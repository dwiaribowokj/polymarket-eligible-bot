import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { BASELINE } from '../../src/restart/config.js';
import { marketSlug } from '../../src/restart/strategy.js';

const slotAt = Date.parse('2026-10-18T00:04:00Z');

function fixture(t, { start = slotAt, clockMs = 0, watchMs = 0, walletMs = 0 } = {}) {
    let now = start;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now - slotAt);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Slot timing fixtures must stay offline'));
    const settings = { ...BASELINE, capital: 20, pilotHours: Infinity, pilotMarkets: Infinity };
    const config = { settings, policy: { aiSource: 'offline-slot-timing' }, ai: {
        slots: [60], slotToleranceMs: 2000, dataAgeMs: 5000, decisionMs: 3000,
    } };
    const market = { slug: marketSlug('late-entry', settings, slotAt), conditionId: 'offline-condition',
        open: slotAt - 240000, end: slotAt + 60000, tokens: ['offline-up', 'offline-down'],
        ticks: [.01, .01], tick: .01, minimum: 5, accepting: true,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: slotAt - 3600000,
        cash: 20, peakEquity: 20, maxDrawdown: 0, failures: 0, completed: [], seen: {},
        stopped: null, position: null };
    const events = [];
    const store = { state, save() {}, event(type, detail) { events.push({ type, detail }); },
        stop(reason) { state.stopped ||= { reason, at: now }; } };
    const client = { startBtcFeed() {}, serverTime: t.mock.fn(async () => { now += clockMs; return now; }) };
    const engine = new LayaLiveEngine(config, store, client, {}, {});
    engine.current = market;
    engine.watch = t.mock.fn(async () => { now += watchMs; });
    engine.broker.checkWallet = t.mock.fn(async () => { now += walletMs; return true; });
    engine.broker.cancelOwned = async () => assert.fail('Healthy flat fixtures must not cancel');
    engine.observe = t.mock.fn(async () => {});
    return { engine, config, client, market, state, events,
        get now() { return now; }, advance(ms) { now += ms; } };
}

test('clock, watch and wallet awaits crossing a slot start use current time on the same tick', async t => {
    const f = fixture(t, { start: slotAt - 100, clockMs: 40, watchMs: 20, walletMs: 150 });
    await f.engine.tick();
    assert.equal(f.client.serverTime.mock.callCount(), 1);
    assert.equal(f.engine.lastClockCheck, slotAt - 60);
    assert.equal(f.engine.watch.mock.calls[0].arguments[0], slotAt - 60);
    assert.equal(f.engine.observe.mock.callCount(), 1);
    const slot = f.state.ai.slots[`${f.market.slug}:60`];
    assert.equal(slot.at, slotAt + 110);
    assert.deepEqual(slot.timing, { scheduledAt: slotAt, checkedAt: slotAt + 110,
        tickAt: slotAt - 40, tickDelayMs: 150, slotLatenessMs: 110 });
    assert.equal(f.state.stopped, null);
});

test('wallet reads crossing the two second deadline consume the slot before collection and never retry', async t => {
    const f = fixture(t, { start: slotAt + 100, clockMs: 500, watchMs: 500, walletMs: 1100 });
    await f.engine.tick();
    const key = `${f.market.slug}:60`, slot = f.state.ai.slots[key];
    assert.equal(f.now, slotAt + 2200);
    assert.equal(slot.status, 'slot_late');
    assert.equal(slot.timing.tickDelayMs, 1100);
    assert.equal(slot.timing.slotLatenessMs, 2200);
    assert.equal(f.engine.observe.mock.callCount(), 0);
    assert.deepEqual(f.events.find(event => event.type === 'laya_slot_skipped').detail,
        { key, reason: 'slot_late', timing: slot.timing });
    await f.engine.tick();
    assert.equal(f.engine.observe.mock.callCount(), 0);
    assert.equal(f.events.filter(event => event.type === 'laya_slot_skipped').length, 1);
    assert.equal(f.state.position, null);
    assert.deepEqual(f.state.seen, {});
    assert.equal(f.state.stopped, null);
});

test('a clock await crossing a market rollover watches the current market timestamp', async t => {
    const f = fixture(t, { start: slotAt + 59990, clockMs: 20 });
    await f.engine.tick();
    assert.equal(f.engine.watch.mock.calls[0].arguments[0], slotAt + 60010);
    assert.equal(f.engine.observe.mock.callCount(), 0);
    assert.deepEqual(f.state.ai.slots, {});
});

test('the exact slot deadline is accepted but one millisecond beyond is skipped', async t => {
    for (const latenessMs of [2000, 2001]) await t.test(`${latenessMs}ms`, async t => {
        const f = fixture(t, { start: slotAt + latenessMs });
        await f.engine.checkClock();
        await f.engine.discover(slotAt);
        assert.equal(f.engine.observe.mock.callCount(), latenessMs === 2000 ? 1 : 0);
        assert.equal(f.state.ai.slots[`${f.market.slug}:60`].status,
            latenessMs === 2000 ? 'reserved' : 'slot_late');
    });
});

test('REST and metadata preparation that exhaust the slot records timing without stream validation or inference', async t => {
    const f = fixture(t);
    await f.engine.checkClock();
    delete f.engine.observe;
    const rest = [{ timestamp: slotAt - 100, fetchedAt: slotAt - 50 }];
    f.client.books = t.mock.fn(async (_market, options) => {
        assert.equal(options.deadline, slotAt + 2000);
        f.advance(100); return rest;
    });
    f.client.marketInfo = t.mock.fn(async () => { f.advance(1901); return {}; });
    f.client.validateInfo = t.mock.fn(() => {});
    f.engine.books = { generation: 7, snapshot: () => assert.fail('Expired slots must not validate a stream') };
    f.engine.providers = { predict: () => assert.fail('Expired slots must not request inference') };
    await f.engine.discover(slotAt);
    const key = `${f.market.slug}:60`, slot = f.state.ai.slots[key];
    assert.equal(slot.status, 'invalid');
    assert.equal(f.client.books.mock.callCount(), 1);
    assert.equal(f.client.marketInfo.mock.callCount(), 1);
    assert.equal(f.client.validateInfo.mock.callCount(), 1);
    assert.equal(slot.preparationTiming.startedAt, slotAt);
    assert.equal(slot.preparationTiming.deadlineAt, slotAt + 2000);
    assert.equal(slot.preparationTiming.failedAt, slotAt + 2001);
    assert.equal(slot.preparationTiming.elapsedMs, 2001);
    for (const field of ['restMs', 'metadataMs']) assert.ok(slot.preparationTiming[field] >= 0);
    const missed = f.events.find(event => event.type === 'laya_snapshot_skipped').detail;
    assert.equal(missed.reason, 'slot_late_after_validation');
    assert.equal(missed.preparationTiming, slot.preparationTiming);
    assert.deepEqual(rest, [{ timestamp: slotAt - 100, fetchedAt: slotAt - 50 }]);
    await f.engine.discover(slotAt);
    assert.equal(f.client.books.mock.callCount(), 1);
    assert.equal(f.state.ai.snapshots.length, 0);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.position, null);
    assert.deepEqual(f.state.seen, {});
});
