import test from 'node:test';
import assert from 'node:assert/strict';
import { readValueBooks } from '../../src/value-collector/book-source.js';
import { safeCode, ValueCollectorEngine } from '../../src/value-collector/engine.js';

const OPEN = Date.parse('2026-11-01T12:00:00Z');

function fixture({ ticks = [.01, .01], sourceAgeMs = 60000 } = {}) {
    let now = OPEN + 210000;
    const market = { slug: `btc-updown-5m-${OPEN / 1000}`, open: OPEN, end: OPEN + 300000,
        conditionId: `0x${'1'.repeat(64)}`, tokens: ['up', 'down'], outcomes: ['Up', 'Down'],
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const calls = [], metadata = structuredClone(market);
    const client = {
        async market(slug, options) {
            calls.push({ kind: 'market', slug, options }); return structuredClone(metadata);
        },
        async tickSize(tokenId) { calls.push({ kind: 'tick', tokenId }); return ticks[market.tokens.indexOf(tokenId)]; },
    };
    const fetchImpl = async (input, options) => {
        const url = new URL(input), token = url.searchParams.get('token_id'), index = market.tokens.indexOf(token);
        calls.push({ kind: 'fetch', path: url.pathname, token, options, cacheBust: url.searchParams.has('_paper_verify') });
        const tick = ticks[index];
        const body = url.pathname === '/tick-size' ? { minimum_tick_size: String(tick) }
            : { market: market.conditionId, asset_id: token, min_order_size: '5', neg_risk: false,
                tick_size: String(tick), timestamp: String(now - sourceAgeMs), hash: 'a'.repeat(40),
                bids: [{ price: '.48', size: '20' }], asks: [{ price: tick === .001 ? '.521' : '.52', size: '30' }] };
        return new Response(JSON.stringify(body), { headers: { Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC' } });
    };
    return { market, metadata, client, calls, fetchImpl, get now() { return now; }, advance(ms) { now += ms; },
        run(options = {}) { return readValueBooks(market, { client, clock: () => now,
            deadlineAt: now + 3000, fetchImpl, ...options }); } };
}

test('value books retain an unchanged exchange timestamp with current uncached REST evidence', async () => {
    const f = fixture(), pair = await f.run();
    assert.equal(pair.source, 'rest');
    assert.equal(pair.books.length, 2);
    for (const [index, book] of pair.books.entries()) {
        assert.equal(book.timestamp, f.now - 60000);
        assert.equal(book.fetchedAt, f.now);
        assert.equal(pair.evidence.books[index].sourceAgeMs, 60000);
        assert.equal(pair.evidence.books[index].tickVerification.receivedAt, f.now);
    }
    const requests = f.calls.filter(call => call.kind === 'fetch');
    assert.equal(requests.length, 4);
    assert.ok(requests.every(call => call.options.cache === 'no-store' && call.cacheBust));
    assert.deepEqual(f.calls[0].options, { deadline: f.now + 3000, retries: 0 });
});

test('value books independently refresh token ticks before validating full depth', async () => {
    const f = fixture({ ticks: [.001, .01] });
    const pair = await f.run();
    assert.deepEqual(f.market.ticks, [.001, .01]);
    assert.deepEqual(pair.books.map(book => book.tick), [.001, .01]);
    assert.deepEqual(pair.books.map(book => book.asks[0].price), [.521, .52]);
    assert.deepEqual(f.calls.filter(call => call.kind === 'tick').map(call => call.tokenId).sort(), ['down', 'up']);
});

test('value books reject disagreement between metadata refresh and independent tick verification', async () => {
    const f = fixture();
    f.client.tickSize = async () => .001;
    await assert.rejects(f.run(), /early_book_tick_mismatch/);
    assert.deepEqual(f.market.ticks, [.01, .01]);
});

test('value books reject changed market identity, constraints, and closed markets before reading depth', async () => {
    for (const mutate of [market => { market.slug += '-wrong'; }, market => { market.open++; },
        market => { market.end++; }, market => { market.conditionId = `0x${'2'.repeat(64)}`; },
        market => { market.tokens.reverse(); }, market => { market.outcomes.reverse(); },
        market => { market.minimum++; }, market => { market.fee.rate = .1; },
        market => { market.negRisk = true; }, market => { market.accepting = false; }]) {
        const f = fixture(), original = structuredClone(f.market);
        mutate(f.metadata);
        await assert.rejects(f.run(), /collector_book_metadata_changed/);
        assert.deepEqual(f.market, original);
        assert.equal(f.calls.filter(call => call.kind === 'fetch').length, 0);
    }
});

test('value books reject changes to the requested market during metadata refresh', async () => {
    const f = fixture();
    f.client.market = async () => { f.market.tokens = ['different-up', 'different-down']; return structuredClone(f.metadata); };
    await assert.rejects(f.run(), /collector_book_metadata_changed/);
    assert.equal(f.calls.filter(call => call.kind === 'fetch').length, 0);
});

test('value books reject deadline overruns without applying refreshed tick metadata', async () => {
    const f = fixture(), original = structuredClone(f.market);
    await assert.rejects(f.run({ readBooks: async refreshed => {
        refreshed.tick = .001; refreshed.ticks = [.001, .001]; f.advance(3001); return { books: [] };
    } }), /collector_book_timeout/);
    assert.deepEqual(f.market, original);
});

test('late metadata completion after a timed out value book read cannot mutate the original', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), original = structuredClone(f.market);
    let complete, reads = 0;
    f.client.market = () => new Promise(resolve => { complete = resolve; });
    const pending = f.run({ readBooks: async () => { reads++; return { books: [] }; } });
    const rejected = assert.rejects(pending, /collector_book_timeout/);
    t.mock.timers.tick(3001); await rejected;
    const late = structuredClone(f.metadata); late.ticks = [.001, .001]; late.tick = .001;
    complete(late); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.market, original);
    assert.equal(reads, 0);
});

test('late depth completion after a timed out value book read cannot mutate the original', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(), original = structuredClone(f.market);
    let complete;
    const pending = f.run({ readBooks: refreshed => new Promise(resolve => {
        complete = () => { refreshed.ticks = [.001, .001]; refreshed.tick = .001; resolve({ books: [] }); };
    }) });
    const rejected = assert.rejects(pending, /collector_book_timeout/);
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(3001); await rejected;
    complete(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.market, original);
});

test('value book failures persist only a safe reason code instead of arbitrary transport errors', async () => {
    const f = fixture(), records = [];
    const detail = 'network failed at https://rpc.invalid/private-access-key?token=confidential';
    f.client.btc = { openings: new Map() };
    const engine = new ValueCollectorEngine({ slotToleranceMs: 2000, captureBudgetMs: 3000,
        dataAgeMs: 5000, clockMaxAgeMs: 30000 }, {
        state: {}, event() {}, recordObservation(row) { records.push(row); },
    }, f.client, { clock: () => f.now, readBooks: async () => { throw new Error(detail); },
        buildObservation: () => ({ quality: { status: 'partial' }, sides: [] }) });
    engine.current = f.market;
    await engine.capture({ slug: f.market.slug, marketEnd: f.market.end, scheduledAt: f.now, seconds: 90 });
    assert.equal(records[0].bookError, 'read_failed');
    assert.ok(!JSON.stringify(records).includes('confidential'));
    assert.equal(safeCode(new Error(detail)), 'read_failed');
    assert.equal(safeCode(new Error('collector_book_timeout')), 'collector_book_timeout');
});
