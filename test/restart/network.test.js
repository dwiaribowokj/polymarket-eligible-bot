import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { OperationalError, ReadCoordinator, safeError, fetchResponse, TRANSPORT } from '../../src/restart/network.js';
import { safeError as safeLiveError } from '../../src/laya-live/network.js';
import { RpcPool } from '../../src/restart/rpc.js';
import { TradingClient } from '../../src/restart/client.js';
import { BASELINE, loadSettings } from '../../src/restart/config.js';
import { Store, paperExposure, trialManifest } from '../../src/restart/store.js';
import { parseArgs } from '../../src/restart.js';
import { report, saveReport } from '../../src/restart/report.js';
import { preflight } from '../../src/restart/preflight.js';
import { Engine } from '../../src/restart/engine.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-network-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, lateSignal: null, paperDrawdownStop: 2, fingerprint: 'new', dataDir, paperGasUsd: 0.05, strategies: ['late-entry'] };
    const store = new Store(settings, 'paper', 'late-entry'); store.logger = () => {};
    return { settings, store };
}
function clockCoordinator(policy = {}) {
    let now = 100000;
    const pauses = [], events = [];
    const reads = new ReadCoordinator({ now: () => now, random: () => 0,
        sleep: async ms => { pauses.push(ms); now += ms; }, onEvent: e => events.push(e), policy });
    return { reads, pauses, events, advance: ms => { now += ms; } };
}
const serverError = () => Object.assign(new Error('private RPC URL and signed request'), { status: 529 });

test('transient reads retry once, and 4xx validation failures do not retry', async () => {
    const { reads, pauses, events } = clockCoordinator(); let calls = 0;
    assert.equal(await reads.run('one', 'clob', 'book_read', async () => {
        if (++calls === 1) throw serverError(); return 42;
    }), 42);
    assert.equal(calls, 2); assert.deepEqual(pauses, [500]);
    assert.equal(events[0].error.httpStatus, 529); assert.equal(events[0].error.category, 'transport');
    calls = 0;
    await assert.rejects(reads.run('bad', 'clob', 'book_read', async () => {
        calls++; throw { status: 400 };
    }), e => e.category === 'api_rejection' && e.attempts === 1);
    assert.equal(calls, 1);
});
test('429 honors Retry-After and a deadline prevents another attempt', async () => {
    const { reads, pauses } = clockCoordinator(); let calls = 0;
    assert.equal(await reads.run('quota', 'clob', 'book_read', async () => {
        if (++calls === 1) throw { status: 429, retryAfter: 2 }; return 1;
    }), 1);
    assert.deepEqual(pauses, [2000]);
    calls = 0;
    await assert.rejects(reads.run('late', 'clob', 'book_read', async () => {
        calls++; throw { status: 429, retryAfter: 10 };
    }, { deadline: 105000 }), e => e.code === 'entry_window_elapsed');
    assert.equal(calls, 1);
});
test('Retry-After HTTP dates are parsed without recording response bodies', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('secret', {
        status: 429, headers: { 'retry-after': new Date(Date.now() + 6000).toUTCString() },
    }));
    await assert.rejects(fetchResponse('https://example.com'), e => e.retryAfter >= 4 && e.retryAfter <= 6);
});
test('long Retry-After defers requests without blocking deadline processing', async () => {
    const { reads, pauses, advance } = clockCoordinator(); let calls = 0;
    await assert.rejects(reads.run('quota', 'clob', 'book_read', async () => { calls++; throw { status: 429, retryAfter: 120 }; }));
    assert.equal(pauses.length, 0);
    await assert.rejects(reads.run('other', 'clob', 'metadata_read', async () => ++calls), e => e.code === 'rate_limit_wait');
    assert.equal(calls, 1); advance(120000);
    assert.equal(await reads.run('probe', 'clob', 'book_read', async () => ++calls), 2);
});
test('three transport failures open circuit and allow exactly one recovery probe', async () => {
    const { reads, advance, events } = clockCoordinator({ retries: 0 }); let calls = 0;
    for (let i = 0; i < 3; i++) await assert.rejects(reads.run(String(i), 'clob', 'book_read', async () => {
        calls++; throw serverError();
    }));
    await assert.rejects(reads.run('blocked', 'clob', 'book_read', async () => ++calls), e => e.code === 'circuit_open');
    assert.equal(calls, 3); advance(30000);
    let finish;
    const probe = reads.run('probe', 'clob', 'book_read', () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    await assert.rejects(reads.run('second-probe', 'clob', 'book_read', async () => 0), e => e.code === 'circuit_open');
    finish(9); assert.equal(await probe, 9);
    assert.equal(await reads.run('restored', 'clob', 'book_read', async () => 10), 10);
    assert.equal(events.filter(e => e.type === 'circuit_opened').length, 1);
    assert.equal(events.find(e => e.type === 'endpoint_recovered').outageMs, 30000);
});
test('timeout aborts a read and late responses never replace its result', async () => {
    const reads = new ReadCoordinator({ policy: { timeoutMs: 10, retries: 0 } }); let aborted = false;
    await assert.rejects(reads.run('hung', 'clob', 'book_read', async signal => {
        signal.addEventListener('abort', () => { aborted = true; }); await sleep(30); return 'late';
    }), e => e.code === 'read_timeout' && e.attempts === 1);
    assert.equal(aborted, true);
    await sleep(35);
    assert.equal(await reads.run('hung', 'clob', 'book_read', async () => 'fresh'), 'fresh');
});
test('identical inflight reads share one request', async () => {
    const reads = new ReadCoordinator(); let calls = 0;
    const task = async () => { calls++; await sleep(10); return 12; };
    assert.deepEqual(await Promise.all([reads.run('same', 'clob', 'book_read', task), reads.run('same', 'clob', 'book_read', task)]), [12, 12]);
    assert.equal(calls, 1);
});
test('safe telemetry distinguishes nested RPC transport errors without secrets', () => {
    const error = { code: 'CALL_EXCEPTION', error: { status: 529, message: 'https://private-rpc?token=secret' } };
    const result = safeError(error, { stage: 'wallet_balance', durationMs: 123, attempts: 2 });
    assert.equal(result.category, 'transport'); assert.equal(result.httpStatus, 529);
    assert.equal(result.attempts, 2); assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(safeError(new Error('Stale orderbook')).category, 'stale_data');
});

test('RPC diagnostics retain signed error codes and bounded labels without raw response content', () => {
    const error = new OperationalError('rpc_read_rejected', 'transport', {
        rpcCode: -32603, rpcReason: 'internal_error', rpcMethod: 'eth_call',
        message: 'https://private-rpc?token=SECRET', data: { secret: 'SECRET' },
    });
    assert.deepEqual(safeLiveError(error), { name: 'OperationalError', code: 'rpc_read_rejected', category: 'transport',
        rpcCode: -32603, rpcReason: 'internal_error', rpcMethod: 'eth_call' });
    for (const value of ['SECRET', 'https://private-rpc?token=SECRET', Infinity, NaN, 1.5]) {
        Object.assign(error, { rpcCode: value, rpcReason: value, rpcMethod: value });
        assert.deepEqual(safeLiveError(error), { name: 'OperationalError', code: 'rpc_read_rejected', category: 'transport' });
    }
});

function bookFixture() {
    const client = Object.create(TradingClient.prototype); client.settings = BASELINE;
    const market = { conditionId: 'condition', tokens: ['1', '2'], outcomes: ['Up', 'Down'], tick: 0.01,
        minimum: 5, fee: { rate: 0.07, exponent: 1, takerOnly: true } };
    let tick = 0.001, calls = 0;
    const raw = id => ({ assetId: id, conditionId: 'condition', negRisk: false, tickSize: tick, minOrderSize: '5',
        timestamp: Date.now(), asks: [{ price: '0.801', size: '10' }], bids: [{ price: '0.8', size: '10' }] });
    client.public = { fetchOrderBook: async ({ assetId }) => { calls++; return raw(assetId); } };
    client.tickSize = async () => tick;
    client.marketInfo = async () => ({ tickSize: 0.01, negRisk: false, feeInfo: { rate: 0.07, exponent: 1 },
        tokens: [{ assetId: '1', outcome: 'Up' }, { assetId: '2', outcome: 'Down' }] });
    return { client, market, raw, setTick: value => { tick = value; }, calls: () => calls };
}
test('tick changes refresh CLOB and both books despite lagging market metadata', async () => {
    const { client, market, calls } = bookFixture();
    const books = await client.books(market);
    assert.equal(market.tick, 0.001); assert.equal(books[0].asks[0].price, 0.801); assert.equal(calls(), 4);
});
test('identity, minimum, fee and inconsistent tick snapshots fail closed', async () => {
    for (const fault of ['asset', 'minimum', 'fee', 'tick']) {
        const { client, market, raw } = bookFixture();
        if (fault === 'asset') client.public.fetchOrderBook = async ({ assetId }) => ({ ...raw(assetId), assetId: 'unrelated' });
        if (fault === 'minimum') client.public.fetchOrderBook = async ({ assetId }) => ({ ...raw(assetId), minOrderSize: '6' });
        if (fault === 'fee') { const original = client.marketInfo; client.marketInfo = async () => ({ ...await original(), feeInfo: { rate: 0, exponent: 1 } }); }
        if (fault === 'tick') client.tickSize = async () => 0.01;
        await assert.rejects(client.books(market), e => e.category === 'validation');
        assert.equal(market.tick, 0.01);
    }
});
test('old book remains rejected after a valid tick refresh', async () => {
    const { client, market, raw } = bookFixture();
    client.public.fetchOrderBook = async ({ assetId }) => ({ ...raw(assetId), timestamp: Date.now() - 10000 });
    await assert.rejects(client.books(market), e => e.code === 'stale_book' && e.dataAgeMs >= 10000);
});
test('independently changing outcome ticks are accepted only after per-token verification', async () => {
    const { client, market, raw } = bookFixture();
    client.public.fetchOrderBook = async ({ assetId }) => ({ ...raw(assetId), tickSize: assetId === '1' ? 0.001 : 0.01 });
    client.tickSize = async assetId => assetId === '1' ? 0.001 : 0.01;
    await client.books(market); assert.deepEqual(market.ticks, [0.001, 0.01]);
    client.marketInfo = () => assert.fail('verified outcome ticks are cached');
    await client.books(market);
});
test('SDK GET adapter enforces bounded reads while POST remains untouched', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++; return new Response(calls === 1 ? 'busy' : '123', { status: calls === 1 ? 529 : 200 });
    });
    const client = new TradingClient({ ...BASELINE, rpcUrl: 'https://example.com' }); t.after(() => client.close());
    client.reads.sleep = async () => {};
    const post = client.public.clob.post;
    const [one, two] = await Promise.all([client.public.clob.get('/time'), client.public.clob.get('/time')]);
    assert.equal(await one.value.json(), 123); assert.equal(await two.value.json(), 123);
    assert.equal(calls, 2); assert.equal(client.public.clob.post, post);
});

function sdkTickFixture(t, metadataRead) {
    const conditionId = `0x${'1'.repeat(64)}`, tokens = ['1', '2'], calls = [];
    const client = new TradingClient({ ...BASELINE, rpcUrl: 'https://example.com' });
    t.after(() => client.close());
    const market = { conditionId, tokens, outcomes: ['Up', 'Down'], tick: 0.01,
        minimum: 5, fee: { rate: 0.07, exponent: 1, takerOnly: true } };
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        const url = new URL(input); calls.push(url.pathname);
        if (url.pathname.startsWith('/clob-markets/')) {
            if (metadataRead) return metadataRead(options);
            // The token endpoints can update before the market metadata.
            return Response.json({ fd: { r: 0.07, e: 1 }, mts: 0.01, nr: false,
                t: tokens.map((id, i) => ({ t: id, o: market.outcomes[i] })) });
        }
        if (url.pathname === '/tick-size') return Response.json({ minimum_tick_size: 0.001 });
        assert.equal(url.pathname, '/book');
        return Response.json({ market: conditionId, asset_id: url.searchParams.get('token_id'),
            timestamp: String(Date.now()), min_order_size: '5', tick_size: '0.001', neg_risk: false,
            hash: 'a'.repeat(40), asks: [{ price: '0.801', size: '10' }], bids: [{ price: '0.8', size: '10' }] });
    });
    return { client, market, calls };
}
test('tick refresh uses the pinned SDK actions rather than an absent decorated method', async t => {
    const { client, market, calls } = sdkTickFixture(t);
    assert.equal(client.public.fetchTickSize, undefined);
    const books = await client.books(market);
    assert.equal(market.tick, 0.001); assert.equal(books[0].asks[0].price, 0.801);
    assert.equal(calls.filter(p => p === '/tick-size').length, 2);
    assert.equal(calls.filter(p => p === '/book').length, 4);
});
test('deadline expiry during SDK tick refresh is caught without leaving an unhandled read', async t => {
    const { client, market } = sdkTickFixture(t, async () => {
        await sleep(80); throw Object.assign(new Error('temporary failure'), { status: 529 });
    });
    await assert.rejects(client.books(market, { deadline: Date.now() + 30 }),
        e => e.code === 'entry_window_elapsed' && e.stage === 'metadata_read');
    await sleep(100);
    assert.equal(client.reads.inflight.size, 0); assert.equal(market.tick, 0.01);
});
test('clock checks are shared for 30 seconds and cached time advances', async t => {
    let now = Date.now(), calls = 0; t.mock.method(Date, 'now', () => now);
    const client = Object.create(TradingClient.prototype); client.settings = BASELINE;
    client.json = async () => { calls++; return now / 1000; };
    assert.deepEqual(await Promise.all([client.serverTime(), client.serverTime()]), [now, now]);
    now += 5000; assert.equal(await client.serverTime(), now); assert.equal(calls, 1);
    now += 30000; await client.serverTime(); assert.equal(calls, 2);
});

function provider(name, chain = 137, hash = 'same') {
    return { name, send: async () => chain, getBlockNumber: async () => 200,
        getBlock: async number => ({ number, hash }) };
}
test('RPC failover validates chain and hash and redoes the complete snapshot read', async () => {
    const { reads } = clockCoordinator(); const a = provider('primary'), b = provider('backup');
    const pool = new RpcPool([], reads, [a, b]); assert.equal(await pool.snapshot(), 199);
    const attempts = [];
    const result = await pool.read('wallet_holdings', async (p, block) => {
        attempts.push([p.name, block]);
        if (p === a) throw serverError(); return { balance: 20, holdings: [0, 0], block };
    }, 199);
    assert.deepEqual(result, { balance: 20, holdings: [0, 0], block: 199 });
    assert.deepEqual(attempts, [['primary', 199], ['backup', 199]]); assert.equal(pool.active, 1);
});
test('RPC probes primary again after thirty seconds without repeated backup traffic postponing it', async () => {
    const { reads, advance } = clockCoordinator(); const a = provider('primary'), b = provider('backup');
    const pool = new RpcPool([], reads, [a, b]); await pool.snapshot(); let recovered = false;
    const task = async p => { if (p === a && !recovered) throw serverError(); return p.name; };
    assert.equal(await pool.read('wallet_balance', task), 'backup');
    advance(15000); assert.equal(await pool.read('wallet_balance', task), 'backup');
    recovered = true; advance(15000); assert.equal(await pool.read('wallet_balance', task), 'primary');
    assert.equal(pool.active, 0);
});
test('wrong-chain or different-block RPC never supplies holdings', async () => {
    for (const fault of ['chain', 'hash']) {
        const { reads } = clockCoordinator(); const a = provider('primary');
        const b = provider('backup', fault === 'chain' ? 1 : 137, fault === 'hash' ? 'different' : 'same');
        const pool = new RpcPool([], reads, [a, b]); await pool.snapshot(); let backups = 0;
        await assert.rejects(pool.read('wallet_balance', async p => {
            if (p === a) throw serverError(); backups++; return 20;
        }), e => e.code === (fault === 'chain' ? 'rpc_wrong_chain' : 'rpc_block_mismatch'));
        assert.equal(backups, 0); assert.equal(pool.active, 0);
    }
});
test('RPC rejects a changed reconciliation block and an unverified cold fallback', async () => {
    const { reads } = clockCoordinator(); const a = provider('primary'), b = provider('backup');
    const pool = new RpcPool([], reads, [a, b]); await pool.snapshot();
    await assert.rejects(pool.read('wallet_balance', async () => 20, 198), e => e.code === 'rpc_snapshot_changed');
    pool.anchor = null; a.getBlockNumber = async () => { throw serverError(); };
    await assert.rejects(pool.snapshot(), e => e.code === 'rpc_reference_unavailable');
});

test('paper defaults to late-entry and selected preflight never requests maker markets', async t => {
    const { settings } = fixture(t); const slugs = [];
    assert.equal(parseArgs(['paper', '--strategy=late-entry']).strategy, 'late-entry');
    assert.equal(parseArgs(['report', '--history']).history, true);
    assert.throws(() => parseArgs(['pilot', '--strategy=both']));
    assert.throws(() => parseArgs(['paper', '--history']));
    assert.deepEqual(loadSettings({ RESTART_DATA_DIR: settings.dataDir }).strategies, ['late-entry']);
    const client = { serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        market: async slug => { slugs.push(slug); return { slug, minimum: 5, accepting: true, tokens: ['1', '2'] }; },
        books: async () => [{ asks: [{ price: 0.8 }] }, { asks: [{ price: 0.21 }] }] };
    const result = await preflight(client, settings, { publicOnly: true });
    assert.equal(result.publicReady, true); assert.equal(slugs.length, 1); assert.ok(slugs[0].includes('-5m-'));
});
test('PublicNode primary gets a distinct dRPC backup without changing local env', t => {
    const { settings } = fixture(t);
    const result = loadSettings({ RESTART_DATA_DIR: settings.dataDir, POLYGON_RPC_URL: 'https://polygon-bor-rpc.publicnode.com' });
    assert.equal(result.rpcUrls.length, 2); assert.equal(new URL(result.rpcUrls[1]).hostname, 'polygon.drpc.org');
    assert.throws(() => loadSettings({ RESTART_DATA_DIR: settings.dataDir, POLYGON_RPC_URL: 'https://example.com',
        POLYGON_RPC_BACKUP_URL: 'https://example.com/' }), /must differ/);
});
test('history displays archived gains and losses without qualifying the active trial', t => {
    const { settings, store } = fixture(t); store.save(); trialManifest(settings);
    const old = path.join(settings.dataDir, 'old'); fs.mkdirSync(old);
    fs.writeFileSync(path.join(old, 'evaluation-report.json'), JSON.stringify({ baseline: 'old', selected: 'late-entry',
        strategies: [{ strategy: 'late-entry', pnl: 5 }, { strategy: 'maker-mm', pnl: -17.0319 }] }));
    const result = report(settings, Date.now(), true);
    assert.equal(result.selected, null); assert.equal(result.strategies.length, 1);
    assert.equal(result.strategies[0].cash, 20); assert.equal(result.history[0].strategies[1].pnl, -17.0319);
    assert.equal(result.history[0].archived, true);
});
test('profitable new trial under five elapsed days remains belum layak at Saturday', t => {
    const { settings, store } = fixture(t), now = Date.now();
    store.state.startedAt = now - 4.4 * 86400000;
    store.state.completed = Array.from({ length: 105 }, (_, i) => ({ traded: true, closedAt: now - (i % 5) * 86400000,
        pnl: 0.1, fees: 0, gas: 0, rebate: 0, capitalHours: 1 }));
    store.save(); const result = report({ ...settings, minDays: 5, evaluationEndsAt: now }, now);
    assert.equal(result.selected, null); assert.equal(result.decision, 'belum layak');
    assert.ok(result.strategies[0].reasons.includes('need_5_days'));
});
test('network counters survive restart and do not reset cash or exposure', t => {
    const { settings, store } = fixture(t);
    store.state.position = { holdings: [5, 0] };
    store.event('read_failed', { error: { category: 'timeout', stage: 'book_read', endpoint: 'clob' } });
    store.event('endpoint_recovered', { endpoint: 'clob', outageMs: 1000 });
    store.event('rpc_failover', { endpoint: 'rpc_backup' });
    const restarted = new Store(settings, 'paper', 'late-entry');
    assert.equal(restarted.state.operational.errors['book_read:timeout:-'], 1);
    assert.equal(restarted.state.operational.recoveredOutageMs, 1000);
    assert.equal(restarted.state.cash, 20); assert.deepEqual(restarted.state.position.holdings, [5, 0]);
    assert.deepEqual(paperExposure(settings), [{ baseline: 'new', strategy: 'late-entry' }]);
});
test('a response arriving after the entry window cannot reserve a market', async t => {
    const { settings, store } = fixture(t); let now = Math.floor(Date.now() / 300000) * 300000 + 275000;
    t.mock.method(Date, 'now', () => now);
    const client = { market: async slug => ({ slug, minimum: 5, accepting: true, tokens: ['1', '2'],
        open: now - 275000, end: now + 25000, fee: { rate: 0, exponent: 1 } }),
        books: async () => { now += 20000; return [{ bids: [], asks: [{ price: 0.8, size: 5 }] },
            { bids: [], asks: [{ price: 0.21, size: 5 }] }]; } };
    const engine = new Engine(settings, store, client); await engine.discover(now);
    assert.equal(store.state.position, null); assert.equal(Object.keys(store.state.seen).length, 0);
});
test('payout failures back off to 60 seconds without discarding inventory', async t => {
    const { settings, store } = fixture(t); let calls = 0; const end = Date.now();
    store.state.position = { market: { end }, holdings: [5, 0], orders: [], actions: [], lastDeployed: 0,
        exposureAt: end, startingCash: 20, capitalHours: 0 };
    const engine = new Engine(settings, store, { payout: async () => { calls++; throw serverError(); } });
    await engine.manage(null, end + 1); await engine.manage(null, end + 29000); assert.equal(calls, 1);
    await engine.manage(null, end + 30001); await engine.manage(null, end + 89000); assert.equal(calls, 2);
    await engine.manage(null, end + 90001); assert.equal(calls, 3);
    assert.deepEqual(store.state.position.holdings, [5, 0]); assert.equal(store.state.position.payoutFailures, 2);
});
test('settled late-entry inventory marks every five seconds without a trade feed', async t => {
    const { settings, store } = fixture(t); const now = Date.now(); let booksRead = 0;
    const books = [{ bids: [{ price: 0.8, size: 10 }], asks: [{ price: 0.81, size: 10 }] },
        { bids: [{ price: 0.19, size: 10 }], asks: [{ price: 0.2, size: 10 }] }];
    store.state.position = { market: { slug: 'market', open: now - 250000, end: now + 50000,
        fee: { rate: 0, exponent: 1 }, tokens: ['1', '2'] }, holdings: [5, 0], bought: [5, 0],
        orders: [], actions: [], fills: [], lastDeployed: 4, exposureAt: now, startingCash: 20, capitalHours: 0 };
    store.state.cash = 16;
    const feed = { generation: 0, reconnect: () => assert.fail('late-entry does not need a trade feed'), drain: () => [], close() {} };
    const engine = new Engine(settings, store, { serverTime: async () => Date.now(), books: async () => { booksRead++; return books; } }, feed);
    await engine.tick(now); await engine.tick(now + 4000); assert.equal(booksRead, 1);
    await engine.tick(now + 5000); assert.equal(booksRead, 2); assert.ok(store.state.position);
});
