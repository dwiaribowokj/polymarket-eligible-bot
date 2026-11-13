import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPremarketPaperConfig, FAIR_PREMARKET_ARMS } from '../../src/premarket-paper/config.js';
import { EARLY_PROFILE, NEXT_PROFILE } from '../../src/premarket-paper/early-context.js';
import { buildPremarketInput } from '../../src/premarket-paper/providers.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';
import { smoke } from '../../scripts/premarket-paper.js';
import { premarketReader } from '../../src/premarket-paper/client.js';
import { readEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';

function fixture(t, { profile = EARLY_PROFILE } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-early-engine-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: profile }, directory);
    const open = Date.parse('2026-10-28T10:25:00Z'), scheduledAt = open - config.leadSeconds * 1000;
    let now = scheduledAt, historyReady = true, depth = 10, ask = .5, payout = null;
    const reads = [], failures = [], sleeps = [];
    const end = Math.floor(scheduledAt / 300000) * 300000;
    let previousClose = 83000;
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: end - 9000000, windowEnd: end, expectedLatestClosedAt: end,
        observedAt: scheduledAt - 1000, fetchedAt: scheduledAt - 1000,
        bars: Array.from({ length: 30 }, (_, i) => {
            const start = end - (30 - i) * 300000, first = previousClose;
            const last = first + (i >= 26 && i <= 28 ? 20 : i === 29 ? -10 : 0);
            previousClose = last;
            return { openAt: start, closeAt: start + 300000, open: first, high: Math.max(first, last) + 1,
                low: Math.min(first, last) - 1, close: last, volume: 10, trades: 20, observedAt: scheduledAt - 1000 };
        }) };
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const books = () => market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: now, fetchedAt: now, bids: [{ price: .49, size: 10 }], asks: [{ price: .5, size: depth }] }));
    const stream = { generation: 1, tokens: market.tokens, watch() {}, close() {}, snapshot: books };
    const store = new PremarketPaperStore(config, now), events = [], calls = [];
    store.event = (type, detail = {}) => { events.push({ type, ...structuredClone(detail) }); store.save(); };
    const providers = {
        async prepareSnapshot(snapshot) { return { ...buildPremarketInput(snapshot, config), contextTokens: 800,
            contextIdentity: 'fixture', contextVerified: true, semanticPromptHash: 'fixture-prompt' }; },
        async predict(name, snapshot) {
            calls.push({ name, inputHash: snapshot.commonInput.inputHash });
            return { status: 'ok', action: 'BUY_DOWN', requestSubmitted: true,
                inputHash: snapshot.commonInput.inputHash, receivedAt: now };
        }
    };
    const client = {
        btc: { status() { throw new Error('live_chainlink_warmup_must_not_be_required'); } },
        startBtcFeed() { throw new Error('live_chainlink_feed_must_not_start'); }, close() {},
        serverTime: async () => now, market: async () => structuredClone(market), books: async () => books(),
        payout: async () => payout
    };
    const reader = () => historyReady ? structuredClone(history) : { ready: false, reason: 'candle_history_stale' };
    const bookReader = async (expected, options) => {
        reads.push(now);
        if (failures.length) throw failures.shift();
        return readEarlyPaperBooks(expected, { ...options, fetchImpl: async input => {
            const url = new URL(input);
            const body = url.pathname === '/book' ? { market: market.conditionId, asset_id: url.searchParams.get('token_id'),
                min_order_size: '5', tick_size: '.01', neg_risk: false, timestamp: String(scheduledAt - 120000), hash: 'a'.repeat(40),
                bids: [{ price: String(ask - .01), size: '10' }], asks: [{ price: String(ask), size: String(depth) }] }
                : { minimum_tick_size: .01 };
            return new Response(JSON.stringify(body), { headers: { Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC' } });
        } });
    };
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, providers, candleReader: reader,
        bookReader, sleep: async ms => { sleeps.push(ms); now += ms; } });
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.clockRetryAt = now + 20000;
    engine.markets.set(market.slug, market); engine.streams.set(market.slug, stream); engine.discover = async () => {};
    const key = `${market.slug}:premarket`;
    store.state.slots[key] = { scheduledAt, status: 'reserved' };
    store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    return { config, engine, store, market, stream, client, events, calls, key, scheduledAt, history, reader,
        bookReader, reads, failures, sleeps, providers,
        clock: () => now, arm: name => store.state.arms[name], get snapshot() { return store.state.snapshots[0]; },
        advance(ms) { now += ms; engine.clockVerifiedAt = now; }, setHistory(ready) { historyReady = ready; },
        setDepth(value) { depth = value; }, setAsk(value) { ask = value; }, setPayout(value) { payout = value; },
        async idle() { while (engine.tasks.size) await Promise.all([...engine.tasks]); },
        observe: () => engine.observePremarket(market.slug, scheduledAt, key) };
}

test('early profile pins 150 minutes of external candles and a nine minute target without changing old profiles', () => {
    const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: EARLY_PROFILE }, '/tmp/early-profile');
    assert.equal(config.leadSeconds, 540); assert.equal(config.candleCount, 30);
    assert.equal(config.candleIntervalMs, 300000); assert.equal(config.historyMs, 9000000);
    assert.equal(config.candleCacheMaxAgeMs, 90000); assert.equal(config.maxActiveMarketsPerArm, 1);
    assert.deepEqual(config.activeArms, FAIR_PREMARKET_ARMS); assert.equal(config.paperOnly, true);
    assert.equal(config.candleSource.settlementSource, 'official_polymarket_ctf_payout');
    assert.equal(config.candleSource.historicalBackfillAllowed, true);
    assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: EARLY_PROFILE,
        PREMARKET_CANDLE_CACHE: 'relative.json' }, '/tmp/early-profile'), /absolute/);
    const old = loadPremarketPaperConfig({ PREMARKET_PROFILE: 'fair-near-open-30m-v1' }, '/tmp/old-profile');
    assert.equal(old.leadSeconds, 60); assert.equal(old.candleIntervalMs, 60000); assert.equal(old.historyMs, 1800000);
});

test('17:16 schedules 17:25 and prewatches the following future market; missed slots do not enter late', async t => {
    const f = fixture(t), watched = [];
    delete f.store.state.slots[f.key];
    f.engine.discover = async open => { watched.push(open); };
    f.engine.scheduleObservations(f.clock()); await f.idle();
    assert.deepEqual(watched, [f.market.open, f.market.open + 300000]);
    assert.equal(f.snapshot.market.open, Date.parse('2026-10-28T10:25:00Z'));
    assert.equal(f.snapshot.scheduledAt, Date.parse('2026-10-28T10:16:00Z'));
    const count = f.store.state.snapshots.length;
    f.engine.scheduleObservations(f.clock()); await f.idle(); assert.equal(f.store.state.snapshots.length, count);
    f.advance(300000 + f.config.slotToleranceMs + 1); f.engine.scheduleObservations(f.clock()); await f.idle();
    const next = `btc-updown-5m-${(f.market.open + 300000) / 1000}`;
    assert.equal(f.store.state.slots[`${next}:premarket`].reason, 'slot_missed');
});

test('cached candles immediately feed all three arms without live history; shared FAK partial fills settle officially', async t => {
    const f = fixture(t);
    assert.equal(f.engine.history.points.length, 0);
    await f.observe(); await f.idle();
    assert.equal(f.snapshot.features.bars.length, 30);
    assert.equal(f.snapshot.features.context.requiredMinutes, 150);
    assert.equal(f.snapshot.decisions['premarket-momentum'].action, 'BUY_DOWN');
    assert.equal(f.snapshot.decisions['premarket-momentum'].inputHash, f.snapshot.commonInput.inputHash);
    assert.deepEqual(f.calls.map(row => row.inputHash), [f.snapshot.commonInput.inputHash, f.snapshot.commonInput.inputHash]);
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.setDepth(2); f.advance(250); await f.engine.tick(); await f.idle();
    for (const name of FAIR_PREMARKET_ARMS) {
        const position = f.arm(name).positions[f.market.slug];
        assert.equal(position.status, 'matched'); assert.equal(position.holdings, 2);
        assert(position.executionAt < f.market.open);
    }
    f.advance(900000); await f.engine.settle();
    assert(FAIR_PREMARKET_ARMS.every(name => f.arm(name).completed.length === 0));
    f.setPayout([0, 1]); f.advance(15000); await f.engine.settle();
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).completed.length, 1); assert(f.arm(name).completed[0].pnl > 0);
        assert.equal(f.arm(name).completed[0].partial, true);
        assert.deepEqual(f.arm(name).completed[0].payout, [0, 1]);
    }
});

test('a stale collector skips the slot without stopping any arm and next valid snapshot can run', async t => {
    const f = fixture(t); f.setHistory(false);
    await f.observe().catch(error => f.engine.failObservation(f.market.slug, f.key, error));
    assert.equal(f.calls.length, 0);
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).stopped, null);
        assert.equal(f.arm(name).outcomes[f.market.slug].code, 'candle_history_stale');
    }
    await f.engine.tick(); await f.idle();
    assert.equal(f.store.state.candleHistory.ready, false);
    f.setHistory(true); f.advance(f.config.reportMs); await f.engine.tick(); await f.idle();
    assert.equal(f.store.state.candleHistory.ready, true);
    assert.equal(f.engine.closed, false);
});

test('loss of fresh history during the shared decision window prevents simulated execution', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.setHistory(false); f.advance(250); f.engine.executePending(); await f.idle();
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).outcomes[f.market.slug].code, 'candle_history_stale');
        assert.equal(Object.keys(f.arm(name).positions).length, 0);
        assert.equal(f.arm(name).cash, 20);
    }
});

test('restart retains filled positions and prevents replay of an observed slot', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.advance(250); f.engine.executePending(); await f.idle();
    const store = new PremarketPaperStore(f.config, f.clock());
    const engine = new PremarketPaperEngine(f.config, store, f.client,
        { clock: f.clock, candleReader: f.reader });
    engine.discover = async () => {};
    const previous = store.state.snapshots.length;
    engine.scheduleObservations(f.clock()); await Promise.all([...engine.tasks]);
    assert.equal(store.state.snapshots.length, previous);
    for (const name of FAIR_PREMARKET_ARMS) assert.equal(store.state.arms[name].positions[f.market.slug].status, 'matched');
});

test('early smoke needs only cached candles, future orderbook and metadata, with no Chainlink warmup', async t => {
    const f = fixture(t);
    const result = await smoke(f.config, f.client, () => f.stream, f.clock, async ms => f.advance(ms), f.reader, f.bookReader);
    assert.equal(result.candleCount, 30); assert.equal(result.continuousWarmupRequired, false);
    assert.equal(result.market, f.market.slug); assert.equal(result.inferenceSubmitted, false);
    assert.equal(result.transactionsSubmitted, false);
});

test('early public reader cannot start an authenticated feed or expose financial operations', async () => {
    const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: EARLY_PROFILE }, '/tmp/early-reader');
    let authenticated = 0;
    const client = premarketReader(config, null, { authenticate() { authenticated++; throw new Error('must_not_authenticate'); } });
    client.startBtcFeed(); await client.close();
    assert.equal(authenticated, 0);
    for (const name of ['prepare', 'post', 'cancel', 'broadcastAction']) assert.equal(client[name], undefined);
});

const temporary = () => Object.assign(new Error('early_book_read_timeout'), { code: 'early_book_read_timeout', category: 'timeout' });

test('capture retries temporary reads inside ten seconds and retains the original thirty closed candles', async t => {
    const f = fixture(t), originalMarket = f.client.market;
    f.failures.push(temporary());
    f.client.market = async (...args) => { f.advance(1200); return originalMarket(...args); };
    await f.observe(); await f.idle();
    assert.deepEqual(f.sleeps, [1000]);
    assert(f.snapshot.at > f.scheduledAt + 2000 && f.snapshot.at <= f.scheduledAt + 10000);
    assert.equal(f.snapshot.features.bars.length, 30);
    assert(f.snapshot.features.bars.every(row => row.end <= f.scheduledAt));
    assert.equal(f.snapshot.books[0].timestamp, f.scheduledAt - 120000);
    assert.equal(f.snapshot.bookEvidence.verifiedAt, f.snapshot.at);
});

test('shared readiness recovers once, then tick requests a new book after activation for all arms', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.failures.push(temporary());
    f.engine.scheduleFairExecutions(); await f.idle();
    const timing = f.snapshot.fairExecution;
    assert.deepEqual(timing.attempts.map(row => row.status), ['failed', 'verified']);
    assert.equal(timing.attempts[1].startedAt - timing.attempts[0].finishedAt, 1000);
    assert.equal(timing.deadlineAt, f.snapshot.aiDeadlineAt + 30000);
    const reads = f.reads.length;
    f.advance(249); await f.engine.tick(); await f.idle(); assert.equal(f.reads.length, reads);
    f.advance(1); await f.engine.tick(); await f.idle();
    assert.equal(f.reads.length, reads + 1);
    assert(f.reads.at(-1) >= timing.activeAt);
    for (const name of FAIR_PREMARKET_ARMS) {
        const position = f.arm(name).positions[f.market.slug];
        assert.equal(position.status, 'matched');
        assert.equal(position.executionBookHash, timing.executionBookHash);
        assert.equal(position.executionAt, timing.executionAt);
        assert.deepEqual(position.executionEvidence, timing.executionEvidence);
    }
    await f.engine.tick(); await f.idle(); assert.equal(f.reads.length, reads + 1);
});

test('a provider arriving during readiness recovery is still excluded by the original AI deadline', async t => {
    const f = fixture(t); let finishRouter;
    f.providers.predict = async name => name === 'router' ? new Promise(resolve => { finishRouter = resolve; })
        : { status: 'ok', action: 'BUY_DOWN', receivedAt: f.clock() };
    await f.observe(); await Promise.resolve();
    f.advance(30000); f.failures.push(temporary());
    f.engine.sleep = async ms => {
        f.advance(ms); finishRouter({ status: 'ok', action: 'BUY_DOWN', receivedAt: f.clock() });
        await Promise.resolve();
    };
    f.engine.scheduleFairExecutions(); await f.idle();
    f.advance(250); await f.engine.tick(); await f.idle();
    assert.equal(f.arm('router-premarket').outcomes[f.market.slug].reason, 'provider_late');
    assert.equal(f.arm('router-premarket').cash, 20);
    assert.equal(f.arm('laya-premarket').positions[f.market.slug].status, 'matched');
});

test('readiness timeout expires once and never creates inventory or freezes the service', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.failures.push(...Array.from({ length: 40 }, temporary));
    f.engine.scheduleFairExecutions(); await f.idle();
    assert.equal(f.snapshot.fairExecution.status, 'skipped');
    assert(f.snapshot.fairExecution.attempts.length > 1);
    assert(f.snapshot.fairExecution.attempts.every(row => row.startedAt < f.snapshot.fairExecution.deadlineAt));
    assert.equal(f.engine.closed, false);
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).cash, 20); assert.equal(f.arm(name).stopped, null);
        assert.equal(Object.keys(f.arm(name).positions).length, 0);
    }
});

test('one post-activation read failure is terminal with no order retry or partial-fill chase', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    const reads = f.reads.length; f.failures.push(temporary()); f.advance(250);
    await f.engine.tick(); await f.idle();
    await f.engine.tick(); await f.idle();
    assert.equal(f.reads.length, reads + 1);
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).outcomes[f.market.slug].reason, 'execution_expired');
        assert.equal(f.arm(name).cash, 20);
    }
});

test('a fresh book beyond the immutable initial limit yields no fill for every arm', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    const limit = f.snapshot.orders.BUY_DOWN.price;
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.setAsk(limit + .01); f.advance(250); await f.engine.tick(); await f.idle();
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).outcomes[f.market.slug].reason, 'no_fill');
        assert.equal(f.arm(name).cash, 20);
    }
    assert.equal(f.snapshot.orders.BUY_DOWN.price, limit);
});

test('closing or cutoff while a shared read is pending prevents fills and records a complete failed attempt', async t => {
    const f = fixture(t); await f.observe(); await f.idle(); f.advance(30000);
    f.engine.clockValid = false;
    f.client.serverTime = async () => { f.engine.requestEntryCutoff('test_cutoff'); return f.clock(); };
    f.engine.scheduleFairExecutions(); await f.idle();
    const attempt = f.snapshot.fairExecution.attempts[0];
    assert.equal(attempt.status, 'failed'); assert.equal(attempt.code, 'entry_cutoff');
    assert(Number.isFinite(attempt.finishedAt));
    assert(FAIR_PREMARKET_ARMS.every(name => Object.keys(f.arm(name).positions).length === 0));
});

test('settlement failures back off to sixty seconds and a later official payout credits only once', async t => {
    const f = fixture(t); await f.observe(); await f.idle(); f.advance(30000);
    f.engine.scheduleFairExecutions(); await f.idle(); f.advance(250); await f.engine.tick(); await f.idle();
    f.advance(900000); let queries = 0;
    f.client.payout = async () => { queries++; if (queries < 3) throw temporary(); return [0, 1]; };
    await f.engine.settle(); const record = f.store.state.markets[f.market.slug];
    assert.equal(record.payoutNextAt, f.clock() + 30000);
    f.advance(29999); await f.engine.settle(); assert.equal(queries, 1);
    f.advance(1); await f.engine.settle(); assert.equal(record.payoutNextAt, f.clock() + 60000);
    f.advance(60000); await f.engine.settle(); const cash = f.arm('laya-premarket').cash;
    await f.engine.settle(); assert.equal(queries, 3); assert.equal(f.arm('laya-premarket').cash, cash);
    assert.equal(f.arm('laya-premarket').completed.length, 1);
});

test('an overslept recovery never starts another read beyond the common deadline', async t => {
    const f = fixture(t); await f.observe(); await f.idle(); f.advance(30000);
    f.failures.push(temporary()); f.engine.sleep = async () => f.advance(31000);
    f.engine.scheduleFairExecutions(); await f.idle();
    assert.equal(f.snapshot.fairExecution.attempts.length, 1);
    assert.equal(f.snapshot.fairExecution.reason, 'shared_execution_late');
    assert(FAIR_PREMARKET_ARMS.every(name => f.arm(name).cash === 20));
});

test('restart closes an interrupted readiness attempt and never replays its forecast', async t => {
    const f = fixture(t); await f.observe(); await f.idle(); f.advance(30000);
    Object.assign(f.snapshot.fairExecution, { status: 'validating', attempts: [{ startedAt: f.clock() }] });
    f.store.save();
    const store = new PremarketPaperStore(f.config, f.clock());
    const engine = new PremarketPaperEngine(f.config, store, f.client, { clock: f.clock });
    const execution = store.state.snapshots[0].fairExecution;
    assert.equal(execution.status, 'skipped'); assert.equal(execution.attempts[0].status, 'failed');
    assert.equal(execution.attempts[0].finishedAt, f.clock()); assert.equal(engine.fairSnapshots.size, 0);
});

test('clock reversal during the post-activation request cancels instead of retrying an admitted order', async t => {
    const f = fixture(t); await f.observe(); await f.idle(); f.advance(30000);
    f.engine.scheduleFairExecutions(); await f.idle(); f.advance(250);
    const market = f.client.market;
    f.client.market = async (...args) => { f.advance(-1); return market(...args); };
    await f.engine.tick(); await f.idle();
    const reads = f.reads.length;
    f.advance(1000); await f.engine.tick(); await f.idle(); assert.equal(f.reads.length, reads);
    assert.equal(f.arm('laya-premarket').outcomes[f.market.slug].code, 'execution_clock_reversed');
});

test('next-candle profile targets the immediate successor at open plus five seconds with symmetric confirmation masks', async t => {
    const f = fixture(t, { profile: NEXT_PROFILE });
    assert.equal(f.config.leadSeconds, -5); assert.equal(f.config.entryEndOffsetMs, 90000);
    assert.equal(f.config.rolePolicy, 'streak-signal-confirmation-or-skip-v1');
    const watched = []; f.engine.discover = async open => watched.push(open);
    delete f.store.state.slots[f.key]; f.engine.scheduleObservations(f.clock()); await f.idle();
    assert.deepEqual(watched, [f.market.open, f.market.open + 300000]);
    assert.equal(f.snapshot.scheduledAt, f.market.open + 5000);
    assert.equal(f.snapshot.features.bars.at(-1).end, f.market.open);
    assert.equal(f.snapshot.orders.BUY_UP, null);
    assert.deepEqual(f.snapshot.commonInput.allowed, ['BUY_DOWN', 'SKIP']);
    assert.equal(f.snapshot.commonInput.context.confirmationOnly, true);
    assert.equal(f.snapshot.aiDeadlineAt, f.clock() + 30000);
    assert.equal(f.snapshot.fairExecution.deadlineAt, f.snapshot.aiDeadlineAt + 30000);
    f.advance(30000); await f.engine.tick(); await f.idle();
    f.advance(250); await f.engine.tick(); await f.idle();
    for (const name of FAIR_PREMARKET_ARMS) {
        const position = f.arm(name).positions[f.market.slug];
        assert.equal(position.status, 'matched'); assert.equal(position.order.index, 1);
        assert(position.executionAt >= f.market.open && position.executionAt < f.market.open + 90000);
    }
    f.setPayout([0, 1]); f.advance(300000); await f.engine.settle();
    for (const name of FAIR_PREMARKET_ARMS) {
        assert.equal(f.arm(name).completed.length, 1); assert(f.arm(name).completed[0].pnl > 0);
    }
});

test('next-candle no-pattern windows do not ask either AI to invent a directional entry', async t => {
    const f = fixture(t, { profile: NEXT_PROFILE });
    const last = f.history.bars.at(-1); last.close = last.open;
    await f.observe(); await f.idle();
    assert.deepEqual(f.snapshot.commonInput.allowed, ['SKIP']);
    assert.equal(f.calls.length, 0); assert.equal(f.snapshot.orders.BUY_UP, null);
    assert.equal(f.snapshot.orders.BUY_DOWN, null);
    f.advance(30000); await f.engine.tick(); await f.idle();
    for (const name of FAIR_PREMARKET_ARMS) assert.equal(Object.keys(f.arm(name).positions).length, 0);
    assert.equal(f.arm('laya-premarket').outcomes[f.market.slug].reason, 'signal_not_met');
    assert.equal(f.snapshot.decisions['router-premarket'].requestSubmitted, false);
});

test('next-candle an opposing AI decision cannot become a trade while SKIP remains a valid veto', async t => {
    const f = fixture(t, { profile: NEXT_PROFILE });
    f.providers.predict = async name => ({ status: 'ok', action: name === 'laya' ? 'BUY_UP' : 'SKIP', receivedAt: f.clock() });
    await f.observe(); await f.idle(); f.advance(30000); await f.engine.tick(); await f.idle();
    f.advance(250); await f.engine.tick(); await f.idle();
    assert.equal(f.arm('premarket-momentum').positions[f.market.slug].status, 'matched');
    assert.equal(f.arm('laya-premarket').cash, 20); assert.equal(f.arm('router-premarket').cash, 20);
    assert.equal(f.arm('laya-premarket').outcomes[f.market.slug].reason, 'entry_constraints_not_met');
    assert.equal(f.arm('router-premarket').outcomes[f.market.slug].reason, 'provider_skip');
});

test('next-candle late bar receipts cannot enter and no clock rollover targets a future horizon', async t => {
    const f = fixture(t, { profile: NEXT_PROFILE });
    f.history.bars.at(-1).observedAt = f.scheduledAt + 1;
    await assert.rejects(f.observe(), /candle_history_invalid/);
    assert.equal(f.calls.length, 0);
    const open = Date.parse('2026-10-28T23:55:00Z'), next = open + 300000;
    f.advance(next + 5000 - f.clock()); const watched = [];
    f.engine.discover = async value => watched.push(value);
    f.engine.observePremarket = async (slug, scheduledAt) => {
        assert.equal(slug, `btc-updown-5m-${next / 1000}`); assert.equal(scheduledAt, next + 5000);
    };
    f.engine.scheduleObservations(f.clock()); await f.idle();
    assert.deepEqual(watched, [next, next + 300000]);
});

test('next-candle smoke verifies currently open markets and keeps financial operations unavailable', async t => {
    const f = fixture(t, { profile: NEXT_PROFILE });
    const result = await smoke(f.config, f.client, () => { throw Error('must_not_open_ws'); }, f.clock,
        async ms => f.advance(ms), f.reader, f.bookReader);
    assert.equal(result.futureMarket, false); assert.equal(result.targetHorizon, 1);
    assert.equal(result.entryPhase, 'early_in_market'); assert.equal(result.transactionsSubmitted, false);
    const client = premarketReader(f.config); client.startBtcFeed(); await client.close();
    assert.equal(client.prepare, undefined); assert.equal(client.post, undefined);
});
