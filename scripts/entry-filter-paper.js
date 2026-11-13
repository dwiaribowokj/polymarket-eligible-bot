#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '../src/restart/store.js';
import { requireRuntime } from '../src/restart/config.js';
import { preflight } from '../src/restart/preflight.js';
import { validatedStreamBooks } from '../src/ai-shadow/engine.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { publicReader } from '../src/laya-filter-paper/client.js';
import { EntryFilterPaperStore } from '../src/entry-filter-paper/store.js';
import { loadEntryFilterPaperConfig, LIVE_TUNING_PROFILE, isLiveTuningProfile } from '../src/entry-filter-paper/config.js';
import { EntryFilterPaperEngine } from '../src/entry-filter-paper/engine.js';
import { readEntryFilterPaperReports } from '../src/entry-filter-paper/report.js';
import { readEntryFilterRestBooks, validatedEntryFilterRestBooks } from '../src/entry-filter-paper/book-source.js';

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'run', 'report'].includes(command)) throw new Error('use_entry_filter_paper_preflight_run_report');
    const outFlags = flags.filter(flag => flag.startsWith('--out='));
    if (outFlags.length !== 1 || !path.isAbsolute(outFlags[0].slice(6))) throw new Error('absolute_paper_output_required');
    const optional = command === 'preflight' ? ['--smoke'] : command === 'report' ? ['--history'] : [];
    const profiles = flags.filter(flag => flag.startsWith('--profile='));
    const profile = profiles[0]?.slice('--profile='.length);
    if (profiles.length > 1 || profiles.length && (command === 'report' || !isLiveTuningProfile(profile)))
        throw new Error('invalid_entry_filter_profile');
    if (flags.some(flag => !outFlags.includes(flag) && !profiles.includes(flag) && !optional.includes(flag)) || new Set(flags).size !== flags.length)
        throw new Error('invalid_option');
    return { command, out: path.resolve(outFlags[0].slice(6)), smoke: flags.includes('--smoke'), history: flags.includes('--history'),
        ...(profiles.length ? { profile } : {}) };
}

export function writeReportAsync(config) {
    const workerData = { ...config.policy, id: config.id, dataDir: config.dataDir, deadline: config.deadline };
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../src/entry-filter-paper/report-worker.js', import.meta.url), { workerData });
        let result;
        worker.on('message', value => { result = value; });
        worker.once('error', reject);
        worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('paper_report_worker_failed')));
    });
}

export async function smoke(config, client, makeBooks = () => new LiveBookHistory(), {
    clock = Date.now, sleep = delay, readRestBooks = readEntryFilterRestBooks, fetchImpl = globalThis.fetch } = {}) {
    const books = makeBooks();
    try {
        const until = clock() + 15000;
        client.startBtcFeed();
        const market = await client.market(`btc-updown-5m-${Math.floor(clock() / 300000) * 300}`,
            { deadline: until, retries: 0 });
        if (clock() >= until) throw new Error('entry_filter_smoke_timeout');
        books.watch(market.tokens, market);
        // Leave time for fresh REST verification after waiting for the read-only BTC feed.
        while (clock() < until - 3000 && (!client.btcStatus()?.ready
            || config.profile === LIVE_TUNING_PROFILE && !books.snapshot(clock(), false)))
            await sleep(Math.min(100, until - 3000 - clock()));
        const pair = await readRestBooks(market, { client, clock, deadlineAt: until,
            maxAgeMs: config.dataAgeMs, fetchImpl });
        const at = clock();
        if (at > until) throw new Error('entry_filter_smoke_timeout');
        validatedEntryFilterRestBooks(market, pair, at, config.dataAgeMs);
        let websocketReady = false, websocketError = null;
        try {
            const validation = { ...pair.validation, generation: books.generation,
                endpointTicks: pair.books.map(book => book.tick),
                tickVerifiedAt: Math.min(...pair.evidence.books.map(book => book.tickVerification.receivedAt)) };
            validatedStreamBooks(books, market, validation, at, config.dataAgeMs, false);
            websocketReady = true;
        } catch (error) {
            websocketError = /^[a-z_]+$/.test(error.message) ? error.message : 'websocket_unverified';
        }
        return { market: market.slug, restReady: true, bookSource: 'rest', restEvidence: pair.evidence,
            ...(isLiveTuningProfile(config.profile) ? { executionBookPolicy: config.executionBook,
                executionSourceReady: config.profile === LIVE_TUNING_PROFILE ? websocketReady : true,
                warmupRequiredBeforeEntry: true,
                websocketWarmupRequiredBeforeEntry: config.profile === LIVE_TUNING_PROFILE,
                btcHistoryRequiredMs: config.observationPolicy?.btcHistoryMs ?? 180000 } : {}),
            websocketReady, websocketError, btcReady: !!client.btcStatus()?.ready,
            warmupComplete: websocketReady && !!books.snapshot(at),
            inferenceSubmitted: false, transactionsSubmitted: false };
    } finally { books.close(); }
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    requireRuntime();
    if (args.command === 'report') {
        console.log(JSON.stringify(readEntryFilterPaperReports({ dataDir: args.out }, args.history), null, 2)); return;
    }
    const config = loadEntryFilterPaperConfig(process.env, args.out, args.profile);
    if (args.command === 'preflight') {
        const client = publicReader(config.control);
        try {
            const checks = await preflight(client, config.control, { publicOnly: true });
            const output = { id: config.id, paperOnly: true, arms: config.armNames, capitalPerArm: config.capital,
                inferenceRequired: false, transactionsSubmitted: false, publicReady: checks.publicReady,
                checks: checks.checks, policy: config.policy };
            if (args.smoke) output.smoke = await smoke(config, client);
            console.log(JSON.stringify(output, null, 2));
            if (!checks.publicReady || args.smoke && (!output.smoke?.btcReady || !output.smoke?.restReady
                || isLiveTuningProfile(config.profile) && !output.smoke?.executionSourceReady)) process.exitCode = 1;
        } finally { client.close(); }
        return;
    }
    const release = await acquireLock(config.dataDir, 'entry-filter-paper');
    let engine, store, client, books, ending = false;
    const end = () => { ending = true; if (engine) engine.closed = true; };
    process.on('SIGINT', end); process.on('SIGTERM', end);
    try {
        store = new EntryFilterPaperStore(config);
        client = publicReader(config.control, event => {
            if (event.type === 'read_failed') store.error(event.error?.stage || 'public_read', event.error);
            else if (['btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected'].includes(event.type)) store.event(event.type);
        });
        books = new LiveBookHistory({ onEvent: (type, detail) => store.event(type, detail) });
        const providers = { predict() { throw new Error('entry_filter_inference_forbidden'); }, close() {} };
        engine = new EntryFilterPaperEngine(config, store, client, books, providers);
        store.event('started', { paperOnly: true, inferenceRequired: false, capitalPerArm: config.capital,
            arms: config.armNames, profile: config.profile || null, baselineArm: config.baselineArm,
            drawdownStop: config.drawdownStop, deadline: null });
        await engine.verifyClock(); client.startBtcFeed();
        let nextReport = 0, completed = -1, reporting = false;
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
            await delay(100);
        }
    } finally {
        try {
            if (engine) {
                engine.closed = true;
                await Promise.allSettled([...engine.tasks]);
                engine.close();
            } else { books?.close(); client?.close(); }
            if (store) { store.save(); await writeReportAsync(config); }
        }
        finally { await release(); process.off('SIGINT', end); process.off('SIGTERM', end); }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'entry_filter_paper_failed', code: /^[a-z][a-z0-9_]{1,100}$/.test(error.message || '')
            ? error.message : 'operation_failed' })); process.exitCode = 1;
    });
}
