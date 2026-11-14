import { readEarlyPaperBooks } from '../premarket-paper/early-book.js';

const identity = market => JSON.stringify([market.slug, market.open, market.end, market.conditionId,
    market.tokens, market.outcomes, market.minimum, market.fee, market.negRisk]);

// Fresh REST receipt and independent tick verification do not imply the last book change was recent.
export async function readValueBooks(market, { client, clock = Date.now,
    deadlineAt = clock() + 3000, maxAgeMs = 5000, readBooks = readEarlyPaperBooks,
    fetchImpl = globalThis.fetch } = {}) {
    const startedAt = clock(), original = identity(market);
    deadlineAt = Math.min(deadlineAt, startedAt + 3000);
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= startedAt || maxAgeMs < 1 || maxAgeMs > 5000)
        throw new Error('collector_book_deadline_invalid');
    let timer, expired = false;
    const check = () => {
        if (expired || clock() < startedAt || clock() > deadlineAt) throw new Error('collector_book_timeout');
    };
    try {
        const { refreshed, pair } = await Promise.race([new Promise((_, reject) => {
            timer = setTimeout(() => {
                expired = true; reject(new Error('collector_book_timeout'));
            }, deadlineAt - startedAt);
        }), (async () => {
            const refreshed = await client.market(market.slug, { deadline: deadlineAt, retries: 0 });
            check();
            if (identity(refreshed) !== original || identity(market) !== original || refreshed.accepting !== true)
                throw new Error('collector_book_metadata_changed');
            const ticks = await Promise.all(refreshed.tokens.map(token => client.tickSize(token)));
            check();
            if (ticks.some(tick => ![0.1, 0.01, 0.001, 0.0001].includes(tick)))
                throw new Error('collector_book_tick_invalid');
            refreshed.ticks = ticks;
            if (ticks[0] === ticks[1]) refreshed.tick = ticks[0];
            const metadataVerifiedAt = clock();
            const pair = await readBooks(refreshed, { clock, deadlineAt, metadataVerifiedAt, fetchImpl,
                policy: { maxVerificationAgeMs: maxAgeMs, maxMetadataAgeMs: maxAgeMs, maxHttpDateAgeMs: maxAgeMs } });
            check();
            return { refreshed, pair };
        })()]);
        check();
        if (identity(market) !== original) throw new Error('collector_book_metadata_changed');
        market.ticks = [...(refreshed.ticks ?? [refreshed.tick, refreshed.tick])];
        market.tick = refreshed.tick;
        return { ...pair, source: 'rest' };
    } finally { expired = true; clearTimeout(timer); }
}
