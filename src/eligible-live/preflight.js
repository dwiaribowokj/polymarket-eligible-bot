import { preflight } from '../restart/preflight.js';
import { pilotHistory } from '../restart/store.js';
import { EPS, round } from '../restart/math.js';
import { expectedWalletBalance, verifyRecoveryCash } from '../laya-live/recovery.js';
import { profitTakingLedger } from '../laya-live/profit-accounting.js';
import { profitWithdrawalPending, profitTakingReport } from '../laya-live/profit-taking.js';
import { validateRiskPeriodHistory, readRiskPeriodHistory, assertPeriodAccountReady, readPeriodWalletProof } from './period.js';
import { matchesFeeRecoveryIncident, prepareFeeRecovery } from './fee-recovery.js';
import { continuousRecoveryReadCandidate } from './continuous-recovery.js';
import { CapitalDepositReconciler, depositRecoveryCandidate } from '../laya-live/deposits.js';
import { ExternalActivityReconciler } from '../laya-live/external-activity.js';
import { externalOrderReservations } from '../laya-live/external-orders.js';

export { allocateLiveCapital, preflightExitCode } from '../laya-live/preflight.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const operationStages = new Set(['address_requested', 'address_unknown', 'address_ready', 'source_uncertain', 'in_transit']);
const samePeriod = (config, state) => state.baseline === config.id && state.strategy === 'late-entry'
    && state.decisionProvider === 'eligible';

function validateLedger(config, state, { own = false } = {}) {
    if (!record(state) || typeof state.baseline !== 'string' || !state.baseline || state.mode !== 'pilot'
        || !['late-entry', 'maker-mm'].includes(state.strategy) || !Number.isSafeInteger(state.startedAt)
        || state.startedAt < 0 || !Number.isFinite(state.cash) || !Number.isFinite(state.peakEquity)
        || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0 || !Number.isFinite(state.failures)
        || !record(state.seen) || !Array.isArray(state.completed)
        || state.completed.some(row => !record(row) || !Number.isFinite(row.pnl)))
        throw new Error('invalid_eligible_pilot_history');
    if ((own || state.baseline === config.id) && !samePeriod(config, state))
        throw new Error('live_ledger_identity_mismatch');
    for (const stop of [state.stopped, state.liveRiskStop]) {
        if (stop != null && (!record(stop) || typeof stop.reason !== 'string' || !stop.reason))
            throw new Error('invalid_eligible_pilot_stop');
    }
    if (state.position != null && (!record(state.position) || !record(state.position.market)
        || typeof state.position.market.slug !== 'string' || !Array.isArray(state.position.holdings)
        || state.position.holdings.length !== 2 || !state.position.holdings.every(Number.isFinite)
        || !Array.isArray(state.position.orders)
        || state.position.orders.some(order => !record(order) || typeof order.status !== 'string')))
        throw new Error('invalid_eligible_pilot_position');
    if (state.liveFunding && (!record(state.liveFunding) || !Number.isFinite(state.liveFunding.initialCapital)
        || state.liveFunding.initialCapital < 0 || !Number.isFinite(state.walletStart)
        || !Number.isFinite(state.walletCashDelta))) throw new Error('invalid_eligible_live_funding');
    profitTakingLedger(state);
    const control = state.profitTakingControl;
    if (control != null) {
        const op = control.operation;
        if (!record(control) || control.schema !== 1 || !record(control.policy)
            || op != null && (!record(op) || !operationStages.has(op.stage)
                || typeof op.id !== 'string' || !op.id || !Number.isSafeInteger(op.createdAt) || op.createdAt < 0))
            throw new Error('invalid_eligible_profit_taking_control');
    }
    if (state.profitTaking && !control) throw new Error('profit_taking_control_missing');
    if (Number.isFinite(state.walletStart)) expectedWalletBalance(state);
    return state;
}

function checkedHistory(config, history) {
    if (!Array.isArray(history)) throw new Error('invalid_eligible_pilot_history');
    const identities = new Set();
    for (const state of history) {
        validateLedger(config, state);
        const identity = `${state.baseline}:${state.strategy}`;
        if (identities.has(identity)) throw new Error('duplicate_eligible_pilot_history');
        identities.add(identity);
    }
    return history;
}

export function eligibleHistory(config) {
    return checkedHistory(config, config.riskPeriod ? readRiskPeriodHistory(config) : pilotHistory(config.settings));
}

export function previousLiveSummary(config, history = eligibleHistory(config)) {
    const acknowledged = validateRiskPeriodHistory(config, history);
    const periods = checkedHistory(config, history).filter(state => !samePeriod(config, state)).map(state => ({
        baseline: state.baseline, provider: state.decisionProvider || 'legacy', strategy: state.strategy,
        startedAt: state.startedAt, cash: state.cash, peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown,
        netTradingPnl: round(state.completed.reduce((sum, row) => sum + row.pnl, 0)),
        completedMarkets: state.completed.filter(row => row.traded).length,
        stopped: state.stopped || null, liveRiskStop: state.liveRiskStop || null,
        riskAcknowledged: acknowledged.has(`${state.baseline}:${state.strategy}`),
        liveRiskStopped: !!state.liveRiskStop, positionOpen: !!state.position,
        withdrawalPending: profitWithdrawalPending(state),
        expectedWalletPUSD: Number.isFinite(state.walletStart) ? expectedWalletBalance(state) : null,
    }));
    return { found: periods.length > 0, periods,
        netTradingPnl: round(periods.reduce((sum, period) => sum + period.netTradingPnl, 0)),
        stopped: periods.some(period => !!period.stopped), liveRiskStop: periods.some(period => period.liveRiskStopped) };
}

export function eligibleReadiness({ config, state = null, history = [], operationalReady }) {
    const ledgers = checkedHistory(config, history);
    const acknowledged = validateRiskPeriodHistory(config, ledgers);
    const ownHistory = ledgers.find(ledger => samePeriod(config, ledger));
    const prior = ledgers.filter(ledger => !samePeriod(config, ledger)
        && !acknowledged.has(`${ledger.baseline}:${ledger.strategy}`));
    state ||= ownHistory || null;
    if (state) validateLedger(config, state, { own: true });
    const current = [state, ownHistory].filter(Boolean);
    const limit = config.settings.drawdownStop;
    if (!Number.isFinite(limit) || limit <= 0) throw new Error('invalid_eligible_drawdown_limit');
    const blockers = [], warnings = [];
    if (prior.length) blockers.push('existing_pilot_history_requires_original_period');
    if (prior.some(ledger => ledger.stopped)) blockers.push('previous_live_pilot_stop');
    if (prior.some(ledger => ledger.liveRiskStop)) blockers.push('previous_live_risk_stop');
    if (prior.some(ledger => ledger.maxDrawdown >= limit - EPS
        || ledger.stopped?.reason === 'drawdown_limit' || ledger.liveRiskStop?.reason === 'drawdown_limit'))
        blockers.push('previous_live_drawdown_stop');
    if (prior.some(ledger => ledger.position)) blockers.push('previous_live_inventory_open');
    if (prior.some(profitWithdrawalPending)) blockers.push('previous_live_profit_withdrawal_pending');
    if (current.some(ledger => ledger.stopped)) blockers.push('persistent_pilot_stop');
    if (current.some(ledger => ledger.liveRiskStop)) blockers.push('persistent_live_risk_stop');
    const continuousTrading = config.settings.continuousTrading === true;
    if (!continuousTrading && current.some(ledger => ledger.maxDrawdown >= limit - EPS))
        blockers.push('persistent_live_drawdown_stop');
    if (operationalReady !== true) blockers.push(operationalReady === null
        ? 'live_preflight_required' : 'live_preflight_blocked');
    if (!config.paperEvidence?.qualified) warnings.push('eligible_live_unqualified_research');
    const readyForLive = blockers.length === 0;
    const recoveryOnly = (!!state?.position || profitWithdrawalPending(state)) && !prior.length && !readyForLive;
    return { readyForLive, startAllowed: readyForLive || recoveryOnly, recoveryOnly, blockers, warnings,
        ...(continuousTrading ? { continuousTrading: true, drawdownStop: null,
            drawdownAlertThreshold: limit, drawdownEnforcement: 'observe_only' } : {}),
        otherPilotHistory: prior.length > 0,
        riskPeriod: config.riskPeriod ? { id: config.id, drawdownStop: continuousTrading ? null : limit,
            ...(continuousTrading ? { drawdownAlertThreshold: limit, drawdownEnforcement: 'observe_only' } : {}),
            acknowledgedPeriods: acknowledged.size, historicalLossesPreserved: true } : null };
}

export function assertEligibleStartAllowed({ explicitLive, ...context }) {
    if (!explicitLive) throw new Error('explicit_live_flag_required');
    const readiness = eligibleReadiness(context);
    if (!readiness.startAllowed) throw new Error(readiness.blockers[0]);
    return readiness;
}

export function enforceEligibleStartupGuards(store, context) {
    const readiness = assertEligibleStartAllowed({ ...context, state: store.state });
    if (readiness.recoveryOnly && !store.state.stopped) store.stop(readiness.blockers[0]);
    return readiness;
}

export function applyEligibleExternalOrderReadiness(config, account, owned = []) {
    if (config.settings.automaticManualActivity !== true) return account;
    const authenticated = account.checks.find(check => check.name === 'authenticated_order_trade_api');
    const index = account.checks.findIndex(check => check.name === 'unowned_open_orders');
    if (authenticated?.ok !== true || index < 0) return account;
    let external;
    try { external = externalOrderReservations(authenticated.detail?.orders, { owned }); }
    catch { return account; }
    account.checks[index] = { name: 'unowned_open_orders', scope: 'live', ok: true,
        detail: { botOrders: authenticated.detail.orders.length - external.count, external } };
    account.liveReady = account.checks.every(check => check.ok);
    return account;
}

export async function eligiblePreflight(config, client, providers, state = null,
    { history = eligibleHistory(config), refreshHistory = null } = {}) {
    // Validate every ledger before any account request. A new strategy identity
    // cannot make unknown history or an unfinished wallet operation disappear.
    const previousLive = previousLiveSummary(config, history);
    state ||= history.find(ledger => samePeriod(config, ledger)) || null;
    eligibleReadiness({ config, state, history, operationalReady: null });
    const minimumBalance = 0;
    const owned = state?.position?.orders.map(order => order.orderId) || [];
    const [account, provider] = await Promise.all([
        preflight(client, { ...config.settings, capital: minimumBalance }, { strategies: ['late-entry'],
            owned, resuming: !!state?.position }),
        providers.preflight(),
    ]);
    applyEligibleExternalOrderReadiness(config, account, owned);
    if (config.riskPeriod && !state) {
        // A manual preparation may precede startup by hours. Prove the wallet
        // is still flat and free of pending writes before funding a new ledger.
        try {
            const proof = await readPeriodWalletProof(config, client);
            const trades = await assertPeriodAccountReady(account, { client, wallet: config.settings.wallet, proof });
            if (!Number.isFinite(account.wallet?.balance) || Math.abs(account.wallet.balance - proof.balance) > EPS)
                throw new Error('eligible_period_wallet_changed');
            account.checks.push({ name: 'new_period_wallet_readiness', scope: 'live', ok: true,
                detail: { blockNumber: proof.blockNumber, blockHash: proof.blockHash,
                    balance: proof.balance, transactionsPending: false, inventoryOpen: false, trades } });
        } catch (error) {
            account.checks.push({ name: 'new_period_wallet_readiness', scope: 'live', ok: false,
                error: { code: /^eligible_period_[a-z_]+$/.test(error.message || '')
                    ? error.message : 'eligible_period_wallet_read_failed', category: 'reconciliation', stage: 'startup_wallet' } });
        }
    }
    let walletReconciliation = null, externalActivityReview = null;
    if (state && config.settings.automaticManualActivity === true && !state.position) {
        externalActivityReview = await new ExternalActivityReconciler(config, { state }, client).preview();
        account.checks.push({ name: 'external_activity_reconciliation', scope: 'live',
            ok: externalActivityReview?.ready === true,
            ...(externalActivityReview?.ready === true ? { detail: externalActivityReview }
                : { error: externalActivityReview?.error
                    || { code: 'external_activity_verifying', category: 'opportunity', stage: 'startup_wallet' } }) });
    }
    if (state && !state.position && Number.isFinite(state.walletStart)) {
        try {
            walletReconciliation = externalActivityReview?.ready === true
                ? { expectedPUSD: externalActivityReview.balance, actualPUSD: externalActivityReview.balance,
                    externalCashDelta: externalActivityReview.totalExternalCashDelta, automatic: true }
                : await verifyRecoveryCash(config, state, client);
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
    let reviewedRecovery = null;
    if (matchesFeeRecoveryIncident(config, state)) {
        try {
            reviewedRecovery = (await prepareFeeRecovery(config, state, client)).summary;
            account.checks.push({ name: 'reviewed_fee_recovery', scope: 'live', ok: true, detail: reviewedRecovery });
        } catch {
            account.checks.push({ name: 'reviewed_fee_recovery', scope: 'live', ok: false,
                error: { code: 'eligible_fee_recovery_unproven', category: 'reconciliation', stage: 'startup_wallet' } });
        }
    }
    const operationalReady = account.liveReady && account.checks.every(check => check.ok) && provider?.eligible?.ready === true;
    if (refreshHistory) history = refreshHistory();
    const readiness = eligibleReadiness({ config, state, history, operationalReady });
    let capitalDepositReview = null;
    if (state && config.settings.automaticManualActivity !== true && depositRecoveryCandidate(config, state) && readiness.blockers.length
        && readiness.blockers.every(reason => ['persistent_pilot_stop', 'live_preflight_blocked'].includes(reason))
        && account.checks.every(check => check.ok || check.name === 'wallet_ledger_reconciliation')
        && provider?.eligible?.ready === true)
        capitalDepositReview = await new CapitalDepositReconciler(config, { state }, client).preview();
    const output = { at: new Date().toISOString(), id: config.id, runtimeId: config.runtimeId || config.id,
        provider, reviewedRecovery, inferenceAttempted: false, collateral: 'pUSD', chainId: 137,
        wallet: config.settings.wallet, balance: account.wallet?.balance ?? null,
        botCash: state?.cash ?? null,
        manualCashDelta: externalActivityReview?.totalExternalCashDelta ?? state?.externalWalletActivity?.cashDelta ?? 0,
        requiredBalance: minimumBalance, capitalCap: null,
        allocatedCapital: state?.liveFunding?.initialCapital ?? (account.wallet ? round(account.wallet.balance) : null),
        shortfall: account.wallet ? Math.max(0, round(minimumBalance - account.wallet.balance)) : null,
        nativeGasPOL: account.wallet?.nativeGas ?? null, legacyPositions: account.positions.length,
        openOrders: account.openOrders.length, operationalReady, ...readiness, previousLive,
        walletReconciliation, recoverableStop: false, stopped: state?.stopped || null, liveRiskStop: state?.liveRiskStop || null,
        continuousRecoveryAvailable: continuousRecoveryReadCandidate(config, state),
        capitalDepositReview, capitalDepositRecoveryAvailable: capitalDepositReview?.ready === true,
        externalActivityReview, externalActivityRecoveryAvailable: externalActivityReview?.ready === true,
        profitTaking: profitTakingReport(state, config.profitTaking), automaticActivation: false,
        paperEvidence: config.paperEvidence || { qualified: false, reasons: ['no_matching_eligible_paper_evidence'] },
        checks: account.checks.map(check => {
            if (check.name === 'funding' && !check.ok && account.wallet) return { ...check,
                error: { code: !state?.position && account.wallet.balance < minimumBalance ? 'insufficient_pusd' : 'insufficient_polygon_gas',
                    category: 'funding', stage: 'startup_wallet' } };
            return check.name === 'authenticated_order_trade_api' ? { ...check,
                detail: check.ok ? { orders: check.detail.orders.length, trades: check.detail.trades.length } : undefined } : check;
        }) };
    return { output, account };
}
