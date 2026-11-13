import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError } from '../../src/restart/network.js';

const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
const fillHash = '0x' + 'a'.repeat(64), redeemHash = '0x' + 'b'.repeat(64);
const blockHash = '0x' + 'c'.repeat(64), orderId = '0x' + 'd'.repeat(64), conditionId = '0x' + 'e'.repeat(64);
const zero = ethers.constants.AddressZero, zeroHash = ethers.constants.HashZero;
const operator = CONTRACTS.autoRedeemOperator, collateral = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const log = (iface, event, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(event), args) });
const cash = (from, to, amount, index) => log(erc20, 'Transfer', CONTRACTS.collateralToken, [from, to, amount], index);
const token = (from, to, id, amount, index, by = other) => log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens,
    [by, from, to, id, amount], index);
function fillReceipt(shares = 5000000, principal = 3950000, fee = 58060, hash = fillHash, ownedOrderId = orderId) {
    return { transactionHash: hash, blockHash, status: 1, confirmations: 3, blockNumber: 99,
        logs: [cash(wallet, other, principal + fee, 10), token(other, wallet, '2', shares, 11),
            log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                [ownedOrderId, wallet, other, 0, '2', principal, shares, fee, zeroHash, zeroHash], 12)] };
}
function redeemReceipt(shares = 5000000) {
    return { transactionHash: redeemHash, blockHash, status: 1, confirmations: 3, blockNumber: 100,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, shares]], 10),
            token(operator, zero, '2', shares, 11, operator),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, collateral, zeroHash, conditionId, [1, 2], shares], 13), cash(zero, wallet, shares, 16)] };
}
function fixture({ stopped = null, now = 1780000300000, openedAt = now - 180000, receipt = fillReceipt(), autoRedeem = false } = {}) {
    const calls = { orders: 0, single: 0, cancel: 0, receipts: [], payout: 0, auto: 0 }, events = [];
    const order = { orderId, tokenId: '2', side: 'BUY', kind: 'taker', index: 1, price: .79, shares: 5,
        settled: 0, filled: 5, cost: 4.05807, status: 'accepted', transactions: [fillHash],
        submittedAt: openedAt, postAttemptAt: openedAt };
    const position = { market: { tokens: ['1', '2'], conditionId, negRisk: false, end: now - 1000 }, openedAt,
        orders: [order], holdings: [0, 0], bought: [0, 0], receipts: {}, fills: [], actions: [],
        entryCost: 0, fees: 0, payout: null, pendingTrades: true, pendingSince: openedAt };
    const state = { cash: 22.270941, walletStart: 22.270941, walletCashDelta: 0, failures: 0, position, stopped,
        externalWalletActivity: { cashDelta: -1.447987, receipts: [{ hash: 'manual', cash: -1.447987 }] } };
    const store = { state, save() {}, stop(reason) { state.stopped ||= { reason, at: now }; },
        event(type, detail) { events.push({ type, ...detail, savedEvidence: structuredClone(state.settlementEvidence || {}) }); } };
    const client = {
        confirmedBlock: async () => 100,
        ordersAndTrades: async () => { calls.orders++; return { orders: [], trades: [] }; },
        order: async () => { calls.single++; throw new OperationalError('order_lookup_absent', 'reconciliation'); },
        cancel: async () => { calls.cancel++; throw new OperationalError('order_lookup_absent', 'reconciliation'); },
        verifiedReceipt: async (hash, block) => { assert.equal(block, 100); calls.receipts.push(hash);
            return hash === fillHash ? receipt : hash === redeemHash ? redeemReceipt() : null; },
        payoutAtBlock: async (condition, block) => { calls.payout++; assert.equal(condition, conditionId); assert.equal(block, 100); return [0, 1]; },
        listAutoRedemptions: async () => { calls.auto++; return autoRedeem ? [redeemHash] : []; },
        redemptionScan: { complete: true, key: JSON.stringify([wallet, conditionId, ['1', '2'], openedAt]) },
        balance: async block => { assert.equal(block, 100); return autoRedeem ? 21.814894 : 16.814894; },
        holdings: async (tokens, block) => { assert.equal(block, 100); return autoRedeem ? [0, 0] : [0, 5]; },
        prepare: async () => assert.fail('Reconciliation must not prepare orders'),
        post: async () => assert.fail('Reconciliation must not submit orders'),
        prepareAction: async () => assert.fail('Protocol redemption must not prepare transactions'),
        broadcastAction: async () => assert.fail('Protocol redemption must not broadcast transactions'),
    };
    return { now, state, position, order, store, client, calls, events,
        broker: new LayaLiveBroker({ ...BASELINE, wallet }, store, client, async () => {}) };
}

function improvedFixture(options = {}) {
    const { limitPrice = .75, signedMakerAmount = '3750000', reserve = 3.86563, ...fixtureOptions } = options;
    const f = fixture({ openedAt: 1780000299000, receipt: null, ...fixtureOptions });
    Object.assign(f.order, { price: limitPrice, cost: reserve, filled: 0, apiSubmissionStatus: 'matched' });
    const signed = { salt: '1', maker: wallet, signer: wallet, tokenId: '2', makerAmount: signedMakerAmount,
        takerAmount: '5000000', side: 'BUY', signatureType: 2, timestamp: '1780000299000',
        metadata: zeroHash, builder: zeroHash, expiration: 0, orderType: 'FAK' };
    const types = { Order: [['salt', 'uint256'], ['maker', 'address'], ['signer', 'address'], ['tokenId', 'uint256'],
        ['makerAmount', 'uint256'], ['takerAmount', 'uint256'], ['side', 'uint8'], ['signatureType', 'uint8'],
        ['timestamp', 'uint256'], ['metadata', 'bytes32'], ['builder', 'bytes32']].map(([name, type]) => ({ name, type })) };
    f.order.signed = signed;
    f.order.orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2',
        chainId: 137, verifyingContract: CONTRACTS.standardExchange }, types, { ...signed, side: 0 });
    f.trade = { id: 'improved-fill', conditionId, assetId: '2', side: 'BUY', traderSide: 'TAKER',
        takerOrderId: f.order.orderId, size: '5.136985', price: '.73', status: 'CONFIRMED', transactionHash: fillHash };
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade] });
    f.client.verifiedReceipt = async (hash, block) => {
        assert.equal(block, 100); f.calls.receipts.push(hash);
        return hash === fillHash ? fillReceipt(5136985, 3749999, 70870, fillHash, f.order.orderId)
            : hash === redeemHash ? redeemReceipt(5136985) : null;
    };
    return f;
}

function headlineFixture(options = {}) {
    const f = improvedFixture({ limitPrice: .82, signedMakerAmount: '4100000', reserve: 4.20166, ...options });
    Object.assign(f.trade, { size: '5.009266', price: '.82', makerOrders: [
        { orderId: '0x' + '3'.repeat(64), assetId: '1', side: 'BUY', matchedAmount: '.76', price: '.19' },
        { orderId: '0x' + '4'.repeat(64), assetId: '1', side: 'BUY', matchedAmount: '4.249266', price: '.1800000282401714' },
    ] });
    f.client.verifiedReceipt = async (hash, block) => {
        assert.equal(block, 100); f.calls.receipts.push(hash);
        return hash === fillHash ? fillReceipt(5009266, 4099998, 52090, fillHash, f.order.orderId)
            : hash === redeemHash ? redeemReceipt(5009266) : null;
    };
    return f;
}

test('signed FAK headline limit price does not reject a receipt-proven improved fill and auto redemption', async () => {
    const f = headlineFixture({ autoRedeem: true });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.stopped, null); assert.equal(f.position.uncertain, undefined);
    assert.equal(f.order.shares, 5); assert.equal(f.order.settled, 5.009266);
    assert.equal(f.order.settledPrincipal, 4.099998); assert.equal(f.position.entryCost, 4.152088);
    assert.equal(f.state.cash, 23.128119); assert.deepEqual(f.position.holdings, [0, 0]);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.position.pendingTrades, false);
    assert.deepEqual(f.position.fills[0].tradeIds, ['improved-fill']);
    assert.deepEqual(f.order.matchedTrades['trade:improved-fill'], { id: 'improved-fill', shares: 5.009266, price: .82 });
    const before = structuredClone(f.state);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.deepEqual(f.state, before); assert.deepEqual(f.calls.receipts, [fillHash, redeemHash]);
});

test('a headline estimate exceeding the signed cash cap remains pending until a receipt proves actual cost', async () => {
    const f = headlineFixture(), readReceipt = f.client.verifiedReceipt;
    f.order.transactions = [];
    f.client.verifiedReceipt = async () => null;
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.cash, 22.270941); assert.equal(f.order.settled, 0);
    assert.equal(f.state.settlementEvidence, undefined); assert.equal(f.state.stopped, null);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.reconciliationComplete, false);
    assert.equal(f.order.receiptProvenComplete, undefined);
    assert.deepEqual(f.order.transactions, [fillHash]);
    f.client.verifiedReceipt = readReceipt;
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.settledPrincipal, 4.099998); assert.equal(f.order.receiptProvenComplete, true);
    assert.equal(f.position.pendingTrades, false); assert.equal(f.state.cash, 18.118853);
});

test('headline-priced rows link only when their complete quantity matches the same receipt', async () => {
    const f = headlineFixture();
    const first = { ...f.trade, id: 'first-leg', size: '.76' }, second = { ...f.trade, id: 'second-leg', size: '4.249266' };
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [first] });
    f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: '5.009266' });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 5.009266); assert.deepEqual(f.position.fills[0].tradeIds, []);
    assert.equal(f.order.receiptProvenComplete, undefined); assert.equal(f.position.pendingTrades, true);
    const cashAfterReceipt = f.state.cash;
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [first, second] });
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.state.cash, cashAfterReceipt); assert.equal(f.order.settledPrincipal, 4.099998);
    assert.deepEqual(f.position.fills[0].tradeIds, ['first-leg', 'second-leg']);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.position.pendingTrades, false);
});

test('duplicate and conflicting API trade IDs cannot complete a receipt twice or erase outstanding quantity', async () => {
    for (const conflicting of [false, true]) {
        const f = headlineFixture();
        f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade,
            { ...f.trade, size: conflicting ? '6' : f.trade.size }] });
        await f.broker.reconcile(null, f.now);
        assert.equal(f.state.cash, 18.118853); assert.equal(f.position.fills.length, 1);
        assert.deepEqual(f.position.fills[0].tradeIds, []);
        assert.equal(f.position.pendingTrades, true); assert.notEqual(f.order.receiptProvenComplete, true);
        f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade] });
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, f.now + 1000);
        assert.equal(f.state.cash, 18.118853); assert.equal(f.position.fills.length, 1);
        assert.equal(f.position.pendingTrades, conflicting);
        assert.equal(f.order.receiptProvenComplete === true, !conflicting);
        assert.equal(f.order.filled, conflicting ? 6 : 5.009266);
    }
});

test('API quantities with inflated individual or total headline estimates cannot settle without receipts', async () => {
    for (const split of [false, true]) {
        const f = headlineFixture();
        const trades = split ? [{ ...f.trade, id: 'one', size: '3' }, { ...f.trade, id: 'two', size: '3' }]
            : [{ ...f.trade, size: '6' }];
        f.client.ordersAndTrades = async () => ({ orders: [], trades });
        f.client.verifiedReceipt = async () => null;
        f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: '6' });
        await f.broker.reconcile(null, f.now);
        assert.equal(f.state.stopped, null); assert.equal(f.order.filled, 6); assert.equal(f.order.settled, 0);
        assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.reconciliationComplete, false);
        assert.equal(f.state.cash, 22.270941); assert.equal(f.state.settlementEvidence, undefined);
        await f.broker.reconcile(null, f.now + 120001);
        assert.equal(f.state.stopped.reason, 'fill_settlement_timeout');
        assert.equal(f.order.settled, 0); assert.equal(f.state.cash, 22.270941);
    }
});

test('headline-priced partial fills reconcile across receipts without inferring cumulative principal from API prices', async () => {
    const f = headlineFixture(), secondHash = '0x' + '9'.repeat(64);
    const first = { ...f.trade, id: 'first-fill', size: '.76', status: 'MINED' };
    const second = { ...f.trade, id: 'second-fill', size: '4.249266', transactionHash: secondHash };
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [first] });
    f.client.verifiedReceipt = async hash => hash === fillHash
        ? fillReceipt(760000, 615600, 10000, fillHash, f.order.orderId)
        : fillReceipt(4249266, 3484398, 42090, secondHash, f.order.orderId);
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, .76); assert.equal(f.position.pendingTrades, true);
    assert.deepEqual(f.position.fills[0].tradeIds, ['first-fill']);
    first.status = 'CONFIRMED';
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [first, second] });
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.state.stopped, null); assert.equal(f.order.settledPrincipal, 4.099998);
    assert.equal(f.order.settled, 5.009266); assert.equal(f.position.entryCost, 4.152088);
    assert.deepEqual(f.position.fills.map(fill => fill.tradeIds), [['first-fill'], ['second-fill']]);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.position.pendingTrades, false);
});

test('a plausible headline cannot authorize receipts exceeding signed principal, execution price, or entry cap', async () => {
    for (const fault of ['principal', 'price', 'entry_cap']) {
        const f = headlineFixture();
        const shares = fault === 'price' ? 4900000 : 5009266;
        const principal = fault === 'principal' ? 4100001 : 4099998;
        const fees = fault === 'entry_cap' ? 900003 : 52090;
        f.client.verifiedReceipt = async () => fillReceipt(shares, principal, fees, fillHash, f.order.orderId);
        f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: f.trade.size });
        await f.broker.reconcile(null, f.now);
        assert.equal(f.order.settled, 0, fault); assert.equal(f.state.cash, 22.270941, fault);
        assert.equal(f.state.settlementEvidence, undefined, fault);
        assert.equal(f.position.pendingTrades, true, fault); assert.notEqual(f.order.receiptProvenComplete, true, fault);
        await f.broker.reconcile(null, f.now + 60001);
        assert.equal(f.state.stopped.reason, 'trade_receipt_mapping_mismatch', fault);
        assert.equal(f.position.uncertain, true, fault);
    }
});

test('temporary account reads hold entries while receipts reconcile and a fresh snapshot recovers', async () => {
    const f = improvedFixture(), account = f.client.ordersAndTrades;
    f.client.ordersAndTrades = async () => { throw new OperationalError('read_timeout', 'timeout'); };
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.reconciliationFaults?.account_status_unknown, undefined);
    assert.equal(f.state.entryHolds.broker_account.retryable, true);
    assert.equal(f.broker.reconciliationComplete, false);
    assert.equal(f.order.settled, 5.136985, 'known receipt still accounted exactly once');
    const cash = f.state.cash;
    f.client.ordersAndTrades = account;
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 3000);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.broker_account, undefined);
    assert.equal(f.broker.reconciliationComplete, true);
    assert.equal(f.state.cash, cash);
    assert.equal(f.order.receiptProvenComplete, true);
});

test('temporary owned-order lookup never becomes a permanent stop or a resubmission', async () => {
    const f = improvedFixture();
    f.order.transactions = []; f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    f.client.verifiedReceipt = async () => null;
    f.client.order = async () => { throw new OperationalError('http_server_error', 'transport'); };
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.broker_order.retryable, true);
    assert.equal(f.broker.reconciliationComplete, false);
    assert.equal(f.position.orders.length, 1);
    assert.equal(f.order.settled, 0);
});

test('improved-price signed FAK accounts actual shares and auto redemption without changing the target or original stop', async () => {
    const stop = { reason: 'invalid_owned_trade', at: 1 }, f = improvedFixture({ stopped: stop, autoRedeem: true });
    Object.assign(f.order, { status: 'cancelled', cancelConfirmedAt: f.now - 10, cancelSettled: false });
    f.position.uncertain = true;
    f.client.balance = async () => 22.13907; f.client.holdings = async () => [0, 0];
    await f.broker.reconcile(null, f.now);
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(f.order.shares, 5); assert.equal(f.order.filled, 5.136985); assert.equal(f.order.settled, 5.136985);
    assert.equal(f.order.settledPrincipal, 3.749999); assert.equal(f.position.fees, .07087);
    assert.equal(f.position.entryCost, 3.820869); assert.equal(f.state.cash, 23.587057);
    assert.deepEqual(f.position.holdings, [0, 0]); assert.deepEqual(f.position.bought, [0, 5.136985]);
    assert.equal(f.order.status, 'cancelled'); assert.equal(f.order.cancelSettled, true);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.order.receiptTerminal.source, 'cancelled_confirmed_trades');
    assert.equal(f.position.pendingTrades, false); assert.equal(f.position.uncertain, true); assert.deepEqual(f.state.stopped, stop);
    assert.deepEqual(f.order.signedAmounts, { makerAmount: '3750000', takerAmount: '5000000', principalBefore: '0',
        principalAfter: '3749999', feeBefore: '0', feeAfter: '70870', quantityBefore: '0', quantityAfter: '5136985', remainingPrincipal: '1' });
    const evidence = f.state.settlementEvidence[fillHash];
    assert.equal(evidence.principal, 3.749999); assert.equal(evidence.shares, 5.136985); assert.equal(evidence.requestedShares, 5);
    assert.deepEqual(evidence.signedAmounts, f.order.signedAmounts);
    assert.deepEqual(f.order.shareQuantityDeviation, { requestedShares: 5, actualShares: 5.136985,
        excessShares: .136985, source: 'receipt' });
    assert.equal(f.events.filter(event => event.type === 'order_share_quantity_deviation').length, 1);
    assert.deepEqual(f.position.fills[0].tradeIds, ['improved-fill']); assert.equal(f.calls.single, 0);
    const before = structuredClone(f.state);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000); await f.broker.cancelOwned();
    assert.deepEqual(f.state, before); assert.deepEqual(f.calls.receipts, [fillHash, redeemHash]); assert.equal(f.calls.cancel, 0);
});

test('an improved-price API trade persists actual matched quantity before receipt reads without booking money', async () => {
    const f = improvedFixture(); f.order.transactions = [];
    let saved;
    f.store.save = () => { saved = structuredClone(f.state); };
    f.client.verifiedReceipt = async () => {
        assert.equal(saved.position.orders[0].filled, 5.136985);
        assert.deepEqual(saved.position.orders[0].matchedTrades['trade:improved-fill'],
            { id: 'improved-fill', shares: 5.136985, price: .73 });
        assert.deepEqual(saved.position.orders[0].transactions, [fillHash]);
        return null;
    };
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.shares, 5); assert.equal(f.order.settled, 0); assert.equal(f.state.cash, 22.270941);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.state.stopped, null); assert.equal(f.position.uncertain, undefined);
    assert.equal(f.state.settlementEvidence, undefined);
});

test('five settled shares of a known 5.136985-share signed FAK stay pending through restart', async () => {
    const f = improvedFixture();
    f.client.verifiedReceipt = async () => fillReceipt(5000000, 3650000, 68000, fillHash, f.order.orderId);
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 5); assert.equal(f.order.filled, 5.136985); assert.equal(f.order.settledPrincipal, 3.65);
    assert.equal(f.order.receiptProvenComplete, undefined); assert.equal(f.position.pendingTrades, true);
    assert.deepEqual(f.position.fills[0].tradeIds, [], 'An API quantity exceeding this receipt cannot be assigned to its proof');
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.settled, 5); assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
});

test('a signed MINED partial receipt cannot finish against a lagging terminal-zero API row', async () => {
    const f = improvedFixture(); Object.assign(f.trade, { size: '2', status: 'MINED' });
    f.client.verifiedReceipt = async () => fillReceipt(2000000, 1460000, 27000, fillHash, f.order.orderId);
    f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: '0' });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 2); assert.equal(f.order.receiptProvenComplete, undefined);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true); assert.equal(f.state.stopped, null);
});

test('receipt-first API lag safely attaches late owned trade IDs after restart without rebooking', async () => {
    const f = improvedFixture(); f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 5.136985); assert.equal(f.position.pendingTrades, true);
    assert.deepEqual(f.position.fills[0].tradeIds, []); assert.equal(f.order.receiptProvenComplete, undefined);
    const cashAfterReceipt = f.state.cash;
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade] });
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.state.cash, cashAfterReceipt); assert.deepEqual(f.calls.receipts, [fillHash]);
    assert.deepEqual(f.position.fills[0].tradeIds, ['improved-fill']); assert.equal(f.order.receiptProvenComplete, true);
    assert.equal(f.order.receiptTerminal.source, 'fak_matched_confirmed_trades'); assert.equal(f.position.pendingTrades, false);
});

test('an improved-price order quantity arriving before trades remains a pending hint without a false invalid-fill stop', async () => {
    const f = improvedFixture(); f.order.transactions = [];
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: '5.136985' });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.filled, 5.136985); assert.equal(f.order.settled, 0); assert.equal(f.position.pendingTrades, true);
    assert.deepEqual(f.order.apiMatchedQuantity, { shares: 5.136985, source: 'order_lookup' });
    assert.equal(f.state.stopped, null); assert.equal(f.position.uncertain, undefined); assert.equal(f.state.settlementEvidence, undefined);
});

test('signed FAK receipt principal caps apply cumulatively even when each receipt fits the reservation', async () => {
    const secondHash = '0x' + '9'.repeat(64), f = improvedFixture();
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    f.client.verifiedReceipt = async hash => hash === fillHash
        ? fillReceipt(5000000, 3650000, 68000, fillHash, f.order.orderId)
        : fillReceipt(200000, 100001, 1000, secondHash, f.order.orderId);
    await f.broker.reconcile(null, f.now);
    f.order.transactions.push(secondHash);
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.settledPrincipal, 3.65); assert.equal(f.order.settled, 5);
    assert.equal(f.state.cash, 18.552941); assert.equal(f.state.settlementEvidence[secondHash], undefined);
    assert.equal(f.position.pendingTrades, true);
});

test('malformed API quantities, identities, prices, and signed bindings remain permanent reconciliation faults', async () => {
    for (const fault of ['zero', 'precision', 'limit', 'binding', 'condition', 'asset', 'side', 'trader_side', 'id']) {
        const f = improvedFixture(); f.order.transactions = [];
        if (fault === 'zero') f.trade.size = '0';
        if (fault === 'precision') f.trade.size = '5.0000001';
        if (fault === 'limit') f.trade.price = '.76';
        if (fault === 'binding') f.order.signed.makerAmount = '3750001';
        if (fault === 'condition') f.trade.conditionId = zeroHash;
        if (fault === 'asset') f.trade.assetId = '1';
        if (fault === 'side') f.trade.side = 'SELL';
        if (fault === 'id') f.trade.id = '';
        if (fault === 'trader_side') Object.assign(f.trade, { traderSide: 'MAKER',
            makerOrders: [{ orderId: f.order.orderId, matchedAmount: '5', price: '.73' }] });
        f.client.verifiedReceipt = async () => null;
        await f.broker.reconcile(null, f.now);
        assert.equal(f.state.stopped.reason, 'invalid_owned_trade', fault); assert.equal(f.position.uncertain, true, fault);
        assert.equal(f.order.settled, 0, fault); assert.equal(f.state.cash, 22.270941, fault);
        assert.equal(f.state.settlementEvidence, undefined, fault);
    }
});

test('a new semantic reconciliation fault remains durable after its API row disappears behind an existing stop', async () => {
    const stop = { reason: 'invalid_owned_trade', at: 1 }, f = improvedFixture({ stopped: stop });
    f.position.uncertain = true; f.order.transactions = []; f.trade.price = '.76';
    let savedFault;
    f.store.save = () => { savedFault = structuredClone(f.state.reconciliationFaults); };
    await f.broker.reconcile(null, f.now);
    const fault = { count: 1, firstAt: f.now, lastAt: f.now,
        last: { orderId: f.order.orderId.toLowerCase(), tradeId: 'improved-fill' } };
    assert.deepEqual(savedFault.invalid_owned_trade, fault); assert.deepEqual(f.state.stopped, stop);
    f.trade.price = '.73';
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.order.settled, 5.136985);
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    await f.broker.reconcile(null, f.now + 2000);
    assert.deepEqual(f.state.reconciliationFaults.invalid_owned_trade, fault);
    assert.deepEqual(f.state.stopped, stop); assert.equal(f.position.uncertain, true);
});

test('a malformed SDK account response leaves a durable fault after an existing stop even when the next snapshot heals', async () => {
    const stop = { reason: 'invalid_owned_trade', at: 1 }, f = improvedFixture({ stopped: stop });
    f.position.uncertain = true;
    f.client.ordersAndTrades = async () => { throw Object.assign(new Error('malformed account fixture'), { name: 'UnexpectedResponseError' }); };
    await f.broker.reconcile(null, f.now);
    const fault = { count: 1, firstAt: f.now, lastAt: f.now, last: {} };
    assert.deepEqual(f.state.reconciliationFaults.account_status_unknown, fault);
    assert.equal(f.events.find(event => event.type === 'account_query_retry').error.code, 'invalid_api_data');
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade] });
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.receiptProvenComplete, true); assert.equal(f.position.pendingTrades, false);
    assert.deepEqual(f.state.reconciliationFaults.account_status_unknown, fault);
    assert.deepEqual(f.state.stopped, stop); assert.equal(f.position.uncertain, true);
});

test('order schema and identity read failures remain durable behind an original stop after healthy receipt reconciliation', async () => {
    for (const code of ['invalid_api_data', 'order_identity_mismatch']) {
        const stop = { reason: 'invalid_owned_trade', at: 1 }, f = improvedFixture({ stopped: stop });
        f.position.uncertain = true;
        const receiptRead = f.client.verifiedReceipt;
        f.client.verifiedReceipt = async () => null;
        f.client.order = async () => { throw new OperationalError(code, 'validation'); };
        await f.broker.reconcile(null, f.now);
        const fault = { count: 1, firstAt: f.now, lastAt: f.now, last: { orderId: f.order.orderId.toLowerCase() } };
        assert.deepEqual(f.state.reconciliationFaults.order_status_unknown, fault, code);
        f.client.verifiedReceipt = receiptRead;
        f.client.order = async () => ({ id: f.order.orderId, status: 'MATCHED', sizeMatched: '5.136985' });
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, f.now + 1000);
        assert.equal(f.order.receiptProvenComplete, true, code); assert.equal(f.position.pendingTrades, false, code);
        assert.deepEqual(f.state.reconciliationFaults.order_status_unknown, fault, code);
        assert.deepEqual(f.state.stopped, stop, code); assert.equal(f.position.uncertain, true, code);
    }
});

test('transient account and order read failures and expected absent orders do not create semantic fault records', async () => {
    for (const category of ['transport', 'timeout', 'rate_limit', 'circuit']) {
        const f = improvedFixture();
        f.client.ordersAndTrades = async () => { throw new OperationalError('fixture_read_unavailable', category); };
        f.client.verifiedReceipt = async () => null;
        f.client.order = async () => { throw new OperationalError('fixture_read_unavailable', category); };
        await f.broker.reconcile(null, f.now);
        assert.equal(f.state.reconciliationFaults, undefined, category);
    }
    const f = improvedFixture(); f.client.verifiedReceipt = async () => null;
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.awaitingReceipt, true); assert.equal(f.state.reconciliationFaults, undefined);
});

test('receipt proof reconciles the exact incident flows and protocol auto redemption without clearing the stop', async () => {
    const stop = { reason: 'wallet_ledger_mismatch', at: 1780000010000 }, f = fixture({ stopped: stop, autoRedeem: true });
    await f.broker.reconcile(null, f.now);
    await f.broker.cancelOwned();
    assert.equal(await f.broker.checkWallet(), true);
    assert.deepEqual(f.state.stopped, stop); assert.equal(f.state.cash, 23.262881);
    assert.equal(f.state.walletCashDelta, .99194); assert.deepEqual(f.position.holdings, [0, 0]);
    assert.equal(f.position.fees, .05806); assert.equal(f.position.entryCost, 4.00806);
    assert.equal(f.order.status, 'complete'); assert.equal(f.order.settled, 5);
    assert.equal(f.position.pendingTrades, false); assert.equal(f.broker.pending(), false);
    assert.deepEqual(f.calls.receipts, [fillHash, redeemHash]); assert.equal(f.calls.single, 0); assert.equal(f.calls.cancel, 0);
    assert.equal(f.position.actions.length, 1); assert.equal(f.position.actions[0].source, 'protocol_auto');
    assert.equal(f.position.actions[0].status, 'confirmed'); assert.equal(f.position.actions[0].hash, redeemHash);
    assert.equal('raw' in f.position.actions[0], false);
    assert.deepEqual(Object.keys(f.state.settlementEvidence).sort(), [fillHash, redeemHash]);
    assert.deepEqual(f.state.settlementEvidence[fillHash], { hash: fillHash, kind: 'fill', conditionId, orderId,
        cash: -4.00806, holdings: [0, 5], fees: .05806, blockNumber: 99, blockHash, source: 'receipt' });
    assert.equal(f.state.settlementEvidence[redeemHash].kind, 'protocol_auto_redeem');
    assert.equal(f.events.find(event => event.type === 'fill_settled').savedEvidence[fillHash].cash, -4.00806);
    const before = structuredClone(f.state);
    await f.broker.reconcile(null, f.now + 1000);
    assert.deepEqual(f.state, before); assert.deepEqual(f.calls.receipts, [fillHash, redeemHash]);
});

test('owned API trade discovers a valid receipt while its status is MINED and the order lookup is null', async () => {
    const f = fixture(); f.order.transactions = [];
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'owned', conditionId, assetId: '2',
        traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'MINED', transactionHash: fillHash }] });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.stopped, null); assert.equal(f.order.settled, 5); assert.equal(f.order.status, 'complete');
    assert.equal(f.position.fills[0].tradeId, 'owned'); assert.equal(f.calls.single, 0);
});

test('an unrelated API order hash cannot authorize a receipt even when wallet movements look correct', async () => {
    const f = fixture(); f.order.transactions = [];
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'unowned', conditionId,
        traderSide: 'TAKER', takerOrderId: '0x' + 'f'.repeat(64), size: '5', price: '.79', status: 'CONFIRMED', transactionHash: fillHash }] });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 0); assert.equal(f.state.cash, 22.270941); assert.equal(f.calls.receipts.length, 0);
    assert.equal(f.state.stopped.reason, 'order_status_unknown'); assert.equal(f.state.settlementEvidence, undefined);
});

test('a terminal API row with zero fill cannot finish while an authorized settlement receipt is pending', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: null }); f.order.filled = 0;
    f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '0' });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.status, 'complete'); assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
    f.client.verifiedReceipt = async () => fillReceipt();
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.settled, 5); assert.equal(f.order.filled, 5); assert.equal(f.position.pendingTrades, false);
});

test('an owned API transaction remains a pending candidate after the API row disappears on restart', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: null }); f.order.transactions = []; f.order.filled = 0;
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'owned', conditionId,
        traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'MATCHED', transactionHash: fillHash }] });
    f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '0' });
    await f.broker.reconcile(null, f.now);
    assert.deepEqual(f.order.transactions, [fillHash]); assert.equal(f.position.pendingTrades, true);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
});

test('POST and discovered trade identifiers remain pending across terminal-zero API lag and disappearance', async () => {
    for (const source of ['post', 'api']) {
        const f = fixture({ openedAt: 1780000299000, receipt: null });
        f.order.transactions = []; f.order.filled = 0; f.order.tradeIds = source === 'post' ? ['known-match'] : [];
        f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '0' });
        if (source === 'api') f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'known-match', conditionId,
            traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'MATCHED', transactionHash: null }] });
        await f.broker.reconcile(null, f.now);
        assert.equal(f.position.pendingTrades, true); assert.deepEqual(f.order.tradeIds, ['known-match']);
        f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, f.now + 1000);
        assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
    }
});

test('successful matched POST without identifiers retains submission evidence and cannot finish as a zero fill', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: null }); f.position.orders = [];
    f.client.prepare = async () => ({ orderId, signed: { orderType: 'FAK', sealed: true } });
    f.client.post = async () => ({ ok: true, orderId, status: 'matched', tradeIds: [], transactionsHashes: [] });
    const order = await f.broker.submit({ tokenId: '2', index: 1, side: 'BUY', kind: 'taker', shares: 5,
        price: .79, cost: 4.05807 }, f.now);
    assert.equal(order.apiSubmissionStatus, 'matched');
    f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '0' });
    await f.broker.reconcile(null, f.now);
    assert.equal(order.settled, 0); assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
});

test('one missing micro share cannot turn a receipt-proven partial FAK into a complete order', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: fillReceipt(4999999, 3949999, 58060) });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 4.999999); assert.equal(f.order.receiptProvenComplete, undefined);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.broker.pending(), true);
});

test('newly discovered hashes are saved before the first receipt read can lose the process', async () => {
    const f = fixture(); f.order.transactions = [];
    let saved;
    f.store.save = () => { saved = structuredClone(f.state); };
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'owned', conditionId,
        traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'MINED', transactionHash: fillHash }] });
    f.client.verifiedReceipt = async () => {
        assert.deepEqual(saved.position.orders[0].transactions, [fillHash]);
        assert.deepEqual(saved.position.orders[0].tradeIds, ['owned']);
        return null;
    };
    await f.broker.reconcile(null, f.now);
});

test('a receipt for part of a known trade cannot clear the remaining matched quantity, including after restart', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: fillReceipt(2000000, 1580000, 23224) });
    f.order.filled = 0;
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'known-five', conditionId,
        traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'MINED', transactionHash: fillHash }] });
    f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '2' });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 2); assert.equal(f.order.filled, 5);
    assert.equal(f.order.matchedTrades['trade:known-five'].shares, 5); assert.equal(f.position.pendingTrades, true);
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(Object.values(f.order.matchedTrades).length, 1, 'The same trade must not be counted twice');
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [] });
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, f.now + 2000);
    assert.equal(f.position.pendingTrades, true); assert.equal(f.order.settled, 2); assert.equal(f.order.filled, 5);
});

test('new accepted FAK with a known hash stays pending through bounded receipt lag without a permanent stop', async () => {
    for (const receipt of [null, { ...fillReceipt(), confirmations: 1 }, { ...fillReceipt(), blockNumber: 101 }]) {
        const f = fixture({ openedAt: 1780000299000, receipt });
        await f.broker.reconcile(null, f.now);
        assert.equal(f.state.stopped, null); assert.equal(f.order.status, 'accepted');
        assert.equal(f.position.pendingTrades, true); assert.equal(f.order.settled, 0);
        assert.equal(f.state.settlementEvidence, undefined);
    }
    const expired = fixture({ receipt: null });
    await expired.broker.reconcile(null, expired.now);
    assert.ok(expired.state.stopped); assert.equal(expired.order.settled, 0);
});

test('partial FAK receipt remains pending until authoritative terminal status and every filled share is settled', async () => {
    const f = fixture({ openedAt: 1780000299000, receipt: fillReceipt(2000000, 1580000, 23224) });
    f.order.filled = 0;
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.stopped, null); assert.equal(f.order.settled, 2); assert.equal(f.order.filled, 2);
    assert.equal(f.order.receiptProvenComplete, undefined); assert.equal(f.position.pendingTrades, true);
    assert.equal(f.broker.pending(), true);
    f.client.order = async () => ({ id: orderId, status: 'MATCHED', sizeMatched: '2' });
    await f.broker.reconcile(null, f.now + 1000);
    assert.equal(f.order.status, 'complete'); assert.equal(f.position.pendingTrades, false); assert.equal(f.order.settled, 2);
    assert.equal(f.broker.pending(), false); assert.equal(f.position.fills.length, 1);
});

test('persisted order and cancellation retries use one, two, five and thirty seconds and survive restart', async t => {
    const f = fixture({ receipt: null }); f.order.transactions = [];
    t.mock.timers.enable({ apis: ['Date'], now: f.now });
    for (const delay of [1000, 2000, 5000, 30000, 30000]) {
        const beforeQueries = f.calls.single, beforeCancels = f.calls.cancel;
        await f.broker.reconcile(null, Date.now()); await f.broker.cancelOwned();
        assert.equal(f.calls.single, beforeQueries + 1); assert.equal(f.calls.cancel, beforeCancels + 1);
        assert.equal(f.order.queryRetry.nextAt, Date.now() + delay); assert.equal(f.order.cancelRetry.nextAt, Date.now() + delay);
        await f.broker.reconcile(null, Date.now()); await f.broker.cancelOwned();
        assert.equal(f.calls.single, beforeQueries + 1); assert.equal(f.calls.cancel, beforeCancels + 1);
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        t.mock.timers.setTime(Date.now() + delay);
    }
    assert.deepEqual(f.events.filter(event => event.type === 'order_query_retry').map(event => event.nextDelayMs),
        [1000, 2000, 5000, 30000, 30000]);
});

test('API outage does not block persisted receipt settlement and successful proof never overwrites the original stop', async () => {
    const stop = { reason: 'drawdown_limit', at: 1 }, f = fixture({ stopped: stop, autoRedeem: true });
    f.client.ordersAndTrades = async () => { throw new OperationalError('read_timeout', 'timeout'); };
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.status, 'complete'); assert.equal(f.state.cash, 23.262881); assert.deepEqual(f.state.stopped, stop);
    assert.deepEqual(f.position.holdings, [0, 0]); assert.equal(f.calls.single, 0);
});

test('FAILED API contradiction preserves a stop and durable uncertainty while accounting an authoritative successful receipt', async () => {
    const stop = { reason: 'wallet_ledger_mismatch', at: 1 }, f = fixture({ stopped: stop });
    f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ id: 'failed-api', conditionId,
        traderSide: 'TAKER', takerOrderId: orderId, size: '5', price: '.79', status: 'FAILED', transactionHash: fillHash }] });
    await f.broker.reconcile(null, f.now);
    assert.equal(f.order.settled, 5); assert.equal(f.state.cash, 18.262881); assert.deepEqual(f.state.stopped, stop);
    assert.equal(f.position.uncertain, true); assert.equal(f.events.filter(event => event.type === 'trade_settlement_failed').length, 1);
});

test('wallet mismatch, incomplete scan and pending automatic redemption candidates block transaction preparation', async () => {
    for (const fault of ['wallet', 'scan', 'pending']) {
        const f = fixture(); let prepares = 0;
        f.client.prepareAction = async () => { prepares++; throw new Error('should_not_prepare'); };
        if (fault === 'wallet') {
            f.client.balance = async () => 21.814894; f.client.holdings = async () => [0, 0];
        } else if (fault === 'scan') f.client.redemptionScan.complete = false;
        else {
            f.client.listAutoRedemptions = async () => [redeemHash];
            f.client.verifiedReceipt = async hash => hash === fillHash ? fillReceipt() : null;
        }
        await f.broker.reconcile(null, f.now);
        assert.equal(await f.broker.action('redeem', 0, f.now), false);
        assert.equal(prepares, 0); assert.deepEqual(f.position.holdings, [0, 5]);
        if (fault === 'wallet') {
            assert.equal(f.state.stopped, null);
            assert.equal(f.position.autoRedeemWait.since, f.now);
            assert.equal(f.state.cash, 18.262881); assert.equal(f.state.walletCashDelta, -4.00806);
            assert.equal(await f.broker.checkWallet(f.now + 120000), false);
            assert.equal(f.state.stopped.reason, 'auto_redeem_receipt_timeout');
            assert.equal(f.state.cash, 18.262881); assert.deepEqual(f.position.holdings, [0, 5]);
        }
    }
});

test('a post-resolution wallet change differing from the exact official payout remains fatal', async () => {
    const f = fixture();
    f.client.balance = async () => 21.814895; f.client.holdings = async () => [0, 0];
    await f.broker.reconcile(null, f.now);
    assert.equal(await f.broker.action('redeem', 0, f.now), false);
    assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    assert.equal(f.position.autoRedeemWait, undefined);
    assert.equal(f.state.cash, 18.262881); assert.deepEqual(f.position.holdings, [0, 5]);
});

test('invalid fill, failed receipt and wrong protocol redemption never book funds', async () => {
    for (const receipt of [{ ...fillReceipt(), status: 0 }, { ...fillReceipt(), logs: fillReceipt().logs.slice(0, 2) },
        fillReceipt(6000000, 4740000, 69672)]) {
        const f = fixture({ receipt }); await f.broker.reconcile(null, f.now);
        assert.equal(f.order.settled, 0); assert.equal(f.state.cash, 22.270941); assert.equal(f.state.settlementEvidence, undefined);
    }
    const f = fixture({ autoRedeem: true });
    f.client.verifiedReceipt = async hash => hash === fillHash ? fillReceipt() : { ...redeemReceipt(), logs: redeemReceipt().logs.slice(0, 3) };
    await f.broker.reconcile(null, f.now);
    assert.equal(f.state.cash, 18.262881); assert.deepEqual(f.position.holdings, [0, 5]);
    assert.equal(f.position.actions.length, 0); assert.deepEqual(Object.keys(f.state.settlementEvidence), [fillHash]);
});

test('verified receipt checks its canonical block and captured anchor before returning accounting evidence', async () => {
    const client = Object.create(LayaTradingClient.prototype), calls = [];
    let receipt = fillReceipt(), canonicalHash = blockHash;
    client.rpc = { anchor: { number: 100, hash: zeroHash },
        validate: async (provider, anchor) => { calls.push(['anchor', anchor.number, anchor.hash]); },
        read: async (stage, task, block) => { assert.equal(block, 100); return task({
            getTransactionReceipt: async () => receipt,
            getBlock: async number => { calls.push(['block', number]); return { number, hash: canonicalHash }; },
        }, block); } };
    assert.equal((await client.verifiedReceipt(fillHash, 100)).blockHash, blockHash);
    assert.deepEqual(calls, [['anchor', 100, zeroHash], ['block', 99]]);
    canonicalHash = zeroHash;
    await assert.rejects(client.verifiedReceipt(fillHash, 100), error => error.code === 'rpc_block_mismatch');
    receipt = { ...fillReceipt(), confirmations: 1 };
    assert.equal(await client.verifiedReceipt(fillHash, 100), null);
    receipt = { ...fillReceipt(), transactionHash: redeemHash };
    await assert.rejects(client.verifiedReceipt(fillHash, 100), error => error.code === 'receipt_identity_mismatch');
    await assert.rejects(client.verifiedReceipt(fillHash, 101), error => error.code === 'rpc_snapshot_changed');
});
