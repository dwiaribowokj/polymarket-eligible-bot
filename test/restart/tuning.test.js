import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { Engine } from '../../src/restart/engine.js';
import { bookEvidence, quoteQuality, QuoteStability } from '../../src/restart/evidence.js';
import { riskReason, evaluate } from '../../src/restart/math.js';
import { entryPlan } from '../../src/restart/strategy.js';
import { Store } from '../../src/restart/store.js';
import { OperationalError } from '../../src/restart/network.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-tuning-'));
    t.after(() => fs.rmSync(dataDir, { force: true, recursive: true }));
    const settings = { ...BASELINE, lateSignal: null, lateQuality: { ...BASELINE.lateQuality, stableMs: 2000 },
        paperDrawdownStop: 2, dataDir, fingerprint: 'tuned', paperGasUsd: 0.05, strategies: ['late-entry'] };
    const store = new Store(settings, 'paper', 'late-entry'), events = [];
    store.logger = row => events.push(row);
    let now = Math.floor(Date.now() / 300000) * 300000 + 271000;
    t.mock.method(Date, 'now', () => now);
    const market = { slug: `btc-updown-5m-${Math.floor(now / 300000) * 300}`, conditionId: `0x${'a'.repeat(64)}`,
        tokens: ['1', '2'], outcomes: ['Up', 'Down'], tick: 0.01, minimum: 5, accepting: true,
        fee: { rate: 0.07, exponent: 1, takerOnly: true }, open: now - 271000, end: now + 29000 };
    const books = [{ bids: [{ price: 0.79, size: 10 }], asks: [{ price: 0.8, size: 5 }] },
        { bids: [{ price: 0.2, size: 10 }], asks: [{ price: 0.21, size: 5 }] }];
    const feed = { generation: 0, close() {}, drain: () => [] };
    const client = { serverTime: async () => now, market: async () => market,
        books: async () => books.map(b => ({ ...b, timestamp: now, fetchedAt: now })), payout: async () => [1, 0] };
    const engine = new Engine(settings, store, client, feed);
    return { settings, store, events, market, books, client, feed, engine, now: () => now, advance: ms => { now += ms; } };
}

test('expanded entry window includes earlier opportunities and retains final threshold', t => {
    const f = fixture(t);
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 91000), null);
    assert.ok(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 90000));
    assert.ok(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 65000));
    assert.ok(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 31000));
    assert.ok(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 30000));
    f.books[0].asks[0].price = 0.79;
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 20000), null);
});
test('quote filter rejects wide or crossed spreads and shallow initial liquidity', t => {
    const f = fixture(t), plan = entryPlan('late-entry', f.market, f.books, f.settings, 20, f.now());
    assert.equal(quoteQuality(plan, f.books, f.settings).reason, null);
    f.books[0].bids[0].price = 0.77;
    assert.equal(quoteQuality(plan, f.books, f.settings).reason, 'wide_spread');
    f.books[0].bids[0].price = 0.81;
    assert.equal(quoteQuality(plan, f.books, f.settings).reason, 'crossed_book');
    f.books[0].bids[0].price = 0.79; f.books[0].asks[0].size = 4.99;
    assert.equal(quoteQuality(plan, f.books, f.settings).reason, 'insufficient_entry_depth');
});
test('stability requires consecutive samples and resets on side, price or data gaps', () => {
    const s = new QuoteStability(), rule = { ...BASELINE.lateQuality, stableMs: 2000 };
    assert.equal(s.observe('one', 0, 0.8, 1000, rule).reason, 'quote_warmup');
    assert.equal(s.observe('one', 0, 0.81, 2000, rule).reason, 'quote_warmup');
    assert.equal(s.observe('one', 0, 0.82, 3000, rule).reason, null);
    assert.equal(s.observe('one', 0, 0.85, 4000, rule).reason, 'unstable_quote');
    assert.equal(s.observe('one', 1, 0.85, 5000, rule).reason, 'quote_warmup');
    assert.equal(s.observe('one', 1, 0.85, 9000, rule).reason, 'quote_warmup');
    assert.equal(s.observe('two', 1, 0.85, 10000, rule).reason, 'quote_warmup');
});
test('stable entry logs complete books and schedules latency without an extra second', async t => {
    const f = fixture(t);
    await f.engine.tick(); assert.equal(f.store.state.position, null);
    f.advance(1100); await f.engine.tick(); assert.equal(f.store.state.position, null);
    f.advance(1100); await f.engine.tick();
    const position = f.store.state.position;
    assert.ok(position); assert.equal(position.orders.length, 1); assert.equal(f.engine.nextDelay(), 250);
    const accepted = f.events.find(e => e.type === 'entry_observed' && !e.reason);
    assert.equal(accepted.books[0].tokenId, '1'); assert.equal(accepted.books[0].outcome, 'Up');
    assert.deepEqual(accepted.books[0].asks, f.books[0].asks); assert.equal(accepted.stability.stableMs, 2200);
    f.advance(250); f.books[0].asks[0].size = 2;
    await f.engine.tick();
    assert.equal(position.orders[0].filled, 2); assert.equal(position.orders.length, 1);
    assert.equal(f.store.state.diagnostics.latencyMs.total, 250);
    f.advance(2500); await f.engine.tick();
    assert.equal(position.holdings[0], 2); assert.equal(position.fills[0].price, 0.8);
    assert.equal(position.fills[0].tokenId, '1'); assert.equal(position.fills[0].matchedAt, accepted.observedAt + 250);
    assert.equal(typeof accepted.at, 'string');
});
test('restart before stable entry requires a new observation window', async t => {
    const f = fixture(t); await f.engine.tick(); f.advance(1100); await f.engine.tick();
    const restarted = new Store(f.settings, 'paper', 'late-entry'); restarted.logger = () => {};
    const engine = new Engine(f.settings, restarted, f.client, f.feed);
    f.advance(1100); await engine.tick();
    assert.equal(restarted.state.position, null);
    f.advance(2200); await engine.tick(); assert.ok(restarted.state.position);
});
test('read failure resets quote stability and cannot produce an entry on recovery', async t => {
    const f = fixture(t); await f.engine.tick(); f.advance(1100); await f.engine.tick();
    const read = f.client.books; f.client.books = async () => { throw new Error('offline'); };
    f.advance(100); await f.engine.tick(); f.client.books = read;
    f.advance(1100); await f.engine.tick(); assert.equal(f.store.state.position, null);
});
test('paper drawdown stops new entry across restart while retaining settlement inventory', async t => {
    const f = fixture(t);
    await f.engine.tick(); f.advance(2200); await f.engine.tick(); f.advance(250); await f.engine.tick();
    f.advance(2500); await f.engine.tick();
    f.books[0].bids[0].price = 0.3; f.advance(5000); await f.engine.tick();
    assert.equal(f.store.state.stopped.reason, 'paper_drawdown_limit');
    assert.deepEqual(f.store.state.position.holdings, [5, 0]);
    const restarted = new Store(f.settings, 'paper', 'late-entry'); restarted.logger = () => {};
    const engine = new Engine(f.settings, restarted, { ...f.client, payout: async () => [0, 1] }, f.feed);
    f.advance(30000); await engine.tick();
    assert.equal(restarted.state.position, null); assert.ok(restarted.state.cash < 18);
    assert.equal(restarted.state.completed.length, 1); assert.equal(restarted.state.stopped.reason, 'paper_drawdown_limit');
    await engine.tick(); assert.equal(Object.keys(restarted.state.seen).length, 1);
    assert.equal(evaluate(restarted.state, f.settings).eligible, false);
});
test('expired pending reads wait a normal tick rather than hammering a failed endpoint', t => {
    const f = fixture(t);
    f.store.state.position = { orders: [{ status: 'pending', activeAt: f.now() - 10 }] };
    assert.equal(f.engine.nextDelay(), 1000);
});
test('complete evidence is copied and diagnostics survive restart without resetting loss', t => {
    const f = fixture(t), evidence = bookEvidence(f.market, f.books, f.now());
    f.store.event('entry_observed', { ...evidence, reason: 'wide_spread' });
    f.store.event('execution_snapshot', { effectiveLatencyMs: 480 });
    f.store.event('fak_complete', { filled: 0 }); f.store.state.cash = 17;
    f.store.stop(riskReason(f.store.state, f.settings, f.now(), 17));
    f.books[0].asks[0].price = 0.9; assert.equal(evidence.books[0].asks[0].price, 0.8);
    const restarted = new Store(f.settings, 'paper', 'late-entry');
    assert.equal(restarted.state.diagnostics.reasons.wide_spread, 1);
    assert.equal(restarted.state.diagnostics.noFillAttempts, 1);
    assert.equal(restarted.state.diagnostics.latencyMs.max, 480);
    assert.equal(restarted.state.cash, 17); assert.equal(restarted.state.stopped.reason, 'paper_drawdown_limit');
});

function cappedFixture(t) {
    const f = fixture(t);
    f.settings.lateQuality = BASELINE.lateQuality;
    f.settings.lateSignal = BASELINE.lateSignal;
    f.client.assessEntry = () => ({ reason: null, modelEdge: 0.08 });
    return f;
}

test('brief qualifying TWAP quote enters immediately and rechecks before a partial capped fill', async t => {
    const f = cappedFixture(t);
    await f.engine.tick();
    const position = f.store.state.position;
    assert.ok(position); assert.equal(position.orders.length, 1);
    const accepted = f.events.find(e => e.type === 'entry_observed' && !e.reason);
    assert.equal(accepted.stability.mode, 'execution_recheck');
    assert.equal(accepted.stability.stableMs, 0);
    assert.equal(position.orders[0].status, 'pending');
    assert.equal(position.orders[0].filled, 0);
    f.advance(249); await f.engine.tick(); assert.equal(position.orders[0].filled, 0);
    f.advance(1);
    f.books[0].asks = [{ price: 0.8, size: 2 }, { price: 0.81, size: 100 }];
    await f.engine.tick();
    assert.equal(position.orders[0].filled, 2); assert.equal(position.orders[0].price, 0.8);
    const rechecked = f.events.find(e => e.type === 'execution_rechecked');
    assert.equal(rechecked.reason, null); assert.equal(rechecked.quality.depth, 2);
    f.advance(2500); await f.engine.tick();
    assert.equal(position.holdings[0], 2); assert.equal(position.orders.length, 1);
    const restarted = new Store(f.settings, 'paper', 'late-entry'); restarted.logger = () => {};
    const engine = new Engine(f.settings, restarted, f.client, f.feed);
    f.advance(30000); await engine.tick();
    assert.equal(restarted.state.position, null); assert.equal(restarted.state.completed[0].traded, true);
    await engine.tick(); assert.equal(Object.keys(restarted.state.seen).length, 1);
});

test('removing dwell does not admit a stale, opposing or negative-edge TWAP signal', async t => {
    const f = cappedFixture(t);
    for (const reason of ['btc_feed_stale', 'btc_direction_disagrees', 'btc_edge_insufficient']) {
        f.client.assessEntry = () => ({ reason, modelEdge: -0.09 });
        await f.engine.tick();
        assert.equal(f.store.state.position, null);
        assert.equal(Object.keys(f.store.state.seen).length, 0);
        assert.equal(f.events.filter(e => e.type === 'entry_observed').at(-1).reason, reason);
        f.advance(1000);
    }
});

for (const reason of ['wide_spread', 'crossed_book', 'dominant_side_changed']) {
    test(`capped execution rejects ${reason} after latency without a second entry`, async t => {
        const f = cappedFixture(t); await f.engine.tick();
        const position = f.store.state.position;
        if (reason === 'wide_spread') f.books[0].bids[0].price = 0.75;
        if (reason === 'crossed_book') f.books[0].bids[0].price = 0.81;
        if (reason === 'dominant_side_changed') {
            f.books[1].asks[0].price = 0.85; f.books[1].bids[0].price = 0.84;
        }
        f.advance(250); await f.engine.tick();
        assert.equal(position.orders[0].status, 'expired'); assert.equal(position.orders[0].filled, 0);
        assert.equal(f.store.state.position, null);
        assert.equal(f.events.find(e => e.type === 'execution_rechecked').reason, reason);
        assert.equal(f.store.state.diagnostics.expiryReasons[reason], 1);
        await f.engine.tick(); assert.equal(Object.keys(f.store.state.seen).length, 1);
    });
}

test('a changed ask cannot raise the original FAK limit', async t => {
    const f = cappedFixture(t); await f.engine.tick();
    const position = f.store.state.position;
    f.books[0].asks[0].price = 0.81; f.books[0].bids[0].price = 0.8;
    f.advance(250); await f.engine.tick();
    assert.equal(position.orders[0].price, 0.8); assert.equal(position.orders[0].filled, 0);
    assert.equal(f.store.state.diagnostics.noFillAttempts, 1);
    assert.equal(f.store.state.position, null);
    await f.engine.tick(); assert.equal(Object.keys(f.store.state.seen).length, 1);
});

test('stale execution books cancel the FAK and retain uncertainty instead of filling', async t => {
    const f = cappedFixture(t); await f.engine.tick();
    const position = f.store.state.position;
    f.client.books = async () => { throw new OperationalError('stale_book', 'stale_data'); };
    f.advance(250); await f.engine.tick();
    assert.equal(position.orders[0].status, 'cancelled'); assert.equal(position.orders[0].filled, 0);
    assert.equal(f.store.state.completed[0].uncertain, true);
    assert.equal(f.store.state.dataGaps, 1);
    await f.engine.tick(); assert.equal(Object.keys(f.store.state.seen).length, 1);
});

test('deadline crossed during the execution book read cancels the pending BUY', async t => {
    const f = cappedFixture(t); await f.engine.tick();
    const position = f.store.state.position;
    f.settings.evaluationEndsAt = f.now() + 300;
    const read = f.client.books;
    f.client.books = async (...args) => { f.advance(100); return read(...args); };
    f.advance(250); await f.engine.tick();
    assert.equal(position.orders[0].status, 'cancelled'); assert.equal(position.orders[0].filled, 0);
    await f.engine.tick();
    assert.equal(f.store.state.frozenAt, f.settings.evaluationEndsAt);
    assert.equal(f.store.state.completed.length, 1);
});

test('deadline-expired discovery is a missed opportunity, not an execution failure or pilot stop', async t => {
    const f = cappedFixture(t);
    f.store.state.mode = 'pilot'; f.engine.broker.checkWallet = async () => true;
    f.client.books = async () => { throw new OperationalError('entry_window_elapsed', 'opportunity', { stage: 'book_read' }); };
    await f.engine.tick();
    assert.equal(f.store.state.position, null); assert.equal(f.store.state.failures, 0);
    assert.equal(f.store.state.stopped, null);
    assert.equal(f.store.state.operational.missedEntryWindows, 1);
    assert.ok(f.events.some(e => e.type === 'entry_window_missed'));
    assert.equal(f.events.some(e => e.type === 'retry'), false);
});
