import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { TRANSPORT } from './network.js';
import CALIBRATION_MODEL from './calibration-model.json' with { type: 'json' };

if (CALIBRATION_MODEL.schema !== 1 || CALIBRATION_MODEL.method !== 'probit_temperature_v1'
    || !(CALIBRATION_MODEL.temperature >= 1 && CALIBRATION_MODEL.temperature <= 8)
    || CALIBRATION_MODEL.trainingMarkets < 20 || CALIBRATION_MODEL.validationMarkets < 10
    || CALIBRATION_MODEL.trainedThrough > CALIBRATION_MODEL.validationStartsAt
    || !CALIBRATION_MODEL.heldOutImproved || CALIBRATION_MODEL.status !== 'provisional'
    || CALIBRATION_MODEL.researchOnly !== true || CALIBRATION_MODEL.qualifiedForLive !== false)
    throw new Error('Invalid research calibration artifact');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

export const BASELINE = Object.freeze({
    schema: 1, sdk: '0.12.0', asset: 'btc', capital: 20, entryCap: 5,
    shares: 5, drawdownStop: 2, pilotMarkets: 30, pilotHours: 48,
    minDays: 7, minMarkets: 100, bootstrapSamples: 10000,
    latencyMs: 250, paperSettlementMs: 2500, cancelReconcileMs: 30000,
    experiment: 'late-twap-temperature-v4', paperDrawdownStop: 10, paperShadowDrawdownStop: 2,
    lateSignal: Object.freeze({ researchOnly: true, maxAgeMs: 5000, maxGapMs: 5000,
        lookbackSeconds: 180, referenceMaxAgeMs: 330000, maxFeedDifferenceUsd: 3,
        volatilityFloorUsd: 1, volatilityMultiplier: 1.5, referenceBufferUsd: 3,
        minMarginUsd: 5, minZ: 1.5, minModelEdge: 0.05,
        calibration: Object.freeze(CALIBRATION_MODEL) }),
    // Capped taker orders recheck the quote and signal at execution instead of waiting for a flat price.
    lateQuality: Object.freeze({ maxSpread: 0.02, minDepth: 5, stableMs: 0,
        maxMove: 0.02, maxSampleGapMs: 2500 }),
    maxDataAgeMs: 5000, maxClockSkewMs: 2000,
    transport: TRANSPORT,
    late: Object.freeze({ duration: 300, minSeconds: 10, maxSeconds: 90, minPrice: 0.72,
        maxPrice: 0.90, lastSeconds: 20, lastMinPrice: 0.80 }),
    maker: Object.freeze({ duration: 900, delaySeconds: 10, entrySeconds: 45,
        cutSeconds: 60, maxCombined: 0.98 }),
});

export function loadSettings(env = process.env, strategy = env.RESTART_PAPER_STRATEGY || 'late-entry') {
    if (!['late-entry', 'maker-mm'].includes(strategy)) throw new Error('Unknown paper strategy');
    const strategies = [strategy];
    const paperGasUsd = Number(env.RESTART_PAPER_GAS_USD ?? '0.05');
    if (!Number.isFinite(paperGasUsd) || paperGasUsd <= 0) throw new Error('RESTART_PAPER_GAS_USD must be positive');
    const sourceDir = path.join(ROOT, 'src/restart');
    const source = fs.readdirSync(sourceDir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(sourceDir, f), 'utf8')).join('\n');
    const dataDir = path.resolve(env.RESTART_DATA_DIR || path.join(ROOT, 'data/restart'));
    const evaluationFile = path.join(dataDir, 'evaluation.json');
    const evaluation = fs.existsSync(evaluationFile) ? JSON.parse(fs.readFileSync(evaluationFile, 'utf8')) : null;
    const minDays = evaluation?.minDays ?? BASELINE.minDays;
    const evaluationEndsAt = evaluation ? Date.parse(evaluation.endsAt) : null;
    if (!Number.isInteger(minDays) || minDays < 2 || minDays > 30
        || evaluation && !Number.isFinite(evaluationEndsAt)) throw new Error('Invalid evaluation schedule');
    const trialFile = path.join(dataDir, 'trial.json');
    const trialId = fs.existsSync(trialFile) ? JSON.parse(fs.readFileSync(trialFile, 'utf8')).id : 'initial';
    if (typeof trialId !== 'string' || !trialId) throw new Error('Invalid trial identity');
    const primaryRpc = env.POLYGON_RPC_URL || 'https://polygon.drpc.org';
    const defaultBackup = new URL(primaryRpc).hostname === 'polygon-bor-rpc.publicnode.com'
        ? 'https://polygon.drpc.org' : 'https://polygon-bor-rpc.publicnode.com';
    const rpcUrls = [primaryRpc, env.POLYGON_RPC_BACKUP_URL || defaultBackup];
    for (const url of rpcUrls) if (!['https:', 'http:'].includes(new URL(url).protocol)) throw new Error('Invalid RPC configuration');
    if (new URL(rpcUrls[0]).href === new URL(rpcUrls[1]).href) throw new Error('RPC backup must differ from primary');
    const rpcIdentity = crypto.createHash('sha256').update(JSON.stringify(rpcUrls)).digest('hex');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ ...BASELINE, minDays, evaluationEndsAt, paperGasUsd, trialId, strategies, rpcIdentity }))
        .update(source).update(fs.readFileSync(path.join(ROOT, 'src/restart.js'), 'utf8'))
        .update(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).digest('hex').slice(0, 16);
    return {
        ...BASELINE, minDays, evaluationEndsAt, paperGasUsd, fingerprint, trialId, dataDir, strategies,
        rpcUrl: rpcUrls[0], rpcUrls,
        wallet: env.PROXY_WALLET_ADDRESS || '', privateKey: env.PRIVATE_KEY || '',
        credentials: env.CLOB_API_KEY && env.CLOB_API_SECRET && env.CLOB_API_PASSPHRASE
            ? { key: env.CLOB_API_KEY, secret: env.CLOB_API_SECRET, passphrase: env.CLOB_API_PASSPHRASE } : null,
    };
}

export function requireRuntime() {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Reactivation requires Node.js 24');
}
