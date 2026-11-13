import { ethers } from 'ethers';
import { CONTRACTS } from '../restart/client.js';

// These proofs are deliberately restricted to Laya's one BUY in a standard
// binary CTF market. An API response or a balance difference is never a fill.
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const ZERO = ethers.constants.AddressZero.toLowerCase();
const ZERO_HASH = ethers.constants.HashZero.toLowerCase();
const CTF_COLLATERAL = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const SCALE = 1000000n;
const orderTypes = { Order: [
    { name: 'salt', type: 'uint256' }, { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' }, { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' }, { name: 'takerAmount', type: 'uint256' },
    { name: 'side', type: 'uint8' }, { name: 'signatureType', type: 'uint8' },
    { name: 'timestamp', type: 'uint256' }, { name: 'metadata', type: 'bytes32' },
    { name: 'builder', type: 'bytes32' },
] };
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const addressIs = (a, b) => ADDRESS.test(a || '') && lower(a) === lower(b);
const units = value => {
    if (!Number.isFinite(value)) throw new Error('invalid_amount');
    const scaled = Math.round(value * Number(SCALE));
    if (!Number.isSafeInteger(scaled) || Math.abs(value * Number(SCALE) - scaled) > 0.00001)
        throw new Error('invalid_amount');
    return BigInt(scaled);
};
const amount = value => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('invalid_amount');
    return Number(value) / Number(SCALE);
};
const uint = value => {
    const text = value?.toString();
    if (!/^\d+$/.test(text || '')) throw new Error('invalid_uint');
    return BigInt(text);
};
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const accounted = (position, hash) => Object.keys(position.receipts || {}).some(key => lower(key) === hash)
    || (position.actions || []).some(action => lower(action.hash) === hash && action.status === 'confirmed');

function context(position, wallet, block) {
    const tokens = position?.market?.tokens;
    if (!ADDRESS.test(wallet || '') || !Number.isSafeInteger(block) || block < 0
        || position?.market?.negRisk === true || !Array.isArray(tokens) || tokens.length !== 2
        || tokens.some(token => !/^\d+$/.test(token)) || tokens[0] === tokens[1]
        || !Array.isArray(position.holdings) || position.holdings.length !== 2)
        throw new Error('invalid_context');
    const holdings = position.holdings.map(units);
    if (holdings.some(value => value < 0n)) throw new Error('invalid_holdings');
    return { tokens, holdings, wallet: lower(wallet) };
}

function receiptLogs(receipt, block) {
    if (!receipt || !HASH.test(receipt.transactionHash || '') || !HASH.test(receipt.blockHash || '')
        || receipt.status !== 1 || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2
        || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > block
        || !Array.isArray(receipt.logs) || !receipt.logs.length) throw new Error('invalid_receipt');
    const decoded = [];
    let previous = -1;
    for (const log of receipt.logs) {
        if (!ADDRESS.test(log?.address || '') || !Number.isSafeInteger(log.logIndex) || log.logIndex <= previous
            || log.removed === true || log.transactionHash !== undefined && lower(log.transactionHash) !== lower(receipt.transactionHash)
            || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash)
            || log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber
            || !Array.isArray(log.topics) || log.topics.some(topic => !HASH.test(topic))
            || !/^0x(?:[\da-f]{2})*$/i.test(log.data || '')) throw new Error('invalid_log');
        previous = log.logIndex;
        const contract = lower(log.address);
        const iface = addressIs(contract, CONTRACTS.standardExchange) ? exchange
            : addressIs(contract, CONTRACTS.collateralToken) ? erc20
                : addressIs(contract, CONTRACTS.conditionalTokens) ? ctf : null;
        if (!iface) continue;
        const event = Object.values(iface.events).find(fragment => iface.getEventTopic(fragment) === lower(log.topics[0]));
        if (event) decoded.push({ ...iface.parseLog(log), logIndex: log.logIndex, address: contract });
    }
    return decoded;
}

function movement(logs, wallet, tokens) {
    let cash = 0n;
    const holdings = [0n, 0n];
    for (const log of logs) {
        if (log.name === 'Transfer' && addressIs(log.address, CONTRACTS.collateralToken)) {
            const sign = BigInt(Number(addressIs(log.args.to, wallet)) - Number(addressIs(log.args.from, wallet)));
            cash += sign * uint(log.args.value);
        } else if (['TransferSingle', 'TransferBatch'].includes(log.name)) {
            const sign = BigInt(Number(addressIs(log.args.to, wallet)) - Number(addressIs(log.args.from, wallet)));
            if (!sign) continue;
            const ids = log.name === 'TransferBatch' ? log.args.ids : [log.args.id];
            const values = log.name === 'TransferBatch' ? log.args[4] : [log.args.value];
            if (ids.length !== values.length || new Set(ids.map(String)).size !== ids.length) throw new Error('invalid_transfer');
            ids.forEach((id, i) => {
                const index = tokens.indexOf(id.toString());
                if (index >= 0) holdings[index] += sign * uint(values[i]);
                else if (uint(values[i]) !== 0n) throw new Error('mixed_token_transfer');
            });
        }
    }
    return { cash, holdings };
}

function result(receipt, cash, holdings) {
    const hash = lower(receipt.transactionHash);
    return { hash, hashes: [hash], blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash),
        cash: amount(cash), holdings: holdings.map(amount) };
}

// Bind the accounting cap to the exact V2 message already committed on chain.
// This reads persisted order fields; it never signs or changes strategy sizing.
export function signedBuyOrderBounds(order, wallet) {
    try {
        const signed = order?.signed;
        if (!signed || typeof signed !== 'object' || Array.isArray(signed)
            || !HASH.test(order.orderId || '') || order.side !== 'BUY' || order.kind !== 'taker'
            || signed.orderType !== 'FAK' || !['BUY', 0].includes(signed.side)
            || !addressIs(signed.maker, wallet) || !ADDRESS.test(signed.signer || '')
            || signed.tokenId !== order.tokenId || !/^\d+$/.test(order.tokenId || '')) return null;
        const makerAmount = uint(signed.makerAmount), takerAmount = uint(signed.takerAmount);
        const shares = units(order.shares), limit = units(order.price);
        if (makerAmount <= 0n || takerAmount !== shares || shares <= 0n || limit <= 0n || limit >= SCALE
            || makerAmount * SCALE > takerAmount * limit) return null;
        const message = { salt: uint(signed.salt), maker: signed.maker, signer: signed.signer,
            tokenId: uint(signed.tokenId), makerAmount, takerAmount, side: 0,
            signatureType: uint(signed.signatureType), timestamp: uint(signed.timestamp),
            metadata: signed.metadata ?? ZERO_HASH, builder: signed.builder ?? ZERO_HASH };
        const hash = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2',
            chainId: 137, verifyingContract: CONTRACTS.standardExchange }, orderTypes, message);
        return lower(hash) === lower(order.orderId) ? { makerAmount, takerAmount } : null;
    } catch { return null; }
}

export function verifyOwnedFillReceipt({ position, wallet, block, receipt, ownedTradeHashes = [], entryCap }) {
    try {
        const ctx = context(position, wallet, block);
        if (position.orders?.length !== 1) return null;
        const order = position.orders[0], hash = lower(receipt?.transactionHash);
        if (!HASH.test(order.orderId || '') || order.side !== 'BUY' || order.kind !== 'taker'
            || !Number.isInteger(order.index) || ![0, 1].includes(order.index) || order.tokenId !== ctx.tokens[order.index]
            || order.status === 'rejected' || accounted(position, hash)
            || ![...(order.transactions || []), ...ownedTradeHashes].some(value => HASH.test(value) && lower(value) === hash)) return null;
        const shares = units(order.shares), settled = units(order.settled), limit = units(order.price);
        const entryCost = units(position.entryCost), estimatedCost = units(order.cost);
        const bounds = signedBuyOrderBounds(order, wallet);
        if (order.signed !== undefined && !bounds) return null;
        // Price improvement can increase fees while spending the same signed principal.
        // Only an explicitly configured cap can replace the original fee estimate.
        const capped = bounds && entryCap !== undefined;
        const totalCap = capped ? units(entryCap) : estimatedCost;
        if (capped && (totalCap <= 0n || totalCap > 5n * SCALE
            || estimatedCost <= 0n || estimatedCost > totalCap)) return null;
        const budget = totalCap - entryCost;
        if (shares <= 0n || settled < 0n || !bounds && settled >= shares || limit <= 0n || limit >= SCALE
            || entryCost < 0n || budget <= 0n) return null;
        let principalBefore = 0n, feesBefore = 0n;
        if (bounds) {
            feesBefore = units(position.fees ?? (settled === 0n && entryCost === 0n ? 0 : NaN));
            principalBefore = entryCost - feesBefore;
            if (feesBefore < 0n || principalBefore < 0n || principalBefore >= bounds.makerAmount
                || (settled === 0n) !== (principalBefore === 0n)
                || principalBefore * bounds.takerAmount > settled * bounds.makerAmount
                || order.settledPrincipal !== undefined && units(order.settledPrincipal) !== principalBefore) return null;
        }
        const logs = receiptLogs(receipt, block);
        const fills = logs.filter(log => log.name === 'OrderFilled' && lower(log.args.orderHash) === lower(order.orderId));
        if (!fills.length) return null;
        let principal = 0n, quantity = 0n, fees = 0n;
        for (const fill of fills) {
            const args = fill.args, q = uint(args.takerAmountFilled), p = uint(args.makerAmountFilled);
            if (!addressIs(args.maker, ctx.wallet) || Number(args.side) !== 0 || args.tokenId.toString() !== order.tokenId
                || q <= 0n || p <= 0n || p * SCALE > q * limit
                || bounds && p * bounds.takerAmount > q * bounds.makerAmount) return null;
            principal += p; quantity += q; fees += uint(args.fee);
        }
        if (bounds ? principalBefore + principal > bounds.makerAmount : quantity > shares - settled) return null;
        if (principal + fees > budget) return null;
        const expected = [0n, 0n]; expected[order.index] = quantity;
        const observed = movement(logs, ctx.wallet, ctx.tokens);
        if (observed.cash !== -(principal + fees) || !equal(observed.holdings, expected)) return null;
        const part = { orderId: order.orderId, index: order.index, shares: amount(quantity),
            price: Number(principal) / Number(quantity), principal: amount(principal), fee: amount(fees) };
        if (bounds) part.signedAmounts = { makerAmount: String(bounds.makerAmount), takerAmount: String(bounds.takerAmount),
            principalBefore: String(principalBefore), principalAfter: String(principalBefore + principal),
            feeBefore: String(feesBefore), feeAfter: String(feesBefore + fees),
            quantityBefore: String(settled), quantityAfter: String(settled + quantity),
            remainingPrincipal: String(bounds.makerAmount - principalBefore - principal) };
        return { ...result(receipt, observed.cash, observed.holdings), fees: amount(fees), notional: -amount(principal), parts: [part] };
    } catch { return null; }
}

export function pendingSettlementWitness({ position, wallet, block, now, receipts, expectedCash, actualCash, actualHoldings, entryCap }) {
    try {
        context(position, wallet, block);
        if (position.pendingTrades !== true || !Number.isFinite(position.pendingSince) || !Number.isFinite(now)
            || now < position.pendingSince || now - position.pendingSince >= 120000 || !Array.isArray(receipts)
            || !receipts.length || !Number.isFinite(expectedCash) || expectedCash < 0
            || !Number.isFinite(actualCash) || actualCash < 0
            || (position.actions || []).some(action => ['prepared', 'pending', 'unknown', 'invalid'].includes(action.status))
            || !Array.isArray(actualHoldings) || actualHoldings.length !== 2) return null;
        const shadow = { ...position, orders: position.orders.map(order => ({ ...order })), receipts: { ...position.receipts } };
        let cash = 0n;
        const holdings = [0n, 0n], hashes = [];
        for (const receipt of receipts) {
            const proof = verifyOwnedFillReceipt({ position: shadow, wallet, block, receipt, entryCap });
            if (!proof) return null;
            cash += units(proof.cash);
            proof.holdings.forEach((value, i) => { holdings[i] += units(value); });
            hashes.push(proof.hash); shadow.receipts[proof.hash] = true;
            shadow.entryCost = amount(units(shadow.entryCost) - units(proof.cash));
            shadow.fees = amount(units(shadow.fees ?? 0) + units(proof.fees));
            shadow.orders[0].settled = amount(units(shadow.orders[0].settled) + units(proof.parts[0].shares));
            if (proof.parts[0].signedAmounts)
                shadow.orders[0].settledPrincipal = amount(BigInt(proof.parts[0].signedAmounts.principalAfter));
        }
        if (units(actualCash) !== units(expectedCash) + cash
            || !equal(actualHoldings.map(units), position.holdings.map((value, i) => units(value) + holdings[i]))) return null;
        return { block, cash: amount(cash), holdings: holdings.map(amount), hashes };
    } catch { return null; }
}

export function verifyAutoRedeemReceipt({ position, wallet, block, payout, receipt }) {
    try {
        const ctx = context(position, wallet, block), hash = lower(receipt?.transactionHash);
        if (!HASH.test(position.market.conditionId || '') || !Array.isArray(payout) || payout.length !== 2
            || ![[0, 1], [1, 0]].some(value => equal(payout, value)) || accounted(position, hash)
            || ctx.holdings.filter(value => value > 0n).length !== 1) return null;
        const heldIndex = ctx.holdings.findIndex(value => value > 0n), order = position.orders?.[0];
        if (position.orders?.length !== 1 || !HASH.test(order.orderId || '') || order.side !== 'BUY'
            || order.kind !== 'taker' || order.index !== heldIndex || order.tokenId !== ctx.tokens[heldIndex]
            || units(order.settled) < ctx.holdings[heldIndex]) return null;
        const expectedCash = ctx.holdings.reduce((sum, value, i) => sum + value * BigInt(payout[i]), 0n);
        if (expectedCash < 0n) return null;
        const logs = receiptLogs(receipt, block), operator = CONTRACTS.autoRedeemOperator;
        const walletTokens = logs.filter(log => ['TransferSingle', 'TransferBatch'].includes(log.name)
            && (addressIs(log.args.from, wallet) || addressIs(log.args.to, wallet)));
        const walletCash = logs.filter(log => log.name === 'Transfer'
            && (addressIs(log.args.from, wallet) || addressIs(log.args.to, wallet)));
        if (walletTokens.length !== 1 || walletCash.length !== 1) return null;
        const transfer = walletTokens[0], mint = walletCash[0];
        if (transfer.name !== 'TransferBatch' || !addressIs(transfer.args.operator, operator)
            || !addressIs(transfer.args.from, wallet) || !addressIs(transfer.args.to, operator)
            || transfer.args.ids.length !== 2 || new Set(transfer.args.ids.map(String)).size !== 2
            || !ctx.tokens.every((token, i) => {
                const index = transfer.args.ids.findIndex(id => id.toString() === token);
                return index >= 0 && uint(transfer.args[4][index]) === ctx.holdings[i];
            }) || !addressIs(mint.args.from, ZERO) || !addressIs(mint.args.to, wallet)
            || uint(mint.args.value) !== expectedCash || transfer.logIndex >= mint.logIndex) return null;
        // A batch redeems many wallets. Bind the payout and burn to the segment
        // beginning with this wallet's transfer and ending at its pUSD mint.
        const segment = logs.filter(log => log.logIndex > transfer.logIndex && log.logIndex < mint.logIndex);
        const payouts = segment.filter(log => log.name === 'PayoutRedemption');
        if (payouts.length !== 1) return null;
        const redemption = payouts[0], args = redemption.args;
        if (!addressIs(args.redeemer, operator) || !addressIs(args.collateralToken, CTF_COLLATERAL)
            || lower(args.parentCollectionId) !== ZERO_HASH || lower(args.conditionId) !== lower(position.market.conditionId)
            || !equal(args.indexSets.map(value => uint(value)), [1n, 2n]) || uint(args.payout) !== expectedCash) return null;
        const burns = segment.filter(log => log.name === 'TransferSingle' && addressIs(log.args.from, operator)
            && addressIs(log.args.to, ZERO));
        if (burns.length !== 1 || !addressIs(burns[0].args.operator, operator)
            || burns[0].args.id.toString() !== ctx.tokens[heldIndex] || uint(burns[0].args.value) !== ctx.holdings[heldIndex]
            || burns[0].logIndex >= redemption.logIndex
            || segment.some(log => ['TransferSingle', 'TransferBatch'].includes(log.name)
                && !burns.includes(log))) return null;
        const observed = movement(logs, ctx.wallet, ctx.tokens);
        if (observed.cash !== expectedCash || !equal(observed.holdings, ctx.holdings.map(value => -value))) return null;
        return result(receipt, observed.cash, observed.holdings);
    } catch { return null; }
}
