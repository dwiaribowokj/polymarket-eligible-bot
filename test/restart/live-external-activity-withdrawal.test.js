import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalActivityReconciler, externalActivityCandidate } from '../../src/laya-live/external-activity.js';
import { reserveProfitWithdrawal, applyProfitWithdrawalSource, profitTakingLedger }
    from '../../src/laya-live/profit-accounting.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { ProfitTakingCoordinator, loadProfitTakingConfig } from '../../src/laya-live/profit-taking.js';

const hash = digit => `0x${digit.repeat(64)}`;
const wallet = `0x${'b'.repeat(40)}`, recipient = `0x${'a'.repeat(40)}`;
const now = 1800000000000, sourceHash = hash('1'), manualHash = hash('2'), anchorHash = hash('3');
const policy = { recipient, asset: 'USDC', chunkUsd: 5, retainUsd: 20 };

function fixture({ stage = 'in_transit' } = {}) {
    let state = { baseline: 'external-withdrawal-test', startedAt: now - 1000, mode: 'pilot', strategy: 'late-entry',
        decisionProvider: 'eligible', cash: 26, peakEquity: 26, lastEquity: 26, maxDrawdown: 0,
        stopped: null, position: null, liveFunding: { initialCapital: 20 }, walletStart: 20, walletCashDelta: 6,
        completed: [{ traded: true, pnl: 6, fees: .02, gas: .001 }], seen: {}, failures: 0,
        strategyEpochs: [{ walletProof: { blockNumber: 50, blockHash: hash('4'), balance: 26,
            trades: {}, holdingsProof: { holdings: [] } } }] };
    const operation = { id: 'withdrawal:1', createdAt: now, stage };
    if (['in_transit', 'source_uncertain'].includes(stage)) {
        state = reserveProfitWithdrawal(state, policy, { id: operation.id, hash: sourceHash, createdAt: now,
            gasReserveUsd: .01, feeReserveUsd: .00004, openOrders: [], walletBalance: 26 });
        if (stage === 'in_transit') state = applyProfitWithdrawalSource(state, {
            id: operation.id, hash: sourceHash, recipient, asset: 'USDC', amountUsd: 5,
            status: 'confirmed', tokenDebitUsd: 5, gasUsd: .006, feeUsd: 0,
            blockNumber: 70, blockHash: hash('5'),
        });
        operation.transfer = { hash: sourceHash }; operation.submittedAt = now;
    }
    state.profitTakingControl = { schema: 1, policy, operation };
    const f = { state, balance: expectedWalletBalance(state) - 2, calls: [], saves: 0, writes: [],
        config: { settings: { automaticManualActivity: true, wallet } } };
    f.store = { state, save() { f.saves++; }, event() { this.save(); }, stop() { assert.fail('No permanent stop'); } };
    const forbid = name => () => { f.writes.push(name); assert.fail('No financial writes'); };
    f.client = {
        confirmedBlock: async () => 100, balance: async () => f.balance,
        holdings: async tokens => tokens.map(token => token === '51' ? 4 : 0),
        rpc: { anchor: { number: 100, hash: anchorHash },
            read: async (_stage, task) => task({ getBlock: async number => ({ number,
                hash: number === 50 ? hash('4') : anchorHash }) }) },
        prepare: forbid('prepare'), post: forbid('post'), prepareAction: forbid('prepareAction'),
        broadcastAction: forbid('broadcastAction'), cancel: forbid('cancel'),
    };
    f.reconciler = new ExternalActivityReconciler(f.config, f.store, f.client, { now: () => now + 1000,
        discover: async (_client, options) => {
            f.calls.push(options);
            return { receipts: [{ hash: manualHash, blockNumber: 80, blockHash: hash('6'), cash: -2,
                tokenIds: ['51'], holdings: [4] }], externalCashDelta: -2, tokenIds: ['51'],
                holdingsDeltas: [{ tokenId: '51', amount: 4 }], deposits: [], depositAmount: 0,
                checkpoint: { blockNumber: 100, blockHash: anchorHash } };
        } });
    return f;
}

test('a booked withdrawal source permits separate manual accounting until destination settlement', async () => {
    const f = fixture(), before = structuredClone(f.state);
    assert.equal(expectedWalletBalance(f.state), 21);
    assert.equal(externalActivityCandidate(f.config, f.state), true);
    assert.equal((await f.reconciler.preview()).ready, true);
    assert.deepEqual(f.state, before); assert.equal(f.saves, 0);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(expectedWalletBalance(f.state), 19);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    assert.deepEqual(f.state.externalWalletActivity.receipts.map(row => row.hash), [manualHash]);
    assert(f.calls.every(call => call.knownHashes.includes(sourceHash)));
    for (const key of ['cash', 'peakEquity', 'lastEquity', 'maxDrawdown', 'completed', 'liveFunding',
        'walletCashDelta', 'profitTaking', 'profitTakingControl']) assert.deepEqual(f.state[key], before[key], key);
    assert.equal(profitTakingLedger(f.state).totalTokenDebited, 5);
    assert.equal(f.state.profitTaking.pending.stage, 'in_transit'); assert.deepEqual(f.writes, []);
});

test('pre-source withdrawal routes permit manual reconciliation before a signed transfer is persisted', async t => {
    for (const stage of ['address_requested', 'address_ready']) await t.test(stage, async () => {
        const f = fixture({ stage }), before = structuredClone(f.state.profitTakingControl);
        assert.equal(externalActivityCandidate(f.config, f.state), true);
        assert.equal(await f.reconciler.reconcile(), true);
        assert.equal(expectedWalletBalance(f.state), 24);
        assert.equal(f.state.cash, 26); assert.deepEqual(f.state.profitTakingControl, before);
        assert.deepEqual(f.writes, []);
    });
});

test('withdrawal coordinator wallet reads reconcile manual cash changes instead of waiting on their own operation', async t => {
    for (const stage of ['address_ready', 'in_transit']) await t.test(stage, async () => {
        const f = fixture({ stage }), operation = structuredClone(f.state.profitTakingControl.operation);
        const coordinator = Object.assign(Object.create(ProfitTakingCoordinator.prototype), {
            config: f.config, store: f.store, client: f.client, externalActivity: f.reconciler,
        });
        assert.deepEqual(await coordinator.wallet(100), { block: 100, actual: stage === 'in_transit' ? 19 : 24 });
        assert.equal(f.state.externalWalletActivity.cashDelta, -2);
        assert.deepEqual(f.state.profitTakingControl.operation, operation);
        assert.equal(expectedWalletBalance(f.state), f.balance); assert.deepEqual(f.writes, []);
    });
});

test('restart with an unknown unused route preserves disabled withdrawal while reconciling manual cash', async () => {
    const f = fixture({ stage: 'address_requested' });
    f.config.profitTaking = loadProfitTakingConfig({ LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: recipient });
    const { enabled: _enabled, ...configuredPolicy } = f.config.profitTaking;
    f.state.profitTakingControl.policy = configuredPolicy;
    const coordinator = new ProfitTakingCoordinator({ config: f.config, store: f.store, client: f.client,
        bridge: {}, providers: { active: new Map() }, clock: () => now + 1000 });
    coordinator.externalActivity = f.reconciler;
    assert.equal(f.state.profitTakingControl.operation.stage, 'address_unknown');
    assert.equal(f.state.profitTakingControl.disabled, 'bridge_withdrawal_creation_unknown');
    const before = structuredClone(f.state.profitTakingControl);
    assert.equal(await coordinator.tick(), false);
    assert.equal(externalActivityCandidate(f.config, f.state), true);
    assert.equal(await f.reconciler.reconcile(), true);
    assert.equal(expectedWalletBalance(f.state), 24);
    assert.equal(f.state.externalWalletActivity.cashDelta, -2);
    assert.equal(f.state.cash, 26);
    assert.deepEqual(f.state.profitTakingControl, before);
    assert.equal(f.state.profitTaking?.pending, undefined);
    assert.deepEqual(f.writes, []);
});

test('unknown routes with inconsistent disablement or any source intent remain excluded', async t => {
    const changes = {
        'not disabled': f => { delete f.state.profitTakingControl.disabled; },
        'other disable reason': f => { f.state.profitTakingControl.disabled = 'profit_source_transaction_failed'; },
        'signed transfer': f => { f.state.profitTakingControl.operation.transfer = { hash: sourceHash }; },
        'submitted timestamp': f => { f.state.profitTakingControl.operation.submittedAt = now; },
        'reserved ledger': f => { f.state.profitTaking = fixture({ stage: 'source_uncertain' }).state.profitTaking; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
        const f = fixture({ stage: 'address_unknown' });
        f.state.profitTakingControl.disabled = 'bridge_withdrawal_creation_unknown'; change(f);
        const before = structuredClone(f.state.profitTakingControl);
        assert.equal(externalActivityCandidate(f.config, f.state), false);
        assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.calls.length, 0);
        assert.deepEqual(f.state.profitTakingControl, before);
        assert.deepEqual(f.writes, []);
    });
});

test('uncertain, unbooked, corrupt or mismatched withdrawal sources cannot be excluded as manual activity', async t => {
    const changes = {
        'uncertain source': f => { f.state.profitTakingControl.operation.stage = 'source_uncertain'; },
        'unbooked source': f => { f.state.profitTaking.pending.stage = 'reserved'; },
        'missing pending': f => { f.state.profitTaking.pending = null; },
        'missing source receipt': f => { delete f.state.profitTaking.pending.sourceReceipt; },
        'source receipt changed': f => { f.state.profitTaking.pending.sourceReceipt.hash = hash('7'); },
        'operation hash changed': f => { f.state.profitTakingControl.operation.transfer.hash = hash('7'); },
        'operation id changed': f => { f.state.profitTakingControl.operation.id = 'withdrawal:other'; },
        'missing transfer': f => { delete f.state.profitTakingControl.operation.transfer; },
        'source debit corrupt': f => { f.state.profitTaking.totalTokenDebited = 0; },
        'source not confirmed': f => { f.state.profitTaking.pending.sourceReceipt.status = 'failed'; },
        'source quantity changed': f => { f.state.profitTaking.pending.sourceReceipt.tokenDebitUsd = 4; },
        'pre-source with pending': f => { f.state.profitTakingControl.operation.stage = 'address_ready'; },
    };
    for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
        const f = fixture(); change(f); const before = structuredClone(f.state);
        assert.equal(externalActivityCandidate(f.config, f.state), false);
        assert.equal(await f.reconciler.preview(), null); assert.equal(await f.reconciler.reconcile(), false);
        assert.equal(f.calls.length, 0); assert.deepEqual(f.state.profitTaking, before.profitTaking);
        assert.deepEqual(f.state.profitTakingControl, before.profitTakingControl);
        assert.equal(f.state.externalWalletActivity, undefined); assert.equal(f.state.stopped, null);
        assert.deepEqual(f.writes, []);
    });
    for (const stage of ['address_requested', 'address_ready']) {
        const f = fixture({ stage }); f.state.profitTakingControl.operation.transfer = { hash: sourceHash };
        assert.equal(externalActivityCandidate(f.config, f.state), false);
    }
    const f = fixture({ stage: 'source_uncertain' });
    assert.equal(externalActivityCandidate(f.config, f.state), false);
});
