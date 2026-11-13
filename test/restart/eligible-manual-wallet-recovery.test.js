import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { Store } from '../../src/restart/store.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { ELIGIBLE_BUFFER_POLICY } from '../../src/eligible-live/entry-buffer.js';
import { prepareManualWalletRecovery, applyManualWalletRecovery,
    manualWalletRecoveryStateDigest } from '../../src/eligible-live/manual-wallet-recovery.js';
import { main, parseManualRecoveryArgs, loadManualWalletReview } from '../../scripts/eligible-reconcile-manual.js';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const wallet = `0x${'b'.repeat(40)}`, other = `0x${'c'.repeat(40)}`;
const blockHash = `0x${'d'.repeat(64)}`, checkpointHash = `0x${'e'.repeat(64)}`;
const encode = value => ethers.utils.defaultAbiCoder.encode(['uint256'], [value]);
const erc20 = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface(['function balanceOf(address,uint256) view returns (uint256)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)']);

function files(root) {
    return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name)).sort().map(file => [file, hash(fs.readFileSync(file))]);
}

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-manual-wallet-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: '0011223344556677', runtimeId: '8899aabbccddeeff',
        policy: { provider: 'eligible', continuousTrading: true },
        settings: { ...BASELINE, dataDir, wallet, privateKey: `0x${'1'.repeat(64)}`,
            continuousTrading: true, fingerprint: '0011223344556677' } };
    const store = new Store(config.settings, 'pilot', 'late-entry'), state = store.state;
    Object.assign(state, { startedAt: 1000, cash: 2.04043, peakEquity: 19.157402, maxDrawdown: 17.116972,
        lastEquity: 2.04043, walletStart: 2.540542, walletCashDelta: 0, decisionProvider: 'eligible',
        liveFunding: { initialCapital: 2.04043 }, ai: { providers: {}, snapshots: [{ pnl: 0 }], slots: {} },
        continuousOperation: { enabledAt: 2000, runtimeId: '1122334455667788' },
        stopped: { reason: 'wallet_ledger_mismatch', at: 3000 },
        entryHolds: { capital_deposit: { retryable: true, firstAt: 4000, failedAt: 4000, retryAt: 5000,
            attempts: 1, error: { code: 'capital_deposit_verifying', stage: 'capital_deposit' } } },
        reconciliationFaults: { wallet_ledger_mismatch: { count: 2, firstAt: 3000, lastAt: 5000, last: {} } },
        completed: [{ conditionId: `0x${'a'.repeat(64)}`, slug: 'bot-market', tokens: ['3', '4'], pnl: -.4,
            fees: 0, gas: 0, closedAt: 2500, traded: true, orders: [{ status: 'complete' }], actions: [{ status: 'confirmed' }] }],
        seen: { 'bot-market': true }, stopHistory: [{ reason: 'older_stop', recoveredAt: 2000 }],
        capitalFunding: { schema: 1, chainId: 137, tokenAddress: CONTRACTS.collateralToken.toLowerCase(),
            walletAddress: wallet, totalDeposited: 0, entries: {}, checkpoint: { blockNumber: 50, blockHash: checkpointHash } } });
    const approval = { schema: 1, reason: 'reviewed_manual_wallet_activity', periodId: config.id,
        runtimeId: config.runtimeId, previousRuntimeId: state.continuousOperation.runtimeId, wallet,
        stop: structuredClone(state.stopped), hold: structuredClone(state.entryHolds.capital_deposit),
        fault: structuredClone(state.reconciliationFaults.wallet_ledger_mismatch),
        checkpoint: { ...state.capitalFunding.checkpoint, balance: 2.540542 },
        expectedWalletBefore: 2.540542, expectedWalletAfter: 3.289398, cashDelta: .748856,
        tokenIds: ['1', '2'], zeroPayoutInventory: [], receipts: [
            { hash: `0x${'1'.repeat(64)}`, blockNumber: 60, blockHash: `0x${'6'.repeat(64)}`, cash: -1, holdings: [0, 2] },
            { hash: `0x${'2'.repeat(64)}`, blockNumber: 70, blockHash: `0x${'7'.repeat(64)}`, cash: 1.748856, holdings: [0, -2] },
        ] };
    config.manualWalletRecovery = approval;
    config.runtimeContinuation = { reason: 'user_entry_buffer', runtimeId: config.runtimeId, periodId: config.id,
        ledgerStartedAt: state.startedAt, fundingSha256: hash(JSON.stringify(state.liveFunding)),
        entryBufferMigration: { previousRuntimeId: state.continuousOperation.runtimeId } };
    const repin = () => { store.save(); approval.ledgerSha256 = hash(fs.readFileSync(store.filename));
        approval.stateSha256 = manualWalletRecoveryStateDigest(state); };
    repin(); fs.mkdirSync(path.join(dataDir, config.id, 'eligible-runtime'), { recursive: true });
    const receipts = new Map(approval.receipts.map(row => {
        const logs = [erc20.encodeEventLog(erc20.getEvent('Transfer'),
            [row.cash < 0 ? wallet : other, row.cash < 0 ? other : wallet, Math.round(Math.abs(row.cash) * 1e6)]),
        ctf.encodeEventLog(ctf.getEvent('TransferSingle'), [other, row.cash < 0 ? other : wallet,
            row.cash < 0 ? wallet : other, '2', 2000000])].map((log, index) => ({ ...log,
            address: index === 0 ? CONTRACTS.collateralToken : CONTRACTS.conditionalTokens,
            logIndex: index, blockNumber: row.blockNumber, blockHash: row.blockHash, transactionHash: row.hash }));
        return [row.hash, { transactionHash: row.hash, blockNumber: row.blockNumber, blockHash: row.blockHash,
            status: 1, confirmations: 20, logs }];
    }));
    const f = { config, store, state, approval, dataDir, receipts, repin, now: 10000,
        balance: 3.289398, checkpointBalance: 2540542, checkpointHoldings: 0,
        nonce: '0x2', pendingNonce: '0x2', safeNonce: 3, pendingSafeNonce: 3,
        blockNumber: 100, blockHash, positions: [], account: { orders: [], trades: [] }, calls: [], financialCalls: [] };
    const financial = name => () => { f.financialCalls.push(name); throw new Error('financial_write_forbidden'); };
    f.client = {
        confirmedBlock: async () => { f.calls.push('snapshot'); f.client.rpc.anchor = { number: f.blockNumber, hash: f.blockHash }; return f.blockNumber; },
        balance: async () => f.balance,
        verifiedReceipt: async (hash, block) => { assert.equal(block, f.blockNumber); f.calls.push('receipt'); return f.receipts.get(hash); },
        holdings: async (tokens, block) => { assert.equal(block, f.blockNumber); f.calls.push('holdings'); return tokens.map(() => 0); },
        ordersAndTrades: async () => { f.calls.push('orders'); return f.account; }, positions: async () => f.positions,
        rpc: { anchor: { number: 100, hash: blockHash }, read: async (stage, task, block, key) => {
            assert.equal(block, f.blockNumber);
            if (stage === 'eligible_manual_wallet_checkpoint') {
                f.checkpointReads ||= []; f.checkpointReads.push({ block, key });
            }
            return task({ send: async (method, params) => {
                if (method === 'eth_chainId') return f.chainId || '0x89';
                if (method === 'eth_getBlockByNumber') return { number: params[0], hash: params[0] === '0x32' ? f.checkpointHash || checkpointHash
                    : params[0] === '0x64' ? f.initialBlockHash || blockHash : f.blockHash };
                if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? f.pendingNonce : f.nonce;
                if (method === 'eth_call' && stage === 'eligible_manual_wallet_checkpoint') {
                    assert.equal(params[1], '0x32');
                    return encode(params[0].to === CONTRACTS.collateralToken ? f.checkpointBalance : f.checkpointHoldings);
                }
                if (method === 'eth_call') return encode(params[1] === 'pending' ? f.pendingSafeNonce : f.safeNonce);
                throw new Error('unexpected_rpc');
            } });
        } },
        prepare: financial('prepare'), post: financial('post'), prepareAction: financial('prepareAction'),
        broadcastAction: financial('broadcastAction'), cancel: financial('cancel'),
        prepareProfitTransfer: financial('prepareProfitTransfer'),
    };
    f.prepare = () => prepareManualWalletRecovery(config, state, f.client, { now: () => f.now });
    return f;
}

function addReceipt(f, row) {
    const logs = [];
    if (row.cash !== 0) logs.push({ address: CONTRACTS.collateralToken,
        ...erc20.encodeEventLog(erc20.getEvent('Transfer'), [row.cash < 0 ? wallet : other,
            row.cash < 0 ? other : wallet, Math.round(Math.abs(row.cash) * 1e6)]) });
    for (const [index, amount] of row.holdings.entries()) if (amount !== 0) {
        const token = (row.tokenIds || f.approval.tokenIds)[index];
        logs.push({ address: CONTRACTS.conditionalTokens,
            ...ctf.encodeEventLog(ctf.getEvent('TransferSingle'), [other,
                amount < 0 ? wallet : other, amount < 0 ? ethers.constants.AddressZero : wallet,
                token, Math.round(Math.abs(amount) * 1e6)]) });
    }
    f.receipts.set(row.hash, { transactionHash: row.hash, blockNumber: row.blockNumber, blockHash: row.blockHash,
        status: 1, confirmations: 20, logs: logs.map((log, index) => ({ ...log, logIndex: index,
            blockNumber: row.blockNumber, blockHash: row.blockHash, transactionHash: row.hash })) });
    f.approval.receipts.push(row);
}

function losingInventory(f) {
    const conditionId = `0x${'8'.repeat(64)}`;
    const market = new ethers.utils.Interface([
        'function getOutcomeSlotCount(bytes32) view returns (uint256)',
        'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
        'function getPositionId(address,bytes32) view returns (uint256)',
    ]);
    const source = f.approval.receipts[0]; source.holdings = [0, 2.040817];
    f.approval.receipts[1].holdings = [0, 0];
    const purchase = f.receipts.get(source.hash);
    purchase.logs[1] = { ...purchase.logs[1], ...ctf.encodeEventLog(ctf.getEvent('TransferSingle'),
        [other, other, wallet, '2', 2040817]) };
    f.receipts.get(f.approval.receipts[1].hash).logs.pop();
    f.approval.zeroPayoutInventory = [{ conditionId, slug: 'manual-loser', tokens: ['1', '2'],
        amounts: [0, 2.040817], payout: [1, 0], receiptHashes: [source.hash] }];
    f.positions = [{ conditionId, tokenId: '2', size: 2.0408, redeemable: true }];
    const read = f.client.rpc.read;
    f.client.rpc.read = async (stage, task, block, key) => {
        if (stage !== 'eligible_external_inventory_market') return read(stage, task, block, key);
        return task({ _isProvider: true, resolveName: async name => name, call: async transaction => {
            const { name, args } = market.parseTransaction(transaction);
            const value = name === 'getOutcomeSlotCount' ? 2 : name === 'getCollectionId'
                ? ethers.utils.hexZeroPad(args[2].toHexString(), 32) : Number(BigInt(args[1]));
            return market.encodeFunctionResult(name, [value]);
        } });
    };
    f.client.holdings = async tokens => tokens[0] === '1' ? [0, 2.040817] : tokens.map(() => 0);
    f.client.payoutAtBlock = async () => [1, 0];
}

async function additiveFixture(t, { loser = false } = {}) {
    const f = fixture(t);
    if (loser) losingInventory(f);
    applyManualWalletRecovery(f.store, await f.prepare(), { explicitApply: true });
    f.state.externalWalletActivity.receipts[0].retainedEvidence = { version: 'private-reviewed-field' };
    f.config.policy.entryFilter = structuredClone(ELIGIBLE_BUFFER_POLICY);
    f.state.continuousOperation.runtimeId = f.config.runtimeId;
    f.state.currentStrategyEpochId = 'abcdef1234567890';
    f.state.strategyEpochs = [{ id: f.state.currentStrategyEpochId, runtimeId: f.config.runtimeId,
        policy: structuredClone(f.config.policy) }];
    Object.assign(f.approval, { previousRuntimeId: f.config.runtimeId, stop: null, hold: null, fault: null,
        expectedWalletBefore: expectedWalletBalance(f.state), receipts: structuredClone(f.state.externalWalletActivity.receipts),
        tokenIds: loser ? ['2', '1'] : ['5', '2', '1'], zeroPayoutInventory: [] });
    if (loser) {
        addReceipt(f, { hash: `0x${'3'.repeat(64)}`, blockNumber: 80, blockHash: `0x${'8'.repeat(64)}`,
            cash: 0, holdings: [-2.040817, 0] });
    } else {
        addReceipt(f, { hash: `0x${'3'.repeat(64)}`, blockNumber: 80, blockHash: `0x${'8'.repeat(64)}`,
            cash: -1, holdings: [4, 0, 0] });
        addReceipt(f, { hash: `0x${'4'.repeat(64)}`, blockNumber: 90, blockHash: `0x${'9'.repeat(64)}`,
            cash: 2.25, holdings: [-4, 0, 0] });
        f.approval.cashDelta = 1.998856;
        f.approval.expectedWalletAfter = f.balance = 4.539398;
    }
    f.positions = []; f.client.holdings = async tokens => tokens.map(() => 0);
    f.now += 1000; f.repin(); f.calls.length = 0; f.checkpointReads = [];
    return f;
}

function autoBurn(f) {
    const receipt = f.receipts.get(f.approval.receipts.at(-1).hash), operator = CONTRACTS.autoRedeemOperator;
    receipt.logs = [
        [ctf, 'TransferBatch', [operator, wallet, operator, ['1', '2'], [0, 2040817]]],
        [ctf, 'TransferSingle', [operator, operator, ethers.constants.AddressZero, '2', 2040817]],
        [ctf, 'PayoutRedemption', [operator, '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
            ethers.constants.HashZero, `0x${'8'.repeat(64)}`, [1, 2], 0]],
        [erc20, 'Transfer', [ethers.constants.AddressZero, wallet, 0]],
    ].map(([abi, event, args], index) => ({ ...ctfLog(abi, event, args), logIndex: index,
        transactionHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber }));
    return receipt;
}

function ctfLog(abi, event, args) {
    return { ...abi.encodeEventLog(abi.getEvent(event), args),
        address: abi === ctf ? CONTRACTS.conditionalTokens : CONTRACTS.collateralToken };
}

test('additive BUFFER review preserves prior receipts and history while crediting only new cash', async t => {
    const f = await additiveFixture(t), before = structuredClone(f.state), bytes = fs.readFileSync(f.store.filename);
    const unchanged = ['stopped', 'entryHolds', 'reconciliationFaults', 'stopHistory'];
    const references = unchanged.map(key => f.state[key]);
    const review = await f.prepare();
    assert.equal(review.summary.oldExternalCashDelta, .748856);
    assert.equal(review.summary.newlyReviewedCashDelta, 1.25);
    assert.equal(review.summary.externalCashDelta, 1.998856);
    assert.equal(review.summary.newlyReviewedReceiptCount, 2);
    assert.equal(expectedWalletBalance(review.nextState), 4.539398);
    assert.deepEqual(review.nextState.externalWalletActivity.receipts.slice(0, 2), before.externalWalletActivity.receipts);
    assert.deepEqual(review.nextState.externalWalletActivity.receipts[2].tokenIds, ['5', '2', '1']);
    assert.deepEqual(review.nextState.manualWalletRecoveryHistory.slice(0, -1), before.manualWalletRecoveryHistory);
    assert.deepEqual(review.nextState.manualWalletRecoveryHistory.at(-1).previousExternalWalletActivity, before.externalWalletActivity);
    const result = applyManualWalletRecovery(f.store, review, { explicitApply: true });
    assert.deepEqual(fs.readFileSync(result.archivePath), bytes);
    for (const key of Object.keys(before)) if (!['externalWalletActivity', 'manualWalletRecoveryHistory'].includes(key))
        assert.deepEqual(f.state[key], before[key], key);
    unchanged.forEach((key, index) => assert.equal(f.state[key], references[index]));
    assert.deepEqual(f.financialCalls, []);
    await assert.rejects(f.prepare, /unproven/);
});

test('additive review rejects altered history, double credit and reused bot provenance before network reads', async t => {
    const changes = {
        'missing old receipt': f => { f.approval.receipts.shift(); },
        'changed old cash': f => { f.approval.receipts[0].cash++; },
        'changed old block': f => { f.approval.receipts[0].blockNumber++; },
        'changed old token order': f => { f.approval.receipts[0].tokenIds.reverse(); },
        'removed old metadata': f => { delete f.approval.receipts[0].retainedEvidence; },
        'no new receipts': f => { f.approval.receipts.splice(2); },
        'duplicate new receipt': f => { f.approval.receipts.push(f.approval.receipts[2]); },
        'old aggregate corrupt': f => { f.state.externalWalletActivity.cashDelta = .748857; f.repin(); },
        'old receipt now bot settlement': f => { f.state.settlementEvidence = { old: { source: 'receipt', hash: f.approval.receipts[0].hash } }; f.repin(); },
        'old receipt now bot fill': f => { f.state.completed[0].fills = [{ hash: f.approval.receipts[0].hash }]; f.repin(); },
        'old receipt now deposit': f => { f.state.capitalFunding.entries.old = { txHash: f.approval.receipts[0].hash }; f.repin(); },
        'wrong epoch runtime': f => { f.state.strategyEpochs[0].runtimeId = '1111111111111111'; f.repin(); },
        'wrong epoch id': f => { f.state.currentStrategyEpochId = '1111111111111111'; f.repin(); },
        'wrong BUFFER policy': f => { delete f.config.policy.entryFilter; },
        'unexpected stop': f => { f.state.stopped = { reason: 'manual_stop', at: 9000 }; f.repin(); },
        'unexpected hold': f => { f.state.entryHolds.other = {}; f.repin(); },
        'unexpected fault': f => { f.state.reconciliationFaults.other = {}; f.repin(); },
        'unapproved prior stop': f => { f.approval.stop = { reason: 'wallet_ledger_mismatch', at: 3000 }; },
        'double credit': f => { f.approval.expectedWalletAfter = 5.288254; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = await additiveFixture(t); change(f);
        const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.calls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    });
});

test('old receipt revalidation includes newly added aggregate tokens', async t => {
    const f = await additiveFixture(t), receipt = f.receipts.get(f.approval.receipts[0].hash);
    receipt.logs.push({ ...receipt.logs[1], logIndex: 2,
        ...ctf.encodeEventLog(ctf.getEvent('TransferSingle'), [other, other, wallet, '5', 1]) });
    await assert.rejects(f.prepare, /unproven/);
});

test('previously reviewed losing inventory may be canonically burned without cash credit', async t => {
    for (const automatic of [false, true]) await t.test(automatic ? 'automatic operator burn' : 'direct wallet burn', async t => {
        const f = await additiveFixture(t, { loser: true });
        if (automatic) autoBurn(f);
        const before = structuredClone(f.state), review = await f.prepare();
        assert.equal(review.summary.newlyReviewedCashDelta, 0);
        assert.deepEqual(review.nextState.externalWalletActivity.zeroPayoutInventory, []);
        applyManualWalletRecovery(f.store, review, { explicitApply: true });
        assert.deepEqual(f.state.manualWalletRecoveryHistory.at(-1).previousExternalWalletActivity, before.externalWalletActivity);
        assert.equal(expectedWalletBalance(f.state), expectedWalletBalance(before));
        assert.equal(f.state.cash, before.cash); assert.deepEqual(f.financialCalls, []);
    });
});

test('losing inventory cannot disappear through an arbitrary transfer or unbound automatic redemption', async t => {
    const changes = {
        'third party recipient': r => { r.logs[0] = { ...r.logs[0], ...ctfLog(ctf, 'TransferBatch',
            [CONTRACTS.autoRedeemOperator, wallet, other, ['1', '2'], [0, 2040817]]) }; },
        'missing burn': r => { r.logs.splice(1, 1); },
        'wrong burn amount': r => { r.logs[1].data = ctfLog(ctf, 'TransferSingle',
            [CONTRACTS.autoRedeemOperator, CONTRACTS.autoRedeemOperator, ethers.constants.AddressZero, '2', 2040816]).data; },
        'wrong condition': r => { r.logs[2].data = ctfLog(ctf, 'PayoutRedemption',
            [CONTRACTS.autoRedeemOperator, '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
                ethers.constants.HashZero, `0x${'9'.repeat(64)}`, [1, 2], 0]).data; },
        'missing payout': r => { r.logs.splice(2, 1); },
        'wrong wallet mint': r => { r.logs[3] = { ...r.logs[3], ...ctfLog(erc20, 'Transfer', [ethers.constants.AddressZero, other, 0]) }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = await additiveFixture(t, { loser: true }), receipt = autoBurn(f); change(receipt);
        const before = structuredClone(f.state); await assert.rejects(f.prepare, /unproven/); assert.deepEqual(f.state, before);
    });
});

test('large token unions use individually bounded original-checkpoint reads', async t => {
    const f = await additiveFixture(t);
    for (const row of f.approval.receipts.slice(2)) row.tokenIds = [...f.approval.tokenIds];
    f.approval.tokenIds.push(...Array.from({ length: 16 }, (_, index) => String(index + 100)));
    await f.prepare();
    const reads = f.checkpointReads;
    assert.equal(reads.length, f.approval.tokenIds.length + 3);
    assert.equal(new Set(reads.map(row => row.key)).size, reads.length);
    assert(reads.every(row => row.block === 100 && row.key.startsWith(`manual_checkpoint:50:${checkpointHash}:`)));
    const read = f.client.rpc.read;
    f.client.rpc.read = async (stage, task, block, key) => {
        if (key?.endsWith(':after')) f.checkpointHash = blockHash;
        return read(stage, task, block, key);
    };
    await assert.rejects(f.prepare, /unproven/);
});

test('additive reviews retain final order, nonce and wallet snapshot guards', async t => {
    const changes = {
        'open order': f => { f.account.orders.push({ id: 'external' }); },
        'pending signer': f => { f.pendingNonce = '0x3'; },
        'final balance changed': f => { let reads = 0; f.client.balance = async () => f.balance + (++reads === 2 ? .000001 : 0); },
        'final Safe changed': f => { f.client.ordersAndTrades = async () => { f.safeNonce = f.pendingSafeNonce = 4; return f.account; }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = await additiveFixture(t); change(f); const before = structuredClone(f.state);
        await assert.rejects(f.prepare, /unproven|transactions_pending/); assert.deepEqual(f.state, before);
    });
});

test('exact reviewed receipts reconcile external wallet cash and preserve all bot accounting', async t => {
    const f = fixture(t), before = structuredClone(f.state), disk = files(f.dataDir), bytes = fs.readFileSync(f.store.filename);
    const review = await f.prepare();
    assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk); assert.deepEqual(f.financialCalls, []);
    assert.equal(review.summary.externalCashDelta, .748856); assert.equal(review.summary.financialWrites, false);
    assert.equal(expectedWalletBalance(review.nextState), 3.289398);
    assert.equal(review.nextState.externalWalletActivity.capitalAllocated, 0);
    assert.deepEqual(review.nextState.stopHistory.at(-1).originalFault, before.reconciliationFaults.wallet_ledger_mismatch);
    assert.throws(() => applyManualWalletRecovery(f.store, review), /unproven/);
    const result = applyManualWalletRecovery(f.store, review, { explicitApply: true });
    assert.deepEqual(fs.readFileSync(result.archivePath), bytes);
    assert.equal(fs.statSync(result.archivePath).mode & 0o777, 0o400);
    const allowed = new Set(['externalWalletActivity', 'stopped', 'entryHolds', 'reconciliationFaults', 'stopHistory', 'manualWalletRecoveryHistory']);
    for (const key of Object.keys(before)) if (!allowed.has(key)) assert.deepEqual(f.state[key], before[key], key);
    assert.equal(f.state.stopped, null); assert.deepEqual(f.state.entryHolds, {}); assert.deepEqual(f.state.reconciliationFaults, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filename)), f.state);
    assert.throws(() => applyManualWalletRecovery(f.store, review, { explicitApply: true }), /unproven/);
    await assert.rejects(f.prepare, /unproven/);
});

test('redemption may emit an unlisted zero counterpart, while nonzero unlisted movement blocks review', async t => {
    const f = fixture(t), receipt = f.receipts.get(f.approval.receipts[1].hash);
    const encoded = ctf.encodeEventLog(ctf.getEvent('TransferBatch'), [other, wallet, other, ['99', '2'], [0, 2000000]]);
    receipt.logs[1] = { ...receipt.logs[1], ...encoded };
    const review = await f.prepare();
    assert.deepEqual(review.nextState.externalWalletActivity.receipts[1].holdings, [0, -2]);
    receipt.logs[1] = { ...receipt.logs[1], ...ctf.encodeEventLog(ctf.getEvent('TransferBatch'),
        [other, wallet, other, ['99', '2'], [1, 2000000]]) };
    await assert.rejects(f.prepare, /unproven/);
});

test('manual holdings are freshly proven at the final block even when wallet and nonces stay unchanged', async t => {
    const f = fixture(t);
    f.client.ordersAndTrades = async () => {
        f.blockNumber = 101; f.blockHash = `0x${'9'.repeat(64)}`; return f.account;
    };
    // Account reads precede the final snapshot; preserve that first anchor until snapshot().
    f.client.holdings = async (_tokens, block) => {
        assert.equal(block, f.client.rpc.anchor.number); return [0, 0];
    };
    const review = await f.prepare();
    assert.equal(review.nextState.externalWalletActivity.walletProof.manualHoldingsProof.blockNumber, 101);
    assert.equal(review.nextState.externalWalletActivity.walletProof.externalInventory.blockNumber, 101);
    f.blockNumber = 100; f.blockHash = blockHash;
    f.client.holdings = async (tokens, block) => tokens[0] === '1' && block === 101 ? [0, 1] : [0, 0];
    await assert.rejects(f.prepare, /unproven/);
});

test('reviewed losing external inventory remains zero value and never enters bot equity', async t => {
    const f = fixture(t), conditionId = `0x${'8'.repeat(64)}`;
    const market = new ethers.utils.Interface([
        'function getOutcomeSlotCount(bytes32) view returns (uint256)',
        'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
        'function getPositionId(address,bytes32) view returns (uint256)',
    ]);
    const source = f.approval.receipts[0]; source.holdings = [0, 2.040817];
    f.approval.receipts[1].holdings = [0, 0];
    const purchase = f.receipts.get(source.hash);
    purchase.logs[1] = { ...purchase.logs[1], ...ctf.encodeEventLog(ctf.getEvent('TransferSingle'),
        [other, other, wallet, '2', 2040817]) };
    f.receipts.get(f.approval.receipts[1].hash).logs.pop();
    f.approval.zeroPayoutInventory = [{ conditionId, slug: 'manual-loser', tokens: ['1', '2'],
        amounts: [0, 2.040817], payout: [1, 0], receiptHashes: [source.hash] }];
    f.positions = [{ conditionId, tokenId: '2', size: 2.0408, redeemable: true }];
    const read = f.client.rpc.read;
    f.client.rpc.read = async (stage, task, block) => {
        if (stage !== 'eligible_external_inventory_market') return read(stage, task, block);
        return task({ _isProvider: true, resolveName: async name => name, call: async transaction => {
            const { name, args } = market.parseTransaction(transaction);
            const value = name === 'getOutcomeSlotCount' ? 2 : name === 'getCollectionId'
                ? ethers.utils.hexZeroPad(args[2].toHexString(), 32) : Number(BigInt(args[1]));
            return market.encodeFunctionResult(name, [value]);
        } });
    };
    f.client.holdings = async tokens => tokens[0] === '1' ? [0, 2.040817] : tokens.map(() => 0);
    f.client.payoutAtBlock = async () => [1, 0];
    const before = structuredClone(f.state), review = await f.prepare();
    assert.equal(review.nextState.externalWalletActivity.walletProof.externalInventory.inventory[0].value, 0);
    assert.deepEqual(review.nextState.externalWalletActivity.zeroPayoutInventory, f.approval.zeroPayoutInventory);
    applyManualWalletRecovery(f.store, review, { explicitApply: true });
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'lastEquity', 'capitalFunding', 'completed', 'seen'])
        assert.deepEqual(f.state[key], before[key]);
    assert.equal(f.state.position, null); assert.deepEqual(f.financialCalls, []);
});

test('full ledger and exact private incident pins reject altered or owned activity before any network read', async t => {
    const changes = {
        'missing review': f => { delete f.config.manualWalletRecovery; },
        'ledger bytes changed': f => fs.appendFileSync(f.store.filename, '\n'),
        'cash changed': f => { f.state.cash++; },
        'unknown accounting changed': f => { f.state.futureAccounting = 1; },
        'state hash wrong': f => { f.approval.stateSha256 = 'a'.repeat(64); },
        'wrong wallet': f => { f.approval.wallet = other; },
        'wrong provider': f => { f.config.policy.provider = 'other'; },
        'continuous disabled': f => { f.config.settings.continuousTrading = false; },
        'wrong predecessor': f => { f.config.runtimeContinuation.entryBufferMigration.previousRuntimeId = f.config.runtimeId; },
        'external loss exceeds cash': f => { f.state.cash = 4; f.repin(); },
        'other stop pinned': f => { f.state.stopped.reason = f.approval.stop.reason = 'manual_stop'; f.repin(); },
        'other hold pinned': f => { f.state.entryHolds.other = {}; f.repin(); },
        'other fault pinned': f => { f.state.reconciliationFaults.other = {}; f.repin(); },
        'position pinned': f => { f.state.position = {}; f.repin(); },
        'risk stop pinned': f => { f.state.liveRiskStop = { reason: 'drawdown_limit' }; f.repin(); },
        'withdrawal pinned': f => { f.state.profitTaking = { pending: {} }; f.repin(); },
        'control operation pinned': f => { f.state.profitTakingControl = { operation: {} }; f.repin(); },
        'provider pending pinned': f => { f.state.ai.providers.eligible = { pending: true }; f.repin(); },
        'unknown bot action pinned': f => { f.state.completed[0].actions[0].status = 'unknown'; f.repin(); },
        'unknown bot order pinned': f => { f.state.completed[0].orders[0].status = 'unknown'; f.repin(); },
        'bot-owned token pinned': f => { f.state.completed[0].tokens[0] = '1'; f.repin(); },
        'bot-owned receipt pinned': f => { f.state.completed[0].fills = [{ hash: f.approval.receipts[0].hash }]; f.repin(); },
        'duplicate receipt': f => { f.approval.receipts.push(f.approval.receipts[0]); },
        'pre-checkpoint receipt': f => { f.approval.receipts[0].blockNumber = 49; },
        'cash sum mismatch': f => { f.approval.cashDelta += .000001; },
        'balance mismatch': f => { f.approval.expectedWalletAfter += .000001; },
        'unapproved manual inventory': f => { f.approval.receipts[1].holdings[1] = -1; },
        'already external pinned': f => { f.state.externalWalletActivity = { receipts: [], cashDelta: 0 }; f.repin(); },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); const before = structuredClone(f.state), disk = files(f.dataDir);
        await assert.rejects(f.prepare); assert.deepEqual(f.calls, []); assert.deepEqual(f.financialCalls, []);
        assert.deepEqual(f.state, before); assert.deepEqual(files(f.dataDir), disk);
    });
});

test('canonical receipt, checkpoint, account, nonce and audit failures keep the incident intact', async t => {
    const changes = {
        'current wallet mismatch': f => { f.balance += .000001; },
        'checkpoint balance mismatch': f => { f.checkpointBalance++; },
        'checkpoint wrong chain': f => { f.chainId = '0x1'; },
        'checkpoint reorg': f => { f.checkpointHash = blockHash; },
        'checkpoint preexisting tokens': f => { f.checkpointHoldings = 1; },
        'receipt missing': f => { f.receipts.delete(f.approval.receipts[0].hash); },
        'receipt failed': f => { f.receipts.values().next().value.status = 0; },
        'receipt identity': f => { f.receipts.values().next().value.transactionHash = blockHash; },
        'receipt unconfirmed': f => { f.receipts.values().next().value.confirmations = 1; },
        'receipt block hash': f => { f.receipts.values().next().value.blockHash = blockHash; },
        'receipt cash altered': f => { f.receipts.values().next().value.logs[0].data = encode(999999); },
        'duplicate receipt log': f => { const r = f.receipts.values().next().value; r.logs.push(r.logs[0]); },
        'removed receipt log': f => { f.receipts.values().next().value.logs[0].removed = true; },
        'foreign receipt log': f => { f.receipts.values().next().value.logs[0].transactionHash = blockHash; },
        'unknown inventory': f => { f.positions = [{ tokenId: '99', size: 1 }]; },
        'open order': f => { f.account.orders.push({ id: 'unowned' }); },
        'pending trade': f => { f.account.trades.push({ status: 'RETRYING' }); },
        'pending signer': f => { f.pendingNonce = '0x3'; },
        'pending Safe': f => { f.pendingSafeNonce++; },
        'bot holdings': f => { f.client.holdings = async tokens => tokens[0] === '3' ? [0, 1] : [0, 0]; },
        'manual holdings': f => { f.client.holdings = async tokens => tokens[0] === '1' ? [0, 1] : [0, 0]; },
        'audit expired': f => { f.client.verifiedReceipt = async () => { f.now += 600001; return null; }; },
        'final proof expired': f => { f.client.ordersAndTrades = async () => { f.now += 30001; return f.account; }; },
        'final balance changed': f => { let calls = 0; f.client.balance = async () => f.balance + (++calls === 2 ? .000001 : 0); },
        'final signer completed': f => { f.client.ordersAndTrades = async () => { f.nonce = f.pendingNonce = '0x3'; return f.account; }; },
        'final Safe completed': f => { f.client.ordersAndTrades = async () => { f.safeNonce = f.pendingSafeNonce = 4; return f.account; }; },
        'state changed during proof': f => { f.client.ordersAndTrades = async () => { f.state.cash++; return f.account; }; },
        'disk changed during proof': f => { f.client.ordersAndTrades = async () => { fs.appendFileSync(f.store.filename, '\n'); return f.account; }; },
        'config changed during proof': f => { f.client.ordersAndTrades = async () => { f.config.settings.wallet = other; return f.account; }; },
        'clock backwards': f => { f.client.ordersAndTrades = async () => { f.now--; return f.account; }; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
        const f = fixture(t); change(f); await assert.rejects(f.prepare);
        assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch'); assert.equal(f.state.stopHistory.length, 1);
        assert.equal(f.state.externalWalletActivity, undefined); assert.deepEqual(f.financialCalls, []);
    });
});

test('apply rejects mutation, expiration, counterfeit review and save failure', async t => {
    for (const [name, change] of Object.entries({
        expired: (f) => { f.now += 30001; },
        summary: (_f, r) => { r.summary.cash++; },
        next: (_f, r) => { r.nextState.cash++; },
        state: f => { f.state.cash++; },
        disk: f => { fs.appendFileSync(f.store.filename, '\n'); },
    })) await t.test(name, async t => {
        const f = fixture(t), review = await f.prepare(); change(f, review);
        assert.throws(() => applyManualWalletRecovery(f.store, review, { explicitApply: true }));
        assert.equal(f.state.externalWalletActivity, undefined);
    });
    const f = fixture(t), before = structuredClone(f.state), review = await f.prepare();
    assert.throws(() => applyManualWalletRecovery(f.store, structuredClone(review), { explicitApply: true }));
    f.store.save = () => { throw new Error('save_failed'); };
    assert.throws(() => applyManualWalletRecovery(f.store, review, { explicitApply: true }), /save_failed/);
    assert.deepEqual(f.state, before);
});

test('CLI defaults to review, requires explicit apply, and securely loads a separate private review', async t => {
    assert.deepEqual(parseManualRecoveryArgs([]), { apply: false });
    assert.deepEqual(parseManualRecoveryArgs(['--apply']), { apply: true });
    for (const args of [['--live'], ['--apply', '--live'], ['--force']]) assert.throws(() => parseManualRecoveryArgs(args));
    const f = fixture(t), filename = path.join(f.dataDir, 'review.json');
    fs.writeFileSync(filename, JSON.stringify(f.approval), { mode: 0o600 });
    const loaded = loadManualWalletReview(f.config, filename);
    assert.deepEqual(loaded.manualWalletRecovery, f.approval);
    assert.equal(loaded.manualWalletReviewFile.sha256, hash(fs.readFileSync(filename)));
    fs.chmodSync(filename, 0o644); assert.throws(() => loadManualWalletReview(f.config, filename), /unsafe/);
    assert.throws(() => loadManualWalletReview(f.config, 'relative.json'), /required/);
    fs.chmodSync(filename, 0o600);
    const calls = [], output = [];
    const dependencies = { loadConfig: () => f.config, acquireLock: async () => () => { calls.push('release'); },
        readHistory: () => [f.state], storeFactory: () => f.store,
        clientFactory: () => ({ close: () => { calls.push('close'); } }),
        prepare: async () => ({ summary: { ready: true } }),
        apply: (_s, _r, options) => { assert.deepEqual(options, { explicitApply: true }); calls.push('apply'); return { ready: true }; },
        write: value => output.push(value) };
    assert.equal(await main([], dependencies), 0); assert.deepEqual(calls, ['close', 'release']);
    calls.length = 0;
    assert.equal(await main(['--apply'], dependencies), 0); assert.deepEqual(calls, ['apply', 'close', 'release']);
    assert.equal(output[0].applied, false); assert.equal(output[1].automaticActivation, false);
});
