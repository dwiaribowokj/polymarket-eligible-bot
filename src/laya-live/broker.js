import { LiveBroker, ownedTradeParts } from '../restart/live.js';
import { safeError } from './network.js';
import { EPS, round } from '../restart/math.js';
import { expectedWalletBalance } from './recovery.js';
import { OperationalError, classifyError } from '../restart/network.js';
import { temporaryRpcFailure } from './rpc.js';
import { isBenignNoFill } from './order-errors.js';
import { verifyOwnedFillReceipt, verifyAutoRedeemReceipt, signedBuyOrderBounds } from './settlement.js';
import { persistedActionIdentity, verifyActionReceipt, pendingProtocolActionReceipt } from './actions.js';
import { holdEntry, clearEntryHold, temporaryReadFailure } from './entry-holds.js';
import { externalOrderReservations, assertExternalTradesSettled } from './external-orders.js';
import { accountedCapitalHashes } from './deposits.js';
import { captureLossWalletEvidence } from './loss-evidence.js';

const HASH = /^0x[a-fA-F0-9]{64}$/;
// Overlap the entire five-minute market and clock/rounding uncertainty before
// a durable, exhaustive epoch wallet audit. This is fixed, never a rolling TTL.
export const WALLET_TRADE_OVERLAP_MS = 300000;
const terminal = status => ['CANCELED', 'CANCELLED', 'MATCHED', 'FILLED', 'EXPIRED', 'UNMATCHED'].includes(String(status).toUpperCase());
const finished = order => ['rejected', 'complete', 'cancelled'].includes(order.status);
const retryDelays = [1000, 2000, 5000, 30000];
const actionRetryDelays = [5000, 15000, 30000, 60000];
const actionPreparationStages = new Set(['rpc_snapshot', 'safe_action_prepare', 'gas_quote']);
const cleanupStops = new Set(['drawdown_limit', 'capital_exhausted', 'live_book_feed_gap',
    'stale_market_data', 'market_watch_failed', 'laya_provider_unavailable', 'operational_check_failed',
    'live_preflight_blocked']);
const accounted = (position, hash) => Object.keys(position.receipts).some(key => key.toLowerCase() === hash.toLowerCase())
    || position.actions.some(action => action.status === 'confirmed' && action.hash?.toLowerCase() === hash.toLowerCase());
const SCALE = 1000000n;
const units = value => {
    const number = Number(value), scaled = Math.round(number * Number(SCALE));
    return Number.isFinite(number) && Number.isSafeInteger(scaled)
        && Math.abs(number * Number(SCALE) - scaled) <= .00001 ? BigInt(scaled) : null;
};
const amount = value => Number(value) / Number(SCALE);
const signedMetadata = order => order.signed?.makerAmount !== undefined || order.signed?.takerAmount !== undefined;
const semanticReadFailure = error => {
    const classified = classifyError(error);
    return !temporaryRpcFailure(classified) && classified.category !== 'opportunity'
        && classified.code !== 'order_lookup_absent';
};
const matchedQuantity = order => Object.values(order.matchedTrades || {}).reduce((sum, row) => {
    const quantity = units(row.shares);
    return sum === null || quantity === null || quantity < 0n ? null : sum + quantity;
}, 0n);

function apiTradeHint(order, shares, price, wallet) {
    const quantity = units(shares), rate = units(price), bounds = signedBuyOrderBounds(order, wallet);
    if (quantity === null || quantity <= 0n || rate === null || rate <= 0n || rate >= SCALE) return null;
    if (!bounds) return !signedMetadata(order) && shares <= order.shares + EPS ? { shares } : null;
    if (rate * bounds.takerAmount > bounds.makerAmount * SCALE) return null;
    // The API can report the taker's limit, not the execution VWAP. Actual
    // principal and its cumulative signed cap are verified from receipts.
    return { shares: amount(quantity), price: amount(rate) };
}

function apiTradeTotalAllowed(order, rows, wallet) {
    const bounds = signedBuyOrderBounds(order, wallet);
    if (!bounds) return !signedMetadata(order) && Object.values(rows).reduce((sum, row) => sum + row.shares, 0) <= order.shares;
    let quantity = 0n;
    for (const row of Object.values(rows)) {
        const value = apiTradeHint(order, row.shares, row.price ?? order.price, wallet);
        if (!value) return false;
        quantity += units(value.shares);
    }
    return quantity <= BigInt(Number.MAX_SAFE_INTEGER);
}

export const operationCode = error => /^[a-z][a-z0-9_]{1,80}$/.test(error?.message || '') ? error.message : safeError(error).code;

// Laya owns one fixed BUY. Receipt proofs can finish it while the venue's
// account index lags, without changing the shared research runtime.
export class LayaLiveBroker extends LiveBroker {
    constructor(settings, store, client, validate) {
        super(settings, store, client); this.validate = validate;
    }
    settledBookHoldReady() {
        try {
            const state = this.store.state, position = this.position, order = position?.orders?.[0];
            if (state.stopped || state.mode !== 'pilot' || state.strategy !== 'late-entry'
                || state.decisionProvider !== 'laya' || !Number.isFinite(state.cash)
                || Object.keys(state.reconciliationFaults || {}).length || !position || position.uncertain
                || position.pendingTrades !== false || position.orders.length !== 1 || position.actions.length !== 0
                || this.pending() || position.autoRedeemWait || position.autoRedeemRetry || position.accountQueryRetry
                || Object.keys(position.failedTrades || {}).length || Object.keys(position.failedSettlementHashes || {}).length
                || order.receiptProvenComplete !== true || !['complete', 'cancelled'].includes(order.status)
                || order.cancelSettled === false || order.queryRetry || order.cancelRetry || order.awaitingReceipt
                || order.side !== 'BUY' || order.kind !== 'taker' || ![0, 1].includes(order.index)
                || order.shares !== 5 || order.shares !== this.settings.shares
                || !HASH.test(position.market?.conditionId || '') || position.market.negRisk === true
                || position.market.tokens?.length !== 2 || new Set(position.market.tokens).size !== 2
                || !position.market.tokens.every(token => /^\d+$/.test(token))
                || order.tokenId !== position.market.tokens[order.index]) return false;
            const bounds = signedBuyOrderBounds(order, this.settings.wallet), settled = units(order.settled);
            const principal = units(order.settledPrincipal), terminal = order.receiptTerminal;
            const entryCap = units(this.settings.entryCap), entryCost = units(position.entryCost), estimatedCost = units(order.cost);
            if (!bounds || !Number.isFinite(order.settled) || settled === null || settled <= 0n
                || !Number.isFinite(order.filled) || units(order.filled) !== settled
                || !Number.isFinite(order.settledPrincipal) || principal === null || principal <= 0n || principal > bounds.makerAmount
                || principal * bounds.takerAmount > settled * bounds.makerAmount
                || !Number.isFinite(position.entryCost) || !Number.isFinite(this.settings.entryCap)
                || entryCap === null || entryCap <= 0n || entryCap > 5n * SCALE
                || entryCost === null || entryCost > entryCap
                || !Number.isFinite(order.cost) || estimatedCost === null || estimatedCost <= 0n || estimatedCost > entryCap
                || !terminal || units(terminal.matchedShares) !== settled || units(terminal.principal) !== principal
                || !['signed_cash_exhausted', 'api_terminal_order', 'cancelled_confirmed_trades', 'fak_matched_confirmed_trades'].includes(terminal.source)
                || !Array.isArray(position.holdings) || position.holdings.length !== 2
                || !Array.isArray(position.bought) || position.bought.length !== 2
                || !position.holdings.every((value, index) => Number.isFinite(value)
                    && units(value) === (index === order.index ? settled : 0n))
                || !position.bought.every((value, index) => Number.isFinite(value)
                    && units(value) === (index === order.index ? settled : 0n))) return false;
            const transactions = order.transactions;
            if (!Array.isArray(transactions) || !transactions.length || !transactions.every(hash => HASH.test(hash))) return false;
            const receipts = Object.entries(position.receipts || {});
            if (receipts.length !== new Set(transactions.map(hash => hash.toLowerCase())).size) return false;
            let quantity = 0n, cash = 0n, fees = 0n, provenPrincipal = 0n;
            for (const [hash, receipt] of receipts) {
                const holdings = receipt.holdings;
                if (!transactions.some(value => value.toLowerCase() === hash.toLowerCase())
                    || receipt.hash?.toLowerCase() !== hash.toLowerCase() || receipt.kind !== 'fill' || receipt.source !== 'receipt'
                    || receipt.orderId?.toLowerCase() !== order.orderId.toLowerCase()
                    || receipt.conditionId !== position.market.conditionId || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0
                    || !HASH.test(receipt.blockHash || '') || !Number.isFinite(receipt.cash) || receipt.cash >= 0
                    || !Number.isFinite(receipt.fees) || receipt.fees < 0 || !Number.isFinite(receipt.principal) || receipt.principal <= 0
                    || !Array.isArray(holdings) || holdings.length !== 2
                    || !holdings.every((value, index) => Number.isFinite(value) && units(value) !== null
                        && (index === order.index ? value > 0 : value === 0))) return false;
                if (units(receipt.shares) !== units(holdings[order.index])
                    || units(receipt.cash) !== -(units(receipt.principal) + units(receipt.fees))) return false;
                quantity += units(holdings[order.index]); cash += units(receipt.cash);
                fees += units(receipt.fees); provenPrincipal += units(receipt.principal);
            }
            return quantity === settled && provenPrincipal === principal && cash === -(principal + fees)
                && units(position.entryCost) === -cash && units(position.fees) === fees;
        } catch { return false; }
    }
    retryLater(owner, key, type, error, now, detail = {}, delays = retryDelays) {
        const attempts = Math.min(delays.length, (owner[key]?.attempts || 0) + 1), delayMs = delays[attempts - 1];
        owner[key] = { attempts, nextAt: now + delayMs };
        this.store.event(type, { ...detail, error: safeError(error), nextDelayMs: delayMs });
    }
    reconciliationFault(reason, now, detail = {}) {
        const faults = this.store.state.reconciliationFaults ||= {}, previous = faults[reason];
        const last = {};
        for (const key of ['orderId', 'hash']) if (HASH.test(detail[key] || '')) last[key] = detail[key].toLowerCase();
        if (typeof detail.tradeId === 'string' && /^[\w:-]{1,128}$/.test(detail.tradeId)) last.tradeId = detail.tradeId;
        faults[reason] = { count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count || 0) + 1),
            firstAt: previous?.firstAt ?? now, lastAt: now, last };
        // The original stop can already be latched. Preserve later semantic
        // faults independently before an awaited read or restart loses them.
        this.store.save();
    }
    rememberSettlement(kind, proof, orderId) {
        const evidence = { hash: proof.hash, kind, conditionId: this.position.market.conditionId,
            cash: proof.cash, holdings: [...proof.holdings], fees: proof.fees || 0,
            blockNumber: proof.blockNumber, blockHash: proof.blockHash, source: 'receipt' };
        if (orderId) evidence.orderId = orderId;
        if (Number.isSafeInteger(proof.transactionIndex) && proof.transactionIndex >= 0)
            evidence.transactionIndex = proof.transactionIndex;
        const part = proof.parts?.find(row => row.orderId === orderId);
        if (part?.signedAmounts) Object.assign(evidence, { principal: part.principal, shares: part.shares,
            requestedShares: this.position.orders.find(order => order.orderId === orderId).shares,
            signedAmounts: { ...part.signedAmounts } });
        this.store.state.settlementEvidence ||= {};
        this.store.state.settlementEvidence[proof.hash] = evidence;
        this.position.receipts[proof.hash] = { ...evidence };
    }
    linkReceiptTradeIds(ownedTrades) {
        let changed = false;
        for (const [hash, evidence] of Object.entries(this.position.receipts)) {
            if (evidence.kind !== 'fill' || evidence.source !== 'receipt' || !evidence.signedAmounts) continue;
            const order = this.position.orders.find(row => row.orderId.toLowerCase() === evidence.orderId?.toLowerCase());
            if (!order || !signedBuyOrderBounds(order, this.settings.wallet)) continue;
            const rows = ownedTrades.flatMap(({ trade, parts }) =>
                trade.transactionHash?.toLowerCase() === hash.toLowerCase()
                    ? parts.filter(part => part.order === order).map(part => ({ trade, part })) : []);
            const quantity = rows.reduce((sum, { part }) => sum + units(part.shares), 0n);
            // Link the complete API quantity for this order and transaction;
            // a partial snapshot cannot prove which IDs cover the receipt.
            if (!rows.length || quantity !== units(evidence.shares)
                || new Set(rows.map(({ trade }) => trade.id)).size !== rows.length) continue;
            const ids = rows.map(({ trade }) => trade.id);
            for (const fill of this.position.fills.filter(fill => fill.hash?.toLowerCase() === hash.toLowerCase()
                && fill.orderId?.toLowerCase() === order.orderId.toLowerCase())) {
                const next = [...new Set([...(fill.tradeIds || []), ...ids])];
                if (next.length === (fill.tradeIds || []).length && fill.tradeId) continue;
                fill.tradeIds = next; fill.tradeId ||= next[0]; changed = true;
            }
        }
        if (changed) this.store.save();
    }
    completeSignedReceipts(accountComplete, ownedTrades, now) {
        const position = this.position;
        const receiptTradeIds = new Set(position.fills.flatMap(fill => [fill.tradeId, ...(fill.tradeIds || [])]).filter(Boolean));
        for (const order of position.orders) {
            const bounds = signedBuyOrderBounds(order, this.settings.wallet);
            if (!bounds) continue;
            const settled = units(order.settled), principal = units(order.settledPrincipal ?? 0);
            const matched = matchedQuantity(order), filled = units(order.filled || 0);
            const hashes = order.transactions || [], ids = order.tradeIds || [];
            const allAccounted = hashes.length > 0 && hashes.every(hash => HASH.test(hash) && accounted(position, hash))
                && ids.every(id => receiptTradeIds.has(id));
            const noOutstandingQuantity = settled !== null && principal !== null && matched !== null && filled !== null
                && settled > 0n && settled >= matched && settled >= filled;
            if (!allAccounted || !noOutstandingQuantity) {
                if (order.receiptProvenComplete) order.receiptProvenComplete = false;
                continue;
            }
            let source;
            if (principal === bounds.makerAmount) source = 'signed_cash_exhausted';
            else if (order.receiptTerminal && units(order.receiptTerminal.matchedShares) === settled
                && units(order.receiptTerminal.principal) === principal) source = order.receiptTerminal.source;
            else if (accountComplete && order.apiTerminal && units(order.apiTerminal.filled) === settled)
                source = 'api_terminal_order';
            else if (accountComplete) {
                const rows = ownedTrades.flatMap(({ trade, parts }) => parts.filter(part => part.order === order).map(part => ({ trade, part })));
                const confirmed = rows.length > 0 && rows.every(({ trade }) =>
                    String(trade.status).replace(/^TRADE_STATUS_/, '').toUpperCase() === 'CONFIRMED');
                const current = rows.reduce((sum, { part }) => sum + units(part.shares), 0n);
                const cancelled = order.status === 'cancelled' && Number.isFinite(order.cancelConfirmedAt);
                if (confirmed && current === settled && matched === settled
                    && (cancelled || String(order.apiSubmissionStatus).toUpperCase() === 'MATCHED'))
                    source = cancelled ? 'cancelled_confirmed_trades' : 'fak_matched_confirmed_trades';
            }
            if (!source) continue;
            if (!order.receiptTerminal || units(order.receiptTerminal.matchedShares) !== settled
                || units(order.receiptTerminal.principal) !== principal)
                order.receiptTerminal = { source, matchedShares: amount(settled), principal: amount(principal),
                    signedMakerAmount: String(bounds.makerAmount), signedTakerAmount: String(bounds.takerAmount),
                    tradeIds: [...ids], transactions: [...hashes], at: now };
            order.receiptProvenComplete = true;
            if (order.status !== 'cancelled') order.status = 'complete';
            if (order.cancelSettled === false) order.cancelSettled = true;
            delete order.queryRetry; delete order.cancelRetry; delete order.awaitingReceipt;
        }
    }
    async reconcile(books, now) {
        this.reconciledSnapshot = null;
        this.reconciliationComplete = false;
        const position = this.position;
        if (!position) return;
        if (position.autoRedeemWait && now - position.autoRedeemWait.since >= 120000)
            this.store.stop('auto_redeem_receipt_timeout');
        this.reconcileBlock = await this.client.confirmedBlock();
        let account = { orders: [], trades: [] }, accountComplete = false;
        if (!(position.accountQueryRetry?.nextAt > now)) {
            try {
                account = await this.client.ordersAndTrades(position.market);
                accountComplete = true;
                delete position.accountQueryRetry;
                clearEntryHold(this.store, 'broker_account', { now, proof: 'fresh_owned_order_and_trade_snapshot' });
            } catch (error) {
                if (temporaryReadFailure(error))
                    holdEntry(this.store, 'broker_account', error, { now, retryable: true });
                else {
                    if (semanticReadFailure(error)) this.reconciliationFault('account_status_unknown', now);
                    this.store.stop('account_status_unknown');
                }
                this.retryLater(position, 'accountQueryRetry', 'account_query_retry', error, now);
            }
        }
        const own = new Set(position.orders.map(order => order.orderId.toLowerCase()));
        const manualOverlap = account.orders.some(order => !own.has(order.id.toLowerCase()));
        if (manualOverlap && this.externalActivity?.enabled()) {
            holdEntry(this.store, 'external_order_overlap', new OperationalError('external_market_overlap', 'opportunity',
                { stage: 'account_read' }), { now, retryable: true });
        } else if (manualOverlap) {
            this.reconciliationFault('unowned_order_in_active_market', now,
                { orderId: account.orders.find(order => !own.has(order.id.toLowerCase())).id });
            position.uncertain = true; this.store.stop('unowned_order_in_active_market');
        } else if (accountComplete) clearEntryHold(this.store, 'external_order_overlap', { now, proof: 'no_manual_orders_in_bot_market' });
        const ownedTrades = [];
        let discoveredHash = false;
        for (const trade of account.trades) {
            const parts = ownedTradeParts(trade, position.orders);
            if (!parts.length) continue;
            if (trade.conditionId !== position.market.conditionId || parts.some(part =>
                !apiTradeHint(part.order, part.shares, part.price, this.settings.wallet)
                || signedBuyOrderBounds(part.order, this.settings.wallet) &&
                    (trade.traderSide !== 'TAKER' || trade.assetId !== undefined && trade.assetId !== part.order.tokenId
                        || trade.side !== undefined && trade.side !== 'BUY' || typeof trade.id !== 'string' || !trade.id))) {
                this.reconciliationFault('invalid_owned_trade', now, { tradeId: trade.id, orderId: parts[0]?.order.orderId });
                position.uncertain = true; this.store.stop('invalid_owned_trade'); continue;
            }
            let validTotal = true;
            for (const part of parts) {
                const key = `trade:${trade.id}`, previous = part.order.matchedTrades?.[key];
                const next = previous?.shares > part.shares ? previous : { id: trade.id,
                    ...apiTradeHint(part.order, part.shares, part.price, this.settings.wallet) };
                if (!apiTradeTotalAllowed(part.order, { ...(part.order.matchedTrades || {}), [key]: next }, this.settings.wallet))
                    validTotal = false;
            }
            if (!validTotal) {
                this.reconciliationFault('invalid_owned_trade', now, { tradeId: trade.id, orderId: parts[0]?.order.orderId });
                position.uncertain = true; this.store.stop('invalid_owned_trade'); continue;
            }
            ownedTrades.push({ trade, parts });
            if (typeof trade.id === 'string' && trade.id) for (const part of parts) {
                if (!(part.order.tradeIds || []).includes(trade.id)) discoveredHash = true;
                part.order.tradeIds = [...new Set([...(part.order.tradeIds || []), trade.id])];
                part.order.matchedTrades ||= {};
                const key = `trade:${trade.id}`, previous = part.order.matchedTrades[key]?.shares || 0;
                if (previous !== part.shares) discoveredHash = true;
                if (part.shares >= previous) part.order.matchedTrades[key] = { id: trade.id,
                    ...apiTradeHint(part.order, part.shares, part.price, this.settings.wallet) };
                const matched = amount(matchedQuantity(part.order));
                part.order.filled = Math.max(Number(part.order.filled) || 0, matched);
            }
            if (HASH.test(trade.transactionHash || '')) for (const part of parts) {
                const hashes = [...(part.order.transactions || []), trade.transactionHash].map(hash => hash.toLowerCase());
                if (!hashes.slice(0, -1).includes(trade.transactionHash.toLowerCase())) discoveredHash = true;
                part.order.transactions = [...new Set(hashes)];
            }
        }
        // Retain discovery before awaiting RPC: the next API snapshot can
        // lose this row while a process is restarting or a read is pending.
        if (discoveredHash) this.store.save();
        const tradeHashes = ownedTrades.map(({ trade }) => trade.transactionHash).filter(hash => HASH.test(hash || ''));
        const candidates = [...new Set([...position.orders.flatMap(order => order.transactions || []), ...tradeHashes]
            .filter(hash => HASH.test(hash || '')).map(hash => hash.toLowerCase()))];
        position.receiptRetries ||= {};
        for (const hash of candidates.filter(hash => !accounted(position, hash)).slice(0, 16)) {
            if (accounted(position, hash) || position.failedSettlementHashes?.[hash]
                || position.receiptRetries[hash]?.nextAt > now) continue;
            try {
                const receipt = await this.client.verifiedReceipt(hash, this.reconcileBlock);
                if (!receipt) continue;
                if (receipt.status === 0) {
                    this.reconciliationFault('trade_receipt_failed', now, { hash });
                    position.uncertain = true;
                    position.failedSettlementHashes ||= {};
                    position.failedSettlementHashes[hash] = { hash, blockNumber: receipt.blockNumber,
                        blockHash: receipt.blockHash, source: 'receipt' };
                    delete position.receiptRetries[hash];
                    this.store.stop('trade_receipt_failed');
                    this.store.event('trade_receipt_failed', position.failedSettlementHashes[hash]);
                    continue;
                }
                const proof = verifyOwnedFillReceipt({ position, wallet: this.settings.wallet,
                    block: this.reconcileBlock, receipt, ownedTradeHashes: tradeHashes, entryCap: this.settings.entryCap });
                if (!proof) {
                    if (now - position.openedAt >= 60000) {
                        this.reconciliationFault('trade_receipt_mapping_mismatch', now, { hash });
                        position.uncertain = true; this.store.stop('trade_receipt_mapping_mismatch');
                    }
                    this.retryLater(position.receiptRetries, hash, 'fill_receipt_retry',
                        new OperationalError('fill_receipt_unproven', 'reconciliation'), now, { hash });
                    continue;
                }
                delete position.receiptRetries[hash];
                this.applyMovement(proof);
                position.entryCost = round(position.entryCost - proof.cash);
                position.fees = round(position.fees + proof.fees);
                for (const part of proof.parts) {
                    const order = position.orders.find(row => row.orderId.toLowerCase() === part.orderId.toLowerCase());
                    order.settled = round(order.settled + part.shares);
                    if (part.signedAmounts) {
                        order.settledPrincipal = amount(BigInt(part.signedAmounts.principalAfter));
                        order.signedAmounts = { ...part.signedAmounts };
                    }
                    order.filled = Math.max(Number(order.filled) || 0, order.settled);
                    position.bought[part.index] = round(position.bought[part.index] + part.shares);
                    const trades = part.signedAmounts ? [] : ownedTrades.filter(row => row.trade.transactionHash?.toLowerCase() === hash).map(row => row.trade);
                    position.fills.push({ tradeId: trades[0]?.id || null, tradeIds: trades.map(trade => trade.id), orderId: order.orderId, hash,
                        shares: part.shares, price: part.price, settledAt: now, source: 'receipt' });
                    if (!part.signedAmounts && order.settled === order.shares) {
                        order.status = 'complete'; order.receiptProvenComplete = true;
                        if (order.cancelSettled === false) order.cancelSettled = true;
                        delete order.queryRetry; delete order.cancelRetry; delete order.awaitingReceipt;
                    }
                    this.rememberSettlement('fill', proof, order.orderId);
                    if (part.signedAmounts && units(order.settled) > units(order.shares)
                        && units(order.shareQuantityDeviation?.actualShares) !== units(order.settled)) {
                        order.shareQuantityDeviation = { requestedShares: order.shares, actualShares: order.settled,
                            excessShares: amount(units(order.settled) - units(order.shares)), source: 'receipt' };
                        this.store.event('order_share_quantity_deviation', { orderId: order.orderId,
                            ...order.shareQuantityDeviation });
                    }
                }
                this.store.event('fill_settled', { hash, cash: proof.cash, holdings: proof.holdings,
                    fees: proof.fees, source: 'receipt', blockNumber: proof.blockNumber, blockHash: proof.blockHash });
            } catch (error) {
                this.retryLater(position.receiptRetries, hash, 'fill_receipt_retry', error, now, { hash });
                if (!temporaryRpcFailure(error)) {
                    this.reconciliationFault('trade_receipt_unavailable', now, { hash });
                    this.store.stop('trade_receipt_unavailable');
                }
            }
        }
        this.linkReceiptTradeIds(ownedTrades);
        this.completeSignedReceipts(accountComplete, ownedTrades, now);
        const failedShares = new Map();
        for (const { trade, parts } of ownedTrades) {
            if (String(trade.status).replace(/^TRADE_STATUS_/, '').toUpperCase() !== 'FAILED') continue;
            this.reconciliationFault('trade_settlement_failed', now, { tradeId: trade.id });
            position.uncertain = true;
            for (const part of parts) failedShares.set(part.order.orderId,
                (failedShares.get(part.order.orderId) || 0) + part.shares);
            position.failedTrades ||= {};
            if (!position.failedTrades[trade.id]) {
                position.failedTrades[trade.id] = true; this.store.state.failures++;
                this.store.event('trade_settlement_failed', { tradeId: trade.id });
            }
            this.store.stop('trade_settlement_failed');
        }
        for (const order of position.orders) {
            if (order.status === 'rejected' || order.receiptProvenComplete || finished(order) || order.queryRetry?.nextAt > now) continue;
            try {
                const api = account.orders.find(row => row.id.toLowerCase() === order.orderId.toLowerCase())
                    || await this.client.order(order.orderId);
                const filled = Number(api.sizeMatched);
                const quantity = units(api.sizeMatched), bounds = signedBuyOrderBounds(order, this.settings.wallet);
                if (api.id?.toLowerCase() !== order.orderId.toLowerCase() || !Number.isFinite(filled)
                    || quantity === null || quantity < 0n || !bounds && (signedMetadata(order) || filled > order.shares))
                    throw new OperationalError('invalid_order_fill', 'reconciliation');
                // A signed BUY has a cash cap, not an upper share quantity.
                // This API quantity remains a pending hint until receipts agree.
                if (bounds) order.apiMatchedQuantity = { shares: filled, source: 'order_lookup' };
                order.filled = Math.max(order.settled, Number(order.filled) || 0, filled);
                order.status = terminal(api.status) ? 'complete' : 'open';
                if (terminal(api.status)) order.apiTerminal = { status: api.status, filled, at: now };
                delete order.queryRetry; delete order.awaitingReceipt;
            } catch (error) {
                const authorizedHash = [...(order.transactions || []), ...tradeHashes].some(hash => HASH.test(hash || ''));
                const knownMatch = order.tradeIds?.length || String(order.apiSubmissionStatus).toUpperCase() === 'MATCHED';
                const settling = error.code === 'order_lookup_absent' && (authorizedHash || knownMatch)
                    && now >= position.openedAt && now - position.openedAt < 120000;
                if (settling) order.awaitingReceipt = true;
                else if (temporaryReadFailure(error)) {
                    holdEntry(this.store, 'broker_order', error, { now, retryable: true });
                } else {
                    if (error.code === 'invalid_order_fill') {
                        this.reconciliationFault('invalid_order_fill', now, { orderId: order.orderId });
                        position.uncertain = true;
                    } else if (semanticReadFailure(error))
                        this.reconciliationFault('order_status_unknown', now, { orderId: order.orderId });
                    order.status = 'unknown'; this.store.stop('order_status_unknown');
                }
                this.retryLater(order, 'queryRetry', 'order_query_retry', error, now, { orderId: order.orderId });
            }
        }
        this.completeSignedReceipts(accountComplete, ownedTrades, now);
        const unsettledHash = candidates.some(hash => !accounted(position, hash) && !position.failedSettlementHashes?.[hash]);
        const unsettledTrade = ownedTrades.some(({ trade, parts }) =>
            String(trade.status).replace(/^TRADE_STATUS_/, '').toUpperCase() !== 'FAILED'
            && parts.some(part => !part.order.receiptProvenComplete)
            && (!trade.transactionHash || !accounted(position, trade.transactionHash)));
        const knownTradeIds = new Set(position.fills.flatMap(fill => [fill.tradeId, ...(fill.tradeIds || [])]).filter(Boolean));
        const unsettledSubmission = position.orders.some(order => !order.receiptProvenComplete && order.status !== 'rejected'
            && ((order.tradeIds || []).some(id => !knownTradeIds.has(id) && !position.failedTrades?.[id])
                || String(order.apiSubmissionStatus).toUpperCase() === 'MATCHED' && order.settled === 0
                    && !(order.tradeIds?.length && order.tradeIds.every(id => position.failedTrades?.[id]))));
        const unsettledMatchedQuantity = position.orders.some(order => !order.receiptProvenComplete &&
            Math.round(Object.values(order.matchedTrades || {}).filter(row => !position.failedTrades?.[row.id])
                .reduce((sum, row) => sum + row.shares, 0) * 1e6) > Math.round(order.settled * 1e6));
        const unprovenSignedReceipt = position.orders.some(order => signedBuyOrderBounds(order, this.settings.wallet)
            && units(order.settled) > 0n && !order.receiptProvenComplete);
        position.pendingTrades = unsettledHash || unsettledTrade || unsettledSubmission || unsettledMatchedQuantity || unprovenSignedReceipt || position.orders.some(order => order.status !== 'rejected' &&
            (!finished(order) || Math.round(order.filled * 1e6) > Math.round((order.settled + (failedShares.get(order.orderId) || 0)) * 1e6)));
        position.pendingSince = position.pendingTrades ? position.pendingSince || now : null;
        if (position.pendingTrades && now - position.pendingSince >= 120000) this.store.stop('fill_settlement_timeout');
        for (const order of position.orders) {
            if (order.cancelSettled === false && now - order.cancelConfirmedAt >= this.settings.cancelReconcileMs
                && finished(order) && !position.pendingTrades) order.cancelSettled = true;
        }
        if (position.entryCost > this.settings.entryCap + EPS) this.store.stop('entry_budget_exceeded');
        await this.reconcileAutoRedemptions(now);
        await this.reconcileActions(now);
        if (position.orders.every(order => order.receiptProvenComplete || finished(order) && !order.queryRetry))
            clearEntryHold(this.store, 'broker_order', { now, proof: 'owned_orders_terminal_or_freshly_reconciled' });
        this.reconciliationComplete = accountComplete && !manualOverlap && !position.accountQueryRetry
            && !position.pendingTrades && !Object.keys(position.receiptRetries || {}).length
            && !position.orders.some(order => order.queryRetry && !order.receiptProvenComplete)
            && !position.actions.some(action => action.receiptRetry && action.status !== 'confirmed');
        this.store.save();
        this.reconciledSnapshot = { position, block: this.reconcileBlock, at: now };
    }
    actionRetry(action, error, now) {
        this.retryLater(action, 'receiptRetry', 'action_receipt_retry', error, now,
            { hash: action.hash }, actionRetryDelays);
    }
    async reconcileActions(now) {
        for (const action of this.position.actions) {
            if (['confirmed', 'failed'].includes(action.status) || action.source === 'protocol_auto') continue;
            if (action.receiptRetry?.nextAt > now) {
                if (now - action.createdAt > 120000) this.store.stop('transaction_status_unknown');
                continue;
            }
            try {
                if (!persistedActionIdentity({ position: this.position, wallet: this.settings.wallet, action }))
                    throw new OperationalError('action_identity_unproven', 'reconciliation');
                // A missing receipt cannot prove failure or authorize another
                // broadcast. Recovery only reads the already persisted hash.
                const receipt = await this.client.verifiedReceipt(action.hash, this.reconcileBlock);
                if (!receipt) {
                    if (now - action.createdAt > 120000) this.store.stop('transaction_status_unknown');
                    this.actionRetry(action, new OperationalError('action_receipt_pending', 'reconciliation'), now);
                    continue;
                }
                const proof = verifyActionReceipt({ position: this.position, wallet: this.settings.wallet,
                    block: this.reconcileBlock, action, receipt });
                if (!proof && pendingProtocolActionReceipt({ position: this.position, wallet: this.settings.wallet,
                    block: this.reconcileBlock, action, receipt }) && await this.waitForProtocolRedemption(this.reconcileBlock, now)) {
                    this.actionRetry(action, new OperationalError('auto_redeem_receipt_pending', 'opportunity'), now);
                    continue;
                }
                if (!proof) throw new OperationalError('action_receipt_unproven', 'reconciliation');
                // All identity, execution and movement checks precede gas.
                // The terminal status and accounting persist in one snapshot.
                const position = this.position;
                action.gas = proof.gas; action.finishedAt = now; action.status = proof.status;
                action.receiptEvidence = { hash: proof.hash, safeHash: proof.safeHash, safeNonce: proof.safeNonce,
                    signer: proof.signer, blockNumber: proof.blockNumber, blockHash: proof.blockHash, source: 'receipt' };
                delete action.receiptRetry; delete action.raw;
                position.gas = round((position.gas || 0) + proof.gas);
                this.store.state.cash = round(this.store.state.cash - proof.gas);
                if (proof.status === 'confirmed') {
                    this.applyMovement(proof);
                    this.rememberSettlement(action.kind, proof);
                    this.store.event(`${action.kind}_confirmed`, { hash: proof.hash, cash: proof.cash, gas: proof.gas,
                        blockNumber: proof.blockNumber, blockHash: proof.blockHash });
                } else {
                    this.store.state.failures++;
                    this.store.event(`${action.kind}_failed`, { hash: proof.hash, gas: proof.gas,
                        blockNumber: proof.blockNumber, blockHash: proof.blockHash });
                }
            } catch (error) {
                if (now - action.createdAt > 120000) this.store.stop('transaction_status_unknown');
                this.actionRetry(action, error, now);
                if (!temporaryRpcFailure(error)) {
                    this.reconciliationFault('action_receipt_unconfirmed', now, { hash: action.hash });
                    this.store.stop('action_receipt_unconfirmed');
                }
            }
        }
    }
    async reconcileAutoRedemptions(now) {
        const position = this.position;
        if (!position || !position.holdings.some(value => value > EPS) || now < position.market.end
            || !this.client.listAutoRedemptions || position.autoRedeemRetry?.nextAt > now) return;
        try {
            this.autoRedeemScan = null;
            if (!position.payout) {
                position.lastPayoutCheck = now;
                position.payout = await this.client.payoutAtBlock(position.market.conditionId, this.reconcileBlock);
                if (position.payout) this.store.event('official_resolution', { payout: position.payout,
                    conditionId: position.market.conditionId });
            }
            if (!position.payout) return;
            const candidates = await this.client.listAutoRedemptions(position.market, position.openedAt);
            let unresolved = candidates.filter(hash => !accounted(position, hash)).length > 16;
            for (const hash of candidates.filter(hash => !accounted(position, hash)).slice(0, 16)) {
                if (accounted(position, hash)) continue;
                const receipt = await this.client.verifiedReceipt(hash, this.reconcileBlock);
                const proof = verifyAutoRedeemReceipt({ position, wallet: this.settings.wallet,
                    block: this.reconcileBlock, payout: position.payout, receipt });
                if (!proof) { unresolved = true; continue; }
                this.applyMovement(proof);
                if (position.holdings.every(value => Math.abs(value) < EPS)) {
                    delete position.autoRedeemWait;
                    delete position.actionPreparationRetry;
                }
                position.actions.push({ kind: 'redeem', source: 'protocol_auto', hash: proof.hash,
                    status: 'confirmed', amount: proof.cash, gas: 0, createdAt: now, finishedAt: now });
                this.rememberSettlement('protocol_auto_redeem', { ...proof, transactionIndex: receipt.transactionIndex });
                this.store.event('protocol_auto_redeem_settled', { hash: proof.hash, cash: proof.cash,
                    holdings: proof.holdings, blockNumber: proof.blockNumber, blockHash: proof.blockHash });
            }
            const scanKey = JSON.stringify([this.settings.wallet.toLowerCase(), position.market.conditionId.toLowerCase(),
                position.market.tokens, position.openedAt]);
            this.autoRedeemScan = { position, block: this.reconcileBlock, at: now,
                clear: !unresolved && this.client.redemptionScan?.complete === true && this.client.redemptionScan.key === scanKey };
            if (unresolved) this.retryLater(position, 'autoRedeemRetry', 'auto_redeem_retry',
                new OperationalError('auto_redeem_unproven', 'reconciliation'), now, {}, actionRetryDelays);
            else delete position.autoRedeemRetry;
        } catch (error) {
            this.retryLater(position, 'autoRedeemRetry', 'auto_redeem_retry', error, now, {}, actionRetryDelays);
            if (!temporaryRpcFailure(error)) {
                this.reconciliationFault('auto_redeem_unconfirmed', now);
                this.store.stop('auto_redeem_unconfirmed');
            }
        }
    }
    async cancelOwned() {
        const now = Date.now();
        for (const order of this.position?.orders || []) {
            if (finished(order) || order.receiptProvenComplete || order.cancelRetry?.nextAt > now) continue;
            try {
                await this.client.cancel(order.orderId);
                if (order.receiptProvenComplete || order.status === 'complete') continue;
                order.status = 'cancelled'; order.cancelConfirmedAt = now; order.cancelSettled = false;
                delete order.cancelRetry;
                this.store.event('order_cancelled', { orderId: order.orderId });
            } catch (error) {
                this.store.stop('cancellation_unconfirmed');
                this.retryLater(order, 'cancelRetry', 'cancel_retry', error, now, { orderId: order.orderId });
            }
        }
    }
    async action(kind, amount, now) {
        if (this.actionPreparing || this.position?.actionPreparationRetry?.nextAt > now) return false;
        this.actionPreparing = true;
        try {
            if (this.store.state.stopped) {
                if (kind === 'redeem' && amount === 0) return await this.redeemAfterDrawdown(now);
                return false;
            }
            const position = this.position;
            if (!position || position.autoRedeemWait || this.pending()) return false;
            if (kind === 'redeem') {
                const scan = this.autoRedeemScan;
                if (!scan || scan.position !== position || scan.block !== this.reconcileBlock || !scan.clear
                    || !await this.readWallet(now)) return false;
            }
            if (position.actions.filter(action => action.kind === kind && action.status === 'failed').length >= 3) {
                this.store.stop(`${kind}_retry_limit`); return false;
            }
            const last = position.actions.at(-1);
            if (last?.status === 'failed' && now - last.finishedAt < 30000) return false;
            const action = await this.prepareMaintenanceAction(position, kind, amount, now);
            if (!action || this.position !== position || this.store.state.stopped || this.pending()) return false;
            if (this.externalActivity?.enabled() && !await this.freshMaintenanceWallet(position)) return false;
            if (this.position !== position || this.store.state.stopped || this.pending()) return false;
            delete position.actionPreparationRetry;
            position.actions.push(action);
            this.store.event(`${kind}_prepared`, { hash: action.hash, amount });
            await this.broadcast(action);
            return false;
        } finally { this.actionPreparing = false; }
    }
    async freshMaintenanceWallet(position) {
        const startedAt = Date.now();
        let block, balance, holdings, account;
        try {
            block = await this.client.confirmedBlock();
            [balance, holdings, account] = await Promise.all([this.client.balance(block),
                this.client.holdings(position.market.tokens, block), this.walletAccount()]);
        } catch (error) {
            // No signed action has been made durable or broadcast at this read boundary.
            if (!temporaryReadFailure(error) && !temporaryRpcFailure(error)) throw error;
            holdEntry(this.store, 'maintenance_wallet', error, { now: Date.now(), retryable: true });
            return false;
        }
        const manual = externalOrderReservations(account.orders, { market: position.market,
            owned: position.orders.map(order => order.orderId) });
        try { await this.externalTrades(account.trades, block); }
        catch (error) {
            if (error?.code !== 'external_trades_pending') throw error;
            this.externalActivity.defer(); return false;
        }
        if (this.position !== position || Date.now() - startedAt > this.settings.maxDataAgeMs
            || !Number.isFinite(balance) || units(balance) !== units(expectedWalletBalance(this.store.state))
            || !Array.isArray(holdings) || holdings.length !== 2
            || holdings.some((value, index) => units(value) !== units(position.holdings[index])) || manual.overlaps) {
            this.externalActivity.defer();
            return false;
        }
        clearEntryHold(this.store, 'maintenance_wallet', { now: Date.now(), proof: 'fresh_prepared_action_wallet' });
        return true;
    }
    async externalTrades(trades, block) {
        const state = this.store.state;
        const previous = [state.externalWalletActivity?.walletProof, state.strategyEpochs?.at(-1)?.walletProof]
            .flatMap(proof => proof?.trades?.receiptConfirmed || [])
            .filter(row => Number.isSafeInteger(row.blockNumber) && row.blockNumber <= block && HASH.test(row.transactionHash || ''))
            .map(row => row.transactionHash);
        return assertExternalTradesSettled(trades, { client: this.client, block,
            owned: state.position?.orders.map(order => order.orderId) || [],
            knownHashes: [...accountedCapitalHashes(state), ...previous] });
    }
    async prepareMaintenanceAction(position, kind, amount, now) {
        // This catch ends before the signed action is persisted or broadcast.
        // A send error must retain the exact durable action and unknown status.
        try { return await this.client.prepareAction(position, kind, amount); }
        catch (error) {
            const diagnostic = safeError(error);
            const funding = ['insufficient_action_gas', 'action_fee_limit'].includes(diagnostic.code) && diagnostic.category === 'validation'
                && diagnostic.stage === 'safe_action_prepare';
            const read = actionPreparationStages.has(diagnostic.stage) && temporaryReadFailure(error);
            if (this.position !== position || !funding && !read) throw error;
            const previous = position.actionPreparationRetry, attempts = Math.min(2, (previous?.attempts || 0) + 1);
            const delayMs = attempts === 1 ? 30000 : 60000;
            position.actionPreparationRetry = { kind, amount, attempts, firstAt: previous?.firstAt ?? now,
                failedAt: now, nextAt: now + delayMs, error: diagnostic };
            this.store.event('action_preparation_retry', { kind, amount, error: diagnostic, nextDelayMs: delayMs });
            return null;
        }
    }
    stoppedRedeemReady(now) {
        const state = this.store.state, position = this.position, scan = this.autoRedeemScan;
        const snapshot = this.reconciledSnapshot, order = position?.orders?.[0];
        return cleanupStops.has(state.stopped?.reason) && Number.isFinite(state.stopped.at)
            && Number.isFinite(state.walletStart) && Number.isFinite(state.walletCashDelta) && Number.isFinite(state.cash)
            && Number.isFinite(now) && Number.isFinite(position?.market?.end) && now >= position.market.end
            && !Object.keys(state.reconciliationFaults || {}).length && !position.uncertain
            && !state.profitTaking?.pending && !state.profitTakingControl?.operation
            && position.pendingTrades === false && !this.pending() && !position.autoRedeemWait
            && !position.autoRedeemRetry && !position.accountQueryRetry
            && !Object.keys(position.failedTrades || {}).length && !Object.keys(position.failedSettlementHashes || {}).length
            // This exception permits the first cleanup only. A failed or
            // exposed prior transaction never authorizes another financial write.
            && position.actions.length === 0 && position.orders.length === 1
            && order.receiptProvenComplete === true && ['complete', 'cancelled'].includes(order.status)
            && order.side === 'BUY' && [0, 1].includes(order.index)
            && order.tokenId === position.market.tokens?.[order.index]
            && !order.queryRetry && !order.cancelRetry && !order.awaitingReceipt
            && Number.isFinite(order.settled) && units(order.settled) !== null && units(order.settled) > 0n
            && Number.isFinite(order.filled) && units(order.filled) === units(order.settled)
            && Array.isArray(position.holdings) && position.holdings.length === 2
            && position.holdings.every((value, i) => Number.isFinite(value) && units(value) !== null
                && units(value) === (i === order.index ? units(order.settled) : 0n))
            && Number.isSafeInteger(this.reconcileBlock) && this.reconcileBlock >= 0
            && snapshot?.position === position && snapshot.block === this.reconcileBlock && snapshot.at === now
            && scan?.position === position && scan.block === this.reconcileBlock && scan.at === now && scan.clear === true;
    }
    async redeemAfterDrawdown(now) {
        if (this.stoppedRedeemPreparing || this.position?.actionPreparationRetry?.nextAt > now
            || !this.stoppedRedeemReady(now)) return false;
        this.stoppedRedeemPreparing = true;
        let stage = 'resolution';
        try {
            const position = this.position, snapshot = this.reconciledSnapshot, scan = this.autoRedeemScan;
            const unchanged = () => JSON.stringify([this.store.state.stopped, this.store.state.reconciliationFaults,
                position, this.store.state.cash, this.store.state.walletStart, this.store.state.walletCashDelta,
                this.store.state.externalWalletActivity, this.store.state.profitTaking, this.store.state.profitTakingControl,
                expectedWalletBalance(this.store.state)]);
            const before = unchanged();
            const ready = () => this.position === position && this.reconciledSnapshot === snapshot
                && this.autoRedeemScan === scan && this.stoppedRedeemReady(now) && unchanged() === before;
            const payout = await this.client.payoutAtBlock(position.market.conditionId, snapshot.block);
            if (!ready() || payout == null) return false;
            if (!Array.isArray(payout) || payout.length !== 2
                || ![[0, 1], [1, 0]].some(row => row.every((value, i) => value === payout[i]))
                || position.payout?.length !== 2 || !position.payout.every((value, i) => value === payout[i])) {
                this.reconciliationFault('official_payout_mismatch', now); return false;
            }
            stage = 'wallet';
            if (!await this.readWallet(now, true) || !ready()) return false;
            stage = 'prepare';
            const action = await this.prepareMaintenanceAction(position, 'redeem', 0, now);
            // Preparation can await several reads. Revalidate before making
            // the signed intent durable, then retain the normal one-shot write.
            if (!action || !ready()) return false;
            if (this.externalActivity?.enabled() && !await this.freshMaintenanceWallet(position)) return false;
            if (!ready()) return false;
            if (action?.kind !== 'redeem' || action.amount !== 0 || action.status !== 'prepared'
                || !persistedActionIdentity({ position, wallet: this.settings.wallet, action })) {
                this.reconciliationFault('action_identity_unproven', now); return false;
            }
            delete position.actionPreparationRetry;
            position.actions.push(action);
            this.store.event('redeem_prepared', { hash: action.hash, amount: 0 });
            await this.broadcast(action);
            return false;
        } catch (error) {
            const classified = classifyError(error);
            if (semanticReadFailure(error) && (stage !== 'prepare' || classified.category === 'reconciliation'
                || ['rpc_wrong_chain', 'rpc_block_mismatch', 'rpc_block_number_mismatch',
                    'action_safe_hash_mismatch', 'action_nonce_regressed', 'invalid_action_nonce'].includes(classified.code)))
                this.reconciliationFault('stopped_redeem_unconfirmed', now);
            throw error;
        } finally { this.stoppedRedeemPreparing = false; }
    }
    walletTradeQuery(now = Date.now()) {
        const state = this.store.state, epoch = Array.isArray(state.strategyEpochs) ? state.strategyEpochs.at(-1) : null;
        const proof = epoch?.walletProof;
        const time = value => Number.isSafeInteger(value) && value >= 0;
        const nonce = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
        // Only a reviewed full-account epoch proof can retire older API rows.
        // New/fresh epochs and incomplete/invalid proofs retain exhaustive reads.
        if (!epoch || epoch.id !== state.currentStrategyEpochId || !time(state.startedAt)
            || !time(now) || !time(epoch.startedAt) || epoch.startedAt < state.startedAt || epoch.startedAt > now
            || !time(proof?.verifiedAt) || proof.verifiedAt > epoch.startedAt
            || !time(proof.blockNumber) || !HASH.test(proof.blockHash || '') || /^0x0{64}$/i.test(proof.blockHash)
            || !Number.isFinite(proof.balance) || proof.balance < 0 || proof.expectedBalance !== proof.balance
            || !['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce'].every(key => nonce(proof[key]))
            || proof.confirmedNonce !== proof.pendingNonce || proof.safeNonce !== proof.pendingSafeNonce
            || !Number.isSafeInteger(proof.trades?.apiTerminal) || proof.trades.apiTerminal < 0
            || !Array.isArray(proof.trades.receiptConfirmed) || proof.trades.receiptConfirmed.some(row =>
                !row || !HASH.test(row.transactionHash || '') || /^0x0{64}$/i.test(row.transactionHash)
                || row.source !== 'known_receipt' && (!time(row.blockNumber) || row.blockNumber > proof.blockNumber
                    || !HASH.test(row.blockHash || '') || /^0x0{64}$/i.test(row.blockHash)))) return null;
        // Audit-start, not verifiedAt: trades can match while the audit runs.
        // Older proof versions lack audit-start; retain the whole period then.
        const since = proof.verificationStartedAt ?? state.startedAt;
        if (!time(since) || since < state.startedAt || since > proof.verifiedAt) return null;
        const exposedAt = state.position?.openedAt;
        if (state.position && (!time(exposedAt) || exposedAt > now)) return null;
        const boundary = Math.min(since, exposedAt ?? since);
        return { after: String(Math.max(0, Math.floor((boundary - WALLET_TRADE_OVERLAP_MS) / 1000))) };
    }
    walletAccount() {
        const query = this.walletTradeQuery();
        // Open orders remain unfiltered across ALL markets; only already-
        // audited trade history is bounded. Never truncate pagination locally.
        return query ? this.client.ordersAndTrades(null, query) : this.client.ordersAndTrades();
    }
    async entryWallet(market) {
        const startedAt = Date.now();
        const readTogether = async tasks => {
            // Drain failed read groups before the next tick can change the shared RPC anchor.
            const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
            const failures = results.filter(result => result.status === 'rejected');
            // A simultaneous timeout must not hide an identity or validation failure.
            const failure = failures.find(result => !temporaryRpcFailure(result.reason)) || failures[0];
            if (failure) throw failure.reason;
            return results.map(result => result.value);
        };
        try {
            // Fresh account pagination can overlap the pinned RPC chain; neither result is cached.
            const [wallet, account] = await readTogether([
                async () => {
                    const block = await this.client.confirmedBlock();
                    const anchor = this.client.rpc?.anchor;
                    const blockHash = anchor && anchor.number === block ? anchor.hash : undefined;
                    const [balance, holdings] = await readTogether([
                        () => this.client.balance(block), () => this.client.holdings(market.tokens, block),
                    ]);
                    return { block, blockHash, balance, holdings };
                },
                () => this.externalActivity?.enabled() ? this.walletAccount() : null,
            ]);
            const { block, blockHash, balance, holdings } = wallet;
            const reservation = account ? externalOrderReservations(account.orders, { market }) : null;
            if (account) await this.externalTrades(account.trades, block);
            const witness = { startedAt, checkedAt: Date.now(), block, tokens: [...market.tokens], balance, holdings,
                ...(blockHash && this.client.rpc?.anchor?.number === block && this.client.rpc.anchor.hash === blockHash
                    ? { blockHash } : {}),
                ...(reservation ? { externalOrders: reservation, spendable: Math.max(0, balance - reservation.reservedPUSD) } : {}) };
            this.assertEntryWallet(witness, market);
            return witness;
        } catch (error) {
            if (!this.position && temporaryRpcFailure(error))
                throw new OperationalError('entry_wallet_unavailable', 'opportunity', { stage: 'wallet_read' });
            throw error;
        }
    }
    assertEntryWallet(witness, market, now = Date.now()) {
        if (!witness || !Number.isSafeInteger(witness.block) || witness.block < 0
            || !Number.isFinite(witness.startedAt) || !Number.isFinite(witness.checkedAt)
            || witness.startedAt > witness.checkedAt || witness.checkedAt > now
            || witness.tokens?.length !== 2 || witness.tokens.some((token, i) => token !== market.tokens[i])
            || !Number.isFinite(witness.balance) || witness.balance < 0 || witness.holdings?.length !== 2
            || witness.holdings.some(value => !Number.isFinite(value) || value < 0))
            throw new OperationalError('entry_wallet_invalid', 'validation', { stage: 'wallet_read' });
        if (now - witness.startedAt > this.settings.maxDataAgeMs)
            throw new OperationalError('entry_wallet_expired', 'stale_data', { stage: 'wallet_read' });
        const expected = expectedWalletBalance(this.store.state);
        if (!Number.isFinite(expected))
            throw new OperationalError('entry_wallet_invalid', 'validation', { stage: 'wallet_read' });
        if (Math.abs(witness.balance - expected) > EPS) {
            if (this.externalActivity?.enabled()) {
                this.externalActivity.defer();
                throw new OperationalError('external_activity_verifying', 'opportunity', { stage: 'wallet_read' });
            }
            if (this.capitalDeposits?.enabled() && witness.balance > expected) {
                this.capitalDeposits.defer();
                throw new OperationalError('capital_deposit_verifying', 'opportunity', { stage: 'wallet_read' });
            }
            this.store.stop('wallet_ledger_mismatch');
            this.store.event('wallet_mismatch', { expectedPUSD: expected, actualPUSD: witness.balance });
            throw new OperationalError('wallet_ledger_mismatch', 'reconciliation', { stage: 'wallet_read' });
        }
        if (this.externalActivity?.enabled()) {
            if (!witness.externalOrders || !Number.isFinite(witness.spendable) || witness.spendable < 0
                || witness.spendable > witness.balance || !Number.isFinite(witness.externalOrders.reservedPUSD)
                || witness.externalOrders.reservedPUSD < 0)
                throw new OperationalError('external_orders_unproven', 'opportunity', { stage: 'account_read' });
            if (witness.externalOrders.overlaps || witness.holdings.some(value => value > EPS))
                throw new OperationalError('external_market_overlap', 'opportunity', { stage: 'wallet_read' });
        } else if (witness.holdings.some(value => value > EPS)) {
            this.store.stop('legacy_inventory_overlap');
            throw new OperationalError('legacy_inventory_overlap', 'reconciliation', { stage: 'wallet_read' });
        }
    }
    async checkWallet(now = Date.now()) {
        try { return await this.readWallet(now); }
        catch (error) {
            if (this.position || !temporaryRpcFailure(error)) throw error;
            const e = classifyError(error);
            // Flat means no signed/submitted order or inventory to reconcile.
            // Skip the entire tick; no decision or reservation may run with an
            // unreadable wallet. Exposed/identity failures retain live stops.
            const now = Date.now();
            this.rpcRetryAt = now + 1000;
            if (!this.lastRpcWait || now - this.lastRpcWait >= 5000) {
                this.lastRpcWait = now;
                this.store.event('live_rpc_recovery_wait', { reason: e.code, category: e.category });
            }
            throw new OperationalError('rpc_wallet_read_unavailable', 'opportunity', { stage: 'wallet_read' });
        }
    }
    async waitForProtocolRedemption(block, now, account) {
        const position = this.position;
        if (!position || !Number.isFinite(now) || now < position.market.end || position.pendingTrades
            || position.holdings?.length !== 2
            || position.holdings.some(value => !Number.isFinite(value) || units(value) === null || value < 0)
            || position.holdings.filter(value => value > EPS).length !== 1
            || position.orders?.length !== 1 || position.orders[0].receiptProvenComplete !== true
            || !Number.isSafeInteger(block)) return false;
        const payout = await this.client.payoutAtBlock(position.market.conditionId, block);
        if (!Array.isArray(payout) || payout.length !== 2
            || ![[0, 1], [1, 0]].some(row => row.every((value, i) => value === payout[i]))
            || position.payout?.length !== 2 || !position.payout.every((value, i) => value === payout[i])) return false;
        const { actual, holdings } = account || { actual: await this.client.balance(block),
            holdings: await this.client.holdings(position.market.tokens, block) };
        const expected = expectedWalletBalance(this.store.state);
        const redemption = position.holdings.reduce((sum, value, i) => sum + units(value) * BigInt(payout[i]), 0n);
        if (!Number.isFinite(actual) || !Number.isFinite(expected) || units(actual) === null || units(expected) === null
            || units(actual) !== units(expected) + redemption || !Array.isArray(holdings) || holdings.length !== 2
            || holdings.some(value => !Number.isFinite(value) || units(value) !== 0n)) return false;
        const previous = position.autoRedeemWait;
        if (previous && (!Number.isFinite(previous.since) || now < previous.since || now - previous.since >= 120000)) {
            this.store.stop('auto_redeem_receipt_timeout'); return false;
        }
        if (!previous) {
            position.autoRedeemWait = { since: now, block, expectedPUSD: expected, actualPUSD: actual,
                holdings: [...position.holdings], payout: [...payout] };
            this.store.save();
            this.store.event('auto_redeem_receipt_wait', { block, expectedPUSD: expected, actualPUSD: actual });
        }
        return true;
    }
    async readWallet(now = Date.now(), exact = false) {
        this.lastWalletProof = null;
        if (!this.position && Date.now() < (this.rpcRetryAt || 0))
            throw new OperationalError('rpc_wallet_read_unavailable', 'opportunity', { stage: 'wallet_read' });
        if (this.store.state.walletStart === null && !this.store.state.externalWalletActivity
            && !this.store.state.profitTaking) return super.checkWallet();
        const block = (this.position ? this.reconcileBlock : undefined)
            ?? (this.client.confirmedBlock ? await this.client.confirmedBlock() : undefined);
        const anchor = this.client.rpc?.anchor;
        const blockHash = anchor && anchor.number === block ? anchor.hash : undefined;
        const actual = await this.client.balance(block);
        if (this.externalActivity?.enabled()) {
            // Bot fills/actions are reconciled first. Manual movements are
            // then booked separately before the wallet equation is evaluated.
            if (!await this.externalActivity.reconcile({ block, actual })) {
                if (this.position && await this.waitForProtocolRedemption(block, now)) return false;
                return false;
            }
        } else if (this.capitalDeposits?.enabled()) {
            await this.capitalDeposits.reconcile({ block, actual });
            if (actual > expectedWalletBalance(this.store.state) + EPS) {
                this.capitalDeposits.defer();
                return false;
            }
        }
        const expected = expectedWalletBalance(this.store.state);
        let matches = Number.isFinite(actual) && Number.isFinite(expected)
            && (exact ? units(actual) !== null && units(actual) === units(expected) : Math.abs(actual - expected) <= EPS);
        let holdings;
        if (this.position) {
            holdings = await this.client.holdings(this.position.market.tokens, block);
            matches &&= Array.isArray(holdings) && holdings.length === this.position.holdings.length
                && holdings.every((h, i) => Number.isFinite(h) && (exact
                    ? units(h) !== null && units(h) === units(this.position.holdings[i])
                    : Math.abs(h - this.position.holdings[i]) <= EPS));
        }
        if (!matches) {
            if (await this.waitForProtocolRedemption(block, now, { actual, holdings })) return false;
            if (this.externalActivity?.enabled()) {
                this.externalActivity.defer();
                this.store.event('external_wallet_verification_wait', { expectedPUSD: expected, actualPUSD: actual });
                return false;
            }
            this.reconciliationFault('wallet_ledger_mismatch', now);
            this.store.stop('wallet_ledger_mismatch');
            this.store.event('wallet_mismatch', { expectedPUSD: expected, actualPUSD: actual });
        }
        if (matches && this.position?.autoRedeemWait) {
            if (now - this.position.autoRedeemWait.since >= 120000) this.store.stop('auto_redeem_receipt_timeout');
            return false;
        }
        if (matches && blockHash && this.client.rpc?.anchor?.number === block && this.client.rpc.anchor.hash === blockHash) {
            const evidence = captureLossWalletEvidence(this.store.state,
                { balance: actual, blockNumber: block, blockHash, checkedAt: Date.now() });
            if (evidence) this.lastWalletProof = { position: this.position, evidence,
                holdings: Array.isArray(holdings) ? [...holdings] : null };
        }
        return matches;
    }
    async submit(spec, now) {
        const position = this.position;
        if (!position || position.submitAttemptedAt !== undefined || position.orders.length || position.actions.length) throw new Error('laya_duplicate_entry_attempt');
        position.submitAttemptedAt = now;
        this.store.event('laya_submit_reserved', { tokenId: spec.tokenId });
        try { await this.validate(spec); }
        catch (error) {
            this.store.event('laya_entry_expired', { reason: operationCode(error) });
            return { ...spec, status: 'rejected' };
        }
        // A prepare failure has not sent an order. The market reservation is
        // still retained, so restart will never make another attempt.
        let prepared;
        const prepareStartedAt = Date.now();
        try { prepared = await this.client.prepare(spec); }
        catch (error) {
            this.store.state.failures++; this.store.stop('order_preparation_failed');
            this.store.event('order_preparation_failed', { error: safeError(error) });
            return { ...spec, status: 'rejected' };
        }
        if (!prepared.orderId || !prepared.signed) { this.store.stop('prepared_order_identity_missing'); return { ...spec, status: 'rejected' }; }
        const order = { ...spec, ...prepared, submittedAt: now, status: 'prepared', prepareMs: Date.now() - prepareStartedAt,
            filled: 0, settled: 0, transactions: [], tradeIds: [] };
        position.orders.push(order);
        this.store.event('order_prepared', { orderId: order.orderId, side: order.side, price: order.price, shares: order.shares });
        try { order.execution = await this.validate(spec); }
        catch (error) {
            order.status = 'rejected';
            this.store.event('laya_entry_expired', { orderId: order.orderId, reason: operationCode(error) }); return order;
        }
        order.status = 'submitting'; order.postAttemptAt = Date.now();
        // Persist the only POST attempt before network I/O. No submit retry,
        // including after an ambiguous timeout or a process restart.
        this.store.event('order_submission_started', { orderId: order.orderId,
            execution: order.execution ?? null, prepareMs: order.prepareMs });
        try {
            const result = await this.client.post(order.signed);
            order.postRoundtripMs = Date.now() - order.postAttemptAt;
            this.store.event('order_submission_result', { orderId: order.orderId,
                roundtripMs: order.postRoundtripMs, ok: result.ok === true,
                code: result.ok ? null : result.code, httpStatus: result.httpStatus ?? null });
            if (!result.ok && result.code === 'unknown') {
                order.status = 'unknown'; this.store.state.failures++;
                this.store.stop('unknown_order_submission');
                this.store.event('submission_uncertain', { orderId: order.orderId, reason: 'unknown_api_order_status' });
            } else if (!result.ok) {
                order.status = 'rejected'; this.store.state.failures++;
                order.rejection = { code: result.code, httpStatus: result.httpStatus ?? null,
                    definiteRejection: result.definiteRejection === true };
                this.store.event('order_rejected', { orderId: order.orderId, ...order.rejection });
                if (result.definiteRejection && !isBenignNoFill(result)) this.store.stop('order_rejected');
            } else if (result.orderId?.toLowerCase() !== order.orderId.toLowerCase()) {
                order.status = 'unknown'; this.store.stop('order_identity_mismatch');
                this.store.event('submission_uncertain', { orderId: order.orderId, reason: 'order_identity_mismatch' });
            } else {
                order.status = 'accepted'; order.tradeIds = result.tradeIds || [];
                order.transactions = result.transactionsHashes || [];
                order.apiSubmissionStatus = result.status;
                this.store.event('order_accepted', { orderId: order.orderId, apiStatus: result.status });
            }
        } catch (error) {
            order.postRoundtripMs = Date.now() - order.postAttemptAt;
            order.status = 'unknown'; this.store.state.failures++;
            this.store.stop('unknown_order_submission');
            this.store.event('submission_uncertain', { orderId: order.orderId, error: safeError(error) });
        }
        return order;
    }
}
