import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { round } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { verifyOwnedFillReceipt, verifyAutoRedeemReceipt, signedBuyOrderBounds } from '../laya-live/settlement.js';
import { assertExternalTradesSettled } from '../laya-live/external-orders.js';
import { eligibleHistory } from './preflight.js';
import { readPeriodWalletProof } from './period.js';

const ID = /^[a-f0-9]{16}$/, HASH = /^[a-f0-9]{64}$/, TX = /^0x[a-f0-9]{64}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const ownedTradeRecoveryDigest = value => hash(JSON.stringify(value));
const digest = ownedTradeRecoveryDigest;
const reason = 'reviewed_owned_trade_rounded_price';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && round(a) === round(b);
const microAmount = value => Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 1e6))
    && Math.abs(value * 1e6 - Math.round(value * 1e6)) <= .00001;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('eligible_owned_trade_recovery_unproven'); };
const reviews = new WeakMap(), proofLifetimeMs = 60000;

export function readOwnedTradeReview(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail();
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail();
    const value = JSON.parse(fs.readFileSync(filename));
    if (!record(value)) fail();
    return value;
}

function candidate(config, state, approval) {
    const continuation = config.runtimeContinuation, p = state.position, order = p?.orders?.[0];
    if (!record(approval) || approval.schema !== 1 || approval.reason !== reason
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || digest({ policy: config.policy, sources: config.sources, profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId
        || approval.periodId !== config.id || continuation?.runtimeId !== config.runtimeId
        || continuation.periodId !== config.id || state.baseline !== config.id
        || state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.decisionProvider !== 'eligible'
        || state.startedAt !== continuation.ledgerStartedAt || digest(state.liveFunding) !== continuation.fundingSha256
        || config.settings.continuousTrading !== true || config.policy.continuousTrading !== true
        || config.policy.provider !== 'eligible' || !ID.test(approval.previousRuntimeId)
        || approval.previousRuntimeId === config.runtimeId || !HASH.test(approval.previousManifestSha256)
        || !HASH.test(approval.stateSha256) || digest(state) !== approval.stateSha256
        || state.stopped?.reason !== 'invalid_owned_trade' || !isDeepStrictEqual(state.stopped, approval.stop)
        || !timestamp(state.stopped.at) || state.stopped.at < state.startedAt
        || state.liveRiskStop != null || state.frozenAt != null
        || state.continuousOperation?.runtimeId !== approval.previousRuntimeId
        || !timestamp(state.continuousOperation.enabledAt)
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || !Array.isArray(state.completed) || state.completed.some(row => row.uncertain || row.pendingTrades)
        || Object.values(state.ai?.providers || {}).some(provider => provider.pending || provider.disabled)
        || ![state.cash, state.walletStart, state.walletCashDelta, state.peakEquity, state.maxDrawdown].every(Number.isFinite)
        || !p || p.uncertain !== true || p.pendingTrades !== false || p.settled !== false
        || p.holdings?.length !== 2 || p.holdings.some(value => value !== 0)
        || p.orders?.length !== 1 || p.actions?.length !== 1
        || p.actions[0].kind !== 'redeem' || p.actions[0].source !== 'protocol_auto'
        || p.actions[0].status !== 'confirmed' || p.actions[0].hash !== approval.redeem?.hash
        || order.status !== 'complete' || order.receiptProvenComplete !== true
        || order.side !== 'BUY' || order.kind !== 'taker' || !TX.test(approval.orderId)
        || order.orderId !== approval.orderId || ![0, 1].includes(order.index)
        || !TX.test(approval.conditionId) || p.market.conditionId !== approval.conditionId
        || p.market.negRisk === true || order.tokenId !== p.market.tokens?.[order.index]
        || !same(order.filled, order.settled) || !(order.settled > order.shares)
        || !isDeepStrictEqual(p.payout, order.index === 0 ? [1, 0] : [0, 1])
        || p.gas !== 0 || p.rebate !== 0 || typeof approval.tradeId !== 'string' || !approval.tradeId) fail();
    const faults = state.reconciliationFaults, holds = state.entryHolds;
    if (!record(faults) || Object.keys(faults).length !== 1 || !faults.invalid_owned_trade
        || faults.invalid_owned_trade.last?.orderId !== approval.orderId
        || faults.invalid_owned_trade.last?.tradeId !== approval.tradeId
        || !record(holds) || Object.keys(holds).some(key => key !== 'external_activity')
        || holds.external_activity && (holds.external_activity.retryable !== true
            || holds.external_activity.error?.code !== 'external_activity_busy')) fail();
    for (const key of ['stopHistory', 'continuousOperationHistory'])
        if (state[key] != null && !Array.isArray(state[key])) fail();
    let directory = config.settings.dataDir;
    if (!path.isAbsolute(directory)) fail();
    for (const part of [config.id, 'eligible-runtime', 'revisions', approval.previousRuntimeId]) {
        directory = path.join(directory, part);
        if (!fs.lstatSync(directory).isDirectory()) fail();
    }
    const file = path.join(directory, 'manifest.json');
    if (!fs.lstatSync(file).isFile()) fail();
    const bytes = fs.readFileSync(file), manifest = JSON.parse(bytes);
    if (hash(bytes) !== approval.previousManifestSha256 || manifest.id !== config.id
        || manifest.runtimeId !== approval.previousRuntimeId || manifest.startedAt !== state.startedAt
        || !isDeepStrictEqual(manifest.policy, config.policy) || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || digest({ policy: manifest.policy, sources: manifest.sources, profitTaking: manifest.profitTaking }).slice(0, 16) !== approval.previousRuntimeId) fail();
    if (Object.keys(p.receipts || {}).length !== 2) fail();
    for (const [key, kind] of [['fill', 'fill'], ['redeem', 'protocol_auto_redeem']]) {
        const pin = approval[key], saved = p.receipts[pin?.hash];
        if (!pin || !TX.test(pin.hash) || !TX.test(pin.blockHash) || !timestamp(pin.blockNumber)
            || !saved || saved.kind !== kind || saved.source !== 'receipt' || saved.hash !== pin.hash
            || saved.blockHash !== pin.blockHash || saved.blockNumber !== pin.blockNumber
            || saved.conditionId !== approval.conditionId
            || !isDeepStrictEqual(saved, state.settlementEvidence?.[pin.hash])) fail();
    }
    if (approval.fill.blockNumber >= approval.redeem.blockNumber) fail();
    return { position: p, order };
}

function verifyTrade(account, approval, position, order, wallet) {
    if (!record(account) || !Array.isArray(account.orders) || account.orders.length
        || !Array.isArray(account.trades) || account.trades.length !== 1) fail();
    const trade = account.trades[0], size = Number(trade.size), price = Number(trade.price);
    const bounds = signedBuyOrderBounds(order, wallet);
    if (!bounds || trade.id !== approval.tradeId || trade.conditionId !== approval.conditionId
        || trade.takerOrderId?.toLowerCase() !== approval.orderId || trade.assetId !== order.tokenId
        || trade.traderSide !== 'TAKER' || trade.side !== 'BUY'
        || String(trade.status).replace(/^TRADE_STATUS_/, '').toUpperCase() !== 'CONFIRMED'
        || trade.transactionHash?.toLowerCase() !== approval.fill.hash || !microAmount(size) || !same(size, order.settled)
        || !microAmount(price) || price <= 0 || price > order.price
        || BigInt(Math.round(price * 1e6)) * bounds.takerAmount > bounds.makerAmount * 1000000n
        || size * price <= Number(order.signed?.makerAmount) / 1e6
        || !same(position.bought[order.index], size)) fail();
    return { id: trade.id, conditionId: trade.conditionId, takerOrderId: trade.takerOrderId,
        assetId: trade.assetId, traderSide: trade.traderSide, side: trade.side,
        size: trade.size, price: trade.price, status: trade.status, transactionHash: trade.transactionHash };
}

async function verifyGlobalAccount(account, { client, proof, approval, position, order, wallet }) {
    if (!Array.isArray(account?.orders) || account.orders.length || !Array.isArray(account.trades)) fail();
    for (const trade of account.trades) {
        if (!record(trade)) fail();
        const overlaps = trade.conditionId?.toLowerCase() === approval.conditionId
            || trade.takerOrderId?.toLowerCase() === approval.orderId || position.market.tokens.includes(trade.assetId)
            || trade.makerOrders?.some(row => row.orderId?.toLowerCase() === approval.orderId
                || position.market.tokens.includes(row.assetId ?? row.tokenId));
        if (overlaps) verifyTrade({ orders: [], trades: [trade] }, approval, position, order, wallet);
    }
    // Historical API statuses can lag finality. Reverify every pending hash;
    // no cached-receipt or owned-order exemption is used by incident recovery.
    return assertExternalTradesSettled(account.trades, { client, block: proof.blockNumber });
}

// Reconstruct both receipts from zero solely to verify already-booked money.
// The recovered position stays open for the runner's ordinary finalization.
export async function prepareOwnedTradeRecovery(config, state, client, approval, { now = Date.now } = {}) {
    const { position, order } = candidate(config, state, approval), beforeSha256 = digest(state);
    const approvalSha256 = digest(approval), configSha256 = digest(config);
    const guard = () => {
        if (digest(state) !== beforeSha256 || digest(approval) !== approvalSha256 || digest(config) !== configSha256) fail();
        candidate(config, state, approval);
        const own = eligibleHistory(config).find(row => row.baseline === config.id && row.strategy === 'late-entry');
        if (!isDeepStrictEqual(own, state)) fail();
    };
    guard();
    const wallet = await readPeriodWalletProof(config, client);
    guard();
    const block = wallet.blockNumber;
    const [holdings, account, fillReceipt, redeemReceipt, payout, globalAccount] = await Promise.all([
        client.holdings(position.market.tokens, block), client.ordersAndTrades(position.market),
        client.verifiedReceipt(approval.fill.hash, block), client.verifiedReceipt(approval.redeem.hash, block),
        client.payoutAtBlock(approval.conditionId, block), client.ordersAndTrades(),
    ]);
    guard();
    const trade = verifyTrade(account, approval, position, order, config.settings.wallet);
    const globalContext = { client, proof: wallet, approval, position, order, wallet: config.settings.wallet };
    await verifyGlobalAccount(globalAccount, globalContext);
    guard();
    if (!isDeepStrictEqual(holdings, [0, 0]) || !isDeepStrictEqual(payout, position.payout)
        || !same(wallet.balance, expectedWalletBalance(state))) fail();
    for (const [receipt, pin] of [[fillReceipt, approval.fill], [redeemReceipt, approval.redeem]])
        if (receipt?.transactionHash?.toLowerCase() !== pin.hash || receipt?.blockHash?.toLowerCase() !== pin.blockHash
            || receipt.blockNumber !== pin.blockNumber) fail();
    const shadow = { market: structuredClone(position.market), holdings: [0, 0], receipts: {}, actions: [],
        entryCost: 0, fees: 0, orders: [{ ...structuredClone(order), settled: 0, filled: 0, settledPrincipal: 0 }] };
    const fill = verifyOwnedFillReceipt({ position: shadow, wallet: config.settings.wallet,
        block, receipt: fillReceipt, entryCap: config.settings.entryCap });
    const savedFill = position.receipts[approval.fill.hash], savedRedeem = position.receipts[approval.redeem.hash];
    if (!fill || fill.parts.length !== 1 || !same(fill.cash, savedFill.cash) || !same(fill.fees, savedFill.fees)
        || !same(-fill.notional, savedFill.principal) || !isDeepStrictEqual(fill.holdings, savedFill.holdings)
        || !same(fill.parts[0].shares, order.settled) || !same(-fill.notional, order.settledPrincipal)
        || !isDeepStrictEqual(fill.parts[0].signedAmounts, savedFill.signedAmounts)
        || !same(position.entryCost, -fill.cash) || !same(position.fees, fill.fees)
        || !isDeepStrictEqual(position.bought, fill.holdings)) fail();
    Object.assign(shadow, { holdings: fill.holdings, entryCost: -fill.cash, fees: fill.fees });
    shadow.orders[0].settled = order.settled; shadow.receipts[approval.fill.hash] = fill;
    const redeem = verifyAutoRedeemReceipt({ position: shadow, wallet: config.settings.wallet, block, payout, receipt: redeemReceipt });
    if (!redeem || !same(redeem.cash, savedRedeem.cash) || !isDeepStrictEqual(redeem.holdings, savedRedeem.holdings)
        || redeemReceipt.transactionIndex !== savedRedeem.transactionIndex
        || !same(state.cash, position.startingCash + fill.cash + redeem.cash)) fail();
    const [latest, latestGlobal] = await Promise.all([client.ordersAndTrades(position.market), client.ordersAndTrades()]);
    guard(); verifyTrade(latest, approval, position, order, config.settings.wallet);
    const globalTrades = await verifyGlobalAccount(latestGlobal, globalContext);
    guard();
    const finalWallet = await readPeriodWalletProof(config, client);
    guard();
    if (finalWallet.blockNumber < block || finalWallet.blockNumber === block && finalWallet.blockHash !== wallet.blockHash
        || ['balance', 'confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce'].some(key => finalWallet[key] !== wallet[key])) fail();
    const verifiedAt = now(), nextState = structuredClone(state);
    if (!timestamp(verifiedAt) || verifiedAt < state.stopped.at) fail();
    nextState.stopHistory ||= [];
    nextState.stopHistory.push({ ...state.stopped, recoveredAt: verifiedAt, runtimeId: config.runtimeId,
        reasonVerified: reason, beforeSha256, approvalSha256, previousRuntimeId: approval.previousRuntimeId,
        previousManifestSha256: approval.previousManifestSha256, evidence: [approval.fill.hash, approval.redeem.hash],
        originalReconciliationFaults: structuredClone(state.reconciliationFaults), originalEntryHolds: structuredClone(state.entryHolds),
        originalUncertain: true, trade, fill, redemption: redeem, globalTrades, walletProof: finalWallet });
    nextState.stopped = null; nextState.position.uncertain = false;
    nextState.reconciliationFaults = {}; delete nextState.entryHolds.external_activity;
    nextState.continuousOperationHistory ||= [];
    nextState.continuousOperationHistory.push({ ...state.continuousOperation, migratedAt: verifiedAt,
        nextRuntimeId: config.runtimeId, reasonVerified: reason, beforeSha256,
        previousManifestSha256: approval.previousManifestSha256 });
    nextState.continuousOperation.runtimeId = config.runtimeId;
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        previousRuntimeId: approval.previousRuntimeId, slug: position.market.slug, verifiedAt,
        expiresAt: verifiedAt + proofLifetimeMs, walletPUSD: finalWallet.balance, expectedWalletPUSD: expectedWalletBalance(state),
        entryCost: position.entryCost, redemption: redeem.cash, positionCashPnl: round(fill.cash + redeem.cash),
        cash: state.cash, completedMarkets: state.completed.length, accountingPreserved: true, financialWrites: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { state, beforeSha256, nextSha256: digest(nextState), summarySha256: digest(summary), guard, now });
    return review;
}

export function applyOwnedTradeRecovery(store, review, { explicitApply = false } = {}) {
    const proof = reviews.get(review);
    if (!explicitApply || !proof || store.state !== proof.state || review.beforeSha256 !== proof.beforeSha256
        || digest(review.nextState) !== proof.nextSha256 || digest(review.summary) !== proof.summarySha256) fail();
    proof.guard();
    const at = proof.now();
    if (!timestamp(at) || at < review.summary.verifiedAt || at > review.summary.expiresAt) fail();
    const keys = ['stopped', 'position', 'reconciliationFaults', 'entryHolds', 'stopHistory', 'continuousOperation', 'continuousOperationHistory'];
    const old = new Map(keys.map(key => [key, { exists: Object.hasOwn(store.state, key), value: store.state[key] }]));
    for (const key of keys) store.state[key] = structuredClone(review.nextState[key]);
    try { store.save(); }
    catch (error) {
        for (const [key, saved] of old) { if (saved.exists) store.state[key] = saved.value; else delete store.state[key]; }
        throw error;
    }
    reviews.delete(review);
    return review.summary;
}
