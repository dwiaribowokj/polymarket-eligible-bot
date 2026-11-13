import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaRpcPool, LayaRpcProvider, temporaryRpcFailure } from '../../src/laya-live/rpc.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { RpcProvider } from '../../src/restart/rpc.js';
import { ReadCoordinator, classifyError, retryable } from '../../src/restart/network.js';

const URLS = ['https://primary.rpc.invalid/', 'https://backup.rpc.invalid/'];
const HASH = `0x${'11'.repeat(32)}`;
const ANCHOR = { number: 100, hash: `0x${'22'.repeat(32)}` };
const READ_METHODS = ['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber',
    'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_call',
    'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getLogs'];

function fixture(t, respond) {
    let now = 100000;
    const calls = [], events = [];
    const coordinator = new ReadCoordinator({ now: () => now, random: () => 0,
        sleep: async ms => { now += ms; }, onEvent: event => events.push(event) });
    const pool = new LayaRpcPool(URLS, coordinator);
    pool.anchor = { ...ANCHOR };
    for (const [index, provider] of pool.providers.entries()) provider.getBlock = async number => {
        calls.push({ index, method: 'anchor', number });
        return { number, hash: ANCHOR.hash };
    };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const index = URLS.indexOf(url), request = JSON.parse(options.body);
        calls.push({ index, method: request.method });
        const reply = respond(index, request.method);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            result: reply?.result ?? (request.method === 'eth_chainId' ? '0x89' : { transactionHash: HASH }) }),
        { status: reply?.status || 200, headers: reply?.headers });
    });
    t.after(() => pool.close());
    return { pool, calls, events, coordinator, advance(ms) { now += ms; },
        read: () => pool.read('transaction_receipt', p => p.send('eth_getTransactionReceipt', [HASH]), ANCHOR.number) };
}

test('live RPC read403 fails over after validating the complete anchor and cools down primary', async t => {
    const f = fixture(t, index => index === 0 ? { status: 403 } : undefined);
    assert.deepEqual(await f.read(), { transactionHash: HASH });
    assert.equal(f.pool.active, 1);
    assert.deepEqual(f.pool.anchor, ANCHOR);
    assert.deepEqual(f.calls, [{ index: 0, method: 'eth_getTransactionReceipt' },
        { index: 1, method: 'eth_chainId' }, { index: 1, method: 'anchor', number: ANCHOR.number },
        { index: 1, method: 'eth_getTransactionReceipt' }]);
    assert.ok(f.events.some(event => event.type === 'read_failed' && event.error.code === 'rpc_endpoint_forbidden'
        && event.error.category === 'transport' && event.error.httpStatus === 403
        && event.error.endpoint === 'rpc_primary' && event.error.stage === 'transaction_receipt'));
    assert.ok(f.coordinator.state('rpc_primary').notBefore > f.coordinator.now());
    for (let count = 0; count < 10; count++) { f.advance(1000); await f.read(); }
    assert.equal(f.calls.filter(call => call.index === 0).length, 1);
});

test('a403 while validating primary also permits only a validated backup read', async t => {
    const f = fixture(t, index => index === 0 ? { status: 403 } : undefined);
    // A caller may retain an exact validated anchor while the pool has no
    // selected snapshot. The cold path without any anchor remains forbidden.
    f.pool.anchor = null;
    assert.deepEqual(await f.pool.use('transaction_receipt', p => p.send('eth_getTransactionReceipt', [HASH]),
        { anchor: { ...ANCHOR } }), { transactionHash: HASH });
    assert.deepEqual(f.calls, [{ index: 0, method: 'eth_chainId' }, { index: 1, method: 'eth_chainId' },
        { index: 1, method: 'anchor', number: ANCHOR.number }, { index: 1, method: 'eth_getTransactionReceipt' }]);
});

test('both endpoints returning403 keep the anchor and defer new network attempts', async t => {
    const f = fixture(t, () => ({ status: 403 }));
    await assert.rejects(f.read(), error => error.code === 'rpc_endpoint_forbidden'
        && error.category === 'transport' && error.httpStatus === 403 && temporaryRpcFailure(error));
    assert.equal(f.calls.length, 2);
    assert.equal(f.pool.active, 0);
    assert.deepEqual(f.pool.anchor, ANCHOR);
    for (let count = 0; count < 10; count++) {
        f.advance(1000);
        await assert.rejects(f.read(), error => error.code === 'rate_limit_wait' && temporaryRpcFailure(error));
    }
    assert.equal(f.calls.length, 2);
    assert.ok(f.coordinator.state('rpc_primary').notBefore > f.coordinator.now());
    assert.ok(f.coordinator.state('rpc_backup').notBefore > f.coordinator.now());
});

test('backup identity errors stay fatal after primary403', async t => {
    for (const fault of ['chain', 'hash', 'number']) await t.test(fault, async t => {
        const f = fixture(t, index => index === 0 ? { status: 403 }
            : fault === 'chain' ? { result: '0x1' } : undefined);
        if (fault !== 'chain') f.pool.providers[1].getBlock = async number => ({
            number: number + (fault === 'number' ? 1 : 0), hash: fault === 'hash' ? HASH : ANCHOR.hash });
        await assert.rejects(f.read(), error => error.code === ({ chain: 'rpc_wrong_chain',
            hash: 'rpc_block_mismatch', number: 'rpc_block_number_mismatch' })[fault] && !temporaryRpcFailure(error));
        assert.equal(f.pool.active, 0);
        assert.deepEqual(f.pool.anchor, ANCHOR);
        assert.equal(f.calls.filter(call => call.index === 1 && call.method === 'eth_getTransactionReceipt').length, 0);
    });
});

test('cold primary403 cannot bootstrap an unanchored backup', async t => {
    const f = fixture(t, index => index === 0 ? { status: 403 } : undefined);
    f.pool.anchor = null;
    await assert.rejects(f.pool.snapshot(), { code: 'rpc_reference_unavailable' });
    assert.deepEqual(f.calls, [{ index: 0, method: 'eth_chainId' }]);
    assert.equal(f.pool.anchor, null);
});

test('only allowlisted live RPC reads remap403; research, writes and other statuses retain rejection', async t => {
    let status = 403, calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status }); });
    const live = new LayaRpcProvider(URLS[0], 12000), research = new RpcProvider(URLS[0]);
    t.after(() => { live.removeAllListeners(); research.removeAllListeners(); });
    for (const method of READ_METHODS) await assert.rejects(live.send(method, []), error =>
        error.code === 'rpc_endpoint_forbidden' && error.category === 'transport'
            && error.httpStatus === 403 && error.retryAfter === 12);
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'unknown_method'])
        await assert.rejects(live.send(method, []), error => error.code === 'http_rejected'
            && error.category === 'api_rejection' && error.httpStatus === 403 && !retryable(error));
    await assert.rejects(research.send('eth_getTransactionReceipt', [HASH]), error => error.code === 'http_rejected'
        && error.category === 'api_rejection' && error.httpStatus === 403 && !retryable(error));
    for (status of [400, 401, 404]) await assert.rejects(live.send('eth_getTransactionReceipt', [HASH]), error =>
        error.code === 'http_rejected' && error.category === 'api_rejection' && error.httpStatus === status);
    assert.equal(calls, READ_METHODS.length + 9);
    assert.equal(retryable(classifyError({ status: 403 })), false);
});

test('live forbidden reads honor a longer Retry-After and the configured endpoint cooldown', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403, headers: { 'Retry-After': '45' } }));
    const coordinator = new ReadCoordinator({ policy: { circuitMs: 12000 } });
    const pool = new LayaRpcPool(URLS, coordinator);
    t.after(() => pool.close());
    assert.equal(pool.providers[0].forbiddenCooldownMs, 12000);
    await assert.rejects(pool.providers[0].send('eth_chainId', []), error => error.code === 'rpc_endpoint_forbidden'
        && error.retryAfter === 45);
});

test('the live client broadcasts once to its persisted validated endpoint without retrying write403', async t => {
    const fixtureKey = `0x${'77'.repeat(32)}`, wallet = `0x${'33'.repeat(20)}`;
    const client = new LayaTradingClient({ rpcUrl: URLS[0], rpcUrls: URLS, privateKey: fixtureKey, wallet });
    t.after(() => client.close());
    assert.ok(client.rpc.providers.every(provider => provider instanceof LayaRpcProvider));
    assert.equal(client.provider instanceof LayaRpcProvider, false);
    const raw = await new ethers.Wallet(fixtureKey).signTransaction({ to: wallet, data: '0x', value: 0,
        chainId: 137, nonce: 11, gasLimit: 500000, type: 2,
        maxFeePerGas: ethers.utils.parseUnits('300', 'gwei'),
        maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei') });
    client.rpc.anchor = { ...ANCHOR };
    client.rpc.providers[1].getBlock = async number => {
        assert.equal(number, ANCHOR.number); return { ...ANCHOR };
    };
    t.mock.method(client.provider, 'sendTransaction', () => assert.fail('The inherited primary write provider must not send'));
    t.mock.method(client.rpc.providers[0], 'send', () => assert.fail('A rejected write must not reach another endpoint'));
    let writes = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, URLS[1]);
        const request = JSON.parse(options.body);
        if (request.method === 'eth_chainId')
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: '0x89' }));
        assert.equal(request.method, 'eth_sendRawTransaction');
        assert.deepEqual(request.params, [raw]);
        writes++; return new Response('', { status: 403 });
    });
    await assert.rejects(client.broadcastAction({ raw, hash: ethers.utils.keccak256(raw), broadcastRpcIndex: 1 }), error =>
        error.code === 'http_rejected' && error.category === 'api_rejection' && error.httpStatus === 403);
    assert.equal(writes, 1);
});
