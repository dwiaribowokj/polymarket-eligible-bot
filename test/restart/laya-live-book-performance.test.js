import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; this.terminated = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    send(value) { this.sent.push(value); }
    frame(value) { this.emit('message', typeof value === 'string' ? value : JSON.stringify(value)); }
    terminate() { this.terminated++; this.readyState = 3; this.emit('close', 1006, Buffer.from('retired')); }
}

function fixture({ network = false, start = 1000000 } = {}) {
    let now = start, nextTimer = 0;
    const events = [], sockets = [], timers = new Map();
    const stream = new LiveBookHistory({ clock: () => now, onEvent: (type, detail) => events.push({ type, detail }),
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
        scheduleInterval: (fn, interval) => {
            assert.equal(interval, 1000); const id = ++nextTimer; timers.set(id, fn); return id;
        }, cancelInterval: id => timers.delete(id) });
    if (network) { stream.watch(['up', 'down'], { conditionId: 'condition' }); sockets[0].open(); }
    else stream.tokens = ['up', 'down'];
    const f = { stream, events, sockets, timers, get now() { return now; }, advance(ms) { now += ms; },
        book(token = 'up', overrides = {}) { return { event_type: 'book', asset_id: token, market: 'condition',
            timestamp: now, tick_size: '.0001', bids: [{ price: '.4', size: '10' }],
            asks: [{ price: '.6', size: '10' }], ...overrides }; },
        ingest(row) { return network ? sockets.at(-1).frame(row) : stream.ingest(row, now); },
        pair(overrides = {}) { for (const token of stream.tokens) f.ingest(f.book(token, overrides)); },
        delta(size, token = 'up', overrides = {}) {
            return f.ingest({ event_type: 'price_change', market: 'condition', timestamp: now,
                price_changes: [{ asset_id: token, side: 'BUY', price: '.4', size: String(size) }], ...overrides });
        },
        pulse() { for (const fn of [...timers.values()]) fn(); },
        gap() { return events.find(event => event.type === 'book_gap')?.detail; }
    };
    return f;
}

test('a busy deep book materializes history only when a one-second sample is due, while execution sees every mutation', () => {
    const f = fixture({ start: 0 });
    const bids = Array.from({ length: 400 }, (_, i) => ({ price: (0.4 - i / 10000).toFixed(4), size: '10' }));
    const asks = Array.from({ length: 400 }, (_, i) => ({ price: (0.6 + i / 10000).toFixed(4), size: '10' }));
    f.pair({ bids, asks });
    const snapshot = f.stream.snapshot.bind(f.stream);
    let materializations = 0;
    f.stream.snapshot = (...args) => { materializations++; return snapshot(...args); };
    for (let i = 1; i <= 999; i++) { f.advance(1); f.delta(i + 10); }
    assert.equal(materializations, 0, 'unsampled mutations must not sort or materialize the full books');
    assert.equal(f.stream.readyAt, 0); assert.equal(f.stream.lastAt, 999); assert.equal(f.stream.history.length, 1);
    assert.equal(f.stream.history[0].books[0].bids[0].size, 10, 'stored samples remain detached from mutable depth');
    const latest = f.stream.snapshot(f.now, false);
    assert.equal(latest[0].bids[0].size, 1009);
    assert.equal(latest[0].timestamp, 999); assert.equal(latest[0].fetchedAt, 999);
    assert.equal(latest[0].bids.length, 400); assert.equal(latest[0].asks.length, 400);
    assert.ok(latest[0].bids.every((level, i, rows) => i === 0 || rows[i - 1].price > level.price));
    assert.ok(latest[0].asks.every((level, i, rows) => i === 0 || rows[i - 1].price < level.price));
    f.advance(1); f.delta(1010);
    assert.equal(materializations, 2, 'one execution read plus one due history sample');
    assert.equal(f.stream.history.length, 2); assert.equal(f.stream.history[1].receivedAt, 1000);
    assert.equal(f.stream.history[1].books[0].bids[0].size, 1010);
    const lastAt = f.stream.lastAt;
    for (let i = 0; i < 100; i++) assert.equal(f.stream.status(f.now).warming, true);
    assert.equal(materializations, 2, 'status needs only completeness and freshness, not depth');
    assert.equal(f.stream.lastAt, lastAt);
});

test('sample gating preserves zero-time readiness, exact 180-second warmup and the history retention window', () => {
    const f = fixture({ start: 0 }); f.pair(); f.stream.failures = 3;
    for (let i = 1; i <= 179; i++) { f.advance(1000); f.pair(); }
    f.advance(999); f.delta(11);
    assert.equal(f.stream.snapshot(f.now), null); assert.equal(f.stream.failures, 3);
    assert.equal(f.stream.history.length, 180); assert.equal(f.stream.readyAt, 0);
    f.advance(1); f.delta(12);
    assert.ok(f.stream.snapshot(f.now)); assert.equal(f.stream.failures, 0);
    assert.equal(f.stream.history.length, 181);
    for (let i = 0; i < 10; i++) { f.advance(1000); f.pair(); }
    assert.equal(f.stream.history[0].receivedAt, 5000); assert.equal(f.stream.history.length, 186);
});

test('socket close diagnostics retain source and receive ages without emitting peer reason text', () => {
    const f = fixture({ network: true }), socket = f.sockets[0];
    f.ingest(f.book('up', { timestamp: f.now - 100 }));
    f.ingest(f.book('down', { timestamp: f.now - 200 }));
    const lastAt = f.stream.lastAt;
    f.advance(2500); socket.frame('PONG'); f.advance(1000);
    const before = f.stream.status(f.now);
    assert.equal(before.socketLifetimeMs, 3500); assert.equal(before.socketOpenAgeMs, 3500);
    assert.equal(before.lastFrameAgeMs, 1000); assert.equal(before.lastPongAgeMs, 1000);
    assert.equal(f.stream.lastAt, lastAt);
    socket.emit('close', 1001, Buffer.from('heartbeat timeout private-token=do-not-log'));
    const gap = f.gap();
    assert.equal(gap.reason, 'socket_closed'); assert.equal(gap.closeCode, 1001); assert.equal(gap.closeReasonClass, 'heartbeat');
    assert.equal(gap.socketLifetimeMs, 3500); assert.equal(gap.lastFrameAgeMs, 1000); assert.equal(gap.lastPongAgeMs, 1000);
    assert.equal(gap.pendingTimerDelayMs, 2500);
    assert.deepEqual(gap.quoteAges.map(book => [book.sourceAgeMs, book.receiveAgeMs]), [[3600, 3500], [3700, 3500]]);
    assert.equal(JSON.stringify(f.events).includes('private-token'), false);
    assert.equal(JSON.stringify(f.events).includes('do-not-log'), false);
    assert.equal(f.stream.readyAt, null); assert.equal(f.stream.history.length, 0);
    assert.equal(f.stream.reconnectAt - f.now, 1000); assert.equal(f.events.filter(event => event.type === 'book_gap').length, 1);
});

test('close code and reason diagnostics have fixed bounded output for arbitrary peer data', () => {
    const cases = [
        [1000, '', 1000, 'empty'], [1006, 'idle timeout credential=secret', 1006, 'timeout'],
        [1013, 'too many requests secret', 1013, 'rate_limit'], [1012, 'maintenance secret', 1012, 'server_restart'],
        [1002, 'protocol error secret', 1002, 'protocol'], [4001, 'unauthorized secret', 4001, 'authorization'],
        [4999, 'opaque secret', 4999, 'other'], [5000, 'x'.repeat(123) + 'heartbeat secret', null, 'other'],
        [999, 'opaque secret', null, 'other'], ['1001', 'opaque secret', null, 'other'],
        [NaN, null, null, 'empty'], [Infinity, { toString() { throw Error('must not coerce'); } }, null, 'empty']
    ];
    for (const [code, reason, expectedCode, expectedClass] of cases) {
        const f = fixture({ network: true });
        f.sockets[0].emit('close', code, reason);
        assert.equal(f.gap().closeCode, expectedCode); assert.equal(f.gap().closeReasonClass, expectedClass);
        assert.equal(JSON.stringify(f.events).includes('secret'), false);
    }
});

test('observed timer delay and PONG diagnostics cannot extend five-second quote freshness', () => {
    const f = fixture({ network: true }), socket = f.sockets[0]; f.pair();
    const lastAt = f.stream.lastAt, readyAt = f.stream.readyAt;
    f.advance(1000); f.pulse();
    assert.equal(f.stream.status(f.now).timerDelayMs, 0);
    f.advance(3500); f.pulse();
    const status = f.stream.status(f.now);
    assert.equal(status.timerDelayMs, 2500); assert.equal(status.maxTimerDelayMs, 2500);
    assert.equal(status.lastFrameAgeMs, 4500); assert.equal(status.lastPongAgeMs, null);
    assert.equal(socket.sent.filter(value => value === 'PING').length, 0);
    assert.equal(f.stream.lastAt, lastAt); assert.equal(f.stream.readyAt, readyAt);
    f.advance(1000); socket.frame('PONG'); f.pulse();
    const gap = f.gap();
    assert.equal(gap.reason, 'quote_timeout'); assert.equal(gap.lastPongAgeMs, 0); assert.equal(gap.lastFrameAgeMs, 0);
    assert.equal(gap.timerDelayMs, 0); assert.equal(gap.maxTimerDelayMs, 2500);
    assert.deepEqual(gap.quoteAges.map(book => [book.sourceAgeMs, book.receiveAgeMs]), [[5500, 5500], [5500, 5500]]);
    assert.equal(socket.sent.filter(value => value === 'PING').length, 0);
    assert.equal(f.stream.readyAt, null); assert.equal(f.stream.snapshot(f.now, false), null);
    f.advance(1000); f.stream.watch(['up', 'down']); f.sockets.at(-1).open(); f.pair();
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(); }
    assert.equal(f.stream.snapshot(f.now), null);
    f.advance(1000); f.pair(); assert.ok(f.stream.snapshot(f.now));
});

test('source-age timeout diagnostics remain distinct from a recently received quote and fresh protocol PONG', () => {
    const f = fixture({ network: true }), socket = f.sockets[0];
    f.pair({ timestamp: f.now - 4000 });
    f.advance(1001); socket.emit('pong', Buffer.from('private-pong-payload')); f.pulse();
    const gap = f.gap();
    assert.equal(gap.reason, 'quote_timeout'); assert.equal(gap.lastPongAgeMs, 0);
    assert.deepEqual(gap.quoteAges.map(book => [book.sourceAgeMs, book.receiveAgeMs]), [[5001, 1001], [5001, 1001]]);
    assert.equal(JSON.stringify(f.events).includes('private-pong-payload'), false);
    assert.equal(f.stream.lastAt, null); assert.equal(f.stream.readyAt, null);
});

test('retired socket frames and PONG events cannot contaminate the replacement source diagnostics', () => {
    const f = fixture({ network: true }), old = f.sockets[0]; f.pair();
    f.advance(100); f.stream.watch(['new-up', 'new-down'], { conditionId: 'new-condition' });
    const current = f.sockets.at(-1); current.open(); f.advance(100);
    old.frame('PONG'); old.emit('pong'); old.emit('ping'); old.emit('close', 4001, Buffer.from('secret'));
    const status = f.stream.status(f.now);
    assert.equal(status.socketLifetimeMs, 100); assert.equal(status.lastFrameAgeMs, null); assert.equal(status.lastPongAgeMs, null);
    assert.equal(f.gap(), undefined); assert.equal(f.stream.readyAt, null);
    current.emit('ping'); assert.equal(f.stream.status(f.now).lastFrameAgeMs, 0);
    current.emit('pong'); assert.equal(f.stream.status(f.now).lastPongAgeMs, 0);
    assert.equal(f.stream.lastAt, null);
});

test('documented ten-second PING cadence retains independent one-second freshness housekeeping', () => {
    const f = fixture({ network: true }), socket = f.sockets[0]; f.pair();
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); }
    f.advance(999); f.pair(); f.pulse();
    assert.equal(socket.sent.filter(value => value === 'PING').length, 0);
    f.advance(1); f.pair(); f.pulse();
    assert.equal(socket.sent.filter(value => value === 'PING').length, 1);
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); }
    assert.equal(socket.sent.filter(value => value === 'PING').length, 1);
    f.advance(1000); f.pair(); f.pulse();
    assert.equal(socket.sent.filter(value => value === 'PING').length, 2);
    const lastAt = f.stream.lastAt, readyAt = f.stream.readyAt;
    f.advance(100); socket.frame('PONG');
    assert.equal(f.stream.lastAt, lastAt); assert.equal(f.stream.readyAt, readyAt);
    assert.equal(f.stream.status(f.now).lastPongAgeMs, 0); assert.equal(f.gap(), undefined);
});

test('a delayed heartbeat sends one PING and schedules the next interval without a catch-up burst', () => {
    const f = fixture({ network: true }), socket = f.sockets[0]; f.pair();
    for (let i = 0; i < 19; i++) { f.advance(1000); f.pair(); }
    f.pulse(); f.pulse();
    assert.equal(socket.sent.filter(value => value === 'PING').length, 1);
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); }
    assert.equal(socket.sent.filter(value => value === 'PING').length, 1);
    f.advance(1000); f.pair(); f.pulse();
    assert.equal(socket.sent.filter(value => value === 'PING').length, 2);
    assert.equal(f.gap(), undefined);
});

test('a failed due PING still retires the source and resets history with the original reconnect backoff', () => {
    const f = fixture({ network: true }), socket = f.sockets[0]; f.pair();
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); }
    const generation = f.stream.generation;
    socket.send = value => { assert.equal(value, 'PING'); throw new Error('private-send-error'); };
    f.advance(1000); f.pair(); f.pulse();
    assert.equal(f.gap().reason, 'ping_failed'); assert.equal(socket.terminated, 1);
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.stream.readyAt, null);
    assert.equal(f.stream.history.length, 0); assert.equal(f.stream.reconnectAt - f.now, 1000);
    assert.equal(JSON.stringify(f.events).includes('private-send-error'), false);
});

test('a replacement source receives its own full heartbeat interval and retired timers cannot send PING', () => {
    const f = fixture({ network: true }), old = f.sockets[0]; f.pair();
    const oldPulse = [...f.timers.values()][0];
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); oldPulse(); }
    f.stream.watch(['new-up', 'new-down'], { conditionId: 'condition' });
    const current = f.sockets.at(-1); current.open(); f.pair();
    for (let i = 0; i < 9; i++) { f.advance(1000); f.pair(); f.pulse(); }
    assert.equal(old.sent.filter(value => value === 'PING').length, 0);
    assert.equal(current.sent.filter(value => value === 'PING').length, 0);
    f.advance(1000); f.pair(); f.pulse();
    assert.equal(current.sent.filter(value => value === 'PING').length, 1);
    assert.equal(old.sent.filter(value => value === 'PING').length, 0);
    assert.equal(f.gap(), undefined);
});
