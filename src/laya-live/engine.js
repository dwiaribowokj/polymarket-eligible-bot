import crypto from 'node:crypto';
import { MaintenanceEngine } from './maintenance.js';
import { LiveClockGate } from './clock.js';
import { EPS, fee, round } from '../restart/math.js';
import { marketSlug, newPosition } from '../restart/strategy.js';
import { candidateChecks, metadataIdentity, verifyStreamSnapshot, validatedStreamBooks, ShadowEngine } from '../ai-shadow/engine.js';
import { encodeFeatures } from '../ai-shadow/history.js';
import { LayaLiveBroker, operationCode } from './broker.js';
import { compactLiveAiHistory } from './store.js';
import { OperationalError } from '../restart/network.js';
import { safeError } from './network.js';
import { recoverSettlementStop } from './settlement-recovery.js';
import { distributionAdjustedCash } from './profit-accounting.js';
import { profitWithdrawalPending } from './profit-taking.js';
import { captureLossWalletEvidence, lossProtectionActivationId } from './loss-evidence.js';
import { liveDeadline } from './limits.js';
import { clearEntryHold, entryHeld, holdEntry, marketDiscoveryUnavailable, openingMarketReadUnavailable,
    readRetryReady, temporaryReadFailure } from './entry-holds.js';
import { continuousRecoveryReadCandidate } from '../eligible-live/continuous-recovery.js';
import { ELIGIBLE_BUFFER_POLICY, assertEligibleEntryPolicy, eligibleEntryPolicy,
    prepareEligibleEntryBuffer } from '../eligible-live/entry-buffer.js';
import { assertEligibleBinanceLeadLive, prepareEligibleBinanceLead } from '../eligible-live/entry-cost-cap.js';

const invalidData = code => ['stale_laya_input', 'late_laya_response', 'entry_metadata_changed', 'execution_metadata_changed_or_expired',
    'execution_token_mismatch', 'execution_tick_mismatch', 'execution_book_stale_or_future',
    'execution_book_invalid', 'execution_book_unavailable', 'btc_feed_stale_or_warming',
    'btc_twap_source_mismatch', 'btc_reference_unverified', 'btc_calibration_unverified', 'invalid_btc_signal_time',
    'future_twap',
    'invalid_laya_input_time', 'invalid_laya_response_time', 'invalid_snapshot_time',
    'stale_eligible_input', 'late_eligible_response', 'invalid_eligible_input_time', 'invalid_eligible_response_time'].includes(code);

// These misses cannot create exposure before the market is reserved. A slot
// is consumed, and the next slot must pass all metadata/history checks again.
const bookResync = code => ['execution_book_unavailable', 'history_not_ready', 'execution_book_generation_changed'].includes(code);
const decisionExpired = code => ['stale_laya_input', 'late_laya_response', 'stale_eligible_input', 'late_eligible_response', 'entry_wallet_expired'].includes(code);
const FLAT_WALLET_AUDIT = { intervalMs: 15000, slotLeadMs: 10000, maxDeferralMs: 30000 };
const feedWarming = code => ['btc_feed_stale_or_warming', 'btc_volatility_warmup', 'btc_history_gap'].includes(code);
const feedDisparity = error => error?.code === 'btc_twap_source_mismatch'
    && error.category === 'opportunity' && error.stage === 'btc_feed';
const feedDisparityEvidence = detail => Object.fromEntries(
    ['feedDifferenceUsd', 'maxFeedDifferenceUsd', 'spotAt', 'twapAt']
        .filter(key => Number.isFinite(detail?.[key])).map(key => [key, detail[key]]));
const temporaryEntryReadFailure = error => temporaryReadFailure(error)
    || error?.code === 'stale_book' && error?.category === 'stale_data';
const entryResponseCodes = new Map([
    ['metadata_read', new Set(['invalid_api_data', 'metadata_mismatch', 'invalid_tick_size'])],
    ['book_read', new Set(['invalid_api_data', 'invalid_entry_books', 'market_constraints_changed', 'tick_snapshot_mismatch'])],
]);
const entryResponseFailure = error => {
    const diagnostic = safeError(error);
    return diagnostic.category === 'validation' && entryResponseCodes.get(diagnostic.stage)?.has(diagnostic.code);
};
const observationCodes = new Set(['entry_metadata_changed', 'execution_metadata_changed_or_expired',
    'execution_token_mismatch', 'execution_tick_mismatch', 'execution_book_stale_or_future',
    'execution_book_invalid', 'execution_book_unavailable', 'invalid_btc_signal_time',
    'btc_reference_unverified', 'future_twap']);
const watchResponseFailure = error => {
    const diagnostic = safeError(error);
    return operationCode(error) === 'market_identity_mismatch'
        || diagnostic.category === 'validation' && ['invalid_api_data', 'invalid_tick_size', 'metadata_mismatch',
            'unsupported_outcomes', 'missing_market_constraints', 'unsupported_market',
            'unsupported_btc_resolution_source'].includes(diagnostic.code)
        && (!diagnostic.stage || ['market_discovery', 'metadata_read', 'btc_reference'].includes(diagnostic.stage));
};
const settlementTransportGap = detail => ['quote_timeout', 'quote_gap', 'socket_error', 'socket_create_failed',
    'subscribe_failed', 'ping_failed'].includes(detail.reason)
    || detail.reason === 'socket_closed' && [1000, 1001, 1006, 1011, 1012, 1013].includes(detail.closeCode)
        && !['authorization', 'protocol'].includes(detail.closeReasonClass);

function decisionProvider(config) {
    const provider = config.policy?.provider ?? 'laya';
    if (!['laya', 'eligible'].includes(provider)) throw new Error('live_provider_identity_mismatch');
    return provider;
}

function eligibleAdmissionReason(snapshot, config, now) {
    // Deterministic filters do not spend an AI inference budget before wallet validation.
    const decisionReserveMs = eligibleEntryPolicy(config) ? 0 : config.ai.decisionMs;
    const maxAgeMs = config.ai.dataAgeMs - decisionReserveMs - 250 - (config.ai.inferenceReserveMs ?? 150);
    const inputAge = now - snapshot.observedAt;
    const validationAge = now - Math.min(snapshot.validation.at, snapshot.validation.tickVerifiedAt ?? Infinity);
    if (inputAge < 0 || inputAge > maxAgeMs) return 'insufficient_input_headroom';
    if (validationAge < 0 || validationAge > maxAgeMs) return 'insufficient_validation_headroom';
    return null;
}

export function assertDecisionTiming(snapshot, config, now) {
    const provider = decisionProvider(config);
    if (!Number.isFinite(snapshot.at) || snapshot.at > now) throw new Error('invalid_snapshot_time');
    if (!Number.isFinite(snapshot.decisionReceivedAt) || snapshot.decisionReceivedAt < snapshot.at
        || snapshot.decisionReceivedAt > now) throw new Error(`invalid_${provider}_response_time`);
    if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > snapshot.at)
        throw new Error(`invalid_${provider}_input_time`);
    const requestedAt = snapshot.decisionRequestedAt ?? snapshot.at;
    if (!Number.isFinite(requestedAt) || requestedAt < snapshot.at || requestedAt > snapshot.decisionReceivedAt)
        throw new Error(`invalid_${provider}_response_time`);
    if (snapshot.decisionReceivedAt - requestedAt > config.ai.decisionMs) throw new Error(`late_${provider}_response`);
    if (now - snapshot.observedAt > config.ai.dataAgeMs) throw new Error(`stale_${provider}_input`);
}

export function initializeAI(state, config) {
    const provider = decisionProvider(config);
    if (provider === 'eligible') eligibleEntryPolicy(config);
    if (state.decisionProvider && state.decisionProvider !== provider) throw new Error('live_provider_identity_mismatch');
    if (provider === 'eligible' && (config.ai?.decisionProtocol || config.ai?.latencyMs !== 250
        || Object.keys(state.ai?.providers || {}).some(name => name !== provider)))
        throw new Error('invalid_eligible_configuration');
    state.decisionProvider = provider;
    state.ai ||= { providers: {}, slots: {}, snapshots: [], sourceExperiment: config.policy.aiSource };
    if (state.ai.sourceExperiment !== config.policy.aiSource) throw new Error('live_ai_source_changed');
    for (const provider of Object.values(state.ai.providers)) if (provider.pending) {
        provider.disabled ||= 'restart_with_unknown_inference'; provider.pending = null;
    }
    return state.ai;
}

export function entryGuard({ state, config, market, snapshot, decision, spec, books, now }) {
    if (state.stopped || state.liveRiskStop) throw new Error('pilot_stopped');
    if (entryHeld(state)) throw new OperationalError('live_entry_held', 'opportunity');
    if (profitWithdrawalPending(state)) throw new Error('profit_withdrawal_pending');
    if (now >= liveDeadline(state, config.settings)) throw new Error('pilot_deadline');
    const provider = decisionProvider(config);
    const entryFilter = provider === 'eligible'
        ? assertEligibleEntryPolicy({ snapshot, config, now, market, spec, decision }) : null;
    const validIdentity = provider === 'eligible'
        ? state.decisionProvider === provider && snapshot.provider === provider && decision.provider === provider
            && decision.model === 'deterministic-eligible-v1' && decision.inferenceAttempted === false
            && snapshot.allowed.length === 1
        : ['typed-decisions', 'convaiinnovations/laya-typed-decisions', 'laya-typed-decisions'].includes(decision.model);
    if (decision.status !== 'ok' || decision.snapshotId !== snapshot.snapshotId
        || !['BUY_UP', 'BUY_DOWN'].includes(decision.action) || !validIdentity)
        throw new Error(`invalid_${provider}_decision`);
    if (config.ai.decisionProtocol && Object.entries(config.ai.decisionProtocol).some(([key, value]) =>
        snapshot.decisionProtocol?.[key] !== value || decision[key] !== value))
        throw new Error('live_decision_protocol_mismatch');
    assertDecisionTiming(snapshot, config, now);
    if (provider === 'eligible' && now < snapshot.decisionReceivedAt + 250)
        throw new Error('eligible_execution_latency_pending');
    if (metadataIdentity(market) !== snapshot.validation.identity) throw new Error('entry_metadata_changed');
    const index = decision.action === 'BUY_UP' ? 0 : 1;
    const selected = snapshot.allowed.find(order => order.index === index);
    if (!selected || spec.index !== index || spec.tokenId !== market.tokens[index]
        || spec.side !== 'BUY' || spec.kind !== 'taker' || spec.shares !== 5 || spec.price !== selected.price)
        throw new Error('entry_specification_changed');
    const cost = 5 * spec.price + fee(5, spec.price, market.fee) + config.ai.gasUsd;
    const spendable = distributionAdjustedCash(state);
    if (cost > 5 + EPS || cost > spendable + EPS) throw new Error('entry_budget_exceeded');
    const book = books[index];
    const executableShares = book.asks.reduce((total, level) => total +
        (Number.isFinite(level.price) && level.price <= spec.price + EPS
            && Number.isFinite(level.size) && level.size > 0 ? level.size : 0), 0);
    const execution = { snapshotId: snapshot.snapshotId, index, tokenId: spec.tokenId,
        ...(entryFilter ? { entryFilter } : {}),
        snapshotPrice: selected.snapshotPrice, limitPrice: spec.price,
        bestBid: book.bids[0]?.price ?? null, bestAsk: book.asks[0]?.price ?? null,
        executableShares, checkedAt: now, inputAgeMs: now - snapshot.observedAt,
        bookAgeMs: Number.isFinite(book.timestamp) ? now - book.timestamp : null,
        bookReceiveAgeMs: Number.isFinite(book.fetchedAt) ? now - book.fetchedAt : null,
        snapshotToCheckMs: now - snapshot.at };
    const valid = candidateChecks(market, books, { ...config.ai, limitSlippageTicks: 0, limitSlippageUsd: 0 }, spendable, now, false);
    const selectedCheck = valid.find(check => check.index === index);
    if (!selectedCheck?.order) throw Object.assign(new Error('execution_constraints_changed'), {
        execution, constraintReason: selectedCheck?.reason || 'missing_execution_check',
    });
    // Current quotes must be marketable at the limit chosen BEFORE inference.
    // Partial depth is valid for FAK; the original limit/shares never change.
    if (!(executableShares > 0)) throw Object.assign(new Error('execution_limit_unmarketable'), { execution });
    return execution;
}

export class LayaLiveEngine extends MaintenanceEngine {
    constructor(config, store, client, books, providers) {
        super(config.settings, store, client);
        Object.assign(this, { config, books, providers });
        initializeAI(store.state, config);
        this.ai = store.state.ai; this.current = null; this.closed = false; this.watchAttempt = 0;
        this.broker = new LayaLiveBroker(config.settings, store, client, spec => this.validate(spec));
        this.clockGate = new LiveClockGate(this.settings, store, client);
    }
    nextDelay() {
        const now = Date.now();
        if (this.broker.rpcRetryAt > now) return Math.min(1000, this.broker.rpcRetryAt - now);
        if (this.flatEntryReady(now)) {
            const slot = this.nextFlatEntrySlot(now);
            return slot !== null && now >= slot - FLAT_WALLET_AUDIT.slotLeadMs
                && now <= slot + this.config.ai.slotToleranceMs ? 100 : 1000;
        }
        return this.store.state.position ? 1000 : 100;
    }
    scheduledFlatWallet() {
        return this.continuousReadPolicy() && this.settings.automaticManualActivity === true;
    }
    flatEntryReady(now) {
        const state = this.store.state, faults = state.reconciliationFaults;
        return this.scheduledFlatWallet() && !this.closed && !state.position && !state.stopped
            && !state.liveRiskStop && !state.frozenAt && !entryHeld(state) && !profitWithdrawalPending(state)
            && (faults == null || typeof faults === 'object' && !Array.isArray(faults) && !Object.keys(faults).length)
            && this.clockAllowsEntry(now);
    }
    nextFlatEntrySlot(now) {
        const market = this.current;
        if (!market || market.slug !== marketSlug('late-entry', this.settings, now)
            || this.store.state.seen[market.slug] || !Number.isFinite(market.end)) return null;
        const slots = this.config.ai.slots.filter(seconds => !this.ai.slots[`${market.slug}:${seconds}`])
            .map(seconds => market.end - seconds * 1000);
        return slots.length ? Math.min(...slots) : null;
    }
    prioritizeFlatEntry(now) {
        if (!this.flatEntryReady(now)) return false;
        const slot = this.nextFlatEntrySlot(now);
        return slot !== null && now >= slot;
    }
    deferFlatWalletAudit(now) {
        if (!this.flatEntryReady(now)) {
            this.flatWalletDeferredAt = null;
            return false;
        }
        if (Number.isSafeInteger(this.lastFlatWalletAuditAt) && now >= this.lastFlatWalletAuditAt
            && now - this.lastFlatWalletAuditAt < FLAT_WALLET_AUDIT.intervalMs) return true;
        const slot = this.nextFlatEntrySlot(now);
        if (slot === null || now < slot - FLAT_WALLET_AUDIT.slotLeadMs
            || now > slot + this.config.ai.slotToleranceMs) {
            this.flatWalletDeferredAt = null;
            return false;
        }
        // Scheduling is process-local and never substitutes for a successful wallet read.
        if (!Number.isSafeInteger(this.flatWalletDeferredAt) || now < this.flatWalletDeferredAt)
            this.flatWalletDeferredAt = now;
        return now - this.flatWalletDeferredAt < FLAT_WALLET_AUDIT.maxDeferralMs;
    }
    flatWalletAudited(now) {
        this.lastFlatWalletAuditAt = now;
        this.flatWalletDeferredAt = null;
    }
    unreservedObservationFailure(error) {
        return this.continuousReadPolicy() && !this.store.state.position
            && (entryResponseFailure(error) || observationCodes.has(operationCode(error)));
    }
    async entryRead(stage, task) {
        try { return await task(); }
        catch (error) {
            const diagnostic = safeError(error);
            // Only these read calls can supply the missing SDK error stage.
            if (this.continuousReadPolicy() && !diagnostic.stage && diagnostic.category === 'validation'
                && entryResponseCodes.get(stage)?.has(diagnostic.code))
                throw new OperationalError(diagnostic.code, diagnostic.category, { ...diagnostic, stage });
            throw error;
        }
    }
    async entryBooks(market, options) {
        const books = await this.entryRead('book_read', () => this.client.books(market, options));
        if (this.continuousReadPolicy()) {
            const now = Date.now();
            if (!Array.isArray(books) || books.length !== 2 || books.some(book => !book
                || !Number.isFinite(book.timestamp) || !Number.isFinite(book.fetchedAt)
                || book.timestamp > now || book.fetchedAt > now
                || now - book.timestamp > this.config.ai.dataAgeMs || now - book.fetchedAt > this.config.ai.dataAgeMs
                || ['bids', 'asks'].some(side => !Array.isArray(book[side]) || book[side].some(level =>
                    !Number.isFinite(level.price) || level.price <= 0 || level.price >= 1
                    || !Number.isFinite(level.size) || level.size <= 0))))
                throw new OperationalError('invalid_entry_books', 'validation', { stage: 'book_read' });
        }
        return books;
    }
    async entryMetadata(market) {
        return this.entryRead('metadata_read', async () => {
            const info = await this.client.marketInfo(market);
            this.client.validateInfo(market, info);
            return info;
        });
    }
    clockAllowsEntry(now = Date.now()) {
        return this.clockGate?.fresh(now) === true;
    }
    assertEntryClock() {
        if (this.closed) throw new OperationalError('live_engine_closed', 'opportunity');
        if (!this.clockAllowsEntry()) throw new OperationalError('live_clock_unverified', 'opportunity', { stage: 'server_time' });
        if (entryHeld(this.store.state)) throw new OperationalError('live_entry_held', 'opportunity');
    }
    async checkClock(now, { proactive = false } = {}) {
        this.clockGate ||= new LiveClockGate(this.settings, this.store, this.client);
        const ready = await this.clockGate.check({ proactive });
        if (ready) this.lastClockCheck = this.clockGate.verifiedAt;
        else if (!this.clockCancelledThisTick) {
            this.clockCancelledThisTick = true;
            await this.broker.cancelOwned();
        }
        return ready;
    }
    bookEvent(type, detail = {}) {
        this.store.event(type, detail);
        // Completed markets in seen are not current exposure. Keep their
        // reservations, but do not permanently stop on a later feed gap.
        const invalidated = type === 'book_gap' || type === 'book_identity_changed'
            || type === 'book_tick_changed' && detail.continuityPreserved !== true;
        const position = this.store.state.position;
        if (!invalidated || !position) return;
        const now = Date.now(), end = position.market?.end;
        // A closed market is reconciled through receipts and the official
        // payout. The collector may already be warming the following market;
        // its quote continuity cannot invalidate the old settlement position.
        if (Number.isSafeInteger(now) && Number.isSafeInteger(end) && end > 0 && now >= end) {
            this.store.event('closed_market_book_invalidation', { eventType: type,
                activeMarket: position.market.slug, marketEnd: end, observedAt: now,
                watchedMarket: this.current?.slug ?? null });
            return;
        }
        // A transport gap invalidates collector history immediately. Receipt
        // and order reconciliation retain authority over any pending write.
        if (Number.isSafeInteger(now) && Number.isSafeInteger(end) && now < end && type === 'book_gap'
            && settlementTransportGap(detail)) {
            holdEntry(this.store, 'book_stream', new OperationalError('live_book_transport_gap', 'transport'),
                { now, retryable: true });
            this.store.event('settled_hold_book_recovery_wait', { activeMarket: position.market.slug,
                reason: detail.reason, closeCode: detail.closeCode ?? null, generation: detail.generation ?? null });
            return;
        }
        this.store.stop('live_book_feed_gap');
    }
    async watch(now) {
        const slug = marketSlug('late-entry', this.settings, now);
        if (this.current?.slug !== slug) {
            if (now - this.watchAttempt < 2000) return;
            this.watchAttempt = now;
            const market = await this.client.market(slug);
            if (market.slug !== slug || market.end - market.open !== 300000
                || market.open !== Math.floor(now / 300000) * 300000) throw new Error('market_identity_mismatch');
            this.current = market; this.books.watch(market.tokens, market);
            this.store.event('laya_market_watched', { slug });
        } else if (!this.books.socket || this.books.socket.readyState === 3) this.books.watch(this.current.tokens, this.current);
        const opening = this.client.btc.openings.get(this.current.open);
        if (opening && opening.receivedAt >= this.current.open && opening.receivedAt <= this.current.open + 5000)
            this.current.reference = { source: 'chainlink_twap_60s', open: this.current.open, end: this.current.end,
                value: opening.value, observedAt: opening.at, receivedAt: opening.receivedAt };
    }
    recordWatchFailure(error) {
        const now = Date.now(), target = marketSlug('late-entry', this.settings, this.watchAttempt);
        const retryable = temporaryReadFailure(error)
            || !this.store.state.position && !this.store.state.seen?.[target]
                && this.settings.late.duration === 300 && this.current?.slug !== target
                && (openingMarketReadUnavailable(error, this.watchAttempt, now)
                    || this.continuousReadPolicy() && marketDiscoveryUnavailable(error))
            || this.continuousReadPolicy() && !this.store.state.position && watchResponseFailure(error);
        let diagnostic = error;
        if (retryable && this.continuousReadPolicy()) {
            const detail = safeError(error);
            if (operationCode(error) === 'market_identity_mismatch')
                diagnostic = new OperationalError('market_identity_mismatch', 'validation', { stage: 'market_discovery' });
            else if (!detail.stage) diagnostic = new OperationalError(detail.code, detail.category,
                { ...detail, stage: 'market_discovery' });
        }
        holdEntry(this.store, 'market_watch', diagnostic, { now, retryable });
        if (!retryable) this.store.stop('market_watch_failed');
        this.store.event('laya_watch_failed', { reason: operationCode(error) });
    }
    async recoverContinuousReads() {
        const admitted = () => !this.closed && continuousRecoveryReadCandidate(this.config, this.store.state, Date.now());
        if (!admitted()) return false;
        const ready = await this.clockGate.check();
        if (!ready || !admitted() || !readRetryReady(this.store.state, 'market_watch', Date.now())) return false;
        try {
            await this.watch(Date.now());
            if (!admitted()) return false;
            clearEntryHold(this.store, 'market_watch', { now: Date.now(), proof: 'fresh_market_watch' });
        } catch (error) {
            if (admitted()) this.recordWatchFailure(error);
            return false;
        }
        await this.recoverEntryReads(Date.now(), { admitted });
        return admitted();
    }
    async recoverEntryReads(now = Date.now(), { admitted = () => true } = {}) {
        const state = this.store.state, market = this.current;
        if (!admitted()) return;
        const keys = ['entry_read', 'book_stream'].filter(key => state.entryHolds?.[key]?.retryable === true
            && readRetryReady(state, key, now));
        if (!keys.length || !market || market.slug !== marketSlug('late-entry', this.settings, now)) return;
        // The collector must earn the full 180-second history again after a
        // gap. A clock or provider recovery cannot clear this independent hold.
        if (keys.includes('book_stream') && !this.books.snapshot?.(now)) return;
        try {
            await this.entryMetadata(market);
            if (!admitted()) return;
            if (keys.includes('entry_read')) await this.entryBooks(market);
            if (!admitted()) return;
            if (keys.includes('book_stream')) {
                const validation = { at: Date.now(), generation: this.books.generation, identity: metadataIdentity(market) };
                await verifyStreamSnapshot(this.client, this.books, market, validation, Date.now, this.config.ai.dataAgeMs);
            }
            if (!admitted()) return;
            for (const key of keys) clearEntryHold(this.store, key,
                { now: Date.now(), proof: key === 'book_stream' ? 'fresh_metadata_and_warm_stream' : 'fresh_metadata_and_rest_books' });
        } catch (error) {
            if (!admitted()) return;
            if (bookResync(operationCode(error))) return;
            const retryable = temporaryEntryReadFailure(error) || this.unreservedObservationFailure(error);
            for (const key of keys) holdEntry(this.store, key, error,
                { now: Date.now(), retryable });
            if (!retryable) this.store.stop('operational_check_failed');
        }
    }
    maybeArchiveAiHistory(now = Date.now()) {
        const state = this.store.state;
        if (this.closed || state.mode !== 'pilot' || state.decisionProvider !== 'eligible'
            || state.position != null || state.stopped != null || state.liveRiskStop != null
            || state.frozenAt != null || entryHeld(state) || profitWithdrawalPending(state)
            || !Number.isSafeInteger(now) || now <= 0
            || this.lastAiArchiveAt && now - this.lastAiArchiveAt < 3_600_000) return null;
        if (this.prioritizeFlatEntry(now)) return null;
        const slot = this.nextFlatEntrySlot(now);
        if (slot !== null && now >= slot - FLAT_WALLET_AUDIT.slotLeadMs
            && now <= slot + this.config.ai.slotToleranceMs) return null;
        this.lastAiArchiveAt = now;
        try { return compactLiveAiHistory(this.store, { now }); }
        catch { return null; }
    }
    async tick(now = Date.now()) {
        this.client.startBtcFeed();
        this.clockCancelledThisTick = false;
        await this.checkClock(now, { proactive: true });
        const watchAt = Date.now();
        if (this.clockAllowsEntry(watchAt)
            && (!this.store.state.stopped || continuousRecoveryReadCandidate(this.config, this.store.state, watchAt))
            && !this.store.state.liveRiskStop
            && watchAt < liveDeadline(this.store.state, this.settings) && readRetryReady(this.store.state, 'market_watch', watchAt)) {
            try {
                await this.watch(watchAt);
                clearEntryHold(this.store, 'market_watch', { now: Date.now(), proof: 'fresh_market_watch' });
            } catch (error) {
                this.recordWatchFailure(error);
            }
            await this.recoverEntryReads(Date.now());
        }
        await super.tick(Date.now());
        if (this.clockAllowsEntry() && this.allowSettlementRecovery && !this.closed && this.store.state.stopped && !this.store.state.position) {
            try {
                await recoverSettlementStop(this.store, this.config, this.client, this.providers,
                    { explicitLive: true });
            } catch (error) {
                this.store.event('settlement_stop_recovery_deferred', { reason: operationCode(error) });
            }
        }
        this.maybeArchiveAiHistory(Date.now());
        if (this.books.status && now - (this.lastBookStatus || 0) >= 30000) {
            this.lastBookStatus = now;
            this.store.event('laya_book_status', { slug: this.current?.slug ?? null, ...this.books.status(Date.now()) });
        }
    }
    async discover(tickAt = Date.now()) {
        // Clock/watch/wallet reads can cross a slot boundary while the parent
        // tick is awaiting them. Scheduling must use the current wall clock.
        let now = Date.now();
        const state = this.store.state, market = this.current;
        if (!this.clockAllowsEntry(now) || this.closed || state.stopped || entryHeld(state) || profitWithdrawalPending(state) || !market || market.slug !== marketSlug('late-entry', this.settings, now) || state.seen[market.slug]) return;
        for (const seconds of this.config.ai.slots) {
            now = Date.now();
            if (!this.clockAllowsEntry(now) || entryHeld(state) || market.slug !== marketSlug('late-entry', this.settings, now)) return;
            const at = market.end - seconds * 1000, key = `${market.slug}:${seconds}`;
            if (now < at || this.ai.slots[key]) continue;
            const timing = { scheduledAt: at, checkedAt: now, tickAt,
                tickDelayMs: Math.max(0, now - tickAt), slotLatenessMs: now - at };
            this.ai.slots[key] = { at: now, status: 'reserved', timing };
            if (typeof this.store.saveDeferred === 'function') this.store.saveDeferred();
            else this.store.save();
            if (now - at > this.config.ai.slotToleranceMs) {
                this.ai.slots[key].status = 'slot_late';
                this.store.event('laya_slot_skipped', { key, reason: 'slot_late', timing }); continue;
            }
            try { await this.observe(market, seconds, key); }
            catch (error) {
                this.ai.slots[key].status = 'invalid';
                const preparationTiming = this.ai.slots[key].preparationTiming;
                if (preparationTiming && preparationTiming.readyAt === undefined) {
                    preparationTiming.failedAt = Date.now();
                    preparationTiming.elapsedMs = preparationTiming.failedAt - preparationTiming.startedAt;
                }
                this.store.event('laya_snapshot_skipped', { key, reason: operationCode(error),
                    timing: this.ai.slots[key].timing, preparationTiming });
                const snapshot = this.ai.snapshots?.find(s => s.snapshotId === this.ai.slots[key].snapshotId);
                if (snapshot) {
                    snapshot.entryDisposition = operationCode(error);
                    this.store.event('laya_entry_disposition', { key, snapshotId: snapshot.snapshotId,
                        reason: snapshot.entryDisposition, stage: snapshot.executionStage });
                }
                if (!state.position && decisionExpired(operationCode(error))) {
                    this.ai.slots[key].status = 'expired';
                    this.store.event('laya_decision_expired', { key, reason: operationCode(error),
                        snapshotId: snapshot?.snapshotId, inputAgeMs: snapshot ? Date.now() - snapshot.observedAt : null,
                        responseMs: snapshot ? snapshot.decisionReceivedAt - (snapshot.decisionRequestedAt ?? snapshot.at) : null });
                } else if (!state.position && feedWarming(operationCode(error)) && error.category === 'opportunity') {
                    this.ai.slots[key].status = 'warming';
                    this.store.event('laya_feed_recovery_wait', { key, reason: operationCode(error) });
                } else if (!state.position && feedDisparity(error)) {
                    this.ai.slots[key].status = 'feed_disparity';
                    this.store.event('laya_feed_disparity_wait', { key, reason: operationCode(error),
                        category: error.category, stage: error.stage, ...feedDisparityEvidence(error) });
                } else if (!state.position && bookResync(operationCode(error))) {
                    this.store.event('laya_book_recovery_wait', { key, reason: operationCode(error),
                        generation: this.books?.generation ?? null });
                } else if (this.unreservedObservationFailure(error)) {
                    if (entryResponseFailure(error)) holdEntry(this.store, 'entry_read', error,
                        { now: Date.now(), retryable: true });
                    this.store.event('live_entry_data_rejected', { key, reason: operationCode(error) });
                } else if (temporaryEntryReadFailure(error)) {
                    holdEntry(this.store, 'entry_read', error, { now: Date.now(), retryable: true });
                } else if (error.category && error.category !== 'opportunity' || invalidData(operationCode(error))) {
                    this.store.stop('operational_check_failed');
                }
            }
            if (state.position || state.stopped || entryHeld(state)) break;
        }
    }
    async observe(market, seconds, key) {
        this.assertEntryClock();
        const state = this.store.state, generation = this.books.generation;
        const slotEnd = market.end - seconds * 1000 + this.config.ai.slotToleranceMs;
        const preparationTiming = { startedAt: Date.now(), deadlineAt: slotEnd };
        if (this.ai?.slots?.[key]) this.ai.slots[key].preparationTiming = preparationTiming;
        if (this.closed || state.stopped || preparationTiming.startedAt > slotEnd) throw new Error('slot_late_after_validation');
        // Eligible decisions are local. Read a fresh wallet while collecting
        // market data, then drain it before the next tick can move the RPC anchor.
        const walletRead = decisionProvider(this.config) === 'eligible' ? this.startEntryWallet(market) : null;
        try {
            return await this.observeEntry(market, seconds, key, { generation, slotEnd, preparationTiming, walletRead });
        } finally {
            if (walletRead) {
                const result = await walletRead.result;
                // A discarded market observation must not hide a wallet or chain identity fault.
                if (result.status === 'rejected' && !temporaryReadFailure(result.reason)
                    && result.reason?.category !== 'opportunity' && !decisionExpired(operationCode(result.reason)))
                    throw result.reason;
            }
        }
    }
    startEntryWallet(market) {
        const startedAt = performance.now(), read = {};
        read.result = Promise.resolve().then(() => this.broker.entryWallet(market)).then(
            value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }),
        ).then(result => {
            read.elapsedMs = Math.max(0, performance.now() - startedAt);
            return result;
        });
        return read;
    }
    async observeEntry(market, seconds, key, { generation, slotEnd, preparationTiming, walletRead }) {
        const state = this.store.state;
        const timed = async (name, task) => {
            const startedAt = performance.now();
            try { return await task(); }
            finally { preparationTiming[`${name}Ms`] = Math.max(0, performance.now() - startedAt); }
        };
        const preparationResults = await Promise.allSettled([
            timed('rest', () => this.entryBooks(market, { deadline: slotEnd })),
            timed('metadata', () => this.entryMetadata(market)),
        ]);
        for (const result of preparationResults) if (result.status === 'rejected') throw result.reason;
        const rest = preparationResults[0].value;
        this.assertEntryClock();
        // Fee and token identity are checked again at the decision snapshot,
        // rather than relying on the metadata read at market opening.
        if (Date.now() > slotEnd) throw new Error('slot_late_after_validation');
        const validation = { at: Date.now(), generation, identity: metadataIdentity(market) };
        const collector = { config: { ...this.config.ai, deadline: liveDeadline(state, this.config.settings) },
            client: this.client, books: this.books, clock: Date.now, closed: this.closed, clockValid: true,
            sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
        let prepared;
        try {
            await timed('streamValidation', () => verifyStreamSnapshot(this.client, this.books, market, validation, Date.now, this.config.ai.dataAgeMs));
            this.assertEntryClock();
            prepared = await timed('features', () => ShadowEngine.prototype.freshSnapshot.call(collector, market, seconds, rest, validation));
        } catch (error) {
            // A gap can arrive while awaiting tick verification or fresher
            // source values. Consume the slot and require full warmup again.
            if (['execution_metadata_changed_or_expired', 'execution_tick_mismatch'].includes(operationCode(error))
                && this.books.generation !== generation && metadataIdentity(market) === validation.identity
                && Date.now() >= validation.at && Date.now() - validation.at <= this.config.ai.dataAgeMs)
                throw new Error(this.books.snapshot() ? 'execution_book_generation_changed' : 'execution_book_unavailable');
            throw error;
        }
        this.assertEntryClock();
        const now = Date.now();
        preparationTiming.readyAt = now;
        preparationTiming.elapsedMs = now - preparationTiming.startedAt;
        if (this.closed || state.stopped || now > slotEnd) throw new Error('slot_late_after_validation');
        if (profitWithdrawalPending(state)) throw new Error('profit_withdrawal_pending');
        const spendable = distributionAdjustedCash(state);
        const checks = candidateChecks(market, prepared.initial, this.config.ai, spendable, now);
        const allowed = checks.flatMap(c => c.order ? [c.order] : []);
        if (!allowed.length) {
            this.ai.slots[key].status = 'no_valid_side';
            this.store.event('laya_opportunity_skipped', { key, cash: spendable,
                reasons: checks.map(c => c.reason === 'insufficient_virtual_cash' ? 'insufficient_cash' : c.reason) });
            return;
        }
        for (const order of allowed) this.assertSignal(market, order, now);
        prepared.features.state.allowed = allowed.map(o => o.index === 0 ? 'BUY_UP' : 'BUY_DOWN');
        prepared.features.state.limit_cost_up_down = [0, 1].map(index => {
            const order = allowed.find(o => o.index === index); return order ? [round(order.price * 100), order.cost] : null;
        });
        const provider = decisionProvider(this.config);
        const entryFilter = provider === 'eligible' ? eligibleEntryPolicy(this.config) : null;
        const input = provider === 'eligible' ? JSON.stringify(prepared.features.state) : encodeFeatures(prepared.features.state);
        const snapshotId = crypto.createHash('sha256').update(JSON.stringify({ slug: market.slug, seconds, now, input })).digest('hex').slice(0, 24);
        const snapshot = { snapshotId, market: market.slug, slot: seconds, at: now,
            ...(provider === 'eligible' ? { provider, model: 'deterministic-eligible-v1', inferenceAttempted: false } : {}),
            ...(entryFilter ? { entryFilter } : {}),
            ...(state.currentStrategyEpochId ? { strategyEpochId: state.currentStrategyEpochId } : {}),
            ...(this.config.ai.decisionProtocol ? { decisionProtocol: { ...this.config.ai.decisionProtocol },
                evaluationEpochId: this.ai.currentEvaluationEpochId } : {}),
            observedAt: prepared.features.observedAt, input, validation, allowed,
            timing: { ...prepared.timing, preparation: preparationTiming }, inputHash: crypto.createHash('sha256').update(input).digest('hex') };
        if (provider === 'eligible') {
            prepareEligibleEntryBuffer(snapshot, market, this.client.btc, this.config);
            prepareEligibleBinanceLead(snapshot, this.binanceLead ?? this.providers?.binanceLead ?? null, this.config, now);
        }
        this.ai.snapshots.push(snapshot); this.ai.slots[key].status = 'observed';
        this.ai.slots[key].snapshotId = snapshotId;
        const persistenceStartedAt = performance.now();
        this.store.event('laya_snapshot', { snapshotId, slug: market.slug, inputHash: snapshot.inputHash, timing: snapshot.timing,
            decisionProtocol: snapshot.decisionProtocol, evaluationEpochId: snapshot.evaluationEpochId,
            ...(snapshot.entryFilter ? { entryFilter: snapshot.entryFilter } : {}),
            ...(snapshot.strategyEpochId ? { strategyEpochId: snapshot.strategyEpochId } : {}) });
        snapshot.snapshotPersistMs = Math.max(0, performance.now() - persistenceStartedAt);
        snapshot.executionStage = provider === 'eligible' ? 'decision_and_wallet' : 'inference_and_wallet';
        this.assertEntryClock();
        const requestedAt = Date.now();
        const admissionReason = provider === 'eligible' ? eligibleAdmissionReason(snapshot, this.config, requestedAt) : null;
        const prediction = admissionReason ? Promise.resolve({ provider, model: 'deterministic-eligible-v1',
            snapshotId, status: admissionReason, action: 'SKIP', executable: false, inferenceAttempted: false,
            requestedAt, receivedAt: requestedAt, latencyMs: 0, cost: 0 }) : this.providers.predict(provider, snapshot);
        const decisionTask = prediction.then(decision => {
            snapshot.decision = decision;
            snapshot.decisionReceivedAt = decision.receivedAt ?? Date.now();
            if (decision.requestedAt !== undefined) snapshot.decisionRequestedAt = decision.requestedAt;
            return decision;
        });
        const metadataStartedAt = Date.now();
        const metadataTask = this.client.warmOrderMetadata(allowed[0]).finally(() => {
            snapshot.metadataWarmupMs = Date.now() - metadataStartedAt;
        });
        // Both RPC values use ONE confirmed block. Metadata warmup stops at
        // the SDK's unsigned step; neither task reserves or submits an order.
        const walletWaitStartedAt = performance.now();
        walletRead ||= this.startEntryWallet(market);
        const walletTask = walletRead.result.then(result => {
            snapshot.walletReadMs = walletRead.elapsedMs;
            snapshot.walletWaitMs = Math.max(0, performance.now() - walletWaitStartedAt);
            if (result.status === 'rejected') throw result.reason;
            return result.value;
        });
        const [decisionResult, walletResult, metadataResult] = await Promise.allSettled([
            decisionTask, walletTask, metadataTask,
        ]);
        this.assertEntryClock();
        if (decisionResult.status === 'rejected') throw decisionResult.reason;
        const decision = decisionResult.value;
        snapshot.executionStage = 'decision_validation';
        this.store.event('laya_decision', { ...decision, evaluationEpochId: snapshot.evaluationEpochId,
            ...(snapshot.strategyEpochId ? { strategyEpochId: snapshot.strategyEpochId } : {}), preparationTiming: {
            snapshotPersistMs: snapshot.snapshotPersistMs, walletReadMs: snapshot.walletReadMs,
            walletWaitMs: snapshot.walletWaitMs, metadataWarmupMs: snapshot.metadataWarmupMs,
        } });
        const disposition = reason => {
            snapshot.entryDisposition = reason;
            this.store.event('laya_entry_disposition', { key, snapshotId, reason, stage: snapshot.executionStage });
        };
        if (this.closed || state.stopped) { disposition(state.stopped?.reason || 'engine_closed'); return; }
        if (decision.status !== 'ok' || decision.action === 'SKIP') {
            disposition(decision.status === 'ok' ? provider === 'eligible'
                ? decision.entryFilter?.reason || 'eligible_skip' : 'ai_skip' : decision.status); return;
        }
        if (walletResult.status === 'rejected') throw walletResult.reason;
        if (metadataResult.status === 'rejected') throw metadataResult.reason;
        snapshot.wallet = walletResult.value;
        const selected = allowed.find(o => o.index === (decision.action === 'BUY_UP' ? 0 : 1));
        if (!selected) { disposition(provider === 'eligible' ? 'eligible_side_not_allowed' : 'ai_side_not_allowed'); return; }
        const spec = { ...selected, kind: 'taker' };
        this.entryContext = { market, snapshot, decision, wallet: walletResult.value };
        if (provider === 'eligible') {
            const sourceAt = Math.min(snapshot.observedAt, validation.at, validation.tickVerifiedAt ?? Infinity);
            if (Date.now() - sourceAt + 250 + (this.config.ai.inferenceReserveMs ?? 150) > this.config.ai.dataAgeMs) {
                disposition('insufficient_execution_headroom'); return;
            }
            snapshot.executionStage = 'execution_latency';
            await this.awaitExecutionLatency(snapshot);
        }
        await this.validate(spec);
        if (this.beforeReservation && await this.beforeReservation({ market, snapshot, decision, spec }) === false) {
            disposition('diagnostic_veto');
            this.store.event('diagnostic_entry_validated', { slug: market.slug, snapshotId, action: decision.action });
            return;
        }
        this.assertEntryClock();
        let lossProtection;
        if (this.config.profitTaking?.enabled && this.config.profitTaking.lossProtection) {
            const marker = state.profitTakingControl?.lossProtection;
            const activationId = lossProtectionActivationId(marker), witness = this.entryContext.wallet;
            const before = captureLossWalletEvidence(state, { ...witness, blockNumber: witness.block });
            if (!activationId || !before || before.checkedAt < marker.activatedAt)
                throw new OperationalError('loss_wallet_evidence_unavailable', 'opportunity', { stage: 'wallet_read' });
            lossProtection = { schema: 1, activationId, before };
        }
        snapshot.executionStage = 'entry_reservation';
        snapshot.entryDisposition = 'entry_reserved';
        state.seen[market.slug] = { at: Date.now(), cost: selected.cost, snapshotId };
        state.position = newPosition(market, { orders: [spec], cost: selected.cost }, state, Date.now());
        state.position.entrySignal = { provider, model: decision.model, snapshotId, action: decision.action,
            ...(lossProtection ? { lossProtection } : {}),
            ...(decision.entryFilter ? { entryFilter: decision.entryFilter } : {}),
            ...(snapshot.strategyEpochId ? { strategyEpochId: snapshot.strategyEpochId } : {}),
            ...(snapshot.decisionProtocol ? { decisionProtocol: snapshot.decisionProtocol,
                evaluationEpochId: snapshot.evaluationEpochId } : {}),
            inputHash: snapshot.inputHash, latencyMs: decision.latencyMs, confidence: decision.confidence ?? null };
        this.store.event('entry_reserved', { slug: market.slug, snapshotId, cost: selected.cost, orders: [spec], provider });
        const order = await this.broker.submit(spec, Date.now());
        snapshot.executionStage = 'submission_complete';
        disposition(`order_${order.status}`);
    }
    async awaitExecutionLatency(snapshot) {
        // Match the paper comparator's minimum execution latency while wallet
        // reads overlap it. validate() then checks the current book and clock.
        const delayMs = snapshot.decisionReceivedAt + 250 - Date.now();
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    assertSignal(market, order, now) {
        const btc = this.client.btc;
        // A feed can become stale between snapshot preparation and this check.
        // Before reservation that consumes one slot. Causal/source faults must
        // never hide behind the same stale-or-warming assessment result.
        for (const point of [...(Array.isArray(btc.spot) ? btc.spot : []), ...(btc.twap ? [btc.twap] : [])]) {
            if (!Number.isFinite(point?.at) || !Number.isFinite(point.receivedAt)
                || point.at > now || point.receivedAt > now || point.at > point.receivedAt
                || !Number.isFinite(point.value) || point.value <= 0)
                throw new OperationalError('invalid_btc_signal_time', 'validation', { stage: 'btc_feed' });
        }
        if (market.reference?.source !== undefined && market.reference.source !== 'chainlink_twap_60s')
            throw new OperationalError('btc_reference_unverified', 'validation', { stage: 'btc_feed' });
        for (const field of ['observedAt', 'receivedAt']) if (market.reference?.[field] !== undefined
            && (!Number.isFinite(market.reference[field]) || market.reference[field] > now))
            throw new OperationalError('invalid_btc_signal_time', 'validation', { stage: 'btc_feed' });
        const signal = btc.assess(market, order, this.settings, now);
        if (signal.reason && !['btc_edge_insufficient', 'btc_direction_disagrees'].includes(signal.reason)) {
            // A numeric feed disagreement rejects this unreserved slot. The
            // next slot must independently pass the same source checks.
            if (!this.store.state.position && signal.reason === 'btc_twap_source_mismatch')
                throw new OperationalError(signal.reason, 'opportunity', { stage: 'btc_feed',
                    ...feedDisparityEvidence({ feedDifferenceUsd: signal.feedDifference,
                        maxFeedDifferenceUsd: btc.rule?.maxFeedDifferenceUsd, spotAt: signal.spotAt, twapAt: signal.twapAt }) });
            if (!this.store.state.position && feedWarming(signal.reason))
                throw new OperationalError(signal.reason, 'opportunity', { stage: 'btc_feed' });
            throw new Error(signal.reason);
        }
    }
    async validate(spec) {
        try {
            this.assertEntryClock();
            if (this.closed || !this.entryContext) throw new Error('live_entry_context_missing');
            const { market, snapshot, decision } = this.entryContext;
            if (decisionProvider(this.config) === 'eligible') {
                assertEligibleEntryPolicy({ snapshot, config: this.config, now: Date.now(), market, spec, decision });
                assertEligibleBinanceLeadLive(this.binanceLead ?? this.providers?.binanceLead ?? null, this.config, spec, Date.now(), snapshot);
            }
            // Age can expire during healthy inference or wallet reads. Check
            // before stream validation so an old decision is consumed rather
            // than confused with an identity/generation change in metadata.
            assertDecisionTiming(snapshot, this.config, Date.now());
            let books;
            if (!this.books.snapshot()) throw new Error('execution_book_unavailable');
            try { books = validatedStreamBooks(this.books, market, snapshot.validation, Date.now(), this.config.ai.dataAgeMs); }
            catch (error) {
                if (operationCode(error) !== 'execution_tick_mismatch') throw error;
                books = await verifyStreamSnapshot(this.client, this.books, market, snapshot.validation, Date.now, this.config.ai.dataAgeMs);
            }
            this.assertEntryClock();
            const execution = entryGuard({ state: this.store.state, config: this.config, market, snapshot, decision, spec, books, now: Date.now() });
            snapshot.executionEvidence = execution;
            this.broker.assertEntryWallet(this.entryContext.wallet, market);
            if ((this.entryContext.wallet.spendable ?? this.entryContext.wallet.balance) + EPS < spec.cost)
                throw new OperationalError('entry_wallet_insufficient', 'opportunity', { stage: 'wallet_read' });
            this.assertSignal(market, spec, Date.now());
            if (decisionProvider(this.config) === 'eligible')
                assertEligibleBinanceLeadLive(this.binanceLead ?? this.providers?.binanceLead ?? null, this.config, spec, Date.now(), snapshot);
            // Recheck after any awaited tick verification. Never refresh source timestamps.
            validatedStreamBooks(this.books, market, snapshot.validation, Date.now(), this.config.ai.dataAgeMs);
            this.assertEntryClock();
            return execution;
        } catch (error) {
            if (error.entryFilter && this.entryContext) {
                this.entryContext.snapshot.executionEntryFilter = error.entryFilter;
                this.store.event('eligible_entry_filter_veto', { snapshotId: this.entryContext.snapshot.snapshotId,
                    strategyEpochId: this.entryContext.snapshot.strategyEpochId, ...error.entryFilter });
            }
            if (error.execution && this.entryContext) {
                this.entryContext.snapshot.executionEvidence = error.execution;
                const constraintsChanged = operationCode(error) === 'execution_constraints_changed';
                if (constraintsChanged) this.entryContext.snapshot.executionConstraintReason = error.constraintReason;
                this.store.event(constraintsChanged ? 'laya_execution_constraints_changed' : 'laya_execution_unmarketable', {
                    ...error.execution, ...(constraintsChanged ? { constraintReason: error.constraintReason } : {}),
                });
            }
            if (operationCode(error) === 'execution_metadata_changed_or_expired' && !this.store.state.position
                && this.entryContext?.snapshot.validation.generation !== this.books.generation
                && metadataIdentity(this.entryContext.market) === this.entryContext.snapshot.validation.identity
                && Date.now() >= this.entryContext.snapshot.validation.at
                && Date.now() - this.entryContext.snapshot.validation.at <= this.config.ai.dataAgeMs)
                throw new Error(this.books.snapshot() ? 'execution_book_generation_changed' : 'execution_book_unavailable');
            if (this.unreservedObservationFailure(error)) {
                if (entryResponseFailure(error)) holdEntry(this.store, 'entry_read', error, { now: Date.now(), retryable: true });
            } else if (temporaryEntryReadFailure(error)) holdEntry(this.store, 'entry_read', error, { now: Date.now(), retryable: true });
            else if (!(!this.store.state.position && (bookResync(operationCode(error)) || decisionExpired(operationCode(error))
                || feedDisparity(error)))
                && (invalidData(operationCode(error)) || error.category && error.category !== 'opportunity'))
                this.store.stop('stale_or_invalid_execution_data');
            throw error;
        }
    }
    async shutdown() {
        this.closed = true;
        try { await super.shutdown(); }
        finally { this.books.close(); this.providers.close(); }
    }
}
