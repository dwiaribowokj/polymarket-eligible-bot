import { createHash } from 'node:crypto';
import { fee, round } from '../restart/math.js';

export const DECISION_CONTEXT_VERSION = 'decision-paper-context-v1';
export const INFORMED_PROMPT = 'BTC 5m: closing 60s Chainlink TWAP vs opening. Prices/limits/deltas=cents; delta=[spot,TWAP]; bars=30s OHLC oldest-first offsets from open_usd; sizes=shares; ret=millibps(5/15/30/60/180s); sigma=milliUSD/sqrt(s). Books=[bids,asks]; mirror_up swaps Up sides at 100-price. allowed is execution eligibility, not a recommendation. cost_break_even_up_down=[all-in USD,cost/shares], including fees and gas; not a predicted win probability. close60 gives known/remaining seconds, observed mean and required remaining average threshold: Up >threshold, Down <threshold; ties follow market rules. null is unavailable. BUY only if allowed and positive value after costs; else SKIP. SKIP always available. Confidence/probabilities are not win probabilities.';
export const INFORMED_QUESTIONS = Object.freeze({ action: Object.freeze({ type: 'choice', instructions: INFORMED_PROMPT,
    criteria: Object.freeze({ BUY_UP: 'Up if allowed.', BUY_DOWN: 'Down if allowed.', SKIP: 'No entry.' }) }) });
const hash = value => createHash('sha256').update(value).digest('hex');
export const INFORMED_PROMPT_SHA256 = hash(INFORMED_PROMPT);
export const INFORMED_QUESTIONS_SHA256 = hash(JSON.stringify(INFORMED_QUESTIONS));
const INPUT_KEYS = new Set(['seconds', 'open_usd', 'delta_cents', 'margin_cents', 'sigma_milliusd',
    'ret_millibps', 'bars_cents', 'up', 'down', 'fee', 'shares', 'cap_usd', 'limit_cost_up_down', 'allowed']);
const ACTIONS = ['BUY_UP', 'BUY_DOWN'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isFinite(value) && value > 0;
const fail = reason => { throw new Error(reason); };
function frozen(value) {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) frozen(item);
        Object.freeze(value);
    }
    return value;
}

function costs(input, snapshot, market, config) {
    const gasUsd = config.gasUsd ?? config.paperGasUsd ?? config.control?.paperGasUsd;
    if (!positive(input.shares) || !Array.isArray(input.fee) || input.fee.length !== 2
        || !input.fee.every(value => Number.isFinite(value) && value >= 0)
        || !Number.isFinite(gasUsd) || gasUsd < 0 || config.shares !== undefined && config.shares !== input.shares
        || market.fee?.rate !== input.fee[0] || market.fee?.exponent !== input.fee[1]
        || !Array.isArray(input.limit_cost_up_down) || input.limit_cost_up_down.length !== 2)
        fail('decision_cost_inputs_invalid');
    const schedule = { rate: input.fee[0], exponent: input.fee[1] };
    return ACTIONS.map((action, index) => {
        if (!input.allowed.includes(action)) return null;
        const limit = input.limit_cost_up_down[index];
        if (!Array.isArray(limit) || limit.length !== 2 || !positive(limit[0]) || limit[0] >= 100 || !positive(limit[1]))
            fail('decision_allowed_cost_missing');
        const limitPriceUsd = limit[0] / 100, shares = input.shares;
        const notionalUsd = round(shares * limitPriceUsd), feeUsd = fee(shares, limitPriceUsd, schedule);
        const allInCostUsd = round(shares * limitPriceUsd + feeUsd + gasUsd);
        if (Math.abs(allInCostUsd - limit[1]) > 0.000001) fail('decision_snapshot_cost_mismatch');
        if (snapshot.allowed !== undefined) {
            const orders = snapshot.allowed.filter(order => order.index === index), order = orders[0];
            if (orders.length !== 1 || order.shares !== shares || !Number.isFinite(order.price) || Math.abs(order.price - limitPriceUsd) > 1e-9
                || !Number.isFinite(order.cost) || Math.abs(order.cost - allInCostUsd) > 0.000001)
                fail('decision_snapshot_order_mismatch');
        }
        return { action, shares, limitPriceUsd, notionalUsd, feeUsd, gasUsd, allInCostUsd,
            breakEvenProbability: allInCostUsd / shares, costBasis: 'full_fill_at_frozen_limit', payoutPerWinningShareUsd: 1 };
    });
}

function closingTwap(snapshot, input, market, btc, config) {
    const at = snapshot.at, windowStart = market.end - 60000, windowEnd = market.end;
    const base = { windowStart, windowEnd, snapshotAt: at, asOf: null, referenceUsd: null,
        knownSeconds: 0, remainingSeconds: Math.min(60, (windowEnd - at) / 1000), observedIntegralUsdSeconds: null, observedMeanUsd: null,
        requiredRemainingAverageUsd: null, upComparator: '>', downComparator: '<', tieRule: 'market_rules',
        method: 'piecewise_constant_source_observations', status: null };
    const reject = status => ({ ...base, status });
    const reference = market.reference;
    if (!reference || reference.source !== 'chainlink_twap_60s' || reference.open !== market.open
        || reference.end !== market.end || reference.observedAt !== market.open || !positive(reference.value)
        || !Number.isFinite(reference.receivedAt) || reference.receivedAt < reference.observedAt || reference.receivedAt > at
        || !positive(input.open_usd) || Math.abs(reference.value - input.open_usd) > 0.005001)
        return reject('reference_unverified');
    const opening = btc?.openings?.get?.(market.open);
    if (opening && (opening.at !== market.open || opening.value !== reference.value || !Number.isFinite(opening.receivedAt)
        || opening.receivedAt < market.open || opening.receivedAt > at)) return reject('reference_unverified');
    base.referenceUsd = reference.value;
    if (at <= windowStart) return reject('before_window');
    const maxGapMs = btc?.rule?.maxGapMs ?? config.control?.lateSignal?.maxGapMs ?? 5000;
    const maxAgeMs = config.dataAgeMs ?? btc?.rule?.maxAgeMs ?? 5000;
    if (!positive(maxGapMs) || !positive(maxAgeMs)) fail('decision_history_limits_invalid');
    // Receipt time is as important as source time: late historical arrivals cannot change a frozen decision.
    const points = (Array.isArray(btc?.spot) ? btc.spot : []).filter(point => point && positive(point.value)
        && Number.isFinite(point.at) && Number.isFinite(point.receivedAt) && point.at <= at
        && point.receivedAt >= point.at && point.receivedAt <= at)
        .sort((a, b) => a.at - b.at || a.receivedAt - b.receivedAt);
    const latest = points.at(-1);
    if (!latest || latest.at <= windowStart) return reject('history_missing');
    base.asOf = latest.at; base.remainingSeconds = (windowEnd - latest.at) / 1000;
    if (at - latest.at > maxAgeMs) return reject('history_stale');
    const first = points.findLast(point => point.at <= windowStart);
    if (!first || windowStart - first.at > maxGapMs) return reject('history_missing');
    const relevant = points.filter(point => point.at >= first.at);
    let previous = first, cursor = windowStart, integral = 0;
    for (const point of relevant) {
        if (point.at === previous.at && point.value !== previous.value) return reject('history_conflict');
        if (point.at <= windowStart) continue;
        if (point.at - previous.at > maxGapMs) return reject('history_gap');
        integral += previous.value * (point.at - cursor) / 1000;
        previous = point; cursor = point.at;
    }
    const knownSeconds = (latest.at - windowStart) / 1000, remainingSeconds = 60 - knownSeconds;
    return { ...base, status: 'observed', knownSeconds, remainingSeconds,
        observedIntegralUsdSeconds: integral, observedMeanUsd: integral / knownSeconds,
        requiredRemainingAverageUsd: (reference.value * 60 - integral) / remainingSeconds };
}

/** Preserve baseline bytes; enrich only with arithmetic using information received by snapshot.at. */
export function buildDecisionContext(snapshot, market, btc, config, now = snapshot?.at) {
    if (!object(snapshot) || typeof snapshot.input !== 'string' || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId
        || !Number.isFinite(snapshot.at) || !Number.isFinite(now) || now < snapshot.at
        || !object(market) || !Number.isFinite(market.open) || !Number.isFinite(market.end)
        || market.end - market.open !== 300000 || snapshot.at < market.open || snapshot.at >= market.end
        || snapshot.market !== undefined && snapshot.market !== market.slug
        || snapshot.marketEnd !== undefined && snapshot.marketEnd !== market.end
        || snapshot.observedAt !== undefined && (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > snapshot.at)
        || !object(config) || snapshot.allowed !== undefined && !Array.isArray(snapshot.allowed))
        fail('decision_snapshot_invalid');
    const originalInputHash = hash(snapshot.input);
    if (snapshot.inputHash !== originalInputHash) fail('decision_snapshot_hash_mismatch');
    let original;
    try { original = JSON.parse(snapshot.input); } catch { fail('decision_snapshot_input_invalid'); }
    if (!object(original) || Object.keys(original).some(key => !INPUT_KEYS.has(key))
        || !Array.isArray(original.allowed) || new Set(original.allowed).size !== original.allowed.length
        || original.allowed.some(action => ![...ACTIONS, 'SKIP'].includes(action))) fail('decision_snapshot_input_invalid');
    const costsUpDown = costs(original, snapshot, market, config), closing = closingTwap(snapshot, original, market, btc, config);
    const input = JSON.stringify({ ...original, allowed_meaning: 'execution_only',
        cost_break_even_up_down: costsUpDown.map(cost => cost ? [cost.allInCostUsd, cost.breakEvenProbability] : null),
        close60: { status: closing.status, known_s: round(closing.knownSeconds), remaining_s: round(closing.remainingSeconds),
            mean_usd: closing.observedMeanUsd === null ? null : round(closing.observedMeanUsd),
            threshold_usd: closing.requiredRemainingAverageUsd === null ? null : round(closing.requiredRemainingAverageUsd) } });
    return frozen({ version: DECISION_CONTEXT_VERSION, snapshotId: snapshot.snapshotId, at: snapshot.at,
        observedAt: snapshot.observedAt ?? snapshot.at, originalInput: snapshot.input, originalInputHash, input, inputHash: hash(input),
        calculated: { allowedMeaning: 'execution_eligibility_only_not_recommendation', costsUpDown, closingTwap: closing } });
}
