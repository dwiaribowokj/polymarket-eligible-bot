import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { externalActivityCandidate } from '../laya-live/external-activity.js';

const verified = new WeakMap();
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

function verifyPredecessorLineage(state, approval) {
    if (!approval.sourceRepairMigration) return;
    const predecessors = [], history = state.continuousOperationHistory || [];
    for (let previous = approval.sourceRepairMigration.previousContinuation; previous;
        previous = previous.sourceRepairMigration?.previousContinuation) predecessors.unshift(previous);
    if (history.length !== predecessors.length) fail();
    predecessors.forEach((previous, index) => {
        const row = history[index], following = predecessors[index + 1] || approval;
        if (!Number.isSafeInteger(row?.migratedAt) || row.migratedAt < previous.approvedAt
            || row.migratedAt > following.approvedAt
            || !isDeepStrictEqual(row, { ...state.continuousOperation,
                runtimeId: previous.sourceRepairMigration?.previousRuntimeId || previous.originalRuntimeId,
                migratedAt: row.migratedAt, nextRuntimeId: previous.runtimeId,
                reasonVerified: 'base_period_source_repair', beforeSha256: previous.stateSha256,
                previousManifestSha256: previous.sourceRepairMigration?.previousManifestSha256
                    || previous.originalManifestSha256 })) fail();
    });
}

// Run under the pilot lock with the service stopped. Only runtime lineage moves;
// the ordinary reconciler must still prove and complete any empty reservation.
export function prepareBaseSourceRepair(state, config, now = Date.now()) {
    const approval = verifiedBaseSourceRepair(config), operation = state.continuousOperation;
    if (!approval || digest(state) !== approval.stateSha256 || !Number.isSafeInteger(now)
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
