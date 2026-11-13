import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createSecureClient, OrderSide, OrderType } from '@polymarket/client';
import { prepareLimitOrder } from '@polymarket/client/actions';
import { candidateChecks, metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { LayaLiveEngine, entryGuard } from '../../src/laya-live/engine.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';

const start = Date.parse('2026-10-16T00:04:00Z');
const fakMessage = 'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.';

function fixture(index = 0) {
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, late: { duration: 300 },
        lateQuality: { maxSpread: .03, minDepth: 5 } };
    const config = { settings, policy: { aiSource: 'offline-fak-source' }, ai: {
        slots: [60], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
    } };
    const market = { slug: marketSlug('late-entry', settings, start), conditionId: 'fixture-condition',
        open: start - 240000, end: start + 60000, accepting: true, minimum: 5,
        tick: .01, ticks: [.01, .01], tokens: ['fixture-up', 'fixture-down'], outcomes: ['Up', 'Down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, negRisk: false };
    const spec = { index, tokenId: market.tokens[index], snapshotPrice: .77, price: .78,
        shares: 5, side: 'BUY', kind: 'taker', cost: 4.01006 };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 1000, cash: 20,
        peakEquity: 20, maxDrawdown: 0, failures: 0, completed: [], seen: {}, stopped: null, position: null,
        walletStart: 20, walletCashDelta: 0, liveFunding: { initialCapital: 20 } };
    const snapshot = { snapshotId: 'fixture-snapshot', at: start, observedAt: start - 1480,
        decisionReceivedAt: start + 2671, validation: { at: start, generation: 1, identity: metadataIdentity(market) },
        allowed: [spec] };
    const decision = { snapshotId: snapshot.snapshotId, status: 'ok', model: 'typed-decisions',
        action: index === 0 ? 'BUY_UP' : 'BUY_DOWN' };
    const books = market.tokens.map((tokenId, i) => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: start - 1480, fetchedAt: start - 1480,
        bids: [{ price: i === index ? .76 : .22, size: 10 }],
        asks: [{ price: i === index ? .77 : .23, size: 10 }] }));
    const events = [], persisted = [];
    const store = { state, save() { persisted.push(structuredClone(state)); },
        event(type, detail = {}) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: start }; this.save(); } };
    const setAsk = (price, size = 10) => {
        books[index].asks = [{ price, size }]; books[index].bids = [{ price: price - .01, size: 10 }];
    };
    return { settings, config, market, spec, state, snapshot, decision, books, store, events, persisted,
        now: start + 2671, setAsk };
}

test('a newly valid price above the immutable FAK limit cannot pass the live entry guard', () => {
    for (const index of [0, 1]) {
        const f = fixture(index); f.setAsk(.79);
        const fresh = candidateChecks(f.market, f.books,
            { ...f.config.ai, limitSlippageTicks: 0, limitSlippageUsd: 0 }, f.state.cash, f.now, false);
        assert.equal(fresh[index].order.price, .79, 'the current quote still passes the general price band');
        const before = structuredClone(f.spec);
        assert.throws(() => entryGuard(f), /execution_limit_unmarketable/);
        assert.deepEqual(f.spec, before, 'execution checks must never reprice or change the selected outcome');
    }
});

test('an ask at or below the committed limit remains executable without repricing', () => {
    for (const index of [0, 1]) for (const ask of [.76, .77, .78]) {
        const f = fixture(index); f.setAsk(ask);
        const before = structuredClone(f.spec);
        assert.doesNotThrow(() => entryGuard(f));
        assert.deepEqual(f.spec, before);
    }
});

test('positive partial depth within the committed limit remains allowed for FAK', () => {
    const f = fixture(); f.setAsk(.78, .25);
    f.books[0].asks.push({ price: .79, size: 100 });
    assert.doesNotThrow(() => entryGuard(f));
    assert.equal(f.spec.price, .78); assert.equal(f.spec.shares, 5);
});

test('depth beyond the committed limit cannot make an unmarketable FAK executable', () => {
    const f = fixture(); f.setAsk(.79, 100);
    f.books[0].asks.push({ price: .80, size: 1000 });
    assert.throws(() => entryGuard(f), /execution_limit_unmarketable/);
});

test('changed execution constraints retain their exact reason and immutable-limit witness', () => {
    const cases = [
        ['ask_above_entry_maximum', f => f.setAsk(.91)],
        ['ask_below_entry_minimum', f => f.setAsk(.70)],
        ['wide_spread', f => { f.setAsk(.78); f.books[0].bids[0].price = .70; }],
        ['crossed_book', f => { f.setAsk(.78); f.books[0].bids[0].price = .79; }],
        ['missing_bid_or_ask', f => { f.books[0].bids = []; }],
        ['market_not_accepting', f => { f.market.accepting = false; }],
    ];
    for (const [reason, change] of cases) {
        const f = fixture(); change(f); const original = structuredClone(f.spec);
        assert.throws(() => entryGuard(f), error => {
            assert.equal(error.message, 'execution_constraints_changed');
            assert.equal(error.constraintReason, reason);
            assert.equal(error.execution.snapshotId, f.snapshot.snapshotId);
            assert.equal(error.execution.limitPrice, original.price);
            assert.equal(error.execution.bestAsk, f.books[0].asks[0].price);
            return true;
        });
        assert.deepEqual(f.spec, original);
        assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
    }
});

test('a price move discovered by the broker retains the reservation and performs zero POSTs', async t => {
    for (const phase of ['before_prepare', 'after_prepare']) await t.test(phase, async t => {
        t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_fak_fixture'); });
        const f = fixture(), orderId = `0x${'a'.repeat(64)}`, signed = { orderType: 'FAK', fixtureOnly: true };
        f.state.seen[f.market.slug] = { at: start, snapshotId: f.snapshot.snapshotId };
        f.state.position = newPosition(f.market, { orders: [f.spec], cost: f.spec.cost }, f.state, start);
        const reservation = structuredClone(f.state.seen);
        const client = { prepare: t.mock.fn(async spec => {
            assert.equal(spec.price, .78); f.setAsk(.79); return { orderId, signed };
        }), post: t.mock.fn(async () => ({ ok: true, orderId, status: 'matched' })) };
        if (phase === 'before_prepare') f.setAsk(.79);
        const broker = new LayaLiveBroker(f.settings, f.store, client, async spec => entryGuard({ ...f, spec }));
        const order = await broker.submit(f.spec, f.now);
        assert.equal(order.status, 'rejected'); assert.equal(client.post.mock.callCount(), 0);
        assert.equal(client.prepare.mock.callCount(), phase === 'after_prepare' ? 1 : 0);
        assert.deepEqual(f.state.seen, reservation); assert.equal(f.state.position.submitAttemptedAt, f.now);
        assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 20);
        assert.deepEqual(f.state.position.holdings, [0, 0]);
        assert.ok(f.events.some(event => event.type === 'laya_entry_expired' && event.reason === 'execution_limit_unmarketable'));
        assert.equal(f.events.filter(event => event.type === 'order_submission_started').length, 0);
        if (phase === 'after_prepare') {
            assert.deepEqual(f.state.position.orders[0].signed, signed);
            assert.equal(f.state.position.orders[0].postAttemptAt, undefined);
        }
        await assert.rejects(broker.submit(f.spec, f.now), /duplicate_entry_attempt/);
        assert.equal(client.post.mock.callCount(), 0);
    });
});

test('the immutable execution witness is durable before the only POST and records its no-fill outcome', async t => {
    const f = fixture(); let now = f.now;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_fak_fixture'); });
    f.setAsk(.78, 2.5);
    f.state.seen[f.market.slug] = { at: start, snapshotId: f.snapshot.snapshotId };
    f.state.position = newPosition(f.market, { orders: [f.spec], cost: f.spec.cost }, f.state, start);
    const original = structuredClone(f.spec), orderId = `0x${'c'.repeat(64)}`;
    const signed = { orderType: 'FAK', makerAmount: '3900000', takerAmount: '5000000', fixtureOnly: true };
    const client = { prepare: t.mock.fn(async () => { now += 7; return { orderId, signed }; }),
        post: t.mock.fn(async payload => {
            assert.equal(payload, signed);
            const saved = f.persisted.at(-1).position.orders[0];
            assert.equal(saved.status, 'submitting'); assert.equal(saved.postAttemptAt, now); assert.equal(saved.prepareMs, 7);
            assert.deepEqual(saved.signed, signed); assert.equal(saved.price, original.price); assert.equal(saved.shares, original.shares);
            assert.deepEqual(saved.execution, { snapshotId: f.snapshot.snapshotId, index: 0, tokenId: f.spec.tokenId,
                snapshotPrice: .77, limitPrice: .78, bestBid: .77, bestAsk: .78, executableShares: 2.5,
                checkedAt: now, inputAgeMs: now - f.snapshot.observedAt, bookAgeMs: now - f.books[0].timestamp,
                bookReceiveAgeMs: now - f.books[0].fetchedAt, snapshotToCheckMs: now - f.snapshot.at });
            const started = f.events.filter(event => event.type === 'order_submission_started');
            assert.equal(started.length, 1); assert.deepEqual(started[0].execution, saved.execution);
            now += 11;
            return { ok: false, code: 'fak_not_filled', httpStatus: 400, definiteRejection: true };
        }) };
    const broker = new LayaLiveBroker(f.settings, f.store, client, async spec => entryGuard({ ...f, spec, now }));
    const order = await broker.submit(f.spec, now);
    assert.equal(order.status, 'rejected'); assert.equal(order.prepareMs, 7); assert.equal(order.postRoundtripMs, 11);
    assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 20); assert.deepEqual(f.state.position.holdings, [0, 0]);
    assert.deepEqual(f.spec, original); assert.equal(client.post.mock.callCount(), 1);
    const outcome = f.events.find(event => event.type === 'order_submission_result');
    assert.deepEqual(outcome, { type: 'order_submission_result', orderId, roundtripMs: 11,
        ok: false, code: 'fak_not_filled', httpStatus: 400 });
    await assert.rejects(broker.submit(f.spec, now), /duplicate_entry_attempt/);
    assert.equal(client.post.mock.callCount(), 1);
});

test('real discover/observe consumes an AI-selected slot when the ask moves beyond its original limit', async t => {
    const f = fixture(); let now = start, resolveDecision;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_fak_fixture'); });
    const bookRows = () => structuredClone(f.books);
    const client = { btc: { assess: () => ({ reason: null }) }, books: async () => bookRows(),
        marketInfo: async () => ({}), validateInfo() {}, confirmedBlock: async () => 123,
        balance: async () => 20, holdings: async () => [0, 0],
        warmOrderMetadata: t.mock.fn(async spec => { assert.equal(spec.price, .78); }),
        prepare: t.mock.fn(async () => ({ orderId: `0x${'b'.repeat(64)}`, signed: { fixtureOnly: true } })),
        post: t.mock.fn(async () => ({ ok: true, orderId: `0x${'b'.repeat(64)}`, status: 'matched' })) };
    const providers = { predict: t.mock.fn((name, snapshot) => new Promise(resolve => {
        assert.equal(name, 'laya');
        resolveDecision = () => resolve({ snapshotId: snapshot.snapshotId, status: 'ok', model: 'typed-decisions',
            action: 'BUY_UP', requestedAt: start, receivedAt: now, latencyMs: now - start });
    })) };
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: bookRows(), timing: {}, features: {
        observedAt: start - 1480, state: { seconds: 60, opening_twap: 83000, spot: 83020, twap: 83020, margin_usd: 20,
            volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [1, 1, 1, 1, 1],
            bars_30s_OHLC_oldest_first: Array.from({ length: 6 }, () => [83000, 83020, 83000, 83020]),
            books_up_down: bookRows().map(book => ({ bids: book.bids.map(row => [row.price, row.size]),
                asks: book.asks.map(row => [row.price, row.size]) })), fee_rate: .07, fee_exponent: 1, shares: 5, entry_cap: 5 },
    } }));
    const stream = { generation: 1, tokens: [...f.market.tokens], snapshot: bookRows };
    const engine = new LayaLiveEngine(f.config, f.store, client, stream, providers); engine.current = f.market;
    t.mock.method(engine.clockGate, 'fresh', () => true);
    const running = engine.discover(start);
    t.after(async () => { resolveDecision?.(); await running; });
    await nextTurn();
    assert.equal(providers.predict.mock.callCount(), 1); assert.equal(client.prepare.mock.callCount(), 0);
    assert.equal(client.warmOrderMetadata.mock.callCount(), 1); assert.deepEqual(f.state.seen, {});
    now = start + 2671; f.setAsk(.79); resolveDecision(); await running;
    const snapshot = f.state.ai.snapshots[0];
    assert.equal(snapshot.allowed[0].snapshotPrice, .77); assert.equal(snapshot.allowed[0].price, .78);
    assert.equal(snapshot.decision.latencyMs, 2671); assert.equal(now - snapshot.observedAt, 4151);
    assert.equal(snapshot.entryDisposition, 'execution_limit_unmarketable');
    assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {}); assert.equal(f.state.stopped, null);
    assert.equal(client.prepare.mock.callCount(), 0); assert.equal(client.post.mock.callCount(), 0);
    assert.ok(f.events.every(event => !['entry_reserved', 'order_submission_started'].includes(event.type)));
    await engine.discover(now); assert.equal(providers.predict.mock.callCount(), 1);
});

test('official SDK preserves .78 x five-share amounts and FAK POST policy without real signing or network', async t => {
    const address = '0x0000000000000000000000000000000000000001', conditionId = `0x${'1'.repeat(64)}`;
    const credentials = { key: '00000000-0000-4000-8000-000000000000',
        secret: Buffer.from('offline-fak-fixture').toString('base64'), passphrase: 'offline-fixture' };
    const forbidden = () => { throw new Error('real_signing_forbidden_in_fak_fixture'); };
    const signer = { getAddress: async () => address, signTypedData: t.mock.fn(forbidden),
        signMessage: t.mock.fn(forbidden), sendTransaction: t.mock.fn(forbidden) };
    const posts = [];
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        const request = input instanceof Request ? input : new Request(input, options), url = new URL(request.url);
        assert.equal(url.origin, 'https://clob.polymarket.com');
        if (request.method === 'GET' && url.pathname === '/auth/api-keys') return Response.json({ apiKeys: [credentials.key] });
        if (request.method === 'GET' && url.pathname === '/markets-by-token/123') return Response.json({ condition_id: conditionId });
        if (request.method === 'GET' && url.pathname === `/clob-markets/${conditionId}`)
            return Response.json({ fd: { r: .07, e: 1 }, mts: .01, nr: false,
                t: [{ t: '123', o: 'Up' }, { t: '456', o: 'Down' }] });
        if (request.method === 'POST' && url.pathname === '/order') {
            posts.push(await request.json()); return Response.json({ error: fakMessage }, { status: 400 });
        }
        assert.fail('unexpected offline fixture request');
    });
    const secure = await createSecureClient({ wallet: address, signer, credentials });
    const workflow = await prepareLimitOrder(secure, { assetId: '123', side: OrderSide.BUY, price: .78, size: 5, postOnly: false });
    const step = await workflow.next();
    assert.equal(step.done, false); assert.equal(step.value.kind, 'signOrder');
    assert.equal(String(step.value.payload.message.makerAmount), '3900000');
    assert.equal(String(step.value.payload.message.takerAmount), '5000000');
    assert.equal('orderType' in step.value.payload.message, false);
    assert.ok(step.value.payload.types.Order.every(field => field.name !== 'orderType'));
    // A fixed fixture signature completes the SDK serialization workflow; no
    // wallet, private key or signer implementation is used to produce it.
    const signature = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
    const completed = await workflow.next(signature);
    assert.equal(completed.done, true);
    const signed = completed.value; signed.orderType = OrderType.FAK;
    const normalized = await LayaTradingClient.prototype.post.call({ authenticate: async () => secure }, signed);
    assert.deepEqual(normalized, { ok: false, code: 'fak_not_filled', httpStatus: 400, definiteRejection: true });
    assert.equal(posts.length, 1); assert.equal(posts[0].orderType, 'FAK');
    assert.equal(posts[0].order.makerAmount, '3900000'); assert.equal(posts[0].order.takerAmount, '5000000');
    assert.equal(posts[0].order.signature, signature); assert.equal(posts[0].order.tokenId, '123');
    for (const method of [signer.signTypedData, signer.signMessage, signer.sendTransaction]) assert.equal(method.mock.callCount(), 0);
});
