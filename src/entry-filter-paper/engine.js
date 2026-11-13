import { FilterPaperEngine } from '../laya-filter-paper/engine.js';
import { decisionBudget } from '../laya-filter-paper/decision-budget.js';
import { buildDecisionContext } from '../decision-paper/features.js';
import { evaluateEntryFilter } from '../decision-paper/entry-filter.js';
import { metadataIdentity, validatedStreamBooks, verifyStreamSnapshot } from '../ai-shadow/engine.js';
import { readEntryFilterRestBooks, validatedEntryFilterRestBooks } from './book-source.js';
import { calculateFullFillEntryCost } from '../eligible-live/entry-cost-cap.js';
import { LIVE_TUNING_PROFILE, LIVE_COST_CAP_PROFILE, isLiveTuningProfile } from './config.js';

const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};
const noProvider = Object.freeze({ close() {} });

export class EntryFilterPaperEngine extends FilterPaperEngine {
    constructor(config, store, client, books, providers = noProvider, options = {}) {
        super(config, store, client, books, providers, { ...options, beforeInference: async () => true });
        this.readRestBooks = options.readRestBooks || readEntryFilterRestBooks;
        this.validateRestBooks = options.validateRestBooks || validatedEntryFilterRestBooks;
        this.observationPairs = new WeakMap(); this.snapshotEvents = new Map();
    }
    recoveryEnabled() {
        return this.config.observationPolicy?.restFallback === 'independent-current-book-and-tick-verification';
    }
    collectWithoutAvailableArms() { return this.config.passiveCollection?.enabled === true; }
    heartbeatDetail(now) {
        return { bookStream: this.books.status?.(now) || null,
            ...(this.recoveryEnabled() ? { bookRecovery: this.store.state.bookRecovery || null } : {}) };
    }
    async recoverBooks(market, deadlineAt, stage) {
        const recovery = this.store.state.bookRecovery ||= { restAttempts: 0, restSuccesses: 0, restFailures: 0 };
        recovery.restAttempts++; recovery.lastStage = stage;
        try {
            // Keep the tuning metadata check inside the recovery reader's original deadline.
            const client = isLiveTuningProfile(this.config.profile) ? {
                books: async (value, options) => {
                    const [books, info] = await Promise.all([
                        this.client.books(value, options), this.client.marketInfo(value)
                    ]);
                    this.client.validateInfo(value, info);
                    return books;
                }
            } : this.client;
            const pair = await this.readRestBooks(market, { client, clock: this.clock,
                deadlineAt, maxAgeMs: this.config.dataAgeMs });
            recovery.restSuccesses++; recovery.lastRestVerifiedAt = this.clock(); recovery.lastFailure = null;
            return pair;
        } catch (error) {
            recovery.restFailures++; recovery.lastFailure = /^[a-z_]+$/.test(error.message) ? error.message : 'book_recovery_failed';
            throw error;
        }
    }
    observationSourceReady(market, now) {
        if (this.config.observationPolicy?.version !== 'causal-closing-and-rest-recovery-v2'
            || now <= market.end - 60000) return true;
        return this.client.btc.spot.some(point => point.at > market.end - 60000
            && point.at <= now && point.receivedAt <= now);
    }
    observationStream(validation) {
        const pair = this.observationPairs.get(validation);
        if (!pair) return this.books;
        return { generation: 0, tokens: pair.market.tokens,
            snapshot: () => this.validateRestBooks(pair.market, pair, this.clock(), this.config.dataAgeMs) };
    }
    async observationBooks(market, seconds, slotEnd) {
        if (this.config.profile === LIVE_TUNING_PROFILE) {
            const generation = this.books.generation;
            const [rest, info] = await Promise.all([
                this.client.books(market, { deadline: slotEnd, retries: 0 }),
                this.client.marketInfo(market)
            ]);
            this.client.validateInfo(market, info);
            await this.checkObservationTime(slotEnd);
            const validation = { at: this.clock(), generation, identity: metadataIdentity(market) };
            await verifyStreamSnapshot(this.client, this.books, market, validation, this.clock, this.config.dataAgeMs);
            return { rest, validation };
        }
        if (!this.recoveryEnabled()) return super.observationBooks(market, seconds, slotEnd);
        const deadlineAt = slotEnd - this.config.snapshotSlotReserveMs;
        if (this.books.snapshot(this.clock())) {
            const generation = this.books.generation;
            const restRead = this.client.books(market, { deadline: deadlineAt, retries: 0 });
            let rest;
            if (isLiveTuningProfile(this.config.profile)) {
                const [books, info] = await Promise.all([restRead, this.client.marketInfo(market)]);
                this.client.validateInfo(market, info);
                rest = books;
            } else rest = await restRead;
            await this.checkObservationTime(slotEnd);
            const validation = { at: this.clock(), generation, identity: metadataIdentity(market) };
            try {
                await verifyStreamSnapshot(this.client, this.books, market, validation, this.clock, this.config.dataAgeMs);
                return { rest, validation };
            } catch (error) {
                if (!['execution_book_unavailable', 'execution_book_stale_or_future',
                    'execution_metadata_changed_or_expired'].includes(error.message)) throw error;
            }
        }
        const pair = await this.recoverBooks(market, deadlineAt, 'observation');
        await this.checkObservationTime(slotEnd);
        this.observationPairs.set(pair.validation, { ...pair, market });
        return { rest: pair.books, validation: pair.validation };
    }
    recordSnapshot(snapshot, detail) {
        if (!this.recoveryEnabled() && !isLiveTuningProfile(this.config.profile)) return super.recordSnapshot(snapshot, detail);
        // No external request exists here: snapshot, decision and reservation commit together.
        this.snapshotEvents.set(snapshot.snapshotId, { type: 'snapshot', detail });
    }
    async observe(market, seconds, key) {
        try { return await super.observe(market, seconds, key); }
        finally {
            for (const [id, event] of this.snapshotEvents)
                if (event.detail.slug === market.slug && event.detail.slot === seconds) this.snapshotEvents.delete(id);
        }
    }
    async executeCohort(key, names) {
        names = names.filter(name => this.store.state.arms[name]?.position?.status === 'pending');
        if (!names.length) return;
        const first = this.store.state.arms[names[0]].position;
        if (!this.recoveryEnabled() || this.clock() < first.activeAt) return super.executeCohort(key, names);
        const pending = new Map(names.map(name => [name, this.store.state.arms[name].position]));
        const snapshot = this.store.state.snapshots.find(row => row.snapshotId === first.snapshotId);
        const deadlineAt = Math.min(first.snapshotObservedAt + this.config.dataAgeMs,
            this.validationObservedAt(first.validation) + this.config.dataAgeMs,
            snapshot?.timing?.executionDeadlineAt ?? Infinity,
            first.market.end - 10000, this.config.deadline - 1);
        // Recovered WebSocket execution still needs the original generation and metadata.
        let streamReady = false, view;
        try {
            validatedStreamBooks(this.books, first.market, first.validation, this.clock(), this.config.dataAgeMs);
            streamReady = true;
        } catch (error) {
            if (!['execution_book_unavailable', 'execution_book_stale_or_future',
                'execution_metadata_changed_or_expired'].includes(error.message))
                view = { source: 'websocket', error };
        }
        if (streamReady || view) return super.executeCohort(key, names, view);
        try {
            if (this.closed || this.store.state.frozenAt
                || metadataIdentity(first.market) !== first.validation.identity) throw new Error('execution_metadata_changed_or_expired');
            const pair = await this.recoverBooks(first.market, deadlineAt, 'execution');
            if (this.clock() > deadlineAt) throw new Error('execution_stale');
            if (metadataIdentity(first.market) !== first.validation.identity)
                throw new Error('execution_metadata_changed_or_expired');
            this.validateRestBooks(first.market, pair, this.clock(), this.config.dataAgeMs);
            view = pair;
        } catch (error) {
            view = { source: 'rest', error };
        }
        // A deadline freeze or shutdown may have cancelled reservations during the read.
        names = names.filter(name => this.store.state.arms[name].position === pending.get(name)
            && pending.get(name).status === 'pending');
        if (!names.length) return;
        return super.executeCohort(key, names, view);
    }
    maxInputAgeMs() {
        return this.config.dataAgeMs - this.config.latencyMs - (this.config.inferenceReserveMs ?? 150);
    }
    prepareSnapshot(snapshot, market) {
        if (isLiveTuningProfile(this.config.profile)) return this.prepareTuningSnapshot(snapshot, market);
        const verdicts = structuredClone(snapshot.filterVerdicts);
        try { snapshot.informed = buildDecisionContext(snapshot, market, this.client.btc, this.config, snapshot.at); }
        catch (error) {
            snapshot.contextError = /^[a-z_]+$/.test(error.message) ? error.message : 'decision_context_invalid';
        }
        for (const [action, verdict] of Object.entries(verdicts)) {
            const index = action === 'BUY_UP' ? 0 : 1;
            const costs = snapshot.informed?.calculated?.costsUpDown?.[index];
            const validCap = Number.isFinite(this.config.costCapPerShare)
                && this.config.costCapPerShare > 0 && this.config.costCapPerShare < 1;
            const costPass = !snapshot.contextError && validCap && costs
                && costs.breakEvenProbability <= this.config.costCapPerShare;
            const cost = { version: 'full-fill-all-in-cost-cap-v1', pass: !!costPass,
                reason: snapshot.contextError || (!validCap ? 'entry_cost_policy_invalid'
                    : !costs ? 'entry_cost_context_unavailable' : costPass ? null : 'entry_cost_above_cap'),
                metrics: costs ? { ...costs, costCapPerShare: this.config.costCapPerShare,
                    interpretation: 'full_fill_break_even_not_predicted_win_probability',
                    partialFillCapGuaranteed: false } : null };
            let buffer = evaluateEntryFilter(snapshot, action, this.config.entryFilter);
            if (snapshot.contextError) buffer = { ...buffer, pass: false, reason: snapshot.contextError };
            else if (JSON.parse(snapshot.input).seconds < 60
                && snapshot.informed?.calculated?.closingTwap?.status !== 'observed')
                buffer = { ...buffer, pass: false, reason: 'entry_filter_closing_context_unavailable' };
            verdict.eligible = { pass: true, reason: null };
            verdict['cost-cap'] = cost;
            verdict.buffer = buffer;
            verdict.combined = { pass: cost.pass && buffer.pass, reason: cost.reason || buffer.reason,
                metrics: { cost: cost.metrics, buffer: buffer.metrics } };
        }
        snapshot.filterVerdicts = freeze(verdicts);
    }
    prepareTuningSnapshot(snapshot, market) {
        const verdicts = structuredClone(snapshot.filterVerdicts);
        for (const [action, verdict] of Object.entries(verdicts)) {
            const order = snapshot.allowed.find(row => row.index === (action === 'BUY_UP' ? 0 : 1));
            let metrics = null, reason = null;
            try {
                metrics = calculateFullFillEntryCost({ price: order?.price, shares: order?.shares,
                    schedule: market.fee, gasUsd: this.config.gasUsd });
            } catch { reason = 'entry_cost_context_unavailable'; }
            if (this.config.profile === LIVE_COST_CAP_PROFILE) {
                for (const name of this.armNames) {
                    const cap = this.config.armCostCaps?.[name];
                    const invalid = !Number.isFinite(cap) || cap <= 0 || cap >= 1;
                    const rejection = reason || (invalid ? 'entry_cost_policy_invalid'
                        : metrics.breakEvenProbability > cap ? 'entry_cost_above_cap' : null);
                    verdict[name] = { pass: !rejection, reason: rejection,
                        metrics: metrics ? { ...metrics, costCapPerShare: cap } : null };
                }
                continue;
            }
            if (!reason && metrics.breakEvenProbability > this.config.costCapPerShare) reason = 'entry_cost_above_cap';
            const cost = { pass: !reason, reason, metrics };
            verdict['cost-cap-control'] = cost;
            verdict['cost-cap-drop-2c'] = structuredClone(cost);
            verdict['cost-cap-90s'] = snapshot.slot === this.config.tuningPolicy.selectedSlotSeconds
                ? structuredClone(cost) : { pass: false, reason: 'entry_slot_not_selected', metrics };
        }
        snapshot.filterVerdicts = freeze(verdicts);
    }
    executionFilter(name, position, books) {
        if (!isLiveTuningProfile(this.config.profile) || name !== 'cost-cap-drop-2c') return null;
        const snapshotAsk = position.order.snapshotPrice;
        const executionAsk = Math.min(...books[position.order.index].asks.map(level => level.price));
        const limit = this.config.tuningPolicy.maxAskDropUsd;
        if (![snapshotAsk, executionAsk, limit].every(Number.isFinite) || limit < 0)
            throw new Error('execution_ask_drop_inputs_invalid');
        const drop = snapshotAsk - executionAsk, pass = drop <= limit + 1e-9;
        return { pass, reason: pass ? null : 'entry_ask_drop_above_limit',
            metrics: { snapshotAsk, executionAsk, askDropUsd: Math.round(drop * 1e9) / 1e9, maxAskDropUsd: limit } };
    }
    async dispatchDecisions(snapshot, market) {
        const at = this.clock(), inputAge = at - snapshot.observedAt;
        const validationAge = at - this.validationObservedAt(snapshot.validation);
        let reason = inputAge < 0 || inputAge > this.maxInputAgeMs() ? 'insufficient_input_headroom'
            : validationAge < 0 || validationAge > this.maxInputAgeMs() ? 'insufficient_validation_headroom' : null;
        try {
            const budget = decisionBudget(this.config, snapshot, at);
            snapshot.decisionDeadlineAt = budget.decisionDeadlineAt;
            Object.assign(snapshot.timing, budget);
            if (at > budget.decisionDeadlineAt) reason ||= 'insufficient_execution_headroom';
        } catch { reason ||= 'invalid_decision_budget'; }
        const index = snapshot.allowed.length === 1 ? snapshot.allowed[0].index : -1;
        const action = !reason && index >= 0 ? ['BUY_UP', 'BUY_DOWN'][index] : 'SKIP';
        const decision = { snapshotId: snapshot.snapshotId, status: reason || 'ok', action,
            executable: action !== 'SKIP', requestedAt: at, receivedAt: at, admittedAt: at,
            latencyMs: 0, cost: 0, model: 'deterministic', inferenceAttempted: false, requestSubmitted: false,
            policy: 'buy-single-eligible-side-without-ai' };
        snapshot.admittedAt = at;
        snapshot.inferenceAttempted = false;
        snapshot.sharedDecision = structuredClone(decision);
        Object.assign(snapshot.timing, { admittedAt: at, decisionReceivedAt: at,
            decisionInputAgeMs: inputAge, decisionValidationAgeMs: validationAge });
        const snapshotEvent = this.snapshotEvents.get(snapshot.snapshotId);
        this.snapshotEvents.delete(snapshot.snapshotId);
        const events = [...(snapshotEvent ? [snapshotEvent] : []),
            { type: 'decision', detail: { provider: 'deterministic', shared: true, ...decision } }];
        // Reserve every world before writing so storage latency cannot split execution cohorts.
        for (const name of this.armNames) {
            const row = snapshot.decisions[name] = { ...structuredClone(decision), policy: this.config.armPolicies?.[name] };
            this.apply(name, row, snapshot, market, snapshot.allowed, at, events);
            if (row.entryDisposition !== 'reserved') {
                if (row.action !== 'SKIP') row.originalAction = row.action;
                row.action = 'SKIP'; row.executable = false;
            }
        }
        this.eventBatch(events);
    }
}
