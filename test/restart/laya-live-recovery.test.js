import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { atomicJson, Store } from '../../src/restart/store.js';
import { BASELINE } from '../../src/restart/config.js';
import { bindContinuation, liveHistory, recoverableBookStop, recoverBookStop,
    expectedWalletBalance, verifyRecoveryCash } from '../../src/laya-live/recovery.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { liveReadiness, livePreflight } from '../../src/laya-live/preflight.js';

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-recovery-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const policy = { aiSource: 'original-ai', capitalAllocation: 'available_balance' }, sources = [['original', 'hash']];
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, hashes: sources })).digest('hex').slice(0, 16);
    const directory = path.join(dir, id, 'pilot'), stopped = { reason: 'operational_check_failed', at: 100 };
    const settings = { ...BASELINE, dataDir: dir, fingerprint: id, capital: 20 };
    const store = new Store(settings, 'pilot', 'late-entry'); store.logger = () => {};
    Object.assign(store.state, { decisionProvider: 'laya', startedAt: 50, stopped, walletStart: 20, walletCashDelta: 0,
        liveFunding: { initialCapital: 20 }, ai: { snapshots: [], providers: {} } }); store.save();
    atomicJson(path.join(directory, 'laya-manifest.json'), { id, policy, sources, startedAt: 50 });
    atomicJson(path.join(directory, 'laya-report.json'), { liveStarted: true });
    const config = { id: '0123456789abcdef', settings, policy, ai: {}, rehearsalDataDir: path.join(dir, 'paper') };
    const approval = { schema: 1, runtimeId: config.id, periodId: id, recoverStop: stopped };
    atomicJson(path.join(dir, 'laya-live-continuation.json'), approval);
    return { dir, directory, config, store, approval, id };
}

test('live history excludes generated manifest/report but preserves conflicting and corrupt ledgers', t => {
    const f = fixture(t);
    assert.equal(liveHistory(f.config.settings).length, 1);
    atomicJson(path.join(f.directory, 'maker-mm.json'), { baseline: 'other', strategy: 'maker-mm', mode: 'pilot' });
    assert.equal(liveHistory(f.config.settings).length, 2);
    fs.writeFileSync(path.join(f.directory, 'late-entry.json'), '{bad');
    assert.throws(() => liveHistory(f.config.settings));
});

test('reviewed repair binds the original period without writing ledger, clock, funding or manifest', t => {
    const f = fixture(t), ledger = fs.readFileSync(f.store.filename), manifest = fs.readFileSync(path.join(f.directory, 'laya-manifest.json'));
    const config = bindContinuation(f.config);
    assert.equal(config.id, f.id); assert.equal(config.runtimeId, f.config.id);
    assert.equal(config.settings.fingerprint, f.id);
    assert.deepEqual(fs.readFileSync(f.store.filename), ledger);
    assert.deepEqual(fs.readFileSync(path.join(f.directory, 'laya-manifest.json')), manifest);
});

test('runtime, policy, ledger identity and original manifest tampering cannot authorize continuation', t => {
    const f = fixture(t);
    assert.throws(() => bindContinuation({ ...f.config, id: '1111111111111111' }), /runtime_mismatch/);
    assert.throws(() => bindContinuation({ ...f.config, policy: { ...f.config.policy, shares: 50 } }), /policy_mismatch/);
    const manifestFile = path.join(f.directory, 'laya-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile));
    atomicJson(manifestFile, { ...manifest, sources: [] });
    assert.throws(() => bindContinuation(f.config), /policy_mismatch/);
    atomicJson(manifestFile, manifest); f.store.state.startedAt++; f.store.save();
    assert.throws(() => bindContinuation(f.config), /ledger_mismatch/);
});

test('read-only diagnostics may mark the exact empty-book incident recoverable without clearing its stop', t => {
    const f = fixture(t), config = bindContinuation(f.config), before = fs.readFileSync(f.store.filename);
    assert.equal(recoverableBookStop(config, f.store.state), true);
    const status = liveReadiness({ state: f.store.state, operationalReady: true,
        recoverableStop: recoverableBookStop(config, f.store.state) });
    assert.equal(status.readyForLive, true);
    assert.ok(status.warnings.includes('pre_entry_book_stop_recoverable'));
    assert.deepEqual(fs.readFileSync(f.store.filename), before);
});

test('recovery requires explicit healthy startup and archives the incident without resetting accounting or pilot time', t => {
    const f = fixture(t), config = bindContinuation(f.config), before = structuredClone(f.store.state);
    for (const context of [{ explicitLive: false, operationalReady: true }, { explicitLive: true, operationalReady: false },
        { explicitLive: true, operationalReady: true, otherHistory: true }]) {
        assert.throws(() => recoverBookStop(f.store, config, context), /recovery_blocked/);
        assert.deepEqual(f.store.state, before);
    }
    recoverBookStop(f.store, config, { explicitLive: true, operationalReady: true, otherHistory: false });
    assert.equal(f.store.state.stopped, null); assert.equal(f.store.state.stopHistory[0].at, 100);
    for (const key of ['startedAt', 'cash', 'peakEquity', 'maxDrawdown', 'liveFunding', 'seen', 'completed', 'walletStart'])
        assert.deepEqual(f.store.state[key], before[key]);
    const restarted = new Store(config.settings, 'pilot', 'late-entry');
    assert.equal(restarted.state.stopHistory.length, 1); assert.equal(recoverableBookStop(config, restarted.state), false);
});

test('recovery never clears a risk stop, unknown submission, inventory or prior trading history', t => {
    const f = fixture(t), config = bindContinuation(f.config);
    for (const mutation of [{ stopped: { reason: 'drawdown_limit', at: 100 } },
        { stopped: { reason: 'unknown_order_submission', at: 100 } }, { stopped: { reason: 'operational_check_failed', at: 101 } },
        { position: { orders: [{ status: 'unknown' }] } }, { seen: { market: {} } }, { completed: [{ pnl: -1 }] },
        { maxDrawdown: 2 }, { cash: 19 }, { ai: { snapshots: [{ snapshotId: 'x' }], providers: {} } },
        { ai: { snapshots: [], providers: { laya: { pending: {} } } } }]) {
        assert.equal(recoverableBookStop(config, { ...f.store.state, ...mutation }), false);
    }
});

function expiryFixture(t) {
    const f = fixture(t), config = bindContinuation(f.config);
    config.ai = { ...config.ai, decisionMs: 3000, dataAgeMs: 5000 };
    f.store.state.stopped = { reason: 'stale_or_invalid_execution_data', at: 5203 };
    f.store.state.ai.snapshots = [{ snapshotId: 'expired-snapshot', at: 2314, observedAt: 0, decisionReceivedAt: 5195,
        decision: { snapshotId: 'expired-snapshot', status: 'ok', model: 'typed-decisions', action: 'BUY_DOWN' } }];
    f.store.state.ai.slots = { 'market:90': { status: 'invalid' } };
    config.continuation = { ...config.continuation, recoverStop: f.store.state.stopped, incident: {
        reason: 'stale_laya_input', snapshotId: 'expired-snapshot',
        snapshotsSha256: crypto.createHash('sha256').update(JSON.stringify(f.store.state.ai.snapshots)).digest('hex') } };
    f.store.save();
    return { ...f, config };
}

test('reviewed pre-entry expiry recovery retains completed inference, consumed slots, accounting and original deadline', t => {
    const f = expiryFixture(t), before = structuredClone(f.store.state);
    assert.equal(recoverableBookStop(f.config, f.store.state), true);
    recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true, otherHistory: false });
    assert.equal(f.store.state.stopped, null);
    for (const key of ['ai', 'seen', 'completed', 'cash', 'peakEquity', 'maxDrawdown', 'startedAt', 'walletStart', 'liveFunding'])
        assert.deepEqual(f.store.state[key], before[key]);
    assert.deepEqual(f.store.state.stopHistory[0].reason, before.stopped.reason);
});

test('expiry approval cannot clear changed decisions, unknown inference, exposure, risk or an unrelated stop', t => {
    const f = expiryFixture(t), state = f.store.state;
    for (const change of [{ ai: { ...state.ai, snapshots: [] } },
        { ai: { ...state.ai, snapshots: [{ ...state.ai.snapshots[0], decisionReceivedAt: 5196 }] } },
        { ai: { ...state.ai, providers: { laya: { pending: {} } } } },
        { ai: { ...state.ai, providers: { laya: { disabled: 'unknown' } } } },
        { position: { orders: [] } }, { seen: { market: {} } }, { cash: 19 }, { maxDrawdown: 2 },
        { stopped: { ...state.stopped, at: 5204 } }, { stopped: { ...state.stopped, reason: 'drawdown_limit' } }])
        assert.equal(recoverableBookStop(f.config, { ...state, ...change }), false);
    // Even a newly pinned snapshot must satisfy the timing proof.
    const future = structuredClone(state); future.ai.snapshots[0].observedAt = 2315;
    f.config.continuation.incident.snapshotsSha256 = crypto.createHash('sha256').update(JSON.stringify(future.ai.snapshots)).digest('hex');
    assert.equal(recoverableBookStop(f.config, future), false);
});

test('reviewed clock recovery retains pinned decisions and resolved timeouts without resetting the period', t => {
    const f = fixture(t), config = bindContinuation(f.config);
    const state = f.store.state;
    state.ai.snapshots = [
        { snapshotId: 'known', at: 10, decisionReceivedAt: 20,
            decision: { snapshotId: 'known', status: 'ok', model: 'typed-decisions', action: 'SKIP' } },
        { snapshotId: 'timeout', at: 30, decisionReceivedAt: 40,
            decision: { snapshotId: 'timeout', status: 'decision_timeout', action: 'SKIP', actualLatencyMs: 3100 } },
    ];
    state.ai.slots = { 'market:90': { status: 'observed' } };
    config.continuation.incident = { reason: 'invalid_server_clock',
        snapshotsSha256: crypto.createHash('sha256').update(JSON.stringify(state.ai.snapshots)).digest('hex') };
    const before = structuredClone(state);
    assert.equal(recoverableBookStop(config, state), true);
    for (const mutation of [{ position: {} }, { cash: 19 }, { maxDrawdown: 2 }, { seen: { market: {} } },
        { ai: { ...state.ai, snapshots: [] } }, { ai: { ...state.ai, providers: { laya: { pending: {} } } } },
        { stopped: { ...state.stopped, at: 101 } }])
        assert.equal(recoverableBookStop(config, { ...state, ...mutation }), false);
    recoverBookStop(f.store, config, { explicitLive: true, operationalReady: true, otherHistory: false });
    for (const key of ['ai', 'cash', 'peakEquity', 'maxDrawdown', 'startedAt', 'seen', 'completed', 'walletStart'])
        assert.deepEqual(state[key], before[key]);
    assert.equal(state.stopped, null); assert.equal(state.stopHistory.at(-1).at, 100);
});

test('restart preflight detects external wallet changes before offering recovery, without changing capital', async t => {
    const f = fixture(t), config = bindContinuation(f.config);
    const market = { minimum: 5, accepting: true }, before = fs.readFileSync(f.store.filename);
    let balance = 20;
    const client = { serverTime: async () => Date.now(), json: async () => ({ blocked: false }), market: async () => market,
        books: async () => [{ asks: [] }, { asks: [] }], positions: async () => [], gasPriceUsd: async () => 1,
        ordersAndTrades: async () => ({ orders: [], trades: [] }), walletHealth: async () => ({ contract: true,
            signerIsOwner: true, threshold: 1, balance, nativeGas: 5, exchangeAllowance: 100,
            exchangeApproval: true, adapterApproval: true }) };
    const providers = { preflight: async () => ({ laya: { ready: true } }) };
    config.ai.dataDir = path.join(f.dir, 'shadow');
    let result = await livePreflight(config, client, providers, f.store.state);
    assert.equal(result.output.readyForLive, true); assert.equal(result.output.recoverableStop, true);
    balance = 20.5;
    result = await livePreflight(config, client, providers, f.store.state);
    assert.equal(result.output.readyForLive, false); assert.equal(result.output.operationalReady, false);
    assert.equal(result.output.checks.find(c => c.name === 'wallet_ledger_reconciliation').ok, false);
    assert.deepEqual(fs.readFileSync(f.store.filename), before);
});

function cashFixture(t) {
    const f = fixture(t), config = bindContinuation(f.config);
    const wallet = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222';
    config.settings.wallet = wallet;
    const iface = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    const make = (cash, n) => {
        const event = iface.encodeEventLog(iface.getEvent('Transfer'), cash > 0
            ? [other, wallet, Math.round(cash * 1e6)] : [wallet, other, Math.round(-cash * 1e6)]);
        const hash = `0x${String(n).padStart(64, '0')}`, blockHash = `0x${'a'.repeat(64)}`;
        return { expected: { hash, cash, blockHash, blockNumber: 90 }, receipt: { status: 1, confirmations: 10,
            blockNumber: 90, blockHash, logs: [{ address: CONTRACTS.collateralToken, ...event }] } };
    };
    const rows = [make(-1.026589, 1), make(1.612902, 2)];
    config.continuation.walletAdjustments = rows.map(r => r.expected);
    const client = { confirmedBlock: async () => 100, balance: async block => {
        assert.equal(block, 100); return 20.586313;
    }, receipt: async hash => rows.find(r => r.expected.hash === hash)?.receipt };
    return { ...f, config, client, rows };
}

test('reviewed external receipts reconcile cash without allocating more capital or claiming external profit', async t => {
    const f = cashFixture(t), before = fs.readFileSync(f.store.filename);
    const reconciliation = await verifyRecoveryCash(f.config, f.store.state, f.client);
    assert.equal(reconciliation.externalCashDelta, .586313); assert.equal(reconciliation.expectedPUSD, 20.586313);
    assert.deepEqual(fs.readFileSync(f.store.filename), before);
    assert.throws(() => recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true }), /reconciliation_required/);
    recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true, walletReconciliation: reconciliation });
    const restored = new Store(f.config.settings, 'pilot', 'late-entry'); restored.logger = () => {};
    assert.equal(expectedWalletBalance(restored.state), 20.586313);
    assert.equal(restored.state.cash, 20); assert.equal(restored.state.peakEquity, 20);
    assert.equal(restored.state.liveFunding.initialCapital, 20); assert.equal(restored.state.walletStart, 20);
    assert.equal(restored.state.externalWalletActivity.capitalAllocated, 0);
    assert.equal(restored.state.completed.length, 0); assert.equal(restored.state.stopped, null);
    assert.equal(restored.state.stopHistory.length, 1);
    const broker = new LayaLiveBroker(f.config.settings, restored, f.client, async () => {});
    assert.equal(await broker.checkWallet(), true);
    // Any subsequent, unaccounted wallet change still stops the bot.
    f.client.balance = async () => 21;
    assert.equal(await broker.checkWallet(), false); assert.equal(restored.state.stopped.reason, 'wallet_ledger_mismatch');
});

test('wrong chain receipt, failed/pending receipt and mismatched external cash cannot be reconciled', async t => {
    const f = cashFixture(t);
    for (const mutation of [{ status: 0 }, { confirmations: 1 }, { blockNumber: 101 },
        { blockHash: 'different' }, { logs: [] }]) {
        const original = f.rows[0].receipt; f.rows[0].receipt = { ...original, ...mutation };
        await assert.rejects(verifyRecoveryCash(f.config, f.store.state, f.client), /external_wallet_receipt/);
        f.rows[0].receipt = original;
    }
    f.config.continuation.walletAdjustments.push(f.config.continuation.walletAdjustments[0]);
    await assert.rejects(verifyRecoveryCash(f.config, f.store.state, f.client), /duplicate/);
    assert.equal(f.store.state.stopped.reason, 'operational_check_failed');
});

test('confirmed manual buys append verified external receipts and preserve original cash, risk, decisions and deadline', async t => {
    const f = cashFixture(t), state = f.store.state;
    const wallet = f.config.settings.wallet, other = '0x2222222222222222222222222222222222222222';
    const iface = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    [-1.0196, -1.0147].forEach((cash, i) => {
        const event = iface.encodeEventLog(iface.getEvent('Transfer'), [wallet, other, Math.round(-cash * 1e6)]);
        f.rows[i].expected.cash = cash;
        f.rows[i].receipt.logs = [{ address: CONTRACTS.collateralToken, ...event }];
    });
    state.stopped = { reason: 'wallet_ledger_mismatch', at: 100 };
    state.externalWalletActivity = { cashDelta: .586313, capitalAllocated: 0,
        receipts: [{ hash: `0x${'3'.repeat(64)}`, cash: .586313 }] };
    f.config.continuation.recoverStop = { ...state.stopped };
    f.config.continuation.incident = { reason: 'reviewed_manual_wallet_activity', manualConfirmed: true,
        snapshotsSha256: crypto.createHash('sha256').update(JSON.stringify(state.ai.snapshots)).digest('hex') };
    f.config.continuation.walletAdjustments = f.rows.map(row => ({ ...row.expected }));
    f.client.balance = async () => 18.552013;
    const before = structuredClone(state);
    assert.equal(recoverableBookStop(f.config, state), true);
    f.config.continuation.incident.manualConfirmed = false;
    assert.equal(recoverableBookStop(f.config, state), false);
    f.config.continuation.incident.manualConfirmed = true;
    for (const change of [{ maxDrawdown: 2 }, { position: {} }, { seen: { market: {} } },
        { ai: { ...state.ai, snapshots: [{ snapshotId: 'changed' }] } },
        { ai: { ...state.ai, providers: { laya: { pending: {} } } } },
        { stopped: { ...state.stopped, reason: 'unknown_order_submission' } }])
        assert.equal(recoverableBookStop(f.config, { ...state, ...change }), false);
    const r = await verifyRecoveryCash(f.config, state, f.client);
    assert.equal(r.externalCashDelta, -2.0343); assert.equal(r.expectedPUSD, 18.552013);
    recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true, otherHistory: false, walletReconciliation: r });
    assert.equal(state.externalWalletActivity.cashDelta, -1.447987);
    assert.equal(state.externalWalletActivity.receipts.length, 3);
    assert.deepEqual(state.externalWalletActivity.receipts[0], before.externalWalletActivity.receipts[0]);
    assert.equal(expectedWalletBalance(state), 18.552013); assert.equal(state.externalWalletActivity.capitalAllocated, 0);
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'startedAt', 'liveFunding', 'walletStart', 'ai'])
        assert.deepEqual(state[key], before[key]);
    assert.equal(state.stopped, null); assert.equal(state.stopHistory.at(-1).reason, 'wallet_ledger_mismatch');
    assert.equal(await verifyRecoveryCash(f.config, state, f.client), null);
    // A new unreviewed external spend still triggers the persistent stop.
    f.client.confirmedBlock = async () => 100; f.client.balance = async () => 17;
    assert.equal(await new LayaLiveBroker(f.config.settings, f.store, f.client, async () => {}).checkWallet(), false);
    assert.equal(state.stopped.reason, 'wallet_ledger_mismatch');
});

test('manual reconciliation cannot import an already accounted receipt', async t => {
    const f = cashFixture(t), state = f.store.state;
    state.stopped = { reason: 'wallet_ledger_mismatch', at: 100 };
    f.config.continuation.recoverStop = state.stopped;
    f.config.continuation.incident = { reason: 'reviewed_manual_wallet_activity', manualConfirmed: true,
        snapshotsSha256: crypto.createHash('sha256').update(JSON.stringify(state.ai.snapshots)).digest('hex') };
    state.externalWalletActivity = { cashDelta: f.rows[0].expected.cash,
        receipts: [{ ...f.rows[0].expected }], capitalAllocated: 0 };
    await assert.rejects(verifyRecoveryCash(f.config, state, f.client), /receipt_duplicate/);
});

test('external adjustment cannot be imported twice or used to hide a real loss stop', async t => {
    const f = cashFixture(t), reconciliation = await verifyRecoveryCash(f.config, f.store.state, f.client);
    assert.throws(() => recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true,
        walletReconciliation: { ...reconciliation, externalCashDelta: 2 } }), /reconciliation_required/);
    recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true, walletReconciliation: reconciliation });
    assert.throws(() => recoverBookStop(f.store, f.config, { explicitLive: true, operationalReady: true,
        walletReconciliation: reconciliation }), /recovery_blocked/);
    f.store.state.stopped = { reason: 'drawdown_limit', at: 200 };
    assert.equal(await verifyRecoveryCash(f.config, f.store.state, f.client), null);
    assert.equal(recoverableBookStop(f.config, f.store.state), false);
    f.store.state.externalWalletActivity.cashDelta = 3;
    assert.throws(() => expectedWalletBalance(f.store.state), /invalid_external_wallet_accounting/);
});
