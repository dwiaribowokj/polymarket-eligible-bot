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
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { prepareActionGasRecovery, applyActionGasRecovery } from '../../src/eligible-live/action-gas-recovery.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;
const runtimeId = '8899aabbccddeeff', originalRuntimeId = '0011223344556677';
const redeemHash = `0x${'d'.repeat(64)}`, conditionId = `0x${'e'.repeat(64)}`, orderId = `0x${'f'.repeat(64)}`;
const stoppedAt = 1700000210643;
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const log = (iface, event, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(event), args) });

function receipt() {
    const operator = CONTRACTS.autoRedeemOperator, zero = ethers.constants.AddressZero;
    return { transactionHash: redeemHash, blockHash, blockNumber: 100, transactionIndex: 22, status: 1, confirmations: 3,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, 5000000]], 10),
            log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [operator, operator, zero, '2', 5000000], 11),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ethers.constants.HashZero, conditionId, [1, 2], 5000000], 13),
            log(erc20, 'Transfer', CONTRACTS.collateralToken, [zero, wallet, 5000000], 16)] };
}

function files(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [file, hash(fs.readFileSync(file))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-action-gas-'));
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
    Object.assign(state, { decisionProvider: 'eligible', startedAt: 1699990000000,
        cash: 13.669854, peakEquity: 19.157402, maxDrawdown: 13.729814,
        walletStart: 12.920246, walletCashDelta: 1.033635, lastEquity: 13.669854,
        liveFunding: { at: 1699990000000, initialCapital: 12.920246, allocation: 'available_balance' },
        stopped: { reason: 'operational_check_failed', at: stoppedAt }, reconciliationFaults: {},
        entryHolds: { maintenance_unknown: { retryable: false, firstAt: stoppedAt - 71, failedAt: stoppedAt - 71,
            retryAt: stoppedAt + 4929, attempts: 1, error: { name: 'OperationalError', code: 'insufficient_action_gas',
                category: 'validation', stage: 'safe_action_prepare' } } },
        continuousOperation: { enabledAt: 1699992000000, runtimeId: previousRuntimeId },
        stopHistory: [{ reason: 'trade_receipt_mapping_mismatch', at: 1699991000000, recoveredAt: 1699992000000 }],
        liveClock: { status: 'verified', verifiedAt: stoppedAt + 1000 },
        completed: [{ slug: 'completed', conditionId, tokens: ['1', '2'], traded: true, uncertain: false,
            pnl: .75, fees: .05, gas: 0, rebate: 0, entryCost: 4.25, closedAt: stoppedAt + 20000,
            payout: [0, 1], orders: [{ orderId, tokenId: '2', index: 1, side: 'BUY', status: 'complete', filled: 5, settled: 5 }] }],
        settlementEvidence: { [redeemHash]: { hash: redeemHash, kind: 'protocol_auto_redeem', conditionId,
            cash: 5, holdings: [0, -5], fees: 0, blockNumber: 100, blockHash, source: 'receipt', transactionIndex: 22 } },
        seen: { completed: true }, ai: { providers: {}, snapshots: [], slots: {} } });
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', previousRuntimeId, 'manifest.json');
    atomicJson(manifestFile, { id: periodId, runtimeId: previousRuntimeId, ...identity, startedAt: state.startedAt });
    const incident = { reason: 'safe_action_prepare_gas_unavailable', stop: structuredClone(state.stopped),
        hold: structuredClone(state.entryHolds.maintenance_unknown), continuousOperation: structuredClone(state.continuousOperation),
        previousRuntimeId, previousManifestSha256: hash(fs.readFileSync(manifestFile)),
        completedSha256: digest(state.completed), seenSha256: digest(state.seen), aiSha256: digest(state.ai),
        redeem: { hash: redeemHash, blockNumber: 100, blockHash } };
    Object.assign(config.runtimeContinuation, { ledgerStartedAt: state.startedAt, fundingSha256: digest(state.liveFunding),
        actionGasRecovery: incident });
    store.save();
    const f = { config, store, state, incident, dataDir, old, backup, manifestFile, calls: [], financialCalls: [],
        balance: 13.953881, healthBalance: 13.953881, positions: [], account: { orders: [], trades: [] },
        pendingNonce: '0x2', pendingSafeNonce: 3, providerReady: true, amounts: [0, 0], receipt: receipt(), payout: [0, 1] };
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
        balance: async () => f.balance, holdings: async () => f.amounts,
        verifiedReceipt: async (requested, block) => { assert.equal(requested, redeemHash); assert.equal(block, 123); return f.receipt; },
        payoutAtBlock: async () => f.payout,
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
    f.prepare = () => prepareActionGasRecovery(config, state, f.client, f.providers);
    return f;
}

test('review proves protocol settlement, wallet and runtime migration without writes', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir), review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.walletPUSD, 13.953881); assert.equal(review.summary.financialWrites, false);
    assert.equal(review.nextState.continuousOperation.enabledAt, before.continuousOperation.enabledAt);
    assert.equal(review.nextState.continuousOperation.runtimeId, runtimeId);
    assert.deepEqual(review.nextState.stopHistory.at(-1).originalHold, before.entryHolds.maintenance_unknown);
    assert.deepEqual(review.nextState.stopHistory.at(-1).redemption.holdings, [0, -5]);
    assert.equal(review.nextState.stopHistory.at(-1).walletProof.pendingSafeNonce, '3');
    assert.throws(() => applyActionGasRecovery(f.store, review), /unproven/);
    const ai = f.state.ai;
    applyActionGasRecovery(f.store, review, { explicitApply: true });
    assert.equal(f.state.ai, ai);
    assert.deepEqual(f.state, { ...before, stopped: null, entryHolds: {}, stopHistory: review.nextState.stopHistory,
        continuousOperation: review.nextState.continuousOperation, continuousOperationHistory: review.nextState.continuousOperationHistory });
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    assert.equal(eligibleReadiness({ config: f.config, state: f.state, history: eligibleHistory(f.config), operationalReady: true }).readyForLive, true);
    assert.throws(() => applyActionGasRecovery(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('unreviewed holds, write uncertainty, risk stops and changed pins reject before reads', async t => {
    const changes = {
        'different stop': f => { f.state.stopped.reason = 'unknown_transaction'; },
        'manual stop': f => { f.state.stopped.reason = 'manual_stop'; },
        'risk stop': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; },
        'wrong stage even if pinned': f => { f.state.entryHolds.maintenance_unknown.error.stage = 'safe_action_submit'; f.incident.hold = structuredClone(f.state.entryHolds.maintenance_unknown); },
        'wrong code even if pinned': f => { f.state.entryHolds.maintenance_unknown.error.code = 'transport_failed'; f.incident.hold = structuredClone(f.state.entryHolds.maintenance_unknown); },
        'hold changed': f => { f.state.entryHolds.maintenance_unknown.failedAt++; },
        'extra hold': f => { f.state.entryHolds.clock = {}; },
        'position pending': f => { f.state.position = {}; },
        'withdrawal pending': f => { f.state.profitTaking = { pending: {} }; },
        'reconciliation fault': f => { f.state.reconciliationFaults.unknown = {}; },
        'completed changed': f => { f.state.completed[0].pnl++; },
        'AI changed': f => { f.state.ai.slots.extra = {}; },
        'seen changed': f => { f.state.seen.extra = true; },
        'marker changed': f => { f.state.continuousOperation.enabledAt++; },
        'previous runtime changed': f => { f.incident.previousRuntimeId = originalRuntimeId; },
        'manifest changed': f => { fs.appendFileSync(f.manifestFile, '\n'); },
        'policy mismatch': f => { f.config.policy.entryCap = 8; },
        'unknown completed action': f => { f.state.completed[0].actions = [{ status: 'unknown' }]; f.incident.completedSha256 = digest(f.state.completed); },
        'historical backup changed': f => { fs.appendFileSync(f.backup, '\n'); },
        'already archived': f => { f.state.stopHistory.push({ ...f.state.stopped }); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.financialCalls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
});

test('fresh account and receipt failures cannot produce a recovery review', async t => {
    const changes = {
        'preflight wallet': f => { f.healthBalance++; },
        'wallet': f => { f.balance++; },
        'provider': f => { f.providerReady = false; },
        'open order': f => { f.account.orders.push({ id: 'unowned', conditionId }); },
        'inventory': f => { f.positions.push({ size: 1 }); },
        'token holdings': f => { f.amounts = [0, 1]; },
        'pending signer': f => { f.pendingNonce = '0x3'; },
        'pending Safe': f => { f.pendingSafeNonce = 4; },
        'pending trade': f => { f.account.trades.push({ status: 'RETRYING' }); },
        'receipt hash': f => { f.receipt.transactionHash = `0x${'a'.repeat(64)}`; },
        'receipt block': f => { f.receipt.blockNumber++; },
        'receipt index': f => { f.receipt.transactionIndex++; },
        'receipt failure': f => { f.receipt.status = 0; },
        'receipt finality': f => { f.receipt.confirmations = 1; },
        'receipt cash': f => { f.receipt.logs[3] = log(erc20, 'Transfer', CONTRACTS.collateralToken, [ethers.constants.AddressZero, wallet, 5000001], 16); },
        'payout mismatch': f => { f.payout = [1, 0]; },
        'state mutated': f => { f.client.holdings = async () => { f.state.failures++; return [0, 0]; }; },
        'disk mutated': f => { f.client.holdings = async () => { atomicJson(f.store.filename, { ...f.state, failures: 5 }); return [0, 0]; }; },
        'approval mutated': f => { f.client.holdings = async () => { f.incident.redeem.blockNumber++; return [0, 0]; }; },
        'anchor mutated': f => { f.client.holdings = async () => { f.client.rpc.anchor.hash = `0x${'a'.repeat(64)}`; return [0, 0]; }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); await assert.rejects(f.prepare);
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.stopHistory.length, 1); assert.deepEqual(f.financialCalls, []);
    });
});

test('apply rejects tampering and disk changes and rolls back failed persistence', async t => {
    for (const name of ['state', 'draft', 'summary', 'forged', 'disk', 'save']) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare(), before = structuredClone(f.state);
        if (name === 'state') f.state.cash++;
        if (name === 'draft') review.nextState.cash++;
        if (name === 'summary') review.summary.walletPUSD++;
        if (name === 'disk') atomicJson(f.store.filename, { ...f.state, failures: 10 });
        if (name === 'save') f.store.save = () => { throw new Error('disk_unavailable'); };
        assert.throws(() => applyActionGasRecovery(f.store, name === 'forged' ? structuredClone(review) : review, { explicitApply: true }));
        if (name !== 'state') assert.deepEqual(f.state, before);
    });
});
