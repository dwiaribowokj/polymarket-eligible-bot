import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, smoke } from '../../scripts/entry-filter-paper.js';
import { readEntryFilterRestBooks } from '../../src/entry-filter-paper/book-source.js';

test('entry filter paper CLI separates run, public smoke and historical reports', () => {
    assert.deepEqual(parseArgs(['run', '--out=/tmp/example-paper']), {
        command: 'run', out: '/tmp/example-paper', smoke: false, history: false });
    assert.equal(parseArgs(['preflight', '--out=/tmp/example-paper', '--smoke']).smoke, true);
    assert.equal(parseArgs(['report', '--out=/tmp/example-paper', '--history']).history, true);
});

test('entry filter paper CLI refuses live, reset and ambiguous output requests', () => {
    for (const args of [[], ['live'], ['run', '--out=relative'], ['run', '--out=/tmp/a', '--live'],
        ['run', '--out=/tmp/a', '--reset'], ['run', '--out=/tmp/a', '--history'],
        ['report', '--out=/tmp/a', '--smoke'], ['run', '--out=/tmp/a', '--out=/tmp/b'],
        ['preflight', '--out=/tmp/a', '--smoke', '--smoke']])
        assert.throws(() => parseArgs(args));
});

test('live tuning requires an explicit known profile and report uses stored manifest', () => {
    for (const command of ['run', 'preflight'])
        assert.equal(parseArgs([command, '--out=/tmp/tuning', '--profile=live-tuning-v1']).profile, 'live-tuning-v1');
    for (const args of [['run', '--profile=other'], ['report', '--profile=live-tuning-v1'],
        ['run', '--profile=live-tuning-v1', '--profile=live-tuning-v1']])
        assert.throws(() => parseArgs([...args, '--out=/tmp/tuning']));
});

function smokeFixture({ websocket = false, warm = false, btc = true, sourceAgeMs = 100,
    headers = {}, mutateBook, mutateStream, refresh } = {}) {
    const startedAt = Date.parse('2026-10-31T12:00:00Z');
    let now = startedAt, closed = false;
    const calls = [], sleeps = [], market = { slug: `btc-updown-5m-${startedAt / 1000}`,
        conditionId: 'condition', tokens: ['up', 'down'], minimum: 5, ticks: [.01, .01], tick: .01,
        negRisk: false, accepting: true, fee: { rate: .07, exponent: 1, takerOnly: true },
        open: startedAt, end: startedAt + 300000 };
    const rawBook = token => ({ market: 'condition', asset_id: token, min_order_size: '5',
        tick_size: '.01', neg_risk: false, timestamp: String(now - sourceAgeMs), hash: 'a'.repeat(40),
        bids: [{ price: '.49', size: '10' }], asks: [{ price: '.50', size: '10' }] });
    const stream = { generation: 7, tokens: market.tokens,
        watch(tokens, value) { calls.push('watch'); assert.deepEqual(tokens, market.tokens); assert.equal(value, market); },
        snapshot(at, requireWarm = true) {
            if (!websocket || requireWarm && !warm) return null;
            return market.tokens.map(tokenId => {
                const book = { tokenId, conditionId: market.conditionId, tick: .01,
                    timestamp: at - 100, fetchedAt: at, bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: 10 }] };
                mutateStream?.(book); return book;
            });
        },
        close() { calls.push('close'); closed = true; } };
    const client = {
        startBtcFeed() { calls.push('startBtcFeed'); },
        btcStatus() { return { ready: btc }; },
        async market(slug, options) {
            calls.push('market'); assert.equal(slug, market.slug);
            assert.deepEqual(options, { deadline: startedAt + 15000, retries: 0 });
            return market;
        },
        async books(value, options) {
            calls.push('metadata'); assert.notEqual(value, market);
            assert.equal(options.retries, 0); assert.ok(options.deadline <= startedAt + 15000);
            refresh?.(value); return [];
        },
    };
    const fetchImpl = async input => {
        const url = new URL(input), token = url.searchParams.get('token_id');
        calls.push(url.pathname);
        const value = url.pathname === '/book' ? rawBook(token) : { minimum_tick_size: .01 };
        if (url.pathname === '/book') mutateBook?.(value);
        return new Response(JSON.stringify(value), { headers: {
            Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC', ...headers } });
    };
    const options = { clock: () => now, fetchImpl,
        sleep: async ms => { sleeps.push(ms); now += ms; } };
    return { market, client, stream, options, calls, sleeps, startedAt,
        get closed() { return closed; }, get now() { return now; },
        advance(ms) { now += ms; },
        run(overrides = {}) { return smoke({ dataAgeMs: 5000 }, client, () => stream, { ...options, ...overrides }); } };
}

test('public smoke verifies independent REST evidence without websocket warmup', async () => {
    const f = smokeFixture(), result = await f.run();
    assert.equal(result.restReady, true);
    assert.equal(result.bookSource, 'rest');
    assert.equal(result.websocketReady, false);
    assert.equal(result.websocketError, 'execution_book_unavailable');
    assert.equal(result.warmupComplete, false);
    assert.equal(result.btcReady, true);
    assert.equal(result.inferenceSubmitted, false);
    assert.equal(result.transactionsSubmitted, false);
    assert.equal(result.restEvidence.paperOnly, true);
    assert.equal(result.restEvidence.authority, 'fresh_rest_full_snapshot');
    assert.equal(result.restEvidence.books[0].sourceTimestampMs, f.startedAt - 100);
    assert.equal(result.restEvidence.books[0].tickVerification.endpoint, 'https://clob.polymarket.com/tick-size');
    assert.equal(f.calls.filter(call => call === '/book').length, 2);
    assert.equal(f.calls.filter(call => call === '/tick-size').length, 2);
    assert.equal(f.sleeps.length, 0);
    assert.equal(f.closed, true);
    assert.deepEqual(f.calls.slice(0, 4), ['startBtcFeed', 'market', 'watch', 'metadata']);
});

test('live tuning smoke reports required websocket separately from REST and trading warmup', async () => {
    for (const websocket of [false, true]) {
        const f = smokeFixture({ websocket, warm: false });
        const result = await smoke({ dataAgeMs: 5000, profile: 'live-tuning-v1',
            executionBook: 'validated-websocket' }, f.client, () => f.stream, f.options);
        assert.equal(result.restReady, true);
        assert.equal(result.executionBookPolicy, 'validated-websocket');
        assert.equal(result.executionSourceReady, websocket);
        assert.equal(result.warmupComplete, false);
        assert.equal(result.warmupRequiredBeforeEntry, true);
        assert.equal(result.transactionsSubmitted, false);
    }
});

test('public smoke reports websocket readiness and warmup separately', async () => {
    const cold = await smokeFixture({ websocket: true }).run();
    assert.equal(cold.websocketReady, true); assert.equal(cold.websocketError, null);
    assert.equal(cold.warmupComplete, false); assert.equal(cold.restReady, true);
    const warm = await smokeFixture({ websocket: true, warm: true }).run();
    assert.equal(warm.websocketReady, true); assert.equal(warm.warmupComplete, true);
});

test('public smoke independently verifies a compatible coarser websocket tick', async () => {
    const f = smokeFixture({ websocket: true, mutateStream: book => { book.tick = .1; } });
    const result = await f.run();
    assert.equal(result.websocketReady, true);
    assert.equal(result.restEvidence.books[0].tick, .01);
});

test('a websocket identity failure is reported truthfully while fresh REST remains verified', async () => {
    const f = smokeFixture({ websocket: true, warm: true,
        mutateStream: book => { book.tokenId = 'other'; } }), result = await f.run();
    assert.equal(result.restReady, true);
    assert.equal(result.websocketReady, false);
    assert.equal(result.websocketError, 'execution_token_mismatch');
    assert.equal(result.warmupComplete, false);
});

test('public smoke reports unavailable BTC and reserves REST verification time within fifteen seconds', async () => {
    const f = smokeFixture({ btc: false }), result = await f.run();
    assert.equal(result.restReady, true);
    assert.equal(result.btcReady, false);
    assert.equal(result.websocketReady, false);
    assert.equal(f.now - f.startedAt, 12000);
    assert.equal(result.restEvidence.verifiedAt, f.now);
    assert.equal(result.restEvidence.books[0].sourceTimestampMs, f.now - 100);
    assert.equal(f.closed, true);
});

test('public smoke rejects stale, future, cached and mismatched REST even with a warm websocket', async () => {
    for (const [options, error] of [
        [{ sourceAgeMs: 5001 }, /execution_book_stale_or_future/],
        [{ sourceAgeMs: -1 }, /early_book_source_timestamp_invalid/],
        [{ headers: { 'CF-Cache-Status': 'HIT' } }, /early_book_response_cached_or_stale/],
        [{ mutateBook: book => { book.asset_id = 'other'; } }, /early_book_identity_or_constraints_changed/],
        [{ refresh: market => { market.fee.rate = .08; } }, /entry_rest_metadata_changed/],
    ]) {
        const f = smokeFixture({ websocket: true, warm: true, ...options });
        await assert.rejects(f.run(), error);
        assert.equal(f.closed, true);
    }
});

test('public smoke revalidates returned REST evidence and rejects post-deadline results', async () => {
    const tampered = smokeFixture();
    await assert.rejects(tampered.run({ readRestBooks: async (...args) => {
        const pair = await readEntryFilterRestBooks(...args);
        pair.books[0].asks[0].size = 1000;
        return pair;
    } }), /early_book_evidence_invalid/);
    assert.equal(tampered.closed, true);
    const late = smokeFixture();
    await assert.rejects(late.run({ readRestBooks: async (...args) => {
        const pair = await readEntryFilterRestBooks(...args);
        late.advance(15001); return pair;
    } }), /entry_filter_smoke_timeout/);
    assert.equal(late.closed, true);
});
