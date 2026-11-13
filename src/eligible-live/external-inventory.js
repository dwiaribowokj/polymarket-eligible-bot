import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { isDeepStrictEqual } from 'node:util';
import { CONTRACTS } from '../restart/client.js';

const HASH = /^0x[\da-f]{64}$/i;
const TOKEN = /^[1-9]\d*$/;
const ADDRESS = /^0x[\da-f]{40}$/i;
const COLLATERAL = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const fail = () => { throw new Error('eligible_external_inventory_unproven'); };
const stateDigest = state => {
    const { events, operational, diagnostics, lastTickAt, lastHeartbeatAt, ...protectedState } = state;
    return digest(protectedState);
};
const abi = new ethers.utils.Interface([
    'function getOutcomeSlotCount(bytes32) view returns (uint256)',
    'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
    'function getPositionId(address,bytes32) view returns (uint256)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);
const transferTopics = ['TransferSingle', 'TransferBatch'].map(name => lower(abi.getEventTopic(name)));

function units(value) {
    if (!Number.isFinite(value) || !/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(String(value))) fail();
    const result = BigInt(ethers.utils.parseUnits(String(value), 6).toString());
    if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < -BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return result;
}

function anchor(client, proof) {
    if (!timestamp(proof?.blockNumber) || !HASH.test(proof.blockHash || '')
        || client.rpc?.anchor?.number !== proof.blockNumber || client.rpc.anchor.hash !== proof.blockHash) fail();
}

function receiptHoldings(receipt, expected, wallet, tokens, block) {
    if (!record(receipt) || lower(receipt.transactionHash) !== lower(expected.hash)
        || receipt.status !== 1 || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2
        || receipt.blockNumber !== expected.blockNumber || receipt.blockNumber > block
        || lower(receipt.blockHash) !== lower(expected.blockHash) || !Array.isArray(receipt.logs)) fail();
    const amounts = tokens.map(() => 0n);
    let lastIndex = -1;
    for (const log of receipt.logs) {
        if (!record(log) || !ADDRESS.test(log.address || '') || !Number.isSafeInteger(log.logIndex)
            || log.logIndex <= lastIndex || log.removed === true
            || log.transactionHash != null && lower(log.transactionHash) !== lower(expected.hash)
            || log.blockHash != null && lower(log.blockHash) !== lower(expected.blockHash)
            || log.blockNumber != null && log.blockNumber !== expected.blockNumber) fail();
        lastIndex = log.logIndex;
        if (lower(log.address) !== lower(CONTRACTS.conditionalTokens)) continue;
        if (!Array.isArray(log.topics) || !HASH.test(log.topics[0] || '')) fail();
        if (!transferTopics.includes(lower(log.topics[0]))) continue;
        let event;
        try { event = abi.parseLog(log); } catch { fail(); }
        if (!['TransferSingle', 'TransferBatch'].includes(event.name)) continue;
        const sign = BigInt(Number(lower(event.args.to) === wallet) - Number(lower(event.args.from) === wallet));
        const ids = event.name === 'TransferBatch' ? event.args.ids : [event.args.id];
        const values = event.name === 'TransferBatch' ? event.args[4] : [event.args.value];
        if (ids.length !== values.length) fail();
        ids.forEach((id, i) => {
            const index = tokens.indexOf(id.toString());
            if (index >= 0) amounts[index] += sign * BigInt(values[i].toString());
        });
    }
    return amounts;
}

// Only reviewed external standard-binary CTF positions are eligible. Their
// receipt ownership and official zero payout never become bot capital or PnL.
export async function readExternalInventoryProof(config, state, client, account, walletProof,
    { now = Date.now, guard = () => {} } = {}) {
    const external = state.externalWalletActivity, approvals = external?.zeroPayoutInventory;
    if (approvals == null) return { account, proof: null, excludedLegacyInventory: [] };
    const startedAt = now(), stateSha256 = stateDigest(state), accountSha256 = digest(account);
    const check = () => {
        guard(); anchor(client, walletProof);
        const at = now();
        if (!timestamp(at) || at < startedAt || stateDigest(state) !== stateSha256 || digest(account) !== accountSha256) fail();
        return at;
    };
    check();
    if (!timestamp(startedAt) || !timestamp(external.reviewedAt) || external.reviewedAt > startedAt
        || !Array.isArray(approvals) || !Array.isArray(external.receipts)
        || !ADDRESS.test(config.settings?.wallet || '') || !Array.isArray(account?.positions)
        || account.positions.some(position => !record(position) || !Number.isFinite(position.size) || position.size < 0)
        || !Array.isArray(account.openOrders) || account.openOrders.length
        || !Array.isArray(state.completed) || state.position != null
        || new Set(external.receipts.map(row => lower(row?.hash))).size !== external.receipts.length) fail();
    const botTokens = new Set(state.completed.flatMap(row => row.tokens || []));
    const botConditions = new Set(state.completed.map(row => lower(row.conditionId)));
    const conditions = new Set(), owned = new Set(), receipts = new Map(), inventory = [], excludedLegacyInventory = [];
    for (const approved of approvals) {
        if (!record(approved) || !HASH.test(approved.conditionId || '') || conditions.has(lower(approved.conditionId))
            || botConditions.has(lower(approved.conditionId)) || typeof approved.slug !== 'string' || !approved.slug
            || !Array.isArray(approved.tokens) || approved.tokens.length !== 2 || approved.tokens[0] === approved.tokens[1]
            || approved.tokens.some(token => typeof token !== 'string' || !TOKEN.test(token) || owned.has(token) || botTokens.has(token))
            || !Array.isArray(approved.amounts) || approved.amounts.length !== 2
            || approved.amounts.some(amount => units(amount) < 0n) || !approved.amounts.some(amount => amount > 0)
            || !isDeepStrictEqual(approved.payout, [1, 0]) && !isDeepStrictEqual(approved.payout, [0, 1])
            || approved.amounts.some((amount, index) => amount > 0 && approved.payout[index] !== 0)
            || !Array.isArray(approved.receiptHashes) || !approved.receiptHashes.length
            || approved.receiptHashes.some(hash => !HASH.test(hash))
            || new Set(approved.receiptHashes.map(lower)).size !== approved.receiptHashes.length) fail();
        conditions.add(lower(approved.conditionId)); approved.tokens.forEach(token => owned.add(token));
        const expected = approved.amounts.map(units), origin = approved.tokens.map(() => 0n), relevant = [];
        for (const row of external.receipts) {
            if (!record(row) || !HASH.test(row.hash || '')) fail();
            const listed = approved.receiptHashes.some(hash => lower(hash) === lower(row.hash));
            const intersects = Array.isArray(row.tokenIds) && row.tokenIds.some(token => approved.tokens.includes(token));
            if (!listed && !intersects) continue;
            if (!timestamp(row.blockNumber) || !HASH.test(row.blockHash || '') || !Array.isArray(row.tokenIds)
                || !Array.isArray(row.holdings) || row.tokenIds.length !== row.holdings.length
                || new Set(row.tokenIds).size !== row.tokenIds.length || row.tokenIds.some(token => !TOKEN.test(token))) fail();
            const amounts = approved.tokens.map(token => {
                const index = row.tokenIds.indexOf(token);
                return index < 0 ? 0n : units(row.holdings[index]);
            });
            if (!amounts.some(amount => amount !== 0n)) { if (listed) fail(); else continue; }
            if (!listed) fail();
            const key = lower(row.hash);
            if (!receipts.has(key)) receipts.set(key, await client.verifiedReceipt(row.hash, walletProof.blockNumber));
            check();
            const actual = receiptHoldings(receipts.get(key), row, lower(config.settings.wallet), approved.tokens, walletProof.blockNumber);
            if (!isDeepStrictEqual(actual, amounts)) fail();
            amounts.forEach((amount, index) => { origin[index] += amount; }); relevant.push(key);
        }
        if (!isDeepStrictEqual(origin, expected)
            || !isDeepStrictEqual(relevant.sort(), approved.receiptHashes.map(lower).sort())) fail();
        const canonicalTokens = await client.rpc.read('eligible_external_inventory_market', async provider => {
            const ctf = new ethers.Contract(CONTRACTS.conditionalTokens, abi, provider);
            const options = { blockTag: walletProof.blockNumber };
            if (!(await ctf.getOutcomeSlotCount(approved.conditionId, options)).eq(2)) fail();
            return Promise.all([1, 2].map(async index => {
                const collection = await ctf.getCollectionId(ethers.constants.HashZero, approved.conditionId, index, options);
                return (await ctf.getPositionId(COLLATERAL, collection, options)).toString();
            }));
        }, walletProof.blockNumber);
        check();
        if (!isDeepStrictEqual(canonicalTokens, approved.tokens)) fail();
        const [payout, holdings] = await Promise.all([
            client.payoutAtBlock(approved.conditionId, walletProof.blockNumber),
            client.holdings(canonicalTokens, walletProof.blockNumber),
        ]);
        check();
        if (!isDeepStrictEqual(payout, approved.payout) || !Array.isArray(holdings) || holdings.length !== 2
            || !isDeepStrictEqual(holdings.map(units), expected)) fail();
        const positions = account.positions.filter(position => approved.tokens.includes(position.tokenId));
        if (new Set(positions.map(position => position.tokenId)).size !== positions.length) fail();
        for (const [index, tokenId] of approved.tokens.entries()) {
            const position = positions.find(row => row.tokenId === tokenId);
            if (expected[index] === 0n && !position) continue;
            if (!position || lower(position.conditionId) !== lower(approved.conditionId)) fail();
            const apiUnits = units(position.size);
            // Data API may truncate or round to four decimals. Only those exact
            // representations are accepted; receipt and chain units stay exact.
            if (apiUnits !== expected[index] && apiUnits !== (expected[index] / 100n) * 100n
                && apiUnits !== ((expected[index] + 50n) / 100n) * 100n) fail();
            if (position.size > 0) excludedLegacyInventory.push(structuredClone(position));
        }
        inventory.push({ ...structuredClone(approved), canonicalTokens, collateral: COLLATERAL, payout, holdings,
            receiptHashes: relevant, apiPositions: structuredClone(positions), value: 0, capitalAllocated: 0 });
    }
    if (account.positions.some(position => position.size > 0 && !owned.has(position.tokenId))) fail();
    const otherTokens = new Set();
    for (const receipt of external.receipts) {
        if (receipt.tokenIds == null && receipt.holdings == null) continue;
        if (!Array.isArray(receipt.tokenIds) || !Array.isArray(receipt.holdings)
            || receipt.tokenIds.length !== receipt.holdings.length || receipt.tokenIds.some(token => !TOKEN.test(token))
            || new Set(receipt.tokenIds).size !== receipt.tokenIds.length) fail();
        receipt.holdings.forEach(units);
        receipt.tokenIds.filter(token => !owned.has(token)).forEach(token => otherTokens.add(token));
    }
    const tokens = [...otherTokens];
    const holdings = tokens.length ? await client.holdings(tokens, walletProof.blockNumber) : [];
    check();
    if (!Array.isArray(holdings) || holdings.length !== tokens.length || holdings.some(amount => amount !== 0)) fail();
    const trades = account.checks?.find(row => row.name === 'authenticated_order_trade_api')?.detail?.trades;
    if (!Array.isArray(trades) || trades.some(trade => !record(trade)
        || (conditions.has(lower(trade.conditionId)) || owned.has(trade.assetId) || owned.has(trade.tokenId))
            && !['CONFIRMED', 'FAILED'].includes(trade.status?.replace(/^TRADE_STATUS_/, '')))) fail();
    const verifiedAt = check();
    return { account: { ...account, positions: account.positions.filter(position => !owned.has(position.tokenId)) },
        proof: { schema: 1, source: 'reviewed_manual_zero_payout_ctf', blockNumber: walletProof.blockNumber,
            blockHash: walletProof.blockHash, verifiedAt, approvalSha256: digest(approvals), inventory,
            otherManualHoldings: { tokens, holdings } }, excludedLegacyInventory };
}
