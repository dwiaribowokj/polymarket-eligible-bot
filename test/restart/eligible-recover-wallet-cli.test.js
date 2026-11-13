import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { main, parseWalletRecoveryArgs, backupWalletLedger } from '../../scripts/eligible-recover-wallet.js';

function fixture() {
    const calls = [], state = { baseline: 'period', strategy: 'late-entry' }, config = { id: 'period', runtimeId: 'runtime',
        settings: { dataDir: '/test' }, ai: {} };
    const summary = { ready: true, remainingStops: ['unrelated_stop'] };
    const deps = {
        loadConfig: () => config,
        acquireLock: async () => { calls.push('lock'); return async () => calls.push('release'); },
        readHistory: () => [state], storeFactory: () => ({ state }),
        clientFactory: () => ({ close: () => calls.push('client-close') }),
        providerFactory: () => ({ close: () => calls.push('provider-close') }),
        prepare: async () => { calls.push('prepare'); return { summary }; },
        backup: () => { calls.push('backup'); return 'proof'; },
        apply: (store, review, options) => {
            assert.equal(options.explicitApply, true);
            assert.equal(store.state, state);
            assert.equal(review.summary, summary);
            calls.push('apply');
        },
        write: result => calls.push(result),
    };
    return { calls, state, config, summary, deps };
}

function ledgerFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-read-recovery-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'ledger.json');
    const bytes = '{"cash":13.66961,"stopped":{"reason":"operational_check_failed"}}\n';
    fs.writeFileSync(filename, bytes);
    const store = { filename, state: JSON.parse(bytes) }, config = { id: 'period', settings: { dataDir: dir } };
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(dir, 'period', 'eligible-runtime', 'wallet-read-recovery');
    return { dir, bytes, store, config, hash, directory, backup: path.join(directory, `${hash}.json`) };
}

test('wallet recovery CLI defaults to read-only review and preserves the review summary', async () => {
    const f = fixture();
    assert.deepEqual(parseWalletRecoveryArgs([]), { apply: false });
    assert.equal(await main([], f.deps), 0);
    assert.deepEqual(f.calls.filter(value => typeof value === 'string'),
        ['lock', 'prepare', 'provider-close', 'client-close', 'release']);
    assert.deepEqual(f.calls.find(value => typeof value === 'object'), { ...f.summary, applied: false,
        backupSha256: null, liveStarted: false, financialWrites: false, nextCommand: 'poly start' });
});

test('explicit wallet recovery applies only after preparation and backup under the wallet lock', async () => {
    const f = fixture();
    assert.deepEqual(parseWalletRecoveryArgs(['--apply']), { apply: true });
    assert.equal(await main(['--apply'], f.deps), 0);
    assert.deepEqual(f.calls.filter(value => typeof value === 'string'),
        ['lock', 'prepare', 'backup', 'apply', 'provider-close', 'client-close', 'release']);
    assert.deepEqual(f.calls.find(value => typeof value === 'object'), { ...f.summary, applied: true,
        backupSha256: 'proof', liveStarted: false, financialWrites: false, nextCommand: 'poly start' });
});

test('failed wallet recovery proof or backup cannot apply and releases resources', async t => {
    for (const stage of ['prepare', 'backup']) await t.test(stage, async () => {
        const f = fixture(); f.deps[stage] = () => { throw new Error('unproven'); };
        await assert.rejects(main(['--apply'], f.deps), /unproven/);
        assert.ok(!f.calls.includes('apply'));
        assert.deepEqual(f.calls.slice(-3), ['provider-close', 'client-close', 'release']);
    });
});

test('wallet recovery cancellation prevents backup and apply and removes its signal handlers', async t => {
    for (const signal of ['SIGINT', 'SIGTERM']) await t.test(signal, async () => {
        const f = fixture(), before = process.listeners(signal);
        f.deps.prepare = async () => {
            process.emit(signal);
            return { summary: f.summary };
        };
        await assert.rejects(main(['--apply'], f.deps), /eligible_wallet_recovery_interrupted/);
        assert.deepEqual(f.calls, ['lock', 'provider-close', 'client-close', 'release']);
        assert.deepEqual(process.listeners(signal), before);
    });
});

test('wallet recovery cleanup releases the shared lock when closing either resource fails', async t => {
    for (const resource of ['provider', 'client']) await t.test(resource, async () => {
        const f = fixture();
        f.deps[`${resource}Factory`] = () => ({ close() {
            f.calls.push(`${resource}-close`);
            throw new Error('close_failed');
        } });
        await assert.rejects(main([], f.deps), /close_failed/);
        assert.deepEqual(f.calls.slice(-3), ['provider-close', 'client-close', 'release']);
    });
});

test('invalid wallet recovery arguments and an active runner cannot start recovery', async t => {
    for (const args of [['apply'], ['--force'], ['--apply', '--apply']]) {
        assert.throws(() => parseWalletRecoveryArgs(args), /use_eligible_recover_wallet_apply/);
        const f = fixture();
        await assert.rejects(main(args, f.deps), /use_eligible_recover_wallet_apply/);
        assert.deepEqual(f.calls, []);
    }
    await t.test('active runner', async () => {
        const f = fixture(); f.deps.acquireLock = async () => { throw new Error('already_running'); };
        await assert.rejects(main(['--apply'], f.deps), /already_running/);
        assert.deepEqual(f.calls, []);
    });
});

test('wallet recovery refuses configuration drift and a missing baseline ledger', async t => {
    for (const field of ['id', 'runtimeId', 'dataDir']) await t.test(field, async () => {
        const f = fixture(); let loads = 0;
        f.deps.loadConfig = () => {
            if (++loads === 1) return f.config;
            return field === 'dataDir' ? { ...f.config, settings: { dataDir: '/changed' } }
                : { ...f.config, [field]: 'changed' };
        };
        await assert.rejects(main(['--apply'], f.deps), /eligible_wallet_recovery_config_changed/);
        assert.deepEqual(f.calls, ['lock', 'release']);
    });
    for (const history of [[], [{ baseline: 'another-period' }]]) await t.test('missing ledger', async () => {
        const f = fixture(); f.deps.readHistory = () => history;
        await assert.rejects(main(['--apply'], f.deps), /eligible_wallet_recovery_ledger_missing/);
        assert.deepEqual(f.calls, ['lock', 'release']);
    });
});

test('wallet ledger backup preserves exact bytes privately and refuses changed data', t => {
    const f = ledgerFixture(t);
    assert.equal(backupWalletLedger(f.store, f.config), f.hash);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.bytes);
    assert.equal(fs.statSync(f.backup).mode & 0o077, 0);
    assert.equal(backupWalletLedger(f.store, f.config), f.hash);
    f.store.state.cash++;
    assert.throws(() => backupWalletLedger(f.store, f.config), /eligible_wallet_recovery_ledger_changed/);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), f.bytes);
});

test('wallet recovery syncs its real backup before applying and fails closed if syncing fails', async t => {
    for (const failSync of [false, true]) await t.test(failSync ? 'sync failure' : 'synced backup', async t => {
        const f = fixture(), ledger = ledgerFixture(t), fsync = fs.fsyncSync;
        f.config.settings.dataDir = ledger.dir;
        f.deps.storeFactory = () => ledger.store;
        f.deps.backup = backupWalletLedger;
        f.deps.apply = (_store, _review, options) => {
            assert.equal(options.explicitApply, true);
            assert.ok(f.calls.includes('fsync'));
            assert.equal(fs.readFileSync(ledger.backup, 'utf8'), ledger.bytes);
            f.calls.push('apply');
        };
        fs.fsyncSync = fd => {
            f.calls.push('fsync');
            if (failSync) throw new Error('sync_failed');
            return fsync(fd);
        };
        try {
            if (failSync) {
                await assert.rejects(main(['--apply'], f.deps), /sync_failed/);
                assert.ok(!f.calls.includes('apply'));
            } else {
                assert.equal(await main(['--apply'], f.deps), 0);
                assert.ok(f.calls.includes('apply'));
            }
            assert.deepEqual(f.calls.slice(-3), ['provider-close', 'client-close', 'release']);
        } finally { fs.fsyncSync = fsync; }
    });
});

test('wallet ledger backup rejects symlinks and an existing backup with different bytes', async t => {
    for (const kind of ['directory symlink', 'file symlink', 'changed backup']) await t.test(kind, t => {
        const f = ledgerFixture(t);
        if (kind === 'directory symlink') {
            const target = path.join(f.dir, 'outside');
            fs.mkdirSync(target);
            fs.mkdirSync(path.dirname(f.directory), { recursive: true });
            fs.symlinkSync(target, f.directory, 'dir');
            assert.throws(() => backupWalletLedger(f.store, f.config));
            assert.deepEqual(fs.readdirSync(target), []);
        } else {
            fs.mkdirSync(f.directory, { recursive: true });
            if (kind === 'file symlink') fs.symlinkSync(f.store.filename, f.backup);
            else fs.writeFileSync(f.backup, 'different bytes');
            assert.throws(() => backupWalletLedger(f.store, f.config));
            assert.equal(fs.readFileSync(f.store.filename, 'utf8'), f.bytes);
            if (kind === 'changed backup') assert.equal(fs.readFileSync(f.backup, 'utf8'), 'different bytes');
        }
    });
});
