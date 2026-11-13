#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '../src/restart/store.js';
import { requireRuntime } from '../src/restart/config.js';
import { preflight } from '../src/restart/preflight.js';
import { metadataIdentity, verifyStreamSnapshot } from '../src/ai-shadow/engine.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { premarketReader } from '../src/premarket-paper/client.js';
import { PremarketPaperStore } from '../src/premarket-paper/store.js';
import { loadPremarketPaperConfig, selectedPremarketProviders } from '../src/premarket-paper/config.js';
import { PremarketPaperEngine } from '../src/premarket-paper/engine.js';
import { PremarketProviders } from '../src/premarket-paper/providers.js';
import { readPremarketPaperReports } from '../src/premarket-paper/report.js';
import { EARLY_PROFILE, NEXT_PROFILE, isCandleProfile } from '../src/premarket-paper/early-context.js';
import { readCandleHistory } from '../src/premarket-paper/candle-history.js';
import { readEarlyPaperBooks, validatedEarlyPaperBooks } from '../src/premarket-paper/early-book.js';
import { configureEarlyPaperTransport, EARLY_PAPER_CLOCK } from '../src/premarket-paper/transport.js';
import { safeError, OperationalError } from '../src/restart/network.js';

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'run', 'report'].includes(command)) throw new Error('use_premarket_paper_preflight_run_report');
    const outputs = flags.filter(flag => flag.startsWith('--out='));
    if (outputs.length !== 1 || !path.isAbsolute(outputs[0].slice(6))) throw new Error('absolute_paper_output_required');
    const optional = command === 'preflight' ? ['--smoke'] : command === 'report' ? ['--history'] : [];
    if (flags.some(flag => !outputs.includes(flag) && !optional.includes(flag)) || new Set(flags).size !== flags.length)
        throw new Error('invalid_option');
    return { command, out: path.resolve(outputs[0].slice(6)), smoke: flags.includes('--smoke'), history: flags.includes('--history') };
}

export function writeReportAsync(config) {
    const reportConfig = { ...config.policy, id: config.id, dataDir: config.dataDir };
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../src/premarket-paper/report.js', import.meta.url),
            { workerData: { kind: 'premarket-paper-report', config: reportConfig } });
        let result;
        worker.on('message', value => { result = value; });
        worker.once('error', reject);
        worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('paper_report_worker_failed')));
    });
}

export function installPaperSignals({ end, cutoff }, target = process) {
    target.on('SIGINT', end); target.on('SIGTERM', end); target.on('SIGUSR1', cutoff);
    return () => { target.off('SIGINT', end); target.off('SIGTERM', end); target.off('SIGUSR1', cutoff); };
}

export async function smoke(config, client, makeBooks = () => new LiveBookHistory(), clock = Date.now, sleep = delay,
    candleReader = readCandleHistory, readEarlyBooks = readEarlyPaperBooks) {
    if (isCandleProfile(config) && config.bookPolicy)
        return earlySmoke(config, client, clock, candleReader, readEarlyBooks);
    const books = makeBooks();
    const early = isCandleProfile(config);
    const history = () => candleReader(config.candleCache, { snapshotAt: clock(), now: clock(),
        maxAgeMs: config.candleCacheMaxAgeMs, count: config.candleCount });
    try {
        if (!early) client.startBtcFeed();
        const open = (Math.floor(clock() / 300000) + (early ? Math.ceil(config.leadSeconds / 300) : 1)) * 300000;
        const slug = `btc-updown-5m-${open / 1000}`;
        const market = await client.market(slug);
        if (market.slug !== slug || market.open !== open || market.end !== open + 300000 || market.open <= clock()
            || !market.accepting || !(market.minimum > 0 && market.minimum <= config.shares))
            throw new Error('premarket_smoke_future_market_invalid');
        const until = clock() + 15000;
        let verified = false, lastError;
        while (clock() < until) {
            if (market.open <= clock()) throw new Error('premarket_smoke_future_market_expired');
            // watch() reconnects only when the stream's own backoff permits it.
            books.watch(market.tokens, market);
            if (!books.snapshot(clock(), false) || !(early ? history().ready : client.btcStatus()?.ready)) {
                await sleep(Math.min(100, until - clock())); continue;
            }
            const generation = books.generation;
            let validation, timer;
            try {
                await Promise.race([
                    (async () => {
                        await client.books(market, { deadline: until, retries: 0 });
                        if (clock() >= until) throw new Error('premarket_smoke_timeout');
                        validation = { at: clock(), generation, identity: metadataIdentity(market) };
                        await verifyStreamSnapshot(client, books, market, validation, clock, config.dataAgeMs, false);
                    })(),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('premarket_smoke_timeout')), Math.max(0, until - clock()));
                    }),
                ]);
                if (clock() >= until) throw new Error('premarket_smoke_timeout');
                if (market.open <= clock()) throw new Error('premarket_smoke_future_market_expired');
                if (!(early ? history().ready : client.btcStatus()?.ready)) {
                    lastError = new Error('premarket_smoke_btc_unavailable');
                } else { verified = true; break; }
            } catch (error) {
                const reconnect = error.message === 'execution_metadata_changed_or_expired' && validation
                    && metadataIdentity(market) === validation.identity && clock() >= validation.at
                    && (books.generation !== generation || clock() - validation.at > config.dataAgeMs);
                const stale = error.code === 'stale_book' && error.category === 'stale_data' && error.stage === 'book_read';
                if (!reconnect && !stale && error.message !== 'execution_book_unavailable') throw error;
                lastError = error;
            } finally { clearTimeout(timer); }
            if (clock() < until) await sleep(Math.min(1000, until - clock()));
        }
        if (!verified) {
            if (!(early ? history().ready : client.btcStatus()?.ready)) throw new Error('premarket_smoke_btc_unavailable');
            throw lastError || new Error('execution_book_unavailable');
        }
        return { market: market.slug, futureMarket: true, open: market.open, websocketReady: true, btcReady: true,
            openingReferenceRequired: false, inferenceSubmitted: false, transactionsSubmitted: false,
            ...(early ? { candleSource: 'binance_spot', candleCount: 30, candleIntervalMs: 300000,
                historicalBackfillAllowed: true, continuousWarmupRequired: false } : {}) };
    } finally { books.close(); }
}

async function earlySmoke(config, client, clock, candleReader, readBooks) {
    const next = config.profile === NEXT_PROFILE;
    const open = (Math.floor(clock() / 300000) + Math.ceil(config.leadSeconds / 300)) * 300000;
    const slug = `btc-updown-5m-${open / 1000}`, deadlineAt = clock() + 15000;
    const market = await client.market(slug, { deadline: deadlineAt, retries: 0 });
    if (market.slug !== slug || market.open !== open || market.end !== open + 300000 || (next ? market.end <= clock() : market.open <= clock())
        || !market.accepting || !(market.minimum > 0 && market.minimum <= config.shares))
        throw new Error('premarket_smoke_future_market_invalid');
    const metadataVerifiedAt = clock();
    const pair = await readBooks(market, { clock, metadataVerifiedAt,
        deadlineAt: Math.min(deadlineAt, metadataVerifiedAt + config.bookPolicy.maxRoundTripMs), policy: config.bookPolicy });
    const books = validatedEarlyPaperBooks(market, pair, clock(), config.bookPolicy);
    if (clock() >= deadlineAt) throw new Error('premarket_smoke_timeout');
    if ((next ? market.end <= clock() : market.open <= clock())) throw new Error('premarket_smoke_future_market_expired');
    const history = candleReader(config.candleCache, { snapshotAt: clock(), now: clock(),
        maxAgeMs: config.candleCacheMaxAgeMs, count: config.candleCount });
    if (!history.ready) throw new Error('premarket_smoke_btc_unavailable');
    return { market: market.slug, futureMarket: !next, open: market.open,
        ...(next ? { targetHorizon: 1, entryPhase: 'early_in_market' } : {}),
        restBooksReady: true, websocketRequired: false, btcReady: true,
        bestAsk: books.map(book => book.asks[0]?.price ?? null), bookEvidence: pair.evidence,
        openingReferenceRequired: false, inferenceSubmitted: false, transactionsSubmitted: false,
        candleSource: 'binance_spot', candleCount: config.candleCount, candleIntervalMs: config.candleIntervalMs,
        historicalBackfillAllowed: true, continuousWarmupRequired: false };
}

export async function premarketPreflight(config, client, { clock = Date.now, candleReader = readCandleHistory,
    readBooks = readEarlyPaperBooks, publicPreflight = preflight } = {}) {
    const early = isCandleProfile(config);
    let checkedClient = early ? { ...client, btc: null, startBtcFeed() {} } : client;
    if (early && config.bookPolicy) {
        let clockError;
        try { await client.serverTime(); } catch (error) { clockError = error; }
        // The generic preflight must not measure retry backoff as clock skew.
        checkedClient = { ...checkedClient, serverTime: async () => {
            if (clockError) throw clockError;
            const sample = client.clock, now = clock();
            if (!sample || !Number.isFinite(sample.skewMs) || !Number.isFinite(sample.at)
                || now < sample.at || now - sample.at >= EARLY_PAPER_CLOCK.validMs)
                throw new Error('Invalid server clock');
            return now + sample.skewMs;
        } };
    }
    const checks = await publicPreflight(checkedClient, config.control,
        { publicOnly: true, ...(early && config.bookPolicy ? { strategies: [] } : {}) });
    if (early && config.bookPolicy && checks.time && client.clock)
        Object.assign(checks.time, { roundTripMs: client.clock.durationMs, sampledAt: client.clock.at,
            sampleAgeMs: clock() - client.clock.at });
    if (early) {
        const at = clock(), history = candleReader(config.candleCache,
            { snapshotAt: at, now: at, maxAgeMs: config.candleCacheMaxAgeMs, count: config.candleCount });
        checks.checks.push({ name: 'external_candle_history', scope: 'public', ok: history.ready,
            detail: { source: history.source, symbol: history.symbol, candles: history.bars?.length || 0,
                windowEnd: history.windowEnd, observedAt: history.observedAt, reason: history.reason } });
        checks.publicReady &&= history.ready;
        if (config.bookPolicy) {
            try {
                const detail = await earlySmoke(config, client, clock, candleReader, readBooks);
                checks.checks.push({ name: 'early_future_market', scope: 'public', ok: true, detail });
            } catch (error) {
                checks.checks.push({ name: 'early_future_market', scope: 'public', ok: false, error: safeError(error) });
                checks.publicReady = false;
            }
        }
    }
    return checks;
}

export function recordPremarketReadFailure(store, error) {
    const code = /^[a-z][a-z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'request_failed';
    const category = ['transport', 'timeout', 'rate_limit', 'circuit', 'validation', 'stale_data', 'api_rejection', 'opportunity', 'contract']
        .includes(error?.category) ? error.category : 'unknown';
    const diagnostic = safeError(new OperationalError(code, category, Object.fromEntries(
        ['stage', 'endpoint', 'httpStatus', 'durationMs', 'attempts', 'dataAgeMs', 'retryAfter'].map(key => [key, error?.[key]]))));
    store.error(diagnostic.stage || 'public_read', diagnostic);
    store.event('read_failed', { error: diagnostic });
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv); requireRuntime();
    if (args.command === 'report') {
        console.log(JSON.stringify(readPremarketPaperReports({ dataDir: args.out }, args.history), null, 2)); return;
    }
    const config = loadPremarketPaperConfig(process.env, args.out);
    const restoreTransport = isCandleProfile(config) ? configureEarlyPaperTransport() : () => {};
    try { return await runConfigured(config, args); }
    finally { restoreTransport(); }
}

async function runConfigured(config, args) {
    const providerNames = selectedPremarketProviders(config);
    if (args.command === 'preflight') {
        const client = premarketReader(config);
        let providers;
        try {
            if (providerNames.length) providers = new PremarketProviders(config, {}, () => {});
            const checks = await premarketPreflight(config, client);
            const providerChecks = await providers?.preflight() || {};
            const output = { id: config.id, paperOnly: true, arms: config.armNames, activeArms: config.activeArms, capitalPerArm: config.capital,
                inferenceSubmitted: false, transactionsSubmitted: false, publicReady: checks.publicReady,
                checks: checks.checks, providers: providerChecks, policy: config.policy };
            if (args.smoke) output.smoke = await smoke(config, client);
            console.log(JSON.stringify(output, null, 2));
            if (!checks.publicReady || providerNames.some(name => !providerChecks[name]?.ready)) process.exitCode = 1;
        } finally { providers?.close(); await client.close(); }
        return;
    }
    const release = await acquireLock(config.dataDir, 'premarket-paper');
    let engine, store, client, providers, ending = false, cutoffRequested = false;
    const end = () => { ending = true; if (engine) engine.closed = true; };
    const cutoff = () => {
        cutoffRequested = true;
        if (engine) {
            try { engine.requestEntryCutoff('manual_entry_cutoff'); }
            catch (error) { ending = true; engine.closed = true; process.exitCode = 1; }
        }
    };
    const removeSignals = installPaperSignals({ end, cutoff });
    try {
        store = new PremarketPaperStore(config);
        client = premarketReader(config, event => {
            if (event.type === 'read_failed') {
                if (isCandleProfile(config)) recordPremarketReadFailure(store, event.error);
                else store.error(event.error?.stage || 'public_read', event.error);
            }
            else if (['btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected', 'btc_feed_close_wait',
                'btc_feed_close_failed', 'btc_feed_retry_scheduled'].includes(event.type)) {
                if (event.type === 'btc_feed_gap') engine?.history?.reset?.();
                const { type, ...detail } = event;
                store.event(type, detail);
            }
        });
        if (providerNames.length) providers = new PremarketProviders(config, store.state.providers ||= {},
            (type, detail) => { store.save(); store.event(type, detail); });
        engine = new PremarketPaperEngine(config, store, client, { providers });
        if (['fair-near-open-30m-v1', EARLY_PROFILE, NEXT_PROFILE].includes(config.profile)) await providers.preflight();
        if (cutoffRequested) engine.requestEntryCutoff('manual_entry_cutoff');
        store.event('started', { paperOnly: true, capitalPerArm: config.capital, arms: config.armNames, activeArms: config.activeArms,
            drawdownStop: config.drawdownStop, automaticPromotion: false });
        client.startBtcFeed(); await engine.verifyClock();
        let nextReport = 0, completed = -1, reporting = false;
        while (!ending) {
            if (engine.isDrained()) { store.event('entry_cutoff_drained'); break; }
            const now = Date.now();
            try { await engine.tick(now); } catch (error) { store.error('tick', error); }
            const count = Object.values(store.state.arms).reduce((total, arm) => total + arm.completed.length, 0);
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
                await providers?.drain?.(config.providerDrainMs ?? config.aiDecisionMs + 1000);
                await Promise.allSettled([...engine.tasks]);
                await engine.close();
            } else await client?.close();
            providers?.close();
            if (store) { store.save(); await writeReportAsync(config); }
        } finally { await release(); removeSignals(); }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'premarket_paper_failed', code: /^[a-z][a-z0-9_]{1,100}$/.test(error.message || '')
            ? error.message : 'operation_failed' })); process.exitCode = 1;
    });
}
