import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expectedWalletBalance } from './recovery.js';
import { capitalFundingLedger } from './capital-funding.js';

const SCALE = 1000000n, MAX = BigInt(Number.MAX_SAFE_INTEGER);
const HASH = /^0x[\da-f]{64}$/i, DIGEST = /^[a-f0-9]{64}$/, ADDRESS = /^0x[\da-f]{40}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(`capital_allocation_${code}`); };
const prepared = new WeakMap();
const proofLifetimeMs = 30000;

function units(value, negative = false) {
    let result;
    if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
        const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
        result = (value.startsWith('-') ? -1n : 1n) * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0')));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        const scaled = value * 1e6, rounded = Math.round(scaled);
        if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .00001) fail('amount_invalid');
        result = BigInt(rounded);
    } else fail('amount_invalid');
    if (result > MAX || result < -MAX || !negative && result < 0n) fail('amount_invalid');
    return result;
}

function amount(value) {
    if (value > MAX || value < -MAX) fail('amount_invalid');
    const result = Number(value) / 1e6;
    if (units(result, true) !== value) fail('amount_invalid');
    return result;
}

function checkpoint(value) {
    if (!record(value) || !integer(value.blockNumber) || !HASH.test(value.blockHash || '')
        || /^0x0{64}$/i.test(value.blockHash)) fail('checkpoint_invalid');
    return { blockNumber: value.blockNumber, blockHash: value.blockHash.toLowerCase() };
}

function account(value) {
    if (!record(value) || value.chainId !== 137
        || ['tokenAddress', 'walletAddress'].some(key => !ADDRESS.test(value[key] || '') || /^0x0{40}$/i.test(value[key])))
        fail('identity_invalid');
    return { chainId: 137, tokenAddress: value.tokenAddress.toLowerCase(), walletAddress: value.walletAddress.toLowerCase() };
}

function period(state) {
    if (typeof state.baseline !== 'string' || !state.baseline || !integer(state.startedAt)) fail('period_invalid');
    return { baseline: state.baseline, startedAt: state.startedAt, initialCapital: amount(units(state.liveFunding?.initialCapital)) };
}

function source(state) {
    const external = state.externalWalletActivity;
    if (!record(external) || !Array.isArray(external.receipts)
        || external.automatic?.schema !== 1) fail('external_history_invalid');
    const boundary = checkpoint(external.automatic.checkpoint), hashes = new Set(), totals = [0n];
    for (const row of external.receipts) {
        const block = checkpoint(row);
        if (!HASH.test(row.hash || '') || hashes.has(row.hash.toLowerCase()) || block.blockNumber > boundary.blockNumber
            || block.blockNumber === boundary.blockNumber && block.blockHash !== boundary.blockHash)
            fail('external_history_invalid');
        hashes.add(row.hash.toLowerCase());
        totals.push(totals.at(-1) + units(row.cash, true));
        amount(totals.at(-1));
    }
    if (units(external.cashDelta, true) !== totals.at(-1)) fail('external_history_invalid');
    return { receipts: external.receipts, checkpoint: boundary, totals };
}

function requestIdentity(value) {
    if (!record(value) || typeof value.id !== 'string' || !/^[\w:-]{1,128}$/.test(value.id)
        || units(value.amount) <= 0n || value.approval?.source !== 'explicit_user_instruction'
        || typeof value.approval.text !== 'string' || !value.approval.text.trim() || value.approval.text.length > 4096
        || !Array.isArray(value.openOrders) || value.openOrders.length || value.tradesSettled !== true)
        fail('request_invalid');
    const proof = value.walletProof, external = value.externalActivityProof;
    const identity = account(proof), block = checkpoint(proof), origin = checkpoint(external?.checkpoint);
    if (!integer(proof.verificationStartedAt) || !integer(proof.verifiedAt)
        || proof.verifiedAt < proof.verificationStartedAt || proof.verifiedAt - proof.verificationStartedAt > proofLifetimeMs
        || ['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce'].some(key =>
            typeof proof[key] !== 'string' || !/^(?:0|[1-9]\d*)$/.test(proof[key]))
        || proof.confirmedNonce !== proof.pendingNonce || proof.safeNonce !== proof.pendingSafeNonce
        || !record(external) || external.schema !== 1 || external.source !== 'automatic_manual_ctf'
        || !isDeepStrictEqual(checkpoint(external), block) || origin.blockNumber > block.blockNumber
        || origin.blockNumber === block.blockNumber && origin.blockHash !== block.blockHash
        || !integer(external.verifiedAt) || external.verifiedAt < proof.verificationStartedAt || external.verifiedAt > proof.verifiedAt
        || external.orders?.count !== 0 || external.orders?.reservedPUSD !== 0 || external.orders?.overlaps !== false
        || !Array.isArray(external.holdings)) fail('proof_invalid');
    const seen = new Set();
    for (const holding of external.holdings) {
        if (!record(holding) || typeof holding.tokenId !== 'string' || !/^[1-9]\d*$/.test(holding.tokenId)
            || seen.has(holding.tokenId)) fail('proof_invalid');
        seen.add(holding.tokenId); units(holding.amount);
    }
    return { id: value.id, amount: amount(units(value.amount)), approval: { source: value.approval.source, text: value.approval.text },
        walletProof: { ...identity, ...block, balance: amount(units(proof.balance)),
            confirmedNonce: proof.confirmedNonce, pendingNonce: proof.pendingNonce,
            safeNonce: proof.safeNonce, pendingSafeNonce: proof.pendingSafeNonce,
            verificationStartedAt: proof.verificationStartedAt, verifiedAt: proof.verifiedAt },
        externalActivityProof: structuredClone(external), openOrders: [], tradesSettled: true };
}

// Allocations transfer ownership inside one wallet. The original movement
// receipts stay intact and are pinned by prefix so later manual trades can append.
export function capitalAllocationLedger(state) {
    if (!record(state)) fail('state_invalid');
    const ledger = state.capitalAllocations;
    if (ledger === undefined || ledger === null) return null;
    if (!record(ledger) || ledger.schema !== 1 || !Array.isArray(ledger.entries) || !ledger.entries.length
        || !isDeepStrictEqual(ledger.period, period(state))) fail('ledger_invalid');
    const identity = account(ledger), external = source(state), ids = new Set();
    let total = 0n, count = 0, at = state.startedAt, boundary = null;
    for (const entry of ledger.entries) {
        if (!record(entry)) fail('ledger_invalid');
        const request = requestIdentity(entry.request), prefix = entry.receiptPrefix, block = checkpoint(entry.checkpoint);
        if (!isDeepStrictEqual(entry.request, request) || !isDeepStrictEqual(account(request.walletProof), identity)
            || ids.has(request.id) || !DIGEST.test(entry.beforeSha256 || '')
            || !integer(entry.at) || entry.at < at || entry.at < request.walletProof.verifiedAt
            || entry.at > request.walletProof.verificationStartedAt + proofLifetimeMs
            || !record(prefix) || !integer(prefix.count) || prefix.count < 1 || prefix.count < count
            || prefix.count > external.receipts.length || !DIGEST.test(prefix.sha256 || '')
            || digest(external.receipts.slice(0, prefix.count)) !== prefix.sha256
            || units(prefix.cashDelta, true) !== external.totals[prefix.count]
            || !isDeepStrictEqual(block, checkpoint(request.externalActivityProof.checkpoint))
            || block.blockNumber > external.checkpoint.blockNumber
            || block.blockNumber === external.checkpoint.blockNumber && block.blockHash !== external.checkpoint.blockHash
            || boundary && (block.blockNumber < boundary.blockNumber
                || block.blockNumber === boundary.blockNumber && block.blockHash !== boundary.blockHash)
            || external.receipts.slice(0, prefix.count).some(row => row.blockNumber > block.blockNumber
                || row.blockNumber === block.blockNumber && row.blockHash.toLowerCase() !== block.blockHash)) fail('ledger_invalid');
        ids.add(request.id); count = prefix.count; at = entry.at; boundary = block;
        total += units(request.amount);
        if (total > external.totals[prefix.count]) fail('source_exhausted');
        amount(total);
    }
    if (units(ledger.totalAllocated) !== total) fail('ledger_invalid');
    return structuredClone(ledger);
}

export function totalCapitalAllocated(state) {
    return capitalAllocationLedger(state)?.totalAllocated ?? 0;
}

// The caller holds the pilot lock, stops the runtime, and independently obtains
// canonical wallet and readAutomaticExternalAccount proofs. This API never calls
// a wallet or creates on-chain deposit evidence.
export function prepareCapitalAllocation(state, input, { now = Date.now } = {}) {
    const request = requestIdentity(input), ledger = capitalAllocationLedger(state), beforeSha256 = digest(state);
    const existing = ledger?.entries.find(entry => entry.request.id === request.id);
    if (existing && !isDeepStrictEqual(existing.request, request)) fail('id_conflict');
    const identity = account(request.walletProof);
    if (ledger && !isDeepStrictEqual(account(ledger), identity)) fail('identity_mismatch');
    const deposits = capitalFundingLedger(state);
    if (deposits && !isDeepStrictEqual(account(deposits), identity)) fail('identity_mismatch');
    const at = now();
    if (!integer(at)) fail('proof_expired');
    let nextState = null;
    if (!existing) {
        const external = source(state), proof = request.walletProof;
        if (at < proof.verifiedAt || at > proof.verificationStartedAt + proofLifetimeMs) fail('proof_expired');
        if (state.mode !== 'pilot' || state.decisionProvider !== 'eligible' || state.position != null
            || state.frozenAt != null || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
            || !Array.isArray(state.completed) || state.completed.some(row => !record(row) || row.pendingTrades || row.uncertain
                || !Number.isFinite(row.pnl)
                || row.actions != null && (!Array.isArray(row.actions)
                    || row.actions.some(action => !record(action) || !['confirmed', 'failed'].includes(action.status)))
                || row.orders != null && (!Array.isArray(row.orders)
                    || row.orders.some(order => !record(order) || !['complete', 'cancelled', 'rejected'].includes(order.status))))
            || state.ai?.providers != null && (!record(state.ai.providers)
                || Object.values(state.ai.providers).some(provider => !record(provider) || provider.pending || provider.disabled))
            || ['entryHolds', 'reconciliationFaults'].some(key => state[key] != null
                && (!record(state[key]) || Object.keys(state[key]).length))
            || !Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
            || state.lastEquity !== undefined && !Number.isFinite(state.lastEquity)) fail('state_busy');
        if (!isDeepStrictEqual(checkpoint(request.externalActivityProof.checkpoint), external.checkpoint)
            || !isDeepStrictEqual(request.externalActivityProof.holdings, state.externalWalletActivity.automatic.holdings)
            || units(expectedWalletBalance(state)) !== units(proof.balance)) fail('wallet_mismatch');
        const allocated = units(ledger?.totalAllocated ?? 0), requested = units(request.amount);
        if (requested > external.totals.at(-1) - allocated || requested > units(proof.balance)) fail('source_exhausted');
        const entry = { request, at, beforeSha256, checkpoint: external.checkpoint,
            receiptPrefix: { count: external.receipts.length, sha256: digest(external.receipts),
                cashDelta: amount(external.totals.at(-1)) } };
        nextState = structuredClone(state);
        nextState.capitalAllocations = { schema: 1, ...identity, period: period(state),
            entries: [...(ledger?.entries ?? []), entry], totalAllocated: amount(allocated + requested) };
        nextState.cash = amount(units(state.cash, true) + requested);
        nextState.peakEquity = state.peakEquity + request.amount;
        if (state.lastEquity !== undefined) nextState.lastEquity = state.lastEquity + request.amount;
        if (!Number.isFinite(nextState.peakEquity) || nextState.lastEquity !== undefined && !Number.isFinite(nextState.lastEquity))
            fail('amount_invalid');
        capitalAllocationLedger(nextState);
        if (units(expectedWalletBalance(nextState)) !== units(proof.balance)) fail('wallet_mismatch');
    }
    const summary = { id: request.id, amount: existing ? 0 : request.amount, alreadyApplied: !!existing,
        totalAllocated: nextState?.capitalAllocations.totalAllocated ?? ledger.totalAllocated,
        cashBefore: state.cash, cashAfter: nextState?.cash ?? state.cash,
        walletBalance: request.walletProof.balance, financialWrites: false };
    const review = { summary };
    prepared.set(review, { state, beforeSha256, nextState, summarySha256: digest(summary), now,
        verifiedAt: request.walletProof.verifiedAt, expiresAt: request.walletProof.verificationStartedAt + proofLifetimeMs });
    return review;
}

export function applyCapitalAllocation(store, review, { explicitApply = false } = {}) {
    const checked = prepared.get(review);
    if (!explicitApply || !checked || typeof store?.save !== 'function' || store.state !== checked.state
        || digest(store.state) !== checked.beforeSha256 || digest(review.summary) !== checked.summarySha256) fail('review_changed');
    if (!checked.nextState) return { ...review.summary };
    const at = checked.now();
    if (!integer(at) || at < checked.verifiedAt || at > checked.expiresAt) fail('proof_expired');
    const keys = ['capitalAllocations', 'cash', 'peakEquity', 'lastEquity'];
    const restore = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(store.state, key)]));
    try {
        for (const key of keys) if (Object.hasOwn(checked.nextState, key)) store.state[key] = checked.nextState[key];
        store.save();
    } catch (error) {
        for (const [key, descriptor] of restore) {
            if (descriptor) Object.defineProperty(store.state, key, descriptor);
            else delete store.state[key];
        }
        throw error;
    }
    prepared.delete(review);
    return { ...review.summary };
}
