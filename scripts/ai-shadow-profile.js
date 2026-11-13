// Bounded historical-input probes; never imports a trading/execution API.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { loadConfig, routerPin } from '../src/ai-shadow/config.js';
import { ProviderManager, TokenCounter } from '../src/ai-shadow/providers.js';
import { atomicJson } from '../src/restart/store.js';
import { safeWindow, StageProfiler, percentiles } from './lib/ai-shadow-profile.js';

dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
const args = process.argv.slice(2);
if (args.length !== 1 || !/^--samples=([1-9]|10)$/.test(args[0])) throw new Error('Use --samples=1..10');
const samples = Number(args[0].split('=')[1]), config = loadConfig();
const activeFile = path.join(config.dataDir, 'active.json');
const readLedger = () => {
    const active = JSON.parse(fs.readFileSync(activeFile));
    if (active.id !== config.id) throw new Error('profile_baseline_changed');
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, config.id, 'ledger.json')));
};
const initial = readLedger(), snapshots = initial.snapshots.slice(-samples);
if (snapshots.length < samples || snapshots.some(s => typeof s.input !== 'string'
    || crypto.createHash('sha256').update(s.input).digest('hex') !== s.inputHash)) throw new Error('profile_input_hash_invalid');
const stopFile = path.join(config.dataDir, 'validation', 'stage-profile-inference-uncertain.json');
if (fs.existsSync(stopFile)) throw new Error('profile_previous_inference_uncertain_manual_review_required');
// Separate diagnostic lock. Never acquires/replaces the running engine's lock.
const lock = path.join(config.dataDir, 'latency-profile.lock');
const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
const artifact = path.join(config.dataDir, 'validation', `stage-profile-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
const report = { generatedAt: new Date().toISOString(), configId: config.id, historicalInputsOnly: true,
    runtimeRestarted: false, decisionMs: config.decisionMs, samplesRequested: samples, rows: [],
    model: config.ninerouterResolvedModel, reasoningEffort: config.ninerouterReasoningEffort,
    limitations: ['small_diagnostic_sample_not_production_p95', 'not_profit_evidence',
        'http_wait_includes_network_server_queue_and_inference', 'no_server_queue_inference_split',
        'probe_api_costs_separate_from_trading_ledgers_local_compute_unpriced',
        'quiet_window_may_differ_from_production_load'] };
let providers;
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
function resources() {
    const result = { at: new Date().toISOString(), loadAverage: os.loadavg(), cpuCount: os.availableParallelism() };
    for (const name of [config.layaContainer, '9router']) {
        try {
            const pid = execFileSync('docker', ['inspect', '--format', '{{.State.Pid}}', name], { timeout: 2000, encoding: 'utf8' }).trim();
            if (!/^\d+$/.test(pid) || pid === '0') throw new Error('container_not_running');
            const group = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').find(s => s.startsWith('0::'))?.slice(3);
            if (!group) throw new Error('cgroup_unavailable');
            const dir = path.join('/sys/fs/cgroup', group);
            const cpu = Object.fromEntries(fs.readFileSync(path.join(dir, 'cpu.stat'), 'utf8').trim().split('\n').map(line => line.split(/\s+/)));
            result[name] = { cpuUsageUs: Number(cpu.usage_usec), throttledUs: Number(cpu.throttled_usec),
                memoryBytes: Number(fs.readFileSync(path.join(dir, 'memory.current'), 'utf8')) };
        } catch { result[name] = { unavailable: true }; }
    }
    return result;
}
async function quiet() {
    const until = Date.now() + 330000; let announced = false;
    while (Date.now() < until) {
        const ledger = readLedger(), reason = safeWindow(Date.now(), ledger, config);
        if (!reason) return;
        if (['baseline_changed', 'deadline_or_frozen', 'heartbeat_stale', 'production_provider_disabled'].includes(reason)) throw new Error(`profile_${reason}`);
        if (!announced) { console.log(JSON.stringify({ waiting: reason, noInferenceSubmitted: true })); announced = true; }
        await delay(1000);
    }
    throw new Error('profile_quiet_window_timeout');
}
try {
    await quiet();
    const profiler = new StageProfiler({ fetch, counter: new TokenCounter(config), pin: () => routerPin(config.routerDb, config.ninerouterModel) });
    providers = new ProviderManager(config, {}, (type, detail) => profiler.event(type, detail),
        { fetch: profiler.fetch, counter: profiler.counter, pin: profiler.pin });
    const start = performance.now(), health = await providers.preflight();
    report.preflightMs = performance.now() - start;
    if (!health.laya.ready || !health['9router'].ready) throw new Error('profile_preflight_failed');
    report.tokenizerIdentity = health.laya.tokenizer.identity;
    if (report.tokenizerIdentity !== initial.providers.laya?.tokenizerIdentity) throw new Error('profile_tokenizer_changed');
    report.resourcesBefore = resources();
    for (const snapshot of snapshots) {
        await quiet();
        const phase = Date.now() % 300000;
        // Guard the injected POST itself as well as the scheduler above.
        const timedFetch = profiler.fetch;
        providers.fetch = (url, options) => {
            if (options?.method === 'POST') {
                const reason = safeWindow(Date.now(), readLedger(), config);
                if (reason) throw new Error('profile_submit_blocked');
            }
            return timedFetch(url, options);
        };
        const decisions = await Promise.all(['laya', '9router'].map(async provider => {
            profiler.begin(provider, snapshot);
            return [provider, await providers.predict(provider, snapshot)];
        }));
        // Await the real HTTP tasks after a decision timeout. The manager keeps
        // its original 3s decision and 30s drain; no POST retries or new queues.
        await Promise.allSettled([...providers.active.values()]);
        await delay(0); // let drained/finally handlers record completion
        for (const [provider, decision] of decisions) {
            const row = profiler.finish(provider, decision); row.marketPhaseMs = phase;
            report.rows.push(row); console.log(JSON.stringify(row));
        }
        if (Object.values(providers.state).some(p => p.disabled)) throw new Error('profile_provider_disabled_stop_probes');
        atomicJson(artifact, report);
    }
    report.resourcesAfter = resources();
    report.summary = Object.fromEntries(['laya','9router'].map(provider => {
        const rows = report.rows.filter(row => row.provider === provider);
        return [provider, { requests: rows.length, timely: rows.filter(row => row.decisionStatus === 'ok').length,
            stagesMs: Object.fromEntries(['localPreparationMs','tokenizerMs','httpHeadersWaitMs','bodyReadMs',
                'jsonParseMs','responseValidationMs','totalMs'].map(key => [key, percentiles(rows.map(row => row[key]))])) }];
    }));
    // Measure durable writes on a disposable COPY, never the active ledger.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-profile-'));
    try {
        const times = [];
        for (let i=0;i<5;i++) { const at=performance.now(); atomicJson(path.join(scratch,'ledger-copy.json'),initial); times.push(performance.now()-at); }
        report.copiedLedgerSaveMs = percentiles(times); report.copiedLedgerBytes = Buffer.byteLength(JSON.stringify(initial,null,2));
    } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
    const latest = readLedger();
    report.finalProof = { configId: latest.id, heartbeat: latest.lastHeartbeatAt, frozenAt: latest.frozenAt,
        sameRuntimeFingerprint: loadConfig().id === config.id, providersPending: Object.fromEntries(Object.entries(latest.providers).map(([k,v])=>[k,!!v.pending])) };
} catch (error) {
    report.errorCode = /^profile_[a-z_]+$/.test(error.message || '') ? error.message : 'profile_failed';
    process.exitCode = 1;
} finally {
    if (providers && (providers.active.size || Object.values(providers.state).some(p =>
        ['inference_unresolved','inference_transport_uncertain'].includes(p.disabled)))) {
        // A new profiler process must not enqueue another POST behind an
        // uncertain server task. Keep this separate from production ledgers.
        atomicJson(stopFile, { at: new Date().toISOString(), configId: config.id,
            reason: 'inference_uncertain_manual_review_required', artifact });
        report.persistentDiagnosticStop = true;
    }
    providers?.close(); lag.disable();
    report.eventLoopDelayMs = { p50: lag.percentile(50)/1e6, p95: lag.percentile(95)/1e6, max: lag.max/1e6 };
    report.finishedAt = new Date().toISOString(); atomicJson(artifact, report); fs.unlinkSync(lock);
    console.log(JSON.stringify({ artifact, summary: report.summary || null, errorCode: report.errorCode || null }));
}
