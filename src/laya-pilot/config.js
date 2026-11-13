import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../ai-shadow/config.js';

// A new rehearsal, never an extension of the completed October 15 experiment.
export function loadLayaConfig(env = process.env, now = Date.now()) {
    const base = loadConfig(env);
    const dataDir = path.resolve(env.LAYA_PAPER_DATA_DIR || path.join(base.root, 'data/laya-pilot'));
    const policy = { schema: 1, provider: 'laya', model: 'typed-decisions', capital: 20,
        drawdownStop: 2, shadowDrawdownStop: 2, maxMarkets: 30, hours: 48,
        shares: 5, entryCap: 5, decisionMs: 3000, dataAgeMs: 5000,
        sourceExperiment: base.id, purpose: 'paper_pilot_rehearsal' };
    const sources = fs.readdirSync(path.join(base.root, 'src/laya-pilot')).filter(f => f.endsWith('.js')).sort()
        .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(base.root, 'src/laya-pilot', file))).digest('hex')]);
    const entry = path.join(base.root, 'scripts/laya-pilot.js');
    if (fs.existsSync(entry)) sources.push(['entry', crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex')]);
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, sources })).digest('hex').slice(0, 16);
    const marker = path.join(dataDir, 'active.json');
    const active = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker)) : null;
    if (active && (active.id !== id || !Number.isFinite(active.deadline))) throw new Error('laya_period_identity_changed');
    // Startup of preflight alone does not persist a start time or a deadline.
    return { ...base, ...policy, id, sources, dataDir, deadline: active?.deadline ?? now + policy.hours * 3600000 };
}
