import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaRpcPool } from '../../src/laya-live/rpc.js';
import { OperationalError, ReadCoordinator } from '../../src/restart/network.js';

const wallet = `0x${'1'.repeat(40)}`, blockHash = `0x${'a'.repeat(64)}`;
const ctf = new ethers.utils.Interface([
    'function balanceOf(address,uint256) view returns (uint256)',
    'function balanceOfBatch(address[],uint256[]) view returns (uint256[])',
]);

function fixture(t, { policy = {}, anchored = true } = {}) {
    const calls = [], validations = [], events = [];
    const reads = new ReadCoordinator({ random: () => 0, sleep: async () => {},
        policy: { retryMinMs: 0, retryMaxMs: 0, ...policy }, onEvent: event => events.push(event) });
    const provider = name => ({
        _isProvider: true, name, chain: 137, hash: blockHash, balances: null,
        resolveName: async address => address,
        removeAllListeners() {},
        async send(method) { validations.push([name, method]); assert.equal(method, 'eth_chainId'); return this.chain; },
        async getBlockNumber() { validations.push([name, 'head']); return 200; },
        async getBlock(number) { validations.push([name, 'block', number]); return { number, hash: this.hash }; },
        async call(transaction, block) {
            const tx = await ethers.utils.resolveProperties(transaction);
            const parsed = ctf.parseTransaction(tx);
            calls.push({ name, block, tx, method: parsed.name,
                accounts: [...parsed.args[0]], ids: parsed.args[1].map(id => id.toString()) });
            assert.equal(parsed.name, 'balanceOfBatch', 'never fan out into per-token reads');
            assert.equal(tx.to.toLowerCase(), CONTRACTS.conditionalTokens.toLowerCase());
            if (this.error) throw this.error;
            if (this.pending) return this.pending;
            if (this.raw !== undefined) return this.raw;
            return ctf.encodeFunctionResult('balanceOfBatch', [this.balances || parsed.args[1].map(() => 0)]);
        },
    });
    const primary = provider('primary'), backup = provider('backup');
    const client = Object.create(LayaTradingClient.prototype);
    client.settings = { wallet };
    client.rpc = new LayaRpcPool([], reads, [primary, backup]);
    if (anchored) client.rpc.anchor = { number: 199, hash: blockHash };
    t.after(() => client.rpc.close());
    return { client, primary, backup, calls, validations, events };
}

test('live holdings reads all 77 tracked tokens in one pinned batch, including 66 zero balances', async t => {
    const f = fixture(t), tokens = Array.from({ length: 77 }, (_, index) => String(index + 1));
    f.primary.balances = tokens.map((_, index) => index < 11 ? String((index + 1) * 1000000 + 1) : '0');
    assert.deepEqual(await f.client.holdings(tokens, 199), tokens.map((_, index) => index < 11 ? index + 1.000001 : 0));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].block, 199);
    assert.deepEqual(f.calls[0].ids, tokens);
    assert.deepEqual(f.calls[0].accounts, tokens.map(() => wallet));
    assert.deepEqual(f.validations, []);
});

test('live holdings captures the token list before awaiting its confirmed block', async t => {
    const f = fixture(t), tokens = ['1', '2'];
    let confirm;
    f.client.confirmedBlock = () => new Promise(resolve => { confirm = resolve; });
    const pending = f.client.holdings(tokens);
    tokens.splice(0, tokens.length, '3');
    confirm(199);
    assert.deepEqual(await pending, [0, 0]);
    assert.deepEqual(f.calls[0].ids, ['1', '2']);
    assert.equal(f.calls.length, 1);
});

test('holdings preserves token order and duplicate entries', async t => {
    const f = fixture(t);
    f.primary.balances = ['1234567', '0', '1234567'];
    assert.deepEqual(await f.client.holdings(['2', '1', '2'], 199), [1.234567, 0, 1.234567]);
    assert.deepEqual(f.calls[0].ids, ['2', '1', '2']);
});

test('omitting the block obtains one confirmed snapshot before the batch', async t => {
    const f = fixture(t, { anchored: false });
    assert.deepEqual(await f.client.holdings(['1', '2']), [0, 0]);
    assert.deepEqual(f.client.rpc.anchor, { number: 199, hash: blockHash });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].block, 199);
    assert.equal(f.validations.filter(([, method]) => method === 'head').length, 1);
});

test('concurrent identical batches coalesce but a later verification rereads the same block', async t => {
    const f = fixture(t);
    assert.deepEqual(await Promise.all([f.client.holdings(['1', '2'], 199), f.client.holdings(['1', '2'], 199)]), [[0, 0], [0, 0]]);
    assert.equal(f.calls.length, 1);
    f.primary.balances = ['1000000', '0'];
    assert.deepEqual(await f.client.holdings(['1', '2'], 199), [1, 0]);
    assert.equal(f.calls.length, 2);
});

test('empty holdings requires the same anchor but makes no contract call', async t => {
    const f = fixture(t);
    assert.deepEqual(await f.client.holdings([], 199), []);
    await assert.rejects(f.client.holdings([], 198), { code: 'rpc_snapshot_changed' });
    assert.equal(f.calls.length, 0);
});

test('a changed anchor rejects holdings before any contract call', async t => {
    const f = fixture(t);
    await assert.rejects(f.client.holdings(['1', '2'], 198), { code: 'rpc_snapshot_changed' });
    assert.equal(f.calls.length, 0);
});

test('batch failover validates the same anchor and repeats only one complete batch on backup', async t => {
    const f = fixture(t);
    f.primary.error = new OperationalError('read_timeout', 'timeout');
    f.backup.balances = ['1000000', '0', '123456'];
    assert.deepEqual(await f.client.holdings(['1', '2', '3'], 199), [1, 0, .123456]);
    assert.deepEqual(f.calls.map(call => [call.name, call.block, call.ids]), [
        ['primary', 199, ['1', '2', '3']], ['backup', 199, ['1', '2', '3']],
    ]);
    assert.deepEqual(f.validations, [['backup', 'eth_chainId'], ['backup', 'block', 199]]);
    assert.equal(f.client.rpc.active, 1);
});

for (const [fault, code] of [['chain', 'rpc_wrong_chain'], ['hash', 'rpc_block_mismatch']]) {
    test(`batch failover rejects conflicting ${fault} before reading backup holdings`, async t => {
        const f = fixture(t);
        f.primary.error = new OperationalError('read_timeout', 'timeout');
        f.backup[fault] = fault === 'chain' ? 1 : `0x${'b'.repeat(64)}`;
        await assert.rejects(f.client.holdings(['1', '2'], 199), { code });
        assert.equal(f.calls.length, 1);
        assert.equal(f.client.rpc.active, 0);
    });
}

for (const balances of [[], ['0'], ['0', '0', '0']]) {
    test(`batch rejects ${balances.length} returned balances for two tokens without fallback`, async t => {
        const f = fixture(t);
        f.primary.balances = balances;
        await assert.rejects(f.client.holdings(['1', '2'], 199), {
            code: 'invalid_holdings_batch', category: 'validation', stage: 'wallet_holdings',
        });
        assert.equal(f.calls.length, 1);
    });
}

for (const value of ['9007199254740992', ethers.constants.MaxUint256.toString()]) {
    test(`batch rejects a balance outside exact micro-unit range (${value.length} digits) without fallback`, async t => {
        const f = fixture(t);
        f.primary.balances = ['0', value];
        await assert.rejects(f.client.holdings(['1', '2'], 199), {
            code: 'invalid_holdings_balance', category: 'validation', stage: 'wallet_holdings',
        });
        assert.equal(f.calls.length, 1);
    });
}

test('malformed ABI result fails closed without trying individual token reads or backup', async t => {
    const f = fixture(t);
    f.primary.raw = '0x1234';
    await assert.rejects(f.client.holdings(['1', '2'], 199), { category: 'contract', stage: 'wallet_holdings' });
    assert.equal(f.calls.length, 1);
});

test('timeouts remain bounded to one batch per endpoint with no per-token fallback', { timeout: 2000 }, async t => {
    const f = fixture(t, { policy: { timeoutMs: 20 } });
    f.primary.pending = f.backup.pending = new Promise(() => {});
    await assert.rejects(f.client.holdings(Array.from({ length: 77 }, (_, index) => String(index)), 199), {
        code: 'read_timeout', category: 'timeout', stage: 'wallet_holdings',
    });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map(call => call.name), ['primary', 'backup']);
    assert.ok(f.calls.every(call => call.ids.length === 77 && call.block === 199));
});
