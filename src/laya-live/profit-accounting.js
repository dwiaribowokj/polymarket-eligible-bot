import crypto from 'node:crypto';
import { totalCapitalDeposited } from './capital-funding.js';
import { totalCapitalAllocated } from './capital-allocations.js';
import { lossProtectionPolicy, validateLossProtectionState, lossWithdrawalCandidate,
    claimLossWithdrawal } from './loss-withdrawal.js';

// These functions never sign, broadcast or persist. The caller must save a
// reservation before broadcasting and supply independently verified receipts.
const SCALE = 1000000n;
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const fail = code => { throw new Error(code); };
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function units(value, { negative = false } = {}) {
    let result;
    if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
        const sign = value.startsWith('-') ? -1n : 1n;
        const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
        result = sign * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0')));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        const scaled = value * Number(SCALE), rounded = Math.round(scaled);
        if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .00001)
            fail('invalid_profit_accounting_amount');
        result = BigInt(rounded);
    } else fail('invalid_profit_accounting_amount');
    if (result > MAX || result < -MAX || !negative && result < 0n) fail('invalid_profit_accounting_amount');
    return result;
}

function amount(value) {
    if (value > MAX || value < -MAX) fail('invalid_profit_accounting_amount');
    return Number(value) / Number(SCALE);
}

function policyIdentity(policy) {
    const walletTriggered = policy?.trigger === 'wallet_balance';
    const lossProtection = lossProtectionPolicy(policy);
    if (!policy || !ADDRESS.test(policy.recipient || '') || /^0x0{40}$/i.test(policy.recipient)
        || !['pUSD', 'USDC'].includes(policy.asset)
        || ![undefined, 'realized_profit', 'wallet_balance'].includes(policy.trigger)
        || units(policy.chunkUsd) !== 5n * SCALE
        || (walletTriggered ? policy.asset !== 'USDC' || units(policy.retainUsd) !== 10n * SCALE
            || units(policy.thresholdUsd) !== 15n * SCALE : units(policy.retainUsd) < 20n * SCALE))
        fail('invalid_profit_taking_policy');
    return { recipient: policy.recipient.toLowerCase(), asset: policy.asset,
        chunkUsd: amount(units(policy.chunkUsd)), retainUsd: amount(units(policy.retainUsd)),
        ...(walletTriggered ? { trigger: 'wallet_balance', thresholdUsd: amount(units(policy.thresholdUsd)) } : {}),
        ...(lossProtection ? { lossProtection } : {}) };
}

function periodIdentity(state) {
    if (typeof state.baseline !== 'string' || !state.baseline
        || !Number.isSafeInteger(state.startedAt) || state.startedAt < 0)
        fail('invalid_profit_accounting_period');
    return { baseline: state.baseline, startedAt: state.startedAt,
        initialCapital: amount(units(state.liveFunding?.initialCapital)) };
}

function history(state) {
    if (!Array.isArray(state.completed)) fail('invalid_profit_accounting_history');
    let pnl = 0n;
    for (const row of state.completed) {
        if (!row || typeof row !== 'object') fail('invalid_profit_accounting_history');
        const value = units(row.pnl, { negative: true });
        // A no-fill attempt may lose gas, but cannot establish trading profit.
        pnl += row.traded === true || value < 0n ? value : 0n;
        amount(pnl);
    }
    return { pnl, count: state.completed.length, sha256: digest(state.completed) };
}

function receiptIdentity(receipt, policy) {
    if (!receipt || typeof receipt.id !== 'string' || !/^[\w:-]{1,128}$/.test(receipt.id)
        || !HASH.test(receipt.hash || '') || !HASH.test(receipt.blockHash || '')
        || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0
        || !['confirmed', 'failed'].includes(receipt.status)
        || typeof receipt.recipient !== 'string' || receipt.recipient.toLowerCase() !== policy.recipient
        || receipt.asset !== policy.asset || units(receipt.amountUsd) !== units(policy.chunkUsd))
        fail('invalid_profit_withdrawal_receipt');
    const tokenDebit = units(receipt.tokenDebitUsd), gas = units(receipt.gasUsd);
    const fee = units(receipt.feeUsd ?? 0), intended = units(receipt.amountUsd);
    if (receipt.status === 'confirmed' ? tokenDebit !== intended + fee : tokenDebit !== 0n || fee !== 0n)
        fail('invalid_profit_withdrawal_receipt');
    return { id: receipt.id, hash: receipt.hash.toLowerCase(), recipient: policy.recipient, asset: policy.asset,
        amountUsd: amount(intended), status: receipt.status, tokenDebitUsd: amount(tokenDebit),
        transferredUsd: receipt.status === 'confirmed' ? amount(intended) : 0,
        feeUsd: amount(fee), gasUsd: amount(gas), blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash.toLowerCase() };
}

function sourceIdentity(evidence, policy) {
    const receipt = receiptIdentity(evidence, policy);
    if (policy.asset !== 'USDC' || receipt.status !== 'confirmed' || units(receipt.feeUsd) !== 0n
        || units(receipt.tokenDebitUsd) !== units(policy.chunkUsd)) fail('invalid_profit_withdrawal_source');
    return receipt;
}

function destinationIdentity(evidence, source, policy) {
    if (!evidence || evidence.id !== source.id || !HASH.test(evidence.sourceHash || '')
        || evidence.sourceHash.toLowerCase() !== source.hash || !HASH.test(evidence.hash || '')
        || evidence.hash.toLowerCase() === source.hash || !HASH.test(evidence.blockHash || '')
        || !Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber < 0
        || (evidence.status !== undefined && evidence.status !== 'confirmed')
        || typeof evidence.recipient !== 'string' || evidence.recipient.toLowerCase() !== policy.recipient
        || evidence.asset !== 'USDC' || policy.asset !== 'USDC') fail('invalid_profit_withdrawal_destination');
    const received = units(evidence.receivedUsd);
    if (received <= 0n) fail('invalid_profit_withdrawal_destination');
    return { id: source.id, sourceHash: source.hash, hash: evidence.hash.toLowerCase(),
        recipient: policy.recipient, asset: 'USDC', status: 'confirmed', receivedUsd: amount(received),
        blockNumber: evidence.blockNumber, blockHash: evidence.blockHash.toLowerCase() };
}

function bridgeWithdrawal(source, destination) {
    const difference = units(source.tokenDebitUsd) - units(destination.receivedUsd);
    return { kind: 'bridge', id: source.id, hash: source.hash, recipient: source.recipient, asset: source.asset,
        amountUsd: source.amountUsd, status: 'confirmed', tokenDebitUsd: source.tokenDebitUsd,
        transferredUsd: destination.receivedUsd,
        feeUsd: amount(difference > 0n ? difference : 0n), gasUsd: source.gasUsd,
        ...(difference < 0n ? { conversionGainUsd: amount(-difference) } : {}),
        blockNumber: source.blockNumber, blockHash: source.blockHash,
        sourceReceipt: source, destinationReceipt: destination };
}

function withdrawalIdentity(entry, policy) {
    if (!entry || typeof entry !== 'object') fail('invalid_profit_taking_ledger');
    if (entry.kind !== 'bridge') {
        if (entry.conversionGainUsd !== undefined) fail('invalid_profit_taking_ledger');
        return receiptIdentity(entry, policy);
    }
    const source = sourceIdentity(entry.sourceReceipt, policy);
    const destination = destinationIdentity(entry.destinationReceipt, source, policy);
    const canonical = bridgeWithdrawal(source, destination);
    for (const key of ['id', 'hash', 'recipient', 'asset', 'amountUsd', 'status', 'tokenDebitUsd',
        'transferredUsd', 'feeUsd', 'gasUsd', 'conversionGainUsd', 'blockNumber', 'blockHash'])
        if (entry[key] !== canonical[key]) fail('invalid_profit_taking_ledger');
    return canonical;
}

// Validation is also used by reconciliation and entry guards. Inconsistent
// totals or a truncated/edited history never silently become an empty ledger.
export function profitTakingLedger(state) {
    const ledger = state.profitTaking;
    if (ledger === undefined || ledger === null) return null;
    if (ledger.schema !== 1 || !Array.isArray(ledger.withdrawals) || !ledger.history
        || !Number.isSafeInteger(ledger.history.count) || ledger.history.count < 0
        || !Array.isArray(state.completed) || ledger.history.count > state.completed.length
        || ledger.history.sha256 !== digest(state.completed.slice(0, ledger.history.count)))
        fail('invalid_profit_taking_ledger');
    const policy = policyIdentity(ledger.policy);
    validateLossProtectionState(state, policy);
    if (JSON.stringify(ledger.period) !== JSON.stringify(periodIdentity(state))) fail('profit_taking_period_mismatch');
    const hashes = new Set(), destinationHashes = new Set(), ids = new Set();
    let transferred = 0n, tokenDebited = 0n, gas = 0n, fees = 0n, conversionGains = 0n;
    for (const entry of ledger.withdrawals) {
        const receipt = withdrawalIdentity(entry, policy);
        if (entry.lossId !== undefined && !state.profitTakingControl?.lossProtection?.consumed?.some(claim =>
            claim.lossId === entry.lossId && claim.intentId === entry.id)) fail('invalid_profit_taking_ledger');
        if (hashes.has(receipt.hash) || destinationHashes.has(receipt.hash) || ids.has(receipt.id)
            || entry.transferredUsd !== receipt.transferredUsd) fail('invalid_profit_taking_ledger');
        if (receipt.kind === 'bridge') {
            const destinationHash = receipt.destinationReceipt.hash;
            if (hashes.has(destinationHash) || destinationHashes.has(destinationHash)) fail('invalid_profit_taking_ledger');
            destinationHashes.add(destinationHash);
        }
        hashes.add(receipt.hash); ids.add(receipt.id);
        transferred += units(receipt.transferredUsd); tokenDebited += units(receipt.tokenDebitUsd);
        gas += units(receipt.gasUsd); fees += units(receipt.feeUsd);
        conversionGains += units(receipt.conversionGainUsd ?? 0);
    }
    const pending = ledger.pending;
    if (pending !== null) {
        if (!pending || typeof pending.id !== 'string' || !/^[\w:-]{1,128}$/.test(pending.id)
            || !HASH.test(pending.hash || '') || hashes.has(pending.hash.toLowerCase())
            || destinationHashes.has(pending.hash.toLowerCase()) || ids.has(pending.id)
            || !Number.isSafeInteger(pending.createdAt) || pending.createdAt < 0
            || units(pending.amountUsd) !== units(policy.chunkUsd)) fail('invalid_profit_taking_pending');
        units(pending.gasReserveUsd); units(pending.feeReserveUsd);
        if (pending.lossId !== undefined && !state.profitTakingControl?.lossProtection?.consumed?.some(claim =>
            claim.lossId === pending.lossId && claim.intentId === pending.id)) fail('invalid_profit_taking_pending');
        if (pending.stage === 'in_transit') {
            const source = sourceIdentity(pending.sourceReceipt, policy);
            if (source.id !== pending.id || source.hash !== pending.hash.toLowerCase()
                || units(pending.provisionalPrincipalUsd) !== units(source.tokenDebitUsd))
                fail('invalid_profit_taking_pending');
            tokenDebited += units(source.tokenDebitUsd); gas += units(source.gasUsd);
        } else if ((pending.stage !== undefined && pending.stage !== 'reserved')
            || pending.sourceReceipt !== undefined || pending.provisionalPrincipalUsd !== undefined)
            fail('invalid_profit_taking_pending');
    }
    if (units(ledger.totalTransferred) !== transferred || units(ledger.totalTokenDebited) !== tokenDebited
        || units(ledger.withdrawalGasUsd) !== gas || units(ledger.withdrawalFeesUsd) !== fees
        || units(ledger.withdrawalConversionGainUsd ?? 0) !== conversionGains)
        fail('invalid_profit_taking_ledger');
    return structuredClone(ledger);
}

// Cash remains the total-return trading account. Subtract only distributions
// here; actual transfer fees/gas have already reduced cash on receipt booking.
export function distributionAdjustedCash(state, { reservePending = true } = {}) {
    totalCapitalAllocated(state);
    const ledger = profitTakingLedger(state);
    let value = units(state.cash, { negative: true }) - units(ledger?.totalTransferred ?? 0);
    if (ledger?.pending?.stage === 'in_transit') value -= units(ledger.pending.provisionalPrincipalUsd);
    else if (reservePending && ledger?.pending) value -= units(ledger.pending.amountUsd)
        + units(ledger.pending.gasReserveUsd) + units(ledger.pending.feeReserveUsd);
    return amount(value);
}

export function profitTakingBudget(state, policy, context = {}) {
    const normalized = policyIdentity(policy), ledger = profitTakingLedger(state), initial = periodIdentity(state);
    if (ledger && JSON.stringify(normalized) !== JSON.stringify(policyIdentity(ledger.policy)))
        fail('profit_taking_policy_mismatch');
    const completed = history(state), gasReserve = units(context.gasReserveUsd ?? 0);
    const feeReserve = units(context.feeReserveUsd ?? 0), reserved = gasReserve + feeReserve;
    const transferred = units(ledger?.totalTransferred ?? 0), gas = units(ledger?.withdrawalGasUsd ?? 0);
    const fees = units(ledger?.withdrawalFeesUsd ?? 0), cash = units(state.cash, { negative: true });
    const conversionGains = units(ledger?.withdrawalConversionGainUsd ?? 0);
    const cashProfit = cash - units(initial.initialCapital) - units(totalCapitalDeposited(state))
        - units(totalCapitalAllocated(state)) - conversionGains, closedProfit = completed.pnl - gas - fees;
    const realized = cashProfit < closedProfit ? cashProfit : closedProfit;
    const provisional = units(ledger?.pending?.stage === 'in_transit' ? ledger.pending.provisionalPrincipalUsd : 0);
    const available = realized - transferred + conversionGains - provisional - reserved;
    const spendable = units(distributionAdjustedCash(state), { negative: true });
    const headroom = spendable - units(normalized.retainUsd) - reserved;
    const chunk = units(normalized.chunkUsd), reasons = [];
    const walletTriggered = normalized.trigger === 'wallet_balance';
    const walletBalance = walletTriggered ? context.walletBalance !== undefined
        ? context.walletBalance : context.expectedWalletBalance : undefined;
    const walletCash = walletBalance === undefined ? null : units(walletBalance);
    const lossCandidate = normalized.lossProtection ? lossWithdrawalCandidate(state, normalized, context) : null;
    const normalWalletReady = walletCash !== null && walletCash >= units(normalized.thresholdUsd ?? 0)
        && walletCash - chunk >= units(normalized.retainUsd);
    const lossTriggered = walletTriggered && !normalWalletReady && !!lossCandidate && walletCash !== null
        && walletCash > units(normalized.lossProtection.afterLossMinUsd);
    if (state.stopped) reasons.push('profit_taking_stopped');
    if (state.position) reasons.push('profit_taking_inventory');
    if (state.completed.some(row => row.uncertain)) reasons.push('profit_taking_uncertain_history');
    if (ledger?.pending) reasons.push('profit_taking_pending');
    if (!Array.isArray(context.openOrders)) reasons.push('profit_taking_open_orders_unverified');
    else if (context.openOrders.length) reasons.push('profit_taking_open_orders');
    if (walletTriggered) {
        // Bridge fees are withheld from the gross transfer; source gas is POL.
        // Neither consumes additional pUSD from the retained wallet balance.
        if (walletCash === null) reasons.push('profit_taking_wallet_unverified');
        else if (!normalWalletReady && !lossTriggered) reasons.push('profit_taking_wallet_cash');
        if (spendable < chunk + gasReserve) reasons.push('profit_taking_bot_cash_unallocated');
    } else {
        if (available < chunk) reasons.push('profit_taking_insufficient_profit');
        if (headroom < chunk) reasons.push('profit_taking_working_capital');
        if (context.walletBalance !== undefined
            && units(context.walletBalance) < chunk + feeReserve + units(normalized.retainUsd))
            reasons.push('profit_taking_wallet_cash');
    }
    return { eligible: reasons.length === 0, reasons, amountUsd: reasons.length ? 0 : normalized.chunkUsd,
        realizedProfitUsd: amount(realized), availableProfitUsd: amount(available),
        spendableCash: amount(spendable),
        workingCapitalAfter: walletTriggered ? walletCash === null ? null : amount(walletCash - chunk)
            : amount(spendable - chunk - reserved),
        ...(walletTriggered ? { trigger: 'wallet_balance', thresholdUsd: normalized.thresholdUsd,
            walletCash: walletCash === null ? null : amount(walletCash),
            botCashAfter: amount(spendable - chunk - gasReserve),
            walletBalanceVerified: context.walletBalance !== undefined,
            cashBasis: context.walletBalance !== undefined ? 'verified_wallet' : 'expected_wallet' } : {}),
        ...(normalized.lossProtection ? { withdrawalTrigger: lossTriggered ? 'loss_protection' : 'wallet_balance',
            lossCandidate } : {}),
        gasReserveUsd: amount(gasReserve), feeReserveUsd: amount(feeReserve),
        totalTransferred: amount(transferred), provisionalTransferredUsd: amount(provisional),
        totalTokenDebited: ledger?.totalTokenDebited ?? 0,
        withdrawalGasUsd: amount(gas), withdrawalFeesUsd: amount(fees),
        ...(conversionGains > 0n ? { withdrawalConversionGainUsd: amount(conversionGains) } : {}) };
}

export function reserveProfitWithdrawal(state, policy, request) {
    if (!request || request.gasReserveUsd === undefined || request.feeReserveUsd === undefined)
        fail('profit_taking_cost_reserve_required');
    const budget = profitTakingBudget(state, policy, request);
    if (request.lossIntentId !== undefined && (request.lossIntentId !== request.id || !budget.lossCandidate
        || state.profitTakingControl?.operation?.id !== request.id
        || state.profitTakingControl.operation.lossId !== budget.lossCandidate.lossId))
        fail('profit_taking_loss_witness_changed');
    if (policy.trigger === 'wallet_balance' && !budget.walletBalanceVerified)
        fail('profit_taking_wallet_unverified');
    if (!budget.eligible) fail(budget.reasons[0]);
    if (typeof request.id !== 'string' || !/^[\w:-]{1,128}$/.test(request.id)
        || !HASH.test(request.hash || '') || !Number.isSafeInteger(request.createdAt) || request.createdAt < 0)
        fail('invalid_profit_taking_pending');
    const next = structuredClone(state), normalized = policyIdentity(policy), completed = history(state);
    if (budget.lossCandidate && !next.profitTakingControl.lossProtection.consumed.some(row => row.lossId === budget.lossCandidate.lossId))
        claimLossWithdrawal(next, policy, budget.lossCandidate, { id: request.id, createdAt: request.createdAt });
    next.profitTaking ||= { schema: 1, policy: normalized, period: periodIdentity(state), pending: null,
        withdrawals: [], totalTransferred: 0, totalTokenDebited: 0, withdrawalGasUsd: 0, withdrawalFeesUsd: 0 };
    next.profitTaking.history = { count: completed.count, sha256: completed.sha256 };
    next.profitTaking.pending = { id: request.id, hash: request.hash.toLowerCase(), createdAt: request.createdAt,
        amountUsd: budget.amountUsd, gasReserveUsd: budget.gasReserveUsd, feeReserveUsd: budget.feeReserveUsd };
    if (budget.lossCandidate) next.profitTaking.pending.lossId = budget.lossCandidate.lossId;
    if (request.bridge !== undefined) next.profitTaking.pending.bridge = structuredClone(request.bridge);
    profitTakingLedger(next);
    return next;
}

export function applyProfitWithdrawal(state, evidence) {
    const ledger = profitTakingLedger(state);
    if (!ledger) fail('profit_taking_reservation_required');
    const receipt = receiptIdentity(evidence, policyIdentity(ledger.policy));
    const existing = ledger.withdrawals.find(row => row.hash.toLowerCase() === receipt.hash || row.id === receipt.id);
    if (existing) {
        if (existing.kind === 'bridge') fail('profit_withdrawal_receipt_mismatch');
        if (JSON.stringify(receiptIdentity(existing, policyIdentity(ledger.policy))) !== JSON.stringify(receipt))
            fail('profit_withdrawal_receipt_mismatch');
        return structuredClone(state);
    }
    if (!ledger.pending || ledger.pending.id !== receipt.id || ledger.pending.hash.toLowerCase() !== receipt.hash
        || units(ledger.pending.amountUsd) !== units(receipt.amountUsd)) fail('profit_withdrawal_receipt_mismatch');
    if (ledger.pending.stage === 'in_transit') fail('profit_withdrawal_source_already_accounted');
    if (state.position) fail('profit_taking_inventory');
    const next = structuredClone(state), nextLedger = next.profitTaking, completed = history(state);
    next.cash = amount(units(state.cash, { negative: true }) - units(receipt.gasUsd) - units(receipt.feeUsd));
    nextLedger.withdrawals.push({ ...receipt, ...(ledger.pending.lossId ? { lossId: ledger.pending.lossId } : {}) });
    nextLedger.pending = null;
    nextLedger.totalTransferred = amount(units(ledger.totalTransferred) + units(receipt.transferredUsd));
    nextLedger.totalTokenDebited = amount(units(ledger.totalTokenDebited) + units(receipt.tokenDebitUsd));
    nextLedger.withdrawalGasUsd = amount(units(ledger.withdrawalGasUsd) + units(receipt.gasUsd));
    nextLedger.withdrawalFeesUsd = amount(units(ledger.withdrawalFeesUsd) + units(receipt.feeUsd));
    nextLedger.history = { count: completed.count, sha256: completed.sha256 };
    profitTakingLedger(next);
    return next;
}

// Official Bridge stage 1. Evidence has the same identity fields as a legacy
// receipt: {id,hash,recipient,asset:'USDC',amountUsd:5,status:'confirmed',
// tokenDebitUsd:5,feeUsd:0,gasUsd,blockNumber,blockHash}. It proves a gross pUSD
// debit, not USDC delivery. The exact source hash remains pending on restart;
// bridge delays/failures never authorize another source transfer.
export function applyProfitWithdrawalSource(state, evidence) {
    const ledger = profitTakingLedger(state);
    if (!ledger) fail('profit_taking_reservation_required');
    const policy = policyIdentity(ledger.policy), source = sourceIdentity(evidence, policy);
    const existing = ledger.withdrawals.find(row => row.hash.toLowerCase() === source.hash || row.id === source.id);
    if (existing) {
        if (existing.kind !== 'bridge'
            || JSON.stringify(sourceIdentity(existing.sourceReceipt, policy)) !== JSON.stringify(source))
            fail('profit_withdrawal_receipt_mismatch');
        return structuredClone(state);
    }
    const pending = ledger.pending;
    if (!pending || pending.id !== source.id || pending.hash.toLowerCase() !== source.hash
        || units(pending.amountUsd) !== units(source.amountUsd)) fail('profit_withdrawal_receipt_mismatch');
    if (pending.stage === 'in_transit') {
        if (JSON.stringify(sourceIdentity(pending.sourceReceipt, policy)) !== JSON.stringify(source))
            fail('profit_withdrawal_receipt_mismatch');
        return structuredClone(state);
    }
    if (state.position) fail('profit_taking_inventory');
    const next = structuredClone(state), nextLedger = next.profitTaking, completed = history(state);
    next.cash = amount(units(state.cash, { negative: true }) - units(source.gasUsd));
    nextLedger.totalTokenDebited = amount(units(ledger.totalTokenDebited) + units(source.tokenDebitUsd));
    nextLedger.withdrawalGasUsd = amount(units(ledger.withdrawalGasUsd) + units(source.gasUsd));
    Object.assign(nextLedger.pending, { stage: 'in_transit', sourceReceipt: source,
        provisionalPrincipalUsd: source.tokenDebitUsd });
    nextLedger.history = { count: completed.count, sha256: completed.sha256 };
    profitTakingLedger(next);
    return next;
}

// Official Bridge stage 2. Only verified destination USDC logs may supply
// {id,sourceHash,hash,recipient,asset:'USDC',receivedUsd,blockNumber,blockHash}.
// Conversion shortfalls are fees; favorable conversion is a separate gain.
// Both preserve the gross source debit in spendable cash. Unknown delivery stays pending.
export function applyProfitWithdrawalDestination(state, evidence) {
    const ledger = profitTakingLedger(state);
    if (!ledger) fail('profit_taking_reservation_required');
    const policy = policyIdentity(ledger.policy);
    const sourceHash = HASH.test(evidence?.sourceHash || '') ? evidence.sourceHash.toLowerCase() : null;
    const existing = ledger.withdrawals.find(row => row.id === evidence?.id || row.hash.toLowerCase() === sourceHash);
    if (existing) {
        if (existing.kind !== 'bridge') fail('profit_withdrawal_receipt_mismatch');
        const source = sourceIdentity(existing.sourceReceipt, policy), destination = destinationIdentity(evidence, source, policy);
        if (JSON.stringify(destinationIdentity(existing.destinationReceipt, source, policy)) !== JSON.stringify(destination))
            fail('profit_withdrawal_receipt_mismatch');
        return structuredClone(state);
    }
    const pending = ledger.pending;
    if (!pending || pending.stage !== 'in_transit') fail('profit_withdrawal_source_required');
    const source = sourceIdentity(pending.sourceReceipt, policy), destination = destinationIdentity(evidence, source, policy);
    if (ledger.withdrawals.some(row => row.destinationReceipt?.hash?.toLowerCase() === destination.hash))
        fail('profit_withdrawal_receipt_mismatch');
    if (state.position) fail('profit_taking_inventory');
    const next = structuredClone(state), nextLedger = next.profitTaking, completed = history(state);
    const withdrawal = bridgeWithdrawal(source, destination);
    if (pending.lossId) withdrawal.lossId = pending.lossId;
    const conversionGain = units(withdrawal.conversionGainUsd ?? 0);
    next.cash = amount(units(state.cash, { negative: true }) - units(withdrawal.feeUsd) + conversionGain);
    nextLedger.totalTransferred = amount(units(ledger.totalTransferred) + units(withdrawal.transferredUsd));
    nextLedger.withdrawalFeesUsd = amount(units(ledger.withdrawalFeesUsd) + units(withdrawal.feeUsd));
    if (conversionGain > 0n)
        nextLedger.withdrawalConversionGainUsd = amount(units(ledger.withdrawalConversionGainUsd ?? 0) + conversionGain);
    nextLedger.withdrawals.push(withdrawal); nextLedger.pending = null;
    nextLedger.history = { count: completed.count, sha256: completed.sha256 };
    profitTakingLedger(next);
    return next;
}
