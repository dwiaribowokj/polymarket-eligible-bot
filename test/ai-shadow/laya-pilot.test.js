import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE, ROOT, loadSettings } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { risk } from '../../src/ai-shadow/engine.js';
import { loadLayaConfig } from '../../src/laya-pilot/config.js';
import { LayaProvider } from '../../src/laya-pilot/provider.js';
import { LayaStore } from '../../src/laya-pilot/store.js';
import { LayaPaperEngine } from '../../src/laya-pilot/engine.js';
import { summarizeLaya } from '../../src/laya-pilot/report.js';
import { parseArgs, publicReader } from '../../scripts/laya-pilot.js';

function fixture() {
    let now = Date.parse('2026-10-15T12:03:30Z'), price = .78, size = 10, payout = null;
    const config = { id: 'fixture', sources: [], root: ROOT, deadline: now + 48 * 3600000,
        slots: [90, 60, 30], slotToleranceMs: 2000, capital: 20, shares: 5, entryCap: 5, gasUsd: .05,
        latencyMs: 250, settlementMs: 2500, dataAgeMs: 5000, decisionMs: 3000,
        drawdownStop: 2, shadowDrawdownStop: 2, maxMarkets: 30, hours: 48,
        limitSlippageTicks: 1, limitSlippageUsd: .01,
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const signal = new BtcSignal(config.control.lateSignal);
    for (let i = -185; i <= 0; i++) signal.ingest({ topic: 'prices.crypto', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now + i * 1000, value: 83020 } }, now + i * 1000);
    signal.ingest({ topic: 'prices.crypto.twap', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now, value: 83020, windowSeconds: 60 } }, now);
    const market = { slug: 'btc-updown-5m-fixture', conditionId: 'condition', open: now - 210000, end: now + 90000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const opening = { at: market.open, receivedAt: market.open + 100, value: 83000 };
    signal.openings.set(market.open, opening);
    market.reference = { source: 'chainlink_twap_60s', open: market.open, end: market.end,
        value: 83000, observedAt: market.open, receivedAt: opening.receivedAt };
    const getBooks = () => [
        { tokenId: 'up', conditionId: 'condition', tick: .01, timestamp: now, fetchedAt: now, bids: [{ price: price - .01, size: 10 }], asks: [{ price, size }] },
        { tokenId: 'down', conditionId: 'condition', tick: .01, timestamp: now, fetchedAt: now, bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] }];
    const books = { generation: 1, tokens: market.tokens, snapshot: getBooks, watch() {}, close() {}, socket: { readyState: 1 } };
    const arm = { cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null, seen: {}, position: null, completed: [], outcomes: {} };
    const state = { id: 'fixture', startedAt: now, deadline: config.deadline, frozenAt: null, providers: {},
        slots: { [market.slug + ':90']: { status: 'reserved' } }, snapshots: [], errors: {},
        markets: { [market.slug]: { open: market.open, end: market.end, conditionId: 'condition' } }, arms: { laya: arm } };
    const store = { state, save() {}, event() {}, error() {}, freeze(at) { if (at >= config.deadline) state.frozenAt ||= config.deadline; } };
    const requested = [];
    const providers = { async predict(name, snapshot) { requested.push(name); return { snapshotId: snapshot.snapshotId,
        status: 'ok', action: 'BUY_UP', latencyMs: 0 }; }, close() {} };
    const client = { btc: signal, async books() { return getBooks(); }, async payout() { return payout; }, startBtcFeed() {}, close() {} };
    const engine = new LayaPaperEngine(config, store, client, books, providers, { clock: () => now });
    return { config, market, state, arm, store, signal, providers, client, engine, requested,
        get now() { return now; }, advance(ms) { now += ms; }, price(p) { price = p; }, size(s) { size = s; }, payout(p) { payout = p; } };
}

test('Laya CLI cannot activate live or accept hidden trading flags', () => {
    assert.equal(parseArgs([]).command, 'preflight');
    assert.equal(parseArgs(['preflight', '--wallet']).wallet, true);
    for (const args of [['live'], ['pilot'], ['paper', '--live'], ['paper', '--strategy=maker-mm'], ['report', '--wallet']]) assert.throws(() => parseArgs(args));
});

test('paper facade excludes wallet signer and every transaction operation', () => {
    const reader = publicReader(loadSettings());
    try {
        for (const key of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction', 'authenticate', 'walletHealth', 'settings']) assert.equal(reader[key], undefined);
        assert.ok(Object.isFrozen(reader)); assert.equal(typeof reader.payout, 'function');
    } finally { reader.close(); }
});

test('period configuration preserves deadline across restart and leaves original baseline unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-config-'));
    try {
        const original = loadSettings().fingerprint;
        const env = { ...process.env, LAYA_PAPER_DATA_DIR: dir };
        const first = loadLayaConfig(env, 1000000000);
        assert.equal(fs.existsSync(path.join(dir, 'active.json')), false);
        fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id: first.id, deadline: first.deadline }));
        const second = loadLayaConfig(env, 1000000000 + 3600000);
        assert.equal(second.deadline, first.deadline); assert.equal(second.id, first.id);
        assert.equal(loadSettings().fingerprint, original);
        fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id: 'changed', deadline: first.deadline }));
        assert.throws(() => loadLayaConfig(env), /identity_changed/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('provider preflight accesses only local Laya and persists artifact mismatch', async () => {
    const urls = [], state = {};
    let identity = 'original';
    const provider = new LayaProvider({ layaUrl: 'http://local', decisionMs: 100, layaDrainMs: 100 }, state, () => {}, {
        fetch: async url => { urls.push(url); return { ok: true, json: async () => ({ loaded: ['typed-decisions'] }) }; },
        counter: { async start() { return { identity, maxTokens: 1024 }; }, close() {} } });
    try {
        assert.equal((await provider.preflight()).laya.ready, true);
        assert.deepEqual(urls, ['http://local/health']);
        identity = 'replacement'; assert.equal((await provider.preflight()).laya.ready, false);
        identity = 'original'; assert.equal((await provider.preflight()).laya.ready, false);
        assert.equal(state.laya.disabled, 'laya_artifact_changed');
        await assert.rejects(provider.predict('9router', {}), /laya_only/);
    } finally { provider.close(); }
});

test('single-arm ledger preserves filled inventory, stops, and ambiguous inference after restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-store-'));
    try {
        const config = { ...fixture().config, dataDir: dir, ninerouterKey: 'do-not-save', privateKey: 'do-not-save-either' };
        let store = new LayaStore(config);
        assert.deepEqual(Object.keys(store.state.arms), ['laya']);
        assert.ok(!fs.readFileSync(path.join(store.dir, 'manifest.json'), 'utf8').includes('do-not-save'));
        store.state.arms.laya.position = { status: 'filled', holdings: 2, market: { slug: 'filled' } };
        store.state.arms.laya.stopped = { reason: 'research_drawdown_limit', at: 123 };
        store.state.providers.laya = { pending: { snapshotId: 'unknown' } }; store.save();
        store = new LayaStore(config);
        assert.equal(store.state.arms.laya.position.holdings, 2);
        assert.equal(store.state.arms.laya.stopped.at, 123);
        assert.equal(store.state.providers.laya.disabled, 'restart_with_unknown_inference');
        store.state.arms.laya.position = { status: 'pending', market: { slug: 'pending' } }; store.save();
        store = new LayaStore(config); assert.equal(store.state.arms.laya.position, null);
        assert.equal(store.state.arms.laya.outcomes.pending.reason, 'restart_during_pending_execution');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only Laya receives a snapshot, retains safety gates, and reserves one fixed-limit entry', async () => {
    const f = fixture(); await f.engine.observe(f.market, 90, f.market.slug + ':90');
    assert.deepEqual(f.requested, ['laya']);
    assert.deepEqual(Object.keys(f.state.snapshots[0].decisions), ['laya']);
    assert.equal(f.arm.position.order.shares, 5); assert.equal(f.arm.position.order.price, .79);
    await f.engine.observe(f.market, 90, f.market.slug + ':90'); assert.equal(f.requested.length, 1);
});

test('history, opening TWAP, and late snapshot failures cannot reach inference', async () => {
    for (const mutate of [f => f.signal.openings.clear(), f => { f.signal.spot = f.signal.spot.slice(-50); }, f => f.advance(2001)]) {
        const f = fixture(); mutate(f);
        await assert.rejects(f.engine.observe(f.market, 90, f.market.slug + ':90'));
        assert.equal(f.requested.length, 0); assert.equal(f.arm.position, null);
    }
});

test('late or stale responses never reserve a position', async () => {
    for (const ms of [3001, 5001]) {
        const f = fixture();
        f.providers.predict = async (_name, s) => { f.advance(ms); return { snapshotId: s.snapshotId, status: 'ok', action: 'BUY_UP' }; };
        await f.engine.observe(f.market, 90, f.market.slug + ':90'); assert.equal(f.arm.position, null);
    }
});

test('partial FAK cannot chase and waits for official settlement', async () => {
    const f = fixture(); await f.engine.observe(f.market, 90, f.market.slug + ':90');
    f.size(2); f.advance(300); await f.engine.manage(f.now);
    assert.equal(f.arm.position.status, 'matched'); assert.equal(f.arm.cash, 20);
    f.advance(2600); await f.engine.manage(f.now); assert.equal(f.arm.position.holdings, 2);
    f.advance(90000); await f.engine.manage(f.now); assert.equal(f.arm.completed.length, 0);
    f.payout([1, 0]); f.advance(16000); await f.engine.manage(f.now);
    assert.equal(f.arm.completed.length, 1); assert.equal(f.arm.completed[0].partial, true);
    assert.equal(Object.keys(f.arm.seen).length, 1);
});

test('no fill beyond precommitted limit retains cash and consumed market attempt', async () => {
    const f = fixture(); await f.engine.observe(f.market, 90, f.market.slug + ':90');
    f.price(.80); f.advance(300); await f.engine.manage(f.now);
    assert.equal(f.arm.position, null); assert.equal(f.arm.cash, 20);
    assert.equal(f.arm.outcomes[f.market.slug].reason, 'no_fill');
    await f.engine.observe(f.market, 90, f.market.slug + ':90'); assert.equal(f.requested.length, 1);
});

test('drawdown at $2 freezes further entries while leaving filled inventory managed', async () => {
    const f = fixture(); await f.engine.observe(f.market, 90, f.market.slug + ':90');
    f.advance(300); await f.engine.manage(f.now); f.advance(2600); await f.engine.manage(f.now);
    risk(f.arm, f.config, 17.99, f.now); assert.ok(f.arm.stopped);
    await f.engine.tick(f.now); await Promise.allSettled([...f.engine.tasks]);
    assert.ok(f.state.frozenAt); assert.equal(f.arm.position.status, 'filled');
    risk(f.arm, f.config, 21, f.now); assert.ok(f.arm.stopped);
});

test('30 completed markets stop new observations without resetting the ledger', async () => {
    const f = fixture(); f.arm.completed = Array.from({ length: 30 }, () => ({ pnl: 1 }));
    await f.engine.tick(f.now); await Promise.allSettled([...f.engine.tasks]);
    assert.equal(f.arm.stopped.reason, 'market_limit'); assert.ok(f.state.frozenAt); assert.equal(f.requested.length, 0);
});

test('positive small sample remains unqualified and timeout is excluded from completed response latency', () => {
    const f = fixture();
    f.arm.completed = [{ pnl: 1, fees: .03, gas: .05, closedAt: f.now }];
    f.state.snapshots = [{ decisions: { laya: { status: 'decision_timeout', latencyMs: 3000 } } }];
    const report = summarizeLaya(f.state, f.now + 3600000);
    assert.equal(report.liveReady, false); assert.equal(report.decision, 'belum layak pilot');
    assert.ok(report.reasons.includes('need_7_days')); assert.ok(report.reasons.includes('need_100_filled_markets'));
    assert.equal(report.latencyMs.p95, null); assert.equal(report.netAfterAllCosts, null);
});
