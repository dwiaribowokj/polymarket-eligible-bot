#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSettings, requireRuntime } from '../../src/restart/config.js';
import { atomicJson, acquireLock } from '../../src/restart/store.js';
import { EPS, fee, makerFill, round, sweep } from '../../src/restart/math.js';
import { TradeFeed } from '../../src/restart/feed.js';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { publicReader } from '../../src/laya-filter-paper/client.js';
import { BinanceLeadFeed } from './binance-feed.mjs';
import {
    ARM_DEFS,
    GAS_USD,
    LATENCY_MS,
    SHARES,
    SLOTS,
    buildMarketContext,
    evaluateArm,
} from './strategies.mjs';
import { CandidatePaperStore } from './store.mjs';

const SLOT_TOLERANCE_MS = 2000;

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'run', 'report'].includes(command)) {
        throw new Error('use_strategy_candidates_preflight_run_report');
    }
    const outFlag = flags.find(f => f.startsWith('--out='));
    if (!outFlag || !path.isAbsolute(outFlag.slice(6))) {
        throw new Error('absolute_output_dir_required');
    }
    return { command, out: path.resolve(outFlag.slice(6)) };
}

export class StrategyCandidatesEngine {
    constructor({ client, books, trades, binance, store, clock = Date.now }) {
        Object.assign(this, { client, books, trades, binance, store, clock });
        this.currentMarket = null;
        this.marketRetryAt = 0;
        this.labelRetryAt = new Map();
        this.pendingTakers = [];
        this.openMakers = [];
        this.closed = false;
        this.lastReportAt = 0;
        this.lastSlotSummary = null;
    }

    async discoverMarket(now) {
        const open = Math.floor(now / 300000) * 300000;
        const slug = `btc-updown-5m-${open / 1000}`;
        if (this.currentMarket?.slug === slug || now < this.marketRetryAt) return;
        this.marketRetryAt = now + 4000;
        try {
            const market = await this.client.market(slug, { deadline: now + 3000, retries: 0 });
            if (market && market.slug === slug && market.open === open && market.end === open + 300000) {
                this.currentMarket = market;
                this.books.watch(market.tokens, market);
                this.trades.watch(market.tokens);
            }
        } catch {
            // Transient discovery errors retry on next window.
        }
    }

    _processMakerTrades(now) {
        const events = this.trades.drain();
        if (!events.length || !this.openMakers.length) return;
        for (const ev of events) {
            for (const order of this.openMakers) {
                if (order.status !== 'open' || order.tokenId !== ev.tokenId) continue;
                const fill = makerFill(order, ev);
                if (fill > 0) {
                    order.notionalUsd = round(order.notionalUsd + fill * order.price);
                }
                if (order.status === 'filled') {
                    this.store.finalizeOrder(order.id, {
                        status: 'filled',
                        cancelReason: null,
                        filledShares: order.filled,
                        notionalUsd: order.notionalUsd,
                        feeUsd: 0,
                        gasUsd: GAS_USD,
                        closedAt: now,
                    });
                }
            }
        }
        this.openMakers = this.openMakers.filter(o => o.status === 'open');
    }

    _manageOpenMakers(now) {
        if (!this.openMakers.length) return;
        const remainingOpen = [];
        for (const order of this.openMakers) {
            if (order.status !== 'open') continue;
            const remainingSec = (order.marketEnd - now) / 1000;
            let cancelReason = null;
            if (remainingSec <= order.cancelAtRemainingSec) {
                cancelReason = 'timeout_cancel';
            } else if (
                order.adverseCancelBps !== null
                && now >= order.activeAt
                && this.binance.adverseMove(order.index, order.adverseLookbackMs, order.adverseCancelBps, now)
            ) {
                cancelReason = 'binance_adverse_cancel';
            }
            if (cancelReason) {
                order.status = 'canceled';
                const status = order.filled > EPS ? 'partial' : 'canceled';
                this.store.finalizeOrder(order.id, {
                    status,
                    cancelReason,
                    filledShares: order.filled,
                    notionalUsd: order.notionalUsd,
                    feeUsd: 0,
                    gasUsd: order.filled > EPS ? GAS_USD : 0,
                    closedAt: now,
                });
            } else {
                remainingOpen.push(order);
            }
        }
        this.openMakers = remainingOpen;
    }

    _executePendingTakers(now) {
        if (!this.pendingTakers.length) return;
        const stillPending = [];
        const snapshot = this.books.snapshot(now, false);
        for (const order of this.pendingTakers) {
            if (now < order.activeAt) {
                stillPending.push(order);
                continue;
            }
            if (now >= order.marketEnd) {
                this.store.finalizeOrder(order.id, {
                    status: 'expired',
                    cancelReason: 'market_ended',
                    filledShares: 0,
                    notionalUsd: 0,
                    feeUsd: 0,
                    gasUsd: 0,
                    closedAt: now,
                });
                continue;
            }
            const book = snapshot?.find(b => b.tokenId === order.tokenId);
            if (!book) {
                if (now - order.activeAt > 2000) {
                    this.store.finalizeOrder(order.id, {
                        status: 'no_fill',
                        cancelReason: 'book_unavailable_at_arrival',
                        filledShares: 0,
                        notionalUsd: 0,
                        feeUsd: 0,
                        gasUsd: 0,
                        closedAt: now,
                    });
                } else {
                    stillPending.push(order);
                }
                continue;
            }
            const result = sweep(book.asks, order.shares, order.limitPrice, 'BUY', order.feeSchedule);
            if (result.shares > EPS) {
                this.store.finalizeOrder(order.id, {
                    status: result.shares >= order.shares - EPS ? 'filled' : 'partial',
                    cancelReason: null,
                    filledShares: result.shares,
                    notionalUsd: result.notional,
                    feeUsd: result.fees,
                    gasUsd: GAS_USD,
                    closedAt: now,
                });
            } else {
                this.store.finalizeOrder(order.id, {
                    status: 'no_fill',
                    cancelReason: 'limit_unmarketable_at_arrival',
                    filledShares: 0,
                    notionalUsd: 0,
                    feeUsd: 0,
                    gasUsd: 0,
                    closedAt: now,
                });
            }
        }
        this.pendingTakers = stillPending;
    }

    _evaluateSlots(now) {
        const market = this.currentMarket;
        if (!market || now >= market.end) return;
        for (const seconds of SLOTS) {
            const scheduledAt = market.end - seconds * 1000;
            if (now < scheduledAt || now > scheduledAt + SLOT_TOLERANCE_MS) continue;
            if (this.store.hasSlot(market.slug, seconds)) continue;

            const books = this.books.snapshot(now, false);
            if (!books || books.length !== 2) continue;

            const ctx = buildMarketContext({
                market,
                books,
                btcPoints: this.client.btc?.spot ?? [],
                binance: this.binance,
                seconds,
                now,
            });
            if (!ctx) continue;

            const decisions = {};
            for (const def of ARM_DEFS) {
                const dec = evaluateArm(def, ctx);
                if (dec.action === 'SKIP') {
                    decisions[def.name] = dec;
                    continue;
                }
                const neededUsd = dec.execution === 'taker'
                    ? round(dec.shares * dec.limitPrice + fee(dec.shares, dec.limitPrice, market.fee, false) + GAS_USD)
                    : round(dec.shares * dec.price + GAS_USD);
                const gate = this.store.armCanEnter(def.name, market.slug, neededUsd);
                if (!gate.ok) {
                    decisions[def.name] = { action: 'SKIP', reason: gate.reason };
                    continue;
                }
                decisions[def.name] = dec;

                const activeAt = now + LATENCY_MS;
                if (dec.execution === 'taker') {
                    const id = this.store.createOrder({
                        arm: def.name,
                        slug: market.slug,
                        conditionId: market.conditionId,
                        marketEnd: market.end,
                        slotSeconds: seconds,
                        execution: 'taker',
                        index: dec.index,
                        side: dec.side,
                        tokenId: dec.tokenId,
                        shares: dec.shares,
                        price: dec.limitPrice,
                        queueAhead: 0,
                        createdAt: now,
                        activeAt,
                        status: 'pending_taker',
                    });
                    this.pendingTakers.push({
                        id,
                        arm: def.name,
                        slug: market.slug,
                        marketEnd: market.end,
                        tokenId: dec.tokenId,
                        shares: dec.shares,
                        limitPrice: dec.limitPrice,
                        feeSchedule: market.fee,
                        activeAt,
                    });
                } else {
                    const id = this.store.createOrder({
                        arm: def.name,
                        slug: market.slug,
                        conditionId: market.conditionId,
                        marketEnd: market.end,
                        slotSeconds: seconds,
                        execution: 'maker',
                        index: dec.index,
                        side: dec.side,
                        tokenId: dec.tokenId,
                        shares: dec.shares,
                        price: dec.price,
                        queueAhead: dec.queueAhead,
                        createdAt: now,
                        activeAt,
                        status: 'open_maker',
                    });
                    this.openMakers.push({
                        id,
                        arm: def.name,
                        slug: market.slug,
                        marketEnd: market.end,
                        index: dec.index,
                        tokenId: dec.tokenId,
                        shares: dec.shares,
                        price: dec.price,
                        queueAhead: dec.queueAhead,
                        filled: 0,
                        notionalUsd: 0,
                        status: 'open',
                        activeAt,
                        cancelAtRemainingSec: dec.cancelAtRemainingSec,
                        adverseCancelBps: dec.adverseCancelBps,
                        adverseLookbackMs: dec.adverseLookbackMs,
                    });
                }
            }

            this.store.recordSlot({
                slug: market.slug,
                marketEnd: market.end,
                seconds,
                at: now,
                context: {
                    sigma: ctx.sigma,
                    binance: ctx.binance,
                    sides: ctx.sides.map(s => ({
                        side: s.side,
                        bestBid: s.bestBid,
                        bestAsk: s.bestAsk,
                        imb3: s.imb3,
                        c5: s.c5,
                    })),
                },
                decisions,
            });
            this.lastSlotSummary = { slug: market.slug, seconds, at: now };
            console.log(JSON.stringify({
                type: 'candidate_slot',
                slug: market.slug,
                seconds,
                at: now,
                sigma: ctx.sigma,
                binanceRet5sBps: ctx.binance.ret5sBps !== null ? round(ctx.binance.ret5sBps) : null,
                actions: Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v.action === 'SKIP' ? `SKIP:${v.reason}` : `${v.action}(${v.execution}@${v.price ?? v.limitPrice})`])),
            }));
        }
    }

    async _resolveSettlements(now) {
        const pending = this.store.unsettledMarkets();
        for (const m of pending) {
            if (now < m.marketEnd + 5000) continue;
            const retryAt = this.labelRetryAt.get(m.conditionId) || 0;
            if (now < retryAt) continue;
            this.labelRetryAt.set(m.conditionId, now + 15000);
            try {
                const payout = await this.client.payout(m.conditionId);
                if (!Array.isArray(payout) || payout.length !== 2) continue;
                const outcome = payout[0] === 1 && payout[1] === 0 ? 'UP'
                    : payout[0] === 0 && payout[1] === 1 ? 'DOWN' : 'SPLIT';
                const settled = this.store.settleMarket({
                    conditionId: m.conditionId,
                    slug: m.slug,
                    marketEnd: m.marketEnd,
                    payout,
                    outcome,
                    resolvedAt: this.clock(),
                });
                this.labelRetryAt.delete(m.conditionId);
                if (settled > 0) {
                    console.log(JSON.stringify({ type: 'candidate_settled', slug: m.slug, outcome, ordersSettled: settled }));
                }
            } catch {
                // Retry on next interval.
            }
        }
    }

    writeReport(now = this.clock()) {
        const report = this.store.report({
            now,
            health: {
                market: this.currentMarket?.slug ?? null,
                books: this.books.status(now),
                tradesReady: this.trades.ready,
                btc: this.client.btcStatus?.() ?? null,
                binance: this.binance.status(now),
                lastSlot: this.lastSlotSummary,
            },
        });
        atomicJson(path.join(this.store.directory, 'report.json'), report);
        return report;
    }

    async tick() {
        if (this.closed) return;
        const startNow = this.clock();
        this.client.startBtcFeed();
        this.binance.start();
        this.trades.reconnect();
        await this.discoverMarket(startNow);
        const now = this.clock();
        this._processMakerTrades(now);
        this._manageOpenMakers(now);
        this._executePendingTakers(now);
        this._evaluateSlots(now);
        await this._resolveSettlements(this.clock());
        const reportNow = this.clock();
        if (reportNow - this.lastReportAt >= 15000) {
            this.lastReportAt = reportNow;
            this.writeReport(reportNow);
        }
    }

    close() {
        this.closed = true;
        this.books.close();
        this.trades.close();
        this.binance.close();
        this.client.close();
    }
}

export async function preflight(client, binance) {
    const checks = [];
    const runCheck = async (name, fn) => {
        try { checks.push({ name, ok: true, detail: await fn() }); }
        catch (e) { checks.push({ name, ok: false, reason: e.message }); }
    };
    client.startBtcFeed();
    binance.start();
    await runCheck('polymarket_clock', async () => {
        const t = await client.serverTime();
        if (!Number.isFinite(t)) throw new Error('clock_unavailable');
        return { serverTime: t };
    });
    await runCheck('active_btc_5m_market', async () => {
        const slug = `btc-updown-5m-${Math.floor(Date.now() / 300000) * 300}`;
        const m = await client.market(slug, { deadline: Date.now() + 5000, retries: 0 });
        return { slug: m.slug, feeRate: m.fee?.rate, takerOnly: m.fee?.takerOnly };
    });
    await runCheck('binance_ws_lead_feed', async () => {
        const until = Date.now() + 8000;
        while (Date.now() < until && !binance.latest()) await delay(100);
        const latest = binance.latest();
        if (!latest) throw new Error('binance_feed_unavailable');
        return { mid: latest.mid, connected: binance.connected };
    });
    await runCheck('chainlink_btc_feed', async () => {
        const until = Date.now() + 12000;
        while (Date.now() < until && !client.btcStatus()?.ready) await delay(100);
        const st = client.btcStatus();
        if (!st?.ready) throw new Error('chainlink_feed_unavailable');
        return { spot: st.spot, twap: st.twap };
    });
    return { ready: checks.every(c => c.ok), readOnly: true, liveTransactions: 0, checks };
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    requireRuntime();
    if (args.command === 'report') {
        const fs = await import('node:fs');
        console.log(fs.readFileSync(path.join(args.out, 'report.json'), 'utf8'));
        return;
    }
    const settings = loadSettings(process.env, 'late-entry');
    const client = publicReader(settings);
    const binance = new BinanceLeadFeed();
    if (args.command === 'preflight') {
        try {
            const res = await preflight(client, binance);
            console.log(JSON.stringify(res, null, 2));
            if (!res.ready) process.exitCode = 1;
        } finally {
            binance.close();
            client.close();
        }
        return;
    }
    process.umask(0o077);
    const release = await acquireLock(args.out, 'strategy-candidates-paper');
    const store = new CandidatePaperStore({ directory: args.out });
    store.expireOrphanedOpenOrders(Date.now());
    const books = new LiveBookHistory();
    const trades = new TradeFeed();
    const engine = new StrategyCandidatesEngine({ client, books, trades, binance, store });
    let ending = false;
    const stop = () => { ending = true; engine.closed = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
        engine.writeReport(Date.now());
        while (!ending) {
            await engine.tick();
            await delay(150);
        }
    } finally {
        try { engine.writeReport(Date.now()); } catch { /* ignore */ }
        engine.close();
        store.close();
        await release();
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main().catch(err => {
        console.error(JSON.stringify({ type: 'strategy_candidates_failed', message: err.message }));
        process.exitCode = 1;
    });
}
