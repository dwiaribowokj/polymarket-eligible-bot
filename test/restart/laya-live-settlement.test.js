import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { BASELINE } from '../../src/restart/config.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { pendingSettlementWitness, signedBuyOrderBounds, verifyAutoRedeemReceipt, verifyOwnedFillReceipt } from '../../src/laya-live/settlement.js';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const hash = `0x${'a'.repeat(64)}`, redeemHash = `0x${'b'.repeat(64)}`;
const blockHash = `0x${'c'.repeat(64)}`, orderId = `0x${'d'.repeat(64)}`, conditionId = `0x${'e'.repeat(64)}`;
const zero = ethers.constants.AddressZero, zeroHash = ethers.constants.HashZero;
const collateral = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const operator = CONTRACTS.autoRedeemOperator;
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const clone = value => structuredClone(value);
const log = (iface, event, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(event), args) });
const cashLog = (from, to, value, logIndex) => log(erc20, 'Transfer', CONTRACTS.collateralToken, [from, to, value], logIndex);
const tokenLog = (from, to, id, value, logIndex, by = other) => log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens,
    [by, from, to, id, value], logIndex);
function position() {
    return { market: { tokens: ['1', '2'], conditionId, negRisk: false }, holdings: [0, 0], entryCost: 0,
        pendingTrades: true, pendingSince: 1000, receipts: {}, actions: [],
        orders: [{ orderId, tokenId: '2', side: 'BUY', kind: 'taker', index: 1, price: .79,
            shares: 5, settled: 0, cost: 4.05807, status: 'unknown', transactions: [hash] }] };
}
function fillReceipt({ quantity = 5000000, principal = 3950000, fee = 58060, transactionHash = hash,
    fillOrderId = orderId } = {}) {
    return { transactionHash, blockHash, status: 1, confirmations: 3, blockNumber: 99,
        logs: [cashLog(wallet, other, principal + fee, 10), tokenLog(other, wallet, '2', quantity, 11),
            log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                [fillOrderId, wallet, other, 0, '2', principal, quantity, fee, zeroHash, zeroHash], 12)] };
}
function fillInput() { return { position: position(), wallet, block: 100, receipt: fillReceipt() }; }
function pendingInput() {
    return { position: position(), wallet, block: 100, now: 2000, receipts: [fillReceipt()],
        expectedCash: 20.822954, actualCash: 16.814894, actualHoldings: [0, 5] };
}
function redeemReceipt() {
    return { transactionHash: redeemHash, blockHash, status: 1, confirmations: 3, blockNumber: 100,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, 5000000]], 10),
            tokenLog(operator, zero, '2', 5000000, 11, operator),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, collateral, zeroHash, conditionId, [1, 2], 5000000], 13),
            cashLog(zero, wallet, 5000000, 16)] };
}
function redeemInput() {
    const p = position(); p.holdings = [0, 5]; p.orders[0].settled = 5; p.entryCost = 4.00806;
    p.receipts[hash] = { cash: -4.00806, holdings: [0, 5] };
    return { position: p, wallet, block: 100, payout: [0, 1], receipt: redeemReceipt() };
}
function bindSignedOrder(order, changes = {}) {
    const signed = { salt: '1', maker: wallet, signer: wallet, tokenId: '2', makerAmount: '3750000',
        takerAmount: '5000000', side: 'BUY', signatureType: 0, timestamp: '1792208315',
        metadata: zeroHash, builder: zeroHash, orderType: 'FAK', ...changes };
    const fields = [ ['salt', 'uint256'], ['maker', 'address'], ['signer', 'address'], ['tokenId', 'uint256'],
        ['makerAmount', 'uint256'], ['takerAmount', 'uint256'], ['side', 'uint8'], ['signatureType', 'uint8'],
        ['timestamp', 'uint256'], ['metadata', 'bytes32'], ['builder', 'bytes32'] ].map(([name, type]) => ({ name, type }));
    order.signed = signed;
    order.orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2',
        chainId: 137, verifyingContract: CONTRACTS.standardExchange }, { Order: fields },
    { ...signed, side: signed.side === 'BUY' ? 0 : signed.side === 'SELL' ? 1 : signed.side });
    return order;
}
function improvedFillInput() {
    const p = position(); p.fees = 0;
    const order = p.orders[0]; order.price = .75; order.cost = 3.86563;
    bindSignedOrder(order);
    return { position: p, wallet, block: 100, receipt: fillReceipt({ quantity: 5136985, principal: 3749999,
        fee: 70870, fillOrderId: order.orderId }) };
}
function higherFeeFillInput() {
    const input = improvedFillInput(), order = input.position.orders[0];
    order.price = .88; order.cost = 4.48696;
    bindSignedOrder(order, { makerAmount: '4400000' });
    input.receipt = fillReceipt({ quantity: 6376812, principal: 4400000, fee: 95480, fillOrderId: order.orderId });
    return { ...input, entryCap: 5 };
}

test('confirmed owned V2 receipt proves exact BUY principal, fees and shares without trusting API status', () => {
    const input = fillInput(), before = clone(input);
    const proof = verifyOwnedFillReceipt(input);
    assert.deepEqual(proof, { hash, hashes: [hash], blockNumber: 99, blockHash,
        cash: -4.00806, holdings: [0, 5], fees: .05806, notional: -3.95,
        parts: [{ orderId, index: 1, shares: 5, price: .79, principal: 3.95, fee: .05806 }] });
    assert.deepEqual(input, before, 'proof must not update the ledger or order');
});

test('owned trade hash can locate proof when POST omitted settlement hash; an arbitrary hash cannot', () => {
    const input = fillInput(); input.position.orders[0].transactions = [];
    assert.equal(verifyOwnedFillReceipt(input), null);
    assert.ok(verifyOwnedFillReceipt({ ...input, ownedTradeHashes: [hash.toUpperCase().replace('0X', '0x')] }));
    assert.equal(verifyOwnedFillReceipt({ ...input, ownedTradeHashes: [redeemHash] }), null);
});

test('missing, malformed, failed, unconfirmed, future and already accounted receipts fail closed', () => {
    for (const mutate of [
        input => { input.receipt = null; },
        input => { delete input.receipt.confirmations; },
        input => { input.receipt.confirmations = 1; },
        input => { input.receipt.confirmations = NaN; },
        input => { input.receipt.status = 0; },
        input => { input.receipt.blockNumber = 101; },
        input => { delete input.receipt.blockNumber; },
        input => { input.receipt.blockHash = 'invalid'; },
        input => { input.receipt.logs[0].removed = true; },
        input => { input.receipt.logs[0].transactionHash = redeemHash; },
        input => { input.receipt.logs[0].blockHash = zeroHash; },
        input => { input.receipt.logs[1].logIndex = 10; },
        input => { input.receipt.logs[2].data = '0x'; },
        input => { input.position.receipts[hash.toUpperCase()] = true; },
    ]) {
        const input = fillInput(); mutate(input); assert.equal(verifyOwnedFillReceipt(input), null);
    }
});

test('receipt transfers alone, wrong exchange/order/maker/token/side and excess quantity or cost prove no fill', () => {
    const wrongEvents = [
        [redeemHash, wallet, other, 0, '2', 3950000, 5000000, 58060],
        [orderId, other, wallet, 0, '2', 3950000, 5000000, 58060],
        [orderId, wallet, other, 1, '2', 3950000, 5000000, 58060],
        [orderId, wallet, other, 0, '1', 3950000, 5000000, 58060],
        [orderId, wallet, other, 0, '2', 4000000, 5000000, 8060],
    ];
    for (const args of wrongEvents) {
        const input = fillInput(); input.receipt.logs[2] = log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
            [...args, zeroHash, zeroHash], 12);
        assert.equal(verifyOwnedFillReceipt(input), null);
    }
    for (const mutate of [
        input => { input.receipt.logs.pop(); },
        input => { input.receipt.logs[2].address = other; },
        input => { input.position.orders[0].shares = 4; },
        input => { input.position.orders[0].settled = 1; },
        input => { input.position.orders[0].cost = 4; },
        input => { input.position.entryCost = -1; },
        input => { input.position.orders[0].tokenId = '1'; },
        input => { input.position.orders[0].side = 'SELL'; },
        input => { input.position.market.negRisk = true; },
    ]) {
        const input = fillInput(); mutate(input); assert.equal(verifyOwnedFillReceipt(input), null);
    }
});

test('unrelated wallet cash, extra tokens and a fee inconsistent with the owned event cannot hide in a fill', () => {
    for (const extra of [cashLog(other, wallet, 1, 13), cashLog(wallet, other, 1, 13),
        tokenLog(other, wallet, '1', 1, 13), tokenLog(other, wallet, '3', 1, 13)]) {
        const input = fillInput(); input.receipt.logs.push(extra); assert.equal(verifyOwnedFillReceipt(input), null);
    }
    const input = fillInput(); input.receipt.logs[0] = cashLog(wallet, other, 4008061, 10);
    assert.equal(verifyOwnedFillReceipt(input), null);
});

test('partial owned receipts respect remaining quantity and remaining reservation across multiple transactions', () => {
    const input = fillInput(); input.receipt = fillReceipt({ quantity: 2000000, principal: 1580000, fee: 23224 });
    assert.equal(verifyOwnedFillReceipt(input).parts[0].shares, 2);
    input.position.orders[0].settled = 4; input.position.entryCost = 3.206448;
    assert.equal(verifyOwnedFillReceipt(input), null);
});

test('signed V2 cash cap proves the actual 5.136985-share price improvement while preserving the five-share target', () => {
    const input = improvedFillInput(), before = clone(input), order = input.position.orders[0];
    assert.deepEqual(signedBuyOrderBounds(order, wallet), { makerAmount: 3750000n, takerAmount: 5000000n });
    const proof = verifyOwnedFillReceipt(input);
    assert.equal(proof.cash, -3.820869);
    assert.equal(proof.fees, .07087);
    assert.deepEqual(proof.holdings, [0, 5.136985]);
    assert.equal(proof.parts[0].shares, 5.136985);
    assert.equal(proof.parts[0].principal, 3.749999);
    assert.deepEqual(proof.parts[0].signedAmounts, { makerAmount: '3750000', takerAmount: '5000000',
        principalBefore: '0', principalAfter: '3749999', feeBefore: '0', feeAfter: '70870',
        quantityBefore: '0', quantityAfter: '5136985', remainingPrincipal: '1' });
    assert.deepEqual(input, before, 'receipt accounting cannot resize or otherwise update the order');
    delete input.position.orders[0].signed;
    assert.equal(verifyOwnedFillReceipt(input), null, 'unsigned compatibility never authorizes excess shares');
});

test('explicit signed entry cap proves improved-price fees above the preserved entry estimate', () => {
    const input = higherFeeFillInput(), before = clone(input), proof = verifyOwnedFillReceipt(input);
    assert.equal(proof.cash, -4.49548);
    assert.equal(proof.fees, .09548);
    assert.equal(proof.parts[0].principal, 4.4);
    assert.deepEqual(proof.holdings, [0, 6.376812]);
    assert.equal(proof.parts[0].signedAmounts.remainingPrincipal, '0');
    assert.deepEqual(input, before, 'proof preserves estimated cost, target and all accounting inputs');
    delete input.entryCap;
    assert.equal(verifyOwnedFillReceipt(input), null, 'the estimate remains binding without an explicit cap');
    const unsigned = fillInput(); unsigned.position.orders[0].cost = 4;
    assert.equal(verifyOwnedFillReceipt({ ...unsigned, entryCap: 5 }), null, 'unsigned receipt cannot broaden its reservation');
});

test('signed entry cap rejects invalid configuration and enforces exact total cost boundaries', () => {
    for (const cap of [null, '5', NaN, Infinity, -1, 0, 5.000001, 4.486959, 4.4954801]) {
        const input = higherFeeFillInput(); input.entryCap = cap;
        assert.equal(verifyOwnedFillReceipt(input), null, `invalid cap ${String(cap)}`);
    }
    const exact = higherFeeFillInput(); exact.entryCap = 4.49548;
    assert.ok(verifyOwnedFillReceipt(exact));
    exact.entryCap = 4.495479;
    assert.equal(verifyOwnedFillReceipt(exact), null, 'one micro above a configured cap fails');
    for (const fee of [600000, 600001]) {
        const input = higherFeeFillInput();
        input.receipt = fillReceipt({ quantity: 6376812, principal: 4400000, fee,
            fillOrderId: input.position.orders[0].orderId });
        assert.equal(!!verifyOwnedFillReceipt(input), fee === 600000, 'five-dollar cap includes all event fees');
    }
});

test('higher fee allowance preserves signed principal, price and exact wallet movement checks', () => {
    for (const mutate of [
        input => { input.receipt = fillReceipt({ quantity: 6376812, principal: 4400001, fee: 95480,
            fillOrderId: input.position.orders[0].orderId }); },
        input => { input.receipt = fillReceipt({ quantity: 4999999, principal: 4400000, fee: 95480,
            fillOrderId: input.position.orders[0].orderId }); },
        input => { input.receipt.logs[0] = cashLog(wallet, other, 4495481, 10); },
        input => { input.receipt.logs[1] = tokenLog(other, wallet, '2', 6376811, 11); },
        input => { input.receipt.logs.push(cashLog(other, wallet, 1, 13)); },
        input => { input.position.orders[0].signed.makerAmount = '4400001'; },
    ]) {
        const input = higherFeeFillInput(); mutate(input);
        assert.equal(verifyOwnedFillReceipt(input), null);
    }
});

test('explicit signed cap includes prior principal and fees across partial receipts and pending witnesses', () => {
    const input = higherFeeFillInput(), order = input.position.orders[0];
    const first = fillReceipt({ quantity: 3000000, principal: 2200000, fee: 48000, fillOrderId: order.orderId });
    const second = fillReceipt({ quantity: 3376812, principal: 2200000, fee: 47480,
        transactionHash: redeemHash, fillOrderId: order.orderId });
    order.transactions.push(redeemHash);
    const witness = { ...input, now: 2000, receipts: [first, second], expectedCash: 10,
        actualCash: 5.50452, actualHoldings: [0, 6.376812] };
    assert.deepEqual(pendingSettlementWitness(witness), { block: 100, cash: -4.49548,
        holdings: [0, 6.376812], hashes: [hash, redeemHash] });
    assert.equal(pendingSettlementWitness({ ...witness, entryCap: 4.495479 }), null);
    input.position.entryCost = 2.248; input.position.fees = .048;
    order.settled = 3; order.settledPrincipal = 2.2; input.position.receipts[hash] = true;
    input.receipt = second; input.entryCap = 4.49548;
    const proof = verifyOwnedFillReceipt(input);
    assert.equal(proof.parts[0].signedAmounts.principalAfter, '4400000');
    assert.equal(proof.parts[0].signedAmounts.feeAfter, '95480');
    input.entryCap = 4.495479;
    assert.equal(verifyOwnedFillReceipt(input), null, 'prior fees count against the total cap');
});

test('broker reconciles higher actual fees once and recognizes settled holdings within the authorized cap', async () => {
    const input = higherFeeFillInput(), position = input.position, order = position.orders[0], now = 100000;
    Object.assign(position, { openedAt: 0, bought: [0, 0], fills: [], pendingSince: 0 });
    position.market.end = now + 1000;
    Object.assign(order, { filled: 0, status: 'accepted' });
    const state = { mode: 'pilot', strategy: 'late-entry', decisionProvider: 'laya', cash: 10,
        walletCashDelta: 0, position, stopped: null }, events = [];
    const store = { state, save() {}, stop(reason) { state.stopped ||= { reason }; },
        event(type, detail) { events.push({ type, ...detail }); } };
    let receiptReads = 0;
    const client = { confirmedBlock: async () => 100,
        ordersAndTrades: async () => ({ orders: [], trades: [] }),
        verifiedReceipt: async () => { receiptReads++; return input.receipt; },
        order: async () => assert.fail('signed cash exhaustion needs no order lookup'),
        prepare: async () => assert.fail('reconciliation cannot prepare an order'),
        post: async () => assert.fail('reconciliation cannot submit an order'),
    };
    const settings = { ...BASELINE, wallet, shares: 5, entryCap: 5 };
    let broker = new LayaLiveBroker(settings, store, client, async () => {});
    await broker.reconcile(null, now);
    assert.equal(state.stopped, null);
    assert.equal(position.entryCost, 4.49548);
    assert.equal(position.fees, .09548);
    assert.equal(order.cost, 4.48696);
    assert.equal(order.shares, 5);
    assert.equal(order.settled, 6.376812);
    assert.equal(order.receiptProvenComplete, true);
    assert.equal(state.cash, 5.50452);
    assert.equal(broker.settledBookHoldReady(), true);
    broker = new LayaLiveBroker(settings, store, client, async () => {});
    await broker.reconcile(null, now + 1);
    assert.equal(receiptReads, 1, 'restart cannot account the same receipt twice');
    assert.equal(events.filter(event => event.type === 'fill_settled').length, 1);
    assert.equal(state.cash, 5.50452);
    assert.equal(broker.settledBookHoldReady(), true);
    for (const entryCap of [4.495479, 5.000001, NaN]) {
        broker.settings = { ...settings, entryCap };
        assert.equal(broker.settledBookHoldReady(), false);
    }
});

test('signed cap metadata must bind the exact order hash, BUY wallet, token, target and FAK policy', () => {
    for (const mutate of [
        value => { value.position.orders[0].signed.makerAmount = '4000000'; },
        value => { value.position.orders[0].signed.maker = other; },
        value => { value.position.orders[0].signed.signer = other; },
        value => { value.position.orders[0].signed.tokenId = '1'; },
        value => { value.position.orders[0].signed.side = 'SELL'; },
        value => { value.position.orders[0].signed.orderType = 'GTC'; },
        value => { value.position.orders[0].signed.takerAmount = '6000000'; },
        value => { value.position.orders[0].signed.timestamp = '1792208316'; },
        value => { value.position.orders[0].signed = {}; },
        value => { value.position.orders[0].shares = 6; },
        value => { value.position.orders[0].price = .74; },
        value => { value.position.orders[0].orderId = orderId; },
        value => { value.wallet = other; },
        value => { value.receipt.logs[2].address = other; },
    ]) {
        const input = improvedFillInput(); mutate(input);
        assert.equal(verifyOwnedFillReceipt(input), null);
    }
});

test('signed maker cap and integer price ratio reject a cash overfill or worse execution even within the reservation', () => {
    const over = improvedFillInput(), order = over.position.orders[0];
    over.receipt = fillReceipt({ quantity: 5200000, principal: 3750001, fee: 70870, fillOrderId: order.orderId });
    assert.equal(verifyOwnedFillReceipt(over), null);
    const ratio = improvedFillInput();
    bindSignedOrder(ratio.position.orders[0], { makerAmount: '3700000' });
    ratio.receipt = fillReceipt({ quantity: 4950000, principal: 3700000, fee: 70000,
        fillOrderId: ratio.position.orders[0].orderId });
    assert.equal(verifyOwnedFillReceipt(ratio), null, 'the signed .74 ratio is stricter than the .75 metadata limit');
    const aggregate = improvedFillInput(), id = aggregate.position.orders[0].orderId;
    aggregate.receipt = fillReceipt({ quantity: 5200000, principal: 3800000, fee: 40000, fillOrderId: id });
    aggregate.receipt.logs.splice(2, 1,
        log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
            [id, wallet, other, 0, '2', 1900000, 2600000, 20000, zeroHash, zeroHash], 12),
        log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
            [id, wallet, other, 0, '2', 1900000, 2600000, 20000, zeroHash, zeroHash], 13));
    assert.equal(verifyOwnedFillReceipt(aggregate), null, 'all fills in the receipt share one signed cash cap');
});

test('signed partial receipts retain exact cumulative principal, fees and actual quantity across the target', () => {
    const input = improvedFillInput(), order = input.position.orders[0];
    input.receipt = fillReceipt({ quantity: 2000000, principal: 1500000, fee: 20000, fillOrderId: order.orderId });
    assert.equal(verifyOwnedFillReceipt(input).parts[0].signedAmounts.principalAfter, '1500000');
    input.position.entryCost = 1.52; input.position.fees = .02;
    order.settled = 2; order.settledPrincipal = 1.5; order.transactions.push(redeemHash);
    input.position.receipts[hash] = true;
    input.receipt = fillReceipt({ quantity: 3136985, principal: 2249999, fee: 50870,
        transactionHash: redeemHash, fillOrderId: order.orderId });
    const proof = verifyOwnedFillReceipt(input);
    assert.deepEqual(proof.parts[0].signedAmounts, { makerAmount: '3750000', takerAmount: '5000000',
        principalBefore: '1500000', principalAfter: '3749999', feeBefore: '20000', feeAfter: '70870',
        quantityBefore: '2000000', quantityAfter: '5136985', remainingPrincipal: '1' });
    for (const mutate of [
        value => { value.receipt = fillReceipt({ quantity: 3136985, principal: 2250001, fee: 50870,
            transactionHash: redeemHash, fillOrderId: order.orderId }); },
        value => { value.receipt = fillReceipt({ quantity: 3136985, principal: 2249999, fee: 100000,
            transactionHash: redeemHash, fillOrderId: order.orderId }); },
        value => { value.position.orders[0].settledPrincipal = 1.499999; },
        value => { value.position.fees = -.01; },
        value => { delete value.position.fees; },
    ]) {
        const changed = clone(input); mutate(changed); assert.equal(verifyOwnedFillReceipt(changed), null);
    }
});

test('signed pending witness aggregates price-improved receipts and cannot spend the principal cap twice', () => {
    const signed = improvedFillInput(), order = signed.position.orders[0];
    order.transactions.push(redeemHash);
    const input = { ...signed, receipt: undefined, now: 2000, expectedCash: 21.814894,
        actualCash: 17.994025, actualHoldings: [0, 5.136985], receipts: [
            fillReceipt({ quantity: 2000000, principal: 1500000, fee: 20000, fillOrderId: order.orderId }),
            fillReceipt({ quantity: 3136985, principal: 2249999, fee: 50870,
                transactionHash: redeemHash, fillOrderId: order.orderId }),
        ] };
    const before = clone(input);
    assert.deepEqual(pendingSettlementWitness(input), { block: 100, cash: -3.820869,
        holdings: [0, 5.136985], hashes: [hash, redeemHash] });
    assert.deepEqual(input, before);
    input.receipts[1] = fillReceipt({ quantity: 3136985, principal: 2250001, fee: 50870,
        transactionHash: redeemHash, fillOrderId: order.orderId });
    input.actualCash -= .000002;
    assert.equal(pendingSettlementWitness(input), null);
});

test('pending wallet deferral requires exact current cash and both holdings, a bounded age and immutable receipt proof', () => {
    const input = pendingInput(), before = clone(input);
    assert.deepEqual(pendingSettlementWitness(input), { block: 100, cash: -4.00806, holdings: [0, 5], hashes: [hash] });
    assert.deepEqual(input, before);
    for (const mutate of [
        value => { value.actualCash += .000001; },
        value => { value.actualCash -= 1; },
        value => { value.actualCash = -1; },
        value => { value.expectedCash = -1; },
        value => { value.actualHoldings[0] = .000001; },
        value => { value.actualHoldings[1] = 0; },
        value => { value.position.pendingTrades = false; },
        value => { value.now = value.position.pendingSince + 120000; },
        value => { value.now = value.position.pendingSince - 1; },
        value => { delete value.position.pendingSince; },
        value => { value.receipts = []; },
        value => { value.receipts.push(clone(value.receipts[0])); },
        value => { value.position.actions.push({ status: 'unknown' }); },
        value => { value.block = 98; },
    ]) {
        const changed = pendingInput(); mutate(changed); assert.equal(pendingSettlementWitness(changed), null);
    }
});

test('pending witness aggregates partial receipts once and refuses overfill across their total', () => {
    const input = pendingInput(); input.position.orders[0].transactions.push(redeemHash);
    input.receipts = [fillReceipt({ quantity: 2000000, principal: 1580000, fee: 23224 }),
        fillReceipt({ quantity: 3000000, principal: 2370000, fee: 34836, transactionHash: redeemHash })];
    assert.deepEqual(pendingSettlementWitness(input)?.holdings, [0, 5]);
    input.receipts[1] = fillReceipt({ quantity: 4000000, principal: 3160000, fee: 46448, transactionHash: redeemHash });
    input.actualCash = 20.822954 - 4.809672; input.actualHoldings = [0, 6];
    assert.equal(pendingSettlementWitness(input), null);
});

test('protocol auto redemption binds owned transfer, burn, official condition payout and exact pUSD mint', () => {
    const input = redeemInput(), before = clone(input);
    assert.deepEqual(verifyAutoRedeemReceipt(input), { hash: redeemHash, hashes: [redeemHash], blockNumber: 100,
        blockHash, cash: 5, holdings: [0, -5] });
    assert.deepEqual(input, before);
});

test('losing token redemption requires a zero payout and an explicit zero pUSD mint in its owned segment', () => {
    const input = redeemInput(); input.payout = [1, 0];
    input.receipt.logs[2] = log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
        [operator, collateral, zeroHash, conditionId, [1, 2], 0], 13);
    input.receipt.logs[3] = cashLog(zero, wallet, 0, 16);
    const before = clone(input);
    assert.deepEqual(verifyAutoRedeemReceipt(input), { hash: redeemHash, hashes: [redeemHash], blockNumber: 100,
        blockHash, cash: 0, holdings: [0, -5] });
    assert.deepEqual(input, before, 'zero-payout proof must not mutate the ledger');

    const noMint = clone(input); noMint.receipt.logs.pop();
    assert.equal(verifyAutoRedeemReceipt(noMint), null, 'an unknown no-mint redemption format stays unproven');
    const noBurn = clone(input); noBurn.receipt.logs.splice(1, 1);
    assert.equal(verifyAutoRedeemReceipt(noBurn), null);
    const mixedCash = clone(input); mixedCash.receipt.logs.push(cashLog(other, wallet, 1, 17));
    assert.equal(verifyAutoRedeemReceipt(mixedCash), null);
    const wrongPayout = clone(input); wrongPayout.payout = [0, 1];
    assert.equal(verifyAutoRedeemReceipt(wrongPayout), null);
});

test('other users in a batch do not become this wallet redemption', () => {
    const input = redeemInput();
    input.receipt.logs.unshift(log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens,
        [operator, other, operator, ['1', '2'], [0, 9000000]], 1),
    tokenLog(operator, zero, '2', 9000000, 2, operator),
    log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
        [operator, collateral, zeroHash, conditionId, [1, 2], 9000000], 3), cashLog(zero, other, 9000000, 4));
    assert.equal(verifyAutoRedeemReceipt(input)?.cash, 5);
    input.receipt.logs = input.receipt.logs.slice(0, 4);
    assert.equal(verifyAutoRedeemReceipt(input), null);
});

test('payout-looking transfers, wrong operator/condition/collateral, unburned shares and wrong official winner are rejected', () => {
    for (const mutate of [
        input => { input.payout = [1, 0]; },
        input => { input.payout = [.5, .5]; },
        input => { input.position.holdings = [0, 4]; },
        input => { input.position.orders = []; },
        input => { input.position.orders[0].settled = 4; },
        input => { input.position.orders[0].tokenId = '1'; },
        input => { input.position.receipts[redeemHash] = true; },
        input => { input.receipt.confirmations = 1; },
        input => { input.receipt.blockNumber = 101; },
        input => { input.receipt.logs.splice(1, 1); },
        input => { input.receipt.logs.splice(2, 1); },
        input => { input.receipt.logs[0] = log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens,
            [other, wallet, operator, ['1', '2'], [0, 5000000]], 10); },
        input => { input.receipt.logs[1] = tokenLog(operator, zero, '2', 4000000, 11, operator); },
        input => { input.receipt.logs[2] = log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
            [operator, collateral, zeroHash, zeroHash, [1, 2], 5000000], 13); },
        input => { input.receipt.logs[2] = log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
            [other, collateral, zeroHash, conditionId, [1, 2], 5000000], 13); },
        input => { input.receipt.logs[2] = log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
            [operator, CONTRACTS.collateralToken, zeroHash, conditionId, [1, 2], 5000000], 13); },
        input => { input.receipt.logs[3] = cashLog(other, wallet, 5000000, 16); },
        input => { input.receipt.logs.push(cashLog(other, wallet, 1, 17)); },
    ]) {
        const input = redeemInput(); mutate(input); assert.equal(verifyAutoRedeemReceipt(input), null);
    }
});

test('interleaved or duplicate payout segments cannot attribute another wallet payout to owned tokens', () => {
    const input = redeemInput();
    input.receipt.logs.splice(2, 0, tokenLog(other, operator, '2', 5000000, 12, operator));
    assert.equal(verifyAutoRedeemReceipt(input), null);
    const duplicate = redeemInput(); duplicate.receipt.logs.splice(3, 0,
        log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
            [operator, collateral, zeroHash, conditionId, [1, 2], 5000000], 14));
    assert.equal(verifyAutoRedeemReceipt(duplicate), null);
});
