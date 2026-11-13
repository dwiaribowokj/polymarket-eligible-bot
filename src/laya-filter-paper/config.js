import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, BASELINE, loadSettings, requireRuntime } from '../restart/config.js';
import { decisionProtocolView } from '../laya-live/decision-protocol.js';

export const ARM_NAMES = Object.freeze(['laya', 'spot-twap', 'price-cap-085', 'combined', 'model-edge']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function sourceManifest(root = ROOT) {
    const files = [];
    const visit = dir => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
            const file = path.posix.join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && /\.(?:js|json|cjs)$/.test(file)) files.push(file);
        }
    };
    visit('src');
    files.push('package.json', 'package-lock.json', 'scripts/laya-filter-paper.js', 'scripts/ai-shadow-tokenizer.py');
    return files.sort().map(file => [file, digest(fs.readFileSync(path.join(root, file)))]);
}

export function loadFilterPaperConfig(env = process.env, out) {
    requireRuntime();
    if (!out || !path.isAbsolute(out)) throw new Error('absolute_paper_output_required');
    const dataDir = path.resolve(out);
    // Independent evaluation metadata cannot inherit a live risk epoch or an expired shadow deadline.
    const control = loadSettings({ ...env, RESTART_DATA_DIR: path.join(dataDir, 'settings') }, 'late-entry');
    control.minDays = 7; control.evaluationEndsAt = null;
    const policy = { schema: 3, experiment: 'laya-independent-filter-paper-v3', paperOnly: true,
        armNames: [...ARM_NAMES], capital: 20, shares: 5, entryCap: 5, slots: [90, 60, 30],
        slotToleranceMs: 2000, historyMs: 180000, snapshotWaitMs: 2000, snapshotAgeTargetMs: 1600,
        snapshotSlotReserveMs: 100, decisionMs: 3000, layaDrainMs: 30000, dataAgeMs: 5000,
        decisionTimeoutPolicy: 'snapshot-freshness-budget-v1',
        latencyMs: 250, settlementMs: 2500, executionBook: 'validated-websocket', inferenceReserveMs: 150,
        executionPolicy: 'shared-admission-and-immutable-execution-cohort-v2',
        reportMs: 60000,
        limitSlippageTicks: 1, limitSlippageUsd: 0.01, gasUsd: control.paperGasUsd,
        drawdownStop: 10, shadowDrawdownStop: 2, minDays: 7, minMarkets: 100, bootstrapSamples: 10000,
        deadline: null, maxMarkets: null, layaModel: 'typed-decisions',
        providerMetadataMs: 300000, decisionProtocol: decisionProtocolView(),
        modelEdgePolicy: BASELINE.lateSignal, lateQuality: BASELINE.lateQuality,
        late: BASELINE.late, controlBaseline: control.fingerprint,
        inferencePolicy: 'shared-once-per-snapshot-suspend-while-other-trading-service-active',
        inputUsdPerMillion: null, outputUsdPerMillion: null };
    const sources = sourceManifest(), id = digest(JSON.stringify({ policy, sources })).slice(0, 16);
    return { ...policy, deadline: Number.MAX_SAFE_INTEGER, id, policy, sources, root: ROOT, dataDir, control,
        layaUrl: env.AI_SHADOW_LAYA_URL || 'http://127.0.0.1:8090',
        layaContainer: env.AI_SHADOW_LAYA_CONTAINER || 'laya-server' };
}
