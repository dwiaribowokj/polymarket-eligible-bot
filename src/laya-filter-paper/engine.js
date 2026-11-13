import crypto from 'node:crypto';
import { ShadowEngine, candidateChecks, metadataIdentity, verifyStreamSnapshot,
    validatedStreamBooks, risk } from '../ai-shadow/engine.js';
import { makeFeatures, encodeFeatures } from '../ai-shadow/history.js';
import { marketSlug } from '../restart/strategy.js';
import { sweep, round, EPS } from '../restart/math.js';
import { ADAPTIVE_TIMEOUT_POLICY, decisionBudget } from './decision-budget.js';

export const FILTER_ARMS = Object.freeze(['laya', 'spot-twap', 'price-cap-085', 'combined', 'model-edge']);
const optionalModelReasons = new Set(['btc_edge_insufficient', 'btc_direction_disagrees']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const frozen = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
    return value;
};
const validPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(x => Number.isFinite(x) && x >= 0 && x <= 1) && Math.abs(payout[0] + payout[1] - 1) <= EPS;

export class FilterPaperEngine extends ShadowEngine {
    constructor(config, store, client, books, providers, options = {}) {
        super(config, store, client, books, providers, options);
        this.armNames = config.armNames || FILTER_ARMS;
        this.beforeInference = options.beforeInference || (async () => true);
        this.clockValid = false; this.clockVerifiedAt = null; this.clockRetryAt = 0;
        this.payoutPending = new Map(); this.observing = new Set();
    }
    clockFresh(now = this.clock()) {
        return this.clockValid && Number.isFinite(this.clockVerifiedAt) && now >= this.clockVerifiedAt
            && now - this.clockVerifiedAt < 30000;
    }
    async verifyClock() {
        if (this.clockTask) return this.clockTask;
        this.clockTask = (async () => {
            const before = this.clock(); this.lastClockCheck = before;
            try {
                const server = await this.client.serverTime(), now = this.clock();
                const sampledAt = this.client.clock?.at ?? now;
                if (!Number.isFinite(server) || now < before || now - before > this.config.dataAgeMs
                    || Math.abs(server - now) > (this.config.control.maxClockSkewMs ?? 1000)
                    || !Number.isFinite(sampledAt) || sampledAt > now || now - sampledAt >= 30000)
                    throw new Error('invalid_server_clock');
                this.clockVerifiedAt = sampledAt; this.clockValid = true;
                this.store.state.clock = { status: 'verified', verifiedAt: sampledAt };
                this.clockRetryAt = Math.min(now + 20000, sampledAt + 30000); this.store.save(); return true;
            } catch (error) {
                this.clockValid = false; this.clockVerifiedAt = null; this.clockRetryAt = this.clock() + 5000;
                this.store.state.clock = { status: 'waiting', failedAt: this.clock(), retryAt: this.clockRetryAt };
                this.store.error('clock', error); this.store.save(); return false;
            }
        })().finally(() => { this.clockTask = null; });
        return this.clockTask;
    }
    available(name, slug) {
        const arm = this.store.state.arms[name];
        return !!arm && !arm.stopped && !arm.position && !arm.seen[slug];
    }
    collectWithoutAvailableArms() { return false; }
    assessRisk(name, value, at, { basis = 'cash_balance', position, settlement = null } = {}, events = null) {
        const arm = this.store.state.arms[name], p = position === undefined ? arm.position : position;
        const stopped = arm.stopped, shadowStop = arm.shadowStop, previousDrawdown = arm.drawdown;
        risk(arm, this.config, value, at);
        const thresholdChanged = arm.stopped !== stopped || arm.shadowStop !== shadowStop;
        if (!thresholdChanged && arm.drawdown <= previousDrawdown) return;
        // Keep the valuation that caused each stop after the position is redeemed and removed.
        const evidence = {
            schema: 1, at, basis, equity: round(value), cash: arm.cash, peak: round(arm.peak),
            drawdown: round(arm.peak - value), maxDrawdown: round(arm.drawdown),
            pilotDrawdownLimit: this.config.shadowDrawdownStop, researchDrawdownLimit: this.config.drawdownStop,
            position: p ? { market: p.market.slug, conditionId: p.market.conditionId, snapshotId: p.snapshotId,
                status: p.status, side: p.order.index === 0 ? 'UP' : 'DOWN', marketEnd: p.market.end,
                submittedAt: p.submittedAt, executionAt: p.executionAt ?? null, settleAt: p.settleAt ?? null,
                holdings: p.holdings, entryCost: p.entryCost, fees: p.fees, requestedShares: p.order.shares,
                matchedShares: p.fill?.shares ?? null, matchedCost: p.fill ? round(-p.fill.cash) : null,
                snapshotPrice: p.order.snapshotPrice ?? null, limit: p.order.price,
                mark: p.mark ?? null, markFresh: p.markFresh === true, markSource: p.markSource ?? null,
                markObservedAt: p.markObservedAt ?? null, markReceivedAt: p.markReceivedAt ?? null,
                markAt: p.lastMarkAt ?? null, markBook: p.markBook ? structuredClone(p.markBook) : null } : null,
            settlement: settlement ? structuredClone(settlement) : null,
        };
        if (arm.drawdown > previousDrawdown) arm.maxDrawdownEvidence = structuredClone(evidence);
        if (arm.shadowStop !== shadowStop) arm.shadowStop.evidence = structuredClone(evidence);
        if (arm.stopped !== stopped) arm.stopped.evidence = structuredClone(evidence);
        if (thresholdChanged) {
            const detail = { arm: name, stopped: arm.stopped, shadowStop: arm.shadowStop, evidence };
            if (events) events.push({ type: 'risk_threshold', detail });
            else this.store.event('risk_threshold', detail);
        }
    }
    async market(now) {
        const slug = marketSlug('late-entry', this.config.control, now);
        if (this.current?.slug !== slug) {
            if (now - this.lastMarketCheck < 2000) return null;
            this.lastMarketCheck = now;
            const market = await this.client.market(slug);
            if (market.end - market.open !== 300000 || market.slug !== slug
                || market.open !== Math.floor(now / 300000) * 300000) throw new Error('market_identity_mismatch');
            this.current = market; this.books.watch(market.tokens, market);
            this.store.state.markets[slug] ||= { open: market.open, end: market.end, conditionId: market.conditionId };
            this.store.event('market_watched', { slug });
        } else if (!this.books.socket || this.books.socket.readyState === 3) this.books.watch(this.current.tokens, this.current);
        const opening = this.client.btc.openings.get(this.current.open);
        if (opening && opening.receivedAt >= this.current.open && opening.receivedAt <= this.current.open + 5000)
            this.current.reference = { source: 'chainlink_twap_60s', open: this.current.open, end: this.current.end,
                value: opening.value, observedAt: opening.at, receivedAt: opening.receivedAt };
        return this.current;
    }
    async tick(now = this.clock()) {
        if (this.closed) return;
        this.store.freeze(now);
        this.launch(this.manage(now).catch(error => this.store.error('manage', error)));
        if (!this.labelsPending) {
            this.labelsPending = true;
            this.launch(this.resolveOutcomes(now).catch(error => this.store.error('labels', error))
                .finally(() => { this.labelsPending = false; }));
        }
        if (!this.clockTask && now >= this.clockRetryAt) this.launch(this.verifyClock());
        this.client.startBtcFeed();
        if (!this.store.state.frozenAt && this.clockFresh(now)
            && (this.collectWithoutAvailableArms() || this.armNames.some(name => !this.store.state.arms[name].stopped))) {
            const market = await this.market(now);
            if (market) for (const seconds of this.config.slots) {
                const key = `${market.slug}:${seconds}`, at = market.end - seconds * 1000;
                if (now < at || this.store.state.slots[key]) continue;
                this.store.state.slots[key] = { at: now, status: 'reserved' }; this.store.save();
                if (now - at > this.config.slotToleranceMs) {
                    this.store.state.slots[key].status = 'slot_late';
                    this.store.event('slot_skipped', { key, reason: 'slot_late' }); continue;
                }
                this.launch(this.observe(market, seconds, key).catch(error => {
                    if (!error.durableStateCommitted || this.store.state.slots[key].reason)
                        this.store.state.slots[key].status = 'invalid';
                    this.store.error('snapshot', error); this.store.save();
                }));
            }
        }
        if (now - this.lastHeartbeat >= 60000) {
            this.lastHeartbeat = now; this.store.state.lastHeartbeatAt = now;
            this.store.event('heartbeat', { frozenAt: this.store.state.frozenAt, clockFresh: this.clockFresh(now),
                feed: this.client.btc.status(now), bookReady: !!this.books.snapshot(now),
                ...this.heartbeatDetail(now),
                arms: Object.fromEntries(this.armNames.map(name => { const arm = this.store.state.arms[name];
                    return [name, { cash: arm.cash, position: arm.position?.market.slug || null,
                        completed: arm.completed.length, stopped: arm.stopped }]; })) });
        }
        this.store.state.lastTickAt = now;
    }
    heartbeatDetail(now) { return {}; }
    maxInputAgeMs() {
        return this.config.dataAgeMs - this.config.decisionMs - this.config.latencyMs - (this.config.inferenceReserveMs ?? 150);
    }
    validationObservedAt(validation) {
        return Math.min(validation?.at ?? -Infinity, validation?.tickVerifiedAt ?? Infinity);
    }
    async checkObservationTime(slotEnd) {
        // A refresh already in flight can replace an expired clock sample,
        // but neither the sample lifetime nor the observation slot is extended.
        while (!this.clockFresh() && this.clockTask && this.clock() < slotEnd)
            await this.sleep(Math.min(25, slotEnd - this.clock()));
        const now = this.clock();
        if (this.closed || this.store.state.frozenAt || now >= this.config.deadline || now > slotEnd)
            throw new Error('slot_late_after_validation');
        if (!this.clockFresh(now)) throw new Error('snapshot_clock_unverified');
        return now;
    }
    observationStream(validation) { return this.books; }
    observationSourceReady(market, now) { return true; }
    async observationBooks(market, seconds, slotEnd) {
        const generation = this.books.generation;
        const rest = await this.client.books(market); await this.checkObservationTime(slotEnd);
        const validation = { at: this.clock(), generation, identity: metadataIdentity(market) };
        await verifyStreamSnapshot(this.client, this.books, market, validation, this.clock, this.config.dataAgeMs);
        return { rest, validation };
    }
    recordSnapshot(snapshot, detail) {
        this.store.event('snapshot', detail);
        this.store.save();
    }
    async freshSnapshot(market, seconds, rest, validation) {
        const start = this.clock(), slotEnd = market.end - seconds * 1000 + this.config.slotToleranceMs;
        const until = Math.min(slotEnd - (this.config.snapshotSlotReserveMs ?? 100), this.config.deadline - 1);
        const target = Math.min(this.config.snapshotAgeTargetMs ?? this.maxInputAgeMs(), this.maxInputAgeMs());
        let beforeAge;
        for (;;) {
            const now = await this.checkObservationTime(slotEnd);
            let initial, bookSource, features;
            try {
                const stream = this.observationStream(validation);
                const streamed = validatedStreamBooks(stream, market, validation, now, this.config.dataAgeMs);
                const useStream = Math.min(...streamed.map(book => book.timestamp)) >= Math.min(...rest.map(book => book.timestamp));
                initial = useStream ? streamed : rest; bookSource = validation.source || (useStream ? 'websocket' : 'rest');
                features = makeFeatures(this.client.btc, market, initial, stream, now);
            } catch (error) {
                if (now >= until || !['execution_book_unavailable', 'execution_book_stale_or_future',
                    'history_not_ready', 'snapshot_book_stale_or_future'].includes(error.message)) throw error;
                await this.sleep(Math.min(25, until - now)); continue;
            }
            const age = now - features.observedAt;
            beforeAge ??= age;
            const sourceReady = this.observationSourceReady(market, now);
            if (!sourceReady && now >= until) throw new Error('closing_observation_not_ready');
            if (sourceReady && (age <= target || now >= until)) {
                const spot = this.client.btc.spot.findLast(point => point.at <= now && point.receivedAt <= now);
                const twap = this.client.btc.twap;
                return { initial, bookSource, features, timing: { waitMs: now - start, beforeAgeMs: beforeAge,
                    inputAgeMs: age, maxInputAgeMs: this.maxInputAgeMs(), inputHeadroomMs: this.config.dataAgeMs - age,
                    targetMet: age <= target, sourceAgeMs: { spot: now - spot.at, twap: now - twap.at,
                        books: initial.map(book => now - book.timestamp) },
                    feedIngestLagMs: { spot: spot.receivedAt - spot.at, twap: twap.receivedAt - twap.at } } };
            }
            await this.sleep(Math.min(25, until - now));
        }
    }
    eventBatch(events) {
        if (this.store.eventBatch) return this.store.eventBatch(events);
        this.store.save();
        for (const { type, detail } of events) this.store.event(type, detail);
    }
    prepareSnapshot() {}
    async dispatchDecisions(snapshot, market, finalGate, inferenceAt) {
        const { timing, eligibleArms } = snapshot;
        const inputAge = inferenceAt - snapshot.observedAt;
        const validationAge = inferenceAt - this.validationObservedAt(snapshot.validation);
        let decision;
        if (finalGate === false || !this.armNames.some(name => eligibleArms[name] && this.available(name, market.slug)))
            decision = { snapshotId: snapshot.snapshotId, status: 'inference_gate_blocked', action: 'SKIP', latencyMs: 0, cost: 0 };
        else if (inputAge < 0 || inputAge > this.maxInputAgeMs())
            decision = { snapshotId: snapshot.snapshotId, status: 'insufficient_input_headroom', action: 'SKIP', latencyMs: 0, cost: 0 };
        else if (validationAge < 0 || validationAge > this.maxInputAgeMs())
            decision = { snapshotId: snapshot.snapshotId, status: 'insufficient_validation_headroom', action: 'SKIP', latencyMs: 0, cost: 0 };
        else {
            if (this.config.decisionTimeoutPolicy === ADAPTIVE_TIMEOUT_POLICY) {
                const budget = decisionBudget(this.config, snapshot, inferenceAt);
                snapshot.decisionDeadlineAt = budget.decisionDeadlineAt;
                Object.assign(timing, budget);
            }
            decision = await this.providers.predict('laya', snapshot);
        }
        const admittedAt = this.clock();
        snapshot.admittedAt = admittedAt;
        Object.assign(timing, { admittedAt, decisionReceivedAt: decision.receivedAt ?? null,
            decisionInputAgeMs: admittedAt - snapshot.observedAt,
            decisionValidationAgeMs: admittedAt - this.validationObservedAt(snapshot.validation) });
        snapshot.sharedDecision = { ...structuredClone(decision), inferenceAttempted: snapshot.inferenceAttempted === true };
        const events = [{ type: 'decision', detail: { provider: 'laya', shared: true, ...decision } }];
        for (const name of this.armNames) {
            const row = snapshot.decisions[name] = structuredClone(decision);
            this.apply(name, row, snapshot, market, snapshot.allowed, admittedAt, events);
        }
        this.eventBatch(events);
    }
    async observe(market, seconds, key) {
        const slot = this.store.state.slots[key] ||= { at: this.clock(), status: 'reserved' };
        if (this.observing.has(market.slug)) { slot.status = 'observation_busy'; this.store.save(); return; }
        const passiveCollection = this.collectWithoutAvailableArms();
        if (!passiveCollection && !this.armNames.some(name => this.available(name, market.slug))) {
            slot.status = 'arm_unavailable'; this.store.save(); return;
        }
        this.observing.add(market.slug);
        try {
            const started = this.clock();
            const slotEnd = market.end - seconds * 1000 + this.config.slotToleranceMs;
            await this.checkObservationTime(slotEnd);
            const gate = await this.beforeInference({ market: market.slug, slot: seconds, slotEnd });
            await this.checkObservationTime(slotEnd);
            const { rest, validation } = await this.observationBooks(market, seconds, slotEnd);
            const { initial, features, timing, bookSource } = await this.freshSnapshot(market, seconds, rest, validation);
            const now = await this.checkObservationTime(slotEnd); timing.validationMs = validation.at - started;
            const eligibleArms = Object.fromEntries(this.armNames.map(name => [name, this.available(name, market.slug)]));
            // Diagnostic candidates use the frozen research budget; apply still checks each actual ledger.
            const cash = passiveCollection ? this.config.capital
                : Math.max(...this.armNames.filter(name => eligibleArms[name]).map(name => this.store.state.arms[name].cash), 0);
            const checks = candidateChecks(market, initial, this.config, cash, now);
            const allowed = checks.flatMap(check => check.order ? [check.order] : []);
            if (!allowed.length) {
                slot.status = 'no_valid_side';
                this.store.event('opportunity_skipped', { slug: market.slug, slot: seconds, slotKey: key,
                    reasons: checks.map(c => c.reason), sideReasons: { UP: checks[0]?.reason, DOWN: checks[1]?.reason } });
                this.store.save();
                if (!passiveCollection) return;
            }
            const filterVerdicts = {};
            for (const order of allowed) {
                const assessment = this.client.btc.assess(market, order, this.config.control, now);
                if (assessment.reason && !optionalModelReasons.has(assessment.reason)) throw new Error(assessment.reason);
                const action = order.index === 0 ? 'BUY_UP' : 'BUY_DOWN', direction = order.index === 0 ? 1 : -1;
                const aligned = [features.state.spot, features.state.twap]
                    .every(value => Number.isFinite(value) && (value - features.state.opening_twap) * direction > 0);
                const capped = order.price <= .85 + EPS;
                filterVerdicts[action] = {
                    laya: { pass: true, reason: null },
                    'spot-twap': { pass: aligned, reason: aligned ? null : 'spot_twap_not_aligned' },
                    'price-cap-085': { pass: capped, reason: capped ? null : 'price_above_085' },
                    combined: { pass: aligned && capped, reason: !aligned ? 'spot_twap_not_aligned' : capped ? null : 'price_above_085' },
                    'model-edge': { pass: assessment.reason === null, reason: assessment.reason, assessment: structuredClone(assessment) },
                };
            }
            features.state.allowed = allowed.map(order => order.index === 0 ? 'BUY_UP' : 'BUY_DOWN');
            features.state.limit_cost_up_down = [0, 1].map(index => {
                const order = allowed.find(o => o.index === index); return order ? [round(order.price * 100), order.cost] : null;
            });
            const input = encodeFeatures(features.state), snapshotId = hash(JSON.stringify({ market: market.slug, seconds, now, input })).slice(0, 24);
            const snapshot = { snapshotId, market: market.slug, marketEnd: market.end, slot: seconds, at: now, observedAt: features.observedAt,
                state: frozen(structuredClone(features.state)), input, inputHash: hash(input), bookSource,
                validation: structuredClone(validation), timing, allowed: frozen(structuredClone(allowed)),
                eligibleArms: frozen(eligibleArms), filterVerdicts: frozen(filterVerdicts),
                ...(passiveCollection ? { passiveCollection: true,
                    diagnosticOnly: !Object.values(eligibleArms).some(Boolean),
                    collectionPhase: this.armNames.every(name => this.store.state.arms[name].stopped) ? 'all_stopped' : 'active',
                    candidateCashBasis: 'frozen-paper-capital-diagnostic',
                    candidateChecks: checks.map(({ index, reason }) => ({ index, reason })) } : {}),
                decisionProtocol: structuredClone(this.config.decisionProtocol || null), executionBatches: [], decisions: {} };
            this.prepareSnapshot(snapshot, market);
            this.store.state.markets[market.slug] ||= { open: market.open, end: market.end, conditionId: market.conditionId };
            this.store.state.snapshots.push(snapshot); slot.status = 'observed';
            this.recordSnapshot(snapshot, { snapshotId, slug: market.slug, slot: seconds, inputHash: snapshot.inputHash, filterVerdicts, timing });
            const finalGate = gate === false ? false : await this.beforeInference(snapshot);
            await this.checkObservationTime(slotEnd);
            const inferenceAt = this.clock(), inputAge = inferenceAt - snapshot.observedAt;
            const validationAge = inferenceAt - this.validationObservedAt(validation);
            Object.assign(timing, { inferenceStartedAt: inferenceAt, inferenceInputAgeMs: inputAge,
                inferenceHeadroomMs: this.config.dataAgeMs - inputAge, inferenceValidationAgeMs: validationAge,
                validationHeadroomMs: this.config.dataAgeMs - validationAge });
            await this.dispatchDecisions(snapshot, market, finalGate, inferenceAt);
        } catch (error) {
            const code = /^[a-zA-Z0-9_:-]+$/.test(error.message) ? error.message : 'snapshot_failed';
            const snapshot = this.store.state.snapshots.findLast(row => row.market === market.slug && row.slot === seconds);
            if (error.durableStateCommitted && snapshot?.sharedDecision) slot.loggingError = code;
            else {
                slot.reason = code;
                if (snapshot && !snapshot.sharedDecision) {
                    snapshot.sharedDecision = { snapshotId: snapshot.snapshotId, status: 'observation_failed',
                        action: 'SKIP', latencyMs: 0, cost: 0, inferenceAttempted: snapshot.inferenceAttempted === true };
                    for (const name of this.armNames) snapshot.decisions[name] = {
                        ...snapshot.sharedDecision, entryDisposition: 'no_buy_decision' };
                    this.store.save();
                }
            }
            throw error;
        } finally { this.observing.delete(market.slug); }
    }
    apply(name, decision, snapshot, market, allowed = snapshot.allowed, now = this.clock(), events = null) {
        const arm = this.store.state.arms[name];
        const emit = (type, detail) => events ? events.push({ type, detail }) : this.store.event(type, detail);
        const reject = reason => { decision.entryDisposition = reason; };
        if (!snapshot.eligibleArms?.[name] || !this.available(name, market.slug)) return reject(arm.stopped ? 'arm_stopped' : 'arm_unavailable');
        if (decision.status !== 'ok' || decision.action === 'SKIP') return reject('no_buy_decision');
        if (this.closed) return reject('closed');
        if (this.store.state.frozenAt || now >= this.config.deadline || now >= market.end) return reject('deadline');
        if (!this.clockFresh(now)) return reject('clock_unverified');
        const { requestedAt, receivedAt } = decision;
        let deadlineAt = requestedAt + this.config.decisionMs;
        if (this.config.decisionTimeoutPolicy === ADAPTIVE_TIMEOUT_POLICY) {
            try {
                deadlineAt = decisionBudget(this.config, snapshot, now).decisionDeadlineAt;
                if (snapshot.marketEnd !== market.end || snapshot.decisionDeadlineAt !== deadlineAt) return reject('invalid_decision_budget');
            } catch { return reject('invalid_decision_budget'); }
        }
        if (!Number.isFinite(requestedAt) || !Number.isFinite(receivedAt) || requestedAt < snapshot.at
            || receivedAt < requestedAt || receivedAt > now || receivedAt > deadlineAt)
            return reject('late_response');
        if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now || now - snapshot.observedAt > this.config.dataAgeMs)
            return reject('stale_input');
        if (now - Math.min(snapshot.observedAt, this.validationObservedAt(snapshot.validation))
            + this.config.latencyMs + (this.config.inferenceReserveMs ?? 150) > this.config.dataAgeMs)
            return reject('insufficient_execution_headroom');
        const index = decision.action === 'BUY_UP' ? 0 : decision.action === 'BUY_DOWN' ? 1 : -1;
        const order = allowed.find(o => o.index === index);
        if (!order || order.cost > arm.cash + EPS) return reject('side_or_budget_invalid');
        const verdict = snapshot.filterVerdicts?.[decision.action]?.[name];
        if (!verdict) return reject('missing_filter_verdict');
        if (!verdict.pass) {
            decision.filterReason = verdict.reason; reject('filter_veto');
            arm.outcomes[market.slug] = { snapshotId: snapshot.snapshotId, pnl: 0, reason: 'filter_veto', filterReason: verdict.reason };
            emit('filter_veto', { arm: name, slug: market.slug, snapshotId: snapshot.snapshotId, reason: verdict.reason }); return;
        }
        // A filter veto leaves later preregistered slots eligible; only an actual
        // reserved order consumes this arm's single execution attempt.
        arm.seen[market.slug] = { snapshotId: snapshot.snapshotId, at: now };
        if (arm.outcomes[market.slug]?.reason === 'filter_veto') delete arm.outcomes[market.slug];
        decision.entryDisposition = 'reserved';
        arm.position = { market: structuredClone(market), snapshotId: snapshot.snapshotId, order: structuredClone(order),
            status: 'pending', submittedAt: now, activeAt: now + this.config.latencyMs, holdings: 0, entryCost: 0, fees: 0, gas: 0,
            signal: snapshot.filterVerdicts[decision.action]['model-edge'].assessment,
            snapshotObservedAt: snapshot.observedAt, validation: structuredClone(snapshot.validation), capitalHours: 0, lastCapitalAt: now };
        emit('order_pending', { arm: name, snapshotId: snapshot.snapshotId, slug: market.slug, submittedAt: now,
            activeAt: arm.position.activeAt, snapshotPrice: order.snapshotPrice, price: order.price, slippage: order.slippage, shares: order.shares });
    }
    finishWithoutFill(name, position, reason, code = null, events = null) {
        const arm = this.store.state.arms[name];
        arm.outcomes[position.market.slug] = { snapshotId: position.snapshotId, pnl: 0, reason, ...(code ? { code } : {}),
            ...(position.executionCohortId ? { executionCohortId: position.executionCohortId,
                executionBookHash: position.executionBookHash, executionAt: position.executionAt,
                executionInputAgeMs: position.executionInputAgeMs, executionHeadroomMs: position.executionHeadroomMs } : {}) };
        arm.position = null;
        const detail = { arm: name, slug: position.market.slug, snapshotId: position.snapshotId, code };
        if (events) events.push({ type: reason, detail }); else this.store.event(reason, detail);
    }
    async manage(now = this.clock()) {
        const names = this.armNames.filter(name => !this.managingArms.has(name));
        names.forEach(name => this.managingArms.add(name));
        try {
            const cohorts = new Map();
            for (const name of names) {
                const p = this.store.state.arms[name].position;
                if (p?.status !== 'pending') continue;
                const key = JSON.stringify([p.snapshotId, p.market.slug, p.activeAt]);
                if (!cohorts.has(key)) cohorts.set(key, []);
                cohorts.get(key).push(name);
            }
            for (const [key, cohort] of cohorts) await this.executeCohort(key, cohort);
        } catch (error) {
            names.forEach(name => this.managingArms.delete(name)); throw error;
        }
        await Promise.all(names.map(async name => {
            try { await this.manageArm(name, now); }
            finally { this.managingArms.delete(name); }
        }));
    }
    executionFilter() { return null; }
    executeCohort(key, names, view = null) {
        const at = this.clock(), first = this.store.state.arms[names[0]].position;
        if (at < first.activeAt) return;
        const cohortId = hash(key).slice(0, 24), events = [], errors = [];
        let books, captureError, feedReady, clockReady;
        try {
            if (view?.error) throw view.error;
            books = frozen(structuredClone(view ? view.books : this.books.snapshot(at)));
            feedReady = this.client.btc.status(at).ready;
            clockReady = this.clockFresh(at);
        } catch (error) { captureError = error; }
        const stream = { generation: view?.validation?.generation ?? this.books.generation,
            tokens: [...(view ? first.market.tokens : this.books.tokens || [])], snapshot: () => books };
        const bookSource = view?.source || 'websocket';
        const bookHash = books ? hash(JSON.stringify(books)) : null, assessments = new Map();
        const snapshot = this.store.state.snapshots.find(row => row.snapshotId === first.snapshotId);
        if (snapshot) {
            snapshot.executionBatches ||= [];
            snapshot.executionBatches.push({ cohortId, activeAt: first.activeAt, executionAt: at,
                bookHash, bookSource, armNames: [...names], inputAgeMs: at - first.snapshotObservedAt,
                headroomMs: this.config.dataAgeMs - (at - first.snapshotObservedAt),
                ...(view?.evidence ? { evidence: structuredClone(view.evidence) } : {}) });
        }
        // Every world reads this one actual execution view. Compute and mutate
        // the whole cohort before the first durable write or event append.
        for (const name of names) {
            const arm = this.store.state.arms[name], p = arm.position;
            Object.assign(p, { executionAt: at, executionLatencyMs: at - p.submittedAt,
                executionInputAgeMs: at - p.snapshotObservedAt, executionHeadroomMs: this.config.dataAgeMs - (at - p.snapshotObservedAt),
                executionBookSource: bookSource, executionBookHash: bookHash, executionCohortId: cohortId });
            try {
                this.assessRisk(name, arm.cash, at, { basis: 'pre_execution_cash' }, events);
                if (captureError) throw captureError;
                if (this.closed || arm.stopped || this.store.state.frozenAt || at >= this.config.deadline || at >= p.market.end
                    || !clockReady || !feedReady || !Number.isFinite(p.snapshotObservedAt)
                    || at < p.snapshotObservedAt || at - p.snapshotObservedAt > this.config.dataAgeMs) throw new Error('execution_stale');
                if (view && at > Math.min(this.validationObservedAt(p.validation) + this.config.dataAgeMs,
                    snapshot?.timing?.executionDeadlineAt ?? Infinity)) throw new Error('execution_stale');
                if (view && metadataIdentity(p.market) !== p.validation.identity) throw new Error('execution_metadata_changed_or_expired');
                validatedStreamBooks(stream, p.market, view?.validation || p.validation, at, this.config.dataAgeMs);
                const check = candidateChecks(p.market, books, { ...this.config, limitSlippageTicks: 0, limitSlippageUsd: 0 }, arm.cash, at, false)
                    .find(row => row.index === p.order.index);
                if (!check?.order) throw new Error(`execution_${check?.reason || 'side_invalid'}`);
                if (p.order.cost > arm.cash + EPS) throw new Error('execution_insufficient_virtual_cash');
                const assessmentKey = JSON.stringify([metadataIdentity(p.market), p.order]);
                if (!assessments.has(assessmentKey)) assessments.set(assessmentKey,
                    frozen(structuredClone(this.client.btc.assess(p.market, p.order, this.config.control, at))));
                const assessed = assessments.get(assessmentKey);
                if (name === 'model-edge' ? assessed.reason !== null : assessed.reason && !optionalModelReasons.has(assessed.reason))
                    throw new Error('execution_signal_invalid');
                p.executionSignal = structuredClone(assessed);
                const filter = this.executionFilter(name, p, books, at);
                if (filter) {
                    events.push({ type: 'execution_filter_checked', detail: { arm: name,
                        slug: p.market.slug, snapshotId: p.snapshotId, executionCohortId: cohortId,
                        executionBookHash: bookHash, executionAt: at, ...filter } });
                    if (!filter.pass) {
                        this.finishWithoutFill(name, p, 'execution_filter_veto', filter.reason, events);
                        Object.assign(arm.outcomes[p.market.slug], { filterReason: filter.reason, metrics: filter.metrics });
                        const decision = snapshot?.decisions?.[name];
                        if (decision) Object.assign(decision, { entryDisposition: 'execution_filter_veto',
                            filterReason: filter.reason, executionFilter: filter });
                        continue;
                    }
                }
                const fill = sweep(books[p.order.index].asks, p.order.shares, p.order.price, 'BUY', p.market.fee);
                if (fill.shares <= EPS) { this.finishWithoutFill(name, p, 'no_fill', 'fixed_limit_not_marketable', events); continue; }
                p.status = 'matched'; p.fill = fill; p.settleAt = at + this.config.settlementMs;
                events.push({ type: 'fill_matched', detail: { arm: name, slug: p.market.slug, snapshotId: p.snapshotId,
                    shares: fill.shares, fees: fill.fees, executionAt: at, executionLatencyMs: p.executionLatencyMs,
                    executionCohortId: cohortId, executionBookHash: bookHash, limit: p.order.price } });
            } catch (error) {
                if (p.status !== 'pending' || arm.position !== p) throw error;
                this.finishWithoutFill(name, p, 'execution_expired', error.message, events); errors.push(error);
            }
        }
        this.eventBatch(events);
        for (const error of errors) this.store.error('execution', error);
    }
    async manageArm(name, now) {
        const arm = this.store.state.arms[name], p = arm.position;
        if (!p) { this.assessRisk(name, arm.cash, now); arm.valuationKnown = true; arm.valuationAt = now; return; }
        p.capitalHours += (p.entryCost || (p.status === 'matched' ? -p.fill.cash : p.order.cost - this.config.gasUsd))
            * Math.max(0, now - p.lastCapitalAt) / 3600000; p.lastCapitalAt = now;
        if (p.status === 'matched' && now >= p.settleAt) {
            p.status = 'filled'; p.holdings = p.fill.shares; p.entryCost = -p.fill.cash; p.fees = p.fill.fees;
            arm.cash = round(arm.cash + p.fill.cash);
            this.store.event('fill_settled', { arm: name, slug: p.market.slug, shares: p.holdings, cash: arm.cash });
        }
        if (p.status !== 'filled') return;
        let markUpdated = false;
        if (now < p.market.end && (!p.lastMarkAttemptAt || now - p.lastMarkAttemptAt >= 5000)) {
            p.lastMarkAttemptAt = now;
            try {
                const books = await this.client.books(p.market), at = this.clock(), book = books?.[p.order.index];
                if (!book || !Number.isFinite(book.timestamp) || !Number.isFinite(book.fetchedAt)
                    || book.timestamp > at || book.fetchedAt > at || at - book.timestamp > this.config.dataAgeMs
                    || at - book.fetchedAt > this.config.dataAgeMs || !Array.isArray(book.bids)
                    || book.bids.some(level => !Number.isFinite(level.price) || level.price <= 0 || level.price >= 1
                        || !Number.isFinite(level.size) || level.size <= 0)) throw new Error('valuation_book_unavailable');
                const liquidation = sweep(book.bids, p.holdings, 0, 'SELL', p.market.fee);
                p.mark = liquidation.cash; p.markSource = 'rest';
                p.markBook = { hash: hash(JSON.stringify(book.bids)), bidLevels: book.bids.length,
                    bestBid: book.bids.reduce((best, level) => Math.max(best, level.price), 0) || null,
                    bidDepthShares: round(book.bids.reduce((total, level) => total + level.size, 0)),
                    liquidatedShares: liquidation.shares, unliquidatedShares: round(Math.max(0, p.holdings - liquidation.shares)),
                    liquidationNotional: liquidation.notional, liquidationFees: liquidation.fees };
                p.markObservedAt = book.timestamp; p.markReceivedAt = book.fetchedAt; p.lastMarkAt = at; markUpdated = true;
            } catch (error) { this.store.error('valuation', error); }
        }
        const at = this.clock();
        p.markFresh = Number.isFinite(p.mark) && Number.isFinite(p.markObservedAt) && Number.isFinite(p.markReceivedAt)
            && p.markObservedAt <= at && p.markReceivedAt <= at && at - p.markObservedAt <= this.config.dataAgeMs
            && at - p.markReceivedAt <= this.config.dataAgeMs;
        arm.valuationKnown = p.markFresh;
        if (p.markFresh) { this.assessRisk(name, arm.cash + p.mark, at, { basis: 'liquidation_mark' }); arm.valuationAt = p.markObservedAt; }
        if (markUpdated) this.store.save();
        if (at < p.market.end) return;
        const payout = await this.officialPayout(p.market, at);
        if (!payout || arm.position !== p) return;
        const redeemed = p.holdings * payout[p.order.index], pnl = round(redeemed - p.entryCost - this.config.gasUsd);
        arm.cash = round(arm.cash + redeemed - this.config.gasUsd);
        const result = { slug: p.market.slug, conditionId: p.market.conditionId, snapshotId: p.snapshotId,
            openedAt: p.submittedAt, closedAt: this.clock(), marketEnd: p.market.end, pnl, fees: p.fees, gas: this.config.gasUsd,
            entryCost: p.entryCost, shares: p.holdings, partial: p.holdings < p.order.shares - EPS, payout: [...payout],
            capitalHours: p.capitalHours, executionLatencyMs: p.executionLatencyMs, executionBookSource: p.executionBookSource,
            executionAt: p.executionAt, executionCohortId: p.executionCohortId, executionBookHash: p.executionBookHash,
            executionInputAgeMs: p.executionInputAgeMs, executionHeadroomMs: p.executionHeadroomMs,
            snapshotPrice: p.order.snapshotPrice, limit: p.order.price, averageFillPrice: round(p.fill.notional / p.fill.shares) };
        arm.completed.push(result); arm.outcomes[p.market.slug] = { snapshotId: p.snapshotId, pnl, reason: 'settled' }; arm.position = null;
        arm.valuationKnown = true; arm.valuationAt = result.closedAt;
        this.assessRisk(name, arm.cash, result.closedAt, { basis: 'official_settlement', position: p,
            settlement: { payout: [...payout], redeemed: round(redeemed), pnl, gas: this.config.gasUsd } });
        this.store.event('official_settlement', { arm: name, ...result });
    }
    async officialPayout(market, now) {
        const record = this.store.state.markets[market.slug] ||= { open: market.open, end: market.end, conditionId: market.conditionId };
        if (validPayout(record.payout)) return record.payout;
        if (now < market.end || !market.conditionId) return null;
        const cached = Object.values(this.store.state.markets).find(row => row.conditionId === market.conditionId && validPayout(row.payout));
        if (cached) { record.payout = [...cached.payout]; return record.payout; }
        if (this.payoutPending.has(market.conditionId)) return this.payoutPending.get(market.conditionId);
        if (now < (record.payoutNextAt || 0)) return null;
        const task = (async () => {
            try {
                const payout = await this.client.payout(market.conditionId), at = this.clock();
                record.payoutNextAt = at + 15000;
                if (!payout) return null;
                if (!validPayout(payout)) throw new Error('invalid_payout');
                // Cache before releasing concurrent arm settlements, including label-only reads.
                record.payout = [...payout]; record.labelResolvedAt = at; record.payoutFailures = 0;
                this.store.event('market_label', { slug: market.slug, payout }); this.store.save(); return record.payout;
            } catch (error) {
                record.payoutFailures = (record.payoutFailures || 0) + 1;
                record.payoutNextAt = this.clock() + Math.min(60000, 15000 * 2 ** Math.min(record.payoutFailures, 2));
                this.store.error('settlement', error); return null;
            } finally { this.store.save(); }
        })();
        this.payoutPending.set(market.conditionId, task);
        try { return await task; } finally { this.payoutPending.delete(market.conditionId); }
    }
    async resolveOutcomes(now) {
        await Promise.all(Object.entries(this.store.state.markets).filter(([slug, market]) => now >= market.end && !market.payout
            && (this.store.state.snapshots.some(snapshot => snapshot.market === slug)
                || this.armNames.some(name => this.store.state.arms[name].position?.market.slug === slug)))
            .map(([slug, market]) => this.officialPayout({ ...market, slug }, now)));
    }
    close() {
        this.closed = true;
        for (const name of this.armNames) {
            const p = this.store.state.arms[name].position;
            if (p?.status === 'pending') this.finishWithoutFill(name, p, 'shutdown_pending_cancelled');
        }
        this.books.close(); this.providers.close(); this.client.close(); this.store.save();
    }
}
