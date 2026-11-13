import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { loadSettings, requireRuntime } from '../src/restart/config.js';
import { atomicJson, readTrials } from '../src/restart/store.js';
import { report } from '../src/restart/report.js';

// Reporting only: never changes trading parameters, orders, stops or trial identity.
requireRuntime();
if (process.argv.length > 2) throw new Error('Use node scripts/restart-checkpoint.js');
const settings = loadSettings(), now = Date.now(), states = readTrials(settings);
const evaluation = report(settings, now, true);
const service = Object.fromEntries(execFileSync('systemctl', ['--user', 'show', 'polymarket-paper.service',
    '-p', 'ActiveState', '-p', 'MainPID', '-p', 'NRestarts', '-p', 'Result'],
{ encoding: 'utf8', timeout: 10000 }).trim().split('\n').map(line => line.split('=')));
const reviews = [];
for (const state of states.filter(Boolean)) {
    const file = path.join(settings.dataDir, settings.fingerprint, 'paper', `${state.strategy}.jsonl`);
    let heartbeat = null;
    if (fs.existsSync(file)) {
        const input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
        for await (const line of input) {
            // The service may be appending its final line during this read.
            try { const row = JSON.parse(line); if (row.type === 'heartbeat') heartbeat = row; }
            catch { /* A partial last event is unavailable evidence, never a fabricated heartbeat. */ }
        }
    }
    const elapsedHours = (now - state.startedAt) / 3600000;
    const filled = state.completed.filter(r => r.traded);
    const diagnostics = state.diagnostics || {};
    const riskFlags = [];
    if (state.stopped) riskFlags.push(state.stopped.reason);
    if (state.shadowPilotStop) riskFlags.push('shadow_pilot_drawdown_limit');
    if (state.dataGaps || filled.some(r => r.uncertain)) riskFlags.push('incomplete_execution_data');
    const finished = !!(state.frozenAt || state.stopped) && !state.position;
    if (!finished && service.ActiveState !== 'active') riskFlags.push('paper_service_inactive');
    if (!finished && (!state.lastTickAt || now - state.lastTickAt > 90000)) riskFlags.push('paper_tick_stale');
    if (!finished && (!heartbeat || now - Date.parse(heartbeat.at) > 120000)) riskFlags.push('heartbeat_stale');
    const checkpoint = riskFlags.length ? 'review_sekarang'
        : finished ? 'periode_selesai'
        : !filled.length && elapsedHours >= 24 ? 'review_coverage_tanpa_fill'
        : filled.length >= 10 || elapsedHours >= 24 ? 'evaluasi_awal'
        : elapsedHours >= 12 ? 'evaluasi_operasional_12_jam' : 'pengumpulan_data_awal';
    const schedule = [12, 24].map(hours => ({ hours,
        at: new Date(state.startedAt + hours * 3600000).toISOString(), reached: elapsedHours >= hours }));
    reviews.push({ strategy: state.strategy, checkpoint, provisional: !finished, riskFlags,
        elapsedHours: Math.round(elapsedHours * 100) / 100,
        completedFilledMarkets: filled.length, wins: filled.filter(r => r.pnl > 0).length,
        losses: filled.filter(r => r.pnl < 0).length,
        entryAttempts: Object.keys(state.seen).length,
        noFillAttempts: diagnostics.noFillAttempts || 0, expiredAttempts: diagnostics.signalExpired || 0,
        decisionChecks: diagnostics.decisionChecks || 0,
        skippedMarkets: Object.keys(state.skipped || {}).filter(slug => !state.seen[slug]).length,
        dominantSkipReasons: Object.entries(diagnostics.reasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
        heartbeat: heartbeat ? { at: heartbeat.at, feedReady: heartbeat.btcFeed?.ready,
            feedAgeAtHeartbeatMs: heartbeat.btcFeed?.ageMs } : null,
        schedule, completedMarketCheckpoint: { required: 10, reached: filled.length >= 10 },
        nextAction: riskFlags.length ? 'review_operasi_dan_risiko_tanpa_reset_stop'
            : !filled.length && elapsedHours >= 24 ? 'audit_peluang_dan_eksekusi_tanpa_memaksa_fill'
                : 'nilai_hasil_sementara_tanpa_mengubah_parameter',
        liveDecision: 'belum_layak',
        liveRequirementsUnchanged: { minimumDays: settings.minDays, minimumFilledMarkets: settings.minMarkets,
            researchOnly: settings.lateSignal?.researchOnly || false },
    });
}
const checkpoint = { generatedAt: new Date(now).toISOString(), baseline: settings.fingerprint,
    experiment: settings.experiment, service, earlyReviews: reviews, evaluation };
const directory = path.join(settings.dataDir, settings.fingerprint, 'checkpoints');
const filename = path.join(directory, `${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
atomicJson(filename, checkpoint); atomicJson(path.join(directory, 'latest.json'), checkpoint);
console.log(JSON.stringify({ type: 'paper_early_checkpoint', filename, baseline: settings.fingerprint,
    service, earlyReviews: reviews }));
