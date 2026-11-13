import { ethers } from 'ethers';
import { CONTRACTS } from '../restart/client.js';
import { OperationalError } from '../restart/network.js';
import { classifyCapitalDepositReceipt } from './deposit-proof.js';

// Keep backlog scans within the range accepted by the fallback RPC provider.
export const EXTERNAL_ACTIVITY_SCAN = Object.freeze({ chunkBlocks: 100, maxLogs: 1000, maxReceipts: 100, maxTokens: 512 });
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const same = (a, b) => lower(a) === lower(b);
const hash = value => /^0x[\da-f]{64}$/i.test(value || '') && !same(value, ethers.constants.HashZero);
const address = value => /^0x[\da-f]{40}$/i.test(value || '');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
    && value.length <= 78 && BigInt(value) <= (1n << 256n) - 1n;
const collateral = lower(CONTRACTS.collateralToken), conditional = lower(CONTRACTS.conditionalTokens);
const reserved = new Set(Object.values(CONTRACTS).map(lower));
const max = BigInt(Number.MAX_SAFE_INTEGER);
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);
const transferTopic = lower(erc20.getEventTopic('Transfer'));
const singleTopic = lower(ctf.getEventTopic('TransferSingle')), batchTopic = lower(ctf.getEventTopic('TransferBatch'));
const eventKey = log => `${lower(log.transactionHash)}:${log.logIndex}`;
const fail = code => { throw new OperationalError(`external_activity_${code}`, 'reconciliation', { stage: 'external_activity_proof' }); };
const amount = units => {
    if (units > max || units < -max) fail('amount_overflow');
    return Number(units) / 1e6;
};

function validLog(log) {
    if (!address(log?.address) || !hash(log.transactionHash) || !hash(log.blockHash)
        || !integer(log.blockNumber) || !integer(log.transactionIndex) || !integer(log.logIndex)
        || log.removed === true || !Array.isArray(log.topics) || !log.topics.length
        || log.topics.some(topic => !/^0x[\da-f]{64}$/i.test(topic || ''))
        || !/^0x(?:[\da-f]{2})*$/i.test(log.data || '')) fail('malformed_log');
    return log;
}

function sameLog(a, b) {
    return same(a.address, b.address) && same(a.transactionHash, b.transactionHash)
        && same(a.blockHash, b.blockHash) && a.blockNumber === b.blockNumber
        && a.transactionIndex === b.transactionIndex && a.logIndex === b.logIndex
        && same(a.data, b.data) && a.topics.length === b.topics.length
        && a.topics.every((topic, index) => same(topic, b.topics[index]));
}

function movementEvent(log) {
    const cash = same(log.address, collateral) && same(log.topics[0], transferTopic);
    const single = same(log.address, conditional) && same(log.topics[0], singleTopic);
    const batch = same(log.address, conditional) && same(log.topics[0], batchTopic);
    if (!cash && !single && !batch) return null;
    const abi = cash ? erc20 : ctf, name = cash ? 'Transfer' : single ? 'TransferSingle' : 'TransferBatch';
    let args;
    try {
        args = abi.decodeEventLog(name, log.data, log.topics);
        const encoded = abi.encodeEventLog(abi.getEvent(name), [...args]);
        if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length
            || encoded.topics.some((topic, index) => !same(topic, log.topics[index]))) fail('malformed_event');
    } catch { fail('malformed_event'); }
    const tokenIds = cash ? [] : (batch ? args.ids : [args.id]).map(String);
    const values = cash ? [args.value] : batch ? args[4] : [args.value];
    if (!cash && (tokenIds.length !== values.length || tokenIds.some(id => !token(id))
        || new Set(tokenIds).size !== tokenIds.length)) fail('malformed_event');
    if (tokenIds.length > EXTERNAL_ACTIVITY_SCAN.maxTokens) fail('scan_limit');
    const quantities = values.map(value => BigInt(value.toString()));
    quantities.forEach(amount);
    return { cash, from: lower(args.from), to: lower(args.to), tokenIds, values: quantities };
}

// Cash and ERC1155 movements are discovered independently: a losing-token burn
// or a buy/sell round trip can change inventory without changing net wallet cash.
export async function discoverExternalActivity(client, { wallet, from, to, knownHashes = [], botTokens = [], botOrderIds = [] } = {}) {
    if (!address(wallet) || same(wallet, ethers.constants.AddressZero) || reserved.has(lower(wallet))
        || !integer(from?.blockNumber) || !hash(from?.blockHash)
        || !integer(to?.blockNumber) || !hash(to?.blockHash) || from.blockNumber > to.blockNumber
        || from.blockNumber === to.blockNumber && !same(from.blockHash, to.blockHash)
        || !Array.isArray(knownHashes) || knownHashes.some(value => !hash(value))
        || !Array.isArray(botTokens) || botTokens.some(value => !token(value))
        || !Array.isArray(botOrderIds) || botOrderIds.some(value => !hash(value))
        || typeof client?.rpc?.read !== 'function' || typeof client.rpc.validate !== 'function'
        || typeof client.verifiedReceipt !== 'function') fail('invalid_query');
    const start = { number: from.blockNumber, hash: lower(from.blockHash) };
    const end = { number: to.blockNumber, hash: lower(to.blockHash) };
    const owner = lower(wallet), ownerTopic = lower(ethers.utils.hexZeroPad(wallet, 32));
    const known = new Set(knownHashes.map(lower)), ownedTokens = new Set(botTokens), ownedOrders = new Set(botOrderIds.map(lower));
    const guard = () => {
        if (client.rpc.anchor?.number !== end.number || !same(client.rpc.anchor?.hash, end.hash)) fail('snapshot_changed');
    };
    const pinned = async (task, key) => {
        guard();
        const result = await client.rpc.read('external_activity_proof', task, end.number, key);
        guard(); return result;
    };
    const checkAnchors = async () => {
        await pinned(provider => client.rpc.validate(provider, end), 'external_activity_chain');
        for (const anchor of [start, end]) {
            const block = await pinned(provider => provider.getBlock(anchor.number), `external_activity_block:${anchor.number}`);
            if (block?.number !== anchor.number || !same(block.hash, anchor.hash)) fail('anchor_changed');
        }
    };
    await checkAnchors();
    const scans = [
        { kind: 'cash_in', contract: collateral, incoming: true, topics: [transferTopic, null, ownerTopic] },
        { kind: 'cash_out', contract: collateral, incoming: false, topics: [transferTopic, ownerTopic] },
        { kind: 'ctf_in', contract: conditional, incoming: true, topics: [[singleTopic, batchTopic], null, null, ownerTopic] },
        { kind: 'ctf_out', contract: conditional, incoming: false, topics: [[singleTopic, batchTopic], null, ownerTopic] },
    ];
    const found = new Map(), directions = new Map();
    for (let first = start.number + 1; first <= end.number; first += EXTERNAL_ACTIVITY_SCAN.chunkBlocks) {
        const last = Math.min(end.number, first + EXTERNAL_ACTIVITY_SCAN.chunkBlocks - 1);
        const pages = await Promise.all(scans.map(scan => pinned(provider => provider.getLogs({
            address: scan.contract, topics: scan.topics, fromBlock: first, toBlock: last,
        }), `external_activity_logs:${scan.kind}:${first}:${last}`)));
        for (const [index, logs] of pages.entries()) {
            const scan = scans[index], pageIds = new Set();
            if (!Array.isArray(logs) || logs.length >= EXTERNAL_ACTIVITY_SCAN.maxLogs) fail('scan_limit');
            for (const raw of logs) {
                const log = validLog(raw), event = movementEvent(log), key = eventKey(log);
                if (!event || !same(log.address, scan.contract) || log.blockNumber < first || log.blockNumber > last
                    || (scan.incoming ? event.to : event.from) !== owner) fail('log_filter_mismatch');
                if (pageIds.has(key)) fail('duplicate_log');
                pageIds.add(key);
                if (!directions.has(key)) directions.set(key, new Set());
                if (directions.get(key).has(scan.kind)) fail('duplicate_log');
                directions.get(key).add(scan.kind);
                const previous = found.get(key);
                if (previous) {
                    // A self-transfer appears in both directions, but only once
                    // in the receipt and in the resulting accounting.
                    if (event.from !== owner || event.to !== owner || !sameLog(previous, log)) fail('duplicate_log');
                } else found.set(key, log);
                if (found.size > EXTERNAL_ACTIVITY_SCAN.maxLogs) fail('scan_limit');
            }
        }
    }
    for (const [key, log] of found) {
        const event = movementEvent(log);
        if (event.from === owner && event.to === owner && directions.get(key).size !== 2) fail('receipt_log_mismatch');
    }
    const hashes = [...new Set([...found.values()].map(log => lower(log.transactionHash)))];
    if (hashes.length > EXTERNAL_ACTIVITY_SCAN.maxReceipts) fail('scan_limit');
    const receipts = [], deposits = [], totals = new Map();
    let externalCash = 0n, depositCash = 0n;
    for (const txHash of hashes) {
        guard();
        const receipt = await client.verifiedReceipt(txHash, end.number);
        guard();
        if (!receipt || receipt.status !== 1 || !same(receipt.transactionHash, txHash)
            || !integer(receipt.blockNumber) || receipt.blockNumber <= start.number || receipt.blockNumber > end.number
            || !hash(receipt.blockHash) || !integer(receipt.transactionIndex)
            || !integer(receipt.confirmations) || receipt.confirmations < 2 || !Array.isArray(receipt.logs)) fail('receipt_unconfirmed');
        const header = await pinned(provider => provider.getBlock(receipt.blockNumber), `external_activity_receipt_block:${receipt.blockNumber}`);
        if (header?.number !== receipt.blockNumber || !same(header.hash, receipt.blockHash)) fail('receipt_reorg');
        const walletLogs = [], events = [];
        let lastIndex = -1;
        for (const log of receipt.logs) {
            validLog(log);
            if (!same(log.transactionHash, txHash) || !same(log.blockHash, receipt.blockHash)
                || log.blockNumber !== receipt.blockNumber || log.transactionIndex !== receipt.transactionIndex
                || log.logIndex <= lastIndex) fail('receipt_log_mismatch');
            lastIndex = log.logIndex;
            const event = movementEvent(log);
            if (event && (event.from === owner || event.to === owner)) { walletLogs.push(log); events.push(event); }
        }
        const scanned = [...found.values()].filter(log => same(log.transactionHash, txHash));
        if (!walletLogs.length || walletLogs.length !== scanned.length || walletLogs.some(log => !found.has(eventKey(log))
            || !sameLog(log, found.get(eventKey(log))))) fail('receipt_log_mismatch');
        if (known.has(txHash)) continue;
        if (events.some(event => event.tokenIds.some(id => ownedTokens.has(id)))
            || receipt.logs.some(log => log.topics.slice(1).some(topic => ownedOrders.has(lower(topic)))
                || ownedOrders.size && (log.data.slice(2).match(/.{64}/g) || []).some(word => ownedOrders.has(`0x${word.toLowerCase()}`))))
            fail('bot_overlap');
        let cash = 0n;
        const holdings = new Map();
        for (const event of events) {
            const sign = BigInt(Number(event.to === owner) - Number(event.from === owner));
            if (event.cash) cash += sign * event.values[0];
            else event.tokenIds.forEach((id, index) => holdings.set(id, (holdings.get(id) || 0n) + sign * event.values[index]));
        }
        amount(cash); holdings.forEach(amount);
        let contributions = [];
        try { contributions = classifyCapitalDepositReceipt(receipt, owner); }
        catch (error) {
            if (!['capital_deposit_non_deposit_flow', 'capital_deposit_mint_unproven'].includes(error.code)) throw error;
        }
        if (contributions.length) {
            const total = contributions.reduce((sum, entry) => sum + BigInt(entry.amountUnits), 0n);
            if (holdings.size || total !== cash) fail('deposit_movement_mismatch');
            depositCash += total; amount(depositCash); deposits.push(...contributions);
        } else {
            const tokenIds = [...holdings.keys()];
            receipts.push({ hash: txHash, blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash),
                cash: amount(cash), tokenIds, holdings: tokenIds.map(id => amount(holdings.get(id))) });
            externalCash += cash; amount(externalCash);
            for (const [id, value] of holdings) { totals.set(id, (totals.get(id) || 0n) + value); amount(totals.get(id)); }
            if (totals.size > EXTERNAL_ACTIVITY_SCAN.maxTokens) fail('scan_limit');
        }
    }
    await checkAnchors();
    receipts.sort((a, b) => a.blockNumber - b.blockNumber || a.hash.localeCompare(b.hash));
    deposits.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return { receipts, externalCashDelta: amount(externalCash), tokenIds: [...totals.keys()],
        holdingsDeltas: [...totals].map(([tokenId, value]) => ({ tokenId, amount: amount(value) })),
        deposits, depositAmount: amount(depositCash), checkpoint: { blockNumber: end.number, blockHash: end.hash } };
}
