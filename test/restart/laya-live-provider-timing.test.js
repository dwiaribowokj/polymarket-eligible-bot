import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LayaLiveProvider } from '../../src/laya-live/provider.js';
import { QUESTIONS } from '../../src/ai-shadow/config.js';

const START = 1792200000000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const answer = () => ({ model: 'typed-decisions', answers: { action: { choice: 'BUY_UP' } } });

function fixture(t, overrides = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
    let monotonic = 0;
    t.mock.method(performance, 'now', () => monotonic);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_provider_timing_fixture'); });
    const events = [], state = { laya: { tokenizerIdentity: 'pinned-1024-artifact' } };
    const counter = { async start() { return { maxTokens: 1024, identity: 'pinned-1024-artifact' }; },
        async count() { return { valid: true, identity: 'pinned-1024-artifact' }; }, close: t.mock.fn() };
    const fetch = t.mock.fn(async () => ({ ok: true, status: 200, json: async () => answer() }));
    const provider = new LayaLiveProvider({ layaUrl: 'http://private-fixture/secret-path', decisionMs: 3000, layaDrainMs: 30000 },
        state, (type, detail) => events.push({ type, detail }), { counter, fetch, ...overrides });
    t.after(() => provider.close());
    const snapshot = { snapshotId: 'timing-snapshot', input: '{"state":"private-input"}' };
    return { provider, state, counter, fetch, snapshot, events, advance(ms) {
        monotonic += ms; t.mock.timers.setTime(Date.now() + ms);
    }, tick(ms) { monotonic += ms; t.mock.timers.tick(ms); } };
}

test('live telemetry separates tokenizer, inference headers/body, and durable callback overhead without changing request', async t => {
    const f = fixture(t);
    f.counter.count = async function(input) {
        assert.equal(this, f.counter); assert.equal(input, f.snapshot.input);
        f.advance(7); return { valid: true, identity: 'pinned-1024-artifact' };
    };
    // The constructor adapter captures the injected function while preserving
    // the provider receiver expected by the inherited implementation.
    const originalFetch = f.fetch;
    originalFetch.mock.mockImplementation(async function(url, options) {
        assert.equal(this, f.provider); assert.equal(url, 'http://private-fixture/secret-path/v1/systemone');
        assert.deepEqual(JSON.parse(options.body), { model: 'typed-decisions', state: f.snapshot.input, questions: QUESTIONS });
        assert.deepEqual(options.headers, { 'Content-Type': 'application/json' });
        assert.equal(options.method, 'POST'); assert.ok(options.signal instanceof AbortSignal);
        f.advance(100);
        const response = { ok: true, status: 200, async json() {
            assert.equal(this, response); f.advance(20);
            return { ...answer(), requestedAt: 1, receivedAt: 2, latencyMs: 1,
                timing: { tokenizerMs: 0, inferenceHttpMs: 0, secret: 'remote-secret' } };
        } };
        return response;
    });
    // Replacing the sink after construction matches scripts/laya-live.js.
    f.provider.onEvent = (type, detail) => {
        f.events.push({ type, detail });
        if (type === 'provider_pending') f.advance(5);
        if (type === 'provider_drained') f.advance(50);
    };
    const decision = await f.provider.predict('laya', f.snapshot);
    assert.equal(f.fetch.mock.callCount(), 1); assert.equal(decision.status, 'ok');
    assert.equal(decision.model, 'typed-decisions'); assert.equal(decision.requestedAt, START);
    assert.equal(decision.latencyMs, 132); assert.equal(decision.receivedAt, START + 132);
    assert.deepEqual(f.events.map(e => e.type), ['provider_pending', 'provider_drained']);
    const drained = f.events[1].detail;
    assert.equal(drained.snapshotId, f.snapshot.snapshotId);
    assert.equal(drained.timing.tokenizerMs, 7); assert.equal(drained.timing.inferenceHeadersMs, 100);
    assert.equal(drained.timing.inferenceBodyMs, 20); assert.equal(drained.timing.inferenceHttpMs, 120);
    assert.equal(drained.timing.localOverheadMs, 5); assert.equal(drained.timing.eventCallbackMs, 5);
    assert.equal(decision.timing.elapsedMs, 182); assert.equal(decision.timing.localOverheadMs, 55);
    assert.equal(decision.timing.eventCallbackMs, 55); assert.equal(decision.timing.stage, 'drained');
    assert.equal(decision.timing.eventLoopDelayResolutionMs, 20);
    assert.equal(typeof decision.timing.eventLoopActiveMs, 'number');
    assert.equal(typeof decision.timing.eventLoopIdleMs, 'number');
    const telemetry = JSON.stringify({ decision, drained });
    for (const secret of ['private-input', 'secret-path', 'remote-secret', 'Content-Type'])
        assert.equal(telemetry.includes(secret), false);
    assert.equal(f.state.laya.pending, null); assert.equal(f.provider.active.size, 0);
    assert.equal(f.provider.timingAttempts.size, 0);
});

test('tokenizer failure and pinned artifact rejection never reach inference', async t => {
    for (const fault of ['invalid', 'identity', 'throw']) await t.test(fault, async t => {
        const f = fixture(t);
        f.counter.count = async () => {
            f.advance(9);
            if (fault === 'throw') throw new Error('private-tokenizer-error');
            return { valid: fault !== 'invalid', identity: fault === 'identity' ? 'replacement' : 'pinned-1024-artifact' };
        };
        const decision = await f.provider.predict('laya', f.snapshot);
        assert.equal(decision.status, 'provider_error'); assert.equal(decision.timing.tokenizerMs, 9);
        assert.equal(decision.timing.inferenceHttpMs, null); assert.equal(f.fetch.mock.callCount(), 0);
        assert.equal(f.state.laya.pending, null); assert.equal(f.state.laya.disabled, undefined);
        assert.equal(f.provider.timingAttempts.size, 0);
        assert.equal(JSON.stringify(f.events).includes('private-tokenizer-error'), false);
    });
});

test('preflight retains exact1024 and persistent identity pin without inference telemetry', async t => {
    for (const fault of ['none', 'context', 'identity']) await t.test(fault, async t => {
        const f = fixture(t);
        f.counter.start = async () => ({ maxTokens: fault === 'context' ? 2048 : 1024,
            identity: fault === 'identity' ? 'replacement' : 'pinned-1024-artifact' });
        f.fetch.mock.mockImplementation(async function(url) {
            assert.equal(this, f.provider); assert.equal(url, 'http://private-fixture/secret-path/health');
            return { ok: true, json: async () => ({ loaded: ['typed-decisions'] }) };
        });
        const result = await f.provider.preflight();
        assert.equal(result.laya.ready, fault === 'none'); assert.equal(f.fetch.mock.callCount(), 1);
        assert.equal(f.provider.timingAttempts.size, 0); assert.equal(f.events[0].detail.timing, undefined);
        if (fault === 'context') assert.equal(result.laya.reason, 'laya_context_mismatch');
        if (fault === 'identity') assert.equal(f.state.laya.disabled, 'laya_artifact_changed');
    });
});

test('3second decision timeout preserves one active/pending request through late30second drain', async t => {
    const wait = deferred(), f = fixture(t, { fetch: t.mock.fn(() => wait.promise) });
    const pending = f.provider.predict('laya', f.snapshot);
    await flush();
    assert.equal(f.provider.active.size, 1); assert.equal(f.state.laya.pending.snapshotId, f.snapshot.snapshotId);
    f.tick(2999); await flush();
    let resolved = false; pending.then(() => { resolved = true; }); await flush(); assert.equal(resolved, false);
    f.tick(1); const decision = await pending;
    assert.equal(decision.status, 'decision_timeout'); assert.equal(decision.latencyMs, 3000);
    assert.equal(decision.timing.stage, 'inference_headers'); assert.equal(decision.timing.inferenceHttpMs, 3000);
    assert.equal(f.provider.active.size, 1); assert.ok(f.state.laya.pending);
    const busy = await f.provider.predict('laya', { ...f.snapshot, snapshotId: 'other' });
    assert.equal(busy.status, 'provider_busy'); assert.equal(busy.timing, undefined);
    f.advance(1500); wait.resolve({ ok: true, status: 200, json: async () => answer() }); await flush();
    assert.equal(f.state.laya.pending, null); assert.equal(f.provider.active.size, 0);
    assert.equal(f.provider.timingAttempts.size, 0); assert.equal(f.state.laya.disabled, undefined);
    const late = f.events.find(e => e.type === 'provider_late_response').detail;
    assert.equal(late.snapshotId, f.snapshot.snapshotId); assert.equal(late.latencyMs, 4500);
    assert.equal(late.timing.inferenceHttpMs, 4500);
    assert.equal(f.events.filter(e => e.type === 'provider_drained').length, 1);
});

test('unresolved inference still aborts at30seconds, stays disabled, and drains once', async t => {
    const request = deferred(); let signal, calls = 0;
    const f = fixture(t, { fetch: async (_url, options) => {
        calls++; signal = options.signal;
        signal.addEventListener('abort', () => request.reject(new Error('private-abort-details')), { once: true });
        return request.promise;
    } });
    const pending = f.provider.predict('laya', f.snapshot); await flush();
    f.tick(3000); assert.equal((await pending).status, 'decision_timeout');
    f.tick(26999); await flush(); assert.equal(signal.aborted, false); assert.ok(f.state.laya.pending);
    f.tick(1); await flush();
    assert.equal(signal.aborted, true); assert.equal(f.state.laya.disabled, 'inference_unresolved');
    assert.equal(f.state.laya.pending, null); assert.equal(f.provider.active.size, 0); assert.equal(calls, 1);
    assert.equal(f.provider.timingAttempts.size, 0);
    const error = f.events.find(e => e.type === 'provider_drain_error').detail;
    assert.equal(error.timing.inferenceHeadersMs, 30000); assert.equal(error.timing.inferenceHttpMs, 30000);
    assert.equal(JSON.stringify(f.events).includes('private-abort-details'), false);
    assert.equal((await f.provider.predict('laya', f.snapshot)).status, 'inference_unresolved');
});

test('HTTP, body, and model errors preserve inherited classifications and single request', async t => {
    for (const fault of ['http', 'transport', 'body', 'model']) await t.test(fault, async t => {
        const f = fixture(t);
        f.fetch.mock.mockImplementation(async () => {
            f.advance(20);
            if (fault === 'transport') throw new Error('private-transport-details');
            return { ok: fault !== 'http', status: fault === 'http' ? 503 : 200, async json() {
                f.advance(4);
                if (fault === 'body') throw new Error('private-body-details');
                return { ...answer(), ...(fault === 'model' ? { model: 'wrong-model' } : {}) };
            } };
        });
        const decision = await f.provider.predict('laya', f.snapshot);
        assert.equal(decision.status, 'provider_error'); assert.equal(f.fetch.mock.callCount(), 1);
        assert.equal(decision.timing.inferenceHeadersMs, 20);
        assert.equal(decision.timing.inferenceBodyMs, ['body', 'model'].includes(fault) ? 4 : null);
        assert.equal(decision.timing.inferenceHttpMs, ['body', 'model'].includes(fault) ? 24 : 20);
        assert.equal(f.state.laya.disabled, fault === 'model' ? 'model_mismatch'
            : ['transport', 'body'].includes(fault) ? 'inference_transport_uncertain' : undefined);
        assert.equal(f.state.laya.pending, null); assert.equal(f.provider.timingAttempts.size, 0);
    });
});

test('closed, unavailable, pending, and wrong-provider calls never start timing or duplicate requests', async t => {
    for (const blocked of ['closed', 'unavailable', 'pending', 'disabled', 'wrong-provider']) await t.test(blocked, async t => {
        const f = fixture(t);
        if (blocked === 'closed') f.provider.close();
        if (blocked === 'unavailable') f.provider.availability.laya = false;
        if (blocked === 'pending') f.state.laya.pending = { snapshotId: 'restart-unknown', startedAt: START - 1 };
        if (blocked === 'disabled') f.state.laya.disabled = 'restart_with_unknown_inference';
        if (blocked === 'wrong-provider') await assert.rejects(f.provider.predict('9router', f.snapshot), /laya_only/);
        else assert.equal((await f.provider.predict('laya', f.snapshot)).timing, undefined);
        assert.equal(f.fetch.mock.callCount(), 0); assert.equal(f.provider.timingAttempts.size, 0);
        assert.equal(f.events.length, 0);
        if (blocked === 'pending') assert.equal(f.state.laya.pending.snapshotId, 'restart-unknown');
    });
});
