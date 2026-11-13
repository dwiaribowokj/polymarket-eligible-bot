import { createHash } from 'node:crypto';

export const COMPACT_PREMARKET_PROMPT_VERSION = 'fair-near-open-complete-cent-context-v1';
export const COMPACT_PREMARKET_PROMPT = 'BTC 5m paper: predict future closing 60s Chainlink TWAP >= future opening TWAP (UP), else DOWN. Opening unknown. End is UTC completed history end; opens 60s later, lasts 300s. seconds_to_open is from capture. OHLC rows=30 completed 1m, oldest first, cents offsets from anchor. Groups of 5 derive six 5m OHLC, not extra evidence. Returns USD=30s,60s,3m,5m,15m,30m; sigma=USD/sqrt(s). Books UP/DOWN bids/asks=[price USD,shares],up to 5 levels. Entries UP/DOWN=[limit USD,shares,total USD cost including fees+gas]. Winner pays $1/share. BUY only allowed with positive expected net after costs; else SKIP. Evaluate all history, returns, volatility and both books. Choice probabilities are not win probabilities.';
export const COMPACT_PREMARKET_QUESTIONS = Object.freeze({ action: Object.freeze({ type: 'choice',
    instructions: COMPACT_PREMARKET_PROMPT, criteria: Object.freeze({
        BUY_UP: 'Up with positive net value; must be allowed.',
        BUY_DOWN: 'Down with positive net value; must be allowed.',
        SKIP: 'No positive net value or insufficient evidence.'
    }) }) });

const RETURN_KEYS = ['s30', 's60', 'm3', 'm5', 'm15', 'm30'];
const ACTIONS = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
const finite = Number.isFinite;
const fail = () => { throw new Error('premarket_compact_context_invalid'); };
const ohlcValid = bar => Array.isArray(bar) && bar.length === 4 && bar.every(finite)
    && bar[1] >= Math.max(bar[0], bar[3]) && bar[2] <= Math.min(bar[0], bar[3]);
const aggregate = bars => Array.from({ length: 6 }, (_, i) => {
    const group = bars.slice(i * 5, i * 5 + 5);
    return [group[0][0], Math.max(...group.map(bar => bar[1])),
        Math.min(...group.map(bar => bar[2])), group.at(-1)[3]];
});

/** Takes the full validated long-history encoding; quantizes every arm identically. */
export function buildCompactPremarketInput(encoded) {
    let source;
    try { source = JSON.parse(encoded?.input); } catch { fail(); }
    const coverage = encoded?.inputCoverage, oldContext = source?.context;
    if (!coverage || coverage.truncated !== false || coverage.minuteBars !== 30 || coverage.fiveMinuteGroups !== 6
        || !oldContext || oldContext.source !== 'chainlink_btc_usd' || oldContext.complete_minutes !== 30
        || oldContext.candle_interval_seconds !== 60
        || oldContext.aggregation_5m !== 'consecutive_groups_of_five_completed_1m_bars'
        || typeof source.snapshotId !== 'string' || !source.snapshotId || source.snapshotId.length > 256
        || /[\u0000-\u001f]/.test(source.snapshotId)
        || !(finite(source.price_anchor_usd) && source.price_anchor_usd > 0)
        || !finite(source.seconds_to_open) || source.seconds_to_open < 58 || source.seconds_to_open > 60
        || source.market_seconds !== 300 || source.opening_twap !== null
        || !Array.isArray(source.bars) || source.bars.length !== 30 || !source.bars.every(ohlcValid)
        || !Array.isArray(oldContext.bars_5m) || oldContext.bars_5m.length !== 6 || !oldContext.bars_5m.every(ohlcValid)
        || !oldContext.returns_usd || RETURN_KEYS.some(key => !finite(oldContext.returns_usd[key]))
        || !(finite(source.diagnostics?.sigmaUsdSqrtSecond) && source.diagnostics.sigmaUsdSqrtSecond >= 0)
        || !Array.isArray(source.allowed) || !source.allowed.includes('SKIP')
        || source.allowed.some(action => !ACTIONS.includes(action)) || new Set(source.allowed).size !== source.allowed.length)
        fail();
    const startAt = Date.parse(oldContext.window_start_utc), endAt = Date.parse(oldContext.window_end_utc);
    if (!finite(startAt) || !finite(endAt) || endAt - startAt !== 1800000 || endAt % 60000 !== 0
        || Date.parse(oldContext.decision_at_utc) !== endAt || coverage.historyStartAt !== startAt
        || coverage.historyEndAt !== endAt || coverage.decisionAt !== endAt) fail();
    const expectedGroups = aggregate(source.bars);
    if (oldContext.bars_5m.some((bar, i) => bar.some((value, j) => Math.abs(value - expectedGroups[i][j]) > 1e-6))) fail();
    if (!Array.isArray(source.books_up_down) || source.books_up_down.length !== 2
        || source.books_up_down.some(book => !Array.isArray(book) || book.length !== 2
            || book.some(side => !Array.isArray(side) || side.length > 5
                || side.some(level => !Array.isArray(level) || level.length !== 2
                    || !(finite(level[0]) && level[0] > 0 && level[0] < 1)
                    || !(finite(level[1]) && level[1] > 0))))) fail();
    if (!Array.isArray(source.entry_up_down) || source.entry_up_down.length !== 2
        || source.entry_up_down.some((entry, i) => entry === null ? source.allowed.includes(ACTIONS[i])
            : !source.allowed.includes(ACTIONS[i]) || !(finite(entry.limit_usd_per_share)
                && entry.limit_usd_per_share > 0 && entry.limit_usd_per_share < 1
                && finite(entry.shares) && entry.shares > 0 && finite(entry.total_cost_usd) && entry.total_cost_usd > 0))) fail();

    // Quantize absolute prices first, so every arm sees the same cent-valued OHLC.
    const anchorCents = Math.round(source.price_anchor_usd * 100);
    const barsCents = source.bars.map(bar => bar.map(offset => Math.round(source.price_anchor_usd * 100 + offset)));
    if (!Number.isSafeInteger(anchorCents) || barsCents.flat().some(value => !Number.isSafeInteger(value) || value <= 0)) fail();
    const context = {
        schema: COMPACT_PREMARKET_PROMPT_VERSION, source: oldContext.source,
        historyStartAt: startAt, historyEndAt: endAt, decisionAt: endAt,
        secondsToOpen: source.seconds_to_open, marketSeconds: 300, priceAnchorUsd: anchorCents / 100,
        // Array tuples are [open, high, low, close], in absolute USD, oldest first.
        bars: barsCents.map(bar => bar.map(value => value / 100)),
        bars5m: aggregate(barsCents).map(bar => bar.map(value => value / 100)),
        returnsUsd: Object.fromEntries(RETURN_KEYS.map(key => [key, oldContext.returns_usd[key]])),
        sigmaUsdSqrtSecond: source.diagnostics.sigmaUsdSqrtSecond,
        booksUpDown: structuredClone(source.books_up_down), entriesUpDown: structuredClone(source.entry_up_down)
    };
    const allowed = [...source.allowed];
    const lines = [
        `snapshotId=${source.snapshotId}`, `end=${new Date(endAt).toISOString()}`,
        `seconds_to_open=${context.secondsToOpen}`, `anchor=${context.priceAnchorUsd}`,
        `OHLC=${barsCents.map(bar => bar.map(value => value - anchorCents).join(' ')).join(';')}`,
        `returns=${RETURN_KEYS.map(key => context.returnsUsd[key]).join(' ')}`, `sigma=${context.sigmaUsdSqrtSecond}`,
        ...context.booksUpDown.flatMap((book, i) => book.map((side, j) =>
            `${['UP', 'DOWN'][i]}${['bids', 'asks'][j]}=${side.map(([price, size]) => `${price} ${size}`).join(';')}`)),
        `entries=${context.entriesUpDown.map(entry => entry === null ? 'null'
            : `${entry.limit_usd_per_share} ${entry.shares} ${entry.total_cost_usd}`).join(';')}`,
        `allowed=${allowed.join(' ')}`
    ];
    const input = lines.join('\n');
    return { input, inputHash: createHash('sha256').update(input).digest('hex'), inputBytes: Buffer.byteLength(input),
        allowed, context, inputCoverage: { ...coverage, encoding: COMPACT_PREMARKET_PROMPT_VERSION,
            truncated: false, fiveMinuteGroupsDerived: true, bookLevelsUpDown: context.booksUpDown.map(book => book.map(side => side.length)),
            quantization: { ohlc: 'nearest_USD_0.01', returns: 'nearest_USD_0.000001',
                sigma: 'nearest_USD_0.000001_per_sqrt_second', bookPricesAndSizes: 'validated_input_precision_preserved',
                entryPricesSharesAndCosts: 'validated_input_precision_preserved' } } };
}
