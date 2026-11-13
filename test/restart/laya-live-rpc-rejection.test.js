import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaRpcPool, LayaRpcProvider, temporaryRpcFailure } from '../../src/laya-live/rpc.js';
import { RpcProvider } from '../../src/restart/rpc.js';
import { ReadCoordinator, retryable } from '../../src/restart/network.js';
import { safeError } from '../../src/laya-live/network.js';

const URLS = ['https://primary.rpc.invalid/secret-token', 'https://backup.rpc.invalid/secret-token'];
const ANCHOR = { number: 100, hash: `0x${'22'.repeat(32)}` };
const ADDRESS = `0x${'33'.repeat(20)}`;
const ABI = ['function balanceOf(address) view returns (uint256)'];
const BALANCE = ethers.utils.defaultAbiCoder.encode(['uint256'], [11008433]);
const READ_METHODS = ['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_call',
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
        calls.push({ index, method: request.method, params: request.params });
        const reply = respond(index, request.method);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            ...(reply?.error ? { error: reply.error }
                : { result: reply?.result ?? (request.method === 'eth_chainId' ? '0x89' : BALANCE) }) }));
    });
    t.after(() => pool.close());
    return { pool, calls, events, coordinator, advance(ms) { now += ms; },
        read: () => pool.read('wallet_balance', async (provider, blockTag) =>
            new ethers.Contract(ADDRESS, ABI, provider).balanceOf(ADDRESS, { blockTag }), ANCHOR.number) };
}

test('unknown JSON-RPC wallet read rejection fails over through ethers after validating the same block', async t => {
    const f = fixture(t, (index, method) => index === 0 && method === 'eth_call'
        ? { error: { code: -32000, message: 'undocumented rejection secret-token', data: { url: URLS[0] } } } : undefined);
    assert.equal((await f.read()).toString(), '11008433');
    assert.equal(f.pool.active, 1);
    assert.deepEqual(f.pool.anchor, ANCHOR);
    const backupCalls = f.calls.filter(call => call.index === 1);
    assert.equal(backupCalls[0].method, 'eth_chainId');
    assert.deepEqual(backupCalls[1], { index: 1, method: 'anchor', number: ANCHOR.number });
    assert.equal(backupCalls.at(-1).method, 'eth_call');
    assert.equal(backupCalls.at(-1).params[1], '0x64');
    const failure = f.events.find(event => event.type === 'rpc_rejection');
    assert.deepEqual(failure.error, { name: 'OperationalError', code: 'rpc_read_rejected', category: 'transport',
        stage: 'wallet_balance', endpoint: 'rpc_primary',
        rpcCode: -32000, rpcMethod: 'eth_call', rpcReason: 'unknown' });
    assert.equal(JSON.stringify(f.events).includes('secret-token'), false);
    assert.equal(JSON.stringify(f.events).includes('undocumented rejection'), false);
});

test('repeated rejected reads open circuits and retain the anchor without accepting an unread balance', async t => {
    const f = fixture(t, () => ({ error: { code: -32603, message: 'Internal error' } }));
    const read = () => f.pool.read('wallet_balance', provider => provider.send('eth_call', []), ANCHOR.number);
    for (let count = 0; count < 3; count++)
        await assert.rejects(read(), error => error.code === 'rpc_read_rejected'
            && error.rpcReason === 'internal_error' && temporaryRpcFailure(error));
    const attempted = f.calls.length;
    assert.equal(attempted, 6);
    for (let count = 0; count < 5; count++)
        await assert.rejects(read(), error => error.code === 'circuit_open' && temporaryRpcFailure(error));
    assert.equal(f.calls.length, attempted);
    assert.equal(f.pool.active, 0);
    assert.deepEqual(f.pool.anchor, ANCHOR);
});

test('backup identities and missing initial anchor stay strict for JSON-RPC rejected reads', async t => {
    for (const fault of ['chain', 'hash', 'number', 'cold']) await t.test(fault, async t => {
        const f = fixture(t, index => index === 0 ? { error: { code: -32603, message: 'Internal error' } }
            : fault === 'chain' ? { result: '0x1' } : undefined);
        if (fault === 'cold') f.pool.anchor = null;
        if (['hash', 'number'].includes(fault)) f.pool.providers[1].getBlock = async number => ({
            number: number + (fault === 'number' ? 1 : 0), hash: fault === 'hash' ? `0x${'44'.repeat(32)}` : ANCHOR.hash });
        await assert.rejects(f.read(), { code: ({ chain: 'rpc_wrong_chain', hash: 'rpc_block_mismatch',
            number: 'rpc_block_number_mismatch', cold: 'rpc_reference_unavailable' })[fault] });
        assert.equal(f.calls.some(call => call.index === 1 && call.method === 'eth_call'), false);
        assert.equal(f.pool.active, 0);
    });
});

const PERMANENT = [
    [{ code: 3, message: 'execution reverted' }, 'contract', 'execution_reverted'],
    [{ code: -32603, message: 'execution reverted: rate limit' }, 'contract', 'execution_reverted'],
    [{ code: -32000, message: 'VM Exception while processing transaction: invalid opcode' }, 'contract', 'execution_reverted'],
    [{ code: -32603, message: 'Internal error', data: '0xdeadbeef' }, 'contract', 'execution_reverted'],
    [{ code: -32603, message: 'Internal error', data: { originalError: { code: 3, message: 'execution reverted' } } }, 'contract', 'execution_reverted'],
    [{ code: -32700, message: 'Parse error' }, 'validation', 'invalid_request'],
    [{ code: -32600, message: 'Invalid Request' }, 'validation', 'invalid_request'],
    [{ code: -32602, message: 'Invalid params' }, 'validation', 'invalid_params'],
    [{ code: -32000, message: 'invalid argument 0: malformed address' }, 'validation', 'invalid_params'],
    [{ code: -32601, message: 'Method not found' }, 'validation', 'method_unavailable'],
    [{ code: -32000, message: 'unsupported method' }, 'validation', 'method_unavailable'],
    [{ code: -32000, message: 'Unauthorized: invalid API key' }, 'api_rejection', 'authentication'],
    [{ code: -32603, message: 'access denied' }, 'api_rejection', 'authentication'],
];

test('explicit contract, request and authorization rejections never fail over or become retryable', async t => {
    for (const [error, category, rpcReason] of PERMANENT) await t.test(`${rpcReason}: ${error.message}`, async t => {
        const f = fixture(t, (index, method) => method === 'eth_call' ? { error } : undefined);
        await assert.rejects(f.read(), actual => actual.code === 'rpc_rejected' && actual.category === category
            && actual.rpcReason === rpcReason && actual.rpcMethod === 'eth_call' && !retryable(actual)
            && !temporaryRpcFailure(actual));
        assert.equal(f.calls.filter(call => call.method === 'eth_call').length, 1);
        assert.equal(f.calls.some(call => call.index === 1), false);
        assert.equal(f.coordinator.state('rpc_primary').streak, 0);
    });
});

test('known provider read failures have safe specific reasons and unknown failures remain bounded reads', async t => {
    const errors = [
        [{ code: -32005, message: 'limit exceeded' }, 'rate_limited', 'rate_limit'],
        [{ code: 429, message: 'slow down' }, 'rate_limited', 'rate_limit'],
        [{ code: -32000, message: 'rate limit exceeded' }, 'rate_limited', 'rate_limit'],
        [{ code: -32000, message: 'header not found' }, 'rpc_read_rejected', 'block_unavailable'],
        [{ code: -32000, message: 'missing trie node' }, 'rpc_read_rejected', 'block_unavailable'],
        [{ code: -32000, message: 'state unavailable' }, 'rpc_read_rejected', 'block_unavailable'],
        [{ code: -32002, message: 'resource unavailable' }, 'rpc_read_rejected', 'upstream_unavailable'],
        [{ code: -32000, message: 'upstream timeout' }, 'rpc_read_rejected', 'upstream_unavailable'],
        [{ code: -32603, message: 'Internal error' }, 'rpc_read_rejected', 'internal_error'],
        [{ code: -32099, message: 'not documented' }, 'rpc_read_rejected', 'unknown'],
        [{ code: 'secret-token', message: 'not documented' }, 'rpc_read_rejected', 'unknown'],
    ];
    let response;
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: response })));
    const provider = new LayaRpcProvider(URLS[0]);
    t.after(() => provider.removeAllListeners());
    for (const [error, code, rpcReason] of errors) {
        response = error;
        await assert.rejects(provider.send('eth_call', []), actual => {
            assert.equal(actual.code, code); assert.equal(actual.rpcReason, rpcReason);
            assert.equal(retryable(actual), true);
            assert.equal(actual.rpcCode, Number.isSafeInteger(error.code) ? error.code : undefined);
            assert.equal(JSON.stringify(safeError(actual)).includes('secret-token'), false);
            assert.equal(Object.hasOwn(actual, 'data'), false);
            return true;
        });
    }
});

test('only allowlisted live read methods gain rejection recovery; research and writes preserve their behavior', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        error: { code: -32603, message: 'Internal error secret-token', data: { url: URLS[0] } } })));
    const live = new LayaRpcProvider(URLS[0]), research = new RpcProvider(URLS[0]);
    t.after(() => { live.removeAllListeners(); research.removeAllListeners(); });
    for (const method of READ_METHODS) await assert.rejects(live.send(method, []), error =>
        error.code === 'rpc_read_rejected' && error.category === 'transport' && error.rpcMethod === method
            && error.rpcCode === -32603 && error.rpcReason === 'internal_error');
    for (const method of ['eth_sendRawTransaction', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'unknown_method'])
        await assert.rejects(live.send(method, []), error => error.code === 'rpc_rejected'
            && error.category === 'contract' && !retryable(error) && error.rpcMethod === undefined);
    await assert.rejects(research.send('eth_call', []), error => error.code === 'rpc_rejected'
        && error.category === 'contract' && !retryable(error) && error.rpcCode === undefined);
});

test('live provider foreground fetch uses the coordinator timeout signal', async t => {
    let fetchSignal;
    const coordinator = new ReadCoordinator({ policy: { timeoutMs: 20 }, sleep: async () => {} });
    const pool = new LayaRpcPool([URLS[0]], coordinator);
    pool.anchor = { ...ANCHOR };
    t.after(() => pool.close());
    t.mock.method(globalThis, 'fetch', (url, options) => {
        fetchSignal = options.signal;
        return new Promise((resolve, reject) => fetchSignal.addEventListener('abort', () => reject(fetchSignal.reason), { once: true }));
    });
    await assert.rejects(pool.read('wallet_balance', provider => provider.send('eth_call', []), ANCHOR.number),
        { code: 'read_timeout' });
    assert.ok(fetchSignal instanceof AbortSignal);
    assert.equal(fetchSignal.aborted, true);
});

test('closing a primary probe aborts the live provider fetch and prevents late promotion', async t => {
    let fetchSignal, resolveFetch, started;
    const fetched = new Promise(resolve => { started = resolve; });
    const response = new Promise(resolve => { resolveFetch = resolve; });
    const coordinator = new ReadCoordinator({ sleep: async () => {} });
    const pool = new LayaRpcPool(URLS, coordinator);
    pool.anchor = { ...ANCHOR }; pool.active = 1;
    t.after(() => pool.close());
    t.mock.method(globalThis, 'fetch', (url, options) => {
        assert.equal(url, URLS[0]); fetchSignal = options.signal; started(); return response;
    });
    let blockReads = 0;
    pool.providers[0].getBlock = async () => { blockReads++; return { ...ANCHOR }; };
    pool.probePrimary();
    const pending = pool.primaryRecoveryPending;
    await fetched;
    assert.ok(fetchSignal instanceof AbortSignal);
    assert.equal(fetchSignal.aborted, false);
    pool.close();
    assert.equal(fetchSignal.aborted, true);
    resolveFetch(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x89' })));
    await pending;
    assert.equal(pool.active, 1);
    assert.equal(pool.recoveredPrimary, null);
    assert.equal(blockReads, 0);
});
