import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { EligibleLiveProvider, ELIGIBLE_MODEL, eligibleAction } from '../../src/eligible-live/provider.js';
import { LayaLiveEngine, entryGuard, initializeAI } from '../../src/laya-live/engine.js';
import { LiveSupervisor } from '../../src/laya-live/runner.js';
import { ShadowEngine } from '../../src/ai-shadow/engine.js';
import { marketSlug } from '../../src/restart/strategy.js';
import { OperationalError } from '../../src/restart/network.js';

const start = Date.parse('2026-10-16T00:04:00Z');

function fixture(t, options = {}) {
    let now = start;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(performance, 'now', () => now - start);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_eligible_fixture'); });
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, shares: 5, entryCap: 5,
        late: { duration: 300 }, lateQuality: { maxSpread: .03, minDepth: 5 } };
    const config = { settings, policy: { provider: 'eligible', model: ELIGIBLE_MODEL, aiSource: ELIGIBLE_MODEL }, ai: {
        slots: [60], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
    } };
    const market = { slug: marketSlug('late-entry', settings, start), conditionId: 'fixture-condition',
        open: start - 240000, end: start + 60000, accepting: true, minimum: 5,
        tick: .01, ticks: [.01, .01], tokens: ['fixture-up', 'fixture-down'], outcomes: ['Up', 'Down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, negRisk: false };
    const rows = market.tokens.map((tokenId, index) => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: start - 100, fetchedAt: start - 100,
        bids: [{ price: index === (options.index ?? 0) ? .76 : .22, size: 10 }],
        asks: [{ price: index === (options.index ?? 0) ? .77 : .23, size: 10 }] }));
    const setAsk = (price, size = 10, index = options.index ?? 0) => {
        rows[index].asks = [{ price, size }]; rows[index].bids = [{ price: price - .01, size: 10 }];
    };
    if (options.ambiguous) setAsk(.77, 10, 1);
    if (options.noAllowed) setAsk(.23);
    const bookRows = () => structuredClone(rows);
    const stream = { generation: 1, tokens: [...market.tokens], snapshot: bookRows };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 3600000, cash: 20,
        walletStart: 20, walletCashDelta: 0, peakEquity: 20, maxDrawdown: 0, failures: 0,
        completed: [], seen: {}, stopped: null, position: null };
    const events = [], persisted = [];
    const store = { state, save() { persisted.push(structuredClone(state)); },
        event(type, detail = {}) {
            events.push({ type, ...detail, at: now }); this.save();
            if (['laya_snapshot', 'laya_decision'].includes(type)) now += options.persistMs ?? 0;
        },
        stop(reason) { state.stopped ||= { reason, at: now }; this.save(); } };
    const orderId = `0x${'e'.repeat(64)}`, signed = { fixtureOnly: true, orderType: 'FAK' };
    const client = {
        btc: { assess: t.mock.fn(() => ({ reason: options.signalReason ?? null })) },
        books: t.mock.fn(async () => { await options.restGate; return bookRows(); }),
        marketInfo: t.mock.fn(async () => ({})), validateInfo: t.mock.fn(),
        confirmedBlock: t.mock.fn(async () => 123), balance: t.mock.fn(async () => {
            await options.walletGate;
            if (options.walletError) throw options.walletError;
            return options.balance ?? 20;
        }),
        holdings: t.mock.fn(async () => { await options.walletGate; return options.holdings ?? [0, 0]; }),
        warmOrderMetadata: t.mock.fn(async () => { now += options.walletDelayMs ?? 0; }),
        prepare: t.mock.fn(async spec => {
            assert.ok(now >= start + 250); assert.equal(spec.shares, 5); assert.equal(spec.price, .78);
            assert.equal(spec.side, 'BUY'); assert.equal(spec.kind, 'taker');
            options.onPrepare?.({ setAsk, state, rows, stream });
            return { orderId, signed };
        }),
        post: t.mock.fn(async payload => {
            assert.equal(payload, signed);
            const saved = persisted.at(-1).position.orders[0];
            assert.equal(saved.status, 'submitting'); assert.equal(saved.postAttemptAt, now);
            assert.deepEqual(saved.signed, signed); assert.equal(saved.shares, 5); assert.equal(saved.price, .78);
            return { ok: true, orderId, status: 'matched', makingAmount: '1.56', takingAmount: '2',
                tradeIds: ['fixture-partial-trade'], transactionsHashes: [] };
        }),
    };
    // Keep shared entry and broker logic real; replace only market history
    // assembly and the wall-clock wait, with network calls forbidden.
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => {
        now += options.preparationMs ?? 0;
        return { initial: bookRows(), timing: {}, features: {
            observedAt: now - (options.inputAgeMs ?? 100), state: { fixture: 'validated-history' },
        } };
    });
    const providers = new EligibleLiveProvider(config.ai, {}, () => {});
    const predict = t.mock.method(providers, 'predict');
    const engine = new LayaLiveEngine(config, store, client, stream, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    engine.current = market;
    const waits = [];
    t.mock.method(engine, 'awaitExecutionLatency', async snapshot => {
        assert.equal(state.position, null); assert.deepEqual(state.seen, {});
        assert.equal(client.prepare.mock.callCount(), 0); assert.equal(client.post.mock.callCount(), 0);
        waits.push({ at: now, until: snapshot.decisionReceivedAt + 250 });
        now = Math.max(now, snapshot.decisionReceivedAt + (options.executionDelayMs ?? 250));
        options.onWait?.({ setAsk, state, rows, stream });
    });
    return { engine, providers, predict, config, state, market, client, stream, store, events, persisted, waits,
        rows, setAsk, get now() { return now; }, setTime(value) { now = value; } };
}

test('eligible provider buys exactly one allowed side and never invokes inference or a tokenizer', async t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_provider_fixture'); });
    const provider = new EligibleLiveProvider({}, {}, () => {}, { clock: () => start });
    assert.deepEqual(await provider.preflight(), { eligible: { ready: true, model: ELIGIBLE_MODEL, inferenceAttempted: false } });
    assert.equal(provider.counter, undefined); assert.equal(provider.active.size, 0);
    for (const [allowed, action] of [
        [[{ index: 0 }], 'BUY_UP'], [[{ index: 1 }], 'BUY_DOWN'], [[], 'SKIP'],
        [[{ index: 0 }, { index: 1 }], 'SKIP'], [[{ index: 2 }], 'SKIP'], [[null], 'SKIP'], [null, 'SKIP'],
    ]) {
        assert.equal(eligibleAction(allowed), action);
        assert.deepEqual(await provider.predict('eligible', { snapshotId: 'fixture', allowed }), {
            provider: 'eligible', model: ELIGIBLE_MODEL, snapshotId: 'fixture', status: 'ok', action,
            executable: action !== 'SKIP', inferenceAttempted: false,
            requestedAt: start, receivedAt: start, latencyMs: 0, cost: 0,
        });
    }
    await assert.rejects(provider.predict('laya', {}), /eligible_only/);
    provider.close();
    assert.equal((await provider.predict('eligible', { allowed: [{ index: 0 }] })).action, 'SKIP');
    assert.equal((await provider.preflight()).eligible.ready, false);
});

test('eligible uses the shared fixed-limit broker and records truthful identity with no invented inventory', async t => {
    for (const index of [0, 1]) await t.test(`outcome ${index}`, async t => {
        const f = fixture(t, { index }); await f.engine.discover(start);
        const snapshot = f.state.ai.snapshots[0], position = f.state.position, order = position.orders[0];
        assert.equal(f.state.decisionProvider, 'eligible'); assert.equal(f.predict.mock.callCount(), 1);
        assert.equal(f.predict.mock.calls[0].arguments[0], 'eligible');
        assert.equal(snapshot.provider, 'eligible'); assert.equal(snapshot.model, ELIGIBLE_MODEL);
        assert.equal(snapshot.inferenceAttempted, false); assert.equal(snapshot.decision.latencyMs, 0);
        assert.equal(snapshot.decisionReceivedAt, start); assert.equal(position.openedAt, start + 250);
        assert.deepEqual(f.waits, [{ at: start, until: start + 250 }]);
        assert.equal(position.entrySignal.provider, 'eligible'); assert.equal(position.entrySignal.model, ELIGIBLE_MODEL);
        assert.equal(position.entrySignal.action, index === 0 ? 'BUY_UP' : 'BUY_DOWN');
        assert.equal(order.status, 'accepted'); assert.equal(order.filled, 0); assert.equal(order.settled, 0);
        assert.deepEqual(position.holdings, [0, 0]); assert.equal(f.state.cash, 20);
        assert.equal(order.price, .78); assert.equal(order.shares, 5); assert.ok(order.cost <= 5);
        assert.equal(f.client.confirmedBlock.mock.callCount(), 1); assert.equal(f.client.post.mock.callCount(), 1);
        assert.equal(snapshot.executionEvidence.snapshotToCheckMs, 250);
        assert.ok(f.events.some(row => row.type === 'entry_reserved' && row.provider === 'eligible'));
        await f.engine.discover(start + 250);
        await assert.rejects(f.engine.broker.submit(order, start + 250), /duplicate_entry_attempt/);
        assert.equal(f.client.post.mock.callCount(), 1);
        const saved = structuredClone(f.state), restored = structuredClone(f.state);
        initializeAI(restored, f.config);
        assert.deepEqual(restored.seen, saved.seen); assert.deepEqual(restored.position, saved.position);
        assert.deepEqual(restored.ai.slots, saved.ai.slots);
    });
});

test('eligible skips ambiguous and empty candidate sets without reserving a market', async t => {
    for (const options of [{ ambiguous: true }, { noAllowed: true }]) await t.test(JSON.stringify(options), async t => {
        const f = fixture(t, options); await f.engine.discover(start);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
        if (options.ambiguous) {
            assert.equal(f.state.ai.snapshots[0].decision.action, 'SKIP');
            assert.equal(f.state.ai.snapshots[0].entryDisposition, 'eligible_skip');
        } else assert.equal(Object.values(f.state.ai.slots)[0].status, 'no_valid_side');
    });
});

test('eligible overlaps a fresh pinned wallet with market preparation and durable snapshot writes', async t => {
    const rest = Promise.withResolvers(), wallet = Promise.withResolvers();
    const f = fixture(t, { restGate: rest.promise, walletGate: wallet.promise, inputAgeMs: 1100, persistMs: 400 });
    const pending = f.engine.discover(start);
    t.after(async () => { rest.resolve(); wallet.resolve(); await pending; });
    await nextTurn();
    assert.equal(f.client.confirmedBlock.mock.callCount(), 1);
    assert.equal(f.client.balance.mock.callCount(), 1);
    assert.equal(f.client.holdings.mock.callCount(), 1);
    assert.equal(f.state.ai.snapshots.length, 0);
    assert.equal(f.client.prepare.mock.callCount(), 0);
    f.setTime(start + 1500); rest.resolve();
    await nextTurn();
    const snapshot = f.state.ai.snapshots[0];
    assert.equal(snapshot.at, start + 1500);
    assert.equal(snapshot.snapshotPersistMs, 400);
    assert.equal(f.client.prepare.mock.callCount(), 0);
    f.setTime(start + 2200); wallet.resolve();
    await pending;
    assert.equal(snapshot.entryDisposition, 'order_accepted');
    assert.equal(snapshot.wallet.startedAt, start);
    assert.equal(snapshot.wallet.checkedAt, start + 2200);
    assert.equal(snapshot.wallet.block, 123);
    assert.equal(snapshot.walletReadMs, 2200);
    assert.equal(snapshot.walletWaitMs, 300);
    assert.equal(f.state.position.openedAt, start + 2600);
    assert.equal(f.client.post.mock.callCount(), 1);
    assert.equal(f.config.ai.dataAgeMs, 5000);
    assert.equal(f.state.position.orders[0].price, .78);
    assert.equal(f.state.position.orders[0].shares, 5);
    assert.equal(f.client.balance.mock.calls[0].arguments[0], 123);
    assert.equal(f.client.holdings.mock.calls[0].arguments[1], 123);
});

test('eligible drains the wallet on discarded observations before another tick can use the RPC anchor', async t => {
    for (const reason of ['no_valid_side', 'preparation_failed', 'metadata_failed', 'engine_closed'])
        for (const failWallet of [false, true]) await t.test(`${reason}, wallet failure ${failWallet}`, async t => {
            const rest = Promise.withResolvers(), wallet = Promise.withResolvers();
            const f = fixture(t, { restGate: rest.promise, walletGate: wallet.promise,
                noAllowed: reason === 'no_valid_side',
                ...(failWallet ? { walletError: new OperationalError('read_timeout', 'timeout') } : {}) });
            if (reason === 'preparation_failed') t.mock.method(f.client, 'books', async () => {
                await rest.promise; throw new OperationalError('read_timeout', 'timeout');
            });
            if (reason === 'metadata_failed') t.mock.method(f.client, 'marketInfo', async () => {
                throw new OperationalError('read_timeout', 'timeout');
            });
            let finished = false;
            const pending = f.engine.discover(start).finally(() => { finished = true; });
            t.after(async () => { rest.resolve(); wallet.resolve(); await pending; });
            await nextTurn();
            assert.equal(f.client.balance.mock.callCount(), 1);
            if (reason === 'engine_closed') f.engine.closed = true;
            rest.resolve(); await nextTurn();
            assert.equal(finished, false, 'discarding market data must still drain the pinned wallet reads');
            assert.equal(f.client.post.mock.callCount(), 0);
            wallet.resolve(); await pending;
            assert.equal(finished, true);
            assert.equal(f.state.position, null);
            assert.deepEqual(f.state.seen, {});
            assert.equal(f.client.prepare.mock.callCount(), 0);
            assert.equal(f.client.post.mock.callCount(), 0);
        });
});

test('prefetched wallet proof keeps its original age and expires without preparing an order', async t => {
    const wallet = Promise.withResolvers();
    const f = fixture(t, { walletGate: wallet.promise });
    const pending = f.engine.discover(start);
    t.after(async () => { wallet.resolve(); await pending; });
    await nextTurn();
    f.setTime(start + 5001); wallet.resolve(); await pending;
    assert.equal(f.state.ai.snapshots[0].entryDisposition, 'entry_wallet_expired');
    assert.equal(f.client.confirmedBlock.mock.callCount(), 1);
    assert.equal(f.client.prepare.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
    assert.equal(f.state.position, null);
});

test('discarded market data cannot hide a concurrent wallet identity failure', async t => {
    for (const code of ['rpc_wrong_chain', 'rpc_block_mismatch', 'entry_wallet_invalid'])
        for (const failedPreparation of [false, true]) await t.test(`${code}, preparation failure ${failedPreparation}`, async t => {
            const wallet = Promise.withResolvers();
            const f = fixture(t, { noAllowed: true, walletGate: wallet.promise,
                walletError: new OperationalError(code, 'validation', { stage: 'wallet_read' }) });
            if (failedPreparation) t.mock.method(f.client, 'books', async () => {
                throw new OperationalError('read_timeout', 'timeout');
            });
            const pending = f.engine.discover(start);
            t.after(async () => { wallet.resolve(); await pending; });
            await nextTurn(); wallet.resolve(); await pending;
            assert.equal(f.state.stopped?.reason, 'operational_check_failed');
            assert.ok(f.events.some(row => row.type === 'laya_snapshot_skipped' && row.reason === code));
            assert.equal(f.client.prepare.mock.callCount(), 0);
            assert.equal(f.client.post.mock.callCount(), 0);
            assert.equal(f.state.position, null);
        });
});

test('eligible rechecks the current book after the minimum latency and retains the original limit', async t => {
    for (const [name, options, expected] of [
        ['price moves above limit', { onWait: ({ setAsk }) => setAsk(.79) }, 'execution_limit_unmarketable'],
        ['price band changes', { onWait: ({ setAsk }) => setAsk(.91) }, 'execution_constraints_changed'],
        ['input expires during delay', { inputAgeMs: 1500, executionDelayMs: 3501 }, 'stale_eligible_input'],
        ['clock delay too short', { executionDelayMs: 249 }, 'eligible_execution_latency_pending'],
        ['stream generation changes', { onWait: ({ stream }) => { stream.generation++; } }, 'execution_book_generation_changed'],
        ['risk stop during delay', { onWait: ({ state }) => { state.liveRiskStop = { reason: 'drawdown_limit' }; } }, 'live_entry_held'],
        ['wallet ledger mismatch', { balance: 19 }, 'wallet_ledger_mismatch'],
        ['existing wallet inventory', { holdings: [.1, 0] }, 'legacy_inventory_overlap'],
    ]) await t.test(name, async t => {
        const f = fixture(t, options); await f.engine.discover(start);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
        assert.equal(f.state.ai.snapshots[0].entryDisposition, expected);
        assert.equal(f.state.ai.snapshots[0].allowed[0].price, .78);
    });
});

test('eligible preserves the paper comparator input, metadata and execution headroom gates', async t => {
    for (const [name, options, expected] of [
        ['old input at dispatch', { inputAgeMs: 1601 }, 'insufficient_input_headroom'],
        ['old validation at dispatch', { preparationMs: 1601 }, 'insufficient_validation_headroom'],
        ['wallet consumes execution reserve', { inputAgeMs: 1600, walletDelayMs: 3001 }, 'insufficient_execution_headroom'],
    ]) await t.test(name, async t => {
        const f = fixture(t, options); await f.engine.discover(start);
        assert.equal(f.state.ai.snapshots[0].entryDisposition, expected);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
        assert.equal(f.predict.mock.callCount(), expected === 'insufficient_execution_headroom' ? 1 : 0);
    });
    await t.test('exact 1600ms input boundary', async t => {
        const f = fixture(t, { inputAgeMs: 1600 }); await f.engine.discover(start);
        assert.equal(f.client.post.mock.callCount(), 1);
    });
});

test('partial current depth is valid for FAK and post-prepare price moves preserve the reservation', async t => {
    await t.test('partial depth', async t => {
        const f = fixture(t, { onWait: ({ setAsk }) => setAsk(.78, .25) }); await f.engine.discover(start);
        assert.equal(f.client.post.mock.callCount(), 1);
        assert.equal(f.state.ai.snapshots[0].executionEvidence.executableShares, .25);
        assert.equal(f.state.position.orders[0].shares, 5);
    });
    await t.test('price changes after preparation', async t => {
        const f = fixture(t, { onPrepare: ({ setAsk }) => setAsk(.79) }); await f.engine.discover(start);
        assert.equal(f.client.prepare.mock.callCount(), 1); assert.equal(f.client.post.mock.callCount(), 0);
        assert.ok(f.state.seen[f.market.slug]); assert.equal(f.state.position.orders[0].status, 'rejected');
        assert.equal(f.state.cash, 20); assert.deepEqual(f.state.position.holdings, [0, 0]);
        await assert.rejects(f.engine.broker.submit(f.state.position.orders[0], f.now), /duplicate_entry_attempt/);
    });
});

test('eligible cannot adopt Laya state or bypass decision identity, one-side, fixed-share and budget guards', async t => {
    const f = fixture(t); await f.engine.discover(start);
    const snapshot = f.state.ai.snapshots[0], decision = snapshot.decision, spec = f.state.position.orders[0];
    const valid = { state: f.state, config: f.config, market: f.market, snapshot, decision, spec, books: f.rows, now: f.now };
    assert.doesNotThrow(() => entryGuard(valid));
    for (const [field, value] of [['provider', 'laya'], ['model', 'typed-decisions'], ['inferenceAttempted', true],
        ['snapshotId', 'wrong'], ['action', 'BUY_DOWN']])
        assert.throws(() => entryGuard({ ...valid, decision: { ...decision, [field]: value } }));
    assert.throws(() => entryGuard({ ...valid, snapshot: { ...snapshot, allowed: [...snapshot.allowed, { index: 1 }] } }), /invalid_eligible_decision/);
    assert.throws(() => entryGuard({ ...valid, spec: { ...spec, shares: 6 } }), /entry_specification_changed/);
    assert.throws(() => entryGuard({ ...valid, state: { ...f.state, cash: 1 } }), /entry_budget_exceeded/);
    assert.throws(() => initializeAI({ decisionProvider: 'laya' }, f.config), /live_provider_identity_mismatch/);
    assert.throws(() => initializeAI({}, { ...f.config, ai: { ...f.config.ai, latencyMs: 0 } }), /invalid_eligible_configuration/);
    assert.throws(() => initializeAI({}, { ...f.config, ai: { ...f.config.ai, decisionProtocol: { schema: 'laya' } } }), /invalid_eligible_configuration/);
    assert.throws(() => initializeAI({ ai: { providers: { laya: {} } } }, f.config), /invalid_eligible_configuration/);
    assert.throws(() => initializeAI(structuredClone(f.state), { ...f.config, policy: { ...f.config.policy, aiSource: 'changed' } }), /live_ai_source_changed/);
});

test('the production latency wait cannot resolve before its timer and early wakeups remain guarded', async t => {
    let release;
    t.mock.method(Date, 'now', () => start);
    t.mock.method(globalThis, 'setTimeout', (resolve, ms) => { assert.equal(ms, 250); release = resolve; });
    let complete = false;
    const waiting = LayaLiveEngine.prototype.awaitExecutionLatency({ decisionReceivedAt: start }).then(() => { complete = true; });
    await nextTurn(); assert.equal(complete, false);
    release(); await waiting; assert.equal(complete, true);
});

test('eligible supervision probes the local provider identity without requiring Laya health', async t => {
    const f = fixture(t);
    const supervisor = new LiveSupervisor({ engine: f.engine, store: f.store, providers: f.providers,
        now: () => f.now, probeIntervalMs: 1000, diagnostic() {} });
    const preflight = t.mock.method(f.providers, 'preflight');
    f.setTime(start + 1000); supervisor.maybeProbe();
    assert.ok(f.state.entryHolds.provider_probe);
    await supervisor.probeBounded;
    assert.equal(supervisor.providerName, 'eligible'); assert.equal(preflight.mock.callCount(), 1);
    assert.deepEqual(f.state.entryHolds, {});
    assert.ok(f.events.some(row => row.type === 'eligible_provider_health_ready'));
    assert.equal(f.events.some(row => row.type === 'laya_provider_health_ready'), false);
    assert.equal(f.providers.state.laya, undefined); assert.equal(f.predict.mock.callCount(), 0);
    assert.equal(f.client.post.mock.callCount(), 0);
    assert.throws(() => new LiveSupervisor({ engine: f.engine, store: f.store, providers: f.providers,
        providerName: 'laya' }), /live_provider_identity_mismatch/);
});

test('eligible health probes cannot accept another provider or clear a semantic hold', async t => {
    const f = fixture(t);
    const supervisor = new LiveSupervisor({ engine: f.engine, store: f.store, providers: f.providers,
        now: () => f.now, probeIntervalMs: 1000, diagnostic() {} });
    const preflight = t.mock.method(f.providers, 'preflight', async () => ({ laya: { ready: true } }));
    f.setTime(start + 1000); supervisor.maybeProbe(); await supervisor.probeBounded;
    assert.equal(f.state.entryHolds.provider_semantics.retryable, false);
    preflight.mock.mockImplementation(async () => ({ eligible: { ready: true, model: ELIGIBLE_MODEL } }));
    f.setTime(start + 2000); supervisor.maybeProbe(); await supervisor.probeBounded;
    assert.equal(f.state.entryHolds.provider_semantics.retryable, false);
    assert.equal(f.state.entryHolds.provider_probe, undefined);
    assert.equal(f.client.post.mock.callCount(), 0);
});

test('eligible keeps feed validation but does not impose a BTC prediction filter', async t => {
    for (const reason of ['btc_edge_insufficient', 'btc_direction_disagrees']) await t.test(reason, async t => {
        const f = fixture(t, { signalReason: reason }); await f.engine.discover(start);
        assert.equal(f.client.post.mock.callCount(), 1);
        assert.equal(f.state.position.entrySignal.provider, 'eligible');
    });
    await t.test('invalid feed blocks entry', async t => {
        const f = fixture(t, { signalReason: 'btc_reference_unverified' }); await f.engine.discover(start);
        assert.equal(f.client.post.mock.callCount(), 0); assert.equal(f.state.position, null);
        assert.equal(f.predict.mock.callCount(), 0); assert.equal(f.state.stopped.reason, 'operational_check_failed');
    });
});
