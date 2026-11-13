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
import { eligibleHistory, eligiblePreflight, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { prepareSignalRecovery, applySignalRecovery } from '../../src/eligible-live/signal-recovery.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;
const runtimeId = '8899aabbccddeeff', originalRuntimeId = '0011223344556677';
const slotKey = 'btc-updown-5m-1700000000:90';
const stoppedAt = 1700000210643;

function files(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [file, hash(fs.readFileSync(file))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-signal-recovery-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let config = { id: runtimeId, runtimeId, riskRuntimeId: originalRuntimeId,
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`,
            fingerprint: runtimeId, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity },
        policy: { provider: 'eligible' }, profitTaking: { enabled: false }, paperEvidence: { qualified: false }, ai: {} };
    const old = new Store({ ...config.settings, fingerprint: 'aabbccddeeff0011' }, 'pilot', 'late-entry');
    Object.assign(old.state, { startedAt: 1000, walletStart: 20, walletCashDelta: 0,
        stopped: { reason: 'drawdown_limit', at: 2000 }, maxDrawdown: 10 });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = { schema: 1, runtimeId: originalRuntimeId, dataDir, wallet, drawdownStop: 10,
        policySha256: digest(config.policy), profitTakingSha256: digest(config.profitTaking),
        createdAt: 3000, nonce: 'd'.repeat(64), openingBalance: 12.920246,
        acknowledgment: 'manual_new_risk_period', automaticActivation: false, approvedHistory: [pin] };
    const periodId = digest(payload).slice(0, 16), riskRoot = path.join(dataDir, 'eligible-risk-periods', originalRuntimeId);
    atomicJson(path.join(riskRoot, periodId, 'record.json'), { periodId, ...payload });
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(old.filename, backup);
    config = bindRiskPeriod(config);
    const store = new Store(config.settings, 'pilot', 'late-entry');
    const state = store.state;
    Object.assign(state, { decisionProvider: 'eligible', startedAt: 1699990000000,
        cash: 13.66961, peakEquity: 16.910045, maxDrawdown: 5.756046999999999,
        walletStart: 12.920246, walletCashDelta: .797062, lastEquity: 13.66961,
        liveFunding: { at: 1699990000000, initialCapital: 12.920246, allocation: 'available_balance' },
        stopped: { reason: 'operational_check_failed', at: stoppedAt }, entryHolds: {}, reconciliationFaults: {},
        stopHistory: [{ reason: 'trade_receipt_mapping_mismatch', at: 1699991000000,
            recoveredAt: 1699992000000, reasonVerified: 'verified_fill_fee_above_estimate' }],
        liveClock: { status: 'verified', verifiedAt: stoppedAt + 1000 },
        completed: Array.from({ length: 6 }, (_, i) => ({ slug: `completed-${i}`, conditionId: `condition-${i}`,
            tokens: [String(2 * i + 1), String(2 * i + 2)], traded: true, uncertain: false,
            pnl: .1, fees: .01, gas: .001, closedAt: 1699993000000 + i * 300000 })),
        seen: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`completed-${i}`, true])),
        ai: { sourceExperiment: 'deterministic-eligible-v1', providers: {}, snapshots: [],
            slots: { [slotKey]: { at: stoppedAt - 390, status: 'invalid',
                preparationTiming: { startedAt: stoppedAt - 357, readyAt: stoppedAt - 120 } } } } });
    const incident = { reason: 'btc_twap_source_mismatch', stop: structuredClone(state.stopped), slotKey,
        slotSha256: digest(state.ai.slots[slotKey]), completedSha256: digest(state.completed),
        seenSha256: digest(state.seen), aiSha256: digest(state.ai) };
    config.runtimeContinuation = { reason: 'pre_entry_signal_repair', runtimeId, originalRuntimeId, periodId,
        ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding), incident };
    store.save();
    const f = { config, store, state, incident, dataDir, old, backup, calls: [], financialCalls: [],
        balance: 13.717308, healthBalance: 13.717308, positions: [], account: { orders: [], trades: [] },
        pendingNonce: '0x2', pendingSafeNonce: 3, providerReady: true, amounts: [0, 0] };
    const financial = name => () => { f.financialCalls.push(name); throw new Error('financial_write_forbidden'); };
    f.client = {
        startBtcFeed() {}, serverTime: async () => { f.calls.push('time'); return Date.now(); },
        json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: f.healthBalance,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => f.positions, ordersAndTrades: async () => f.account,
        gasPriceUsd: async () => 1, confirmedBlock: async () => 123,
        balance: async block => { assert.equal(block, 123); return f.balance; },
        holdings: async (tokens, block) => { f.calls.push(['holdings', tokens, block]); return f.amounts; },
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task, block) => {
            assert.equal(block, 123);
            return task({ send: async (method, params) => {
                if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? f.pendingNonce : '0x2';
                if (method === 'eth_call') return ethers.utils.defaultAbiCoder.encode(['uint256'],
                    [params[1] === 'pending' ? f.pendingSafeNonce : 3]);
                if (method === 'eth_getBlockByNumber') return { hash: blockHash };
                throw new Error('unexpected_rpc');
            } });
        } },
        prepare: financial('prepare'), post: financial('post'), prepareAction: financial('prepareAction'),
        broadcastAction: financial('broadcastAction'), cancel: financial('cancel'),
        prepareProfitTransfer: financial('prepareProfitTransfer'),
    };
    f.providers = { preflight: async () => ({ eligible: { ready: f.providerReady, inferenceAttempted: false } }),
        predict: financial('predict') };
    f.prepare = () => prepareSignalRecovery(config, state, f.client, f.providers);
    return f;
}

test('signal review is read-only and proves the original wallet, history and completed token holdings', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir);
    const result = await f.prepare();
    assert.equal(result.summary.ready, true);
    assert.equal(result.summary.walletPUSD, 13.717308);
    assert.equal(result.summary.cash, 13.66961);
    assert.equal(result.summary.maxDrawdown, before.maxDrawdown);
    assert.equal(result.summary.financialWrites, false);
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    assert.deepEqual(f.financialCalls, []);
    assert.deepEqual(f.calls.filter(call => Array.isArray(call)), before.completed.map(row => ['holdings', row.tokens, 123]));
    const proof = result.nextState.stopHistory.at(-1);
    assert.equal(proof.reasonVerified, 'btc_twap_source_mismatch');
    assert.equal(proof.beforeSha256, digest(before));
    assert.equal(proof.walletProof.pendingNonce, proof.walletProof.confirmedNonce);
    assert.equal(proof.walletProof.pendingSafeNonce, proof.walletProof.safeNonce);
    assert.equal(proof.walletProof.holdings.length, 6);
    assert.deepEqual(proof.stop, undefined);
});

test('unreviewed incidents, changed accounting, pending work and risk latches fail before network reads', async t => {
    const changes = {
        'missing approval': f => { delete f.config.runtimeContinuation; },
        'wrong repair': f => { f.config.runtimeContinuation.reason = 'receipt_fee_estimate_repair'; },
        'wrong incident': f => { f.incident.reason = 'invalid_server_clock'; },
        'wrong runtime': f => { f.config.runtimeId = 'a'.repeat(16); },
        'wrong risk namespace': f => { f.config.riskRuntimeId = runtimeId; },
        'wrong period': f => { f.config.id = 'a'.repeat(16); },
        'different stop': f => { f.state.stopped.at++; },
        'different stop reason': f => { f.state.stopped.reason = 'drawdown_limit'; },
        'funding changed': f => { f.state.liveFunding.initialCapital++; },
        'completed changed': f => { f.state.completed[0].pnl++; },
        'seen changed': f => { f.state.seen.extra = true; },
        'ai changed': f => { f.state.ai.snapshots.push({}); },
        'slot changed': f => { f.state.ai.slots[slotKey].status = 'reserved'; },
        'slot admitted': f => { f.state.ai.slots[slotKey].snapshotId = 'snapshot'; },
        'market reserved': f => { f.state.seen[slotKey.split(':')[0]] = true; },
        'position exists': f => { f.state.position = {}; },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; },
        'historical drawdown': f => { f.state.maxDrawdown = 10; },
        'current drawdown': f => { f.state.peakEquity = f.state.cash + 10; },
        'no capital': f => { f.state.cash = 0; },
        'entry hold': f => { f.state.entryHolds.clock = {}; },
        'fault': f => { f.state.reconciliationFaults.wallet_ledger_mismatch = {}; },
        'withdrawal': f => { f.state.profitTaking = { pending: {} }; },
        'withdrawal operation': f => { f.state.profitTakingControl = { operation: {} }; },
        'failed clock': f => { f.state.liveClock.status = 'failed'; },
        'provider pending': f => { f.state.ai.providers.eligible = { pending: {} }; },
        'provider disabled': f => { f.state.ai.providers.eligible = { disabled: 'unknown' }; },
        'unsettled completed': f => { f.state.completed[0].pendingTrades = true; },
        'missing tokens': f => { delete f.state.completed[0].tokens; },
        'already archived': f => { f.state.stopHistory.push({ ...f.state.stopped }); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare, /eligible_signal_recovery_unproven/);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.financialCalls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
});

test('preflight, wallet, nonce, inventory and anchor failures cannot produce recovery', async t => {
    const changes = {
        'preflight wallet mismatch': f => { f.healthBalance++; },
        'anchored wallet mismatch': f => { f.balance++; },
        'provider unavailable': f => { f.providerReady = false; },
        'open order': f => { f.account.orders.push({ id: 'unowned', conditionId: 'condition' }); },
        'inventory': f => { f.positions.push({ size: 1 }); },
        'completed token holding': f => { f.amounts = [0, 1]; },
        'malformed token holding': f => { f.amounts = [0, null]; },
        'pending signer transaction': f => { f.pendingNonce = '0x3'; },
        'pending Safe transaction': f => { f.pendingSafeNonce = 4; },
        'pending trade': f => { f.account.trades.push({ status: 'RETRYING' }); },
        'anchor moved': f => { f.client.holdings = async () => {
            f.client.rpc.anchor.hash = `0x${'e'.repeat(64)}`; return [0, 0];
        }; },
        'state changed during reads': f => { f.client.holdings = async () => { f.state.failures++; return [0, 0]; }; },
        'disk changed during reads': f => { f.client.holdings = async () => {
            atomicJson(f.store.filename, { ...f.state, failures: 1 }); return [0, 0];
        }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f);
        await assert.rejects(f.prepare);
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.stopHistory.length, 1);
        assert.deepEqual(f.financialCalls, []);
    });
});

test('historical ledger and backup pins remain enforced before account reads', async t => {
    for (const name of ['ledger', 'backup']) await t.test(name, async t => {
        const f = fixture(t);
        fs.appendFileSync(name === 'ledger' ? f.old.filename : f.backup, '\n');
        await assert.rejects(f.prepare, /history_changed|archive_changed/);
        assert.deepEqual(f.calls, []);
    });
});

test('explicit application archives only the reviewed stop and preserves object references and every other field', async t => {
    const f = fixture(t), before = structuredClone(f.state), stateRef = f.state, aiRef = f.state.ai;
    const disk = files(f.dataDir), review = await f.prepare();
    assert.throws(() => applySignalRecovery(f.store, review), /eligible_signal_recovery_unproven/);
    assert.deepEqual(files(f.dataDir), disk);
    let saves = 0;
    const save = f.store.save.bind(f.store);
    f.store.save = () => { saves++; save(); };
    applySignalRecovery(f.store, review, { explicitApply: true });
    assert.equal(saves, 1); assert.equal(f.store.state, stateRef); assert.equal(f.store.state.ai, aiRef);
    assert.deepEqual(f.state, { ...before, stopped: null, stopHistory: review.nextState.stopHistory });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    assert.deepEqual(f.state.stopHistory.slice(0, -1), before.stopHistory);
    assert.throws(() => applySignalRecovery(f.store, review, { explicitApply: true }), /eligible_signal_recovery_unproven/);
    await assert.rejects(f.prepare, /eligible_signal_recovery_unproven/);
    const history = eligibleHistory(f.config);
    const ready = eligibleReadiness({ config: f.config, state: f.state, history, operationalReady: true });
    assert.equal(ready.readyForLive, true); assert.equal(ready.otherPilotHistory, false);
    const after = files(f.dataDir);
    const checked = await eligiblePreflight(f.config, f.client, f.providers, f.state, { history });
    assert.equal(checked.output.readyForLive, true);
    assert.deepEqual(files(f.dataDir), after); assert.deepEqual(f.financialCalls, []);
});

test('apply rejects changed or forged reviews and restores memory when atomic save fails', async t => {
    for (const name of ['state', 'state and pin', 'draft', 'summary', 'forged', 'save']) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare();
        if (name === 'state') f.state.cash++;
        if (name === 'state and pin') { f.state.liveRiskStop = { reason: 'drawdown_limit' };
            review.beforeSha256 = digest(f.state); }
        if (name === 'draft') review.nextState.peakEquity++;
        if (name === 'summary') review.summary.walletPUSD++;
        if (name === 'save') f.store.save = () => { throw new Error('disk_unavailable'); };
        const before = structuredClone(f.state), disk = files(f.dataDir);
        assert.throws(() => applySignalRecovery(f.store, name === 'forged' ? structuredClone(review) : review,
            { explicitApply: true }), /eligible_signal_recovery_unproven|disk_unavailable/);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
});
