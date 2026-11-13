import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/restart/store.js';
import { capitalFundingLedger, totalCapitalDeposited, applyConfirmedCapitalDeposits }
    from '../../src/laya-live/capital-funding.js';
import { profitTakingBudget } from '../../src/laya-live/profit-accounting.js';

const tokenAddress = `0x${'11'.repeat(20)}`, walletAddress = `0x${'22'.repeat(20)}`;
const from = `0x${'33'.repeat(20)}`, recipient = `0x${'44'.repeat(20)}`;
const hash = value => `0x${value.toString(16).padStart(64, '0')}`;
const identity = { chainId: 137, tokenAddress, walletAddress };
const transfer = (index = 1, amount = 5, overrides = {}) => ({ txHash: hash(index),
    logIndex: index, from, amount, blockNumber: 100 + index, blockHash: hash(100 + index), ...overrides });
const review = (entries = [transfer()], expectedBalanceBefore = 24, actualBalanceAfter = 29, overrides = {}) => ({
    ...identity, entries, expectedBalanceBefore, actualBalanceAfter,
    checkpoint: { blockNumber: 200, blockHash: hash(200) }, ...overrides,
});

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-capital-funding-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const settings = { dataDir: directory, fingerprint: 'offline-capital-funding', capital: 20 };
    const store = new Store(settings, 'pilot', 'late-entry');
    store.logger = () => {};
    Object.assign(store.state, { startedAt: 1800000000000, cash: 24, peakEquity: 30.123456789,
        lastEquity: 24.123456789, maxDrawdown: 9, walletStart: 20, walletCashDelta: 4,
        liveFunding: { at: 1800000000000, initialCapital: 20, capitalCap: null, minimumBalance: 0 },
        completed: [{ traded: true, pnl: 10, fees: 0, gas: 0 }],
        stopped: { reason: 'wallet_reconciliation_mismatch', at: 1800000000001 },
        liveRiskStop: { reason: 'drawdown_limit', peakEquity: 30, equity: 21, at: 1800000000002 } });
    return { store, settings };
}

test('a verified deposit increases trading cash without creating profit or erasing drawdown and stops', t => {
    const { store } = fixture(t), state = store.state;
    const original = structuredClone(state), drawdown = state.peakEquity - state.lastEquity;
    const policy = { recipient, asset: 'pUSD', chunkUsd: 5, retainUsd: 20 };
    const budgetBefore = profitTakingBudget(state, policy, { openOrders: [] });
    const result = applyConfirmedCapitalDeposits(store, review());
    assert.equal(result.amount, 5);
    assert.equal(result.applied.length, 1);
    assert.equal(state.cash, 29);
    assert.equal(state.peakEquity, original.peakEquity + 5);
    assert.equal(state.lastEquity, original.lastEquity + 5);
    assert.ok(Math.abs(state.peakEquity - state.lastEquity - drawdown) < 1e-12);
    assert.equal(totalCapitalDeposited(state), 5);
    assert.equal(state.cash - state.liveFunding.initialCapital - totalCapitalDeposited(state), 4);
    const budgetAfter = profitTakingBudget(state, policy, { openOrders: [] });
    assert.equal(budgetAfter.realizedProfitUsd, budgetBefore.realizedProfitUsd);
    assert.equal(budgetAfter.availableProfitUsd, budgetBefore.availableProfitUsd);
    for (const key of ['liveFunding', 'walletStart', 'walletCashDelta', 'maxDrawdown', 'completed', 'stopped', 'liveRiskStop'])
        assert.deepEqual(state[key], original[key], key);
    const persisted = JSON.parse(fs.readFileSync(store.filename, 'utf8'));
    assert.equal(persisted.cash, 29);
    assert.equal(persisted.capitalFunding.totalDeposited, 5);
});

test('restart and partially repeated batches credit each receipt once', t => {
    const { store, settings } = fixture(t);
    applyConfirmedCapitalDeposits(store, review([transfer(1, '0.000001')], 24, '24.000001'));
    const restarted = new Store(settings, 'pilot', 'late-entry');
    let saves = 0;
    const save = restarted.save.bind(restarted);
    restarted.save = () => { saves++; save(); };
    const replay = applyConfirmedCapitalDeposits(restarted, review([transfer(1, '0.000001')], '24.000001', '24.000001'));
    assert.equal(replay.amount, 0);
    assert.equal(replay.applied.length, 0);
    assert.equal(replay.skipped.length, 1);
    assert.equal(saves, 0);
    const partial = applyConfirmedCapitalDeposits(restarted,
        review([transfer(1, '0.000001'), transfer(2, '4.999999')], '24.000001', 29));
    assert.equal(partial.amount, 4.999999);
    assert.equal(partial.skipped.length, 1);
    assert.equal(partial.applied.length, 1);
    assert.equal(restarted.state.cash, 29);
    assert.equal(totalCapitalDeposited(restarted.state), 5);
    assert.equal(Object.keys(capitalFundingLedger(new Store(settings, 'pilot', 'late-entry').state).entries).length, 2);
});

test('a deposit during an open trade moves its baseline and retains position identity', t => {
    const { store, settings } = fixture(t);
    const position = { startingCash: 26, holdings: [5, 0], orders: [], lastDeployed: 2 };
    store.state.position = position;
    const tradePnl = store.state.cash - position.startingCash;
    applyConfirmedCapitalDeposits(store, review());
    assert.equal(store.state.position, position);
    assert.equal(position.startingCash, 31);
    assert.equal(store.state.cash - position.startingCash, tradePnl);
    assert.equal(position.lastDeployed, 2);
    assert.deepEqual(position.holdings, [5, 0]);
    assert.equal(new Store(settings, 'pilot', 'late-entry').state.position.startingCash, 31);
});

test('a failed save restores cash, risk marks, ledger absence and the same open position', t => {
    const { store } = fixture(t);
    const position = { startingCash: 26, holdings: [5, 0], orders: [] };
    store.state.position = position;
    const before = structuredClone(store.state);
    store.save = () => { throw new Error('disk_full'); };
    assert.throws(() => applyConfirmedCapitalDeposits(store, review()), /disk_full/);
    assert.deepEqual(store.state, before);
    assert.equal(store.state.position, position);
    assert.equal(Object.hasOwn(store.state, 'capitalFunding'), false);
    assert.equal(position.startingCash, 26);
});

test('a failed later save restores the previously persisted ledger object', t => {
    const { store } = fixture(t);
    applyConfirmedCapitalDeposits(store, review());
    const ledger = store.state.capitalFunding, before = structuredClone(store.state);
    store.save = () => { throw new Error('disk_full'); };
    assert.throws(() => applyConfirmedCapitalDeposits(store, review([transfer(2)], 29, 34)), /disk_full/);
    assert.deepEqual(store.state, before);
    assert.equal(store.state.capitalFunding, ledger);
});

test('checkpoint advancement persists without manufacturing deposits or risk marks', t => {
    const { store, settings } = fixture(t);
    delete store.state.lastEquity;
    const before = structuredClone(store.state);
    const result = applyConfirmedCapitalDeposits(store, review([], 24, 24));
    assert.equal(result.amount, 0);
    assert.equal(result.checkpointChanged, true);
    assert.equal(totalCapitalDeposited(store.state), 0);
    assert.equal(Object.hasOwn(store.state, 'lastEquity'), false);
    assert.equal(store.state.cash, before.cash);
    assert.equal(store.state.peakEquity, before.peakEquity);
    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state.capitalFunding.checkpoint,
        { blockNumber: 200, blockHash: hash(200) });
});

test('missing risk marks stay missing when actual deposits are booked', t => {
    const { store } = fixture(t);
    delete store.state.lastEquity;
    applyConfirmedCapitalDeposits(store, review());
    assert.equal(Object.hasOwn(store.state, 'lastEquity'), false);
});

test('balance-only changes, wrong deltas and duplicate batch IDs fail before state mutation', t => {
    const { store } = fixture(t), before = structuredClone(store.state);
    for (const value of [review([], 24, 29), review([transfer()], 24, 30),
        review([transfer()], 24, 23), review([transfer(), transfer()], 24, 34)]) {
        assert.throws(() => applyConfirmedCapitalDeposits(store, value),
            /capital_funding_balance_mismatch|duplicate_capital_funding_receipt/);
        assert.deepEqual(store.state, before);
        assert.equal(fs.existsSync(store.filename), false);
    }
});

test('changed replay evidence and conflicting blocks fail closed', t => {
    const { store } = fixture(t);
    applyConfirmedCapitalDeposits(store, review());
    const before = structuredClone(store.state);
    for (const changed of [transfer(1, 6), transfer(1, 5, { from: recipient }),
        transfer(1, 5, { blockHash: hash(300) }), transfer(1, 5, { blockNumber: 102 }),
        transfer(2, 5, { blockNumber: 101, blockHash: hash(999) })]) {
        assert.throws(() => applyConfirmedCapitalDeposits(store, review([changed], 29, 29)), /conflicting_capital_funding_receipt/);
        assert.deepEqual(store.state, before);
    }
});

test('checkpoint regression, reorgs and future receipts fail closed', t => {
    const { store } = fixture(t);
    applyConfirmedCapitalDeposits(store, review());
    const before = structuredClone(store.state);
    for (const value of [review([], 29, 29, { checkpoint: { blockNumber: 199, blockHash: hash(199) } }),
        review([], 29, 29, { checkpoint: { blockNumber: 200, blockHash: hash(999) } }),
        review([transfer(2, 5, { blockNumber: 201, blockHash: hash(201) })], 29, 34),
        review([transfer(2, 5, { blockNumber: 200, blockHash: hash(999) })], 29, 34)]) {
        assert.throws(() => applyConfirmedCapitalDeposits(store, value), /capital_funding_checkpoint/);
        assert.deepEqual(store.state, before);
    }
});

test('malformed receipts and identity switches cannot credit capital', t => {
    const { store } = fixture(t), before = structuredClone(store.state);
    for (const value of [null, [], { ...transfer(), txHash: {} }, { ...transfer(), logIndex: -1 },
        { ...transfer(), logIndex: 1.5 }, { ...transfer(), from: walletAddress },
        { ...transfer(), from: Symbol('bad') }, { ...transfer(), amount: 0 },
        { ...transfer(), amount: -5 }, { ...transfer(), amount: '5.0000001' },
        { ...transfer(), amount: NaN }, { ...transfer(), blockHash: null },
        Object.create(transfer())]) {
        assert.throws(() => applyConfirmedCapitalDeposits(store, review([value])), /invalid_capital_funding_/);
        assert.deepEqual(store.state, before);
    }
    applyConfirmedCapitalDeposits(store, review());
    for (const changed of [{ chainId: 1 }, { tokenAddress: recipient }, { walletAddress: recipient }]) {
        assert.throws(() => applyConfirmedCapitalDeposits(store, review([], 29, 29, changed)),
            /invalid_capital_funding_identity|capital_funding_identity_mismatch/);
    }
});

test('corrupt totals, receipt IDs and ledger structures never become zero funding', t => {
    const { store } = fixture(t);
    assert.equal(capitalFundingLedger(store.state), null);
    assert.equal(totalCapitalDeposited(store.state), 0);
    applyConfirmedCapitalDeposits(store, review());
    const pristine = structuredClone(store.state);
    for (const mutate of [
        state => { state.capitalFunding.totalDeposited = 4.999999; },
        state => { state.capitalFunding.totalDeposited = 5.0000001; },
        state => { state.capitalFunding.schema = 2; },
        state => { state.capitalFunding.entries = []; },
        state => { state.capitalFunding.entries = Object.create({ hidden: transfer() }); },
        state => { state.capitalFunding.entries = JSON.parse('{"__proto__":{}}'); },
        state => { state.capitalFunding.entries.bad = transfer(); },
        state => { state.capitalFunding.entries[Object.keys(state.capitalFunding.entries)[0]].amount = 6; },
        state => { state.capitalFunding.checkpoint = null; },
        state => { state.capitalFunding = false; },
    ]) {
        const state = structuredClone(pristine);
        mutate(state);
        assert.throws(() => capitalFundingLedger(state), /invalid_capital_funding_/);
        assert.throws(() => totalCapitalDeposited(state), /invalid_capital_funding_/);
    }
    const view = capitalFundingLedger(store.state);
    Object.values(view.entries)[0].amount = 999;
    assert.equal(totalCapitalDeposited(store.state), 5);
});
