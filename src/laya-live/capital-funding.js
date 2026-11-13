// Receipt discovery and canonical-chain verification belong to the caller.
// This module only books verified transfers after an exact wallet reconciliation.
const SCALE = 1000000n;
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const ADDRESS = /^0x[\da-f]{40}$/i;
const HASH = /^0x[\da-f]{64}$/i;
const own = (value, key) => Object.hasOwn(value, key);
const fail = code => { throw new Error(code); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = value => Number.isSafeInteger(value) && value >= 0;

function units(value, { negative = false } = {}) {
    let result;
    if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
        const sign = value.startsWith('-') ? -1n : 1n;
        const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
        result = sign * (BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0')));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
        const scaled = value * Number(SCALE), rounded = Math.round(scaled);
        if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .00001)
            fail('invalid_capital_funding_amount');
        result = BigInt(rounded);
    } else fail('invalid_capital_funding_amount');
    if (result > MAX || result < -MAX || !negative && result < 0n) fail('invalid_capital_funding_amount');
    return result;
}

function amount(value) {
    if (value > MAX || value < -MAX) fail('invalid_capital_funding_amount');
    const result = Number(value) / Number(SCALE);
    if (units(result, { negative: true }) !== value) fail('invalid_capital_funding_amount');
    return result;
}

function address(value) {
    if (typeof value !== 'string' || !ADDRESS.test(value)) fail('invalid_capital_funding_identity');
    return value.toLowerCase();
}

function identity(value) {
    if (!record(value) || value.chainId !== 137) fail('invalid_capital_funding_identity');
    const tokenAddress = address(value.tokenAddress), walletAddress = address(value.walletAddress);
    if (/^0x0{40}$/.test(tokenAddress) || /^0x0{40}$/.test(walletAddress)) fail('invalid_capital_funding_identity');
    return { chainId: 137, tokenAddress, walletAddress };
}

function checkpoint(value) {
    if (!record(value) || !integer(value.blockNumber)
        || typeof value.blockHash !== 'string' || !HASH.test(value.blockHash))
        fail('invalid_capital_funding_checkpoint');
    return { blockNumber: value.blockNumber, blockHash: value.blockHash.toLowerCase() };
}

function receipt(value, account) {
    if (!record(value) || typeof value.txHash !== 'string' || !HASH.test(value.txHash)
        || !integer(value.logIndex)) fail('invalid_capital_funding_receipt');
    const block = checkpoint(value), from = address(value.from), valueUnits = units(value.amount);
    if (from === account.walletAddress || valueUnits <= 0n) fail('invalid_capital_funding_receipt');
    return { txHash: value.txHash.toLowerCase(), logIndex: value.logIndex, from,
        amount: amount(valueUnits), ...block };
}

function receiptId(account, entry) {
    return `${account.chainId}:${account.tokenAddress}:${account.walletAddress}:${entry.txHash}:${entry.logIndex}`;
}

function checkBlock(entry, boundary, transactions) {
    if (boundary && (entry.blockNumber > boundary.blockNumber
        || entry.blockNumber === boundary.blockNumber && entry.blockHash !== boundary.blockHash))
        fail('invalid_capital_funding_checkpoint');
    const previous = transactions.get(entry.txHash);
    if (previous && (previous.blockNumber !== entry.blockNumber || previous.blockHash !== entry.blockHash))
        fail('conflicting_capital_funding_receipt');
    const blockHash = transactions.get(`block:${entry.blockNumber}`);
    const blockNumber = transactions.get(`hash:${entry.blockHash}`);
    if (blockHash !== undefined && blockHash !== entry.blockHash
        || blockNumber !== undefined && blockNumber !== entry.blockNumber)
        fail('conflicting_capital_funding_receipt');
    transactions.set(entry.txHash, entry);
    transactions.set(`block:${entry.blockNumber}`, entry.blockHash);
    transactions.set(`hash:${entry.blockHash}`, entry.blockNumber);
}

// Reconciliation and profit accounting share this validator so malformed or
// edited history can never silently become an empty funding balance.
export function capitalFundingLedger(state) {
    if (!record(state)) fail('invalid_capital_funding_state');
    const ledger = state.capitalFunding;
    if (ledger === undefined || ledger === null) return null;
    if (!record(ledger) || ledger.schema !== 1 || !record(ledger.entries))
        fail('invalid_capital_funding_ledger');
    const account = identity(ledger), entries = {}, transactions = new Map();
    const boundary = ledger.checkpoint === undefined ? null : checkpoint(ledger.checkpoint);
    let total = 0n;
    for (const [id, value] of Object.entries(ledger.entries)) {
        const entry = receipt(value, account);
        if (id !== receiptId(account, entry) || own(entries, id)) fail('invalid_capital_funding_ledger');
        checkBlock(entry, boundary, transactions);
        entries[id] = entry;
        total += units(entry.amount);
        amount(total);
    }
    if (units(ledger.totalDeposited) !== total) fail('invalid_capital_funding_ledger');
    return { schema: 1, ...account, entries, totalDeposited: amount(total),
        ...(boundary ? { checkpoint: boundary } : {}) };
}

export function totalCapitalDeposited(state) {
    return capitalFundingLedger(state)?.totalDeposited ?? 0;
}

// The caller must hold its state lock and verify every receipt independently.
// Balance equality alone is never enough: only new receipt IDs create credit.
export function applyConfirmedCapitalDeposits(store, review) {
    if (!record(store?.state) || typeof store.save !== 'function') fail('invalid_capital_funding_store');
    const state = store.state, previous = capitalFundingLedger(state), account = identity(review);
    if (!Array.isArray(review.entries)) fail('invalid_capital_funding_review');
    if (previous && ['chainId', 'tokenAddress', 'walletAddress'].some(key => previous[key] !== account[key]))
        fail('capital_funding_identity_mismatch');
    if (!record(state.liveFunding) || !Number.isFinite(state.peakEquity)) fail('invalid_capital_funding_state');
    units(state.liveFunding.initialCapital); units(state.walletStart);
    const cash = units(state.cash, { negative: true }), position = state.position;
    if (position != null && (!record(position) || !Number.isFinite(position.startingCash)))
        fail('invalid_capital_funding_state');
    const expectedBefore = units(review.expectedBalanceBefore), actualAfter = units(review.actualBalanceAfter);
    const boundary = review.checkpoint === undefined ? previous?.checkpoint : checkpoint(review.checkpoint);
    if (previous?.checkpoint && (boundary.blockNumber < previous.checkpoint.blockNumber
        || boundary.blockNumber === previous.checkpoint.blockNumber && boundary.blockHash !== previous.checkpoint.blockHash))
        fail('capital_funding_checkpoint_regressed');
    const entries = { ...(previous?.entries ?? {}) }, transactions = new Map(), reviewed = new Set();
    for (const entry of Object.values(entries)) checkBlock(entry, boundary, transactions);
    const applied = [], skipped = [];
    let deposited = 0n;
    for (const value of review.entries) {
        const entry = receipt(value, account), id = receiptId(account, entry);
        if (reviewed.has(id)) fail('duplicate_capital_funding_receipt');
        reviewed.add(id);
        checkBlock(entry, boundary, transactions);
        if (own(entries, id)) {
            if (JSON.stringify(entries[id]) !== JSON.stringify(entry)) fail('conflicting_capital_funding_receipt');
            skipped.push(id);
            continue;
        }
        entries[id] = entry;
        applied.push({ id, ...entry });
        deposited += units(entry.amount);
        amount(deposited);
    }
    if (actualAfter - expectedBefore !== deposited) fail('capital_funding_balance_mismatch');
    const totalDeposited = amount(units(previous?.totalDeposited ?? 0) + deposited);
    const checkpointChanged = JSON.stringify(previous?.checkpoint) !== JSON.stringify(boundary);
    const result = { applied, skipped, amount: amount(deposited), totalDeposited, checkpointChanged };
    if (!applied.length && !checkpointChanged) return result;
    const next = { capitalFunding: { schema: 1, ...account, entries, totalDeposited,
        ...(boundary ? { checkpoint: boundary } : {}) } };
    if (deposited > 0n) {
        next.cash = amount(cash + deposited);
        next.peakEquity = state.peakEquity + result.amount;
        if (Number.isFinite(state.lastEquity)) next.lastEquity = state.lastEquity + result.amount;
        if (!Number.isFinite(next.peakEquity) || own(next, 'lastEquity') && !Number.isFinite(next.lastEquity))
            fail('invalid_capital_funding_state');
    }
    // An open trade's cash baseline must move with capital or its eventual PnL
    // (cash minus startingCash) would report the deposit as trading income.
    const startingCash = deposited > 0n && position != null
        ? amount(units(position.startingCash, { negative: true }) + deposited) : undefined;
    const positionDescriptor = startingCash === undefined ? null : Object.getOwnPropertyDescriptor(position, 'startingCash');
    const restore = new Map(Object.keys(next).map(key => [key, Object.getOwnPropertyDescriptor(state, key)]));
    try {
        Object.assign(state, next);
        if (startingCash !== undefined) position.startingCash = startingCash;
        store.save();
    } catch (error) {
        for (const [key, descriptor] of restore) {
            if (descriptor) Object.defineProperty(state, key, descriptor);
            else delete state[key];
        }
        if (startingCash !== undefined) {
            if (positionDescriptor) Object.defineProperty(position, 'startingCash', positionDescriptor);
            else delete position.startingCash;
        }
        throw error;
    }
    return result;
}
