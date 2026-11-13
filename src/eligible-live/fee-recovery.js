import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LayaLiveBroker } from '../laya-live/broker.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { signedBuyOrderBounds, verifyOwnedFillReceipt } from '../laya-live/settlement.js';
import { riskReason, round } from '../restart/math.js';
import { reconcilePeriodTrades } from './period-trades.js';

const HASH = /^0x[\da-f]{64}$/i;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const fail = () => { throw new Error('eligible_fee_recovery_unproven'); };
const empty = value => value == null || typeof value === 'object' && Object.keys(value).length === 0;
const units = value => {
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 1e6))
        || Math.abs(value * 1e6 - Math.round(value * 1e6)) > .00001) fail();
    return BigInt(Math.round(value * 1e6));
};
export const feeOrderIdentity = order => Object.fromEntries([
    'orderId', 'tokenId', 'index', 'side', 'kind', 'shares', 'price', 'cost', 'signed', 'submittedAt',
].map(key => [key, order[key]]));

export function matchesFeeRecoveryIncident(config, state) {
    const incident = config.runtimeContinuation?.incident;
    return incident?.reason === 'verified_fill_fee_above_estimate' && config.runtimeContinuation.periodId === config.id
        && state?.baseline === config.id && !!state.stopped
        && isDeepStrictEqual(state.stopped, incident.stop)
        && !state.stopHistory?.some(stop => stop.at === incident.stop.at
            && stop.reason === incident.stop.reason && stop.reasonVerified === incident.reason);
}

function candidate(config, state) {
    const approval = config.runtimeContinuation, incident = approval?.incident;
    const p = state?.position, order = p?.orders?.[0];
    if (!matchesFeeRecoveryIncident(config, state) || incident.reason !== 'verified_fill_fee_above_estimate'
        || approval.periodId !== config.id || state.baseline !== config.id
        || state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.decisionProvider !== 'eligible'
        || state.liveRiskStop || !isDeepStrictEqual(state.stopped, incident.stop)
        || state.stopped?.reason !== 'trade_receipt_mapping_mismatch'
        || !Number.isSafeInteger(state.stopped.at) || !Number.isFinite(state.maxDrawdown)
        || state.maxDrawdown >= config.settings.drawdownStop || !Number.isFinite(state.peakEquity)
        || config.settings.entryCap !== 5 || config.settings.drawdownStop !== 10
        || !empty(state.entryHolds) || state.profitTaking?.pending || state.profitTakingControl?.operation
        || digest(state.completed) !== incident.completedSha256 || digest(state.seen) !== incident.seenSha256
        || !p || p.orders.length !== 1 || p.actions?.length !== 0 || p.fills?.length !== 0
        || !empty(p.receipts) || !empty(p.failedTrades) || !empty(p.failedSettlementHashes)
        || p.entryCost !== 0 || p.fees !== 0 || p.gas !== 0 || p.rebate !== 0
        || p.holdings?.length !== 2 || p.holdings.some(value => value !== 0)
        || p.bought?.length !== 2 || p.bought.some(value => value !== 0)
        || p.openedAt !== incident.openedAt || p.market.conditionId !== incident.conditionId
        || p.market.negRisk === true || !Number.isFinite(p.market.end) || p.autoRedeemWait
        || p.pendingTrades !== true || p.uncertain !== true
        || order.orderId !== incident.orderId || order.settled !== 0 || order.receiptProvenComplete
        || digest(feeOrderIdentity(order)) !== incident.orderIdentitySha256
        || order.transactions?.length !== 1 || lower(order.transactions[0]) !== lower(incident.transactionHash)
        || !HASH.test(incident.transactionHash || '') || !HASH.test(incident.receiptBlockHash || '')
        || !Number.isSafeInteger(incident.receiptBlockNumber)
        || Object.keys(state.reconciliationFaults || {}).length !== 1
        || lower(state.reconciliationFaults.trade_receipt_mapping_mismatch?.last?.hash) !== lower(incident.transactionHash)
        || !signedBuyOrderBounds(order, config.settings.wallet)) fail();
    return { incident, p, order };
}

// Preparation is read-only. Replay the normal broker against captured reads
// and a memory store; it cannot sign, submit, redeem, or update the real ledger.
export async function prepareFeeRecovery(config, state, client) {
    const { incident, p, order } = candidate(config, state);
    const beforeSha256 = digest(state), now = Date.now();
    if (now < p.market.end) fail();
    const block = await client.confirmedBlock(), anchor = { ...client.rpc?.anchor };
    if (!Number.isSafeInteger(block) || anchor.number !== block || !HASH.test(anchor.hash || '')) fail();
    const [receipt, account, balance, holdings, payout] = await Promise.all([
        client.verifiedReceipt(incident.transactionHash, block), client.ordersAndTrades(),
        client.balance(block), client.holdings(p.market.tokens, block), client.payoutAtBlock(incident.conditionId, block),
    ]);
    if (digest(state) !== beforeSha256 || !isDeepStrictEqual(client.rpc.anchor, anchor)
        || receipt?.blockNumber !== incident.receiptBlockNumber
        || lower(receipt?.blockHash) !== lower(incident.receiptBlockHash)
        || lower(receipt?.transactionHash) !== lower(incident.transactionHash)
        || !Array.isArray(account?.orders) || account.orders.length || !Array.isArray(account.trades)
        || !Array.isArray(payout) || ![[0, 1], [1, 0]].some(row => isDeepStrictEqual(row, payout))
        || p.payout != null && !isDeepStrictEqual(p.payout, payout)) fail();
    const input = { position: p, wallet: config.settings.wallet, block, receipt };
    const proof = verifyOwnedFillReceipt({ ...input, entryCap: config.settings.entryCap });
    if (!proof || verifyOwnedFillReceipt(input) !== null || proof.parts?.length !== 1
        || -proof.cash <= order.cost || -proof.cash > config.settings.entryCap
        || proof.parts[0].signedAmounts?.remainingPrincipal !== '0'
        || units(balance) !== units(expectedWalletBalance(state)) + units(proof.cash)
        || !isDeepStrictEqual(holdings, proof.holdings)) fail();
    const trades = account.trades.filter(trade => lower(trade.takerOrderId) === lower(order.orderId)
        || trade.makerOrders?.some(maker => lower(maker.orderId) === lower(order.orderId)));
    if (trades.length !== 1) fail();
    await reconcilePeriodTrades(account.trades.filter(trade => !trades.includes(trade)), {
        client, wallet: config.settings.wallet, proof: { blockNumber: block, blockHash: anchor.hash },
    });
    if (!isDeepStrictEqual(client.rpc.anchor, anchor)) fail();
    const trade = trades[0], part = proof.parts[0];
    if (trade.traderSide !== 'TAKER' || trade.side !== 'BUY' || trade.conditionId !== incident.conditionId
        || trade.assetId !== order.tokenId || lower(trade.takerOrderId) !== lower(order.orderId)
        || trade.status?.replace(/^TRADE_STATUS_/, '') !== 'CONFIRMED'
        || lower(trade.transactionHash) !== lower(incident.transactionHash)
        || !trade.id || !isDeepStrictEqual(order.tradeIds, [trade.id])
        || units(Number(trade.size)) !== units(part.shares)
        || Math.abs(Number(trade.price) * part.shares - part.principal) > 1e-6) fail();
    const draft = structuredClone(state), events = [];
    draft.position.receiptRetries = {};
    delete draft.position.accountQueryRetry;
    const memory = { state: draft, save() {}, event(type, detail) { events.push({ type, detail }); },
        stop(reason) { if (!draft.stopped) draft.stopped = { reason, at: now }; } };
    const captured = { confirmedBlock: async () => block,
        ordersAndTrades: async () => ({ orders: [], trades }),
        verifiedReceipt: async hash => { if (lower(hash) !== lower(incident.transactionHash)) fail(); return receipt; },
    };
    const broker = new LayaLiveBroker(config.settings, memory, captured);
    await broker.reconcile(null, now);
    if (!broker.reconciliationComplete || draft.position.pendingTrades !== false
        || draft.position.orders[0].receiptProvenComplete !== true
        || units(draft.position.entryCost) !== units(-proof.cash)
        || units(draft.position.fees) !== units(proof.fees)
        || !isDeepStrictEqual(draft.position.holdings, holdings)
        || units(expectedWalletBalance(draft)) !== units(balance)
        || !isDeepStrictEqual(draft.stopped, incident.stop)
        || !isDeepStrictEqual(draft.reconciliationFaults, state.reconciliationFaults)) fail();
    const value = round(draft.cash + holdings.reduce((sum, amount, index) => sum + amount * payout[index], 0));
    if (draft.cash < 0 || riskReason(draft, config.settings, now, value)
        || draft.maxDrawdown >= config.settings.drawdownStop) fail();
    draft.stopHistory ||= [];
    draft.stopHistory.push({ ...state.stopped, recoveredAt: now, runtimeId: config.runtimeId,
        reasonVerified: incident.reason, evidence: [proof.hash], blockNumber: block, blockHash: anchor.hash,
        originalFault: structuredClone(state.reconciliationFaults.trade_receipt_mapping_mismatch),
        originalUncertain: p.uncertain, estimate: order.cost, actualCost: -proof.cash });
    draft.stopped = null;
    delete draft.reconciliationFaults.trade_receipt_mapping_mismatch;
    draft.position.uncertain = false;
    draft.position.payout = payout;
    draft.position.oneSided = true;
    draft.position.lastDeployed = Math.max(0, draft.position.startingCash - draft.cash);
    const summary = { ready: true, reason: incident.reason, transactionHash: proof.hash,
        blockNumber: block, blockHash: anchor.hash, actualEntryCost: -proof.cash,
        estimatedEntryCost: order.cost, shares: part.shares, fees: proof.fees,
        cash: draft.cash, walletPUSD: balance, payout, payoutValue: round(value - draft.cash),
        maxDrawdown: draft.maxDrawdown, inventoryOpen: holdings.some(value => value > 0),
        financialWrites: false };
    if (digest(state) !== beforeSha256) fail();
    return { summary, nextState: draft, beforeSha256, replayEvents: events };
}

export function applyFeeRecovery(store, review, { explicitLive = false } = {}) {
    if (!explicitLive || review?.summary?.ready !== true || !review.nextState
        || digest(store.state) !== review.beforeSha256) fail();
    // Keep the object identity used by the runner; one save commits the fill,
    // archived incident and stop recovery together, before any financial tick.
    if (!isDeepStrictEqual(store.state.ai, review.nextState.ai)) fail();
    Object.assign(store.state, review.nextState, { ai: store.state.ai });
    store.save();
    store.event('eligible_fee_receipt_recovered', review.summary);
}
