import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { Store, atomicJson } from '../../src/restart/store.js';
import { bindRiskPeriod } from '../../src/eligible-live/period.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { prepareWalletReadRecovery, applyWalletReadRecovery,
    walletReadRecoveryStateDigest } from '../../src/eligible-live/wallet-read-recovery.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;
const runtimeId = '8899aabbccddeeff', originalRuntimeId = '0011223344556677';
const conditionId = `0x${'e'.repeat(64)}`, orderId = `0x${'f'.repeat(64)}`;
const stoppedAt = 1792898865801;

function files(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [file, hash(fs.readFileSync(file))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-wallet-read-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const policy = { provider: 'eligible' };
    let config = { id: runtimeId, runtimeId, riskRuntimeId: originalRuntimeId,
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`, continuousTrading: true,
            fingerprint: runtimeId, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity },
        policy: { ...policy, continuousTrading: true }, profitTaking: { enabled: false }, paperEvidence: { qualified: false }, ai: {} };
    const old = new Store({ ...config.settings, fingerprint: 'aabbccddeeff0011' }, 'pilot', 'late-entry');
    Object.assign(old.state, { startedAt: 1000, walletStart: 20, walletCashDelta: 0,
        stopped: { reason: 'drawdown_limit', at: 2000 }, maxDrawdown: 10 });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = { schema: 1, runtimeId: originalRuntimeId, dataDir, wallet, drawdownStop: 10,
        policySha256: digest(policy), profitTakingSha256: digest(config.profitTaking),
        createdAt: 3000, nonce: 'd'.repeat(64), openingBalance: 12.920246,
        acknowledgment: 'manual_new_risk_period', automaticActivation: false, approvedHistory: [pin] };
    const periodId = digest(payload).slice(0, 16), riskRoot = path.join(dataDir, 'eligible-risk-periods', originalRuntimeId);
    atomicJson(path.join(riskRoot, periodId, 'record.json'), { periodId, ...payload });
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(old.filename, backup);
    config.runtimeContinuation = { reason: 'user_continuous_trading', runtimeId, originalRuntimeId, periodId,
        policyChange: { previousPolicySha256: digest(policy), currentPolicySha256: digest(config.policy) } };
    config = bindRiskPeriod(config);
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    const identity = { policy: config.policy, sources: [['src/previous.js', 'a'.repeat(64)]], profitTaking: config.profitTaking };
    const previousRuntimeId = digest(identity).slice(0, 16);
    Object.assign(state, { decisionProvider: 'eligible', startedAt: 1792739231020,
        cash: 11.008433, peakEquity: 19.157402, maxDrawdown: 13.729814,
        walletStart: 12.920246, walletCashDelta: -1.610881, lastEquity: 11.008433,
        liveFunding: { at: 1792739231020, initialCapital: 12.920246, allocation: 'available_balance' },
        stopped: { reason: 'operational_check_failed', at: stoppedAt }, reconciliationFaults: {},
        entryHolds: { maintenance_wallet: { retryable: false, firstAt: 1792898865756, failedAt: 1792898865756,
            retryAt: 1792898870756, attempts: 1, error: { name: 'OperationalError', code: 'rpc_rejected',
                category: 'contract', stage: 'wallet_balance', endpoint: 'rpc_primary', durationMs: 405, attempts: 1 } } },
        continuousOperation: { enabledAt: 1792808581496, runtimeId: previousRuntimeId },
        stopHistory: [{ reason: 'trade_receipt_mapping_mismatch', at: 1792745454257, recoveredAt: 1792745554257 }],
        liveClock: { status: 'verified', verifiedAt: stoppedAt + 1000 },
        completed: [{ slug: 'completed', conditionId, tokens: ['1', '2'], traded: true, uncertain: false,
            pnl: .75, fees: .05, gas: 0, rebate: 0, entryCost: 4.25, closedAt: stoppedAt - 20000,
            payout: [0, 1], orders: [{ orderId, tokenId: '2', index: 1, side: 'BUY', status: 'complete', filled: 5, settled: 5 }] },
        { slug: 'no-fill', conditionId: `0x${'a'.repeat(64)}`, tokens: ['3', '4'], traded: false,
            pnl: 0, closedAt: stoppedAt - 10000, orders: [{ status: 'rejected', filled: 0, settled: 0 }] }],
        seen: { completed: true }, ai: { providers: {}, snapshots: [], slots: {} } });
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', previousRuntimeId, 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: previousRuntimeId, ...identity, startedAt: state.startedAt });
    const incident = { reason: 'maintenance_wallet_balance_read_rejected', stop: structuredClone(state.stopped),
        hold: structuredClone(state.entryHolds.maintenance_wallet), continuousOperation: structuredClone(state.continuousOperation),
        previousRuntimeId, previousManifestSha256: hash(fs.readFileSync(manifestFile)), stateSha256: walletReadRecoveryStateDigest(state) };
    Object.assign(config.runtimeContinuation, { ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding),
        walletReadRecovery: incident });
    store.save();
    const f = { config, store, state, incident, dataDir, old, backup, manifestFile, calls: [], financialCalls: [],
        balance: 11.309365, healthBalance: 11.309365, positions: [], account: { orders: [], trades: [] },
        nonce: '0x2', safeNonce: 3, pendingNonce: '0x2', pendingSafeNonce: 3,
        providerReady: true, amounts: [0, 0], now: Date.now(), snapshots: 0, blockNumber: 123, blockHash };
    const financial = name => () => { f.financialCalls.push(name); throw new Error('financial_write_forbidden'); };
    f.client = {
        startBtcFeed() {}, serverTime: async () => { f.calls.push('time'); return Date.now(); },
        json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: f.healthBalance,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => f.positions,
        ordersAndTrades: async () => { f.calls.push('orders'); return f.account; },
        gasPriceUsd: async () => 1, confirmedBlock: async () => {
            f.snapshots++; f.client.rpc.anchor = { number: f.blockNumber, hash: f.blockHash }; return f.blockNumber;
        },
        balance: async () => f.balance, holdings: async (tokens, block) => {
            assert.equal(block, 123); f.calls.push(`holdings:${tokens.join(',')}`); return [...f.amounts];
        },
        verifiedReceipt: async () => { throw new Error('unexpected_incident_receipt'); },
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task, block) => {
            assert.equal(block, f.blockNumber);
            return task({ send: async (method, params) => {
                if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? f.pendingNonce : f.nonce;
                if (method === 'eth_call') return ethers.utils.defaultAbiCoder.encode(['uint256'],
                    [params[1] === 'pending' ? f.pendingSafeNonce : f.safeNonce]);
                if (method === 'eth_getBlockByNumber') return { hash: f.blockHash };
                throw new Error('unexpected_rpc');
            } });
        } },
        prepare: financial('prepare'), post: financial('post'), prepareAction: financial('prepareAction'),
        broadcastAction: financial('broadcastAction'), cancel: financial('cancel'),
        prepareProfitTransfer: financial('prepareProfitTransfer'),
    };
    f.providers = { preflight: async () => ({ eligible: { ready: f.providerReady, inferenceAttempted: false } }),
        predict: financial('predict') };
    f.prepare = () => prepareWalletReadRecovery(config, state, f.client, f.providers, { now: () => f.now });
    f.repin = () => { f.incident.stateSha256 = walletReadRecoveryStateDigest(state); };
    return f;
}

test('review proves fresh flat account and preserves every financial/history field without writes', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir), review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.walletPUSD, 11.309365); assert.equal(review.summary.financialWrites, false);
    assert.equal(review.summary.completedMarkets, 2); assert.equal(review.summary.filledMarkets, 1);
    assert.equal(review.nextState.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(review.nextState.continuousOperation.runtimeId, runtimeId);
    assert.deepEqual(review.nextState.stopHistory.at(-1).originalHold, before.entryHolds.maintenance_wallet);
    assert.equal(review.nextState.stopHistory.at(-1).walletProof.pendingSafeNonce, '3');
    assert.equal(review.nextState.stopHistory.at(-1).walletProof.holdingsProof.holdings.length, 2);
    assert.equal(f.snapshots, 2);
    assert.deepEqual(f.calls.filter(call => call.startsWith('holdings:') || call === 'orders'),
        ['orders', 'holdings:1,2', 'holdings:3,4', 'orders']);
    assert.throws(() => applyWalletReadRecovery(f.store, review), /unproven/);
    const ai = f.state.ai, completed = f.state.completed;
    applyWalletReadRecovery(f.store, review, { explicitApply: true });
    assert.equal(f.state.ai, ai); assert.equal(f.state.completed, completed);
    assert.deepEqual(f.state, { ...before, stopped: null, entryHolds: {}, stopHistory: review.nextState.stopHistory,
        continuousOperation: review.nextState.continuousOperation, continuousOperationHistory: review.nextState.continuousOperationHistory });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    assert.equal(eligibleReadiness({ config: f.config, state: f.state, history: eligibleHistory(f.config), operationalReady: true }).readyForLive, true);
    assert.throws(() => applyWalletReadRecovery(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('private approval binds finance, history, manifest and exact read incident before account reads', async t => {
    const changes = {
        'missing approval': f => { delete f.config.runtimeContinuation.walletReadRecovery; },
        'manual stop': f => { f.state.stopped.reason = 'manual_stop'; f.incident.stop = structuredClone(f.state.stopped); f.repin(); },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; f.repin(); },
        'wrong stage pinned': f => { f.state.entryHolds.maintenance_wallet.error.stage = 'safe_action_submit'; f.incident.hold = structuredClone(f.state.entryHolds.maintenance_wallet); f.repin(); },
        'wrong code pinned': f => { f.state.entryHolds.maintenance_wallet.error.code = 'transport_failed'; f.incident.hold = structuredClone(f.state.entryHolds.maintenance_wallet); f.repin(); },
        'hold changed': f => { f.state.entryHolds.maintenance_wallet.failedAt++; },
        'extra hold pinned': f => { f.state.entryHolds.clock = {}; f.repin(); },
        'position pinned': f => { f.state.position = {}; f.repin(); },
        'withdrawal pinned': f => { f.state.profitTaking = { pending: {} }; f.repin(); },
        'control operation pinned': f => { f.state.profitTakingControl = { operation: {} }; f.repin(); },
        'reconciliation pinned': f => { f.state.reconciliationFaults.unknown = {}; f.repin(); },
        'completed changed': f => { f.state.completed[0].pnl++; },
        'AI changed': f => { f.state.ai.slots.extra = {}; },
        'seen changed': f => { f.state.seen.extra = true; },
        'cash changed': f => { f.state.cash++; },
        'wallet changed': f => { f.state.walletCashDelta++; },
        'peak changed': f => { f.state.peakEquity++; },
        'drawdown changed': f => { f.state.maxDrawdown++; },
        'history changed': f => { f.state.stopHistory[0].recoveredAt++; },
        'unknown field changed': f => { f.state.futureAccounting = 1; },
        'marker changed': f => { f.state.continuousOperation.enabledAt++; },
        'runtime changed': f => { f.incident.previousRuntimeId = originalRuntimeId; },
        'manifest changed': f => { fs.appendFileSync(f.manifestFile, '\n'); },
        'policy mismatch': f => { f.config.policy.entryCap = 8; },
        'unknown action pinned': f => { f.state.completed[0].actions = [{ status: 'unknown' }]; f.repin(); },
        'unknown order pinned': f => { f.state.completed[0].orders[0].status = 'unknown'; f.repin(); },
        'historical backup changed': f => { fs.appendFileSync(f.backup, '\n'); },
        'already archived pinned': f => { f.state.stopHistory.push({ ...f.state.stopped }); f.repin(); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.financialCalls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
});

test('diagnostic cache updates before offline review preserve the private incident digest', async t => {
    const f = fixture(t), before = f.incident.stateSha256;
    Object.assign(f.state, { failures: 23, dataGaps: 14, events: 5, operational: { errors: {} },
        diagnostics: { decisions: 1 }, lastTickAt: stoppedAt + 100, lastHeartbeatAt: stoppedAt + 100 });
    f.state.liveClock.verifiedAt++;
    assert.equal(walletReadRecoveryStateDigest(f.state), before);
    f.store.save();
    const review = await f.prepare();
    assert.equal(review.nextState.failures, 23);
    const control = { schema: 1, policy: {}, operation: null, lastCheck: { at: 1 } };
    const initial = walletReadRecoveryStateDigest({ ...f.state, profitTakingControl: control });
    control.lastCheck.at++;
    assert.equal(walletReadRecoveryStateDigest({ ...f.state, profitTakingControl: control }), initial);
    control.operation = { stage: 'source_uncertain' };
    assert.notEqual(walletReadRecoveryStateDigest({ ...f.state, profitTakingControl: control }), initial);
});

test('fresh proof failures including refreshed global account state cannot recover', async t => {
    const changes = {
        'preflight wallet': f => { f.healthBalance++; },
        'wallet': f => { f.balance++; },
        'provider': f => { f.providerReady = false; },
        'open order': f => { f.account.orders.push({ id: 'unowned', conditionId }); },
        'inventory': f => { f.positions.push({ size: 1 }); },
        'token holdings': f => { f.amounts = [0, 1]; },
        'no-fill token holdings': f => { f.client.holdings = async tokens => tokens[0] === '3' ? [1, 0] : [0, 0]; },
        'pending signer': f => { f.pendingNonce = '0x3'; },
        'pending Safe': f => { f.pendingSafeNonce = 4; },
        'pending trade': f => { f.account.trades.push({ status: 'RETRYING' }); },
        'late order': f => { let reads = 0; f.client.ordersAndTrades = async () => ++reads === 1 ? f.account : { orders: [{}], trades: [] }; },
        'late trade': f => { let reads = 0; f.client.ordersAndTrades = async () => ++reads === 1 ? f.account : { orders: [], trades: [{ status: 'RETRYING' }] }; },
        'late inventory': f => { let reads = 0; f.client.positions = async () => ++reads === 1 ? [] : [{ size: 1 }]; },
        'final wallet changed': f => { let reads = 0; f.client.balance = async () => f.balance + (++reads === 2 ? 1 : 0); },
        'final signer pending': f => { f.client.holdings = async () => { f.pendingNonce = '0x3'; return [0, 0]; }; },
        'final signer completed write': f => { f.client.holdings = async () => { f.nonce = f.pendingNonce = '0x3'; return [0, 0]; }; },
        'final Safe completed write': f => { f.client.holdings = async () => { f.safeNonce = f.pendingSafeNonce = 4; return [0, 0]; }; },
        'final block regressed': f => { f.client.holdings = async () => { f.blockNumber = 122; return [0, 0]; }; },
        'final block changed hash': f => { f.client.holdings = async () => { f.blockHash = `0x${'a'.repeat(64)}`; return [0, 0]; }; },
        'final proof expired': f => { let reads = 0; f.client.balance = async () => { if (++reads === 2) f.now += 30001; return f.balance; }; },
        'invalid latest account': f => { let reads = 0; f.client.ordersAndTrades = async () => ++reads === 1 ? f.account : null; },
        'state mutated': f => { f.client.holdings = async () => { f.state.failures++; return [0, 0]; }; },
        'disk mutated': f => { f.client.holdings = async () => { atomicJson(f.store.filename, { ...f.state, failures: 5 }); return [0, 0]; }; },
        'approval mutated': f => { f.client.holdings = async () => { f.incident.stateSha256 = 'a'.repeat(64); return [0, 0]; }; },
        'configuration mutated': f => { f.client.holdings = async () => { f.config.settings.wallet = `0x${'a'.repeat(40)}`; return [0, 0]; }; },
        'anchor mutated': f => { f.client.holdings = async () => { f.client.rpc.anchor.hash = `0x${'a'.repeat(64)}`; return [0, 0]; }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); await assert.rejects(f.prepare);
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.stopHistory.length, 1); assert.deepEqual(f.financialCalls, []);
    });
});

test('apply rejects tampering, stale proof and wrong store and rolls back failed persistence', async t => {
    for (const name of ['state', 'draft', 'summary', 'forged', 'store', 'disk', 'manifest', 'approval', 'expired', 'clock reversed', 'save']) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare(), before = structuredClone(f.state);
        if (name === 'state') f.state.cash++;
        if (name === 'draft') review.nextState.cash++;
        if (name === 'summary') review.summary.walletPUSD++;
        if (name === 'disk') atomicJson(f.store.filename, { ...f.state, failures: 10 });
        if (name === 'manifest') fs.appendFileSync(f.manifestFile, '\n');
        if (name === 'approval') f.incident.reason = 'other';
        if (name === 'expired') f.now += 30001;
        if (name === 'clock reversed') f.now--;
        if (name === 'save') f.store.save = () => { throw new Error('disk_unavailable'); };
        const store = name === 'store' ? { state: structuredClone(f.state), save() {} } : f.store;
        assert.throws(() => applyWalletReadRecovery(store, name === 'forged' ? structuredClone(review) : review, { explicitApply: true }));
        if (name !== 'state') assert.deepEqual(f.state, before);
    });
});

test('final proof uses a newer confirmed block while preserving the earlier holdings evidence', async t => {
    const f = fixture(t);
    let reads = 0;
    f.client.ordersAndTrades = async () => {
        if (++reads === 2) { f.blockNumber = 124; f.blockHash = `0x${'a'.repeat(64)}`; }
        return f.account;
    };
    const review = await f.prepare(), walletProof = review.nextState.stopHistory.at(-1).walletProof;
    assert.equal(review.summary.blockNumber, 124);
    assert.equal(review.summary.blockHash, f.blockHash);
    assert.equal(walletProof.blockNumber, 124);
    assert.equal(walletProof.holdingsProof.blockNumber, 123);
    assert.equal(walletProof.holdingsProof.blockHash, blockHash);
    f.now += 30000;
    applyWalletReadRecovery(f.store, review, { explicitApply: true });
    assert.equal(f.state.stopped, null);
});
