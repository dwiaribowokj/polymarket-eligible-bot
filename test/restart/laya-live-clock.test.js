import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { ReadCoordinator, OperationalError } from '../../src/restart/network.js';
import { BASELINE } from '../../src/restart/config.js';
import { Store } from '../../src/restart/store.js';
import { newPosition } from '../../src/restart/strategy.js';
import { LIVE_CLOCK, temporaryClockFailure } from '../../src/laya-live/clock.js';

function clockFixture(t) {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
    const advance = ms => t.mock.timers.setTime(Date.now() + ms);
    const client = Object.create(LayaTradingClient.prototype);
    client.settings = { ...BASELINE };
    client.reads = new ReadCoordinator({ sleep: async ms => advance(ms), random: () => 0.2 });
    const events = [];
    client.reads.onEvent = e => events.push(e);
    return { client, advance, events };
}

test('clock retry measures only the successful round trip and coalesces concurrent checks', async t => {
    const f = clockFixture(t); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (calls === 1) { f.advance(3000); throw new OperationalError('read_timeout', 'timeout'); }
        const before = Date.now(); f.advance(800);
        return new Response(JSON.stringify((before + 400 + 1000) / 1000));
    });
    const before = Date.now(), result = await Promise.all([f.client.serverTime(), f.client.serverTime()]);
    assert.equal(calls, 2); assert.deepEqual(result, [Date.now() + 1000, Date.now() + 1000]);
    assert.equal(f.client.clock.skewMs, 1000); assert.equal(f.client.clock.durationMs, 800);
    // The old outer check counted half of all retry time as extra clock skew.
    assert.ok(result[0] - (before + Date.now()) / 2 > BASELINE.maxClockSkewMs);
    f.advance(5000); assert.equal(await f.client.serverTime(), Date.now() + 1000); assert.equal(calls, 2);
    f.advance(30000); await f.client.serverTime(); assert.equal(calls, 3);
    assert.ok(f.events.some(e => e.type === 'read_failed' && e.error.code === 'read_timeout'));
});

test('forced proactive samples bypass only the clock cache and retain skew/RTT validation', async t => {
    const f = clockFixture(t); let calls = 0, skew = 1000;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++; const before = Date.now(); f.advance(800);
        return new Response(JSON.stringify((before + 400 + skew) / 1000));
    });
    await f.client.serverTime(); const previous = { ...f.client.clock };
    f.advance(20000); await f.client.serverTime(); assert.equal(calls, 1);
    await Promise.all([f.client.serverTime({ force: true }), f.client.serverTime({ force: true })]);
    assert.equal(calls, 2); assert.ok(f.client.clock.at > previous.at);
    assert.equal(f.client.clock.skewMs, 1000); assert.equal(f.client.clock.durationMs, 800);
    const verified = { ...f.client.clock }; skew = 2001;
    await assert.rejects(f.client.serverTime({ force: true }), { code: 'invalid_server_clock' });
    assert.deepEqual(f.client.clock, verified); assert.equal(calls, 3);
});

test('wrong clock, invalid payload, and excessive successful round trip never update the clock', async t => {
    for (const fault of ['offset', 'payload', 'latency']) {
        await t.test(fault, async t => {
            const f = clockFixture(t);
            t.mock.method(globalThis, 'fetch', async () => {
                const before = Date.now(); f.advance(fault === 'latency' ? 5001 : 200);
                const value = fault === 'payload' ? 'invalid' : (before + (Date.now() - before) / 2
                    + (fault === 'offset' ? 2001 : 0)) / 1000;
                return new Response(JSON.stringify(value));
            });
            await assert.rejects(f.client.serverTime(), e => e.code === 'invalid_server_clock');
            assert.equal(f.client.clock, undefined); assert.equal(f.client.clockPending, null);
        });
    }
});

function engineFixture(t, client, restored) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-clock-engine-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const settings = { ...BASELINE, dataDir: dir, fingerprint: 'clock', capital: 20 };
    const store = new Store(settings, 'pilot', 'late-entry'); store.logger = () => {};
    if (restored) store.state = structuredClone(restored);
    const events = [], event = store.event.bind(store);
    store.event = (type, detail) => { events.push({ type, ...detail }); event(type, detail); };
    client.startBtcFeed = () => {};
    const engine = new LayaLiveEngine({ settings, policy: { aiSource: 'source' } }, store, client, {}, {});
    const calls = { decisions: 0, cancellations: 0, wallets: 0, reconciliations: 0, payouts: 0, watches: 0 };
    engine.watch = async () => { calls.watches++; };
    engine.discover = async () => { if (engine.clockAllowsEntry()) calls.decisions++; };
    engine.broker.checkWallet = async () => { calls.wallets++; return true; };
    engine.broker.cancelOwned = async () => { calls.cancellations++; };
    engine.broker.reconcile = async () => { calls.reconciliations++; };
    engine.broker.pending = () => !!store.state.position;
    client.payout = async () => { calls.payouts++; return [1, 0]; };
    return { engine, store, calls, events, decisions: () => calls.decisions, cancellations: () => calls.cancellations };
}

function expose(f) {
    const now = Date.now(), state = f.store.state;
    const market = { slug: 'existing', conditionId: 'condition', open: now - 300000, end: now - 1,
        tokens: ['up', 'down'], fee: { rate: .07, exponent: 1 } };
    const p = state.position = newPosition(market, { cost: 1 }, state, now - 1000);
    p.holdings = [1, 0]; p.bought = [1, 0]; p.orders = [{ status: 'unknown' }];
    p.markBooks = [{ bids: [{ price: 1, size: 1 }] }, { bids: [] }]; state.cash = 19;
    return p;
}

test('actual engine survives a clock timeout followed by a valid response, without the duplicate midpoint check', async t => {
    const f = clockFixture(t), e = engineFixture(t, f.client); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        if (++calls === 1) { f.advance(3000); throw new OperationalError('read_timeout', 'timeout'); }
        const before = Date.now(); f.advance(800);
        return new Response(JSON.stringify((before + 400 + 1000) / 1000));
    });
    await e.engine.tick();
    assert.equal(e.store.state.stopped, null); assert.equal(e.decisions(), 1); assert.equal(calls, 2);
    assert.equal(e.store.state.position, null); assert.deepEqual(e.store.state.seen, {});
});

test('engine renews clock before slow tick work crosses thirty-second expiry', async t => {
    const f = clockFixture(t), e = engineFixture(t, f.client); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++; const before = Date.now(); f.advance(200);
        return new Response(JSON.stringify((before + 100) / 1000));
    });
    await e.engine.tick(); const first = f.client.clock.at;
    f.advance(LIVE_CLOCK.freshMs - LIVE_CLOCK.refreshAheadMs - 1);
    await e.engine.checkClock(); assert.equal(calls, 1);
    f.advance(1);
    e.engine.watch = async () => { e.calls.watches++; f.advance(9500); };
    e.engine.broker.checkWallet = async () => { e.calls.wallets++; f.advance(1000); return true; };
    await e.engine.tick();
    assert.ok(Date.now() - first > LIVE_CLOCK.freshMs);
    assert.equal(calls, 2, 'Proactive refresh must bypass the client thirty-second cache');
    assert.equal(e.engine.clockAllowsEntry(), true); assert.equal(e.decisions(), 2);
    assert.equal(e.store.state.stopped, null); assert.equal(e.cancellations(), 0);
});

test('failed proactive clock probe still holds entry and honors retry instead of trusting cached time', async t => {
    const f = clockFixture(t), e = engineFixture(t, f.client); let offline = false;
    t.mock.method(globalThis, 'fetch', async () => {
        if (offline) throw new OperationalError('read_timeout', 'timeout');
        return new Response(JSON.stringify(Date.now() / 1000));
    });
    await e.engine.tick(); f.advance(20000); offline = true;
    await e.engine.tick();
    assert.equal(e.engine.clockAllowsEntry(), false); assert.equal(e.decisions(), 1);
    assert.equal(e.store.state.liveClock.status, 'waiting'); assert.equal(e.store.state.stopped, null);
    assert.equal(e.store.state.entryHolds.clock.retryable, true);
    const retryAt = e.store.state.liveClock.retryAt;
    f.advance(retryAt - Date.now()); offline = false; await e.engine.tick();
    assert.equal(e.engine.clockAllowsEntry(), true); assert.equal(e.decisions(), 2);
});

test('continuous clock recovery must fetch a new sample even while the rejected probe leaves a younger cache', async t => {
    const f = clockFixture(t), e = engineFixture(t, f.client); let calls = 0, skew = 0;
    e.engine.settings.continuousTrading = true; e.store.state.decisionProvider = 'eligible';
    t.mock.method(globalThis, 'fetch', async () => {
        calls++; return new Response(JSON.stringify((Date.now() + skew) / 1000));
    });
    await e.engine.tick(); const original = f.client.clock.at;
    f.advance(20000); skew = 2001; await e.engine.tick();
    assert.equal(calls, 2); assert.equal(e.engine.clockAllowsEntry(), false);
    assert.equal(e.store.state.liveClock.status, 'waiting'); assert.equal(e.store.state.stopped, null);
    assert.equal(f.client.clock.at, original);
    f.advance(e.store.state.liveClock.retryAt - Date.now()); skew = 0;
    assert.ok(Date.now() - original < LIVE_CLOCK.freshMs);
    await e.engine.tick();
    assert.equal(calls, 3, 'Recovery cannot reuse the cache left behind by a rejected forced sample');
    assert.equal(e.engine.clockAllowsEntry(), true); assert.equal(f.client.clock.at, Date.now());
    assert.equal(e.store.state.entryHolds.clock, undefined);
});

test('genuine clock error and nonfinite time stop flat and exposed engines while maintenance continues', async t => {
    for (const exposed of [false, true]) for (const fault of ['offset', 'nonfinite']) {
        await t.test(`${exposed}:${fault}`, async t => {
            t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
            const client = { serverTime: async () => {
                return fault === 'offset' ? Date.now() + 2001 : NaN;
            } };
            const e = engineFixture(t, client);
            if (exposed) expose(e);
            await e.engine.tick();
            assert.equal(e.store.state.stopped.reason, 'operational_check_failed');
            assert.equal(e.decisions(), 0); assert.ok(e.cancellations() >= 1);
            assert.equal(e.store.state.failures, 1);
            assert.equal(e.calls.wallets, 1); assert.equal(e.calls.reconciliations, Number(exposed));
            assert.equal(e.calls.payouts, Number(exposed)); assert.equal(e.store.state.lastTickAt, Date.now());
        });
    }
});

test('exhausted timeout pauses entry and recovers with bounded probes for flat and exposed engines', async t => {
    for (const exposed of [false, true]) await t.test(String(exposed), async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0, offline = true;
        const f = engineFixture(t, { serverTime: async () => {
            probes++; if (offline) throw new OperationalError('read_timeout', 'timeout'); return Date.now();
        } });
        const p = exposed ? expose(f) : null, startedAt = f.store.state.startedAt;
        await f.engine.tick();
        assert.equal(f.store.state.stopped, null); assert.equal(f.store.state.liveClock.status, 'waiting');
        assert.equal(f.decisions(), 0); assert.equal(f.calls.watches, 0); assert.equal(probes, 1);
        assert.equal(f.engine.lastClockCheck, 0); assert.equal(f.store.state.lastTickAt, Date.now());
        assert.equal(f.calls.reconciliations, Number(exposed)); assert.equal(f.calls.payouts, Number(exposed));
        t.mock.timers.setTime(Date.now() + 4999); await f.engine.tick(); assert.equal(probes, 1);
        offline = false; t.mock.timers.setTime(Date.now() + 1); await f.engine.tick();
        assert.equal(probes, 2); assert.equal(f.store.state.liveClock.status, 'verified');
        assert.equal(f.store.state.stopped, null); assert.equal(f.store.state.startedAt, startedAt);
        assert.equal(f.store.state.position, p); assert.equal(f.decisions(), exposed ? 0 : 1);
        assert.equal(f.events.filter(e => e.type === 'live_clock_wait').length, 1);
        assert.deepEqual(f.events.filter(e => e.type === 'live_clock_recovered').map(e => e.outageMs), [5000]);
    });
});

test('only allowlisted public-clock transport failures can enter a hold', () => {
    for (const [code, category] of [['read_timeout', 'timeout'], ['transport_failed', 'transport'],
        ['http_server_error', 'transport'], ['rate_limited', 'rate_limit'], ['rate_limit_wait', 'rate_limit'], ['circuit_open', 'circuit']])
        assert.equal(temporaryClockFailure(new OperationalError(code, category, { stage: 'server_time', endpoint: 'clob' })), true);
    for (const error of [new Error('private payload'), new OperationalError('invalid_api_data', 'validation'),
        new OperationalError('invalid_server_clock', 'stale_data'), new OperationalError('http_rejected', 'api_rejection'),
        new OperationalError('read_timeout', 'timeout', { stage: 'order_status' }),
        new OperationalError('read_timeout', 'timeout', { endpoint: 'rpc' }), new OperationalError('other', 'timeout')])
        assert.equal(temporaryClockFailure(error), false);
});

test('Retry-After and shared CLOB circuits defer probes without log spam', async t => {
    for (const circuit of [false, true]) await t.test(String(circuit), async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0;
        const f = engineFixture(t, { reads: { endpoints: new Map([['clob', { openUntil: circuit ? Date.now() + 30000 : 0 }]]) },
            serverTime: async () => { probes++; throw circuit ? new OperationalError('circuit_open', 'circuit')
                : new OperationalError('rate_limited', 'rate_limit', { retryAfter: 20 }); } });
        await f.engine.tick(); const until = f.store.state.liveClock.retryAt;
        assert.equal(until - Date.now(), circuit ? 30000 : 20000);
        for (let i = 0; i < 10; i++) { t.mock.timers.setTime(Date.now() + 1000); await f.engine.tick(); }
        assert.equal(probes, 1); assert.equal(f.events.filter(e => e.type === 'live_clock_wait').length, 1);
        t.mock.timers.setTime(until); await f.engine.tick(); assert.equal(probes, 2);
        assert.equal(f.decisions(), 0); assert.equal(f.store.state.stopped, null);
    });
});

test('long clock outages survive restart with bounded probes and recover without changing ledger history', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0;
    const client = { serverTime: async () => { probes++; throw new OperationalError('read_timeout', 'timeout'); } };
    const f = engineFixture(t, client); await f.engine.tick(); const since = f.store.state.liveClock.outageAt;
    f.store.state.seen.previous = { at: since - 10000 }; f.store.state.ai.snapshots.push({ snapshotId: 'existing' });
    t.mock.timers.setTime(since + 119999);
    const restarted = engineFixture(t, client, f.store.state); await restarted.engine.tick();
    assert.equal(restarted.store.state.liveClock.outageAt, since); assert.equal(restarted.store.state.stopped, null);
    t.mock.timers.setTime(since + 3600000); await restarted.engine.tick();
    assert.equal(restarted.store.state.stopped, null);
    assert.equal(restarted.store.state.liveClock.status, 'waiting');
    assert.equal(restarted.store.state.liveClock.outageAt, since);
    assert.ok(restarted.store.state.liveClock.retryAt - Date.now() <= LIVE_CLOCK.retryMaxMs);
    assert.equal(restarted.store.state.lastTickAt, Date.now());
    client.serverTime = async () => Date.now();
    t.mock.timers.setTime(restarted.store.state.liveClock.retryAt);
    const afterOutage = engineFixture(t, client, restarted.store.state); await afterOutage.engine.tick();
    assert.equal(afterOutage.store.state.stopped, null); assert.equal(afterOutage.decisions(), 1);
    assert.equal(afterOutage.store.state.liveClock.status, 'verified');
    assert.deepEqual(afterOutage.store.state.entryHolds, {});
    assert.deepEqual(afterOutage.store.state.seen, f.store.state.seen);
    assert.deepEqual(afterOutage.store.state.ai.snapshots, f.store.state.ai.snapshots);
});

test('restart rechecks time and cached sample verification age cannot be renewed', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0;
    const client = { clock: { at: Date.now() - 20000 }, serverTime: async () => { probes++; return Date.now(); } };
    const f = engineFixture(t, client); await f.engine.tick(); assert.equal(probes, 1);
    assert.equal(f.engine.lastClockCheck, client.clock.at);
    t.mock.timers.setTime(Date.now() + 9999); assert.equal(f.engine.clockAllowsEntry(), true);
    t.mock.timers.setTime(Date.now() + 1); assert.equal(f.engine.clockAllowsEntry(), false);
    client.clock.at = Date.now();
    const restarted = engineFixture(t, client, f.store.state); await restarted.engine.tick(); assert.equal(probes, 2);
});

test('malformed and unknown clock errors remain fatal and are private-safe', async t => {
    for (const error of [new OperationalError('invalid_api_data', 'validation'), new Error('SECRET_PRIVATE_PAYLOAD')])
        await t.test(error.name, async t => {
            t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
            const f = engineFixture(t, { serverTime: async () => { throw error; } }); await f.engine.tick();
            assert.equal(f.store.state.stopped.reason, 'operational_check_failed');
            assert.equal(f.store.state.liveClock.status, 'failed'); assert.equal(f.calls.wallets, 1);
            assert.equal(JSON.stringify(f.events).includes('SECRET_PRIVATE_PAYLOAD'), false);
        });
});

test('clock recovery preserves manual and drawdown stops; risk still latches during a hold', async t => {
    for (const reason of ['manual_stop', 'drawdown_limit']) await t.test(reason, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let offline = true;
        const f = engineFixture(t, { serverTime: async () => {
            if (offline) throw new OperationalError('read_timeout', 'timeout'); return Date.now();
        } });
        f.store.stop(reason); const stopped = structuredClone(f.store.state.stopped);
        await f.engine.tick(); offline = false; t.mock.timers.setTime(Date.now() + 5000); await f.engine.tick();
        assert.deepEqual(f.store.state.stopped, stopped); assert.equal(f.decisions(), 0);
    });
    await t.test('risk', async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
        const f = engineFixture(t, { serverTime: async () => { throw new OperationalError('read_timeout', 'timeout'); } });
        expose(f); f.store.state.cash = 16; await f.engine.tick();
        assert.equal(f.store.state.stopped.reason, 'drawdown_limit'); assert.ok(f.store.state.maxDrawdown >= 3);
        assert.equal(f.calls.reconciliations, 1); assert.equal(f.calls.payouts, 1);
    });
});

test('expired time blocks real discover, observe and validation before entry work', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
    const f = engineFixture(t, { serverTime: async () => Date.now() }); await f.engine.tick();
    const seen = structuredClone(f.store.state.seen); t.mock.timers.setTime(Date.now() + LIVE_CLOCK.freshMs);
    f.engine.current = { slug: 'should-never-be-read' }; await LayaLiveEngine.prototype.discover.call(f.engine);
    await assert.rejects(f.engine.observe({}, 90, 'slot'), e => e.code === 'live_clock_unverified');
    await assert.rejects(f.engine.validate({}), e => e.code === 'live_clock_unverified');
    assert.deepEqual(f.store.state.seen, seen); assert.equal(f.store.state.stopped, null);
});

test('a new engine or missing gate blocks entry before its first verified clock check', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0;
    const f = engineFixture(t, { serverTime: async () => { probes++; return Date.now(); } });
    assert.equal(f.engine.clockAllowsEntry(), false);
    f.engine.current = { slug: 'unverified' }; await LayaLiveEngine.prototype.discover.call(f.engine);
    await assert.rejects(f.engine.observe({}, 90, 'slot'), e => e.code === 'live_clock_unverified');
    await assert.rejects(f.engine.validate({}), e => e.code === 'live_clock_unverified');
    assert.equal(probes, 0); assert.equal(f.store.state.position, null); assert.deepEqual(f.store.state.seen, {});
    delete f.engine.clockGate; assert.equal(f.engine.clockAllowsEntry(), false);
});

test('clock expiry during signing blocks post and retains the only market reservation', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let probes = 0, posts = 0, validates = 0;
    const f = engineFixture(t, { serverTime: async () => { probes++; return Date.now(); },
        prepare: async () => { t.mock.timers.setTime(Date.now() + LIVE_CLOCK.freshMs);
            return { orderId: 'prepared-order', signed: { sealed: true } }; },
        post: async () => { posts++; throw new Error('must not post'); } });
    await f.engine.tick(); const market = { slug: 'reserved', tokens: ['up', 'down'], end: Date.now() + 90000 };
    const spec = { side: 'BUY', kind: 'taker', tokenId: 'up', index: 0, shares: 5, price: .79 };
    f.store.state.seen.reserved = { at: Date.now(), cost: 3.95 };
    const position = f.store.state.position = newPosition(market, { cost: 3.95 }, f.store.state, Date.now());
    // Exercise the broker's actual validation boundaries with the real clock
    // guard; quote validation is covered separately by the execution suite.
    f.engine.validate = async () => { validates++; f.engine.assertEntryClock(); return {}; };
    const result = await f.engine.broker.submit(spec, Date.now());
    assert.equal(result.status, 'rejected'); assert.equal(posts, 0); assert.equal(probes, 1); assert.equal(validates, 2);
    assert.equal(f.store.state.position, position); assert.ok(f.store.state.seen.reserved);
    assert.equal(position.orders.length, 1); assert.equal(position.orders[0].status, 'rejected');
    await assert.rejects(f.engine.broker.submit(spec, Date.now()), /laya_duplicate_entry_attempt/);
});

test('a stop requested during signing blocks the only POST and retains its signed reservation', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let posts = 0;
    const f = engineFixture(t, { serverTime: async () => Date.now(),
        prepare: async () => { f.engine.closed = true; return { orderId: 'prepared-stop', signed: { sealed: true } }; },
        post: async () => { posts++; throw new Error('must not post'); } });
    await f.engine.tick();
    const market = { slug: 'reserved-stop', tokens: ['up', 'down'], end: Date.now() + 90000 };
    const spec = { side: 'BUY', kind: 'taker', tokenId: 'up', index: 0, shares: 5, price: .79 };
    f.store.state.seen[market.slug] = { at: Date.now(), cost: 3.95 };
    const position = f.store.state.position = newPosition(market, { cost: 3.95 }, f.store.state, Date.now());
    f.engine.validate = async () => { f.engine.assertEntryClock(); return {}; };
    const result = await f.engine.broker.submit(spec, Date.now());
    assert.equal(result.status, 'rejected'); assert.equal(posts, 0);
    assert.equal(position.orders.length, 1); assert.deepEqual(position.orders[0].signed, { sealed: true });
    assert.ok(f.store.state.seen[market.slug]); assert.equal(f.store.state.position, position);
    await assert.rejects(f.engine.broker.submit(spec, Date.now()), /laya_duplicate_entry_attempt/);
});
