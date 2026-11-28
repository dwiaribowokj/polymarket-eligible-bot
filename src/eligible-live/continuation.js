import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateRiskPeriodRecord } from './period.js';
import { ELIGIBLE_BUFFER_POLICY } from './entry-buffer.js';
import { registerBaseSourceRepair } from './source-repair.js';
import { continuationProfitTaking, registerVerifiedProfitTakingMigration,
    registerVerifiedEntryCostCapAdjustment } from './profit-policy-proof.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
const fail = code => { throw new Error(`eligible_continuation_${code}`); };

function readFile(filename, { privateFile = false } = {}) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || privateFile && ((stat.mode & 0o077) !== 0
        || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('unsafe_path');
    return fs.readFileSync(filename);
}

function parse(bytes) {
    try { const value = JSON.parse(bytes); if (!record(value)) fail('invalid_record'); return value; }
    catch { fail('invalid_record'); }
}

function readArtifact(dataDir, ...parts) {
    let directory = dataDir;
    for (const part of parts.slice(0, -1)) {
        directory = path.join(directory, part);
        if (!fs.lstatSync(directory).isDirectory()) fail('unsafe_path');
    }
    return readFile(path.join(directory, parts.at(-1)));
}

function validSources(sources) {
    return Array.isArray(sources) && sources.length > 0
        && sources.every(source => Array.isArray(source) && source.length === 2
            && typeof source[0] === 'string' && source[0].length > 0
            && !path.posix.isAbsolute(source[0]) && !source[0].split('/').some(part => ['', '.', '..'].includes(part))
            && HASH.test(source[1]))
        && new Set(sources.map(source => source[0])).size === sources.length;
}

function deepFreeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
}

import { ELIGIBLE_BINANCE_LEAD_VETO } from './binance-lead.js';
import { registerVerifiedEntryBinanceLeadVeto } from './profit-policy-proof.js';

function policyMatches(config, approval, originalPolicy) {
    if (approval.reason === 'user_entry_binance_lead_veto') {
        const change = approval.policyChange;
        const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.82,
            gasUsd: originalPolicy?.execution?.gasUsd, basis: 'full_fill_at_frozen_limit',
            binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO };
        return record(originalPolicy) && !Object.hasOwn(originalPolicy, 'continuousTrading')
            && !Object.hasOwn(originalPolicy, 'entryFilter') && Number.isFinite(filter.gasUsd) && filter.gasUsd >= 0
            && config.settings.continuousTrading === true && config.policy.continuousTrading === true
            && record(change) && Object.keys(change).length === 2
            && change.previousPolicySha256 === jsonHash(originalPolicy)
            && change.currentPolicySha256 === jsonHash(config.policy)
            && isDeepStrictEqual({ ...originalPolicy, continuousTrading: true, entryFilter: filter }, config.policy);
    }
    if (approval.reason === 'user_entry_cost_cap_adjustment') {
        const change = approval.policyChange;
        const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.82,
            gasUsd: originalPolicy?.execution?.gasUsd, basis: 'full_fill_at_frozen_limit' };
        return record(originalPolicy) && !Object.hasOwn(originalPolicy, 'continuousTrading')
            && !Object.hasOwn(originalPolicy, 'entryFilter') && Number.isFinite(filter.gasUsd) && filter.gasUsd >= 0
            && config.settings.continuousTrading === true && config.policy.continuousTrading === true
            && record(change) && Object.keys(change).length === 2
            && change.previousPolicySha256 === jsonHash(originalPolicy)
            && change.currentPolicySha256 === jsonHash(config.policy)
            && isDeepStrictEqual({ ...originalPolicy, continuousTrading: true, entryFilter: filter }, config.policy);
    }
    if (approval.reason === 'user_entry_buffer') {
        const change = approval.policyChange;
        return record(originalPolicy) && !Object.hasOwn(originalPolicy, 'continuousTrading')
            && !Object.hasOwn(originalPolicy, 'entryFilter')
            && config.settings.continuousTrading === true && config.policy.continuousTrading === true
            && record(change) && Object.keys(change).length === 2
            && change.previousPolicySha256 === jsonHash(originalPolicy)
            && change.currentPolicySha256 === jsonHash(config.policy)
            && isDeepStrictEqual({ ...originalPolicy, continuousTrading: true,
                entryFilter: ELIGIBLE_BUFFER_POLICY }, config.policy);
    }
    if (['user_entry_cost_cap', 'user_return_cost_cap'].includes(approval.reason)) {
        const change = approval.policyChange;
        const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.85,
            gasUsd: originalPolicy?.execution?.gasUsd, basis: 'full_fill_at_frozen_limit' };
        return record(originalPolicy) && !Object.hasOwn(originalPolicy, 'continuousTrading')
            && !Object.hasOwn(originalPolicy, 'entryFilter') && Number.isFinite(filter.gasUsd) && filter.gasUsd >= 0
            && config.settings.continuousTrading === true && config.policy.continuousTrading === true
            && record(change) && Object.keys(change).length === 2
            && change.previousPolicySha256 === jsonHash(originalPolicy)
            && change.currentPolicySha256 === jsonHash(config.policy)
            && isDeepStrictEqual({ ...originalPolicy, continuousTrading: true, entryFilter: filter }, config.policy);
    }
    if (approval.reason !== 'user_continuous_trading')
        return isDeepStrictEqual(originalPolicy, config.policy);
    const change = approval.policyChange;
    return record(originalPolicy) && !Object.hasOwn(originalPolicy, 'continuousTrading')
        && config.settings.continuousTrading === true && config.policy.continuousTrading === true
        && record(change) && Object.keys(change).length === 2
        && change.previousPolicySha256 === jsonHash(originalPolicy)
        && change.currentPolicySha256 === jsonHash(config.policy)
        && isDeepStrictEqual({ ...originalPolicy, continuousTrading: true }, config.policy);
}

// Preserve the complete reviewed predecessor, including incident approvals, while
// independently checking its policy and source identity against immutable bytes.
export function readEntryBufferPredecessor(config, approval = config.runtimeContinuation) {
    if (approval?.profitTakingMigration) config = { ...config,
        profitTaking: continuationProfitTaking({ ...config, runtimeContinuation: approval }) };
    const migration = approval?.entryBufferMigration, previous = migration?.previousContinuation;
    if (approval?.reason !== 'user_entry_buffer' || !record(migration) || !record(previous)
        || !ID.test(approval.periodId) || !ID.test(approval.originalRuntimeId)
        || !HASH.test(approval.originalManifestSha256) || !HASH.test(approval.riskRecordSha256)
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
        || jsonHash(previous) !== migration.previousContinuationSha256
        || previous.schema !== 1 || previous.reason !== 'user_entry_cost_cap'
        || previous.runtimeId !== migration.previousRuntimeId
        || ['originalRuntimeId', 'periodId', 'originalManifestSha256', 'riskRecordSha256',
            'fundingSha256', 'ledgerStartedAt'].some(key => previous[key] !== approval[key]))
        fail('buffer_predecessor_mismatch');
    const dataDir = fs.realpathSync(config.settings.dataDir);
    const originalBytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'manifest.json');
    const bytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'revisions',
        migration.previousRuntimeId, 'manifest.json');
    if (digest(originalBytes) !== approval.originalManifestSha256
        || digest(bytes) !== migration.previousManifestSha256) fail('buffer_predecessor_changed');
    const riskBytes = readArtifact(dataDir, 'eligible-risk-periods', approval.originalRuntimeId,
        approval.periodId, 'record.json');
    if (digest(riskBytes) !== approval.riskRecordSha256) fail('risk_record_changed');
    const original = parse(originalBytes), manifest = parse(bytes);
    const previousConfig = { ...config, policy: manifest.policy };
    if (original.id !== approval.periodId || original.startedAt !== approval.ledgerStartedAt
        || !validSources(original.sources) || !isDeepStrictEqual(original.profitTaking, config.profitTaking)
        || jsonHash({ policy: original.policy, sources: original.sources,
            profitTaking: original.profitTaking }).slice(0, 16) !== approval.originalRuntimeId
        || !policyMatches(config, approval, original.policy)
        || !policyMatches(previousConfig, previous, original.policy)
        || manifest.id !== approval.periodId || manifest.runtimeId !== migration.previousRuntimeId
        || manifest.startedAt !== approval.ledgerStartedAt || !validSources(manifest.sources)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== migration.previousRuntimeId
        || !isDeepStrictEqual({ ...manifest.policy, entryFilter: ELIGIBLE_BUFFER_POLICY }, config.policy))
        fail('buffer_predecessor_mismatch');
    return manifest;
}

export function readEntryCostCapReturnPredecessor(config, approval = config.runtimeContinuation) {
    if (approval?.profitTakingMigration) config = { ...config,
        profitTaking: continuationProfitTaking({ ...config, runtimeContinuation: approval }) };
    const migration = approval?.entryCostCapReturn, previous = migration?.previousContinuation;
    if (approval?.reason !== 'user_return_cost_cap' || !record(migration) || !record(previous)
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
        || jsonHash(previous) !== migration.previousContinuationSha256
        || previous.schema !== 1 || previous.reason !== 'user_entry_buffer'
        || previous.runtimeId !== migration.previousRuntimeId
        || ['originalRuntimeId', 'periodId', 'originalManifestSha256', 'riskRecordSha256',
            'fundingSha256', 'ledgerStartedAt'].some(key => previous[key] !== approval[key]))
        fail('cost_cap_return_predecessor_mismatch');
    const bytes = readArtifact(fs.realpathSync(config.settings.dataDir), approval.periodId,
        'eligible-runtime', 'revisions', migration.previousRuntimeId, 'manifest.json');
    if (digest(bytes) !== migration.previousManifestSha256) fail('cost_cap_return_predecessor_changed');
    const manifest = parse(bytes), previousConfig = { ...config, runtimeId: previous.runtimeId,
        policy: manifest.policy, runtimeContinuation: previous };
    if (manifest.id !== approval.periodId || manifest.runtimeId !== previous.runtimeId
        || manifest.startedAt !== approval.ledgerStartedAt || !validSources(manifest.sources)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== previous.runtimeId
        || !isDeepStrictEqual(manifest.policy.entryFilter, ELIGIBLE_BUFFER_POLICY)
        || !isDeepStrictEqual({ ...manifest.policy, entryFilter: config.policy.entryFilter }, config.policy))
        fail('cost_cap_return_predecessor_mismatch');
    readEntryBufferPredecessor(previousConfig, previous);
    return manifest;
}

export function bindRuntimeContinuation(config, env = process.env) {
    const filename = env.ELIGIBLE_LIVE_CONTINUATION;
    if (filename === undefined) return config;
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('absolute_path_required');
    const approval = parse(readFile(filename, { privateFile: true }));
    return validateContinuation(config, approval);
}

function validateProfitTakingMigration(config, approval, depth) {
    const migration = approval.profitTakingMigration, previous = migration?.previousContinuation;
    const oldPolicy = migration?.previousProfitTaking;
    const walletTransition = record(oldPolicy) && !previous?.profitTakingMigration
        && !Object.hasOwn(oldPolicy, 'lossProtection') && oldPolicy.retainUsd === 20
        && ['realized_profit', undefined].includes(oldPolicy.trigger)
        && isDeepStrictEqual(config.profitTaking, { ...oldPolicy,
            retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15 });
    const lossTransition = record(oldPolicy) && record(previous?.profitTakingMigration)
        && !Object.hasOwn(oldPolicy, 'lossProtection') && oldPolicy.trigger === 'wallet_balance'
        && oldPolicy.retainUsd === 10 && oldPolicy.thresholdUsd === 15
        && isDeepStrictEqual(config.profitTaking, { ...oldPolicy,
            lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } });
    const keys = ['previousRuntimeId', 'previousManifestSha256', 'previousContinuation',
        'previousContinuationSha256', 'previousProfitTaking', 'currentProfitTakingSha256', 'approvedAt'];
    if (!record(migration) || Object.keys(migration).length !== keys.length
        || keys.some(key => !Object.hasOwn(migration, key)) || !record(previous)
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || previous.runtimeId !== migration.previousRuntimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
        || !HASH.test(migration.currentProfitTakingSha256)
        || jsonHash(previous) !== migration.previousContinuationSha256
        || jsonHash(config.profitTaking) !== migration.currentProfitTakingSha256
        || !Number.isSafeInteger(migration.approvedAt) || migration.approvedAt < approval.ledgerStartedAt
        || !record(migration.previousProfitTaking) || migration.previousProfitTaking.enabled !== true
        || migration.previousProfitTaking.chunkUsd !== 5 || !walletTransition && !lossTransition
        || typeof migration.previousProfitTaking.recipient !== 'string'
        || !/^0x[a-fA-F0-9]{40}$/.test(migration.previousProfitTaking.recipient)
        || /^0x0{40}$/i.test(migration.previousProfitTaking.recipient)) fail('profit_policy_mismatch');
    const { runtimeId: _runtimeId, profitTakingMigration: _migration,
        profitTakingStateMigration: _stateMigration, ...unchanged } = approval;
    const { runtimeId: _previousId, ...previousUnchanged } = previous;
    // The second reviewed policy edge retains the first edge inside its full
    // predecessor. Recursive validation still proves the original risk pin.
    if (lossTransition) {
        delete previousUnchanged.profitTakingMigration;
        delete previousUnchanged.profitTakingStateMigration;
    }
    if (!isDeepStrictEqual(unchanged, previousUnchanged)) fail('profit_policy_predecessor_mismatch');
    const bytes = readArtifact(fs.realpathSync(config.settings.dataDir), approval.periodId,
        'eligible-runtime', 'revisions', migration.previousRuntimeId, 'manifest.json');
    if (digest(bytes) !== migration.previousManifestSha256) fail('profit_policy_predecessor_changed');
    const manifest = parse(bytes);
    if (manifest.id !== approval.periodId || manifest.runtimeId !== previous.runtimeId
        || manifest.startedAt !== approval.ledgerStartedAt || !validSources(manifest.sources)
        || !isDeepStrictEqual(manifest.profitTaking, migration.previousProfitTaking)
        || !isDeepStrictEqual(manifest.policy, config.policy)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== previous.runtimeId)
        fail('profit_policy_predecessor_mismatch');
    const predecessor = validateContinuation({ ...config, runtimeId: previous.runtimeId,
        policy: manifest.policy, sources: manifest.sources, profitTaking: manifest.profitTaking }, previous, depth + 1);
    return continuationProfitTaking(predecessor);
}

function validateEntryCostCapAdjustment(config, approval, depth) {
    const migration = approval.entryCostCapAdjustment, previous = migration?.previousContinuation;
    const keys = ['previousRuntimeId', 'previousManifestSha256', 'previousContinuation',
        'previousContinuationSha256', 'approvedAt'];
    if (!record(migration) || Object.keys(migration).length !== keys.length
        || keys.some(key => !Object.hasOwn(migration, key)) || !record(previous)
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || previous.runtimeId !== migration.previousRuntimeId
        || !['user_entry_cost_cap', 'user_return_cost_cap'].includes(previous.reason)
        || Object.hasOwn(previous, 'entryCostCapAdjustment')
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
        || jsonHash(previous) !== migration.previousContinuationSha256
        || !Number.isSafeInteger(migration.approvedAt) || migration.approvedAt < approval.ledgerStartedAt
        || migration.approvedAt < (previous.profitTakingMigration?.approvedAt ?? approval.ledgerStartedAt))
        fail('cost_cap_adjustment_predecessor_mismatch');
    const { runtimeId: _runtimeId, reason: _reason, policyChange: change,
        entryCostCapAdjustment: _adjustment, ...unchanged } = approval;
    const { runtimeId: _previousId, reason: _previousReason, policyChange: previousChange,
        ...previousUnchanged } = previous;
    if (!isDeepStrictEqual(unchanged, previousUnchanged)
        || !record(change) || Object.keys(change).length !== 2 || !record(previousChange)
        || change.previousPolicySha256 !== previousChange.previousPolicySha256
        || change.currentPolicySha256 !== jsonHash(config.policy)) fail('cost_cap_adjustment_predecessor_mismatch');
    const bytes = readArtifact(fs.realpathSync(config.settings.dataDir), approval.periodId,
        'eligible-runtime', 'revisions', migration.previousRuntimeId, 'manifest.json');
    if (digest(bytes) !== migration.previousManifestSha256) fail('cost_cap_adjustment_predecessor_changed');
    const manifest = parse(bytes), previousFilter = manifest.policy?.entryFilter;
    if (manifest.id !== approval.periodId || manifest.runtimeId !== previous.runtimeId
        || manifest.startedAt !== approval.ledgerStartedAt || !validSources(manifest.sources)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== previous.runtimeId
        || previousChange.currentPolicySha256 !== jsonHash(manifest.policy)
        || !record(previousFilter) || previousFilter.maxCostPerShare !== 0.85
        || !isDeepStrictEqual({ ...manifest.policy,
            entryFilter: { ...previousFilter, maxCostPerShare: 0.82 } }, config.policy))
        fail('cost_cap_adjustment_predecessor_mismatch');
    // Validate withdrawal-policy edges against their original strategy, then
    // carry their verified risk pin across this separate strategy-only edge.
    const predecessor = validateContinuation({ ...config, runtimeId: previous.runtimeId,
        policy: manifest.policy, sources: manifest.sources, profitTaking: manifest.profitTaking }, previous, depth + 1);
    return continuationProfitTaking(predecessor);
}

function validateEntryBinanceLeadVeto(config, approval, depth) {
    const migration = approval.entryBinanceLeadVeto, previous = migration?.previousContinuation;
    const keys = ['previousRuntimeId', 'previousManifestSha256',
        'previousContinuation', 'previousContinuationSha256', 'approvedAt'];
    if (!record(migration) || Object.keys(migration).length !== keys.length
        || keys.some(key => !Object.hasOwn(migration, key))
        || !record(previous) || !ID.test(migration.previousRuntimeId)
        || migration.previousRuntimeId === config.runtimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
        || jsonHash(previous) !== migration.previousContinuationSha256
        || previous.schema !== 1 || previous.reason !== 'user_entry_cost_cap_adjustment'
        || previous.runtimeId !== migration.previousRuntimeId
        || Object.hasOwn(previous, 'entryBinanceLeadVeto')
        || !Number.isSafeInteger(migration.approvedAt) || migration.approvedAt < approval.ledgerStartedAt
        || previous.entryCostCapAdjustment?.approvedAt && migration.approvedAt < previous.entryCostCapAdjustment.approvedAt
        || approval.profitTakingMigration?.approvedAt && migration.approvedAt < approval.profitTakingMigration.approvedAt
        || approval.profitTakingStateMigration?.approvedAt && migration.approvedAt < approval.profitTakingStateMigration.approvedAt)
        fail('binance_lead_veto_predecessor_mismatch');
    const strip = (value, ignored) => Object.fromEntries(
        Object.entries(value).filter(([key]) => !ignored.includes(key)));
    const unchanged = strip(approval, ['runtimeId', 'reason', 'policyChange', 'entryBinanceLeadVeto']);
    const previousUnchanged = strip(previous, ['runtimeId', 'reason', 'policyChange', 'entryCostCapAdjustment']);
    if (!isDeepStrictEqual(unchanged, previousUnchanged)
        || !record(approval.policyChange) || !record(previous.policyChange)
        || Object.keys(approval.policyChange).length !== 2 || Object.keys(previous.policyChange).length !== 2
        || approval.policyChange.previousPolicySha256 !== previous.policyChange.previousPolicySha256
        || approval.policyChange.currentPolicySha256 !== jsonHash(config.policy))
        fail('binance_lead_veto_predecessor_mismatch');
    const dataDir = fs.realpathSync(config.settings.dataDir);
    const bytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'revisions',
        previous.runtimeId, 'manifest.json');
    if (digest(bytes) !== migration.previousManifestSha256) fail('binance_lead_veto_predecessor_changed');
    const manifest = parse(bytes);
    const previousFilter = manifest.policy?.entryFilter;
    if (manifest.id !== approval.periodId || manifest.runtimeId !== previous.runtimeId
        || manifest.startedAt !== approval.ledgerStartedAt || !validSources(manifest.sources)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== previous.runtimeId
        || previous.policyChange.currentPolicySha256 !== jsonHash(manifest.policy)
        || !record(previousFilter) || previousFilter.maxCostPerShare !== 0.82
        || Object.hasOwn(previousFilter, 'binanceLeadVeto')
        || !isDeepStrictEqual({ ...manifest.policy,
            entryFilter: { ...previousFilter, binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } }, config.policy))
        fail('binance_lead_veto_predecessor_mismatch');
    const predecessor = validateContinuation({ ...config, runtimeId: previous.runtimeId,
        policy: manifest.policy, sources: manifest.sources, profitTaking: manifest.profitTaking }, previous, depth + 1);
    return continuationProfitTaking(predecessor);
}

function validateBaseSourceRepair(config, approval, depth, sourceRepairRuntimes) {
    const keys = ['schema', 'runtimeId', 'originalRuntimeId', 'periodId', 'reason',
        'originalManifestSha256', 'fundingSha256', 'ledgerStartedAt', 'wallet', 'dataDir',
        'stateSha256', 'approvedAt'];
    if (Object.hasOwn(approval, 'sourceRepairMigration')) keys.push('sourceRepairMigration');
    if (Object.keys(approval).length !== keys.length || keys.some(key => !Object.hasOwn(approval, key))
        || approval.schema !== 1 || !ID.test(approval.runtimeId) || !ID.test(approval.originalRuntimeId)
        || approval.periodId !== approval.originalRuntimeId || approval.runtimeId === approval.originalRuntimeId
        || approval.runtimeId !== config.runtimeId || config.riskPeriod || config.runtimeContinuation
        || !HASH.test(approval.originalManifestSha256) || !HASH.test(approval.fundingSha256)
        || !HASH.test(approval.stateSha256) || !Number.isSafeInteger(approval.ledgerStartedAt)
        || approval.ledgerStartedAt < 0 || !Number.isSafeInteger(approval.approvedAt)
        || approval.approvedAt < approval.ledgerStartedAt
        || !/^0x[a-f0-9]{40}$/.test(approval.wallet) || /^0x0{40}$/.test(approval.wallet)
        || approval.wallet !== config.settings.wallet?.toLowerCase()
        || !path.isAbsolute(config.settings.dataDir) || !validSources(config.sources)
        || jsonHash({ policy: config.policy, sources: config.sources,
            profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId) fail('approval_mismatch');
    if (sourceRepairRuntimes.has(config.runtimeId)) fail('source_repair_cycle');
    const visited = new Set(sourceRepairRuntimes).add(config.runtimeId);
    const dataDir = fs.realpathSync(config.settings.dataDir);
    if (dataDir !== approval.dataDir) fail('unsafe_path');
    const riskRoot = path.join(dataDir, 'eligible-risk-periods');
    try { if (!fs.lstatSync(riskRoot).isDirectory()) fail('unsafe_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A base-period repair cannot acknowledge, replace, or bypass a risk period.
    for (const runtime of [approval.originalRuntimeId, config.runtimeId]) {
        try { fs.lstatSync(path.join(riskRoot, runtime)); fail('base_period_conflict'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const bytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'manifest.json');
    if (digest(bytes) !== approval.originalManifestSha256) fail('manifest_changed');
    const manifest = parse(bytes);
    if (manifest.id !== approval.periodId || manifest.startedAt !== approval.ledgerStartedAt
        || manifest.runtimeId != null && manifest.runtimeId !== approval.originalRuntimeId
        || !validSources(manifest.sources)
        || (!Object.hasOwn(approval, 'sourceRepairMigration') && !isDeepStrictEqual(manifest.policy, config.policy))
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== approval.originalRuntimeId)
        fail('manifest_mismatch');
    if (Object.hasOwn(approval, 'sourceRepairMigration')) {
        const migration = approval.sourceRepairMigration, previous = migration?.previousContinuation;
        const migrationKeys = ['previousRuntimeId', 'previousManifestSha256',
            'previousContinuation', 'previousContinuationSha256'];
        const unchanged = ['schema', 'originalRuntimeId', 'periodId',
            'originalManifestSha256', 'fundingSha256', 'ledgerStartedAt', 'wallet', 'dataDir'];
        if (!record(migration) || Object.keys(migration).length !== migrationKeys.length
            || migrationKeys.some(key => !Object.hasOwn(migration, key)) || !record(previous)
            || !ID.test(migration.previousRuntimeId) || previous.runtimeId !== migration.previousRuntimeId
            || !['base_period_source_repair', 'base_period_binance_lead_veto'].includes(previous.reason)
            || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
            || jsonHash(previous) !== migration.previousContinuationSha256
            || unchanged.some(key => previous[key] !== approval[key])
            || !Number.isSafeInteger(previous.approvedAt) || previous.approvedAt > approval.approvedAt)
            fail('source_repair_predecessor_mismatch');
        if (visited.has(previous.runtimeId)) fail('source_repair_cycle');
        const previousBytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime',
            'revisions', previous.runtimeId, 'manifest.json');
        if (digest(previousBytes) !== migration.previousManifestSha256) fail('source_repair_predecessor_changed');
        const previousManifest = parse(previousBytes);
        if (previousManifest.id !== approval.periodId || previousManifest.runtimeId !== previous.runtimeId
            || previousManifest.startedAt !== approval.ledgerStartedAt || !validSources(previousManifest.sources)
            || !isDeepStrictEqual(previousManifest.policy, config.policy)
            || !isDeepStrictEqual(previousManifest.profitTaking, config.profitTaking)
            || jsonHash({ policy: previousManifest.policy, sources: previousManifest.sources,
                profitTaking: previousManifest.profitTaking }).slice(0, 16) !== previous.runtimeId)
            fail('source_repair_predecessor_mismatch');
        validateContinuation({ ...config, runtimeId: previous.runtimeId,
            policy: previousManifest.policy, sources: previousManifest.sources,
            profitTaking: previousManifest.profitTaking }, previous, depth + 1, visited);
    }
    const ledger = parse(readArtifact(dataDir, approval.periodId, 'pilot', 'late-entry.json'));
    if (ledger.baseline !== approval.periodId || ledger.mode !== 'pilot' || ledger.strategy !== 'late-entry'
        || ledger.decisionProvider !== 'eligible' || ledger.startedAt !== approval.ledgerStartedAt
        || !record(ledger.liveFunding) || jsonHash(ledger.liveFunding) !== approval.fundingSha256)
        fail('ledger_mismatch');
    const settings = { ...config.settings, fingerprint: approval.periodId };
    return registerBaseSourceRepair({ ...config, id: approval.periodId, settings,
        ai: { ...config.ai, id: approval.periodId, control: settings },
        riskRuntimeId: approval.originalRuntimeId, runtimeContinuation: deepFreeze(approval) });
}

function validateBaseBinanceLeadVeto(config, approval, depth, sourceRepairRuntimes) {
    const keys = ['schema', 'runtimeId', 'originalRuntimeId', 'periodId', 'reason',
        'originalManifestSha256', 'fundingSha256', 'ledgerStartedAt', 'wallet', 'dataDir',
        'stateSha256', 'approvedAt', 'policyChange'];
    if (Object.hasOwn(approval, 'entryBinanceLeadVeto')) keys.push('entryBinanceLeadVeto');
    if (Object.keys(approval).length !== keys.length || keys.some(key => !Object.hasOwn(approval, key))
        || approval.schema !== 1 || !ID.test(approval.runtimeId) || !ID.test(approval.originalRuntimeId)
        || approval.periodId !== approval.originalRuntimeId || approval.runtimeId === approval.originalRuntimeId
        || approval.runtimeId !== config.runtimeId || config.riskPeriod || config.runtimeContinuation
        || !HASH.test(approval.originalManifestSha256) || !HASH.test(approval.fundingSha256)
        || !HASH.test(approval.stateSha256) || !Number.isSafeInteger(approval.ledgerStartedAt)
        || approval.ledgerStartedAt < 0 || !Number.isSafeInteger(approval.approvedAt)
        || approval.approvedAt < approval.ledgerStartedAt
        || !/^0x[a-f0-9]{40}$/.test(approval.wallet) || /^0x0{40}$/.test(approval.wallet)
        || approval.wallet !== config.settings.wallet?.toLowerCase()
        || !path.isAbsolute(config.settings.dataDir) || !validSources(config.sources)
        || jsonHash({ policy: config.policy, sources: config.sources,
            profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId) fail('approval_mismatch');
    if (sourceRepairRuntimes.has(config.runtimeId)) fail('source_repair_cycle');
    const visited = new Set(sourceRepairRuntimes).add(config.runtimeId);
    const dataDir = fs.realpathSync(config.settings.dataDir);
    if (dataDir !== approval.dataDir) fail('unsafe_path');
    const riskRoot = path.join(dataDir, 'eligible-risk-periods');
    try { if (!fs.lstatSync(riskRoot).isDirectory()) fail('unsafe_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // A base-period continuation cannot acknowledge, replace, or bypass a risk period.
    for (const runtime of [approval.originalRuntimeId, config.runtimeId]) {
        try { fs.lstatSync(path.join(riskRoot, runtime)); fail('base_period_conflict'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const bytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'manifest.json');
    if (digest(bytes) !== approval.originalManifestSha256) fail('manifest_changed');
    const manifest = parse(bytes), originalFilter = manifest.policy?.entryFilter;
    if (manifest.id !== approval.periodId || manifest.startedAt !== approval.ledgerStartedAt
        || manifest.runtimeId != null && manifest.runtimeId !== approval.originalRuntimeId
        || !validSources(manifest.sources) || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== approval.originalRuntimeId
        || manifest.policy?.continuousTrading !== true || config.settings.continuousTrading !== true
        || !record(originalFilter) || originalFilter.version !== 'full-fill-all-in-cost-cap-v1'
        || originalFilter.maxCostPerShare !== 0.82 || originalFilter.basis !== 'full_fill_at_frozen_limit'
        || !Number.isFinite(originalFilter.gasUsd) || originalFilter.gasUsd < 0
        || originalFilter.gasUsd !== manifest.policy?.execution?.gasUsd
        || Object.hasOwn(originalFilter, 'binanceLeadVeto')
        || !record(approval.policyChange) || Object.keys(approval.policyChange).length !== 2
        || approval.policyChange.previousPolicySha256 !== jsonHash(manifest.policy)
        || approval.policyChange.currentPolicySha256 !== jsonHash(config.policy)
        || !isDeepStrictEqual({ ...manifest.policy,
            entryFilter: { ...originalFilter, binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } }, config.policy))
        fail('manifest_mismatch');
    if (Object.hasOwn(approval, 'entryBinanceLeadVeto')) {
        const migration = approval.entryBinanceLeadVeto, previous = migration?.previousContinuation;
        const migrationKeys = ['previousRuntimeId', 'previousManifestSha256',
            'previousContinuation', 'previousContinuationSha256'];
        const unchanged = ['schema', 'originalRuntimeId', 'periodId', 'originalManifestSha256',
            'fundingSha256', 'ledgerStartedAt', 'wallet', 'dataDir'];
        if (!record(migration) || Object.keys(migration).length !== migrationKeys.length
            || migrationKeys.some(key => !Object.hasOwn(migration, key)) || !record(previous)
            || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
            || previous.runtimeId !== migration.previousRuntimeId
            || previous.reason !== 'base_period_source_repair'
            || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.previousContinuationSha256)
            || jsonHash(previous) !== migration.previousContinuationSha256
            || unchanged.some(key => previous[key] !== approval[key])
            || !Number.isSafeInteger(previous.approvedAt) || previous.approvedAt > approval.approvedAt)
            fail('binance_lead_veto_predecessor_mismatch');
        if (visited.has(previous.runtimeId)) fail('source_repair_cycle');
        const previousBytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime',
            'revisions', previous.runtimeId, 'manifest.json');
        if (digest(previousBytes) !== migration.previousManifestSha256) fail('binance_lead_veto_predecessor_changed');
        const previousManifest = parse(previousBytes);
        if (previousManifest.id !== approval.periodId || previousManifest.runtimeId !== previous.runtimeId
            || previousManifest.startedAt !== approval.ledgerStartedAt || !validSources(previousManifest.sources)
            || !isDeepStrictEqual(previousManifest.policy, manifest.policy)
            || !isDeepStrictEqual(previousManifest.profitTaking, config.profitTaking)
            || jsonHash({ policy: previousManifest.policy, sources: previousManifest.sources,
                profitTaking: previousManifest.profitTaking }).slice(0, 16) !== previous.runtimeId)
            fail('binance_lead_veto_predecessor_mismatch');
        validateContinuation({ ...config, runtimeId: previous.runtimeId,
            policy: previousManifest.policy, sources: previousManifest.sources,
            profitTaking: previousManifest.profitTaking }, previous, depth + 1, visited);
    }
    const ledger = parse(readArtifact(dataDir, approval.periodId, 'pilot', 'late-entry.json'));
    if (ledger.baseline !== approval.periodId || ledger.mode !== 'pilot' || ledger.strategy !== 'late-entry'
        || ledger.decisionProvider !== 'eligible' || ledger.startedAt !== approval.ledgerStartedAt
        || !record(ledger.liveFunding) || jsonHash(ledger.liveFunding) !== approval.fundingSha256)
        fail('ledger_mismatch');
    const settings = { ...config.settings, fingerprint: approval.periodId };
    return registerBaseSourceRepair({ ...config, id: approval.periodId, settings,
        ai: { ...config.ai, id: approval.periodId, control: settings },
        riskRuntimeId: approval.originalRuntimeId, runtimeContinuation: deepFreeze(approval) });
}

function validateContinuation(config, approval, depth = 0, sourceRepairRuntimes = new Set()) {
    if (depth > 8) fail('approval_depth');
    if (approval.reason === 'base_period_source_repair')
        return validateBaseSourceRepair(config, approval, depth, sourceRepairRuntimes);
    if (approval.reason === 'base_period_binance_lead_veto')
        return validateBaseBinanceLeadVeto(config, approval, depth, sourceRepairRuntimes);
    if (approval.schema !== 1 || !ID.test(approval.runtimeId) || !ID.test(approval.originalRuntimeId)
        || !ID.test(approval.periodId) || approval.runtimeId === approval.originalRuntimeId
        || approval.runtimeId !== config.runtimeId
        || !['receipt_fee_estimate_repair', 'pre_entry_signal_repair', 'user_continuous_trading',
            'user_entry_cost_cap', 'user_entry_buffer', 'user_return_cost_cap',
            'user_entry_cost_cap_adjustment', 'user_entry_binance_lead_veto'].includes(approval.reason)
        || !HASH.test(approval.originalManifestSha256) || !HASH.test(approval.riskRecordSha256)
        || !HASH.test(approval.fundingSha256) || !Number.isSafeInteger(approval.ledgerStartedAt)
        || approval.ledgerStartedAt < 0) fail('approval_mismatch');
    const identity = { policy: config.policy, sources: config.sources, profitTaking: config.profitTaking };
    if (jsonHash(identity).slice(0, 16) !== config.runtimeId) fail('runtime_mismatch');
    if (!path.isAbsolute(config.settings.dataDir)) fail('unsafe_path');
    const dataDir = fs.realpathSync(config.settings.dataDir);
    if (approval.reason !== 'user_entry_cost_cap_adjustment' && Object.hasOwn(approval, 'entryCostCapAdjustment'))
        fail('cost_cap_adjustment_predecessor_mismatch');
    if (approval.reason !== 'user_entry_binance_lead_veto' && Object.hasOwn(approval, 'entryBinanceLeadVeto'))
        fail('binance_lead_veto_predecessor_mismatch');
    const originalProfitTaking = approval.reason === 'user_entry_binance_lead_veto'
        ? validateEntryBinanceLeadVeto(config, approval, depth)
        : approval.reason === 'user_entry_cost_cap_adjustment'
        ? validateEntryCostCapAdjustment(config, approval, depth)
        : approval.profitTakingMigration ? validateProfitTakingMigration(config, approval, depth) : config.profitTaking;
    const manifestBytes = readArtifact(dataDir, approval.periodId, 'eligible-runtime', 'manifest.json');
    if (digest(manifestBytes) !== approval.originalManifestSha256) fail('manifest_changed');
    const manifest = parse(manifestBytes);
    if (manifest.id !== approval.periodId || manifest.startedAt !== approval.ledgerStartedAt
        || !validSources(manifest.sources) || !policyMatches(config, approval, manifest.policy)
        || !isDeepStrictEqual(manifest.profitTaking, originalProfitTaking)
        || jsonHash({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== approval.originalRuntimeId)
        fail('manifest_mismatch');
    const historicalConfig = { ...config, profitTaking: originalProfitTaking };
    const { profitTakingMigration: _profitMigration, ...historicalApproval } = approval;
    if (approval.reason === 'user_entry_buffer') readEntryBufferPredecessor(historicalConfig, historicalApproval);
    if (approval.reason === 'user_return_cost_cap') readEntryCostCapReturnPredecessor(historicalConfig, historicalApproval);
    const continued = { ...config, riskRuntimeId: approval.originalRuntimeId,
        runtimeContinuation: deepFreeze(approval) };
    if (approval.profitTakingMigration) registerVerifiedProfitTakingMigration(continued, deepFreeze(originalProfitTaking));
    if (approval.reason === 'user_entry_cost_cap_adjustment') registerVerifiedEntryCostCapAdjustment(continued);
    if (approval.reason === 'user_entry_binance_lead_veto') registerVerifiedEntryBinanceLeadVeto(continued);
    const riskBytes = readArtifact(dataDir, 'eligible-risk-periods', approval.originalRuntimeId,
        approval.periodId, 'record.json');
    if (digest(riskBytes) !== approval.riskRecordSha256) fail('risk_record_changed');
    const risk = validateRiskPeriodRecord(continued, parse(riskBytes));
    if (risk.periodId !== approval.periodId) fail('risk_record_mismatch');
    const ledger = parse(readArtifact(dataDir, approval.periodId, 'pilot', 'late-entry.json'));
    if (ledger.baseline !== approval.periodId || ledger.mode !== 'pilot' || ledger.strategy !== 'late-entry'
        || ledger.decisionProvider !== 'eligible' || ledger.startedAt !== approval.ledgerStartedAt
        || !record(ledger.liveFunding) || jsonHash(ledger.liveFunding) !== approval.fundingSha256)
        fail('ledger_mismatch');
    return continued;
}

export function eligibleManifestPath(config) {
    const artifacts = path.join(config.settings.dataDir, config.id, 'eligible-runtime');
    if (!config.runtimeContinuation) return path.join(artifacts, 'manifest.json');
    if (!ID.test(config.runtimeId)) fail('runtime_mismatch');
    return path.join(artifacts, 'revisions', config.runtimeId, 'manifest.json');
}
