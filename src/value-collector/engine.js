import { readValueBooks } from './book-source.js';
import { buildValueObservation } from './features.js';

export const safeCode = error => /^[a-z][a-z0-9_]{1,100}$/.test(error?.message || '')
    ? error.message : 'read_failed';

export function nextValueSlot(after, slots) {
    const open = Math.floor(after / 300000) * 300000;
    for (const seconds of slots) {
        const scheduledAt = open + 300000 - seconds * 1000;
        if (scheduledAt > after) return { slug: `btc-updown-5m-${open / 1000}`, open,
            marketEnd: open + 300000, scheduledAt, seconds };
    }
    return nextValueSlot(open + 300000, slots);
}

async function bounded(read, timeoutMs) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(read), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('collector_read_timeout')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

export class ValueCollectorEngine {
    constructor(config, store, client, { clock = Date.now, readBooks = readValueBooks,
        buildObservation = buildValueObservation } = {}) {
        this.config = config; this.store = store; this.client = client; this.clock = clock;
        this.readBooks = readBooks; this.buildObservation = buildObservation;
        this.tasks = new Set(); this.conflicts = new Set(); this.closed = false;
        this.clockRetryAt = 0; this.marketRetryAt = 0; this.labelRetryAt = new Map(); this.heartbeatAt = 0;
    }
    launch(task) {
        this.tasks.add(task);
        task.finally(() => this.tasks.delete(task)).catch(() => {});
        return task;
    }
    clockFresh(at = this.clock()) {
        return this.clockVerifiedAt !== undefined && at >= this.clockVerifiedAt
            && at - this.clockVerifiedAt < this.config.clockMaxAgeMs;
    }
    async verifyClock() {
        if (this.clockTask) return this.clockTask;
        this.clockTask = this.launch((async () => {
            const before = this.clock();
            try {
                const server = await bounded(() => this.client.serverTime(), this.config.dataAgeMs);
                const at = this.clock(), sampledAt = this.client.clock?.at;
                if (!Number.isFinite(server) || !Number.isFinite(sampledAt) || sampledAt > at
                    || at < before || at - before > this.config.dataAgeMs
                    || at - sampledAt >= this.config.clockMaxAgeMs
                    || Math.abs(server - at) > this.config.maxClockSkewMs) throw new Error('collector_clock_unverified');
                this.clockVerifiedAt = sampledAt; this.clockRetryAt = Math.min(at + 20000, sampledAt + 29000);
                this.store.state.clock = { status: 'verified', verifiedAt: sampledAt, skewMs: server - at };
            } catch (error) {
                this.clockVerifiedAt = undefined; this.clockRetryAt = this.clock() + 5000;
                this.store.state.clock = { status: 'unverified', at: this.clock(), reason: safeCode(error) };
                this.store.event('clock_failed');
            }
        })());
        try { await this.clockTask; } finally { this.clockTask = null; }
    }
    async discover(now) {
        const open = Math.floor(now / 300000) * 300000, slug = `btc-updown-5m-${open / 1000}`;
        if (this.current?.slug === slug || this.marketTask || now < this.marketRetryAt) return;
        this.marketRetryAt = now + 5000;
        this.marketTask = this.launch((async () => {
            try {
                const market = await bounded(() => this.client.market(slug,
                    { deadline: this.clock() + 3000, retries: 0 }), 3000);
                if (market.slug !== slug || market.open !== open || market.end !== open + 300000)
                    throw new Error('collector_market_identity_mismatch');
                if (this.clock() < market.end && !this.closed) this.current = market;
            } catch (error) {
                this.marketError = safeCode(error); this.store.event('market_failed');
            }
        })());
        try { await this.marketTask; } finally { this.marketTask = null; }
    }
    async capture(slot) {
        const start = this.clock(), market = this.current?.slug === slot.slug ? structuredClone(this.current) : null;
        const base = { id: `${slot.slug}:${slot.scheduledAt}`, slug: slot.slug,
            marketEnd: slot.marketEnd, scheduledAt: slot.scheduledAt, seconds: slot.seconds,
            conditionId: market?.conditionId ?? null };
        if (start - slot.scheduledAt > this.config.slotToleranceMs || start >= slot.marketEnd) {
            this.store.recordObservation({ ...base, at: start, status: 'missed', reason: 'scheduled_slot_missed', features: null });
            return;
        }
        if (!market) {
            this.store.recordObservation({ ...base, at: start, status: 'partial',
                reason: this.marketError || 'market_unavailable', features: null });
            return;
        }
        const opening = this.client.btc?.openings?.get(market.open);
        market.reference = opening ? { source: 'chainlink_twap_60s', open: market.open,
            end: market.end, value: opening.value, observedAt: opening.at, receivedAt: opening.receivedAt } : null;
        let pair = null, bookError = null;
        try {
            pair = await this.readBooks(market, { client: this.client, clock: this.clock,
                deadlineAt: Math.min(start + this.config.captureBudgetMs, slot.marketEnd - 1),
                maxAgeMs: this.config.dataAgeMs });
        } catch (error) { bookError = safeCode(error); this.store.event('book_failed'); }
        const at = this.clock(), clockVerified = this.clockFresh(at);
        if (at >= slot.marketEnd || at - start > this.config.captureBudgetMs || at < start) {
            this.store.recordObservation({ ...base, at: Math.max(at, start), status: 'partial',
                reason: 'capture_deadline_exceeded', features: null });
            return;
        }
        const features = this.buildObservation({ market, btc: this.client.btc, pair, at,
            scheduledAt: slot.scheduledAt, config: this.config });
        const referenceConflict = this.conflicts.has(market.open);
        this.store.recordObservation({ ...base, at, status: clockVerified && !referenceConflict
            && features.quality.status === 'ready' ? 'ready' : 'partial',
        clock: { verified: clockVerified, verifiedAt: this.clockVerifiedAt ?? null },
        referenceConflict, bookError, features });
    }
    async resolveLabels() {
        if (this.labelTask) return this.labelTask;
        const now = this.clock();
        const pending = Object.values(this.store.state.pending)
            .filter(row => row.marketEnd + 5000 <= now && (this.labelRetryAt.get(row.conditionId) || 0) <= now)
            .sort((a, b) => (this.labelRetryAt.get(a.conditionId) || 0) - (this.labelRetryAt.get(b.conditionId) || 0)).slice(0, 2);
        if (!pending.length) return;
        this.labelTask = this.launch((async () => {
            for (const row of pending) {
                this.labelRetryAt.set(row.conditionId, this.clock() + this.config.labelRetryMs);
                let payout;
                try {
                    payout = await bounded(() => this.client.payout(row.conditionId), 10000);
                    if (payout === null) continue;
                    if (!Array.isArray(payout) || payout.length !== 2 || payout.some(x => !Number.isFinite(x) || x < 0 || x > 1)
                        || Math.abs(payout[0] + payout[1] - 1) > 1e-9) throw new Error('collector_invalid_payout');
                } catch (error) { this.store.event('label_failed'); continue; }
                this.store.recordLabel({ conditionId: row.conditionId, slug: row.slug,
                    marketEnd: row.marketEnd, at: this.clock(), official: true, source: 'ctf_payout', payout,
                    outcome: payout[0] === 1 && payout[1] === 0 ? 'UP'
                        : payout[0] === 0 && payout[1] === 1 ? 'DOWN' : 'SPLIT' });
                this.labelRetryAt.delete(row.conditionId);
            }
        })());
        try { await this.labelTask; } finally { this.labelTask = null; }
    }
    async tick() {
        if (this.closed) return;
        const now = this.clock();
        this.client.startBtcFeed();
        if (now >= this.clockRetryAt) this.verifyClock().catch(error => { this.fatal = error; });
        this.discover(now).catch(error => { this.fatal = error; });
        this.resolveLabels().catch(error => { this.fatal = error; });
        if (this.fatal) throw this.fatal;
        const cursor = Math.max(this.store.state.startedAt - 1, this.store.state.lastSlotAt ?? 0);
        const slot = nextValueSlot(cursor, this.config.slots);
        if (slot.scheduledAt <= now) await this.capture(slot);
        if (now >= this.heartbeatAt) {
            this.heartbeatAt = now + this.config.heartbeatMs;
            this.store.state.lastTickAt = this.clock();
            this.store.state.health = { at: this.clock(), clockVerified: this.clockFresh(),
                btc: this.client.btcStatus(), market: this.current?.slug ?? null,
                readOnly: true, transactionsSubmitted: 0, inferenceSubmitted: 0 };
            this.store.save();
        }
        for (const open of this.conflicts) if (open < now - 600000) this.conflicts.delete(open);
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.tasks]);
        this.client.close();
        if (this.fatal) throw this.fatal;
    }
}
