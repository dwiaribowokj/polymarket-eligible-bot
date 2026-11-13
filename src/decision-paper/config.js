import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadFilterPaperConfig, sourceManifest } from '../laya-filter-paper/config.js';
import { INFORMED_PROMPT_SHA256, DECISION_CONTEXT_VERSION } from './features.js';
import { GEMINI_MODEL, GEMINI_ROUTE_MODEL, GEMINI_RESPONSE_MODELS, GEMINI_PROMPT_SHA256 } from './gemini.js';
import { ENTRY_FILTER_POLICY } from './entry-filter.js';

export const DECISION_ARMS = Object.freeze(['laya', 'laya-filtered', 'gemini', 'eligible', 'skip']);
export function loadDecisionPaperConfig(env = process.env, out) {
    const base = loadFilterPaperConfig(env, out);
    const policy = { ...base.policy, schema: 3, experiment: 'decision-paper-v3', armNames: [...DECISION_ARMS],
        geminiModel: GEMINI_MODEL, geminiResolvedModel: GEMINI_ROUTE_MODEL,
        geminiResponseModels: [...GEMINI_RESPONSE_MODELS], geminiPromptHash: GEMINI_PROMPT_SHA256,
        informedPromptHash: INFORMED_PROMPT_SHA256, contextVersion: DECISION_CONTEXT_VERSION,
        geminiMaxOutputTokens: 128, geminiDrainMs: 120000, geminiCooldownMs: 120000,
        geminiTransport: 'bounded-sse-v1', geminiResponsePolicy: 'complete-action-json-v1',
        geminiLatencyPolicy: 'client-observed-phases-v1',
        providerShutdownDrainMs: 30000, providerMetadataMs: 300000,
        geminiRecoveryPolicy: 'bounded-http-drain-and-persistent-cooldown-v1',
        layaConfidencePolicy: 'diagnostics-only-no-entry-threshold',
        entryFilter: { ...ENTRY_FILTER_POLICY },
        executionPolicy: 'independent-providers-shared-laya-filter-cohort-v2',
        inferencePolicy: 'parallel-independent-providers-one-flight-each',
        providerObservationPolicy: 'continue-after-risk-stop-v1',
        comparison: 'configurations-not-isolated-model-effect',
        armPolicies: { laya: 'candidate-v2-original-input', 'laya-filtered': ENTRY_FILTER_POLICY.version,
            gemini: 'informed-cost-closing-twap-v1',
            eligible: 'buy-single-eligible-side-without-ai', skip: 'always-skip' } };
    const sources = sourceManifest();
    for (const file of ['scripts/decision-paper.js', 'scripts/decision-prompt-replay.js'])
        sources.push([file, crypto.createHash('sha256').update(fs.readFileSync(path.join(base.root, file))).digest('hex')]);
    sources.sort(([a], [b]) => a.localeCompare(b));
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, sources })).digest('hex').slice(0, 16);
    return { ...base, ...policy, deadline: Number.MAX_SAFE_INTEGER, id, policy, sources,
        routerUrl: env.NINEROUTER_URL || 'http://127.0.0.1:20128/v1', routerKey: env.NINEROUTER_KEY || '',
        routerDb: env.AI_SHADOW_ROUTER_DB || path.join(base.root, '..', '9router-data', 'db', 'data.sqlite') };
}
