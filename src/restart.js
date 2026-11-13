import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadSettings, requireRuntime } from './restart/config.js';
import { Store, acquireLock, atomicJson, otherLiveExposure, readTrials, pilotHistory, paperExposure, trialManifest } from './restart/store.js';
import { TradingClient, safeError } from './restart/client.js';
import { preflight } from './restart/preflight.js';
import { comparison } from './restart/math.js';
import { report, saveReport } from './restart/report.js';
import { Engine } from './restart/engine.js';

export function parseArgs(argv) {
    let command = 'paper', strategy = null, once = false, publicOnly = false, newTrial = false, save = false, history = false;
    if (argv[0] && !argv[0].startsWith('--')) command = argv.shift();
    if (!['paper', 'preflight', 'pilot', 'report'].includes(command)) throw new Error('Use preflight, paper, report, or pilot --strategy=late-entry|maker-mm');
    for (const arg of argv) {
        if (arg.startsWith('--strategy=')) strategy = arg.slice(11);
        else if (arg === '--once') once = true;
        else if (arg === '--public') publicOnly = true;
        else if (arg === '--new-trial') newTrial = true;
        else if (arg === '--save') save = true;
        else if (arg === '--history') history = true;
        else throw new Error('Unknown command option');
    }
    if (strategy && !['late-entry', 'maker-mm'].includes(strategy)) throw new Error('Unknown strategy');
    if (command === 'pilot' && !strategy) throw new Error('Pilot requires explicit --strategy=late-entry|maker-mm');
    if (newTrial && command !== 'paper') throw new Error('--new-trial is only available for paper');
    if (publicOnly && command !== 'preflight') throw new Error('--public is only available for preflight');
    if (save && command !== 'report') throw new Error('--save is only available for report');
    if (history && command !== 'report') throw new Error('--history is only available for report');
    return { command, strategy, once, publicOnly, newTrial, save, history };
}

export async function main(argv = process.argv.slice(2)) {
    requireRuntime();
    const args = parseArgs([...argv]);
    let settings = loadSettings(process.env, args.strategy || undefined);
    if (args.command === 'report') {
        console.log(JSON.stringify(args.save ? saveReport(settings, Date.now(), args.history)
            : report(settings, Date.now(), args.history), null, 2)); return;
    }
    let release = () => {}, client = null, engines = [];
    try {
        if (['paper', 'pilot'].includes(args.command)) release = await acquireLock(settings.dataDir, args.command);
        if (args.newTrial) {
            if (otherLiveExposure(settings).length) throw new Error('Resolve existing pilot exposure before resetting evidence');
            if (paperExposure(settings).length) throw new Error('Existing paper exposure blocks a new trial');
            atomicJson(path.join(settings.dataDir, 'trial.json'), { id: crypto.randomUUID(), createdAt: Date.now() });
            settings = loadSettings(process.env, args.strategy || undefined);
        }
        client = new TradingClient(settings);
        if (args.command === 'preflight') {
            const result = await preflight(client, settings, { publicOnly: args.publicOnly });
            console.log(JSON.stringify(result, null, 2));
            if (!(args.publicOnly ? result.publicReady : result.liveReady)) process.exitCode = 1;
            return;
        }
        if (args.command === 'pilot') {
            const store = new Store(settings, 'pilot', args.strategy);
            const exposures = otherLiveExposure(settings);
            if (exposures.some(e => e.baseline !== settings.fingerprint || e.strategy !== args.strategy))
                throw new Error('Existing pilot exposure requires its original baseline and strategy');
            if (!store.state.position) {
                const result = comparison(readTrials(settings), settings);
                if (result.selected !== args.strategy) throw new Error('Paper evidence does not qualify this selected strategy');
                if (pilotHistory(settings).some(s => s.baseline !== settings.fingerprint || s.strategy !== args.strategy))
                    throw new Error('Existing pilot history blocks a new capital or risk period');
                if (store.state.stopped) throw new Error('Pilot is stopped; its persistent limits cannot be reset');
            }
            const result = await preflight(client, settings, { owned: store.state.position?.orders.map(o => o.orderId) || [],
                resuming: !!store.state.position });
            console.log(JSON.stringify(result, null, 2));
            if (!result.liveReady && !store.state.position) throw new Error('Preflight blocks live startup');
            if (!result.liveReady) store.stop('restart_preflight_failed');
            store.state.legacyPositions = result.positions;
            store.save(); engines = [new Engine(settings, store, client)];
        } else {
            if (paperExposure(settings).some(s => s.baseline !== settings.fingerprint || !settings.strategies.includes(s.strategy)))
                throw new Error('Existing paper exposure requires its original baseline and strategy');
            const result = await preflight(client, settings, { publicOnly: true });
            console.log(JSON.stringify(result, null, 2));
            if (!result.publicReady) throw new Error('Public preflight blocks paper startup');
            engines = settings.strategies.map(strategy => new Engine(settings, new Store(settings, 'paper', strategy), client));
            trialManifest(settings);
        }
        client.onEvent = ({ type, ...detail }) => { for (const engine of engines) engine.store.event(type, detail); };
        for (const engine of engines) for (const [endpoint, started] of Object.entries(engine.store.state.operational?.outages || {}))
            client.reads.state(endpoint).outageAt = started;
        let ending = false;
        let snapshotSaved = false, finalSaved = false;
        const end = () => { ending = true; };
        process.on('SIGINT', end); process.on('SIGTERM', end);
        try {
            do {
                for (const engine of engines) await engine.tick();
                if (args.command === 'paper' && (settings.evaluationEndsAt && Date.now() >= settings.evaluationEndsAt
                    || engines.some(e => e.store.state.stopped))) {
                    const finished = engines.every(e => !e.store.state.position);
                    if (!snapshotSaved || finished && !finalSaved) {
                        saveReport(settings, Date.now(), true); snapshotSaved = true; finalSaved = finished;
                    }
                }
                if (args.once || engines.every(e => (e.store.state.stopped || e.store.state.frozenAt) && !e.store.state.position)) break;
                if (!ending) await delay(Math.min(...engines.map(e => e.nextDelay())));
            } while (!ending);
        } finally { process.off('SIGINT', end); process.off('SIGTERM', end); }
    } finally {
        for (const engine of engines) await engine.shutdown();
        client?.close(); await release();
    }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    main().catch(err => {
        const localErrors = ['Use ', 'Pilot ', 'Unknown ', 'Paper ', 'Public ', 'Preflight ', 'Existing ', 'Resolve ', 'Ledger ', 'Reactivation '];
        console.error(JSON.stringify({ type: 'startup_failed', error: safeError(err),
            reason: localErrors.some(prefix => err.message?.startsWith(prefix)) ? err.message : 'Check preflight output and local configuration' }));
        process.exitCode = 1;
    });
}
