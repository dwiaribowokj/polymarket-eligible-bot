import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, save } from '../../src/laya-tuning/replay.js';
import { buildProtocolRequest } from '../../src/laya-tuning/protocol.js';
import { INFORMED_QUESTIONS } from '../../src/decision-paper/features.js';
import { REPLAY_SERVICES, selectReplaySnapshots, buildPromptReplayProtocol, verifyReplayServices,
    replayPromptPair, runPromptReplay, summarizePromptReplay } from '../../src/decision-paper/replay.js';
import { parseReplayArgs, serviceGuard } from '../../scripts/decision-prompt-replay.js';

const identity = 'offline-artifact-identity';
const counter = { start: async () => ({ identity, maxTokens: 1024 }),
    count: async () => ({ valid: true, tokens: 512, identity }) };
function snapshot(market = 'm1', at = 1) {
    const input = ` ${JSON.stringify({ seconds: 60, shares: 5, cap_usd: 5, allowed: ['BUY_UP'] })}\n`;
    return { snapshotId: market + '-' + at, market, at, input, inputHash: digest(input),
        state: { future: 'DO_NOT_SEND' }, outcome: 'DO_NOT_SEND' };
}
const idleServices = () => REPLAY_SERVICES.map(Id => ({ Id, ActiveState: 'inactive', SubState: 'dead', MainPID: '0' }));
const response = (choice = 'BUY_UP', overrides = {}) => ({ ok: true, text: async () => JSON.stringify({ model: 'typed-decisions',
    usage: { input_tokens: 512 }, answers: { action: { choice, probabilities: { BUY_UP: .5, BUY_DOWN: .3, SKIP: .2 },
        answer_confidence: .5 } }, ...overrides }) });
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-prompt-replay-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, counter, expectedIdentity: identity, guard: async () => verifyReplayServices(idleServices()),
        uncertainFile: path.join(dir, 'inference-uncertain.json'), url: 'http://127.0.0.1:8090', persist: async () => {} };
}

test('CLI requires explicit absolute paths and bounds requests to 1..12 pairs, default four', () => {
    assert.deepEqual(parseReplayArgs(['--ledger=/tmp/l.json', '--out=/tmp/result']), { ledgerFile: '/tmp/l.json', out: '/tmp/result', pairs: 4 });
    for (const flags of [['--ledger=relative', '--out=/tmp/out'], ['--ledger=/tmp/l'],
        ['--ledger=/tmp/l', '--out=/tmp/o', '--pairs=0'], ['--ledger=/tmp/l', '--out=/tmp/o', '--pairs=13'],
        ['--ledger=/tmp/l', '--out=/tmp/o', '--pairs=1.5'], ['--ledger=/tmp/l', '--out=/tmp/o', '--out=/tmp/q'],
        ['--ledger=/tmp/l', '--out=/tmp/o', '--model=other']]) assert.throws(() => parseReplayArgs(flags), /prompt_replay_/);
});

test('selection takes chronological first snapshot per market with deterministic tie handling independent of labels', () => {
    const rows = [snapshot('late', 40), snapshot('m2', 20), snapshot('m1', 10), snapshot('m1', 30), snapshot('m0', 20)];
    const expected = ['m1-10', 'm0-20', 'm2-20', 'late-40'];
    assert.deepEqual(selectReplaySnapshots(rows).map(row => row.snapshotId), expected);
    for (const row of rows) { row.outcome = row.market === 'm1' ? 'WIN' : 'LOSS'; row.settlement = { payout: [0, 1] }; }
    assert.deepEqual(selectReplaySnapshots(rows.reverse()).map(row => row.snapshotId), expected);
    assert.equal(JSON.stringify(selectReplaySnapshots(rows)).includes('DO_NOT_SEND'), false);
    assert.throws(() => selectReplaySnapshots(rows, 5), /insufficient_markets/);
    assert.throws(() => selectReplaySnapshots(rows, 13), /pair_count_invalid/);
    const invalid = snapshot(); invalid.inputHash = 'changed';
    assert.throws(() => selectReplaySnapshots([invalid], 1), /snapshot_input_hash_mismatch/);
});

test('both protocols send exact persisted original bytes; baseline matches deployed candidate-v2', () => {
    const s = snapshot(), baseline = buildPromptReplayProtocol(s), candidate = buildPromptReplayProtocol(s, 'informed-v1');
    assert.deepEqual(baseline, buildProtocolRequest(s, { variantId: 'candidate-v2' }));
    assert.equal(baseline.request.state, s.input); assert.equal(candidate.request.state, s.input);
    assert.equal(candidate.request.model, 'typed-decisions'); assert.deepEqual(candidate.request.questions, INFORMED_QUESTIONS);
    assert.equal(candidate.inputHash, s.inputHash); assert.equal(candidate.requestHash, digest(JSON.stringify(candidate.request)));
    assert.notEqual(candidate.promptHash, baseline.promptHash);
    assert.equal(JSON.stringify(candidate.request).includes('DO_NOT_SEND'), false);
    assert.equal(JSON.parse(candidate.request.state).close60, undefined);
    assert.throws(() => { candidate.request.state = '{}'; }, TypeError);
    assert.throws(() => buildPromptReplayProtocol(s, 'best'), /variant_invalid/);
});

test('every configured competing service must be inactive with no process', () => {
    assert.deepEqual(REPLAY_SERVICES, ['polymarket-laya-filter-paper.service', 'polymarket-decision-paper.service',
        'polymarket-laya-live.service', 'polymarket-laya-paper.service', 'polymarket-ai-shadow.service', 'polymarket-paper.service']);
    assert.equal(verifyReplayServices(idleServices()).services.length, 6);
    for (const key of ['ActiveState', 'SubState', 'MainPID']) {
        const rows = idleServices(); rows[0][key] = key === 'MainPID' ? '123' : 'running';
        assert.throws(() => verifyReplayServices(rows), /competing_service_active/);
    }
    assert.throws(() => verifyReplayServices(idleServices().slice(1)), /services_unknown/);
    const duplicate = idleServices(); duplicate[0] = duplicate[1];
    assert.throws(() => verifyReplayServices(duplicate), /competing_service_active/);
    const guard = serviceGuard((_binary, args) => {
        for (const name of REPLAY_SERVICES) assert.ok(args.includes(name));
        return idleServices().map(row => Object.entries(row).map(([key, value]) => `${key}=${value}`).join('\n')).join('\n\n');
    });
    assert.equal(guard.services.length, 6);
});

test('pair runs sequentially, records durable marker before POST, and measures HTTP latency excluding checks', async t => {
    const options = fixture(t), requests = [], saved = [], counted = []; let now = 100, active = 0, maxActive = 0;
    options.clock = () => now;
    options.counter = { ...counter, count: async (state, questions) => { counted.push({ state, questions }); now += 500; return counter.count(); } };
    options.guard = async () => { now += 100; return verifyReplayServices(idleServices(), now); };
    options.fetch = async (_url, request) => {
        active++; maxActive = Math.max(maxActive, active);
        const marker = JSON.parse(fs.readFileSync(options.uncertainFile));
        const body = JSON.parse(request.body); assert.equal(marker.requestHash, digest(JSON.stringify(body)));
        assert.equal(request.redirect, 'error'); assert.equal(request.signal.aborted, false);
        requests.push(body); now += 1200; active--; return response();
    };
    options.persist = async row => { assert.ok(fs.existsSync(options.uncertainFile)); saved.push(row); };
    const s = snapshot(), rows = await replayPromptPair(s, options);
    assert.equal(maxActive, 1); assert.equal(requests.length, 2); assert.equal(saved.length, 2);
    assert.deepEqual(rows.map(row => row.variantId), ['candidate-v2', 'informed-v1']);
    assert.ok(rows.every(row => row.actualLatencyMs === 1200 && row.originalInputHash === s.inputHash && row.cost === null));
    assert.ok(requests.every(request => request.state === s.input));
    assert.deepEqual(counted.map(row => row.questions), requests.map(request => request.questions));
    assert.equal(fs.existsSync(options.uncertainFile), false);
});

test('second-pair ordering alternates and service guard is rechecked before every POST', async t => {
    const options = fixture(t); let calls = 0, guards = 0; const saved = [];
    options.pairIndex = 1;
    options.guard = async () => { if (++guards === 2) throw new Error('prompt_replay_competing_service_active'); return {}; };
    options.fetch = async () => { calls++; return response(); }; options.persist = async row => saved.push(row);
    await assert.rejects(replayPromptPair(snapshot(), options), /competing_service_active/);
    assert.equal(calls, 1); assert.equal(guards, 2); assert.equal(saved[0].variantId, 'informed-v1');
    assert.equal(fs.existsSync(options.uncertainFile), false);
});

test('ambiguous header, body, HTTP and malformed-response failures retain marker and never retry', async t => {
    for (const request of [async () => { throw new Error('timeout'); }, async () => ({ ok: false }),
        async () => ({ ok: true, text: async () => { throw new Error('timeout body'); } }),
        async () => ({ ok: true, text: async () => 'corrupt' })]) {
        const options = fixture(t); let calls = 0;
        options.fetch = async (...args) => { calls++; return request(...args); };
        await assert.rejects(replayPromptPair(snapshot(), options), /inference_uncertain/);
        await assert.rejects(replayPromptPair(snapshot(), options), /inference_uncertain/);
        assert.equal(calls, 1); assert.ok(fs.existsSync(options.uncertainFile));
    }
});

test('durable result failure retains uncertainty; invalid model or token count stops after drained response', async t => {
    const options = fixture(t); options.fetch = async () => response(); options.persist = async () => { throw new Error('disk full'); };
    await assert.rejects(replayPromptPair(snapshot(), options), /disk full/); assert.ok(fs.existsSync(options.uncertainFile));
    for (const raw of [{ model: 'other' }, { usage: { input_tokens: 511 } }]) {
        const invalid = fixture(t), rows = []; let calls = 0;
        invalid.fetch = async () => { calls++; return response('BUY_UP', raw); }; invalid.persist = async row => rows.push(row);
        await assert.rejects(replayPromptPair(snapshot(), invalid), /response_invalid/);
        assert.equal(calls, 1); assert.equal(rows[0].status, 'invalid'); assert.equal(rows[0].executable, false);
        assert.equal(fs.existsSync(invalid.uncertainFile), false);
    }
});

test('uncertain marker must fsync successfully before submitting any inference', async t => {
    const options = fixture(t), original = fs.fsyncSync; let calls = 0;
    options.fetch = async () => { calls++; return response(); };
    fs.fsyncSync = function(fd) {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === options.uncertainFile) throw new Error('sync_failed');
        return original.call(this, fd);
    };
    try { await assert.rejects(replayPromptPair(snapshot(), options), /sync_failed/); }
    finally { fs.fsyncSync = original; }
    assert.equal(calls, 0); assert.ok(fs.existsSync(options.uncertainFile));
});

test('offline token validity, artifact identity and full-prefix truncation failures prevent all POSTs', async t => {
    for (const overrides of [{ valid: false }, { tokens: 1025 }, { identity: 'changed' }, { instructionTruncated: true },
        { optionsTruncated: true }, { stateTruncated: true }]) {
        const options = fixture(t); let calls = 0;
        options.counter = { ...counter, count: async () => ({ valid: true, tokens: 512, identity, ...overrides }) };
        options.fetch = async () => { calls++; return response(); };
        await assert.rejects(replayPromptPair(snapshot(), options), /protocol_/);
        assert.equal(calls, 0); assert.equal(fs.existsSync(options.uncertainFile), false);
    }
});

test('run persists selection and both prompt hashes before first POST, without selecting on outcomes', async t => {
    const options = fixture(t), out = path.join(options.dir, 'output'), reservationDir = path.join(options.dir, 'reservations');
    const ledgerFile = path.join(options.dir, 'ledger.json'), snapshots = [snapshot('m2', 2), snapshot('m1', 1)];
    save(ledgerFile, { snapshots, markets: { m1: { payout: [0, 1] }, m2: { payout: [1, 0] } }, providers: { laya: { tokenizerIdentity: identity } } });
    let calls = 0;
    const result = await runPromptReplay({ ...options, ledgerFile, out, reservationDir, pairs: 2, fetch: async (_url, request) => {
        calls++; const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json')));
        assert.deepEqual(manifest.selected.map(row => row.snapshotId), ['m1-1', 'm2-2']);
        assert.ok(manifest.selected.every(row => row.protocols.length === 2 && row.protocols.every(p => /^[a-f0-9]{64}$/.test(p.promptHash))));
        assert.equal(manifest.sourceHash, digest(fs.readFileSync(ledgerFile)));
        assert.equal(JSON.stringify(manifest).includes('payout'), false);
        assert.equal(JSON.stringify(JSON.parse(request.body)).includes('DO_NOT_SEND'), false);
        assert.ok(fs.existsSync(path.join(reservationDir, 'inference-uncertain.json')));
        return response();
    } });
    assert.equal(result.status, 'completed'); assert.equal(calls, 4); assert.equal(result.completedRequests, 4);
    assert.equal(result.summary['candidate-v2'].directionCorrect, 1);
    assert.equal(result.summary['candidate-v2'].labelledBuyDecisions, 2);
    assert.equal(result.summary['informed-v1'].tradingProfit, null); assert.equal(result.summary['informed-v1'].winner, null);
    assert.equal(fs.existsSync(path.join(reservationDir, 'replay.lock')), false);
    await assert.rejects(runPromptReplay({ ...options, ledgerFile, out, reservationDir, pairs: 2 }), /output_exists/);
});

test('all selected inputs are counted before inference; any failure yields stopped artifact without a POST', async t => {
    const options = fixture(t), ledgerFile = path.join(options.dir, 'ledger.json');
    save(ledgerFile, { snapshots: [snapshot('m1', 1), snapshot('m2', 2)] }); let calls = 0, checks = 0;
    const result = await runPromptReplay({ ...options, ledgerFile, out: path.join(options.dir, 'output'),
        reservationDir: path.join(options.dir, 'reservations'), pairs: 2,
        counter: { ...counter, count: async () => ({ valid: ++checks < 4, tokens: 512, identity }) },
        fetch: async () => { calls++; return response(); } });
    assert.equal(calls, 0); assert.equal(result.status, 'stopped'); assert.equal(result.manifest, null);
    assert.match(result.reason, /protocol_context_invalid/); assert.equal(result.inferenceUncertain, false);
});

test('uncertain failure stops entire run and another output directory cannot bypass shared reservation', async t => {
    const options = fixture(t), ledgerFile = path.join(options.dir, 'ledger.json'), reservationDir = path.join(options.dir, 'reservations');
    save(ledgerFile, { snapshots: [snapshot()] }); let calls = 0;
    const args = { ...options, ledgerFile, out: path.join(options.dir, 'output'), reservationDir, pairs: 1,
        fetch: async () => { calls++; throw new Error('timeout'); } };
    const result = await runPromptReplay(args);
    assert.equal(result.status, 'stopped'); assert.equal(result.inferenceUncertain, true); assert.equal(calls, 1);
    await assert.rejects(runPromptReplay({ ...args, out: path.join(options.dir, 'new-output') }), /inference_uncertain/);
    assert.equal(calls, 1); assert.equal(fs.existsSync(path.join(reservationDir, 'replay.lock')), false);
});

test('unknown official labels remain excluded and forbidden choices never become hypothetical trades', async t => {
    const options = fixture(t); options.fetch = async () => response('BUY_DOWN');
    const rows = await replayPromptPair(snapshot(), options);
    assert.ok(rows.every(row => row.originalAction === 'BUY_DOWN' && row.action === 'SKIP' && !row.executable));
    const summary = summarizePromptReplay(rows, { m1: { payout: [0, 1] } });
    assert.equal(summary['candidate-v2'].disallowed, 1); assert.equal(summary['candidate-v2'].buyDecisions, 0);
    assert.equal(summary['candidate-v2'].directionAccuracy, null);
    const unknown = summarizePromptReplay([{ variantId: 'candidate-v2', status: 'ok', executable: true, action: 'BUY_UP', market: 'missing' }]);
    assert.equal(unknown['candidate-v2'].labelledBuyDecisions, 0); assert.equal(unknown['candidate-v2'].computeCost, null);
});
