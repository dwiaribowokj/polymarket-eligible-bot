import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { Store, atomicJson, acquireLock } from '../../src/restart/store.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { verifyOwnedFillReceipt } from '../../src/laya-live/settlement.js';
import { readOwnedTradeReview, prepareOwnedTradeRecovery, applyOwnedTradeRecovery,
    ownedTradeRecoveryDigest as digest } from '../../src/eligible-live/owned-trade-recovery.js';
import { backupOwnedTradeLedger, main } from '../../scripts/eligible-recover-trade.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tx = value => `0x${value.repeat(64)}`;
const wallet = `0x${'b'.repeat(40)}`, other = `0x${'c'.repeat(40)}`;
const fillHash = tx('1'), redeemHash = tx('2'), conditionId = tx('3'), blockHash = tx('4');
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const orderTypes = { Order: [['salt', 'uint256'], ['maker', 'address'], ['signer', 'address'],
    ['tokenId', 'uint256'], ['makerAmount', 'uint256'], ['takerAmount', 'uint256'], ['side', 'uint8'],
    ['signatureType', 'uint8'], ['timestamp', 'uint256'], ['metadata', 'bytes32'], ['builder', 'bytes32']]
    .map(([name, type]) => ({ name, type })) };
const log = (iface, name, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(name), args) });

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-owned-trade-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const policy = { provider: 'eligible', continuousTrading: true }, profitTaking = { enabled: false };
    const sources = [['src/current.js', 'f'.repeat(64)]], oldSources = [['src/previous.js', 'e'.repeat(64)]];
    const runtimeId = digest({ policy, sources, profitTaking }).slice(0, 16);
    const previousRuntimeId = digest({ policy, sources: oldSources, profitTaking }).slice(0, 16);
    const periodId = '0123456789abcdef';
    const config = { id: periodId, runtimeId, policy, sources, profitTaking, paperEvidence: { qualified: false },
        settings: { ...BASELINE, fingerprint: periodId, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`,
            continuousTrading: true, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity } };
    const signed = { salt: '1', maker: wallet, signer: wallet, tokenId: '1', makerAmount: '4100000',
        takerAmount: '5000000', side: 'BUY', signatureType: 2, timestamp: '1794002013',
        metadata: ethers.constants.HashZero, builder: ethers.constants.HashZero, orderType: 'FAK' };
    const orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2',
        chainId: 137, verifyingContract: CONTRACTS.standardExchange }, orderTypes, { ...signed, side: 0 });
    const fillReceipt = { transactionHash: fillHash, blockHash: tx('5'), blockNumber: 100,
        transactionIndex: 1, status: 1, confirmations: 24,
        logs: [log(erc20, 'Transfer', CONTRACTS.collateralToken, [wallet, other, 4152088], 10),
            log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [other, other, wallet, '1', 5009266], 11),
            log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                [orderId, wallet, other, 0, '1', 4099998, 5009266, 52090, ethers.constants.HashZero, ethers.constants.HashZero], 12)] };
    const operator = CONTRACTS.autoRedeemOperator, zero = ethers.constants.AddressZero;
    const redeemReceipt = { transactionHash: redeemHash, blockHash: tx('6'), blockNumber: 110,
        transactionIndex: 21, status: 1, confirmations: 14,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [5009266, 0]], 10),
            log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [operator, operator, zero, '1', 5009266], 11),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ethers.constants.HashZero, conditionId, [1, 2], 5009266], 13),
            log(erc20, 'Transfer', CONTRACTS.collateralToken, [zero, wallet, 5009266], 16)] };
    const order = { orderId, index: 0, tokenId: '1', side: 'BUY', kind: 'taker', signed,
        shares: 5, price: .82, cost: 4.20166, status: 'complete', filled: 5.009266, settled: 5.009266,
        settledPrincipal: 4.099998, receiptProvenComplete: true, transactions: [fillHash], tradeIds: [] };
    const market = { slug: 'btc-updown-5m-reviewed', conditionId, tokens: ['1', '2'], negRisk: false };
    const fill = verifyOwnedFillReceipt({ position: { market, holdings: [0, 0], receipts: {}, actions: [],
        entryCost: 0, fees: 0, orders: [{ ...order, settled: 0, filled: 0, settledPrincipal: 0 }] },
    wallet, block: 123, receipt: fillReceipt, entryCap: 5 });
    assert.ok(fill);
    const receipts = {
        [fillHash]: { hash: fillHash, kind: 'fill', conditionId, cash: fill.cash, holdings: fill.holdings,
            fees: fill.fees, blockNumber: 100, blockHash: tx('5'), source: 'receipt', orderId,
            principal: -fill.notional, shares: 5.009266, requestedShares: 5, signedAmounts: fill.parts[0].signedAmounts },
        [redeemHash]: { hash: redeemHash, kind: 'protocol_auto_redeem', conditionId, cash: 5.009266,
            holdings: [-5.009266, 0], fees: 0, blockNumber: 110, blockHash: tx('6'), source: 'receipt', transactionIndex: 21 },
    };
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    Object.assign(state, { startedAt: 1000, decisionProvider: 'eligible', cash: 10.857178, peakEquity: 20,
        maxDrawdown: 12, walletStart: 10, walletCashDelta: .857178, liveFunding: { initialCapital: 10 },
        stopped: { reason: 'invalid_owned_trade', at: 2000 },
        continuousOperation: { runtimeId: previousRuntimeId, enabledAt: 1000 },
        reconciliationFaults: { invalid_owned_trade: { count: 10, firstAt: 1900, lastAt: 3000,
            last: { orderId, tradeId: 'reviewed-trade' } } },
        entryHolds: { external_activity: { retryable: true, error: { code: 'external_activity_busy' } } },
        ai: { providers: {}, snapshots: [], slots: {} }, settlementEvidence: structuredClone(receipts),
        position: { market, openedAt: 1800, startingCash: 10, holdings: [0, 0], bought: [5.009266, 0],
            entryCost: 4.152088, fees: .05209, gas: 0, rebate: 0, uncertain: true, pendingTrades: false,
            settled: false, orders: [order], receipts, payout: [1, 0], actions: [{ kind: 'redeem',
                source: 'protocol_auto', hash: redeemHash, status: 'confirmed', amount: 5.009266 }],
            fills: [{ hash: fillHash, orderId, shares: 5.009266, source: 'receipt' }] } });
    config.runtimeContinuation = { runtimeId, periodId, ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding) };
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', previousRuntimeId, 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: previousRuntimeId, policy, sources: oldSources, profitTaking, startedAt: 1000 });
    const approval = { schema: 1, reason: 'reviewed_owned_trade_rounded_price', runtimeId, periodId, previousRuntimeId,
        previousManifestSha256: hash(fs.readFileSync(manifestFile)), stateSha256: digest(state), stop: structuredClone(state.stopped),
        orderId, tradeId: 'reviewed-trade', conditionId, fill: { hash: fillHash, blockNumber: 100, blockHash: tx('5') },
        redeem: { hash: redeemHash, blockNumber: 110, blockHash: tx('6') } };
    store.save();
    const f = { config, store, state, approval, dataDir, manifestFile, now: 5000,
        holdings: [0, 0], balance: state.cash, pendingNonce: '0x2', openOrders: [], globalOpenOrders: [],
        trade: { id: 'reviewed-trade', conditionId, assetId: '1', traderSide: 'TAKER', side: 'BUY',
            takerOrderId: orderId, size: '5.009266', price: '.82', status: 'CONFIRMED', transactionHash: fillHash },
        payout: [1, 0], fillReceipt, redeemReceipt, financialCalls: [] };
    f.client = { confirmedBlock: async () => 123, balance: async () => f.balance, holdings: async () => f.holdings,
        ordersAndTrades: async market => ({ orders: market ? f.openOrders : f.globalOpenOrders, trades: [f.trade] }),
        verifiedReceipt: async hash => hash === fillHash ? f.fillReceipt : f.redeemReceipt,
        payoutAtBlock: async () => f.payout,
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task, block) => {
            assert.equal(block, 123);
            return task({ send: async (method, params) => {
                if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? f.pendingNonce : '0x2';
                if (method === 'eth_call') return ethers.utils.defaultAbiCoder.encode(['uint256'], [3]);
                if (method === 'eth_getBlockByNumber') return { hash: blockHash };
                throw new Error('unexpected_rpc');
            } });
        } },
    };
    for (const method of ['prepare', 'post', 'prepareAction', 'broadcastAction', 'cancel', 'prepareProfitTransfer'])
        f.client[method] = () => { f.financialCalls.push(method); throw new Error('financial_write_forbidden'); };
    f.prepare = () => prepareOwnedTradeRecovery(config, state, f.client, approval, { now: () => f.now });
    f.repin = () => { approval.stateSha256 = digest(state); store.save(); };
    return f;
}

test('receipt-backed review recovers uncertainty without re-accounting fill or redemption', async t => {
    const f = fixture(t), before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
    const review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
    assert.equal(review.summary.positionCashPnl, .857178); assert.equal(review.summary.financialWrites, false);
    assert.throws(() => applyOwnedTradeRecovery(f.store, review), /unproven/);
    applyOwnedTradeRecovery(f.store, review, { explicitApply: true });
    assert.equal(f.state.stopped, null); assert.equal(f.state.position.uncertain, false);
    assert.deepEqual(f.state.position, { ...before.position, uncertain: false });
    assert.deepEqual(f.state.reconciliationFaults, {}); assert.deepEqual(f.state.entryHolds, {});
    assert.deepEqual(f.state.stopHistory.at(-1).originalReconciliationFaults, before.reconciliationFaults);
    assert.deepEqual(f.state.stopHistory.at(-1).originalEntryHolds, before.entryHolds);
    for (const key of ['cash', 'walletStart', 'walletCashDelta', 'completed', 'peakEquity', 'maxDrawdown', 'settlementEvidence', 'seen', 'ai'])
        assert.deepEqual(f.state[key], before[key], key);
    assert.equal(f.state.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(f.state.continuousOperation.runtimeId, f.config.runtimeId);
    assert.equal(eligibleReadiness({ config: f.config, state: f.state, history: eligibleHistory(f.config), operationalReady: true }).readyForLive, true);
    assert.deepEqual(f.financialCalls, []);
    assert.throws(() => applyOwnedTradeRecovery(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('different incidents, pending activity, ledger pins and policies remain stopped', async t => {
    const mutations = {
        statePin: f => { f.state.cash++; }, approvalRuntime: f => { f.approval.runtimeId = '0'.repeat(16); },
        stop: f => { f.state.stopped.reason = 'unknown_trade'; f.repin(); },
        uncertain: f => { f.state.position.uncertain = false; f.repin(); },
        pendingTrade: f => { f.state.position.pendingTrades = true; f.repin(); },
        pendingAction: f => { f.state.position.actions[0].status = 'unknown'; f.repin(); },
        pendingWithdrawal: f => { f.state.profitTaking = { pending: {} }; f.repin(); },
        riskStop: f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; f.repin(); },
        otherFault: f => { f.state.reconciliationFaults.other = {}; f.repin(); },
        otherHold: f => { f.state.entryHolds.clock = {}; f.repin(); },
        priorUncertain: f => { f.state.completed.push({ uncertain: true, pnl: 0 }); f.repin(); },
        manifest: f => { fs.appendFileSync(f.manifestFile, ' '); },
        policy: f => { f.config.policy.entryCap = 100; },
        receiptAccounting: f => { f.state.settlementEvidence[fillHash].cash++; f.repin(); },
        changedDisk: f => { const other = structuredClone(f.state); other.cash++; atomicJson(f.store.filename, other); },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
        const f = fixture(t); mutate(f); const before = structuredClone(f.state);
        await assert.rejects(f.prepare, /unproven/); assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    });
});

test('fresh API, canonical receipts, payout and wallet proofs must all agree', async t => {
    const mutations = {
        tradeId: f => { f.trade.id = 'other'; }, tradeOrder: f => { f.trade.takerOrderId = tx('8'); },
        tradeSide: f => { f.trade.side = 'SELL'; }, tradeCondition: f => { f.trade.conditionId = tx('9'); },
        conditionCase: f => { f.trade.conditionId = f.trade.conditionId.replace('0x', '0X'); },
        signedPriceLimit: f => { f.state.position.orders[0].price = .83; f.trade.price = '.83'; f.repin(); },
        tradeAsset: f => { f.trade.assetId = '2'; }, tradeRole: f => { f.trade.traderSide = 'MAKER'; },
        tradeQuantity: f => { f.trade.size = '5.009267'; }, tradeStatus: f => { f.trade.status = 'MINED'; },
        fractionalMicroShare: f => { f.trade.size = '5.00926601'; }, fractionalMicroPrice: f => { f.trade.price = '.819999999'; },
        tradeReceipt: f => { f.trade.transactionHash = tx('8'); },
        openOrder: f => { f.openOrders.push({}); }, otherOpenOrder: f => { f.globalOpenOrders.push({}); },
        fillBlock: f => { f.fillReceipt.blockHash = tx('7'); }, fillConfirmation: f => { f.fillReceipt.confirmations = 1; },
        fillMoney: f => { f.fillReceipt.logs[0] = log(erc20, 'Transfer', CONTRACTS.collateralToken, [wallet, other, 4152089], 10); },
        redeemReceipt: f => { f.redeemReceipt.logs.pop(); }, payout: f => { f.payout = [0, 1]; },
        holdings: f => { f.holdings = [1, 0]; }, wallet: f => { f.balance++; }, nonce: f => { f.pendingNonce = '0x3'; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
        const f = fixture(t); mutate(f); const before = structuredClone(f.state);
        await assert.rejects(f.prepare, /unproven|transactions_pending/);
        assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    });
});

test('an unrelated order appearing during receipt verification prevents recovery', async t => {
    const f = fixture(t), original = f.client.verifiedReceipt;
    f.client.verifiedReceipt = async (...args) => {
        const receipt = await original(...args);
        f.globalOpenOrders = [{ id: 'new-other-market-order' }];
        return receipt;
    };
    const before = structuredClone(f.state);
    await assert.rejects(f.prepare, /unproven/);
    assert.deepEqual(f.state, before);
});

test('stale unrelated API matches require fresh canonical receipts on both account snapshots', async t => {
    for (const name of ['proven', 'absent', 'foreign', 'failed', 'unconfirmed', 'overlap', 'latePending']) await t.test(name, async t => {
        const f = fixture(t), pendingHash = tx('a'), readHashes = [], originalReceipt = f.client.verifiedReceipt;
        const pending = { id: 'historical-api-match', conditionId: tx('b'), assetId: '9',
            traderSide: 'TAKER', takerOrderId: tx('c'), transactionHash: pendingHash, status: 'MATCHED' };
        const canonical = { transactionHash: pendingHash, blockHash: tx('d'), blockNumber: 90, status: 1, confirmations: 34 };
        let globalReads = 0;
        f.client.ordersAndTrades = async market => {
            if (market) return { orders: [], trades: [f.trade] };
            globalReads++;
            return { orders: [], trades: [f.trade, ...(name === 'latePending' && globalReads === 1 ? [] : [pending])] };
        };
        f.client.verifiedReceipt = async (requested, block) => {
            if (requested !== pendingHash) return originalReceipt(requested, block);
            readHashes.push(requested); assert.equal(block, 123);
            if (name === 'absent' || name === 'latePending') return null;
            return canonical;
        };
        if (name === 'foreign') canonical.transactionHash = tx('e');
        if (name === 'failed') canonical.status = 0;
        if (name === 'unconfirmed') canonical.confirmations = 1;
        if (name === 'overlap') pending.conditionId = conditionId;
        const before = structuredClone(f.state);
        if (name === 'proven') {
            const review = await f.prepare();
            assert.equal(readHashes.length, 2); assert.equal(globalReads, 2);
            assert.deepEqual(review.nextState.stopHistory.at(-1).globalTrades.receiptConfirmed,
                [{ transactionHash: pendingHash, blockNumber: 90, blockHash: tx('d'), source: 'canonical_receipt' }]);
        } else await assert.rejects(f.prepare, /unproven|external_trades_pending/);
        assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    });
});

test('apply rejects stale or tampered reviews and restores memory after save failure', async t => {
    for (const name of ['time', 'draft', 'summary', 'state', 'approval', 'save']) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare(), before = structuredClone(f.state);
        if (name === 'time') f.now += 60001;
        if (name === 'draft') review.nextState.cash++;
        if (name === 'summary') review.summary.walletPUSD++;
        if (name === 'state') f.state.cash++;
        if (name === 'approval') f.approval.tradeId = 'changed';
        if (name === 'save') f.store.save = () => { throw new Error('disk_failed'); };
        assert.throws(() => applyOwnedTradeRecovery(f.store, review, { explicitApply: true }), /unproven|disk_failed/);
        if (name !== 'state') assert.deepEqual(f.state, before);
    });
});

test('backup preserves exact private ledger bytes; review rejects symlinks and public permissions', async t => {
    const f = fixture(t), bytes = fs.readFileSync(f.store.filename);
    const backup = backupOwnedTradeLedger(f.store, f.config);
    const file = path.join(f.dataDir, f.config.id, 'eligible-runtime', 'owned-trade-recovery', `${backup}.json`);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(backupOwnedTradeLedger(f.store, f.config), backup);
    const approvalFile = path.join(f.dataDir, 'review.json'); atomicJson(approvalFile, f.approval);
    assert.deepEqual(readOwnedTradeReview(approvalFile), f.approval);
    fs.chmodSync(approvalFile, 0o644); assert.throws(() => readOwnedTradeReview(approvalFile), /unproven/);
    fs.chmodSync(approvalFile, 0o600); const link = path.join(f.dataDir, 'review-link.json'); fs.symlinkSync(approvalFile, link);
    assert.throws(() => readOwnedTradeReview(link), /unproven/);
    await assert.rejects(main(['--reset']), /use_eligible_recover_trade_apply/);
    const release = await acquireLock(f.dataDir, 'pilot');
    try { await assert.rejects(acquireLock(f.dataDir, 'pilot'), /already running/); }
    finally { await release(); }
});

test('CLI reviews under lock and applies only after a durable backup', async t => {
    for (const apply of [false, true]) await t.test(apply ? 'apply' : 'review', async t => {
        const f = fixture(t), calls = [], output = [], before = structuredClone(f.state);
        const code = await main(apply ? ['--apply'] : [], {
            loadConfig: () => f.config, loadReview: () => f.approval,
            acquireLock: async () => { calls.push('lock'); return async () => calls.push('unlock'); },
            storeFactory: () => { calls.push('store'); return f.store; },
            clientFactory: () => ({ ...f.client, close() { calls.push('close'); } }),
            prepare: async (...args) => { calls.push('prepare'); return prepareOwnedTradeRecovery(...args, { now: () => f.now }); },
            backup: (...args) => { calls.push('backup'); return backupOwnedTradeLedger(...args); },
            apply: (...args) => { calls.push('apply'); return applyOwnedTradeRecovery(...args); },
            write: value => output.push(value),
        });
        assert.equal(code, 0); assert.equal(output[0].applied, apply); assert.equal(output[0].liveStarted, false);
        assert.deepEqual(calls, ['lock', 'store', 'prepare', ...(apply ? ['backup', 'apply'] : []), 'close', 'unlock']);
        if (!apply) assert.deepEqual(f.state, before);
    });
    await t.test('failed backup never applies', async t => {
        const f = fixture(t), before = structuredClone(f.state); let applied = false, released = false;
        await assert.rejects(main(['--apply'], {
            loadConfig: () => f.config, loadReview: () => f.approval,
            acquireLock: async () => async () => { released = true; },
            storeFactory: () => f.store, clientFactory: () => f.client,
            prepare: (...args) => prepareOwnedTradeRecovery(...args, { now: () => f.now }),
            backup: () => { throw new Error('disk_failed'); }, apply: () => { applied = true; },
        }), /disk_failed/);
        assert.equal(applied, false); assert.equal(released, true); assert.deepEqual(f.state, before);
    });
});
