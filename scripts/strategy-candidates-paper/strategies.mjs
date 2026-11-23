import { EPS, fee, round, sweep } from '../../src/restart/math.js';

export const PROTOCOL_VERSION = 'strategy-candidates-v1';
export const SLOTS = Object.freeze([90, 60, 30]);
export const SHARES = 5;
export const GAS_USD = 0.05;
export const LATENCY_MS = 250;
export const INITIAL_CASH = 20;
export const DRAWDOWN_STOP = 10;
export const MIN_EVAL_DAYS = 7;
export const MIN_EVAL_COMPLETED = 100;

export const HIGH_VOL_SIGMA_USD = 3.39;
export const MIN_BOOK_IMBALANCE = -0.2;
export const LEAD_VETO_LOOKBACK_MS = 5000;
export const LEAD_VETO_BPS = 1.5;
export const ADVERSE_CANCEL_LOOKBACK_MS = 3000;
export const ADVERSE_CANCEL_BPS = 2.0;

export const ARM_DEFS = Object.freeze([
    Object.freeze({
        name: 'control_fav_taker',
        description: 'Live baseline: fav ask>=0.70, c5<=0.82, slots [90,60,30], taker',
        slots: [90, 60, 30],
        execution: 'taker',
        shares: SHARES,
    }),
    Object.freeze({
        name: 'contrarian_dog_60_taker',
        description: 'Underdog 0.15-0.45 at slot 60s, taker',
        slots: [60],
        execution: 'taker',
        shares: SHARES,
    }),
    Object.freeze({
        name: 'contrarian_dog_60_maker',
        description: 'Underdog 0.15-0.45 at slot 60s, maker post-only @ bestBid (0% fee, cancel @15s)',
        slots: [60],
        execution: 'maker',
        shares: SHARES,
        cancelAtRemainingSec: 15,
        adverseCancelBps: null,
        adverseLookbackMs: null,
    }),
    Object.freeze({
        name: 'fav_90_filtered_taker',
        description: 'Fav 0.70-0.82 at slot 90s + high-vol + non-ask-heavy + Binance lead-veto, taker',
        slots: [90],
        execution: 'taker',
        shares: SHARES,
    }),
    Object.freeze({
        name: 'fav_90_filtered_maker',
        description: 'Fav 0.70-0.82 at slot 90s + high-vol + non-ask-heavy + Binance lead-veto, maker @ bestBid + adverse cancel',
        slots: [90],
        execution: 'maker',
        shares: SHARES,
        cancelAtRemainingSec: 20,
        adverseCancelBps: ADVERSE_CANCEL_BPS,
        adverseLookbackMs: ADVERSE_CANCEL_LOOKBACK_MS,
    }),
    Object.freeze({
        name: 'late_lock_60_maker',
        description: 'Extreme fav 0.90-0.98 at slot 60s + Binance lead-veto, maker @ bestBid + adverse cancel',
        slots: [60],
        execution: 'maker',
        shares: SHARES,
        cancelAtRemainingSec: 15,
        adverseCancelBps: ADVERSE_CANCEL_BPS,
        adverseLookbackMs: ADVERSE_CANCEL_LOOKBACK_MS,
    }),
]);

export const ARM_NAMES = Object.freeze(ARM_DEFS.map(a => a.name));

export function computeSigma(spotPoints, now, lookbackMs = 180000, maxGapMs = 5000) {
    if (!Array.isArray(spotPoints) || spotPoints.length < 10) return null;
    const latest = spotPoints.at(-1);
    if (!latest || now - latest.at > maxGapMs) return null;
    const history = spotPoints.filter(p => p.at >= latest.at - lookbackMs && p.at <= latest.at);
    if (history.length < Math.ceil(lookbackMs / maxGapMs) * 0.5) return null;
    if (history.at(-1).at - history[0].at < lookbackMs - 5000) return null;
    let variance = 0, elapsed = 0;
    for (let i = 1; i < history.length; i++) {
        const dt = (history[i].at - history[i - 1].at) / 1000;
        if (dt <= 0 || dt * 1000 > maxGapMs) return null;
        variance += (history[i].value - history[i - 1].value) ** 2;
        elapsed += dt;
    }
    return elapsed > 30 ? round(Math.sqrt(variance / elapsed)) : null;
}

export function extractSideBook(book, feeSchedule, shares = SHARES, gasUsd = GAS_USD) {
    if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
    const bestBid = book.bids[0]?.price ?? null;
    const bestAsk = book.asks[0]?.price ?? null;
    const bidSize1 = book.bids[0]?.size ?? 0;
    const askSize1 = book.asks[0]?.size ?? 0;
    const bidSize3 = book.bids.slice(0, 3).reduce((s, l) => s + l.size, 0);
    const askSize3 = book.asks.slice(0, 3).reduce((s, l) => s + l.size, 0);
    const imb3 = bidSize3 + askSize3 > 0 ? round((bidSize3 - askSize3) / (bidSize3 + askSize3)) : 0;
    const limitPrice = bestAsk !== null ? round(Math.min(0.99, bestAsk + 0.01)) : null;
    let c5 = null, limitCostUsd = null, depthShares = 0;
    if (limitPrice !== null && limitPrice > 0 && limitPrice < 1 && feeSchedule) {
        const feeUsd = fee(shares, limitPrice, feeSchedule, false);
        limitCostUsd = round(shares * limitPrice + feeUsd + gasUsd);
        c5 = round(limitCostUsd / shares);
        const sw = sweep(book.asks, shares, limitPrice, 'BUY', feeSchedule);
        depthShares = sw.shares;
    }
    return {
        tokenId: book.tokenId,
        bestBid,
        bestAsk,
        spread: bestBid !== null && bestAsk !== null ? round(bestAsk - bestBid) : null,
        bidSize1: round(bidSize1),
        askSize1: round(askSize1),
        imb3,
        limitPrice,
        limitCostUsd,
        c5,
        depthShares,
    };
}

export function buildMarketContext({ market, books, btcPoints, binance, seconds, now }) {
    if (!market || !Array.isArray(books) || books.length !== 2) return null;
    const sides = books.map((book, index) => ({
        index,
        side: index === 0 ? 'UP' : 'DOWN',
        ...extractSideBook(book, market.fee, SHARES, GAS_USD),
    }));
    const sigma = computeSigma(btcPoints, now);
    const binanceStatus = binance ? binance.status(now) : { ready: false, ret3sBps: null, ret5sBps: null, mid: null };
    return {
        slug: market.slug,
        conditionId: market.conditionId,
        open: market.open,
        end: market.end,
        seconds,
        at: now,
        fee: market.fee,
        sides,
        sigma,
        binance: binanceStatus,
    };
}

function singleCandidate(sides, predicate) {
    const matches = sides.filter(predicate);
    return matches.length === 1 ? matches[0] : null;
}

function leadVetoReason(ctx, sideIndex) {
    if (!ctx.binance?.ready || !Number.isFinite(ctx.binance.ret5sBps)) return 'binance_feed_not_ready';
    const dir = sideIndex === 0 ? 1 : -1;
    if (dir * ctx.binance.ret5sBps <= -LEAD_VETO_BPS) return 'binance_lead_veto';
    return null;
}

export function evaluateArm(armDef, ctx) {
    if (!armDef.slots.includes(ctx.seconds)) return { action: 'SKIP', reason: 'slot_not_enabled' };

    const takerOrder = (s) => {
        if (s.depthShares < armDef.shares - EPS) return { action: 'SKIP', reason: 'insufficient_ask_depth' };
        return {
            action: s.index === 0 ? 'BUY_UP' : 'BUY_DOWN',
            execution: 'taker',
            index: s.index,
            side: s.side,
            tokenId: s.tokenId,
            shares: armDef.shares,
            limitPrice: s.limitPrice,
            signalBestAsk: s.bestAsk,
            signalBestBid: s.bestBid,
            expectedCostPerShare: s.c5,
            reason: null,
        };
    };

    const makerOrder = (s) => {
        if (s.bestBid === null || s.bestAsk === null || s.bestBid < 0.01 || s.bestBid >= s.bestAsk - EPS) {
            return { action: 'SKIP', reason: 'no_valid_post_only_bid' };
        }
        return {
            action: s.index === 0 ? 'BUY_UP' : 'BUY_DOWN',
            execution: 'maker',
            index: s.index,
            side: s.side,
            tokenId: s.tokenId,
            shares: armDef.shares,
            price: s.bestBid,
            queueAhead: s.bidSize1,
            signalBestAsk: s.bestAsk,
            signalBestBid: s.bestBid,
            cancelAtRemainingSec: armDef.cancelAtRemainingSec,
            adverseCancelBps: armDef.adverseCancelBps,
            adverseLookbackMs: armDef.adverseLookbackMs,
            reason: null,
        };
    };

    if (armDef.name === 'control_fav_taker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.70 - EPS && x.c5 !== null && x.c5 <= 0.82 + EPS);
        if (!s) return { action: 'SKIP', reason: 'no_eligible_favorite_in_cap' };
        return takerOrder(s);
    }

    if (armDef.name === 'contrarian_dog_60_taker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.15 - EPS && x.bestAsk <= 0.45 + EPS);
        if (!s) return { action: 'SKIP', reason: 'no_underdog_in_band' };
        return takerOrder(s);
    }

    if (armDef.name === 'contrarian_dog_60_maker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.15 - EPS && x.bestAsk <= 0.45 + EPS);
        if (!s) return { action: 'SKIP', reason: 'no_underdog_in_band' };
        return makerOrder(s);
    }

    if (armDef.name === 'fav_90_filtered_taker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.70 - EPS && x.c5 !== null && x.c5 <= 0.82 + EPS);
        if (!s) return { action: 'SKIP', reason: 'no_eligible_favorite_in_cap' };
        if (ctx.sigma === null) return { action: 'SKIP', reason: 'volatility_unavailable' };
        if (ctx.sigma < HIGH_VOL_SIGMA_USD) return { action: 'SKIP', reason: 'low_volatility_veto' };
        if (s.imb3 < MIN_BOOK_IMBALANCE) return { action: 'SKIP', reason: 'ask_heavy_book_veto' };
        const veto = leadVetoReason(ctx, s.index);
        if (veto) return { action: 'SKIP', reason: veto };
        return takerOrder(s);
    }

    if (armDef.name === 'fav_90_filtered_maker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.70 - EPS
            && x.bestBid !== null && x.bestBid <= 0.82 + EPS);
        if (!s) return { action: 'SKIP', reason: 'no_eligible_favorite_in_band' };
        if (ctx.sigma === null) return { action: 'SKIP', reason: 'volatility_unavailable' };
        if (ctx.sigma < HIGH_VOL_SIGMA_USD) return { action: 'SKIP', reason: 'low_volatility_veto' };
        if (s.imb3 < MIN_BOOK_IMBALANCE) return { action: 'SKIP', reason: 'ask_heavy_book_veto' };
        const veto = leadVetoReason(ctx, s.index);
        if (veto) return { action: 'SKIP', reason: veto };
        return makerOrder(s);
    }

    if (armDef.name === 'late_lock_60_maker') {
        const s = singleCandidate(ctx.sides, x => x.bestAsk !== null && x.bestAsk >= 0.90 - EPS && x.bestAsk <= 0.98 + EPS
            && x.bestBid !== null && x.bestBid >= 0.88 - EPS);
        if (!s) return { action: 'SKIP', reason: 'no_late_lock_favorite' };
        const veto = leadVetoReason(ctx, s.index);
        if (veto) return { action: 'SKIP', reason: veto };
        return makerOrder(s);
    }

    throw new Error(`unknown_arm_${armDef.name}`);
}
