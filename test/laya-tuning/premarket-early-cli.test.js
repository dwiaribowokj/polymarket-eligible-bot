import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, smoke, premarketPreflight, recordPremarketReadFailure } from '../../scripts/premarket-paper.js';
import { EARLY_PROFILE } from '../../src/premarket-paper/early-context.js';
import { EARLY_BOOK_POLICY, readEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';

function fixture() {
    let now = Date.parse('2026-10-28T12:01:00Z');
    const open = Math.floor(now / 300000) * 300000 + 600000, calls = [];
    const market = { slug: `btc-updown-5m-${open / 1000}`, open, end: open + 300000, conditionId: 'condition',
        tokens: ['up', 'down'], minimum: 5, tick: .01, ticks: [.01, .01], negRisk: false, accepting: true,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const config = { profile: EARLY_PROFILE, leadSeconds: 540, shares: 5, dataAgeMs: 5000, bookPolicy: EARLY_BOOK_POLICY,
        candleCache: '/tmp/test-candles', candleCacheMaxAgeMs: 90000, candleCount: 30, candleIntervalMs: 300000,
        control: { maxClockSkewMs: 2000, maxDataAgeMs: 5000 } };
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', bars: Array(30).fill({}),
        observedAt: now, windowEnd: now - 60000 };
    const client = {
        btc: { unused: true }, clock: { at: now, skewMs: 0, durationMs: 100 },
        async serverTime() { calls.push('clock'); return now; },
        async market(slug, options) { calls.push({ slug, options }); return structuredClone(market); },
        startBtcFeed() { throw new Error('authenticated_feed_forbidden'); },
        books() { throw new Error('legacy_stale_book_gate_forbidden'); },
    };
    const fetchImpl = async input => {
        const url = new URL(input), token = url.searchParams.get('token_id'); calls.push(url.pathname);
        const body = url.pathname === '/tick-size' ? { minimum_tick_size: .01 }
            : { market: 'condition', asset_id: token, min_order_size: '5', tick_size: '.01', neg_risk: false,
                timestamp: String(now - 120000), hash: 'a'.repeat(40), bids: [{ price: '.49', size: '5' }], asks: [{ price: '.5', size: '5' }] };
        return new Response(JSON.stringify(body), { headers: { Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC' } });
    };
    const readBooks = (value, options) => readEarlyPaperBooks(value, { ...options, fetchImpl });
    const makeBooks = () => { throw new Error('websocket_not_required'); };
    return { config, client, market, calls, history, readBooks, makeBooks, clock: () => now,
        candleReader: () => history, advance(ms) { now += ms; } };
}

test('early smoke verifies uncached REST with quiet source timestamps and never constructs a websocket', async () => {
    const f = fixture();
    const result = await smoke(f.config, f.client, f.makeBooks, f.clock, undefined, f.candleReader, f.readBooks);
    assert.equal(result.restBooksReady, true); assert.equal(result.websocketRequired, false);
    assert.equal(result.websocketReady, undefined); assert.equal(result.market, f.market.slug);
    assert.deepEqual(result.bestAsk, [.5, .5]); assert.equal(result.candleCount, 30);
    assert.equal(result.bookEvidence.books[0].sourceAgeMs, 120000);
    assert.equal(result.bookEvidence.authority, 'fresh_rest_full_snapshot');
    assert.equal(result.inferenceSubmitted, false); assert.equal(result.transactionsSubmitted, false);
    assert.equal(f.calls.filter(call => call === '/book').length, 2);
    assert.equal(f.calls.filter(call => call === '/tick-size').length, 2);
    assert.equal(f.calls[0].options.retries, 0);
});

test('early smoke rejects unavailable candles and tampered REST evidence without legacy fallback', async t => {
    for (const fault of ['candles', 'tamper', 'market']) await t.test(fault, async () => {
        const f = fixture();
        if (fault === 'candles') f.history.ready = false;
        if (fault === 'market') f.market.open += 1;
        const readBooks = async (...args) => {
            const result = await f.readBooks(...args);
            if (fault === 'tamper') result.books[0].asks[0].size = 999;
            return result;
        };
        await assert.rejects(smoke(f.config, f.client, f.makeBooks, f.clock, undefined, f.candleReader, readBooks),
            fault === 'candles' ? /premarket_smoke_btc_unavailable/ : fault === 'tamper' ? /early_book_evidence_invalid/ : /future_market_invalid/);
    });
});

test('early preflight retains generic public checks and adds the future REST market check', async () => {
    const f = fixture(); let genericCalls = 0;
    const result = await premarketPreflight(f.config, f.client, { clock: f.clock, candleReader: f.candleReader, readBooks: f.readBooks,
        publicPreflight: async (client, settings, options) => {
            genericCalls++; assert.equal(settings, f.config.control); assert.equal(client.btc, null);
            assert.deepEqual(options, { publicOnly: true, strategies: [] }); client.startBtcFeed();
            assert.equal(await client.serverTime(), f.clock());
            return { time: { skewMs: 0, roundTripMs: 0 }, publicReady: true, liveReady: false,
                checks: [{ name: 'server_time', scope: 'public', ok: true }, { name: 'geoblock', scope: 'live', ok: true }] };
        } });
    assert.equal(genericCalls, 1); assert.equal(result.publicReady, true); assert.equal(result.liveReady, false);
    assert.equal(result.time.roundTripMs, 100); assert.equal(result.time.sampledAt, f.clock());
    assert.deepEqual(result.checks.map(check => check.name), ['server_time', 'geoblock', 'external_candle_history', 'early_future_market']);
    assert.equal(f.calls.filter(call => call === 'clock').length, 1);
});

test('early preflight reports failed current-depth verification as public unready', async () => {
    const f = fixture();
    const result = await premarketPreflight(f.config, f.client, { clock: f.clock, candleReader: f.candleReader,
        readBooks: async () => { throw new Error('early_book_evidence_invalid'); },
        publicPreflight: async () => ({ publicReady: true, checks: [] }) });
    assert.equal(result.publicReady, false);
    assert.equal(result.checks.find(check => check.name === 'early_future_market').ok, false);
});

test('older profile preflight delegates its original client and strategy policy unchanged', async () => {
    const f = fixture(); f.config.profile = 'fair-near-open-30m-v1';
    const expected = { publicReady: true, checks: [] };
    const result = await premarketPreflight(f.config, f.client, { publicPreflight: async (client, settings, options) => {
        assert.equal(client, f.client); assert.equal(settings, f.config.control); assert.deepEqual(options, { publicOnly: true });
        return expected;
    } });
    assert.equal(result, expected); assert.deepEqual(f.calls, []);
});

test('read diagnostics retain endpoint, stage, timing and retries while removing arbitrary content', () => {
    const calls = [], store = { error: (...args) => calls.push(['error', ...args]), event: (...args) => calls.push(['event', ...args]) };
    recordPremarketReadFailure(store, { code: 'read_timeout', category: 'timeout', endpoint: 'clob', stage: 'server_time',
        durationMs: 539, attempts: 1, httpStatus: 503, retryAfter: 2, message: 'PRIVATE_PAYLOAD', url: 'PRIVATE_URL' });
    assert.equal(calls[0][1], 'server_time'); assert.equal(calls[0][2].code, 'read_timeout');
    assert.deepEqual(calls[1], ['event', 'read_failed', { error: { name: 'OperationalError', code: 'read_timeout', category: 'timeout',
        stage: 'server_time', endpoint: 'clob', httpStatus: 503, durationMs: 539, attempts: 1, retryAfter: 2 } }]);
    assert.equal(JSON.stringify(calls).includes('PRIVATE'), false);
});

test('CLI restores early process routing after lock acquisition fails before a client is created', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'early-cli-routing-')), out = path.join(directory, 'not-directory');
    fs.writeFileSync(out, '');
    const original = { profile: process.env.PREMARKET_PROFILE, arms: process.env.PREMARKET_ACTIVE_ARMS,
        family: net.getDefaultAutoSelectFamily(), dns: dns.getDefaultResultOrder() };
    t.after(() => {
        for (const [key, value] of [['PREMARKET_PROFILE', original.profile], ['PREMARKET_ACTIVE_ARMS', original.arms]])
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        net.setDefaultAutoSelectFamily(original.family); dns.setDefaultResultOrder(original.dns);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    process.env.PREMARKET_PROFILE = EARLY_PROFILE; delete process.env.PREMARKET_ACTIVE_ARMS;
    net.setDefaultAutoSelectFamily(true); dns.setDefaultResultOrder('verbatim');
    await assert.rejects(main(['run', `--out=${out}`]));
    assert.equal(net.getDefaultAutoSelectFamily(), true); assert.equal(dns.getDefaultResultOrder(), 'verbatim');
});
