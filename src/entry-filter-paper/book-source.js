import { metadataIdentity } from '../ai-shadow/engine.js';
import { EARLY_BOOK_POLICY, readEarlyPaperBooks, validatedEarlyPaperBooks } from '../premarket-paper/early-book.js';
import { OperationalError } from '../restart/network.js';

const MAX_AGE_MS = 5000;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = market => JSON.stringify([metadataIdentity(market), market.accepting, market.negRisk,
    market.slug, market.open, market.end]);
const fixedIdentity = market => JSON.stringify([market.conditionId, market.tokens, market.minimum,
    market.fee, market.negRisk, market.accepting, market.slug, market.open, market.end]);

function checkedAge(maxAgeMs) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > MAX_AGE_MS)
        throw new Error('entry_rest_age_policy_invalid');
    return maxAgeMs;
}

export function validatedEntryFilterRestBooks(market, pair, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
    checkedAge(maxAgeMs);
    const books = validatedEarlyPaperBooks(market, pair, now, { maxVerificationAgeMs: maxAgeMs,
        maxMetadataAgeMs: maxAgeMs, maxHttpDateAgeMs: maxAgeMs });
    if (pair.validation && (pair.validation.source !== 'rest' || pair.validation.generation !== 0
        || pair.validation.identity !== metadataIdentity(market)
        || pair.validation.at !== pair.evidence.metadataVerifiedAt))
        throw new Error('entry_rest_metadata_changed');
    for (const book of books) {
        if (!integer(now) || book.timestamp > now || book.fetchedAt > now
            || now - book.timestamp > maxAgeMs || now - book.fetchedAt > maxAgeMs)
            throw new Error('execution_book_stale_or_future');
    }
    return books;
}

export async function readEntryFilterRestBooks(market, { client, clock = Date.now,
    deadlineAt, fetchImpl = globalThis.fetch, readBooks = readEarlyPaperBooks,
    maxAgeMs = MAX_AGE_MS } = {}) {
    checkedAge(maxAgeMs);
    const startedAt = clock();
    deadlineAt ??= startedAt + EARLY_BOOK_POLICY.maxRoundTripMs;
    if (!integer(startedAt) || !integer(deadlineAt) || deadlineAt <= startedAt)
        throw new Error('entry_rest_deadline');
    if (typeof client?.books !== 'function') throw new Error('entry_rest_metadata_reader_required');
    deadlineAt = Math.min(deadlineAt, startedAt + EARLY_BOOK_POLICY.maxRoundTripMs);
    const originalIdentity = identity(market), fixedBefore = fixedIdentity(market);
    // Client metadata refreshes can finish after our deadline; isolate their writes.
    const refreshed = structuredClone(market);
    let timer, expired = false;
    const checkDeadline = () => {
        const now = clock();
        if (expired || !integer(now) || now < startedAt || now > deadlineAt)
            throw new Error('entry_rest_deadline');
        return now;
    };
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            expired = true;
            reject(new OperationalError('entry_rest_timeout', 'timeout', { stage: 'entry_rest_read' }));
        }, deadlineAt - startedAt);
    });
    try {
        const result = await Promise.race([timeout, (async () => {
            await client.books(refreshed, { deadline: deadlineAt, retries: 0 });
            const metadataVerifiedAt = checkDeadline();
            if (fixedIdentity(refreshed) !== fixedBefore || identity(market) !== originalIdentity)
                throw new Error('entry_rest_metadata_changed');
            const pair = await readBooks(refreshed, { clock, deadlineAt, metadataVerifiedAt, fetchImpl });
            checkDeadline();
            return structuredClone(pair);
        })()]);
        const at = checkDeadline();
        if (fixedIdentity(refreshed) !== fixedBefore || identity(market) !== originalIdentity)
            throw new Error('entry_rest_metadata_changed');
        const books = validatedEntryFilterRestBooks(refreshed, result, at, maxAgeMs);
        const ticks = refreshed.ticks ?? [refreshed.tick, refreshed.tick];
        market.ticks = [...ticks];
        if (ticks[0] === ticks[1]) market.tick = ticks[0];
        market.tickVerifiedAt = Math.min(...result.evidence.books.map(book => book.tickVerification.receivedAt));
        const validation = { at: result.evidence.metadataVerifiedAt, generation: 0,
            identity: metadataIdentity(market), source: 'rest', bookEvidence: result.evidence };
        return { books, evidence: result.evidence, validation, source: 'rest' };
    } finally {
        expired = true;
        clearTimeout(timer);
    }
}
