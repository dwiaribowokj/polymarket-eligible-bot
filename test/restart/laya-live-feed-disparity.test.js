import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError } from '../../src/restart/network.js';
import { marketSlug } from '../../src/restart/strategy.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { BtcSignal } from '../../src/laya-live/signal.js';

const start = Date.parse('2026-10-23T15:28:30Z');
const feedEvent = (at, value, twap = false) => ({
    topic: twap ? 'prices.crypto.twap' : 'prices.crypto', type: 'update',
    payload: { timestamp: at, value, symbol: 'btcusd', ...(twap ? { windowSeconds: 60 } : {}) },
});

function fixture(t, provider = 'eligible') {
    let now = start;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_feed_fixture'); });
    const settings = { ...BASELINE, paperGasUsd: .05 };
    const config = { settings, policy: { provider, aiSource: 'offline-feed-source' }, ai: {
        slots: [90, 60], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
    } };
    const market = { slug: marketSlug('late-entry', settings, now), conditionId: 'fixture-condition',
        open: start - 210000, end: start + 90000, accepting: true, minimum: 5,
        tick: .01, ticks: [.01, .01], tokens: ['fixture-up', 'fixture-down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const signal = new BtcSignal(BASELINE.lateSignal);
    signal.ingest(feedEvent(market.open, 82970, true), market.open);
    market.reference = { source: 'chainlink_twap_60s', open: market.open, end: market.end,
        value: 82970, observedAt: market.open, receivedAt: market.open };
    for (let at = now - 185000; at <= now; at += 1000) signal.ingest(feedEvent(at, 83000), at);
    signal.ingest(feedEvent(now, 83000, true), now);
    const bookRows = () => [
        { bids: [{ price: .77, size: 10 }], asks: [{ price: .78, size: 10 }] },
        { bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] },
    ].map((book, index) => ({ ...book, tokenId: market.tokens[index], conditionId: market.conditionId,
        tick: .01, timestamp: now, fetchedAt: now }));
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 3600000,
        cash: 20, walletStart: 20, walletCashDelta: 0, peakEquity: 20, maxDrawdown: 0,
        failures: 0, stopped: null, position: null, seen: {}, completed: [] };
    const events = [];
    const store = { state, save() {}, event(type, detail) { events.push({ type, detail }); },
        stop(reason) { state.stopped ||= { reason, at: now }; } };
    const client = { btc: signal, books: t.mock.fn(async () => bookRows()),
        marketInfo: t.mock.fn(async () => ({})), validateInfo: t.mock.fn(),
        confirmedBlock: async () => 123, balance: async () => 20, holdings: async () => [0, 0],
        warmOrderMetadata: async () => {},
        prepare: t.mock.fn(async () => ({ orderId: 'offline-order', signed: { fixtureOnly: true } })),
        post: t.mock.fn(async () => { throw new Error('unexpected_order_post'); }) };
    const providers = { predict: t.mock.fn(async (_provider, snapshot) => ({
        provider, snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP',
        model: provider === 'eligible' ? 'deterministic-eligible-v1' : 'typed-decisions',
        inferenceAttempted: false, requestedAt: now, receivedAt: now, latencyMs: 0,
    })) };
    const engine = new LayaLiveEngine(config, store, client,
        { generation: 1, tokens: market.tokens, snapshot: bookRows }, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    t.mock.method(engine, 'awaitExecutionLatency', async () => { now += 250; });
    engine.current = market;
    engine.beforeReservation = t.mock.fn(async () => false);
    const submission = t.mock.method(engine.broker, 'submit');
    return { engine, signal, state, market, client, providers, events, store, submission,
        advance(ms) {
            const end = now + ms;
            for (let at = signal.spot.at(-1).at + 1000; at <= end; at += 1000) {
                signal.ingest(feedEvent(at, 83000), at);
                signal.ingest(feedEvent(at, 83000, true), at);
            }
            now = end;
        } };
}

for (const provider of ['laya', 'eligible']) test(`${provider}: TWAP disagreement consumes one flat slot and a fresh next slot can validate`, async t => {
    const f = fixture(t, provider);
    f.signal.twap.value += 4;
    const assessment = f.signal.assess(f.market, { index: 0, price: .79, shares: 5 }, f.engine.settings, Date.now());
    assert.equal(assessment.reason, 'btc_twap_source_mismatch');
    assert.equal(assessment.feedDifference, 4); assert.equal(f.signal.rule.maxFeedDifferenceUsd, 3);
    await f.engine.discover();
    const key = `${f.market.slug}:90`;
    assert.equal(f.state.ai.slots[key].status, 'feed_disparity');
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(f.state.ai.snapshots.length, 0); assert.equal(f.providers.predict.mock.callCount(), 0);
    assert.equal(f.submission.mock.callCount(), 0); assert.equal(f.client.prepare.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
    assert.deepEqual(f.events.find(event => event.type === 'laya_feed_disparity_wait').detail,
        { key, reason: 'btc_twap_source_mismatch', category: 'opportunity', stage: 'btc_feed',
            feedDifferenceUsd: 4, maxFeedDifferenceUsd: 3, spotAt: start, twapAt: start });
    await f.engine.discover();
    assert.equal(f.client.books.mock.callCount(), 1, 'the rejected slot cannot replay');
    f.advance(30000);
    await f.engine.discover();
    assert.equal(f.client.books.mock.callCount(), 2); assert.equal(f.client.marketInfo.mock.callCount(), 2);
    assert.equal(f.providers.predict.mock.callCount(), 1); assert.equal(f.engine.beforeReservation.mock.callCount(), 1);
    assert.equal(f.state.ai.snapshots[0].entryDisposition, 'diagnostic_veto');
    assert.equal(f.state.ai.slots[key].status, 'feed_disparity');
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null);
    assert.equal(f.submission.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
});

test('TWAP disagreement arising after a decision still skips before reservation', async t => {
    const f = fixture(t), predict = f.providers.predict;
    f.providers.predict = async (...args) => {
        const decision = await predict(...args); f.signal.twap.value += 4; return decision;
    };
    await f.engine.discover();
    assert.equal(f.state.ai.slots[`${f.market.slug}:90`].status, 'feed_disparity');
    assert.equal(f.state.ai.snapshots[0].entryDisposition, 'btc_twap_source_mismatch');
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(f.submission.mock.callCount(), 0); assert.equal(f.client.prepare.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
});

test('TWAP disagreement after reservation remains fatal and cannot sign or post', async t => {
    const f = fixture(t), event = f.store.event.bind(f.store);
    delete f.engine.beforeReservation;
    f.store.event = (type, detail) => {
        event(type, detail);
        if (type === 'entry_reserved') f.signal.twap.value += 4;
    };
    await f.engine.discover();
    assert.equal(f.state.stopped.reason, 'stale_or_invalid_execution_data');
    assert.ok(f.state.position); assert.ok(f.state.seen[f.market.slug]);
    assert.equal(f.submission.mock.callCount(), 1); assert.equal(f.state.position.submitAttemptedAt, Date.now());
    assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
    assert.equal(f.events.some(event => event.type === 'laya_feed_disparity_wait'), false);
});

test('TWAP disagreement does not hide future data or invalid source identity', async t => {
    for (const fault of ['future_spot', 'future_receive', 'future_twap', 'future_reference', 'wrong_source']) {
        await t.test(fault, async t => {
            const f = fixture(t);
            f.signal.twap.value += 4;
            // Mutate only after valid features are assembled, at the final signal gate.
            const assessSignal = f.engine.assertSignal.bind(f.engine);
            f.engine.assertSignal = (...args) => {
                if (fault === 'future_spot') f.signal.spot.at(-1).at = Date.now() + 1;
                if (fault === 'future_receive') f.signal.spot.at(-1).receivedAt = Date.now() + 1;
                if (fault === 'future_twap') f.signal.twap.at = Date.now() + 1;
                if (fault === 'future_reference') f.market.reference.receivedAt = Date.now() + 1;
                if (fault === 'wrong_source') f.market.reference.source = 'other_feed';
                return assessSignal(...args);
            };
            await f.engine.discover();
            assert.equal(f.state.stopped.reason, 'operational_check_failed');
            assert.equal(f.state.position, null); assert.equal(f.providers.predict.mock.callCount(), 0);
            assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
            assert.equal(f.events.some(event => event.type === 'laya_feed_disparity_wait'), false);
        });
    }
});

test('a mismatch error without the identified pre-entry numeric check remains fatal', async t => {
    for (const error of [new Error('btc_twap_source_mismatch'),
        new OperationalError('btc_twap_source_mismatch', 'validation', { stage: 'btc_feed' }),
        new OperationalError('btc_twap_source_mismatch', 'opportunity', { stage: 'other_stage' })]) {
        await t.test(`${error.category || 'untyped'}:${error.stage || 'unknown'}`, async t => {
            const f = fixture(t);
            f.engine.observe = async () => { throw error; };
            await f.engine.discover();
            assert.equal(f.state.stopped.reason, 'operational_check_failed');
            assert.equal(f.state.position, null); assert.equal(f.client.post.mock.callCount(), 0);
        });
    }
});
