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
import { readOwnedTradeReview, prepareOwnedTradeRecovery, applyOwnedTradeRecovery } from '../src/eligible-live/owned-trade-recovery.js';

export function backupOwnedTradeLedger(store, config) {
    const unsafe = () => { throw new Error('eligible_owned_trade_recovery_unsafe_backup'); };
    if (!fs.lstatSync(store.filename).isFile()) unsafe();
    const bytes = fs.readFileSync(store.filename);
    if (!isDeepStrictEqual(JSON.parse(bytes), store.state)) throw new Error('eligible_owned_trade_recovery_ledger_changed');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    let directory = config.settings.dataDir;
    if (!path.isAbsolute(directory) || !fs.lstatSync(directory).isDirectory()
        || typeof config.id !== 'string' || !/^[a-f0-9]{16}$/.test(config.id)) unsafe();
    const directories = [directory];
    for (const part of [config.id, 'eligible-runtime', 'owned-trade-recovery']) {
        directory = path.join(directory, part);
        try { fs.mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(directory).isDirectory()) unsafe();
        directories.push(directory);
    }
    const filename = path.join(directory, `${digest}.json`);
    try {
        const fd = fs.openSync(filename, 'wx', 0o600);
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
        if (error.code !== 'EEXIST' || !fs.lstatSync(filename).isFile() || !fs.readFileSync(filename).equals(bytes)) throw error;
    }
    for (const target of directories.reverse()) {
        const fd = fs.openSync(target, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return digest;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
    if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply') throw new Error('use_eligible_recover_trade_apply');
    const apply = argv[0] === '--apply';
    const load = dependencies.loadConfig || (() => loadEligibleConfig(eligibleEnvironment()));
    const loadReview = dependencies.loadReview || (() => readOwnedTradeReview(eligibleEnvironment().ELIGIBLE_OWNED_TRADE_REVIEW));
    const config = load(), approval = loadReview();
    const release = await (dependencies.acquireLock || acquireLock)(config.settings.dataDir, 'pilot');
    let client, interrupted = false;
    const cancel = () => { interrupted = true; };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
        const unchanged = () => {
            if (!isDeepStrictEqual(load(), config) || !isDeepStrictEqual(loadReview(), approval))
                throw new Error('eligible_owned_trade_recovery_config_changed');
        };
        unchanged();
        const store = dependencies.storeFactory ? dependencies.storeFactory(config) : new Store(config.settings, 'pilot', 'late-entry');
        client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        const review = await (dependencies.prepare || prepareOwnedTradeRecovery)(config, store.state, client, approval);
        if (interrupted) throw new Error('eligible_owned_trade_recovery_interrupted');
        unchanged();
        let backupSha256 = null;
        if (apply) {
            backupSha256 = (dependencies.backup || backupOwnedTradeLedger)(store, config);
            (dependencies.apply || applyOwnedTradeRecovery)(store, review, { explicitApply: true });
        }
        (dependencies.write || (value => console.log(JSON.stringify(value, null, 2))))({ ...review.summary, applied: apply, backupSha256,
            liveStarted: false, nextCommand: 'poly check, then poly start' });
        return 0;
    } finally {
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        try { client?.close?.(); } finally { await release(); }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(JSON.stringify({ type: 'eligible_owned_trade_recovery_failed', code: operationCode(error) }));
        process.exitCode = 1;
    });
