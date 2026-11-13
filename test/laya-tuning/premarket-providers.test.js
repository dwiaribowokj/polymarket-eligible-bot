import test from 'node:test';
import assert from 'node:assert/strict';
import { PremarketProviders, PREMARKET_QUESTIONS, buildPremarketInput, normalizeRouterResponse, routerRequest } from '../../src/premarket-paper/providers.js';

function snapshot(now = Date.now()) {
    return { snapshotId: 'paper-snapshot', at: now, aiDeadlineAt: now + 30000,
        market: { open: now + 240000, end: now + 540000 },
        features: { decisionAt: now, observedAt: now - 1000, openingTwap: { value: null },
            bars: [0, 1, 2].map(i => ({ start: now - (3 - i) * 60000, end: now - (2 - i) * 60000,
                open: 100 - i, high: 101 - i, low: 98 - i, close: 99 - i, latestReceivedAt: now - (2 - i) * 60000 })),
            diagnosticOnly: { sigmaUsdSqrtSecond: 1 } },
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 12 }], asks: [{ price: .5, size: 15 }] })),
        orders: { BUY_UP: { price: .51, shares: 5, cost: 2.7 }, BUY_DOWN: { price: .51, shares: 5, cost: 2.7 } } };
}
const config = { routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium', aiDecisionMs: 30000,
    providerDrainMs: 100, layaUrl: 'http://laya.example', ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'test' };
const counter = () => ({ start: async () => ({ identity: 'tokenizer-v1', maxTokens: 1024 }),
    count: async (_input, questions) => {
        assert.deepEqual(questions, PREMARKET_QUESTIONS); return { valid: true, tokens: 500, identity: 'tokenizer-v1' };
    }, close() {} });
const routerRow = (s, patch = {}) => ({ model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop',
    message: { role: 'assistant', content: JSON.stringify({ snapshotId: s.snapshotId, action: 'BUY_DOWN',
        estimatedUpProbability: .3, reasonCode: 'positive_edge', rationale: 'Three falling candles support the down forecast.' }) } }], ...patch });
const response = body => new Response(JSON.stringify(body), { status: 200 });
const readResponse = url => url.endsWith('/health') ? response({ loaded: ['typed-decisions'] })
    : response({ data: [{ id: config.routerModel, owned_by: 'cx' }] });

test('premarket AI schema leaves opening unknown and rejects future candles', () => {
    const s = snapshot(), built = buildPremarketInput(s), parsed = JSON.parse(built.input);
    assert.equal(parsed.opening_twap, null); assert.deepEqual(parsed.allowed, ['BUY_UP', 'BUY_DOWN', 'SKIP']);
    s.features.bars[2].latestReceivedAt = s.at + 1;
    assert.throws(() => buildPremarketInput(s), /input_invalid/);
});

test('input rejects absent, nonfinite or reordered timestamps instead of admitting future history', () => {
    for (const mutate of [
        s => { delete s.features.decisionAt; s.features.bars[2].end = s.market.open + 1; },
        s => { s.features.decisionAt = NaN; }, s => { delete s.features.observedAt; },
        s => { s.features.observedAt = s.features.decisionAt + 1; },
        s => { delete s.market.open; }, s => { s.market.end = s.market.open; },
        s => { delete s.features.bars[0].start; }, s => { delete s.features.bars[2].latestReceivedAt; },
        s => { s.features.bars.reverse(); }, s => { s.features.bars[1].end += 1; }
    ]) {
        const s = snapshot(); mutate(s);
        assert.throws(() => buildPremarketInput(s), /premarket_provider_input_invalid/);
    }
});

test('router requires fixed model, completed JSON, exact snapshot and allowed action', () => {
    const s = snapshot(), normalize = raw => normalizeRouterResponse(raw, config, s, ['BUY_DOWN', 'SKIP']);
    assert.equal(normalize(routerRow(s)).action, 'BUY_DOWN');
    for (const raw of [routerRow(s, { model: 'gpt-6-luna' }), routerRow(s, { choices: [] }),
        routerRow(s, { choices: [{ finish_reason: 'length', message: {} }] }),
        routerRow({ snapshotId: 'wrong' })]) assert.throws(() => normalize(raw));
    const raw = routerRow(s); raw.choices[0].message.content = JSON.stringify({ snapshotId: s.snapshotId, action: 'BUY_UP',
        estimatedUpProbability: .7, reasonCode: 'positive_edge', rationale: 'Rising input supports Up.' });
    assert.throws(() => normalize(raw), /disallowed_action/);
    raw.choices[0].message.content = JSON.stringify({ snapshotId: s.snapshotId, action: 'BUY_DOWN', tool: 'buy' });
    assert.throws(() => normalize(raw), /invalid_response/);
    assert.throws(() => new PremarketProviders({ ...config, routerModel: 'polymarket-decision' }), /fixed_router/);
});

test('input defines both side costs explicitly and projects no outcome or asymmetric reversal flag', () => {
    const s = snapshot(); s.market.payout = [0, 1]; s.decisions = { router: { action: 'BUY_DOWN' } };
    s.features.diagnosticOnly.reversalAgainstDown = true;
    const encoded = buildPremarketInput(s), input = JSON.parse(encoded.input);
    assert.deepEqual(input.entry_up_down, [0, 1].map(() => ({ limit_usd_per_share: .51,
        shares: 5, total_cost_usd: 2.7, break_even_probability: .54 })));
    assert.equal(input.books_up_down.length, 2);
    assert.equal(encoded.input.includes('payout'), false);
    assert.equal(encoded.input.includes('decisions'), false);
    assert.equal(encoded.input.includes('reversalAgainstDown'), false);
    assert.match(routerRequest(config, encoded).messages[0].content, /winning share pays \$1/);
    assert.match(routerRequest(config, encoded).messages[0].content, /reasonCode/);
});

test('router preserves Up, Down and an explained valid abstention separately from invalid responses', () => {
    const s = snapshot(), allowed = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
    const normalize = answer => {
        const raw = routerRow(s); raw.choices[0].message.content = JSON.stringify({ snapshotId: s.snapshotId, ...answer });
        return normalizeRouterResponse(raw, config, s, allowed);
    };
    for (const [action, p, expected] of [['BUY_UP', .8, 1.3], ['BUY_DOWN', .2, 1.3]]) {
        const row = normalize({ action, estimatedUpProbability: p, reasonCode: 'positive_edge', rationale: 'Synthetic evidence supports the chosen side.' });
        assert.equal(row.action, action); assert.equal(row.rawAction, action);
        assert.equal(row.expectedNetUsd[action], expected);
        assert.equal(row.estimatedUpProbabilityType, 'self_reported_uncalibrated_market_probability');
        assert.match(row.responseHash, /^[a-f0-9]{64}$/);
    }
    const skip = { action: 'SKIP', estimatedUpProbability: .51, reasonCode: 'insufficient_predictive_evidence', rationale: 'The weak Up lean does not cover the all-in cost.' };
    const row = normalize(skip);
    assert.equal(row.action, 'SKIP'); assert.equal(row.forecastDirection, 'UP');
    assert.equal(row.expectedNetUsd.BUY_UP, -.15); assert.equal(row.expectedNetUsd.BUY_DOWN, -.25);
    for (const bad of [{ ...skip, estimatedUpProbability: undefined }, { ...skip, estimatedUpProbability: 1.1 },
        { ...skip, rationale: 'a'.repeat(241) }, { ...skip, reasonCode: 'unknown' },
        { ...skip, reasonCode: 'positive_edge' }, { ...skip, reasonCode: 'no_allowed_buy' },
        { ...skip, action: 'BUY_UP', reasonCode: 'positive_edge' }]) assert.throws(() => normalize(bad));
    assert.equal(normalize({ ...skip, estimatedUpProbability: null }).forecastDirection, null);
    assert.equal(normalize({ ...skip, estimatedUpProbability: .5 }).forecastDirection, 'NEUTRAL');
    assert.throws(() => normalize({ ...skip, estimatedUpProbability: .9, reasonCode: 'no_positive_edge' }), /router_reason_action_mismatch/);
    assert.throws(() => normalize({ ...skip, estimatedUpProbability: null, reasonCode: 'no_positive_edge' }), /router_reason_action_mismatch/);
    assert.equal(normalize({ ...skip, estimatedUpProbability: .9, reasonCode: 'conflicting_signals' }).action, 'SKIP');
});

test('router-only provider preflight and inference never require Laya health or tokenizer', async () => {
    const s = snapshot(), calls = [];
    const p = new PremarketProviders({ ...config, activeArms: ['router-premarket'] }, {}, () => {}, {
        counter: { start() { throw new Error('laya_forbidden'); }, close() {} },
        fetch: async (url, init) => { calls.push(url); return init.method === 'POST' ? response(routerRow(s)) : readResponse(url); } });
    assert.deepEqual(Object.keys(await p.preflight()), ['router']);
    assert.equal((await p.predict('router', s)).action, 'BUY_DOWN');
    await assert.rejects(p.predict('laya', s), /provider_not_selected/);
    assert.ok(calls.every(url => url.startsWith(config.ninerouterUrl))); p.close();
});

test('router records durable request before dispatch and keeps unknown subscription cost', async () => {
    const s = snapshot(), state = {}, events = [];
    const p = new PremarketProviders(config, state, (type, detail) => events.push({ type, detail }), {
        counter: counter(), fetch: async (url, init) => {
            if (init.method !== 'POST') return readResponse(url);
            assert.equal(state.router.pending.submitted, true);
            assert.equal(events.at(-1).type, 'provider_request');
            const req = JSON.parse(init.body); assert.equal(req.model, config.routerModel);
            assert.equal(req.reasoning_effort, 'medium'); return response(routerRow(s));
        } });
    const r = await p.predict('router', s); p.close();
    assert.equal(r.status, 'ok'); assert.equal(r.requestSubmitted, true); assert.equal(r.cost, null);
    assert.equal(state.router.pending, null); assert.equal(p.active.size, 0);
});

test('Laya counts exact custom questions and validates model input token usage', async () => {
    const s = snapshot(); let bad = false;
    const p = new PremarketProviders(config, {}, () => {}, { counter: counter(), fetch: async (url, init) => {
        if (init.method !== 'POST') return readResponse(url);
        assert.deepEqual(JSON.parse(init.body).questions, PREMARKET_QUESTIONS);
        return response({ model: 'laya-rl-agent', routing: { model: 'typed-decisions' },
            answers: { action: { choice: 'BUY_UP', probabilities: { BUY_UP: .6, BUY_DOWN: .2, SKIP: .2 } } },
            usage: { input_tokens: bad ? 499 : 500 } });
    } });
    assert.equal((await p.predict('laya', s)).action, 'BUY_UP');
    bad = true; const invalid = await p.predict('laya', { ...s, snapshotId: 'next' });
    assert.equal(invalid.action, 'SKIP'); assert.equal(invalid.reason, 'token_usage_mismatch'); p.close();
});

test('oversize Laya context never submits inference', async () => {
    let posts = 0;
    const p = new PremarketProviders(config, {}, () => {}, {
        counter: { ...counter(), count: async () => ({ valid: false, tokens: 1025, identity: 'tokenizer-v1' }) },
        fetch: async (url, init) => { if (init.method === 'POST') posts++; return readResponse(url); } });
    const result = await p.predict('laya', snapshot()); p.close();
    assert.equal(result.reason, 'context_or_artifact_invalid'); assert.equal(result.requestSubmitted, false); assert.equal(posts, 0);
});

test('timed out inference drains once, blocks overlap and late response never becomes entry', async () => {
    let finish, calls = 0;
    const s = snapshot(); s.aiDeadlineAt = Date.now() + 25;
    const events = [];
    const p = new PremarketProviders({ ...config, providerDrainMs: 1000 }, {}, (type, detail) => events.push({ type, detail }), {
        counter: counter(), fetch: async (url, init) => {
            if (init.method !== 'POST') return readResponse(url);
            calls++; return new Promise(resolve => { finish = () => resolve(response(routerRow(s))); });
        } });
    const result = await p.predict('router', s);
    assert.equal(result.status, 'decision_timeout'); assert.equal(result.action, 'SKIP');
    assert.equal((await p.predict('router', snapshot())).status, 'provider_busy');
    finish(); await p.drain(); p.close();
    assert.equal(calls, 1); assert.ok(events.some(e => e.type === 'provider_late_response'));
});

test('restart preserves unresolved provider state and does not resubmit', async () => {
    let requests = 0;
    const state = { router: { pending: { snapshotId: 'old', submitted: true } } };
    const p = new PremarketProviders(config, state, () => {}, { counter: counter(), fetch: async () => { requests++; } });
    const row = await p.predict('router', snapshot()); p.close();
    assert.equal(row.status, 'inference_unresolved_after_restart'); assert.equal(requests, 0);
});

test('provider input uses one common immutable projection for both engines', async () => {
    const s = snapshot(), inputs = [];
    const p = new PremarketProviders(config, {}, () => {}, { counter: counter(), fetch: async (url, init) => {
        if (init.method !== 'POST') return readResponse(url);
        const req = JSON.parse(init.body); inputs.push(req.state || req.messages.at(-1).content);
        if (url.endsWith('/v1/systemone')) return response({ model: 'typed-decisions', answers: { action: {
            choice: 'SKIP', probabilities: { BUY_UP: .2, BUY_DOWN: .2, SKIP: .6 } } }, usage: { input_tokens: 500 } });
        return response(routerRow(s));
    } });
    await Promise.all([p.predict('laya', s), p.predict('router', s)]); p.close();
    assert.equal(inputs.length, 2); assert.equal(inputs[0], inputs[1]);
});
