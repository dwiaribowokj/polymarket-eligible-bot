import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { BASELINE, loadSettings } from '../../src/restart/config.js';
import { metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { buildProtocolRequest, parseProtocolResponse } from '../../src/laya-tuning/protocol.js';
import { loadLiveConfig, liveConfigView } from '../../src/laya-live/config.js';
import { decisionProtocolView } from '../../src/laya-live/decision-protocol.js';
import { entryGuard, LayaLiveEngine } from '../../src/laya-live/engine.js';

const START = Date.parse('2026-10-16T00:04:00Z');
const hash = value => createHash('sha256').update(value).digest('hex');
const metadataKeys = ['protocolVersion', 'variantId', 'promptVersion', 'promptHash', 'questionsHash'];

function configFixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-tuned-integration-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = { RESTART_DATA_DIR: dataDir,
        POLYGON_RPC_URL: 'https://primary.example.test/private-rpc-token',
        POLYGON_RPC_BACKUP_URL: 'https://backup.example.test/private-backup-token',
        PRIVATE_KEY: 'private-wallet-secret', PROXY_WALLET_ADDRESS: 'private-wallet-address',
        CLOB_API_KEY: 'private-clob-key', CLOB_API_SECRET: 'private-clob-secret',
        CLOB_API_PASSPHRASE: 'private-clob-passphrase', NINEROUTER_KEY: 'private-router-key',
        AI_SHADOW_LAYA_URL: 'http://private-laya.example.test',
        AI_SHADOW_ROUTER_DB: '/private/router-database', LAYA_PROFIT_TAKING_ENABLED: 'false' };
    return { env, config: loadLiveConfig(env) };
}

test('live config binds the exact candidate-v2 protocol and hashes its LIVE and tuning dependencies', t => {
    const { env, config } = configFixture(t);
    const input = JSON.stringify({ allowed: ['BUY_UP', 'SKIP'] });
    const protocol = buildProtocolRequest({ snapshotId: 'config-protocol-fixture', input, inputHash: hash(input) },
        { variantId: 'candidate-v2' });
    const expected = Object.fromEntries(metadataKeys.map(key => [key, protocol[key]]));
    assert.deepEqual(config.ai.decisionProtocol, expected);
    assert.deepEqual(decisionProtocolView(), expected);
    assert.equal(expected.variantId, 'candidate-v2');
    assert.equal(expected.promptVersion, 'allowed-actions-compact-v2');
    assert.equal(config.policy.controlBaseline, loadSettings(env, 'late-entry').fingerprint);
    assert.equal(config.settings.lateSignal.maxAgeMs, 5000);
    assert.equal(config.settings.lateSignal.lookbackSeconds, 180);
    const sources = new Map(config.sources);
    for (const file of ['src/laya-tuning/protocol.js', 'src/laya-tuning/counter.js',
        'src/laya-live/decision-protocol.js', 'src/laya-live/signal.js', 'scripts/laya-live.js'])
        assert.equal(sources.get(file), hash(fs.readFileSync(path.join(config.root, file))), file);
});

test('live config view publishes protocol identity and execution limits without credentials or private endpoints', t => {
    const { config, env } = configFixture(t), view = liveConfigView(config);
    assert.deepEqual(view.decisionProtocol, config.ai.decisionProtocol);
    assert.deepEqual(Object.keys(view.decisionProtocol).sort(), [...metadataKeys].sort());
    assert.equal(view.execution.orderType, 'FAK');
    assert.equal(view.execution.decisionMs, 3000);
    assert.equal(view.execution.dataAgeMs, 5000);
    assert.equal(view.execution.historyMs, 180000);
    assert.deepEqual(view.limits, { capital: null, entryCap: 5, shares: 5,
        drawdownStop: 10, pilotMarkets: null, pilotHours: null });
    const output = JSON.stringify(view);
    for (const [key, value] of Object.entries(env))
        if (key !== 'LAYA_PROFIT_TAKING_ENABLED') assert.equal(output.includes(value), false, key);
    assert.equal(Object.hasOwn(view, 'settings'), false);
    assert.equal(Object.hasOwn(view, 'ai'), false);
});

test('the live runner config command renders the tuned protocol without starting network work', async t => {
    const { env } = configFixture(t), originalEnv = process.env, output = [];
    process.env = { ...originalEnv, ...env };
    t.after(() => { process.env = originalEnv; });
    t.mock.method(dotenv, 'config', () => ({ parsed: {} }));
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_runner_config_fixture'); });
    t.mock.method(console, 'log', value => output.push(value));
    const { main } = await import('../../scripts/laya-live.js');
    await main(['config']);
    assert.equal(output.length, 1);
    const view = JSON.parse(output[0]);
    assert.deepEqual(view.decisionProtocol, decisionProtocolView());
    assert.equal(view.mode, 'live');
    assert.equal(view.guards.automaticActivation, false);
    assert.equal(fs.readdirSync(env.RESTART_DATA_DIR).length, 0);
    assert.equal(globalThis.fetch.mock.callCount(), 0);
});

function guardFixture() {
    const settings = { ...BASELINE, paperGasUsd: .05 }, protocol = decisionProtocolView();
    const config = { settings, ai: { decisionProtocol: protocol, decisionMs: 3000, dataAgeMs: 5000,
        capital: 20, shares: 5, entryCap: 5, gasUsd: .05,
        limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings } };
    const market = { slug: 'offline-market', conditionId: 'offline-condition', open: START - 240000,
        end: START + 60000, accepting: true, tokens: ['offline-up', 'offline-down'],
        minimum: 5, tick: .01, ticks: [.01, .01], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const spec = { index: 0, tokenId: market.tokens[0], price: .79, snapshotPrice: .78,
        shares: 5, side: 'BUY', kind: 'taker' };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: START - 3600000,
        walletStart: 20, walletCashDelta: 0, cash: 20, peakEquity: 20, maxDrawdown: 0,
        failures: 0, stopped: null, completed: [], seen: {}, position: null };
    const snapshot = { snapshotId: 'offline-snapshot', at: START - 2600, observedAt: START - 3000,
        decisionReceivedAt: START, decisionProtocol: { ...protocol },
        validation: { at: START - 2600, generation: 1, identity: metadataIdentity(market) }, allowed: [spec] };
    const decision = { ...protocol, snapshotId: snapshot.snapshotId, model: 'typed-decisions',
        action: 'BUY_UP', status: 'ok' };
    const books = [
        { bids: [{ price: .77, size: 10 }], asks: [{ price: .78, size: 10 }] },
        { bids: [{ price: .21, size: 10 }], asks: [{ price: .22, size: 10 }] },
    ];
    return { now: START, settings, config, market, spec, state, snapshot, decision, books };
}

test('live entry requires every configured protocol field in both the snapshot and decision', () => {
    const valid = guardFixture(), original = structuredClone(valid.spec);
    const execution = entryGuard(valid);
    assert.equal(execution.snapshotId, valid.snapshot.snapshotId);
    assert.equal(execution.limitPrice, original.price);
    assert.deepEqual(valid.spec, original);
    for (const target of ['snapshot', 'decision']) for (const key of metadataKeys) {
        for (const missing of [false, true]) {
            const f = guardFixture();
            const metadata = target === 'snapshot' ? f.snapshot.decisionProtocol : f.decision;
            if (missing) delete metadata[key];
            else metadata[key] = 'mismatched-protocol-field';
            assert.throws(() => entryGuard(f), { message: 'live_decision_protocol_mismatch' }, `${target}.${key}`);
        }
    }
    const absent = guardFixture(); delete absent.snapshot.decisionProtocol;
    assert.throws(() => entryGuard(absent), { message: 'live_decision_protocol_mismatch' });
});

test('a valid tuned decision retains original timing, budget, stop and immutable execution checks', () => {
    const cases = [
        ['stale_laya_input', f => { f.snapshot.observedAt = f.now - 5001; }],
        ['late_laya_response', f => { f.snapshot.at = f.now - 3001; f.snapshot.observedAt = f.now - 3500; }],
        ['invalid_laya_decision', f => { f.decision.model = 'other-model'; }],
        ['entry_metadata_changed', f => { f.market.minimum = 6; }],
        ['entry_specification_changed', f => { f.spec = { ...f.spec, price: .80 }; }],
        ['entry_budget_exceeded', f => { f.state.cash = 1; }],
        ['execution_limit_unmarketable', f => { f.books[0].asks[0].price = .80; f.books[0].bids[0].price = .79; }],
        ['pilot_stopped', f => { f.state.stopped = { reason: 'drawdown_limit', at: f.now }; }],
        ['pilot_deadline', f => { f.state.startedAt = f.now - 48 * 3600000; }],
        ['profit_withdrawal_pending', f => { f.state.profitTaking = { pending: { id: 'offline-withdrawal' } }; }],
    ];
    for (const [message, mutate] of cases) {
        const f = guardFixture(); mutate(f);
        assert.throws(() => entryGuard(f), { message });
    }
    const partial = guardFixture(); partial.books[0].asks[0].size = .25;
    assert.equal(entryGuard(partial).executableShares, .25);
    assert.equal(partial.spec.shares, 5);
    assert.equal(partial.spec.price, .79);
});

test('real live observation carries protocol and evaluation epoch through snapshot, events and reserved entry', async t => {
    let now = START;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_tuned_observe_fixture'); });
    const f = guardFixture(), protocol = decisionProtocolView(), epochId = 'offline-candidate-v2-epoch';
    f.config.policy = { aiSource: 'offline-tuned-source' };
    Object.assign(f.config.ai, { slots: [60], slotToleranceMs: 2000 });
    const observedAt = START - 1000;
    const rows = () => f.books.map((book, i) => ({ ...book, tokenId: f.market.tokens[i],
        conditionId: f.market.conditionId, tick: .01, timestamp: observedAt, fetchedAt: observedAt }));
    const stream = { generation: 1, tokens: [...f.market.tokens], snapshot: rows };
    const events = [], persisted = [], orderId = 'offline-tuned-order';
    const store = { state: f.state, save() { persisted.push(structuredClone(this.state)); },
        event(type, detail) { events.push({ type, detail }); this.save(); },
        stop(reason) { this.state.stopped ||= { reason, at: now }; this.save(); } };
    const client = { btc: { assess: () => ({ reason: null }) }, books: async () => rows(),
        marketInfo: async () => ({}), validateInfo() {}, tickSize: async () => .01,
        confirmedBlock: async () => 12345, balance: async () => 20, holdings: async () => [0, 0],
        warmOrderMetadata: t.mock.fn(async () => {}),
        prepare: t.mock.fn(async () => ({ orderId, signed: { fixtureOnly: true } })),
        post: t.mock.fn(async () => {
            const saved = persisted.at(-1).position;
            assert.deepEqual(saved.entrySignal.decisionProtocol, protocol);
            assert.equal(saved.entrySignal.evaluationEpochId, epochId);
            assert.equal(saved.orders[0].status, 'submitting');
            return { ok: true, orderId, tradeIds: [], transactionsHashes: [] };
        }) };
    const providers = { predict: t.mock.fn(async (name, snapshot) => {
        assert.equal(name, 'laya');
        assert.deepEqual(snapshot.decisionProtocol, protocol);
        assert.notStrictEqual(snapshot.decisionProtocol, f.config.ai.decisionProtocol);
        assert.equal(snapshot.evaluationEpochId, epochId);
        const request = buildProtocolRequest(snapshot, { variantId: 'candidate-v2' });
        await Promise.resolve(); now = START + 2500;
        return { ...parseProtocolResponse({ model: 'typed-decisions', answers: { action: { choice: 'BUY_UP',
            probabilities: { BUY_UP: .9, BUY_DOWN: .05, SKIP: .05 }, answer_confidence: .9 } } }, request),
            requestedAt: START, receivedAt: now, latencyMs: 2500 };
    }) };
    // Keep actual observation, input encoding, protocol parsing, wallet checks,
    // entry validation, reservation and submission. Replace history assembly.
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({ initial: rows(), timing: {},
        features: { observedAt, state: { seconds: 60, opening_twap: 83000, spot: 83020, twap: 83020,
            margin_usd: 20, volatility_usd_sqrt_s: 1, returns_bps_5_15_30_60_180: [1, 1, 1, 1, 1],
            bars_30s_OHLC_oldest_first: Array.from({ length: 6 }, () => [83000, 83020, 83000, 83020]),
            books_up_down: rows().map(book => ({ bids: book.bids.map(row => [row.price, row.size]),
                asks: book.asks.map(row => [row.price, row.size]) })),
            fee_rate: .07, fee_exponent: 1, shares: 5, entry_cap: 5 } } }));
    const engine = new LayaLiveEngine(f.config, store, client, stream, providers);
    t.mock.method(engine.clockGate, 'fresh', () => true);
    const key = `${f.market.slug}:60`;
    engine.ai.currentEvaluationEpochId = epochId;
    engine.ai.slots[key] = { status: 'reserved' };
    await engine.observe(f.market, 60, key);
    const snapshot = f.state.ai.snapshots[0], signal = f.state.position.entrySignal;
    assert.deepEqual(snapshot.decisionProtocol, protocol);
    assert.equal(snapshot.evaluationEpochId, epochId);
    assert.equal(snapshot.decision.variantId, 'candidate-v2');
    assert.equal(snapshot.entryDisposition, 'order_accepted');
    assert.deepEqual(signal.decisionProtocol, protocol);
    assert.equal(signal.evaluationEpochId, epochId);
    assert.equal(signal.snapshotId, snapshot.snapshotId);
    assert.equal(signal.inputHash, snapshot.inputHash);
    for (const type of ['laya_snapshot', 'laya_decision']) {
        const event = events.find(row => row.type === type);
        assert.equal(event.detail.evaluationEpochId, epochId);
        if (type === 'laya_snapshot') assert.deepEqual(event.detail.decisionProtocol, protocol);
        else for (const key of metadataKeys) assert.equal(event.detail[key], protocol[key]);
    }
    assert.equal(providers.predict.mock.callCount(), 1);
    assert.equal(client.prepare.mock.callCount(), 1);
    assert.equal(client.post.mock.callCount(), 1);
    assert.equal(f.state.position.orders[0].price, .79);
    assert.equal(f.state.position.orders[0].shares, 5);
    assert.equal(f.state.stopped, null);
});
