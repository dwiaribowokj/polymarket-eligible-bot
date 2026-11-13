import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError } from '../../src/restart/network.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';
import { holdEntry } from '../../src/laya-live/entry-holds.js';

function fixture(t, { exposed = false, ended = false, continuousTrading = true } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: 1792367640000 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Continuous read tests must remain offline'));
    const settings = { ...BASELINE, continuousTrading, capital: 20, drawdownStop: 10,
        pilotHours: Infinity, pilotMarkets: Infinity };
    const state = { mode: 'pilot', strategy: 'late-entry', decisionProvider: 'eligible',
        startedAt: Date.now() - 300000, cash: 20, peakEquity: 20, maxDrawdown: 0,
        stopped: null, failures: 0, dataGaps: 0, completed: [], seen: {}, position: null, walletStart: 20 };
    const events = [], calls = { clock: 0, wallet: 0, reconcile: 0, cancel: 0, actions: 0, entries: 0, books: 0, payout: 0 };
    const store = { state, save() {}, event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    const market = { slug: marketSlug('late-entry', settings, Date.now()), conditionId: 'offline-condition',
        open: Date.now() - 240000, end: Date.now() + (ended ? -1 : 60000), tokens: ['1', '2'],
        tick: .01, minimum: 5, accepting: true, fee: { rate: 0, exponent: 1 } };
    const quotes = () => market.tokens.map((tokenId, index) => ({ tokenId, conditionId: market.conditionId,
        tick: .01, timestamp: Date.now(), fetchedAt: Date.now(),
        bids: [{ price: index ? .19 : .79, size: 10 }], asks: [{ price: index ? .2 : .8, size: 10 }] }));
    const client = { startBtcFeed() {}, serverTime: async () => { calls.clock++; return Date.now(); },
        marketInfo: async () => ({}), validateInfo() {}, books: async () => { calls.books++; return quotes(); },
        payout: async () => { calls.payout++; return null; },
        btc: { spot: [], openings: new Map(), assess: () => ({ reason: null }) } };
    const stream = { generation: 1, tokens: market.tokens, snapshot: quotes };
    const config = { settings, policy: { provider: 'eligible', aiSource: 'offline-read-policy' }, ai: {
        latencyMs: 250, shares: 5, entryCap: 5, gasUsd: .05, control: settings,
        dataAgeMs: 5000, decisionMs: 3000, slots: [60, 30], slotToleranceMs: 2000 } };
    const engine = new LayaLiveEngine(config, store, client, stream, {});
    engine.current = market;
    engine.watch = async () => {};
    engine.discover = async () => { calls.entries++; };
    engine.broker.checkWallet = async () => { calls.wallet++; return true; };
    engine.broker.reconcile = async () => { calls.reconcile++; };
    engine.broker.cancelOwned = async () => { calls.cancel++; };
    engine.broker.pending = () => !!state.position;
    engine.broker.action = async () => { calls.actions++; };
    const position = newPosition(market, { cost: 4 }, state, Date.now() - 1000);
    position.holdings = [5, 0]; position.bought = [5, 0]; position.orders = [{ status: 'unknown' }];
    if (exposed) { state.position = position; state.cash = 16; state.seen[market.slug] = { at: position.openedAt }; }
    return { engine, state, store, calls, events, client, config, market, position, quotes, stream,
        advance(ms) { t.mock.timers.setTime(Date.now() + ms); } };
}

test('continuous clock rejects invalid server samples, retries with backoff, and requires fresh proof', async t => {
    for (const fault of ['skew', 'nonfinite', 'payload']) await t.test(fault, async t => {
        const f = fixture(t); let broken = true;
        f.client.serverTime = async () => {
            f.calls.clock++;
            if (broken && fault === 'payload') throw new OperationalError('invalid_api_data', 'validation', { stage: 'server_time' });
            return broken ? fault === 'skew' ? Date.now() + 2001 : NaN : Date.now();
        };
        await f.engine.tick();
        assert.equal(f.state.stopped, null);
        assert.equal(f.state.liveClock.status, 'waiting');
        assert.equal(f.state.entryHolds.clock.retryable, true);
        assert.equal(f.calls.entries, 0);
        assert.equal(f.engine.clockAllowsEntry(), false);
        f.advance(4999); await f.engine.tick(); assert.equal(f.calls.clock, 1);
        f.advance(1); await f.engine.tick(); assert.equal(f.calls.clock, 2);
        assert.equal(f.state.liveClock.retryAt - Date.now(), 10000);
        broken = false; f.advance(9999); await f.engine.tick(); assert.equal(f.calls.entries, 0);
        f.advance(1); await f.engine.tick();
        assert.equal(f.calls.clock, 3); assert.equal(f.calls.entries, 1);
        assert.equal(f.state.liveClock.status, 'verified'); assert.equal(f.state.entryHolds.clock, undefined);
        assert.equal(f.state.stopped, null);
    });
});

test('continuous clock never repairs malformed persisted clock/hold state or clears old failed evidence', async t => {
    for (const mutation of [
        state => { state.liveClock = { status: 'waiting', retryAt: 'bad', outageAt: Date.now() }; },
        state => { state.liveClock = { status: 'verified', verifiedAt: 'bad' }; },
        state => { state.entryHolds = []; },
        state => { state.entryHolds = { clock: { retryable: true, retryAt: Date.now() } }; },
    ]) await t.test(String(mutation), async t => {
        const f = fixture(t); mutation(f.state);
        const before = structuredClone({ liveClock: f.state.liveClock, entryHolds: f.state.entryHolds });
        await f.engine.tick();
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.deepEqual({ liveClock: f.state.liveClock, entryHolds: f.state.entryHolds }, before);
        assert.equal(f.calls.clock, 0); assert.equal(f.calls.entries, 0);
    });
    await t.test('old failed evidence', async t => {
        const f = fixture(t);
        f.state.liveClock = { status: 'failed', failedAt: Date.now() - 10, error: { code: 'invalid_server_clock' } };
        f.state.stopped = { reason: 'operational_check_failed', at: Date.now() - 10 };
        const before = structuredClone({ liveClock: f.state.liveClock, stopped: f.state.stopped });
        await f.engine.tick();
        assert.deepEqual({ liveClock: f.state.liveClock, stopped: f.state.stopped }, before);
        assert.equal(f.calls.clock, 0); assert.equal(f.calls.entries, 0);
    });
});

test('continuous clock still stops unknown failures and default clock validation remains strict', async t => {
    for (const [continuousTrading, error] of [[true, new Error('unknown_problem')],
        [true, new OperationalError('invalid_api_data', 'validation', { stage: 'account_read' })],
        [false, new OperationalError('invalid_server_clock', 'stale_data')]]) await t.test(String(error), async t => {
        const f = fixture(t, { continuousTrading }); f.client.serverTime = async () => { throw error; };
        await f.engine.tick();
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.liveClock.status, 'failed'); assert.equal(f.calls.entries, 0);
    });
});

test('continuous position mark responses retry and recover without altering unknown order ownership', async t => {
    for (const fault of ['future', 'malformed', 'identity']) await t.test(fault, async t => {
        const f = fixture(t, { exposed: true }); let broken = true;
        const orders = structuredClone(f.position.orders);
        f.client.books = async () => {
            f.calls.books++;
            if (broken && fault === 'identity') throw new OperationalError('market_constraints_changed', 'validation', { stage: 'book_read' });
            const books = f.quotes();
            if (broken && fault === 'future') books[0].timestamp = Date.now() + 1;
            if (broken && fault === 'malformed') books[0].bids[0].price = NaN;
            return books;
        };
        await f.engine.tick();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_mark.retryable, true);
        assert.equal(f.state.lastEquity, undefined); assert.equal(f.state.maxDrawdown, 0);
        broken = false; f.advance(4999); await f.engine.tick(); assert.equal(f.calls.books, 1);
        f.advance(1); await f.engine.tick();
        assert.equal(f.calls.books, 2); assert.equal(f.state.entryHolds.maintenance_mark, undefined);
        assert.equal(f.state.lastEquity, 19.95); assert.equal(f.state.stopped, null);
        assert.deepEqual(f.position.orders, orders); assert.equal(f.calls.actions, 0); assert.equal(f.calls.entries, 0);
    });
});

test('continuous payout rejects invalid response until a new valid payout', async t => {
    const f = fixture(t, { exposed: true, ended: true }); let broken = true;
    f.client.payout = async () => { f.calls.payout++; return broken ? [.7, .7] : [1, 0]; };
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.position.payout, null);
    assert.equal(f.state.entryHolds.maintenance_payout.retryable, true);
    broken = false; f.advance(30000); await f.engine.tick();
    assert.deepEqual(f.position.payout, [1, 0]); assert.equal(f.state.entryHolds.maintenance_payout, undefined);
    assert.equal(f.calls.actions, 0);
});

test('continuous persisted payout corruption remains permanent', async t => {
    const f = fixture(t, { exposed: true, ended: true }); f.position.payout = [.7, .7];
    await f.engine.tick();
    assert.equal(f.state.stopped.reason, 'operational_check_failed');
    assert.equal(f.state.entryHolds.maintenance_payout.retryable, false);
    assert.deepEqual(f.position.payout, [.7, .7]); assert.equal(f.calls.payout, 0);
});

test('continuous maintenance preserves reconciliation, wallet, and accounting failures as permanent', async t => {
    for (const kind of ['reconciliation', 'wallet', 'accounting']) await t.test(kind, async t => {
        const f = fixture(t, { exposed: true });
        if (kind === 'reconciliation') f.engine.broker.reconcile = async () => { throw new OperationalError('invalid_api_data', 'validation'); };
        if (kind === 'wallet') f.engine.broker.checkWallet = async () => { throw new OperationalError('wallet_ledger_mismatch', 'reconciliation'); };
        if (kind === 'accounting') f.position.holdings[0] = -1;
        await f.engine.tick();
        const key = kind === 'reconciliation' ? 'maintenance_reconcile' : kind === 'wallet' ? 'maintenance_wallet' : 'risk_mark';
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.entryHolds[key].retryable, false); assert.equal(f.calls.actions, 0);
    });
});

test('continuous wallet eth_call rejections wait for fresh proof without latching a permanent stop', async t => {
    for (const exposed of [false, true]) await t.test(String(exposed), async t => {
        const f = fixture(t, { exposed }); let broken = true;
        const orders = structuredClone(f.position.orders);
        f.engine.broker.checkWallet = async () => {
            f.calls.wallet++;
            if (broken) throw new OperationalError('rpc_rejected', 'contract', {
                stage: 'wallet_balance', rpcMethod: 'eth_call', rpcReason: 'execution_reverted', rpcCode: 3,
            });
            return true;
        };
        await f.engine.tick();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_wallet.retryable, true);
        assert.equal(f.calls.entries, 0); assert.equal(f.calls.actions, 0);
        for (let i = 0; i < 8; i++) {
            f.advance(f.state.entryHolds.maintenance_wallet.retryAt - Date.now());
            await f.engine.tick();
            assert.equal(f.state.stopped, null); assert.equal(f.calls.entries, 0); assert.equal(f.calls.actions, 0);
        }
        assert.equal(f.state.entryHolds.maintenance_wallet.retryAt - Date.now(), 60000);
        broken = false;
        f.advance(59999); await f.engine.tick(); assert.ok(f.state.entryHolds.maintenance_wallet);
        f.advance(1); await f.engine.tick();
        assert.equal(f.state.entryHolds.maintenance_wallet, undefined); assert.equal(f.state.stopped, null);
        assert.equal(f.calls.entries, exposed ? 0 : 1); assert.deepEqual(f.position.orders, orders);
    });
});

test('wallet retry scope excludes writes, identity errors, missing method evidence, and noncontinuous mode', async t => {
    const cases = [
        { continuousTrading: false }, { rpcMethod: 'eth_sendRawTransaction' }, { rpcMethod: undefined },
        { stage: 'safe_action_prepare' }, { code: 'rpc_block_mismatch' }, { code: 'wallet_ledger_mismatch', category: 'reconciliation' },
    ];
    for (const value of cases) await t.test(JSON.stringify(value), async t => {
        const f = fixture(t, { continuousTrading: value.continuousTrading ?? true });
        const error = new OperationalError(value.code ?? 'rpc_rejected', value.category ?? 'contract', {
            stage: 'wallet_balance', rpcMethod: 'eth_call', ...value,
        });
        f.engine.broker.checkWallet = async () => { throw error; };
        await f.engine.tick();
        assert.equal(f.state.stopped.reason, 'operational_check_failed');
        assert.equal(f.state.entryHolds.maintenance_wallet.retryable, false); assert.equal(f.calls.entries, 0);
    });
});

test('continuous payout eth_call rejection leaves inventory unresolved until official read succeeds', async t => {
    const f = fixture(t, { exposed: true, ended: true }); let broken = true;
    f.client.payout = async () => {
        if (broken) throw new OperationalError('rpc_rejected', 'contract', { stage: 'official_payout', rpcMethod: 'eth_call' });
        return [0, 1];
    };
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_payout.retryable, true);
    assert.equal(f.position.payout, null); assert.equal(f.calls.actions, 0);
    broken = false; f.advance(30000); await f.engine.tick();
    assert.deepEqual(f.position.payout, [0, 1]); assert.equal(f.state.entryHolds.maintenance_payout, undefined);
    assert.equal(f.calls.actions, 0); assert.equal(f.position.orders[0].status, 'unknown');
});

test('continuous market-watch validation needs a successful replacement read before entry', async t => {
    const f = fixture(t); let broken = true, watches = 0;
    f.engine.watch = async () => { watches++; if (broken) throw new Error('market_identity_mismatch'); };
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.market_watch.retryable, true);
    assert.equal(f.calls.entries, 0);
    broken = false; f.advance(4999); await f.engine.tick(); assert.equal(watches, 1);
    f.advance(1); await f.engine.tick();
    assert.equal(watches, 2); assert.equal(f.calls.entries, 1); assert.equal(f.state.entryHolds.market_watch, undefined);
});

test('continuous recovery can recheck read holds behind an eligible stop while entry stays blocked', async t => {
    for (const blocked of [false, 'manual_stop', 'reconciliation']) await t.test(String(blocked), async t => {
        const f = fixture(t), id = 'e'.repeat(16);
        Object.assign(f.config, { id, runtimeId: id }); f.config.policy.continuousTrading = true;
        Object.assign(f.state, { baseline: id, continuousOperation: { enabledAt: f.state.startedAt, runtimeId: id },
            liveFunding: { initialCapital: 20 }, walletCashDelta: 0,
            stopped: { reason: blocked === 'manual_stop' ? 'manual_stop' : 'operational_check_failed', at: Date.now() } });
        if (blocked === 'reconciliation') f.state.reconciliationFaults = { unresolved: true };
        holdEntry(f.store, 'entry_read', new OperationalError('metadata_mismatch', 'validation', { stage: 'metadata_read' }),
            { now: Date.now(), retryable: true });
        const stop = structuredClone(f.state.stopped); let watches = 0;
        f.engine.watch = async () => { watches++; };
        f.advance(5000); await f.engine.tick();
        assert.equal(watches, blocked ? 0 : 1);
        assert.equal(!!f.state.entryHolds.entry_read, !!blocked);
        assert.equal(f.calls.entries, 0); assert.deepEqual(f.state.stopped, stop);
    });
});

test('startup continuous read recovery performs no financial work and stops when closed during a read', async t => {
    for (const closeAt of [null, 'clock', 'watch', 'metadata']) await t.test(String(closeAt), async t => {
        const f = fixture(t), id = 'e'.repeat(16);
        Object.assign(f.config, { id, runtimeId: id }); f.config.policy.continuousTrading = true;
        Object.assign(f.state, { baseline: id, continuousOperation: { enabledAt: f.state.startedAt, runtimeId: id },
            liveFunding: { initialCapital: 20 }, walletCashDelta: 0,
            stopped: { reason: 'operational_check_failed', at: Date.now() } });
        holdEntry(f.store, 'entry_read', new OperationalError('metadata_mismatch', 'validation', { stage: 'metadata_read' }),
            { now: Date.now(), retryable: true });
        const stopped = structuredClone(f.state.stopped), sequence = [];
        f.client.serverTime = async () => { sequence.push('clock'); if (closeAt === 'clock') f.engine.closed = true; return Date.now(); };
        f.engine.watch = async () => { sequence.push('watch'); if (closeAt === 'watch') f.engine.closed = true; };
        f.client.marketInfo = async () => { sequence.push('metadata'); if (closeAt === 'metadata') f.engine.closed = true; return {}; };
        f.advance(5000);
        assert.equal(await f.engine.recoverContinuousReads(), closeAt === null);
        assert.equal(!!f.state.entryHolds.entry_read, closeAt !== null);
        assert.deepEqual(f.state.stopped, stopped);
        assert.equal(f.calls.wallet, 0); assert.equal(f.calls.reconcile, 0); assert.equal(f.calls.cancel, 0);
        assert.equal(f.calls.actions, 0); assert.equal(f.calls.entries, 0);
        assert.deepEqual(sequence, closeAt === 'clock' ? ['clock'] : closeAt === 'watch' ? ['clock', 'watch']
            : ['clock', 'watch', 'metadata']);
    });
});

test('continuous entry metadata and future REST responses consume a slot and require fresh matching reads', async t => {
    for (const fault of ['metadata', 'future']) await t.test(fault, async t => {
        const f = fixture(t); let broken = true, observations = 0, accepted = 0;
        f.client.validateInfo = () => { if (broken && fault === 'metadata') throw new OperationalError('metadata_mismatch', 'validation', { stage: 'metadata_read' }); };
        f.client.books = async () => { const books = f.quotes(); if (broken && fault === 'future') books[0].timestamp++; return books; };
        f.engine.observe = async () => {
            observations++; await f.engine.entryMetadata(f.market); await f.engine.entryBooks(f.market); accepted++;
        };
        await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
        const first = `${f.market.slug}:60`;
        assert.equal(f.state.stopped, null); assert.equal(f.state.ai.slots[first].status, 'invalid');
        assert.equal(f.state.entryHolds.entry_read.retryable, true); assert.equal(accepted, 0);
        f.advance(5000); await f.engine.recoverEntryReads();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.entry_read.retryable, true);
        broken = false; f.advance(10000); await f.engine.recoverEntryReads();
        assert.equal(f.state.entryHolds.entry_read, undefined);
        await LayaLiveEngine.prototype.discover.call(f.engine); assert.equal(observations, 1);
        f.advance(15000); await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
        assert.equal(observations, 2); assert.equal(accepted, 1); assert.equal(f.state.stopped, null);
        assert.deepEqual(f.state.seen, {}); assert.equal(f.state.position, null);
    });
});

test('continuous future feed data and wrong source consume only the current unreserved slot', async t => {
    for (const fault of ['future', 'source']) await t.test(fault, async t => {
        const f = fixture(t); let accepted = 0;
        if (fault === 'future') f.client.btc.spot = [{ at: Date.now() + 1, receivedAt: Date.now() + 1, value: 83000 }];
        else f.market.reference = { source: 'wrong_source' };
        f.engine.observe = async () => { f.engine.assertSignal(f.market, { index: 0 }, Date.now()); accepted++; };
        await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
        assert.equal(f.state.stopped, null); assert.equal(accepted, 0);
        assert.equal(f.state.ai.slots[`${f.market.slug}:60`].status, 'invalid');
        f.client.btc.spot = []; f.market.reference = { source: 'chainlink_twap_60s' };
        f.advance(30000); await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
        assert.equal(accepted, 1); assert.equal(f.state.stopped, null); assert.equal(f.state.position, null);
    });
});

test('continuous execution rejects a changed book before reservation but retains strict post-reservation stop', async t => {
    for (const exposed of [false, true]) await t.test(String(exposed), async t => {
        const f = fixture(t, { exposed });
        await f.engine.checkClock();
        const snapshot = { snapshotId: 'read-test', provider: 'eligible', at: Date.now() - 250,
            observedAt: Date.now() - 250, decisionReceivedAt: Date.now() - 250,
            validation: { at: Date.now(), generation: 1, identity: metadataIdentity(f.market) }, allowed: [{ index: 0, price: .8 }] };
        f.engine.entryContext = { market: f.market, snapshot, decision: { status: 'ok', snapshotId: 'read-test',
            provider: 'eligible', model: 'deterministic-eligible-v1', inferenceAttempted: false, action: 'BUY_UP' }, wallet: {} };
        f.engine.broker.assertEntryWallet = () => {};
        const spec = { index: 0, tokenId: '1', kind: 'taker', side: 'BUY', shares: 5, price: .8 };
        let broken = true;
        f.stream.snapshot = () => { const books = f.quotes(); if (broken) books[0].tokenId = 'wrong'; return books; };
        await assert.rejects(f.engine.validate(spec), /execution_token_mismatch/);
        assert.equal(f.state.stopped?.reason ?? null, exposed ? 'stale_or_invalid_execution_data' : null);
        if (!exposed) {
            broken = false;
            f.engine.entryContext.wallet = { balance: 20 };
            await assert.doesNotReject(f.engine.validate(spec));
        } else {
            assert.equal(f.state.position, f.position); assert.equal(f.position.orders[0].status, 'unknown');
        }
        assert.equal(f.calls.actions, 0);
    });
});

test('settled continuous losses complete the ledger beyond the drawdown threshold without a new stop', async t => {
    const f = fixture(t, { exposed: true, ended: true });
    Object.assign(f.state, { cash: 7, peakEquity: 20, maxDrawdown: 0 });
    Object.assign(f.position, { holdings: [0, 0], payout: [0, 1], startingCash: 12 });
    f.position.orders = [{ status: 'complete', settled: 5, shares: 5 }];
    const settings = f.engine.settings;
    f.engine.finish(Date.now());
    assert.equal(f.state.position, null); assert.equal(f.state.completed.length, 1);
    assert.equal(f.state.completed[0].pnl, -5); assert.deepEqual(f.state.completed[0].payout, [0, 1]);
    assert.equal(f.state.peakEquity, 20); assert.equal(f.state.lastEquity, 7); assert.equal(f.state.maxDrawdown, 13);
    assert.equal(f.state.stopped, null); assert.equal(f.state.liveRiskStop, undefined);
    assert.equal(f.state.liveRiskThreshold.drawdown, 13);
    assert.equal(f.engine.settings, settings); assert.equal(settings.drawdownStop, 10);
    assert.equal(f.events.filter(event => event.type === 'market_complete').length, 1);
});
