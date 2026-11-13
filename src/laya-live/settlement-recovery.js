import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS, riskReason, round } from '../restart/math.js';
import { expectedWalletBalance } from './recovery.js';
import { signedBuyOrderBounds, verifyAutoRedeemReceipt, verifyOwnedFillReceipt } from './settlement.js';

export const evidenceHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hash = value => /^0x[\da-f]{64}$/i.test(value || '');
const sameAmount = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < EPS;
const improvedReason = 'reviewed_fak_price_improvement_and_protocol_auto_redeem';
const improvementStopAt = 1792208316559;
const rawAmount = value => {
    const scaled = value * 1e6, rounded = Math.round(scaled);
    if (!Number.isFinite(value) || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .00001)
        throw new Error('invalid_reviewed_amount');
    return BigInt(rounded);
};
const exactAmount = (a, b) => {
    try { return rawAmount(a) === rawAmount(b); } catch { return false; }
};

// Replay and production account the same receipts at different times. Keep
// every original execution field; omit only values produced by accounting.
export function incidentEvidenceHash(row) {
    const copy = structuredClone(row);
    delete copy.closedAt; delete copy.capitalHours;
    if (Array.isArray(copy.fills)) for (const fill of copy.fills) delete fill.settledAt;
    return evidenceHash(copy);
}

export const operationalFailureHash = state => evidenceHash({
    errors: state.operational?.errors || {}, applicationErrors: state.operational?.applicationErrors || {},
    circuitsOpened: state.operational?.circuitsOpened || 0, reconciliationFaults: state.reconciliationFaults || {},
});
const aiHistoryHash = state => evidenceHash({ slots: state.ai?.slots, snapshots: state.ai?.snapshots });
const fillTradeIds = row => [...new Set(row.fills.flatMap(fill => [fill.tradeId, ...(fill.tradeIds || [])]).filter(Boolean))].sort();
const reviewedSignedAmounts = a => ({ makerAmount: a.signedMakerAmount, takerAmount: a.signedTakerAmount,
    principalBefore: '0', principalAfter: String(rawAmount(a.principal)), feeBefore: '0', feeAfter: String(rawAmount(a.fee)),
    quantityBefore: '0', quantityAfter: String(rawAmount(a.actualShares)),
    remainingPrincipal: String(BigInt(a.signedMakerAmount) - rawAmount(a.principal)) });

function improvedSettlementCandidate(config, state, now) {
    try {
        const a = config.continuation?.settlementRecovery;
        if (!a || a.reason !== improvedReason || a.stop?.reason !== 'invalid_owned_trade' || a.stop.at !== improvementStopAt
            || !isDeepStrictEqual(state.stopped, a.stop) || state.position || state.baseline !== config.id
            || state.mode !== 'pilot' || state.decisionProvider !== 'laya' || state.startedAt !== a.startedAt
            || !Number.isFinite(now) || now < a.stop.at || !Number.isSafeInteger(a.startedAt) || a.startedAt >= a.stop.at
            || a.uncertaintyReason !== 'invalid_owned_trade' || a.uncertaintyBefore !== false
            || !Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
            || !Number.isFinite(a.peakEquityBefore) || !Number.isFinite(a.maxDrawdownBefore)
            || !exactAmount(state.maxDrawdown, a.maxDrawdownBefore)
            || !exactAmount(state.peakEquity, Math.max(a.peakEquityBefore, a.startingCash + a.profit))
            || state.maxDrawdown >= config.settings.drawdownStop - EPS
            || riskReason(structuredClone(state), config.settings, now, state.cash)
            || Object.values(state.ai?.providers || {}).some(p => p.pending || p.disabled || p.unavailable)
            || evidenceHash(state.externalWalletActivity) !== a.externalSha256
            || !exactAmount(state.externalWalletActivity?.cashDelta, -1.447987)
            || evidenceHash(state.liveFunding) !== a.fundingSha256 || evidenceHash(state.seen) !== a.seenSha256
            || evidenceHash(state.stopHistory) !== a.stopHistorySha256 || aiHistoryHash(state) !== a.aiHistorySha256
            || operationalFailureHash(state) !== a.operationalSha256 || state.failures !== a.failuresBefore
            || state.dataGaps !== a.dataGapsBefore || !Number.isSafeInteger(a.failuresBefore) || a.failuresBefore < 0
            || !Number.isSafeInteger(a.dataGapsBefore) || a.dataGapsBefore < 0
            || !exactAmount(state.walletStart, a.walletStart)
            || !exactAmount(state.walletCashDelta, round(a.walletCashDeltaBefore + a.profit))
            || !exactAmount(state.cash, round(a.startingCash + a.profit))
            || !hash(a.fillHash) || !hash(a.redeemHash) || a.fillHash === a.redeemHash || !hash(a.orderId) || !hash(a.conditionId)
            || a.shares !== 5 || ![0, 1].includes(a.index) || !Array.isArray(a.tokens) || a.tokens.length !== 2
            || a.tokens.some(token => typeof token !== 'string' || !/^\d+$/.test(token)) || a.tokens[0] === a.tokens[1]
            || !isDeepStrictEqual(a.payout, a.index === 0 ? [1, 0] : [0, 1])
            || !Array.isArray(a.tradeIds) || !a.tradeIds.length || a.tradeIds.some(id => typeof id !== 'string' || !id)
            || new Set(a.tradeIds).size !== a.tradeIds.length
            || !(a.actualShares > a.shares) || !(a.principal > 0) || !(a.fee >= 0) || !(a.reserve > 0 && a.reserve <= 5)
            || !exactAmount(a.entryCost, round(a.principal + a.fee)) || a.entryCost > a.reserve || a.entryCost > 5
            || !exactAmount(a.profit, round(a.actualShares - a.entryCost)) || a.profit <= 0
            || !exactAmount(state.seen?.[a.slug]?.cost, a.reserve)) return false;
        const rows = state.completed;
        if (!Array.isArray(rows) || !rows.length || evidenceHash(rows.slice(0, -1)) !== a.completedBeforeSha256) return false;
        const row = rows.at(-1), order = row.orders?.[0];
        if (incidentEvidenceHash(row) !== a.completedIncidentSha256 || row.uncertain !== true || !row.traded
            || row.slug !== a.slug || row.conditionId !== a.conditionId || !isDeepStrictEqual(row.tokens, a.tokens)
            || !isDeepStrictEqual(row.payout, a.payout) || !exactAmount(row.pnl, a.profit) || !exactAmount(row.fees, a.fee)
            || !exactAmount(row.entryCost, a.entryCost) || row.gas !== 0 || row.rebate !== 0
            || row.orders?.length !== 1 || order.orderId !== a.orderId || order.index !== a.index
            || order.tokenId !== a.tokens[a.index] || order.side !== 'BUY' || !['complete', 'cancelled'].includes(order.status)
            || !exactAmount(order.price, a.limitPrice) || order.shares !== a.shares
            || !exactAmount(order.filled, a.actualShares) || !exactAmount(order.settled, a.actualShares)
            || !row.fills?.length || row.fills.some(fill => fill.hash !== a.fillHash || fill.orderId !== a.orderId
                || fill.source !== 'receipt' || !Number.isFinite(fill.price) || fill.price <= 0 || fill.price > a.limitPrice)
            || !exactAmount(row.fills.reduce((sum, fill) => sum + fill.shares, 0), a.actualShares)
            || !exactAmount(round(row.fills.reduce((sum, fill) => sum + fill.shares * fill.price, 0)), a.principal)
            || !isDeepStrictEqual(fillTradeIds(row), [...a.tradeIds].sort())) return false;
        const original = { ...order, kind: 'taker', signed: a.signedOrderEvidence };
        const bounds = signedBuyOrderBounds(original, config.settings.wallet);
        if (!bounds || String(bounds.makerAmount) !== a.signedMakerAmount || String(bounds.takerAmount) !== a.signedTakerAmount
            || rawAmount(a.principal) > bounds.makerAmount
            || rawAmount(a.principal) * bounds.takerAmount >= rawAmount(a.actualShares) * bounds.makerAmount) return false;
        const fill = state.settlementEvidence?.[a.fillHash], redeem = state.settlementEvidence?.[a.redeemHash];
        const tokens = [0, 0]; tokens[a.index] = a.actualShares;
        if (!fill || !redeem || fill.kind !== 'fill' || redeem.kind !== 'protocol_auto_redeem'
            || fill.orderId !== a.orderId || !exactAmount(fill.cash, -a.entryCost) || !exactAmount(fill.fees, a.fee)
            || !exactAmount(fill.principal, a.principal) || fill.requestedShares !== a.shares
            || !exactAmount(fill.shares, a.actualShares) || !isDeepStrictEqual(fill.signedAmounts, reviewedSignedAmounts(a))
            || !exactAmount(redeem.cash, a.actualShares) || !isDeepStrictEqual(fill.holdings, tokens)
            || !isDeepStrictEqual(redeem.holdings, tokens.map(value => value ? -value : 0))) return false;
        for (const [proof, prefix] of [[fill, 'fill'], [redeem, 'redeem']]) {
            if (proof.source !== 'receipt' || proof.hash !== a[`${prefix}Hash`] || proof.conditionId !== a.conditionId
                || !hash(proof.blockHash) || proof.blockHash !== a[`${prefix}BlockHash`]
                || !Number.isSafeInteger(proof.blockNumber) || proof.blockNumber !== a[`${prefix}BlockNumber`]) return false;
        }
        return fill.blockNumber < redeem.blockNumber && Number.isFinite(expectedWalletBalance(state));
    } catch { return false; }
}

// This is a reviewed software-incident continuation, never a generic reset.
// The approval is bound to the complete runtime by bindContinuation. Receipts
// must already have been accounted by the broker and inventory must be flat.
export function settlementStopCandidate(config, state, now) {
    try {
        const a = config.continuation?.settlementRecovery;
        if (a?.reason === improvedReason) return improvedSettlementCandidate(config, state, now);
        if (!a || a.reason !== 'reviewed_sdk_fill_and_protocol_auto_redeem'
            || a.stop?.reason !== 'wallet_ledger_mismatch' || !isDeepStrictEqual(state.stopped, a.stop)
            || state.position || state.baseline !== config.id || state.mode !== 'pilot' || state.decisionProvider !== 'laya'
            || state.startedAt !== a.startedAt || !Number.isFinite(now) || now < a.stop.at
            || !Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
            || !Number.isFinite(a.peakEquityBefore) || !Number.isFinite(a.maxDrawdownBefore)
            || !sameAmount(state.maxDrawdown, a.maxDrawdownBefore)
            || !sameAmount(state.peakEquity, Math.max(a.peakEquityBefore, a.startingCash + a.profit))
            || state.maxDrawdown >= config.settings.drawdownStop - EPS
            || riskReason(structuredClone(state), config.settings, now, state.cash)
            || Object.values(state.ai?.providers || {}).some(p => p.pending || p.disabled || p.unavailable)
            || evidenceHash(state.externalWalletActivity) !== a.externalSha256
            || evidenceHash(state.liveFunding) !== a.fundingSha256 || evidenceHash(state.seen) !== a.seenSha256
            || !sameAmount(state.walletStart, a.walletStart)
            || !sameAmount(state.walletCashDelta, round(a.walletCashDeltaBefore + a.profit))
            || !sameAmount(state.cash, round(a.startingCash + a.profit))
            || !hash(a.fillHash) || !hash(a.redeemHash) || a.fillHash === a.redeemHash
            || !hash(a.conditionId) || !hash(a.orderId) || ![0, 1].includes(a.index) || a.shares !== 5
            || !Array.isArray(a.tokens) || a.tokens.length !== 2 || a.tokens[0] === a.tokens[1]
            || !isDeepStrictEqual(a.payout, a.index === 0 ? [1, 0] : [0, 1])
            || !sameAmount(a.profit, round(a.shares - a.entryCost)) || a.profit <= 0 || a.entryCost > 5)
            return false;
        const rows = state.completed;
        if (!Array.isArray(rows) || !rows.length || evidenceHash(rows.slice(0, -1)) !== a.completedBeforeSha256) return false;
        const row = rows.at(-1), order = row.orders?.[0];
        if (row.slug !== a.slug || row.conditionId !== a.conditionId || !row.traded || row.uncertain
            || !isDeepStrictEqual(row.tokens, a.tokens) || !isDeepStrictEqual(row.payout, a.payout)
            || !sameAmount(row.pnl, a.profit) || !sameAmount(row.fees, a.fee)
            || !sameAmount(row.entryCost, a.entryCost) || row.gas !== 0 || row.rebate !== 0
            || row.orders?.length !== 1 || order.orderId !== a.orderId || order.index !== a.index
            || order.tokenId !== a.tokens[a.index] || order.side !== 'BUY' || order.status !== 'complete'
            || !sameAmount(order.price, a.limitPrice) || order.shares !== a.shares
            || order.filled !== a.shares || order.settled !== a.shares
            || !row.fills?.length || row.fills.some(fill => fill.hash !== a.fillHash || fill.orderId !== a.orderId)
            || !sameAmount(row.fills.reduce((sum, fill) => sum + fill.shares, 0), a.shares)) return false;
        const fill = state.settlementEvidence?.[a.fillHash], redeem = state.settlementEvidence?.[a.redeemHash];
        const tokens = [0, 0]; tokens[a.index] = a.shares;
        if (!fill || !redeem || fill.kind !== 'fill' || redeem.kind !== 'protocol_auto_redeem'
            || fill.orderId !== a.orderId || !sameAmount(fill.cash, -a.entryCost) || !sameAmount(fill.fees, a.fee)
            || !sameAmount(redeem.cash, a.shares) || !isDeepStrictEqual(fill.holdings, tokens)
            || !isDeepStrictEqual(redeem.holdings, tokens.map(value => value ? -value : 0))) return false;
        for (const [proof, prefix] of [[fill, 'fill'], [redeem, 'redeem']]) {
            if (proof.source !== 'receipt' || proof.hash !== a[`${prefix}Hash`] || proof.conditionId !== a.conditionId
                || !hash(proof.blockHash) || proof.blockHash !== a[`${prefix}BlockHash`]
                || !Number.isSafeInteger(proof.blockNumber) || proof.blockNumber !== a[`${prefix}BlockNumber`]) return false;
        }
        return fill.blockNumber < redeem.blockNumber && Number.isFinite(expectedWalletBalance(state));
    } catch { return false; }
}

function freshImprovedProofs(config, state, a, block, fill, redeem, account, payout) {
    try {
        if (!isDeepStrictEqual(payout, a.payout) || !Array.isArray(account.orders) || account.orders.length
            || !Array.isArray(account.trades) || account.trades.length !== a.tradeIds.length) return false;
        const ids = new Set();
        let quantity = 0, principal = 0;
        for (const trade of account.trades) {
            if (!a.tradeIds.includes(trade.id) || ids.has(trade.id) || trade.traderSide !== 'TAKER' || trade.side !== 'BUY'
                || trade.takerOrderId?.toLowerCase() !== a.orderId || trade.conditionId?.toLowerCase() !== a.conditionId
                || trade.assetId !== a.tokens[a.index] || trade.transactionHash?.toLowerCase() !== a.fillHash
                || String(trade.status).replace(/^TRADE_STATUS_/, '').toUpperCase() !== 'CONFIRMED') return false;
            const size = Number(trade.size), price = Number(trade.price);
            if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0 || price > a.limitPrice) return false;
            rawAmount(size); quantity += size; principal += size * price; ids.add(trade.id);
        }
        if (!exactAmount(round(quantity), a.actualShares) || !exactAmount(round(principal), a.principal)) return false;
        const row = state.completed.at(-1);
        const position = { market: { tokens: a.tokens, conditionId: a.conditionId, negRisk: false },
            holdings: [0, 0], entryCost: 0, fees: 0, receipts: {}, actions: [],
            orders: [{ ...row.orders[0], kind: 'taker', signed: structuredClone(a.signedOrderEvidence),
                settled: 0, filled: 0, cost: a.reserve, transactions: [a.fillHash] }] };
        const fillProof = verifyOwnedFillReceipt({ position, wallet: config.settings.wallet, block, receipt: fill });
        if (!fillProof || !exactAmount(fillProof.cash, -a.entryCost) || !exactAmount(fillProof.fees, a.fee)
            || !exactAmount(-fillProof.notional, a.principal) || fillProof.parts.length !== 1
            || !exactAmount(fillProof.parts[0].shares, a.actualShares)
            || !isDeepStrictEqual(fillProof.parts[0].signedAmounts, reviewedSignedAmounts(a))) return false;
        position.holdings = fillProof.holdings; position.entryCost = a.entryCost; position.fees = a.fee;
        position.orders[0].settled = a.actualShares; position.receipts[a.fillHash] = fillProof;
        const redeemProof = verifyAutoRedeemReceipt({ position, wallet: config.settings.wallet, block, payout, receipt: redeem });
        return !!redeemProof && exactAmount(redeemProof.cash, a.actualShares)
            && isDeepStrictEqual(redeemProof.holdings, fillProof.holdings.map(value => value ? -value : 0));
    } catch { return false; }
}

async function recoverImprovedSettlementStop(store, config, client, providers, clock) {
    const a = config.continuation.settlementRecovery, before = store.state;
    const block = await client.confirmedBlock();
    const [balance, holdings, account, health, fill, redeem, payout, globalAccount] = await Promise.all([
        client.balance(block), client.holdings(a.tokens, block),
        client.ordersAndTrades({ conditionId: a.conditionId, tokens: a.tokens }), providers.preflight(),
        client.verifiedReceipt(a.fillHash, block), client.verifiedReceipt(a.redeemHash, block),
        client.payoutAtBlock(a.conditionId, block),
        client.ordersAndTrades(),
    ]);
    if (!exactAmount(balance, expectedWalletBalance(store.state)) || !Array.isArray(holdings) || holdings.length !== 2
        || holdings.some(value => !exactAmount(value, 0)) || !health.laya?.ready
        || health.laya?.pending || health.laya?.disabled || health.laya?.unavailable
        || !Array.isArray(globalAccount?.orders) || globalAccount.orders.length) return false;
    for (const [receipt, prefix] of [[fill, 'fill'], [redeem, 'redeem']]) {
        if (!receipt || receipt.status !== 1 || receipt.confirmations < 2 || receipt.blockNumber > block
            || receipt.transactionHash?.toLowerCase() !== a[`${prefix}Hash`]
            || receipt.blockHash?.toLowerCase() !== a[`${prefix}BlockHash`]
            || receipt.blockNumber !== a[`${prefix}BlockNumber`]) return false;
    }
    if (!freshImprovedProofs(config, store.state, a, block, fill, redeem, account, payout)) return false;
    const recoveredAt = clock();
    if (store.state !== before || !improvedSettlementCandidate(config, store.state, recoveredAt)) return false;
    const previous = store.state.stopped, row = store.state.completed.at(-1), originalRow = structuredClone(row);
    store.state.stopHistory ||= [];
    store.state.stopHistory.push({ ...previous, recoveredAt, runtimeId: config.runtimeId,
        evidence: [a.fillHash, a.redeemHash], reasonVerified: a.reason,
        uncertaintyReview: { previousUncertain: true, reviewedReason: a.uncertaintyReason,
            originalRowEvidenceHash: a.completedIncidentSha256, originalRow } });
    row.uncertain = false;
    store.state.stopped = null;
    store.event('settlement_accounting_stop_recovered', { previous, runtimeId: config.runtimeId,
        block, fillHash: a.fillHash, redeemHash: a.redeemHash, cashProfit: a.profit,
        requestedShares: a.shares, actualShares: a.actualShares, uncertaintyReviewed: a.uncertaintyReason });
    return true;
}

export async function recoverSettlementStop(store, config, client, providers, { explicitLive = false, clock = Date.now } = {}) {
    if (!explicitLive || !settlementStopCandidate(config, store.state, clock())) return false;
    if (config.continuation.settlementRecovery.reason === improvedReason)
        return recoverImprovedSettlementStop(store, config, client, providers, clock);
    const a = config.continuation.settlementRecovery;
    const block = await client.confirmedBlock();
    const [balance, holdings, account, health, fill, redeem] = await Promise.all([
        client.balance(block), client.holdings(a.tokens, block),
        client.ordersAndTrades({ conditionId: a.conditionId, tokens: a.tokens }), providers.preflight(),
        client.verifiedReceipt(a.fillHash, block), client.verifiedReceipt(a.redeemHash, block),
    ]);
    if (!sameAmount(balance, expectedWalletBalance(store.state)) || holdings.length !== 2
        || holdings.some(h => !sameAmount(h, 0)) || account.orders.length || !health.laya?.ready) return false;
    for (const [receipt, prefix] of [[fill, 'fill'], [redeem, 'redeem']]) {
        if (!receipt || receipt.status !== 1 || receipt.confirmations < 2 || receipt.blockNumber > block
            || receipt.transactionHash?.toLowerCase() !== a[`${prefix}Hash`]
            || receipt.blockHash?.toLowerCase() !== a[`${prefix}BlockHash`]
            || receipt.blockNumber !== a[`${prefix}BlockNumber`]) return false;
    }
    // The await above may cross a deadline or receive a provider-disable event.
    if (!settlementStopCandidate(config, store.state, clock())) return false;
    const previous = store.state.stopped;
    store.state.stopHistory ||= [];
    store.state.stopHistory.push({ ...previous, recoveredAt: clock(), runtimeId: config.runtimeId,
        evidence: [a.fillHash, a.redeemHash], reasonVerified: a.reason });
    store.state.stopped = null;
    store.event('settlement_accounting_stop_recovered', { previous, runtimeId: config.runtimeId,
        block, fillHash: a.fillHash, redeemHash: a.redeemHash, cashProfit: a.profit });
    return true;
}
