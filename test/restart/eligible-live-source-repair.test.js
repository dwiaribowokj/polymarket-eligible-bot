import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store, atomicJson } from '../../src/restart/store.js';
import { newPosition } from '../../src/restart/strategy.js';
import { loadEligibleConfig } from '../../src/eligible-live/config.js';
import { bindRuntimeContinuation, eligibleManifestPath } from '../../src/eligible-live/continuation.js';
import { bindRiskPeriod, readRiskPeriodHistory } from '../../src/eligible-live/period.js';
import { prepareBaseSourceRepair, prepareBaseBinanceLeadVeto, verifiedBaseSourceRepair } from '../../src/eligible-live/source-repair.js';
import { ELIGIBLE_BINANCE_LEAD_VETO } from '../../src/eligible-live/binance-lead.js';
import { initializeContinuousState } from '../../src/eligible-live/continuous-recovery.js';
import { initializeEligibleStrategyEpoch } from '../../src/eligible-live/strategy-epochs.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`;
const identity = config => jsonHash({ policy: config.policy, sources: config.sources,
    profitTaking: config.profitTaking }).slice(0, 16);

function snapshot(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort()
        .map(filename => [path.relative(root, filename), digest(fs.readFileSync(filename))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-source-repair-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = { RESTART_DATA_DIR: dataDir, PROXY_WALLET_ADDRESS: wallet,
        PRIVATE_KEY: `0x${'1'.repeat(64)}`, ELIGIBLE_CONTINUOUS_TRADING: 'true',
        ELIGIBLE_ENTRY_COST_CAP: 'true', LAYA_PROFIT_TAKING_ENABLED: 'true',
        LAYA_PROFIT_RECIPIENT: `0x${'c'.repeat(40)}` };
    const config = loadEligibleConfig(env);
    const original = { policy: structuredClone(config.policy), sources: [['src/original.js', 'a'.repeat(64)]],
        profitTaking: structuredClone(config.profitTaking) };
    const periodId = identity(original), store = new Store({ ...config.settings, fingerprint: periodId }, 'pilot', 'late-entry');
    const state = store.state;
    Object.assign(state, { startedAt: 1000, decisionProvider: 'eligible', cash: 10.25,
        peakEquity: 14, maxDrawdown: 3.75, lastEquity: 10.25,
        walletStart: 10, walletCashDelta: .25,
        liveFunding: { at: 1000, initialCapital: 10, allocation: 'available_balance' },
        continuousOperation: { enabledAt: 1100, runtimeId: periodId },
        ai: { providers: { eligible: { pending: null } }, slots: { reserved: true },
            snapshots: [{ snapshotId: 'kept-snapshot', at: 1500 }] },
        completed: [{ slug: 'previous-market', traded: true, pnl: .25, fees: .01, gas: .02,
            closedAt: 1400, tokens: ['3', '4'] }],
        stopHistory: [{ reason: 'operational_check_failed', at: 1050, recoveredAt: 1100 }],
        reconciliationFaults: {}, entryHolds: { external_activity: { retryable: true, code: 'external_activity_busy' } },
        strategyEpochs: [{ id: '0123456789abcdef', periodId, runtimeId: periodId, startedAt: 1100,
            policy: structuredClone(config.policy), firstCompletedIndex: 0, firstSnapshotIndex: 0,
            walletProof: { blockNumber: 50, blockHash: `0x${'1'.repeat(64)}`, balance: 10,
                trades: {}, holdingsProof: { holdings: [] } } }],
        currentStrategyEpochId: '0123456789abcdef' });
    const market = { slug: 'btc-updown-5m-empty-reservation', tokens: ['1', '2'],
        conditionId: `0x${'2'.repeat(64)}`, open: 1200, end: 1800 };
    state.position = newPosition(market, { cost: 4 }, state, 1500);
    Object.assign(state.position, { pendingTrades: false, submitAttemptedAt: 1550, payout: [1, 0],
        entrySignal: { snapshotId: 'kept-snapshot', strategyEpochId: state.currentStrategyEpochId } });
    state.seen[market.slug] = 1500;
    store.save();
    const manifest = { id: periodId, runtimeId: periodId, ...original, startedAt: state.startedAt };
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(manifestFile, manifest);
    const approval = { schema: 1, runtimeId: config.runtimeId, originalRuntimeId: periodId, periodId,
        reason: 'base_period_source_repair', originalManifestSha256: digest(fs.readFileSync(manifestFile)),
        fundingSha256: jsonHash(state.liveFunding), ledgerStartedAt: state.startedAt,
        wallet, dataDir, stateSha256: jsonHash(state), approvedAt: 2000 };
    const approvalFile = path.join(dataDir, 'continuation.json');
    const saveApproval = () => atomicJson(approvalFile, approval);
    const repin = () => { store.save(); approval.stateSha256 = jsonHash(state); saveApproval(); };
    saveApproval(); env.ELIGIBLE_LIVE_CONTINUATION = approvalFile;
    return { dataDir, env, config, store, state, periodId, manifest, manifestFile, approval, approvalFile,
        saveApproval, repin, bind: () => bindRiskPeriod(bindRuntimeContinuation(config, env)) };
}

function advanceSourceRepair(f, at) {
    const config = f.bind(), next = prepareBaseSourceRepair(f.state, config, at);
    Object.assign(f.state, next); f.store.save();
    const manifestFile = eligibleManifestPath(config);
    atomicJson(manifestFile, { id: config.id, runtimeId: config.runtimeId, policy: config.policy,
        sources: config.sources, profitTaking: config.profitTaking, startedAt: f.state.startedAt });
    const previous = structuredClone(f.approval);
    f.config.sources = [[`src/revision-${at}.js`, digest(String(at))]];
    f.config.runtimeId = identity(f.config);
    Object.assign(f.approval, { runtimeId: f.config.runtimeId, stateSha256: jsonHash(f.state),
        approvedAt: at + 100, sourceRepairMigration: { previousRuntimeId: config.runtimeId,
            previousManifestSha256: digest(fs.readFileSync(manifestFile)), previousContinuation: previous,
            previousContinuationSha256: jsonHash(previous) } });
    f.saveApproval();
    return manifestFile;
}

function chainedFixture(t) {
    const f = fixture(t);
    f.state.position = null; f.state.entryHolds = {}; f.repin();
    return { ...f, previousManifestFile: advanceSourceRepair(f, 2100) };
}

test('base source repair retains the original funded period and does not write during binding', t => {
    const f = fixture(t), before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.runtimeId, f.config.runtimeId);
    assert.notEqual(config.runtimeId, config.id);
    assert.equal(config.settings.fingerprint, f.periodId);
    assert.equal(config.ai.id, f.periodId);
    assert.equal(config.ai.control, config.settings);
    assert.equal(config.riskPeriod, undefined);
    assert.equal(Object.isFrozen(config.runtimeContinuation), true);
    assert.equal(verifiedBaseSourceRepair(config), config.runtimeContinuation);
    assert.deepEqual(new Store(config.settings, 'pilot', 'late-entry').state, f.state);
    assert.deepEqual(readRiskPeriodHistory(config), [f.state]);
    assert.equal(loadEligibleConfig(f.env).id, f.periodId);
    assert.deepEqual(snapshot(f.dataDir), before);
});

test('repair manifests use a revision and leave the original manifest intact', t => {
    const f = fixture(t), before = fs.readFileSync(f.manifestFile), config = f.bind();
    const revision = eligibleManifestPath(config);
    assert.equal(revision, path.join(f.dataDir, f.periodId, 'eligible-runtime', 'revisions', config.runtimeId, 'manifest.json'));
    atomicJson(revision, { ...f.manifest, runtimeId: config.runtimeId, sources: config.sources });
    assert.deepEqual(fs.readFileSync(f.manifestFile), before);
    assert.equal(f.bind().id, f.periodId);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'eligible-risk-periods')), false);
});

test('base continuation rejects altered identity, policy, funding and approval pins', async t => {
    const cases = {
        'different wallet': f => { f.approval.wallet = `0x${'d'.repeat(40)}`; },
        'zero wallet': f => { f.approval.wallet = `0x${'0'.repeat(40)}`; f.config.settings.wallet = f.approval.wallet; },
        'different data directory': f => { f.approval.dataDir = path.dirname(f.dataDir); },
        'relative data directory': f => { f.config.settings.dataDir = '.'; },
        'different base period': f => { f.approval.periodId = '0123456789abcdef'; },
        'same runtime': f => { f.approval.runtimeId = f.periodId; },
        'bad state hash': f => { f.approval.stateSha256 = 'bad'; },
        'approval before funding': f => { f.approval.approvedAt = 999; },
        'unknown approval field': f => { f.approval.clearStop = true; },
        'risk record pin': f => { f.approval.riskRecordSha256 = 'a'.repeat(64); },
        'wrong manifest hash': f => { f.approval.originalManifestSha256 = 'f'.repeat(64); },
        'wrong funding hash': f => { f.approval.fundingSha256 = 'f'.repeat(64); },
        'changed ledger start': f => { f.state.startedAt++; f.store.save(); },
        'changed funding': f => { f.state.liveFunding.initialCapital++; f.store.save(); },
        'changed ledger provider': f => { f.state.decisionProvider = 'laya'; f.store.save(); },
        'changed policy': f => { f.config.policy.entryCap = 10; f.config.runtimeId = identity(f.config);
            f.approval.runtimeId = f.config.runtimeId; },
        'changed profit recipient': f => { f.config.profitTaking.recipient = `0x${'d'.repeat(40)}`;
            f.config.runtimeId = identity(f.config); f.approval.runtimeId = f.config.runtimeId; },
        'changed source bytes': f => { f.config.sources[0][1] = 'f'.repeat(64); },
        'unsafe source path': f => { f.config.sources = [['../source.js', 'a'.repeat(64)]];
            f.config.runtimeId = identity(f.config); f.approval.runtimeId = f.config.runtimeId; },
        'existing risk binding': f => { f.config.riskPeriod = { periodId: f.periodId }; },
        'existing continuation': f => { f.config.runtimeContinuation = {}; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = fixture(t); change(f); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_/);
    });
});

test('a base repair cannot bypass risk namespaces or symbolic artifact paths', async t => {
    const cases = {
        'original risk namespace': f => fs.mkdirSync(path.join(f.dataDir, 'eligible-risk-periods', f.periodId), { recursive: true }),
        'new risk namespace': f => fs.mkdirSync(path.join(f.dataDir, 'eligible-risk-periods', f.config.runtimeId), { recursive: true }),
        'risk root symlink': f => fs.symlinkSync(f.dataDir, path.join(f.dataDir, 'eligible-risk-periods')),
        'manifest symlink': f => { const target = path.join(f.dataDir, 'manifest-copy.json');
            fs.renameSync(f.manifestFile, target); fs.symlinkSync(target, f.manifestFile); },
        'ledger symlink': f => { const target = path.join(f.dataDir, 'ledger-copy.json');
            fs.renameSync(f.store.filename, target); fs.symlinkSync(target, f.store.filename); },
        'period directory symlink': f => { const original = path.join(f.dataDir, f.periodId), target = `${original}-copy`;
            fs.renameSync(original, target); fs.symlinkSync(target, original); },
        'public approval': f => fs.chmodSync(f.approvalFile, 0o644),
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = fixture(t); change(f);
        assert.throws(f.bind, /eligible_continuation_/);
    });
});

test('offline migration changes only audited runtime lineage and preserves the empty reservation', t => {
    const f = fixture(t), config = f.bind(), before = structuredClone(f.state), files = snapshot(f.dataDir);
    assert.throws(() => initializeContinuousState(config, f.state, { now: () => 2100 }), /eligible_continuous_recovery_unproven/);
    const next = prepareBaseSourceRepair(f.state, config, 2100);
    assert.deepEqual(f.state, before);
    assert.deepEqual(snapshot(f.dataDir), files);
    assert.equal(next.continuousOperation.runtimeId, config.runtimeId);
    assert.equal(next.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.deepEqual(next.continuousOperationHistory, [{ ...before.continuousOperation, migratedAt: 2100,
        nextRuntimeId: config.runtimeId, reasonVerified: 'base_period_source_repair',
        beforeSha256: f.approval.stateSha256, previousManifestSha256: f.approval.originalManifestSha256 }]);
    const restored = structuredClone(next);
    restored.continuousOperation.runtimeId = before.continuousOperation.runtimeId;
    delete restored.continuousOperationHistory;
    assert.deepEqual(restored, before);
    assert.equal(initializeContinuousState(config, next, { now: () => 2200 }), false);
    assert.equal(initializeEligibleStrategyEpoch(next, config, 2200), next.strategyEpochs[0]);
    assert.deepEqual(next.strategyEpochs, before.strategyEpochs);
    assert.deepEqual(next.position, before.position);
    assert.deepEqual(next.entryHolds, before.entryHolds);
    assert.throws(() => prepareBaseSourceRepair(next, config, 2200), /eligible_source_repair_unproven/);
    f.store.state = next; f.store.save();
    assert.equal(f.bind().id, f.periodId);
});

test('metadata migration preserves a latched stop and cannot erase it during rebinding', t => {
    const f = fixture(t);
    f.state.stopped = { reason: 'operational_check_failed', at: 1900 };
    f.repin();
    const config = f.bind(), next = prepareBaseSourceRepair(f.state, config, 2100);
    assert.deepEqual(next.stopped, f.state.stopped);
    assert.deepEqual(next.stopHistory, f.state.stopHistory);
    f.store.state = next; f.store.save();
    assert.deepEqual(new Store(f.bind().settings, 'pilot', 'late-entry').state.stopped, f.state.stopped);
});

test('offline migration requires the exact reviewed state and no pending financial writes', async t => {
    const cases = {
        'ledger changed after approval': f => { f.state.events++; },
        'open submitted order': f => { f.state.position.orders.push({ status: 'pending', filled: 0 }); f.repin(); },
        'nonzero holdings': f => { f.state.position.holdings[0] = 1; f.repin(); },
        'accounted entry cost': f => { f.state.position.entryCost = 1; f.repin(); },
        'pending trade': f => { f.state.position.pendingTrades = true; f.repin(); },
        'uncertain reservation': f => { f.state.position.uncertain = true; f.repin(); },
        'pending provider': f => { f.state.ai.providers.eligible.pending = { id: 'pending' }; f.repin(); },
        'pending withdrawal': f => { f.state.profitTakingControl = { operation: { stage: 'address_ready' } }; f.repin(); },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: 1900 }; f.repin(); },
        'frozen ledger': f => { f.state.frozenAt = 1900; f.repin(); },
        'wrong prior runtime': f => { f.state.continuousOperation.runtimeId = '0123456789abcdef'; f.repin(); },
        'operation enabled after approval': f => { f.state.continuousOperation.enabledAt = 2001; f.repin(); },
        'duplicate migration': f => { f.state.continuousOperationHistory = [{ nextRuntimeId: f.config.runtimeId }]; f.repin(); },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = fixture(t); change(f); const config = f.bind(), before = structuredClone(f.state);
        assert.throws(() => prepareBaseSourceRepair(f.state, config, 2100), /eligible_source_repair_unproven/);
        assert.deepEqual(f.state, before);
    });
    await t.test('clock before approval', t => {
        const f = fixture(t);
        assert.throws(() => prepareBaseSourceRepair(f.state, f.bind(), 1999), /eligible_source_repair_unproven/);
    });
});

test('verified configuration cannot be cloned or changed to authorize a different repair', async t => {
    const cases = {
        'wallet': config => { config.settings.wallet = `0x${'d'.repeat(40)}`; },
        'data directory': config => { config.settings.dataDir = path.dirname(config.settings.dataDir); },
        'policy': config => { config.policy.entryCap++; },
        'source': config => { config.sources[0][1] = 'f'.repeat(64); },
        'profit recipient': config => { config.profitTaking.recipient = `0x${'d'.repeat(40)}`; },
        'AI identity': config => { config.ai.id = '0123456789abcdef'; },
        'settings identity': config => { config.settings.fingerprint = '0123456789abcdef'; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = fixture(t), config = f.bind(); change(config);
        assert.equal(verifiedBaseSourceRepair(config), null);
        assert.throws(() => prepareBaseSourceRepair(f.state, config, 2100), /eligible_source_repair_unproven/);
    });
    await t.test('copied validated object', t => {
        const f = fixture(t), config = { ...f.bind() };
        assert.equal(verifiedBaseSourceRepair(config), null);
        assert.throws(() => bindRiskPeriod(config), /eligible_period_missing_pointer/);
        assert.throws(() => prepareBaseSourceRepair(f.state, config, 2100), /eligible_source_repair_unproven/);
    });
});

test('successive source repairs preserve funded history and all immutable predecessor manifests', t => {
    const f = chainedFixture(t), before = structuredClone(f.state), files = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.riskPeriod, undefined);
    assert.deepEqual(snapshot(f.dataDir), files);
    const next = prepareBaseSourceRepair(f.state, config, 2300);
    assert.deepEqual(next.continuousOperationHistory.slice(0, -1), before.continuousOperationHistory);
    assert.deepEqual(next.continuousOperationHistory.at(-1), { ...before.continuousOperation,
        migratedAt: 2300, nextRuntimeId: config.runtimeId, reasonVerified: 'base_period_source_repair',
        beforeSha256: f.approval.stateSha256,
        previousManifestSha256: digest(fs.readFileSync(f.previousManifestFile)) });
    const restored = structuredClone(next);
    restored.continuousOperation = before.continuousOperation;
    restored.continuousOperationHistory = before.continuousOperationHistory;
    assert.deepEqual(restored, before);
    assert.equal(initializeContinuousState(config, next, { now: () => 2400 }), false);
    assert.equal(initializeEligibleStrategyEpoch(next, config, 2400).id, before.currentStrategyEpochId);
    assert.deepEqual(snapshot(f.dataDir), files);
    f.store.state = next; f.store.save();
    next.events++; f.store.save();
    assert.equal(f.bind().id, f.periodId);
    assert.throws(() => prepareBaseSourceRepair(next, config, 2400), /eligible_source_repair_unproven/);
    for (const [name, hash] of files.filter(([name]) => name.endsWith('manifest.json')))
        assert.equal(digest(fs.readFileSync(path.join(f.dataDir, name))), hash);
});

test('successive source repair validates every earlier approval and lineage edge', t => {
    const f = chainedFixture(t);
    advanceSourceRepair(f, 2300);
    const next = prepareBaseSourceRepair(f.state, f.bind(), 2500);
    assert.equal(next.continuousOperationHistory.length, 3);
    assert.deepEqual(next.continuousOperationHistory.slice(0, -1), f.state.continuousOperationHistory);
    f.state.continuousOperationHistory[0].beforeSha256 = 'f'.repeat(64); f.repin();
    assert.throws(() => prepareBaseSourceRepair(f.state, f.bind(), 2500), /eligible_source_repair_unproven/);
});

test('successive source repairs reject altered predecessors and unsafe revision artifacts', async t => {
    const cases = {
        'unknown migration field': f => { f.approval.sourceRepairMigration.clearStop = true; },
        'missing migration field': f => { delete f.approval.sourceRepairMigration.previousContinuationSha256; },
        'null migration': f => { f.approval.sourceRepairMigration = null; },
        'wrong predecessor hash': f => { f.approval.sourceRepairMigration.previousContinuationSha256 = 'f'.repeat(64); },
        'wrong predecessor manifest hash': f => { f.approval.sourceRepairMigration.previousManifestSha256 = 'f'.repeat(64); },
        'wrong predecessor runtime': f => { f.approval.sourceRepairMigration.previousRuntimeId = '0123456789abcdef'; },
        'altered predecessor approval': f => { f.approval.sourceRepairMigration.previousContinuation.approvedAt++; },
        'backwards approval time': f => { f.approval.approvedAt = 1999; },
        'changed predecessor manifest': f => { fs.appendFileSync(f.previousManifestFile, '\n'); },
        'absent predecessor manifest': f => { fs.unlinkSync(f.previousManifestFile); },
        'predecessor risk namespace': f => { fs.mkdirSync(path.join(f.dataDir, 'eligible-risk-periods',
            f.approval.sourceRepairMigration.previousRuntimeId), { recursive: true }); },
        'predecessor manifest symlink': f => {
            const target = path.join(f.dataDir, 'previous-manifest.json');
            fs.renameSync(f.previousManifestFile, target); fs.symlinkSync(target, f.previousManifestFile);
        },
        'predecessor revision directory symlink': f => {
            const dir = path.dirname(f.previousManifestFile), target = `${dir}-copy`;
            fs.renameSync(dir, target); fs.symlinkSync(target, dir);
        },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = chainedFixture(t); change(f); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_|ENOENT/);
    });
    for (const field of ['originalRuntimeId', 'periodId', 'fundingSha256', 'originalManifestSha256',
        'ledgerStartedAt', 'wallet', 'dataDir', 'reason']) await t.test(`repinned predecessor ${field}`, t => {
        const f = chainedFixture(t), migration = f.approval.sourceRepairMigration;
        migration.previousContinuation[field] = field === 'ledgerStartedAt' ? 999 : 'changed';
        migration.previousContinuationSha256 = jsonHash(migration.previousContinuation); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_source_repair_predecessor_mismatch/);
    });
    await t.test('repinned predecessor policy', t => {
        const f = chainedFixture(t), migration = f.approval.sourceRepairMigration;
        const manifest = JSON.parse(fs.readFileSync(f.previousManifestFile));
        manifest.policy.entryCap++; atomicJson(f.previousManifestFile, manifest);
        migration.previousManifestSha256 = digest(fs.readFileSync(f.previousManifestFile)); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_source_repair_predecessor_mismatch/);
    });
    await t.test('repinned predecessor profit recipient', t => {
        const f = chainedFixture(t), migration = f.approval.sourceRepairMigration;
        const manifest = JSON.parse(fs.readFileSync(f.previousManifestFile));
        manifest.profitTaking.recipient = `0x${'d'.repeat(40)}`; atomicJson(f.previousManifestFile, manifest);
        migration.previousManifestSha256 = digest(fs.readFileSync(f.previousManifestFile)); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_source_repair_predecessor_mismatch/);
    });
});

test('successive source repairs require exact reviewed state and unaltered prior lineage', async t => {
    const cases = {
        'missing lineage': f => { delete f.state.continuousOperationHistory; },
        'extra lineage': f => { f.state.continuousOperationHistory.push({ ...f.state.continuousOperationHistory[0] }); },
        'null lineage row': f => { f.state.continuousOperationHistory[0] = null; },
        'wrong current runtime': f => { f.state.continuousOperation.runtimeId = f.periodId; },
        'changed enablement time': f => { f.state.continuousOperation.enabledAt++; },
        'migration before prior approval': f => { f.state.continuousOperationHistory[0].migratedAt = 1999; },
        'migration after current approval': f => { f.state.continuousOperationHistory[0].migratedAt = 2201; },
        'wrong history predecessor': f => { f.state.continuousOperationHistory[0].runtimeId = '0123456789abcdef'; },
        'wrong history destination': f => { f.state.continuousOperationHistory[0].nextRuntimeId = '0123456789abcdef'; },
        'wrong history manifest': f => { f.state.continuousOperationHistory[0].previousManifestSha256 = 'f'.repeat(64); },
        'wrong history state': f => { f.state.continuousOperationHistory[0].beforeSha256 = 'f'.repeat(64); },
        'wrong history reason': f => { f.state.continuousOperationHistory[0].reasonVerified = 'manual_reset'; },
        'unknown lineage field': f => { f.state.continuousOperationHistory[0].clearStop = true; },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: 2150 }; },
        'frozen ledger': f => { f.state.frozenAt = 2150; },
        'pending provider': f => { f.state.ai.providers.eligible.pending = { id: 'pending' }; },
        'pending withdrawal': f => { f.state.profitTakingControl = { operation: { stage: 'address_ready' } }; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, t => {
        const f = chainedFixture(t); change(f); f.repin();
        const before = structuredClone(f.state), config = f.bind();
        assert.throws(() => prepareBaseSourceRepair(f.state, config, 2300), /eligible_source_repair_unproven/);
        assert.deepEqual(f.state, before);
    });
    await t.test('state changed after approval', t => {
        const f = chainedFixture(t), config = f.bind(); f.state.events++;
        assert.throws(() => prepareBaseSourceRepair(f.state, config, 2300), /eligible_source_repair_unproven/);
    });
    await t.test('latched operational stop remains intact', t => {
        const f = chainedFixture(t); f.state.stopped = { reason: 'operational_check_failed', at: 2150 }; f.repin();
        assert.deepEqual(prepareBaseSourceRepair(f.state, f.bind(), 2300).stopped, f.state.stopped);
    });
});

test('source repair chains reject repeated runtimes and excessive predecessor depth', async t => {
    await t.test('repeated runtime', t => {
        const f = chainedFixture(t), first = structuredClone(f.approval.sourceRepairMigration.previousContinuation);
        advanceSourceRepair(f, 2300);
        const earlier = JSON.parse(fs.readFileSync(f.previousManifestFile));
        f.config.sources = earlier.sources; f.config.runtimeId = first.runtimeId;
        f.approval.runtimeId = first.runtimeId; f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_source_repair_cycle/);
    });
    await t.test('depth limit', t => {
        const f = fixture(t);
        for (let index = 0; index < 9; index++) advanceSourceRepair(f, 2100 + index * 200);
        assert.throws(f.bind, /eligible_continuation_approval_depth/);
    });
});

function baseLeadVetoFixture(t, { chained = true, cap = '0.82', emptyProviders = false } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-base-lead-veto-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const baseEnv = {
        RESTART_DATA_DIR: dataDir,
        PROXY_WALLET_ADDRESS: wallet,
        PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        ELIGIBLE_CONTINUOUS_TRADING: 'true',
        ELIGIBLE_ENTRY_COST_CAP: 'true',
        ELIGIBLE_ENTRY_COST_CAP_MAX: cap,
        LAYA_PROFIT_TAKING_ENABLED: 'true',
        LAYA_PROFIT_TRIGGER: 'wallet_balance',
        LAYA_PROFIT_LOSS_PROTECTION_ENABLED: 'true',
        LAYA_PROFIT_RECIPIENT: `0x${'c'.repeat(40)}`,
    };
    const original = loadEligibleConfig(baseEnv);
    const originalSources = [['src/original.js', 'a'.repeat(64)]];
    const originalCfg = { ...original, sources: originalSources };
    const periodId = identity(originalCfg);
    const store = new Store({ ...original.settings, fingerprint: periodId }, 'pilot', 'late-entry');
    const state = store.state;
    Object.assign(state, {
        startedAt: 1000, decisionProvider: 'eligible', cash: 11.71, peakEquity: 14.24,
        maxDrawdown: 3.94, lastEquity: 11.71, walletStart: 0, walletCashDelta: 6.78,
        liveFunding: { at: 1000, initialCapital: 0, allocation: 'available_balance' },
        continuousOperation: { enabledAt: 1100, runtimeId: periodId },
        ai: { providers: emptyProviders ? {} : { eligible: { pending: null } }, slots: { reserved: true },
            snapshots: [{ snapshotId: 'snap-1', at: 1500 }] },
        completed: [{ slug: 'previous-market', traded: true, pnl: 1.41, fees: 0.02, gas: 0.05,
            closedAt: 1400, tokens: ['3', '4'] }],
        stopHistory: [{ reason: 'operational_check_failed', at: 1900, recoveredAt: 2000 }],
        reconciliationFaults: {}, entryHolds: {},
        strategyEpochs: [{ id: '0d9b634c12d346aa', periodId, runtimeId: periodId, startedAt: 1100,
            policy: structuredClone(original.policy), firstCompletedIndex: 0, firstSnapshotIndex: 0 }],
        currentStrategyEpochId: '0d9b634c12d346aa',
    });
    store.save();
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: periodId, policy: original.policy,
        sources: originalSources, profitTaking: original.profitTaking, startedAt: state.startedAt });
    const approvalFile = path.join(dataDir, 'continuation.json');

    let previousContinuation = null, previousManifestFile = manifestFile, previousRuntimeId = periodId;
    if (chained) {
        let currentCfg = { ...originalCfg, runtimeId: periodId };
        let currentApproval = null;
        for (const [index, at] of [2100, 2300].entries()) {
            const nextSources = [[`src/repair-${index}.js`, digest(`repair-${index}`)]];
            const nextCfg = { ...currentCfg, sources: nextSources };
            nextCfg.runtimeId = identity(nextCfg);
            const repairApproval = {
                schema: 1, runtimeId: nextCfg.runtimeId, originalRuntimeId: periodId, periodId,
                reason: 'base_period_source_repair',
                originalManifestSha256: digest(fs.readFileSync(manifestFile)),
                fundingSha256: jsonHash(state.liveFunding), ledgerStartedAt: state.startedAt,
                wallet, dataDir, stateSha256: jsonHash(state), approvedAt: at,
                ...(currentApproval ? {
                    sourceRepairMigration: {
                        previousRuntimeId: currentCfg.runtimeId,
                        previousManifestSha256: digest(fs.readFileSync(previousManifestFile)),
                        previousContinuation: currentApproval,
                        previousContinuationSha256: jsonHash(currentApproval),
                    },
                } : {}),
            };
            atomicJson(approvalFile, repairApproval);
            const bound = bindRiskPeriod(bindRuntimeContinuation(
                { ...original, runtimeId: nextCfg.runtimeId, sources: nextSources },
                { ELIGIBLE_LIVE_CONTINUATION: approvalFile }));
            const nextState = prepareBaseSourceRepair(state, bound, at + 50);
            Object.assign(state, nextState);
            store.save();
            previousManifestFile = eligibleManifestPath(bound);
            atomicJson(previousManifestFile, { id: periodId, runtimeId: bound.runtimeId, policy: bound.policy,
                sources: bound.sources, profitTaking: bound.profitTaking, startedAt: state.startedAt });
            currentCfg = bound;
            currentApproval = repairApproval;
        }
        previousContinuation = currentApproval;
        previousRuntimeId = currentCfg.runtimeId;
    }

    const targetEnv = { ...baseEnv, ELIGIBLE_ENTRY_BINANCE_LEAD_VETO: 'true' };
    const bareLead = loadEligibleConfig(targetEnv);
    const leadSources = [['src/lead-veto.js', digest('lead-veto')]];
    const leadConfig = { ...bareLead, sources: leadSources, runtimeId: identity({ ...bareLead, sources: leadSources }) };
    const approval = {
        schema: 1,
        runtimeId: leadConfig.runtimeId,
        originalRuntimeId: periodId,
        periodId,
        reason: 'base_period_binance_lead_veto',
        originalManifestSha256: digest(fs.readFileSync(manifestFile)),
        fundingSha256: jsonHash(state.liveFunding),
        ledgerStartedAt: state.startedAt,
        wallet,
        dataDir,
        stateSha256: jsonHash(state),
        approvedAt: 2500,
        policyChange: {
            previousPolicySha256: jsonHash(original.policy),
            currentPolicySha256: jsonHash(leadConfig.policy),
        },
        ...(chained ? {
            entryBinanceLeadVeto: {
                previousRuntimeId,
                previousManifestSha256: digest(fs.readFileSync(previousManifestFile)),
                previousContinuation,
                previousContinuationSha256: jsonHash(previousContinuation),
            },
        } : {}),
    };
    const saveApproval = () => atomicJson(approvalFile, approval);
    const repin = () => {
        store.save();
        approval.stateSha256 = jsonHash(state);
        saveApproval();
    };
    saveApproval();
    targetEnv.ELIGIBLE_LIVE_CONTINUATION = approvalFile;
    return {
        dataDir, env: targetEnv, config: leadConfig, original, store, state, periodId,
        manifestFile, previousManifestFile, approval, approvalFile, saveApproval, repin,
        bind: () => bindRiskPeriod(bindRuntimeContinuation(leadConfig, targetEnv)),
    };
}

test('base_period_binance_lead_veto supports direct and chained base-period migration without writes or risk reset', async t => {
    for (const [label, opts] of [
        ['chained after 2x base_period_source_repair', { chained: true, emptyProviders: true }],
        ['direct from original base period', { chained: false, emptyProviders: false }],
    ]) {
        await t.test(label, t => {
            const f = baseLeadVetoFixture(t, opts), files = snapshot(f.dataDir), before = structuredClone(f.state);
            const bound = f.bind();
            assert.equal(bound.id, f.periodId);
            assert.equal(bound.runtimeId, f.config.runtimeId);
            assert.equal(bound.riskPeriod, undefined);
            assert.deepEqual(bound.policy.entryFilter.binanceLeadVeto, ELIGIBLE_BINANCE_LEAD_VETO);
            assert.equal(eligibleManifestPath(bound), path.join(f.dataDir, f.periodId,
                'eligible-runtime', 'revisions', bound.runtimeId, 'manifest.json'));
            assert.deepEqual(snapshot(f.dataDir), files);
            assert.throws(() => prepareBaseSourceRepair(f.state, bound, 2600), /eligible_source_repair_unproven/);

            const walletProof = { blockNumber: 98040000, blockHash: `0x${'a'.repeat(64)}`, balance: 0 };
            const next = prepareBaseBinanceLeadVeto(f.state, bound, 2600, { walletProof });
            assert.deepEqual(f.state, before);
            assert.deepEqual(snapshot(f.dataDir), files);
            assert.equal(next.continuousOperation.runtimeId, bound.runtimeId);
            assert.equal(next.continuousOperationHistory.length, (before.continuousOperationHistory?.length || 0) + 1);
            assert.equal(next.continuousOperationHistory.at(-1).reasonVerified, 'base_period_binance_lead_veto');
            assert.equal(next.continuousOperationHistory.at(-1).nextRuntimeId, bound.runtimeId);
            assert.equal(next.strategyEpochs.length, 2);
            assert.equal(next.currentStrategyEpochId, next.strategyEpochs[1].id);
            assert.equal(next.strategyEpochs[1].previousStrategyEpochId, before.currentStrategyEpochId);
            assert.equal(next.strategyEpochs[1].reason, 'base_period_binance_lead_veto');
            assert.deepEqual(next.strategyEpochs[1].policy, bound.policy);
            assert.deepEqual(next.strategyEpochs[1].walletProof, walletProof);
            assert.equal(next.cash, before.cash);
            assert.equal(next.maxDrawdown, before.maxDrawdown);
            assert.equal(next.peakEquity, before.peakEquity);
            assert.deepEqual(next.completed, before.completed);
            assert.deepEqual(next.stopHistory, before.stopHistory);
            assert.equal(initializeContinuousState(bound, next, { now: () => 2700 }), false);
            assert.equal(initializeEligibleStrategyEpoch(next, bound, 2700), next.strategyEpochs[1]);
            assert.throws(() => prepareBaseBinanceLeadVeto(next, bound, 2700), /eligible_source_repair_unproven/);
            f.store.state = next; f.store.save();
            assert.equal(f.bind().id, f.periodId);
        });
    }
});

test('base_period_binance_lead_veto rejects tampered policies, predecessors, risk namespaces, and non-flat state', async t => {
    const bindRejections = {
        'altered lead threshold': f => {
            f.config.policy = {
                ...f.config.policy,
                entryFilter: {
                    ...f.config.policy.entryFilter,
                    binanceLeadVeto: { ...ELIGIBLE_BINANCE_LEAD_VETO, thresholdBps: 3 },
                },
            };
            f.config.runtimeId = identity(f.config); f.approval.runtimeId = f.config.runtimeId;
            f.approval.policyChange.currentPolicySha256 = jsonHash(f.config.policy);
        },
        'cap 0.85 manifest': f => {
            const g = baseLeadVetoFixture(t, { chained: false, cap: '0.85' });
            assert.throws(g.bind, /eligible_continuation_manifest_mismatch/);
        },
        'changed profit recipient': f => {
            f.config.profitTaking.recipient = `0x${'d'.repeat(40)}`;
            f.config.runtimeId = identity(f.config); f.approval.runtimeId = f.config.runtimeId;
        },
        'unknown approval field': f => { f.approval.clearStop = true; },
        'wrong policyChange hash': f => { f.approval.policyChange.currentPolicySha256 = 'f'.repeat(64); },
        'tampered predecessor manifest': f => { fs.appendFileSync(f.previousManifestFile, '\n'); },
        'altered predecessor continuation': f => {
            f.approval.entryBinanceLeadVeto.previousContinuation.approvedAt++;
        },
        'rehashed predecessor continuation mismatch': f => {
            f.approval.entryBinanceLeadVeto.previousContinuation.fundingSha256 = 'f'.repeat(64);
            f.approval.entryBinanceLeadVeto.previousContinuationSha256 = jsonHash(f.approval.entryBinanceLeadVeto.previousContinuation);
        },
        'rehashed predecessor approval after current': f => {
            f.approval.entryBinanceLeadVeto.previousContinuation.approvedAt = f.approval.approvedAt + 1;
            f.approval.entryBinanceLeadVeto.previousContinuationSha256 = jsonHash(f.approval.entryBinanceLeadVeto.previousContinuation);
        },
        'recursive base_period_binance_lead_veto': f => {
            f.approval.entryBinanceLeadVeto.previousContinuation.reason = 'base_period_binance_lead_veto';
            f.approval.entryBinanceLeadVeto.previousContinuationSha256 = jsonHash(f.approval.entryBinanceLeadVeto.previousContinuation);
        },
        'risk namespace exists': f => fs.mkdirSync(path.join(f.dataDir, 'eligible-risk-periods', f.periodId), { recursive: true }),
    };
    for (const [name, mutate] of Object.entries(bindRejections)) await t.test(name, t => {
        if (name === 'cap 0.85 manifest') return mutate();
        const f = baseLeadVetoFixture(t, { chained: true });
        mutate(f); f.saveApproval();
        assert.throws(f.bind, /eligible_continuation_/);
    });

    const stateRejections = {
        'open position': f => { f.state.position = { market: { slug: 'x' } }; f.repin(); },
        'latched stop': f => { f.state.stopped = { reason: 'operational_check_failed', at: 2400 }; f.repin(); },
        'non-empty entry holds': f => { f.state.entryHolds = { clock: { retryable: true } }; f.repin(); },
        'pending provider': f => { f.state.ai.providers.eligible.pending = { id: 'p' }; f.repin(); },
        'state changed after approval': f => { f.state.events++; },
    };
    for (const [name, mutate] of Object.entries(stateRejections)) await t.test(name, t => {
        const f = baseLeadVetoFixture(t, { chained: true });
        mutate(f);
        const bound = f.bind(), before = structuredClone(f.state);
        assert.throws(() => prepareBaseBinanceLeadVeto(f.state, bound, 2600), /eligible_source_repair_unproven/);
        assert.deepEqual(f.state, before);
    });
});
