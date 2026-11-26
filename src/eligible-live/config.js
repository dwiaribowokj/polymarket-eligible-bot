import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { ROOT, loadSettings, requireRuntime } from '../restart/config.js';
import { loadProfitTakingConfig } from '../laya-live/profit-taking.js';
import { ELIGIBLE_MODEL } from './provider.js';
import { bindRiskPeriod } from './period.js';
import { bindRuntimeContinuation } from './continuation.js';
import { validateEligibleEntryFilter } from './entry-cost-cap.js';
import { ELIGIBLE_BUFFER_POLICY, validateEligibleEntryPolicy } from './entry-buffer.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function eligibleEnvironment(env = process.env, home = os.homedir()) {
    const filename = env.ELIGIBLE_LIVE_CONFIG || path.join(home, '.config/polymarket-eligible-live.env');
    if (!path.isAbsolute(filename)) throw new Error('eligible_config_requires_absolute_path');
    const read = (file, optional = false) => {
        try { return dotenv.parse(fs.readFileSync(file)); }
        catch (error) {
            if (optional && error.code === 'ENOENT') return {};
            throw new Error('eligible_environment_unreadable');
        }
    };
    const privateEnv = read(filename, !env.ELIGIBLE_LIVE_CONFIG);
    const external = env.POLYMARKET_ENV_FILE || privateEnv.POLYMARKET_ENV_FILE;
    if (external && !path.isAbsolute(external)) throw new Error('eligible_env_requires_absolute_path');
    return { ...(external ? read(external) : {}), ...privateEnv, ...env };
}

export function eligibleSources(root = ROOT) {
    const files = [];
    const visit = dir => {
        for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
            const name = path.posix.join(dir, entry.name);
            if (entry.isDirectory()) visit(name);
            else if (entry.isFile() && /\.(js|json|cjs)$/.test(name)) files.push(name);
        }
    };
    visit('src');
    files.push('package.json', 'package-lock.json', 'scripts/eligible-live.js',
        'scripts/eligible-live-control.js', 'scripts/eligible-recover-signal.js', 'scripts/eligible-recover-action.js',
        'scripts/eligible-recover-wallet.js', 'scripts/eligible-recover-trade.js', 'scripts/eligible-migrate-cost-cap.js',
        'scripts/eligible-migrate-buffer.js', 'scripts/eligible-return-cost-cap.js',
        'scripts/eligible-reconcile-manual.js', 'scripts/poly', 'scripts/device.js', 'scripts/laya-live-control.js',
        'deploy/polymarket-eligible-live.service');
    return files.sort().map(file => [file, digest(fs.readFileSync(path.join(root, file)))]);
}

import { ELIGIBLE_BINANCE_LEAD_VETO } from './binance-lead.js';

export function loadEligibleConfig(env = process.env) {
    requireRuntime();
    if (env.ELIGIBLE_CONTINUOUS_TRADING !== undefined
        && !['true', 'false'].includes(env.ELIGIBLE_CONTINUOUS_TRADING))
        throw new Error('invalid_eligible_continuous_trading');
    const continuousTrading = env.ELIGIBLE_CONTINUOUS_TRADING === 'true';
    const base = loadSettings(env, 'late-entry'), profitTaking = loadProfitTakingConfig(env);
    if (env.ELIGIBLE_ENTRY_COST_CAP !== undefined && !['true', 'false'].includes(env.ELIGIBLE_ENTRY_COST_CAP))
        throw new Error('invalid_eligible_entry_cost_cap');
    if (env.ELIGIBLE_ENTRY_BUFFER !== undefined && !['true', 'false'].includes(env.ELIGIBLE_ENTRY_BUFFER))
        throw new Error('invalid_eligible_entry_buffer');
    if (env.ELIGIBLE_ENTRY_BINANCE_LEAD_VETO !== undefined
        && !['true', 'false'].includes(env.ELIGIBLE_ENTRY_BINANCE_LEAD_VETO))
        throw new Error('invalid_eligible_entry_binance_lead_veto');
    if (env.ELIGIBLE_ENTRY_BUFFER === 'true' && env.ELIGIBLE_ENTRY_COST_CAP === 'true')
        throw new Error('eligible_entry_filters_conflict');
    if (env.ELIGIBLE_ENTRY_COST_CAP_MAX !== undefined) {
        if (!['0.82', '0.85'].includes(env.ELIGIBLE_ENTRY_COST_CAP_MAX))
            throw new Error('invalid_eligible_entry_cost_cap_max');
        if (env.ELIGIBLE_ENTRY_COST_CAP !== 'true')
            throw new Error('eligible_entry_cost_cap_max_requires_enabled_cap');
    }
    const binanceLeadVeto = env.ELIGIBLE_ENTRY_BINANCE_LEAD_VETO === 'true';
    if (binanceLeadVeto) {
        if (env.ELIGIBLE_ENTRY_COST_CAP !== 'true')
            throw new Error('eligible_entry_binance_lead_veto_requires_enabled_cap');
        if (env.ELIGIBLE_ENTRY_BUFFER === 'true')
            throw new Error('eligible_entry_filters_conflict');
    }
    const entryFilter = env.ELIGIBLE_ENTRY_BUFFER === 'true'
        ? validateEligibleEntryPolicy({ ...ELIGIBLE_BUFFER_POLICY }, { gasUsd: base.paperGasUsd })
        : env.ELIGIBLE_ENTRY_COST_CAP === 'true' ? validateEligibleEntryFilter({
        version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: Number(env.ELIGIBLE_ENTRY_COST_CAP_MAX ?? '0.85'),
        gasUsd: base.paperGasUsd, basis: 'full_fill_at_frozen_limit',
        ...(binanceLeadVeto ? { binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } : {}) }, { gasUsd: base.paperGasUsd }) : null;
    const policy = { schema: 1, provider: 'eligible', model: ELIGIBLE_MODEL,
        aiSource: 'deterministic-eligible-v1', inference: false,
        capital: null, capitalAllocation: 'available_balance', minimumBalance: 0,
        entryCap: 5, shares: 5, drawdownStop: 10, pilotMarkets: null, pilotHours: null,
        controlBaseline: base.fingerprint, qualification: 'unqualified_research_pilot',
        activation: 'explicit_run_live_only', paperEvidence: 'report_only',
        guards: { automaticActivation: false, explicitActivation: true,
            persistentPilotStop: true, sharedPilotHistory: true, recoveryWithoutNewEntries: true },
        execution: { slots: [90, 60, 30], slotToleranceMs: 2000, historyMs: 180000,
            snapshotWaitMs: 2000, snapshotAgeTargetMs: 1600, snapshotSlotReserveMs: 100,
            decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250, settlementMs: 2500, inferenceReserveMs: 150,
            executionBook: 'validated-websocket', limitSlippageTicks: 1, limitSlippageUsd: 0.01,
            providerMetadataMs: 300000, gasUsd: base.paperGasUsd } };
    if (continuousTrading) policy.continuousTrading = true;
    if (entryFilter) policy.entryFilter = entryFilter;
    const sources = eligibleSources(), id = digest(JSON.stringify({ policy, sources, profitTaking })).slice(0, 16);
    const settings = { ...base, fingerprint: id, capital: 0, shares: 5, entryCap: 5,
        experiment: 'eligible-live-v1', drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity,
        evaluationEndsAt: null, continuousTrading, automaticDeposits: continuousTrading,
        automaticManualActivity: continuousTrading,
        ...(entryFilter ? { entryFilter } : {}) };
    return bindRiskPeriod(bindRuntimeContinuation({ id, runtimeId: id, root: ROOT, sources, policy, profitTaking, settings,
        paperEvidence: { qualified: false, reasons: ['no_verified_matching_live_evidence'],
            automaticPromotion: false },
        ai: { ...policy.execution, ...(entryFilter ? { entryFilter } : {}), id, root: ROOT, control: settings, deadline: Number.MAX_SAFE_INTEGER,
            capital: 0, shares: 5, entryCap: 5, drawdownStop: 10 } }, env));
}

export function eligibleConfigView(config) {
    const continuousTrading = config.settings.continuousTrading === true;
    const drawdown = { drawdownStop: continuousTrading ? null : 10,
        ...(continuousTrading ? { drawdownAlertThreshold: 10, drawdownEnforcement: 'observe_only' } : {}) };
    return { id: config.id, runtimeId: config.runtimeId || config.id,
        ...(continuousTrading ? { continuousTrading: true } : {}),
        runtimeContinuation: config.runtimeContinuation ? {
            originalRuntimeId: config.runtimeContinuation.originalRuntimeId,
            periodId: config.runtimeContinuation.periodId, reason: config.runtimeContinuation.reason,
            ...(config.runtimeContinuation.policyChange ? { policyChange: config.runtimeContinuation.policyChange } : {}) } : null,
        riskPeriod: config.riskPeriod ? { id: config.id, ...drawdown,
            historicalLossesPreserved: true, activation: 'separate_manual_start' } : null,
        provider: 'eligible', model: ELIGIBLE_MODEL, inference: false,
        entryFilter: config.policy.entryFilter || null,
        automaticDeposits: config.settings.automaticDeposits === true,
        automaticManualActivity: config.settings.automaticManualActivity === true,
        mode: 'live', nodeMajor: 24, sdk: config.settings.sdk, collateral: 'pUSD', chainId: 137,
        limits: { capital: null, shares: 5, entryCap: 5, ...drawdown,
            pilotMarkets: null, pilotHours: null },
        execution: { ...config.policy.execution, ...config.settings.late, orderType: 'FAK',
            partialFill: 'accept_without_retry', oneEntryAttemptPerMarket: true },
        funding: { allocation: 'available_balance', minimumBalance: 0, capitalCap: null },
        qualification: config.policy.qualification, guards: config.policy.guards,
        profitTaking: config.profitTaking, automaticActivation: false,
        readOnlyCommands: ['config', 'preflight', 'report'] };
}
