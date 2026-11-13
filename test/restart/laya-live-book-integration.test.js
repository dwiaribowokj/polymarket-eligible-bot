import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';

const start = Date.parse('2026-10-16T00:04:00Z');
class OfflineSocket extends EventEmitter {
    constructor() { super(); this.readyState = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    send() {}
    frame(row) { this.emit('message', JSON.stringify(row)); }
    terminate() { this.readyState = 3; this.emit('close'); }
}

function fixture(t) {
    let now = start - 180000, engine, resolveDecision;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_book_integration'); });
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, late: { duration: 300 },
        lateQuality: { maxSpread: .03, minDepth: 5 } };
    const config = { settings, policy: { aiSource: 'offline-book-integration' }, ai: {
        slots: [60], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
    } };
    const market = { slug: marketSlug('late-entry', settings, start), conditionId: 'fixture-condition',
        open: start - 240000, end: start + 60000, accepting: true, minimum: 5,
        tick: .01, ticks: [.01, .01], tokens: ['fixture-up', 'fixture-down'], outcomes: ['Up', 'Down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, negRisk: false };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 240000,
        cash: 20, peakEquity: 20, maxDrawdown: 0, failures: 0, stopped: null, position: null,
        completed: [], seen: {}, walletStart: 20, walletCashDelta: 0, liveFunding: { initialCapital: 20 } };
    const events = [], persisted = [], sockets = [], timers = new Set();
    const store = { state, save() { persisted.push(structuredClone(state)); },
        event(type, detail = {}) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: now }; this.save(); } };
    const stream = new LiveBookHistory({ clock: () => now, onEvent: (type, detail) => engine.bookEvent(type, detail),
        socketFactory: () => { const socket = new OfflineSocket(); sockets.push(socket); return socket; },
        scheduleInterval: fn => { timers.add(fn); return fn; }, cancelInterval: fn => timers.delete(fn) });
    const rows = () => structuredClone(stream.snapshot(now, false));
    const client = { btc: { assess: () => ({ reason: null }) }, books: async () => rows(),
        marketInfo: async () => ({}), validateInfo() {}, confirmedBlock: async () => 123,
        balance: async () => 20, holdings: async () => [0, 0], warmOrderMetadata: async () => {},
        tickSize: t.mock.fn(async () => .01),
        prepare: t.mock.fn(async () => ({ orderId: `0x${'d'.repeat(64)}`, signed: { fixtureOnly: true } })),
        post: t.mock.fn(async () => ({ ok: true, orderId: `0x${'d'.repeat(64)}`, status: 'matched' })) };
    const providers = { predict: t.mock.fn((name, snapshot) => new Promise(resolve => {
        assert.equal(name, 'laya');
        resolveDecision = () => resolve({ snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP',
            model: 'typed-decisions', requestedAt: start, receivedAt: now, latencyMs: now - start });
    })) };
    engine = new LayaLiveEngine(config, store, client, stream, providers); engine.current = market;
    // Book lifecycle tests supply clock readiness; clock transitions have their own suite.
    t.mock.method(engine.clockGate, 'fresh', () => true);
    stream.watch(market.tokens, market); sockets[0].open();
    const pair = (watched = market) => watched.tokens.forEach((token, index) => sockets.at(-1).frame({ event_type: 'book',
        asset_id: token, market: watched.conditionId, timestamp: now, tick_size: '.01',
        bids: [{ price: index === 0 ? '.77' : '.21', size: '10' }],
        asks: [{ price: index === 0 ? '.78' : '.22', size: '10' }] }));
    for (let i = 0; i <= 180; i++) { pair(); if (i < 180) now += 1000; }
    assert.ok(stream.snapshot(now));
    t.after(() => stream.close());
    const tick = (next = '.001') => market.tokens.forEach(token => sockets.at(-1).frame({ event_type: 'tick_size_change',
        asset_id: token, market: market.conditionId, timestamp: now,
        old_tick_size: String(stream.books.get(token).tick), new_tick_size: next }));
    const spec = { index: 0, tokenId: market.tokens[0], snapshotPrice: .78, price: .79,
        shares: 5, side: 'BUY', kind: 'taker', cost: 4.058065 };
    const reserve = () => {
        const snapshot = { snapshotId: 'fixture-snapshot', at: now, observedAt: now, decisionReceivedAt: now,
            validation: { at: now, generation: stream.generation, identity: metadataIdentity(market) }, allowed: [spec] };
        const decision = { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', model: 'typed-decisions' };
        engine.entryContext = { market, snapshot, decision,
            wallet: { startedAt: now, checkedAt: now, block: 123, tokens: [...market.tokens], balance: 20, holdings: [0, 0] } };
        state.seen[market.slug] = { at: now, snapshotId: snapshot.snapshotId };
        state.position = newPosition(market, { orders: [spec], cost: spec.cost }, state, now);
        return snapshot;
    };
    return { engine, stream, settings, config, market, state, store, events, persisted, client, providers, sockets,
        spec, rows, tick, reserve, pair, get now() { return now; }, advance(ms) { now += ms; },
        pulse() { for (const fn of [...timers]) fn(); }, resolveDecision() { resolveDecision?.(); } };
}

function features(t, f) {
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: f.rows(), timing: {}, features: {
        observedAt: f.now, state: { seconds: 60, opening_twap: 83000, spot: 83020, twap: 83020, margin_usd: 20,
            volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [1, 1, 1, 1, 1],
            bars_30s_OHLC_oldest_first: Array.from({ length: 6 }, () => [83000, 83020, 83000, 83020]),
            books_up_down: f.rows().map(book => ({ bids: book.bids.map(row => [row.price, row.size]),
                asks: book.asks.map(row => [row.price, row.size]) })), fee_rate: .07, fee_exponent: 1, shares: 5, entry_cap: 5 },
    } }));
}

test('book lifecycle and rejected-message telemetry retain exposure and forward event details without a stop', t => {
    const f = fixture(t); f.reserve();
    for (const type of ['book_stream_open', 'book_reconnect_scheduled', 'book_message_rejected']) {
        const detail = { reason: 'fixture', sourceEpoch: 7, generation: f.stream.generation };
        f.engine.bookEvent(type, detail);
        assert.deepEqual(f.events.at(-1), { type, ...detail }); assert.equal(f.state.stopped, null);
    }
    f.advance(100); f.tick();
    assert.equal(f.state.stopped, null, 'a proven continuous tick alone is not a quote gap');
    assert.ok(f.stream.snapshot(f.now));
});

test('a real quote gap holds exposed execution once and retains its reservation', t => {
    const f = fixture(t); f.reserve(); const before = structuredClone(f.state.seen);
    f.advance(5001); f.pulse();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.book_stream.retryable, true);
    assert.deepEqual(f.state.seen, before);
    assert.equal(f.stream.snapshot(f.now), null); assert.equal(f.client.post.mock.callCount(), 0);
    assert.equal(f.events.filter(event => event.type === 'book_gap').length, 1);
    const stop = structuredClone(f.state.stopped); f.engine.bookEvent('book_reconnect_scheduled', { delayMs: 1000 });
    assert.deepEqual(f.state.stopped, stop);
});

test('a next-market socket close preserves ended holdings and requires 180 seconds of new quotes', async t => {
    const f = fixture(t); f.reserve(); f.state.position.holdings = [5.649347, 0];
    const position = structuredClone(f.state.position), seen = structuredClone(f.state.seen);
    f.advance(f.market.end - f.now + 3000);
    const next = { ...f.market, slug: marketSlug('late-entry', f.settings, f.now),
        open: f.market.end, end: f.market.end + 300000, conditionId: 'next-condition',
        tokens: ['next-up', 'next-down'] };
    f.engine.current = next; f.stream.watch(next.tokens, next); f.sockets.at(-1).open(); f.pair(next);
    f.advance(11233); f.sockets.at(-1).emit('close', 1013, Buffer.from('try again later'));
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.position, position);
    assert.deepEqual(f.state.seen, seen); assert.equal(f.stream.snapshot(f.now), null);
    assert.equal(f.stream.history.length, 0); assert.equal(f.stream.readyAt, null);
    assert.ok(f.events.some(event => event.type === 'book_gap' && event.reason === 'socket_closed' && event.closeCode === 1013));
    assert.ok(f.events.some(event => event.type === 'closed_market_book_invalidation'
        && event.activeMarket === f.market.slug && event.watchedMarket === next.slug));
    assert.ok(f.events.some(event => event.type === 'book_reconnect_scheduled'));
    assert.equal(f.stream.watch(next.tokens, next), false, 'reconnect backoff still applies');
    f.advance(1000); assert.equal(f.stream.watch(next.tokens, next), true);
    f.sockets.at(-1).open(); f.pair(next);
    await assert.rejects(f.engine.observe(next, 60, 'warming'), /execution_book_unavailable/);
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(next); }
    f.advance(999); f.pair(next);
    assert.equal(f.stream.snapshot(f.now), null);
    assert.equal(f.stream.status(f.now).remainingWarmupMs, 1);
    await assert.rejects(f.engine.observe(next, 60, 'still-warming'), /execution_book_unavailable/);
    assert.equal(f.providers.predict.mock.callCount(), 0); assert.equal(f.client.prepare.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
    f.advance(1); f.pair(next);
    assert.ok(f.stream.snapshot(f.now)); assert.equal(f.stream.status(f.now).ready, true);
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.position, position);
    assert.deepEqual(f.state.seen, seen);
});

test('collector invalidations use the held market expiry at handling time', async t => {
    for (const type of ['book_gap', 'book_identity_changed', 'book_tick_changed']) {
        for (const offset of [-1, 0, 1]) await t.test(`${type} ${offset}ms from expiry`, t => {
            const f = fixture(t); f.reserve(); const position = structuredClone(f.state.position);
            f.advance(f.market.end - f.now + offset);
            const detail = { continuityPreserved: false, timestamp: offset < 0 ? f.market.end + 1000 : f.market.end - 1000 };
            f.engine.bookEvent(type, detail);
            assert.equal(f.state.stopped?.reason ?? null, offset < 0 ? 'live_book_feed_gap' : null);
            assert.deepEqual(f.state.position, position);
            assert.ok(f.events.some(event => event.type === type && event.timestamp === detail.timestamp));
            if (offset < 0) assert.equal(f.persisted.at(-1).stopped.reason, 'live_book_feed_gap');
        });
    }
});

test('unproven position expiry or handling clock keeps collector invalidations fatal', async t => {
    const cases = [
        ...[undefined, null, NaN, Infinity, 0, -1, start + .5, String(start)].map(end => ({ name: `end ${String(end)}`, end })),
        { name: 'missing market', missingMarket: true },
        ...[NaN, Infinity, undefined, start + 60001.5].map(clock => ({ name: `clock ${String(clock)}`, clock, invalidClock: true })),
    ];
    for (const scenario of cases) await t.test(scenario.name, t => {
        const f = fixture(t); f.reserve(); f.advance(f.market.end - f.now + 1000);
        if (scenario.missingMarket) delete f.state.position.market;
        else if (!scenario.invalidClock) f.state.position.market.end = scenario.end;
        if (scenario.invalidClock) t.mock.method(Date, 'now', () => scenario.clock);
        f.engine.bookEvent('book_gap', { reason: 'socket_closed' });
        assert.equal(f.state.stopped.reason, 'live_book_feed_gap');
        assert.equal(f.persisted.at(-1).stopped.reason, 'live_book_feed_gap');
    });
});

test('collector invalidations never replace an existing risk stop', t => {
    const f = fixture(t); f.reserve();
    f.state.stopped = { reason: 'drawdown_limit', at: f.now }; const before = structuredClone(f.state.stopped);
    f.sockets[0].emit('error', new Error('fixture connection lost'));
    assert.deepEqual(f.state.stopped, before); assert.equal(f.stream.snapshot(f.now), null);
});

test('ended exposure never clears a pre-existing feed or risk stop', async t => {
    for (const reason of ['live_book_feed_gap', 'drawdown_limit']) await t.test(reason, t => {
        const f = fixture(t); f.reserve(); f.state.stopped = { reason, at: f.now };
        const before = structuredClone(f.state.stopped);
        f.advance(f.market.end - f.now + 1000);
        f.sockets[0].emit('error', new Error('fixture connection lost'));
        assert.deepEqual(f.state.stopped, before); assert.equal(f.stream.snapshot(f.now), null);
        assert.deepEqual(f.persisted.at(-1).stopped, before);
    });
});

test('a safe tick during inference consumes the original slot before reservation and performs zero POSTs', async t => {
    const f = fixture(t); features(t, f);
    const running = f.engine.discover(start);
    t.after(async () => { f.resolveDecision(); await running; });
    await nextTurn(); assert.equal(f.providers.predict.mock.callCount(), 1);
    f.advance(100); f.tick(); assert.ok(f.stream.snapshot(f.now)); f.resolveDecision(); await running;
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(f.state.ai.snapshots[0].entryDisposition, 'execution_book_generation_changed');
    assert.ok(f.events.some(event => event.type === 'laya_book_recovery_wait' && event.reason === 'execution_book_generation_changed'));
    assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
    await f.engine.discover(f.now); assert.equal(f.providers.predict.mock.callCount(), 1);
});

test('a tick-endpoint race consumes its slot when generation changed without weakening token identity', async t => {
    const f = fixture(t); let changed = false;
    f.market.ticks = [.001, .001]; f.market.tick = .001;
    f.client.tickSize = t.mock.fn(async () => {
        await Promise.resolve();
        if (!changed) { changed = true; f.advance(100); f.tick(); }
        return .0001; // Endpoint advances again before the in-flight metadata proof completes.
    });
    await f.engine.discover(start);
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.ok(f.events.some(event => event.type === 'laya_book_recovery_wait' && event.reason === 'execution_book_generation_changed'));
    assert.equal(f.providers.predict.mock.callCount(), 0); assert.equal(f.client.prepare.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
});

test('generation changes after reservation remain fatal and cannot reach POST', async t => {
    const f = fixture(t); f.reserve();
    const before = structuredClone(f.state.seen), signed = { fixtureOnly: true, orderType: 'FAK' };
    f.client.prepare = t.mock.fn(async () => {
        f.advance(100); f.tick(); return { orderId: `0x${'e'.repeat(64)}`, signed };
    });
    const order = await f.engine.broker.submit(f.spec, f.now);
    assert.equal(order.status, 'rejected'); assert.equal(f.state.stopped.reason, 'stale_or_invalid_execution_data');
    assert.deepEqual(f.state.seen, before); assert.deepEqual(f.state.position.orders[0].signed, signed);
    assert.equal(f.state.position.orders[0].postAttemptAt, undefined); assert.equal(f.client.post.mock.callCount(), 0);
    assert.ok(f.stream.snapshot(f.now), 'the fatal guard applies even when tick continuity preserved the warm book');
    await assert.rejects(f.engine.broker.submit(f.spec, f.now), /duplicate_entry_attempt/);
});

test('a true gap after reservation holds entry and cannot reach POST or a second attempt', async t => {
    const f = fixture(t); f.reserve();
    const before = structuredClone(f.state.seen), signed = { fixtureOnly: true, orderType: 'FAK' };
    f.client.prepare = t.mock.fn(async () => {
        f.advance(5001); f.pulse(); return { orderId: `0x${'f'.repeat(64)}`, signed };
    });
    const order = await f.engine.broker.submit(f.spec, f.now);
    assert.equal(order.status, 'rejected'); assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.book_stream.retryable, true);
    assert.deepEqual(f.state.seen, before); assert.deepEqual(f.state.position.orders[0].signed, signed);
    assert.equal(f.state.position.orders[0].postAttemptAt, undefined); assert.equal(f.client.post.mock.callCount(), 0);
    await assert.rejects(f.engine.broker.submit(f.spec, f.now), /duplicate_entry_attempt/);
});

test('generation changes do not soften real token, metadata or future-data failures', async t => {
    for (const mutation of ['token', 'metadata', 'future']) await t.test(mutation, async t => {
        const f = fixture(t); const snapshot = f.reserve(); f.state.position = null; f.state.seen = {};
        if (mutation === 'token') {
            f.stream.tokens[0] = 'foreign-token'; f.stream.books.set('foreign-token', f.stream.books.get(f.market.tokens[0]));
        } else if (mutation === 'metadata') {
            f.advance(100); f.tick(); f.market.conditionId = 'foreign-condition';
        } else {
            f.advance(100); f.tick(); snapshot.observedAt = snapshot.at + 1;
        }
        await assert.rejects(f.engine.validate(f.spec), mutation === 'token' ? /execution_token_mismatch/
            : mutation === 'metadata' ? /execution_metadata_changed_or_expired/ : /invalid_laya_input_time/);
        assert.equal(f.state.stopped.reason, 'stale_or_invalid_execution_data');
        assert.equal(f.client.post.mock.callCount(), 0); assert.deepEqual(f.state.seen, {});
    });
});
