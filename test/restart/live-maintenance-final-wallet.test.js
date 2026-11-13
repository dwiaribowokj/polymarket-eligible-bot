import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { MaintenanceEngine } from '../../src/laya-live/maintenance.js';
import { OperationalError } from '../../src/restart/network.js';
import { holdEntry } from '../../src/laya-live/entry-holds.js';

const hash = byte => `0x${byte.repeat(64)}`;
const secret = 'unpersisted-signed-payload-must-not-appear-in-diagnostics';

function fixture() {
    const now = Date.now(), position = { market: { conditionId: hash('1'), tokens: ['1', '2'],
        end: now - 1000 }, startingCash: 20, holdings: [5, 0], pendingTrades: false,
        orders: [{ orderId: hash('2'), status: 'complete', receiptProvenComplete: true }], actions: [],
        lastDeployed: 0, exposureAt: now, capitalHours: 0 };
    const state = { mode: 'pilot', decisionProvider: 'eligible', position, cash: 20, walletStart: 20,
        walletCashDelta: 0, completed: [], failures: 0, entryHolds: {}, stopped: null };
    const f = { state, position, now, calls: [], snapshots: [], events: [], prepared: 0,
        broadcast: 0, balance: 20, holdings: [5, 0], failure: null, failedRead: null };
    const store = { state, save() { f.snapshots.push(structuredClone(state)); },
        event(type, detail = {}) { f.events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; this.save(); } };
    const read = (name, value) => async () => {
        f.calls.push(name);
        if (f.failure && f.failedRead === name) throw f.failure;
        return typeof value === 'function' ? value() : value;
    };
    const client = {
        confirmedBlock: read('confirmedBlock', 100), balance: read('balance', () => f.balance),
        holdings: read('holdings', () => f.holdings), ordersAndTrades: read('ordersAndTrades', { orders: [], trades: [] }),
        rpc: { anchor: { number: 100, hash: hash('3') } },
        prepareAction: async (_position, kind, amount) => {
            f.prepared++;
            return { kind, amount, hash: hash('4'), status: 'prepared', raw: secret };
        },
        broadcastAction: async action => {
            assert.equal(f.snapshots.at(-1).position.actions[0].hash, action.hash);
            f.broadcast++;
        },
    };
    const settings = { maxDataAgeMs: 5000, continuousTrading: true };
    const broker = new LayaLiveBroker(settings, store, client);
    broker.externalActivity = { enabled: () => true, defer() {
        holdEntry(store, 'external_activity', new OperationalError('external_activity_verifying', 'opportunity'),
            { retryable: true });
    } };
    broker.reconcile = async () => { broker.reconciliationComplete = true; };
    broker.checkWallet = async () => true;
    const engine = Object.assign(Object.create(MaintenanceEngine.prototype), { settings, store, client, broker,
        lastHeartbeat: now, boot: async () => {}, checkClock: async () => {}, pollPayout: async () => {}, markRisk() {},
        async manage(_books, at, proof) {
            if (proof.reconciled && proof.wallet) await broker.action('merge', 1, at);
        } });
    store.save();
    return { ...f, data: f, store, client, broker, engine };
}

test('temporary failures in every final read discard the prepared action and recover on a later maintenance tick', async t => {
    const failures = [
        ['confirmedBlock', 'rpc_reference_unavailable', 'reconciliation'],
        ['balance', 'read_timeout', 'timeout'],
        ['holdings', 'transport_failed', 'transport'],
        ['ordersAndTrades', 'rate_limited', 'rate_limit'],
    ];
    for (const [failedRead, code, category] of failures) await t.test(failedRead, async () => {
        const f = fixture(), data = f.data;
        data.failedRead = failedRead;
        data.failure = Object.assign(new OperationalError(code, category, { stage: 'wallet_read' }),
            { response: secret, requestBody: secret });
        await f.engine.tick(data.now);
        assert.equal(data.prepared, 1); assert.equal(data.broadcast, 0);
        assert.deepEqual(data.position.actions, []); assert.equal(data.state.stopped, null);
        assert.equal(data.state.entryHolds.maintenance_wallet.retryable, true);
        assert.equal(data.state.entryHolds.maintenance_wallet.error.code, code);
        assert.equal(data.state.entryHolds.maintenance_unknown, undefined);
        assert.equal(data.snapshots.every(row => row.position.actions.length === 0), true);
        assert.equal(JSON.stringify(data.events).includes(secret), false);
        assert.equal(data.state.cash, 20); assert.deepEqual(data.position.holdings, [5, 0]);
        assert.equal(f.broker.actionPreparing, false);
        const retryAt = data.state.entryHolds.maintenance_wallet.retryAt;
        data.failure = null;
        await f.engine.tick(retryAt - 1);
        assert.equal(data.prepared, 1); assert.equal(data.broadcast, 0);
        await f.engine.tick(retryAt);
        assert.equal(data.prepared, 2); assert.equal(data.broadcast, 1);
        assert.equal(data.position.actions.length, 1); assert.equal(data.position.actions[0].status, 'pending');
        assert.equal(data.state.entryHolds.maintenance_wallet, undefined);
        assert.equal(data.state.stopped, null); assert.equal(data.state.cash, 20);
    });
});

test('RPC endpoint outages retry but chain identity failures retain their semantic error', async () => {
    const f = fixture(), data = f.data;
    data.failedRead = 'holdings';
    data.failure = new OperationalError('rpc_endpoint_forbidden', 'transport', { httpStatus: 403 });
    assert.equal(await f.broker.freshMaintenanceWallet(data.position), false);
    assert.equal(data.state.entryHolds.maintenance_wallet.retryable, true);
    data.failure = null;
    assert.equal(await f.broker.freshMaintenanceWallet(data.position), true);
    assert.equal(data.state.entryHolds.maintenance_wallet, undefined);
    data.failure = new OperationalError('rpc_wrong_chain', 'reconciliation');
    await assert.rejects(f.broker.freshMaintenanceWallet(data.position), error => error === data.failure);
    assert.equal(data.state.entryHolds.maintenance_wallet, undefined);
    assert.equal(data.broadcast, 0); assert.deepEqual(data.position.actions, []);
});

test('successful RPC transport does not bypass exact wallet reconciliation', async () => {
    const f = fixture(), data = f.data;
    data.balance = 19;
    assert.equal(await f.broker.action('merge', 1, data.now), false);
    assert.equal(data.state.entryHolds.external_activity.retryable, true);
    assert.equal(data.state.entryHolds.maintenance_wallet, undefined);
    assert.equal(data.state.stopped, null); assert.equal(data.broadcast, 0);
    assert.deepEqual(data.position.actions, []); assert.equal(data.state.cash, 20);
});

test('an exception after broadcast begins retains the durable action and unknown transaction stop', async () => {
    const f = fixture(), data = f.data;
    f.client.broadcastAction = async () => { data.broadcast++; throw new OperationalError('read_timeout', 'timeout'); };
    assert.equal(await f.broker.action('merge', 1, data.now), false);
    assert.equal(data.broadcast, 1); assert.equal(data.position.actions.length, 1);
    assert.equal(data.position.actions[0].status, 'unknown');
    assert.equal(data.state.stopped.reason, 'unknown_transaction');
    assert.equal(data.state.entryHolds.maintenance_wallet, undefined);
});
