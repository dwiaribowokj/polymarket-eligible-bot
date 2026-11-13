#!/usr/bin/env node
// Local files only. No dotenv, trading clients, network calls, signing or inference.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, acquireLock } from '../src/restart/store.js';
import { hash, createExperiment, validateExperiment, observe, report } from '../src/laya-filter-shadow/evaluation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseArgs(argv) {
    const [command, ...flags] = argv, options = {};
    if (!['init', 'run', 'report'].includes(command)) throw new Error('filter_shadow_use_init_run_report');
    for (const flag of flags) {
        const match = /^--(source|out)=(.+)$/.exec(flag);
        if (!match || Object.hasOwn(options, match[1])) throw new Error('filter_shadow_argument_invalid');
        options[match[1]] = path.resolve(match[2]);
    }
    if (!options.out || command === 'init' && !options.source || command !== 'init' && options.source)
        throw new Error('filter_shadow_explicit_paths_required');
    return { command, ...options };
}
export function codeHash() {
    return hash(['src/laya-filter-shadow/evaluation.js', 'scripts/laya-filter-shadow.js', 'src/restart/store.js']
        .map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
}
function markdown(view) {
    const lines = ['# Evaluasi filter Laya', '',
        `Status: ${view.status}. Terdaftar: ${new Date(view.registeredAt).toISOString()}.`,
        `Snapshot: ${view.counts.captured}; hasil filled: ${view.counts.scored}; hari WIB: ${view.counts.daysWIB}.`, '',
        'Evaluasi veto atas entry Laya yang benar-benar terjadi. Belum cukup untuk keputusan live; tidak ada perubahan live otomatis.', '',
        '| Kandidat | Dipertahankan | Dilewati | Loss terhindar | Win terlewat | PnL kondisional | Selisih kontrol |',
        '|---|---:|---:|---:|---:|---:|---:|'];
    for (const [name,c] of Object.entries(view.candidates)) lines.push(`| ${name} | ${c.retained} | ${c.vetoed} | ${c.avoidedLosses} | ${c.missedWins} | ${c.conditionalPnl.toFixed(6)} | ${c.differenceFromControl.toFixed(6)} |`);
    lines.push('', 'Spot–TWAP harus sama-sama searah dengan sisi entry; delta nol dilewati. Kandidat harga memakai limit maksimum $0,85. Gabungan menerapkan keduanya.', '',
        'Biaya trading/gas sudah termasuk sekali pada PnL. Biaya AI belum diketahui. Drawdown laporan hanya dari hasil selesai, tanpa valuasi inventory terbuka.', '',
        'Filter dinilai sebelum keputusan; tidak membuka entry pengganti atau menyimulasikan perubahan modal. Perubahan identitas model/prompt menghentikan pengambilan sampel baru untuk periode ini.', '',
        `Minimum bukti tercapai: ${view.minimumEvidence}. Interval bootstrap per hari tersedia setelah 7 hari dan 100 filled market pada cohort yang sama. Hasil ini tetap tidak menjadi kelulusan live otomatis.`, '',
        'Lihat report.json untuk exclusions, error pembacaan, identitas periode, aturan tetap, interval statistik, dan keterbatasan.', '');
    return lines.join('\n');
}
function writeReports(out, state, now) {
    const view = report(state, now);
    atomicJson(path.join(out, 'report.json'), view);
    const target = path.join(out, 'report.md'), tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, markdown(view), { mode: 0o600 }); fs.renameSync(tmp, target);
    return view;
}
export async function main(argv = process.argv.slice(2)) {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('filter_shadow_node_24_required');
    const args = parseArgs(argv), filename = path.join(args.out, 'state.json'), pin = codeHash();
    if (args.command === 'report') {
        const state = JSON.parse(fs.readFileSync(filename)); validateExperiment(state, pin);
        console.log(JSON.stringify(report(state, Date.now()), null, 2)); return;
    }
    fs.mkdirSync(args.out, { recursive: true, mode: 0o700 });
    const release = await acquireLock(args.out, 'observer');
    const shutdown = new AbortController();
    const end = () => shutdown.abort();
    process.on('SIGTERM', end); process.on('SIGINT', end);
    try {
        if (args.command === 'init') {
            if (fs.existsSync(filename)) throw new Error('filter_shadow_period_already_exists');
            const source = fs.realpathSync(args.source), out = fs.realpathSync(args.out);
            if (source === filename || path.dirname(source) === out) throw new Error('filter_shadow_output_must_be_separate');
            const bytes = fs.readFileSync(source), now = Date.now();
            const state = createExperiment(JSON.parse(bytes), { now, sourcePath: source, codeHash: pin, sourceHash: hash(bytes) });
            atomicJson(path.join(args.out, 'manifest.json'), { id: state.id, ...state.manifest });
            atomicJson(filename, state); writeReports(args.out, state, now);
            console.log(JSON.stringify({ type: 'filter_shadow_registered', id: state.id,
                firstMarketOpenAt: state.manifest.firstMarketOpenAt, out: args.out })); return;
        }
        const state = JSON.parse(fs.readFileSync(filename)); validateExperiment(state, pin);
        let lastReport = 0, lastSaved = 0, lastSourceStamp = null;
        console.log(JSON.stringify({ type: 'filter_shadow_started', id: state.id, pid: process.pid }));
        while (!shutdown.signal.aborted) {
            const now = Date.now();
            let stamp, changed = false;
            try {
                const stat = fs.statSync(state.manifest.sourcePath);
                stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
                if (stamp !== lastSourceStamp) {
                    const source = JSON.parse(fs.readFileSync(state.manifest.sourcePath));
                    observe(state, source, Date.now()); lastSourceStamp = stamp; changed = true;
                } else { state.lastPollAt = now; state.lastSuccessfulReadAt = Date.now(); }
                state.lastReadError = null;
            } catch (error) {
                state.sourceReadErrors = (state.sourceReadErrors || 0) + 1;
                state.lastReadError = { at: now, code: error.message?.startsWith('filter_shadow_')
                    ? error.message : 'filter_shadow_source_read_failed' };
                if (error.message?.startsWith('filter_shadow_')) {
                    state.captureStopped ||= { at: now, reason: error.message };
                    atomicJson(filename, state); writeReports(args.out, state, now);
                    throw new Error('filter_shadow_source_semantics_changed');
                }
            }
            if (changed || now - lastSaved >= 10000) {
                atomicJson(filename, state); lastSaved = now;
            }
            if (now - lastReport >= 60000) {
                const view = writeReports(args.out, state, now); lastReport = now;
                console.log(JSON.stringify({ type: 'filter_shadow_heartbeat', id: state.id,
                    captured: view.counts.captured, scored: view.counts.scored,
                    sourceReadErrors: view.counts.sourceReadErrors, captureStopped: state.captureStopped }));
            }
            try { await sleep(500, undefined, { signal: shutdown.signal }); }
            catch (error) { if (error.name !== 'AbortError') throw error; }
        }
        atomicJson(filename, state); writeReports(args.out, state, Date.now());
    } finally {
        process.off('SIGTERM', end); process.off('SIGINT', end); await release();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(JSON.stringify({ type: 'filter_shadow_failed', code: error.message?.startsWith('filter_shadow_')
            ? error.message : 'filter_shadow_failed' })); process.exitCode = 1;
    });
}
