import { TradeFeed } from './feed.js';
import { PaperBroker } from './paper.js';
import { LiveBroker } from './live.js';
import { EPS, equity, riskReason, round } from './math.js';
import { accrueCapital, duration, entryPlan, lateEntrySkipReason, marketSlug, newPosition } from './strategy.js';
import { safeError } from './client.js';
import { TRANSPORT, OperationalError } from './network.js';
import { bookEvidence, quoteQuality, QuoteStability } from './evidence.js';

export class Engine {
    constructor(settings, store, client, feed = new TradeFeed()) {
        Object.assign(this, { settings, store, client, feed });
        this.broker = store.state.mode === 'paper' ? new PaperBroker(settings, store, client, feed)
            : new LiveBroker(settings, store, client);
        this.marketCache = null; this.lastHeartbeat = 0; this.lastClockCheck = 0;
        this.feedGeneration = feed.generation; this.booted = false;
        this.quoteStability = new QuoteStability();
    }
    nextDelay(now = Date.now()) {
        const pending = this.store.state.position?.orders.filter(o => o.status === 'pending') || [];
        const waits = pending.map(o => o.activeAt - now).filter(ms => ms > 0);
        return Math.min(1000, ...waits);
    }
    async boot() {
        if (this.booted) return;
        const state = this.store.state;
        if (state.mode === 'paper' && state.position?.orders.some(o => ['pending', 'open'].includes(o.status))) {
            this.invalidate('restart_during_pending_execution'); await this.broker.cancelOwned();
        }
        if (state.position && state.strategy === 'maker-mm') this.feed.watch(state.position.market.tokens);
        this.feedGeneration = this.feed.generation;
        this.booted = true;
        this.store.event('resumed', { activeMarket: state.position?.market.slug ?? null, stopped: state.stopped });
    }
    invalidate(reason) {
        const state = this.store.state;
        if (state.position && !state.position.uncertain) {
            state.position.uncertain = true; state.dataGaps++;
            this.store.event('execution_data_gap', { reason });
        }
    }
    skip(reason, now = Date.now()) {
        const state = this.store.state, slug = marketSlug(state.strategy, this.settings, now);
        state.skipped ||= {};
        const row = state.skipped[slug] ||= { at: now, reasons: [] };
        if (row.reasons.includes(reason)) return;
        row.reasons.push(reason); this.store.event('entry_check_skipped', { slug, reason });
    }
    async tick(now = Date.now()) {
        await this.boot();
        const state = this.store.state;
        if (state.strategy === 'late-entry' && this.settings.lateSignal) this.client.startBtcFeed?.();
        if (state.mode === 'paper' && this.settings.evaluationEndsAt && now >= this.settings.evaluationEndsAt && !state.frozenAt) {
            state.frozenAt = this.settings.evaluationEndsAt;
            this.store.event('paper_trial_frozen', { reason: 'scheduled_deadline', deadline: new Date(state.frozenAt).toISOString() });
        }
        try {
            if (now - this.lastClockCheck > 30000) {
                const before = Date.now(), server = await this.client.serverTime(), after = Date.now();
                if (Math.abs(server - (before + after) / 2) > this.settings.maxClockSkewMs
                    || after - before > this.settings.maxDataAgeMs) throw new Error('Invalid server clock');
                this.lastClockCheck = now;
            }
            let books = null;
            if (state.position) {
                const p = state.position;
                accrueCapital(p, now);
                if (state.strategy === 'maker-mm') this.feed.reconnect();
                if (state.strategy === 'maker-mm' && state.mode === 'paper'
                    && this.feed.generation !== this.feedGeneration && this.broker.pending()) {
                    this.invalidate('maker_feed_disconnected'); await this.broker.cancelOwned();
                }
                this.feedGeneration = this.feed.generation;
                const needBooks = state.strategy === 'maker-mm' || this.broker.pending()
                    || !p.lastBookAttempt || now - p.lastBookAttempt >= TRANSPORT.markMs;
                if (now < p.market.end && needBooks) {
                    p.lastBookAttempt = now;
                    try { books = await this.client.books(p.market); }
                    catch (err) {
                        if (state.mode === 'pilot') state.stopped || this.store.stop('stale_market_data');
                        else if (this.broker.pending()) { this.invalidate('stale_market_data'); await this.broker.cancelOwned(); }
                        this.store.event('book_retry', { error: safeError(err) });
                    }
                }
                await this.broker.reconcile(books, now);
                if (state.mode === 'pilot') await this.broker.checkWallet();
                if (books) p.markBooks = books.map(b => ({ bids: b.bids.slice(0, 30) }));
                // After trading closes, retain the last quote until official payout replaces it.
                // Capital being locked is not itself a realized loss or drawdown.
                const pairs = Math.min(...p.holdings);
                const mark = p.payout ? state.cash + p.holdings.reduce((s, h, i) => s + h * p.payout[i], 0)
                    : Math.max(equity(state, books || p.markBooks), state.cash + pairs);
                const reason = riskReason(state, this.settings, now, mark);
                if (reason) this.store.stop(reason);
                if (state.stopped || state.frozenAt) await this.broker.cancelOwned();
                await this.manage(books, now);
                if (state.position) {
                    p.lastDeployed = Math.max(0, p.startingCash - state.cash);
                    p.oneSided ||= Math.abs(p.holdings[0] - p.holdings[1]) > EPS;
                }
            } else {
                const reason = riskReason(state, this.settings, now, state.cash);
                if (reason) this.store.stop(reason);
                if (state.mode === 'pilot') await this.broker.checkWallet();
                const completed = state.completed.filter(r => r.traded);
                if (state.mode === 'paper' && !this.settings.evaluationEndsAt && !state.frozenAt
                    && now - state.startedAt >= this.settings.minDays * 86400000
                    && completed.length >= this.settings.minMarkets
                    && new Set(completed.map(r => new Date(r.closedAt).toISOString().slice(0, 10))).size >= this.settings.minDays) {
                    state.frozenAt = now; this.store.event('paper_trial_frozen', { completed: completed.length });
                }
                if (!state.stopped && !state.frozenAt) await this.discover(now);
            }
            state.lastTickAt = now;
            if (now - this.lastHeartbeat >= 60000) {
                this.lastHeartbeat = now;
                this.store.event('heartbeat', { cash: state.cash, activeMarket: state.position?.market.slug ?? null,
                    holdings: state.position?.holdings ?? [0, 0], completed: state.completed.filter(r => r.traded).length,
                    stopped: state.stopped, btcFeed: this.client.btcStatus?.() || null,
                    shadowPilotStop: state.shadowPilotStop || null });
            } else this.store.save();
        } catch (err) {
            const error = safeError(err);
            if (!state.position && error.category === 'opportunity') {
                this.quoteStability.reset(); this.skip(error.code);
                this.store.event('entry_window_missed', { error });
                return;
            }
            state.failures++;
            if (!state.position) { this.quoteStability.reset(); this.skip(error.code); }
            if (state.mode === 'pilot') this.store.stop('operational_check_failed');
            else if (state.position && this.broker.pending()) this.invalidate('request_failed_with_pending_order');
            this.store.event('retry', { error });
            if (state.stopped || state.position?.uncertain) await this.broker.cancelOwned();
        }
    }
    async discover(now) {
        const state = this.store.state, strategy = state.strategy;
        if (state.mode === 'paper' && this.settings.evaluationEndsAt && Date.now() >= this.settings.evaluationEndsAt) return;
        const slug = marketSlug(strategy, this.settings, now);
        if (state.seen[slug]) return;
        const seconds = duration(strategy, this.settings);
        const elapsed = now / 1000 % seconds;
        if (strategy === 'late-entry' && (seconds - elapsed > this.settings.late.maxSeconds
            || seconds - elapsed < this.settings.late.minSeconds)) return;
        if (strategy === 'maker-mm' && (elapsed < this.settings.maker.delaySeconds
            || elapsed > this.settings.maker.entrySeconds)) return;
        const start = Math.floor(now / 1000 / seconds) * seconds * 1000;
        const deadline = strategy === 'late-entry' ? start + (seconds - this.settings.late.minSeconds) * 1000
            : start + this.settings.maker.entrySeconds * 1000;
        if (this.marketCache?.slug !== slug) this.marketCache = await this.client.market(slug, { deadline });
        const market = this.marketCache;
        if (market.end - market.open !== seconds * 1000) throw new OperationalError('market_duration_mismatch', 'validation', { stage: 'market_discovery' });
        if (strategy === 'maker-mm' && state.mode === 'paper') {
            this.feed.watch(market.tokens); this.feed.reconnect();
            this.feedGeneration = this.feed.generation;
            if (!this.feed.ready) return;
        }
        const books = await this.client.books(market, { deadline });
        if (state.mode === 'paper' && this.settings.evaluationEndsAt && Date.now() >= this.settings.evaluationEndsAt) return;
        const plan = entryPlan(strategy, market, books, this.settings, state.cash, Date.now());
        const checkedAt = Date.now();
        let quality = {}, stability = {}, signal = {}, reason = plan ? null : strategy === 'late-entry'
            ? lateEntrySkipReason(market, books, this.settings, state.cash, checkedAt) : 'no_entry_signal';
        if (strategy === 'late-entry' && this.settings.lateQuality) {
            if (plan) {
                quality = quoteQuality(plan, books, this.settings); reason = quality.reason;
                if (!reason) { stability = this.quoteStability.observe(slug, plan.orders[0].index,
                    plan.orders[0].price, checkedAt, this.settings.lateQuality); reason = stability.reason; }
            }
            if (!plan || quality.reason) this.quoteStability.reset();
        }
        if (plan && strategy === 'late-entry' && this.settings.lateSignal) {
            signal = this.client.assessEntry?.(market, plan.orders[0], Date.now()) || { reason: 'btc_feed_unavailable' };
            reason ||= signal.reason;
        }
        this.store.event('entry_observed', { ...bookEvidence(market, books, checkedAt),
            reason, quality, stability, signal, orders: plan?.orders || [], estimatedCost: plan?.cost ?? null });
        if (reason) { this.skip(reason, checkedAt); return; }
        if (state.mode === 'pilot') {
            if (!await this.broker.checkWallet()) return;
            const holdings = await this.client.holdings(market.tokens);
            if (holdings.some(h => h > EPS)) { this.store.stop('legacy_inventory_overlap'); return; }
        }
        state.seen[slug] = { at: Date.now(), cost: plan.cost };
        state.position = newPosition(market, plan, state, Date.now());
        state.position.entrySignal = signal;
        this.store.event('entry_reserved', { slug, cost: plan.cost, remainingSeconds: (market.end - Date.now()) / 1000,
            orders: plan.orders, quality, stability, signal });
        for (const spec of plan.orders) {
            if (state.stopped) break;
            const order = await this.broker.submit(spec, Date.now());
            if (order.status === 'rejected') break;
        }
    }
    async manage(books, now) {
        const state = this.store.state, p = state.position;
        if (!p) return;
        const cutting = state.strategy === 'maker-mm' && (now >= p.market.end - this.settings.maker.cutSeconds * 1000 || state.stopped || state.frozenAt
            || p.orders.some(o => o.status === 'rejected'));
        if (cutting) { p.cutting = true; await this.broker.cancelOwned(); }
        if (state.strategy === 'maker-mm' && !p.pendingTrades && !p.actions.some(a => ['prepared', 'pending', 'unknown', 'invalid'].includes(a.status))
            && (cutting || !this.broker.pending())) {
            const pairs = Math.min(...p.holdings);
            if (pairs > EPS) await this.broker.action('merge', pairs, now);
        }
        if (cutting && !this.broker.pending() && books && now < p.market.end) {
            for (let index = 0; index < 2; index++) {
                const shares = Math.floor((p.holdings[index] + 1e-9) * 100) / 100;
                if (p.exitAttempted[index] || shares < p.market.minimum - EPS || !books[index].bids.length) continue;
                p.exitAttempted[index] = true; this.store.save();
                // One capped FAK exit per side. Unsold and sub-minimum inventory stays exposed.
                await this.broker.submit({ tokenId: p.market.tokens[index], index, side: 'SELL',
                    price: books[index].bids[0].price, shares, kind: 'taker' }, now);
            }
        }
        const payoutDelay = Math.min(TRANSPORT.payoutMaxMs, TRANSPORT.payoutMs * 2 ** (p.payoutFailures || 0));
        if (now >= p.market.end && !p.payout && (!p.lastPayoutCheck || now - p.lastPayoutCheck >= payoutDelay)) {
            p.lastPayoutCheck = now;
            if (this.broker.pending()) await this.broker.cancelOwned();
            try {
                p.payout = await this.client.payout(p.market.conditionId); p.payoutFailures = 0;
            } catch (error) {
                p.payoutFailures = Math.min(2, (p.payoutFailures || 0) + 1); state.failures++;
                if (state.mode === 'pilot') this.store.stop('operational_check_failed');
                this.store.event('payout_retry', { error: safeError(error, { stage: 'official_payout' }), nextDelayMs:
                    Math.min(TRANSPORT.payoutMaxMs, TRANSPORT.payoutMs * 2 ** p.payoutFailures) });
            }
            if (p.payout) this.store.event('official_resolution', { payout: p.payout, conditionId: p.market.conditionId });
        }
        if (p.payout && !this.broker.pending() && p.holdings.some(h => h > EPS)) await this.broker.action('redeem', 0, now);
        if (!this.broker.pending() && p.holdings.every(h => Math.abs(h) < EPS)) this.finish(now);
    }
    finish(now) {
        const state = this.store.state, p = state.position;
        accrueCapital(p, now);
        const row = { slug: p.market.slug, conditionId: p.market.conditionId, openedAt: p.openedAt,
            closedAt: now, traded: p.bought.some(h => h > EPS), pnl: round(state.cash - p.startingCash),
            fees: p.fees, gas: p.gas, rebate: p.rebate, capitalHours: round(p.capitalHours),
            partial: p.orders.some(o => o.settled > EPS && o.settled < o.shares - EPS),
            oneSided: p.oneSided, uncertain: p.uncertain, payout: p.payout };
        row.tokens = p.market.tokens; row.outcomes = p.market.outcomes; row.entryCost = p.entryCost;
        row.orders = p.orders.map(o => ({ orderId: o.orderId, tokenId: o.tokenId, index: o.index,
            side: o.side, price: o.price, shares: o.shares, filled: o.filled, settled: o.settled,
            submittedAt: o.submittedAt, matchedAt: o.matchedAt ?? null, status: o.status,
            executionSignal: o.executionSignal || null }));
        row.fills = p.fills;
        row.entrySignal = p.entrySignal || null;
        state.completed.push(row); state.position = null;
        this.feed.close(); this.store.event('market_complete', row);
        const reason = riskReason(state, this.settings, now, state.cash);
        if (reason) this.store.stop(reason);
    }
    async shutdown() {
        if (this.store.state.position) {
            if (this.store.state.mode === 'paper' && this.store.state.position.orders.some(o => ['pending', 'open'].includes(o.status)))
                this.invalidate('shutdown_with_pending_order');
            await this.broker.cancelOwned();
        }
        this.store.event('shutdown', { activeMarket: this.store.state.position?.market.slug ?? null });
        this.feed.close();
    }
}
