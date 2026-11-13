import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { TradingClient, compatibleBookTick } from '../../src/restart/client.js';
import { ReadCoordinator } from '../../src/restart/network.js';
import { Store } from '../../src/restart/store.js';
import { riskReason, evaluate } from '../../src/restart/math.js';
import { newPosition, entryPlan, lateEntrySkipReason } from '../../src/restart/strategy.js';
import { Engine } from '../../src/restart/engine.js';

const spotEvent = (at, value) => ({ topic: 'prices.crypto', type: 'update',
    payload: { timestamp: at, value: String(value), symbol: 'btcusd' } });
const twapEvent = (at, value) => ({ ...spotEvent(at, value), topic: 'prices.crypto.twap',
    payload: { ...spotEvent(at, value).payload, windowSeconds: 60 } });
const legacyRule = { ...BASELINE.lateSignal, calibration: null };
function signalFixture(rule = legacyRule, now = 1791437880000) {
    const signal = new BtcSignal(rule);
    for (let i = -185; i <= 0; i++) signal.ingest(spotEvent(now + i * 1000, 83000), now + i * 1000 + 100);
    signal.ingest(twapEvent(now, 83000), now + 100);
    const market = { open: now - 280000, end: now + 20000, fee: { rate: 0.07, exponent: 1, takerOnly: true } };
    market.reference = { source: 'chainlink_twap_60s', open: market.open,
        end: market.end, value: 82970, observedAt: market.open, receivedAt: market.open + 100 };
    signal.openings.set(market.open, { at: market.open, value: 82970, receivedAt: market.open + 100 });
    const order = { index: 0, price: 0.85, shares: 5 };
    const settings = { ...BASELINE, lateSignal: rule, paperGasUsd: 0.05 };
    return { signal, now, market, order, settings, assess: () => signal.assess(market, order, settings, now + 200) };
}
test('TWAP research signal requires source agreement, causal history and fee-inclusive model edge', () => {
    const f = signalFixture(), result = f.assess();
    assert.equal(result.reason, null); assert.equal(result.projection, 83000);
    assert.equal(result.calibrated, false); assert.ok(result.modelEdge > 0.05);
    assert.ok(result.netCostPerShare > f.order.price + 0.01);
    f.settings.paperGasUsd = 1; assert.equal(f.assess().reason, 'btc_edge_insufficient');
});
test('a dominant ask never overrides opposite BTC/TWAP direction or an inadequate margin', () => {
    const f = signalFixture(); f.order.index = 1;
    assert.equal(f.assess().reason, 'btc_direction_disagrees');
    f.order.index = 0; f.market.reference.value = 82998; f.signal.openings.get(f.market.open).value = 82998;
    assert.equal(f.assess().reason, 'btc_edge_insufficient');
});
test('stale, future, wrong-symbol and out-of-order feed data cannot produce entry', () => {
    const f = signalFixture();
    const length = f.signal.spot.length;
    f.signal.ingest(spotEvent(f.now + 1000, 90000), f.now);
    f.signal.ingest(spotEvent(f.now - 1000, 90000), f.now);
    f.signal.ingest({ ...spotEvent(f.now, 90000), payload: { ...spotEvent(f.now, 90000).payload, symbol: 'eth/usd' } }, f.now);
    assert.equal(f.signal.spot.length, length); assert.equal(f.signal.spot.at(-1).value, 83000);
    assert.equal(f.signal.assess(f.market, f.order, f.settings, f.now + 5001).reason, 'btc_feed_stale_or_warming');
});
test('gaps and restart discard feed warmup; retained wallet position is independent', () => {
    const f = signalFixture();
    f.signal.ingest(spotEvent(f.now + 6000, 83000), f.now + 6000);
    f.signal.ingest(twapEvent(f.now + 6000, 83000), f.now + 6000);
    assert.equal(f.signal.spot.length, 1);
    assert.equal(f.signal.assess(f.market, f.order, f.settings, f.now + 6000).reason, 'btc_volatility_warmup');
    const restarted = new BtcSignal(BASELINE.lateSignal);
    assert.equal(restarted.assess(f.market, f.order, f.settings, f.now).reason, 'btc_feed_stale_or_warming');
});
test('fresh subscription snapshots cannot import old warmup data and declared drops reset history', () => {
    const f = signalFixture(), signal = new BtcSignal(legacyRule);
    signal.ingest({ topic: 'prices.crypto', type: 'subscribe', payload: { symbol: 'btcusd',
        data: f.signal.spot.map(p => ({ timestamp: p.at, value: String(p.value) })) } }, f.now + 100);
    assert.ok(signal.spot.length <= 5);
    signal.ingest(twapEvent(f.now, 83000), f.now + 100);
    signal.openings = f.signal.openings;
    assert.equal(signal.assess(f.market, f.order, f.settings, f.now + 200).reason, 'btc_volatility_warmup');
    f.signal.ingest({ ...spotEvent(f.now + 1000, 83000), dropped: 1 }, f.now + 1100);
    assert.equal(f.signal.spot.length, 1); assert.equal(f.signal.twap, null);
});

test('fitted temperature discounts an expensive overconfident TWAP entry without changing its projection', () => {
    const f = signalFixture(BASELINE.lateSignal, 1791700000000);
    const uncertainty = 1.5 * Math.sqrt(20 ** 3 / (3 * 60 ** 2));
    const reference = 83000 - (2 * uncertainty + 3);
    f.market.reference.value = reference; f.signal.openings.get(f.market.open).value = reference;
    f.order.price = 0.89;
    const adjusted = f.assess();
    assert.ok(Math.abs(adjusted.z - 2) < 0.00001);
    assert.ok(adjusted.rawModelProbability > 0.97);
    assert.ok(adjusted.modelProbability < 0.92);
    assert.ok(adjusted.rawModelEdge > 0.05);
    assert.ok(adjusted.modelEdge < 0.05);
    assert.equal(adjusted.reason, 'btc_edge_insufficient');
    assert.equal(adjusted.projection, 83000);
    assert.equal(adjusted.calibrated, false);
    assert.equal(adjusted.calibration.temperature, 1.5);
});

test('a frozen calibration cannot use outcomes later than the assessed market or an invalid temperature', () => {
    const f = signalFixture(BASELINE.lateSignal, 1791700000000);
    f.signal.rule = { ...BASELINE.lateSignal, calibration: { ...BASELINE.lateSignal.calibration,
        validationEndsAt: f.market.open } };
    assert.equal(f.assess().reason, 'btc_calibration_unverified');
    f.signal.rule = { ...BASELINE.lateSignal, calibration: { ...BASELINE.lateSignal.calibration, temperature: 0.5 } };
    assert.equal(f.assess().reason, 'btc_calibration_unverified');
});
test('two-second feed cadence has sufficient time coverage without pretending it is one-second data', () => {
    const f = signalFixture(); f.signal.spot = f.signal.spot.filter(p => p.at % 2000 === 0);
    assert.equal(f.assess().reason, null);
});
test('TWAP source divergence and market reference identity fail closed', () => {
    const f = signalFixture(); f.signal.twap.value += 4;
    assert.equal(f.assess().reason, 'btc_twap_source_mismatch');
    f.signal.twap.value -= 4;
    for (const reference of [null, { ...f.market.reference, source: 'spot' },
        { ...f.market.reference, open: f.market.open - 300000 }, { ...f.market.reference, receivedAt: f.market.open + 6000 }]) {
        f.market.reference = reference;
        assert.equal(f.assess().reason, 'btc_reference_unverified');
    }
});
test('opening TWAP must be independently observed and exactly match the retained market reference', () => {
    const f = signalFixture(); f.signal.openings.clear();
    assert.equal(f.assess().reason, 'btc_opening_twap_unobserved');
    f.signal.openings.set(f.market.open, { at: f.market.open, value: 82960 });
    assert.equal(f.assess().reason, 'btc_reference_unverified');
    const signal = new BtcSignal(BASELINE.lateSignal), opening = Math.floor(f.now / 300000) * 300000;
    signal.ingest(twapEvent(opening, 82970), opening + 100);
    assert.equal(signal.openings.get(opening).value, 82970);
    signal.ingest(twapEvent(opening + 1000, 82975), opening + 1100);
    assert.equal(signal.openings.get(opening).value, 82970);
});
test('remaining TWAP projects only the observed final minute and rejects missing coverage', () => {
    const f = signalFixture();
    f.signal.spot.forEach(p => { if (p.at <= f.now - 60000) p.value = 82990; });
    // Rolling average includes one earlier sample; independent check uses the same causal interval.
    f.signal.twap.value = f.signal.integral(f.now - 60000, f.now) / 60;
    assert.equal(f.assess().projection, 83000);
    f.signal.spot = f.signal.spot.filter(p => p.at > f.now - 30000);
    assert.notEqual(f.assess().reason, null);
});
test('entry before the settlement minute projects only its 60 seconds and includes the lead-time risk', () => {
    const f = signalFixture();
    f.market.end = f.now + 90000; f.market.open = f.market.end - 300000;
    f.market.reference = { ...f.market.reference, open: f.market.open, end: f.market.end,
        observedAt: f.market.open, receivedAt: f.market.open + 100 };
    f.signal.openings.set(f.market.open, { at: f.market.open, value: f.market.reference.value, receivedAt: f.market.open + 100 });
    const early = f.assess();
    assert.equal(early.reason, null); assert.equal(early.projection, 83000);
    assert.equal(early.knownSeconds, 0); assert.equal(early.futureWindowSeconds, 60); assert.equal(early.leadSeconds, 30);
    assert.ok(Math.abs(early.uncertainty - 1.5 * Math.sqrt(50)) < 0.00001);
    f.market.end = f.now + 60000; f.market.reference.end = f.market.end;
    const boundary = f.assess();
    assert.equal(boundary.projection, 83000); assert.equal(boundary.knownSeconds, 0);
    assert.equal(boundary.leadSeconds, 0); assert.ok(boundary.uncertainty < early.uncertainty);
    f.market.end = f.now + 59000; f.market.reference.end = f.market.end;
    const inside = f.assess();
    assert.equal(inside.projection, 83000); assert.equal(inside.knownSeconds, 1);
    assert.ok(inside.uncertainty < boundary.uncertainty);
});
test('an earlier cheap quote still cannot bypass TWAP uncertainty and net edge', () => {
    const f = signalFixture();
    f.market.end = f.now + 90000; f.market.reference.end = f.market.end;
    f.market.reference.value = 82995; f.signal.openings.get(f.market.open).value = 82995;
    assert.equal(f.assess().reason, 'btc_edge_insufficient');
});
test('skip diagnostics separate absent liquidity, price limits and funding constraints', () => {
    const f = signalFixture(), market = { ...f.market, accepting: true, minimum: 5, tokens: ['1', '2'] };
    const books = [{ asks: [{ price: 0.85, size: 10 }] }, { asks: [{ price: 0.16, size: 10 }] }];
    assert.equal(lateEntrySkipReason(market, books, f.settings, 3, f.now), 'insufficient_virtual_cash');
    books[0].asks = []; assert.equal(lateEntrySkipReason(market, books, f.settings, 20, f.now), 'missing_executable_ask');
    books[0].asks = [{ price: 0.99, size: 10 }];
    assert.equal(lateEntrySkipReason(market, books, f.settings, 20, f.now), 'ask_above_entry_maximum');
    books[0].asks[0].price = 0.79;
    assert.equal(lateEntrySkipReason(market, books, f.settings, 20, f.now), 'ask_below_entry_minimum');
    assert.equal(lateEntrySkipReason(market, books, f.settings, 20, market.end - 45000), 'no_entry_signal');
});
test('entry deadline exhaustion does not trip the endpoint transport circuit', async () => {
    const events = [], reads = new ReadCoordinator({ policy: { timeoutMs: 3000 }, onEvent: e => events.push(e) });
    await assert.rejects(reads.run('deadline', 'clob', 'book_read', async () => { await delay(50); return 1; },
        { deadline: Date.now() + 10 }), e => e.code === 'entry_window_elapsed' && e.category === 'opportunity');
    assert.equal(reads.state('clob').streak, 0); assert.equal(reads.state('clob').outageAt, null);
    assert.equal(events.find(e => e.type === 'read_failed').error.category, 'opportunity');
});
test('tick endpoint changing during snapshot gets one fresh reconciliation, never unlimited retries', async () => {
    const client = Object.create(TradingClient.prototype); client.settings = BASELINE;
    const market = { slug: 'tick', conditionId: 'condition', tokens: ['1', '2'], outcomes: ['Up', 'Down'],
        minimum: 5, tick: 0.01, fee: { rate: 0.07, exponent: 1 } };
    client.marketInfo = async () => ({ tickSize: 0.01, negRisk: false, feeInfo: market.fee,
        tokens: [{ assetId: '1', outcome: 'Up' }, { assetId: '2', outcome: 'Down' }] });
    let checks = 0, books = 0; const events = [];
    client.onEvent = event => events.push(event);
    client.tickSize = async () => ++checks <= 2 ? 0.01 : 0.001;
    client.public = { fetchOrderBook: async ({ assetId }) => { books++; return { assetId, conditionId: 'condition',
        negRisk: false, minOrderSize: '5', tickSize: 0.001, timestamp: Date.now(), bids: [], asks: [] }; } };
    await client.books(market); assert.deepEqual(market.ticks, [0.001, 0.001]);
    assert.equal(checks, 4); assert.equal(books, 6); assert.equal(events[0].type, 'tick_snapshot_conflict');
});
test('fresh book with lagging coarser tick is usable only on a twice-verified finer exchange grid', async t => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const client = Object.create(TradingClient.prototype); client.settings = BASELINE;
    const market = { slug: 'lag', conditionId: 'condition', tokens: ['1', '2'], outcomes: ['Up', 'Down'],
        minimum: 5, tick: 0.001, fee: { rate: 0.07, exponent: 1 } };
    const events = []; let tickCalls = 0, bookCalls = 0;
    client.onEvent = e => events.push(e);
    client.marketInfo = async () => ({ tickSize: 0.001, negRisk: false, feeInfo: market.fee,
        tokens: [{ assetId: '1', outcome: 'Up' }, { assetId: '2', outcome: 'Down' }] });
    client.tickSize = async () => { tickCalls++; return 0.001; };
    client.public = { fetchOrderBook: async ({ assetId }) => { bookCalls++; return {
        assetId, conditionId: 'condition', negRisk: false, minOrderSize: '5', tickSize: 0.01,
        timestamp: now, bids: [{ price: '0.79', size: '5' }], asks: [{ price: '0.8', size: '5' }] }; } };
    assert.equal((await client.books(market))[0].asks[0].price, 0.8);
    assert.equal(tickCalls, 4); assert.equal(bookCalls, 6);
    assert.ok(events.some(e => e.type === 'book_tick_lag_verified'));
    now += 1000; await client.books(market); assert.equal(tickCalls, 4); assert.equal(bookCalls, 8);
    now += 5000; await client.books(market); assert.equal(tickCalls, 8);
    assert.equal(compatibleBookTick({ tickSize: 0.01, bids: [], asks: [{ price: '0.8005' }] }, 0.001), false);
    assert.equal(compatibleBookTick({ tickSize: 0.001, bids: [], asks: [{ price: '0.801' }] }, 0.01), false);
    now += 6000; client.tickSize = async () => 0.0007;
    await assert.rejects(client.books(market), e => e.code === 'tick_snapshot_mismatch');
});
test('paper research continues after shadow $2 stop, persists it, and hard-stops at $10', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-shadow-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, fingerprint: 'shadow', dataDir, paperGasUsd: 0.05 };
    const store = new Store(settings, 'paper', 'late-entry'); store.logger = () => {};
    assert.equal(riskReason(store.state, settings, Date.now(), 17.9), null);
    store.state.cash = 17.9; store.save();
    const restarted = new Store(settings, 'paper', 'late-entry');
    assert.equal(restarted.state.shadowPilotStop.reason, 'drawdown_limit');
    riskReason(restarted.state, settings, Date.now(), 21);
    assert.ok(evaluate(restarted.state, settings).reasons.includes('shadow_pilot_drawdown_limit'));
    assert.equal(riskReason(restarted.state, settings, Date.now(), 10.9), 'paper_drawdown_limit');
    const pilot = new Store(settings, 'pilot', 'late-entry');
    assert.equal(riskReason(pilot.state, settings, Date.now(), 17.9), 'drawdown_limit');
});
test('signal expires during paper latency without a fill or another entry attempt', async t => {
    const f = signalFixture(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-causal-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...f.settings, dataDir, fingerprint: 'causal' };
    let now = f.now; t.mock.method(Date, 'now', () => now);
    const store = new Store(settings, 'paper', 'late-entry'); store.logger = () => {};
    const market = { ...f.market, tokens: ['1', '2'], slug: `btc-updown-5m-${Math.floor(now / 300000) * 300}`,
        accepting: true, minimum: 5, open: Math.floor(now / 300000) * 300000, end: Math.floor(now / 300000) * 300000 + 300000 };
    now = market.end - 25000;
    const books = [{ bids: [{ price: 0.84, size: 10 }], asks: [{ price: 0.85, size: 10 }] },
        { bids: [{ price: 0.14, size: 10 }], asks: [{ price: 0.15, size: 10 }] }];
    let valid = true;
    const client = { serverTime: async () => now, market: async () => market, books: async () => books,
        assessEntry: () => ({ reason: valid ? null : 'btc_edge_insufficient' }) };
    const feed = { generation: 0, close() {}, drain: () => [] };
    const engine = new Engine(settings, store, client, feed);
    await engine.tick(); assert.ok(store.state.position);
    valid = false; now += 250; await engine.tick();
    assert.equal(store.state.position, null); assert.equal(store.state.completed[0].traded, false);
    await engine.tick(); assert.equal(Object.keys(store.state.seen).length, 1);
});
