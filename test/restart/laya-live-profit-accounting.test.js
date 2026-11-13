import test from 'node:test';
import assert from 'node:assert/strict';
import { riskReason } from '../../src/restart/math.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { profitTakingLedger, distributionAdjustedCash, profitTakingBudget,
    reserveProfitWithdrawal, applyProfitWithdrawal, applyProfitWithdrawalSource,
    applyProfitWithdrawalDestination } from '../../src/laya-live/profit-accounting.js';

const recipient = `0x${'a'.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const policy = { recipient, asset: 'pUSD', chunkUsd: 5, retainUsd: 20 };
const context = { openOrders: [], gasReserveUsd: .01, feeReserveUsd: 0, walletBalance: 100 };
const row = pnl => ({ traded: true, pnl, fees: .02, gas: .001, uncertain: false });
const balancePolicy = { recipient, asset: 'USDC', chunkUsd: 5, retainUsd: 10,
    trigger: 'wallet_balance', thresholdUsd: 15 };

function fixture(pnls = [5.02]) {
    const cash = Math.round((20 + pnls.reduce((sum, value) => sum + value, 0)) * 1e6) / 1e6;
    return { baseline: 'aabbccddeeff0011', startedAt: 1000, mode: 'pilot', cash,
        liveFunding: { initialCapital: 20 }, walletStart: 20, walletCashDelta: cash - 20,
        position: null, completed: pnls.map(row), stopped: null, peakEquity: cash,
        maxDrawdown: 0, lastEquity: cash, failures: 0 };
}

function reserve(state = fixture(), request = {}, selectedPolicy = policy) {
    return reserveProfitWithdrawal(state, selectedPolicy,
        { ...context, id: 'withdrawal:1', hash: hash('1'), createdAt: 2000, ...request });
}

function evidence(overrides = {}) {
    return { id: 'withdrawal:1', hash: hash('1'), recipient, asset: 'pUSD', amountUsd: 5,
        status: 'confirmed', tokenDebitUsd: 5, gasUsd: .006, feeUsd: 0,
        blockNumber: 123, blockHash: hash('b'), ...overrides };
}

test('balance trigger admits exactly 15 pUSD despite past losses and reserves without calling deposits profit', () => {
    const state = fixture([-10]);
    state.externalWalletActivity = { cashDelta: 5, receipts: [{ hash: hash('9'), cash: 5 }], capitalAllocated: 0 };
    const before = structuredClone(state), actual = expectedWalletBalance(state);
    assert.equal(actual, 15);
    const budget = profitTakingBudget(state, balancePolicy, { ...context, walletBalance: actual,
        gasReserveUsd: .15, feeReserveUsd: .05 });
    assert.equal(budget.eligible, true);
    assert.equal(budget.workingCapitalAfter, 10);
    assert.equal(budget.walletCash, 15);
    assert.equal(budget.walletBalanceVerified, true);
    assert.equal(budget.realizedProfitUsd, -10);
    assert.equal(budget.cashBasis, 'verified_wallet');
    assert.deepEqual(state, before);
    assert.equal(profitTakingBudget(state, balancePolicy, { ...context, walletBalance: 14.999999 }).eligible, false);
    assert.equal(profitTakingBudget(fixture([100]), balancePolicy, { ...context, walletBalance: 14.999999 }).eligible, false);
});

test('balance estimates allow preliminary checks but cannot reserve a withdrawal without a fresh wallet read', () => {
    const state = fixture([-5]);
    const estimate = { openOrders: [], gasReserveUsd: .15, feeReserveUsd: .05, expectedWalletBalance: 15 };
    const budget = profitTakingBudget(state, balancePolicy, estimate);
    assert.equal(budget.eligible, true);
    assert.equal(budget.walletBalanceVerified, false);
    assert.equal(budget.cashBasis, 'expected_wallet');
    assert.throws(() => reserveProfitWithdrawal(state, balancePolicy,
        { ...estimate, id: 'withdrawal:1', hash: hash('1'), createdAt: 2000 }), /profit_taking_wallet_unverified/);
    assert.ok(profitTakingBudget(state, balancePolicy, { openOrders: [] }).reasons.includes('profit_taking_wallet_unverified'));
    assert.throws(() => profitTakingBudget(state, balancePolicy, { ...context, walletBalance: null }), /invalid_profit_accounting_amount/);
    for (const change of [{ thresholdUsd: 14 }, { retainUsd: 9 }, { chunkUsd: 6 }, { asset: 'pUSD' }, { trigger: 'all_cash' }])
        assert.throws(() => profitTakingBudget(state, { ...balancePolicy, ...change }, context), /invalid_profit_taking_policy/);
});

test('unallocated manual cash cannot fund a withdrawal that would make bot capital negative', () => {
    const state = fixture([-18]);
    state.externalWalletActivity = { cashDelta: 13, receipts: [{ hash: hash('9'), cash: 13 }], capitalAllocated: 0 };
    const budget = profitTakingBudget(state, balancePolicy, { ...context, walletBalance: 15,
        gasReserveUsd: .15, feeReserveUsd: .05 });
    assert.equal(budget.eligible, false);
    assert.equal(budget.workingCapitalAfter, 10);
    assert.equal(budget.botCashAfter, -3.15);
    assert.deepEqual(budget.reasons, ['profit_taking_bot_cash_unallocated']);
    assert.throws(() => reserve(state, { walletBalance: 15, gasReserveUsd: .15, feeReserveUsd: .05 }, balancePolicy),
        /profit_taking_bot_cash_unallocated/);
    const edge = fixture([-14.85]);
    assert.equal(profitTakingBudget(edge, balancePolicy, { ...context, walletBalance: 15,
        gasReserveUsd: .15, feeReserveUsd: .05 }).eligible, true, 'Bridge fee is already included in gross five');
    edge.cash = 5.149999;
    assert.equal(profitTakingBudget(edge, balancePolicy, { ...context, walletBalance: 15,
        gasReserveUsd: .15, feeReserveUsd: .05 }).eligible, false);
});

test('balance withdrawal preserves ten pUSD after source debit and records net USDC, gas, and fees once across restart', () => {
    const state = fixture([-5]), history = structuredClone(state.completed);
    const pending = reserve(state, { walletBalance: 15, gasReserveUsd: .15, feeReserveUsd: .05 }, balancePolicy);
    assert.deepEqual(pending.profitTaking.policy, balancePolicy);
    const proof = evidence({ asset: 'USDC', gasUsd: .006 });
    const source = applyProfitWithdrawalSource(JSON.parse(JSON.stringify(pending)), proof);
    assert.equal(expectedWalletBalance(source), 10);
    assert.equal(source.profitTaking.totalTokenDebited, 5);
    assert.equal(source.profitTaking.withdrawalGasUsd, .006);
    assert.ok(profitTakingBudget(source, balancePolicy, { ...context, walletBalance: 10 }).reasons.includes('profit_taking_pending'));
    assert.deepEqual(applyProfitWithdrawalSource(source, proof), source);
    const delivery = { id: 'withdrawal:1', sourceHash: hash('1'), hash: hash('2'), recipient, asset: 'USDC',
        receivedUsd: 4.99, status: 'confirmed', blockNumber: 124, blockHash: hash('c') };
    const done = applyProfitWithdrawalDestination(JSON.parse(JSON.stringify(source)), delivery);
    assert.equal(expectedWalletBalance(done), 10);
    assert.equal(done.profitTaking.totalTransferred, 4.99);
    assert.equal(done.profitTaking.withdrawalFeesUsd, .01);
    assert.equal(done.profitTaking.withdrawalGasUsd, .006);
    assert.equal(done.cash, 14.984);
    assert.deepEqual(done.completed, history);
    assert.deepEqual(applyProfitWithdrawalDestination(done, delivery), done);
    assert.equal(profitTakingBudget(done, balancePolicy, { ...context, walletBalance: 10 }).eligible, false);
    assert.throws(() => reserve(done, { id: 'withdrawal:2', hash: hash('3'), walletBalance: 10 }, balancePolicy),
        /profit_taking_wallet_cash/);
    assert.equal(profitTakingBudget(done, balancePolicy, { ...context, walletBalance: 15 }).eligible, true);
});

test('balance trigger retains open inventory, order, uncertain-history and stop protections', () => {
    for (const change of [{ position: { holdings: [5, 0] } }, { stopped: { reason: 'manual' } },
        { completed: [{ ...row(-5), uncertain: true }] }])
        assert.equal(profitTakingBudget({ ...fixture([-5]), ...change }, balancePolicy,
            { ...context, walletBalance: 15 }).eligible, false);
    assert.equal(profitTakingBudget(fixture([-5]), balancePolicy,
        { ...context, walletBalance: 15, openOrders: [{ status: 'open' }] }).eligible, false);
});

test('only completed net trading profit funds a chunk, excluding manual deposits and marked inventory', () => {
    const state = fixture([-2, 3]);
    state.externalWalletActivity = { cashDelta: 50, receipts: [{ hash: hash('9'), cash: 50 }], capitalAllocated: 0 };
    assert.equal(profitTakingBudget(state, policy, context).eligible, false);
    assert.equal(profitTakingBudget(state, policy, context).realizedProfitUsd, 1);
    state.cash += 50; // Even an incorrectly allocated deposit cannot create closed trading profit.
    assert.equal(profitTakingBudget(state, policy, context).realizedProfitUsd, 1);
    state.completed.push(row(5)); state.cash -= 50; state.cash += 5;
    state.position = { holdings: [100, 0], orders: [] };
    assert.ok(profitTakingBudget(state, policy, context).reasons.includes('profit_taking_inventory'));
    const noFill = fixture([10, -1]); noFill.completed[0].traded = false;
    assert.equal(profitTakingBudget(noFill, policy, context).realizedProfitUsd, -1);
});

test('all closed losses, fees and trading gas carry forward without resetting at each winning market', () => {
    const state = fixture([-6, 10.99]);
    const before = structuredClone(state), budget = profitTakingBudget(state, policy, context);
    assert.equal(budget.realizedProfitUsd, 4.99);
    assert.equal(budget.eligible, false);
    assert.deepEqual(state, before);
    state.completed.push(row(.02)); state.cash = 25.01;
    assert.equal(profitTakingBudget(state, policy, context).eligible, true);
});

test('six-decimal thresholds never round a fractional micro-dollar up into a payout', () => {
    assert.equal(profitTakingBudget(fixture([5.009999]), policy, context).eligible, false);
    assert.equal(profitTakingBudget(fixture([5.01]), policy, context).eligible, true);
    assert.throws(() => profitTakingBudget(fixture([5.0100001]), policy, context), /invalid_profit_accounting_amount/);
    assert.throws(() => profitTakingBudget(fixture(), policy, { ...context, gasReserveUsd: -.01 }), /invalid_profit_accounting_amount/);
    assert.throws(() => profitTakingBudget(fixture(), policy, { ...context, feeReserveUsd: Infinity }), /invalid_profit_accounting_amount/);
    assert.equal(profitTakingBudget(fixture([.1, .2, 4.71]), policy, context).eligible, true);
});

test('retain policy, trading cash shortfalls and fee reserve constrain the same withdrawal', () => {
    const state = fixture([6]); state.cash = 24.99;
    const budget = profitTakingBudget(state, policy, context);
    assert.equal(budget.realizedProfitUsd, 4.99);
    assert.ok(budget.reasons.includes('profit_taking_working_capital'));
    assert.equal(profitTakingBudget(fixture([5.01]), policy, { ...context, feeReserveUsd: .000001 }).eligible, false);
    assert.equal(profitTakingBudget(fixture([6]), { ...policy, retainUsd: 22 }, context).eligible, false);
    assert.throws(() => profitTakingBudget(fixture([6]), { ...policy, retainUsd: 19.99 }, context), /invalid_profit_taking_policy/);
    assert.throws(() => profitTakingBudget(fixture([6]), { ...policy, chunkUsd: 6 }, context), /invalid_profit_taking_policy/);
});

test('an explicit flat account and no venue open orders are required', () => {
    assert.ok(profitTakingBudget(fixture(), policy).reasons.includes('profit_taking_open_orders_unverified'));
    for (const order of [{ status: 'open' }, { status: 'unknown' }, { status: 'matched' }]) {
        assert.ok(profitTakingBudget(fixture(), policy, { ...context, openOrders: [order] })
            .reasons.includes('profit_taking_open_orders'));
    }
    for (const change of [{ stopped: { reason: 'drawdown_limit' } }, { position: { holdings: [0, 0], orders: [] } },
        { completed: [{ ...row(5.02), uncertain: true }] }]) {
        assert.equal(profitTakingBudget({ ...fixture(), ...change }, policy, context).eligible, false);
    }
    assert.ok(profitTakingBudget(fixture(), policy, { ...context, walletBalance: 4.999999 })
        .reasons.includes('profit_taking_wallet_cash'));
    assert.ok(profitTakingBudget(fixture(), policy, { ...context, walletBalance: 24.999999 })
        .reasons.includes('profit_taking_wallet_cash'));
});

test('reservation is immutable and survives restart, reserving funds until the exact hash is reconciled', () => {
    const state = fixture([11]), before = structuredClone(state), pending = reserve(state);
    assert.deepEqual(state, before);
    assert.equal(pending.cash, 31);
    assert.equal(distributionAdjustedCash(pending), 25.99);
    assert.equal(distributionAdjustedCash(pending, { reservePending: false }), 31);
    const restarted = JSON.parse(JSON.stringify(pending));
    assert.ok(profitTakingBudget(restarted, policy, context).reasons.includes('profit_taking_pending'));
    assert.throws(() => reserve(restarted, { id: 'withdrawal:2', hash: hash('2') }), /profit_taking_pending/);
    assert.equal(profitTakingLedger(restarted).pending.hash, hash('1'));
    assert.throws(() => applyProfitWithdrawal(restarted, evidence({ hash: hash('2') })), /receipt_mismatch/);
    assert.deepEqual(restarted, pending);
    assert.throws(() => reserveProfitWithdrawal(state, policy,
        { id: 'withdrawal:1', hash: hash('1'), createdAt: 2000, openOrders: [] }), /cost_reserve_required/);
});

test('confirmed principal is distributed once; actual fees and native gas reduce trading cash once', () => {
    const state = fixture([6]), pending = reserve(state, { feeReserveUsd: .03 }), before = structuredClone(pending);
    const next = applyProfitWithdrawal(pending, evidence({ tokenDebitUsd: 5.02, feeUsd: .02 }));
    assert.deepEqual(pending, before);
    assert.equal(next.cash, 25.974);
    assert.equal(next.profitTaking.totalTransferred, 5);
    assert.equal(next.profitTaking.totalTokenDebited, 5.02);
    assert.equal(next.profitTaking.withdrawalGasUsd, .006);
    assert.equal(next.profitTaking.withdrawalFeesUsd, .02);
    assert.equal(next.profitTaking.pending, null);
    assert.equal(distributionAdjustedCash(next), 20.974);
    assert.equal(profitTakingBudget(next, policy, context).availableProfitUsd, .964);
    assert.equal(next.walletCashDelta, state.walletCashDelta);
    assert.deepEqual(next.completed, state.completed);
});

test('idempotence uses case-insensitive transaction identity and rejects contradictory duplicate receipts', () => {
    const booked = applyProfitWithdrawal(reserve(), evidence());
    const restarted = JSON.parse(JSON.stringify(booked));
    assert.deepEqual(applyProfitWithdrawal(restarted, evidence({ hash: hash('1').toUpperCase().replace('0X', '0x'),
        blockHash: hash('b').toUpperCase().replace('0X', '0x'), recipient: recipient.toUpperCase().replace('0X', '0x') })), booked);
    for (const change of [{ gasUsd: .007 }, { blockHash: hash('c') }, { blockNumber: 124 }, { id: 'different' },
        { status: 'failed', tokenDebitUsd: 0 }, { tokenDebitUsd: 5.01, feeUsd: .01 }]) {
        assert.throws(() => applyProfitWithdrawal(restarted, evidence(change)), /receipt_mismatch/);
    }
});

test('verified failed transactions charge only actual gas and cannot double charge on restart', () => {
    const proof = evidence({ status: 'failed', tokenDebitUsd: 0, gasUsd: .008 });
    const next = applyProfitWithdrawal(reserve(), proof);
    assert.equal(next.cash, 25.012);
    assert.equal(distributionAdjustedCash(next), 25.012);
    assert.equal(next.profitTaking.totalTransferred, 0);
    assert.equal(next.profitTaking.totalTokenDebited, 0);
    assert.equal(next.profitTaking.withdrawals[0].transferredUsd, 0);
    assert.deepEqual(applyProfitWithdrawal(JSON.parse(JSON.stringify(next)), proof), next);
    assert.equal(profitTakingBudget(next, policy, context).availableProfitUsd, 5.002);
    const retry = reserve(next, { id: 'withdrawal:2', hash: hash('2') });
    assert.equal(retry.profitTaking.withdrawals.length, 1);
});

test('losses after a payout must be recovered before another chunk can be distributed', () => {
    let state = applyProfitWithdrawal(reserve(fixture([5.02])), evidence());
    assert.equal(profitTakingBudget(state, policy, context).eligible, false);
    state.completed.push(row(-4), row(8)); state.cash = 29.014;
    assert.equal(profitTakingBudget(state, policy, context).availableProfitUsd, 4.004);
    assert.equal(profitTakingBudget(state, policy, context).eligible, false);
    state.completed.push(row(.996)); state.cash = 30.01;
    assert.equal(profitTakingBudget(state, policy, context).eligible, true);
    state = applyProfitWithdrawal(reserve(state, { id: 'withdrawal:2', hash: hash('2') }),
        evidence({ id: 'withdrawal:2', hash: hash('2'), blockNumber: 124 }));
    assert.equal(state.profitTaking.totalTransferred, 10);
    assert.equal(distributionAdjustedCash(state), 20.004);
});

test('distributions preserve historical equity and drawdown; actual withdrawal gas remains a real cost', () => {
    const state = fixture([6]); state.peakEquity = 28; state.maxDrawdown = 2;
    const next = applyProfitWithdrawal(reserve(state), evidence({ gasUsd: 0 }));
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'lastEquity', 'startedAt', 'walletStart', 'walletCashDelta'])
        assert.equal(next[key], state[key]);
    const settings = { drawdownStop: 3, pilotMarkets: 100, pilotHours: 100 };
    assert.equal(riskReason(next, settings, 2000, next.cash), null);
    assert.equal(next.maxDrawdown, 2);
    const withGas = applyProfitWithdrawal(reserve(state), evidence({ gasUsd: .006 }));
    assert.equal(riskReason(withGas, settings, 2000, withGas.cash), null);
    assert.ok(Math.abs(withGas.maxDrawdown - 2.006) < 1e-9);
});

test('period, policy and completed history cannot be reset to resurrect distributed profit', () => {
    const booked = applyProfitWithdrawal(reserve(), evidence());
    for (const change of [{ startedAt: 2000 }, { baseline: 'replacement' }, { liveFunding: { initialCapital: 10 } }])
        assert.throws(() => profitTakingLedger({ ...booked, ...change }), /period_mismatch/);
    assert.throws(() => profitTakingBudget(booked, { ...policy, asset: 'USDC' }, context), /policy_mismatch/);
    for (const completed of [[], [{ ...booked.completed[0], pnl: 10 }]])
        assert.throws(() => profitTakingLedger({ ...booked, completed }), /invalid_profit_taking_ledger/);
    const appended = structuredClone(booked); appended.completed.push(row(-1)); appended.cash -= 1;
    assert.equal(profitTakingBudget(appended, policy, context).realizedProfitUsd, 4.014);
});

test('corrupt totals, duplicate hashes and malformed pending reservations fail closed', () => {
    const booked = applyProfitWithdrawal(reserve(), evidence());
    for (const field of ['totalTransferred', 'totalTokenDebited', 'withdrawalGasUsd', 'withdrawalFeesUsd']) {
        const corrupt = structuredClone(booked); corrupt.profitTaking[field] += .000001;
        assert.throws(() => profitTakingLedger(corrupt), /invalid_profit_taking_ledger/);
    }
    const duplicate = structuredClone(booked); duplicate.profitTaking.withdrawals.push(duplicate.profitTaking.withdrawals[0]);
    assert.throws(() => distributionAdjustedCash(duplicate), /invalid_profit_taking_ledger/);
    for (const change of [{ amountUsd: 4 }, { gasReserveUsd: -1 }, { feeReserveUsd: NaN }, { hash: 'unknown' },
        { id: '' }, { createdAt: -1 }]) {
        const corrupt = reserve(); Object.assign(corrupt.profitTaking.pending, change);
        assert.throws(() => profitTakingBudget(corrupt, policy, context), /invalid_profit/);
    }
});

test('malformed or unrelated receipt evidence cannot change any accounting', () => {
    const pending = reserve(), before = structuredClone(pending);
    for (const change of [{ recipient: `0x${'d'.repeat(40)}` }, { amountUsd: 4.999999 }, { asset: 'USDC' },
        { tokenDebitUsd: 5.01 }, { feeUsd: -.01 }, { gasUsd: NaN }, { blockNumber: 1.1 },
        { blockHash: 'missing' }, { status: 'pending' }, { status: 'failed', tokenDebitUsd: 5 }]) {
        assert.throws(() => applyProfitWithdrawal(pending, evidence(change)), /invalid_profit/);
        assert.deepEqual(pending, before);
    }
    assert.throws(() => applyProfitWithdrawal(fixture(), evidence()), /reservation_required/);
});

const bridgePolicy = { ...policy, asset: 'USDC' };
const sourceProof = change => evidence({ asset: 'USDC', ...change });
const destinationProof = change => ({ id: 'withdrawal:1', sourceHash: hash('1'), hash: hash('2'),
    recipient, asset: 'USDC', receivedUsd: 4.999960, blockNumber: 125, blockHash: hash('c'), ...change });
const bridgeReserve = (state = fixture([6]), request = {}) => reserve(state, request, bridgePolicy);

test('Bridge source proof books gross debit and gas once while retaining the unresolved destination', () => {
    const metadata = { withdrawalId: 'official-bridge-request', depositAddress: `0x${'e'.repeat(40)}` };
    const reserved = bridgeReserve(fixture([6]), { bridge: metadata, feeReserveUsd: .00004 });
    metadata.withdrawalId = 'changed outside ledger';
    assert.equal(reserved.profitTaking.pending.bridge.withdrawalId, 'official-bridge-request');
    const before = structuredClone(reserved), source = applyProfitWithdrawalSource(reserved, sourceProof());
    assert.deepEqual(reserved, before);
    assert.equal(source.cash, 25.994);
    assert.equal(source.profitTaking.totalTransferred, 0);
    assert.equal(source.profitTaking.totalTokenDebited, 5);
    assert.equal(source.profitTaking.withdrawalGasUsd, .006);
    assert.equal(source.profitTaking.withdrawalFeesUsd, 0);
    assert.equal(source.profitTaking.withdrawals.length, 0);
    assert.equal(source.profitTaking.pending.stage, 'in_transit');
    assert.equal(source.profitTaking.pending.provisionalPrincipalUsd, 5);
    assert.equal(source.profitTaking.pending.bridge.withdrawalId, 'official-bridge-request');
    // Gas and withheld destination fees are not reserved again after the debit.
    assert.equal(distributionAdjustedCash(source), 20.994);
    assert.equal(distributionAdjustedCash(source, { reservePending: false }), 20.994);
    assert.equal(profitTakingBudget(source, bridgePolicy, context).provisionalTransferredUsd, 5);
    assert.deepEqual(applyProfitWithdrawalSource(JSON.parse(JSON.stringify(source)), sourceProof()), source);
    assert.throws(() => applyProfitWithdrawal(source, sourceProof()), /source_already_accounted/);
});

test('Bridge final delivery recognizes net USDC and withheld fee without changing spendable cash', () => {
    const source = applyProfitWithdrawalSource(bridgeReserve(), sourceProof());
    const before = structuredClone(source), destination = applyProfitWithdrawalDestination(source, destinationProof());
    assert.deepEqual(source, before);
    assert.equal(destination.cash, 25.993960);
    assert.equal(destination.profitTaking.totalTransferred, 4.999960);
    assert.equal(destination.profitTaking.totalTokenDebited, 5);
    assert.equal(destination.profitTaking.withdrawalFeesUsd, .000040);
    assert.equal(destination.profitTaking.withdrawalGasUsd, .006);
    assert.equal(destination.profitTaking.pending, null);
    assert.equal(destination.profitTaking.withdrawals[0].kind, 'bridge');
    assert.equal(destination.profitTaking.withdrawals[0].sourceReceipt.hash, hash('1'));
    assert.equal(destination.profitTaking.withdrawals[0].destinationReceipt.hash, hash('2'));
    assert.equal(distributionAdjustedCash(destination), distributionAdjustedCash(source));
    assert.equal(profitTakingBudget(destination, bridgePolicy, context).availableProfitUsd,
        profitTakingBudget(source, bridgePolicy, context).availableProfitUsd);
    assert.equal(profitTakingBudget(destination, bridgePolicy, context).realizedProfitUsd, 5.993960);
    for (const key of ['walletCashDelta', 'walletStart', 'completed', 'peakEquity', 'maxDrawdown', 'startedAt'])
        assert.deepEqual(destination[key], source[key]);
});

test('Bridge source and destination proofs remain idempotent across both restart boundaries', () => {
    let source = applyProfitWithdrawalSource(bridgeReserve(), sourceProof());
    source = JSON.parse(JSON.stringify(source));
    assert.deepEqual(applyProfitWithdrawalSource(source, sourceProof()), source);
    const destination = applyProfitWithdrawalDestination(source, destinationProof());
    const restarted = JSON.parse(JSON.stringify(destination));
    assert.deepEqual(applyProfitWithdrawalDestination(restarted, destinationProof()), restarted);
    assert.deepEqual(applyProfitWithdrawalSource(restarted, sourceProof()), restarted);
    assert.deepEqual(applyProfitWithdrawalDestination(restarted, destinationProof({ receivedUsd: '4.999960',
        recipient: recipient.toUpperCase().replace('0X', '0x'), blockHash: hash('c').toUpperCase().replace('0X', '0x') })), restarted);
    for (const change of [{ gasUsd: .007 }, { blockNumber: 124 }, { blockHash: hash('a') }])
        assert.throws(() => applyProfitWithdrawalSource(restarted, sourceProof(change)), /receipt_mismatch/);
    for (const change of [{ receivedUsd: 5 }, { blockNumber: 126 }, { blockHash: hash('a') }, { hash: hash('3') }])
        assert.throws(() => applyProfitWithdrawalDestination(restarted, destinationProof(change)), /receipt_mismatch/);
});

test('unresolved or failed Bridge delivery never finalizes or authorizes source resubmission', () => {
    const source = applyProfitWithdrawalSource(bridgeReserve(fixture([11])), sourceProof());
    source.profitTaking.pending.bridge = { status: 'failed' };
    const restarted = JSON.parse(JSON.stringify(source)), before = structuredClone(restarted);
    assert.throws(() => applyProfitWithdrawalDestination(restarted, destinationProof({ status: 'failed' })), /invalid_profit_withdrawal_destination/);
    assert.throws(() => applyProfitWithdrawalDestination(restarted, destinationProof({ receivedUsd: 0 })), /invalid_profit_withdrawal_destination/);
    assert.throws(() => reserve(restarted, { id: 'withdrawal:2', hash: hash('2') }, bridgePolicy), /profit_taking_pending/);
    assert.throws(() => applyProfitWithdrawal(restarted, sourceProof({ status: 'failed', tokenDebitUsd: 0 })), /source_already_accounted/);
    assert.deepEqual(restarted, before);
    assert.equal(restarted.profitTaking.totalTokenDebited, 5);
    assert.equal(restarted.profitTaking.totalTransferred, 0);
    assert.equal(restarted.profitTaking.withdrawals.length, 0);
});

test('only matched positive, six-decimal destination receipts can settle Bridge transit', () => {
    const source = applyProfitWithdrawalSource(bridgeReserve(), sourceProof()), before = structuredClone(source);
    for (const change of [{ id: 'wrong' }, { sourceHash: hash('3') }, { hash: hash('1') },
        { recipient: `0x${'e'.repeat(40)}` }, { asset: 'pUSD' }, { receivedUsd: '9007199254.740992' },
        { receivedUsd: 4.9999601 }, { receivedUsd: -1 }, { blockNumber: NaN }, { blockHash: 'unknown' }]) {
        assert.throws(() => applyProfitWithdrawalDestination(source, destinationProof(change)), /invalid_profit/);
        assert.deepEqual(source, before);
    }
    assert.throws(() => applyProfitWithdrawalDestination(bridgeReserve(), destinationProof()), /source_required/);
    assert.throws(() => applyProfitWithdrawalSource(reserve(), evidence()), /invalid_profit_withdrawal_source/);
    const noFee = applyProfitWithdrawalDestination(source, destinationProof({ receivedUsd: 5 }));
    assert.equal(noFee.profitTaking.withdrawalFeesUsd, 0);
    assert.equal(noFee.profitTaking.totalTransferred, 5);
});

test('favorable conversion books actual receipt and separate gain once without inflating trading profit or spendable cash', () => {
    const initial = fixture([11]);
    const source = applyProfitWithdrawalSource(bridgeReserve(initial), sourceProof());
    const beforeBudget = profitTakingBudget(source, bridgePolicy, context);
    const received = destinationProof({ receivedUsd: 5.000121 });
    const done = applyProfitWithdrawalDestination(JSON.parse(JSON.stringify(source)), received);
    assert.equal(done.profitTaking.totalTokenDebited, 5);
    assert.equal(done.profitTaking.totalTransferred, 5.000121);
    assert.equal(done.profitTaking.withdrawalFeesUsd, 0);
    assert.equal(done.profitTaking.withdrawalConversionGainUsd, .000121);
    assert.equal(done.profitTaking.withdrawals[0].conversionGainUsd, .000121);
    assert.equal(done.cash, 30.994121);
    assert.equal(expectedWalletBalance(done), expectedWalletBalance(source));
    assert.equal(distributionAdjustedCash(done), distributionAdjustedCash(source));
    assert.equal(profitTakingBudget(done, bridgePolicy, context).realizedProfitUsd, beforeBudget.realizedProfitUsd);
    assert.equal(profitTakingBudget(done, bridgePolicy, context).availableProfitUsd, beforeBudget.availableProfitUsd);
    assert.deepEqual(done.completed, initial.completed);
    const restarted = JSON.parse(JSON.stringify(done));
    assert.deepEqual(applyProfitWithdrawalDestination(restarted, received), done);
    assert.deepEqual(applyProfitWithdrawalSource(restarted, sourceProof()), done);
    for (const mutate of [s => { s.profitTaking.withdrawalConversionGainUsd = .000122; },
        s => { delete s.profitTaking.withdrawalConversionGainUsd; },
        s => { delete s.profitTaking.withdrawals[0].conversionGainUsd; },
        s => { s.profitTaking.withdrawals[0].conversionGainUsd = .000122; },
        s => { s.profitTaking.withdrawals[0].feeUsd = -.000121; }]) {
        const altered = structuredClone(done); mutate(altered);
        assert.throws(() => profitTakingLedger(altered), /invalid_profit/);
    }
});

test('fee-only legacy receipts retain their original optional-field shape', () => {
    const source = applyProfitWithdrawalSource(bridgeReserve(), sourceProof());
    const done = applyProfitWithdrawalDestination(source, destinationProof());
    assert.equal(Object.hasOwn(done.profitTaking, 'withdrawalConversionGainUsd'), false);
    assert.equal(Object.hasOwn(done.profitTaking.withdrawals[0], 'conversionGainUsd'), false);
    assert.deepEqual(profitTakingLedger(done), done.profitTaking);
});

test('Bridge transit and delivered ledger totals are validated against both exact proofs', () => {
    const source = applyProfitWithdrawalSource(bridgeReserve(), sourceProof());
    for (const change of [{ stage: 'reserved' }, { stage: 'unknown' }, { provisionalPrincipalUsd: 4.999960 },
        { sourceReceipt: sourceProof({ gasUsd: .007 }) }]) {
        const corrupt = structuredClone(source); Object.assign(corrupt.profitTaking.pending, change);
        assert.throws(() => profitTakingLedger(corrupt), /invalid_profit/);
    }
    for (const change of [{ totalTokenDebited: 0 }, { withdrawalGasUsd: 0 }, { totalTransferred: 5 }]) {
        const corrupt = structuredClone(source); Object.assign(corrupt.profitTaking, change);
        assert.throws(() => profitTakingLedger(corrupt), /invalid_profit/);
    }
    const delivered = applyProfitWithdrawalDestination(source, destinationProof());
    for (const change of [{ transferredUsd: 5 }, { feeUsd: 0 }, { gasUsd: .007 }, { hash: hash('3') }]) {
        const corrupt = structuredClone(delivered); Object.assign(corrupt.profitTaking.withdrawals[0], change);
        assert.throws(() => profitTakingLedger(corrupt), /invalid_profit/);
    }
    const editedHistory = structuredClone(source); editedHistory.completed[0].pnl += 5;
    assert.throws(() => applyProfitWithdrawalDestination(editedHistory, destinationProof()), /invalid_profit_taking_ledger/);
});

test('Bridge net receipts, fees and gas retain loss carry across repeated chunks and manual deposits', () => {
    let state = applyProfitWithdrawalDestination(applyProfitWithdrawalSource(bridgeReserve(fixture([6])), sourceProof()), destinationProof());
    state.completed.push(row(-4), row(8)); state.cash = 29.993960;
    state.externalWalletActivity = { cashDelta: 100, receipts: [{ hash: hash('9'), cash: 100 }], capitalAllocated: 0 };
    assert.equal(profitTakingBudget(state, bridgePolicy, context).eligible, false);
    state.completed.push(row(.02)); state.cash = 30.013960;
    assert.equal(profitTakingBudget(state, bridgePolicy, context).eligible, true);
    const second = bridgeReserve(state, { id: 'withdrawal:2', hash: hash('3') });
    state = applyProfitWithdrawalSource(second, sourceProof({ id: 'withdrawal:2', hash: hash('3') }));
    state = applyProfitWithdrawalDestination(state, destinationProof({ id: 'withdrawal:2', sourceHash: hash('3'), hash: hash('4') }));
    assert.equal(state.profitTaking.totalTokenDebited, 10);
    assert.equal(state.profitTaking.totalTransferred, 9.999920);
    assert.equal(state.profitTaking.withdrawalGasUsd, .012);
    assert.equal(state.profitTaking.withdrawalFeesUsd, .000080);
    assert.equal(distributionAdjustedCash(state), 20.008);
    assert.equal(profitTakingBudget(state, bridgePolicy, context).availableProfitUsd, -.002);
});
