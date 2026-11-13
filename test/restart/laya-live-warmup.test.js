import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureClient } from '@polymarket/client';
import { OrderResponseSchema } from '@polymarket/bindings/clob';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';

const conditionId = `0x${'1'.repeat(64)}`;
const tokens = ['123', '456'];
const spec = { tokenId: tokens[0], side: 'BUY', kind: 'taker', price: .873, shares: 5 };
const marketPayload = () => ({ fd: { r: .25, e: 2 }, mts: .001, nr: false,
    t: [{ t: tokens[0], o: 'Up' }, { t: tokens[1], o: 'Down' }] });

async function sdkFixture(t, initialMarket = marketPayload()) {
    let market = initialMarket;
    const requests = [];
    // These values belong only to this offline fixture. Never load wallet
    // configuration or forward a request to the real network.
    const address = '0x0000000000000000000000000000000000000001';
    const credentials = { key: '00000000-0000-4000-8000-000000000000',
        secret: Buffer.from('offline-warmup-fixture').toString('base64'), passphrase: 'offline-fixture' };
    const forbidden = () => { throw new Error('warmup_must_not_sign_or_submit'); };
    const signer = { getAddress: async () => address, signTypedData: t.mock.fn(forbidden),
        signMessage: t.mock.fn(forbidden), sendTransaction: t.mock.fn(forbidden) };
    t.mock.method(globalThis, 'fetch', async (input, options) => {
        const request = input instanceof Request ? input : new Request(input, options);
        const url = new URL(request.url);
        requests.push({ method: request.method, path: url.pathname });
        assert.equal(request.method, 'GET', 'every fixture request must be read-only');
        assert.equal(url.origin, 'https://clob.polymarket.com');
        if (url.pathname === '/auth/api-keys') return Response.json({ apiKeys: [credentials.key] });
        if (url.pathname === `/markets-by-token/${tokens[0]}` || url.pathname === `/markets-by-token/${tokens[1]}`)
            return Response.json({ condition_id: conditionId });
        if (url.pathname === `/clob-markets/${conditionId}`) return Response.json(market);
        assert.fail('unexpected offline fixture request');
    });
    const secure = await createSecureClient({ wallet: address, signer, credentials });
    assert.equal(secure.isSecureClient(), true);
    assert.deepEqual(requests, [{ method: 'GET', path: '/auth/api-keys' }]);
    const fullPrepare = t.mock.method(secure, 'createLimitOrder', forbidden);
    const post = t.mock.method(secure, 'postOrder', forbidden);
    const rawPost = t.mock.method(secure.secureClob, 'post', forbidden);
    const client = Object.create(LayaTradingClient.prototype);
    client.secure = secure;
    const authenticate = t.mock.method(client, 'authenticate');
    const metadataRequests = () => requests.filter(request => request.path !== '/auth/api-keys');
    const assertReadOnly = () => {
        for (const method of [signer.signTypedData, signer.signMessage, signer.sendTransaction, fullPrepare, post, rawPost])
            assert.equal(method.mock.callCount(), 0);
        assert.ok(requests.every(request => request.method === 'GET'));
        assert.equal(client.secure, secure);
    };
    return { client, secure, authenticate, metadataRequests, assertReadOnly, setMarket(value) { market = value; } };
}

test('metadata warmup uses the authenticated SDK cache without signing, full preparation, or POST', async t => {
    const f = await sdkFixture(t);
    await f.client.warmOrderMetadata(spec);
    assert.deepEqual(f.metadataRequests(), [
        { method: 'GET', path: `/markets-by-token/${tokens[0]}` },
        { method: 'GET', path: `/clob-markets/${conditionId}` },
    ]);
    f.assertReadOnly();
    // Loading one condition seeds both token IDs. The second side must use
    // the same secure SDK object and require no additional metadata reads.
    await f.client.warmOrderMetadata({ ...spec, tokenId: tokens[1], price: .127 });
    assert.equal(f.metadataRequests().length, 2);
    assert.equal(f.authenticate.mock.callCount(), 2);
    for (const call of f.authenticate.mock.calls) assert.equal(await call.result, f.secure);
    f.assertReadOnly();
});

test('invalid SDK metadata rejects warmup without signing or submitting and does not poison the cache', async t => {
    const invalid = [
        ['unsupported tick', { ...marketPayload(), mts: .003 }],
        ['invalid fee data', { ...marketPayload(), fd: { r: 'invalid', e: 2 } }],
        ['asset missing from condition', { ...marketPayload(), t: [{ t: '789', o: 'Other' }] }],
    ];
    for (const [name, payload] of invalid) await t.test(name, async t => {
        const f = await sdkFixture(t, payload);
        await assert.rejects(f.client.warmOrderMetadata(spec), { code: 'invalid_api_data', category: 'validation' });
        assert.equal(f.metadataRequests().length, 2);
        f.assertReadOnly();
        f.setMarket(marketPayload());
        await f.client.warmOrderMetadata(spec);
        assert.ok(f.metadataRequests().length > 2, 'failed metadata must be fetched again');
        const reads = f.metadataRequests().length;
        await f.client.warmOrderMetadata(spec);
        assert.equal(f.metadataRequests().length, reads);
        f.assertReadOnly();
    });
});

test('an unknown normalized API result preserves submission uncertainty and never retries or records rejection', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_broker_fixture'); });
    const now = Date.now(), orderId = `0x${'2'.repeat(64)}`;
    const response = OrderResponseSchema.parse({ success: true, errorMsg: '', orderID: orderId,
        status: 'unexpected_status', makingAmount: '', takingAmount: '', tradeIDs: [], transactionsHashes: [] });
    assert.deepEqual(response, { ok: false, code: 'unknown', message: 'Unknown order failure' });
    const state = { failures: 0, cash: 20, stopped: null,
        position: { orders: [], actions: [], holdings: [0, 0] } };
    const events = [], persisted = [];
    const store = { state, event(type, detail) { events.push({ type, detail }); persisted.push(structuredClone(state)); },
        stop(reason) { state.stopped ||= { at: now, reason }; persisted.push(structuredClone(state)); } };
    const client = { prepare: t.mock.fn(async () => ({ orderId, signed: { fixtureOnly: true } })),
        post: t.mock.fn(async () => {
            const saved = persisted.at(-1).position.orders[0];
            assert.equal(saved.orderId, orderId); assert.equal(saved.status, 'submitting');
            assert.ok(saved.postAttemptAt);
            return response;
        }) };
    const broker = new LayaLiveBroker({}, store, client, async () => {});
    const result = await broker.submit(spec, now);
    assert.equal(result.status, 'unknown');
    assert.equal(state.stopped.reason, 'unknown_order_submission');
    assert.equal(state.failures, 1); assert.equal(state.cash, 20);
    assert.deepEqual(state.position.holdings, [0, 0]);
    assert.ok(events.some(event => event.type === 'submission_uncertain'
        && event.detail.reason === 'unknown_api_order_status'));
    assert.ok(events.every(event => !['order_rejected', 'order_accepted'].includes(event.type)));
    await assert.rejects(broker.submit(spec, now + 1), /duplicate_entry_attempt/);
    const restartedStore = { ...store, state: structuredClone(state) };
    await assert.rejects(new LayaLiveBroker({}, restartedStore, client, async () => {}).submit(spec, now + 2), /duplicate_entry_attempt/);
    assert.equal(client.prepare.mock.callCount(), 1); assert.equal(client.post.mock.callCount(), 1);
});
