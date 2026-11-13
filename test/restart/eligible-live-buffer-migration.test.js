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
import { main, parseBufferMigrationArgs } from '../../scripts/eligible-migrate-buffer.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { prepareEntryBufferMigration, applyEntryBufferMigration,
    entryBufferMigrationStateDigest } from '../../src/eligible-live/buffer-migration.js';

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
        stateSha256: entryBufferMigrationStateDigest(state) };
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
    f.prepare = () => prepareEntryBufferMigration(config, state, f.client, f.providers, { now: () => f.now });
    f.repin = () => { f.migration.stateSha256 = entryBufferMigrationStateDigest(state); };
    return f;
}

function addMaintenanceRevision(f) {
    const oldRuntimeId = f.migration.previousRuntimeId, oldManifest = f.manifestFile;
    const previous = JSON.parse(fs.readFileSync(oldManifest));
    const identity = { policy: previous.policy, sources: [['src/maintenance.js', 'd'.repeat(64)]],
        profitTaking: previous.profitTaking };
    const runtimeId = digest(identity).slice(0, 16);
    f.manifestFile = path.join(f.dataDir, f.config.id, 'eligible-runtime', 'revisions', runtimeId, 'manifest.json');
    atomicJson(f.manifestFile, { id: f.config.id, runtimeId, ...identity, startedAt: f.state.startedAt });
    f.state.continuousOperationHistory = [{ ...f.state.continuousOperation, migratedAt: stoppedAt,
        nextRuntimeId: runtimeId, previousManifestSha256: hash(fs.readFileSync(oldManifest)),
        reasonVerified: 'automatic_capital_deposits', beforeSha256: digest(f.state) }];
    f.state.continuousOperation.runtimeId = runtimeId;
    Object.assign(f.migration, { previousRuntimeId: runtimeId,
        previousManifestSha256: hash(fs.readFileSync(f.manifestFile)),
        continuousOperation: structuredClone(f.state.continuousOperation) });
    f.migration.previousContinuation.runtimeId = runtimeId;
    f.migration.previousContinuation.runtimeMaintenance = { previousRuntimeId: oldRuntimeId,
        reason: 'automatic_capital_deposits' };
    f.migration.previousContinuationSha256 = digest(f.migration.previousContinuation);
    f.repin(); f.store.save();
    return oldManifest;
}

function addExternalInventory(f) {
    const conditionId = `0x${'7'.repeat(64)}`, hash = `0x${'8'.repeat(64)}`;
    const approved = { conditionId, slug: 'manual-losing-market', tokens: ['11', '22'],
        amounts: [0, 2.040817], payout: [1, 0], receiptHashes: [hash] };
    f.state.externalWalletActivity = { reviewedAt: f.now - 1000, cashDelta: -1.0357,
        receipts: [{ hash, blockNumber: 100, blockHash, cash: -1.0357, tokenIds: ['22'], holdings: [2.040817] }],
        zeroPayoutInventory: [approved] };
    f.balance = f.healthBalance = .7043;
    f.positions = [{ conditionId, tokenId: '22', size: 2.0408, redeemable: true }];
    const abi = new ethers.utils.Interface([
        'function getOutcomeSlotCount(bytes32) view returns (uint256)',
        'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
        'function getPositionId(address,bytes32) view returns (uint256)',
        'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    ]);
    const read = f.client.rpc.read;
    f.client.rpc.read = (stage, task, block) => stage === 'eligible_external_inventory_market' ? task({
        _isProvider: true, resolveName: async name => name, call: async (transaction, tag) => {
            assert.equal(tag, block);
            const { name, args } = abi.parseTransaction(transaction);
            const value = name === 'getOutcomeSlotCount' ? 2 : name === 'getCollectionId'
                ? ethers.utils.hexZeroPad(args[2].toHexString(), 32) : Number(BigInt(args[1])) * 11;
            return abi.encodeFunctionResult(name, [value]);
        },
    }) : read(stage, task, block);
    const log = abi.encodeEventLog(abi.getEvent('TransferSingle'),
        [wallet, ethers.constants.AddressZero, wallet, '22', '2040817']);
    f.client.verifiedReceipt = async (transactionHash, block) => {
        assert.equal(transactionHash, hash); f.calls.push(`external_receipt:${block}`);
        return { transactionHash, blockNumber: 100, blockHash, status: 1, confirmations: 24,
            logs: [{ address: CONTRACTS.conditionalTokens, logIndex: 1, ...log }] };
    };
    const holdings = f.client.holdings;
    f.externalAmounts = [0, 2.040817]; f.payout = [1, 0];
    f.client.holdings = (tokens, block) => tokens[0] === '11' ? [...f.externalAmounts] : holdings(tokens, block);
    f.client.payoutAtBlock = async () => f.payout;
    f.repin(); f.store.save();
}

test('buffer continuation verifies the original risk anchor and full cost-cap predecessor without clearing stops', t => {
    const f = fixture(t), file = path.join(f.dataDir, 'buffer-continuation.json');
    f.state.stopped = { reason: 'wallet_ledger_mismatch', at: stoppedAt }; f.repin(); f.store.save();
    atomicJson(file, f.config.runtimeContinuation);
    const before = files(f.dataDir);
    const bound = bindRiskPeriod(bindRuntimeContinuation(f.config, { ELIGIBLE_LIVE_CONTINUATION: file }));
    assert.equal(bound.id, f.config.id); assert.equal(bound.riskRuntimeId, f.originalRuntimeId);
    assert.deepEqual(bound.riskPeriod, f.config.riskPeriod);
    assert.deepEqual(bound.runtimeContinuation.entryBufferMigration.previousContinuation, f.migration.previousContinuation);
    assert.equal(Object.isFrozen(bound.runtimeContinuation.entryBufferMigration.previousContinuation), true);
    assert.equal(eligibleReadiness({ config: bound, history: eligibleHistory(bound), operationalReady: true }).readyForLive, false);
    assert.deepEqual(files(f.dataDir), before);
});

test('continuation rejects changed predecessor identity, sources, policy, risk pins and unsafe revision paths', async t => {
    const changes = {
        'approval runtime': f => { f.migration.previousContinuation.runtimeId = f.originalRuntimeId; },
        'approval reason': f => { f.migration.previousContinuation.reason = 'user_continuous_trading'; },
        'approval origin': f => { f.migration.previousContinuation.originalRuntimeId = f.runtimeId; },
        'approval funding': f => { f.migration.previousContinuation.fundingSha256 = 'e'.repeat(64); },
        'approval ledger start': f => { f.migration.previousContinuation.ledgerStartedAt++; },
        'risk bytes': f => { fs.appendFileSync(f.riskFile, '\n'); },
        'original bytes': f => { fs.appendFileSync(f.originalFile, '\n'); },
        'manifest runtime': f => { const m = JSON.parse(fs.readFileSync(f.manifestFile)); m.runtimeId = f.runtimeId; atomicJson(f.manifestFile, m); },
        'manifest sources': f => { const m = JSON.parse(fs.readFileSync(f.manifestFile)); m.sources[0][0] = '../unsafe.js'; atomicJson(f.manifestFile, m); },
        'manifest source hash': f => { const m = JSON.parse(fs.readFileSync(f.manifestFile)); m.sources[0][1] = 'f'.repeat(64); atomicJson(f.manifestFile, m); },
        'manifest policy': f => { const m = JSON.parse(fs.readFileSync(f.manifestFile)); m.policy.entryFilter.maxCostPerShare = .86; atomicJson(f.manifestFile, m); },
        'revision symlink': f => { const target = f.manifestFile + '.target'; fs.renameSync(f.manifestFile, target); fs.symlinkSync(target, f.manifestFile); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, t => {
        const f = fixture(t); change(f);
        f.migration.previousManifestSha256 = hash(fs.readFileSync(f.manifestFile));
        f.migration.previousContinuationSha256 = digest(f.migration.previousContinuation);
        const before = files(f.dataDir);
        assert.throws(() => readEntryBufferPredecessor(f.config));
        assert.deepEqual(files(f.dataDir), before);
    });
});

test('a cost-cap epoch survives verified maintenance revisions before the buffer migration', async t => {
    const f = fixture(t); addMaintenanceRevision(f);
    const before = structuredClone(f.state), review = await f.prepare();
    assert.deepEqual(review.nextState.strategyEpochs[0], before.strategyEpochs[0]);
    assert.deepEqual(review.nextState.continuousOperationHistory.slice(0, -1), before.continuousOperationHistory);
    assert.equal(review.nextState.strategyEpochs.at(-1).previousRuntimeId, f.migration.previousRuntimeId);
    assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
});

test('maintenance history cannot bridge an unknown runtime or changed policy into the new epoch', async t => {
    const changes = {
        'missing chain': f => { f.state.continuousOperationHistory = []; },
        'broken edge': f => { f.state.continuousOperationHistory[0].nextRuntimeId = f.originalRuntimeId; },
        'unknown origin': f => { f.state.continuousOperationHistory[0].runtimeId = f.originalRuntimeId; },
        'reversed clock': f => { f.state.continuousOperationHistory[0].migratedAt = 1; },
        'manifest pin': f => { f.state.continuousOperationHistory[0].previousManifestSha256 = 'f'.repeat(64); },
        'changed original manifest': (f, file) => { fs.appendFileSync(file, '\n'); },
        'repeated edge': f => { f.state.continuousOperationHistory.push(structuredClone(f.state.continuousOperationHistory[0])); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t), file = addMaintenanceRevision(f); change(f, file); f.repin(); f.store.save();
        const before = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.calls, []); assert.deepEqual(files(f.dataDir), before);
    });
});

test('read-only review appends BUFFER after cost-cap while preserving funding, losses and every prior epoch', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir), review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.walletPUSD, 1.74); assert.equal(review.summary.financialWrites, false);
    assert.equal(review.summary.completedMarkets, 2); assert.equal(review.summary.filledMarkets, 1);
    assert.equal(review.nextState.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(review.nextState.continuousOperation.runtimeId, f.runtimeId);
    assert.deepEqual(review.nextState.strategyEpochs.slice(0, -1), before.strategyEpochs);
    const epoch = review.nextState.strategyEpochs.at(-1);
    assert.equal(epoch.id, review.nextState.currentStrategyEpochId);
    assert.deepEqual(epoch.policy, f.config.policy);
    assert.equal(epoch.firstCompletedIndex, 2); assert.equal(epoch.firstSnapshotIndex, 1);
    assert.equal(epoch.previousStrategyEpochId, before.currentStrategyEpochId);
    assert.equal(epoch.walletProof.holdingsProof.holdings.length, 2);
    assert.equal(f.snapshots, 2);
    assert.deepEqual(f.calls.filter(call => call.startsWith('holdings:') || call === 'orders'),
        ['orders', 'holdings:1,2', 'holdings:3,4', 'orders']);
    assert.throws(() => applyEntryBufferMigration(f.store, review), /unproven/);
    const ai = f.state.ai, completed = f.state.completed, originalBytes = fs.readFileSync(f.store.filename);
    const result = applyEntryBufferMigration(f.store, review, { explicitApply: true });
    assert.equal(f.state.ai, ai); assert.equal(f.state.completed, completed);
    assert.deepEqual(f.state, { ...before, strategyEpochs: review.nextState.strategyEpochs,
        currentStrategyEpochId: epoch.id, continuousOperation: review.nextState.continuousOperation,
        continuousOperationHistory: review.nextState.continuousOperationHistory });
    assert.deepEqual(fs.readFileSync(result.archivePath), originalBytes);
    assert.equal(result.archiveSha256, hash(originalBytes));
    assert.equal(fs.statSync(result.archivePath).mode & 0o777, 0o400);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    const summary = eligibleStrategySummary(f.state, f.config);
    assert.equal(summary.current.completedAttempts, 0); assert.equal(summary.current.realizedPnl, 0);
    assert.equal(summary.epochs[0].completedAttempts, 1);
    assert.equal(eligibleReadiness({ config: f.config, state: f.state, history: eligibleHistory(f.config), operationalReady: true }).readyForLive, true);
    assert.throws(() => applyEntryBufferMigration(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('buffer migration preserves reviewed zero-payout external inventory with fresh final-block evidence', async t => {
    const f = fixture(t); addExternalInventory(f);
    const before = structuredClone(f.state), filesBefore = files(f.dataDir), confirmed = f.client.confirmedBlock;
    f.client.confirmedBlock = async () => { if (f.snapshots === 1) f.blockNumber = 124; return confirmed(); };
    const review = await f.prepare(), proof = review.nextState.strategyEpochs.at(-1).walletProof;
    assert.equal(proof.blockNumber, 124); assert.equal(proof.externalInventoryProof.blockNumber, 124);
    assert.deepEqual(proof.externalInventoryProof.inventory[0].holdings, [0, 2.040817]);
    assert.deepEqual(proof.excludedLegacyInventory, f.positions);
    assert.deepEqual(f.calls.filter(call => call.startsWith('external_receipt:')), ['external_receipt:123', 'external_receipt:124']);
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), filesBefore);
    applyEntryBufferMigration(f.store, review, { explicitApply: true });
    assert.deepEqual(f.state.externalWalletActivity, before.externalWalletActivity);
    assert.equal(f.state.cash, before.cash); assert.equal(f.state.peakEquity, before.peakEquity);
    assert.equal(f.state.maxDrawdown, before.maxDrawdown); assert.deepEqual(f.state.completed, before.completed);
    assert.deepEqual(f.financialCalls, []);
});

test('external inventory changes and slow final reproof cannot consume the migration freshness window', async t => {
    const changes = {
        'winning payout': f => { f.payout = [0, 1]; },
        'bot balance remains nonzero': f => { f.amounts = [0, .1]; },
        'unknown inventory': f => { f.positions.push({ tokenId: '99', size: 1 }); },
        'pending manual trade': f => { f.account.trades = [{ conditionId: f.positions[0].conditionId, status: 'MATCHED' }]; },
        'late inventory increase': f => { const read = f.client.confirmedBlock;
            f.client.confirmedBlock = async () => { const block = await read();
                if (f.snapshots === 2) f.externalAmounts[1]++; return block; }; },
        'final external proof exceeds thirty seconds': f => { const read = f.client.verifiedReceipt; let count = 0;
            f.client.verifiedReceipt = async (...args) => { if (++count === 2) f.now += 30001; return read(...args); }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); addExternalInventory(f); change(f); const before = structuredClone(f.state);
        await assert.rejects(f.prepare); assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    });
});

test('migration refuses stops, pending work, policy drift and protected ledger changes before account reads', async t => {
    const changes = {
        'missing approval': f => { delete f.config.runtimeContinuation.entryBufferMigration; },
        'pilot stop pinned': f => { f.state.stopped = { reason: 'operational_check_failed', at: stoppedAt }; f.repin(); },
        'risk stop pinned': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; f.repin(); },
        'hold pinned': f => { f.state.entryHolds.clock = {}; f.repin(); },
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
        'runtime changed': f => { f.migration.previousRuntimeId = f.originalRuntimeId; },
        'manifest changed': f => { fs.appendFileSync(f.manifestFile, '\n'); },
        'policy threshold mismatch': f => { f.config.policy.entryFilter.minBufferSigma = .9; },
        'cost cap retained': f => { f.config.policy.entryFilter.maxCostPerShare = .85; },
        'closing proof disabled': f => { f.config.policy.entryFilter.requireObservedClosing = false; },
        'extra policy field': f => { f.config.policy.entryFilter.extra = true; },
        'unknown action pinned': f => { f.state.completed[0].actions = [{ status: 'unknown' }]; f.repin(); },
        'unknown order pinned': f => { f.state.completed[0].orders[0].status = 'unknown'; f.repin(); },
        'uncertain completion pinned': f => { f.state.completed[0].uncertain = true; f.repin(); },
        'historical backup changed': f => { fs.appendFileSync(f.backup, '\n'); },
        'invalid existing epoch pinned': f => { f.state.strategyEpochs = [{ id: 'a'.repeat(16) }]; f.repin(); },
        'missing current epoch pinned': f => { delete f.state.currentStrategyEpochId; f.repin(); },
        'previous epoch changed pinned': f => { f.state.strategyEpochs[0].policy.entryFilter.maxCostPerShare = .86; f.repin(); },
        'previous approval changed': f => { f.migration.previousContinuation.capitalDepositRevision = {}; },
        'previous policy changed and repinned': f => { f.migration.previousContinuation.policyChange.currentPolicySha256 = 'e'.repeat(64);
            f.migration.previousContinuationSha256 = digest(f.migration.previousContinuation); },
        'wallet mismatch stop pinned': f => { f.state.stopped = { reason: 'wallet_ledger_mismatch', at: stoppedAt }; f.repin(); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); f.store.save(); const before = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.calls, []);
        assert.deepEqual(f.financialCalls, []); assert.deepEqual(files(f.dataDir), before);
    });
});

test('fresh proof rejects inventory, API writes, nonce changes, balance changes and provider failures', async t => {
    const changes = {
        inventory: f => { f.positions = [{ size: 1 }]; },
        orders: f => { f.account.orders = [{ id: 'open' }]; },
        'pending trade': f => { f.account.trades = [{ id: 'pending', status: 'MATCHED' }]; },
        holdings: f => { f.amounts = [0, .1]; },
        nonce: f => { f.pendingNonce = '0x3'; },
        'safe nonce': f => { f.pendingSafeNonce++; },
        balance: f => { f.balance++; },
        'health balance': f => { f.healthBalance++; },
        'provider unavailable': f => { f.providerReady = false; },
        'full audit expired': f => { const holdings = f.client.holdings;
            f.client.holdings = async (...args) => { f.now += 600001; return holdings(...args); }; },
        'final account proof expired': f => { const orders = f.client.ordersAndTrades; let reads = 0;
            f.client.ordersAndTrades = async () => { if (++reads === 2) f.now += 31000; return orders(); }; },
        'final chain proof expired': f => { const confirmedBlock = f.client.confirmedBlock;
            f.client.confirmedBlock = async () => { const block = await confirmedBlock();
                if (f.snapshots === 2) f.now += 31000; return block; }; },
        'clock reversed during audit': f => { const holdings = f.client.holdings;
            f.client.holdings = async (...args) => { f.now--; return holdings(...args); }; },
        'late nonce': f => {
            const original = f.client.confirmedBlock;
            f.client.confirmedBlock = async () => { const block = await original();
                if (f.snapshots === 2) f.nonce = f.pendingNonce = '0x3'; return block; };
        },
        'late position': f => {
            let reads = 0; f.client.positions = async () => ++reads === 1 ? [] : [{ size: 1 }];
        },
        'late orders': f => {
            let reads = 0; f.client.ordersAndTrades = async () => ++reads === 1
                ? { orders: [], trades: [] } : { orders: [{ id: 'new' }], trades: [] };
        },
        'old history changed during read': f => {
            f.client.holdings = async () => { fs.appendFileSync(f.old.filename, '\n'); return [0, 0]; };
        },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state);
        await assert.rejects(f.prepare); assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    });
});

test('a long historical audit receives a fresh apply window only after renewed account and chain proof', async t => {
    const f = fixture(t), auditStartedAt = f.now, before = structuredClone(f.state);
    const preflight = f.providers.preflight, holdings = f.client.holdings;
    f.providers.preflight = async () => { f.now += 60000; return preflight(); };
    f.client.holdings = async (...args) => { f.now += 20000; return holdings(...args); };
    const review = await f.prepare();
    assert.equal(review.summary.verificationStartedAt, auditStartedAt);
    assert.equal(review.summary.finalVerificationStartedAt, auditStartedAt + 100000);
    assert.equal(review.summary.verifiedAt, auditStartedAt + 100000);
    assert.equal(review.summary.expiresAt, auditStartedAt + 130000);
    assert.equal(f.snapshots, 2);
    assert.deepEqual(f.calls.filter(call => call.startsWith('holdings:') || call === 'orders'),
        ['orders', 'holdings:1,2', 'holdings:3,4', 'orders']);
    assert.deepEqual(f.state, before); assert.deepEqual(f.financialCalls, []);
    f.now += 29000;
    applyEntryBufferMigration(f.store, review, { explicitApply: true });
    assert.equal(f.state.strategyEpochs.length, 2);
    assert.equal(f.state.cash, before.cash);
});

test('apply refuses stale, forged or changed reviews and restores memory when save fails', async t => {
    const changes = {
        expired: (f, review) => { f.now = review.summary.expiresAt + 1; },
        'clock reversed': (f, review) => { f.now = review.summary.verifiedAt - 1; },
        'next state changed': (_f, review) => { review.nextState.cash++; },
        'summary changed': (_f, review) => { review.summary.cash++; },
        'memory changed': f => { f.state.cash++; },
        'disk changed': f => { const altered = structuredClone(f.state); altered.cash++; atomicJson(f.store.filename, altered); },
        'manifest changed': f => { fs.appendFileSync(f.manifestFile, '\n'); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare(); change(f, review);
        const before = structuredClone(f.state), disk = files(f.dataDir);
        assert.throws(() => applyEntryBufferMigration(f.store, review, { explicitApply: true }));
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
    const f = fixture(t), before = structuredClone(f.state), review = await f.prepare();
    assert.throws(() => applyEntryBufferMigration(f.store, structuredClone(review), { explicitApply: true }), /unproven/);
    f.store.save = () => { throw new Error('disk_failed'); };
    assert.throws(() => applyEntryBufferMigration(f.store, review, { explicitApply: true }), /disk_failed/);
    assert.deepEqual(f.state, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), before);
});

test('archive refuses symlinks and preserves ledger before mutation', async t => {
    const f = fixture(t), review = await f.prepare(), before = structuredClone(f.state);
    const target = path.join(f.dataDir, 'unexpected'); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(f.dataDir, f.config.id, 'eligible-runtime', 'entry-buffer-migration'));
    assert.throws(() => applyEntryBufferMigration(f.store, review, { explicitApply: true }), /unproven/);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readdirSync(target), []);
});

test('buffer CLI defaults to review, requires exact apply and releases the lock without starting live', async () => {
    assert.deepEqual(parseBufferMigrationArgs([]), { apply: false });
    for (const args of [['--live'], ['--reset'], ['--apply', '--apply']]) assert.throws(() => parseBufferMigrationArgs(args));
    for (const args of [[], ['--apply']]) {
        const events = [], output = [], config = { id: 'period', runtimeId: 'runtime', settings: { dataDir: '/tmp/test-buffer' }, ai: {} };
        const store = { state: {} }, review = { summary: { ready: true } };
        const dependencies = { loadConfig: () => config, acquireLock: async (_dir, mode) => {
            assert.equal(mode, 'pilot'); events.push('lock'); return async () => events.push('release'); },
            readHistory: () => [{ baseline: config.id, strategy: 'late-entry' }], storeFactory: () => store,
            clientFactory: () => ({ close() { events.push('client_close'); } }),
            providerFactory: () => ({ close() { events.push('provider_close'); } }),
            prepare: async () => { events.push('proof'); return review; },
            apply: (s, r, options) => { assert.equal(s, store); assert.equal(r, review); assert.equal(options.explicitApply, true);
                events.push('apply'); return {}; }, write: row => output.push(row) };
        assert.equal(await main(args, dependencies), 0);
        assert.deepEqual(events, ['lock', 'proof', ...(args.length ? ['apply'] : []), 'provider_close', 'client_close', 'release']);
        assert.equal(output[0].liveStarted, false); assert.equal(output[0].financialWrites, false);
        assert.equal(output[0].automaticActivation, false); assert.equal(output[0].applied, args.length > 0);
    }
});
