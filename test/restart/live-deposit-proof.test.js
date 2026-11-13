import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { CAPITAL_DEPOSIT_SCAN, discoverCapitalDeposits } from '../../src/laya-live/deposit-proof.js';

const h = value => `0x${value.toString(16).padStart(64, '0')}`;
const a = value => `0x${value.toString(16).padStart(40, '0')}`;
const wallet = a(11), sender = a(12), zero = ethers.constants.AddressZero;
const underlying = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const abi = new ethers.utils.Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event Wrapped(address indexed caller,address indexed token,address indexed recipient,uint256 amount)',
]);
const from = { blockNumber: 100, blockHash: h(100) }, to = { blockNumber: 200, blockHash: h(200) };
function event(name, args, index, { token = CONTRACTS.collateralToken, tx = h(901), block = 150 } = {}) {
    const encoded = abi.encodeEventLog(abi.getEvent(name), args);
    return { ...encoded, address: token, logIndex: index, transactionHash: tx,
        blockNumber: block, blockHash: h(block), transactionIndex: 3, removed: false };
}
function transfer(source = sender, amount = '5000000', options = {}) {
    return event('Transfer', [source, options.recipient || wallet, amount], options.index || 10, options);
}
function mint() {
    return [transfer(a(40), '5000000', { token: underlying, recipient: CONTRACTS.collateralToken, index: 9 }),
        transfer(zero), event('Wrapped', [a(50), underlying, wallet, '5000000'], 11)];
}
function fixture(logs = [transfer()], overrides = {}) {
    const calls = [], receipts = new Map();
    for (const log of logs) {
        if (!receipts.has(log.transactionHash)) receipts.set(log.transactionHash, { status: 1,
            transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
            transactionIndex: log.transactionIndex, confirmations: 10, logs: [] });
        receipts.get(log.transactionHash).logs.push(log);
    }
    const provider = {
        async getBlock(number) { calls.push(['block', number]); return { number, hash: h(number) }; },
        async getLogs(filter) {
            calls.push(['logs', filter]);
            return logs.filter(log => log.address.toLowerCase() === filter.address.toLowerCase()
                && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock
                && filter.topics.every((topic, index) => topic == null || topic === log.topics[index].toLowerCase()));
        }, ...overrides,
    };
    const client = { rpc: { anchor: { number: to.blockNumber, hash: to.blockHash },
        async validate(_provider, anchor) { calls.push(['validate', anchor]); },
        async read(_stage, task, block) { assert.equal(block, client.rpc.anchor.number); return task(provider); } },
    async verifiedReceipt(hash, block) { assert.equal(block, client.rpc.anchor.number); return receipts.get(hash); } };
    return { client, provider, calls, receipts, options: { wallet, from, to, expectedDelta: 5 } };
}
const run = f => discoverCapitalDeposits(f.client, f.options);
const rejects = (f, code) => assert.rejects(run(f), { code: `capital_deposit_${code}` });

test('canonical external pUSD transfer is a precisely identified contribution', async () => {
    const f = fixture(), [entry] = await run(f);
    assert.deepEqual(entry, { txHash: h(901), logIndex: 10, from: sender, amount: 5, amountUnits: '5000000',
        blockNumber: 150, blockHash: h(150), token: CONTRACTS.collateralToken.toLowerCase(), wallet, kind: 'direct' });
    assert.equal(f.calls.filter(([kind]) => kind === 'validate').length, 2);
    assert.equal(f.calls.filter(([kind]) => kind === 'logs').length, 2);
});

test('USDC.e wrap route recognizes the actual deposit mint shape', async () => {
    const [entry] = await run(fixture(mint()));
    assert.equal(entry.kind, 'wrapped'); assert.equal(entry.from, zero); assert.equal(entry.amount, 5);
    assert.equal(entry.underlyingToken, underlying); assert.equal(entry.wrappedLogIndex, 11);
    assert.equal(entry.fundingLogIndex, 9);
});

test('multiple independent incoming deposits add exactly in token units', async () => {
    const f = fixture([transfer(sender, '2000001'), transfer(a(13), '2999999', { tx: h(902), index: 11 })]);
    assert.equal((await run(f)).length, 2);
});

test('known bot receipt is checked canonically and excluded from capital', async () => {
    const outgoing = transfer(wallet, '2000000', { tx: h(902), recipient: CONTRACTS.standardExchange, index: 20 });
    const f = fixture([transfer(), outgoing]); f.options.knownHashes = [h(902)];
    assert.equal((await run(f)).length, 1);
    f.receipts.get(h(902)).status = 0;
    await rejects(f, 'receipt_unconfirmed');
});

test('unknown wallet spending invalidates the entire scan', async () => {
    const f = fixture([transfer(), transfer(wallet, '1', { tx: h(902), recipient: sender, index: 11 })]);
    await rejects(f, 'non_deposit_flow');
});

test('unknown transfer from a protocol contract cannot become a deposit', async () => {
    await rejects(fixture([transfer(CONTRACTS.collateralAdapter)]), 'non_deposit_flow');
});

test('CTF and exchange receipt activity prevents mistaking proceeds for deposits', async () => {
    for (const token of [CONTRACTS.conditionalTokens, CONTRACTS.standardExchange, CONTRACTS.negRiskExchange,
        CONTRACTS.protocolV2Router, CONTRACTS.collateralAdapter]) {
        const f = fixture([transfer(), event('Transfer', [sender, a(14), '1'], 12, { token })]);
        await rejects(f, 'non_deposit_flow');
    }
});

test('deposit transaction cannot spend wallet underlying even if pUSD increases', async () => {
    const f = fixture([...mint(), transfer(wallet, '5000000', { token: underlying, recipient: a(40), index: 8 })]);
    await rejects(f, 'non_deposit_flow');
});

test('mint requires one matching wrap and underlying funding transfer', async () => {
    await rejects(fixture([transfer(zero)]), 'mint_unproven');
    await rejects(fixture(mint().slice(1)), 'mint_unproven');
    const badRecipient = mint(); badRecipient[2] = event('Wrapped', [a(50), underlying, sender, '5000000'], 11);
    await rejects(fixture(badRecipient), 'mint_unproven');
    const badAmount = mint(); badAmount[0] = transfer(a(40), '4000000', { token: underlying,
        recipient: CONTRACTS.collateralToken, index: 9 });
    await rejects(fixture(badAmount), 'mint_unproven');
    const badToken = mint(); badToken[2] = event('Wrapped', [a(50), a(99), wallet, '5000000'], 11);
    await rejects(fixture(badToken), 'mint_unproven');
});

test('duplicate matching mint evidence cannot credit twice', async () => {
    await rejects(fixture([...mint(), event('Wrapped', [a(50), underlying, wallet, '5000000'], 12)]), 'mint_unproven');
    await rejects(fixture([...mint(), transfer(zero, '5000000', { index: 12 })]), 'mint_unproven');
});

test('surplus mismatch rejects deposits without changing the caller amount', async () => {
    const f = fixture(); f.options.expectedDelta = 6;
    await rejects(f, 'amount_mismatch'); assert.equal(f.options.expectedDelta, 6);
    for (const expectedDelta of [0, -1, NaN, Infinity, 0.0000001, '5']) {
        const invalid = fixture(); invalid.options.expectedDelta = expectedDelta;
        await rejects(invalid, 'invalid_delta');
    }
});

test('duplicate, removed, malformed and out of filter RPC logs fail closed', async () => {
    const duplicate = fixture([transfer()], { async getLogs() { return [transfer(), transfer()]; } });
    await rejects(duplicate, 'duplicate_log');
    const removed = transfer(); removed.removed = true;
    await rejects(fixture([removed]), 'malformed_log');
    const noIdentity = transfer(); delete noIdentity.logIndex;
    await rejects(fixture([noIdentity]), 'malformed_log');
    const outside = fixture([transfer()], { async getLogs() { return [transfer(sender, '5000000', { block: 99 })]; } });
    await rejects(outside, 'log_filter_mismatch');
});

test('malformed ABI cannot be accepted through permissive decoding', async () => {
    const log = transfer(); log.data += '00'.repeat(32);
    await rejects(fixture([log]), 'malformed_event');
});

test('receipt logs must exactly match the queried canonical event', async () => {
    const f = fixture(); const receipt = structuredClone(f.receipts.get(h(901)));
    receipt.logs[0].data = ethers.utils.hexZeroPad('0x01', 32); f.receipts.set(h(901), receipt);
    await rejects(f, 'receipt_log_mismatch');
    const omitted = fixture([transfer(), transfer(sender, '1', { index: 12 })]);
    const original = omitted.provider.getLogs;
    omitted.provider.getLogs = async filter => (await original(filter)).filter(log => log.logIndex !== 12);
    await rejects(omitted, 'receipt_log_mismatch');
});

test('failed, unconfirmed and reorged receipts are not contributions', async () => {
    for (const mutation of [{ status: 0 }, { confirmations: 1 }, { transactionHash: h(777) }, { blockNumber: 201 }]) {
        const f = fixture(); Object.assign(f.receipts.get(h(901)), mutation);
        await rejects(f, 'receipt_unconfirmed');
    }
    const reorg = fixture([], { async getBlock(number) { return { number, hash: number === 150 ? h(151) : h(number) }; } });
    const valid = fixture(); reorg.receipts.set(h(901), valid.receipts.get(h(901)));
    reorg.provider.getLogs = valid.provider.getLogs;
    await rejects(reorg, 'receipt_reorg');
});

test('start/end anchors are checked again after all receipt reads', async () => {
    for (const changedBlock of [100, 200]) {
        const f = fixture();
        let selectedReads = 0;
        f.provider.getBlock = async number => ({ number, hash: number === changedBlock && ++selectedReads > 1 ? h(888) : h(number) });
        await rejects(f, 'anchor_changed');
    }
});

test('concurrent RPC snapshot change aborts the proof', async () => {
    const f = fixture();
    f.client.verifiedReceipt = async () => { f.client.rpc.anchor = { number: 201, hash: h(201) }; return f.receipts.get(h(901)); };
    await rejects(f, 'snapshot_changed');
});

test('long offline ranges use bounded pages without an arbitrary age cutoff', async () => {
    const f = fixture([transfer(sender, '5000000', { block: 10400 })]);
    f.options.to = { blockNumber: 10500, blockHash: h(10500) }; f.client.rpc.anchor = { number: 10500, hash: h(10500) };
    assert.equal((await run(f)).length, 1);
    const pages = f.calls.filter(([kind]) => kind === 'logs').map(([, filter]) => filter);
    assert.ok(pages.length > 40);
    assert.ok(pages.every(page => page.toBlock - page.fromBlock + 1 <= CAPITAL_DEPOSIT_SCAN.chunkBlocks));
    assert.equal(pages[0].fromBlock, 101); assert.equal(pages.at(-1).toBlock, 10500);
});

test('provider result saturation fails closed instead of trusting truncated history', async () => {
    const f = fixture([transfer()], { async getLogs() { return Array(CAPITAL_DEPOSIT_SCAN.maxLogs).fill(transfer()); } });
    await rejects(f, 'scan_limit');
});
