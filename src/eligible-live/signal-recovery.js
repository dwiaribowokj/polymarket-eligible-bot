import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value == null || record(value) && Object.keys(value).length === 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('eligible_signal_recovery_unproven'); };
const reviews = new WeakMap();

function candidate(config, state) {
    const approval = config.runtimeContinuation, incident = approval?.incident;
    const key = incident?.slotKey, match = typeof key === 'string' && /^btc-updown-5m-(\d+):(90|60|30)$/.exec(key);
    const slot = state?.ai?.slots?.[key];
    if (!approval || approval.reason !== 'pre_entry_signal_repair' || incident?.reason !== 'btc_twap_source_mismatch'
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || !ID.test(approval.originalRuntimeId) || config.riskRuntimeId !== approval.originalRuntimeId
        || approval.originalRuntimeId === config.runtimeId || approval.periodId !== config.id
        || config.riskPeriod?.periodId !== config.id || config.riskPeriod.runtimeId !== approval.originalRuntimeId
        || state?.baseline !== config.id || state.mode !== 'pilot' || state.strategy !== 'late-entry'
        || state.decisionProvider !== 'eligible' || config.policy?.provider !== 'eligible'
        || state.startedAt !== approval.ledgerStartedAt || !record(state.liveFunding)
        || digest(state.liveFunding) !== approval.fundingSha256
        || !isDeepStrictEqual(state.stopped, incident.stop) || state.stopped?.reason !== 'operational_check_failed'
        || !Number.isSafeInteger(state.stopped.at) || state.stopped.at < state.startedAt
        || state.position != null || state.liveRiskStop != null || state.frozenAt != null
        || !Number.isFinite(state.cash) || state.cash <= EPS || !Number.isFinite(state.peakEquity)
        || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
        || config.settings.entryCap !== 5 || config.settings.drawdownStop !== 10
        || state.maxDrawdown >= 10 - EPS || state.peakEquity - state.cash >= 10 - EPS
        || !empty(state.entryHolds) || !empty(state.reconciliationFaults)
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || state.liveClock?.status === 'failed' || !record(state.seen) || !record(state.ai)
        || !record(state.ai.providers) || Object.entries(state.ai.providers).some(([name, provider]) =>
            name !== 'eligible' || !record(provider) || provider.pending || provider.disabled)
        || !Array.isArray(state.ai.snapshots) || !Array.isArray(state.completed)
        || state.completed.some(row => !record(row) || row.uncertain || row.pendingTrades
            || !Number.isFinite(row.closedAt) || row.closedAt > state.stopped.at
            || !Array.isArray(row.tokens) || row.tokens.length !== 2 || row.tokens[0] === row.tokens[1]
            || row.tokens.some(token => typeof token !== 'string' || !/^[1-9]\d*$/.test(token)))
        || !match || !record(slot) || slot.status !== 'invalid' || slot.snapshotId !== undefined
        || !Number.isSafeInteger(slot.at) || slot.at > state.stopped.at
        || slot.at < state.startedAt || state.seen[key.slice(0, key.lastIndexOf(':'))]
        || (Number(match[1]) + 300) * 1000 > Date.now()
        || ![incident.slotSha256, incident.completedSha256, incident.seenSha256, incident.aiSha256].every(hash => HASH.test(hash))
        || digest(slot) !== incident.slotSha256 || digest(state.completed) !== incident.completedSha256
        || digest(state.seen) !== incident.seenSha256 || digest(state.ai) !== incident.aiSha256
        || state.stopHistory != null && (!Array.isArray(state.stopHistory) || state.stopHistory.some(stop =>
            stop?.at === incident.stop.at && stop.reason === incident.stop.reason))) fail();
    return incident;
}

// The offline caller holds the shared pilot lock when applying. Preparation
// uses only account reads and leaves the original stop and accounting intact.
export async function prepareSignalRecovery(config, state, client, providers) {
    const incident = candidate(config, state), beforeSha256 = digest(state);
    const history = eligibleHistory(config);
    const own = history.find(ledger => ledger.baseline === config.id && ledger.strategy === 'late-entry');
    if (!isDeepStrictEqual(own, state)) fail();
    const checked = await eligiblePreflight(config, client, providers, state, { history });
    if (checked.output.operationalReady !== true || checked.output.readyForLive !== false
        || checked.output.startAllowed !== false || checked.output.recoveryOnly !== false
        || !isDeepStrictEqual(checked.output.blockers, ['persistent_pilot_stop'])) fail();
    const proof = await readPeriodWalletProof(config, client);
    const trades = await assertPeriodAccountReady(checked.account, { client, wallet: config.settings.wallet, proof });
    const holdings = await Promise.all(state.completed.map(async row => {
        const amounts = await client.holdings(row.tokens, proof.blockNumber);
        if (!Array.isArray(amounts) || amounts.length !== 2 || amounts.some(amount => amount !== 0)) fail();
        return { conditionId: row.conditionId, tokens: [...row.tokens], amounts };
    }));
    const expected = expectedWalletBalance(state);
    if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
        || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
        || client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash
        || digest(state) !== beforeSha256
        || !isDeepStrictEqual(eligibleHistory(config).find(ledger => ledger.baseline === config.id
            && ledger.strategy === 'late-entry'), state)) fail();
    candidate(config, state);
    const recoveredAt = Date.now(), nextState = structuredClone(state);
    nextState.stopHistory ||= [];
    nextState.stopHistory.push({ ...state.stopped, recoveredAt, runtimeId: config.runtimeId,
        reasonVerified: incident.reason, slotKey: incident.slotKey, slotSha256: incident.slotSha256,
        completedSha256: incident.completedSha256, seenSha256: incident.seenSha256, aiSha256: incident.aiSha256,
        beforeSha256, blockNumber: proof.blockNumber, blockHash: proof.blockHash,
        walletProof: { ...proof, expectedBalance: expected, trades, holdings } });
    nextState.stopped = null;
    const summary = { ready: true, reason: incident.reason, periodId: config.id, runtimeId: config.runtimeId,
        stop: structuredClone(state.stopped), slotKey: incident.slotKey,
        blockNumber: proof.blockNumber, blockHash: proof.blockHash, walletPUSD: proof.balance,
        expectedWalletPUSD: expected, cash: state.cash, peakEquity: state.peakEquity,
        maxDrawdown: state.maxDrawdown, completedMarkets: state.completed.length,
        accountingPreserved: true, financialWrites: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { beforeSha256, nextSha256: digest(nextState), summarySha256: digest(summary) });
    return review;
}

export function applySignalRecovery(store, review, { explicitApply = false } = {}) {
    const prepared = reviews.get(review);
    if (!explicitApply || !prepared || review.summary?.ready !== true
        || review.beforeSha256 !== prepared.beforeSha256
        || digest(store.state) !== review.beforeSha256 || digest(review.nextState) !== prepared.nextSha256
        || digest(review.summary) !== prepared.summarySha256
        || !isDeepStrictEqual(store.state.ai, review.nextState.ai)) fail();
    const previous = { stopped: store.state.stopped, stopHistory: store.state.stopHistory };
    const hadHistory = Object.hasOwn(store.state, 'stopHistory');
    store.state.stopped = null;
    store.state.stopHistory = structuredClone(review.nextState.stopHistory);
    try { store.save(); }
    catch (error) {
        store.state.stopped = previous.stopped;
        if (hadHistory) store.state.stopHistory = previous.stopHistory;
        else delete store.state.stopHistory;
        throw error;
    }
    reviews.delete(review);
    return review.summary;
}
