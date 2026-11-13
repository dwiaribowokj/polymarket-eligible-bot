import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as flush } from 'node:timers/promises';
import { DecisionProviders } from '../../src/decision-paper/providers.js';
import { GEMINI_MODEL, GEMINI_ROUTE_MODEL } from '../../src/decision-paper/gemini.js';
import { decisionBudget } from '../../src/laya-filter-paper/decision-budget.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('combined shutdown drain waits for both timed-out providers before closing and preserves late Gemini billing', async t => {
    const at = 100000;
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: at });
    const config = { routerUrl: 'http://router.invalid/v1', routerKey: 'test-only-key', geminiModel: GEMINI_MODEL,
        layaUrl: 'http://laya.invalid', dataAgeMs: 5000, decisionMs: 3000, latencyMs: 250, inferenceReserveMs: 150,
        decisionTimeoutPolicy: 'snapshot-freshness-budget-v1', late: { minSeconds: 10 },
        deadline: Number.MAX_SAFE_INTEGER, layaDrainMs: 30000, geminiDrainMs: 120000,
        geminiCooldownMs: 120000, providerShutdownDrainMs: 30000,
        inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
    const state = {}, events = [], submissions = { laya: 0, gemini: 0 };
    let resolveLaya, resolveGemini, geminiSignal;
    const providers = new DecisionProviders(config, state, (type, detail) => events.push({ type, ...detail }), {
        laya: {
            counter: { async start() { return { maxTokens: 1024, identity: 'tokenizer' }; },
                async count() { return { valid: true, identity: 'tokenizer' }; }, close() {} },
            fetch: async url => {
                if (url.endsWith('/health')) return response({ loaded: ['typed-decisions'] });
                submissions.laya++;
                return new Promise(resolve => { resolveLaya = resolve; });
            },
        },
        gemini: { pin: () => GEMINI_ROUTE_MODEL, fetch: async (url, init) => {
            if (init.method === 'GET') return response({ data: [{ id: GEMINI_MODEL }] });
            submissions.gemini++; geminiSignal = init.signal;
            return new Promise(resolve => { resolveGemini = resolve; });
        } },
    });
    t.after(() => providers.close());
    const readiness = await providers.preflight();
    assert.equal(readiness.laya.ready, true);
    assert.equal(readiness.gemini.ready, true);
    const input = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60 });
    const enriched = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60, allowed_meaning: 'execution_only' });
    const snapshot = { snapshotId: 'drain-test', input, inputHash: hash(input), at, observedAt: at,
        validation: { at }, marketEnd: at + 90000,
        informed: { snapshotId: 'drain-test', input: enriched, inputHash: hash(enriched), originalInputHash: hash(input),
            version: 'decision-paper-context-v1' } };
    snapshot.decisionDeadlineAt = decisionBudget(config, snapshot, at).decisionDeadlineAt;
    const decisions = Promise.all(['laya', 'gemini'].map(name => providers.predict(name, snapshot)));
    await flush();
    t.mock.timers.tick(4600);
    const initialResults = await decisions;
    assert.deepEqual(initialResults.map(row => row.status), ['decision_timeout', 'decision_timeout']);
    assert.equal(providers.active.size, 2);

    let shutdownDrained = false;
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const drain = providers.drain().then(result => { shutdownDrained = result; return result; });
    const shutdownTimer = scheduled.mock.calls.find(call => call.arguments[1] === 30000).result;
    await flush();
    assert.equal(shutdownDrained, false);
    resolveLaya(response({ model: 'typed-decisions', answers: { action: { choice: 'BUY_UP' } } }));
    await flush();
    assert.equal(shutdownDrained, false, 'the completed Laya request must not release the pending Gemini drain');
    assert.equal(providers.active.size, 1);
    assert.equal(geminiSignal.aborted, false);

    t.mock.timers.tick(600);
    resolveGemini(response({ model: 'gemini-3.8-flash-low',
        choices: [{ finish_reason: 'stop', message: { content: '{"action":"BUY_UP"}' } }],
        usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 } }));
    assert.equal(await drain, true);
    assert.equal(cleared.mock.calls.some(call => call.arguments[0] === shutdownTimer), true);
    providers.close();
    assert.equal(shutdownDrained, true);
    assert.equal(providers.active.size, 0);
    assert.equal(state.gemini.pending, null);
    assert.equal(state.gemini.disabled, undefined);
    assert.equal(geminiSignal.aborted, false);
    assert.deepEqual(submissions, { laya: 1, gemini: 1 });
    assert.deepEqual(initialResults.map(row => row.action), ['SKIP', 'SKIP']);
    const late = events.filter(event => event.type === 'provider_late_response' && event.provider === 'gemini');
    assert.equal(late.length, 1);
    assert.equal(late[0].executable, false);
    assert.equal(late[0].latencyMs, 5200);
    assert.equal(late[0].cost, .00044);
    assert.equal(late[0].usage.total_tokens, 420);
});

for (const completionAtAbort of [false, true]) {
    test(`shutdown waits at most 30 seconds then cools down Gemini (${completionAtAbort ? 'response races abort' : 'abort rejected'})`, async t => {
        const at = 100000;
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: at });
        const config = { routerUrl: 'http://router.invalid/v1', routerKey: 'test-only-key', geminiModel: GEMINI_MODEL,
            layaUrl: 'http://laya.invalid', dataAgeMs: 5000, decisionMs: 3000, latencyMs: 250, inferenceReserveMs: 150,
            decisionTimeoutPolicy: 'snapshot-freshness-budget-v1', late: { minSeconds: 10 },
            deadline: Number.MAX_SAFE_INTEGER, layaDrainMs: 30000, geminiDrainMs: 120000,
            geminiCooldownMs: 120000, providerShutdownDrainMs: 30000 };
        const state = {}, events = [];
        let signal, submissions = 0, aborts = 0;
        const providers = new DecisionProviders(config, state, (type, detail) => events.push({ type, ...detail }), {
            laya: {
                counter: { async start() { return { maxTokens: 1024, identity: 'tokenizer' }; }, close() {} },
                fetch: async () => response({ loaded: ['typed-decisions'] }),
            },
            gemini: { pin: () => GEMINI_ROUTE_MODEL, fetch: async (url, init) => {
                if (init.method === 'GET') return response({ data: [{ id: GEMINI_MODEL }] });
                submissions++; signal = init.signal;
                return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
                    aborts++;
                    if (completionAtAbort) resolve(response({ model: 'gemini-3.8-flash-n',
                        choices: [{ finish_reason: 'stop', message: { content: '{"action":"BUY_UP"}' } }],
                        usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 } }));
                    else reject(new DOMException('request aborted', 'AbortError'));
                }, { once: true }));
            } },
        });
        t.after(() => providers.close());
        assert.equal((await providers.preflight()).gemini.ready, true);
        const input = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60 });
        const enriched = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60, allowed_meaning: 'execution_only' });
        const snapshot = { snapshotId: 'bounded-shutdown', input, inputHash: hash(input), at, observedAt: at,
            validation: { at }, marketEnd: at + 90000,
            informed: { snapshotId: 'bounded-shutdown', input: enriched, inputHash: hash(enriched),
                originalInputHash: hash(input), version: 'decision-paper-context-v1' } };
        snapshot.decisionDeadlineAt = decisionBudget(config, snapshot, at).decisionDeadlineAt;
        const prediction = providers.predict('gemini', snapshot); await flush();
        t.mock.timers.tick(4600);
        const initial = await prediction;
        assert.equal(initial.status, 'decision_timeout'); assert.equal(initial.action, 'SKIP');
        assert.equal(providers.active.size, 1); assert.equal(signal.aborted, false);

        const scheduled = t.mock.method(globalThis, 'setTimeout');
        const cleared = t.mock.method(globalThis, 'clearTimeout');
        let drainResult = null;
        const draining = providers.drain().then(result => { drainResult = result; return result; });
        const shutdownTimer = scheduled.mock.calls.find(call => call.arguments[1] === 30000).result;
        t.mock.timers.tick(29999); await flush();
        assert.equal(drainResult, null); assert.equal(signal.aborted, false);
        t.mock.timers.tick(1);
        assert.equal(await draining, false); await flush();
        assert.equal(Date.now(), at + 34600); assert.equal(signal.aborted, true); assert.equal(aborts, 1);
        assert.equal(cleared.mock.calls.some(call => call.arguments[0] === shutdownTimer), true);
        assert.equal(providers.active.size, 0); assert.equal(state.gemini.pending, null);
        assert.equal(state.gemini.disabled, undefined);
        assert.equal(state.gemini.recoveryAt, at + 34600 + 120000);
        assert.equal(state.gemini.recoveryReason, 'closed_with_unknown_inference');
        const cooldown = events.find(event => event.type === 'provider_cooldown');
        assert.equal(cooldown.upstreamCancellationConfirmed, false); assert.equal(cooldown.cost, null);
        assert.equal((await providers.predict('gemini', snapshot)).status, 'provider_closed');
        assert.equal(submissions, 1);
        if (completionAtAbort) {
            const late = events.find(event => event.type === 'provider_late_response');
            assert.equal(late.model, 'gemini-3.8-flash-n'); assert.equal(late.usage.total_tokens, 420);
            assert.equal(late.action, 'BUY_UP'); assert.equal(late.executable, false); assert.equal(late.latencyMs, 34600);
        } else {
            const error = events.find(event => event.type === 'provider_drain_error');
            assert.equal(error.reason, 'closed_with_unknown_inference'); assert.equal(error.executable, false);
        }
        t.mock.timers.tick(240000); await flush();
        assert.equal(events.filter(event => event.type === 'provider_cooldown').length, 1);
        assert.equal(state.gemini.disabled, undefined); assert.equal(initial.action, 'SKIP');
        assert.equal(initial.executable, false); assert.equal(submissions, 1); assert.equal(aborts, 1);
    });
}
