import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';
import { PremarketHistory, premarketFeatures } from '../../src/premarket-paper/features.js';

const arms = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
function fixture(t, { direction = -1, durable = false, providers = null, activeArms } = {}) {
    const open = Date.parse('2026-10-26T00:10:00Z'), scheduledAt = open - 240000;
    let now = scheduledAt, prices = [.5, .5], sizes = [10, 10], payout = null, readsAdvance = 0, bookOffset = 0;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-engine-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: 'premarket-test', dataDir, policy: {}, sources: [], armNames: arms,
        capital: 20, shares: 5, entryCap: 5, leadSeconds: 240, slots: [90, 60, 30], slotToleranceMs: 2000,
        dataAgeMs: 5000, maxGapMs: 5000, diagnosticHistoryMs: 900000, latencyMs: 250, settlementMs: 2500,
        reportMs: 60000, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, costCapPerShare: .85,
        drawdownStop: 10, aiDecisionMs: 30000, ...(activeArms === undefined ? {} : { activeArms }),
        providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' },
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const btc = new BtcSignal(config.control.lateSignal);
    const feed = at => {
        btc.ingest({ type: 'update', topic: 'prices.crypto', payload: { symbol: 'btcusd', timestamp: at,
            value: 83000 + direction * (at - scheduledAt) / 1000 } }, at);
        btc.ingest({ type: 'update', topic: 'prices.crypto.twap', payload: { symbol: 'btcusd', timestamp: at,
            value: 83000 + direction * (at - scheduledAt) / 1000, windowSeconds: 60 } }, at);
    };
    for (let at = now - 185000; at <= now; at += 1000) feed(at);
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const getBooks = () => market.tokens.map((tokenId, index) => ({ tokenId, conditionId: market.conditionId,
        tick: market.ticks[index], timestamp: now + bookOffset, fetchedAt: now + bookOffset,
        bids: [{ price: prices[index] - .01, size: 10 }], asks: [{ price: prices[index], size: sizes[index] }] }));
    const stream = { generation: 1, tokens: market.tokens, watch() {}, close() {}, snapshot: getBooks };
    const events = [], store = new PremarketPaperStore(config, now);
    store.event = (type, detail = {}) => { events.push({ type, ...structuredClone(detail) }); if (durable) store.save(); };
    store.error = (stage, error) => { store.state.errors[`${stage}:${error.message}`] = true; };
    const client = { btc, startBtcFeed() {}, close() {}, serverTime: async () => now,
        market: async () => { now += readsAdvance; return structuredClone(market); },
        books: async () => getBooks(), payout: async () => payout };
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, makeBooks: () => stream, providers });
    engine.markets.set(market.slug, market); engine.streams.set(market.slug, stream);
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.history.capture(btc, now);
    const key = `${market.slug}:premarket`;
    store.state.slots[key] = { scheduledAt, status: 'reserved' };
    store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    return { config, store, engine, market, btc, stream, events, key, scheduledAt,
        get now() { return now; }, advance(ms) { now += ms; }, prices(value) { prices = value; }, sizes(value) { sizes = value; },
        payout(value) { payout = value; }, bookOffset(value) { bookOffset = value; }, readsAdvance(value) { readsAdvance = value; },
        feed(at = now) { feed(at); engine.history.capture(btc, at); },
        async observe() { await engine.observePremarket(market.slug, scheduledAt, key); },
        arm(name = 'premarket-momentum') { return store.state.arms[name]; } };
}

test('symmetric completed minute candles exclude new candle and future receipt prices', t => {
    for (const direction of [-1, 1]) {
        const f = fixture(t, { direction });
        const points = structuredClone(f.engine.history.points);
        points.at(-1).value = direction < 0 ? 999999 : 1;
        const result = premarketFeatures(points, f.market, f.scheduledAt, f.config);
        assert.equal(result.action, direction < 0 ? 'BUY_DOWN' : 'BUY_UP');
        assert.equal(result.bars.at(-1).end, f.scheduledAt);
        assert.notEqual(result.bars.at(-1).close, points.at(-1).value);
        assert.equal(result.openingTwap.value, null);
        points.forEach(point => { point.receivedAt = f.scheduledAt + 1; });
        assert.equal(premarketFeatures(points, f.market, f.scheduledAt, f.config).action, 'SKIP');
    }
});

test('history gaps reset warmup and diagnostic history never claims an unavailable 15 minutes', t => {
    const f = fixture(t), result = premarketFeatures(f.engine.history.points, f.market, f.scheduledAt, f.config);
    assert.equal(result.diagnosticOnly.full15MinutesAvailable, false);
    const history = new PremarketHistory(f.config);
    history.capture({ spot: [{ at: 1000, receivedAt: 1000, value: 10 }, { at: 8000, receivedAt: 8000, value: 9 }] }, 8000);
    assert.equal(history.points.length, 1);
    const missing = f.engine.history.points.filter(point => point.at < f.scheduledAt - 70000 || point.at > f.scheduledAt - 60000);
    assert.equal(premarketFeatures(missing, f.market, f.scheduledAt, f.config).reason, 'btc_history_gap');
});

test('premarket fills at fixed limit after 250ms and settles only official payout with fees and gas', async t => {
    const f = fixture(t);
    await f.observe();
    assert.equal(f.arm().positions[f.market.slug].order.index, 1);
    assert.equal(f.arm().positions[f.market.slug].order.price, .51);
    f.engine.executePending(f.now + 250); assert.equal(f.arm().cash, 20);
    f.advance(249); f.engine.executePending(); assert.equal(f.arm().cash, 20);
    f.advance(1); f.sizes([10, 2]); f.engine.executePending();
    const position = f.arm().positions[f.market.slug];
    assert.equal(position.status, 'matched'); assert.equal(position.holdings, 2);
    assert.equal(f.arm().cash, 18.965);
    f.advance(f.market.end - f.now + 3000); await f.engine.settle();
    assert.equal(f.arm().completed.length, 0); assert.ok(f.arm().positions[f.market.slug]);
    f.payout([0, 1]); f.advance(15000); await f.engine.settle();
    assert.equal(f.arm().completed.length, 1); assert.equal(f.arm().completed[0].pnl, .915);
    assert.equal(f.arm().cash, 20.915); assert.equal(f.arm().completed[0].partial, true);
    await f.engine.settle(); assert.equal(f.arm().completed.length, 1); assert.equal(f.arm().cash, 20.915);
});

test('execution does not chase a moving ask and rejects stale or future books', async t => {
    for (const mode of ['moves', 'stale', 'future']) {
        const f = fixture(t); await f.observe(); f.advance(250);
        if (mode === 'moves') f.prices([.5, .53]);
        if (mode === 'stale') f.bookOffset(-5001);
        if (mode === 'future') f.bookOffset(1);
        f.engine.executePending();
        assert.equal(f.arm().cash, 20); assert.equal(Object.keys(f.arm().positions).length, 0);
        assert.equal(f.arm().outcomes[f.market.slug].noExposure, true);
        assert.equal(f.arm().outcomes[f.market.slug].reason, mode === 'moves' ? 'no_fill' : 'execution_expired');
    }
});

test('full initial depth is required but a smaller delayed FAK fill is valid', async t => {
    const f = fixture(t); f.sizes([10, 2]); await f.observe();
    assert.equal(f.arm().outcomes[f.market.slug].reason, 'entry_constraints_not_met');
    assert.equal(f.arm().cash, 20);
});

test('AI can decide after 20s with fresh execution books and original limit', async t => {
    let deliver;
    const providers = { predict: () => new Promise(resolve => { deliver ||= resolve; }), close() {} };
    const f = fixture(t, { providers });
    f.config.providerArms = { 'laya-premarket': 'laya' };
    await f.observe();
    f.advance(20000); f.feed(); f.engine.clockVerifiedAt = f.now;
    deliver({ status: 'ok', action: 'BUY_DOWN', receivedAt: f.now, cost: null });
    await Promise.all([...f.engine.tasks]);
    const arm = f.arm('laya-premarket');
    assert.equal(arm.positions[f.market.slug].order.price, .51);
    f.advance(250); f.engine.executePending();
    assert.equal(arm.positions[f.market.slug].status, 'matched');
    assert.equal(f.store.state.snapshots[0].decisions['laya-premarket'].entryDisposition, 'reserved');
});

test('AI late responses and stale capture are rejected before creating exposure', async t => {
    let deliver;
    const providers = { predict: () => new Promise(resolve => { deliver = resolve; }), close() {} };
    const f = fixture(t, { providers }); f.config.providerArms = { 'laya-premarket': 'laya' };
    await f.observe(); f.advance(30001); deliver({ status: 'ok', action: 'BUY_UP' });
    await Promise.all([...f.engine.tasks]);
    assert.equal(f.arm('laya-premarket').outcomes[f.market.slug].reason, 'provider_late');
    const g = fixture(t, { providers });
    g.engine.history.points = g.engine.history.points.filter(point => point.at <= g.scheduledAt - 4000);
    g.readsAdvance(1500);
    await assert.rejects(g.observe(), /stale_input_at_capture/);
});

test('restart cancels pending executions, preserves matched cash, and never reruns provider requests', async t => {
    const f = fixture(t, { durable: true }); await f.observe();
    const restored = new PremarketPaperStore(f.config, f.now + 1);
    assert.equal(restored.state.arms['premarket-momentum'].cash, 20);
    assert.equal(restored.state.arms['premarket-momentum'].outcomes[f.market.slug].reason, 'restart_during_pending_execution');
    const g = fixture(t, { durable: true }); await g.observe(); g.advance(250); g.engine.executePending();
    g.store.state.snapshots[0].decisions['router-premarket'] = { status: 'requested' };
    delete g.arm('router-premarket').outcomes[g.market.slug]; g.store.save();
    const resumed = new PremarketPaperStore(g.config, g.now + 1);
    assert.equal(resumed.state.arms['premarket-momentum'].cash, g.arm().cash);
    assert.equal(resumed.state.arms['premarket-momentum'].positions[g.market.slug].status, 'matched');
    assert.equal(resumed.state.arms['router-premarket'].outcomes[g.market.slug].reason, 'restart_during_provider_request');
});

test('pending cash and settlement gas are reserved independently for each arm', async t => {
    const f = fixture(t); await f.observe();
    assert.ok(f.engine.availableCash(f.arm()) < 17.5);
    assert.equal(f.engine.availableCash(f.arm('late-cost-cap')), 20);
    f.advance(250); f.engine.executePending();
    assert.equal(f.engine.availableCash(f.arm()), round6(f.arm().cash - .05));
});

test('a second market is skipped while an arm has active inventory', async t => {
    const f = fixture(t); await f.observe();
    const snapshot = structuredClone(f.store.state.snapshots[0]);
    snapshot.market.slug = 'btc-updown-5m-another';
    const decision = { action: 'BUY_DOWN' };
    f.engine.admit('premarket-momentum', snapshot, decision, { market: f.market, validation: {} }, false);
    assert.equal(decision.entryDisposition, 'active_market_limit');
    assert.equal(Object.keys(f.arm().positions).length, 1);
});

test('late comparison uses existing eligibility and fee-inclusive cap on the same cohort', async t => {
    for (const ask of [.78, .84]) {
        const f = fixture(t), at = f.market.end - 90000;
        f.advance(at - f.now); f.engine.clockVerifiedAt = f.now;
        f.btc.spot = []; f.btc.twap = null;
        for (let pointAt = at - 185000; pointAt <= at; pointAt += 1000) {
            f.btc.ingest({ type: 'update', topic: 'prices.crypto', payload: { symbol: 'btcusd', timestamp: pointAt, value: 83020 } }, pointAt);
        }
        f.btc.ingest({ type: 'update', topic: 'prices.crypto.twap', payload: { symbol: 'btcusd', timestamp: at, value: 83020, windowSeconds: 60 } }, at);
        f.btc.openings.set(f.market.open, { at: f.market.open, value: 83000, receivedAt: f.market.open + 100 });
        f.prices([ask, .22]);
        const key = `${f.market.slug}:late:90`;
        f.store.state.slots[key] = { status: 'reserved', scheduledAt: at };
        await f.engine.observeLate(f.market.slug, at, key);
        const arm = f.arm('late-cost-cap');
        if (ask === .78) {
            assert.equal(arm.positions[f.market.slug].order.index, 0);
            assert.equal(arm.positions[f.market.slug].order.price, .79);
            f.advance(250); f.engine.executePending(); assert.equal(arm.positions[f.market.slug].status, 'matched');
        } else {
            assert.equal(Object.keys(arm.positions).length, 0);
            assert.equal(f.store.state.slots[key].reason, 'entry_cost_above_cap');
            assert.equal(arm.cash, 20);
        }
    }
});

test('router-only paper retains all arms but never predicts or admits inactive arms', async t => {
    const calls = [], providers = { async predict(name) {
        calls.push(name); return { status: 'ok', action: 'BUY_DOWN' };
    }, close() {} };
    const f = fixture(t, { providers, activeArms: ['router-premarket'] });
    const stopped = { at: f.now - 1, reason: 'realized_drawdown_limit', drawdown: 10 };
    f.arm().stopped = structuredClone(stopped);
    await f.observe(); await Promise.all([...f.engine.tasks]);
    assert.deepEqual(calls, ['router']);
    assert.deepEqual(Object.keys(f.store.state.arms), arms);
    assert.deepEqual(f.store.state.activeArms, ['router-premarket']);
    assert.deepEqual(f.arm().stopped, stopped);
    for (const name of arms.filter(name => name !== 'router-premarket')) {
        assert.equal(f.arm(name).cash, 20);
        assert.deepEqual(f.arm(name).positions, {});
        assert.equal(f.arm(name).outcomes[f.market.slug].reason, 'arm_not_selected');
    }
    const snapshot = f.store.state.snapshots[0];
    assert.equal(snapshot.decisions['premarket-momentum'].action, 'SKIP');
    assert.equal(snapshot.decisions['laya-premarket'].inferenceAttempted, false);
    const decision = { action: 'BUY_DOWN' };
    f.engine.admit('premarket-momentum', snapshot, decision, null, false);
    assert.equal(decision.entryDisposition, 'arm_not_selected');
    f.advance(250); f.engine.executePending();
    assert.equal(f.arm('router-premarket').positions[f.market.slug].status, 'matched');
    assert.equal(f.events.filter(event => event.type === 'fill_matched').length, 1);
});

test('inactive late control skips before market reads and pending execution', async t => {
    const f = fixture(t, { activeArms: ['router-premarket'] });
    f.engine.validated = async () => { assert.fail('inactive late arm must not read market or books'); };
    const key = `${f.market.slug}:late:90`;
    f.store.state.slots[key] = { status: 'reserved' };
    await f.engine.observeLate(f.market.slug, f.market.end - 90000, key);
    assert.equal(f.store.state.slots[key].reason, 'arm_not_selected');
    assert.equal(f.arm('late-cost-cap').outcomes[f.market.slug].reason, 'arm_not_selected');
    const pendingSlug = `${f.market.slug}-pending`;
    f.arm('late-cost-cap').positions[pendingSlug] = { status: 'pending', activeAt: f.now + 1000 };
    f.engine.executePending();
    assert.deepEqual(f.arm('late-cost-cap').positions, {});
    assert.equal(f.arm('late-cost-cap').outcomes[pendingSlug].reason, 'arm_not_selected');
    assert.equal(f.arm('late-cost-cap').cash, 20);
});

test('provider decision events include terminal skips, returned errors, thrown errors and late results', async t => {
    for (const disposition of ['provider_skip', 'provider_error', 'provider_failed', 'provider_late']) {
        let f;
        const providers = { async predict() {
            if (disposition === 'provider_failed') throw new Error('synthetic_provider_failure');
            if (disposition === 'provider_late') f.advance(30001);
            return { status: disposition === 'provider_error' ? 'provider_error' : 'ok',
                action: disposition === 'provider_late' ? 'BUY_UP' : 'SKIP' };
        }, close() {} };
        f = fixture(t, { providers, activeArms: ['router-premarket'] });
        await f.observe(); await Promise.all([...f.engine.tasks]);
        const events = f.events.filter(event => event.type === 'provider_decision');
        assert.equal(events.length, 1, disposition);
        assert.equal(events[0].entryDisposition, disposition);
        assert.equal(events[0].snapshotId, f.store.state.snapshots[0].snapshotId);
        assert.equal(f.arm('router-premarket').outcomes[f.market.slug].reason, disposition);
        assert.deepEqual(f.arm('router-premarket').positions, {});
    }
});
const round6 = value => Math.round(value * 1e6) / 1e6;
