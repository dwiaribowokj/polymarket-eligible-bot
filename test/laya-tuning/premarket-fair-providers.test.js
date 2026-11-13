import test from 'node:test';
import assert from 'node:assert/strict';
import { PremarketProviders, buildPremarketInput, normalizeRouterResponse, routerRequest } from '../../src/premarket-paper/providers.js';
import { COMPACT_PREMARKET_PROMPT, COMPACT_PREMARKET_QUESTIONS } from '../../src/premarket-paper/compact-context.js';
import { premarketFeatures } from '../../src/premarket-paper/features.js';

const at = Date.parse('2026-10-27T04:59:00Z');
const config = { profile: 'fair-near-open-30m-v1', activeArms: ['premarket-momentum', 'laya-premarket', 'router-premarket'],
    routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium', aiDecisionMs: 30000, providerDrainMs: 1000,
    leadSeconds: 60, historyMs: 1800000, diagnosticHistoryMs: 1800000, dataAgeMs: 5000, maxGapMs: 5000,
    layaUrl: 'http://laya.example', ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'test' };
function snapshot() {
    const points = Array.from({ length: 901 }, (_, i) => ({ at: at - 1800000 + i * 2000,
        receivedAt: at - 1800000 + i * 2000, value: 80000 + i * .13 + Math.sin(i / 20) }));
    const market = { open: at + 60000, end: at + 360000 };
    return { snapshotId: 'fair-common-test', at, aiDeadlineAt: at + 30000, market,
        features: premarketFeatures(points, market, at, config),
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 12 }] })),
        orders: { BUY_UP: { price: .51, shares: 5, cost: 2.68747 }, BUY_DOWN: { price: .51, shares: 5, cost: 2.68747 } } };
}
const response = value => new Response(JSON.stringify(value));
function fixture(options = {}) {
    const posts = [], counts = [], state = {};
    const counter = { start: async () => ({ identity: 'artifact-test', maxTokens: 1024 }),
        count: async (input, questions) => {
            counts.push({ input, questions });
            return { valid: true, tokens: 728, identity: 'artifact-test', ...options.count };
        }, close() {} };
    const providers = new PremarketProviders(config, state, () => {}, { counter, clock: () => at,
        fetch: async (url, init) => {
            if (init.method !== 'POST') return response(url.endsWith('/health')
                ? { loaded: ['typed-decisions'] } : { data: [{ id: config.routerModel, owned_by: 'cx' }] });
            const request = JSON.parse(init.body); posts.push(request);
            return response(url.endsWith('/v1/systemone')
                ? { model: 'laya-rl-agent', routing: { model: 'typed-decisions' },
                    answers: { action: { choice: 'BUY_UP', probabilities: { BUY_UP: .6, BUY_DOWN: .2, SKIP: .2 } } },
                    usage: { input_tokens: options.returnedTokens ?? 728 } }
                : { model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
                    content: JSON.stringify({ snapshotId: 'fair-common-test', action: 'SKIP', estimatedUpProbability: null,
                        reasonCode: 'insufficient_predictive_evidence', rationale: 'Direction remains uncertain over the future window.' }) } }] });
        } });
    return { providers, posts, counts, state };
}

test('both providers consume identical complete context checked once against Laya actual contract', async () => {
    const f = fixture(), s = snapshot();
    try {
        await f.providers.preflight(); s.commonInput = await f.providers.prepareSnapshot(s);
        const rows = await Promise.all(['laya', 'router'].map(name => f.providers.predict(name, s)));
        assert.deepEqual(rows.map(row => row.status), ['ok', 'ok']);
        assert.deepEqual(rows.map(row => row.action), ['BUY_UP', 'SKIP']);
        assert.equal(f.counts.length, 1);
        assert.deepEqual(f.counts[0].questions, COMPACT_PREMARKET_QUESTIONS);
        assert.equal(f.posts[0].state, f.posts[1].messages[1].content);
        assert.equal(f.posts[0].questions.action.instructions, COMPACT_PREMARKET_PROMPT);
        assert.ok(f.posts[1].messages[0].content.startsWith(COMPACT_PREMARKET_PROMPT));
        for (const row of rows) {
            assert.equal(row.inputHash, s.commonInput.inputHash);
            assert.equal(row.contextTokens, 728); assert.equal(row.contextIdentity, 'artifact-test');
            assert.equal(row.inputCoverage.minuteBars, 30); assert.equal(row.inputCoverage.truncated, false);
        }
        assert.equal(rows[0].probabilityType, 'action_choice_distribution');
        assert.equal(rows[1].cost, null);
    } finally { f.providers.close(); }
});

test('oversize or invalid common context blocks the entire shared preparation without any inference', async () => {
    for (const count of [{ tokens: 1025, valid: false }, { tokens: NaN }, { truncated: true },
        { instructionTruncated: true }, { identity: 'different-artifact' }]) {
        const f = fixture({ count });
        await assert.rejects(f.providers.prepareSnapshot(snapshot()), /shared_context_invalid/);
        assert.equal(f.posts.length, 0); f.providers.close();
    }
});

test('fair providers reject missing or tampered common input and do not fall back to independent encoding', async () => {
    const f = fixture();
    try {
        await f.providers.preflight();
        for (const mutate of [s => { delete s.commonInput; }, s => { s.commonInput.input += 'extra'; },
            s => { s.commonInput.contextTokens = 1025; }, s => { s.commonInput.semanticPromptHash = 'wrong'; }]) {
            const s = snapshot(); s.commonInput = await f.providers.prepareSnapshot(s);
            mutate(s);
            for (const name of ['laya', 'router']) {
                const row = await f.providers.predict(name, s);
                assert.equal(row.reason, 'shared_context_unverified'); assert.equal(row.requestSubmitted, false);
            }
        }
        assert.equal(f.posts.length, 0);
    } finally { f.providers.close(); }
});

test('fair router uses the same three-action contract without a router-only numeric probability gate', () => {
    const s = snapshot();
    for (const action of ['BUY_UP', 'BUY_DOWN', 'SKIP']) {
        const raw = { model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
            content: JSON.stringify({ snapshotId: s.snapshotId, action,
                reasonCode: action === 'SKIP' ? 'insufficient_predictive_evidence' : 'positive_edge',
                rationale: 'The shared history supports this prospective choice.' }) } }] };
        const row = normalizeRouterResponse(raw, config, s, ['BUY_UP', 'BUY_DOWN', 'SKIP']);
        assert.equal(row.action, action); assert.equal(row.estimatedUpProbability, null);
        if (action !== 'SKIP') assert.throws(() => normalizeRouterResponse(raw, config, s, ['SKIP']), /disallowed_action/);
    }
});

test('capturing up to two seconds after fixed history cutoff keeps causal common input', () => {
    const s = snapshot(); s.at += 1500;
    const encoded = buildPremarketInput(s, config);
    assert.equal(encoded.context.secondsToOpen, 58.5);
    assert.equal(encoded.inputCoverage.historyEndAt, at);
    assert.equal(encoded.context.bars.length, 30);
    assert.equal(routerRequest(config, encoded).messages[1].content, encoded.input);
});

test('Laya response must confirm exact pre-counted input tokens', async () => {
    const f = fixture({ returnedTokens: 727 }), s = snapshot();
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        const row = await f.providers.predict('laya', s);
        assert.equal(row.reason, 'token_usage_mismatch'); assert.equal(row.action, 'SKIP');
    } finally { f.providers.close(); }
});
