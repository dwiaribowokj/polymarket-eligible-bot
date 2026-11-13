import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fitTemperature, normalCdf, probabilityMetrics, temperatureProbability } from '../../src/restart/calibration.js';
import { BASELINE } from '../../src/restart/config.js';
import { report } from '../../src/restart/report.js';
import { Store } from '../../src/restart/store.js';

function samples(n = 40) {
    return Array.from({ length: n }, (_, i) => ({ conditionId: `market-${i}`, source: 'official_ctf_payout',
        open: 100000 + i * 300000, end: 400000 + i * 300000, observedAt: 370000 + i * 300000,
        z: 2, outcome: i % 4 === 0 ? 0 : 1 }));
}

test('temperature only softens positive model confidence and preserves finite probabilities', () => {
    assert.ok(temperatureProbability(2, 1.5) < normalCdf(2));
    assert.equal(temperatureProbability(0, 1.5), normalCdf(0));
    assert.ok(temperatureProbability(100, 1.5) <= 1);
    assert.ok(temperatureProbability(-100, 1.5) >= 0);
    for (const t of [0, 0.9, 8.01, Infinity, NaN]) assert.throws(() => temperatureProbability(2, t), /Invalid/);
    assert.throws(() => temperatureProbability(NaN, 1.5), /Invalid/);
});

test('temperature is fitted chronologically on training outcomes alone', () => {
    const rows = samples(), fitted = fitTemperature(rows);
    assert.equal(fitted.trainingMarkets, 26); assert.equal(fitted.validationMarkets, 14);
    assert.ok(fitted.temperature > 1); assert.equal(fitted.qualifiedForLive, false);
    assert.ok(fitted.trainedThrough <= fitted.validationStartsAt);
    assert.equal(fitted.status, 'provisional'); assert.equal(fitted.researchOnly, true);
    const changedHoldout = rows.map((r, i) => i < 26 ? r : { ...r, outcome: 1 - r.outcome });
    const other = fitTemperature(changedHoldout);
    assert.equal(other.temperature, fitted.temperature);
    assert.deepEqual(other.training, fitted.training);
    assert.notDeepEqual(other.validation, fitted.validation);
    assert.equal(fitTemperature([...rows].reverse()).temperature, fitted.temperature);
});

test('duplicate markets, missing official labels, future predictions and too-small samples are rejected', () => {
    const rows = samples();
    assert.throws(() => fitTemperature([...rows, rows[0]]), /Duplicate/);
    assert.throws(() => fitTemperature(samples(20)), /Insufficient/);
    for (const invalid of [{ source: 'spot' }, { outcome: 0.5 }, { z: Infinity }, { observedAt: rows[0].end }]) {
        assert.throws(() => fitTemperature([{ ...rows[0], ...invalid }, ...rows.slice(1)]), /Invalid/);
    }
    rows[25].end = rows[26].open + 1;
    assert.throws(() => fitTemperature(rows), /overlaps/);
});

test('proper scoring remains finite at extreme confidence and empty evidence stays empty', () => {
    assert.equal(probabilityMetrics([]), null);
    const result = probabilityMetrics([{ z: 100, outcome: 0 }, { z: -100, outcome: 1 }]);
    assert.equal(result.brier, 1); assert.ok(Number.isFinite(result.logLoss));
    assert.equal(result.markets, 2); assert.equal(result.meanPrediction, 0.5);
});

test('prospective report uses official filled outcomes and execution-time forecasts, never retrospective fit PnL', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-calibration-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, dataDir, fingerprint: 'calibration', strategies: ['late-entry'], paperGasUsd: 0.05 };
    const store = new Store(settings, 'paper', 'late-entry'); store.logger = () => {};
    store.state.completed = [{ traded: true, uncertain: false, payout: [0, 1], pnl: -4.4, closedAt: Date.now(),
        fees: 0.04, gas: 0.05, rebate: 0, capitalHours: 0.1, entrySignal: { z: 9 },
        orders: [{ side: 'BUY', settled: 5, index: 0, executionSignal: { z: 2 } }] },
    { traded: false, pnl: 0, orders: [], closedAt: Date.now() },
    { traded: true, uncertain: true, payout: [1, 0], pnl: 1, closedAt: Date.now(), orders: [] }];
    store.save();
    const result = report(settings);
    const evidence = result.calibration.prospective[0];
    assert.equal(evidence.independentFilledMarkets, 1);
    assert.deepEqual(evidence.raw, probabilityMetrics([{ z: 2, outcome: 0 }]));
    assert.equal(evidence.eligibleForLive, false);
    assert.equal(result.calibration.frozenArtifact.temperature, 1.5);
    assert.equal(result.strategies[0].pnl, -3.4);
    assert.ok(result.strategies[0].reasons.includes('calibration_requires_prospective_validation'));
});
