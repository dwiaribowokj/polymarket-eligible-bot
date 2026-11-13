import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS, round } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { verifyAutoRedeemReceipt } from '../laya-live/settlement.js';
import { continuousRecoveryCandidate } from './continuous-recovery.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const TX = /^0x[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const sameAmount = (a, b) => Number.isFinite(a) && Number.isFinite(b) && round(a) === round(b);
const fail = () => { throw new Error('eligible_action_gas_recovery_unproven'); };
const reviews = new WeakMap();
const reason = 'safe_action_prepare_gas_unavailable';

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
            || typeof source[0] !== 'string' || !source[0] || !HASH.test(source[1]))
        || new Set(manifest.sources.map(source => source[0])).size !== manifest.sources.length
        || digest({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== incident.previousRuntimeId) fail();
    return manifest;
}

function candidate(config, state) {
    const approval = config.runtimeContinuation, incident = approval?.actionGasRecovery;
    const hold = state?.entryHolds?.maintenance_unknown, error = hold?.error;
    if (approval?.reason !== 'user_continuous_trading' || incident?.reason !== reason
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || !ID.test(approval.originalRuntimeId) || config.riskRuntimeId !== approval.originalRuntimeId
        || config.riskPeriod?.runtimeId !== approval.originalRuntimeId
        || approval.periodId !== config.id || config.riskPeriod?.periodId !== config.id
        || state?.startedAt !== approval.ledgerStartedAt || digest(state.liveFunding) !== approval.fundingSha256
        || !ID.test(incident.previousRuntimeId) || incident.previousRuntimeId === config.runtimeId
        || !HASH.test(incident.previousManifestSha256)
        || !isDeepStrictEqual(state.stopped, incident.stop) || state.stopped?.reason !== 'operational_check_failed'
        || !isDeepStrictEqual(state.continuousOperation, incident.continuousOperation)
        || state.continuousOperation?.runtimeId !== incident.previousRuntimeId
        || !record(state.entryHolds) || Object.keys(state.entryHolds).length !== 1
        || !isDeepStrictEqual(hold, incident.hold) || hold?.retryable !== false
        || !timestamp(hold.firstAt) || !timestamp(hold.failedAt) || !timestamp(hold.retryAt)
        || hold.firstAt < state.continuousOperation.enabledAt || hold.firstAt > hold.failedAt
        || hold.failedAt > state.stopped.at || hold.retryAt < hold.failedAt
        || !Number.isSafeInteger(hold.attempts) || hold.attempts < 1
        || error?.name !== 'OperationalError' || error.code !== 'insufficient_action_gas'
        || error.category !== 'validation' || error.stage !== 'safe_action_prepare'
        || ![incident.completedSha256, incident.seenSha256, incident.aiSha256].every(value => HASH.test(value))
        || digest(state.completed) !== incident.completedSha256 || digest(state.seen) !== incident.seenSha256
        || digest(state.ai) !== incident.aiSha256
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)
        || !continuousRecoveryCandidate(config, { ...state, entryHolds: {},
            continuousOperation: { ...state.continuousOperation, runtimeId: config.runtimeId } })) fail();
    previousManifest(config, incident);
    const row = state.completed.at(-1), order = row?.orders?.[0], redeem = incident.redeem;
    if (!record(redeem) || !TX.test(redeem.hash) || !TX.test(redeem.blockHash) || !timestamp(redeem.blockNumber)
        || !row?.traded || row.closedAt < state.stopped.at || !TX.test(row.conditionId)
        || row.orders?.length !== 1 || !TX.test(order.orderId) || order.side !== 'BUY' || order.status !== 'complete'
        || ![0, 1].includes(order.index) || order.tokenId !== row.tokens[order.index]
        || !(order.settled > 0) || !sameAmount(order.filled, order.settled)
        || !isDeepStrictEqual(row.payout, order.index === 0 ? [1, 0] : [0, 1])
        || row.gas !== 0 || row.rebate !== 0 || !sameAmount(row.pnl, order.settled - row.entryCost)
        || state.completed.some(completed => completed.actions?.some(action =>
            !['confirmed', 'failed'].includes(action.status)))) fail();
    const evidence = state.settlementEvidence?.[redeem.hash], amounts = [0, 0];
    amounts[order.index] = -order.settled;
    if (!evidence || evidence.kind !== 'protocol_auto_redeem' || evidence.source !== 'receipt'
        || evidence.hash !== redeem.hash || evidence.blockNumber !== redeem.blockNumber
        || evidence.blockHash !== redeem.blockHash || evidence.conditionId !== row.conditionId
        || evidence.fees !== 0 || !sameAmount(evidence.cash, order.settled)
        || !isDeepStrictEqual(evidence.holdings, amounts)) fail();
    return { incident, row, evidence };
}

// The caller holds the pilot lock. Preparation only reads; it never prepares
// a replacement transaction or infers write absence from completed actions.
export async function prepareActionGasRecovery(config, state, client, providers) {
    const { incident, row, evidence } = candidate(config, state), beforeSha256 = digest(state);
    const approvalSha256 = digest(config.runtimeContinuation);
    const guard = () => {
        if (digest(state) !== beforeSha256 || digest(config.runtimeContinuation) !== approvalSha256) fail();
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
    const receipt = await client.verifiedReceipt(incident.redeem.hash, proof.blockNumber);
    guard();
    const payout = await client.payoutAtBlock(row.conditionId, proof.blockNumber);
    guard();
    if (!receipt || receipt.transactionHash?.toLowerCase() !== incident.redeem.hash
        || receipt.blockNumber !== incident.redeem.blockNumber || receipt.blockHash?.toLowerCase() !== incident.redeem.blockHash
        || receipt.transactionIndex !== evidence.transactionIndex || !isDeepStrictEqual(payout, row.payout)) fail();
    const position = { market: { tokens: row.tokens, conditionId: row.conditionId, negRisk: false },
        holdings: evidence.holdings.map(amount => amount === 0 ? 0 : -amount), receipts: {}, actions: [],
        orders: [{ ...row.orders[0], kind: 'taker' }] };
    const redemption = verifyAutoRedeemReceipt({ position, wallet: config.settings.wallet,
        block: proof.blockNumber, payout, receipt });
    if (!redemption || !sameAmount(redemption.cash, evidence.cash)
        || !isDeepStrictEqual(redemption.holdings, evidence.holdings)) fail();
    const latest = await client.ordersAndTrades();
    guard();
    if (!record(latest) || !Array.isArray(latest.orders)) fail();
    trades = await assertPeriodAccountReady({ ...checked.account, openOrders: latest.orders,
        checks: [{ name: 'authenticated_order_trade_api', detail: { trades: latest.trades } }] },
    { client, wallet: config.settings.wallet, proof });
    guard();
    const expected = expectedWalletBalance(state);
    if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
        || !Number.isFinite(checked.account.wallet?.balance) || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
        || client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
    history();
    const recoveredAt = Date.now(), nextState = structuredClone(state);
    nextState.stopHistory ||= [];
    nextState.stopHistory.push({ ...state.stopped, recoveredAt, runtimeId: config.runtimeId, reasonVerified: reason,
        beforeSha256, originalHold: structuredClone(incident.hold), previousRuntimeId: incident.previousRuntimeId,
        previousManifestSha256: incident.previousManifestSha256,
        evidence: [incident.redeem.hash], redemption,
        walletProof: { ...proof, expectedBalance: expected, trades, holdings } });
    nextState.stopped = null;
    delete nextState.entryHolds.maintenance_unknown;
    nextState.continuousOperationHistory ||= [];
    nextState.continuousOperationHistory.push({ ...state.continuousOperation, migratedAt: recoveredAt,
        nextRuntimeId: config.runtimeId, previousManifestSha256: incident.previousManifestSha256,
        reasonVerified: reason, beforeSha256 });
    nextState.continuousOperation.runtimeId = config.runtimeId;
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        previousRuntimeId: incident.previousRuntimeId, stop: structuredClone(state.stopped),
        blockNumber: proof.blockNumber, blockHash: proof.blockHash,
        walletPUSD: proof.balance, expectedWalletPUSD: expected, cash: state.cash,
        peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown, completedMarkets: state.completed.length,
        accountingPreserved: true, financialWrites: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { state, beforeSha256, nextSha256: digest(nextState), summarySha256: digest(summary), history });
    return review;
}

export function applyActionGasRecovery(store, review, { explicitApply = false } = {}) {
    const prepared = reviews.get(review);
    if (!explicitApply || !prepared || store.state !== prepared.state || review.summary?.ready !== true
        || review.beforeSha256 !== prepared.beforeSha256 || digest(store.state) !== prepared.beforeSha256
        || digest(review.nextState) !== prepared.nextSha256 || digest(review.summary) !== prepared.summarySha256) fail();
    prepared.history();
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
