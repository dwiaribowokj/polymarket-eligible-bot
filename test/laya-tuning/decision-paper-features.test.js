import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fee, round } from '../../src/restart/math.js';
import { buildDecisionContext, INFORMED_PROMPT, INFORMED_PROMPT_SHA256, INFORMED_QUESTIONS,
    INFORMED_QUESTIONS_SHA256 } from '../../src/decision-paper/features.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(seconds = 30) {
    const end = Date.parse('2026-10-20T00:05:00Z'), open = end - 300000, at = end - seconds * 1000;
    const market = { slug: 'btc-updown-5m-test', open, end, fee: { rate: .07, exponent: 1 },
        reference: { source: 'chainlink_twap_60s', open, end, observedAt: open, receivedAt: open + 100, value: 83000 } };
    const shares = 5, gasUsd = .05, prices = [.79, .22];
    const allowed = prices.map((price, index) => ({ index, price, shares, cost: round(shares * price + fee(shares, price, market.fee) + gasUsd) }));
    const original = { seconds, open_usd: 83000, delta_cents: [2000, 2000], margin_cents: 2000,
        sigma_milliusd: 500, ret_millibps: [0, 0, 0, 0, 0], bars_cents: Array.from({ length: 6 }, () => [2000, 2000, 2000, 2000]),
        up: [[[78, 10]], [[79, 10]]], down: 'mirror_up', fee: [.07, 1], shares, cap_usd: 5,
        limit_cost_up_down: allowed.map(order => [order.price * 100, order.cost]), allowed: ['BUY_UP', 'BUY_DOWN'] };
    const input = JSON.stringify(original);
    const snapshot = { snapshotId: 's1', market: market.slug, marketEnd: end, at, observedAt: at - 100,
        input, inputHash: hash(input), allowed, state: { outcome: 'ignore_me' }, settlement: { winner: 'ignore_me' } };
    const spot = [];
    for (let sourceAt = at - 185000; sourceAt <= at; sourceAt += 1000) spot.push({ at: sourceAt, receivedAt: sourceAt, value: 83020 });
    const btc = { spot, rule: { maxGapMs: 5000, maxAgeMs: 5000 },
        openings: new Map([[open, { at: open, receivedAt: open + 100, value: 83000 }]]) };
    const config = { shares, gasUsd, dataAgeMs: 5000, control: { lateSignal: { maxGapMs: 5000 } } };
    return { snapshot, original, market, btc, config, context(now) { return buildDecisionContext(snapshot, market, btc, config, now); } };
}
function replaceInput(f, change) {
    const input = JSON.parse(f.snapshot.input); change(input); f.snapshot.input = JSON.stringify(input); f.snapshot.inputHash = hash(f.snapshot.input);
}

test('before the final minute, closing-window observations and threshold remain unavailable', () => {
    for (const seconds of [90, 60]) {
        const f = fixture(seconds), result = f.context(), closing = result.calculated.closingTwap;
        assert.equal(closing.status, 'before_window'); assert.equal(closing.knownSeconds, 0);
        assert.equal(closing.remainingSeconds, 60); assert.equal(closing.observedIntegralUsdSeconds, null);
        assert.equal(closing.observedMeanUsd, null); assert.equal(closing.requiredRemainingAverageUsd, null);
        assert.equal(JSON.parse(result.input).close60.threshold_usd, null);
    }
});

test('30-second observation computes the remaining required TWAP average without forecasting', () => {
    const f = fixture(), result = f.context(), closing = result.calculated.closingTwap;
    assert.equal(closing.status, 'observed'); assert.equal(closing.knownSeconds, 30); assert.equal(closing.remainingSeconds, 30);
    assert.equal(closing.observedIntegralUsdSeconds, 83020 * 30); assert.equal(closing.observedMeanUsd, 83020);
    assert.equal(closing.requiredRemainingAverageUsd, 82980); assert.equal(closing.upComparator, '>');
    assert.equal(closing.downComparator, '<'); assert.equal(closing.tieRule, 'market_rules');
    assert.equal((closing.observedIntegralUsdSeconds + closing.requiredRemainingAverageUsd * closing.remainingSeconds) / 60, 83000);
    assert.deepEqual(JSON.parse(result.input).close60, { status: 'observed', known_s: 30, remaining_s: 30, mean_usd: 83020, threshold_usd: 82980 });
});

test('TWAP integration weights irregular observations by elapsed seconds, without extending the latest source point', () => {
    const f = fixture(), start = f.market.end - 60000;
    f.btc.spot = [0, 2, 5, 10, 15, 20, 25, 29].map((second, index) => ({ at: start + second * 1000,
        receivedAt: start + second * 1000, value: index === 0 ? 82990 : 83010 }));
    const closing = f.context().calculated.closingTwap;
    assert.equal(closing.status, 'observed'); assert.equal(closing.knownSeconds, 29); assert.equal(closing.remainingSeconds, 31);
    assert.equal(closing.observedIntegralUsdSeconds, 82990 * 2 + 83010 * 27);
    assert.equal(closing.asOf, f.snapshot.at - 1000);
});

test('missing, stale and gapped histories cannot produce an apparent required average', () => {
    const missing = fixture(); missing.btc.spot = [];
    assert.equal(missing.context().calculated.closingTwap.status, 'history_missing');
    const noStart = fixture(); noStart.btc.spot = noStart.btc.spot.filter(point => point.at > noStart.market.end - 60000);
    assert.equal(noStart.context().calculated.closingTwap.status, 'history_missing');
    const gap = fixture(), start = gap.market.end - 60000;
    gap.btc.spot = gap.btc.spot.filter(point => point.at <= start + 10000 || point.at >= start + 17000);
    const stale = fixture(); stale.btc.spot = stale.btc.spot.filter(point => point.at < stale.snapshot.at - 5000);
    for (const [f, expected] of [[gap, 'history_gap'], [stale, 'history_stale']]) {
        const closing = f.context().calculated.closingTwap;
        assert.equal(closing.status, expected); assert.equal(closing.observedMeanUsd, null);
        assert.equal(closing.requiredRemainingAverageUsd, null);
    }
});

test('future source points, late historical arrivals and impossible receipt times cannot alter frozen input', () => {
    const f = fixture(), expected = f.context();
    f.btc.spot.push({ at: f.snapshot.at + 1000, receivedAt: f.snapshot.at + 1000, value: 1000000 },
        { at: f.snapshot.at - 1000, receivedAt: f.snapshot.at + 1, value: 1000000 },
        { at: f.snapshot.at - 1000, receivedAt: f.snapshot.at - 1001, value: 1000000 },
        { at: f.snapshot.at - 500, receivedAt: f.snapshot.at, value: NaN });
    assert.deepEqual(f.context(f.snapshot.at + 10000), expected);
    assert.throws(() => f.context(f.snapshot.at - 1), /decision_snapshot_invalid/);
});

test('conflicting observations at the same source timestamp make history unavailable', () => {
    const f = fixture();
    f.btc.spot.push({ at: f.snapshot.at - 1000, receivedAt: f.snapshot.at, value: 84000 });
    const closing = f.context().calculated.closingTwap;
    assert.equal(closing.status, 'history_conflict'); assert.equal(closing.requiredRemainingAverageUsd, null);
});

test('opening reference must be causal and agree with frozen baseline and observed opening', () => {
    for (const mutate of [f => { f.market.reference.receivedAt = f.snapshot.at + 1; },
        f => { f.market.reference.value++; }, f => { f.btc.openings.get(f.market.open).value++; },
        f => { f.market.reference.source = 'later_settlement'; }]) {
        const f = fixture(); mutate(f);
        const closing = f.context().calculated.closingTwap;
        assert.equal(closing.status, 'reference_unverified'); assert.equal(closing.requiredRemainingAverageUsd, null);
    }
});

test('each executable side receives independently computed fee-and-gas-inclusive cost and break-even', () => {
    const f = fixture(), result = f.context();
    for (const [index, cost] of result.calculated.costsUpDown.entries()) {
        assert.equal(cost.notionalUsd, f.snapshot.allowed[index].price * 5);
        assert.equal(cost.feeUsd, fee(5, f.snapshot.allowed[index].price, f.market.fee));
        assert.equal(cost.allInCostUsd, f.snapshot.allowed[index].cost);
        assert.equal(cost.gasUsd, .05); assert.equal(cost.breakEvenProbability, cost.allInCostUsd / 5);
        assert.deepEqual(JSON.parse(result.input).cost_break_even_up_down[index], [cost.allInCostUsd, cost.breakEvenProbability]);
    }
    assert.equal(result.calculated.allowedMeaning, 'execution_eligibility_only_not_recommendation');
    replaceInput(f, input => { input.allowed = ['BUY_UP']; input.limit_cost_up_down[1] = null; });
    f.snapshot.allowed.pop();
    assert.equal(f.context().calculated.costsUpDown[1], null);
});

test('contradictory reserved cost, order price, fees or configured shares fail closed', () => {
    for (const [mutate, expected] of [
        [f => replaceInput(f, input => { input.limit_cost_up_down[0][1] += .05; }), /decision_snapshot_cost_mismatch/],
        [f => { f.snapshot.allowed[0].price = NaN; }, /decision_snapshot_order_mismatch/],
        [f => { f.market.fee.rate = .1; }, /decision_cost_inputs_invalid/],
        [f => { f.config.shares = 6; }, /decision_cost_inputs_invalid/],
        [f => { delete f.config.gasUsd; }, /decision_cost_inputs_invalid/]]) {
        const f = fixture(); mutate(f); assert.throws(() => f.context(), expected);
    }
});

test('original bytes and digest are retained while enriched data excludes incidental snapshot state and outcomes', () => {
    const f = fixture(); f.snapshot.input = `  ${f.snapshot.input}\n`; f.snapshot.inputHash = hash(f.snapshot.input);
    const result = f.context(), enriched = JSON.parse(result.input);
    assert.equal(result.originalInput, f.snapshot.input); assert.equal(result.originalInputHash, f.snapshot.inputHash);
    assert.equal(result.inputHash, hash(result.input)); assert.notEqual(result.inputHash, result.originalInputHash);
    for (const [key, value] of Object.entries(f.original)) assert.deepEqual(enriched[key], value);
    assert.equal(JSON.stringify(result).includes('ignore_me'), false);
    assert.throws(() => { result.calculated.closingTwap.status = 'changed'; }, TypeError);
    f.snapshot.input += ' '; assert.throws(() => f.context(), /decision_snapshot_hash_mismatch/);
});

test('outcome-shaped input extensions and mismatched market identity are rejected', () => {
    const f = fixture(); replaceInput(f, input => { input.settled_winner = 'UP'; });
    assert.throws(() => f.context(), /decision_snapshot_input_invalid/);
    const other = fixture(); other.snapshot.market = 'future-market';
    assert.throws(() => other.context(), /decision_snapshot_invalid/);
});

test('prompt identity is stable and explicitly separates eligibility, costs and uncertainty', () => {
    assert.equal(INFORMED_PROMPT_SHA256, hash(INFORMED_PROMPT));
    assert.equal(INFORMED_QUESTIONS_SHA256, hash(JSON.stringify(INFORMED_QUESTIONS)));
    assert.match(INFORMED_PROMPT, /execution eligibility, not a recommendation/);
    assert.match(INFORMED_PROMPT, /including fees and gas/); assert.match(INFORMED_PROMPT, /null is unavailable/);
    assert.match(INFORMED_PROMPT, /not a predicted win probability/); assert.match(INFORMED_PROMPT, /SKIP always available/);
    assert.deepEqual(Object.keys(INFORMED_QUESTIONS.action.criteria), ['BUY_UP', 'BUY_DOWN', 'SKIP']);
});
