import fs from 'node:fs';
import path from 'node:path';
import { preflight } from '../restart/preflight.js';
import { dailyBootstrap, round, EPS } from '../restart/math.js';
import { recoverableBookStop, expectedWalletBalance, verifyRecoveryCash } from './recovery.js';
import { profitWithdrawalPending, profitTakingReport } from './profit-taking.js';

export function rehearsalEvidence(config) {
    const marker = path.join(config.rehearsalDataDir, 'active.json');
    if (!fs.existsSync(marker)) return { found: false, riskStopActive: null };
    const active = JSON.parse(fs.readFileSync(marker));
    if (!/^[a-f0-9]{16}$/.test(active.id)) throw new Error('invalid_rehearsal_identity');
    const state = JSON.parse(fs.readFileSync(path.join(config.rehearsalDataDir, active.id, 'ledger.json')));
    if (state.id !== active.id || !state.arms?.laya) throw new Error('invalid_rehearsal_ledger');
    const arm = state.arms.laya;
    if (!Number.isFinite(arm.cash) || !Array.isArray(arm.completed)
        || arm.completed.some(row => !Number.isFinite(row.pnl))) throw new Error('invalid_rehearsal_ledger');
    return { found: true, id: state.id, filledMarkets: arm.completed.length, cash: arm.cash,
        netTradingPnl: round(arm.completed.reduce((sum, row) => sum + row.pnl, 0)),
        riskStopActive: !!arm.stopped || !!arm.shadowStop, stopped: arm.stopped, shadowStop: arm.shadowStop,
        inventoryOpen: !!arm.position, separatePeriod: true };
}

export function paperEvidence(config) {
    const filename = path.join(config.ai.dataDir, config.policy.aiSource, 'ledger.json');
    if (!fs.existsSync(filename)) return { qualified: false, reasons: ['no_matching_paper_evidence'] };
    const state = JSON.parse(fs.readFileSync(filename)), arm = state.arms.laya;
    const end = state.frozenAt || Math.min(Date.now(), state.deadline);
    const days = (end - state.startedAt) / 86400000;
    const rows = arm.completed, pnl = round(rows.reduce((sum, r) => sum + r.pnl, 0));
    const ci95 = dailyBootstrap(rows.map(row => ({ ...row, closedAt: row.closedAt + 7 * 3600000 })));
    const reasons = [...(days < 7 ? ['need_7_days'] : []), ...(rows.length < 100 ? ['need_100_filled_markets'] : []),
        ...(pnl <= 0 ? ['nonpositive_net_profit'] : []), ...(!ci95 || ci95.lower <= 0 ? ['uncertain_expectancy'] : []),
        ...(arm.shadowStop || arm.stopped ? ['paper_risk_stop_breached'] : []), ...(arm.position ? ['paper_inventory_open'] : []),
        'local_compute_cost_unknown'];
    return { qualified: reasons.length === 0, source: state.id, days: round(days), filledMarkets: rows.length,
        netTradingPnl: pnl, ci95, reasons, computeCost: null };
}

// One policy drives both preflight diagnostics and the startup assertion.
// Resuming real inventory is allowed in recovery mode, with entry latched off.
export function liveReadiness({ state = null, operationalReady, otherHistory = false, rehearsal, recoverableStop = false }) {
    const blockers = [], warnings = [];
    if (otherHistory) blockers.push('existing_pilot_history_requires_original_period');
    if (state?.stopped && !recoverableStop) blockers.push('persistent_pilot_stop');
    if (state?.liveRiskStop) blockers.push('persistent_live_risk_stop');
    if (recoverableStop) warnings.push('pre_entry_book_stop_recoverable');
    // Virtual research results remain evidence. They are not a stop in the
    // separate, explicitly activated live ledger.
    if (rehearsal?.invalid) warnings.push('rehearsal_evidence_invalid');
    else if (rehearsal?.found !== true) warnings.push('rehearsal_evidence_missing');
    if (rehearsal?.riskStopActive) warnings.push('rehearsal_risk_stop_recorded');
    if (rehearsal?.inventoryOpen) warnings.push('rehearsal_virtual_inventory_open');
    if (operationalReady !== true) blockers.push(operationalReady === null
        ? 'live_preflight_required' : 'live_preflight_blocked');
    const readyForLive = blockers.length === 0;
    const recoveryOnly = (!!state?.position || profitWithdrawalPending(state)) && !otherHistory && !readyForLive;
    return { readyForLive, startAllowed: readyForLive || recoveryOnly, recoveryOnly, blockers, warnings };
}

export function preflightExitCode(output) { return output.readyForLive === true ? 0 : 1; }

export function readRehearsalEvidence(config) {
    try { return rehearsalEvidence(config); }
    catch { return { found: false, invalid: true, riskStopActive: null }; }
}

export function allocateLiveCapital(state, config, balance, { fresh = false, now = Date.now() } = {}) {
    if (state.liveFunding) {
        const initial = state.liveFunding.initialCapital;
        if (!Number.isFinite(initial) || initial < 0) throw new Error('invalid_live_capital');
        return state.liveFunding;
    }
    if (!fresh || state.position || state.completed.length || Object.keys(state.seen).length || state.stopped)
        throw new Error('live_capital_initialization_requires_fresh_period');
    if (!Number.isFinite(balance) || balance < 0) throw new Error('invalid_wallet_balance');
    const initialCapital = round(balance);
    state.cash = initialCapital; state.peakEquity = initialCapital; state.lastEquity = initialCapital;
    state.walletStart = balance; state.walletCashDelta = 0;
    state.liveFunding = { at: now, initialCapital, capitalCap: null, minimumBalance: 0,
        allocation: config.policy.capitalAllocation || 'available_balance' };
    return state.liveFunding;
}

export async function livePreflight(config, client, providers, state = null, { otherHistory = false } = {}) {
    const minimumBalance = 0, capitalCap = null;
    const [account, provider] = await Promise.all([
        preflight(client, { ...config.settings, capital: minimumBalance }, { strategies: ['late-entry'],
            owned: state?.position?.orders.map(o => o.orderId) || [], resuming: !!state?.position }),
        providers.preflight(),
    ]);
    // Detect external cash changes before declaring a restart healthy. Never
    // rebase the original funding or conceal losses with the current balance.
    let walletReconciliation = null;
    if (state && !state.position && Number.isFinite(state.walletStart)) {
        try {
            walletReconciliation = await verifyRecoveryCash(config, state, client);
            const expected = walletReconciliation?.expectedPUSD ?? expectedWalletBalance(state);
            const actual = walletReconciliation?.actualPUSD ?? account.wallet?.balance;
            if (walletReconciliation && account.wallet) account.wallet.balance = actual;
            const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= EPS;
            account.checks.push({ name: 'wallet_ledger_reconciliation', scope: 'live', ok,
                detail: { expectedPUSD: expected, actualPUSD: actual ?? null,
                    externalCashDelta: walletReconciliation?.externalCashDelta ?? state.externalWalletActivity?.cashDelta ?? 0 },
                ...(!ok ? { error: { code: 'wallet_ledger_mismatch', category: 'reconciliation', stage: 'startup_wallet' } } : {}) });
        } catch {
            account.checks.push({ name: 'wallet_ledger_reconciliation', scope: 'live', ok: false,
                error: { code: 'external_wallet_reconciliation_failed', category: 'reconciliation', stage: 'startup_wallet' } });
        }
    }
    const operationalReady = account.liveReady && account.checks.every(c => c.ok) && provider.laya.ready;
    const rehearsal = readRehearsalEvidence(config);
    const recoverableStop = recoverableBookStop(config, state);
    const readiness = liveReadiness({ state, operationalReady, otherHistory, rehearsal, recoverableStop });
    const output = { at: new Date().toISOString(), id: config.id, runtimeId: config.runtimeId || config.id,
        recoverableStop, walletReconciliation, provider, collateral: 'pUSD', chainId: 137,
        wallet: config.settings.wallet, balance: account.wallet?.balance ?? null,
        requiredBalance: minimumBalance, capitalCap,
        allocatedCapital: state?.liveFunding?.initialCapital ?? (account.wallet ? round(account.wallet.balance) : null),
        shortfall: account.wallet ? Math.max(0, round(minimumBalance - account.wallet.balance)) : null,
        nativeGasPOL: account.wallet?.nativeGas ?? null, legacyPositions: account.positions.length,
        openOrders: account.openOrders.length, operationalReady, ...readiness, otherPilotHistory: otherHistory,
        profitTaking: profitTakingReport(state, config.profitTaking),
        automaticActivation: false, paperEvidence: paperEvidence(config), rehearsal,
        checks: account.checks.map(check => {
            if (check.name === 'funding' && !check.ok && account.wallet) return { ...check,
                error: { code: !state?.position && account.wallet.balance < minimumBalance ? 'insufficient_pusd' : 'insufficient_polygon_gas',
                    category: 'funding', stage: 'startup_wallet' } };
            return check.name === 'authenticated_order_trade_api' ?
                { ...check, detail: check.ok ? { orders: check.detail.orders.length, trades: check.detail.trades.length } : undefined } : check;
        }) };
    return { output, account };
}

export function assertStartAllowed({ explicitLive, ...context }) {
    if (!explicitLive) throw new Error('explicit_live_flag_required');
    const readiness = liveReadiness(context);
    if (!readiness.startAllowed) throw new Error(readiness.blockers[0]);
    return readiness;
}

export function enforceStartupGuards(store, context) {
    const readiness = assertStartAllowed({ ...context, state: store.state });
    if (readiness.recoveryOnly && !store.state.stopped) store.stop(readiness.blockers[0]);
    return readiness;
}
