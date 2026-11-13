#!/usr/bin/env node
// Bounded historical decision replay. No trading client or wallet writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ProtocolCounter } from '../src/laya-tuning/counter.js';
import { buildProtocolRequest, verifyProtocolContext } from '../src/laya-tuning/protocol.js';
import { digest, LIMITATIONS, quietGuard, selectSnapshots, summarize, replayPair, save, ensureDirectory } from '../src/laya-tuning/replay.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2), options = {};
for (const arg of args) {
    if (arg === '--history') { options.history = true; continue; }
    const match = arg.match(/^--(source|labels|live-ledger|out|pairs|candidate)=(.+)$/);
    if (!match || options[match[1]] !== undefined) throw new Error('Use preflight|replay|report [--source=FILE --labels=FILE --live-ledger=FILE --out=DIR --pairs=1..12 --candidate=candidate-v1|candidate-v2] [--history]');
    options[match[1]] = match[2];
}
const out = path.resolve(options.out || path.join(root, 'data/laya-tuning'));
if (command === 'report') {
    const files = fs.existsSync(out) ? fs.readdirSync(out).filter(name => /^replay-.+\.json$/.test(name)).sort() : [];
    const reports = (options.history ? files : files.slice(-1)).map(name => {
        const report = JSON.parse(fs.readFileSync(path.join(out, name)));
        return { artifact: path.join(out, name), startedAt: report.startedAt, finishedAt: report.finishedAt,
            status: report.status, summary: report.summary, limitations: report.limitations };
    });
    console.log(JSON.stringify({ reports }, null, 2));
    process.exit(0);
}
if (!['preflight', 'replay'].includes(command) || !options.source || !options['live-ledger']) throw new Error('tune_source_and_live_ledger_required');
const candidateId = options.candidate || 'candidate-v1';
if (!['candidate-v1', 'candidate-v2'].includes(candidateId)) throw new Error('tune_candidate_unknown');
// Deliberately one local server, no endpoint/model fallback or remote key.
const endpoint = new URL('http://127.0.0.1:8090');
const sourceBytes = fs.readFileSync(path.resolve(options.source)), source = JSON.parse(sourceBytes);
const livePath = path.resolve(options['live-ledger']);
const live = () => JSON.parse(fs.readFileSync(livePath));
const expectedIdentity = live().ai?.providers?.laya?.tokenizerIdentity;
if (!expectedIdentity) throw new Error('tune_tokenizer_identity_required');
const labelBytes = options.labels ? fs.readFileSync(path.resolve(options.labels)) : null;
const labelEvidence = labelBytes ? JSON.parse(labelBytes) : null;
const labels = labelEvidence?.labels || [];
const snapshots = selectSnapshots(source.ai?.snapshots || [], Number(options.pairs || 6),
    labelBytes ? new Set(labels.map(row => row.slug)) : null);
const service = () => Object.fromEntries(execFileSync('systemctl', ['--user', 'show', 'polymarket-laya-live.service',
    '--property=ActiveState,SubState,MainPID,NRestarts'], { encoding: 'utf8' }).trim().split('\n').map(line => line.split('=')));
const expectedService = service(), expectedPid = Number(expectedService.MainPID);
const guard = () => {
    for (const unit of ['polymarket-laya-paper.service', 'polymarket-ai-shadow.service', 'polymarket-paper.service']) {
        const active = execFileSync('systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
        if (!['inactive', 'failed'].includes(active)) throw new Error('tune_other_experiment_active');
    }
    return quietGuard({ now: Date.now(), service: service(), ledger: live(), expectedPid, expectedTokenizer: expectedIdentity });
};
const counter = new ProtocolCounter({ root, layaContainer: 'laya-server' });
const artifact = path.join(out, `replay-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.json`);
const report = { startedAt: Date.now(), status: 'preflight', candidateVariant: candidateId, sourceHash: digest(sourceBytes),
    labelsHash: labelBytes ? digest(labelBytes) : null, labelBlock: labelEvidence?.block ?? null,
    labelBlockHash: labelEvidence?.blockHash ?? null, expectedIdentity, service: expectedService,
    selection: 'first_per_market_balanced_by_allowed_side_not_outcome',
    snapshots: snapshots.map(s => ({ snapshotId: s.snapshotId, market: s.market, inputHash: s.inputHash })),
    context: [], rows: [], limitations: LIMITATIONS };
let lock, locked = false;
// One reservation for this user's local Laya, across output paths and checkouts.
const reservations = path.join(os.homedir(), '.cache/laya-polymarket-tuning');
const uncertainFile = path.join(reservations, 'inference-uncertain.json');
try {
    ensureDirectory(out);
    ensureDirectory(reservations);
    if (fs.existsSync(uncertainFile)) throw new Error('tune_inference_uncertain');
    lock = path.join(reservations, 'replay.lock');
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); locked = true;
    const healthResponse = await fetch(endpoint.href + 'health', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!healthResponse.ok || !(await healthResponse.json()).loaded?.includes('typed-decisions')) throw new Error('tune_model_not_loaded');
    // Check ALL archived inputs against BOTH prompts, not just selected rows.
    for (const snapshot of source.ai?.snapshots || []) {
        for (const variantId of ['baseline-v1', candidateId]) {
            const protocol = buildProtocolRequest(snapshot, { variantId });
            report.context.push(await verifyProtocolContext(protocol, counter, { expectedIdentity }));
        }
    }
    if (command === 'replay') {
        report.status = 'running'; save(artifact, report);
        for (const [pairIndex, snapshot] of snapshots.entries()) {
            await replayPair(snapshot, { counter, expectedIdentity, guard, url: endpoint.href.replace(/\/$/, ''), uncertainFile, pairIndex, candidateId,
                persist: async row => { report.rows.push(row); save(artifact, report); } });
        }
    }
    report.status = command === 'preflight' ? 'preflight_passed' : 'completed';
} catch (error) {
    report.status = 'stopped'; report.reason = /^tune_|^protocol_/.test(error.message) ? error.message : 'tune_check_failed';
    process.exitCode = 1;
} finally {
    counter.close();
    report.finishedAt = Date.now(); report.summary = summarize(report.rows, labels, candidateId); save(artifact, report);
    if (locked) fs.unlinkSync(lock);
    console.log(JSON.stringify({ artifact, status: report.status, reason: report.reason ?? null,
        contextChecks: report.context.length, maxTokens: report.context.length ? Math.max(...report.context.map(c => c.tokens)) : null,
        summary: report.summary }, null, 2));
}
