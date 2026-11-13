import crypto from 'node:crypto';

const time = value => Number.isSafeInteger(value) && value >= 0;
const units = value => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scaled = value * 1e6, integer = Math.round(scaled);
    return Number.isSafeInteger(integer) && Math.abs(scaled - integer) <= .00001 ? BigInt(integer) : null;
};
const nonnegative = value => units(value) !== null && units(value) >= 0n;
const blockHash = value => /^0x[\da-f]{64}$/i.test(value || '') && !/^0x0{64}$/i.test(value);

export function lossProtectionActivationId(marker) {
    if (!marker || marker.schema !== 1 || !time(marker.activatedAt) || !time(marker.completedCount)
        || !/^[\da-f]{64}$/.test(marker.completedSha256 || '') || !Array.isArray(marker.consumed)) return null;
    return crypto.createHash('sha256').update(JSON.stringify({ schema: marker.schema, activatedAt: marker.activatedAt,
        completedCount: marker.completedCount, completedSha256: marker.completedSha256 })).digest('hex');
}

// Capture only balances already reconciled by the broker at a confirmed block.
// Keep this independent of the profit ledger validator to avoid import cycles.
export function captureLossWalletEvidence(state, witness) {
    if (!witness || !time(witness.blockNumber) || !blockHash(witness.blockHash) || !time(witness.checkedAt)
        || !nonnegative(witness.balance) || !nonnegative(state.walletStart)) return null;
    const evidence = { balance: witness.balance, blockNumber: witness.blockNumber,
        blockHash: witness.blockHash, checkedAt: witness.checkedAt,
        walletCashDelta: state.walletCashDelta, externalCashDelta: state.externalWalletActivity?.cashDelta ?? 0,
        totalDeposited: state.capitalFunding?.totalDeposited ?? 0,
        totalTokenDebited: state.profitTaking?.totalTokenDebited ?? 0 };
    if (units(evidence.walletCashDelta) === null || units(evidence.externalCashDelta) === null
        || !nonnegative(evidence.totalDeposited) || !nonnegative(evidence.totalTokenDebited)) return null;
    const expected = units(state.walletStart) + units(evidence.walletCashDelta) + units(evidence.externalCashDelta)
        + units(evidence.totalDeposited) - units(evidence.totalTokenDebited);
    return units(evidence.balance) === expected ? evidence : null;
}

export function lossWalletProofMatches(state, proof, position, now, maxAgeMs) {
    const evidence = proof?.evidence;
    if (!position || proof?.position !== position || state.position !== position || !evidence
        || !time(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
        || !time(position.openedAt) || evidence.checkedAt < position.openedAt
        || evidence.checkedAt > now || now - evidence.checkedAt > maxAgeMs
        || !Array.isArray(proof.holdings) || proof.holdings.length !== 2 || proof.holdings.some(value => units(value) !== 0n)
        || !Array.isArray(position.holdings) || position.holdings.length !== 2
        || position.holdings.some(value => units(value) !== 0n)) return false;
    const current = captureLossWalletEvidence(state, evidence);
    return current !== null && Object.keys(current).every(key => current[key] === evidence[key]);
}
