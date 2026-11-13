import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { Store } from '../../src/restart/store.js';
import { preflight } from '../../src/restart/preflight.js';
import { eligiblePreflight, applyEligibleExternalOrderReadiness } from '../../src/eligible-live/preflight.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { ProfitTakingCoordinator } from '../../src/laya-live/profit-taking.js';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';
import { ExternalActivityReconciler } from '../../src/laya-live/external-activity.js';
import { externalOrderReservations, assertExternalTradesSettled } from '../../src/laya-live/external-orders.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';

const hash = byte => `0x${byte.repeat(64)}`;
const wallet = `0x${'b'.repeat(40)}`, blockHash = hash('c'), checkpointHash = hash('d');
const botMarket = { slug: 'bot-market', conditionId: hash('1'), tokens: ['1', '2'], minimum: 5,
    accepting: true, tick: .01, fee: { rate: .07, exponent: 1 }, end: Date.now() + 300000 };
const manualMarket = { conditionId: hash('2'), tokens: ['5', '6'] };
const encode = value => ethers.utils.defaultAbiCoder.encode(['uint256'], [value]);

function fixture(t, { enabled = true, balance = 20 } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-coexistence-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const id = '0123456789abcdef';
    const settings = { ...BASELINE, dataDir, fingerprint: id, wallet, privateKey: `0x${'1'.repeat(64)}`,
        continuousTrading: true, automaticManualActivity: enabled, automaticDeposits: true,
        pilotHours: Infinity, pilotMarkets: Infinity, drawdownStop: 10, capital: 20 };
    const config = { id, runtimeId: id, settings, policy: { provider: 'eligible', continuousTrading: true },
        profitTaking: { enabled: false }, paperEvidence: { qualified: true } };
    const store = new Store(settings, 'pilot', 'late-entry'); store.logger = () => {};
    Object.assign(store.state, { decisionProvider: 'eligible', cash: 20, peakEquity: 25, maxDrawdown: 5,
        lastEquity: 20, walletStart: 20, walletCashDelta: 0, liveFunding: { initialCapital: 20 },
        stopped: null, liveRiskStop: null, position: null, completed: [], seen: {},
        strategyEpochs: [{ walletProof: { blockNumber: 50, blockHash: checkpointHash, balance: 20,
            trades: {}, holdingsProof: { holdings: [] } } }],
        capitalFunding: { schema: 1, chainId: 137, tokenAddress: CONTRACTS.collateralToken.toLowerCase(),
            walletAddress: wallet, totalDeposited: 0, entries: {},
            checkpoint: { blockNumber: 50, blockHash: checkpointHash } } });
    store.save();
    const f = { config, settings, store, state: store.state, balance, orders: [], trades: [], positions: [],
        holdings: {}, financialWrites: [], snapshots: 0, blockNumber: 100, blockHash, events: [] };
    const write = name => () => { f.financialWrites.push(name); assert.fail(`Unexpected financial write: ${name}`); };
    f.client = {
        startBtcFeed() {}, serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        market: async () => botMarket, books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: f.balance,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => f.positions, ordersAndTrades: async () => ({ orders: f.orders, trades: f.trades }),
        openOrders: async () => f.orders,
        gasPriceUsd: async () => 1,
        confirmedBlock: async () => { f.snapshots++; f.client.rpc.anchor = { number: f.blockNumber, hash: f.blockHash }; return f.blockNumber; },
        balance: async () => f.balance, holdings: async tokens => tokens.map(token => f.holdings[token] || 0),
        rpc: { anchor: { number: 100, hash: blockHash }, validate: async () => true,
            read: async (_stage, task) => task({ getBlock: async number => ({ number,
                hash: number === 50 ? checkpointHash : f.blockHash }), send: async (method, params) => {
                if (method === 'eth_chainId') return '0x89';
                if (method === 'eth_getTransactionCount') return '0x2';
                if (method === 'eth_call') return encode(2);
                if (method === 'eth_getBlockByNumber') return { number: params[0],
                    hash: params[0] === '0x32' ? checkpointHash : f.blockHash };
                assert.fail(`Unexpected RPC: ${method}`);
            } }) },
        prepare: write('prepare'), post: write('post'), cancel: write('cancel'),
        prepareAction: write('prepareAction'), broadcastAction: write('broadcastAction'),
        prepareProfitTransfer: write('prepareProfitTransfer'),
    };
    f.providers = { preflight: async () => ({ eligible: { ready: true, inferenceAttempted: false } }),
        predict: write('predict') };
    f.broker = new LayaLiveBroker(settings, store, f.client, async () => {});
    return f;
}

function manualOrder(changes = {}) {
    return { id: hash('a'), tokenId: '5', assetId: '5', conditionId: manualMarket.conditionId,
        side: 'BUY', originalSize: 5, sizeMatched: 1, price: .6, ...changes };
}

function discovery(f, { cash = -2, tokenId = '5', amount = 4 } = {}) {
    return { receipts: [{ hash: hash('e'), blockNumber: 80, blockHash: hash('f'), cash,
        tokenIds: [tokenId], holdings: [amount] }], externalCashDelta: cash, tokenIds: [tokenId],
        holdingsDeltas: [{ tokenId, amount }], deposits: [], depositAmount: 0,
        checkpoint: { blockNumber: f.blockNumber, blockHash: f.blockHash } };
}

function reconciler(f, discover = async () => discovery(f)) {
    return f.broker.externalActivity = new ExternalActivityReconciler(f.config, f.store, f.client, { discover });
}

function botPosition(f) {
    f.state.position = { market: { ...botMarket, tokens: [...botMarket.tokens] }, openedAt: Date.now() - 1000,
        holdings: [5, 0], bought: [5, 0], actions: [], fills: [], receipts: {}, entryCost: 4, fees: 0,
        pendingTrades: false, orders: [{ orderId: hash('7'), tokenId: '1', side: 'BUY', kind: 'taker',
            index: 0, price: .8, shares: 5, filled: 5, settled: 5, status: 'complete', receiptProvenComplete: true }] };
    f.holdings['1'] = 5;
    return f.state.position;
}

test('read-only eligible preflight accepts proven manual buys without rewriting the ledger', async t => {
    const f = fixture(t, { balance: 18 });
    f.holdings['5'] = 4;
    f.positions = [{ conditionId: manualMarket.conditionId, tokenId: '5', size: 4 }];
    const preview = ExternalActivityReconciler.prototype.preview;
    t.mock.method(ExternalActivityReconciler.prototype, 'preview', function (options) {
        this.discover = async () => discovery(f);
        return preview.call(this, options);
    });
    const before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
    const { output } = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history: [f.state] });
    assert.equal(output.externalActivityRecoveryAvailable, true);
    assert.equal(output.readyForLive, true);
    assert.equal(output.walletReconciliation.actualPUSD, 18);
    assert.equal(output.walletReconciliation.externalCashDelta, -2);
    assert.equal(output.allocatedCapital, 20);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
    assert.deepEqual(f.financialWrites, []);
});

test('a failed external proof blocks preflight even when zero-net manual activity leaves cash unchanged', async t => {
    const f = fixture(t);
    f.positions = [{ conditionId: manualMarket.conditionId, tokenId: '5', size: 4 }];
    t.mock.method(ExternalActivityReconciler.prototype, 'preview', async () => null);
    const before = structuredClone(f.state);
    const { output } = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history: [f.state] });
    assert.equal(output.readyForLive, false);
    assert.equal(output.operationalReady, false);
    assert(output.checks.some(check => !check.ok && /external/.test(check.name)));
    assert.deepEqual(f.state, before); assert.deepEqual(f.financialWrites, []);
});

test('an entry wallet mismatch defers external accounting without latching a stop', async t => {
    const f = fixture(t, { balance: 18 }); reconciler(f);
    await assert.rejects(f.broker.entryWallet(botMarket), error => error.code === 'external_activity_verifying');
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.external_activity.retryable, true);
    assert.equal(f.state.cash, 20); assert.equal(f.state.externalWalletActivity, undefined);
    assert.deepEqual(f.financialWrites, []);
});

test('same-market manual holdings and orders skip that opportunity without a global stop', async t => {
    for (const kind of ['holdings', 'order']) await t.test(kind, async t => {
        const f = fixture(t); reconciler(f);
        if (kind === 'holdings') f.holdings['1'] = 2;
        else f.orders = [manualOrder({ tokenId: '1', conditionId: botMarket.conditionId })];
        const before = structuredClone(f.state);
        await assert.rejects(f.broker.entryWallet(botMarket), error => error.code === 'external_market_overlap'
            && error.category === 'opportunity');
        assert.deepEqual(f.state, before); assert.equal(f.state.stopped, null); assert.deepEqual(f.financialWrites, []);
    });
});

test('other-market manual orders reduce broker spendable cash without becoming bot orders', async t => {
    const f = fixture(t); reconciler(f);
    f.orders = [manualOrder({ originalSize: 19, sizeMatched: 1 })];
    const witness = await f.broker.entryWallet(botMarket);
    assert.equal(witness.balance, 20); assert.equal(witness.spendable, 2);
    assert.deepEqual(witness.externalOrders, { count: 1, reservedPUSD: 18, overlaps: false });
    assert.equal(f.state.cash, 20); assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
    assert.deepEqual(f.financialWrites, []);
});

test('final execution validation refuses to spend collateral reserved by manual orders', async t => {
    const f = fixture(t); reconciler(f);
    f.orders = [manualOrder({ originalSize: 19, sizeMatched: 1 })];
    const now = Date.now(), market = { ...botMarket, open: now - 240000, end: now + 60000,
        ticks: [.01, .01], negRisk: false, fee: { rate: .07, exponent: 1, takerOnly: true } };
    const spec = { index: 0, tokenId: '1', snapshotPrice: .77, price: .78,
        shares: 5, side: 'BUY', kind: 'taker', cost: 4.01006 };
    const rows = market.tokens.map((tokenId, index) => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: now, fetchedAt: now, bids: [{ price: index ? .22 : .76, size: 10 }],
        asks: [{ price: index ? .23 : .77, size: 10 }] }));
    const config = { ...f.config, policy: { provider: 'laya' }, ai: { shares: 5, entryCap: 5, gasUsd: .05,
        decisionMs: 3000, dataAgeMs: 5000, control: f.settings, limitSlippageTicks: 1, limitSlippageUsd: .01 } };
    const snapshot = { snapshotId: 'manual-reservation', at: now - 500, observedAt: now - 500,
        decisionReceivedAt: now - 250, allowed: [spec],
        validation: { at: now - 500, generation: 1, identity: metadataIdentity(market) } };
    const decision = { snapshotId: snapshot.snapshotId, status: 'ok', model: 'typed-decisions', action: 'BUY_UP' };
    const witness = await f.broker.entryWallet(market);
    const engine = Object.assign(Object.create(LayaLiveEngine.prototype), {
        config, settings: f.settings, store: f.store, broker: f.broker, client: f.client, closed: false,
        entryContext: { market, snapshot, decision, wallet: witness },
        books: { generation: 1, tokens: market.tokens, snapshot: () => rows },
        assertEntryClock() {}, assertSignal() {},
    });
    await assert.rejects(engine.validate(spec), error => error.code === 'entry_wallet_insufficient');
    assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
    assert.equal(f.state.cash, 20); assert.deepEqual(f.financialWrites, []);
});

test('disabled coexistence preserves strict wallet and inventory stop behavior', async t => {
    for (const kind of ['cash', 'holdings']) await t.test(kind, async t => {
        const f = fixture(t, { enabled: false, balance: kind === 'cash' ? 18 : 20 }); reconciler(f);
        if (kind === 'holdings') f.holdings['1'] = 2;
        const code = kind === 'cash' ? 'wallet_ledger_mismatch' : 'legacy_inventory_overlap';
        await assert.rejects(f.broker.entryWallet(botMarket), error => error.code === code);
        assert.equal(f.state.stopped.reason, code); assert.deepEqual(f.financialWrites, []);
    });
});

test('external proof failure with an open bot position holds accounting without changing bot inventory', async t => {
    const f = fixture(t, { balance: 18 });
    const position = botPosition(f), before = structuredClone(position);
    reconciler(f, async () => { throw new Error('external_activity_receipt_unconfirmed'); });
    assert.equal(await f.broker.readWallet(), false);
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.external_activity.retryable, true);
    assert.deepEqual(position, before); assert.equal(f.state.cash, 20);
    assert.equal(expectedWalletBalance(f.state), 20); assert.deepEqual(f.financialWrites, []);
});

test('proven manual buys in another market coexist with a settled open bot position', async t => {
    const f = fixture(t, { balance: 18 }), position = botPosition(f), before = structuredClone(position);
    f.holdings['5'] = 4;
    reconciler(f);
    const snapshot = f.client.confirmedBlock;
    let reads = 0;
    f.client.confirmedBlock = async () => {
        if (++reads > 1) { f.blockNumber++; f.blockHash = hash('8'); }
        return snapshot();
    };
    f.client.holdings = async (tokens, block) => {
        assert.equal(block, f.client.rpc.anchor.number, 'broker must retain the reconciled RPC anchor');
        return tokens.map(token => f.holdings[token] || 0);
    };
    assert.equal(await f.broker.readWallet(), true);
    assert.equal(reads, 1);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    assert.equal(expectedWalletBalance(f.state), 18);
    assert.equal(f.state.cash, 20); assert.equal(f.state.peakEquity, 25); assert.equal(f.state.maxDrawdown, 5);
    assert.deepEqual(position, before); assert.equal(f.state.stopped, null); assert.deepEqual(f.financialWrites, []);
});

test('unsettled bot orders defer manual attribution until their own receipts reconcile', async t => {
    const f = fixture(t, { balance: 18 }), position = botPosition(f);
    position.pendingTrades = true; position.orders[0].status = 'accepted';
    position.orders[0].receiptProvenComplete = false;
    let discoveries = 0;
    reconciler(f, async () => { discoveries++; return discovery(f); });
    const before = structuredClone(position);
    assert.equal(await f.broker.readWallet(), false);
    assert.equal(discoveries, 0); assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.external_activity.retryable, true);
    assert.equal(f.state.externalWalletActivity, undefined); assert.deepEqual(position, before);
    assert.deepEqual(f.financialWrites, []);
});

test('manual orders appearing in an open bot market hold reconciliation and recover when removed', async t => {
    const f = fixture(t), position = botPosition(f); reconciler(f);
    f.orders = [manualOrder({ tokenId: '2', conditionId: botMarket.conditionId })];
    const before = structuredClone(position);
    await f.broker.reconcile(null, Date.now());
    assert.equal(f.state.stopped, null); assert.equal(position.uncertain, undefined);
    assert.equal(f.state.entryHolds.external_order_overlap.retryable, true);
    assert.equal(f.broker.reconciliationComplete, false);
    assert.deepEqual(position.holdings, before.holdings); assert.deepEqual(position.orders, before.orders);
    f.orders = [];
    await f.broker.reconcile(null, Date.now());
    assert.equal(f.state.entryHolds.external_order_overlap, undefined);
    assert.equal(f.broker.reconciliationComplete, true); assert.equal(f.state.stopped, null);
    assert.deepEqual(f.financialWrites, []);
});

test('profit withdrawal wallet checks remain available while an owned operation is in progress', async t => {
    for (const stage of ['address_ready', 'source_uncertain', 'in_transit']) await t.test(stage, async t => {
        const f = fixture(t);
        f.state.profitTakingControl = { operation: { id: 'owned-withdrawal', stage } };
        let discoveries = 0;
        const externalActivity = reconciler(f, async () => { discoveries++; assert.fail('Owned withdrawal must settle first'); });
        const coordinator = Object.assign(Object.create(ProfitTakingCoordinator.prototype), {
            config: f.config, store: f.store, client: f.client, externalActivity,
        });
        assert.deepEqual(await coordinator.wallet(), { block: 100, actual: 20 });
        assert.equal(discoveries, 0); assert.equal(f.state.entryHolds?.external_activity, undefined);
        assert.equal(f.state.stopped, null); assert.deepEqual(f.financialWrites, []);
        f.balance = 18;
        await assert.rejects(coordinator.wallet(), error => error.code === 'external_activity_verifying');
        assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 20);
        assert.equal(f.state.externalWalletActivity, undefined); assert.deepEqual(f.financialWrites, []);
    });
});

test('a manual buy while maintenance preparation awaits cannot persist or broadcast the prepared action', async t => {
    const f = fixture(t), position = botPosition(f);
    reconciler(f, async () => ({ receipts: [], externalCashDelta: 0, tokenIds: [], holdingsDeltas: [],
        deposits: [], depositAmount: 0, checkpoint: { blockNumber: 100, blockHash } }));
    f.broker.reconcileBlock = 100;
    f.broker.autoRedeemScan = { position, block: 100, clear: true };
    let prepared, preparing;
    const begun = new Promise(resolve => { preparing = resolve; });
    const delayed = new Promise(resolve => { prepared = resolve; });
    f.client.prepareAction = async () => { preparing(); return delayed; };
    const pending = f.broker.action('redeem', 0, Date.now());
    await begun;
    f.balance = 19; f.holdings['1'] = 6;
    prepared({ hash: hash('9'), kind: 'redeem', amount: 0, status: 'prepared' });
    assert.equal(await pending, false);
    assert.deepEqual(position.actions, []); assert.deepEqual(position.holdings, [5, 0]);
    assert.equal(f.state.entryHolds.external_activity.retryable, true);
    assert.equal(f.state.cash, 20); assert.equal(f.state.stopped, null);
    assert.deepEqual(f.financialWrites, []);
});

test('fresh maintenance checks require current exact holdings, settled manual trades and no overlap', async t => {
    for (const kind of ['safe', 'extra holdings', 'pending FAK', 'manual market order', 'stale'])
        await t.test(kind, async t => {
            const f = fixture(t), position = botPosition(f); reconciler(f);
            let now = Date.now(); t.mock.method(Date, 'now', () => now);
            if (kind === 'extra holdings') f.holdings['1'] = 6;
            if (kind === 'pending FAK') {
                f.trades = [{ status: 'MATCHED', transactionHash: hash('e') }];
                f.client.verifiedReceipt = async () => null;
            }
            if (kind === 'manual market order') f.orders = [manualOrder({ conditionId: botMarket.conditionId, tokenId: '2' })];
            if (kind === 'safe') f.orders = [manualOrder()];
            if (kind === 'stale') f.client.ordersAndTrades = async () => {
                now += f.settings.maxDataAgeMs + 1; return { orders: [], trades: [] };
            };
            const before = structuredClone(position);
            assert.equal(await f.broker.freshMaintenanceWallet(position), kind === 'safe');
            if (kind !== 'safe') assert.equal(f.state.entryHolds.external_activity.retryable, true);
            assert.deepEqual(position, before); assert.equal(f.state.stopped, null);
            assert.deepEqual(f.financialWrites, []);
        });
});

test('a stop or new pending bot trade during final maintenance reads prevents action persistence', async t => {
    for (const kind of ['stop', 'pending bot trade']) await t.test(kind, async t => {
        const f = fixture(t), position = botPosition(f); reconciler(f);
        f.client.prepareAction = async () => ({ hash: hash('9'), kind: 'merge', amount: 1, status: 'prepared' });
        f.client.ordersAndTrades = async () => {
            if (kind === 'stop') f.state.stopped = { reason: 'manual_stop', at: Date.now() };
            else position.pendingTrades = true;
            return { orders: [], trades: [] };
        };
        assert.equal(await f.broker.action('merge', 1, Date.now()), false);
        assert.deepEqual(position.actions, []);
        if (kind === 'stop') assert.equal(f.state.stopped.reason, 'manual_stop');
        else assert.equal(f.state.stopped, null);
        assert.deepEqual(f.financialWrites, []);
    });
});

test('manual order reservations exclude bot orders and reserve remaining external BUY payout', async t => {
    const f = fixture(t), external = manualOrder(), own = manualOrder({ id: hash('9') });
    const sell = manualOrder({ id: hash('8'), side: 'SELL', tokenId: '6' });
    const reservation = externalOrderReservations([external, own, sell], { owned: [own.id], market: botMarket });
    assert.deepEqual(reservation, { count: 2, reservedPUSD: 4, overlaps: false });
    assert.equal(externalOrderReservations([external], { market: manualMarket }).overlaps, true);
    f.orders = [external];
    const before = fs.readFileSync(f.store.filename);
    t.mock.method(ExternalActivityReconciler.prototype, 'preview', async () => ({
        ready: true, balance: 20, totalExternalCashDelta: 0,
    }));
    const { account: result, output } = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history: [f.state] });
    assert.equal(result.liveReady, true);
    assert.equal(output.readyForLive, true);
    assert.equal(result.checks.find(check => check.name === 'unowned_open_orders').detail.external.reservedPUSD, 4);
    assert.deepEqual(fs.readFileSync(f.store.filename), before); assert.deepEqual(f.financialWrites, []);
});

test('strict preflight retains unowned-order rejection without coexistence enabled', async t => {
    const f = fixture(t, { enabled: false }); f.orders = [manualOrder()];
    const result = await preflight(f.client, f.settings);
    assert.equal(result.liveReady, false);
    assert.equal(result.checks.find(check => check.name === 'unowned_open_orders').ok, false);
    const before = structuredClone(result);
    applyEligibleExternalOrderReadiness(f.config, result);
    assert.deepEqual(result, before);
    assert.deepEqual(f.financialWrites, []);
});

test('eligible manual-order readiness changes only validated external-order admission', async t => {
    const f = fixture(t); f.orders = [manualOrder()];
    const result = await preflight(f.client, f.settings);
    assert.equal(result.liveReady, false);
    const before = structuredClone(result);
    applyEligibleExternalOrderReadiness(f.config, result);
    assert.equal(result.liveReady, true);
    assert.deepEqual(result.checks.filter(check => check.name !== 'unowned_open_orders'),
        before.checks.filter(check => check.name !== 'unowned_open_orders'));
    for (const key of Object.keys(before).filter(key => !['checks', 'liveReady'].includes(key)))
        assert.deepEqual(result[key], before[key], key);
    assert.deepEqual(f.financialWrites, []);
});

test('eligible manual-order readiness preserves failed authentication, malformed orders, and unrelated blockers', async t => {
    for (const kind of ['authentication', 'malformed order', 'funding']) await t.test(kind, async t => {
        const f = fixture(t); f.orders = [manualOrder()];
        if (kind === 'authentication') f.client.ordersAndTrades = async () => { throw new Error('offline_auth_failure'); };
        if (kind === 'malformed order') f.orders[0].originalSize = -1;
        if (kind === 'funding') f.balance = 0;
        const result = await preflight(f.client, f.settings), before = structuredClone(result);
        assert.equal(result.liveReady, false);
        applyEligibleExternalOrderReadiness(f.config, result);
        assert.equal(result.liveReady, false);
        if (kind !== 'funding') assert.deepEqual(result, before);
        else {
            assert.equal(result.checks.find(check => check.name === 'unowned_open_orders').ok, true);
            assert.deepEqual(result.checks.find(check => check.name === 'funding'),
                before.checks.find(check => check.name === 'funding'));
        }
        assert.deepEqual(result.checks.find(check => check.name === 'authenticated_order_trade_api'),
            before.checks.find(check => check.name === 'authenticated_order_trade_api'));
        assert.deepEqual(f.financialWrites, []);
    });
});

test('pending manual FAK trades cannot bypass entry when their open order has disappeared', async t => {
    const f = fixture(t); reconciler(f);
    f.trades = [{ id: 'manual-fak', status: 'MATCHED', traderSide: 'TAKER', takerOrderId: hash('8'),
        transactionHash: hash('e'), conditionId: manualMarket.conditionId, assetId: '5', side: 'BUY', size: '5', price: '.6' }];
    f.client.verifiedReceipt = async () => null;
    await assert.rejects(f.broker.entryWallet(botMarket), error => error.code === 'external_trades_pending'
        && error.category === 'opportunity');
    assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
    assert.deepEqual(f.financialWrites, []);
    f.client.verifiedReceipt = async () => ({ transactionHash: hash('e'), status: 1,
        blockNumber: 99, blockHash: hash('f'), confirmations: 2 });
    const witness = await f.broker.entryWallet(botMarket);
    assert.equal(witness.balance, 20); assert.equal(witness.spendable, 20);
    assert.equal(f.state.cash, 20); assert.equal(f.state.externalWalletActivity, undefined);
});

test('external trade admission accepts terminal API states and defers uncertain status without accounting writes', async t => {
    assert.deepEqual(await assertExternalTradesSettled(['CONFIRMED', 'FAILED', 'TRADE_STATUS_CONFIRMED',
        'TRADE_STATUS_FAILED'].map(status => ({ status }))), { apiTerminal: 4, owned: 0, receiptConfirmed: [] });
    for (const trade of [null, {}, { status: 'UNKNOWN' }, { status: 'MATCHED' },
        { status: 'MATCHED', transactionHash: hash('0') }]) {
        await assert.rejects(assertExternalTradesSettled([trade]), error => error.code === 'external_trades_pending');
    }
    const f = fixture(t), owned = hash('a');
    const result = await assertExternalTradesSettled([
        { status: 'MATCHED', traderSide: 'TAKER', takerOrderId: owned },
        { status: 'MINED', traderSide: 'MAKER', makerOrders: [{ orderId: owned }] },
    ], { owned: [owned] });
    assert.equal(result.owned, 2);
    await assert.rejects(assertExternalTradesSettled([{ status: 'MATCHED', traderSide: 'MAKER',
        makerOrders: [{ orderId: owned }, { orderId: hash('b') }] }], { owned: [owned] }),
    error => error.code === 'external_trades_pending');
    assert.deepEqual(f.financialWrites, []);
});

test('canonical receipts settle stale manual API statuses once per hash while known proofs avoid RPC', async t => {
    const f = fixture(t), before = structuredClone(f.state), transactionHash = hash('e'), known = hash('f');
    const calls = [];
    f.client.verifiedReceipt = async (tx, block) => {
        calls.push({ hash: tx, block }); return { transactionHash: tx, status: 1,
            blockNumber: 99, blockHash: hash('9'), confirmations: 2 };
    };
    const result = await assertExternalTradesSettled([
        { status: 'MATCHED', transactionHash }, { status: 'TRADE_STATUS_MINED', transactionHash },
        { status: 'RETRYING', transactionHash: known },
    ], { client: f.client, block: 100, knownHashes: [known] });
    assert.deepEqual(calls, [{ hash: transactionHash, block: 100 }]);
    assert.deepEqual(result.receiptConfirmed, [
        { transactionHash, blockNumber: 99, blockHash: hash('9'), source: 'canonical_receipt' },
        { transactionHash: known, source: 'known_receipt' },
    ]);
    assert.deepEqual(f.state, before); assert.deepEqual(f.financialWrites, []);
});

test('pending trade admission rejects missing, failed, unconfirmed, future and changed-anchor receipts', async t => {
    const changes = {
        missing: () => null,
        failed: receipt => ({ ...receipt, status: 0 }),
        unconfirmed: receipt => ({ ...receipt, confirmations: 1 }),
        future: receipt => ({ ...receipt, blockNumber: 101 }),
        identity: receipt => ({ ...receipt, transactionHash: hash('8') }),
        blockHash: receipt => ({ ...receipt, blockHash: hash('0') }),
        anchor: (receipt, f) => { f.client.rpc.anchor.hash = hash('8'); return receipt; },
        unavailable: () => { throw new Error('rpc_unavailable'); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t), transactionHash = hash('e');
        f.client.verifiedReceipt = async () => change({ transactionHash, status: 1,
            blockNumber: 99, blockHash: hash('f'), confirmations: 2 }, f);
        await assert.rejects(assertExternalTradesSettled([{ status: 'MATCHED', transactionHash }],
            { client: f.client, block: 100 }), error => error.code === 'external_trades_pending'
                && error.category === 'opportunity');
        assert.equal(f.state.stopped, null); assert.deepEqual(f.financialWrites, []);
    });
});
