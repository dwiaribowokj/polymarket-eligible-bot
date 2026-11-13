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
import { prepareEntryCostCapMigration, applyEntryCostCapMigration,
    entryCostCapMigrationStateDigest } from '../../src/eligible-live/cost-cap-migration.js';

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
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-cost-cap-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const policy = { provider: 'eligible', execution: { gasUsd: 0.02 } };
    const entryFilter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.85,
        gasUsd: 0.02, basis: 'full_fill_at_frozen_limit' };
    let config = { id: runtimeId, runtimeId, riskRuntimeId: originalRuntimeId,
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`, continuousTrading: true,
            fingerprint: runtimeId, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity },
        policy: { ...policy, continuousTrading: true, entryFilter }, profitTaking: { enabled: false }, paperEvidence: { qualified: false }, ai: {} };
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
    config.runtimeContinuation = { reason: 'user_entry_cost_cap', runtimeId, originalRuntimeId, periodId,
        policyChange: { previousPolicySha256: digest(policy), currentPolicySha256: digest(config.policy) } };
    config = bindRiskPeriod(config);
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    const identity = { policy: { ...policy, continuousTrading: true }, sources: [['src/previous.js', 'a'.repeat(64)]], profitTaking: config.profitTaking };
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
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', previousRuntimeId, 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: previousRuntimeId, ...identity, startedAt: state.startedAt });
    const migration = { continuousOperation: structuredClone(state.continuousOperation),
        previousRuntimeId, previousManifestSha256: hash(fs.readFileSync(manifestFile)),
        stateSha256: entryCostCapMigrationStateDigest(state) };
    Object.assign(config.runtimeContinuation, { ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding),
        entryCostCapMigration: migration });
    store.save();
    const f = { config, store, state, migration, dataDir, old, backup, manifestFile, calls: [], financialCalls: [],
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
    f.prepare = () => prepareEntryCostCapMigration(config, state, f.client, f.providers, { now: () => f.now });
    f.repin = () => { f.migration.stateSha256 = entryCostCapMigrationStateDigest(state); };
    return f;
}

test('read-only review allows a low wallet balance and starts a separate epoch without financial reset', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir), review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.walletPUSD, 1.74); assert.equal(review.summary.financialWrites, false);
    assert.equal(review.summary.completedMarkets, 2); assert.equal(review.summary.filledMarkets, 1);
    assert.equal(review.nextState.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(review.nextState.continuousOperation.runtimeId, runtimeId);
    const epoch = review.nextState.strategyEpochs[0];
    assert.equal(epoch.id, review.nextState.currentStrategyEpochId);
    assert.deepEqual(epoch.policy, f.config.policy);
    assert.equal(epoch.firstCompletedIndex, 2); assert.equal(epoch.firstSnapshotIndex, 0);
    assert.equal(epoch.walletProof.holdingsProof.holdings.length, 2);
    assert.equal(f.snapshots, 2);
    assert.deepEqual(f.calls.filter(call => call.startsWith('holdings:') || call === 'orders'),
        ['orders', 'holdings:1,2', 'holdings:3,4', 'orders']);
    assert.throws(() => applyEntryCostCapMigration(f.store, review), /unproven/);
    const ai = f.state.ai, completed = f.state.completed, originalBytes = fs.readFileSync(f.store.filename);
    const result = applyEntryCostCapMigration(f.store, review, { explicitApply: true });
    assert.equal(f.state.ai, ai); assert.equal(f.state.completed, completed);
    assert.deepEqual(f.state, { ...before, strategyEpochs: review.nextState.strategyEpochs,
        currentStrategyEpochId: epoch.id, continuousOperation: review.nextState.continuousOperation,
        continuousOperationHistory: review.nextState.continuousOperationHistory });
    assert.deepEqual(fs.readFileSync(result.archivePath), originalBytes);
    assert.equal(result.archiveSha256, hash(originalBytes));
    assert.equal(fs.statSync(result.archivePath).mode & 0o777, 0o400);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    assert.equal(eligibleReadiness({ config: f.config, state: f.state, history: eligibleHistory(f.config), operationalReady: true }).readyForLive, true);
    assert.throws(() => applyEntryCostCapMigration(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('migration refuses stops, pending work, policy drift and protected ledger changes before account reads', async t => {
    const changes = {
        'missing approval': f => { delete f.config.runtimeContinuation.entryCostCapMigration; },
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
        'runtime changed': f => { f.migration.previousRuntimeId = originalRuntimeId; },
        'manifest changed': f => { fs.appendFileSync(f.manifestFile, '\n'); },
        'policy cap mismatch': f => { f.config.policy.entryFilter.maxCostPerShare = .86; },
        'gas mismatch': f => { f.config.policy.entryFilter.gasUsd = 0; },
        'basis mismatch': f => { f.config.policy.entryFilter.basis = 'top_ask'; },
        'extra policy field': f => { f.config.policy.entryFilter.extra = true; },
        'unknown action pinned': f => { f.state.completed[0].actions = [{ status: 'unknown' }]; f.repin(); },
        'unknown order pinned': f => { f.state.completed[0].orders[0].status = 'unknown'; f.repin(); },
        'uncertain completion pinned': f => { f.state.completed[0].uncertain = true; f.repin(); },
        'historical backup changed': f => { fs.appendFileSync(f.backup, '\n'); },
        'already activated pinned': f => { f.state.strategyEpochs = [{ id: 'a'.repeat(16) }]; f.repin(); },
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
        assert.throws(() => applyEntryCostCapMigration(f.store, review, { explicitApply: true }));
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
    const f = fixture(t), before = structuredClone(f.state), review = await f.prepare();
    assert.throws(() => applyEntryCostCapMigration(f.store, structuredClone(review), { explicitApply: true }), /unproven/);
    f.store.save = () => { throw new Error('disk_failed'); };
    assert.throws(() => applyEntryCostCapMigration(f.store, review, { explicitApply: true }), /disk_failed/);
    assert.deepEqual(f.state, before);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), before);
});

test('archive refuses symlinks and preserves ledger before mutation', async t => {
    const f = fixture(t), review = await f.prepare(), before = structuredClone(f.state);
    const target = path.join(f.dataDir, 'unexpected'); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(f.dataDir, f.config.id, 'eligible-runtime', 'entry-cost-cap-migration'));
    assert.throws(() => applyEntryCostCapMigration(f.store, review, { explicitApply: true }), /unproven/);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readdirSync(target), []);
});
