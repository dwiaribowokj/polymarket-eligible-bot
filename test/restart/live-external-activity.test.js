import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/restart/store.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { OperationalError } from '../../src/restart/network.js';
import { ExternalActivityReconciler, externalActivityCandidate, externalTokenBalances }
    from '../../src/laya-live/external-activity.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';

const hash = number => `0x${number.toString(16).padStart(64, '0')}`;
const block = number => ({ blockNumber: number, blockHash: hash(10000 + number) });
const wallet = `0x${'2'.repeat(40)}`, from = `0x${'3'.repeat(40)}`;
const receipt = (id, number, cash = 0, tokenIds = [], holdings = []) =>
    ({ hash: hash(id), ...block(number), cash, tokenIds, holdings });
const financialKeys = ['cash', 'peakEquity', 'lastEquity', 'maxDrawdown', 'walletStart', 'walletCashDelta',
    'liveFunding', 'capitalFunding', 'completed', 'position'];
const financialState = state => Object.fromEntries(financialKeys.map(key => [key, structuredClone(state[key])]));

function reviewedSeed() {
    const tokens = ['11', '12', '13', '14', '15', '16', '17', '18'];
    const receipts = Array.from({ length: 14 }, (_, index) => receipt(index + 1, 31 + index,
        index === 0 ? -1 : index === 1 ? 1.720373 : 0,
        [tokens[index % tokens.length]], [index === 6 ? 1.923077 : 0]));
    return { cashDelta: .720373, receipts, capitalAllocated: 0, reviewedAt: 1000,
        checkpoint: { ...block(30), tokenIds: tokens },
        walletProof: { ...block(50), balance: 20.720373,
            manualHoldingsProof: { ...block(50), amounts: [0, 0, 0, 0, 0, 0, 1.923077, 0] } },
        zeroPayoutInventory: [{ conditionId: hash(999), tokens: ['17', '18'], amounts: [1.923077, 0], payout: [0, 1] }] };
}

function fixture(t, { reviewed = false, fresh = false } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-activity-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { dataDir, fingerprint: 'external-activity-test', capital: 20,
        wallet, automaticManualActivity: true, automaticDeposits: true };
    const config = { settings }, store = new Store(settings, 'pilot', 'late-entry');
    store.logger = () => {};
    Object.assign(store.state, { decisionProvider: 'eligible', cash: 20, peakEquity: 25,
        lastEquity: 20, maxDrawdown: 5, walletStart: 20, walletCashDelta: 0,
        liveFunding: { initialCapital: 20 }, ai: { snapshots: [] }, reconciliationFaults: {},
        strategyEpochs: fresh ? [] : [{ walletProof: { ...block(50), balance: 20,
            trades: {}, holdingsProof: { holdings: [] } } }],
        capitalFunding: { schema: 1, chainId: 137, tokenAddress: CONTRACTS.collateralToken.toLowerCase(),
            walletAddress: wallet, totalDeposited: 0, entries: {}, checkpoint: block(50) } });
    if (reviewed) store.state.externalWalletActivity = reviewedSeed();
    store.save();
    const f = { settings, config, store, state: store.state, time: 1800000000000, tip: 100,
        balance: expectedWalletBalance(store.state), holdings: reviewed ? { '17': 1.923077 } : {},
        positions: [], orders: [], trades: [], receipts: [], deposits: [], scans: [], reads: [],
        headers: {}, snapshots: 0, financialWrites: [] };
    const forbidden = name => () => { f.financialWrites.push(name); assert.fail(`Unexpected financial write: ${name}`); };
    f.client = {
        confirmedBlock: async () => { f.snapshots++; f.client.rpc.anchor = { number: f.tip, hash: block(f.tip).blockHash }; return f.tip; },
        balance: async number => { f.reads.push(['balance', number]); return f.balance; },
        holdings: async (tokens, number) => { f.reads.push(['holdings', number]); return tokens.map(token => f.holdings[token] || 0); },
        positions: async () => f.positions,
        ordersAndTrades: async () => ({ orders: f.orders, trades: f.trades }),
        rpc: { anchor: { number: 100, hash: block(100).blockHash },
            read: async (_stage, task) => task({ getBlock: async number => ({ number,
                hash: f.headers[number] || block(number).blockHash }) }) },
        prepare: forbidden('prepare'), post: forbidden('post'), cancel: forbidden('cancel'),
        prepareAction: forbidden('prepareAction'), broadcastAction: forbidden('broadcastAction'),
    };
    f.discover = async (_client, options) => {
        f.scans.push(structuredClone(options));
        const receipts = f.receipts.filter(row => row.blockNumber > options.from.blockNumber && row.blockNumber <= options.to.blockNumber);
        const deposits = f.deposits.filter(row => row.blockNumber > options.from.blockNumber && row.blockNumber <= options.to.blockNumber);
        const amounts = new Map();
        for (const row of receipts) row.tokenIds.forEach((token, index) =>
            amounts.set(token, (amounts.get(token) || 0) + Math.round(row.holdings[index] * 1e6)));
        return { receipts, externalCashDelta: receipts.reduce((sum, row) => sum + Math.round(row.cash * 1e6), 0) / 1e6,
            tokenIds: [...amounts.keys()], holdingsDeltas: [...amounts].map(([tokenId, value]) => ({ tokenId, amount: value / 1e6 })),
            deposits, depositAmount: deposits.reduce((sum, row) => sum + Math.round(row.amount * 1e6), 0) / 1e6,
            checkpoint: options.to };
    };
    f.reconciler = new ExternalActivityReconciler(config, store, f.client, { discover: (...args) => f.discover(...args), now: () => f.time });
    t.after(() => assert.deepEqual(f.financialWrites, []));
    return f;
}

function addTrade(f, { cash = -2, token = '51', shares = 4, id = 101, number = 80 } = {}) {
    f.receipts.push(receipt(id, number, cash, [token], [shares]));
    f.balance = Math.round((f.balance + cash) * 1e6) / 1e6;
    f.holdings[token] = Math.round(((f.holdings[token] || 0) + shares) * 1e6) / 1e6;
}

function addDeposit(f, value = 5) {
    f.deposits.push({ txHash: hash(501), logIndex: 1, from, amount: value, ...block(85) });
    f.balance = Math.round((f.balance + value) * 1e6) / 1e6;
}

function botPosition(f, tokens = ['1', '2']) {
    const position = f.state.position = { market: { tokens }, startingCash: 22,
        holdings: [5, 0], pendingTrades: false,
        orders: [{ orderId: hash(701), status: 'complete', receiptProvenComplete: true, transactions: [hash(702)] }],
        actions: [], receipts: { [hash(702)]: { hash: hash(702) } } };
    f.holdings[tokens[0]] = 5;
    return position;
}

test('reviewed receipts survive zero-payout burn and new manual holdings without changing bot capital', async t => {
    const f = fixture(t, { reviewed: true }), before = financialState(f.state);
    const old = structuredClone(f.state.externalWalletActivity);
    addTrade(f, { token: '17', shares: -1.923077, cash: 0 });
    addTrade(f, { token: '51', shares: 4, cash: -2, id: 102, number: 81 });
    addTrade(f, { token: '52', shares: 2, cash: -1, id: 103, number: 82 });
    assert.equal(await f.reconciler.reconcile(), true);
    assert.deepEqual(financialState(f.state), before);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2.279627);
    assert.deepEqual(f.state.externalWalletActivity.receipts.slice(0, 14), old.receipts);
    assert.deepEqual(f.state.externalWalletActivity.zeroPayoutInventory, old.zeroPayoutInventory);
    assert.deepEqual(f.state.externalWalletActivity.walletProof, old.walletProof);
    assert.deepEqual(externalTokenBalances(f.state), { '11': 0, '12': 0, '13': 0, '14': 0,
        '15': 0, '16': 0, '17': 0, '18': 0, '51': 4, '52': 2 });
    assert.equal(expectedWalletBalance(f.state), f.balance);
    assert.equal(f.reconciler.lastSummary.receiptCount, 3);
    assert.equal(f.reconciler.lastSummary.openExternalTokens, 2);
    assert.equal(new Store(f.settings, 'pilot', 'late-entry').state.externalWalletActivity.receipts.length, 17);
});

test('preview is read-only and includes actionable proof failure diagnostics', async t => {
    const f = fixture(t); addTrade(f);
    const before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
    assert.equal((await f.reconciler.preview()).externalCashDelta, -2);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
    f.holdings['51'] = 4.000001;
    const failed = await f.reconciler.preview();
    assert.equal(failed.ready, false); assert.equal(failed.automaticRecoveryAvailable, false);
    assert.equal(failed.error.code, 'external_activity_holdings_mismatch');
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
});

test('restart advances the checkpoint and never imports old receipts or deposits twice', async t => {
    const f = fixture(t); addTrade(f); addDeposit(f);
    assert.equal(await f.reconciler.reconcile(), true);
    const first = structuredClone(f.state.externalWalletActivity);
    const restarted = new Store(f.settings, 'pilot', 'late-entry'); restarted.logger = () => {};
    const reconciler = new ExternalActivityReconciler(f.config, restarted, f.client, { discover: f.discover, now: () => f.time });
    f.tip = 110;
    addTrade(f, { cash: 3, shares: -4, id: 102, number: 105 });
    assert.equal(await reconciler.reconcile(), true);
    assert.equal(restarted.state.cash, 25); assert.equal(restarted.state.capitalFunding.totalDeposited, 5);
    assert.equal(restarted.state.externalWalletActivity.cashDelta, 1);
    assert.deepEqual(restarted.state.externalWalletActivity.receipts.slice(0, 1), first.receipts);
    assert.deepEqual(restarted.state.externalWalletActivity.automatic.checkpoint, block(110));
    assert.deepEqual(f.scans.at(-1).from, block(100));
    assert.equal(f.scans.at(-1).knownHashes.includes(hash(501)), true);
    assert.equal(await reconciler.reconcile(), true);
    assert.equal(restarted.state.externalWalletActivity.receipts.length, 2);
    assert.equal(restarted.state.capitalFunding.totalDeposited, 5);
    assert.equal(restarted.state.cash, 25);
});

test('a genuine deposit moves capital and open-trade baseline while manual profit stays excluded', async t => {
    const f = fixture(t), position = botPosition(f), before = structuredClone(position);
    addTrade(f, { cash: 3, shares: 0 }); addDeposit(f);
    const pnl = f.state.cash - position.startingCash;
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.position, position); assert.equal(position.startingCash, 27);
    assert.equal(f.state.cash, 25); assert.equal(f.state.peakEquity, 30); assert.equal(f.state.lastEquity, 25);
    assert.equal(f.state.maxDrawdown, 5); assert.equal(f.state.cash - position.startingCash, pnl);
    assert.deepEqual({ ...position, startingCash: before.startingCash }, before);
    assert.equal(f.state.externalWalletActivity.cashDelta, 3);
    assert.equal(f.state.capitalFunding.totalDeposited, 5);
    assert.deepEqual(f.scans[0].botTokens, []);
    assert.deepEqual(f.scans[0].botOrderIds, [hash(701)]);
    assert.equal(f.scans[0].knownHashes.includes(hash(702)), true);
});

test('uncertain bot work and active withdrawals defer before discovery', async t => {
    const cases = {
        pendingTrades: f => { botPosition(f).pendingTrades = true; },
        pendingOrder: f => { botPosition(f).orders[0].status = 'accepted'; },
        unprovenOrder: f => { botPosition(f).orders[0].receiptProvenComplete = false; },
        pendingAction: f => { botPosition(f).actions.push({ status: 'pending' }); },
        fractionalHoldings: f => { botPosition(f).holdings[0] = 5.0000001; },
        withdrawal: f => { f.state.profitTakingControl = { operation: { stage: 'address_ready' } }; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t); change(f); addTrade(f);
        const before = financialState(f.state);
        assert.equal(externalActivityCandidate(f.config, f.state), false);
        assert.equal(await f.reconciler.preview(), null);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.scans.length, 0); assert.deepEqual(financialState(f.state), before);
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.external_activity.retryable, true);
    });
});

test('terminal zero-fill orders can finish accounting without a nonexistent fill receipt', async t => {
    for (const status of ['complete', 'cancelled']) await t.test(status, async t => {
        const f = fixture(t), position = botPosition(f);
        position.holdings = [0, 0]; f.holdings['1'] = 0;
        position.orders = [{ orderId: hash(701), status, filled: 0, settled: 0,
            transactions: [], tradeIds: [], matchedTrades: {},
            ...(status === 'complete' ? { apiTerminal: { status: 'EXPIRED', filled: 0, at: f.time - 1000 } }
                : { cancelConfirmedAt: f.time - 1000, cancelSettled: true }) }];
        addTrade(f);
        const before = financialState(f.state);
        assert.equal(await f.reconciler.reconcile(), true);
        assert.deepEqual(financialState(f.state), before);
        assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    });
});

test('zero-fill terminal status never overrides pending match, receipt, or cancellation evidence', async t => {
    const cases = {
        'unsettled cancellation': order => { order.status = 'cancelled'; order.cancelConfirmedAt = 1000; order.cancelSettled = false; },
        'receipt hash': order => { order.transactions = [hash(999)]; },
        'trade identity': order => { order.tradeIds = ['unknown-trade']; },
        'matched submission': order => { order.apiSubmissionStatus = 'MATCHED'; },
        'matched quantity': order => { order.apiMatchedQuantity = { shares: .000001 }; },
        'query retry': order => { order.queryRetry = { nextAt: 1000 }; },
        'awaiting receipt': order => { order.awaitingReceipt = true; },
        'unproven terminal': order => { delete order.apiTerminal; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t), position = botPosition(f);
        position.orders = [{ orderId: hash(701), status: 'complete', filled: 0, settled: 0,
            transactions: [], tradeIds: [], matchedTrades: {},
            apiTerminal: { status: 'UNMATCHED', filled: 0, at: 1000 } }];
        change(position.orders[0]);
        assert.equal(externalActivityCandidate(f.config, f.state), false);
        assert.equal(await f.reconciler.reconcile(), false); assert.equal(f.scans.length, 0);
    });
});

test('manual holdings in active bot tokens hold until a full manual roundtrip restores bot-only inventory', async t => {
    const f = fixture(t); botPosition(f);
    addTrade(f, { cash: -1, token: '1', shares: 2 });
    const before = financialState(f.state);
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.reconciler.lastError.code, 'external_activity_bot_overlap');
    assert.deepEqual(financialState(f.state), before); assert.equal(f.state.externalWalletActivity, undefined);
    assert.equal(f.state.stopped, null);
    f.time += 1000; f.tip = 110;
    addTrade(f, { cash: 1.5, token: '1', shares: -2, id: 102, number: 105 });
    assert.equal(await f.reconciler.reconcile(), true);
    assert.deepEqual(financialState(f.state), before);
    assert.equal(f.state.externalWalletActivity.cashDelta, .5);
    assert.equal(externalTokenBalances(f.state)['1'], 0);
    assert.deepEqual(f.state.position.holdings, [5, 0]);
});

test('completed bot token history does not reserve later manual ownership', async t => {
    const f = fixture(t);
    f.state.completed = [{ market: { tokens: ['51', '52'] }, orders: [{ orderId: hash(901),
        receiptProvenComplete: true, transactions: [hash(902)] }], receipts: {}, actions: [] }];
    addTrade(f);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.deepEqual(f.scans[0].botTokens, []);
    assert.deepEqual(f.scans[0].botOrderIds, [hash(901)]);
    assert.equal(f.scans[0].knownHashes.includes(hash(902)), true);
    assert.equal(externalTokenBalances(f.state)['51'], 4);
});

test('a fully disposed external token can later be held by the bot', async t => {
    const f = fixture(t); addTrade(f);
    addTrade(f, { cash: 2, shares: -4, id: 102, number: 81 });
    assert.equal(await f.reconciler.reconcile(), true);
    botPosition(f, ['51', '52']); f.tip = 110;
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(externalTokenBalances(f.state)['51'], 0);
    assert.deepEqual(f.state.position.holdings, [5, 0]);
});

test('invalid receipt amounts, history, range, and checkpoint fail without accounting changes', async t => {
    const cases = {
        cashSum: proof => { proof.externalCashDelta = -1.999999; },
        tokenSum: proof => { proof.holdingsDeltas[0].amount = 4.000001; },
        fractional: proof => { proof.receipts[0].cash = -2.0000001; },
        duplicate: proof => { proof.receipts.push(proof.receipts[0]); },
        oldReceipt: proof => { proof.receipts[0].blockNumber = 50; },
        futureReceipt: proof => { proof.receipts[0].blockNumber = 101; },
        wrongEndpointHash: proof => { proof.receipts[0].blockNumber = 100; },
        wrongCheckpoint: proof => { proof.checkpoint = block(101); },
        unbackedDeposit: proof => { proof.depositAmount = 1; },
        missingHoldings: proof => { proof.holdingsDeltas = []; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t); addTrade(f);
        const discover = f.discover;
        f.discover = async (...args) => { const proof = structuredClone(await discover(...args)); mutate(proof); return proof; };
        const before = financialState(f.state);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.deepEqual(financialState(f.state), before); assert.equal(f.state.externalWalletActivity, undefined);
        assert.equal(f.state.stopped, null);
    });
});

test('reviewed seed requires a complete holding witness and exact historical token balances', async t => {
    const cases = {
        missingPositive: external => { external.checkpoint.tokenIds.splice(6, 1); external.walletProof.manualHoldingsProof.amounts.splice(6, 1); },
        truncatedAmount: external => { external.walletProof.manualHoldingsProof.amounts[6] = 1.923; },
        wrongBlock: external => { external.walletProof.manualHoldingsProof.blockHash = hash(999); },
        wrongHistory: external => { external.receipts[6].holdings[0] = 1.923076; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t, { reviewed: true }); mutate(f.state.externalWalletActivity);
        const before = financialState(f.state), external = structuredClone(f.state.externalWalletActivity);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.scans.length, 0); assert.deepEqual(financialState(f.state), before);
        assert.deepEqual(f.state.externalWalletActivity, external);
    });
});

test('reorgs, concurrent state changes, and expiry invalidate a proof before booking', async t => {
    const cases = {
        originReorg: f => { f.headers[50] = hash(999); },
        finalReorg: f => { f.headers[100] = hash(999); },
        stateChange: f => { const discover = f.discover; f.discover = async (...args) => { const proof = await discover(...args); f.state.seen.concurrent = true; return proof; }; },
        configChange: f => { const discover = f.discover; f.discover = async (...args) => { const proof = await discover(...args); f.settings.wallet = from; return proof; }; },
        timeBudget: f => { const discover = f.discover; f.discover = async (...args) => { const proof = await discover(...args); f.time += 600001; return proof; }; },
        finalExpiry: f => { let balances = 0; f.client.balance = async () => { if (++balances > 1) f.time += 30001; return f.balance; }; },
        changedBalance: f => { let balances = 0; f.client.balance = async () => f.balance + (++balances > 1 ? .000001 : 0); },
        anchorMoved: f => { const discover = f.discover; f.discover = async (...args) => { const proof = await discover(...args); f.client.rpc.anchor = { number: 101, hash: block(101).blockHash }; return proof; }; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t); addTrade(f); mutate(f);
        const before = financialState(f.state);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.deepEqual(financialState(f.state), before); assert.equal(f.state.externalWalletActivity, undefined);
        assert.equal(f.state.stopped, null);
    });
});

test('persistence failure restores external ledger, funding, and the original position object', async t => {
    const f = fixture(t, { reviewed: true }), position = botPosition(f);
    addTrade(f); addDeposit(f);
    const before = financialState(f.state), external = f.state.externalWalletActivity, bytes = fs.readFileSync(f.store.filename);
    f.store.save = () => { throw new Error('disk_full'); };
    assert.equal(await f.reconciler.reconcile(), false);
    assert.deepEqual(financialState(f.state), before); assert.equal(f.state.position, position);
    assert.equal(f.state.externalWalletActivity, external); assert.equal(position.startingCash, 22);
    assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
});

test('a proven mismatch clears only its own stop and retryable accounting holds', async t => {
    const f = fixture(t); addTrade(f);
    f.state.stopped = { reason: 'wallet_ledger_mismatch', at: f.time - 1 };
    f.state.reconciliationFaults = { wallet_ledger_mismatch: { expected: 20, actual: 18 } };
    f.state.entryHolds = { external_activity: { retryable: true }, capital_deposit: { retryable: true },
        operator: { retryable: false, reason: 'review_required' } };
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.reconciliationFaults, {});
    assert.deepEqual(f.state.entryHolds, { operator: { retryable: false, reason: 'review_required' } });
    assert.equal(f.state.externalActivityRecoveryHistory[0].stop.reason, 'wallet_ledger_mismatch');
});

test('accounting remains available under an unrelated operational stop without clearing it or other faults', async t => {
    const f = fixture(t); addTrade(f);
    f.state.stopped = { reason: 'operational_check_failed', at: f.time - 1 };
    f.state.reconciliationFaults = { unrelated: { reason: 'order_history_incomplete' } };
    const stopped = structuredClone(f.state.stopped), faults = structuredClone(f.state.reconciliationFaults);
    assert.equal((await f.reconciler.preview()).ready, true);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.deepEqual(f.state.stopped, stopped); assert.deepEqual(f.state.reconciliationFaults, faults);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    assert.equal(f.state.cash, 20);
});

test('fresh empty-wallet bootstrap establishes a checkpoint without importing unknown history', async t => {
    const f = fixture(t, { fresh: true });
    f.trades = [{ status: 'TRADE_STATUS_CONFIRMED' }, { status: 'FAILED' }];
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.scans.length, 0);
    assert.equal(f.state.externalWalletActivity.automatic.seed.source, 'fresh_flat_wallet');
    assert.deepEqual(f.state.externalWalletActivity.automatic.checkpoint, block(100));
    assert.equal(f.state.externalWalletActivity.cashDelta, 0);
    f.tip = 110; addTrade(f, { number: 105 });
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2);
});

test('bootstrap refuses unexplained cash, inventory, orders, pending API trades, and prior bot history', async t => {
    const cases = {
        cash: f => { f.balance = 21; },
        inventory: f => { f.positions = [{ size: .000001 }]; },
        order: f => { f.orders = [{ id: hash(999) }]; },
        trade: f => { f.trades = [{ status: 'TRADE_STATUS_MATCHED' }]; },
        completed: f => { f.state.completed = [{ pnl: 0 }]; },
        seen: f => { f.state.seen.old = true; },
        ai: f => { f.state.ai.snapshots = [{ at: 1000 }]; },
        cashDelta: f => { f.state.walletCashDelta = .000001; },
    };
    for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t, { fresh: true }); change(f);
        const before = financialState(f.state);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.deepEqual(financialState(f.state), before); assert.equal(f.state.externalWalletActivity, undefined);
        assert.equal(f.state.stopped, null);
    });
});

test('later manual activity does not invalidate an earlier complete confirmed snapshot', async t => {
    const f = fixture(t); addTrade(f);
    const discover = f.discover;
    f.discover = async (...args) => { const proof = await discover(...args); f.tip = 101; return proof; };
    f.client.balance = async number => { f.reads.push(['balance', number]); return number > 100 ? 17 : 18; };
    f.client.holdings = async (tokens, number) => tokens.map(token => token === '51' ? number > 100 ? 6 : 4 : 0);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.snapshots, 1);
    assert.deepEqual(f.state.externalWalletActivity.automatic.checkpoint, block(100));
    assert.deepEqual(f.reads.filter(row => row[0] === 'balance'), [['balance', 100], ['balance', 100]]);
    f.receipts.push(receipt(102, 101, -1, ['51'], [2]));
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.externalWalletActivity.cashDelta, -3);
    assert.equal(externalTokenBalances(f.state)['51'], 6);
    assert.deepEqual(f.state.externalWalletActivity.automatic.checkpoint, block(101));
});

test('disabled and closed reconcilers perform no reads or writes', async t => {
    const f = fixture(t); f.settings.automaticManualActivity = false;
    const before = structuredClone(f.state);
    assert.equal(await f.reconciler.preview(), null); assert.equal(await f.reconciler.reconcile(), false);
    f.settings.automaticManualActivity = true; f.reconciler.close();
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.snapshots, 0); assert.deepEqual(f.state, before);
});

test('accounting events report new activity and recovery but do not repeat on idle polls', async t => {
    const f = fixture(t), events = [];
    f.store.logger = row => events.push(row);
    addTrade(f); addDeposit(f);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(events.length, 1); assert.equal(events[0].type, 'external_activity_reconciled');
    assert.equal(events[0].externalCashDelta, -2); assert.equal(events[0].depositAmount, 5);
    assert.equal(events[0].balance, 23); assert.equal(events[0].receiptCount, 1);
    assert.equal(await f.reconciler.reconcile(), true); assert.equal(events.length, 1);
    f.state.entryHolds.external_activity = { retryable: true };
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(events.length, 2); assert.equal(events[1].receiptCount, 0);
});

test('diagnostic failure after durable accounting does not roll back or duplicate booked activity', async t => {
    const f = fixture(t); addTrade(f); addDeposit(f);
    f.store.event = () => { throw new Error('diagnostic_unavailable'); };
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.cash, 25); assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    const persisted = new Store(f.settings, 'pilot', 'late-entry').state;
    assert.equal(persisted.cash, 25); assert.equal(persisted.externalWalletActivity.receipts.length, 1);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.cash, 25); assert.equal(f.state.externalWalletActivity.receipts.length, 1);
});

test('deferred accounting diagnostics are bounded and report changed proof failures', async t => {
    const f = fixture(t), events = [];
    f.store.logger = row => { if (row.type === 'external_activity_deferred') events.push(row); };
    addTrade(f); f.holdings['51'] = 5;
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(events[0].error.code, 'external_activity_holdings_mismatch');
    f.time += 1000;
    assert.equal(await f.reconciler.reconcile(), false); assert.equal(events.length, 1);
    f.time += 60000;
    assert.equal(await f.reconciler.reconcile(), false); assert.equal(events.length, 2);
    f.time = f.reconciler.nextAt; f.balance++;
    assert.equal(await f.reconciler.reconcile(), false); assert.equal(events.length, 3);
    assert.equal(events[2].error.code, 'external_activity_balance_mismatch');
    assert.equal(f.state.externalWalletActivity, undefined); assert.equal(f.state.cash, 20);
});

test('external RPC failures back off to one minute without scanning during cooldown and reset after recovery', async t => {
    const f = fixture(t), discover = f.discover, before = financialState(f.state);
    f.discover = async (...args) => {
        await discover(...args);
        throw new OperationalError('rpc_read_rejected', 'transport', { stage: 'external_activity', httpStatus: 400 });
    };
    let attempts = 0;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        const failedAt = f.time;
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.scans.length, ++attempts);
        assert.equal(f.reconciler.nextAt, failedAt + delay);
        assert.equal(f.state.entryHolds.external_activity.retryAt, failedAt + delay);
        const held = structuredClone(f.state.entryHolds), snapshots = f.snapshots, reads = f.reads.length;
        for (const time of [failedAt, failedAt + delay - 1]) {
            f.time = time;
            assert.equal(await f.reconciler.reconcile({ block: 100, actual: 20 }), false);
            const preview = await f.reconciler.preview();
            assert.equal(preview.ready, false); assert.equal(preview.error.code, 'external_activity_retry_wait');
            assert.equal(f.snapshots, snapshots); assert.equal(f.reads.length, reads);
            assert.equal(f.scans.length, attempts); assert.deepEqual(f.state.entryHolds, held);
        }
        f.time = failedAt + delay;
    }
    assert.deepEqual(financialState(f.state), before);
    f.discover = discover;
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.reconciler.nextAt, 0); assert.equal(f.reconciler.retryDelayMs, 0);
    assert.equal(f.state.entryHolds.external_activity, undefined);
    f.tip++;
    f.discover = async () => { throw new Error('external_activity_receipt_unconfirmed'); };
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.reconciler.nextAt, f.time + 1000);
    assert.equal(f.state.entryHolds.external_activity.attempts, 1);
});

test('a new external reconciler respects the persisted retry deadline in reconcile and read-only preview', async t => {
    const f = fixture(t);
    addTrade(f); f.holdings['51'] = 5;
    assert.equal(await f.reconciler.reconcile(), false);
    f.time = f.reconciler.nextAt;
    assert.equal(await f.reconciler.reconcile(), false);
    const retryAt = f.reconciler.nextAt;
    const store = new Store(f.settings, 'pilot', 'late-entry'); store.logger = () => {};
    const reconciler = new ExternalActivityReconciler(f.config, store, f.client,
        { discover: f.discover, now: () => f.time });
    const snapshots = f.snapshots, reads = f.reads.length, scans = f.scans.length;
    f.time = retryAt - 1;
    assert.equal(await reconciler.reconcile(), false);
    assert.equal((await reconciler.preview()).error.code, 'external_activity_retry_wait');
    assert.equal(f.snapshots, snapshots); assert.equal(f.reads.length, reads); assert.equal(f.scans.length, scans);
    f.time = retryAt;
    assert.equal(await reconciler.reconcile(), false);
    assert.equal(f.scans.length, scans + 1); assert.equal(reconciler.nextAt, f.time + 4000);
    f.time = reconciler.nextAt; f.holdings['51'] = 4;
    assert.equal(await reconciler.reconcile(), true);
    assert.equal(store.state.entryHolds.external_activity, undefined);
});

test('failed hold persistence still throttles external proof retries without accounting changes', async t => {
    const f = fixture(t), before = financialState(f.state);
    f.reconciler.defer = () => { throw new Error('disk_full'); };
    f.discover = async () => { throw new Error('external_activity_receipt_unconfirmed'); };
    for (const delay of [1000, 2000, 4000]) {
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.reconciler.nextAt, f.time + delay);
        assert.equal(f.state.entryHolds?.external_activity, undefined);
        const snapshots = f.snapshots;
        f.time = f.reconciler.nextAt - 1;
        assert.equal(await f.reconciler.reconcile(), false); assert.equal(f.snapshots, snapshots);
        f.time++;
    }
    assert.deepEqual(financialState(f.state), before);
});
