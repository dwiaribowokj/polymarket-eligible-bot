export const EPS = 0.00001;
export const round = n => Math.round(n * 1e6) / 1e6;
export const floorTick = (price, tick) => round(Math.floor((price + 1e-9) / tick) * tick);

export function fee(shares, price, schedule, maker = false) {
    if (maker && schedule.takerOnly) return 0;
    const value = shares * schedule.rate * (price * (1 - price)) ** schedule.exponent;
    return Math.round(value * 1e5) / 1e5;
}

export function sweep(levels, shares, limit, side, schedule) {
    const sorted = [...levels].sort((a, b) => side === 'BUY' ? a.price - b.price : b.price - a.price);
    let filled = 0, notional = 0, fees = 0;
    for (const level of sorted) {
        if (side === 'BUY' ? level.price > limit + EPS : level.price < limit - EPS) break;
        const size = Math.min(shares - filled, level.size);
        if (size <= 0) continue;
        filled += size;
        notional += size * level.price;
        fees += fee(size, level.price, schedule);
        if (filled >= shares - EPS) break;
    }
    return { shares: round(filled), notional: round(notional), fees: round(fees),
        cash: round(side === 'BUY' ? -(notional + fees) : notional - fees) };
}

export function makerFill(order, trade) {
    if (order.status !== 'open' || trade.side !== 'SELL' || trade.price > order.price + EPS
        || trade.at < order.activeAt || !Number.isFinite(trade.size) || trade.size <= 0) return 0;
    const volume = trade.size;
    const ahead = Math.min(order.queueAhead, volume);
    order.queueAhead = Math.max(0, order.queueAhead - ahead);
    const fill = Math.min(order.shares - order.filled, volume - ahead);
    order.filled = round(order.filled + fill);
    if (order.filled >= order.shares - EPS) order.status = 'filled';
    return round(fill);
}

export function equity(state, books) {
    if (!state.position) return state.cash;
    return state.cash + state.position.holdings.reduce((sum, shares, i) => {
        const book = books?.[i];
        if (!book) return sum;
        return sum + sweep(book.bids, shares, 0, 'SELL', state.position.market.fee).cash;
    }, 0);
}

export function riskReason(state, settings, now, value) {
    state.lastEquity = value;
    state.peakEquity = Math.max(state.peakEquity, value);
    state.maxDrawdown = Math.max(state.maxDrawdown, state.peakEquity - value);
    if (state.mode === 'paper' && settings.paperShadowDrawdownStop && !state.shadowPilotStop
        && state.peakEquity - value >= settings.paperShadowDrawdownStop - EPS)
        state.shadowPilotStop = { reason: 'drawdown_limit', at: now, equity: round(value),
            drawdown: round(state.peakEquity - value), completedMarkets: state.completed.filter(r => r.traded).length };
    if (state.mode === 'paper' && settings.paperDrawdownStop
        && state.peakEquity - value >= settings.paperDrawdownStop - EPS) return 'paper_drawdown_limit';
    if (state.mode !== 'pilot') return null;
    if (state.peakEquity - value >= settings.drawdownStop - EPS) return 'drawdown_limit';
    if (state.completed.length >= settings.pilotMarkets) return 'market_limit';
    if (now - state.startedAt >= settings.pilotHours * 3600000) return 'time_limit';
    return null;
}

function random(seed = 42) {
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function dailyBootstrap(rows, samples = 10000) {
    const groups = new Map();
    for (const row of rows) {
        const day = new Date(row.closedAt).toISOString().slice(0, 10);
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(row.pnl);
    }
    const days = [...groups.values()];
    if (days.length < 2) return null;
    const rng = random(), means = [];
    for (let i = 0; i < samples; i++) {
        let sum = 0, count = 0;
        for (let j = 0; j < days.length; j++) {
            const group = days[Math.floor(rng() * days.length)];
            sum += group.reduce((a, b) => a + b, 0); count += group.length;
        }
        means.push(sum / count);
    }
    means.sort((a, b) => a - b);
    return { lower: means[Math.floor(samples * 0.025)], upper: means[Math.floor(samples * 0.975)] };
}

export function evaluate(state, settings, now = Date.now()) {
    if (!state) return { eligible: false, decision: 'belum layak', reasons: ['no_paper_trial'] };
    now = state.frozenAt || (settings.evaluationEndsAt ? Math.min(now, settings.evaluationEndsAt) : now);
    const rows = state.completed.filter(r => r.traded);
    const pnl = round(rows.reduce((sum, row) => sum + row.pnl, 0));
    const days = (now - state.startedAt) / 86400000;
    const observedDays = new Set(rows.map(r => new Date(r.closedAt).toISOString().slice(0, 10))).size;
    const ci = dailyBootstrap(rows, settings.bootstrapSamples);
    const reasons = [];
    if (state.baseline !== settings.fingerprint) reasons.push('baseline_changed');
    if (days < settings.minDays) reasons.push(`need_${settings.minDays}_days`);
    if (observedDays < settings.minDays) reasons.push(`need_${settings.minDays}_observed_days`);
    if (settings.evaluationEndsAt && now < settings.evaluationEndsAt) reasons.push('evaluation_window_open');
    if (rows.length < settings.minMarkets) reasons.push('need_100_completed_markets');
    if (pnl <= 0) reasons.push('nonpositive_net_profit');
    if (!ci || ci.lower <= 0) reasons.push('uncertain_expectancy');
    if (state.dataGaps > 0 || rows.some(r => r.uncertain)) reasons.push('incomplete_execution_data');
    if (state.stopped) reasons.push('trial_stopped');
    if (state.shadowPilotStop) reasons.push('shadow_pilot_drawdown_limit');
    if (settings.lateSignal?.researchOnly && state.strategy === 'late-entry') reasons.push(
        settings.lateSignal.calibration ? 'calibration_requires_prospective_validation' : 'research_model_uncalibrated');
    if (state.position) reasons.push('unresolved_inventory');
    const hours = Math.max((now - state.startedAt) / 3600000, 1 / 3600);
    const insufficient = days < settings.minDays || observedDays < settings.minDays || rows.length < settings.minMarkets
        || settings.evaluationEndsAt && now < settings.evaluationEndsAt || !!state.position;
    return { strategy: state.strategy, baseline: state.baseline, eligible: reasons.length === 0,
        decision: reasons.length === 0 ? 'layak pilot' : insufficient ? 'belum layak' : 'perlu perubahan',
        days: round(days), observedDays, markets: rows.length, pnl, ci95: ci, maxDrawdown: round(state.maxDrawdown),
        activeInventory: state.position?.holdings || null, cash: state.cash,
        fees: round(rows.reduce((s, r) => s + r.fees, 0)), gas: round(rows.reduce((s, r) => s + r.gas, 0)),
        rebates: round(rows.reduce((s, r) => s + r.rebate, 0)),
        partialFills: rows.filter(r => r.partial).length, oneSided: rows.filter(r => r.oneSided).length,
        executionFailures: state.failures, dataGaps: state.dataGaps, operational: state.operational || null,
        stopped: state.stopped, shadowPilotStop: state.shadowPilotStop || null,
        frozenAt: state.frozenAt || null, lastTickAt: state.lastTickAt || null,
        lastEquity: state.lastEquity ?? state.cash, diagnostics: state.diagnostics || null,
        skippedMarkets: Object.keys(state.skipped || {}).filter(slug => !state.seen[slug]).length,
        capitalHours: round(rows.reduce((s, r) => s + r.capitalHours, 0)),
        returnPerCapitalHour: pnl / (settings.capital * hours), reasons };
}

export function comparison(states, settings, now) {
    const strategies = states.map(state => evaluate(state, settings, now));
    const eligible = strategies.filter(s => s.eligible).sort((a, b) => b.returnPerCapitalHour - a.returnPerCapitalHour
        || a.strategy.localeCompare(b.strategy));
    return { baseline: settings.fingerprint, selected: eligible[0]?.strategy || null,
        decision: eligible.length ? 'layak pilot' : strategies.some(s => s.decision === 'perlu perubahan') ? 'perlu perubahan' : 'belum layak',
        minimumDays: settings.minDays, evaluationEndsAt: settings.evaluationEndsAt ? new Date(settings.evaluationEndsAt).toISOString() : null,
        strategies };
}

export function pilotSummary(state) {
    const rows = state.completed.filter(r => r.traded);
    const pnl = round(rows.reduce((s, r) => s + r.pnl, 0));
    return { strategy: state.strategy, baseline: state.baseline, startedAt: state.startedAt,
        completedMarkets: rows.length, netRealizedPnl: pnl, cash: state.cash,
        activeMarket: state.position?.market.slug ?? null, inventory: state.position?.holdings ?? [0, 0],
        pendingOrders: state.position?.orders.filter(o => !['complete', 'rejected', 'cancelled'].includes(o.status)).map(o => o.orderId) || [],
        maxDrawdown: state.maxDrawdown, failures: state.failures, stopped: state.stopped,
        fees: round(rows.reduce((s, r) => s + r.fees, 0)), gas: round(rows.reduce((s, r) => s + r.gas, 0)),
        decision: state.position ? 'belum layak' : pnl > 0 && !state.failures ? 'layak pilot' : 'perlu perubahan' };
}
