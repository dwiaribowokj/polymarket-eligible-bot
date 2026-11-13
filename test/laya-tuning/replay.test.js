import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, quietGuard, selectSnapshots, replayPair, summarize } from '../../src/laya-tuning/replay.js';

const identity = 'tokenizer';
const counter = { start: async () => ({ identity, maxTokens: 1024 }),
    count: async () => ({ valid: true, tokens: 500, identity }) };
function snapshot(market = 'm1', allowed = ['BUY_UP'], at = 1) {
    const input = JSON.stringify({ seconds: 60, shares: 5, cap_usd: 5, allowed });
    return { market, at, snapshotId: market + at, input, inputHash: digest(input) };
}
function ready(now = 300_000 + 30_000) {
    return { now, expectedPid: 123, expectedTokenizer: identity,
        service: { ActiveState: 'active', SubState: 'running', MainPID: '123' },
        ledger: { stopped: null, position: null, lastTickAt: now - 100,
            ai: { providers: { laya: { tokenizerIdentity: identity, pending: null } } } } };
}
function setup(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-replay-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { uncertainFile: path.join(dir, 'uncertain.json'), expectedIdentity: identity,
        counter, guard: async () => ({ now: 330000 }), url: 'http://localhost:8090', persist: async () => {} };
}
const response = (choice = 'BUY_UP') => ({ ok: true, text: async () => JSON.stringify({ model: 'typed-decisions', usage: { input_tokens: 500 },
    answers: { action: { choice, probabilities: { BUY_UP: .5, BUY_DOWN: .3, SKIP: .2 },
        confidence: .1, answer_confidence: .5 } } }) });

test('quiet window leaves thirty-second HTTP drain and sixty-second margin before live slot', () => {
    for (const elapsed of [30_000, 120_000]) assert.equal(quietGuard(ready(300000 + elapsed)).elapsedMs, elapsed);
    for (const elapsed of [0, 29999, 120001, 210000, 270000, 299999])
        assert.throws(() => quietGuard(ready(300000 + elapsed)), /outside_quiet_window/);
});

test('service identity, heartbeat, position, stop and pending inference all block replay', () => {
    for (const change of [v => v.service.MainPID = 124, v => v.service.ActiveState = 'inactive',
        v => v.ledger.lastTickAt -= 15001, v => v.ledger.lastTickAt = v.now + 1,
        v => v.ledger.position = {}, v => v.ledger.stopped = 'drawdown_limit',
        v => v.ledger.ai.providers.laya.pending = {}, v => v.ledger.ai.providers.laya.disabled = 'unknown',
        v => v.ledger.ai.providers.laya.tokenizerIdentity = 'changed']) {
        const value = ready(); change(value); assert.throws(() => quietGuard(value), /tune_/);
    }
});

test('selection first-per-market balances allowed sides independently of outcome', () => {
    const source = [snapshot('down1', ['BUY_DOWN'], 1), snapshot('up1', ['BUY_UP'], 2),
        snapshot('down1', ['BUY_UP'], 3), snapshot('up2', ['BUY_UP'], 4), snapshot('down2', ['BUY_DOWN'], 5)];
    assert.deepEqual(selectSnapshots(source, 4).map(s => s.market), ['up1', 'down1', 'up2', 'down2']);
    assert.deepEqual(selectSnapshots(source, 2, new Set(['up2', 'down2'])).map(s => s.market), ['up2', 'down2']);
    assert.throws(() => selectSnapshots(source, 5), /insufficient_markets/);
    assert.throws(() => selectSnapshots(source, 0), /pair_count_invalid/);
});

test('replay sends identical input and only prompt differs; pending persisted before each POST', async t => {
    const options = setup(t), calls = [], saved = [];
    let time = 100;
    options.clock = () => time;
    options.fetch = async (_url, request) => {
        assert.equal(fs.existsSync(options.uncertainFile), true);
        calls.push(JSON.parse(request.body)); time += 2500; return response();
    };
    options.persist = async row => { saved.push(row); assert.equal(fs.existsSync(options.uncertainFile), true); };
    const s = { ...snapshot(), outcome: 'FUTURE_LABEL_NOT_SENT' };
    const result = await replayPair(s, options);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].state, calls[1].state);
    assert.equal(JSON.stringify(calls).includes('FUTURE_LABEL_NOT_SENT'), false);
    assert.notDeepEqual(calls[0].questions, calls[1].questions);
    assert.deepEqual(result.map(r => r.variantId), ['baseline-v1', 'candidate-v1']);
    assert.equal(result[0].timely, true);
    assert.equal(result[0].entropyConfidence, .1);
    assert.equal(saved.length, 2);
    assert.equal(fs.existsSync(options.uncertainFile), false);
    assert.equal(fs.statSync(path.dirname(options.uncertainFile)).mode & 0o077, 0);
});

test('alternates pair order and rechecks guard before second request', async t => {
    const options = setup(t); let checks = 0, calls = 0;
    options.guard = async () => { if (++checks === 2) throw new Error('tune_outside_quiet_window'); return {}; };
    options.fetch = async () => { calls++; return response(); };
    const rows = []; options.persist = async row => rows.push(row); options.pairIndex = 1;
    await assert.rejects(replayPair(snapshot(), options), /outside_quiet_window/);
    assert.equal(calls, 1);
    assert.equal(rows[0].variantId, 'candidate-v1');
    assert.equal(fs.existsSync(options.uncertainFile), false);
});

test('timeout after submit persists uncertain marker, never retries or sends next variant', async t => {
    const options = setup(t); let calls = 0;
    options.fetch = async () => { calls++; throw new Error('timeout after submit'); };
    await assert.rejects(replayPair(snapshot(), options), /inference_uncertain/);
    await assert.rejects(replayPair(snapshot(), options), /inference_uncertain/);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(options.uncertainFile), true);
});

test('body timeout, HTTP rejection and corrupt response are uncertain with no retry', async t => {
    for (const fetch of [async () => ({ ok: true, text: async () => { throw new Error('timeout'); } }),
        async () => ({ ok: false }), async () => ({ ok: true, text: async () => 'invalid' })]) {
        const options = setup(t); options.fetch = fetch;
        await assert.rejects(replayPair(snapshot(), options), /inference_uncertain/);
        assert.equal(fs.existsSync(options.uncertainFile), true);
    }
});

test('persist failure retains marker; invalid model stops after drained response', async t => {
    const options = setup(t); options.fetch = async () => response();
    options.persist = async () => { throw new Error('disk full'); };
    await assert.rejects(replayPair(snapshot(), options), /disk full/);
    assert.equal(fs.existsSync(options.uncertainFile), true);
    const invalid = setup(t); let calls = 0;
    invalid.fetch = async () => { calls++; return { ok: true, text: async () => JSON.stringify({ model: 'other' }) }; };
    await assert.rejects(replayPair(snapshot(), invalid), /invalid_response/);
    assert.equal(calls, 1); assert.equal(fs.existsSync(invalid.uncertainFile), false);
});

test('late or forbidden choices retained without creating fills or synthetic profit', async t => {
    const options = setup(t); let time = 100; options.clock = () => time;
    options.fetch = async () => { time += 3001; return response('BUY_DOWN'); };
    const rows = await replayPair(snapshot(), options);
    assert.equal(rows[0].timely, false);
    assert.equal(rows[0].originalAction, 'BUY_DOWN'); assert.equal(rows[0].action, 'SKIP');
    assert.equal(rows[0].reason, 'disallowed_action');
    const summary = summarize(rows, [{ slug: 'm1', payout: [0, 1] }]);
    assert.equal(summary['candidate-v1'].disallowed, 1);
    assert.equal(summary['candidate-v1'].buyDecisions, 0);
    assert.equal(summary['candidate-v1'].tradingProfit, null);
    assert.equal(summary['candidate-v1'].computeCost, null);
});

test('server token usage must match exact offline count before accepting a replay decision', async t => {
    const options = setup(t), rows = []; let calls = 0;
    options.fetch = async () => {
        calls++;
        const raw = JSON.parse(await response().text()); raw.usage.input_tokens = 499;
        return { ok: true, text: async () => JSON.stringify(raw) };
    };
    options.persist = async row => rows.push(row);
    await assert.rejects(replayPair(snapshot(), options), /invalid_response/);
    assert.equal(calls, 1); assert.equal(rows[0].reason, 'token_usage_mismatch');
    assert.equal(rows[0].executable, false); assert.equal(rows[0].tokenUsageMatches, false);
    assert.equal(fs.existsSync(options.uncertainFile), false);
});

test('compact candidate is explicit, archived separately and never silently falls back', async t => {
    const options = setup(t); options.candidateId = 'candidate-v2'; options.fetch = async () => response();
    const rows = await replayPair(snapshot(), options);
    assert.deepEqual(rows.map(row => row.variantId), ['baseline-v1', 'candidate-v2']);
    const report = summarize(rows, [], 'candidate-v2');
    assert.equal(report['candidate-v2'].requests, 1);
    assert.equal(report['candidate-v1'], undefined);
    await assert.rejects(replayPair(snapshot(), { ...options, candidateId: 'automatic-best' }), /candidate_unknown/);
});
