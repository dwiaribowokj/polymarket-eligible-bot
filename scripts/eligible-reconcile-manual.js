#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Store, acquireLock } from '../src/restart/store.js';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { operationCode } from '../src/laya-live/broker.js';
import { eligibleEnvironment, loadEligibleConfig } from '../src/eligible-live/config.js';
import { eligibleHistory } from '../src/eligible-live/preflight.js';
import { prepareManualWalletRecovery, applyManualWalletRecovery } from '../src/eligible-live/manual-wallet-recovery.js';

export function parseManualRecoveryArgs(argv) {
    if (argv.length > 1 || argv.length === 1 && argv[0] !== '--apply')
        throw new Error('use_eligible_reconcile_manual_apply');
    return { apply: argv[0] === '--apply' };
}

export function loadManualWalletReview(config, filename = process.env.ELIGIBLE_MANUAL_WALLET_REVIEW) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('eligible_manual_wallet_review_required');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())
        throw new Error('eligible_manual_wallet_review_unsafe');
    const bytes = fs.readFileSync(filename), review = JSON.parse(bytes);
    return { ...config, manualWalletRecovery: review, manualWalletReviewFile: { path: filename,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseManualRecoveryArgs(argv);
    const load = dependencies.loadConfig || (() => loadManualWalletReview(loadEligibleConfig(eligibleEnvironment())));
    const initial = load();
    const release = await (dependencies.acquireLock || acquireLock)(initial.settings.dataDir, 'pilot');
    const write = dependencies.write || (value => console.log(JSON.stringify(value, null, 2)));
    let client, interrupted = false;
    const cancel = () => { interrupted = true; };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
        const config = load();
        if (config.id !== initial.id || config.runtimeId !== initial.runtimeId
            || config.settings.dataDir !== initial.settings.dataDir
            || JSON.stringify(config.manualWalletRecovery) !== JSON.stringify(initial.manualWalletRecovery)
            || JSON.stringify(config.manualWalletReviewFile) !== JSON.stringify(initial.manualWalletReviewFile))
            throw new Error('eligible_manual_wallet_config_changed');
        const history = (dependencies.readHistory || eligibleHistory)(config);
        if (!history.some(state => state.baseline === config.id && state.strategy === 'late-entry'))
            throw new Error('eligible_manual_wallet_ledger_missing');
        const store = dependencies.storeFactory ? dependencies.storeFactory(config) : new Store(config.settings, 'pilot', 'late-entry');
        client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        const review = await (dependencies.prepare || prepareManualWalletRecovery)(config, store.state, client);
        if (interrupted) throw new Error('eligible_manual_wallet_interrupted');
        const applied = args.apply ? (dependencies.apply || applyManualWalletRecovery)(store, review, { explicitApply: true }) : null;
        write({ ...review.summary, applied: args.apply, recovery: applied,
            liveStarted: false, financialWrites: false, automaticActivation: false });
        return 0;
    } finally {
        process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
        try { client?.close(); } finally { await release(); }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(JSON.stringify({ type: 'eligible_manual_wallet_recovery_failed', code: operationCode(error) }));
        process.exitCode = 1;
    });
