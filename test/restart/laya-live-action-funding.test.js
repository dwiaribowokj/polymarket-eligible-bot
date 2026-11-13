import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { MaintenanceEngine } from '../../src/laya-live/maintenance.js';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { newPosition } from '../../src/restart/strategy.js';
import { OperationalError } from '../../src/restart/network.js';

const wallet = '0x' + '1'.repeat(40), conditionId = '0x' + 'e'.repeat(64);
const blockHash = '0x' + 'c'.repeat(64), protocolHash = '0x' + 'b'.repeat(64);
const zero = ethers.constants.AddressZero;
const safe = new ethers.utils.Interface([
    'function nonce() view returns(uint256)',
    'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
]);
const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
const gwei = value => ethers.utils.parseUnits(String(value), 'gwei');
const hex = ethers.utils.hexValue;

function protocolReceipt() {
    const ctf = new ethers.utils.Interface([
        'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
        'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
        'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
    ]);
    const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    const log = (iface, name, address, args, logIndex) => ({ address, logIndex,
        ...iface.encodeEventLog(iface.getEvent(name), args) });
    const operator = CONTRACTS.autoRedeemOperator;
    return { transactionHash: protocolHash, blockHash, blockNumber: 99, confirmations: 4,
        status: 1, transactionIndex: 1, logs: [
            log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, 5000000]], 10),
            log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens, [operator, operator, zero, '2', 5000000], 11),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ethers.constants.HashZero, conditionId, [1, 2], 5000000], 13),
            log(erc20, 'Transfer', CONTRACTS.collateralToken, [zero, wallet, 5000000], 16),
        ] };
}

function fixture(t, { stopped = false } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: 1792872080000 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Funding tests must stay offline'));
    const settings = { ...BASELINE, wallet, capital: 20, drawdownStop: 10, continuousTrading: true,
        pilotHours: Infinity, pilotMarkets: Infinity };
    const state = { mode: 'pilot', strategy: 'late-entry', decisionProvider: 'eligible', startedAt: Date.now() - 300000,
        cash: 16, walletStart: 20, walletCashDelta: -4, peakEquity: 20, lastEquity: 20, maxDrawdown: 0,
        failures: 0, completed: [], seen: {}, entryHolds: {}, reconciliationFaults: {},
        stopped: stopped ? { reason: 'operational_check_failed', at: Date.now() - 1 } : null };
    const market = { slug: 'funding', conditionId, negRisk: false, tokens: ['1', '2'], outcomes: ['Up', 'Down'],
        open: Date.now() - 300000, end: Date.now() - 1000, fee: { rate: .07, exponent: 1 } };
    const position = state.position = newPosition(market, { cost: 4 }, state, Date.now() - 200000);
    Object.assign(position, { holdings: [0, 5], bought: [0, 5], payout: [0, 1], pendingTrades: false });
    position.orders.push({ orderId: '0x' + 'd'.repeat(64), side: 'BUY', kind: 'taker', index: 1, tokenId: '2', shares: 5,
        filled: 5, settled: 5, status: 'complete', receiptProvenComplete: true });
    const events = [], snapshots = [], calls = { prepares: 0, broadcasts: 0, reconciles: 0, scans: 0, wallets: 0, discovers: 0 };
    const store = { state, save() { snapshots.push(structuredClone(state)); },
        event(type, detail = {}) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    const values = { balance: hex(ethers.utils.parseEther('.1')), protocol: false, sendError: null };
    const provider = {
        async getBlock(number) { return { number, hash: blockHash, baseFeePerGas: gwei(145) }; },
        async send(method, params) {
            if (method === 'eth_getTransactionCount') return '0x1';
            if (method === 'eth_getBalance') return values.balance;
            if (method === 'eth_maxPriorityFeePerGas') return hex(gwei(30));
            if (method === 'eth_gasPrice') return hex(gwei(175));
            if (method === 'eth_call') {
                const parsed = safe.parseTransaction(params[0]);
                if (parsed.name === 'nonce') return safe.encodeFunctionResult('nonce', [7]);
                const message = Object.fromEntries(fields.map((field, index) => [field.name, parsed.args[index]]));
                return safe.encodeFunctionResult('getTransactionHash', [ethers.utils._TypedDataEncoder.hash(
                    { chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message)]);
            }
            if (method === 'eth_sendRawTransaction') {
                calls.broadcasts++;
                assert.equal(snapshots.at(-1).position.actions.at(-1).raw, params[0]);
                if (values.sendError) throw values.sendError;
                return ethers.utils.keccak256(params[0]);
            }
            assert.fail(`Unexpected RPC ${method}`);
        },
    };
    const client = Object.create(LayaTradingClient.prototype);
    client.settings = { wallet, privateKey: '0x' + '7'.repeat(64) }; // Synthetic offline key.
    client.rpc = { anchor: { number: 100, hash: blockHash }, active: 0, providers: [provider], validate: async () => {},
        async read(stage, task, block) {
            try { return await task(provider, block); }
            catch (error) { Object.assign(error, { stage, endpoint: 'rpc_primary' }); throw error; }
        } };
    client.confirmedBlock = async () => 100;
    client.gasPriceUsd = async () => .1;
    client.prepareAction = async (...args) => { calls.prepares++; return LayaTradingClient.prototype.prepareAction.call(client, ...args); };
    client.payoutAtBlock = async () => [0, 1];
    client.listAutoRedemptions = async () => { calls.scans++; return values.protocol ? [protocolHash] : []; };
    client.redemptionScan = { complete: true, key: JSON.stringify([wallet, conditionId, ['1', '2'], position.openedAt]) };
    client.verifiedReceipt = async hash => hash === protocolHash ? protocolReceipt() : null;
    const engine = new MaintenanceEngine(settings, store, client, { close() {} });
    engine.boot = async () => {}; engine.checkClock = async () => {};
    engine.discover = async () => { calls.discovers++; };
    const restartBroker = () => {
        const broker = engine.broker = new LayaLiveBroker(settings, store, client, async () => {});
        broker.readWallet = broker.checkWallet = async () => { calls.wallets++; return true; };
        broker.reconcile = async (_books, now) => {
            calls.reconciles++; broker.reconcileBlock = 100;
            await broker.reconcileAutoRedemptions(now);
            broker.reconciledSnapshot = { position, block: 100, at: now };
        };
        return broker;
    };
    restartBroker();
    return { state, position, store, client, engine, values, events, snapshots, calls, restartBroker,
        advance(ms) { t.mock.timers.setTime(Date.now() + ms); } };
}

test('real gas preparation defers without signing or stopping and keeps reconciliation active across restart', async t => {
    const f = fixture(t), sign = t.mock.method(ethers.Wallet.prototype, 'signMessage');
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.entryHolds, {});
    assert.equal(f.position.actions.length, 0); assert.equal(sign.mock.callCount(), 0);
    assert.equal(f.calls.broadcasts, 0); assert.equal(f.state.cash, 16); assert.deepEqual(f.position.holdings, [0, 5]);
    assert.equal(f.position.actionPreparationRetry.nextAt, Date.now() + 30000);
    assert.equal(f.snapshots.at(-1).position.actionPreparationRetry.error.code, 'insufficient_action_gas');
    f.restartBroker();
    for (let i = 0; i < 29; i++) { f.advance(1000); await f.engine.tick(); }
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.reconciles, 30); assert.equal(f.calls.scans, 30);
    f.advance(1000); await f.engine.tick();
    assert.equal(f.calls.prepares, 2); assert.equal(f.position.actionPreparationRetry.nextAt, Date.now() + 60000);
    f.advance(60000); await f.engine.tick();
    assert.equal(f.calls.prepares, 3); assert.equal(f.position.actionPreparationRetry.nextAt, Date.now() + 60000);
    f.values.balance = hex(ethers.utils.parseEther('1')); f.advance(60000); await f.engine.tick();
    assert.equal(f.position.actionPreparationRetry, undefined); assert.equal(sign.mock.callCount(), 1);
    assert.equal(f.calls.broadcasts, 1); assert.equal(f.position.actions[0].status, 'pending');
    f.advance(60000); await f.engine.tick();
    assert.equal(f.calls.broadcasts, 1); assert.equal(f.calls.prepares, 4); assert.equal(f.calls.discovers, 0);
    assert.equal(f.events.filter(row => row.type === 'action_preparation_retry').length, 3);
});

test('protocol redemption during funding backoff clears the retry and completes without a financial write', async t => {
    const f = fixture(t);
    await f.engine.tick(); f.values.protocol = true; f.advance(1000); await f.engine.tick();
    assert.equal(f.position.actionPreparationRetry, undefined); assert.equal(f.state.position, null);
    assert.equal(f.state.completed.length, 1); assert.equal(f.state.cash, 21);
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.entryHolds, {});
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 0);
    assert.equal(f.position.receipts[protocolHash].kind, 'protocol_auto_redeem');
    f.advance(1000); await f.engine.tick(); assert.equal(f.calls.discovers, 1);
});

test('stopped cleanup defers known funding failures then preserves the original stop after one funded broadcast', async t => {
    const f = fixture(t, { stopped: true }), original = structuredClone(f.state.stopped);
    await f.engine.tick();
    assert.deepEqual(f.state.stopped, original); assert.deepEqual(f.state.entryHolds, {});
    assert.deepEqual(f.state.reconciliationFaults, {}); assert.equal(f.calls.prepares, 1);
    f.restartBroker(); f.advance(29999); await f.engine.tick(); assert.equal(f.calls.prepares, 1);
    f.values.balance = hex(ethers.utils.parseEther('1')); f.advance(1); await f.engine.tick();
    assert.equal(f.position.actionPreparationRetry, undefined); assert.equal(f.calls.broadcasts, 1);
    assert.equal(f.position.actions[0].status, 'pending'); assert.deepEqual(f.state.stopped, original);
});

test('an identical gas error during broadcast stays unknown and cannot authorize another preparation', async t => {
    const f = fixture(t);
    f.values.balance = hex(ethers.utils.parseEther('1'));
    f.values.sendError = new OperationalError('insufficient_action_gas', 'validation', { stage: 'safe_action_prepare' });
    await f.engine.tick();
    const action = structuredClone(f.position.actions[0]);
    assert.equal(action.status, 'unknown'); assert.equal(f.state.stopped.reason, 'unknown_transaction');
    assert.equal(f.position.actionPreparationRetry, undefined); assert.equal(f.calls.broadcasts, 1);
    f.restartBroker(); f.advance(60000); await f.engine.tick();
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1); assert.deepEqual(f.position.actions[0], action);
});

test('only identified preparation reads defer; semantic errors and mislabeled funding stay persistent', async t => {
    for (const [code, category, stage, retry] of [
        ['read_timeout', 'timeout', 'safe_action_prepare', true],
        ['rpc_unavailable', 'transport', 'rpc_snapshot', true],
        ['rate_limited', 'rate_limit', 'gas_quote', true],
        ['action_fee_limit', 'validation', 'safe_action_prepare', true],
        ['action_fee_limit', 'validation', undefined, false],
        ['insufficient_action_gas', 'validation', undefined, false],
        ['insufficient_action_gas', 'validation', 'action_submit', false],
        ['insufficient_action_gas', 'unknown', 'safe_action_prepare', false],
        ['read_timeout', 'timeout', 'action_submit', false],
        ['rpc_wrong_chain', 'transport', 'safe_action_prepare', false],
        ['action_safe_hash_mismatch', 'reconciliation', 'safe_action_prepare', false],
        ['action_nonce_regressed', 'validation', 'safe_action_prepare', false],
        ['invalid_action_gas_balance', 'validation', 'safe_action_prepare', false],
    ]) await t.test(`${code}/${category}/${stage}`, async t => {
        const f = fixture(t);
        f.client.prepareAction = async () => { throw new OperationalError(code, category, { stage }); };
        await f.engine.tick();
        assert.equal(!!f.position.actionPreparationRetry, retry);
        assert.equal(f.state.stopped?.reason, retry ? undefined : 'operational_check_failed');
        assert.equal(f.state.entryHolds.maintenance_unknown?.retryable, retry ? undefined : false);
        assert.equal(f.calls.broadcasts, 0); assert.equal(f.position.actions.length, 0);
    });
});

test('concurrent funded maintenance actions persist and broadcast only one action', async t => {
    const f = fixture(t); f.values.balance = hex(ethers.utils.parseEther('1'));
    await f.engine.broker.reconcile(null, Date.now());
    await Promise.all([f.engine.broker.action('redeem', 0, Date.now()), f.engine.broker.action('redeem', 0, Date.now())]);
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1); assert.equal(f.position.actions.length, 1);
});

test('failure after preparation cannot be reclassified as a safe funding retry', async t => {
    const f = fixture(t); f.values.balance = hex(ethers.utils.parseEther('1'));
    const event = f.store.event.bind(f.store);
    f.store.event = (type, detail) => {
        if (type === 'redeem_prepared') throw new OperationalError('insufficient_action_gas', 'validation',
            { stage: 'safe_action_prepare' });
        event(type, detail);
    };
    await f.engine.tick();
    assert.equal(f.position.actions[0].status, 'prepared'); assert.equal(f.calls.broadcasts, 0);
    assert.equal(f.position.actionPreparationRetry, undefined);
    assert.equal(f.state.stopped.reason, 'operational_check_failed');
    assert.equal(f.state.entryHolds.maintenance_unknown.retryable, false);
    f.restartBroker(); f.advance(60000); await f.engine.tick();
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 0);
});

test('live action preparation preserves terminal failure cooldown and retry limit', async t => {
    for (const count of [1, 3]) await t.test(String(count), async t => {
        const f = fixture(t); f.values.balance = hex(ethers.utils.parseEther('1'));
        f.position.actions = Array.from({ length: count }, () => ({ kind: 'redeem', status: 'failed', finishedAt: Date.now() }));
        await f.engine.tick();
        assert.equal(f.calls.prepares, 0); assert.equal(f.calls.broadcasts, 0);
        assert.equal(f.state.stopped?.reason, count === 3 ? 'redeem_retry_limit' : undefined);
        f.advance(30000); await f.engine.tick();
        assert.equal(f.calls.prepares, count === 3 ? 0 : 1);
        assert.equal(f.calls.broadcasts, count === 3 ? 0 : 1);
    });
});
