import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCapitalAllocation, applyCapitalAllocation, capitalAllocationLedger, totalCapitalAllocated }
    from '../../src/laya-live/capital-allocations.js';
import { applyConfirmedCapitalDeposits, totalCapitalDeposited } from '../../src/laya-live/capital-funding.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { distributionAdjustedCash, profitTakingBudget, reserveProfitWithdrawal, applyProfitWithdrawal }
    from '../../src/laya-live/profit-accounting.js';

const hash = value => `0x${value.toString(16).padStart(64, '0')}`;
const tokenAddress = `0x${'11'.repeat(20)}`, walletAddress = `0x${'22'.repeat(20)}`;
const recipient = `0x${'33'.repeat(20)}`, identity = { chainId: 137, tokenAddress, walletAddress };
const policy = { recipient, asset: 'pUSD', chunkUsd: 5, retainUsd: 20 };

function fixture() {
    const checkpoint = { blockNumber: 200, blockHash: hash(200) };
    const state = { baseline: 'allocation-period', startedAt: 1000, mode: 'pilot', decisionProvider: 'eligible',
        cash: 2.04043, peakEquity: 19.157402, lastEquity: 2.04043, maxDrawdown: 17.116972,
        walletStart: 12.920246, walletCashDelta: -10.379704, liveFunding: { initialCapital: 12.920246 },
        completed: [{ traded: true, pnl: -10.879816 }], position: null, stopped: null,
        stopHistory: [{ at: 2000, reason: 'old_stop' }], entryHolds: {}, reconciliationFaults: {},
        externalWalletActivity: { capitalAllocated: 0, cashDelta: 3.447673,
            receipts: [{ hash: hash(1), blockNumber: 100, blockHash: hash(100), cash: 5,
                tokenIds: ['11', '22'], holdings: [2, 1] },
            { hash: hash(2), blockNumber: 101, blockHash: hash(101), cash: -1.552327,
                tokenIds: ['11', '22'], holdings: [-1, 0] }],
            automatic: { schema: 1, checkpoint, holdings: [{ tokenId: '11', amount: 1 }, { tokenId: '22', amount: 1 }] } } };
    applyConfirmedCapitalDeposits({ state, save() {} }, { ...identity,
        entries: [{ txHash: hash(10), logIndex: 0, from: recipient, amount: 5, blockNumber: 150, blockHash: hash(150) }],
        checkpoint, expectedBalanceBefore: 5.988215, actualBalanceAfter: 10.988215 });
    const input = { id: 'user-manual-cash-1', amount: 3.447673,
        approval: { source: 'explicit_user_instruction', text: 'Use available wallet cash as bot capital.' },
        walletProof: { ...identity, blockNumber: 210, blockHash: hash(210), balance: 10.988215,
            confirmedNonce: '3', pendingNonce: '3', safeNonce: '4', pendingSafeNonce: '4',
            verificationStartedAt: 9000, verifiedAt: 10000 },
        externalActivityProof: { schema: 1, source: 'automatic_manual_ctf', blockNumber: 210, blockHash: hash(210),
            verifiedAt: 10000, checkpoint, holdings: structuredClone(state.externalWalletActivity.automatic.holdings),
            orders: { count: 0, reservedPUSD: 0, overlaps: false } }, openOrders: [], tradesSettled: true };
    const f = { state, input, at: 10000, saves: 0, disk: structuredClone(state) };
    f.store = { state, save() { f.saves++; f.disk = structuredClone(state); } };
    f.prepare = () => prepareCapitalAllocation(state, input, { now: () => f.at });
    f.apply = () => applyCapitalAllocation(f.store, f.prepare(), { explicitApply: true });
    return f;
}

test('manual cash allocation preserves wallet receipts, PnL, drawdown and the native gas accounting difference', () => {
    const f = fixture(), before = structuredClone(f.state), walletBefore = expectedWalletBalance(f.state);
    const budget = profitTakingBudget(f.state, policy, { openOrders: [] });
    const review = f.prepare();
    assert.deepEqual(f.state, before); assert.equal(f.saves, 0);
    assert.equal(review.summary.cashAfter, 10.488103);
    assert.equal(review.summary.financialWrites, false);
    assert.throws(() => applyCapitalAllocation(f.store, review), /review_changed/);
    const applied = applyCapitalAllocation(f.store, review, { explicitApply: true });
    assert.equal(applied.amount, 3.447673); assert.equal(f.saves, 1);
    assert.equal(f.state.cash, 10.488103); assert.equal(totalCapitalAllocated(f.state), 3.447673);
    assert.equal(totalCapitalDeposited(f.state), 5);
    assert.equal(expectedWalletBalance(f.state), walletBefore);
    assert.ok(Math.abs(walletBefore - distributionAdjustedCash(f.state) - .500112) < 1e-12);
    assert.equal(f.state.peakEquity, before.peakEquity + 3.447673);
    assert.equal(f.state.lastEquity, before.lastEquity + 3.447673);
    assert.ok(Math.abs(f.state.peakEquity - f.state.lastEquity - (before.peakEquity - before.lastEquity)) < 1e-12);
    for (const key of Object.keys(before).filter(key => !['cash', 'peakEquity', 'lastEquity'].includes(key)))
        assert.deepEqual(f.state[key], before[key], key);
    const after = profitTakingBudget(f.state, policy, { openOrders: [] });
    assert.equal(after.realizedProfitUsd, budget.realizedProfitUsd);
    assert.equal(after.availableProfitUsd, budget.availableProfitUsd);
    assert.deepEqual(f.disk, f.state);
    assert.equal(totalCapitalAllocated(JSON.parse(JSON.stringify(f.state))), 3.447673);
});

test('the source ceiling uses manual receipts, never the wallet-to-cash difference', () => {
    for (const amount of [3.447674, 3.947785, 10.988215]) {
        const f = fixture(); f.input.amount = amount;
        assert.throws(f.prepare, /source_exhausted/); assert.equal(f.saves, 0);
    }
    const f = fixture(); f.input.amount = 1; f.apply();
    f.input.id = 'second'; f.input.amount = 2.447673;
    assert.equal(f.apply().totalAllocated, 3.447673);
    f.input.id = 'third'; f.input.amount = .000001;
    assert.throws(f.prepare, /source_exhausted/);
});

test('an identical ID replay after restart is a no-op even after proof expiry; conflicts reject', () => {
    const f = fixture(); f.apply(); const after = structuredClone(f.state);
    f.at = 1000000;
    assert.equal(f.apply().alreadyApplied, true); assert.equal(f.saves, 1); assert.deepEqual(f.state, after);
    const restarted = { state: structuredClone(f.state), save() { assert.fail('duplicate saved'); } };
    const replay = prepareCapitalAllocation(restarted.state, f.input, { now: () => f.at });
    assert.equal(applyCapitalAllocation(restarted, replay, { explicitApply: true }).amount, 0);
    f.input.amount = 1; assert.throws(f.prepare, /id_conflict/);
    f.input.amount = 3.447673; f.input.approval.text += ' changed'; assert.throws(f.prepare, /id_conflict/);
});

test('later manual receipts append without rewriting allocated history or granting further credit', () => {
    const f = fixture(); f.apply();
    const ledger = structuredClone(f.state.capitalAllocations);
    f.state.externalWalletActivity.receipts.push({ hash: hash(3), blockNumber: 220, blockHash: hash(220),
        cash: -1, tokenIds: ['11'], holdings: [1] });
    f.state.externalWalletActivity.cashDelta = 2.447673;
    f.state.externalWalletActivity.automatic.checkpoint = { blockNumber: 230, blockHash: hash(230) };
    f.state.externalWalletActivity.automatic.holdings[0].amount = 2;
    assert.deepEqual(capitalAllocationLedger(f.state), ledger);
    assert.equal(expectedWalletBalance(f.state), 9.988215);
    assert.equal(totalCapitalAllocated(f.state), 3.447673);
    f.input.id = 'new'; f.input.amount = .000001;
    Object.assign(f.input.walletProof, { blockNumber: 230, blockHash: hash(230), balance: 9.988215 });
    Object.assign(f.input.externalActivityProof, { blockNumber: 230, blockHash: hash(230),
        checkpoint: f.state.externalWalletActivity.automatic.checkpoint,
        holdings: f.state.externalWalletActivity.automatic.holdings });
    assert.throws(f.prepare, /source_exhausted/);
});

test('corrupt allocation or receipt history blocks wallet reconciliation and profit spending', () => {
    const changes = [
        s => { s.capitalAllocations.totalAllocated++; },
        s => { s.capitalAllocations.entries[0].request.amount++; },
        s => { s.capitalAllocations.entries.push(structuredClone(s.capitalAllocations.entries[0])); },
        s => { s.capitalAllocations.entries[0].receiptPrefix.sha256 = '0'.repeat(64); },
        s => { s.externalWalletActivity.receipts[0].cash++; s.externalWalletActivity.cashDelta++; },
        s => { s.externalWalletActivity.receipts.pop(); },
        s => { s.capitalAllocations.period.startedAt++; },
        s => { s.capitalAllocations.entries[0].request.walletProof.balance = NaN; },
    ];
    for (const change of changes) {
        const f = fixture(); f.apply(); change(f.state);
        assert.throws(() => expectedWalletBalance(f.state), /capital_allocation_/);
        assert.throws(() => distributionAdjustedCash(f.state), /capital_allocation_/);
        assert.throws(() => profitTakingBudget(f.state, policy, { openOrders: [] }), /capital_allocation_/);
    }
});

test('allocation requires explicit settled proofs at the current source checkpoint and no active operations', () => {
    const changes = [
        f => { f.state.position = {}; },
        f => { f.state.entryHolds.rpc = {}; },
        f => { f.state.reconciliationFaults.wallet = {}; },
        f => { f.state.profitTaking = { pending: {} }; },
        f => { f.state.profitTakingControl = { operation: {} }; },
        f => { f.state.completed[0].pendingTrades = true; },
        f => { f.state.completed[0].uncertain = true; },
        f => { f.state.completed[0].orders = [{ status: 'open' }]; },
        f => { f.state.completed[0].actions = [{ status: 'submitted' }]; },
        f => { f.state.ai = { providers: { eligible: { pending: {} } } }; },
        f => { f.input.openOrders = [{}]; },
        f => { f.input.tradesSettled = false; },
        f => { f.input.approval.source = 'automatic'; },
        f => { f.input.walletProof.pendingNonce = '9'; },
        f => { f.input.walletProof.pendingSafeNonce = '9'; },
        f => { f.input.walletProof.walletAddress = recipient; },
        f => { f.input.walletProof.balance++; },
        f => { f.input.externalActivityProof.checkpoint = { blockNumber: 199, blockHash: hash(199) }; },
        f => { f.input.externalActivityProof.blockHash = hash(211); },
        f => { f.input.externalActivityProof.orders.count = 1; },
        f => { f.input.externalActivityProof.holdings[0].amount++; },
        f => { f.input.walletProof.verifiedAt = 50000; },
        f => { f.input.externalActivityProof.verifiedAt = 8000; },
        f => { f.at = 40000; },
    ];
    for (const change of changes) {
        const f = fixture(); change(f); const before = structuredClone(f.state);
        assert.throws(f.prepare, /capital_allocation_/); assert.deepEqual(f.state, before); assert.equal(f.saves, 0);
    }
});

test('review and state mutation, expiry, and save failure cannot leave a partial credit', () => {
    for (const kind of ['state', 'summary', 'expiry', 'save']) {
        const f = fixture(), review = f.prepare();
        if (kind === 'state') f.state.cash += 1;
        if (kind === 'summary') review.summary.amount += 1;
        if (kind === 'expiry') f.at = 40000;
        if (kind === 'save') f.store.save = () => { throw new Error('save_failed'); };
        const before = structuredClone(f.state);
        assert.throws(() => applyCapitalAllocation(f.store, review, { explicitApply: true }));
        assert.deepEqual(f.state, before); assert.equal(totalCapitalAllocated(f.state), 0);
    }
});

test('allocation preserves stops and historical maximum drawdown without resetting risk', () => {
    const f = fixture();
    f.state.stopped = { reason: 'manual_stop', at: 8000 };
    f.state.liveRiskStop = { reason: 'drawdown_limit', at: 7000, maxDrawdown: 17.116972 };
    const before = structuredClone(f.state);
    f.apply();
    for (const key of ['stopped', 'liveRiskStop', 'maxDrawdown', 'stopHistory', 'completed', 'startedAt', 'liveFunding'])
        assert.deepEqual(f.state[key], before[key]);
});

test('withdrawal principal, costs, and later deposits remain excluded from allocation profit', () => {
    const f = fixture();
    Object.assign(f.state, { cash: 31, peakEquity: 35, lastEquity: 31,
        walletStart: 20, walletCashDelta: 11, liveFunding: { initialCapital: 20 }, completed: [{ traded: true, pnl: 6 }] });
    const reserved = reserveProfitWithdrawal(f.state, policy, { id: 'withdrawal', hash: hash(999), createdAt: 7000,
        gasReserveUsd: .1, feeReserveUsd: .1, openOrders: [] });
    Object.assign(f.state, applyProfitWithdrawal(reserved, { id: 'withdrawal', hash: hash(999),
        recipient, asset: 'pUSD', amountUsd: 5, status: 'confirmed', tokenDebitUsd: 5.05,
        feeUsd: .05, gasUsd: .1, blockNumber: 190, blockHash: hash(190) }));
    f.input.walletProof.balance = expectedWalletBalance(f.state);
    const before = profitTakingBudget(f.state, policy, { openOrders: [] });
    f.apply();
    let after = profitTakingBudget(f.state, policy, { openOrders: [] });
    assert.equal(after.realizedProfitUsd, before.realizedProfitUsd);
    assert.equal(after.availableProfitUsd, before.availableProfitUsd);
    assert.equal(after.totalTransferred, 5);
    assert.equal(distributionAdjustedCash(f.state), 29.297673);
    const wallet = expectedWalletBalance(f.state);
    applyConfirmedCapitalDeposits(f.store, { ...identity,
        entries: [{ txHash: hash(11), logIndex: 0, from: recipient, amount: 2, blockNumber: 250, blockHash: hash(250) }],
        checkpoint: { blockNumber: 250, blockHash: hash(250) }, expectedBalanceBefore: wallet, actualBalanceAfter: wallet + 2 });
    after = profitTakingBudget(f.state, policy, { openOrders: [] });
    assert.equal(after.realizedProfitUsd, before.realizedProfitUsd);
    assert.equal(after.availableProfitUsd, before.availableProfitUsd);
    assert.equal(expectedWalletBalance(f.state), wallet + 2);
    assert.equal(totalCapitalDeposited(f.state), 7);
});
