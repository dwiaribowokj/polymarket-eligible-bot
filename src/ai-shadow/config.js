import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, loadSettings, requireRuntime } from '../restart/config.js';

export const DEADLINE = Date.parse('2026-10-15T09:00:00+07:00');
export const ARMS = ['control', 'laya', '9router'];
import { PROMPT } from './encoding.js';
export { PROMPT, QUESTIONS } from './encoding.js';

export function routerPin(filename, alias) {
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
        const row = db.prepare('SELECT models FROM combos WHERE name = ?').get(alias);
        if (!row) throw new Error('router_alias_missing');
        const models = JSON.parse(row.models);
        if (!Array.isArray(models) || models.length !== 1 || typeof models[0] !== 'string'
            || !models[0].includes('/')) throw new Error('router_alias_requires_one_concrete_model');
        return models[0];
    } finally { db.close(); }
}

export function loadConfig(env = process.env) {
    requireRuntime();
    const control = loadSettings(env, 'late-entry');
    const resolved = env.AI_SHADOW_9ROUTER_RESOLVED_MODEL || null;
    const policy = { schema: 3, featureEncoding: 'cent-offsets-v4-exact-books', deadline: DEADLINE, slots: [90, 60, 30], slotToleranceMs: 2000,
        historyMs: 180000, snapshotWaitMs: 1000, snapshotAgeTargetMs: 1650, snapshotSlotReserveMs: 100, decisionMs: 3000, layaDrainMs: 30000, dataAgeMs: 5000,
        latencyMs: 250, settlementMs: 2500, capital: 20, shares: 5, entryCap: 5,
        executionBook: 'validated-websocket', limitSlippageTicks: 1, limitSlippageUsd: 0.01,
        drawdownStop: 10, shadowDrawdownStop: 2, gasUsd: control.paperGasUsd,
        ninerouterModel: 'polymarket-decision', ninerouterResolvedModel: resolved,
        ninerouterReasoningEffort: 'low', providerMetadataMs: 300000,
        layaModel: 'typed-decisions', prompt: PROMPT, controlBaseline: control.fingerprint,
        inputUsdPerMillion: env.AI_SHADOW_INPUT_USD_PER_MILLION ? Number(env.AI_SHADOW_INPUT_USD_PER_MILLION) : null,
        outputUsdPerMillion: env.AI_SHADOW_OUTPUT_USD_PER_MILLION ? Number(env.AI_SHADOW_OUTPUT_USD_PER_MILLION) : null };
    for (const rate of [policy.inputUsdPerMillion, policy.outputUsdPerMillion])
        if (rate !== null && (!Number.isFinite(rate) || rate < 0)) throw new Error('invalid_ai_rate');
    const sourceDir = path.join(ROOT, 'src/ai-shadow');
    const sources = fs.readdirSync(sourceDir).filter(f => f.endsWith('.js')).sort()
        .map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceDir, f))).digest('hex')]);
    const helper = path.join(ROOT, 'scripts/ai-shadow-tokenizer.py');
    if (fs.existsSync(helper)) sources.push(['tokenizer', crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex')]);
    const entry = path.join(ROOT, 'scripts/ai-shadow.js');
    if (fs.existsSync(entry)) sources.push(['entry', crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex')]);
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, sources })).digest('hex').slice(0, 16);
    return { ...policy, id, sources, root: ROOT, control,
        dataDir: path.resolve(env.AI_SHADOW_DATA_DIR || path.join(ROOT, 'data/ai-shadow')),
        layaUrl: env.AI_SHADOW_LAYA_URL || 'http://127.0.0.1:8090',
        layaContainer: env.AI_SHADOW_LAYA_CONTAINER || 'laya-server',
        ninerouterUrl: env.NINEROUTER_URL || 'http://127.0.0.1:20128/v1',
        ninerouterKey: env.NINEROUTER_KEY || '',
        routerDb: env.AI_SHADOW_ROUTER_DB || path.join(ROOT, '..', '9router-data', 'db', 'data.sqlite'),
    };
}
