import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BtcSignal } from '../../src/restart/signal.js';
import { encodeFeatures } from '../../src/ai-shadow/history.js';
import { EntryFilterPaperEngine } from '../../src/entry-filter-paper/engine.js';
import { loadEntryFilterPaperConfig, LIVE_COST_CAP_PROFILE, LIVE_MOMENTUM_PROFILE,
    LIVE_MOMENTUM_ARMS } from '../../src/entry-filter-paper/config.js';
import { evaluateMomentum30, exactAskDropAboveLimit } from '../../src/entry-filter-paper/momentum.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const seal = snapshot => {
    snapshot.input = encodeFeatures(snapshot.state); snapshot.inputHash = hash(snapshot.input);
    snapshot.snapshotId = hash(JSON.stringify({ market: snapshot.market, seconds: snapshot.slot,
        now: snapshot.at, input: snapshot.input })).slice(0, 24);
    return snapshot;
};

async function fixture({ direction = 1, momentum = 1, seconds = 90 } = {}) {
    const config = loadEntryFilterPaperConfig({}, '/tmp/entry-momentum-memory-only', LIVE_MOMENTUM_PROFILE);
    const open = Date.parse('2026-10-20T00:00:00Z'), firstAt = open + (300 - seconds) * 1000;
    let now = firstAt, ask = .78, payout = null, momentumDirection = momentum;
    const btc = new BtcSignal(config.control.lateSignal);
    const feed = at => btc.ingest({ topic: 'prices.crypto', type: 'update', payload: {
        symbol: 'btcusd', timestamp: at,
        value: 83000 + direction * 20 + momentumDirection * (at - firstAt) / 10000 } }, at);
    for (let at = now - 185000; at <= now; at += 1000) feed(at);
    const twap = () => btc.ingest({ topic: 'prices.crypto.twap', type: 'update', payload: {
        symbol: 'btcusd', timestamp: now, value: btc.integral(now - 60000, now) / 60, windowSeconds: 60 } }, now);
    twap(); btc.openings.set(open, { at: open, value: 83000, receivedAt: open + 100 });
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, reference: { source: 'chainlink_twap_60s',
            open, end: open + 300000, value: 83000, observedAt: open, receivedAt: open + 100 } };
    const getBooks = () => market.tokens.map((tokenId, index) => {
        const price = index === (direction > 0 ? 0 : 1) ? ask : .22;
        return { tokenId, conditionId: market.conditionId, tick: .01, timestamp: now, fetchedAt: now,
            bids: [{ price: price - .01, size: 10 }], asks: [{ price, size: 10 }] };
    });
    const books = { generation: 1, tokens: market.tokens, socket: { readyState: 1 },
        snapshot: () => getBooks(), watch() {}, close() {} };
    const state = { id: config.id, startedAt: now, frozenAt: null, providers: {}, slots: {}, snapshots: [],
        markets: {}, errors: {}, arms: Object.fromEntries(config.armNames.map(name => [name, {
            cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null,
            seen: {}, position: null, completed: [], outcomes: {} }])) };
    const events = [], batches = [];
    const store = { state, save() {}, freeze() {}, event(type, detail) { events.push({ type, detail }); },
        eventBatch(rows) { batches.push(structuredClone(rows)); events.push(...structuredClone(rows)); },
        error(stage, error) { state.errors[`${stage}:${error.message}`] = true; } };
    const client = { btc, books: async () => getBooks(), payout: async () => payout,
        marketInfo: async () => ({ fee: market.fee }),
        validateInfo(value, info) { assert.deepEqual(value.fee, info.fee); },
        serverTime: async () => now, startBtcFeed() {}, close() {} };
    const engine = new EntryFilterPaperEngine(config, store, client, books,
        { predict() { throw new Error('inference_forbidden'); }, close() {} },
        { clock: () => now, sleep: async ms => { now += ms; } });
    await engine.verifyClock();
    return { config, market, books, client, engine, state, events, batches,
        get now() { return now; }, advance(ms) { now += ms; }, price(value) { ask = value; },
        payout(value) { payout = value; }, observe(slot = seconds) {
            return engine.observe(market, slot, `${market.slug}:${slot}`);
        }, async laterSlot(slot, nextMomentum = momentumDirection) {
            momentumDirection = nextMomentum;
            const until = market.end - slot * 1000;
            for (let at = btc.spot.at(-1).at + 1000; at <= until; at += 1000) feed(at);
            now = until; twap(); await engine.verifyClock();
        } };
}

test('momentum profile fixes independent primary and secondary arms at the same cap and risk settings', () => {
    const original = loadEntryFilterPaperConfig({}, '/tmp/cost-cap-memory-only', LIVE_COST_CAP_PROFILE);
    const config = loadEntryFilterPaperConfig({}, '/tmp/momentum-memory-only', LIVE_MOMENTUM_PROFILE);
    assert.deepEqual(config.armNames, LIVE_MOMENTUM_ARMS);
    assert.deepEqual(config.armCostCaps, Object.fromEntries(LIVE_MOMENTUM_ARMS.map(name => [name, .82])));
    assert.equal(config.costCapPerShare, .82);
    for (const key of ['capital', 'shares', 'entryCap', 'gasUsd', 'latencyMs', 'settlementMs', 'dataAgeMs',
        'slots', 'snapshotAgeTargetMs', 'snapshotSlotReserveMs', 'executionPolicy', 'executionBook',
        'limitSlippageTicks', 'limitSlippageUsd', 'drawdownStop', 'shadowDrawdownStop',
        'observationPolicy', 'passiveCollection']) assert.deepEqual(config[key], original[key], key);
    assert.equal(config.tuningPolicy.primaryArm, 'cost-cap-momentum30');
    assert.equal(config.tuningPolicy.secondaryArm, 'cost-cap-drop-2c');
    assert.equal(config.tuningPolicy.admissionVetoConsumesMarketAttempt, false);
    assert.equal(config.tuningPolicy.reservedOrderConsumesMarketAttempt, true);
    assert.equal(config.evaluationPolicy.durationMs, 7 * 86400000);
    assert.equal(config.evaluationPolicy.minCompletedFillsPerArm, 100);
    assert.equal(config.evaluationPolicy.promotion, 'manual-review-only');
    assert.equal(config.evaluationPolicy.parameterSelection, 'frozen-before-period-no-retuning');
    assert.equal(config.evaluationPolicy.primaryMetric, 'candidate-minus-control-net-pnl-per-common-resolved-opportunity-market');
    assert.ok(config.evaluationPolicy.primaryCohortExclusions.includes('no-eligible-side'));
    assert.equal(config.evaluationPolicy.opportunityCoverageReportedSeparately, true);
    assert.equal(config.momentumPolicy.thresholdSelection, 'fixed-zero-no-magnitude-optimization');
    assert.equal(config.momentumPolicy.zeroPolicy, 'reject');
    assert.equal(config.momentumPolicy.missingPolicy, 'reject');
    assert.notEqual(config.id, original.id);
});

test('momentum uses the frozen30-second sign for both sides without inferring or changing direction', async () => {
    for (const direction of [1, -1]) for (const momentum of [1, -1]) {
        const f = await fixture({ direction, momentum }); await f.observe();
        const action = direction > 0 ? 'BUY_UP' : 'BUY_DOWN', snapshot = f.state.snapshots[0];
        const pass = direction === momentum, primary = snapshot.filterVerdicts[action]['cost-cap-momentum30'];
        assert.equal(primary.pass, pass);
        assert.equal(primary.momentum.metrics.return30Bps,
            snapshot.state.returns_bps_5_15_30_60_180[2]);
        assert.equal(snapshot.decisions['cost-cap-momentum30'].action, pass ? action : 'SKIP');
        assert.equal(snapshot.decisions['cost-cap-control'].action, action);
        assert.equal(f.state.arms['cost-cap-control'].position.status, 'pending');
        assert.equal(f.state.arms['cost-cap-drop-2c'].position.status, 'pending');
        if (!pass) {
            assert.equal(primary.reason, 'entry_momentum_not_aligned');
            assert.equal(f.state.arms['cost-cap-momentum30'].position, null);
            assert.equal(f.state.arms['cost-cap-momentum30'].seen[f.market.slug], undefined);
        }
    }
});

test('momentum rejects missing, nonfinite, zero, changed and unverifiable return inputs', async () => {
    const f = await fixture(); await f.observe();
    const original = f.state.snapshots[0], evaluate = snapshot => evaluateMomentum30(snapshot, 'BUY_UP', {
        market: f.market, now: f.now, dataAgeMs: f.config.dataAgeMs, policy: f.config.momentumPolicy });
    for (const value of [undefined, NaN, Infinity, null]) {
        const changed = structuredClone(original);
        changed.state.returns_bps_5_15_30_60_180[2] = value;
        assert.equal(evaluate(changed).reason, 'entry_momentum_return_unavailable');
    }
    const zero = structuredClone(original); zero.state.returns_bps_5_15_30_60_180[2] = 0; seal(zero);
    assert.equal(evaluate(zero).reason, 'entry_momentum_not_aligned');
    const tiny = structuredClone(original); tiny.state.returns_bps_5_15_30_60_180[2] = .0001; seal(tiny);
    assert.equal(evaluate(tiny).reason, 'entry_momentum_return_unavailable');
    const changed = structuredClone(original); changed.state.returns_bps_5_15_30_60_180[2] *= -1;
    assert.equal(evaluate(changed).reason, 'entry_momentum_input_invalid');
    assert.equal(evaluate({ ...original, inputHash: 'changed' }).reason, 'entry_momentum_input_hash_mismatch');
    assert.equal(evaluate({ ...original, snapshotId: 'changed' }).reason, 'entry_momentum_snapshot_identity_invalid');
    assert.equal(evaluate({ ...original, marketEnd: f.market.end + 1 }).reason, 'entry_momentum_market_mismatch');
    assert.equal(evaluate({ ...original, validation: { ...original.validation, identity: 'changed' } }).reason,
        'entry_momentum_market_mismatch');
    assert.equal(evaluate({ ...original, observedAt: original.at + 1 }).reason, 'entry_momentum_snapshot_stale');
    assert.equal(evaluate({ ...original, validation: { ...original.validation, at: original.at + 1 } }).reason,
        'entry_momentum_snapshot_stale');
    f.advance(5001);
    assert.equal(evaluate(original).reason, 'entry_momentum_snapshot_stale');
});

test('all three arms reserve and fill from one shared immutable book with independent ledgers', async () => {
    const f = await fixture(); await f.observe();
    const snapshot = f.state.snapshots[0];
    assert.deepEqual(Object.keys(snapshot.decisions), LIVE_MOMENTUM_ARMS);
    assert.ok(LIVE_MOMENTUM_ARMS.every(name => snapshot.decisions[name].entryDisposition === 'reserved'));
    f.price(.76); f.advance(250); await f.engine.manage();
    const control = f.state.arms['cost-cap-control'].position;
    assert.equal(control.status, 'matched');
    for (const name of LIVE_MOMENTUM_ARMS) {
        const position = f.state.arms[name].position;
        assert.equal(position.fill.shares, 5);
        for (const key of ['snapshotId', 'order', 'fill', 'executionAt', 'executionBookHash', 'executionCohortId'])
            assert.deepEqual(position[key], control[key], `${name}:${key}`);
    }
    assert.equal(snapshot.executionBatches.length, 1);
    assert.deepEqual(snapshot.executionBatches[0].armNames, LIVE_MOMENTUM_ARMS);
    f.advance(f.config.settlementMs); await f.engine.manage();
    f.advance(f.market.end - f.now + 1000); f.payout([1, 0]); await f.engine.manage();
    const settled = f.state.arms['cost-cap-control'].completed[0];
    assert.ok(settled.fees > 0); assert.equal(settled.gas, f.config.gasUsd);
    for (const name of LIVE_MOMENTUM_ARMS) assert.deepEqual(f.state.arms[name].completed, [settled]);
});

test('ask drop greater than two cents vetoes only the secondary arm and consumes its reserved attempt', async () => {
    const f = await fixture(); await f.observe(); f.price(.75); f.advance(250); await f.engine.manage();
    assert.equal(f.state.arms['cost-cap-control'].position.status, 'matched');
    assert.equal(f.state.arms['cost-cap-momentum30'].position.status, 'matched');
    const rejected = f.state.arms['cost-cap-drop-2c'];
    assert.equal(rejected.position, null); assert.equal(rejected.cash, 20);
    assert.equal(rejected.outcomes[f.market.slug].code, 'entry_ask_drop_above_limit');
    assert.ok(rejected.seen[f.market.slug]);
    assert.equal(f.engine.available('cost-cap-drop-2c', f.market.slug), false);
    assert.equal(f.state.snapshots[0].executionBatches.length, 1);
});

test('exact decimal drop comparison admits the two-cent boundary and rejects any larger decimal drop', () => {
    for (const [before, after, limit, above] of [[.78, .76, .02, false], [.79, .77, .02, false],
        [.78, .75, .02, true], [.78, .7599999999, .02, true], [.78, .7801, .02, false],
        [.78, .7799999, 1e-7, false], [.78, .7799998, 1e-7, true]])
        assert.equal(exactAskDropAboveLimit(before, after, limit), above);
    for (const value of [undefined, null, Infinity, NaN])
        assert.throws(() => exactAskDropAboveLimit(.78, value, .02), /execution_ask_drop_inputs_invalid/);
});

test('momentum admission veto leaves a later causal scheduled slot available', async () => {
    const f = await fixture({ momentum: -1 }); await f.observe();
    assert.equal(f.state.arms['cost-cap-momentum30'].position, null);
    assert.equal(f.engine.available('cost-cap-momentum30', f.market.slug), true);
    await f.laterSlot(60, 1); await f.observe(60);
    const next = f.state.snapshots[1];
    assert.equal(next.decisions['cost-cap-momentum30'].entryDisposition, 'reserved');
    assert.equal(next.decisions['cost-cap-control'].entryDisposition, 'arm_unavailable');
    assert.equal(next.decisions['cost-cap-drop-2c'].entryDisposition, 'arm_unavailable');
    assert.equal(f.state.arms['cost-cap-momentum30'].outcomes[f.market.slug], undefined);
});

test('cap and existing stops remain authoritative for every momentum profile arm', async () => {
    const expensive = await fixture(); expensive.price(.79); await expensive.observe();
    for (const name of LIVE_MOMENTUM_ARMS) {
        assert.equal(expensive.state.arms[name].position, null);
        assert.equal(expensive.state.snapshots[0].decisions[name].filterReason, 'entry_cost_above_cap');
        assert.equal(expensive.state.arms[name].seen[expensive.market.slug], undefined);
    }
    const stopped = await fixture();
    for (const arm of Object.values(stopped.state.arms)) arm.stopped = { at: stopped.now, reason: 'research_drawdown_limit' };
    await stopped.observe();
    assert.equal(stopped.state.snapshots[0].diagnosticOnly, true);
    assert.equal(stopped.state.snapshots[0].collectionPhase, 'all_stopped');
    assert.ok(Object.values(stopped.state.arms).every(arm => arm.stopped && !arm.position && arm.cash === 20));
});
