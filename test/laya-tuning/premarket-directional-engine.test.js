import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadPremarketPaperConfig, FAIR_PREMARKET_ARMS } from '../../src/premarket-paper/config.js';
import { NEXT_PROFILE, NEXT_PREMARKET_PROMPT } from '../../src/premarket-paper/early-context.js';
import { PremarketProviders } from '../../src/premarket-paper/providers.js';
import { PremarketPaperEngine } from '../../src/premarket-paper/engine.js';
import { PremarketPaperStore } from '../../src/premarket-paper/store.js';
import { readEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY, routerDirectionalPromptEvidence } from '../../src/premarket-paper/router-directional.js';

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, { noSignal = false, ask = .5, minimum = 5, opposing = false, deferred = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-directional-engine-'));
    const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: NEXT_PROFILE,
        PREMARKET_ROUTER_POLICY: NEXT_ROUTER_DIRECTIONAL_POLICY }, directory);
    const open = Date.parse('2026-10-28T10:25:00Z'), scheduledAt = open + 5000;
    let now = scheduledAt, previousClose = 83000, finishRouter, markRouterStarted;
    const routerStarted = new Promise(resolve => { markRouterStarted = resolve; });
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: open - 9000000, windowEnd: open, expectedLatestClosedAt: open,
        observedAt: scheduledAt - 1000, fetchedAt: scheduledAt - 1000,
        bars: Array.from({ length: 30 }, (_, i) => {
            const first = previousClose, last = first + (i >= 26 && i <= 28 ? 20 : i === 29 && !noSignal ? -10 : 0);
            previousClose = last;
            return { openAt: open - (30 - i) * 300000, closeAt: open - (29 - i) * 300000,
                open: first, high: Math.max(first, last) + 1, low: Math.min(first, last) - 1,
                close: last, observedAt: scheduledAt - 1000 };
        }) };
    const market = { slug: `btc-updown-5m-${open / 1000}`, conditionId: 'condition', open, end: open + 300000,
        minimum, tick: .01, ticks: [.01, .01], accepting: true, negRisk: false, tokens: ['up', 'down'],
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const books = () => market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        timestamp: now, fetchedAt: now, bids: [{ price: ask - .01, size: 10 }], asks: [{ price: ask, size: 10 }] }));
    const store = new PremarketPaperStore(config, now), events = [], requests = [];
    store.event = (type, detail = {}) => { events.push({ type, ...structuredClone(detail) }); store.save(); };
    const providers = new PremarketProviders(config, store.state.providers, (type, detail) => store.event(type, detail), {
        clock: () => now, counter: { start: async () => ({ identity: 'directional-engine-tokenizer', maxTokens: 1024 }),
            count: async () => ({ valid: true, tokens: 800, identity: 'directional-engine-tokenizer' }), close() {} },
        fetch: async (url, init = {}) => {
            if (init.method !== 'POST') return Response.json(url.endsWith('/health') ? { loaded: ['typed-decisions'] }
                : { data: [{ id: config.routerModel, owned_by: 'cx' }] });
            const request = JSON.parse(init.body), name = url.endsWith('/v1/systemone') ? 'laya' : 'router';
            requests.push({ name, request });
            if (name === 'laya') return Response.json({ model: 'typed-decisions', answers: { action: {
                choice: 'BUY_DOWN', probabilities: { BUY_UP: .1, BUY_DOWN: .6, SKIP: .3 } } }, usage: { input_tokens: 800 } });
            const snapshotId = request.messages[1].content.split('\n')[0].slice('snapshotId='.length);
            const raw = { model: 'gpt-6.1-sol', choices: [{ finish_reason: 'stop', message: { role: 'assistant',
                content: JSON.stringify({ snapshotId, forecastDirection: opposing ? 'UP' : 'DOWN', forecastStrength: 'moderate',
                    action: opposing ? 'SKIP' : 'BUY_DOWN',
                    reasonCode: opposing ? 'direction_opposes_signal' : 'direction_matches_signal',
                    rationale: opposing ? 'Three $20 rising bodies outweigh the final $10 decline.'
                        : 'The last $10 falling body reverses three $20 rising bodies; wicks are $1.' }) } }] };
            if (deferred) return new Promise(resolve => { finishRouter = () => resolve(Response.json(raw)); markRouterStarted(); });
            markRouterStarted(); return Response.json(raw);
        } });
    const client = { btc: { status() { assert.fail('live history must not be required'); } },
        startBtcFeed() { assert.fail('live feed must not start'); }, close() {}, serverTime: async () => now,
        market: async () => structuredClone(market), books: async () => books(), payout: async () => null };
    const bookReader = (expected, options) => readEarlyPaperBooks(expected, { ...options, fetchImpl: async input => {
        const url = new URL(input);
        const body = url.pathname === '/book' ? { market: market.conditionId, asset_id: url.searchParams.get('token_id'),
            min_order_size: String(minimum), tick_size: '.01', neg_risk: false, timestamp: String(scheduledAt - 120000), hash: 'a'.repeat(40),
            bids: [{ price: String(ask - .01), size: '10' }], asks: [{ price: String(ask), size: '10' }] }
            : { minimum_tick_size: .01 };
        return Response.json(body, { headers: { Date: new Date(now).toUTCString(), 'CF-Cache-Status': 'DYNAMIC' } });
    } });
    const engine = new PremarketPaperEngine(config, store, client, { clock: () => now, providers,
        candleReader: () => structuredClone(history), bookReader, sleep: async ms => { now += ms; } });
    engine.clockValid = true; engine.clockVerifiedAt = now; engine.clockRetryAt = now + 20000;
    engine.markets.set(market.slug, market); engine.discover = async () => {};
    const key = `${market.slug}:premarket`;
    store.state.slots[key] = { scheduledAt, status: 'reserved' };
    store.state.markets[market.slug] = { slug: market.slug, open, end: market.end, enrolledAt: now, conditionId: market.conditionId };
    t.after(async () => {
        finishRouter?.(); await providers.drain(1000); await engine.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { config, store, engine, market, scheduledAt, events, requests, providers, routerStarted,
        advance(ms) { now += ms; engine.clockVerifiedAt = now; }, finishRouter: () => finishRouter(),
        arm: name => store.state.arms[name], get snapshot() { return store.state.snapshots[0]; },
        async idle() { while (engine.tasks.size) await Promise.all([...engine.tasks]); },
        observe: () => engine.observePremarket(market.slug, scheduledAt, key) };
}

function assertOffered(row, config) {
    for (const [field, value] of Object.entries(routerDirectionalPromptEvidence(config)))
        assert.equal(row[`offered${field[0].toUpperCase()}${field.slice(1)}`], value);
}

function assertSubmitted(row, config) {
    for (const [field, value] of Object.entries(routerDirectionalPromptEvidence(config))) assert.equal(row[field], value);
}

for (const [reason, options] of [['signal_not_met', { noSignal: true }], ['entry_constraints_not_met', { minimum: 6 }]]) {
    test(`directional engine persists offered prompt metadata for ${reason} without calling AI`, async t => {
        const f = fixture(t, options); await f.observe(); await f.idle();
        const row = f.snapshot.decisions['router-premarket'];
        assert.equal(row.status, reason); assert.equal(row.action, 'SKIP');
        assert.equal(row.requestSubmitted, false); assert.equal(row.inferenceAttempted, false);
        assertOffered(row, f.config);
        assert.equal(row.providerTask, undefined); assert.equal(row.providerPromptVersion, undefined);
        assert.equal(row.providerPromptHash, undefined); assert.equal(f.requests.length, 0);
        assert.deepEqual(f.snapshot.commonInput.allowed, ['SKIP']);
        assert.equal(row.offeredInputHash, f.snapshot.commonInput.inputHash);
        assert.equal(row.offeredSemanticPromptHash, hash(NEXT_PREMARKET_PROMPT));
        assert.equal(f.snapshot.decisions['laya-premarket'].offeredProviderTask, undefined);
        const persisted = JSON.parse(fs.readFileSync(f.store.filename, 'utf8')).snapshots[0].decisions['router-premarket'];
        assertOffered(persisted, f.config); assert.equal(persisted.requestSubmitted, false);
        f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
        for (const name of FAIR_PREMARKET_ARMS) {
            assert.equal(f.arm(name).cash, 20); assert.deepEqual(f.arm(name).positions, {});
        }
    });
}

test('actual directional provider response and both prompt identities persist through bounded paper execution', async t => {
    const f = fixture(t); await f.observe(); await f.idle();
    const row = f.snapshot.decisions['router-premarket'];
    assert.equal(row.status, 'ok'); assert.equal(row.action, 'BUY_DOWN');
    assert.equal(row.forecastDirection, 'DOWN'); assert.equal(row.forecastStrength, 'moderate');
    assert.equal(row.forecastStrengthType, 'directional_not_calibrated');
    assert.deepEqual(row.expectedNetUsd, { BUY_UP: null, BUY_DOWN: null });
    assert.equal(row.estimatedUpProbability, null); assertOffered(row, f.config); assertSubmitted(row, f.config);
    assert.equal(row.semanticPromptHash, hash(NEXT_PREMARKET_PROMPT));
    assert.equal(row.entryDisposition, 'awaiting_shared_cutoff');
    const router = f.requests.find(request => request.name === 'router').request;
    const laya = f.requests.find(request => request.name === 'laya').request;
    assert.equal(router.messages[1].content, laya.state);
    assert.equal(row.providerPromptHash, hash(router.messages[0].content));
    const event = f.events.find(event => event.type === 'provider_decision' && event.arm === 'router-premarket');
    assertOffered(event, f.config); assertSubmitted(event, f.config);
    const persisted = JSON.parse(fs.readFileSync(f.store.filename, 'utf8')).snapshots[0].decisions['router-premarket'];
    assertOffered(persisted, f.config); assertSubmitted(persisted, f.config);
    assert.equal(f.snapshot.aiDeadlineAt, f.scheduledAt + 30000);
    assert.equal(f.snapshot.fairExecution.deadlineAt, f.snapshot.aiDeadlineAt + 30000);
    assert.equal(f.engine.decisionDeadline(f.market.open + 80000, f.market), f.market.open + 90000);
    assert.equal(f.engine.readinessDeadline(f.market.open + 80000, f.market), f.market.open + 90000);
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.advance(250); f.engine.executePending(); await f.idle();
    const position = f.arm('router-premarket').positions[f.market.slug];
    assert.equal(position.status, 'matched'); assert.equal(position.order.index, 1);
    assert(position.executionAt >= f.market.open && position.executionAt < f.market.open + 90000);
    assert.equal(f.events.filter(event => event.type === 'fill_matched' && event.arm === 'router-premarket').length, 1);
});

test('actual opposing forecast remains SKIP with offered and submitted prompt evidence and no exposure', async t => {
    const f = fixture(t, { opposing: true }); await f.observe(); await f.idle();
    const row = f.snapshot.decisions['router-premarket'];
    assert.equal(row.status, 'ok'); assert.equal(row.action, 'SKIP'); assert.equal(row.forecastDirection, 'UP');
    assert.equal(row.reasonCode, 'direction_opposes_signal'); assert.equal(row.entryDisposition, 'provider_skip');
    assertOffered(row, f.config); assertSubmitted(row, f.config);
    f.advance(30000); f.engine.scheduleFairExecutions(); await f.idle();
    f.advance(250); f.engine.executePending(); await f.idle();
    assert.equal(f.arm('router-premarket').cash, 20); assert.deepEqual(f.arm('router-premarket').positions, {});
    assert.equal(f.arm('premarket-momentum').positions[f.market.slug].status, 'matched');
});

test('late directional response retains provenance but cannot enter after the original AI deadline', async t => {
    const f = fixture(t, { deferred: true }); await f.observe(); await f.routerStarted;
    assertOffered(f.snapshot.decisions['router-premarket'], f.config);
    f.advance(30001); f.finishRouter(); await f.idle();
    const row = f.snapshot.decisions['router-premarket'];
    assert.equal(row.status, 'decision_timeout'); assert.equal(row.action, 'SKIP');
    assert.equal(row.originalAction, 'BUY_DOWN'); assert.equal(row.forecastDirection, 'DOWN');
    assert.equal(row.entryDisposition, 'provider_late'); assertOffered(row, f.config); assertSubmitted(row, f.config);
    f.engine.scheduleFairExecutions(); await f.idle();
    f.advance(250); f.engine.executePending(); await f.idle();
    assert.equal(f.arm('router-premarket').cash, 20); assert.deepEqual(f.arm('router-premarket').positions, {});
    assert.equal(f.arm('router-premarket').outcomes[f.market.slug].reason, 'provider_late');
    assert.equal(f.events.some(event => event.type === 'fill_matched' && event.arm === 'router-premarket'), false);
    assert.equal(f.requests.filter(request => request.name === 'router').length, 1);
});
