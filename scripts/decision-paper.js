#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { acquireLock } from '../src/restart/store.js';
import { requireRuntime } from '../src/restart/config.js';
import { preflight } from '../src/restart/preflight.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { DecisionProviders } from '../src/decision-paper/providers.js';
import { metadataIdentity, verifyStreamSnapshot } from '../src/ai-shadow/engine.js';
import { loadDecisionPaperConfig } from '../src/decision-paper/config.js';
import { DecisionPaperStore } from '../src/decision-paper/store.js';
import { DecisionPaperEngine } from '../src/decision-paper/engine.js';
import { publicReader } from '../src/laya-filter-paper/client.js';
import { readDecisionPaperReports } from '../src/decision-paper/report.js';
import { recordProviderEvent } from '../src/decision-paper/events.js';

const runFile = promisify(execFile);
const competingServices = ['polymarket-laya-live.service', 'polymarket-laya-paper.service', 'polymarket-ai-shadow.service',
    'polymarket-laya-filter-paper.service', 'polymarket-decision-paper.service'];

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'run', 'report'].includes(command)) throw new Error('use_decision_paper_preflight_run_report');
    const outFlags = flags.filter(flag => flag.startsWith('--out='));
    if (outFlags.length !== 1 || !path.isAbsolute(outFlags[0].slice(6))) throw new Error('absolute_paper_output_required');
    const optional = command === 'preflight' ? ['--smoke'] : command === 'report' ? ['--history'] : [];
    if (flags.some(flag => !outFlags.includes(flag) && !optional.includes(flag)) || new Set(flags).size !== flags.length)
        throw new Error('invalid_option');
    return { command, out: path.resolve(outFlags[0].slice(6)), smoke: flags.includes('--smoke'), history: flags.includes('--history') };
}

export async function inferenceAvailable(execute = runFile, ownPid = process.pid) {
    try {
        const { stdout } = await execute('systemctl', ['--user', 'show', ...competingServices, '--property=Id,ActiveState,MainPID'],
            { timeout: 500, maxBuffer: 8192 });
        const rows = stdout.trim().split(/\n\s*\n/).map(block => Object.fromEntries(block.split('\n').map(line => {
            const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
        })));
        return rows.length === competingServices.length && competingServices.every(unit => {
            const matches = rows.filter(row => row.Id === unit), row = matches[0];
            return matches.length === 1 && (['inactive', 'failed'].includes(row.ActiveState) && row.MainPID === '0'
                || row.ActiveState === 'active' && Number(row.MainPID) === ownPid);
        });
    } catch { return false; }
}

export function writeReportAsync(config) {
    // Read the atomically saved ledger in another thread; bootstrap cannot delay entry or feed ingestion.
    const workerData = { ...config.policy, id: config.id, dataDir: config.dataDir, deadline: config.deadline };
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../src/decision-paper/report-worker.js', import.meta.url), { workerData });
        let result;
        worker.on('message', value => { result = value; });
        worker.once('error', reject);
        worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('paper_report_worker_failed')));
    });
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    requireRuntime();
    if (args.command === 'report') {
        console.log(JSON.stringify(readDecisionPaperReports({ dataDir: args.out }, args.history), null, 2)); return;
    }
    dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
    const config = loadDecisionPaperConfig(process.env, args.out);
    if (args.command === 'preflight') {
        const client = publicReader(config.control), provider = new DecisionProviders(config, {});
        try {
            const health = await provider.preflight();
            const checks = await preflight(client, config.control, { publicOnly: true });
            const inferenceReady = await inferenceAvailable();
            const output = { id: config.id, paperOnly: true, arms: config.armNames, capitalPerArm: 20,
                models: health, publicReady: checks.publicReady, checks: checks.checks, inferenceReady,
                decisionProtocol: config.decisionProtocol, decisionTimeoutPolicy: config.decisionTimeoutPolicy };
            if (args.smoke) {
                const books = new LiveBookHistory();
                try {
                    const market = await client.market(`btc-updown-5m-${Math.floor(Date.now() / 300000) * 300}`);
                    books.watch(market.tokens, market);
                    const until = Date.now() + 15000;
                    while (Date.now() < until && (!books.snapshot(Date.now(), false) || !client.btcStatus()?.ready)) await delay(100);
                    const generation = books.generation;
                    await client.books(market);
                    const validation = { at: Date.now(), generation, identity: metadataIdentity(market) };
                    await verifyStreamSnapshot(client, books, market, validation, Date.now, config.dataAgeMs, false);
                    output.smoke = { market: market.slug, websocketReady: true, btcReady: !!client.btcStatus()?.ready,
                        warmupComplete: !!books.snapshot(), inferenceSubmitted: false, transactionsSubmitted: false };
                } finally { books.close(); }
            }
            console.log(JSON.stringify(output, null, 2));
            if (!health.laya.ready || !health.gemini.ready || !checks.publicReady || !inferenceReady || args.smoke && !output.smoke?.btcReady) process.exitCode = 1;
        } finally { provider.close(); client.close(); }
        return;
    }
    const release = await acquireLock(config.dataDir, 'filter-paper');
    let engine, store, provider, client, books, ending = false;
    const end = () => { ending = true; if (engine) engine.closed = true; };
    process.on('SIGINT', end); process.on('SIGTERM', end);
    try {
        store = new DecisionPaperStore(config);
        provider = new DecisionProviders(config, store.state.providers, (type, detail) => {
            recordProviderEvent(store.state, type, detail);
            store.event(type, detail);
        });
        client = publicReader(config.control, event => {
            if (event.type === 'read_failed') store.error(event.error?.stage || 'public_read', event.error);
            else if (['btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected'].includes(event.type)) store.event(event.type);
        });
        books = new LiveBookHistory({ onEvent: (type, detail) => store.event(type, detail) });
        engine = new DecisionPaperEngine(config, store, client, books, provider, { beforeInference: async () => {
            const available = await inferenceAvailable();
            if (!available) store.event('inference_paused', { reason: 'competing_service_or_status_unavailable' });
            return available;
        } });
        const health = await provider.preflight();
        store.event('started', { paperOnly: true, models: health, capitalPerArm: 20,
            arms: config.armNames, drawdownStop: 10, deadline: null, decisionProtocol: config.decisionProtocol,
            decisionTimeoutPolicy: config.decisionTimeoutPolicy });
        await engine.verifyClock(); client.startBtcFeed();
        let nextReport = 0, nextProbe = Date.now() + 30000, completed = -1, probing = false, reporting = false;
        while (!ending) {
            const now = Date.now();
            try { await engine.tick(now); } catch (error) { store.error('tick', error); }
            const count = Object.values(store.state.arms).reduce((n, arm) => n + arm.completed.length, 0);
            if (!reporting && (now >= nextReport || count !== completed)) {
                reporting = true; nextReport = now + config.reportMs; completed = count;
                engine.launch(writeReportAsync(config).catch(error => {
                    nextReport = Date.now() + 30000; store.error('report', error);
                }).finally(() => { reporting = false; }));
            }
            if (now >= nextProbe && !probing && !provider.active.size && !store.state.frozenAt) {
                probing = true; nextProbe = now + 30000;
                engine.launch(provider.preflight().catch(error => store.error('provider_health', error))
                    .finally(() => { probing = false; }));
            }
            await delay(100);
        }
    } finally {
        if (engine) {
            engine.closed = true;
            await Promise.allSettled([...engine.tasks]);
            await provider.drain();
            engine.close();
        } else { books?.close(); provider?.close(); client?.close(); }
        if (store) { store.save(); await writeReportAsync(config); }
        await release(); process.off('SIGINT', end); process.off('SIGTERM', end);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'decision_paper_failed', code: /^[a-z][a-z0-9_]{1,100}$/.test(error.message || '')
            ? error.message : 'operation_failed' })); process.exitCode = 1;
    });
}
