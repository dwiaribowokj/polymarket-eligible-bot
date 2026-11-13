import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLayaConfidence } from '../../src/decision-paper/confidence.js';

const NOW = 10000;
function snapshot(id, action = 'BUY_UP', confidence = .6, overrides = {}) {
    const alternatives = ['BUY_UP', 'BUY_DOWN', 'SKIP'].filter(label => label !== action);
    const probabilities = { [action]: confidence, [alternatives[0]]: (1 - confidence) / 2,
        [alternatives[1]]: (1 - confidence) / 2 };
    return { snapshotId: id, market: id, at: 1000, inputHash: 'input',
        input: JSON.stringify({ allowed: action === 'SKIP' ? ['BUY_UP'] : [action] }),
        providerDecisions: { laya: { snapshotId: id, model: 'typed-decisions', status: 'ok', action,
            originalAction: action, probabilities, answerConfidence: confidence, entropyConfidence: .12,
            confidence, confidenceSource: 'answer_confidence', inputHash: 'input',
            requestedAt: 1100, receivedAt: 1500, decisionDeadlineAt: 2000, ...overrides } } };
}
function state(snapshots, payouts = {}) {
    return { startedAt: 900, snapshots, markets: Object.fromEntries(Object.entries(payouts)
        .map(([market, payout]) => [market, { end: 3000, labelResolvedAt: 4000, payout }])) };
}

test('confidence audit distinguishes metrics, direction, official labels, fixed bins and coverage', () => {
    const data = state([snapshot('low-win', 'BUY_UP', .46), snapshot('loss', 'BUY_UP', .47),
        snapshot('down', 'BUY_DOWN', .6), snapshot('unresolved', 'BUY_DOWN', .7), snapshot('skip', 'SKIP', 1)],
    { 'low-win': [1, 0], loss: [0, 1], down: [0, 1], skip: [1, 0] });
    const before = structuredClone(data), result = summarizeLayaConfidence(data, NOW), timely = result.cohorts.timely;
    assert.deepEqual(data, before);
    assert.equal(result.thresholdActive, false);
    assert.equal(result.changesTradingResults, false);
    assert.equal(timely.independentMarkets, 5);
    assert.equal(timely.officiallyLabeledBuyResponses, 3);
    assert.equal(timely.winRate, .666667);
    assert.equal(timely.bySide.BUY_UP.winRate, .5);
    assert.equal(timely.bySide.BUY_DOWN.winRate, 1);
    assert.equal(timely.bins[0].independentMarkets, 2);
    assert.equal(timely.bins[2].independentMarkets, 1);
    assert.equal(timely.bins.at(-1).skipResponses, 1);
    assert.equal(timely.thresholds[0].coverage, .5);
    assert.equal(timely.thresholds[1].wins, 1);
    assert.equal(timely.metrics.entropyConfidence.mean, .12);
    assert.equal(timely.metrics.answerConfidence.mean, timely.metrics.selectedActionProbability.mean);
    assert.ok(result.limitations.includes('direction_confounded'));
});

test('late responses are observed separately and never promoted into the timely cohort', () => {
    const nested = snapshot('nested', 'BUY_DOWN', .7);
    const response = { ...nested.providerDecisions.laya, receivedAt: 2500 };
    nested.providerDecisions.laya = { ...response, status: 'decision_timeout', action: 'SKIP', lateResponse: response };
    const fallback = snapshot('fallback', 'BUY_UP', .5, { status: 'decision_timeout', action: 'SKIP', receivedAt: 2200 });
    const expired = snapshot('expired', 'BUY_UP', .5, { receivedAt: 2100 });
    const result = summarizeLayaConfidence(state([nested, fallback, expired],
        { nested: [0, 1], fallback: [0, 1], expired: [1, 0] }), NOW);
    assert.equal(result.cohorts.timely.independentMarkets, 0);
    assert.equal(result.cohorts.late.independentMarkets, 3);
    assert.equal(result.cohorts.late.wins, 2);
    assert.equal(result.cohorts.late.losses, 1);
});

test('only the first valid received response per market enters each cohort', () => {
    const early = snapshot('early', 'BUY_UP', .5, { receivedAt: 1400 });
    const later = snapshot('later', 'BUY_DOWN', .8, { receivedAt: 1600 });
    later.market = early.market;
    const late = snapshot('late', 'BUY_DOWN', .8, { receivedAt: 2100 });
    late.market = early.market;
    const result = summarizeLayaConfidence(state([later, late, early], { early: [1, 0] }), NOW);
    assert.equal(result.cohorts.allValid.independentMarkets, 1);
    assert.equal(result.cohorts.allValid.duplicateMarketResponses, 2);
    assert.equal(result.cohorts.allValid.wins, 1);
    assert.equal(result.cohorts.timely.independentMarkets, 1);
    assert.equal(result.cohorts.late.losses, 1);
});

test('invalid response identities, distributions, confidence, eligibility and timing are excluded', () => {
    const changes = [{ model: 'other-model' }, { snapshotId: 'wrong' }, { inputHash: 'wrong' },
        { answerConfidence: null, confidence: null }, { answerConfidence: .9 }, { entropyConfidence: NaN },
        { probabilities: { BUY_UP: .6, BUY_DOWN: .5, SKIP: .1 } },
        { probabilities: { BUY_UP: .3, BUY_DOWN: .6, SKIP: .1 }, answerConfidence: .6 },
        { probabilities: { BUY_UP: .6, BUY_DOWN: .2, SKIP: .2, EXTRA: 0 } },
        { requestedAt: null }, { requestedAt: 999 }, { receivedAt: 1000 }, { receivedAt: NOW + 1 },
        { receivedAt: null }, { decisionDeadlineAt: null }, { tokenUsageMatches: false },
        { status: 'rejected' }, { reason: 'disallowed_action' }];
    const invalid = changes.map((change, index) => snapshot(`bad-${index}`, 'BUY_UP', .6, change));
    const forbidden = snapshot('forbidden'); forbidden.input = '{"allowed":["BUY_DOWN"]}';
    const malformed = snapshot('malformed'); malformed.input = '{';
    const beforePeriod = snapshot('before-period'); beforePeriod.at = 800;
    invalid.push(forbidden, malformed, beforePeriod);
    const result = summarizeLayaConfidence(state([...invalid, snapshot('good')]), NOW);
    assert.equal(result.input.rejectedResponses, invalid.length);
    assert.equal(result.input.validResponses, 1);
});

test('future, malformed and neutral official payouts do not become wins or losses', () => {
    const data = state(['future', 'bad', 'neutral', 'early-label'].map(id => snapshot(id)),
        { future: [1, 0], bad: [1, 1], neutral: [.5, .5], 'early-label': [1, 0] });
    data.markets.future.labelResolvedAt = NOW + 1;
    data.markets['early-label'].labelResolvedAt = 2000;
    const result = summarizeLayaConfidence(data, NOW).cohorts.allValid;
    assert.equal(result.officiallyLabeledBuyResponses, 1);
    assert.equal(result.neutral, 1);
    assert.equal(result.wins, 0);
    assert.equal(result.losses, 0);
    assert.equal(result.winRate, null);
});

test('rounded distributions and event arrival timestamps retain valid historical observations', () => {
    const data = state([snapshot('rounded', 'BUY_DOWN', .5972,
        { probabilities: { BUY_UP: .2497, BUY_DOWN: .5972, SKIP: .153 } })]);
    const decision = data.snapshots[0].providerDecisions.laya;
    const lateResponse = { ...decision, at: new Date(2500).toISOString() };
    delete lateResponse.receivedAt;
    delete lateResponse.requestedAt;
    data.snapshots[0].providerDecisions.laya = { ...decision, status: 'decision_timeout', action: 'SKIP', lateResponse };
    const result = summarizeLayaConfidence(data, NOW);
    assert.equal(result.cohorts.late.independentMarkets, 1);
    assert.equal(result.cohorts.timely.independentMarkets, 0);
});
