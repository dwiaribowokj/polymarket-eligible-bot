const finitePoint = p => p && Number.isFinite(p.at) && Number.isFinite(p.receivedAt)
    && Number.isFinite(p.value) && p.value > 0;
const LONG_PROFILE = 'near-open-30m-v1';
const FAIR_PROFILE = 'fair-near-open-30m-v1';
const longProfile = profile => profile === LONG_PROFILE || profile === FAIR_PROFILE;
const MINUTE_MS = 60000;

export function fairMomentumDecision(context, parameters) {
    const reject = (reason, evidence = {}) => ({ action: 'SKIP', reason, ...evidence });
    const returns = context?.returnsUsd, groups = context?.bars5m, sigma = context?.sigmaUsdSqrtSecond;
    if (!parameters || !returns || !Array.isArray(groups) || groups.length !== parameters.total5mGroups
        || groups.some(bar => !Array.isArray(bar) || bar.length !== 4 || bar.some(value => !Number.isFinite(value)))
        || ['m5', 'm15', 'm30', 's60'].some(key => !Number.isFinite(returns[key])))
        return reject('momentum_context_invalid');
    const direction = Math.sign(returns.m30);
    if (!direction || ['m5', 'm15'].some(key => Math.sign(returns[key]) !== direction))
        return reject('momentum_horizons_disagree');
    const aligned5mGroups = groups.filter(bar => Math.sign(bar[3] - bar[0]) === direction).length;
    const evidence = { direction: direction > 0 ? 'UP' : 'DOWN', aligned5mGroups };
    if (aligned5mGroups < parameters.minimumAligned5mGroups)
        return reject('momentum_group_consistency_not_met', evidence);
    if (!(Number.isFinite(sigma) && sigma > 0)) return reject('momentum_volatility_unavailable', evidence);
    const normalizedStrength = Object.fromEntries(Object.entries(parameters.windowsSeconds).map(([name, seconds]) =>
        [name, Math.abs(returns[name]) / (sigma * Math.sqrt(seconds))]));
    evidence.normalizedStrength = normalizedStrength;
    if (Object.entries(parameters.minimumNormalizedStrength).some(([name, minimum]) => !(normalizedStrength[name] >= minimum)))
        return reject('momentum_strength_not_met', evidence);
    if (direction * returns.s60 < -parameters.maximumOpposingReversalUsd)
        return reject('momentum_recent_reversal', evidence);
    return { action: direction > 0 ? 'BUY_UP' : 'BUY_DOWN', reason: null, ...evidence };
}

export class PremarketHistory {
    constructor({ profile, maxGapMs = 5000, dataAgeMs = 5000, historyMs = 180000, diagnosticHistoryMs = 900000 } = {}) {
        this.longHistory = longProfile(profile);
        this.maxGapMs = this.longHistory ? Math.min(maxGapMs, 5000) : maxGapMs;
        this.dataAgeMs = dataAgeMs;
        this.keepMs = Math.max(historyMs, diagnosticHistoryMs, this.longHistory ? 1800000 : 180000) + 65000;
        this.points = []; this.liveStartedAt = null;
    }
    reset() { this.points = []; this.liveStartedAt = null; }
    capture(signal, now) {
        if (!Number.isFinite(now)) { this.reset(); return; }
        this.liveStartedAt ??= now;
        const source = (signal?.spot || []).filter(p => finitePoint(p) && p.at <= now && p.receivedAt <= now
            && (!this.longHistory || p.receivedAt >= p.at && p.receivedAt - p.at <= this.dataAgeMs));
        if (!source.length) { this.reset(); return; }
        if (this.longHistory && source.some((p, i) => i && (p.at <= source[i - 1].at
            || p.receivedAt < source[i - 1].receivedAt))) { this.reset(); return; }
        for (const point of source) {
            const last = this.points.at(-1);
            if (last && point.at <= last.at) continue;
            if (this.longHistory && (point.at < this.liveStartedAt || point.receivedAt < this.liveStartedAt
                || now - point.receivedAt > this.dataAgeMs)) continue;
            if (this.longHistory && last && point.receivedAt < last.receivedAt) {
                this.reset(); this.liveStartedAt = now; continue;
            }
            if (last && point.at - last.at > this.maxGapMs) {
                this.reset(); this.liveStartedAt = now;
                if (this.longHistory && point.at < now) continue;
            }
            this.points.push({ ...point });
        }
        if (this.longHistory && this.points.length && now - this.points.at(-1).at > this.maxGapMs) this.reset();
        this.points = this.points.filter(p => p.at >= now - this.keepMs);
    }
}

export function premarketFeatures(points, market, decisionAt, config) {
    const reject = reason => ({ action: 'SKIP', reason, decisionAt,
        openingTwap: { status: 'unavailable_before_market_open', value: null } });
    if (!Number.isFinite(decisionAt) || !Number.isFinite(market.open)
        || !(decisionAt < market.open) || market.open - decisionAt !== config.leadSeconds * 1000)
        return reject('invalid_premarket_decision_time');
    const longHistory = longProfile(config.profile);
    const maxGapMs = longHistory ? Math.min(config.maxGapMs, 5000) : config.maxGapMs;
    const end = Math.floor(decisionAt / MINUTE_MS) * MINUTE_MS, start = end - (longHistory ? 30 : 3) * MINUTE_MS;
    if (longHistory && (!Array.isArray(points) || points.some(p => !p || !Number.isFinite(p.at)
        || p.at >= start - maxGapMs && p.at <= decisionAt && !finitePoint(p)))) return reject('btc_history_invalid');
    const known = points.filter(p => finitePoint(p) && p.at <= decisionAt && p.receivedAt <= decisionAt
        && p.receivedAt >= p.at && p.receivedAt - p.at <= config.dataAgeMs);
    const latest = known.at(-1);
    if (!latest || decisionAt - latest.at > config.dataAgeMs
        || longHistory && decisionAt - latest.at > maxGapMs) return reject('btc_feed_stale_or_warming');
    if (longHistory && known.some((p, i) => i && p.at >= start - maxGapMs
        && (p.at <= known[i - 1].at || p.receivedAt < known[i - 1].receivedAt))) return reject('btc_history_out_of_order');
    const anchor = known.findLast(p => p.at <= start);
    if (!anchor || start - anchor.at > maxGapMs) return reject('completed_candles_warming');
    const history = known.filter(p => p.at >= anchor.at);
    if (history.some((p, i) => i && p.at - history[i - 1].at > maxGapMs)) return reject('btc_history_gap');
    const bars = [];
    for (let at = start; at < end; at += MINUTE_MS) {
        const samples = known.filter(p => p.at >= at && p.at < at + MINUTE_MS);
        if (!samples.length || samples[0].at - at > maxGapMs
            || at + MINUTE_MS - samples.at(-1).at > maxGapMs) return reject('completed_candle_gap');
        const values = samples.map(p => p.value);
        bars.push({ start: at, end: at + MINUTE_MS, open: values[0], high: Math.max(...values),
            low: Math.min(...values), close: values.at(-1), samples: values.length,
            latestReceivedAt: Math.max(...samples.map(p => p.receivedAt)) });
    }
    const recent = known.filter(p => p.at >= decisionAt - config.diagnosticHistoryMs);
    let variance = 0;
    for (let i = 1; i < recent.length; i++) variance += (recent[i].value - recent[i - 1].value) ** 2;
    const elapsed = recent.length > 1 ? (recent.at(-1).at - recent[0].at) / 1000 : 0;
    const estimatedSigma = elapsed > 0 ? Math.sqrt(variance / elapsed) : null;
    const sigma = Number.isFinite(estimatedSigma) ? estimatedSigma : null;
    const before30 = known.findLast(p => p.at <= decisionAt - 30000);
    const move30 = before30 && decisionAt - 30000 - before30.at <= maxGapMs ? latest.value - before30.value : null;
    const directionalBars = bars.slice(-3);
    const bearish = directionalBars.every(bar => bar.close < bar.open)
        && directionalBars[1].close < directionalBars[0].close && directionalBars[2].close < directionalBars[1].close;
    const bullish = directionalBars.every(bar => bar.close > bar.open)
        && directionalBars[1].close > directionalBars[0].close && directionalBars[2].close > directionalBars[1].close;
    const move180 = directionalBars[2].close - directionalBars[0].open;
    let context;
    if (longHistory) {
        const bars5m = [];
        // These rolling groups retain the exact completed 30-minute window, even off a UTC 5-minute boundary.
        for (let i = 0; i < bars.length; i += 5) {
            const group = bars.slice(i, i + 5);
            bars5m.push({ start: group[0].start, end: group.at(-1).end, open: group[0].open,
                high: Math.max(...group.map(bar => bar.high)), low: Math.min(...group.map(bar => bar.low)),
                close: group.at(-1).close, samples: group.reduce((sum, bar) => sum + bar.samples, 0),
                latestReceivedAt: Math.max(...group.map(bar => bar.latestReceivedAt)) });
        }
        const returnsUsd = Object.fromEntries(Object.entries({ s30: 30000, s60: 60000, m3: 180000,
            m5: 300000, m15: 900000, m30: 1800000 }).map(([name, duration]) => {
            const before = known.findLast(p => p.at <= decisionAt - duration);
            return [name, before && decisionAt - duration - before.at <= maxGapMs ? latest.value - before.value : null];
        }));
        context = { schema: config.profile, source: 'chainlink_btc_usd', completedThroughAt: end,
            historyStartAt: start, historyEndAt: end, requiredMinutes: 30,
            aggregation5m: 'consecutive_groups_of_five_completed_1m_bars', bars5m, returnsUsd };
    }
    return { action: config.profile === FAIR_PROFILE ? 'SKIP' : bearish ? 'BUY_DOWN' : bullish ? 'BUY_UP' : 'SKIP',
        reason: config.profile === FAIR_PROFILE ? 'common_input_required' : bearish || bullish ? null : 'three_directional_candles_not_met',
        decisionAt, observedAt: latest.at, observedReceivedAt: latest.receivedAt, bars,
        ...(context ? { context } : {}),
        openingTwap: { status: 'unavailable_before_market_open', value: null },
        diagnosticOnly: { historySeconds: elapsed, full15MinutesAvailable: elapsed >= 897,
            sigmaUsdSqrtSecond: sigma, move180Usd: move180,
            normalized180: sigma > 0 ? move180 / (sigma * Math.sqrt(180)) : null,
            latest30sMoveUsd: move30, reversalAgainstDown: move30 === null ? null : move30 > 0 } };
}
