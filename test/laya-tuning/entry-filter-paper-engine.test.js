import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';
import { ADAPTIVE_TIMEOUT_POLICY } from '../../src/laya-filter-paper/decision-budget.js';
import { ENTRY_FILTER_POLICY } from '../../src/decision-paper/entry-filter.js';
import { ENTRY_FILTER_ARMS, ENTRY_OBSERVATION_POLICY, LIVE_TUNING_PROFILE, LIVE_TUNING_ARMS,
    LIVE_TUNING_POLICY, loadEntryFilterPaperConfig } from '../../src/entry-filter-paper/config.js';
import { metadataIdentity } from '../../src/ai-shadow/engine.js';
import { EntryFilterPaperEngine } from '../../src/entry-filter-paper/engine.js';
import { EntryFilterPaperStore } from '../../src/entry-filter-paper/store.js';

async function fixture(t, { seconds = 90, direction = 1, durable = false, recovery = false, tuning = false, passive = false } = {}) {
    const open = Date.parse('2026-10-20T00:00:00Z');
    let now = open + (300 - seconds) * 1000;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-filter-paper-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: 'entry-test', dataDir, policy: {}, sources: [], armNames: [...ENTRY_FILTER_ARMS],
        baselineArm: 'eligible', capital: 20, shares: 5, entryCap: 5, gasUsd: .05,
        slots: [90, 60, 30], slotToleranceMs: 2000, snapshotAgeTargetMs: 1600,
        snapshotSlotReserveMs: 100, dataAgeMs: 5000, decisionMs: 0, latencyMs: 250, inferenceReserveMs: 150,
        settlementMs: 2500, deadline: Number.MAX_SAFE_INTEGER, drawdownStop: 10, shadowDrawdownStop: 2,
        decisionTimeoutPolicy: ADAPTIVE_TIMEOUT_POLICY, limitSlippageTicks: 1, limitSlippageUsd: .01,
        entryFilter: ENTRY_FILTER_POLICY, costCapPerShare: .85,
        control: { ...BASELINE, paperGasUsd: .05, lateSignal: { ...BASELINE.lateSignal, calibration: null } } };
    if (recovery) Object.assign(config, { observationPolicy: ENTRY_OBSERVATION_POLICY,
        slots: [...ENTRY_OBSERVATION_POLICY.slots], snapshotAgeTargetMs: 4600, snapshotSlotReserveMs: 500 });
    if (tuning) Object.assign(config, { profile: LIVE_TUNING_PROFILE, armNames: [...LIVE_TUNING_ARMS],
        baselineArm: 'cost-cap-control', tuningPolicy: { ...LIVE_TUNING_POLICY } });
    if (passive) config.passiveCollection = { enabled: true, afterArmStop: true, whileArmsBusy: true };
    const btc = new BtcSignal(config.control.lateSignal);
    const feed = at => btc.ingest({ topic: 'prices.crypto', type: 'update',
        payload: { symbol: 'btcusd', timestamp: at, value: 83000 + direction * 20 + Math.sin(at / 1000) * .1 } }, at);
    for (let at = now - 185000; at <= now; at += 1000) feed(at);
    const twap = () => btc.ingest({ topic: 'prices.crypto.twap', type: 'update',
        payload: { symbol: 'btcusd', timestamp: now, value: 83000 + direction * 20, windowSeconds: 60 } }, now);
    twap();
    const market = { slug: 'btc-updown-5m-1792454400', conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, reference: { source: 'chainlink_twap_60s',
            open, end: open + 300000, value: 83000, observedAt: open, receivedAt: open + 100 } };
    btc.openings.set(open, { at: open, value: 83000, receivedAt: open + 100 });
    let price = .78, size = 10, payout = null, otherPrice = .22;
    const getBooks = () => market.tokens.map((tokenId, index) => {
        const high = index === (direction === 1 ? 0 : 1), ask = high ? price : otherPrice;
        return { tokenId, conditionId: market.conditionId, tick: market.ticks[index], timestamp: now, fetchedAt: now,
            bids: [{ price: ask - .01, size: 10 }], asks: [{ price: ask, size: high ? size : 10 }] };
    });
    const books = { generation: 1, tokens: market.tokens, socket: { readyState: 1 },
        snapshot: () => getBooks(), watch() {}, close() {} };
    const blankArm = () => ({ cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null,
        seen: {}, position: null, completed: [], outcomes: {} });
    const events = [], batches = [];
    const store = durable ? new EntryFilterPaperStore(config, now) : {
        state: { id: config.id, startedAt: now, frozenAt: null, providers: {}, slots: {}, snapshots: [], markets: {}, errors: {},
            arms: Object.fromEntries(config.armNames.map(name => [name, blankArm()])) }, save() {}, freeze() {} };
    store.eventBatch = rows => { store.save(); batches.push(structuredClone(rows)); events.push(...structuredClone(rows)); };
    store.event = (type, detail = {}) => store.eventBatch([{ type, detail }]);
    store.error = (stage, error) => { store.state.errors[`${stage}:${error.message}`] = true; };
    const providers = { predict() { throw new Error('inference_forbidden_in_test'); }, close() {} };
    const client = { btc, books: async () => getBooks(), payout: async () => payout,
        marketInfo: async () => ({ fee: market.fee }), validateInfo: (value, info) => assert.deepEqual(value.fee, info.fee),
        serverTime: async () => now, startBtcFeed() {}, close() {} };
    const options = { clock: () => now, sleep: async ms => { now += ms; },
        beforeInference: async () => { throw new Error('inference_gate_forbidden_in_test'); } };
    const engine = new EntryFilterPaperEngine(config, store, client, books, providers, options);
    await engine.verifyClock();
    return { config, market, btc, books, client, providers, options, engine, store, state: store.state, events, batches,
        getBooks, get now() { return now; }, advance(ms) { now += ms; },
        price(value) { price = value; }, size(value) { size = value; }, otherPrice(value) { otherPrice = value; },
        payout(value) { payout = value; }, async laterSlot(slot) {
            const until = market.end - slot * 1000;
            for (let at = btc.spot.at(-1).at + 1000; at <= until; at += 1000) feed(at);
            now = until; twap(); await engine.verifyClock();
        }, observe(slot = seconds) { return engine.observe(market, slot, `${market.slug}:${slot}`); } };
}

test('configuration fixes four independent worlds and fingerprints the provider-free runner without secrets', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = loadEntryFilterPaperConfig({ PRIVATE_KEY: 'private-marker', AI_SHADOW_LAYA_URL: 'private-endpoint' }, dir);
    assert.deepEqual(config.armNames, ['eligible', 'cost-cap', 'buffer', 'combined']);
    assert.equal(config.experiment, 'entry-filter-paper-v2'); assert.equal(config.baselineArm, 'eligible');
    assert.equal(config.inferencePolicy, 'none'); assert.equal(config.costCapPerShare, .85);
    assert.equal(config.capital, 20); assert.equal(config.drawdownStop, 10); assert.equal(config.shadowDrawdownStop, 2);
    assert.equal(config.entryFilter.minBufferSigma, 1); assert.equal(config.snapshotAgeTargetMs, 4600);
    assert.deepEqual(config.slots, [90, 57, 30]); assert.equal(config.deadline, Number.MAX_SAFE_INTEGER);
    assert.equal(config.observationPolicy.closingDelayMs, 3000);
    assert.equal(config.snapshotSlotReserveMs, 500);
    assert.ok(config.sources.some(([file]) => file === 'scripts/entry-filter-paper.js'));
    assert.ok(!JSON.stringify(config.policy).includes('private-marker'));
    assert.ok(!JSON.stringify(config).includes('private-endpoint'));
});

test('opt-in tuning profile freezes separate hypotheses and mirrors live observation timing', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-tuning-config-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const env = { PRIVATE_KEY: 'private-marker' };
    const config = loadEntryFilterPaperConfig(env, dir, LIVE_TUNING_PROFILE);
    assert.deepEqual(config.armNames, [...LIVE_TUNING_ARMS]);
    assert.equal(config.baselineArm, 'cost-cap-control');
    assert.deepEqual(config.slots, [90, 60, 30]);
    assert.equal(config.snapshotAgeTargetMs, 1600); assert.equal(config.snapshotSlotReserveMs, 100);
    assert.equal(config.executionBook, 'validated-websocket');
    assert.equal(config.tuningPolicy.maxAskDropUsd, .02); assert.equal(config.tuningPolicy.selectedSlotSeconds, 90);
    assert.equal(config.capital, 20); assert.equal(config.shares, 5); assert.equal(config.entryCap, 5);
    assert.notEqual(config.id, loadEntryFilterPaperConfig(env, dir).id);
    assert.ok(!JSON.stringify(config.policy).includes('private-marker'));
    assert.throws(() => loadEntryFilterPaperConfig(env, dir, 'unknown'), /invalid_entry_filter_profile/);
    new EntryFilterPaperStore(config);
    assert.throws(() => new EntryFilterPaperStore(loadEntryFilterPaperConfig(env, dir)), /paper_baseline_changed/);
});

test('90-second arm alone rejects 60/30-second slots without requiring extra closing context', async t => {
    for (const seconds of [90, 60, 30]) {
        const f = await fixture(t, { tuning: true, seconds });
        await f.observe();
        const snapshot = f.state.snapshots[0];
        assert.equal(snapshot.informed, undefined);
        for (const name of ['cost-cap-control', 'cost-cap-drop-2c'])
            assert.equal(f.state.arms[name].position.status, 'pending');
        if (seconds === 90) assert.equal(f.state.arms['cost-cap-90s'].position.status, 'pending');
        else {
            assert.equal(f.state.arms['cost-cap-90s'].position, null);
            assert.equal(snapshot.decisions['cost-cap-90s'].filterReason, 'entry_slot_not_selected');
        }
        assert.equal(f.batches.length, 1);
        assert.equal(f.batches[0][0].type, 'snapshot');
    }
});

test('ask-drop filter uses shared actual ask with strict two-cent threshold for Up and Down', async t => {
    for (const direction of [1, -1]) for (const price of [.76, .75, .79]) {
        const f = await fixture(t, { tuning: true, direction });
        if (direction < 0) f.engine.armNames.reverse();
        await f.observe(); f.price(price); f.advance(250);
        let reads = 0;
        f.books.snapshot = () => { reads++; return f.getBooks(); };
        await f.engine.manage();
        assert.equal(reads, 1);
        const rejected = price === .75, filtered = f.state.arms['cost-cap-drop-2c'];
        for (const name of ['cost-cap-control', 'cost-cap-90s'])
            assert.equal(f.state.arms[name].position.status, 'matched');
        const checked = f.events.find(row => row.type === 'execution_filter_checked').detail;
        assert.equal(checked.metrics.snapshotAsk, .78);
        assert.equal(checked.metrics.executionAsk, price); assert.equal(checked.pass, !rejected);
        assert.equal(checked.executionBookHash, f.state.arms['cost-cap-control'].position.executionBookHash);
        if (rejected) {
            assert.equal(filtered.position, null); assert.equal(filtered.cash, 20);
            assert.equal(filtered.outcomes[f.market.slug].reason, 'execution_filter_veto');
            assert.equal(filtered.outcomes[f.market.slug].code, 'entry_ask_drop_above_limit');
            assert.ok(filtered.seen[f.market.slug]);
            assert.deepEqual(f.state.errors, {});
            await f.laterSlot(60); await f.observe(60);
            assert.equal(filtered.position, null);
            assert.equal(f.engine.available('cost-cap-drop-2c', f.market.slug), false);
            assert.equal(f.state.snapshots.length, 1);
        } else assert.equal(filtered.position.status, 'matched');
    }
});

test('tuning cost-cap still rejects expensive orders and stale execution in every arm', async t => {
    const expensive = await fixture(t, { tuning: true }); expensive.price(.84); await expensive.observe();
    for (const name of LIVE_TUNING_ARMS) {
        assert.equal(expensive.state.arms[name].position, null);
        assert.equal(expensive.state.snapshots[0].decisions[name].filterReason, 'entry_cost_above_cap');
    }
    const stale = await fixture(t, { tuning: true }); await stale.observe();
    stale.advance(5001); await stale.engine.manage();
    for (const arm of Object.values(stale.state.arms)) {
        assert.equal(arm.position, null); assert.equal(arm.outcomes[stale.market.slug].code, 'execution_stale');
    }
});

test('tuning revalidates metadata each slot and late or changed metadata cannot reserve orders', async t => {
    for (const late of [false, true]) {
        const f = await fixture(t, { tuning: true });
        let validations = 0;
        f.client.marketInfo = async () => {
            if (late) f.advance(2001);
            return { fee: late ? f.market.fee : { rate: .1 } };
        };
        f.client.validateInfo = (market, info) => {
            validations++;
            if (info.fee !== market.fee) throw new Error('metadata_mismatch');
        };
        await assert.rejects(f.observe(), late ? /slot_late_after_validation/ : /metadata_mismatch/);
        assert.equal(validations, 1);
        assert.ok(Object.values(f.state.arms).every(arm => !arm.position));
    }
});

test('new arms retain partial inventory, veto, and risk stop across restart and settle only once', async t => {
    const f = await fixture(t, { tuning: true, durable: true }); await f.observe();
    f.price(.75); f.size(2); f.advance(250); await f.engine.manage();
    f.engine.assessRisk('cost-cap-90s', 9, f.now); f.store.save();
    const restarted = new EntryFilterPaperStore(f.config, f.now + 1);
    restarted.event = () => restarted.save();
    const engine = new EntryFilterPaperEngine(f.config, restarted, f.client, f.books, f.providers, f.options);
    await engine.verifyClock(); f.advance(2500); await engine.manage();
    f.advance(f.market.end - f.now); f.payout([1, 0]); await engine.manage(); await engine.manage();
    for (const name of ['cost-cap-control', 'cost-cap-90s']) {
        const arm = restarted.state.arms[name];
        assert.equal(arm.completed.length, 1); assert.equal(arm.completed[0].shares, 2);
        assert.equal(arm.completed[0].partial, true); assert.equal(arm.position, null);
    }
    assert.equal(restarted.state.arms['cost-cap-90s'].stopped.reason, 'research_drawdown_limit');
    assert.equal(restarted.state.arms['cost-cap-drop-2c'].outcomes[f.market.slug].reason, 'execution_filter_veto');
    assert.equal(engine.available('cost-cap-drop-2c', f.market.slug), false);
});

test('one deterministic action has shared immutable verdicts, admission, book and fills in either arm order', async t => {
    for (const direction of [1, -1]) {
        const f = await fixture(t, { direction });
        if (direction < 0) f.engine.armNames.reverse();
        const batch = f.store.eventBatch;
        f.store.eventBatch = rows => { batch(rows); f.advance(10); };
        await f.observe();
        const snapshot = f.state.snapshots[0], positions = Object.values(f.state.arms).map(arm => arm.position);
        assert.equal(snapshot.sharedDecision.action, direction > 0 ? 'BUY_UP' : 'BUY_DOWN');
        assert.equal(snapshot.sharedDecision.inferenceAttempted, false);
        assert.equal(snapshot.sharedDecision.requestSubmitted, false);
        assert.equal(Object.keys(f.state.providers).length, 0);
        assert.ok(Object.isFrozen(snapshot.filterVerdicts));
        assert.ok(Object.isFrozen(snapshot.filterVerdicts[snapshot.sharedDecision.action].combined.metrics));
        assert.ok(snapshot.filterVerdicts[snapshot.sharedDecision.action]['model-edge'].assessment);
        assert.equal(new Set(positions.map(p => p.submittedAt)).size, 1);
        assert.equal(new Set(positions.map(p => p.activeAt)).size, 1);
        f.advance(positions[0].activeAt - f.now);
        let captures = 0; f.books.snapshot = () => { captures++; return f.getBooks(); };
        await f.engine.manage();
        assert.equal(captures, 1); assert.equal(snapshot.executionBatches.length, 1);
        assert.equal(new Set(positions.map(p => p.executionBookHash)).size, 1);
        assert.equal(new Set(positions.map(p => p.executionAt)).size, 1);
        assert.ok(positions.every(p => p.status === 'matched' && p.fill.shares === 5 && p.fill.notional === 3.9));
    }
});

test('cost cap includes fees and gas beyond an otherwise acceptable raw 0.84 limit; veto retries later slot', async t => {
    const f = await fixture(t); f.price(.83); await f.observe();
    const snapshot = f.state.snapshots[0], verdict = snapshot.filterVerdicts.BUY_UP['cost-cap'];
    assert.equal(verdict.metrics.limitPriceUsd, .84); assert.ok(verdict.metrics.breakEvenProbability > .85);
    assert.equal(verdict.reason, 'entry_cost_above_cap');
    for (const name of ['cost-cap', 'combined']) {
        assert.equal(f.state.arms[name].position, null); assert.equal(f.state.arms[name].seen[f.market.slug], undefined);
        assert.equal(snapshot.decisions[name].action, 'SKIP'); assert.equal(snapshot.decisions[name].originalAction, 'BUY_UP');
    }
    assert.equal(f.state.arms.eligible.position.status, 'pending');
    assert.equal(f.state.arms.buffer.position.status, 'pending');
    f.price(.78); await f.laterSlot(60); await f.observe(60);
    assert.equal(f.state.arms['cost-cap'].position.status, 'pending');
    assert.equal(f.state.arms.combined.position.status, 'pending');
    assert.equal(snapshot.filterVerdicts.BUY_UP['cost-cap'].reason, 'entry_cost_above_cap');
});

test('all-in cap boundary is inclusive and direction volatility veto remains separate', async t => {
    const f = await fixture(t);
    f.market.fee.rate = 0; f.price(.83);
    await f.observe();
    assert.equal(f.state.snapshots[0].filterVerdicts.BUY_UP['cost-cap'].metrics.breakEvenProbability, .85);
    assert.equal(f.state.arms.combined.position.status, 'pending');
    const weak = await fixture(t);
    weak.btc.twap.value = 82999; weak.btc.assess = () => ({ reason: 'btc_direction_disagrees' });
    await weak.observe();
    assert.equal(weak.state.arms.eligible.position.status, 'pending');
    assert.equal(weak.state.arms['cost-cap'].position.status, 'pending');
    assert.equal(weak.state.arms.buffer.position, null); assert.equal(weak.state.arms.combined.position, null);
    assert.equal(weak.state.snapshots[0].decisions.buffer.filterReason, 'entry_filter_direction_conflict');
});

test('final minute requires causal observed closing context while earlier slots allow before-window status', async t => {
    const earlier = await fixture(t); await earlier.observe();
    assert.equal(earlier.state.snapshots[0].informed.calculated.closingTwap.status, 'before_window');
    assert.equal(earlier.state.arms.buffer.position.status, 'pending');
    const final = await fixture(t, { seconds: 30 }); await final.observe();
    assert.equal(final.state.snapshots[0].informed.calculated.closingTwap.status, 'observed');
    assert.equal(final.state.arms.buffer.position.status, 'pending');
    const invalid = await fixture(t, { seconds: 30 });
    const prepare = invalid.engine.prepareSnapshot.bind(invalid.engine);
    invalid.engine.prepareSnapshot = (snapshot, market) => prepare(snapshot, { ...market,
        reference: { ...market.reference, receivedAt: snapshot.at + 1 } });
    await invalid.observe();
    assert.equal(invalid.state.snapshots[0].informed.calculated.closingTwap.status, 'reference_unverified');
    assert.equal(invalid.state.arms.eligible.position.status, 'pending');
    assert.equal(invalid.state.arms['cost-cap'].position.status, 'pending');
    assert.equal(invalid.state.arms.buffer.position, null);
    assert.equal(invalid.state.snapshots[0].decisions.buffer.filterReason, 'entry_filter_closing_context_unavailable');
});

test('mismatched context fails both filters without altering the eligible control', async t => {
    const f = await fixture(t), prepare = f.engine.prepareSnapshot.bind(f.engine);
    f.engine.prepareSnapshot = (snapshot, market) => prepare(snapshot, { ...market, fee: { ...market.fee, rate: .1 } });
    await f.observe();
    assert.equal(f.state.snapshots[0].contextError, 'decision_cost_inputs_invalid');
    assert.equal(f.state.arms.eligible.position.status, 'pending');
    for (const name of ['cost-cap', 'buffer', 'combined']) {
        assert.equal(f.state.arms[name].position, null);
        assert.equal(f.state.snapshots[0].decisions[name].filterReason, 'decision_cost_inputs_invalid');
    }
});

test('ambiguous eligible sides skip without inventing a directional choice', async t => {
    const f = await fixture(t); f.otherPrice(.78); await f.observe();
    assert.equal(f.state.snapshots[0].allowed.length, 2);
    assert.equal(f.state.snapshots[0].sharedDecision.action, 'SKIP');
    assert.ok(Object.values(f.state.arms).every(arm => !arm.position && !arm.seen[f.market.slug]));
});

test('deterministic admission needs only activation reserve and stale admission or execution still expires', async t => {
    const accepted = await fixture(t), dispatch = accepted.engine.dispatchDecisions.bind(accepted.engine);
    accepted.engine.dispatchDecisions = (...args) => { accepted.advance(2000); return dispatch(...args); };
    await accepted.observe();
    assert.equal(accepted.engine.maxInputAgeMs(), 4600);
    assert.ok(Object.values(accepted.state.arms).every(arm => arm.position?.status === 'pending'));
    const late = await fixture(t), delayed = late.engine.dispatchDecisions.bind(late.engine);
    late.engine.dispatchDecisions = (...args) => { late.advance(4700); return delayed(...args); };
    await late.observe();
    assert.equal(late.state.snapshots[0].sharedDecision.status, 'insufficient_input_headroom');
    assert.ok(Object.values(late.state.arms).every(arm => !arm.position));
    const stale = await fixture(t); await stale.observe(); stale.advance(5001); await stale.engine.manage();
    assert.ok(Object.values(stale.state.arms).every(arm => !arm.position));
    assert.equal(stale.state.arms.eligible.outcomes[stale.market.slug].code, 'execution_stale');
});

test('cash and persistent risk stops affect only their own ledgers', async t => {
    const f = await fixture(t, { durable: true });
    f.state.arms.buffer.cash = 1;
    f.state.arms['cost-cap'].cash = 9;
    f.engine.assessRisk('cost-cap', 9, f.now);
    const stop = structuredClone(f.state.arms['cost-cap'].stopped);
    await f.observe();
    assert.equal(f.state.arms.eligible.position.status, 'pending');
    assert.equal(f.state.arms.combined.position.status, 'pending');
    assert.equal(f.state.arms.buffer.position, null);
    assert.equal(f.state.snapshots[0].decisions.buffer.entryDisposition, 'side_or_budget_invalid');
    assert.equal(f.state.snapshots[0].decisions['cost-cap'].entryDisposition, 'arm_stopped');
    for (const name of ['buffer', 'cost-cap']) {
        assert.equal(f.state.snapshots[0].decisions[name].action, 'SKIP');
        assert.equal(f.state.snapshots[0].decisions[name].originalAction, 'BUY_UP');
        assert.equal(f.state.snapshots[0].decisions[name].executable, false);
    }
    const restarted = new EntryFilterPaperStore(f.config, f.now + 1000);
    assert.deepEqual(restarted.state.arms['cost-cap'].stopped, stop);
    assert.equal(restarted.state.arms['cost-cap'].cash, 9);
    assert.equal(restarted.state.arms.eligible.position, null);
    assert.equal(restarted.state.arms.eligible.outcomes[f.market.slug].reason, 'restart_during_pending_execution');
});

test('partial fills retain actual economics and matched inventory settles once across restart', async t => {
    const f = await fixture(t, { durable: true }); f.price(.82); await f.observe();
    f.size(.5); f.advance(250); await f.engine.manage();
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position.status, 'matched'); assert.equal(arm.position.fill.shares, .5); assert.equal(arm.cash, 20);
    }
    const restarted = new EntryFilterPaperStore(f.config, f.now + 1);
    restarted.event = () => restarted.save();
    const engine = new EntryFilterPaperEngine(f.config, restarted, f.client, f.books, f.providers, f.options);
    await engine.verifyClock(); f.advance(2500); await engine.manage();
    const afterDebit = restarted.state.arms.eligible.cash;
    await engine.manage(); assert.equal(restarted.state.arms.eligible.cash, afterDebit);
    f.advance(f.market.end - f.now); f.payout([1, 0]); await engine.manage(); await engine.manage();
    for (const arm of Object.values(restarted.state.arms)) {
        assert.equal(arm.completed.length, 1); assert.equal(arm.position, null);
        assert.equal(arm.completed[0].shares, .5); assert.equal(arm.completed[0].partial, true);
        assert.ok((arm.completed[0].entryCost + arm.completed[0].gas) / arm.completed[0].shares > .85);
        assert.equal(arm.cash, Math.round((20 + arm.completed[0].pnl) * 1e6) / 1e6);
    }
});

test('restart before dispatch records no-entry, while reservation and inventory evidence stay unresolved or retained', async t => {
    const f = await fixture(t, { durable: true });
    f.engine.dispatchDecisions = async () => {};
    await f.observe();
    const snapshot = f.state.snapshots[0];
    assert.deepEqual(snapshot.decisions, {});
    const restarted = new EntryFilterPaperStore(f.config, f.now + 1);
    assert.equal(restarted.state.snapshots[0].sharedDecision.inferenceAttempted, false);
    for (const name of ENTRY_FILTER_ARMS) {
        assert.equal(restarted.state.snapshots[0].decisions[name].status, 'restart_before_decision');
        assert.equal(restarted.state.snapshots[0].decisions[name].entryDisposition, 'no_buy_decision');
    }
    const persisted = restarted.state.snapshots[0];
    persisted.decisions.eligible = { status: 'pending' };
    restarted.state.arms.eligible.seen[snapshot.market] = { snapshotId: snapshot.snapshotId };
    persisted.decisions.buffer = { status: 'pending' };
    restarted.state.arms.buffer.position = { snapshotId: snapshot.snapshotId,
        market: { slug: snapshot.market }, status: 'filled', holdings: 2, entryCost: 1.6 };
    restarted.save();
    const again = new EntryFilterPaperStore(f.config, f.now + 2);
    assert.equal(again.state.snapshots[0].decisions.eligible.entryDisposition, 'reserved');
    assert.equal(again.state.arms.eligible.outcomes[snapshot.market], undefined);
    assert.equal(again.state.snapshots[0].decisions.buffer.entryDisposition, 'reserved');
    assert.equal(again.state.arms.buffer.position.holdings, 2);
    assert.equal(again.state.arms.buffer.outcomes[snapshot.market], undefined);
});

test('snapshot event telemetry persists the prepared filter verdicts, not inherited legacy verdicts', async t => {
    const f = await fixture(t, { durable: true }); await f.observe();
    const snapshot = f.state.snapshots[0];
    const log = t.mock.method(console, 'log', () => {});
    EntryFilterPaperStore.prototype.eventBatch.call(f.store, [{ type: 'snapshot',
        detail: { snapshotId: snapshot.snapshotId, filterVerdicts: { legacy: true } } }]);
    log.mock.restore();
    const event = JSON.parse(fs.readFileSync(path.join(f.store.dir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal(event.inferencePolicy, 'none');
    assert.deepEqual(event.filterVerdicts, snapshot.filterVerdicts);
    assert.equal(event.filterVerdicts.BUY_UP['cost-cap'].metrics.costCapPerShare, .85);
});

test('recovery commits one causal decision batch without waiting for the AI freshness target', async t => {
    const f = await fixture(t, { recovery: true }), start = f.now;
    const books = () => f.getBooks().map(book => ({ ...book, timestamp: f.now - 1900 }));
    f.books.snapshot = books; f.client.books = async () => books();
    let writes = 0;
    f.store.save = () => { writes++; f.advance(150); };
    await f.observe();
    assert.equal(writes, 1);
    assert.ok(f.now - start < 2000);
    assert.equal(f.batches.length, 1);
    assert.equal(f.batches[0][0].type, 'snapshot');
    assert.ok(f.batches[0].some(row => row.type === 'decision'));
    assert.ok(f.batches[0].some(row => row.type === 'order_pending'));
    assert.ok(Object.values(f.state.arms).every(arm => arm.position?.status === 'pending'));
    assert.equal(f.state.snapshots[0].timing.waitMs, 0);
});

test('closing observation waits only for a causal tick within the original slot', async t => {
    const f = await fixture(t, { recovery: true, seconds: 60 }), boundary = f.now;
    f.advance(400);
    f.engine.sleep = async ms => {
        f.advance(ms);
        if (f.now >= boundary + 1400 && f.btc.spot.at(-1).at <= boundary)
            f.btc.ingest({ topic: 'prices.crypto', type: 'update', payload: {
                symbol: 'btcusd', timestamp: boundary + 1000, value: 83020 } }, f.now);
    };
    await f.observe();
    const snapshot = f.state.snapshots[0], closing = snapshot.informed.calculated.closingTwap;
    assert.equal(closing.status, 'observed');
    assert.equal(closing.asOf, boundary + 1000);
    assert.ok(snapshot.at >= boundary + 1400 && snapshot.at < boundary + 2000);
    assert.ok(f.state.arms.combined.position);
    assert.ok(closing.asOf <= snapshot.at);
});

test('closing ticks arriving after the slot cannot produce a snapshot or reservation', async t => {
    const f = await fixture(t, { recovery: true, seconds: 60 }); f.advance(400);
    await assert.rejects(f.observe(), /closing_observation_not_ready/);
    assert.ok(Object.values(f.state.arms).every(arm => !arm.position));
    assert.equal(f.state.snapshots.length, 0);
    assert.equal(f.state.slots[`${f.market.slug}:60`].reason, 'closing_observation_not_ready');
});

test('57-second schedule has actual closing context despite normal source ingestion lag', async t => {
    const f = await fixture(t, { recovery: true, seconds: 57 });
    f.btc.spot = f.btc.spot.filter(point => point.at <= f.now - 2000);
    f.btc.twap.at = f.now - 2000;
    await f.observe();
    const context = f.state.snapshots[0].informed.calculated.closingTwap;
    assert.equal(context.status, 'observed'); assert.equal(context.knownSeconds, 1);
    assert.ok(f.state.arms.combined.position);
});

function mockRecoverySource(f) {
    const reads = [];
    f.engine.readRestBooks = async (market, { deadlineAt }) => {
        reads.push({ at: f.now, deadlineAt });
        return { books: f.getBooks(), source: 'rest', evidence: { testSource: true },
            validation: { at: f.now, generation: 0, source: 'rest', identity: metadataIdentity(market) } };
    };
    // Source evidence and late HTTP rejection are covered by book-source.test.js.
    f.engine.validateRestBooks = (_market, pair) => pair.books;
    return reads;
}

test('cold websocket uses independent REST at observation and again at one shared execution', async t => {
    const f = await fixture(t, { recovery: true }), reads = mockRecoverySource(f);
    f.books.snapshot = () => null;
    await f.observe();
    assert.equal(f.state.snapshots[0].bookSource, 'rest');
    assert.equal(reads.length, 1);
    await f.engine.manage(); assert.equal(reads.length, 1);
    f.size(2); f.advance(250);
    await Promise.all([f.engine.manage(), f.engine.manage()]);
    assert.equal(reads.length, 2);
    assert.ok(Object.values(f.state.arms).every(arm => arm.position.status === 'matched'
        && arm.position.fill.shares === 2 && arm.position.executionBookSource === 'rest'));
    assert.equal(f.state.snapshots[0].executionBatches.length, 1);
    assert.equal(f.state.snapshots[0].executionBatches[0].bookSource, 'rest');
    assert.equal(f.state.bookRecovery.restSuccesses, 2);
});

test('websocket gap after admission recovers using a fresh shared REST book and the original limit', async t => {
    const f = await fixture(t, { recovery: true }), reads = mockRecoverySource(f);
    await f.observe(); f.books.generation++; f.books.snapshot = () => null;
    f.price(.82); f.advance(250); await f.engine.manage();
    assert.equal(reads.length, 1);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position, null);
        assert.equal(arm.outcomes[f.market.slug].code, 'fixed_limit_not_marketable');
        assert.ok(arm.seen[f.market.slug]);
    }
});

test('late REST execution and changed metadata cannot produce a fill or retry the order', async t => {
    for (const reason of ['late', 'metadata']) {
        const f = await fixture(t, { recovery: true }); mockRecoverySource(f);
        await f.observe(); f.books.snapshot = () => null; f.books.generation++; f.advance(250);
        const reader = f.engine.readRestBooks;
        f.engine.readRestBooks = async (...args) => {
            const pair = await reader(...args);
            if (reason === 'late') f.advance(5001);
            else args[0].minimum = 6;
            return pair;
        };
        await f.engine.manage(); await f.engine.manage();
        for (const arm of Object.values(f.state.arms)) {
            assert.equal(arm.position, null);
            assert.equal(arm.completed.length, 0);
            assert.ok(arm.seen[f.market.slug]);
            assert.equal(arm.outcomes[f.market.slug].reason, 'execution_expired');
        }
    }
});

test('fresh REST cannot extend the original metadata or frozen execution deadline', async t => {
    for (const source of ['at', 'tickVerifiedAt', 'frozen']) {
        const f = await fixture(t, { recovery: true }), dispatch = f.engine.dispatchDecisions.bind(f.engine);
        f.engine.dispatchDecisions = (snapshot, market) => {
            if (source !== 'frozen') snapshot.validation[source] = f.now - 1500;
            return dispatch(snapshot, market);
        };
        await f.observe();
        const snapshot = f.state.snapshots[0];
        if (source === 'frozen') snapshot.timing.executionDeadlineAt = f.now + 3500;
        const deadline = snapshot.timing.executionDeadlineAt;
        f.books.snapshot = () => null;
        mockRecoverySource(f);
        const reader = f.engine.readRestBooks;
        let reads = 0;
        f.engine.readRestBooks = async (market, options) => {
            reads++; assert.equal(options.deadlineAt, deadline);
            f.advance(deadline + 100 - f.now);
            return reader(market, options);
        };
        f.advance(600); await f.engine.manage(); await f.engine.manage();
        assert.equal(reads, 1);
        for (const arm of Object.values(f.state.arms)) {
            assert.equal(arm.position, null);
            assert.equal(arm.outcomes[f.market.slug].code, 'execution_stale');
            assert.ok(arm.seen[f.market.slug]);
        }
    }
});

test('shutdown or deadline cancellation during REST recovery cannot revive a pending cohort', async t => {
    for (const reason of ['shutdown', 'deadline', 'one-arm']) {
        const f = await fixture(t, { recovery: true, durable: true });
        mockRecoverySource(f); await f.observe();
        f.books.snapshot = () => null; f.advance(250);
        const reader = f.engine.readRestBooks;
        let release, entered;
        const started = new Promise(resolve => { entered = resolve; });
        const waiting = new Promise(resolve => { release = resolve; });
        f.engine.readRestBooks = async (...args) => { entered(); await waiting; return reader(...args); };
        const managing = f.engine.manage(); await started;
        if (reason === 'shutdown') f.engine.close();
        else if (reason === 'deadline') { f.config.deadline = f.now; f.store.freeze(f.now); }
        else f.engine.finishWithoutFill('eligible', f.state.arms.eligible.position, 'shutdown_pending_cancelled');
        release(); await managing;
        assert.equal(f.engine.managingArms.size, 0);
        for (const [name, arm] of Object.entries(f.state.arms)) {
            if (reason === 'one-arm' && name !== 'eligible') assert.equal(arm.position.status, 'matched');
            else {
                assert.equal(arm.position, null);
                assert.equal(arm.outcomes[f.market.slug].reason,
                    reason === 'deadline' ? 'deadline_pending_cancelled' : 'shutdown_pending_cancelled');
            }
        }
    }
});

test('passive collection discovers snapshots and official labels after all risk stops without touching balances', async t => {
    const f = await fixture(t, { tuning: true, passive: true, durable: true });
    for (const arm of Object.values(f.state.arms)) {
        arm.cash = 1;
        arm.stopped = { at: f.now - 1, reason: 'research_drawdown_limit' };
    }
    await f.engine.manage(f.now);
    const before = structuredClone(f.state.arms);
    f.client.market = async () => f.market;
    await f.engine.tick(f.now);
    await Promise.all([...f.engine.tasks]);
    assert.equal(f.state.snapshots.length, 1);
    const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.diagnosticOnly, true);
    assert.equal(snapshot.collectionPhase, 'all_stopped');
    assert.equal(snapshot.candidateCashBasis, 'frozen-paper-capital-diagnostic');
    assert.equal(snapshot.allowed.length, 1);
    for (const name of f.config.armNames) {
        assert.equal(snapshot.eligibleArms[name], false);
        assert.equal(snapshot.decisions[name].entryDisposition, 'arm_stopped');
        assert.equal(snapshot.decisions[name].executable, false);
    }
    assert.deepEqual(f.state.arms, before);
    f.advance(f.market.end - f.now + 1); f.payout([1, 0]);
    await f.engine.resolveOutcomes(f.now);
    assert.deepEqual(f.state.markets[f.market.slug].payout, [1, 0]);
    assert.deepEqual(f.state.arms, before);
    const restarted = new EntryFilterPaperStore(f.config, f.now);
    assert.deepEqual(restarted.state.arms, before);
    assert.equal(restarted.state.snapshots[0].diagnosticOnly, true);
    assert.deepEqual(restarted.state.markets[f.market.slug].payout, [1, 0]);
});

test('passive collection records busy and already-attempted slots without additional reservations', async t => {
    const f = await fixture(t, { tuning: true, passive: true });
    await f.observe();
    const pending = structuredClone(f.state.arms);
    await f.laterSlot(60); await f.observe(60);
    assert.equal(f.state.snapshots.length, 2);
    assert.equal(f.state.snapshots[1].diagnosticOnly, true);
    assert.deepEqual(f.state.arms, pending);
    for (const arm of Object.values(f.state.arms)) arm.position = null;
    const attempted = structuredClone(f.state.arms);
    await f.laterSlot(30); await f.observe(30);
    assert.equal(f.state.snapshots.length, 3);
    assert.deepEqual(f.state.arms, attempted);
    assert.equal(f.events.filter(row => row.type === 'order_pending').length, 3);
});

test('passive candidates do not spend unavailable virtual cash and retain no-entry market labels', async t => {
    for (const belowPrice of [false, true]) {
        const f = await fixture(t, { tuning: true, passive: true });
        for (const arm of Object.values(f.state.arms)) arm.cash = 1;
        if (belowPrice) { f.price(.5); f.otherPrice(.5); }
        const before = structuredClone(f.state.arms);
        await f.observe();
        const snapshot = f.state.snapshots[0];
        assert.ok(snapshot);
        assert.deepEqual(f.state.arms, before);
        assert.equal(snapshot.allowed.length, belowPrice ? 0 : 1);
        for (const decision of Object.values(snapshot.decisions)) {
            assert.equal(decision.executable, false);
            assert.equal(decision.entryDisposition, belowPrice ? 'no_buy_decision' : 'side_or_budget_invalid');
        }
        if (belowPrice) {
            assert.ok(snapshot.candidateChecks.every(row => row.reason === 'ask_below_entry_minimum'));
            assert.equal(snapshot.sharedDecision.action, 'SKIP');
        }
        f.advance(f.market.end - f.now + 1); f.payout([0, 1]);
        await f.engine.resolveOutcomes(f.now);
        assert.deepEqual(f.state.markets[f.market.slug].payout, [0, 1]);
        assert.deepEqual(f.state.arms, before);
    }
});

test('passive collection honors shutdown, clock checks and a frozen period', async t => {
    for (const state of ['closed', 'clock', 'frozen']) {
        const f = await fixture(t, { tuning: true, passive: true });
        for (const arm of Object.values(f.state.arms)) arm.stopped = { at: f.now, reason: 'research_drawdown_limit' };
        if (state === 'closed') f.engine.closed = true;
        if (state === 'clock') { f.engine.clockValid = false; f.engine.clockRetryAt = f.now + 10000; }
        if (state === 'frozen') f.store.state.frozenAt = f.now;
        f.client.market = async () => { throw new Error('must_not_collect'); };
        await f.engine.tick(f.now); await Promise.all([...f.engine.tasks]);
        assert.equal(f.state.snapshots.length, 0);
        assert.deepEqual(f.state.errors, {});
    }
});
