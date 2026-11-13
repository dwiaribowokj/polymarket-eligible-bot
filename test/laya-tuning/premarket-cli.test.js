import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { parseArgs, smoke, writeReportAsync, installPaperSignals } from '../../scripts/premarket-paper.js';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { OperationalError } from '../../src/restart/network.js';

test('paper cutoff signal requests drain separately from process termination and removes listeners', () => {
    const target = new EventEmitter(), calls = [];
    const remove = installPaperSignals({ end: () => calls.push('end'), cutoff: () => calls.push('cutoff') }, target);
    target.emit('SIGUSR1'); assert.deepEqual(calls, ['cutoff']);
    target.emit('SIGTERM'); target.emit('SIGINT'); assert.deepEqual(calls, ['cutoff', 'end', 'end']);
    remove(); target.emit('SIGUSR1'); target.emit('SIGTERM');
    assert.equal(calls.length, 3); assert.equal(target.listenerCount('SIGUSR1'), 0);
});

test('premarket CLI exposes only explicit public preflight, paper run and report commands', () => {
    assert.deepEqual(parseArgs(['run', '--out=/tmp/premarket']), {
        command: 'run', out: '/tmp/premarket', smoke: false, history: false });
    assert.equal(parseArgs(['preflight', '--out=/tmp/premarket', '--smoke']).smoke, true);
    assert.equal(parseArgs(['report', '--out=/tmp/premarket', '--history']).history, true);
    for (const args of [[], ['live'], ['run', '--out=relative'], ['run', '--out=/tmp/a', '--live'],
        ['run', '--out=/tmp/a', '--reset'], ['run', '--out=/tmp/a', '--history'],
        ['report', '--out=/tmp/a', '--smoke'], ['run', '--out=/tmp/a', '--out=/tmp/b'],
        ['preflight', '--out=/tmp/a', '--smoke', '--smoke']]) assert.throws(() => parseArgs(args));
});

function fixture() {
    let now = 60000, closed = false;
    const market = { slug: 'btc-updown-5m-300', open: 300000, end: 600000, minimum: 5, accepting: true,
        tokens: ['up', 'down'], conditionId: 'condition', tick: .01, ticks: [.01, .01],
        fee: { rate: 0, exponent: 1, takerOnly: true } };
    const books = { generation: 1, tokens: market.tokens,
        watch(tokens, value) { assert.equal(value, market); assert.deepEqual(tokens, market.tokens); },
        snapshot() { return market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
            timestamp: now, fetchedAt: now, bids: [{ price: .49, size: 20 }], asks: [{ price: .5, size: 20 }] })); },
        close() { closed = true; } };
    const calls = [], client = {
        startBtcFeed() { calls.push('feed'); }, btcStatus() { return { ready: true }; },
        async market(slug) { calls.push(['market', slug]); return market; },
        async books(value) { calls.push('books'); assert.equal(value, market); return books.snapshot(); },
        post() { throw new Error('transactions_forbidden'); },
        walletHealth() { throw new Error('wallet_read_forbidden'); },
        predict() { throw new Error('inference_forbidden'); } };
    return { market, books, client, calls, clock: () => now, sleep: async ms => { now += ms; }, get closed() { return closed; } };
}

test('smoke verifies future market and fresh public stream without opening reference, inference or wallet reads', async () => {
    const f = fixture();
    const result = await smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep);
    assert.deepEqual(result, { market: 'btc-updown-5m-300', futureMarket: true, open: 300000,
        websocketReady: true, btcReady: true, openingReferenceRequired: false,
        inferenceSubmitted: false, transactionsSubmitted: false });
    assert.equal(f.closed, true);
    assert.deepEqual(f.calls, ['feed', ['market', 'btc-updown-5m-300'], 'books']);
});

test('smoke rejects unavailable BTC and wrong future market and always closes stream', async () => {
    const wrong = fixture(); wrong.market.open = 0;
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, wrong.client, () => wrong.books, wrong.clock, wrong.sleep), /future_market_invalid/);
    assert.equal(wrong.closed, true);
    const offline = fixture(); offline.client.btcStatus = () => ({ ready: false });
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, offline.client, () => offline.books, offline.clock, offline.sleep), /btc_unavailable/);
    assert.equal(offline.closed, true);
});

test('smoke reconnects after a rejected initial snapshot using the stream backoff', async () => {
    const f = fixture(), connectedAt = [];
    const stream = new LiveBookHistory({ clock: f.clock, scheduleInterval: () => 1, cancelInterval() {},
        socketFactory() {
            connectedAt.push(f.clock());
            const socket = new EventEmitter(); socket.readyState = 1; socket.send = () => {};
            socket.terminate = () => { socket.readyState = 3; };
            queueMicrotask(() => {
                socket.emit('open');
                socket.emit('message', JSON.stringify(f.market.tokens.map(asset_id => ({ event_type: 'book',
                    market: f.market.conditionId, asset_id, tick_size: '.01',
                    timestamp: String(f.clock() - (connectedAt.length === 1 ? 10000 : 0)),
                    bids: [{ price: '.49', size: '20' }], asks: [{ price: '.5', size: '20' }] }))));
            });
            return socket;
        } });
    const result = await smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => stream, f.clock, f.sleep);
    assert.equal(result.websocketReady, true);
    assert.equal(connectedAt.length, 2); assert(connectedAt[1] - connectedAt[0] >= 1000);
    assert.equal(stream.closed, true);
});

test('smoke repeats REST and fresh stream validation after stale REST or a changed stream generation', async t => {
    for (const cause of ['stale REST', 'reconnected stream']) await t.test(cause, async () => {
        const f = fixture(); let reads = 0;
        f.client.books = async (_market, options) => {
            assert.deepEqual(options, { deadline: 75000, retries: 0 });
            if (++reads === 1) {
                if (cause === 'stale REST') throw new OperationalError('stale_book', 'stale_data', { stage: 'book_read' });
                f.books.generation++;
            }
            return f.books.snapshot();
        };
        assert.equal((await smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep)).websocketReady, true);
        assert.equal(reads, 2); assert.equal(f.closed, true);
    });
});

test('smoke never substitutes a fresh stream for persistently stale REST and stops at fifteen seconds', async () => {
    const f = fixture(); let reads = 0;
    f.client.books = async () => { reads++; throw new OperationalError('stale_book', 'stale_data', { stage: 'book_read' }); };
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep),
        error => error.code === 'stale_book');
    assert.equal(f.clock(), 75000); assert.equal(reads, 15); assert.equal(f.closed, true);
});

test('smoke retains the five-second stream guard even after a successful REST read', async () => {
    const f = fixture(), snapshot = f.books.snapshot;
    f.books.snapshot = () => snapshot().map(book => ({ ...book, timestamp: f.clock() - 5001 }));
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep), /execution_book_stale_or_future/);
    assert.equal(f.closed, true);
});

test('smoke does not retry metadata, tick or identity failures', async t => {
    for (const code of ['market_constraints_changed', 'tick_snapshot_mismatch', 'execution_tick_mismatch', 'execution_token_mismatch'])
        await t.test(code, async () => {
            const f = fixture(); let reads = 0;
            f.client.books = async () => { reads++; throw new Error(code); };
            await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep),
                error => error.message === code);
            assert.equal(reads, 1); assert.equal(f.clock(), 60000); assert.equal(f.closed, true);
        });
});

test('smoke cannot hide changed metadata behind a concurrent stream generation change', async () => {
    const f = fixture(), snapshot = f.books.snapshot;
    f.books.snapshot = () => snapshot().map(book => ({ ...book, tick: .1 }));
    f.client.tickSize = async () => { f.market.conditionId = 'different'; f.books.generation++; return .01; };
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep),
        /execution_metadata_changed_or_expired/);
    assert.equal(f.clock(), 60000); assert.equal(f.closed, true);
});

test('smoke rejects a REST attempt that completes beyond the overall deadline', async () => {
    const f = fixture(); let reads = 0;
    f.client.books = async (_market, options) => { reads++; assert.equal(options.deadline, 75000); await f.sleep(15001); };
    await assert.rejects(smoke({ shares: 5, dataAgeMs: 5000 }, f.client, () => f.books, f.clock, f.sleep), /premarket_smoke_timeout/);
    assert.equal(reads, 1); assert.equal(f.closed, true);
});

test('report subcommand works without funding, provider or wallet environment and creates no ledger', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const output = spawnSync(process.execPath, ['scripts/premarket-paper.js', 'report', `--out=${directory}`, '--history'],
        { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(output.status, 0, output.stderr);
    const report = JSON.parse(output.stdout);
    assert.equal(report.id, null); assert.equal(report.automaticPromotion, false);
    assert.deepEqual(report.history, []); assert.deepEqual(fs.readdirSync(directory), []);
});

test('report worker reads atomic ledger and does not serialize runtime credentials', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-worker-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const armNames = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
    const config = { id: 'worker-period', dataDir: directory, control: { privateKey: 'DO_NOT_SERIALIZE' },
        policy: { experiment: 'premarket-three-candles-paper-v1', armNames, capital: 20, shares: 5,
            inferencePolicy: 'independent-laya-router-frozen-forecast-30s', leadSeconds: 240, costCapPerShare: .85 } };
    const state = { id: config.id, startedAt: Date.now(), markets: {}, slots: {}, snapshots: [],
        arms: Object.fromEntries(armNames.map(name => [name, { cash: 20, peak: 20, drawdown: 0, positions: {}, completed: [], outcomes: {} }])) };
    fs.mkdirSync(path.join(directory, config.id));
    fs.writeFileSync(path.join(directory, config.id, 'ledger.json'), JSON.stringify(state));
    const report = await writeReportAsync(config);
    assert.equal(report.id, config.id); assert.equal(JSON.stringify(report).includes('DO_NOT_SERIALIZE'), false);
    assert.equal(fs.existsSync(path.join(directory, config.id, 'reports', 'latest.json')), true);
});
