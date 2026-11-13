import { ethers } from 'ethers';
import { CONTRACTS } from '../restart/client.js';

// Only historical standard V1 maker trades are covered by this proof. It
// establishes finality for period readiness, never credits live fill/PnL.
const EXCHANGE = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
const COLLATERAL = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
const UINT = /^(0|[1-9]\d*)$/;
const SCALE = 1000000n;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const status = trade => typeof trade?.status === 'string' ? trade.status.replace(/^TRADE_STATUS_/, '') : '';
const terminal = trade => ['CONFIRMED', 'FAILED'].includes(status(trade));
const fail = () => { throw new Error('eligible_period_trades_pending'); };
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)',
]);
const ctfAbi = [
    'function getOutcomeSlotCount(bytes32) view returns (uint256)',
    'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
    'function getPositionId(address,bytes32) view returns (uint256)',
];

function decimal(value) {
    const text = String(value);
    if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text)) fail();
    const result = BigInt(ethers.utils.parseUnits(text, 6).toString());
    if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return result;
}

function anchor(client, proof) {
    if (!Number.isSafeInteger(proof?.blockNumber) || proof.blockNumber < 0 || !HASH.test(proof.blockHash || '')
        || client.rpc?.anchor?.number !== proof.blockNumber || client.rpc.anchor.hash !== proof.blockHash)
        throw new Error('eligible_period_invalid_snapshot');
}

function receiptEvents(receipt, hash, block) {
    if (!receipt || lower(receipt.transactionHash) !== hash || !HASH.test(receipt.blockHash || '')
        || receipt.status !== 1 || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2
        || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > block
        || !Array.isArray(receipt.logs) || !receipt.logs.length) fail();
    const events = [];
    let last = -1;
    for (const log of receipt.logs) {
        if (!ADDRESS.test(log?.address || '') || !Number.isSafeInteger(log.logIndex) || log.logIndex <= last
            || log.removed === true || log.transactionHash !== undefined && lower(log.transactionHash) !== hash
            || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash)
            || log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber
            || !Array.isArray(log.topics) || log.topics.some(topic => !HASH.test(topic))
            || !/^0x(?:[\da-f]{2})*$/i.test(log.data || '')) fail();
        last = log.logIndex;
        if (lower(log.address) === EXCHANGE && lower(log.topics[0]) === lower(exchange.getEventTopic('OrderFilled'))) {
            try { events.push(exchange.parseLog(log).args); } catch { fail(); }
        }
    }
    return events;
}

async function closedMarket(client, conditionId, proof) {
    const block = proof.blockNumber;
    const tokens = await client.rpc.read('eligible_period_market', async provider => {
        const ctf = new ethers.Contract(CONTRACTS.conditionalTokens, ctfAbi, provider), options = { blockTag: block };
        if (!(await ctf.getOutcomeSlotCount(conditionId, options)).eq(2)) fail();
        return Promise.all([1, 2].map(async index => {
            const collection = await ctf.getCollectionId(ethers.constants.HashZero, conditionId, index, options);
            return (await ctf.getPositionId(COLLATERAL, collection, options)).toString();
        }));
    }, block);
    if (tokens.length !== 2 || tokens[0] === tokens[1] || tokens.some(token => !UINT.test(token) || token === '0')) fail();
    const [payout, holdings] = await Promise.all([
        client.payoutAtBlock(conditionId, block), client.holdings(tokens, block),
    ]);
    if (!Array.isArray(payout) || payout.length !== 2
        || payout.some(value => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(payout[0] + payout[1] - 1) > 1e-9
        || !Array.isArray(holdings) || holdings.length !== 2 || holdings.some(value => value !== 0)) fail();
    anchor(client, proof);
    return { tokens, payout, holdings };
}

export async function reconcilePeriodTrades(trades, { client, wallet, proof } = {}) {
    if (!Array.isArray(trades) || trades.some(trade => !trade || typeof trade !== 'object' || Array.isArray(trade))) fail();
    const pending = trades.filter(trade => !terminal(trade));
    const result = { apiTerminal: trades.length - pending.length, receiptConfirmed: [] };
    if (!pending.length) return result;
    if (!ADDRESS.test(wallet || '') || !client?.verifiedReceipt) fail();
    anchor(client, proof);
    const groups = new Map(), ids = new Set(), markets = new Map();
    for (const trade of pending) {
        if (!['MATCHED', 'MINED'].includes(status(trade)) || trade.traderSide !== 'MAKER'
            || typeof trade.id !== 'string' || !trade.id || ids.has(trade.id)
            || !HASH.test(trade.transactionHash || '') || !HASH.test(trade.conditionId || '')
            || !Array.isArray(trade.makerOrders)) fail();
        ids.add(trade.id);
        const owned = trade.makerOrders.filter(order => lower(order?.makerAddress) === lower(wallet));
        if (!owned.length) fail();
        const orderIds = new Set();
        const orders = owned.map(order => {
            const tokenId = order.assetId ?? order.tokenId;
            if (!HASH.test(order.orderId || '') || !UINT.test(tokenId || '') || tokenId === '0'
                || order.assetId !== undefined && order.tokenId !== undefined && order.assetId !== order.tokenId
                || !['BUY', 'SELL'].includes(order.side) || orderIds.has(lower(order.orderId))) fail();
            orderIds.add(lower(order.orderId));
            const shares = decimal(order.matchedAmount), price = decimal(order.price);
            if (price >= SCALE) fail();
            return { orderId: lower(order.orderId), tokenId, side: order.side, shares,
                principal: (shares * price + SCALE / 2n) / SCALE };
        });
        const hash = lower(trade.transactionHash);
        if (!groups.has(hash)) groups.set(hash, []);
        groups.get(hash).push({ trade, orders });
    }
    for (const [hash, rows] of groups) {
        anchor(client, proof);
        const receipt = await client.verifiedReceipt(hash, proof.blockNumber);
        const events = receiptEvents(receipt, hash, proof.blockNumber), expected = new Map();
        for (const { trade, orders } of rows) {
            const condition = lower(trade.conditionId);
            if (!markets.has(condition)) markets.set(condition, await closedMarket(client, condition, proof));
            const { tokens } = markets.get(condition);
            for (const order of orders) {
                if (!tokens.includes(order.tokenId)) fail();
                const prior = expected.get(order.orderId);
                if (prior && (prior.tokenId !== order.tokenId || prior.side !== order.side || prior.condition !== condition)) fail();
                expected.set(order.orderId, { ...order, condition, shares: order.shares + (prior?.shares || 0n),
                    principal: order.principal + (prior?.principal || 0n) });
            }
        }
        for (const order of expected.values()) {
            const matches = events.filter(event => lower(event.orderHash) === order.orderId);
            if (!matches.length) fail();
            let shares = 0n, principal = 0n;
            for (const event of matches) {
                const buy = order.side === 'BUY';
                if (lower(event.maker) !== lower(wallet)
                    || event[buy ? 'makerAssetId' : 'takerAssetId'].toString() !== '0'
                    || event[buy ? 'takerAssetId' : 'makerAssetId'].toString() !== order.tokenId) fail();
                shares += BigInt(event[buy ? 'takerAmountFilled' : 'makerAmountFilled'].toString());
                principal += BigInt(event[buy ? 'makerAmountFilled' : 'takerAmountFilled'].toString());
            }
            if (shares !== order.shares || principal <= 0n || principal < order.principal - 1n || principal > order.principal + 1n) fail();
        }
        for (const { trade, orders } of rows) result.receiptConfirmed.push({ tradeId: trade.id, apiStatus: status(trade),
            conditionId: lower(trade.conditionId), market: markets.get(lower(trade.conditionId)),
            transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash),
            orders: orders.map(order => ({ orderId: order.orderId, tokenId: order.tokenId,
                shares: Number(order.shares) / Number(SCALE), principal: Number(order.principal) / Number(SCALE) })) });
    }
    anchor(client, proof);
    return result;
}
