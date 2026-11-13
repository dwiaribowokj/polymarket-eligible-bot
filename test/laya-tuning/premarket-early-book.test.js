import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_BOOK_POLICY, readEarlyPaperBooks, validatedEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';
import { retryable, safeError } from '../../src/restart/network.js';

const AT = Date.parse('2026-10-28T12:00:00Z');
const market = () => ({ conditionId: 'condition', tokens: ['up', 'down'], minimum: 5,
    ticks: [.01, .01], tick: .01, negRisk: false, accepting: true,
    fee: { rate: .07, exponent: 1, takerOnly: true } });
const rawBook = token => ({ market: 'condition', asset_id: token, min_order_size: '5',
    tick_size: '.01', neg_risk: false, timestamp: String(AT - 120000), hash: 'a'.repeat(40),
    bids: [{ price: '.48', size: '8' }, { price: '.49', size: '10' }],
    asks: [{ price: '.51', size: '9' }, { price: '.50', size: '2.5' }] });

function fixture({ mutateBook, mutateTick, headers = {}, status = 200, advance = 0, policy, body,
    mutateMarket } = {}) {
    let now = AT;
    const expected = market(), calls = [];
    const fetchImpl = async (input, options) => {
        const url = new URL(input), token = url.searchParams.get('token_id'); calls.push({ url, options });
        let value = url.pathname === '/book' ? rawBook(token) : { minimum_tick_size: .01 };
        if (url.pathname === '/book') mutateBook?.(value, token);
        else mutateTick?.(value, token);
        mutateMarket?.(expected);
        now = AT + advance;
        return new Response(body ?? JSON.stringify(value), { status,
            headers: { Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC', ...headers } });
    };
    return { expected, calls, clock: () => now,
        async read(options = {}) { return readEarlyPaperBooks(expected, { fetchImpl, clock: () => now,
            metadataVerifiedAt: AT, deadlineAt: AT + 2000, policy, ...options }); } };
}

test('fresh uncached REST verifies quiet depth without changing source timestamps', async () => {
    const f = fixture(), result = await f.read();
    assert.equal(result.books[0].timestamp, AT - 120000);
    assert.equal(result.books[0].sourceTimestamp, String(AT - 120000));
    assert.equal(result.books[0].fetchedAt, AT);
    assert.equal(result.evidence.books[0].sourceAgeMs, 120000);
    assert.equal(result.evidence.sourceTimestampMeaning, 'exchange_book_timestamp');
    assert.equal(result.evidence.websocket.status, 'unavailable');
    assert.equal(result.evidence.authority, 'fresh_rest_full_snapshot');
    assert.deepEqual(result.books[0].asks.map(row => row.price), [.5, .51]);
    assert.deepEqual(result.books[0].bids.map(row => row.price), [.49, .48]);
    assert.equal(result.books[0].asks[0].size, 2.5, 'partial-fill depth remains exact');
    assert.deepEqual(validatedEarlyPaperBooks(f.expected, structuredClone(result), AT + 250), result.books);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(f.calls.length, 4);
    assert.equal(new Set(f.calls.map(call => call.url.searchParams.get('_paper_verify'))).size, 4);
    for (const { url, options } of f.calls) {
        assert.equal(url.origin, 'https://clob.polymarket.com');
        assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store');
        assert.equal(options.headers['Cache-Control'], 'no-cache, no-store');
        assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    }
});

test('book grid may be coarser only with fresh independently verified compatible tick', async () => {
    const f = fixture({ mutateBook: b => { b.tick_size = '.1'; } });
    const result = await f.read();
    assert.equal(result.books[0].sourceTick, .1); assert.equal(result.books[0].tick, .01);
    assert.equal(result.evidence.books[0].tickVerification.endpoint, 'https://clob.polymarket.com/tick-size');
});

for (const [label, mutateBook, error] of [
    ['wrong token', b => { b.asset_id = 'other'; }, 'identity_or_constraints_changed'],
    ['wrong condition', b => { b.market = 'other'; }, 'identity_or_constraints_changed'],
    ['minimum changed', b => { b.min_order_size = '6'; }, 'identity_or_constraints_changed'],
    ['negative-risk market', b => { b.neg_risk = true; }, 'identity_or_constraints_changed'],
    ['unknown negative-risk flag', b => { delete b.neg_risk; }, 'identity_or_constraints_changed'],
    ['invalid source hash', b => { b.hash = ''; }, 'source_hash_invalid'],
    ['future source', b => { b.timestamp = String(AT + 1); }, 'source_timestamp_invalid'],
    ['missing source', b => { delete b.timestamp; }, 'source_timestamp_invalid'],
    ['fractional source', b => { b.timestamp = AT - .5; }, 'source_timestamp_invalid'],
    ['finer book tick', b => { b.tick_size = '.001'; }, 'tick_mismatch'],
    ['unknown book tick', b => { b.tick_size = '.02'; }, 'tick_mismatch'],
    ['missing depth', b => { delete b.asks; }, 'depth_invalid'],
    ['invalid level', b => { b.asks.push({ price: '.52', size: 'junk' }); }, 'depth_invalid'],
    ['off-grid level', b => { b.asks[0].price = '.515'; }, 'depth_invalid'],
    ['duplicate level', b => { b.asks.push({ ...b.asks[0] }); }, 'depth_invalid'],
    ['zero size', b => { b.asks[0].size = '0'; }, 'depth_invalid'],
    ['negative size', b => { b.asks[0].size = -1; }, 'depth_invalid'],
    ['crossed book', b => { b.bids[0].price = '.60'; }, 'crossed'],
]) test(`rejects ${label} without dropping malformed levels`, async () => {
    await assert.rejects(fixture({ mutateBook }).read(), { message: `early_book_${error}` });
});

test('empty depth is recorded exactly and cannot manufacture executable liquidity', async () => {
    const f = fixture({ mutateBook: b => { b.asks = []; } }), pair = await f.read();
    assert.deepEqual(pair.books[0].asks, []);
});

test('independent tick and book mismatch rejects rather than repricing metadata', async () => {
    const f = fixture({ mutateTick: b => { b.minimum_tick_size = .001; } });
    await assert.rejects(f.read(), /early_book_tick_mismatch/);
    assert.deepEqual(f.expected.ticks, [.01, .01]);
});

for (const [label, headers] of [
    ['positive cache Age', { Age: '1' }], ['malformed cache Age', { Age: 'unknown' }],
    ['cache HIT', { 'CF-Cache-Status': 'HIT' }], ['cache STALE', { 'CF-Cache-Status': 'STALE' }],
    ['unknown cache status', { 'CF-Cache-Status': 'UPDATING' }],
    ['old HTTP Date', { Date: new Date(AT - 6000).toUTCString() }],
    ['future HTTP Date', { Date: new Date(AT + 2000).toUTCString() }],
    ['missing valid HTTP Date', { Date: '' }],
]) test(`rejects ${label}`, async () => {
    await assert.rejects(fixture({ headers }).read(), /early_book_response_cached_or_stale/);
});

test('same-second zero cache Age is allowed and retained as evidence', async () => {
    const pair = await fixture({ headers: { Age: '0' } }).read();
    assert.equal(pair.evidence.books[0].httpAge, 0);
});

test('rejects HTTP failures, oversized streaming bodies, invalid JSON and excess depth', async () => {
    await assert.rejects(fixture({ status: 503 }).read(), /http_server_error/);
    await assert.rejects(fixture({ headers: { 'Content-Length': '2097153' } }).read(), /early_book_body_too_large/);
    await assert.rejects(fixture({ policy: { maxResponseBytes: 10 } }).read(), /early_book_body_too_large/);
    await assert.rejects(fixture({ body: '<html>error</html>' }).read(), /early_book_body_invalid/);
    await assert.rejects(fixture({ policy: { maxLevelsPerSide: 1 } }).read(), /early_book_depth_invalid/);
});

test('deadline, RTT and wall-clock regressions reject a completed response', async () => {
    await assert.rejects(fixture({ advance: 2001 }).read(), /early_book_(response_unverified|deadline)/);
    await assert.rejects(fixture({ advance: 3001 }).read({ deadlineAt: AT + 10000 }), /early_book_response_unverified/);
    await assert.rejects(fixture({ advance: -1 }).read(), /early_book_response_unverified/);
    await assert.rejects(fixture().read({ deadlineAt: AT }), /early_book_deadline/);
});

test('timeout covers a body that stalls after HTTP headers', async () => {
    const signals = [];
    await assert.rejects(readEarlyPaperBooks(market(), { metadataVerifiedAt: AT, clock: () => AT,
        deadlineAt: AT + 1000, policy: { maxRoundTripMs: 15 }, fetchImpl: async (url, options) => {
            signals.push(options.signal);
            return new Response(new ReadableStream({ start() {} }), { headers: { Date: new Date(AT).toUTCString() } });
        } }), /early_book_read_timeout/);
    assert.ok(signals.some(signal => signal.aborted));
});

test('late transport result cannot turn a timed-out read into successful evidence', async () => {
    let resolve;
    const transport = new Promise(r => { resolve = r; });
    const pending = readEarlyPaperBooks(market(), { metadataVerifiedAt: AT, clock: () => AT,
        policy: { maxRoundTripMs: 15 }, fetchImpl: () => transport });
    await assert.rejects(pending, /early_book_read_timeout/);
    resolve(new Response(JSON.stringify(rawBook('up')), { headers: { Date: new Date(AT).toUTCString() } }));
    await new Promise(r => setImmediate(r));
});

test('metadata must be recent, accepting, unchanged, and contain explicit fees', async () => {
    await assert.rejects(fixture().read({ metadataVerifiedAt: AT - 5001 }), /early_book_metadata_expired/);
    await assert.rejects(fixture().read({ metadataVerifiedAt: AT + 1 }), /early_book_metadata_expired/);
    const changed = fixture({ mutateMarket: m => { m.fee.rate = .08; } });
    await assert.rejects(changed.read(), /early_book_metadata_changed/);
    for (const mutate of [m => { m.accepting = false; }, m => { delete m.fee; },
        m => { m.fee.takerOnly = undefined; }, m => { m.fee.rate = NaN; }, m => { m.negRisk = true; }]) {
        const f = fixture(); mutate(f.expected);
        await assert.rejects(f.read(), /early_book_market_invalid/);
        assert.equal(f.calls.length, 0);
    }
});

test('evidence cannot extend metadata or response freshness or hide changed depth', async () => {
    const f = fixture(), pair = await f.read();
    assert.throws(() => validatedEarlyPaperBooks(f.expected, pair, AT - 1), /verification_expired/);
    assert.throws(() => validatedEarlyPaperBooks(f.expected, pair, AT + 5001), /verification_expired/);
    const depthChanged = structuredClone(pair); depthChanged.books[0].asks[0].size = 1000;
    assert.throws(() => validatedEarlyPaperBooks(f.expected, depthChanged, AT), /evidence_invalid/);
    const metadataChanged = structuredClone(f.expected); metadataChanged.minimum = 6;
    assert.throws(() => validatedEarlyPaperBooks(metadataChanged, pair, AT), /evidence_invalid/);
    f.expected.accepting = false;
    assert.throws(() => validatedEarlyPaperBooks(f.expected, pair, AT), /market_invalid/);
});

test('WS matching depth adds corroboration; newer conflicting depth vetoes REST', async () => {
    const f = fixture(), pair = await f.read();
    const websocketBooks = structuredClone(pair.books).map(book => ({ ...book, timestamp: AT, fetchedAt: AT }));
    const checked = await f.read({ websocketBooks });
    assert.equal(checked.evidence.websocket.status, 'checked');
    assert.equal(checked.evidence.websocket.comparisons[0].status, 'matched');
    websocketBooks[0].asks[0].size = 1;
    await assert.rejects(f.read({ websocketBooks }), /early_book_websocket_conflict/);
    websocketBooks[0].conditionId = 'other';
    await assert.rejects(f.read({ websocketBooks }), /early_book_websocket_identity_mismatch/);
});

test('heartbeat receipt cannot make stale WS quotes corroborate a REST snapshot', async () => {
    const f = fixture(), pair = await f.read();
    const websocketBooks = structuredClone(pair.books);
    await assert.rejects(f.read({ websocketBooks }), /early_book_websocket_stale/);
});

test('policy cannot widen limits or enable a non-paper mode', async () => {
    await assert.rejects(fixture({ policy: { paperOnly: false } }).read(), /early_book_policy_invalid/);
    await assert.rejects(fixture({ policy: { maxRoundTripMs: EARLY_BOOK_POLICY.maxRoundTripMs + 1 } }).read(), /early_book_policy_invalid/);
});

test('HTTP failures expose safe retry classification and Retry-After without performing retries', async () => {
    for (const [status, category, code, retry] of [
        [429, 'rate_limit', 'rate_limited', true], [503, 'transport', 'http_server_error', true],
        [404, 'api_rejection', 'early_book_http_rejected', false],
    ]) {
        const f = fixture({ status, headers: { 'Retry-After': '2' } });
        await assert.rejects(f.read(), error => {
            assert.equal(retryable(error), retry);
            assert.deepEqual(safeError(error), { name: 'OperationalError', code, category,
                stage: 'early_book_read', endpoint: 'clob', httpStatus: status, retryAfter: 2 });
            return true;
        });
        assert.equal(f.calls.length, 4, 'one call per endpoint, no retry');
    }
});

test('one failed response aborts and settles every sibling request before returning', async () => {
    const signals = [], cancelled = [];
    await assert.rejects(readEarlyPaperBooks(market(), { metadataVerifiedAt: AT, clock: () => AT,
        fetchImpl: async (url, options) => {
            signals.push(options.signal);
            if (new URL(url).pathname === '/book' && new URL(url).searchParams.get('token_id') === 'up')
                return new Response('{}', { status: 503 });
            return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
                cancelled.push(true); reject(new Error('sibling_aborted'));
            }, { once: true }));
        } }), /http_server_error/);
    assert.equal(signals.length, 4); assert.equal(cancelled.length, 3);
    assert.ok(signals.every(signal => signal.aborted));
});
