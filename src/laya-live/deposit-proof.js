import { ethers } from 'ethers';
import { CONTRACTS } from '../restart/client.js';
import { OperationalError } from '../restart/network.js';

export const CAPITAL_DEPOSIT_SCAN = Object.freeze({ chunkBlocks: 500, maxLogs: 1000, maxReceipts: 100 });
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const same = (a, b) => lower(a) === lower(b);
const hash = value => /^0x[\da-f]{64}$/i.test(value || '') && !same(value, ethers.constants.HashZero);
const address = value => /^0x[\da-f]{40}$/i.test(value || '');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const zero = ethers.constants.AddressZero, collateral = lower(CONTRACTS.collateralToken);
const protocol = new Set(Object.values(CONTRACTS).map(lower).filter(value => value !== collateral));
const reserved = new Set(Object.values(CONTRACTS).map(lower));
const underlying = new Set(['0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359']);
const erc20 = new ethers.utils.Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event Wrapped(address indexed caller,address indexed token,address indexed recipient,uint256 amount)',
]);
const transferTopic = lower(erc20.getEventTopic('Transfer'));
const wrappedTopic = lower(erc20.getEventTopic('Wrapped'));
const fail = code => { throw new OperationalError(`capital_deposit_${code}`, 'reconciliation', { stage: 'capital_deposit_proof' }); };
const eventKey = log => `${lower(log.transactionHash)}:${log.logIndex}`;

function decode(name, log) {
    try {
        const args = erc20.decodeEventLog(name, log.data, log.topics);
        const encoded = erc20.encodeEventLog(erc20.getEvent(name), [...args]);
        if (!same(encoded.data, log.data) || encoded.topics.length !== log.topics.length
            || encoded.topics.some((topic, index) => !same(topic, log.topics[index]))) fail('malformed_event');
        return args;
    } catch { fail('malformed_event'); }
}

function validLog(log) {
    if (!address(log?.address) || !hash(log.transactionHash) || !hash(log.blockHash)
        || !integer(log.blockNumber) || !integer(log.transactionIndex) || !integer(log.logIndex)
        || log.removed === true || !Array.isArray(log.topics)
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

function deltaUnits(value) {
    const scaled = value * 1e6, units = Math.round(scaled);
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(units)
        || units <= 0 || Math.abs(scaled - units) > .00001) fail('invalid_delta');
    return BigInt(units);
}

// The caller verifies receipt finality and complete wallet-log coverage first.
export function classifyCapitalDepositReceipt(receipt, wallet) {
    if (!address(wallet) || !Array.isArray(receipt?.logs)) fail('invalid_query');
    const owner = lower(wallet), ownerTopic = lower(ethers.utils.hexZeroPad(wallet, 32));
    const txHash = lower(receipt.transactionHash), entries = [];
    const walletLogs = receipt.logs.filter(log => same(log.address, collateral)
        && same(log.topics[0], transferTopic)).filter(log => {
        const args = decode('Transfer', log); return same(args.from, owner) || same(args.to, owner);
    });
    // Protocol proceeds and spending cannot become a capital contribution.
    if (receipt.logs.some(log => protocol.has(lower(log.address))
        || same(log.topics[0], transferTopic) && same(log.topics[1], ownerTopic))) fail('non_deposit_flow');
    const usedWraps = new Set(), usedFunding = new Set();
    for (const log of walletLogs) {
        const args = decode('Transfer', log), amountUnits = BigInt(args.value.toString());
        if (!same(args.to, owner) || same(args.from, owner) || amountUnits <= 0n
            || amountUnits > BigInt(Number.MAX_SAFE_INTEGER)) fail('non_deposit_flow');
        let kind = 'direct', proof = {};
        if (same(args.from, zero)) {
            const wraps = receipt.logs.filter(row => same(row.address, collateral)
                && same(row.topics[0], wrappedTopic)).map(row => ({ log: row, args: decode('Wrapped', row) }))
                .filter(row => same(row.args.recipient, owner) && row.args.amount.toString() === amountUnits.toString());
            if (wraps.length !== 1) fail('mint_unproven');
            const wrap = wraps[0];
            if (!underlying.has(lower(wrap.args.token)) || same(wrap.args.caller, zero)
                || reserved.has(lower(wrap.args.caller)) || wrap.log.logIndex <= log.logIndex
                || usedWraps.has(wrap.log.logIndex)) fail('mint_unproven');
            const funding = receipt.logs.filter(row => same(row.address, wrap.args.token)
                && same(row.topics[0], transferTopic)).map(row => ({ log: row, args: decode('Transfer', row) }))
                .filter(row => same(row.args.to, collateral) && row.args.value.toString() === amountUnits.toString()
                    && row.log.logIndex < log.logIndex && !same(row.args.from, zero)
                    && !same(row.args.from, owner) && !reserved.has(lower(row.args.from)));
            if (funding.length !== 1 || usedFunding.has(funding[0].log.logIndex)) fail('mint_unproven');
            usedWraps.add(wrap.log.logIndex); usedFunding.add(funding[0].log.logIndex);
            kind = 'wrapped'; proof = { underlyingToken: lower(wrap.args.token), wrapper: lower(wrap.args.caller),
                wrappedLogIndex: wrap.log.logIndex, fundingLogIndex: funding[0].log.logIndex };
        } else if (reserved.has(lower(args.from))) fail('non_deposit_flow');
        entries.push({ txHash, logIndex: log.logIndex, from: lower(args.from), amount: Number(amountUnits) / 1e6,
            amountUnits: amountUnits.toString(), blockNumber: log.blockNumber, blockHash: lower(log.blockHash),
            token: collateral, wallet: owner, kind, ...proof });
    }
    return entries;
}

// The balance surplus only determines the required total. Each contribution
// must independently identify a canonical, external incoming token movement.
export async function discoverCapitalDeposits(client, { wallet, from, to, knownHashes = [], expectedDelta } = {}) {
    const required = deltaUnits(expectedDelta);
    if (!address(wallet) || same(wallet, zero) || reserved.has(lower(wallet))
        || !integer(from?.blockNumber) || !hash(from?.blockHash)
        || !integer(to?.blockNumber) || !hash(to?.blockHash) || from.blockNumber >= to.blockNumber
        || !Array.isArray(knownHashes) || knownHashes.some(value => !hash(value))
        || typeof client?.rpc?.read !== 'function' || typeof client.rpc.validate !== 'function'
        || typeof client.verifiedReceipt !== 'function') fail('invalid_query');
    const start = { number: from.blockNumber, hash: lower(from.blockHash) };
    const end = { number: to.blockNumber, hash: lower(to.blockHash) };
    const owner = lower(wallet), ownerTopic = lower(ethers.utils.hexZeroPad(wallet, 32));
    const known = new Set(knownHashes.map(lower));
    const guard = () => {
        if (client.rpc.anchor?.number !== end.number || !same(client.rpc.anchor?.hash, end.hash)) fail('snapshot_changed');
    };
    const pinned = async (task, key) => {
        guard();
        const result = await client.rpc.read('capital_deposit_proof', task, end.number, key);
        guard(); return result;
    };
    async function checkAnchors() {
        await pinned(provider => client.rpc.validate(provider, end), 'capital_deposit_chain');
        for (const anchor of [start, end]) {
            const block = await pinned(provider => provider.getBlock(anchor.number), `capital_deposit_block:${anchor.number}`);
            if (block?.number !== anchor.number || !same(block.hash, anchor.hash)) fail('anchor_changed');
        }
    }
    await checkAnchors();
    const found = new Map();
    for (let first = start.number + 1; first <= end.number; first += CAPITAL_DEPOSIT_SCAN.chunkBlocks) {
        const last = Math.min(end.number, first + CAPITAL_DEPOSIT_SCAN.chunkBlocks - 1);
        for (const direction of ['incoming', 'outgoing']) {
            const topics = direction === 'incoming' ? [transferTopic, null, ownerTopic] : [transferTopic, ownerTopic];
            const logs = await pinned(provider => provider.getLogs({ address: collateral, topics,
                fromBlock: first, toBlock: last }), `capital_deposit_logs:${direction}:${first}:${last}`);
            if (!Array.isArray(logs) || logs.length >= CAPITAL_DEPOSIT_SCAN.maxLogs
                || found.size + logs.length > CAPITAL_DEPOSIT_SCAN.maxLogs) fail('scan_limit');
            for (const raw of logs) {
                const log = validLog(raw), args = decode('Transfer', log);
                if (!same(log.address, collateral) || log.blockNumber < first || log.blockNumber > last
                    || !same(direction === 'incoming' ? args.to : args.from, owner)) fail('log_filter_mismatch');
                if (found.has(eventKey(log))) fail('duplicate_log');
                found.set(eventKey(log), log);
            }
        }
    }
    const hashes = [...new Set([...found.values()].map(log => lower(log.transactionHash)))];
    if (hashes.length > CAPITAL_DEPOSIT_SCAN.maxReceipts) fail('scan_limit');
    const entries = [];
    for (const txHash of hashes) {
        guard();
        const receipt = await client.verifiedReceipt(txHash, end.number);
        guard();
        if (!receipt || receipt.status !== 1 || !same(receipt.transactionHash, txHash)
            || !integer(receipt.blockNumber) || receipt.blockNumber <= start.number || receipt.blockNumber > end.number
            || !hash(receipt.blockHash) || !integer(receipt.transactionIndex)
            || !integer(receipt.confirmations) || receipt.confirmations < 2 || !Array.isArray(receipt.logs)) fail('receipt_unconfirmed');
        const header = await pinned(provider => provider.getBlock(receipt.blockNumber), `capital_deposit_receipt_block:${receipt.blockNumber}`);
        if (header?.number !== receipt.blockNumber || !same(header.hash, receipt.blockHash)) fail('receipt_reorg');
        const indices = new Set();
        for (const log of receipt.logs) {
            validLog(log);
            if (!same(log.transactionHash, txHash) || !same(log.blockHash, receipt.blockHash)
                || log.blockNumber !== receipt.blockNumber || log.transactionIndex !== receipt.transactionIndex
                || indices.has(log.logIndex)) fail('receipt_log_mismatch');
            indices.add(log.logIndex);
        }
        const walletLogs = receipt.logs.filter(log => same(log.address, collateral)
            && same(log.topics[0], transferTopic)).filter(log => {
            const args = decode('Transfer', log); return same(args.from, owner) || same(args.to, owner);
        });
        const scanned = [...found.values()].filter(log => same(log.transactionHash, txHash));
        if (walletLogs.length !== scanned.length || walletLogs.some(log => !found.has(eventKey(log))
            || !sameLog(log, found.get(eventKey(log))))) fail('receipt_log_mismatch');
        if (known.has(txHash)) continue;
        entries.push(...classifyCapitalDepositReceipt(receipt, wallet));
    }
    if (!entries.length || entries.reduce((sum, entry) => sum + BigInt(entry.amountUnits), 0n) !== required) fail('amount_mismatch');
    await checkAnchors();
    return entries.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}
