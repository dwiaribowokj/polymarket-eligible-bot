import crypto from 'node:crypto';
import { CONTRACTS } from '../restart/client.js';
import { round } from '../restart/math.js';
import { OperationalError, safeError } from '../restart/network.js';
import { expectedWalletBalance } from './recovery.js';
import { capitalFundingLedger, applyConfirmedCapitalDeposits } from './capital-funding.js';
import { discoverCapitalDeposits } from './deposit-proof.js';
import { clearEntryHold, holdEntry } from './entry-holds.js';

const HASH = /^0x[\da-f]{64}$/i;
const units = n => Math.round(n * 1e6);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new OperationalError(code, 'reconciliation', { stage: 'capital_deposit' }); };
const checkpoint = value => Number.isSafeInteger(value?.blockNumber) && value.blockNumber >= 0
    && HASH.test(value.blockHash || '');

export function depositRecoveryCandidate(config, state) {
    return config.settings.automaticDeposits === true && state?.decisionProvider === 'eligible'
        && !!state.liveFunding && !state.liveRiskStop && !state.frozenAt
        && (!state.stopped || state.stopped.reason === 'wallet_ledger_mismatch')
        && Object.keys(state.reconciliationFaults || {}).every(key => key === 'wallet_ledger_mismatch');
}

// Only accounted transaction hashes can be excluded from a transfer scan.
export function accountedCapitalHashes(state) {
    return [...new Set([
        ...Object.values(state.settlementEvidence || {}).filter(row => row.source === 'receipt').map(row => row.hash),
        ...Object.values(state.position?.receipts || {}).map(row => row.hash),
        ...(state.position?.actions || []).filter(row => row.status === 'confirmed').map(row => row.hash),
        ...(state.externalWalletActivity?.receipts || []).map(row => row.hash),
        ...(state.profitTaking?.withdrawals || []).map(row => row.hash),
        ...(state.profitTaking?.pending?.stage === 'in_transit' ? [state.profitTaking.pending.sourceReceipt?.hash] : []),
        ...Object.values(capitalFundingLedger(state)?.entries || {}).map(row => row.txHash),
    ].filter(hash => HASH.test(hash || '')).map(hash => hash.toLowerCase()))];
}

function protectedState(state) {
    return digest([state.cash, state.peakEquity, state.maxDrawdown, state.lastEquity, state.liveFunding,
        state.walletStart, state.walletCashDelta, state.capitalFunding, state.capitalAllocations, state.position, state.completed,
        state.externalWalletActivity, state.profitTaking, state.profitTakingControl?.operation,
        state.stopped, state.liveRiskStop, state.reconciliationFaults]);
}

function pending(state) {
    const p = state.position;
    const withdrawal = state.profitTaking?.pending, operation = state.profitTakingControl?.operation;
    const awaitingSource = withdrawal && withdrawal.stage !== 'in_transit'
        || operation && !['address_requested', 'address_ready', 'in_transit'].includes(operation.stage);
    return !!(awaitingSource || p &&
        (p.pendingTrades || p.orders?.some(order => !['complete', 'cancelled', 'rejected'].includes(order.status))
            || p.actions?.some(action => !['confirmed', 'failed'].includes(action.status))));
}

export class CapitalDepositReconciler {
    constructor(config, store, client, { discover = discoverCapitalDeposits, now = Date.now } = {}) {
        Object.assign(this, { config, store, client, discover, now });
        this.nextAt = 0; this.lastCheckpointAt = 0; this.closed = false;
    }
    enabled() { return this.config.settings.automaticDeposits === true && !!this.store.state.liveFunding; }
    defer(code = 'capital_deposit_verifying') {
        if (!this.store.state.entryHolds?.capital_deposit)
            holdEntry(this.store, 'capital_deposit', new OperationalError(code, 'opportunity',
                { stage: 'capital_deposit' }), { now: this.now(), retryable: true, delayMs: 15000 });
    }
    origin() {
        const state = this.store.state, saved = capitalFundingLedger(state)?.checkpoint;
        if (saved) return saved;
        const proof = state.strategyEpochs?.at(-1)?.walletProof;
        return checkpoint(proof) ? { blockNumber: proof.blockNumber, blockHash: proof.blockHash } : null;
    }
    async proof({ block, actual } = {}) {
        if (!this.enabled() || this.closed || pending(this.store.state)) return null;
        const state = this.store.state, before = protectedState(state);
        block ??= await this.client.confirmedBlock();
        const anchor = { ...this.client.rpc.anchor };
        if (anchor.number !== block || !HASH.test(anchor.hash || '')) fail('capital_deposit_snapshot_invalid');
        actual ??= await this.client.balance(block);
        const expected = expectedWalletBalance(state), delta = round(actual - expected);
        if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(expected)) fail('capital_deposit_balance_invalid');
        if (units(delta) <= 0) return null;
        const from = this.origin();
        if (!from) fail('capital_deposit_anchor_missing');
        const to = { blockNumber: block, blockHash: anchor.hash };
        const entries = await this.discover(this.client, { wallet: this.config.settings.wallet,
            from, to, knownHashes: accountedCapitalHashes(state), expectedDelta: delta });
        if (state.position) {
            const holdings = await this.client.holdings(state.position.market.tokens, block);
            if (!Array.isArray(holdings) || holdings.length !== state.position.holdings.length
                || holdings.some((v, i) => !Number.isFinite(v) || units(v) !== units(state.position.holdings[i])))
                fail('capital_deposit_holdings_pending');
        }
        if (this.closed || state !== this.store.state || before !== protectedState(state)
            || this.client.rpc.anchor.number !== block || this.client.rpc.anchor.hash !== anchor.hash)
            fail('capital_deposit_state_changed');
        return { chainId: 137, tokenAddress: CONTRACTS.collateralToken, walletAddress: this.config.settings.wallet,
            entries, expectedBalanceBefore: expected, actualBalanceAfter: actual, checkpoint: to, before };
    }
    async preview() {
        if (!depositRecoveryCandidate(this.config, this.store.state)) return null;
        try {
            const proof = await this.proof();
            if (proof) return { ready: true, amount: round(proof.actualBalanceAfter - proof.expectedBalanceBefore),
                balance: proof.actualBalanceAfter, deposits: proof.entries.length };
            if (!pending(this.store.state) && this.recoveryMatches()) {
                const block = await this.client.confirmedBlock(), actual = await this.client.balance(block);
                await this.verifyCheckpoint();
                if (units(actual) === units(expectedWalletBalance(this.store.state)))
                    return { ready: true, amount: 0, alreadyCredited: true, balance: actual, deposits: 0 };
            }
            return null;
        } catch { return null; }
    }
    recoveryMatches() {
        const state = this.store.state, credit = state.capitalDepositRecovery, ledger = capitalFundingLedger(state);
        return !!credit && !!ledger && credit.amount > 0
            && digest(credit.checkpoint) === digest(ledger.checkpoint)
            && credit.totalDeposited === ledger.totalDeposited && Array.isArray(credit.receiptIds)
            && credit.receiptIds.length > 0 && new Set(credit.receiptIds).size === credit.receiptIds.length
            && credit.receiptIds.every(id => Object.hasOwn(ledger.entries, id))
            && units(credit.receiptIds.reduce((sum, id) => sum + ledger.entries[id].amount, 0)) === units(credit.amount)
            && digest(credit.stop) === digest(state.stopped || null)
            && digest(credit.fault) === digest(state.reconciliationFaults?.wallet_ledger_mismatch || null);
    }
    async verifyCheckpoint() {
        const saved = this.origin();
        if (saved) await this.client.rpc.read('capital_deposit_anchor', provider => this.client.rpc.validate(provider,
            { number: saved.blockNumber, hash: saved.blockHash }), this.client.rpc.anchor.number);
    }
    clearProvenStop(proof) {
        const state = this.store.state;
        if (!this.recoveryMatches() || !depositRecoveryCandidate(this.config, state)
            || units(expectedWalletBalance(state)) !== units(proof.actualBalanceAfter)) return;
        if (state.stopped?.reason === 'wallet_ledger_mismatch' || state.reconciliationFaults?.wallet_ledger_mismatch) {
            state.capitalRecoveryHistory ||= [];
            state.capitalRecoveryHistory.push({ at: this.now(), stop: state.stopped,
                fault: state.reconciliationFaults?.wallet_ledger_mismatch || null,
                proofBlock: proof.checkpoint, totalDeposited: state.capitalFunding.totalDeposited });
            if (state.stopped?.reason === 'wallet_ledger_mismatch') state.stopped = null;
            if (state.reconciliationFaults) delete state.reconciliationFaults.wallet_ledger_mismatch;
            delete state.capitalDepositRecovery;
            this.store.save();
            this.store.event('capital_deposit_stop_recovered', { block: proof.checkpoint.blockNumber });
        } else {
            delete state.capitalDepositRecovery;
            this.store.save();
        }
    }
    async reconcile({ block, actual, bootstrap = false } = {}) {
        if (!this.enabled() || this.closed || this.now() < this.nextAt || pending(this.store.state)) return false;
        try {
            block ??= await this.client.confirmedBlock();
            actual ??= await this.client.balance(block);
            const state = this.store.state, expected = expectedWalletBalance(state), anchor = this.client.rpc.anchor;
            if (!Number.isFinite(actual) || !Number.isFinite(expected) || anchor?.number !== block || !HASH.test(anchor.hash || ''))
                fail('capital_deposit_balance_invalid');
            if (units(actual) === units(expected)) {
                // A restart after credit was persisted but before clearing its old hold is idempotent.
                const ledger = capitalFundingLedger(state);
                if (ledger?.totalDeposited > 0 && state.capitalDepositRecovery) {
                    await this.verifyCheckpoint();
                    const p = state.position;
                    if (p) {
                        const holdings = await this.client.holdings(p.market.tokens, block);
                        if (!Array.isArray(holdings) || holdings.length !== p.holdings.length
                            || holdings.some((v, i) => !Number.isFinite(v) || units(v) !== units(p.holdings[i])))
                            fail('capital_deposit_holdings_pending');
                    }
                    this.clearProvenStop({ actualBalanceAfter: actual,
                        checkpoint: { blockNumber: block, blockHash: anchor.hash } });
                }
                clearEntryHold(this.store, 'capital_deposit', { now: this.now(), proof: 'confirmed_wallet_balance' });
                if (!state.position && !state.capitalDepositRecovery && (bootstrap || this.now() - this.lastCheckpointAt >= 60000)) {
                    await this.verifyCheckpoint();
                    applyConfirmedCapitalDeposits(this.store, { chainId: 137, tokenAddress: CONTRACTS.collateralToken,
                        walletAddress: this.config.settings.wallet, entries: [], expectedBalanceBefore: expected,
                        actualBalanceAfter: actual, checkpoint: { blockNumber: block, blockHash: anchor.hash } });
                    this.lastCheckpointAt = this.now();
                }
                return true;
            }
            if (actual < expected) return false;
            this.defer();
            const proof = await this.proof({ block, actual });
            if (!proof) return false;
            if (proof.before !== protectedState(state)) fail('capital_deposit_state_changed');
            const previousRecovery = state.capitalDepositRecovery;
            state.capitalDepositRecovery = { stop: state.stopped || null,
                fault: state.reconciliationFaults?.wallet_ledger_mismatch || null, checkpoint: proof.checkpoint,
                amount: round(proof.actualBalanceAfter - proof.expectedBalanceBefore), balanceAfter: proof.actualBalanceAfter,
                totalDeposited: round((capitalFundingLedger(state)?.totalDeposited || 0) + proof.actualBalanceAfter - proof.expectedBalanceBefore),
                receiptIds: proof.entries.map(row => `137:${CONTRACTS.collateralToken.toLowerCase()}:${this.config.settings.wallet.toLowerCase()}:${row.txHash.toLowerCase()}:${row.logIndex}`) };
            let applied;
            try { applied = applyConfirmedCapitalDeposits(this.store, proof); }
            catch (error) {
                if (previousRecovery === undefined) delete state.capitalDepositRecovery;
                else state.capitalDepositRecovery = previousRecovery;
                throw error;
            }
            this.clearProvenStop(proof);
            clearEntryHold(this.store, 'capital_deposit', { now: this.now(), proof: 'canonical_deposit_receipts' });
            this.lastCheckpointAt = this.now();
            this.store.event('capital_deposit_credited', { amount: applied.amount, totalDeposited: applied.totalDeposited,
                receipts: applied.applied.map(row => ({ hash: row.txHash, logIndex: row.logIndex, amount: row.amount })),
                blockNumber: block, cash: state.cash, walletPUSD: actual, tradingProfitChanged: false });
            return true;
        } catch (error) {
            this.nextAt = this.now() + 15000;
            this.defer();
            this.store.event('capital_deposit_retry', { error: safeError(error), nextAt: this.nextAt });
            return false;
        }
    }
}
