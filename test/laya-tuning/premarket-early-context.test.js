import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EARLY_PROFILE, EARLY_PREMARKET_PROMPT, EARLY_PREMARKET_QUESTIONS,
    earlyPremarketFeatures, earlyReversalDecision, buildEarlyPremarketInput } from '../../src/premarket-paper/early-context.js';
import { buildPremarketInput, PremarketProviders, routerRequest } from '../../src/premarket-paper/providers.js';
import { summarizePremarketPaper, savePremarketPaperReport, readPremarketPaperReports } from '../../src/premarket-paper/report.js';
import { ProtocolCounter } from '../../src/laya-tuning/counter.js';

const at = Date.parse('2026-10-28T10:16:00Z'), end = at - 60000;
const arms = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const active = arms.filter(name => name !== 'late-cost-cap');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = { id: 'early-fixture', profile: EARLY_PROFILE, paperOnly: true,
    experiment: 'premarket-three-candles-paper-v1', armNames: arms, activeArms: active,
    inferencePolicy: 'shared-compact-150m-binance-evidence-independent-laya-router-30s-v1',
    capital: 20, shares: 5, entryCap: 5, leadSeconds: 540, candleCount: 30, candleIntervalMs: 300000,
    historyMs: 9000000, diagnosticHistoryMs: 9000000, candleCacheMaxAgeMs: 90000, slotToleranceMs: 2000,
    signalParameters: { minimumPriorStreak: 3 }, aiDecisionMs: 30000, providerDrainMs: 1000,
    routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium',
    layaUrl: 'http://laya.example', ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'fixture' };

function history(directions = [1, 1, 1, -1]) {
    const changes = [...Array(30 - directions.length).fill(0), ...directions];
    const bars = changes.map((direction, i) => {
        const open = 80000.003 + i * 2, close = open + direction;
        return { openAt: end - (30 - i) * 300000, closeAt: end - (29 - i) * 300000,
            open, high: Math.max(open, close) + .12, low: Math.min(open, close) - .17, close,
            volume: 1, trades: 10, observedAt: end + 10000 };
    });
    return { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: end - 9000000, windowEnd: end, expectedLatestClosedAt: end,
        observedAt: end + 10000, fetchedAt: end + 10000, bars };
}
function snapshot(directions) {
    const market = { slug: 'btc-updown-5m-early', open: at + 540000, end: at + 840000 };
    return { snapshotId: 'early-shared-fixture', scheduledAt: at, at, aiDeadlineAt: at + 30000, market,
        features: earlyPremarketFeatures(history(directions), market, at, config),
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 12 }] })),
        orders: { BUY_UP: { price: .51, shares: 5, cost: 2.68747 }, BUY_DOWN: { price: .51, shares: 5, cost: 2.68747 } } };
}

test('early evidence contains thirty native closed five-minute bars before the future target', () => {
    const s = snapshot(), before = structuredClone(s), encoded = buildPremarketInput(s, config);
    assert.deepEqual(s, before);
    assert.equal(s.features.context.historyStartAt, Date.parse('2026-10-28T07:45:00Z'));
    assert.equal(s.features.context.historyEndAt, Date.parse('2026-10-28T10:15:00Z'));
    assert.equal(encoded.context.marketOpenAt, Date.parse('2026-10-28T10:25:00Z'));
    assert.equal(encoded.context.marketEndAt, Date.parse('2026-10-28T10:30:00Z'));
    assert.equal(encoded.inputCoverage.completeMinutes, 150);
    assert.equal(encoded.inputCoverage.fiveMinuteBars, 30);
    assert.equal(encoded.inputCoverage.minuteBars, 0);
    assert.equal(encoded.inputCoverage.fiveMinuteGroupsDerived, false);
    assert.equal(encoded.inputCoverage.source, 'binance_spot');
    assert.equal(encoded.inputCoverage.truncated, false);
    assert.deepEqual(Object.keys(encoded.context.returnsUsd), ['m5', 'm15', 'm30', 'm60', 'm150']);
    assert.equal(encoded.context.returnsUsd.m5, -1);
    assert.ok(encoded.context.sigmaUsdSqrtSecond > 0);
    assert.equal(encoded.inputHash, hash(encoded.input));
    assert.equal(encoded.inputBytes, Buffer.byteLength(encoded.input));
    assert.match(EARLY_PREMARKET_PROMPT, /540s.*NOT the next candle/);
    assert.match(EARLY_PREMARKET_PROMPT, /Binance BTCUSDT.*not settlement/);
});

test('compact delta encoding reconstructs every shared cent-valued OHLC without losing precision in costs', () => {
    const s = snapshot(); s.orders.BUY_UP.cost = 2.68747001;
    const encoded = buildEarlyPremarketInput(s, config);
    let previous = Math.round(encoded.context.priceAnchorUsd * 100);
    const reconstructed = encoded.input.split('\n').find(line => line.startsWith('OHLC=')).slice(5).split(';').map(row => {
        const [gap, high, low, close] = row.split(' ').map(Number), open = previous + gap;
        previous = open + close; return [open, open + high, open + low, previous].map(value => value / 100);
    });
    assert.equal(reconstructed.length, 30);
    assert.deepEqual(reconstructed, encoded.context.bars);
    assert.deepEqual(reconstructed, s.features.bars.map(bar => ['open', 'high', 'low', 'close'].map(key => Math.round(bar[key] * 100) / 100)));
    assert.equal(encoded.context.entriesUpDown[0].total_cost_usd, 2.68747001);
    assert.match(encoded.input, /2\.68747001/);
    assert.equal(earlyReversalDecision(encoded.context).action, 'BUY_DOWN');
});

test('streak-reversal only selects the first opposing candle after at least three; doji breaks the run', () => {
    for (const [directions, expected] of [
        [[1, 1, 1, -1], 'BUY_DOWN'], [[-1, -1, -1, 1], 'BUY_UP'],
        [[1, 1, 1, 1, -1], 'BUY_DOWN'], [[1, 1, -1], 'SKIP'], [[1, 1, 1, -1, -1], 'SKIP'],
        [[1, 1, 0, 1, -1], 'SKIP'], [[1, 1, 1, 0], 'SKIP'], [[1, 1, 1, 1], 'SKIP'],
    ]) assert.equal(earlyReversalDecision(buildPremarketInput(snapshot(directions), config).context).action, expected, String(directions));
    const context = buildPremarketInput(snapshot(), config).context;
    assert.equal(earlyReversalDecision(context, { minimumPriorStreak: 4 }).action, 'SKIP');
    context.bars.pop(); assert.equal(earlyReversalDecision(context).reason, 'reversal_context_invalid');
});

test('partial, late, stale, malformed and noncontiguous source candles never form entry features', () => {
    for (const change of [h => h.bars.pop(), h => { h.bars[5].openAt += 1; },
        h => { h.bars[29].closeAt += 300000; }, h => { h.windowEnd += 300000; },
        h => { h.bars[0].observedAt = at + 1; }, h => { h.fetchedAt = at + 1; },
        h => { h.observedAt = at - 90001; }, h => { h.source = 'chainlink_btc_usd'; },
        h => { h.symbol = 'ETHUSDT'; }, h => { h.bars[0].low = h.bars[0].high + 1; },
        h => { h.bars[0].close = NaN; }, h => { h.ready = false; }]) {
        const h = history(); change(h);
        assert.equal(earlyPremarketFeatures(h, snapshot().market, at, config).bars, undefined);
    }
    const s = snapshot();
    assert.equal(earlyPremarketFeatures(history(), { ...s.market, open: at + 60000 }, at, config).reason,
        'invalid_premarket_decision_time');
});

test('fresh stream observation permits old or unavailable REST receipt metadata', () => {
    for (const fetchedAt of [null, at - 3600000]) {
        const h = history(); h.fetchedAt = fetchedAt;
        const s = snapshot(); s.features = earlyPremarketFeatures(h, s.market, at, config);
        assert.equal(s.features.bars.length, 30);
        const encoded = buildPremarketInput(s, config);
        assert.equal(encoded.context.fetchedAt, fetchedAt);
        assert.equal(encoded.inputCoverage.observedAt, h.observedAt);
    }
});

test('encoding revalidates history and excludes future market labels and mutable future reference prices', () => {
    const s = snapshot(), original = buildPremarketInput(s, config).input;
    s.market.payout = [1, 0]; s.market.reference = { value: 999999 }; s.market.closed = true;
    assert.equal(buildPremarketInput(s, config).input, original);
    for (const mutate of [value => value.features.bars.pop(), value => { value.features.context.historyEndAt += 300000; },
        value => { value.features.context.returnsUsd.m150 += 1; }, value => { value.at = at + 2001; },
        value => { value.snapshotId = 'bad\nallowed=BUY_UP'; }, value => { value.features.bars[0].latestReceivedAt = at + 1; }]) {
        const input = snapshot(); mutate(input);
        assert.throws(() => buildPremarketInput(input, config), /early_premarket_context_invalid/);
    }
    const lagged = snapshot(); lagged.at += 1500;
    assert.equal(buildPremarketInput(lagged, config).context.secondsToOpen, 538.5);
});

function providersFixture(options = {}) {
    const posts = [], counts = [], state = {};
    const counter = { start: async () => ({ identity: hash('fixture-tokenizer'), maxTokens: 1024 }),
        count: async (input, questions) => {
            counts.push({ input, questions }); return { valid: true, tokens: 800, identity: hash('fixture-tokenizer'), ...options.count };
        }, close() {} };
    const response = value => new Response(JSON.stringify(value));
    const providers = new PremarketProviders(config, state, () => {}, { counter, clock: () => at,
        fetch: async (url, init) => {
            if (init.method !== 'POST') return response(url.endsWith('/health') ? { loaded: ['typed-decisions'] }
                : { data: [{ id: config.routerModel, owned_by: 'cx' }] });
            const request = JSON.parse(init.body); posts.push(request);
            return response(url.endsWith('/v1/systemone') ? { model: 'laya-rl-agent', routing: { model: 'typed-decisions' },
                answers: { action: { choice: 'BUY_UP', probabilities: { BUY_UP: .6, BUY_DOWN: .2, SKIP: .2 } } },
                usage: { input_tokens: options.returnedTokens ?? 800 } }
                : { model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
                    content: JSON.stringify({ snapshotId: 'early-shared-fixture', action: 'BUY_DOWN', reasonCode: 'positive_edge',
                        rationale: 'The first down candle after an up streak suggests a possible reversal.' }) } }] });
        } });
    return { providers, posts, counts };
}

test('deterministic, Laya and router share identical full evidence with actual-token contract and independent choices', async () => {
    const f = providersFixture(), s = snapshot();
    try {
        await f.providers.preflight(); s.commonInput = await f.providers.prepareSnapshot(s);
        assert.equal(earlyReversalDecision(s.commonInput.context).action, 'BUY_DOWN');
        const rows = await Promise.all(['laya', 'router'].map(name => f.providers.predict(name, s)));
        assert.deepEqual(rows.map(row => row.status), ['ok', 'ok']);
        assert.deepEqual(rows.map(row => row.action), ['BUY_UP', 'BUY_DOWN']);
        assert.equal(f.counts.length, 1); assert.deepEqual(f.counts[0].questions, EARLY_PREMARKET_QUESTIONS);
        assert.equal(f.posts[0].state, f.posts[1].messages[1].content);
        assert.equal(f.posts[0].questions.action.instructions, EARLY_PREMARKET_PROMPT);
        assert.ok(f.posts[1].messages[0].content.startsWith(EARLY_PREMARKET_PROMPT));
        assert.equal(routerRequest(config, s.commonInput).model, config.routerModel);
        for (const row of rows) {
            assert.equal(row.inputHash, s.commonInput.inputHash); assert.equal(row.contextTokens, 800);
            assert.equal(row.semanticPromptHash, hash(EARLY_PREMARKET_PROMPT));
            assert.equal(row.inputCoverage.fiveMinuteBars, 30);
        }
    } finally { f.providers.close(); }
});

test('invalid actual tokenizer coverage blocks shared preparation before any provider request', async () => {
    for (const count of [{ tokens: 1025, valid: false }, { truncated: true }, { instructionTruncated: true },
        { stateTruncated: true }, { identity: 'changed' }]) {
        const f = providersFixture({ count });
        try { await assert.rejects(f.providers.prepareSnapshot(snapshot()), /shared_context_invalid/); assert.equal(f.posts.length, 0); }
        finally { f.providers.close(); }
    }
});

test('tampered common evidence and incorrect Laya token accounting fail closed', async () => {
    const f = providersFixture({ returnedTokens: 799 }), s = snapshot();
    try {
        s.commonInput = await f.providers.prepareSnapshot(s);
        assert.equal((await f.providers.predict('laya', s)).reason, 'token_usage_mismatch');
        s.commonInput.semanticPromptHash = hash('old-near-open-prompt');
        assert.equal((await f.providers.predict('router', s)).reason, 'shared_context_unverified');
        assert.equal(f.posts.length, 1);
    } finally { f.providers.close(); }
});

function reportFixture() {
    const s = snapshot(), slug = s.market.slug;
    const common = s.commonInput = { ...buildPremarketInput(s, config), contextVerified: true,
        contextTokens: 800, contextIdentity: hash('fixture-tokenizer'), semanticPromptHash: hash(EARLY_PREMARKET_PROMPT) };
    Object.assign(s, { decisionCutoffAt: at + 30000, fairExecution: { status: 'skipped', scheduledAt: at + 30000,
        deadlineAt: at + 32000, adjudicatedAt: at + 30000, reason: 'no_eligible_decisions' },
        decisions: Object.fromEntries(active.map(name => [name, { status: 'ok', action: 'SKIP',
            inputHash: common.inputHash, inputCoverage: common.inputCoverage,
            offeredInputHash: common.inputHash, offeredInputCoverage: common.inputCoverage,
            contextTokens: 800, contextIdentity: common.contextIdentity, contextVerified: true,
            semanticPromptHash: common.semanticPromptHash, offeredSemanticPromptHash: common.semanticPromptHash,
            requestSubmitted: name !== 'premarket-momentum', startedAt: at, receivedAt: at + 30000 }])) });
    const state = { id: config.id, startedAt: at, snapshots: [s], slots: {},
        markets: { [slug]: { ...s.market, enrolledAt: at, payout: [1, 0], labelResolvedAt: at + 850000 } },
        arms: Object.fromEntries(arms.map(name => [name, { cash: 20, peak: 20, drawdown: 0, positions: {}, completed: [],
            outcomes: { [slug]: { noExposure: true, pnl: 0, reason: name === 'late-cost-cap' ? 'arm_not_selected' : 'provider_skip' } } }])) };
    return { state, snapshot: s };
}

test('early reports verify 150-minute common evidence and retain three-arm cohort and deterministic display label', t => {
    const { state } = reportFixture(), before = structuredClone(state);
    const report = summarizePremarketPaper(state, config, at + 900000);
    assert.deepEqual(state, before); assert.equal(report.comparability.status, 'verified', JSON.stringify(report.comparability));
    assert.equal(report.controlLabel, 'streak-reversal'); assert.equal(report.controlArm, 'premarket-momentum');
    assert.equal(report.historyRequirements.historyMs, 9000000);
    assert.equal(report.historyRequirements.uninterruptedLiveWarmupRequired, false);
    assert.equal(report.historyRequirements.native5mCandleCount, 30);
    assert.equal(report.historyRequirements.outcomeSource, 'official_ctf_payout');
    assert.equal(report.commonCohort.markets, 1); assert.equal(report.pairedComparisons['router-premarket'].markets, 1);
    assert.equal(report.hypothesis.momentumRuleActive, false); assert.equal(report.hypothesis.streakReversalRuleActive, true);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-paper-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    savePremarketPaperReport({ ...config, dataDir }, state, at + 900000);
    const markdown = fs.readFileSync(path.join(dataDir, config.id, 'reports/latest.md'), 'utf8');
    assert.match(markdown, /streak-reversal/); assert.match(markdown, /150 menit/);
    assert.doesNotMatch(markdown, /enam kelompok|Warmup LIVE utuh/);
    fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id: config.id, paperOnly: true }));
    fs.writeFileSync(path.join(dataDir, config.id, 'manifest.json'), JSON.stringify({ id: config.id, paperOnly: true, policy: config }));
    fs.writeFileSync(path.join(dataDir, config.id, 'ledger.json'), JSON.stringify(state));
    assert.equal(readPremarketPaperReports({ dataDir }).profile, EARLY_PROFILE);
});

test('early comparability rejects wrong source, target time, abbreviated history and post-decision receipt', () => {
    for (const mutate of [s => { s.commonInput.inputCoverage.source = 'chainlink_btc_usd'; },
        s => { s.commonInput.inputCoverage.marketOpenAt -= 300000; }, s => { s.commonInput.inputCoverage.fiveMinuteBars = 29; },
        s => { s.commonInput.inputCoverage.fetchedAt = at + 1; }, s => { s.features.bars.pop(); }]) {
        const { state, snapshot: s } = reportFixture(); mutate(s);
        assert.equal(summarizePremarketPaper(state, config, at + 900000).comparability.status, 'incomplete');
    }
});

test('early report recognizes uniform pre-input skips at the nine-minute lead', () => {
    const { state, snapshot: s } = reportFixture(), slug = s.market.slug;
    state.snapshots = [];
    state.slots[`${slug}:premarket`] = { status: 'skipped', reason: 'candle_history_stale', scheduledAt: at };
    for (const name of active) state.arms[name].outcomes[slug] = { noExposure: true, pnl: 0,
        reason: 'observation_failed', code: 'candle_history_stale' };
    const report = summarizePremarketPaper(state, config, at + 900000);
    assert.equal(report.comparability.status, 'verified');
    assert.equal(report.comparability.verifiedUniformSkippedMarkets, 1);
    assert.equal(report.comparability.rows[0].inputCoverage, null);
    state.slots[`${slug}:premarket`].scheduledAt = s.market.open - 60000;
    assert.equal(summarizePremarketPaper(state, config, at + 900000).comparability.status, 'incomplete');
});

test('early report preserves optional old REST metadata when stream observation is fresh', () => {
    for (const fetchedAt of [null, at - 3600000]) {
        const { state, snapshot: s } = reportFixture();
        s.commonInput.inputCoverage.fetchedAt = fetchedAt;
        assert.equal(summarizePremarketPaper(state, config, at + 900000).comparability.status, 'verified');
    }
});

test('actual installed tokenizer keeps full early contexts or rejects overflow without truncation', {
    skip: process.env.EARLY_CONTEXT_TOKENIZER_TESTS !== '1'
}, async t => {
    const counter = new ProtocolCounter({ root: fileURLToPath(new URL('../../', import.meta.url)),
        layaContainer: process.env.AI_SHADOW_LAYA_CONTAINER || 'laya-server' });
    try {
        const info = await counter.start(); assert.equal(info.maxTokens, 1024);
        for (const directions of [[1, 1, 1, -1], [-1, -1, -1, 1], [0, 0, 0, 0]]) {
            const s = snapshot(directions);
            s.books = [0, 1].map(() => ({ bids: Array.from({ length: 5 }, (_, i) => ({ price: .49 - i * .01, size: 120.51 + i * 32.91 })),
                asks: Array.from({ length: 5 }, (_, i) => ({ price: .5 + i * .01, size: 140.51 + i * 32.91 })) }));
            const encoded = buildPremarketInput(s, config), result = await counter.count(encoded.input, EARLY_PREMARKET_QUESTIONS);
            t.diagnostic(`Full 30x5m: ${JSON.stringify(result)}`);
            assert.equal(result.valid, true); assert.ok(result.tokens <= 1024); assert.equal(result.identity, info.identity);
            assert.equal(encoded.context.bars.length, 30); assert.equal(encoded.inputCoverage.truncated, false);
        }
    } finally { counter.close(); }
});
