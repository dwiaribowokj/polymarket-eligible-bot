#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Store, acquireLock } from '../src/restart/store.js';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { operationCode } from '../src/laya-live/broker.js';
import { eligibleEnvironment, loadEligibleConfig } from '../src/eligible-live/config.js';
import { eligibleHistory } from '../src/eligible-live/preflight.js';
import { EligibleLiveProvider } from '../src/eligible-live/provider.js';
import { prepareEntryBufferMigration, applyEntryBufferMigration } from '../src/eligible-live/buffer-migration.js';

export function parseBufferMigrationArgs(argv) {
    if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
        throw new Error('use_eligible_migrate_buffer_apply');
    return { apply: argv[0] === '--apply' };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseBufferMigrationArgs(argv);
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
            || config.settings.dataDir !== initial.settings.dataDir) throw new Error('eligible_buffer_config_changed');
        const history = (dependencies.readHistory || eligibleHistory)(config);
        if (!history.some(state => state.baseline === config.id && state.strategy === 'late-entry'))
            throw new Error('eligible_buffer_ledger_missing');
        const store = dependencies.storeFactory ? dependencies.storeFactory(config) : new Store(config.settings, 'pilot', 'late-entry');
        client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        providers = dependencies.providerFactory ? dependencies.providerFactory(config.ai) : new EligibleLiveProvider(config.ai);
        const review = await (dependencies.prepare || prepareEntryBufferMigration)(config, store.state, client, providers);
        if (interrupted) throw new Error('eligible_buffer_interrupted');
        const applied = args.apply ? (dependencies.apply || applyEntryBufferMigration)(store, review, { explicitApply: true }) : null;
        write({ ...review.summary, applied: args.apply, migration: applied,
            liveStarted: false, financialWrites: false, automaticActivation: false });
        return 0;
    } finally {
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        try { providers?.close(); }
        finally { try { client?.close(); } finally { await release(); } }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(JSON.stringify({ type: 'eligible_buffer_migration_failed', code: operationCode(error) }));
        process.exitCode = 1;
    });
