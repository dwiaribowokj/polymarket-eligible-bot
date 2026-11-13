import { createHash, randomUUID } from 'node:crypto';
import { OperationalError } from '../restart/network.js';

export const EARLY_BOOK_POLICY = Object.freeze({
    schema: 'early-paper-rest-current-depth-v1', paperOnly: true,
    maxRoundTripMs: 3000, maxVerificationAgeMs: 5000, maxMetadataAgeMs: 5000,
    maxHttpDateAgeMs: 5000, maxResponseBytes: 2 * 1024 * 1024, maxLevelsPerSide: 20000,
});

const CLOB = 'https://clob.polymarket.com';
const TICKS = new Set([0.1, 0.01, 0.001, 0.0001]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const decimal = value => typeof value === 'number' && Number.isFinite(value) ? value
    : typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) ? Number(value) : NaN;
const onGrid = (price, tick) => Math.abs(price / tick - Math.round(price / tick)) <= 1e-8;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };

function checkedPolicy(policy) {
    const result = { ...EARLY_BOOK_POLICY, ...policy };
    if (result.schema !== EARLY_BOOK_POLICY.schema || result.paperOnly !== true
        || Object.keys(EARLY_BOOK_POLICY).filter(key => typeof EARLY_BOOK_POLICY[key] === 'number')
            .some(key => !Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > EARLY_BOOK_POLICY[key]))
        fail('early_book_policy_invalid');
    return result;
}

function marketIdentity(market) {
    const ticks = market?.ticks ?? [market?.tick, market?.tick], fee = market?.fee;
    if (!identity(market?.conditionId) || !Array.isArray(market.tokens) || market.tokens.length !== 2
        || !market.tokens.every(identity) || market.tokens[0] === market.tokens[1]
        || market.negRisk !== false || market.accepting !== true || !Number.isFinite(market.minimum) || market.minimum <= 0
        || !Array.isArray(ticks) || ticks.length !== 2 || !ticks.every(tick => TICKS.has(tick))
        || !fee || !Number.isFinite(fee.rate) || fee.rate < 0 || !Number.isFinite(fee.exponent)
        || fee.exponent <= 0 || typeof fee.takerOnly !== 'boolean') fail('early_book_market_invalid');
    return JSON.stringify([market.conditionId, market.tokens, market.minimum, ticks,
        fee.rate, fee.exponent, fee.takerOnly, market.negRisk, market.accepting]);
}

function assertAge(at, now, maximum, code) {
    if (!integer(at) || !integer(now) || now < at || now - at > maximum) fail(code);
}

function levels(rows, tick, side, policy) {
    if (!Array.isArray(rows) || rows.length > policy.maxLevelsPerSide) fail('early_book_depth_invalid');
    const seen = new Set(), result = [];
    for (const row of rows) {
        const price = decimal(row?.price), size = decimal(row?.size);
        if (!(price > 0 && price < 1 && Number.isFinite(size) && size > 0) || !onGrid(price, tick)
            || seen.has(price)) fail('early_book_depth_invalid');
        seen.add(price); result.push({ price, size });
    }
    return result.sort((a, b) => side === 'bids' ? b.price - a.price : a.price - b.price);
}

function depth(raw, tick, policy) {
    const bids = levels(raw?.bids, tick, 'bids', policy), asks = levels(raw?.asks, tick, 'asks', policy);
    if (bids.length && asks.length && bids[0].price > asks[0].price) fail('early_book_crossed');
    return { bids, asks };
}

function checkResponseEvidence(row, now, policy) {
    if (!row || !integer(row.requestStartedAt) || !integer(row.receivedAt)
        || row.receivedAt < row.requestStartedAt || row.roundTripMs !== row.receivedAt - row.requestStartedAt
        || row.roundTripMs > policy.maxRoundTripMs || !integer(row.deadlineAt) || row.receivedAt > row.deadlineAt
        || row.cachePolicy !== 'no-store' || row.cacheBust !== true || row.status !== 200)
        fail('early_book_response_unverified');
    assertAge(row.receivedAt, now, policy.maxVerificationAgeMs, 'early_book_verification_expired');
    if (!integer(row.httpDateAt) || row.httpDateAt > row.receivedAt + 1000
        || row.receivedAt - row.httpDateAt > policy.maxHttpDateAgeMs
        || row.httpAge !== null && row.httpAge !== 0
        || row.cacheStatus !== null && !['DYNAMIC', 'BYPASS', 'MISS', 'EXPIRED'].includes(row.cacheStatus))
        fail('early_book_response_cached_or_stale');
}

async function readJson(path, tokenId, options, policy) {
    const { clock, fetchImpl, deadlineAt, pairSignal } = options, requestStartedAt = clock();
    if (!integer(requestStartedAt) || !integer(deadlineAt) || deadlineAt <= requestStartedAt) fail('early_book_deadline');
    const budget = Math.min(policy.maxRoundTripMs, deadlineAt - requestStartedAt);
    const controller = new AbortController(), url = new URL(path, CLOB);
    url.searchParams.set('token_id', tokenId); url.searchParams.set('_paper_verify', randomUUID());
    let timer, abortPair;
    const aborted = new Promise((_, reject) => {
        abortPair = () => { controller.abort(); reject(new OperationalError('early_book_pair_aborted', 'timeout')); };
        pairSignal.addEventListener('abort', abortPair, { once: true });
        if (pairSignal.aborted) abortPair();
    });
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new OperationalError('early_book_read_timeout', 'timeout')); }, budget);
    });
    try {
        const result = await Promise.race([timeout, aborted, (async () => {
            controller.signal.throwIfAborted();
            const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', signal: controller.signal,
                redirect: 'error', headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache',
                    Accept: 'application/json' } });
            if (response.status !== 200) {
                const value = response.headers.get('retry-after');
                const retryAfter = value === null ? undefined : /^\d+(\.\d+)?$/.test(value) ? Number(value)
                    : Number.isFinite(Date.parse(value)) ? Math.max(0, (Date.parse(value) - clock()) / 1000) : undefined;
                const rateLimit = response.status === 429, serverError = response.status >= 500;
                const error = new OperationalError(rateLimit ? 'rate_limited' : serverError ? 'http_server_error' : 'early_book_http_rejected',
                    rateLimit ? 'rate_limit' : serverError ? 'transport' : 'api_rejection',
                    { httpStatus: response.status, retryAfter, stage: 'early_book_read', endpoint: 'clob' });
                await response.body?.cancel().catch(() => {});
                throw error;
            }
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > policy.maxResponseBytes))
                fail('early_book_body_too_large');
            if (!response.body?.getReader) fail('early_book_body_invalid');
            const reader = response.body.getReader(), chunks = [];
            let size = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > policy.maxResponseBytes) fail('early_book_body_too_large');
                    chunks.push(Buffer.from(value));
                }
            } finally {
                if (size > policy.maxResponseBytes || controller.signal.aborted) await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
            controller.signal.throwIfAborted();
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { fail('early_book_body_invalid'); }
            const receivedAt = clock(), age = response.headers.get('age'), date = response.headers.get('date');
            const evidence = { endpoint: `${CLOB}${path}`, tokenId, requestStartedAt, receivedAt,
                roundTripMs: receivedAt - requestStartedAt, deadlineAt, status: response.status,
                cachePolicy: 'no-store', cacheBust: true, httpDate: date, httpDateAt: Date.parse(date),
                httpAge: age === null ? null : /^\d+$/.test(age) ? Number(age) : NaN,
                cacheStatus: response.headers.get('cf-cache-status')?.toUpperCase() ?? null, responseBytes: size };
            checkResponseEvidence(evidence, receivedAt, policy);
            if (receivedAt > deadlineAt) fail('early_book_deadline');
            return { body, evidence };
        })()]);
        return result;
    } finally { clearTimeout(timer); pairSignal.removeEventListener('abort', abortPair); controller.abort(); }
}

function compareWebsocket(books, websocketBooks, market, now, policy) {
    if (websocketBooks == null) return { status: 'unavailable', authority: 'fresh_rest_full_snapshot' };
    if (!Array.isArray(websocketBooks) || websocketBooks.length !== 2) fail('early_book_websocket_invalid');
    const comparisons = websocketBooks.map((book, index) => {
        if (book?.tokenId !== market.tokens[index] || book.conditionId !== market.conditionId)
            fail('early_book_websocket_identity_mismatch');
        assertAge(book.timestamp, now, policy.maxVerificationAgeMs, 'early_book_websocket_stale');
        assertAge(book.fetchedAt, now, policy.maxVerificationAgeMs, 'early_book_websocket_stale');
        const tick = books[index].tick, quoted = depth(book, tick, policy);
        if (book.tick !== undefined && (!TICKS.has(book.tick) || book.tick < tick || !onGrid(book.tick, tick)))
            fail('early_book_websocket_tick_mismatch');
        const matches = hash(quoted) === hash({ bids: books[index].bids, asks: books[index].asks });
        if (!matches && book.timestamp >= books[index].timestamp) fail('early_book_websocket_conflict');
        return { tokenId: book.tokenId, timestamp: book.timestamp, fetchedAt: book.fetchedAt,
            status: matches ? 'matched' : 'older_than_rest', depthHash: hash(quoted) };
    });
    return { status: 'checked', authority: 'fresh_rest_full_snapshot', comparisons };
}

export async function readEarlyPaperBooks(market, { clock = Date.now, fetchImpl = globalThis.fetch,
    deadlineAt, metadataVerifiedAt, policy: suppliedPolicy, websocketBooks = null } = {}) {
    const policy = checkedPolicy(suppliedPolicy), identityBefore = marketIdentity(market), startedAt = clock();
    assertAge(metadataVerifiedAt, startedAt, policy.maxMetadataAgeMs, 'early_book_metadata_expired');
    deadlineAt ??= startedAt + policy.maxRoundTripMs;
    if (!integer(deadlineAt) || deadlineAt <= startedAt) fail('early_book_deadline');
    const pairController = new AbortController(), options = { clock, fetchImpl, deadlineAt, pairSignal: pairController.signal };
    let failure;
    const reads = ['/book', '/tick-size'].flatMap(path => market.tokens.map(token =>
        readJson(path, token, options, policy).catch(error => {
            if (!failure) { failure = error; pairController.abort(); }
            throw error;
        })));
    const settled = await Promise.allSettled(reads);
    if (failure) throw failure;
    const rawBooks = settled.slice(0, 2).map(row => row.value), rawTicks = settled.slice(2).map(row => row.value);
    const verifiedAt = clock();
    if (verifiedAt > deadlineAt) fail('early_book_deadline');
    if (marketIdentity(market) !== identityBefore) fail('early_book_metadata_changed');
    assertAge(metadataVerifiedAt, verifiedAt, policy.maxMetadataAgeMs, 'early_book_metadata_expired');
    const books = rawBooks.map(({ body: raw, evidence: response }, index) => {
        const tick = decimal(rawTicks[index].body?.minimum_tick_size), expectedTick = market.ticks?.[index] ?? market.tick;
        const sourceTick = decimal(raw?.tick_size);
        if (!TICKS.has(tick) || tick !== expectedTick || !TICKS.has(sourceTick)
            || sourceTick < tick || !onGrid(sourceTick, tick)) fail('early_book_tick_mismatch');
        if (raw?.market !== market.conditionId || raw.asset_id !== market.tokens[index]
            || raw.neg_risk !== false || decimal(raw.min_order_size) !== market.minimum)
            fail('early_book_identity_or_constraints_changed');
        const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp
            : typeof raw.timestamp === 'string' && /^\d+$/.test(raw.timestamp) ? Number(raw.timestamp) : NaN;
        if (!integer(timestamp) || timestamp === 0 || timestamp > response.receivedAt) fail('early_book_source_timestamp_invalid');
        if (typeof raw.hash !== 'string' || !/^[a-f0-9]{40}$/.test(raw.hash)) fail('early_book_source_hash_invalid');
        // The exchange timestamp can predate this current-book response. Keep
        // it intact and record fresh REST verification as separate evidence.
        return { tokenId: raw.asset_id, conditionId: raw.market, tick, sourceTick,
            minimum: market.minimum, negRisk: false, timestamp, fetchedAt: response.receivedAt,
            sourceTimestamp: raw.timestamp, sourceHash: raw.hash, ...depth(raw, tick, policy) };
    });
    const evidence = { schema: policy.schema, paperOnly: true, authority: 'fresh_rest_full_snapshot',
        sourceTimestampMeaning: 'exchange_book_timestamp', startedAt, verifiedAt, deadlineAt,
        metadataVerifiedAt, metadataIdentity: identityBefore, booksHash: hash(books),
        books: books.map((book, index) => ({ ...rawBooks[index].evidence, sourceTimestamp: book.sourceTimestamp,
            sourceTimestampMs: book.timestamp, sourceAgeMs: rawBooks[index].evidence.receivedAt - book.timestamp,
            sourceHash: book.sourceHash, sourceTick: book.sourceTick, tick: book.tick,
            tickVerification: rawTicks[index].evidence })),
        websocket: compareWebsocket(books, websocketBooks, market, verifiedAt, policy) };
    const result = { books, evidence };
    validatedEarlyPaperBooks(market, result, verifiedAt, policy);
    return result;
}

export function validatedEarlyPaperBooks(market, pair, now = Date.now(), suppliedPolicy) {
    const policy = checkedPolicy(suppliedPolicy), expectedIdentity = marketIdentity(market);
    const books = pair?.books, evidence = pair?.evidence;
    if (!evidence || evidence.schema !== policy.schema || evidence.paperOnly !== true
        || evidence.authority !== 'fresh_rest_full_snapshot' || evidence.sourceTimestampMeaning !== 'exchange_book_timestamp'
        || evidence.metadataIdentity !== expectedIdentity || !Array.isArray(books) || books.length !== 2
        || !Array.isArray(evidence.books) || evidence.books.length !== 2 || hash(books) !== evidence.booksHash)
        fail('early_book_evidence_invalid');
    assertAge(evidence.verifiedAt, now, policy.maxVerificationAgeMs, 'early_book_verification_expired');
    assertAge(evidence.metadataVerifiedAt, now, policy.maxMetadataAgeMs, 'early_book_metadata_expired');
    if (!integer(evidence.startedAt) || evidence.startedAt > evidence.verifiedAt
        || !integer(evidence.deadlineAt) || evidence.verifiedAt > evidence.deadlineAt
        || evidence.verifiedAt - evidence.startedAt > policy.maxRoundTripMs)
        fail('early_book_response_unverified');
    for (const [index, book] of books.entries()) {
        const proof = evidence.books[index], tick = market.ticks?.[index] ?? market.tick;
        checkResponseEvidence(proof, now, policy); checkResponseEvidence(proof.tickVerification, now, policy);
        if (proof.endpoint !== `${CLOB}/book` || proof.tickVerification.endpoint !== `${CLOB}/tick-size`
            || proof.tokenId !== market.tokens[index] || proof.tickVerification.tokenId !== market.tokens[index]
            || book.tokenId !== market.tokens[index] || book.conditionId !== market.conditionId
            || book.minimum !== market.minimum || book.negRisk !== false || book.tick !== tick || proof.tick !== tick
            || !TICKS.has(book.sourceTick) || book.sourceTick < tick || !onGrid(book.sourceTick, tick)
            || book.sourceTick !== proof.sourceTick
            || book.timestamp !== proof.sourceTimestampMs || book.sourceTimestamp !== proof.sourceTimestamp
            || book.sourceHash !== proof.sourceHash || book.fetchedAt !== proof.receivedAt
            || proof.sourceAgeMs !== proof.receivedAt - book.timestamp
            || !integer(book.timestamp) || book.timestamp <= 0 || book.timestamp > proof.receivedAt
            || proof.deadlineAt !== evidence.deadlineAt || proof.tickVerification.deadlineAt !== evidence.deadlineAt
            || proof.requestStartedAt < evidence.startedAt || proof.receivedAt > evidence.verifiedAt
            || proof.tickVerification.requestStartedAt < evidence.startedAt || proof.tickVerification.receivedAt > evidence.verifiedAt)
            fail('early_book_evidence_invalid');
        depth(book, tick, policy);
    }
    return books;
}
