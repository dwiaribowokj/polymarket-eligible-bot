import { EPS, round } from './math.js';
import { receiptMovements, safeError } from './client.js';
import { entryPlan } from './strategy.js';

const terminal = status => ['CANCELED', 'CANCELLED', 'MATCHED', 'FILLED', 'EXPIRED', 'UNMATCHED'].includes(String(status).toUpperCase());
const normalizeStatus = status => terminal(status) ? 'complete' : 'open';

export function ownedTradeParts(trade, orders) {
    const own = new Map(orders.map(order => [order.orderId.toLowerCase(), order]));
    if (trade.traderSide === 'TAKER') {
        const order = own.get(trade.takerOrderId?.toLowerCase());
        return order ? [{ order, shares: Number(trade.size), price: Number(trade.price) }] : [];
    }
    return (trade.makerOrders || []).flatMap(maker => {
        const order = own.get(maker.orderId?.toLowerCase());
        return order ? [{ order, shares: Number(maker.matchedAmount), price: Number(maker.price) }] : [];
    });
}

export class LiveBroker {
    constructor(settings, store, client) { Object.assign(this, { settings, store, client }); }
    get position() { return this.store.state.position; }
    async submit(spec, now) {
        const prepared = await this.client.prepare(spec);
        const order = { ...spec, ...prepared, submittedAt: now, status: 'submitting', filled: 0, settled: 0,
            transactions: [], tradeIds: [] };
        this.position.orders.push(order);
        // Persist the exact signed order and its hash BEFORE the only POST attempt.
        this.store.event('order_prepared', { orderId: order.orderId, side: order.side, price: order.price, shares: order.shares });
        try {
            if (spec.side === 'BUY' && spec.kind === 'taker' && this.client.books) {
                const books = await this.client.books(this.position.market,
                    { deadline: this.position.market.end - this.settings.late.minSeconds * 1000 });
                const plan = entryPlan('late-entry', this.position.market, books, this.settings, this.store.state.cash, Date.now());
                if (!plan || plan.orders[0].index !== spec.index) {
                    order.status = 'rejected'; this.store.event('late_signal_expired', { orderId: order.orderId }); return order;
                }
            }
            const result = await this.client.post(order.signed);
            if (!result.ok) {
                order.status = 'rejected'; this.store.state.failures++;
                this.store.event('order_rejected', { orderId: order.orderId, code: result.code });
            } else {
                if (result.orderId.toLowerCase() !== order.orderId.toLowerCase()) {
                    this.store.stop('order_identity_mismatch'); throw new Error('Order identity mismatch');
                }
                order.status = 'accepted'; order.tradeIds = result.tradeIds || [];
                order.transactions = result.transactionsHashes || [];
                this.store.event('order_accepted', { orderId: order.orderId, apiStatus: result.status });
            }
        } catch (err) {
            if (order.status === 'submitting') order.status = 'unknown';
            this.store.state.failures++;
            this.store.event('submission_uncertain', { orderId: order.orderId, error: safeError(err) });
            this.store.stop('unknown_order_submission');
        }
        return order;
    }
    async reconcile(books, now) {
        const position = this.position;
        if (!position) return;
        this.reconcileBlock = this.client.confirmedBlock ? await this.client.confirmedBlock() : undefined;
        const account = await this.client.ordersAndTrades(position.market);
        const known = new Set(position.orders.map(o => o.orderId.toLowerCase()));
        if (account.orders.some(o => !known.has(o.id.toLowerCase()))) this.store.stop('unowned_order_in_active_market');
        for (const order of position.orders) {
            if (order.status === 'rejected') continue;
            let api = account.orders.find(o => o.id.toLowerCase() === order.orderId.toLowerCase());
            if (!api) {
                try { api = await this.client.order(order.orderId); }
                catch (err) {
                    order.status = 'unknown'; this.store.stop('order_status_unknown');
                    this.store.event('order_query_retry', { orderId: order.orderId, error: safeError(err) });
                    continue;
                }
            }
            order.status = normalizeStatus(api.status);
            order.filled = Number(api.sizeMatched);
            if (!Number.isFinite(order.filled) || order.filled > order.shares + EPS) {
                this.store.stop('invalid_order_fill'); continue;
            }
        }
        const groups = new Map();
        const failedShares = new Map();
        let pendingTrades = false;
        for (const trade of account.trades) {
            const parts = ownedTradeParts(trade, position.orders);
            if (!parts.length) continue;
            if (parts.some(p => !Number.isFinite(p.shares) || p.shares <= 0 || !Number.isFinite(p.price)))
                throw new Error('Invalid owned trade');
            if (String(trade.status).toUpperCase() === 'FAILED') {
                for (const part of parts) failedShares.set(part.order.orderId, (failedShares.get(part.order.orderId) || 0) + part.shares);
                position.failedTrades ||= {};
                if (!position.failedTrades[trade.id]) {
                    position.failedTrades[trade.id] = true; this.store.state.failures++;
                    this.store.event('trade_settlement_failed', { tradeId: trade.id });
                }
                this.store.stop('trade_settlement_failed');
                continue;
            }
            const hash = trade.transactionHash;
            if (!hash) { pendingTrades = true; continue; }
            if (!groups.has(hash)) groups.set(hash, []);
            groups.get(hash).push({ trade, parts });
        }
        for (const [hash, group] of groups) {
            if (position.receipts[hash]) continue;
            const receipt = await this.client.receipt(hash);
            if (!receipt || receipt.confirmations < 2 || receipt.blockNumber > this.reconcileBlock) { pendingTrades = true; continue; }
            if (receipt.status !== 1) { pendingTrades = true; this.store.stop('trade_receipt_failed'); continue; }
            // Wait for every API row from the same settlement transaction before accounting once.
            if (group.some(g => String(g.trade.status).toUpperCase() !== 'CONFIRMED')) { pendingTrades = true; continue; }
            const movement = receiptMovements(receipt, this.settings.wallet, position.market.tokens);
            let notional = 0;
            const expected = [0, 0];
            for (const { parts } of group) for (const part of parts) {
                const sign = part.order.side === 'BUY' ? 1 : -1;
                expected[part.order.index] += sign * part.shares;
                notional -= sign * part.shares * part.price;
            }
            if (expected.some((v, i) => Math.abs(v - movement.holdings[i]) > EPS)) {
                // A transaction can contain additional rows not yet indexed, or unrelated wallet activity.
                pendingTrades = true;
                if (now - position.openedAt > 60000) this.store.stop('trade_receipt_mapping_mismatch');
                continue;
            }
            const fees = round(notional - movement.cash);
            if (fees < -EPS) { this.store.stop('unattributed_cash_in_settlement'); continue; }
            this.applyMovement(movement);
            position.fees = round(position.fees + Math.max(0, fees));
            position.receipts[hash] = { blockNumber: receipt.blockNumber, ...movement };
            for (const { trade, parts } of group) for (const part of parts) {
                part.order.settled = round(part.order.settled + part.shares);
                if (part.order.side === 'BUY') position.bought[part.order.index] = round(position.bought[part.order.index] + part.shares);
                position.fills.push({ tradeId: trade.id, orderId: part.order.orderId, hash,
                    shares: part.shares, price: part.price, settledAt: now });
            }
            if (notional < 0) position.entryCost = round(position.entryCost - movement.cash);
            this.store.event('fill_settled', { hash, cash: movement.cash, holdings: movement.holdings, fees });
        }
        for (const order of position.orders) {
            if (order.filled > order.settled + (failedShares.get(order.orderId) || 0) + EPS) pendingTrades = true;
        }
        position.pendingTrades = pendingTrades;
        position.pendingSince = pendingTrades ? position.pendingSince || now : null;
        if (pendingTrades && now - position.pendingSince >= 120000) this.store.stop('fill_settlement_timeout');
        for (const order of position.orders) {
            if (order.cancelSettled === false && now - order.cancelConfirmedAt >= this.settings.cancelReconcileMs
                && ['complete', 'cancelled'].includes(order.status) && !pendingTrades) order.cancelSettled = true;
        }
        if (position.entryCost > this.settings.entryCap + EPS) this.store.stop('entry_budget_exceeded');
        await this.reconcileActions(now);
        this.store.save();
    }
    applyMovement(movement) {
        const state = this.store.state, position = this.position;
        state.cash = round(state.cash + movement.cash);
        state.walletCashDelta = round((state.walletCashDelta || 0) + movement.cash);
        position.holdings = position.holdings.map((h, i) => round(h + movement.holdings[i]));
    }
    async cancelOwned() {
        for (const order of this.position?.orders || []) {
            if (['rejected', 'complete', 'cancelled'].includes(order.status)) continue;
            try {
                await this.client.cancel(order.orderId);
                order.status = 'cancelled';
                order.cancelConfirmedAt = Date.now(); order.cancelSettled = false;
                this.store.event('order_cancelled', { orderId: order.orderId });
            } catch (err) {
                this.store.stop('cancellation_unconfirmed');
                this.store.event('cancel_retry', { orderId: order.orderId, error: safeError(err) });
            }
        }
    }
    pending() {
        return !!this.position && (this.position.pendingTrades || this.position.orders.some(o =>
            !['rejected', 'complete', 'cancelled'].includes(o.status) || o.cancelSettled === false)
            || this.position.actions.some(a => ['prepared', 'pending', 'unknown', 'invalid'].includes(a.status)));
    }
    async action(kind, amount, now) {
        const position = this.position;
        if (position.pendingTrades || position.actions.some(a => ['prepared', 'pending', 'unknown', 'invalid'].includes(a.status))) return false;
        if (position.actions.filter(a => a.kind === kind && a.status === 'failed').length >= 3) {
            this.store.stop(`${kind}_retry_limit`); return false;
        }
        const last = position.actions.at(-1);
        if (last?.status === 'failed' && now - last.finishedAt < 30000) return false;
        // No retry with a new nonce until a prior attempt has a final failed receipt.
        const action = await this.client.prepareAction(position, kind, amount);
        position.actions.push(action);
        this.store.event(`${kind}_prepared`, { hash: action.hash, amount });
        await this.broadcast(action);
        return false;
    }
    async broadcast(action) {
        try {
            await this.client.broadcastAction(action); action.status = 'pending';
            this.store.event(`${action.kind}_submitted`, { hash: action.hash });
        } catch (err) {
            action.status = 'unknown'; this.store.state.failures++;
            this.store.event('transaction_submission_uncertain', { hash: action.hash, error: safeError(err) });
            this.store.stop('unknown_transaction');
        }
    }
    async reconcileActions(now) {
        for (const action of this.position.actions) {
            if (['confirmed', 'failed', 'invalid'].includes(action.status)) continue;
            const receipt = await this.client.receipt(action.hash);
            if (!receipt || receipt.confirmations < 2 || receipt.blockNumber > this.reconcileBlock) {
                // Re-broadcast only the persisted identical raw transaction; its hash and nonce are unchanged.
                if (now - (action.lastBroadcast || action.createdAt) > 30000) {
                    action.lastBroadcast = now; this.store.save(); await this.broadcast(action);
                }
                if (now - action.createdAt > 120000) this.store.stop('transaction_status_unknown');
                continue;
            }
            const gas = this.client.receiptGas(receipt, action.polUsd);
            action.gas = gas; action.finishedAt = now;
            this.position.gas = round(this.position.gas + gas);
            this.store.state.cash = round(this.store.state.cash - gas);
            if (!this.client.actionSucceeded(receipt)) {
                action.status = 'failed'; this.store.state.failures++;
                this.store.event(`${action.kind}_failed`, { hash: action.hash, gas });
                continue;
            }
            const movement = receiptMovements(receipt, this.settings.wallet, this.position.market.tokens);
            if (action.kind === 'merge') {
                if (Math.abs(movement.cash - action.amount) > EPS
                    || movement.holdings.some(h => Math.abs(h + action.amount) > EPS)) {
                    action.status = 'invalid'; this.store.stop('merge_receipt_mismatch'); continue;
                }
            } else {
                const expectedCash = this.position.holdings.reduce((s, h, i) => s + h * this.position.payout[i], 0);
                if (movement.holdings.some((h, i) => Math.abs(h + this.position.holdings[i]) > EPS)
                    || Math.abs(movement.cash - expectedCash) > EPS) {
                    action.status = 'invalid'; this.store.stop('redeem_receipt_mismatch'); continue;
                }
            }
            this.applyMovement(movement); action.status = 'confirmed'; delete action.raw;
            this.store.event(`${action.kind}_confirmed`, { hash: action.hash, cash: movement.cash, gas });
        }
    }
    async checkWallet() {
        const state = this.store.state;
        const block = (this.position ? this.reconcileBlock : undefined)
            ?? (this.client.confirmedBlock ? await this.client.confirmedBlock() : undefined);
        const balance = await this.client.balance(block);
        if (state.walletStart === null) {
            state.walletStart = balance; state.walletCashDelta = 0; this.store.save(); return true;
        }
        const expected = round(state.walletStart + (state.walletCashDelta || 0));
        let matches = Math.abs(balance - expected) <= EPS;
        if (this.position) {
            const holdings = await this.client.holdings(this.position.market.tokens, block);
            matches &&= holdings.every((h, i) => Math.abs(h - this.position.holdings[i]) <= EPS);
        }
        if (!matches) {
            this.store.stop('wallet_ledger_mismatch');
            this.store.event('wallet_mismatch', { expectedPUSD: expected, actualPUSD: balance });
        }
        return matches;
    }
}
