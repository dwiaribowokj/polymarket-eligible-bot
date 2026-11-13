import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { Store } from '../../src/restart/store.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { CapitalDepositReconciler } from '../../src/laya-live/deposits.js';
import { totalCapitalDeposited } from '../../src/laya-live/capital-funding.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { ProfitTakingCoordinator } from '../../src/laya-live/profit-taking.js';
import { profitTakingBudget } from '../../src/laya-live/profit-accounting.js';
import { loadEligibleConfig } from '../../src/eligible-live/config.js';
import { eligiblePreflight } from '../../src/eligible-live/preflight.js';
import { main } from '../../scripts/eligible-live.js';
import { controlMain } from '../../scripts/eligible-live-control.js';

const wallet = `0x${'1'.repeat(40)}`, sender = `0x${'2'.repeat(40)}`, recipient = `0x${'3'.repeat(40)}`;
const hash = value => `0x${value.toString(16).padStart(64, '0')}`;
const token = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const market = { slug: 'offline-deposit-market', tokens: ['1', '2'], conditionId: hash(5), end: 1900000000000 };

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-deposit-integration-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    t.mock.method(globalThis, 'fetch', () => assert.fail('Integration fixtures must not contact a network'));
    const config = loadEligibleConfig({ RESTART_DATA_DIR: dataDir, ELIGIBLE_CONTINUOUS_TRADING: 'true',
        PROXY_WALLET_ADDRESS: wallet, LAYA_PROFIT_TAKING_ENABLED: 'false' });
    // Exercise the older deposit-only path; coexistence has its own integration suite.
    config.settings.automaticManualActivity = false;
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state, events = [];
    store.logger = event => events.push(event);
    Object.assign(state, { decisionProvider: 'eligible', cash: 20, peakEquity: 25, lastEquity: 20, maxDrawdown: 8,
        walletStart: 20, walletCashDelta: 0, liveFunding: { initialCapital: 20, allocation: 'available_balance' },
        reconciliationFaults: {}, strategyEpochs: [{ walletProof: { blockNumber: 100, blockHash: hash(100) } }] });
    store.save();
    const event = { address: CONTRACTS.collateralToken,
        ...token.encodeEventLog(token.getEvent('Transfer'), [sender, wallet, '5000000']),
        logIndex: 1, transactionHash: hash(501), blockNumber: 150, blockHash: hash(150), transactionIndex: 0 };
    const receipt = { transactionHash: hash(501), status: 1, confirmations: 10, blockNumber: 150,
        blockHash: hash(150), transactionIndex: 0, logs: [event] };
    const f = { config, store, state, events, dataDir, now: Date.now(), balance: 25, holdings: [0, 0],
        receipt, logs: [event], receiptsRead: 0, holdingsRead: 0, providerReady: true, gas: 5, closed: 0 };
    const financialWrite = () => assert.fail('No signing, orders, transfers or cancellations in deposit integration');
    const provider = {
        async getBlock(number) { return { number, hash: hash(number) }; },
        async getLogs(filter) {
            return f.logs.filter(log => log.address.toLowerCase() === filter.address.toLowerCase()
                && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock
                && filter.topics.every((topic, i) => topic === null || topic === log.topics[i].toLowerCase()));
        },
    };
    f.client = {
        async confirmedBlock() { this.rpc.anchor = { number: 200, hash: hash(200) }; return 200; },
        async balance(block) { assert.equal(block, 200); return f.balance; },
        async holdings(tokens, block) {
            assert.deepEqual(tokens, market.tokens); assert.equal(block, 200); f.holdingsRead++; return [...f.holdings];
        },
        async verifiedReceipt(txHash, block) {
            assert.equal(txHash, hash(501)); assert.equal(block, 200); f.receiptsRead++; return f.receipt;
        },
        rpc: { anchor: { number: 200, hash: hash(200) }, async validate() {},
            async read(_stage, task, block) { assert.equal(block, 200); return task(provider); } },
        async serverTime() { return Date.now(); }, async json() { return { blocked: false }; },
        async market() { return { ...market, minimum: 5, accepting: true, tick: .01, fee: { rate: .07, exponent: 1 } }; },
        async books() { return [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }]; },
        async walletHealth() { return { contract: true, signerIsOwner: true, threshold: 1, balance: f.balance,
            nativeGas: f.gas, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }; },
        async positions() { return []; }, async ordersAndTrades() { return { orders: [], trades: [] }; },
        async gasPriceUsd() { return 1; }, close() { f.closed++; },
        prepare: financialWrite, post: financialWrite, prepareAction: financialWrite,
        broadcastAction: financialWrite, prepareProfitTransfer: financialWrite, cancel: financialWrite,
    };
    f.providers = { preflight: async () => ({ eligible: { ready: f.providerReady, inferenceAttempted: false } }),
        predict: financialWrite };
    f.deposits = new CapitalDepositReconciler(config, store, f.client, { now: () => f.now });
    f.broker = new LayaLiveBroker(config.settings, store, f.client, financialWrite);
    f.broker.capitalDeposits = f.deposits;
    f.profit = new ProfitTakingCoordinator({ config, store, client: f.client, providers: f.providers });
    f.profit.capitalDeposits = f.deposits;
    return f;
}

function expose(f) {
    Object.assign(f.state, { cash: 16, walletCashDelta: -4,
        position: { market: structuredClone(market), startingCash: 20, holdings: [5, 0],
            orders: [], actions: [], receipts: {}, pendingTrades: false } });
    f.balance = 21; f.holdings = [5, 0];
    return f.state.position;
}

function entryWitness(f) {
    const now = Date.now();
    return { startedAt: now, checkedAt: now, block: 200, tokens: market.tokens, balance: f.balance, holdings: [0, 0] };
}

test('entry wallet surplus defers as an opportunity until canonical receipts are accounted', async t => {
    const f = fixture(t), witness = entryWitness(f);
    assert.throws(() => f.broker.assertEntryWallet(witness, market),
        { code: 'capital_deposit_verifying', category: 'opportunity' });
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.cash, 20);
    assert.equal(f.state.entryHolds.capital_deposit.retryable, true);
    assert.equal(f.receiptsRead, 0, 'Entry validation cannot import an unexplained balance increase');
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(f.receiptsRead, 1);
    assert.equal(f.state.cash, 25);
    assert.equal(f.state.entryHolds.capital_deposit, undefined);
    assert.doesNotThrow(() => f.broker.assertEntryWallet(witness, market));
});

test('unconfirmed incoming receipts pause wallet reads without a permanent reconciliation stop', async t => {
    const f = fixture(t); f.receipt.confirmations = 1;
    assert.equal(await f.broker.checkWallet(), false);
    assert.equal(f.state.stopped, null);
    assert.deepEqual(f.state.reconciliationFaults, {});
    assert.equal(f.state.cash, 20);
    assert.equal(totalCapitalDeposited(f.state), 0);
    assert.equal(f.state.entryHolds.capital_deposit.retryable, true);
    assert.equal(f.events.some(row => row.type === 'capital_deposit_credited'), false);
    f.receipt.confirmations = 10; f.now += 15000;
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(f.state.cash, 25);
    assert.equal(expectedWalletBalance(f.state), 25);
});

test('negative wallet mismatches remain permanent despite automatic deposit support', async t => {
    const f = fixture(t); f.balance = 19;
    assert.equal(await f.broker.checkWallet(), false);
    assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    assert.ok(f.state.reconciliationFaults.wallet_ledger_mismatch);
    assert.equal(f.receiptsRead, 0);
    assert.equal(f.state.cash, 20);
    assert.equal(totalCapitalDeposited(f.state), 0);
});

test('disabled automatic deposits preserve strict positive-mismatch entry protection', t => {
    const f = fixture(t); f.config.settings.automaticDeposits = false;
    assert.throws(() => f.broker.assertEntryWallet(entryWitness(f), market),
        { code: 'wallet_ledger_mismatch', category: 'reconciliation' });
    assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    assert.equal(f.state.cash, 20);
    assert.equal(f.receiptsRead, 0);
});

test('broker credits a proved open-position deposit without changing trade PnL or inventory', async t => {
    const f = fixture(t), position = expose(f), initialFunding = structuredClone(f.state.liveFunding);
    const originalPnl = f.state.cash - position.startingCash;
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(f.state.position, position);
    assert.equal(f.state.cash, 21);
    assert.equal(position.startingCash, 25);
    assert.equal(f.state.cash - position.startingCash, originalPnl);
    assert.deepEqual(position.holdings, [5, 0]);
    assert.deepEqual(f.state.liveFunding, initialFunding);
    assert.equal(f.state.walletStart, 20);
    assert.equal(expectedWalletBalance(f.state), 21);
    assert.equal(f.holdingsRead, 2, 'The deposit and normal wallet reconciliation independently check inventory');
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(totalCapitalDeposited(f.state), 5);
    assert.equal(f.events.filter(row => row.type === 'capital_deposit_credited').length, 1);
});

test('pending trade receipts prevent a surplus from changing cash or the open-position baseline', async t => {
    const f = fixture(t), position = expose(f); position.pendingTrades = true;
    assert.equal(await f.broker.checkWallet(), false);
    assert.equal(f.receiptsRead, 0);
    assert.equal(f.state.cash, 16);
    assert.equal(position.startingCash, 20);
    assert.equal(f.state.stopped, null);
    position.pendingTrades = false;
    assert.equal(await f.broker.checkWallet(), true);
    assert.equal(f.state.cash, 21);
    assert.equal(position.startingCash, 25);
});

test('canonical deposit receipts alone cannot credit an open position with unproved holdings', async t => {
    const f = fixture(t), position = expose(f); f.holdings = [4, 0];
    assert.equal(await f.broker.checkWallet(), false);
    assert.equal(f.receiptsRead, 1);
    assert.equal(f.state.cash, 16);
    assert.equal(position.startingCash, 20);
    assert.equal(totalCapitalDeposited(f.state), 0);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.capital_deposit.retryable, true);
});

test('profit wallet reconciliation adds principal without expanding available trading profit', async t => {
    const f = fixture(t);
    Object.assign(f.state, { cash: 24, walletCashDelta: 4, completed: [{ traded: true, pnl: 10, fees: 0, gas: 0 }] });
    f.balance = 29;
    const policy = { recipient, asset: 'pUSD', chunkUsd: 5, retainUsd: 20 };
    const original = profitTakingBudget(f.state, policy, { openOrders: [] });
    assert.deepEqual(await f.profit.wallet(), { block: 200, actual: 29 });
    const after = profitTakingBudget(f.state, policy, { openOrders: [] });
    assert.equal(f.state.cash, 29);
    assert.equal(expectedWalletBalance(f.state), 29);
    assert.equal(after.availableProfitUsd, original.availableProfitUsd);
    assert.equal(after.availableProfitUsd, 4);
    assert.equal(after.eligible, false);
    assert.equal(f.state.profitTaking, undefined);
});

test('profit wallet reads defer unproved surpluses but retain strict negative-mismatch stops', async t => {
    const f = fixture(t); f.receipt.confirmations = 1;
    await assert.rejects(f.profit.wallet(), { code: 'capital_deposit_verifying', category: 'opportunity' });
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.cash, 20);
    f.balance = 19;
    await assert.rejects(f.profit.wallet(), { code: 'profit_wallet_mismatch', category: 'reconciliation' });
    assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    assert.equal(totalCapitalDeposited(f.state), 0);
});

test('read-only preflight proves deposit recovery while preserving the saved stop and original funding', async t => {
    const f = fixture(t);
    f.state.stopped = { reason: 'wallet_ledger_mismatch', at: f.now - 1000 };
    f.state.reconciliationFaults.wallet_ledger_mismatch = { firstAt: f.now - 1000 };
    f.store.save();
    const before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
    const { output } = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history: [f.state] });
    assert.equal(output.readyForLive, false);
    assert.equal(output.startAllowed, false);
    assert.equal(output.operationalReady, false);
    assert.equal(output.capitalDepositRecoveryAvailable, true);
    assert.deepEqual(output.capitalDepositReview, { ready: true, amount: 5, balance: 25, deposits: 1 });
    assert.deepEqual(output.blockers, ['persistent_pilot_stop', 'live_preflight_blocked']);
    assert.deepEqual(f.state, before);
    assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
    assert.equal(f.events.length, 0);
});

test('startup deposit preview cannot authorize deficit, absent proof, risk stops or failed operational checks', async t => {
    for (const [name, change] of [
        ['wallet deficit', f => { f.balance = 19; }],
        ['unconfirmed receipt', f => { f.receipt.confirmations = 1; }],
        ['risk stop', f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: f.now }; }],
        ['gas funding', f => { f.gas = 0; }],
        ['provider unavailable', f => { f.providerReady = false; }],
    ]) await t.test(name, async t => {
        const f = fixture(t); change(f); f.store.save();
        const before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
        const { output } = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history: [f.state] });
        assert.equal(output.capitalDepositRecoveryAvailable, false);
        assert.equal(output.readyForLive, false);
        assert.deepEqual(f.state, before);
        assert.deepEqual(fs.readFileSync(f.store.filename), bytes);
    });
});

test('CLI preflight and poly check admit proved recovery without persisting or operating the service', async t => {
    const f = fixture(t), before = fs.readFileSync(f.store.filename), output = [];
    const code = await main(['preflight'], { config: f.config, clientFactory: () => f.client,
        write: row => output.push(row), acquireLock: () => assert.fail('Preflight must not acquire the live write lock') });
    assert.equal(code, 1);
    assert.equal(output.length, 1);
    assert.equal(output[0].capitalDepositRecoveryAvailable, true);
    assert.equal(f.closed, 1);
    assert.deepEqual(fs.readFileSync(f.store.filename), before);
    const calls = [], messages = [];
    const checked = await controlMain(['check'], { root: f.dataDir, home: f.dataDir, env: {}, nodeVersion: '24.0.0',
        install: () => assert.fail('Read-only check must not install a service'), write: row => messages.push(row),
        run: async (command, args) => {
            calls.push([command, args]);
            assert.equal(command, process.execPath);
            assert.equal(args.at(-1), 'preflight');
            return { code, stdout: JSON.stringify(output[0]), stderr: '' };
        } });
    assert.equal(checked, 0);
    assert.equal(calls.length, 1);
    assert.ok(messages.some(message => message.includes('Deposit terverifikasi')));
    assert.deepEqual(fs.readFileSync(f.store.filename), before);
    assert.equal(totalCapitalDeposited(f.state), 0);
});
