import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { evidenceHash, incidentEvidenceHash, operationalFailureHash, recoverSettlementStop, settlementStopCandidate } from '../../src/laya-live/settlement-recovery.js';

function fixture() {
    const hash = n => `0x${String(n).repeat(64)}`;
    const a = { reason: 'reviewed_sdk_fill_and_protocol_auto_redeem', stop: { reason: 'wallet_ledger_mismatch', at: 200 },
        startedAt: 100, startingCash: 22.270941, walletStart: 22.270941, walletCashDeltaBefore: 0,
        slug: 'btc-updown-5m-example', conditionId: hash(1), orderId: hash(2), fillHash: hash(3), redeemHash: hash(4),
        fillBlockNumber: 100, fillBlockHash: hash(5), redeemBlockNumber: 110, redeemBlockHash: hash(6),
        shares: 5, index: 1, tokens: ['111', '222'], payout: [0, 1], limitPrice: .79,
        entryCost: 4.00806, fee: .05806, profit: .99194 };
    a.peakEquityBefore = a.startingCash; a.maxDrawdownBefore = 0;
    const state = { baseline: 'same-period', mode: 'pilot', decisionProvider: 'laya', startedAt: 100,
        stopped: { ...a.stop }, cash: 23.262881, walletStart: a.walletStart, walletCashDelta: a.profit,
        peakEquity: 23.262881, maxDrawdown: 0, liveFunding: { initialCapital: a.startingCash },
        externalWalletActivity: { cashDelta: -1.447987, receipts: [{ hash: hash(7), cash: -1.447987 }] },
        seen: { [a.slug]: { at: 190, cost: 4.05807 } }, ai: { providers: { laya: { pending: null } } },
        position: null, completed: [{ traded: false, pnl: 0 }, { traded: false, pnl: 0 }, {
            slug: a.slug, conditionId: a.conditionId, tokens: a.tokens, payout: a.payout,
            traded: true, uncertain: false, pnl: a.profit, fees: a.fee, entryCost: a.entryCost, gas: 0, rebate: 0,
            orders: [{ orderId: a.orderId, tokenId: a.tokens[1], index: 1, side: 'BUY', price: .79,
                shares: 5, filled: 5, settled: 5, status: 'complete' }],
            fills: [{ orderId: a.orderId, hash: a.fillHash, shares: 5 }],
        }], settlementEvidence: {
            [a.fillHash]: { source: 'receipt', hash: a.fillHash, kind: 'fill', conditionId: a.conditionId,
                orderId: a.orderId, cash: -a.entryCost, holdings: [0, 5], fees: a.fee,
                blockNumber: a.fillBlockNumber, blockHash: a.fillBlockHash },
            [a.redeemHash]: { source: 'receipt', hash: a.redeemHash, kind: 'protocol_auto_redeem', conditionId: a.conditionId,
                cash: 5, holdings: [0, -5], blockNumber: a.redeemBlockNumber, blockHash: a.redeemBlockHash },
        } };
    Object.assign(a, { externalSha256: evidenceHash(state.externalWalletActivity), fundingSha256: evidenceHash(state.liveFunding),
        seenSha256: evidenceHash(state.seen), completedBeforeSha256: evidenceHash(state.completed.slice(0, -1)) });
    const config = { id: state.baseline, runtimeId: 'reviewed-runtime',
        settings: { drawdownStop: 2, pilotMarkets: 30, pilotHours: 48 }, continuation: { settlementRecovery: a } };
    const calls = [];
    const client = { confirmedBlock: async () => 120, balance: async block => { calls.push(block); return 21.814894; },
        holdings: async (tokens, block) => { assert.deepEqual(tokens, a.tokens); calls.push(block); return [0, 0]; },
        ordersAndTrades: async () => ({ orders: [], trades: [] }), verifiedReceipt: async (hash, block) => {
            calls.push(block); const prefix = hash === a.fillHash ? 'fill' : 'redeem';
            return { status: 1, confirmations: 10, blockNumber: a[`${prefix}BlockNumber`],
                blockHash: a[`${prefix}BlockHash`], transactionHash: hash };
        } };
    const store = { state, events: [], event(type, detail) { this.events.push({ type, detail }); } };
    const providers = { preflight: async () => ({ laya: { ready: true } }) };
    return { a, state, config, client, providers, store, calls };
}

test('only explicit continuation recovers the proven incident and retains risk, history, manual activity and clock', async () => {
    const f = fixture(), before = structuredClone(f.state);
    assert.equal(settlementStopCandidate(f.config, f.state, 300), true);
    assert.equal(await recoverSettlementStop(f.store, f.config, f.client, f.providers, { clock: () => 300 }), false);
    assert.deepEqual(f.state, before);
    assert.equal(await recoverSettlementStop(f.store, f.config, f.client, f.providers, { explicitLive: true, clock: () => 300 }), true);
    assert.equal(f.state.stopped, null); assert.equal(f.state.stopHistory[0].at, 200);
    for (const key of Object.keys(before).filter(k => k !== 'stopped')) assert.deepEqual(f.state[key], before[key]);
    assert.deepEqual(f.calls, [120, 120, 120, 120]);
    assert.equal(f.store.events.length, 1);
    assert.equal(await recoverSettlementStop(f.store, f.config, f.client, f.providers, { explicitLive: true, clock: () => 300 }), false);
});

test('risk, changed stop, incomplete receipts, inventory, altered external activity and history stay stopped', () => {
    const changes = [
        s => { s.stopped.reason = 'drawdown_limit'; }, s => { s.stopped.at++; },
        s => { s.maxDrawdown = 2; }, s => { s.peakEquity = s.cash + 2; },
        s => { s.maxDrawdown = 1; }, s => { s.maxDrawdown = NaN; }, s => { s.peakEquity = null; },
        s => { s.position = { holdings: [0, 5] }; }, s => { s.cash++; }, s => { s.startedAt++; },
        s => { s.walletCashDelta = 0; }, s => { s.externalWalletActivity.cashDelta = 0; },
        s => { s.completed.shift(); }, s => { s.completed.at(-1).orders[0].settled = 4; },
        s => { s.completed.at(-1).fills[0].hash = `0x${'f'.repeat(64)}`; },
        s => { s.completed.at(-1).uncertain = true; }, s => { s.ai.providers.laya.disabled = 'unknown'; },
        s => { s.ai.providers.laya.pending = {}; }, s => { s.seen.extra = {}; },
        s => { delete s.settlementEvidence[Object.keys(s.settlementEvidence)[0]]; },
        s => { Object.values(s.settlementEvidence)[0].holdings = [5, 0]; },
    ];
    for (const change of changes) {
        const f = fixture(); change(f.state);
        assert.equal(settlementStopCandidate(f.config, f.state, 300), false, change.toString());
    }
    const f = fixture();
    assert.equal(settlementStopCandidate(f.config, f.state, 100 + 48 * 3600000), false);
    f.config.settings.pilotMarkets = 3;
    assert.equal(settlementStopCandidate(f.config, f.state, 300), false);
});

test('wallet, holdings, canonical receipts, open orders or unhealthy provider refuse incident recovery', async () => {
    const changes = [
        f => { f.client.balance = async () => 22; }, f => { f.client.holdings = async () => [0, 1]; },
        f => { f.client.ordersAndTrades = async () => ({ orders: [{}], trades: [] }); },
        f => { f.providers.preflight = async () => ({ laya: { ready: false } }); },
        f => { f.client.verifiedReceipt = async () => null; },
        f => { const read = f.client.verifiedReceipt; f.client.verifiedReceipt = async (...args) => ({ ...await read(...args), confirmations: 1 }); },
        f => { const read = f.client.verifiedReceipt; f.client.verifiedReceipt = async (...args) => ({ ...await read(...args), blockHash: 'wrong' }); },
    ];
    for (const change of changes) {
        const f = fixture(); change(f); const before = structuredClone(f.state);
        assert.equal(await recoverSettlementStop(f.store, f.config, f.client, f.providers, { explicitLive: true, clock: () => 300 }), false);
        assert.deepEqual(f.state, before); assert.equal(f.store.events.length, 0);
    }
});

test('crossing deadline or new provider uncertainty while reading cannot clear the persistent stop', async () => {
    for (const uncertain of [false, true]) {
        const f = fixture(); let now = 300;
        f.providers.preflight = async () => {
            if (uncertain) f.state.ai.providers.laya.pending = {};
            else now = 100 + 48 * 3600000;
            return { laya: { ready: true } };
        };
        assert.equal(await recoverSettlementStop(f.store, f.config, f.client, f.providers, { explicitLive: true, clock: () => now }), false);
        assert.deepEqual(f.state.stopped, f.a.stop);
    }
});

const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
const zero = ethers.constants.AddressZero, zeroHash = ethers.constants.HashZero;
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const orderTypes = { Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' }, { name: 'signer', type: 'address' },
    { name: 'tokenId', type: 'uint256' }, { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' }, { name: 'timestamp', type: 'uint256' },
    { name: 'metadata', type: 'bytes32' }, { name: 'builder', type: 'bytes32' },
] };
const eventLog = (iface, name, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(name), args) });
function improvedFixture() {
    const f = fixture(), { a, state, config, client } = f;
    const prior = structuredClone(state.completed);
    const signedOrderEvidence = { salt: '1', maker: wallet, signer: wallet, tokenId: '222', makerAmount: '3750000',
        takerAmount: '5000000', side: 'BUY', signatureType: 2, timestamp: '1792208310',
        metadata: zeroHash, builder: zeroHash, orderType: 'FAK' };
    const orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2', chainId: 137,
        verifyingContract: CONTRACTS.standardExchange }, orderTypes, { ...signedOrderEvidence, side: 0 });
    Object.assign(a, { reason: 'reviewed_fak_price_improvement_and_protocol_auto_redeem',
        stop: { reason: 'invalid_owned_trade', at: 1792208316559 }, startedAt: 1792082969496,
        startingCash: 23.262881, walletCashDeltaBefore: .99194, peakEquityBefore: 23.262881,
        slug: 'btc-updown-5m-reviewed-improvement', conditionId: `0x${'8'.repeat(64)}`, orderId,
        actualShares: 5.136985, principal: 3.749999, signedMakerAmount: '3750000', signedTakerAmount: '5000000',
        signedOrderEvidence, reserve: 3.86563, limitPrice: .75, entryCost: 3.820869, fee: .07087, profit: 1.316116,
        tradeIds: ['reviewed-owned-trade'], uncertaintyReason: 'invalid_owned_trade', uncertaintyBefore: false });
    f.now = a.stop.at + 300000;
    state.startedAt = a.startedAt; state.stopped = { ...a.stop }; state.cash = 24.578997;
    state.walletCashDelta = 2.308056; state.peakEquity = state.cash; state.failures = 2; state.dataGaps = 0;
    state.stopHistory = [{ reason: 'wallet_ledger_mismatch', at: 200, recoveredAt: 300 }];
    state.operational = { errors: {}, applicationErrors: {}, circuitsOpened: 0, rpcFailovers: 2, outages: {} };
    state.ai.slots = {}; state.ai.snapshots = [];
    state.seen[a.slug] = { at: a.stop.at - 2000, cost: a.reserve };
    const signedAmounts = { makerAmount: a.signedMakerAmount, takerAmount: a.signedTakerAmount,
        principalBefore: '0', principalAfter: '3749999', feeBefore: '0', feeAfter: '70870',
        quantityBefore: '0', quantityAfter: '5136985', remainingPrincipal: '1' };
    const row = { slug: a.slug, conditionId: a.conditionId, tokens: a.tokens, payout: a.payout,
        openedAt: a.stop.at - 2000, closedAt: f.now - 1000, capitalHours: .2,
        traded: true, uncertain: true, pnl: a.profit, fees: a.fee, entryCost: a.entryCost, gas: 0, rebate: 0,
        orders: [{ orderId, tokenId: a.tokens[1], index: 1, side: 'BUY', price: a.limitPrice,
            shares: 5, filled: a.actualShares, settled: a.actualShares, status: 'cancelled',
            submittedAt: a.stop.at - 1900, matchedAt: null }],
        fills: [{ orderId, hash: a.fillHash, shares: a.actualShares, price: a.principal / a.actualShares,
            tradeId: a.tradeIds[0], tradeIds: [...a.tradeIds], source: 'receipt', settledAt: f.now - 2000 }] };
    state.completed = [...prior, row];
    Object.assign(state.settlementEvidence[a.fillHash], { orderId, conditionId: a.conditionId, cash: -a.entryCost,
        holdings: [0, a.actualShares], fees: a.fee, principal: a.principal, requestedShares: 5,
        shares: a.actualShares, signedAmounts });
    Object.assign(state.settlementEvidence[a.redeemHash], { conditionId: a.conditionId,
        cash: a.actualShares, holdings: [0, -a.actualShares] });
    Object.assign(a, { externalSha256: evidenceHash(state.externalWalletActivity), fundingSha256: evidenceHash(state.liveFunding),
        seenSha256: evidenceHash(state.seen), completedBeforeSha256: evidenceHash(prior),
        completedIncidentSha256: incidentEvidenceHash(row), stopHistorySha256: evidenceHash(state.stopHistory),
        aiHistorySha256: evidenceHash({ slots: state.ai.slots, snapshots: state.ai.snapshots }),
        operationalSha256: operationalFailureHash(state), failuresBefore: state.failures, dataGapsBefore: state.dataGaps });
    config.settings.wallet = wallet;
    f.receipts = {
        [a.fillHash]: { transactionHash: a.fillHash, status: 1, confirmations: 10,
            blockNumber: a.fillBlockNumber, blockHash: a.fillBlockHash,
            logs: [eventLog(erc20, 'Transfer', CONTRACTS.collateralToken, [wallet, other, 3820869], 10),
                eventLog(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [other, other, wallet, '222', 5136985], 11),
                eventLog(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                    [a.orderId, wallet, other, 0, '222', 3749999, 5136985, 70870, zeroHash, zeroHash], 12)] },
        [a.redeemHash]: { transactionHash: a.redeemHash, status: 1, confirmations: 10,
            blockNumber: a.redeemBlockNumber, blockHash: a.redeemBlockHash,
            logs: [eventLog(ctf, 'TransferBatch', CONTRACTS.conditionalTokens,
                [CONTRACTS.autoRedeemOperator, wallet, CONTRACTS.autoRedeemOperator, a.tokens, [0, 5136985]], 10),
                eventLog(ctf, 'TransferSingle', CONTRACTS.conditionalTokens,
                    [CONTRACTS.autoRedeemOperator, CONTRACTS.autoRedeemOperator, zero, '222', 5136985], 11),
                eventLog(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                    [CONTRACTS.autoRedeemOperator, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', zeroHash, a.conditionId, [1, 2], 5136985], 13),
                eventLog(erc20, 'Transfer', CONTRACTS.collateralToken, [zero, wallet, 5136985], 16)] },
    };
    f.trade = { id: a.tradeIds[0], conditionId: a.conditionId, assetId: '222', traderSide: 'TAKER', side: 'BUY', takerOrderId: a.orderId,
        size: String(a.actualShares), price: '.73', status: 'CONFIRMED', transactionHash: a.fillHash };
    client.balance = async block => { f.calls.push(block); return 23.131010; };
    client.ordersAndTrades = async () => ({ orders: [], trades: [structuredClone(f.trade)] });
    client.verifiedReceipt = async (hash, block) => { f.calls.push(block); return structuredClone(f.receipts[hash]); };
    client.payoutAtBlock = async (condition, block) => {
        assert.equal(condition, a.conditionId); f.calls.push(block); return [...a.payout];
    };
    return f;
}
const recoverImproved = f => recoverSettlementStop(f.store, f.config, f.client, f.providers,
    { explicitLive: true, clock: () => f.now });

test('reviewed price improvement recovers only its pinned uncertainty and audits the original row and stop', async () => {
    const f = improvedFixture(), before = structuredClone(f.state);
    assert.equal(settlementStopCandidate(f.config, f.state, f.now), true);
    assert.equal(await recoverImproved(f), true);
    assert.equal(f.state.stopped, null); assert.equal(f.state.completed.at(-1).uncertain, false);
    const audit = f.state.stopHistory.at(-1);
    assert.equal(audit.reason, 'invalid_owned_trade'); assert.equal(audit.at, f.a.stop.at);
    assert.deepEqual(audit.uncertaintyReview.originalRow, before.completed.at(-1));
    assert.equal(audit.uncertaintyReview.originalRowEvidenceHash, f.a.completedIncidentSha256);
    const expected = structuredClone(before); expected.stopped = null; expected.completed.at(-1).uncertain = false;
    expected.stopHistory.push(audit);
    assert.deepEqual(f.state, expected, 'cash, funding, external activity, decisions, risk and clock stay unchanged');
    assert.ok(f.calls.every(block => block === 120));
    assert.equal(await recoverImproved(f), false);
});

test('review approval survives replay accounting times but never changes original execution timestamps', async () => {
    const f = improvedFixture(), row = f.state.completed.at(-1);
    row.closedAt += 10000; row.capitalHours += .25; row.fills[0].settledAt += 5000;
    assert.equal(incidentEvidenceHash(row), f.a.completedIncidentSha256);
    f.state.operational.rpcFailovers++; f.state.operational.outages.rpc_primary = 123;
    assert.equal(operationalFailureHash(f.state), f.a.operationalSha256);
    assert.equal(await recoverImproved(f), true);
    const changed = improvedFixture(); changed.state.completed.at(-1).orders[0].submittedAt++;
    assert.equal(settlementStopCandidate(changed.config, changed.state, changed.now), false);
});

test('old continuation and generic uncertain or changed incident rows cannot clear the new stop', () => {
    const changes = [
        f => { f.a.reason = 'reviewed_sdk_fill_and_protocol_auto_redeem'; },
        f => { f.a.stop.reason = 'wallet_ledger_mismatch'; },
        f => { f.a.stop.at++; f.state.stopped.at++; },
        f => { f.state.completed.at(-1).uncertain = false; },
        f => { f.a.uncertaintyBefore = true; },
        f => { f.a.uncertaintyReason = 'other_error'; },
        f => { f.state.completed.at(-1).orders[0].shares = f.a.actualShares; },
        f => { f.state.completed.at(-1).orders[0].settled = 5; },
        f => { f.state.completed.at(-1).orders[0].price = .76; },
        f => { f.state.completed.at(-1).orders[0].status = 'unknown'; },
        f => { f.state.completed.at(-1).fills[0].source = 'api'; },
        f => { f.state.completed[0].pnl = 1; },
        f => { f.state.stopHistory.push({ reason: 'new_error' }); },
        f => { f.state.ai.snapshots.push({ snapshotId: 'new' }); },
        f => { f.state.liveFunding.initialCapital++; },
        f => { f.state.externalWalletActivity.cashDelta++; },
        f => { f.state.cash += .000001; },
        f => { f.state.maxDrawdown = .000001; },
        f => { f.state.failures++; },
        f => { f.state.dataGaps++; },
        f => { f.state.operational.errors.new = 1; },
        f => { f.state.operational.applicationErrors.new = 1; },
        f => { f.state.reconciliationFaults = { invalid_owned_trade: { count: 1, firstAt: f.now, lastAt: f.now, last: { tradeId: 'new' } } }; },
    ];
    for (const change of changes) {
        const f = improvedFixture(); change(f);
        assert.equal(settlementStopCandidate(f.config, f.state, f.now), false, change.toString());
    }
});

test('signed target, cash cap, principal, reserve and exact receipt evidence cannot be rebound to excess shares', () => {
    for (const change of [
        f => { f.a.shares = f.a.actualShares; },
        f => { f.a.actualShares += .000001; },
        f => { f.a.principal += .000001; },
        f => { f.a.signedMakerAmount = '3750001'; },
        f => { f.a.signedTakerAmount = '5136985'; },
        f => { f.a.signedOrderEvidence.makerAmount = '3750001'; },
        f => { f.a.signedOrderEvidence.takerAmount = '5136985'; },
        f => { f.a.signedOrderEvidence.salt = '2'; },
        f => { f.a.reserve = 5.000001; },
        f => { f.a.reserve = 3.82; },
        f => { f.state.settlementEvidence[f.a.fillHash].signedAmounts.quantityAfter = '5000000'; },
        f => { f.state.settlementEvidence[f.a.fillHash].principal = 3.75; },
        f => { f.state.settlementEvidence[f.a.fillHash].requestedShares = f.a.actualShares; },
    ]) {
        const f = improvedFixture(); change(f);
        assert.equal(settlementStopCandidate(f.config, f.state, f.now), false, change.toString());
    }
});

test('fresh API failed, unowned, extra owned, changed hash, quantity or notional rows refuse reviewed recovery', async () => {
    for (const change of [
        f => { f.trade.status = 'FAILED'; },
        f => { f.trade.status = 'MINED'; },
        f => { f.trade.side = 'SELL'; },
        f => { f.trade.takerOrderId = f.a.redeemHash; },
        f => { f.trade.transactionHash = f.a.redeemHash; },
        f => { f.trade.assetId = f.a.tokens[0]; },
        f => { f.trade.conditionId = f.a.fillHash; },
        f => { f.trade.id = 'new-owned-trade'; },
        f => { f.trade.size = '5'; },
        f => { f.trade.price = '.74'; },
        f => { f.client.ordersAndTrades = async () => ({ orders: [], trades: [f.trade, { ...f.trade, id: 'extra-owned' }] }); },
        f => { f.client.ordersAndTrades = async () => ({ orders: [], trades: [] }); },
        f => { f.client.ordersAndTrades = async () => ({ orders: [{}], trades: [f.trade] }); },
        f => { f.client.ordersAndTrades = async market => market ? { orders: [], trades: [f.trade] }
            : { orders: [{ id: 'other-market-order', conditionId: f.a.fillHash }], trades: [] }; },
    ]) {
        const f = improvedFixture(); change(f); const before = structuredClone(f.state);
        assert.equal(await recoverImproved(f), false, change.toString()); assert.deepEqual(f.state, before);
    }
});

test('fresh global open-order verification keeps historical trades separate from the exact active-market proof', async () => {
    const f = improvedFixture();
    f.client.ordersAndTrades = async market => market ? { orders: [], trades: [structuredClone(f.trade)] }
        : { orders: [], trades: [{ id: 'historical-manual-activity', side: 'SELL', status: 'FAILED' }] };
    assert.equal(await recoverImproved(f), true);
});

test('fresh canonical fill and redemption must reproduce the exact owned event and all wallet movements', async () => {
    for (const change of [
        f => { f.receipts[f.a.fillHash].status = 0; },
        f => { f.receipts[f.a.fillHash].confirmations = 1; },
        f => { f.receipts[f.a.fillHash].blockHash = f.a.redeemBlockHash; },
        f => { f.receipts[f.a.fillHash].logs.pop(); },
        f => { f.receipts[f.a.fillHash].logs[0] = eventLog(erc20, 'Transfer', CONTRACTS.collateralToken, [wallet, other, 3820870], 10); },
        f => { f.receipts[f.a.redeemHash].logs.pop(); },
        f => { f.receipts[f.a.redeemHash].logs[3] = eventLog(erc20, 'Transfer', CONTRACTS.collateralToken, [zero, wallet, 5136984], 16); },
        f => { f.client.payoutAtBlock = async () => [1, 0]; },
        f => { f.client.balance = async () => 23.131011; },
        f => { f.client.holdings = async () => [0, .000001]; },
        f => { f.providers.preflight = async () => ({ laya: { ready: true, disabled: 'new_error' } }); },
    ]) {
        const f = improvedFixture(); change(f); const before = structuredClone(f.state);
        assert.equal(await recoverImproved(f), false, change.toString()); assert.deepEqual(f.state, before);
    }
});

test('fresh asynchronous failures, history changes, provider uncertainty and deadline crossing retain the incident stop', async () => {
    for (const change of [
        f => { f.state.failures++; },
        f => { f.state.dataGaps++; },
        f => { f.state.operational.errors.new = 1; },
        f => { f.state.reconciliationFaults = { unowned_order_in_active_market: { count: 1, firstAt: f.now, lastAt: f.now, last: {} } }; },
        f => { f.state.ai.providers.laya.pending = {}; },
        f => { f.state.ai.snapshots.push({ snapshotId: 'new-during-read' }); },
        f => { f.state.stopHistory.push({ reason: 'changed-during-read' }); },
        f => { f.now = f.state.startedAt + 48 * 3600000; },
    ]) {
        const f = improvedFixture();
        f.providers.preflight = async () => { change(f); return { laya: { ready: true } }; };
        assert.equal(await recoverImproved(f), false, change.toString());
        assert.deepEqual(f.state.stopped, f.a.stop); assert.equal(f.state.completed.at(-1).uncertain, true);
        assert.equal(f.store.events.length, 0);
    }
});
