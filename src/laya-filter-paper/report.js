import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';

const ARMS = ['laya', 'spot-twap', 'price-cap-085', 'combined', 'model-edge'];
const DAY = 86400000, WIB = 7 * 3600000;
const ZERO_OUTCOMES = new Set(['filter_veto', 'execution_filter_veto', 'no_fill', 'execution_expired', 'arm_stopped', 'arm_unavailable',
    'deadline_pending_cancelled', 'shutdown_pending_cancelled', 'restart_during_pending_execution']);
const NO_ENTRY = new Set(['no_buy_decision', 'arm_stopped', 'arm_unavailable', 'filter_veto', 'execution_filter_veto', 'deadline',
    'late_response', 'stale_input', 'insufficient_execution_headroom', 'side_or_budget_invalid', 'closed', 'slot_ineligible',
    'clock_unverified', 'missing_filter_verdict', 'invalid_decision_budget']);
const NO_RESPONSE = new Set(['decision_timeout', 'timeout', 'provider_error', 'provider_disabled', 'provider_unavailable',
    'arm_stopped', 'arm_unavailable', 'disabled', 'unavailable', 'busy']);
const REQUEST_STATUSES = new Set(['ok', 'decision_timeout', 'timeout', 'provider_error']);
const finite = Number.isFinite;
const sum = (rows, key) => round(rows.reduce((total, row) => total + (finite(row[key]) ? row[key] : 0), 0));
const slugOf = row => row.slug || (typeof row.market === 'string' ? row.market : row.market?.slug);
const payoutOf = market => market?.payout ?? market?.officialPayout;
const validPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(value => finite(value) && value >= 0 && value <= 1) && Math.abs(payout[0] + payout[1] - 1) < 0.00001;
const countBy = (rows, key) => rows.reduce((counts, row) => {
    const value = typeof key === 'function' ? key(row) : row[key];
    if (value) counts[value] = (counts[value] || 0) + 1;
    return counts;
}, {});
const percentile = (values, fraction) => values.length
    ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
const percentiles = values => ({ p50: percentile(values, .5), p95: percentile(values, .95), samples: values.length });
const dayCount = rows => new Set(rows.map(row => new Date(row.closedAt + WIB).toISOString().slice(0, 10))).size;
const decisionDeadline = (snapshot, decision) => snapshot.decisionDeadlineAt
    ?? snapshot.timing?.decisionDeadlineAt ?? decision?.decisionDeadlineAt;

function withinDecisionDeadline(snapshot, decision, config, now) {
    const deadline = decisionDeadline(snapshot, decision);
    const requestedAt = finite(decision.requestedAt) ? decision.requestedAt : snapshot.at;
    if (finite(deadline) || config.decisionTimeoutPolicy === 'snapshot-freshness-budget-v1')
        return finite(deadline) && finite(decision.requestedAt) && finite(decision.receivedAt)
            && decision.requestedAt >= snapshot.at && decision.receivedAt >= decision.requestedAt
            && decision.receivedAt <= Math.min(deadline, now);
    const latency = decision.actualLatencyMs ?? decision.latencyMs;
    return !(finite(config.decisionMs) && finite(latency) && latency > config.decisionMs
        || finite(decision.receivedAt) && (decision.receivedAt > now || decision.receivedAt < requestedAt)
        || finite(decision.receivedAt) && finite(requestedAt) && finite(config.decisionMs)
            && decision.receivedAt - requestedAt > config.decisionMs);
}

function interval(rows, minimumDays, minimumMarkets, samples, elapsedDays) {
    const days = dayCount(rows), reasons = [];
    if (elapsedDays < minimumDays) reasons.push('insufficient_elapsed_days');
    if (days < minimumDays) reasons.push('insufficient_observed_days');
    if (rows.length < minimumMarkets) reasons.push('insufficient_cohort_markets');
    return { method: 'daily_cluster_bootstrap', timezone: 'Asia/Jakarta', days, markets: rows.length,
        sufficient: reasons.length === 0, reasons,
        ci95: reasons.length ? null : dailyBootstrap(rows.map(row => ({ ...row, closedAt: row.closedAt + WIB })), samples) };
}

function completedMarkets(arm) {
    const rows = new Map(), ambiguous = new Set();
    for (const row of arm.completed || []) {
        const slug = slugOf(row);
        if (!slug) continue;
        if (!finite(row.pnl) || row.uncertain || row.traded === false || (finite(row.shares) && row.shares <= 0)) {
            ambiguous.add(slug); continue;
        }
        if (rows.has(slug) && JSON.stringify(rows.get(slug)) !== JSON.stringify(row)) ambiguous.add(slug);
        else rows.set(slug, row);
    }
    for (const slug of ambiguous) rows.delete(slug);
    return { rows, ambiguous };
}

function noExposureDecision(decision) {
    if (!decision) return false;
    if (['pending', 'running', 'requested'].includes(decision.status)) return false;
    if (['reserved', 'pending', 'matched', 'filled'].includes(decision.entryDisposition)) return false;
    return NO_ENTRY.has(decision.entryDisposition) || NO_RESPONSE.has(decision.status)
        || decision.status === 'ok' && decision.action === 'SKIP';
}

function marketResult(arm, completed, slug, snapshots) {
    if (!arm) return { pending: 'missing_arm' };
    if (slugOf(arm.position || {}) === slug) return { pending: 'open_inventory' };
    if (completed.ambiguous.has(slug)) return { pending: 'ambiguous_completion' };
    const row = completed.rows.get(slug), outcome = arm.outcomes?.[slug];
    if (row) {
        if (outcome && finite(outcome.pnl) && Math.abs(outcome.pnl - row.pnl) > 0.00001)
            return { pending: 'outcome_completion_mismatch' };
        return { pnl: row.pnl, reason: 'settled', filled: true };
    }
    if (outcome?.reason === 'settled' && finite(outcome.pnl) && !outcome.uncertain)
        return { pending: 'settled_completion_missing' };
    if (['filter_veto', 'execution_filter_veto'].includes(outcome?.reason)
        && !snapshots.every(snapshot => noExposureDecision(snapshot.decision)))
        return { pending: 'decision_or_outcome_pending' };
    if (outcome && finite(outcome.pnl) && outcome.pnl === 0 && !outcome.uncertain
        && (ZERO_OUTCOMES.has(outcome.reason) || outcome.noExposure === true))
        return { pnl: 0, reason: outcome.reason || 'no_exposure', filled: false };
    if (outcome) return { pending: 'unresolved_outcome' };
    if (arm.seen?.[slug]) return { pending: 'execution_outcome_missing' };
    if (snapshots.length && snapshots.every(snapshot => noExposureDecision(snapshot.decision)))
        return { pnl: 0, reason: 'explicit_no_entry', filled: false };
    return { pending: 'decision_or_outcome_pending' };
}

function signalQuality(snapshots, markets, decisionFor, config, now) {
    const selected = new Map();
    for (const snapshot of [...snapshots].sort((a, b) => (a.at || 0) - (b.at || 0))) {
        const decision = decisionFor(snapshot), market = markets[snapshot.market], payout = payoutOf(market);
        if (!market || market.end > now || !validPayout(payout) || selected.has(snapshot.market)
            || decision?.status !== 'ok' || decision.diagnosticOnly || !['BUY_UP', 'BUY_DOWN'].includes(decision.action)) continue;
        if (decision.timely === false || ['late_response', 'stale_input'].includes(decision.entryDisposition)
            || !withinDecisionDeadline(snapshot, decision, config, now)) continue;
        selected.set(snapshot.market, payout[decision.action === 'BUY_UP' ? 0 : 1]);
    }
    const labels = [...selected.values()], wins = labels.filter(value => value === 1).length;
    return { selection: 'first_timely_buy_per_officially_labeled_market', independentMarkets: labels.length,
        wins, losses: labels.filter(value => value === 0).length, neutral: labels.filter(value => value > 0 && value < 1).length,
        winRate: labels.length ? round(wins / labels.length) : null };
}

function completedResponseLatency(decision) {
    const completedResponse = decision.status === 'ok' || decision.inferenceAttempted === true
        && (['invalid', 'rejected'].includes(decision.status) || decision.status === 'provider_error' && finite(decision.httpStatus));
    const latency = finite(decision.actualLatencyMs) ? decision.actualLatencyMs
        : completedResponse ? decision.latencyMs : null;
    return finite(latency) && latency >= 0 ? latency : null;
}

function responseLatency(decisions) {
    // Timeout waiting time is not a completed response latency. A later response can provide actualLatencyMs.
    const values = decisions.map(completedResponseLatency).filter(finite);
    return { ...percentiles(values), completedResponses: values.length,
        timeoutCount: decisions.filter(decision => ['decision_timeout', 'timeout'].includes(decision.status)).length };
}

function sharedDecision(snapshot) {
    const decision = snapshot.sharedDecision || snapshot.decisions?.laya;
    const attempted = snapshot.inferenceAttempted === true || decision?.inferenceAttempted === true;
    if (!decision && !attempted) return null;
    return { ...(decision || { status: 'pending', cost: null }), inferenceAttempted: attempted,
        inferenceStartedAt: snapshot.inferenceStartedAt ?? decision?.inferenceStartedAt ?? null };
}

function adaptiveTimeoutDiagnostics(snapshots, config, now) {
    const rows = snapshots.flatMap(snapshot => {
        const decision = sharedDecision(snapshot);
        return decision && (decision.inferenceAttempted || REQUEST_STATUSES.has(decision.status))
            ? [{ snapshot, decision }] : [];
    });
    const recorded = rows.filter(({ snapshot, decision }) => finite(decisionDeadline(snapshot, decision)));
    const budgets = rows.map(({ snapshot, decision }) => decision.decisionBudgetMs ?? snapshot.timing?.decisionBudgetMs)
        .filter(value => finite(value) && value >= 0);
    const referenceMs = 3000, available = recorded.length > 0;
    const slow = rows.filter(({ decision }) => completedResponseLatency(decision) > referenceMs);
    const accepted = slow.filter(({ snapshot, decision }) => decision.status === 'ok'
        && finite(decisionDeadline(snapshot, decision)) && withinDecisionDeadline(snapshot, decision, config, now));
    const timeouts = rows.filter(({ decision }) => ['decision_timeout', 'timeout'].includes(decision.status));
    return { policy: config.decisionTimeoutPolicy || null, referenceMs, available,
        complete: available && recorded.length === rows.length, recordedRequests: recorded.length,
        decisionBudgetMs: { available: budgets.length > 0, ...percentiles(budgets) },
        completedResponsesOverReference: slow.length,
        acceptedOverReference: available ? accepted.length : null,
        reservedOverReference: available ? accepted.filter(({ snapshot }) => Object.values(snapshot.decisions || {})
            .some(decision => decision.entryDisposition === 'reserved')).length : null,
        timedOutResponsesOverReference: slow.filter(({ decision }) => ['decision_timeout', 'timeout'].includes(decision.status)).length,
        timeoutCount: timeouts.length,
        timeoutsWithoutResponse: timeouts.filter(({ decision }) => completedResponseLatency(decision) === null).length };
}

function settledDrawdown(rows) {
    let equity = 0, peak = 0, drawdown = 0;
    for (const row of [...rows].sort((a, b) => (a.closedAt || a.marketEnd || 0) - (b.closedAt || b.marketEnd || 0))) {
        equity += row.pnl; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity);
    }
    return round(drawdown);
}

function opportunityCoverage(state) {
    const available = state.slots !== undefined, slots = Object.values(state.slots || {});
    const byStatus = countBy(slots, row => row.status || 'unrecorded');
    const counters = state.opportunitySkips, recorded = counters?.schema === 1;
    const complete = recorded && counters.complete === true;
    return { slots: byStatus,
        slotCoverage: { available, source: 'durable_slot_state', scheduled: available ? slots.length : null,
            observed: available ? byStatus.observed || 0 : null,
            no_valid_side: available ? byStatus.no_valid_side || 0 : null,
            invalid: available ? byStatus.invalid || 0 : null,
            invalidReasons: countBy(slots.filter(slot => slot.status === 'invalid'), slot => slot.reason || 'unrecorded'),
            pending: available ? (byStatus.reserved || 0) + (byStatus.scheduled || 0) : null,
            observationRate: slots.length ? round((byStatus.observed || 0) / slots.length) : null },
        opportunitySkips: { total: complete ? counters.total : available ? byStatus.no_valid_side || 0 : null,
            source: complete ? 'durable_skip_counter' : available ? 'durable_slot_state' : 'unavailable',
            reasonsAvailable: recorded, reasonsComplete: complete,
            recordedReasonSlots: recorded ? counters.total : null,
            byReason: recorded ? counters.byReason : null, bySide: recorded ? counters.bySide : null } };
}

function pipelineDiagnostics(state, snapshots, shared) {
    const metrics = ['inputAgeMs', 'maxInputAgeMs', 'inputHeadroomMs', 'inferenceInputAgeMs', 'inferenceHeadroomMs',
        'inferenceValidationAgeMs', 'validationHeadroomMs', 'decisionInputAgeMs', 'decisionValidationAgeMs'];
    const timing = Object.fromEntries(metrics.map(key => [key,
        percentiles(snapshots.map(snapshot => snapshot.timing?.[key]).filter(finite))]));
    const batches = [...new Map(snapshots.flatMap(snapshot => snapshot.executionBatches || [])
        .map((batch, index) => [batch.cohortId || `unidentified-${index}`, batch])).values()];
    const comparable = batches.filter(batch => batch.armNames?.length > 1);
    const recordedSnapshots = snapshots.filter(snapshot => Array.isArray(snapshot.executionBatches)).length;
    const available = recordedSnapshots > 0;
    const verified = [], mismatched = [], unverifiable = [];
    for (const batch of comparable) {
        const armRows = batch.armNames.map(name => {
            const arm = state.arms?.[name];
            return [arm?.position, ...(arm?.completed || []), ...Object.values(arm?.outcomes || {})]
                .filter(row => row?.executionCohortId === batch.cohortId);
        });
        if (armRows.some(rows => rows.some(row => row.executionBookHash && row.executionBookHash !== batch.bookHash
            || finite(row.executionAt) && row.executionAt !== batch.executionAt)))
            mismatched.push(batch.cohortId);
        else if (!batch.cohortId || !batch.bookHash || batch.bookSource !== 'websocket' || !finite(batch.executionAt)
            || armRows.some(rows => !rows.length || rows.some(row => !row.executionBookHash || !finite(row.executionAt))))
            unverifiable.push(batch.cohortId || null);
        else verified.push(batch.cohortId);
    }
    const attempted = decision => decision.inferenceAttempted || REQUEST_STATUSES.has(decision.status);
    return { admission: { attempted: shared.filter(attempted).length,
            skippedReasons: countBy(shared.filter(decision => !attempted(decision)),
                decision => decision.reason || decision.status),
            responseReasons: countBy(shared, decision => decision.reason || decision.status) },
        pipelineTimingMs: timing,
        executionQuality: { available, complete: available && recordedSnapshots === snapshots.length, recordedSnapshots,
            batches: available ? batches.length : null, comparableBatches: available ? comparable.length : null,
            sameBatchSourceRecorded: available ? comparable.filter(batch => batch.bookSource === 'websocket'
                && typeof batch.bookHash === 'string' && !!batch.bookHash && finite(batch.executionAt)).length : null,
            verifiedArmSources: available ? verified.length : null,
            mismatchedArmSources: available ? mismatched : null, unverifiableArmSources: available ? unverifiable : null,
            incompleteSourceMarkers: available ? batches.filter(batch => !batch.bookHash || !batch.bookSource || !finite(batch.executionAt)).length : null,
            source: available ? countBy(batches, 'bookSource') : null,
            inputAgeMs: percentiles(batches.map(batch => batch.inputAgeMs).filter(finite)),
            headroomMs: percentiles(batches.map(batch => batch.headroomMs).filter(finite)) } };
}

export function summarizeFilterPaper(state, config, now = Date.now()) {
    const snapshots = state.snapshots || [], markets = state.markets || {};
    const armNames = config.armNames || ARMS, baselineArm = config.baselineArm || 'laya';
    const minimumDays = Math.max(7, config.minDays || 7), minimumMarkets = Math.max(100, config.minMarkets || 100);
    const bootstrapSamples = Math.max(100, Math.floor(config.bootstrapSamples || 2000));
    const startedAt = state.startedAt, evaluationAt = Math.min(now, state.frozenAt || now, finite(config.deadline) ? config.deadline : now);
    const elapsedDays = finite(startedAt) ? Math.max(0, (evaluationAt - startedAt) / DAY) : 0;
    const snapshotsByMarket = new Map();
    for (const snapshot of snapshots) {
        if (!snapshotsByMarket.has(snapshot.market)) snapshotsByMarket.set(snapshot.market, []);
        snapshotsByMarket.get(snapshot.market).push(snapshot);
    }
    const completed = Object.fromEntries(armNames.map(name => [name, completedMarkets(state.arms?.[name] || {})]));
    const cohort = [], pendingMarkets = [], labelPending = [];
    for (const [slug, observations] of snapshotsByMarket) {
        const market = markets[slug];
        if (!market || !finite(market.end) || market.end > now) continue;
        if (!validPayout(payoutOf(market))) { labelPending.push(slug); continue; }
        const results = Object.fromEntries(armNames.map(name => [name, marketResult(state.arms?.[name], completed[name], slug,
            observations.map(snapshot => ({ decision: snapshot.decisions?.[name] })))]));
        const pending = Object.fromEntries(Object.entries(results).filter(([, result]) => result.pending)
            .map(([name, result]) => [name, result.pending]));
        if (Object.keys(pending).length) pendingMarkets.push({ market: slug, reasons: pending });
        else cohort.push({ market: slug, closedAt: market.end, results });
    }
    cohort.sort((a, b) => a.closedAt - b.closedAt || a.market.localeCompare(b.market));
    const uniqueSnapshots = [...new Map(snapshots.map((snapshot, index) => [snapshot.snapshotId || index, snapshot])).values()];
    const shared = uniqueSnapshots.map(sharedDecision).filter(Boolean);
    const requests = shared.filter(decision => REQUEST_STATUSES.has(decision.status) || decision.inferenceAttempted === true);
    const knownApiCost = sum(requests, 'cost'), unknownApiCostRequests = requests.filter(decision => !finite(decision.cost)).length;
    const sharedInference = { requests: requests.length, requestsBasis: 'admitted_inference_attempts',
        knownNotSubmittedRequests: requests.filter(decision => decision.requestSubmitted === false).length,
        status: countBy(shared, 'status'), knownApiCost,
        unknownApiCostRequests, localComputeCost: null, totalAiCost: null, costCountedOnce: true,
        costAllocation: 'experiment_level_only', latencyMs: responseLatency(requests),
        waitingMs: percentiles(requests.map(decision => decision.latencyMs).filter(finite)),
        adaptiveTimeout: adaptiveTimeoutDiagnostics(uniqueSnapshots, config, now) };
    const coverage = opportunityCoverage(state), diagnostics = pipelineDiagnostics(state, snapshots, shared);
    const arms = {}, differences = {};
    for (const name of armNames) {
        const arm = state.arms?.[name] || {}, rows = [...completed[name].rows.values()];
        const decisions = snapshots.flatMap(snapshot => snapshot.decisions?.[name]
            ? [{ ...snapshot.decisions[name], inferenceAttempted: snapshot.inferenceAttempted === true
                || snapshot.decisions[name].inferenceAttempted === true }] : []);
        const cohortRows = cohort.map(row => ({ closedAt: row.closedAt, pnl: row.results[name].pnl }));
        const uncertainty = interval(cohortRows, minimumDays, minimumMarkets, bootstrapSamples, elapsedDays);
        const pnl = sum(rows, 'pnl'), cohortPnl = sum(cohortRows, 'pnl');
        const wins = rows.filter(row => row.pnl > 0), losses = rows.filter(row => row.pnl < 0);
        const outcomes = Object.values(arm.outcomes || {}), failed = outcomes.filter(row => row.reason === 'execution_expired');
        const reasons = [];
        if (rows.length < minimumMarkets) reasons.push('insufficient_completed_filled_markets');
        reasons.push(...uncertainty.reasons);
        if (pnl <= 0) reasons.push('nonpositive_trading_pnl');
        if (!uncertainty.ci95 || uncertainty.ci95.lower <= 0) reasons.push('uncertain_positive_expectancy');
        if (arm.position) reasons.push('unresolved_inventory');
        if (arm.stopped) reasons.push('research_drawdown_stop');
        if (completed[name].ambiguous.size) reasons.push('ambiguous_completions');
        const position = arm.position;
        arms[name] = { capital: config.capital || 20, cash: finite(arm.cash) ? arm.cash : null,
            completedFilled: rows.length, wins: wins.length, losses: losses.length,
            breakeven: rows.length - wins.length - losses.length, executionWinRate: rows.length ? round(wins.length / rows.length) : null,
            averageWin: wins.length ? round(sum(wins, 'pnl') / wins.length) : null,
            averageLoss: losses.length ? round(sum(losses, 'pnl') / losses.length) : null,
            tradingPnl: pnl, fees: sum(rows, 'fees'), gas: sum(rows, 'gas'), pnlIncludesFeesAndGas: true,
            netAfterAllAiCost: null, aiCostAllocation: 'experiment_level_only',
            cohortMarkets: cohort.length, cohortTradingPnl: cohortPnl,
            cohortFilledMarkets: cohort.filter(row => row.results[name].filled).length,
            cohortNoExposureMarkets: cohort.filter(row => !row.results[name].filled).length,
            settledPnlDrawdown: settledDrawdown(rows), intratradePaperDrawdown: finite(arm.drawdown) ? round(arm.drawdown) : null,
            risk: { pilotDrawdownLimit: config.shadowDrawdownStop ?? 2, researchDrawdownLimit: config.drawdownStop ?? 10,
                pilotBreach: arm.shadowStop || null, researchStop: arm.stopped || null, persistent: true },
            shadowPilotStop: arm.shadowStop || null, stopped: arm.stopped || null,
            activeInventory: position ? { slug: slugOf(position), status: position.status,
                shares: position.holdings ?? 0, pendingShares: position.status === 'matched' ? position.fill?.shares ?? 0
                    : position.status === 'pending' ? position.order?.shares ?? 0 : 0,
                entryCost: position.entryCost ?? null, mark: position.mark ?? null,
                markFresh: position.markFresh ?? null, markObservedAt: position.markObservedAt ?? null,
                markReceivedAt: position.markReceivedAt ?? null } : null,
            valuationKnown: arm.valuationKnown ?? !position,
            valuationAt: arm.valuationAt ?? null,
            partialFills: rows.filter(row => row.partial).length, noFill: outcomes.filter(row => row.reason === 'no_fill').length,
            executionFailures: failed.length, executionFailureReasons: countBy(failed, row => row.code || 'unknown'),
            executionOutcomeReasons: countBy(outcomes, row => row.code || row.reason || 'unknown'),
            capitalHours: sum(rows, 'capitalHours'), attempts: Object.keys(arm.seen || {}).length,
            executionLatencyMs: percentiles(rows.map(row => row.executionLatencyMs).filter(finite)),
            decisions: decisions.length, decisionStatus: countBy(decisions, 'status'),
            decisionReasons: countBy(decisions, row => row.reason || row.status),
            entryDispositions: countBy(decisions, row => row.entryDisposition || 'unrecorded'),
            latencyMs: responseLatency(decisions),
            signalQuality: signalQuality(snapshots, markets, snapshot => snapshot.decisions?.[name], config, now),
            uncertainty, tradingMeanCi95: uncertainty.ci95,
            researchEligibility: { eligible: reasons.length === 0, reasons, scope: 'paper_research_only' },
            liveDecision: 'paper_research_only', sufficientForLive: false };
        if (name !== baselineArm) {
            const deltaRows = cohort.map(row => ({ closedAt: row.closedAt, pnl: round(row.results[name].pnl - row.results[baselineArm].pnl) }));
            const deltaUncertainty = interval(deltaRows, minimumDays, minimumMarkets, bootstrapSamples, elapsedDays);
            differences[name] = { baseline: baselineArm, matchedMarkets: cohort.length, tradingDifference: sum(deltaRows, 'pnl'),
                meanDifference: cohort.length ? round(sum(deltaRows, 'pnl') / cohort.length) : null,
                includesSkipAndTimeout: true, uncertainty: deltaUncertainty, tradingMeanDifferenceCi95: deltaUncertainty.ci95 };
        }
    }
    const openInventoryArms = armNames.filter(name => state.arms?.[name]?.position);
    const limitations = ['paper_execution_simulation', 'ai_compute_cost_unknown', 'no_automatic_live_promotion'];
    if (elapsedDays < minimumDays) limitations.push('insufficient_elapsed_days');
    if (Object.values(arms).some(arm => arm.completedFilled < minimumMarkets)) limitations.push('insufficient_completed_filled_markets');
    if (dayCount(cohort) < minimumDays || cohort.length < minimumMarkets) limitations.push('insufficient_daily_bootstrap_sample');
    if (labelPending.length || pendingMarkets.length) limitations.push('unresolved_common_cohort_markets');
    if (!coverage.opportunitySkips.reasonsComplete) limitations.push('opportunity_skip_reasons_unavailable_or_incomplete');
    if (!diagnostics.executionQuality.available) limitations.push('same_batch_execution_markers_unavailable');
    return { id: state.id || config.id, generatedAt: new Date(now).toISOString(),
        startedAt: finite(startedAt) ? new Date(startedAt).toISOString() : null,
        deadline: finite(config.deadline) && config.deadline < 8640000000000000 ? new Date(config.deadline).toISOString() : null,
        frozenAt: state.frozenAt || null, elapsedDays: round(elapsedDays), elapsedHours: round(elapsedDays * 24),
        paperOnly: true, experimentType: 'independent_paper_arms', automaticPromotion: false, sufficientForLive: false,
        decision: Object.values(arms).some(arm => arm.stopped) ? 'perlu evaluasi risiko paper' : 'lanjut riset paper',
        minimumEvidence: { days: minimumDays, completedFilledPerArm: minimumMarkets, observedCohortDays: minimumDays },
        commonCohort: { markets: cohort.length, observedDays: dayCount(cohort), marketIds: cohort.map(row => row.market),
            officialLabelsPending: labelPending.length, unresolvedMarkets: pendingMarkets.length, pending: pendingMarkets,
            includesSkipAndTimeout: true, requiresOfficialPayout: true, unknownOutcomesCountedAsZero: false },
        officialLabelsPending: labelPending.length, arms, differences, sharedInference,
        aiDecisionQuality: signalQuality(snapshots, markets, snapshot => snapshot.sharedDecision || snapshot.decisions?.laya, config, now),
        bootstrapTimezone: 'Asia/Jakarta', openInventoryArms, finished: !!state.frozenAt && openInventoryArms.length === 0,
        lastHeartbeatAt: state.lastHeartbeatAt || null, snapshots: snapshots.length, errors: state.errors || {},
        ...coverage, ...diagnostics, limitations };
}

function markdown(report) {
    const money = value => value === null ? 'belum diketahui' : `$${value.toFixed(6)}`;
    const adaptive = report.sharedInference.adaptiveTimeout;
    return [`# Laya filter paper - ${report.id}`, '',
        `Diperbarui: ${report.generatedAt}. Lima arm paper independen; modal $20 per arm.`,
        `Durasi ${report.elapsedDays} hari; cohort bersama ${report.commonCohort.markets} market berlabel resmi.`, '',
        '| Arm | Filled | Win rate eksekusi | PnL setelah fee/gas | Delta vs Laya | DD settled | DD intratrade |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...Object.entries(report.arms).map(([name, arm]) => `| ${name} | ${arm.completedFilled} | ${arm.executionWinRate === null ? '-' : (arm.executionWinRate * 100).toFixed(1) + '%'} | ${money(arm.tradingPnl)} | ${name === 'laya' ? '-' : money(report.differences[name].tradingDifference)} | ${money(arm.settledPnlDrawdown)} | ${money(arm.intratradePaperDrawdown)} |`), '',
        `Label resmi tertunda: ${report.officialLabelsPending}; hasil arm belum lengkap: ${report.commonCohort.unresolvedMarkets}; inventory terbuka: ${report.openInventoryArms.join(', ') || 'tidak ada'}.`,
        `Inference bersama: ${report.sharedInference.requests} percobaan inference, ${report.sharedInference.knownNotSubmittedRequests} tercatat tanpa pengiriman HTTP; biaya API tercatat ${money(report.sharedInference.knownApiCost)} sekali pada tingkat eksperimen; biaya komputasi AI belum diketahui.`,
        `Latency respons selesai p50/p95: ${report.sharedInference.latencyMs.p50 ?? '-'} / ${report.sharedInference.latencyMs.p95 ?? '-'} ms; timeout: ${report.sharedInference.latencyMs.timeoutCount}.`,
        `Budget keputusan p50/p95: ${adaptive.decisionBudgetMs.available ? `${adaptive.decisionBudgetMs.p50} / ${adaptive.decisionBudgetMs.p95} ms` : 'belum tersedia untuk periode ini'}. Respons >${adaptive.referenceMs} ms: ${adaptive.acceptedOverReference ?? '-'} diterima sebelum deadline, ${adaptive.reservedOverReference ?? '-'} mereservasi minimal satu arm, ${adaptive.timedOutResponsesOverReference} selesai setelah timeout; ${adaptive.timeoutsWithoutResponse} timeout belum memiliki respons selesai. Dihitung sekali per inference.`,
        `Cakupan slot: ${report.slotCoverage.scheduled ?? '-'} tercatat, ${report.slotCoverage.observed ?? '-'} diamati, ${report.slotCoverage.no_valid_side ?? '-'} tanpa sisi valid, ${report.slotCoverage.invalid ?? '-'} invalid.`,
        `Alasan skip: ${report.opportunitySkips.reasonsComplete ? JSON.stringify(report.opportunitySkips.byReason) : 'belum tersedia lengkap untuk periode ini'}.`,
        `Sumber eksekusi bersama: ${report.executionQuality.available ? `${report.executionQuality.sameBatchSourceRecorded}/${report.executionQuality.comparableBatches} batch lintas arm memiliki penanda sumber bersama` : 'penanda belum tersedia untuk periode ini'}.`,
        `Kualitas keputusan AI: ${report.aiDecisionQuality.wins}/${report.aiDecisionQuality.independentMarkets} prediksi BUY pertama yang tepat waktu menang menurut payout resmi.`, '',
        `Kelayakan riset: minimal ${report.minimumEvidence.days} hari, ${report.minimumEvidence.completedFilledPerArm} filled per arm, PnL positif, dan batas bawah CI 95% bootstrap harian positif. CI tetap kosong bila hari/cohort belum cukup.`,
        ...Object.entries(report.arms).map(([name, arm]) => `- ${name}: ${arm.researchEligibility.eligible ? 'memenuhi kriteria statistik riset paper' : arm.researchEligibility.reasons.join(', ')}; breach $2: ${arm.risk.pilotBreach ? 'ya' : 'tidak'}; stop $10: ${arm.stopped ? 'ya' : 'tidak'}.`), '',
        'Hasil ini khusus riset paper. Biaya AI lengkap belum diketahui; tidak ada promosi atau perubahan live otomatis.', ''].join('\n');
}

export function saveFilterPaperReport(config, state, now = Date.now()) {
    if (!/^[a-zA-Z0-9_-]+$/.test(config.id || '') || state.id !== config.id) throw new Error('filter_paper_report_identity_mismatch');
    const report = summarizeFilterPaper(state, config, now), dir = path.join(config.dataDir, config.id, 'reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    atomicJson(path.join(dir, 'latest.json'), report);
    const filename = path.join(dir, 'latest.md');
    fs.writeFileSync(filename, markdown(report), { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    return report;
}

export function readFilterPaperReports(config, history = false) {
    const identityError = () => new Error('filter_paper_report_identity_mismatch');
    const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
    const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const dataDir = path.resolve(config.dataDir), activeFile = path.join(dataDir, 'active.json');
    const activeExists = fs.existsSync(activeFile), active = activeExists ? read(activeFile) : null;
    if (activeExists && (!active || !validId(active.id) || active.paperOnly !== true)) throw identityError();
    const readPeriod = (directory, id, archivedAt = null) => {
        if (typeof directory !== 'string' || !path.isAbsolute(directory) || !validId(id)) throw identityError();
        const periodDir = path.join(directory, id), manifest = read(path.join(periodDir, 'manifest.json'));
        if (manifest.id !== id || manifest.paperOnly !== true || !manifest.policy
            || typeof manifest.policy !== 'object' || Array.isArray(manifest.policy)) throw identityError();
        const ledgerFile = path.join(periodDir, 'ledger.json'), reportFile = path.join(periodDir, 'reports', 'latest.json');
        let report;
        if (fs.existsSync(ledgerFile)) {
            const state = read(ledgerFile);
            if (state.id !== id || !state.arms || typeof state.arms !== 'object' || Array.isArray(state.arms)) throw identityError();
            const policy = { ...manifest.policy, id, dataDir: directory };
            report = summarizeFilterPaper(state, policy);
        } else {
            report = read(reportFile);
            if (report.id !== id || report.paperOnly !== true) throw identityError();
        }
        return archivedAt === null ? report : { ...report, archivedAt };
    };
    const result = active ? readPeriod(dataDir, active.id)
        : { id: null, decision: 'belum_dimulai', paperOnly: true, automaticPromotion: false, sufficientForLive: false };
    if (history) {
        const historyFile = path.join(dataDir, 'history.json'), index = fs.existsSync(historyFile) ? read(historyFile) : { periods: [] };
        if (!index || !Array.isArray(index.periods)) throw identityError();
        const seen = new Set(active ? [`${dataDir}:${active.id}`] : []);
        result.history = index.periods.flatMap(period => {
            if (!period || !validId(period.id) || typeof period.dataDir !== 'string' || !path.isAbsolute(period.dataDir)
                || !['number', 'string'].includes(typeof period.archivedAt)
                || !finite(new Date(period.archivedAt).getTime())) throw identityError();
            const directory = path.resolve(period.dataDir), key = `${directory}:${period.id}`;
            if (seen.has(key)) return [];
            seen.add(key);
            return [readPeriod(directory, period.id, period.archivedAt)];
        }).sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    }
    return result;
}
