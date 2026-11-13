import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { PREMARKET_ARMS } from '../../src/premarket-paper/config.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketProviders } from '../../src/premarket-paper/providers.js';
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';

function fixture(t, answer) {
    const open = Date.parse('2026-10-26T00:10:00Z'), scheduledAt = open - 240000;
    let now = scheduledAt, availableShares = 10;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-router-engine-'));
    const config = { id: 'router-engine-test', dataDir, policy: {}, sources: [], armNames: [...PREMARKET_ARMS],
        activeArms: ['router-premarket'], capital: 20, shares: 5, entryCap: 5, leadSeconds: 240,
        slots: [90, 60, 30], slotToleranceMs: 2000, dataAgeMs: 5000, maxGapMs: 5000,
        diagnosticHistoryMs: 900000, latencyMs: 250, settlementMs: 2500, reportMs: 60000,
        gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, costCapPerShare: .85,
        drawdownStop: 10, aiDecisionMs: 30000, providerDrainMs: 1000,
        providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' },
        routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium', ninerouterUrl: 'http://router.invalid/v1',
        ninerouterKey: 'synthetic-test-key', layaUrl: 'http://laya.invalid',
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const btc = new BtcSignal(config.control.lateSignal);
    for (let at = now - 185000; at <= now; at += 1000) {
        for (const topic of ['prices.crypto', 'prices.crypto.twap']) btc.ingest({ type: 'update', topic,
            payload: { symbol: 'btcusd', timestamp: at, value: 83000 + (at - scheduledAt) / 1000,
                ...(topic.endsWith('.twap') ? { windowSeconds: 60 } : {}) } }, at);
    }
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const books = () => market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: now, fetchedAt: now, bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: availableShares }] }));
    const stream = { generation: 1, tokens: market.tokens, watch() {}, close() {}, snapshot: books };
    const events = [], calls = [], store = new PremarketPaperStore(config, now);
    store.event = (type, detail = {}) => { store.save(); events.push({ type, ...structuredClone(detail) }); };
    const providers = new PremarketProviders(config, store.state.providers, (type, detail) => store.event(type, detail), {
        clock: () => now,
        counter: { start() { assert.fail('router-only run must not initialize the Laya tokenizer'); }, close() {} },
        fetch: async (url, init = {}) => {
            calls.push({ url, method: init.method || 'GET' });
            if (url === `${config.ninerouterUrl}/models`) return Response.json({ data: [{ id: config.routerModel, owned_by: 'codex' }] });
            assert.equal(url, `${config.ninerouterUrl}/chat/completions`);
            assert.equal(init.method, 'POST');
            const request = JSON.parse(init.body), input = JSON.parse(request.messages.at(-1).content);
            assert.equal(request.model, config.routerModel);
            assert.equal(request.stream, false);
            assert.equal(input.opening_twap, null);
            assert.equal(input.seconds_to_open, 240);
            assert.deepEqual(input.allowed, ['BUY_UP', 'BUY_DOWN', 'SKIP']);
            assert.equal(input.entry_up_down[0].shares, 5);
            assert.ok(input.entry_up_down[0].total_cost_usd > 5 * .51);
            const content = typeof answer === 'string' ? answer : JSON.stringify({ snapshotId: input.snapshotId, ...answer });
            return Response.json({ model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop',
                message: { role: 'assistant', content } }], usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 } });
        }
    });
    const client = { btc, startBtcFeed() {}, close() {}, serverTime: async () => now,
        market: async () => structuredClone(market), books: async () => books(), payout: async () => null };
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, makeBooks: () => stream, providers });
    engine.markets.set(market.slug, market); engine.streams.set(market.slug, stream);
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.history.capture(btc, now);
    const key = `${market.slug}:premarket`;
    store.state.slots[key] = { scheduledAt, status: 'reserved' };
    store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    t.after(async () => { await engine.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    return { config, store, engine, market, events, calls,
        advance(ms) { now += ms; }, depth(shares) { availableShares = shares; },
        get arm() { return store.state.arms['router-premarket']; },
        get decision() { return store.state.snapshots[0].decisions['router-premarket']; },
        async observe() { await engine.observePremarket(market.slug, scheduledAt, key); await Promise.all([...engine.tasks]); }
    };
}

for (const [action, probability, index] of [['BUY_UP', .8, 0], ['BUY_DOWN', .2, 1]]) {
    test(`real router adapter carries ${action} through fresh delayed paper FAK execution`, async t => {
        const f = fixture(t, { action, estimatedUpProbability: probability, reasonCode: 'positive_edge',
            rationale: 'Synthetic supplied evidence supports this side above its all-in break-even cost.' });
        await f.observe();
        assert.deepEqual(f.calls.map(call => call.url), [`${f.config.ninerouterUrl}/models`, `${f.config.ninerouterUrl}/chat/completions`]);
        assert.equal(f.decision.status, 'ok'); assert.equal(f.decision.action, action);
        assert.equal(f.decision.rawAction, action); assert.equal(f.decision.entryDisposition, 'reserved');
        assert.ok(f.decision.expectedNetUsd[action] > 0);
        assert.equal(f.arm.positions[f.market.slug].order.index, index);
        assert.equal(f.arm.positions[f.market.slug].order.price, .51);
        assert.equal(f.arm.cash, 20);
        f.advance(249); f.engine.executePending();
        assert.equal(f.arm.positions[f.market.slug].status, 'pending');
        f.depth(2); f.advance(1); f.engine.executePending();
        const position = f.arm.positions[f.market.slug];
        assert.equal(position.status, 'matched'); assert.equal(position.holdings, 2);
        assert.equal(position.fill.notional, 1); assert.ok(f.arm.cash < 19);
        assert.equal(f.events.filter(event => event.type === 'fill_matched').length, 1);
        const event = f.events.find(event => event.type === 'provider_decision');
        assert.equal(event.action, action); assert.equal(event.reasonCode, 'positive_edge');
        for (const name of PREMARKET_ARMS.filter(name => name !== 'router-premarket')) {
            assert.equal(f.store.state.arms[name].cash, 20);
            assert.deepEqual(f.store.state.arms[name].positions, {});
        }
    });
}

test('valid router abstention remains an explained successful decision with no paper fill', async t => {
    const rationale = 'The small estimated Up lean does not cover fees and the fixed limit cost.';
    const f = fixture(t, { action: 'SKIP', estimatedUpProbability: .51,
        reasonCode: 'no_positive_edge', rationale });
    await f.observe(); f.advance(250); f.engine.executePending();
    assert.equal(f.decision.status, 'ok'); assert.equal(f.decision.rawAction, 'SKIP');
    assert.equal(f.decision.entryDisposition, 'provider_skip');
    assert.equal(f.decision.estimatedUpProbability, .51);
    assert.equal(f.decision.reasonCode, 'no_positive_edge'); assert.equal(f.decision.rationale, rationale);
    assert.ok(f.decision.expectedNetUsd.BUY_UP < 0); assert.ok(f.decision.expectedNetUsd.BUY_DOWN < 0);
    assert.equal(f.arm.outcomes[f.market.slug].reason, 'provider_skip');
    assert.deepEqual(f.arm.positions, {}); assert.equal(f.arm.cash, 20);
    assert.equal(f.events.some(event => event.type === 'fill_matched'), false);
    const event = f.events.find(event => event.type === 'provider_decision');
    assert.equal(event.status, 'ok'); assert.equal(event.reasonCode, 'no_positive_edge');
    assert.equal(event.rationale, rationale); assert.deepEqual(event.expectedNetUsd, f.decision.expectedNetUsd);
});

test('malformed router output becomes a provider error distinct from a valid abstention', async t => {
    for (const answer of ['{invalid JSON', { action: 'BUY_UP' }]) {
        const f = fixture(t, answer);
        await f.observe(); f.advance(250); f.engine.executePending();
        assert.equal(f.decision.status, 'provider_error'); assert.equal(f.decision.action, 'SKIP');
        assert.equal(f.decision.reason, 'invalid_response'); assert.equal(f.decision.requestSubmitted, true);
        assert.equal(f.decision.entryDisposition, 'provider_error');
        assert.equal(f.decision.reasonCode, undefined);
        assert.equal(f.arm.outcomes[f.market.slug].reason, 'provider_error');
        assert.deepEqual(f.arm.positions, {}); assert.equal(f.arm.cash, 20);
        assert.equal(f.events.some(event => event.type === 'fill_matched'), false);
        const event = f.events.find(event => event.type === 'provider_decision');
        assert.equal(event.status, 'provider_error'); assert.equal(event.reason, 'invalid_response');
    }
});

test('execution revalidation failure preserves a valid router BUY and bounds its error diagnostics', async t => {
    for (const mode of ['identity_changed', 'unsafe_transport_error']) {
        const f = fixture(t, { action: 'BUY_UP', estimatedUpProbability: .8, reasonCode: 'positive_edge',
            rationale: 'Synthetic supplied evidence supports Up above its all-in break-even cost.' });
        let reads = 0;
        f.engine.client.market = async () => {
            if (++reads === 1) return structuredClone(f.market);
            f.advance(17);
            if (mode === 'identity_changed') return { ...structuredClone(f.market), conditionId: 'different-condition' };
            throw new Error(`UNSAFE_TRANSPORT_DETAIL ${'x'.repeat(250)}`);
        };
        await f.observe(); f.advance(250); f.engine.executePending();
        const expectedCode = mode === 'identity_changed' ? 'market_identity_mismatch' : 'operation_failed';
        assert.equal(reads, 2);
        assert.equal(f.decision.status, 'ok'); assert.equal(f.decision.action, 'BUY_UP');
        assert.equal(f.decision.rawAction, 'BUY_UP'); assert.equal(f.decision.reasonCode, 'positive_edge');
        assert.equal(f.decision.receivedAt, f.market.open - 240000);
        assert.equal(f.decision.entryDisposition, 'execution_validation_failed');
        assert.equal(f.decision.executionValidationCode, expectedCode);
        assert.equal(f.arm.outcomes[f.market.slug].reason, 'execution_validation_failed');
        assert.equal(f.arm.outcomes[f.market.slug].code, expectedCode);
        assert.equal(f.arm.cash, 20); assert.deepEqual(f.arm.positions, {});
        assert.equal(f.events.some(event => ['order_pending', 'fill_matched'].includes(event.type)), false);
        const decisions = f.events.filter(event => event.type === 'provider_decision');
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0].status, 'ok'); assert.equal(decisions[0].action, 'BUY_UP');
        assert.equal(decisions[0].rawAction, 'BUY_UP'); assert.equal(decisions[0].receivedAt, f.decision.receivedAt);
        assert.equal(decisions[0].entryDisposition, 'execution_validation_failed');
        assert.equal(decisions[0].executionValidationCode, expectedCode);
        assert.equal(f.store.state.errors[`execution_validation:${expectedCode}`], 1);
        assert.equal(JSON.stringify(f.events).includes('UNSAFE_TRANSPORT_DETAIL'), false);
    }
});
