import test from 'node:test';
import assert from 'node:assert/strict';
import { LayaLiveEngine, entryGuard } from '../../src/laya-live/engine.js';
import { entryHeld, holdEntry, temporaryReadFailure } from '../../src/laya-live/entry-holds.js';
import { BASELINE } from '../../src/restart/config.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';
import { OperationalError } from '../../src/restart/network.js';
import { BtcSignal } from '../../src/laya-live/signal.js';

function fixture(t, { ended = false, pending = true } = {}) {
    t.mock.timers.enable({ apis: ['Date'], now: 1792367640000 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Offline resilience tests must not access the network'));
    const settings = { ...BASELINE, capital: 20, drawdownStop: 2, pilotHours: Infinity, pilotMarkets: Infinity };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: Date.now() - 300000,
        cash: 16, peakEquity: 20, lastEquity: 20, maxDrawdown: 0, stopped: null, failures: 0,
        dataGaps: 0, completed: [], seen: { held: { snapshotId: 'original' } }, walletStart: 20 };
    const events = [], calls = { books: 0, reconcile: 0, wallet: 0, payout: 0, actions: 0, discover: 0, cancel: 0 };
    const store = { state, save() {}, event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    const quotes = () => [0, 1].map(() => ({ timestamp: Date.now(), fetchedAt: Date.now(),
        bids: [{ price: .8, size: 10 }], asks: [{ price: .81, size: 10 }] }));
    const client = { startBtcFeed() {}, serverTime: async () => Date.now(),
        books: async () => { calls.books++; return quotes(); },
        payout: async () => { calls.payout++; return null; } };
    const config = { settings, policy: { aiSource: 'offline-resilience' },
        ai: { dataAgeMs: 5000, decisionMs: 3000, slots: [60], slotToleranceMs: 2000 } };
    const engine = new LayaLiveEngine(config, store, client, {}, {});
    const market = { slug: 'held', conditionId: 'official-condition', open: Date.now() - 240000,
        end: Date.now() + (ended ? -1 : 60000), tokens: ['1', '2'], fee: { rate: .07, exponent: 1 } };
    const position = state.position = newPosition(market, { cost: 4 }, state, Date.now() - 1000);
    position.holdings = [5, 0]; position.bought = [5, 0]; position.orders = [{ status: pending ? 'unknown' : 'complete' }];
    engine.watch = async () => {};
    engine.discover = async () => { calls.discover++; };
    engine.broker.pending = () => pending;
    engine.broker.reconcile = async () => { calls.reconcile++; };
    engine.broker.checkWallet = async () => { calls.wallet++; return true; };
    engine.broker.cancelOwned = async () => { calls.cancel++; };
    engine.broker.action = async () => { calls.actions++; };
    return { engine, state, store, position, client, calls, events, quotes,
        advance(ms) { t.mock.timers.setTime(Date.now() + ms); } };
}

test('a quote outage holds entry across many exposed ticks without inventing drawdown and recovers from fresh books', async t => {
    const f = fixture(t), before = structuredClone({ startedAt: f.state.startedAt, seen: f.state.seen, ai: f.state.ai });
    let offline = true;
    f.client.books = async () => { f.calls.books++; if (offline) throw new OperationalError('read_timeout', 'timeout'); return f.quotes(); };
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_mark.retryable, true);
    assert.equal(f.state.lastEquity, 20); assert.equal(f.state.maxDrawdown, 0);
    for (let i = 0; i < 20; i++) { f.advance(100); await f.engine.tick(); }
    assert.equal(f.calls.books, 1); assert.equal(f.calls.reconcile, 21); assert.equal(f.calls.wallet, 21);
    assert.equal(f.calls.actions, 0); assert.equal(f.calls.discover, 0);
    offline = false; f.advance(3000); await f.engine.tick();
    assert.equal(f.calls.books, 2); assert.equal(f.state.entryHolds.maintenance_mark, undefined);
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, f.position);
    assert.ok(f.state.lastEquity > 19.9); assert.ok(f.state.maxDrawdown < .1);
    assert.deepEqual({ startedAt: f.state.startedAt, seen: f.state.seen, ai: f.state.ai }, before);
});

test('official payout read retries while reconciliation continues and unknown orders are never resubmitted', async t => {
    const f = fixture(t, { ended: true }); let offline = true;
    f.client.payout = async () => { f.calls.payout++; if (offline) throw new OperationalError('rpc_unavailable', 'transport'); return [1, 0]; };
    const order = structuredClone(f.position.orders[0]);
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_payout.retryable, true);
    assert.equal(f.state.lastEquity, 20); assert.equal(f.state.maxDrawdown, 0);
    f.advance(1000); await f.engine.tick(); assert.equal(f.calls.payout, 1);
    offline = false; f.advance(29000); await f.engine.tick();
    assert.equal(f.calls.payout, 2); assert.deepEqual(f.position.payout, [1, 0]);
    assert.equal(f.state.entryHolds.maintenance_payout, undefined); assert.equal(f.state.entryHolds.maintenance_mark, undefined);
    assert.equal(f.state.lastEquity, 21); assert.equal(f.calls.reconcile, 3); assert.equal(f.calls.wallet, 3);
    assert.equal(f.calls.actions, 0); assert.deepEqual(f.position.orders[0], order);
    assert.ok(f.state.seen.held); assert.equal(f.calls.discover, 0);
});

test('a failed reconciliation defers wallet mismatch validation and writes while independent payout polling continues', async t => {
    const f = fixture(t, { ended: true, pending: false }); let offline = true;
    f.engine.broker.reconcile = async () => { f.calls.reconcile++; if (offline) throw new OperationalError('read_timeout', 'timeout'); };
    f.client.payout = async () => { f.calls.payout++; return [1, 0]; };
    await f.engine.tick();
    assert.equal(f.calls.payout, 1); assert.equal(f.calls.wallet, 0); assert.equal(f.calls.actions, 0);
    assert.equal(f.state.stopped, null); assert.equal(f.state.lastEquity, 20);
    f.advance(4999); await f.engine.tick(); assert.equal(f.calls.reconcile, 1);
    offline = false; f.advance(1); await f.engine.tick();
    assert.equal(f.calls.reconcile, 2); assert.equal(f.calls.wallet, 1); assert.equal(f.calls.actions, 1);
    assert.equal(f.state.lastEquity, 21); assert.equal(f.state.entryHolds.maintenance_reconcile, undefined);
});

test('incomplete broker reconciliation keeps reads and official resolution running without using incomplete holdings', async t => {
    const f = fixture(t, { ended: true, pending: false });
    f.engine.broker.reconciliationComplete = false;
    f.client.payout = async () => { f.calls.payout++; return [0, 1]; };
    await f.engine.tick();
    assert.deepEqual(f.position.payout, [0, 1]); assert.equal(f.calls.wallet, 0); assert.equal(f.calls.actions, 0);
    assert.equal(f.state.stopped, null); assert.equal(f.state.lastEquity, 20);
    f.engine.broker.reconciliationComplete = true; f.advance(1000); await f.engine.tick();
    assert.equal(f.state.stopped.reason, 'drawdown_limit'); assert.equal(f.state.liveRiskStop.reason, 'drawdown_limit');
    assert.equal(f.state.lastEquity, 16);
});

test('fresh empty bids retain real drawdown while future or malformed mark data remain persistently held', async t => {
    for (const kind of ['empty', 'future', 'malformed']) await t.test(kind, async t => {
        const f = fixture(t);
        f.client.books = async () => f.quotes().map(book => ({ ...book,
            ...(kind === 'empty' ? { bids: [] } : kind === 'future' ? { timestamp: Date.now() + 1 } : { bids: [{ price: NaN, size: 10 }] }) }));
        await f.engine.tick();
        if (kind === 'empty') {
            assert.equal(f.state.stopped.reason, 'drawdown_limit'); assert.equal(f.state.lastEquity, 16);
        } else {
            assert.equal(f.state.stopped.reason, 'operational_check_failed');
            const hold = structuredClone(f.state.entryHolds.maintenance_mark), stop = structuredClone(f.state.stopped);
            assert.equal(hold.retryable, false); assert.equal(f.state.maxDrawdown, 0); assert.equal(f.state.peakEquity, 20);
            f.client.books = async () => f.quotes(); f.advance(60000); await f.engine.tick();
            assert.deepEqual(f.state.entryHolds.maintenance_mark, hold); assert.deepEqual(f.state.stopped, stop);
            assert.equal(f.calls.discover, 0);
        }
    });
});

test('independent holds block every entry boundary and one recovered read cannot clear another diagnosis', async t => {
    const f = fixture(t); await f.engine.checkClock();
    f.state.position = null; f.state.cash = 20;
    holdEntry(f.store, 'provider_semantics', new OperationalError('invalid_provider_output', 'validation'));
    holdEntry(f.store, 'maintenance_wallet', new OperationalError('read_timeout', 'timeout'), { retryable: true });
    f.advance(5000); await f.engine.tick();
    assert.equal(f.state.entryHolds.maintenance_wallet, undefined); assert.equal(f.state.entryHolds.provider_semantics.retryable, false);
    assert.equal(entryHeld(f.state), true); assert.equal(f.calls.discover, 0);
    assert.throws(() => entryGuard({ state: f.state }), /live_entry_held/);
    await assert.rejects(f.engine.observe({}, 60, 'held'), /live_entry_held/);
    await assert.rejects(f.engine.validate({}), /live_entry_held/);
});

test('unknown maintenance failures preserve diagnosis while safe reads continue with bounded probes', async t => {
    const f = fixture(t); let broken = true;
    f.engine.broker.reconcile = async () => { f.calls.reconcile++; if (broken) throw new Error('PRIVATE_UNKNOWN_PAYLOAD'); };
    await f.engine.tick(); const stop = structuredClone(f.state.stopped), hold = structuredClone(f.state.entryHolds.maintenance_reconcile);
    assert.equal(stop.reason, 'operational_check_failed'); assert.equal(hold.retryable, false);
    broken = false; f.advance(5000); await f.engine.tick();
    assert.equal(f.calls.reconcile, 2); assert.equal(f.calls.wallet, 1);
    assert.deepEqual(f.state.stopped, stop); assert.deepEqual(f.state.entryHolds.maintenance_reconcile, hold);
    f.advance(1000); await f.engine.tick(); assert.equal(f.calls.reconcile, 2);
    assert.equal(JSON.stringify(f.events).includes('PRIVATE_UNKNOWN_PAYLOAD'), false); assert.equal(f.calls.discover, 0);
});

test('transient read classification never accepts arbitrary timeout labels or semantic failures', () => {
    assert.equal(temporaryReadFailure(new OperationalError('read_timeout', 'timeout')), true);
    for (const error of [new OperationalError('invalid_api_data', 'validation'),
        new OperationalError('rpc_wrong_chain', 'transport'), new OperationalError('arbitrary', 'timeout'), new Error('timeout')])
        assert.equal(temporaryReadFailure(error), false);
});

test('RPC read rejection holds exposed wallet checks through restart and resumes only on a fresh match', async t => {
    const f = fixture(t, { ended: true, pending: false });
    let broken = true;
    f.client.payout = async () => [1, 0];
    f.engine.broker.checkWallet = async () => {
        f.calls.wallet++;
        if (broken) throw new OperationalError('rpc_read_rejected', 'transport', {
            stage: 'wallet_balance', rpcCode: -32603, rpcReason: 'internal_error', rpcMethod: 'eth_call',
        });
        return true;
    };
    await f.engine.tick();
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.entryHolds.maintenance_wallet.retryable, true);
    assert.equal(f.calls.actions, 0);
    const orders = structuredClone(f.position.orders);
    f.state.entryHolds = JSON.parse(JSON.stringify(f.state.entryHolds));
    broken = false;
    f.advance(4999); await f.engine.tick();
    assert.equal(f.calls.wallet, 1); assert.equal(f.calls.actions, 0);
    f.advance(1); await f.engine.tick();
    assert.equal(f.state.entryHolds.maintenance_wallet, undefined);
    assert.equal(f.state.stopped, null); assert.equal(f.calls.actions, 1);
    assert.deepEqual(f.position.orders, orders); assert.equal(f.calls.discover, 0);
    assert.equal(temporaryReadFailure(new OperationalError('rpc_read_rejected', 'contract')), false);
});

test('market discovery transport failures use bounded probes and require a new successful watch before entry', async t => {
    const f = fixture(t); f.state.position = null; f.state.cash = 20;
    let watches = 0, offline = true;
    f.engine.watch = async () => { watches++; if (offline) throw new OperationalError('http_server_error', 'transport',
        { stage: 'market_discovery', endpoint: 'gamma' }); };
    await f.engine.tick();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.market_watch.retryable, true);
    assert.equal(f.calls.discover, 0); assert.equal(f.calls.wallet, 1);
    f.advance(4999); await f.engine.tick(); assert.equal(watches, 1); assert.equal(f.calls.discover, 0);
    offline = false; f.advance(1); await f.engine.tick();
    assert.equal(watches, 2); assert.equal(f.state.entryHolds.market_watch, undefined);
    assert.equal(f.calls.discover, 1); assert.ok(f.state.seen.held);
});

test('metadata read recovery consumes the failed AI slot and fresh proof never replays its observation', async t => {
    const f = fixture(t); f.state.position = null; f.state.cash = 20;
    await f.engine.checkClock();
    const market = { ...f.position.market, slug: marketSlug('late-entry', f.engine.settings, Date.now()), end: Date.now() + 60000 };
    f.engine.current = market; f.engine.config.ai.slots = [60, 30];
    let observations = 0;
    f.engine.observe = async () => { observations++; if (observations === 1)
        throw new OperationalError('read_timeout', 'timeout', { stage: 'metadata_read', endpoint: 'clob' }); };
    await LayaLiveEngine.prototype.discover.call(f.engine);
    assert.equal(observations, 1); assert.equal(f.state.entryHolds.entry_read.retryable, true);
    const slot = `${market.slug}:60`; assert.equal(f.state.ai.slots[slot].status, 'invalid');
    f.client.marketInfo = async () => ({}); f.client.validateInfo = () => {};
    f.advance(5000); await f.engine.recoverEntryReads();
    assert.equal(f.state.entryHolds.entry_read, undefined);
    await LayaLiveEngine.prototype.discover.call(f.engine); assert.equal(observations, 1);
    f.advance(25000); await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
    assert.equal(observations, 2); assert.equal(f.state.ai.slots[slot].status, 'invalid');
    assert.equal(f.state.position, null); assert.equal(f.state.stopped, null);
});

test('an unreserved stale BTC slot is consumed and only a later slot with fresh direct history can proceed', async t => {
    const f = fixture(t); f.state.position = null; f.state.cash = 20;
    await f.engine.checkClock();
    const signal = f.client.btc = new BtcSignal(BASELINE.lateSignal);
    const event = (at, twap = false) => ({ topic: twap ? 'prices.crypto.twap' : 'prices.crypto', type: 'update',
        payload: { symbol: 'btcusd', timestamp: at, value: '83000', ...(twap ? { windowSeconds: 60 } : {}) } });
    const reference = market => ({ source: 'chainlink_twap_60s', open: market.open, end: market.end,
        observedAt: market.open, receivedAt: market.open, value: 83000 });
    const market = f.engine.current = { ...f.position.market,
        slug: marketSlug('late-entry', f.engine.settings, Date.now()) };
    market.reference = reference(market);
    signal.ingest(event(market.open, true), market.open);
    signal.ingest(event(Date.now() - 6000), Date.now() - 6000);
    signal.ingest(event(Date.now() - 6000, true), Date.now() - 6000);
    let observations = 0, accepted = 0;
    f.engine.observe = async watched => { observations++; f.engine.assertSignal(watched,
        { index: 0, shares: 5, price: .8 }, Date.now()); accepted++; };
    await LayaLiveEngine.prototype.discover.call(f.engine);
    const key = `${market.slug}:60`;
    assert.equal(f.state.ai.slots[key].status, 'warming'); assert.equal(f.state.stopped, null);
    await LayaLiveEngine.prototype.discover.call(f.engine); assert.equal(observations, 1);
    for (let i = 0; i < 300; i++) {
        f.advance(1000); signal.ingest(event(Date.now()), Date.now()); signal.ingest(event(Date.now(), true), Date.now());
    }
    const next = f.engine.current = { ...market, slug: marketSlug('late-entry', f.engine.settings, Date.now()),
        open: market.open + 300000, end: market.end + 300000 };
    next.reference = reference(next);
    await f.engine.checkClock(); await LayaLiveEngine.prototype.discover.call(f.engine);
    assert.equal(observations, 2); assert.equal(accepted, 1); assert.equal(f.state.stopped, null);
    assert.equal(f.state.ai.slots[key].status, 'warming'); assert.equal(f.state.position, null);
});

test('BTC future timestamps and wrong source identity stay fatal even when the feed reports stale', async t => {
    for (const fault of ['future_spot', 'future_receive', 'future_twap', 'future_reference', 'wrong_source']) await t.test(fault, async t => {
        const f = fixture(t); f.state.position = null;
        await f.engine.checkClock();
        const point = { at: Date.now() - 6000, receivedAt: Date.now() - 6000, value: 83000 };
        f.client.btc = { spot: [{ ...point }], twap: { ...point }, assess: () => ({ reason: 'btc_feed_stale_or_warming' }) };
        if (fault === 'future_spot') f.client.btc.spot[0].at = Date.now() + 1;
        if (fault === 'future_receive') f.client.btc.spot[0].receivedAt = Date.now() + 1;
        if (fault === 'future_twap') f.client.btc.twap.at = Date.now() + 1;
        const market = f.engine.current = { ...f.position.market,
            slug: marketSlug('late-entry', f.engine.settings, Date.now()),
            reference: { source: fault === 'wrong_source' ? 'another_feed' : 'chainlink_twap_60s',
                ...(fault === 'future_reference' ? { receivedAt: Date.now() + 1 } : {}) } };
        f.engine.observe = async () => f.engine.assertSignal(market, { index: 0 }, Date.now());
        await LayaLiveEngine.prototype.discover.call(f.engine);
        assert.equal(f.state.stopped.reason, 'operational_check_failed'); assert.equal(f.state.position, null);
        assert.equal(f.calls.actions, 0); assert.equal(f.state.ai.slots[`${market.slug}:60`].status, 'invalid');
    });
});

test('the BTC freshness exception cannot soften a reserved entry failure', async t => {
    const f = fixture(t);
    f.client.btc = { assess: () => ({ reason: 'btc_feed_stale_or_warming' }) };
    assert.throws(() => f.engine.assertSignal(f.position.market, { index: 0 }, Date.now()),
        error => error.message === 'btc_feed_stale_or_warming' && error.category !== 'opportunity');
});

test('stale REST entry books hold entry until a fresh read, without replaying the expired slot', async t => {
    const f = fixture(t); f.state.position = null; await f.engine.checkClock();
    const market = f.engine.current = { ...f.position.market,
        slug: marketSlug('late-entry', f.engine.settings, Date.now()) };
    let observations = 0, offline = true;
    f.engine.observe = async () => { observations++; throw new OperationalError('stale_book', 'stale_data', { stage: 'book_read' }); };
    await LayaLiveEngine.prototype.discover.call(f.engine);
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.entry_read.retryable, true);
    f.client.marketInfo = async () => ({}); f.client.validateInfo = () => {};
    f.client.books = async () => { if (offline) throw new OperationalError('stale_book', 'stale_data', { stage: 'book_read' }); return f.quotes(); };
    f.advance(5000); await f.engine.recoverEntryReads();
    assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.entry_read.retryable, true);
    offline = false; f.advance(10000); await f.engine.recoverEntryReads();
    assert.equal(f.state.entryHolds.entry_read, undefined);
    await LayaLiveEngine.prototype.discover.call(f.engine); assert.equal(observations, 1);
    assert.equal(f.state.ai.slots[`${market.slug}:60`].status, 'invalid'); assert.equal(f.state.stopped, null);
});
