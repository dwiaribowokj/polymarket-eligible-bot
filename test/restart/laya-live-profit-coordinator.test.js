import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { loadLiveConfig } from '../../src/laya-live/config.js';
import { OperationalError } from '../../src/restart/network.js';
import { ProfitTakingCoordinator, loadProfitTakingConfig, profitWithdrawalPending, profitTakingReport } from '../../src/laya-live/profit-taking.js';
import { BRIDGE, verifyBridgeDestinationReceipt } from '../../src/laya-live/profit-bridge.js';
import { profitTransferCall, persistedProfitTransferIdentity } from '../../src/laya-live/profit-transaction.js';
import { distributionAdjustedCash, profitTakingLedger } from '../../src/laya-live/profit-accounting.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { entryGuard, initializeAI, LayaLiveEngine } from '../../src/laya-live/engine.js';
import { EligibleLiveProvider } from '../../src/eligible-live/provider.js';

// In-memory persistence and injected proofs. Only fixture keys sign; nothing
// reads environment files, contacts providers, or writes external state.
const owner = new ethers.Wallet('0x' + '7'.repeat(64));
const wallet = '0x' + '1'.repeat(40), routeAddress = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40);
const recipient = owner.address.toLowerCase(), blockHash = '0x' + 'a'.repeat(64), destinationHash = '0x' + 'b'.repeat(64);
const base = 1800000000000, zero = ethers.constants.AddressZero;
const safe = new ethers.utils.Interface([
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
]);
const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));

async function signedTransfer(now, intent = {}) {
    const selected = { token: BRIDGE.sourceToken, recipient: routeAddress, amount: 5, ...intent };
    const call = profitTransferCall(selected), message = { to: call.to, value: 0, data: call.data, operation: 0,
        safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: zero, refundReceiver: zero, nonce: '7' };
    const safeHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message);
    const sig = ethers.utils.splitSignature(await owner.signMessage(ethers.utils.arrayify(safeHash)));
    const signature = ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
    const data = safe.encodeFunctionData('execTransaction', fields.slice(0, 9).map(({ name }) => message[name]).concat(signature));
    const raw = await owner.signTransaction({ to: wallet, value: 0, data, chainId: 137, type: 2, nonce: 11,
        gasLimit: 500000, maxFeePerGas: ethers.utils.parseUnits('320', 'gwei'), maxPriorityFeePerGas: ethers.utils.parseUnits('30', 'gwei') });
    return { kind: 'profit_transfer', ...selected, hash: ethers.utils.keccak256(raw), raw, safeNonce: '7',
        createdAt: now, polUsd: .1, status: 'prepared',
        maxGasUsd: Math.ceil(.16 * .1 * 1e6) / 1e6, broadcastRpcIndex: 0 };
}

async function fixture(options = {}) {
    const clock = { now: base + 10000 }, calls = { assets: 0, quote: 0, create: 0, prepare: 0, broadcast: [],
        receipts: [], status: 0, sourceProof: 0, destinationProof: 0, resolutions: [] }, events = [], saves = [];
    const values = { orders: [], sourceAvailable: false, destinationAvailable: false, match: null,
        destinationAmount: 4.99, destinationBlock: 101, destinationIndex: 3,
        sourceStatus: 'confirmed', sourceGas: .006, ...options.values };
    const state = { baseline: 'offline-profit-coordinator', mode: 'pilot', strategy: 'late-entry',
        startedAt: base - 3600000, cash: 26, peakEquity: 26, lastEquity: 26, maxDrawdown: 0,
        walletStart: 20, walletCashDelta: 6, liveFunding: { initialCapital: 20 }, position: null,
        completed: [{ traded: true, pnl: 6, fees: .01, gas: .001, uncertain: false }], stopped: null,
        seen: {}, failures: 0, ...options.state };
    const config = options.config ?? { settings: { wallet, pilotHours: 48, pilotMarkets: 100, drawdownStop: 2 },
        profitTaking: loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient }) };
    const store = { state,
        save() {
            if (values.saveError) throw new Error('offline_save_failed');
            saves.push(structuredClone(state));
        },
        event(type, detail) { events.push({ type, ...detail }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: clock.now }; this.save(); },
    };
    const prepared = await signedTransfer(clock.now, options.transferIntent);
    const providers = { active: new Map() };
    const quote = () => ({ wallet, recipient, amountUnits: '5000000', chainId: 137,
        sourceToken: BRIDGE.sourceToken.toLowerCase(), destinationToken: BRIDGE.destinationToken.toLowerCase(),
        quoteId: 'offline-quote', estimatedOutputUnits: '4990000', minOutputUnits: '4950000', maxOutputUnits: '5000000',
        estimatedInputUsd: 5, estimatedOutputUsd: 4.99, estimatedCostUsd: .01, gasReserveUsd: 0, providerFeesUsd: .01,
        maxFeeUsd: .05, maxSlippagePercent: 0, quotedAt: clock.now, expiresAt: clock.now + 30000 });
    const bridge = {
        async supportedAssets() { calls.assets++; if (values.assetsError) throw values.assetsError; },
        async quote() {
            calls.quote++; if (values.quoteError) throw values.quoteError;
            if (values.quoteHook) values.quoteHook(calls.quote);
            return quote();
        },
        async createWithdrawal() {
            calls.create++;
            assert.equal(saves.at(-1).profitTakingControl.operation.stage, 'address_requested', 'POST intent must be durable first');
            assert.equal(saves.at(-1).profitTaking?.pending, undefined);
            if (values.createHook) await values.createHook();
            if (values.createError) throw values.createError;
            return { address: values.routeAddress ?? routeAddress };
        },
        async status() {
            calls.status++;
            if (values.statusError) throw values.statusError;
            return values.statusResult ?? { match: values.match, intermediates: values.intermediates ?? [], nextCursor: null };
        },
    };
    const client = {
        async confirmedBlock() { return 200; },
        async balance() { return values.balanceOverride ?? expectedWalletBalance(state); },
        async ordersAndTrades() { return { orders: values.orders, trades: [] }; },
        async prepareProfitTransfer(intent) {
            calls.prepare++; assert.deepEqual(intent, { token: BRIDGE.sourceToken, recipient: routeAddress, amount: 5 });
            if (values.prepareHook) await values.prepareHook();
            if (values.prepareError) throw values.prepareError;
            return { ...prepared, ...values.preparedOverrides };
        },
        async broadcastAction(transfer) {
            const saved = saves.at(-1);
            assert.equal(saved.profitTakingControl.operation.stage, 'source_uncertain');
            assert.equal(saved.profitTaking.pending.hash, transfer.hash, 'Signed source identity must be durable before write');
            assert.equal(saved.profitTakingControl.operation.transfer.raw, transfer.raw);
            calls.broadcast.push(transfer.hash);
            if (values.broadcastError) throw values.broadcastError;
            return { hash: transfer.hash };
        },
        async verifiedReceipt(hash, block) {
            calls.receipts.push(hash); assert.equal(block, 200);
            if (values.receiptError) throw values.receiptError;
            if (hash === prepared.hash && values.sourceAvailable) return { transactionHash: hash, blockNumber: 100,
                blockHash, transactionIndex: 2, confirmations: 4, status: values.sourceStatus === 'confirmed' ? 1 : 0 };
            if (hash === destinationHash && values.destinationAvailable) return { transactionHash: hash,
                blockNumber: values.destinationBlock, blockHash, transactionIndex: values.destinationIndex, status: 1 };
            return null;
        },
        rpc: { async read(stage, task, block) {
            assert.ok(['profit_destination_block', 'profit_source_block'].includes(stage)); assert.equal(block, 200);
            return task({ async getBlock(number) { return { number, hash: blockHash, timestamp: Math.floor(clock.now / 1000) }; } });
        } },
    };
    const sourceProof = input => {
        calls.sourceProof++; assert.equal(input.transfer.hash, prepared.hash);
        if (values.sourceUnproven) return null;
        return { hash: prepared.hash, status: values.sourceStatus, safeTokenDelta: values.sourceStatus === 'confirmed' ? -5 : 0,
            gas: values.sourceGas, blockNumber: 100, blockHash, transactionIndex: 2 };
    };
    const destinationProof = input => {
        calls.destinationProof++; assert.equal(input.expected.recipient, recipient); assert.equal(input.expected.wallet, wallet);
        assert.equal(input.expected.transactionHash, destinationHash);
        if (values.destinationUnproven || input.expected.destinationAmountUnits != null
            && input.expected.destinationAmountUnits !== String(Math.round(values.destinationAmount * 1e6))) return null;
        return { hash: destinationHash, amount: values.destinationAmount,
            amountUnits: String(Math.round(values.destinationAmount * 1e6)),
            feeUnits: String(Math.max(0, 5000000 - Math.round(values.destinationAmount * 1e6))), blockNumber: values.destinationBlock,
            blockHash, transactionIndex: values.destinationIndex };
    };
    const resolveDestination = async input => {
        calls.resolutions.push(input);
        if (values.resolutionError) throw values.resolutionError;
        return values.resolution ?? null;
    };
    const args = { config, store, client, providers, bridge, clock: () => clock.now, sourceProof, destinationProof, resolveDestination };
    const withSnapshot = coordinator => {
        coordinator.verifyRecipient = async block => {
            if (values.snapshotError) throw values.snapshotError;
            return { blockNumber: block, blockHash, wallet, recipient, sourceToken: BRIDGE.sourceToken.toLowerCase(),
                destinationToken: BRIDGE.destinationToken.toLowerCase(), sourceBalanceUnits: String(Math.round(expectedWalletBalance(state) * 1e6)),
                destinationBalanceUnits: values.destinationAvailable ? String(Math.round(values.destinationAmount * 1e6)) : '0',
                recipientAccount: { kind: 'eoa' } };
        };
        return coordinator;
    };
    const coordinator = withSnapshot(new ProfitTakingCoordinator(args));
    const advance = (ms = 15000) => { clock.now += ms; };
    const restart = () => withSnapshot(new ProfitTakingCoordinator(args));
    return { coordinator, config, store, state, values, prepared, providers, calls, saves, events, clock, advance, restart };
}

async function continuousFixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-profit-continuous-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const config = loadLiveConfig({ RESTART_DATA_DIR: directory, PROXY_WALLET_ADDRESS: wallet,
        LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient });
    return fixture({ config, state: { startedAt: base - 72 * 3600000,
        completed: Array.from({ length: 31 }, (_, index) => ({ traded: true,
            pnl: index === 0 ? 6 : 0, fees: 0, gas: 0, uncertain: false })) } });
}

test('wallet-balance configuration is explicit and leaves the legacy default identity unchanged', () => {
    const env = { LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient };
    const legacy = loadProfitTakingConfig(env);
    assert.deepEqual(legacy, { enabled: true, recipient, asset: 'USDC', chainId: 137, chunkUsd: 5, retainUsd: 20,
        sourceToken: BRIDGE.sourceToken.toLowerCase(), destinationToken: BRIDGE.destinationToken.toLowerCase(),
        maxFeeUsd: .05, maxGasUsd: .15, maxSlippagePercent: 0, quoteAgeMs: 30000 });
    assert.deepEqual(loadProfitTakingConfig({ ...env, LAYA_PROFIT_TRIGGER: 'realized_profit' }), legacy);
    assert.deepEqual(loadProfitTakingConfig({ ...env, LAYA_PROFIT_TRIGGER: 'wallet_balance' }),
        { ...legacy, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15 });
    assert.throws(() => loadProfitTakingConfig({ ...env, LAYA_PROFIT_TRIGGER: 'anything' }), /invalid_profit_taking_trigger/);
});

function walletBalanceConfig() {
    return { settings: { wallet, pilotHours: 48, pilotMarkets: 100, drawdownStop: 20 },
        profitTaking: loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient,
            LAYA_PROFIT_TRIGGER: 'wallet_balance' }) };
}

async function lossFixture({ beforeBalance = 14, afterBalance = 11, outsideHalf = false } = {}) {
    const config = walletBalanceConfig();
    config.profitTaking = loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient,
        LAYA_PROFIT_TRIGGER: 'wallet_balance', LAYA_PROFIT_LOSS_PROTECTION_ENABLED: 'true' });
    const f = await fixture({ config, state: { completed: [], cash: beforeBalance, peakEquity: beforeBalance,
        lastEquity: beforeBalance, walletCashDelta: beforeBalance - 20 } });
    const marker = f.state.profitTakingControl.lossProtection;
    const activation = { schema: marker.schema, activatedAt: marker.activatedAt,
        completedCount: marker.completedCount, completedSha256: marker.completedSha256 };
    const before = { balance: beforeBalance, blockNumber: 90, blockHash, checkedAt: f.clock.now + 1000,
        walletCashDelta: beforeBalance - 20, externalCashDelta: 0, totalDeposited: 0, totalTokenDebited: 0 };
    const after = { ...before, balance: afterBalance, blockNumber: 99, checkedAt: f.clock.now + 3000,
        walletCashDelta: afterBalance - 20 };
    const fillHash = '0x' + 'c'.repeat(64), ownedOrder = '0x' + 'd'.repeat(64), condition = '0x' + 'e'.repeat(64);
    f.state.completed.push({ traded: true, pnl: afterBalance - beforeBalance, uncertain: false,
        openedAt: f.clock.now + 2000, closedAt: f.clock.now + 4000, conditionId: condition,
        fills: [{ hash: fillHash, orderId: ownedOrder, shares: 5, source: 'receipt' }],
        entrySignal: { lossProtection: { schema: 1,
            activationId: crypto.createHash('sha256').update(JSON.stringify(activation)).digest('hex'), before, after } } });
    f.state.settlementEvidence = { [fillHash]: { kind: 'fill', source: 'receipt', hash: fillHash,
        orderId: ownedOrder, conditionId: condition, blockNumber: 95, blockHash, shares: 5, cash: -3 } };
    f.state.cash = afterBalance; f.state.walletCashDelta = afterBalance - 20;
    f.advance(outsideHalf ? 160000 : 10000); f.prepared.createdAt = f.clock.now;
    return f;
}

test('loss protection is explicit, wallet-only, and never enabled by an invalid environment value', () => {
    const env = { LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient,
        LAYA_PROFIT_TRIGGER: 'wallet_balance', LAYA_PROFIT_LOSS_PROTECTION_ENABLED: 'true' };
    assert.deepEqual(loadProfitTakingConfig(env).lossProtection, { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 });
    assert.throws(() => loadProfitTakingConfig({ ...env, LAYA_PROFIT_TRIGGER: 'realized_profit' }), /invalid_profit_taking_loss_protection/);
    assert.throws(() => loadProfitTakingConfig({ ...env, LAYA_PROFIT_LOSS_PROTECTION_ENABLED: 'yes' }), /invalid_profit_taking_loss_protection/);
});

test('a fresh loss takes priority outside the usual window and claims its one withdrawal before route POST', async () => {
    const f = await lossFixture({ outsideHalf: true });
    f.coordinator.nextCheck = f.clock.now + 30000;
    f.values.createHook = () => {
        const saved = f.saves.at(-1), claim = saved.profitTakingControl.lossProtection.consumed[0];
        assert.equal(claim.intentId, saved.profitTakingControl.operation.id);
        assert.equal(claim.lossId, saved.profitTakingControl.operation.lossId);
        assert.equal(saved.profitTakingControl.operation.stage, 'address_requested');
    };
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 1);
    assert.equal(f.state.profitTaking.pending.amountUsd, 5);
    assert.equal(f.state.profitTakingControl.lossProtection.consumed.length, 1);
    f.values.sourceAvailable = true;
    f.advance(); await f.restart().tick();
    assert.equal(expectedWalletBalance(f.state), 6); assert.equal(f.state.stopped, null);
    complete(f); f.advance(); await f.restart().tick();
    assert.equal(f.state.profitTaking.pending, null); assert.equal(f.state.profitTaking.totalTransferred, 4.99);
    assert.equal(f.state.profitTaking.withdrawals[0].lossId, f.state.profitTakingControl.lossProtection.consumed[0].lossId);
    f.advance(30000); assert.equal(await f.restart().tick(), false);
    assert.equal(f.calls.broadcast.length, 1); assert.equal(f.calls.create, 1); assert.equal(f.state.stopped, null);
});

test('temporary bridge failure keeps a valid loss pending before entry and retries without consuming it', async () => {
    const f = await lossFixture();
    f.values.quoteError = new OperationalError('read_timeout', 'timeout');
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.create, 0); assert.equal(f.state.profitTakingControl.lossProtection.consumed.length, 0);
    assert.equal(await f.coordinator.tick(), true); assert.equal(f.calls.quote, 1);
    delete f.values.quoteError; f.advance(30000); f.prepared.createdAt = f.clock.now;
    assert.equal(await f.coordinator.tick(), true); assert.equal(f.calls.broadcast.length, 1);
});

test('a loss candidate rejected by permanent allocation guards never creates a retry entry hold', async () => {
    const f = await lossFixture();
    f.state.cash = 5;
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.quote, 0); assert.equal(f.calls.create, 0);
});

test('malformed bridge reads do not leave a loss retry hold, while temporarily expensive quotes do', async () => {
    const invalid = await lossFixture();
    invalid.values.quoteError = new OperationalError('invalid_bridge_quote', 'reconciliation');
    assert.equal(await invalid.coordinator.tick(), false);
    assert.equal(invalid.coordinator.waitingLossId, null);
    assert.equal(await invalid.coordinator.tick(), false);
    assert.equal(invalid.calls.create, 0); assert.equal(invalid.calls.broadcast.length, 0);
    const expensive = await lossFixture();
    expensive.values.quoteError = new OperationalError('bridge_quote_exceeds_budget', 'reconciliation');
    assert.equal(await expensive.coordinator.tick(), true);
    assert.equal(await expensive.coordinator.tick(), true);
    assert.equal(expensive.calls.quote, 1); assert.equal(expensive.calls.create, 0);
});

test('post-loss threshold failure cannot be revived by a later topup and does not hold normal trading', async () => {
    const f = await lossFixture({ afterBalance: 10 });
    assert.equal(await f.coordinator.tick(), false);
    f.state.externalWalletActivity = { cashDelta: 2, receipts: [{ hash: '0x' + 'f'.repeat(64), cash: 2 }] };
    f.advance(30000);
    assert.equal(await f.restart().tick(), false); assert.equal(f.calls.broadcast.length, 0); assert.equal(f.calls.create, 0);
});

test('a fresh-wallet change before source reservation abandons a claimed loss route without retrying its intent', async () => {
    const f = await lossFixture();
    f.values.prepareHook = () => { f.state.walletCashDelta -= 1; f.state.cash -= 1; };
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 0);
    assert.equal(f.state.profitTakingControl.lossProtection.consumed.length, 1);
    assert.equal(f.state.profitTakingControl.operation, null);
    f.advance(300000); assert.equal(await f.restart().tick(), false);
    assert.equal(f.calls.create, 1); assert.equal(f.state.stopped, null);
});

test('a topup reaching the normal threshold cannot silently change a claimed loss intent before source send', async () => {
    const f = await lossFixture();
    f.values.prepareHook = () => {
        f.state.externalWalletActivity = { cashDelta: 4, receipts: [{ hash: '0x' + 'f'.repeat(64), cash: 4 }] };
    };
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(expectedWalletBalance(f.state), 15);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 0);
    assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(f.state.profitTakingControl.abandoned.at(-1).reason, 'profit_taking_loss_witness_changed');
    assert.equal(f.state.profitTakingControl.lossProtection.consumed.length, 1);
    assert.equal(f.state.stopped, null);
});

test('an uncertain loss route-creation POST remains consumed after restart and never resends', async () => {
    const f = await lossFixture();
    f.values.createError = new OperationalError('read_timeout', 'timeout');
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.state.profitTakingControl.operation.stage, 'address_unknown');
    assert.equal(f.state.profitTakingControl.lossProtection.consumed.length, 1);
    f.advance(300000); assert.equal(await f.restart().tick(), false);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 0);
});

test('balance coordinator withdraws gross five at exactly fifteen and does not repeat after restart at ten', async () => {
    const f = await fixture({ config: walletBalanceConfig(), state: { cash: 14.9, peakEquity: 20, lastEquity: 14.9,
        walletCashDelta: -5, completed: [{ traded: true, pnl: -5.1, fees: 0, gas: .1, uncertain: false }] } });
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.broadcast.length, 1);
    assert.equal(f.state.profitTaking.policy.trigger, 'wallet_balance');
    assert.equal(f.state.profitTaking.policy.retainUsd, 10);
    f.values.sourceAvailable = true;
    f.advance();
    await f.restart().tick();
    assert.equal(expectedWalletBalance(f.state), 10);
    assert.equal(f.calls.broadcast.length, 1);
    complete(f);
    f.advance();
    await f.restart().tick();
    assert.equal(f.state.profitTaking.pending, null);
    assert.equal(f.state.profitTaking.totalTransferred, 4.99);
    assert.equal(expectedWalletBalance(f.state), 10);
    const report = profitTakingReport(f.state, f.config.profitTaking);
    assert.equal(report.trigger, 'wallet_balance');
    assert.equal(report.thresholdUsd, 15);
    assert.equal(report.retainUsd, 10);
    assert.equal(report.totalPUSDDebited, 5);
    assert.equal(report.budget.walletCash, 10);
    assert.equal(report.budget.cashBasis, 'expected_wallet');
    assert.equal(report.budget.walletBalanceVerified, false);
    assert.equal(report.tradingPnlAfterWithdrawalCosts, -5.116);
    f.advance(30000);
    assert.equal(await f.restart().tick(), false);
    assert.equal(f.calls.create, 1);
    assert.equal(f.calls.broadcast.length, 1);
});

test('manual cash decrease before source reservation abandons unused route without stopping trading', async () => {
    const f = await fixture({ config: walletBalanceConfig(), state: { cash: 15, peakEquity: 20, lastEquity: 15,
        walletCashDelta: -5, completed: [{ traded: true, pnl: -5, fees: 0, gas: 0, uncertain: false }] } });
    f.values.prepareHook = () => { f.state.walletCashDelta -= 1; f.state.cash -= 1; };
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.calls.prepare, 1);
    assert.equal(f.calls.broadcast.length, 0);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.profitTaking?.pending, undefined);
    assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(f.state.profitTakingControl.abandoned.at(-1).reason, 'profit_taking_wallet_cash');
});

test('favorable destination settles after restart and reports conversion separately from trading profit', async () => {
    const f = await fixture({ config: walletBalanceConfig(), state: { cash: 15, peakEquity: 20, lastEquity: 15,
        walletCashDelta: -5, completed: [{ traded: true, pnl: -5, fees: 0, gas: 0, uncertain: false }] },
        values: { destinationAmount: 5.000121 } });
    await f.coordinator.tick();
    f.values.sourceAvailable = true; f.advance();
    await f.restart().tick();
    const sourceSpendable = distributionAdjustedCash(f.state);
    completeThroughUserOperations(f, 5.000121);
    f.advance();
    await f.restart().tick();
    assert.equal(f.state.profitTaking.pending, null);
    assert.equal(f.state.stopped, null);
    assert.equal(f.state.profitTaking.totalTransferred, 5.000121);
    assert.equal(f.state.profitTakingControl.lastCompleted.feeUsd, 0);
    assert.equal(f.state.profitTakingControl.lastCompleted.conversionGainUsd, .000121);
    assert.equal(expectedWalletBalance(f.state), 10);
    assert.equal(distributionAdjustedCash(f.state), sourceSpendable);
    const report = profitTakingReport(f.state, f.config.profitTaking);
    assert.equal(report.bridgeConversionGainUsd, .000121);
    assert.equal(report.bridgeFeesUsd, 0);
    assert.equal(report.tradingPnlAfterWithdrawalCosts, -5.006);
    f.advance(30000); await f.restart().tick();
    assert.equal(f.calls.broadcast.length, 1);
    assert.equal(f.state.profitTaking.withdrawals.length, 1);
});

test('switching a persisted withdrawal policy still requires an audited migration', async () => {
    const f = await fixture();
    f.config.profitTaking = walletBalanceConfig().profitTaking;
    assert.throws(() => f.restart(), /profit_taking_configuration_changed/);
    assert.equal(f.calls.broadcast.length, 0);
});

test('shutdown or an entry hold arriving during bridge reads prevents every new source transfer', async t => {
    for (const stage of ['quote', 'create', 'prepare', 'wallet']) {
        for (const reason of ['shutdown', 'entry_hold', 'risk_stop']) {
            const f = await continuousFixture(t);
            const block = () => {
                if (reason === 'shutdown') f.coordinator.closed = true;
                if (reason === 'entry_hold') f.state.entryHolds = { network: { retryable: true } };
                if (reason === 'risk_stop') f.state.liveRiskStop = { reason: 'drawdown_limit', at: f.clock.now };
            };
            if (stage === 'quote') f.values.quoteHook = block;
            if (stage === 'create') f.values.createHook = block;
            if (stage === 'prepare') f.values.prepareHook = block;
            if (stage === 'wallet') f.coordinator.wallet = async () => {
                block(); return { block: 200, actual: expectedWalletBalance(f.state) };
            };
            await f.coordinator.tick();
            assert.equal(f.calls.broadcast.length, 0, `${stage}/${reason}`);
            assert.equal(f.state.profitTaking?.pending ?? null, null, `${stage}/${reason}`);
            if (stage !== 'create' && stage !== 'prepare') assert.equal(f.calls.create, 0);
        }
    }
});

test('shutdown and entry holds still reconcile a previously durable uncertain withdrawal without resubmitting', async () => {
    const f = await fixture();
    await f.coordinator.tick();
    assert.equal(f.calls.broadcast.length, 1);
    f.coordinator.closed = true; f.state.entryHolds = { network: { retryable: true } };
    f.values.sourceAvailable = true;
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
    assert.equal(f.calls.broadcast.length, 1);
});

async function sourceConfirmed(f) {
    await f.coordinator.tick(); f.values.sourceAvailable = true; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
}
function complete(f, amount = 4.99) {
    f.values.destinationAmount = amount; f.values.destinationAvailable = true;
    f.values.match = { status: 'COMPLETED', transactionHash: destinationHash, createdAt: f.clock.now,
        destinationAmountUnits: String(Math.round(amount * 1e6)), from: null };
}

function completeThroughUserOperations(f, amount = 4.99) {
    complete(f, amount);
    f.values.match.transactionHash = '0x' + 'c'.repeat(64);
    f.values.intermediates = [{ status: 'COMPLETED', transactionHash: '0x' + 'd'.repeat(64) }];
    f.values.resolution = { transactionHash: destinationHash, destinationAmountUnits: String(Math.round(amount * 1e6)), correlation: { schema: 1,
        sourceHash: f.prepared.hash.toLowerCase(), withdrawalAddress: routeAddress, recipient,
        destinationHash, orderId: '0x' + 'e'.repeat(64) } };
}

test('a correlated UserOperation withdrawal settles after restart exactly once and preserves an existing stop', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    const source = structuredClone(f.state.profitTaking.pending.sourceReceipt);
    const funding = structuredClone(f.state.liveFunding), startedAt = f.state.startedAt;
    const stopped = f.state.stopped = { reason: 'manual_stop', at: f.clock.now };
    const restarted = f.restart(); f.advance(); await restarted.tick();
    assert.equal(f.calls.resolutions.length, 1);
    assert.equal(f.calls.resolutions[0].sourceReceipt.transactionHash, f.prepared.hash);
    assert.deepEqual(f.calls.resolutions[0].intermediates, f.values.intermediates);
    assert.equal(f.state.profitTaking.totalTransferred, 4.99);
    assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.deepEqual(f.state.profitTaking.withdrawals[0].sourceReceipt, source);
    assert.equal(f.state.profitTaking.pending, null);
    assert.equal(f.state.profitTakingControl.operation, null);
    assert.deepEqual(f.state.profitTakingControl.lastCompleted.correlation, f.values.resolution.correlation);
    assert.equal(profitWithdrawalPending(f.state), false);
    assert.deepEqual(f.state.stopped, stopped); assert.deepEqual(f.state.liveFunding, funding);
    assert.equal(f.state.startedAt, startedAt);
    const again = f.restart(); f.advance(); await again.tick();
    assert.equal(f.state.profitTaking.withdrawals.length, 1);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
});

test('resolver output amount constrains final proof even when bridge status omits the amount', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f, 5.000121);
    delete f.values.match.destinationAmountUnits;
    f.values.resolution.destinationAmountUnits = '4990000';
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.withdrawalConversionGainUsd, undefined);
    assert.equal(f.state.stopped.reason, 'profit_destination_receipt_unproven');
});

test('status output differing from authoritative resolver mapping cannot settle a withdrawal', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f, 5.000121);
    f.values.match.destinationAmountUnits = '5000122';
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTakingControl.lastReconciliation.error.code, 'bridge_destination_correlation_mismatch');
});

test('direct batched credits to the recipient cannot become conversion gain without authoritative exact output', async () => {
    const f = await fixture(); await sourceConfirmed(f);
    complete(f, 5.000121); delete f.values.match.destinationAmountUnits;
    const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    const directReceipt = { transactionHash: destinationHash, blockNumber: 101, blockHash, transactionIndex: 3,
        confirmations: 4, status: 1, logs: ['4990000', '10121'].map((amount, index) => ({
            address: BRIDGE.destinationToken, logIndex: index,
            ...erc20.encodeEventLog(erc20.getEvent('Transfer'), [other, recipient, amount]) })) };
    const originalReceipt = f.coordinator.client.verifiedReceipt;
    f.coordinator.client.verifiedReceipt = async (hash, block) => hash === destinationHash
        ? directReceipt : originalReceipt(hash, block);
    const originalRead = f.coordinator.client.rpc.read;
    f.coordinator.client.rpc.read = async (stage, task, block) => stage === 'profit_destination_block'
        ? task({ async getBlock(number) { return { number, hash: blockHash, timestamp: Math.floor(f.clock.now / 1000) }; } })
        : originalRead(stage, task, block);
    f.coordinator.destinationProof = verifyBridgeDestinationReceipt;
    f.advance(); await f.coordinator.tick();
    assert.equal(f.calls.resolutions.length, 1);
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.withdrawalConversionGainUsd, undefined);
    assert.equal(f.state.profitTakingControl.lastReconciliation.error.code, 'bridge_destination_receipt_missing');
    f.values.resolution = { transactionHash: destinationHash, destinationAmountUnits: '4990000', correlation: {
        schema: 1, sourceHash: f.prepared.hash.toLowerCase(), withdrawalAddress: routeAddress,
        recipient, destinationHash, orderId: '0x' + 'e'.repeat(64) } };
    f.advance(60000); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.stopped.reason, 'profit_destination_receipt_unproven');
    assert.equal(f.calls.broadcast.length, 1);
});

test('unavailable authoritative correlation retains pending funds and reports its domain stage', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    f.values.resolutionError = new OperationalError('bridge_relay_mapping_unavailable', 'reconciliation',
        { stage: 'bridge_correlation', endpoint: 'relay' });
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.state.stopped, null);
    assert.equal(profitTakingReport(f.state, f.config.profitTaking).lastReconciliation.error.code,
        'bridge_relay_mapping_unavailable');
    const event = f.events.findLast(row => row.type === 'profit_withdrawal_retry');
    assert.equal(event.error.stage, 'bridge_correlation'); assert.equal(event.error.endpoint, 'relay');
    assert.equal(f.calls.broadcast.length, 1);
});

test('a missing reported receipt without a correlated destination remains pending with an explicit error', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    f.values.resolution = null; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 0); assert.ok(f.state.profitTaking.pending);
    assert.equal(f.state.profitTakingControl.lastReconciliation.error.code, 'bridge_destination_receipt_missing');
    assert.equal(f.calls.broadcast.length, 1);
});

test('provider Retry-After longer than normal backoff delays reconciliation without retrying writes', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    f.values.resolutionError = new OperationalError('bridge_relay_mapping_unavailable', 'rate_limit',
        { stage: 'bridge_correlation', endpoint: 'relay', retryAfter: 120 });
    f.advance(); await f.coordinator.tick();
    const count = f.calls.resolutions.length;
    assert.equal(f.coordinator.nextPoll - f.clock.now, 120000);
    f.advance(60000); await f.coordinator.tick();
    assert.equal(f.calls.resolutions.length, count);
    assert.ok(f.state.profitTaking.pending); assert.equal(f.calls.broadcast.length, 1);
});

test('resolved recipient payouts still require canonical destination proof', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    f.values.destinationUnproven = true; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.stopped.reason, 'profit_destination_receipt_unproven');
    assert.ok(f.state.profitTaking.pending); assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.calls.broadcast.length, 1);
});

test('resolution cannot change the source, withdrawal address, recipient, destination or order identity', async () => {
    for (const key of ['sourceHash', 'withdrawalAddress', 'recipient', 'destinationHash', 'orderId']) {
        const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
        f.values.resolution.correlation[key] = key === 'orderId' ? null : '0x' + '9'.repeat(40);
        f.advance(); await f.coordinator.tick();
        assert.equal(f.state.profitTaking.totalTransferred, 0, key); assert.ok(f.state.profitTaking.pending, key);
        assert.equal(f.state.profitTakingControl.lastReconciliation.error.code, 'bridge_destination_correlation_mismatch', key);
    }
});

test('duplicate intermediate operations across status pages cannot resolve or book a payout', async () => {
    const f = await fixture(); await sourceConfirmed(f); completeThroughUserOperations(f);
    f.values.statusResult = { match: null, intermediates: f.values.intermediates, nextCursor: 'next-page' };
    f.advance(); await f.coordinator.tick();
    assert.equal(f.calls.resolutions.length, 0); assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.ok(f.state.profitTaking.pending);
    assert.equal(f.state.profitTakingControl.lastReconciliation.error.code, 'ambiguous_bridge_status');
});

test('two-stage withdrawal persists each write intent and books source gas, then actual USDC and withheld fee exactly once', async () => {
    const f = await fixture();
    assert.ok(persistedProfitTransferIdentity({ wallet, transfer: f.prepared }));
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.deepEqual(f.calls.broadcast, [f.prepared.hash]);
    assert.equal(f.state.cash, 26); assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.totalTokenDebited, 0); assert.equal(profitWithdrawalPending(f.state), true);
    f.values.sourceAvailable = true; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.cash, 25.994); assert.equal(f.state.profitTaking.totalTokenDebited, 5);
    assert.equal(f.state.profitTaking.totalTransferred, 0); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(expectedWalletBalance(f.state), 21); assert.equal(distributionAdjustedCash(f.state), 20.994);
    complete(f); f.advance(); await f.coordinator.tick();
    assert.equal(f.state.cash, 25.984); assert.equal(f.state.profitTaking.totalTransferred, 4.99);
    assert.equal(f.state.profitTaking.withdrawalFeesUsd, .01); assert.equal(f.state.profitTaking.pending, null);
    assert.equal(f.state.profitTakingControl.operation, null); assert.equal(profitWithdrawalPending(f.state), false);
    assert.equal(distributionAdjustedCash(f.state), 20.994); assert.equal(f.state.completed[0].pnl, 6);
    const restarted = f.restart(); f.advance(30000); await restarted.tick();
    assert.equal(f.state.profitTaking.withdrawals.length, 1); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 1);
    assert.equal(profitTakingReport(f.state, f.config.profitTaking).totalUSDCReceived, 4.99);
});

test('withdrawal checkpoints preserve engine, provider and callback decision-state references', async () => {
    const f = await fixture();
    const config = { ...f.config, policy: { provider: 'eligible', aiSource: 'deterministic-eligible-v1' },
        ai: { latencyMs: 250 } };
    const ai = initializeAI(f.state, config), snapshots = ai.snapshots, slots = ai.slots;
    const provider = new EligibleLiveProvider(config.ai, ai.providers);
    const engine = new LayaLiveEngine(config, f.store, f.coordinator.client, {}, provider);
    const callback = snapshotId => { snapshots.find(row => row.snapshotId === snapshotId).callbackSeen = true; };
    const recordAfterCheckpoint = stage => {
        assert.equal(engine.ai, f.state.ai);
        assert.equal(provider.state, f.state.ai.providers);
        assert.equal(snapshots, f.state.ai.snapshots);
        assert.equal(slots, f.state.ai.slots);
        engine.ai.snapshots.push({ snapshotId: stage });
        slots[stage] = { status: 'observed' };
        provider.state.eligible = { lastSnapshotId: stage };
        callback(stage);
        f.store.save();
        const saved = f.saves.at(-1).ai;
        assert.deepEqual(saved.snapshots.at(-1), { snapshotId: stage, callbackSeen: true });
        assert.deepEqual(saved.slots[stage], { status: 'observed' });
        assert.equal(saved.providers.eligible.lastSnapshotId, stage);
    };

    await f.coordinator.tick();
    recordAfterCheckpoint('source_uncertain');
    f.values.sourceAvailable = true; f.advance(); await f.coordinator.tick();
    recordAfterCheckpoint('in_transit');
    complete(f); f.advance(); await f.coordinator.tick();
    recordAfterCheckpoint('completed');
    assert.equal(f.saves.at(-1).ai.snapshots.length, 3);
    assert.equal(f.state.profitTaking.withdrawals.length, 1);
    assert.equal(f.state.profitTaking.totalTransferred, 4.99);
});

test('withdrawal replacement rejects divergent decision state before any ledger mutation or save', async () => {
    const f = await fixture({ state: { ai: { snapshots: [], slots: {}, providers: {} } } });
    const state = structuredClone(f.state), ai = f.state.ai, saveCount = f.saves.length;
    for (const change of [
        next => next.ai.snapshots.push({ snapshotId: 'unexpected' }),
        next => { next.ai.slots.unexpected = { status: 'observed' }; },
        next => { next.ai.providers.eligible = { disabled: 'unexpected' }; },
    ]) {
        const next = structuredClone(f.state);
        next.cash = 0;
        change(next);
        assert.throws(() => f.coordinator.replace(next), /profit_taking_ai_state_changed/);
        assert.deepEqual(f.state, state);
        assert.equal(f.state.ai, ai);
        assert.equal(f.saves.length, saveCount);
    }
});

test('continuous live profit-taking continues after 31 markets and 72 hours while pending withdrawals still block entries', async t => {
    const f = await continuousFixture(t), completed = structuredClone(f.state.completed), startedAt = f.state.startedAt;
    assert.equal(f.config.policy.pilotMarkets, null); assert.equal(f.config.policy.pilotHours, null);
    assert.equal(f.config.settings.pilotMarkets, Infinity); assert.equal(f.config.settings.pilotHours, Infinity);
    assert.equal(await f.coordinator.tick(), true);
    assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
    assert.throws(() => entryGuard({ state: f.state, config: f.config, now: f.clock.now }), /profit_withdrawal_pending/);
    const restarted = f.restart(); f.advance(); await restarted.tick();
    assert.equal(f.state.lastTickAt, f.clock.now); assert.equal(f.state.stopped, null);
    assert.deepEqual(f.calls.receipts, [f.prepared.hash]);
    f.values.sourceAvailable = true; f.advance(); await restarted.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
    assert.equal(f.state.stopped, null); assert.equal(profitWithdrawalPending(f.state), true);
    complete(f); f.advance(); await restarted.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 4.99); assert.equal(profitWithdrawalPending(f.state), false);
    assert.equal(f.state.stopped, null); assert.equal(f.state.startedAt, startedAt);
    assert.deepEqual(f.state.completed, completed);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
});

test('continuous live checkpoints preserve manual and drawdown stops while reconciling pending withdrawals past 30 markets', async t => {
    for (const reason of ['manual_stop', 'drawdown_limit']) {
        const f = await continuousFixture(t); await sourceConfirmed(f);
        const quote = f.state.profitTakingControl.operation.quote;
        if (reason === 'manual_stop') f.state.stopped = { reason, at: f.clock.now };
        else f.state.peakEquity = f.state.cash + f.config.settings.drawdownStop;
        complete(f); f.advance(); await f.coordinator.tick();
        assert.equal(f.state.stopped.reason, reason);
        if (reason === 'drawdown_limit') {
            assert.equal(f.config.settings.drawdownStop, 10);
            assert.ok(f.state.maxDrawdown >= 10);
        }
        assert.equal(f.state.profitTaking.totalTransferred, 4.99);
        assert.equal(profitWithdrawalPending(f.state), false);
        assert.throws(() => f.coordinator.assertInitiation(quote), /profit_taking_stopped/);
        assert.throws(() => entryGuard({ state: f.state, config: f.config, now: f.clock.now }), /pilot_stopped/);
        const stopped = structuredClone(f.state.stopped);
        f.advance(300000); assert.equal(await f.coordinator.tick(), false);
        assert.deepEqual(f.state.stopped, stopped);
        assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
    }
});

test('uncertain source submission survives restart and polls its exact hash without recreating a route or rebroadcasting', async () => {
    const f = await fixture({ values: { broadcastError: new Error('offline_write_uncertain') } });
    await f.coordinator.tick();
    const restarted = f.restart(); f.advance(180000); await restarted.tick();
    assert.equal(f.state.stopped.reason, 'profit_source_transaction_unknown');
    assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
    assert.deepEqual(f.calls.receipts, [f.prepared.hash]);
    f.values.sourceAvailable = true; f.advance(); await restarted.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
    assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.calls.broadcast.length, 1); assert.equal(f.state.stopped.reason, 'profit_source_transaction_unknown');
});

test('ambiguous withdrawal POST disables further route creation without reserving or moving funds', async () => {
    const f = await fixture({ values: { createError: new Error('offline_post_unknown') } });
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.state.profitTakingControl.operation.stage, 'address_unknown');
    assert.equal(f.state.profitTakingControl.disabled, 'bridge_withdrawal_creation_unknown');
    assert.equal(f.state.profitTaking, undefined); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast.length, 0);
    const restarted = f.restart(); f.advance(300000); await restarted.tick();
    assert.equal(f.calls.create, 1); assert.equal(f.state.cash, 26);
});

test('entry guards block even while the address-creation POST is awaiting its response', async () => {
    const f = await fixture();
    f.values.createHook = async () => {
        assert.equal(profitWithdrawalPending(f.state), true);
        assert.throws(() => entryGuard({ state: f.state, config: f.config, now: f.clock.now }), /profit_withdrawal_pending/);
    };
    await f.coordinator.tick(); assert.equal(f.calls.broadcast.length, 1);
});

test('restart after persisted address POST intent disables creation and never signs or sends', async () => {
    const f = await fixture();
    f.state.profitTakingControl.operation = { id: 'offline-post:1', stage: 'address_requested', createdAt: f.clock.now };
    f.store.save();
    const restarted = f.restart(); await restarted.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'address_unknown');
    assert.equal(f.state.profitTakingControl.disabled, 'bridge_withdrawal_creation_unknown');
    assert.equal(f.calls.create, 0); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast.length, 0);
});

test('inventory, stops, active inference and venue orders prevent source writes', async () => {
    for (const reason of ['inventory', 'stopped', 'active', 'orders']) {
        const f = await fixture();
        if (reason === 'inventory') f.state.position = { holdings: [1, 0] };
        if (reason === 'stopped') f.state.stopped = { reason: 'drawdown_limit' };
        if (reason === 'active') f.providers.active.set('offline', Promise.resolve());
        if (reason === 'orders') f.values.orders = [{ status: 'open' }];
        assert.equal(await f.coordinator.tick(), false, reason);
        assert.equal(f.calls.create, 0, reason); assert.equal(f.calls.prepare, 0, reason); assert.equal(f.calls.broadcast.length, 0, reason);
    }
});

test('deadline and market-count limits forbid a source transfer even with eligible profit', async () => {
    for (const reason of ['deadline', 'market_limit']) {
        const f = await fixture();
        if (reason === 'deadline') f.state.startedAt = f.clock.now - 48 * 3600000;
        else f.config.settings.pilotMarkets = 1;
        await f.coordinator.tick();
        assert.equal(f.calls.create, 0); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast.length, 0);
    }
});

test('a stop or deadline reached while preparing prevents broadcasting a previously signed source', async () => {
    for (const reason of ['stopped', 'deadline']) {
        const f = await fixture();
        f.values.prepareHook = async () => {
            if (reason === 'stopped') f.state.stopped = { reason: 'manual_stop' };
            else f.clock.now = f.state.startedAt + 48 * 3600000;
        };
        await f.coordinator.tick();
        assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 0);
        assert.equal(f.state.profitTaking, undefined);
    }
});

test('withdrawal network waits cannot carry source preparation or broadcasting into the decision half of a market', async () => {
    const f = await fixture();
    f.values.createHook = async () => { f.clock.now = base + 151000; };
    await f.coordinator.tick();
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast.length, 0);
});

test('returned signed source intent must match the exact pUSD token, fresh route and $5 amount before sending', async () => {
    for (const change of [{ token: other }, { recipient: other }, { amount: 4 }]) {
        const f = await fixture({ transferIntent: change });
        assert.ok(persistedProfitTransferIdentity({ wallet, transfer: f.prepared }));
        await f.coordinator.tick();
        assert.equal(f.calls.broadcast.length, 0, JSON.stringify(change));
        assert.equal(f.state.profitTaking, undefined);
    }
});

test('source wallet mismatch, excessive gas reserve and malformed signed response prevent any source write', async () => {
    for (const reason of ['wallet', 'gas', 'raw']) {
        const f = await fixture();
        if (reason === 'wallet') f.values.balanceOverride = 100;
        if (reason === 'gas') f.values.preparedOverrides = { maxGasUsd: .150001 };
        if (reason === 'raw') f.values.preparedOverrides = { raw: '0x' };
        await f.coordinator.tick();
        assert.equal(f.calls.broadcast.length, 0, reason); assert.equal(f.state.profitTaking, undefined, reason);
        if (reason === 'wallet') assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    }
});

test('transient reads preserve exact pending identity and backoff without repeating either financial write', async () => {
    const f = await fixture(); await f.coordinator.tick();
    f.values.receiptError = new Error('offline_read_failure'); f.advance(); await f.coordinator.tick();
    const polls = f.calls.receipts.length;
    f.advance(1000); await f.coordinator.tick(); assert.equal(f.calls.receipts.length, polls);
    f.advance(15000); await f.coordinator.tick(); assert.equal(f.calls.receipts.length, polls + 1);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
    assert.equal(f.state.cash, 26); assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
});

test('invalid source proof cannot book gas, debit principal or resolve the source hash', async () => {
    const f = await fixture(); await f.coordinator.tick();
    f.values.sourceAvailable = true; f.values.sourceUnproven = true; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.stopped.reason, 'profit_source_receipt_unproven');
    assert.equal(f.state.cash, 26); assert.equal(f.state.profitTaking.totalTokenDebited, 0);
    assert.equal(f.state.profitTaking.withdrawalGasUsd, 0); assert.equal(f.state.profitTakingControl.operation.stage, 'source_uncertain');
});

test('canonical failed source books gas before disabling the feature and never redistributes principal', async () => {
    const f = await fixture({ values: { sourceStatus: 'failed', sourceAvailable: true } });
    await f.coordinator.tick(); f.advance(); await f.coordinator.tick();
    assert.equal(f.state.cash, 25.994); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.state.profitTaking.totalTokenDebited, 0); assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.pending, null); assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(f.state.profitTakingControl.disabled, 'profit_source_transaction_failed');
    const restarted = f.restart(); f.advance(300000); await restarted.tick();
    assert.equal(f.state.profitTaking.withdrawals.length, 1); assert.equal(f.calls.broadcast.length, 1);
});

test('pending settlement still reconciles after a stop while new entries remain blocked', async () => {
    const f = await fixture(); await sourceConfirmed(f);
    f.state.stopped = { reason: 'manual_stop' };
    assert.throws(() => entryGuard({ state: { ...f.state, stopped: null }, config: f.config, now: f.clock.now }), /profit_withdrawal_pending/);
    complete(f); f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 4.99); assert.equal(f.state.stopped.reason, 'manual_stop');
    assert.equal(f.calls.broadcast.length, 1);
});

test('bridge failure retains the in-transit reservation and source debit without another transfer', async () => {
    const f = await fixture(); await sourceConfirmed(f);
    f.values.match = { status: 'FAILED', transactionHash: null, createdAt: f.clock.now };
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.stopped.reason, 'profit_bridge_failed_funds_unresolved');
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit'); assert.equal(f.state.profitTaking.totalTransferred, 0);
    const restarted = f.restart(); f.advance(); await restarted.tick();
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 1); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
});

test('actual USDC delivery and an over-budget bridge fee are booked before stopping future work', async () => {
    const f = await fixture(); await sourceConfirmed(f); complete(f, 4.9); f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 4.9); assert.equal(f.state.profitTaking.withdrawalFeesUsd, .1);
    assert.equal(f.state.cash, 25.894); assert.equal(f.state.stopped.reason, 'profit_bridge_fee_exceeded');
    assert.equal(f.state.profitTaking.pending, null); assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(profitTakingLedger(f.state).withdrawals.length, 1);
});

test('provider COMPLETED and a destination receipt without canonical proof never establish USDC delivery', async () => {
    const f = await fixture(); await sourceConfirmed(f); complete(f); f.values.destinationUnproven = true;
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.stopped.reason, 'profit_destination_receipt_unproven');
    assert.equal(f.state.profitTaking.totalTransferred, 0); assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
    assert.equal(f.state.cash, 25.994); assert.equal(f.calls.broadcast.length, 1);
});

test('a destination transaction preceding its source in the same block cannot establish delivery', async () => {
    const f = await fixture(); await sourceConfirmed(f); complete(f);
    f.values.destinationBlock = 100; f.values.destinationIndex = 1;
    f.advance(); await f.coordinator.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 0);
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit');
});

test('policy and signed pending identity mutations fail closed on restart', async () => {
    for (const change of ['recipient', 'token', 'amount', 'nonce', 'raw']) {
        const f = await fixture(); await f.coordinator.tick();
        if (change === 'recipient') f.config.profitTaking.recipient = other;
        if (change === 'token') f.state.profitTakingControl.operation.transfer.token = other;
        if (change === 'amount') f.state.profitTakingControl.operation.transfer.amount = 4;
        if (change === 'nonce') f.state.profitTakingControl.operation.transfer.safeNonce = '8';
        if (change === 'raw') f.state.profitTakingControl.operation.transfer.raw = '0x';
        assert.throws(f.restart, /profit_taking_configuration_changed|invalid_profit_taking_operation/, change);
        assert.equal(f.calls.broadcast.length, 1);
    }
});

test('a save failure before source intent persistence never broadcasts', async () => {
    const f = await fixture();
    f.values.prepareHook = async () => { f.values.saveError = true; };
    await assert.rejects(f.coordinator.tick(), /offline_save_failed/);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.broadcast.length, 0);
});

test('a known pre-source preparation failure archives its unused route and releases the entry guard', async () => {
    const f = await fixture({ values: { prepareError: new Error('offline_preparation_failed') } });
    assert.equal(await f.coordinator.tick(), false);
    assert.equal(f.state.profitTaking, undefined); assert.equal(f.state.profitTakingControl.operation, null);
    assert.equal(profitWithdrawalPending(f.state), false);
    assert.equal(f.state.profitTakingControl.abandoned.at(-1).address, routeAddress);
    assert.equal(f.calls.create, 1); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 0);
    f.values.prepareError = null; f.advance(30000); await f.coordinator.tick();
    assert.equal(f.calls.create, 1, 'Known unused route failure must not create another route immediately');
});

test('source accounting stays durable and charges gas once when the subsequent wallet check fails', async () => {
    const f = await fixture(); await f.coordinator.tick();
    f.values.sourceAvailable = true; f.values.balanceOverride = 100; f.advance(); await f.coordinator.tick();
    assert.equal(f.state.stopped.reason, 'wallet_ledger_mismatch');
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
    assert.equal(f.state.cash, 25.994); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.saves.at(-1).profitTaking.withdrawalGasUsd, .006, 'Source accounting must be durable before dependent reads');
    f.values.balanceOverride = undefined;
    const restarted = f.restart(); complete(f); f.advance(); await restarted.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 4.99); assert.equal(f.state.profitTaking.withdrawalGasUsd, .006);
    assert.equal(f.calls.broadcast.length, 1); assert.equal(f.calls.create, 1);
});

test('disabled configuration still reconciles an existing financial intent without authorizing a new one', async () => {
    const f = await fixture(); await f.coordinator.tick(); f.config.profitTaking.enabled = false;
    const restarted = f.restart(); f.values.sourceAvailable = true; f.advance(); await restarted.tick();
    assert.equal(f.state.profitTakingControl.operation.stage, 'in_transit');
    complete(f); f.advance(); await restarted.tick();
    assert.equal(f.state.profitTaking.totalTransferred, 4.99); assert.equal(f.calls.broadcast.length, 1);
    f.advance(300000); await restarted.tick(); assert.equal(f.calls.create, 1);
});
