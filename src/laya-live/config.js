import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../ai-shadow/config.js';
import { bindContinuation } from './recovery.js';
import { loadProfitTakingConfig } from './profit-taking.js';
import { decisionProtocolView } from './decision-protocol.js';
import { LIVE_CLOCK } from './clock.js';

export const LIVE_GUARDS = Object.freeze({ explicitActivation: true, automaticActivation: false,
    rehearsalEvidenceRequired: false, rehearsalRiskStop: false, persistentPilotStop: true,
    sharedPilotHistory: true, recoveryWithoutNewEntries: true });

// Deliberately allowlist public fields. Never serialize settings or ai: both
// include credentials and may contain token-bearing endpoint URLs.
export function liveConfigView(config) {
    const { policy, ai, settings } = config;
    return { id: config.id, runtimeId: config.runtimeId || config.id, mode: 'live', provider: policy.provider, model: policy.model,
        nodeMajor: 24, sdk: settings.sdk, collateral: 'pUSD', chainId: 137,
        limits: { capital: policy.capital, entryCap: policy.entryCap, shares: policy.shares,
            drawdownStop: policy.drawdownStop, pilotMarkets: policy.pilotMarkets, pilotHours: policy.pilotHours },
        funding: { allocation: policy.capitalAllocation, minimumBalance: policy.minimumBalance, capitalCap: policy.capital },
        execution: { orderType: 'FAK', partialFill: 'accept_without_retry',
            decisionMs: ai.decisionMs, dataAgeMs: ai.dataAgeMs, historyMs: ai.historyMs,
            slots: ai.slots, minSeconds: settings.late.minSeconds, maxSeconds: settings.late.maxSeconds,
            minPrice: settings.late.minPrice, maxPrice: settings.late.maxPrice,
            lastSeconds: settings.late.lastSeconds, lastMinPrice: settings.late.lastMinPrice },
        decisionProtocol: ai.decisionProtocol, clock: LIVE_CLOCK,
        guards: policy.guards, qualification: policy.qualification, paperEvidence: policy.paperEvidence,
        activation: policy.activation, profitTaking: config.profitTaking,
        readOnlyCommands: ['config', 'preflight', 'report'] };
}

export function loadLiveConfig(env = process.env) {
    const ai = loadConfig(env), root = ai.root, profitTaking = loadProfitTakingConfig(env);
    const rehearsalDataDir = path.resolve(env.LAYA_PAPER_DATA_DIR || path.join(root, 'data/laya-pilot'));
    const policy = { schema: 4, provider: 'laya', model: 'typed-decisions', capital: null,
        entryCap: 5, shares: 5, drawdownStop: 10, pilotMarkets: null, pilotHours: null,
        minimumBalance: 0, capitalAllocation: 'available_balance', paperEvidence: 'report_only',
        controlBaseline: ai.control.fingerprint, aiSource: ai.id,
        qualification: 'unqualified_research_pilot', activation: 'explicit_run_live_only', guards: LIVE_GUARDS,
        rehearsalDataIdentity: crypto.createHash('sha256').update(rehearsalDataDir).digest('hex') };
    const sources = fs.readdirSync(path.join(root, 'src/laya-live')).filter(f => f.endsWith('.js')).sort()
        .map(f => [`src/laya-live/${f}`, fs.readFileSync(path.join(root, 'src/laya-live', f))]);
    for (const file of ['scripts/laya-live.js', 'scripts/laya-live-control.js', 'scripts/laya-live',
        'deploy/polymarket-laya-live.service', 'src/laya-pilot/provider.js',
        'src/laya-tuning/protocol.js', 'src/laya-tuning/counter.js'])
        if (fs.existsSync(path.join(root, file))) sources.push([file, fs.readFileSync(path.join(root, file))]);
    const hashes = sources.map(([file, bytes]) => [file, crypto.createHash('sha256').update(bytes).digest('hex')]);
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, hashes, profitTaking })).digest('hex').slice(0, 16);
    // The new Store starts at zero; explicit activation seeds it from the
    // real wallet snapshot before the engine can make any entry decision.
    return bindContinuation({ id, root, policy, profitTaking, rehearsalDataDir, sources: hashes,
        settings: { ...ai.control, fingerprint: id, experiment: 'laya-typed-decisions-live-v1',
            capital: 0, shares: 5, entryCap: 5, drawdownStop: policy.drawdownStop, pilotMarkets: Infinity, pilotHours: Infinity },
        ai: { ...ai, id, decisionProtocol: decisionProtocolView(), deadline: Number.MAX_SAFE_INTEGER,
            capital: 0, shares: 5, entryCap: 5, drawdownStop: policy.drawdownStop } });
}
