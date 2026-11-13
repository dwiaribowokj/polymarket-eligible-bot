import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASELINE } from '../../src/restart/config.js';
import { LiveBroker } from '../../src/restart/live.js';
import { atomicJson } from '../../src/restart/store.js';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { entryGuard } from '../../src/laya-live/engine.js';
import { liveReadiness, enforceStartupGuards } from '../../src/laya-live/preflight.js';
import { loadLiveConfig, liveConfigView } from '../../src/laya-live/config.js';
import { readOnlyLiveClient } from '../../src/laya-live/diagnostic.js';
import { expectedWalletBalance, bindContinuation } from '../../src/laya-live/recovery.js';
import { loadProfitTakingConfig, profitTakingReport } from '../../src/laya-live/profit-taking.js';
import { distributionAdjustedCash, reserveProfitWithdrawal, applyProfitWithdrawalSource,
    applyProfitWithdrawalDestination } from '../../src/laya-live/profit-accounting.js';

// Pure accounting plus mocked reads; no environment files, signing or network.
const recipient = `0x${'a'.repeat(40)}`, otherRecipient = `0x${'e'.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const now = 1800000000000;
const policy = { recipient, asset: 'USDC', chunkUsd: 5, retainUsd: 20 };
const profitConfig = () => loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient });
const pnl = value => ({ traded: true, pnl: value, fees: .02, gas: .001, uncertain: false });

function stateFixture() {
    return { baseline: 'integration-profit-period', startedAt: now - 1000, mode: 'pilot', strategy: 'late-entry',
        decisionProvider: 'laya', cash: 26, peakEquity: 26, maxDrawdown: 0, stopped: null, position: null,
        liveFunding: { initialCapital: 20 }, walletStart: 20, walletCashDelta: 6,
        completed: [pnl(6)], seen: {}, failures: 0 };
}

function reserve(state = stateFixture(), id = 'withdrawal:1', transactionHash = hash('1')) {
    return reserveProfitWithdrawal(state, policy, { id, hash: transactionHash, createdAt: now,
        gasReserveUsd: .01, feeReserveUsd: .00004, openOrders: [], walletBalance: 100 });
}

function source(state = reserve(), id = 'withdrawal:1', transactionHash = hash('1')) {
    return applyProfitWithdrawalSource(state, { id, hash: transactionHash, recipient, asset: 'USDC', amountUsd: 5,
        status: 'confirmed', tokenDebitUsd: 5, gasUsd: .006, feeUsd: 0, blockNumber: 100, blockHash: hash('b') });
}

function delivered(state = source()) {
    return applyProfitWithdrawalDestination(state, { id: 'withdrawal:1', sourceHash: hash('1'), hash: hash('2'),
        recipient, asset: 'USDC', receivedUsd: 4.999960, blockNumber: 102, blockHash: hash('c') });
}

function entryFixture(state = stateFixture()) {
    const settings = { ...BASELINE, paperGasUsd: .05 };
    const config = { settings, ai: { decisionMs: 3000, dataAgeMs: 5000, capital: 20, shares: 5, entryCap: 5,
        gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings } };
    const market = { slug: 'market', conditionId: 'condition', open: now - 210000, end: now + 90000,
        accepting: true, tokens: ['up', 'down'], minimum: 5, tick: .01, ticks: [.01, .01],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const spec = { index: 0, tokenId: 'up', price: .79, snapshotPrice: .78, shares: 5, side: 'BUY', kind: 'taker' };
    const snapshot = { snapshotId: 'snapshot', at: now - 2600, observedAt: now - 3000, decisionReceivedAt: now,
        validation: { at: now - 2600, generation: 1, identity: metadataIdentity(market) }, allowed: [spec] };
    const decision = { snapshotId: 'snapshot', model: 'typed-decisions', action: 'BUY_UP', status: 'ok' };
    const books = [{ bids: [{ price: .77, size: 10 }], asks: [{ price: .78, size: 10 }] },
        { bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] }];
    return { now, state, settings, config, market, spec, snapshot, decision, books };
}

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-profit-integration-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('wallet expectation follows gross source debits once, independently of native gas and net destination fees', () => {
    assert.equal(expectedWalletBalance(stateFixture()), 26);
    assert.equal(expectedWalletBalance(reserve()), 26);
    const inTransit = source();
    assert.equal(inTransit.cash, 25.994);
    assert.equal(expectedWalletBalance(inTransit), 21);
    const completed = delivered(inTransit);
    assert.equal(completed.cash, 25.993960);
    assert.equal(expectedWalletBalance(completed), 21);
    const restarted = JSON.parse(JSON.stringify(completed));
    assert.equal(expectedWalletBalance(restarted), 21);
    restarted.completed.push(pnl(6)); restarted.cash = 31.993960; restarted.walletCashDelta = 12;
    const second = source(reserve(restarted, 'withdrawal:2', hash('3')), 'withdrawal:2', hash('3'));
    assert.equal(second.profitTaking.totalTokenDebited, 10);
    assert.equal(expectedWalletBalance(second), 22);
    second.externalWalletActivity = { cashDelta: 7.125, receipts: [{ hash: hash('9'), cash: 7.125 }], capitalAllocated: 0 };
    assert.equal(expectedWalletBalance(second), 29.125);
    const corrupt = structuredClone(second); corrupt.profitTaking.totalTokenDebited = 5;
    assert.throws(() => expectedWalletBalance(corrupt), /invalid_profit_taking_ledger/);
});

test('Laya wallet reads use the profit ledger without external activity and stop on a real mismatch', async t => {
    t.mock.method(LiveBroker.prototype, 'checkWallet', async () => { throw new Error('legacy_wallet_path_must_not_run'); });
    for (const state of [source(), delivered()]) {
        assert.equal(state.externalWalletActivity, undefined);
        const calls = [], events = [];
        let actual = 21;
        const store = { state, save() {}, event(type, detail) { events.push({ type, ...detail }); },
            stop(reason) { state.stopped ||= { reason, at: now }; } };
        const client = { async confirmedBlock() { calls.push('block'); return 200; },
            async balance(block) { calls.push(['balance', block]); return actual; } };
        const broker = new LayaLiveBroker(BASELINE, store, client, async () => {});
        assert.equal(await broker.readWallet(), true);
        assert.deepEqual(calls, ['block', ['balance', 200]]);
        assert.equal(state.stopped, null);
        actual = 26;
        assert.equal(await broker.readWallet(), false);
        assert.equal(state.stopped.reason, 'wallet_ledger_mismatch');
        assert.deepEqual(events.at(-1), { type: 'wallet_mismatch', expectedPUSD: 21, actualPUSD: 26 });
    }
});

test('entry guard uses spendable cash after distributions while preserving historical cash', () => {
    const state = delivered();
    assert.doesNotThrow(() => entryGuard(entryFixture(state)));
    // A later trading loss leaves cash=8 in the total-return account, but only
    // 3.000040 is still spendable after the previous distribution.
    state.completed.push(pnl(-17.993960)); state.cash = 8;
    assert.equal(distributionAdjustedCash(state), 3.000040);
    assert.throws(() => entryGuard(entryFixture(state)), /entry_budget_exceeded/);
    assert.equal(state.cash, 8);
    assert.doesNotThrow(() => entryGuard(entryFixture({ ...state, profitTaking: undefined })));
});

test('entry guard blocks every persisted withdrawal stage before inference or entry validation', () => {
    for (const state of [reserve(), source(), { ...stateFixture(),
        profitTakingControl: { operation: { stage: 'address_ready' } } }]) {
        // Deliberately invalid input proves the pending veto happens first.
        assert.throws(() => entryGuard({ state }), /profit_withdrawal_pending/);
    }
});

test('flat pending withdrawals permit recovery without clearing risk stops or conflicting-history guards', () => {
    const state = source(); state.stopped = { reason: 'drawdown_limit', at: now };
    const before = structuredClone(state), context = { operationalReady: false, otherHistory: false };
    const readiness = liveReadiness({ ...context, state });
    assert.equal(readiness.readyForLive, false);
    assert.equal(readiness.recoveryOnly, true);
    assert.equal(readiness.startAllowed, true);
    assert.ok(readiness.blockers.includes('persistent_pilot_stop'));
    const store = { state, stop() { assert.fail('existing risk stop must survive'); } };
    assert.doesNotThrow(() => enforceStartupGuards(store, { ...context, explicitLive: true }));
    assert.deepEqual(state, before);
    const conflict = liveReadiness({ ...context, state, otherHistory: true });
    assert.equal(conflict.startAllowed, false); assert.equal(conflict.recoveryOnly, false);
    assert.equal(liveReadiness({ ...context, state: delivered() }).startAllowed, false);
    assert.throws(() => enforceStartupGuards(store, { ...context, explicitLive: false }), /explicit_live_flag_required/);
});

test('profit config is disabled with no recipient by default and rejects invalid opt-in values', t => {
    const defaults = loadProfitTakingConfig({});
    assert.equal(defaults.enabled, false); assert.equal(defaults.recipient, null);
    assert.equal(defaults.asset, 'USDC'); assert.equal(defaults.chainId, 137);
    assert.equal(defaults.chunkUsd, 5); assert.equal(defaults.retainUsd, 20);
    assert.equal(defaults.maxFeeUsd, .05); assert.equal(defaults.maxGasUsd, .15);
    assert.equal(loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'false', LAYA_PROFIT_RECIPIENT: '' }).recipient, null);
    for (const enabled of ['TRUE', '1', 'yes', ' false '])
        assert.throws(() => loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: enabled }), /invalid_profit_taking_enabled/);
    assert.throws(() => loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true' }), /recipient_required/);
    for (const address of ['not-an-address', `0x${'0'.repeat(40)}`, '0x1234'])
        assert.throws(() => loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: address }), /invalid_profit_taking_recipient/);
    const config = loadLiveConfig({ RESTART_DATA_DIR: temporaryDirectory(t) });
    assert.equal(liveConfigView(config).profitTaking.enabled, false);
    assert.equal(liveConfigView(config).profitTaking.recipient, null);
    const template = fs.readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
    assert.match(template, /^LAYA_PROFIT_TAKING_ENABLED=false$/m);
    assert.match(template, /^LAYA_PROFIT_RECIPIENT=$/m);
    assert.equal(loadProfitTakingConfig({ LAYA_PROFIT_RECIPIENT: recipient }).recipient, recipient);
    assert.equal(loadProfitTakingConfig({ LAYA_PROFIT_RECIPIENT: otherRecipient }).recipient, otherRecipient);
});

test('live config identity binds the chosen private recipient and exposes no signing secret', t => {
    const base = { RESTART_DATA_DIR: temporaryDirectory(t), LAYA_PROFIT_TAKING_ENABLED: 'true',
        LAYA_PROFIT_RECIPIENT: recipient, PRIVATE_KEY: 'fixture-private-signing-secret' };
    const first = loadLiveConfig(base), second = loadLiveConfig({ ...base, LAYA_PROFIT_RECIPIENT: otherRecipient });
    assert.notEqual(first.id, second.id);
    assert.equal(liveConfigView(first).profitTaking.recipient, recipient);
    assert.equal(liveConfigView(second).profitTaking.recipient, otherRecipient);
    assert.equal(JSON.stringify(liveConfigView(first)).includes(base.PRIVATE_KEY), false);
});

test('diagnostic facade masks both new financial preparation methods and all underlying signing escapes', async () => {
    const blocked = [], calls = [];
    const raw = { prepareSafeCall() { calls.push('safe'); }, prepareProfitTransfer() { calls.push('profit'); },
        broadcastAction() { calls.push('broadcast'); }, balance: async () => 21, provider: {}, rpc: {},
        wallet: { signTransaction() { calls.push('sign'); } }, secure: {}, token: {} };
    const facade = readOnlyLiveClient(raw, method => blocked.push(method));
    for (const method of ['prepareSafeCall', 'prepareProfitTransfer', 'broadcastAction'])
        assert.throws(() => facade[method]({}), /diagnostic_financial_operation_blocked/);
    for (const field of ['provider', 'rpc', 'wallet', 'secure', 'token']) assert.equal(facade[field], undefined);
    assert.deepEqual(blocked, ['prepareSafeCall', 'prepareProfitTransfer', 'broadcastAction']);
    assert.deepEqual(calls, []);
    assert.equal(await facade.balance(), 21);
});

test('profit report separates actual net USDC, gross debit, pending cash and all flat withdrawal costs', () => {
    const transit = profitTakingReport(source(), profitConfig());
    assert.equal(transit.pending, true); assert.equal(transit.totalPUSDDebited, 5);
    assert.equal(transit.totalUSDCReceived, 0); assert.equal(transit.availableTradingCash, 20.994);
    const report = profitTakingReport(delivered(), profitConfig());
    assert.equal(report.pending, false); assert.equal(report.totalPUSDDebited, 5);
    assert.equal(report.totalUSDCReceived, 4.999960); assert.equal(report.availableTradingCash, 20.994);
    assert.equal(report.gasUsd, .006); assert.equal(report.bridgeFeesUsd, .000040);
    assert.equal(report.tradingPnlAfterWithdrawalCosts, 5.993960);
    assert.equal(report.aiComputeCost, null);
});

test('new manifest self-hash includes profit config and rejects changed recipient metadata', t => {
    const directory = temporaryDirectory(t);
    const original = loadLiveConfig({ RESTART_DATA_DIR: directory, LAYA_PROFIT_TAKING_ENABLED: 'true',
        LAYA_PROFIT_RECIPIENT: recipient });
    const manifest = { id: original.id, policy: original.policy, sources: original.sources,
        profitTaking: original.profitTaking, startedAt: now };
    const expected = crypto.createHash('sha256').update(JSON.stringify({ policy: manifest.policy,
        hashes: manifest.sources, profitTaking: manifest.profitTaking })).digest('hex').slice(0, 16);
    assert.equal(manifest.id, expected);
    const runtimeId = '0123456789abcdef', period = path.join(directory, original.id, 'pilot');
    atomicJson(path.join(period, 'laya-manifest.json'), manifest);
    atomicJson(path.join(period, 'late-entry.json'), { ...stateFixture(), baseline: original.id, startedAt: now });
    atomicJson(path.join(directory, 'laya-live-continuation.json'), { schema: 1, runtimeId, periodId: original.id });
    const runtime = { ...original, id: runtimeId }, continuation = bindContinuation(runtime);
    assert.equal(continuation.id, original.id); assert.equal(continuation.runtimeId, runtimeId);
    assert.equal(continuation.settings.fingerprint, original.id);
    atomicJson(path.join(period, 'laya-manifest.json'), { ...manifest,
        profitTaking: { ...manifest.profitTaking, recipient: otherRecipient } });
    assert.throws(() => bindContinuation(runtime), /policy_mismatch/);
});

test('legacy manifests retain their original self-hash and original period during continuation', t => {
    const directory = temporaryDirectory(t), policy = { schema: 4, capital: null, shares: 5 };
    const sources = [['reviewed-legacy-source', 'legacy-source-digest']];
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, hashes: sources })).digest('hex').slice(0, 16);
    const period = path.join(directory, id, 'pilot'), runtimeId = 'fedcba9876543210';
    atomicJson(path.join(period, 'laya-manifest.json'), { id, policy, sources, startedAt: now });
    const state = { ...stateFixture(), baseline: id, startedAt: now };
    atomicJson(path.join(period, 'late-entry.json'), state);
    atomicJson(path.join(directory, 'laya-live-continuation.json'), { schema: 1, runtimeId, periodId: id });
    const before = fs.readFileSync(path.join(period, 'late-entry.json'));
    const config = bindContinuation({ id: runtimeId, policy, profitTaking: loadProfitTakingConfig({}),
        settings: { dataDir: directory, fingerprint: runtimeId }, ai: { id: runtimeId } });
    assert.equal(config.id, id); assert.equal(config.ai.id, id);
    assert.equal(config.runtimeId, runtimeId);
    assert.deepEqual(fs.readFileSync(path.join(period, 'late-entry.json')), before);
});
