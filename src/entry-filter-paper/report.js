import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';
import { summarizeFilterPaper } from '../laya-filter-paper/report.js';
import { EARLY_BOOK_POLICY } from '../premarket-paper/early-book.js';
import { LIVE_COST_CAP_PROFILE, LIVE_TUNING_RECOVERY_PROFILE, isLiveTuningProfile } from './config.js';

const DAY = 86400000;
const WIB = 7 * 3600000;
const finite = Number.isFinite;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const identityError = () => new Error('entry_filter_paper_report_identity_mismatch');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sum = values => round(values.reduce((total, value) => total + value, 0));
const mean = values => values.length ? round(sum(values) / values.length) : null;
const validArms = names => Array.isArray(names) && names.length >= 2 && names.every(validId)
    && new Set(names).size === names.length;
const sameArms = (names, expected) => validArms(names) && names.length === expected.length
    && expected.every(name => names.includes(name));
const slugOf = row => row.slug || (typeof row.market === 'string' ? row.market : row.market?.slug);
const FILTER_REJECTIONS = new Set(['entry_cost_above_cap', 'entry_filter_direction_conflict',
    'entry_filter_insufficient_buffer', 'entry_filter_closing_direction_conflict', 'entry_filter_closing_insufficient_buffer',
    'entry_slot_not_selected', 'entry_ask_drop_above_limit']);
const FILTER_VETOES = new Set(['filter_veto', 'execution_filter_veto']);
const AVAILABILITY_REJECTIONS = new Set(['arm_stopped', 'arm_unavailable', 'closed', 'deadline', 'slot_ineligible']);
const counts = (rows, key) => Object.fromEntries(rows.reduce((result, row) => {
    const value = key(row) || 'unrecorded'; result.set(value, (result.get(value) || 0) + 1); return result;
}, new Map()));
const timestamp = value => {
    const at = typeof value === 'string' && value ? Date.parse(value) : value;
    return finite(at) && Math.abs(at) <= 8640000000000000 ? at : null;
};
const iso = at => at === null ? null : new Date(at).toISOString();
const duration = (at, until) => at === null ? null : Math.max(0, until - at);
const metric = values => {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
    return { samples: sorted.length, positiveSamples: sorted.filter(value => value > 0).length,
        p50: percentile(.5), p95: percentile(.95), maximum: sorted.at(-1) ?? null };
};
const isLiveTuning = config => isLiveTuningProfile(config.profile);
const entryTimestamp = row => ['entryAt', 'openedAt', 'submittedAt'].map(key => timestamp(row?.[key]))
    .find(at => at !== null) ?? null;
const uniqueSnapshots = state => [...new Map((state.snapshots || [])
    .map(row => [row.snapshotId || JSON.stringify(row), row])).values()];
const observedDays = dates => new Set(dates.filter(at => at !== null)
    .map(at => new Date(at + WIB).toISOString().slice(0, 10))).size;
const validPayout = row => {
    const payout = row?.payout ?? row?.officialPayout;
    return Array.isArray(payout) && payout.length === 2 && payout.every(value => finite(value) && value >= 0 && value <= 1)
        && Math.abs(payout[0] + payout[1] - 1) < .00001;
};

function validatePolicy(config) {
    if (!config.experiment?.startsWith('entry-filter-paper-') || config.inferencePolicy !== 'none'
        || !validArms(config.armNames) || !config.armNames.includes(config.baselineArm)) throw identityError();
}

function validateState(state, config) {
    validatePolicy(config);
    if (!validId(config.id) || state.id !== config.id || !state.arms
        || !sameArms(Object.keys(state.arms), config.armNames)) throw identityError();
    const attempted = decision => decision?.inferenceAttempted === true || decision?.requestSubmitted === true;
    if (Object.values(state.providers || {}).some(provider => provider?.pending
        || Object.keys(provider?.attempted || {}).length)
        || (state.snapshots || []).some(snapshot => snapshot.inferenceAttempted === true
            || Object.values(snapshot.inferenceAttempts || {}).some(Boolean)
            || attempted(snapshot.sharedDecision)
            || Object.values(snapshot.providerDecisions || {}).some(attempted)
            || Object.values(snapshot.decisions || {}).some(attempted)))
        throw new Error('entry_filter_paper_inference_evidence_invalid');
}

// Match the shared report's treatment of duplicate, ambiguous and unfilled completions.
function completedRows(arm) {
    const rows = new Map(), ambiguous = new Set();
    for (const row of arm.completed || []) {
        const slug = slugOf(row);
        if (!slug) continue;
        if (!finite(row.pnl) || row.uncertain || row.traded === false || finite(row.shares) && row.shares <= 0)
            ambiguous.add(slug);
        else if (rows.has(slug) && JSON.stringify(rows.get(slug)) !== JSON.stringify(row)) ambiguous.add(slug);
        else rows.set(slug, row);
    }
    for (const slug of ambiguous) rows.delete(slug);
    return rows;
}

function economics(rows, arm) {
    const costs = rows.filter(row => finite(row.entryCost) && row.entryCost >= 0
        && finite(row.gas) && row.gas >= 0 && finite(row.shares) && row.shares > 0);
    const completeFees = rows.every(row => finite(row.fees) && row.fees >= 0 && finite(row.gas) && row.gas >= 0);
    const entryCost = sum(costs.map(row => row.entryCost)), gas = sum(costs.map(row => row.gas));
    const shares = sum(costs.map(row => row.shares));
    const allIn = costs.map(row => (row.entryCost + row.gas) / row.shares);
    const breakEven = arm.averageWin > 0 && arm.averageLoss < 0
        ? -arm.averageLoss / (arm.averageWin - arm.averageLoss) : null;
    return { grossTradingPnl: completeFees ? round(arm.tradingPnl + arm.fees + arm.gas) : null,
        netTradingPnl: arm.tradingPnl, fees: completeFees ? arm.fees : null, gas: completeFees ? arm.gas : null,
        grossPnlBasis: 'settlement_payout_minus_entry_notional_before_fees_and_gas',
        netPnlBasis: 'settlement_payout_minus_entry_cost_including_fees_and_gas',
        averageNetWin: arm.averageWin, averageNetLoss: arm.averageLoss,
        realizedPayoffBreakEvenWinRate: breakEven === null ? null : round(breakEven),
        breakEvenWinRateBasis: 'absolute_average_net_loss_divided_by_average_net_win_plus_absolute_average_net_loss',
        observedEntryCosts: { fills: costs.length, missingFills: rows.length - costs.length,
            complete: costs.length === rows.length, meanAllInCostPerShare: mean(allIn),
            shareWeightedAllInCostPerShare: shares ? round((entryCost + gas) / shares) : null,
            minimumAllInCostPerShare: allIn.length ? round(Math.min(...allIn)) : null,
            maximumAllInCostPerShare: allIn.length ? round(Math.max(...allIn)) : null,
            basis: 'actual_entry_cost_including_fees_plus_gas_divided_by_actual_filled_shares',
            partialFillCaveat: 'fixed_gas_per_partial_fill_can_exceed_full_fill_admission_cost_cap' },
        calibratedWinProbability: null, expectedProfitValidated: false };
}

function missedOutcomes(state, report, completed, name, baselineArm) {
    const baseline = completed[baselineArm], candidate = completed[name];
    const result = { baseline: baselineArm, matchedMarkets: report.commonCohort.markets,
        baselineFilledMarkets: 0, bothFilledMarkets: 0, baselineOnlyFilledMarkets: 0,
        candidateOnlyFilledMarkets: 0, neitherFilledMarkets: 0,
        lossesAvoided: 0, winsMissed: 0, breakevenFillsOmitted: 0,
        lossAmountAvoided: 0, winAmountMissed: 0,
        filterVetoLossesAvoided: 0, filterVetoWinsMissed: 0,
        basis: 'officially_labeled_common_market_cohort_with_final_outcomes',
        interpretation: 'baseline_realized_fills_without_candidate_exposure_includes_filter_veto_skip_and_no_fill',
        hypotheticalFillsIncluded: false, unknownOutcomesCountedAsZero: false };
    for (const slug of report.commonCohort.marketIds) {
        const base = baseline.get(slug), selected = candidate.get(slug);
        if (base) result.baselineFilledMarkets++;
        if (base && selected) { result.bothFilledMarkets++; continue; }
        if (selected) { result.candidateOnlyFilledMarkets++; continue; }
        if (!base) { result.neitherFilledMarkets++; continue; }
        result.baselineOnlyFilledMarkets++;
        const filterVeto = FILTER_VETOES.has(state.arms[name].outcomes?.[slug]?.reason);
        if (base.pnl < 0) {
            result.lossesAvoided++; result.lossAmountAvoided -= base.pnl;
            if (filterVeto) result.filterVetoLossesAvoided++;
        } else if (base.pnl > 0) {
            result.winsMissed++; result.winAmountMissed += base.pnl;
            if (filterVeto) result.filterVetoWinsMissed++;
        } else result.breakevenFillsOmitted++;
    }
    result.lossAmountAvoided = round(result.lossAmountAvoided);
    result.winAmountMissed = round(result.winAmountMissed);
    return result;
}

function entryActivity(arm, completed, startedAt, evaluationAt) {
    const rows = [...completed.values()], position = arm.position;
    const openFilled = position && !position.uncertain && ['matched', 'filled'].includes(position.status)
        && (position.holdings > 0 || position.fill?.shares > 0) ? position : null;
    const filled = new Map(completed);
    if (openFilled && slugOf(openFilled)) filled.set(slugOf(openFilled), openFilled);
    const dated = (items, fields) => {
        const dates = items.map(row => fields.map(field => timestamp(row[field]))
            .find(at => at !== null && at <= evaluationAt && (startedAt === null || at >= startedAt)) ?? null);
        const known = dates.filter(at => at !== null);
        return { last: known.length ? Math.max(...known) : null, missing: dates.length - known.length };
    };
    const entries = dated([...filled.values()], ['entryAt', 'openedAt', 'submittedAt']);
    const fills = dated([...filled.values()], ['filledAt', 'matchedAt', 'executionAt']);
    const completions = dated(rows, ['completedAt', 'closedAt']);
    const excluded = new Set((arm.completed || []).filter(row => !completed.has(slugOf(row)))
        .map(row => slugOf(row) || JSON.stringify(row))).size;
    // An order submission is not a fill. Older ledgers with missing fill times cannot establish an idle duration.
    const incomplete = fills.missing > 0 || excluded > 0;
    const idleFrom = incomplete ? null : fills.last ?? startedAt;
    return { completedFilledMarkets: completed.size, observedFilledMarkets: filled.size,
        openFilledMarket: openFilled ? slugOf(openFilled) : null,
        lastEntryAt: iso(entries.last), lastFillAt: iso(fills.last), lastCompletedAt: iso(completions.last),
        entryTimestampMissingMarkets: entries.missing, fillTimestampMissingMarkets: fills.missing,
        completionTimestampMissingMarkets: completions.missing, excludedCompletionMarkets: excluded,
        timeSinceLastCompletedMs: completions.missing || excluded ? null : duration(completions.last, evaluationAt),
        timeWithoutTradeMs: duration(idleFrom, evaluationAt),
        timeWithoutTradeBasis: incomplete ? 'unknown_incomplete_fill_evidence'
            : fills.last !== null ? 'last_recorded_actual_fill' : startedAt !== null ? 'period_start_no_fills_recorded' : 'unknown_start_time',
        noFillsRecorded: filled.size === 0 && excluded === 0,
        latestTimestampsBasis: 'latest_known_recorded_timestamp_per_unique_filled_market',
        asOf: iso(evaluationAt) };
}

function verifiedRestEvidence(batch, snapshot, config) {
    const evidence = batch.evidence, at = batch.executionAt;
    const maxAge = Math.min(EARLY_BOOK_POLICY.maxVerificationAgeMs,
        config.dataAgeMs ?? EARLY_BOOK_POLICY.maxVerificationAgeMs,
        config.observationPolicy?.maxSourceAgeMs ?? EARLY_BOOK_POLICY.maxVerificationAgeMs);
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const fresh = value => integer(value) && integer(at) && value <= at && at - value <= maxAge;
    if (!(maxAge > 0) || !evidence || evidence.schema !== EARLY_BOOK_POLICY.schema || evidence.paperOnly !== true
        || evidence.authority !== 'fresh_rest_full_snapshot' || evidence.sourceTimestampMeaning !== 'exchange_book_timestamp'
        || !/^[a-f0-9]{64}$/.test(batch.bookHash) || evidence.booksHash !== batch.bookHash
        || !fresh(evidence.verifiedAt) || !fresh(evidence.metadataVerifiedAt)
        || !integer(evidence.startedAt) || evidence.startedAt > evidence.verifiedAt
        || evidence.metadataVerifiedAt > evidence.startedAt || !integer(evidence.deadlineAt)
        || evidence.verifiedAt > evidence.deadlineAt || evidence.verifiedAt - evidence.startedAt > EARLY_BOOK_POLICY.maxRoundTripMs
        || !Array.isArray(evidence.books) || evidence.books.length !== 2) return false;
    let identity, admission;
    try { identity = JSON.parse(evidence.metadataIdentity); admission = JSON.parse(snapshot.validation?.identity); }
    catch { return false; }
    if (!Array.isArray(identity) || identity.length !== 9 || !Array.isArray(admission) || admission.length !== 6
        || identity[7] !== false || identity[8] !== true
        || JSON.stringify(identity.slice(0, 4)) !== JSON.stringify(admission.slice(0, 4))
        || identity[4] !== admission[4]?.rate || identity[5] !== admission[4]?.exponent
        || identity[6] !== admission[4]?.takerOnly || admission[5] !== false
        || !Array.isArray(identity[1]) || identity[1].length !== 2 || identity[1][0] === identity[1][1]
        || !identity[1].every(token => typeof token === 'string' && token.length)
        || !Array.isArray(identity[3]) || identity[3].length !== 2) return false;
    const response = (proof, endpoint, token) => proof && proof.endpoint === `https://clob.polymarket.com/${endpoint}`
        && proof.tokenId === token && integer(proof.requestStartedAt) && proof.requestStartedAt >= evidence.startedAt
        && fresh(proof.receivedAt) && proof.receivedAt >= proof.requestStartedAt && proof.receivedAt <= evidence.verifiedAt
        && proof.roundTripMs === proof.receivedAt - proof.requestStartedAt
        && proof.roundTripMs <= EARLY_BOOK_POLICY.maxRoundTripMs && proof.deadlineAt === evidence.deadlineAt
        && proof.receivedAt <= proof.deadlineAt && proof.cachePolicy === 'no-store' && proof.cacheBust === true
        && proof.status === 200 && integer(proof.httpDateAt) && proof.httpDateAt <= proof.receivedAt + 1000
        && proof.receivedAt - proof.httpDateAt <= maxAge && [null, 0].includes(proof.httpAge)
        && [null, 'DYNAMIC', 'BYPASS', 'MISS', 'EXPIRED'].includes(proof.cacheStatus);
    return evidence.books.every((proof, index) => response(proof, 'book', identity[1][index])
        && response(proof.tickVerification, 'tick-size', identity[1][index])
        && fresh(proof.sourceTimestampMs) && proof.sourceTimestampMs > 0 && proof.sourceTimestampMs <= proof.receivedAt
        && String(proof.sourceTimestamp) === String(proof.sourceTimestampMs)
        && proof.sourceAgeMs === proof.receivedAt - proof.sourceTimestampMs && /^[a-f0-9]{40}$/.test(proof.sourceHash)
        && proof.tick === identity[3][index] && [.1, .01, .001, .0001].includes(proof.tick)
        && [.1, .01, .001, .0001].includes(proof.sourceTick) && proof.sourceTick >= proof.tick
        && Math.abs(proof.sourceTick / proof.tick - Math.round(proof.sourceTick / proof.tick)) <= 1e-8);
}

function executionQuality(state, config, quality) {
    const batches = [...new Map((state.snapshots || []).flatMap(snapshot => (snapshot.executionBatches || [])
        .map(batch => ({ batch, snapshot }))).map((row, index) => [row.batch.cohortId || `unidentified-${index}`, row])).values()];
    const rest = batches.filter(({ batch }) => batch.bookSource === 'rest');
    const result = { ...quality, restEvidenceVerification: { batches: rest.length, verifiedBatches: 0,
        unavailableOrInvalidBatches: 0, basis: 'recorded_response_tick_metadata_and_source_age_proof_with_matching_book_hash',
        fullBookDepthRevalidated: false } };
    const mismatched = new Set(quality.mismatchedArmSources || []), unverifiable = new Set(quality.unverifiableArmSources || []);
    for (const { batch, snapshot } of rest) {
        const valid = verifiedRestEvidence(batch, snapshot, config);
        result.restEvidenceVerification[valid ? 'verifiedBatches' : 'unavailableOrInvalidBatches']++;
        if (!(batch.armNames?.length > 1)) continue;
        if (valid && batch.cohortId) result.sameBatchSourceRecorded++;
        const rows = batch.armNames.map(name => {
            const arm = state.arms[name];
            return [arm?.position, ...(arm?.completed || []), ...Object.values(arm?.outcomes || {})]
                .filter(row => row?.executionCohortId === batch.cohortId);
        });
        if (rows.some(group => group.some(row => row.executionBookSource && row.executionBookSource !== 'rest'))) {
            mismatched.add(batch.cohortId); unverifiable.delete(batch.cohortId); continue;
        }
        if (valid && batch.cohortId && !mismatched.has(batch.cohortId)
            && rows.every(group => group.length && group.every(row => row.executionBookSource === 'rest'
                && row.executionBookHash === batch.bookHash && row.executionAt === batch.executionAt))) {
            unverifiable.delete(batch.cohortId); result.verifiedArmSources++;
        }
    }
    if (quality.available) {
        result.mismatchedArmSources = [...mismatched]; result.unverifiableArmSources = [...unverifiable];
    }
    return result;
}

function operationalSummary(state, config, report, completed, now) {
    const raw = state.snapshots || [];
    const snapshots = [...new Map(raw.map(row => [row.snapshotId || JSON.stringify(row), row])).values()];
    const slots = Object.values(state.slots || {});
    const evaluationAt = Math.min(now, timestamp(state.frozenAt) ?? now, timestamp(config.deadline) ?? now);
    const startedAt = timestamp(state.startedAt);
    const arms = Object.fromEntries(config.armNames.map(name => {
        const decisions = snapshots.flatMap(row => row.decisions?.[name] ? [{ ...row.decisions[name], market: slugOf(row) }] : []);
        const vetoes = decisions.filter(row => FILTER_VETOES.has(row.entryDisposition));
        const filterRejections = vetoes.filter(row => FILTER_REJECTIONS.has(row.filterReason));
        const dataVetoes = vetoes.filter(row => row.filterReason && !FILTER_REJECTIONS.has(row.filterReason));
        const unknownVetoes = vetoes.filter(row => !row.filterReason);
        const pipeline = decisions.filter(row => !FILTER_VETOES.has(row.entryDisposition)
            && !AVAILABILITY_REJECTIONS.has(row.entryDisposition)
            && (row.status && row.status !== 'ok' || row.entryDisposition
                && !['reserved', 'pending', 'matched', 'filled', 'no_buy_decision'].includes(row.entryDisposition)));
        const availability = decisions.filter(row => AVAILABILITY_REJECTIONS.has(row.entryDisposition));
        const details = (rows, reason) => ({ samples: rows.length,
            uniqueMarkets: new Set(rows.map(row => row.market).filter(Boolean)).size, byReason: counts(rows, reason) });
        return [name, { activity: entryActivity(state.arms[name], completed[name], startedAt, now),
            execution: { completedFilledMarkets: report.arms[name].completedFilled,
                noFillMarkets: report.arms[name].noFill, failedMarkets: report.arms[name].executionFailures,
                failureReasons: report.arms[name].executionFailureReasons,
                basis: 'deduplicated_completions_and_durable_final_outcomes_per_arm' },
            decisions: { samples: decisions.length, uniqueMarkets: new Set(decisions.map(row => row.market).filter(Boolean)).size,
                byDisposition: counts(decisions, row => row.entryDisposition),
                strategyFilterRejections: details(filterRejections, row => row.filterReason),
                dataOrIntegrityFilterVetoes: details(dataVetoes, row => row.filterReason),
                unclassifiedFilterVetoes: details(unknownVetoes, row => row.filterReason),
                pipelineFailures: details(pipeline, row => row.status && row.status !== 'ok' ? row.status : row.entryDisposition),
                availabilityRejections: details(availability, row => row.entryDisposition),
                basis: 'deduplicated_snapshot_decisions_not_fills_or_final_market_outcomes' } }];
    }));
    return { startedAt: iso(startedAt), evaluationAt: iso(evaluationAt), elapsedMs: duration(startedAt, evaluationAt),
        observationPolicy: config.observationPolicy ?? null,
        samples: { recordedRows: raw.length, uniqueSnapshots: snapshots.length, duplicateRows: raw.length - snapshots.length,
            uniqueObservedMarkets: new Set(snapshots.map(slugOf).filter(Boolean)).size,
            basis: 'snapshot_id_or_identical_row_when_id_missing' },
        slots: { available: state.slots !== undefined, byStatus: counts(slots, row => row.status),
            pipelineInvalid: { slots: slots.filter(row => row.status === 'invalid').length,
                byReason: counts(slots.filter(row => row.status === 'invalid'), row => row.reason) },
            eligibilityRejected: { slots: report.slotCoverage.no_valid_side,
                byReason: report.opportunitySkips.byReason, reasonsComplete: report.opportunitySkips.reasonsComplete,
                reasonCountsMayOverlapPerSlot: true },
            basis: 'one_durable_record_per_market_and_scheduled_slot_not_unique_markets' },
        contextReadiness: { samples: snapshots.length,
            closingByStatus: counts(snapshots, row => row.informed?.calculated?.closingTwap?.status),
            errorsByReason: counts(snapshots.filter(row => row.contextError), row => row.contextError),
            basis: 'recorded_snapshot_context_status_unrecorded_is_unknown' },
        observationSources: counts(snapshots, row => row.bookSource),
        observationValidationSources: counts(snapshots, row => row.validation?.source),
        executionSources: report.executionQuality.source,
        bookRecovery: state.bookRecovery ?? null, bookStream: state.bookStream ?? null,
        waitsMs: { observation: metric(snapshots.map(row => row.timing?.waitMs)) },
        errorsByStageAndReason: state.errors || {}, arms,
        interpretation: 'pipeline_and_context_failures_are_not_evidence_of_strategy_filter_rejection; sample_counts_are_not_market_counts' };
}

function commonEntryWindow(state, config, completed, now) {
    const startedAt = timestamp(state.startedAt), stopped = config.armNames.filter(name => state.arms[name].stopped);
    const stopTimes = stopped.map(name => timestamp(state.arms[name].stopped.at));
    const missingStopTime = stopTimes.some(at => at === null);
    const firstStopAt = stopTimes.length && !missingStopTime ? Math.min(...stopTimes) : null;
    const cutoff = missingStopTime ? null : Math.min(now, timestamp(state.frozenAt) ?? now,
        timestamp(config.deadline) ?? now, firstStopAt ?? now);
    const available = startedAt !== null && cutoff !== null && cutoff >= startedAt;
    const within = at => available && at !== null && at >= startedAt && at <= cutoff;
    const excludedCohort = new Map(), scopedArms = {}, included = {}, exclusions = {};
    const exclude = (slug, reason) => {
        if (!slug) return;
        if (!excludedCohort.has(slug)) excludedCohort.set(slug, new Set());
        excludedCohort.get(slug).add(reason);
    };
    for (const name of config.armNames) {
        const arm = state.arms[name], rows = [], excluded = {};
        for (const [slug, row] of completed[name]) {
            const at = entryTimestamp(row), closedAt = timestamp(row.completedAt ?? row.closedAt);
            const reason = !available ? 'window_unavailable' : at === null ? 'entry_time_unknown'
                : at < startedAt ? 'entry_before_start' : at > cutoff ? 'entry_after_cutoff'
                    : closedAt !== null && closedAt > now ? 'settlement_after_as_of' : null;
            if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; exclude(slug, reason); }
            else rows.push(row);
        }
        const invalid = new Set((arm.completed || []).map(slugOf).filter(slug => slug && !completed[name].has(slug)));
        if (invalid.size) excluded.ambiguous_or_unfilled_completion = invalid.size;
        for (const slug of invalid) exclude(slug, 'ambiguous_or_unfilled_completion');
        const position = arm.position && within(entryTimestamp(arm.position)) ? arm.position : null;
        if (arm.position && !position) exclude(slugOf(arm.position), 'inventory_entry_outside_or_unknown');
        included[name] = new Map(rows.map(row => [slugOf(row), row])); exclusions[name] = excluded;
        scopedArms[name] = { ...arm, completed: rows, position };
    }
    const observations = uniqueSnapshots(state).filter(row => within(timestamp(row.at)) && row.diagnosticOnly !== true
        && !(row.passiveCollection === true && Array.isArray(row.allowed) && row.allowed.length === 0));
    const snapshots = observations.filter(row => !excludedCohort.has(slugOf(row)));
    // Use the shared outcome validation, but never turn a later/unknown entry into a hypothetical zero fill.
    const scoped = summarizeFilterPaper({ ...state, startedAt, frozenAt: cutoff ?? now, arms: scopedArms, snapshots },
        { ...config, deadline: cutoff ?? now }, now);
    const firstObservation = new Map();
    for (const row of snapshots) {
        const slug = slugOf(row), at = timestamp(row.at);
        firstObservation.set(slug, Math.min(firstObservation.get(slug) ?? at, at));
    }
    const minimumDays = Math.max(7, config.minDays || 7, config.evaluationPolicy?.minObservedDays || 7);
    const minimumFills = Math.max(100, config.minMarkets || 100, config.evaluationPolicy?.minCompletedFillsPerArm || 100);
    const elapsedDays = available ? (cutoff - startedAt) / DAY : 0;
    const uncertainty = rows => {
        const days = observedDays(rows.map(row => row.at)), reasons = [];
        if (elapsedDays < minimumDays) reasons.push('insufficient_elapsed_days');
        if (days < minimumDays) reasons.push('insufficient_observed_days');
        if (rows.length < minimumFills) reasons.push('insufficient_cohort_markets');
        return { method: 'daily_cluster_bootstrap', timezone: 'Asia/Jakarta', dayBasis: 'first_in_window_observation',
            days, markets: rows.length, sufficient: reasons.length === 0, reasons,
            ci95: reasons.length ? null : dailyBootstrap(rows.map(row => ({ pnl: row.pnl, closedAt: row.at + WIB })),
                Math.max(100, Math.floor(config.bootstrapSamples || 2000))) };
    };
    const cohort = scoped.commonCohort.marketIds;
    const rowsFor = name => cohort.map(slug => ({ at: firstObservation.get(slug), pnl: included[name].get(slug)?.pnl ?? 0 }));
    const arms = Object.fromEntries(config.armNames.map(name => {
        const arm = scoped.arms[name], rows = [...included[name].values()], interval = uncertainty(rowsFor(name));
        const days = observedDays(rows.map(entryTimestamp));
        const cohortEntryDays = observedDays(cohort.flatMap(slug => included[name].has(slug)
            ? [entryTimestamp(included[name].get(slug))] : []));
        const reasons = [...interval.reasons];
        if (!available) reasons.push('common_entry_window_unavailable');
        if (rows.length < minimumFills) reasons.push('insufficient_completed_filled_markets');
        if (arm.cohortFilledMarkets < minimumFills) reasons.push('insufficient_common_cohort_filled_markets');
        if (days < minimumDays) reasons.push('insufficient_observed_entry_days');
        if (cohortEntryDays < minimumDays) reasons.push('insufficient_common_cohort_entry_days');
        if (arm.tradingPnl <= 0) reasons.push('nonpositive_trading_pnl');
        if (!interval.ci95 || interval.ci95.lower <= 0) reasons.push('uncertain_positive_expectancy');
        if (state.arms[name].position) {
            reasons.push('unresolved_inventory');
            if (entryTimestamp(state.arms[name].position) === null) reasons.push('incomplete_inventory_entry_timestamp');
        }
        if (state.arms[name].stopped) reasons.push('research_drawdown_stop');
        if (exclusions[name].entry_time_unknown) reasons.push('incomplete_entry_timestamps');
        if (exclusions[name].ambiguous_or_unfilled_completion) reasons.push('ambiguous_completions');
        if (scoped.commonCohort.unresolvedMarkets || scoped.commonCohort.officialLabelsPending)
            reasons.push('unresolved_common_cohort_markets');
        return [name, { completedFilled: rows.length, wins: arm.wins, losses: arm.losses, breakeven: arm.breakeven,
            tradingPnl: arm.tradingPnl, pnlIncludesFeesAndGas: true, observedEntryDays: days,
            observedCohortEntryDays: cohortEntryDays,
            cohortFilledMarkets: arm.cohortFilledMarkets, cohortNoExposureMarkets: arm.cohortNoExposureMarkets,
            cohortTradingPnl: arm.cohortTradingPnl, excludedCompletedMarkets: exclusions[name],
            openInventory: scopedArms[name].position ? slugOf(scopedArms[name].position) : null,
            uncertainty: interval, researchEligibility: { eligible: reasons.length === 0, reasons: [...new Set(reasons)],
                scope: 'paper_research_only', basis: 'common_entry_window' } }];
    }));
    const differences = Object.fromEntries(config.armNames.filter(name => name !== config.baselineArm).map(name => {
        const rows = cohort.map(slug => ({ at: firstObservation.get(slug),
            pnl: round((included[name].get(slug)?.pnl ?? 0) - (included[config.baselineArm].get(slug)?.pnl ?? 0)) }));
        const interval = uncertainty(rows);
        return [name, { baseline: config.baselineArm, matchedMarkets: cohort.length,
            tradingDifference: sum(rows.map(row => row.pnl)), meanDifference: mean(rows.map(row => row.pnl)),
            includesSkipAndNoFill: true, uncertainty: interval, tradingMeanDifferenceCi95: interval.ci95,
            outcomeTradeoff: { ...missedOutcomes(state, scoped, included, name, config.baselineArm),
                interpretation: 'descriptive_realized_baseline_outcomes_omitted_by_candidate_not_a_causal_filter_effect' } }];
    }));
    return { available, startedAt: iso(startedAt), entryCutoffAt: iso(cutoff), settlementAsOf: iso(now),
        cutoffReason: missingStopTime ? 'research_stop_time_unknown' : !available ? 'period_start_unavailable_or_invalid'
            : firstStopAt !== null && cutoff === firstStopAt ? 'earliest_arm_research_stop'
                : cutoff === now ? 'current_report_time' : 'period_freeze_or_deadline',
        firstResearchStopAt: iso(firstStopAt), elapsedDays: round(elapsedDays),
        entryTimeBasis: 'recorded_entryAt_openedAt_or_submittedAt_inclusive_start_and_cutoff',
        includesSettlementsAfterCutoff: true, diagnosticOnlySnapshotsExcluded: true,
        primaryComparison: true, allPeriodTotalsAreDescriptive: true,
        commonCohort: { ...scoped.commonCohort, includesSkipAndTimeout: undefined, includesSkipAndNoFill: true,
            observedDays: observedDays(cohort.map(slug => firstObservation.get(slug))),
            dayBasis: 'first_in_window_observation',
            excludedMarkets: [...excludedCohort].filter(([slug]) => observations.some(row => slugOf(row) === slug))
                .map(([market, reasons]) => ({ market, reasons: [...reasons] })) },
        minimumEvidence: { elapsedDays: minimumDays, observedEntryDaysPerArm: minimumDays,
            observedCohortDays: minimumDays, completedFilledPerArm: minimumFills }, arms, differences,
        interpretation: 'same_entry_time_window_with_eventual_recorded_settlements; marginal_fills_and_paired_policy_differences_are_descriptive_not_causal; stopped_arms_do_not_resume' };
}

function collectionSummary(state, config, now) {
    const snapshots = uniqueSnapshots(state), dated = snapshots.filter(row => timestamp(row.at) !== null && timestamp(row.at) <= now);
    const stops = config.armNames.map(name => timestamp(state.arms[name].stopped?.at)).filter(at => at !== null && at <= now);
    const firstStopAt = stops.length ? Math.min(...stops) : null;
    const allStoppedAt = stops.length === config.armNames.length ? Math.max(...stops) : null;
    const observed = new Set(dated.map(slugOf).filter(Boolean));
    const markets = [...observed].map(slug => state.markets?.[slug]).filter(Boolean);
    const labeled = markets.filter(validPayout), resolved = labeled.map(row => timestamp(row.labelResolvedAt))
        .filter(at => at !== null && at <= now);
    const latestSnapshot = dated.length ? Math.max(...dated.map(row => timestamp(row.at))) : null;
    const latestLabel = resolved.length ? Math.max(...resolved) : null;
    const postStop = dated.filter(row => firstStopAt !== null && timestamp(row.at) > firstStopAt);
    return { policy: config.passiveCollection ?? null, asOf: iso(now), firstResearchStopAt: iso(firstStopAt),
        allResearchStoppedAt: iso(allStoppedAt),
        snapshots: { unique: snapshots.length, diagnosticOnly: dated.filter(row => row.diagnosticOnly === true).length,
            afterFirstResearchStop: postStop.length,
            afterAllResearchStops: dated.filter(row => allStoppedAt !== null && timestamp(row.at) > allStoppedAt).length,
            unknownOrFutureTimestamp: snapshots.length - dated.length,
            lastAt: iso(latestSnapshot), ageMs: duration(latestSnapshot, now) },
        officialLabels: { observedMarkets: observed.size, labeledObservedMarkets: labeled.length,
            pendingEndedObservedMarkets: markets.filter(row => timestamp(row.end) !== null && timestamp(row.end) <= now && !validPayout(row)).length,
            resolvedAfterFirstResearchStop: resolved.filter(at => firstStopAt !== null && at > firstStopAt).length,
            postStopObservedMarketsLabeled: [...new Set(postStop.map(slugOf))].filter(slug => validPayout(state.markets?.[slug])).length,
            unknownOrFutureResolvedTimestamp: labeled.length - resolved.length,
            lastResolvedAt: iso(latestLabel), ageMs: duration(latestLabel, now) },
        tradingEvidenceAddedByPassiveCollection: false,
        interpretation: 'snapshot_and_official_label_freshness_only; passive_observations_are_not_fills_or_additional_active_trading_days' };
}

export function summarizeEntryFilterPaper(state, config, now = Date.now()) {
    validateState(state, config);
    const liveTuning = isLiveTuning(config);
    const report = summarizeFilterPaper(state, config, now);
    report.executionQuality = executionQuality(state, config, report.executionQuality);
    delete report.sharedInference; delete report.aiDecisionQuality; delete report.admission;
    delete report.commonCohort.includesSkipAndTimeout;
    report.commonCohort.includesSkipAndNoFill = true;
    const completed = Object.fromEntries(config.armNames.map(name => [name, completedRows(state.arms[name])]));
    for (const [name, arm] of Object.entries(report.arms)) {
        delete arm.latencyMs;
        arm.deterministicSignalQuality = arm.signalQuality; delete arm.signalQuality;
        Object.assign(arm, { knownApiCost: 0, unknownApiCostRequests: 0, totalAiCost: 0,
            netAfterAllAiCost: arm.tradingPnl, aiCostAllocation: 'no_inference', localComputeCost: null,
            economics: economics([...completed[name].values()], arm),
            riskEvidence: { research: state.arms[name].stopped?.evidence || null,
                pilot: state.arms[name].shadowStop?.evidence || null,
                maximum: state.arms[name].maxDrawdownEvidence || null } });
        if (name !== config.baselineArm) {
            delete report.differences[name].includesSkipAndTimeout;
            report.differences[name].includesSkipAndNoFill = true;
            report.differences[name].outcomeTradeoff = missedOutcomes(state, report, completed, name, config.baselineArm);
        }
    }
    report.limitations = report.limitations.filter(reason => reason !== 'ai_compute_cost_unknown');
    report.limitations.push('local_compute_cost_unknown', 'entry_cost_cap_is_not_positive_expected_value',
        ...(!liveTuning ? ['volatility_buffer_is_not_calibrated_win_probability'] : []),
        'partial_fills_can_raise_gas_cost_per_share',
        'simulation_fixed_share_fak_not_exact_live_spend_sizing',
        'virtual_arm_profits_must_not_be_summed');
    report.commonEntryWindow = commonEntryWindow(state, config, completed, now);
    report.collectionSummary = collectionSummary(state, config, now);
    report.comparisonBasis = 'common_entry_window';
    report.allPeriodTotalsBasis = 'descriptive_actual_ledgers_with_potentially_unequal_active_horizons';
    if ([LIVE_TUNING_RECOVERY_PROFILE, LIVE_COST_CAP_PROFILE].includes(config.profile)) for (const name of config.armNames)
        report.arms[name].researchEligibility = report.commonEntryWindow.arms[name].researchEligibility;
    report.limitations.push('all_period_arm_totals_may_have_unequal_active_horizons',
        'marginal_filter_selection_is_not_causal', 'independent_subsequent_holdout_required_before_live_review');
    report.operationalSummary = operationalSummary(state, config, report, completed, now);
    const startedAt = timestamp(state.startedAt), firstCheckpointAt = startedAt === null ? null : startedAt + DAY;
    const evaluationAt = timestamp(report.operationalSummary.evaluationAt);
    return Object.assign(report, { experiment: config.experiment, profile: config.profile ?? null,
        armNames: [...config.armNames], baselineArm: config.baselineArm,
        evaluationSchedule: { firstCheckpointAt: iso(firstCheckpointAt), firstCheckpointIsPreliminary: true,
            firstCheckpointReached: firstCheckpointAt !== null && evaluationAt >= firstCheckpointAt,
            minimumDurationAt: iso(startedAt === null ? null : startedAt + report.minimumEvidence.days * DAY),
            minimumCompletedFilledPerArm: report.minimumEvidence.completedFilledPerArm,
            minimumObservedEntryDaysPerArm: report.commonEntryWindow.minimumEvidence.observedEntryDaysPerArm,
            evidenceBasis: 'common_entry_window_excluding_passive_only_observations',
            independentHoldout: { required: true, status: 'not_evaluated_by_this_report',
                period: 'subsequent_independent_period_with_selected_parameters_frozen',
                minimumObservedDays: report.commonEntryWindow.minimumEvidence.observedEntryDaysPerArm,
                minimumCompletedFilledPerArm: report.commonEntryWindow.minimumEvidence.completedFilledPerArm,
                requiredBefore: 'manual_live_promotion_review' },
            parametersFrozen: true, automaticPromotion: false,
            interpretation: '24_hour_checkpoint_is_operational_only_statistical_review_requires_duration_fills_and_daily_bootstrap' },
        inferencePolicy: 'none', inference: { requests: 0, providerCalls: 0, knownApiCost: 0,
            unknownApiCostRequests: 0, totalAiCost: 0, localComputeCost: null,
            evidence: 'provider_free_engine_and_no_inference_attempts_in_ledger' },
        hypothesis: { preregistered: true, validatedProfitability: false,
            costCapPerShare: config.costCapPerShare, costCapBasis: 'full_fill_at_frozen_limit_including_fees_and_gas',
            armCostCaps: config.armCostCaps ?? null,
            entryFilter: liveTuning ? null : config.entryFilter, closingContextPolicy: config.closingContextPolicy ?? null,
            observationPolicy: config.observationPolicy ?? null,
            passiveCollection: config.passiveCollection ?? null, evaluationPolicy: config.evaluationPolicy ?? null,
            armPolicies: config.armPolicies ?? null, tuningPolicy: config.tuningPolicy ?? null,
            baselinePolicy: config.armPolicies?.[config.baselineArm] || config.baselineArm,
            modelIndependent: true, virtualArmProfitsAreAdditive: false,
            interpretation: config.profile === LIVE_COST_CAP_PROFILE
                ? 'separate_full_fill_all_in_cost_caps_compared_prospectively_on_independent_virtual_balances'
                : liveTuning
                ? 'fixed_cost_control_compared_with_separate_slot_and_execution_ask_drop_filters_on_independent_virtual_balances'
                : 'fixed_cost_and_volatility_filters_compared_prospectively_on_independent_virtual_balances' },
        executionQuality: { ...report.executionQuality, sameAdmissionAndExecutionBookRequired: true,
            interpretation: 'arms_reserved_together_share_admission_timestamp_and_immutable_execution_book' } });
}

function markdown(report) {
    const money = value => finite(value) ? `$${value.toFixed(6)}` : '-';
    const rate = value => finite(value) ? `${(value * 100).toFixed(2)}%` : '-';
    const age = value => finite(value) ? `${Math.floor(value / 86400000)} hari ${Math.floor(value / 3600000) % 24} jam ${Math.floor(value / 60000) % 60} menit` : 'belum diketahui';
    const breakdown = value => value === null ? 'belum tercatat' : Object.entries(value)
        .map(([reason, count]) => `${reason}: ${count}`).join('; ') || 'tidak ada';
    const operational = report.operationalSummary;
    const liveTuning = isLiveTuning(report), costComparison = report.profile === LIVE_COST_CAP_PROFILE;
    const window = report.commonEntryWindow, collection = report.collectionSummary;
    return [`# Entry filter paper - ${report.id}`, '', `Diperbarui: ${report.generatedAt}.`,
        `Mulai periode: ${operational.startedAt || 'belum tercatat'}; umur observasi ${age(operational.elapsedMs)} (sampai ${operational.evaluationAt}).`,
        `${report.armNames.length} ledger virtual terpisah; modal ${money(report.arms[report.baselineArm].capital)} per arm. Pembanding: ${report.baselineArm}. Profil: ${report.profile || 'entry-filter-standard'}.`,
        'Aturan deterministik tanpa model AI; nol request inference dan biaya AI $0. Biaya komputasi lokal belum diketahui.',
        costComparison
            ? `Hipotesis ditetapkan sebelum periode: batas biaya penuh per share pada limit entry, termasuk fee dan gas: ${report.armNames.map(name => `${name} maksimum ${money(report.hypothesis.armCostCaps?.[name])}`).join('; ')}.`
            : `Hipotesis ditetapkan sebelum periode: biaya penuh per share maksimum ${money(report.hypothesis.costCapPerShare)} pada limit entry, termasuk fee dan gas${liveTuning ? '.' : `; buffer volatilitas ${report.hypothesis.entryFilter?.minBufferSigma ?? '-'} sigma.`}`,
        ...(costComparison ? ['Dua arm membandingkan batas biaya dengan slot, modal awal, latensi, dan asumsi eksekusi yang sama. Arm yang masuk pada snapshot yang sama memakai book eksekusi bersama.']
            : liveTuning ? [`Tiga arm membandingkan Cost-cap kontrol, entry hanya pada slot sisa ${report.hypothesis.tuningPolicy?.selectedSlotSeconds ?? '-'} detik, dan penolakan terpisah bila ask eksekusi turun lebih dari ${money(report.hypothesis.tuningPolicy?.maxAskDropUsd)} dari ask snapshot awal.`] : []),
        costComparison ? 'Batas biaya adalah hipotesis yang diuji, bukan probabilitas menang. Profit antar arm tidak dijumlahkan.'
            : liveTuning ? 'Batas biaya, pemilihan slot, dan batas penurunan ask adalah hipotesis yang diuji, bukan probabilitas menang. Profit antar arm tidak dijumlahkan.'
            : 'Batas biaya bukan estimasi keuntungan, dan buffer bukan probabilitas menang. Profit antar arm tidak dijumlahkan.', '',
        ...(report.hypothesis.armPolicies ? Object.entries(report.hypothesis.armPolicies)
            .map(([name, policy]) => `- Kebijakan ${name}: ${typeof policy === 'string' ? policy : JSON.stringify(policy)}.`) : []),
        ...(report.hypothesis.tuningPolicy ? [`Aturan tuning yang dibekukan: ${JSON.stringify(report.hypothesis.tuningPolicy)}.`] : []),
        `Checkpoint awal: ${report.evaluationSchedule.firstCheckpointAt || 'menunggu waktu mulai'} (24 jam, evaluasi operasional awal; belum bukti kelulusan).`,
        `Evaluasi statistik paling cepat: ${report.evaluationSchedule.minimumDurationAt || 'menunggu waktu mulai'}, dengan sedikitnya ${report.evaluationSchedule.minimumCompletedFilledPerArm} market selesai terisi per arm dan CI bootstrap harian positif. Tidak mengubah live otomatis.`, '',
        ...(window ? [
            `Perbandingan utama: jendela entry bersama ${window.startedAt || 'belum diketahui'} sampai ${window.entryCutoffAt || 'belum diketahui'} (${window.cutoffReason}); settlement yang datang belakangan tetap dihitung sampai ${window.settlementAsOf}.`,
            'Entry dipilih berdasarkan waktu order yang tercatat, bukan waktu settlement. Entry setelah cutoff dan entry tanpa timestamp tidak dipakai; market dengan entry di luar jendela pada salah satu arm dikeluarkan dari cohort bersama.', '',
            '| Arm | Filled dalam jendela | W/L | PnL setelah fee/gas | Hari entry teramati | Delta cohort bersama |',
            '| --- | ---: | ---: | ---: | ---: | ---: |',
            ...Object.entries(window.arms).map(([name, arm]) => `| ${name} | ${arm.completedFilled} | ${arm.wins}/${arm.losses} | ${money(arm.tradingPnl)} | ${arm.observedEntryDays} | ${name === report.baselineArm ? '-' : money(window.differences[name].tradingDifference)} |`), '',
            `Cohort jendela bersama: ${window.commonCohort.markets} market berlabel resmi; ${window.commonCohort.observedDays} hari observasi; ${window.commonCohort.officialLabelsPending} label tertunda; ${window.commonCohort.unresolvedMarkets} hasil belum lengkap; ${window.commonCohort.excludedMarkets.length} market dikeluarkan karena waktu/bukti entry.`,
            `Syarat riset: sedikitnya ${window.minimumEvidence.elapsedDays} hari durasi aktif bersama, ${window.minimumEvidence.observedEntryDaysPerArm} hari entry teramati dan ${window.minimumEvidence.completedFilledPerArm} fills selesai per arm. Snapshot pasif tidak menambah bukti trading.`,
            'Setelah pemilihan parameter, wajib holdout periode berikut yang independen dengan parameter dibekukan, sedikitnya 7 hari teramati dan 100 fills per arm sebelum review promosi live. Holdout belum dievaluasi oleh laporan ini.',
            'Selisih PnL dan hasil baseline yang tidak diikuti kandidat bersifat deskriptif; seleksi marginal bukan bukti efek kausal filter.', '',
        ] : []),
        '| Arm | Entry terakhir (order) | Fill terakhir | Selesai terakhir | Waktu tanpa fill baru |',
        '| --- | --- | --- | --- | --- |',
        ...Object.entries(operational.arms).map(([name, row]) => {
            const activity = row.activity;
            return `| ${name} | ${activity.lastEntryAt || '-'} | ${activity.lastFillAt || '-'} | ${activity.lastCompletedAt || '-'} | ${age(activity.timeWithoutTradeMs)}${activity.noFillsRecorded ? ' sejak awal periode' : ''} |`;
        }), '',
        'Waktu tanpa fill dihitung dari eksekusi aktual terakhir, atau awal periode bila belum ada fill tercatat. Timestamp yang hilang tetap belum diketahui; pengiriman order tidak dianggap fill. Posisi yang sudah matched/filled ikut aktivitas, sedangkan order pending belum termasuk.', '',
        'Simulasi FAK memakai target share tetap; FAK live berbasis nilai belanja dapat memperoleh lebih banyak share saat harga membaik, sehingga PnL paper dan hasil live historis tidak dapat diterapkan langsung satu sama lain atau membuktikan keuntungan live.', '',
        'Total ledger seluruh periode berikut bersifat deskriptif: durasi aktif antar arm dapat berbeda karena stop riset. Gunakan jendela entry bersama untuk membandingkan strategi.', '',
        `| Arm | Filled | W/L | PnL sebelum fee/gas | PnL setelah fee/gas | Delta vs ${report.baselineArm} | Break-even payoff | Biaya aktual/share | DD intratrade |`,
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...Object.entries(report.arms).map(([name, arm]) => `| ${name} | ${arm.completedFilled} | ${arm.wins}/${arm.losses} | ${money(arm.economics.grossTradingPnl)} | ${money(arm.tradingPnl)} | ${name === report.baselineArm ? '-' : money(report.differences[name].tradingDifference)} | ${rate(arm.economics.realizedPayoffBreakEvenWinRate)} | ${money(arm.economics.observedEntryCosts.meanAllInCostPerShare)} | ${money(arm.intratradePaperDrawdown)} |`), '',
        'Break-even payoff memakai rata-rata net win dan net loss yang terealisasi; kosong sebelum keduanya tersedia. Biaya aktual/share memakai filled shares; partial fill dapat menaikkan gas/share melewati batas admission full-fill.', '',
        ...Object.entries(report.arms).map(([name, arm]) => `- ${name}: rata-rata net win ${money(arm.averageWin)}; rata-rata net loss ${money(arm.averageLoss)}.`), '',
        '| Arm | Loss baseline tanpa fill kandidat | Win baseline tanpa fill kandidat | Loss dengan veto filter | Win dengan veto filter |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...Object.entries(report.differences).map(([name, difference]) => {
            const t = difference.outcomeTradeoff;
            return `| ${name} | ${t.lossesAvoided} | ${t.winsMissed} | ${t.filterVetoLossesAvoided} | ${t.filterVetoWinsMissed} |`;
        }), '',
        `Perbandingan memakai ${report.commonCohort.markets} market bersama berlabel resmi, termasuk skip/no-fill final. Label tertunda: ${report.officialLabelsPending}; hasil belum lengkap: ${report.commonCohort.unresolvedMarkets}.`,
        'Loss/win yang tidak diikuti kandidat adalah hasil baseline aktual pada market yang sama; bukan fill hipotetis. Veto filter dilaporkan terpisah dari alasan tanpa fill lainnya.',
        `Cakupan slot: ${report.slotCoverage.observed ?? '-'}/${report.slotCoverage.scheduled ?? '-'} diamati; ${report.slotCoverage.invalid ?? '-'} invalid; ${report.slotCoverage.no_valid_side ?? '-'} tanpa sisi valid.`,
        `Sampel observasi: ${operational.samples.uniqueSnapshots} snapshot unik dari ${operational.samples.recordedRows} baris (${operational.samples.duplicateRows} duplikat), pada ${operational.samples.uniqueObservedMarkets} market unik. Slot dan sampel tidak sama dengan jumlah market.`,
        ...(collection ? [
            `Pengumpulan data: snapshot terakhir ${collection.snapshots.lastAt || 'belum diketahui'} (umur ${age(collection.snapshots.ageMs)}); ${collection.snapshots.afterFirstResearchStop} snapshot setelah stop arm pertama, ${collection.snapshots.afterAllResearchStops} setelah semua arm stop, ${collection.snapshots.diagnosticOnly} diagnostik saja.`,
            `Label resmi: ${collection.officialLabels.labeledObservedMarkets}/${collection.officialLabels.observedMarkets} market teramati berlabel; ${collection.officialLabels.pendingEndedObservedMarkets} market selesai menunggu label; resolusi terakhir ${collection.officialLabels.lastResolvedAt || 'belum diketahui'} (umur ${age(collection.officialLabels.ageMs)}). Pengumpulan pasif tidak dianggap fill atau hari trading aktif.`,
        ] : []),
        `Status slot: ${breakdown(operational.slots.byStatus)}.`,
        `Kegagalan pipeline/data pada slot invalid: ${breakdown(operational.slots.pipelineInvalid.byReason)}.`,
        `Penolakan kelayakan sisi: ${breakdown(operational.slots.eligibilityRejected.byReason)}; alasan ${operational.slots.eligibilityRejected.reasonsComplete ? 'lengkap' : 'belum lengkap'}.`,
        `Kesiapan konteks closing: ${breakdown(operational.contextReadiness.closingByStatus)}; error konteks: ${breakdown(operational.contextReadiness.errorsByReason)}.`,
        `Sumber book observasi: ${breakdown(operational.observationSources)}; sumber book eksekusi: ${breakdown(operational.executionSources)}.`,
        `Sumber validasi observasi: ${breakdown(operational.observationValidationSources)}; kebijakan observasi tersimpan: ${operational.observationPolicy?.version || 'belum tercatat'}.`,
        `Pemulihan REST: ${operational.bookRecovery ? `${operational.bookRecovery.restAttempts ?? '-'} percobaan, ${operational.bookRecovery.restSuccesses ?? '-'} berhasil, ${operational.bookRecovery.restFailures ?? '-'} gagal; tahap terakhir ${operational.bookRecovery.lastStage || '-'}; alasan terakhir ${operational.bookRecovery.lastFailure || 'tidak ada'}` : 'belum tercatat'}.`,
        `Waktu tunggu observasi: ${operational.waitsMs.observation.samples} sampel, p50 ${operational.waitsMs.observation.p50 ?? '-'} ms, p95 ${operational.waitsMs.observation.p95 ?? '-'} ms.`,
        `Error proses tercatat: ${breakdown(operational.errorsByStageAndReason)}.`, '',
        '| Arm | Sampel keputusan | Ditolak filter strategi | Veto data/konteks/integritas | Alasan veto belum tercatat | Gagal pipeline keputusan | Arm tidak tersedia |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...Object.entries(operational.arms).map(([name, row]) => {
            const decision = row.decisions;
            return `| ${name} | ${decision.samples} | ${decision.strategyFilterRejections.samples} | ${decision.dataOrIntegrityFilterVetoes.samples} | ${decision.unclassifiedFilterVetoes.samples} | ${decision.pipelineFailures.samples} | ${decision.availabilityRejections.samples} |`;
        }), '',
        ...Object.entries(operational.arms).map(([name, row]) => `- ${name}: filter strategi ${breakdown(row.decisions.strategyFilterRejections.byReason)}; data/konteks/integritas ${breakdown(row.decisions.dataOrIntegrityFilterVetoes.byReason)}; pipeline keputusan ${breakdown(row.decisions.pipelineFailures.byReason)}. Eksekusi final: ${row.execution.noFillMarkets} market tanpa fill, ${row.execution.failedMarkets} market gagal (${breakdown(row.execution.failureReasons)}).`), '',
        'Kegagalan pipeline atau konteks bukan bukti bahwa strategi menolak kondisi pasar. Angka tabel adalah sampel keputusan, dapat berulang pada market yang sama, dan tidak dijumlahkan menjadi jumlah trade.',
        `Verifikasi book eksekusi sama: ${report.executionQuality.verifiedArmSources ?? '-'}/${report.executionQuality.comparableBatches ?? '-'} batch bersama; mismatch ${report.executionQuality.mismatchedArmSources?.length ?? '-'}; belum terverifikasi ${report.executionQuality.unverifiableArmSources?.length ?? '-'}.`,
        `Bukti sumber REST eksekusi: ${report.executionQuality.restEvidenceVerification.verifiedBatches}/${report.executionQuality.restEvidenceVerification.batches} batch memenuhi pemeriksaan bukti tersimpan (hash, metadata, respons, tick, dan umur sumber); isi depth penuh tidak disimpan untuk validasi ulang laporan.`,
        `Minimum bukti: ${report.minimumEvidence.days} hari, ${report.minimumEvidence.observedCohortDays} hari cohort, ${report.minimumEvidence.completedFilledPerArm} fills per arm. CI bootstrap harian tetap kosong sebelum cukup bukti.`,
        ...Object.entries(report.arms).map(([name, arm]) => `- ${name}: ${arm.researchEligibility.reasons.join(', ') || 'memenuhi kriteria statistik riset paper'}; breach pilot ${arm.risk.pilotBreach ? 'ya' : 'tidak'}; stop riset ${arm.stopped ? 'ya' : 'tidak'}.`), '',
        'Khusus riset paper. Hipotesis belum terbukti menguntungkan; tidak ada promosi live otomatis.', ''].join('\n');
}

export function saveEntryFilterPaperReport(config, state, now = Date.now()) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const report = summarizeEntryFilterPaper(state, config, now), dir = path.join(config.dataDir, config.id, 'reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
    atomicJson(path.join(dir, 'latest.json'), report);
    const filename = path.join(dir, 'latest.md');
    fs.writeFileSync(filename, markdown(report), { mode: 0o600 }); fs.chmodSync(filename, 0o600);
    if (isLiveTuning(config) && report.evaluationSchedule.firstCheckpointReached) {
        const checkpointFile = path.join(dir, 'checkpoint-24h.json');
        if (!fs.existsSync(checkpointFile)) atomicJson(checkpointFile, report);
        const checkpoint = read(checkpointFile), checkpointMarkdown = path.join(dir, 'checkpoint-24h.md');
        if (!fs.existsSync(checkpointMarkdown))
            fs.writeFileSync(checkpointMarkdown, markdown(checkpoint), { mode: 0o600, flag: 'wx' });
    }
    return report;
}

export function readEntryFilterPaperReports(config, history = false) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const dataDir = path.resolve(config.dataDir), activeFile = path.join(dataDir, 'active.json');
    const active = fs.existsSync(activeFile) ? read(activeFile) : null;
    if (fs.existsSync(activeFile) && (!validId(active?.id) || active.paperOnly !== true)) throw identityError();
    const readPeriod = (directory, id, archivedAt = null) => {
        if (!path.isAbsolute(directory) || !validId(id)) throw identityError();
        const dir = path.join(directory, id), manifest = read(path.join(dir, 'manifest.json'));
        if (manifest.id !== id || manifest.paperOnly !== true || !manifest.policy) throw identityError();
        const policy = { ...manifest.policy, id, dataDir: directory };
        validatePolicy(policy);
        const ledgerFile = path.join(dir, 'ledger.json');
        const report = fs.existsSync(ledgerFile) ? summarizeEntryFilterPaper(read(ledgerFile), policy,
            archivedAt === null ? Date.now() : new Date(archivedAt).getTime())
            : read(path.join(dir, 'reports', 'latest.json'));
        if (report.id !== id || report.paperOnly !== true || report.experiment !== policy.experiment
            || report.baselineArm !== policy.baselineArm || report.inferencePolicy !== 'none'
            || !sameArms(Object.keys(report.arms || {}), policy.armNames)) throw identityError();
        return { ...report, periodPolicy: { schema: policy.schema ?? null, experiment: policy.experiment,
            profile: policy.profile ?? null, armPolicies: policy.armPolicies ?? null,
            tuningPolicy: policy.tuningPolicy ?? null,
            passiveCollection: policy.passiveCollection ?? null, evaluationPolicy: policy.evaluationPolicy ?? null,
            armNames: [...policy.armNames], baselineArm: policy.baselineArm, inferencePolicy: policy.inferencePolicy,
            costCapPerShare: policy.costCapPerShare, armCostCaps: policy.armCostCaps ?? null, entryFilter: policy.entryFilter,
            closingContextPolicy: policy.closingContextPolicy ?? null,
            observationPolicy: policy.observationPolicy ?? null,
            executionPolicy: policy.executionPolicy ?? null }, ...(archivedAt === null ? {} : { archivedAt }) };
    };
    const result = active ? readPeriod(dataDir, active.id)
        : { id: null, decision: 'belum_dimulai', paperOnly: true, automaticPromotion: false, sufficientForLive: false };
    if (history) {
        const file = path.join(dataDir, 'history.json'), index = fs.existsSync(file) ? read(file) : { periods: [] };
        if (!Array.isArray(index?.periods)) throw identityError();
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
