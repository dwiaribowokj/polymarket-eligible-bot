import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaRpcPool, LayaRpcProvider } from '../../src/laya-live/rpc.js';
import { RpcProvider } from '../../src/restart/rpc.js';
import { ReadCoordinator, retryable } from '../../src/restart/network.js';
import { safeError } from '../../src/laya-live/network.js';

const URLS = ['https://primary.invalid/secret-token', 'https://backup.invalid/secret-token'];
const ANCHOR = { number: 100, hash: `0x${'22'.repeat(32)}` };
const FILTER = { address: `0x${'33'.repeat(20)}`, fromBlock: '0x1', toBlock: '0x64', topics: [] };
const LIMIT = { code: 35, message: 'ranges over 10000 blocks are not supported on free plan' };

function fixture(t, response) {
    let now = 100000;
    const events = [], calls = [];
    const coordinator = new ReadCoordinator({ now: () => now, random: () => 0,
        sleep: async ms => { now += ms; }, onEvent: event => events.push(event) });
    const pool = new LayaRpcPool(URLS, coordinator);
    pool.anchor = { ...ANCHOR }; pool.active = 1; pool.recoveryAt = Infinity;
    for (const [index, provider] of pool.providers.entries()) provider.getBlock = async number => {
        calls.push({ index, method: 'anchor', number }); return { ...ANCHOR, number };
    };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const index = URLS.indexOf(url), request = JSON.parse(options.body);
        calls.push({ index, method: request.method, params: request.params });
        return response(index, request) || new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            result: request.method === 'eth_chainId' ? '0x89' : [] }));
    });
    t.after(() => pool.close());
    return { pool, coordinator, events, calls,
        read: () => pool.read('external_activity_proof', p => p.send('eth_getLogs', [FILTER]), ANCHOR.number) };
}

test('HTTP400 log range rejection on backup falls back to the validated primary with the same filter', async t => {
    const f = fixture(t, (index, request) => index === 1 && request.method === 'eth_getLogs'
        ? new Response(JSON.stringify({ error: { ...LIMIT, message: `${LIMIT.message} secret-token` } }),
            { status: 400, headers: { 'Retry-After': '45' } }) : null);
    assert.deepEqual(await f.read(), []);
    assert.equal(f.pool.active, 0); assert.deepEqual(f.pool.anchor, ANCHOR);
    assert.deepEqual(f.calls, [
        { index: 1, method: 'eth_getLogs', params: [FILTER] },
        { index: 0, method: 'eth_chainId', params: [] },
        { index: 0, method: 'anchor', number: ANCHOR.number },
        { index: 0, method: 'eth_getLogs', params: [FILTER] },
    ]);
    const error = f.events.find(event => event.type === 'rpc_rejection').error;
    assert.equal(error.code, 'rpc_log_range_unavailable'); assert.equal(error.rpcReason, 'log_range_limit');
    assert.equal(error.rpcMethod, 'eth_getLogs'); assert.equal(error.httpStatus, 400);
    assert.equal(error.rpcCode, 35); assert.equal(error.retryAfter, 45);
    assert.ok(f.coordinator.state('rpc_backup').notBefore > f.coordinator.now());
    assert.equal(JSON.stringify(f.events).includes('secret-token'), false);
    assert.equal(JSON.stringify(f.events).includes('ranges over'), false);
});

test('alternate chain and anchor mismatches remain fatal after a log range rejection', async t => {
    for (const fault of ['chain', 'hash', 'number']) await t.test(fault, async t => {
        const f = fixture(t, (index, request) => index === 1
            ? new Response(JSON.stringify({ error: LIMIT }), { status: 400 })
            : fault === 'chain' && request.method === 'eth_chainId'
                ? new Response(JSON.stringify({ result: '0x1' })) : null);
        if (fault !== 'chain') f.pool.providers[0].getBlock = async number => ({
            number: number + (fault === 'number' ? 1 : 0), hash: fault === 'hash' ? `0x${'44'.repeat(32)}` : ANCHOR.hash });
        await assert.rejects(f.read(), { code: ({ chain: 'rpc_wrong_chain', hash: 'rpc_block_mismatch',
            number: 'rpc_block_number_mismatch' })[fault] });
        assert.equal(f.calls.some(call => call.index === 0 && call.method === 'eth_getLogs'), false);
        assert.deepEqual(f.pool.anchor, ANCHOR);
    });
});

test('all endpoints rejecting log ranges defer further reads and never manufacture empty logs', async t => {
    const f = fixture(t, (_, request) => request.method === 'eth_getLogs'
        ? new Response(JSON.stringify({ error: LIMIT }), { status: 400 }) : null);
    await assert.rejects(f.read(), { code: 'rpc_log_range_unavailable' });
    const attempted = f.calls.length;
    await assert.rejects(f.read(), { code: 'rate_limit_wait' });
    assert.equal(f.calls.length, attempted); assert.deepEqual(f.pool.anchor, ANCHOR);
});

test('only the explicit log-range read rejection permits HTTP400 failover', async t => {
    const replies = [
        { error: { code: 35, message: 'other provider problem' } },
        { error: { code: -32602, message: LIMIT.message } },
        { error: { code: 35, message: `invalid params: ${LIMIT.message}` } },
        { error: { code: 35, message: `Unauthorized: ${LIMIT.message}` } },
        { error: { code: 35, message: `execution reverted: ${LIMIT.message}` } },
        { result: [] }, null, '<html>bad request</html>',
    ];
    for (const body of replies) await t.test(JSON.stringify(body), async t => {
        const f = fixture(t, () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 400 }));
        await assert.rejects(f.read(), error => error.code === 'http_rejected' && error.httpStatus === 400 && !retryable(error));
        assert.equal(f.calls.length, 1);
    });
});

test('log range handling preserves HTTP statuses, other methods, writes and research behavior', async t => {
    let status = 400;
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: LIMIT }), { status }));
    const live = new LayaRpcProvider(URLS[0]), research = new RpcProvider(URLS[0]);
    t.after(() => { live.removeAllListeners(); research.removeAllListeners(); });
    for (const method of ['eth_call', 'eth_getTransactionReceipt', 'eth_sendRawTransaction', 'unknown_method'])
        await assert.rejects(live.send(method, []), error => error.code === 'http_rejected' && !retryable(error));
    await assert.rejects(research.send('eth_getLogs', [FILTER]), error => error.code === 'http_rejected' && !retryable(error));
    for (status of [401, 404]) await assert.rejects(live.send('eth_getLogs', [FILTER]),
        error => error.code === 'http_rejected' && error.httpStatus === status && !retryable(error));
    status = 200;
    await assert.rejects(live.send('eth_getLogs', [FILTER]), error => error.code === 'rpc_log_range_unavailable'
        && retryable(error) && safeError(error).rpcReason === 'log_range_limit');
});

test('reading an HTTP400 error body retains the coordinator abort signal', async t => {
    let signal;
    const pool = new LayaRpcPool([URLS[0]], new ReadCoordinator({ policy: { timeoutMs: 20 }, sleep: async () => {} }));
    pool.anchor = { ...ANCHOR }; t.after(() => pool.close());
    t.mock.method(globalThis, 'fetch', async (_, options) => {
        signal = options.signal;
        return { ok: false, status: 400, headers: new Headers(), json: () => new Promise((resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })) };
    });
    await assert.rejects(pool.read('external_activity_proof', p => p.send('eth_getLogs', [FILTER]), ANCHOR.number),
        { code: 'read_timeout' });
    assert.equal(signal.aborted, true);
});
