import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPremarketInput, normalizeRouterResponse, PremarketProviders, routerRequest,
    NEXT_ROUTER_OUTPUT_INSTRUCTIONS } from '../../src/premarket-paper/providers.js';
import { NEXT_PROFILE, NEXT_PREMARKET_PROMPT, NEXT_PREMARKET_QUESTIONS, NEXT_PREMARKET_PROMPT_VERSION,
    earlyPremarketFeatures, nextReversalSignal } from '../../src/premarket-paper/early-context.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY, NEXT_ROUTER_DIRECTIONAL_PROMPT, routerDirectionalPolicy,
    routerDirectionalPromptEvidence } from '../../src/premarket-paper/router-directional.js';

const open = Date.parse('2026-10-29T10:15:00Z'), at = open + 5000;
const hash = value => createHash('sha256').update(value).digest('hex');
const config = { profile: NEXT_PROFILE, paperOnly: true, routerPolicy: NEXT_ROUTER_DIRECTIONAL_POLICY,
    activeArms: ['premarket-momentum', 'laya-premarket', 'router-premarket'],
    candleCount: 30, candleIntervalMs: 300000, candleCacheMaxAgeMs: 90000, slotToleranceMs: 10000,
    signalParameters: { minimumPriorStreak: 3 }, aiDecisionMs: 30000, providerDrainMs: 1000,
    routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium',
    layaUrl: 'http://laya.example', ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'fixture' };
const evidence = { providerTask: 'next-candle-directional-forecast-confirmation-v1',
    providerPromptVersion: 'next-router-directional-v1', providerPromptHash: hash(NEXT_ROUTER_DIRECTIONAL_PROMPT) };

function snapshot(directions = [1, 1, 1, -1]) {
    const changes = [...Array(30 - directions.length).fill(0), ...directions];
    const market = { open, end: open + 300000 };
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: open - 9000000, windowEnd: open, expectedLatestClosedAt: open,
        observedAt: open + 1000, fetchedAt: open + 1000,
        bars: changes.map((direction, i) => {
            const value = 80000.003 + i * 2, close = value + direction;
            return { openAt: open - (30 - i) * 300000, closeAt: open - (29 - i) * 300000,
                open: value, high: Math.max(value, close) + .12, low: Math.min(value, close) - .17, close,
                observedAt: open + 1000 };
        }) };
    const features = earlyPremarketFeatures(history, market, at, config);
    const signal = nextReversalSignal(features, config.signalParameters);
    return { snapshotId: 'directional-fixture', at, aiDeadlineAt: at + 30000, market, features,
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 12 }] })),
        orders: Object.fromEntries(['BUY_UP', 'BUY_DOWN'].map(action => [action,
            action === signal.action ? { price: .51, shares: 5, cost: 2.68747001 } : null])) };
}

const answer = (overrides = {}) => ({ snapshotId: 'directional-fixture', forecastDirection: 'DOWN',
    forecastStrength: 'weak', action: 'BUY_DOWN', reasonCode: 'direction_matches_signal',
    rationale: 'The final candle falls $1 after three rising bodies, with a $0.12 upper wick.', ...overrides });
const rawResponse = (value = answer()) => ({ model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { prompt_tokens: 900, completion_tokens: 80 } });
const response = value => new Response(JSON.stringify(value));
const normalize = (value, s = snapshot(), allowed = buildPremarketInput(s, config).allowed) =>
    normalizeRouterResponse(rawResponse(value), config, s, allowed);
const assertEvidence = row => {
    for (const [key, value] of Object.entries(evidence)) assert.equal(row[key], value);
};

function fixture({ configuration = config, raw = rawResponse(), deferred = false, httpError = false } = {}) {
    const requests = [], counts = [], state = {}, events = [];
    let finish;
    const counter = { start: async () => ({ identity: 'directional-tokenizer', maxTokens: 1024 }),
        count: async (input, questions) => {
            counts.push({ input, questions }); return { valid: true, tokens: 800, identity: 'directional-tokenizer' };
        }, close() {} };
    const providers = new PremarketProviders(configuration, state, (type, detail) => events.push({ type, detail }), {
        counter, clock: () => at, fetch: async (url, init) => {
            if (init.method !== 'POST') return response(url.endsWith('/health') ? { loaded: ['typed-decisions'] }
                : { data: [{ id: configuration.routerModel, owned_by: 'cx' }] });
            const request = JSON.parse(init.body), name = url.endsWith('/v1/systemone') ? 'laya' : 'router';
            requests.push({ name, request, body: init.body, pending: structuredClone(state[name].pending) });
            if (name === 'laya') return response({ model: 'typed-decisions', answers: { action: {
                choice: 'BUY_DOWN', probabilities: { BUY_UP: .1, BUY_DOWN: .6, SKIP: .3 } } }, usage: { input_tokens: 800 } });
            if (httpError) return new Response('{}', { status: 503 });
            if (deferred) return new Promise(resolve => { finish = () => resolve(response(raw)); });
            return response(raw);
        } });
    return { providers, requests, counts, state, events, finish: () => finish() };
}

test('directional policy requires both exact next profile and explicit opt-in', () => {
    assert.equal(routerDirectionalPolicy(config), true);
    assert.deepEqual(routerDirectionalPromptEvidence(config), evidence);
    for (const configuration of [{}, { ...config, routerPolicy: undefined }, { ...config, routerPolicy: 'unknown' },
        { ...config, profile: 'early-reversal-30x5m-v1' }, { ...config, profile: 'fair-near-open-30m-v1' }]) {
        assert.equal(routerDirectionalPolicy(configuration), false);
        assert.deepEqual(routerDirectionalPromptEvidence(configuration), {});
    }
});

test('router changes only the full system prompt while preserving exact shared encoded input', () => {
    const encoded = buildPremarketInput(snapshot(), config), legacyConfig = { ...config, routerPolicy: undefined };
    const legacy = routerRequest(legacyConfig, encoded), directional = routerRequest(config, encoded);
    assert.equal(legacy.messages[0].content, NEXT_PREMARKET_PROMPT + ' Choices: '
        + JSON.stringify(NEXT_PREMARKET_QUESTIONS.action.criteria) + NEXT_ROUTER_OUTPUT_INSTRUCTIONS);
    assert.equal(directional.messages[0].content, NEXT_ROUTER_DIRECTIONAL_PROMPT);
    assert.equal(directional.messages[1].content, encoded.input);
    const expected = structuredClone(legacy); expected.messages[0].content = NEXT_ROUTER_DIRECTIONAL_PROMPT;
    assert.deepEqual(directional, expected);
    for (const profile of ['early-reversal-30x5m-v1', 'fair-near-open-30m-v1', 'near-open-30m-v1']) {
        const base = { ...config, profile, routerPolicy: undefined };
        assert.deepEqual(routerRequest({ ...base, routerPolicy: NEXT_ROUTER_DIRECTIONAL_POLICY }, encoded), routerRequest(base, encoded));
    }
    assert.match(directional.messages[0].content, /PAPER.*does not require statistical proof/);
    assert.match(directional.messages[0].content, /open\+5s/);
    assert.match(directional.messages[0].content, /absence alone is not a reason to abstain/);
    assert.match(directional.messages[0].content, /open=prevClose\+first/);
    assert.match(directional.messages[0].content, /even in a close call/);
    assert.match(directional.messages[0].content, /baseline that can be wrong/);
});

for (const [direction, directions] of [['DOWN', [1, 1, 1, -1]], ['UP', [-1, -1, -1, 1]]]) {
    test(`directional ${direction} forecast confirms only its allowed signal without estimating probability or EV`, () => {
        const s = snapshot(directions), value = answer({ forecastDirection: direction, action: `BUY_${direction}` });
        const row = normalize(value, s);
        assert.equal(row.action, value.action); assert.equal(row.rawAction, value.action);
        assert.equal(row.forecastDirection, direction); assert.equal(row.forecastStrength, 'weak');
        assert.equal(row.forecastStrengthType, 'directional_not_calibrated');
        assert.equal(row.estimatedUpProbability, null); assert.equal(row.confidence, null);
        assert.equal(row.estimatedUpProbabilityType, 'directional_not_calibrated');
        assert.equal(row.confidenceType, 'directional_not_calibrated');
        assert.deepEqual(row.expectedNetUsd, { BUY_UP: null, BUY_DOWN: null });
        assert.equal(row.reasonCode, 'direction_matches_signal'); assert.equal(row.responseValidation, 'strict_local_contract');
        assert.equal(row.responseHash, hash(JSON.stringify(value)));
    });
    test(`opposing ${direction} forecast is retained as an explicit SKIP`, () => {
        const s = snapshot(directions.map(value => -value));
        const row = normalize(answer({ forecastDirection: direction, forecastStrength: 'strong',
            action: 'SKIP', reasonCode: 'direction_opposes_signal' }), s);
        assert.equal(row.action, 'SKIP'); assert.equal(row.rawAction, 'SKIP');
        assert.equal(row.forecastDirection, direction); assert.equal(row.forecastStrength, 'strong');
        assert.equal(row.reasonCode, 'direction_opposes_signal');
    });
}

test('directional responses require every exact field and valid strength, direction, action, reason and rationale', () => {
    const good = answer();
    for (const field of Object.keys(good)) {
        const bad = { ...good }; delete bad[field];
        assert.throws(() => normalize(bad), /invalid_response/);
    }
    for (const bad of [{ forecastDirection: 'NEUTRAL' }, { forecastDirection: null }, { forecastStrength: .9 },
        { forecastStrength: 'certain' }, { action: 'BUY' }, { reasonCode: 'positive_edge' },
        { rationale: '' }, { rationale: 'a'.repeat(241) }, { rationale: 'line\nbreak' },
        { snapshotId: 'different' }, { estimatedUpProbability: .9 }, { confidence: .9 }, { extra: true }]) {
        assert.throws(() => normalize({ ...good, ...bad }), /invalid_response/);
    }
    assert.equal(normalize(answer({ forecastStrength: 'moderate', rationale: 'a'.repeat(240) })).forecastStrength, 'moderate');
});

test('local mapping rejects inconsistent SKIP or BUY without synthesizing a confirming BUY', () => {
    for (const bad of [
        { action: 'SKIP', reasonCode: 'direction_opposes_signal' },
        { action: 'SKIP', reasonCode: 'direction_matches_signal' },
        { action: 'SKIP', reasonCode: 'no_allowed_buy' },
        { forecastDirection: 'UP' }, { reasonCode: 'direction_opposes_signal' }, { reasonCode: 'no_allowed_buy' },
        { forecastDirection: 'UP', action: 'SKIP', reasonCode: 'direction_matches_signal' }
    ]) assert.throws(() => normalize(answer(bad)), /router_reason_action_mismatch/);
    assert.throws(() => normalize(answer({ action: 'BUY_UP', forecastDirection: 'UP' })), /disallowed_action/);
    assert.throws(() => normalize(answer({ action: 'BUY_UP', forecastDirection: 'UP' }), snapshot(),
        ['BUY_UP', 'BUY_DOWN', 'SKIP']), /disallowed_action/);
    assert.throws(() => normalize(answer(), snapshot(), ['SKIP']), /disallowed_action/);
});

test('no pattern and order veto require no_allowed_buy while retaining a directional forecast', () => {
    const veto = snapshot(); veto.orders.BUY_DOWN = null;
    for (const s of [snapshot([1, 1, 1, 1]), veto]) {
        assert.deepEqual(buildPremarketInput(s, config).allowed, ['SKIP']);
        const row = normalize(answer({ action: 'SKIP', reasonCode: 'no_allowed_buy' }), s);
        assert.equal(row.action, 'SKIP'); assert.equal(row.forecastDirection, 'DOWN');
        assert.throws(() => normalize(answer(), s), /disallowed_action/);
        assert.throws(() => normalize(answer({ action: 'SKIP', reasonCode: 'direction_opposes_signal' }), s),
            /router_reason_action_mismatch/);
    }
});

test('model mismatch, tools, refusal, non-JSON and incomplete responses remain rejected', () => {
    const s = snapshot(), allowed = buildPremarketInput(s, config).allowed;
    for (const mutate of [raw => { raw.model = 'gpt-6-astra'; },
        raw => { raw.choices[0].message.tool_calls = [{ id: 'tool' }]; },
        raw => { raw.choices[0].message.function_call = { name: 'function' }; },
        raw => { raw.choices[0].message.refusal = 'refused'; },
        raw => { raw.choices[0].message.role = 'user'; }, raw => { raw.choices[0].finish_reason = 'length'; },
        raw => { raw.choices[0].message.content = 'not JSON'; }, raw => { raw.choices.push(raw.choices[0]); }]) {
        const raw = rawResponse(); mutate(raw);
        assert.throws(() => normalizeRouterResponse(raw, config, s, allowed), /model_mismatch|invalid_response/);
    }
    const raw = rawResponse(); raw.model = config.routerModel;
    assert.equal(normalizeRouterResponse(raw, config, s, allowed).action, 'BUY_DOWN');
});

test('opt-in preserves byte-identical Laya request and shared semantic hash while auditing actual GPT request', async () => {
    const legacy = fixture({ configuration: { ...config, routerPolicy: undefined } }), directional = fixture();
    try {
        const oldSnapshot = snapshot(), s = snapshot();
        oldSnapshot.commonInput = await legacy.providers.prepareSnapshot(oldSnapshot);
        s.commonInput = await directional.providers.prepareSnapshot(s);
        await legacy.providers.predict('laya', oldSnapshot);
        const rows = await Promise.all(['laya', 'router'].map(name => directional.providers.predict(name, s)));
        assert.deepEqual(rows.map(row => row.status), ['ok', 'ok']);
        const laya = directional.requests.find(row => row.name === 'laya');
        const router = directional.requests.find(row => row.name === 'router');
        assert.equal(laya.body, legacy.requests[0].body);
        assert.equal(laya.request.state, router.request.messages[1].content);
        assert.deepEqual(s.commonInput, oldSnapshot.commonInput);
        assert.deepEqual(directional.counts, legacy.counts);
        assert.deepEqual(directional.counts[0].questions, NEXT_PREMARKET_QUESTIONS);
        assert.equal(directional.counts.length, 1);
        for (const row of rows) {
            assert.equal(row.semanticPromptHash, hash(NEXT_PREMARKET_PROMPT));
            assert.equal(row.inputHash, s.commonInput.inputHash);
            assert.equal(row.promptVersion, NEXT_PREMARKET_PROMPT_VERSION);
            assert.equal(row.contextTokens, 800); assert.equal(row.inputCoverage.fiveMinuteBars, 30);
        }
        assert.equal(rows[0].providerTask, undefined); assert.equal(laya.pending.providerPromptHash, undefined);
        assertEvidence(rows[1]); assertEvidence(router.pending);
        assert.equal(router.pending.requestHash, hash(router.body));
        assert.equal(router.pending.providerPromptHash, hash(router.request.messages[0].content));
        assertEvidence(directional.events.find(event => event.type === 'provider_request' && event.detail.provider === 'router').detail);
        assert.equal(directional.state.router.pending, null);
    } finally { legacy.providers.close(); directional.providers.close(); }
});

test('submitted validation and HTTP failures retain directional prompt evidence and never become BUY', async () => {
    for (const options of [{ raw: rawResponse(answer({ forecastDirection: undefined })) }, { httpError: true },
        { raw: { ...rawResponse(), model: 'other-model' } }]) {
        const f = fixture(options), s = snapshot();
        try {
            s.commonInput = await f.providers.prepareSnapshot(s);
            const row = await f.providers.predict('router', s);
            assert.equal(row.status, 'provider_error'); assert.equal(row.action, 'SKIP');
            assert.equal(row.requestSubmitted, true); assertEvidence(row); assertEvidence(f.requests[0].pending);
            if (row.reason === 'model_mismatch') assert.equal(f.state.router.disabled, 'model_mismatch');
        } finally { f.providers.close(); }
    }
});

test('decision timeout and late response retain actual prompt evidence without a second request', async () => {
    const f = fixture({ deferred: true }), s = snapshot(); s.aiDeadlineAt = at + 30;
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        const row = await f.providers.predict('router', s);
        assert.equal(row.status, 'decision_timeout'); assert.equal(row.action, 'SKIP'); assertEvidence(row);
        assertEvidence(f.state.router.pending);
        assert.equal((await f.providers.predict('router', snapshot())).status, 'provider_busy');
        f.finish(); await f.providers.drain();
        const late = f.events.find(event => event.type === 'provider_late_response').detail;
        assertEvidence(late); assert.equal(late.forecastDirection, 'DOWN'); assert.equal(late.forecastStrength, 'weak');
        assert.equal(f.requests.length, 1); assert.equal(f.state.router.pending, null);
    } finally { f.providers.close(); }
});

test('opt-in retains existing bounded deadlines and validates common input before submission', async () => {
    const f = fixture();
    try {
        for (const deadline of [at, at + 30001, open + 90001]) {
            const s = snapshot(); s.aiDeadlineAt = deadline;
            assert.equal((await f.providers.predict('router', s)).status, 'decision_budget_invalid');
        }
        const s = snapshot(); s.commonInput = await f.providers.prepareSnapshot(s);
        s.commonInput.semanticPromptHash = evidence.providerPromptHash;
        const row = await f.providers.predict('router', s);
        assert.equal(row.reason, 'shared_context_unverified'); assert.equal(row.requestSubmitted, false);
        assert.equal(row.providerPromptHash, undefined); assert.equal(f.requests.length, 0);
    } finally { f.providers.close(); }
});
