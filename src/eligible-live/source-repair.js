import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { externalActivityCandidate } from '../laya-live/external-activity.js';
import { ELIGIBLE_BINANCE_LEAD_VETO } from './binance-lead.js';

const verified = new WeakMap();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('eligible_source_repair_unproven'); };

export function registerBaseSourceRepair(config) {
    verified.set(config, { approval: config.runtimeContinuation, configSha256: digest(config) });
    return config;
}

export function verifiedBaseSourceRepair(config) {
    const proof = verified.get(config), approval = proof?.approval;
    return approval && proof.configSha256 === digest(config) && approval === config.runtimeContinuation
        && config.id === approval.periodId && config.runtimeId === approval.runtimeId
        && config.settings.fingerprint === approval.periodId ? approval : null;
}

const migrationOf = item => item?.sourceRepairMigration || item?.entryBinanceLeadVeto || null;
const predecessorOf = item => migrationOf(item)?.previousContinuation || null;

function verifyPredecessorLineage(state, approval, firstPrevious = migrationOf(approval)?.previousContinuation) {
    if (!firstPrevious) {
        if (approval.reason === 'base_period_binance_lead_veto' && state.continuousOperationHistory?.length) fail();
        return;
    }
    const predecessors = [], history = state.continuousOperationHistory || [];
    for (let previous = firstPrevious; previous; previous = predecessorOf(previous)) predecessors.unshift(previous);
    if (history.length !== predecessors.length) fail();
    predecessors.forEach((previous, index) => {
        const row = history[index], following = predecessors[index + 1] || approval;
        const migration = migrationOf(previous);
        if (!Number.isSafeInteger(row?.migratedAt) || row.migratedAt < previous.approvedAt
            || row.migratedAt > following.approvedAt
            || !isDeepStrictEqual(row, { ...state.continuousOperation,
                runtimeId: migration?.previousRuntimeId || previous.originalRuntimeId,
                migratedAt: row.migratedAt, nextRuntimeId: previous.runtimeId,
                reasonVerified: previous.reason, beforeSha256: previous.stateSha256,
                previousManifestSha256: migration?.previousManifestSha256
                    || previous.originalManifestSha256 })) fail();
    });
}

// Run under the pilot lock with the service stopped. Only runtime lineage moves;
// the ordinary reconciler must still prove and complete any empty reservation.
export function prepareBaseSourceRepair(state, config, now = Date.now()) {
    const approval = verifiedBaseSourceRepair(config), operation = state.continuousOperation;
    if (!approval || approval.reason !== 'base_period_source_repair'
        || digest(state) !== approval.stateSha256 || !Number.isSafeInteger(now)
        || now < approval.approvedAt || config.settings.continuousTrading !== true
        || state.baseline !== config.id || state.startedAt !== approval.ledgerStartedAt
        || state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.decisionProvider !== 'eligible'
        || operation?.runtimeId !== (approval.sourceRepairMigration?.previousRuntimeId || approval.originalRuntimeId)
        || !Number.isSafeInteger(operation.enabledAt) || operation.enabledAt < state.startedAt
        || operation.enabledAt > approval.approvedAt
        || !externalActivityCandidate(config, state)
        || state.position != null && state.position.orders.length !== 0
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || !state.ai?.providers || Object.values(state.ai.providers).some(provider => !provider || provider.pending)
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)
        || state.continuousOperationHistory?.some(row => !row || row.nextRuntimeId === config.runtimeId)) fail();
    verifyPredecessorLineage(state, approval);
    const next = structuredClone(state);
    next.continuousOperationHistory = [...(state.continuousOperationHistory || []),
        { ...operation, migratedAt: now, nextRuntimeId: config.runtimeId,
            reasonVerified: 'base_period_source_repair', beforeSha256: approval.stateSha256,
            previousManifestSha256: approval.sourceRepairMigration?.previousManifestSha256
                || approval.originalManifestSha256 }];
    next.continuousOperation.runtimeId = config.runtimeId;
    return next;
}

export function prepareBaseBinanceLeadVeto(state, config, now = Date.now(), { walletProof = null } = {}) {
    const approval = verifiedBaseSourceRepair(config), operation = state?.continuousOperation;
    const previousRuntimeId = approval?.entryBinanceLeadVeto?.previousRuntimeId || approval?.originalRuntimeId;
    const previousManifestSha256 = approval?.entryBinanceLeadVeto?.previousManifestSha256 || approval?.originalManifestSha256;
    if (!approval || approval.reason !== 'base_period_binance_lead_veto'
        || digest(state) !== approval.stateSha256 || !Number.isSafeInteger(now)
        || now < approval.approvedAt || config.settings.continuousTrading !== true
        || state.baseline !== config.id || state.startedAt !== approval.ledgerStartedAt
        || state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.decisionProvider !== 'eligible'
        || state.position !== null || state.stopped != null || state.liveRiskStop != null || state.frozenAt != null
        || state.entryHolds != null && (!record(state.entryHolds) || Object.keys(state.entryHolds).length > 0)
        || state.reconciliationFaults != null && (!record(state.reconciliationFaults) || Object.keys(state.reconciliationFaults).length > 0)
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || !Array.isArray(state.completed) || state.completed.some(row => !record(row) || row.uncertain || row.pendingTrades)
        || !record(state.ai?.providers) || Object.values(state.ai.providers).some(provider => !provider || provider.pending || provider.disabled)
        || !Array.isArray(state.ai.snapshots)
        || operation?.runtimeId !== previousRuntimeId || !Number.isSafeInteger(operation.enabledAt)
        || operation.enabledAt < state.startedAt || operation.enabledAt > approval.approvedAt
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)
        || state.continuousOperationHistory?.some(row => !row || row.nextRuntimeId === config.runtimeId)) fail();
    verifyPredecessorLineage(state, approval, approval.entryBinanceLeadVeto?.previousContinuation);
    const epochs = state.strategyEpochs;
    if (!Array.isArray(epochs) || !epochs.length) fail();
    const previousEpoch = epochs.at(-1);
    if (!record(previousEpoch) || previousEpoch.id !== state.currentStrategyEpochId
        || !record(previousEpoch.policy?.entryFilter)
        || !isDeepStrictEqual({ ...previousEpoch.policy,
            entryFilter: { ...previousEpoch.policy.entryFilter, binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } }, config.policy))
        fail();
    const next = structuredClone(state);
    next.continuousOperationHistory = [...(state.continuousOperationHistory || []),
        { ...operation, migratedAt: now, nextRuntimeId: config.runtimeId,
            reasonVerified: 'base_period_binance_lead_veto', beforeSha256: approval.stateSha256,
            previousManifestSha256 }];
    next.continuousOperation.runtimeId = config.runtimeId;
    const epochIdentity = {
        periodId: config.id, runtimeId: config.runtimeId, startedAt: now,
        firstCompletedIndex: state.completed.length, firstSnapshotIndex: state.ai.snapshots.length,
    };
    const epoch = {
        id: digest(epochIdentity).slice(0, 16),
        ...epochIdentity,
        policy: structuredClone(config.policy),
        cashAtStart: state.cash,
        previousStrategyEpochId: previousEpoch.id,
        previousRuntimeId,
        reason: 'base_period_binance_lead_veto',
        beforeSha256: approval.stateSha256,
        previousManifestSha256,
        ...(approval.entryBinanceLeadVeto ? { previousContinuationSha256: approval.entryBinanceLeadVeto.previousContinuationSha256 } : {}),
        ...(walletProof ? { walletProof: structuredClone(walletProof) } : {}),
    };
    next.strategyEpochs = [...epochs, epoch];
    next.currentStrategyEpochId = epoch.id;
    return next;
}
