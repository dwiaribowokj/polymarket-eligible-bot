import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EligibleLiveProvider, ELIGIBLE_MODEL } from '../../src/eligible-live/provider.js';
import { ELIGIBLE_BUFFER_POLICY, prepareEligibleEntryBuffer, evaluateEligibleEntryPolicy,
    validateEligibleEntryPolicy } from '../../src/eligible-live/entry-buffer.js';
import { LayaLiveEngine, entryGuard, initializeAI } from '../../src/laya-live/engine.js';
import { candidateChecks, metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { encodeFeatures } from '../../src/ai-shadow/history.js';
import { ENTRY_FILTER_POLICY } from '../../src/decision-paper/entry-filter.js';
import { EntryFilterPaperEngine } from '../../src/entry-filter-paper/engine.js';
import { marketSlug } from '../../src/restart/strategy.js';

const end = Date.parse('2026-10-16T00:05:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');

function data({ seconds = 60, index = 0, spotDelta = 2, twapDelta = 2, sigma = .1,
    historyDelta = 0, history = true, price = .84 } = {}) {
    const at = end - seconds * 1000, direction = index === 0 ? 1 : -1;
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, shares: 5, entryCap: 5,
        late: { duration: 300 }, lateQuality: { maxSpread: .03, minDepth: 5 } };
    const config = { settings, policy: { provider: 'eligible', model: ELIGIBLE_MODEL,
        aiSource: ELIGIBLE_MODEL, entryFilter: ELIGIBLE_BUFFER_POLICY }, ai: {
        slots: [90, 60, 30], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01,
        control: settings, entryFilter: ELIGIBLE_BUFFER_POLICY,
    } };
    const market = { slug: marketSlug('late-entry', settings, at), conditionId: 'buffer-condition',
        open: end - 300000, end, accepting: true, minimum: 5, tick: .01, ticks: [.01, .01],
        tokens: ['buffer-up', 'buffer-down'], outcomes: ['Up', 'Down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, negRisk: false };
    market.reference = { source: 'chainlink_twap_60s', open: market.open, end,
        value: 100000, observedAt: market.open, receivedAt: market.open };
    const books = market.tokens.map((tokenId, i) => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: at - 100, fetchedAt: at - 100, bids: [{ price: i === index ? price - .02 : .20, size: 10 }],
        asks: [{ price: i === index ? price - .01 : .21, size: 10 }] }));
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: at - 3600000, cash: 20,
        walletStart: 20, walletCashDelta: 0, peakEquity: 20, maxDrawdown: 0, failures: 0,
        completed: [], seen: {}, stopped: null, position: null, decisionProvider: 'eligible' };
    const allowed = candidateChecks(market, books, config.ai, state.cash, at).flatMap(check => check.order ? [check.order] : []);
    assert.equal(allowed.length, 1);
    const snapshot = { market: market.slug, slot: seconds, at, observedAt: at - 100,
        provider: 'eligible', model: ELIGIBLE_MODEL, allowed, entryFilter: ELIGIBLE_BUFFER_POLICY,
        validation: { at, generation: 1, identity: metadataIdentity(market) },
        decisionRequestedAt: at, decisionReceivedAt: at };
    const input = { market: market.slug, seconds, opening_twap: 100000,
        spot: 100000 + spotDelta * direction, twap: 100000 + twapDelta * direction,
        volatility_usd_sqrt_s: sigma, margin_usd: twapDelta * direction,
        returns_bps_5_15_30_60_180: [], bars_30s_OHLC_oldest_first: [],
        books_up_down: books.map(book => Object.fromEntries(['bids', 'asks'].map(side =>
            [side, book[side].map(level => [level.price, level.size])]))),
        fee_rate: market.fee.rate, fee_exponent: 1, shares: 5, entry_cap: 5,
        allowed: [index === 0 ? 'BUY_UP' : 'BUY_DOWN'], limit_cost_up_down: [0, 1].map(i =>
            i === index ? [Math.round(allowed[0].price * 100), allowed[0].cost] : null) };
    const btc = { rule: { maxGapMs: 5000 }, openings: new Map([[market.open,
        { at: market.open, value: 100000, receivedAt: market.open }]]), spot: [] };
    if (history) {
        for (let time = market.open; time < at; time += 1000)
            btc.spot.push({ at: time, receivedAt: time, value: 100000 + historyDelta * direction });
        btc.spot.push({ at, receivedAt: at, value: input.spot });
    }
    const rehash = () => {
        snapshot.input = JSON.stringify(input); snapshot.inputHash = digest(snapshot.input);
        snapshot.snapshotId = digest(JSON.stringify({ slug: snapshot.market, seconds: snapshot.slot,
            now: snapshot.at, input: snapshot.input })).slice(0, 24);
    };
    const prepare = () => { rehash(); prepareEligibleEntryBuffer(snapshot, market, btc, config); };
    prepare();
    return { settings, config, market, books, state, snapshot, input, btc, rehash, prepare, at,
        spec: { ...allowed[0], kind: 'taker' }, now: at + 250 };
}

function paperVerdict(f) {
    const input = encodeFeatures(f.input), action = f.input.allowed[0];
    const snapshot = { ...f.snapshot, input, inputHash: digest(input), filterVerdicts: { [action]: {} } };
    EntryFilterPaperEngine.prototype.prepareSnapshot.call({ config: { ...f.config.ai,
        entryFilter: ENTRY_FILTER_POLICY, costCapPerShare: .85 }, client: { btc: f.btc } }, snapshot, f.market);
    return snapshot.filterVerdicts[action];
}

const decision = f => new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => f.at }).predict('eligible', f.snapshot);

function engineFixture(t, options = {}) {
    const f = data(options); let now = f.at;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_buffer_fixture'); });
    const events = [], persisted = [];
    const store = { state: f.state, save() { persisted.push(structuredClone(this.state)); },
        event(type, detail = {}) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { this.state.stopped ||= { reason, at: now }; this.save(); } };
    const stream = { generation: 1, tokens: f.market.tokens, snapshot: () => structuredClone(f.books) };
    const orderId = `0x${'b'.repeat(64)}`, signed = { fixtureOnly: true, orderType: 'FAK' };
    const client = { btc: Object.assign(f.btc, { assess: () => ({ reason: 'btc_edge_insufficient' }) }),
        books: async () => stream.snapshot(), marketInfo: async () => ({}), validateInfo() {},
        confirmedBlock: async () => 123, balance: async () => 20, holdings: async () => [0, 0],
        warmOrderMetadata: async () => { now += options.walletDelayMs ?? 0; },
        prepare: t.mock.fn(async () => { options.onPrepare?.(f); return { orderId, signed }; }),
        post: t.mock.fn(async () => {
            assert.equal(persisted.at(-1).position.orders[0].status, 'submitting');
            return { ok: true, orderId, status: 'matched', makingAmount: '4.2', takingAmount: '5',
                tradeIds: ['buffer-fill'], transactionsHashes: [] };
        }) };
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => {
        now += options.preparationMs ?? 0;
        return { initial: stream.snapshot(), timing: {},
            features: { observedAt: now - (options.inputAgeMs ?? 100), state: structuredClone(f.input) } };
    });
    const providers = new EligibleLiveProvider(f.config.ai);
    const engine = new LayaLiveEngine(f.config, store, client, stream, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    t.mock.method(engine, 'awaitExecutionLatency', async snapshot => {
        now = snapshot.decisionReceivedAt + 250; options.onWait?.(f, snapshot);
    });
    engine.current = f.market;
    return Object.assign(f, { engine, client, providers, store, events, persisted,
        setTime(value) { now = value; for (const book of f.books) book.timestamp = book.fetchedAt = now - 100; } });
}

test('BUFFER policy is frozen and cannot silently become a combined or retuned filter', () => {
    assert.deepEqual(validateEligibleEntryPolicy(ELIGIBLE_BUFFER_POLICY), ELIGIBLE_BUFFER_POLICY);
    for (const change of [{ minBufferSigma: .5 }, { useClosingThreshold: false }, { requireObservedClosing: false },
        { maxCostPerShare: .85 }])
        assert.throws(() => validateEligibleEntryPolicy({ ...ELIGIBLE_BUFFER_POLICY, ...change }), /invalid_eligible_entry_filter/);
});

test('LIVE BUFFER matches actual paper BUFFER verdicts, boundaries, directions and final-minute context', async t => {
    const cases = [
        ['before closing window', { seconds: 90 }, true, null],
        ['exact closing cutoff permits absent history', { seconds: 60, history: false }, true, null],
        ['inside closing cutoff requires observed history', { seconds: 59.99, history: false }, false, 'entry_filter_closing_context_unavailable'],
        ['observed final minute', { seconds: 30 }, true, null],
        ['Down observed final minute', { seconds: 30, index: 1 }, true, null],
        ['exact sigma boundary', { seconds: 64, sigma: .125, spotDelta: 1, twapDelta: 1 }, true, null],
        ['below sigma boundary', { seconds: 64, sigma: .125, spotDelta: 1, twapDelta: .99 }, false, 'entry_filter_insufficient_buffer'],
        ['spot disagrees', { spotDelta: -2 }, false, 'entry_filter_direction_conflict'],
        ['TWAP disagrees', { twapDelta: -2 }, false, 'entry_filter_direction_conflict'],
        ['closing threshold disagrees', { seconds: 30, historyDelta: -3 }, false, 'entry_filter_closing_direction_conflict'],
        ['closing threshold too close', { seconds: 30, historyDelta: -1.7 }, false, 'entry_filter_closing_insufficient_buffer'],
    ];
    for (const [name, options, pass, reason] of cases) await t.test(name, async () => {
        const f = data(options), paper = paperVerdict(f), live = await decision(f);
        assert.deepEqual({ version: live.entryFilter.version, pass: live.entryFilter.pass,
            reason: live.entryFilter.reason, metrics: live.entryFilter.metrics }, paper.buffer);
        assert.equal(live.entryFilter.pass, pass); assert.equal(live.entryFilter.reason, reason);
        assert.equal(live.action, pass ? f.input.allowed[0] : 'SKIP');
        assert.equal(live.inferenceAttempted, false);
        assert.equal(paper['cost-cap'].pass, false);
        if (pass) assert.doesNotThrow(() => entryGuard({ ...f, decision: live }));
    });
});

test('BUFFER needs only shared scalar features and preserves causal context across JSON restart', async () => {
    const f = data({ seconds: 30 });
    for (const key of ['margin_usd', 'returns_bps_5_15_30_60_180', 'bars_30s_OHLC_oldest_first', 'books_up_down']) delete f.input[key];
    f.prepare();
    const before = await decision(f), saved = JSON.stringify(f.snapshot);
    assert.equal(before.entryFilter.pass, true);
    f.btc.spot.push({ at: f.at - 500, receivedAt: f.at + 1, value: 90000 },
        { at: f.at + 1, receivedAt: f.at + 1, value: 90000 });
    f.prepare();
    assert.equal(JSON.stringify(f.snapshot), saved);
    f.btc.spot = [];
    const restored = JSON.parse(saved);
    assert.deepEqual(evaluateEligibleEntryPolicy(restored, f.config, f.at), before.entryFilter);
    assert.doesNotThrow(() => entryGuard({ ...f, snapshot: restored, decision: before }));
});

test('BUFFER preserves paper rounding for cents and milliUSD sigma', async () => {
    const f = data({ seconds: 30, spotDelta: 2.001, twapDelta: 1.999, sigma: .1001 });
    f.market.reference.value = 100000.004;
    f.btc.openings.get(f.market.open).value = f.market.reference.value;
    f.prepare();
    const live = await decision(f), paper = paperVerdict(f);
    assert.deepEqual(live.entryFilter.metrics, paper.buffer.metrics);
    assert.equal(live.entryFilter.pass, paper.buffer.pass);
});

test('final-minute BUFFER fails closed on the same unobserved source histories as paper', async t => {
    for (const [status, change] of [
        ['history_missing', f => { f.btc.spot = f.btc.spot.filter(point => point.at > end - 60000); }],
        ['history_gap', f => { f.btc.spot = f.btc.spot.filter(point => point.at < f.at - 15000 || point.at > f.at - 9000); }],
        ['history_conflict', f => { f.btc.spot.push({ at: f.at - 1000, receivedAt: f.at, value: 90000 }); }],
        ['history_stale', f => { f.btc.spot = f.btc.spot.filter(point => point.at <= f.at - 6000); }],
        ['reference_unverified', f => { f.market.reference.receivedAt = f.at + 1; }],
    ]) await t.test(status, async () => {
        const f = data({ seconds: 30 }); change(f); f.prepare();
        assert.equal(f.snapshot.entryBuffer.context.informed.calculated.closingTwap.status, status);
        const live = await decision(f), paper = paperVerdict(f);
        assert.equal(live.entryFilter.pass, false); assert.equal(live.reason, 'entry_filter_closing_context_unavailable');
        assert.equal(live.reason, paper.buffer.reason); assert.deepEqual(live.entryFilter.metrics, paper.buffer.metrics);
    });
});

test('BUFFER rejects missing, altered, expired and identity-mismatched snapshots before execution', async t => {
    const changes = [
        ['raw bytes', f => { f.snapshot.input += ' '; }],
        ['snapshot identity', f => { f.snapshot.snapshotId = 'changed'; }],
        ['observed cutoff', f => { f.snapshot.observedAt++; }],
        ['context bytes', f => { f.snapshot.entryBuffer = structuredClone(f.snapshot.entryBuffer);
            f.snapshot.entryBuffer.context.informed.calculated.closingTwap.requiredRemainingAverageUsd = 1; }],
        ['context missing', f => { delete f.snapshot.entryBuffer; }],
        ['order token', f => { f.snapshot.allowed[0].tokenId = 'other'; }],
        ['order shares', f => { f.snapshot.allowed[0].shares = 6; }],
        ['order cost', f => { f.snapshot.allowed[0].cost--; }],
        ['fee mismatch', f => { f.input.fee_rate = 0; f.rehash(); }],
        ['invalid volatility', f => { f.input.volatility_usd_sqrt_s = 0; f.prepare(); }],
        ['invalid time horizon', f => { f.input.seconds = 1; f.prepare(); }],
        ['old source', f => { f.snapshot.observedAt = f.at - 5001; f.prepare(); }],
        ['future source', f => { f.snapshot.observedAt = f.at + 1; f.prepare(); }],
        ['old validation', f => { f.snapshot.validation.at = f.at - 5001; }],
    ];
    for (const [name, change] of changes) await t.test(name, async () => {
        const f = data({ seconds: 30 }); change(f);
        const result = await decision(f);
        assert.equal(result.action, 'SKIP'); assert.equal(result.entryFilter.pass, false);
    });
    const f = data(), live = await decision(f);
    assert.throws(() => entryGuard({ ...f, decision: live, now: f.at + 4901 }), /snapshot_stale/);
    assert.throws(() => entryGuard({ ...f, decision: live, state: { ...f.state, cash: 1 } }), /entry_budget_exceeded/);
    assert.throws(() => entryGuard({ ...f, decision: live, market: { ...f.market, tokens: ['wrong', 'wrong2'] } }), /market_changed/);
    assert.throws(() => entryGuard({ ...f, decision: live, market: { ...f.market, reference: { ...f.market.reference, value: 1 } } }), /market_changed/);
});

test('real LIVE engine applies BUFFER alone, preserves limits and one attempt across restart', async t => {
    const f = engineFixture(t, { seconds: 30 }); await f.engine.discover(f.at);
    assert.equal(f.client.prepare.mock.callCount(), 1); assert.equal(f.client.post.mock.callCount(), 1);
    assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 20);
    const order = f.state.position.orders[0];
    assert.equal(order.shares, 5); assert.equal(order.price, .84); assert.ok(order.cost > 5 * .85 && order.cost <= 5);
    assert.equal(order.execution.entryFilter.pass, true);
    assert.equal(f.state.position.entrySignal.entryFilter.policy.version, ELIGIBLE_BUFFER_POLICY.version);
    assert.deepEqual(f.state.position.holdings, [0, 0]);
    const saved = JSON.parse(JSON.stringify(f.state));
    initializeAI(saved, f.config);
    assert.deepEqual(saved.position, f.state.position); assert.deepEqual(saved.seen, f.state.seen);
    f.store.state = saved; f.engine.ai = saved.ai;
    await assert.rejects(f.engine.broker.submit(f.spec, f.now), /duplicate_entry_attempt/);
    assert.equal(f.client.post.mock.callCount(), 1);
});

test('BUFFER allows feature assembly milliseconds before the frozen live snapshot', async t => {
    const f = engineFixture(t, { seconds: 30, preparationMs: 17 }); await f.engine.discover(f.at);
    assert.equal(f.state.ai.snapshots[0].at, f.at + 17);
    assert.equal(JSON.parse(f.state.ai.snapshots[0].input).seconds, 30);
    assert.equal(f.client.post.mock.callCount(), 1);
});

test('execution rechecks the frozen BUFFER decision without incorporating later observations', async t => {
    const f = engineFixture(t, { seconds: 30, onWait(f) {
        f.btc.spot.push({ at: f.at + 250, receivedAt: f.at + 250, value: 90000 });
    } });
    await f.engine.discover(f.at);
    const snapshot = f.state.ai.snapshots[0];
    assert.equal(f.client.post.mock.callCount(), 1);
    assert.equal(snapshot.entryBuffer.context.informed.calculated.closingTwap.asOf, f.at);
    assert.deepEqual(snapshot.executionEvidence.entryFilter.metrics, snapshot.decision.entryFilter.metrics);
});

test('BUFFER deterministic admission uses paper freshness headroom and retains execution reserve', async t => {
    for (const [name, options, expected] of [
        ['exact 4600ms input boundary', { inputAgeMs: 4600 }, null],
        ['old input at dispatch', { inputAgeMs: 4601 }, 'insufficient_input_headroom'],
        ['wallet exhausts reserve', { inputAgeMs: 4600, walletDelayMs: 1 }, 'insufficient_execution_headroom'],
    ]) await t.test(name, async t => {
        const f = engineFixture(t, options); await f.engine.discover(f.at);
        assert.equal(f.client.post.mock.callCount(), expected ? 0 : 1);
        if (expected) {
            assert.equal(f.state.ai.snapshots[0].entryDisposition, expected);
            assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        }
        assert.equal(f.config.ai.decisionMs, 3000); assert.equal(f.config.ai.latencyMs, 250);
    });
});

test('the real live snapshot collector retains deterministic headroom despite the hard response limit', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_buffer_capture'); });
    const f = data({ seconds: 90 }), sourceAt = f.at - 2700;
    let now = f.at;
    f.btc.spot = f.btc.spot.filter(point => point.at < sourceAt);
    f.btc.spot.push({ at: sourceAt, receivedAt: sourceAt, value: f.input.spot });
    f.btc.twap = { at: sourceAt, receivedAt: sourceAt, value: f.input.twap };
    f.btc.status = () => ({ ready: true });
    const collector = { config: { ...f.config.ai, deadline: Number.MAX_SAFE_INTEGER,
        snapshotWaitMs: 2000, snapshotAgeTargetMs: 1600, snapshotSlotReserveMs: 100 },
        client: { btc: f.btc }, books: { generation: 1, tokens: f.market.tokens, snapshot: () => f.books },
        clock: () => now, clockValid: true, closed: false, sleep: async ms => { now += ms; } };
    const prepared = await ShadowEngine.prototype.freshSnapshot.call(collector, f.market, 90, f.books, f.snapshot.validation);
    assert.equal(collector.config.decisionMs, 3000);
    assert.equal(prepared.features.observedAt, sourceAt);
    assert.equal(prepared.timing.waitMs, 1900);
    assert.equal(prepared.timing.inputAgeMs, 4600);
    assert.equal(prepared.timing.targetMet, false);
    assert.equal(now - prepared.features.observedAt + 250 + 150, collector.config.dataAgeMs);
});

test('live BUFFER vetoes direction and missing closing history without reserving or stopping', async t => {
    for (const options of [{ spotDelta: -2 }, { seconds: 30, history: false }]) await t.test(JSON.stringify(options), async t => {
        const f = engineFixture(t, options); await f.engine.discover(f.at);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.state.stopped, null); assert.equal(f.state.failures, 0);
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
    });
});

test('BUFFER is rechecked before signing and before post, retaining the reserved attempt on rejection', async t => {
    for (const stage of ['onWait', 'onPrepare']) for (const change of ['context', 'decision', 'fee', 'expired'])
        await t.test(`${stage}: ${change}`, async t => {
            const mutate = f => {
                const snapshot = f.state.ai.snapshots[0];
                if (change === 'context') snapshot.entryBuffer = { ...snapshot.entryBuffer, contextHash: 'changed' };
                if (change === 'decision') snapshot.decision.entryFilter.metrics.spotBufferUsd++;
                if (change === 'fee') f.market.fee.rate = .09;
                if (change === 'expired') f.setTime(f.at + 5001);
            };
            const f = engineFixture(t, { seconds: 30, [stage]: mutate }); await f.engine.discover(f.at);
            assert.equal(f.client.post.mock.callCount(), 0); assert.equal(f.state.stopped, null);
            assert.ok(f.events.some(row => row.type === 'eligible_entry_filter_veto'));
            if (stage === 'onWait') {
                assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
                assert.equal(f.client.prepare.mock.callCount(), 0);
            } else {
                assert.equal(f.client.prepare.mock.callCount(), 1); assert.ok(f.state.seen[f.market.slug]);
                assert.equal(f.state.position.orders[0].status, 'rejected');
                assert.equal(f.state.position.orders[0].postAttemptAt, undefined);
                await assert.rejects(f.engine.broker.submit(f.spec, f.now), /duplicate_entry_attempt/);
            }
        });
});
