import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { TradingClient } from '../src/restart/client.js';
import { acquireLock } from '../src/restart/store.js';
import { preflight } from '../src/restart/preflight.js';
import { BookHistory } from '../src/ai-shadow/history.js';
import { metadataIdentity, verifyStreamSnapshot } from '../src/ai-shadow/engine.js';
import { loadLayaConfig } from '../src/laya-pilot/config.js';
import { LayaProvider } from '../src/laya-pilot/provider.js';
import { LayaStore } from '../src/laya-pilot/store.js';
import { LayaPaperEngine } from '../src/laya-pilot/engine.js';
import { saveLayaReport, readLayaReports } from '../src/laya-pilot/report.js';

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['preflight', 'paper', 'report'].includes(command)) throw new Error('use_laya_pilot_preflight_paper_report');
    const valid = command === 'preflight' ? ['--wallet', '--smoke'] : command === 'report' ? ['--history'] : [];
    if (flags.some(flag => !valid.includes(flag)) || new Set(flags).size !== flags.length) throw new Error('invalid_option');
    return { command, wallet: flags.includes('--wallet'), smoke: flags.includes('--smoke'), history: flags.includes('--history') };
}

// No signer, order submission, allowance, or transaction method is exposed to paper.
export function publicReader(control, onEvent) {
    // Polybolt requires authenticated feed access. The signing inside
    // authenticate() proves wallet ownership; it is not a trading signature.
    const raw = new TradingClient(control);
    for (const operation of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction'])
        raw[operation] = async () => { throw new Error('paper_transaction_forbidden'); };
    raw.onEvent = event => onEvent?.(event);
    return Object.freeze({ btc: raw.btc, market: raw.market.bind(raw), books: raw.books.bind(raw),
        payout: raw.payout.bind(raw), serverTime: raw.serverTime.bind(raw), tickSize: raw.tickSize.bind(raw),
        startBtcFeed: raw.startBtcFeed.bind(raw), btcStatus: raw.btcStatus.bind(raw), close: raw.close.bind(raw) });
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
    const config = loadLayaConfig();
    if (args.command === 'report') { console.log(JSON.stringify(readLayaReports(config, args.history), null, 2)); return; }
    if (args.command === 'preflight') {
        const client = publicReader(config.control), providers = new LayaProvider(config, {});
        let walletClient;
        try {
            const health = await providers.preflight();
            const publicChecks = await preflight(client, config.control, { publicOnly: true });
            const output = { at: new Date().toISOString(), id: config.id, paperOnly: true, liveReady: false,
                providers: health, publicReady: publicChecks.publicReady, checks: publicChecks.checks,
                liveBlockers: ['insufficient_laya_prospective_evidence', 'manual_live_activation_required'] };
            if (args.wallet) {
                // Reads contracts only. No API-key creation or signed trade submission.
                walletClient = new TradingClient(config.control);
                const wallet = await walletClient.walletHealth();
                output.wallet = { address: config.control.wallet, asset: 'pUSD', chainId: 137,
                    balance: wallet.balance, requiredBalance: config.capital,
                    shortfall: Math.max(0, Math.round((config.capital - wallet.balance) * 1e6) / 1e6),
                    nativeGasPOL: wallet.nativeGas, signerIsOwner: wallet.signerIsOwner,
                    threshold: wallet.threshold, exchangeApproved: wallet.exchangeApproval,
                    adapterApproved: wallet.adapterApproval, fundingReady: wallet.balance >= config.capital && wallet.nativeGas >= 0.05 };
                if (!output.wallet.fundingReady) output.liveBlockers.push('insufficient_funding');
            }
            if (args.smoke) {
                const ws = new BookHistory();
                try {
                    const slug = `btc-updown-5m-${Math.floor(Date.now() / 300000) * 300}`;
                    const market = await client.market(slug);
                    ws.watch(market.tokens); client.startBtcFeed();
                    const until = Date.now() + 15000;
                    while (Date.now() < until && (!ws.snapshot(Date.now(), false) || !client.btcStatus()?.ready)) await delay(100);
                    const generation = ws.generation; await client.books(market);
                    const validation = { at: Date.now(), generation, identity: metadataIdentity(market) };
                    await verifyStreamSnapshot(client, ws, market, validation, Date.now, config.dataAgeMs, false);
                    output.smoke = { websocketReady: true, btcReady: !!client.btcStatus()?.ready,
                        warmupComplete: !!ws.snapshot(), market: market.slug };
                } finally { ws.close(); }
            }
            console.log(JSON.stringify(output, null, 2));
            if (!health.laya.ready || !publicChecks.publicReady || args.smoke && !output.smoke?.btcReady) process.exitCode = 1;
        } finally { providers.close(); client.close(); walletClient?.close(); }
        return;
    }
    const release = await acquireLock(config.dataDir, 'paper');
    let engine, ending = false;
    const end = () => { ending = true; if (engine) engine.closed = true; };
    process.on('SIGINT', end); process.on('SIGTERM', end);
    try {
        const store = new LayaStore(config);
        const providers = new LayaProvider(config, store.state.providers, (type, detail) => {
            if (type === 'provider_late_response') {
                const row = store.state.snapshots.find(s => s.snapshotId === detail.snapshotId)?.decisions.laya;
                if (row) { row.lateDecision = detail.action; row.actualLatencyMs = detail.latencyMs; }
            }
            store.event(type, detail);
        });
        const client = publicReader(config.control, event => {
            if (event.type === 'read_failed') store.error(event.error?.stage || 'public_read', event.error);
            else if (['btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected'].includes(event.type)) store.event(event.type);
        });
        const books = new BookHistory({ onEvent: type => store.event(type) });
        engine = new LayaPaperEngine(config, store, client, books, providers);
        const health = await providers.preflight();
        if (!health.laya.ready) throw new Error('laya_preflight_failed');
        store.event('started', { paperOnly: true, provider: 'laya', model: 'typed-decisions',
            deadline: new Date(config.deadline).toISOString(), capital: 20, drawdownStop: 2, maxMarkets: 30 });
        client.startBtcFeed(); let nextReport = 0, nextProbe = Date.now() + 30000;
        while (!ending) {
            const now = Date.now(); store.freeze(now);
            const labelsPending = store.state.snapshots.some(s => !store.state.markets[s.market]?.payout);
            // Check before launching the next manage/label tasks, so a flat stopped period exits.
            if (store.state.frozenAt && !store.state.arms.laya.position && !labelsPending && !engine.tasks.size) break;
            try { await engine.tick(now); } catch (error) { store.error('tick', error); }
            if (now >= nextReport) { saveLayaReport(config, store.state); nextReport = now + 1800000; }
            if (now >= nextProbe && !providers.active.size && !store.state.frozenAt) {
                await providers.preflight(); nextProbe = Date.now() + 30000;
            }
            await delay(100);
        }
        store.save(); saveLayaReport(config, store.state);
    } finally {
        if (engine) {
            engine.closed = true; await Promise.allSettled([...engine.tasks]);
            await Promise.allSettled([...engine.providers.active.values()]);
            engine.close(); saveLayaReport(config, engine.store.state);
        }
        await release(); process.off('SIGINT', end); process.off('SIGTERM', end);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'laya_pilot_failed', code: /^[a-z][a-z0-9_]{1,80}$/.test(error.message || '') ? error.message : 'operation_failed' }));
        process.exitCode = 1;
    });
}
