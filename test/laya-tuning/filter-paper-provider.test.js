import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { FilterPaperProvider } from '../../src/laya-filter-paper/provider.js';
import { ADAPTIVE_TIMEOUT_POLICY, decisionBudget } from '../../src/laya-filter-paper/decision-budget.js';
import { decisionProtocolView } from '../../src/laya-live/decision-protocol.js';

const start = 100000;
const config = { decisionTimeoutPolicy: ADAPTIVE_TIMEOUT_POLICY, decisionMs: 3000, dataAgeMs: 5000,
    latencyMs: 250, inferenceReserveMs: 150, layaDrainMs: 30000, late: { minSeconds: 10 },
    deadline: Number.MAX_SAFE_INTEGER, layaUrl: 'http://laya.invalid' };
const response = { ok: true, json: async () => ({ model: 'typed-decisions', answers: { action: { choice: 'BUY_UP' } } }) };
function snapshot(overrides = {}) {
    const row = { snapshotId: 'snapshot-a', input: '{}', at: start, observedAt: start,
        validation: { at: start }, marketEnd: start + 90000, ...overrides };
    row.decisionDeadlineAt = decisionBudget(config, row, start).decisionDeadlineAt;
    return row;
}
function fixture(t, { onEvent = () => {}, fetch: request } = {}) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
    const state = { laya: { tokenizerIdentity: 'tokenizer' } }, events = [];
    let resolve, calls = 0, signal;
    const provider = new FilterPaperProvider(config, state, (type, detail) => { events.push({ type, ...detail }); onEvent(type); }, {
        counter: { async count() { return { valid: true, identity: 'tokenizer' }; }, close() {} },
        fetch: async (...args) => {
            calls++; signal = args[1].signal;
            return request ? request(...args) : new Promise(r => { resolve = r; });
        },
    });
    t.after(() => provider.close());
    return { provider, state, events, resolve: () => resolve(response), get calls() { return calls; }, get signal() { return signal; } };
}

test('adaptive deadline uses original source, metadata, tick validation and market entry cutoff', () => {
    assert.equal(decisionBudget(config, snapshot({ observedAt: start - 1388 }), start).decisionBudgetMs, 3212);
    assert.equal(decisionBudget(config, snapshot({ validation: { at: start - 1200 } }), start).decisionBudgetMs, 3400);
    assert.equal(decisionBudget(config, snapshot({ validation: { at: start, tickVerifiedAt: start - 1500 } }), start).decisionBudgetMs, 3100);
    assert.equal(decisionBudget(config, snapshot({ marketEnd: start + 12000 }), start).decisionBudgetMs, 1600);
    for (const bad of [NaN, Infinity, start + 1, null]) {
        assert.throws(() => snapshot({ observedAt: bad }), /invalid_decision_budget/);
        assert.throws(() => snapshot({ validation: { at: bad, tickVerifiedAt: start - 1500 } }), /invalid_decision_budget/);
        assert.throws(() => snapshot({ validation: { at: start - 1500, tickVerifiedAt: bad } }), /invalid_decision_budget/);
    }
});

test('a 3500ms response is accepted with fresh input, without changing shared config', async t => {
    const f = fixture(t), pending = f.provider.predict('laya', snapshot());
    await flush(); t.mock.timers.tick(3500); f.resolve();
    const result = await pending;
    assert.equal(result.status, 'ok'); assert.equal(result.action, 'BUY_UP');
    assert.equal(result.latencyMs, 3500); assert.equal(result.decisionBudgetMs, 4600);
    assert.equal(result.decisionDeadlineAt, start + 4600); assert.equal(result.receivedAt, start + 3500);
    assert.equal(config.decisionMs, 3000); assert.equal(f.provider.config.decisionMs, 3000);
    assert.equal(f.state.laya.pending, null); assert.equal(f.calls, 1);
});

test('source or metadata age shortens timeout and late response is drained without reentry', async t => {
    const f = fixture(t), row = snapshot({ validation: { at: start - 1200 } });
    const pending = f.provider.predict('laya', row); await flush();
    t.mock.timers.tick(3400); const result = await pending;
    assert.equal(result.status, 'decision_timeout'); assert.equal(result.action, 'SKIP');
    assert.ok(f.state.laya.pending); assert.equal(f.provider.active.size, 1);
    assert.equal((await f.provider.predict('laya', { ...row, snapshotId: 'b' })).status, 'provider_busy');
    assert.equal(f.calls, 1);
    t.mock.timers.tick(100); f.resolve(); await flush();
    assert.equal(f.state.laya.pending, null);
    assert.equal(f.events.find(e => e.type === 'provider_late_response').latencyMs, 3500);
    assert.equal(result.status, 'decision_timeout');
});

test('pending persistence cannot extend the absolute timeout', async t => {
    const f = fixture(t, { onEvent(type) { if (type === 'provider_pending') t.mock.timers.tick(700); } });
    const pending = f.provider.predict('laya', snapshot({ observedAt: start - 1200 })); await flush();
    t.mock.timers.tick(2699); await flush(); assert.ok(f.state.laya.pending);
    t.mock.timers.tick(1); const result = await pending;
    assert.equal(result.status, 'decision_timeout'); assert.equal(Date.now(), start + 3400);
    f.resolve(); await flush();
});

test('event-loop delay cannot make an overdue decoded response executable', async t => {
    const f = fixture(t, { fetch: async () => ({ ok: true, json: async () => {
        t.mock.timers.setTime(start + 4601);
        return response.json();
    } }) });
    const result = await f.provider.predict('laya', snapshot());
    assert.equal(result.status, 'decision_timeout'); assert.equal(result.action, 'SKIP');
    assert.equal(result.reason, 'decision_deadline_exceeded'); assert.equal(result.actualLatencyMs, 4601);
});

test('budget spent in local persistence never sends an expired HTTP request or disables the provider', async t => {
    const f = fixture(t, { onEvent(type) { if (type === 'provider_pending') t.mock.timers.tick(4601); } });
    const result = await f.provider.predict('laya', snapshot());
    assert.equal(result.status, 'decision_budget_expired'); assert.equal(result.requestSubmitted, false);
    assert.equal(f.calls, 0); assert.equal(f.state.laya.disabled, undefined);
    assert.equal(f.state.laya.pending, null);
});

test('expired or modified deadlines never submit a request', async t => {
    const f = fixture(t), row = snapshot();
    assert.equal((await f.provider.predict('laya', { ...row, decisionDeadlineAt: row.decisionDeadlineAt + 1 })).status, 'invalid_decision_budget');
    t.mock.timers.tick(4600);
    assert.equal((await f.provider.predict('laya', row)).status, 'decision_budget_expired');
    assert.equal(f.calls, 0); assert.equal(f.state.laya.pending, undefined);
});

test('unresolved inference retains single flight and disables after the original 30 seconds', async t => {
    const f = fixture(t), pending = f.provider.predict('laya', snapshot()); await flush();
    t.mock.timers.tick(4600); assert.equal((await pending).status, 'decision_timeout');
    t.mock.timers.tick(25399); assert.equal(f.state.laya.disabled, undefined);
    t.mock.timers.tick(1); assert.equal(f.state.laya.disabled, 'inference_unresolved');
    assert.equal(f.signal.aborted, true); assert.equal(f.calls, 1);
    f.resolve(); await flush();
    assert.equal((await f.provider.predict('laya', snapshot())).status, 'inference_unresolved');
});

test('adaptive provider preserves the real candidate protocol, context validation and allowed actions', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
    const input = JSON.stringify({ allowed: ['BUY_UP'], seconds: 60 });
    const row = snapshot({ input, inputHash: createHash('sha256').update(input).digest('hex') });
    let choice = 'BUY_UP', responseAt = start + 3500;
    const provider = new FilterPaperProvider({ ...config, decisionProtocol: decisionProtocolView() },
        { laya: { tokenizerIdentity: 'tokenizer' } }, () => {}, {
            counter: { start: async () => ({ identity: 'tokenizer', maxTokens: 1024 }),
                count: async () => ({ valid: true, tokens: 500, identity: 'tokenizer' }), close() {} },
            fetch: async (url, init) => {
                const request = JSON.parse(init.body);
                assert.equal(request.state, input);
                assert.ok(request.questions.action.instructions.includes('BUY requires'));
                t.mock.timers.setTime(responseAt);
                return { ok: true, json: async () => ({ model: 'laya-rl-agent', routing: { model: 'typed-decisions' },
                    usage: { input_tokens: 500, output_tokens: 1 }, answers: { action: { choice,
                        probabilities: { BUY_UP: .6, BUY_DOWN: .15, SKIP: .25 }, answer_confidence: .6 } } }) };
            },
        });
    t.after(() => provider.close());
    const accepted = await provider.predict('laya', row);
    assert.equal(accepted.status, 'ok'); assert.equal(accepted.latencyMs, 3500);
    assert.equal(accepted.context.verified, true); assert.equal(accepted.variantId, 'candidate-v2');
    choice = 'BUY_DOWN';
    const rejected = await provider.predict('laya', row);
    assert.equal(rejected.status, 'rejected'); assert.equal(rejected.action, 'SKIP');
    assert.equal(rejected.reason, 'disallowed_action');
    choice = 'BUY_UP'; responseAt = start + 4601;
    const overdue = await provider.predict('laya', row);
    assert.equal(overdue.status, 'decision_timeout'); assert.equal(overdue.action, 'SKIP');
    assert.equal(overdue.executable, false);
});
