import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LayaLiveEngine, assertDecisionTiming } from '../../src/laya-live/engine.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { LayaLiveProvider } from '../../src/laya-live/provider.js';
import { ShadowEngine } from '../../src/ai-shadow/engine.js';
import { marketSlug } from '../../src/restart/strategy.js';
import { OperationalError } from '../../src/restart/network.js';
import { lossProtectionActivationId } from '../../src/laya-live/loss-evidence.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const start = Date.parse('2026-10-16T00:04:00Z');

function entryFixture(t, options = {}) {
    let now = start, warmed = false;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_entry_fixture'); });
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, late: { duration: 300 },
        lateQuality: { maxSpread: .03, minDepth: 5 } };
    const config = { settings, policy: { aiSource: 'offline-entry-source' }, ai: {
        slots: [60], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000,
        shares: 5, entryCap: 5, gasUsd: .05, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
    } };
    const market = { slug: marketSlug('late-entry', settings, now), conditionId: 'fixture-condition',
        open: start - 240000, end: start + 60000, accepting: true, minimum: 5,
        tick: .001, ticks: [.001, .001], tokens: ['fixture-up', 'fixture-down'], outcomes: ['Up', 'Down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, negRisk: false };
    const observedAt = start - (options.inputAgeMs ?? 1269);
    const bookRows = () => [
        { tokenId: market.tokens[0], conditionId: market.conditionId, tick: .01, timestamp: observedAt, fetchedAt: observedAt,
            bids: [{ price: .77, size: 10 }], asks: [{ price: .78, size: 10 }] },
        { tokenId: market.tokens[1], conditionId: market.conditionId, tick: .01, timestamp: observedAt, fetchedAt: observedAt,
            bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] },
    ];
    const stream = { generation: 1, tokens: [...market.tokens], snapshot: bookRows };
    const gates = { ai: deferred(), wallet: deferred(), metadata: deferred() }, begun = [];
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: start - 3600000, walletStart: 20,
        walletCashDelta: 0, cash: 20, peakEquity: 20, maxDrawdown: 0, failures: 0,
        stopped: null, seen: {}, completed: [], position: null };
    const events = [], persisted = [];
    const store = { state, save() { persisted.push({ at: now, state: structuredClone(state) }); },
        event(type, detail) { events.push({ type, detail, at: now }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: now }; this.save(); } };
    const orderId = '0xoffline-order', signed = { fixtureOnly: 'unsigned-placeholder' };
    const client = {
        btc: { assess: t.mock.fn(() => ({ reason: null })) },
        books: t.mock.fn(async () => bookRows()),
        marketInfo: t.mock.fn(async () => ({ negRisk: false, feeInfo: { rate: .07, exponent: 1 },
            tickSize: .001, tokens: market.tokens.map((assetId, i) => ({ assetId, outcome: market.outcomes[i] })) })),
        validateInfo: t.mock.fn((actual, info) => {
            assert.equal(actual, market); assert.equal(info.negRisk, market.negRisk);
            assert.equal(info.feeInfo.rate, market.fee.rate); assert.equal(info.feeInfo.exponent, market.fee.exponent);
            assert.deepEqual(info.tokens.map(token => token.assetId), market.tokens);
        }),
        tickSize: t.mock.fn(async token => { assert.ok(market.tokens.includes(token)); return .001; }),
        confirmedBlock: t.mock.fn(async () => 12345),
        balance: t.mock.fn(async block => {
            begun.push({ task: 'balance', at: now, block }); await gates.wallet.promise;
            return options.balance ?? 20;
        }),
        holdings: t.mock.fn(async (tokens, block) => {
            begun.push({ task: 'holdings', at: now, block }); assert.deepEqual(tokens, market.tokens);
            await gates.wallet.promise; return options.holdings ?? [0, 0];
        }),
        warmOrderMetadata: t.mock.fn(async spec => {
            begun.push({ task: 'metadata', at: now });
            assert.equal(state.position, null); assert.deepEqual(state.seen, {});
            assert.equal(spec.tokenId, market.tokens[0]); assert.equal(spec.shares, 5); assert.equal(spec.price, .781);
            await gates.metadata.promise;
            if (options.warmError) throw options.warmError;
            warmed = true;
        }),
        prepare: t.mock.fn(async spec => {
            assert.equal(warmed, true, 'unsigned metadata warmup must complete before preparation');
            assert.equal(client.tickSize.mock.callCount(), 2, 'fresh endpoint proof must be reused');
            assert.equal(spec.shares, 5); assert.equal(spec.price, .781); assert.equal(spec.tokenId, market.tokens[0]);
            now += 13; // Explicit preparation/persistence overhead in the latency comparison.
            return { orderId, signed };
        }),
        post: t.mock.fn(async payload => {
            assert.equal(payload, signed);
            const saved = persisted.at(-1).state.position.orders[0];
            assert.equal(saved.orderId, orderId); assert.deepEqual(saved.signed, signed);
            assert.equal(saved.status, 'submitting'); assert.equal(saved.postAttemptAt, now);
            return { ok: true, orderId, status: 'matched', makingAmount: '1.562', takingAmount: '2',
                tradeIds: ['fixture-partial-trade'], transactionsHashes: [] };
        }),
    };
    const providers = { predict: t.mock.fn(async (name, snapshot) => {
        assert.equal(name, 'laya'); begun.push({ task: 'ai', at: now });
        const requestedAt = now;
        await gates.ai.promise;
        return { snapshotId: snapshot.snapshotId, status: options.status ?? 'ok',
            action: options.action ?? 'BUY_UP', model: 'typed-decisions', requestedAt,
            receivedAt: now, latencyMs: now - requestedAt };
    }) };
    // Feature/history assembly alone is replaced; snapshot collection, token,
    // tick, freshness, wallet validation, reservation and submission stay real.
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: bookRows(), timing: {}, features: {
        observedAt, state: { seconds: 60, opening_twap: 83000, spot: 83020, twap: 83020, margin_usd: 20,
            volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [1, 1, 1, 1, 1],
            bars_30s_OHLC_oldest_first: Array.from({ length: 6 }, () => [83000, 83020, 83000, 83020]),
            books_up_down: bookRows().map(book => ({ bids: book.bids.map(row => [row.price, row.size]),
                asks: book.asks.map(row => [row.price, row.size]) })), fee_rate: .07, fee_exponent: 1, shares: 5, entry_cap: 5 },
    } }));
    const engine = new LayaLiveEngine(config, store, client, stream, providers);
    // Isolate entry concurrency and execution timing from the clock transport.
    t.mock.method(engine.clockGate, 'fresh', () => true);
    engine.current = market;
    const walletRead = t.mock.method(engine.broker, 'entryWallet');
    const validation = t.mock.method(engine, 'validate');
    const submission = t.mock.method(engine.broker, 'submit');
    return { engine, config, market, state, events, persisted, client, providers, gates, begun,
        walletRead, validation, submission, observedAt, get now() { return now; }, setTime(value) { now = value; } };
}

async function runEntry(t, f, timing = {}) {
    const running = f.engine.discover(start);
    t.after(async () => { for (const gate of Object.values(f.gates)) gate.resolve(); await running; });
    await nextTurn();
    assert.deepEqual(new Set(f.begun.map(row => row.task)), new Set(['ai', 'balance', 'holdings', 'metadata']),
        'AI, both wallet reads and metadata must begin before any gate is released');
    assert.ok(f.begun.every(row => row.at === start));
    assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
    assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
    const releases = [
        { task: 'metadata', ms: timing.metadataMs ?? 500, pending: f.client.warmOrderMetadata.mock.calls[0].result },
        { task: 'wallet', ms: timing.walletMs ?? 1477, pending: f.walletRead.mock.calls[0].result },
        { task: 'ai', ms: timing.aiMs ?? 2952, pending: f.providers.predict.mock.calls[0].result },
    ].sort((a, b) => a.ms - b.ms);
    for (const release of releases) {
        f.setTime(start + release.ms); f.gates[release.task].resolve();
        await release.pending.catch(() => {}); // observe/discover owns the rejection and its disposition.
    }
    await running;
}

test('real live entry overlaps 2952ms AI with 1477ms wallet reads and reuses the verified coarser tick proof', async t => {
    const f = entryFixture(t);
    assert.ok(f.engine.broker instanceof LayaLiveBroker);
    await runEntry(t, f);
    const snapshot = f.state.ai.snapshots[0], order = f.state.position.orders[0];
    assert.equal(f.now - f.observedAt, 4234);
    assert.equal(f.state.position.openedAt, start + 2952);
    assert.doesNotThrow(() => assertDecisionTiming(snapshot, f.config, f.now));
    const oldSerialAt = start + 2952 + 1477 + 13;
    assert.equal(oldSerialAt - f.observedAt, 5711);
    assert.throws(() => assertDecisionTiming(snapshot, f.config, oldSerialAt), /stale_laya_input/);
    assert.equal(f.client.confirmedBlock.mock.callCount(), 1);
    assert.equal(f.client.balance.mock.calls[0].arguments[0], 12345);
    assert.equal(f.client.holdings.mock.calls[0].arguments[1], 12345);
    assert.deepEqual(snapshot.wallet.holdings, [0, 0]); assert.equal(snapshot.wallet.block, 12345);
    assert.deepEqual(snapshot.validation.endpointTicks, [.001, .001]);
    assert.equal(snapshot.validation.tickVerifiedAt, start); assert.equal(f.client.tickSize.mock.callCount(), 2);
    assert.equal(f.validation.mock.callCount(), 3); assert.equal(f.submission.mock.callCount(), 1);
    assert.equal(f.client.prepare.mock.callCount(), 1); assert.equal(f.client.post.mock.callCount(), 1);
    assert.equal(order.status, 'accepted'); assert.equal(order.shares, 5);
    assert.deepEqual(order.tradeIds, ['fixture-partial-trade']);
    // A placement response with partial amounts cannot manufacture confirmed inventory or cash movement.
    assert.equal(order.filled, 0); assert.equal(order.settled, 0);
    assert.deepEqual(f.state.position.holdings, [0, 0]); assert.equal(f.state.cash, 20);
    assert.equal(f.state.stopped, null); assert.equal(snapshot.entryDisposition, 'order_accepted');
    assert.equal(snapshot.executionStage, 'submission_complete'); assert.equal(snapshot.metadataWarmupMs, 500);
    assert.ok(f.events.some(event => event.type === 'entry_reserved' && event.at === start + 2952));
    assert.equal(f.events.filter(event => event.type === 'order_submission_started').length, 1);
    await f.engine.discover(f.now);
    await assert.rejects(f.engine.broker.submit(order, f.now), /duplicate_entry_attempt/);
    assert.equal(f.client.post.mock.callCount(), 1);
});

test('wallet, metadata, timing and disallowed AI side failures never reserve or submit an entry', async t => {
    const cases = [
        { name: 'expired wallet witness', timing: { walletMs: 5001, aiMs: 1000 }, reason: 'entry_wallet_expired' },
        { name: 'nonfinite wallet balance', options: { balance: NaN }, reason: 'entry_wallet_invalid' },
        { name: 'nonfinite wallet holdings', options: { holdings: [NaN, 0] }, reason: 'entry_wallet_invalid' },
        { name: 'legacy holdings', options: { holdings: [.1, 0] }, reason: 'legacy_inventory_overlap', stop: 'legacy_inventory_overlap' },
        { name: 'wallet ledger mismatch', options: { balance: 19 }, reason: 'wallet_ledger_mismatch', stop: 'wallet_ledger_mismatch' },
        { name: 'metadata warmup failed', options: { warmError: new OperationalError('invalid_api_data', 'validation') }, reason: 'invalid_api_data' },
        { name: 'late successful response', timing: { aiMs: 3001 }, reason: 'late_laya_response' },
        { name: 'input expired while AI ran', options: { inputAgeMs: 2200 }, reason: 'stale_laya_input' },
        { name: 'provider decision timeout', options: { status: 'decision_timeout', action: 'SKIP' }, reason: 'decision_timeout' },
        { name: 'wrong AI side', options: { action: 'BUY_DOWN' }, reason: 'ai_side_not_allowed' },
    ];
    for (const row of cases) await t.test(row.name, async t => {
        const f = entryFixture(t, row.options);
        await runEntry(t, f, row.timing);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
        assert.equal(f.submission.mock.callCount(), 0);
        assert.ok(f.persisted.every(saved => saved.state.position === null && Object.keys(saved.state.seen).length === 0));
        assert.ok(f.events.every(event => event.type !== 'entry_reserved' && event.type !== 'order_submission_started'));
        assert.equal(f.state.ai.snapshots[0].entryDisposition, row.reason);
        assert.ok(f.events.some(event => event.type === 'laya_entry_disposition' && event.detail.reason === row.reason));
        if (row.stop) assert.equal(f.state.stopped.reason, row.stop);
    });
});

function enableLossProtection(f) {
    f.config.profitTaking = { enabled: true,
        lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } };
    f.state.profitTakingControl = { lossProtection: { schema: 1, activatedAt: start - 1000,
        completedCount: 0, completedSha256: crypto.createHash('sha256').update('[]').digest('hex'), consumed: [] } };
    f.client.rpc = { anchor: { number: 12345, hash: `0x${'a'.repeat(64)}` } };
}

test('protected live entry persists canonical before evidence at entry_reserved before preparing the order', async t => {
    const f = entryFixture(t); enableLossProtection(f);
    const expected = { schema: 1, activationId: lossProtectionActivationId(f.state.profitTakingControl.lossProtection),
        before: { balance: 20, blockNumber: 12345, blockHash: `0x${'a'.repeat(64)}`, checkedAt: start + 1477,
            walletCashDelta: 0, externalCashDelta: 0, totalDeposited: 0, totalTokenDebited: 0 } };
    let durableReservation;
    const originalEvent = f.engine.store.event;
    t.mock.method(f.engine.store, 'event', function(type, detail) {
        if (type === 'entry_reserved') {
            assert.equal(f.client.prepare.mock.callCount(), 0);
            assert.equal(f.client.post.mock.callCount(), 0);
            assert.deepEqual(f.state.position.entrySignal.lossProtection, expected);
        }
        originalEvent.call(this, type, detail);
        if (type === 'entry_reserved') durableReservation = f.persisted.at(-1).state;
    });
    await runEntry(t, f);
    assert.deepEqual(durableReservation.position.entrySignal.lossProtection, expected);
    assert.equal(durableReservation.position.openedAt, start + 2952);
    assert.equal(f.client.post.mock.callCount(), 1);
    f.state.ai.snapshots[0].wallet.balance = 0;
    assert.deepEqual(f.state.position.entrySignal.lossProtection, expected,
        'persisted evidence must not alias the transient wallet witness');
});

test('protected entry refuses incomplete or inexact wallet evidence before any reservation or order', async t => {
    const cases = [
        { name: 'no canonical hash', mutate: f => { delete f.client.rpc; } },
        { name: 'anchor belongs to another block', mutate: f => { f.client.rpc.anchor.number--; } },
        { name: 'sub-microunit wallet difference', options: { balance: 20.0000001 } },
        { name: 'no activation marker', mutate: f => { delete f.state.profitTakingControl.lossProtection; } },
        { name: 'read predates activation', mutate: f => { f.state.profitTakingControl.lossProtection.activatedAt = start + 1478; } },
    ];
    for (const row of cases) await t.test(row.name, async t => {
        const f = entryFixture(t, row.options); enableLossProtection(f); row.mutate?.(f);
        await runEntry(t, f);
        assert.equal(f.state.position, null); assert.deepEqual(f.state.seen, {});
        assert.equal(f.client.prepare.mock.callCount(), 0); assert.equal(f.client.post.mock.callCount(), 0);
        assert.ok(f.events.every(event => event.type !== 'entry_reserved'));
        assert.equal(f.state.ai.snapshots[0].entryDisposition, 'loss_wallet_evidence_unavailable');
    });
});

test('live provider uses locally measured response timing before durable drain logging and ignores remote timestamps', async t => {
    for (const latencyMs of [2984, 3001]) await t.test(`${latencyMs}ms response plus 50ms drain`, async t => {
        let now = start;
        t.mock.method(Date, 'now', () => now);
        t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_provider_fixture'); });
        const state = { laya: { tokenizerIdentity: 'fixture-tokenizer' } }, events = [];
        const provider = new LayaLiveProvider({ layaUrl: 'http://offline-fixture', decisionMs: 3000, layaDrainMs: 10000 },
            state, (type, detail) => {
                events.push({ type, detail, at: now });
                if (type === 'provider_drained') now += 50;
            }, {
                counter: { async count() { return { valid: true, identity: 'fixture-tokenizer' }; }, close() {} },
                fetch: t.mock.fn(async (url, options) => {
                    assert.equal(url, 'http://offline-fixture/v1/systemone'); assert.equal(options.method, 'POST');
                    return { ok: true, async json() {
                        now += latencyMs;
                        return { model: 'typed-decisions', answers: { action: { choice: 'BUY_UP' } },
                            requestedAt: start - 999999, receivedAt: start + 1, latencyMs: 1 };
                    } };
                }),
            });
        t.after(() => provider.close());
        const snapshot = { snapshotId: 'local-timing-fixture', at: start - 40, observedAt: start - 1269, input: '{}' };
        const decision = await provider.predict('laya', snapshot);
        assert.equal(now - start, latencyMs + 50); assert.ok(now - start > 3000);
        assert.equal(decision.status, 'ok'); assert.equal(decision.latencyMs, latencyMs);
        assert.equal(decision.requestedAt, start); assert.equal(decision.receivedAt, start + latencyMs);
        assert.equal(events.find(event => event.type === 'provider_drained').at, start + latencyMs);
        assert.equal(state.laya.pending, null); assert.equal(provider.active.size, 0);
        const timed = { ...snapshot, decisionRequestedAt: decision.requestedAt, decisionReceivedAt: decision.receivedAt };
        const config = { ai: { decisionMs: 3000, dataAgeMs: 5000 } };
        if (latencyMs <= 3000) assert.doesNotThrow(() => assertDecisionTiming(timed, config, now));
        else assert.throws(() => assertDecisionTiming(timed, config, now), /late_laya_response/);
    });
});
