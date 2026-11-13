import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { EARLY_PROFILE, NEXT_PROFILE, isCandleProfile, EARLY_PREMARKET_PROMPT, EARLY_PREMARKET_QUESTIONS,
    NEXT_PREMARKET_PROMPT, NEXT_PREMARKET_QUESTIONS, NEXT_PREMARKET_PROMPT_VERSION,
    earlyPremarketFeatures, earlyReversalDecision, nextReversalSignal } from '../../src/premarket-paper/early-context.js';
import { buildPremarketInput, PremarketProviders, routerRequest, normalizeRouterResponse } from '../../src/premarket-paper/providers.js';
import { ProtocolCounter } from '../../src/laya-tuning/counter.js';

const open = Date.parse('2026-10-29T10:15:00Z'), at = open + 5000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = { profile: NEXT_PROFILE, paperOnly: true, leadSeconds: -5,
    activeArms: ['premarket-momentum', 'laya-premarket', 'router-premarket'],
    candleCount: 30, candleIntervalMs: 300000, candleCacheMaxAgeMs: 90000, slotToleranceMs: 10000,
    signalParameters: { minimumPriorStreak: 3 }, aiDecisionMs: 30000, providerDrainMs: 1000,
    routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium',
    layaUrl: 'http://laya.example', ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'fixture' };

function history(directions = [1, 1, 1, -1]) {
    const changes = [...Array(30 - directions.length).fill(0), ...directions];
    return { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: open - 9000000, windowEnd: open, expectedLatestClosedAt: open,
        observedAt: open + 1000, fetchedAt: open + 1000,
        bars: changes.map((direction, i) => {
            const value = 80000.003 + i * 2, close = value + direction;
            return { openAt: open - (30 - i) * 300000, closeAt: open - (29 - i) * 300000,
                open: value, high: Math.max(value, close) + .12, low: Math.min(value, close) - .17, close,
                observedAt: open + 1000 };
        }) };
}

function snapshot(directions, configuration = config) {
    const market = { slug: `btc-updown-5m-${open / 1000}`, open, end: open + 300000 };
    const features = earlyPremarketFeatures(history(directions), market, at, configuration);
    const signal = nextReversalSignal(features, configuration.signalParameters);
    return { snapshotId: 'next-shared-fixture', scheduledAt: at, at, aiDeadlineAt: at + 30000, market, features,
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 12 }] })),
        orders: Object.fromEntries(['BUY_UP', 'BUY_DOWN'].map(action => [action,
            action === signal.action ? { price: .51, shares: 5, cost: 2.68747001 } : null])) };
}

function providerFixture({ layaAction = 'BUY_DOWN', routerAction = 'BUY_DOWN', count = {}, returnedTokens,
    configuration = config } = {}) {
    const requests = [], counts = [], state = {};
    const counter = { start: async () => ({ identity: hash('next-tokenizer'), maxTokens: 1024 }),
        count: async (input, questions) => {
            counts.push({ input, questions }); return { valid: true, tokens: 800, identity: hash('next-tokenizer'), ...count };
        }, close() {} };
    const response = value => new Response(JSON.stringify(value));
    const providers = new PremarketProviders(configuration, state, () => {}, { counter, clock: () => at,
        fetch: async (url, init) => {
            if (init.method !== 'POST') return response(url.endsWith('/health') ? { loaded: ['typed-decisions'] }
                : { data: [{ id: configuration.routerModel, owned_by: 'cx' }] });
            const request = JSON.parse(init.body); requests.push(request);
            return response(url.endsWith('/v1/systemone') ? { model: 'laya-rl-agent', routing: { model: 'typed-decisions' },
                answers: { action: { choice: layaAction, probabilities: { BUY_UP: .1, BUY_DOWN: .6, SKIP: .3 } } },
                usage: { input_tokens: returnedTokens ?? 800 } } : routerResponse(routerAction));
        } });
    return { providers, requests, counts, state };
}

function routerResponse(action) {
    return { model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ snapshotId: 'next-shared-fixture', action,
            reasonCode: action === 'SKIP' ? 'insufficient_predictive_evidence' : 'positive_edge',
            rationale: 'The closed reversal and wider history inform this confirmation decision.' }) } }] };
}

test('next profile targets the market immediately after the last closed native candle', () => {
    const s = snapshot(), before = structuredClone(s), encoded = buildPremarketInput(s, config);
    assert.deepEqual(s, before);
    assert.equal(isCandleProfile(config), true); assert.equal(isCandleProfile({ profile: EARLY_PROFILE }), true);
    assert.equal(isCandleProfile({ profile: 'fair-near-open-30m-v1' }), false);
    assert.equal(encoded.context.schema, NEXT_PREMARKET_PROMPT_VERSION);
    assert.equal(encoded.context.historyEndAt, open);
    assert.equal(encoded.context.marketOpenAt, open); assert.equal(encoded.context.decisionAt, open + 5000);
    assert.equal(encoded.context.secondsToOpen, -5);
    assert.equal(encoded.context.bars.length, 30); assert.equal(encoded.inputCoverage.fiveMinuteBars, 30);
    assert.equal(encoded.inputCoverage.completeMinutes, 150); assert.equal(encoded.inputCoverage.truncated, false);
    assert.equal(encoded.inputCoverage.fiveMinuteGroupsDerived, false);
    assert.equal(s.features.openingTwap.status, 'unavailable_in_input');
    assert.equal(encoded.context.confirmationOnly, true);
    assert.equal(encoded.context.reversalSignal.action, 'BUY_DOWN');
    assert.equal(encoded.context.reversalSignal.priorStreak, 3);
    assert.deepEqual(encoded.allowed, ['BUY_DOWN', 'SKIP']);
    assert.equal(encoded.context.entriesUpDown[0], null);
    assert.equal(encoded.context.entriesUpDown[1].total_cost_usd, 2.68747001);
    assert.match(encoded.input, /signal=BUY_DOWN prior_streak=3; confirm signal or SKIP/);
    assert.match(NEXT_PREMARKET_PROMPT, /actual NEXT market.*now open/);
    assert.match(NEXT_PREMARKET_PROMPT, /confirmation filter/);
    assert.match(EARLY_PREMARKET_PROMPT, /540s.*NOT the next candle/);
    assert.equal(EARLY_PREMARKET_QUESTIONS.action.instructions, EARLY_PREMARKET_PROMPT);
});

test('all thirty encoded bars reconstruct exactly and pre-order signal matches the shared cent evidence', () => {
    const s = snapshot(), encoded = buildPremarketInput(s, config);
    let previous = Math.round(encoded.context.priceAnchorUsd * 100);
    const bars = encoded.input.split('\n').find(line => line.startsWith('OHLC=')).slice(5).split(';').map(row => {
        const [gap, high, low, close] = row.split(' ').map(Number), start = previous + gap;
        previous = start + close; return [start, start + high, start + low, previous].map(value => value / 100);
    });
    assert.deepEqual(bars, encoded.context.bars);
    assert.deepEqual(nextReversalSignal(s.features), earlyReversalDecision(encoded.context));
    assert.equal(encoded.inputHash, hash(encoded.input));
    assert.equal(encoded.inputBytes, Buffer.byteLength(encoded.input));
});

test('confirmation mask allows only the first reversal side or SKIP, including no-pattern slots', () => {
    for (const [directions, action] of [
        [[1, 1, 1, -1], 'BUY_DOWN'], [[-1, -1, -1, 1], 'BUY_UP'], [[1, 1, 1, 1, -1], 'BUY_DOWN'],
        [[1, 1, -1], 'SKIP'], [[1, 1, 1, -1, -1], 'SKIP'], [[1, 1, 0, 1, -1], 'SKIP'], [[1, 1, 1, 0], 'SKIP'],
    ]) {
        const encoded = buildPremarketInput(snapshot(directions), config);
        assert.equal(encoded.context.reversalSignal.action, action);
        assert.deepEqual(encoded.allowed, action === 'SKIP' ? ['SKIP'] : [action, 'SKIP']);
    }
    const s = snapshot(); s.orders.BUY_DOWN = null;
    assert.deepEqual(buildPremarketInput(s, config).allowed, ['SKIP'], 'entry constraints may veto the signal');
    s.orders.BUY_UP = { price: .51, shares: 5, cost: 2.7 };
    assert.throws(() => buildPremarketInput(s, config), /early_premarket_context_invalid/);
    const absent = snapshot([1, 1, 1, 1]); absent.orders.BUY_DOWN = { price: .51, shares: 5, cost: 2.7 };
    assert.throws(() => buildPremarketInput(absent, config), /early_premarket_context_invalid/);
});

test('next features reject delayed targets, partial bars, post-decision observations and capture beyond grace', () => {
    for (const mutate of [s => { s.market.open += 300000; s.market.end += 300000; },
        s => { s.features.bars.at(-1).end += 300000; }, s => { s.features.bars.pop(); },
        s => { s.features.bars.at(-1).latestReceivedAt = at + 1; },
        s => { s.features.context.historyEndAt -= 300000; }, s => { s.at += 10001; }]) {
        const s = snapshot(); mutate(s); assert.throws(() => buildPremarketInput(s, config), /early_premarket_context_invalid/);
    }
    const s = snapshot(); s.at += 10000;
    assert.equal(buildPremarketInput(s, config).context.secondsToOpen, -15);
});

test('both providers share full input and confirmation prompt, and may independently BUY or SKIP', async () => {
    const f = providerFixture({ layaAction: 'BUY_DOWN', routerAction: 'SKIP' }), s = snapshot();
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        const rows = await Promise.all(['laya', 'router'].map(name => f.providers.predict(name, s)));
        assert.deepEqual(rows.map(row => row.status), ['ok', 'ok']);
        assert.deepEqual(rows.map(row => row.action), ['BUY_DOWN', 'SKIP']);
        assert.equal(f.counts.length, 1); assert.deepEqual(f.counts[0].questions, NEXT_PREMARKET_QUESTIONS);
        assert.equal(f.requests[0].state, f.requests[1].messages[1].content);
        assert.equal(f.requests[0].questions.action.instructions, NEXT_PREMARKET_PROMPT);
        assert.ok(f.requests[1].messages[0].content.startsWith(NEXT_PREMARKET_PROMPT));
        assert.match(routerRequest(config, s.commonInput).messages[0].content, /opposite direction is forbidden/);
        for (const row of rows) {
            assert.equal(row.inputHash, s.commonInput.inputHash); assert.equal(row.contextTokens, 800);
            assert.equal(row.promptVersion, NEXT_PREMARKET_PROMPT_VERSION);
            assert.equal(row.semanticPromptHash, hash(NEXT_PREMARKET_PROMPT));
            assert.equal(row.inputCoverage.fiveMinuteBars, 30);
        }
    } finally { f.providers.close(); }
});

test('real local parsers reject the opposite BUY instead of replacing it with the signal BUY', async () => {
    const f = providerFixture({ layaAction: 'BUY_UP', routerAction: 'BUY_UP' }), s = snapshot();
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        const rows = await Promise.all(['laya', 'router'].map(name => f.providers.predict(name, s)));
        for (const row of rows) {
            assert.equal(row.status, 'provider_error'); assert.equal(row.reason, 'disallowed_action');
            assert.equal(row.action, 'SKIP');
        }
        assert.throws(() => normalizeRouterResponse(routerResponse('BUY_UP'), config, s,
            ['BUY_UP', 'BUY_DOWN', 'SKIP']), /disallowed_action/, 'caller cannot widen derived mask');
    } finally { f.providers.close(); }
});

test('no pattern accepts SKIP from both providers and forbids every BUY', async () => {
    for (const chosen of ['SKIP', 'BUY_UP', 'BUY_DOWN']) {
        const f = providerFixture({ layaAction: chosen, routerAction: chosen }), s = snapshot([1, 1, 1, 1]);
        try {
            s.commonInput = await f.providers.prepareSnapshot(s); assert.deepEqual(s.commonInput.allowed, ['SKIP']);
            const rows = await Promise.all(['laya', 'router'].map(name => f.providers.predict(name, s)));
            assert.deepEqual(rows.map(row => row.action), ['SKIP', 'SKIP']);
            assert.deepEqual(rows.map(row => row.status), chosen === 'SKIP' ? ['ok', 'ok'] : ['provider_error', 'provider_error']);
        } finally { f.providers.close(); }
    }
});

test('after-open deadline is bounded by thirty seconds from capture and ninety seconds from opening', async () => {
    const f = providerFixture();
    try {
        for (const deadline of [at, at + 30001, open + 90001]) {
            const s = snapshot(); s.aiDeadlineAt = deadline;
            assert.equal((await f.providers.predict('router', s)).status, 'decision_budget_invalid');
        }
        const s = snapshot(); s.commonInput = await f.providers.prepareSnapshot(s);
        assert.equal((await f.providers.predict('router', s)).status, 'ok');
        const later = snapshot(); later.at = open + 70000; later.aiDeadlineAt = open + 90001;
        assert.equal((await f.providers.predict('router', later)).status, 'decision_budget_invalid');
    } finally { f.providers.close(); }
});

test('widened persisted action masks and altered prompt identity are rejected before inference', async () => {
    for (const mutate of [s => { s.commonInput.allowed.unshift('BUY_UP'); },
        s => { s.commonInput.semanticPromptHash = hash(EARLY_PREMARKET_PROMPT); }]) {
        const f = providerFixture(), s = snapshot();
        try {
            s.commonInput = await f.providers.prepareSnapshot(s); mutate(s);
            for (const name of ['laya', 'router']) {
                const row = await f.providers.predict(name, s);
                assert.equal(row.reason, 'shared_context_unverified'); assert.equal(row.requestSubmitted, false);
            }
            assert.equal(f.requests.length, 0);
        } finally { f.providers.close(); }
    }
});

test('overflow, truncation, tokenizer changes and wrong returned usage fail closed', async () => {
    for (const count of [{ tokens: 1025 }, { truncated: true }, { instructionTruncated: true },
        { optionsTruncated: true }, { stateTruncated: true }, { identity: 'changed' }]) {
        const f = providerFixture({ count });
        try { await assert.rejects(f.providers.prepareSnapshot(snapshot()), /shared_context_invalid/); assert.equal(f.requests.length, 0); }
        finally { f.providers.close(); }
    }
    const f = providerFixture({ returnedTokens: 799 }), s = snapshot();
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        assert.equal((await f.providers.predict('laya', s)).reason, 'token_usage_mismatch');
    } finally { f.providers.close(); }
});

test('actual installed tokenizer accepts full next confirmation evidence without truncation', {
    skip: process.env.NEXT_CONTEXT_TOKENIZER_TESTS !== '1'
}, async t => {
    const counter = new ProtocolCounter({ root: fileURLToPath(new URL('../../', import.meta.url)),
        layaContainer: process.env.AI_SHADOW_LAYA_CONTAINER || 'laya-server' });
    try {
        const info = await counter.start(); assert.equal(info.maxTokens, 1024);
        for (const directions of [[1, 1, 1, -1], [-1, -1, -1, 1], [0, 0, 0, 0]]) {
            const s = snapshot(directions);
            s.books = [0, 1].map(() => ({ bids: Array.from({ length: 5 }, (_, i) => ({ price: .49 - i * .01, size: 120.51 + i * 32.91 })),
                asks: Array.from({ length: 5 }, (_, i) => ({ price: .5 + i * .01, size: 140.51 + i * 32.91 })) }));
            const encoded = buildPremarketInput(s, config), result = await counter.count(encoded.input, NEXT_PREMARKET_QUESTIONS);
            t.diagnostic(`Full next 30x5m: ${JSON.stringify(result)}`);
            assert.equal(result.valid, true); assert.ok(result.tokens <= 1024); assert.equal(result.identity, info.identity);
            assert.equal(encoded.context.bars.length, 30); assert.equal(encoded.inputCoverage.truncated, false);
        }
    } finally { counter.close(); }
});
