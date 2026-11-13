import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EPS } from '../../src/restart/math.js';
import { Store } from '../../src/restart/store.js';
import { evaluateLiveRisk } from '../../src/laya-live/risk.js';
import { liveReadiness } from '../../src/laya-live/preflight.js';

const now = 1800000000000;

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-risk-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const settings = { dataDir: directory, fingerprint: 'offline-risk', capital: 20,
        drawdownStop: 10, maxDataAgeMs: 5000, pilotMarkets: Infinity, pilotHours: Infinity };
    const store = new Store(settings, 'pilot', 'late-entry');
    store.logger = () => {};
    store.state.startedAt = now - 300000;
    return { store, settings };
}

function expose(store, { cash = 16, holdings = [5, 0] } = {}) {
    store.state.cash = cash;
    store.state.position = { market: { slug: 'offline-market', conditionId: '0xcondition', end: now + 30000,
        tokens: ['1', '2'], fee: { rate: 0, exponent: 1, takerOnly: true } }, holdings, payout: null };
}

const books = (bids = [{ price: .5, size: 5 }]) => [
    { bids, timestamp: now - 100, fetchedAt: now - 20 },
    { bids: [], timestamp: now - 100, fetchedAt: now - 20 },
];

test('a genuine drawdown preserves the original peak and exact first trigger across restart', t => {
    const { store, settings } = fixture(t);
    const s = store.state;
    Object.assign(s, { cash: 22.783669, peakEquity: 29.310139, maxDrawdown: 10.586361,
        completed: [{ traded: true, pnl: -1, fees: .01, gas: 0 }], seen: { retained: { at: 1 } } });
    const history = structuredClone({ completed: s.completed, seen: s.seen, startedAt: s.startedAt });
    assert.equal(evaluateLiveRisk(store, settings, now, s.cash, { source: 'flat_cash' }), null);
    assert.equal(s.maxDrawdown, 10.586361);
    s.cash = 19.310139;
    assert.equal(evaluateLiveRisk(store, settings, now + 1, s.cash, { source: 'flat_cash' }), 'drawdown_limit');
    assert.equal(s.peakEquity, 29.310139);
    assert.equal(s.liveRiskStop.equity, 19.310139);
    assert.equal(s.liveRiskStop.drawdown, 10);
    assert.equal(s.liveRiskStop.maxDrawdown, 10.586361);
    assert.equal(s.liveRiskStop.drawdownStop, 10);
    const first = structuredClone(s.liveRiskStop);
    s.cash = 23;
    assert.equal(evaluateLiveRisk(store, settings, now + 2, s.cash), null);
    store.save();
    const restarted = new Store(settings, 'pilot', 'late-entry');
    assert.deepEqual(restarted.state.liveRiskStop, first);
    assert.equal(restarted.state.peakEquity, 29.310139);
    assert.equal(restarted.state.maxDrawdown, 10.586361);
    assert.deepEqual({ completed: s.completed, seen: s.seen, startedAt: s.startedAt }, history);
});

test('an earlier operational stop cannot hide a later real risk stop or its quote evidence', t => {
    const { store, settings } = fixture(t);
    expose(store, { cash: 8 });
    store.stop('account_status_unknown');
    const original = structuredClone(store.state.stopped);
    const quote = books([{ price: .2, size: 3 }, { price: .1, size: 2 }]);
    assert.equal(evaluateLiveRisk(store, settings, now, 8.8, { source: 'fresh_books', books: quote }), 'drawdown_limit');
    assert.deepEqual(store.state.stopped, original);
    const trigger = store.state.liveRiskStop;
    assert.deepEqual(trigger.priorStop, original);
    assert.equal(trigger.source, 'fresh_books');
    assert.equal(trigger.quotes[0].timestamp, now - 100);
    assert.equal(trigger.quotes[0].fetchedAt, now - 20);
    assert.equal(trigger.quotes[0].quoteAgeMs, 100);
    assert.equal(trigger.quotes[0].availableBidShares, 5);
    assert.equal(trigger.quotes[0].liquidation.cash, .8);
    assert.deepEqual(trigger.quotes[0].bids, quote[0].bids);
    quote[0].bids[0].price = .9;
    assert.equal(trigger.quotes[0].bids[0].price, .2);
    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state.liveRiskStop, trigger);
});

test('missing and stale held-side quotes defer drawdown, and fresh quotes recover the hold', t => {
    for (const input of [null, [null, null], books().map(book => ({ ...book, timestamp: now - 5001 }))]) {
        const { store, settings } = fixture(t);
        expose(store, { cash: 8 });
        const before = { peak: store.state.peakEquity, drawdown: store.state.maxDrawdown };
        assert.equal(evaluateLiveRisk(store, settings, now, 8, { books: input }), null);
        assert.equal(store.state.stopped, null);
        assert.equal(store.state.liveRiskStop, undefined);
        assert.equal(store.state.entryHolds.risk_mark.retryable, true);
        assert.deepEqual({ peak: store.state.peakEquity, drawdown: store.state.maxDrawdown }, before);
        assert.equal(evaluateLiveRisk(store, settings, now, 10.5, { books: books() }), null);
        assert.equal(store.state.entryHolds.risk_mark, undefined);
        assert.equal(store.state.maxDrawdown, 9.5);
    }
});

test('fresh empty bid depth is a genuine zero liquidation mark', t => {
    const { store, settings } = fixture(t);
    expose(store, { cash: 8 });
    assert.equal(evaluateLiveRisk(store, settings, now, 8, { books: books([]) }), 'drawdown_limit');
    assert.equal(store.state.liveRiskStop.quotes[0].bestBid, null);
    assert.equal(store.state.liveRiskStop.quotes[0].availableBidShares, 0);
    assert.equal(store.state.liveRiskStop.quotes[0].liquidation.cash, 0);
});

test('nonfinite or inconsistent marks cannot poison risk history and remain held after good data', t => {
    for (const value of [NaN, Infinity, 1]) {
        const { store, settings } = fixture(t);
        expose(store);
        assert.equal(evaluateLiveRisk(store, settings, now, value, { books: books() }), null);
        assert.equal(store.state.peakEquity, 20);
        assert.equal(store.state.maxDrawdown, 0);
        assert.equal(store.state.lastEquity, undefined);
        assert.equal(store.state.stopped.reason, 'operational_check_failed');
        assert.equal(store.state.entryHolds.risk_mark.retryable, false);
        evaluateLiveRisk(store, settings, now, 18.5, { books: books() });
        assert.equal(store.state.entryHolds.risk_mark.retryable, false);
    }
});

test('future or malformed quotes and corrupt history fail closed without changing the peak', t => {
    for (const alter of [
        quote => { quote[0].timestamp = now + 1; },
        quote => { quote[0].bids[0].price = NaN; },
        (_quote, state) => { state.maxDrawdown = NaN; },
    ]) {
        const { store, settings } = fixture(t);
        expose(store);
        const quote = books();
        alter(quote, store.state);
        assert.equal(evaluateLiveRisk(store, settings, now, 18.5, { books: quote }), null);
        assert.equal(store.state.peakEquity, 20);
        assert.equal(store.state.liveRiskStop, undefined);
        assert.equal(store.state.entryHolds.risk_mark.retryable, false);
    }
});

test('official payout replaces quotes and paired inventory retains its guaranteed value', t => {
    const { store, settings } = fixture(t);
    expose(store);
    store.state.position.payout = [1, 0];
    assert.equal(evaluateLiveRisk(store, settings, now, 21, { source: 'official_payout', payout: [1, 0] }), null);
    assert.equal(store.state.peakEquity, 21);
    assert.equal(store.state.lastEquity, 21);
    store.state.position.payout = null;
    store.state.position.holdings = [5, 5];
    assert.equal(evaluateLiveRisk(store, settings, now, 21, { books: books([]) }), null);
    assert.equal(store.state.maxDrawdown, 0);
});

test('capital exhaustion requires flat cash at zero rather than cash below an entry budget', t => {
    for (const cash of [0, EPS, -1]) {
        const { store, settings } = fixture(t);
        store.state.cash = cash;
        store.state.peakEquity = 0;
        assert.equal(evaluateLiveRisk(store, settings, now, cash), 'capital_exhausted');
        assert.equal(store.state.liveRiskStop.reason, 'capital_exhausted');
    }
    const { store, settings } = fixture(t);
    store.state.cash = .1;
    assert.equal(evaluateLiveRisk(store, { ...settings, drawdownStop: 100 }, now, .1), null);
    assert.equal(store.state.liveRiskStop, undefined);
    expose(store, { cash: 0 });
    store.state.peakEquity = 0;
    assert.equal(evaluateLiveRisk(store, settings, now, 2.5, { books: books() }), null);
    assert.equal(store.state.liveRiskStop, undefined);
});

test('an independent risk latch blocks entry while exposed recovery remains available', t => {
    const { store, settings } = fixture(t);
    store.state.cash = 10;
    assert.equal(evaluateLiveRisk(store, settings, now, 10), 'drawdown_limit');
    assert.equal(store.state.stopped, null);
    const flat = liveReadiness({ state: store.state, operationalReady: true });
    assert.equal(flat.readyForLive, false);
    assert.equal(flat.startAllowed, false);
    assert.ok(flat.blockers.includes('persistent_live_risk_stop'));
    expose(store, { cash: 8 });
    const exposed = liveReadiness({ state: store.state, operationalReady: false });
    assert.equal(exposed.readyForLive, false);
    assert.equal(exposed.startAllowed, true);
    assert.equal(exposed.recoveryOnly, true);
    assert.ok(exposed.blockers.includes('persistent_live_risk_stop'));
});
