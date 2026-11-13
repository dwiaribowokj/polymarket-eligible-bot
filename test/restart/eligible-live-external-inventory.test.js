import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { CONTRACTS } from '../../src/restart/client.js';
import { readExternalInventoryProof } from '../../src/eligible-live/external-inventory.js';
import { assertPeriodAccountReady } from '../../src/eligible-live/period.js';

const hash = digit => `0x${digit.repeat(64)}`, wallet = `0x${'a'.repeat(40)}`;
const conditionId = hash('1'), blockHash = hash('2'), txHash = hash('3');
const abi = new ethers.utils.Interface([
    'function getOutcomeSlotCount(bytes32) view returns (uint256)',
    'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
    'function getPositionId(address,bytes32) view returns (uint256)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
]);

function fixture() {
    const approved = { conditionId, slug: 'reviewed-manual', tokens: ['11', '22'],
        amounts: [0, 2.040817], payout: [1, 0], receiptHashes: [txHash] };
    const source = { hash: txHash, blockNumber: 80, blockHash: hash('4'),
        cash: -1.0357, tokenIds: ['22', '33'], holdings: [2.040817, 0] };
    const state = { completed: [{ conditionId: hash('9'), tokens: ['1', '2'] }],
        externalWalletActivity: { reviewedAt: 900, cashDelta: -1.0357, receipts: [source], zeroPayoutInventory: [approved] } };
    const account = { positions: [{ conditionId, tokenId: '22', size: 2.0408, redeemable: true }],
        openOrders: [], checks: [{ name: 'authenticated_order_trade_api', detail: { trades: [] } }] };
    const log = abi.encodeEventLog(abi.getEvent('TransferSingle'), [wallet, ethers.constants.AddressZero, wallet, '22', '2040817']);
    const f = { state, account, approved, source, proof: { blockNumber: 100, blockHash }, now: 1000, calls: [],
        config: { settings: { wallet } }, amounts: [0, 2.040817], otherAmounts: [0], payout: [1, 0],
        receipt: { transactionHash: txHash, blockNumber: 80, blockHash: hash('4'), status: 1, confirmations: 21,
            logs: [{ address: CONTRACTS.conditionalTokens, logIndex: 1, ...log }] } };
    f.client = { rpc: { anchor: { number: 100, hash: blockHash }, read: async (stage, task, block) => {
        assert.equal(stage, 'eligible_external_inventory_market'); assert.equal(block, 100);
        return task({ _isProvider: true, resolveName: async name => name, call: async (transaction, tag) => {
            assert.equal(tag, 100); assert.equal(transaction.to.toLowerCase(), CONTRACTS.conditionalTokens.toLowerCase());
            const { name, args } = abi.parseTransaction(transaction);
            if (name === 'getPositionId') assert.equal(args[0].toLowerCase(), '0x2791bca1f2de4661ed88a30c99a7a9449aa84174');
            const value = name === 'getOutcomeSlotCount' ? 2 : name === 'getCollectionId'
                ? ethers.utils.hexZeroPad(args[2].toHexString(), 32) : Number(BigInt(args[1])) * 11;
            return abi.encodeFunctionResult(name, [value]);
        } });
    } }, verifiedReceipt: async (hash, block) => {
        assert.equal(hash, txHash); assert.equal(block, 100); f.calls.push('receipt'); return f.receipt;
    }, holdings: async (tokens, block) => {
        assert.equal(block, 100); f.calls.push(`holdings:${tokens.join(',')}`);
        return tokens.length === 2 ? f.amounts : f.otherAmounts;
    }, payoutAtBlock: async (condition, block) => {
        assert.equal(condition, conditionId); assert.equal(block, 100); return f.payout;
    } };
    f.read = () => readExternalInventoryProof(f.config, f.state, f.client, f.account, f.proof, { now: () => f.now });
    return f;
}

test('only canonical zero-payout reviewed manual tokens are excluded, with exact receipts and rounded API evidence', async () => {
    const f = fixture(), before = structuredClone(f.state), originalAccount = structuredClone(f.account);
    const result = await f.read();
    assert.deepEqual(result.account.positions, []);
    assert.deepEqual(result.excludedLegacyInventory, originalAccount.positions);
    assert.deepEqual(result.proof.inventory[0].holdings, [0, 2.040817]);
    assert.equal(result.proof.inventory[0].value, 0);
    assert.equal(result.proof.blockNumber, 100); assert.equal(result.proof.blockHash, blockHash);
    assert.deepEqual(result.proof.otherManualHoldings, { tokens: ['33'], holdings: [0] });
    assert.deepEqual(f.state, before); assert.deepEqual(f.account, originalAccount);
    await assertPeriodAccountReady(result.account, { client: f.client, wallet, proof: f.proof });
    await assert.rejects(assertPeriodAccountReady(f.account), /inventory_open/);
});

test('absence of reviewed exclusions preserves strict period readiness and performs no extra reads', async () => {
    const f = fixture(); delete f.state.externalWalletActivity.zeroPayoutInventory;
    const result = await f.read();
    assert.equal(result.account, f.account); assert.equal(result.proof, null); assert.deepEqual(f.calls, []);
    await assert.rejects(assertPeriodAccountReady(result.account), /inventory_open/);
});

test('four-decimal API truncation and rounding preserve exact receipt and onchain units', async t => {
    const reviewed = () => {
        const f = fixture();
        f.approved.amounts[1] = f.amounts[1] = f.source.holdings[0] = 1.923077;
        const event = abi.encodeEventLog(abi.getEvent('TransferSingle'),
            [wallet, ethers.constants.AddressZero, wallet, '22', '1923077']);
        Object.assign(f.receipt.logs[0], event);
        return f;
    };
    for (const size of [1.923077, 1.923, 1.9231]) await t.test(`accepted API size ${size}`, async () => {
        const f = reviewed(); f.account.positions[0].size = size;
        const result = await f.read();
        assert.deepEqual(result.proof.inventory[0].holdings, [0, 1.923077]);
        assert.deepEqual(result.proof.inventory[0].amounts, [0, 1.923077]);
        assert.equal(result.proof.inventory[0].apiPositions[0].size, size);
    });
    for (const size of [1.9229, 1.9232, 1.923001, 1.923076, 1.923078, 1.923099])
        await t.test(`rejected API size ${size}`, async () => {
            const f = reviewed(); f.account.positions[0].size = size;
            await assert.rejects(f.read, /eligible_external_inventory_unproven/);
        });
    for (const field of ['chain', 'receipt']) await t.test(`one-unit ${field} mismatch remains rejected`, async () => {
        const f = reviewed(); f.account.positions[0].size = 1.923;
        if (field === 'chain') f.amounts[1] = 1.923078;
        else f.source.holdings[0] = 1.923078;
        await assert.rejects(f.read, /eligible_external_inventory_unproven/);
    });
});

test('normal read telemetry may advance while inventory ownership and accounting remain pinned', async () => {
    const f = fixture(), receipt = f.client.verifiedReceipt;
    f.client.verifiedReceipt = async (...args) => {
        Object.assign(f.state, { events: [{ type: 'endpoint_recovered' }], operational: { failures: 0 },
            diagnostics: { rpc: 'healthy' }, lastTickAt: f.now, lastHeartbeatAt: f.now });
        return receipt(...args);
    };
    const result = await f.read();
    assert.equal(result.proof.inventory[0].value, 0);
    assert.equal(f.state.events[0].type, 'endpoint_recovered');
});

test('inventory exclusion rejects winning, unresolved, unknown, unreviewed, pending and mismatched evidence', async t => {
    const changes = {
        'official winning payout': f => { f.payout = [0, 1]; },
        'approved winning holdings': f => { f.approved.payout = [0, 1]; },
        unresolved: f => { f.payout = null; },
        fractional: f => { f.approved.payout = f.payout = [0.5, 0.5]; },
        'missing review': f => { delete f.state.externalWalletActivity.reviewedAt; },
        'future review': f => { f.state.externalWalletActivity.reviewedAt = 1001; },
        'unknown position': f => { f.account.positions.push({ conditionId: hash('8'), tokenId: '44', size: 1 }); },
        'other manual holdings': f => { f.otherAmounts = [0.1]; },
        'new same-token inventory': f => { f.amounts = [0, 3.040817]; },
        'unreported winning balance': f => { f.amounts = [1, 2.040817]; },
        'missing API position': f => { f.account.positions = []; },
        'wrong API size': f => { f.account.positions[0].size = 2.0409; },
        'cross-token API substitution': f => { f.account.positions[0].tokenId = '11'; },
        'wrong API condition': f => { f.account.positions[0].conditionId = hash('8'); },
        'duplicate API position': f => { f.account.positions.push({ ...f.account.positions[0] }); },
        'noncanonical token pair': f => { f.approved.tokens[0] = '99'; },
        'bot token overlap': f => { f.state.completed[0].tokens[1] = '22'; },
        'bot condition overlap': f => { f.state.completed[0].conditionId = conditionId; },
        'bot position': f => { f.state.position = {}; },
        'pending order': f => { f.account.openOrders.push({ id: 'pending' }); },
        'pending manual trade': f => { f.account.checks[0].detail.trades = [{ conditionId, status: 'MATCHED' }]; },
        'unknown manual trade status': f => { f.account.checks[0].detail.trades = [{ tokenId: '22', status: 'UNKNOWN' }]; },
        'receipt sum mismatch': f => { f.source.holdings[0] = 2.040816; },
        'cross-token receipt mismatch': f => { f.source.tokenIds[0] = '11'; },
        'unlisted later movement': f => { f.state.externalWalletActivity.receipts.push({ ...f.source, hash: hash('6'), holdings: [-1, 0] }); },
        'duplicate approval receipt': f => { f.approved.receiptHashes.push(txHash); },
        'missing approval receipt': f => { f.approved.receiptHashes = [hash('6')]; },
        'unconfirmed receipt': f => { f.receipt.confirmations = 1; },
        'failed receipt': f => { f.receipt.status = 0; },
        'receipt block mismatch': f => { f.receipt.blockHash = hash('6'); },
        'removed receipt log': f => { f.receipt.logs[0].removed = true; },
        'canonical block changed': f => { f.client.rpc.anchor.hash = hash('6'); },
        'state mutation during proof': f => { const read = f.client.verifiedReceipt;
            f.client.verifiedReceipt = async (...args) => { f.state.cash = 3; return read(...args); }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
        const f = fixture(); change(f); await assert.rejects(f.read, /eligible_external_inventory_unproven/);
    });
});

test('pending unknown trade remains a global blocker even when manual inventory is proven', async () => {
    const f = fixture(); f.account.checks[0].detail.trades = [{ id: 'unknown', status: 'MATCHED' }];
    const result = await f.read();
    await assert.rejects(assertPeriodAccountReady(result.account, { client: f.client, wallet, proof: f.proof }), /trades_pending/);
});
