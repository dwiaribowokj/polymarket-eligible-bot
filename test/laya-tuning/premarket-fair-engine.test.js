import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { FAIR_PREMARKET_ARMS, FAIR_SIGNAL_PARAMETERS, PREMARKET_ARMS,
    loadPremarketPaperConfig } from '../../src/premarket-paper/config.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketHistory, premarketFeatures, fairMomentumDecision } from '../../src/premarket-paper/features.js';
import { buildPremarketInput } from '../../src/premarket-paper/providers.js';
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';
import { summarizePremarketPaper } from '../../src/premarket-paper/report.js';

const FAIR_PROFILE = 'fair-near-open-30m-v1';
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const context = (direction = 1) => ({
    bars5m: Array.from({ length: 6 }, (_, i) => direction > 0 ? [100 + i, 102 + i, 100 + i, 101 + i]
        : [100 - i, 100 - i, 98 - i, 99 - i]),
    returnsUsd: { s30: direction, s60: direction, m3: 3 * direction,
        m5: 30 * direction, m15: 90 * direction, m30: 180 * direction }, sigmaUsdSqrtSecond: 1
});
const momentum = value => fairMomentumDecision(value, FAIR_SIGNAL_PARAMETERS);

test('fair profile freezes the complete three-arm cohort, full history, timing and prospective thresholds', () => {
    const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: FAIR_PROFILE }, '/tmp/fair-config-tests');
    assert.deepEqual(config.activeArms, FAIR_PREMARKET_ARMS);
    assert.deepEqual(config.armNames, PREMARKET_ARMS);
    assert.deepEqual(config.historicalReferenceArms, ['late-cost-cap']);
    assert.equal(config.leadSeconds, 60); assert.equal(config.aiDecisionMs, 30000);
    assert.equal(config.candleCount, 30); assert.equal(config.historyMs, 1800000);
    assert.equal(config.diagnosticHistoryMs, 1800000); assert.equal(config.paperOnly, true);
    assert.deepEqual(config.signalParameters, { windowsSeconds: { m5: 300, m15: 900, m30: 1800 },
        minimumNormalizedStrength: { m5: .5, m15: 1, m30: 1 }, minimumAligned5mGroups: 5,
        total5mGroups: 6, reversalWindowSeconds: 60, maximumOpposingReversalUsd: 0, probabilityPolicy: 'none_direction_only' });
    assert.equal(Object.isFrozen(config.signalParameters.minimumNormalizedStrength), true);
    assert.match(config.hypothesisPolicy, /prospective-untuned/);
    for (const arms of ['premarket-momentum', 'router-premarket,laya-premarket', PREMARKET_ARMS.join(',')])
        assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: FAIR_PROFILE,
            PREMARKET_ACTIVE_ARMS: arms }, '/tmp/fair-config-tests'), /premarket_fair_requires_three_arm_cohort/);
    assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: 'near-open-30m-v1',
        PREMARKET_ACTIVE_ARMS: FAIR_PREMARKET_ARMS.join(',') }, '/tmp/fair-config-tests'), /requires_router_only/);
});

test('fair deterministic momentum uses 5m, 15m and 30m agreement with five of six aligned groups', () => {
    for (const direction of [1, -1]) {
        assert.equal(momentum(context(direction)).action, direction > 0 ? 'BUY_UP' : 'BUY_DOWN');
        for (const key of ['m5', 'm15', 'm30']) {
            const input = context(direction); input.returnsUsd[key] *= -1;
            assert.equal(momentum(input).reason, 'momentum_horizons_disagree');
        }
        const input = context(direction);
        [input.bars5m[0][0], input.bars5m[0][3]] = [input.bars5m[0][3], input.bars5m[0][0]];
        assert.equal(momentum(input).aligned5mGroups, 5);
        assert.notEqual(momentum(input).action, 'SKIP');
        [input.bars5m[1][0], input.bars5m[1][3]] = [input.bars5m[1][3], input.bars5m[1][0]];
        assert.equal(momentum(input).reason, 'momentum_group_consistency_not_met');
    }
});

test('fair momentum enforces normalized strength, recent minute reversal and no invented probability', () => {
    for (const direction of [1, -1]) {
        for (const [key, seconds] of Object.entries(FAIR_SIGNAL_PARAMETERS.windowsSeconds)) {
            const input = context(direction), threshold = FAIR_SIGNAL_PARAMETERS.minimumNormalizedStrength[key];
            input.returnsUsd[key] = direction * threshold * Math.sqrt(seconds);
            assert.notEqual(momentum(input).action, 'SKIP');
            input.returnsUsd[key] *= .999;
            assert.equal(momentum(input).reason, 'momentum_strength_not_met');
        }
        const input = context(direction); input.returnsUsd.s60 = -direction * .000001;
        assert.equal(momentum(input).reason, 'momentum_recent_reversal');
        input.returnsUsd.s60 = 0;
        assert.notEqual(momentum(input).action, 'SKIP');
        assert.equal('estimatedUpProbability' in momentum(input), false);
        for (const sigma of [0, null, NaN, Infinity]) {
            input.sigmaUsdSqrtSecond = sigma;
            assert.equal(momentum(input).reason, 'momentum_volatility_unavailable');
        }
    }
});

function fixture(t, { answers = {}, prepare } = {}) {
    const open = Date.parse('2026-10-27T01:05:00Z'), scheduledAt = open - 60000;
    let now = scheduledAt, availableShares = 10, ask = .5, reads = 0;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-fair-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: 'fair-engine-test', profile: FAIR_PROFILE, dataDir, policy: {}, sources: [],
        experiment: 'premarket-three-candles-paper-v1', inferencePolicy: 'shared-compact-30m-evidence-independent-laya-router-30s-v1',
        armNames: [...PREMARKET_ARMS], activeArms: [...FAIR_PREMARKET_ARMS], signalParameters: FAIR_SIGNAL_PARAMETERS,
        providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' },
        capital: 20, shares: 5, entryCap: 5, leadSeconds: 60, aiDecisionMs: 30000,
        slots: [90, 60, 30], slotToleranceMs: 2000, dataAgeMs: 5000, maxGapMs: 5000,
        historyMs: 1800000, diagnosticHistoryMs: 1800000, candleCount: 30, candleIntervalMs: 60000,
        minDays: 7, minMarkets: 100, bootstrapSamples: 20, latencyMs: 250, settlementMs: 2500, reportMs: 60000,
        gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, drawdownStop: 10,
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const btc = new BtcSignal(config.control.lateSignal);
    const feed = at => {
        for (const topic of ['prices.crypto', 'prices.crypto.twap']) btc.ingest({ type: 'update', topic,
            payload: { symbol: 'btcusd', timestamp: at, value: 83000 + (at - scheduledAt) / 1000, windowSeconds: 60 } }, at);
    };
    const books = () => market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: now, fetchedAt: now, bids: [{ price: ask - .01, size: 10 }], asks: [{ price: ask, size: availableShares }] }));
    const stream = { generation: 1, tokens: market.tokens, watch() {}, close() {}, snapshot: books };
    const events = [], calls = [], store = new PremarketPaperStore(config, now);
    store.event = (type, detail = {}) => { events.push({ type, ...structuredClone(detail) }); store.save(); };
    const providers = {
        async prepareSnapshot(snapshot) {
            const encoded = buildPremarketInput(snapshot, config);
            const result = { ...encoded, contextTokens: 750, contextIdentity: 'fixture-tokenizer',
                semanticPromptHash: 'fixture-prompt', contextVerified: true };
            return prepare ? prepare(result) : result;
        },
        async predict(provider, snapshot) {
            calls.push({ provider, snapshot });
            const answer = await (answers[provider] || { status: 'ok', action: 'BUY_UP' });
            return { requestSubmitted: true, ...answer, ...(answer.requestSubmitted === false ? {} : {
                inputHash: snapshot.commonInput.inputHash, inputCoverage: snapshot.commonInput.inputCoverage,
                semanticPromptHash: snapshot.commonInput.semanticPromptHash }) };
        }
    };
    const client = { btc, startBtcFeed() {}, close() {}, serverTime: async () => now,
        market: async () => { reads++; return structuredClone(market); }, books: async () => books(), payout: async () => null };
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, providers });
    for (let at = scheduledAt - 1800000; at <= scheduledAt; at += 1000) {
        feed(at); engine.history.capture({ spot: [{ at, receivedAt: at, value: 83000 + (at - scheduledAt) / 1000 }] }, at);
    }
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.clockRetryAt = now + 20000;
    engine.markets.set(market.slug, market); engine.streams.set(market.slug, stream); engine.discover = async () => {};
    const key = `${market.slug}:premarket`;
    store.state.slots[key] = { scheduledAt, status: 'reserved' };
    store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    return { config, market, store, engine, events, calls, key, scheduledAt,
        get now() { return now; }, get reads() { return reads; }, get snapshot() { return store.state.snapshots[0]; },
        arm(name = 'premarket-momentum') { return store.state.arms[name]; },
        advance(ms, refresh = true) { now += ms; if (refresh) { feed(now); engine.clockVerifiedAt = now; } },
        depth(value) { availableShares = value; }, ask(value) { ask = value; },
        observe() { return engine.observePremarket(market.slug, scheduledAt, key); },
        async idle() { while (engine.tasks.size) await Promise.all([...engine.tasks]); },
        async adjudicate() { engine.scheduleFairExecutions(now); while (engine.tasks.size) await Promise.all([...engine.tasks]); }
    };
}

test('all fair arms consume the same compact evidence and wait for one shared validation and execution time', async t => {
    const laya = deferred(), router = deferred();
    const f = fixture(t, { answers: { laya: laya.promise, router: router.promise } });
    await f.observe();
    assert.equal(f.calls.length, 2); assert.equal(f.reads, 1);
    assert.equal(f.snapshot.features.bars.length, 30);
    assert.equal(f.snapshot.decisionCutoffAt, f.scheduledAt + 30000);
    assert.equal(f.snapshot.decisions['premarket-momentum'].inputHash, f.snapshot.commonInput.inputHash);
    f.advance(100); laya.resolve({ status: 'ok', action: 'BUY_UP' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(f.snapshot.decisions['laya-premarket'].latencyMs, 100);
    f.advance(9900); router.resolve({ status: 'ok', action: 'BUY_UP' }); await f.idle();
    assert.equal(f.snapshot.decisions['router-premarket'].latencyMs, 10000);
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.deepEqual(f.arm(name).positions, {});
        assert.equal(f.snapshot.decisions[name].inputHash, f.snapshot.commonInput.inputHash);
    }
    f.advance(19999); f.engine.scheduleFairExecutions(); assert.equal(f.engine.tasks.size, 0);
    f.advance(1); await f.adjudicate(); assert.equal(f.reads, 2);
    for (const name of FAIR_PREMARKET_ARMS) {
        const position = f.arm(name).positions[f.market.slug];
        assert.equal(position.submittedAt, f.scheduledAt + 30000);
        assert.equal(position.activeAt, f.scheduledAt + 30250);
        assert.equal(position.order.price, .51); assert.equal(position.order.shares, 5);
    }
    f.advance(249); f.engine.executePending();
    assert.equal(FAIR_PREMARKET_ARMS.every(name => f.arm(name).positions[f.market.slug].status === 'pending'), true);
    f.depth(2); f.advance(1);
    const stream = f.engine.streams.get(f.market.slug), snapshotBook = stream.snapshot;
    let executionBookReads = 0;
    stream.snapshot = (...args) => { executionBookReads++; const result = snapshotBook(...args); f.advance(1, false); return result; };
    f.engine.executePending(); assert.equal(executionBookReads, 1);
    const positions = FAIR_PREMARKET_ARMS.map(name => f.arm(name).positions[f.market.slug]);
    assert.equal(new Set(positions.map(position => position.executionBookHash)).size, 1);
    assert.equal(new Set(positions.map(position => position.executionAt)).size, 1);
    assert.equal(new Set(positions.map(position => position.entryCost)).size, 1);
    assert.equal(positions.every(position => position.status === 'matched' && position.holdings === 2), true);
    assert.equal(f.arm('late-cost-cap').outcomes[f.market.slug].reason, 'arm_not_selected');
    assert.equal(f.arm('late-cost-cap').cash, 20);
});

test('momentum acts on common quantized groups instead of the original candle precision', async t => {
    const f = fixture(t, { prepare(input) { input.context.bars5m[0][3] = input.context.bars5m[0][0];
        input.context.bars5m[1][3] = input.context.bars5m[1][0]; return input; } });
    await f.observe(); await f.idle();
    assert.equal(f.snapshot.features.bars.every(bar => bar.close > bar.open), true);
    assert.equal(f.snapshot.decisions['premarket-momentum'].action, 'SKIP');
    assert.equal(f.snapshot.decisions['premarket-momentum'].reason, 'momentum_group_consistency_not_met');
});

test('shared preparation failure blocks all selected decisions and both provider requests', async t => {
    const f = fixture(t, { prepare() { throw new Error('context_token_limit'); } });
    await f.observe().catch(error => f.engine.failObservation(f.market.slug, f.key, error));
    assert.equal(f.calls.length, 0); assert.equal(f.store.state.snapshots.length, 0);
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).outcomes[f.market.slug].reason, 'observation_failed');
        assert.equal(f.arm(name).outcomes[f.market.slug].code, 'context_token_limit');
        assert.deepEqual(f.arm(name).positions, {});
    }
});

test('fair snapshots preserve strict full live warmup and gap rejection', () => {
    const at = Date.parse('2026-10-27T01:04:00Z'), market = { open: at + 60000 };
    const config = { profile: FAIR_PROFILE, historyMs: 1800000, diagnosticHistoryMs: 1800000,
        leadSeconds: 60, maxGapMs: 5000, dataAgeMs: 5000 };
    const points = Array.from({ length: 1801 }, (_, i) => ({ at: at - 1800000 + i * 1000,
        receivedAt: at - 1800000 + i * 1000, value: 83000 + i }));
    const history = new PremarketHistory(config); history.capture({ spot: points }, at);
    assert.equal(history.points.length, 1);
    assert.equal(premarketFeatures(history.points, market, at, config).reason, 'completed_candles_warming');
    assert.equal(premarketFeatures(points.slice(60), market, at, config).reason, 'completed_candles_warming');
    assert.equal(premarketFeatures(points.filter((_, i) => i < 600 || i >= 606), market, at, config).reason, 'btc_history_gap');
    assert.equal(premarketFeatures(points, market, at, config).context.schema, FAIR_PROFILE);
});

test('a response after the shared deadline cannot enter while timely arms retain their common cutoff', async t => {
    const late = deferred(), f = fixture(t, { answers: { router: late.promise } });
    await f.observe();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    f.advance(30000); f.engine.scheduleFairExecutions();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(f.arm('router-premarket').outcomes[f.market.slug].reason, 'provider_late');
    f.advance(1); late.resolve({ status: 'ok', action: 'BUY_UP' }); await f.idle();
    assert.deepEqual(f.arm('router-premarket').positions, {});
    for (const name of ['premarket-momentum', 'laya-premarket'])
        assert.equal(f.arm(name).positions[f.market.slug].submittedAt, f.scheduledAt + 30000);
});

test('shared validation failures, cutoff, and delayed scheduling cannot advantage one fair arm', async t => {
    for (const failure of ['validation', 'cutoff', 'late']) {
        const f = fixture(t); await f.observe(); await f.idle();
        if (failure === 'validation') f.engine.validated = async () => { throw new Error('book_changed'); };
        if (failure === 'cutoff') f.engine.requestEntryCutoff('profile_rotation');
        f.advance(failure === 'late' ? 32001 : 30000); await f.adjudicate();
        const reason = { validation: 'execution_validation_failed', cutoff: 'entry_cutoff', late: 'shared_execution_late' }[failure];
        for (const name of FAIR_PREMARKET_ARMS) {
            assert.equal(f.arm(name).outcomes[f.market.slug].reason, reason);
            assert.deepEqual(f.arm(name).positions, {}); assert.equal(f.arm(name).cash, 20);
        }
        assert.equal(f.engine.fairSnapshots.size, 0);
    }
});

test('fixed initial limits cannot chase a price rise during the common decision wait', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.ask(.6); await f.adjudicate();
    f.advance(250); f.engine.executePending();
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).outcomes[f.market.slug].reason, 'no_fill');
        assert.equal(f.arm(name).cash, 20); assert.deepEqual(f.arm(name).positions, {});
    }
});

test('restart during the shared decision wait fails closed and cannot resume old forecasts', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    const restoredStore = new PremarketPaperStore(f.config, f.now);
    restoredStore.event = () => restoredStore.save();
    const restored = new PremarketPaperEngine(f.config, restoredStore, f.engine.client, { clock: () => f.now });
    assert.equal(restored.fairSnapshots.size, 0);
    assert.equal(restoredStore.state.snapshots[0].fairExecution.reason, 'restart_during_fair_decision');
    for (const name of FAIR_PREMARKET_ARMS)
        assert.equal(restoredStore.state.arms[name].outcomes[f.market.slug].reason, 'restart_during_fair_decision');
});

test('settled engine cohorts verify report comparability including a busy provider with no request', async t => {
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    for (const busy of [false, true]) {
        const f = fixture(t, { answers: busy ? { laya: { status: 'busy', action: 'SKIP',
            requestSubmitted: false, inferenceAttempted: false } } : {}, prepare(input) {
            return { ...input, contextIdentity: hash('fixture-tokenizer'), semanticPromptHash: hash('fixture-prompt') };
        } });
        await f.observe(); await f.idle(); f.advance(30000); await f.adjudicate();
        f.advance(250); f.engine.executePending();
        f.advance(f.market.end + 1 - f.now);
        Object.assign(f.store.state.markets[f.market.slug], { payout: [1, 0], labelResolvedAt: f.now });
        await f.engine.settle();
        const report = summarizePremarketPaper(f.store.state, f.config, f.now);
        assert.equal(report.comparability.status, 'verified', JSON.stringify(report.comparability.reasons));
        assert.equal(report.commonCohort.markets, 1);
        assert.deepEqual(Object.keys(report.comparability.rows[0].arms), FAIR_PREMARKET_ARMS);
        assert.equal(report.pairedComparisons['laya-premarket'].markets, 1);
        assert.equal(report.pairedComparisons['router-premarket'].markets, 1);
        if (busy) {
            const row = report.comparability.rows[0].arms['laya-premarket'];
            assert.equal(row.inputUse, 'provider_request_not_submitted');
            assert.equal(row.inputSubmittedHash, null);
            assert.equal(row.inputOfferedHash, f.snapshot.commonInput.inputHash);
        }
    }
});
