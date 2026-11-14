import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../scripts/value-collector.js';
import { VALUE_SLOTS } from '../../src/value-collector/config.js';
import { nextValueSlot, ValueCollectorEngine } from '../../src/value-collector/engine.js';
import { publicReader } from '../../src/laya-filter-paper/client.js';

const OPEN = Date.parse('2026-11-01T12:00:00Z');
const condition = index => `0x${index.toString(16).padStart(64, '0')}`;
const marketFor = open => ({ slug: `btc-updown-5m-${open / 1000}`, open, end: open + 300000,
    conditionId: condition(open / 300000), tokens: ['up', 'down'], outcomes: ['Up', 'Down'],
    minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false,
    fee: { rate: .07, exponent: 1, takerOnly: true } });

function fixture({ now = OPEN + 210000, startedAt = now, clockVerified = true } = {}) {
    let time = now;
    const calls = { books: [], builds: [], payouts: [], feed: 0, close: 0 }, observations = [], labels = [], events = [];
    const config = { slots: VALUE_SLOTS, slotToleranceMs: 2000, captureBudgetMs: 3000,
        dataAgeMs: 5000, clockMaxAgeMs: 30000, maxClockSkewMs: 2000, heartbeatMs: 10000, labelRetryMs: 15000 };
    const store = { state: { startedAt, lastSlotAt: null, pending: {} }, saves: 0,
        recordObservation(row) {
            observations.push(structuredClone(row)); this.state.lastSlotAt = row.scheduledAt;
            if (row.conditionId) this.state.pending[row.conditionId] = {
                conditionId: row.conditionId, slug: row.slug, marketEnd: row.marketEnd };
        },
        recordLabel(row) { labels.push(structuredClone(row)); delete this.state.pending[row.conditionId]; },
        save() { this.saves++; }, event(type) { events.push(type); } };
    const client = {
        clock: { at: now }, btc: { openings: new Map([[OPEN, { at: OPEN, receivedAt: OPEN + 100, value: 70000 }]]) },
        async serverTime() { this.clock = { at: time }; return time; },
        async market(slug) { return marketFor(Number(slug.split('-').at(-1)) * 1000); },
        async payout(id) { calls.payouts.push(id); return null; },
        startBtcFeed() { calls.feed++; }, btcStatus() { return { ready: true }; }, close() { calls.close++; },
    };
    const pair = { source: 'rest', books: [{ tokenId: 'up', asks: [{ price: .22, size: 30 }] },
        { tokenId: 'down', asks: [{ price: .96, size: 30 }] }] };
    const options = { clock: () => time,
        readBooks: async (market, args) => { calls.books.push({ market: structuredClone(market), args }); return pair; },
        buildObservation: args => {
            calls.builds.push(args);
            return { quality: { status: args.pair ? 'ready' : 'partial' },
                sides: args.pair?.books.map(book => ({ tokenId: book.tokenId, asks: book.asks })) ?? [] };
        } };
    const engine = new ValueCollectorEngine(config, store, client, options);
    engine.current = marketFor(OPEN);
    if (clockVerified) engine.clockVerifiedAt = time;
    const slot = seconds => ({ slug: marketFor(OPEN).slug, open: OPEN, marketEnd: OPEN + 300000,
        scheduledAt: OPEN + 300000 - seconds * 1000, seconds });
    return { config, store, client, engine, calls, observations, labels, events, options, pair, slot,
        get now() { return time; }, setTime(at) { time = at; }, advance(ms) { time += ms; },
        async settle() { await Promise.allSettled([...engine.tasks]); } };
}

test('value collector schedules every fixed slot once across five-minute boundaries', () => {
    let cursor = OPEN, seen = [];
    for (let i = 0; i < VALUE_SLOTS.length * 2; i++) {
        const slot = nextValueSlot(cursor, VALUE_SLOTS);
        assert.ok(slot.scheduledAt > cursor);
        assert.equal(slot.slug, `btc-updown-5m-${slot.open / 1000}`);
        assert.equal(slot.marketEnd - slot.open, 300000);
        seen.push(slot); cursor = slot.scheduledAt;
    }
    assert.deepEqual(seen.slice(0, 16).map(slot => slot.seconds), VALUE_SLOTS);
    assert.deepEqual(seen.slice(16).map(slot => slot.seconds), VALUE_SLOTS);
    assert.equal(seen[16].scheduledAt, OPEN + 330000);
    assert.equal(nextValueSlot(OPEN + 300000, VALUE_SLOTS).scheduledAt, OPEN + 330000);
});

test('value collector starts at the next prospective slot without fabricating pre-start coverage', async () => {
    const f = fixture({ now: OPEN + 44000 });
    await f.engine.tick(); await f.settle();
    assert.equal(f.observations.length, 0);
    f.setTime(OPEN + 60000);
    await f.engine.tick(); await f.settle();
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0].seconds, 240);
    assert.equal(f.observations[0].status, 'ready');
    await f.engine.tick(); await f.settle();
    assert.equal(f.observations.length, 1);
    await f.engine.close();
});

test('value collector records downtime slots as missed and resumes without historical reads', async () => {
    const f = fixture({ now: OPEN + 510000, startedAt: OPEN + 29000 });
    for (let i = 0; i < 23; i++) { await f.engine.tick(); await f.settle(); }
    assert.equal(f.observations.length, 23);
    assert.equal(new Set(f.observations.map(row => row.id)).size, 23);
    assert.ok(f.observations.slice(0, -1).every(row => row.status === 'missed' && row.features === null));
    assert.equal(f.observations.at(-1).scheduledAt, f.now);
    assert.equal(f.observations.at(-1).status, 'ready');
    assert.equal(f.calls.books.length, 1);
    assert.equal(f.calls.books[0].market.open, OPEN + 300000);
    const resumed = new ValueCollectorEngine(f.config, f.store, f.client, f.options);
    await resumed.tick(); await Promise.allSettled([...resumed.tasks]);
    assert.equal(f.observations.length, 23);
    await resumed.close(); await f.engine.close();
});

test('value collector retains both books outside the old entry price band', async () => {
    const f = fixture();
    f.client.btc.assess = () => { throw new Error('old_signal_must_not_gate_collection'); };
    await f.engine.capture(f.slot(90));
    const row = f.observations[0];
    assert.equal(row.status, 'ready');
    assert.deepEqual(row.features.sides.map(side => side.asks[0].price), [.22, .96]);
    assert.deepEqual(f.calls.books[0].market.tokens, ['up', 'down']);
    assert.equal(f.calls.books[0].args.deadlineAt, f.now + 3000);
    assert.equal(f.calls.builds[0].at, f.now);
});

test('value collector refreshes opening evidence without mutating discovered metadata', async () => {
    const f = fixture();
    f.engine.current.reference = { value: 1 };
    await f.engine.capture(f.slot(90));
    assert.equal(f.calls.builds[0].market.reference.value, 70000);
    assert.equal(f.calls.builds[0].market.reference.receivedAt, OPEN + 100);
    assert.deepEqual(f.engine.current.reference, { value: 1 });
});

test('value collector makes missing markets and book failures visible instead of selecting them away', async () => {
    const absent = fixture(); absent.engine.current = null;
    await absent.engine.capture(absent.slot(90));
    assert.equal(absent.observations[0].status, 'partial');
    assert.equal(absent.observations[0].reason, 'market_unavailable');
    assert.equal(absent.calls.books.length, 0);
    const failed = fixture();
    failed.engine.readBooks = async () => { throw new Error('entry_rest_timeout'); };
    await failed.engine.capture(failed.slot(90));
    assert.equal(failed.observations[0].status, 'partial');
    assert.equal(failed.observations[0].bookError, 'entry_rest_timeout');
    assert.equal(failed.observations[0].conditionId, failed.engine.current.conditionId);
    assert.deepEqual(failed.events, ['book_failed']);
});

test('value collector drops responses beyond the capture budget or market close', async () => {
    for (const { seconds, elapsed } of [{ seconds: 90, elapsed: 3001 }, { seconds: 5, elapsed: 5000 }]) {
        const f = fixture({ now: OPEN + 300000 - seconds * 1000 });
        f.engine.readBooks = async () => { f.advance(elapsed); return f.pair; };
        await f.engine.capture(f.slot(seconds));
        assert.equal(f.observations[0].status, 'partial');
        assert.equal(f.observations[0].reason, 'capture_deadline_exceeded');
        assert.equal(f.observations[0].features, null);
        assert.equal(f.calls.builds.length, 0);
    }
});

test('value collector drops a response when the wall clock rolls backward during capture', async () => {
    const f = fixture(), started = f.now;
    f.engine.readBooks = async () => { f.advance(-1); return f.pair; };
    await f.engine.capture(f.slot(90));
    assert.equal(f.observations[0].reason, 'capture_deadline_exceeded');
    assert.equal(f.observations[0].at, started);
    assert.equal(f.calls.builds.length, 0);
});

test('value collector refuses late slots before requesting books', async () => {
    for (const now of [OPEN + 212001, OPEN + 300000]) {
        const f = fixture({ now });
        await f.engine.capture(f.slot(90));
        assert.equal(f.observations[0].status, 'missed');
        assert.equal(f.calls.books.length, 0);
    }
});

test('value collector never upgrades an unverified, expired, or conflicting snapshot to ready', async () => {
    for (const mode of ['unverified', 'expired', 'conflict']) {
        const f = fixture({ clockVerified: mode !== 'unverified' });
        if (mode === 'expired') f.engine.clockVerifiedAt = f.now - 30000;
        if (mode === 'conflict') f.engine.conflicts.add(OPEN);
        await f.engine.capture(f.slot(90));
        assert.equal(f.observations[0].status, 'partial');
        assert.equal(f.observations[0].clock.verified, mode === 'conflict');
        assert.equal(f.observations[0].referenceConflict, mode === 'conflict');
        assert.equal(f.calls.builds.length, 1);
    }
});

test('value collector caches the actual clock sample time without extending its validity', async () => {
    const f = fixture({ clockVerified: false }), sampledAt = f.now;
    f.client.serverTime = async () => f.now;
    await f.engine.verifyClock();
    assert.equal(f.engine.clockVerifiedAt, sampledAt);
    f.advance(20000); await f.engine.verifyClock();
    assert.equal(f.engine.clockVerifiedAt, sampledAt);
    f.advance(9999); assert.equal(f.engine.clockFresh(), true);
    f.advance(1); assert.equal(f.engine.clockFresh(), false);
    await f.engine.verifyClock();
    assert.equal(f.engine.clockFresh(), false);
    assert.equal(f.store.state.clock.status, 'unverified');
    f.client.clock.at = f.now;
    await f.engine.verifyClock();
    assert.equal(f.engine.clockFresh(), true);
});

test('value collector rejects future, slow, skewed, missing and failed clock samples', async () => {
    for (const mode of ['future', 'slow', 'skew', 'missing', 'failed', 'rollback']) {
        const f = fixture({ clockVerified: false });
        f.client.serverTime = async () => {
            if (mode === 'failed') throw new Error('rpc_unavailable');
            if (mode === 'future') f.client.clock.at = f.now + 1;
            if (mode === 'slow') f.advance(5001);
            if (mode === 'rollback') f.advance(-1);
            if (mode === 'missing') delete f.client.clock;
            return f.now + (mode === 'skew' ? 2001 : 0);
        };
        await f.engine.verifyClock();
        assert.equal(f.engine.clockFresh(), false, mode);
        assert.equal(f.store.state.clock.status, 'unverified', mode);
        assert.deepEqual(f.events, ['clock_failed'], mode);
    }
});

test('value collector does not accept a clock response after its read timeout', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ clockVerified: false });
    let finish;
    f.client.serverTime = () => new Promise(resolve => { finish = resolve; });
    const checking = f.engine.verifyClock();
    await Promise.resolve();
    t.mock.timers.tick(5001);
    await checking;
    assert.equal(f.store.state.clock.reason, 'collector_read_timeout');
    finish(f.now);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.engine.clockFresh(), false);
});

test('value collector retries official labels after settlement without feature mutation', async () => {
    const f = fixture();
    await f.engine.capture(f.slot(90));
    const before = structuredClone(f.observations);
    f.setTime(OPEN + 304999); await f.engine.resolveLabels();
    assert.equal(f.calls.payouts.length, 0);
    f.advance(1); await f.engine.resolveLabels();
    assert.equal(f.calls.payouts.length, 1);
    assert.equal(f.labels.length, 0);
    f.advance(14999); await f.engine.resolveLabels();
    assert.equal(f.calls.payouts.length, 1);
    f.client.payout = async id => { f.calls.payouts.push(id); return [0, 1]; };
    f.advance(1); await f.engine.resolveLabels();
    assert.equal(f.labels.length, 1);
    assert.equal(f.labels[0].source, 'ctf_payout');
    assert.equal(f.labels[0].official, true);
    assert.equal(f.labels[0].outcome, 'DOWN');
    assert.deepEqual(f.observations, before);
    assert.equal(Object.keys(f.store.state.pending).length, 0);
    await f.engine.resolveLabels(); assert.equal(f.calls.payouts.length, 2);
});

test('value collector preserves pending labels after RPC errors and rejects invalid payouts', async () => {
    const f = fixture(); await f.engine.capture(f.slot(90)); f.setTime(OPEN + 305000);
    for (const payout of ['error', [1], [1, 1], [-1, 2], [NaN, 1]]) {
        f.client.payout = async () => { if (payout === 'error') throw new Error('rpc_unavailable'); return payout; };
        await f.engine.resolveLabels();
        assert.equal(f.labels.length, 0);
        assert.equal(Object.keys(f.store.state.pending).length, 1);
        f.advance(15000);
    }
    assert.equal(f.events.filter(event => event === 'label_failed').length, 5);
    f.client.payout = async () => [.5, .5]; await f.engine.resolveLabels();
    assert.equal(f.labels[0].outcome, 'SPLIT');
});

test('value collector does not record a payout that completes after the RPC read timeout', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); await f.engine.capture(f.slot(90)); f.setTime(OPEN + 305000);
    let complete;
    f.client.payout = () => new Promise(resolve => { complete = resolve; });
    const pending = f.engine.resolveLabels();
    await Promise.resolve();
    t.mock.timers.tick(10001); await pending;
    assert.equal(f.labels.length, 0);
    assert.equal(Object.keys(f.store.state.pending).length, 1);
    complete([1, 0]); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.labels.length, 0);
    assert.deepEqual(f.events, ['label_failed']);
});

test('value collector label backlogs do not starve later markets or duplicate in-flight reads', async () => {
    const f = fixture({ now: OPEN + 1800000 });
    for (let i = 0; i < 5; i++) {
        const market = marketFor(OPEN + i * 300000);
        f.store.state.pending[market.conditionId] = { conditionId: market.conditionId,
            slug: market.slug, marketEnd: market.end };
    }
    let unblock;
    f.client.payout = async id => { f.calls.payouts.push(id); await new Promise(resolve => { unblock = resolve; }); return null; };
    const first = f.engine.resolveLabels();
    await Promise.resolve();
    const duplicate = f.engine.resolveLabels();
    assert.equal(f.calls.payouts.length, 1);
    unblock(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.payouts.length, 2);
    unblock(); await first; await duplicate;
    f.client.payout = async id => { f.calls.payouts.push(id); return null; };
    await f.engine.resolveLabels(); await f.engine.resolveLabels();
    assert.equal(f.calls.payouts.length, 5);
    assert.equal(new Set(f.calls.payouts).size, 5);
});

test('value collector rejects a discovered market with mismatched identity', async () => {
    const f = fixture(); f.engine.current = null;
    f.client.market = async () => marketFor(OPEN + 300000);
    await f.engine.discover(f.now);
    assert.equal(f.engine.current, null);
    assert.equal(f.engine.marketError, 'collector_market_identity_mismatch');
    assert.deepEqual(f.events, ['market_failed']);
});

test('value collector ignores market discovery that completes after its deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); f.engine.current = null;
    let complete;
    f.client.market = () => new Promise(resolve => { complete = resolve; });
    const discovery = f.engine.discover(f.now);
    await Promise.resolve();
    t.mock.timers.tick(3001); await discovery;
    complete(marketFor(OPEN)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.engine.current, null);
    assert.equal(f.engine.marketError, 'collector_read_timeout');
});

test('value collector CLI cannot select live, reset, relative output, or extra mutation options', () => {
    for (const command of ['preflight', 'run', 'report'])
        assert.deepEqual(parseArgs([command, '--out=/tmp/value-observations']), { command, out: '/tmp/value-observations' });
    for (const args of [[], ['live', '--out=/tmp/value'], ['run', '--out=relative'],
        ['run', '--out=/tmp/value', '--reset'], ['run', '--out=/tmp/value', '--live'],
        ['run', '--out=/tmp/value', '--out=/tmp/other'], ['report', '--out=/tmp/value', '--promote']])
        assert.throws(() => parseArgs(args));
});

test('value collector reader exposes no financial API and blocks internal transaction calls', async () => {
    let raw;
    class Client {
        constructor() { raw = this; this.btc = {}; this.clock = { at: OPEN }; }
        market() { return this.post(); }
        books() {} payout() {} marketInfo() {} validateInfo() {} serverTime() {}
        tickSize() {} startBtcFeed() {} btcStatus() {} close() {}
        async prepare() { throw new Error('unexpected_transaction'); }
        async post() { throw new Error('unexpected_transaction'); }
        async cancel() { throw new Error('unexpected_transaction'); }
        async prepareAction() { throw new Error('unexpected_transaction'); }
        async broadcastAction() { throw new Error('unexpected_transaction'); }
    }
    const reader = publicReader({}, undefined, Client);
    assert.equal(Object.isFrozen(reader), true);
    for (const method of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction']) {
        assert.equal(reader[method], undefined);
        await assert.rejects(raw[method](), /paper_transaction_forbidden/);
    }
    await assert.rejects(reader.market(), /paper_transaction_forbidden/);
});
