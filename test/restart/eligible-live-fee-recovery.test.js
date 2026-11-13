import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { verifyOwnedFillReceipt } from '../../src/laya-live/settlement.js';
import { applyFeeRecovery, matchesFeeRecoveryIncident, prepareFeeRecovery } from '../../src/eligible-live/fee-recovery.js';

const wallet = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`;
const transactionHash = `0x${'a'.repeat(64)}`, blockHash = `0x${'b'.repeat(64)}`;
const anchorHash = `0x${'c'.repeat(64)}`, conditionId = `0x${'d'.repeat(64)}`;
const foreignHash = `0x${'e'.repeat(64)}`, zeroHash = ethers.constants.HashZero;
const periodId = '1122334455667788', runtimeId = '8899aabbccddeeff';
const openedAt = 1780000000000, stoppedAt = openedAt + 120000;
const jsonHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const orderIdentity = order => Object.fromEntries([
    'orderId', 'tokenId', 'index', 'side', 'kind', 'shares', 'price', 'cost', 'signed', 'submittedAt',
].map(key => [key, order[key]]));
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const log = (iface, event, address, args, logIndex) => ({ address, logIndex,
    ...iface.encodeEventLog(iface.getEvent(event), args) });

function receiptFor(orderId, { principal = 4400000, quantity = 6376812, fee = 95480, tokenId = '2' } = {}) {
    return { transactionHash, blockHash, status: 1, confirmations: 3, blockNumber: 99,
        logs: [log(erc20, 'Transfer', CONTRACTS.collateralToken, [wallet, other, principal + fee], 10),
            log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [other, other, wallet, tokenId, quantity], 11),
            log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                [orderId, wallet, other, 0, tokenId, principal, quantity, fee, zeroHash, zeroHash], 12)] };
}

function fixture() {
    const signed = { salt: '1', maker: wallet, signer: wallet, tokenId: '2', makerAmount: '4400000',
        takerAmount: '5000000', side: 'BUY', signatureType: 2, timestamp: String(openedAt),
        metadata: zeroHash, builder: zeroHash, expiration: 0, orderType: 'FAK' };
    const types = { Order: [['salt', 'uint256'], ['maker', 'address'], ['signer', 'address'], ['tokenId', 'uint256'],
        ['makerAmount', 'uint256'], ['takerAmount', 'uint256'], ['side', 'uint8'], ['signatureType', 'uint8'],
        ['timestamp', 'uint256'], ['metadata', 'bytes32'], ['builder', 'bytes32']].map(([name, type]) => ({ name, type })) };
    const orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2',
        chainId: 137, verifyingContract: CONTRACTS.standardExchange }, types, { ...signed, side: 0 });
    const order = { orderId, tokenId: '2', index: 1, side: 'BUY', kind: 'taker', shares: 5,
        price: .88, cost: 4.48696, signed, submittedAt: openedAt, postAttemptAt: openedAt,
        settled: 0, filled: 6.376812, status: 'unknown', apiSubmissionStatus: 'matched',
        transactions: [transactionHash], tradeIds: ['fee-fill'] };
    const position = { market: { slug: 'btc-fee-incident', conditionId, tokens: ['1', '2'], negRisk: false,
        end: openedAt + 300000, fee: { rate: .07, exponent: 1 } }, openedAt, startingCash: 20,
        orders: [order], actions: [], fills: [], receipts: {}, holdings: [0, 0], bought: [0, 0],
        entryCost: 0, fees: 0, gas: 0, rebate: 0, payout: null, pendingTrades: true,
        pendingSince: openedAt, uncertain: true,
        receiptRetries: { [transactionHash]: { attempts: 4, nextAt: Number.MAX_SAFE_INTEGER } } };
    const state = { version: 1, baseline: periodId, mode: 'pilot', strategy: 'late-entry', decisionProvider: 'eligible',
        startedAt: openedAt - 3600000, cash: 20, peakEquity: 22, maxDrawdown: 3, walletStart: 21,
        walletCashDelta: -1, failures: 0, dataGaps: 0, events: 20, position,
        liveFunding: { at: openedAt - 3600000, initialCapital: 21, capitalCap: null, allocation: 'available_balance' },
        externalWalletActivity: { cashDelta: -.25, receipts: [{ hash: 'reviewed-external', cash: -.25 }] },
        completed: Array.from({ length: 4 }, (_, index) => ({ market: `old-${index}`, traded: true,
            pnl: -.25, fees: .05, gas: 0, closedAt: openedAt - (4 - index) * 300000 })),
        seen: { 'old-0': true, 'old-1': true, 'old-2': true, 'old-3': true, 'btc-fee-incident': true },
        stopped: { reason: 'trade_receipt_mapping_mismatch', at: stoppedAt },
        reconciliationFaults: { trade_receipt_mapping_mismatch: { count: 4,
            firstAt: stoppedAt, lastAt: stoppedAt + 30000, last: { hash: transactionHash } } } };
    const incident = { reason: 'verified_fill_fee_above_estimate', stop: clone(state.stopped), orderId,
        transactionHash, conditionId, openedAt, receiptBlockNumber: 99, receiptBlockHash: blockHash,
        completedSha256: jsonHash(state.completed), seenSha256: jsonHash(state.seen),
        orderIdentitySha256: jsonHash(orderIdentity(order)) };
    const config = { id: periodId, runtimeId, settings: { ...BASELINE, wallet, fingerprint: periodId,
        entryCap: 5, shares: 5, drawdownStop: 10, pilotHours: Infinity, pilotMarkets: Infinity },
        runtimeContinuation: { periodId, originalRuntimeId: '0011223344556677', runtimeId,
            ledgerStartedAt: state.startedAt, fundingSha256: jsonHash(state.liveFunding), incident } };
    const trade = { id: 'fee-fill', conditionId, assetId: '2', side: 'BUY', traderSide: 'TAKER',
        takerOrderId: orderId, size: '6.376812', price: '.69', status: 'CONFIRMED', transactionHash };
    const f = { config, state, position, order, incident, trade, receipt: receiptFor(orderId),
        account: { orders: [], trades: [trade] }, balance: 15.25452, holdings: [0, 6.376812], payout: [1, 0],
        calls: [], financialCalls: [], saves: [], events: [] };
    f.client = {
        rpc: { anchor: { number: 100, hash: anchorHash } },
        confirmedBlock: async () => { f.calls.push(['block']); return 100; },
        verifiedReceipt: async (hash, block) => {
            f.calls.push(['receipt', hash, block]); assert.equal(hash, transactionHash); assert.equal(block, 100); return f.receipt;
        },
        ordersAndTrades: async (...args) => { f.calls.push(['account', ...args]);
            assert.equal(args.length, 0, 'The review must inspect all account orders'); return f.account; },
        balance: async block => { f.calls.push(['balance', block]); assert.equal(block, 100); return f.balance; },
        holdings: async (tokens, block) => { f.calls.push(['holdings', tokens, block]);
            assert.deepEqual(tokens, ['1', '2']); assert.equal(block, 100); return f.holdings; },
        payoutAtBlock: async (condition, block) => { f.calls.push(['payout', condition, block]);
            assert.equal(condition, conditionId); assert.equal(block, 100); return f.payout; },
    };
    for (const method of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction', 'redeem', 'transfer', 'sendTransaction'])
        f.client[method] = async () => { f.financialCalls.push(method); assert.fail(`Recovery called ${method}`); };
    f.store = { state, save() { f.saves.push(clone(this.state)); },
        event(type, detail) { f.events.push({ type, ...clone(detail) }); } };
    f.prepare = () => prepareFeeRecovery(config, state, f.client);
    return f;
}

test('fee recovery reviews the exact receipt without mutating state or submitting financial actions', async () => {
    const f = fixture(), before = clone(f.state), configBefore = clone(f.config);
    const accountBefore = clone(f.account), receiptBefore = clone(f.receipt);
    const input = { position: f.position, wallet, block: 100, receipt: f.receipt };
    assert.equal(verifyOwnedFillReceipt(input), null, 'The original estimate must actually reject this receipt');
    assert.equal(verifyOwnedFillReceipt({ ...input, entryCap: 5 }).cash, -4.49548);
    const review = await f.prepare();
    assert.equal(review.beforeSha256, jsonHash(before));
    assert.deepEqual(f.state, before); assert.deepEqual(f.config, configBefore);
    assert.deepEqual(f.account, accountBefore); assert.deepEqual(f.receipt, receiptBefore);
    assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.ready, true);
    assert.equal(review.summary.reason, 'verified_fill_fee_above_estimate');
    assert.equal(review.summary.actualEntryCost, 4.49548); assert.equal(review.summary.estimatedEntryCost, 4.48696);
    assert.equal(review.summary.shares, 6.376812); assert.equal(review.summary.fees, .09548);
    assert.equal(review.summary.financialWrites, false); assert.equal(review.summary.inventoryOpen, true);
    assert.equal(review.summary.payoutValue, 0); assert.deepEqual(review.summary.payout, [1, 0]);
    const next = review.nextState, position = next.position, order = position.orders[0];
    assert.equal(next.cash, 15.50452); assert.equal(next.walletCashDelta, -5.49548);
    assert.equal(expectedWalletBalance(next), f.balance);
    assert.equal(position.entryCost, 4.49548); assert.equal(position.fees, .09548);
    assert.deepEqual(position.holdings, [0, 6.376812]); assert.deepEqual(position.bought, [0, 6.376812]);
    assert.equal(order.shares, 5); assert.equal(order.filled, 6.376812); assert.equal(order.settled, 6.376812);
    assert.equal(order.settledPrincipal, 4.4); assert.equal(order.receiptProvenComplete, true);
    assert.equal(order.receiptTerminal.source, 'signed_cash_exhausted'); assert.equal(order.status, 'complete');
    assert.equal(position.pendingTrades, false); assert.equal(position.uncertain, false);
    assert.equal(position.fills.length, 1); assert.deepEqual(position.fills[0].tradeIds, ['fee-fill']);
    assert.deepEqual(position.actions, []); assert.deepEqual(Object.keys(position.receipts), [transactionHash]);
    assert.equal(next.settlementEvidence[transactionHash].cash, -4.49548);
    assert.equal(next.settlementEvidence[transactionHash].principal, 4.4);
    assert.equal(next.settlementEvidence[transactionHash].fees, .09548);
    assert.equal(next.stopped, null); assert.deepEqual(next.reconciliationFaults, {});
    for (const key of ['baseline', 'startedAt', 'walletStart', 'liveFunding', 'completed', 'seen', 'externalWalletActivity'])
        assert.deepEqual(next[key], before[key], key);
    assert.equal(next.completed.length, 4); assert.equal(next.peakEquity, 22);
    assert.equal(next.lastEquity, next.cash); assert.ok(Math.abs(next.maxDrawdown - 6.49548) < 1e-9);
    assert.equal(next.liveRiskStop, undefined);
    assert.equal(next.stopHistory.length, 1);
    const archived = next.stopHistory[0];
    assert.equal(archived.reason, before.stopped.reason); assert.equal(archived.at, before.stopped.at);
    assert.equal(archived.reasonVerified, f.incident.reason); assert.equal(archived.runtimeId, runtimeId);
    assert.deepEqual(archived.originalFault, before.reconciliationFaults.trade_receipt_mapping_mismatch);
    assert.equal(archived.originalUncertain, true); assert.deepEqual(archived.evidence, [transactionHash]);
    assert.equal(archived.blockNumber, 100); assert.equal(archived.blockHash, anchorHash);
});

test('recovery incident matching requires the original period and stop and refuses a consumed approval', async t => {
    const original = fixture(), before = clone(original.state);
    assert.equal(matchesFeeRecoveryIncident(original.config, original.state), true);
    assert.equal(matchesFeeRecoveryIncident(original.config, null), false);
    assert.deepEqual(original.state, before);
    const cases = {
        'missing continuation': f => { delete f.config.runtimeContinuation; },
        'missing incident': f => { delete f.config.runtimeContinuation.incident; },
        'different recovery reason': f => { f.config.runtimeContinuation.incident.reason = 'btc_twap_source_mismatch'; },
        'another approved period': f => { f.config.runtimeContinuation.periodId = runtimeId; },
        'another active period': f => { f.config.id = runtimeId; },
        'another ledger period': f => { f.state.baseline = runtimeId; },
        'no active stop': f => { f.state.stopped = null; },
        'another stop reason': f => { f.state.stopped.reason = 'drawdown_limit'; },
        'another stop timestamp': f => { f.state.stopped.at++; },
        'already consumed incident': f => { f.state.stopHistory = [{ ...f.incident.stop,
            reasonVerified: f.incident.reason, recoveredAt: stoppedAt + 60000 }]; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
        const f = fixture(); mutate(f); const before = clone(f.state);
        assert.equal(matchesFeeRecoveryIncident(f.config, f.state), false);
        await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
        assert.deepEqual(f.state, before); assert.deepEqual(f.calls, []);
        assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []);
    });
    for (const field of ['at', 'reason', 'reasonVerified']) await t.test(`unrelated archived ${field}`, () => {
        const f = fixture(), stop = { ...f.incident.stop, reasonVerified: f.incident.reason };
        stop[field] = field === 'at' ? stoppedAt - 1 : 'another_incident';
        f.state.stopHistory = [stop];
        assert.equal(matchesFeeRecoveryIncident(f.config, f.state), true);
    });
});

test('fee recovery refuses unreviewed identity, history, stops, other faults and previously accounted fills', async t => {
    const cases = {
        'missing approval': f => { delete f.config.runtimeContinuation; },
        'wrong incident reason': f => { f.incident.reason = 'reset_losses'; },
        'different period': f => { f.config.id = runtimeId; },
        'different provider': f => { f.state.decisionProvider = 'laya'; },
        'paper ledger': f => { f.state.mode = 'paper'; },
        'another strategy': f => { f.state.strategy = 'maker-mm'; },
        'changed completed history': f => { f.state.completed[0].pnl = 0; },
        'changed seen markets': f => { f.state.seen['old-4'] = true; },
        'changed signed order': f => { f.order.signed.makerAmount = '4400001'; },
        'changed order estimate': f => { f.order.cost = 4.4; },
        'changed order submission': f => { f.order.submittedAt++; },
        'changed stop timestamp': f => { f.state.stopped.at++; },
        'different stop': f => { f.state.stopped.reason = 'wallet_ledger_mismatch'; },
        'risk latch': f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: stoppedAt }; },
        'historical drawdown limit': f => { f.state.maxDrawdown = 10; },
        'additional reconciliation fault': f => { f.state.reconciliationFaults.invalid_owned_trade = { count: 1 }; },
        'different faulty receipt': f => { f.state.reconciliationFaults.trade_receipt_mapping_mismatch.last.hash = foreignHash; },
        'entry hold': f => { f.state.entryHolds = { broker_account: { retryable: true } }; },
        'existing receipt': f => { f.position.receipts[transactionHash] = { cash: -4.49548 }; },
        'existing fill': f => { f.position.fills.push({ hash: transactionHash }); },
        'existing holdings': f => { f.position.holdings[1] = 1; },
        'existing bought shares': f => { f.position.bought[1] = 1; },
        'existing entry cost': f => { f.position.entryCost = 1; },
        'existing gas': f => { f.position.gas = .001; },
        'existing rebate': f => { f.position.rebate = .001; },
        'pending action': f => { f.position.actions.push({ kind: 'redeem', status: 'submitted' }); },
        'another owned order': f => { f.position.orders.push(clone(f.order)); },
        'another settlement hash': f => { f.order.transactions.push(foreignHash); },
        'failed trade': f => { f.position.failedTrades = { 'fee-fill': true }; },
        'position no longer uncertain': f => { f.position.uncertain = false; },
        'position no longer pending': f => { f.position.pendingTrades = false; },
        'risk threshold changed': f => { f.config.settings.drawdownStop = 20; },
        'entry cap changed': f => { f.config.settings.entryCap = 6; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
        const f = fixture(); mutate(f); const before = clone(f.state);
        await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
        assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []); assert.deepEqual(f.saves, []);
    });
});

test('fee recovery requires exact confirmed receipt, wallet, inventory, global account and official payout', async t => {
    const cases = {
        'receipt absent': f => { f.receipt = null; },
        'receipt failed': f => { f.receipt.status = 0; },
        'receipt not confirmed': f => { f.receipt.confirmations = 1; },
        'different receipt hash': f => { f.receipt.transactionHash = foreignHash; },
        'different receipt block': f => { f.receipt.blockNumber++; },
        'different canonical receipt block': f => { f.receipt.blockHash = foreignHash; },
        'receipt logs incomplete': f => { f.receipt.logs.pop(); },
        'wrong receipt token': f => { f.receipt = receiptFor(f.order.orderId, { tokenId: '1' }); },
        'wrong receipt order': f => { f.receipt = receiptFor(foreignHash); },
        'principal not exhausted': f => { f.receipt = receiptFor(f.order.orderId, { principal: 4399999 }); },
        'principal exceeds signed authorization': f => { f.receipt = receiptFor(f.order.orderId, { principal: 4400001 }); },
        'fee exceeds fixed entry cap': f => { f.receipt = receiptFor(f.order.orderId, { fee: 600001 }); },
        'original estimate already sufficient': f => { f.receipt = receiptFor(f.order.orderId, { fee: 80000 }); },
        'cash one micro too high': f => { f.balance += .000001; },
        'cash one micro too low': f => { f.balance -= .000001; },
        'one micro share missing': f => { f.holdings[1] -= .000001; },
        'unexplained other token': f => { f.holdings[0] = .000001; },
        'already redeemed inventory': f => { f.holdings = [0, 0]; },
        'resolution missing': f => { f.payout = null; },
        'invalid binary resolution': f => { f.payout = [.5, .5]; },
        'contradictory saved resolution': f => { f.position.payout = [0, 1]; },
        'foreign open order outside current market': f => { f.account.orders.push({ id: foreignHash, conditionId: foreignHash }); },
        'owned order still open': f => { f.account.orders.push({ id: f.order.orderId }); },
        'missing owned trade': f => { f.account.trades = []; },
        'another owned trade': f => { f.account.trades.push({ ...f.trade, id: 'extra' }); },
        'trade only mined': f => { f.trade.status = 'MINED'; },
        'trade failed': f => { f.trade.status = 'FAILED'; },
        'wrong trade transaction': f => { f.trade.transactionHash = foreignHash; },
        'wrong trade condition': f => { f.trade.conditionId = foreignHash; },
        'wrong trade asset': f => { f.trade.assetId = '1'; },
        'wrong trade side': f => { f.trade.side = 'SELL'; },
        'wrong trade role': f => { f.trade.traderSide = 'MAKER'; },
        'wrong trade quantity': f => { f.trade.size = '6.376811'; },
        'wrong trade price': f => { f.trade.price = '.70'; },
        'wrong persisted trade id': f => { f.order.tradeIds = ['another-trade']; },
        'wrong anchor height': f => { f.client.rpc.anchor.number++; },
        'missing anchor hash': f => { delete f.client.rpc.anchor.hash; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
        const f = fixture(); mutate(f); const before = clone(f.state);
        await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
        assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []); assert.deepEqual(f.saves, []);
    });
});

test('official losing payout preserves maximum drawdown and blocks recovery at the existing risk limit', async () => {
    const f = fixture(); f.state.peakEquity = 25.50452;
    const before = clone(f.state);
    await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
    assert.deepEqual(f.state, before); assert.deepEqual(f.saves, []);
    const priorMaximum = fixture(); priorMaximum.state.maxDrawdown = 9;
    const review = await priorMaximum.prepare();
    assert.equal(review.nextState.maxDrawdown, 9); assert.equal(review.nextState.peakEquity, 22);
});

test('unproven foreign account trades block fee recovery even when the incident wallet and tokens match', async t => {
    for (const status of ['MATCHED', 'MINED', 'RETRYING', 'TRADE_STATUS_MATCHED',
        'TRADE_STATUS_MINED', 'TRADE_STATUS_RETRYING']) {
        for (const traderSide of ['MAKER', 'TAKER']) await t.test(`${traderSide} ${status}`, async () => {
            const f = fixture(), foreignReceiptReads = [], readReceipt = f.client.verifiedReceipt;
            const foreignTrade = { id: 'unresolved-other-market', status, traderSide,
                conditionId: foreignHash, transactionHash: foreignHash, takerOrderId: foreignHash,
                assetId: '202', side: 'BUY', size: '5', price: '.4',
                makerOrders: [{ orderId: foreignHash, makerAddress: wallet, assetId: '202',
                side: 'BUY', matchedAmount: '5', price: '0.4' }] };
            f.account.trades.push(foreignTrade);
            f.client.verifiedReceipt = async (hash, block) => {
                if (hash !== foreignHash) return readReceipt(hash, block);
                foreignReceiptReads.push({ hash, block });
                return null;
            };
            const before = clone(f.state), accountBefore = clone(f.account);
            await assert.rejects(f.prepare, /eligible_period_trades_pending/);
            assert.deepEqual(f.state, before); assert.deepEqual(f.account, accountBefore);
            assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []); assert.deepEqual(f.financialCalls, []);
            assert.equal(f.state.cash, 20); assert.deepEqual(f.position.receipts, {});
            const receiptRequired = traderSide === 'MAKER' && !status.endsWith('RETRYING');
            assert.deepEqual(foreignReceiptReads, receiptRequired ? [{ hash: foreignHash, block: 100 }] : []);
        });
    }
});

test('terminal foreign account trades preserve their history without adding fill accounting or receipt reads', async t => {
    for (const status of ['CONFIRMED', 'FAILED', 'TRADE_STATUS_CONFIRMED', 'TRADE_STATUS_FAILED'])
        await t.test(status, async () => {
            const f = fixture(), before = clone(f.state);
            f.account.trades.push({ id: 'historical-other-market', status, conditionId: foreignHash,
                transactionHash: foreignHash, takerOrderId: foreignHash, assetId: '202',
                side: 'BUY', traderSide: 'TAKER', size: '5', price: '.4' });
            const accountBefore = clone(f.account), review = await f.prepare(), next = review.nextState;
            assert.equal(review.summary.ready, true);
            assert.deepEqual(f.state, before); assert.deepEqual(f.account, accountBefore);
            assert.equal(next.cash, 15.50452); assert.equal(next.walletCashDelta, -5.49548);
            assert.equal(next.position.fills.length, 1);
            assert.deepEqual(next.position.fills[0].tradeIds, ['fee-fill']);
            assert.deepEqual(Object.keys(next.settlementEvidence), [transactionHash]);
            assert.deepEqual(next.completed, before.completed); assert.deepEqual(next.seen, before.seen);
            assert.deepEqual(f.calls.filter(call => call[0] === 'receipt'), [['receipt', transactionHash, 100]]);
            assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []); assert.deepEqual(f.financialCalls, []);
        });
});

test('fee recovery rejects state or confirmed anchor changes during the review', async t => {
    for (const target of ['ledger', 'anchor']) await t.test(target, async () => {
        const f = fixture(), read = f.client.balance;
        f.client.balance = async block => {
            if (target === 'ledger') f.state.events++;
            else f.client.rpc.anchor.hash = foreignHash;
            return read(block);
        };
        await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
        assert.equal(f.state.stopped.reason, 'trade_receipt_mapping_mismatch');
        assert.equal(f.state.cash, 20); assert.deepEqual(f.position.holdings, [0, 0]);
        assert.deepEqual(f.financialCalls, []); assert.deepEqual(f.saves, []);
    });
});

test('apply requires explicit live activation and the exact reviewed ledger, then commits once', async () => {
    const f = fixture(), before = clone(f.state), originalState = f.state, review = await f.prepare();
    await assert.rejects(async () => applyFeeRecovery(f.store, review), /eligible_fee_recovery_unproven/);
    await assert.rejects(async () => applyFeeRecovery(f.store, review, { explicitLive: false }), /eligible_fee_recovery_unproven/);
    assert.deepEqual(f.state, before); assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []);
    f.state.events++;
    await assert.rejects(async () => applyFeeRecovery(f.store, review, { explicitLive: true }), /eligible_fee_recovery_unproven/);
    assert.deepEqual(f.saves, []); assert.deepEqual(f.events, []);
    f.state.events--;
    applyFeeRecovery(f.store, review, { explicitLive: true });
    assert.equal(f.store.state, originalState, 'Runner references must keep the same state object');
    assert.equal(f.saves.length, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].type, 'eligible_fee_receipt_recovered');
    assert.equal(f.saves[0].stopped, null); assert.equal(f.saves[0].cash, 15.50452);
    assert.equal(f.saves[0].position.fills.length, 1); assert.equal(f.saves[0].stopHistory.length, 1);
    assert.deepEqual(f.state.completed, before.completed); assert.equal(f.state.walletStart, before.walletStart);
    const committed = clone(f.state);
    await assert.rejects(async () => applyFeeRecovery(f.store, review, { explicitLive: true }), /eligible_fee_recovery_unproven/);
    await assert.rejects(f.prepare, /eligible_fee_recovery_unproven/);
    assert.deepEqual(f.state, committed); assert.equal(f.saves.length, 1); assert.equal(f.events.length, 1);
    assert.deepEqual(f.financialCalls, []);
});
