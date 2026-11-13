import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main, parseRecoveryArgs, backupSignalLedger } from '../../scripts/eligible-recover-signal.js';

function fixture() {
    const calls = [], state = { baseline: 'period' }, config = { id: 'period', runtimeId: 'runtime',
        settings: { dataDir: '/test' }, ai: {} };
    const deps = {
        loadConfig: () => config,
        acquireLock: async () => { calls.push('lock'); return async () => calls.push('release'); },
        readHistory: () => [state], storeFactory: () => ({ state }),
        clientFactory: () => ({ close: () => calls.push('client-close') }),
        providerFactory: () => ({ close: () => calls.push('provider-close') }),
        prepare: async () => { calls.push('prepare'); return { summary: { ready: true } }; },
        backup: () => { calls.push('backup'); return 'proof'; },
        apply: (store, review, options) => { assert.equal(options.explicitApply, true); calls.push('apply'); },
        write: result => calls.push(result),
    };
    return { calls, state, config, deps };
}

test('signal recovery CLI defaults to review without applying or starting trading', async () => {
    const f = fixture();
    assert.equal(await main([], f.deps), 0);
    assert.deepEqual(f.calls.filter(value => typeof value === 'string'),
        ['lock', 'prepare', 'provider-close', 'client-close', 'release']);
    assert.deepEqual(f.calls.find(value => typeof value === 'object'), { ready: true, applied: false,
        backupSha256: null, liveStarted: false, financialWrites: false, nextCommand: 'poly start' });
});

test('explicit apply backs up under the wallet lock before writing and always releases', async () => {
    const f = fixture();
    assert.equal(await main(['--apply'], f.deps), 0);
    assert.deepEqual(f.calls.filter(value => typeof value === 'string'),
        ['lock', 'prepare', 'backup', 'apply', 'provider-close', 'client-close', 'release']);
});

test('failed proof or backup cannot apply; lock and resources are released', async t => {
    for (const stage of ['prepare', 'backup']) await t.test(stage, async () => {
        const f = fixture(); f.deps[stage] = () => { throw new Error('unproven'); };
        await assert.rejects(main(['--apply'], f.deps), /unproven/);
        assert.ok(!f.calls.includes('apply'));
        assert.deepEqual(f.calls.slice(-3), ['provider-close', 'client-close', 'release']);
    });
});

test('cleanup exceptions still release the shared wallet lock', async () => {
    const f = fixture();
    f.deps.providerFactory = () => ({ close() { throw new Error('close_failed'); } });
    await assert.rejects(main([], f.deps), /close_failed/);
    assert.deepEqual(f.calls.slice(-2), ['client-close', 'release']);
});

test('active runner lock, invalid arguments, changed configuration and missing ledger cannot recover', async t => {
    for (const args of [['apply'], ['--force'], ['--apply', '--apply']])
        assert.throws(() => parseRecoveryArgs(args), /use_eligible_recover_signal_apply/);
    await t.test('lock', async () => {
        const f = fixture(); f.deps.acquireLock = async () => { throw new Error('already_running'); };
        await assert.rejects(main(['--apply'], f.deps), /already_running/);
        assert.deepEqual(f.calls, []);
    });
    await t.test('configuration', async () => {
        const f = fixture(); let n = 0;
        f.deps.loadConfig = () => ({ ...f.config, runtimeId: ++n === 1 ? 'old' : 'new' });
        await assert.rejects(main(['--apply'], f.deps), /config_changed/);
        assert.deepEqual(f.calls, ['lock', 'release']);
    });
    await t.test('ledger', async () => {
        const f = fixture(); f.deps.readHistory = () => [];
        await assert.rejects(main(['--apply'], f.deps), /ledger_missing/);
        assert.deepEqual(f.calls, ['lock', 'release']);
    });
});

test('ledger backup preserves exact bytes and refuses changed data', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-recovery-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'ledger.json'), bytes = '{"cash":13.66961,"stopped":{"reason":"operational_check_failed"}}\n';
    fs.writeFileSync(filename, bytes);
    const store = { filename, state: JSON.parse(bytes) }, config = { id: 'period', settings: { dataDir: dir } };
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(backupSignalLedger(store, config), hash);
    const backup = path.join(dir, 'period/eligible-runtime/signal-recovery', `${hash}.json`);
    assert.equal(fs.readFileSync(backup, 'utf8'), bytes);
    assert.equal(fs.statSync(backup).mode & 0o077, 0);
    assert.equal(backupSignalLedger(store, config), hash);
    store.state.cash++;
    assert.throws(() => backupSignalLedger(store, config), /ledger_changed/);
    assert.equal(fs.readFileSync(backup, 'utf8'), bytes);
});
