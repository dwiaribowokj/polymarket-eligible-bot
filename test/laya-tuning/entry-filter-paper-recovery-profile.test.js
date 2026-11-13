import test from 'node:test';
import assert from 'node:assert/strict';
import { BtcSignal } from '../../src/restart/signal.js';
import { EntryFilterPaperEngine } from '../../src/entry-filter-paper/engine.js';
import { loadEntryFilterPaperConfig, LIVE_TUNING_PROFILE, LIVE_TUNING_RECOVERY_PROFILE,
    LIVE_COST_CAP_PROFILE, LIVE_COST_CAP_ARMS } from '../../src/entry-filter-paper/config.js';
import { readEntryFilterRestBooks } from '../../src/entry-filter-paper/book-source.js';
import { parseArgs, smoke } from '../../scripts/entry-filter-paper.js';

async function fixture({ seconds = 90, profile = LIVE_TUNING_RECOVERY_PROFILE } = {}) {
    const config = loadEntryFilterPaperConfig({}, '/tmp/entry-tuning-recovery-memory-only', profile);
    const open = Date.parse('2026-10-20T00:00:00Z');
    let now = open + (300 - seconds) * 1000, ask = .78, websocket = false, sourceAge = 0;
    let cacheStatus = 'DYNAMIC', metadataValid = true, afterRead = null, payout = null;
    const btc = new BtcSignal(config.control.lateSignal);
    for (let at = now - 185000; at <= now; at += 1000)
        btc.ingest({ topic: 'prices.crypto', type: 'update', payload: {
            symbol: 'btcusd', timestamp: at, value: 83020 + Math.sin(at / 1000) * .1 } }, at);
    btc.ingest({ topic: 'prices.crypto.twap', type: 'update', payload: {
        symbol: 'btcusd', timestamp: now, value: 83020, windowSeconds: 60 } }, now);
    btc.openings.set(open, { at: open, value: 83000, receivedAt: open + 100 });
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum: 5, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true }, reference: { source: 'chainlink_twap_60s',
            open, end: open + 300000, value: 83000, observedAt: open, receivedAt: open + 100 } };
    const getBooks = () => market.tokens.map((tokenId, index) => ({ tokenId, conditionId: market.conditionId,
        tick: .01, timestamp: now - sourceAge, fetchedAt: now,
        bids: [{ price: (index === 0 ? ask : .22) - .01, size: 10 }],
        asks: [{ price: index === 0 ? ask : .22, size: 10 }] }));
    const books = { generation: 1, tokens: market.tokens, socket: { readyState: 1 },
        snapshot: () => websocket ? getBooks() : null, watch() {}, close() {} };
    const events = [], reads = [], requests = [], infoCalls = [];
    const state = { id: config.id, startedAt: now, frozenAt: null, providers: {}, slots: {}, snapshots: [],
        markets: {}, errors: {}, arms: Object.fromEntries(config.armNames.map(name => [name, {
            cash: 20, peak: 20, drawdown: 0, shadowStop: null, stopped: null,
            seen: {}, position: null, completed: [], outcomes: {} }])) };
    const store = { state, save() {}, freeze() {}, event(type, detail) { events.push({ type, detail }); },
        eventBatch(rows) { events.push(...structuredClone(rows)); },
        error(stage, error) { state.errors[`${stage}:${error.message}`] = true; } };
    const client = { btc, books: async () => getBooks(), payout: async () => payout,
        marketInfo: async value => { infoCalls.push(value); return { fee: { ...value.fee, rate: metadataValid ? .07 : .08 } }; },
        validateInfo(value, info) { if (value.fee.rate !== info.fee.rate) throw new Error('metadata_mismatch'); },
        serverTime: async () => now, startBtcFeed() {}, close() {} };
    const fetchImpl = async input => {
        const url = new URL(input), token = url.searchParams.get('token_id');
        requests.push(url.pathname);
        const book = getBooks().find(row => row.tokenId === token);
        const body = url.pathname === '/tick-size' ? { minimum_tick_size: .01 } : {
            market: market.conditionId, asset_id: token, min_order_size: '5', tick_size: '.01',
            neg_risk: false, timestamp: String(book.timestamp), hash: 'a'.repeat(40), bids: book.bids, asks: book.asks };
        return new Response(JSON.stringify(body), { headers: { Date: new Date(now).toUTCString(),
            'CF-Cache-Status': cacheStatus } });
    };
    const engine = new EntryFilterPaperEngine(config, store, client, books, undefined, {
        clock: () => now, sleep: async ms => { now += ms; },
        readRestBooks: async (value, options) => {
            reads.push({ at: now, deadlineAt: options.deadlineAt });
            const pair = await readEntryFilterRestBooks(value, { ...options, fetchImpl });
            afterRead?.(pair, value); return pair;
        } });
    await engine.verifyClock();
    return { config, market, books, client, engine, state, events, reads, requests, infoCalls,
        get now() { return now; }, advance(ms) { now += ms; }, price(value) { ask = value; },
        websocket(value) { websocket = value; }, sourceAge(value) { sourceAge = value; },
        cacheStatus(value) { cacheStatus = value; }, metadataValid(value) { metadataValid = value; },
        afterRead(callback) { afterRead = callback; }, payout(value) { payout = value; },
        observe() { return engine.observe(market, seconds, `${market.slug}:${seconds}`); } };
}

test('recovery profile freezes the original hypotheses and adds an independent seven-day evaluation policy', () => {
    const v1 = loadEntryFilterPaperConfig({}, '/tmp/tuning-v1', LIVE_TUNING_PROFILE);
    const v2 = loadEntryFilterPaperConfig({}, '/tmp/tuning-v2', LIVE_TUNING_RECOVERY_PROFILE);
    for (const key of ['armNames', 'baselineArm', 'slots', 'snapshotAgeTargetMs', 'snapshotSlotReserveMs',
        'latencyMs', 'costCapPerShare', 'capital', 'shares', 'drawdownStop', 'shadowDrawdownStop', 'armPolicies'])
        assert.deepEqual(v2[key], v1[key], key);
    assert.equal(v1.executionBook, 'validated-websocket');
    assert.equal(v1.observationPolicy.restFallback, 'none');
    assert.equal(v1.passiveCollection, undefined);
    assert.equal(v2.executionBook, 'validated-websocket-or-fresh-rest');
    assert.equal(v2.passiveCollection.enabled, true);
    assert.equal(v2.evaluationPolicy.durationMs, 7 * 86400000);
    assert.equal(v2.evaluationPolicy.minCompletedFillsPerArm, 100);
    assert.equal(v2.evaluationPolicy.minObservedDays, 7);
    assert.equal(v2.evaluationPolicy.holdout, 'next-independent-seven-day-period');
    assert.equal(v2.evaluationPolicy.promotion, 'manual-review-only');
    assert.equal(v2.deadline, Number.MAX_SAFE_INTEGER);
    assert.notEqual(v1.id, v2.id);
    for (const command of ['run', 'preflight'])
        assert.equal(parseArgs([command, '--out=/tmp/tuning', '--profile=live-tuning-v2']).profile, LIVE_TUNING_RECOVERY_PROFILE);
    for (const flags of [['report', '--profile=live-tuning-v2'], ['run', '--profile=live-tuning-v3'],
        ['run', '--profile=live-tuning-v1', '--profile=live-tuning-v2']])
        assert.throws(() => parseArgs([...flags, '--out=/tmp/tuning']), /invalid_entry_filter_profile/);
});

test('cold websocket uses verified REST for observation and one shared execution with the same ask-drop veto', async () => {
    const f = await fixture(); await f.observe();
    const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.bookSource, 'rest');
    assert.equal(snapshot.validation.bookEvidence.authority, 'fresh_rest_full_snapshot');
    assert.equal(snapshot.informed, undefined);
    assert.equal(f.reads.length, 1);
    assert.ok(Object.values(f.state.arms).every(arm => arm.position?.status === 'pending'));
    f.price(.75); f.advance(250); await f.engine.manage();
    for (const name of ['cost-cap-control', 'cost-cap-90s']) {
        const position = f.state.arms[name].position;
        assert.equal(position.status, 'matched');
        assert.equal(position.fill.shares, 5);
        assert.equal(position.executionBookSource, 'rest');
    }
    assert.equal(f.state.arms['cost-cap-drop-2c'].position, null);
    assert.equal(f.state.arms['cost-cap-drop-2c'].outcomes[f.market.slug].code, 'entry_ask_drop_above_limit');
    assert.equal(snapshot.executionBatches.length, 1);
    assert.equal(snapshot.executionBatches[0].evidence.authority, 'fresh_rest_full_snapshot');
    assert.equal(f.reads.length, 2);
    assert.equal(f.infoCalls.length, 2);
    assert.equal(f.requests.filter(row => row === '/book').length, 4);
    assert.equal(f.requests.filter(row => row === '/tick-size').length, 4);
    assert.equal(f.state.bookRecovery.restSuccesses, 2);
});

test('healthy websocket remains preferred and recovery cannot raise an admitted frozen limit', async () => {
    const f = await fixture(); f.websocket(true); await f.observe();
    assert.equal(f.state.snapshots[0].bookSource, 'websocket');
    assert.equal(f.infoCalls.length, 1);
    assert.equal(f.reads.length, 0);
    f.websocket(false); f.books.generation++; f.price(.82); f.advance(250);
    await f.engine.manage();
    assert.equal(f.reads.length, 1);
    for (const arm of Object.values(f.state.arms)) {
        assert.equal(arm.position, null); assert.equal(arm.cash, 20);
        assert.equal(arm.outcomes[f.market.slug].code, 'fixed_limit_not_marketable');
    }
});

test('a stale websocket observation recovers only from independently fresh REST', async () => {
    const f = await fixture(); f.websocket(true);
    const snapshot = f.books.snapshot;
    f.books.snapshot = () => snapshot().map(book => ({ ...book, timestamp: f.now - 5001 }));
    await f.observe();
    assert.equal(f.reads.length, 1);
    assert.equal(f.state.snapshots[0].bookSource, 'rest');
    assert.ok(Object.values(f.state.arms).every(arm => arm.position?.status === 'pending'));
    assert.equal(f.state.snapshots[0].validation.bookEvidence.books[0].sourceAgeMs, 0);
});

test('REST availability cannot override the frozen all-in cost cap', async () => {
    const f = await fixture(); f.price(.84); await f.observe();
    for (const [name, arm] of Object.entries(f.state.arms)) {
        assert.equal(arm.position, null); assert.equal(arm.cash, 20);
        assert.equal(f.state.snapshots[0].decisions[name].filterReason, 'entry_cost_above_cap');
    }
});

test('tuning recovery retains 60-second and 30-second observations without the separate closing filter', async () => {
    for (const seconds of [60, 30]) {
        const f = await fixture({ seconds }); f.advance(400); await f.observe();
        const snapshot = f.state.snapshots[0];
        assert.equal(snapshot.informed, undefined);
        assert.equal(snapshot.decisions['cost-cap-90s'].filterReason, 'entry_slot_not_selected');
        assert.equal(f.state.arms['cost-cap-control'].position.status, 'pending');
        assert.equal(f.state.arms['cost-cap-drop-2c'].position.status, 'pending');
        assert.equal(snapshot.timing.waitMs, 0);
    }
});

test('recovery rejects stale, cached and changed-metadata observations before reserving any arm', async () => {
    for (const [change, reason] of [
        [f => f.sourceAge(5001), /execution_book_stale_or_future/],
        [f => f.cacheStatus('HIT'), /early_book_response_cached_or_stale/],
        [f => f.metadataValid(false), /metadata_mismatch/],
        [f => f.afterRead(pair => { pair.books[0].asks[0].size = 1000; }), /early_book_evidence_invalid/],
    ]) {
        const f = await fixture(); change(f);
        await assert.rejects(f.observe(), reason);
        assert.equal(f.state.snapshots.length, 0);
        assert.ok(Object.values(f.state.arms).every(arm => !arm.position && arm.cash === 20));
    }
});

test('recovery does not mask websocket identity failures', async () => {
    const f = await fixture(); f.websocket(true); f.books.tokens = ['other', 'down'];
    await assert.rejects(f.observe(), /execution_token_mismatch/);
    assert.equal(f.reads.length, 0);
    assert.ok(Object.values(f.state.arms).every(arm => !arm.position));
});

test('execution recovery fails closed for stale, invalid metadata and results past the original deadline', async () => {
    for (const [change, code] of [
        [f => f.sourceAge(5001), 'execution_book_stale_or_future'],
        [f => f.metadataValid(false), 'metadata_mismatch'],
        [f => f.afterRead(() => f.advance(5001)), 'execution_stale'],
    ]) {
        const f = await fixture(); f.websocket(true); await f.observe();
        const deadline = f.state.snapshots[0].timing.executionDeadlineAt;
        f.websocket(false); change(f); f.advance(250);
        await f.engine.manage(); await f.engine.manage();
        assert.equal(f.reads.length, 1);
        assert.equal(f.reads[0].deadlineAt, deadline);
        for (const arm of Object.values(f.state.arms)) {
            assert.equal(arm.position, null); assert.equal(arm.cash, 20);
            assert.equal(arm.outcomes[f.market.slug].code, code);
            assert.ok(arm.seen[f.market.slug]);
        }
    }
});

test('recovery metadata timeout cannot publish a late observation', async () => {
    const f = await fixture(); let resolveInfo;
    f.client.marketInfo = () => new Promise(resolve => { resolveInfo = resolve; });
    await assert.rejects(f.engine.recoverBooks(f.market, f.now + 20, 'observation'), /entry_rest_timeout/);
    resolveInfo({ fee: { ...f.market.fee } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.requests.length, 0);
    assert.equal(f.state.bookRecovery.restFailures, 1);
    assert.equal(f.state.bookRecovery.restSuccesses, 0);
});

test('v1 remains websocket-only while v2 smoke can pass verified REST without warmup', async () => {
    const legacy = await fixture({ profile: LIVE_TUNING_PROFILE });
    await assert.rejects(legacy.observe(), /execution_book_unavailable/);
    assert.equal(legacy.reads.length, 0);
    assert.equal(legacy.engine.collectWithoutAvailableArms(), false);
    const f = await fixture();
    f.client.market = async () => f.market; f.client.btcStatus = () => ({ ready: true });
    const result = await smoke(f.config, f.client, () => f.books, {
        clock: () => f.now, sleep: async () => { throw new Error('websocket_wait_not_required'); },
        readRestBooks: async (market, options) => f.engine.readRestBooks(market, options) });
    assert.equal(result.restReady, true); assert.equal(result.websocketReady, false);
    assert.equal(result.executionSourceReady, true);
    assert.equal(result.warmupRequiredBeforeEntry, true);
    assert.equal(result.websocketWarmupRequiredBeforeEntry, false);
    assert.equal(result.btcHistoryRequiredMs, 180000);
    assert.equal(result.transactionsSubmitted, false);
});

test('cost-cap comparison freezes two caps with the same execution, capital and evaluation policy', () => {
    const previous = loadEntryFilterPaperConfig({}, '/tmp/tuning-v2', LIVE_TUNING_RECOVERY_PROFILE);
    const config = loadEntryFilterPaperConfig({}, '/tmp/cost-cap-comparison', LIVE_COST_CAP_PROFILE);
    assert.deepEqual(config.armNames, LIVE_COST_CAP_ARMS);
    assert.equal(config.baselineArm, 'cost-cap-control');
    assert.deepEqual(config.armCostCaps, { 'cost-cap-control': .85, 'cost-cap-082': .82 });
    for (const key of ['capital', 'shares', 'entryCap', 'slots', 'gasUsd', 'latencyMs', 'settlementMs',
        'dataAgeMs', 'snapshotAgeTargetMs', 'snapshotSlotReserveMs', 'executionPolicy', 'executionBook',
        'limitSlippageTicks', 'limitSlippageUsd', 'drawdownStop', 'shadowDrawdownStop',
        'observationPolicy', 'passiveCollection', 'evaluationPolicy'])
        assert.deepEqual(config[key], previous[key], key);
    assert.equal(config.tuningPolicy.admissionVetoConsumesMarketAttempt, false);
    assert.equal(config.tuningPolicy.reservedOrderConsumesMarketAttempt, true);
    assert.equal(config.tuningPolicy.promotion, 'manual-review-only');
    assert.equal(config.tuningPolicy.selectedSlotSeconds, undefined);
    assert.equal(config.tuningPolicy.maxAskDropUsd, undefined);
    assert.notEqual(config.id, previous.id);
    for (const command of ['preflight', 'run'])
        assert.equal(parseArgs([command, '--profile=live-cost-cap-v1', '--out=/tmp/cost-cap']).profile,
            LIVE_COST_CAP_PROFILE);
});

test('both cost-cap arms use the same verified execution book, fill, fees and gas', async () => {
    const f = await fixture({ profile: LIVE_COST_CAP_PROFILE }); await f.observe();
    const snapshot = f.state.snapshots[0];
    assert.equal(snapshot.informed, undefined);
    assert.deepEqual(Object.keys(snapshot.decisions), LIVE_COST_CAP_ARMS);
    for (const name of LIVE_COST_CAP_ARMS) {
        assert.equal(snapshot.decisions[name].entryDisposition, 'reserved');
        assert.equal(snapshot.filterVerdicts.BUY_UP[name].metrics.costCapPerShare, f.config.armCostCaps[name]);
    }
    f.price(.75); f.advance(250); await f.engine.manage();
    const control = f.state.arms['cost-cap-control'].position;
    const candidate = f.state.arms['cost-cap-082'].position;
    assert.equal(control.status, 'matched');
    assert.equal(control.fill.shares, 5);
    for (const key of ['snapshotId', 'order', 'fill', 'status', 'executionAt', 'executionBookHash',
        'executionCohortId', 'executionBookSource', 'settleAt'])
        assert.deepEqual(candidate[key], control[key], key);
    assert.equal(snapshot.executionBatches.length, 1);
    assert.deepEqual(snapshot.executionBatches[0].armNames, LIVE_COST_CAP_ARMS);
    assert.equal(f.reads.length, 2);
    assert.equal(f.infoCalls.length, 2);
    f.advance(f.config.settlementMs); await f.engine.manage();
    assert.equal(control.status, 'filled');
    assert.ok(control.entryCost > 0 && control.fees > 0);
    for (const key of ['entryCost', 'fees', 'gas', 'holdings']) assert.equal(candidate[key], control[key], key);
    assert.equal(f.state.arms['cost-cap-082'].cash, f.state.arms['cost-cap-control'].cash);
    f.advance(f.market.end - f.now + 1000); f.payout([1, 0]); await f.engine.manage();
    const settled = f.state.arms['cost-cap-control'].completed[0];
    assert.equal(settled.gas, f.config.gasUsd);
    assert.deepEqual(f.state.arms['cost-cap-082'].completed, [settled]);
});

test('the lower cap rejects full-fill cost including fees and gas but preserves later-slot eligibility', async () => {
    const f = await fixture({ profile: LIVE_COST_CAP_PROFILE });
    // The ask and limit are below .82, but total cost exceeds .82 after fees and gas.
    f.price(.79); await f.observe();
    const snapshot = f.state.snapshots[0], verdict = snapshot.filterVerdicts.BUY_UP;
    assert.ok(snapshot.allowed[0].price < .82);
    assert.ok(verdict['cost-cap-082'].metrics.breakEvenProbability > .82);
    assert.equal(f.state.arms['cost-cap-control'].position.status, 'pending');
    assert.equal(f.state.arms['cost-cap-082'].position, null);
    assert.equal(snapshot.decisions['cost-cap-082'].filterReason, 'entry_cost_above_cap');
    assert.equal(f.state.arms['cost-cap-082'].seen[f.market.slug], undefined);
    assert.equal(f.engine.available('cost-cap-082', f.market.slug), true);
    assert.equal(f.engine.available('cost-cap-control', f.market.slug), false);
    f.advance(250); await f.engine.manage();
    assert.equal(f.state.arms['cost-cap-control'].position.status, 'matched');
    assert.equal(f.state.arms['cost-cap-082'].cash, 20);
    assert.deepEqual(snapshot.executionBatches[0].armNames, ['cost-cap-control']);
});

test('cost-cap comparison retains all three slots and fails closed for invalid policy or metadata', async () => {
    for (const seconds of [90, 60, 30]) {
        const f = await fixture({ profile: LIVE_COST_CAP_PROFILE, seconds }); await f.observe();
        assert.ok(Object.values(f.state.arms).every(arm => arm.position?.status === 'pending'));
    }
    const invalid = await fixture({ profile: LIVE_COST_CAP_PROFILE });
    delete invalid.config.armCostCaps['cost-cap-082']; await invalid.observe();
    assert.equal(invalid.state.arms['cost-cap-082'].position, null);
    assert.equal(invalid.state.snapshots[0].decisions['cost-cap-082'].filterReason, 'entry_cost_policy_invalid');
    const metadata = await fixture({ profile: LIVE_COST_CAP_PROFILE }); metadata.metadataValid(false);
    await assert.rejects(metadata.observe(), /metadata_mismatch/);
    assert.equal(metadata.state.snapshots.length, 0);
    assert.ok(Object.values(metadata.state.arms).every(arm => arm.position === null));
});

test('cost-cap comparison keeps stopped arms stopped while collecting diagnostic snapshots', async () => {
    const f = await fixture({ profile: LIVE_COST_CAP_PROFILE });
    for (const arm of Object.values(f.state.arms)) arm.stopped = { at: f.now, reason: 'drawdown_limit' };
    await f.observe();
    assert.equal(f.state.snapshots[0].collectionPhase, 'all_stopped');
    assert.equal(f.state.snapshots[0].diagnosticOnly, true);
    assert.equal(f.state.snapshots[0].executionBatches.length, 0);
    assert.ok(Object.values(f.state.arms).every(arm => arm.stopped && arm.position === null && arm.cash === 20));
});
