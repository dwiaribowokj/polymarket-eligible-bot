import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const verified = new WeakMap();
const verifiedCapAdjustments = new WeakMap();
const fail = () => { throw new Error('eligible_continuation_profit_policy_unverified'); };

// Approval JSON alone cannot replace the risk period's original policy pin.
// Only continuation validation registers it after verifying the predecessor.
export function registerVerifiedProfitTakingMigration(config, originalProfitTaking) {
    const approval = config.runtimeContinuation;
    verified.set(approval, { originalProfitTaking, originalHash: digest(originalProfitTaking),
        currentHash: approval.profitTakingMigration.currentProfitTakingSha256,
        dataDir: config.settings.dataDir, wallet: config.settings.wallet });
}

export function verifiedProfitTakingMigration(config) {
    const approval = config.runtimeContinuation, proof = verified.get(approval);
    if (!proof || !Object.isFrozen(approval) || approval.runtimeId !== config.runtimeId
        || config.settings.dataDir !== proof.dataDir || config.settings.wallet !== proof.wallet
        || digest({ policy: config.policy, sources: config.sources,
            profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId
        || digest(config.profitTaking) !== proof.currentHash
        || digest(proof.originalProfitTaking) !== proof.originalHash) fail();
    return approval.profitTakingMigration;
}

export function continuationProfitTaking(config, periodId = config.runtimeContinuation?.periodId) {
    const approval = config.runtimeContinuation;
    if (!approval?.profitTakingMigration || periodId !== approval.periodId) return config.profitTaking;
    verifiedProfitTakingMigration(config);
    return verified.get(approval).originalProfitTaking;
}

export function registerVerifiedEntryCostCapAdjustment(config) {
    const approval = config.runtimeContinuation;
    verifiedCapAdjustments.set(approval, { runtimeId: config.runtimeId,
        policySha256: digest(config.policy), originalPolicySha256: approval.policyChange.previousPolicySha256,
        dataDir: config.settings.dataDir, wallet: config.settings.wallet });
}

export function verifiedEntryCostCapAdjustment(config) {
    const approval = config.runtimeContinuation, proof = verifiedCapAdjustments.get(approval);
    if (!proof || !Object.isFrozen(approval) || approval.reason !== 'user_entry_cost_cap_adjustment'
        || approval.runtimeId !== config.runtimeId || config.runtimeId !== proof.runtimeId
        || config.settings.dataDir !== proof.dataDir || config.settings.wallet !== proof.wallet
        || digest({ policy: config.policy, sources: config.sources,
            profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId
        || digest(config.policy) !== proof.policySha256
        || approval.policyChange.previousPolicySha256 !== proof.originalPolicySha256)
        throw new Error('eligible_continuation_cost_cap_adjustment_unverified');
    return proof.originalPolicySha256;
}
