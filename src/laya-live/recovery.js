import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { receiptMovements } from '../restart/client.js';
import { round, EPS } from '../restart/math.js';
import { profitTakingLedger } from './profit-accounting.js';
import { totalCapitalDeposited } from './capital-funding.js';
import { totalCapitalAllocated } from './capital-allocations.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Keep unknown/corrupt history fail-closed. Only the two generated artifacts
// are excluded; a report is never evidence of another trading period.
export function liveHistory(settings) {
    if (!fs.existsSync(settings.dataDir)) return [];
    return fs.readdirSync(settings.dataDir, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
        const dir = path.join(settings.dataDir, d.name, 'pilot');
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter(f => f.endsWith('.json')
            && !['laya-manifest.json', 'laya-report.json'].includes(f))
            .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    });
}

// A reviewed runtime repair may continue an existing period. The approval is
// pinned to the complete runtime hash and the original, self-verifying policy
// manifest. Any further code/config change invalidates it. This never creates
// a ledger, clears a stop, or restarts the pilot clock.
export function bindContinuation(config) {
    const filename = path.join(config.settings.dataDir, 'laya-live-continuation.json');
    if (!fs.existsSync(filename)) return config;
    const approval = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (approval.schema !== 1 || approval.runtimeId !== config.id
        || !/^[a-f0-9]{16}$/.test(approval.periodId)) throw new Error('live_continuation_runtime_mismatch');
    const directory = path.join(config.settings.dataDir, approval.periodId, 'pilot');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'laya-manifest.json'), 'utf8'));
    const originalId = hash({ policy: manifest.policy, hashes: manifest.sources,
        ...(manifest.profitTaking === undefined ? {} : { profitTaking: manifest.profitTaking }) }).slice(0, 16);
    const policyChange = approval.policyChange;
    const exactPolicyHashes = policyChange?.previousPolicySha256 === hash(manifest.policy)
        && policyChange?.currentPolicySha256 === hash(config.policy);
    const removedTimeLimit = policyChange?.reason === 'user_removed_live_deadline'
        && manifest.policy.pilotHours === 48 && config.policy.pilotHours === null
        && exactPolicyHashes
        && isDeepStrictEqual({ ...manifest.policy, pilotHours: null }, config.policy);
    const removedLiveLimits = policyChange?.reason === 'user_removed_live_limits'
        && manifest.policy.pilotMarkets === 30 && manifest.policy.pilotHours === 48
        && config.policy.pilotMarkets === null && config.policy.pilotHours === null
        && exactPolicyHashes
        && isDeepStrictEqual({ ...manifest.policy, pilotMarkets: null, pilotHours: null }, config.policy);
    // This explicit risk change retains the original period and all loss/peak
    // accounting. Binding its policy cannot clear a latched drawdown stop.
    const increasedDrawdownLimit = policyChange?.reason === 'user_increased_live_drawdown_limit'
        && manifest.policy.drawdownStop === 2 && config.policy.drawdownStop === 10
        && policyChange.previousDrawdownStop === 2 && policyChange.currentDrawdownStop === 10
        && manifest.policy.pilotMarkets === 30 && manifest.policy.pilotHours === 48
        && config.policy.pilotMarkets === null && config.policy.pilotHours === null
        && policyChange.previousRuntimePolicySha256 === hash({ ...manifest.policy, pilotMarkets: null, pilotHours: null })
        && exactPolicyHashes
        && isDeepStrictEqual({ ...manifest.policy, drawdownStop: 10, pilotMarkets: null, pilotHours: null }, config.policy);
    if (manifest.id !== approval.periodId || originalId !== approval.periodId
        || !isDeepStrictEqual(manifest.policy, config.policy) && !removedTimeLimit && !removedLiveLimits && !increasedDrawdownLimit)
        throw new Error('live_continuation_policy_mismatch');
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'late-entry.json'), 'utf8'));
    if (state.baseline !== approval.periodId || state.decisionProvider !== 'laya'
        || state.startedAt !== manifest.startedAt) throw new Error('live_continuation_ledger_mismatch');
    return { ...config, runtimeId: config.id, id: approval.periodId, continuation: approval,
        settings: { ...config.settings, fingerprint: approval.periodId }, ai: { ...config.ai, id: approval.periodId } };
}

export function recoverableBookStop(config, state) {
    const expected = config.continuation?.recoverStop;
    if (!expected || !['operational_check_failed', 'stale_or_invalid_execution_data', 'wallet_ledger_mismatch'].includes(expected.reason)
        || !isDeepStrictEqual(state?.stopped, expected)) return false;
    // Exact reviewed incidents before any order, never risk/settlement/submit
    // resets. Completed decisions can be retained only when pinned and expired.
    const incident = config.continuation.incident;
    const snapshots = state.ai?.snapshots, last = snapshots?.at(-1);
    const reviewedExpiryIncident = expected.reason === 'stale_or_invalid_execution_data'
        && incident?.reason === 'stale_laya_input' && Array.isArray(snapshots) && !!last && last.snapshotId === incident.snapshotId
        && hash(snapshots) === incident.snapshotsSha256 && last.decision?.status === 'ok'
        && last.decision.snapshotId === last.snapshotId && last.decision.model === 'typed-decisions'
        && ['BUY_UP', 'BUY_DOWN'].includes(last.decision.action)
        && Number.isFinite(last.at) && Number.isFinite(last.observedAt) && Number.isFinite(last.decisionReceivedAt)
        && last.observedAt <= last.at && last.at <= last.decisionReceivedAt && last.decisionReceivedAt <= expected.at
        && last.decisionReceivedAt - last.at <= config.ai.decisionMs
        && expected.at - last.observedAt > config.ai.dataAgeMs;
    const reviewedRpcIncident = config.continuation?.incident?.reason === 'rpc_missing_block';
    const pinnedFinishedDecisions = Array.isArray(snapshots)
        && hash(snapshots) === incident?.snapshotsSha256 && snapshots.every(snapshot =>
            Number.isFinite(snapshot.at) && Number.isFinite(snapshot.decisionReceivedAt)
            && snapshot.at <= snapshot.decisionReceivedAt && snapshot.decisionReceivedAt <= expected.at
            && snapshot.decision?.snapshotId === snapshot.snapshotId
            && (snapshot.decision.status === 'ok' && snapshot.decision.model === 'typed-decisions'
                || snapshot.decision.status === 'decision_timeout' && snapshot.decision.action === 'SKIP'
                    && Number.isFinite(snapshot.decision.actualLatencyMs)));
    const reviewedClockIncident = expected.reason === 'operational_check_failed'
        && incident?.reason === 'invalid_server_clock' && pinnedFinishedDecisions;
    const reviewedManualActivity = expected.reason === 'wallet_ledger_mismatch'
        && incident?.reason === 'reviewed_manual_wallet_activity' && incident.manualConfirmed === true
        && pinnedFinishedDecisions && config.continuation.walletAdjustments?.length > 0;
    if (expected.reason !== 'operational_check_failed' && !reviewedExpiryIncident && !reviewedManualActivity) return false;
    if (incident?.reason === 'invalid_server_clock' && !reviewedClockIncident) return false;
    if (state.externalWalletActivity && !reviewedRpcIncident && !reviewedExpiryIncident && !reviewedClockIncident && !reviewedManualActivity) return false;
    try { if (state.externalWalletActivity) expectedWalletBalance(state); } catch { return false; }
    return !state.position && state.completed?.length === 0 && state.seen && Object.keys(state.seen).length === 0
        && (snapshots?.length === 0 || reviewedExpiryIncident || reviewedClockIncident || reviewedManualActivity) && state.maxDrawdown === 0
        && Number.isFinite(state.liveFunding?.initialCapital) && state.cash === state.liveFunding.initialCapital
        && state.peakEquity === state.cash && state.walletStart === state.cash && state.walletCashDelta === 0
        && Object.values(state.ai.providers || {}).every(p => !p.pending && !p.disabled);
}

export function expectedWalletBalance(state) {
    // Internal ownership transfers do not move wallet tokens, but their history
    // must validate before reconciliation can authorize any further activity.
    totalCapitalAllocated(state);
    const external = state.externalWalletActivity;
    if (external && (!Array.isArray(external.receipts) || !Number.isFinite(external.cashDelta)
        || external.receipts.some(r => !Number.isFinite(r.cash))
        || new Set(external.receipts.map(r => r.hash)).size !== external.receipts.length
        || Math.abs(external.cashDelta - external.receipts.reduce((sum, r) => sum + r.cash, 0)) > EPS))
        throw new Error('invalid_external_wallet_accounting');
    const distributions = profitTakingLedger(state)?.totalTokenDebited || 0;
    return round(state.walletStart + (state.walletCashDelta || 0) + (external?.cashDelta || 0)
        + totalCapitalDeposited(state) - distributions);
}

// Only the reviewed, flat incident may import these specific external receipts.
// Read-only preflight verifies their cash movement at one confirmed block. The
// extra wallet cash is excluded from bot capital, profit and drawdown.
export async function verifyRecoveryCash(config, state, client) {
    const approved = config.continuation?.walletAdjustments;
    if (!approved?.length || !recoverableBookStop(config, state)) return null;
    const manual = config.continuation.incident?.reason === 'reviewed_manual_wallet_activity';
    const existing = state.externalWalletActivity?.receipts || [];
    if (state.externalWalletActivity && !manual || new Set(approved.map(r => r.hash)).size !== approved.length
        || approved.some(r => existing.some(old => old.hash === r.hash)))
        throw new Error('external_wallet_receipt_duplicate');
    const block = await client.confirmedBlock(), receipts = [];
    for (const expected of approved) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(expected.hash)) throw new Error('external_wallet_receipt_invalid');
        const receipt = await client.receipt(expected.hash);
        if (!receipt || receipt.status !== 1 || receipt.confirmations < 2 || receipt.blockNumber > block
            || receipt.blockNumber !== expected.blockNumber || receipt.blockHash !== expected.blockHash)
            throw new Error('external_wallet_receipt_unconfirmed');
        const cash = receiptMovements(receipt, config.settings.wallet, []).cash;
        if (!Number.isFinite(expected.cash) || Math.abs(cash - expected.cash) > EPS)
            throw new Error('external_wallet_receipt_cash_mismatch');
        receipts.push({ ...expected, cash });
    }
    const externalCashDelta = round(receipts.reduce((sum, r) => sum + r.cash, 0));
    return { block, receipts, externalCashDelta, actualPUSD: await client.balance(block),
        expectedPUSD: round(expectedWalletBalance(state) + externalCashDelta) };
}

export function recoverBookStop(store, config, { explicitLive, operationalReady, otherHistory, walletReconciliation }) {
    if (!explicitLive || !operationalReady || otherHistory || !recoverableBookStop(config, store.state))
        throw new Error('live_book_stop_recovery_blocked');
    if (config.continuation.walletAdjustments?.length) {
        const r = walletReconciliation;
        if (!r || !isDeepStrictEqual(r.receipts, config.continuation.walletAdjustments)
            || !Number.isFinite(r.externalCashDelta) || !Number.isFinite(r.actualPUSD)
            || Math.abs(r.externalCashDelta - r.receipts.reduce((sum, receipt) => sum + receipt.cash, 0)) > EPS
            || Math.abs(r.actualPUSD - (expectedWalletBalance(store.state) + r.externalCashDelta)) > EPS)
            throw new Error('external_wallet_reconciliation_required');
        const existing = store.state.externalWalletActivity;
        store.state.externalWalletActivity = { cashDelta: round((existing?.cashDelta || 0) + r.externalCashDelta),
            receipts: [...(existing?.receipts || []), ...r.receipts],
            verifiedAt: Date.now(), block: r.block, capitalAllocated: 0 };
    }
    const previous = store.state.stopped;
    store.state.stopHistory ||= [];
    store.state.stopHistory.push({ ...previous, recoveredAt: Date.now(), runtimeId: config.runtimeId });
    store.state.stopped = null;
    // One atomic ledger save covers both the cash reconciliation and recovery.
    store.event('pre_entry_book_stop_recovered', { previous, runtimeId: config.runtimeId,
        externalWalletActivity: store.state.externalWalletActivity || null });
}
