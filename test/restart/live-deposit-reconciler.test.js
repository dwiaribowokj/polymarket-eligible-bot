import test from 'node:test';
import assert from 'node:assert/strict';
import { CapitalDepositReconciler } from '../../src/laya-live/deposits.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { CONTRACTS } from '../../src/restart/client.js';

const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const wallet = `0x${'12'.repeat(20)}`, sender = `0x${'34'.repeat(20)}`;
function fixture() {
    let time = 100000, actual = 6.75, calls = 0, saved;
    const events = [], state = { mode: 'pilot', decisionProvider: 'eligible', cash: 1.25,
        peakEquity: 19, lastEquity: 1.25, maxDrawdown: 17.75, walletStart: 12, walletCashDelta: -10.25,
        liveFunding: { initialCapital: 12 }, completed: [], stopped: null, position: null,
        strategyEpochs: [{ walletProof: { blockNumber: 100, blockHash: hash(100), balance: 1.75 } }] };
    const store = { state, save() { saved = structuredClone(this.state); },
        event(type, detail) { events.push({ type, ...detail }); this.save(); } };
    const config = { settings: { automaticDeposits: true, wallet } };
    const client = { rpc: { anchor: { number: 120, hash: hash(120) },
        async read(stage, fn) { return fn({}); }, async validate() {} },
    async confirmedBlock() { return 120; }, async balance() { return actual; },
    async holdings() { return [...state.position.holdings]; } };
    const entry = { txHash: hash(42), logIndex: 3, from: sender, amount: 5, blockNumber: 110, blockHash: hash(110) };
    const deps = { now: () => time, discover: async () => { calls++; return [entry]; } };
    const reconciler = new CapitalDepositReconciler(config, store, client, deps);
    return { state, store, config, client, entry, deps, reconciler, events, calls: () => calls,
        saved: () => saved, advance: n => { time += n; }, balance: n => { actual = n; } };
}

test('a running bot books a proven deposit once and clears only its temporary entry hold', async () => {
    const f = fixture();
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.cash, 6.25);
    assert.equal(expectedWalletBalance(f.state), 6.75);
    assert.equal(f.state.peakEquity - f.state.lastEquity, 17.75);
    assert.equal(f.state.maxDrawdown, 17.75);
    assert.equal(f.state.stopped, null);
    assert.deepEqual(f.state.entryHolds, {});
    assert.equal(f.state.capitalDepositRecovery, undefined);
    assert.equal(f.events.filter(e => e.type === 'capital_deposit_credited').length, 1);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.calls(), 1);
    assert.equal(f.state.cash, 6.25);
});

test('legacy wallet mismatch from this deposit is archived without clearing an unrelated stop', async () => {
    for (const reason of ['wallet_ledger_mismatch', 'drawdown_limit', 'unknown_transaction']) {
        const f = fixture(); f.state.stopped = { reason, at: 90000 };
        f.state.reconciliationFaults = { wallet_ledger_mismatch: { firstAt: 90000 } };
        assert.equal(await f.reconciler.reconcile(), true);
        assert.equal(f.state.stopped?.reason ?? null, reason === 'wallet_ledger_mismatch' ? null : reason);
        assert.equal(f.state.cash, 6.25);
        if (reason === 'wallet_ledger_mismatch') {
            assert.equal(f.state.capitalRecoveryHistory[0].stop.reason, reason);
            assert.deepEqual(f.state.reconciliationFaults, {});
        }
    }
});

test('read-only preview allows deposit startup without modifying the ledger', async () => {
    const f = fixture(); f.state.stopped = { reason: 'wallet_ledger_mismatch', at: 90000 };
    const before = structuredClone(f.state);
    const preview = await f.reconciler.preview();
    assert.deepEqual(preview, { ready: true, amount: 5, balance: 6.75, deposits: 1 });
    assert.deepEqual(f.state, before); assert.equal(f.saved(), undefined);
});

test('credit-before-clear crash can preview and recover flat or open positions after restart without double credit', async () => {
    for (const open of [false, true]) {
        const f = fixture(); f.state.stopped = { reason: 'wallet_ledger_mismatch', at: 90000 };
        f.state.reconciliationFaults = { wallet_ledger_mismatch: { firstAt: 90000 } };
        if (open) f.state.position = { startingCash: 5, holdings: [5, 0], market: { tokens: ['1', '2'] },
            orders: [{ status: 'complete' }], actions: [], pendingTrades: false };
        f.reconciler.clearProvenStop = () => { throw new Error('simulated_process_exit'); };
        assert.equal(await f.reconciler.reconcile(), false);
        const cash = f.state.cash;
        f.store.state = structuredClone(f.saved());
        const next = new CapitalDepositReconciler(f.config, f.store, f.client, f.deps);
        const preview = await next.preview();
        assert.equal(preview?.alreadyCredited, true); assert.equal(preview.amount, 0);
        assert.equal(await next.reconcile(), true);
        assert.equal(f.store.state.cash, cash); assert.equal(f.calls(), 1);
        assert.equal(f.store.state.stopped, null);
        assert.deepEqual(f.store.state.reconciliationFaults, {});
        if (open) assert.equal(f.store.state.position.startingCash, 10);
    }
});

test('deposit during settled inventory preserves trade profit and checks holdings before credit', async () => {
    const f = fixture(); f.state.position = { startingCash: 5, holdings: [5, 0], market: { tokens: ['1', '2'] },
        orders: [{ status: 'complete' }], actions: [], pendingTrades: false, uncertain: true };
    const pnl = f.state.cash - f.state.position.startingCash;
    f.client.holdings = async () => [0, 0];
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.state.cash, 1.25); assert.equal(f.state.stopped, null);
    f.advance(15000); f.client.holdings = async () => [5, 0];
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.state.cash - f.state.position.startingCash, pnl);
});

test('canonical settlement after a credit-before-clear crash does not strand the deposit stop', async () => {
    const f = fixture(); f.state.stopped = { reason: 'wallet_ledger_mismatch', at: 90000 };
    f.state.position = { startingCash: 5, holdings: [5, 0], market: { tokens: ['1', '2'] },
        orders: [{ status: 'complete' }], actions: [], pendingTrades: false };
    f.reconciler.clearProvenStop = () => { throw new Error('simulated_process_exit'); };
    await f.reconciler.reconcile();
    // Existing receipt reconciliation books an official redemption while recovering.
    f.state.cash += 5; f.state.walletCashDelta += 5; f.state.position.holdings = [0, 0];
    f.balance(11.75);
    const next = new CapitalDepositReconciler(f.config, f.store, f.client, f.deps);
    assert.equal((await next.preview()).alreadyCredited, true);
    assert.equal(await next.reconcile(), true);
    assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 11.25);
    assert.equal(f.state.capitalFunding.totalDeposited, 5);
});

test('pending submit and unproven withdrawal source defer credit without interfering with reconciliation', async () => {
    for (const change of [state => { state.position = { orders: [{ status: 'unknown' }] }; },
        state => { state.profitTakingControl = { operation: { stage: 'source_uncertain' } }; }]) {
        const f = fixture(); change(f.state);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.calls(), 0); assert.equal(f.state.cash, 1.25);
    }
});

test('proven withdrawal source may finish while deposit recognition continues', async () => {
    const f = fixture();
    // The source receipt is already accounted; the bridge destination is still pending.
    f.state.profitTakingControl = { operation: { stage: 'in_transit' } };
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(f.calls(), 1); assert.equal(f.state.cash, 6.25);
});

test('RPC failure uses a bounded retry hold and never makes a balance-only credit', async () => {
    const f = fixture(); f.reconciler.discover = async () => { throw new Error('read_timeout'); };
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.state.cash, 1.25); assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.capital_deposit.retryable, true);
    f.reconciler.discover = f.deps.discover;
    assert.equal(await f.reconciler.reconcile(), false); assert.equal(f.calls(), 0);
    f.advance(15000);
    assert.equal(await f.reconciler.reconcile(), true); assert.equal(f.calls(), 1);
});

test('unexpected accounting mutation during proof prevents applying stale credit', async () => {
    const f = fixture(); f.reconciler.discover = async () => { f.state.walletCashDelta++; return [f.entry]; };
    assert.equal(await f.reconciler.reconcile(), false);
    assert.equal(f.state.cash, 1.25); assert.equal(f.state.capitalFunding, undefined);
});

test('balanced startup establishes and validates canonical checkpoint with no fabricated capital', async () => {
    const f = fixture(); f.balance(1.75);
    assert.equal(await f.reconciler.reconcile({ bootstrap: true }), true);
    assert.equal(f.state.capitalFunding.totalDeposited, 0);
    assert.equal(f.state.capitalFunding.tokenAddress, CONTRACTS.collateralToken.toLowerCase());
    f.client.rpc.validate = async () => { throw new Error('rpc_block_mismatch'); };
    assert.equal(await f.reconciler.reconcile({ bootstrap: true }), false);
    assert.equal(f.state.cash, 1.25);
});
