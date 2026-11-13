import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CONTRACTS } from '../restart/client.js';
import { OperationalError } from '../restart/network.js';
import { expectedWalletBalance } from './recovery.js';
import { accountedCapitalHashes } from './deposits.js';
import { applyConfirmedCapitalDeposits, capitalFundingLedger } from './capital-funding.js';
import { profitTakingLedger } from './profit-accounting.js';
import { holdEntry } from './entry-holds.js';
import { discoverExternalActivity } from './external-activity-proof.js';
import { safeError } from './network.js';

const HASH = /^0x[\da-f]{64}$/i, TOKEN = /^[1-9]\d*$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const fail = code => { throw new OperationalError(`external_activity_${code}`, 'reconciliation', { stage: 'external_activity' }); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checkpoint = value => integer(value?.blockNumber) && HASH.test(value.blockHash || '');
const protectedDigest = state => {
    const { events, operational, diagnostics, lastTickAt, lastHeartbeatAt, ...protectedState } = state;
    return digest(protectedState);
};
const units = value => {
    if (!Number.isFinite(value)) fail('amount_invalid');
    const scaled = Math.round(value * 1e6);
    if (!Number.isSafeInteger(scaled) || Math.abs(value * 1e6 - scaled) > .00001) fail('amount_invalid');
    return BigInt(scaled);
};
const amount = value => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) fail('amount_invalid');
    return Number(value) / 1e6;
};
const blockIdentity = proof => ({ blockNumber: proof.blockNumber, blockHash: lower(proof.blockHash) });

function balanceMap(rows) {
    if (!Array.isArray(rows)) fail('inventory_invalid');
    const result = new Map();
    for (const row of rows) {
        if (!record(row) || typeof row.tokenId !== 'string' || !TOKEN.test(row.tokenId) || result.has(row.tokenId)
            || units(row.amount) < 0n) fail('inventory_invalid');
        result.set(row.tokenId, units(row.amount));
    }
    return result;
}

function receiptBalances(receipts, { allowNegative = false } = {}) {
    if (!Array.isArray(receipts)) fail('receipts_invalid');
    const holdings = new Map(), hashes = new Set();
    let cash = 0n;
    for (const row of receipts) {
        if (!record(row) || !HASH.test(row.hash || '') || hashes.has(lower(row.hash))
            || !checkpoint(row) || !Array.isArray(row.tokenIds) || !Array.isArray(row.holdings)
            || row.tokenIds.length !== row.holdings.length || new Set(row.tokenIds).size !== row.tokenIds.length
            || row.tokenIds.some(token => typeof token !== 'string' || !TOKEN.test(token))) fail('receipts_invalid');
        hashes.add(lower(row.hash)); cash += units(row.cash);
        row.tokenIds.forEach((token, index) => holdings.set(token, (holdings.get(token) || 0n) + units(row.holdings[index])));
    }
    if (!allowNegative && [...holdings.values()].some(value => value < 0n)) fail('inventory_negative');
    return { holdings, cash, hashes };
}

function sameHoldings(actual, expected) {
    const tokens = new Set([...actual.keys(), ...expected.keys()]);
    return [...tokens].every(token => (actual.get(token) || 0n) === (expected.get(token) || 0n));
}

export function externalTokenBalances(state) {
    const external = state.externalWalletActivity;
    if (external == null) return {};
    const receipts = receiptBalances(external.receipts);
    if (receipts.cash !== units(external.cashDelta)) fail('cash_history_invalid');
    let holdings;
    if (external.automatic != null) {
        if (external.automatic.schema !== 1 || !checkpoint(external.automatic.checkpoint)) fail('checkpoint_invalid');
        holdings = balanceMap(external.automatic.holdings);
    } else {
        if (!Array.isArray(external.zeroPayoutInventory)) fail('inventory_unproven');
        holdings = new Map();
        for (const row of external.zeroPayoutInventory) {
            if (!record(row) || !Array.isArray(row.tokens) || row.tokens.length !== 2
                || !Array.isArray(row.amounts) || row.amounts.length !== 2
                || !isDeepStrictEqual(row.payout, [1, 0]) && !isDeepStrictEqual(row.payout, [0, 1])) fail('inventory_unproven');
            row.tokens.forEach((token, index) => {
                if (!TOKEN.test(token) || holdings.has(token) || units(row.amounts[index]) < 0n
                    || row.amounts[index] > 0 && row.payout[index] !== 0) fail('inventory_unproven');
                holdings.set(token, units(row.amounts[index]));
            });
        }
    }
    if (!sameHoldings(holdings, receipts.holdings)) fail('inventory_history_mismatch');
    return Object.fromEntries([...new Map([...receipts.holdings, ...holdings])].map(([token, value]) => [token, amount(value)]));
}

function seed(state) {
    const external = state.externalWalletActivity;
    if (external != null) {
        const holdings = externalTokenBalances(state), saved = external.automatic?.checkpoint || external.walletProof;
        if (!checkpoint(saved) || external.receipts.some(row => row.blockNumber > saved.blockNumber)) fail('checkpoint_missing');
        if (!external.automatic && (!integer(external.reviewedAt) || external.capitalAllocated !== 0
            || !checkpoint(external.walletProof.manualHoldingsProof)
            || external.walletProof.manualHoldingsProof.blockNumber !== saved.blockNumber
            || lower(external.walletProof.manualHoldingsProof.blockHash) !== lower(saved.blockHash))) fail('seed_unproven');
        if (!external.automatic) {
            const tokens = external.checkpoint?.tokenIds, amounts = external.walletProof.manualHoldingsProof.amounts;
            if (!Array.isArray(tokens) || !Array.isArray(amounts) || tokens.length !== amounts.length
                || new Set(tokens).size !== tokens.length || tokens.some(token => !TOKEN.test(token))
                || Object.entries(holdings).some(([token, value]) => value > 0 && !tokens.includes(token))
                || amounts.some((value, index) => units(value) !== units(holdings[tokens[index]] || 0))) fail('seed_unproven');
        }
        return { checkpoint: blockIdentity(saved), holdings, source: external.automatic ? 'automatic' : 'reviewed_manual' };
    }
    const proof = state.strategyEpochs?.at(-1)?.walletProof;
    if (!checkpoint(proof) || !Number.isFinite(proof.balance) || !record(proof.trades)
        || !Array.isArray(proof.holdingsProof?.holdings)
        || proof.holdingsProof.holdings.some(row => !Array.isArray(row.amounts) || row.amounts.some(value => value !== 0))
        || proof.excludedLegacyInventory?.some(row => row.size !== 0)
        || proof.externalInventoryProof?.inventory?.some(row => row.amounts?.some(value => value !== 0))) fail('seed_unproven');
    return { checkpoint: blockIdentity(proof), holdings: {}, source: 'flat_strategy_epoch' };
}

function terminalEmptyOrder(order) {
    if (order.filled !== 0 || order.settled !== 0 || order.queryRetry != null || order.cancelRetry != null
        || order.awaitingReceipt || order.cancelSettled === false
        || order.apiMatchedQuantity != null && order.apiMatchedQuantity.shares !== 0
        || String(order.apiSubmissionStatus).toUpperCase() === 'MATCHED'
        || [order.transactions, order.tradeIds].some(rows => rows != null && (!Array.isArray(rows) || rows.length))
        || order.matchedTrades != null && (!record(order.matchedTrades) || Object.keys(order.matchedTrades).length)) return false;
    if (order.status === 'cancelled') return order.cancelSettled === true && integer(order.cancelConfirmedAt);
    return order.status === 'complete' && integer(order.apiTerminal?.at) && order.apiTerminal.filled === 0
        && ['CANCELED', 'CANCELLED', 'EXPIRED', 'UNMATCHED'].includes(String(order.apiTerminal.status).toUpperCase());
}

function emptyReservation(position) {
    // Validation can veto after reservation but before an order is prepared.
    // Admit only its untouched accounting; wallet and inventory proof still run.
    return position.uncertain === false && integer(position.openedAt)
        && (position.submitAttemptedAt === undefined || integer(position.submitAttemptedAt)
            && position.submitAttemptedAt >= position.openedAt)
        && position.holdings.every(value => value === 0)
        && Array.isArray(position.bought) && position.bought.length === 2 && position.bought.every(value => value === 0)
        && Array.isArray(position.fills) && position.fills.length === 0
        && Array.isArray(position.actions) && position.actions.length === 0
        && record(position.receipts) && Object.keys(position.receipts).length === 0
        && ['entryCost', 'fees', 'gas', 'rebate', 'lastDeployed', 'capitalHours'].every(key => position[key] === 0)
        && ['receiptRetries', 'failedTrades', 'failedSettlementHashes'].every(key => position[key] === undefined
            || record(position[key]) && Object.keys(position[key]).length === 0)
        && ['pendingSince', 'accountQueryRetry', 'autoRedeemWait', 'autoRedeemRetry', 'actionPreparationRetry']
            .every(key => position[key] == null);
}

function stablePosition(position) {
    if (position == null) return true;
    return record(position) && position.pendingTrades === false && position.uncertain !== true
        && Array.isArray(position.market?.tokens) && position.market.tokens.length === 2
        && new Set(position.market.tokens).size === 2 && position.market.tokens.every(token => TOKEN.test(token))
        && Array.isArray(position.holdings) && position.holdings.length === 2
        && position.holdings.every(value => Number.isFinite(value) && units(value) >= 0n)
        && Array.isArray(position.orders) && (position.orders.length > 0 || emptyReservation(position))
        && position.orders.every(order => record(order) && (order.status === 'rejected' && !(order.filled > 0)
            || ['complete', 'cancelled'].includes(order.status) && order.receiptProvenComplete === true
            || terminalEmptyOrder(order)))
        && Array.isArray(position.actions) && position.actions.every(action => ['confirmed', 'failed'].includes(action.status));
}

function freshWallet(state) {
    return state.externalWalletActivity == null && state.position == null && !state.stopped
        && Array.isArray(state.completed) && state.completed.length === 0
        && Array.isArray(state.ai?.snapshots) && state.ai.snapshots.length === 0
        && record(state.seen) && Object.keys(state.seen).length === 0
        && units(state.walletCashDelta) === 0n && units(state.walletStart) === units(state.liveFunding.initialCapital)
        && units(state.cash) === units(state.walletStart)
        && (capitalFundingLedger(state)?.totalDeposited || 0) === 0;
}

function withdrawalSourceAccounted(state) {
    const pending = profitTakingLedger(state)?.pending, operation = state.profitTakingControl?.operation;
    if (operation == null) return pending == null;
    if (!record(operation) || typeof operation.id !== 'string' || !/^[\w:-]{1,128}$/.test(operation.id)
        || !integer(operation.createdAt)) return false;
    if (['address_requested', 'address_ready'].includes(operation.stage)
        || operation.stage === 'address_unknown' && state.profitTakingControl.disabled === 'bridge_withdrawal_creation_unknown')
        return pending == null && operation.transfer == null && operation.submittedAt == null;
    // Only a source debit already included in the validated profit ledger may
    // be excluded from manual discovery while destination settlement continues.
    if (operation.stage !== 'in_transit' || pending?.stage !== 'in_transit' || pending.id !== operation.id
        || !HASH.test(operation.transfer?.hash || '') || /^0x0{64}$/i.test(operation.transfer.hash)
        || lower(pending.hash) !== lower(operation.transfer.hash)
        || lower(pending.sourceReceipt?.hash) !== lower(operation.transfer.hash)) return false;
    return accountedCapitalHashes(state).includes(lower(operation.transfer.hash));
}

export function externalActivityCandidate(config, state) {
    try {
        return config.settings.automaticManualActivity === true && record(state?.liveFunding)
            && Number.isFinite(state.walletStart) && !state.liveRiskStop && !state.frozenAt
            && withdrawalSourceAccounted(state)
            && stablePosition(state.position);
    } catch { return false; }
}

export class ExternalActivityReconciler {
    constructor(config, store, client, { now = Date.now, discover = discoverExternalActivity } = {}) {
        Object.assign(this, { config, store, client, now, discover });
        this.closed = false; this.nextAt = 0; this.retryDelayMs = 0; this.running = false;
    }
    enabled() { return this.config.settings.automaticManualActivity === true; }
    close() { this.closed = true; }
    retryAt() {
        const hold = this.store.state.entryHolds?.external_activity;
        return Math.max(this.nextAt, hold?.retryable === true && integer(hold.retryAt) ? hold.retryAt : 0);
    }
    defer(code = 'external_activity_verifying') {
        if (!this.enabled() || this.closed) return;
        const message = /^external_activity_[a-z_]+$/.test(code) ? code : 'external_activity_verifying';
        holdEntry(this.store, 'external_activity', new OperationalError(message, 'opportunity', { stage: 'external_activity' }),
            { now: this.now(), retryable: true, delayMs: 1000 });
    }
    async proof({ block, actual } = {}) {
        const state = this.store.state;
        if (!this.enabled() || this.closed || !externalActivityCandidate(this.config, state)) fail('busy');
        if (this.now() < this.retryAt()) fail('retry_wait');
        const startedAt = this.now(), before = protectedDigest(state), configSha256 = digest(this.config);
        let lastAt = startedAt;
        const guard = () => {
            const at = this.now();
            if (this.closed || state !== this.store.state || !integer(at) || at < lastAt || at - startedAt > 600000
                || protectedDigest(state) !== before || digest(this.config) !== configSha256) fail('state_changed');
            lastAt = at;
        };
        guard();
        let origin;
        try { origin = seed(state); } catch (error) { if (!freshWallet(state)) throw error; }
        const expected = expectedWalletBalance(state);
        block ??= await this.client.confirmedBlock(); guard();
        const anchor = { ...this.client.rpc.anchor }, to = { blockNumber: block, blockHash: lower(anchor.hash) };
        if (!checkpoint(to) || anchor.number !== block) fail('snapshot_changed');
        actual ??= await this.client.balance(block); guard();
        if (units(actual) < 0n) fail('balance_invalid');
        if (!origin) {
            const [positions, account] = await Promise.all([this.client.positions(), this.client.ordersAndTrades()]); guard();
            if (units(actual) !== units(expected) || !Array.isArray(positions)
                || positions.some(row => !record(row) || row.size !== 0)
                || !record(account) || !Array.isArray(account.orders) || account.orders.length
                || !Array.isArray(account.trades) || account.trades.some(row => !record(row)
                    || !['CONFIRMED', 'FAILED'].includes(row.status?.replace(/^TRADE_STATUS_/, '')))) fail('seed_unproven');
            origin = { checkpoint: to, holdings: {}, source: 'fresh_flat_wallet' };
        }
        if (block < origin.checkpoint.blockNumber
            || block === origin.checkpoint.blockNumber && to.blockHash !== origin.checkpoint.blockHash) fail('checkpoint_regressed');
        const pinned = async (task, key) => {
            guard();
            if (this.client.rpc.anchor?.number !== block || lower(this.client.rpc.anchor.hash) !== to.blockHash) fail('snapshot_changed');
            const result = await this.client.rpc.read('external_activity_anchor', task, block, key);
            guard(); return result;
        };
        const checkOrigin = () => pinned(async provider => {
            const header = await provider.getBlock(origin.checkpoint.blockNumber);
            if (header?.number !== origin.checkpoint.blockNumber || lower(header.hash) !== origin.checkpoint.blockHash) fail('checkpoint_changed');
        }, `external_origin:${origin.checkpoint.blockNumber}:${origin.checkpoint.blockHash}`);
        await checkOrigin();
        const botRows = [...(state.completed || []), ...(state.position ? [state.position] : [])];
        const botTokens = state.position ? [...state.position.market.tokens] : [];
        const botOrderIds = [...new Set(botRows.flatMap(row => row.orders || []).map(row => lower(row.orderId)).filter(value => HASH.test(value)))];
        const knownHashes = [...new Set([...accountedCapitalHashes(state), ...botRows.flatMap(row => [
            ...Object.keys(row.receipts || {}),
            ...(row.actions || []).filter(action => action.status === 'confirmed').map(action => action.hash),
            ...(row.orders || []).filter(order => order.receiptProvenComplete === true).flatMap(order => order.transactions || []),
        ]).filter(value => HASH.test(value || '')).map(lower)])];
        const discovered = block === origin.checkpoint.blockNumber
            ? { receipts: [], externalCashDelta: 0, tokenIds: [], holdingsDeltas: [], deposits: [], depositAmount: 0, checkpoint: to }
            // Reserve bot orders, then check net ownership after the scan so a
            // completed manual roundtrip in the same token can recover.
            : await this.discover(this.client, { wallet: this.config.settings.wallet, from: origin.checkpoint, to,
                knownHashes, botTokens: [], botOrderIds });
        guard();
        if (!record(discovered) || !isDeepStrictEqual(discovered.checkpoint, to)
            || !Array.isArray(discovered.deposits) || !Array.isArray(discovered.holdingsDeltas)) fail('proof_invalid');
        const newReceipts = receiptBalances(discovered.receipts, { allowNegative: true }), deltas = new Map();
        const withinScan = row => checkpoint(row) && row.blockNumber > origin.checkpoint.blockNumber
            && row.blockNumber <= to.blockNumber
            && (row.blockNumber !== to.blockNumber || lower(row.blockHash) === to.blockHash);
        if (discovered.receipts.some(row => !withinScan(row))) fail('proof_invalid');
        for (const row of discovered.holdingsDeltas) {
            if (!record(row) || !TOKEN.test(row.tokenId) || deltas.has(row.tokenId)) fail('proof_invalid');
            deltas.set(row.tokenId, units(row.amount));
        }
        if (newReceipts.cash !== units(discovered.externalCashDelta) || !sameHoldings(deltas, newReceipts.holdings)
            || [...newReceipts.hashes].some(hash => knownHashes.includes(hash))) fail('proof_invalid');
        const holdings = new Map(Object.entries(origin.holdings).map(([token, value]) => [token, units(value)]));
        for (const [token, delta] of deltas) holdings.set(token, (holdings.get(token) || 0n) + delta);
        if ([...holdings.values()].some(value => value < 0n)) fail('inventory_negative');
        let depositUnits = 0n;
        for (const entry of discovered.deposits) {
            if (!withinScan(entry) || !HASH.test(entry.txHash || '') || knownHashes.includes(lower(entry.txHash))
                || newReceipts.hashes.has(lower(entry.txHash)) || units(entry.amount) <= 0n) fail('proof_invalid');
            depositUnits += units(entry.amount);
        }
        if (depositUnits !== units(discovered.depositAmount)
            || units(expected) + newReceipts.cash + depositUnits !== units(actual)) fail('balance_mismatch');
        const tokens = [...holdings.keys()];
        const verifyHoldings = async selectedBlock => {
            if (botTokens.some(token => (holdings.get(token) || 0n) !== 0n)) fail('bot_overlap');
            const actualHoldings = tokens.length ? await this.client.holdings(tokens, selectedBlock) : [];
            guard();
            if (!Array.isArray(actualHoldings) || actualHoldings.length !== tokens.length
                || actualHoldings.some((value, index) => {
                    const botIndex = botTokens.indexOf(tokens[index]);
                    return units(value) !== holdings.get(tokens[index])
                        + (botIndex < 0 ? 0n : units(state.position.holdings[botIndex]));
                })) fail('holdings_mismatch');
            if (state.position) {
                const bot = await this.client.holdings(state.position.market.tokens, selectedBlock); guard();
                if (!Array.isArray(bot) || bot.length !== 2
                    || bot.some((value, index) => units(value) !== units(state.position.holdings[index]))) fail('bot_overlap');
            }
        };
        await verifyHoldings(block);
        await checkOrigin();
        // Book only the fully scanned confirmed snapshot. Newer manual trades
        // remain for the next scan instead of invalidating a complete history.
        const finalStartedAt = this.now(), finalBlock = block;
        const finalAnchor = { ...this.client.rpc.anchor };
        if (!integer(finalBlock) || finalBlock < block || finalAnchor.number !== finalBlock || !HASH.test(finalAnchor.hash || '')
            || finalBlock === block && lower(finalAnchor.hash) !== to.blockHash) fail('snapshot_changed');
        const finalBalance = await this.client.balance(finalBlock); guard();
        if (units(finalBalance) !== units(actual)) fail('balance_changed');
        await verifyHoldings(finalBlock);
        await this.client.rpc.read('external_activity_final_anchor', async provider => {
            const header = await provider.getBlock(block);
            if (header?.number !== block || lower(header.hash) !== to.blockHash) fail('checkpoint_changed');
        }, finalBlock);
        guard();
        const verifiedAt = this.now();
        if (verifiedAt - finalStartedAt > 30000 || this.client.rpc.anchor?.number !== finalBlock
            || this.client.rpc.anchor.hash !== finalAnchor.hash) fail('proof_expired');
        const nextState = structuredClone(state), existing = state.externalWalletActivity;
        nextState.externalWalletActivity = { ...structuredClone(existing || {}),
            cashDelta: amount(units(existing?.cashDelta || 0) + newReceipts.cash),
            receipts: [...structuredClone(existing?.receipts || []), ...structuredClone(discovered.receipts)],
            capitalAllocated: 0,
            automatic: { schema: 1, checkpoint: to, holdings: tokens.map(token => ({ tokenId: token, amount: amount(holdings.get(token)) })),
                verifiedAt, finalBlockNumber: finalBlock, finalBlockHash: lower(finalAnchor.hash),
                seed: structuredClone(existing?.automatic?.seed || origin),
                externalCashDelta: amount(newReceipts.cash), depositAmount: amount(depositUnits) } };
        if (!existing) Object.assign(nextState.externalWalletActivity, { zeroPayoutInventory: [], reason: 'automatic_external_wallet_activity' });
        if (discovered.deposits.length) applyConfirmedCapitalDeposits({ state: nextState, save() {} }, {
            chainId: 137, tokenAddress: CONTRACTS.collateralToken, walletAddress: this.config.settings.wallet,
            entries: discovered.deposits, expectedBalanceBefore: amount(units(expected) + newReceipts.cash),
            actualBalanceAfter: actual, checkpoint: to });
        if (units(expectedWalletBalance(nextState)) !== units(actual)) fail('balance_mismatch');
        const summary = { ready: true, automaticRecoveryAvailable: true, externalCashDelta: amount(newReceipts.cash),
            totalExternalCashDelta: nextState.externalWalletActivity.cashDelta, depositAmount: amount(depositUnits),
            balance: actual, checkpoint: to, receiptCount: discovered.receipts.length,
            openExternalTokens: [...holdings.values()].filter(value => value > 0n).length };
        return { state, before, nextState, summary, verifiedAt, expiresAt: finalStartedAt + 30000, guard };
    }
    async preview(options = {}) {
        if (!this.enabled() || !externalActivityCandidate(this.config, this.store.state)) return null;
        try { return (await this.proof(options)).summary; }
        catch (error) { return { ready: false, automaticRecoveryAvailable: false, error: safeError(error) }; }
    }
    async reconcile(options = {}) {
        if (!this.enabled() || this.closed || this.running || this.now() < this.retryAt()) return false;
        this.running = true;
        try {
            const reviewed = await this.proof(options), { state, nextState } = reviewed;
            reviewed.guard();
            if (this.now() > reviewed.expiresAt || protectedDigest(state) !== reviewed.before) fail('proof_expired');
            const recoveredHold = ['external_activity', 'capital_deposit'].some(key => state.entryHolds?.[key]?.retryable === true);
            const recoveredMismatch = state.stopped?.reason === 'wallet_ledger_mismatch'
                || !!state.reconciliationFaults?.wallet_ledger_mismatch;
            nextState.entryHolds ||= {};
            for (const key of ['external_activity', 'capital_deposit']) if (nextState.entryHolds[key]?.retryable === true)
                delete nextState.entryHolds[key];
            if (state.stopped?.reason === 'wallet_ledger_mismatch' || state.reconciliationFaults?.wallet_ledger_mismatch) {
                nextState.externalActivityRecoveryHistory = [...(state.externalActivityRecoveryHistory || []), {
                    at: this.now(), stop: structuredClone(state.stopped || null),
                    fault: structuredClone(state.reconciliationFaults?.wallet_ledger_mismatch || null),
                    checkpoint: reviewed.summary.checkpoint, expectedBalance: reviewed.summary.balance }];
                if (state.stopped?.reason === 'wallet_ledger_mismatch') nextState.stopped = null;
                if (nextState.reconciliationFaults) delete nextState.reconciliationFaults.wallet_ledger_mismatch;
            }
            const keys = ['externalWalletActivity', 'capitalFunding', 'cash', 'peakEquity', 'lastEquity',
                'entryHolds', 'stopped', 'reconciliationFaults', 'externalActivityRecoveryHistory'];
            const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(state, key)]));
            const startingCash = state.position && Object.getOwnPropertyDescriptor(state.position, 'startingCash');
            try {
                for (const key of keys) {
                    if (Object.hasOwn(nextState, key)) state[key] = nextState[key]; else delete state[key];
                }
                if (state.position && nextState.position?.startingCash !== state.position.startingCash)
                    state.position.startingCash = nextState.position.startingCash;
                this.store.save();
            } catch (error) {
                for (const [key, descriptor] of previous) {
                    if (descriptor) Object.defineProperty(state, key, descriptor); else delete state[key];
                }
                if (state.position) {
                    if (startingCash) Object.defineProperty(state.position, 'startingCash', startingCash);
                    else delete state.position.startingCash;
                }
                throw error;
            }
            this.nextAt = 0; this.retryDelayMs = 0;
            this.lastSummary = reviewed.summary; this.lastError = null; this.lastFailureCode = null;
            if (reviewed.summary.receiptCount || reviewed.summary.depositAmount || recoveredHold || recoveredMismatch) {
                const { ready, automaticRecoveryAvailable, ...detail } = reviewed.summary;
                try { this.store.event?.('external_activity_reconciled', detail); } catch {}
            }
            return true;
        } catch (error) {
            this.retryDelayMs = Math.min(60000, (this.retryDelayMs || 500) * 2);
            this.nextAt = this.now() + this.retryDelayMs;
            this.lastError = safeError(error);
            // A failed persistence attempt must still leave accounting rolled back.
            try { this.defer(error.code || error.message); } catch {}
            this.nextAt = this.retryAt();
            if (this.lastFailureCode !== this.lastError.code || this.now() - (this.lastFailureEventAt || 0) >= 60000) {
                this.lastFailureCode = this.lastError.code; this.lastFailureEventAt = this.now();
                try { this.store.event?.('external_activity_deferred', { error: this.lastError, nextAt: this.nextAt }); } catch {}
            }
            return false;
        } finally { this.running = false; }
    }
}
