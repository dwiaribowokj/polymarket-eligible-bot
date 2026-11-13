import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EPS } from '../../src/restart/math.js';
import { Store, atomicJson } from '../../src/restart/store.js';
import { candidateChecks, metadataIdentity } from '../../src/ai-shadow/engine.js';
import { entryGuard } from '../../src/laya-live/engine.js';
import { entryHeld } from '../../src/laya-live/entry-holds.js';
import { evaluateLiveRisk } from '../../src/laya-live/risk.js';

const now = 1800000000000;

function fixture(t, mode = 'pilot') {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Continuous risk tests must remain offline'));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-continuous-risk-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const settings = { dataDir: directory, fingerprint: 'offline-continuous-risk', capital: 20,
        continuousTrading: true, drawdownStop: 10, maxDataAgeMs: 5000,
        pilotMarkets: Infinity, pilotHours: Infinity };
    const store = new Store(settings, mode, 'late-entry'), events = [];
    store.logger = event => events.push(event);
    Object.assign(store.state, { decisionProvider: 'eligible', startedAt: now - 300000 });
    return { store, settings, events };
}

function inventory(store) {
    store.state.cash = 8;
    store.state.position = { market: { slug: 'offline-held', conditionId: 'offline-condition',
        end: now + 60000, tokens: ['1', '2'], fee: { rate: 0, exponent: 1 } }, holdings: [5, 0] };
    return [{ timestamp: now - 100, fetchedAt: now - 20,
        bids: [{ price: .2, size: 3 }, { price: .1, size: 2 }] },
    { timestamp: now - 100, fetchedAt: now - 20, bids: [] }];
}

test('continuous risk observes exact drawdown boundaries without a new stop or entry latch', t => {
    for (const [cash, crossed] of [[10 + 2 * EPS, false], [10 + EPS / 2, true], [10, true], [9, true]]) {
        const { store, settings, events } = fixture(t);
        store.state.cash = cash;
        assert.equal(evaluateLiveRisk(store, settings, now, cash), null);
        assert.equal(store.state.peakEquity, 20);
        assert.equal(store.state.lastEquity, cash);
        assert.equal(store.state.maxDrawdown, 20 - cash);
        assert.equal(store.state.stopped, null);
        assert.equal(store.state.liveRiskStop, undefined);
        assert.equal(entryHeld(store.state), false);
        assert.equal(events.filter(event => event.type === 'live_risk_stop').length, 0);
        assert.equal(events.filter(event => event.type === 'live_risk_threshold_crossed').length, Number(crossed));
        if (crossed) {
            assert.equal(store.state.liveRiskThreshold.kind, 'drawdown');
            assert.equal(store.state.liveRiskThreshold.threshold, 10);
            assert.equal(store.state.liveRiskThreshold.drawdown, 20 - cash);
        }
    }
});

test('continuous inventory drawdown retains executable quote evidence and accounting history', t => {
    const { store, settings, events } = fixture(t), books = inventory(store);
    const position = structuredClone(store.state.position);
    Object.assign(store.state, { maxDrawdown: 13, completed: [{ traded: true, pnl: -3 }], seen: { retained: true } });
    const history = structuredClone({ completed: store.state.completed, seen: store.state.seen, startedAt: store.state.startedAt });
    assert.equal(evaluateLiveRisk(store, settings, now, 8.8, { books }), null);
    assert.equal(store.state.peakEquity, 20);
    assert.equal(store.state.lastEquity, 8.8);
    assert.equal(store.state.maxDrawdown, 13);
    const observation = store.state.liveRiskThreshold;
    assert.equal(observation.source, 'fresh_books');
    assert.equal(observation.drawdown, 11.2);
    assert.equal(observation.quotes[0].liquidation.cash, .8);
    assert.equal(observation.quotes[0].timestamp, now - 100);
    assert.deepEqual(observation.quotes[0].bids, books[0].bids);
    books[0].bids[0].price = .9;
    assert.equal(observation.quotes[0].bids[0].price, .2);
    assert.deepEqual(store.state.position, position);
    assert.deepEqual({ completed: store.state.completed, seen: store.state.seen, startedAt: store.state.startedAt }, history);
    assert.equal(store.state.stopped, null);
    assert.equal(store.state.liveRiskStop, undefined);
    assert.equal(events.at(-1).type, 'live_risk_threshold_crossed');
    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state.liveRiskThreshold, observation);
});

test('threshold telemetry records crossings once, including a later crossing after restart', t => {
    const { store, settings } = fixture(t);
    store.state.cash = 10;
    evaluateLiveRisk(store, settings, now, 10);
    const first = structuredClone(store.state.liveRiskThreshold);
    const restarted = new Store(settings, 'pilot', 'late-entry');
    restarted.logger = () => {};
    restarted.state.cash = 9;
    evaluateLiveRisk(restarted, settings, now + 1, 9);
    assert.deepEqual(restarted.state.liveRiskThreshold, first);
    assert.equal(restarted.state.maxDrawdown, 11);
    restarted.state.cash = 21;
    evaluateLiveRisk(restarted, settings, now + 2, 21);
    assert.equal(restarted.state.peakEquity, 21);
    restarted.save();
    const recovered = new Store(settings, 'pilot', 'late-entry');
    recovered.logger = () => {};
    recovered.state.cash = 11;
    evaluateLiveRisk(recovered, settings, now + 3, 11);
    assert.equal(recovered.state.liveRiskThreshold.at, now + 3);
    assert.equal(recovered.state.liveRiskThreshold.peakEquity, 21);
    assert.equal(recovered.state.maxDrawdown, 11);
    const rows = fs.readFileSync(path.join(store.directory, 'late-entry.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.type === 'live_risk_threshold_crossed').length, 2);
    assert.equal(rows.filter(row => row.type === 'live_risk_stop').length, 0);
});

test('continuous trading preserves previously latched stops and their original evidence', t => {
    for (const reason of ['drawdown_limit', 'capital_exhausted', 'operational_check_failed', 'manual_stop']) {
        const { store, settings } = fixture(t);
        const stopped = store.state.stopped = { reason, at: now - 100 };
        const riskStop = store.state.liveRiskStop = { reason: 'drawdown_limit', at: now - 200, equity: 10 };
        store.state.cash = 8;
        assert.equal(evaluateLiveRisk(store, settings, now, 8), null);
        assert.equal(store.state.stopped, stopped);
        assert.equal(store.state.liveRiskStop, riskStop);
        assert.equal(entryHeld(store.state), true);
        assert.throws(() => entryGuard({ state: store.state }), /pilot_stopped/);
        const restarted = new Store(settings, 'pilot', 'late-entry');
        assert.deepEqual(restarted.state.stopped, stopped);
        assert.deepEqual(restarted.state.liveRiskStop, riskStop);
    }
});

test('continuous capital exhaustion stays unlatched while candidate and entry guards enforce affordability', t => {
    const { store, settings } = fixture(t);
    const config = { settings, policy: { provider: 'eligible' }, ai: { shares: 5, entryCap: 5, gasUsd: .05,
        decisionMs: 3000, dataAgeMs: 5000, control: { lateQuality: { maxSpread: .03, minDepth: 5 } } } };
    const market = { accepting: true, minimum: 5, tick: .01, end: now + 60000,
        conditionId: 'offline-condition', tokens: ['1', '2'], fee: { rate: 0, exponent: 1 } };
    const books = [0, 1].map(() => ({ asks: [{ price: .8, size: 10 }], bids: [{ price: .79, size: 10 }] }));
    const snapshot = { snapshotId: 'offline', provider: 'eligible', at: now - 250,
        decisionReceivedAt: now - 250, observedAt: now - 250,
        validation: { identity: metadataIdentity(market) }, allowed: [{ index: 0, price: .8 }] };
    const decision = { status: 'ok', snapshotId: 'offline', action: 'BUY_UP', provider: 'eligible',
        model: 'deterministic-eligible-v1', inferenceAttempted: false };
    const spec = { index: 0, tokenId: '1', side: 'BUY', kind: 'taker', shares: 5, price: .8 };
    for (const cash of [0, EPS, 1, 4.05 - 2 * EPS]) {
        store.state.cash = cash;
        assert.equal(evaluateLiveRisk(store, settings, now, cash), null);
        assert.equal(store.state.liveRiskStop, undefined);
        assert.equal(store.state.stopped, null);
        assert.ok(candidateChecks(market, books, config.ai, cash, now).every(check => !check.order));
        assert.throws(() => entryGuard({ state: store.state, config, market, books, snapshot, decision, spec, now }),
            /entry_budget_exceeded/);
    }
    store.state.cash = 4.05;
    assert.doesNotThrow(() => entryGuard({ state: store.state, config, market, books, snapshot, decision, spec, now }));
});

test('continuous trading keeps invalid marks and corrupt histories blocked', t => {
    for (const alter of [
        (_state, books) => { books[0].timestamp = now + 1; },
        (_state, books) => { books[0].bids[0].price = NaN; },
        state => { state.maxDrawdown = NaN; },
        state => { state.position.holdings[0] = -1; },
    ]) {
        const { store, settings } = fixture(t), books = inventory(store);
        alter(store.state, books);
        assert.equal(evaluateLiveRisk(store, settings, now, 8.8, { books }), null);
        assert.equal(store.state.stopped.reason, 'operational_check_failed');
        assert.equal(store.state.entryHolds.risk_mark.retryable, false);
        assert.equal(store.state.peakEquity, 20);
        assert.equal(store.state.lastEquity, undefined);
        assert.equal(store.state.liveRiskThreshold, undefined);
    }
    const { store, settings } = fixture(t);
    atomicJson(store.filename, { ...store.state, baseline: 'another-ledger' });
    assert.throws(() => new Store(settings, 'pilot', 'late-entry'), /identity mismatch/);
    atomicJson(store.filename, { ...store.state, cash: null });
    assert.throws(() => new Store(settings, 'pilot', 'late-entry'), /incomplete or corrupt/);
});

test('the continuous flag requires exact opt-in and does not alter paper drawdown behavior', t => {
    for (const continuousTrading of [undefined, false, 'true', 1]) {
        const { store, settings } = fixture(t);
        store.state.cash = 10;
        assert.equal(evaluateLiveRisk(store, { ...settings, continuousTrading }, now, 10), 'drawdown_limit');
        assert.equal(store.state.liveRiskStop.reason, 'drawdown_limit');
        assert.equal(store.state.liveRiskThreshold, undefined);
    }
    const { store, settings } = fixture(t, 'paper');
    store.state.cash = 10;
    assert.equal(evaluateLiveRisk(store, { ...settings, paperDrawdownStop: 10, paperShadowDrawdownStop: 10 }, now, 10),
        'paper_drawdown_limit');
    assert.equal(store.state.shadowPilotStop.reason, 'drawdown_limit');
    assert.equal(store.state.liveRiskThreshold, undefined);
});
