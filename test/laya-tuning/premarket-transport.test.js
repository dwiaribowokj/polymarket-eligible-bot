import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { configureEarlyPaperTransport, EARLY_PAPER_TRANSPORT, EARLY_PAPER_CLOCK } from '../../src/premarket-paper/transport.js';
import { EarlyPremarketTradingClient, PremarketTradingClient, premarketReader } from '../../src/premarket-paper/client.js';
import { TradingClient } from '../../src/restart/client.js';
import { ReadCoordinator, OperationalError } from '../../src/restart/network.js';

test('early transport routing is scoped to this process and restores nested callers exactly once', t => {
    const previous = { family: net.getDefaultAutoSelectFamily(), dns: dns.getDefaultResultOrder() };
    t.after(() => { net.setDefaultAutoSelectFamily(previous.family); dns.setDefaultResultOrder(previous.dns); });
    net.setDefaultAutoSelectFamily(true); dns.setDefaultResultOrder('verbatim');
    const first = configureEarlyPaperTransport(), second = configureEarlyPaperTransport();
    assert.equal(net.getDefaultAutoSelectFamily(), false); assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
    first(); first();
    assert.equal(net.getDefaultAutoSelectFamily(), false); assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
    second(); second();
    assert.equal(net.getDefaultAutoSelectFamily(), true); assert.equal(dns.getDefaultResultOrder(), 'verbatim');
    const again = configureEarlyPaperTransport(); again();
    assert.equal(net.getDefaultAutoSelectFamily(), true); assert.equal(dns.getDefaultResultOrder(), 'verbatim');
    assert.equal(Object.isFrozen(EARLY_PAPER_TRANSPORT), true);
    assert.equal(Object.isFrozen(EARLY_PAPER_CLOCK), true);
});

test('restoration preserves a later explicit DNS configuration', t => {
    const previous = { family: net.getDefaultAutoSelectFamily(), dns: dns.getDefaultResultOrder() };
    t.after(() => { net.setDefaultAutoSelectFamily(previous.family); dns.setDefaultResultOrder(previous.dns); });
    const restore = configureEarlyPaperTransport();
    dns.setDefaultResultOrder('ipv6first'); restore();
    assert.equal(dns.getDefaultResultOrder(), 'ipv6first');
});

function fixture(t) {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 });
    const advance = ms => t.mock.timers.setTime(Date.now() + ms), events = [];
    const client = Object.create(EarlyPremarketTradingClient.prototype);
    client.settings = { maxClockSkewMs: 2000, maxDataAgeMs: 5000 };
    client.reads = new ReadCoordinator();
    client.clockReads = new ReadCoordinator({ policy: EARLY_PAPER_CLOCK, sleep: async ms => advance(ms), random: () => 0.2,
        onEvent: event => events.push(event) });
    return { client, advance, events };
}

test('early clock retries measure the successful attempt and coalesce concurrent requests', async t => {
    const { client, advance, events } = fixture(t); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        if (++calls === 1) { advance(3000); throw new OperationalError('read_timeout', 'timeout'); }
        const before = Date.now(); advance(800);
        return new Response(JSON.stringify((before + 400 + 1000) / 1000));
    });
    const startedAt = Date.now(), values = await Promise.all([client.serverTime(), client.serverTime()]);
    assert.equal(calls, 2); assert.equal(Date.now() - startedAt, 4400);
    assert.deepEqual(values, [Date.now() + 1000, Date.now() + 1000]);
    assert.deepEqual(client.clock, { at: Date.now(), skewMs: 1000, durationMs: 800 });
    assert.equal(client.clockPending, null);
    assert.ok(events.some(event => event.type === 'read_failed' && event.error.code === 'read_timeout'));
});

test('early clock refreshes at 20 seconds before the original sample expires at 30 seconds', async t => {
    const { client, advance } = fixture(t); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(Date.now() / 1000)); });
    await client.serverTime(); const original = client.clock.at;
    advance(19999); await client.serverTime(); assert.equal(calls, 1); assert.equal(client.clock.at, original);
    advance(1); await client.serverTime(); assert.equal(calls, 2); assert.equal(client.clock.at, original + 20000);
});

test('book and metadata circuits cannot block the dedicated early clock coordinator', async t => {
    const { client } = fixture(t); let calls = 0;
    client.reads.state('clob').openUntil = Date.now() + 30000;
    client.reads.state('gamma').openUntil = Date.now() + 30000;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(Date.now() / 1000)); });
    assert.equal(await client.serverTime(), Date.now()); assert.equal(calls, 1);
    assert.equal(client.reads.state('clob').openUntil, Date.now() + 30000);
    assert.equal(client.clockReads.state('clob').openUntil, 0);
});

test('temporary refresh failures retain a verified sample without renewing its age or allowing expiry', async t => {
    const { client, advance } = fixture(t); let calls = 0;
    const original = client.clock = { at: Date.now(), skewMs: 500, durationMs: 200 };
    advance(20000);
    t.mock.method(globalThis, 'fetch', async () => {
        calls++; advance(3000); throw new OperationalError('read_timeout', 'timeout');
    });
    assert.equal(await client.serverTime(), Date.now() + 500);
    assert.equal(calls, 2); assert.equal(client.clock, original); assert.equal(Date.now() - original.at, 26600);
    client.clockReads.state('clob').openUntil = Date.now() + 30000;
    assert.equal(await client.serverTime(), Date.now() + 500); assert.equal(calls, 2);
    advance(3400);
    await assert.rejects(client.serverTime(), error => error.code === 'circuit_open');
    assert.equal(client.clock, original); assert.equal(client.clockSampleFresh(), false);
});

test('a refresh that crosses the original sample expiry fails closed', async t => {
    const { client, advance } = fixture(t);
    client.clock = { at: Date.now() - 25000, skewMs: 0, durationMs: 100 };
    t.mock.method(globalThis, 'fetch', async () => { advance(3000); throw new OperationalError('read_timeout', 'timeout'); });
    await assert.rejects(client.serverTime(), error => error.code === 'read_timeout');
    assert.equal(client.clockSampleFresh(), false);
});

test('hanging clock reads abort each attempt at three seconds and retry only once', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000000000000 });
    const client = Object.create(EarlyPremarketTradingClient.prototype), signals = [];
    client.settings = { maxClockSkewMs: 2000, maxDataAgeMs: 5000 };
    client.clockReads = new ReadCoordinator({ policy: EARLY_PAPER_CLOCK, sleep: async () => {} });
    t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
        signals.push(signal);
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const failed = assert.rejects(client.serverTime(), error => error.code === 'read_timeout');
    const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
    await flush(); assert.equal(signals.length, 1);
    t.mock.timers.tick(2999); await flush(); assert.equal(signals[0].aborted, false);
    t.mock.timers.tick(1); await flush(); assert.equal(signals[0].aborted, true); assert.equal(signals.length, 2);
    t.mock.timers.tick(3000); await failed;
    assert.equal(signals[1].aborted, true); assert.equal(signals.length, 2); assert.equal(client.clock, undefined);
});

test('invalid responses, incorrect clock offsets and excessive round trips never fall back to an old sample', async t => {
    for (const fault of ['payload', 'offset', 'latency', 'reversed', 'http']) await t.test(fault, async t => {
        const { client, advance } = fixture(t);
        client.clock = { at: Date.now() - 20000, skewMs: 0, durationMs: 100 };
        t.mock.method(globalThis, 'fetch', async () => {
            const before = Date.now(); advance(fault === 'latency' ? 3001 : fault === 'reversed' ? -1 : 200);
            if (fault === 'http') return new Response('{}', { status: 403 });
            const raw = fault === 'payload' ? { time: Date.now() } : (before + (Date.now() - before) / 2
                + (fault === 'offset' ? 2001 : 0)) / 1000;
            return new Response(JSON.stringify(raw));
        });
        await assert.rejects(client.serverTime(), error => error.code === (fault === 'http' ? 'http_rejected' : 'invalid_server_clock'));
        assert.equal(client.clock, null); assert.equal(client.clockPending, null);
    });
});

test('only the early public reader selects the new clock behavior', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000000000 }); let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(Date.now() / 1000)); });
    const control = { rpcUrl: 'https://polygon.drpc.org', maxDataAgeMs: 5000, maxClockSkewMs: 2000 };
    const reader = premarketReader({ profile: 'early-reversal-30x5m-v1', control }, () => {});
    t.after(() => reader.close());
    await reader.serverTime(); const original = reader.clock.at;
    t.mock.timers.setTime(Date.now() + 20000); await reader.serverTime();
    assert.equal(calls, 2); assert.equal(reader.clock.at, original + 20000);
    assert.equal(PremarketTradingClient.prototype.serverTime, TradingClient.prototype.serverTime);
    assert.equal(reader.prepare, undefined); assert.equal(reader.post, undefined); assert.equal(reader.broadcastAction, undefined);
});
