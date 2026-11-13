import { OperationalError } from '../restart/network.js';

const HASH = /^0x[\da-f]{64}$/i;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Reserve the full payout value of each remaining manual BUY share. This
// deliberately leaves room for fees without borrowing manual-order collateral.
export function externalOrderReservations(orders, { owned = [], market = null } = {}) {
    const fail = () => { throw new OperationalError('external_orders_unproven', 'opportunity', { stage: 'account_read' }); };
    if (!Array.isArray(orders) || !Array.isArray(owned)) fail();
    const own = new Set(owned.map(id => String(id).toLowerCase())), seen = new Set();
    let reservedPUSD = 0, overlaps = false, count = 0;
    for (const order of orders) {
        const id = String(order?.id || '').toLowerCase();
        if (!/^0x[\da-f]{64}$/.test(id) || seen.has(id)) fail();
        seen.add(id);
        if (own.has(id)) continue;
        const token = order.tokenId ?? order.assetId;
        const size = Number(order.originalSize), matched = Number(order.sizeMatched), price = Number(order.price);
        const side = String(order.side).toUpperCase();
        if (!/^[1-9]\d*$/.test(token || '') || !/^0x[\da-f]{64}$/i.test(order.conditionId || '')
            || !['BUY', 'SELL'].includes(side) || ![size, matched, price].every(Number.isFinite)
            || size <= 0 || matched < 0 || matched > size || price <= 0 || price >= 1) fail();
        if (side === 'BUY') reservedPUSD += size - matched;
        if (!Number.isFinite(reservedPUSD)) fail();
        overlaps ||= !!market && (market.conditionId?.toLowerCase() === order.conditionId.toLowerCase()
            || market.tokens?.includes(token));
        count++;
    }
    return { count, reservedPUSD: Math.ceil(reservedPUSD * 1e6) / 1e6, overlaps };
}

// An already matched FAK can leave the open-order list before its cash debit
// confirms. This admission check never credits cash or changes trade state.
export async function assertExternalTradesSettled(trades, { client, block, owned = [], knownHashes = [] } = {}) {
    const fail = () => { throw new OperationalError('external_trades_pending', 'opportunity', { stage: 'account_read' }); };
    if (!Array.isArray(trades) || !Array.isArray(owned) || owned.some(id => !HASH.test(id || ''))
        || !Array.isArray(knownHashes) || knownHashes.some(hash => !HASH.test(hash || ''))) fail();
    const own = new Set(owned.map(lower)), known = new Set(knownHashes.map(lower)), pending = new Set();
    const summary = { apiTerminal: 0, owned: 0, receiptConfirmed: [] };
    for (const trade of trades) {
        if (!record(trade)) fail();
        const whollyOwned = trade.traderSide === 'TAKER' && own.has(lower(trade.takerOrderId))
            || trade.traderSide === 'MAKER' && Array.isArray(trade.makerOrders) && trade.makerOrders.length > 0
                && trade.makerOrders.every(order => record(order) && own.has(lower(order.orderId)));
        if (whollyOwned) { summary.owned++; continue; }
        const status = typeof trade.status === 'string' ? trade.status.replace(/^TRADE_STATUS_/, '').toUpperCase() : '';
        if (['CONFIRMED', 'FAILED'].includes(status)) { summary.apiTerminal++; continue; }
        if (!['MATCHED', 'MINED', 'RETRYING'].includes(status) || !HASH.test(trade.transactionHash || '')
            || /^0x0{64}$/i.test(trade.transactionHash)) fail();
        pending.add(lower(trade.transactionHash));
    }
    if (!pending.size) return summary;
    if (!Number.isSafeInteger(block) || block < 0 || !HASH.test(client?.rpc?.anchor?.hash || '')) fail();
    const blockHash = lower(client.rpc.anchor.hash);
    const guard = () => {
        if (client.rpc.anchor?.number !== block || lower(client.rpc.anchor.hash) !== blockHash) fail();
    };
    for (const hash of pending) {
        guard();
        if (known.has(hash)) {
            summary.receiptConfirmed.push({ transactionHash: hash, source: 'known_receipt' });
            continue;
        }
        if (typeof client.verifiedReceipt !== 'function') fail();
        let receipt;
        try { receipt = await client.verifiedReceipt(hash, block); } catch { fail(); }
        guard();
        if (!record(receipt) || lower(receipt.transactionHash) !== hash || receipt.status !== 1
            || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > block
            || !HASH.test(receipt.blockHash || '') || /^0x0{64}$/i.test(receipt.blockHash)
            || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2) fail();
        summary.receiptConfirmed.push({ transactionHash: hash, blockNumber: receipt.blockNumber,
            blockHash: lower(receipt.blockHash), source: 'canonical_receipt' });
    }
    guard();
    return summary;
}
