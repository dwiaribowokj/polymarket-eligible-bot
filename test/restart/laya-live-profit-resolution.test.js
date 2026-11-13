import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { BRIDGE } from '../../src/laya-live/profit-bridge.js';
import { BRIDGE_RESOLUTION as route, resolveBridgeDestination } from '../../src/laya-live/profit-resolution.js';

// Synthetic public fixtures only. No network, environment, account keys, or
// signed transactions are used by this suite.
const A = n => `0x${n.toString(16).padStart(40, '0')}`;
const H = n => `0x${n.toString(16).padStart(64, '0')}`;
const wallet = A(1), withdrawal = A(2), recipient = A(3), solver = A(4), caller = A(5);
const sourceHash = H(10), unwrapHash = H(11), depositHash = H(12), payoutHash = H(13), manualHash = H(14);
const primaryHash = H(20), intermediateHash = H(21), orderId = H(22), requestId = H(23);
const token = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)',
    'function transferFrom(address from,address to,uint256 amount)']);
const protocol = new ethers.utils.Interface([
    'event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)',
    'event RelayErc20Deposit(address from,address token,uint256 amount,bytes32 id)',
]);

function fixture(outputAmount = '5000000') {
    const receipts = new Map(), txs = new Map(), calls = [], headers = new Map();
    const receipt = (hash, number, definitions) => {
        const r = { transactionHash: hash, blockNumber: number, blockHash: H(1000 + number), transactionIndex: 2,
            status: 1, confirmations: 50, logs: [] };
        r.logs = definitions.map(([address, iface, name, values], index) => ({ ...iface.encodeEventLog(iface.getEvent(name), values),
            address, logIndex: index + 1, blockNumber: number, blockHash: r.blockHash, transactionHash: hash, transactionIndex: 2, removed: false }));
        receipts.set(hash, r); headers.set(number, { number, hash: r.blockHash }); return r;
    };
    const transfer = (asset, from, to, amount = '5000000') => [asset, token, 'Transfer', [from, to, amount]];
    const user = hash => [route.entryPoint, protocol, 'UserOperationEvent', [hash, withdrawal, A(8), 1, true, 10, 20]];
    const source = receipt(sourceHash, 100, [transfer(BRIDGE.sourceToken, wallet, withdrawal)]);
    const unwrap = receipt(unwrapHash, 108, [transfer(BRIDGE.sourceToken, withdrawal, BRIDGE.sourceToken),
        transfer(route.intermediateToken, A(9), withdrawal), transfer(BRIDGE.sourceToken, BRIDGE.sourceToken, ethers.constants.AddressZero), user(primaryHash)]);
    const deposit = receipt(depositHash, 115, [transfer(route.intermediateToken, withdrawal, route.depository),
        [route.depository, protocol, 'RelayErc20Deposit', [withdrawal, route.intermediateToken, '5000000', orderId]], user(intermediateHash)]);
    const payout = receipt(payoutHash, 116, [transfer(BRIDGE.destinationToken, solver, recipient, outputAmount)]);
    const tx = (hash, number, id = orderId) => ({ hash, blockNumber: number, blockHash: H(1000 + number), transactionIndex: 2,
        chainId: 137, from: caller, to: BRIDGE.destinationToken, value: ethers.constants.Zero,
        data: token.encodeFunctionData('transferFrom', [solver, recipient, outputAmount]) + id.slice(2) });
    txs.set(payoutHash, tx(payoutHash, 116));
    const provider = {
        async getBlock(number) { return headers.get(number); },
        async getTransaction(hash) { return txs.get(hash); },
        async getLogs(filter) {
            calls.push(filter);
            const addresses = Array.isArray(filter.address) ? filter.address : [filter.address];
            return [...receipts.values()].flatMap(r => r.logs).filter(log => log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock
                && addresses.some(address => address.toLowerCase() === log.address.toLowerCase())
                && filter.topics.every((topic, i) => topic === null || (Array.isArray(topic) ? topic : [topic]).some(value => value.toLowerCase() === log.topics[i]?.toLowerCase())));
        },
    };
    const client = { async verifiedReceipt(hash) { return receipts.get(hash) ?? null; }, rpc: {
        async read(stage, task, block) { assert.equal(stage, 'bridge_correlation'); assert.equal(block, args.block); return task(provider); },
    } };
    const operation = { address: withdrawal, transfer: { hash: sourceHash, token: BRIDGE.sourceToken, amount: 5, recipient: withdrawal },
        quote: { wallet, recipient, amountUnits: '5000000', chainId: 137, sourceToken: BRIDGE.sourceToken, destinationToken: BRIDGE.destinationToken } };
    const status = (hash, sourceToken) => ({ transactionHash: hash, status: 'COMPLETED', address: withdrawal,
        sourceHash, wallet, recipient, amountUnits: '5000000', sourceToken, destinationToken: BRIDGE.destinationToken });
    const currency = (address, amount) => ({ currency: { chainId: 137, address, decimals: 6 }, amount });
    const metadata = { requests: [{ id: requestId, status: 'success', user: withdrawal, recipient,
        data: { metadata: { sender: withdrawal, recipient, currencyIn: currency(route.intermediateToken, '5000000'),
            currencyOut: currency(BRIDGE.destinationToken, outputAmount) },
        inTxs: [{ hash: depositHash, chainId: 137, block: 115, status: 'success' }],
        outTxs: [{ hash: payoutHash, chainId: 137, block: 116, status: 'success' }] },
        protocol: { orderId, deposit: { origin: { chainId: 137, amount: '5000000', currency: route.intermediateToken,
            depositor: withdrawal, depository: route.depository, transactionId: depositHash } },
        settlement: { destination: { fills: [{ chainId: 137, transactionId: payoutHash }] } } } }] };
    const args = { client, operation, primary: status(primaryHash, BRIDGE.sourceToken),
        intermediates: [status(intermediateHash, route.intermediateToken)], block: 200, recipient, sourceReceipt: source,
        async relayLookup(hash) { assert.equal(hash, depositHash); return metadata; } };
    return { args, provider, receipts, txs, headers, calls, source, unwrap, deposit, payout, metadata, receipt, transfer, user, tx };
}

test('canonical UserOperations, unwrap, Relay deposit and provider mapping resolve the native USDC fill', async () => {
    const f = fixture(), result = await resolveBridgeDestination(f.args);
    assert.equal(result.transactionHash, payoutHash);
    assert.equal(result.destinationAmountUnits, '5000000');
    assert.equal(result.correlation.orderId, orderId);
    assert.equal(result.correlation.relayRequestId, requestId);
    assert.equal(result.correlation.pUSDUserOperationHash, primaryHash);
    assert.equal(result.correlation.unwrapTransactionHash, unwrapHash);
    assert.equal(result.correlation.canonicalBlocks.destination.blockHash, f.payout.blockHash);
    assert.equal(JSON.stringify(result).includes('data'), false);
});

test('ordinary or forged order-tagged manual transfers cannot substitute for the provider-mapped fill', async () => {
    const f = fixture();
    f.receipt(manualHash, 117, [f.transfer(BRIDGE.destinationToken, A(99), recipient)]);
    f.txs.set(manualHash, f.tx(manualHash, 117));
    assert.equal((await resolveBridgeDestination(f.args)).transactionHash, payoutHash);
    f.receipts.delete(payoutHash);
    await assert.rejects(resolveBridgeDestination(f.args), /bridge_correlation_receipt_unproven/);
});

test('favorable output still requires matching Relay mapping, calldata, canonical receipt and exact recipient', async () => {
    const f = fixture('5000121');
    const resolved = await resolveBridgeDestination(f.args);
    assert.equal(resolved.destinationAmountUnits, '5000121');
    assert.equal(resolved.transactionHash, payoutHash);
    f.receipt(payoutHash, 116, [f.transfer(BRIDGE.destinationToken, solver, recipient, '5000121'),
        f.transfer(BRIDGE.destinationToken, A(99), recipient, '10000')]);
    await assert.rejects(resolveBridgeDestination(f.args), /bridge_correlation_fill_unproven/);
    f.receipt(payoutHash, 116, [f.transfer(BRIDGE.destinationToken, solver, recipient, '5000121')]);
    f.metadata.requests[0].data.metadata.currencyOut.amount = '5000122';
    await assert.rejects(resolveBridgeDestination(f.args), /bridge_correlation_fill_mismatch/);
    f.metadata.requests[0].data.metadata.currencyOut.amount = '5000121';
    f.receipt(payoutHash, 116, [f.transfer(BRIDGE.destinationToken, solver, A(99), '5000121')]);
    await assert.rejects(resolveBridgeDestination(f.args), /bridge_correlation_fill_unproven/);
    await assert.rejects(resolveBridgeDestination(fixture('9007199254740992').args), /bridge_relay_mapping_mismatch/);
});

for (const [name, mutate, code] of [
    ['wrong source hash', f => { f.args.operation.transfer.hash = H(999); }, 'status_identity_mismatch'],
    ['wrong withdrawal address', f => { f.args.operation.address = A(77); }, 'invalid_operation'],
    ['wrong recipient', f => { f.args.recipient = A(77); }, 'invalid_operation'],
    ['wrong UserOperation hash', f => { f.args.primary.transactionHash = H(999); }, 'user_operation_ambiguous'],
    ['wrong intermediate token', f => { f.args.intermediates[0].sourceToken = BRIDGE.sourceToken; }, 'status_identity_mismatch'],
    ['missing intermediate', f => { f.args.intermediates = []; }, 'intermediate_ambiguous'],
    ['failed receipt', f => { f.unwrap.status = 0; }, 'receipt_unproven'],
    ['reorged block', f => { f.headers.get(108).hash = H(999); }, 'reorg'],
    ['wrong order id suffix', f => { f.txs.get(payoutHash).data = f.tx(payoutHash, 116, H(999)).data; }, 'fill_malformed'],
    ['malformed transaction value', f => { f.txs.get(payoutHash).value = 'invalid'; }, 'fill_malformed'],
    ['provider lookup unavailable', f => { f.args.relayLookup = async () => { throw new Error('offline'); }; }, 'bridge_relay_mapping_unavailable'],
    ['missing provider mapping', f => { f.metadata.requests = []; }, 'bridge_relay_mapping_unavailable'],
    ['ambiguous provider requests', f => { f.metadata.requests.push(structuredClone(f.metadata.requests[0])); }, 'bridge_relay_mapping_unavailable'],
    ['provider wrong order', f => { f.metadata.requests[0].protocol.orderId = H(999); }, 'bridge_relay_mapping_mismatch'],
    ['provider wrong recipient', f => { f.metadata.requests[0].recipient = A(77); }, 'bridge_relay_mapping_mismatch'],
    ['provider wrong input', f => { f.metadata.requests[0].data.inTxs[0].hash = H(999); }, 'bridge_relay_mapping_mismatch'],
    ['provider wrong output currency', f => { f.metadata.requests[0].data.metadata.currencyOut.currency.address = BRIDGE.sourceToken; }, 'bridge_relay_mapping_mismatch'],
    ['provider wrong output amount', f => { f.metadata.requests[0].data.metadata.currencyOut.amount = '4999999'; }, 'fill_mismatch'],
    ['provider output beyond pinned block', f => { f.metadata.requests[0].data.outTxs[0].block = 201; }, 'fill_unconfirmed'],
    ['long scan', f => { f.args.block = 100101; }, 'scan_limit'],
]) test(`resolver rejects ${name}`, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(resolveBridgeDestination(f.args), error => error.code?.endsWith(code) && error.stage === 'bridge_correlation');
});

test('failed UserOperation and duplicate operation events are rejected', async () => {
    const f = fixture(), log = f.unwrap.logs.at(-1);
    Object.assign(log, protocol.encodeEventLog(protocol.getEvent('UserOperationEvent'), [primaryHash, withdrawal, A(8), 1, false, 10, 20]));
    await assert.rejects(resolveBridgeDestination(f.args), /user_operation_failed/);
    const g = fixture();
    g.receipt(H(88), 109, [g.user(primaryHash)]);
    await assert.rejects(resolveBridgeDestination(g.args), /user_operation_ambiguous/);
});

test('an additional intermediate-token deposit makes source provenance ambiguous', async () => {
    const f = fixture();
    f.receipt(manualHash, 110, [f.transfer(route.intermediateToken, A(99), withdrawal)]);
    await assert.rejects(resolveBridgeDestination(f.args), /token_flow_ambiguous/);
});

test('every log request is bounded to at most 100 blocks and no recipient transfer scan runs', async () => {
    const f = fixture(); f.args.block = 2200;
    await resolveBridgeDestination(f.args);
    assert.ok(f.calls.length > 6);
    assert.ok(f.calls.every(filter => filter.toBlock - filter.fromBlock + 1 <= 100));
    assert.ok(f.calls.every(filter => filter.address !== BRIDGE.destinationToken));
});

test('flow scans pass scalar token addresses through ethers v5 JSON-RPC formatting', async () => {
    const f = fixture(), sent = [];
    const provider = new ethers.providers.JsonRpcProvider(undefined, { name: 'polygon', chainId: 137 });
    provider.getNetwork = async () => ({ name: 'polygon', chainId: 137 });
    provider.getBlock = f.provider.getBlock;
    provider.getTransaction = f.provider.getTransaction;
    provider.send = async (method, [filter]) => {
        assert.equal(method, 'eth_getLogs');
        assert.equal(typeof filter.address, 'string');
        sent.push(filter);
        return f.provider.getLogs({ ...filter, fromBlock: Number(filter.fromBlock), toBlock: Number(filter.toBlock) });
    };
    f.args.client.rpc.read = async (stage, task, block) => {
        assert.equal(stage, 'bridge_correlation'); assert.equal(block, f.args.block);
        return task(provider);
    };
    assert.equal((await resolveBridgeDestination(f.args)).transactionHash, payoutHash);
    const flow = sent.filter(filter => filter.address.toLowerCase() !== route.entryPoint);
    assert.equal(flow.length, 4);
    for (const asset of [BRIDGE.sourceToken, route.intermediateToken])
        assert.equal(flow.filter(filter => filter.address.toLowerCase() === asset.toLowerCase()).length, 2);
});

test('separate token requests retain the cumulative flow log limit', async () => {
    const f = fixture(), original = f.provider.getLogs;
    f.provider.getLogs = async filter => {
        const logs = await original(filter);
        if (filter.address.toLowerCase() === route.entryPoint) return logs;
        const log = filter.address.toLowerCase() === BRIDGE.sourceToken.toLowerCase() ? f.unwrap.logs[0] : f.deposit.logs[0];
        return Array.from({ length: Math.floor(route.maxLogs / 2) + 1 }, () => ({ ...log }));
    };
    await assert.rejects(resolveBridgeDestination(f.args), error => error.code === 'bridge_correlation_scan_limit');
});

test('Relay Retry-After reaches the coordinator without an early retry', async () => {
    const f = fixture(), previousFetch = globalThis.fetch; let calls = 0;
    delete f.args.relayLookup;
    globalThis.fetch = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '60' }) }; };
    try {
        await assert.rejects(resolveBridgeDestination(f.args), error => error.code === 'bridge_relay_mapping_unavailable'
            && error.category === 'rate_limit' && error.retryAfter === 60 && error.httpStatus === 429);
        assert.equal(calls, 1);
    } finally { globalThis.fetch = previousFetch; }
});
