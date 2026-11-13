import { createHash } from 'node:crypto';

export const EARLY_PROFILE = 'early-reversal-30x5m-v1';
export const NEXT_PROFILE = 'next-reversal-30x5m-v1';
export const isCandleProfile = config => [EARLY_PROFILE, NEXT_PROFILE].includes(config?.profile);
export const EARLY_PREMARKET_PROMPT_VERSION = 'early-binance-30x5m-shared-cent-context-v1';
export const EARLY_PREMARKET_PROMPT = 'Paper BTC 5m: target closing Chainlink 60s TWAP >= target opening TWAP means UP, else DOWN; both unknown. Official CTF payout settles. Target opens 540s after decision, NOT the next candle. Binance BTCUSDT is predictor, not settlement source. Evaluate all 30 closed 5m OHLC (150m), returns, volatility, books; encoding in input. Assess streak reversal independently, need not follow it. Entries=[limit USD,shares,cost USD incl fees+gas]. Winner pays $1/share. BUY only allowed with positive expected net, else SKIP. Choice scores are not win probabilities.';
export const EARLY_PREMARKET_QUESTIONS = Object.freeze({ action: Object.freeze({ type: 'choice',
    instructions: EARLY_PREMARKET_PROMPT, criteria: Object.freeze({
        BUY_UP: 'Up with positive net value; must be allowed.',
        BUY_DOWN: 'Down with positive net value; must be allowed.',
        SKIP: 'No positive net value or insufficient evidence.'
    }) }) });
export const NEXT_PREMARKET_PROMPT_VERSION = 'next-binance-30x5m-confirmation-cent-context-v1';
export const NEXT_PREMARKET_PROMPT = 'Paper BTC 5m: target is the actual NEXT market after the last closed Binance candle, now open; decision=open+5s. Closing Chainlink 60s TWAP >= opening means UP, else DOWN; TWAPs not supplied. Official CTF payout settles; Binance is predictor. Read all 30 closed 5m OHLC (150m), returns, volatility, books. Pattern: >=3 same-direction bars then first opposite bar; signal follows opposite bar. You are a confirmation filter: BUY only the signal side in allowed with positive expected net, otherwise SKIP. Other side forbidden; no pattern means SKIP only. Entries=[limit USD,shares,total USD incl fees+gas]; winner pays $1/share. Choice scores are not win probabilities.';
export const NEXT_PREMARKET_QUESTIONS = Object.freeze({ action: Object.freeze({ type: 'choice',
    instructions: NEXT_PREMARKET_PROMPT, criteria: Object.freeze({
        BUY_UP: 'Confirm UP only if signal=BUY_UP and allowed; positive net value.',
        BUY_DOWN: 'Confirm DOWN only if signal=BUY_DOWN and allowed; positive net value.',
        SKIP: 'Always allowed; uncertain, unprofitable, or no allowed signal.'
    }) }) });

const INTERVAL = 300000, COUNT = 30, HISTORY = COUNT * INTERVAL;
const WINDOWS = { m5: 1, m15: 3, m30: 6, m60: 12, m150: 30 };
const ACTIONS = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finite = Number.isFinite;
const rounded = value => Math.round(value * 1e6) / 1e6;
const fail = () => { throw new Error('early_premarket_context_invalid'); };
const validOhlc = row => Array.isArray(row) && row.length === 4 && row.every(value => finite(value) && value > 0)
    && row[1] >= Math.max(row[0], row[3]) && row[2] <= Math.min(row[0], row[3]);
const metrics = bars => ({
    returnsUsd: Object.fromEntries(Object.entries(WINDOWS).map(([name, length]) =>
        [name, rounded(bars.at(-1)[3] - bars.at(-length)[0])])),
    sigmaUsdSqrtSecond: rounded(Math.sqrt(bars.slice(1).reduce((sum, row, index) =>
        sum + (row[3] - bars[index][3]) ** 2, 0) / ((bars.length - 1) * 300))),
});

export function earlyPremarketFeatures(history, market, decisionAt, config = {}) {
    const next = config.profile === NEXT_PROFILE;
    const openingTwap = { status: next ? 'unavailable_in_input' : 'unavailable_before_market_open', value: null };
    const reject = reason => ({ action: 'SKIP', reason, decisionAt,
        openingTwap });
    if (!integer(decisionAt) || !integer(market?.open) || market.open % INTERVAL !== 0
        || (next ? decisionAt - market.open !== 5000 : market.open - decisionAt !== 540000)
        || market.end !== market.open + INTERVAL)
        return reject('invalid_premarket_decision_time');
    if (history?.ready !== true) return reject(history?.reason || 'candle_history_unavailable');
    const expectedEnd = Math.floor(decisionAt / INTERVAL) * INTERVAL;
    const maxAgeMs = config.candleCacheMaxAgeMs ?? config.historyMaxAgeMs ?? 90000;
    if (history.source !== 'binance_spot' || history.symbol !== 'BTCUSDT' || history.intervalMs !== INTERVAL
        || history.windowStart !== expectedEnd - HISTORY || history.windowEnd !== expectedEnd
        || history.expectedLatestClosedAt !== expectedEnd || !integer(history.observedAt)
        || history.observedAt > decisionAt || history.observedAt < expectedEnd
        || history.fetchedAt != null && (!integer(history.fetchedAt) || history.fetchedAt > decisionAt)
        || decisionAt - history.observedAt > maxAgeMs
        || !Array.isArray(history.bars) || history.bars.length !== COUNT)
        return reject('candle_history_invalid');
    const bars = history.bars.map(bar => ({ start: bar.openAt, end: bar.closeAt,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close, latestReceivedAt: bar.observedAt }));
    if (bars.some((bar, index) => bar.start !== history.windowStart + index * INTERVAL
        || bar.end !== bar.start + INTERVAL || !integer(bar.latestReceivedAt)
        || bar.latestReceivedAt < bar.end || bar.latestReceivedAt > decisionAt || bar.latestReceivedAt > history.observedAt
        || !validOhlc([bar.open, bar.high, bar.low, bar.close]))) return reject('candle_history_invalid');
    const derived = metrics(bars.map(bar => [bar.open, bar.high, bar.low, bar.close]));
    return { action: 'SKIP', reason: 'common_input_required', decisionAt, observedAt: history.observedAt,
        observedReceivedAt: history.observedAt, bars,
        context: { schema: next ? NEXT_PROFILE : EARLY_PROFILE, source: 'binance_spot', symbol: 'BTCUSDT', candleIntervalMs: INTERVAL,
            historyStartAt: history.windowStart, historyEndAt: history.windowEnd, completedThroughAt: history.windowEnd,
            requiredMinutes: 150, observedAt: history.observedAt, fetchedAt: history.fetchedAt ?? null,
            aggregation5m: 'native_closed_5m_bars', ...derived },
        openingTwap,
        diagnosticOnly: { historySeconds: HISTORY / 1000, ...derived } };
}

export function earlyReversalDecision(context, parameters = {}) {
    const reject = (reason, evidence = {}) => ({ action: 'SKIP', reason, ...evidence });
    const minimum = parameters.minimumPriorStreak ?? 3, bars = context?.bars;
    if (!Number.isInteger(minimum) || minimum < 3 || minimum > 29
        || ![EARLY_PREMARKET_PROMPT_VERSION, NEXT_PREMARKET_PROMPT_VERSION].includes(context?.schema) || context.source !== 'binance_spot'
        || context.symbol !== 'BTCUSDT' || context.candleIntervalMs !== INTERVAL
        || !Array.isArray(bars) || bars.length !== COUNT || !bars.every(validOhlc))
        return reject('reversal_context_invalid');
    const direction = Math.sign(bars.at(-1)[3] - bars.at(-1)[0]);
    if (!direction) return reject('reversal_latest_doji');
    let priorStreak = 0;
    for (let i = bars.length - 2; i >= 0 && Math.sign(bars[i][3] - bars[i][0]) === -direction; i--) priorStreak++;
    const evidence = { priorStreak, minimumPriorStreak: minimum,
        priorDirection: direction > 0 ? 'DOWN' : 'UP', firstReversalDirection: direction > 0 ? 'UP' : 'DOWN' };
    if (priorStreak < minimum) return reject('reversal_prior_streak_not_met', evidence);
    return { action: direction > 0 ? 'BUY_UP' : 'BUY_DOWN', reason: null, ...evidence };
}

export function nextReversalSignal(features, parameters = {}) {
    if (features?.context?.schema !== NEXT_PROFILE || !Array.isArray(features.bars)
        || features.bars.some(bar => !bar || !validOhlc([bar.open, bar.high, bar.low, bar.close])))
        return { action: 'SKIP', reason: 'reversal_context_invalid' };
    return earlyReversalDecision({ schema: NEXT_PREMARKET_PROMPT_VERSION, source: features.context.source,
        symbol: features.context.symbol, candleIntervalMs: features.context.candleIntervalMs,
        bars: features.bars.map(bar => [bar.open, bar.high, bar.low, bar.close].map(value => Math.round(value * 100) / 100)) }, parameters);
}

export function buildEarlyPremarketInput(snapshot, config = {}) {
    const features = snapshot?.features, c = features?.context, bars = features?.bars, market = snapshot?.market;
    const next = config.profile === NEXT_PROFILE, version = next ? NEXT_PREMARKET_PROMPT_VERSION : EARLY_PREMARKET_PROMPT_VERSION;
    if (!isCandleProfile(config) || !c || c.schema !== config.profile
        || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId || snapshot.snapshotId.length > 256
        || /[\u0000-\u001f]/.test(snapshot.snapshotId)
        || !integer(snapshot.at) || !integer(features.decisionAt) || snapshot.at < features.decisionAt
        || snapshot.at - features.decisionAt > (config.slotToleranceMs ?? 2000)
        || features.openingTwap?.value !== null || !Array.isArray(bars)) fail();
    const validated = earlyPremarketFeatures({ ready: true, source: c.source, symbol: c.symbol,
        intervalMs: c.candleIntervalMs, windowStart: c.historyStartAt, windowEnd: c.historyEndAt,
        expectedLatestClosedAt: c.completedThroughAt, observedAt: features.observedAt,
        fetchedAt: c.fetchedAt, bars: bars.map(bar => ({ openAt: bar.start, closeAt: bar.end,
            open: bar.open, high: bar.high, low: bar.low, close: bar.close, observedAt: bar.latestReceivedAt })) },
    market, features.decisionAt, config);
    if (!validated.bars || c.requiredMinutes !== 150 || c.aggregation5m !== 'native_closed_5m_bars'
        || c.observedAt !== features.observedAt || features.observedReceivedAt !== features.observedAt
        || JSON.stringify(c.returnsUsd) !== JSON.stringify(validated.context.returnsUsd)
        || c.sigmaUsdSqrtSecond !== validated.context.sigmaUsdSqrtSecond) fail();
    if (!Array.isArray(snapshot.books) || snapshot.books.length !== 2
        || snapshot.books.some(book => !book || ['bids', 'asks'].some(side => !Array.isArray(book[side])
            || book[side].slice(0, 5).some(level => !(finite(level.price) && level.price > 0 && level.price < 1
                && finite(level.size) && level.size > 0))))) fail();
    const signal = next ? nextReversalSignal(features, config.signalParameters) : null;
    if (next && ACTIONS.some(action => action !== 'SKIP' && action !== signal.action && snapshot.orders?.[action])) fail();
    const allowed = ACTIONS.filter(action => action === 'SKIP' || snapshot.orders?.[action]);
    const entries = ACTIONS.slice(0, 2).map(action => {
        const order = snapshot.orders?.[action];
        if (!order) return null;
        if (!(finite(order.price) && order.price > 0 && order.price < 1
            && finite(order.shares) && order.shares > 0 && finite(order.cost) && order.cost > 0)) fail();
        return { limit_usd_per_share: order.price, shares: order.shares, total_cost_usd: order.cost };
    });
    const cents = bars.map(bar => [bar.open, bar.high, bar.low, bar.close].map(value => Math.round(value * 100)));
    if (cents.some(row => !row.every(value => Number.isSafeInteger(value) && value > 0))) fail();
    const anchor = cents[0][0];
    const context = { schema: version, source: 'binance_spot', symbol: 'BTCUSDT',
        candleIntervalMs: INTERVAL, historyStartAt: c.historyStartAt, historyEndAt: c.historyEndAt,
        decisionAt: features.decisionAt, observedAt: features.observedAt, fetchedAt: c.fetchedAt,
        marketOpenAt: market.open, marketEndAt: market.end, secondsToOpen: (market.open - snapshot.at) / 1000,
        marketSeconds: 300, priceAnchorUsd: anchor / 100, bars: cents.map(row => row.map(value => value / 100)),
        booksUpDown: snapshot.books.map(book => ['bids', 'asks'].map(side =>
            book[side].slice(0, 5).map(level => [level.price, level.size]))), entriesUpDown: entries };
    if (next) Object.assign(context, { reversalSignal: signal, confirmationOnly: true, allowedActions: [...allowed] });
    Object.assign(context, metrics(context.bars));
    const lines = [`snapshotId=${snapshot.snapshotId}`,
        'format=oldest first; OHLC cents [open-prevClose,high-open,low-open,close-open]; first prevClose=anchor',
        'units=returns USD 5/15/30/60/150m; sigma RMS close changes USD/sqrt(s); books [USD,shares] up to5 levels',
        'hypothesis=>=3 UP bars then first DOWN predicts DOWN; mirror UP; doji breaks streak',
        ...(next ? [`signal=${signal.action} prior_streak=${signal.priorStreak ?? 0}; confirm signal or SKIP`] : []),
        `window=${new Date(c.historyStartAt).toISOString()}/${new Date(c.historyEndAt).toISOString()}`,
        `decision=${new Date(features.decisionAt).toISOString()}`,
        `target=${new Date(market.open).toISOString()}/${new Date(market.end).toISOString()}`,
        `seconds_to_open=${context.secondsToOpen}`, `anchor=${context.priceAnchorUsd}`,
        `OHLC=${cents.map((row, i) => [row[0] - (i ? cents[i - 1][3] : anchor), row[1] - row[0],
            row[2] - row[0], row[3] - row[0]].join(' ')).join(';')}`,
        `returns=${Object.keys(WINDOWS).map(key => context.returnsUsd[key]).join(' ')}`,
        `sigma=${context.sigmaUsdSqrtSecond}`,
        ...context.booksUpDown.flatMap((book, i) => book.map((side, j) =>
            `${['UP', 'DOWN'][i]}${['bids', 'asks'][j]}=${side.map(level => level.join(' ')).join(';')}`)),
        `entries=${entries.map(entry => entry ? [entry.limit_usd_per_share, entry.shares, entry.total_cost_usd].join(' ') : 'null').join(';')}`,
        `allowed=${allowed.join(' ')}`];
    const input = lines.join('\n');
    return { input, inputHash: createHash('sha256').update(input).digest('hex'), inputBytes: Buffer.byteLength(input),
        allowed, context, inputCoverage: { source: 'binance_spot', symbol: 'BTCUSDT', completeMinutes: 150,
            minuteBars: 0, fiveMinuteBars: COUNT, fiveMinuteGroups: 0, fiveMinuteGroupsDerived: false,
            candleIntervalMs: INTERVAL, historyStartAt: c.historyStartAt, historyEndAt: c.historyEndAt,
            decisionAt: features.decisionAt, observedAt: features.observedAt, fetchedAt: c.fetchedAt,
            marketOpenAt: market.open, marketEndAt: market.end, truncated: false, encoding: version,
            ...(next ? { confirmationOnly: true, signalAction: signal.action, priorStreak: signal.priorStreak ?? 0 } : {}),
            bookLevelsUpDown: context.booksUpDown.map(book => book.map(side => side.length)),
            quantization: { ohlc: 'nearest_USD_0.01', returns: 'derived_from_cent_OHLC_nearest_USD_0.000001',
                sigma: 'cent_close_changes_nearest_USD_0.000001_per_sqrt_second',
                bookPricesAndSizes: 'validated_input_precision_preserved', entryPricesSharesAndCosts: 'validated_input_precision_preserved' } } };
}
