import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { profitTakingBudget, reserveProfitWithdrawal, applyProfitWithdrawalSource,
    applyProfitWithdrawalDestination, profitTakingLedger } from '../../src/laya-live/profit-accounting.js';
import { lossWithdrawalCandidate, claimLossWithdrawal } from '../../src/laya-live/loss-withdrawal.js';

const hash = digit => '0x' + digit.repeat(64);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recipient = '0x' + 'a'.repeat(40);
const policy = { recipient, asset: 'USDC', chunkUsd: 5, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15,
    lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } };
const request = { id: 'loss-withdrawal:1', hash: hash('2'), createdAt: 5000,
    openOrders: [], walletBalance: 11, gasReserveUsd: .15, feeReserveUsd: .05 };

function fixture({ beforeBalance = 14, afterBalance = 11 } = {}) {
    const activation = { schema: 1, activatedAt: 2000, completedCount: 0, completedSha256: digest([]) };
    const before = { balance: beforeBalance, blockNumber: 10, blockHash: hash('b'), checkedAt: 2900,
        walletCashDelta: 0, externalCashDelta: 0, totalDeposited: 0, totalTokenDebited: 0 };
    const after = { ...before, balance: afterBalance, blockNumber: 20, checkedAt: 3900,
        walletCashDelta: Math.round((afterBalance - beforeBalance) * 1e6) / 1e6 };
    const row = { traded: true, pnl: after.walletCashDelta, uncertain: false, openedAt: 3000, closedAt: 4000,
        conditionId: hash('c'), fills: [{ hash: hash('1'), orderId: hash('d'), shares: 5, source: 'receipt' }],
        entrySignal: { lossProtection: { schema: 1, activationId: digest(activation), before, after } } };
    return { baseline: 'loss-protection-fixture', startedAt: 1000, mode: 'pilot', position: null, stopped: null,
        liveFunding: { initialCapital: beforeBalance }, cash: afterBalance, walletStart: beforeBalance,
        walletCashDelta: after.walletCashDelta, peakEquity: beforeBalance, lastEquity: afterBalance, maxDrawdown: 0,
        completed: [row], profitTakingControl: { schema: 1, policy, operation: null, disabled: null,
            lossProtection: { ...activation, consumed: [] } },
        settlementEvidence: { [hash('1')]: { kind: 'fill', source: 'receipt', hash: hash('1'), orderId: hash('d'),
            conditionId: hash('c'), blockNumber: 11, blockHash: hash('b'), shares: 5, cash: -3 } } };
}

test('a future receipt-backed loss withdraws five below normal threshold without retaining ten', () => {
    const state = fixture(), original = structuredClone(state);
    const budget = profitTakingBudget(state, policy, request);
    assert.equal(budget.eligible, true); assert.equal(budget.withdrawalTrigger, 'loss_protection');
    assert.equal(budget.workingCapitalAfter, 6); assert.equal(budget.walletBalanceVerified, true);
    assert.equal(budget.lossCandidate.beforeTradeWallet, 14); assert.equal(budget.lossCandidate.afterLossWallet, 11);
    assert.deepEqual(state, original);
    const reserved = reserveProfitWithdrawal(state, policy, request);
    assert.equal(reserved.profitTaking.pending.amountUsd, 5);
    assert.equal(reserved.profitTaking.pending.lossId, reserved.profitTakingControl.lossProtection.consumed[0].lossId);
    assert.equal(reserved.profitTakingControl.lossProtection.consumed[0].intentId, request.id);
    assert.equal(reserved.profitTakingControl.lossProtection.consumed.length, 1);
});

test('loss policy uses inclusive fourteen, exclusive ten, and verified current funds without estimated reservation', () => {
    for (const [beforeBalance, afterBalance, eligible] of [[14, 10.000001, true], [13.999999, 11, false],
        [14, 10, false], [14, 9.999999, false], [15, 14, true]]) {
        const state = fixture({ beforeBalance, afterBalance });
        assert.equal(profitTakingBudget(state, policy, { ...request, walletBalance: afterBalance }).eligible, eligible);
    }
    const state = fixture();
    assert.equal(profitTakingBudget(state, policy, { ...request, walletBalance: 10 }).eligible, false);
    const estimate = { ...request, expectedWalletBalance: 11 }; delete estimate.walletBalance;
    assert.equal(profitTakingBudget(state, policy, estimate).eligible, true);
    assert.throws(() => reserveProfitWithdrawal(state, policy, estimate), /profit_taking_wallet_unverified/);
});

test('normal fifteen threshold keeps precedence and consumes the same eligible loss once', () => {
    const state = fixture({ beforeBalance: 17, afterBalance: 15 });
    const budget = profitTakingBudget(state, policy, { ...request, walletBalance: 15 });
    assert.equal(budget.eligible, true); assert.equal(budget.withdrawalTrigger, 'wallet_balance');
    assert.equal(budget.workingCapitalAfter, 10); assert.ok(budget.lossCandidate);
    const next = reserveProfitWithdrawal(state, policy, { ...request, walletBalance: 15 });
    assert.equal(next.profitTakingControl.lossProtection.consumed.length, 1);
});

test('historical, unfilled, uncertain, profitable and unproven losses cannot activate the exception', () => {
    const mutations = {
        historical: s => { const marker = s.profitTakingControl.lossProtection;
            marker.completedCount = 1; marker.completedSha256 = digest(s.completed); },
        preactivation: s => { s.completed[0].openedAt = 1999; },
        nofill: s => { s.completed[0].traded = false; },
        uncertain: s => { s.completed[0].uncertain = true; },
        win: s => { s.completed[0].pnl = 1; },
        flat: s => { s.completed[0].pnl = 0; },
        no_witness: s => { delete s.completed[0].entrySignal; },
        wrong_activation: s => { s.completed[0].entrySignal.lossProtection.activationId = '0'.repeat(64); },
        missing_fill: s => { s.completed[0].fills = []; },
        no_receipt: s => { s.settlementEvidence = {}; },
        wrong_receipt: s => { s.settlementEvidence[hash('1')].conditionId = hash('d'); },
        early_after: s => { s.completed[0].entrySignal.lossProtection.after.checkedAt = 2999; },
        late_before: s => { s.completed[0].entrySignal.lossProtection.before.checkedAt = 3001; },
        wrong_balance: s => { s.completed[0].entrySignal.lossProtection.before.balance = 15; },
        shifted_balances: s => { const proof = s.completed[0].entrySignal.lossProtection;
            proof.before.balance += 1; proof.after.balance += 1; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const state = fixture(); mutate(state);
        assert.equal(profitTakingBudget(state, policy, request).eligible, false, name);
        assert.equal(lossWithdrawalCandidate(state, policy), null, name);
    }
});

test('topups, manual cash, withdrawals or later trading cannot manufacture or revive loss eligibility', () => {
    const mutations = {
        during_deposit: s => { s.completed[0].entrySignal.lossProtection.after.totalDeposited = 1; },
        during_manual: s => { s.completed[0].entrySignal.lossProtection.after.externalCashDelta = 1; },
        during_withdrawal: s => { s.completed[0].entrySignal.lossProtection.after.totalTokenDebited = 5; },
        later_deposit: s => { s.capitalFunding = { totalDeposited: 1 }; },
        later_manual: s => { s.externalWalletActivity = { cashDelta: 1 }; },
        later_trade: s => { s.walletCashDelta += 1; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const state = fixture(); mutate(state);
        assert.equal(lossWithdrawalCandidate(state, policy, { walletBalance: 12 }), null, name);
    }
    const emptyAfterLoss = fixture({ afterBalance: 10 });
    assert.equal(profitTakingBudget(emptyAfterLoss, policy, { ...request, walletBalance: 14 }).eligible, false);
});

test('claim persists before routing, survives abandonment, and only its same intent can reserve', () => {
    const state = fixture(), candidate = lossWithdrawalCandidate(state, policy);
    const operation = { id: request.id, createdAt: request.createdAt, stage: 'address_requested' };
    claimLossWithdrawal(state, policy, candidate, operation);
    state.profitTakingControl.operation = operation;
    assert.equal(lossWithdrawalCandidate(state, policy), null);
    assert.ok(lossWithdrawalCandidate(state, policy, { lossIntentId: request.id }));
    assert.throws(() => claimLossWithdrawal(state, policy, candidate, { ...operation, id: 'other' }), /invalid_loss_protection_state/);
    assert.throws(() => reserveProfitWithdrawal(state, policy, { ...request, lossIntentId: 'other' }), /profit_taking_loss_witness_changed/);
    const reserved = reserveProfitWithdrawal(state, policy, { ...request, lossIntentId: request.id });
    assert.equal(reserved.profitTakingControl.lossProtection.consumed.length, 1);
    state.profitTakingControl.operation = null;
    assert.equal(lossWithdrawalCandidate(JSON.parse(JSON.stringify(state)), policy), null);
});

test('source and destination receipts consume a loss exactly once across restarts and reject changed evidence', () => {
    const reserved = reserveProfitWithdrawal(fixture(), policy, request);
    const source = { id: request.id, hash: request.hash, recipient, asset: 'USDC', amountUsd: 5,
        status: 'confirmed', tokenDebitUsd: 5, gasUsd: .006, feeUsd: 0, blockNumber: 30, blockHash: hash('b') };
    const inTransit = applyProfitWithdrawalSource(JSON.parse(JSON.stringify(reserved)), source);
    assert.equal(inTransit.profitTaking.totalTokenDebited, 5);
    assert.deepEqual(applyProfitWithdrawalSource(inTransit, source), inTransit);
    const destination = { id: request.id, sourceHash: request.hash, hash: hash('3'), recipient, asset: 'USDC',
        receivedUsd: 4.99, blockNumber: 31, blockHash: hash('b') };
    const completed = applyProfitWithdrawalDestination(JSON.parse(JSON.stringify(inTransit)), destination);
    assert.equal(completed.profitTaking.withdrawals[0].lossId, reserved.profitTaking.pending.lossId);
    assert.equal(completed.profitTaking.totalTransferred, 4.99);
    assert.equal(completed.profitTaking.withdrawalFeesUsd, .01);
    assert.equal(completed.cash, 10.984);
    assert.deepEqual(applyProfitWithdrawalDestination(completed, destination), completed);
    assert.equal(lossWithdrawalCandidate(completed, policy), null);
    assert.throws(() => applyProfitWithdrawalDestination(completed, { ...destination, receivedUsd: 5 }), /receipt_mismatch/);
    const tampered = structuredClone(completed); tampered.profitTakingControl.lossProtection.consumed = [];
    assert.throws(() => profitTakingLedger(tampered), /invalid_profit_taking_ledger/);
});

test('activation prefix and consumed-loss history are immutable and normal policy remains opt-in', () => {
    const state = fixture(), legacy = { ...policy }; delete legacy.lossProtection;
    assert.equal(profitTakingBudget(state, legacy, request).eligible, false);
    for (const value of [{ beforeTradeMinUsd: 13, afterLossMinUsd: 10, amountUsd: 5 },
        { beforeTradeMinUsd: 14, afterLossMinUsd: 9, amountUsd: 5 },
        { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 6 }])
        assert.throws(() => profitTakingBudget(state, { ...policy, lossProtection: value }, request), /invalid_profit_taking_policy/);
    state.profitTakingControl.lossProtection.completedSha256 = '0'.repeat(64);
    assert.throws(() => profitTakingBudget(state, policy, request), /invalid_loss_protection_state/);
});
