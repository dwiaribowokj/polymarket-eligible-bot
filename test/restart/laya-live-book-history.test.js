import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { metadataIdentity, validatedStreamBooks, verifyStreamSnapshot } from '../../src/ai-shadow/engine.js';

class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; this.terminated = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    send(value) { this.sent.push(value); }
    frame(value) { this.emit('message', typeof value === 'string' ? value : JSON.stringify(value)); }
    terminate() { this.terminated++; this.readyState = 3; this.emit('close'); this.emit('error', new Error('late error')); }
}
function fixture({ network = false, start = 1000000, conditionId } = {}) {
    let now = start, nextTimer = 0;
    const events = [], sockets = [], timers = new Map();
    const stream = new LiveBookHistory({ clock: () => now, onEvent: (type, detail) => events.push({ type, detail }),
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
        scheduleInterval: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
        cancelInterval: id => timers.delete(id) });
    if (network) { stream.watch(['up', 'down'], conditionId ? { conditionId } : undefined); sockets[0].open(); }
    else stream.tokens = ['up', 'down'];
    const f = { stream, events, sockets, timers, get now() { return now; }, advance(ms) { now += ms; },
        book(token = 'up', overrides = {}) { return { event_type: 'book', asset_id: token, market: 'condition',
            timestamp: now, tick_size: '.01', bids: [{ price: '.77', size: '10' }], asks: [{ price: '.78', size: '10' }], ...overrides }; },
        tick(token = 'up', overrides = {}) { return { event_type: 'tick_size_change', asset_id: token, market: 'condition',
            timestamp: now, old_tick_size: '.01', new_tick_size: '.001', ...overrides }; },
        ingest(row) { return network ? sockets.at(-1).frame(row) : stream.ingest(row, now); },
        pair(overrides = {}) { for (const token of stream.tokens) f.ingest(f.book(token, overrides)); },
        pulse() { for (const fn of [...timers.values()]) fn(); },
        warm() { f.pair(); for (let i = 0; i < 180; i++) { f.advance(1000); f.pair(); } }
    };
    return f;
}

test('live books require 180 continuous valid seconds, including a zero local timestamp', () => {
    const f = fixture({ start: 0 }); f.pair();
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(); }
    assert.equal(f.stream.snapshot(f.now), null);
    f.advance(1000); f.pair();
    assert.equal(f.stream.readyAt, 0); assert.equal(f.stream.snapshot(f.now).length, 2);
    assert.equal(f.stream.history.length, 181);
});

test('validated tick changes on both tokens preserve only continuous warm books and invalidate old execution proof', async () => {
    const f = fixture(); f.warm();
    const market = { conditionId: 'condition', tokens: ['up', 'down'], minimum: 5, ticks: [.001, .001], fee: {} };
    const validation = { at: f.now, generation: f.stream.generation, identity: metadataIdentity(market) };
    const generation = f.stream.generation, readyAt = f.stream.readyAt, history = f.stream.history.length;
    const before = f.stream.snapshot(f.now);
    f.advance(100); f.ingest(f.tick('up')); f.ingest(f.tick('down'));
    const after = f.stream.snapshot(f.now);
    assert.equal(f.stream.generation, generation + 2);
    assert.equal(f.stream.readyAt, readyAt); assert.equal(f.stream.history.length, history);
    assert.equal(f.stream.lastAt, before[0].fetchedAt);
    assert.deepEqual(after.map(b => [b.timestamp, b.fetchedAt]), before.map(b => [b.timestamp, b.fetchedAt]));
    assert.deepEqual(after.map(b => b.tick), [.001, .001]);
    assert.throws(() => validatedStreamBooks(f.stream, market, validation, f.now), /execution_metadata_changed_or_expired/);
    validation.generation = f.stream.generation;
    assert.equal(validatedStreamBooks(f.stream, market, validation, f.now).length, 2);
    // A different CLOB grid still requires an independent endpoint proof.
    market.ticks = [.0001, .0001]; validation.identity = metadataIdentity(market);
    assert.throws(() => validatedStreamBooks(f.stream, market, validation, f.now), /execution_tick_mismatch/);
    const calls = [], client = { tickSize: async token => { calls.push(token); return .0001; } };
    assert.equal((await verifyStreamSnapshot(client, f.stream, market, validation, () => f.now)).length, 2);
    assert.deepEqual(calls, ['up', 'down']);
    const tickEvents = f.events.filter(e => e.type === 'book_tick_changed');
    assert.equal(tickEvents.length, 2); assert.ok(tickEvents.every(e => e.detail.continuityPreserved));
});

test('duplicate tick messages neither repeat invalidation nor refresh quote timestamps', () => {
    const f = fixture(); f.warm(); f.advance(100);
    const row = f.tick(); f.ingest(row);
    const generation = f.stream.generation, readyAt = f.stream.readyAt, lastAt = f.stream.lastAt;
    f.advance(100); f.ingest(row); f.ingest({ ...row, timestamp: f.now });
    assert.equal(f.stream.generation, generation); assert.equal(f.stream.readyAt, readyAt); assert.equal(f.stream.lastAt, lastAt);
    assert.equal(f.events.filter(e => e.type === 'book_tick_changed').length, 1);
    f.advance(4901); assert.equal(f.stream.snapshot(f.now), null);
});

test('tick enlargement needs all retained levels on the new grid and cannot invent a resnapshot', () => {
    for (const legal of [true, false]) {
        const f = fixture({ network: true }); f.warm();
        f.advance(1000); f.pair({ tick_size: '.01', ...(legal ? {} : { bids: [{ price: '.77', size: '10' }] }) });
        const socket = f.sockets[0], generation = f.stream.generation;
        // .01 to .1 cannot retain .77/.78; legal .1 grid uses .7/.8.
        if (legal) { f.advance(100); f.pair({ bids: [{ price: '.7', size: '10' }], asks: [{ price: '.8', size: '10' }] }); }
        f.ingest(f.tick('up', { new_tick_size: '.1' }));
        assert.equal(f.stream.generation, generation + 1);
        if (legal) { assert.ok(f.stream.snapshot(f.now)); assert.equal(socket.terminated, 0); }
        else { assert.equal(f.stream.snapshot(f.now, false), null); assert.equal(socket.terminated, 1); assert.equal(f.stream.readyAt, null); }
    }
});

test('an omitted initial stream tick needs CLOB verification and an unknown old tick cannot preserve continuity', async () => {
    const f = fixture(); f.pair({ tick_size: undefined });
    for (let i = 0; i < 180; i++) { f.advance(1000); f.pair({ tick_size: undefined }); }
    const market = { conditionId: 'condition', tokens: ['up', 'down'], minimum: 5, ticks: [.01, .01], fee: {} };
    const validation = { at: f.now, generation: f.stream.generation, identity: metadataIdentity(market) };
    assert.throws(() => validatedStreamBooks(f.stream, market, validation, f.now), /execution_tick_mismatch/);
    assert.equal((await verifyStreamSnapshot({ tickSize: async () => .01 }, f.stream, market, validation, () => f.now)).length, 2);
    f.ingest(f.tick()); assert.equal(f.stream.readyAt, null); assert.equal(f.stream.snapshot(f.now, false), null);
    assert.equal(f.events.find(e => e.type === 'book_tick_changed').detail.reason, 'old_tick_unproven');
});

test('a real per-token quote gap discards warmup once and requires a fresh 180 seconds', () => {
    const f = fixture(); f.warm(); const generation = f.stream.generation;
    f.advance(5001); f.ingest(f.book());
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.stream.readyAt, null);
    assert.equal(f.stream.snapshot(f.now, false), null);
    f.pair();
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(); }
    assert.equal(f.stream.snapshot(f.now), null); f.advance(1000); f.pair(); assert.ok(f.stream.snapshot(f.now));
    assert.equal(f.events.filter(e => e.type === 'book_gap').length, 1);
});

test('one active token cannot conceal the other token becoming stale', () => {
    const f = fixture(); f.warm();
    for (let i = 0; i < 5; i++) { f.advance(1000); f.ingest(f.book()); }
    assert.ok(f.stream.snapshot(f.now)); f.advance(1); f.ingest(f.book());
    assert.equal(f.stream.readyAt, null); assert.equal(f.stream.books.size, 0);
});

test('unknown-token and quote-free malformed envelopes cannot alter books or freshness', () => {
    const f = fixture(); f.warm(); const before = f.stream.snapshot(f.now), generation = f.stream.generation;
    const lastAt = f.stream.lastAt, readyAt = f.stream.readyAt;
    f.advance(100);
    const rows = [null, [], f.book('foreign'), f.tick('foreign'),
        { event_type: 'price_change', price_changes: [{ asset_id: 'foreign', side: 'INVALID' }] }];
    for (const row of rows) f.ingest(row);
    assert.deepEqual(f.stream.snapshot(f.now), before);
    assert.equal(f.stream.generation, generation); assert.equal(f.stream.lastAt, lastAt); assert.equal(f.stream.readyAt, readyAt);
});

test('malformed, future and ambiguous tick mutations invalidate retained history', () => {
    const mutations = [f => f.book('up', { timestamp: f.now + 1 }),
        f => f.book('up', { bids: [{ price: '.771', size: '10' }] }),
        f => f.book('up', { tick_size: true }), f => f.book('up', { tick_size: '0.0100000000000000001' }),
        f => f.book('up', { bids: [{ price: '.77', size: '' }] }), f => f.book('up', { asks: null }),
        f => f.book('up', { bids: [{ price: '.77', size: '10' }, { price: '.77', size: '20' }] }),
        f => f.book('up', { bids: [{ price: '.77', size: '10' }, { price: '.7700000000000001', size: '20' }] }),
        f => f.book('up', { bids: [{ price: '0.00000000000000000001', size: '10' }] }),
        f => f.book('up', { asks: [{ price: '0.9999999999999999', size: '10' }] }),
        f => f.tick('up', { old_tick_size: '.1' }), f => f.tick('up', { new_tick_size: '.005' }),
        f => f.tick('up', { new_tick_size: null }), f => f.tick('up', { timestamp: f.now - 101 }),
        f => ({ event_type: 'price_change', price_changes: {} })];
    for (const mutate of mutations) {
        const f = fixture({ network: true }); f.warm(); const generation = f.stream.generation; f.advance(100);
        f.ingest(mutate(f));
        assert.equal(f.stream.books.size, 0); assert.equal(f.stream.lastAt, null); assert.equal(f.stream.readyAt, null);
        assert.equal(f.stream.generation, generation + 1); assert.equal(f.sockets[0].terminated, 1);
        assert.equal(f.stream.snapshot(f.now, false), null);
    }
});

test('a malformed batched delta discards retained asks and later deltas cannot revive them', () => {
    const f = fixture({ network: true }); f.warm(); const generation = f.stream.generation;
    f.advance(1000); f.ingest({ event_type: 'price_change', market: 'condition', timestamp: f.now,
        price_changes: [{ asset_id: 'up', side: 'SELL', price: '.78', size: '0' },
            { asset_id: 'down', side: 'INVALID', price: '.78', size: '10' }] });
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.lastAt, null);
    assert.equal(f.stream.generation, generation + 1);
    f.ingest({ event_type: 'price_change', market: 'condition', timestamp: f.now,
        price_changes: [{ asset_id: 'up', side: 'BUY', price: '.77', size: '11' }] });
    assert.equal(f.stream.snapshot(f.now, false), null); assert.equal(f.stream.books.size, 0);
    f.advance(1000); f.stream.watch(['up', 'down']); f.sockets.at(-1).open();
    f.pair({ asks: [] }); assert.equal(f.stream.snapshot(f.now), null);
    for (let i = 0; i < 180; i++) { f.advance(1000); f.pair({ asks: [] }); }
    assert.deepEqual(f.stream.snapshot(f.now)[0].asks, []);
});

test('a mixed known and unknown delta invalidates rather than partially renewing tracked quotes', () => {
    const f = fixture(); f.warm(); f.advance(1000);
    f.ingest({ event_type: 'price_change', market: 'condition', timestamp: f.now,
        price_changes: [{ asset_id: 'up', side: 'BUY', price: '.77', size: '99' },
            { asset_id: 'foreign', side: 'BROKEN', price: 'invalid', size: 'invalid' }] });
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.lastAt, null);
});

test('a tick watermark faults ambiguous earlier quotes and invalid new-grid deltas', () => {
    for (const kind of ['book', 'old_delta', 'off_grid_delta']) {
        const f = fixture(); f.warm(); f.advance(100); f.ingest(f.tick()); const generation = f.stream.generation;
        f.ingest(kind === 'book' ? f.book('up', { timestamp: f.now - 1 })
            : { event_type: 'price_change', market: 'condition', timestamp: f.now - (kind === 'old_delta' ? 1 : 0),
                price_changes: [{ asset_id: 'up', side: 'BUY', price: kind === 'old_delta' ? '.771' : '.7711', size: '99' }] });
        assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation + 1);
    }
    const f = fixture(); f.warm(); f.advance(100); f.ingest(f.tick());
    f.ingest(f.book('up', { tick_size: undefined, bids: [{ price: '.771', size: '10' }] }));
    assert.equal(f.stream.snapshot(f.now)[0].tick, .001);
});

test('a proven duplicate tick arriving after newer quotes cannot reset or refresh them', () => {
    const f = fixture(); f.warm(); f.advance(100); const tick = f.tick(); f.ingest(tick);
    f.advance(1000); f.pair({ tick_size: undefined });
    const before = f.stream.snapshot(f.now), generation = f.stream.generation, readyAt = f.stream.readyAt, lastAt = f.stream.lastAt;
    f.advance(100); f.ingest(tick);
    assert.deepEqual(f.stream.snapshot(f.now), before); assert.equal(f.stream.generation, generation);
    assert.equal(f.stream.readyAt, readyAt); assert.equal(f.stream.lastAt, lastAt);
});

test('unexpected conditions invalidate once and an explicitly pinned condition cannot be replaced', () => {
    const f = fixture({ network: true, conditionId: 'condition' }); f.pair();
    const socket = f.sockets[0], generation = f.stream.generation;
    f.ingest(f.book('up', { market: 'other-condition' }));
    socket.frame(f.book('down', { market: 'other-condition' })); socket.emit('close');
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.stream.books.size, 0);
    assert.equal(f.stream.conditionId, 'condition'); assert.equal(socket.terminated, 1);
    assert.equal(f.events.filter(e => e.type === 'book_identity_changed').length, 1);
});

test('superseded sockets and late callbacks cannot overwrite books, ticks or the active timer', () => {
    const f = fixture({ network: true }); f.pair(); const old = f.sockets[0], oldEpoch = f.stream.sourceEpoch;
    const oldPulse = [...f.timers.values()][0];
    f.stream.watch(['new-up', 'new-down'], { conditionId: 'new-condition' }); f.sockets[1].open();
    const generation = f.stream.generation;
    old.frame(f.book('new-up', { market: 'new-condition' })); old.emit('open'); old.emit('close'); oldPulse();
    f.stream.ingest(f.book('new-up', { market: 'new-condition' }), f.now, oldEpoch);
    assert.equal(f.stream.books.size, 0); assert.equal(f.stream.generation, generation); assert.equal(f.timers.size, 1);
    for (const token of f.stream.tokens) f.ingest(f.book(token, { market: 'new-condition' }));
    assert.ok(f.stream.snapshot(f.now, false));
});

test('PONG and quote-free control messages never renew quotes or postpone a true gap', () => {
    const f = fixture({ network: true }); f.warm(); const lastAt = f.stream.lastAt, socket = f.sockets[0];
    for (let i = 0; i < 5; i++) {
        f.advance(1000); socket.frame('PONG');
        socket.frame({ event_type: 'last_trade_price', asset_id: 'up', market: 'condition', timestamp: f.now, price: '.78' });
        socket.frame({ event_type: 'best_bid_ask', asset_id: 'up', market: 'condition', timestamp: f.now }); f.pulse();
    }
    assert.equal(socket.terminated, 0); assert.equal(f.stream.lastAt, lastAt);
    f.advance(1); socket.frame('PONG'); f.pulse();
    assert.equal(socket.terminated, 1); assert.equal(f.stream.readyAt, null);
    assert.equal(f.events.filter(e => e.type === 'book_gap').length, 1);
});

test('a missing initial companion book triggers reconnect despite active quotes on one token', () => {
    const f = fixture({ network: true }); f.ingest(f.book());
    f.sockets[0].emit('open'); assert.equal(f.timers.size, 1);
    for (let i = 0; i < 5; i++) { f.advance(1000); f.ingest(f.book()); f.pulse(); }
    assert.equal(f.sockets[0].terminated, 0);
    f.advance(1); f.ingest(f.book()); f.pulse();
    assert.equal(f.sockets[0].terminated, 1); assert.equal(f.stream.readyAt, null); assert.equal(f.stream.books.size, 0);
});

test('status reports genuine per-token ages and warmup without changing collector state', () => {
    const f = fixture({ network: true }); f.pair(); f.advance(1000); f.pair(); f.advance(100);
    const generation = f.stream.generation, lastAt = f.stream.lastAt;
    const status = f.stream.status(f.now);
    assert.equal(status.connected, true); assert.equal(status.ready, false); assert.equal(status.warming, true);
    assert.equal(status.warmupMs, 1100); assert.equal(status.remainingWarmupMs, 178900);
    assert.deepEqual(status.tokens.map(token => [token.sourceAgeMs, token.receiveAgeMs]), [[100, 100], [100, 100]]);
    f.advance(5001); const stale = f.stream.status(f.now);
    assert.equal(stale.ready, false); assert.equal(stale.warmupMs, 0);
    assert.equal(f.stream.generation, generation); assert.equal(f.stream.lastAt, lastAt);
    f.stream.close(); assert.equal(f.stream.status(f.now).connected, false);
});

test('parse/error/close invalidations coalesce and reconnect polling uses bounded backoff', () => {
    const f = fixture({ network: true }); f.pair(); const first = f.sockets[0], generation = f.stream.generation;
    first.frame('{broken'); first.emit('error', new Error('late')); first.emit('close');
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.events.filter(e => e.type === 'book_gap').length, 1);
    assert.equal(f.timers.size, 0);
    for (let i = 0; i < 10; i++) { f.advance(99); assert.equal(f.stream.watch(['up', 'down']), false); }
    f.advance(10); assert.equal(f.stream.watch(['up', 'down']), true);
    for (let i = 0; i < 8; i++) {
        const socket = f.sockets.at(-1); socket.emit('error', new Error('offline'));
        const delay = f.stream.reconnectAt - f.now;
        assert.equal(delay, Math.min(30000, 1000 * 2 ** (i + 1)));
        f.advance(delay - 1); assert.equal(f.stream.watch(['up', 'down']), false);
        f.advance(1); assert.equal(f.stream.watch(['up', 'down']), true);
    }
    f.stream.close();
});

test('intentional close emits no extra gap/reset and a later watch starts cold', () => {
    const f = fixture({ network: true }); f.warm(); const generation = f.stream.generation, events = f.events.length;
    f.stream.close(); f.stream.close();
    assert.equal(f.stream.generation, generation); assert.equal(f.events.length, events); assert.equal(f.timers.size, 0);
    assert.equal(f.stream.snapshot(f.now), null);
    f.stream.watch(['up', 'down']); f.sockets.at(-1).open(); f.pair();
    assert.equal(f.stream.generation, generation + 1); assert.equal(f.stream.snapshot(f.now), null);
});
