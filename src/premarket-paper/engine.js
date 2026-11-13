import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveBookHistory } from '../laya-live/book-history.js';
import { candidateChecks, metadataIdentity, verifyStreamSnapshot, validatedStreamBooks } from '../ai-shadow/engine.js';
import { makeFeatures } from '../ai-shadow/history.js';
import { quoteQuality } from '../restart/evidence.js';
import { fee, floorTick, sweep, round, EPS } from '../restart/math.js';
import { PremarketHistory, premarketFeatures, fairMomentumDecision } from './features.js';
import { readCandleHistory } from './candle-history.js';
import { NEXT_PROFILE, isCandleProfile, earlyPremarketFeatures, earlyReversalDecision, nextReversalSignal } from './early-context.js';
import { readEarlyPaperBooks, validatedEarlyPaperBooks } from './early-book.js';
import { retryable, safeError } from '../restart/network.js';
import { routerDirectionalPromptEvidence } from './router-directional.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const optionalModelReasons = new Set(['btc_edge_insufficient', 'btc_direction_disagrees']);
const boundedErrorCode = error => /^[a-z][a-z0-9_]{1,80}$/.test(error?.code || error?.message || '')
    ? error.code || error.message : 'operation_failed';
const validPayout = value => Array.isArray(value) && value.length === 2
    && value.every(n => Number.isFinite(n) && n >= 0 && n <= 1) && Math.abs(value[0] + value[1] - 1) <= EPS;
const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
};

export function premarketOrder(market, books, index, config, cash, requireDepth = true) {
    const skip = reason => ({ index, reason });
    if (!market.accepting) return skip('market_not_accepting');
    if (market.minimum > config.shares + EPS) return skip('minimum_exceeds_fixed_shares');
    const ask = books[index].asks[0]?.price, tick = market.ticks?.[index] || market.tick;
    if (!Number.isFinite(ask) || !(ask > 0 && ask < 1) || !(tick > 0 && tick < 1)) return skip('missing_executable_ask');
    const price = floorTick(Math.min(1 - tick, ask + Math.min(config.limitSlippageTicks * tick, config.limitSlippageUsd)), tick);
    const cost = config.shares * price + fee(config.shares, price, market.fee) + config.gasUsd;
    const order = { index, tokenId: market.tokens[index], snapshotPrice: ask, price, shares: config.shares,
        side: 'BUY', cost: round(cost), slippage: round(price - ask) };
    if (cost > config.entryCap + EPS) return skip('entry_budget_exceeded');
    if (cost > cash + EPS) return skip('insufficient_virtual_cash');
    const quality = quoteQuality({ orders: [order] }, books, config.control, { requireDepth });
    return quality.reason ? skip(quality.reason) : { index, reason: null, order };
}

export class PremarketPaperEngine {
    constructor(config, store, client, { clock = Date.now, makeBooks, providers = null, candleReader = readCandleHistory,
        bookReader = readEarlyPaperBooks, sleep = delay } = {}) {
        Object.assign(this, { config, store, client, clock, providers, candleReader, bookReader, sleep });
        this.store.state.activeArms = [...(config.activeArms ?? config.armNames)];
        this.makeBooks = makeBooks || (() => new LiveBookHistory({ clock, onEvent: (type, detail) => store.event(type, detail) }));
        this.streams = new Map(); this.markets = new Map(); this.discovery = new Map(); this.tasks = new Set();
        this.history = new PremarketHistory(config); this.closed = false; this.clockValid = false;
        this.clockRetryAt = 0; this.lastHeartbeat = 0; this.resolving = false;
        this.fairSnapshots = new Map(); this.executionReads = new Map();
        if (this.fairProfile()) for (const snapshot of this.store.state.snapshots || []) {
            if (!['awaiting_cutoff', 'validating'].includes(snapshot.fairExecution?.status)) continue;
            for (const attempt of snapshot.fairExecution.attempts || []) if (!Number.isFinite(attempt.finishedAt))
                Object.assign(attempt, { finishedAt: this.clock(), status: 'failed', code: 'restart_during_fair_decision' });
            Object.assign(snapshot.fairExecution, { status: 'skipped', reason: 'restart_during_fair_decision', adjudicatedAt: this.clock() });
            for (const name of this.config.activeArms) {
                if (snapshot.decisions[name] && !this.store.state.arms[name].outcomes[snapshot.market.slug])
                    snapshot.decisions[name].entryDisposition = 'restart_during_fair_decision';
                this.skip(name, snapshot.market.slug, 'restart_during_fair_decision');
            }
        }
    }
    launch(task) { this.tasks.add(task); task.finally(() => this.tasks.delete(task)).catch(() => {}); return task; }
    earlyProfile() { return isCandleProfile(this.config); }
    nextProfile() { return this.config.profile === NEXT_PROFILE; }
    entryEnd(market) { return this.nextProfile() ? market.open + this.config.entryEndOffsetMs : market.open; }
    decisionDeadline(at, market) {
        return Math.min(at + this.config.aiDecisionMs,
            this.nextProfile() ? this.entryEnd(market) : market.open - this.config.latencyMs - 1);
    }
    readinessDeadline(at, market) {
        return Math.min(at + this.config.earlyExecution.retryWindowMs,
            this.nextProfile() ? this.entryEnd(market) : market.open - 1000);
    }
    restEarlyProfile() { return this.earlyProfile() && this.config.earlyExecution?.version === 'bounded-shared-rest-fak-v1'; }
    transientRead(error) {
        return retryable(error) || ['clock_unverified', 'circuit_open', 'rate_limit_wait', 'early_book_read_timeout',
            'early_book_verification_expired', 'early_book_metadata_expired'].includes(error.code || error.message);
    }
    fairProfile() { return this.config.profile === 'fair-near-open-30m-v1' || this.earlyProfile(); }
    candleContext(at = this.clock()) {
        return this.candleReader(this.config.candleCache, { snapshotAt: at, now: this.clock(),
            maxAgeMs: this.config.candleCacheMaxAgeMs, count: this.config.candleCount });
    }
    armSelected(name) { return this.config.activeArms === undefined || this.config.activeArms.includes(name); }
    entryCutoffRequested() { return this.store.state.entryCutoffAt != null; }
    cancelPendingForCutoff() {
        for (const [name, arm] of Object.entries(this.store.state.arms)) for (const [slug, position] of Object.entries(arm.positions)) {
            if (position.status !== 'pending') continue;
            delete arm.positions[slug]; this.skip(name, slug, 'entry_cutoff');
        }
    }
    cancelFairDecisions(reason) {
        for (const snapshot of this.fairSnapshots.values()) {
            for (const attempt of snapshot.fairExecution.attempts || []) if (!Number.isFinite(attempt.finishedAt))
                Object.assign(attempt, { finishedAt: this.clock(), status: 'failed', code: reason });
            Object.assign(snapshot.fairExecution, { status: 'skipped', reason, adjudicatedAt: this.clock() });
            for (const name of this.config.activeArms) {
                const decision = snapshot.decisions[name];
                if (decision) decision.entryDisposition = reason;
                this.skip(name, snapshot.market.slug, reason);
            }
        }
        this.fairSnapshots.clear();
    }
    requestEntryCutoff(reason, at = this.clock()) {
        if (!Number.isFinite(at) || at < 0) throw new Error('invalid_entry_cutoff_time');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('invalid_entry_cutoff_reason');
        if (!this.entryCutoffRequested()) {
            Object.assign(this.store.state, { entryCutoffAt: at, entryCutoffReason: reason });
            this.store.event('entry_cutoff_requested', { entryCutoffAt: at, reason });
        }
        this.cancelFairDecisions('entry_cutoff'); this.cancelPendingForCutoff();
        this.store.save();
        return this.store.state.entryCutoffAt;
    }
    isDrained() {
        return this.entryCutoffRequested() && !this.tasks.size && !this.fairSnapshots.size && !this.clockTask && !this.resolving && !this.providers?.active?.size
            && Object.values(this.store.state.arms).every(arm => !Object.keys(arm.positions).length);
    }
    markUnselected(slug) {
        for (const name of this.config.armNames) if (!this.armSelected(name)) this.skip(name, slug, 'arm_not_selected');
    }
    clockFresh(now = this.clock()) {
        return this.clockValid && Number.isFinite(this.clockVerifiedAt) && now >= this.clockVerifiedAt && now - this.clockVerifiedAt < 30000;
    }
    async verifyClock() {
        if (this.clockTask) return this.clockTask;
        this.clockTask = (async () => {
            const before = this.clock();
            try {
                const server = await this.client.serverTime(), now = this.clock(), sampledAt = this.client.clock?.at ?? now;
                const roundTripMs = this.restEarlyProfile() ? this.client.clock?.durationMs ?? now - before : now - before;
                if (!Number.isFinite(server) || now < before || roundTripMs > this.config.dataAgeMs
                    || Math.abs(server - now) > this.config.control.maxClockSkewMs
                    || sampledAt > now || now - sampledAt >= 30000) throw new Error('invalid_server_clock');
                this.clockValid = true; this.clockVerifiedAt = sampledAt; this.clockRetryAt = Math.min(now + 20000, sampledAt + 30000);
                this.store.state.clock = { status: 'verified', verifiedAt: sampledAt }; this.store.save(); return true;
            } catch (error) {
                this.clockValid = false; this.clockRetryAt = this.clock() + 5000;
                this.store.state.clock = { status: 'waiting', failedAt: this.clock() };
                this.store.error('clock', error); return false;
            }
        })().finally(() => { this.clockTask = null; });
        return this.clockTask;
    }
    availableCash(arm) {
        return round(arm.cash - Object.values(arm.positions).reduce((sum, position) =>
            sum + (position.status === 'pending' ? position.order.cost : this.config.gasUsd), 0));
    }
    skip(name, slug, reason, detail = {}) {
        const arm = this.store.state.arms[name];
        if (arm.positions[slug] || arm.outcomes[slug]) return;
        if (!this.armSelected(name)) reason = 'arm_not_selected';
        arm.outcomes[slug] = { pnl: 0, noExposure: true, reason, ...detail };
        this.store.event('entry_skipped', { arm: name, slug, reason, ...detail });
    }
    async discover(open) {
        if (this.closed || this.entryCutoffRequested()) return;
        const slug = `btc-updown-5m-${open / 1000}`;
        if (this.markets.has(slug)) {
            const market = this.markets.get(slug); this.streams.get(slug)?.watch(market.tokens, market); return;
        }
        const attempt = this.discovery.get(slug);
        if (attempt?.pending || this.clock() < (attempt?.retryAt || 0)) return;
        this.discovery.set(slug, { pending: true });
        try {
            const market = await this.client.market(slug);
            if (market.slug !== slug || market.open !== open || market.end !== open + 300000) throw new Error('market_identity_mismatch');
            if (this.closed || this.entryCutoffRequested()) return;
            if (!this.restEarlyProfile()) {
                const stream = this.makeBooks(); stream.watch(market.tokens, market); this.streams.set(slug, stream);
            }
            this.markets.set(slug, market);
            this.store.event('market_watched', { slug, open, future: open > this.clock() });
        } catch (error) { this.store.error('market_discovery', error); }
        finally { this.discovery.set(slug, { pending: false, retryAt: this.clock() + 5000 }); }
    }
    async tick(now = this.clock()) {
        if (this.closed) return;
        if (!this.earlyProfile()) { this.history.capture(this.client.btc, now); this.client.startBtcFeed(); }
        if (!this.clockTask && now >= this.clockRetryAt) this.launch(this.verifyClock());
        this.executePending();
        this.scheduleFairExecutions(now);
        if (!this.resolving && now >= (this.nextSettlementTick || 0)) {
            this.nextSettlementTick = now + (this.restEarlyProfile() ? 1000 : 0);
            this.resolving = true;
            this.launch(this.settle(now).catch(error => this.store.error('settlement', error)).finally(() => { this.resolving = false; }));
        }
        if (!this.entryCutoffRequested()) this.scheduleObservations(now);
        for (const [watched, market] of this.markets) if (now > market.end + this.config.dataAgeMs) {
            this.streams.get(watched)?.close(); this.streams.delete(watched); this.markets.delete(watched); this.discovery.delete(watched);
        }
        if (now - this.lastHeartbeat >= this.config.reportMs) {
            this.lastHeartbeat = now; this.store.state.lastHeartbeatAt = now;
            const candleHistory = this.earlyProfile() ? this.candleContext(now) : null;
            const historyStatus = candleHistory ? { source: candleHistory.source, symbol: candleHistory.symbol,
                ready: candleHistory.ready, reason: candleHistory.reason, candles: candleHistory.bars?.length || 0,
                observedAt: candleHistory.observedAt, windowEnd: candleHistory.windowEnd } : null;
            if (historyStatus) this.store.state.candleHistory = historyStatus;
            this.store.event('heartbeat', { clockFresh: this.clockFresh(now),
                feed: historyStatus || this.client.btcStatus?.() || this.client.btc.status(now),
                historySeconds: candleHistory ? (candleHistory.ready ? this.config.historyMs / 1000 : 0)
                    : this.history.points.length ? (now - this.history.points[0].at) / 1000 : 0,
                markets: [...this.markets.keys()], arms: Object.fromEntries(Object.entries(this.store.state.arms).map(([name, arm]) =>
                    [name, { cash: arm.cash, activePositions: Object.keys(arm.positions).length, completed: arm.completed.length, stopped: arm.stopped }])) });
        }
        this.store.state.lastTickAt = now;
    }
    scheduleObservations(now) {
        if (this.closed || this.entryCutoffRequested()) return;
        const currentOpen = Math.floor(now / 300000) * 300000;
        const targetOpen = currentOpen + Math.ceil(this.config.leadSeconds / 300) * 300000;
        const watching = this.earlyProfile() ? [targetOpen, targetOpen + 300000]
            : [currentOpen, currentOpen + 300000, currentOpen + 600000];
        for (const open of watching) this.launch(this.discover(open));
        const targetSlug = `btc-updown-5m-${targetOpen / 1000}`;
        const scheduledAt = targetOpen - this.config.leadSeconds * 1000, key = `${targetSlug}:premarket`;
        if (now >= scheduledAt && !this.store.state.slots[key]) {
            const slot = this.store.state.slots[key] = { at: now, scheduledAt, status: 'reserved' };
            this.store.state.markets[targetSlug] ||= { slug: targetSlug, open: targetOpen, end: targetOpen + 300000, enrolledAt: now };
            this.markUnselected(targetSlug);
            this.store.save();
            if (now - scheduledAt > this.config.slotToleranceMs) {
                slot.status = 'skipped'; slot.reason = 'slot_missed';
                for (const name of this.config.armNames.filter(name => name !== 'late-cost-cap')) this.skip(name, targetSlug, 'slot_missed');
            } else this.launch(this.observePremarket(targetSlug, scheduledAt, key).catch(error => this.failObservation(targetSlug, key, error)));
        }
        const slug = `btc-updown-5m-${currentOpen / 1000}`, cohort = this.store.state.markets[slug];
        if (cohort) for (const seconds of this.config.slots) {
            const at = cohort.end - seconds * 1000, slotKey = `${slug}:late:${seconds}`;
            if (now < at || this.store.state.slots[slotKey]) continue;
            this.store.state.slots[slotKey] = { at: now, scheduledAt: at, status: 'reserved' }; this.store.save();
            if (!this.armSelected('late-cost-cap')) {
                Object.assign(this.store.state.slots[slotKey], { status: 'skipped', reason: 'arm_not_selected' });
                this.skip('late-cost-cap', slug, 'arm_not_selected'); this.store.save(); continue;
            }
            if (now - at > this.config.slotToleranceMs) {
                Object.assign(this.store.state.slots[slotKey], { status: 'skipped', reason: 'slot_missed' }); this.store.save();
            } else this.launch(this.observeLate(slug, at, slotKey).catch(error => this.failObservation(slug, slotKey, error)));
        }
    }
    failObservation(slug, key, error) {
        if (error.durableStateCommitted) throw error;
        const slot = this.store.state.slots[key]; slot.status = 'skipped'; slot.reason = error.message;
        if (key.endsWith(':premarket')) for (const name of this.config.armNames.filter(name => name !== 'late-cost-cap'))
            this.skip(name, slug, error.message === 'entry_cutoff' ? 'entry_cutoff' : 'observation_failed', { code: error.message });
        if (error.message === 'entry_cutoff') { this.store.save(); return; }
        this.store.error('observation', error);
    }
    async validated(slug, requireWarm = false, deadline = Infinity) {
        const cached = this.markets.get(slug), stream = this.streams.get(slug);
        if (!cached || !stream && !this.restEarlyProfile()) throw new Error('target_market_unavailable');
        const generation = stream?.generation, market = await this.client.market(slug,
            this.restEarlyProfile() ? { deadline, retries: 0 } : {});
        if (market.open !== cached.open || market.end !== cached.end || market.slug !== slug
            || market.conditionId !== cached.conditionId || market.tokens.some((token, i) => token !== cached.tokens[i]))
            throw new Error('market_identity_mismatch');
        if (this.restEarlyProfile()) {
            if (!market.accepting) throw new Error('market_not_accepting');
            const metadataVerifiedAt = this.clock();
            const pair = await this.bookReader(market, { clock: this.clock,
                deadlineAt: Math.min(deadline, metadataVerifiedAt + this.config.bookPolicy.maxRoundTripMs),
                metadataVerifiedAt, policy: this.config.bookPolicy });
            const at = this.clock(), books = validatedEarlyPaperBooks(market, pair, at, this.config.bookPolicy);
            this.markets.set(slug, market);
            Object.assign(this.store.state.markets[slug], { conditionId: market.conditionId, market: structuredClone(market) });
            return { market, books, pair, validation: { at, identity: metadataIdentity(market), bookEvidence: pair.evidence } };
        }
        await this.client.books(market);
        const at = this.clock(), validation = { at, generation, identity: metadataIdentity(market) };
        const books = await verifyStreamSnapshot(this.client, stream, market, validation, this.clock, this.config.dataAgeMs, requireWarm);
        this.markets.set(slug, market);
        Object.assign(this.store.state.markets[slug], { conditionId: market.conditionId, market: structuredClone(market) });
        return { market, books, validation, stream };
    }
    checkWindow(scheduledAt, market, premarket = true) {
        const now = this.clock();
        if (this.entryCutoffRequested()) throw new Error('entry_cutoff');
        if (this.closed || now < scheduledAt || now > scheduledAt + this.config.slotToleranceMs
            || (premarket ? now >= this.entryEnd(market) : now >= market.end)) throw new Error('slot_late_after_validation');
        if (!this.clockFresh(now)) throw new Error('clock_unverified');
        return now;
    }
    async observePremarket(slug, scheduledAt, key) {
        if (!this.restEarlyProfile()) return this.capturePremarket(slug, scheduledAt, key);
        const deadline = scheduledAt + this.config.slotToleranceMs;
        for (;;) {
            if (!this.clockFresh()) await this.verifyClock();
            try { return await this.capturePremarket(slug, scheduledAt, key); }
            catch (error) {
                if (error.durableStateCommitted || !this.transientRead(error) || this.closed || this.entryCutoffRequested()
                    || this.clock() + this.config.earlyExecution.retryMs >= deadline) throw error;
                const wait = Math.max(this.config.earlyExecution.retryMs, (error.retryAfter || 0) * 1000);
                if (this.clock() + wait >= deadline) throw error;
                this.store.event('capture_read_retry', { slug, error: safeError(error), nextDelayMs: wait });
                await this.sleep(wait);
            }
        }
    }
    async capturePremarket(slug, scheduledAt, key) {
        this.markUnselected(slug);
        const market = this.markets.get(slug);
        if (!market) throw new Error('target_market_unavailable');
        this.checkWindow(scheduledAt, market);
        const features = this.earlyProfile()
            ? earlyPremarketFeatures(this.candleContext(scheduledAt), market, scheduledAt, this.config)
            : premarketFeatures(this.history.points, market, scheduledAt, this.config);
        if (!features.bars) throw new Error(features.reason);
        const verified = await this.validated(slug, false, scheduledAt + this.config.slotToleranceMs),
            at = this.checkWindow(scheduledAt, verified.market);
        const historyAgeLimit = this.earlyProfile() ? this.config.candleCacheMaxAgeMs : this.config.dataAgeMs;
        if (at - features.observedAt + this.config.latencyMs > historyAgeLimit) throw new Error('stale_input_at_capture');
        const orders = Object.fromEntries(['BUY_UP', 'BUY_DOWN'].map((action, index) =>
            [action, premarketOrder(verified.market, verified.books, index, this.config, this.config.capital).order || null]));
        if (this.nextProfile()) {
            const signal = nextReversalSignal(features, this.config.signalParameters);
            for (const action of ['BUY_UP', 'BUY_DOWN']) if (action !== signal.action) orders[action] = null;
        }
        const snapshot = { snapshotId: hash([this.config.id, key]).slice(0, 24), market: structuredClone(verified.market),
            scheduledAt, at, observedAt: features.observedAt, features, books: structuredClone(verified.books), orders,
            aiDeadlineAt: this.decisionDeadline(at, market), decisions: {} };
        if (verified.pair) snapshot.bookEvidence = structuredClone(verified.pair.evidence);
        if (this.fairProfile()) {
            if (!this.providers?.prepareSnapshot) throw new Error('fair_common_input_unavailable');
            snapshot.commonInput = freeze(structuredClone(await this.providers.prepareSnapshot(snapshot)));
            const preparedAt = this.checkWindow(scheduledAt, verified.market);
            if (preparedAt - features.observedAt + this.config.latencyMs > historyAgeLimit) throw new Error('stale_input_at_capture');
            const momentum = this.earlyProfile() ? earlyReversalDecision(snapshot.commonInput.context, this.config.signalParameters)
                : fairMomentumDecision(snapshot.commonInput.context, this.config.signalParameters);
            Object.assign(features, { action: momentum.action, reason: momentum.reason, momentum });
            snapshot.decisionCutoffAt = snapshot.aiDeadlineAt;
            snapshot.fairExecution = { status: 'awaiting_cutoff', scheduledAt: snapshot.decisionCutoffAt,
                deadlineAt: this.restEarlyProfile() ? this.readinessDeadline(snapshot.decisionCutoffAt, market)
                    : snapshot.decisionCutoffAt + this.config.slotToleranceMs,
                ...(this.restEarlyProfile() ? { attempts: [] } : {}) };
            this.fairSnapshots.set(snapshot.snapshotId, snapshot);
        }
        this.store.state.snapshots.push(snapshot); this.store.state.slots[key].status = 'observed';
        const name = 'premarket-momentum', selected = this.armSelected(name);
        const decision = snapshot.decisions[name] = { status: selected ? 'ok' : 'arm_not_selected',
            action: selected ? features.action : 'SKIP', reason: selected ? features.reason : 'arm_not_selected',
            startedAt: at, receivedAt: this.fairProfile() ? this.clock() : at, inferenceAttempted: false };
        if (this.fairProfile()) Object.assign(decision, Object.fromEntries(['inputHash', 'inputCoverage', 'inputBytes',
            'contextTokens', 'contextIdentity', 'contextVerified', 'semanticPromptHash'].map(field => [field, snapshot.commonInput[field]])));
        if (selected && this.fairProfile()) decision.entryDisposition = 'awaiting_shared_cutoff';
        else if (selected) this.admit(name, snapshot, decision, verified, false);
        else decision.entryDisposition = 'arm_not_selected';
        this.store.event('snapshot', { snapshotId: snapshot.snapshotId, slug, scheduledAt, observedAt: features.observedAt,
            action: features.action, features, orders });
        for (const [arm, provider] of Object.entries(this.config.providerArms || {})) {
            const world = this.store.state.arms[arm];
            const offeredInput = this.fairProfile() && this.armSelected(arm) ? {
                offeredInputHash: snapshot.commonInput.inputHash, offeredInputCoverage: snapshot.commonInput.inputCoverage,
                offeredContextTokens: snapshot.commonInput.contextTokens, offeredContextIdentity: snapshot.commonInput.contextIdentity,
                offeredContextVerified: snapshot.commonInput.contextVerified,
                offeredSemanticPromptHash: snapshot.commonInput.semanticPromptHash,
                ...(provider === 'router' ? Object.fromEntries(Object.entries(routerDirectionalPromptEvidence(this.config))
                    .map(([field, value]) => [`offered${field[0].toUpperCase()}${field.slice(1)}`, value])) : {}) } : {};
            const unavailable = !this.armSelected(arm) ? 'arm_not_selected' : this.entryCutoffRequested() ? 'entry_cutoff' : world.stopped ? 'arm_stopped'
                : this.nextProfile() && features.action === 'SKIP' ? 'signal_not_met'
                : this.nextProfile() && !snapshot.orders[features.action] ? 'entry_constraints_not_met'
                : Object.keys(world.positions).length ? 'active_market_limit' : null;
            if (unavailable) {
                snapshot.decisions[arm] = { status: unavailable, action: 'SKIP', inferenceAttempted: false, requestSubmitted: false, ...offeredInput };
                this.skip(arm, slug, unavailable); continue;
            }
            if (!this.providers) { this.skip(arm, slug, 'provider_unavailable'); continue; }
            const row = snapshot.decisions[arm] = { status: 'requested', action: 'SKIP', startedAt: this.clock(),
                inferenceAttempted: true, ...offeredInput };
            this.store.save();
            this.launch(this.decideProvider(arm, provider, snapshot, row));
        }
    }
    async decideProvider(arm, provider, snapshot, row) {
        try {
            if (this.entryCutoffRequested()) {
                Object.assign(row, { status: 'entry_cutoff', action: 'SKIP', entryDisposition: 'entry_cutoff',
                    inferenceAttempted: false, requestSubmitted: false });
                this.skip(arm, snapshot.market.slug, 'entry_cutoff'); return;
            }
            if (!this.armSelected(arm)) {
                Object.assign(row, { status: 'arm_not_selected', action: 'SKIP', entryDisposition: 'arm_not_selected',
                    inferenceAttempted: false, requestSubmitted: false });
                this.skip(arm, snapshot.market.slug, 'arm_not_selected'); return;
            }
            const frozen = freeze(structuredClone(snapshot));
            let result;
            try { result = await this.providers.predict(provider, frozen); }
            catch (error) {
                if (error.durableStateCommitted) throw error;
                const code = boundedErrorCode(error);
                Object.assign(row, { status: 'provider_failed', action: 'SKIP', entryDisposition: 'provider_failed', receivedAt: this.clock() });
                this.skip(arm, snapshot.market.slug, 'provider_failed', { code }); this.store.error('provider', new Error(code)); return;
            }
            Object.assign(row, result);
            const now = this.clock();
            if (this.fairProfile()) Object.assign(row, { decisionCompletedAt: now,
                receivedAt: row.receivedAt ?? now, latencyMs: row.latencyMs ?? now - row.startedAt });
            if (this.entryCutoffRequested() || this.closed || now > snapshot.aiDeadlineAt || row.status !== 'ok' || !['BUY_UP', 'BUY_DOWN'].includes(row.action)) {
                row.entryDisposition = this.entryCutoffRequested() ? 'entry_cutoff' : this.closed ? 'provider_closed' : now > snapshot.aiDeadlineAt ? 'provider_late'
                    : row.status === 'ok' ? 'provider_skip' : row.status || 'provider_failed';
                this.skip(arm, snapshot.market.slug, row.entryDisposition); return;
            }
            if (this.fairProfile()) {
                if (snapshot.fairExecution.status !== 'awaiting_cutoff') {
                    row.entryDisposition = 'provider_late'; this.skip(arm, snapshot.market.slug, 'provider_late'); return;
                }
                row.entryDisposition = 'awaiting_shared_cutoff'; return;
            }
            let verified;
            try { verified = await this.validated(snapshot.market.slug); }
            catch (error) {
                if (error.durableStateCommitted) throw error;
                const code = boundedErrorCode(error);
                Object.assign(row, { entryDisposition: 'execution_validation_failed', executionValidationCode: code });
                this.skip(arm, snapshot.market.slug, 'execution_validation_failed', { code });
                this.store.error('execution_validation', new Error(code)); return;
            }
            if (this.entryCutoffRequested()) { row.entryDisposition = 'entry_cutoff'; this.skip(arm, snapshot.market.slug, 'entry_cutoff'); return; }
            if (this.clock() > snapshot.aiDeadlineAt) { row.entryDisposition = 'provider_late'; this.skip(arm, snapshot.market.slug, 'provider_late'); return; }
            this.admit(arm, snapshot, row, verified, true);
        } finally {
            this.store.event('provider_decision', { arm, slug: snapshot.market.slug, snapshotId: snapshot.snapshotId, ...row });
        }
    }
    scheduleFairExecutions(now = this.clock()) {
        if (!this.fairProfile() || this.closed || this.entryCutoffRequested()) return;
        for (const snapshot of this.fairSnapshots.values()) {
            if (snapshot.fairExecution.status !== 'awaiting_cutoff' || now < snapshot.decisionCutoffAt) continue;
            snapshot.fairExecution.status = 'validating';
            this.launch(this.adjudicateFairSnapshot(snapshot).catch(error => {
                if (error.durableStateCommitted) throw error;
                this.store.error('fair_execution', new Error(boundedErrorCode(error)));
            }));
        }
    }
    async adjudicateFairSnapshot(snapshot) {
        const timing = snapshot.fairExecution, slug = snapshot.market.slug;
        const fail = (reason, code) => {
            Object.assign(timing, { status: 'skipped', reason, ...(code ? { code } : {}) });
            for (const name of this.config.activeArms) {
                const decision = snapshot.decisions[name];
                if (decision && !this.store.state.arms[name].outcomes[slug]) decision.entryDisposition = reason;
                this.skip(name, slug, reason, code ? { code } : {});
            }
        };
        try {
            timing.adjudicatedAt = this.clock();
            if (this.entryCutoffRequested() || this.closed) return fail(this.closed ? 'provider_closed' : 'entry_cutoff');
            if (timing.adjudicatedAt > timing.deadlineAt) return fail('shared_execution_late');
            const candidates = [];
            for (const name of this.config.activeArms) {
                const decision = snapshot.decisions[name];
                if (this.store.state.arms[name].outcomes[slug]) continue;
                if (!decision || decision.status === 'requested' || decision.receivedAt > snapshot.aiDeadlineAt
                    || decision.decisionCompletedAt > snapshot.aiDeadlineAt) {
                    if (decision) decision.entryDisposition = 'provider_late';
                    this.skip(name, slug, 'provider_late'); continue;
                }
                if (decision.status !== 'ok' || !['BUY_UP', 'BUY_DOWN'].includes(decision.action)) {
                    const reason = decision.status === 'ok' ? decision.reason || 'provider_skip' : decision.status;
                    decision.entryDisposition = reason; this.skip(name, slug, reason); continue;
                }
                candidates.push([name, decision]);
            }
            if (!candidates.length) return fail('no_eligible_decisions');
            let verified;
            for (;;) {
                if (this.restEarlyProfile() && this.clock() + this.config.latencyMs >= timing.deadlineAt)
                    return fail('shared_execution_late');
                const attempt = { startedAt: this.clock() };
                if (this.restEarlyProfile()) timing.attempts.push(attempt);
                try {
                    if (this.restEarlyProfile() && !this.clockFresh()) await this.verifyClock();
                    if (this.entryCutoffRequested() || this.closed) {
                        const reason = this.closed ? 'provider_closed' : 'entry_cutoff';
                        Object.assign(attempt, { finishedAt: this.clock(), status: 'failed', code: reason });
                        return fail(reason);
                    }
                    if (!this.clockFresh()) throw new Error('clock_unverified');
                    if (this.restEarlyProfile() && this.clock() + this.config.latencyMs >= timing.deadlineAt)
                        throw new Error('shared_execution_late');
                    verified = await this.validated(slug, false, timing.deadlineAt - this.config.latencyMs);
                    if (!verified.market.accepting) throw new Error('market_not_accepting');
                    if (metadataIdentity(snapshot.market) !== metadataIdentity(verified.market)) throw new Error('market_metadata_changed');
                    Object.assign(attempt, { finishedAt: this.clock(), status: 'verified' });
                    break;
                } catch (error) {
                    if (error.durableStateCommitted) throw error;
                    const code = boundedErrorCode(error), wait = Math.max(this.config.earlyExecution?.retryMs || 0,
                        (error.retryAfter || 0) * 1000);
                    Object.assign(attempt, { finishedAt: this.clock(), status: 'failed', code });
                    if (!this.restEarlyProfile() || !this.transientRead(error) || this.clock() + wait + this.config.latencyMs >= timing.deadlineAt) {
                        fail('execution_validation_failed', code); this.store.error('execution_validation', new Error(code)); return;
                    }
                    this.store.event('execution_read_retry', { slug, snapshotId: snapshot.snapshotId,
                        error: safeError(error), nextDelayMs: wait, deadlineAt: timing.deadlineAt });
                    await this.sleep(wait);
                }
            }
            const submittedAt = this.clock();
            if (this.entryCutoffRequested() || this.closed) return fail(this.closed ? 'provider_closed' : 'entry_cutoff');
            if (submittedAt > timing.deadlineAt || this.restEarlyProfile()
                && submittedAt + this.config.latencyMs >= timing.deadlineAt) return fail('shared_execution_late');
            Object.assign(timing, { status: 'reserved', validatedAt: verified.validation.at, submittedAt,
                activeAt: submittedAt + this.config.latencyMs, validationBookHash: hash(verified.books) });
            for (const [name, decision] of candidates) this.admit(name, snapshot, decision, verified,
                name !== 'premarket-momentum', submittedAt);
            if (!candidates.some(([name]) => this.store.state.arms[name].positions[slug]?.status === 'pending'))
                Object.assign(timing, { status: 'skipped', reason: 'no_orders_admitted' });
        } finally {
            this.fairSnapshots.delete(snapshot.snapshotId);
            this.store.event('fair_execution_adjudicated', { slug, snapshotId: snapshot.snapshotId, ...timing });
        }
    }
    admit(name, snapshot, decision, verified, ai, sharedSubmittedAt) {
        const fair = this.fairProfile();
        const arm = this.store.state.arms[name], slug = snapshot.market.slug, now = sharedSubmittedAt ?? this.clock();
        const fail = reason => { decision.entryDisposition = reason; this.skip(name, slug, reason); };
        if (!this.armSelected(name)) return fail('arm_not_selected');
        if (this.entryCutoffRequested()) return fail('entry_cutoff');
        if (arm.positions[slug] || arm.outcomes[slug]) { decision.entryDisposition = 'already_attempted'; return; }
        if (Object.keys(arm.positions).length >= (this.config.maxActiveMarketsPerArm || 1)) return fail('active_market_limit');
        if (arm.stopped) return fail('arm_stopped');
        if (!this.clockFresh(now)) return fail('clock_unverified');
        if (decision.action === 'SKIP') return fail(decision.reason || 'signal_not_met');
        if (this.closed || now >= this.entryEnd(snapshot.market)) return fail('premarket_window_closed');
        if (!verified.market.accepting) return fail('market_not_accepting');
        const order = snapshot.orders[decision.action];
        if (!order) return fail('entry_constraints_not_met');
        if (metadataIdentity(snapshot.market) !== metadataIdentity(verified.market)) return fail('market_metadata_changed');
        if (order.cost > this.availableCash(arm) + EPS) return fail('insufficient_virtual_cash');
        if (!fair && !ai && now - snapshot.observedAt + this.config.latencyMs > this.config.dataAgeMs) return fail('stale_input');
        if (!fair && ai && now > snapshot.aiDeadlineAt) return fail('provider_late');
        if (fair && (sharedSubmittedAt === undefined || now < snapshot.decisionCutoffAt
            || now > snapshot.fairExecution.deadlineAt)) return fail('shared_execution_late');
        arm.positions[slug] = { market: structuredClone(verified.market), order: structuredClone(order), snapshotId: snapshot.snapshotId,
            status: 'pending', submittedAt: now, activeAt: now + this.config.latencyMs, validation: structuredClone(verified.validation),
            observedAt: snapshot.observedAt, forecastExpiresAt: this.restEarlyProfile() ? snapshot.fairExecution.deadlineAt
                : fair ? snapshot.fairExecution.deadlineAt + this.config.latencyMs
                : ai ? snapshot.aiDeadlineAt + this.config.latencyMs : snapshot.observedAt + this.config.dataAgeMs,
            premarket: true, ai, holdings: 0, entryCost: 0, fees: 0, capitalHours: 0 };
        decision.entryDisposition = 'reserved';
        this.store.event('order_pending', { arm: name, slug, snapshotId: snapshot.snapshotId, order, activeAt: now + this.config.latencyMs });
    }
    async observeLate(slug, scheduledAt, key) {
        if (this.entryCutoffRequested()) throw new Error('entry_cutoff');
        const arm = this.store.state.arms['late-cost-cap'];
        if (!this.armSelected('late-cost-cap')) {
            Object.assign(this.store.state.slots[key], { status: 'skipped', reason: 'arm_not_selected' });
            this.skip('late-cost-cap', slug, 'arm_not_selected'); this.store.save(); return;
        }
        if (Object.keys(arm.positions).length || arm.outcomes[slug] || arm.stopped) {
            Object.assign(this.store.state.slots[key], { status: 'skipped', reason: arm.stopped ? 'arm_stopped'
                : arm.positions[slug] || arm.outcomes[slug] ? 'already_attempted' : 'active_market_limit' }); this.store.save(); return;
        }
        const verified = await this.validated(slug, true), { market, books, stream } = verified;
        const at = this.checkWindow(scheduledAt, market, false);
        const opening = this.client.btc.openings.get(market.open);
        if (opening) market.reference = { source: 'chainlink_twap_60s', open: market.open, end: market.end,
            value: opening.value, observedAt: opening.at, receivedAt: opening.receivedAt };
        const features = makeFeatures(this.client.btc, market, books, stream, at);
        const checks = candidateChecks(market, books, this.config, this.availableCash(arm), at);
        const allowed = checks.filter(check => check.order).filter(check => {
            const assessed = this.client.btc.assess(market, check.order, this.config.control, at);
            check.signal = assessed; return !assessed.reason || optionalModelReasons.has(assessed.reason);
        });
        const selected = allowed.length === 1 ? allowed[0] : null;
        const slot = this.store.state.slots[key];
        const reason = !selected ? 'no_single_eligible_side' : selected.order.cost / this.config.shares > this.config.costCapPerShare + EPS
            ? 'entry_cost_above_cap' : at - features.observedAt + this.config.latencyMs > this.config.dataAgeMs ? 'stale_input' : null;
        Object.assign(slot, { status: reason ? 'skipped' : 'reserved_order', reason, checks });
        if (reason) { this.store.event('late_slot_skipped', { slug, key, reason, checks }); return; }
        arm.positions[slug] = { market: structuredClone(market), order: structuredClone(selected.order),
            snapshotId: hash([this.config.id, key]).slice(0, 24), status: 'pending', submittedAt: at, activeAt: at + this.config.latencyMs,
            validation: structuredClone(verified.validation), observedAt: features.observedAt,
            forecastExpiresAt: features.observedAt + this.config.dataAgeMs, premarket: false,
            holdings: 0, entryCost: 0, fees: 0, capitalHours: 0 };
        this.store.event('order_pending', { arm: 'late-cost-cap', slug, order: selected.order, activeAt: at + this.config.latencyMs });
    }
    scheduleEarlyPending() {
        for (const arm of Object.values(this.store.state.arms)) for (const [slug, position] of Object.entries(arm.positions)) {
            if (position.status !== 'pending' || this.clock() < position.activeAt || this.executionReads.has(position.snapshotId)) continue;
            const snapshotId = position.snapshotId;
            const task = (async () => {
                try {
                    const verified = await this.validated(slug, false, position.forecastExpiresAt);
                    if (!verified.market.accepting) throw new Error('market_not_accepting');
                    if (this.clock() < position.activeAt || verified.pair.evidence.startedAt < position.activeAt)
                        throw new Error('execution_clock_reversed');
                    const snapshot = this.store.state.snapshots.find(row => row.snapshotId === snapshotId);
                    Object.assign(snapshot.fairExecution, { executionEvidence: structuredClone(verified.pair.evidence),
                        executionBooks: structuredClone(verified.books), executionBookHash: hash(verified.books), executionAt: this.clock() });
                    this.executePending({ snapshotId, pair: verified.pair });
                } catch (error) {
                    if (error.durableStateCommitted) throw error;
                    const code = boundedErrorCode(error);
                    for (const [name, candidate] of Object.entries(this.store.state.arms)) {
                        if (candidate.positions[slug]?.status !== 'pending' || candidate.positions[slug].snapshotId !== snapshotId) continue;
                        delete candidate.positions[slug]; this.skip(name, slug, 'execution_expired', { code });
                    }
                    this.store.error('execution_read', error);
                }
            })().finally(() => this.executionReads.delete(snapshotId));
            this.executionReads.set(snapshotId, task); this.launch(task);
        }
    }
    executePending(ready = null) {
        if (typeof ready !== 'object') ready = null;
        if (this.entryCutoffRequested()) { this.cancelPendingForCutoff(); return; }
        if (this.restEarlyProfile() && !ready) { this.scheduleEarlyPending(); return; }
        const fair = this.fairProfile(), sharedNow = fair ? this.clock() : null, sharedBooks = new Map();
        let sharedHistory;
        for (const [name, arm] of Object.entries(this.store.state.arms)) for (const [slug, position] of Object.entries(arm.positions)) {
            if (ready && position.snapshotId !== ready.snapshotId) continue;
            const now = fair ? sharedNow : this.clock();
            if (position.status === 'pending' && !this.armSelected(name)) {
                delete arm.positions[slug]; this.skip(name, slug, 'arm_not_selected'); continue;
            }
            if (position.status !== 'pending' || now < position.activeAt) continue;
            try {
                if (this.closed || !this.clockFresh(now) || arm.stopped || now > position.forecastExpiresAt
                    || now >= (position.premarket ? this.entryEnd(position.market) : position.market.end)) throw new Error('execution_stale');
                const stream = this.streams.get(slug);
                if (!stream && !ready) throw new Error('execution_book_unavailable');
                // All fair virtual arms sweep the same observed book independently, without sharing simulated liquidity.
                let books = fair ? sharedBooks.get(position.snapshotId) : null;
                if (!books) {
                    books = structuredClone(ready ? validatedEarlyPaperBooks(position.market, ready.pair, now, this.config.bookPolicy)
                        : validatedStreamBooks(stream, position.market, position.validation, now, this.config.dataAgeMs, !position.premarket));
                    if (fair) sharedBooks.set(position.snapshotId, books);
                }
                if (this.earlyProfile()) {
                    const history = sharedHistory ||= this.candleContext(now);
                    if (!history.ready) throw new Error(history.reason || 'candle_history_unavailable');
                } else if (!this.client.btc.status(now).ready) throw new Error('btc_feed_stale_or_warming');
                const quality = quoteQuality({ orders: [position.order] }, books, this.config.control, { requireDepth: false });
                if (quality.reason) throw new Error(quality.reason);
                if (!position.premarket) {
                    const check = candidateChecks(position.market, books, { ...this.config, limitSlippageTicks: 0, limitSlippageUsd: 0 },
                        arm.cash, now, false).find(check => check.index === position.order.index);
                    if (!check?.order) throw new Error(check?.reason || 'execution_side_invalid');
                    const signal = this.client.btc.assess(position.market, position.order, this.config.control, now);
                    if (signal.reason && !optionalModelReasons.has(signal.reason)) throw new Error(signal.reason);
                }
                const fill = sweep(books[position.order.index].asks, position.order.shares, position.order.price, 'BUY', position.market.fee);
                if (fill.shares <= EPS) throw new Error('fixed_limit_not_marketable');
                if (-fill.cash + this.config.gasUsd > position.order.cost + EPS || -fill.cash + this.config.gasUsd > arm.cash + EPS)
                    throw new Error('execution_budget_exceeded');
                Object.assign(position, { status: 'matched', fill, holdings: fill.shares, entryCost: -fill.cash, fees: fill.fees,
                    executionAt: now, settleAt: now + this.config.settlementMs, executionBookHash: hash(books), lastCapitalAt: now });
                if (ready) {
                    position.executionEvidence = structuredClone(ready.pair.evidence);
                    const snapshot = this.store.state.snapshots.find(row => row.snapshotId === position.snapshotId);
                    snapshot.fairExecution.executionAt = now;
                }
                // Debit at match so concurrent future markets cannot reuse reserved capital.
                arm.cash = round(arm.cash + fill.cash);
                this.store.event('fill_matched', { arm: name, slug, fill, executionAt: now,
                    executionLatencyMs: now - position.submittedAt, executionBookHash: position.executionBookHash, limit: position.order.price });
            } catch (error) {
                if (error.durableStateCommitted || position.status !== 'pending') throw error;
                delete arm.positions[slug];
                this.skip(name, slug, error.message === 'fixed_limit_not_marketable' ? 'no_fill' : 'execution_expired', { code: error.message });
            }
        }
    }
    async settle(now = this.clock()) {
        for (const [slug, record] of Object.entries(this.store.state.markets)) {
            if (now >= record.end) {
                for (const [name, arm] of Object.entries(this.store.state.arms)) if (!arm.positions[slug] && !arm.outcomes[slug])
                    this.skip(name, slug, arm.stopped ? 'arm_stopped' : 'no_entry');
                if (!record.payout && now >= (record.payoutNextAt || 0)) {
                    record.payoutNextAt = now + 15000;
                    try {
                        if (!record.conditionId) {
                            const market = await this.client.market(slug);
                            if (market.slug !== slug || market.open !== record.open || market.end !== record.end) throw new Error('market_identity_mismatch');
                            record.conditionId = market.conditionId;
                        }
                        const payout = await this.client.payout(record.conditionId);
                        record.payoutFailures = 0;
                        if (payout) {
                            if (!validPayout(payout)) throw new Error('invalid_official_payout');
                            record.payout = [...payout]; record.labelResolvedAt = this.clock();
                            this.store.event('market_label', { slug, payout });
                        }
                    } catch (error) {
                        if (this.restEarlyProfile()) {
                            record.payoutFailures = (record.payoutFailures || 0) + 1;
                            record.payoutNextAt = this.clock() + Math.min(60000, 15000 * 2 ** Math.min(record.payoutFailures, 2));
                        }
                        this.store.error('official_payout', error);
                    }
                }
            }
            for (const [name, arm] of Object.entries(this.store.state.arms)) {
                const position = arm.positions[slug];
                if (!position || position.status === 'pending') continue;
                const at = this.clock();
                position.capitalHours += position.entryCost * Math.max(0, at - position.lastCapitalAt) / 3600000;
                position.lastCapitalAt = at;
                if (position.status === 'matched' && at >= position.settleAt) { position.status = 'filled'; this.store.save(); }
                if (position.status !== 'filled' || !record.payout || at < record.end) continue;
                const redeemed = position.holdings * record.payout[position.order.index];
                const pnl = round(redeemed - position.entryCost - this.config.gasUsd);
                const result = { slug, side: position.order.index === 0 ? 'UP' : 'DOWN', pnl, shares: position.holdings,
                    entryCost: position.entryCost, fees: position.fees, gas: this.config.gasUsd, payout: [...record.payout],
                    openedAt: position.submittedAt, closedAt: at, executionAt: position.executionAt, marketEnd: record.end,
                    partial: position.holdings < position.order.shares - EPS, averageFillPrice: round(position.fill.notional / position.holdings),
                    allInCostPerShare: round((position.entryCost + this.config.gasUsd) / position.holdings),
                    capitalHours: position.capitalHours, executionBookHash: position.executionBookHash,
                    ...(position.executionEvidence ? { executionEvidence: position.executionEvidence, orderLimit: position.order.price } : {}) };
                arm.cash = round(arm.cash + redeemed - this.config.gasUsd); arm.completed.push(result);
                arm.outcomes[slug] = { pnl, noExposure: false, reason: 'settled', closedAt: at };
                delete arm.positions[slug];
                const realizedEquity = this.config.capital + arm.completed.reduce((sum, row) => sum + row.pnl, 0);
                arm.peak = Math.max(arm.peak, realizedEquity); arm.drawdown = Math.max(arm.drawdown, arm.peak - realizedEquity);
                if (!arm.stopped && arm.drawdown >= this.config.drawdownStop - EPS)
                    arm.stopped = { at, reason: 'realized_drawdown_limit', drawdown: round(arm.drawdown) };
                this.store.event('official_settlement', { arm: name, ...result });
            }
        }
    }
    close() {
        this.closed = true;
        this.cancelFairDecisions('shutdown_pending_cancelled');
        for (const [name, arm] of Object.entries(this.store.state.arms)) for (const [slug, position] of Object.entries(arm.positions)) {
            if (position.status !== 'pending') continue;
            delete arm.positions[slug]; this.skip(name, slug, 'shutdown_pending_cancelled');
        }
        for (const stream of this.streams.values()) stream.close();
        this.providers?.close();
        const closed = this.client.close();
        this.store.save();
        return closed;
    }
}
