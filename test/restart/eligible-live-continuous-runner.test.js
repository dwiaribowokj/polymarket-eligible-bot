import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveSupervisor, automaticLiveExit, waitForLiveStartup } from '../../src/laya-live/runner.js';

test('continuous supervision disables automatic exit without changing stored risk evidence', () => {
    for (const reason of ['drawdown_limit', 'capital_exhausted', 'bankrupt']) {
        for (const field of ['liveRiskStop', 'stopped']) {
            const state = { cash: 0, [field]: { reason, at: 123 } }, original = structuredClone(state);
            assert.equal(automaticLiveExit(state, { continuousTrading: true }), null);
            assert.deepEqual(state, original);
            for (const continuousTrading of [undefined, false, 'true', 1])
                assert.equal(automaticLiveExit(state, { continuousTrading }), reason);
        }
    }
});

test('continuous startup keeps old risk stops observable until a manual signal, draining its check', async () => {
    const controller = new AbortController(), events = [];
    const state = { stopped: { reason: 'drawdown_limit', at: 1 }, liveRiskStop: { reason: 'drawdown_limit', at: 1 } };
    const original = structuredClone(state);
    let checks = 0, release;
    const running = waitForLiveStartup({ state, signal: controller.signal, continuousTrading: true,
        intervalMs: 1, heartbeatMs: 10000, emit: (type, detail) => events.push({ type, ...detail }),
        check: async () => {
            checks++;
            if (checks === 2) await new Promise(resolve => { release = resolve; controller.abort(); });
            return { output: { operationalReady: true, startAllowed: false } };
        } });
    await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    let finished = false;
    running.then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    assert.equal(await running, null);
    assert.equal(checks, 2);
    assert.deepEqual(state, original);
    assert.equal(events[0].type, 'laya_startup_heartbeat');
    assert.deepEqual(events[0].liveRiskStop, state.liveRiskStop);
});

test('continuous startup does not bypass preflight and admits an allowed ready result', async () => {
    let checks = 0;
    const result = await waitForLiveStartup({ state: {}, continuousTrading: true, intervalMs: 1, emit() {},
        check: async () => ({ output: { operationalReady: ++checks >= 3, startAllowed: checks >= 3 } }) });
    assert.equal(checks, 3);
    assert.equal(result.output.startAllowed, true);
    assert.equal(result.output.operationalReady, true);
});

test('default startup still exits for durable flat risk evidence before checking', async () => {
    const result = await waitForLiveStartup({ state: { liveRiskStop: { reason: 'capital_exhausted' } }, emit() {},
        check: async () => assert.fail('Default risk exit must happen before preflight') });
    assert.equal(result, null);
});

test('continuous supervisor keeps ticking after risk evidence and waits for a manual signal to drain', async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Continuous supervisor tests must remain offline'));
    const controller = new AbortController(), sequence = [], events = [];
    const state = { decisionProvider: 'eligible', cash: 0, stopped: { reason: 'drawdown_limit', at: 1 },
        liveRiskStop: { reason: 'drawdown_limit', at: 1 }, position: { market: { slug: 'owned' } } };
    const originalStop = structuredClone(state.stopped), originalRisk = structuredClone(state.liveRiskStop);
    const store = { state, save() {}, event(type, detail) { events.push({ type, ...detail }); } };
    let ticks = 0, release;
    const engine = { config: { policy: { provider: 'eligible' } },
        tick: async () => {
            ticks++; sequence.push(`tick:${ticks}`);
            if (ticks === 1) state.position = null;
            if (ticks === 3) {
                await new Promise(resolve => { release = resolve; controller.abort(); });
                sequence.push('drained');
            }
        }, nextDelay: () => 1, shutdown: async () => { sequence.push('shutdown'); } };
    const profitTaking = { tick: async () => false };
    const supervisor = new LiveSupervisor({ engine, store, profitTaking, signal: controller.signal,
        continuousTrading: true, providers: { active: new Map() }, probeIntervalMs: 100000, diagnostic() {},
        report: () => sequence.push('report') });
    t.after(() => supervisor.requestStop());
    const running = supervisor.run();
    await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    assert.equal(ticks, 3);
    assert.equal(engine.closed, true);
    assert.equal(profitTaking.closed, true);
    assert.equal(sequence.includes('shutdown'), false);
    release();
    const result = await running;
    assert.equal(result.reason, 'manual_signal');
    assert.equal(supervisor.closed, true);
    assert.ok(sequence.indexOf('drained') < sequence.indexOf('shutdown'));
    assert.equal(sequence.filter(value => value === 'shutdown').length, 1);
    assert.equal(ticks, 3);
    assert.deepEqual(state.stopped, originalStop);
    assert.deepEqual(state.liveRiskStop, originalRisk);
    assert.equal(events[0].type, 'laya_supervisor_heartbeat');
});

test('continuous supervisor still rejects another provider ledger identity', () => {
    assert.throws(() => new LiveSupervisor({ engine: { config: { policy: { provider: 'eligible' } } },
        store: { state: { decisionProvider: 'laya' } }, continuousTrading: true }), /live_provider_identity_mismatch/);
});
