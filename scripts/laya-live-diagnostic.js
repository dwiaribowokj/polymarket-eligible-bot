import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { readOnlyLiveClient } from '../src/laya-live/diagnostic.js';
import { loadLiveConfig } from '../src/laya-live/config.js';
import { LayaLiveEngine } from '../src/laya-live/engine.js';
import { livePreflight } from '../src/laya-live/preflight.js';
import { operationCode } from '../src/laya-live/broker.js';
import { OperationalError } from '../src/restart/network.js';
import { Store, acquireLock, atomicJson } from '../src/restart/store.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { LayaLiveProvider } from '../src/laya-live/provider.js';

// Runs the real engine against an isolated COPY of a flat live ledger. Two
// independent barriers prevent signing/submission and entry reservations.
export async function main(argv = process.argv.slice(2)) {
    if (argv.some(a => !/^--minutes=\d+$/.test(a) && a !== '--inject-rpc-faults')) throw new Error('invalid_diagnostic_arguments');
    const minutes = Number(argv.find(a => a.startsWith('--minutes='))?.split('=')[1] || 15);
    if (minutes < 1 || minutes > 60) throw new Error('invalid_diagnostic_duration');
    dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
    const config = loadLiveConfig();
    const release = await acquireLock(config.settings.dataDir, 'pilot');
    const realLedger = path.join(config.settings.dataDir, config.id, 'pilot/late-entry.json');
    let client, providers, engine, store, interrupted = false;
    const started = Date.now(), runId = `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const dataDir = path.join(config.root, 'data/laya-live-diagnostics', runId);
    const digest = () => crypto.createHash('sha256').update(fs.readFileSync(realLedger)).digest('hex');
    let originalHash;
    const counts = {}, blocked = [], injections = [];
    let ticks = 0, lastReport = 0, lastProbe = 0, injectedMissing = false, injectedOutage = false;
    const end = () => { interrupted = true; if (engine) engine.closed = true; };
    const summary = () => ({ diagnostic: true, financialOperations: false, pid: process.pid, runId,
        periodId: config.id, runtimeId: config.runtimeId, startedAt: new Date(started).toISOString(),
        at: new Date().toISOString(), elapsedMs: Date.now() - started, ticks, counts, injections, blocked,
        stopped: store?.state.stopped || null, position: store?.state.position || null,
        reservations: Object.keys(store?.state.seen || {}).length,
        ledgerUnchanged: originalHash === digest(), interrupted,
        bookReady: !!engine?.books.snapshot(), feed: client?.btcStatus(),
        rpcEndpoint: client?.rpc.active === 0 ? 'rpc_primary' : 'rpc_backup' });
    try {
        originalHash = digest();
        const prior = JSON.parse(fs.readFileSync(realLedger, 'utf8'));
        if (prior.position || Object.keys(prior.seen).length || prior.completed.length || prior.ai?.snapshots.length)
            throw new Error('diagnostic_requires_untouched_flat_period');
        const settings = { ...config.settings, dataDir };
        store = new Store(settings, 'pilot', 'late-entry');
        store.state = structuredClone(prior);
        store.state.diagnostic = { sourceLedgerSha256: originalHash, originalStop: prior.stopped, noFinancialOperations: true };
        store.state.stopped = null;
        store.logger = row => {
            counts[row.type] = (counts[row.type] || 0) + 1;
            if (!['provider_preflight', 'heartbeat'].includes(row.type)) console.log(JSON.stringify(row));
        };
        client = new LayaTradingClient(config.settings);
        const facade = readOnlyLiveClient(client, name => blocked.push(name));
        providers = new LayaLiveProvider(config.ai, store.state.ai.providers);
        const preflight = await livePreflight(config, facade, providers, prior);
        atomicJson(path.join(dataDir, 'preflight.json'), preflight.output);
        if (!preflight.output.operationalReady) throw new Error('diagnostic_preflight_failed');
        client.onEvent = ({ type, ...detail }) => store.event(type, detail);
        providers.onEvent = (type, detail) => {
            store.event(type, detail);
            if (type === 'provider_disabled') store.stop('laya_inference_status_unknown');
        };
        const books = new LiveBookHistory({ onEvent: (type, detail) => engine.bookEvent(type, detail) });
        engine = new LayaLiveEngine({ ...config, settings }, store, facade, books, providers);
        engine.beforeReservation = async () => false;
        if (argv.includes('--inject-rpc-faults')) {
            const primary = client.rpc.providers[0], getBlock = primary.getBlock.bind(primary);
            primary.getBlock = async (...args) => {
                if (!injectedMissing && Date.now() - started >= 60000 && client.rpc.anchor) {
                    injectedMissing = true;
                    injections.push({ type: 'primary_missing_block', at: new Date().toISOString() });
                    store.event('diagnostic_fault_injected', injections.at(-1)); return null;
                }
                return getBlock(...args);
            };
            for (const rpc of client.rpc.providers) {
                const getBlockNumber = rpc.getBlockNumber.bind(rpc);
                rpc.getBlockNumber = async (...args) => {
                    const elapsed = Date.now() - started;
                    if (elapsed >= 180000 && elapsed < 190000) {
                        if (!injectedOutage) {
                            injectedOutage = true;
                            injections.push({ type: 'all_rpc_transport_outage', at: new Date().toISOString(), durationMs: 10000 });
                            store.event('diagnostic_fault_injected', injections.at(-1));
                        }
                        throw new OperationalError('diagnostic_rpc_outage', 'transport');
                    }
                    return getBlockNumber(...args);
                };
            }
        }
        process.on('SIGTERM', end); process.on('SIGINT', end);
        store.event('diagnostic_started', { runId, pid: process.pid, minutes, financialOperations: false });
        while (!interrupted && Date.now() - started < minutes * 60000) {
            await engine.tick(); ticks++;
            if (store.state.stopped || blocked.length || store.state.position || Object.keys(store.state.seen).length)
                throw new Error('diagnostic_engine_guard_failed');
            if (Date.now() - lastProbe >= 30000 && !providers.active.size) {
                const health = await providers.preflight(); lastProbe = Date.now();
                if (!health.laya.ready) throw new Error('diagnostic_laya_unavailable');
            }
            if (Date.now() - lastReport >= 5000) {
                atomicJson(path.join(dataDir, 'status.json'), summary()); lastReport = Date.now();
            }
            await delay(engine.nextDelay());
        }
        if (interrupted) throw new Error('diagnostic_interrupted');
        if (argv.includes('--inject-rpc-faults') && (!injectedMissing || !injectedOutage
            || !counts.rpc_failover || !counts.live_rpc_recovery_wait || client.rpc.active !== 0))
            throw new Error('diagnostic_recovery_not_observed');
        if (digest() !== originalHash) throw new Error('diagnostic_source_ledger_changed');
        atomicJson(path.join(dataDir, 'result.json'), { ...summary(), passed: true });
        console.log(JSON.stringify({ type: 'diagnostic_passed', directory: dataDir, ...summary() }));
    } catch (error) {
        atomicJson(path.join(dataDir, 'result.json'), { ...summary(), passed: false, code: operationCode(error) });
        throw error;
    } finally {
        process.off('SIGTERM', end); process.off('SIGINT', end);
        if (engine) await engine.shutdown();
        if (providers) await Promise.allSettled([...providers.active.values()]);
        providers?.close(); client?.close(); await release();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => { console.error(JSON.stringify({ type: 'diagnostic_failed', code: operationCode(error) })); process.exitCode = 1; });
