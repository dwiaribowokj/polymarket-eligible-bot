import { ethers } from 'ethers';
import { BRIDGE, BRIDGE_MAX_OUTPUT_UNITS, verifyBridgeDestinationReceipt } from './profit-bridge.js';
import { OperationalError } from '../restart/network.js';
import { setTimeout as sleep } from 'node:timers/promises';

// Bridge status currently reports ERC-4337 user operation hashes. Resolve those
// through canonical events, then correlate the Relay deposit with its fill's
// calldata. Neither a nearby transfer nor a provider's COMPLETED status is proof.
export const BRIDGE_RESOLUTION = Object.freeze({
    entryPoint: '0x4337084d9e255ff0702461cf8895ce9e3b5ff108',
    intermediateToken: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    depository: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
    chunkBlocks: 100, maxScanBlocks: 10000, maxLogs: 1000, budgetMs: 30000,
});
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const address = value => /^0x[\da-f]{40}$/i.test(value || '') && lower(value) !== ethers.constants.AddressZero;
const hash = value => /^0x[\da-f]{64}$/i.test(value || '') && lower(value) !== ethers.constants.HashZero;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => lower(a) === lower(b);
const fail = code => { throw new OperationalError(code, 'reconciliation', { stage: 'bridge_correlation' }); };
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)',
    'function transferFrom(address from,address to,uint256 amount)']);
const events = new ethers.utils.Interface([
    'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
    'event RelayErc20Deposit(address from,address token,uint256 amount,bytes32 id)',
]);
const transferTopic = erc20.getEventTopic('Transfer').toLowerCase();
const userTopic = events.getEventTopic('UserOperationEvent').toLowerCase();
const relayTopic = events.getEventTopic('RelayErc20Deposit').toLowerCase();
const topicAddress = value => ethers.utils.hexZeroPad(value, 32).toLowerCase();
const position = (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || (a.logIndex ?? -1) - (b.logIndex ?? -1);

// This public endpoint supplies the provider's authoritative input/output
// mapping. The ERC20 contract ignores a trailing order id, so calldata tagging
// alone must never authenticate a payment. Relay v2 retires on 2026-11-24;
// unavailable metadata deliberately leaves the withdrawal unresolved.
async function lookupRelayDeposit(depositHash) {
    let lastRetryAfter, lastStatus;
    for (let attempt = 0; attempt < 2; attempt++) {
        let response;
        try {
            response = await fetch(`https://api.relay.link/requests/v2?hash=${depositHash}`, {
                method: 'GET', redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
            if (response.ok) return await response.json();
        } catch { /* A public read may be retried once; no write is involved. */ }
        lastStatus = response?.status;
        const retryable = !response || response.status === 429 || response.status >= 500;
        const retryHeader = response?.headers?.get('retry-after');
        const retryAfter = retryHeader ? (/^\d+(?:\.\d+)?$/.test(retryHeader)
            ? Number(retryHeader) * 1000 : Math.max(0, Date.parse(retryHeader) - Date.now())) : 500;
        if (retryHeader && Number.isFinite(retryAfter) && retryAfter >= 0) lastRetryAfter = retryAfter / 1000;
        if (!retryable || attempt === 1) break;
        // A longer server-directed wait is handled by the next reconciliation
        // pass. Never retry earlier than the provider permits.
        if (!Number.isFinite(retryAfter) || retryAfter > 1000) break;
        await sleep(Math.max(500, retryAfter));
    }
    throw new OperationalError('bridge_relay_mapping_unavailable', lastStatus === 429 ? 'rate_limit' : 'reconciliation', {
        stage: 'bridge_correlation', ...(lastRetryAfter === undefined ? {} : { retryAfter: lastRetryAfter }),
        ...(lastStatus === undefined ? {} : { httpStatus: lastStatus }) });
}

function relayMapping(response, operation, recipient, deposit, orderId) {
    if (!response || !Array.isArray(response.requests) || response.requests.length !== 1)
        fail('bridge_relay_mapping_unavailable');
    const request = response.requests[0], data = request?.data, metadata = data?.metadata, protocol = request?.protocol;
    const input = metadata?.currencyIn, output = metadata?.currencyOut;
    const currency = (value, token) => value?.currency?.chainId === 137 && same(value.currency.address, token)
        && value.currency.decimals === 6 && /^\d+$/.test(value.amount || '');
    const tx = (value, txHash) => value?.chainId === 137 && value.status === 'success' && same(value.hash, txHash);
    const origin = protocol?.deposit?.origin, fills = protocol?.settlement?.destination?.fills;
    if (!hash(request?.id) || request.status !== 'success' || !same(request.user, operation.address)
        || !same(request.recipient, recipient) || !same(metadata?.sender, operation.address) || !same(metadata?.recipient, recipient)
        || !currency(input, BRIDGE_RESOLUTION.intermediateToken) || input.amount !== '5000000'
        || !currency(output, BRIDGE.destinationToken) || BigInt(output.amount) < 1n
        || BigInt(output.amount) > BigInt(BRIDGE_MAX_OUTPUT_UNITS)
        || !Array.isArray(data.inTxs) || data.inTxs.length !== 1 || !tx(data.inTxs[0], deposit.transactionHash)
        || data.inTxs[0].block !== deposit.blockNumber || !Array.isArray(data.outTxs) || data.outTxs.length !== 1
        || !hash(data.outTxs[0]?.hash) || !tx(data.outTxs[0], data.outTxs[0].hash) || !integer(data.outTxs[0].block)
        || data.outTxs[0].block < deposit.blockNumber
        || !same(protocol?.orderId, orderId) || origin?.chainId !== 137 || origin.amount !== '5000000'
        || !same(origin.currency, BRIDGE_RESOLUTION.intermediateToken) || !same(origin.depositor, operation.address)
        || !same(origin.depository, BRIDGE_RESOLUTION.depository) || !same(origin.transactionId, deposit.transactionHash)
        || !Array.isArray(fills) || fills.length !== 1 || fills[0].chainId !== 137
        || !same(fills[0].transactionId, data.outTxs[0].hash)) fail('bridge_relay_mapping_mismatch');
    return { requestId: lower(request.id), destinationHash: lower(data.outTxs[0].hash),
        destinationBlock: data.outTxs[0].block, destinationAmountUnits: output.amount };
}

function decode(iface, name, log) {
    try {
        const args = iface.parseLog(log).args, encoded = iface.encodeEventLog(iface.getEvent(name), [...args]);
        if (!same(log.data, encoded.data) || encoded.topics.length !== log.topics.length
            || encoded.topics.some((topic, i) => !same(topic, log.topics[i]))) fail('bridge_correlation_malformed_event');
        return args;
    } catch (error) {
        if (error instanceof OperationalError) throw error;
        fail('bridge_correlation_malformed_event');
    }
}

function receiptShape(receipt, expectedHash, block) {
    if (!receipt || receipt.status !== 1 || !same(receipt.transactionHash, expectedHash)
        || !hash(receipt.blockHash) || !integer(receipt.blockNumber) || receipt.blockNumber > block
        || !integer(receipt.transactionIndex) || !integer(receipt.confirmations) || receipt.confirmations < 2
        || receipt.chainId !== undefined && receipt.chainId !== 137 || !Array.isArray(receipt.logs))
        fail('bridge_correlation_receipt_unproven');
    let previous = -1;
    for (const log of receipt.logs) {
        if (!address(log?.address) || !integer(log.logIndex) || log.logIndex <= previous || log.removed === true
            || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some(value => !/^0x[\da-f]{64}$/i.test(value))
            || !/^0x(?:[\da-f]{2})*$/i.test(log.data || '') || !same(log.transactionHash, receipt.transactionHash)
            || !same(log.blockHash, receipt.blockHash) || log.blockNumber !== receipt.blockNumber
            || log.transactionIndex !== receipt.transactionIndex) fail('bridge_correlation_malformed_receipt');
        previous = log.logIndex;
    }
    return receipt;
}

function transfers(receipt, token) {
    return receipt.logs.filter(log => same(log.address, token) && same(log.topics[0], transferTopic))
        .map(log => ({ ...decode(erc20, 'Transfer', log), log }));
}

function exactTransfer(receipt, token, from, to, amount) {
    const relevant = transfers(receipt, token).filter(row => same(row.from, from) || same(row.to, to));
    if (relevant.length !== 1 || !same(relevant[0].from, from) || !same(relevant[0].to, to)
        || relevant[0].value.toString() !== amount) fail('bridge_correlation_token_flow_mismatch');
    return relevant[0].log;
}

function userOperation(receipt, operationHash, withdrawalAddress) {
    const logs = receipt.logs.filter(log => same(log.address, BRIDGE_RESOLUTION.entryPoint)
        && same(log.topics[0], userTopic) && same(log.topics[1], operationHash));
    if (logs.length !== 1) fail('bridge_correlation_user_operation_ambiguous');
    const args = decode(events, 'UserOperationEvent', logs[0]);
    if (!same(args.sender, withdrawalAddress) || args.success !== true)
        fail('bridge_correlation_user_operation_failed');
    return logs[0];
}

function rowIdentity(row, operation, recipient, sourceToken) {
    if (!row || row.status !== 'COMPLETED' || !hash(row.transactionHash)
        || !same(row.sourceHash, operation.transfer.hash) || !same(row.address, operation.address)
        || !same(row.wallet, operation.quote.wallet) || !same(row.recipient, recipient) || row.amountUnits !== '5000000'
        || row.sourceToken !== undefined && !same(row.sourceToken, sourceToken)
        || row.destinationToken !== undefined && !same(row.destinationToken, BRIDGE.destinationToken)
        || row.chainId !== undefined && row.chainId !== 137)
        fail('bridge_correlation_status_identity_mismatch');
}

export async function resolveBridgeDestination({ client, operation, primary, intermediates, block, recipient, sourceReceipt,
    relayLookup = lookupRelayDeposit } = {}) {
    const deadline = Date.now() + BRIDGE_RESOLUTION.budgetMs;
    const checkBudget = () => { if (Date.now() >= deadline) fail('bridge_correlation_budget_exceeded'); };
    if (!client?.rpc?.read || typeof client.verifiedReceipt !== 'function' || !integer(block)
        || !address(operation?.address) || !address(operation?.quote?.wallet) || !address(recipient)
        || !hash(operation?.transfer?.hash) || !same(operation.quote.recipient, recipient)
        || !same(operation.quote.sourceToken, BRIDGE.sourceToken) || !same(operation.quote.destinationToken, BRIDGE.destinationToken)
        || operation.quote.chainId !== 137 || operation.quote.amountUnits !== '5000000'
        || operation.transfer.amount !== 5 || !same(operation.transfer.token, BRIDGE.sourceToken)
        || !same(operation.transfer.recipient, operation.address)) fail('bridge_correlation_invalid_operation');
    if (!Array.isArray(intermediates) || intermediates.length !== 1) fail('bridge_correlation_intermediate_ambiguous');
    const intermediate = intermediates[0];
    rowIdentity(primary, operation, recipient, BRIDGE.sourceToken);
    rowIdentity(intermediate, operation, recipient, BRIDGE_RESOLUTION.intermediateToken);
    if (!same(intermediate.sourceToken, BRIDGE_RESOLUTION.intermediateToken)
        || same(primary.transactionHash, intermediate.transactionHash)) fail('bridge_correlation_status_identity_mismatch');
    const pinned = async (task, key = 'bridge_correlation') => {
        checkBudget();
        const result = await client.rpc.read('bridge_correlation', async provider => { checkBudget(); return task(provider); }, block, key);
        checkBudget(); return result;
    };
    async function canonicalReceipt(txHash, supplied) {
        checkBudget();
        const receipt = receiptShape(await client.verifiedReceipt(txHash, block), txHash, block);
        checkBudget();
        if (supplied && (!same(supplied.blockHash, receipt.blockHash) || supplied.blockNumber !== receipt.blockNumber
            || supplied.transactionIndex !== receipt.transactionIndex || !same(supplied.transactionHash, receipt.transactionHash)))
            fail('bridge_correlation_source_changed');
        const header = await pinned(provider => provider.getBlock(receipt.blockNumber), `bridge_block:${receipt.blockNumber}`);
        if (header?.number !== receipt.blockNumber || !same(header.hash, receipt.blockHash)) fail('bridge_correlation_reorg');
        return receipt;
    }
    receiptShape(sourceReceipt, operation.transfer.hash, block);
    const source = await canonicalReceipt(operation.transfer.hash, sourceReceipt);
    const sourceLog = exactTransfer(source, BRIDGE.sourceToken, operation.quote.wallet, operation.address, '5000000');
    if (block - source.blockNumber + 1 > BRIDGE_RESOLUTION.maxScanBlocks) fail('bridge_correlation_scan_limit');
    async function scan(filter, fromBlock, toBlock) {
        const logs = [];
        // ethers v5 accepts one address per getLogs call. Keep one shared
        // result limit across the separate token requests and block pages.
        const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
        for (let start = fromBlock; start <= toBlock; start += BRIDGE_RESOLUTION.chunkBlocks) {
            const end = Math.min(toBlock, start + BRIDGE_RESOLUTION.chunkBlocks - 1);
            for (const scanAddress of addresses) {
                const request = { ...filter, address: scanAddress, fromBlock: start, toBlock: end };
                const page = await pinned(provider => provider.getLogs(request),
                    `bridge_logs:${JSON.stringify(request)}`);
                if (!Array.isArray(page) || page.length >= BRIDGE_RESOLUTION.maxLogs
                    || logs.length + page.length > BRIDGE_RESOLUTION.maxLogs) fail('bridge_correlation_scan_limit');
                for (const log of page) {
                    if (!integer(log?.blockNumber) || log.blockNumber < start || log.blockNumber > end || !hash(log.transactionHash)
                        || !hash(log.blockHash) || !integer(log.transactionIndex) || !integer(log.logIndex) || log.removed === true)
                        fail('bridge_correlation_malformed_log');
                    logs.push(log);
                }
            }
        }
        return logs;
    }
    const operationLogs = await scan({ address: BRIDGE_RESOLUTION.entryPoint,
        topics: [userTopic, [primary.transactionHash, intermediate.transactionHash], topicAddress(operation.address)] }, source.blockNumber, block);
    const lookup = async row => {
        const found = operationLogs.filter(log => same(log.address, BRIDGE_RESOLUTION.entryPoint)
            && same(log.topics?.[0], userTopic) && same(log.topics?.[1], row.transactionHash));
        if (found.length !== 1) fail('bridge_correlation_user_operation_ambiguous');
        const receipt = await canonicalReceipt(found[0].transactionHash);
        const log = userOperation(receipt, row.transactionHash, operation.address);
        if (log.logIndex !== found[0].logIndex || !same(log.blockHash, found[0].blockHash)
            || !same(log.data, found[0].data) || JSON.stringify(log.topics.map(lower)) !== JSON.stringify(found[0].topics.map(lower)))
            fail('bridge_correlation_log_changed');
        return { receipt, log };
    };
    const unwrap = await lookup(primary), deposit = await lookup(intermediate);
    if (position(source, unwrap.receipt) >= 0 || position(unwrap.receipt, deposit.receipt) >= 0)
        fail('bridge_correlation_order_mismatch');
    exactTransfer(unwrap.receipt, BRIDGE.sourceToken, operation.address, BRIDGE.sourceToken, '5000000');
    exactTransfer(unwrap.receipt, BRIDGE.sourceToken, BRIDGE.sourceToken, ethers.constants.AddressZero, '5000000');
    const releases = transfers(unwrap.receipt, BRIDGE_RESOLUTION.intermediateToken).filter(row => same(row.to, operation.address));
    if (releases.length !== 1 || releases[0].value.toString() !== '5000000' || !address(releases[0].from))
        fail('bridge_correlation_token_flow_mismatch');
    const depositLog = exactTransfer(deposit.receipt, BRIDGE_RESOLUTION.intermediateToken,
        operation.address, BRIDGE_RESOLUTION.depository, '5000000');
    const requests = deposit.receipt.logs.filter(log => same(log.address, BRIDGE_RESOLUTION.depository) && same(log.topics[0], relayTopic));
    if (requests.length !== 1) fail('bridge_correlation_relay_deposit_ambiguous');
    const request = decode(events, 'RelayErc20Deposit', requests[0]);
    if (!same(request.from, operation.address) || !same(request.token, BRIDGE_RESOLUTION.intermediateToken)
        || request.amount.toString() !== '5000000' || !hash(request.id)) fail('bridge_correlation_relay_deposit_mismatch');
    let providerResponse;
    try { checkBudget(); providerResponse = await relayLookup(lower(deposit.receipt.transactionHash)); checkBudget(); }
    catch (error) {
        if (error instanceof OperationalError) throw error;
        fail('bridge_relay_mapping_unavailable');
    }
    const providerMapping = relayMapping(providerResponse, operation, recipient, deposit.receipt, request.id);
    // Extra funds entering/leaving this withdrawal address make fungible-token
    // provenance ambiguous. Require the four exact movements of this operation.
    const flowFilters = [[transferTopic, topicAddress(operation.address)], [transferTopic, null, topicAddress(operation.address)]];
    const flow = [];
    for (const topics of flowFilters) flow.push(...await scan({ address: [BRIDGE.sourceToken, BRIDGE_RESOLUTION.intermediateToken], topics },
        source.blockNumber, deposit.receipt.blockNumber));
    const expectedFlow = new Map([sourceLog, ...transfers(unwrap.receipt, BRIDGE.sourceToken).filter(row => same(row.from, operation.address)).map(row => row.log),
        releases[0].log, depositLog].map(log => [`${lower(log.transactionHash)}:${log.logIndex}`, log]));
    const observedFlow = new Set();
    for (const log of flow.filter(log => position(log, sourceLog) >= 0 && position(log, depositLog) <= 0)) {
        if (![BRIDGE.sourceToken, BRIDGE_RESOLUTION.intermediateToken].some(token => same(token, log.address))) fail('bridge_correlation_token_flow_mismatch');
        const args = decode(erc20, 'Transfer', log);
        if (!same(args.from, operation.address) && !same(args.to, operation.address)) fail('bridge_correlation_token_flow_mismatch');
        const key = `${lower(log.transactionHash)}:${log.logIndex}`;
        const expected = expectedFlow.get(key);
        if (!expected) fail('bridge_correlation_token_flow_ambiguous');
        if (!same(log.address, expected.address) || !same(log.blockHash, expected.blockHash) || !same(log.data, expected.data)
            || JSON.stringify(log.topics.map(lower)) !== JSON.stringify(expected.topics.map(lower))) fail('bridge_correlation_log_changed');
        observedFlow.add(key);
    }
    if (expectedFlow.size !== 4 || observedFlow.size !== expectedFlow.size) fail('bridge_correlation_token_flow_incomplete');
    // The provider names exactly one output transaction. Read that transaction
    // directly; a recipient-wide transfer scan adds no identity evidence.
    if (providerMapping.destinationBlock > block) fail('bridge_correlation_fill_unconfirmed');
    const txHash = providerMapping.destinationHash;
    const tx = await pinned(provider => provider.getTransaction(txHash), `bridge_tx:${txHash}`);
    const data = lower(tx?.data ?? tx?.input);
    // transferFrom's standard ABI ignores the trailing Relay order id. Its
    // presence alone is not enough: provider mapping and receipt are required.
    if (!tx || !same(tx.hash, txHash) || tx.chainId !== 137 || !same(tx.to, BRIDGE.destinationToken)
        || data.length !== 2 + 8 + 64 * 4 || data.slice(0, 10) !== erc20.getSighash('transferFrom')
        || !data.endsWith(lower(request.id).slice(2))) fail('bridge_correlation_fill_malformed');
    let args;
    try {
        if (!ethers.BigNumber.from(tx.value ?? 0).isZero()) fail('bridge_correlation_fill_malformed');
        args = erc20.decodeFunctionData('transferFrom', data.slice(0, 2 + 8 + 64 * 3));
    } catch { fail('bridge_correlation_fill_malformed'); }
    if (!address(args.from) || !same(args.to, recipient) || args.amount.isZero() || args.amount.gt(BRIDGE_MAX_OUTPUT_UNITS)
        || args.amount.toString() !== providerMapping.destinationAmountUnits)
        fail('bridge_correlation_fill_mismatch');
    const destination = await canonicalReceipt(txHash);
    if (position(destination, deposit.receipt) <= 0 || providerMapping.destinationBlock !== destination.blockNumber || tx.blockNumber !== destination.blockNumber
        || !same(tx.blockHash, destination.blockHash) || tx.transactionIndex !== destination.transactionIndex)
        fail('bridge_correlation_reorg');
    const proof = verifyBridgeDestinationReceipt({ receipt: destination, block,
        canonicalBlock: { number: destination.blockNumber, hash: destination.blockHash }, expected: {
            wallet: operation.quote.wallet, recipient, amountUnits: '5000000', transactionHash: txHash,
            minOutputUnits: '1', maxOutputUnits: BRIDGE_MAX_OUTPUT_UNITS, destinationAmountUnits: args.amount.toString(), from: args.from } });
    if (!proof) fail('bridge_correlation_fill_unproven');
    const canonical = receipt => ({ transactionHash: lower(receipt.transactionHash), blockNumber: receipt.blockNumber,
        blockHash: lower(receipt.blockHash), transactionIndex: receipt.transactionIndex });
    return { transactionHash: lower(destination.transactionHash), destinationAmountUnits: proof.amountUnits,
        correlation: { schema: 1, sourceHash: lower(operation.transfer.hash), withdrawalAddress: lower(operation.address),
            recipient: lower(recipient), destinationHash: lower(destination.transactionHash), orderId: lower(request.id), relayRequestId: providerMapping.requestId,
            pUSDUserOperationHash: lower(primary.transactionHash), intermediateUserOperationHash: lower(intermediate.transactionHash),
            unwrapTransactionHash: lower(unwrap.receipt.transactionHash), depositTransactionHash: lower(deposit.receipt.transactionHash),
            canonicalBlocks: { source: canonical(source), unwrap: canonical(unwrap.receipt), deposit: canonical(deposit.receipt), destination: canonical(destination) } } };
}
