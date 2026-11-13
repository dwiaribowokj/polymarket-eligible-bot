import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { LayaTradingClient } from '../src/laya-live/client.js';
import { Store, acquireLock, atomicJson } from '../src/restart/store.js';
import { pilotSummary } from '../src/restart/math.js';
import { LiveBookHistory } from '../src/laya-live/book-history.js';
import { LayaLiveProvider } from '../src/laya-live/provider.js';
import { loadLiveConfig, liveConfigView } from '../src/laya-live/config.js';
import { LayaLiveEngine, initializeAI } from '../src/laya-live/engine.js';
import { livePreflight, enforceStartupGuards, allocateLiveCapital, paperEvidence, readRehearsalEvidence, liveReadiness, preflightExitCode } from '../src/laya-live/preflight.js';
import { operationCode } from '../src/laya-live/broker.js';
import { liveHistory, recoverableBookStop, recoverBookStop } from '../src/laya-live/recovery.js';
import { ProfitTakingCoordinator, profitTakingReport } from '../src/laya-live/profit-taking.js';
import { liveDeadlineISO } from '../src/laya-live/limits.js';
import { startDecisionEpoch, evaluationSummary } from '../src/laya-live/decision-epochs.js';
import { LiveSupervisor, waitForLiveStartup } from '../src/laya-live/runner.js';
import { entryHeld } from '../src/laya-live/entry-holds.js';

export function parseArgs(argv) {
    const [command = 'preflight', ...flags] = argv;
    if (!['config', 'preflight', 'run', 'report'].includes(command) || flags.some(f => command !== 'run' || f !== '--live') || flags.length > 1)
        throw new Error('use_laya_live_config_preflight_run_live_report');
    if (command === 'run' && !flags.includes('--live')) throw new Error('explicit_live_flag_required');
    return { command, explicitLive: flags.includes('--live') };
}

function summary(config, state) {
    const rehearsal = readRehearsalEvidence(config);
    const otherHistory = liveHistory(config.settings).some(s => s.baseline !== config.id || s.decisionProvider !== 'laya');
    const guards = liveReadiness({ state, rehearsal, otherHistory, operationalReady: null,
        recoverableStop: recoverableBookStop(config, state) });
    const common = { id: config.id, automaticActivation: false, configuration: liveConfigView(config),
        ...guards, paperEvidence: paperEvidence(config), rehearsal };
    if (!state) return { ...common, liveStarted: false };
    const { decision, ...performance } = pilotSummary(state);
    const withdrawals = profitTakingReport(state, config.profitTaking);
    return { ...common, liveStarted: true, provider: 'laya', model: 'typed-decisions',
        qualification: 'unqualified_research_pilot', automaticActivation: false,
        deadline: liveDeadlineISO(state, config.settings), ...performance,
        tradingMarketsPnl: performance.netRealizedPnl,
        netRealizedPnl: withdrawals.tradingPnlAfterWithdrawalCosts,
        aiComputeCost: null, funding: state.liveFunding || null,
        decisions: state.ai?.snapshots.length || 0, providerState: state.ai?.providers.laya || null,
        profitTaking: withdrawals, evaluation: evaluationSummary(state, config), clock: state.liveClock || null,
        entryHolds: state.entryHolds || {}, liveRiskStop: state.liveRiskStop || null,
        phase: state.position || state.profitTaking?.pending ? 'reconciling'
            : state.stopped || entryHeld(state) ? 'entry_paused' : 'monitoring',
        entryBlocked: !!state.stopped || entryHeld(state) };
}

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
    const config = loadLiveConfig();
    if (args.command === 'config') { console.log(JSON.stringify(liveConfigView(config), null, 2)); return; }
    const filename = path.join(config.settings.dataDir, config.id, 'pilot/late-entry.json');
    const prior = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename)) : null;
    if (args.command === 'report') { console.log(JSON.stringify(summary(config, prior), null, 2)); return; }
    // Same kernel lock and history root as the original rule-based pilot.
    // A legacy pilot and Laya can never trade the wallet concurrently.
    const release = args.command === 'run' ? await acquireLock(config.settings.dataDir, 'pilot') : async () => {};
    let client, providers, engine, supervisor;
    const shutdown = new AbortController();
    const end = () => { shutdown.abort(); supervisor?.requestStop(); if (engine) engine.closed = true; };
    if (args.command === 'run') { process.on('SIGINT', end); process.on('SIGTERM', end); }
    try {
        if (prior && (prior.baseline !== config.id || prior.decisionProvider !== 'laya')) throw new Error('live_ledger_identity_mismatch');
        const store = new Store(config.settings, 'pilot', 'late-entry');
        const state = store.state, ai = initializeAI(state, config);
        const history = liveHistory(config.settings);
        const otherHistory = history.some(s => s.baseline !== config.id || s.decisionProvider !== 'laya');
        if (args.command === 'run' && otherHistory) throw new Error('existing_pilot_history_requires_original_period');
        client = new LayaTradingClient(config.settings);
        // Health checks only. No inference, signing orders or transaction submit.
        providers = new LayaLiveProvider(config.ai, ai.providers);
        const check = () => livePreflight(config, client, providers, prior, { otherHistory });
        let result;
        if (args.command === 'preflight') {
            result = await check();
            console.log(JSON.stringify(result.output, null, 2));
            process.exitCode = preflightExitCode(result.output);
            return;
        }
        result = await waitForLiveStartup({ check, state, signal: shutdown.signal,
            onResult: checked => console.log(JSON.stringify(checked.output, null, 2)) });
        if (!result || shutdown.signal.aborted) return;
        // Keep the persistent stop through position recovery. Only a separately
        // reviewed, receipt-proven incident may recover after it is fully flat.
        if (result.output.readyForLive && result.output.recoverableStop) recoverBookStop(store, config, {
            explicitLive: args.explicitLive, operationalReady: result.output.operationalReady, otherHistory,
            walletReconciliation: result.output.walletReconciliation });
        enforceStartupGuards(store, { explicitLive: args.explicitLive, operationalReady: result.output.operationalReady,
            otherHistory, rehearsal: result.output.rehearsal });
        allocateLiveCapital(state, config, result.output.balance, { fresh: !prior });
        // Preserve the original accounting start across continuations. Failed
        // preflight never creates a live ledger or a future funding trigger.
        if (!prior) state.startedAt = Date.now();
        state.liveActivation = prior?.liveActivation || { at: Date.now(), source: 'explicit_run_live',
            statisticalQualification: result.output.paperEvidence.qualified, evidence: result.output.paperEvidence,
            rehearsal: result.output.rehearsal, warnings: result.output.warnings };
        state.legacyPositions = prior?.legacyPositions || result.account.positions;
        const evaluationEpoch = startDecisionEpoch(state, config);
        store.save();
        const revisionDir = path.join(store.directory, 'runtime-revisions', config.runtimeId || config.id);
        const manifest = { id: config.id, runtimeId: config.runtimeId || config.id, policy: config.policy,
            sources: config.sources, profitTaking: config.profitTaking,
            startedAt: state.startedAt, qualification: state.liveActivation,
            decisionProtocol: config.ai.decisionProtocol, evaluationEpoch };
        const originalManifest = path.join(store.directory, 'laya-manifest.json');
        if (!fs.existsSync(originalManifest)) atomicJson(originalManifest, manifest);
        atomicJson(path.join(revisionDir, 'manifest.json'), manifest);
        for (const [relative] of config.sources) {
            const target = path.join(revisionDir, relative);
            if (!fs.existsSync(target)) { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(config.root, relative), target); }
        }
        providers.onEvent = (type, detail) => {
            if (type === 'provider_late_response') {
                const snapshot = ai.snapshots.find(s => s.snapshotId === detail.snapshotId);
                if (snapshot?.decision) { snapshot.decision.actualLatencyMs = detail.latencyMs; snapshot.decision.lateDecision = detail.action; }
            }
            store.event(type, detail);
            if (type === 'provider_disabled') store.stop('laya_inference_status_unknown');
        };
        client.onEvent = ({ type, ...detail }) => store.event(type, detail);
        const books = new LiveBookHistory({ onEvent: (type, detail) => engine.bookEvent(type, detail) });
        engine = new LayaLiveEngine(config, store, client, books, providers);
        const profitTaking = new ProfitTakingCoordinator({ config, store, client, providers });
        engine.allowSettlementRecovery = args.explicitLive && result.output.operationalReady && !otherHistory;
        store.event('laya_live_started', { periodId: config.id, runtimeId: config.runtimeId || config.id,
            decisionProtocol: config.ai.decisionProtocol, evaluationEpochId: evaluationEpoch?.id,
            capital: state.liveFunding.initialCapital, capitalCap: null, entryCap: 5, drawdownStop: config.settings.drawdownStop,
            qualified: result.output.paperEvidence.qualified, deadline: liveDeadlineISO(state, config.settings) });
        supervisor = new LiveSupervisor({ engine, store, providers, profitTaking, signal: shutdown.signal,
            report: () => atomicJson(path.join(store.directory, 'laya-report.json'), summary(config, state)) });
        await supervisor.run();
    } finally {
        process.off('SIGINT', end); process.off('SIGTERM', end);
        providers?.close(); client?.close(); await release();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main().catch(error => { console.error(JSON.stringify({ type: 'laya_live_failed', code: operationCode(error) })); process.exitCode = 1; });
