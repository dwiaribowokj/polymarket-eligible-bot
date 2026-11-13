import test from 'node:test';
import assert from 'node:assert/strict';
import { premarketFeatures } from '../../src/premarket-paper/features.js';
import { buildPremarketInput, routerRequest, PremarketProviders, NEAR_OPEN_PROMPT_VERSION } from '../../src/premarket-paper/providers.js';

const config = { profile: 'near-open-30m-v1', activeArms: ['router-premarket'], leadSeconds: 60,
    historyMs: 1800000, diagnosticHistoryMs: 1800000, dataAgeMs: 5000, maxGapMs: 5000,
    aiDecisionMs: 30000, providerDrainMs: 1000, routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium',
    ninerouterUrl: 'http://router.example/v1', ninerouterKey: 'test' };
function snapshot() {
    const at = Date.parse('2026-10-27T05:59:00Z'), market = { open: at + 60000, end: at + 360000 };
    const points = Array.from({ length: 901 }, (_, i) => ({ at: at - 1800000 + i * 2000,
        receivedAt: at - 1800000 + i * 2000, value: 80000 + i * .5 + Math.sin(i / 12) * 5 }));
    return { snapshotId: 'long-snapshot', at, aiDeadlineAt: at + 30000, market,
        features: premarketFeatures(points, market, at, config),
        books: [0, 1].map(() => ({ bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 12 }] })),
        orders: { BUY_UP: { price: .51, shares: 5, cost: 2.7 }, BUY_DOWN: { price: .51, shares: 5, cost: 2.7 } } };
}

test('near-open model receives all thirty OHLC bars and six exact aggregates without truncation or outcome leakage', () => {
    const s = snapshot(); s.market.payout = [1, 0]; s.decisions = { action: 'BUY_DOWN' };
    const encoded = buildPremarketInput(s, config), input = JSON.parse(encoded.input);
    assert.equal(input.bars.length, 30); assert.equal(input.context.bars_5m.length, 6);
    assert.equal(input.seconds_to_open, 60); assert.equal(input.context.complete_minutes, 30);
    assert.equal(input.context.window_end_utc, new Date(s.at).toISOString());
    assert.equal(input.context.aggregation_5m, 'consecutive_groups_of_five_completed_1m_bars');
    assert.equal(input.context.returns_usd.m30, Math.round(s.features.context.returnsUsd.m30 * 1e6) / 1e6);
    assert.equal(encoded.inputCoverage.truncated, false); assert.equal(encoded.inputCoverage.minuteBars, 30);
    assert.equal(encoded.inputBytes, Buffer.byteLength(encoded.input)); assert.ok(encoded.inputBytes < 16384);
    assert.equal(encoded.input.includes('payout'), false); assert.equal(encoded.input.includes('decisions'), false);
    assert.match(routerRequest(config, encoded).messages[0].content, /ALL 30 completed/);
});

test('near-open provider refuses shortened, malformed, misaggregated, future, or wrong-window candle contexts', () => {
    for (const mutate of [s => s.features.bars.splice(0, 27), s => { delete s.features.context; },
        s => { s.features.context.bars5m[2].high += 1; }, s => { s.features.context.bars5m.pop(); },
        s => { s.features.context.source = 'unknown'; }, s => { s.features.context.historyStartAt += 1; },
        s => { s.features.context.returnsUsd.m30 = null; }, s => { s.features.bars[0].latestReceivedAt = s.at + 1; },
        s => { delete s.features.observedReceivedAt; }, s => { s.features.observedReceivedAt = s.at + 1; },
        s => { s.features.bars[0].start += 1; s.features.context.historyStartAt += 1; },
        s => { s.market.open += 180000; }, s => { s.features.context.historyEndAt += 60000; }]) {
        const s = snapshot(); mutate(s); assert.throws(() => buildPremarketInput(s, config));
    }
    assert.throws(() => buildPremarketInput(snapshot()), /input_invalid/);
    assert.throws(() => new PremarketProviders({ ...config, activeArms: ['laya-premarket'] }), /requires_router_only/);
});

test('request and failed inference preserve the exact full-context input identity without Laya calls', async () => {
    const s = snapshot(), state = {}, events = [];
    const provider = new PremarketProviders(config, state, (type, detail) => events.push({ type, ...structuredClone(detail) }), {
        clock: () => s.at,
        counter: { start() { assert.fail('No Laya context compression or tokenizer'); }, close() {} },
        fetch: async (url, init = {}) => {
            if (url.endsWith('/models')) return Response.json({ data: [{ id: config.routerModel, owned_by: 'cx' }] });
            const body = JSON.parse(init.body), input = JSON.parse(body.messages.at(-1).content);
            assert.equal(input.bars.length, 30); assert.equal(input.context.bars_5m.length, 6);
            assert.equal(state.router.pending.inputCoverage.minuteBars, 30);
            return Response.json({ error: 'synthetic_http_failure' }, { status: 503 });
        }
    });
    const result = await provider.predict('router', s); provider.close();
    assert.equal(result.status, 'provider_error'); assert.equal(result.action, 'SKIP');
    assert.equal(result.promptVersion, NEAR_OPEN_PROMPT_VERSION);
    assert.deepEqual(result.inputCoverage, buildPremarketInput(s, config).inputCoverage);
    assert.equal(result.inputHash, buildPremarketInput(s, config).inputHash);
    assert.ok(events.some(e => e.type === 'provider_request' && e.inputCoverage.minuteBars === 30));
    assert.equal(state.router.pending, null);
});
