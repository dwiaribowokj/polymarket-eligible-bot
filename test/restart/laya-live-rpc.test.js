import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LayaRpcPool } from '../../src/laya-live/rpc.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { readOnlyLiveClient } from '../../src/laya-live/diagnostic.js';
import { ReadCoordinator, OperationalError } from '../../src/restart/network.js';
import { TradingClient } from '../../src/restart/client.js';
import { BASELINE } from '../../src/restart/config.js';
import { Store } from '../../src/restart/store.js';

function fixture() {
    let now = 100000, head = 200;
    const events = [], calls = [];
    const reads = new ReadCoordinator({ now: () => now, sleep: async ms => { now += ms; }, random: () => 0 });
    reads.onEvent = e => events.push(e);
    const provider = name => ({ send: async () => 137, getBlockNumber: async () => head,
        getBlock: async number => { calls.push([name, number]); return { number, hash: `hash-${number}` }; } });
    const primary = provider('primary'), backup = provider('backup');
    const pool = new LayaRpcPool([], reads, [primary, backup]);
    return { pool, primary, backup, events, calls, advance(ms = 1100) { now += ms; }, head(value) { head = value; } };
}

test('missing latest block fails over using the previously validated common block', async () => {
    const f = fixture(); assert.equal(await f.pool.snapshot(), 199);
    f.advance(); f.head(201); f.primary.getBlock = async () => null;
    assert.equal(await f.pool.snapshot(), 200); assert.equal(f.pool.active, 1);
    assert.ok(f.calls.some(([name, block]) => name === 'backup' && block === 199));
    assert.ok(f.events.some(e => e.type === 'rpc_failover'));
    assert.ok(f.events.some(e => e.type === 'read_failed' && e.error.code === 'rpc_missing_block' && e.error.category === 'transport'));
});

test('snapshot calls coalesce and cache briefly, then fetch a new block without returning a stale anchor on failure', async () => {
    const f = fixture();
    assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => f.pool.snapshot())), Array(10).fill(199));
    assert.equal(f.calls.length, 1);
    await f.pool.snapshot(); assert.equal(f.calls.length, 1);
    f.advance(); f.head(201); assert.equal(await f.pool.snapshot(), 200);
    assert.equal(f.calls.length, 2);
    f.advance(); f.primary.getBlock = f.backup.getBlock = async () => null;
    await assert.rejects(f.pool.snapshot(), e => e.code === 'rpc_missing_reference_block');
    assert.equal(f.pool.anchor.number, 200);
    await assert.rejects(f.pool.snapshot());
});

test('a missing reference block is unavailable; wrong chain, hash or block number remain fatal', async () => {
    for (const fault of ['chain', 'hash', 'number']) {
        const f = fixture(); await f.pool.snapshot(); f.advance();
        f.primary.getBlock = async () => null;
        if (fault === 'chain') f.backup.send = async () => 1;
        if (fault === 'hash') f.backup.getBlock = async number => ({ number, hash: 'different' });
        if (fault === 'number') {
            f.head(201); f.backup.getBlock = async number => ({ number: number === 200 ? 201 : number, hash: `hash-${number}` });
        }
        await assert.rejects(f.pool.snapshot(), e => e.code === ({ chain: 'rpc_wrong_chain', hash: 'rpc_block_mismatch',
            number: 'rpc_block_number_mismatch' })[fault]);
        assert.equal(f.pool.active, 0);
    }
});

test('backup switches back to primary after its recovery probe without postponing the probe', async () => {
    const f = fixture(); await f.pool.snapshot(); f.advance();
    const healthy = f.primary.getBlock; f.primary.getBlock = async () => null;
    await f.pool.snapshot(); assert.equal(f.pool.active, 1);
    f.advance(15000); await f.pool.snapshot(); assert.equal(f.pool.active, 1);
    f.primary.getBlock = healthy; f.advance(15000); await f.pool.snapshot(); assert.equal(f.pool.active, 0);
});

test('cold startup never accepts an unverified backup and a restored primary can establish the first anchor', async () => {
    const f = fixture(), healthy = f.primary.getBlock; f.primary.getBlock = async () => null;
    await assert.rejects(f.pool.snapshot(), e => e.code === 'rpc_reference_unavailable');
    assert.equal(f.pool.anchor, null); assert.equal(f.calls.some(([name]) => name === 'backup'), false);
    f.primary.getBlock = healthy; f.advance(); assert.equal(await f.pool.snapshot(), 199);
});

test('confirmed balance caching is tied to exact block/hash and never carries values across blocks', async t => {
    const client = Object.create(LayaTradingClient.prototype);
    client.balancePending = new Map(); client.rpc = { anchor: { hash: 'block-a' } };
    let calls = 0;
    t.mock.method(TradingClient.prototype, 'balance', async block => { calls++; return block; });
    assert.deepEqual(await Promise.all([client.balance(100), client.balance(100)]), [100, 100]);
    assert.equal(calls, 1); await client.balance(100); assert.equal(calls, 1);
    client.rpc.anchor.hash = 'block-b'; assert.equal(await client.balance(100), 100); assert.equal(calls, 2);
    assert.equal(await client.balance(101), 101); assert.equal(calls, 3);
});

function engineFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-rpc-engine-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const settings = { ...BASELINE, dataDir: dir, fingerprint: 'test', capital: 20 };
    const store = new Store(settings, 'pilot', 'late-entry'); store.logger = () => {};
    store.state.walletStart = 20;
    let unavailable = true, decisions = 0;
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(), balance: async () => {
        if (unavailable) throw new OperationalError('rpc_missing_block', 'transport'); return 20;
    } };
    const config = { settings, policy: { aiSource: 'source' } };
    const engine = new LayaLiveEngine(config, store, client, {}, {});
    engine.watch = async () => {};
    engine.discover = async () => { decisions++; };
    return { engine, store, client, decisions: () => decisions, restore() { unavailable = false; engine.broker.rpcRetryAt = 0; } };
}

test('a continuous flat engine pauses during an RPC outage, makes no decision, and resumes once wallet data is valid', async t => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now);
    const f = engineFixture(t);
    await f.engine.tick();
    assert.equal(f.store.state.stopped, null); assert.equal(f.decisions(), 0);
    assert.equal(f.store.state.position, null); assert.deepEqual(f.store.state.seen, {});
    f.restore(); await f.engine.tick();
    assert.equal(f.decisions(), 0, 'restored endpoint still respects the persisted retry deadline');
    now = f.store.state.entryHolds.maintenance_wallet.retryAt + 1;
    await f.engine.tick();
    assert.equal(f.decisions(), 1); assert.equal(f.store.state.stopped, null);
});

test('identity errors while flat and unreadable wallets while exposed cannot use the pause path', async t => {
    const f = engineFixture(t);
    f.client.balance = async () => { throw new OperationalError('rpc_block_mismatch'); };
    await f.engine.tick(); assert.equal(f.store.state.stopped.reason, 'operational_check_failed');
    const client = { balance: async () => { throw new OperationalError('rpc_missing_block', 'transport'); } };
    const broker = new LayaLiveBroker(BASELINE, { state: { position: {} } }, client, async () => {});
    await assert.rejects(broker.checkWallet(), e => e.code === 'rpc_missing_block' && e.category === 'transport');
});

test('read-only diagnostics block financial methods and hide raw signing/SDK/provider escape routes', () => {
    const blocked = []; let mutations = 0;
    const raw = { balance: async () => 20, prepare() { mutations++; }, post() { mutations++; },
        secure: { postOrder() { mutations++; } }, provider: {}, rpc: {}, authenticate() { mutations++; } };
    const facade = readOnlyLiveClient(raw, name => blocked.push(name));
    for (const name of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction', 'authenticate'])
        assert.throws(() => facade[name](), /diagnostic_financial_operation_blocked/);
    for (const name of ['secure', 'provider', 'rpc', 'public', 'token', 'ctf', 'json']) assert.equal(facade[name], undefined);
    assert.equal(mutations, 0); assert.equal(blocked.length, 6);
});
