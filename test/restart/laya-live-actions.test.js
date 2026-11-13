import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { ctfMergePositionsCall, ctfRedeemPositionsCall } from '@polymarket/client';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { persistedActionIdentity, verifyActionReceipt } from '../../src/laya-live/actions.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { BASELINE } from '../../src/restart/config.js';
import { OperationalError } from '../../src/restart/network.js';
import { Engine } from '../../src/restart/engine.js';

const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
const conditionId = '0x' + 'e'.repeat(64), blockHash = '0x' + 'c'.repeat(64);
const protocolHash = '0x' + 'b'.repeat(64), orderId = '0x' + 'd'.repeat(64);
const zero = ethers.constants.AddressZero, zeroHash = ethers.constants.HashZero;
const signer = new ethers.Wallet('0x' + '7'.repeat(64)); // Offline fixture key only.
const safe = new ethers.utils.Interface([
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
    'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const fields = [ ['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256'] ].map(([name, type]) => ({ name, type }));
const log = (iface, event, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(event), args) });
const cash = (from, to, value, index) => log(erc20, 'Transfer', CONTRACTS.collateralToken, [from, to, value], index);
const token = (from, to, id, value, index, operator = other) => log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens,
    [operator, from, to, id, value], index);
const now = 1780000300000, quantity = 5063290;

async function signedAction(kind = 'redeem', overrides = {}) {
    const amount = kind === 'redeem' ? 0 : 2;
    const call = kind === 'redeem' ? ctfRedeemPositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, conditionId)
        : ctfMergePositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, conditionId, 2000000n);
    const message = { to: call.to, value: 0, data: call.data, operation: 0, safeTxGas: 0, baseGas: 0,
        gasPrice: 0, gasToken: zero, refundReceiver: zero, nonce: '7', ...overrides.safe };
    const safeHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message);
    const sig = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(safeHash)));
    const signatures = ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
    const data = safe.encodeFunctionData('execTransaction', fields.filter(row => row.name !== 'nonce').map(row => message[row.name]).concat(signatures));
    const raw = await signer.signTransaction({ to: wallet, data, gasLimit: 500000, gasPrice: 30000000000,
        chainId: 137, nonce: 11, value: 0, ...overrides.tx });
    return { safeHash, action: { kind, amount, hash: ethers.utils.keccak256(raw), raw, safeNonce: message.nonce,
        polUsd: .1, status: 'unknown', createdAt: now - 180000, ...overrides.action } };
}
function ownReceipt(action, safeHash, { movement = true, kind = action.kind, status = 1, event = 'ExecutionSuccess' } = {}) {
    const logs = movement ? kind === 'merge'
        ? [token(wallet, zero, '1', 2000000, 10), token(wallet, zero, '2', 2000000, 11), cash(zero, wallet, 2000000, 12)]
        : [token(wallet, zero, '2', quantity, 10), cash(zero, wallet, quantity, 11)] : [];
    if (status === 1) logs.push(log(safe, event, wallet, [safeHash, 0], 20));
    return { transactionHash: action.hash, to: wallet, from: signer.address, blockHash, blockNumber: 100,
        confirmations: 3, status, transactionIndex: 2, logs,
        gasUsed: ethers.BigNumber.from(100000), effectiveGasPrice: ethers.BigNumber.from(30000000000) };
}
function protocolReceipt() {
    const operator = CONTRACTS.autoRedeemOperator;
    return { transactionHash: protocolHash, blockHash, blockNumber: 99, confirmations: 4, status: 1, transactionIndex: 1,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, quantity]], 10),
            token(operator, zero, '2', quantity, 11, operator),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', zeroHash, conditionId, [1, 2], quantity], 13),
            cash(zero, wallet, quantity, 16)] };
}
async function fixture({ kind = 'redeem', stopped = true, protocol = false, own = null } = {}) {
    const signed = await signedAction(kind), events = [], calls = { receipts: [] };
    const position = { market: { tokens: ['1', '2'], conditionId, negRisk: false, end: now - 1000 }, openedAt: now - 200000,
        holdings: kind === 'merge' ? [2, 2] : [0, quantity / 1e6], bought: [0, quantity / 1e6], receipts: {}, fills: [],
        orders: [{ orderId, tokenId: '2', index: 1, side: 'BUY', kind: 'taker', price: .79, shares: 5,
            settled: quantity / 1e6, filled: quantity / 1e6, status: 'complete', receiptProvenComplete: true }],
        actions: [signed.action], payout: [0, 1], entryCost: 4, fees: .05, gas: 0, pendingTrades: false };
    const stop = { reason: 'unknown_transaction', at: now - 100000 };
    const state = { cash: 16, walletCashDelta: -4, walletStart: 20, position, failures: 1, stopped: stopped ? stop : null };
    const store = { state, save() {}, event(type, detail) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: now }; } };
    const client = { confirmedBlock: async () => 100, ordersAndTrades: async () => ({ orders: [], trades: [] }),
        verifiedReceipt: async (hash, block) => { assert.equal(block, 100); calls.receipts.push(hash);
            return hash === protocolHash ? protocolReceipt() : own === 'success' ? ownReceipt(signed.action, signed.safeHash) : own; },
        listAutoRedemptions: async () => protocol ? [protocolHash] : [],
        payoutAtBlock: async () => [0, 1],
        prepareAction: async () => assert.fail('Reconciliation must not prepare an action or allocate a new nonce'),
        broadcastAction: async () => assert.fail('Reconciliation must not broadcast'),
        prepare: async () => assert.fail('Reconciliation must not prepare an entry'),
        post: async () => assert.fail('Reconciliation must not submit an entry') };
    const broker = new LayaLiveBroker({ ...BASELINE, wallet }, store, client, async () => {});
    broker.reconcileBlock = 100;
    return { ...signed, position, state, store, client, broker, events, calls, stop };
}

test('protocol payout settles while the exact own redemption remains unknown, stopped and blocking new actions', async () => {
    const f = await fixture({ protocol: true });
    let saved;
    f.store.save = () => { saved = structuredClone(f.state); };
    f.client.verifiedReceipt = async (hash, block) => {
        assert.equal(block, 100); f.calls.receipts.push(hash);
        if (hash === protocolHash) return protocolReceipt();
        assert.deepEqual(f.position.holdings, [0, 0], 'Protocol proof must settle before reading the own action');
        return null;
    };
    await f.broker.reconcile(null, now);
    assert.equal(f.state.cash, 21.06329); assert.equal(f.state.walletCashDelta, 1.06329);
    assert.deepEqual(f.position.holdings, [0, 0]); assert.equal(f.position.gas, 0);
    assert.equal(f.action.status, 'unknown'); assert.equal(f.action.raw.startsWith('0x'), true);
    assert.equal(f.position.actions.filter(action => action.source === 'protocol_auto').length, 1);
    assert.equal(f.position.receipts[protocolHash].transactionIndex, 1);
    assert.deepEqual(f.state.stopped, f.stop); assert.equal(f.broker.pending(), true);
    assert.equal(await f.broker.action('merge', 1, now), false);
    assert.equal(saved.position.actions[0].receiptRetry.nextAt, now + 5000);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 2000);
    assert.deepEqual(f.calls.receipts, [protocolHash, f.action.hash]); assert.equal(f.state.cash, 21.06329);
});

test('a later successful zero-movement own redemption accounts gas exactly once after verified protocol payout', async () => {
    const f = await fixture({ protocol: true });
    await f.broker.reconcile(null, now);
    f.client.verifiedReceipt = async () => ownReceipt(f.action, f.safeHash, { movement: false });
    await f.broker.reconcile(null, now + 5000);
    assert.equal(f.action.status, 'confirmed'); assert.equal(f.position.gas, .0003); assert.equal(f.state.cash, 21.06299);
    assert.equal(f.state.walletCashDelta, 1.06329); assert.deepEqual(f.position.holdings, [0, 0]);
    assert.equal(f.action.raw, undefined); assert.equal(f.action.receiptEvidence.safeHash, f.safeHash.toLowerCase());
    assert.equal(f.position.receipts[f.action.hash].cash, 0); assert.deepEqual(f.state.stopped, f.stop);
    const before = structuredClone(f.state);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 6000); assert.deepEqual(f.state, before);
});

test('canonical ordinary redemption and merge retain their exact movements and gas accounting', async () => {
    for (const kind of ['redeem', 'merge']) {
        const f = await fixture({ kind, own: 'success', stopped: false });
        await f.broker.reconcileActions(now);
        assert.equal(f.action.status, 'confirmed', kind); assert.equal(f.position.gas, .0003, kind);
        assert.equal(f.state.cash, kind === 'redeem' ? 21.06299 : 17.9997, kind);
        assert.deepEqual(f.position.holdings, [0, 0], kind); assert.equal(f.state.stopped, null);
        const before = structuredClone(f.state);
        await f.broker.reconcileActions(now + 60000); assert.deepEqual(f.state, before);
    }
});

test('only canonical terminal outer revert or exact Safe failure accounts failed-action gas once', async () => {
    for (const status of [0, 1]) {
        const f = await fixture();
        f.client.verifiedReceipt = async () => ownReceipt(f.action, f.safeHash,
            { status, event: 'ExecutionFailure', movement: false });
        await f.broker.reconcileActions(now);
        assert.equal(f.action.status, 'failed'); assert.equal(f.state.failures, 2); assert.equal(f.state.cash, 15.9997);
        assert.equal(f.position.gas, .0003); assert.equal(f.state.walletCashDelta, -4);
        assert.deepEqual(f.position.holdings, [0, 5.06329]); assert.deepEqual(f.state.stopped, f.stop);
        const before = structuredClone(f.state);
        await f.broker.reconcileActions(now + 60000); assert.deepEqual(f.state, before);
    }
});

test('wrong raw action identity, Safe payload, nonce, signer, network and chain cannot authorize accounting', async () => {
    for (const fault of ['raw_hash', 'safe_nonce', 'inner_condition', 'operation', 'chain', 'target', 'value', 'signature']) {
        const f = await fixture();
        if (fault === 'raw_hash') f.action.hash = protocolHash;
        if (fault === 'safe_nonce') f.action.safeNonce = '8';
        const changes = fault === 'inner_condition' ? { safe: { data: '0x' } }
            : fault === 'operation' ? { safe: { operation: 1 } }
                : fault === 'chain' ? { tx: { chainId: 1 } }
                    : fault === 'target' ? { tx: { to: other } }
                        : fault === 'value' ? { tx: { value: 1 } } : null;
        if (changes) Object.assign(f.action, (await signedAction('redeem', changes)).action);
        if (fault === 'signature') {
            const tx = ethers.utils.parseTransaction(f.action.raw), args = safe.decodeFunctionData('execTransaction', tx.data);
            const signature = await new ethers.Wallet('0x' + '8'.repeat(64)).signMessage(ethers.utils.arrayify(f.safeHash));
            const split = ethers.utils.splitSignature(signature);
            const data = safe.encodeFunctionData('execTransaction', [...args].slice(0, 9)
                .concat(ethers.utils.hexConcat([split.r, split.s, ethers.utils.hexlify(split.v + 4)])));
            f.action.raw = await signer.signTransaction({ to: wallet, data, chainId: 137, nonce: 11, gasLimit: 500000, gasPrice: 30000000000 });
            f.action.hash = ethers.utils.keccak256(f.action.raw);
        }
        assert.equal(persistedActionIdentity({ position: f.position, wallet, action: f.action }), null, fault);
        await f.broker.reconcileActions(now);
        assert.equal(f.state.cash, 16, fault); assert.equal(f.position.gas, 0, fault);
        assert.equal(f.action.status, 'unknown', fault); assert.equal(f.calls.receipts.length, 0, fault);
        assert.equal(f.state.reconciliationFaults.action_receipt_unconfirmed.count, 1, fault);
    }
});

test('invalid receipt proofs never book gas and paced rechecks remain idempotent', async () => {
    const mutations = {
        hash: receipt => { receipt.transactionHash = protocolHash; },
        from: receipt => { receipt.from = other; }, to: receipt => { receipt.to = other; },
        blockHash: receipt => { receipt.blockHash = 'bad'; },
        future: receipt => { receipt.blockNumber = 101; }, confirmations: receipt => { receipt.confirmations = 1; },
        safeHash: receipt => { receipt.logs[2] = log(safe, 'ExecutionSuccess', wallet, [zeroHash, 0], 20); },
        missingSafe: receipt => { receipt.logs.pop(); },
        doubleSafe: receipt => { receipt.logs.push(log(safe, 'ExecutionSuccess', wallet, [receipt.logs[2] && zeroHash, 0], 21)); },
        payment: receipt => { receipt.logs[2] = log(safe, 'ExecutionSuccess', wallet, [receipt.safeHash || zeroHash, 1], 20); },
        movement: receipt => { receipt.logs[1] = cash(zero, wallet, quantity - 1, 11); },
        removed: receipt => { receipt.logs[0].removed = true; },
        logIdentity: receipt => { receipt.logs[0].transactionHash = protocolHash; },
        duplicateLog: receipt => { receipt.logs[1].logIndex = receipt.logs[0].logIndex; },
        unknownToken: receipt => { receipt.logs[0] = token(wallet, zero, '3', quantity, 10); },
        malformedTransfer: receipt => { receipt.logs[1].data = '0x'; },
        gasLimit: receipt => { receipt.gasUsed = ethers.BigNumber.from(500001); },
        gasPrice: receipt => { receipt.effectiveGasPrice = ethers.BigNumber.from(30000000001); },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const f = await fixture(), receipt = ownReceipt(f.action, f.safeHash); mutate(receipt);
        assert.equal(verifyActionReceipt({ position: f.position, wallet, block: 100, action: f.action, receipt }), null, name);
        f.client.verifiedReceipt = async () => { f.calls.receipts.push(f.action.hash); return receipt; };
        await f.broker.reconcileActions(now); await f.broker.reconcileActions(now + 2000);
        assert.equal(f.calls.receipts.length, 1, name); assert.equal(f.state.cash, 16, name); assert.equal(f.position.gas, 0, name);
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {}); f.broker.reconcileBlock = 100;
        await f.broker.reconcileActions(now + 5000);
        assert.equal(f.calls.receipts.length, 2, name); assert.equal(f.state.cash, 16, name); assert.equal(f.position.gas, 0, name);
        assert.deepEqual(f.state.stopped, f.stop, name); assert.equal(f.action.status, 'unknown', name);
    }
});

test('read failures and missing receipts persist bounded backoff across restart without broadcasting or declaring failure', async () => {
    for (const mode of ['missing', 'transport', 'canonical']) {
        const f = await fixture();
        f.client.verifiedReceipt = async () => { f.calls.receipts.push(f.action.hash);
            if (mode !== 'missing') throw new OperationalError(mode === 'canonical' ? 'rpc_block_mismatch' : 'rpc_unavailable',
                mode === 'canonical' ? 'reconciliation' : 'transport');
            return null; };
        let clock = now;
        for (const delay of [5000, 15000, 30000, 60000, 60000]) {
            const before = f.calls.receipts.length;
            f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {}); f.broker.reconcileBlock = 100;
            await f.broker.reconcileActions(clock);
            assert.equal(f.calls.receipts.length, before + 1, mode); assert.equal(f.action.receiptRetry.nextAt, clock + delay, mode);
            await f.broker.reconcileActions(clock + 2000); assert.equal(f.calls.receipts.length, before + 1, mode);
            clock += delay;
        }
        assert.equal(f.action.status, 'unknown', mode); assert.equal(f.state.cash, 16, mode); assert.equal(f.position.gas, 0, mode);
        assert.equal(f.state.failures, 1, mode); assert.deepEqual(f.state.stopped, f.stop, mode);
    }
});

test('zero own movement stays unresolved until earlier protocol evidence arrives; later evidence can complete the same receipt', async () => {
    const f = await fixture({ protocol: false });
    f.client.verifiedReceipt = async hash => hash === protocolHash ? protocolReceipt()
        : ownReceipt(f.action, f.safeHash, { movement: false });
    await f.broker.reconcile(null, now);
    assert.equal(f.action.status, 'unknown'); assert.equal(f.position.gas, 0); assert.equal(f.state.cash, 16);
    f.client.listAutoRedemptions = async () => [protocolHash];
    await f.broker.reconcile(null, now + 5000);
    assert.equal(f.action.status, 'confirmed'); assert.equal(f.position.gas, .0003); assert.equal(f.state.cash, 21.06299);
    assert.deepEqual(f.state.stopped, f.stop);
});

async function delayedProtocolFixture() {
    const f = await fixture({ stopped: false });
    f.action.createdAt = now - 5000;
    f.client.balance = async block => { assert.equal(block, 100); return 21.06329; };
    f.client.holdings = async (tokens, block) => { assert.equal(block, 100); return [0, 0]; };
    f.client.verifiedReceipt = async hash => hash === protocolHash ? protocolReceipt()
        : ownReceipt(f.action, f.safeHash, { movement: false });
    return f;
}

test('exact official payout wallet delta waits for indexed proof without booking money or preparing an action', async () => {
    const f = await delayedProtocolFixture();
    f.position.actions = [];
    assert.equal(await f.broker.checkWallet(now), false);
    assert.equal(f.state.stopped, null); assert.equal(f.position.autoRedeemWait.since, now);
    assert.equal(f.state.cash, 16); assert.equal(f.state.walletCashDelta, -4);
    assert.deepEqual(f.position.holdings, [0, 5.06329]); assert.equal(f.position.gas, 0);
    assert.equal(await f.broker.action('redeem', 0, now), false);
    assert.equal(f.position.actions.length, 0);
});

test('verified no-op waits through index lag and restart, then books each canonical receipt exactly once without a new fault', async () => {
    const f = await delayedProtocolFixture();
    await f.broker.reconcile(null, now);
    assert.equal(await f.broker.checkWallet(now), false);
    assert.equal(f.state.stopped, null); assert.equal(f.state.reconciliationFaults, undefined);
    assert.equal(f.action.status, 'unknown'); assert.equal(f.position.autoRedeemWait.since, now);
    assert.equal(f.state.cash, 16); assert.equal(f.position.gas, 0);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 5000);
    assert.equal(f.position.autoRedeemWait.since, now);
    assert.equal(f.state.stopped, null); assert.equal(f.state.reconciliationFaults, undefined);
    f.client.listAutoRedemptions = async () => [protocolHash];
    await f.broker.reconcile(null, now + 20000);
    assert.equal(f.position.autoRedeemWait, undefined); assert.equal(f.action.status, 'confirmed');
    assert.equal(f.state.cash, 21.06299); assert.equal(f.state.walletCashDelta, 1.06329);
    assert.equal(f.position.gas, .0003); assert.deepEqual(f.position.holdings, [0, 0]);
    assert.equal(f.state.stopped, null); assert.equal(f.state.reconciliationFaults, undefined);
    const settled = structuredClone(f.state);
    await f.broker.reconcile(null, now + 21000);
    assert.deepEqual(f.state, settled);
});

test('index wait does not excuse wrong Safe hash, transaction hash, movements, wallet delta or payout', async () => {
    for (const fault of ['safeHash', 'hash', 'movement', 'delta', 'holdings', 'payout']) {
        const f = await delayedProtocolFixture(), receipt = ownReceipt(f.action, f.safeHash, { movement: false });
        if (fault === 'safeHash') receipt.logs[0] = log(safe, 'ExecutionSuccess', wallet, [zeroHash, 0], 20);
        if (fault === 'hash') receipt.transactionHash = protocolHash;
        if (fault === 'movement') receipt.logs.unshift(cash(zero, wallet, 1, 10));
        if (fault === 'delta') f.client.balance = async () => 21.063291;
        if (fault === 'holdings') f.client.holdings = async () => [0, .000001];
        if (fault === 'payout') f.client.payoutAtBlock = async () => [1, 0];
        f.client.verifiedReceipt = async () => receipt;
        await f.broker.reconcile(null, now);
        assert.equal(f.state.stopped.reason, 'action_receipt_unconfirmed', fault);
        assert.equal(f.state.reconciliationFaults.action_receipt_unconfirmed.count, 1, fault);
        assert.equal(f.position.autoRedeemWait, undefined, fault);
        assert.equal(f.state.cash, 16, fault); assert.equal(f.position.gas, 0, fault);
    }
});

test('unproven payout wait expires durably after 120 seconds even if canonical proof arrives in that tick', async () => {
    const f = await delayedProtocolFixture();
    await f.broker.reconcile(null, now);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    f.client.listAutoRedemptions = async () => [protocolHash];
    await f.broker.reconcile(null, now + 120000);
    assert.equal(f.state.stopped.reason, 'auto_redeem_receipt_timeout');
    assert.equal(f.action.status, 'confirmed'); assert.equal(f.state.cash, 21.06299);
    assert.equal(f.position.gas, .0003); assert.deepEqual(f.position.holdings, [0, 0]);
});

test('a malformed protocol payout cannot settle money while an own action is unresolved', async () => {
    const f = await fixture({ protocol: true });
    f.client.verifiedReceipt = async hash => {
        f.calls.receipts.push(hash);
        if (hash !== protocolHash) return null;
        const receipt = protocolReceipt(); receipt.logs[3] = cash(zero, other, quantity, 16); return receipt;
    };
    await f.broker.reconcile(null, now); await f.broker.reconcile(null, now + 500);
    assert.equal(f.state.cash, 16); assert.deepEqual(f.position.holdings, [0, 5.06329]);
    assert.equal(f.position.actions.length, 1); assert.equal(f.action.status, 'unknown'); assert.equal(f.position.gas, 0);
    assert.deepEqual(f.calls.receipts, [protocolHash, f.action.hash]); assert.equal(f.position.autoRedeemRetry.nextAt, now + 5000);
});

test('a recent prepared or pending action stays unresolved without a new stop, broadcast or new nonce', async () => {
    for (const status of ['prepared', 'pending']) {
        const f = await fixture({ stopped: false });
        f.action.status = status; f.action.createdAt = now - 31000;
        await f.broker.reconcileActions(now);
        assert.equal(f.action.status, status); assert.equal(f.state.stopped, null);
        assert.equal(f.position.gas, 0); assert.equal(f.state.cash, 16); assert.equal(f.broker.pending(), true);
        assert.equal(await f.broker.action('merge', 1, now), false);
        await f.broker.reconcileActions(now + 121000);
        assert.equal(f.state.stopped.reason, 'transaction_status_unknown'); assert.equal(f.action.status, status);
    }
});

test('the persistent stop blocks any new action after a canonical failed or successful terminal receipt', async () => {
    for (const status of [0, 1]) {
        const f = await fixture();
        f.client.verifiedReceipt = async () => ownReceipt(f.action, f.safeHash, { status, movement: status === 1 });
        await f.broker.reconcileActions(now);
        assert.equal(f.action.status, status === 1 ? 'confirmed' : 'failed');
        assert.equal(await f.broker.action('merge', 1, now + 31000), false);
        assert.deepEqual(f.state.stopped, f.stop);
    }
});

test('zero movement requires protocol evidence before the own receipt, with explicit same-block transaction ordering', async () => {
    const f = await fixture({ protocol: true }); await f.broker.reconcile(null, now);
    const receipt = ownReceipt(f.action, f.safeHash, { movement: false }), row = f.position.receipts[protocolHash];
    row.blockNumber = 101;
    const input = { position: f.position, wallet, block: 100, action: f.action, receipt };
    assert.equal(verifyActionReceipt(input), null);
    row.blockNumber = 100; row.transactionIndex = 3;
    assert.equal(verifyActionReceipt(input), null);
    delete row.transactionIndex;
    assert.equal(verifyActionReceipt(input), null);
    row.transactionIndex = 1;
    assert.equal(verifyActionReceipt(input).status, 'confirmed');
    delete f.position.receipts[protocolHash];
    assert.equal(verifyActionReceipt(input), null);
});

test('type2 action gas accepts effective price below or equal to maxFeePerGas and rejects a price above it', async () => {
    for (const effective of [30000000000, 40000000000, 40000000001]) {
        const f = await fixture();
        const signed = await signedAction('redeem', { tx: { type: 2, gasPrice: undefined,
            maxFeePerGas: 40000000000, maxPriorityFeePerGas: 2000000000 } });
        Object.assign(f.action, signed.action);
        const identity = persistedActionIdentity({ position: f.position, wallet, action: f.action });
        assert.equal(identity.tx.type, 2); assert.equal(identity.tx.gasPrice, null);
        const receipt = ownReceipt(f.action, signed.safeHash);
        receipt.effectiveGasPrice = ethers.BigNumber.from(effective);
        const proof = verifyActionReceipt({ position: f.position, wallet, block: 100, action: f.action, receipt });
        f.client.verifiedReceipt = async () => receipt;
        await f.broker.reconcileActions(now);
        if (effective <= 40000000000) {
            assert.equal(proof.status, 'confirmed'); assert.equal(f.action.status, 'confirmed');
            assert.equal(f.position.gas, effective === 30000000000 ? .0003 : .0004);
            const before = structuredClone(f.state);
            await f.broker.reconcileActions(now + 60000); assert.deepEqual(f.state, before);
        } else {
            assert.equal(proof, null); assert.equal(f.action.status, 'unknown');
            assert.equal(f.position.gas, 0); assert.equal(f.state.cash, 16);
        }
        assert.deepEqual(f.state.stopped, f.stop);
    }
});

async function stoppedRedeemFixture({ winning = false } = {}) {
    const f = await fixture(), index = winning ? 1 : 0, shares = 5.123457;
    f.stop.reason = 'drawdown_limit';
    Object.assign(f.state, { mode: 'pilot', strategy: 'late-entry', completed: [], peakEquity: 20,
        maxDrawdown: 4, startedAt: now - 200000, stopHistory: [{ reason: 'old_reviewed_stop', at: 1 }] });
    Object.assign(f.position, { actions: [], holdings: index ? [0, shares] : [shares, 0], uncertain: false,
        startingCash: 20, exposureAt: now - 200000, lastDeployed: 4, capitalHours: 0, rebate: 0 });
    Object.assign(f.position.orders[0], { index, tokenId: String(index + 1), settled: shares, filled: shares });
    f.calls.prepares = 0; f.calls.broadcasts = 0; f.calls.payouts = [];
    f.snapshots = []; f.receipt = null;
    f.walletBalance = 16; f.walletHoldings = [...f.position.holdings];
    f.store.save = () => f.snapshots.push(structuredClone(f.state));
    const event = f.store.event;
    f.store.event = (type, detail) => { event(type, detail); f.store.save(); };
    f.client.redemptionScan = { complete: true,
        key: JSON.stringify([wallet, conditionId, ['1', '2'], f.position.openedAt]) };
    f.client.payoutAtBlock = async (condition, block) => {
        f.calls.payouts.push([condition, block]); return [0, 1];
    };
    f.client.balance = async block => { assert.equal(block, 100); return f.walletBalance; };
    f.client.holdings = async (tokens, block) => {
        assert.deepEqual(tokens, ['1', '2']); assert.equal(block, 100); return [...f.walletHoldings];
    };
    f.client.prepareAction = async (position, kind, amount) => {
        assert.equal(position, f.position); assert.equal(kind, 'redeem'); assert.equal(amount, 0);
        f.calls.prepares++; return { ...f.action, status: 'prepared', createdAt: now };
    };
    f.client.broadcastAction = async action => {
        f.calls.broadcasts++;
        const persisted = f.snapshots.at(-1).position.actions[0];
        assert.equal(persisted.status, 'prepared'); assert.equal(persisted.raw, action.raw);
        assert.equal(persisted.hash, action.hash); assert.deepEqual(f.state.stopped, f.stop);
    };
    f.client.verifiedReceipt = async (hash, block) => {
        assert.equal(hash, f.action.hash); assert.equal(block, 100); return f.receipt;
    };
    f.successReceipt = () => ({ ...ownReceipt(f.action, f.safeHash, { movement: false }),
        logs: [token(wallet, zero, String(index + 1), 5123457, 10),
            ...(winning ? [cash(zero, wallet, 5123457, 11)] : []),
            log(safe, 'ExecutionSuccess', wallet, [f.safeHash, 0], 20)] });
    await f.broker.reconcile(null, now);
    return f;
}

test('latched operational stops permit only the first receipt-proven official cleanup without clearing the stop', async () => {
    for (const reason of ['live_book_feed_gap', 'stale_market_data', 'market_watch_failed',
        'laya_provider_unavailable', 'operational_check_failed', 'capital_exhausted', 'live_preflight_blocked']) {
        const f = await stoppedRedeemFixture(); f.stop.reason = reason;
        await f.broker.action('redeem', 0, now);
        assert.equal(f.calls.prepares, 1, reason); assert.equal(f.calls.broadcasts, 1, reason);
        assert.equal(f.state.stopped.reason, reason);
        await f.broker.action('redeem', 0, now);
        assert.equal(f.calls.broadcasts, 1, 'cleanup never repeats a financial write');
    }
});

test('a latched drawdown stop permits one verified losing or winning redemption and survives completion and restart', async () => {
    for (const winning of [false, true]) {
        const f = await stoppedRedeemFixture({ winning }), history = structuredClone(f.state.stopHistory);
        assert.equal(await f.broker.action('redeem', 0, now), false);
        assert.deepEqual(f.calls.payouts, [[conditionId, 100]]);
        assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1);
        assert.equal(f.position.actions[0].status, 'pending'); assert.equal(f.state.cash, 16);
        assert.deepEqual(f.position.holdings, winning ? [0, 5.123457] : [5.123457, 0]);
        assert.equal(await f.broker.action('redeem', 0, now), false);
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, now + 1000);
        assert.equal(await f.broker.action('redeem', 0, now + 1000), false);
        assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1);
        f.receipt = f.successReceipt();
        await f.broker.reconcile(null, now + 6000);
        assert.equal(f.state.cash, winning ? 21.123157 : 15.9997);
        assert.equal(f.state.walletCashDelta, winning ? 1.123457 : -4);
        assert.equal(f.position.gas, .0003); assert.deepEqual(f.position.holdings, [0, 0]);
        assert.equal(f.position.receipts[f.action.hash].cash, winning ? 5.123457 : 0);
        assert.equal(f.position.actions[0].status, 'confirmed'); assert.equal(f.position.actions[0].raw, undefined);
        const engine = new Engine({ ...BASELINE, wallet }, f.store, f.client, { close() {} });
        engine.broker = f.broker;
        await engine.manage(null, now + 6000);
        assert.equal(f.state.position, null); assert.equal(f.state.completed.length, 1);
        assert.deepEqual(f.state.stopped, f.stop); assert.deepEqual(f.state.stopHistory, history);
        const saved = structuredClone(f.state);
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, now + 7000);
        assert.equal(await f.broker.action('redeem', 0, now + 7000), false);
        assert.deepEqual(f.state, saved); assert.equal(f.calls.broadcasts, 1);
    }
});

test('stopped redemption refuses unresolved payout, unknown exposure, faults and stale or incomplete scans before preparation', async () => {
    const faults = {
        unresolved: f => { f.client.payoutAtBlock = async () => null; },
        unofficial: f => { f.client.payoutAtBlock = async () => [.5, .5]; },
        changedPayout: f => { f.client.payoutAtBlock = async () => [1, 0]; },
        beforeEnd: f => { f.position.market.end = now + 1; },
        uncertain: f => { f.position.uncertain = true; },
        pendingFill: f => { f.position.pendingTrades = true; },
        unprovedFill: f => { f.position.orders[0].receiptProvenComplete = false; },
        unknownOrder: f => { f.position.orders[0].status = 'unknown'; },
        unaccountedFill: f => { f.position.orders[0].filled += .000001; },
        malformedHoldings: f => { f.position.holdings[0] = '5.123457'; },
        missingWalletBaseline: f => { f.state.walletStart = null; },
        fault: f => { f.state.reconciliationFaults = { invalid_owned_trade: { count: 1 } }; },
        profitTransfer: f => { f.state.profitTaking = { pending: {} }; },
        profitOperation: f => { f.state.profitTakingControl = { operation: { stage: 'source_uncertain' } }; },
        accountRetry: f => { f.position.accountQueryRetry = { nextAt: now + 1000 }; },
        autoWait: f => { f.position.autoRedeemWait = { since: now }; },
        incompleteScan: f => { f.broker.autoRedeemScan.clear = false; },
        staleScan: f => { f.broker.autoRedeemScan.at--; },
        staleTick: f => { f.broker.reconciledSnapshot.at--; },
        staleBlock: f => { f.broker.reconcileBlock++; },
        walletStop: f => { f.stop.reason = 'wallet_ledger_mismatch'; },
        semanticStop: f => { f.stop.reason = 'invalid_owned_trade'; },
        missingScanAfterRestart: f => { f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {}); },
    };
    for (const [name, mutate] of Object.entries(faults)) {
        const f = await stoppedRedeemFixture(); mutate(f);
        assert.equal(await f.broker.action('redeem', 0, now), false, name);
        assert.equal(f.calls.prepares, 0, name); assert.equal(f.calls.broadcasts, 0, name);
    }
    for (const status of ['prepared', 'pending', 'unknown', 'invalid', 'failed', 'confirmed']) {
        const f = await stoppedRedeemFixture(); f.position.actions.push({ ...f.action, status, finishedAt: now - 60000 });
        assert.equal(await f.broker.action('redeem', 0, now), false, status);
        assert.equal(f.calls.prepares, 0, status); assert.equal(f.calls.broadcasts, 0, status);
    }
    const f = await stoppedRedeemFixture();
    assert.equal(await f.broker.action('merge', 1, now), false);
    assert.equal(await f.broker.action('redeem', 1, now), false);
    assert.equal(f.calls.prepares, 0); assert.equal(f.calls.broadcasts, 0);
});

test('wallet conflicts and malformed holdings remain durable behind the original drawdown stop', async () => {
    for (const fault of ['cash', 'holdings', 'missingHoldings']) {
        const f = await stoppedRedeemFixture();
        if (fault === 'cash') f.walletBalance += .000001;
        else f.walletHoldings = fault === 'holdings' ? [5.123456, 0] : [];
        assert.equal(await f.broker.action('redeem', 0, now), false, fault);
        assert.equal(f.state.reconciliationFaults.wallet_ledger_mismatch.count, 1, fault);
        assert.deepEqual(f.state.stopped, f.stop, fault);
        f.walletBalance = 16; f.walletHoldings = [5.123457, 0];
        f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
        await f.broker.reconcile(null, now + 1000);
        assert.equal(await f.broker.action('redeem', 0, now + 1000), false, fault);
        assert.equal(f.calls.prepares, 0, fault); assert.equal(f.calls.broadcasts, 0, fault);
    }
});

test('stopped redemption rechecks state after each awaited read and preparation before persisting or broadcasting', async () => {
    for (const phase of ['payout', 'wallet', 'prepare']) {
        for (const change of ['uncertain', 'fault', 'holdings', 'action', 'position', 'stop', 'scan', 'profitOperation', 'walletLedger']) {
            const f = await stoppedRedeemFixture();
            const mutate = () => {
                if (change === 'uncertain') f.position.uncertain = true;
                if (change === 'fault') f.state.reconciliationFaults = { invalid_owned_trade: { count: 1 } };
                if (change === 'holdings') f.position.holdings[0] -= .000001;
                if (change === 'action') f.position.actions.push({ ...f.action, status: 'unknown' });
                if (change === 'position') f.state.position = structuredClone(f.position);
                if (change === 'stop') f.state.stopped = { reason: 'wallet_ledger_mismatch', at: now };
                if (change === 'scan') f.broker.autoRedeemScan = { ...f.broker.autoRedeemScan };
                if (change === 'profitOperation') f.state.profitTakingControl = { operation: { stage: 'source_uncertain' } };
                if (change === 'walletLedger') { f.state.walletStart++; f.state.walletCashDelta--; }
            };
            const method = { payout: 'payoutAtBlock', wallet: 'holdings', prepare: 'prepareAction' }[phase];
            const original = f.client[method];
            f.client[method] = async (...args) => { const result = await original(...args); mutate(); return result; };
            assert.equal(await f.broker.action('redeem', 0, now), false, `${phase}/${change}`);
            assert.equal(f.calls.broadcasts, 0, `${phase}/${change}`);
            assert.equal(f.events.some(row => row.type === 'redeem_prepared'), false, `${phase}/${change}`);
        }
    }
});

test('concurrent stopped redemption calls sign and broadcast one durable action, and invalid preparation never broadcasts', async () => {
    const f = await stoppedRedeemFixture();
    await Promise.all([f.broker.action('redeem', 0, now), f.broker.action('redeem', 0, now)]);
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1);
    const invalid = await stoppedRedeemFixture();
    invalid.client.prepareAction = async () => ({ ...invalid.action, status: 'prepared', hash: protocolHash });
    assert.equal(await invalid.broker.action('redeem', 0, now), false);
    assert.equal(invalid.calls.broadcasts, 0); assert.equal(invalid.position.actions.length, 0);
    assert.equal(invalid.state.reconciliationFaults.action_identity_unproven.count, 1);
});

test('semantic resolution and wallet read failures stay sticky while transient reads and gas funding can defer', async () => {
    for (const [method, error, sticky] of [
        ['payoutAtBlock', new OperationalError('rpc_wrong_chain'), true],
        ['balance', new OperationalError('invalid_balance'), true],
        ['prepareAction', new OperationalError('action_safe_hash_mismatch', 'reconciliation'), true],
        ['payoutAtBlock', new OperationalError('rpc_unavailable', 'transport'), false],
        ['prepareAction', new OperationalError('insufficient_action_gas'), false],
    ]) {
        const f = await stoppedRedeemFixture();
        f.client[method] = async () => { throw error; };
        await assert.rejects(f.broker.action('redeem', 0, now), value => value === error);
        assert.equal(!!f.state.reconciliationFaults?.stopped_redeem_unconfirmed, sticky, method);
        assert.deepEqual(f.state.stopped, f.stop); assert.equal(f.calls.broadcasts, 0);
        assert.equal(f.position.actions.length, 0);
    }
    for (const payout of [[1, 0], [.5, .5], []]) {
        const f = await stoppedRedeemFixture(); f.client.payoutAtBlock = async () => payout;
        assert.equal(await f.broker.action('redeem', 0, now), false);
        assert.equal(f.state.reconciliationFaults.official_payout_mismatch.count, 1);
        assert.equal(f.calls.prepares, 0); assert.equal(f.calls.broadcasts, 0);
    }
});

test('a stopped redemption broadcast failure preserves the exact durable unknown action and never sends again after restart', async () => {
    const f = await stoppedRedeemFixture();
    f.client.broadcastAction = async () => { f.calls.broadcasts++; throw new OperationalError('rpc_unavailable', 'transport'); };
    await f.broker.action('redeem', 0, now);
    assert.equal(f.position.actions[0].status, 'unknown'); assert.equal(f.position.actions[0].raw, f.action.raw);
    assert.deepEqual(f.snapshots.at(-1).position.actions[0], f.position.actions[0]);
    assert.deepEqual(f.state.stopped, f.stop);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 1000);
    assert.equal(await f.broker.action('redeem', 0, now + 1000), false);
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1);
});

test('a canonical failed stopped redemption books gas once and cannot allocate a replacement nonce after restart', async () => {
    const f = await stoppedRedeemFixture(); await f.broker.action('redeem', 0, now);
    f.receipt = ownReceipt(f.action, f.safeHash, { status: 0, movement: false });
    await f.broker.reconcile(null, now + 1000);
    assert.equal(f.position.actions[0].status, 'failed'); assert.equal(f.position.gas, .0003);
    assert.equal(f.state.cash, 15.9997); assert.deepEqual(f.state.stopped, f.stop);
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 61000);
    assert.equal(await f.broker.action('redeem', 0, now + 61000), false);
    assert.equal(f.calls.prepares, 1); assert.equal(f.calls.broadcasts, 1); assert.equal(f.position.gas, .0003);
});

test('semantic automatic-redemption scan errors remain durable after a healthy scan and restart behind drawdown', async () => {
    const f = await stoppedRedeemFixture();
    f.client.listAutoRedemptions = async () => { throw new OperationalError('invalid_redemption_activity'); };
    await f.broker.reconcile(null, now + 1000);
    assert.equal(f.state.reconciliationFaults.auto_redeem_unconfirmed.count, 1);
    assert.deepEqual(f.state.stopped, f.stop);
    f.client.listAutoRedemptions = async () => [];
    f.broker = new LayaLiveBroker({ ...BASELINE, wallet }, f.store, f.client, async () => {});
    await f.broker.reconcile(null, now + 6000);
    assert.equal(f.broker.autoRedeemScan.clear, true);
    assert.equal(await f.broker.action('redeem', 0, now + 6000), false);
    assert.equal(f.calls.prepares, 0); assert.equal(f.calls.broadcasts, 0);
});
