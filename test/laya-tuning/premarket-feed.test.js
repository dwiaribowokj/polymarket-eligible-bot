import test from 'node:test';
import assert from 'node:assert/strict';
import { BtcSignal } from '../../src/restart/signal.js';
import { BASELINE } from '../../src/restart/config.js';
import { PREMARKET_FEED_WATCHDOG, PremarketBtcFeed, premarketReader } from '../../src/premarket-paper/client.js';
import { PremarketHistory } from '../../src/premarket-paper/features.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class FakeStream {
    constructor({ closePending = false, endOnClose = true } = {}) {
        this.items = []; this.waiter = null; this.ended = false; this.closes = 0;
        this.closeGate = closePending ? deferred() : null; this.endOnClose = endOnClose;
    }
    [Symbol.asyncIterator]() { return this; }
    next() {
        if (this.items.length) return Promise.resolve({ done: false, value: this.items.shift() });
        if (this.ended) return Promise.resolve({ done: true });
        this.waiter = deferred(); return this.waiter.promise;
    }
    push(value) {
        if (this.waiter) { const waiter = this.waiter; this.waiter = null; waiter.resolve({ done: false, value }); }
        else this.items.push(value);
    }
    end() { this.ended = true; this.waiter?.resolve({ done: true }); this.waiter = null; }
    async close() {
        this.closes++;
        if (this.endOnClose) this.end();
        if (this.closeGate) await this.closeGate.promise;
    }
}

function fixture(options = {}) {
    let now = 300000, timer, timerCanceled = false, subscriptions = 0, authentications = 0;
    const events = [], streams = [], history = new PremarketHistory();
    const btc = new BtcSignal(BASELINE.lateSignal, event => events.push(event));
    const authenticate = options.authenticate || (async () => {
        authentications++;
        return { subscribe: async () => {
            subscriptions++;
            const stream = new FakeStream(options.stream); streams.push(stream); return stream;
        } };
    });
    const feed = new PremarketBtcFeed({ btc, authenticate, clock: () => now,
        policy: { ...PREMARKET_FEED_WATCHDOG, ...options.policy },
        emit: event => { events.push(event); if (event.type === 'btc_feed_gap') history.reset(); },
        scheduleInterval: callback => { timer = callback; return { unref() {} }; },
        cancelInterval: () => { timerCanceled = true; } });
    const push = (topic, at = now, value = 83000) => streams.at(-1).push({ type: 'update', topic,
        payload: { symbol: 'btcusd', timestamp: at, value, ...(topic.endsWith('twap') ? { windowSeconds: 60 } : {}) } });
    return { feed, btc, history, events, streams, push,
        get now() { return now; }, get subscriptions() { return subscriptions; }, get authentications() { return authentications; },
        get timerCanceled() { return timerCanceled; },
        async start() { feed.start(); await flush(); },
        async advance(ms) { now += ms; timer?.(); await flush(); },
        async fresh() { push('prices.crypto'); push('prices.crypto.twap'); await flush(); history.capture(btc, now); },
        async close() { const task = feed.close(); await flush(); return task; } };
}

test('stale source prices trigger autonomous recovery despite live pong messages, retaining verified openings', async () => {
    const f = fixture(); await f.start(); await f.fresh();
    assert.equal(f.btc.status(f.now).ready, true); assert.ok(f.btc.openings.has(300000));
    assert.equal(f.history.points.length, 1);
    for (let i = 0; i < 3; i++) { await f.advance(5000); f.streams[0].push({ type: 'pong' }); await flush(); }
    assert.equal(f.subscriptions, 1);
    await f.advance(1000);
    assert.equal(f.streams[0].closes, 1); assert.equal(f.btc.spot.length, 0); assert.equal(f.btc.twap, null);
    assert.equal(f.history.points.length, 0); assert.ok(f.btc.openings.has(300000));
    const gap = f.events.find(event => event.type === 'btc_feed_gap' && event.reason === 'source_price_stall');
    assert.equal(gap.spotAgeMs, 16000); assert.equal(gap.twapAgeMs, 16000); assert.equal(gap.generation, 1);
    await f.advance(1999); assert.equal(f.subscriptions, 1);
    await f.advance(1); assert.equal(f.subscriptions, 2); await f.fresh();
    assert.equal(f.btc.spot.length, 1); assert.equal(f.feed.status().generation, 2); await f.close();
});

test('initial absence of prices, stale TWAP, malformed and duplicate messages never count as health', async () => {
    for (const mode of ['empty', 'twap', 'invalid', 'duplicate']) {
        const f = fixture(); await f.start();
        if (mode !== 'empty') await f.fresh();
        const originalAt = f.now;
        for (let i = 0; i < 16; i++) {
            await f.advance(1000);
            if (f.feed.source?.retired || !f.feed.source) break;
            if (mode === 'twap') f.push('prices.crypto');
            if (mode === 'invalid') { f.push('prices.crypto', f.now + 1); f.push('prices.crypto.twap', f.now, -1); }
            if (mode === 'duplicate') { f.push('prices.crypto', originalAt); f.push('prices.crypto.twap', originalAt); }
            await flush();
        }
        assert.equal(f.streams[0].closes, 1, mode);
        assert.equal(f.subscriptions, 1, mode);
        assert.ok(f.events.some(event => event.type === 'btc_feed_retry_scheduled'), mode);
        await f.close();
    }
});

test('close hanging or rejecting never allows overlapping subscriptions, even after iterator ends', async () => {
    for (const rejects of [false, true]) {
        const f = fixture({ stream: { closePending: true } }); await f.start(); await f.fresh();
        await f.advance(16000);
        assert.equal(f.streams[0].ended, true); assert.equal(f.feed.source.workFinished, true);
        if (rejects) f.streams[0].closeGate.reject(new Error('private_close_failure_details'));
        await flush();
        for (let i = 0; i < 10; i++) { await f.advance(10000); f.feed.start(); await flush(); }
        assert.equal(f.subscriptions, 1); assert.equal(f.streams[0].closes, 1);
        assert.equal(f.events.filter(event => event.type === 'btc_feed_close_wait').length, 1);
        assert.ok(!JSON.stringify(f.events).includes('private_close_failure_details'));
        if (!rejects) {
            f.streams[0].closeGate.resolve(); await flush();
            await f.advance(2000); assert.equal(f.subscriptions, 2);
            f.streams[1].closeGate.resolve(); await f.close();
        } else { f.feed.close(); await flush(); assert.equal(f.timerCanceled, true); }
    }
});

test('a short source gap invalidates windows without prematurely treating an old connection as a 15s stall', async () => {
    const f = fixture(); await f.start(); await f.fresh();
    for (let i = 0; i < 20; i++) { await f.advance(1000); await f.fresh(); }
    await f.advance(6000); f.push('prices.crypto'); await flush();
    assert.equal(f.btc.twap, null);
    f.feed.pulse(); await flush();
    assert.equal(f.streams[0].closes, 0); assert.equal(f.feed.status().twapAgeMs, 6000);
    await f.advance(1000); await f.fresh();
    assert.equal(f.btc.status(f.now).ready, true); assert.equal(f.subscriptions, 1);
    await f.close();
});

test('confirmed close still waits for iterator exit and ignores retired queued events', async () => {
    const f = fixture({ stream: { endOnClose: false } }); await f.start(); await f.fresh();
    const old = f.streams[0]; await f.advance(16000);
    assert.equal(f.feed.source.closeConfirmed, true); assert.equal(f.feed.source.workFinished, false);
    old.push({ type: 'update', topic: 'prices.crypto', payload: { symbol: 'btcusd', timestamp: f.now, value: 99999 } });
    await flush(); assert.equal(f.btc.spot.length, 0);
    await f.advance(60000); assert.equal(f.subscriptions, 1);
    old.end(); await flush(); await f.advance(2000); assert.equal(f.subscriptions, 2);
    await f.fresh(); old.push({ type: 'update', topic: 'prices.crypto', payload: { symbol: 'btcusd', timestamp: f.now, value: 99999 } });
    await flush(); assert.equal(f.btc.spot.at(-1).value, 83000);
    const closing = f.feed.close(); await flush(); f.streams[1].end(); await closing;
});

test('pending authentication and subscription retain generation barrier and late handles are closed', async () => {
    const auth = deferred(); let subscriptions = 0;
    const f = fixture({ authenticate: () => auth.promise }); await f.start(); await f.advance(16000);
    await f.advance(30000); assert.equal(f.feed.source.generation, 1);
    auth.resolve({ subscribe: async () => { subscriptions++; return new FakeStream(); } });
    await flush(); assert.equal(subscriptions, 0);
    assert.ok(f.events.some(event => event.reason === 'initial_feed_stall')); await f.close();

    const pending = deferred(), late = new FakeStream();
    const g = fixture({ authenticate: async () => ({ subscribe: () => { subscriptions++; return pending.promise; } }) });
    await g.start(); await g.advance(16000); await g.advance(30000);
    assert.equal(subscriptions, 1); const closing = g.feed.close();
    pending.resolve(late); await flush(); await closing;
    assert.equal(late.closes, 1); assert.equal(g.btc.spot.length, 0);
    assert.equal(g.events.filter(event => event.type === 'btc_feed_connected').length, 0);
    await g.advance(60000); g.feed.start(); assert.equal(subscriptions, 1);
});

test('backoff grows to its bound and only a continuous healthy minute resets failures', async () => {
    const f = fixture(); await f.start();
    const delays = [];
    for (let i = 0; i < 6; i++) {
        await f.advance(16000);
        const event = f.events.filter(event => event.type === 'btc_feed_retry_scheduled').at(-1);
        delays.push(event.retryMs); await f.advance(event.retryMs);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000]);
    await f.fresh();
    for (let i = 0; i < 62; i++) { await f.advance(1000); await f.fresh(); }
    assert.equal(f.feed.failures, 0);
    await f.advance(16000); assert.equal(f.events.filter(event => event.type === 'btc_feed_retry_scheduled').at(-1).retryMs, 2000);
    await f.close();
});

test('shutdown cancels watchdog and rejects late authentication without starting a subscription', async () => {
    const auth = deferred(); let subscribed = 0;
    const f = fixture({ authenticate: () => auth.promise }); await f.start();
    const closing = f.feed.close();
    assert.equal(f.timerCanceled, true);
    auth.resolve({ subscribe: async () => { subscribed++; return new FakeStream(); } });
    await closing; await f.advance(60000); f.feed.start();
    assert.equal(subscribed, 0); assert.equal(f.feed.status().phase, 'closed');
});

test('paper reader retains public-only surface and injects watchdog policy without live operations', async () => {
    const stream = new FakeStream(), calls = [];
    const reader = premarketReader({ control: { ...BASELINE, strategies: ['late-entry'], rpcUrl: 'https://polygon.drpc.org',
        rpcUrls: ['https://polygon.drpc.org'] }, feedWatchdog: { ...PREMARKET_FEED_WATCHDOG } }, event => calls.push(event),
    { authenticate: async () => ({ subscribe: async () => stream }) });
    assert.deepEqual(Object.keys(reader).sort(), ['books', 'btc', 'btcStatus', 'clock', 'close', 'market', 'marketInfo',
        'payout', 'serverTime', 'startBtcFeed', 'tickSize', 'validateInfo'].sort());
    reader.startBtcFeed(); await flush();
    assert.equal(reader.btcStatus().watchdog.phase, 'streaming');
    await reader.close(); assert.equal(stream.closes, 1);
    assert.equal(reader.btcStatus().watchdog.phase, 'closed');
});

test('engine shutdown propagates the reader drain promise until handle close and iterator both finish', async () => {
    const stream = new FakeStream({ closePending: true, endOnClose: false });
    const reader = premarketReader({ control: { ...BASELINE, strategies: ['late-entry'], rpcUrl: 'https://polygon.drpc.org',
        rpcUrls: ['https://polygon.drpc.org'] }, feedWatchdog: { ...PREMARKET_FEED_WATCHDOG } }, () => {},
    { authenticate: async () => ({ subscribe: async () => stream }) });
    reader.startBtcFeed(); await flush();
    const engine = new PremarketPaperEngine({ armNames: [] }, { state: { arms: {} }, save() {} }, reader);
    let drained = false;
    const closing = engine.close().then(() => { drained = true; });
    await flush(); assert.equal(engine.closed, true); assert.equal(drained, false);
    stream.closeGate.resolve(); await flush(); assert.equal(drained, false);
    stream.end(); await closing;
    assert.equal(drained, true); assert.equal(reader.btcStatus().watchdog.phase, 'closed');
});
