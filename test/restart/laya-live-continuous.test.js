import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../../src/restart/config.js';
import { MaintenanceEngine } from '../../src/laya-live/maintenance.js';
import { riskReason } from '../../src/restart/math.js';
import { atomicJson, Store } from '../../src/restart/store.js';
import { loadLiveConfig } from '../../src/laya-live/config.js';
import { entryGuard, LayaLiveEngine } from '../../src/laya-live/engine.js';
import { liveDeadline, liveDeadlineISO } from '../../src/laya-live/limits.js';
import { liveReadiness } from '../../src/laya-live/preflight.js';
import { bindContinuation } from '../../src/laya-live/recovery.js';
import { marketSlug } from '../../src/restart/strategy.js';

const hour = 3600000;
const now = Date.parse('2026-10-17T00:04:00Z');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-continuous-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function continuationFixture(t, { originalHours = 48, originalMarkets = 30, originalDrawdown = 2, removeMarkets = true } = {}) {
    const dataDir = temporaryDirectory(t);
    const originalPolicy = { schema: 4, provider: 'laya', model: 'typed-decisions',
        shares: 5, entryCap: 5, drawdownStop: originalDrawdown, pilotMarkets: originalMarkets, pilotHours: originalHours,
        aiSource: 'offline-source', capitalAllocation: 'available_balance' };
    const sources = [['src/laya-live/engine.js', 'a'.repeat(64)]];
    const periodId = hash({ policy: originalPolicy, hashes: sources }).slice(0, 16);
    const directory = path.join(dataDir, periodId, 'pilot');
    const manifestFile = path.join(directory, 'laya-manifest.json');
    const ledgerFile = path.join(directory, 'late-entry.json');
    const approvalFile = path.join(dataDir, 'laya-live-continuation.json');
    const state = { baseline: periodId, decisionProvider: 'laya', startedAt: now - 72 * hour,
        mode: 'pilot', strategy: 'late-entry', cash: 19.5, walletStart: 20, walletCashDelta: -.5,
        peakEquity: 22, maxDrawdown: 2.5, stopped: { reason: 'drawdown_limit', at: now - hour },
        position: null, seen: { 'past-market': { snapshotId: 'past-decision' } },
        completed: Array.from({ length: 31 }, (_, i) => ({ slug: `past-market-${i}`,
            traded: true, pnl: i === 0 ? -.5 : 0, fees: i === 0 ? .02 : 0, gas: 0 })),
        liveFunding: { initialCapital: 20 }, ai: { sourceExperiment: 'offline-source',
            providers: {}, slots: { 'past-market:60': { status: 'observed' } },
            snapshots: [{ snapshotId: 'past-decision', decision: { action: 'SKIP' } }] } };
    const manifest = { id: periodId, policy: originalPolicy, sources, startedAt: state.startedAt };
    const policy = { ...originalPolicy, pilotHours: null, ...(removeMarkets ? { pilotMarkets: null } : {}) };
    const config = { id: 'f'.repeat(16), policy, ai: { id: 'f'.repeat(16) },
        settings: { dataDir, fingerprint: 'f'.repeat(16), pilotHours: Infinity,
            drawdownStop: 2, pilotMarkets: removeMarkets ? Infinity : originalMarkets } };
    const approval = { schema: 1, runtimeId: config.id, periodId,
        policyChange: { reason: removeMarkets ? 'user_removed_live_limits' : 'user_removed_live_deadline',
            previousPolicySha256: hash(originalPolicy), currentPolicySha256: hash(policy) } };
    atomicJson(manifestFile, manifest);
    atomicJson(ledgerFile, state);
    atomicJson(approvalFile, approval);
    return { config, approval, state, manifest, periodId, directory, manifestFile, ledgerFile, approvalFile };
}

test('continuous deadlines have an explicit null representation while finite fixtures retain their boundary', () => {
    const state = { startedAt: now - 72 * hour };
    assert.equal(liveDeadline(state, { pilotHours: Infinity }), Infinity);
    assert.equal(liveDeadlineISO(state, { pilotHours: Infinity }), null);
    assert.equal(liveDeadline(state, { pilotHours: 48 }), state.startedAt + 48 * hour);
    assert.equal(liveDeadlineISO(state, { pilotHours: 48 }), new Date(state.startedAt + 48 * hour).toISOString());
    for (const pilotHours of [null, undefined, NaN, -Infinity, 0, -1, '48']) {
        assert.throws(() => liveDeadline(state, { pilotHours }), /invalid_live_time_limit/);
    }
    for (const startedAt of [NaN, Infinity, -1, undefined]) {
        for (const pilotHours of [48, Infinity]) {
            assert.throws(() => liveDeadline({ startedAt }, { pilotHours }), /invalid_live_time_limit/);
        }
    }
});

test('effective live settings remove time and count stops while preserving drawdown and finite fixture boundaries', t => {
    const directory = temporaryDirectory(t);
    const config = loadLiveConfig({ ...process.env, RESTART_DATA_DIR: directory,
        LAYA_PROFIT_TAKING_ENABLED: 'false', LAYA_PROFIT_RECIPIENT: '' });
    assert.equal(config.policy.pilotHours, null);
    assert.equal(config.policy.pilotMarkets, null);
    assert.equal(config.settings.pilotHours, Infinity);
    assert.equal(config.settings.pilotMarkets, Infinity);
    assert.equal(config.policy.drawdownStop, 10);
    assert.equal(config.settings.drawdownStop, 10);
    assert.equal(config.ai.drawdownStop, 10);
    const fresh = () => ({ mode: 'pilot', startedAt: now - 72 * hour,
        cash: 20, peakEquity: 20, maxDrawdown: 0, completed: [] });
    assert.equal(riskReason(fresh(), config.settings, now, 20), null);
    assert.equal(riskReason(fresh(), config.settings, now, 18), null);
    assert.equal(riskReason(fresh(), config.settings, now, 15), null);
    assert.equal(riskReason(fresh(), config.settings, now, 10.00002), null);
    assert.equal(riskReason(fresh(), config.settings, now, 10), 'drawdown_limit');
    assert.equal(riskReason(fresh(), config.settings, now, 9.999998), 'drawdown_limit');
    for (const count of [29, 30, 31, 300]) {
        const state = { ...fresh(), completed: Array.from({ length: count }, () => ({})) };
        assert.equal(riskReason(state, config.settings, now, 20), null);
        assert.equal(riskReason(state, config.settings, now, 18), null);
        assert.equal(riskReason(state, config.settings, now, 15), null);
        assert.equal(riskReason(state, config.settings, now, 10), 'drawdown_limit');
    }
    assert.equal(riskReason({ ...fresh(), completed: Array.from({ length: 30 }, () => ({})) },
        { ...config.settings, pilotMarkets: 30 }, now, 20), 'market_limit');
    assert.equal(riskReason(fresh(), { ...config.settings, pilotHours: 48 }, now, 20), 'time_limit');
});

test('an exact approved 30-market and 48-hour removal preserves the original ledger, history and stop', t => {
    const f = continuationFixture(t);
    const ledger = fs.readFileSync(f.ledgerFile), manifest = fs.readFileSync(f.manifestFile);
    const files = fs.readdirSync(f.directory);
    const bound = bindContinuation(f.config);
    assert.equal(bound.id, f.periodId);
    assert.equal(bound.runtimeId, f.config.id);
    assert.equal(bound.settings.fingerprint, f.periodId);
    assert.equal(bound.ai.id, f.periodId);
    assert.equal(bound.settings.pilotHours, Infinity);
    assert.equal(bound.settings.pilotMarkets, Infinity);
    assert.equal(bound.policy.pilotHours, null);
    assert.equal(bound.policy.pilotMarkets, null);
    assert.deepEqual(fs.readFileSync(f.ledgerFile), ledger);
    assert.deepEqual(fs.readFileSync(f.manifestFile), manifest);
    assert.deepEqual(fs.readdirSync(f.directory), files);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.ledgerFile)), f.state);
    const restarted = new Store(bound.settings, 'pilot', 'late-entry');
    assert.deepEqual(restarted.state, f.state);
    assert.equal(restarted.state.completed.length, 31);
    assert.equal(riskReason(restarted.state, bound.settings, now, restarted.state.cash), 'drawdown_limit');
    assert.throws(() => entryGuard({ state: restarted.state }), /pilot_stopped/);
    assert.deepEqual(liveReadiness({ state: restarted.state, operationalReady: true }).blockers,
        ['persistent_pilot_stop']);
});

function approvedDrawdownIncrease(f) {
    f.config.policy.drawdownStop = 10;
    f.config.settings.drawdownStop = 10;
    f.config.ai.drawdownStop = 10;
    f.approval.policyChange = { reason: 'user_increased_live_drawdown_limit',
        previousDrawdownStop: 2, currentDrawdownStop: 10,
        previousPolicySha256: hash(f.manifest.policy), currentPolicySha256: hash(f.config.policy),
        previousRuntimePolicySha256: hash({ ...f.manifest.policy, pilotMarkets: null, pilotHours: null }) };
    atomicJson(f.approvalFile, f.approval);
}

test('approved $10 drawdown continuation preserves historical peak, losses, and latched stop across restart', t => {
    const f = continuationFixture(t);
    f.state.cash = 17.786758; f.state.maxDrawdown = 4.213242;
    atomicJson(f.ledgerFile, f.state);
    approvedDrawdownIncrease(f);
    const ledger = fs.readFileSync(f.ledgerFile), manifest = fs.readFileSync(f.manifestFile);
    const bound = bindContinuation(f.config);
    assert.equal(bound.id, f.periodId); assert.equal(bound.settings.drawdownStop, 10);
    assert.equal(bound.ai.drawdownStop, 10);
    assert.deepEqual(fs.readFileSync(f.ledgerFile), ledger);
    assert.deepEqual(fs.readFileSync(f.manifestFile), manifest);
    const restarted = new Store(bound.settings, 'pilot', 'late-entry');
    assert.deepEqual(restarted.state, f.state);
    assert.throws(() => entryGuard({ state: restarted.state }), /pilot_stopped/);
    assert.equal(riskReason(restarted.state, bound.settings, now, f.state.cash), null);
    assert.deepEqual(restarted.state.stopped, f.state.stopped, 'policy approval cannot clear the old stop');
    assert.equal(restarted.state.peakEquity, 22);
    assert.ok(Math.abs(restarted.state.maxDrawdown - 4.213242) < .000001);
    assert.equal(riskReason(restarted.state, bound.settings, now, 17), null);
    assert.equal(riskReason(restarted.state, bound.settings, now, 12.00002), null);
    assert.equal(riskReason(restarted.state, bound.settings, now, 12), 'drawdown_limit');
    assert.equal(restarted.state.peakEquity, 22);
    assert.equal(restarted.state.maxDrawdown, 10);
    assert.deepEqual(restarted.state.stopped, f.state.stopped);
    assert.deepEqual(restarted.state.completed, f.state.completed);
});

for (const [name, mutate] of [
    ['absent prior limit', f => { delete f.approval.policyChange.previousDrawdownStop; }],
    ['absent approved limit', f => { delete f.approval.policyChange.currentDrawdownStop; }],
    ['wrong prior limit', f => { f.approval.policyChange.previousDrawdownStop = 3; }],
    ['superseded approved limit', f => { f.approval.policyChange.currentDrawdownStop = 5; }],
    ['unapproved reason', f => { f.approval.policyChange.reason = 'user_removed_live_limits'; }],
    ['missing prior runtime policy hash', f => { delete f.approval.policyChange.previousRuntimePolicySha256; }],
    ['forged prior runtime policy hash', f => { f.approval.policyChange.previousRuntimePolicySha256 = '0'.repeat(64); }],
    ['unapproved risk limit', f => { f.config.policy.drawdownStop = 11; f.approval.policyChange.currentDrawdownStop = 11; }],
    ['changed entry budget', f => { f.config.policy.entryCap = 6; }],
    ['changed size', f => { f.config.policy.shares = 6; }],
]) test(`drawdown continuation rejects ${name} even with refreshed policy hashes`, t => {
    const f = continuationFixture(t); approvedDrawdownIncrease(f); mutate(f);
    f.approval.policyChange.currentPolicySha256 = hash(f.config.policy);
    atomicJson(f.approvalFile, f.approval);
    const ledger = fs.readFileSync(f.ledgerFile), manifest = fs.readFileSync(f.manifestFile);
    assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
    assert.deepEqual(fs.readFileSync(f.ledgerFile), ledger);
    assert.deepEqual(fs.readFileSync(f.manifestFile), manifest);
    if (name === 'unapproved risk limit') for (const limit of [5, 20, '10', null]) {
        f.config.policy.drawdownStop = limit;
        f.approval.policyChange.currentDrawdownStop = limit;
        f.approval.policyChange.currentPolicySha256 = hash(f.config.policy);
        atomicJson(f.approvalFile, f.approval);
        assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
        assert.deepEqual(fs.readFileSync(f.ledgerFile), ledger);
    }
    if (name === 'forged prior runtime policy hash') {
        f.approval.policyChange.previousRuntimePolicySha256 = hash({ ...f.manifest.policy,
            drawdownStop: 5, pilotMarkets: null, pilotHours: null });
        atomicJson(f.approvalFile, f.approval);
        assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
        assert.deepEqual(fs.readFileSync(f.ledgerFile), ledger);
    }
});

test('the previous exact time-only approval remains valid without authorizing a count removal', t => {
    const f = continuationFixture(t, { removeMarkets: false });
    const before = fs.readFileSync(f.ledgerFile);
    const bound = bindContinuation(f.config);
    assert.equal(bound.id, f.periodId);
    assert.equal(bound.policy.pilotMarkets, 30);
    assert.equal(bound.settings.pilotMarkets, 30);
    assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
    f.config.policy.pilotMarkets = null;
    f.config.settings.pilotMarkets = Infinity;
    f.approval.policyChange.currentPolicySha256 = hash(f.config.policy);
    atomicJson(f.approvalFile, f.approval);
    assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
});

for (const [name, change] of [
    ['missing policy approval', approval => { delete approval.policyChange; }],
    ['missing previous hash', approval => { delete approval.policyChange.previousPolicySha256; }],
    ['missing current hash', approval => { delete approval.policyChange.currentPolicySha256; }],
    ['forged previous hash', approval => { approval.policyChange.previousPolicySha256 = '0'.repeat(64); }],
    ['forged current hash', approval => { approval.policyChange.currentPolicySha256 = '0'.repeat(64); }],
    ['unrelated approval reason', approval => { approval.policyChange.reason = 'reviewed_runtime_repair'; }],
    ['time-only approval reason', approval => { approval.policyChange.reason = 'user_removed_live_deadline'; }],
    ['malformed policy approval', approval => { approval.policyChange = 'user_removed_live_limits'; }],
]) test(`live-limit removal rejects ${name}`, t => {
    const f = continuationFixture(t);
    change(f.approval);
    atomicJson(f.approvalFile, f.approval);
    assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
});

test('matching hashes cannot approve other policy changes or different original limits', t => {
    for (const change of [{ drawdownStop: 3 }, { pilotMarkets: 31 }, { shares: 6 }, { entryCap: 6 },
        { pilotHours: 96 }, { provider: 'other' }, { aiSource: 'other-source' },
        { capitalAllocation: 'rebase' }, { minimumBalance: 10 }]) {
        const f = continuationFixture(t);
        f.config.policy = { ...f.config.policy, ...change };
        f.approval.policyChange.currentPolicySha256 = hash(f.config.policy);
        atomicJson(f.approvalFile, f.approval);
        assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
    }
    for (const original of [{ originalHours: 24 }, { originalHours: null }, { originalMarkets: 31 },
        { originalMarkets: null }]) {
        const other = continuationFixture(t, original);
        assert.throws(() => bindContinuation(other.config), /live_continuation_policy_mismatch/);
    }
    for (const original of [{ originalDrawdown: 5 }, { originalDrawdown: 10 }, { originalHours: 24 },
        { originalHours: null }, { originalMarkets: 31 }, { originalMarkets: null }]) {
        const other = continuationFixture(t, original); approvedDrawdownIncrease(other);
        const ledger = fs.readFileSync(other.ledgerFile);
        assert.throws(() => bindContinuation(other.config), /live_continuation_policy_mismatch/);
        assert.deepEqual(fs.readFileSync(other.ledgerFile), ledger);
    }
});

test('live-limit approval retains the runtime, manifest, and original ledger identity checks', t => {
    const f = continuationFixture(t);
    assert.throws(() => bindContinuation({ ...f.config, id: 'e'.repeat(16) }), /live_continuation_runtime_mismatch/);
    atomicJson(f.manifestFile, { ...f.manifest, sources: [] });
    assert.throws(() => bindContinuation(f.config), /live_continuation_policy_mismatch/);
    atomicJson(f.manifestFile, f.manifest);
    for (const change of [{ startedAt: f.state.startedAt + 1 }, { baseline: 'e'.repeat(16) },
        { decisionProvider: 'other' }]) {
        atomicJson(f.ledgerFile, { ...f.state, ...change });
        assert.throws(() => bindContinuation(f.config), /live_continuation_ledger_mismatch/);
    }
});

for (const [name, change] of [
    ['wrong schema', approval => { approval.schema = 2; }],
    ['wrong runtime', approval => { approval.runtimeId = 'e'.repeat(16); }],
    ['missing runtime', approval => { delete approval.runtimeId; }],
    ['invalid period', approval => { approval.periodId = '../unsafe'; }],
    ['missing period', approval => { delete approval.periodId; }],
]) test(`live-limit removal rejects ${name} without changing the ledger`, t => {
    const f = continuationFixture(t), before = fs.readFileSync(f.ledgerFile);
    change(f.approval);
    atomicJson(f.approvalFile, f.approval);
    assert.throws(() => bindContinuation(f.config), /live_continuation_runtime_mismatch/);
    assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
});

for (const file of ['approvalFile', 'manifestFile', 'ledgerFile']) {
    test(`malformed ${file} fails closed without replacing evidence`, t => {
        const f = continuationFixture(t);
        fs.writeFileSync(f[file], '{broken');
        const before = fs.readFileSync(f.ledgerFile);
        assert.throws(() => bindContinuation(f.config), SyntaxError);
        assert.equal(fs.readFileSync(f[file], 'utf8'), '{broken');
        assert.deepEqual(fs.readFileSync(f.ledgerFile), before);
    });
}

test('live discovery continues beyond 30 completed markets and drawdown remains persistent after restart', async t => {
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Offline live test must not access the network'));
    const config = loadLiveConfig({ RESTART_DATA_DIR: temporaryDirectory(t),
        LAYA_PROFIT_TAKING_ENABLED: 'false', LAYA_PROFIT_RECIPIENT: '' });
    const store = new Store(config.settings, 'pilot', 'late-entry');
    store.logger = () => {};
    Object.assign(store.state, { startedAt: now - 72 * hour, cash: 20, peakEquity: 20,
        walletStart: 20, walletCashDelta: 0, liveFunding: { initialCapital: 20 },
        completed: Array.from({ length: 31 }, (_, i) => ({ slug: `past-${i}`,
            traded: true, pnl: 0, fees: 0, gas: 0, closedAt: now - (32 - i) * 300000 })) });
    const history = structuredClone(store.state.completed);
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(),
        confirmedBlock: async () => 1, balance: async () => store.state.cash };
    const engine = new LayaLiveEngine(config, store, client, {}, {});
    engine.watch = t.mock.fn(async () => {});
    engine.discover = t.mock.fn(async () => {});
    await engine.tick(now);
    assert.equal(engine.discover.mock.callCount(), 1);
    assert.equal(store.state.stopped, null);
    assert.deepEqual(store.state.completed, history);
    store.state.cash = 15;
    store.state.walletCashDelta = -5;
    await engine.tick(now + 1);
    assert.equal(engine.discover.mock.callCount(), 2);
    assert.equal(store.state.stopped, null);
    store.state.cash = 10;
    store.state.walletCashDelta = -10;
    await engine.tick(now + 2);
    assert.equal(engine.discover.mock.callCount(), 2);
    assert.equal(store.state.stopped.reason, 'drawdown_limit');
    assert.equal(store.state.maxDrawdown, 10);
    assert.equal(store.state.peakEquity, 20);
    const restarted = new Store(config.settings, 'pilot', 'late-entry');
    assert.deepEqual(restarted.state.stopped, store.state.stopped);
    assert.deepEqual(restarted.state.completed, history);
    assert.equal(restarted.state.startedAt, now - 72 * hour);
    assert.equal(restarted.state.walletCashDelta, -10);
    assert.equal(restarted.state.peakEquity, 20);
    assert.throws(() => entryGuard({ state: restarted.state }), /pilot_stopped/);
    assert.deepEqual(liveReadiness({ state: restarted.state, operationalReady: true }).blockers,
        ['persistent_pilot_stop', 'persistent_live_risk_stop']);
});

test('a read-only CLI report displays no deadline after 72 hours and leaves its ledger unchanged', t => {
    const directory = temporaryDirectory(t);
    const env = { ...process.env, RESTART_DATA_DIR: path.join(directory, 'live'),
        LAYA_PAPER_DATA_DIR: path.join(directory, 'paper'), AI_SHADOW_DATA_DIR: path.join(directory, 'shadow'),
        LAYA_PROFIT_TAKING_ENABLED: 'false', LAYA_PROFIT_RECIPIENT: '', LAYA_TEST_HOME: directory };
    const config = loadLiveConfig(env);
    const filename = path.join(env.RESTART_DATA_DIR, config.id, 'pilot', 'late-entry.json');
    const state = { baseline: config.id, decisionProvider: 'laya', mode: 'pilot', strategy: 'late-entry',
        startedAt: now - 72 * hour, cash: 20, peakEquity: 20, maxDrawdown: 0,
        stopped: null, position: null, completed: Array.from({ length: 31 }, () => ({
            traded: true, pnl: 0, fees: 0, gas: 0, closedAt: now - hour })), seen: {}, failures: 0,
        liveFunding: { initialCapital: 20 }, ai: { snapshots: [], providers: {} } };
    atomicJson(filename, state);
    const before = fs.readFileSync(filename);
    const bootstrap = 'data:text/javascript,' + encodeURIComponent(
        "import os from 'node:os'; os.homedir = () => process.env.LAYA_TEST_HOME;");
    const result = spawnSync(process.execPath, ['--import', bootstrap, path.join(ROOT, 'scripts/laya-live.js'), 'report'], {
        cwd: ROOT, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.liveStarted, true);
    assert.equal(report.deadline, null);
    assert.equal(report.configuration.limits.pilotHours, null);
    assert.equal(report.configuration.limits.pilotMarkets, null);
    assert.equal(report.startedAt, state.startedAt);
    assert.deepEqual(fs.readFileSync(filename), before);
    assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['late-entry.json']);
});

test('market watching continues after 48 hours while finite fixture deadlines still stop watching', async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('Offline watch test must not access the network'));
    t.mock.method(MaintenanceEngine.prototype, 'tick', async () => {});
    const state = { startedAt: now - 72 * hour, stopped: null, position: null };
    const watch = t.mock.fn(async () => {});
    const engine = Object.assign(Object.create(LayaLiveEngine.prototype), {
        settings: { pilotHours: Infinity }, store: { state }, books: {}, watch,
        client: { startBtcFeed() {} }, closed: false,
        clockGate: { check: async () => true, fresh: () => true, verifiedAt: now } });
    await engine.tick(now);
    assert.equal(watch.mock.callCount(), 1);
    engine.settings.pilotHours = 48;
    await engine.tick(now);
    assert.equal(watch.mock.callCount(), 1);
    assert.equal(state.startedAt, now - 72 * hour);
    assert.equal(state.stopped, null);
});

test('fresh snapshot collection still validates current market data after 72 hours without inference', async t => {
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Offline snapshot test must not access the network'));
    const settings = { pilotHours: Infinity, late: { duration: 300 } };
    const config = { settings, policy: { aiSource: 'offline-source' }, ai: {
        slots: [60], slotToleranceMs: 2000, dataAgeMs: 5000, snapshotWaitMs: 0,
        shares: 5, entryCap: 5, gasUsd: .05, control: settings } };
    const market = { slug: marketSlug('late-entry', settings, now), conditionId: 'offline-condition',
        open: now - 240000, end: now + 60000, accepting: true, minimum: 5,
        tokens: ['offline-up', 'offline-down'], tick: .01, ticks: [.01, .01],
        reference: { value: 83000 }, fee: { rate: .07, exponent: 1, takerOnly: true } };
    // Both sides are below the entry minimum so collection ends without any inference or order operation.
    const rows = market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId,
        tick: .01, timestamp: now, fetchedAt: now,
        bids: [{ price: .29, size: 10 }], asks: [{ price: .30, size: 10 }] }));
    const btc = { spot: Array.from({ length: 181 }, (_, index) => ({
        at: now - (180 - index) * 1000, receivedAt: now - (180 - index) * 1000, value: 83000 + index / 10 })),
        twap: { at: now, receivedAt: now, value: 83020 },
        openings: new Map([[market.open, { value: 83000 }]]), status: () => ({ ready: true }) };
    const client = { btc, books: async () => rows, marketInfo: async () => ({}), validateInfo() {} };
    const stream = { generation: 1, tokens: market.tokens, snapshot: () => rows };
    const state = { startedAt: now - 72 * hour, cash: 20, stopped: null, position: null };
    const events = [];
    const store = { state, save() {}, event: (type, detail) => events.push({ type, ...detail }) };
    const providers = { predict: () => assert.fail('Invalid entry prices must not request inference') };
    const engine = new LayaLiveEngine(config, store, client, stream, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    const key = `${market.slug}:60`;
    state.ai.slots[key] = { status: 'reserved' };
    await engine.observe(market, 60, key);
    assert.equal(state.ai.slots[key].status, 'no_valid_side');
    assert.equal(events.at(-1).type, 'laya_opportunity_skipped');
    assert.equal(state.ai.snapshots.length, 0);
    assert.equal(state.position, null);
    assert.equal(state.stopped, null);
});
