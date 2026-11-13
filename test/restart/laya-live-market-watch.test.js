import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveEngine, entryGuard } from '../../src/laya-live/engine.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { holdEntry, openingMarketReadUnavailable, temporaryReadFailure } from '../../src/laya-live/entry-holds.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError, ReadCoordinator } from '../../src/restart/network.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';

const OPEN = Date.parse('2026-11-01T04:55:00Z');
const missing = detail => new OperationalError('http_rejected', 'api_rejection', {
    httpStatus: 404, endpoint: 'gamma', stage: 'market_discovery', ...detail,
});

function fixture(t, { continuous = false, elapsed = 0 } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: OPEN + elapsed });
    const settings = { ...BASELINE, continuousTrading: continuous, capital: 20,
        pilotHours: Infinity, pilotMarkets: Infinity };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: OPEN - 300000,
        cash: 20, peakEquity: 20, maxDrawdown: 0, stopped: null, failures: 0,
        completed: [], seen: {}, position: null, walletStart: 20 };
    const events = [], calls = { gamma: [], metadata: 0, stream: [], wallet: 0, observe: 0 };
    const store = { state, save() {}, event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    const raw = { slug: marketSlug('late-entry', settings, OPEN), conditionId: 'official-condition',
        question: 'BTC Up or Down', description: 'time-weighted average price (TWAP) from '
            + 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
        clobTokenIds: ['1', '2'], outcomes: ['Up', 'Down'],
        orderPriceMinTickSize: .01, orderMinSize: 5, feesEnabled: false,
        eventStartTime: new Date(OPEN).toISOString(), endDate: new Date(OPEN + 300000).toISOString(),
        acceptingOrders: true, closed: false, negRisk: false };
    const info = { tickSize: .01, negRisk: false, feeInfo: { rate: 0, exponent: 1 },
        tokens: [{ assetId: '1', outcome: 'Up' }, { assetId: '2', outcome: 'Down' }] };
    let status = 404;
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        assert.equal(options.method ?? 'GET', 'GET', 'Market watch must perform reads only');
        const url = new URL(input);
        assert.equal(url.origin, 'https://gamma-api.polymarket.com');
        assert.equal(url.pathname, `/markets/slug/${raw.slug}`);
        calls.gamma.push(url.pathname);
        return status === 200 ? Response.json(raw) : new Response('PRIVATE_REJECTION_BODY', { status });
    });
    // Use the real inherited market/json/normalization and metadata validators,
    // without constructing a client that could authenticate or make writes.
    const client = Object.assign(Object.create(LayaTradingClient.prototype), { settings,
        reads: new ReadCoordinator(), startBtcFeed() {}, serverTime: async () => Date.now(),
        marketInfo: async () => { calls.metadata++; return info; },
        btc: { openings: new Map(), status: () => null }, payout: async () => null });
    const stream = { generation: 1, socket: { readyState: 1 }, snapshot: () => null,
        watch(tokens, market) { calls.stream.push(market); } };
    const config = { settings, policy: { provider: continuous ? 'eligible' : 'laya', aiSource: 'offline-market-watch' },
        ai: { latencyMs: 250, dataAgeMs: 5000, decisionMs: 3000, slots: [90, 60, 30], slotToleranceMs: 2000 } };
    const engine = new LayaLiveEngine(config, store, client, stream, {});
    engine.broker.checkWallet = async () => { calls.wallet++; return true; };
    engine.broker.reconcile = async () => {};
    engine.broker.cancelOwned = async () => {};
    engine.broker.pending = () => !!state.position;
    for (const method of ['submit', 'action']) engine.broker[method] = async () => assert.fail('No financial work in watch tests');
    engine.observe = async () => { calls.observe++; };
    return { engine, client, state, store, calls, raw, info, events, config,
        status(value) { status = value; }, advance(ms) { t.mock.timers.setTime(Date.now() + ms); } };
}

test('opening Gamma 404 holds entry with backoff until the exact market is freshly validated', async t => {
    for (const continuous of [false, true]) await t.test(String(continuous), async t => {
        const f = fixture(t, { continuous }), before = structuredClone(f.state);
        await f.engine.tick();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.market_watch.retryable, true);
        assert.deepEqual(f.state.entryHolds.market_watch.error, { name: 'OperationalError', code: 'http_rejected',
            category: 'api_rejection', httpStatus: 404, stage: 'market_discovery', endpoint: 'gamma', durationMs: 0, attempts: 1 });
        assert.equal(f.client.reads.state('gamma').streak, 0, '404 must not become a global transport retry');
        assert.equal(f.calls.gamma.length, 1); assert.equal(f.calls.metadata, 0); assert.equal(f.calls.stream.length, 0);
        assert.equal(f.engine.current, null); assert.equal(f.calls.observe, 0); assert.equal(f.calls.wallet, 1);
        assert.throws(() => entryGuard({ state: f.state }), /live_entry_held/);
        assert.throws(() => f.engine.assertEntryClock(), /live_entry_held/);
        assert.equal(JSON.stringify(f.events).includes('PRIVATE_REJECTION_BODY'), false);
        f.advance(4999); await f.engine.tick(); assert.equal(f.calls.gamma.length, 1);
        f.advance(1); await f.engine.tick();
        assert.equal(f.calls.gamma.length, 2); assert.equal(f.state.entryHolds.market_watch.attempts, 2);
        assert.equal(f.state.entryHolds.market_watch.retryAt - Date.now(), 10000);
        f.advance(10000); await f.engine.tick();
        assert.equal(f.calls.gamma.length, 3); assert.equal(f.state.entryHolds.market_watch.retryAt - Date.now(), 20000);
        // A fresh success may recover beyond the opening grace, but cannot
        // clear the independent full-history/stream hold or replay a slot.
        holdEntry(f.store, 'book_stream', new OperationalError('read_timeout', 'timeout'), { retryable: true });
        f.status(200); f.advance(20000); await f.engine.tick();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.market_watch, undefined);
        assert.equal(f.state.entryHolds.book_stream.retryable, true); assert.equal(f.calls.gamma.length, 4);
        assert.equal(f.calls.metadata, 1); assert.equal(f.calls.stream.length, 1);
        assert.equal(f.engine.current.slug, f.raw.slug); assert.equal(f.engine.current.open, OPEN);
        assert.equal(f.engine.current.end, OPEN + 300000); assert.equal(f.calls.observe, 0);
        assert.throws(() => f.engine.assertEntryClock(), /live_entry_held/);
        assert.deepEqual(f.state.seen, before.seen); assert.deepEqual(f.state.completed, before.completed);
        assert.deepEqual(f.state.ai, before.ai); assert.equal(f.state.cash, before.cash); assert.equal(f.state.position, null);
    });
});

test('a persistent target 404 past opening grace is not silently retried forever', async t => {
    const f = fixture(t);
    for (const elapsed of [0, 5000, 15000, 35000]) {
        f.advance(OPEN + elapsed - Date.now()); await f.engine.tick();
    }
    assert.equal(f.calls.gamma.length, 4); assert.equal(f.state.stopped.reason, 'market_watch_failed');
    assert.equal(f.state.entryHolds.market_watch.retryable, false); assert.equal(f.calls.stream.length, 0);
    const hold = structuredClone(f.state.entryHolds.market_watch), stop = structuredClone(f.state.stopped);
    f.status(200); f.advance(60000); await f.engine.tick();
    assert.equal(f.calls.gamma.length, 4); assert.deepEqual(f.state.entryHolds.market_watch, hold);
    assert.deepEqual(f.state.stopped, stop); assert.equal(f.calls.observe, 0);
});

test('continuous discovery 404 backs off through a missing market and validates the next market', async t => {
    const f = fixture(t, { continuous: true }), before = structuredClone(f.state);
    for (const elapsed of [0, 5000, 15000, 35000, 75000, 135000, 195000, 255000]) {
        f.advance(OPEN + elapsed - Date.now()); await f.engine.tick();
        assert.equal(f.state.stopped, null);
        assert.equal(f.state.entryHolds.market_watch.retryable, true);
        assert.equal(f.calls.stream.length, 0);
        assert.equal(f.calls.observe, 0);
        assert.throws(() => entryGuard({ state: f.state }), /live_entry_held/);
    }
    assert.equal(f.calls.gamma.length, 8);
    assert.equal(f.state.entryHolds.market_watch.retryAt, OPEN + 315000);
    f.advance(59999); await f.engine.tick();
    assert.equal(f.calls.gamma.length, 8, 'Do not retry before persisted backoff');
    f.advance(1);
    f.raw.slug = marketSlug('late-entry', f.config.settings, Date.now());
    f.raw.eventStartTime = new Date(OPEN + 300000).toISOString();
    f.raw.endDate = new Date(OPEN + 600000).toISOString();
    f.status(200); await f.engine.tick();
    assert.equal(f.calls.gamma.length, 9);
    assert.equal(f.calls.metadata, 1);
    assert.equal(f.calls.stream.length, 1);
    assert.equal(f.engine.current.slug, f.raw.slug);
    assert.equal(f.state.entryHolds.market_watch, undefined);
    assert.equal(f.state.stopped, null);
    assert.equal(f.calls.observe, 0, 'Recovery does not replay an expired entry slot');
    assert.deepEqual(f.state.completed, before.completed);
    assert.deepEqual(f.state.seen, before.seen);
    assert.equal(f.state.cash, before.cash);
});

test('continuous 404 recovery does not admit other endpoints, authentication errors or exposure', async t => {
    for (const fault of ['401', '403', 'clob', 'metadata_read', 'reserved', 'position'])
        await t.test(fault, async t => {
            const f = fixture(t, { continuous: true, elapsed: 45000 });
            if (['401', '403'].includes(fault)) f.status(Number(fault));
            if (fault === 'clob') f.client.json = async () => { throw missing({ endpoint: 'clob' }); };
            if (fault === 'metadata_read') f.client.json = async () => { throw missing({ stage: 'metadata_read' }); };
            if (fault === 'reserved') f.state.seen[f.raw.slug] = { at: OPEN - 1 };
            if (fault === 'position') {
                f.state.position = newPosition({ slug: 'previous', open: OPEN - 300000,
                    end: OPEN, tokens: ['3', '4'] }, { cost: 4 }, f.state, OPEN - 1000);
                f.state.position.holdings = [5, 0]; f.state.cash = 16;
            }
            await f.engine.tick();
            assert.equal(f.state.stopped.reason, 'market_watch_failed');
            assert.equal(f.state.entryHolds.market_watch.retryable, false);
            assert.equal(f.calls.stream.length, 0);
            assert.equal(f.calls.observe, 0);
        });
});

test('other HTTP rejections and 404 reads away from opening retain a permanent diagnosis', async t => {
    for (const value of [400, 401, 403, 405, 410, 422, 'late_404', 'reserved_404', 'exposed_404', 'old_hold'])
        await t.test(String(value), async t => {
            const f = fixture(t, { elapsed: value === 'late_404' ? 30001 : 0 });
            if (typeof value === 'number') f.status(value);
            if (value === 'reserved_404') f.state.seen[f.raw.slug] = { at: OPEN - 1 };
            if (value === 'exposed_404') {
                const market = { slug: 'previous', open: OPEN - 300000, end: OPEN, tokens: ['3', '4'] };
                f.state.position = newPosition(market, { cost: 4 }, f.state, OPEN - 1000);
                f.state.position.holdings = [5, 0]; f.state.cash = 16;
            }
            if (value === 'old_hold') holdEntry(f.store, 'market_watch', missing(), { now: OPEN - 1 });
            const old = value === 'old_hold' ? structuredClone(f.state.entryHolds.market_watch) : null;
            await f.engine.tick();
            if (old) assert.deepEqual(f.state.entryHolds.market_watch, old);
            else assert.equal(f.state.stopped.reason, 'market_watch_failed');
            assert.equal(f.state.entryHolds.market_watch.retryable, false);
            assert.equal(f.calls.metadata, 0); assert.equal(f.calls.stream.length, 0); assert.equal(f.calls.observe, 0);
        });
});

test('Gamma absence exception requires exact endpoint, stage, status, and same-market timing evidence', async t => {
    assert.equal(openingMarketReadUnavailable(missing(), OPEN, OPEN + 30000), true);
    assert.equal(temporaryReadFailure(missing()), false);
    for (const detail of [{ httpStatus: undefined }, { httpStatus: 400 }, { httpStatus: 403 }, { httpStatus: 410 },
        { stage: undefined }, { stage: 'metadata_read' }, { stage: 'book_read' }, { stage: 'authentication' },
        { endpoint: undefined }, { endpoint: 'clob' }, { endpoint: 'data' }]) {
        const error = missing(detail);
        assert.equal(openingMarketReadUnavailable(error, OPEN), false);
        await t.test(JSON.stringify(detail), async t => {
            const f = fixture(t); f.client.json = async () => { throw error; };
            await f.engine.tick();
            assert.equal(f.state.stopped.reason, 'market_watch_failed');
            assert.equal(f.state.entryHolds.market_watch.retryable, false);
            assert.equal(f.engine.current, null); assert.equal(f.calls.stream.length, 0);
        });
    }
    for (const [attemptedAt, failedAt] of [[OPEN, OPEN + 30001], [OPEN + 30001, OPEN + 30001],
        [OPEN - 1, OPEN], [OPEN, OPEN - 1], [NaN, OPEN], [OPEN, Infinity]])
        assert.equal(openingMarketReadUnavailable(missing(), attemptedAt, failedAt), false);
});

test('a replacement after Gamma absence still needs exact market identity and verified CLOB constraints', async t => {
    for (const fault of ['slug', 'open', 'duration', 'outcomes', 'constraints', 'metadata', 'tick'])
        await t.test(fault, async t => {
            const f = fixture(t); await f.engine.tick();
            f.status(200);
            if (fault === 'slug') f.raw.slug = 'wrong-market';
            if (fault === 'open') f.raw.eventStartTime = new Date(OPEN - 300000).toISOString();
            if (fault === 'duration') f.raw.endDate = new Date(OPEN + 600000).toISOString();
            if (fault === 'outcomes') f.raw.outcomes = ['Yes', 'No'];
            if (fault === 'constraints') f.raw.orderMinSize = 0;
            if (fault === 'metadata') f.info.tokens[0].assetId = 'wrong-token';
            if (fault === 'tick') f.info.tickSize = 0;
            // Validate the response identity, not a mock URL derived from the
            // intentionally changed response slug.
            const target = marketSlug('late-entry', f.engine.settings, Date.now());
            t.mock.method(globalThis, 'fetch', async input => {
                assert.equal(new URL(input).pathname, `/markets/slug/${target}`);
                f.calls.gamma.push(target); return Response.json(f.raw);
            });
            f.advance(5000); await f.engine.tick();
            assert.equal(f.state.stopped.reason, 'market_watch_failed');
            assert.equal(f.state.entryHolds.market_watch.retryable, false);
            assert.equal(f.calls.gamma.length, 2); assert.equal(f.engine.current, null);
            assert.equal(f.calls.stream.length, 0); assert.equal(f.calls.observe, 0);
            assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        });
});

test('recovered market watch cannot make stale entry books fresh', async t => {
    const f = fixture(t, { continuous: true });
    await f.engine.tick(); f.status(200); f.advance(5000); await f.engine.tick();
    assert.equal(f.state.entryHolds.market_watch, undefined);
    f.advance(205000); await f.engine.checkClock();
    f.client.books = async () => [0, 1].map(() => ({ timestamp: Date.now() - 5001, fetchedAt: Date.now(),
        bids: [{ price: .79, size: 10 }], asks: [{ price: .8, size: 10 }] }));
    f.engine.observe = async market => { f.calls.observe++; await f.engine.entryBooks(market); };
    await f.engine.discover();
    assert.equal(f.state.ai.slots[`${f.raw.slug}:90`].status, 'invalid');
    assert.equal(f.state.entryHolds.entry_read.error.code, 'invalid_entry_books');
    assert.equal(f.state.entryHolds.entry_read.retryable, true);
    assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(f.calls.observe, 1); assert.equal(f.calls.stream.length, 1);
});
