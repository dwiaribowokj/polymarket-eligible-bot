#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Store, acquireLock } from '../src/restart/store.js';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { operationCode } from '../src/laya-live/broker.js';
import { eligibleEnvironment, loadEligibleConfig } from '../src/eligible-live/config.js';
import { eligibleHistory } from '../src/eligible-live/preflight.js';
import { EligibleLiveProvider } from '../src/eligible-live/provider.js';
import { prepareWalletReadRecovery, applyWalletReadRecovery } from '../src/eligible-live/wallet-read-recovery.js';

export function parseWalletRecoveryArgs(argv) {
    if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
        throw new Error('use_eligible_recover_wallet_apply');
    return { apply: argv[0] === '--apply' };
}

export function backupWalletLedger(store, config) {
    const unsafe = () => { throw new Error('eligible_wallet_recovery_unsafe_backup'); };
    if (!fs.lstatSync(store.filename).isFile()) unsafe();
    const bytes = fs.readFileSync(store.filename);
    if (!isDeepStrictEqual(JSON.parse(bytes), store.state)) throw new Error('eligible_wallet_recovery_ledger_changed');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    let directory = config.settings.dataDir;
    if (!path.isAbsolute(directory) || !fs.lstatSync(directory).isDirectory()
        || typeof config.id !== 'string' || !config.id || path.basename(config.id) !== config.id
        || ['.', '..'].includes(config.id)) unsafe();
    const directories = [directory];
    for (const part of [config.id, 'eligible-runtime', 'wallet-read-recovery']) {
        directory = path.join(directory, part);
        try { fs.mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(directory).isDirectory()) unsafe();
        directories.push(directory);
    }
    const filename = path.join(directory, `${digest}.json`);
    let fd;
    try {
        fd = fs.openSync(filename, 'wx', 0o600);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } catch (error) {
        if (error.code !== 'EEXIST' || !fs.lstatSync(filename).isFile()
            || !fs.readFileSync(filename).equals(bytes)) throw error;
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    for (const target of directories.reverse()) {
        const dir = fs.openSync(target, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    return digest;
}

// Offline recovery of one privately reviewed read failure, under the pilot lock.
export async function main(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseWalletRecoveryArgs(argv);
    const load = dependencies.loadConfig || (() => loadEligibleConfig(eligibleEnvironment()));
    const initial = load();
    const release = await (dependencies.acquireLock || acquireLock)(initial.settings.dataDir, 'pilot');
    const write = dependencies.write || (value => console.log(JSON.stringify(value, null, 2)));
    let client, providers, interrupted = false;
    const cancel = () => { interrupted = true; };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
        const config = load();
        if (config.id !== initial.id || config.runtimeId !== initial.runtimeId
            || config.settings.dataDir !== initial.settings.dataDir) throw new Error('eligible_wallet_recovery_config_changed');
        const history = (dependencies.readHistory || eligibleHistory)(config);
        if (!history.some(state => state.baseline === config.id && state.strategy === 'late-entry'))
            throw new Error('eligible_wallet_recovery_ledger_missing');
        const store = dependencies.storeFactory ? dependencies.storeFactory(config) : new Store(config.settings, 'pilot', 'late-entry');
        client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        providers = dependencies.providerFactory ? dependencies.providerFactory(config.ai) : new EligibleLiveProvider(config.ai);
        const review = await (dependencies.prepare || prepareWalletReadRecovery)(config, store.state, client, providers);
        if (interrupted) throw new Error('eligible_wallet_recovery_interrupted');
        let backupSha256 = null;
        if (args.apply) {
            backupSha256 = (dependencies.backup || backupWalletLedger)(store, config);
            if (interrupted) throw new Error('eligible_wallet_recovery_interrupted');
            (dependencies.apply || applyWalletReadRecovery)(store, review, { explicitApply: true });
        }
        write({ ...review.summary, applied: args.apply, backupSha256,
            liveStarted: false, financialWrites: false, nextCommand: 'poly start' });
        return 0;
    } finally {
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        try { providers?.close(); }
        finally { try { client?.close(); } finally { await release(); } }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(JSON.stringify({ type: 'eligible_wallet_recovery_failed', code: operationCode(error) }));
        process.exitCode = 1;
    });
