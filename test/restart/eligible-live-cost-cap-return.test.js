import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { Store, atomicJson } from '../../src/restart/store.js';
import { bindRiskPeriod } from '../../src/eligible-live/period.js';
import { bindRuntimeContinuation, readEntryBufferPredecessor } from '../../src/eligible-live/continuation.js';
import { ELIGIBLE_BUFFER_POLICY } from '../../src/eligible-live/entry-buffer.js';
import { eligibleStrategySummary } from '../../src/eligible-live/strategy-epochs.js';
import { main, parseCostCapReturnArgs } from '../../scripts/eligible-return-cost-cap.js';
import { readEntryCostCapReturnPredecessor } from '../../src/eligible-live/continuation.js';
import { ExternalActivityReconciler } from '../../src/laya-live/external-activity.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { prepareEntryCostCapReturn, applyEntryCostCapReturn,
    entryCostCapReturnStateDigest } from '../../src/eligible-live/cost-cap-return.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;
const conditionId = `0x${'e'.repeat(64)}`, orderId = `0x${'f'.repeat(64)}`;
const stoppedAt = 1792898865801;

function files(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [file, hash(fs.readFileSync(file))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-buffer-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const policy = { provider: 'eligible', execution: { gasUsd: 0.02 } };
    const entryFilter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.85,
        gasUsd: 0.02, basis: 'full_fill_at_frozen_limit' };
    const originalIdentity = { policy, sources: [['src/original.js', 'b'.repeat(64)]], profitTaking: { enabled: false } };
    const originalRuntimeId = digest(originalIdentity).slice(0, 16);
    const currentIdentity = { policy: { ...policy, continuousTrading: true, entryFilter: { ...ELIGIBLE_BUFFER_POLICY } },
        sources: [['src/current.js', 'c'.repeat(64)]], profitTaking: originalIdentity.profitTaking };
    const runtimeId = digest(currentIdentity).slice(0, 16);
    let config = { ...currentIdentity, id: runtimeId, runtimeId, riskRuntimeId: originalRuntimeId,
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`, continuousTrading: true,
            fingerprint: runtimeId, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity },
        paperEvidence: { qualified: false }, ai: {} };
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
    const riskFile = path.join(riskRoot, periodId, 'record.json');
    atomicJson(riskFile, { periodId, ...payload });
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(old.filename, backup);
    config.runtimeContinuation = { schema: 1, reason: 'user_entry_buffer', runtimeId, originalRuntimeId, periodId,
        policyChange: { previousPolicySha256: digest(policy), currentPolicySha256: digest(config.policy) } };
    config = bindRiskPeriod(config);
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    const identity = { policy: { ...policy, continuousTrading: true, entryFilter },
        sources: [['src/previous.js', 'a'.repeat(64)]], profitTaking: config.profitTaking };
    const previousRuntimeId = digest(identity).slice(0, 16);
    Object.assign(state, { decisionProvider: 'eligible', startedAt: 1792739231020,
        cash: 1.74, peakEquity: 19.157402, maxDrawdown: 13.729814,
        walletStart: 12.920246, walletCashDelta: -11.180246, lastEquity: 1.74,
        liveFunding: { at: 1792739231020, initialCapital: 12.920246, allocation: 'available_balance' },
        stopped: null, reconciliationFaults: {}, entryHolds: {},
        continuousOperation: { enabledAt: 1792808581496, runtimeId: previousRuntimeId },
        stopHistory: [{ reason: 'trade_receipt_mapping_mismatch', at: 1792745454257, recoveredAt: 1792745554257 }],
        liveClock: { status: 'verified', verifiedAt: stoppedAt + 1000 },
        completed: [{ slug: 'completed', conditionId, tokens: ['1', '2'], traded: true, uncertain: false,
            pnl: .75, fees: .05, gas: 0, rebate: 0, entryCost: 4.25, closedAt: stoppedAt - 20000,
            payout: [0, 1], orders: [{ orderId, tokenId: '2', index: 1, side: 'BUY', status: 'complete', filled: 5, settled: 5 }] },
        { slug: 'no-fill', conditionId: `0x${'a'.repeat(64)}`, tokens: ['3', '4'], traded: false,
            pnl: 0, closedAt: stoppedAt - 10000, orders: [{ status: 'rejected', filled: 0, settled: 0 }] }],
        seen: { completed: true }, ai: { providers: {}, snapshots: [], slots: {} } });
    const epochIdentity = { periodId, runtimeId: previousRuntimeId, startedAt: stoppedAt - 30000,
        firstCompletedIndex: 1, firstSnapshotIndex: 0 };
    const epoch = { id: digest(epochIdentity).slice(0, 16), ...epochIdentity,
        policy: structuredClone(identity.policy), cashAtStart: 2, reason: 'user_entry_cost_cap' };
    state.strategyEpochs = [epoch]; state.currentStrategyEpochId = epoch.id;
    state.ai.snapshots.push({ snapshotId: 'cost-cap-snapshot', strategyEpochId: epoch.id });
    state.completed[1].entrySignal = { snapshotId: 'cost-cap-snapshot', strategyEpochId: epoch.id };
    const originalFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(originalFile, { id: periodId, ...originalIdentity, startedAt: state.startedAt });
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', previousRuntimeId, 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: previousRuntimeId, ...identity, startedAt: state.startedAt });
    Object.assign(config.runtimeContinuation, { ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding),
        originalManifestSha256: hash(fs.readFileSync(originalFile)), riskRecordSha256: hash(fs.readFileSync(riskFile)) });
    const previousContinuation = { ...structuredClone(config.runtimeContinuation), runtimeId: previousRuntimeId,
        reason: 'user_entry_cost_cap', policyChange: { previousPolicySha256: digest(policy), currentPolicySha256: digest(identity.policy) },
        entryCostCapMigration: { preservedApproval: 'original-reviewed-migration' },
        capitalDepositRevision: { preservedApproval: 'read-only-continuation' } };
    const migration = { continuousOperation: structuredClone(state.continuousOperation),
        previousRuntimeId, previousManifestSha256: hash(fs.readFileSync(manifestFile)),
        previousContinuation, previousContinuationSha256: digest(previousContinuation),
        stateSha256: entryCostCapReturnStateDigest(state) };
    Object.assign(config.runtimeContinuation, { ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding),
        entryBufferMigration: migration });
    store.save();
    const f = { config, store, state, migration, dataDir, old, backup, manifestFile, originalFile, originalRuntimeId,
        riskFile, runtimeId, previousRuntimeId, calls: [], financialCalls: [],
        balance: 1.74, healthBalance: 1.74, positions: [], account: { orders: [], trades: [] },
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
            return task({ getBlock: async number => ({ number, hash: blockHash }), send: async (method, params) => {
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
    const bufferApproval = structuredClone(config.runtimeContinuation), bufferId = config.runtimeId;
    const bufferManifest = path.join(dataDir, config.id, 'eligible-runtime', 'revisions', bufferId, 'manifest.json');
    atomicJson(bufferManifest, { id: config.id, runtimeId: bufferId, policy: config.policy, sources: config.sources,
        profitTaking: config.profitTaking, startedAt: state.startedAt });
    const bufferEpochIdentity = { periodId: config.id, runtimeId: bufferId, startedAt: stoppedAt - 5000,
        firstCompletedIndex: 2, firstSnapshotIndex: 1 };
    const bufferEpoch = { id: digest(bufferEpochIdentity).slice(0, 16), ...bufferEpochIdentity,
        policy: structuredClone(config.policy), cashAtStart: state.cash, reason: 'user_entry_buffer' };
    state.strategyEpochs.push(bufferEpoch); state.currentStrategyEpochId = bufferEpoch.id;
    state.continuousOperation.runtimeId = bufferId;
    config.policy = { ...config.policy, entryFilter };
    config.sources = [['src/return.js', 'e'.repeat(64)]];
    config.runtimeId = digest({ policy: config.policy, sources: config.sources, profitTaking: config.profitTaking }).slice(0, 16);
    config.runtimeContinuation = { ...bufferApproval, reason: 'user_return_cost_cap', runtimeId: config.runtimeId,
        policyChange: { previousPolicySha256: digest(policy), currentPolicySha256: digest(config.policy) } };
    delete config.runtimeContinuation.entryBufferMigration;
    config.runtimeContinuation.entryCostCapReturn = { previousRuntimeId: bufferId,
        previousManifestSha256: hash(fs.readFileSync(bufferManifest)), previousContinuation: bufferApproval,
        previousContinuationSha256: digest(bufferApproval), continuousOperation: structuredClone(state.continuousOperation),
        stateSha256: entryCostCapReturnStateDigest(state) };
    f.migration = config.runtimeContinuation.entryCostCapReturn;
    f.manifestFile = bufferManifest; f.runtimeId = config.runtimeId; f.previousRuntimeId = bufferId;
    store.save();
    f.prepare = () => prepareEntryCostCapReturn(config, state, f.client, f.providers, { now: () => f.now });
    f.repin = () => { f.migration.stateSha256 = entryCostCapReturnStateDigest(state); };
    return f;
}

function maintenance(f) {
    const epochContinuation = structuredClone(f.migration.previousContinuation);
    const epochContinuationText = JSON.stringify(epochContinuation, null, 2) + '\n';
    const epochManifestSha256 = f.migration.previousManifestSha256, epochId = f.previousRuntimeId;
    const prior = JSON.parse(fs.readFileSync(f.manifestFile));
    const identity = { policy: prior.policy, sources: [['src/maintenance.js', 'f'.repeat(64)]], profitTaking: prior.profitTaking };
    const runtimeId = digest(identity).slice(0, 16);
    f.manifestFile = path.join(f.dataDir, f.config.id, 'eligible-runtime', 'revisions', runtimeId, 'manifest.json');
    atomicJson(f.manifestFile, { id: f.config.id, runtimeId, ...identity, startedAt: f.state.startedAt });
    f.migration.previousContinuation.runtimeId = runtimeId;
    f.migration.previousContinuation.maintenanceRevision = { previousRuntimeId: epochId,
        previousContinuationSha256: hash(epochContinuationText), reason: 'automatic_separate_manual_accounting', at: stoppedAt };
    f.state.runtimeMaintenanceHistory = [{ at: stoppedAt + 1000, reason: 'automatic_separate_manual_accounting',
        previousRuntimeId: epochId, runtimeId, previousLedgerSha256: hash(fs.readFileSync(f.store.filename)), policyChanged: false }];
    f.state.continuousOperation.runtimeId = runtimeId;
    Object.assign(f.migration, { previousRuntimeId: runtimeId, previousManifestSha256: hash(fs.readFileSync(f.manifestFile)),
        previousContinuationSha256: digest(f.migration.previousContinuation), epochContinuationText, epochManifestSha256,
        continuousOperation: structuredClone(f.state.continuousOperation) });
    f.repin(); f.store.save();
}

function automaticInventory(f) {
    f.config.settings.automaticManualActivity = true;
    const receipt = `0x${'9'.repeat(64)}`;
    f.manualHoldings = { '1': 1.923077, '22': 2.040817 };
    f.state.externalWalletActivity = { cashDelta: 2, capitalAllocated: 0, zeroPayoutInventory: [],
        receipts: [{ hash: receipt, blockNumber: 110, blockHash, cash: 2,
            tokenIds: ['1', '22'], holdings: [1.923077, 2.040817] }],
        automatic: { schema: 1, checkpoint: { blockNumber: 123, blockHash },
            holdings: Object.entries(f.manualHoldings).map(([tokenId, amount]) => ({ tokenId, amount })) } };
    f.state.manualWalletRecoveryHistory = [{ reason: 'reviewed_manual_wallet_activity', reviewedAt: stoppedAt }];
    f.positions = [{ conditionId, tokenId: '1', size: 1.923 }, { conditionId, tokenId: '22', size: 2.0408 }];
    f.balance = f.healthBalance = 3.74;
    f.account.trades = [{ status: 'MATCHED', transactionHash: receipt }];
    f.client.holdings = async (tokens, block) => {
        assert.equal(block, 123); f.calls.push(`holdings:${tokens.join(',')}`);
        return tokens.map(token => f.manualHoldings[token] || 0);
    };
    f.repin(); f.store.save();
}

test('return continuation binds original risk period and verifies complete BUFFER predecessor', t => {
    const f = fixture(t); maintenance(f);
    const filename = path.join(f.dataDir, 'return.json'); atomicJson(filename, f.config.runtimeContinuation);
    const bound = bindRiskPeriod(bindRuntimeContinuation(f.config, { ELIGIBLE_LIVE_CONTINUATION: filename }));
    assert.equal(bound.id, f.config.id); assert.deepEqual(bound.riskPeriod, f.config.riskPeriod);
    assert.deepEqual(bound.runtimeContinuation.entryCostCapReturn.previousContinuation, f.migration.previousContinuation);
    assert.equal(readEntryCostCapReturnPredecessor(bound).runtimeId, f.migration.previousRuntimeId);
});

test('return appends a third epoch through verified maintenance and preserves every accounting field', async t => {
    const f = fixture(t); maintenance(f); automaticInventory(f);
    const before = structuredClone(f.state), disk = files(f.dataDir), review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.previousEpochsPreserved, 2);
    assert.equal(review.summary.financialWrites, false); assert.equal(review.summary.liveStarted, false);
    const epoch = review.nextState.strategyEpochs.at(-1);
    assert.equal(epoch.reason, 'user_return_cost_cap'); assert.equal(epoch.firstCompletedIndex, 2);
    assert.deepEqual(epoch.policy, f.config.policy);
    assert.equal(epoch.walletProof.externalInventoryProof.source, 'automatic_manual_ctf');
    assert.deepEqual(epoch.walletProof.holdingsProof.holdings[0].amounts, [1.923077, 0]);
    assert.equal(epoch.walletProof.trades.receiptConfirmed[0].source, 'known_receipt');
    assert.deepEqual(review.nextState.strategyEpochs.slice(0, -1), before.strategyEpochs);
    assert.throws(() => applyEntryCostCapReturn(f.store, review), /unproven/);
    const bytes = fs.readFileSync(f.store.filename), result = applyEntryCostCapReturn(f.store, review, { explicitApply: true });
    assert.deepEqual(fs.readFileSync(result.archivePath), bytes);
    assert.equal(fs.statSync(result.archivePath).mode & 0o777, 0o400);
    for (const key of Object.keys(before).filter(key => !['strategyEpochs', 'currentStrategyEpochId',
        'continuousOperation', 'continuousOperationHistory'].includes(key))) assert.deepEqual(f.state[key], before[key], key);
    assert.equal(f.state.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(f.state.continuousOperation.runtimeId, f.config.runtimeId);
    assert.equal(eligibleStrategySummary(f.state, f.config).current.completedAttempts, 0);
    assert.equal(eligibleStrategySummary(f.state, f.config).current.realizedPnl, 0);
    assert.deepEqual(f.financialCalls, []);
    assert.throws(() => applyEntryCostCapReturn(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('return validates direct BUFFER epoch without a maintenance bridge', async t => {
    const f = fixture(t), before = structuredClone(f.state), review = await f.prepare();
    assert.equal(review.nextState.strategyEpochs.length, 3);
    assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
});

test('return rejects changed approvals, maintenance evidence, stop guards and protected state before wallet reads', async t => {
    const changes = {
        'predecessor reason': f => { f.migration.previousContinuation.reason = 'user_entry_cost_cap'; },
        'previous manifest': f => { fs.appendFileSync(f.manifestFile, '\n'); },
        'original manifest': f => { fs.appendFileSync(f.originalFile, '\n'); },
        'risk record': f => { fs.appendFileSync(f.riskFile, '\n'); },
        'historical risk backup': f => { fs.appendFileSync(f.backup, '\n'); },
        'missing maintenance history': f => { delete f.state.runtimeMaintenanceHistory; },
        'changed maintenance policy': f => { f.state.runtimeMaintenanceHistory[0].policyChanged = true; },
        'changed maintenance origin': f => { f.state.runtimeMaintenanceHistory[0].previousRuntimeId = f.originalRuntimeId; },
        'reversed maintenance time': f => { f.state.runtimeMaintenanceHistory[0].at = 1; },
        'epoch continuation': f => { f.migration.epochContinuationText += '\n'; },
        'epoch manifest': f => { f.migration.epochManifestSha256 = '0'.repeat(64); },
        'missing epoch continuation': f => { delete f.migration.epochContinuationText; },
        'stop': f => { f.state.stopped = { reason: 'manual_signal', at: stoppedAt }; },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: stoppedAt }; },
        'frozen': f => { f.state.frozenAt = stoppedAt; },
        'position': f => { f.state.position = {}; },
        'entry hold': f => { f.state.entryHolds.clock = {}; },
        'reconciliation fault': f => { f.state.reconciliationFaults.wallet = {}; },
        'withdrawal': f => { f.state.profitTaking = { pending: {} }; },
        'withdrawal operation': f => { f.state.profitTakingControl = { operation: {} }; },
        'unknown order': f => { f.state.completed[0].orders[0].status = 'unknown'; },
        'pending trade': f => { f.state.completed[0].pendingTrades = true; },
        'policy drift': f => { f.config.policy.shares = 6; },
        'cost cap drift': f => { f.config.policy.entryFilter.maxCostPerShare = .86; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); maintenance(f); change(f); f.repin(); f.store.save();
        const before = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.calls, []); assert.deepEqual(f.financialCalls, []);
        assert.deepEqual(files(f.dataDir), before);
    });
});

test('return rechecks manual inventory, orders, pending writes and final proof freshness', async t => {
    const changes = {
        'unknown inventory': f => { f.positions.push({ tokenId: '99', size: 1 }); },
        'missing manual inventory': f => { f.positions.pop(); },
        'changed manual chain inventory': f => { f.manualHoldings['1']++; },
        'open manual order': f => { f.account.orders.push({ id: `0x${'a'.repeat(64)}`, tokenId: '22', conditionId,
            side: 'BUY', originalSize: 5, sizeMatched: 1, price: .4 }); },
        'pending manual trade': f => { f.account.trades = [{ status: 'MATCHED', transactionHash: `0x${'0'.repeat(64)}` }]; },
        'wallet mismatch': f => { f.balance++; },
        'pending nonce': f => { f.pendingNonce = '0x3'; },
        'pending safe nonce': f => { f.pendingSafeNonce++; },
        'late nonce': f => { const original = f.client.confirmedBlock;
            f.client.confirmedBlock = async () => { const result = await original();
                if (f.snapshots >= 3) f.nonce = f.pendingNonce = '0x3'; return result; }; },
        'final audit expired': f => { const original = f.client.ordersAndTrades; let reads = 0;
            f.client.ordersAndTrades = async () => { if (++reads === 2) f.now += 30001; return original(); }; },
        'late inventory': f => { let reads = 0; const original = f.client.positions;
            f.client.positions = async () => ++reads === 1 ? original() : [...f.positions, { tokenId: '99', size: 1 }]; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); automaticInventory(f); change(f);
        const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
        assert.deepEqual(f.financialCalls, []);
    });
});

test('return refuses unbooked manual activity even when the preflight preview succeeds', async t => {
    const f = fixture(t); automaticInventory(f);
    const original = ExternalActivityReconciler.prototype.proof;
    t.mock.method(ExternalActivityReconciler.prototype, 'proof', async function (...args) {
        const result = await original.apply(this, args);
        result.summary.receiptCount = 1;
        return result;
    });
    const before = structuredClone(f.state);
    await assert.rejects(f.prepare); assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
});

test('apply rejects expired proof and save failure restores the in-memory ledger', async t => {
    for (const expires of [false, true]) await t.test(String(expires), async t => {
        const f = fixture(t), before = structuredClone(f.state), review = await f.prepare();
        if (expires) f.now = review.summary.expiresAt + 1;
        else f.store.save = () => { throw new Error('save_failed'); };
        assert.throws(() => applyEntryCostCapReturn(f.store, review, { explicitApply: true }));
        assert.deepEqual(f.state, before); assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), before);
    });
});

test('return CLI defaults to review, holds the wallet lock and never starts live', async () => {
    assert.deepEqual(parseCostCapReturnArgs([]), { apply: false });
    for (const args of [['--live'], ['--reset'], ['--apply', '--apply']]) assert.throws(() => parseCostCapReturnArgs(args));
    for (const args of [[], ['--apply']]) {
        const calls = [], output = [], config = { id: 'period', runtimeId: 'runtime', settings: { dataDir: '/tmp/unused' }, ai: {} };
        await main(args, { loadConfig: () => config, acquireLock: async () => { calls.push('lock'); return () => calls.push('unlock'); },
            readHistory: () => [{ baseline: 'period', strategy: 'late-entry' }], storeFactory: () => ({ state: {} }),
            clientFactory: () => ({ close() { calls.push('close'); } }), providerFactory: () => ({ close() {} }),
            prepare: async () => { calls.push('review'); return { summary: { ready: true } }; },
            apply: () => { calls.push('apply'); return {}; }, write: row => output.push(row) });
        assert.deepEqual(calls, ['lock', 'review', ...(args.length ? ['apply'] : []), 'close', 'unlock']);
        assert.equal(output[0].liveStarted, false); assert.equal(output[0].financialWrites, false);
    }
});
