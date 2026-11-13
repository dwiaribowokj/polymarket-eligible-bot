import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../scripts/eligible-live.js';
import { loadEligibleConfig } from '../../src/eligible-live/config.js';
import { ContinuousRecovery } from '../../src/eligible-live/continuous-recovery.js';
import { LiveSupervisor } from '../../src/laya-live/runner.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { Store } from '../../src/restart/store.js';

test('continuous CLI wires supervision and resumes its funded ledger after verified recovery', async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-continuous-cli-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    t.mock.method(globalThis, 'fetch', () => assert.fail('No network in CLI wiring test'));
    t.mock.method(console, 'log', () => {});
    // Keep the real clock/hold recovery; market-history assembly is tested separately.
    t.mock.method(LayaLiveEngine.prototype, 'watch', async () => {});
    const config = loadEligibleConfig({ RESTART_DATA_DIR: dataDir, ELIGIBLE_CONTINUOUS_TRADING: 'true',
        PROXY_WALLET_ADDRESS: `0x${'a'.repeat(40)}` });
    const financialWrite = () => assert.fail('No orders, transactions or transfers in startup');
    let closed = 0, supervised = 0, recovered = 0, released = 0;
    const client = { serverTime: async () => Date.now(), json: async () => ({ blocked: false }),
        rpc: { anchor: { number: 100, hash: `0x${'b'.repeat(64)}` },
            read: async (_stage, task) => task({ getBlock: async number => ({ number, hash: `0x${'b'.repeat(64)}` }) }),
            validate: async () => {} },
        confirmedBlock: async () => 100, balance: async () => 20,
        startBtcFeed() {}, market: async () => ({ slug: 'market', conditionId: 'condition',
            minimum: 5, accepting: true, tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: 20,
            nativeGas: 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => [], ordersAndTrades: async () => ({ orders: [], trades: [] }),
        gasPriceUsd: async () => 1, post: financialWrite, prepareAction: financialWrite,
        close() { closed++; } };
    t.mock.method(ContinuousRecovery.prototype, 'tick', async function () {
        if (!this.store.state.stopped) return false;
        recovered++;
        this.store.state.stopHistory = [{ ...this.store.state.stopped, recoveredAt: Date.now() }];
        this.store.state.stopped = null;
        this.store.save();
        return true;
    });
    t.mock.method(LiveSupervisor.prototype, 'run', async function () {
        supervised++;
        assert.equal(this.continuousTrading, true);
        assert.ok(this.continuousRecovery instanceof ContinuousRecovery);
        assert.ok(this.engine.broker.capitalDeposits.enabled());
        assert.ok(this.engine.broker.externalActivity.enabled());
        assert.ok(this.profitTaking.externalActivity.enabled());
        const state = this.store.state;
        assert.equal(state.stopped, null);
        assert.equal(state.continuousOperation.runtimeId, config.runtimeId);
        assert.equal(state.liveFunding.initialCapital, 20);
        if (supervised >= 2) assert.equal(state.maxDrawdown, 12);
        assert.deepEqual(state.entryHolds || {}, {});
        this.requestStop();
        assert.equal(this.continuousRecovery.closed, true);
    });
    const dependencies = { config, clientFactory: () => client, write() {},
        acquireLock: async () => async () => { released++; } };
    assert.equal(await main(['run', '--live'], dependencies), 0);
    const store = new Store(config.settings, 'pilot', 'late-entry');
    const funding = structuredClone(store.state.liveFunding), start = store.state.startedAt;
    store.state.stopped = { reason: 'operational_check_failed', at: Date.now() };
    store.state.maxDrawdown = 12;
    store.save();
    assert.equal(await main(['run', '--live'], dependencies), 0);
    const held = new Store(config.settings, 'pilot', 'late-entry');
    const now = Date.now() + 1;
    await new Promise(resolve => setTimeout(resolve, 2));
    held.state.stopped = { reason: 'operational_check_failed', at: now };
    held.state.entryHolds = { clock: { firstAt: now, failedAt: now, retryAt: now, attempts: 1, retryable: true,
        error: { code: 'invalid_server_clock', category: 'stale_data', stage: 'server_time' } } };
    held.state.liveClock = { status: 'waiting', outageAt: now, retryAt: now, attempts: 1 };
    held.save();
    assert.equal(await main(['run', '--live'], dependencies), 0);
    const restored = new Store(config.settings, 'pilot', 'late-entry').state;
    assert.equal(recovered, 2); assert.equal(supervised, 3); assert.equal(released, 3); assert.equal(closed, 3);
    assert.equal(restored.startedAt, start); assert.deepEqual(restored.liveFunding, funding);
    assert.equal(restored.maxDrawdown, 12); assert.equal(restored.stopHistory.length, 1);
    assert.equal(restored.liveClock.status, 'verified');
});

test('continuous recovery runs after the serialized financial tick and manual stop drains it', async t => {
    const sequence = [], state = { decisionProvider: 'eligible', cash: 20 };
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const recovery = { tick: async () => {
        sequence.push('recovery'); entered();
        await new Promise(resolve => { release = resolve; });
        sequence.push('recovery_done');
    } };
    const engine = { config: { policy: { provider: 'eligible' } }, tick: async () => sequence.push('engine'),
        nextDelay: () => 1, shutdown: async () => sequence.push('shutdown') };
    const supervisor = new LiveSupervisor({ engine, store: { state, event() {} },
        providers: { active: new Set() }, profitTaking: { tick: async () => { sequence.push('withdrawal'); return false; } },
        continuousRecovery: recovery, continuousTrading: true, diagnostic() {}, probeIntervalMs: 100000 });
    t.after(() => supervisor.requestStop());
    const running = supervisor.run();
    await waiting;
    supervisor.requestStop();
    assert.equal(recovery.closed, true);
    assert.deepEqual(sequence, ['withdrawal', 'engine', 'recovery']);
    release();
    await running;
    assert.deepEqual(sequence, ['withdrawal', 'engine', 'recovery', 'recovery_done', 'shutdown']);
});

test('background health does not interrupt an active recovery account proof', () => {
    const store = { state: { decisionProvider: 'eligible' }, event: () => assert.fail('No extra hold during proof') };
    const supervisor = new LiveSupervisor({ engine: { config: { policy: { provider: 'eligible' } } }, store,
        continuousRecovery: { pending: Promise.resolve() }, providers: {
            preflight: () => assert.fail('Recovery owns its own provider preflight'), active: new Set() },
        continuousTrading: true, now: () => 1000 });
    supervisor.nextProbe = 0;
    supervisor.maybeProbe();
    assert.equal(supervisor.probeInFlight, undefined);
});
