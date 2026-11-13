import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { ProfitTakingCoordinator, loadProfitTakingConfig } from '../../src/laya-live/profit-taking.js';
import { BRIDGE } from '../../src/laya-live/profit-bridge.js';
import { profitTransferCall } from '../../src/laya-live/profit-transaction.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';

const owner = new ethers.Wallet('0x' + '7'.repeat(64));
const wallet = '0x' + '1'.repeat(40), address = '0x' + '2'.repeat(40);
const recipient = owner.address.toLowerCase(), blockHash = '0x' + 'a'.repeat(64), manualHash = '0x' + 'b'.repeat(64);
const now = 1800000010000, zero = ethers.constants.AddressZero;
const pendingTrade = () => ({ status: 'MATCHED', transactionHash: manualHash });
const receipt = () => ({ transactionHash: manualHash, blockNumber: 199, blockHash, status: 1, confirmations: 2 });

// Fixture-only signing; every account read, receipt, bridge and send is injected.
async function signedTransfer() {
    const intent = { token: BRIDGE.sourceToken, recipient: address, amount: 5 };
    const call = profitTransferCall(intent);
    const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
        ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
        ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
    const message = { to: call.to, value: 0, data: call.data, operation: 0, safeTxGas: 0, baseGas: 0,
        gasPrice: 0, gasToken: zero, refundReceiver: zero, nonce: '7' };
    const safeHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message);
    const sig = ethers.utils.splitSignature(await owner.signMessage(ethers.utils.arrayify(safeHash)));
    const signature = ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
    const safe = new ethers.utils.Interface([
        'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
    ]);
    const data = safe.encodeFunctionData('execTransaction', fields.slice(0, 9).map(({ name }) => message[name]).concat(signature));
    const raw = await owner.signTransaction({ to: wallet, value: 0, data, chainId: 137, type: 2, nonce: 11,
        gasLimit: 500000, maxFeePerGas: ethers.utils.parseUnits('320', 'gwei'), maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei') });
    return { kind: 'profit_transfer', ...intent, hash: ethers.utils.keccak256(raw), raw, safeNonce: '7',
        createdAt: now, polUsd: .1, status: 'prepared', maxGasUsd: .016, broadcastRpcIndex: 0 };
}

async function fixture({ automatic = true } = {}) {
    const prepared = await signedTransfer(), events = [], saves = [];
    const values = { trades: [], receipt: null, prepareHook: null, now };
    const calls = { route: 0, prepare: 0, broadcast: 0, account: 0, receipts: [] };
    const state = { baseline: 'offline-profit-manual', mode: 'pilot', strategy: 'late-entry',
        startedAt: now - 3600000, cash: 26, peakEquity: 26, lastEquity: 26, maxDrawdown: 0,
        walletStart: 20, walletCashDelta: 6, liveFunding: { initialCapital: 20 }, position: null,
        completed: [{ traded: true, pnl: 6, fees: .01, gas: .001, uncertain: false }], stopped: null,
        seen: {}, failures: 0 };
    const store = { state, save() { saves.push(structuredClone(state)); },
        event(type, detail) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: values.now }; this.save(); } };
    const config = { settings: { wallet, pilotHours: 48, pilotMarkets: 100, drawdownStop: 2 },
        profitTaking: loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient }) };
    const bridge = {
        async supportedAssets() {},
        async quote() {
            return { wallet, recipient, amountUnits: '5000000', chainId: 137,
                sourceToken: BRIDGE.sourceToken.toLowerCase(), destinationToken: BRIDGE.destinationToken.toLowerCase(),
                quoteId: 'offline-quote', estimatedOutputUnits: '4990000', minOutputUnits: '4950000', maxOutputUnits: '5000000',
                estimatedInputUsd: 5, estimatedOutputUsd: 4.99, estimatedCostUsd: .01, gasReserveUsd: 0, providerFeesUsd: .01,
                maxFeeUsd: .05, maxSlippagePercent: 0, quotedAt: values.now, expiresAt: values.now + 30000 };
        },
        async createWithdrawal() { calls.route++; return { address }; },
    };
    const client = {
        rpc: { anchor: { number: 200, hash: blockHash } },
        async confirmedBlock() { return 200; },
        async balance() { return expectedWalletBalance(state); },
        async ordersAndTrades() { calls.account++; return { orders: [], trades: values.trades }; },
        async verifiedReceipt(hash, block) {
            calls.receipts.push(hash); assert.equal(block, 200);
            return hash === manualHash ? values.receipt : null;
        },
        async prepareProfitTransfer() { calls.prepare++; await values.prepareHook?.(); return prepared; },
        async broadcastAction(transfer) {
            const saved = saves.at(-1);
            assert.equal(saved.profitTakingControl.operation.stage, 'source_uncertain');
            assert.equal(saved.profitTaking.pending.hash, transfer.hash);
            assert.equal(saved.profitTakingControl.operation.transfer.raw, transfer.raw);
            calls.broadcast++;
        },
    };
    const coordinator = new ProfitTakingCoordinator({ config, store, client, bridge,
        providers: { active: new Map() }, clock: () => values.now });
    coordinator.externalActivity = { enabled: () => automatic, reconcile: async () => true, defer() {} };
    coordinator.verifyRecipient = async block => ({ blockNumber: block, blockHash, wallet, recipient,
        sourceToken: BRIDGE.sourceToken.toLowerCase(), destinationToken: BRIDGE.destinationToken.toLowerCase(),
        sourceBalanceUnits: String(Math.round(expectedWalletBalance(state) * 1e6)), destinationBalanceUnits: '0',
        recipientAccount: { kind: 'eoa' } });
    return { coordinator, state, values, calls, events, saves, prepared };
}

test('manual MATCHED FAK without an open order defers before route creation', async () => {
    const f = await fixture(); f.values.trades = [pendingTrade()];
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.route, 0); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast, 0);
    assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(f.state.stopped, null);
    assert.equal(f.events.at(-1).error.code, 'external_trades_pending');
});

test('manual FAK appearing while signing blocks final source reservation and broadcast', async () => {
    const f = await fixture(); f.values.prepareHook = () => { f.values.trades = [pendingTrade()]; };
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.route, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 0);
    assert.equal(f.state.profitTaking?.pending, undefined);
    assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(f.state.profitTakingControl.abandoned[0].reason, 'external_trades_pending');
    assert.ok(f.saves.every(state => !state.profitTakingControl.operation?.transfer));
    assert.equal(f.state.stopped, null);
});

test('stale MATCHED API status with canonical settled receipt admits one durable withdrawal', async () => {
    const f = await fixture(); f.values.trades = [pendingTrade()]; f.values.receipt = receipt();
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.broadcast, 1);
    assert.deepEqual(f.calls.receipts, [manualHash, manualHash]);
    assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
});

test('canonical historical trade proof avoids re-fetching stale MATCHED receipts', async () => {
    const f = await fixture(); f.values.trades = [pendingTrade()];
    f.state.strategyEpochs = [{ walletProof: { trades: { receiptConfirmed: [
        { transactionHash: manualHash, blockNumber: 199, blockHash },
    ] } } }];
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.broadcast, 1); assert.deepEqual(f.calls.receipts, []);
});

for (const [name, proof] of [
    ['missing', null], ['failed', { ...receipt(), status: 0 }],
    ['unconfirmed', { ...receipt(), confirmations: 1 }], ['future', { ...receipt(), blockNumber: 201 }],
]) test(`manual FAK with ${name} receipt cannot reserve or send withdrawal`, async () => {
    const f = await fixture();
    f.values.prepareHook = () => { f.values.trades = [pendingTrade()]; f.values.receipt = proof; };
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.broadcast, 0); assert.equal(f.state.profitTaking?.pending, undefined);
    assert.equal(f.state.stopped, null);
});

test('nonautomatic withdrawal admission retains its existing behavior', async () => {
    const f = await fixture({ automatic: false }); f.values.trades = [pendingTrade()];
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.broadcast, 1); assert.deepEqual(f.calls.receipts, []);
});

test('new manual pending trade does not obstruct reconciliation of durable source uncertainty', async () => {
    const f = await fixture(); assert.equal(await f.coordinator.tick(), true);
    const beforeAccount = f.calls.account, pending = structuredClone(f.state.profitTaking.pending);
    f.values.trades = [pendingTrade()]; f.values.now += 15000;
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.account, beforeAccount); assert.equal(f.calls.broadcast, 1);
    assert.deepEqual(f.calls.receipts, [f.prepared.hash]);
    assert.deepEqual(f.state.profitTaking.pending, pending);
    assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
    assert.equal(f.state.stopped, null);
});
