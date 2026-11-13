import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, atomicJson } from '../../src/restart/store.js';
import { loadEligibleConfig } from '../../src/eligible-live/config.js';
import { bindRuntimeContinuation } from '../../src/eligible-live/continuation.js';
import { bindRiskPeriod, validateRiskPeriodRecord } from '../../src/eligible-live/period.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { ELIGIBLE_BUFFER_POLICY } from '../../src/eligible-live/entry-buffer.js';
import { continuationProfitTaking, verifiedProfitTakingMigration } from '../../src/eligible-live/profit-policy-proof.js';
import { prepareProfitTakingPolicyMigration } from '../../src/eligible-live/profit-policy-migration.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const identity = config => digest({ policy: config.policy, sources: config.sources,
    profitTaking: config.profitTaking }).slice(0, 16);
const wallet = `0x${'b'.repeat(40)}`;

function fixture(t, { profitTaking = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-cap-adjustment-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = { RESTART_DATA_DIR: dataDir, PROXY_WALLET_ADDRESS: wallet,
        PRIVATE_KEY: `0x${'1'.repeat(64)}`, ...(profitTaking ? {
            LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: `0x${'c'.repeat(40)}` } : {}) };
    const original = loadEligibleConfig(env), originalProfitTaking = structuredClone(original.profitTaking);
    const old = new Store({ ...original.settings, fingerprint: '8899aabbccddeeff', capital: 20 }, 'pilot', 'late-entry');
    Object.assign(old.state, { decisionProvider: 'laya', startedAt: 1000, cash: 12, peakEquity: 23,
        maxDrawdown: 11, walletStart: 20, walletCashDelta: -8, liveFunding: { initialCapital: 20 },
        stopped: { reason: 'drawdown_limit', at: 2000 }, liveRiskStop: { reason: 'drawdown_limit', at: 2000 } });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = { schema: 1, runtimeId: original.runtimeId, wallet, dataDir,
        priorPeriodId: old.state.baseline, policySha256: digest(original.policy),
        profitTakingSha256: digest(original.profitTaking), createdAt: 3000, nonce: 'c'.repeat(64),
        acknowledgment: 'manual_new_risk_period', drawdownStop: 10, openingBalance: 12,
        approvedHistory: [pin], proof: {}, automaticActivation: false };
    const periodId = digest(payload).slice(0, 16), risk = { periodId, ...payload };
    const riskRoot = path.join(dataDir, 'eligible-risk-periods', original.runtimeId);
    const riskFile = path.join(riskRoot, periodId, 'record.json');
    atomicJson(riskFile, risk);
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(old.filename, backup);
    const current = new Store({ ...original.settings, fingerprint: periodId }, 'pilot', 'late-entry');
    Object.assign(current.state, { decisionProvider: 'eligible', startedAt: 4000, cash: 11, peakEquity: 14,
        maxDrawdown: 3, walletStart: 12, walletCashDelta: -1,
        liveFunding: { at: 4000, initialCapital: 12, capitalCap: null, allocation: 'available_balance' } });
    current.save();
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(manifestFile, { id: periodId, policy: original.policy, sources: original.sources,
        profitTaking: original.profitTaking, startedAt: 4000 });
    const revision = config => {
        const filename = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', config.runtimeId, 'manifest.json');
        atomicJson(filename, { id: periodId, runtimeId: config.runtimeId, startedAt: 4000,
            policy: config.policy, sources: config.sources, profitTaking: config.profitTaking });
        return filename;
    };
    const nextConfig = (previous, policy, profit, label) => {
        const config = { ...previous, policy, profitTaking: profit,
            sources: [[`src/${label}.js`, hash(label)]],
            settings: { ...previous.settings, continuousTrading: true } };
        config.runtimeId = identity(config);
        return config;
    };
    const capPolicy = { ...original.policy, continuousTrading: true,
        entryFilter: { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: .85,
            gasUsd: original.policy.execution.gasUsd, basis: 'full_fill_at_frozen_limit' } };
    let previousConfig = nextConfig(original, capPolicy, original.profitTaking, 'cap');
    let previousApproval = { schema: 1, runtimeId: previousConfig.runtimeId, originalRuntimeId: original.runtimeId,
        periodId, originalManifestSha256: hash(fs.readFileSync(manifestFile)),
        riskRecordSha256: hash(fs.readFileSync(riskFile)), reason: 'user_entry_cost_cap',
        ledgerStartedAt: 4000, fundingSha256: digest(current.state.liveFunding),
        policyChange: { previousPolicySha256: digest(original.policy), currentPolicySha256: digest(capPolicy) } };
    const capFile = revision(previousConfig);
    const bufferConfig = nextConfig(previousConfig, { ...capPolicy, entryFilter: ELIGIBLE_BUFFER_POLICY },
        previousConfig.profitTaking, 'buffer');
    const bufferApproval = { ...previousApproval, runtimeId: bufferConfig.runtimeId, reason: 'user_entry_buffer',
        policyChange: { ...previousApproval.policyChange, currentPolicySha256: digest(bufferConfig.policy) },
        entryBufferMigration: { previousRuntimeId: previousConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(capFile)), previousContinuation: previousApproval,
            previousContinuationSha256: digest(previousApproval) } };
    const bufferFile = revision(bufferConfig);
    previousConfig = nextConfig(bufferConfig, capPolicy, bufferConfig.profitTaking, 'returned');
    previousApproval = { ...previousApproval, runtimeId: previousConfig.runtimeId, reason: 'user_return_cost_cap',
        entryCostCapReturn: { previousRuntimeId: bufferConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(bufferFile)), previousContinuation: bufferApproval,
            previousContinuationSha256: digest(bufferApproval) } };
    const profitFiles = [];
    if (profitTaking) {
        for (const [at, nextProfit, label] of [
            [6000, { ...original.profitTaking, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15 }, 'wallet'],
            [7000, { ...original.profitTaking, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15,
                lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } }, 'loss'],
        ]) {
            const filename = revision(previousConfig); profitFiles.push(filename);
            const next = nextConfig(previousConfig, capPolicy, nextProfit, label);
            previousApproval = { ...previousApproval, runtimeId: next.runtimeId, profitTakingMigration: {
                previousRuntimeId: previousConfig.runtimeId, previousManifestSha256: hash(fs.readFileSync(filename)),
                previousContinuation: previousApproval, previousContinuationSha256: digest(previousApproval),
                previousProfitTaking: previousConfig.profitTaking, currentProfitTakingSha256: digest(nextProfit),
                approvedAt: at }, profitTakingStateMigration: { stateSha256: digest(current.state), approvedAt: at } };
            previousConfig = next;
        }
        const { enabled, ...policy } = previousConfig.profitTaking;
        current.state.profitTakingControl = { schema: 1, policy, operation: null, disabled: null,
            lossProtection: { schema: 1, activatedAt: 7500, completedCount: 0,
                completedSha256: digest([]), consumed: [] } };
    }
    revision(previousConfig);
    previousConfig = nextConfig(previousConfig, capPolicy, previousConfig.profitTaking, 'maintenance');
    previousApproval = { ...previousApproval, runtimeId: previousConfig.runtimeId };
    const previousFile = revision(previousConfig);
    current.state.continuousOperation = { enabledAt: 4500, runtimeId: previousConfig.runtimeId };
    current.save();
    const config = nextConfig(previousConfig, { ...capPolicy, entryFilter: { ...capPolicy.entryFilter,
        maxCostPerShare: .82 } }, previousConfig.profitTaking, 'cap-adjustment');
    const approval = { ...previousApproval, runtimeId: config.runtimeId, reason: 'user_entry_cost_cap_adjustment',
        policyChange: { ...previousApproval.policyChange, currentPolicySha256: digest(config.policy) },
        entryCostCapAdjustment: { previousRuntimeId: previousConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(previousFile)), previousContinuation: structuredClone(previousApproval),
            previousContinuationSha256: digest(previousApproval), approvedAt: 8000 } };
    const approvalFile = path.join(dataDir, 'continuation.json');
    const save = () => atomicJson(approvalFile, approval);
    const repin = () => {
        config.runtimeId = identity(config); approval.runtimeId = config.runtimeId;
        approval.policyChange.currentPolicySha256 = digest(config.policy);
        approval.entryCostCapAdjustment.previousContinuationSha256 = digest(approval.entryCostCapAdjustment.previousContinuation);
        save();
    };
    save();
    return { config, approval, original, originalProfitTaking, current, old, risk, riskFile, manifestFile,
        previousConfig, previousApproval, previousFile, profitFiles, capFile, bufferFile, periodId, dataDir, save, repin,
        bind: () => bindRiskPeriod(bindRuntimeContinuation(config, { ELIGIBLE_LIVE_CONTINUATION: approvalFile })) };
}

test('cap adjustment preserves the full withdrawal chain and original financial/risk period without writes', t => {
    const f = fixture(t), before = fs.readFileSync(f.current.filename), prior = fs.readFileSync(f.old.filename);
    const riskBefore = fs.readFileSync(f.riskFile), manifestBefore = fs.readFileSync(f.manifestFile);
    const config = f.bind();
    assert.equal(config.id, f.periodId); assert.equal(config.riskRuntimeId, f.original.runtimeId);
    assert.deepEqual(config.riskPeriod, f.risk); assert.equal(config.policy.entryFilter.maxCostPerShare, .82);
    assert.deepEqual(config.runtimeContinuation.entryCostCapAdjustment.previousContinuation, f.previousApproval);
    assert.deepEqual(verifiedProfitTakingMigration(config), f.previousApproval.profitTakingMigration);
    assert.deepEqual(continuationProfitTaking(config), f.originalProfitTaking);
    assert.deepEqual(config.profitTaking, f.previousConfig.profitTaking);
    assert.equal(Object.isFrozen(config.runtimeContinuation.entryCostCapAdjustment.previousContinuation), true);
    assert.deepEqual(validateRiskPeriodRecord(config, f.risk), f.risk);
    const readiness = eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true });
    assert.equal(readiness.readyForLive, true);
    assert.deepEqual(fs.readFileSync(f.current.filename), before); assert.deepEqual(fs.readFileSync(f.old.filename), prior);
    assert.deepEqual(fs.readFileSync(f.riskFile), riskBefore); assert.deepEqual(fs.readFileSync(f.manifestFile), manifestBefore);
    assert.throws(() => prepareProfitTakingPolicyMigration(f.current.state, config, 8001), /migration_unproven/);
});

test('cap adjustment supports an unchanged disabled withdrawal policy with the same verified risk pin', t => {
    const f = fixture(t, { profitTaking: false }), config = f.bind();
    assert.equal(config.id, f.periodId); assert.equal(config.policy.entryFilter.maxCostPerShare, .82);
    assert.equal(config.profitTaking.enabled, false);
    assert.deepEqual(config.profitTaking, f.originalProfitTaking);
    assert.deepEqual(validateRiskPeriodRecord(config, f.risk), f.risk);
});

test('cap adjustment retains a persistent stop and cannot replay prior withdrawal migrations', t => {
    const f = fixture(t);
    f.current.state.stopped = { reason: 'wallet_ledger_mismatch', at: 7900 }; f.current.save();
    const config = f.bind(), readiness = eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true });
    assert.equal(readiness.readyForLive, false); assert.ok(readiness.blockers.includes('persistent_pilot_stop'));
    assert.deepEqual(new Store(config.settings, 'pilot', 'late-entry').state.stopped, f.current.state.stopped);
});

test('cap adjustment refuses forged, reordered, incomplete, or wider policy changes even after rehashing', async t => {
    const mutations = {
        targetCap: f => { f.config.policy.entryFilter.maxCostPerShare = .81; },
        targetGas: f => { f.config.policy.entryFilter.gasUsd += .01; },
        targetShares: f => { f.config.policy.shares = 6; },
        targetSlots: f => { f.config.policy.execution.slots = [90]; },
        targetRecipient: f => { f.config.profitTaking.recipient = `0x${'a'.repeat(40)}`; },
        targetLossRule: f => { f.config.profitTaking.lossProtection.beforeTradeMinUsd = 13; },
        removedLossMigration: f => { delete f.approval.profitTakingMigration; },
        removedStateMigration: f => { delete f.approval.profitTakingStateMigration; },
        rewrittenOldPolicyPin: f => { f.approval.policyChange.previousPolicySha256 = digest(f.previousConfig.policy); },
        extraApprovalField: f => { f.approval.unreviewed = true; },
        extraMigrationField: f => { f.approval.entryCostCapAdjustment.extra = true; },
        approvalTooEarly: f => { f.approval.entryCostCapAdjustment.approvedAt = 6999; },
        predecessorId: f => { f.approval.entryCostCapAdjustment.previousRuntimeId = 'f'.repeat(16); },
        predecessorHash: f => { f.approval.entryCostCapAdjustment.previousManifestSha256 = 'f'.repeat(64); },
        predecessorApproval: f => { f.approval.entryCostCapAdjustment.previousContinuation.fundingSha256 = 'f'.repeat(64); },
        predecessorReason: f => { f.approval.entryCostCapAdjustment.previousContinuation.reason = 'user_entry_buffer'; },
        recursiveAdjustment: f => { f.approval.entryCostCapAdjustment.previousContinuation.entryCostCapAdjustment = {}; },
        omittedAdjustment: f => { f.approval.reason = 'user_return_cost_cap'; },
        changedOriginalManifest: f => { fs.appendFileSync(f.manifestFile, '\n'); },
        changedPreviousManifest: f => { fs.appendFileSync(f.previousFile, '\n'); },
        changedProfitManifest: f => { fs.appendFileSync(f.profitFiles[0], '\n'); },
        changedBufferManifest: f => { fs.appendFileSync(f.bufferFile, '\n'); },
        changedRiskRecord: f => { fs.appendFileSync(f.riskFile, '\n'); },
        missingDeepProfitEdge: f => {
            const previous = f.approval.entryCostCapAdjustment.previousContinuation;
            delete previous.profitTakingMigration.previousContinuation.profitTakingMigration;
            previous.profitTakingMigration.previousContinuationSha256 = digest(previous.profitTakingMigration.previousContinuation);
            f.approval.profitTakingMigration = structuredClone(previous.profitTakingMigration);
        },
        reorderedProfitEdges: f => {
            const previous = f.approval.entryCostCapAdjustment.previousContinuation;
            previous.profitTakingMigration = structuredClone(previous.profitTakingMigration.previousContinuation.profitTakingMigration);
            f.approval.profitTakingMigration = structuredClone(previous.profitTakingMigration);
        },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = fixture(t); mutate(f); f.repin();
        assert.throws(f.bind, /eligible_(continuation|period)_/);
    });
});

test('unregistered or changed config cannot use an adjustment approval to replace the original risk pin', t => {
    const f = fixture(t), config = f.bind();
    for (const changed of [
        { ...config, runtimeContinuation: structuredClone(config.runtimeContinuation) },
        { ...config, policy: { ...config.policy, shares: 6 } },
        { ...config, settings: { ...config.settings, wallet: `0x${'a'.repeat(40)}` } },
        { ...config, settings: { ...config.settings, dataDir: `${config.settings.dataDir}/other` } },
    ]) assert.throws(() => validateRiskPeriodRecord(changed, f.risk), /eligible_continuation_cost_cap_adjustment_unverified/);
});
