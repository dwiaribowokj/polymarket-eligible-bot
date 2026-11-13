import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ENTRY_FILTER_POLICY, evaluateEntryFilter } from '../../src/decision-paper/entry-filter.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function snapshot(overrides = {}) {
    const input = JSON.stringify({ seconds: 100, open_usd: 83000, delta_cents: [1000, 1000],
        sigma_milliusd: 1000, allowed: ['BUY_UP', 'BUY_DOWN'], ...overrides });
    return { snapshotId: 's1', at: 1000000, input, inputHash: hash(input) };
}
function closing(s, overrides = {}) {
    s.informed = { snapshotId: s.snapshotId, at: s.at, originalInputHash: s.inputHash,
        calculated: { closingTwap: { status: 'observed', snapshotAt: s.at, asOf: s.at - 1000,
            referenceUsd: 83000, knownSeconds: 35, remainingSeconds: 25,
            requiredRemainingAverageUsd: 83005, ...overrides } } };
    return s;
}

test('one-sigma boundary is inclusive, symmetric and dimensionally correct', () => {
    for (const [action, delta] of [['BUY_UP', 1000], ['BUY_DOWN', -1000]]) {
        const verdict = evaluateEntryFilter(snapshot({ delta_cents: [delta, delta] }), action);
        assert.equal(verdict.pass, true); assert.equal(verdict.metrics.horizonVolatilityUsd, 10);
        assert.equal(verdict.metrics.spotBufferSigma, 1); assert.equal(verdict.metrics.twapBufferSigma, 1);
        const thinner = evaluateEntryFilter(snapshot({ delta_cents: [delta, delta * .999] }), action);
        assert.equal(thinner.pass, false); assert.equal(thinner.reason, 'entry_filter_insufficient_buffer');
    }
    assert.equal(ENTRY_FILTER_POLICY.minBufferSigma, 1); assert.equal(Object.isFrozen(ENTRY_FILTER_POLICY), true);
});

test('both spot and rolling TWAP must agree with the chosen side, including at zero', () => {
    for (const delta_cents of [[1000, -1000], [-1000, 1000], [0, 1000], [1000, 0]]) {
        assert.equal(evaluateEntryFilter(snapshot({ delta_cents }), 'BUY_UP').reason, 'entry_filter_direction_conflict');
    }
    assert.equal(evaluateEntryFilter(snapshot({ allowed: ['BUY_DOWN'] }), 'BUY_UP').reason, 'entry_filter_action_not_allowed');
});

test('missing, zero, nonnumeric and corrupt inputs fail closed', () => {
    for (const values of [{ seconds: 0 }, { seconds: 301 }, { seconds: '100' }, { sigma_milliusd: 0 },
        { sigma_milliusd: -1 }, { sigma_milliusd: null }, { sigma_milliusd: '1000' }, { open_usd: 0 },
        { delta_cents: [1000, null] }, { delta_cents: [1000] }, { allowed: null }]) {
        assert.equal(evaluateEntryFilter(snapshot(values), 'BUY_UP').pass, false);
    }
    const corrupt = snapshot(); corrupt.input += ' ';
    assert.equal(evaluateEntryFilter(corrupt, 'BUY_UP').reason, 'entry_filter_input_hash_mismatch');
    assert.equal(evaluateEntryFilter({ input: 'bad', inputHash: hash('bad') }, 'BUY_UP').reason, 'entry_filter_input_invalid');
    assert.equal(evaluateEntryFilter(snapshot(), 'BUY_UP', { ...ENTRY_FILTER_POLICY, minBufferSigma: 0 }).pass, false);
});

test('closing threshold can veto a strong rolling signal and uses its remaining horizon', () => {
    const equal = evaluateEntryFilter(closing(snapshot()), 'BUY_UP');
    assert.equal(equal.pass, true); assert.equal(equal.metrics.closingHorizonVolatilityUsd, 5);
    assert.equal(equal.metrics.closingBufferUsd, 5); assert.equal(equal.metrics.closingBufferSigma, 1);
    assert.equal(evaluateEntryFilter(closing(snapshot(), { requiredRemainingAverageUsd: 83005.01 }), 'BUY_UP').reason,
        'entry_filter_closing_insufficient_buffer');
    assert.equal(evaluateEntryFilter(closing(snapshot(), { requiredRemainingAverageUsd: 83011 }), 'BUY_UP').reason,
        'entry_filter_closing_direction_conflict');
    const down = closing(snapshot({ delta_cents: [-1000, -1000] }), { requiredRemainingAverageUsd: 82995 });
    assert.equal(evaluateEntryFilter(down, 'BUY_DOWN').pass, true);
});

test('mismatched or noncausal observed closing context fails closed', () => {
    for (const mutate of [s => { s.informed.originalInputHash = 'wrong'; }, s => { s.informed.snapshotId = 'other'; },
        s => { s.informed.calculated.closingTwap.asOf = s.at + 1; },
        s => { s.informed.calculated.closingTwap.snapshotAt++; },
        s => { s.informed.calculated.closingTwap.remainingSeconds = 0; },
        s => { s.informed.calculated.closingTwap.referenceUsd++; },
        s => { s.informed.calculated.closingTwap.requiredRemainingAverageUsd = null; }]) {
        const s = closing(snapshot()); mutate(s);
        assert.equal(evaluateEntryFilter(s, 'BUY_UP').reason, 'entry_filter_closing_context_invalid');
    }
});

test('unavailable closing observations stay explicit and never fabricate a threshold', () => {
    for (const status of ['before_window', 'history_missing', 'history_stale', 'history_gap']) {
        const s = closing(snapshot(), { status, requiredRemainingAverageUsd: null });
        const verdict = evaluateEntryFilter(s, 'BUY_UP');
        assert.equal(verdict.pass, true); assert.equal(verdict.metrics.closingStatus, status);
        assert.equal(verdict.metrics.closingBufferSigma, null);
    }
    const s = closing(snapshot(), { requiredRemainingAverageUsd: 83011 });
    assert.equal(evaluateEntryFilter(s, 'BUY_UP', { ...ENTRY_FILTER_POLICY, useClosingThreshold: false }).pass, true);
});

test('confidence, choice probabilities, payout and mutable market state cannot affect the veto', () => {
    const s = snapshot(), expected = evaluateEntryFilter(s, 'BUY_UP');
    s.sharedDecision = { confidence: 0, probabilities: { BUY_UP: 0 } };
    s.settlement = { payout: [0, 1] }; s.state = { spot: 1000000, twap: 1 };
    const before = JSON.stringify(s);
    assert.deepEqual(evaluateEntryFilter(s, 'BUY_UP'), expected);
    assert.equal(JSON.stringify(s), before);
    assert.match(expected.metrics.interpretation, /not_probability/);
    assert.equal(evaluateEntryFilter(null, 'SKIP').pass, true);
    assert.equal(evaluateEntryFilter(s, 'BUY').pass, false);
});
