import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS } from '../restart/math.js';
import { safeError } from '../restart/network.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { marketDiscoveryUnavailable, temporaryReadFailure } from '../laya-live/entry-holds.js';
import { ExternalActivityReconciler, externalTokenBalances } from '../laya-live/external-activity.js';
import { accountedCapitalHashes } from '../laya-live/deposits.js';
import { externalOrderReservations, assertExternalTradesSettled } from '../laya-live/external-orders.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';
import { readExternalInventoryProof } from './external-inventory.js';

const ID = /^[a-f0-9]{16}$/;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value == null || record(value) && Object.keys(value).length === 0;
const reasons = new Set(['operational_check_failed', 'market_watch_failed',
    'stale_or_invalid_execution_data', 'live_book_feed_gap']);
const entryResponses = new Map([
    ['metadata_read', new Set(['invalid_api_data', 'metadata_mismatch', 'invalid_tick_size'])],
    ['book_read', new Set(['invalid_api_data', 'invalid_entry_books', 'market_constraints_changed', 'tick_snapshot_mismatch'])],
]);
const watchResponses = new Set(['market_identity_mismatch', 'invalid_api_data', 'invalid_tick_size',
    'metadata_mismatch', 'unsupported_outcomes', 'missing_market_constraints', 'unsupported_market',
    'unsupported_btc_resolution_source']);
const fail = () => { throw new Error('eligible_continuous_recovery_unproven'); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function identity(config, state) {
    return config.settings.continuousTrading === true && config.policy?.provider === 'eligible'
        && config.policy.continuousTrading === true && ID.test(config.runtimeId || config.id)
        && state?.baseline === config.id && state.mode === 'pilot' && state.strategy === 'late-entry'
        && state.decisionProvider === 'eligible' && timestamp(state.startedAt);
}

// Called only after activation guards pass; an old stop never acquires eligibility.
export function initializeContinuousState(config, state, { now = Date.now } = {}) {
    if (config.settings.continuousTrading !== true) return false;
    const at = now(), operation = state.continuousOperation;
    if (!identity(config, state) || !timestamp(at) || at < state.startedAt) fail();
    if (operation != null) {
        if (!record(operation) || operation.runtimeId !== (config.runtimeId || config.id)
            || !timestamp(operation.enabledAt) || operation.enabledAt < state.startedAt || operation.enabledAt > at) fail();
        return false;
    }
    if (state.stopped != null || state.liveRiskStop != null || state.frozenAt != null) return false;
    state.continuousOperation = { enabledAt: at, runtimeId: config.runtimeId || config.id };
    return true;
}

function retryableReadHolds(holds, enabledAt, now) {
    if (empty(holds)) return true;
    if (!record(holds)) return false;
    return Object.entries(holds).every(([key, hold]) => {
        const error = hold?.error;
        return ['entry_read', 'market_watch', 'book_stream', 'clock'].includes(key)
            && record(hold) && hold.retryable === true && timestamp(hold.firstAt)
            && timestamp(hold.failedAt) && timestamp(hold.retryAt) && hold.firstAt >= enabledAt
            && hold.firstAt <= hold.failedAt && hold.failedAt <= now && hold.retryAt >= hold.failedAt
            && record(error) && (temporaryReadFailure(error)
                || key === 'entry_read' && error.code === 'stale_book' && error.category === 'stale_data'
                || ['entry_read', 'book_stream'].includes(key) && error.category === 'validation'
                    && entryResponses.get(error.stage)?.has(error.code)
                || key === 'market_watch' && error.category === 'validation' && watchResponses.has(error.code)
                    && ['market_discovery', 'metadata_read', 'btc_reference'].includes(error.stage)
                || key === 'market_watch' && marketDiscoveryUnavailable(error)
                || key === 'book_stream' && error.code === 'live_book_transport_gap' && error.category === 'transport'
                || key === 'clock' && (error.code === 'invalid_server_clock' && error.category === 'stale_data'
                    || error.code === 'invalid_api_data' && error.category === 'validation'));
    });
}

function candidate(config, state, now, allowReadHolds) {
    const operation = state?.continuousOperation, stop = state?.stopped;
    if (!identity(config, state) || !timestamp(now) || !record(operation)
        || operation.runtimeId !== (config.runtimeId || config.id)
        || !timestamp(operation.enabledAt) || operation.enabledAt < state.startedAt || operation.enabledAt > now
        || !record(stop) || !reasons.has(stop.reason) || !timestamp(stop.at)
        || stop.at < operation.enabledAt || stop.at > now
        || state.position != null || state.liveRiskStop != null || state.frozenAt != null
        || !(allowReadHolds ? retryableReadHolds(state.entryHolds, operation.enabledAt, now) : empty(state.entryHolds))
        || !empty(state.reconciliationFaults)
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || state.liveClock != null && (!record(state.liveClock)
            || !['verified', 'waiting'].includes(state.liveClock.status))
        || !Number.isFinite(state.cash) || !Number.isFinite(state.peakEquity)
        || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
        || !record(state.liveFunding) || !Number.isFinite(state.liveFunding.initialCapital)
        || state.liveFunding.initialCapital < 0 || !Number.isFinite(state.walletStart)
        || !Number.isFinite(state.walletCashDelta) || !record(state.seen) || !record(state.ai)
        || !record(state.ai.providers) || Object.entries(state.ai.providers).some(([name, provider]) =>
            name !== 'eligible' || !record(provider) || provider.pending || provider.disabled)
        || !Array.isArray(state.ai.snapshots) || !record(state.ai.slots) || !Array.isArray(state.completed)
        || state.completed.some(row => !record(row) || row.uncertain || row.pendingTrades
            || !Number.isFinite(row.pnl) || !timestamp(row.closedAt) || row.closedAt > now
            || !Array.isArray(row.tokens) || row.tokens.length !== 2 || row.tokens[0] === row.tokens[1]
            || row.tokens.some(token => typeof token !== 'string' || !/^[1-9]\d*$/.test(token)))
        || state.stopHistory != null && (!Array.isArray(state.stopHistory) || state.stopHistory.some(previous =>
            !record(previous) || !timestamp(previous.at) || typeof previous.reason !== 'string' || !previous.reason
            || previous.at === stop.at && previous.reason === stop.reason))) return false;
    return true;
}

export function continuousRecoveryCandidate(config, state, now = Date.now()) {
    return candidate(config, state, now, false);
}

// Read admission only: each engine stage still needs its own fresh proof to
// clear its hold, before the coordinator can consider clearing the stop.
export function continuousRecoveryReadCandidate(config, state, now = Date.now()) {
    return candidate(config, state, now, true);
}

function recoveryState(state) {
    // Background read diagnostics may save while proofs run. Everything that
    // can authorize or account for trading remains part of the comparison.
    const { events, operational, diagnostics, lastTickAt, lastHeartbeatAt, ...protectedState } = state;
    return protectedState;
}

export async function readAutomaticExternalAccount(config, state, client, account, proof, { now, guard }) {
    if (!state.externalWalletActivity?.automatic) fail();
    const checked = await new ExternalActivityReconciler(config, { state }, client, { now }).proof({
        block: proof.blockNumber, actual: proof.balance });
    guard();
    // Accounting is committed by the runtime reconciler. Stop recovery may
    // only verify the already-booked history and cannot import new activity.
    if (checked.summary.externalCashDelta !== 0 || checked.summary.depositAmount !== 0
        || checked.summary.receiptCount !== 0) fail();
    const balances = externalTokenBalances(state), seen = new Set(), excluded = [];
    if (!Array.isArray(account?.positions)) fail();
    for (const position of account.positions) {
        if (!record(position) || !Number.isFinite(position.size) || position.size < 0) fail();
        if (position.size === 0 && !Object.hasOwn(balances, position.tokenId)) continue;
        if (typeof position.tokenId !== 'string' || seen.has(position.tokenId)
            || !Object.hasOwn(balances, position.tokenId)) fail();
        seen.add(position.tokenId);
        const expected = Math.round(balances[position.tokenId] * 1e6), actual = position.size * 1e6;
        if (!Number.isSafeInteger(expected) || Math.abs(actual - Math.round(actual)) > .00001
            || ![expected, Math.floor(expected / 100) * 100, Math.floor((expected + 50) / 100) * 100]
                .includes(Math.round(actual))) fail();
        if (position.size > 0) excluded.push(structuredClone(position));
    }
    if (Object.entries(balances).some(([token, value]) => value > 0 && !seen.has(token))) fail();
    const api = account.checks?.find(row => row.name === 'authenticated_order_trade_api')?.detail;
    const orders = api?.orders || account.openOrders;
    const owned = state.completed.flatMap(row => row.orders || []).map(order => order.orderId).filter(Boolean);
    if (!Array.isArray(orders) || orders.some(order => owned.some(id => id.toLowerCase() === order.id?.toLowerCase()))) fail();
    const reservations = externalOrderReservations(orders);
    const knownHashes = [...new Set([...accountedCapitalHashes(state),
        ...[state.externalWalletActivity.walletProof, ...(state.strategyEpochs || []).map(epoch => epoch.walletProof)]
            .flatMap(saved => saved?.trades?.receiptConfirmed || [])
            .filter(row => Number.isSafeInteger(row.blockNumber) && row.blockNumber <= proof.blockNumber)
            .map(row => row.transactionHash)].filter(hash => /^0x[\da-f]{64}$/i.test(hash || '')))];
    const trades = await assertExternalTradesSettled(api?.trades, { client, block: proof.blockNumber, knownHashes });
    guard(); checked.guard();
    return { balances, trades, proof: { schema: 1, source: 'automatic_manual_ctf',
        blockNumber: proof.blockNumber, blockHash: proof.blockHash, verifiedAt: now(),
        checkpoint: state.externalWalletActivity.automatic.checkpoint,
        holdings: Object.entries(balances).map(([tokenId, amount]) => ({ tokenId, amount })),
        excludedLegacyInventory: excluded, orders: reservations } };
}

export class ContinuousRecovery {
    constructor(config, store, client, providers, { now = Date.now } = {}) {
        Object.assign(this, { config, store, client, providers, now });
        this.nextAt = 0;
        this.failures = 0;
        this.pending = null;
        this.closed = false;
    }
    event(type, detail, persist = true) {
        try {
            if (persist) this.store.event(type, detail);
            else this.store.logger?.({ at: new Date().toISOString(), type, ...detail });
        } catch { /* Diagnostics cannot end supervision. */ }
    }
    tick() {
        if (this.pending) return this.pending;
        if (this.closed || this.now() < this.nextAt
            || !continuousRecoveryCandidate(this.config, this.store.state, this.now())) return Promise.resolve(false);
        this.nextAt = this.now() + 30000;
        const pending = Promise.resolve().then(() => this.recover()).catch(error => {
            this.failures++;
            this.nextAt = this.now() + Math.min(60000, 30000 * 2 ** Math.min(1, this.failures - 1));
            // A failed proof may mean the disk ledger changed. Logging must
            // not save a stale in-memory ledger over that evidence.
            this.event('eligible_continuous_recovery_deferred', { error: safeError(error), nextAt: this.nextAt }, false);
            return false;
        }).finally(() => { if (this.pending === pending) this.pending = null; });
        this.pending = pending;
        return pending;
    }
    async recover() {
        const { config, store, client, providers } = this, state = store.state;
        const before = structuredClone(recoveryState(state)), beforeSha256 = digest(before);
        const guard = () => {
            if (this.closed || store.state !== state || !continuousRecoveryCandidate(config, state, this.now())
                || !isDeepStrictEqual(recoveryState(state), before)) fail();
        };
        const history = () => {
            guard();
            const rows = eligibleHistory(config), own = rows.find(row => row.baseline === config.id
                && row.strategy === 'late-entry');
            if (!own || !isDeepStrictEqual(recoveryState(own), before)) fail();
            return rows;
        };
        const checked = await eligiblePreflight(config, client, providers, state,
            { history: history(), refreshHistory: history });
        guard();
        if (checked.output.operationalReady !== true || checked.output.readyForLive !== false
            || checked.output.startAllowed !== false || checked.output.recoveryOnly !== false
            || !isDeepStrictEqual(checked.output.blockers, ['persistent_pilot_stop'])) fail();
        const proof = await readPeriodWalletProof(config, client);
        guard();
        const automatic = config.settings.automaticManualActivity === true;
        const readExternal = account => automatic
            ? readAutomaticExternalAccount(config, state, client, account, proof, { now: this.now, guard })
            : readExternalInventoryProof(config, state, client, account, proof, { now: this.now, guard });
        let external = await readExternal(checked.account);
        guard();
        let trades = automatic ? external.trades
            : await assertPeriodAccountReady(external.account, { client, wallet: config.settings.wallet, proof });
        guard();
        const holdings = [];
        for (const row of before.completed) {
            const amounts = await client.holdings(row.tokens, proof.blockNumber);
            guard();
            if (!Array.isArray(amounts) || amounts.length !== 2
                || amounts.some((amount, index) => amount !== (automatic ? external.balances[row.tokens[index]] || 0 : 0))) fail();
            holdings.push({ conditionId: row.conditionId, tokens: [...row.tokens], amounts });
        }
        // Completed-token checks can grow with the ledger. Refresh live order
        // admission after them rather than relying on the earlier API snapshot.
        const latestAccount = await client.ordersAndTrades();
        guard();
        if (!record(latestAccount) || !Array.isArray(latestAccount.orders)) fail();
        const positions = external.proof ? await client.positions() : checked.account.positions;
        guard();
        external = await readExternal(
            { ...checked.account, positions, openOrders: latestAccount.orders,
                checks: [{ name: 'authenticated_order_trade_api', detail: latestAccount }] });
        guard();
        trades = automatic ? external.trades
            : await assertPeriodAccountReady(external.account, { client, wallet: config.settings.wallet, proof });
        guard();
        const expected = expectedWalletBalance(state);
        if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
            || !Number.isFinite(checked.account.wallet?.balance)
            || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
            || client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
        history();
        const recoveredAt = this.now(), previous = state.stopped, previousHistory = state.stopHistory;
        const hadHistory = Object.hasOwn(state, 'stopHistory');
        state.stopHistory = [...(previousHistory || []), { ...previous, recoveredAt,
            runtimeId: config.runtimeId || config.id, reasonVerified: 'continuous_flat_account_recheck',
            enabledAt: state.continuousOperation.enabledAt, beforeSha256,
            walletProof: { ...proof, expectedBalance: expected, trades, holdings,
                ...(external.proof ? { externalInventoryProof: external.proof } : {}) } }];
        state.stopped = null;
        try { store.save(); }
        catch (error) {
            state.stopped = previous;
            if (hadHistory) state.stopHistory = previousHistory;
            else delete state.stopHistory;
            throw error;
        }
        this.failures = 0;
        this.event('eligible_continuous_stop_recovered', { stop: previous, recoveredAt,
            blockNumber: proof.blockNumber, blockHash: proof.blockHash, accountingPreserved: true, financialWrites: false });
        return true;
    }
}
