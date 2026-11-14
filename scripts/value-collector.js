#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock } from '../src/restart/store.js';
import { requireRuntime } from '../src/restart/config.js';
import { publicReader } from '../src/laya-filter-paper/client.js';
import { readValueBooks } from '../src/value-collector/book-source.js';
import { loadValueCollectorConfig } from '../src/value-collector/config.js';
import { ValueCollectorEngine, safeCode } from '../src/value-collector/engine.js';
import { ValueCollectorStore } from '../src/value-collector/store.js';

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'run', 'report'].includes(command)) throw new Error('use_value_collector_preflight_run_report');
    if (flags.length !== 1 || !flags[0].startsWith('--out=') || !path.isAbsolute(flags[0].slice(6)))
        throw new Error('absolute_collector_output_required');
    return { command, out: path.resolve(flags[0].slice(6)) };
}

export async function collectorPreflight(config, client) {
    const checks = [];
    const check = async (name, read) => {
        try { checks.push({ name, ok: true, detail: await read() }); }
        catch (error) { checks.push({ name, ok: false, reason: safeCode(error) }); }
    };
    client.startBtcFeed();
    await check('clock', async () => {
        const start = Date.now(), server = await client.serverTime(), now = Date.now();
        if (!Number.isFinite(server) || Math.abs(server - now) > config.maxClockSkewMs
            || now - start > config.dataAgeMs) throw new Error('collector_clock_unverified');
        return { verified: true };
    });
    let market;
    await check('market_and_both_books', async () => {
        market = await client.market(`btc-updown-5m-${Math.floor(Date.now() / 300000) * 300}`,
            { deadline: Date.now() + 5000, retries: 0 });
        const pair = await readValueBooks(market, { client, maxAgeMs: config.dataAgeMs });
        return { slug: market.slug, sides: pair.books.length, source: pair.source };
    });
    await check('chainlink_feed', async () => {
        const until = Date.now() + 15000;
        while (Date.now() < until && !client.btcStatus()?.ready) await delay(100);
        if (!client.btcStatus()?.ready) throw new Error('collector_feed_unavailable');
        return { ready: true, historyWarmupSeconds: config.historyMs / 1000,
            openingMustBeObservedAtNextBoundary: true };
    });
    if (market) await check('official_payout_rpc', async () => {
        await client.payout(market.conditionId);
        return { readable: true };
    });
    return { id: config.id, readOnly: true, transactionsSubmitted: 0, inferenceSubmitted: 0,
        ready: checks.every(row => row.ok), checks, policy: config.policy };
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    requireRuntime();
    if (args.command === 'report') {
        const state = JSON.parse(fs.readFileSync(path.join(args.out, 'state.json'), 'utf8'));
        console.log(JSON.stringify({ id: state.id, startedAt: state.startedAt, lastTickAt: state.lastTickAt,
            lastSlotAt: state.lastSlotAt, counts: state.counts, health: state.health, clock: state.clock,
            pendingLabels: Object.keys(state.pending || {}).length, storageBytes: state.storageBytes, readOnly: true,
            transactionsSubmitted: 0, inferenceSubmitted: 0 }, null, 2));
        return;
    }
    const config = loadValueCollectorConfig(process.env, args.out);
    if (args.command === 'preflight') {
        const client = publicReader(config.control);
        try {
            const result = await collectorPreflight(config, client);
            console.log(JSON.stringify(result, null, 2));
            if (!result.ready) process.exitCode = 1;
        } finally { client.close(); }
        return;
    }
    const release = await acquireLock(config.dataDir, 'value-collector');
    let store, client, engine, ending = false;
    const end = () => { ending = true; if (engine) engine.closed = true; };
    process.on('SIGINT', end); process.on('SIGTERM', end);
    try {
        store = new ValueCollectorStore(config);
        client = publicReader(config.control, event => {
            if (['btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected', 'btc_opening_conflict'].includes(event.type)) {
                store.event(event.type);
                if (event.type === 'btc_opening_conflict' && Number.isFinite(event.opening?.at))
                    engine?.conflicts.add(event.opening.at);
            }
        });
        engine = new ValueCollectorEngine(config, store, client);
        store.event('started');
        await engine.verifyClock();
        while (!ending) { await engine.tick(); await delay(100); }
    } finally {
        try {
            if (engine) await engine.close(); else client?.close();
            if (store) { store.event('stopped'); store.save(); }
        } finally {
            await release(); process.off('SIGINT', end); process.off('SIGTERM', end);
        }
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'value_collector_failed', code: safeCode(error) }));
        process.exitCode = error.message === 'collector_storage_budget_exhausted' ? 78 : 1;
    });
}
