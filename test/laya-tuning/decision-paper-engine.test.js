import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { DecisionPaperEngine } from '../../src/decision-paper/engine.js';
import { ADAPTIVE_TIMEOUT_POLICY } from '../../src/laya-filter-paper/decision-budget.js';
const DECISION_ARMS = ['laya', 'gemini', 'eligible', 'skip'];

async function fixture({ verify = true, beforeInference, filtered = false } = {}) {
    let now = Date.parse('2026-10-20T00:03:30Z');
    const armNames = filtered ? [...DECISION_ARMS, 'laya-filtered'] : DECISION_ARMS;
    const config = { armNames, deadline: Number.MAX_SAFE_INTEGER, slots: [90, 60, 30],
        slotToleranceMs: 2000, capital: 20, shares: 5, entryCap: 5, gasUsd: .05, latencyMs: 250,
        settlementMs: 2500, dataAgeMs: 5000, decisionMs: 3000, drawdownStop: 10, shadowDrawdownStop: 2,
        limitSlippageTicks: 1, limitSlippageUsd: .01,
        decisionProtocol: { variantId: 'candidate-v2' },
        decisionTimeoutPolicy: ADAPTIVE_TIMEOUT_POLICY, inferenceReserveMs: 150,
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const btc = new BtcSignal(config.control.lateSignal);
    for (let i = -185; i <= 0; i++) btc.ingest({ topic: 'prices.crypto', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now + i * 1000, value: 83020 + (filtered ? Math.sin(i) : 0) } }, now + i * 1000);
    btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now, value: 83020, windowSeconds: 60 } }, now);
    const market = { slug: 'btc-updown-5m-1792454400', conditionId: 'condition', open: now - 210000,
        end: now + 90000, minimum: 5, tick: .01, ticks: [.01, .01], accepting: true,
        tokens: ['up', 'down'], fee: { rate: .07, exponent: 1, takerOnly: true } };
    btc.openings.set(market.open, { at: market.open, value: 83000, receivedAt: market.open + 100 });
    market.reference = { source: 'chainlink_twap_60s', open: market.open, end: market.end,
        value: 83000, observedAt: market.open, receivedAt: market.open + 100 };
    let price = .78, size = 10, payout = null;
    const getBooks = () => [
        { tokenId: 'up', conditionId: market.conditionId, tick: .01, timestamp: now, fetchedAt: now,
            bids: [{ price: price - .01, size: 10 }], asks: [{ price, size }] },
        { tokenId: 'down', conditionId: market.conditionId, tick: .01, timestamp: now, fetchedAt: now,
            bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] },
    ];
    const books = { generation: 1, tokens: market.tokens, socket: { readyState: 1 },
        snapshot: () => getBooks(), watch() {}, close() {} };
    const arm = () => ({ cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null,
        seen: {}, position: null, completed: [], outcomes: {} });
    const state = { startedAt: now, frozenAt: null, slots: {}, snapshots: [], markets: {}, providers: {}, errors: {},
        arms: Object.fromEntries(armNames.map(name => [name, arm()])) };
    const events = [], requests = [];
    const store = { state, save() {}, event(type, row) { events.push({ type, ...structuredClone(row) }); },
        error(stage, error) { const key = `${stage}:${error.message}`; state.errors[key] = (state.errors[key] || 0) + 1; },
        freeze(at) { if (at >= config.deadline) state.frozenAt = config.deadline; } };
    const providers = { async predict(name, snapshot) {
        snapshot.inferenceAttempts[name] = true;
        requests.push({ name, input: snapshot.input, inputHash: snapshot.inputHash, snapshotId: snapshot.snapshotId });
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', model: 'typed-decisions',
            requestedAt: now, receivedAt: now, latencyMs: 0, cost: 0 };
    }, close() {} };
    let payoutCalls = 0;
    const client = { btc, books: async () => getBooks(), async payout() { payoutCalls++; return payout; },
        serverTime: async () => now, startBtcFeed() {}, close() {} };
    const options = { clock: () => now, sleep: async ms => { now += ms; }, beforeInference };
    const engine = new DecisionPaperEngine(config, store, client, books, providers, options);
    if (verify) await engine.verifyClock();
    return { config, market, btc, books, state, store, providers, client, engine, events, requests, options,
        getBooks, get now() { return now; }, get payoutCalls() { return payoutCalls; }, advance(ms) { now += ms; },
        price(value) { price = value; }, size(value) { size = value; }, payout(value) { payout = value; },
        observe(seconds = 90) { return engine.observe(market, seconds, `${market.slug}:${seconds}`); } };
}

test('fast response and no-AI entry execute before a slow provider completes', async () => {
    const f = await fixture();
    let releaseGemini;
    const predict = f.providers.predict;
    f.providers.predict = async (name, snapshot) => {
        if (name === 'gemini') await new Promise(resolve => { releaseGemini = resolve; });
        return predict(name, snapshot);
    };
    const observing = f.observe(); await turn();
    assert.equal(typeof releaseGemini, 'function');
    const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.contextError, undefined);
    assert.equal(snapshot.informed.originalInput, snapshot.input);
    assert.equal(snapshot.informed.originalInputHash, snapshot.inputHash);
    assert.equal(f.state.arms.laya.position.status, 'pending');
    assert.equal(f.state.arms.eligible.position.status, 'pending');
    assert.equal(f.state.arms.gemini.position, null);
    assert.equal(f.state.arms.skip.position, null);
    f.advance(250); await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.position.status, 'matched');
    assert.equal(f.state.arms.eligible.position.status, 'matched');
    const frozenInput = snapshot.informed.input;
    f.price(.80); f.advance(500); releaseGemini(); await observing;
    assert.equal(snapshot.informed.input, frozenInput);
    assert.equal(f.state.arms.gemini.position.order.price, .79);
    f.advance(250); await f.engine.manage(f.now);
    assert.equal(f.state.arms.gemini.position, null);
    assert.equal(f.state.arms.gemini.outcomes[f.market.slug].reason, 'no_fill');
    assert.equal(snapshot.decisions.laya.entryDisposition, 'reserved');
    assert.equal(snapshot.providerDecisions.gemini.action, 'BUY_UP');
});

test('provider timeout or rejection leaves independent baselines and other AI intact', async () => {
    for (const failure of ['decision_timeout', 'invalid', 'throw']) {
        const f = await fixture(), predict = f.providers.predict;
        f.providers.predict = async (name, snapshot) => {
            if (name === 'laya') return predict(name, snapshot);
            if (failure === 'throw') throw new Error('private-endpoint-must-not-be-logged');
            return { snapshotId: snapshot.snapshotId, status: failure, action: 'SKIP', cost: null };
        };
        await f.observe();
        assert.equal(f.state.arms.laya.position.status, 'pending');
        assert.equal(f.state.arms.eligible.position.status, 'pending');
        assert.equal(f.state.arms.gemini.position, null);
        assert.equal(f.state.arms.skip.position, null);
        assert.ok(!JSON.stringify(f.state).includes('private-endpoint'));
    }
});

test('late directional answer cannot enter after absolute data freshness deadline', async () => {
    const f = await fixture(), predict = f.providers.predict;
    let release;
    f.providers.predict = async (name, snapshot) => {
        if (name === 'gemini') await new Promise(resolve => { release = resolve; });
        return predict(name, snapshot);
    };
    const observing = f.observe(); await turn(); f.advance(4601); release(); await observing;
    assert.equal(f.state.arms.gemini.position, null);
    assert.equal(f.state.snapshots[0].decisions.gemini.entryDisposition, 'late_response');
    assert.equal(f.state.arms.laya.position.order.price, .79);
});

test('independent partial fills debit and settle exactly once and never chase remaining shares', async () => {
    const f = await fixture(); await f.observe(); f.size(2); f.advance(250); await f.engine.manage(f.now);
    for (const name of ['laya', 'gemini', 'eligible']) assert.equal(f.state.arms[name].position.fill.shares, 2);
    f.advance(2500); await f.engine.manage(f.now); f.advance(1000); await f.engine.manage(f.now);
    const cash = f.state.arms.laya.cash;
    f.size(10);
    f.btc.ingest({ topic: 'prices.crypto', type: 'update', payload: { symbol: 'btcusd', timestamp: f.now, value: 83020 } }, f.now);
    f.btc.ingest({ topic: 'prices.crypto.twap', type: 'update', payload: { symbol: 'btcusd', timestamp: f.now, value: 83020, windowSeconds: 60 } }, f.now);
    await f.observe(60);
    assert.equal(f.requests.length, 2);
    assert.equal(f.state.arms.laya.cash, cash);
    f.advance(90000); f.payout([1, 0]); await f.engine.manage(f.now); await f.engine.manage(f.now);
    for (const name of ['laya', 'gemini', 'eligible']) {
        assert.equal(f.state.arms[name].completed.length, 1);
        assert.equal(f.state.arms[name].completed[0].shares, 2);
        assert.equal(f.state.arms[name].position, null);
    }
    assert.equal(f.state.arms.skip.cash, 20);
});

test('persistent stop and insufficient cash block only the affected arm', async () => {
    const f = await fixture();
    f.state.arms.laya.stopped = { at: f.now, reason: 'drawdown_limit' };
    f.state.arms.eligible.cash = 1;
    await f.observe();
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].name, 'gemini');
    assert.equal(f.state.arms.laya.position, null);
    assert.equal(f.state.arms.eligible.position, null);
    assert.equal(f.state.arms.gemini.position.status, 'pending');
    assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, 'arm_stopped');
    assert.equal(f.state.snapshots[0].decisions.eligible.entryDisposition, 'side_or_budget_invalid');
});

test('common inference gate does not issue requests or reserve any entry', async () => {
    const f = await fixture({ beforeInference: async () => false }); await f.observe();
    assert.equal(f.requests.length, 0);
    for (const name of DECISION_ARMS) {
        assert.equal(f.state.arms[name].position, null);
        assert.equal(f.state.snapshots[0].decisions[name].status, 'inference_gate_blocked');
    }
});

test('filtered Laya shares one inference and the exact admission and execution view with its control', async () => {
    const f = await fixture({ filtered: true }); await f.observe();
    const s = f.state.snapshots[0];
    assert.equal(s.filterVerdicts.BUY_UP['laya-filtered'].pass, true);
    assert.equal(f.requests.filter(r => r.name === 'laya').length, 1);
    assert.equal(s.decisions['laya-filtered'].inferenceSource, 'laya');
    assert.equal(s.decisions['laya-filtered'].inferenceAttempted, false);
    assert.equal(f.state.arms.laya.position.activeAt, f.state.arms['laya-filtered'].position.activeAt);
    f.advance(250); await f.engine.manage(f.now);
    const control = f.state.arms.laya.position, candidate = f.state.arms['laya-filtered'].position;
    assert.equal(control.status, 'matched'); assert.equal(candidate.status, 'matched');
    assert.equal(control.executionCohortId, candidate.executionCohortId);
    assert.equal(control.executionBookHash, candidate.executionBookHash);
    assert.deepEqual(control.fill, candidate.fill);
});

test('filter veto records effective SKIP without changing the raw Laya response or consuming an entry attempt', async () => {
    const f = await fixture({ filtered: true });
    f.config.entryFilter = { version: 'direction-volatility-buffer-v1', minBufferSigma: 100, useClosingThreshold: true };
    await f.observe(); const s = f.state.snapshots[0];
    assert.equal(s.providerDecisions.laya.action, 'BUY_UP');
    assert.equal(s.decisions.laya.action, 'BUY_UP');
    assert.equal(s.decisions['laya-filtered'].action, 'SKIP');
    assert.equal(s.decisions['laya-filtered'].executable, false);
    assert.equal(s.decisions['laya-filtered'].originalAction, 'BUY_UP');
    assert.equal(s.decisions['laya-filtered'].entryDisposition, 'filter_veto');
    assert.equal(f.state.arms['laya-filtered'].position, null);
    assert.equal(f.state.arms['laya-filtered'].seen[f.market.slug], undefined);
    assert.equal(f.state.arms.laya.position.status, 'pending');
});

test('stopped original Laya does not prevent the filtered arm sharing a new response', async () => {
    const f = await fixture({ filtered: true });
    f.state.arms.laya.stopped = { at: f.now, reason: 'research_drawdown_limit' };
    await f.observe();
    assert.equal(f.requests.filter(r => r.name === 'laya').length, 1);
    assert.equal(f.state.arms.laya.position, null);
    assert.equal(f.state.arms['laya-filtered'].position.status, 'pending');
    assert.equal(f.state.arms.laya.stopped.reason, 'research_drawdown_limit');
});

test('late shared response cannot enter the filtered arm despite a passing filter', async () => {
    const f = await fixture({ filtered: true }), predict = f.providers.predict;
    f.providers.predict = async (name, snapshot) => {
        if (name === 'laya') f.advance(4601);
        return predict(name, snapshot);
    };
    await f.observe();
    assert.equal(f.state.arms.laya.position, null);
    assert.equal(f.state.arms['laya-filtered'].position, null);
    assert.equal(f.state.snapshots[0].decisions['laya-filtered'].entryDisposition, 'late_response');
});

test('risk-stopped providers continue only explicitly labeled observations without resetting execution stops', async () => {
    const f = await fixture({ filtered: true });
    f.config.providerObservationPolicy = 'continue-after-risk-stop-v1';
    for (const name of ['laya', 'laya-filtered', 'gemini'])
        f.state.arms[name].stopped = { at: f.now, reason: 'research_drawdown_limit' };
    await f.observe();
    assert.equal(f.requests.length, 2);
    for (const name of ['laya', 'gemini']) assert.equal(f.state.snapshots[0].providerDecisions[name].diagnosticOnly, true);
    for (const name of ['laya', 'laya-filtered', 'gemini']) {
        assert.equal(f.state.arms[name].position, null);
        assert.equal(f.state.arms[name].stopped.reason, 'research_drawdown_limit');
    }
});
