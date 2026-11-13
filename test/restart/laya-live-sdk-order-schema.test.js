import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { okAsync, errAsync } from '@polymarket/types';
import { fetchOrder, listOpenOrders, listAccountTrades, cancelOrder, listActivity } from '@polymarket/client/actions';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError, classifyError } from '../../src/restart/network.js';

const orderId = '0x' + 'a'.repeat(64), conditionId = '0x' + 'b'.repeat(64);
const transactionHash = '0x' + 'c'.repeat(64), wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
const wireOrder = () => ({ id: orderId, asset_id: '1', market: conditionId, owner: 'account',
    maker_address: wallet, side: 'BUY', price: '0.79', original_size: '5', size_matched: '5',
    outcome: 'Down', order_type: 'FAK', status: 'MATCHED', associate_trades: ['trade'],
    created_at: 1780000000, expiration: '0' });
const wireTrade = status => ({ id: 'trade', asset_id: '1', market: conditionId, owner: 'account',
    maker_address: wallet, taker_order_id: orderId, side: 'BUY', trader_side: 'TAKER',
    price: '0.79', size: '5', outcome: 'Down', status, fee_rate_bps: '0', bucket_index: 0,
    transaction_hash: transactionHash, maker_orders: [], match_time: '1780000000', last_update: '1780000001' });
const page = data => ({ data, count: data.length, limit: 100, next_cursor: 'LTE=' });

function fixture({ order = wireOrder(), trades = [], canceled = [], notCanceled = {} } = {}) {
    const calls = [];
    const secure = { secureClob: {
        get(path, options = {}) {
            calls.push({ method: 'GET', path, params: options.params });
            const body = path === '/data/orders' ? page([]) : path === '/data/trades' ? page(trades) : order;
            return okAsync(new Response(JSON.stringify(body), { status: 200 }));
        },
        del(path) {
            calls.push({ method: 'DELETE', path });
            return okAsync(new Response(JSON.stringify({ canceled, not_canceled: notCanceled }), { status: 200 }));
        },
    } };
    secure.fetchOrder = params => fetchOrder(secure, params);
    secure.listOpenOrders = params => listOpenOrders(secure, params);
    secure.listAccountTrades = params => listAccountTrades(secure, params);
    secure.cancelOrder = params => cancelOrder(secure, params);
    const client = Object.create(LayaTradingClient.prototype);
    client.authenticate = async () => secure;
    return { client, secure, calls };
}

test('live adapter maps SDK prefixed and plain trade statuses to the receipt accounting vocabulary', async () => {
    for (const status of ['MATCHED', 'MATCHED_NOT_BROADCASTED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED']) {
        for (const wireStatus of [status, `TRADE_STATUS_${status}`]) {
            const f = fixture({ trades: [wireTrade(wireStatus)] });
            const sdkPage = await f.secure.listAccountTrades({ market: conditionId }).firstPage();
            assert.equal(sdkPage.items[0].status, `TRADE_STATUS_${status}`);
            const account = await f.client.ordersAndTrades({ conditionId });
            assert.equal(account.trades[0].status, status);
            assert.equal(account.trades[0].takerOrderId, orderId);
            assert.equal(account.trades[0].transactionHash, transactionHash);
            assert.ok(f.calls.filter(call => call.path === '/data/trades').every(call => call.params.get('market') === conditionId));
        }
    }
});

test('optional trade after filter reaches the SDK without narrowing open orders or the default audit', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    for (const market of [null, { conditionId }]) {
        const f = fixture({ trades: [wireTrade('MATCHED')] });
        const account = await f.client.ordersAndTrades(market, { after: '1779999700' });
        assert.equal(account.trades[0].status, 'MATCHED');
        const trades = f.calls.find(call => call.path === '/data/trades');
        const orders = f.calls.find(call => call.path === '/data/orders');
        assert.equal(trades.params.get('after'), '1779999700');
        assert.equal(orders.params.has('after'), false);
        assert.equal(trades.params.get('market'), market?.conditionId ?? null);
        assert.equal(orders.params.get('market'), market?.conditionId ?? null);
    }
    const audit = fixture(); await audit.client.ordersAndTrades();
    assert.ok(audit.calls.every(call => !call.params.has('after') && !call.params.has('market')));
    for (const after of [1779999700, '-1', '01', '1.2', '1780000051', '9007199254740992', null]) {
        const f = fixture();
        await assert.rejects(f.client.ordersAndTrades(null, { after }), { code: 'invalid_account_trade_after' });
        assert.equal(f.calls.length, 0);
    }
});

test('bounded trade queries still exhaust every page and retain after and market on every cursor', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const f = fixture(), calls = [];
    f.secure.secureClob.get = (path, { params }) => {
        calls.push({ path, params });
        const next = params.get('next_cursor');
        const trade = { ...wireTrade(next ? 'MINED' : 'MATCHED'), id: next ? 'second' : 'first' };
        const body = path === '/data/orders' ? page([]) : { ...page([trade]), next_cursor: next ? 'LTE=' : 'cGFnZTI=' };
        return okAsync(new Response(JSON.stringify(body)));
    };
    const account = await f.client.ordersAndTrades({ conditionId }, { after: '1779999700' });
    assert.deepEqual(account.trades.map(row => [row.id, row.status]), [['first', 'MATCHED'], ['second', 'MINED']]);
    const trades = calls.filter(call => call.path === '/data/trades');
    assert.equal(trades.length, 2);
    assert.ok(trades.every(call => call.params.get('after') === '1779999700' && call.params.get('market') === conditionId));
    assert.equal(trades[1].params.get('next_cursor'), 'cGFnZTI=');
});

test('HTTP 200 null is absent-order evidence and cannot prove a fill or cancellation', async () => {
    const f = fixture({ order: null });
    await assert.rejects(f.secure.fetchOrder({ orderId }), error => error.name === 'UnexpectedResponseError');
    assert.deepEqual(await f.client.orderPresence(orderId), { found: false, httpStatus: 200 });
    await assert.rejects(f.client.order(orderId), error => error.code === 'order_lookup_absent'
        && error.category === 'reconciliation');
    await assert.rejects(f.client.cancel(orderId), error => error.code === 'order_lookup_absent');
});

test('single-order lookup retains SDK validation and rejects a mismatched order identity', async () => {
    const f = fixture(), order = await f.client.order(orderId);
    assert.equal(order.id, orderId); assert.equal(order.sizeMatched, '5'); assert.equal(order.assetId, '1');
    const malformed = fixture({ order: { ...wireOrder(), size_matched: null } });
    await assert.rejects(malformed.client.order(orderId), error => error.code === 'invalid_api_data');
    const mismatch = fixture({ order: { ...wireOrder(), id: '0x' + 'd'.repeat(64) } });
    await assert.rejects(mismatch.client.order(orderId), error => error.code === 'order_identity_mismatch');
    const invalid = fixture();
    await assert.rejects(invalid.client.order('not-an-order'), error => error.code === 'invalid_order_id');
    await assert.rejects(invalid.client.cancel('not-an-order'), error => error.code === 'invalid_order_id');
    assert.equal(invalid.calls.length, 0);
});

function brokerFixture(f) {
    const events = [], position = { market: { tokens: ['1', '2'], conditionId, end: Date.now() + 60000 }, openedAt: Date.now(),
        orders: [{ orderId, side: 'BUY', kind: 'taker', tokenId: '1', price: .79, cost: 4.05807,
            index: 0, shares: 5, filled: 5, settled: 0, status: 'unknown', transactions: [] }],
        holdings: [0, 0], bought: [0, 0], receipts: {}, fills: [], actions: [], entryCost: 0, fees: 0 };
    const state = { cash: 20, walletCashDelta: 0, failures: 0, position, stopped: null };
    const store = { state, save() {}, stop(reason) { state.stopped ||= { reason }; },
        event(type, detail) { events.push({ type, ...detail }); } };
    f.client.confirmedBlock = async () => 100;
    const broker = new LayaLiveBroker({ ...BASELINE, wallet }, store, f.client, async () => {});
    return { broker, state, position, events };
}

test('SDK confirmed trade settles from its receipt once through the actual live broker', async () => {
    const f = fixture({ trades: [wireTrade('TRADE_STATUS_CONFIRMED')] }), b = brokerFixture(f);
    const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    const ctf = new ethers.utils.Interface(['event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)']);
    const cash = erc20.encodeEventLog(erc20.getEvent('Transfer'), [wallet, other, 4008060]);
    const shares = ctf.encodeEventLog(ctf.getEvent('TransferSingle'), [other, other, wallet, 1, 5000000]);
    const exchange = new ethers.utils.Interface([
        'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
    ]);
    const fill = exchange.encodeEventLog(exchange.getEvent('OrderFilled'),
        [orderId, wallet, other, 0, '1', 3950000, 5000000, 58060, ethers.constants.HashZero, ethers.constants.HashZero]);
    let receipts = 0;
    f.client.verifiedReceipt = async hash => {
        assert.equal(hash, transactionHash); receipts++;
        return { transactionHash, blockHash: ethers.constants.HashZero, status: 1, confirmations: 2, blockNumber: 99, logs: [
            { address: CONTRACTS.collateralToken, logIndex: 1, ...cash },
            { address: CONTRACTS.conditionalTokens, logIndex: 2, ...shares },
            { address: CONTRACTS.standardExchange, logIndex: 3, ...fill },
        ] };
    };
    await b.broker.reconcile(null, Date.now());
    await b.broker.reconcile(null, Date.now());
    assert.equal(b.state.stopped, null); assert.equal(b.state.cash, 15.99194);
    assert.equal(b.state.walletCashDelta, -4.00806); assert.deepEqual(b.position.holdings, [5, 0]);
    assert.equal(b.position.orders[0].status, 'complete'); assert.equal(b.position.orders[0].settled, 5);
    assert.equal(b.position.fees, 0.05806); assert.equal(b.position.pendingTrades, false);
    assert.equal(b.position.fills.length, 1); assert.equal(receipts, 1);
    assert.equal(b.events.filter(event => event.type === 'fill_settled').length, 1);
});

test('SDK failed trade stops settlement and keeps wallet accounting unchanged', async () => {
    const f = fixture({ trades: [wireTrade('FAILED')] }), b = brokerFixture(f);
    f.client.verifiedReceipt = async () => null;
    f.client.receipt = async () => assert.fail('Failed trades must not settle');
    await b.broker.reconcile(null, Date.now());
    assert.equal(b.state.stopped.reason, 'trade_settlement_failed'); assert.equal(b.state.failures, 1);
    assert.equal(b.state.cash, 20); assert.equal(b.state.walletCashDelta, 0);
    assert.deepEqual(b.position.holdings, [0, 0]); assert.equal(b.position.orders[0].settled, 0);
    assert.equal(b.events.filter(event => event.type === 'trade_settlement_failed').length, 1);
});

test('cancel confirms a terminal order using the live lookup and still rejects open or absent orders', async () => {
    for (const status of ['MATCHED', 'matched', 'CANCELED', 'CANCELLED', 'FILLED', 'EXPIRED', 'UNMATCHED']) {
        const f = fixture({ order: { ...wireOrder(), status }, notCanceled: { [orderId]: 'Order already matched' } });
        await f.client.cancel(orderId);
        assert.deepEqual(f.calls.map(call => call.method), ['DELETE', 'GET']);
    }
    const canceled = fixture({ canceled: [orderId.toUpperCase().replace(/^0X/, '0x')] });
    await canceled.client.cancel(orderId);
    assert.deepEqual(canceled.calls.map(call => call.method), ['DELETE']);
    const open = fixture({ order: { ...wireOrder(), status: 'LIVE' } });
    await assert.rejects(open.client.cancel(orderId), error => error.code === 'cancellation_unconfirmed');
    const absent = fixture({ order: null });
    await assert.rejects(absent.client.cancel(orderId));
});

const wireRedemption = overrides => ({ proxy_wallet: wallet, timestamp: 1780000010, condition_id: conditionId,
    type: 'REDEEM', size: '5', usdc_size: '5', transaction_hash: transactionHash, price: '0',
    token_id: '', side: '', outcome_index: 999, title: 'Market', slug: 'market', event_slug: 'event', ...overrides });

function redemptionFixture(pages) {
    const calls = [], client = Object.create(LayaTradingClient.prototype);
    client.settings = { wallet };
    client.public = { data: { get(path, { params }) {
        calls.push({ path, params });
        const { rows = [], nextCursor = null } = pages[params.get('cursor') || 'first'];
        return okAsync(new Response(JSON.stringify({ data: rows, pagination: {
            limit: 50, offset: 0, has_more: nextCursor !== null, next_cursor: nextCursor,
        } })));
    } } };
    client.public.listActivity = params => listActivity(client.public, params);
    return { client, calls, market: { conditionId, tokens: ['1', '2'] }, since: 1780000000000 };
}

test('redemption candidates use SDK schema, retain filters across pages, coalesce and expire after ten seconds', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const secondHash = '0x' + 'd'.repeat(64);
    const f = redemptionFixture({ first: { rows: [wireRedemption(), wireRedemption(),
        wireRedemption({ timestamp: 1779999999 })], nextCursor: 'second' },
    second: { rows: [wireRedemption({ transaction_hash: secondHash })] } });
    const results = await Promise.all([f.client.listAutoRedemptions(f.market, f.since),
        f.client.listAutoRedemptions(f.market, f.since)]);
    assert.deepEqual(results, [[transactionHash, secondHash], [transactionHash, secondHash]]);
    assert.equal(f.calls.length, 2);
    for (const { path, params } of f.calls) {
        assert.equal(path, '/v2/activity'); assert.equal(params.get('user'), wallet);
        assert.equal(params.get('condition_id'), conditionId); assert.equal(params.get('type'), 'REDEEM');
        assert.equal(params.get('start'), '1780000000'); assert.equal(params.get('limit'), '50');
    }
    assert.equal(f.calls[1].params.get('cursor'), 'second');
    results[0].pop();
    t.mock.timers.setTime(Date.now() + 9999);
    assert.deepEqual(await f.client.listAutoRedemptions(f.market, f.since), [transactionHash, secondHash]);
    assert.equal(f.calls.length, 2);
    t.mock.timers.setTime(Date.now() + 1);
    await f.client.listAutoRedemptions(f.market, f.since);
    assert.equal(f.calls.length, 4);
});

test('redemption candidate reads stop after three pages without fabricating completeness', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const f = redemptionFixture({ first: { rows: [wireRedemption()], nextCursor: 'second' },
        second: { rows: [], nextCursor: 'third' }, third: { rows: [], nextCursor: 'fourth' } });
    assert.deepEqual(await f.client.listAutoRedemptions(f.market, f.since), [transactionHash]);
    assert.equal(f.calls.length, 3);
});

test('an unidentified SDK redemption page rejection retries without caching partial results', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const secondHash = '0x' + 'd'.repeat(64);
    const f = redemptionFixture({ first: { rows: [wireRedemption()], nextCursor: 'second' },
        second: { rows: [wireRedemption({ transaction_hash: secondHash })] } });
    const get = f.client.public.data.get;
    let fail = true;
    f.client.public.data.get = (path, options) => fail && options.params.get('cursor') === 'second'
        ? errAsync(new Error('SDK read rejected')) : get(path, options);
    const reads = await Promise.allSettled([f.client.listAutoRedemptions(f.market, f.since),
        f.client.listAutoRedemptions(f.market, f.since)]);
    for (const read of reads) {
        assert.equal(read.status, 'rejected');
        assert.equal(read.reason.code, 'redemption_activity_unavailable');
        assert.equal(read.reason.category, 'transport');
        assert.equal(read.reason.stage, 'redemption_activity');
        assert.equal(read.reason.endpoint, 'data');
    }
    assert.equal(f.client.redemptionPending.size, 0);
    assert.equal(f.client.redemptionCache.size, 0);
    assert.equal(f.client.redemptionScan, undefined);
    fail = false;
    assert.deepEqual(await f.client.listAutoRedemptions(f.market, f.since), [transactionHash, secondHash]);
    assert.equal(f.client.redemptionScan.complete, true);
    assert.equal(f.calls.filter(call => !call.params.has('cursor')).length, 2);
});

test('redemption read classification preserves SDK validation and known rejection failures', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const errors = [new OperationalError('invalid_redemption_activity'),
        new OperationalError('http_rejected', 'api_rejection', { httpStatus: 403 }),
        new OperationalError('rpc_block_mismatch', 'reconciliation')];
    for (const error of errors) {
        const f = redemptionFixture({});
        f.client.public.data.get = () => errAsync(error);
        await assert.rejects(f.client.listAutoRedemptions(f.market, f.since), actual => actual === error);
        assert.equal(f.client.redemptionCache.size, 0);
    }
    const f = redemptionFixture({ first: { rows: [null] } });
    await assert.rejects(f.client.listAutoRedemptions(f.market, f.since), error =>
        classifyError(error).code === 'invalid_api_data' && classifyError(error).category === 'validation');
    assert.equal(f.client.redemptionCache.size, 0);
});

test('the live broker waits through an unidentified discovery failure without stopping or writing', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const f = redemptionFixture({ first: { rows: [] } }), b = brokerFixture(f);
    Object.assign(b.position, { openedAt: f.since, holdings: [5, 0], payout: [1, 0], pendingTrades: false });
    Object.assign(b.position.orders[0], { settled: 5, status: 'complete', receiptProvenComplete: true });
    b.position.market.end = Date.now() - 1000;
    b.broker.reconcileBlock = 100;
    for (const method of ['prepareAction', 'broadcastAction', 'prepare', 'post'])
        f.client[method] = async () => assert.fail(`Failed discovery must not call ${method}`);
    const get = f.client.public.data.get;
    f.client.public.data.get = () => errAsync(new Error('SDK read rejected'));
    await b.broker.reconcileAutoRedemptions(Date.now());
    assert.equal(b.state.stopped, null);
    assert.equal(b.state.reconciliationFaults, undefined);
    assert.equal(b.position.autoRedeemRetry.nextAt, Date.now() + 5000);
    assert.equal(b.broker.autoRedeemScan, null);
    assert.equal(await b.broker.action('redeem', 0, Date.now()), false);
    assert.equal(b.state.cash, 20); assert.deepEqual(b.position.holdings, [5, 0]);
    assert.deepEqual(b.position.actions, []); assert.deepEqual(b.position.receipts, {});
    f.client.public.data.get = get;
    t.mock.timers.setTime(Date.now() + 5000);
    await b.broker.reconcileAutoRedemptions(Date.now());
    assert.equal(b.state.stopped, null);
    assert.equal(b.position.autoRedeemRetry, undefined);
    assert.equal(b.broker.autoRedeemScan.clear, true);
    assert.equal(b.state.cash, 20); assert.deepEqual(b.position.holdings, [5, 0]);
});

test('malformed redemption data still leaves a persistent broker fault after discovery recovers', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const pages = { first: { rows: [null] } };
    const f = redemptionFixture(pages), b = brokerFixture(f);
    Object.assign(b.position, { openedAt: f.since, holdings: [5, 0], payout: [1, 0], pendingTrades: false });
    b.position.market.end = Date.now() - 1000;
    b.broker.reconcileBlock = 100;
    await b.broker.reconcileAutoRedemptions(Date.now());
    assert.equal(b.state.stopped.reason, 'auto_redeem_unconfirmed');
    assert.equal(b.state.reconciliationFaults.auto_redeem_unconfirmed.count, 1);
    assert.equal(b.events.at(-1).error.code, 'invalid_api_data');
    pages.first.rows = [];
    t.mock.timers.setTime(Date.now() + 5000);
    await b.broker.reconcileAutoRedemptions(Date.now());
    assert.equal(b.broker.autoRedeemScan.clear, true);
    assert.equal(b.state.stopped.reason, 'auto_redeem_unconfirmed');
    assert.equal(b.state.reconciliationFaults.auto_redeem_unconfirmed.count, 1);
    assert.deepEqual(b.position.actions, []);
});

test('redemption query and response identity failures never become receipt candidates or cached success', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1780000050000 });
    const invalid = redemptionFixture({});
    for (const [market, since] of [[{ conditionId: 'invalid', tokens: ['1', '2'] }, invalid.since],
        [{ conditionId, tokens: ['1', '1'] }, invalid.since], [invalid.market, Date.now() + 1],
        [invalid.market, NaN]]) {
        await assert.rejects(invalid.client.listAutoRedemptions(market, since), error => error.code === 'invalid_redemption_query');
    }
    assert.equal(invalid.calls.length, 0);
    for (const mutation of [{ proxy_wallet: other }, { condition_id: '0x' + 'e'.repeat(64) },
        { type: 'MERGE' }, { timestamp: 1780000051 }, { transaction_hash: 'invalid' }]) {
        const pages = { first: { rows: [wireRedemption(mutation)] } }, f = redemptionFixture(pages);
        await assert.rejects(f.client.listAutoRedemptions(f.market, f.since));
        pages.first.rows = [wireRedemption()];
        assert.deepEqual(await f.client.listAutoRedemptions(f.market, f.since), [transactionHash]);
        assert.equal(f.calls.length, 2);
    }
    const repeated = redemptionFixture({ first: { rows: [], nextCursor: 'repeat' }, repeat: { rows: [], nextCursor: 'repeat' } });
    await assert.rejects(repeated.client.listAutoRedemptions(repeated.market, repeated.since),
        error => error.code === 'invalid_redemption_activity');
    assert.equal(repeated.calls.length, 2);
});
