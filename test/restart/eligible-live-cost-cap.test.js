import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EligibleLiveProvider, ELIGIBLE_MODEL } from '../../src/eligible-live/provider.js';
import { calculateFullFillEntryCost, validateEligibleEntryFilter } from '../../src/eligible-live/entry-cost-cap.js';
import { LayaLiveEngine, entryGuard } from '../../src/laya-live/engine.js';
import { candidateChecks, metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { buildDecisionContext } from '../../src/decision-paper/features.js';
import { marketSlug } from '../../src/restart/strategy.js';

const start = Date.parse('2026-10-16T00:04:00Z');
const digest = value => createHash('sha256').update(value).digest('hex');
const policy = (gasUsd, maxCostPerShare = .85) => ({ version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare,
    gasUsd, basis: 'full_fill_at_frozen_limit' });

function data({ price = .83, rate = .07, gasUsd = .05, index = 0, enabled = true, maxCostPerShare = .85 } = {}) {
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, shares: 5, entryCap: 5,
        late: { duration: 300 }, lateQuality: { maxSpread: .03, minDepth: 5 } };
    const entryFilter = enabled ? policy(gasUsd, maxCostPerShare) : undefined;
    const config = { settings, policy: { provider: 'eligible', model: ELIGIBLE_MODEL, aiSource: ELIGIBLE_MODEL,
        ...(entryFilter ? { entryFilter } : {}) }, ai: {
        slots: [60, 30], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250,
        shares: 5, entryCap: 5, gasUsd, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
        ...(entryFilter ? { entryFilter } : {}),
    } };
    const market = { slug: marketSlug('late-entry', settings, start), conditionId: 'cost-cap-condition',
        open: start - 240000, end: start + 60000, accepting: true, minimum: 5,
        tick: .01, ticks: [.01, .01], tokens: ['cost-cap-up', 'cost-cap-down'], outcomes: ['Up', 'Down'],
        fee: { rate, exponent: 1, takerOnly: true }, negRisk: false };
    const books = market.tokens.map((tokenId, i) => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: start - 100, fetchedAt: start - 100,
        bids: [{ price: i === index ? price - .02 : .20, size: 10 }],
        asks: [{ price: i === index ? price - .01 : .21, size: 10 }] }));
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 3600000, cash: 20,
        walletStart: 20, walletCashDelta: 0, peakEquity: 20, maxDrawdown: 0, failures: 0,
        completed: [], seen: {}, stopped: null, position: null, decisionProvider: 'eligible',
        currentStrategyEpochId: 'cost-cap-epoch' };
    const allowed = candidateChecks(market, books, config.ai, state.cash, start).flatMap(check => check.order ? [check.order] : []);
    assert.equal(allowed.length, 1);
    const snapshot = { market: market.slug, slot: 60, at: start, observedAt: start - 100,
        provider: 'eligible', model: ELIGIBLE_MODEL, allowed, entryFilter,
        validation: { at: start, generation: 1, identity: metadataIdentity(market) },
        decisionRequestedAt: start, decisionReceivedAt: start };
    const input = { market: market.slug, seconds: 60, fee_rate: rate, fee_exponent: 1, shares: 5, entry_cap: 5,
        allowed: [index === 0 ? 'BUY_UP' : 'BUY_DOWN'], limit_cost_up_down: [0, 1].map(i =>
            i === index ? [Math.round(allowed[0].price * 100), allowed[0].cost] : null) };
    const rehash = () => {
        snapshot.input = JSON.stringify(input); snapshot.inputHash = digest(snapshot.input);
        snapshot.snapshotId = digest(JSON.stringify({ slug: snapshot.market, seconds: snapshot.slot,
            now: snapshot.at, input: snapshot.input })).slice(0, 24);
    };
    rehash();
    return { settings, config, market, books, state, snapshot, input, rehash, index,
        spec: { ...allowed[0], kind: 'taker' }, now: start + 250 };
}

function engineFixture(t, options = {}) {
    const f = data(options); let now = start;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_cost_cap_fixture'); });
    const events = [], persisted = [];
    const store = { state: f.state, save() { persisted.push(structuredClone(this.state)); },
        event(type, detail = {}) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { this.state.stopped ||= { reason, at: now }; this.save(); } };
    const stream = { generation: 1, tokens: f.market.tokens, snapshot: () => structuredClone(f.books) };
    const orderId = `0x${'c'.repeat(64)}`, signed = { fixtureOnly: true, orderType: 'FAK' };
    const client = { btc: { assess: () => ({ reason: 'btc_direction_disagrees' }) },
        books: async () => stream.snapshot(), marketInfo: async () => ({}), validateInfo() {},
        confirmedBlock: async () => 123, balance: async () => 20, holdings: async () => [0, 0],
        warmOrderMetadata: async () => { now += options.walletDelayMs ?? 0; },
        prepare: t.mock.fn(async spec => { options.onPrepare?.(f, spec); return { orderId, signed }; }),
        post: t.mock.fn(async () => {
            assert.equal(persisted.at(-1).position.orders[0].status, 'submitting');
            return { ok: true, orderId, status: 'matched', makingAmount: '3.9', takingAmount: '5.1',
                tradeIds: ['cost-cap-fill'], transactionsHashes: [] };
        }) };
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: stream.snapshot(), timing: {},
        features: { observedAt: now - (options.inputAgeMs ?? 100), state: { market: f.market.slug, seconds: (f.market.end - now) / 1000,
            fee_rate: f.market.fee.rate, fee_exponent: f.market.fee.exponent, shares: 5, entry_cap: 5 } } }));
    const providers = new EligibleLiveProvider(f.config.ai);
    const engine = new LayaLiveEngine(f.config, store, client, stream, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    t.mock.method(engine, 'awaitExecutionLatency', async snapshot => {
        now = snapshot.decisionReceivedAt + 250; options.onWait?.(f, snapshot);
    });
    engine.current = f.market;
    return Object.assign(f, { engine, client, providers, store, events, persisted,
        setTime: value => { now = value; for (const book of f.books) book.timestamp = book.fetchedAt = now - 100; } });
}

test('LIVE full-fill costs match paper arithmetic and include fees and fixed gas at the inclusive boundary', async t => {
    for (const [maxCostPerShare, below, above, feeBoundaryGas] of [[.85, .83, .84, .05061], [.82, .79, .80, .09193]]) {
        const feeFreeBoundary = Math.round((maxCostPerShare - .01) * 100) / 100;
        for (const [options, pass] of [[{ price: below }, true], [{ price: above }, false],
            [{ price: feeFreeBoundary, rate: 0 }, true], [{ price: maxCostPerShare, rate: 0 }, false],
            [{ price: feeFreeBoundary, rate: 0, gasUsd: .050001 }, false],
            [{ price: below, gasUsd: feeBoundaryGas }, true],
            [{ price: below, gasUsd: feeBoundaryGas + .000001 }, false]])
            await t.test(`${maxCostPerShare}: ${JSON.stringify(options)}`, async () => {
                const f = data({ ...options, maxCostPerShare }), provider = new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => start });
                const decision = await provider.predict('eligible', f.snapshot);
                assert.equal(decision.entryFilter.pass, pass);
                assert.equal(decision.action, pass ? 'BUY_UP' : 'SKIP');
                const cost = calculateFullFillEntryCost({ price: f.spec.price, shares: 5, schedule: f.market.fee, gasUsd: f.config.ai.gasUsd });
                const paperInput = JSON.stringify({ seconds: 60, fee: [f.market.fee.rate, 1], shares: 5, cap_usd: 5,
                    allowed: ['BUY_UP'], limit_cost_up_down: f.input.limit_cost_up_down });
                const paper = buildDecisionContext({ ...f.snapshot, input: paperInput, inputHash: digest(paperInput) },
                    f.market, {}, f.config.ai).calculated.costsUpDown[0];
                assert.deepEqual(cost, Object.fromEntries(Object.keys(cost).map(key => [key, paper[key]])));
                assert.equal(decision.entryFilter.metrics.allInCostUsd, cost.allInCostUsd);
                assert.equal(decision.entryFilter.metrics.costCapPerShare, maxCostPerShare);
                assert.equal(decision.entryFilter.metrics.partialFillCapGuaranteed, false);
                assert.equal(decision.inferenceAttempted, false);
                if (pass) assert.doesNotThrow(() => entryGuard({ ...f, decision }));
                else assert.throws(() => entryGuard({ ...f, decision: { ...decision, action: 'BUY_UP' } }),
                    error => error.code === 'entry_cost_above_cap' && error.category === 'opportunity');
            });
    }
});

test('invalid cost-cap policies fail configuration while absent policy preserves legacy decisions', async () => {
    assert.equal(validateEligibleEntryFilter(undefined), null);
    for (const maxCostPerShare of [.82, .85]) {
        const accepted = validateEligibleEntryFilter(policy(.05, maxCostPerShare));
        assert.equal(accepted.maxCostPerShare, maxCostPerShare);
        assert.equal(Object.isFrozen(accepted), true);
    }
    for (const invalid of [null, {}, ...[.81, .83, .84, .86, '0.82', '0.85', NaN, null]
        .map(maxCostPerShare => policy(.05, maxCostPerShare)), { ...policy(.05), gasUsd: NaN },
        { ...policy(.05), basis: 'best_ask' }, { ...policy(.05), buffer: true }]) {
        assert.throws(() => validateEligibleEntryFilter(invalid), /invalid_eligible_entry_filter/);
        assert.throws(() => new EligibleLiveProvider({ entryFilter: invalid }), /invalid_eligible_entry_filter/);
    }
    assert.throws(() => new EligibleLiveProvider({ gasUsd: .06, entryFilter: policy(.05) }), /invalid_eligible_entry_filter/);
    const old = new EligibleLiveProvider({});
    assert.equal((await old.predict('eligible', { snapshotId: 'legacy', allowed: [{ index: 0 }] })).action, 'BUY_UP');
});

test('cost-cap provider rejects tampered, malformed and stale snapshots as local SKIPs', async t => {
    const cases = [
        ['input bytes', f => { f.snapshot.input += ' '; }],
        ['snapshot id', f => { f.snapshot.snapshotId = 'replaced'; }],
        ['encoded fee', f => { f.input.fee_rate = 0; f.rehash(); }],
        ['encoded shares', f => { f.input.shares = 4; f.rehash(); }],
        ['encoded cost', f => { f.input.limit_cost_up_down[0][1] -= .01; f.rehash(); }],
        ['encoded action', f => { f.input.allowed = ['BUY_DOWN']; f.rehash(); }],
        ['order cost', f => { f.snapshot.allowed[0].cost -= .01; }],
        ['order shares', f => { f.snapshot.allowed[0].shares = 6; }],
        ['order token', f => { f.snapshot.allowed[0].tokenId = 'other-token'; }],
        ['order limit', f => { f.snapshot.allowed[0].price -= .01; }],
        ['policy missing', f => { delete f.snapshot.entryFilter; }],
        ['policy cap changed', f => { f.snapshot.entryFilter = policy(.05,
            f.config.ai.entryFilter.maxCostPerShare === .85 ? .82 : .85); }],
        ['future snapshot', f => { f.snapshot.at = start + 1; f.rehash(); }],
        ['old data', f => { f.snapshot.observedAt = start - 5001; }],
        ['old metadata', f => { f.snapshot.validation.at = start - 5001; }],
        ['ambiguous sides', f => { f.snapshot.allowed.push({ ...f.spec, index: 1 }); }],
    ];
    for (const [maxCostPerShare, price] of [[.85, .83], [.82, .79]])
        for (const [name, change] of cases) await t.test(`${maxCostPerShare}: ${name}`, async () => {
            const f = data({ maxCostPerShare, price }); change(f);
            const provider = new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => start });
            const decision = await provider.predict('eligible', f.snapshot);
            assert.equal(decision.status, 'ok'); assert.equal(decision.action, 'SKIP');
            assert.equal(decision.entryFilter.pass, false); assert.equal(decision.executable, false);
            assert.match(decision.reason, /^eligible_entry_/);
        });
});

test('actual LIVE engine vetoes above-cap entries without stopping and may take a later qualifying slot', async t => {
    for (const [maxCostPerShare, above, below] of [[.85, .84, .83], [.82, .80, .79]])
        await t.test(String(maxCostPerShare), async t => {
            const f = engineFixture(t, { price: above, maxCostPerShare });
            await f.engine.discover(start);
            assert.equal(f.state.ai.snapshots[0].entryDisposition, 'entry_cost_above_cap');
            assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
            assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
            assert.equal(f.state.stopped, null); assert.equal(f.state.failures, 0);
            f.books[0].asks[0].price = below - .01; f.books[0].bids[0].price = below - .02; f.setTime(start + 30000);
            await f.engine.discover(start + 30000);
            assert.equal(f.client.post.mock.callCount(), 1);
            assert.equal(f.state.position.entrySignal.entryFilter.pass, true);
            assert.equal(f.state.position.entrySignal.entryFilter.policy.maxCostPerShare, maxCostPerShare);
            assert.equal(f.state.position.entrySignal.strategyEpochId, 'cost-cap-epoch');
            assert.equal(f.state.ai.snapshots[1].strategyEpochId, 'cost-cap-epoch');
            assert.equal(f.state.position.orders[0].execution.entryFilter.pass, true);
            assert.equal(f.state.position.orders[0].shares, 5);
            assert.equal(f.state.position.orders[0].filled, 0);
            assert.equal(f.state.stopped, null);
        });
});

test('LIVE engine accepts the fee-free exact boundary and keeps unfiltered legacy behavior', async t => {
    for (const options of [{ price: .84, rate: 0 }, { price: .81, rate: 0, maxCostPerShare: .82 },
        { price: .84, enabled: false }, { index: 1, price: .83 }, { index: 1, price: .79, maxCostPerShare: .82 }])
        await t.test(JSON.stringify(options), async t => {
            const f = engineFixture(t, options); await f.engine.discover(start);
            assert.equal(f.client.post.mock.callCount(), 1); assert.equal(f.state.stopped, null);
            assert.equal(f.state.position.orders[0].shares, 5);
            assert.ok(f.state.position.orders[0].cost <= 5);
            assert.equal(f.state.position.entrySignal.entryFilter?.pass, options.enabled === false ? undefined : true);
        });
});

test('Cost-cap admission keeps the full deterministic budget and rejects exhausted execution headroom', async t => {
    for (const [name, options, expected] of [
        ['data older than the AI-only reserve', { inputAgeMs: 2000 }, null],
        ['exact deterministic boundary', { inputAgeMs: 4600 }, null],
        ['beyond deterministic boundary', { inputAgeMs: 4601 }, 'insufficient_input_headroom'],
        ['wallet consumes execution reserve', { inputAgeMs: 4600, walletDelayMs: 1 }, 'insufficient_execution_headroom'],
    ]) await t.test(name, async t => {
        const f = engineFixture(t, options); await f.engine.discover(start);
        const snapshot = f.state.ai.snapshots[0];
        assert.equal(f.client.post.mock.callCount(), expected ? 0 : 1);
        assert.equal(f.state.stopped, null);
        if (expected) {
            assert.equal(snapshot.entryDisposition, expected);
            assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        } else {
            assert.equal(snapshot.decision.inferenceAttempted, false);
            assert.ok(snapshot.executionEvidence.snapshotToCheckMs >= 250);
            assert.ok(f.state.position.orders[0].cost <= 5);
        }
    });
});

test('execution rechecks frozen terms before reservation and after signing without retrying or stopping', async t => {
    for (const [maxCostPerShare, price] of [[.85, .83], [.82, .79]])
        for (const stage of ['onWait', 'onPrepare']) for (const change of ['fee', 'cost', 'decision'])
        await t.test(`${maxCostPerShare}: ${stage}: ${change}`, async t => {
            const mutate = f => {
                if (change === 'fee') f.market.fee.rate = .09;
                if (change === 'cost') f.state.ai.snapshots[0].allowed[0].cost -= .01;
                if (change === 'decision') f.state.ai.snapshots[0].decision.entryFilter.metrics.gasUsd = 0;
            };
            const f = engineFixture(t, { price, maxCostPerShare, [stage]: mutate }); await f.engine.discover(start);
            assert.equal(f.client.post.mock.callCount(), 0); assert.equal(f.state.stopped, null);
            assert.equal(f.state.failures, 0); assert.ok(f.events.some(row => row.type === 'eligible_entry_filter_veto'));
            if (stage === 'onWait') {
                assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
                assert.equal(f.client.prepare.mock.callCount(), 0);
            } else {
                assert.equal(f.client.prepare.mock.callCount(), 1);
                assert.equal(f.state.position.orders[0].status, 'rejected');
                assert.equal(f.state.position.orders[0].postAttemptAt, undefined);
                await assert.rejects(f.engine.broker.submit(f.spec, start + 250), /duplicate_entry_attempt/);
                assert.equal(f.client.post.mock.callCount(), 0);
            }
        });
});
