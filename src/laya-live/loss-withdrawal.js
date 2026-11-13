import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = value => /^0x[\da-f]{64}$/i.test(value || '') && !/^0x0{64}$/i.test(value);
const sha = value => /^[\da-f]{64}$/.test(value || '');
const time = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('invalid_loss_protection_state'); };
const units = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail();
    const scaled = value * 1e6, integer = Math.round(scaled);
    if (!Number.isSafeInteger(integer) || Math.abs(scaled - integer) > .00001) fail();
    return BigInt(integer);
};
const activationId = marker => digest({ schema: marker.schema, activatedAt: marker.activatedAt,
    completedCount: marker.completedCount, completedSha256: marker.completedSha256 });
const lossIdentity = (state, rowIndex, rowSha256) => digest({ baseline: state.baseline,
    startedAt: state.startedAt, rowIndex, rowSha256 });

export function lossProtectionPolicy(policy) {
    const value = policy?.lossProtection;
    if (value === undefined) return null;
    if (policy.trigger !== 'wallet_balance' || !value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== 'afterLossMinUsd,amountUsd,beforeTradeMinUsd'
        || value.beforeTradeMinUsd !== 14 || value.afterLossMinUsd !== 10 || value.amountUsd !== 5)
        throw new Error('invalid_profit_taking_policy');
    return { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 };
}

export function validateLossProtectionState(state, policy) {
    if (!lossProtectionPolicy(policy)) return null;
    const marker = state.profitTakingControl?.lossProtection;
    if (!marker || marker.schema !== 1 || !time(marker.activatedAt) || marker.activatedAt < state.startedAt
        || !time(marker.completedCount) || !Array.isArray(state.completed) || marker.completedCount > state.completed.length
        || !sha(marker.completedSha256) || marker.completedSha256 !== digest(state.completed.slice(0, marker.completedCount))
        || !Array.isArray(marker.consumed)) fail();
    const losses = new Set(), intents = new Set();
    for (const claim of marker.consumed) {
        const row = state.completed[claim?.rowIndex];
        if (!claim || !time(claim.rowIndex) || claim.rowIndex < marker.completedCount || !row
            || claim.rowSha256 !== digest(row) || claim.lossId !== lossIdentity(state, claim.rowIndex, claim.rowSha256)
            || losses.has(claim.lossId) || typeof claim.intentId !== 'string' || !/^[\w:-]{1,128}$/.test(claim.intentId)
            || intents.has(claim.intentId) || !time(claim.createdAt) || claim.createdAt < row.closedAt) fail();
        losses.add(claim.lossId); intents.add(claim.intentId);
    }
    return marker;
}

function walletEvidence(value) {
    return value && time(value.checkedAt) && time(value.blockNumber) && hash(value.blockHash)
        && units(value.balance) >= 0n && units(value.totalDeposited) >= 0n && units(value.totalTokenDebited) >= 0n
        && typeof units(value.walletCashDelta) === 'bigint' && typeof units(value.externalCashDelta) === 'bigint';
}

// Only the latest completed, receipt-backed loss can authorize the exception.
// The saved post-loss balance prevents a later deposit reviving an old loss.
export function lossWithdrawalCandidate(state, policy, context = {}) {
    const marker = validateLossProtectionState(state, policy);
    if (!marker || state.position || !state.completed.length) return null;
    try {
        const rowIndex = state.completed.length - 1, row = state.completed[rowIndex];
        const evidence = row.entrySignal?.lossProtection, before = evidence?.before, after = evidence?.after;
        if (rowIndex < marker.completedCount || row.traded !== true || row.uncertain !== false || units(row.pnl) >= 0n
            || !time(row.openedAt) || !time(row.closedAt) || row.openedAt < marker.activatedAt || row.closedAt < row.openedAt
            || evidence?.schema !== 1 || evidence.activationId !== activationId(marker)
            || !walletEvidence(before) || !walletEvidence(after)
            || before.checkedAt < marker.activatedAt || before.checkedAt > row.openedAt
            || after.checkedAt < row.openedAt || after.checkedAt > row.closedAt || after.blockNumber < before.blockNumber
            || [before, after].some(proof => units(proof.balance) !== units(state.walletStart)
                + units(proof.walletCashDelta) + units(proof.externalCashDelta)
                + units(proof.totalDeposited) - units(proof.totalTokenDebited))
            || units(before.balance) < 14000000n || units(after.balance) <= 10000000n
            || units(after.balance) - units(before.balance) !== units(after.walletCashDelta) - units(before.walletCashDelta)
            || ['externalCashDelta', 'totalDeposited', 'totalTokenDebited'].some(key => units(before[key]) !== units(after[key]))
            || units(after.externalCashDelta) !== units(state.externalWalletActivity?.cashDelta ?? 0)
            || units(after.totalDeposited) !== units(state.capitalFunding?.totalDeposited ?? 0)
            || units(after.totalTokenDebited) !== units(state.profitTaking?.totalTokenDebited ?? 0)
            || units(after.walletCashDelta) !== units(state.walletCashDelta)
            || !Array.isArray(row.fills) || !row.fills.length || !hash(row.conditionId)
            || row.fills.some(fill => {
                const proof = state.settlementEvidence?.[fill.hash?.toLowerCase()];
                return fill.source !== 'receipt' || !hash(fill.hash) || !hash(fill.orderId) || units(fill.shares) <= 0n
                    || !proof || proof.kind !== 'fill' || proof.source !== 'receipt' || proof.hash !== fill.hash.toLowerCase()
                    || proof.orderId !== fill.orderId || proof.conditionId !== row.conditionId
                    || !hash(proof.blockHash) || !time(proof.blockNumber)
                    || proof.blockNumber < before.blockNumber || proof.blockNumber > after.blockNumber
                    || units(proof.shares) !== units(fill.shares) || units(proof.cash) >= 0n;
            })) return null;
        const rowSha256 = digest(row), lossId = lossIdentity(state, rowIndex, rowSha256);
        const claim = marker.consumed.find(value => value.lossId === lossId);
        if (claim) {
            const operation = state.profitTakingControl.operation;
            if (context.lossIntentId !== claim.intentId || operation?.id !== claim.intentId
                || operation.lossId !== lossId || !['address_requested', 'address_ready'].includes(operation.stage)) return null;
        }
        const current = context.walletBalance ?? context.expectedWalletBalance;
        if (current !== undefined && units(current) <= 10000000n) return null;
        return { lossId, rowIndex, rowSha256, beforeTradeWallet: before.balance, afterLossWallet: after.balance };
    } catch { return null; }
}

export function claimLossWithdrawal(state, policy, candidate, intent) {
    const verified = lossWithdrawalCandidate(state, policy);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(candidate)
        || !intent || typeof intent.id !== 'string' || !/^[\w:-]{1,128}$/.test(intent.id)
        || !time(intent.createdAt) || intent.createdAt < state.completed[candidate.rowIndex].closedAt) fail();
    state.profitTakingControl.lossProtection.consumed.push({ lossId: candidate.lossId, rowIndex: candidate.rowIndex,
        rowSha256: candidate.rowSha256, intentId: intent.id, createdAt: intent.createdAt });
    intent.lossId = candidate.lossId;
    validateLossProtectionState(state, policy);
}
