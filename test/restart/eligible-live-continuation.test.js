import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { Store, atomicJson } from '../../src/restart/store.js';
import { loadEligibleConfig, eligibleConfigView } from '../../src/eligible-live/config.js';
import { bindRuntimeContinuation, eligibleManifestPath } from '../../src/eligible-live/continuation.js';
import { bindRiskPeriod, createRiskPeriod, validateRiskPeriodRecord } from '../../src/eligible-live/period.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { ELIGIBLE_BUFFER_POLICY } from '../../src/eligible-live/entry-buffer.js';
import { verifiedProfitTakingMigration } from '../../src/eligible-live/profit-policy-proof.js';
import { prepareProfitTakingPolicyMigration } from '../../src/eligible-live/profit-policy-migration.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`;

function snapshot(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name)).sort()
        .map(filename => [path.relative(root, filename), hash(fs.readFileSync(filename))]);
}

function fixture(t, { continuousTrading = false, entryCostCap = false, profitTaking = false } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-continuation-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = { RESTART_DATA_DIR: dataDir, PROXY_WALLET_ADDRESS: wallet,
        PRIVATE_KEY: `0x${'1'.repeat(64)}` };
    if (profitTaking) Object.assign(env, { LAYA_PROFIT_TAKING_ENABLED: 'true',
        LAYA_PROFIT_RECIPIENT: `0x${'c'.repeat(40)}` });
    const original = loadEligibleConfig(env);
    if (continuousTrading) env.ELIGIBLE_CONTINUOUS_TRADING = 'true';
    if (entryCostCap) env.ELIGIBLE_ENTRY_COST_CAP = 'true';
    const config = continuousTrading || entryCostCap ? loadEligibleConfig(env) : original;
    const originalSources = [['src/original.js', 'a'.repeat(64)]];
    const originalRuntimeId = jsonHash({ policy: original.policy, sources: originalSources,
        profitTaking: config.profitTaking }).slice(0, 16);
    const old = new Store({ ...config.settings, fingerprint: '8899aabbccddeeff', capital: 20 }, 'pilot', 'late-entry');
    Object.assign(old.state, { decisionProvider: 'laya', startedAt: 1000, cash: 12, peakEquity: 23,
        maxDrawdown: 11, walletStart: 20, walletCashDelta: -8,
        liveFunding: { initialCapital: 20 }, stopped: { reason: 'drawdown_limit', at: 2000 },
        liveRiskStop: { reason: 'drawdown_limit', at: 2000 } });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = { schema: 1, runtimeId: originalRuntimeId, wallet, dataDir,
        priorPeriodId: old.state.baseline, policySha256: jsonHash(original.policy),
        profitTakingSha256: jsonHash(config.profitTaking), createdAt: 3000, nonce: 'c'.repeat(64),
        acknowledgment: 'manual_new_risk_period', drawdownStop: 10, openingBalance: 12,
        approvedHistory: [pin], proof: {}, automaticActivation: false };
    const periodId = jsonHash(payload).slice(0, 16);
    const record = { periodId, ...payload };
    const riskRoot = path.join(dataDir, 'eligible-risk-periods', originalRuntimeId);
    const riskFile = path.join(riskRoot, periodId, 'record.json');
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    atomicJson(riskFile, record);
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(old.filename, backup);
    const current = new Store({ ...config.settings, fingerprint: periodId }, 'pilot', 'late-entry');
    Object.assign(current.state, { decisionProvider: 'eligible', startedAt: 4000, cash: 11, peakEquity: 14,
        maxDrawdown: 3, walletStart: 12, walletCashDelta: -1,
        liveFunding: { at: 4000, initialCapital: 12, capitalCap: null, allocation: 'available_balance' },
        stopped: { reason: 'receipt_mapping', at: 5000 } });
    current.save();
    const manifest = { id: periodId, policy: original.policy, sources: originalSources,
        profitTaking: config.profitTaking, startedAt: current.state.startedAt };
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(manifestFile, manifest);
    const approval = { schema: 1, runtimeId: config.runtimeId, originalRuntimeId, periodId,
        originalManifestSha256: hash(fs.readFileSync(manifestFile)),
        riskRecordSha256: hash(fs.readFileSync(riskFile)), reason: 'receipt_fee_estimate_repair',
        ledgerStartedAt: current.state.startedAt, fundingSha256: jsonHash(current.state.liveFunding) };
    if (continuousTrading) {
        approval.reason = entryCostCap ? 'user_entry_cost_cap' : 'user_continuous_trading';
        approval.policyChange = { previousPolicySha256: jsonHash(original.policy),
            currentPolicySha256: jsonHash(config.policy) };
    }
    const approvalFile = path.join(dataDir, 'continuation.json');
    const saveApproval = () => atomicJson(approvalFile, approval);
    saveApproval();
    env.ELIGIBLE_LIVE_CONTINUATION = approvalFile;
    return { dataDir, env, config, old, current, originalRuntimeId, periodId, manifest, manifestFile,
        record, riskFile, riskRoot, backup, approval, approvalFile, saveApproval,
        bind: () => bindRiskPeriod(bindRuntimeContinuation(config, env)) };
}

function profitMigrationFixture(t) {
    const f = fixture(t, { continuousTrading: true, entryCostCap: true, profitTaking: true });
    const writeRevision = config => {
        const filename = path.join(f.dataDir, f.periodId, 'eligible-runtime', 'revisions', config.runtimeId, 'manifest.json');
        atomicJson(filename, { id: f.periodId, runtimeId: config.runtimeId, startedAt: f.current.state.startedAt,
            policy: config.policy, sources: config.sources, profitTaking: config.profitTaking });
        return filename;
    };
    const cap = structuredClone(f.config), capApproval = structuredClone(f.approval), capFile = writeRevision(cap);
    const buffer = { ...cap, policy: { ...cap.policy, entryFilter: ELIGIBLE_BUFFER_POLICY },
        sources: [['src/buffer.js', 'd'.repeat(64)]] };
    buffer.runtimeId = jsonHash({ policy: buffer.policy, sources: buffer.sources,
        profitTaking: buffer.profitTaking }).slice(0, 16);
    const bufferApproval = { ...capApproval, runtimeId: buffer.runtimeId, reason: 'user_entry_buffer',
        policyChange: { ...capApproval.policyChange, currentPolicySha256: jsonHash(buffer.policy) },
        entryBufferMigration: { previousRuntimeId: cap.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(capFile)), previousContinuation: capApproval,
            previousContinuationSha256: jsonHash(capApproval) } };
    const bufferFile = writeRevision(buffer);
    f.config.sources = [['src/returned.js', 'e'.repeat(64)]];
    f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
        profitTaking: f.config.profitTaking }).slice(0, 16);
    Object.assign(f.approval, { runtimeId: f.config.runtimeId, reason: 'user_return_cost_cap',
        entryCostCapReturn: { previousRuntimeId: buffer.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(bufferFile)), previousContinuation: bufferApproval,
            previousContinuationSha256: jsonHash(bufferApproval) } });
    f.saveApproval();
    f.bind();
    const previousConfig = structuredClone(f.config), previousApproval = structuredClone(f.approval);
    const previousFile = writeRevision(previousConfig);
    f.config.profitTaking = { ...previousConfig.profitTaking, retainUsd: 10,
        trigger: 'wallet_balance', thresholdUsd: 15 };
    f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
        profitTaking: f.config.profitTaking }).slice(0, 16);
    Object.assign(f.approval, { runtimeId: f.config.runtimeId, profitTakingMigration: {
        previousRuntimeId: previousConfig.runtimeId, previousManifestSha256: hash(fs.readFileSync(previousFile)),
        previousContinuation: previousApproval, previousContinuationSha256: jsonHash(previousApproval),
        previousProfitTaking: previousConfig.profitTaking, currentProfitTakingSha256: jsonHash(f.config.profitTaking),
        approvedAt: 6000 }, profitTakingStateMigration: { stateSha256: jsonHash(f.current.state), approvedAt: 6000 } });
    f.saveApproval();
    return { ...f, previousConfig, previousApproval, previousFile };
}

function profitMigrationStateFixture(t, { ledger = false } = {}) {
    const f = profitMigrationFixture(t), oldPolicy = structuredClone(f.previousConfig.profitTaking);
    delete oldPolicy.enabled;
    Object.assign(f.current.state, { profitTakingControl: { schema: 1, policy: oldPolicy,
        operation: null, disabled: null, lastCheck: { at: 5500, reasons: ['retained_capital'] } },
    continuousOperation: { runtimeId: f.previousConfig.runtimeId, enabledAt: 4500 },
    ai: { providers: { eligible: { pending: null } }, snapshots: [], slots: {} },
    strategyEpochs: [{ id: '9876543210abcdef', runtimeId: f.previousConfig.runtimeId,
        policy: structuredClone(f.config.policy), startedAt: 4500 }],
    currentStrategyEpochId: '9876543210abcdef',
    completed: [{ slug: 'settled', traded: true, pnl: -1, fees: .01, gas: .02, closedAt: 5400 }] });
    if (ledger) f.current.state.profitTaking = { schema: 1,
        policy: { recipient: oldPolicy.recipient, asset: oldPolicy.asset, chunkUsd: 5, retainUsd: 20 },
        period: { baseline: f.periodId, startedAt: f.current.state.startedAt,
            initialCapital: f.current.state.liveFunding.initialCapital },
        history: { count: 1, sha256: jsonHash(f.current.state.completed) }, pending: null,
        withdrawals: [], totalTransferred: 0, totalTokenDebited: 0, withdrawalGasUsd: 0, withdrawalFeesUsd: 0 };
    f.current.save();
    f.approval.profitTakingStateMigration.stateSha256 = jsonHash(f.current.state);
    f.saveApproval();
    return f;
}

function lossProtectionMigrationFixture(t, { ledger = false } = {}) {
    const f = profitMigrationStateFixture(t, { ledger });
    const firstConfig = f.bind(), firstApproval = structuredClone(f.approval);
    f.current.state = prepareProfitTakingPolicyMigration(f.current.state, firstConfig, 6500);
    f.current.save();
    const firstFile = path.join(f.dataDir, f.periodId, 'eligible-runtime', 'revisions', firstConfig.runtimeId, 'manifest.json');
    atomicJson(firstFile, { id: f.periodId, runtimeId: firstConfig.runtimeId, startedAt: f.current.state.startedAt,
        policy: firstConfig.policy, sources: firstConfig.sources, profitTaking: firstConfig.profitTaking });
    f.config.profitTaking = { ...firstConfig.profitTaking,
        lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } };
    f.config.sources = [['src/loss-protection.js', 'f'.repeat(64)]];
    f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
        profitTaking: f.config.profitTaking }).slice(0, 16);
    Object.assign(f.approval, { runtimeId: f.config.runtimeId, profitTakingMigration: {
        previousRuntimeId: firstConfig.runtimeId, previousManifestSha256: hash(fs.readFileSync(firstFile)),
        previousContinuation: firstApproval, previousContinuationSha256: jsonHash(firstApproval),
        previousProfitTaking: structuredClone(firstConfig.profitTaking), currentProfitTakingSha256: jsonHash(f.config.profitTaking),
        approvedAt: 7000 }, profitTakingStateMigration: { stateSha256: jsonHash(f.current.state), approvedAt: 7000 } });
    f.saveApproval();
    return { ...f, firstConfig, firstApproval, firstFile };
}

test('reviewed continuation keeps original accounting identity, funding, peak and stop without writing', t => {
    const f = fixture(t), before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.runtimeId, f.config.runtimeId);
    assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.equal(config.settings.fingerprint, f.periodId);
    assert.equal(config.ai.id, f.periodId); assert.equal(config.ai.control, config.settings);
    assert.deepEqual(config.riskPeriod, f.record);
    assert.equal(Object.isFrozen(config.runtimeContinuation), true);
    const store = new Store(config.settings, 'pilot', 'late-entry');
    assert.deepEqual(store.state, f.current.state);
    const history = eligibleHistory(config);
    const readiness = eligibleReadiness({ config, history, operationalReady: true });
    assert.equal(readiness.readyForLive, false);
    assert.ok(readiness.blockers.includes('persistent_pilot_stop'));
    assert.equal(readiness.otherPilotHistory, false);
    const view = eligibleConfigView(config);
    assert.equal(view.runtimeId, f.config.runtimeId);
    assert.equal(view.runtimeContinuation.originalRuntimeId, f.originalRuntimeId);
    assert.equal(loadEligibleConfig(f.env).id, f.periodId);
    assert.deepEqual(snapshot(f.dataDir), before);
});

test('continuation remains opt-in and records revisions without overwriting the original manifest', t => {
    const f = fixture(t), before = fs.readFileSync(f.manifestFile);
    assert.equal(bindRuntimeContinuation(f.config, {}), f.config);
    const continued = f.bind(), revised = eligibleManifestPath(continued);
    assert.equal(revised, path.join(f.dataDir, f.periodId, 'eligible-runtime', 'revisions',
        f.config.runtimeId, 'manifest.json'));
    assert.equal(eligibleManifestPath({ ...continued, runtimeContinuation: null }), f.manifestFile);
    atomicJson(revised, { id: continued.id, runtimeId: continued.runtimeId, policy: continued.policy,
        sources: continued.sources, profitTaking: continued.profitTaking, startedAt: f.current.state.startedAt });
    assert.deepEqual(fs.readFileSync(f.manifestFile), before);
    assert.equal(f.bind().id, f.periodId);
});

test('pre-entry signal repair binds to the same funded period without clearing its stop', t => {
    const f = fixture(t), before = fs.readFileSync(f.current.filename);
    f.approval.reason = 'pre_entry_signal_repair'; f.saveApproval();
    const config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.deepEqual(fs.readFileSync(f.current.filename), before);
    assert.equal(eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true }).readyForLive, false);
});

test('continuous approval retains the original policy pin and risk namespace without rewriting history', t => {
    const f = fixture(t, { continuousTrading: true }), before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.equal(config.settings.fingerprint, f.periodId);
    assert.deepEqual(config.riskPeriod, f.record);
    assert.equal(config.riskPeriod.policySha256, jsonHash(f.manifest.policy));
    assert.notEqual(config.riskPeriod.policySha256, jsonHash(config.policy));
    assert.equal(Object.isFrozen(config.runtimeContinuation.policyChange), true);
    assert.equal(loadEligibleConfig(f.env).id, f.periodId);
    assert.equal(eligibleConfigView(config).riskPeriod.drawdownStop, null);
    assert.deepEqual(eligibleConfigView(config).runtimeContinuation.policyChange, f.approval.policyChange);
    assert.deepEqual(new Store(config.settings, 'pilot', 'late-entry').state, f.current.state);
    assert.deepEqual(snapshot(f.dataDir), before);
    assert.throws(() => validateRiskPeriodRecord({ ...config, runtimeContinuation: null }, f.record), /record_mismatch/);
    assert.throws(() => validateRiskPeriodRecord({ ...config,
        runtimeContinuation: { ...config.runtimeContinuation, policyChange: {
            ...config.runtimeContinuation.policyChange, previousPolicySha256: jsonHash(config.policy) } } }, f.record),
    /record_mismatch/);
    assert.throws(() => validateRiskPeriodRecord({ ...config,
        policy: { ...config.policy, entryCap: 8 } }, f.record), /record_mismatch/);
});

test('cost-cap continuation preserves the immutable original manifest, risk period and accounting', t => {
    const f = fixture(t, { continuousTrading: true, entryCostCap: true });
    const before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId); assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.equal(config.settings.fingerprint, f.periodId);
    assert.deepEqual(config.riskPeriod, f.record);
    assert.deepEqual(config.policy, { ...f.manifest.policy, continuousTrading: true,
        entryFilter: { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: .85,
            gasUsd: f.manifest.policy.execution.gasUsd, basis: 'full_fill_at_frozen_limit' } });
    assert.equal(loadEligibleConfig(f.env).id, f.periodId);
    assert.deepEqual(new Store(config.settings, 'pilot', 'late-entry').state, f.current.state);
    assert.equal(eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true }).readyForLive, false);
    assert.equal(config.runtimeContinuation.reason, 'user_entry_cost_cap');
    assert.deepEqual(snapshot(f.dataDir), before);
    assert.throws(() => validateRiskPeriodRecord({ ...config, runtimeContinuation: null }, f.record), /record_mismatch/);
});

test('profit trigger migration validates the complete return chain and retains all risk and strategy history', t => {
    const f = profitMigrationFixture(t), before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.deepEqual(config.policy, f.previousConfig.policy);
    assert.deepEqual(config.riskPeriod, f.record);
    assert.equal(config.riskPeriod.profitTakingSha256, jsonHash(f.previousConfig.profitTaking));
    assert.notEqual(config.riskPeriod.profitTakingSha256, jsonHash(config.profitTaking));
    assert.deepEqual(config.profitTaking, { ...f.previousConfig.profitTaking, retainUsd: 10,
        trigger: 'wallet_balance', thresholdUsd: 15 });
    assert.equal(config.runtimeContinuation.reason, 'user_return_cost_cap');
    assert.deepEqual(config.runtimeContinuation.entryCostCapReturn, f.previousApproval.entryCostCapReturn);
    assert.deepEqual(verifiedProfitTakingMigration(config), f.approval.profitTakingMigration);
    assert.deepEqual(new Store(config.settings, 'pilot', 'late-entry').state, f.current.state);
    assert.equal(eligibleHistory(config).length, 2);
    assert.deepEqual(snapshot(f.dataDir), before);
    assert.throws(() => validateRiskPeriodRecord({ ...config, runtimeContinuation: null }, f.record), /record_mismatch/);
    assert.throws(() => validateRiskPeriodRecord({ ...config,
        runtimeContinuation: structuredClone(config.runtimeContinuation) }, f.record), /profit_policy_unverified/);
    assert.throws(() => verifiedProfitTakingMigration({ ...config,
        profitTaking: { ...config.profitTaking, thresholdUsd: 14 } }), /profit_policy_unverified/);
});

test('profit migration rejects altered recipients, amounts, identities and incomplete predecessor proofs', async t => {
    const mutations = {
        recipient: f => { f.config.profitTaking.recipient = `0x${'d'.repeat(40)}`; },
        threshold: f => { f.config.profitTaking.thresholdUsd = 14; },
        retain: f => { f.config.profitTaking.retainUsd = 9; },
        chunk: f => { f.config.profitTaking.chunkUsd = 6; },
        fee: f => { f.config.profitTaking.maxFeeUsd = 1; },
        enabled: f => { f.config.profitTaking.enabled = false; },
        strategy: f => { f.config.policy = { ...f.config.policy, entryCap: 10 }; },
        'missing manifest': f => { fs.unlinkSync(f.previousFile); },
        'manifest bytes changed': f => { fs.appendFileSync(f.previousFile, '\n'); },
        'old manifest missing': f => { fs.unlinkSync(f.manifestFile); },
        'previous hash': f => { f.approval.profitTakingMigration.previousManifestSha256 = 'f'.repeat(64); },
        'previous approval hash': f => { f.approval.profitTakingMigration.previousContinuationSha256 = 'f'.repeat(64); },
        'previous identity': f => { f.approval.profitTakingMigration.previousRuntimeId = 'f'.repeat(16); },
        'previous policy': f => { f.approval.profitTakingMigration.previousProfitTaking.retainUsd = 10; },
        'approval date': f => { f.approval.profitTakingMigration.approvedAt = 3999; },
        'unknown field': f => { f.approval.profitTakingMigration.extra = true; },
        'reason changed': f => { f.approval.reason = 'user_entry_cost_cap'; },
        'risk approval changed': f => { f.approval.riskRecordSha256 = 'f'.repeat(64); },
        'return chain omitted': f => { delete f.approval.entryCostCapReturn; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = profitMigrationFixture(t);
        mutate(f);
        f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
            profitTaking: f.config.profitTaking }).slice(0, 16);
        f.approval.runtimeId = f.config.runtimeId;
        f.approval.profitTakingMigration.currentProfitTakingSha256 = jsonHash(f.config.profitTaking);
        f.saveApproval();
        assert.throws(f.bind);
    });
});

test('profit migration current hash and source identity remain mandatory', async t => {
    for (const name of ['hash', 'sources', 'no migration']) await t.test(name, t => {
        const f = profitMigrationFixture(t);
        if (name === 'hash') f.approval.profitTakingMigration.currentProfitTakingSha256 = 'f'.repeat(64);
        else if (name === 'sources') f.config.sources = [['src/unreviewed.js', 'f'.repeat(64)]];
        else delete f.approval.profitTakingMigration;
        f.saveApproval();
        assert.throws(f.bind, /mismatch/);
    });
});

test('profit policy state migration changes only withdrawal policy and runtime audit fields', async t => {
    for (const ledger of [false, true]) await t.test(`ledger:${ledger}`, t => {
        const f = profitMigrationStateFixture(t, { ledger }), config = f.bind();
        const state = structuredClone(f.current.state), before = snapshot(f.dataDir);
        const next = prepareProfitTakingPolicyMigration(state, config, 6500);
        assert.deepEqual(state, f.current.state);
        const retained = value => {
            const { profitTakingControl, profitTaking, continuousOperation,
                profitTakingPolicyHistory, continuousOperationHistory, ...unchanged } = value;
            return unchanged;
        };
        assert.deepEqual(retained(next), retained(state));
        const { enabled, ...expectedPolicy } = config.profitTaking;
        const { lastCheck, ...oldControl } = state.profitTakingControl;
        assert.deepEqual(next.profitTakingControl, { ...oldControl, policy: expectedPolicy });
        assert.equal(Object.hasOwn(next.profitTakingControl, 'lastCheck'), false);
        assert.deepEqual(next.continuousOperation, { ...state.continuousOperation, runtimeId: config.runtimeId });
        assert.equal(next.profitTakingPolicyHistory.length, 1);
        assert.equal(next.continuousOperationHistory.length, 1);
        assert.equal(next.profitTakingPolicyHistory[0].stateSha256, jsonHash(state));
        assert.equal(next.profitTakingPolicyHistory[0].completedSha256, jsonHash(state.completed));
        if (ledger) {
            const { policy: oldAccountingPolicy, ...oldLedger } = state.profitTaking;
            assert.deepEqual(next.profitTaking, { ...oldLedger, policy: { ...oldAccountingPolicy,
                retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15 } });
        } else assert.equal(next.profitTaking, undefined);
        assert.deepEqual(snapshot(f.dataDir), before);
        assert.throws(() => prepareProfitTakingPolicyMigration(next, config, 6501), /migration_unproven/);
    });
});

test('profit state migration rejects stale or non-flat state and unverified approvals', async t => {
    const mutations = {
        cash: state => { state.cash += 1; },
        position: state => { state.position = { pending: true }; },
        withdrawal: state => { state.profitTakingControl.operation = { stage: 'in_transit' }; },
        disabled: state => { state.profitTakingControl.disabled = 'unknown_withdrawal'; },
        provider: state => { state.ai.providers.eligible.pending = { snapshotId: 'pending' }; },
        uncertain: state => { state.completed[0].uncertain = true; },
        pendingTrades: state => { state.completed[0].pendingTrades = true; },
        runtime: state => { state.continuousOperation.runtimeId = 'f'.repeat(16); },
        policy: state => { state.profitTakingControl.policy.recipient = `0x${'d'.repeat(40)}`; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = profitMigrationStateFixture(t), state = structuredClone(f.current.state);
        mutate(state);
        if (name !== 'cash') {
            f.approval.profitTakingStateMigration.stateSha256 = jsonHash(state);
            f.saveApproval();
        }
        const config = f.bind();
        assert.throws(() => prepareProfitTakingPolicyMigration(state, config, 6500), /migration_unproven/);
    });
    const f = profitMigrationStateFixture(t), config = f.bind();
    assert.throws(() => prepareProfitTakingPolicyMigration(f.current.state, config, 5999), /migration_unproven/);
    assert.throws(() => prepareProfitTakingPolicyMigration(f.current.state, {
        ...config, runtimeContinuation: structuredClone(config.runtimeContinuation) }, 6500), /profit_policy_unverified/);
});

test('loss protection second migration preserves full prior chain and original risk policy', t => {
    const f = lossProtectionMigrationFixture(t), before = snapshot(f.dataDir), config = f.bind();
    assert.equal(config.id, f.periodId); assert.equal(config.riskRuntimeId, f.originalRuntimeId);
    assert.deepEqual(config.riskPeriod, f.firstConfig.riskPeriod);
    assert.deepEqual(config.policy, f.firstConfig.policy);
    assert.deepEqual(config.runtimeContinuation.profitTakingMigration.previousContinuation, f.firstApproval);
    assert.deepEqual(config.profitTaking, { ...f.firstConfig.profitTaking,
        lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } });
    assert.deepEqual(verifiedProfitTakingMigration(config), f.approval.profitTakingMigration);
    assert.deepEqual(eligibleHistory(config).map(row => row.baseline), eligibleHistory(f.firstConfig).map(row => row.baseline));
    assert.deepEqual(snapshot(f.dataDir), before);
});

test('loss protection migration enables only future outcomes without rewriting accounting', async t => {
    for (const ledger of [false, true]) await t.test(`ledger:${ledger}`, t => {
        const f = lossProtectionMigrationFixture(t, { ledger }), config = f.bind(), state = f.current.state;
        const before = structuredClone(state), next = prepareProfitTakingPolicyMigration(state, config, 7500);
        assert.deepEqual(state, before);
        const marker = { schema: 1, activatedAt: 7500, completedCount: state.completed.length,
            completedSha256: jsonHash(state.completed), consumed: [] };
        assert.deepEqual(next.profitTakingControl.lossProtection, marker);
        assert.deepEqual(next.profitTakingControl.policy.lossProtection, config.profitTaking.lossProtection);
        assert.equal(next.profitTakingPolicyHistory.at(-1).reason, 'user_loss_protection_pre14_after10_withdraw5');
        assert.equal(next.profitTakingPolicyHistory.at(-1).previousRuntimeId, f.firstConfig.runtimeId);
        for (const key of Object.keys(state).filter(key => !['profitTakingControl', 'profitTaking', 'profitTakingPolicyHistory',
            'continuousOperation', 'continuousOperationHistory'].includes(key))) assert.deepEqual(next[key], state[key], key);
        assert.deepEqual(next.profitTakingPolicyHistory.slice(0, -1), state.profitTakingPolicyHistory);
        assert.deepEqual(next.continuousOperationHistory.slice(0, -1), state.continuousOperationHistory);
        assert.deepEqual(next.continuousOperation, { ...state.continuousOperation, runtimeId: config.runtimeId });
        if (ledger) {
            const { policy, ...unchanged } = next.profitTaking;
            const { policy: previousPolicy, ...oldUnchanged } = state.profitTaking;
            assert.deepEqual(unchanged, oldUnchanged);
            assert.deepEqual(policy, { ...previousPolicy, lossProtection: config.profitTaking.lossProtection });
        }
        assert.throws(() => prepareProfitTakingPolicyMigration(next, config, 7501), /migration_unproven/);
    });
});

test('second migration rejects broader policy changes and broken historical proof', async t => {
    const mutations = {
        beforeThreshold: f => { f.config.profitTaking.lossProtection.beforeTradeMinUsd = 13; },
        afterThreshold: f => { f.config.profitTaking.lossProtection.afterLossMinUsd = 9; },
        amount: f => { f.config.profitTaking.lossProtection.amountUsd = 6; },
        extraRule: f => { f.config.profitTaking.lossProtection.anyLoss = true; },
        recipient: f => { f.config.profitTaking.recipient = `0x${'a'.repeat(40)}`; },
        normalThreshold: f => { f.config.profitTaking.thresholdUsd = 14; },
        normalRetain: f => { f.config.profitTaking.retainUsd = 5; },
        trigger: f => { f.config.profitTaking.trigger = 'realized_profit'; },
        predecessorManifest: f => { fs.appendFileSync(f.firstFile, '\n'); },
        originalManifest: f => { fs.appendFileSync(f.manifestFile, '\n'); },
        priorApproval: f => { f.approval.profitTakingMigration.previousContinuation.fundingSha256 = 'f'.repeat(64); },
        priorMigration: f => { delete f.approval.profitTakingMigration.previousContinuation.profitTakingMigration; },
        strategy: f => { f.config.policy.entryCap = 6; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = lossProtectionMigrationFixture(t); mutate(f);
        f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
            profitTaking: f.config.profitTaking }).slice(0, 16);
        f.approval.runtimeId = f.config.runtimeId;
        f.approval.profitTakingMigration.currentProfitTakingSha256 = jsonHash(f.config.profitTaking);
        f.approval.profitTakingMigration.previousContinuationSha256 = jsonHash(f.approval.profitTakingMigration.previousContinuation);
        f.saveApproval(); assert.throws(f.bind, /mismatch|changed/);
    });
});

test('loss activation refuses existing markers even when the new state hash is approved', t => {
    const f = lossProtectionMigrationFixture(t);
    f.current.state.profitTakingControl.lossProtection = { schema: 1, activatedAt: 6500,
        completedCount: 0, completedSha256: jsonHash([]), consumed: [] };
    f.current.save();
    f.approval.profitTakingStateMigration.stateSha256 = jsonHash(f.current.state); f.saveApproval();
    const config = f.bind();
    assert.throws(() => prepareProfitTakingPolicyMigration(f.current.state, config, 7500), /migration_unproven/);
});

test('cost-cap continuation permits only the fixed gas-inclusive filter and continuous policy addition', async t => {
    const mutations = {
        'missing policy pin': f => { delete f.approval.policyChange; },
        'wrong original pin': f => { f.approval.policyChange.previousPolicySha256 = 'd'.repeat(64); },
        'extra pin': f => { f.approval.policyChange.extra = true; },
        'different reason': f => { f.approval.reason = 'user_continuous_trading'; },
        'continuous disabled': f => { f.config.settings.continuousTrading = false; },
        'continuous policy disabled': f => { f.config.policy.continuousTrading = false; },
        'cap raised': f => { f.config.policy.entryFilter.maxCostPerShare = .86; },
        'gas omitted': f => { delete f.config.policy.entryFilter.gasUsd; },
        'gas changed': f => { f.config.policy.entryFilter.gasUsd += .01; },
        'basis changed': f => { f.config.policy.entryFilter.basis = 'best_ask'; },
        'extra filter property': f => { f.config.policy.entryFilter.extra = true; },
        'other policy changed': f => { f.config.policy.entryCap = 10; },
        'drawdown changed': f => { f.config.policy.drawdownStop = null; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = fixture(t, { continuousTrading: true, entryCostCap: true });
        f.config.policy.entryFilter = { ...f.config.policy.entryFilter };
        mutate(f);
        if (f.approval.policyChange) f.approval.policyChange.currentPolicySha256 = jsonHash(f.config.policy);
        f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
            profitTaking: f.config.profitTaking }).slice(0, 16);
        f.approval.runtimeId = f.config.runtimeId; f.saveApproval();
        assert.throws(f.bind, /manifest_mismatch/);
    });
});

test('continuous trading permits active historical drawdown only when no durable stop is present', async t => {
    for (const stopped of [null, 'drawdown_limit', 'receipt_mapping']) {
        for (const riskStopped of [false, true]) await t.test(`${stopped}:${riskStopped}`, t => {
            const f = fixture(t, { continuousTrading: true });
            Object.assign(f.current.state, { maxDrawdown: 20,
                stopped: stopped ? { reason: stopped, at: 6000 } : null,
                liveRiskStop: riskStopped ? { reason: 'drawdown_limit', at: 6000 } : null });
            f.current.save();
            const before = snapshot(f.dataDir), config = f.bind(), history = eligibleHistory(config);
            // A replacement in-memory state must not hide stops on disk.
            const state = { ...f.current.state, stopped: null, liveRiskStop: null, maxDrawdown: 0 };
            const readiness = eligibleReadiness({ config, state, history, operationalReady: true });
            assert.equal(readiness.readyForLive, !stopped && !riskStopped);
            assert.equal(readiness.startAllowed, !stopped && !riskStopped);
            assert.equal(readiness.blockers.includes('persistent_pilot_stop'), !!stopped);
            assert.equal(readiness.blockers.includes('persistent_live_risk_stop'), riskStopped);
            assert.equal(readiness.blockers.includes('persistent_live_drawdown_stop'), false);
            assert.equal(readiness.drawdownStop, null);
            assert.equal(readiness.drawdownAlertThreshold, 10);
            assert.equal(readiness.drawdownEnforcement, 'observe_only');
            assert.equal(history.find(row => row.baseline === f.periodId).maxDrawdown, 20);
            assert.deepEqual(snapshot(f.dataDir), before);
        });
    }
});

test('continuous approval allows only the exact opt-in policy addition with both reviewed hashes', async t => {
    const mutations = [
        f => { delete f.approval.policyChange; },
        f => { delete f.approval.policyChange.previousPolicySha256; },
        f => { delete f.approval.policyChange.currentPolicySha256; },
        f => { f.approval.policyChange.previousPolicySha256 = 'd'.repeat(64); },
        f => { f.approval.policyChange.currentPolicySha256 = 'd'.repeat(64); },
        f => { f.approval.policyChange.extra = true; },
        f => { f.approval.reason = 'pre_entry_signal_repair'; },
        f => { f.config.settings.continuousTrading = false; },
        f => { f.config.settings.continuousTrading = 'true'; },
        f => { delete f.config.policy.continuousTrading; },
        f => { f.config.policy.continuousTrading = false; },
        f => { f.config.policy.entryCap = 10; },
        f => { f.config.policy.drawdownStop = null; },
        f => { f.config.policy.execution.slots = [30]; },
        f => { f.config.profitTaking = { ...f.config.profitTaking, enabled: true }; },
    ];
    for (const [index, mutate] of mutations.entries()) await t.test(String(index), t => {
        const f = fixture(t, { continuousTrading: true });
        const originalPolicyHash = jsonHash(f.config.policy);
        mutate(f);
        if (f.approval.policyChange && jsonHash(f.config.policy) !== originalPolicyHash)
            f.approval.policyChange.currentPolicySha256 = jsonHash(f.config.policy);
        f.config.runtimeId = jsonHash({ policy: f.config.policy, sources: f.config.sources,
            profitTaking: f.config.profitTaking }).slice(0, 16);
        f.approval.runtimeId = f.config.runtimeId;
        f.saveApproval();
        assert.throws(f.bind, /manifest_mismatch/);
    });
});

test('continuous continuation preserves pinned prior history and its archives', async t => {
    for (const name of ['history', 'backup']) await t.test(name, t => {
        const f = fixture(t, { continuousTrading: true });
        fs.appendFileSync(name === 'history' ? f.old.filename : f.backup, '\n');
        assert.throws(() => eligibleHistory(f.bind()), /history_changed|archive_changed/);
    });
});

test('approval rejects another code revision, malformed pins, missing approval and unsafe files', async t => {
    const mutations = [
        f => { f.approval.runtimeId = 'd'.repeat(16); f.saveApproval(); },
        f => { f.approval.schema = 2; f.saveApproval(); },
        f => { f.approval.reason = 'clear_risk_stop'; f.saveApproval(); },
        f => { f.approval.riskRecordSha256 = 'invalid'; f.saveApproval(); },
        f => { f.env.ELIGIBLE_LIVE_CONTINUATION = 'relative.json'; },
        f => { fs.chmodSync(f.approvalFile, 0o644); },
        f => { fs.renameSync(f.approvalFile, `${f.approvalFile}.real`);
            fs.symlinkSync(`${f.approvalFile}.real`, f.approvalFile); },
        f => { fs.unlinkSync(f.approvalFile); },
        f => { f.config.sources = [['src/changed.js', 'd'.repeat(64)]]; },
    ];
    for (const [index, mutate] of mutations.entries()) await t.test(String(index), t => {
        const f = fixture(t); mutate(f);
        assert.throws(f.bind);
    });
});

test('immutable manifest, origin, policy and risk record must match the reviewed anchor', async t => {
    const mutations = [
        f => fs.appendFileSync(f.manifestFile, '\n'),
        f => fs.appendFileSync(f.riskFile, '\n'),
        f => { f.manifest.sources[0][1] = 'd'.repeat(64); atomicJson(f.manifestFile, f.manifest);
            f.approval.originalManifestSha256 = hash(fs.readFileSync(f.manifestFile)); f.saveApproval(); },
        f => { f.manifest.policy = { ...f.config.policy, entryCap: 10 }; atomicJson(f.manifestFile, f.manifest);
            f.approval.originalManifestSha256 = hash(fs.readFileSync(f.manifestFile)); f.saveApproval(); },
        f => { f.record.openingBalance = 100; atomicJson(f.riskFile, f.record);
            f.approval.riskRecordSha256 = hash(fs.readFileSync(f.riskFile)); f.saveApproval(); },
        f => { fs.renameSync(path.dirname(f.manifestFile), `${path.dirname(f.manifestFile)}.real`);
            fs.symlinkSync(`${path.dirname(f.manifestFile)}.real`, path.dirname(f.manifestFile)); },
    ];
    for (const [index, mutate] of mutations.entries()) await t.test(String(index), t => {
        const f = fixture(t); mutate(f); assert.throws(f.bind, /continuation|period/);
    });
});

test('continuation refuses replaced ledger identity or funding and missing active risk pointer', async t => {
    const mutations = [
        f => { f.current.state.baseline = f.config.id; },
        f => { f.current.state.mode = 'paper'; },
        f => { f.current.state.decisionProvider = 'laya'; },
        f => { f.current.state.startedAt++; },
        f => { f.current.state.liveFunding.initialCapital++; },
        f => { f.current.state.liveFunding = null; },
    ];
    for (const [index, mutate] of mutations.entries()) await t.test(String(index), t => {
        const f = fixture(t); mutate(f); f.current.save(); assert.throws(f.bind, /ledger_mismatch/);
    });
    const f = fixture(t); fs.unlinkSync(path.join(f.riskRoot, 'active.json'));
    assert.throws(f.bind, /missing_pointer/);
});

test('legacy history pins, archived history and latched risk stops remain enforced', async t => {
    for (const name of ['history', 'backup', 'drawdown']) await t.test(name, t => {
        const f = fixture(t);
        if (name === 'history') fs.appendFileSync(f.old.filename, '\n');
        if (name === 'backup') fs.appendFileSync(f.backup, '\n');
        if (name === 'drawdown') {
            f.current.state.maxDrawdown = 10;
            f.current.state.liveRiskStop = { reason: 'drawdown_limit', at: 6000 };
            f.current.save();
        }
        const config = f.bind();
        if (name !== 'drawdown') assert.throws(() => eligibleHistory(config), /history_changed|archive_changed/);
        else {
            const result = eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true });
            assert.equal(result.readyForLive, false);
            assert.ok(result.blockers.includes('persistent_live_risk_stop'));
            assert.ok(result.blockers.includes('persistent_live_drawdown_stop'));
        }
    });
});

test('a later explicit manual period advances the original namespace and reports the actual runtime', async t => {
    const f = fixture(t);
    Object.assign(f.current.state, { maxDrawdown: 10, stopped: { reason: 'drawdown_limit', at: 6000 },
        liveRiskStop: { reason: 'drawdown_limit', at: 6000 } });
    f.current.save();
    const config = f.bind(), before = fs.readFileSync(f.current.filename);
    const blockHash = `0x${'a'.repeat(64)}`;
    const client = {
        startBtcFeed() {}, serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: 11,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => [], ordersAndTrades: async () => ({ orders: [], trades: [] }),
        gasPriceUsd: async () => 1, confirmedBlock: async () => 123, balance: async () => 11,
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task) => task({
            send: async method => {
                if (method === 'eth_getTransactionCount') return '0x2';
                if (method === 'eth_call') return ethers.utils.defaultAbiCoder.encode(['uint256'], [3]);
                if (method === 'eth_getBlockByNumber') return { hash: blockHash };
                throw new Error('unexpected_rpc');
            },
        }) },
    };
    const providers = { preflight: async () => ({ eligible: { ready: true } }) };
    const result = await createRiskPeriod(config, { client, providers, clock: () => 7000 });
    assert.equal(result.runtimeId, f.config.runtimeId);
    assert.notEqual(result.id, f.periodId);
    assert.equal(fs.existsSync(path.join(f.riskRoot, result.id, 'record.json')), true);
    assert.equal(fs.existsSync(path.join(f.dataDir, 'eligible-risk-periods', f.config.runtimeId)), false);
    const advanced = f.bind();
    assert.equal(advanced.id, result.id);
    assert.equal(advanced.runtimeContinuation.periodId, f.periodId);
    assert.equal(advanced.runtimeId, f.config.runtimeId);
    assert.equal(eligibleReadiness({ config: advanced, history: eligibleHistory(advanced),
        operationalReady: true }).readyForLive, true);
    assert.deepEqual(fs.readFileSync(f.current.filename), before);
});
