import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as flush } from 'node:timers/promises';
import { GeminiPaperProvider, GEMINI_MODEL, GEMINI_ROUTE_MODEL, GEMINI_PROMPT_SHA256 } from '../../src/decision-paper/gemini.js';
import { INFORMED_PROMPT_SHA256 } from '../../src/decision-paper/features.js';
import { decisionBudget } from '../../src/laya-filter-paper/decision-budget.js';

const start = 100000;
const config = { routerUrl: 'http://router.invalid/v1', routerKey: 'test-secret-do-not-log', geminiModel: GEMINI_MODEL,
    dataAgeMs: 5000, latencyMs: 250, inferenceReserveMs: 150, late: { minSeconds: 10 },
    deadline: Number.MAX_SAFE_INTEGER, geminiDrainMs: 120000, geminiCooldownMs: 120000 };
const hash = value => createHash('sha256').update(value).digest('hex');
function snapshot(overrides = {}) {
    const input = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60 });
    const enriched = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60, allowed_meaning: 'execution_only' });
    const row = { snapshotId: 'snapshot-a', input, inputHash: hash(input), at: start, observedAt: start,
        validation: { at: start }, marketEnd: start + 90000,
        informed: { snapshotId: 'snapshot-a', input: enriched, inputHash: hash(enriched), originalInputHash: hash(input),
            version: 'decision-paper-context-v1' }, ...overrides };
    row.informed.snapshotId = row.snapshotId;
    row.decisionDeadlineAt = decisionBudget(config, row, row.at).decisionDeadlineAt;
    return row;
}
const completion = (overrides = {}) => ({ model: 'gemini-3.8-flash-low',
    choices: [{ index: 0, finish_reason: 'stop', message: { content: '{"action":"BUY_UP","reasonCode":"favorable_edge"}' } }],
    usage: { prompt_tokens: 400, completion_tokens: 20, total_tokens: 420 }, ...overrides });
const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const streamChunk = (delta, finish = null, overrides = {}) => ({ id: 'chatcmpl-pinned', model: 'gemini-3.8-flash-n',
    choices: [{ index: 0, delta, finish_reason: finish }], ...overrides });
const sse = row => 'data: ' + (typeof row === 'string' ? row : JSON.stringify(row)) + '\r\n\r\n';
const streamResponse = chunks => new Response(chunks, { headers: { 'Content-Type': 'text/event-stream' } });
async function fixture(t, options = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
    const state = options.state || {}, events = [], calls = [];
    let resolve, signal;
    const provider = new GeminiPaperProvider({ ...config, ...options.config }, state, async (type, detail) => {
        events.push({ type, ...detail }); await options.onEvent?.(type, detail);
    }, { pin: options.pin || (() => GEMINI_ROUTE_MODEL), fetch: async (url, init) => {
        calls.push({ url, init }); signal = init.signal;
        if (init.method === 'GET') return options.catalog ? options.catalog(url, init) : response({ data: [{ id: GEMINI_MODEL }] });
        return options.fetch ? options.fetch(url, init) : new Promise(r => { resolve = r; });
    } });
    t.after(() => provider.close());
    if (options.preflight !== false) await provider.preflight();
    return { provider, state, events, calls, get signal() { return signal; },
        resolve: data => resolve(response(data || completion())), get inferenceCalls() { return calls.filter(call => call.init.method === 'POST'); } };
}

test('preflight is read-only, alias route pinned and exposes no authentication or URL', async t => {
    const f = await fixture(t), health = f.provider.getHealth();
    assert.equal(health.ready, true); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'http://router.invalid/v1/models');
    assert.equal(f.calls[0].init.method, 'GET'); assert.equal(f.calls[0].init.redirect, 'error');
    assert.equal(f.calls[0].init.headers['x-9r-internal-models-fetch'], '1');
    assert.equal(f.inferenceCalls.length, 0);
    assert.equal(JSON.stringify({ health, events: f.events }).includes(config.routerKey), false);
    assert.equal(JSON.stringify({ health, events: f.events }).includes(config.routerUrl), false);
    assert.equal(health.model, 'polymarket-decision'); assert.equal(health.resolvedModel, GEMINI_ROUTE_MODEL);
    assert.throws(() => new GeminiPaperProvider({ ...config, geminiModel: GEMINI_ROUTE_MODEL }, {}), /gemini_model_not_pinned/);
    assert.throws(() => new GeminiPaperProvider({ ...config, geminiResolvedModel: 'ag/gemini-3.8-flash-medium' }, {}), /route_not_pinned/);
    assert.throws(() => new GeminiPaperProvider({ ...config, allowedResponseModels: ['cx/gpt6luna'] }, {}), /not_pinned/);
});

test('catalog direct models cannot establish readiness without the required alias', async t => {
    const f = await fixture(t, { catalog: async () => response({ data: [{ id: GEMINI_ROUTE_MODEL }, { id: 'ag/gemini-3.8-flash-medium' }] }) });
    assert.equal(f.provider.getHealth().reason, 'gemini_model_unavailable');
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'preflight_unavailable');
    assert.equal(f.inferenceCalls.length, 0);
});

test('metadata body timeout and transport errors stay bounded and sanitized', async t => {
    const f = await fixture(t, { preflight: false, catalog: async () => new Response(new ReadableStream({ start() {} })) });
    const pending = f.provider.preflight(); await flush(); t.mock.timers.tick(3000);
    assert.equal((await pending).reason, 'provider_read_timeout'); assert.equal(f.signal.aborted, true);
    f.provider.fetch = async () => { throw new Error('Bearer ' + config.routerKey + ' ' + config.routerUrl); };
    const health = await f.provider.preflight();
    assert.equal(health.reason, 'router_probe_failed');
    assert.equal(JSON.stringify({ health, events: f.events }).includes(config.routerKey), false);
});

test('request durably records its immutable identity before HTTP and accepts a 3500ms response', async t => {
    let durable = false;
    const f = await fixture(t, { onEvent: type => { if (type === 'provider_pending') durable = true; } });
    const pending = f.provider.predict('gemini', snapshot()); await flush();
    assert.equal(durable, true); assert.equal(f.state.gemini.pending.inputHash, snapshot().informed.inputHash);
    const request = JSON.parse(f.inferenceCalls[0].init.body);
    assert.equal(request.model, GEMINI_MODEL); assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, { include_usage: true });
    assert.equal(request.reasoning_effort, 'low'); assert.equal(request.messages[1].content, snapshot().informed.input);
    assert.equal(hash(request.messages[0].content), GEMINI_PROMPT_SHA256);
    assert.equal(request.tools, undefined); assert.equal(request.fallback, undefined);
    t.mock.timers.tick(3500); f.resolve(); const row = await pending;
    assert.equal(row.status, 'ok'); assert.equal(row.action, 'BUY_UP'); assert.equal(row.latencyMs, 3500);
    assert.equal(row.requestedAt, start); assert.equal(row.receivedAt, start + 3500);
    assert.equal(row.informedPromptHash, INFORMED_PROMPT_SHA256); assert.equal(row.promptHash, GEMINI_PROMPT_SHA256);
    assert.equal(row.cost, null); assert.equal(row.usage.prompt_tokens, 400); assert.equal(row.requestSubmitted, true);
    assert.equal(f.state.gemini.pending, null); assert.equal(f.provider.active.size, 0);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'snapshot_already_attempted');
    assert.equal(f.inferenceCalls.length, 1);
});

test('pending fsync consumes the source deadline and never dispatches after expiry', async t => {
    const f = await fixture(t, { onEvent: type => { if (type === 'provider_pending') t.mock.timers.tick(4600); } });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'decision_budget_expired'); assert.equal(row.requestSubmitted, false);
    assert.equal(f.inferenceCalls.length, 0); assert.equal(f.state.gemini.pending, null);
    assert.equal(f.state.gemini.disabled, undefined);
});

test('source age shortens timeout, late diagnostics drain and the next fresh snapshot can run', async t => {
    const f = await fixture(t), snap = snapshot({ observedAt: start - 1200 });
    const pending = f.provider.predict('gemini', snap); await flush(); t.mock.timers.tick(3400);
    const row = await pending;
    assert.equal(row.status, 'decision_timeout'); assert.equal(row.action, 'SKIP'); assert.equal(row.receivedAt, null);
    assert.equal(f.provider.active.size, 1); assert.ok(f.state.gemini.pending);
    assert.equal((await f.provider.predict('gemini', snap)).status, 'provider_busy');
    t.mock.timers.tick(100); f.resolve(); await flush();
    const late = f.events.find(event => event.type === 'provider_late_response');
    assert.equal(late.latencyMs, 3500); assert.equal(late.action, 'BUY_UP'); assert.equal(late.executable, false);
    assert.equal(late.model, 'gemini-3.8-flash-low'); assert.equal(late.usage.total_tokens, 420);
    assert.equal(f.state.gemini.pending, null); assert.equal(f.provider.active.size, 0);
    assert.equal(row.action, 'SKIP'); assert.equal(f.inferenceCalls.length, 1);
    const fresh = snapshot({ snapshotId: 'snapshot-b', at: Date.now(), observedAt: Date.now(), validation: { at: Date.now() } });
    const next = f.provider.predict('gemini', fresh); await flush(); f.resolve();
    assert.equal((await next).status, 'ok'); assert.equal(f.inferenceCalls.length, 2);
});

test('source deadlines include pending persistence time and reject externally extended budgets', async t => {
    const f = await fixture(t, { onEvent: type => { if (type === 'provider_pending') t.mock.timers.tick(700); } });
    const snap = snapshot();
    assert.equal((await f.provider.predict('gemini', { ...snap, decisionDeadlineAt: snap.decisionDeadlineAt + 1 })).status, 'invalid_decision_budget');
    const pending = f.provider.predict('gemini', snap); await flush(); t.mock.timers.tick(3900);
    assert.equal((await pending).status, 'decision_timeout'); assert.equal(Date.now(), start + 4600);
    f.resolve(); await flush();
});

test('an event-loop-delayed completed response remains non-executable', async t => {
    const f = await fixture(t, { fetch: async () => ({ ok: true, json: async () => {
        t.mock.timers.setTime(start + 4601); return completion();
    } }) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'decision_timeout'); assert.equal(row.action, 'SKIP'); assert.equal(row.executable, false);
    assert.equal(row.receivedAt, start + 4601); assert.equal(row.reason, 'decision_deadline_exceeded');
});

test('response persistence cannot extend the admission deadline or reopen a single flight', async t => {
    let provider, concurrent;
    const f = await fixture(t, { fetch: async () => response(completion()), onEvent: async type => {
        if (type !== 'provider_drained') return;
        concurrent = await provider.predict('gemini', snapshot());
        t.mock.timers.tick(4600);
    } });
    provider = f.provider;
    const row = await provider.predict('gemini', snapshot());
    assert.equal(concurrent.status, 'provider_busy'); assert.equal(row.status, 'decision_timeout');
    assert.equal(row.action, 'SKIP'); assert.equal(row.executable, false); assert.equal(f.inferenceCalls.length, 1);
});

test('a response received after 60 seconds is retained only as diagnostics', async t => {
    const f = await fixture(t, { config: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } });
    const pending = f.provider.predict('gemini', snapshot()); await flush();
    t.mock.timers.tick(60000); assert.equal((await pending).status, 'decision_timeout');
    assert.equal(f.signal.aborted, false); assert.equal(f.provider.active.size, 1);
    f.resolve(); await flush();
    const late = f.events.find(event => event.type === 'provider_late_response');
    assert.equal(late.latencyMs, 60000); assert.equal(late.model, 'gemini-3.8-flash-low');
    assert.equal(late.action, 'BUY_UP'); assert.equal(late.executable, false); assert.equal(late.cost, .00044);
    assert.equal(f.state.gemini.disabled, undefined); assert.equal(f.state.gemini.recoveryAt, null);
});

test('a stalled persistence callback cannot delay the execution timeout or reopen single flight', async t => {
    let finishPersistence;
    const f = await fixture(t, { fetch: async () => response(completion()), onEvent: type => {
        if (type === 'provider_drained') return new Promise(resolve => { finishPersistence = resolve; });
    } });
    const pending = f.provider.predict('gemini', snapshot()); await flush();
    t.mock.timers.tick(4600);
    assert.equal((await pending).status, 'decision_timeout');
    assert.equal((await f.provider.predict('gemini', snapshot({ snapshotId: 'cannot-overlap' }))).status, 'provider_busy');
    finishPersistence(); await flush();
    assert.equal(f.provider.active.size, 0);
    assert.equal(f.events.find(event => event.type === 'provider_late_response').executable, false);
});

test('120-second diagnostic timeout waits for local abort then recovers after persisted cooldown and preflight', async t => {
    const f = await fixture(t, { fetch: async (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) }), pending = f.provider.predict('gemini', snapshot());
    await flush(); t.mock.timers.tick(4600); assert.equal((await pending).status, 'decision_timeout');
    t.mock.timers.tick(115399); assert.equal(f.state.gemini.disabled, undefined); assert.equal(f.signal.aborted, false);
    t.mock.timers.tick(1); assert.equal(f.signal.aborted, true);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_busy');
    await flush();
    assert.equal(f.state.gemini.disabled, undefined); assert.equal(f.state.gemini.pending, null);
    assert.equal(f.provider.active.size, 0); assert.equal(f.state.gemini.recoveryAt, start + 240000);
    assert.equal(f.state.gemini.recoveryReason, 'inference_drain_timeout');
    const cooldown = f.events.find(event => event.type === 'provider_cooldown');
    assert.equal(cooldown.cost, null); assert.equal(cooldown.upstreamCancellationConfirmed, false);
    assert.equal((await f.provider.preflight()).reason, 'provider_cooldown');
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_cooldown');
    t.mock.timers.tick(120000);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'preflight_unavailable');
    assert.equal((await f.provider.preflight()).ready, true);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'snapshot_already_attempted');
    f.provider.fetch = async () => response(completion());
    const fresh = snapshot({ snapshotId: 'after-cooldown', at: Date.now(), observedAt: Date.now(),
        validation: { at: Date.now() }, marketEnd: Date.now() + 90000 });
    assert.equal((await f.provider.predict('gemini', fresh)).status, 'ok');
    assert.equal(f.inferenceCalls.length, 1);
});

test('an unacknowledged local abort keeps single flight even after cooldown expires', async t => {
    const f = await fixture(t), pending = f.provider.predict('gemini', snapshot());
    await flush(); t.mock.timers.tick(240000); await pending;
    assert.equal(f.provider.active.size, 1); assert.ok(f.state.gemini.pending);
    assert.equal((await f.provider.preflight()).reason, 'provider_busy');
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_busy');
    f.resolve(); await flush();
    const late = f.events.find(event => event.type === 'provider_late_response');
    assert.equal(late.executable, false); assert.equal(late.latencyMs, 240000);
    assert.equal(f.provider.active.size, 0); assert.equal(f.state.gemini.disabled, undefined);
    t.mock.timers.tick(120000); assert.equal((await f.provider.preflight()).ready, true);
});

test('disallowed BUY and malformed outputs fail closed without using confidence as outcome probability', async t => {
    let content = '{"action":"BUY_DOWN","confidence":0.9}';
    const f = await fixture(t, { fetch: async () => response(completion({ choices: [{ finish_reason: 'stop', message: { content } }] })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'rejected'); assert.equal(row.action, 'SKIP'); assert.equal(row.reason, 'disallowed_action');
    assert.equal(row.confidence, .9); assert.equal(row.confidenceKind, 'decision_confidence_not_outcome_probability');
    assert.equal(row.winProbability, undefined);
    for (const invalid of ['not json', '{"action":"BUY_UP","probability":0.9}',
        '{"action":"BUY_UP","reasonCode":"secret text"}', '{"action":"BUY_UP","confidence":1.1}']) {
        content = invalid;
        const snap = snapshot(); snap.snapshotId = invalid; snap.informed.snapshotId = invalid;
        const result = await f.provider.predict('gemini', snap);
        assert.equal(result.status, 'provider_error'); assert.equal(result.reason, 'invalid_response'); assert.equal(result.action, 'SKIP');
    }
});

test('model fallback holds the provider until the route is verified again without exposing raw response data', async t => {
    const f = await fixture(t, { fetch: async () => response(completion({ model: 'cx/gpt6luna', debug: config.routerKey })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'provider_error'); assert.equal(row.reason, 'model_mismatch'); assert.equal(row.model, null);
    assert.equal(f.state.gemini.disabled, 'model_mismatch'); assert.equal(f.provider.getHealth().ready, false);
    assert.equal(JSON.stringify({ row, events: f.events }).includes(config.routerKey), false);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'model_mismatch');
    assert.equal(f.inferenceCalls.length, 1);
    f.provider.pin = () => 'ag/gemini-3.8-flash-medium';
    assert.equal((await f.provider.preflight()).reason, 'router_pin_changed');
    assert.equal(f.state.gemini.disabled, 'model_mismatch');
    f.provider.pin = () => GEMINI_ROUTE_MODEL;
    assert.equal((await f.provider.preflight()).ready, true); assert.equal(f.state.gemini.disabled, null);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'snapshot_already_attempted');
});

test('the observed upstream modelVersion is accepted only as an exact response identity', async t => {
    let model = 'gemini-3.8-flash-n';
    const f = await fixture(t, { fetch: async () => response(completion({ model })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'ok'); assert.equal(row.model, 'gemini-3.8-flash-n');
    assert.equal(row.requestedModel, GEMINI_MODEL);
    model = 'gemini-3.8-flash-other';
    const snap = snapshot(); snap.snapshotId = snap.informed.snapshotId = 'snapshot-other';
    const rejected = await f.provider.predict('gemini', snap);
    assert.equal(rejected.reason, 'model_mismatch'); assert.equal(f.state.gemini.disabled, 'model_mismatch');
});

test('transport uncertainty enters cooldown while pending persistence failure remains a hard hold', async t => {
    const f = await fixture(t, { fetch: async () => { throw new Error(config.routerKey); } });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.reason, 'inference_transport_uncertain'); assert.equal(f.state.gemini.disabled, undefined);
    assert.equal(f.state.gemini.recoveryReason, 'inference_transport_uncertain');
    assert.equal(f.state.gemini.recoveryAt, start + 120000); assert.equal(f.state.gemini.pending, null);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_cooldown');
    assert.equal(JSON.stringify(row).includes(config.routerKey), false); assert.equal(f.inferenceCalls.length, 1);
    const p = new GeminiPaperProvider(config, {}, type => { if (type === 'provider_pending') throw new Error('fsync_failed'); },
        { pin: () => GEMINI_ROUTE_MODEL, fetch: async () => response({ data: [{ id: GEMINI_MODEL }] }) });
    t.after(() => p.close()); await p.preflight();
    const rejected = await p.predict('gemini', snapshot());
    assert.equal(rejected.status, 'provider_persistence_failed'); assert.equal(rejected.requestSubmitted, false);
    assert.ok(p.state.gemini.pending); assert.equal(p.state.gemini.disabled, 'provider_persistence_failed');
    assert.equal((await p.preflight()).ready, false);
});

test('transport recovery requires cooldown, successful preflight and a fresh snapshot', async t => {
    let healthy = false;
    const f = await fixture(t, { fetch: async () => {
        if (!healthy) throw new Error('socket closed');
        return response(completion());
    } });
    assert.equal((await f.provider.predict('gemini', snapshot())).reason, 'inference_transport_uncertain');
    t.mock.timers.tick(120000);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'preflight_unavailable');
    assert.equal((await f.provider.preflight()).ready, true); healthy = true;
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'snapshot_already_attempted');
    const fresh = snapshot({ snapshotId: 'transport-recovered', at: Date.now(), observedAt: Date.now(),
        validation: { at: Date.now() }, marketEnd: Date.now() + 90000 });
    assert.equal((await f.provider.predict('gemini', fresh)).status, 'ok'); assert.equal(f.inferenceCalls.length, 2);
});

test('input hash mismatch cannot submit HTTP', async t => {
    const f = await fixture(t), snap = snapshot(); snap.informed.input += ' ';
    assert.equal((await f.provider.predict('gemini', snap)).status, 'snapshot_identity_invalid');
    const changedAllowed = snapshot();
    changedAllowed.informed.input = JSON.stringify({ allowed: ['BUY_DOWN'] });
    changedAllowed.informed.inputHash = hash(changedAllowed.informed.input);
    assert.equal((await f.provider.predict('gemini', changedAllowed)).status, 'snapshot_identity_invalid');
    assert.equal(f.inferenceCalls.length, 0);
});

test('persisted restart cooldown admits only new snapshots after verified recovery', async t => {
    const f = await fixture(t, { state: { gemini: { pending: null, recoveryAt: start + 120000,
        recoveryReason: 'restart_with_unknown_inference', attempted: { 'snapshot-a': start - 1000 } } } });
    assert.equal(f.provider.getHealth().reason, 'provider_cooldown'); assert.equal(f.calls.length, 0);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_cooldown');
    t.mock.timers.tick(120000);
    assert.equal((await f.provider.preflight()).ready, true);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'snapshot_already_attempted');
    const fresh = snapshot({ snapshotId: 'snapshot-after-restart', at: Date.now(), observedAt: Date.now(),
        validation: { at: Date.now() }, marketEnd: Date.now() + 90000 });
    const pending = f.provider.predict('gemini', fresh); await flush(); f.resolve();
    assert.equal((await pending).status, 'ok'); assert.equal(f.inferenceCalls.length, 1);
});

test('HTTP rejection is never retried and billing uses only explicitly configured rates', async t => {
    let reject = true;
    const f = await fixture(t, { config: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        fetch: async () => reject ? new Response(config.routerKey, { status: 429 }) : response(completion()) });
    const rejected = await f.provider.predict('gemini', snapshot());
    assert.equal(rejected.httpStatus, 429); assert.equal(rejected.action, 'SKIP'); assert.equal(f.inferenceCalls.length, 1);
    reject = false;
    const snap = snapshot(); snap.snapshotId = snap.informed.snapshotId = 'snapshot-b';
    const row = await f.provider.predict('gemini', snap);
    assert.equal(row.cost, .00044); assert.equal(row.costBasis, 'configured_rates');
    assert.equal(f.inferenceCalls.length, 2);
});

test('oversized response bodies cannot be treated as decisions', async t => {
    const f = await fixture(t, { fetch: async () => new Response('x'.repeat(65537)) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'provider_error'); assert.equal(row.reason, 'response_too_large');
    assert.equal(row.action, 'SKIP'); assert.equal(f.inferenceCalls.length, 1);
});

test('closing during inference preserves unknown work for restart and prevents late execution', async t => {
    const f = await fixture(t), pending = f.provider.predict('gemini', snapshot());
    await flush(); f.provider.close();
    const row = await pending;
    assert.equal(row.status, 'provider_closed'); assert.equal(row.executable, false);
    assert.equal(row.inputHash, snapshot().informed.inputHash); assert.equal(row.promptHash, GEMINI_PROMPT_SHA256);
    assert.ok(f.state.gemini.pending); assert.equal(f.state.gemini.disabled, undefined);
    assert.equal(f.state.gemini.recoveryReason, 'closed_with_unknown_inference');
    assert.equal(f.state.gemini.recoveryAt, start + 120000);
    assert.equal(f.signal.aborted, true);
    f.resolve(); await flush();
    assert.equal(f.events.find(event => event.type === 'provider_late_response').executable, false);
    assert.equal(f.state.gemini.disabled, undefined); assert.equal(f.inferenceCalls.length, 1);
});

test('alias identity is checked before submission and again before accepting a response', async t => {
    let pin = GEMINI_ROUTE_MODEL;
    const f = await fixture(t, { pin: () => pin, onEvent: type => {
        if (type === 'provider_pending') pin = 'ag/gemini-3.8-flash-medium';
    } });
    const held = await f.provider.predict('gemini', snapshot());
    assert.equal(held.status, 'router_pin_changed'); assert.equal(held.requestSubmitted, false);
    assert.equal(f.inferenceCalls.length, 0);
    pin = GEMINI_ROUTE_MODEL; assert.equal((await f.provider.preflight()).ready, true);
    f.provider.onEvent = async (type, detail) => f.events.push({ type, ...detail });
    const pending = f.provider.predict('gemini', snapshot({ snapshotId: 'alias-changed-mid-request' })); await flush();
    pin = 'ag/gemini-3.8-flash-medium'; f.resolve(completion({ model: 'gemini-3.8-flash-n' }));
    const row = await pending;
    assert.equal(row.reason, 'router_pin_changed'); assert.equal(row.action, 'SKIP'); assert.equal(row.executable, false);
    assert.equal(f.state.gemini.disabled, 'router_pin_changed');
});

test('pin read failures are sanitized and cannot grant readiness from catalog alone', async t => {
    const f = await fixture(t, { pin: () => { throw new Error(config.routerKey); } });
    assert.equal(f.provider.getHealth().reason, 'router_pin_changed'); assert.equal(f.calls.length, 0);
    assert.equal(JSON.stringify(f.events).includes(config.routerKey), false);
});

test('stream timing separates persistence, headers, reasoning, content and completion without retaining reasoning', async t => {
    let controller, settled = false;
    const f = await fixture(t, { onEvent: type => { if (type === 'provider_pending') t.mock.timers.tick(70); },
        fetch: async () => streamResponse(new ReadableStream({ start(value) { controller = value; } })) });
    const pending = f.provider.predict('gemini', snapshot()); pending.then(() => { settled = true; }); await flush();
    const send = row => controller.enqueue(Buffer.from(sse(row)));
    t.mock.timers.tick(200); send(streamChunk({ role: 'assistant' })); await flush();
    t.mock.timers.tick(300); send(streamChunk({ reasoning_content: 'private-reasoning-do-not-record' })); await flush();
    t.mock.timers.tick(500); send(streamChunk({ content: '{"action":"BUY_' })); await flush();
    t.mock.timers.tick(50); send(streamChunk({ content: 'UP"}' }, 'stop', { usage: completion().usage })); await flush();
    assert.equal(settled, false); assert.equal(f.provider.active.size, 1);
    t.mock.timers.tick(50); controller.close(); const row = await pending;
    assert.equal(row.status, 'ok'); assert.equal(row.transport, 'sse'); assert.equal(row.action, 'BUY_UP');
    assert.equal(row.submittedAt, start + 70); assert.equal(row.latencyMs, 1170);
    assert.deepEqual(row.transportTimingMs, { localPreparation: 70, responseHeaders: 0, firstByte: 200,
        firstReasoning: 500, firstContent: 1000, finish: 1050, bodyComplete: 1100, contentToComplete: 100, routerQueue: null });
    assert.equal(row.usage.total_tokens, 420); assert.ok(row.responseBytes > 0);
    assert.equal(JSON.stringify({ row, events: f.events, state: f.state }).includes('private-reasoning'), false);
});

test('SSE accepts split CRLF, split UTF-8 comments, usage trailers and optional DONE only after stop', async t => {
    const wire = Buffer.from(': caf\u00e9\r\n\r\n' + sse(streamChunk({ content: '{"action":"SKIP"}' }, 'stop'))
        + sse(streamChunk({}, null, { choices: [], usage: completion().usage })) + sse('[DONE]'));
    const f = await fixture(t, { fetch: async () => streamResponse(new ReadableStream({ start(controller) {
        for (const byte of wire) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'ok'); assert.equal(row.action, 'SKIP'); assert.equal(row.usage.total_tokens, 420);
    assert.equal(row.responseBytes, wire.length);
});

test('a complete action and stop cannot execute until EOF, and delayed EOF is diagnostics only', async t => {
    let controller;
    const f = await fixture(t, { fetch: async () => streamResponse(new ReadableStream({ start(value) { controller = value; } })) });
    const pending = f.provider.predict('gemini', snapshot()); await flush();
    t.mock.timers.tick(1000); controller.enqueue(Buffer.from(sse(streamChunk({ content: '{"action":"BUY_UP"}' }, 'stop'))));
    await flush(); t.mock.timers.tick(3600);
    const row = await pending;
    assert.equal(row.status, 'decision_timeout'); assert.equal(row.action, 'SKIP');
    assert.equal(row.transportTimingMs.finish, 1000); assert.equal(row.transportTimingMs.bodyComplete, null);
    assert.equal((await f.provider.predict('gemini', snapshot())).status, 'provider_busy');
    t.mock.timers.tick(400); controller.close(); await flush();
    const late = f.events.find(event => event.type === 'provider_late_response');
    assert.equal(late.action, 'BUY_UP'); assert.equal(late.executable, false);
    assert.equal(late.transportTimingMs.bodyComplete, 5000); assert.equal(f.provider.active.size, 0);
    assert.equal(row.transportTimingMs.bodyComplete, null);
});

test('a stalled SSE body drains under the existing hard timeout and persisted cooldown', async t => {
    const f = await fixture(t, { fetch: async (url, init) => streamResponse(new ReadableStream({ start(controller) {
        controller.enqueue(Buffer.from(sse(streamChunk({ role: 'assistant' }))));
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } })) });
    const pending = f.provider.predict('gemini', snapshot()); await flush(); t.mock.timers.tick(4600);
    assert.equal((await pending).status, 'decision_timeout'); assert.equal(f.provider.active.size, 1);
    t.mock.timers.tick(115400); await flush();
    assert.equal(f.signal.aborted, true); assert.equal(f.provider.active.size, 0);
    assert.equal(f.state.gemini.recoveryReason, 'inference_drain_timeout');
    assert.equal(f.events.find(event => event.type === 'provider_drain_error').executable, false);
});

test('an endless SSE producer is cancelled at the byte bound and held for uncertain upstream work', async t => {
    let cancelled = false, pulls = 0;
    const f = await fixture(t, { fetch: async () => streamResponse(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(Buffer.from(': ' + 'x'.repeat(4096) + '\n\n')); },
        cancel() { cancelled = true; },
    })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.reason, 'response_too_large'); assert.equal(row.action, 'SKIP');
    assert.equal(cancelled, true); assert.ok(pulls < 20);
    assert.equal(f.state.gemini.recoveryReason, 'inference_transport_uncertain');
    assert.equal((await f.provider.predict('gemini', snapshot({ snapshotId: 'overlap' }))).status, 'provider_cooldown');
});

test('an oversized declared SSE body is cancelled and held before any content is read', async t => {
    let cancelled = false;
    const f = await fixture(t, { fetch: async () => new Response(new ReadableStream({
        start() {}, cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream', 'Content-Length': '65537' } }) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.reason, 'response_too_large'); assert.equal(row.action, 'SKIP');
    assert.equal(cancelled, true); assert.equal(row.responseBytes, 0);
    assert.equal(f.state.gemini.recoveryReason, 'inference_transport_uncertain');
    assert.equal((await f.provider.predict('gemini', snapshot({ snapshotId: 'overlap' }))).status, 'provider_cooldown');
});

test('an oversized JSON fallback also retains cooldown for uncertain upstream work', async t => {
    let cancelled = false;
    const f = await fixture(t, { fetch: async () => new Response(new ReadableStream({
        start() {}, cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.reason, 'response_too_large'); assert.equal(row.action, 'SKIP');
    assert.equal(cancelled, true);
    assert.equal(f.state.gemini.recoveryReason, 'inference_transport_uncertain');
});

test('stream completion rechecks the alias pin before accepting the matching upstream identity', async t => {
    let pin = GEMINI_ROUTE_MODEL;
    const f = await fixture(t, { pin: () => pin, fetch: async () => streamResponse(new ReadableStream({
        start(controller) {
            controller.enqueue(Buffer.from(sse(streamChunk(validStreamContent, 'stop'))));
            pin = 'ag/gemini-3.8-flash-medium'; controller.close();
        },
    })) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.reason, 'router_pin_changed'); assert.equal(row.executable, false);
    assert.equal(f.state.gemini.disabled, 'router_pin_changed'); assert.equal(f.inferenceCalls.length, 1);
});

const validStreamContent = { content: '{"action":"BUY_UP"}' };
for (const [name, wire, reason = 'invalid_response'] of [
    ['missing stop', sse(streamChunk(validStreamContent))],
    ['truncated event', sse(streamChunk(validStreamContent, 'stop')).slice(0, -2)],
    ['missing action', sse(streamChunk({ content: '{}' }, 'stop'))],
    ['unknown model', sse(streamChunk(validStreamContent, 'stop', { model: 'other' })), 'model_mismatch'],
    ['changed model', sse(streamChunk({ role: 'assistant' }))
        + sse(streamChunk(validStreamContent, 'stop', { model: 'gemini-3.8-flash-low' })), 'model_mismatch'],
    ['changed id', sse(streamChunk({ role: 'assistant' })) + sse(streamChunk(validStreamContent, 'stop', { id: 'changed' }))],
    ['multiple choices', sse(streamChunk({}, null, { choices: [
        { index: 0, delta: validStreamContent, finish_reason: 'stop' }, { index: 1, delta: {}, finish_reason: 'stop' }] }))],
    ['tool call', sse(streamChunk({ ...validStreamContent, tool_calls: [] }, 'stop'))],
    ['refusal', sse(streamChunk({ ...validStreamContent, refusal: 'refused' }, 'stop'))],
    ['length finish', sse(streamChunk(validStreamContent, 'length'))],
    ['early DONE', sse('[DONE]')],
    ['content after stop', sse(streamChunk(validStreamContent, 'stop')) + sse(streamChunk({ content: ' ' }))],
    ['error after stop', sse(streamChunk(validStreamContent, 'stop')) + sse({ error: { message: config.routerKey } })],
    ['invalid UTF-8', Buffer.concat([Buffer.from(sse(streamChunk(validStreamContent, 'stop'))), Buffer.from([0xff])])],
    ['excessive body', ': ' + 'x'.repeat(65537), 'response_too_large'],
    ['excessive content', sse(streamChunk({ content: 'x'.repeat(1025) }, 'stop')), 'response_too_large'],
]) test('stream rejects ' + name + ' without admitting a decision or leaking raw data', async t => {
    const f = await fixture(t, { fetch: async () => streamResponse(wire) });
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.status, 'provider_error'); assert.equal(row.reason, reason); assert.equal(row.executable, false);
    assert.equal(row.action, 'SKIP'); assert.equal(f.inferenceCalls.length, 1);
    assert.equal(JSON.stringify({ row, events: f.events }).includes(config.routerKey), false);
});

test('preflight and cooldown persistence failures hold future submissions', async t => {
    let failedEvent = 'provider_preflight';
    const f = await fixture(t, { onEvent: type => { if (type === failedEvent) throw new Error(config.routerKey); } });
    assert.equal(f.provider.getHealth().ready, false); assert.equal(f.state.gemini.disabled, 'provider_persistence_failed');
    assert.equal((await f.provider.predict('gemini', snapshot())).requestSubmitted, false);
    failedEvent = 'provider_cooldown'; f.state.gemini.disabled = null;
    assert.equal((await f.provider.preflight()).ready, true);
    f.provider.fetch = async () => { throw new Error('transport failure'); };
    const row = await f.provider.predict('gemini', snapshot());
    assert.equal(row.executable, false); assert.equal(f.state.gemini.disabled, 'provider_persistence_failed');
    assert.equal((await f.provider.preflight()).ready, false);
});
