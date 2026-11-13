#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, acquireLock, atomicJson } from '../src/restart/store.js';
import { pilotSummary } from '../src/restart/math.js';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { LayaLiveEngine, initializeAI } from '../src/laya-live/engine.js';
import { ProfitTakingCoordinator, profitTakingReport } from '../src/laya-live/profit-taking.js';
import { LiveSupervisor, waitForLiveStartup } from '../src/laya-live/runner.js';
import { entryHeld } from '../src/laya-live/entry-holds.js';
import { operationCode } from '../src/laya-live/broker.js';
import { eligibleEnvironment, loadEligibleConfig, eligibleConfigView } from '../src/eligible-live/config.js';
import { EligibleLiveProvider, ELIGIBLE_MODEL } from '../src/eligible-live/provider.js';
import { createRiskPeriod } from '../src/eligible-live/period.js';
import { eligibleManifestPath } from '../src/eligible-live/continuation.js';
import { initializeEligibleStrategyEpoch, eligibleStrategySummary } from '../src/eligible-live/strategy-epochs.js';
import { CapitalDepositReconciler, depositRecoveryCandidate } from '../src/laya-live/deposits.js';
import { ExternalActivityReconciler, externalTokenBalances } from '../src/laya-live/external-activity.js';
import { totalCapitalDeposited, capitalFundingLedger } from '../src/laya-live/capital-funding.js';
import { totalCapitalAllocated } from '../src/laya-live/capital-allocations.js';
import { matchesFeeRecoveryIncident, prepareFeeRecovery, applyFeeRecovery } from '../src/eligible-live/fee-recovery.js';
import { ContinuousRecovery, continuousRecoveryReadCandidate, initializeContinuousState } from '../src/eligible-live/continuous-recovery.js';
import { eligibleHistory, previousLiveSummary, eligibleReadiness, eligiblePreflight,
    enforceEligibleStartupGuards, allocateLiveCapital } from '../src/eligible-live/preflight.js';

export function parseEligibleArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['config', 'preflight', 'report', 'run', 'new-period'].includes(command)
        || flags.some(flag => command !== 'run' || flag !== '--live') || flags.length > 1)
        throw new Error('use_eligible_config_preflight_report_new_period_run_live');
    if (command === 'run' && flags.length !== 1) throw new Error('explicit_live_flag_required');
    return { command, explicitLive: command === 'run' };
}

export function eligibleSummary(config, state, history) {
    const readiness = eligibleReadiness({ config, state, history, operationalReady: null });
    const common = { id: config.id, provider: 'eligible', model: ELIGIBLE_MODEL, inference: false,
        automaticActivation: false, liveStarted: !!state, configuration: eligibleConfigView(config),
        ...readiness, previousLive: previousLiveSummary(config, history), paperEvidence: config.paperEvidence };
    if (!state) return common;
    const { decision, ...performance } = pilotSummary(state);
    const withdrawals = profitTakingReport(state, config.profitTaking);
    return { ...common, ...performance, qualification: config.policy.qualification,
        tradingMarketsPnl: performance.netRealizedPnl, netRealizedPnl: withdrawals.tradingPnlAfterWithdrawalCosts,
        aiComputeCost: 0, infrastructureCost: null, funding: state.liveFunding || null,
        capitalDeposits: { totalDeposited: totalCapitalDeposited(state),
            receipts: Object.values(capitalFundingLedger(state)?.entries || {}),
            profitIncluded: false },
        externalWalletActivity: { cashDelta: state.externalWalletActivity?.cashDelta || 0,
            receipts: state.externalWalletActivity?.receipts?.length || 0,
            zeroPayoutInventory: state.externalWalletActivity?.zeroPayoutInventory?.length || 0,
            automatic: config.settings.automaticManualActivity === true,
            openTokens: config.settings.automaticManualActivity === true
                ? Object.values(externalTokenBalances(state)).filter(value => value > 0).length : null,
            verifiedAt: state.externalWalletActivity?.automatic?.verifiedAt ?? null,
            capitalAllocated: totalCapitalAllocated(state), profitIncluded: false },
        decisions: state.ai?.snapshots?.length || 0, profitTaking: withdrawals,
        strategyEvaluation: eligibleStrategySummary(state, config),
        clock: state.liveClock || null, liveRiskStop: state.liveRiskStop || null,
        continuousOperation: state.continuousOperation || null, liveRiskThreshold: state.liveRiskThreshold || null,
        entryHolds: state.entryHolds || {}, entryBlocked: !!state.stopped || !!state.liveRiskStop || entryHeld(state),
        phase: state.position || withdrawals.pending ? 'reconciling'
            : state.stopped || state.liveRiskStop || entryHeld(state) ? 'entry_paused' : 'monitoring' };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
    const args = parseEligibleArgs(argv);
    const config = dependencies.config || loadEligibleConfig(eligibleEnvironment());
    const write = dependencies.write || (value => console.log(JSON.stringify(value, null, 2)));
    if (args.command === 'config') { write(eligibleConfigView(config)); return 0; }
    if (args.command === 'new-period') {
        const client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        const providers = new EligibleLiveProvider(config.ai);
        try {
            write(await createRiskPeriod(config, { client, providers })); return 0;
        } finally { providers.close(); client.close?.(); }
    }
    const readHistory = () => eligibleHistory(config);
    let history = readHistory(), prior = history.find(state => state.baseline === config.id) || null;
    if (args.command === 'report') { write(eligibleSummary(config, prior, history)); return 0; }
    const release = args.command === 'run' ? await (dependencies.acquireLock || acquireLock)(config.settings.dataDir, 'pilot') : async () => {};
    let client, providers, engine, supervisor, continuousRecovery, capitalDeposits, externalActivity;
    const shutdown = new AbortController();
    const end = () => {
        shutdown.abort(); supervisor?.requestStop();
        if (engine) engine.closed = true;
        if (continuousRecovery) continuousRecovery.closed = true;
        if (capitalDeposits) capitalDeposits.closed = true;
        if (externalActivity) externalActivity.closed = true;
    };
    if (args.command === 'run') { process.on('SIGINT', end); process.on('SIGTERM', end); }
    try {
        // Re-read under the wallet's existing lock before creating any live state.
        history = readHistory(); prior = history.find(state => state.baseline === config.id) || null;
        if (args.command === 'run') {
            const guards = eligibleReadiness({ config, state: prior, history, operationalReady: true });
            const canRecover = continuousRecoveryReadCandidate(config, prior)
                && guards.blockers.length === 1 && guards.blockers[0] === 'persistent_pilot_stop';
            const canReconcileDeposit = depositRecoveryCandidate(config, prior)
                && guards.blockers.every(reason => reason === 'persistent_pilot_stop');
            if (!guards.startAllowed && !canRecover && !canReconcileDeposit) throw new Error(guards.blockers[0]);
        }
        const store = new Store(config.settings, 'pilot', 'late-entry');
        const state = store.state, ai = initializeAI(state, config);
        client = dependencies.clientFactory ? dependencies.clientFactory(config.settings) : new LayaTradingClient(config.settings);
        providers = new EligibleLiveProvider(config.ai, ai.providers);
        capitalDeposits = new CapitalDepositReconciler(config, store, client);
        externalActivity = new ExternalActivityReconciler(config, store, client);
        const createEngine = () => {
            const books = new LiveBookHistory({ onEvent: (type, detail) => engine.bookEvent(type, detail) });
            engine = new LayaLiveEngine(config, store, client, books, providers);
            engine.broker.capitalDeposits = capitalDeposits;
            engine.broker.externalActivity = externalActivity;
            engine.allowSettlementRecovery = false;
        };
        if (args.command === 'run' && config.settings.continuousTrading === true)
            continuousRecovery = new ContinuousRecovery(config, store, client, providers);
        const check = async () => {
            if (args.command === 'run' && prior) {
                if (externalActivity.enabled()) await externalActivity.reconcile({ bootstrap: true });
                else if (capitalDeposits.enabled()) await capitalDeposits.reconcile({ bootstrap: true });
            }
            if (continuousRecovery && continuousRecoveryReadCandidate(config, state)) {
                if (!engine) createEngine();
                await engine.recoverContinuousReads();
            }
            await continuousRecovery?.tick();
            return eligiblePreflight(config, client, providers, prior ? state : null, { history: readHistory() });
        };
        if (args.command === 'preflight') {
            const result = await check(); write(result.output);
            return result.output.readyForLive ? 0 : 1;
        }
        const result = await waitForLiveStartup({ check, state, signal: shutdown.signal,
            continuousTrading: config.settings.continuousTrading === true,
            onResult: checked => write(checked.output) });
        if (!result || shutdown.signal.aborted) return 0;
        if (matchesFeeRecoveryIncident(config, state)) {
            const review = await prepareFeeRecovery(config, state, client);
            if (shutdown.signal.aborted) return 0;
            applyFeeRecovery(store, review, { explicitLive: args.explicitLive });
        }
        enforceEligibleStartupGuards(store, { config, history: readHistory(), explicitLive: args.explicitLive,
            operationalReady: result.output.operationalReady });
        allocateLiveCapital(state, config, result.output.balance, { fresh: !prior });
        if (!prior) state.startedAt = Date.now();
        state.liveActivation ||= { at: Date.now(), source: 'explicit_run_live',
            statisticalQualification: false, evidence: config.paperEvidence };
        state.legacyPositions = prior?.legacyPositions || result.account.positions;
        initializeContinuousState(config, state);
        initializeEligibleStrategyEpoch(state, config);
        store.save();
        if (externalActivity.enabled()) await externalActivity.reconcile({ bootstrap: true });
        else if (capitalDeposits.enabled()) await capitalDeposits.reconcile({ bootstrap: true });
        // Legacy history scanners treat top-level pilot JSON as ledgers.
        const artifacts = path.join(config.settings.dataDir, config.id, 'eligible-runtime');
        atomicJson(eligibleManifestPath(config), { id: config.id, runtimeId: config.runtimeId || config.id,
            policy: config.policy,
            sources: config.sources, profitTaking: config.profitTaking, startedAt: state.startedAt });
        providers.onEvent = (type, detail) => store.event(type, detail);
        client.onEvent = ({ type, ...detail }) => store.event(type, detail);
        if (!engine) createEngine();
        const profitTaking = new ProfitTakingCoordinator({ config, store, client, providers });
        profitTaking.capitalDeposits = capitalDeposits;
        profitTaking.externalActivity = externalActivity;
        store.event('eligible_live_started', { periodId: config.id, runtimeId: config.runtimeId || config.id,
            provider: 'eligible', model: ELIGIBLE_MODEL,
            inferenceAttempted: false, capital: state.liveFunding.initialCapital, entryCap: 5,
            entryFilter: config.policy.entryFilter || null, strategyEpochId: state.currentStrategyEpochId || null,
            continuousTrading: config.settings.continuousTrading === true,
            drawdownStop: config.settings.continuousTrading === true ? null : 10 });
        supervisor = new LiveSupervisor({ engine, store, providers, profitTaking, continuousRecovery, signal: shutdown.signal,
            continuousTrading: config.settings.continuousTrading === true,
            report: () => atomicJson(path.join(artifacts, 'report.json'), eligibleSummary(config, state, readHistory())) });
        await supervisor.run();
        return 0;
    } finally {
        process.off('SIGINT', end); process.off('SIGTERM', end);
        if (engine && !supervisor) { engine.closed = true; engine.books?.close(); }
        providers?.close(); client?.close(); await release();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(JSON.stringify({ type: 'eligible_live_failed', code: operationCode(error) }));
        process.exitCode = 1;
    });
