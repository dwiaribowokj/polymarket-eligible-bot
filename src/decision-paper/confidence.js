import { LABELS, PROBABILITY_SUM_TOLERANCE } from '../laya-tuning/protocol.js';

const MODELS = new Set(['typed-decisions', 'convaiinnovations/laya-typed-decisions', 'laya-typed-decisions']);
const EDGES = [0, .5, .6, .7, .8, .9, 1];
const finite = Number.isFinite;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rounded = value => Math.round(value * 1e6) / 1e6;
const probability = value => finite(value) && value >= 0 && value <= 1;
const near = (a, b) => Math.abs(a - b) <= .0001 + Number.EPSILON;

function allowedActions(snapshot) {
    let allowed;
    if (typeof snapshot.input === 'string') {
        try { allowed = JSON.parse(snapshot.input)?.allowed; } catch { return null; }
    } else allowed = snapshot.state?.allowed;
    return Array.isArray(allowed) && new Set(allowed).size === allowed.length
        && allowed.every(action => LABELS.includes(action)) ? allowed : null;
}

function responseRow(snapshot, decision, state, now) {
    const response = decision.lateResponse ?? decision;
    const timeout = ['decision_timeout', 'timeout'].includes(decision.status);
    const action = response.originalAction ?? response.action;
    if (!object(response) || !['ok', 'decision_timeout', 'timeout'].includes(response.status)
        || response.status !== 'ok' && !timeout || !MODELS.has(response.model)
        || !LABELS.includes(action) || response.reason === 'disallowed_action'
        || response.tokenUsageMatches === false || response.requestSubmitted === false
        || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || response.snapshotId !== snapshot.snapshotId
        || typeof snapshot.market !== 'string' || !snapshot.market || !finite(snapshot.at)
        || finite(state.startedAt) && snapshot.at < state.startedAt
        || response.inputHash != null && response.inputHash !== snapshot.inputHash
        || response.status === 'ok' && response.action !== action) return null;
    const allowed = allowedActions(snapshot);
    if (!allowed || action !== 'SKIP' && !allowed.includes(action)) return null;
    const probabilities = response.probabilities;
    if (!object(probabilities) || Object.keys(probabilities).length !== LABELS.length
        || !LABELS.every(label => Object.hasOwn(probabilities, label) && probability(probabilities[label]))
        || Math.abs(LABELS.reduce((sum, label) => sum + probabilities[label], 0) - 1)
            > PROBABILITY_SUM_TOLERANCE + Number.EPSILON * 4) return null;
    const selected = probabilities[action], maximum = Math.max(...LABELS.map(label => probabilities[label]));
    const answer = response.answerConfidence ?? response.answer_confidence
        ?? (response.confidenceSource === 'answer_confidence' ? response.confidence : null);
    const entropy = response.entropyConfidence ?? null;
    if (!probability(answer) || selected !== maximum || !near(answer, maximum)
        || entropy !== null && !probability(entropy)
        || response.confidence != null && !probability(response.confidence)) return null;
    const requestedAt = response.requestedAt ?? decision.requestedAt;
    const receivedAt = response.receivedAt ?? (decision.lateResponse && typeof response.at === 'string'
        ? Date.parse(response.at) : null);
    const deadline = response.decisionDeadlineAt ?? decision.decisionDeadlineAt
        ?? snapshot.decisionDeadlineAt ?? snapshot.timing?.decisionDeadlineAt;
    if (!finite(now) || !finite(requestedAt) || !finite(receivedAt) || !finite(deadline)
        || requestedAt < snapshot.at || receivedAt < requestedAt || receivedAt > now || deadline < requestedAt) return null;
    const late = !!decision.lateResponse || timeout || receivedAt > deadline || response.timely === false;
    const market = state.markets?.[snapshot.market], payout = market?.payout ?? market?.officialPayout;
    const labeled = market && finite(market.end) && market.end <= now
        && (market.labelResolvedAt === undefined || finite(market.labelResolvedAt)
            && market.labelResolvedAt >= market.end && market.labelResolvedAt <= now)
        && Array.isArray(payout) && payout.length === 2 && payout.every(probability)
        && Math.abs(payout[0] + payout[1] - 1) <= .00001
        && !(market.payout && market.officialPayout
            && JSON.stringify(market.payout) !== JSON.stringify(market.officialPayout));
    return { market: snapshot.market, snapshotId: snapshot.snapshotId, receivedAt, action, late,
        selectedActionProbability: selected, answerConfidence: answer, entropyConfidence: entropy,
        outcome: labeled && action !== 'SKIP' ? payout[action === 'BUY_UP' ? 0 : 1] : null,
        allowedBuyCount: allowed.filter(label => label !== 'SKIP').length };
}

function outcomeSummary(rows) {
    const labeled = rows.filter(row => row.outcome !== null), wins = labeled.filter(row => row.outcome === 1).length;
    const losses = labeled.filter(row => row.outcome === 0).length;
    return { independentMarkets: rows.length, buyResponses: rows.filter(row => row.action !== 'SKIP').length,
        skipResponses: rows.filter(row => row.action === 'SKIP').length,
        officiallyLabeledBuyResponses: labeled.length, wins, losses, neutral: labeled.length - wins - losses,
        winRate: wins + losses ? rounded(wins / (wins + losses)) : null };
}

function distribution(rows, key) {
    const values = rows.map(row => row[key]).filter(finite);
    return { samples: values.length, minimum: values.length ? Math.min(...values) : null,
        maximum: values.length ? Math.max(...values) : null,
        mean: values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null };
}

function bucketSummary(rows) {
    const buys = rows.filter(row => row.action !== 'SKIP');
    return { ...outcomeSummary(rows),
        metrics: Object.fromEntries(['selectedActionProbability', 'answerConfidence', 'entropyConfidence']
            .map(key => [key, distribution(rows, key)])),
        singleAllowedBuyResponses: rows.filter(row => row.allowedBuyCount === 1).length,
        bins: EDGES.slice(0, -1).map((lower, index) => {
            const upper = EDGES[index + 1], upperInclusive = upper === 1;
            const selected = rows.filter(row => row.selectedActionProbability >= lower
                && (upperInclusive ? row.selectedActionProbability <= upper : row.selectedActionProbability < upper));
            return { lower, upper, upperInclusive, ...outcomeSummary(selected) };
        }),
        thresholds: EDGES.slice(1, -1).map(threshold => {
            const selected = buys.filter(row => row.selectedActionProbability >= threshold);
            return { threshold, eligibleBuyResponses: buys.length,
                coverage: buys.length ? rounded(selected.length / buys.length) : null, ...outcomeSummary(selected) };
        }) };
}

function cohort(rows) {
    const selected = new Map();
    for (const row of [...rows].sort((a, b) => a.receivedAt - b.receivedAt
        || a.snapshotId.localeCompare(b.snapshotId))) if (!selected.has(row.market)) selected.set(row.market, row);
    const first = [...selected.values()];
    return { ...bucketSummary(first), validResponses: rows.length,
        duplicateMarketResponses: rows.length - first.length,
        bySide: Object.fromEntries(['BUY_UP', 'BUY_DOWN'].map(action =>
            [action, bucketSummary(first.filter(row => row.action === action))])) };
}

/** Observation only: fixed buckets never alter a decision, fill, or policy. */
export function summarizeLayaConfidence(state, now = Date.now()) {
    const snapshots = new Map((state.snapshots || []).map((snapshot, index) =>
        [snapshot.snapshotId ?? index, snapshot]));
    let candidateResponses = 0, rejectedResponses = 0;
    const rows = [];
    for (const snapshot of snapshots.values()) {
        const decision = snapshot.providerDecisions?.laya ?? snapshot.decisions?.laya ?? snapshot.sharedDecision;
        if (!object(decision) || !(decision.lateResponse || decision.probabilities)) continue;
        candidateResponses++;
        const row = responseRow(snapshot, decision, state, now);
        if (row) rows.push(row); else rejectedResponses++;
    }
    return { schema: 1, thresholdActive: false, changesTradingResults: false,
        selection: 'first_valid_response_received_per_market_within_each_timing_cohort',
        metricDefinitions: {
            selectedActionProbability: 'probability_mass_of_reported_action_not_market_win_probability',
            answerConfidence: 'maximum_action_choice_probability_not_market_win_probability',
            entropyConfidence: 'one_minus_normalized_shannon_entropy_not_calibrated_probability',
            binsAndThresholds: 'selected_action_probability_fixed_observational_boundaries',
            winRate: 'official_direction_wins_divided_by_wins_plus_losses_excludes_skip_neutral_unresolved',
            thresholdCoverage: 'retained_buy_responses_divided_by_all_buy_responses_in_cohort',
        },
        limitations: ['confidence_not_win_probability', 'selection_bias_allowed_side', 'direction_confounded',
            'small_sample_no_threshold_selected', 'late_responses_not_executable',
            'cohorts_can_select_different_snapshots_of_same_market', 'no_hypothetical_pnl_or_threshold_ranking'],
        input: { snapshots: snapshots.size, candidateResponses, rejectedResponses, validResponses: rows.length },
        cohorts: { timely: cohort(rows.filter(row => !row.late)), late: cohort(rows.filter(row => row.late)),
            allValid: cohort(rows) } };
}
