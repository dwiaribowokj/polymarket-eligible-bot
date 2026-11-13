import crypto from 'node:crypto';
import { EPS, fee, makerFill, round, sweep } from './math.js';
import { entryPlan, lateEntrySkipReason } from './strategy.js';
import { bookEvidence, quoteQuality } from './evidence.js';

export class PaperBroker {
    constructor(settings, store, client, feed) { Object.assign(this, { settings, store, client, feed }); }
    get position() { return this.store.state.position; }
    async submit(spec, now) {
        const order = { ...spec, orderId: `paper-${crypto.randomUUID()}`, status: 'pending',
            submittedAt: now, activeAt: now + this.settings.latencyMs, filled: 0, settled: 0, queueAhead: 0 };
        if (spec.side === 'BUY' && (this.store.state.frozenAt
            || this.settings.evaluationEndsAt && now >= this.settings.evaluationEndsAt)) order.status = 'cancelled';
        this.position.orders.push(order);
        this.store.event('order_pending', { slug: this.position.market.slug, orderId: order.orderId,
            tokenId: order.tokenId, index: order.index, side: order.side, price: order.price,
            shares: order.shares, submittedAt: now, activeAt: order.activeAt });
        return order;
    }
    applyFill(order, shares, cash, fees, now) {
        if (shares <= EPS) return;
        const position = this.position;
        position.holdings[order.index] = round(position.holdings[order.index] + (order.side === 'BUY' ? shares : -shares));
        if (order.side === 'BUY') {
            position.bought[order.index] = round(position.bought[order.index] + shares);
            position.entryCost = round(position.entryCost - cash);
        }
        position.fees = round(position.fees + fees);
        this.store.state.cash = round(this.store.state.cash + cash);
        order.settled = round(order.settled + shares);
        const price = round(order.side === 'BUY' ? (-cash - fees) / shares : (cash + fees) / shares);
        position.fills.push({ orderId: order.orderId, tokenId: order.tokenId, index: order.index,
            side: order.side, price, shares, cash, fees, matchedAt: order.matchedAt, at: now, settledAt: now });
        this.store.event('fill_settled', { slug: position.market.slug, orderId: order.orderId,
            tokenId: order.tokenId, index: order.index, price, shares, cash, fees, matchedAt: order.matchedAt, settledAt: now });
    }
    stageFill(order, shares, cash, fees, now) {
        if (shares <= EPS) return;
        order.matchedAt = now;
        this.position.pendingFills ||= [];
        this.position.pendingFills.push({ orderId: order.orderId, shares, cash, fees,
            matchedAt: now, settleAt: now + this.settings.paperSettlementMs });
        this.store.event('fill_matched', { orderId: order.orderId, shares, settleAt: now + this.settings.paperSettlementMs });
    }
    async reconcile(books, now) {
        now = Math.max(now, Date.now());
        const position = this.position;
        if (!position) return;
        for (const fill of position.pendingFills || []) {
            if (now < fill.settleAt || fill.done) continue;
            const order = position.orders.find(o => o.orderId === fill.orderId);
            fill.done = true;
            this.applyFill(order, fill.shares, fill.cash, fill.fees, now);
        }
        position.pendingFills = (position.pendingFills || []).filter(f => !f.done);
        const cutoff = this.store.state.frozenAt || (this.settings.evaluationEndsAt
            && now >= this.settings.evaluationEndsAt ? this.settings.evaluationEndsAt : null);
        const trades = this.feed.drain().filter(trade => !cutoff || trade.at <= cutoff);
        for (const order of position.orders) {
            if (cutoff && order.status === 'pending' && order.side === 'BUY') {
                order.status = 'cancelled'; this.store.event('order_cancelled', { orderId: order.orderId, reason: 'evaluation_deadline' });
            }
            if (order.status === 'pending' && now >= order.activeAt && books) {
                const book = books[order.index];
                this.store.event('execution_snapshot', { ...bookEvidence(position.market, books, now),
                    orderId: order.orderId, tokenId: order.tokenId, index: order.index, limit: order.price,
                    submittedAt: order.submittedAt, activeAt: order.activeAt,
                    effectiveLatencyMs: now - order.submittedAt });
                if (order.kind === 'maker') {
                    if (!this.feed.ready || book.asks[0]?.price <= order.price + EPS) {
                        order.status = 'rejected'; this.store.state.failures++;
                        this.store.event('postonly_rejected', { orderId: order.orderId });
                    } else {
                        // Retain all better-priced and equal-priced resting volume ahead of us.
                        order.queueAhead = book.bids.filter(l => l.price >= order.price - EPS).reduce((s, l) => s + l.size, 0);
                        order.activeAt = now; order.status = 'open';
                        this.store.event('maker_active', { orderId: order.orderId, queueAhead: order.queueAhead });
                    }
                } else {
                    const signal = order.side === 'BUY' && this.settings.lateSignal
                        ? this.client.assessEntry?.(position.market, order, now) || { reason: 'btc_feed_unavailable' } : null;
                    const plan = order.side === 'BUY' ? entryPlan('late-entry', position.market,
                        books, this.settings, this.store.state.cash, now) : null;
                    // Initial depth must cover five shares. At execution, reduced depth may partially fill the original FAK.
                    const quality = order.side === 'BUY' ? quoteQuality({ orders: [order] }, books,
                        this.settings, { requireDepth: false }) : null;
                    const reason = order.side !== 'BUY' ? null : signal?.reason || quality?.reason
                        || (!plan ? lateEntrySkipReason(position.market, books, this.settings, this.store.state.cash, now)
                            : plan.orders[0].index !== order.index ? 'dominant_side_changed' : null);
                    this.store.event('execution_rechecked', { orderId: order.orderId, reason, quality, signal,
                        limit: order.price, executableAsk: book.asks[0]?.price ?? null });
                    if (reason) { order.status = 'expired'; this.store.event('late_signal_expired', { orderId: order.orderId, reason, quality, signal }); }
                    else {
                        if (order.side === 'BUY') order.executionSignal = signal;
                        const fill = sweep(order.side === 'BUY' ? book.asks : book.bids, order.shares,
                            order.price, order.side, position.market.fee);
                        order.filled = fill.shares; order.status = 'complete';
                        this.stageFill(order, fill.shares, fill.cash, fill.fees, now);
                        this.store.event('fak_complete', { orderId: order.orderId, filled: fill.shares, requested: order.shares });
                    }
                }
            }
            if (order.status === 'open' && books) {
                for (const trade of trades.filter(t => t.tokenId === order.tokenId)) {
                    const fill = makerFill(order, trade);
                    const fees = fee(fill, order.price, position.market.fee, true);
                    this.stageFill(order, fill, round(-fill * order.price - fees), fees, now);
                }
            }
        }
        this.store.save();
    }
    async cancelOwned() {
        for (const order of this.position?.orders || []) {
            if (['open', 'pending'].includes(order.status)) {
                order.status = 'cancelled'; this.store.event('order_cancelled', { orderId: order.orderId });
            }
        }
    }
    pending() { return !!this.position && (this.position.orders.some(o => ['pending', 'open'].includes(o.status))
        || (this.position.pendingFills || []).length > 0); }
    async action(kind, amount, now) {
        const position = this.position;
        if (kind === 'redeem' && !position.payout) return false;
        const cash = kind === 'merge' ? amount : position.holdings.reduce((s, h, i) => s + h * position.payout[i], 0);
        if (kind === 'merge') position.holdings = position.holdings.map(h => round(h - amount));
        else position.holdings = [0, 0];
        position.gas = round(position.gas + this.settings.paperGasUsd);
        this.store.state.cash = round(this.store.state.cash + cash - this.settings.paperGasUsd);
        position.actions.push({ kind, amount, cash, gas: this.settings.paperGasUsd, at: now, status: 'confirmed' });
        this.store.event(`${kind}_confirmed`, { amount, cash, gas: this.settings.paperGasUsd });
        return true;
    }
    async checkWallet() { return true; }
}
