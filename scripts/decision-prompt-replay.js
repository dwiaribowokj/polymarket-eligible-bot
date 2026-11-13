#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { ProtocolCounter } from '../src/laya-tuning/counter.js';
import { requireRuntime } from '../src/restart/config.js';
import { REPLAY_SERVICES, runPromptReplay, verifyReplayServices } from '../src/decision-paper/replay.js';

export function parseReplayArgs(argv) {
    const options = {};
    for (const arg of argv) {
        const match = arg.match(/^--(ledger|out|pairs)=(.+)$/);
        if (!match || options[match[1]] !== undefined) throw new Error('prompt_replay_options_invalid');
        options[match[1]] = match[2];
    }
    if (!options.ledger || !path.isAbsolute(options.ledger) || !options.out || !path.isAbsolute(options.out))
        throw new Error('prompt_replay_absolute_paths_required');
    const pairs = Number(options.pairs ?? 4);
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 12) throw new Error('prompt_replay_pair_count_invalid');
    return { ledgerFile: path.resolve(options.ledger), out: path.resolve(options.out), pairs };
}

export function serviceGuard(execute = execFileSync) {
    const stdout = execute('systemctl', ['--user', 'show', ...REPLAY_SERVICES,
        '--property=Id,ActiveState,SubState,MainPID'], { encoding: 'utf8', timeout: 1000, maxBuffer: 16384 });
    const rows = String(stdout).trim().split(/\n\s*\n/).map(block =>
        Object.fromEntries(block.split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; })));
    return verifyReplayServices(rows);
}

export async function main(argv = process.argv.slice(2)) {
    const options = parseReplayArgs(argv);
    requireRuntime();
    dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const counter = new ProtocolCounter({ root, layaContainer: process.env.AI_SHADOW_LAYA_CONTAINER || 'laya-server' });
    try {
        const result = await runPromptReplay({ ...options, counter, guard: serviceGuard,
            url: process.env.AI_SHADOW_LAYA_URL || 'http://127.0.0.1:8090',
            reservationDir: path.join(os.homedir(), '.cache/laya-polymarket-tuning') });
        console.log(JSON.stringify(result, null, 2));
        if (result.status !== 'completed') process.exitCode = 1;
    } finally { counter.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(error => { console.error(/^prompt_replay_|^protocol_|^snapshot_/.test(error.message)
        ? error.message : 'prompt_replay_failed'); process.exitCode = 1; });
