import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { continuousRecoveryCandidate } from './continuous-recovery.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const fail = () => { throw new Error('eligible_wallet_read_recovery_unproven'); };
const reviews = new WeakMap();
const reason = 'maintenance_wallet_balance_read_rejected';
const proofLifetimeMs = 30000;

// The private approval pins all accounting and authorization state, including
// unknown fields, while allowing diagnostic caches to advance before shutdown.
export function walletReadRecoveryStateDigest(state) {
    if (!record(state)) fail();
    const { events, operational, diagnostics, failures, dataGaps, liveClock,
        lastTickAt, lastHeartbeatAt, ...selected } = state;
    if (record(selected.profitTakingControl)) {
        const { lastCheck, ...control } = selected.profitTakingControl;
        selected.profitTakingControl = control;
    }
    return digest(selected);
}

function previousManifest(config, incident) {
    let directory = config.settings.dataDir;
    if (!path.isAbsolute(directory)) fail();
    for (const part of [config.id, 'eligible-runtime', 'revisions', incident.previousRuntimeId]) {
        directory = path.join(directory, part);
        if (!fs.lstatSync(directory).isDirectory()) fail();
    }
    const filename = path.join(directory, 'manifest.json');
    if (!fs.lstatSync(filename).isFile()) fail();
    const bytes = fs.readFileSync(filename);
    if (hash(bytes) !== incident.previousManifestSha256) fail();
    const manifest = JSON.parse(bytes);
    if (manifest.id !== config.id || manifest.runtimeId !== incident.previousRuntimeId
        || manifest.startedAt !== config.runtimeContinuation.ledgerStartedAt
        || !isDeepStrictEqual(manifest.policy, config.policy)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || !Array.isArray(manifest.sources) || !manifest.sources.length
        || manifest.sources.some(source => !Array.isArray(source) || source.length !== 2
            || typeof source[0] !== 'string' || !source[0] || path.posix.isAbsolute(source[0])
            || source[0].split('/').some(part => ['', '.', '..'].includes(part)) || !HASH.test(source[1]))
        || new Set(manifest.sources.map(source => source[0])).size !== manifest.sources.length
        || digest({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== incident.previousRuntimeId) fail();
}

function candidate(config, state) {
    const approval = config.runtimeContinuation, incident = approval?.walletReadRecovery;
    const hold = state?.entryHolds?.maintenance_wallet, error = hold?.error;
    if (approval?.reason !== 'user_continuous_trading' || incident?.reason !== reason
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || !ID.test(approval.originalRuntimeId) || config.riskRuntimeId !== approval.originalRuntimeId
        || config.riskPeriod?.runtimeId !== approval.originalRuntimeId
        || approval.periodId !== config.id || config.riskPeriod?.periodId !== config.id
        || state?.startedAt !== approval.ledgerStartedAt || digest(state.liveFunding) !== approval.fundingSha256
        || !ID.test(incident.previousRuntimeId) || incident.previousRuntimeId === config.runtimeId
        || !HASH.test(incident.previousManifestSha256) || !HASH.test(incident.stateSha256)
        || walletReadRecoveryStateDigest(state) !== incident.stateSha256
        || !isDeepStrictEqual(state.stopped, incident.stop) || state.stopped?.reason !== 'operational_check_failed'
        || !isDeepStrictEqual(state.continuousOperation, incident.continuousOperation)
        || state.continuousOperation?.runtimeId !== incident.previousRuntimeId
        || !record(state.entryHolds) || Object.keys(state.entryHolds).length !== 1
        || !isDeepStrictEqual(hold, incident.hold) || hold?.retryable !== false
        || !timestamp(hold.firstAt) || !timestamp(hold.failedAt) || !timestamp(hold.retryAt)
        || hold.firstAt < state.continuousOperation.enabledAt || hold.firstAt !== hold.failedAt
        || hold.failedAt > state.stopped.at || hold.retryAt < hold.failedAt || hold.attempts !== 1
        || error?.name !== 'OperationalError' || error.code !== 'rpc_rejected'
        || error.category !== 'contract' || error.stage !== 'wallet_balance'
        || error.endpoint !== 'rpc_primary' || !Number.isFinite(error.durationMs) || error.durationMs < 0
        || error.attempts !== 1
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)
        || !continuousRecoveryCandidate(config, { ...state, entryHolds: {},
            continuousOperation: { ...state.continuousOperation, runtimeId: config.runtimeId } })
        || state.completed.some(row => row.actions != null && (!Array.isArray(row.actions)
            || row.actions.some(action => !record(action) || !['confirmed', 'failed'].includes(action.status)))
            || row.orders != null && (!Array.isArray(row.orders)
                || row.orders.some(order => !record(order) || !['complete', 'rejected', 'cancelled'].includes(order.status))))) fail();
    previousManifest(config, incident);
    return incident;
}

// The caller holds the pilot lock. A failed balance read has no transaction to
// replace or receipt to recover; fresh account and chain proofs must stand alone.
export async function prepareWalletReadRecovery(config, state, client, providers, { now = Date.now } = {}) {
    const incident = candidate(config, state), beforeSha256 = digest(state), configSha256 = digest(config);
    const guard = () => {
        if (digest(state) !== beforeSha256 || digest(config) !== configSha256) fail();
        candidate(config, state);
    };
    const history = () => {
        guard();
        const rows = eligibleHistory(config);
        if (!isDeepStrictEqual(rows.find(ledger => ledger.baseline === config.id
            && ledger.strategy === 'late-entry'), state)) fail();
        return rows;
    };
    const checked = await eligiblePreflight(config, client, providers, state,
        { history: history(), refreshHistory: history });
    guard();
    if (checked.output.operationalReady !== true || checked.output.readyForLive !== false
        || checked.output.startAllowed !== false || checked.output.recoveryOnly !== false
        || !isDeepStrictEqual(checked.output.blockers, ['persistent_pilot_stop'])) fail();
    const proof = await readPeriodWalletProof(config, client);
    guard();
    let trades = await assertPeriodAccountReady(checked.account, { client, wallet: config.settings.wallet, proof });
    guard();
    const holdings = [];
    for (const completed of state.completed) {
        const amounts = await client.holdings(completed.tokens, proof.blockNumber);
        guard();
        if (!Array.isArray(amounts) || amounts.length !== 2 || amounts.some(amount => amount !== 0)) fail();
        holdings.push({ conditionId: completed.conditionId, tokens: [...completed.tokens], amounts });
    }
    // The ledger scan can take time. Refresh global orders/trades after every
    // completed market has been proven flat at the same confirmed block.
    const [latest, positions] = await Promise.all([client.ordersAndTrades(), client.positions()]);
    guard();
    if (!record(latest) || !Array.isArray(latest.orders)) fail();
    trades = await assertPeriodAccountReady({ ...checked.account, positions, openOrders: latest.orders,
        checks: [{ name: 'authenticated_order_trade_api', detail: { trades: latest.trades } }] },
    { client, wallet: config.settings.wallet, proof });
    guard();
    if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
    const verifiedAt = now(), finalProof = await readPeriodWalletProof(config, client);
    guard();
    if (!timestamp(verifiedAt) || !timestamp(now()) || now() < verifiedAt || now() - verifiedAt > proofLifetimeMs
        || finalProof.blockNumber < proof.blockNumber
        || finalProof.blockNumber === proof.blockNumber && finalProof.blockHash !== proof.blockHash
        || ['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce', 'balance'].some(key => finalProof[key] !== proof[key])) fail();
    const expected = expectedWalletBalance(state);
    if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
        || !Number.isFinite(checked.account.wallet?.balance) || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
        || client.rpc.anchor?.number !== finalProof.blockNumber || client.rpc.anchor?.hash !== finalProof.blockHash) fail();
    history();
    const recoveredAt = now(), expiresAt = verifiedAt + proofLifetimeMs, nextState = structuredClone(state);
    if (!timestamp(recoveredAt) || recoveredAt < verifiedAt || recoveredAt > expiresAt) fail();
    nextState.stopHistory ||= [];
    nextState.stopHistory.push({ ...state.stopped, recoveredAt, runtimeId: config.runtimeId, reasonVerified: reason,
        beforeSha256, stateSha256: incident.stateSha256, originalHold: structuredClone(incident.hold),
        previousRuntimeId: incident.previousRuntimeId, previousManifestSha256: incident.previousManifestSha256,
        walletProof: { ...finalProof, verifiedAt, expectedBalance: expected, trades,
            holdingsProof: { blockNumber: proof.blockNumber, blockHash: proof.blockHash, holdings } } });
    nextState.stopped = null;
    delete nextState.entryHolds.maintenance_wallet;
    nextState.continuousOperationHistory ||= [];
    nextState.continuousOperationHistory.push({ ...state.continuousOperation, migratedAt: recoveredAt,
        nextRuntimeId: config.runtimeId, previousManifestSha256: incident.previousManifestSha256,
        reasonVerified: reason, beforeSha256 });
    nextState.continuousOperation.runtimeId = config.runtimeId;
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        previousRuntimeId: incident.previousRuntimeId, stop: structuredClone(state.stopped),
        blockNumber: finalProof.blockNumber, blockHash: finalProof.blockHash, verifiedAt, expiresAt,
        walletPUSD: finalProof.balance, expectedWalletPUSD: expected, cash: state.cash,
        peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown, completedMarkets: state.completed.length,
        filledMarkets: state.completed.filter(row => row.traded).length,
        accountingPreserved: true, financialWrites: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { state, beforeSha256, nextSha256: digest(nextState), summarySha256: digest(summary),
        verifiedAt, expiresAt, now, history });
    return review;
}

export function applyWalletReadRecovery(store, review, { explicitApply = false } = {}) {
    const prepared = reviews.get(review);
    if (!explicitApply || !prepared || store.state !== prepared.state || review.summary?.ready !== true
        || review.beforeSha256 !== prepared.beforeSha256 || digest(store.state) !== prepared.beforeSha256
        || digest(review.nextState) !== prepared.nextSha256 || digest(review.summary) !== prepared.summarySha256) fail();
    prepared.history();
    const at = prepared.now();
    if (!timestamp(at) || at < prepared.verifiedAt || at > prepared.expiresAt) fail();
    const keys = ['stopped', 'entryHolds', 'stopHistory', 'continuousOperation', 'continuousOperationHistory'];
    const previous = new Map(keys.map(key => [key, { exists: Object.hasOwn(store.state, key), value: store.state[key] }]));
    for (const key of keys) store.state[key] = structuredClone(review.nextState[key]);
    try { store.save(); }
    catch (error) {
        for (const [key, old] of previous) {
            if (old.exists) store.state[key] = old.value;
            else delete store.state[key];
        }
        throw error;
    }
    reviews.delete(review);
    return review.summary;
}
