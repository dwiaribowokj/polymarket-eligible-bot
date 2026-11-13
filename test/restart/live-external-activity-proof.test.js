import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { EXTERNAL_ACTIVITY_SCAN, discoverExternalActivity } from '../../src/laya-live/external-activity-proof.js';

const h = value => `0x${value.toString(16).padStart(64, '0')}`;
const a = value => `0x${value.toString(16).padStart(40, '0')}`;
const wallet = a(11), sender = a(12), zero = ethers.constants.AddressZero;
const underlying = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174';
const abi = new ethers.utils.Interface([
    'event Transfer(address indexed from,address indexed to,uint256 value)',
    'event Wrapped(address indexed caller,address indexed token,address indexed recipient,uint256 amount)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const from = { blockNumber: 100, blockHash: h(100) }, to = { blockNumber: 200, blockHash: h(200) };
function event(name, args, index, { contract = CONTRACTS.collateralToken, tx = h(901), block = 150 } = {}) {
    return { ...abi.encodeEventLog(abi.getEvent(name), args), address: contract, logIndex: index,
        transactionHash: tx, blockNumber: block, blockHash: h(block), transactionIndex: 3, removed: false };
}
function cash(source = sender, recipient = wallet, units = '5000000', options = {}) {
    return event('Transfer', [source, recipient, units], options.index ?? 10, options);
}
function shares(source = zero, recipient = wallet, id = '11', units = '2000000', options = {}) {
    return event('TransferSingle', [CONTRACTS.standardExchange, source, recipient, id, units], options.index ?? 11,
        { contract: CONTRACTS.conditionalTokens, ...options });
}
function batch(source, recipient, ids, values, options = {}) {
    return event('TransferBatch', [CONTRACTS.collateralAdapter, source, recipient, ids, values], options.index ?? 12,
        { contract: CONTRACTS.conditionalTokens, ...options });
}
function buy(options = {}) {
    return [cash(wallet, CONTRACTS.standardExchange, '1035000', options), shares(zero, wallet, '11', '2000000', options)];
}
function redeem(options = {}) {
    return [cash(zero, wallet, '2000000', options), shares(wallet, zero, '11', '2000000', options)];
}
function mint() {
    return [cash(a(40), CONTRACTS.collateralToken, '5000000', { contract: underlying, index: 9 }),
        cash(zero), event('Wrapped', [a(50), underlying, wallet, '5000000'], 11)];
}
function fixture(logs = buy(), overrides = {}) {
    const calls = [], receipts = new Map();
    for (const log of logs) {
        if (!receipts.has(log.transactionHash)) receipts.set(log.transactionHash, { status: 1,
            transactionHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: log.blockHash,
            transactionIndex: log.transactionIndex, confirmations: 10, logs: [] });
        receipts.get(log.transactionHash).logs.push(log);
    }
    for (const receipt of receipts.values()) receipt.logs.sort((a, b) => a.logIndex - b.logIndex);
    const provider = {
        async getBlock(number) { calls.push(['block', number]); return { number, hash: h(number) }; },
        async getLogs(filter) {
            calls.push(['logs', filter]);
            return logs.filter(log => log.address.toLowerCase() === filter.address.toLowerCase()
                && log.blockNumber >= filter.fromBlock && log.blockNumber <= filter.toBlock
                && filter.topics.every((topic, index) => topic == null
                    || (Array.isArray(topic) ? topic : [topic]).includes(log.topics[index]?.toLowerCase())));
        }, ...overrides,
    };
    const client = { rpc: { anchor: { number: to.blockNumber, hash: to.blockHash },
        async validate(_provider, anchor) { calls.push(['validate', anchor]); },
        async read(_stage, task, block, key) { assert.equal(block, client.rpc.anchor.number); calls.push(['read', key]); return task(provider); } },
    async verifiedReceipt(hash, block) { assert.equal(block, client.rpc.anchor.number); calls.push(['receipt', hash]); return receipts.get(hash); } };
    return { client, provider, calls, receipts, options: { wallet, from, to } };
}
const run = f => discoverExternalActivity(f.client, f.options);
const rejects = (f, code) => assert.rejects(run(f), { code: `external_activity_${code}` });

test('manual buy is external cash and open inventory without an API or resolution requirement', async () => {
    const f = fixture(), result = await run(f);
    assert.deepEqual(result, { receipts: [{ hash: h(901), blockNumber: 150, blockHash: h(150),
        cash: -1.035, tokenIds: ['11'], holdings: [2] }], externalCashDelta: -1.035,
    tokenIds: ['11'], holdingsDeltas: [{ tokenId: '11', amount: 2 }], deposits: [], depositAmount: 0, checkpoint: to });
    assert.equal(f.calls.filter(([kind]) => kind === 'logs').length, 4);
    assert.equal(f.calls.filter(([kind]) => kind === 'validate').length, 2);
});

test('winning redemption is manual proceeds rather than a deposit mint', async () => {
    const result = await run(fixture(redeem()));
    assert.equal(result.externalCashDelta, 2); assert.equal(result.depositAmount, 0);
    assert.deepEqual(result.receipts[0].holdings, [-2]); assert.deepEqual(result.deposits, []);
});

test('zero-cash losing burns and zero-quantity redemptions are discovered from CTF logs', async () => {
    const result = await run(fixture([
        batch(wallet, CONTRACTS.collateralAdapter, ['11', '12'], ['0', '1923077']),
        batch(wallet, CONTRACTS.collateralAdapter, ['13', '14'], ['0', '0'], { tx: h(902), block: 160 }),
    ]));
    assert.equal(result.externalCashDelta, 0); assert.equal(result.receipts.length, 2);
    assert.deepEqual(result.holdingsDeltas, [{ tokenId: '11', amount: 0 }, { tokenId: '12', amount: -1.923077 },
        { tokenId: '13', amount: 0 }, { tokenId: '14', amount: 0 }]);
});

test('cash-neutral activity still returns every receipt and independently derived token change', async () => {
    const result = await run(fixture([...buy(), cash(CONTRACTS.standardExchange, wallet, '1035000', { tx: h(902), block: 160 }),
        shares(wallet, zero, '11', '1000000', { tx: h(902), block: 160 })]));
    assert.equal(result.externalCashDelta, 0); assert.equal(result.receipts.length, 2);
    assert.deepEqual(result.holdingsDeltas, [{ tokenId: '11', amount: 1 }]);
});

test('manual buys, real deposits and redemptions in one interval remain separately accounted', async () => {
    const result = await run(fixture([...buy(), cash(sender, wallet, '5000000', { tx: h(902), block: 160 }),
        ...redeem({ tx: h(903), block: 170 })]));
    assert.equal(result.externalCashDelta, 0.965); assert.equal(result.depositAmount, 5);
    assert.equal(result.receipts.length, 2); assert.equal(result.deposits.length, 1);
    assert.deepEqual(result.holdingsDeltas, [{ tokenId: '11', amount: 0 }]);
    assert.equal(result.deposits[0].txHash, h(902)); assert.equal(result.deposits[0].kind, 'direct');
});

test('strict wrapped funding is recognized while a manual self-funded wrap is not bot capital', async () => {
    const funded = await run(fixture(mint()));
    assert.equal(funded.depositAmount, 5); assert.equal(funded.receipts.length, 0);
    assert.equal(funded.deposits[0].kind, 'wrapped'); assert.equal(funded.deposits[0].fundingLogIndex, 9);
    const self = mint(); self[0] = cash(wallet, CONTRACTS.collateralToken, '5000000', { contract: underlying, index: 9 });
    const manual = await run(fixture(self));
    assert.equal(manual.depositAmount, 0); assert.equal(manual.externalCashDelta, 5);
});

test('protocol transfers and unproven mints never inflate bot funding', async () => {
    for (const logs of [[cash(CONTRACTS.collateralAdapter)], [cash(zero)], mint().slice(1)]) {
        const result = await run(fixture(logs));
        assert.equal(result.depositAmount, 0); assert.equal(result.externalCashDelta, 5);
    }
    const malformed = mint(); malformed[2].data += '00'.repeat(32);
    await assert.rejects(run(fixture(malformed)), { code: 'capital_deposit_malformed_event' });
});

test('pure manual cash spending is a negative external movement', async () => {
    const result = await run(fixture([cash(wallet, sender, '2100000')]));
    assert.equal(result.externalCashDelta, -2.1); assert.equal(result.depositAmount, 0);
    assert.deepEqual(result.tokenIds, []); assert.deepEqual(result.receipts[0].holdings, []);
});

test('self-transfers appearing in both scan directions are validated and booked once with zero net movement', async () => {
    const f = fixture([cash(wallet, wallet), shares(wallet, wallet)]), result = await run(f);
    assert.equal(result.receipts.length, 1); assert.equal(result.externalCashDelta, 0);
    assert.deepEqual(result.holdingsDeltas, [{ tokenId: '11', amount: 0 }]);
    assert.equal(f.calls.filter(([kind]) => kind === 'receipt').length, 1);
    const incomplete = fixture([cash(wallet, wallet)]), read = incomplete.provider.getLogs;
    incomplete.provider.getLogs = async filter => filter.topics.length === 2 ? [] : read(filter);
    await rejects(incomplete, 'receipt_log_mismatch');
});

test('known receipts are verified and excluded even when they contain reserved bot tokens and orders', async () => {
    const order = event('OrderFilled', [h(444), wallet, sender, 0, '11', '1000000', '2000000', '35000', h(1), h(2)],
        12, { contract: CONTRACTS.standardExchange });
    const f = fixture([...buy(), order]); Object.assign(f.options, { knownHashes: [h(901)], botTokens: ['11'], botOrderIds: [h(444)] });
    const result = await run(f);
    assert.deepEqual(result.receipts, []); assert.deepEqual(result.deposits, []); assert.equal(result.externalCashDelta, 0);
    assert.equal(f.calls.filter(([kind]) => kind === 'receipt').length, 1);
    f.receipts.get(h(901)).confirmations = 1; await rejects(f, 'receipt_unconfirmed');
});

test('a new receipt cannot consume a reserved bot token, even in a zero-value transfer', async () => {
    for (const logs of [buy(), [shares(wallet, zero, '11', '0')]]) {
        const f = fixture(logs); f.options.botTokens = ['11']; await rejects(f, 'bot_overlap');
    }
    const f = fixture([...buy(), shares(sender, a(13), '44', '10', { index: 12 })]);
    f.options.botTokens = ['44']; assert.equal((await run(f)).receipts.length, 1);
});

test('a new receipt carrying a bot order hash cannot be imported as external activity', async () => {
    const f = fixture([...buy(), event('OrderFilled', [h(444), wallet, sender, 0, '11', '1000000', '2000000', '35000', h(1), h(2)],
        12, { contract: CONTRACTS.standardExchange })]);
    f.options.botOrderIds = [h(444)]; await rejects(f, 'bot_overlap');
    const unindexed = fixture([...buy(), { address: CONTRACTS.standardExchange, topics: [h(555)], data: h(444),
        transactionHash: h(901), blockNumber: 150, blockHash: h(150), transactionIndex: 3, logIndex: 12 }]);
    unindexed.options.botOrderIds = [h(444)]; await rejects(unindexed, 'bot_overlap');
});

test('receipt completeness covers both pUSD and CTF logs, including known hashes', async () => {
    for (const missingIndex of [10, 11]) for (const known of [false, true]) {
        const f = fixture(); if (known) f.options.knownHashes = [h(901)];
        const original = f.provider.getLogs;
        f.provider.getLogs = async filter => (await original(filter)).filter(log => log.logIndex !== missingIndex);
        await rejects(f, 'receipt_log_mismatch');
    }
    const f = fixture(); const copy = structuredClone(f.receipts.get(h(901)));
    copy.logs[0].data = ethers.utils.hexZeroPad('0x01', 32); f.receipts.set(h(901), copy);
    await rejects(f, 'receipt_log_mismatch');
});

test('duplicate scan rows are rejected without confusing valid self-transfer coverage', async () => {
    const f = fixture([cash(wallet, wallet)]), original = f.provider.getLogs;
    f.provider.getLogs = async filter => { const rows = await original(filter); return [...rows, ...rows]; };
    await rejects(f, 'duplicate_log');
    const conflict = fixture([cash(wallet, wallet)]), read = conflict.provider.getLogs;
    conflict.provider.getLogs = async filter => {
        const rows = await read(filter);
        return filter.topics.length === 2 ? rows.map(row => ({ ...row, data: ethers.utils.hexZeroPad('0x01', 32) })) : rows;
    };
    await rejects(conflict, 'duplicate_log');
});

test('removed, malformed, unordered and identity-mismatched logs fail closed', async () => {
    const bad = cash(); bad.removed = true; await rejects(fixture([bad]), 'malformed_log');
    const missing = cash(); delete missing.transactionIndex; await rejects(fixture([missing]), 'malformed_log');
    for (const field of ['blockNumber', 'transactionIndex', 'logIndex']) {
        const f = fixture(); const copy = structuredClone(f.receipts.get(h(901)));
        copy.logs[1][field] = field === 'logIndex' ? 9 : 999; f.receipts.set(h(901), copy);
        await rejects(f, 'receipt_log_mismatch');
    }
    const f = fixture(), copy = structuredClone(f.receipts.get(h(901)));
    copy.logs[1].transactionHash = h(777); f.receipts.set(h(901), copy); await rejects(f, 'receipt_log_mismatch');
});

test('malformed ABI and invalid batch token layouts cannot pass permissive decoding', async () => {
    const bad = shares(); bad.data += '00'.repeat(32); await rejects(fixture([bad]), 'malformed_event');
    for (const [ids, values] of [[['11', '11'], ['1', '2']], [['11', '12'], ['1']], [['0'], ['1']]])
        await rejects(fixture([batch(wallet, zero, ids, values)]), 'malformed_event');
    await rejects(fixture([shares(zero, wallet, '11', (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString())]), 'amount_overflow');
});

test('scan responses outside the block or wallet filters cannot introduce receipts', async () => {
    for (const log of [cash(sender, wallet, '1', { block: 99 }), cash(sender, wallet, '1', { block: 201 }), cash(sender, a(44), '1')]) {
        const f = fixture([log], { async getLogs() { return [log]; } }); await rejects(f, 'log_filter_mismatch');
    }
});

test('failed, unconfirmed, reorged and out-of-range receipts cannot authorize accounting', async () => {
    for (const mutation of [{ status: 0 }, { confirmations: 1 }, { transactionHash: h(777) }, { blockNumber: 100 }, { blockNumber: 201 }]) {
        const f = fixture(); Object.assign(f.receipts.get(h(901)), mutation); await rejects(f, 'receipt_unconfirmed');
    }
    const missing = fixture(); missing.receipts.clear(); await rejects(missing, 'receipt_unconfirmed');
    const f = fixture([], { async getBlock(number) { return { number, hash: number === 150 ? h(151) : h(number) }; } });
    const valid = fixture(); f.receipts.set(h(901), valid.receipts.get(h(901))); f.provider.getLogs = valid.provider.getLogs;
    await rejects(f, 'receipt_reorg');
});

test('start and end anchor headers are checked again after receipt accounting', async () => {
    for (const changed of [100, 200]) {
        const f = fixture(); let reads = 0;
        f.provider.getBlock = async number => ({ number, hash: number === changed && ++reads > 1 ? h(888) : h(number) });
        await rejects(f, 'anchor_changed');
    }
    const f = fixture(); f.client.rpc.validate = async () => { throw new Error('wrong_chain'); };
    await assert.rejects(run(f), /wrong_chain/);
});

test('a moving RPC snapshot invalidates a proof before any result escapes', async () => {
    const f = fixture();
    f.client.verifiedReceipt = async () => { f.client.rpc.anchor = { number: 201, hash: h(201) }; return f.receipts.get(h(901)); };
    await rejects(f, 'snapshot_changed');
});

test('equal anchors safely return an empty proof and invalid ownership or range queries reject', async () => {
    const f = fixture([]); f.options.from = to;
    assert.deepEqual(await run(f), { receipts: [], externalCashDelta: 0, tokenIds: [], holdingsDeltas: [], deposits: [], depositAmount: 0, checkpoint: to });
    assert.equal(f.calls.filter(([kind]) => kind === 'logs').length, 0);
    for (const invalid of [{ botTokens: ['0'] }, { botOrderIds: ['wrong'] }, { knownHashes: ['wrong'] },
        { from: { blockNumber: 201, blockHash: h(201) } }, { from: { blockNumber: 200, blockHash: h(201) } }]) {
        const f = fixture(); Object.assign(f.options, invalid); await rejects(f, 'invalid_query');
    }
});

test('long offline scans cover every block once within a provider 100-block limit', async () => {
    const boundaries = [101, 200, 201, 10400, 10401, 10505];
    const f = fixture([
        ...boundaries.flatMap((block, index) => buy({ block, tx: h(901 + index) })),
        cash(sender, wallet, '5000000', { block: 300, tx: h(910) }),
        cash(wallet, wallet, '2000000', { block: 301, tx: h(911) }),
        shares(wallet, wallet, '11', '2000000', { block: 301, tx: h(911) }),
        ...buy({ block: 100, tx: h(912) }), ...buy({ block: 10506, tx: h(913) }),
    ]);
    const getLogs = f.provider.getLogs;
    f.provider.getLogs = async filter => {
        if (filter.toBlock - filter.fromBlock + 1 > 100)
            throw Object.assign(new Error('provider_log_range_limit'), { status: 400 });
        return getLogs(filter);
    };
    f.options.to = { blockNumber: 10505, blockHash: h(10505) };
    f.client.rpc.anchor = { number: 10505, hash: h(10505) };
    const result = await run(f);
    assert.deepEqual(result.checkpoint, f.options.to);
    assert.deepEqual(result.receipts.map(row => row.blockNumber), [101, 200, 201, 301, 10400, 10401, 10505]);
    assert.equal(result.externalCashDelta, -6.21);
    assert.deepEqual(result.holdingsDeltas, [{ tokenId: '11', amount: 12 }]);
    assert.equal(result.depositAmount, 5); assert.equal(result.deposits.length, 1);
    const receiptHashes = f.calls.filter(([kind]) => kind === 'receipt').map(([, hash]) => hash);
    assert.equal(receiptHashes.length, 8); assert.equal(new Set(receiptHashes).size, 8);
    const scans = new Map();
    for (const [, filter] of f.calls.filter(([kind]) => kind === 'logs')) {
        const key = JSON.stringify([filter.address, filter.topics]);
        if (!scans.has(key)) scans.set(key, []);
        scans.get(key).push(filter);
    }
    assert.equal(scans.size, 4);
    for (const pages of scans.values()) {
        let next = from.blockNumber + 1;
        for (const page of pages) {
            assert.equal(page.fromBlock, next);
            assert.ok(page.toBlock >= page.fromBlock && page.toBlock - page.fromBlock + 1 <= 100);
            next = page.toBlock + 1;
        }
        assert.equal(next, f.options.to.blockNumber + 1);
    }
});

test('saturated results and excessive receipt or token counts refuse incomplete coverage', async () => {
    const f = fixture([], { async getLogs() { return Array(EXTERNAL_ACTIVITY_SCAN.maxLogs).fill(cash()); } });
    await rejects(f, 'scan_limit');
    await rejects(fixture(Array.from({ length: EXTERNAL_ACTIVITY_SCAN.maxReceipts + 1 }, (_, index) => cash(sender, wallet, '1', { tx: h(901 + index) }))), 'scan_limit');
    const ids = Array.from({ length: EXTERNAL_ACTIVITY_SCAN.maxTokens + 1 }, (_, index) => String(index + 1));
    await rejects(fixture([batch(wallet, zero, ids, ids.map(() => '0'))]), 'scan_limit');
});
