import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ethers } from 'ethers';
import { EPS, round } from '../restart/math.js';
import { fetchResponse, safeError, OperationalError } from '../restart/network.js';
import { expectedWalletBalance } from './recovery.js';
import { profitTakingLedger, profitTakingBudget, distributionAdjustedCash, reserveProfitWithdrawal,
    applyProfitWithdrawal, applyProfitWithdrawalSource, applyProfitWithdrawalDestination } from './profit-accounting.js';
import { BRIDGE, BRIDGE_MAX_OUTPUT_UNITS, createProfitBridge, assertBridgeQuoteFresh, verifyBridgeDestinationReceipt, readBridgeBalances } from './profit-bridge.js';
import { persistedProfitTransferIdentity, verifyProfitTransferReceipt } from './profit-transaction.js';
import { liveDeadline } from './limits.js';
import { resolveBridgeDestination } from './profit-resolution.js';
import { entryHeld, temporaryReadFailure } from './entry-holds.js';
import { evaluateLiveRisk } from './risk.js';
import { assertExternalTradesSettled } from './external-orders.js';
import { accountedCapitalHashes } from './deposits.js';
import { lossProtectionPolicy, validateLossProtectionState, lossWithdrawalCandidate,
    claimLossWithdrawal } from './loss-withdrawal.js';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ceil = value => Math.ceil(value * 1e6) / 1e6;
const fail = code => { throw new OperationalError(code, 'reconciliation'); };
const activeStages = new Set(['address_requested', 'address_ready', 'source_uncertain', 'in_transit']);

export function loadProfitTakingConfig(env = process.env) {
    const enabled = env.LAYA_PROFIT_TAKING_ENABLED || 'false';
    if (!['true', 'false'].includes(enabled)) fail('invalid_profit_taking_enabled');
    const trigger = env.LAYA_PROFIT_TRIGGER || 'realized_profit';
    if (!['realized_profit', 'wallet_balance'].includes(trigger)) fail('invalid_profit_taking_trigger');
    const lossEnabled = env.LAYA_PROFIT_LOSS_PROTECTION_ENABLED || 'false';
    if (!['true', 'false'].includes(lossEnabled) || lossEnabled === 'true' && trigger !== 'wallet_balance')
        fail('invalid_profit_taking_loss_protection');
    const recipient = env.LAYA_PROFIT_RECIPIENT || null;
    if (recipient !== null && (!ethers.utils.isAddress(recipient) || /^0x0{40}$/i.test(recipient)))
        fail('invalid_profit_taking_recipient');
    if (enabled === 'true' && !recipient) fail('profit_taking_recipient_required');
    return { enabled: enabled === 'true', recipient: recipient?.toLowerCase() ?? null,
        asset: 'USDC', chainId: 137, chunkUsd: 5, retainUsd: trigger === 'wallet_balance' ? 10 : 20,
        sourceToken: BRIDGE.sourceToken.toLowerCase(), destinationToken: BRIDGE.destinationToken.toLowerCase(),
        maxFeeUsd: .05, maxGasUsd: .15, maxSlippagePercent: 0, quoteAgeMs: 30000,
        ...(trigger === 'wallet_balance' ? { trigger, thresholdUsd: 15 } : {}),
        ...(lossEnabled === 'true' ? { lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } } : {}) };
}

function policy(config) {
    const { enabled: _enabled, ...p } = config;
    return p;
}

export function profitWithdrawalPending(state) {
    return !!state?.profitTaking?.pending || activeStages.has(state?.profitTakingControl?.operation?.stage);
}

export function profitTakingReport(state, config) {
    if (!state) return { enabled: !!config?.enabled, pending: false };
    const ledger = profitTakingLedger(state), control = state.profitTakingControl;
    const configured = control?.policy ?? config;
    const budget = configured?.recipient && state.liveFunding
        ? profitTakingBudget(state, configured, { openOrders: [], gasReserveUsd: configured.maxGasUsd,
            feeReserveUsd: configured.maxFeeUsd,
            ...(configured.trigger === 'wallet_balance' ? { expectedWalletBalance: expectedWalletBalance(state) } : {}) }) : null;
    return { enabled: !!config?.enabled, recipient: configured?.recipient ?? null, asset: 'USDC', chainId: 137,
        chunkUsd: configured?.chunkUsd ?? 5, retainUsd: configured?.retainUsd ?? 20,
        trigger: configured?.trigger ?? 'realized_profit', thresholdUsd: configured?.thresholdUsd ?? null,
        ...(configured?.lossProtection ? { lossProtection: configured.lossProtection } : {}),
        availableTradingCash: distributionAdjustedCash(state),
        totalUSDCReceived: ledger?.totalTransferred ?? 0, totalPUSDDebited: ledger?.totalTokenDebited ?? 0,
        gasUsd: ledger?.withdrawalGasUsd ?? 0, bridgeFeesUsd: ledger?.withdrawalFeesUsd ?? 0,
        bridgeConversionGainUsd: ledger?.withdrawalConversionGainUsd ?? 0,
        pending: profitWithdrawalPending(state), stage: control?.operation?.stage ?? null,
        sourceHash: ledger?.pending?.hash ?? null, disabled: control?.disabled ?? null,
        lastCheck: control?.lastCheck ?? null, lastReconciliation: control?.lastReconciliation ?? null, budget,
        tradingPnlAfterWithdrawalCosts: round((state.completed || []).reduce((s, r) => s + r.pnl, 0)
            - (ledger?.withdrawalGasUsd ?? 0) - (ledger?.withdrawalFeesUsd ?? 0)), aiComputeCost: null };
}

// One coordinator runs under the existing wallet-wide pilot flock. No write is
// retried. Persisting an intent always precedes its one external operation.
export class ProfitTakingCoordinator {
    constructor({ config, store, client, providers, bridge, clock = Date.now,
        sourceProof = verifyProfitTransferReceipt, destinationProof = verifyBridgeDestinationReceipt,
        resolveDestination = resolveBridgeDestination }) {
        Object.assign(this, { config, store, client, providers, clock, sourceProof, destinationProof, resolveDestination });
        const selected = config.profitTaking ?? loadProfitTakingConfig({});
        const state = store.state;
        if (!selected.enabled && !state.profitTakingControl && !state.profitTaking) return;
        if (state.profitTaking && !state.profitTakingControl) fail('profit_taking_control_missing');
        const p = policy(selected), old = state.profitTakingControl;
        lossProtectionPolicy(p);
        if (old && (old.schema !== 1 || !equal(old.policy, p))) fail('profit_taking_configuration_changed');
        if (!ethers.utils.isAddress(selected.recipient || '') || selected.recipient === config.settings.wallet?.toLowerCase()
            || [BRIDGE.sourceToken, BRIDGE.destinationToken].some(a => a.toLowerCase() === selected.recipient))
            fail('invalid_profit_taking_route');
        profitTakingLedger(state);
        state.profitTakingControl ||= { schema: 1, policy: p, operation: null, disabled: null };
        if (p.lossProtection && !old) state.profitTakingControl.lossProtection = { schema: 1,
            activatedAt: this.clock(), completedCount: state.completed.length,
            completedSha256: crypto.createHash('sha256').update(JSON.stringify(state.completed)).digest('hex'), consumed: [] };
        validateLossProtectionState(state, p);
        this.control = state.profitTakingControl;
        this.bridge = bridge ?? createProfitBridge({ request: fetchResponse, wallet: config.settings.wallet,
            recipient: p.recipient, clock, timeoutMs: 20000 });
        // A restart cannot establish whether the address-creation POST reached
        // the server. No funds have moved; disable this feature, retain audit.
        if (this.control.operation?.stage === 'address_requested') {
            this.control.operation.stage = 'address_unknown';
            this.control.disabled ||= 'bridge_withdrawal_creation_unknown';
        }
        this.nextCheck = 0; this.nextPoll = 0; this.pollFailures = 0;
        this.validateOperation();
        store.save();
    }
    validateOperation() {
        const op = this.control?.operation, pending = this.store.state.profitTaking?.pending;
        if (this.control) validateLossProtectionState(this.store.state, this.control.policy);
        if (!op) { if (pending) fail('profit_taking_operation_missing'); return; }
        if (!['address_requested', 'address_unknown', ...activeStages].includes(op.stage)
            || typeof op.id !== 'string' || !Number.isSafeInteger(op.createdAt) || op.createdAt < 0
            || op.createdAt > this.clock()) fail('invalid_profit_taking_operation');
        if (op.lossId !== undefined && !this.control.lossProtection?.consumed.some(claim =>
            claim.lossId === op.lossId && claim.intentId === op.id)) fail('invalid_profit_taking_operation');
        if (activeStages.has(op.stage) && op.stage !== 'address_requested' && (!ethers.utils.isAddress(op.address || '')
            || /^0x0{40}$/i.test(op.address)
            || [this.config.settings.wallet, this.control.policy.recipient, BRIDGE.sourceToken, BRIDGE.destinationToken]
                .some(a => a.toLowerCase() === op.address.toLowerCase()))) fail('invalid_profit_taking_operation');
        if (['source_uncertain', 'in_transit'].includes(op.stage)) {
            const transfer = op.transfer;
            const identity = persistedProfitTransferIdentity({ wallet: this.config.settings.wallet, transfer });
            if (!pending || pending.id !== op.id || pending.hash !== transfer?.hash
                || transfer.token?.toLowerCase() !== BRIDGE.sourceToken.toLowerCase()
                || transfer.recipient?.toLowerCase() !== op.address.toLowerCase() || transfer.amount !== 5
                || !identity || transfer.createdAt < op.createdAt || !Number.isSafeInteger(op.submittedAt)
                || op.submittedAt < transfer.createdAt || op.submittedAt > this.clock()
                || pending.bridge?.address !== op.address || !equal(pending.bridge?.quote, op.quote))
                fail('invalid_profit_taking_operation');
            if (op.lossId !== pending.lossId) fail('invalid_profit_taking_operation');
            if ((op.stage === 'in_transit') !== (pending.stage === 'in_transit')) fail('invalid_profit_taking_operation');
        } else if (pending) fail('invalid_profit_taking_operation');
    }
    replace(next) {
        if (!isDeepStrictEqual(this.store.state.ai, next.ai)) fail('profit_taking_ai_state_changed');
        // The engine, providers and callbacks retain these decision-state references.
        Object.assign(this.store.state, next, { ai: this.store.state.ai });
        this.store.save();
    }
    abandonUnusedRoute(error) {
        const op = this.control.operation;
        if (this.store.state.profitTaking?.pending || op?.stage !== 'address_ready') return;
        this.control.abandoned ||= [];
        this.control.abandoned.push({ ...op, reason: safeError(error).code, abandonedAt: this.clock() });
        this.control.operation = null;
        this.nextCheck = this.clock() + 300000;
        this.store.event('profit_withdrawal_route_abandoned', { id: op.id, reason: safeError(error).code });
    }
    async wallet(snapshotBlock) {
        const block = snapshotBlock ?? await this.client.confirmedBlock();
        const actual = await this.client.balance(block);
        if (this.externalActivity?.enabled()) {
            // The existing withdrawal reconciler owns its in-flight cash
            // movement. Do not try to classify it as manual activity.
            const ownedOperation = this.store.state.profitTaking?.pending || this.store.state.profitTakingControl?.operation;
            if ((!ownedOperation || Math.abs(actual - expectedWalletBalance(this.store.state)) > EPS)
                && !await this.externalActivity.reconcile({ block, actual }))
                throw new OperationalError('external_activity_verifying', 'opportunity', { stage: 'wallet_read' });
        } else if (this.capitalDeposits?.enabled() && actual > expectedWalletBalance(this.store.state) + EPS) {
            await this.capitalDeposits.reconcile({ block, actual });
            if (actual > expectedWalletBalance(this.store.state) + EPS) {
                this.capitalDeposits.defer();
                throw new OperationalError('capital_deposit_verifying', 'opportunity', { stage: 'capital_deposit' });
            }
        }
        const expected = expectedWalletBalance(this.store.state);
        if (!Number.isFinite(actual) || Math.abs(actual - expected) > EPS) {
            if (this.externalActivity?.enabled()) {
                this.externalActivity.defer();
                throw new OperationalError('external_activity_verifying', 'opportunity', { stage: 'wallet_read' });
            }
            this.store.stop('wallet_ledger_mismatch');
            this.store.event('profit_wallet_mismatch', { expectedPUSD: expected, actualPUSD: actual });
            fail('profit_wallet_mismatch');
        }
        return { block, actual };
    }
    async externalTrades(trades, block) {
        if (!this.externalActivity?.enabled()) return;
        const state = this.store.state;
        const previous = [state.externalWalletActivity?.walletProof, state.strategyEpochs?.at(-1)?.walletProof]
            .flatMap(proof => proof?.trades?.receiptConfirmed || [])
            .filter(row => Number.isSafeInteger(row.blockNumber) && row.blockNumber <= block
                && /^0x[a-fA-F0-9]{64}$/.test(row.transactionHash || ''))
            .map(row => row.transactionHash);
        await assertExternalTradesSettled(trades, { client: this.client, block,
            knownHashes: [...accountedCapitalHashes(state), ...previous] });
    }
    async verifyRecipient(block) {
        const p = this.control.policy;
        return this.client.rpc.read('profit_recipient', async provider => {
            const snapshot = await readBridgeBalances({ provider, wallet: this.config.settings.wallet,
                recipient: p.recipient, block, blockHash: this.client.rpc.anchor.hash });
            const token = new ethers.utils.Interface(['function decimals() view returns(uint8)']);
            const raw = await provider.call({ to: BRIDGE.destinationToken, data: token.encodeFunctionData('decimals') }, block);
            if (Number(token.decodeFunctionResult('decimals', raw)[0]) !== 6) fail('profit_destination_token_invalid');
            return snapshot;
        }, block);
    }
    checkpoint() {
        const s = this.store.state, now = this.clock();
        const reason = s.position ? null : evaluateLiveRisk(this.store, this.config.settings, now, s.cash, { source: 'flat_cash' });
        if (reason) this.store.stop(reason);
        s.lastTickAt = now;
        if (now - (this.lastHeartbeat || 0) >= 60000) {
            this.lastHeartbeat = now;
            this.store.event('profit_withdrawal_heartbeat', { stage: this.control?.operation?.stage,
                stopped: s.stopped, cash: s.cash });
        } else this.store.save();
    }
    async tick() {
        if (!this.control) return false;
        this.validateOperation();
        const s = this.store.state, now = this.clock(), op = this.control.operation;
        if (profitWithdrawalPending(s)) {
            this.checkpoint();
            if (s.position) { this.store.stop('profit_taking_inventory_conflict'); return false; }
            if (now < this.nextPoll) return true;
            this.nextPoll = now + 15000;
            try {
                if (op.stage === 'address_ready') {
                    // No source transaction exists. A restart may continue the
                    // existing fresh route, never create another address.
                    if (this.closed || s.stopped || entryHeld(s) || !this.config.profitTaking.enabled) {
                        this.control.abandoned ||= []; this.control.abandoned.push({ ...op, reason: 'entry_stopped_before_source' });
                        this.control.operation = null; this.store.save(); return false;
                    }
                    await this.prepareAndSend(op);
                } else await this.reconcile(op);
                this.pollFailures = 0;
            } catch (error) {
                this.abandonUnusedRoute(error);
                this.pollFailures++;
                const retryAfterMs = Number.isFinite(error?.retryAfter) && error.retryAfter >= 0
                    ? error.retryAfter * 1000 : 0;
                this.nextPoll = this.clock() + Math.max(retryAfterMs,
                    Math.min(60000, 15000 * 2 ** Math.min(2, this.pollFailures - 1)));
                const diagnostic = safeError(error, { stage: this.reconciliationStage || 'profit_reconciliation' });
                this.control.lastReconciliation = { at: this.clock(), outcome: 'retry', error: diagnostic };
                this.store.event('profit_withdrawal_retry', { error: diagnostic, stage: op.stage,
                    nextDelayMs: this.nextPoll - this.clock() });
            }
            return profitWithdrawalPending(s);
        }
        const lossCandidate = lossWithdrawalCandidate(s, this.control.policy,
            this.control.policy.lossProtection ? { expectedWalletBalance: expectedWalletBalance(s) } : {});
        if (this.closed || !this.config.profitTaking.enabled || this.control.disabled || s.stopped || entryHeld(s) || s.position
            || this.providers?.active?.size || now < this.nextCheck && !lossCandidate) return false;
        this.nextCheck = now + 30000;
        const p = this.control.policy;
        const preliminary = profitTakingBudget(s, p, { openOrders: [], gasReserveUsd: p.maxGasUsd, feeReserveUsd: p.maxFeeUsd,
            ...(p.trigger === 'wallet_balance' ? { expectedWalletBalance: expectedWalletBalance(s) } : {}) });
        this.control.lastCheck = { at: now, eligible: preliminary.eligible, reasons: preliminary.reasons };
        if (!preliminary.eligible) { this.waitingLossId = null; this.nextLossCheck = 0; this.store.save(); return false; }
        if (lossCandidate && this.waitingLossId === lossCandidate.lossId && now < this.nextLossCheck) return true;
        this.waitingLossId = lossCandidate?.lossId; this.nextLossCheck = now + 30000;
        // Ordinary withdrawals stay away from entry slots. A newly verified
        // loss gets priority before another trade can consume its cash.
        if (now % 300000 >= 150000 && !lossCandidate) return false;
        let lossRetryable = false;
        try {
            await this.bridge.supportedAssets();
            const quote = await this.bridge.quote({ maxFeeUsd: p.maxFeeUsd, maxSlippagePercent: p.maxSlippagePercent });
            const account = await this.client.ordersAndTrades(), wallet = await this.wallet();
            await this.verifyRecipient(wallet.block);
            await this.externalTrades(account.trades, wallet.block);
            const budget = profitTakingBudget(s, p, { openOrders: account.orders, walletBalance: wallet.actual,
                gasReserveUsd: p.maxGasUsd, feeReserveUsd: p.maxFeeUsd });
            if (!budget.eligible) {
                this.waitingLossId = null; this.nextLossCheck = 0;
                this.control.lastCheck = { at: now, eligible: false, reasons: budget.reasons };
                this.store.save(); return false;
            }
            this.assertInitiation(quote, budget.lossCandidate);
            const operation = { id: crypto.randomUUID(), stage: 'address_requested', createdAt: this.clock(), quote };
            if (budget.lossCandidate) claimLossWithdrawal(s, p, budget.lossCandidate, operation);
            this.control.operation = operation;
            this.store.event('profit_withdrawal_address_reserved', { id: operation.id, amountUsd: 5 });
            let route;
            try { route = await this.bridge.createWithdrawal({ intentId: operation.id }); }
            catch {
                operation.stage = 'address_unknown'; this.control.disabled = 'bridge_withdrawal_creation_unknown';
                this.store.event('profit_withdrawal_disabled', { reason: this.control.disabled }); return false;
            }
            operation.address = route.address; operation.stage = 'address_ready';
            this.store.event('profit_withdrawal_address_ready', { id: operation.id });
            await this.prepareAndSend(operation);
        } catch (error) {
            this.abandonUnusedRoute(error);
            lossRetryable = temporaryReadFailure(error) || safeError(error).code === 'bridge_quote_exceeds_budget';
            if (!lossRetryable) { this.waitingLossId = null; this.nextLossCheck = 0; }
            this.store.event('profit_withdrawal_deferred', { error: safeError(error) });
        }
        return profitWithdrawalPending(s) || lossRetryable && !!p.lossProtection && !!lossWithdrawalCandidate(s, p,
            { expectedWalletBalance: expectedWalletBalance(s) }) && !this.control.disabled;
    }
    assertInitiation(quote, lossCandidate) {
        const s = this.store.state;
        if (this.closed || s.stopped || entryHeld(s) || s.position || this.providers?.active?.size
            || this.clock() >= liveDeadline(s, this.config.settings)
            || s.completed.length >= this.config.settings.pilotMarkets) fail('profit_taking_stopped');
        if (this.clock() % 300000 >= 150000 && !lossCandidate
            && !lossWithdrawalCandidate(s, this.control.policy, { lossIntentId: this.control.operation?.id }))
            fail('profit_taking_entry_window');
        assertBridgeQuoteFresh(quote, { now: this.clock(), wallet: this.config.settings.wallet,
            recipient: this.control.policy.recipient });
    }
    async prepareAndSend(op) {
        const s = this.store.state, p = this.control.policy;
        this.assertInitiation(op.quote);
        op.quote = await this.bridge.quote({ maxFeeUsd: p.maxFeeUsd, maxSlippagePercent: p.maxSlippagePercent });
        await this.wallet();
        this.assertInitiation(op.quote);
        const transfer = await this.client.prepareProfitTransfer({ token: BRIDGE.sourceToken, recipient: op.address, amount: 5 });
        const identity = persistedProfitTransferIdentity({ wallet: this.config.settings.wallet, transfer });
        if (!identity || transfer.token?.toLowerCase() !== BRIDGE.sourceToken.toLowerCase()
            || transfer.recipient?.toLowerCase() !== op.address.toLowerCase() || transfer.amount !== 5
            || !Number.isFinite(transfer.maxGasUsd) || transfer.maxGasUsd <= 0 || transfer.maxGasUsd > p.maxGasUsd)
            fail('profit_withdrawal_gas_budget');
        const maxGasUsd = ceil(Number(ethers.utils.formatEther(identity.tx.gasLimit.mul(identity.tx.maxFeePerGas ?? identity.tx.gasPrice))) * transfer.polUsd);
        if (maxGasUsd > p.maxGasUsd || maxGasUsd !== transfer.maxGasUsd) fail('profit_withdrawal_gas_budget');
        this.assertInitiation(op.quote);
        const account = await this.client.ordersAndTrades(), wallet = await this.wallet();
        const beforeSourceSnapshot = await this.verifyRecipient(wallet.block);
        await this.externalTrades(account.trades, wallet.block);
        this.assertInitiation(op.quote);
        const request = { id: op.id, hash: transfer.hash, createdAt: transfer.createdAt,
            gasReserveUsd: ceil(transfer.maxGasUsd), feeReserveUsd: p.maxFeeUsd,
            openOrders: account.orders, walletBalance: wallet.actual,
            ...(op.lossId ? { lossIntentId: op.id } : {}),
            bridge: { address: op.address, quote: op.quote } };
        if (p.trigger === 'wallet_balance') {
            const budget = profitTakingBudget(s, p, request);
            if (op.lossId && budget.lossCandidate?.lossId !== op.lossId) fail('profit_taking_loss_witness_changed');
            if (!budget.eligible) fail(budget.reasons[0]);
        }
        const next = reserveProfitWithdrawal(s, p, request);
        next.profitTakingControl.operation = { ...op, transfer, beforeSourceSnapshot,
            stage: 'source_uncertain', submittedAt: this.clock() };
        this.replace(next); this.control = s.profitTakingControl;
        this.store.event('profit_withdrawal_submit_reserved', { id: op.id, hash: transfer.hash, amountUsd: 5 });
        try { await this.client.broadcastAction(transfer); }
        catch (error) { this.store.event('profit_withdrawal_submit_uncertain', { hash: transfer.hash, error: safeError(error) }); }
        // Only the persisted hash is queried on every later tick/restart.
    }
    async reconcile(op) {
        const s = this.store.state, p = this.control.policy;
        this.reconciliationStage = 'profit_source_snapshot';
        const block = await this.client.confirmedBlock();
        if (op.stage === 'source_uncertain') {
            const receipt = await this.client.verifiedReceipt(op.transfer.hash, block);
            if (!receipt) {
                if (this.clock() - op.submittedAt >= 180000) this.store.stop('profit_source_transaction_unknown');
                return;
            }
            const proof = this.sourceProof({ wallet: this.config.settings.wallet, block, transfer: op.transfer, receipt });
            if (!proof) { this.store.stop('profit_source_receipt_unproven'); fail('profit_source_receipt_unproven'); }
            const canonical = await this.client.rpc.read('profit_source_block', provider => provider.getBlock(receipt.blockNumber), block);
            if (!canonical || canonical.hash?.toLowerCase() !== receipt.blockHash?.toLowerCase()
                || canonical.timestamp * 1000 < op.createdAt - 2000) fail('profit_source_receipt_before_intent');
            const evidence = { id: op.id, hash: proof.hash, recipient: p.recipient, asset: 'USDC', amountUsd: 5,
                status: proof.status, tokenDebitUsd: -proof.safeTokenDelta, gasUsd: ceil(proof.gas), feeUsd: 0,
                blockNumber: proof.blockNumber, blockHash: proof.blockHash };
            const next = proof.status === 'confirmed' ? applyProfitWithdrawalSource(s, evidence) : applyProfitWithdrawal(s, evidence);
            if (proof.status === 'confirmed') {
                next.profitTakingControl.operation.stage = 'in_transit';
                next.profitTakingControl.operation.sourceTransactionIndex = receipt.transactionIndex;
            }
            else {
                next.profitTakingControl.operation = null;
                next.profitTakingControl.disabled = 'profit_source_transaction_failed';
            }
            this.replace(next); this.control = s.profitTakingControl;
            this.store.event('profit_withdrawal_source_receipt', { id: op.id, hash: proof.hash, status: proof.status, gasUsd: evidence.gasUsd });
            await this.wallet(block);
            return;
        }
        await this.wallet(block);
        this.reconciliationStage = 'bridge_status';
        let cursor, match = null;
        const intermediates = [];
        const cursors = new Set();
        for (let page = 0; page < 3; page++) {
            const result = await this.bridge.status({ address: op.address, sourceHash: op.transfer.hash,
                createdAt: op.createdAt, ...(cursor ? { cursor } : {}) });
            if (result.match) { if (match) fail('ambiguous_bridge_status'); match = result.match; }
            intermediates.push(...(result.intermediates || []));
            if (intermediates.length > 1) fail('ambiguous_bridge_status');
            if (!result.nextCursor) { cursor = null; break; }
            if (cursors.has(result.nextCursor)) fail('ambiguous_bridge_status');
            cursors.add(result.nextCursor); cursor = result.nextCursor;
        }
        if (cursor) fail('incomplete_bridge_status');
        if (!match) return;
        if (match.createdAt !== null && match.createdAt > this.clock()) fail('bridge_status_future');
        op.bridgeStatus = { status: match.status, at: this.clock(), transactionHash: match.transactionHash };
        this.store.save();
        if (match.status === 'FAILED') { this.store.stop('profit_bridge_failed_funds_unresolved'); return; }
        if (match.status !== 'COMPLETED') return;
        if (match.transactionHash === op.transfer.hash) fail('bridge_destination_identity_mismatch');
        if (s.profitTaking.withdrawals.some(row => row.destinationReceipt?.hash === match.transactionHash))
            fail('bridge_destination_transaction_reused');
        this.reconciliationStage = 'profit_source_receipt';
        const sourceReceipt = await this.client.verifiedReceipt(op.transfer.hash, block);
        const source = s.profitTaking.pending.sourceReceipt;
        const sourceProof = sourceReceipt && this.sourceProof({ wallet: this.config.settings.wallet,
            block, transfer: op.transfer, receipt: sourceReceipt });
        if (!sourceProof || sourceProof.status !== 'confirmed' || sourceProof.blockNumber !== source.blockNumber
            || sourceProof.blockHash !== source.blockHash) {
            this.store.stop('profit_source_receipt_changed'); fail('profit_source_receipt_changed');
        }
        this.reconciliationStage = 'bridge_destination_receipt';
        let transactionHash = match.transactionHash;
        let receipt = await this.client.verifiedReceipt(transactionHash, block);
        let resolution = null;
        const resolveReceipt = async ({ direct = false } = {}) => {
            this.reconciliationStage = 'bridge_correlation';
            resolution = await this.resolveDestination({ client: this.client, operation: op, primary: match,
                intermediates, block, recipient: p.recipient, sourceReceipt });
            if (!resolution || !/^0x[\da-f]{64}$/i.test(resolution.transactionHash || ''))
                fail('bridge_destination_receipt_missing');
            transactionHash = resolution.transactionHash.toLowerCase();
            const correlation = resolution.correlation;
            if (correlation?.schema !== 1 || correlation.sourceHash !== op.transfer.hash.toLowerCase()
                || correlation.withdrawalAddress !== op.address.toLowerCase()
                || correlation.recipient !== p.recipient.toLowerCase()
                || correlation.destinationHash !== transactionHash
                || !/^0x[\da-f]{64}$/i.test(correlation.orderId || '')
                || !/^[1-9]\d*$/.test(resolution.destinationAmountUnits || '')
                || BigInt(resolution.destinationAmountUnits) > BigInt(BRIDGE_MAX_OUTPUT_UNITS)
                || match.destinationAmountUnits != null && match.destinationAmountUnits !== resolution.destinationAmountUnits)
                fail('bridge_destination_correlation_mismatch');
            if (transactionHash === op.transfer.hash || (direct ? transactionHash !== match.transactionHash : transactionHash === match.transactionHash)
                || s.profitTaking.withdrawals.some(row => row.destinationReceipt?.hash === transactionHash))
                fail('bridge_destination_identity_mismatch');
            receipt = await this.client.verifiedReceipt(transactionHash, block);
            if (!receipt) fail('bridge_destination_receipt_missing');
        };
        if (!receipt) await resolveReceipt();
        this.reconciliationStage = 'profit_destination_proof';
        const proveDestination = async () => {
            const canonicalBlock = await this.client.rpc.read('profit_destination_block', provider => provider.getBlock(receipt.blockNumber), block);
            if (receipt.blockNumber < s.profitTaking.pending.sourceReceipt.blockNumber
                || receipt.blockNumber === s.profitTaking.pending.sourceReceipt.blockNumber
                    && (!Number.isSafeInteger(sourceReceipt.transactionIndex) || receipt.transactionIndex <= sourceReceipt.transactionIndex)
                || canonicalBlock.timestamp * 1000 < op.createdAt - 2000) fail('bridge_destination_before_source');
            const destinationAmountUnits = resolution?.destinationAmountUnits ?? match.destinationAmountUnits;
            return this.destinationProof({ receipt, block, canonicalBlock, expected: {
                wallet: this.config.settings.wallet, recipient: p.recipient, transactionHash,
                minOutputUnits: '1', maxOutputUnits: BRIDGE_MAX_OUTPUT_UNITS,
                ...(destinationAmountUnits ? { destinationAmountUnits } : {}),
                ...(match.from ? { from: match.from } : {}),
            } });
        };
        // Book actual received funds even if provider execution exceeded its
        // estimate. A fee breach stops future work; it must not hide a loss.
        let proof = await proveDestination();
        if (proof?.amount > 5 && !resolution) {
            // A transaction may batch unrelated credits to the same recipient.
            // Favorable conversion needs the provider-mapped exact output amount.
            await resolveReceipt({ direct: true });
            this.reconciliationStage = 'profit_destination_proof';
            proof = await proveDestination();
        }
        if (!proof) { this.store.stop('profit_destination_receipt_unproven'); fail('profit_destination_receipt_unproven'); }
        const next = applyProfitWithdrawalDestination(s, { id: op.id, sourceHash: op.transfer.hash,
            recipient: p.recipient, asset: 'USDC', receivedUsd: proof.amount, hash: proof.hash,
            blockNumber: proof.blockNumber, blockHash: proof.blockHash });
        this.reconciliationStage = 'profit_recipient_snapshot';
        const afterSnapshot = await this.verifyRecipient(block);
        if (!op.beforeSourceSnapshot) fail('profit_withdrawal_snapshot_missing');
        const observedDelta = BigInt(afterSnapshot.destinationBalanceUnits) - BigInt(op.beforeSourceSnapshot.destinationBalanceUnits);
        next.profitTakingControl.lastCompleted = { id: op.id, sourceHash: op.transfer.hash, destinationHash: proof.hash,
            receivedUSDC: proof.amount, feeUsd: round(Math.max(0, 5 - proof.amount)),
            ...(proof.amount > 5 ? { conversionGainUsd: round(proof.amount - 5) } : {}), at: this.clock(),
            beforeSourceSnapshot: op.beforeSourceSnapshot, afterSnapshot,
            externalRecipientDeltaUnits: (observedDelta - BigInt(proof.amountUnits)).toString() };
        if (resolution) next.profitTakingControl.lastCompleted.correlation = resolution.correlation;
        next.profitTakingControl.lastReconciliation = { at: this.clock(), outcome: 'completed' };
        next.profitTakingControl.operation = null;
        this.replace(next); this.control = s.profitTakingControl;
        if (BigInt(proof.feeUnits) > BigInt(Math.round(p.maxFeeUsd * 1e6))) this.store.stop('profit_bridge_fee_exceeded');
        this.store.event('profit_withdrawal_completed', this.control.lastCompleted);
    }
}
