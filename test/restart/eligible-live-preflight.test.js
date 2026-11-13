import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { Store, atomicJson } from '../../src/restart/store.js';
import { reserveProfitWithdrawal, applyProfitWithdrawal } from '../../src/laya-live/profit-accounting.js';
import { eligibleHistory, previousLiveSummary, eligibleReadiness, eligiblePreflight,
    assertEligibleStartAllowed, enforceEligibleStartupGuards } from '../../src/eligible-live/preflight.js';

const id = '0011223344556677';
const priorId = '5ebbc4a6b2123135';
const recipient = `0x${'a'.repeat(40)}`;
const hash = value => `0x${value.repeat(64)}`;
const policy = { recipient, asset: 'pUSD', chainId: 137, chunkUsd: 5, retainUsd: 20, maxGasUsd: .01, maxFeeUsd: 0 };

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-preflight-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, fingerprint: id, drawdownStop: 10, pilotMarkets: Infinity,
        pilotHours: Infinity, dataDir, wallet: `0x${'b'.repeat(40)}` };
    const config = { id, settings, policy: { provider: 'eligible', capitalAllocation: 'available_balance' },
        profitTaking: { ...policy, enabled: false },
        paperEvidence: { qualified: false, reasons: ['no_matching_eligible_paper_evidence'] } };
    const store = new Store(settings, 'pilot', 'late-entry');
    store.logger = () => {};
    Object.assign(store.state, { decisionProvider: 'eligible', liveFunding: { initialCapital: 20 },
        walletStart: 20, walletCashDelta: 0 });
    return { config, store, dataDir };
}

function priorLedger(f, changes = {}) {
    const old = new Store({ ...f.config.settings, fingerprint: priorId }, 'pilot', 'late-entry');
    old.logger = () => {};
    Object.assign(old.state, { decisionProvider: 'laya', walletStart: 20, walletCashDelta: -.814458,
        cash: 19.185542, peakEquity: 29.771903, maxDrawdown: 10.586361,
        completed: [{ traded: true, pnl: -.814458, fees: 0, gas: 0 }],
        stopped: { reason: 'drawdown_limit', at: 12345 },
        liveRiskStop: { reason: 'drawdown_limit', at: 12345 }, ...changes });
    old.save();
    return old;
}

function position() { return { market: { slug: 'owned-market' }, holdings: [5, 0], orders: [{ orderId: 'owned', status: 'complete' }] }; }
function control(stage = 'address_ready') {
    return { schema: 1, policy, operation: { id: 'withdrawal:1', stage, createdAt: 12345 } };
}
function readClient({ balance = 20, orders = [] } = {}) {
    let mutations = 0, requests = 0;
    const financialWrite = () => { mutations++; throw new Error('financial_write_forbidden'); };
    const client = {
        startBtcFeed() {}, serverTime: async () => { requests++; return Date.now(); }, json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => [], ordersAndTrades: async () => ({ orders, trades: [] }), gasPriceUsd: async () => 1,
        prepare: financialWrite, post: financialWrite, prepareAction: financialWrite, broadcastAction: financialWrite,
        prepareProfitTransfer: financialWrite, cancel: financialWrite,
    };
    const providers = { preflight: async () => ({ eligible: { ready: true, inferenceAttempted: false } }),
        predict: financialWrite };
    return { client, providers, get mutations() { return mutations; }, get requests() { return requests; } };
}

test('another identity cannot bypass an existing drawdown stop or hide its report', t => {
    const f = fixture(t), old = priorLedger(f), before = fs.readFileSync(old.filename);
    const history = eligibleHistory(f.config);
    const result = eligibleReadiness({ config: f.config, state: f.store.state, history, operationalReady: true });
    assert.equal(result.readyForLive, false); assert.equal(result.startAllowed, false);
    for (const code of ['existing_pilot_history_requires_original_period', 'previous_live_pilot_stop',
        'previous_live_risk_stop', 'previous_live_drawdown_stop']) assert.ok(result.blockers.includes(code));
    const previous = previousLiveSummary(f.config, history);
    assert.equal(previous.found, true); assert.equal(previous.stopped, true); assert.equal(previous.liveRiskStop, true);
    assert.equal(previous.netTradingPnl, -.814458); assert.equal(previous.periods[0].baseline, priorId);
    assert.equal(previous.periods[0].maxDrawdown, 10.586361); assert.equal(previous.periods[0].cash, 19.185542);
    assert.equal(previous.periods[0].positionOpen, false); assert.equal(previous.periods[0].withdrawalPending, false);
    assert.deepEqual(fs.readFileSync(old.filename), before);
    assert.throws(() => assertEligibleStartAllowed({ explicitLive: true, config: f.config,
        state: f.store.state, history, operationalReady: true }), /existing_pilot_history/);
    assert.equal(fs.existsSync(f.store.filename), false);
});

test('prior inventory and control-only withdrawals block fresh and recovery starts', t => {
    const f = fixture(t);
    for (const changes of [{ position: position() }, { profitTakingControl: control() },
        { profitTakingControl: control('address_requested') }, { profitTakingControl: control('source_uncertain') },
        { profitTakingControl: control('in_transit') }]) {
        const old = priorLedger(f, { stopped: null, liveRiskStop: null, maxDrawdown: 0, ...changes });
        const history = eligibleHistory(f.config), previous = previousLiveSummary(f.config, history);
        const result = eligibleReadiness({ config: f.config, state: { ...f.store.state, position: position() },
            history, operationalReady: false });
        assert.equal(result.startAllowed, false); assert.equal(result.recoveryOnly, false);
        assert.ok(result.blockers.includes(changes.position ? 'previous_live_inventory_open' : 'previous_live_profit_withdrawal_pending'));
        assert.equal(previous.periods[0][changes.position ? 'positionOpen' : 'withdrawalPending'], true);
        assert.equal(old.state.profitTaking?.pending, undefined);
    }
});

test('own inventory can reconcile through a durable stop without clearing any risk history', t => {
    const f = fixture(t);
    Object.assign(f.store.state, { position: position(), stopped: { reason: 'drawdown_limit', at: 12345 },
        liveRiskStop: { reason: 'drawdown_limit', at: 12345 }, maxDrawdown: 10.586361 });
    const before = structuredClone(f.store.state);
    const result = enforceEligibleStartupGuards(f.store, { explicitLive: true, config: f.config,
        history: [], operationalReady: false });
    assert.equal(result.readyForLive, false); assert.equal(result.startAllowed, true); assert.equal(result.recoveryOnly, true);
    assert.ok(result.blockers.includes('persistent_live_drawdown_stop'));
    assert.deepEqual(f.store.state, before); assert.equal(fs.existsSync(f.store.filename), false);
    f.store.state.position = null;
    assert.equal(eligibleReadiness({ config: f.config, state: f.store.state, history: [], operationalReady: true }).startAllowed, false);
    assert.throws(() => assertEligibleStartAllowed({ explicitLive: false, config: f.config,
        state: f.store.state, history: [], operationalReady: true }), /explicit_live/);
});

test('history retains own risk latches even if the caller omits or replaces current state', t => {
    const f = fixture(t), prior = { ...f.store.state, stopped: { reason: 'drawdown_limit' }, maxDrawdown: 10.5 };
    for (const state of [undefined, f.store.state]) {
        const result = eligibleReadiness({ config: f.config, state, history: [prior], operationalReady: true });
        assert.equal(result.startAllowed, false); assert.ok(result.blockers.includes('persistent_pilot_stop'));
        assert.ok(result.blockers.includes('persistent_live_drawdown_stop'));
    }
});

test('read-only preflight does not allocate capital, save ledgers, infer or submit', async t => {
    const f = fixture(t), mock = readClient({ balance: .465657 });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected_network'); });
    const before = fs.readdirSync(f.dataDir);
    const result = await eligiblePreflight(f.config, mock.client, mock.providers);
    assert.equal(result.output.operationalReady, true); assert.equal(result.output.readyForLive, true);
    assert.equal(result.output.inferenceAttempted, false); assert.equal(result.output.automaticActivation, false);
    assert.equal(result.output.requiredBalance, 0); assert.equal(result.output.shortfall, 0);
    assert.equal(result.output.balance, .465657); assert.equal(result.output.allocatedCapital, .465657);
    assert.deepEqual(result.output.paperEvidence, f.config.paperEvidence);
    assert.equal(mock.mutations, 0); assert.deepEqual(fs.readdirSync(f.dataDir), before);
});

test('preflight reconciles actual wallet cash after a distribution without rebasing capital', async t => {
    const f = fixture(t);
    Object.assign(f.store.state, { cash: 31, peakEquity: 31, walletCashDelta: 11,
        completed: [{ traded: true, pnl: 11, fees: .02, gas: .001, uncertain: false }] });
    const reserved = reserveProfitWithdrawal(f.store.state, policy, { id: 'withdrawal:1', hash: hash('1'),
        createdAt: 2000, openOrders: [], gasReserveUsd: .01, feeReserveUsd: 0, walletBalance: 31 });
    const state = applyProfitWithdrawal(reserved, { id: 'withdrawal:1', hash: hash('1'), recipient,
        asset: 'pUSD', amountUsd: 5, status: 'confirmed', tokenDebitUsd: 5, gasUsd: .006, feeUsd: 0,
        blockNumber: 123, blockHash: hash('c') });
    state.profitTakingControl = { schema: 1, policy, operation: null };
    const before = structuredClone(state), mock = readClient({ balance: 26 });
    const result = await eligiblePreflight(f.config, mock.client, mock.providers, state, { history: [state] });
    const check = result.output.checks.find(row => row.name === 'wallet_ledger_reconciliation');
    assert.equal(check.ok, true); assert.equal(check.detail.expectedPUSD, 26);
    assert.equal(result.output.readyForLive, true); assert.equal(result.output.allocatedCapital, 20);
    assert.equal(result.output.profitTaking.totalPUSDDebited, 5);
    assert.equal(result.output.previousLive.found, false);
    assert.deepEqual(state, before); assert.equal(mock.mutations, 0); assert.equal(fs.existsSync(f.store.filename), false);
    const mismatch = readClient({ balance: 27 });
    const rejected = await eligiblePreflight(f.config, mismatch.client, mismatch.providers, state, { history: [state] });
    assert.equal(rejected.output.readyForLive, false);
    assert.equal(rejected.output.checks.find(row => row.name === 'wallet_ledger_reconciliation').error.code, 'wallet_ledger_mismatch');
    assert.deepEqual(state, before);
});

test('corrupt or misidentified history fails before any preflight account request', async t => {
    const f = fixture(t), old = priorLedger(f), mock = readClient();
    const valid = structuredClone(old.state);
    const corruptions = [
        '{broken-json', JSON.stringify({ ...valid, baseline: 'another' }),
        JSON.stringify({ ...valid, completed: [{ traded: true, pnl: null }] }),
        JSON.stringify({ ...valid, profitTaking: {} }),
        JSON.stringify({ ...valid, profitTakingControl: control('unknown_stage') }),
        JSON.stringify({ ...valid, externalWalletActivity: { cashDelta: 1, receipts: [] } }),
    ];
    for (const contents of corruptions) {
        fs.writeFileSync(old.filename, contents);
        assert.throws(() => eligibleHistory(f.config));
        await assert.rejects(eligiblePreflight(f.config, mock.client, mock.providers));
        assert.equal(mock.requests, 0); assert.equal(mock.mutations, 0);
    }
    fs.writeFileSync(old.filename, JSON.stringify(valid));
    const own = { ...f.store.state, decisionProvider: 'laya' };
    atomicJson(f.store.filename, own);
    assert.throws(() => eligibleHistory(f.config), /live_ledger_identity_mismatch/);
});

test('provider readiness and unowned orders still block eligible entry', async t => {
    const f = fixture(t), mock = readClient({ orders: [{ id: 'unowned', conditionId: 'condition' }] });
    mock.providers.preflight = async () => ({ eligible: { ready: false }, laya: { ready: true } });
    const result = await eligiblePreflight(f.config, mock.client, mock.providers);
    assert.equal(result.output.readyForLive, false); assert.equal(result.output.operationalReady, false);
    assert.ok(result.output.blockers.includes('live_preflight_blocked'));
    assert.equal(result.output.checks.find(row => row.name === 'unowned_open_orders').ok, false);
    assert.equal(mock.mutations, 0);
});
