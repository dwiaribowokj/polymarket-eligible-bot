import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE, ROOT, loadSettings } from '../../src/restart/config.js';
import { newPosition } from '../../src/restart/strategy.js';
import { riskReason } from '../../src/restart/math.js';
import { LiveBroker } from '../../src/restart/live.js';
import { TradingClient } from '../../src/restart/client.js';
import { acquireLock } from '../../src/restart/store.js';
import { candidateChecks, metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { LayaLiveBroker, operationCode } from '../../src/laya-live/broker.js';
import { entryGuard, assertDecisionTiming, initializeAI, LayaLiveEngine } from '../../src/laya-live/engine.js';
import { loadLiveConfig, liveConfigView } from '../../src/laya-live/config.js';
import { assertStartAllowed, enforceStartupGuards, livePreflight, liveReadiness,
    allocateLiveCapital, preflightExitCode, readRehearsalEvidence, rehearsalEvidence } from '../../src/laya-live/preflight.js';
import { parseArgs } from '../../scripts/laya-live.js';
import { BookHistory } from '../../src/ai-shadow/history.js';

// Entry/book fixtures explicitly supply readiness; dedicated clock tests exercise the gate.
function readyEntryEngine() {
    return Object.assign(Object.create(LayaLiveEngine.prototype), { clockGate: { fresh: () => true } });
}

function fixture() {
    const now = Date.now();
    const settings = { ...BASELINE, paperGasUsd: .05 };
    const config = { settings, ai: { decisionMs: 3000, dataAgeMs: 5000, capital: 20, shares: 5, entryCap: 5,
        gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings },
        policy: { aiSource: 'source', capital: null, minimumBalance: 0, capitalAllocation: 'available_balance' } };
    const market = { slug: 'market', conditionId: 'condition', open: now - 210000, end: now + 90000,
        accepting: true, tokens: ['up', 'down'], minimum: 5, tick: .01, ticks: [.01, .01], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const spec = { index: 0, tokenId: 'up', price: .79, snapshotPrice: .78, shares: 5, side: 'BUY', kind: 'taker' };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: now, cash: 20, peakEquity: 20,
        maxDrawdown: 0, failures: 0, stopped: null, completed: [], seen: { market: { at: now } } };
    state.position = newPosition(market, { orders: [spec], cost: 4.06 }, state, now);
    const events = [], persisted = [];
    const store = { state, save() { persisted.push(JSON.parse(JSON.stringify(state))); },
        event(type, detail) { events.push({ type, detail }); this.save(); },
        stop(reason) { state.stopped ||= { at: now, reason }; this.save(); } };
    const snapshot = { snapshotId: 'snapshot', at: now - 2600, observedAt: now - 3000, decisionReceivedAt: now,
        validation: { at: now - 2600, generation: 1, identity: metadataIdentity(market) }, allowed: [spec] };
    const decision = { snapshotId: 'snapshot', model: 'typed-decisions', action: 'BUY_UP', status: 'ok' };
    const books = [{ bids: [{ price: .77, size: 10 }], asks: [{ price: .78, size: 10 }] },
        { bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] }];
    let posts = 0;
    const client = { async prepare() { return { orderId: '0xabc', signed: { sealed: true } }; },
        async post() { posts++; return { ok: true, orderId: '0xabc' }; } };
    return { now, settings, config, market, spec, state, store, snapshot, decision, books, client, events, persisted, get posts() { return posts; } };
}

test('live CLI defaults to a read-only preflight and requires an explicit run --live', () => {
    assert.equal(parseArgs([]).command, 'preflight');
    assert.deepEqual(parseArgs(['config']), { command: 'config', explicitLive: false });
    assert.equal(parseArgs(['run', '--live']).explicitLive, true);
    for (const args of [['run'], ['config', '--live'], ['preflight', '--live'], ['report', '--live'],
        ['run', '--auto'], ['run', '--live', '--force'], ['run', '--live', '--live']]) assert.throws(() => parseArgs(args));
});

test('live source identity is isolated while using the legacy pilot lock and history root', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-config-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = { ...process.env, RESTART_DATA_DIR: dataDir };
    const old = loadSettings(env), live = loadLiveConfig(env);
    assert.notEqual(live.id, old.fingerprint); assert.equal(live.settings.dataDir, old.dataDir);
    assert.equal(live.settings.drawdownStop, 10); assert.equal(live.settings.pilotHours, Infinity);
    assert.equal(live.settings.pilotMarkets, Infinity);
    assert.equal(live.policy.pilotHours, null); assert.equal(live.policy.pilotMarkets, null);
    assert.equal(live.settings.shares, 5); assert.equal(live.settings.entryCap, 5);
    assert.equal(loadSettings(env).fingerprint, old.fingerprint);
});

test('two live engines cannot acquire the shared pilot lock', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-live-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const release = await acquireLock(dir, 'pilot');
    try { await assert.rejects(acquireLock(dir, 'pilot'), /already running/); } finally { await release(); }
});

test('fresh decision keeps exact side, token, shares, and committed price', () => {
    const f = fixture(); assert.doesNotThrow(() => entryGuard(f));
    for (const mutation of [{ shares: 6 }, { price: .80 }, { index: 1 }, { tokenId: 'other' }, { side: 'SELL' }, { kind: 'maker' }])
        assert.throws(() => entryGuard({ ...f, spec: { ...f.spec, ...mutation } }), /specification_changed/);
});

test('expired input, slow response, model changes, and mismatched snapshot cannot reach submit', () => {
    const f = fixture();
    for (const mutation of [
        { snapshot: { ...f.snapshot, observedAt: f.now - 5001 } },
        { snapshot: { ...f.snapshot, decisionReceivedAt: f.snapshot.at + 3001 } },
        { snapshot: { ...f.snapshot, at: f.now + 1 } },
        { decision: { ...f.decision, model: 'other-model' } },
        { decision: { ...f.decision, snapshotId: 'other' } },
        { decision: { ...f.decision, status: 'decision_timeout' } },
        { market: { ...f.market, minimum: 6 } },
        { market: { ...f.market, ticks: [.001, .001] } }]) assert.throws(() => entryGuard({ ...f, ...mutation }));
});

test('partial execution depth remains allowed, but fee-inclusive budget and final price threshold remain enforced', () => {
    const f = fixture(); f.books[0].asks[0].size = 2; assert.doesNotThrow(() => entryGuard(f));
    assert.throws(() => entryGuard({ ...f, state: { ...f.state, cash: 1 } }), /budget_exceeded/);
    const closing = { ...f.market, end: f.now + 19000 };
    assert.throws(() => entryGuard({ ...f, market: closing }), /execution_constraints_changed/);
});

test('exact signed identity and submit attempt are saved before the only network POST', async () => {
    const f = fixture(); let validations = 0;
    f.client.post = async () => {
        const saved = f.persisted.at(-1).position.orders[0];
        assert.equal(saved.orderId, '0xabc'); assert.deepEqual(saved.signed, { sealed: true });
        assert.equal(saved.status, 'submitting'); assert.ok(saved.postAttemptAt);
        return { ok: true, orderId: '0xabc' };
    };
    const broker = new LayaLiveBroker(f.settings, f.store, f.client, async () => { validations++; });
    assert.ok(broker instanceof LiveBroker);
    const result = await broker.submit(f.spec, f.now);
    assert.equal(result.status, 'accepted'); assert.equal(validations, 2);
    assert.equal(f.state.cash, 20); assert.deepEqual(f.state.position.holdings, [0, 0]);
});

test('timeout after submit stays unknown and restart cannot submit a duplicate', async () => {
    const f = fixture(); let posts = 0;
    f.client.post = async () => { posts++; throw new Error('timeout'); };
    const broker = new LayaLiveBroker(f.settings, f.store, f.client, async () => {});
    assert.equal((await broker.submit(f.spec, f.now)).status, 'unknown');
    assert.equal(f.state.stopped.reason, 'unknown_order_submission');
    const restarted = { ...f.store, state: JSON.parse(JSON.stringify(f.state)) };
    await assert.rejects(new LayaLiveBroker(f.settings, restarted, f.client, async () => {}).submit(f.spec, f.now + 1000), /duplicate_entry/);
    assert.equal(posts, 1); assert.equal(restarted.state.position.orders[0].orderId, '0xabc');
});

test('validation expiring during signing cannot POST or prepare another attempt', async () => {
    const f = fixture(); let validations = 0;
    const broker = new LayaLiveBroker(f.settings, f.store, f.client, async () => {
        if (++validations === 2) throw new Error('stale_laya_input');
    });
    assert.equal((await broker.submit(f.spec, f.now)).status, 'rejected'); assert.equal(f.posts, 0);
    assert.equal(f.state.position.orders[0].status, 'rejected');
    await assert.rejects(broker.submit(f.spec, f.now), /duplicate_entry/); assert.equal(f.posts, 0);
});

test('HTTP order rejection and identity mismatch do not retry or create inventory', async () => {
    for (const response of [{ ok: false, code: 'INVALID_ORDER' }, { ok: true, orderId: 'wrong' }]) {
        const f = fixture(); let posts = 0; f.client.post = async () => { posts++; return response; };
        const result = await new LayaLiveBroker(f.settings, f.store, f.client, async () => {}).submit(f.spec, f.now);
        assert.equal(posts, 1); assert.deepEqual(f.state.position.holdings, [0, 0]);
        assert.equal(result.status, response.ok ? 'unknown' : 'rejected');
        if (response.ok) assert.equal(f.state.stopped.reason, 'order_identity_mismatch');
    }
});

test('restart disables uncertain inference and preserves live loss stop and market reservation', () => {
    const f = fixture();
    initializeAI(f.state, f.config);
    f.state.ai.providers.laya = { pending: { snapshotId: 'uncertain' }, tokenizerIdentity: 'artifact' };
    f.state.stopped = { reason: 'drawdown_limit', at: f.now };
    const recovered = JSON.parse(JSON.stringify(f.state)); initializeAI(recovered, f.config);
    assert.equal(recovered.ai.providers.laya.disabled, 'restart_with_unknown_inference');
    assert.ok(recovered.seen.market); assert.equal(recovered.stopped.reason, 'drawdown_limit');
    assert.throws(() => initializeAI(recovered, { policy: { aiSource: 'changed' } }), /source_changed/);
});

test('bounded legacy settings retain their drawdown, market-count and time limits', () => {
    const f = fixture(); assert.equal(riskReason(f.state, f.settings, f.now, 17.99), 'drawdown_limit');
    const fresh = () => ({ ...f.state, peakEquity: 20, completed: [] });
    assert.equal(riskReason({ ...fresh(), completed: Array.from({ length: 30 }, () => ({})) }, f.settings, f.now, 20), 'market_limit');
    assert.equal(riskReason(fresh(), f.settings, f.now + 48 * 3600000, 20), 'time_limit');
});

test('manual live requires healthy operations and preserves real stops while paper remains a warning', () => {
    const f = fixture(), args = { explicitLive: true, state: { ...f.state, position: null }, operationalReady: true,
        otherHistory: false, rehearsal: { found: true, riskStopActive: false, inventoryOpen: false } };
    assert.doesNotThrow(() => assertStartAllowed(args));
    assert.throws(() => assertStartAllowed({ ...args, explicitLive: false }), /explicit_live/);
    assert.throws(() => assertStartAllowed({ ...args, operationalReady: false }), /preflight_blocked/);
    assert.throws(() => assertStartAllowed({ ...args, otherHistory: true }), /history/);
    assert.throws(() => assertStartAllowed({ ...args, state: { ...args.state, stopped: { reason: 'drawdown' } } }), /persistent/);
    assert.doesNotThrow(() => assertStartAllowed({ ...args, rehearsal: { found: true, riskStopActive: true } }));
    assert.doesNotThrow(() => assertStartAllowed({ ...args, rehearsal: { found: true, inventoryOpen: true } }));
    // Existing real inventory must still be managed even when startup checks fail.
    assert.doesNotThrow(() => assertStartAllowed({ ...args, state: f.state, operationalReady: false, rehearsal: { riskStopActive: true } }));
});

test('public config exposes effective limits and guards without wallet secrets or endpoints', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-config-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = loadLiveConfig({ ...process.env, RESTART_DATA_DIR: dataDir }), secret = 'DO_NOT_EXPOSE_ME';
    config.settings = { ...config.settings, privateKey: secret, credentials: { secret }, rpcUrl: `https://example.test/${secret}` };
    config.ai = { ...config.ai, ninerouterKey: secret, layaUrl: `https://user:${secret}@example.test`, routerDb: secret };
    const view = liveConfigView(config), output = JSON.stringify(view);
    assert.equal(output.includes(secret), false); assert.equal(view.guards.rehearsalRiskStop, false);
    assert.equal(view.paperEvidence, 'report_only'); assert.equal(view.funding.minimumBalance, 0);
    assert.equal(view.funding.capitalCap, null); assert.equal(view.funding.allocation, 'available_balance');
    assert.equal(view.guards.automaticActivation, false); assert.equal(view.execution.orderType, 'FAK');
    assert.deepEqual(view.limits, { capital: null, entryCap: 5, shares: 5, drawdownStop: 10, pilotMarkets: null, pilotHours: null });
    assert.equal(view.execution.decisionMs, 3000); assert.equal(view.execution.dataAgeMs, 5000);
});

test('a paper stop remains visible without vetoing explicitly requested live startup', () => {
    const readiness = liveReadiness({ operationalReady: true, rehearsal: { found: true, riskStopActive: true } });
    assert.equal(readiness.readyForLive, true); assert.equal(readiness.startAllowed, true);
    assert.deepEqual(readiness.blockers, []);
    assert.deepEqual(readiness.warnings, ['rehearsal_risk_stop_recorded']);
    assert.equal(preflightExitCode({ operationalReady: true, ...readiness }), 0);
    assert.equal(preflightExitCode({ readyForLive: true }), 0);
    assert.equal(preflightExitCode({ operationalReady: true }), 1);
});

test('missing or malformed paper evidence is reported without altering live risk enforcement', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-live-evidence-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = { rehearsalDataDir: dir };
    const missing = liveReadiness({ operationalReady: true, rehearsal: readRehearsalEvidence(config) });
    assert.deepEqual(missing.blockers, []); assert.deepEqual(missing.warnings, ['rehearsal_evidence_missing']);
    fs.writeFileSync(path.join(dir, 'active.json'), '{ broken');
    const evidence = readRehearsalEvidence(config);
    assert.equal(evidence.invalid, true);
    const invalid = liveReadiness({ operationalReady: true, rehearsal: evidence });
    assert.equal(invalid.readyForLive, true); assert.ok(invalid.warnings.includes('rehearsal_evidence_invalid'));
    const stopped = liveReadiness({ operationalReady: true, state: { stopped: { reason: 'drawdown_limit' } }, rehearsal: evidence });
    assert.equal(stopped.readyForLive, false); assert.deepEqual(stopped.blockers, ['persistent_pilot_stop']);
});

test('read-only report must require a fresh preflight rather than reuse a previous healthy status', () => {
    const readiness = liveReadiness({ operationalReady: null, rehearsal: { found: true } });
    assert.equal(readiness.readyForLive, false); assert.deepEqual(readiness.blockers, ['live_preflight_required']);
});

test('recovery persists a stop before managing inventory, and cannot enter again after settlement or restart', () => {
    const f = fixture(), context = { explicitLive: true, operationalReady: false,
        rehearsal: { found: true, riskStopActive: true } };
    const readiness = enforceStartupGuards(f.store, context);
    assert.equal(readiness.startAllowed, true); assert.equal(readiness.readyForLive, false);
    assert.equal(readiness.recoveryOnly, true); assert.ok(f.persisted.length);
    assert.equal(f.persisted.at(-1).stopped.reason, 'live_preflight_blocked');
    assert.throws(() => entryGuard(f), /pilot_stopped/);
    const restarted = structuredClone(f.persisted.at(-1)); restarted.position = null;
    assert.throws(() => assertStartAllowed({ ...context, state: restarted }), /persistent_pilot_stop/);
});

test('recovery preserves an earlier loss stop and still refuses conflicting live history', () => {
    const f = fixture(); f.state.stopped = { reason: 'drawdown_limit', at: f.now };
    const context = { explicitLive: true, operationalReady: false, rehearsal: { found: true, riskStopActive: true } };
    enforceStartupGuards(f.store, context);
    assert.equal(f.state.stopped.reason, 'drawdown_limit'); assert.equal(f.persisted.length, 0);
    assert.throws(() => enforceStartupGuards(f.store, { ...context, otherHistory: true }), /existing_pilot_history/);
});

test('current rehearsal loss remains separate evidence and cannot be hidden by old winning samples', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-live-evidence-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const id = '0123456789abcdef'; fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id }));
    fs.writeFileSync(path.join(dir, id, 'ledger.json'), JSON.stringify({ id, arms: { laya: { cash: 15.98994,
        stopped: { reason: 'research_drawdown_limit' }, shadowStop: { drawdown: 2.80583 }, position: null,
        completed: [{ pnl: -4.01006 }] } } }));
    const evidence = rehearsalEvidence({ rehearsalDataDir: dir });
    assert.equal(evidence.netTradingPnl, -4.01006); assert.equal(evidence.riskStopActive, true); assert.equal(evidence.separatePeriod, true);
});

test('small balances can pass read-only startup checks without creating a future automatic activation', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-live-preflight-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const f = fixture(); const config = { ...f.config, root: ROOT, id: 'test', rehearsalDataDir: path.join(dir, 'paper'),
        ai: { ...f.config.ai, dataDir: path.join(dir, 'shadow') } };
    let mutations = 0;
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        market: async () => f.market, books: async () => f.books, walletHealth: async () => ({ contract: true, signerIsOwner: true,
            threshold: 1, balance: .465657, nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => [], ordersAndTrades: async () => ({ orders: [], trades: [] }), gasPriceUsd: async () => 1,
        prepare: async () => { mutations++; }, post: async () => { mutations++; }, broadcastAction: async () => { mutations++; } };
    const result = await livePreflight(config, client, { preflight: async () => ({ laya: { ready: true } }) });
    assert.equal(result.output.operationalReady, true); assert.equal(result.output.shortfall, 0);
    assert.equal(result.output.checks.find(c => c.name === 'funding').ok, true);
    assert.equal(result.output.allocatedCapital, .465657);
    assert.equal(result.output.automaticActivation, false); assert.equal(mutations, 0); assert.deepEqual(fs.readdirSync(dir), []);
});

test('any available balance can pass read-only preflight without erasing a paper loss or creating a live ledger', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-live-funded-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const f = fixture(), paper = path.join(dir, 'paper'), id = '0123456789abcdef';
    fs.mkdirSync(path.join(paper, id), { recursive: true });
    fs.writeFileSync(path.join(paper, 'active.json'), JSON.stringify({ id }));
    fs.writeFileSync(path.join(paper, id, 'ledger.json'), JSON.stringify({ id, arms: { laya: { cash: 15.98994,
        stopped: { reason: 'research_drawdown_limit' }, position: null, completed: [{ pnl: -4.01006 }] } } }));
    const before = fs.readFileSync(path.join(paper, id, 'ledger.json'));
    const config = { ...f.config, root: ROOT, id: 'test', rehearsalDataDir: paper,
        ai: { ...f.config.ai, dataDir: path.join(dir, 'shadow') } };
    let mutations = 0;
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        market: async () => f.market, books: async () => f.books, walletHealth: async () => ({ contract: true, signerIsOwner: true,
            threshold: 1, balance: 18.18504, nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => [], ordersAndTrades: async () => ({ orders: [], trades: [] }), gasPriceUsd: async () => 1,
        prepare: async () => { mutations++; }, post: async () => { mutations++; }, broadcastAction: async () => { mutations++; } };
    const result = await livePreflight(config, client, { preflight: async () => ({ laya: { ready: true } }) });
    assert.equal(result.output.operationalReady, true); assert.equal(result.output.shortfall, 0);
    assert.equal(result.output.readyForLive, true); assert.equal(result.output.startAllowed, true);
    assert.deepEqual(result.output.blockers, []); assert.deepEqual(result.output.warnings, ['rehearsal_risk_stop_recorded']);
    assert.equal(result.output.allocatedCapital, 18.18504); assert.equal(result.output.capitalCap, null);
    assert.equal(result.output.requiredBalance, 0);
    assert.equal(preflightExitCode(result.output), 0); assert.equal(mutations, 0);
    assert.deepEqual(fs.readFileSync(path.join(paper, id, 'ledger.json')), before);
    assert.deepEqual(fs.readdirSync(dir), ['paper']);
});

test('fresh live capital accepts zero, small and large balances without a fictitious starting drawdown', () => {
    for (const balance of [0, .465657, 5, 18.18504, 20, 47, 1000]) {
        const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
        const funding = allocateLiveCapital(f.state, f.config, balance, { fresh: true, now: f.now });
        const expected = balance;
        assert.equal(funding.initialCapital, expected); assert.equal(f.state.cash, expected);
        assert.equal(f.state.peakEquity, expected); assert.equal(f.state.walletStart, balance);
        assert.equal(riskReason(f.state, f.settings, f.now, expected), null);
        assert.equal(riskReason(f.state, f.settings, f.now, expected - 2), 'drawdown_limit');
    }
});

test('insufficient order funds skip the opportunity while large capital keeps the same fixed order size', () => {
    const f = fixture();
    for (const cash of [0, .465657, 1]) {
        const checks = candidateChecks(f.market, f.books, f.config.ai, cash, f.now);
        assert.equal(checks[0].reason, 'insufficient_virtual_cash');
        assert.equal(checks.some(check => check.order), false);
    }
    const checks = candidateChecks(f.market, f.books, f.config.ai, 1000, f.now);
    assert.equal(checks[0].order.shares, 5); assert.ok(checks[0].order.cost <= 5);
});

test('restart and wallet top-ups cannot reset capital, cash, peak equity, or the real loss stop', () => {
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    allocateLiveCapital(f.state, f.config, 18.18504, { fresh: true });
    Object.assign(f.state, { cash: 15.5, peakEquity: 19, stopped: { reason: 'drawdown_limit', at: f.now } });
    const restored = structuredClone(f.state);
    allocateLiveCapital(restored, f.config, 100);
    assert.equal(restored.liveFunding.initialCapital, 18.18504); assert.equal(restored.cash, 15.5);
    assert.equal(restored.peakEquity, 19); assert.equal(restored.stopped.reason, 'drawdown_limit');
    assert.equal(restored.walletStart, 18.18504);
});

test('capital initialization rejects corrupt balances and cannot overwrite an existing period', () => {
    const fresh = () => { const f = fixture(); Object.assign(f.state, { position: null, seen: {} }); return f; };
    for (const balance of [-1, NaN, Infinity]) {
        const f = fresh(); assert.throws(() => allocateLiveCapital(f.state, f.config, balance, { fresh: true }), /invalid_wallet_balance/);
        assert.equal(f.state.cash, 20); assert.equal(f.state.liveFunding, undefined);
    }
    for (const mutation of [{ seen: { old: {} } }, { completed: [{ pnl: -1 }] }, { stopped: { reason: 'drawdown_limit' } }, { position: {} }]) {
        const f = fresh(); Object.assign(f.state, mutation);
        assert.throws(() => allocateLiveCapital(f.state, f.config, 18, { fresh: true }), /requires_fresh_period/);
    }
    const f = fresh(); assert.throws(() => allocateLiveCapital(f.state, f.config, 18), /requires_fresh_period/);
});

test('the initial wallet snapshot still detects external balance changes with unrestricted startup capital', async () => {
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    allocateLiveCapital(f.state, f.config, 27, { fresh: true });
    let balance = 27;
    const broker = new LayaLiveBroker(f.settings, f.store, { balance: async () => balance }, async () => {});
    assert.equal(await broker.checkWallet(), true); assert.equal(f.state.cash, 27);
    balance = 26;
    assert.equal(await broker.checkWallet(), false); assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
});

test('credential-bearing errors are logged as sanitized codes', () => {
    assert.equal(operationCode(new Error('fetch failed https://rpc.invalid/private-token')), 'request_failed');
    assert.equal(operationCode(new Error('stale_laya_input')), 'stale_laya_input');
});

test('missed snapshot opportunity skips entry while a transport failure retains the live stop', async () => {
    for (const category of ['opportunity', 'timeout']) {
        const f = fixture(), slug = `btc-updown-5m-${Math.floor(f.now / 300000) * 300}`;
        const engine = readyEntryEngine();
        Object.assign(engine, { settings: f.settings, config: { ...f.config, ai: { ...f.config.ai, slots: [90], slotToleranceMs: 2000 } },
            store: f.store, ai: { slots: {} }, current: { ...f.market, slug }, closed: false,
            observe: async () => { throw Object.assign(new Error('entry_deadline_passed'), { category }); } });
        await engine.discover(f.now);
        assert.equal(!!f.state.stopped, category === 'timeout');
    }
});

test('changed CLOB fees are rejected before any Laya inference or order reservation', async () => {
    const f = fixture(); let predictions = 0;
    const engine = readyEntryEngine();
    Object.assign(engine, { config: { ...f.config, ai: { ...f.config.ai, slotToleranceMs: 2000 } },
        store: f.store, books: { generation: 1 }, providers: { predict: async () => { predictions++; } },
        client: { books: async () => f.books, marketInfo: async () => ({ negRisk: false, feeInfo: { rate: .08, exponent: 1 }, tokens: [] }),
            validateInfo: TradingClient.prototype.validateInfo } });
    await assert.rejects(engine.observe(f.market, 90, 'key'), /metadata_mismatch/);
    assert.equal(predictions, 0); assert.equal(f.state.position.orders.length, 0);
});

test('a tick resync while flat skips its slot and a later valid slot can be observed', async () => {
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    const market = { ...f.market, slug: `btc-updown-5m-${Math.floor(f.now / 300000) * 300}` };
    let observations = 0;
    const engine = readyEntryEngine();
    Object.assign(engine, { store: f.store, settings: f.settings, config: { ...f.config,
        ai: { ...f.config.ai, slots: [90, 60], slotToleranceMs: 2000 } }, current: market,
        books: { generation: 2 }, ai: { slots: {} }, closed: false,
        observe: async () => { if (++observations === 1) throw new Error('execution_book_unavailable'); } });
    await engine.discover(f.now);
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null);
    assert.ok(f.events.some(e => e.type === 'laya_book_recovery_wait'));
    // The same slot is never retried, including after the book recovers.
    await engine.discover(f.now + 100); assert.equal(observations, 1);
    // Keep the test market in the same slug window independently of wall time.
    engine.current.end = f.now + 60000;
    await engine.discover(f.now); assert.equal(observations, 2);
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.seen, {});
});

test('a completed market reservation does not make a later flat book gap fatal', () => {
    const f = fixture(); f.state.position = null;
    const engine = readyEntryEngine(); engine.store = f.store;
    for (const event of ['book_tick_changed', 'book_gap']) engine.bookEvent(event);
    assert.equal(f.state.stopped, null); assert.ok(f.state.seen.market);
    f.state.position = { orders: [{ status: 'unknown' }] };
    engine.bookEvent('book_gap'); assert.equal(f.state.stopped.reason, 'live_book_feed_gap');
});

test('a book tick event discards warmup and cannot provide a decision snapshot until 180 valid seconds', () => {
    const f = fixture(), events = [];
    const stream = new BookHistory({ onEvent: type => events.push(type), clock: () => f.now });
    stream.tokens = ['up', 'down'];
    const ingest = at => {
        for (const token of stream.tokens) stream.ingest({ event_type: 'book', asset_id: token,
            timestamp: at, market: 'condition', tick_size: '.001', bids: [{ price: '.77', size: '10' }],
            asks: [{ price: '.78', size: '10' }] }, at);
    };
    ingest(f.now); const generation = stream.generation;
    stream.ingest({ event_type: 'tick_size_change', timestamp: f.now + 1000 }, f.now + 1000);
    assert.ok(stream.generation > generation); assert.equal(stream.snapshot(f.now + 1000), null);
    for (let elapsed = 2000; elapsed <= 181000; elapsed += 1000) ingest(f.now + elapsed);
    assert.equal(stream.snapshot(f.now + 181000), null);
    ingest(f.now + 182000); assert.ok(stream.snapshot(f.now + 182000));
    assert.ok(events.includes('book_tick_changed'));
});

test('invalid token/tick, future data, and a book gap after reservation still persist a live stop', async () => {
    for (const [code, exposed] of [['execution_token_mismatch', false], ['execution_tick_mismatch', false],
        ['execution_book_stale_or_future', false], ['execution_book_unavailable', true]]) {
        const f = fixture(); if (!exposed) f.state.position = null;
        const engine = readyEntryEngine();
        Object.assign(engine, { store: f.store, settings: f.settings, config: { ...f.config,
            ai: { ...f.config.ai, slots: [90], slotToleranceMs: 2000 } }, ai: { slots: {} }, closed: false,
            current: { ...f.market, slug: `btc-updown-5m-${Math.floor(f.now / 300000) * 300}` },
            observe: async () => { throw new Error(code); } });
        await engine.discover(f.now);
        assert.equal(f.state.stopped.reason, 'operational_check_failed', code);
    }
});

test('validation cannot permanently stop a flat book resync but still stops after market reservation', async () => {
    const f = fixture(), engine = readyEntryEngine();
    Object.assign(engine, { store: f.store, config: f.config, closed: false,
        entryContext: { market: f.market, snapshot: f.snapshot, decision: f.decision },
        books: { snapshot: () => null }, client: {} });
    const position = f.state.position; f.state.position = null;
    await assert.rejects(engine.validate(f.spec), /execution_book_unavailable/);
    assert.equal(f.state.stopped, null);
    f.state.position = position;
    await assert.rejects(engine.validate(f.spec), /execution_book_unavailable/);
    assert.equal(f.state.stopped.reason, 'stale_or_invalid_execution_data');
});

test('a gap during asynchronous snapshot validation is a recoverable pre-entry book miss', async () => {
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    const engine = readyEntryEngine();
    let gap = false, predictions = 0;
    const streamed = f.books.map((book, i) => ({ ...book, tokenId: f.market.tokens[i],
        conditionId: f.market.conditionId, timestamp: f.now, fetchedAt: f.now }));
    const stream = { generation: 1, tokens: f.market.tokens, snapshot: () => gap ? null : streamed };
    Object.assign(engine, { store: f.store, config: { ...f.config, ai: { ...f.config.ai, slotToleranceMs: 2000 } }, books: stream,
        client: { books: async () => f.books, marketInfo: async () => ({}), validateInfo() {},
            tickSize: async () => { gap = true; stream.generation = 2; return .01; } },
        providers: { predict: async () => { predictions++; } } });
    await assert.rejects(engine.observe(f.market, 90, 'key'), /execution_book_unavailable/);
    assert.equal(predictions, 0); assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
});

test('diagnostic entry veto runs after final validation and cannot reserve, sign or submit an order', async t => {
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    const streamed = f.books.map((book, i) => ({ ...book, tick: .01, tokenId: f.market.tokens[i],
        conditionId: f.market.conditionId, timestamp: f.now, fetchedAt: f.now }));
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: f.books, timing: {},
        features: { observedAt: f.now, state: { opening_twap: 100, spot: 101, twap: 100.5,
            margin_usd: 1, volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [0, 0, 0, 0, 0],
            bars_30s_OHLC_oldest_first: [], books_up_down: f.books.map(book => Object.fromEntries(
                ['bids', 'asks'].map(side => [side, book[side].map(level => [level.price, level.size])]))), seconds: 90 } } }));
    let validations = 0, checks = 0, vetoes = 0, submits = 0;
    const engine = readyEntryEngine();
    Object.assign(engine, { store: f.store, config: { ...f.config, ai: { ...f.config.ai, slotToleranceMs: 2000 } },
        books: { generation: 1, tokens: f.market.tokens, snapshot: () => streamed }, closed: false,
        ai: { slots: { key: {} }, snapshots: [] },
        client: { books: async () => f.books, marketInfo: async () => ({}), validateInfo() {},
            confirmedBlock: async () => 1, holdings: async () => [0, 0], warmOrderMetadata: async () => {} },
        providers: { predict: async (_name, snapshot) => ({ ...f.decision, snapshotId: snapshot.snapshotId }) },
        broker: { entryWallet: async () => { checks++; return {}; }, submit: async () => { submits++; } },
        assertSignal() {}, validate: async () => { validations++; },
        beforeReservation: async () => { vetoes++; return false; } });
    await engine.observe(f.market, 90, 'key');
    assert.equal(validations, 1); assert.equal(checks, 1); assert.equal(vetoes, 1); assert.equal(submits, 0);
    assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.ok(f.events.some(e => e.type === 'diagnostic_entry_validated'));
});

test('healthy inference with 5195 ms old input skips entry and preserves the consumed slot without stopping', async t => {
    // Start at the 90-second slot so the next slot stays in the same market,
    // regardless of the wall clock when the suite runs.
    let now = Date.UTC(2026, 9, 16, 0, 3, 30);
    t.mock.method(Date, 'now', () => now);
    const f = fixture(); Object.assign(f.state, { position: null, seen: {} });
    let predictions = 0, submits = 0, vetoes = 0, inputAge = 2314, inferenceMs = 2881;
    const streamed = f.books.map((book, i) => ({ ...book, tick: .01, tokenId: f.market.tokens[i],
        conditionId: f.market.conditionId, timestamp: now, fetchedAt: now }));
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: f.books, timing: {},
        features: { observedAt: now - inputAge, state: { opening_twap: 100, spot: 101, twap: 100.5,
            margin_usd: 1, volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [0, 0, 0, 0, 0],
            bars_30s_OHLC_oldest_first: [], books_up_down: f.books.map(book => Object.fromEntries(
                ['bids', 'asks'].map(side => [side, book[side].map(level => [level.price, level.size])]))), seconds: 90 } } }));
    const engine = readyEntryEngine();
    Object.assign(engine, { store: f.store, settings: f.settings,
        config: { ...f.config, ai: { ...f.config.ai, slots: [90, 60], slotToleranceMs: 2000 } },
        current: { ...f.market, slug: `btc-updown-5m-${Math.floor(f.now / 300000) * 300}` },
        books: { generation: 1, tokens: f.market.tokens,
            snapshot: () => streamed.map(book => ({ ...book, timestamp: now, fetchedAt: now })) }, closed: false,
        ai: { slots: {}, snapshots: [] },
        client: { books: async () => f.books, marketInfo: async () => ({}), validateInfo() {},
            btc: { assess: () => ({}) }, confirmedBlock: async () => 1, holdings: async () => [0, 0], warmOrderMetadata: async () => {} },
        providers: { predict: async (_name, snapshot) => {
            predictions++; now += inferenceMs; return { ...f.decision, snapshotId: snapshot.snapshotId };
        } },
        broker: { entryWallet: async () => ({ balance: 20 }), assertEntryWallet() {}, submit: async () => { submits++; } },
        beforeReservation: async () => { vetoes++; return false; } });
    await engine.discover(f.now);
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(predictions, 1); assert.equal(submits, 0); assert.equal(vetoes, 0);
    const key = `${engine.current.slug}:90`;
    assert.equal(engine.ai.slots[key].status, 'expired');
    assert.equal(engine.ai.snapshots[0].observedAt, f.now - 2314);
    const event = f.events.find(e => e.type === 'laya_decision_expired');
    assert.equal(event.detail.inputAgeMs, 5195); assert.equal(event.detail.responseMs, 2881);
    // A later tick/restart must retain this slot and cannot retry its decision.
    await engine.discover(now); assert.equal(predictions, 1);
    now = f.now + 30000; inputAge = 1000; inferenceMs = 2000;
    await engine.discover(now);
    assert.equal(predictions, 2); assert.equal(vetoes, 1); assert.equal(submits, 0);
    assert.equal(f.state.stopped, null); assert.equal(engine.ai.slots[key].status, 'expired');
    assert.equal(engine.ai.slots[`${engine.current.slug}:60`].status, 'observed');
});

test('decision timing keeps 3-second and 5-second boundaries and rejects future or missing timestamps', () => {
    const f = fixture(), snapshot = { at: f.now - 3000, observedAt: f.now - 5000, decisionReceivedAt: f.now };
    assert.doesNotThrow(() => assertDecisionTiming(snapshot, f.config, f.now));
    assert.throws(() => assertDecisionTiming({ ...snapshot, observedAt: f.now - 5001 }, f.config, f.now), /stale_laya_input/);
    assert.throws(() => assertDecisionTiming({ ...snapshot, at: f.now - 3001 }, f.config, f.now), /late_laya_response/);
    for (const change of [{ at: f.now + 1 }, { observedAt: snapshot.at + 1 }, { observedAt: NaN },
        { decisionReceivedAt: snapshot.at - 1 }, { decisionReceivedAt: f.now + 1 }])
        assert.throws(() => assertDecisionTiming({ ...snapshot, ...change }, f.config, f.now), /invalid_/);
});

test('expired decisions remain fatal after reservation; future timestamps remain fatal even while flat', async () => {
    for (const [expired, exposed] of [[true, false], [true, true], [false, false]]) {
        const f = fixture(); if (!exposed) f.state.position = null;
        f.snapshot.observedAt = expired ? f.now - 6000 : f.now + 1;
        const engine = readyEntryEngine();
        Object.assign(engine, { store: f.store, config: f.config, closed: false,
            entryContext: { market: f.market, snapshot: f.snapshot, decision: f.decision } });
        await assert.rejects(engine.validate(f.spec), expired ? /stale_laya_input/ : /invalid_laya_input_time/);
        assert.equal(f.state.stopped?.reason || null, !expired || exposed ? 'stale_or_invalid_execution_data' : null);
    }
});
