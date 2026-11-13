import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { holdEntry } from '../../src/laya-live/entry-holds.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError } from '../../src/restart/network.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';

function fixture(t, { elapsed = 210000, settings: overrides = {}, provider = 'eligible' } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 + elapsed });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Scheduling tests must remain offline'));
    const settings = { ...BASELINE, continuousTrading: true, automaticManualActivity: true,
        capital: 20, drawdownStop: 10, pilotHours: Infinity, pilotMarkets: Infinity, ...overrides };
    const state = { mode: 'pilot', strategy: 'late-entry', decisionProvider: provider,
        startedAt: Date.now() - 300000, cash: 20, peakEquity: 20, lastEquity: 20, maxDrawdown: 0,
        stopped: null, failures: 0, dataGaps: 0, completed: [], seen: {}, position: null, walletStart: 20 };
    const events = [], sequence = [], calls = { wallet: 0, observe: 0, reconcile: 0, saves: 0 };
    const store = { state, save() { calls.saves++; },
        event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    const market = { slug: marketSlug('late-entry', settings, Date.now()), conditionId: 'offline-condition',
        open: 1800000000000, end: 1800000300000, tokens: ['1', '2'], fee: { rate: 0, exponent: 1 } };
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(),
        books: async () => [0, 1].map(() => ({ timestamp: Date.now(), fetchedAt: Date.now(),
            bids: [{ price: .8, size: 10 }], asks: [{ price: .81, size: 10 }] })),
        payout: async () => null };
    const config = { settings, policy: { provider, aiSource: 'offline-scheduling' },
        ai: { latencyMs: 250, shares: 5, entryCap: 5, gasUsd: .05, control: settings,
            dataAgeMs: 5000, decisionMs: 3000, slots: [90, 60, 30], slotToleranceMs: 2000 } };
    const engine = new LayaLiveEngine(config, store, client, {}, {});
    engine.current = market;
    engine.watch = async () => {};
    engine.observe = async () => { calls.observe++; sequence.push('observe'); };
    engine.broker.checkWallet = async () => { calls.wallet++; sequence.push('wallet'); return true; };
    engine.broker.reconcile = async () => { calls.reconcile++; sequence.push('reconcile'); };
    engine.broker.cancelOwned = async () => {};
    engine.broker.pending = () => !!state.position;
    return { engine, state, store, calls, events, sequence, config, client, market,
        advance(ms) { t.mock.timers.setTime(Date.now() + ms); } };
}

test('a due slot runs after local risk evaluation and before a slow full wallet audit, without replay', async t => {
    const f = fixture(t);
    f.state.lastEquity = 19;
    f.engine.observe = async () => {
        assert.equal(f.state.lastEquity, 20);
        assert.equal(f.calls.wallet, 0);
        f.calls.observe++; f.sequence.push('observe');
    };
    f.engine.broker.checkWallet = async () => {
        f.calls.wallet++; f.sequence.push('wallet');
        assert.equal(f.calls.observe, 1);
        f.advance(5000);
        return true;
    };
    await f.engine.tick();
    assert.deepEqual(f.sequence, ['observe', 'wallet']);
    assert.equal(f.state.ai.slots[`${f.market.slug}:90`].timing.slotLatenessMs, 0);
    await f.engine.tick();
    assert.equal(f.calls.observe, 1); assert.equal(f.calls.wallet, 1);
});

test('an entry position defers the bulk audit to normal position reconciliation on the next tick', async t => {
    const f = fixture(t);
    f.engine.observe = async () => {
        f.sequence.push('observe');
        const p = f.state.position = newPosition(f.market, { cost: 4 }, f.state, Date.now());
        p.holdings = [5, 0]; p.bought = [5, 0]; p.orders = [{ status: 'unknown' }];
        f.state.cash = 16;
    };
    await f.engine.tick();
    assert.deepEqual(f.sequence, ['observe']);
    assert.equal(f.engine.lastFlatWalletAuditAt, undefined);
    f.advance(1000); await f.engine.tick();
    assert.deepEqual(f.sequence, ['observe', 'reconcile', 'wallet']);
    assert.equal(f.calls.reconcile, 1); assert.equal(f.calls.wallet, 1);
});

test('flat successful audits use a 15-second cadence and process restart requires a fresh audit', async t => {
    const f = fixture(t, { elapsed: 60000 });
    await f.engine.tick();
    const auditedAt = f.engine.lastFlatWalletAuditAt;
    f.advance(14999); await f.engine.tick();
    assert.equal(f.calls.wallet, 1); assert.equal(f.engine.lastFlatWalletAuditAt, auditedAt);
    f.advance(1); await f.engine.tick();
    assert.equal(f.calls.wallet, 2);
    assert.equal(f.state.lastFlatWalletAuditAt, undefined);
    assert.equal(f.state.flatWalletDeferredAt, undefined);
    const restarted = new LayaLiveEngine(f.config, f.store, f.client, {}, {});
    restarted.current = f.market; restarted.watch = async () => {};
    restarted.broker.checkWallet = f.engine.broker.checkWallet;
    await restarted.tick();
    assert.equal(f.calls.wallet, 3);
    assert.equal(restarted.flatWalletDeferredAt, null);
});

test('an upcoming unconsumed slot defers a due audit from ten seconds before entry', async t => {
    const f = fixture(t, { elapsed: 199999 });
    await f.engine.checkClock();
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), false);
    f.advance(1); await f.engine.tick();
    assert.equal(f.calls.wallet, 0); assert.equal(f.calls.observe, 0);
    assert.equal(f.engine.lastFlatWalletAuditAt, undefined);
    f.advance(9999); await f.engine.tick();
    assert.equal(f.calls.wallet, 0); assert.equal(f.calls.observe, 0);
    f.advance(1); await f.engine.tick();
    assert.deepEqual(f.sequence, ['observe', 'wallet']);
    assert.equal(f.engine.lastFlatWalletAuditAt, Date.now());
});

test('unconsumed slot deferral includes the two-second tolerance and cannot exceed thirty seconds', async t => {
    const f = fixture(t);
    await f.engine.checkClock();
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), true);
    f.advance(2000);
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), true);
    f.advance(1);
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), false);
    f.engine.nextFlatEntrySlot = () => Date.now() + 5000;
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), true);
    f.advance(29999); await f.engine.checkClock();
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), true);
    f.advance(1);
    assert.equal(f.engine.deferFlatWalletAudit(Date.now()), false);
    assert.equal(f.engine.lastFlatWalletAuditAt, undefined);
});

test('holds, stops, risk latches, frozen state, withdrawal and reconciliation faults bypass scheduling', async t => {
    const cases = {
        hold: f => holdEntry(f.store, 'provider_semantics', new OperationalError('invalid_provider_output', 'validation')),
        stop: f => { f.state.stopped = { reason: 'operational_check_failed', at: Date.now() }; },
        risk: f => { f.state.liveRiskStop = { reason: 'capital_exhausted', at: Date.now() }; },
        frozen: f => { f.state.frozenAt = Date.now(); },
        withdrawal: f => { f.state.profitTaking = { pending: true }; },
        fault: f => { f.state.reconciliationFaults = { wallet_ledger_mismatch: {} }; },
        malformedFault: f => { f.state.reconciliationFaults = []; },
        closed: f => { f.engine.closed = true; },
    };
    for (const [name, mutate] of Object.entries(cases)) await t.test(name, async t => {
        const f = fixture(t);
        await f.engine.checkClock();
        f.engine.lastFlatWalletAuditAt = Date.now();
        f.engine.flatWalletDeferredAt = Date.now();
        mutate(f);
        assert.equal(f.engine.prioritizeFlatEntry(Date.now()), false);
        assert.equal(f.engine.deferFlatWalletAudit(Date.now()), false);
        assert.equal(f.engine.flatWalletDeferredAt, null);
        await f.engine.tick();
        assert.equal(f.calls.wallet, 1);
        assert.equal(f.sequence[0], 'wallet');
    });
});

test('invalid flat accounting is held before a due slot and still receives a wallet diagnostic', async t => {
    const f = fixture(t); f.state.cash = NaN;
    await f.engine.tick();
    assert.equal(f.state.stopped.reason, 'operational_check_failed');
    assert.equal(f.calls.observe, 0); assert.equal(f.calls.wallet, 1);
    assert.equal(f.state.entryHolds.risk_mark.retryable, false);
});

test('wallet read recovery keeps its retry timer and only a real successful audit clears the hold', async t => {
    const f = fixture(t, { elapsed: 200000 });
    holdEntry(f.store, 'maintenance_wallet', new OperationalError('read_timeout', 'timeout'), { retryable: true });
    const hold = structuredClone(f.state.entryHolds.maintenance_wallet);
    await f.engine.tick();
    assert.equal(f.calls.wallet, 0); assert.equal(f.engine.lastFlatWalletAuditAt, undefined);
    assert.deepEqual(f.state.entryHolds.maintenance_wallet, hold);
    f.advance(4999); await f.engine.tick();
    assert.equal(f.calls.wallet, 0);
    f.advance(1); await f.engine.tick();
    assert.equal(f.calls.wallet, 1); assert.equal(f.state.entryHolds.maintenance_wallet, undefined);
    assert.equal(f.engine.lastFlatWalletAuditAt, Date.now());
});

test('false and failed wallet reads never establish an audit cadence or erase independent holds', async t => {
    for (const result of ['false', 'failure']) await t.test(result, async t => {
        const f = fixture(t, { elapsed: 60000 });
        holdEntry(f.store, 'maintenance_mark', new OperationalError('read_timeout', 'timeout'), { retryable: true });
        f.engine.broker.checkWallet = async () => {
            f.calls.wallet++;
            if (result === 'failure') throw new OperationalError('read_timeout', 'timeout');
            return false;
        };
        await f.engine.tick();
        assert.equal(f.engine.lastFlatWalletAuditAt, undefined);
        assert.equal(f.calls.observe, 0);
        assert.ok(f.state.entryHolds.maintenance_mark);
        if (result === 'failure') assert.ok(f.state.entryHolds.maintenance_wallet);
    });
});

test('other modes retain wallet-before-discovery on every flat tick', async t => {
    for (const options of [{ settings: { automaticManualActivity: false } },
        { settings: { continuousTrading: false } }, { provider: 'laya' }]) await t.test(JSON.stringify(options), async t => {
        const f = fixture(t, options);
        await f.engine.tick();
        assert.deepEqual(f.sequence, ['wallet', 'observe']);
        f.advance(100); await f.engine.tick();
        assert.equal(f.calls.wallet, 2); assert.equal(f.calls.observe, 1);
        assert.equal(f.engine.nextDelay(), 100);
    });
});

test('eligible idle flat ticks slow to one second while near-slot and recovery timing stay responsive', async t => {
    const f = fixture(t, { elapsed: 60000 });
    await f.engine.checkClock();
    assert.equal(f.engine.nextDelay(), 1000);
    f.advance(140000); await f.engine.checkClock();
    assert.equal(f.engine.nextDelay(), 100);
    f.engine.ai.slots[`${f.market.slug}:90`] = { status: 'reserved' };
    assert.equal(f.engine.nextDelay(), 1000);
    f.engine.broker.rpcRetryAt = Date.now() + 50;
    assert.equal(f.engine.nextDelay(), 50);
    f.engine.broker.rpcRetryAt = 0;
    holdEntry(f.store, 'maintenance_wallet', new OperationalError('read_timeout', 'timeout'), { retryable: true });
    assert.equal(f.engine.nextDelay(), 100);
});
