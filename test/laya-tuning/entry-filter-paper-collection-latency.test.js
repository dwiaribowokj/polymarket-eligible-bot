import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { FilterPaperEngine } from '../../src/laya-filter-paper/engine.js';
import { EntryFilterPaperEngine } from '../../src/entry-filter-paper/engine.js';
import { EntryFilterPaperStore } from '../../src/entry-filter-paper/store.js';
import { LIVE_COST_CAP_PROFILE } from '../../src/entry-filter-paper/config.js';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';

function fixture(t, { passive = true, saveMs = 350 } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-collection-latency-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const open = Date.parse('2026-10-20T00:00:00Z');
    const slotAt = open + 210000;
    let now = slotAt + 1500;
    const config = { id: 'collection-latency-test', dataDir, policy: {}, sources: [],
        profile: LIVE_COST_CAP_PROFILE, armNames: ['cost-cap-control', 'cost-cap-082'],
        armCostCaps: { 'cost-cap-control': .85, 'cost-cap-082': .82 },
        capital: 20, shares: 5, entryCap: 5, gasUsd: .05, slotToleranceMs: 2000,
        dataAgeMs: 5000, latencyMs: 250, inferenceReserveMs: 150,
        deadline: Number.MAX_SAFE_INTEGER, control: BASELINE,
        passiveCollection: { enabled: passive } };
    const store = new EntryFilterPaperStore(config, open);
    const market = { slug: 'btc-updown-5m-1792454400', conditionId: 'condition',
        open, end: open + 300000, minimum: 5, tick: .01, ticks: [.01, .01],
        accepting: true, tokens: ['up', 'down'], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const key = `${market.slug}:90`;
    store.state.slots[key] = { at: now, status: 'reserved' };
    const engine = new EntryFilterPaperEngine(config, store, {}, {}, undefined, { clock: () => now });
    engine.clockValid = true;
    engine.clockVerifiedAt = now;
    engine.observationBooks = async () => ({ rest: [],
        validation: { at: now, generation: 1, identity: metadataIdentity(market) } });
    engine.freshSnapshot = async () => ({
        // Neither side is executable; no market-data or provider work is needed for this storage test.
        initial: [{ asks: [] }, { asks: [] }], bookSource: 'websocket', timing: {},
        features: { observedAt: now, state: { seconds: 88.5, opening_twap: 83000,
            spot: 83001, twap: 83001, margin_usd: 1, volatility_usd_sqrt_s: 1,
            returns_bps_5_15_30_60_180: [0, 0, 0, 0, 0], bars_30s_OHLC_oldest_first: [],
            books_up_down: [{ bids: [], asks: [] }, { bids: [], asks: [] }],
            fee_rate: .07, fee_exponent: 1, shares: 5, entry_cap: 5 } }
    });
    const save = store.save.bind(store);
    const commits = t.mock.method(store, 'save', () => { save(); now += saveMs; });
    const ledger = () => JSON.parse(fs.readFileSync(store.filename, 'utf8'));
    const events = () => fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8')
        .trim().split('\n').map(JSON.parse);
    return { config, store, engine, market, key, commits, ledger, events,
        get now() { return now; }, slotAt, advance(ms) { now += ms; },
        observe: () => engine.observe(market, 90, key) };
}

function assertNoEntry(state) {
    for (const arm of Object.values(state.arms)) {
        assert.equal(arm.cash, 20);
        assert.equal(arm.position, null);
        assert.deepEqual(arm.seen, {});
        assert.deepEqual(arm.completed, []);
    }
}

test('pre-snapshot double checkpoint reproduces missed passive slot with a slow ledger', async t => {
    const f = fixture(t);
    f.engine.recordOpportunitySkip = FilterPaperEngine.prototype.recordOpportunitySkip.bind(f.engine);
    await assert.rejects(f.observe(), /slot_late_after_validation/);
    const state = f.ledger();
    assert.equal(f.commits.mock.callCount(), 3);
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.snapshots[0].sharedDecision.status, 'observation_failed');
    assert.equal(state.slots[f.key].reason, 'slot_late_after_validation');
    assertNoEntry(state);
});

test('passive skip, snapshot and no-buy decision share one durable checkpoint within the same slot', async t => {
    const f = fixture(t);
    await f.observe();
    const state = f.ledger();
    assert.equal(f.commits.mock.callCount(), 1);
    assert.equal(f.now - f.slotAt, 1850);
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.slots[f.key].status, 'observed');
    assert.equal(state.snapshots[0].sharedDecision.status, 'ok');
    assert.equal(state.snapshots[0].sharedDecision.action, 'SKIP');
    assert.equal(state.snapshots[0].sharedDecision.admittedAt - f.slotAt, 1500);
    assert.deepEqual(f.events().map(row => row.type), ['opportunity_skipped', 'snapshot', 'decision']);
    assertNoEntry(state);
    const resumed = new EntryFilterPaperStore(f.config, f.now);
    assert.equal(resumed.state.opportunitySkips.total, 1);
    assert.equal(resumed.state.snapshots[0].sharedDecision.status, 'ok');
    assertNoEntry(resumed.state);
});

test('non-passive empty opportunity retains its immediate durable skip and returns before a snapshot', async t => {
    const f = fixture(t, { passive: false });
    await f.observe();
    const state = f.ledger();
    assert.equal(f.commits.mock.callCount(), 2);
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.slots[f.key].status, 'no_valid_side');
    assert.equal(state.snapshots.length, 0);
    assert.deepEqual(f.events().map(row => row.type), ['opportunity_skipped']);
    assertNoEntry(state);
});

test('failure before recording a passive snapshot still commits the skipped opportunity exactly once', async t => {
    const f = fixture(t);
    f.engine.prepareSnapshot = () => { throw new Error('test_context_failed'); };
    await assert.rejects(f.observe(), /test_context_failed/);
    const state = f.ledger();
    assert.equal(f.commits.mock.callCount(), 1);
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.snapshots.length, 0);
    assert.equal(state.slots[f.key].reason, 'test_context_failed');
    assert.deepEqual(f.events().map(row => row.type), ['opportunity_skipped']);
    assertNoEntry(state);
});

test('a genuinely late passive snapshot still fails the unchanged slot guard and preserves skip evidence', async t => {
    const f = fixture(t);
    const prepare = f.engine.prepareSnapshot.bind(f.engine);
    f.engine.prepareSnapshot = (...args) => { prepare(...args); f.advance(600); };
    await assert.rejects(f.observe(), /slot_late_after_validation/);
    const state = f.ledger();
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.slots[f.key].reason, 'slot_late_after_validation');
    assert.equal(state.snapshots[0].sharedDecision.status, 'observation_failed');
    assert.equal(state.snapshots[0].sharedDecision.action, 'SKIP');
    assert.equal(f.events().filter(row => row.type === 'opportunity_skipped').length, 1);
    assertNoEntry(state);
});

test('logging failure after the atomic decision commit cannot duplicate skip accounting or admit a trade', async t => {
    const f = fixture(t);
    t.mock.method(fs, 'appendFileSync', () => { throw new Error('log_io_failure'); });
    await assert.rejects(f.observe(), error => {
        assert.equal(error.message, 'paper_event_log_failed');
        assert.equal(error.durableStateCommitted, true);
        return true;
    });
    const state = f.ledger();
    assert.equal(f.commits.mock.callCount(), 1);
    assert.equal(state.opportunitySkips.total, 1);
    assert.equal(state.snapshots[0].sharedDecision.status, 'ok');
    assertNoEntry(state);
    assert.equal(new EntryFilterPaperStore(f.config, f.now).state.opportunitySkips.total, 1);
});
