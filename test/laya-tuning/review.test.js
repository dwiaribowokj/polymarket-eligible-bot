import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, quietGuard, replayPair, save } from '../../src/laya-tuning/replay.js';

const identity = 'review-tokenizer';
const counter = { start: async () => ({ identity, maxTokens: 1024 }),
    count: async () => ({ identity, tokens: 500, valid: true }) };
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-review-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const input = JSON.stringify({ seconds: 60, allowed: ['BUY_UP'] });
    return { directory, snapshot: { market: 'review-market', snapshotId: 'review-snapshot', input,
        inputHash: digest(input) }, options: { counter, expectedIdentity: identity,
        guard: async () => ({}), url: 'http://127.0.0.1:8090',
        uncertainFile: path.join(directory, 'uncertain.json'), persist: async () => {} } };
}
function guardFixture(now = 330000) {
    return { now, expectedPid: 123, expectedTokenizer: identity,
        service: { ActiveState: 'active', SubState: 'running', MainPID: '123' },
        ledger: { lastTickAt: now, ai: { providers: { laya: { tokenizerIdentity: identity } } } } };
}

test('guard rejects invalid clocks, process identities and absent tokenizer pins', () => {
    for (const now of [NaN, Infinity, -Infinity, -1, '330000', 330000.5])
        assert.throws(() => quietGuard(guardFixture(now)), /tune_clock_invalid/);
    for (const pid of [NaN, Infinity, -1, 0, '123', 123.5])
        assert.throws(() => quietGuard({ ...guardFixture(), expectedPid: pid }), /tune_live_process_changed/);
    const missingIdentity = guardFixture();
    missingIdentity.expectedTokenizer = undefined;
    delete missingIdentity.ledger.ai.providers.laya.tokenizerIdentity;
    assert.throws(() => quietGuard(missingIdentity), /tune_tokenizer_changed/);
});

test('atomic result save flushes both file data and its renamed directory entry', t => {
    const { directory } = fixture(t), file = path.join(directory, 'result.json');
    const original = fs.fsyncSync, types = [];
    t.mock.method(fs, 'fsyncSync', fd => {
        types.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
        original(fd);
    });
    save(file, { persisted: true });
    assert.deepEqual(types, ['file', 'directory']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { persisted: true });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory), ['result.json']);
});

test('failed result file flush preserves the prior result and removes temporary data', t => {
    const { directory } = fixture(t), file = path.join(directory, 'result.json');
    save(file, { persisted: 'prior' });
    t.mock.method(fs, 'fsyncSync', () => { throw new Error('flush_failed'); });
    assert.throws(() => save(file, { persisted: 'new' }), /flush_failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { persisted: 'prior' });
    assert.deepEqual(fs.readdirSync(directory), ['result.json']);
});

test('save flushes newly created directory ancestors before writing file data', t => {
    const { directory } = fixture(t), nested = path.join(directory, 'new', 'nested');
    const originalOpen = fs.openSync, originalSync = fs.fsyncSync, descriptors = new Map(), flushed = [];
    t.mock.method(fs, 'openSync', (...args) => {
        const fd = originalOpen(...args); descriptors.set(fd, args[0]); return fd;
    });
    t.mock.method(fs, 'fsyncSync', fd => { flushed.push(descriptors.get(fd)); originalSync(fd); });
    save(path.join(nested, 'result.json'), { persisted: true });
    assert.deepEqual(flushed.slice(0, 3), [nested, path.dirname(nested), directory]);
    assert.equal(flushed.length, 5);
    assert.equal(flushed.at(-1), nested);
});

test('marker file or directory flush failure blocks POST and retains uncertainty', async t => {
    for (const failAt of [1, 2]) {
        const { snapshot, options } = fixture(t);
        const original = fs.fsyncSync; let flushes = 0, calls = 0;
        const mock = t.mock.method(fs, 'fsyncSync', fd => {
            if (++flushes === failAt) throw new Error('flush_failed');
            original(fd);
        });
        options.fetch = async () => { calls++; throw new Error('unexpected_request'); };
        await assert.rejects(replayPair(snapshot, options), /flush_failed/);
        assert.equal(calls, 0);
        assert.equal(fs.existsSync(options.uncertainFile), true);
        mock.mock.restore();
    }
});

test('exclusive marker prevents concurrent calls from starting a second inference', async t => {
    const { snapshot, options } = fixture(t); let releaseGuard, calls = 0;
    const gate = new Promise(resolve => { releaseGuard = resolve; });
    options.guard = async () => gate;
    options.fetch = async () => { calls++; throw new Error('unknown_after_post'); };
    const first = replayPair(snapshot, options);
    const second = replayPair(snapshot, options);
    await assert.rejects(second, /tune_inference_uncertain/);
    releaseGuard({ checkedAt: 330000 });
    await assert.rejects(first, /tune_inference_uncertain/);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(options.uncertainFile), true);
});

test('guard runs after marker flush and refuses a window crossed while persisting', async t => {
    const { snapshot, options } = fixture(t); let now = 419999, calls = 0;
    const original = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => { original(fd); now++; });
    options.guard = async () => quietGuard(guardFixture(now));
    options.fetch = async () => { calls++; throw new Error('unexpected_request'); };
    await assert.rejects(replayPair(snapshot, options), /tune_outside_quiet_window/);
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(options.uncertainFile), false);
});

test('POST forbids redirects and keeps an unknown redirected request blocked', async t => {
    const { snapshot, options } = fixture(t); let calls = 0;
    options.fetch = async (_url, request) => {
        calls++;
        assert.equal(request.redirect, 'error');
        assert.equal(fs.existsSync(options.uncertainFile), true);
        throw new TypeError('unexpected redirect');
    };
    await assert.rejects(replayPair(snapshot, options), /tune_inference_uncertain/);
    await assert.rejects(replayPair(snapshot, options), /tune_inference_uncertain/);
    assert.equal(calls, 1);
});

test('inference timeout cannot exceed the quiet-window drain allowance', async t => {
    const { snapshot, options } = fixture(t); let calls = 0;
    options.fetch = async () => { calls++; throw new Error('unexpected_request'); };
    for (const timeoutMs of [0, -1, 30001, Infinity, NaN, '30000', 1.5])
        await assert.rejects(replayPair(snapshot, { ...options, timeoutMs }), /tune_timeout_invalid/);
    assert.equal(calls, 0);
});
