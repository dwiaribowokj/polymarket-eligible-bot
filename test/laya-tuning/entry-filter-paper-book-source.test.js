import test from 'node:test';
import assert from 'node:assert/strict';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';
import { readEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';
import { readEntryFilterRestBooks, validatedEntryFilterRestBooks } from '../../src/entry-filter-paper/book-source.js';

const AT = Date.parse('2026-10-31T12:00:00Z');
const market = () => ({ slug: 'btc-updown-5m-1', open: AT - 240000, end: AT + 60000,
    conditionId: 'condition', tokens: ['up', 'down'], minimum: 5,
    ticks: [.01, .01], tick: .01, negRisk: false, accepting: true,
    fee: { rate: .07, exponent: 1, takerOnly: true } });
const rawBook = token => ({ market: 'condition', asset_id: token, min_order_size: '5',
    tick_size: '.01', neg_risk: false, timestamp: String(AT - 100), hash: 'a'.repeat(40),
    bids: [{ price: '.48', size: '8' }, { price: '.49', size: '10' }],
    asks: [{ price: '.51', size: '9' }, { price: '.50', size: '2.5' }] });

function fixture({ mutateBook, mutateTick, headers = {}, refresh, advance = 0, readBooks } = {}) {
    let now = AT;
    const expected = market(), calls = [], metadataCalls = [];
    const client = { async books(value, options) {
        metadataCalls.push({ value, options });
        await refresh?.(value);
        return [];
    } };
    const fetchImpl = async (input, options) => {
        const url = new URL(input), token = url.searchParams.get('token_id');
        calls.push({ url, options });
        const value = url.pathname === '/book' ? rawBook(token) : { minimum_tick_size: .01 };
        if (url.pathname === '/book') mutateBook?.(value, token);
        else mutateTick?.(value, token);
        now = AT + advance;
        return new Response(JSON.stringify(value), { headers: {
            Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC', ...headers } });
    };
    return { expected, calls, metadataCalls, client, clock: () => now,
        setNow(at) { now = at; },
        read(options = {}) { return readEntryFilterRestBooks(expected, { client, fetchImpl,
            clock: () => now, deadlineAt: AT + 2000, readBooks, ...options }); } };
}

test('fresh REST verifies source timestamps and independent ticks with a bounded metadata read', async () => {
    const f = fixture(), pair = await f.read();
    assert.equal(pair.source, 'rest');
    assert.equal(pair.validation.source, 'rest');
    assert.equal(pair.validation.generation, 0);
    assert.equal(pair.validation.identity, metadataIdentity(f.expected));
    assert.equal(pair.validation.at, AT);
    assert.equal(pair.validation.bookEvidence, pair.evidence);
    assert.equal(pair.books[0].timestamp, AT - 100);
    assert.equal(pair.books[0].sourceTimestamp, String(AT - 100));
    assert.equal(pair.books[0].fetchedAt, AT);
    assert.equal(pair.evidence.books[0].sourceAgeMs, 100);
    assert.equal(pair.evidence.authority, 'fresh_rest_full_snapshot');
    assert.equal(pair.evidence.paperOnly, true);
    assert.deepEqual(pair.books[0].asks, [{ price: .5, size: 2.5 }, { price: .51, size: 9 }]);
    assert.deepEqual(pair.books[0].bids.map(row => row.price), [.49, .48]);
    assert.equal(f.metadataCalls.length, 1);
    assert.notEqual(f.metadataCalls[0].value, f.expected);
    assert.deepEqual(f.metadataCalls[0].options, { deadline: AT + 2000, retries: 0 });
    assert.equal(f.calls.length, 4);
    assert.equal(new Set(f.calls.map(({ url }) => url.searchParams.get('_paper_verify'))).size, 4);
    for (const { options } of f.calls) {
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers['Cache-Control'], 'no-cache, no-store');
        assert.equal(options.redirect, 'error');
    }
    assert.deepEqual(validatedEntryFilterRestBooks(f.expected, structuredClone(pair), AT + 100), pair.books);
});

test('source age is independently limited to 5000ms despite a fresh HTTP response', async () => {
    for (const age of [5001, 120000])
        await assert.rejects(fixture({ mutateBook: book => { book.timestamp = String(AT - age); } }).read(),
            /execution_book_stale_or_future/);
    const f = fixture({ mutateBook: book => { book.timestamp = String(AT - 5000); } }), pair = await f.read();
    assert.equal(pair.books[0].timestamp, AT - 5000);
    assert.throws(() => validatedEntryFilterRestBooks(f.expected, pair, AT + 1), /execution_book_stale_or_future/);
    await assert.rejects(fixture().read({ maxAgeMs: 99 }), /execution_book_stale_or_future/);
    await assert.rejects(fixture().read({ maxAgeMs: 5001 }), /entry_rest_age_policy_invalid/);
});

for (const [label, mutateBook, expectedError] of [
    ['future timestamp', book => { book.timestamp = String(AT + 1); }, 'source_timestamp_invalid'],
    ['wrong token', book => { book.asset_id = 'other'; }, 'identity_or_constraints_changed'],
    ['wrong condition', book => { book.market = 'other'; }, 'identity_or_constraints_changed'],
    ['different minimum', book => { book.min_order_size = '6'; }, 'identity_or_constraints_changed'],
    ['negative risk', book => { book.neg_risk = true; }, 'identity_or_constraints_changed'],
    ['missing risk flag', book => { delete book.neg_risk; }, 'identity_or_constraints_changed'],
    ['off-grid depth', book => { book.asks[0].price = '.515'; }, 'depth_invalid'],
    ['zero depth size', book => { book.asks[0].size = '0'; }, 'depth_invalid'],
    ['missing depth', book => { delete book.asks; }, 'depth_invalid'],
    ['finer unverified source tick', book => { book.tick_size = '.001'; }, 'tick_mismatch'],
]) test(`REST recovery rejects ${label}`, async () => {
    await assert.rejects(fixture({ mutateBook }).read(), new RegExp(`early_book_${expectedError}`));
});

test('empty sides and partial liquidity remain exact for the candidate and fill checks', async () => {
    const f = fixture({ mutateBook: (book, token) => {
        if (token === 'down') { book.asks = []; book.bids = []; }
    } });
    const pair = await f.read();
    assert.deepEqual(pair.books[1].asks, []);
    assert.deepEqual(pair.books[1].bids, []);
    assert.equal(pair.books[0].asks[0].size, 2.5);
    assert.equal(pair.books[0].minimum, 5);
});

test('metadata tick refresh is committed only after the independent tick endpoint confirms it', async () => {
    const f = fixture({ refresh: value => { value.ticks = [.001, .001]; value.tick = .001; },
        mutateTick: tick => { tick.minimum_tick_size = .001; } });
    const pair = await f.read();
    assert.deepEqual(f.expected.ticks, [.001, .001]);
    assert.equal(f.expected.tick, .001);
    assert.equal(pair.books[0].tick, .001);
    assert.equal(pair.books[0].sourceTick, .01);
    assert.equal(pair.validation.identity, metadataIdentity(f.expected));
    const mismatch = fixture({ refresh: value => { value.ticks = [.001, .001]; value.tick = .001; } });
    await assert.rejects(mismatch.read(), /early_book_tick_mismatch/);
    assert.deepEqual(mismatch.expected.ticks, [.01, .01]);
    assert.equal(mismatch.expected.tick, .01);
});

for (const [label, mutation] of [
    ['fees', value => { value.fee.rate = .08; }],
    ['fee taker flag', value => { value.fee.takerOnly = false; }],
    ['minimum', value => { value.minimum = 6; }],
    ['tokens', value => { value.tokens.reverse(); }],
    ['condition', value => { value.conditionId = 'other'; }],
    ['negative risk', value => { value.negRisk = true; }],
    ['accepting', value => { value.accepting = false; }],
]) test(`metadata refresh cannot silently change ${label}`, async () => {
    const f = fixture({ refresh: mutation }), before = structuredClone(f.expected);
    await assert.rejects(f.read(), /entry_rest_metadata_changed/);
    assert.deepEqual(f.expected, before);
    assert.equal(f.calls.length, 0);
});

test('concurrent changes to original metadata reject the recovered pair', async () => {
    for (const mutate of [value => { value.fee.rate = .08; },
        value => { delete value.negRisk; }, value => { value.accepting = false; }]) {
        const f = fixture({ mutateBook: () => mutate(f.expected) });
        await assert.rejects(f.read(), /entry_rest_metadata_changed/);
        assert.equal(f.expected.tickVerifiedAt, undefined);
    }
});

test('execution revalidation rejects changed identity, tampered evidence and expiration', async () => {
    const f = fixture(), pair = await f.read();
    const changed = structuredClone(f.expected); changed.fee.rate = .08;
    assert.throws(() => validatedEntryFilterRestBooks(changed, pair, AT), /early_book_evidence_invalid/);
    const tampered = structuredClone(pair); tampered.books[0].asks[0].size = 1000;
    assert.throws(() => validatedEntryFilterRestBooks(f.expected, tampered, AT), /early_book_evidence_invalid/);
    const relabeled = structuredClone(pair); relabeled.validation.identity = 'other';
    assert.throws(() => validatedEntryFilterRestBooks(f.expected, relabeled, AT), /entry_rest_metadata_changed/);
    assert.throws(() => validatedEntryFilterRestBooks(f.expected, pair, AT + 5001), /verification_expired/);
    assert.throws(() => validatedEntryFilterRestBooks(f.expected, pair, AT - 1), /verification_expired/);
});

for (const [label, headers] of [
    ['positive cache age', { Age: '1' }],
    ['cached response', { 'CF-Cache-Status': 'HIT' }],
    ['stale HTTP date', { Date: new Date(AT - 6000).toUTCString() }],
    ['future HTTP date', { Date: new Date(AT + 2000).toUTCString() }],
]) test(`REST recovery rejects ${label}`, async () => {
    await assert.rejects(fixture({ headers }).read(), /early_book_response_cached_or_stale/);
});

test('deadline and total read budget cannot be extended by caller or completed late responses', async () => {
    const expired = fixture();
    await assert.rejects(expired.read({ deadlineAt: AT }), /entry_rest_deadline/);
    assert.equal(expired.metadataCalls.length, 0);
    const capped = fixture();
    await capped.read({ deadlineAt: AT + 10000 });
    assert.equal(capped.metadataCalls[0].options.deadline, AT + 3000);
    await assert.rejects(fixture({ advance: 2001 }).read(), /early_book_(response_unverified|deadline)/);
    const delayedMetadata = fixture({ refresh: () => delayedMetadata.setNow(AT + 2001) });
    await assert.rejects(delayedMetadata.read(), /entry_rest_deadline/);
    assert.equal(delayedMetadata.calls.length, 0);
});

test('metadata timeout cannot mutate the market or launch late REST requests', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ refresh: async value => {
        await waiting; value.ticks = [.001, .001]; value.tick = .001;
    } }), before = structuredClone(f.expected);
    await assert.rejects(f.read({ deadlineAt: AT + 15 }), /entry_rest_timeout/);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.expected, before);
    assert.equal(f.calls.length, 0);
});

test('late REST reader cannot publish a result or mutate the original market after timeout', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = fixture({ readBooks: async (value, options) => {
        const pair = await readEarlyPaperBooks(value, options);
        await waiting; value.tick = .001; value.ticks = [.001, .001];
        return pair;
    } }), before = structuredClone(f.expected);
    await assert.rejects(f.read({ deadlineAt: AT + 15 }), /entry_rest_timeout/);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.expected, before);
});

test('metadata evidence retains its original age when REST verification finishes later', async () => {
    const f = fixture({ advance: 500 }), pair = await f.read();
    assert.equal(pair.validation.at, AT);
    assert.equal(pair.evidence.metadataVerifiedAt, AT);
    assert.equal(pair.evidence.verifiedAt, AT + 500);
    assert.equal(pair.books[0].timestamp, AT - 100);
});
