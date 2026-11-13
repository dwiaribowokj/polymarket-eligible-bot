import WebSocket from 'ws';

const URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const AGE_MS = 5000, WARM_MS = 180000, PING_MS = 10000;
const MAX_ASSIGNMENTS = 19998;
const TICKS = new Set([0.1, 0.01, 0.001, 0.0001]);
const decimal = value => typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN;
const timestamp = value => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : NaN;
};
const validTick = value => {
    if (typeof value === 'string' && !/^0?\.(?:1|01|001|0001)0*$/.test(value)) return NaN;
    const n = decimal(value); return TICKS.has(n) ? n : NaN;
};
const onGrid = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) <= 1e-8;
const gridPrice = price => Math.round(price * 10000) / 10000;
const sameMap = (a, b) => a.size === b.size && [...a].every(([p, s]) => b.get(p) === s);
const sameTokens = (a, b) => a?.length === b.length && b.every((token, i) => token === a[i]);
const identity = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const closeCode = value => Number.isInteger(value) && value >= 1000 && value <= 4999 ? value : null;
const closeReasonClass = value => {
    // Peer text can contain identifiers or arbitrary data. Inspect at most the
    // RFC close-reason bound and emit only a fixed category, never peer text.
    const reason = Buffer.isBuffer(value) ? value.subarray(0, 123).toString('utf8')
        : typeof value === 'string' ? value.slice(0, 123) : '';
    if (!reason.trim()) return 'empty';
    if (/ping|pong|heartbeat/i.test(reason)) return 'heartbeat';
    if (/idle|timeout|timed out/i.test(reason)) return 'timeout';
    if (/rate|too many|limit/i.test(reason)) return 'rate_limit';
    if (/restart|maintenance|shutdown/i.test(reason)) return 'server_restart';
    if (/protocol|invalid|malformed/i.test(reason)) return 'protocol';
    if (/auth|forbidden|permission/i.test(reason)) return 'authorization';
    return 'other';
};

// This live-only collector never derives an exchange tick from SDK metadata.
// Execution still independently verifies CLOB identity, tick and quote age.
export class LiveBookHistory {
    constructor({ onEvent = () => {}, clock = Date.now,
        socketFactory = (url, options) => new WebSocket(url, options),
        scheduleInterval = setInterval, cancelInterval = clearInterval,
        reconnectBaseMs = 1000, reconnectMaxMs = 30000 } = {}) {
        Object.assign(this, { onEvent, clock, socketFactory, scheduleInterval, cancelInterval });
        this.reconnectBaseMs = Math.max(1000, reconnectBaseMs);
        this.reconnectMaxMs = Math.max(this.reconnectBaseMs, reconnectMaxMs);
        this.tokens = []; this.socket = null; this.sourceEpoch = 0;
        this.failures = 0; this.reconnectAt = 0; this.closed = false;
        this.ordering = { lateRebased: 0, lateIgnored: 0, ambiguousReset: 0 };
        this.reset();
    }
    reset() {
        this.books = new Map(); this.history = []; this.readyAt = null; this.lastAt = null;
        this.conditionId = this.expectedConditionId ?? null;
        this.generation = (this.generation || 0) + 1;
    }
    watch(tokens, market) {
        if (!Array.isArray(tokens) || !tokens.length || !tokens.every(identity) || new Set(tokens).size !== tokens.length)
            throw new Error('invalid_book_tokens');
        if (market?.conditionId !== undefined && !identity(market.conditionId)) throw new Error('invalid_book_condition');
        const same = sameTokens(this.tokens, tokens);
        const expected = market?.conditionId ?? (same ? this.expectedConditionId : null);
        const changed = !same || expected !== this.expectedConditionId;
        if (!changed && this._source && this.socket?.readyState !== WebSocket.CLOSED) return false;
        if (!changed && this._source) this._invalidate('book_gap', 'socket_closed', this._source);
        if (!changed && !this.closed && this.clock() < this.reconnectAt) return false;
        if (changed || this.closed) {
            this._retire(); this.tokens = [...tokens]; this.expectedConditionId = expected;
            this.reset(); this.failures = 0; this.reconnectAt = 0; this._gapOpen = false;
        }
        this.closed = false;
        const createdAt = this.clock();
        const source = { epoch: ++this.sourceEpoch, createdAt, openedAt: createdAt, timer: null,
            lastFrameAt: null, lastPongAt: null, nextPulseAt: null, timerDelayMs: null, maxTimerDelayMs: null };
        this._source = source;
        try {
            const socket = this.socket = source.socket = this.socketFactory(URL,
                { handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
            const current = () => this._source === source && !this.closed;
            socket.on('open', () => {
                if (!current() || source.opened) return;
                source.opened = true;
                source.openedAt = this.clock();
                try { socket.send(JSON.stringify({ assets_ids: [...this.tokens], type: 'market', custom_feature_enabled: true })); }
                catch { this._invalidate('book_gap', 'subscribe_failed', source); return; }
                this._emit('book_stream_open', { sourceEpoch: source.epoch });
                if (!current()) return;
                source.nextPulseAt = this.clock() + 1000;
                // The documented application heartbeat runs every 10 seconds;
                // freshness housekeeping remains independent at one second.
                source.nextPingAt = source.openedAt + PING_MS;
                source.timer = this.scheduleInterval(() => {
                    if (!current()) return;
                    const now = this.clock();
                    source.timerDelayMs = Math.max(0, now - source.nextPulseAt);
                    source.maxTimerDelayMs = Math.max(source.maxTimerDelayMs ?? 0, source.timerDelayMs);
                    source.nextPulseAt = now + 1000;
                    if (this._hasGap(now) || !this.tokens.every(token => this.books.has(token)) && now - source.openedAt > AGE_MS) {
                        this._invalidate('book_gap', 'quote_timeout', source); return;
                    }
                    if (now < source.nextPingAt) return;
                    try {
                        if (socket.readyState === WebSocket.OPEN) {
                            socket.send('PING'); source.nextPingAt = now + PING_MS;
                        }
                    }
                    catch { this._invalidate('book_gap', 'ping_failed', source); }
                }, 1000);
                source.timer?.unref?.();
            });
            socket.on('message', data => {
                if (!current()) return;
                source.lastFrameAt = this.clock();
                const body = data.toString();
                if (body === 'PONG') { source.lastPongAt = source.lastFrameAt; return; }
                let rows;
                try { rows = JSON.parse(body); }
                catch { this._invalidate('book_gap', 'invalid_json', source); return; }
                for (const row of Array.isArray(rows) ? rows : [rows]) {
                    if (!current()) break;
                    this.ingest(row, this.clock(), source.epoch);
                }
            });
            socket.on('ping', () => { if (current()) source.lastFrameAt = this.clock(); });
            socket.on('pong', () => {
                if (current()) source.lastPongAt = source.lastFrameAt = this.clock();
            });
            socket.on('close', (code, reason) => {
                if (current()) this._invalidate('book_gap', 'socket_closed', source,
                    { closeCode: closeCode(code), closeReasonClass: closeReasonClass(reason) });
            });
            socket.on('error', () => { if (current()) this._invalidate('book_gap', 'socket_error', source); });
        } catch { this._invalidate('book_gap', 'socket_create_failed', source); }
        return true;
    }
    _emit(type, detail = {}) { this.onEvent(type, { ...detail, generation: this.generation }); }
    _reject(reason, eventType, detail = {}) {
        this._emit('book_message_rejected', { ...detail, reason, eventType: typeof eventType === 'string' ? eventType : null });
        return false;
    }
    _mutationFault(reason, eventType, detail = {}) {
        this._reject(reason, eventType, detail);
        // A rejected mutation may contain a missed removal or snapshot. Later
        // deltas cannot prove that retained levels still exist: resubscribe.
        return this._invalidate(eventType === 'tick_size_change' ? 'book_tick_changed' : 'book_gap', reason, this._source, detail);
    }
    _retire() {
        const source = this._source; this._source = null; this.socket = null;
        if (!source) return;
        if (source.timer !== null) this.cancelInterval(source.timer);
        // Keep guarded error listeners: a late error must not become unhandled.
        try { source.socket?.terminate(); } catch { /* Already retired. */ }
    }
    _invalidate(type, reason, source = this._source, detail = {}) {
        if (source && source !== this._source || this.closed || this._gapOpen && !source) return false;
        const sourceEpoch = source?.epoch ?? this.sourceEpoch;
        const observedAt = this.clock();
        const diagnostics = { ...this._sourceStatus(observedAt, source), quoteAges: this._quoteAges(observedAt) };
        this._retire(); this.reset(); this._gapOpen = true;
        this.failures++;
        const delayMs = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.failures - 1, 20));
        this.reconnectAt = this.clock() + delayMs;
        this._emit(type, { ...detail, ...diagnostics, reason, sourceEpoch, continuityPreserved: false });
        this._emit('book_reconnect_scheduled', { reason, sourceEpoch, delayMs, reconnectAt: this.reconnectAt });
        return false;
    }
    _hasGap(now) {
        if (this.lastAt !== null && (now < this.lastAt || now - this.lastAt > AGE_MS)) return true;
        for (const book of this.books.values()) if (now < book.at || now < book.receivedAt
            || now - book.at > AGE_MS || now - book.receivedAt > AGE_MS) return true;
        return false;
    }
    _levels(rows, tick) {
        if (!Array.isArray(rows)) return null;
        const result = new Map();
        for (const level of rows) {
            const price = decimal(level?.price), size = decimal(level?.size);
            if (!(price > 0 && price < 1 && size > 0 && Number.isFinite(size)) || !onGrid(price, tick ?? 0.0001)) return null;
            const canonicalPrice = gridPrice(price);
            if (!(canonicalPrice > 0 && canonicalPrice < 1) || result.has(canonicalPrice)) return null;
            result.set(canonicalPrice, size);
        }
        return result;
    }
    _context(at, receivedAt, book) {
        return { eventTimestamp: Number.isFinite(at) ? at : null, receivedAt: Number.isFinite(receivedAt) ? receivedAt : null,
            serverAgeMs: Number.isFinite(at) && Number.isFinite(receivedAt) ? receivedAt - at : null,
            previousQuoteAt: book?.at ?? null, currentQuoteAt: book?.at ?? null, fullSnapshotAt: book?.fullAt ?? null,
            delayMs: book ? Math.max(0, book.at - at) : 0 };
    }
    _ordering(action, reason, type, at, receivedAt, book) {
        this.ordering[action] = Math.min(Number.MAX_SAFE_INTEGER, this.ordering[action] + 1);
        // Feed rate is hundreds of messages/second. Counts are always visible;
        // diagnostic events are coalesced to keep ledger writes bounded.
        if (this.lastOrderingEventAt === undefined || receivedAt - this.lastOrderingEventAt >= 30000) {
            this.lastOrderingEventAt = receivedAt;
            this._emit('book_ordering_recovered', { ...this._context(at, receivedAt, book), reason, eventType: type,
                action, ordering: { ...this.ordering } });
        }
    }
    _ambiguous(reason, type, at, receivedAt, book) {
        this.ordering.ambiguousReset = Math.min(Number.MAX_SAFE_INTEGER, this.ordering.ambiguousReset + 1);
        return this._mutationFault(reason, type, this._context(at, receivedAt, book));
    }
    _record(at, receivedAt) {
        this._gapOpen = false; this.lastAt = receivedAt;
        const valid = this._valid(receivedAt, false);
        if (valid) this.readyAt ??= receivedAt;
        // Readiness is independent of sampling. Mutations remain immediately
        // visible to execution; only history materializes and sorts once/second.
        if (valid && (!this.history.length || receivedAt - this.history.at(-1).receivedAt >= 1000)) {
            this.history.push({ at, receivedAt, books: this.snapshot(receivedAt, false) });
            this.history = this.history.filter(point => point.receivedAt >= receivedAt - 185000);
        }
        if (this.readyAt !== null && receivedAt - this.readyAt >= WARM_MS) this.failures = 0;
    }
    ingest(row, receivedAt = this.clock(), sourceEpoch) {
        if (this.closed || sourceEpoch !== undefined && sourceEpoch !== this._source?.epoch) return false;
        if (!row || typeof row !== 'object' || Array.isArray(row)) return this._reject('invalid_envelope');
        const type = row.event_type;
        if (!['book', 'price_change', 'tick_size_change'].includes(type)) return false;
        if (type === 'price_change' && !Array.isArray(row.price_changes)) return this._mutationFault('invalid_delta_envelope', type);
        const known = type === 'price_change'
            ? Array.isArray(row.price_changes) && row.price_changes.some(change => this.tokens.includes(change?.asset_id))
            : this.tokens.includes(row.asset_id);
        if (!known) return this._reject('unknown_token', type);
        const at = timestamp(row.timestamp);
        const targets = type === 'price_change' ? row.price_changes.map(change => change?.asset_id) : [row.asset_id];
        const previous = targets.map(token => this.books.get(token)).find(Boolean);
        if (type === 'tick_size_change' && Number.isSafeInteger(receivedAt) && Number.isFinite(at) && at <= receivedAt) {
            const book = this.books.get(row.asset_id), oldTick = validTick(row.old_tick_size), newTick = validTick(row.new_tick_size);
            if (row.market === book?.conditionId && book?.tick === newTick && book.transition?.oldTick === oldTick
                && book.transition?.newTick === newTick) return false;
        }
        if (!Number.isSafeInteger(receivedAt) || receivedAt < 0 || !Number.isFinite(at)
            || at > receivedAt || this.lastAt !== null && receivedAt < this.lastAt)
            return this._mutationFault('invalid_or_stale_timestamp', type, this._context(at, receivedAt, previous));
        if (!identity(row.market)) return this._mutationFault('invalid_condition', type);
        if (this.conditionId !== null && row.market !== this.conditionId)
            return this._invalidate('book_identity_changed', 'condition_mismatch');
        if (this._hasGap(receivedAt)) return this._invalidate('book_gap', 'quote_gap', this._source, this._context(at, receivedAt, previous));
        if (type === 'tick_size_change') {
            if (receivedAt - at > AGE_MS) return this._mutationFault('invalid_or_stale_timestamp', type, this._context(at, receivedAt, previous));
            if (previous && at < Math.max(previous.at, previous.tickAt ?? 0)) return this._mutationFault('out_of_order', type, this._context(at, receivedAt, previous));
            return this._tick(row, at, receivedAt);
        }
        return type === 'book' ? this._book(row, at, receivedAt) : this._delta(row, at, receivedAt);
    }
    _book(row, at, receivedAt) {
        const type = 'book', old = this.books.get(row.asset_id), context = this._context(at, receivedAt, old);
        const tick = row.tick_size === undefined ? old?.tick : validTick(row.tick_size);
        if (row.tick_size !== undefined && !Number.isFinite(tick)) return this._mutationFault('invalid_tick', type, context);
        const bids = this._levels(row.bids, tick), asks = this._levels(row.asks, tick);
        if (!bids || !asks) return this._mutationFault('invalid_levels', type, context);
        if (old?.tick !== undefined && tick !== old.tick) return this._invalidate('book_tick_changed', 'unannounced_tick_change', this._source, context);
        const late = old && at < old.at;
        if (old && (at < old.fullAt || at === old.fullAt && sameMap(bids, old.fullBids) && sameMap(asks, old.fullAsks))) {
            if (late) this._ordering('lateIgnored', 'covered_or_noop_snapshot', type, at, receivedAt, old);
            return false;
        }
        if (receivedAt - at > AGE_MS) return this._mutationFault('invalid_or_stale_timestamp', type, context);
        if (old?.tickAt !== undefined && at < old.tickAt) return this._ambiguous('uncovered_pre_tick_snapshot', type, at, receivedAt, old);
        if (old && at === old.fullAt && (!sameMap(bids, old.fullBids) || !sameMap(asks, old.fullAsks)))
            return this._ambiguous('equal_time_snapshot_conflict', type, at, receivedAt, old);
        const assignments = { bids: new Map(), asks: new Map() }, merged = { bids: new Map(bids), asks: new Map(asks) };
        for (const side of ['bids', 'asks']) for (const [price, version] of old?.assignments?.[side] ?? []) {
            if (version.at === at && (merged[side].get(price) ?? 0) !== version.size)
                return this._ambiguous('equal_time_snapshot_conflict', type, at, receivedAt, old);
            if (version.at <= at) continue;
            assignments[side].set(price, version);
            if (version.size === 0) merged[side].delete(price); else merged[side].set(price, version.size);
        }
        this.conditionId ??= row.market;
        this.books.set(row.asset_id, { ...old, ...merged, fullAt: at, fullBids: bids, fullAsks: asks, assignments,
            at: late ? old.at : at, receivedAt: late ? old.receivedAt : receivedAt, conditionId: row.market, tick });
        if (late) this._ordering('lateRebased', 'snapshot_rebased', type, at, receivedAt, old);
        else this._record(at, receivedAt);
        return true;
    }
    _delta(row, at, receivedAt) {
        const type = 'price_change', changes = [], keys = new Set();
        for (const change of row.price_changes) {
            if (!this.tokens.includes(change?.asset_id)) return this._mutationFault('mixed_unknown_token', type);
            const old = this.books.get(change.asset_id), context = this._context(at, receivedAt, old);
            if (!old) return this._mutationFault('delta_without_book', type, context);
            const side = change.side === 'BUY' ? 'bids' : change.side === 'SELL' ? 'asks' : null;
            const rawPrice = decimal(change.price), size = decimal(change.size), price = gridPrice(rawPrice);
            const key = `${change.asset_id}:${side}:${price}`;
            if (!side || !(rawPrice > 0 && rawPrice < 1 && price > 0 && price < 1 && size >= 0 && Number.isFinite(size))
                || !onGrid(rawPrice, old.tick ?? 0.0001) || keys.has(key)) return this._mutationFault('invalid_delta', type, context);
            keys.add(key); changes.push({ token: change.asset_id, side, price, size, old });
        }
        const plans = new Map();
        for (const change of changes) {
            const { token, side, price, size, old } = change;
            const plan = plans.get(token) ?? { old, changes: [], late: at < old.at, ignored: false };
            plans.set(token, plan);
            const version = old.assignments[side].get(price), currentSize = old[side].get(price) ?? 0;
            if (at < old.fullAt || version && (at < version.at || at === version.at && version.size === size)
                || at === old.fullAt && size === currentSize) { plan.ignored = true; continue; }
            if (version && at === version.at && version.size !== size && plan.late)
                return this._ambiguous('equal_time_delta_conflict', type, at, receivedAt, old);
            // Within one receive-ordered source, preserve the existing equal-ms
            // path. Reordered equal-ms conflicts above never use this tie rule.
            if (at === old.fullAt && plan.late && size !== currentSize)
                return this._ambiguous('equal_time_delta_conflict', type, at, receivedAt, old);
            if (old.tickAt !== undefined && at < old.tickAt) return this._ambiguous('uncovered_pre_tick_delta', type, at, receivedAt, old);
            if (receivedAt - at > AGE_MS) return this._mutationFault('invalid_or_stale_timestamp', type, this._context(at, receivedAt, old));
            plan.changes.push(change);
        }
        if (![...plans.values()].some(plan => plan.changes.length)) {
            const lateBook = [...plans.values()].find(plan => plan.late)?.old;
            if (lateBook) this._ordering('lateIgnored', 'covered_or_noop_delta', type, at, receivedAt, lateBook);
            return false;
        }
        // Bound versions by the two sides of the minimum supported price grid.
        for (const { old, changes: planned } of plans.values()) {
            const additions = planned.filter(c => !old.assignments[c.side].has(c.price)).length;
            if (old.assignments.bids.size + old.assignments.asks.size + additions > MAX_ASSIGNMENTS)
                return this._mutationFault('ordering_state_capacity', type, this._context(at, receivedAt, old));
        }
        let fresh = false;
        for (const { old, changes: planned, late } of plans.values()) {
            const changedDepth = planned.some(({ side, price, size }) => (old[side].get(price) ?? 0) !== size);
            for (const { side, price, size } of planned) {
                old.assignments[side].set(price, { at, size });
                if (size === 0) old[side].delete(price); else old[side].set(price, size);
            }
            if (late) this._ordering(planned.length ? 'lateRebased' : 'lateIgnored', planned.length ? 'delta_reconciled' : 'covered_delta', type, at, receivedAt, old);
            else if (planned.length && (at > old.at || changedDepth)) { old.at = at; old.receivedAt = receivedAt; fresh = true; }
        }
        if (fresh) this._record(at, receivedAt);
        return true;
    }
    _tick(row, at, receivedAt) {
        const book = this.books.get(row.asset_id), oldTick = validTick(row.old_tick_size), newTick = validTick(row.new_tick_size);
        if (!Number.isFinite(oldTick) || !Number.isFinite(newTick) || oldTick === newTick)
            return this._mutationFault('invalid_tick_transition', row.event_type);
        if (book?.tick === newTick && book.transition?.oldTick === oldTick && book.transition?.newTick === newTick) return false;
        if (!book || book.tick === undefined) return this._invalidate('book_tick_changed', 'old_tick_unproven');
        if (book.tick !== oldTick) return this._mutationFault('old_tick_mismatch', row.event_type);
        if (this._hasGap(receivedAt)) return this._invalidate('book_gap', 'quote_gap');
        if (!this._valid(receivedAt, false)) return this._invalidate('book_tick_changed', 'incomplete_books');
        if ([...book.bids.keys(), ...book.asks.keys()].some(price => !onGrid(price, newTick)))
            return this._invalidate('book_tick_changed', 'tick_grid_resnapshot_required');
        book.tick = newTick; book.tickAt = at; book.transition = { oldTick, newTick };
        this.generation++;
        this._emit('book_tick_changed', { tokenId: row.asset_id, oldTick, newTick, timestamp: at,
            sourceEpoch: this._source?.epoch ?? this.sourceEpoch, continuityPreserved: true });
        return true;
    }
    _valid(now, requireWarm = true) {
        if (this.closed || !Number.isSafeInteger(now) || !this.tokens.length || this.lastAt === null || this._hasGap(now)
            || !this.tokens.every(token => this.books.has(token))
            || requireWarm && (this.readyAt === null || now < this.readyAt || now - this.readyAt < WARM_MS)) return false;
        return true;
    }
    snapshot(now = this.clock(), requireWarm = true) {
        if (!this._valid(now, requireWarm)) return null;
        return this.tokens.map(token => {
            const book = this.books.get(token);
            return { tokenId: token, conditionId: book.conditionId, tick: book.tick, timestamp: book.at, fetchedAt: book.receivedAt,
                bids: [...book.bids].sort((a, b) => b[0] - a[0]).map(([price, size]) => ({ price, size })),
                asks: [...book.asks].sort((a, b) => a[0] - b[0]).map(([price, size]) => ({ price, size })) };
        });
    }
    _sourceStatus(now, source = this._source) {
        const age = at => source && at !== null && Number.isFinite(at) ? Math.max(0, now - at) : null;
        return { socketLifetimeMs: age(source?.createdAt), socketOpenAgeMs: source?.opened ? age(source.openedAt) : null,
            lastFrameAgeMs: age(source?.lastFrameAt), lastPongAgeMs: age(source?.lastPongAt),
            timerDelayMs: source?.timerDelayMs ?? null, maxTimerDelayMs: source?.maxTimerDelayMs ?? null,
            pendingTimerDelayMs: age(source?.nextPulseAt) };
    }
    _quoteAges(now) {
        return this.tokens.map(tokenId => {
            const book = this.books.get(tokenId);
            return { tokenId, sourceAgeMs: book ? now - book.at : null, receiveAgeMs: book ? now - book.receivedAt : null };
        });
    }
    status(now = this.clock()) {
        const valid = this._valid(now, false);
        const warmupMs = valid && this.readyAt !== null ? Math.min(WARM_MS, Math.max(0, now - this.readyAt)) : 0;
        return { generation: this.generation, sourceEpoch: this.sourceEpoch,
            connected: !!this._source && this.socket?.readyState === WebSocket.OPEN,
            ready: valid && warmupMs === WARM_MS, warming: valid && warmupMs < WARM_MS,
            warmupMs, remainingWarmupMs: WARM_MS - warmupMs, reconnectAt: this.reconnectAt, failures: this.failures,
            ordering: { ...this.ordering }, ...this._sourceStatus(now), tokens: this._quoteAges(now) };
    }
    close() { this.closed = true; this._retire(); }
}
