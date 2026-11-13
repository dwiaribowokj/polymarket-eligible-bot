import { EPS, fee, floorTick, round } from './math.js';

export function duration(strategy, settings) {
    return strategy === 'late-entry' ? settings.late.duration : settings.maker.duration;
}

export function marketSlug(strategy, settings, now) {
    const seconds = duration(strategy, settings);
    return `btc-updown-${seconds / 60}m-${Math.floor(now / 1000 / seconds) * seconds}`;
}

export function lateEntrySkipReason(market, books, settings, cash, now) {
    if (!market.accepting) return 'market_not_accepting';
    if (market.minimum > settings.shares + EPS) return 'minimum_exceeds_fixed_shares';
    const remaining = (market.end - now) / 1000, rule = settings.late;
    if (remaining < rule.minSeconds || remaining > rule.maxSeconds) return 'outside_entry_window';
    const asks = books.map(b => b.asks[0]?.price);
    if (asks.some(p => !Number.isFinite(p))) return 'missing_executable_ask';
    const price = Math.max(...asks), minimum = remaining <= rule.lastSeconds ? rule.lastMinPrice : rule.minPrice;
    if (price < minimum - EPS) return 'ask_below_entry_minimum';
    if (price > rule.maxPrice + EPS) return 'ask_above_entry_maximum';
    const cost = settings.shares * price + fee(settings.shares, price, market.fee)
        + (settings.lateSignal ? settings.paperGasUsd : 0);
    if (cost > settings.entryCap + EPS) return 'entry_budget_exceeded';
    if (cost > cash + EPS) return 'insufficient_virtual_cash';
    return 'no_entry_signal';
}

export function entryPlan(strategy, market, books, settings, cash, now) {
    if (!market.accepting || market.minimum > settings.shares + EPS) return null;
    const remaining = (market.end - now) / 1000;
    let orders;
    if (strategy === 'late-entry') {
        const rule = settings.late;
        if (remaining < rule.minSeconds || remaining > rule.maxSeconds) return null;
        const asks = books.map(book => book.asks[0]?.price ?? NaN);
        if (asks.some(p => !Number.isFinite(p))) return null;
        const index = asks[0] >= asks[1] ? 0 : 1;
        const price = asks[index];
        const minimum = remaining <= rule.lastSeconds ? rule.lastMinPrice : rule.minPrice;
        if (price < minimum - EPS || price > rule.maxPrice + EPS) return null;
        orders = [{ tokenId: market.tokens[index], index, side: 'BUY', price, shares: settings.shares, kind: 'taker' }];
    } else {
        const elapsed = (now - market.open) / 1000;
        if (elapsed < settings.maker.delaySeconds || elapsed > settings.maker.entrySeconds) return null;
        const prices = books.map((book, i) => { const tick = market.ticks?.[i] ?? market.tick;
            return floorTick(Math.min(book.bids[0]?.price ?? 0, (book.asks[0]?.price ?? 0) - tick), tick); });
        const excess = round(prices[0] + prices[1] - settings.maker.maxCombined);
        if (excess > EPS) {
            const index = prices[0] >= prices[1] ? 0 : 1;
            prices[index] = floorTick(prices[index] - excess, market.ticks?.[index] ?? market.tick);
        }
        if (prices.some((p, i) => p < (market.ticks?.[i] ?? market.tick) - EPS || p >= 1)) return null;
        orders = prices.map((price, index) => ({ tokenId: market.tokens[index], index,
            side: 'BUY', price, shares: settings.shares, kind: 'maker' }));
    }
    const cost = orders.reduce((sum, order) => sum + order.shares * order.price
        + fee(order.shares, order.price, market.fee, order.kind === 'maker'), 0)
        + (strategy === 'late-entry' && settings.lateSignal ? settings.paperGasUsd : 0);
    if (cost > settings.entryCap + EPS || cost > cash + EPS) return null;
    return { orders, cost: round(cost) };
}

export function newPosition(market, plan, state, now) {
    return { market, openedAt: now, startingCash: state.cash, holdings: [0, 0], bought: [0, 0],
        orders: [], actions: [], receipts: {}, fills: [], fees: 0, gas: 0, rebate: 0,
        entryCost: 0, entryBudget: plan.cost, capitalHours: 0, exposureAt: now,
        lastDeployed: 0, oneSided: false, uncertain: false, cutting: false,
        exitAttempted: [false, false], payout: null, settled: false };
}

export function accrueCapital(position, now) {
    position.capitalHours += position.lastDeployed * Math.max(0, now - position.exposureAt) / 3600000;
    position.exposureAt = now;
}
