import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';

// Offline causal counterexamples: every transport callback and clock is local.
class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.terminated = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    send() {}
    frame(row) { this.emit('message', JSON.stringify(row)); }
    terminate() { this.terminated++; this.readyState = 3; this.emit('close'); }
}
const level = (price, size) => ({ price: String(price), size: String(size) });
function fixture({ transport = false } = {}) {
    let now = 1000000;
    const events = [], sockets = [], timers = new Map();
    let timerId = 0;
    const stream = new LiveBookHistory({ clock: () => now,
        onEvent: (type, detail) => events.push({ type, detail }),
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
        scheduleInterval: fn => { timers.set(++timerId, fn); return timerId; },
        cancelInterval: id => timers.delete(id) });
    if (transport) { stream.watch(['up', 'down'], { conditionId: 'condition' }); sockets[0].open(); }
    else stream.tokens = ['up', 'down'];
    const f = { stream, events, sockets, timers, get now() { return now; },
        advance(ms) { now += ms; },
        book(token = 'up', changes = {}) { return { event_type: 'book', asset_id: token, market: 'condition',
            timestamp: now, tick_size: '.01', bids: [level(.76, 10)], asks: [level(.78, 10)], ...changes }; },
        delta(at, assignments, changes = {}) { return { event_type: 'price_change', market: 'condition', timestamp: at,
            price_changes: assignments.map(([asset_id, side, price, size]) => ({ asset_id, side,
                price: String(price), size: String(size) })), ...changes }; },
        ingest(row) { if (transport) return sockets.at(-1).frame(row); return stream.ingest(row, now); },
        pair(changes = {}) { for (const token of stream.tokens) f.ingest(f.book(token, changes)); },
        warm() { f.pair(); for (let i = 0; i < 180; i++) { f.advance(1000); f.pair(); } },
        snapshot() { return stream.snapshot(now, false); },
        up() { return f.snapshot()?.[0]; }
    };
    return f;
}
const sizes = (book, side) => Object.fromEntries(book[side].map(({ price, size }) => [price, size]));
const freshness = f => ({ generation: f.stream.generation, lastAt: f.stream.lastAt,
    readyAt: f.stream.readyAt, history: f.stream.history.length,
    books: f.snapshot().map(book => [book.timestamp, book.fetchedAt]) });
const gap = f => f.events.find(event => event.type === 'book_gap');

test('late complete snapshot removes untouched depth while preserving newer additions and removal tombstones', () => {
    const f = fixture();
    f.pair({ asks: [level(.78, 10), level(.79, 20), level(.8, 30)] });
    const base = f.now, generation = f.stream.generation;
    f.advance(20);
    f.ingest(f.delta(f.now, [['up', 'SELL', .78, 0], ['up', 'SELL', .81, 40], ['up', 'BUY', .75, 50]]));
    const before = freshness(f);
    f.advance(1500);
    f.ingest(f.book('up', { timestamp: base + 10, asks: [level(.78, 100), level(.8, 35)], bids: [level(.76, 11)] }));
    assert.ok(f.up(), 'a causally provable late full snapshot must keep the stream usable');
    assert.deepEqual(sizes(f.up(), 'asks'), { '0.8': 35, '0.81': 40 });
    assert.deepEqual(sizes(f.up(), 'bids'), { '0.76': 11, '0.75': 50 });
    assert.deepEqual(freshness(f), before, 'rebasing depth must not renew source, receive, history or warmup clocks');
    assert.equal(f.stream.generation, generation); assert.equal(gap(f), undefined);
});

test('a late full cut accepts matching equal-time assignments and rejects conflicting presence or size', () => {
    for (const [assigned, snapshotted, compatible] of [[20, 20, true], [0, null, true],
        [20, 21, false], [20, null, false], [0, 20, false]]) {
        const f = fixture(); f.pair(); const base = f.now;
        f.advance(10); f.ingest(f.delta(f.now, [['up', 'SELL', .79, assigned]]));
        f.advance(10); f.ingest(f.delta(f.now, [['up', 'SELL', .8, 30]]));
        const before = freshness(f); f.advance(100);
        f.ingest(f.book('up', { timestamp: base + 10,
            asks: [level(.78, 10), ...(snapshotted === null ? [] : [level(.79, snapshotted)])] }));
        if (compatible) {
            assert.ok(f.up()); assert.equal(sizes(f.up(), 'asks')['0.8'], 30);
            assert.equal(sizes(f.up(), 'asks')['0.79'], assigned || undefined);
            assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
        } else {
            assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, before.generation + 1);
            assert.equal(f.stream.readyAt, null); assert.ok(gap(f));
        }
    }
});

test('uncovered older delta updates a different level but cannot overwrite a newer same-level assignment', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20], ['up', 'SELL', .8, 0]]));
    const before = freshness(f);
    f.advance(1000);
    f.ingest(f.delta(base + 10, [['up', 'SELL', .78, 0], ['up', 'SELL', .79, 999], ['up', 'SELL', .8, 999]]));
    assert.ok(f.up()); assert.deepEqual(sizes(f.up(), 'asks'), { '0.79': 20 });
    assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('a mixed-token batch advances only the token whose source timestamp moves forward', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20]]));
    const up = f.up(); f.advance(1000);
    f.ingest(f.delta(base + 10, [['up', 'SELL', .8, 30], ['down', 'BUY', .75, 40]]));
    const books = f.snapshot(); assert.ok(books);
    assert.deepEqual([books[0].timestamp, books[0].fetchedAt], [up.timestamp, up.fetchedAt]);
    assert.deepEqual([books[1].timestamp, books[1].fetchedAt], [base + 10, f.now]);
    assert.equal(sizes(books[0], 'asks')['0.8'], 30); assert.equal(sizes(books[1], 'bids')['0.75'], 40);
    assert.equal(gap(f), undefined);
});

test('newer complete snapshot covers omissions so an older delta cannot resurrect deleted levels', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(10); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20], ['up', 'BUY', .75, 30]]));
    f.advance(20); f.pair({ asks: [level(.8, 40)], bids: [level(.77, 50)] });
    const before = freshness(f), expected = f.snapshot();
    f.advance(1000);
    f.ingest(f.delta(base + 20, [['up', 'SELL', .79, 900], ['up', 'SELL', .78, 800], ['up', 'BUY', .75, 700]]));
    assert.deepEqual(f.snapshot(), expected); assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('an older full snapshot covered by a newer complete snapshot cannot roll back its omissions', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(30); f.pair({ asks: [], bids: [level(.77, 50)] });
    const before = freshness(f), expected = f.snapshot();
    f.advance(1000); f.ingest(f.book('up', { timestamp: base + 20, asks: [level(.78, 999)] }));
    assert.deepEqual(f.snapshot(), expected); assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('a late full snapshot with unchanged depth still advances its causal cut against older unseen deltas', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20]]));
    const before = freshness(f); f.advance(100);
    // This happens to match the current merged depth, but proves all levels at T10.
    f.ingest(f.book('up', { timestamp: base + 10, asks: [level(.78, 10), level(.79, 20)] }));
    f.advance(100); f.ingest(f.delta(base + 5, [['up', 'SELL', .78, 0], ['up', 'BUY', .75, 99]]));
    assert.ok(f.up()); assert.deepEqual(sizes(f.up(), 'asks'), { '0.78': 10, '0.79': 20 });
    assert.deepEqual(sizes(f.up(), 'bids'), { '0.76': 10 });
    assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('a late same-value assignment still records its version against an even older unseen assignment', () => {
    const f = fixture(); f.pair(); const base = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20]]));
    const before = freshness(f); f.advance(100);
    f.ingest(f.delta(base + 10, [['up', 'SELL', .78, 10], ['up', 'BUY', .75, 0]]));
    f.advance(100); f.ingest(f.delta(base + 5, [['up', 'SELL', .78, 0], ['up', 'BUY', .75, 99]]));
    assert.ok(f.up()); assert.deepEqual(sizes(f.up(), 'asks'), { '0.78': 10, '0.79': 20 });
    assert.deepEqual(sizes(f.up(), 'bids'), { '0.76': 10 });
    assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('independent same-timestamp levels apply while exact assignment replays do not refresh clocks', () => {
    const f = fixture(); f.pair(); f.advance(10); const at = f.now;
    const first = f.delta(at, [['up', 'SELL', .79, 20]]);
    f.ingest(first);
    f.advance(1000); f.ingest(f.delta(at, [['up', 'SELL', .8, 30], ['up', 'BUY', .75, 40]]));
    assert.ok(f.up()); assert.deepEqual(sizes(f.up(), 'asks'), { '0.78': 10, '0.79': 20, '0.8': 30 });
    const before = freshness(f);
    f.advance(1000); f.ingest(first);
    assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('ordered current same-millisecond assignments retain websocket receive order', () => {
    const f = fixture(); f.pair(); f.advance(10); const at = f.now, generation = f.stream.generation;
    f.ingest(f.delta(at, [['up', 'SELL', .79, 20]]));
    f.ingest(f.delta(at, [['up', 'SELL', .79, 0]]));
    f.ingest(f.delta(at, [['up', 'SELL', .79, 20]]));
    assert.ok(f.up()); assert.equal(sizes(f.up(), 'asks')['0.79'], 20);
    assert.equal(f.stream.generation, generation); assert.equal(gap(f), undefined);
});

test('an exact replay at the current source timestamp cannot renew receive age or history', () => {
    const f = fixture(); f.pair(); f.advance(10);
    const row = f.delta(f.now, [['up', 'SELL', .79, 20]]); f.ingest(row);
    const before = freshness(f); f.advance(1500); f.ingest(row);
    assert.deepEqual(freshness(f), before); assert.equal(gap(f), undefined);
});

test('late conflicting same-level equal-timestamp assignments reset including zero-size conflicts', () => {
    for (const [first, second] of [[20, 21], [0, 20], [20, 0]]) {
        const f = fixture(); f.pair(); f.advance(10); const at = f.now;
        f.ingest(f.delta(at, [['up', 'SELL', .79, first]]));
        f.advance(10); f.ingest(f.delta(f.now, [['up', 'SELL', .81, 50]]));
        const generation = f.stream.generation;
        f.advance(100); f.ingest(f.delta(at, [['up', 'SELL', .79, second]]));
        assert.equal(f.stream.books.size, 0); assert.equal(f.stream.readyAt, null);
        assert.equal(f.stream.generation, generation + 1); assert.ok(gap(f));
    }
});

test('a cached payload cannot hide a late equal-time conflict after an intervening same-key mutation', () => {
    const f = fixture(); f.pair(); f.advance(10); const at = f.now;
    const first = f.delta(at, [['up', 'SELL', .79, 20]]);
    f.ingest(first); f.ingest(f.delta(at, [['up', 'SELL', .79, 0]]));
    f.advance(10); f.ingest(f.delta(f.now, [['up', 'SELL', .8, 30]]));
    const generation = f.stream.generation; f.advance(100); f.ingest(first);
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
    assert.equal(f.stream.readyAt, null); assert.ok(gap(f));
});

test('conflicting complete snapshots at the same timestamp require a reset', () => {
    const f = fixture(); f.pair(); const at = f.now, generation = f.stream.generation;
    f.advance(100); f.ingest(f.book('up', { timestamp: at, asks: [level(.78, 11)] }));
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1); assert.ok(gap(f));
});

test('a repeated full timestamp must match its stored complete cut even when it matches newer merged depth', () => {
    const f = fixture(); f.pair(); const at = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .78, 20]]));
    const generation = f.stream.generation; f.advance(100);
    f.ingest(f.book('up', { timestamp: at, asks: [level(.78, 20)] }));
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
    assert.equal(f.stream.readyAt, null); assert.ok(gap(f));
});

test('late or covered mutations still validate identity, tick and malformed assignments before being ignored', () => {
    const mutations = [
        (f, at) => f.book('up', { timestamp: at, market: 'different-condition' }),
        (f, at) => f.book('up', { timestamp: at, tick_size: '.001' }),
        (f, at) => f.book('up', { timestamp: at, asks: [level(.781, 10)] }),
        (f, at) => f.book('up', { timestamp: at, bids: null }),
        (f, at) => f.delta(at, [['up', 'INVALID', .78, 0]]),
        (f, at) => f.delta(at, [['up', 'SELL', .781, 0]]),
        (f, at) => f.delta(at, [['up', 'SELL', .78, 0]], { market: 'different-condition' }),
        (f, at) => f.delta(at, [['up', 'SELL', .78, 0], ['foreign', 'SELL', .8, 10]])
    ];
    for (const mutate of mutations) {
        const f = fixture(); f.pair(); const at = f.now;
        f.advance(20); f.pair(); const generation = f.stream.generation;
        f.advance(100); f.ingest(mutate(f, at));
        assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
        assert.equal(f.stream.readyAt, null);
    }
});

test('covered replay traffic cannot postpone a genuine per-token gap or manufacture a warm stream', () => {
    const f = fixture(); f.pair(); const old = f.book(), generation = f.stream.generation;
    for (let i = 0; i < 5; i++) {
        f.advance(1000); f.ingest(old); f.ingest(f.book('down'));
        assert.equal(f.stream.books.get('up')?.receivedAt, old.timestamp);
        assert.equal(f.stream.snapshot(f.now), null);
    }
    f.advance(1); f.ingest(f.book('down'));
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
    assert.equal(f.stream.readyAt, null); assert.ok(gap(f));
});

test('a real gap after reordered quotes discards continuity and needs 180 new seconds', () => {
    const f = fixture(); f.warm(); const base = f.now;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .79, 20]]));
    f.advance(100); f.ingest(f.book('up', { timestamp: base + 10, asks: [level(.78, 11)] }));
    assert.ok(f.stream.snapshot(f.now)); const generation = f.stream.generation;
    f.advance(5001); f.ingest(f.book('up'));
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.stream.readyAt, null);
    f.pair();
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(); }
    assert.equal(f.stream.snapshot(f.now), null);
    f.advance(1000); f.pair(); assert.ok(f.stream.snapshot(f.now));
});

test('source epoch reset clears level versions and old callbacks cannot restore their tombstones', () => {
    const f = fixture({ transport: true }); f.pair(); const oldSocket = f.sockets[0], oldEpoch = f.stream.sourceEpoch;
    f.advance(20); f.ingest(f.delta(f.now, [['up', 'SELL', .78, 0]]));
    oldSocket.emit('error', new Error('offline fixture disconnect'));
    assert.equal(f.stream.books.size, 0); f.advance(1000);
    assert.equal(f.stream.watch(['up', 'down'], { conditionId: 'condition' }), true); f.sockets.at(-1).open();
    f.pair({ asks: [level(.78, 70)] }); const before = freshness(f);
    const late = f.delta(f.now, [['up', 'SELL', .78, 0]]);
    oldSocket.frame(late); f.stream.ingest(late, f.now, oldEpoch);
    assert.deepEqual(sizes(f.up(), 'asks'), { '0.78': 70 }); assert.deepEqual(freshness(f), before);
    assert.equal(f.stream.snapshot(f.now), null, 'a new epoch starts cold');
});

test('uncovered pre-transition quotes cannot bypass the verified tick watermark', () => {
    for (const kind of ['book', 'delta']) {
        const f = fixture(); f.pair(); const at = f.now + 10;
        f.advance(20); f.ingest({ event_type: 'tick_size_change', asset_id: 'up', market: 'condition',
            timestamp: f.now, old_tick_size: '.01', new_tick_size: '.001' });
        const generation = f.stream.generation;
        f.advance(20); f.ingest(kind === 'book' ? f.book('up', { timestamp: at, tick_size: undefined })
            : f.delta(at, [['up', 'SELL', .78, 0]]));
        assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
        assert.equal(f.stream.readyAt, null);
    }
});
