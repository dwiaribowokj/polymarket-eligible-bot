import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaRpcPool } from '../../src/laya-live/rpc.js';
import { RpcProvider } from '../../src/restart/rpc.js';
import { ReadCoordinator, OperationalError, TRANSPORT } from '../../src/restart/network.js';

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const transportFailure = () => new OperationalError('rpc_unavailable', 'transport');

function fixture(t, policy = {}) {
    let now = 100000, head = 200;
    const events = [], sleeps = [], calls = [];
    const coordinator = new ReadCoordinator({ now: () => now, random: () => 0, policy,
        sleep: async ms => { sleeps.push(ms); now += ms; }, onEvent: event => events.push(event) });
    const provider = name => ({ name, polling: true, removeAllListeners() { calls.push([name, 'close']); },
        send: async method => { calls.push([name, method]); return 137; },
        getBlockNumber: async () => { calls.push([name, 'head']); return head; },
        getBlock: async number => { calls.push([name, 'block', number]); return { number, hash: `hash-${number}` }; } });
    const primary = provider('primary'), backup = provider('backup');
    const pool = new LayaRpcPool([], coordinator, [primary, backup]);
    t.after(() => pool.close());
    return { pool, primary, backup, coordinator, events, calls, sleeps,
        advance(ms = TRANSPORT.circuitMs) { now += ms; }, head(number) { head = number; },
        async onBackup() {
            assert.equal(await pool.snapshot(), 199);
            const result = await pool.read('wallet_balance', async p => {
                if (p === primary) throw transportFailure(); return p.name;
            }, 199);
            assert.equal(result, 'backup'); assert.equal(pool.active, 1);
        } };
}

test('a due primary recovery probe never delays the healthy backup or repeats foreground work', { timeout: 1000 }, async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    assert.equal(f.coordinator.policy.timeoutMs, 3000);
    const gate = deferred(); let probes = 0, reads = 0;
    f.primary.send = async () => { probes++; return gate.promise; };
    assert.equal(await f.pool.read('wallet_holdings', async (provider, block) => {
        reads++; assert.equal(block, 199); return provider.name;
    }, 199), 'backup');
    assert.equal(probes, 1); assert.equal(reads, 1); assert.equal(f.sleeps.length, 1);
    assert.equal(f.pool.active, 1); assert.ok(f.pool.primaryRecoveryPending);
    const pending = f.pool.primaryRecoveryPending; gate.resolve(137); await pending;
    assert.equal(f.pool.active, 1);
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'primary');
    assert.equal(f.pool.active, 0);
    assert.ok(f.events.some(event => event.type === 'rpc_failover' && event.stage === 'rpc_primary_recovery'));
});

test('concurrent backup reads coalesce one probe and discard its stale generation', async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    const gate = deferred(); let probes = 0;
    f.primary.send = async () => { probes++; return gate.promise; };
    assert.deepEqual(await Promise.all(Array.from({ length: 12 }, (_, index) =>
        f.pool.read('wallet_holdings', async p => p.name, 199, `holdings:${index}`))), Array(12).fill('backup'));
    assert.equal(probes, 1);
    const pending = f.pool.primaryRecoveryPending; gate.resolve(137); await pending;
    assert.equal(f.pool.recoveredPrimary, null);
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    assert.equal(f.pool.active, 1); assert.equal(probes, 1);
});

test('a probe validated against an older anchor cannot select primary or regress the snapshot', async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    const gate = deferred(); f.primary.send = async () => gate.promise;
    f.head(201);
    assert.equal(await f.pool.snapshot(), 200);
    assert.deepEqual(f.pool.anchor, { number: 200, hash: 'hash-200' });
    const pending = f.pool.primaryRecoveryPending; gate.resolve(137); await pending;
    assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
    const values = await f.pool.read('wallet_holdings', async (provider, block) => ({
        balance: 20, holdings: [0, 0], provider: provider.name, block
    }), 200);
    assert.deepEqual(values, { balance: 20, holdings: [0, 0], provider: 'backup', block: 200 });
    await assert.rejects(f.pool.read('wallet_balance', async () => 20, 199), { code: 'rpc_snapshot_changed' });
    f.advance(1100); f.head(200);
    f.primary.getBlockNumber = async () => 200;
    await assert.rejects(f.pool.snapshot(), { code: 'rpc_snapshot_behind' });
    assert.deepEqual(f.pool.anchor, { number: 200, hash: 'hash-200' });
});

test('a candidate invalidated before the next idle boundary never changes the active endpoint', async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    await f.pool.read('wallet_balance', async p => p.name, 199);
    await f.pool.primaryRecoveryPending;
    assert.ok(f.pool.recoveredPrimary); assert.equal(f.pool.active, 1);
    f.pool.anchor = { number: 200, hash: 'hash-200' };
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 200), 'backup');
    assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
});

test('wrong chain, conflicting hash, wrong block number and missing reference never promote primary', async t => {
    for (const [fault, code] of [['chain', 'rpc_wrong_chain'], ['hash', 'rpc_block_mismatch'],
        ['number', 'rpc_block_number_mismatch'], ['missing', 'rpc_missing_reference_block']]) {
        await t.test(fault, async t => {
            const f = fixture(t); await f.onBackup(); f.advance();
            if (fault === 'chain') f.primary.send = async () => 1;
            else f.primary.getBlock = async number => fault === 'missing' ? null
                : { number: number + (fault === 'number' ? 1 : 0), hash: fault === 'hash' ? 'conflict' : `hash-${number}` };
            assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
            await f.pool.primaryRecoveryPending;
            assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
            assert.deepEqual(f.pool.anchor, { number: 199, hash: 'hash-199' });
            assert.ok(f.events.some(event => event.type === 'read_failed'
                && event.error.stage === 'rpc_primary_recovery' && event.error.code === code));
            assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
        });
    }
});

test('probe transport failures respect the circuit and next recovery time while backup stays available', async t => {
    const f = fixture(t, { circuitFailures: 1 }); await f.onBackup(); f.advance();
    let probes = 0;
    f.primary.send = async () => { probes++; throw transportFailure(); };
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    await f.pool.primaryRecoveryPending;
    assert.equal(probes, 1); assert.equal(f.pool.active, 1);
    assert.ok(f.coordinator.state('rpc_primary').openUntil > f.coordinator.now());
    for (let index = 0; index < 10; index++) {
        f.advance(1000);
        assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    }
    assert.equal(probes, 1);
    f.primary.send = async () => { probes++; return 137; };
    f.advance(TRANSPORT.circuitMs);
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    await f.pool.primaryRecoveryPending;
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'primary');
    assert.equal(probes, 2);
});

test('a timed out probe cannot select primary after its uncooperative provider completes late', async t => {
    const f = fixture(t, { timeoutMs: 20 }); await f.onBackup(); f.advance();
    const gate = deferred(); f.primary.send = async () => gate.promise;
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    await f.pool.primaryRecoveryPending;
    assert.ok(f.events.some(event => event.type === 'read_failed'
        && event.error.stage === 'rpc_primary_recovery' && event.error.code === 'read_timeout'));
    const blockCalls = f.calls.filter(([name, method]) => name === 'primary' && method === 'block').length;
    gate.resolve(137); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
    assert.equal(f.calls.filter(([name, method]) => name === 'primary' && method === 'block').length, blockCalls);
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
});

test('a failed backup still falls back to primary with the same complete holdings and balance snapshot', async t => {
    const f = fixture(t); await f.onBackup();
    const attempts = [];
    const result = await f.pool.read('wallet_holdings', async (provider, block) => {
        attempts.push([provider.name, block]);
        const balance = 20;
        if (provider === f.backup) throw transportFailure();
        return { balance, holdings: [2, 3], block };
    }, 199);
    assert.deepEqual(attempts, [['backup', 199], ['primary', 199]]);
    assert.deepEqual(result, { balance: 20, holdings: [2, 3], block: 199 });
    assert.equal(f.pool.active, 0);
    assert.ok(f.calls.some(([name, method, number]) => name === 'primary' && method === 'block' && number === 199));
});

test('close aborts the probe context, ignores late success and prevents further RPC work', async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    const gate = deferred(); f.primary.send = async () => gate.promise;
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    const pending = f.pool.primaryRecoveryPending, controller = f.pool.primaryRecoveryController;
    f.pool.close(); assert.equal(controller.signal.aborted, true);
    gate.resolve(137); await pending;
    assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
    assert.equal(f.pool.primaryRecoveryPending, null);
    assert.equal(f.primary.polling, false); assert.equal(f.backup.polling, false);
    const calls = f.calls.length;
    await assert.rejects(f.pool.snapshot(), { code: 'rpc_closed' });
    await assert.rejects(f.pool.read('wallet_balance', async p => p.name, 199), { code: 'rpc_closed' });
    assert.equal(f.calls.length, calls);
});

test('the isolated primary probe preserves the inherited RPC fetch abort context', async t => {
    const f = fixture(t); await f.onBackup(); f.advance();
    const gate = deferred(); let fetchSignal, fetchCalls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        fetchCalls++; assert.equal(url, 'https://rpc.invalid/');
        fetchSignal = options.signal; return gate.promise;
    });
    f.primary.connection = { url: 'https://rpc.invalid/' }; f.primary.requestId = 0;
    f.primary.send = RpcProvider.prototype.send;
    assert.equal(await f.pool.read('wallet_balance', async p => p.name, 199), 'backup');
    assert.equal(fetchCalls, 1); assert.ok(fetchSignal instanceof AbortSignal);
    assert.equal(fetchSignal.aborted, false);
    const pending = f.pool.primaryRecoveryPending;
    const blockCalls = f.calls.filter(([name, method]) => name === 'primary' && method === 'block').length;
    f.pool.close(); assert.equal(fetchSignal.aborted, true);
    gate.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x89' })));
    await pending;
    assert.equal(f.pool.active, 1); assert.equal(f.pool.recoveredPrimary, null);
    assert.equal(f.calls.filter(([name, method]) => name === 'primary' && method === 'block').length, blockCalls);
});
