import { Engine } from '../restart/engine.js';
import { EPS, equity } from '../restart/math.js';
import { accrueCapital } from '../restart/strategy.js';
import { OperationalError, TRANSPORT } from '../restart/network.js';
import { safeError } from './network.js';
import { clearEntryHold, entryHeld, holdEntry, readRetryReady, temporaryReadFailure } from './entry-holds.js';
import { evaluateLiveRisk } from './risk.js';
import { lossProtectionActivationId, lossWalletProofMatches } from './loss-evidence.js';

const freshMark = (books, now, maxAgeMs) => Array.isArray(books) && books.length === 2 && books.every(book =>
    Number.isFinite(book.timestamp) && Number.isFinite(book.fetchedAt) && book.timestamp <= now && book.fetchedAt <= now
    && now - book.timestamp <= maxAgeMs && now - book.fetchedAt <= maxAgeMs && Array.isArray(book.bids)
    && book.bids.every(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1
        && Number.isFinite(level.size) && level.size > 0));
const markReadError = (books, now, maxAgeMs) => {
    if (!Array.isArray(books) || books.length !== 2 || books.some(book => !book
        || !Number.isFinite(book.timestamp) || !Number.isFinite(book.fetchedAt)
        || book.timestamp > now || book.fetchedAt > now || !Array.isArray(book.bids)
        || book.bids.some(level => !Number.isFinite(level.price) || level.price <= 0 || level.price >= 1
            || !Number.isFinite(level.size) || level.size <= 0)))
        return new OperationalError('invalid_mark_books', 'validation', { stage: 'book_read' });
    if (!freshMark(books, now, maxAgeMs)) return new OperationalError('stale_book', 'stale_data', { stage: 'book_read' });
    return null;
};
const validPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(value => Number.isFinite(value) && value >= 0 && value <= 1)
    && Math.abs(payout[0] + payout[1] - 1) <= EPS;
const markResponseCodes = new Set(['invalid_mark_books', 'invalid_api_data', 'market_constraints_changed',
    'tick_snapshot_mismatch', 'metadata_mismatch']);

// This override is live-only. Read failures hold entry while the serialized
// maintenance pass keeps proving existing orders, wallet movements and payout.
export class MaintenanceEngine extends Engine {
    continuousReadPolicy() {
        return this.settings?.continuousTrading === true && this.store.state.mode === 'pilot'
            && this.store.state.decisionProvider === 'eligible';
    }
    async checkClock() { throw new Error('live_clock_hook_missing'); }
    readReady(key, now) {
        const hold = this.store.state.entryHolds?.[key];
        return hold?.retryable === false ? now >= (this.diagnosticReadAt?.[key] || hold.retryAt)
            : readRetryReady(this.store.state, key, now);
    }
    readFailed(key, error, now, { mark = false, response = false } = {}) {
        const diagnostic = safeError(error);
        // A rejected eth_call changed no wallet state. Keep probing this read
        // boundary; entry/actions still require a successful accounting check.
        const retryRpcResponse = this.continuousReadPolicy() && diagnostic.code === 'rpc_rejected'
            && ['contract', 'validation', 'api_rejection'].includes(diagnostic.category)
            && diagnostic.rpcMethod === 'eth_call'
            && (key === 'maintenance_wallet' && ['wallet_balance', 'wallet_holdings'].includes(diagnostic.stage)
                || key === 'maintenance_payout' && diagnostic.stage === 'official_payout');
        const retryResponse = response && this.continuousReadPolicy()
            && diagnostic.category === 'validation'
            && (key === 'maintenance_mark' && markResponseCodes.has(diagnostic.code)
                && (!diagnostic.stage || ['book_read', 'metadata_read'].includes(diagnostic.stage))
                || key === 'maintenance_payout' && ['invalid_official_payout', 'invalid_api_data'].includes(diagnostic.code)
                && (!diagnostic.stage || diagnostic.stage === 'official_payout'));
        const temporary = temporaryReadFailure(error) || mark && diagnostic.code === 'stale_book'
            && diagnostic.category === 'stale_data'
            || key === 'maintenance_wallet' && diagnostic.code === 'rpc_wallet_read_unavailable'
                && diagnostic.category === 'opportunity' || retryResponse || retryRpcResponse;
        this.store.state.failures++;
        const endpointState = this.client.reads?.endpoints?.get(diagnostic.endpoint);
        holdEntry(this.store, key, error, { now, retryable: temporary, endpointState });
        if (!temporary) this.store.stop('operational_check_failed');
        this.store.event('retry', { error: diagnostic, maintenance: key, entryHeld: true });
    }
    async readStage(key, task, now, options = {}) {
        if (!this.readReady(key, now)) return { ok: false };
        const persistent = this.store.state.entryHolds?.[key]?.retryable === false;
        if (persistent) {
            this.diagnosticReadAt ||= {};
            // Reads may add current evidence without clearing the diagnosis.
            this.diagnosticReadAt[key] = now + 60000;
        }
        try {
            const value = await task();
            clearEntryHold(this.store, key, { now: Date.now(), proof: options.proof || 'fresh_read_succeeded' });
            return { ok: true, value };
        } catch (error) {
            this.readFailed(key, error, Date.now(), options);
            return { ok: false };
        }
    }
    async pollPayout(p, now) {
        if (p.payout) {
            if (!validPayout(p.payout)) this.readFailed('maintenance_payout',
                new OperationalError('invalid_official_payout', 'validation'), now);
            return;
        }
        const payoutDelay = Math.min(TRANSPORT.payoutMaxMs, TRANSPORT.payoutMs * 2 ** (p.payoutFailures || 0));
        if (now < p.market.end || p.lastPayoutCheck && now - p.lastPayoutCheck < payoutDelay
            || !this.readReady('maintenance_payout', now)) return;
        p.lastPayoutCheck = now;
        const result = await this.readStage('maintenance_payout', async () => {
            const value = await this.client.payout(p.market.conditionId);
            if (value != null && !validPayout(value))
                throw new OperationalError('invalid_official_payout', 'validation');
            return value;
        }, now, { response: true, proof: 'fresh_official_payout_read' });
        if (!result.ok) {
            p.payoutFailures = Math.min(2, (p.payoutFailures || 0) + 1);
            this.store.event('payout_retry', { error: this.store.state.entryHolds?.maintenance_payout?.error,
                nextDelayMs: Math.min(TRANSPORT.payoutMaxMs, TRANSPORT.payoutMs * 2 ** p.payoutFailures) });
            return;
        }
        p.payoutFailures = 0;
        if (result.value == null) return;
        p.payout = result.value;
        this.store.event('official_resolution', { payout: p.payout, conditionId: p.market.conditionId });
    }
    markRisk(p, books, now) {
        const state = this.store.state;
        if (!Number.isFinite(state.cash) || !Array.isArray(p.holdings) || p.holdings.length !== 2
            || p.holdings.some(shares => !Number.isFinite(shares) || shares < 0)) {
            evaluateLiveRisk(this.store, this.settings, now, NaN, { source: 'invalid_accounting' }); return;
        }
        let value, source, marking = books || p.markBooks;
        if (p.payout && validPayout(p.payout)) {
            value = state.cash + p.holdings.reduce((sum, shares, i) => sum + shares * p.payout[i], 0);
            source = 'official_payout';
        } else if (p.holdings.every(shares => Math.abs(shares) < EPS)) {
            value = state.cash; source = 'flat_holdings';
        } else if (freshMark(marking, now, this.settings.maxDataAgeMs)) {
            value = Math.max(equity(state, marking), state.cash + Math.min(...p.holdings));
            source = 'fresh_books';
        } else {
            // Do not turn an unavailable quote into zero inventory value, or
            // recompute risk from an old quote after cash/holdings have moved.
            if (!state.entryHolds?.maintenance_mark) holdEntry(this.store, 'maintenance_mark',
                new OperationalError('mark_unavailable', 'stale_data'), { now, retryable: true });
            return;
        }
        if (books || source !== 'fresh_books') clearEntryHold(this.store, 'maintenance_mark', { now, proof: source });
        const reason = evaluateLiveRisk(this.store, this.settings, now, value,
            { source, books: source === 'fresh_books' ? marking : null, payout: p.payout || null });
        if (reason) this.store.stop(reason);
    }
    async tick(now = Date.now()) {
        await this.boot();
        const state = this.store.state;
        try {
            await this.checkClock(now);
            let books = null;
            if (state.position) {
                const p = state.position;
                accrueCapital(p, now);
                const needBooks = this.broker.pending() || !p.lastBookAttempt || now - p.lastBookAttempt >= TRANSPORT.markMs;
                if (now < p.market.end && needBooks && this.readReady('maintenance_mark', now)) {
                    p.lastBookAttempt = now;
                    const mark = await this.readStage('maintenance_mark', async () => {
                        const result = await this.client.books(p.market);
                        const error = markReadError(result, Date.now(), this.settings.maxDataAgeMs);
                        if (error) throw error;
                        return result;
                    }, now,
                        { mark: true, response: true, proof: 'fresh_position_books' });
                    if (mark.ok) books = mark.value;
                }
                if (books) p.markBooks = books.map(book => ({ bids: book.bids.map(level => ({ ...level })),
                    timestamp: book.timestamp, fetchedAt: book.fetchedAt }));
                const reconciled = await this.readStage('maintenance_reconcile', () => this.broker.reconcile(books, now), now,
                    { proof: 'fresh_position_reconciliation' });
                // Wallet mismatch validation needs the same fresh accounting
                // pass. A failed receipt read must not manufacture a mismatch.
                const reconciliationReady = reconciled.ok && this.broker.reconciliationComplete !== false;
                const wallet = reconciliationReady ? await this.readStage('maintenance_wallet', () => this.broker.checkWallet(), now,
                    { proof: 'fresh_wallet_verification' }) : { ok: false };
                await this.pollPayout(p, now);
                if (reconciliationReady) this.markRisk(p, books, Date.now());
                if (state.stopped || state.liveRiskStop || state.frozenAt) await this.broker.cancelOwned();
                await this.manage(books, now, { reconciled: reconciliationReady, wallet: wallet.ok && wallet.value !== false });
                if (state.position === p) {
                    p.lastDeployed = Math.max(0, p.startingCash - state.cash);
                    p.oneSided ||= Math.abs(p.holdings[0] - p.holdings[1]) > EPS;
                }
            } else {
                const reason = evaluateLiveRisk(this.store, this.settings, now, state.cash, { source: 'flat_cash' });
                if (reason) this.store.stop(reason);
                const prioritized = this.prioritizeFlatEntry?.(Date.now()) === true;
                if (prioritized) await this.discover(now);
                if (!state.position && this.deferFlatWalletAudit?.(Date.now()) !== true) {
                    const wallet = await this.readStage('maintenance_wallet', () => this.broker.checkWallet(), now,
                        { proof: 'fresh_flat_wallet_verification' });
                    if (wallet.ok && wallet.value !== false) {
                        this.flatWalletAudited?.(Date.now());
                        clearEntryHold(this.store, 'maintenance_mark', { now, proof: 'flat_wallet_verified' });
                        clearEntryHold(this.store, 'maintenance_reconcile', { now, proof: 'flat_wallet_verified' });
                        clearEntryHold(this.store, 'maintenance_payout', { now, proof: 'flat_wallet_verified' });
                        if (!prioritized && !state.stopped && !state.frozenAt && !entryHeld(state)) await this.discover(now);
                    }
                }
            }
        } catch (error) {
            // This boundary may follow a side effect. Only the identified read
            // stages above may recover automatically; unknown work stays held.
            state.failures++;
            holdEntry(this.store, 'maintenance_unknown', error, { now: Date.now() });
            this.store.stop('operational_check_failed');
            this.store.event('retry', { error: safeError(error), maintenance: 'unknown' });
        }
        state.lastTickAt = now;
        if (now - this.lastHeartbeat >= 60000) {
            this.lastHeartbeat = now;
            this.store.event('heartbeat', { cash: state.cash, activeMarket: state.position?.market.slug ?? null,
                holdings: state.position?.holdings ?? [0, 0], completed: state.completed.filter(row => row.traded).length,
                stopped: state.stopped, liveRiskStop: state.liveRiskStop || null, entryHolds: state.entryHolds || {},
                btcFeed: this.client.btcStatus?.() || null });
        } else this.store.save();
    }
    async manage(books, now, proof = {}) {
        const state = this.store.state, p = state.position;
        if (!p || !proof.reconciled || !proof.wallet) return;
        // Actions retain the broker's exact receipt, ownership and retry guards.
        // Entry holds never imply permission to resubmit an order or a write.
        if (p.payout && validPayout(p.payout) && !this.broker.pending() && p.holdings.some(shares => shares > EPS))
            await this.broker.action('redeem', 0, now);
        if (!this.broker.pending() && p.holdings.every(shares => Math.abs(shares) < EPS)) this.finish(now);
    }
    finish(now) {
        const state = this.store.state, p = state.position, protection = p?.entrySignal?.lossProtection;
        if (protection) {
            const proof = this.broker.lastWalletProof;
            now = Math.max(now, Date.now());
            if (protection.schema !== 1
                || protection.activationId !== lossProtectionActivationId(state.profitTakingControl?.lossProtection)
                || !lossWalletProofMatches(state, proof, p, now, this.settings.maxDataAgeMs)
                || proof.evidence.blockNumber < protection.before?.blockNumber) return;
            // A redeem may have just changed holdings/accounting. Defer until a
            // fresh wallet pass proves the flat position before booking closure.
            protection.after = { ...proof.evidence };
        }
        if (this.continuousReadPolicy()) {
            // Preserve the common completion ledger while routing the live
            // drawdown decision through the continuous policy's telemetry.
            evaluateLiveRisk(this.store, this.settings, now, this.store.state.cash);
            super.finish.call({ ...this, settings: { ...this.settings, drawdownStop: Infinity } }, now);
        } else super.finish(now);
        const reason = evaluateLiveRisk(this.store, this.settings, now, this.store.state.cash, { source: 'flat_cash' });
        if (reason) this.store.stop(reason);
    }
}
