import fs from 'node:fs';
import WebSocket from 'ws';
import { atomicJson } from '../restart/store.js';

export const CANDLE_HISTORY = Object.freeze({ schema: 1, source: 'binance_spot', symbol: 'BTCUSDT',
    interval: '5m', intervalMs: 300000, count: 30 });
const REST_URL = 'https://data-api.binance.vision/api/v3/klines';
const STREAM_URL = 'wss://data-stream.binance.vision/ws/btcusdt@kline_5m';
const MAX_BARS = 288, MAX_OBSERVATIONS = 512, MAX_BYTES = 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw new Error(`candle_history_${code}`); };
const errorCode = error => /^candle_history_[a-z_]+$/.test(error?.message || '') ? error.message : 'candle_history_transport';
const expectedEnd = at => Math.floor(at / CANDLE_HISTORY.intervalMs) * CANDLE_HISTORY.intervalMs;
const identity = value => Object.entries(CANDLE_HISTORY).filter(([key]) => key !== 'count').every(([key, item]) => value?.[key] === item);
const payload = bar => [bar.openAt, bar.closeAt, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.quoteVolume, bar.trades];

function number(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) fail('bar_invalid');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) fail('bar_invalid');
    return parsed;
}

function validBar(bar) {
    if (!record(bar) || !time(bar.openAt) || bar.openAt % CANDLE_HISTORY.intervalMs !== 0
        || bar.closeAt !== bar.openAt + CANDLE_HISTORY.intervalMs || !time(bar.observedAt)
        || bar.observedAt < bar.closeAt || ![bar.open, bar.high, bar.low, bar.close].every(value => Number.isFinite(value) && value > 0)
        || bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low
        || ![bar.volume, bar.quoteVolume].every(value => Number.isFinite(value) && value >= 0)
        || !time(bar.trades)) fail('bar_invalid');
    return bar;
}

function parsedBar(row, observedAt) {
    if (!Array.isArray(row) || row.length < 9 || !time(row[0]) || !time(row[6])) fail('bar_invalid');
    return validBar({ openAt: row[0], closeAt: row[6] + 1, open: number(row[1]), high: number(row[2]),
        low: number(row[3]), close: number(row[4]), volume: number(row[5]), quoteVolume: number(row[7]),
        trades: row[8], observedAt });
}

function validateCache(cache) {
    if (!record(cache) || !identity(cache) || cache.officialSettlement !== false
        || !time(cache.observedAt) || !time(cache.writtenAt) || cache.observedAt > cache.writtenAt
        || cache.fetchedAt !== null && (!time(cache.fetchedAt) || cache.fetchedAt > cache.observedAt)
        || !Array.isArray(cache.bars) || cache.bars.length > MAX_BARS
        || !Array.isArray(cache.observations) || !cache.observations.length || cache.observations.length > MAX_OBSERVATIONS
        || cache.observations.at(-1) !== cache.observedAt
        || cache.observations.some((at, index) => !time(at) || index > 0 && at <= cache.observations[index - 1])) fail('cache_invalid');
    let previous = -1;
    for (const bar of cache.bars) {
        validBar(bar);
        if (bar.openAt <= previous || bar.observedAt > cache.observedAt) fail('cache_invalid');
        previous = bar.openAt;
    }
    return cache;
}

export function candleHistoryContext(cache, { snapshotAt, now = Date.now(), maxAgeMs = 90000, count = CANDLE_HISTORY.count } = {}) {
    const base = { ...CANDLE_HISTORY, count, officialSettlement: false, ready: false };
    try {
        if (!time(snapshotAt) || !time(now) || now < snapshotAt || !time(maxAgeMs) || maxAgeMs < 1
            || !Number.isSafeInteger(count) || count < 1 || count > MAX_BARS) fail('snapshot_invalid');
        validateCache(cache);
        const windowEnd = expectedEnd(snapshotAt), windowStart = windowEnd - count * CANDLE_HISTORY.intervalMs;
        const observations = cache.observations.filter(at => at <= snapshotAt), observedAt = observations.at(-1);
        if (observedAt === undefined) fail('not_observed');
        if (snapshotAt - observedAt > maxAgeMs || now - observedAt > maxAgeMs) fail('stale');
        const bars = cache.bars.filter(bar => bar.openAt >= windowStart && bar.closeAt <= windowEnd);
        if (bars.length !== count || bars.some((bar, index) => bar.openAt !== windowStart + index * CANDLE_HISTORY.intervalMs)) fail('gap');
        if (bars.some(bar => bar.observedAt > snapshotAt || bar.observedAt > observedAt)) fail('not_observed');
        return { ...base, ready: true, reason: null, snapshotAt, windowStart, windowEnd,
            expectedLatestClosedAt: windowEnd, observedAt,
            fetchedAt: cache.fetchedAt !== null && cache.fetchedAt <= snapshotAt ? cache.fetchedAt : null,
            bars: structuredClone(bars) };
    } catch (error) { return { ...base, reason: errorCode(error), bars: [] }; }
}

export function readCandleHistory(filename, options = {}) {
    try {
        const read = options.readFileSync || fs.readFileSync, bytes = read(filename, 'utf8');
        if (Buffer.byteLength(bytes) > MAX_BYTES) fail('cache_invalid');
        return candleHistoryContext(JSON.parse(bytes), options);
    } catch (error) {
        return { ...CANDLE_HISTORY, officialSettlement: false, ready: false,
            reason: error?.code === 'ENOENT' ? 'candle_history_missing' : 'candle_history_cache_invalid', bars: [] };
    }
}

export class BinanceCandleHistoryCollector {
    constructor({ filename, maxAgeMs = 90000, heartbeatMs = 15000, requestTimeoutMs = 10000,
        reconnectMinMs = 1000, reconnectMaxMs = 60000 } = {}, {
        now = Date.now, request = globalThis.fetch, socketFactory = url => new WebSocket(url),
        readFileSync = fs.readFileSync, writeCache = atomicJson, setTimer = setTimeout, clearTimer = clearTimeout,
        onEvent = () => {},
    } = {}) {
        if (typeof filename !== 'string' || !filename || [maxAgeMs, heartbeatMs, requestTimeoutMs, reconnectMinMs, reconnectMaxMs]
            .some(value => !time(value) || value < 1) || reconnectMaxMs < reconnectMinMs) fail('config_invalid');
        Object.assign(this, { filename, maxAgeMs, heartbeatMs, requestTimeoutMs, reconnectMinMs, reconnectMaxMs,
            now, request, socketFactory, readFileSync, writeCache, setTimer, clearTimer, onEvent });
        this.cache = null; this.running = false; this.connected = false; this.socket = null;
        this.restPending = null; this.restTimer = null; this.socketTimer = null; this.heartbeatTimer = null;
        this.restFailures = 0; this.socketFailures = 0; this.restNotBefore = 0; this.lastClock = 0;
        this.lastMessageAt = null; this.lastError = null; this.generation = 0;
    }
    emit(type, detail = {}) {
        try { this.onEvent({ type, at: this.now(), ...detail }); } catch {}
    }
    clock() {
        const at = this.now();
        if (!time(at) || at < this.lastClock) fail('clock_regressed');
        this.lastClock = at;
        return at;
    }
    status(at = this.now()) {
        const context = this.context({ snapshotAt: at, now: at });
        return { ...CANDLE_HISTORY, running: this.running, connected: this.connected, ready: context.ready,
            status: context.ready && this.connected && !this.lastError ? 'healthy' : 'degraded',
            reason: this.lastError || context.reason, observedAt: this.cache?.observedAt ?? null,
            fetchedAt: this.cache?.fetchedAt ?? null, latestClosedAt: this.cache?.bars.at(-1)?.closeAt ?? null,
            barCount: this.cache?.bars.length || 0, restPending: !!this.restPending,
            retryAt: this.restNotBefore, officialSettlement: false };
    }
    context(options = {}) {
        return candleHistoryContext(this.cache, { snapshotAt: this.now(), now: this.now(), maxAgeMs: this.maxAgeMs, ...options });
    }
    load() {
        try {
            const bytes = this.readFileSync(this.filename, 'utf8');
            if (Buffer.byteLength(bytes) > MAX_BYTES) fail('cache_invalid');
            this.cache = validateCache(JSON.parse(bytes));
        } catch (error) {
            if (error?.code !== 'ENOENT') { this.lastError = 'candle_history_cache_invalid'; this.emit('candle_history_degraded', { reason: this.lastError }); }
        }
    }
    async start() {
        if (this.running) return this.restPending || this.status();
        this.running = true; this.generation++;
        this.load(); this.connect(); this.heartbeat();
        await this.backfill();
        return this.status();
    }
    stop() {
        this.running = false; this.generation++;
        for (const name of ['restTimer', 'socketTimer', 'heartbeatTimer']) {
            if (this[name] !== null) this.clearTimer(this[name]); this[name] = null;
        }
        this.abort?.abort(); this.abort = null;
        const socket = this.socket; this.socket = null; this.connected = false;
        try { socket?.terminate?.(); socket?.close?.(); } catch {}
    }
    delay(attempts) { return Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(Math.max(0, attempts - 1), 16)); }
    scheduleRest(delay = 0) {
        if (!this.running || this.restTimer !== null) return;
        const wait = Math.max(delay, this.restNotBefore - this.now(), 0);
        this.restTimer = this.setTimer(() => { this.restTimer = null; void this.backfill(); }, wait);
        this.restTimer?.unref?.();
    }
    merge(bars, observedAt, { fetchedAt = null, requestStartedAt = null } = {}) {
        const prior = this.cache, rows = new Map((prior?.bars || []).map(bar => [bar.openAt, bar]));
        if (prior && observedAt < prior.observedAt) fail('clock_regressed');
        for (const bar of bars) {
            const previous = rows.get(bar.openAt);
            if (previous && JSON.stringify(payload(previous)) === JSON.stringify(payload(bar))) continue;
            // A REST request started before a newer stream observation cannot
            // replace that observation when its response arrives late.
            if (previous && requestStartedAt !== null && previous.observedAt > requestStartedAt) continue;
            rows.set(bar.openAt, bar);
        }
        const observations = [...new Set([...(prior?.observations || []), observedAt])]
            .filter(at => at >= observedAt - 15 * 60000).slice(-MAX_OBSERVATIONS);
        const next = { ...CANDLE_HISTORY, officialSettlement: false, fetchedAt: fetchedAt ?? prior?.fetchedAt ?? null,
            observedAt, writtenAt: observedAt, observations,
            bars: [...rows.values()].sort((a, b) => a.openAt - b.openAt).slice(-MAX_BARS) };
        validateCache(next);
        try { this.writeCache(this.filename, next); }
        catch { fail('cache_write_failed'); }
        this.cache = next;
        this.lastError = null;
    }
    backfill() {
        if (this.restPending) return this.restPending;
        if (!this.running) return Promise.resolve(false);
        if (this.now() < this.restNotBefore) { this.scheduleRest(); return Promise.resolve(false); }
        const generation = this.generation;
        const pending = Promise.resolve().then(async () => {
            let timeout;
            try {
                const startedAt = this.clock(), end = expectedEnd(startedAt);
                const url = new URL(REST_URL);
                for (const [key, value] of Object.entries({ symbol: CANDLE_HISTORY.symbol, interval: CANDLE_HISTORY.interval,
                    limit: MAX_BARS, endTime: end - 1 })) url.searchParams.set(key, String(value));
                const controller = this.abort = new AbortController();
                const raw = await Promise.race([
                    (async () => {
                        const response = await this.request(url.href, { signal: controller.signal, headers: { accept: 'application/json' } });
                        if (!response?.ok) {
                            if ([429, 418, 503].includes(response?.status)) {
                                const value = response.headers?.get?.('retry-after'), seconds = Number(value);
                                const retryAt = value && Number.isFinite(seconds) ? this.now() + Math.max(0, seconds) * 1000 : Date.parse(value);
                                if (Number.isFinite(retryAt)) this.restNotBefore = Math.max(this.restNotBefore, retryAt);
                            }
                            fail(response?.status === 429 || response?.status === 418 ? 'rate_limited' : 'http_failed');
                        }
                        return response.json();
                    })(),
                    new Promise((_, reject) => {
                        timeout = this.setTimer(() => { controller.abort(); reject(new Error('candle_history_timeout')); }, this.requestTimeoutMs);
                        timeout?.unref?.();
                    }),
                ]);
                const at = this.clock();
                if (!this.running || generation !== this.generation) return false;
                if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BARS + 1) fail('response_invalid');
                const bars = [];
                let previous = -1;
                for (const row of raw) {
                    if (!Array.isArray(row) || !time(row[0]) || !time(row[6]) || row[0] <= previous) fail('response_invalid');
                    previous = row[0];
                    if (row[6] + 1 > end || row[6] + 1 > at) continue;
                    bars.push(parsedBar(row, at));
                }
                if (bars.length < CANDLE_HISTORY.count || bars.at(-1)?.closeAt !== end
                    || bars.some((bar, index) => index > 0 && bar.openAt !== bars[index - 1].closeAt)) fail('response_gap');
                this.merge(bars, at, { fetchedAt: at, requestStartedAt: startedAt });
                this.restFailures = 0; this.restNotBefore = 0;
                if (!this.context({ snapshotAt: at, now: at }).ready) this.scheduleRest();
                this.emit('candle_history_backfilled', { bars: bars.length, latestClosedAt: bars.at(-1).closeAt });
                return true;
            } catch (error) {
                if (!this.running || generation !== this.generation) return false;
                this.lastError = errorCode(error); this.restFailures++;
                this.restNotBefore = Math.max(this.restNotBefore, this.now() + this.delay(this.restFailures));
                this.emit('candle_history_degraded', { reason: this.lastError, retryAt: this.restNotBefore });
                this.scheduleRest();
                return false;
            } finally { if (timeout !== undefined) this.clearTimer(timeout); this.abort = null; }
        }).finally(() => { if (this.restPending === pending) this.restPending = null; });
        this.restPending = pending;
        return pending;
    }
    connect() {
        if (!this.running || this.socket || this.socketTimer !== null) return;
        const generation = this.generation;
        let socket;
        const disconnected = error => {
            if (!this.running || generation !== this.generation || socket && this.socket !== socket) return;
            this.socket = null; this.connected = false; this.socketFailures++;
            this.lastError = error ? errorCode(error) : 'candle_history_disconnected';
            try { socket?.terminate?.(); socket?.close?.(); } catch {}
            const delay = this.delay(this.socketFailures);
            this.emit('candle_history_degraded', { reason: this.lastError, reconnectMs: delay });
            this.socketTimer = this.setTimer(() => { this.socketTimer = null; this.connect(); }, delay);
            this.socketTimer?.unref?.(); this.scheduleRest();
        };
        try {
            socket = this.socketFactory(STREAM_URL); this.socket = socket; this.lastMessageAt = this.now();
            socket.on('open', () => {
                if (this.socket !== socket || !this.running) return;
                this.connected = true; this.lastMessageAt = this.now(); this.scheduleRest();
            });
            socket.on('message', bytes => {
                if (this.socket !== socket || !this.running) return;
                try { this.acceptMessage(bytes); this.socketFailures = 0; }
                catch (error) { disconnected(error); }
            });
            socket.on('error', disconnected);
            socket.on('close', () => disconnected());
        } catch (error) { disconnected(error); }
    }
    acceptMessage(bytes) {
        if (!this.running) return false;
        const at = this.clock();
        if (Buffer.byteLength(bytes) > 65536) fail('message_invalid');
        let message;
        try { message = JSON.parse(String(bytes)); } catch { fail('message_invalid'); }
        const k = message?.k;
        if (message?.e !== 'kline' || message.s !== CANDLE_HISTORY.symbol || !time(message.E) || message.E > at
            || at - message.E > this.maxAgeMs || !record(k) || k.s !== CANDLE_HISTORY.symbol || k.i !== CANDLE_HISTORY.interval
            || typeof k.x !== 'boolean' || !time(k.t) || !time(k.T) || k.t % CANDLE_HISTORY.intervalMs
            || k.T + 1 !== k.t + CANDLE_HISTORY.intervalMs || k.t > at
            || k.x && (k.T + 1 > at || k.T > message.E)) fail('message_invalid');
        const row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T, k.q, k.n];
        const bar = parsedBar(row, Math.max(at, k.T + 1));
        const currentEnd = expectedEnd(at);
        if (k.x ? bar.closeAt !== currentEnd : bar.openAt !== currentEnd) fail('message_stale');
        this.lastMessageAt = at;
        this.merge(k.x ? [{ ...bar, observedAt: at }] : [], at);
        if (!this.context({ snapshotAt: at, now: at }).ready) this.scheduleRest();
        return true;
    }
    heartbeat() {
        if (!this.running || this.heartbeatTimer !== null) return;
        this.heartbeatTimer = this.setTimer(() => {
            this.heartbeatTimer = null;
            if (!this.running) return;
            if (this.lastMessageAt !== null && this.now() - this.lastMessageAt > this.maxAgeMs && this.socket) {
                const socket = this.socket;
                try { socket.terminate?.(); socket.close?.(); } catch {}
                if (this.socket === socket) socket.emit?.('close');
            }
            if (!this.context().ready || !this.connected) this.scheduleRest();
            this.emit('candle_history_heartbeat', this.status());
            this.heartbeat();
        }, this.heartbeatMs);
    }
}
