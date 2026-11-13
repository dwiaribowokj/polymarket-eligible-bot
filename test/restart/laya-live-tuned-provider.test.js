import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LayaLiveProvider } from '../../src/laya-live/provider.js';
import { decisionProtocolView } from '../../src/laya-live/decision-protocol.js';
import { buildProtocolRequest } from '../../src/laya-tuning/protocol.js';
import { QUESTIONS as ORIGINAL_QUESTIONS } from '../../src/ai-shadow/config.js';

const IDENTITY = 'pinned-typed-decisions-artifact';
const START = 1792200000000;
const digest = value => createHash('sha256').update(value).digest('hex');
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function snapshot(allowed = ['BUY_UP'], snapshotId = 'tuned-live-snapshot') {
    const input = ` ${JSON.stringify({ seconds: 60, open_usd: 84000, delta_cents: [25, 20], margin_cents: 20,
        sigma_milliusd: 1200, ret_millibps: [12, 5, -2, 3, 9], bars_cents: [[0, 30, -5, 25]],
        up: [[[54.25, 3.5]], [[55, 9]]], down: 'mirror_up', fee: [0.25, 2], shares: 5, cap_usd: 4,
        limit_cost_up_down: [[56, 2.9], null], allowed })}\n`;
    return { snapshotId, input, inputHash: digest(input), state: { future: 'forbidden-snapshot-state' },
        outcome: 'forbidden-future-outcome' };
}
// Shape returned by the installed System One endpoint: a generic agent wrapper,
// a typed-decisions route, rounded probabilities, and two confidence metrics.
function answer(choice = 'BUY_UP') {
    return { model: 'laya-rl-agent', routing: { model: 'typed-decisions' }, usage: { input_tokens: 500, output_tokens: 1 },
        answers: { action: { choice, probabilities: { BUY_UP: 0.6, BUY_DOWN: 0.15, SKIP: 0.25 },
            answer_confidence: 0.6, confidence: 0.1823 } } };
}
const response = raw => ({ ok: true, status: 200, json: async () => raw });

function fixture(t, overrides = {}) {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_tuned_provider_fixture'); });
    const state = { laya: { tokenizerIdentity: IDENTITY } }, events = [];
    const counter = { start: t.mock.fn(async () => ({ maxTokens: 1024, identity: IDENTITY })),
        count: t.mock.fn(async () => ({ valid: true, tokens: 500, identity: IDENTITY })), close: t.mock.fn() };
    const fetch = t.mock.fn(async () => response(answer()));
    const config = { layaUrl: 'http://offline-tuned-fixture/private-path', decisionMs: 3000, layaDrainMs: 30000,
        decisionProtocol: decisionProtocolView() };
    const provider = new LayaLiveProvider(config, state, (type, detail) => events.push({ type, detail }),
        { counter, fetch, ...overrides });
    t.after(() => provider.close());
    return { provider, counter, fetch, config, state, events };
}

test('LIVE candidate-v2 has a stable input-independent identity and rejects a different configured protocol', t => {
    const expected = { protocolVersion: 'laya-tuning-protocol-v1', variantId: 'candidate-v2',
        promptVersion: 'allowed-actions-compact-v2',
        promptHash: '98c43812443f60b5d62c152dd255b3eabcbdd97ffd875a2f16edc3da618559dd',
        questionsHash: 'b7930c7e5ae2b88db0e70f868b1ad87a945976f358b3a44661efbedc3fec2e0c' };
    assert.deepEqual(decisionProtocolView(), expected);
    decisionProtocolView().variantId = 'baseline-v1';
    assert.deepEqual(decisionProtocolView(), expected);
    const f = fixture(t);
    for (const key of Object.keys(expected)) assert.throws(() => new LayaLiveProvider({ ...f.config,
        decisionProtocol: { ...expected, [key]: 'other' } }, {}, () => {}, { counter: f.counter, fetch: f.fetch }),
    /live_decision_protocol_mismatch/);
    assert.throws(() => new LayaLiveProvider({ ...f.config, decisionProtocol: null }, {}), /live_decision_protocol_mismatch/);
    assert.equal(f.counter.start.mock.callCount(), 0);
    assert.equal(f.fetch.mock.callCount(), 0);
});

test('LIVE counts and sends the exact compact candidate request and retains raw choice/confidence evidence', async t => {
    const f = fixture(t), s = snapshot(), protocol = buildProtocolRequest(s, { variantId: 'candidate-v2' });
    f.counter.count.mock.mockImplementation(async function(input, questions) {
        assert.equal(this, f.counter);
        assert.equal(f.state.laya.pending.snapshotId, s.snapshotId);
        assert.equal(f.events[0].type, 'provider_pending');
        assert.equal(input, s.input);
        assert.deepEqual(questions, protocol.request.questions);
        assert.notDeepEqual(questions, ORIGINAL_QUESTIONS);
        return { valid: true, tokens: 500, identity: IDENTITY };
    });
    f.fetch.mock.mockImplementation(async function(url, init) {
        assert.equal(this, f.provider);
        assert.equal(url, f.config.layaUrl + '/v1/systemone');
        assert.equal(init.method, 'POST');
        assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.body, JSON.stringify(protocol.request));
        assert.equal(digest(init.body), protocol.requestHash);
        for (const secret of ['forbidden-snapshot-state', 'forbidden-future-outcome']) assert.equal(init.body.includes(secret), false);
        return response({ ...answer(), timing: { private: 'forbidden-remote-timing' },
            requestedAt: 1, receivedAt: 2, latencyMs: 1 });
    });
    const decision = await f.provider.predict('laya', s);
    assert.equal(decision.status, 'ok');
    assert.equal(decision.action, 'BUY_UP');
    assert.equal(decision.originalAction, 'BUY_UP');
    assert.equal(decision.executable, true);
    assert.equal(decision.model, 'typed-decisions');
    assert.equal(decision.backendModel, 'laya-rl-agent');
    assert.equal(decision.answerConfidence, 0.6);
    assert.equal(decision.entropyConfidence, 0.1823);
    assert.equal(decision.confidence, 0.6);
    assert.equal(decision.probabilityType, 'action_choice_distribution');
    assert.deepEqual(decision.probabilities, answer().answers.action.probabilities);
    assert.deepEqual(decision.context, { valid: true, verified: true, tokens: 500, maxTokens: 1024, identity: IDENTITY,
        snapshotId: s.snapshotId, inputHash: s.inputHash, promptHash: protocol.promptHash,
        questionsHash: protocol.questionsHash, requestHash: protocol.requestHash });
    for (const [key, value] of Object.entries(decisionProtocolView())) assert.equal(decision[key], value);
    assert.equal(decision.inputHash, s.inputHash);
    assert.equal(decision.requestHash, protocol.requestHash);
    assert.ok(Number.isFinite(decision.requestedAt));
    assert.equal(decision.receivedAt, decision.requestedAt + decision.latencyMs);
    assert.equal(decision.cost, 0);
    assert.equal(f.counter.count.mock.callCount(), 1);
    assert.equal(f.fetch.mock.callCount(), 1);
    assert.equal(f.state.laya.pending, null);
    assert.deepEqual(f.events.map(event => event.type), ['provider_pending', 'provider_drained']);
    for (const event of f.events) assert.equal(event.detail.requestHash, protocol.requestHash);
    const serialized = JSON.stringify({ decision, events: f.events });
    for (const secret of [s.input, 'forbidden-snapshot-state', 'forbidden-future-outcome', 'forbidden-remote-timing', 'private-path'])
        assert.equal(serialized.includes(secret), false);
});

test('a forbidden raw BUY becomes a rejected SKIP while retaining the original choice and probabilities', async t => {
    const f = fixture(t);
    for (const [allowed, choice] of [[['BUY_UP'], 'BUY_DOWN'], [['BUY_DOWN'], 'BUY_UP'], [[], 'BUY_UP']]) {
        f.fetch.mock.mockImplementation(async () => response(answer(choice)));
        const decision = await f.provider.predict('laya', snapshot(allowed));
        assert.equal(decision.status, 'rejected');
        assert.equal(decision.reason, 'disallowed_action');
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.originalAction, choice);
        assert.equal(decision.executable, false);
        assert.deepEqual(decision.probabilities, answer().answers.action.probabilities);
        assert.equal(decision.answerConfidence, 0.6);
        assert.equal(f.state.laya.disabled, undefined);
    }
    assert.equal(f.fetch.mock.callCount(), 3);
});

test('the parser keeps the actual typed choice instead of selecting the probability maximum', async t => {
    const f = fixture(t);
    for (const choice of ['BUY_DOWN', 'SKIP']) {
        f.fetch.mock.mockImplementation(async () => response(answer(choice)));
        const decision = await f.provider.predict('laya', snapshot(['BUY_UP', 'BUY_DOWN']));
        assert.equal(decision.status, 'ok');
        assert.equal(decision.action, choice);
        assert.equal(decision.executable, choice !== 'SKIP');
        assert.equal(decision.probabilities.BUY_UP, 0.6);
    }
});

test('strict parser/usage failures never create an entry or retry and retain auditable original choices', async t => {
    for (const fault of ['missing-probabilities', 'probability-sum', 'confidence', 'choice', 'input-hash',
        'missing-usage', 'usage-mismatch', 'usage-invalid']) await t.test(fault, async t => {
        const f = fixture(t), raw = answer();
        if (fault === 'missing-probabilities') delete raw.answers.action.probabilities;
        if (fault === 'probability-sum') raw.answers.action.probabilities.SKIP = 0.4;
        if (fault === 'confidence') raw.answers.action.confidence = '0.5';
        if (fault === 'choice') raw.answers.action.choice = 'BUY_ANY';
        if (fault === 'input-hash') raw.inputHash = 'wrong-input';
        if (fault === 'missing-usage') delete raw.usage;
        if (fault === 'usage-mismatch') raw.usage.input_tokens = 499;
        if (fault === 'usage-invalid') raw.usage.output_tokens = -1;
        f.fetch.mock.mockImplementation(async () => response(raw));
        const decision = await f.provider.predict('laya', snapshot());
        assert.equal(decision.status, 'invalid');
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.executable, false);
        assert.equal(decision.originalAction, fault === 'choice' ? 'BUY_ANY' : 'BUY_UP');
        if (fault.startsWith('usage-') || fault === 'missing-usage')
            assert.deepEqual(decision.probabilities, answer().answers.action.probabilities);
        assert.equal(f.fetch.mock.callCount(), 1);
        assert.equal(f.state.laya.pending, null);
        assert.equal(f.state.laya.disabled, undefined);
    });
});

test('model substitution disables the provider while preserving parser rejection evidence', async t => {
    for (const fault of ['route', 'wrapper', 'missing-route']) await t.test(fault, async t => {
        const f = fixture(t), raw = answer();
        if (fault === 'route') raw.routing.model = 'other-checkpoint';
        if (fault === 'wrapper') raw.model = 'other-agent';
        if (fault === 'missing-route') delete raw.routing;
        f.fetch.mock.mockImplementation(async () => response(raw));
        const decision = await f.provider.predict('laya', snapshot());
        assert.equal(decision.status, 'provider_error');
        assert.equal(decision.reason, 'model_mismatch');
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.originalAction, 'BUY_UP');
        assert.equal(f.state.laya.disabled, 'model_mismatch');
        assert.equal(f.fetch.mock.callCount(), 1);
    });
});

test('unverified exact input or candidate context never reaches inference', async t => {
    for (const fault of ['missing-input-hash', 'altered-input', 'extra-input-key', 'tokens', 'identity', 'context-limit',
        'truncated', 'invalid']) await t.test(fault, async t => {
        const f = fixture(t), s = snapshot();
        if (fault === 'missing-input-hash') delete s.inputHash;
        if (fault === 'altered-input') s.input += ' ';
        if (fault === 'extra-input-key') {
            s.input = JSON.stringify({ ...JSON.parse(s.input), future_outcome: 'UP' }); s.inputHash = digest(s.input);
        }
        const overrides = { ...(fault === 'tokens' ? { tokens: 1025 } : {}),
            ...(fault === 'identity' ? { identity: 'replacement-artifact' } : {}),
            ...(fault === 'context-limit' ? { maxTokens: 2048 } : {}),
            ...(fault === 'truncated' ? { stateTruncated: true } : {}), ...(fault === 'invalid' ? { valid: false } : {}) };
        f.counter.count.mock.mockImplementation(async () => ({ valid: true, tokens: 500, identity: IDENTITY, ...overrides }));
        const decision = await f.provider.predict('laya', s);
        assert.ok(['invalid', 'provider_error'].includes(decision.status));
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.executable, false);
        assert.equal(f.fetch.mock.callCount(), 0);
        assert.equal(f.state.laya.pending ?? null, null);
        assert.equal(f.state.laya.disabled, undefined);
    });
});

test('preflight exposes actual candidate identity and pins the existing 1024-token model without inference', async t => {
    const f = fixture(t);
    f.fetch.mock.mockImplementation(async function(url) {
        assert.equal(this, f.provider);
        assert.equal(url, f.config.layaUrl + '/health');
        return response({ loaded: ['typed-decisions'] });
    });
    const result = await f.provider.preflight();
    assert.equal(result.laya.ready, true);
    assert.equal(result.laya.model, 'typed-decisions');
    assert.deepEqual(result.laya.decisionProtocol, decisionProtocolView());
    assert.deepEqual(f.events[0].detail.decisionProtocol, decisionProtocolView());
    assert.equal(f.counter.count.mock.callCount(), 0);
    assert.equal(f.fetch.mock.callCount(), 1);
    assert.equal(JSON.stringify(result).includes('protocol-metadata'), false);
    assert.equal(Object.hasOwn(result.laya.decisionProtocol, 'inputHash'), false);
    f.counter.start.mock.mockImplementation(async () => ({ maxTokens: 1024, identity: 'replacement-artifact' }));
    assert.equal((await f.provider.preflight()).laya.ready, false);
    assert.equal(f.state.laya.disabled, 'laya_artifact_changed');
});

test('tuned timeout keeps pending until its single late drain and isolates a busy second snapshot', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
    const request = deferred(), fetch = t.mock.fn(() => request.promise), f = fixture(t, { fetch });
    const first = snapshot(['BUY_DOWN'], 'first-snapshot'), second = snapshot(['BUY_UP'], 'second-snapshot');
    const pending = f.provider.predict('laya', first);
    await flush();
    t.mock.timers.tick(3000);
    const timedOut = await pending;
    assert.equal(timedOut.status, 'decision_timeout');
    assert.equal(timedOut.inputHash, first.inputHash);
    assert.equal(timedOut.requestHash, buildProtocolRequest(first, { variantId: 'candidate-v2' }).requestHash);
    assert.equal(timedOut.executable, false);
    assert.equal(f.provider.active.size, 1);
    assert.equal(f.state.laya.pending.snapshotId, first.snapshotId);
    const busy = await f.provider.predict('laya', second);
    assert.equal(busy.status, 'provider_busy');
    assert.equal(busy.inputHash, second.inputHash);
    assert.equal(f.counter.count.mock.callCount(), 1);
    assert.equal(fetch.mock.callCount(), 1);
    t.mock.timers.tick(1500);
    request.resolve(response(answer('BUY_UP')));
    await flush();
    const late = f.events.find(event => event.type === 'provider_late_response').detail;
    assert.equal(late.snapshotId, first.snapshotId);
    assert.equal(late.inputHash, first.inputHash);
    assert.equal(late.status, 'rejected');
    assert.equal(late.originalAction, 'BUY_UP');
    assert.equal(late.action, 'SKIP');
    assert.equal(late.latencyMs, 4500);
    assert.equal(f.state.laya.pending, null);
    assert.equal(f.provider.active.size, 0);
    assert.equal(f.state.laya.disabled, undefined);
    assert.equal(f.events.filter(event => event.type === 'provider_drained').length, 1);
});

test('tuned unresolved inference aborts at 30 seconds and never retries', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
    const request = deferred(); let signal;
    const fetch = t.mock.fn(async (_url, init) => {
        signal = init.signal;
        signal.addEventListener('abort', () => request.reject(new Error('private-abort-details')), { once: true });
        return request.promise;
    });
    const f = fixture(t, { fetch }), s = snapshot();
    const pending = f.provider.predict('laya', s); await flush();
    t.mock.timers.tick(3000); assert.equal((await pending).status, 'decision_timeout');
    t.mock.timers.tick(26999); await flush(); assert.equal(signal.aborted, false);
    t.mock.timers.tick(1); await flush();
    assert.equal(signal.aborted, true);
    assert.equal(f.state.laya.disabled, 'inference_unresolved');
    assert.equal(f.state.laya.pending, null);
    assert.equal(fetch.mock.callCount(), 1);
    const drained = f.events.find(event => event.type === 'provider_drain_error').detail;
    assert.equal(drained.inputHash, s.inputHash);
    assert.equal(drained.action, 'SKIP');
    assert.equal(drained.executable, false);
    assert.equal(JSON.stringify(f.events).includes('private-abort-details'), false);
});
