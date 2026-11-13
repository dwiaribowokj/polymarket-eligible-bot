import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { OperationalError } from '../../src/restart/network.js';
import { LiveSupervisor, automaticLiveExit, waitForLiveStartup } from '../../src/laya-live/runner.js';
import { LayaLiveProvider } from '../../src/laya-live/provider.js';
import { enforceStartupGuards } from '../../src/laya-live/preflight.js';

function fixture(t, options = {}) {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Lifecycle tests must remain offline'));
    const events = [], diagnostics = [], state = { cash: 20, stopped: null, position: null };
    const store = { state, save() {}, event(type, detail) { events.push({ type, ...detail }); } };
    const providers = { active: new Map(), state: { laya: {} }, preflight: async () => ({ laya: { ready: true } }) };
    const engine = { closed: false, ticks: 0, shutdowns: 0, tick: async () => { engine.ticks++; },
        nextDelay: () => 1, shutdown: async () => { engine.shutdowns++; } };
    const profitTaking = { tick: async () => false };
    const supervisor = new LiveSupervisor({ engine, store, providers, profitTaking,
        diagnostic: (type, detail) => diagnostics.push({ type, ...detail }), heartbeatMs: 5,
        probeIntervalMs: 100000, reportIntervalMs: 100000, reportRetryMs: 5, ...options });
    t.after(() => supervisor.requestStop());
    return { supervisor, engine, store, state, providers, profitTaking, events, diagnostics };
}

async function until(predicate) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'lifecycle condition did not arrive');
        await delay(2);
    }
}

test('tick and report failures keep heartbeat and inventory maintenance alive without replaying a tick', async t => {
    const f = fixture(t);
    f.state.position = { market: { slug: 'owned' } };
    let reportCalls = 0, concurrent = 0, maxConcurrent = 0;
    f.supervisor.report = async () => { reportCalls++; if (reportCalls === 1) throw new Error('report failed'); };
    f.engine.tick = async () => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); f.engine.ticks++;
        try {
            await delay(4);
            if (f.engine.ticks === 1) throw new OperationalError('read_timeout', 'timeout');
            if (f.engine.ticks === 5) f.supervisor.requestStop();
        } finally { concurrent--; }
    };
    await f.supervisor.run();
    assert.equal(f.engine.ticks, 5);
    assert.equal(maxConcurrent, 1);
    assert.equal(f.engine.shutdowns, 1);
    assert.ok(reportCalls >= 2);
    assert.ok(f.events.filter(e => e.type === 'laya_supervisor_heartbeat').length >= 2);
    assert.ok(f.events.some(e => e.type === 'laya_report_retry'));
    assert.equal(f.state.entryHolds.runtime_error.retryable, false);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.position.market.slug, 'owned');
});

test('a failing withdrawal coordinator cannot starve open inventory cleanup', async t => {
    const f = fixture(t);
    f.state.position = { market: { slug: 'owned' } };
    f.state.profitTaking = { pending: { hash: 'known' } };
    f.profitTaking.tick = async () => { throw new Error('invalid operation'); };
    f.engine.tick = async () => { f.engine.ticks++; if (f.engine.ticks === 3) f.supervisor.requestStop(); };
    await f.supervisor.run();
    assert.equal(f.engine.ticks, 3);
    assert.equal(f.state.entryHolds.runtime_error.retryable, false);
    assert.equal(f.state.profitTaking.pending.hash, 'known');
});

test('temporary provider health holds entries until fresh proof, with no concurrent probes or inference admission', async t => {
    let now = 100000;
    const f = fixture(t, { now: () => now, probeIntervalMs: 1 });
    let probes = 0, inflight = 0, maximum = 0;
    f.providers.preflight = async () => {
        probes++; inflight++; maximum = Math.max(maximum, inflight);
        assert.ok(f.state.entryHolds.provider_probe);
        await delay(3);
        inflight--;
        return probes === 1 ? { laya: { ready: false,
            error: { name: 'OperationalError', code: 'http_server_error', category: 'transport', httpStatus: 503 } } }
            : { laya: { ready: true } };
    };
    f.engine.tick = async () => {
        f.engine.ticks++; now += 1000;
        if (probes >= 2 && !f.state.entryHolds.provider_health && !f.state.entryHolds.provider_probe)
            f.supervisor.requestStop();
    };
    await f.supervisor.run();
    assert.equal(probes, 2);
    assert.equal(maximum, 1);
    assert.equal(f.state.stopped, null);
    assert.deepEqual(f.state.entryHolds, {});
    assert.ok(f.events.some(e => e.type === 'live_entry_hold' && e.key === 'provider_health'));
});

test('semantic health failures and prior stops stay blocked after a later healthy probe', async t => {
    let now = 100000;
    const f = fixture(t, { now: () => now, probeIntervalMs: 1 });
    const stopped = f.state.stopped = { reason: 'laya_inference_status_unknown', at: now };
    let probes = 0;
    f.providers.preflight = async () => (++probes === 1
        ? { laya: { ready: false, reason: 'laya_artifact_changed' } } : { laya: { ready: true } });
    f.engine.tick = async () => {
        f.engine.ticks++; now += 1000;
        if (probes >= 2 && !f.state.entryHolds.provider_probe) f.supervisor.requestStop();
    };
    await f.supervisor.run();
    assert.equal(f.state.entryHolds.provider_semantics.retryable, false);
    assert.equal(f.state.stopped, stopped);
    assert.ok(f.engine.ticks > 1);
});

test('a timed-out health read remains single-flight while heartbeat and serial ticks continue', async t => {
    const f = fixture(t, { probeIntervalMs: 1, probeTimeoutMs: 8 });
    let resolveProbe, probes = 0;
    f.providers.preflight = () => { probes++; return new Promise(resolve => { resolveProbe = resolve; }); };
    f.engine.tick = async () => { f.engine.ticks++; };
    const running = f.supervisor.run();
    await until(() => f.events.some(e => e.type === 'live_entry_hold' && e.key === 'provider_health'));
    await delay(15);
    assert.equal(probes, 1);
    assert.ok(f.engine.ticks > 2);
    assert.ok(f.events.filter(e => e.type === 'laya_supervisor_heartbeat').length >= 2);
    resolveProbe({ laya: { ready: true } });
    await delay(2);
    assert.ok(f.state.entryHolds.provider_health, 'late health result is not fresh retry proof');
    f.supervisor.requestStop();
    await running;
});

test('manual signal prevents another financial tick and awaits the current tick before shutdown', async t => {
    const signal = new AbortController();
    const f = fixture(t, { signal: signal.signal });
    let finishTick;
    const sequence = [];
    f.engine.tick = async () => { sequence.push('tick'); await new Promise(resolve => { finishTick = resolve; }); sequence.push('drained'); };
    f.engine.shutdown = async () => { sequence.push('shutdown'); };
    const running = f.supervisor.run();
    await until(() => finishTick);
    signal.abort();
    assert.equal(f.engine.closed, true);
    assert.equal(f.profitTaking.closed, true);
    assert.deepEqual(sequence, ['tick']);
    finishTick();
    const result = await running;
    assert.deepEqual(sequence, ['tick', 'drained', 'shutdown']);
    assert.equal(result.reason, 'manual_signal');
});

test('only durable risk evidence exits automatically, after all exposure is flat', async t => {
    const f = fixture(t);
    f.state.stopped = { reason: 'operational_check_failed' };
    f.state.liveRiskStop = { reason: 'drawdown_limit' };
    f.state.position = { market: { slug: 'owned' } };
    f.engine.tick = async () => { f.engine.ticks++; if (f.engine.ticks === 3) f.state.position = null; };
    const result = await f.supervisor.run();
    assert.equal(result.reason, 'drawdown_limit');
    assert.equal(f.engine.ticks, 3);
    assert.equal(f.state.stopped.reason, 'operational_check_failed');
    assert.equal(automaticLiveExit({ cash: 1.01, stopped: { reason: 'insufficient_entry_funds' } }), null);
    assert.equal(automaticLiveExit({ cash: 0, stopped: { reason: 'operational_check_failed' } }), null);
    assert.equal(automaticLiveExit({ cash: 0, liveRiskStop: { reason: 'capital_exhausted' } }), 'capital_exhausted');
    assert.equal(automaticLiveExit({ cash: 0, liveRiskStop: { reason: 'capital_exhausted' }, profitTaking: { pending: {} } }), null);
});

test('startup retries read-only failures with heartbeat before any financial runtime is activated', async t => {
    const signal = new AbortController(), events = [];
    let attempts = 0;
    const result = await waitForLiveStartup({ state: {}, signal: signal.signal,
        intervalMs: 2, heartbeatMs: 2, emit: (type, detail) => events.push({ type, ...detail }),
        check: async () => {
            attempts++;
            await delay(3);
            if (attempts === 1) throw new OperationalError('read_timeout', 'timeout');
            return { output: { operationalReady: attempts >= 3, startAllowed: attempts >= 3 } };
        } });
    assert.equal(attempts, 3);
    assert.equal(result.output.operationalReady, true);
    assert.ok(events.filter(e => e.type === 'laya_startup_heartbeat').length >= 2);
    assert.ok(events.some(e => e.type === 'laya_startup_retry'));
});

test('startup keeps a flat semantic stop observable and honors manual shutdown without clearing it', async () => {
    const signal = new AbortController(), stopped = { reason: 'unknown_order_submission' }, state = { stopped };
    let attempts = 0;
    const result = await waitForLiveStartup({ state, signal: signal.signal, intervalMs: 1, heartbeatMs: 2, emit() {},
        check: async () => {
            attempts++;
            if (attempts === 2) signal.abort();
            return { output: { operationalReady: true, startAllowed: false } };
        } });
    assert.equal(result, null);
    assert.equal(attempts, 2);
    assert.equal(state.stopped, stopped);
});

test('exposed restart proceeds to recovery maintenance during a provider outage with entries latched off', async () => {
    const state = { position: { market: { slug: 'owned' } }, stopped: null };
    let checks = 0;
    const result = await waitForLiveStartup({ state, emit() {}, check: async () => {
        checks++;
        return { output: { operationalReady: false, startAllowed: true, recoveryOnly: true,
            provider: { laya: { ready: false, reason: 'laya_probe_failed' } } } };
    } });
    assert.equal(checks, 1, 'owned inventory must not wait for local AI health');
    assert.equal(result.output.recoveryOnly, true);
    const store = { state, stop(reason) { state.stopped ||= { reason }; } };
    const readiness = enforceStartupGuards(store, { explicitLive: true, operationalReady: false });
    assert.equal(readiness.recoveryOnly, true);
    assert.equal(state.stopped.reason, 'live_preflight_blocked');
    assert.equal(state.position.market.slug, 'owned');
});

test('live provider health diagnostics distinguish HTTP outages, authorization, and Retry-After', async t => {
    for (const status of [503, 401, 429]) {
        const provider = new LayaLiveProvider({ layaUrl: 'http://offline.invalid', decisionMs: 100 }, {}, () => {}, {
            counter: { start: () => assert.fail('HTTP failure cannot start tokenizer'), close() {} }, retryDelayMs: 0,
            fetch: async () => ({ ok: false, status,
                headers: new Headers(status === 429 ? { 'retry-after': '120' } : {}) }) });
        t.after(() => provider.close());
        const result = await provider.preflight();
        assert.equal(result.laya.ready, false);
        assert.equal(result.laya.error.httpStatus, status);
        assert.equal(result.laya.error.category, status === 503 ? 'transport' : status === 429 ? 'rate_limit' : 'api_rejection');
        assert.equal(result.laya.error.stage, 'provider_health');
        if (status === 429) assert.equal(result.laya.error.retryAfter, 120);
    }
});
