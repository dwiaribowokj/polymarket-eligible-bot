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
import { eligiblePreflight } from '../../src/eligible-live/preflight.js';
import { ExternalActivityReconciler } from '../../src/laya-live/external-activity.js';
import { ContinuousRecovery, continuousRecoveryCandidate, continuousRecoveryReadCandidate,
    initializeContinuousState } from '../../src/eligible-live/continuous-recovery.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const runtimeId = '8899aabbccddeeff', wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'c'.repeat(64)}`;

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-continuous-recovery-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    let config = { id: runtimeId, runtimeId,
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`,
            fingerprint: runtimeId, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity,
            continuousTrading: true },
        policy: { provider: 'eligible', continuousTrading: true }, profitTaking: { enabled: false },
        paperEvidence: { qualified: false }, ai: {} };
    const old = new Store({ ...config.settings, fingerprint: 'aabbccddeeff0011' }, 'pilot', 'late-entry');
    Object.assign(old.state, { startedAt: 1000, walletStart: 20, walletCashDelta: 0,
        stopped: { reason: 'drawdown_limit', at: 2000 }, maxDrawdown: 10 });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = { schema: 1, runtimeId, dataDir, wallet, drawdownStop: 10,
        policySha256: digest(config.policy), profitTakingSha256: digest(config.profitTaking),
        createdAt: 3000, nonce: 'd'.repeat(64), openingBalance: 20,
        acknowledgment: 'manual_new_risk_period', automaticActivation: false, approvedHistory: [pin] };
    const periodId = digest(payload).slice(0, 16), riskRoot = path.join(dataDir, 'eligible-risk-periods', runtimeId);
    const riskFile = path.join(riskRoot, periodId, 'record.json');
    atomicJson(riskFile, { periodId, ...payload });
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(old.filename, backup);
    config = bindRiskPeriod(config);
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    Object.assign(state, { decisionProvider: 'eligible', startedAt: 4000,
        cash: 12, peakEquity: 25, maxDrawdown: 13, lastEquity: 12, walletStart: 20, walletCashDelta: -8,
        liveFunding: { at: 4000, initialCapital: 20, allocation: 'available_balance' },
        entryHolds: {}, reconciliationFaults: {},
        completed: [{ slug: 'completed', conditionId: 'condition', tokens: ['1', '2'], traded: true,
            uncertain: false, pnl: -8, fees: .01, gas: .001, closedAt: 4500 }],
        seen: { completed: true }, ai: { providers: {}, snapshots: [], slots: { 'consumed:30': { status: 'invalid' } } } });
    initializeContinuousState(config, state, { now: () => 5000 });
    state.stopped = { reason: 'operational_check_failed', at: 6000 };
    store.save();
    const f = { config, store, state, old, backup, riskFile, dataDir, now: 7000, calls: [], financial: [], logs: [],
        balance: 12, healthBalance: 12, amounts: [0, 0], positions: [], account: { orders: [], trades: [] },
        pendingNonce: '0x2', pendingSafeNonce: 3, providerReady: true };
    store.logger = row => f.logs.push(row);
    const forbidden = name => () => { f.financial.push(name); throw new Error('financial_write_forbidden'); };
    f.client = {
        startBtcFeed() {}, serverTime: async () => { f.calls.push('time'); return Date.now(); },
        json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: f.healthBalance,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => f.positions, ordersAndTrades: async () => f.account,
        gasPriceUsd: async () => 1, confirmedBlock: async () => { f.calls.push('block'); return 123; },
        balance: async block => { assert.equal(block, 123); return f.balance; },
        holdings: async (tokens, block) => { f.calls.push(['holdings', tokens, block]); return f.amounts; },
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task, block) => {
            assert.equal(block, 123);
            return task({ getBlock: async number => ({ number, hash: blockHash }), send: async (method, params) => {
                if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? f.pendingNonce : '0x2';
                if (method === 'eth_call') return ethers.utils.defaultAbiCoder.encode(['uint256'],
                    [params[1] === 'pending' ? f.pendingSafeNonce : 3]);
                if (method === 'eth_getBlockByNumber') return { hash: blockHash };
                throw new Error('unexpected_rpc');
            } });
        } },
        prepare: forbidden('prepare'), post: forbidden('post'), prepareAction: forbidden('prepareAction'),
        broadcastAction: forbidden('broadcastAction'), cancel: forbidden('cancel'),
        prepareProfitTransfer: forbidden('prepareProfitTransfer'),
    };
    f.providers = { preflight: async () => ({ eligible: { ready: f.providerReady } }), predict: forbidden('predict') };
    f.recovery = new ContinuousRecovery(config, store, f.client, f.providers, { now: () => f.now });
    return f;
}

function automaticInventory(f) {
    f.config.settings.automaticManualActivity = true;
    const first = `0x${'e'.repeat(64)}`, second = `0x${'f'.repeat(64)}`;
    const conditionId = `0x${'d'.repeat(64)}`;
    f.manualHoldings = { '1': 1.923077, '22': 2.040817 };
    f.state.externalWalletActivity = { cashDelta: 2, capitalAllocated: 0, zeroPayoutInventory: [],
        receipts: [{ hash: first, blockNumber: 110, blockHash, cash: 1, tokenIds: ['1'], holdings: [1.923077] },
            { hash: second, blockNumber: 111, blockHash, cash: 1, tokenIds: ['22'], holdings: [2.040817] }],
        automatic: { schema: 1, checkpoint: { blockNumber: 123, blockHash },
            holdings: Object.entries(f.manualHoldings).map(([tokenId, amount]) => ({ tokenId, amount })) } };
    f.positions = [{ conditionId, tokenId: '1', size: 1.923 }, { conditionId, tokenId: '22', size: 2.0408 }];
    f.balance = 14; f.healthBalance = 14;
    f.account.orders = [{ id: `0x${'a'.repeat(64)}`, tokenId: '22', conditionId,
        side: 'BUY', originalSize: 5, sizeMatched: 1, price: .4 }];
    f.account.trades = [{ status: 'MATCHED', transactionHash: first }];
    f.client.holdings = async (tokens, block) => {
        assert.equal(block, 123); f.calls.push(['holdings', tokens, block]);
        return tokens.map(token => f.manualHoldings[token] || 0);
    };
    f.store.save();
    return f;
}

function externalInventory(f) {
    const conditionId = `0x${'d'.repeat(64)}`, txHash = `0x${'e'.repeat(64)}`;
    const receiptBlockHash = `0x${'f'.repeat(64)}`, tokens = ['11', '22'];
    const abi = new ethers.utils.Interface([
        'function getOutcomeSlotCount(bytes32) view returns (uint256)',
        'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
        'function getPositionId(address,bytes32) view returns (uint256)',
        'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    ]);
    const event = abi.encodeEventLog(abi.getEvent('TransferSingle'),
        [wallet, ethers.constants.AddressZero, wallet, tokens[1], '2040817']);
    f.external = { payout: [1, 0], holdings: [0, 2.040817], receiptReads: 0, positionReads: 0,
        receipt: { transactionHash: txHash, status: 1, confirmations: 12, blockNumber: 110,
            blockHash: receiptBlockHash, logs: [{ ...event, address: CONTRACTS.conditionalTokens,
                logIndex: 0, transactionHash: txHash, blockNumber: 110, blockHash: receiptBlockHash }] } };
    f.state.externalWalletActivity = { reviewedAt: 6500, cashDelta: 0,
        receipts: [{ hash: txHash, blockNumber: 110, blockHash: receiptBlockHash,
            cash: 0, tokenIds: [tokens[1]], holdings: [2.040817] }],
        zeroPayoutInventory: [{ conditionId, slug: 'manual-losing-position', tokens,
            amounts: [0, 2.040817], payout: [1, 0], receiptHashes: [txHash] }] };
    f.positions = [{ tokenId: tokens[1], conditionId, size: 2.0408 }];
    f.client.positions = async () => { f.external.positionReads++; return structuredClone(f.positions); };
    f.client.verifiedReceipt = async (hash, block) => {
        assert.equal(hash, txHash); assert.equal(block, 123); f.external.receiptReads++;
        return f.external.receipt;
    };
    f.client.payoutAtBlock = async (condition, block) => {
        assert.equal(condition, conditionId); assert.equal(block, 123); return f.external.payout;
    };
    const holdings = f.client.holdings;
    f.client.holdings = async (requested, block) => {
        if (requested[0] !== tokens[0]) return holdings(requested, block);
        assert.equal(block, 123);
        return f.external.holdings;
    };
    const read = f.client.rpc.read;
    f.client.rpc.read = async (stage, task, block) => {
        if (stage !== 'eligible_external_inventory_market') return read(stage, task, block);
        assert.equal(block, 123);
        return task({ _isProvider: true, resolveName: async address => address,
            call: async ({ data }, tag) => {
                assert.equal(tag, 123);
                const { name, args } = abi.parseTransaction({ data });
                const value = name === 'getOutcomeSlotCount' ? 2
                    : name === 'getCollectionId' ? ethers.utils.hexZeroPad(args[2].toHexString(), 32)
                        : ethers.BigNumber.from(args[1]).eq(1) ? tokens[0] : tokens[1];
                return abi.encodeFunctionResult(name, [value]);
            } });
    };
    f.store.save();
    return f;
}

test('activation records a single explicit enablement and cannot label an old stop recoverable', t => {
    const f = fixture(t), marker = structuredClone(f.state.continuousOperation);
    assert.equal(initializeContinuousState(f.config, f.state, { now: () => 8000 }), false);
    assert.deepEqual(f.state.continuousOperation, marker);
    delete f.state.continuousOperation;
    assert.equal(initializeContinuousState(f.config, f.state, { now: () => 8000 }), false);
    assert.equal(f.state.continuousOperation, undefined);
    assert.equal(continuousRecoveryCandidate(f.config, f.state, f.now), false);
    f.state.stopped = null;
    assert.equal(initializeContinuousState({ ...f.config, settings: { ...f.config.settings,
        continuousTrading: false } }, f.state, { now: () => 8000 }), false);
    assert.equal(initializeContinuousState(f.config, f.state, { now: () => 8000 }), true);
    assert.deepEqual(f.state.continuousOperation, { enabledAt: 8000, runtimeId });
    assert.throws(() => initializeContinuousState(f.config, f.state, { now: () => 7999 }), /unproven/);
});

test('read-only preflight advertises recovery only for eligible continuously enabled stops', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
    const checked = await eligiblePreflight(f.config, f.client, f.providers, f.state);
    assert.equal(checked.output.continuousRecoveryAvailable, true);
    assert.equal(checked.output.operationalReady, true);
    assert.equal(checked.output.startAllowed, false);
    assert.deepEqual(checked.output.blockers, ['persistent_pilot_stop']);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
    f.state.entryHolds.entry_read = { retryable: true, firstAt: 6000, failedAt: 6000, retryAt: 11000,
        error: { name: 'OperationalError', code: 'read_timeout', category: 'timeout' } };
    f.store.save();
    const held = await eligiblePreflight(f.config, f.client, f.providers, f.state);
    assert.equal(held.output.continuousRecoveryAvailable, true);
    assert.equal(held.output.startAllowed, false);
    assert.equal(continuousRecoveryCandidate(f.config, f.state, f.now), false);
    assert.equal(await f.recovery.tick(), false);
    assert.deepEqual(f.state.stopped, before.stopped);
    f.state.stopped.reason = 'manual_signal'; f.store.save();
    assert.equal((await eligiblePreflight(f.config, f.client, f.providers, f.state))
        .output.continuousRecoveryAvailable, false);
});

test('read admission permits only known retryable holds without authorizing stop recovery', t => {
    const f = fixture(t);
    const hold = { retryable: true, firstAt: 6000, failedAt: 6000, retryAt: 11000,
        error: { name: 'OperationalError', code: 'read_timeout', category: 'timeout' } };
    for (const key of ['entry_read', 'market_watch', 'book_stream', 'clock']) {
        f.state.entryHolds = { [key]: structuredClone(hold) };
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), true);
        assert.equal(continuousRecoveryCandidate(f.config, f.state, f.now), false);
        f.state.entryHolds[key].retryable = false;
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    }
    for (const key of ['runtime_error', 'maintenance_unknown', 'provider_semantics', 'broker_order']) {
        f.state.entryHolds = { [key]: hold };
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    }
    f.state.entryHolds = { entry_read: { ...hold, firstAt: 4999 } };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    f.state.entryHolds = { entry_read: { ...hold, error: { code: 'execution_token_mismatch', category: 'validation' } } };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    for (const [key, code, stage] of [['entry_read', 'metadata_mismatch', 'metadata_read'],
        ['entry_read', 'invalid_entry_books', 'book_read'], ['book_stream', 'invalid_tick_size', 'metadata_read'],
        ['market_watch', 'market_identity_mismatch', 'market_discovery']]) {
        f.state.entryHolds = { [key]: { ...hold, error: { code, category: 'validation', stage } } };
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), true);
        delete f.state.entryHolds[key].error.stage;
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    }
    f.state.entryHolds = { entry_read: hold };
    f.state.stopped.reason = 'manual_signal';
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    f.state.stopped.reason = 'operational_check_failed'; f.state.liveRiskStop = { reason: 'drawdown_limit' };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
});

test('Gamma discovery absence permits only stopped read recovery, not automatic stop clearance', t => {
    const f = fixture(t);
    const hold = { retryable: true, firstAt: 6000, failedAt: 6000, retryAt: 11000,
        error: { name: 'OperationalError', code: 'http_rejected', category: 'api_rejection',
            httpStatus: 404, endpoint: 'gamma', stage: 'market_discovery' } };
    f.state.entryHolds = { market_watch: structuredClone(hold) };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), true);
    assert.equal(continuousRecoveryCandidate(f.config, f.state, f.now), false);
    for (const [key, detail] of [['entry_read', {}], ['market_watch', { httpStatus: 400 }],
        ['market_watch', { httpStatus: 401 }], ['market_watch', { httpStatus: 403 }],
        ['market_watch', { httpStatus: undefined }], ['market_watch', { endpoint: 'clob' }],
        ['market_watch', { stage: 'metadata_read' }]]) {
        f.state.entryHolds = { [key]: { ...hold, error: { ...hold.error, ...detail } } };
        assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
    }
    f.state.entryHolds = { market_watch: { ...hold, failedAt: 30001, retryAt: 35001 } };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, 35001), true);
    assert.equal(continuousRecoveryCandidate(f.config, f.state, 35001), false);
    f.state.entryHolds = { market_watch: { ...hold, retryable: false } };
    assert.equal(continuousRecoveryReadCandidate(f.config, f.state, f.now), false);
});

test('flat account recovery archives the stop and proof without changing accounting or decisions', async t => {
    const f = fixture(t), before = structuredClone(f.state), aiRef = f.state.ai, stateRef = f.state;
    const immutable = [f.old.filename, f.backup, f.riskFile].map(file => [file, fs.readFileSync(file)]);
    assert.equal(await f.recovery.tick(), true);
    assert.equal(f.store.state, stateRef); assert.equal(f.state.ai, aiRef); assert.equal(f.state.stopped, null);
    const evidence = f.state.stopHistory.at(-1);
    assert.equal(evidence.reason, before.stopped.reason); assert.equal(evidence.at, 6000);
    assert.equal(evidence.enabledAt, 5000); assert.equal(evidence.recoveredAt, 7000);
    assert.equal(evidence.walletProof.expectedBalance, 12);
    assert.equal(evidence.walletProof.pendingNonce, evidence.walletProof.confirmedNonce);
    assert.deepEqual(evidence.walletProof.holdings, [{ conditionId: 'condition', tokens: ['1', '2'], amounts: [0, 0] }]);
    const { events, operational, stopped, stopHistory, ...actual } = f.state;
    const { events: oldEvents, stopped: oldStop, ...expected } = before;
    assert.deepEqual(actual, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    for (const [file, bytes] of immutable) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(f.financial, []);
    assert.equal(await f.recovery.tick(), false);
});

test('continuous recovery rechecks reviewed zero-payout inventory without assigning it bot capital', async t => {
    const f = externalInventory(fixture(t)), before = structuredClone(f.state);
    assert.equal(await f.recovery.tick(), true);
    assert.equal(f.state.stopped, null);
    const proof = f.state.stopHistory.at(-1).walletProof.externalInventoryProof;
    assert.equal(proof.source, 'reviewed_manual_zero_payout_ctf');
    assert.equal(proof.blockNumber, 123); assert.equal(proof.blockHash, blockHash);
    assert.equal(proof.inventory[0].value, 0); assert.equal(proof.inventory[0].capitalAllocated, 0);
    assert.deepEqual(proof.inventory[0].holdings, [0, 2.040817]);
    assert.equal(f.external.receiptReads, 2); assert.equal(f.external.positionReads, 2);
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'lastEquity', 'liveFunding', 'walletStart',
        'walletCashDelta', 'completed', 'ai', 'externalWalletActivity']) assert.deepEqual(f.state[key], before[key], key);
    assert.deepEqual(f.financial, []);
});

test('continuous recovery keeps the stop for winning, unresolved or unreviewed external inventory', async t => {
    const changes = {
        'winner': f => { f.external.payout = [0, 1]; },
        'unresolved': f => { f.external.payout = null; },
        'unreviewed': f => { delete f.state.externalWalletActivity.zeroPayoutInventory; },
        'unknown token': f => { f.positions.push({ tokenId: '33', conditionId: `0x${'a'.repeat(64)}`, size: 1 }); },
        'changed holdings': f => { f.external.holdings = [0, 3]; },
        'failed receipt': f => { f.external.receipt.status = 0; },
        'late inventory': f => {
            const holdings = f.client.holdings;
            f.client.holdings = async (tokens, block) => {
                if (tokens[0] === '1') f.positions.push({ tokenId: '33', conditionId: `0x${'a'.repeat(64)}`, size: 1 });
                return holdings(tokens, block);
            };
        },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = externalInventory(fixture(t)); change(f); f.store.save();
        const before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
        assert.equal(await f.recovery.tick(), false);
        assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
        assert.deepEqual(f.financial, []);
    });
});

test('automatic recovery accepts booked manual inventory, reused completed tokens, and manual open orders', async t => {
    const f = automaticInventory(fixture(t)), before = structuredClone(f.state);
    assert.equal(await f.recovery.tick(), true);
    assert.equal(f.state.stopped, null);
    const proof = f.state.stopHistory.at(-1).walletProof;
    assert.equal(proof.externalInventoryProof.source, 'automatic_manual_ctf');
    assert.equal(proof.externalInventoryProof.orders.count, 1);
    assert.equal(proof.externalInventoryProof.orders.reservedPUSD, 4);
    assert.deepEqual(proof.holdings[0].amounts, [1.923077, 0]);
    assert.equal(proof.trades.receiptConfirmed[0].source, 'known_receipt');
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'lastEquity', 'liveFunding', 'walletStart',
        'walletCashDelta', 'completed', 'ai', 'externalWalletActivity']) assert.deepEqual(f.state[key], before[key], key);
    assert.deepEqual(f.financial, []);
});

test('automatic recovery keeps the stop for unknown inventory, pending trades, and malformed orders', async t => {
    const changes = {
        'unknown inventory': f => { f.positions.push({ tokenId: '33', size: 1 }); },
        'API mismatch': f => { f.positions[0].size = 1.923078; },
        'missing manual inventory': f => { f.positions.pop(); },
        'chain mismatch': f => { f.manualHoldings['1'] = 1.923078; },
        'pending trade': f => { f.account.trades = [{ status: 'MATCHED', transactionHash: `0x${'9'.repeat(64)}` }]; },
        'invalid order': f => { delete f.account.orders[0].originalSize; },
        'completed bot order reopened': f => { f.state.completed[0].orders = [{ orderId: f.account.orders[0].id }]; },
        'late inventory': f => {
            const holdings = f.client.holdings;
            f.client.holdings = async (tokens, block) => {
                if (tokens[0] === '1' && tokens[1] === '2') f.positions.push({ tokenId: '33', size: 1 });
                return holdings(tokens, block);
            };
        },
        'late pending trade': f => {
            const holdings = f.client.holdings;
            f.client.holdings = async (tokens, block) => {
                if (tokens[0] === '1' && tokens[1] === '2') f.account.trades = [{ status: 'RETRYING' }];
                return holdings(tokens, block);
            };
        },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = automaticInventory(fixture(t)); change(f); f.store.save();
        const before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
        assert.equal(await f.recovery.tick(), false);
        assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
        assert.deepEqual(f.financial, []);
    });
});

test('automatic stop recovery never imports an unbooked zero-net receipt or genuine deposit', async t => {
    const original = ExternalActivityReconciler.prototype.proof;
    for (const field of ['receiptCount', 'depositAmount', 'externalCashDelta']) await t.test(field, async t => {
        const f = automaticInventory(fixture(t));
        t.mock.method(ExternalActivityReconciler.prototype, 'proof', async function (...args) {
            const checked = await original.apply(this, args);
            checked.summary[field] = 1;
            return checked;
        });
        const before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
        assert.equal(await f.recovery.tick(), false);
        assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
        assert.deepEqual(f.financial, []);
    });
});

test('old, future, replayed, manual, risk and uncertain state never begin recovery reads', async t => {
    const changes = {
        'disabled': f => { f.config.settings.continuousTrading = false; },
        'missing marker': f => { delete f.state.continuousOperation; },
        'wrong runtime': f => { f.state.continuousOperation.runtimeId = 'a'.repeat(16); },
        'old stop': f => { f.state.stopped.at = 4999; },
        'future stop': f => { f.state.stopped.at = 7001; },
        'future activation': f => { f.state.continuousOperation.enabledAt = 8000; },
        'replayed stop': f => { f.state.stopHistory = [{ ...f.state.stopped }]; },
        'corrupt stop history': f => { f.state.stopHistory = [null]; },
        'manual stop': f => { f.state.stopped.reason = 'manual_signal'; },
        'drawdown stop': f => { f.state.stopped.reason = 'drawdown_limit'; },
        'receipt stop': f => { f.state.stopped.reason = 'trade_receipt_mapping_mismatch'; },
        'identity stop': f => { f.state.stopped.reason = 'market_identity_mismatch'; },
        'risk latch': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; },
        'inventory': f => { f.state.position = {}; },
        'frozen': f => { f.state.frozenAt = 6000; },
        'fault': f => { f.state.reconciliationFaults.receipt = {}; },
        'unknown runtime': f => { f.state.entryHolds.runtime_error = { retryable: false }; },
        'unknown maintenance': f => { f.state.entryHolds.maintenance_unknown = { retryable: true }; },
        'retryable book': f => { f.state.entryHolds.book_stream = { retryable: true }; },
        'withdrawal': f => { f.state.profitTaking = { pending: {} }; },
        'control operation': f => { f.state.profitTakingControl = { operation: {} }; },
        'failed clock': f => { f.state.liveClock = { status: 'failed' }; },
        'corrupt clock': f => { f.state.liveClock = { status: 'unknown' }; },
        'provider pending': f => { f.state.ai.providers.eligible = { pending: {} }; },
        'provider disabled': f => { f.state.ai.providers.eligible = { disabled: 'identity' }; },
        'completed pending': f => { f.state.completed[0].pendingTrades = true; },
        'completed token missing': f => { delete f.state.completed[0].tokens; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state);
        assert.equal(await f.recovery.tick(), false); assert.deepEqual(f.calls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(f.financial, []);
    });
});

test('account proofs reject pending work, inventory, changed balance and inconsistent anchors', async t => {
    const changes = {
        'wallet preflight': f => { f.healthBalance++; },
        'wallet block': f => { f.balance++; },
        'provider': f => { f.providerReady = false; },
        'order': f => { f.account.orders.push({ id: 'open', conditionId: 'condition' }); },
        'trade': f => { f.account.trades.push({ status: 'RETRYING' }); },
        'position': f => { f.positions.push({ size: 1 }); },
        'signer nonce': f => { f.pendingNonce = '0x3'; },
        'safe nonce': f => { f.pendingSafeNonce = 4; },
        'completed holdings': f => { f.amounts = [0, 1]; },
        'late order': f => { f.client.holdings = async () => {
            f.account = { orders: [{ id: 'new-order', conditionId: 'condition' }], trades: [] }; return [0, 0]; }; },
        'late trade': f => { f.client.holdings = async () => {
            f.account = { orders: [], trades: [{ status: 'RETRYING' }] }; return [0, 0]; }; },
        'anchor changed': f => { f.client.holdings = async () => {
            f.client.rpc.anchor.hash = `0x${'e'.repeat(64)}`; return [0, 0]; }; },
        'history changed': f => { fs.appendFileSync(f.old.filename, '\n'); },
        'archive changed': f => { fs.appendFileSync(f.backup, '\n'); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
        assert.equal(await f.recovery.tick(), false); assert.deepEqual(f.state, before);
        assert.deepEqual(fs.readFileSync(f.store.filename), disk); assert.deepEqual(f.financial, []);
        assert.equal(f.logs.at(-1).type, 'eligible_continuous_recovery_deferred');
    });
});

test('real state changes during any awaited proof reject recovery and preserve the new evidence', async t => {
    const changes = {
        'risk': f => { f.state.liveRiskStop = { reason: 'drawdown_limit', at: f.now }; },
        'cash': f => { f.state.cash++; },
        'wallet delta': f => { f.state.walletCashDelta++; },
        'peak': f => { f.state.peakEquity++; },
        'stop': f => { f.state.stopped = { reason: 'manual_signal', at: f.now }; },
        'hold': f => { f.state.entryHolds.runtime_error = { retryable: false }; },
        'decision': f => { f.state.ai.slots.new = { status: 'reserved' }; },
        'closed': f => { f.recovery.closed = true; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t);
        f.client.holdings = async () => { change(f); return [0, 0]; };
        assert.equal(await f.recovery.tick(), false);
        assert.ok(f.state.stopped); assert.equal(f.state.stopHistory, undefined); assert.deepEqual(f.financial, []);
    });
    await t.test('disk accounting', async t => {
        const f = fixture(t);
        f.client.holdings = async () => { atomicJson(f.store.filename, { ...f.state, cash: 99 }); return [0, 0]; };
        assert.equal(await f.recovery.tick(), false);
        assert.equal(JSON.parse(fs.readFileSync(f.store.filename)).cash, 99);
        assert.equal(f.state.cash, 12); assert.ok(f.state.stopped);
    });
    await t.test('stop during preflight', async t => {
        const f = fixture(t), original = f.client.walletHealth;
        f.client.walletHealth = async () => { f.state.stopped = { reason: 'manual_signal', at: f.now }; return original(); };
        assert.equal(await f.recovery.tick(), false); assert.equal(f.calls.includes('block'), false);
    });
});

test('background read telemetry can save during proof without invalidating stable accounting', async t => {
    const f = fixture(t), original = f.providers.preflight;
    f.providers.preflight = async () => { f.store.event('provider_preflight', { ready: true }); return original(); };
    f.client.holdings = async () => { f.store.event('read_succeeded', { stage: 'holdings' }); return [0, 0]; };
    assert.equal(await f.recovery.tick(), true);
    assert.equal(f.state.cash, 12); assert.equal(f.state.maxDrawdown, 13);
    assert.equal(f.state.events, 3); assert.equal(f.state.stopHistory.length, 1);
});

test('recovery checks are single-flight and failures retry after bounded delays', async t => {
    const f = fixture(t);
    let release;
    f.providers.preflight = () => new Promise(resolve => { release = resolve; });
    const first = f.recovery.tick();
    assert.equal(f.recovery.tick(), first);
    await new Promise(resolve => setImmediate(resolve));
    release({ eligible: { ready: false } });
    assert.equal(await first, false);
    assert.equal(f.recovery.nextAt, f.now + 30000);
    const calls = f.calls.length;
    assert.equal(await f.recovery.tick(), false); assert.equal(f.calls.length, calls);
    f.now += 30000;
    f.providers.preflight = async () => ({ eligible: { ready: false } });
    assert.equal(await f.recovery.tick(), false); assert.equal(f.recovery.nextAt, f.now + 60000);
    f.now += 60000;
    f.providers.preflight = async () => ({ eligible: { ready: true } });
    assert.equal(await f.recovery.tick(), true); assert.equal(f.recovery.failures, 0);
});

test('failed persistence restores the original stop and cannot throw out of supervision', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = fs.readFileSync(f.store.filename);
    f.store.save = () => { throw new Error('disk_unavailable'); };
    f.store.logger = () => { throw new Error('logger_unavailable'); };
    assert.equal(await f.recovery.tick(), false);
    assert.deepEqual(f.state, before); assert.deepEqual(fs.readFileSync(f.store.filename), disk);
});
