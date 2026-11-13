import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CANDLE_HISTORY, BinanceCandleHistoryCollector, readCandleHistory, candleHistoryContext }
    from '../../src/premarket-paper/candle-history.js';

const interval = 300000, end = 1800000000000;
const rows = (last = end, count = 30) => Array.from({ length: count }, (_, index) => {
    const at = last - (count - index) * interval, price = 100 + index;
    return [at, String(price), String(price + 2), String(price - 1), String(price + 1), '10',
        at + interval - 1, '1000', 5, '4', '400', '0'];
});
const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const flush = () => new Promise(resolve => setImmediate(resolve));

class Socket extends EventEmitter {
    open() { this.emit('open'); }
    terminate() { this.emit('close'); }
    close() { this.emit('close'); }
}

function fixture(t, options = {}, dependencies = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'candle-history-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'btc.json');
    const f = { at: end + 10000, filename, directory, timers: new Map(), timerId: 0, sockets: [], calls: [],
        events: [], raw: rows(), request: null };
    const setTimer = (callback, delay) => {
        const id = ++f.timerId; f.timers.set(id, { callback, delay, at: f.at + delay }); return id;
    };
    f.collector = new BinanceCandleHistoryCollector({ filename, ...options }, {
        now: () => f.at, request: async (url, requestOptions) => {
            f.calls.push({ url, requestOptions });
            return f.request ? f.request(url, requestOptions) : response(f.raw);
        }, socketFactory: url => { const socket = new Socket(); f.sockets.push({ url, socket }); return socket; },
        setTimer, clearTimer: id => f.timers.delete(id), onEvent: event => f.events.push(event), ...dependencies,
    });
    f.runTimer = async match => {
        const entry = [...f.timers].find(([, timer]) => match(timer));
        assert(entry, 'Expected scheduled timer');
        const [id, timer] = entry; f.timers.delete(id); f.at = Math.max(f.at, timer.at);
        timer.callback(); await flush();
    };
    t.after(() => f.collector.stop());
    return f;
}

function message(f, { closed = false, openAt = Math.floor(f.at / interval) * interval, changes = {} } = {}) {
    return JSON.stringify({ e: 'kline', E: f.at, s: 'BTCUSDT', k: { t: openAt, T: openAt + interval - 1,
        s: 'BTCUSDT', i: '5m', o: '129', h: '131', l: '128', c: '130', v: '10', q: '1000', n: 5,
        x: closed, ...changes } });
}

test('startup REST immediately provides thirty closed five-minute candles with explicit external provenance', async t => {
    const f = fixture(t), status = await f.collector.start();
    assert.equal(status.ready, true); assert.equal(status.barCount, 30);
    const context = readCandleHistory(f.filename, { snapshotAt: f.at, now: f.at });
    assert.equal(context.ready, true); assert.equal(context.bars.length, 30);
    assert.equal(context.source, 'binance_spot'); assert.equal(context.symbol, 'BTCUSDT');
    assert.equal(context.officialSettlement, false); assert.equal(context.windowEnd, end);
    assert.equal(context.windowStart, end - 150 * 60000);
    assert.equal(context.bars[0].observedAt, f.at); assert.equal(context.bars.at(-1).closeAt, end);
    assert.equal(context.fetchedAt, f.at); assert.equal(context.observedAt, f.at);
    const url = new URL(f.calls[0].url);
    assert.equal(url.origin, 'https://data-api.binance.vision'); assert.equal(url.searchParams.get('interval'), '5m');
    assert.equal(url.searchParams.get('symbol'), 'BTCUSDT'); assert.equal(url.searchParams.get('endTime'), String(end - 1));
    assert.equal(f.sockets[0].url, 'wss://data-stream.binance.vision/ws/btcusdt@kline_5m');
    assert.deepEqual(Object.keys(f.calls[0].requestOptions.headers), ['accept']);
});

test('forming REST and stream candles never enter closed history', async t => {
    const f = fixture(t); f.raw.push(rows(end + interval, 1)[0]);
    await f.collector.start();
    const original = structuredClone(f.collector.cache.bars);
    f.at += 2000;
    assert.equal(f.collector.acceptMessage(message(f)), true);
    assert.deepEqual(f.collector.cache.bars, original);
    assert.equal(f.collector.cache.observedAt, f.at);
    assert.equal(f.collector.cache.fetchedAt, end + 10000);
    assert.equal(f.collector.context().ready, true);
});

test('the exact boundary requires the newly closed bar and cannot reuse the prior thirty', async t => {
    const f = fixture(t); await f.collector.start();
    f.at = end + interval - 1; f.collector.acceptMessage(message(f));
    assert.equal(f.collector.context().ready, true);
    f.at++;
    assert.equal(f.collector.context().reason, 'candle_history_gap');
    f.collector.acceptMessage(message(f, { closed: true, openAt: end }));
    const context = f.collector.context();
    assert.equal(context.ready, true); assert.equal(context.bars.length, 30);
    assert.equal(context.windowEnd, end + interval); assert.equal(context.bars.at(-1).closeAt, end + interval);
    assert.equal(context.bars.at(-1).observedAt, f.at);
});

test('a closed stream event may use Binance inclusive end while normalized close remains exclusive', async t => {
    const f = fixture(t); await f.collector.start(); f.at = end + interval;
    const frame = JSON.parse(message(f, { closed: true, openAt: end }));
    frame.E = frame.k.T;
    assert.equal(f.collector.acceptMessage(JSON.stringify(frame)), true);
    assert.equal(f.collector.context().bars.at(-1).closeAt, end + interval);
});

test('failed cache persistence retains the last committed history and reports degradation', async t => {
    let failWrite = false;
    const f = fixture(t, {}, { writeCache(filename, value) {
        if (failWrite) throw new Error('disk unavailable');
        fs.writeFileSync(filename, JSON.stringify(value));
    } });
    await f.collector.start();
    const before = structuredClone(f.collector.cache), bytes = fs.readFileSync(f.filename);
    failWrite = true; f.at += 1000;
    assert.equal(await f.collector.backfill(), false);
    assert.equal(f.collector.lastError, 'candle_history_cache_write_failed');
    assert.deepEqual(f.collector.cache, before); assert.deepEqual(fs.readFileSync(f.filename), bytes);
});

test('as-of reads preserve earlier identical bars but never backdate late or changed observations', async t => {
    const f = fixture(t); await f.collector.start();
    const snapshotAt = f.at;
    f.at += 2000; f.collector.acceptMessage(message(f));
    assert.equal(f.collector.context({ snapshotAt }).ready, true);
    assert.equal(f.collector.context({ snapshotAt }).observedAt, snapshotAt);
    assert.equal(f.collector.context({ snapshotAt: snapshotAt - 1 }).reason, 'candle_history_not_observed');
    await f.collector.backfill();
    assert.equal(f.collector.context({ snapshotAt }).ready, true);
    assert.equal(f.collector.cache.bars[0].observedAt, snapshotAt);
    f.raw[0][4] = '102';
    f.at++;
    await f.collector.backfill();
    assert.equal(f.collector.context({ snapshotAt }).reason, 'candle_history_not_observed');
    assert.equal(f.collector.context().ready, true);
});

test('cache readers reject stale, missing, malformed, duplicate and noncontiguous history', async t => {
    const f = fixture(t); await f.collector.start();
    const cache = structuredClone(f.collector.cache);
    const changes = {
        'missing bar': value => value.bars.splice(5, 1),
        'duplicate bar': value => value.bars.splice(5, 0, value.bars[5]),
        'future receipt': value => { value.bars[0].observedAt = f.at + 1; },
        'bad source': value => { value.source = 'chainlink'; },
        'bad interval': value => { value.interval = '1m'; },
        'bad OHLC': value => { value.bars[0].high = 1; },
        'NaN': value => { value.bars[0].volume = NaN; },
        'negative volume': value => { value.bars[0].volume = -1; },
        'inclusive close': value => { value.bars[0].closeAt--; },
        'future write': value => { value.writtenAt = f.at - 1; },
        'duplicate observation': value => { value.observations.push(f.at); },
    };
    for (const [name, change] of Object.entries(changes)) {
        const value = structuredClone(cache); change(value);
        assert.equal(candleHistoryContext(value, { snapshotAt: f.at, now: f.at }).ready, false, name);
    }
    f.at += 90001;
    assert.equal(f.collector.context().reason, 'candle_history_stale');
    assert.equal(readCandleHistory(path.join(f.directory, 'missing'), { snapshotAt: f.at }).reason, 'candle_history_missing');
    assert.equal(readCandleHistory(f.filename, { snapshotAt: f.at, readFileSync: () => '{' }).reason, 'candle_history_cache_invalid');
});

test('a stream gap retains old history and schedules REST repair without a full live warmup', async t => {
    const f = fixture(t); await f.collector.start();
    const first = structuredClone(f.collector.cache.bars[0]);
    f.at = end + 2 * interval + 1000;
    f.collector.acceptMessage(message(f, { closed: true, openAt: end + interval }));
    assert.equal(f.collector.context().reason, 'candle_history_gap');
    assert.deepEqual(f.collector.cache.bars[0], first);
    f.raw = rows(end + 2 * interval);
    await f.runTimer(timer => timer.delay === 0);
    assert.equal(f.collector.context().ready, true);
    assert.equal(f.collector.context().windowEnd, end + 2 * interval);
    assert.equal(f.collector.cache.bars.length, 32);
    assert.deepEqual(f.collector.cache.bars[0], first);
});

test('late REST responses merge with newer stream observations instead of replacing them', async t => {
    const f = fixture(t); await f.collector.start();
    let resolve;
    f.request = () => new Promise(done => { resolve = done; });
    const pending = f.collector.backfill(); await flush();
    f.at = end + interval;
    f.collector.acceptMessage(message(f, { closed: true, openAt: end }));
    const latest = structuredClone(f.collector.cache.bars.at(-1));
    resolve(response(rows())); await pending;
    assert.deepEqual(f.collector.cache.bars.at(-1), latest);
    assert.equal(f.collector.context().ready, true);
});

test('transport failure and throttling preserve the cache and bound retry concurrency', async t => {
    const f = fixture(t); await f.collector.start();
    const bytes = fs.readFileSync(f.filename), cache = structuredClone(f.collector.cache);
    let resolve;
    f.request = () => new Promise(done => { resolve = done; });
    const first = f.collector.backfill();
    assert.equal(f.collector.backfill(), first); await flush();
    resolve({ ok: false, status: 429, headers: { get: () => '120' } });
    assert.equal(await first, false);
    assert.equal(f.collector.status().reason, 'candle_history_rate_limited');
    assert.equal(f.collector.restNotBefore, f.at + 120000);
    assert.deepEqual(f.collector.cache, cache); assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(await f.collector.backfill(), false); assert.equal(f.calls.length, 2);
    assert.equal(f.collector.delay(100), 60000);
    f.request = async () => response(f.raw);
    await f.runTimer(timer => timer.at === f.collector.restNotBefore);
    assert.equal(f.collector.status().ready, true); assert.equal(f.collector.restFailures, 0);
});

test('REST deadlines also bound body parsing and transport never crashes the collector', async t => {
    const f = fixture(t);
    f.request = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const pending = f.collector.start(); await flush();
    await f.runTimer(timer => timer.delay === 10000);
    const status = await pending;
    assert.equal(status.ready, false); assert.equal(status.reason, 'candle_history_timeout');
    assert.equal(f.calls[0].requestOptions.signal.aborted, true);
    assert.equal(f.collector.running, true);
});

test('socket reconnection uses bounded backoff and valid heartbeat does not invent fresh data', async t => {
    const f = fixture(t); await f.collector.start();
    f.sockets[0].socket.open(); f.sockets[0].socket.emit('error', new Error('url-with-private-query'));
    assert.equal(f.collector.connected, false);
    await f.runTimer(timer => timer.delay === 1000);
    assert.equal(f.sockets.length, 2);
    f.sockets[1].socket.emit('error', new Error('down'));
    await f.runTimer(timer => timer.delay === 2000);
    assert.equal(f.sockets.length, 3);
    assert.equal(JSON.stringify(f.events).includes('url-with-private-query'), false);
    const observedAt = f.collector.cache.observedAt;
    f.request = async () => { throw new Error('offline'); };
    f.at += 90001;
    await f.runTimer(timer => timer.delay === 15000);
    assert.equal(f.collector.cache.observedAt, observedAt);
    assert.equal(f.collector.context().ready, false);
    assert.equal(f.events.some(event => event.type === 'candle_history_heartbeat'), true);
});

test('malformed, stale, future and mismatched stream frames cannot update cache freshness', async t => {
    const f = fixture(t); await f.collector.start();
    const original = structuredClone(f.collector.cache);
    const frames = [
        '{}', message(f, { changes: { s: 'ETHUSDT' } }), message(f, { changes: { i: '1m' } }),
        message(f, { changes: { h: '1' } }), message(f, { changes: { v: '-1' } }),
        message(f, { changes: { T: end + interval } }), message(f, { closed: true }),
        JSON.stringify({ ...JSON.parse(message(f)), E: f.at + 1 }),
        JSON.stringify({ ...JSON.parse(message(f)), E: f.at - 90001 }),
    ];
    for (const frame of frames) {
        assert.throws(() => f.collector.acceptMessage(frame), /candle_history_/);
        assert.deepEqual(f.collector.cache, original);
    }
    f.at--;
    assert.throws(() => f.collector.acceptMessage(message(f)), /clock_regressed/);
    assert.deepEqual(f.collector.cache, original);
});

test('stopping aborts in-flight work and prevents callbacks from writing or reconnecting', async t => {
    const f = fixture(t); await f.collector.start();
    const bytes = fs.readFileSync(f.filename);
    let resolve;
    f.request = () => new Promise(done => { resolve = done; });
    const pending = f.collector.backfill(); await flush();
    f.collector.stop();
    assert.equal(f.calls.at(-1).requestOptions.signal.aborted, true);
    resolve(response(rows())); assert.equal(await pending, false);
    assert.equal(f.timers.size, 0); assert.equal(f.collector.connected, false);
    f.sockets[0].socket.emit('message', message(f));
    assert.deepEqual(fs.readFileSync(f.filename), bytes);
    assert.equal(await f.collector.backfill(), false);
});

test('restart loads persistent history while a failed startup fetch leaves it intact', async t => {
    const f = fixture(t); await f.collector.start(); f.collector.stop();
    const before = structuredClone(f.collector.cache);
    f.request = async () => { throw new Error('offline'); };
    const status = await f.collector.start();
    assert.equal(status.ready, true); assert.equal(status.status, 'degraded');
    assert.deepEqual(f.collector.cache, before);
    assert.equal(CANDLE_HISTORY.count, 30);
});
