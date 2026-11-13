import { EPS, equity, riskReason, sweep } from '../restart/math.js';
import { OperationalError } from '../restart/network.js';
import { clearEntryHold, holdEntry } from './entry-holds.js';

const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const validPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(payout[0] + payout[1] - 1) <= EPS;

function unavailable(store, now, permanent = false, code = 'live_risk_mark_unavailable') {
    holdEntry(store, 'risk_mark', new OperationalError(code, permanent ? 'validation' : 'stale_data',
        { stage: 'live_risk_mark' }), { now, retryable: !permanent });
    if (permanent) store.stop('operational_check_failed');
    return null;
}

// Validate the mark independently of its caller. Missing quotes must not turn
// locked inventory into a loss; a fresh empty bid book is a real zero bid.
function markEvidence(state, settings, now, value, detail) {
    const p = state.position;
    if (!Number.isFinite(value) || !Number.isFinite(state.cash)) return { invalid: true };
    if (!p) return Math.abs(value - state.cash) <= EPS
        ? { expected: state.cash, source: 'flat_cash', position: null }
        : { invalid: true };
    if (!Array.isArray(p.holdings) || p.holdings.length !== 2
        || p.holdings.some(shares => !Number.isFinite(shares) || shares < 0)) return { invalid: true };
    const position = { market: p.market?.slug ?? null, conditionId: p.market?.conditionId ?? null,
        holdings: [...p.holdings], marketEnd: Number.isFinite(p.market?.end) ? p.market.end : null };
    let expected, evidence;
    if (p.payout != null || detail.payout != null) {
        const payout = detail.payout ?? p.payout;
        if (!validPayout(payout) || !validPayout(p.payout)
            || payout.some((part, i) => part !== p.payout[i])) return { invalid: true };
        expected = state.cash + p.holdings.reduce((total, shares, i) => total + shares * payout[i], 0);
        evidence = { source: 'official_payout', payout: [...payout], position };
    } else if (p.holdings.every(shares => shares < EPS)) {
        expected = state.cash; evidence = { source: 'flat_holdings', position };
    } else {
        if (!Number.isFinite(settings.maxDataAgeMs) || settings.maxDataAgeMs < 0) return { invalid: true };
        const books = detail.books;
        if (!Array.isArray(books)) return { unavailable: true };
        if (!p.market?.fee || ![p.market.fee.rate, p.market.fee.exponent].every(Number.isFinite)
            || p.market.fee.rate < 0 || p.market.fee.exponent < 0) return { invalid: true };
        const quotes = [];
        for (let index = 0; index < 2; index++) {
            if (p.holdings[index] === 0) { quotes.push(null); continue; }
            const book = books[index];
            if (!book) return { unavailable: true };
            if (!Number.isFinite(book.timestamp) || !Number.isFinite(book.fetchedAt)
                || !Array.isArray(book.bids) || book.bids.some(level => !Number.isFinite(level.price)
                    || level.price <= 0 || level.price >= 1 || !Number.isFinite(level.size) || level.size <= 0))
                return { invalid: true };
            if (book.timestamp > now || book.fetchedAt > now) return { invalid: true };
            if (now - book.timestamp > settings.maxDataAgeMs || now - book.fetchedAt > settings.maxDataAgeMs)
                return { unavailable: true };
            const liquidation = sweep(book.bids, p.holdings[index], 0, 'SELL', p.market.fee);
            const availableBidShares = book.bids.reduce((total, level) => total + level.size, 0);
            if (![liquidation.shares, liquidation.notional, liquidation.fees, liquidation.cash,
                availableBidShares].every(Number.isFinite)) return { invalid: true };
            quotes.push({ index, tokenId: p.market.tokens?.[index] ?? null,
                timestamp: book.timestamp, fetchedAt: book.fetchedAt,
                quoteAgeMs: now - book.timestamp, receiveAgeMs: now - book.fetchedAt,
                bestBid: book.bids.reduce((best, level) => Math.max(best ?? 0, level.price), null),
                availableBidShares, liquidation,
                bids: book.bids.map(level => ({ price: level.price, size: level.size })) });
        }
        const heldBooks = p.holdings.map((shares, index) => shares === 0 ? { bids: [] } : books[index]);
        expected = Math.max(equity(state, heldBooks), state.cash + Math.min(...p.holdings));
        evidence = { source: 'fresh_books', position, quotes };
    }
    return Number.isFinite(expected) && Math.abs(expected - value) <= EPS
        ? { expected, ...evidence } : { invalid: true };
}

// Keep the historical peak and maximum drawdown in the original account.
// A separate first-trigger latch remains visible when an operational stop
// already occupies Store.stop's first-wins field.
export function evaluateLiveRisk(store, settings, now, value, detail = {}) {
    if (!timestamp(now)) throw new OperationalError('invalid_live_risk_time', 'validation', { stage: 'live_risk_mark' });
    const state = store.state;
    if (!Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
        || !Number.isFinite(settings.drawdownStop) || settings.drawdownStop <= 0)
        return unavailable(store, now, true, 'invalid_live_risk_history');
    const mark = markEvidence(state, settings, now, value, detail);
    if (mark.invalid) return unavailable(store, now, true, 'invalid_live_risk_mark');
    if (mark.unavailable) return unavailable(store, now);
    clearEntryHold(store, 'risk_mark', { now, proof: mark.source });
    const previousDrawdown = state.peakEquity - state.lastEquity;
    let reason = riskReason(state, settings, now, mark.expected);
    if (state.mode === 'pilot' && settings.continuousTrading === true) {
        const drawdown = state.peakEquity - mark.expected;
        // Keep threshold evidence observable without creating an entry latch.
        if (drawdown >= settings.drawdownStop - EPS
            && (state.liveRiskThreshold?.threshold !== settings.drawdownStop
                || previousDrawdown < settings.drawdownStop - EPS)) {
            const { expected, ...evidence } = mark;
            state.liveRiskThreshold = { kind: 'drawdown', at: now, threshold: settings.drawdownStop,
                equity: expected, cash: state.cash, peakEquity: state.peakEquity,
                drawdown, maxDrawdown: state.maxDrawdown, ...evidence };
            const { at: crossedAt, ...observation } = state.liveRiskThreshold;
            store.event('live_risk_threshold_crossed', { ...observation, crossedAt });
        }
        return reason === 'drawdown_limit' ? null : reason;
    }
    if (!reason && state.mode === 'pilot' && !state.position && state.cash <= EPS) reason = 'capital_exhausted';
    if (state.mode === 'pilot' && ['drawdown_limit', 'capital_exhausted'].includes(reason) && !state.liveRiskStop) {
        state.liveRiskStop = { reason, at: now, equity: mark.expected, cash: state.cash,
            peakEquity: state.peakEquity, drawdown: state.peakEquity - mark.expected,
            maxDrawdown: state.maxDrawdown, drawdownStop: settings.drawdownStop,
            priorStop: state.stopped ? { ...state.stopped } : null, ...mark };
        delete state.liveRiskStop.expected;
        const { at: triggeredAt, ...evidence } = state.liveRiskStop;
        store.event('live_risk_stop', { ...evidence, triggeredAt });
    }
    return reason;
}
