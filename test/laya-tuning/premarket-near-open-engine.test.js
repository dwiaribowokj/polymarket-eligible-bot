import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketHistory, premarketFeatures } from '../../src/premarket-paper/features.js';
import { PremarketProviders } from '../../src/premarket-paper/providers.js';

test('cutoff cannot report drained while a timed-out provider HTTP request still runs', () => {
    const active = new Map([['router', Promise.resolve()]]);
    const engine = new PremarketPaperEngine({ armNames: [] }, { state: { arms: {}, entryCutoffAt: 1 } }, {}, { providers: { active } });
    assert.equal(engine.isDrained(), false);
    active.clear(); assert.equal(engine.isDrained(), true);
});
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(t, { leadSeconds = 60, providers = null } = {}) {
    const open = Date.parse('2026-10-26T00:10:00Z'), scheduledAt = open - leadSeconds * 1000;
    let now = scheduledAt, payout = null, availableShares = 10;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-near-open-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: 'near-open-test', dataDir, policy: {}, sources: [],
        armNames: ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'],
        activeArms: ['router-premarket'], providerArms: { 'router-premarket': 'router' },
        capital: 20, shares: 5, entryCap: 5, leadSeconds, aiDecisionMs: 30000,
        slots: [90, 60, 30], slotToleranceMs: 2000, dataAgeMs: 5000, maxGapMs: 5000,
        diagnosticHistoryMs: 900000, latencyMs: 250, settlementMs: 2500, reportMs: 60000,
        gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, drawdownStop: 10,
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const btc = new BtcSignal(config.control.lateSignal);
    const feed = at => {
        for (const topic of ['prices.crypto', 'prices.crypto.twap']) btc.ingest({ type: 'update', topic,
            payload: { symbol: 'btcusd', timestamp: at, value: 83000 - (at - scheduledAt) / 1000, windowSeconds: 60 } }, at);
    };
    for (let at = scheduledAt - 185000; at <= scheduledAt; at += 1000) feed(at);
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const books = () => market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId,
        tick: .01, timestamp: now, fetchedAt: now, bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: availableShares }] }));
    const stream = { generation: 1, tokens: market.tokens, watch() {}, close() {}, snapshot: books };
    const events = [], store = new PremarketPaperStore(config, now);
    store.event = (type, detail = {}) => { events.push({ type, ...structuredClone(detail) }); store.save(); };
    store.error = (stage, error) => { throw new Error(`${stage}:${error.message}`); };
    const client = { btc, startBtcFeed() {}, close() {}, serverTime: async () => now,
        market: async () => structuredClone(market), books: async () => books(), payout: async () => payout };
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, makeBooks: () => stream, providers });
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.clockRetryAt = now + 20000;
    engine.markets.set(market.slug, market); engine.streams.set(market.slug, stream); engine.history.capture(btc, now);
    engine.discover = async () => {};
    const key = `${market.slug}:premarket`;
    const enroll = () => {
        store.state.slots[key] = { scheduledAt, status: 'reserved' };
        store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    };
    return { config, store, engine, client, market, events, scheduledAt, key,
        get now() { return now; }, advance(ms) { now += ms; }, payout(value) { payout = value; }, depth(shares) { availableShares = shares; },
        refresh() { feed(now); engine.clockVerifiedAt = now; engine.clockRetryAt = now + 20000; },
        arm(name = 'router-premarket') { return store.state.arms[name]; },
        async observe() { enroll(); await engine.observePremarket(market.slug, scheduledAt, key); },
        async idle() { while (engine.tasks.size) await Promise.all([...engine.tasks]); } };
}

test('near-open scheduling launches once at open minus 60s with a 30s AI budget', async t => {
    const pending = deferred(), calls = [];
    const f = fixture(t, { providers: { predict(provider, snapshot) { calls.push({ provider, snapshot }); return pending.promise; } } });
    f.advance(-1); await f.engine.tick(); await f.idle();
    assert.equal(calls.length, 0); assert.equal(Object.keys(f.store.state.slots).length, 0);
    f.advance(1); await f.engine.tick();
    for (let i = 0; i < 20 && !calls.length; i++) await Promise.resolve();
    assert.equal(calls.length, 1);
    const snapshot = calls[0].snapshot;
    assert.equal(snapshot.scheduledAt, f.market.open - 60000);
    assert.equal(snapshot.aiDeadlineAt, f.market.open - 30000);
    assert.equal(snapshot.features.bars.at(-1).end, f.scheduledAt);
    await f.engine.tick(); assert.equal(calls.length, 1);
    f.advance(30000); f.refresh(); pending.resolve({ status: 'ok', action: 'BUY_DOWN' }); await f.idle();
    assert.equal(f.arm().positions[f.market.slug].activeAt, f.market.open - 29750);
    f.advance(250); f.engine.executePending();
    assert.equal(f.arm().positions[f.market.slug].status, 'matched');
    assert.ok(f.arm().positions[f.market.slug].executionAt < f.market.open);
});

test('slot tolerance includes exactly 2000ms and skips 2001ms without AI work', async t => {
    for (const delay of [2000, 2001]) {
        let calls = 0;
        const f = fixture(t, { providers: { async predict() { calls++; return { status: 'ok', action: 'SKIP' }; } } });
        f.advance(delay); await f.engine.tick(); await f.idle();
        assert.equal(calls, delay === 2000 ? 1 : 0);
        assert.equal(f.store.state.slots[f.key].status, delay === 2000 ? 'observed' : 'skipped');
        if (delay === 2001) assert.equal(f.arm().outcomes[f.market.slug].reason, 'slot_missed');
    }
});

test('late validation and responses cannot capture future input or enter after opening', async t => {
    const f = fixture(t, { providers: { async predict() { assert.fail('late observation must not launch inference'); } } });
    f.engine.history.points.push({ at: f.scheduledAt + 1, receivedAt: f.scheduledAt + 1, value: 1 });
    const validate = f.engine.validated.bind(f.engine);
    f.engine.validated = async slug => { const result = await validate(slug); f.advance(2001); return result; };
    await assert.rejects(f.observe(), /slot_late_after_validation/);
    assert.equal(f.store.state.snapshots.length, 0);

    for (const delay of [30001, 60000]) {
        const pending = deferred();
        const g = fixture(t, { providers: { predict() { return pending.promise; } } });
        g.engine.history.points.push({ at: g.scheduledAt + 1, receivedAt: g.scheduledAt + 1, value: 1 });
        await g.observe();
        assert.equal(g.store.state.snapshots[0].observedAt, g.scheduledAt);
        assert.equal(g.store.state.snapshots[0].features.action, 'BUY_DOWN');
        g.advance(delay); pending.resolve({ status: 'ok', action: 'BUY_DOWN' }); await g.idle();
        assert.equal(g.arm().outcomes[g.market.slug].reason, 'provider_late');
        assert.deepEqual(g.arm().positions, {}); assert.equal(g.arm().cash, 20);
    }
});

test('the original 240 second lead remains an independent schedule', async t => {
    let captured;
    const f = fixture(t, { leadSeconds: 240, providers: { async predict(provider, snapshot) {
        captured = snapshot; return { status: 'ok', action: 'SKIP' };
    } } });
    await f.engine.tick(); await f.idle();
    assert.equal(captured.scheduledAt, f.market.open - 240000);
    assert.equal(captured.aiDeadlineAt, f.market.open - 210000);
});

test('cutoff persists once and drains outstanding inference while recording its result', async t => {
    const pending = deferred();
    const f = fixture(t, { providers: { predict() { return pending.promise; } } });
    await f.observe();
    assert.equal(f.engine.isDrained(), false);
    const cutoff = f.engine.requestEntryCutoff('profile_rotation');
    f.advance(1000); assert.equal(f.engine.requestEntryCutoff('duplicate_signal'), cutoff);
    assert.equal(f.store.state.entryCutoffAt, cutoff);
    assert.equal(f.store.state.entryCutoffReason, 'profile_rotation');
    assert.equal(f.events.filter(event => event.type === 'entry_cutoff_requested').length, 1);
    assert.equal(f.engine.isDrained(), false);
    f.engine.validated = async () => { assert.fail('cutoff must reject inference before execution validation'); };
    pending.resolve({ status: 'ok', action: 'BUY_DOWN', cost: .0123 }); await f.idle();
    const decision = f.store.state.snapshots[0].decisions['router-premarket'];
    assert.equal(decision.status, 'ok'); assert.equal(decision.cost, .0123);
    assert.equal(decision.entryDisposition, 'entry_cutoff');
    assert.equal(f.events.filter(event => event.type === 'provider_decision').length, 1);
    assert.equal(f.arm().outcomes[f.market.slug].reason, 'entry_cutoff');
    assert.equal(f.arm().outcomes[f.market.slug].noExposure, true);
    assert.deepEqual(f.arm().positions, {}); assert.equal(f.arm().cash, 20);
    assert.equal(f.engine.isDrained(), true);
    const restored = new PremarketPaperStore(f.config, f.now);
    assert.equal(restored.state.entryCutoffAt, cutoff);
    assert.equal(restored.state.entryCutoffReason, 'profile_rotation');
});

test('cutoff during observation or execution validation prevents provider launch and admission', async t => {
    let calls = 0;
    const f = fixture(t, { providers: { async predict() { calls++; return { status: 'ok', action: 'BUY_DOWN' }; } } });
    const validate = f.engine.validated.bind(f.engine);
    f.engine.validated = async slug => { const result = await validate(slug); f.engine.requestEntryCutoff('during_capture'); return result; };
    await assert.rejects(f.observe(), /entry_cutoff/);
    assert.equal(calls, 0); assert.equal(f.store.state.snapshots.length, 0);
    await assert.rejects(f.engine.observeLate(f.market.slug, f.now, 'unused'), /entry_cutoff/);

    const g = fixture(t, { providers: { async predict() { return { status: 'ok', action: 'BUY_DOWN' }; } } });
    const validateExecution = g.engine.validated.bind(g.engine);
    let validations = 0;
    g.engine.validated = async slug => {
        const result = await validateExecution(slug);
        if (++validations === 2) g.engine.requestEntryCutoff('during_execution_validation');
        return result;
    };
    await g.observe(); await g.idle();
    assert.equal(validations, 2); assert.deepEqual(g.arm().positions, {});
    assert.equal(g.store.state.snapshots[0].decisions['router-premarket'].entryDisposition, 'entry_cutoff');
});

test('cutoff cancels pending virtual orders before latency elapses without changing cash or stops', async t => {
    const f = fixture(t, { providers: { async predict() { return { status: 'ok', action: 'BUY_DOWN' }; } } });
    await f.observe(); await f.idle();
    assert.equal(f.arm().positions[f.market.slug].status, 'pending');
    const stop = { at: f.now - 1, reason: 'realized_drawdown_limit', drawdown: 10 };
    f.arm('premarket-momentum').stopped = structuredClone(stop);
    f.engine.requestEntryCutoff('stop_entries');
    assert.deepEqual(f.arm().positions, {}); assert.equal(f.arm().cash, 20);
    assert.deepEqual(f.arm('premarket-momentum').stopped, stop);
    assert.equal(f.arm().outcomes[f.market.slug].reason, 'entry_cutoff');
    assert.equal(f.arm().outcomes[f.market.slug].noExposure, true);
    f.advance(250); f.engine.executePending();
    assert.equal(f.events.some(event => event.type === 'fill_matched'), false);
    assert.equal(f.engine.isDrained(), true);
});

test('cutoff preserves matched inventory across restart and drains only after official payout', async t => {
    const f = fixture(t, { providers: { async predict() { return { status: 'ok', action: 'BUY_DOWN' }; } } });
    await f.observe(); await f.idle(); f.advance(250); f.engine.executePending();
    const paidCash = f.arm().cash;
    assert.equal(f.arm().positions[f.market.slug].status, 'matched');
    f.engine.requestEntryCutoff('rotation');
    assert.equal(f.engine.isDrained(), false); assert.equal(f.arm().cash, paidCash);
    const restored = new PremarketPaperStore(f.config, f.now);
    restored.event = () => restored.save();
    const resumed = new PremarketPaperEngine(f.config, restored, f.client, { clock: () => f.now,
        providers: { predict() { assert.fail('frozen restart must not launch inference'); } } });
    const expectedSlots = structuredClone(restored.state.slots), expectedMarkets = Object.keys(restored.state.markets);
    assert.equal(resumed.entryCutoffRequested(), true);
    f.advance(f.market.end - f.now + 1); await resumed.tick(); await Promise.all([...resumed.tasks]);
    assert.equal(restored.state.arms['router-premarket'].positions[f.market.slug].status, 'filled');
    assert.equal(restored.state.arms['router-premarket'].completed.length, 0);
    assert.equal(resumed.isDrained(), false);
    assert.deepEqual(restored.state.slots, expectedSlots);
    assert.deepEqual(Object.keys(restored.state.markets), expectedMarkets);
    f.payout([0, 1]); f.advance(15000); await resumed.settle();
    const arm = restored.state.arms['router-premarket'];
    assert.equal(arm.completed.length, 1); assert.deepEqual(arm.positions, {});
    assert.equal(arm.cash, 22.3625); assert.equal(arm.completed[0].pnl, 2.3625);
    assert.equal(resumed.isDrained(), true);
    await resumed.settle(); assert.equal(arm.completed.length, 1);
});

test('persisted cutoff prevents pending execution and direct provider launches', async t => {
    const f = fixture(t, { providers: { async predict() { return { status: 'ok', action: 'BUY_DOWN' }; } } });
    await f.observe(); await f.idle();
    f.store.state.entryCutoffAt = f.now;
    f.engine.executePending();
    assert.equal(f.arm().outcomes[f.market.slug].reason, 'entry_cutoff');
    assert.deepEqual(f.arm().positions, {});
    f.engine.providers.predict = () => { assert.fail('cutoff must prevent all new inference'); };
    const row = {};
    await f.engine.decideProvider('router-premarket', 'router', f.store.state.snapshots[0], row);
    assert.equal(row.inferenceAttempted, false); assert.equal(row.entryDisposition, 'entry_cutoff');
    const decision = { action: 'BUY_DOWN' };
    f.engine.admit('router-premarket', f.store.state.snapshots[0], decision, null, true);
    assert.equal(decision.entryDisposition, 'entry_cutoff');
});

test('live thirty-minute history reaches the real router adapter and a delayed partial near-open fill', async t => {
    const f = fixture(t), historyStartAt = f.scheduledAt - 1800000;
    Object.assign(f.config, { profile: 'near-open-30m-v1', historyMs: 1800000, diagnosticHistoryMs: 1800000,
        routerModel: 'cx/gpt-6.1-sol', routerReasoning: 'medium', ninerouterUrl: 'http://router.invalid/v1',
        ninerouterKey: 'synthetic-test-key', layaUrl: 'http://laya.invalid', providerDrainMs: 1000 });
    f.engine.history = new PremarketHistory(f.config);
    const seed = Array.from({ length: 1801 }, (_, i) => ({ at: historyStartAt + i * 1000,
        receivedAt: historyStartAt + i * 1000, value: 84800 - i }));
    f.engine.history.capture({ spot: seed }, f.now);
    assert.equal(f.engine.history.points.length, 1);
    await assert.rejects(f.observe(), /completed_candles_warming/);
    assert.equal(f.store.state.snapshots.length, 0);

    f.engine.history.reset(); f.client.btc.spot = []; f.client.btc.twap = null;
    f.advance(historyStartAt - f.now);
    for (;;) {
        f.refresh(); f.engine.history.capture(f.client.btc, f.now);
        if (f.now === f.scheduledAt) break;
        f.advance(1000);
    }
    f.client.btc.spot.push({ at: f.now + 1, receivedAt: f.now + 1, value: 1 });
    f.engine.history.capture(f.client.btc, f.now);
    assert.equal(f.engine.history.points.length, 1801);
    assert.equal(f.engine.history.points[0].at, historyStartAt);
    assert.equal(f.engine.history.points.at(-1).at, f.scheduledAt);
    const features = premarketFeatures(f.engine.history.points, f.market, f.scheduledAt, f.config);
    assert.equal(features.bars.length, 30); assert.equal(features.context.bars5m.length, 6);
    assert.equal(features.bars.at(-1).end, f.scheduledAt);
    assert.equal(features.context.returnsUsd.m30, -1800);
    const calls = [], requests = [];
    const providers = new PremarketProviders(f.config, f.store.state.providers,
        (type, detail) => f.store.event(type, detail), { clock: () => f.now,
            counter: { start() { assert.fail('router-only profile must not initialize Laya'); },
                count() { assert.fail('router-only profile must not invoke the Laya tokenizer'); }, close() {} },
            fetch: async (url, init = {}) => {
                calls.push(url);
                if (url === `${f.config.ninerouterUrl}/models`)
                    return Response.json({ data: [{ id: f.config.routerModel, owned_by: 'codex' }] });
                assert.equal(url, `${f.config.ninerouterUrl}/chat/completions`); assert.equal(init.method, 'POST');
                const request = JSON.parse(init.body), input = JSON.parse(request.messages.at(-1).content);
                requests.push(input);
                assert.equal(request.model, f.config.routerModel);
                assert.equal(input.seconds_to_open, 60); assert.equal(input.opening_twap, null);
                const anchor = features.bars[0].open;
                const offsets = bar => ['open', 'high', 'low', 'close'].map(key => (bar[key] - anchor) * 100);
                assert.deepEqual(input.bars, features.bars.map(offsets));
                assert.deepEqual(input.context.bars_5m, features.context.bars5m.map(offsets));
                assert.equal(input.context.complete_minutes, 30);
                assert.equal(input.context.window_start_utc, new Date(historyStartAt).toISOString());
                assert.equal(input.context.window_end_utc, new Date(f.scheduledAt).toISOString());
                assert.deepEqual(input.context.returns_usd, features.context.returnsUsd);
                return Response.json({ model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: {
                    role: 'assistant', content: JSON.stringify({ snapshotId: input.snapshotId, action: 'BUY_DOWN',
                        estimatedUpProbability: .2, reasonCode: 'positive_edge',
                        rationale: 'The supplied thirty-minute decline and six declining groups support Down above its all-in break-even cost.' }) } }],
                usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 } });
            } });
    f.engine.providers = providers; t.after(() => providers.close());
    await f.observe(); await f.idle();
    assert.deepEqual(calls, [`${f.config.ninerouterUrl}/models`, `${f.config.ninerouterUrl}/chat/completions`]);
    assert.equal(requests.length, 1);
    const snapshot = f.store.state.snapshots[0], decision = snapshot.decisions['router-premarket'];
    assert.deepEqual(snapshot.features, features);
    assert.equal(snapshot.aiDeadlineAt, f.market.open - 30000);
    assert.equal(decision.status, 'ok'); assert.equal(decision.action, 'BUY_DOWN');
    assert.equal(decision.entryDisposition, 'reserved'); assert.ok(decision.expectedNetUsd.BUY_DOWN > 0);
    assert.deepEqual(decision.inputCoverage, { source: 'chainlink_btc_usd', completeMinutes: 30,
        minuteBars: 30, fiveMinuteGroups: 6, historyStartAt, historyEndAt: f.scheduledAt,
        decisionAt: f.scheduledAt, truncated: false });
    assert.equal(f.arm().positions[f.market.slug].status, 'pending'); assert.equal(f.arm().cash, 20);
    f.advance(249); f.engine.executePending();
    assert.equal(f.arm().positions[f.market.slug].status, 'pending');
    f.depth(2); f.advance(1); f.refresh(); f.engine.executePending();
    const position = f.arm().positions[f.market.slug];
    assert.equal(position.status, 'matched'); assert.equal(position.holdings, 2);
    assert.equal(position.order.price, .51); assert.equal(position.fill.notional, 1);
    assert.equal(position.executionAt, f.scheduledAt + 250); assert.ok(position.executionAt < f.market.open);
    assert.equal(f.arm().cash, 18.965);
    assert.equal(snapshot.books[1].timestamp, f.scheduledAt);
    for (const name of f.config.armNames.filter(name => name !== 'router-premarket')) {
        assert.equal(f.arm(name).cash, 20); assert.deepEqual(f.arm(name).positions, {});
    }
    f.advance(f.market.open - f.now); f.engine.executePending();
    assert.equal(f.events.filter(event => event.type === 'fill_matched').length, 1);
    assert.deepEqual(snapshot.features, features);
});
