import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { reconcilePeriodTrades } from '../../src/eligible-live/period-trades.js';

const hash = digit => `0x${digit.repeat(64)}`;
const wallet = `0x${'1'.repeat(40)}`, taker = `0x${'2'.repeat(40)}`;
const conditionId = hash('3'), transactionHash = hash('4'), blockHash = hash('5');
const proof = { blockNumber: 123, blockHash: hash('6') };
const tokens = ['101', '202'], collections = [hash('7'), hash('8')];
const legacyExchange = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const legacyCollateral = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)',
]);
const ctf = new ethers.utils.Interface([
    'function getOutcomeSlotCount(bytes32) view returns (uint256)',
    'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
    'function getPositionId(address,bytes32) view returns (uint256)',
]);

function maker(overrides = {}) {
    return { orderId: hash('9'), makerAddress: wallet, assetId: tokens[1], side: 'BUY',
        matchedAmount: '5', price: '0.4', ...overrides };
}

function trade(overrides = {}) {
    return { id: 'synthetic-trade-1', status: 'MINED', traderSide: 'MAKER', conditionId,
        transactionHash, assetId: tokens[0], side: 'BUY', size: '5', price: '0.6',
        makerOrders: [maker()], ...overrides };
}

function fill(order = maker(), overrides = {}, logIndex = 0) {
    const shares = ethers.utils.parseUnits(order.matchedAmount, 6);
    const principal = shares.mul(ethers.utils.parseUnits(order.price, 6)).add(500000).div(1000000);
    const buy = order.side === 'BUY', token = order.assetId ?? order.tokenId;
    const event = { orderHash: order.orderId, maker: order.makerAddress, taker,
        makerAssetId: buy ? '0' : token, takerAssetId: buy ? token : '0',
        makerAmountFilled: buy ? principal : shares, takerAmountFilled: buy ? shares : principal,
        fee: '0', ...overrides };
    const encoded = exchange.encodeEventLog(exchange.getEvent('OrderFilled'), [event.orderHash,
        event.maker, event.taker, event.makerAssetId, event.takerAssetId, event.makerAmountFilled,
        event.takerAmountFilled, event.fee]);
    return { ...encoded, address: legacyExchange, logIndex, transactionHash, blockHash,
        blockNumber: 120, removed: false };
}

function fixture() {
    const calls = { receipts: [], market: [], contracts: [], payout: [], holdings: [] };
    const f = { trades: [trade()], payout: [1, 0], holdings: [0, 0], outcomeSlots: 2,
        tokenIds: [...tokens], receipt: { transactionHash, blockHash, blockNumber: 120,
            status: 1, confirmations: 4, logs: [fill()] } };
    const provider = { _isProvider: true, call: async (transaction, blockTag) => {
        assert.equal(transaction.to.toLowerCase(), CONTRACTS.conditionalTokens.toLowerCase());
        assert.equal(blockTag, proof.blockNumber);
        const parsed = ctf.parseTransaction(transaction);
        calls.contracts.push(parsed.name);
        if (parsed.name === 'getOutcomeSlotCount') {
            assert.equal(parsed.args[0], conditionId);
            return ctf.encodeFunctionResult(parsed.name, [f.outcomeSlots]);
        }
        if (parsed.name === 'getCollectionId') {
            assert.equal(parsed.args[0], ethers.constants.HashZero);
            assert.equal(parsed.args[1], conditionId);
            const index = parsed.args[2].toNumber();
            assert.ok(index === 1 || index === 2);
            return ctf.encodeFunctionResult(parsed.name, [collections[index - 1]]);
        }
        assert.equal(parsed.name, 'getPositionId');
        assert.equal(parsed.args[0].toLowerCase(), legacyCollateral);
        const index = collections.indexOf(parsed.args[1]);
        assert.ok(index >= 0);
        return ctf.encodeFunctionResult(parsed.name, [f.tokenIds[index]]);
    } };
    const client = {
        rpc: { anchor: { number: proof.blockNumber, hash: proof.blockHash }, read: async (stage, task, block) => {
            assert.equal(stage, 'eligible_period_market'); assert.equal(block, proof.blockNumber);
            calls.market.push({ stage, block });
            return task(provider, block);
        } },
        verifiedReceipt: async (hash, block) => {
            calls.receipts.push({ hash, block });
            assert.equal(hash, transactionHash); assert.equal(block, proof.blockNumber);
            f.onReceipt?.();
            return f.receipt;
        },
        payoutAtBlock: async (condition, block) => {
            assert.equal(condition, conditionId); assert.equal(block, proof.blockNumber);
            calls.payout.push({ condition, block });
            f.onPayout?.();
            return f.payout;
        },
        holdings: async (ids, block) => {
            assert.deepEqual(ids, tokens); assert.equal(block, proof.blockNumber);
            calls.holdings.push({ ids, block });
            f.onHoldings?.();
            return f.holdings;
        },
    };
    return Object.assign(f, { client, calls, run: () => reconcilePeriodTrades(f.trades, { client, wallet, proof }) });
}

test('plain and prefixed terminal statuses need no receipt exception or RPC access', async () => {
    const result = await reconcilePeriodTrades(['CONFIRMED', 'FAILED', 'TRADE_STATUS_CONFIRMED',
        'TRADE_STATUS_FAILED'].map(status => ({ status })));
    assert.deepEqual(result, { apiTerminal: 4, receiptConfirmed: [] });
    assert.deepEqual(await reconcilePeriodTrades([]), { apiTerminal: 0, receiptConfirmed: [] });
});

test('historical maker proof uses the owned complementary token and price from makerOrders', async () => {
    const f = fixture();
    f.trades[0].makerOrders.push({ makerAddress: taker, orderId: 'unrelated-order' });
    const before = structuredClone(f.trades);
    const result = await f.run();
    assert.equal(result.apiTerminal, 0); assert.equal(result.receiptConfirmed.length, 1);
    const confirmed = result.receiptConfirmed[0];
    assert.equal(confirmed.tradeId, 'synthetic-trade-1');
    assert.equal(confirmed.transactionHash, transactionHash);
    assert.equal(confirmed.blockNumber, 120); assert.equal(confirmed.blockHash, blockHash);
    assert.deepEqual(confirmed.orders, [{ orderId: hash('9'), tokenId: tokens[1], shares: 5, principal: 2 }]);
    assert.deepEqual(f.trades, before);
    assert.deepEqual(f.calls.receipts, [{ hash: transactionHash, block: proof.blockNumber }]);
    assert.equal(f.calls.market.length, 1);
    assert.deepEqual(f.calls.contracts.sort(), ['getOutcomeSlotCount', 'getCollectionId',
        'getCollectionId', 'getPositionId', 'getPositionId'].sort());
    assert.deepEqual(f.calls.holdings, [{ ids: tokens, block: proof.blockNumber }]);
});

test('MATCHED and MINED status spellings can be proven alongside terminal rows', async t => {
    for (const status of ['MATCHED', 'MINED', 'TRADE_STATUS_MATCHED', 'TRADE_STATUS_MINED'])
        await t.test(status, async () => {
            const f = fixture(); f.trades[0].status = status;
            f.trades.push({ status: 'CONFIRMED' }, { status: 'TRADE_STATUS_FAILED' });
            const result = await f.run();
            assert.equal(result.apiTerminal, 2); assert.equal(result.receiptConfirmed.length, 1);
        });
});

test('one transaction proves multiple owned buy and sell orders independently', async () => {
    const f = fixture(), sell = maker({ orderId: hash('a'), assetId: tokens[0], side: 'SELL',
        matchedAmount: '3', price: '0.25' });
    f.trades[0].makerOrders.push(sell);
    f.receipt.logs.push(fill(sell, {}, 1));
    const result = await f.run();
    assert.deepEqual(result.receiptConfirmed[0].orders, [
        { orderId: hash('9'), tokenId: tokens[1], shares: 5, principal: 2 },
        { orderId: hash('a'), tokenId: tokens[0], shares: 3, principal: 0.75 },
    ]);
    assert.equal(f.calls.receipts.length, 1); assert.equal(f.calls.market.length, 1);
});

test('distinct API rows share one receipt only when the summed order quantity matches', async () => {
    const f = fixture();
    f.trades = [trade({ makerOrders: [maker({ matchedAmount: '2' })] }),
        trade({ id: 'synthetic-trade-2', makerOrders: [maker({ matchedAmount: '3' })] })];
    const result = await f.run();
    assert.deepEqual(result.receiptConfirmed.map(row => row.orders[0].shares), [2, 3]);
    assert.deepEqual(result.receiptConfirmed.map(row => row.orders[0].principal), [0.8, 1.2]);
    assert.equal(f.calls.receipts.length, 1); assert.equal(f.calls.market.length, 1);
});

test('separate fill logs may prove one order when their aggregate matches', async () => {
    const f = fixture();
    f.receipt.logs = [fill(maker({ matchedAmount: '2' })), fill(maker({ matchedAmount: '3' }), {}, 1)];
    assert.equal((await f.run()).receiptConfirmed[0].orders[0].shares, 5);
});

test('the tokenId alias and case-insensitive order hashes preserve ownership', async () => {
    const f = fixture();
    const owned = f.trades[0].makerOrders[0];
    owned.tokenId = owned.assetId; delete owned.assetId;
    owned.orderId = `0x${'A'.repeat(64)}`;
    f.receipt.logs = [fill(maker({ orderId: hash('a') }))];
    assert.equal((await f.run()).receiptConfirmed[0].orders[0].orderId, hash('a'));
});

test('duplicate rows or repeated owned order entries cannot reuse one fill', async t => {
    for (const [name, mutate] of [
        ['same trade ID', f => f.trades.push(structuredClone(f.trades[0]))],
        ['different trade IDs with duplicate quantities', f => f.trades.push(trade({ id: 'synthetic-trade-2' }))],
        ['same order twice in a trade', f => f.trades[0].makerOrders.push(maker())],
        ['conflicting same-order sides across rows', f => f.trades.push(trade({ id: 'synthetic-trade-2',
            makerOrders: [maker({ side: 'SELL' })] }))],
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f); await assert.rejects(f.run(), /eligible_period_/);
    });
});

test('missing, reverted, unconfirmed and inconsistent receipt identities fail closed', async t => {
    for (const [name, mutate] of [
        ['missing', f => { f.receipt = null; }],
        ['reverted', f => { f.receipt.status = 0; }],
        ['status missing', f => { delete f.receipt.status; }],
        ['unconfirmed', f => { f.receipt.confirmations = 1; }],
        ['confirmation missing', f => { delete f.receipt.confirmations; }],
        ['different transaction', f => { f.receipt.transactionHash = hash('b'); }],
        ['invalid block hash', f => { f.receipt.blockHash = 'invalid'; }],
        ['future block', f => { f.receipt.blockNumber = proof.blockNumber + 1; }],
        ['negative block', f => { f.receipt.blockNumber = -1; }],
        ['fractional block', f => { f.receipt.blockNumber = 120.5; }],
        ['missing logs', f => { delete f.receipt.logs; }],
        ['empty logs', f => { f.receipt.logs = []; }],
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f); await assert.rejects(f.run(), /eligible_period_/);
    });
});

test('receipt logs must prove the exact legacy exchange, order, maker, token and amounts', async t => {
    for (const [name, mutate] of [
        ['different exchange', log => { log.address = taker; }],
        ['invalid exchange address', log => { log.address = 'invalid'; }],
        ['removed log', log => { log.removed = true; }],
        ['different log transaction', log => { log.transactionHash = hash('b'); }],
        ['different log block hash', log => { log.blockHash = hash('b'); }],
        ['different log block number', log => { log.blockNumber = 119; }],
        ['missing index', log => { delete log.logIndex; }],
        ['negative index', log => { log.logIndex = -1; }],
        ['invalid data', log => { log.data = '0xgg'; }],
        ['truncated fill data', log => { log.data = '0x'; }],
        ['invalid topic', log => { log.topics[1] = 'invalid'; }],
        ['unrelated event', log => { log.topics[0] = hash('b'); }],
        ['different order', log => Object.assign(log, fill(maker(), { orderHash: hash('b') }))],
        ['different maker wallet', log => Object.assign(log, fill(maker(), { maker: taker }))],
        ['top-level asset instead of maker asset', log => Object.assign(log, fill(maker(), { takerAssetId: tokens[0] }))],
        ['noncollateral maker asset', log => Object.assign(log, fill(maker(), { makerAssetId: tokens[0] }))],
        ['different shares', log => Object.assign(log, fill(maker(), { takerAmountFilled: '4999999' }))],
        ['different principal', log => Object.assign(log, fill(maker(), { makerAmountFilled: '2000002' }))],
        ['zero principal', log => Object.assign(log, fill(maker(), { makerAmountFilled: '0' }))],
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f.receipt.logs[0]); await assert.rejects(f.run(), /eligible_period_/);
    });
    const f = fixture();
    f.receipt.logs = [fill(maker({ matchedAmount: '2' })), fill(maker({ matchedAmount: '3' }))];
    await assert.rejects(f.run(), /eligible_period_/);
});

test('principal rounding permits only a single collateral micro-unit', async t => {
    for (const delta of [-2, -1, 0, 1, 2]) await t.test(String(delta), async () => {
        const f = fixture();
        f.receipt.logs = [fill(maker(), { makerAmountFilled: String(2000000 + delta) })];
        if (Math.abs(delta) <= 1) assert.equal((await f.run()).receiptConfirmed.length, 1);
        else await assert.rejects(f.run(), /eligible_period_/);
    });
});

test('official market resolution and zero balances of both derived outcomes are required', async t => {
    for (const [name, mutate] of [
        ['unresolved payout', f => { f.payout = null; }],
        ['zero payout', f => { f.payout = [0, 0]; }],
        ['missing payout leg', f => { f.payout = [1]; }],
        ['nonfinite payout', f => { f.payout = [Infinity, 0]; }],
        ['negative payout', f => { f.payout = [-1, 2]; }],
        ['payout above one', f => { f.payout = [1, 1]; }],
        ['string payout', f => { f.payout = ['1', '0']; }],
        ['held traded token', f => { f.holdings = [0, 0.000001]; }],
        ['held complementary token', f => { f.holdings = [1, 0]; }],
        ['missing holdings', f => { f.holdings = null; }],
        ['missing balance leg', f => { f.holdings = [0]; }],
        ['string balance', f => { f.holdings = [0, '0']; }],
        ['nonbinary condition', f => { f.outcomeSlots = 3; }],
        ['unprepared condition', f => { f.outcomeSlots = 0; }],
        ['duplicate derived tokens', f => { f.tokenIds = [tokens[0], tokens[0]]; }],
        ['zero derived token', f => { f.tokenIds = ['0', tokens[1]]; }],
        ['order token not derived from condition', f => { f.trades[0].makerOrders[0].assetId = '303'; }],
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f); await assert.rejects(f.run(), /eligible_period_/);
    });
    const f = fixture(); f.payout = [0.5, 0.5];
    assert.equal((await f.run()).receiptConfirmed.length, 1);
});

test('snapshot anchor mismatches before or during proof cannot authorize the period', async t => {
    for (const [name, mutate] of [
        ['initial hash', f => { f.client.rpc.anchor.hash = hash('b'); }],
        ['initial block number', f => { f.client.rpc.anchor.number = 124; }],
        ['missing anchor', f => { f.client.rpc.anchor = null; }],
        ['receipt read changes anchor', f => { f.onReceipt = () => { f.client.rpc.anchor.hash = hash('b'); }; }],
        ['payout read changes anchor', f => { f.onPayout = () => { f.client.rpc.anchor.hash = hash('b'); }; }],
        ['holdings read changes anchor', f => { f.onHoldings = () => { f.client.rpc.anchor.number++; }; }],
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f); await assert.rejects(f.run(), /eligible_period_invalid_snapshot/);
    });
});

test('unknown statuses, taker trades and incomplete maker fields remain pending', async t => {
    for (const [name, mutate] of [
        ...['RETRYING', 'TRADE_STATUS_RETRYING', 'PENDING', 'unknown', '', null].map(status =>
            [`status ${status}`, f => { f.trades[0].status = status; }]),
        ['taker', f => { f.trades[0].traderSide = 'TAKER'; }],
        ['missing role', f => { delete f.trades[0].traderSide; }],
        ['missing trade ID', f => { delete f.trades[0].id; }],
        ['missing transaction', f => { delete f.trades[0].transactionHash; }],
        ['missing condition', f => { delete f.trades[0].conditionId; }],
        ['missing makerOrders', f => { delete f.trades[0].makerOrders; }],
        ['empty makerOrders', f => { f.trades[0].makerOrders = []; }],
        ['unowned maker', f => { f.trades[0].makerOrders[0].makerAddress = taker; }],
        ['missing order ID', f => { delete f.trades[0].makerOrders[0].orderId; }],
        ['missing token', f => { delete f.trades[0].makerOrders[0].assetId; }],
        ['conflicting token aliases', f => { f.trades[0].makerOrders[0].tokenId = tokens[0]; }],
        ['missing side', f => { delete f.trades[0].makerOrders[0].side; }],
        ['unknown side', f => { f.trades[0].makerOrders[0].side = 'UNKNOWN'; }],
        ...['0', '-1', 'NaN', '', null, '0.0000001'].map(value =>
            [`shares ${value}`, f => { f.trades[0].makerOrders[0].matchedAmount = value; }]),
        ...['0', '-0.1', '1', '1.1', 'Infinity', '', null].map(value =>
            [`price ${value}`, f => { f.trades[0].makerOrders[0].price = value; }]),
    ]) await t.test(name, async () => {
        const f = fixture(); mutate(f); await assert.rejects(f.run(), /eligible_period_trades_pending/);
    });
    for (const rows of [null, {}, [null], [[]], ['CONFIRMED']])
        await assert.rejects(reconcilePeriodTrades(rows), /eligible_period_trades_pending/);
});
