import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { profitTakingLedger } from '../laya-live/profit-accounting.js';
import { verifiedProfitTakingMigration } from './profit-policy-proof.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('eligible_profit_policy_migration_unproven'); };
const controlPolicy = ({ enabled, ...policy }) => policy;
const accountingPolicy = policy => ({ recipient: policy.recipient, asset: policy.asset,
    chunkUsd: policy.chunkUsd, retainUsd: policy.retainUsd,
    ...(policy.trigger === 'wallet_balance' ? { trigger: policy.trigger, thresholdUsd: policy.thresholdUsd } : {}),
    ...(policy.lossProtection ? { lossProtection: structuredClone(policy.lossProtection) } : {}) });

// The caller holds the pilot lock with the service inactive. No balance, trade,
// receipt, stop, or trading-period field is reset by a withdrawal-policy change.
export function prepareProfitTakingPolicyMigration(state, config, now = Date.now()) {
    const migration = verifiedProfitTakingMigration(config);
    const lossProtection = config.profitTaking.lossProtection !== undefined;
    const pin = config.runtimeContinuation.profitTakingStateMigration;
    if (!pin || !/^[a-f0-9]{64}$/.test(pin.stateSha256 || '')
        || pin.approvedAt !== migration.approvedAt || !Number.isSafeInteger(now)
        || now < pin.approvedAt || digest(state) !== pin.stateSha256
        || state.baseline !== config.id || state.startedAt !== config.runtimeContinuation.ledgerStartedAt
        || state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.decisionProvider !== 'eligible'
        || state.position || state.profitTaking?.pending || state.profitTakingControl?.operation
        || state.profitTakingControl?.disabled || state.profitTakingControl?.schema !== 1
        || lossProtection && state.profitTakingControl.lossProtection !== undefined
        || !isDeepStrictEqual(state.profitTakingControl.policy, controlPolicy(migration.previousProfitTaking))
        || state.continuousOperation?.runtimeId !== migration.previousRuntimeId
        || !Array.isArray(state.completed) || state.completed.some(row => row.uncertain || row.pendingTrades)
        || !state.ai?.providers || Object.values(state.ai.providers).some(provider => provider.pending)
        || state.profitTakingPolicyHistory != null && !Array.isArray(state.profitTakingPolicyHistory)
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)) fail();
    const ledger = profitTakingLedger(state);
    if (ledger && !isDeepStrictEqual(ledger.policy, accountingPolicy(migration.previousProfitTaking))) fail();
    const next = structuredClone(state), history = next.profitTakingPolicyHistory ||= [];
    if (history.some(row => row.runtimeId === config.runtimeId)) fail();
    history.push({ at: now, approvedAt: migration.approvedAt, reason: lossProtection
        ? 'user_loss_protection_pre14_after10_withdraw5' : 'user_wallet_balance_15_withdraw_5_retain_10',
        runtimeId: config.runtimeId, previousRuntimeId: migration.previousRuntimeId,
        previousManifestSha256: migration.previousManifestSha256, stateSha256: pin.stateSha256,
        completedSha256: digest(state.completed),
        previousPolicy: structuredClone(state.profitTakingControl.policy),
        policy: controlPolicy(config.profitTaking), previousLastCheck: state.profitTakingControl.lastCheck || null });
    next.profitTakingControl.policy = controlPolicy(config.profitTaking);
    delete next.profitTakingControl.lastCheck;
    if (lossProtection) next.profitTakingControl.lossProtection = { schema: 1, activatedAt: now,
        completedCount: state.completed.length, completedSha256: digest(state.completed), consumed: [] };
    if (next.profitTaking) next.profitTaking.policy = accountingPolicy(config.profitTaking);
    next.continuousOperationHistory ||= [];
    next.continuousOperationHistory.push({ ...state.continuousOperation, migratedAt: now,
        nextRuntimeId: config.runtimeId, reasonVerified: 'user_profit_taking_policy',
        previousManifestSha256: migration.previousManifestSha256, beforeSha256: pin.stateSha256 });
    next.continuousOperation.runtimeId = config.runtimeId;
    profitTakingLedger(next);
    return next;
}
