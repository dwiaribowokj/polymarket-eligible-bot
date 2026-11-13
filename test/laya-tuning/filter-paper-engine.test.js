import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { FilterPaperEngine, FILTER_ARMS } from '../../src/laya-filter-paper/engine.js';
import { ADAPTIVE_TIMEOUT_POLICY } from '../../src/laya-filter-paper/decision-budget.js';

async function fixture({ verify = true, beforeInference } = {}) {
    let now = Date.parse('2026-10-20T00:03:30Z');
    const config = { armNames: FILTER_ARMS, deadline: Number.MAX_SAFE_INTEGER, slots: [90, 60, 30],
        slotToleranceMs: 2000, capital: 20, shares: 5, entryCap: 5, gasUsd: .05, latencyMs: 250,
        settlementMs: 2500, dataAgeMs: 5000, decisionMs: 3000, drawdownStop: 10, shadowDrawdownStop: 2,
        limitSlippageTicks: 1, limitSlippageUsd: .01,
        decisionProtocol: { variantId: 'candidate-v2' },
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    const btc = new BtcSignal(config.control.lateSignal);
    for (let i = -185; i <= 0; i++) btc.ingest({ topic: 'prices.crypto', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now + i * 1000, value: 83020 } }, now + i * 1000);
    btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now, value: 83020, windowSeconds: 60 } }, now);
    const market = { slug: 'btc-updown-5m-1792454400', conditionId: 'condition', open: now - 210000,
        end: now + 90000, minimum: 5, tick: .01, ticks: [.01, .01], accepting: true,
        tokens: ['up', 'down'], fee: { rate: .07, exponent: 1, takerOnly: true } };
    btc.openings.set(market.open, { at: market.open, value: 83000, receivedAt: market.open + 100 });
    market.reference = { source: 'chainlink_twap_60s', open: market.open, end: market.end,
        value: 83000, observedAt: market.open, receivedAt: market.open + 100 };
    let price = .78, size = 10, payout = null;
    const getBooks = () => [
        { tokenId: 'up', conditionId: market.conditionId, tick: .01, timestamp: now, fetchedAt: now,
            bids: [{ price: price - .01, size: 10 }], asks: [{ price, size }] },
        { tokenId: 'down', conditionId: market.conditionId, tick: .01, timestamp: now, fetchedAt: now,
            bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] },
    ];
    const books = { generation: 1, tokens: market.tokens, socket: { readyState: 1 },
        snapshot: () => getBooks(), watch() {}, close() {} };
    const arm = () => ({ cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null,
        seen: {}, position: null, completed: [], outcomes: {} });
    const state = { startedAt: now, frozenAt: null, slots: {}, snapshots: [], markets: {}, providers: {}, errors: {},
        arms: Object.fromEntries(FILTER_ARMS.map(name => [name, arm()])) };
    const events = [], requests = [];
    const store = { state, save() {}, event(type, row) { events.push({ type, ...structuredClone(row) }); },
        error(stage, error) { const key = `${stage}:${error.message}`; state.errors[key] = (state.errors[key] || 0) + 1; },
        freeze(at) { if (at >= config.deadline) state.frozenAt = config.deadline; } };
    const providers = { async predict(name, snapshot) {
        requests.push({ name, input: snapshot.input, inputHash: snapshot.inputHash, snapshotId: snapshot.snapshotId });
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', model: 'typed-decisions',
            requestedAt: now, receivedAt: now, latencyMs: 0, cost: 0 };
    }, close() {} };
    let payoutCalls = 0;
    const client = { btc, books: async () => getBooks(), async payout() { payoutCalls++; return payout; },
        serverTime: async () => now, startBtcFeed() {}, close() {} };
    const options = { clock: () => now, sleep: async ms => { now += ms; }, beforeInference };
    const engine = new FilterPaperEngine(config, store, client, books, providers, options);
    if (verify) await engine.verifyClock();
    return { config, market, btc, books, state, store, providers, client, engine, events, requests, options,
        getBooks, get now() { return now; }, get payoutCalls() { return payoutCalls; }, advance(ms) { now += ms; },
        price(value) { price = value; }, size(value) { size = value; }, payout(value) { payout = value; },
        observe(seconds = 90) { return engine.observe(market, seconds, `${market.slug}:${seconds}`); } };
}

test('five worlds receive one shared inference with independent dispositions and identical fixed terms', async () => {
    const f = await fixture(); await f.observe();
    const snapshot = f.state.snapshots[0];
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].name, 'laya');
    assert.equal(snapshot.sharedDecision.action, 'BUY_UP');
    assert.equal(snapshot.decisionProtocol.variantId, 'candidate-v2');
    assert.equal(JSON.parse(snapshot.input).limit_cost_up_down[0][0], 79);
    for (const name of FILTER_ARMS) {
        assert.equal(snapshot.decisions[name].snapshotId, snapshot.snapshotId);
        assert.equal(snapshot.decisions[name].entryDisposition, 'reserved');
        assert.equal(f.state.arms[name].position.order.price, .79);
        assert.equal(f.state.arms[name].position.status, 'pending');
        assert.notEqual(snapshot.decisions[name], snapshot.sharedDecision);
    }
    snapshot.decisions.laya.entryDisposition = 'test';
    assert.equal(snapshot.decisions.combined.entryDisposition, 'reserved');
    assert.ok(Object.isFrozen(snapshot.filterVerdicts.BUY_UP));
});

test('filters freeze before inference; a veto leaves later slots eligible until an actual attempt', async () => {
    let gated = false;
    const f = await fixture({ beforeInference: async () => { gated = true; return true; } });
    f.price(.86);
    f.providers.predict = async (name, snapshot) => {
        assert.ok(gated); assert.equal(snapshot.filterVerdicts.BUY_UP['price-cap-085'].pass, false);
        f.price(.78); f.btc.openings.get(f.market.open).value = 83021; f.market.reference.value = 83021;
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt: f.now, receivedAt: f.now };
    };
    await f.observe();
    assert.equal(f.state.snapshots[0].filterVerdicts.BUY_UP['spot-twap'].pass, true);
    assert.equal(f.state.arms.laya.position.status, 'pending');
    for (const name of ['price-cap-085', 'combined']) {
        assert.equal(f.state.arms[name].position, null);
        assert.equal(f.state.arms[name].outcomes[f.market.slug].reason, 'filter_veto');
        assert.equal(f.state.arms[name].seen[f.market.slug], undefined);
    }
    f.btc.openings.get(f.market.open).value = 83000; f.market.reference.value = 83000;
    f.providers.predict = async (name, snapshot) => ({ snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP',
        requestedAt: f.now, receivedAt: f.now });
    await f.observe(60);
    for (const name of ['price-cap-085', 'combined']) {
        assert.equal(f.state.arms[name].position.status, 'pending');
        assert.ok(f.state.arms[name].seen[f.market.slug]);
        assert.equal(f.state.arms[name].outcomes[f.market.slug], undefined);
    }
    assert.equal(f.state.snapshots[0].decisions.combined.entryDisposition, 'filter_veto');
    assert.equal(f.state.snapshots[1].decisions.combined.entryDisposition, 'reserved');
});

test('strict model-edge uses every assessed rejection at snapshot and execution', async () => {
    for (const reason of ['btc_edge_insufficient', 'btc_direction_disagrees']) {
        const f = await fixture(); f.btc.assess = () => ({ reason, z: 1.4, margin: 4.9, modelEdge: .049 });
        await f.observe();
        assert.equal(f.state.arms.laya.position.status, 'pending');
        assert.equal(f.state.arms['model-edge'].position, null);
        assert.equal(f.state.arms['model-edge'].outcomes[f.market.slug].filterReason, reason);
        const execution = await fixture(); await execution.observe();
        execution.btc.assess = () => ({ reason }); execution.advance(250); await execution.engine.manage(execution.now);
        assert.equal(execution.state.arms.laya.position.status, 'matched');
        assert.equal(execution.state.arms['model-edge'].outcomes[execution.market.slug].code, 'execution_signal_invalid');
    }
    const f = await fixture(); f.btc.assess = () => ({ reason: 'btc_reference_unverified' });
    await assert.rejects(f.observe(), /btc_reference_unverified/); assert.equal(f.requests.length, 0);
});

test('no shared decision when all arms are stopped, occupied, or already seen; another available arm still proceeds', async () => {
    for (const unavailable of ['stopped', 'position', 'seen']) {
        const f = await fixture();
        for (const arm of Object.values(f.state.arms)) {
            if (unavailable === 'seen') arm.seen[f.market.slug] = {};
            else arm[unavailable] = {};
        }
        await f.observe(); assert.equal(f.requests.length, 0); assert.equal(f.state.snapshots.length, 0);
        f.state.arms['spot-twap'].stopped = null; f.state.arms['spot-twap'].position = null; f.state.arms['spot-twap'].seen = {};
        await f.observe(60); assert.equal(f.requests.length, 1);
        assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, unavailable === 'stopped' ? 'arm_stopped' : 'arm_unavailable');
    }
});

test('SKIP and provider timeout leave later slots eligible without inventing a fill', async () => {
    for (const status of ['ok', 'decision_timeout']) {
        const f = await fixture(); const predict = f.providers.predict;
        f.providers.predict = async (...args) => ({ ...await predict(...args), status, action: 'SKIP' });
        await f.observe();
        for (const arm of Object.values(f.state.arms)) { assert.equal(arm.position, null); assert.deepEqual(arm.seen, {}); }
        f.providers.predict = predict; await f.observe(60);
        assert.equal(f.requests.length, 2); assert.equal(f.state.arms.laya.position.status, 'pending');
    }
});

test('decision deadline uses provider interval, independently of snapshot preparation delay', async () => {
    const f = await fixture();
    f.providers.predict = async (name, snapshot) => {
        f.advance(1200); const requestedAt = f.now; f.advance(1900);
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt,
            receivedAt: f.now, latencyMs: 1900 };
    };
    await f.observe(); assert.equal(f.state.arms.laya.position.status, 'pending');
    const late = await fixture();
    late.providers.predict = async (name, snapshot) => {
        const requestedAt = late.now; late.advance(3001);
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt, receivedAt: late.now };
    };
    await late.observe(); assert.equal(late.state.snapshots[0].decisions.laya.entryDisposition, 'late_response');
});

test('partial FAK depth is independent per arm and matched cash debits once after simulated settlement', async () => {
    const f = await fixture(); await f.observe(); f.size(2); f.advance(249); await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.position.status, 'pending');
    f.advance(1); await f.engine.manage(f.now);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position.status, 'matched'); assert.equal(arm.position.fill.shares, 2); assert.equal(arm.cash, 20);
    }
    f.advance(2500); await f.engine.manage(f.now);
    const cash = f.state.arms.laya.cash; await f.engine.manage(f.now);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position.holdings, 2); assert.equal(arm.position.status, 'filled'); assert.equal(arm.cash, cash);
    }
});

test('a logging error after a durable match preserves inventory for exactly one later settlement', async () => {
    const f = await fixture(); await f.observe(); f.advance(250);
    const emit = f.store.event; let durable;
    f.store.event = (type, row) => {
        emit(type, row);
        if (type === 'fill_matched' && row.arm === 'laya') {
            durable = structuredClone(f.state); throw new Error('event_append_failed');
        }
    };
    await assert.rejects(f.engine.manage(f.now), /event_append_failed/);
    assert.equal(durable.arms.laya.position.status, 'matched');
    assert.equal(f.state.arms.laya.position.status, 'matched');
    assert.equal(f.state.arms.laya.outcomes[f.market.slug], undefined);
    assert.equal(f.state.arms.laya.cash, 20);
    f.store.event = emit; f.advance(2500); await f.engine.manage(f.now);
    const cash = f.state.arms.laya.cash; await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.cash, cash);
    f.advance(90000); f.payout([1, 0]); await f.engine.manage(f.now); await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.completed.length, 1);
    assert.equal(f.state.arms.laya.outcomes[f.market.slug].reason, 'settled');
});

test('FAK never chases above fixed limit, and a stale generation expires every reserved attempt', async () => {
    const f = await fixture(); await f.observe(); f.price(.80); f.advance(250); await f.engine.manage(f.now);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position, null); assert.equal(arm.cash, 20); assert.equal(arm.outcomes[f.market.slug].reason, 'no_fill');
    }
    const gap = await fixture(); await gap.observe(); gap.books.generation++; gap.advance(250); await gap.engine.manage(gap.now);
    assert.equal(gap.state.arms.laya.outcomes[gap.market.slug].code, 'execution_metadata_changed_or_expired');
    await gap.observe(60); assert.equal(gap.requests.length, 1);
});

test('missing and stale marks remain unknown while a fresh empty bid book is a valid zero valuation', async () => {
    const f = await fixture(); await f.observe(); f.advance(250); await f.engine.manage(f.now); f.advance(2500);
    f.client.books = async () => { throw new Error('read_timeout'); }; await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.position.mark, undefined); assert.equal(f.state.arms.laya.valuationKnown, false);
    assert.equal(f.state.arms.laya.drawdown, 0);
    f.advance(5000); f.client.books = async () => f.getBooks().map(b => ({ ...b, bids: [] })); await f.engine.manage(f.now);
    const arm = f.state.arms.laya, observedAt = arm.position.markObservedAt;
    assert.equal(arm.position.mark, 0); assert.equal(arm.valuationKnown, true); assert.ok(arm.shadowStop);
    f.advance(5001); f.client.books = async () => { throw new Error('read_timeout'); }; await f.engine.manage(f.now);
    assert.equal(arm.position.markObservedAt, observedAt); assert.equal(arm.position.markFresh, false); assert.equal(arm.valuationKnown, false);
});

test('official payout is shared, cached before redemption, retried with backoff and never starves other arms', async () => {
    const f = await fixture(); await f.observe(); f.advance(250); await f.engine.manage(f.now);
    f.advance(2500); await f.engine.manage(f.now); f.advance(90000);
    await Promise.all([f.engine.manage(f.now), f.engine.resolveOutcomes(f.now)]);
    assert.equal(f.payoutCalls, 1);
    assert.ok(Object.values(f.state.arms).every(arm => arm.position && !arm.completed.length));
    f.payout([1, 0]); await f.engine.manage(f.now); assert.equal(f.payoutCalls, 1);
    f.advance(15000); await Promise.all([f.engine.manage(f.now), f.engine.resolveOutcomes(f.now)]);
    assert.equal(f.payoutCalls, 2); assert.deepEqual(f.state.markets[f.market.slug].payout, [1, 0]);
    for (const arm of Object.values(f.state.arms)) { assert.equal(arm.position, null); assert.equal(arm.completed.length, 1); }
    await f.engine.manage(f.now); assert.equal(f.payoutCalls, 2);
});

test('settlement errors retain positions, cap exponential backoff, and survive engine restart', async () => {
    const f = await fixture(); await f.observe(); f.advance(250); await f.engine.manage(f.now); f.advance(2500);
    await f.engine.manage(f.now); f.advance(90000);
    let calls = 0; f.client.payout = async () => { calls++; throw new Error('rpc_offline'); };
    await f.engine.manage(f.now); let record = f.state.markets[f.market.slug];
    assert.equal(record.payoutNextAt - f.now, 30000); assert.equal(calls, 1);
    f.advance(30000); await f.engine.manage(f.now); assert.equal(record.payoutNextAt - f.now, 60000);
    const restarted = new FilterPaperEngine(f.config, f.store, f.client, f.books, f.providers, f.options);
    await restarted.manage(f.now); assert.equal(calls, 2);
    f.advance(60000); f.client.payout = async () => [0, 1]; await restarted.manage(f.now);
    for (const arm of Object.values(f.state.arms)) { assert.equal(arm.completed.length, 1); assert.ok(arm.shadowStop); }
});

test('serialized matched positions resume with equivalent cash, payout, and one debit', async () => {
    const f = await fixture(); await f.observe(); f.advance(250); await f.engine.manage(f.now);
    const original = structuredClone(f.state), resumed = JSON.parse(JSON.stringify(f.state));
    const resumedStore = { ...f.store, state: resumed };
    const restarted = new FilterPaperEngine(f.config, resumedStore, f.client, f.books, f.providers, f.options);
    f.advance(2500); await f.engine.manage(f.now); await restarted.manage(f.now);
    f.advance(90000); f.payout([1, 0]); await f.engine.manage(f.now); await restarted.manage(f.now);
    for (const name of FILTER_ARMS) {
        assert.equal(original.arms[name].cash, 20);
        assert.equal(resumed.arms[name].cash, f.state.arms[name].cash);
        assert.deepEqual(resumed.arms[name].completed, f.state.arms[name].completed);
    }
});

test('startup requires real clock verification and cached samples never gain a new lifetime', async () => {
    const f = await fixture({ verify: false });
    assert.equal(f.engine.clockFresh(), false); await assert.rejects(f.observe(), /snapshot_clock_unverified/);
    f.client.clock = { at: f.now }; await f.engine.verifyClock(); assert.equal(f.engine.clockFresh(), true);
    f.advance(29999); assert.equal(f.engine.clockFresh(), true);
    f.advance(1); assert.equal(f.engine.clockFresh(), false); assert.equal(await f.engine.verifyClock(), false);
    f.client.clock.at = f.now; assert.equal(await f.engine.verifyClock(), true);
    const restarted = new FilterPaperEngine(f.config, f.store, f.client, f.books, f.providers, f.options);
    assert.equal(restarted.clockFresh(), false);
});

test('a cached clock sample schedules its next probe at expiry without a ten-second admission gap', async () => {
    const f = await fixture({ verify: false }); const started = f.now;
    f.client.clock = { at: started }; await f.engine.verifyClock(); f.advance(20000);
    await f.engine.verifyClock(); assert.equal(f.engine.clockRetryAt, started + 30000);
    let refreshed = 0;
    f.client.serverTime = async () => { refreshed++; f.client.clock.at = f.now; return f.now; };
    for (const arm of Object.values(f.state.arms)) arm.stopped = { reason: 'test' };
    f.advance(10000); await f.engine.tick(f.now); await f.engine.clockTask;
    assert.equal(refreshed, 1); assert.equal(f.engine.clockFresh(), true);
    assert.equal(f.engine.clockVerifiedAt, started + 30000);
});

test('an admitted malformed response retains its one actual inference marker', async () => {
    const f = await fixture();
    f.providers.predict = async (name, snapshot) => {
        snapshot.inferenceAttempted = true;
        return { snapshotId: snapshot.snapshotId, status: 'invalid', action: 'SKIP', latencyMs: 12, reason: 'choice_invalid' };
    };
    await f.observe(); assert.equal(f.state.snapshots[0].sharedDecision.inferenceAttempted, true);
    assert.ok(Object.values(f.state.arms).every(arm => !arm.position));
});

test('hard drawdown stops persist independently while a pilot breach allows paper research to continue', async () => {
    const f = await fixture(); f.state.arms.laya.cash = 17; f.state.arms.combined.cash = 9;
    await f.engine.manage(f.now);
    assert.ok(f.state.arms.laya.shadowStop); assert.equal(f.state.arms.laya.stopped, null);
    assert.equal(f.state.arms.combined.stopped.reason, 'research_drawdown_limit');
    f.state.arms.combined.cash = 20; await f.engine.manage(f.now); await f.observe();
    assert.equal(f.state.arms.laya.position.status, 'pending');
    assert.equal(f.state.arms.combined.position, null);
    assert.equal(f.state.snapshots[0].decisions.combined.entryDisposition, 'arm_stopped');
});

test('closing during inference cannot reserve a late response, and missing model assessment never passes execution', async () => {
    const f = await fixture(); let release;
    f.providers.predict = async (name, snapshot) => new Promise(resolve => {
        release = () => resolve({ snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt: f.now, receivedAt: f.now });
    });
    const pending = f.observe();
    while (!release) await Promise.resolve();
    f.engine.close(); release(); await pending;
    assert.equal(f.state.arms.laya.position, null);
    assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, 'closed');
    const missing = await fixture(); await missing.observe(); missing.btc.assess = () => ({});
    missing.advance(250); await missing.engine.manage(missing.now);
    assert.equal(missing.state.arms['model-edge'].outcomes[missing.market.slug].code, 'execution_signal_invalid');
});

test('gate blocks inference, deadline rejects admission, and close cancels pending but preserves matched inventory', async () => {
    const blocked = await fixture({ beforeInference: async () => false }); await blocked.observe();
    assert.equal(blocked.requests.length, 0); assert.equal(blocked.state.snapshots[0].sharedDecision.status, 'inference_gate_blocked');
    const deadline = await fixture(); deadline.config.deadline = deadline.now;
    await assert.rejects(deadline.observe(), /slot_late_after_validation/);
    const pending = await fixture(); await pending.observe(); pending.engine.close();
    assert.equal(pending.state.arms.laya.position, null);
    assert.equal(pending.state.arms.laya.outcomes[pending.market.slug].reason, 'shutdown_pending_cancelled');
    const matched = await fixture(); await matched.observe(); matched.advance(250); await matched.engine.manage(matched.now);
    matched.engine.close(); assert.equal(matched.state.arms.laya.position.status, 'matched');
});

test('one durable admission and execution view survive synchronous storage delays and arm reordering', async () => {
    const runs = [];
    for (const names of [FILTER_ARMS, [...FILTER_ARMS].reverse()]) {
        const f = await fixture(); f.engine.armNames = names;
        const emit = f.store.event, batches = [];
        f.store.eventBatch = rows => {
            batches.push({ rows: structuredClone(rows), durable: structuredClone(f.state) });
            f.advance(30);
            for (const row of rows) { emit(row.type, row.detail); f.advance(35); }
        };
        await f.observe();
        const positions = Object.values(f.state.arms).map(arm => arm.position);
        assert.equal(batches.length, 1);
        assert.ok(Object.values(batches[0].durable.arms).every(arm => arm.position?.status === 'pending'));
        assert.equal(new Set(positions.map(p => p.submittedAt)).size, 1);
        assert.equal(new Set(positions.map(p => p.activeAt)).size, 1);
        f.advance(positions[0].activeAt - f.now);
        const executionAt = f.now; let bookReads = 0;
        f.books.snapshot = () => {
            bookReads++; f.price(f.now === executionAt ? .78 : .80); return f.getBooks();
        };
        await f.engine.manage(f.now);
        assert.equal(bookReads, 1);
        assert.equal(batches.length, 2);
        assert.ok(Object.values(batches[1].durable.arms).every(arm => arm.position?.status === 'matched'));
        for (const arm of Object.values(f.state.arms)) {
            assert.equal(arm.position.executionAt, executionAt);
            assert.equal(arm.position.fill.shares, 5);
            assert.equal(arm.position.fill.notional, 3.9);
        }
        assert.equal(new Set(positions.map(p => p.executionBookHash)).size, 1);
        assert.equal(f.state.snapshots[0].executionBatches.length, 1);
        runs.push(Object.fromEntries(FILTER_ARMS.map(name => [name, f.state.arms[name].position])));
    }
    assert.deepEqual(runs[0], runs[1]);
});

test('fallback event logging sees every reservation already durable and cannot stagger admission', async () => {
    const f = await fixture(); const emit = f.store.event; let durable;
    f.store.save = () => { durable = structuredClone(f.state); f.advance(15); };
    f.store.event = (type, row) => {
        if (type === 'order_pending') {
            assert.ok(Object.values(durable.arms).every(arm => arm.position?.status === 'pending'));
            f.advance(100);
        }
        emit(type, row);
    };
    await f.observe();
    assert.equal(new Set(Object.values(f.state.arms).map(arm => arm.position.activeAt)).size, 1);
    assert.equal(new Set(Object.values(f.state.arms).map(arm => arm.position.submittedAt)).size, 1);
});

test('future tick arguments cannot execute before actual activation and independent cohorts use later books', async () => {
    const f = await fixture(); await f.observe();
    const delayed = f.state.arms.combined.position; delayed.activeAt += 100;
    let reads = 0; f.books.snapshot = () => { reads++; return f.getBooks(); };
    f.advance(249); await f.engine.manage(f.now + 1000);
    assert.equal(reads, 0); assert.ok(Object.values(f.state.arms).every(arm => arm.position.status === 'pending'));
    f.advance(1); await f.engine.manage(f.now);
    assert.equal(reads, 1); assert.equal(f.state.arms.laya.position.status, 'matched');
    assert.equal(delayed.status, 'pending');
    f.price(.80); f.advance(100); await f.engine.manage(f.now);
    assert.equal(reads, 2); assert.equal(f.state.arms.combined.position, null);
    assert.equal(f.state.arms.combined.outcomes[f.market.slug].reason, 'no_fill');
    const batches = f.state.snapshots[0].executionBatches;
    assert.equal(batches.length, 2); assert.notEqual(batches[0].cohortId, batches[1].cohortId);
    assert.notEqual(batches[0].bookHash, batches[1].bookHash);
});

test('execution retains exact candidate rejection reasons and applies each world cash and risk independently', async () => {
    for (const [price, reason] of [[.70, 'ask_below_entry_minimum'], [.91, 'ask_above_entry_maximum']]) {
        const f = await fixture(); await f.observe(); f.price(price); f.advance(250); await f.engine.manage(f.now);
        for (const arm of Object.values(f.state.arms)) assert.equal(arm.outcomes[f.market.slug].code, `execution_${reason}`);
    }
    const f = await fixture(); await f.observe();
    f.state.arms['spot-twap'].cash = 3; f.state.arms['spot-twap'].peak = 3;
    f.state.arms.combined.cash = 9;
    f.advance(250); await f.engine.manage(f.now);
    assert.equal(f.state.arms.laya.position.status, 'matched');
    assert.equal(f.state.arms['spot-twap'].outcomes[f.market.slug].code, 'execution_insufficient_virtual_cash');
    assert.equal(f.state.arms.combined.position, null); assert.ok(f.state.arms.combined.stopped);
});

test('gate latency precedes final fresh capture and the remaining slot budget can await real source updates', async () => {
    const f = await fixture(); const start = f.now; let gateAt;
    const update = () => {
        f.btc.ingest({ topic: 'prices.crypto', type: 'update',
            payload: { symbol: 'btcusd', timestamp: f.now, value: 83020 } }, f.now);
        f.btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
            payload: { symbol: 'btcusd', timestamp: f.now, value: 83020, windowSeconds: 60 } }, f.now);
    };
    f.engine.beforeInference = async snapshot => {
        if (!snapshot.snapshotId) { f.advance(800); gateAt = f.now; update(); }
        return true;
    };
    await f.observe();
    assert.equal(f.state.snapshots[0].at, gateAt);
    assert.equal(f.state.snapshots[0].observedAt, gateAt);
    assert.equal(f.state.snapshots[0].timing.inferenceInputAgeMs, 0);
    assert.equal(f.requests.length, 1); assert.equal(gateAt - start, 800);

    const waiting = await fixture(); waiting.btc.twap.at -= 1700; const waitingStart = waiting.now;
    waiting.engine.sleep = async ms => {
        waiting.advance(ms);
        if (waiting.now - waitingStart >= 1500) {
            waiting.btc.ingest({ topic: 'prices.crypto', type: 'update',
                payload: { symbol: 'btcusd', timestamp: waiting.now, value: 83020 } }, waiting.now);
            waiting.btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
                payload: { symbol: 'btcusd', timestamp: waiting.now, value: 83020, windowSeconds: 60 } }, waiting.now);
        }
    };
    await waiting.observe();
    assert.equal(waiting.requests.length, 1); assert.equal(waiting.state.snapshots[0].timing.waitMs, 1500);
    assert.equal(waiting.state.snapshots[0].timing.beforeAgeMs, 1700);
    assert.equal(waiting.state.snapshots[0].timing.inferenceInputAgeMs, 0);
});

test('requests require full decision plus activation and scheduling headroom after snapshot persistence', async () => {
    for (const age of [1600, 1601]) {
        const f = await fixture(); f.btc.twap.at -= age;
        const originalObservedAt = f.btc.twap.at;
        await f.observe();
        const snapshot = f.state.snapshots[0];
        assert.equal(snapshot.observedAt, originalObservedAt);
        assert.equal(snapshot.timing.maxInputAgeMs, 1600);
        if (age === 1600) {
            assert.equal(f.requests.length, 1); assert.equal(snapshot.timing.inferenceHeadroomMs, 3400);
        } else {
            assert.equal(f.requests.length, 0); assert.equal(snapshot.sharedDecision.status, 'insufficient_input_headroom');
            assert.equal(snapshot.timing.waitMs, 1900); assert.equal(snapshot.sharedDecision.inferenceAttempted, false);
        }
    }
    const persisted = await fixture(); persisted.btc.twap.at -= 1590;
    const emit = persisted.store.event;
    persisted.store.event = (type, detail) => { emit(type, detail); if (type === 'snapshot') persisted.advance(11); };
    await persisted.observe();
    assert.equal(persisted.requests.length, 0);
    assert.equal(persisted.state.snapshots[0].timing.inferenceInputAgeMs, 1601);
    assert.equal(persisted.state.snapshots[0].sharedDecision.status, 'insufficient_input_headroom');
});

test('slot expiry after freshness waiting persists a specific reason and never starts inference', async () => {
    const f = await fixture(); f.btc.twap.at -= 1700;
    f.engine.sleep = async () => { f.advance(2001); };
    await assert.rejects(f.observe(), /slot_late_after_validation/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.slots[`${f.market.slug}:90`].reason, 'slot_late_after_validation');
});

test('an in-flight clock refresh crossing expiry is awaited within the observation slot', async () => {
    const f = await fixture(); f.engine.clockVerifiedAt = f.now - 29999;
    let release;
    f.client.serverTime = () => new Promise(resolve => { release = () => resolve(f.now); });
    const refresh = f.engine.verifyClock();
    f.engine.beforeInference = async () => { f.advance(2); return true; };
    f.engine.sleep = async ms => { f.advance(ms); release(); };
    await f.observe(); await refresh;
    assert.equal(f.requests.length, 1); assert.equal(f.engine.clockFresh(), true);
    assert.ok(f.engine.clockVerifiedAt > f.state.startedAt);

    const expired = await fixture(); expired.engine.clockVerifiedAt = expired.now - 30000;
    expired.engine.clockTask = new Promise(() => {});
    await assert.rejects(expired.observe(), /snapshot_clock_unverified/);
    assert.equal(expired.requests.length, 0);
    assert.equal(expired.now - expired.state.startedAt, 2000);
    assert.equal(expired.engine.clockFresh(), false);
});

test('response admission reserves activation headroom and execution rechecks actual source and book age', async () => {
    const f = await fixture(); f.btc.twap.at -= 1600;
    f.providers.predict = async (name, snapshot) => {
        f.advance(1); const requestedAt = f.now; f.advance(3000);
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt, receivedAt: f.now };
    };
    await f.observe();
    for (const name of FILTER_ARMS) {
        assert.equal(f.state.snapshots[0].decisions[name].entryDisposition, 'insufficient_execution_headroom');
        assert.equal(f.state.arms[name].position, null);
        assert.equal(f.state.arms[name].seen[f.market.slug], undefined);
    }
    const late = await fixture(); await late.observe(); late.advance(5001); await late.engine.manage(late.now);
    assert.equal(late.state.arms.laya.outcomes[late.market.slug].code, 'execution_stale');
    const future = await fixture(); await future.observe(); future.advance(250);
    future.books.snapshot = () => future.getBooks().map(book => ({ ...book, timestamp: future.now + 1 }));
    await future.engine.manage(future.now);
    assert.equal(future.state.arms.laya.outcomes[future.market.slug].code, 'execution_book_stale_or_future');
});

test('a slow world releases unrelated arm locks so later pending entries still execute on time', async () => {
    const f = await fixture(); await f.observe(); f.advance(250); await f.engine.manage(f.now);
    const pending = structuredClone(f.state.arms.combined.position);
    pending.status = 'pending'; pending.activeAt = f.now + 3000;
    f.state.arms.combined.position = null;
    f.advance(2500); let release;
    const stalled = new Promise(resolve => { release = () => resolve(f.getBooks()); });
    f.client.books = async () => stalled;
    const managing = f.engine.manage(f.now);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.engine.managingArms.has('laya'), true);
    assert.equal(f.engine.managingArms.has('combined'), false);
    f.state.arms.combined.position = pending;
    f.advance(500); await f.engine.manage(f.now);
    assert.equal(f.state.arms.combined.position.status, 'matched');
    assert.equal(f.engine.managingArms.has('laya'), true);
    release(); await managing;
    assert.equal(f.engine.managingArms.size, 0);
});

test('final inference gate catches competing activity and headroom lost after the frozen snapshot', async () => {
    const blocked = await fixture(); let calls = 0;
    blocked.engine.beforeInference = async () => ++calls === 1;
    await blocked.observe();
    assert.equal(calls, 2); assert.equal(blocked.requests.length, 0);
    assert.equal(blocked.state.snapshots[0].sharedDecision.status, 'inference_gate_blocked');
    const delayed = await fixture(); delayed.btc.twap.at -= 1500;
    delayed.engine.beforeInference = async snapshot => {
        if (snapshot.snapshotId) delayed.advance(101);
        return true;
    };
    await delayed.observe();
    assert.equal(delayed.requests.length, 0);
    assert.equal(delayed.state.snapshots[0].sharedDecision.status, 'insufficient_input_headroom');
});

test('fresh sources never extend an older metadata validation certificate', async () => {
    const f = await fixture(); const start = f.now; f.btc.twap.at -= 1700;
    f.engine.sleep = async ms => {
        f.advance(ms);
        if (f.now - start >= 1700) {
            f.btc.ingest({ topic: 'prices.crypto', type: 'update',
                payload: { symbol: 'btcusd', timestamp: f.now, value: 83020 } }, f.now);
            f.btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
                payload: { symbol: 'btcusd', timestamp: f.now, value: 83020, windowSeconds: 60 } }, f.now);
        }
    };
    await f.observe(); const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.validation.at, start); assert.equal(snapshot.observedAt, start + 1700);
    assert.equal(snapshot.timing.inferenceInputAgeMs, 0); assert.equal(snapshot.timing.inferenceValidationAgeMs, 1700);
    assert.equal(snapshot.sharedDecision.status, 'insufficient_validation_headroom'); assert.equal(f.requests.length, 0);
});

test('post-commit logging failure preserves shared admission and its observed slot', async () => {
    const f = await fixture(); let durable;
    f.store.eventBatch = () => {
        durable = structuredClone(f.state);
        throw Object.assign(new Error('paper_event_log_failed'), { durableStateCommitted: true });
    };
    await assert.rejects(f.observe(), /paper_event_log_failed/);
    const slot = f.state.slots[`${f.market.slug}:90`];
    assert.equal(slot.status, 'observed'); assert.equal(slot.reason, undefined);
    assert.equal(slot.loggingError, 'paper_event_log_failed');
    for (const arm of Object.values(durable.arms)) assert.equal(arm.position.status, 'pending');
    for (const arm of Object.values(f.state.arms)) assert.equal(arm.position.status, 'pending');
});

test('adaptive paper admits a 3500ms decision and executes a shared partial fill under original limits', async () => {
    const f = await fixture(); f.config.decisionTimeoutPolicy = ADAPTIVE_TIMEOUT_POLICY;
    f.providers.predict = async (name, snapshot) => {
        const requestedAt = f.now; f.advance(3500);
        assert.equal(snapshot.decisionDeadlineAt, requestedAt + 4600);
        return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt, receivedAt: f.now };
    };
    await f.observe(); const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.timing.decisionBudgetMs, 4600);
    for (const arm of Object.values(f.state.arms)) assert.equal(arm.position.status, 'pending');
    f.size(2); f.advance(250); await f.engine.manage(f.now);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position.status, 'matched'); assert.equal(arm.position.fill.shares, 2);
        assert.equal(arm.position.order.price, .79);
        assert.equal(arm.position.executionBookHash, f.state.arms.laya.position.executionBookHash);
        assert.equal(arm.position.executionInputAgeMs, 3750);
    }
});

test('adaptive admission rejects 3500ms when original source or metadata consumes its budget', async () => {
    for (const source of ['source', 'metadata']) {
        const f = await fixture(); f.config.decisionTimeoutPolicy = ADAPTIVE_TIMEOUT_POLICY;
        if (source === 'source') f.btc.twap.at -= 1200;
        else {
            const fresh = f.engine.freshSnapshot.bind(f.engine);
            f.engine.freshSnapshot = async (...args) => {
                f.advance(1200);
                f.btc.ingest({ topic: 'prices.crypto', type: 'update',
                    payload: { symbol: 'btcusd', timestamp: f.now, value: 83020 } }, f.now);
                f.btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
                    payload: { symbol: 'btcusd', timestamp: f.now, value: 83020, windowSeconds: 60 } }, f.now);
                return fresh(...args);
            };
        }
        f.providers.predict = async (name, snapshot) => {
            const requestedAt = f.now; assert.equal(snapshot.timing.decisionBudgetMs, 3400); f.advance(3500);
            return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt, receivedAt: f.now };
        };
        await f.observe();
        assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, 'late_response');
        for (const arm of Object.values(f.state.arms)) assert.equal(arm.position, null);
    }
});

test('adaptive response logging and delayed execution cannot refresh the original evidence', async () => {
    for (const delayedAt of ['admission', 'execution']) {
        const f = await fixture(); f.config.decisionTimeoutPolicy = ADAPTIVE_TIMEOUT_POLICY; f.btc.twap.at -= 1000;
        f.providers.predict = async (name, snapshot) => {
            const requestedAt = f.now; f.advance(3500); const receivedAt = f.now;
            if (delayedAt === 'admission') f.advance(200);
            return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt, receivedAt };
        };
        await f.observe();
        if (delayedAt === 'admission') {
            assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, 'insufficient_execution_headroom');
            assert.equal(f.state.arms.laya.position, null);
        } else {
            assert.equal(f.state.arms.laya.position.status, 'pending'); f.advance(501);
            f.btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
                payload: { symbol: 'btcusd', timestamp: f.now, value: 83020, windowSeconds: 60 } }, f.now);
            await f.engine.manage(f.now);
            assert.equal(f.state.arms.laya.outcomes[f.market.slug].code, 'execution_stale');
        }
    }
});

test('adaptive entry rejects a changed deadline or future validation timestamp', async () => {
    for (const change of ['deadline', 'metadata']) {
        const f = await fixture(); f.config.decisionTimeoutPolicy = ADAPTIVE_TIMEOUT_POLICY;
        f.providers.predict = async (name, snapshot) => {
            if (change === 'deadline') snapshot.decisionDeadlineAt++;
            else snapshot.validation.at = f.now + 1;
            return { snapshotId: snapshot.snapshotId, status: 'ok', action: 'BUY_UP', requestedAt: f.now, receivedAt: f.now };
        };
        await f.observe(); assert.equal(f.state.snapshots[0].decisions.laya.entryDisposition, 'invalid_decision_budget');
        assert.equal(f.state.arms.laya.position, null);
    }
});
