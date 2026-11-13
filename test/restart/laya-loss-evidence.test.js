import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BASELINE } from '../../src/restart/config.js';
import { newPosition } from '../../src/restart/strategy.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { MaintenanceEngine } from '../../src/laya-live/maintenance.js';
import { applyConfirmedCapitalDeposits } from '../../src/laya-live/capital-funding.js';
import { reserveProfitWithdrawal, applyProfitWithdrawal } from '../../src/laya-live/profit-accounting.js';
import { expectedWalletBalance } from '../../src/laya-live/recovery.js';
import { lossProtectionActivationId, captureLossWalletEvidence, lossWalletProofMatches }
    from '../../src/laya-live/loss-evidence.js';

const hash = digit => `0x${digit.repeat(64)}`;
const address = digit => `0x${digit.repeat(40)}`;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policy = { recipient: address('a'), asset: 'USDC', trigger: 'wallet_balance', thresholdUsd: 15,
    chunkUsd: 5, retainUsd: 10, lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } };
const witness = (balance = 14.1, overrides = {}) => ({ balance, blockNumber: 110,
    blockHash: hash('a'), checkedAt: 1000000, ...overrides });

function stateFixture() {
    return { baseline: 'aabbccddeeff0011', startedAt: 900000, mode: 'pilot', strategy: 'late-entry',
        decisionProvider: 'eligible', cash: 14.1, peakEquity: 14.1, maxDrawdown: 0,
        walletStart: 14.1, walletCashDelta: 0, completed: [], seen: {}, failures: 0,
        position: null, stopped: null, liveFunding: { initialCapital: 14.1 } };
}

function closingFixture(t) {
    t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
    const state = stateFixture(), at = Date.now(), events = [], persisted = [];
    const marker = { schema: 1, activatedAt: at - 3000, completedCount: 0,
        completedSha256: digest([]), consumed: [] };
    state.profitTakingControl = { schema: 1, policy, lossProtection: marker };
    const before = captureLossWalletEvidence(state, witness(state.cash, { checkedAt: at - 2000, blockNumber: 100 }));
    const market = { slug: 'btc-reviewed-loss', conditionId: hash('1'), tokens: ['1', '2'], outcomes: ['Up', 'Down'],
        open: at - 300000, end: at - 500, fee: { rate: .07, exponent: 1 } };
    const position = state.position = newPosition(market, { cost: 3 }, state, at - 1000);
    Object.assign(position, { bought: [5, 0], holdings: [0, 0], entryCost: 3, payout: [0, 1],
        orders: [{ orderId: hash('2'), tokenId: '1', index: 0, side: 'BUY', kind: 'taker', price: .6,
            shares: 5, filled: 5, settled: 5, status: 'complete', receiptProvenComplete: true }],
        fills: [{ hash: hash('3'), orderId: hash('2'), shares: 5, source: 'receipt' }],
        entrySignal: { lossProtection: { schema: 1, activationId: lossProtectionActivationId(marker), before } } });
    state.cash = 11.1; state.walletCashDelta = -3;
    const after = captureLossWalletEvidence(state, witness(state.cash));
    const store = { state, save() { persisted.push(structuredClone(state)); },
        event(type, detail) { events.push({ type, detail: structuredClone(detail) }); this.save(); },
        stop(reason) { state.stopped ||= { reason, at: Date.now() }; } };
    let closed = 0;
    const broker = { lastWalletProof: { position, evidence: after, holdings: [0, 0] } };
    const settings = { ...BASELINE, drawdownStop: 10, continuousTrading: true, pilotHours: Infinity, pilotMarkets: Infinity };
    const engine = Object.assign(Object.create(MaintenanceEngine.prototype), { settings, store, broker,
        config: { profitTaking: { enabled: true, ...policy } }, feed: { close() { closed++; } } });
    return { state, position, before, after, marker, store, broker, engine, settings, events, persisted,
        at, closed: () => closed };
}

test('loss activation identity is stable across consumption and changes with activation history', () => {
    const marker = { schema: 1, activatedAt: 1000, completedCount: 0, completedSha256: digest([]), consumed: [] };
    const id = lossProtectionActivationId(marker);
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.equal(lossProtectionActivationId({ ...marker, consumed: [{ lossId: 'already-used' }] }), id);
    for (const change of [{ activatedAt: 1001 }, { completedCount: 1 }, { completedSha256: digest([{}]) }])
        assert.notEqual(lossProtectionActivationId({ ...marker, ...change }), id);
    for (const value of [null, {}, { ...marker, schema: 2 }, { ...marker, activatedAt: -1 },
        { ...marker, completedCount: 1.5 }, { ...marker, completedSha256: 'not-a-digest' }, { ...marker, consumed: null }])
        assert.equal(lossProtectionActivationId(value), null);
});

test('wallet evidence preserves exact trading, external, deposit, and withdrawal components without mutation', () => {
    let state = { ...stateFixture(), walletStart: 20, walletCashDelta: -1.25, cash: 18.75,
        peakEquity: 20, liveFunding: { initialCapital: 20 },
        completed: [{ traded: true, pnl: -1.25, fees: 0, gas: 0, uncertain: false }],
        externalWalletActivity: { cashDelta: 2.123456, receipts: [{ hash: hash('8'), cash: 2.123456 }] } };
    applyConfirmedCapitalDeposits({ state, save() {} }, { chainId: 137, walletAddress: address('1'),
        tokenAddress: address('2'), entries: [{ txHash: hash('4'), logIndex: 0, from: address('3'), amount: 3.000001,
            blockNumber: 100, blockHash: hash('5') }], expectedBalanceBefore: 20.873456, actualBalanceAfter: 23.873457 });
    const { lossProtection, ...ordinaryPolicy } = policy;
    state = reserveProfitWithdrawal(state, ordinaryPolicy, { id: 'withdrawal:1', hash: hash('6'), createdAt: 999000,
        openOrders: [], walletBalance: 23.873457, gasReserveUsd: 0, feeReserveUsd: 0 });
    state = applyProfitWithdrawal(state, { id: 'withdrawal:1', hash: hash('6'), recipient: policy.recipient,
        asset: 'USDC', amountUsd: 5, status: 'confirmed', tokenDebitUsd: 5, gasUsd: 0, feeUsd: 0,
        blockNumber: 105, blockHash: hash('7') });
    assert.equal(expectedWalletBalance(state), 18.873457);
    const before = structuredClone(state), input = witness(18.873457);
    assert.deepEqual(captureLossWalletEvidence(state, input), { ...input, walletCashDelta: -1.25,
        externalCashDelta: 2.123456, totalDeposited: 3.000001, totalTokenDebited: 5 });
    assert.deepEqual(state, before);
    assert.equal(captureLossWalletEvidence(state, witness(18.873456)), null);
    assert.equal(captureLossWalletEvidence(state, witness(18.873458)), null);
});

test('wallet evidence refuses missing block identity and imprecise or inconsistent amounts', async t => {
    const mutations = {
        missingHash: (_s, w) => { delete w.blockHash; }, zeroHash: (_s, w) => { w.blockHash = hash('0'); },
        malformedHash: (_s, w) => { w.blockHash = 'latest'; }, missingBlock: (_s, w) => { delete w.blockNumber; },
        fractionalBlock: (_s, w) => { w.blockNumber = 1.5; }, negativeTime: (_s, w) => { w.checkedAt = -1; },
        fractionalTime: (_s, w) => { w.checkedAt = 1.5; }, unavailableBalance: (_s, w) => { w.balance = NaN; },
        fractionalMicroBalance: (_s, w) => { w.balance += .0000001; }, stringBalance: (_s, w) => { w.balance = '14.1'; },
        negativeBalance: (_s, w) => { w.balance = -1; }, overflowBalance: (_s, w) => { w.balance = Number.MAX_SAFE_INTEGER; },
        missingStart: s => { delete s.walletStart; }, missingDelta: s => { delete s.walletCashDelta; },
        impreciseDelta: s => { s.walletCashDelta = .0000001; }, externalMismatch: s => { s.externalWalletActivity = { cashDelta: .000001 }; },
        invalidExternal: s => { s.externalWalletActivity = { cashDelta: Infinity }; },
        negativeDeposit: s => { s.capitalFunding = { totalDeposited: -1 }; },
        negativeDebit: s => { s.profitTaking = { totalTokenDebited: -1 }; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
        const state = stateFixture(), input = witness(); mutate(state, input);
        const before = structuredClone(state);
        assert.equal(captureLossWalletEvidence(state, input), null);
        assert.deepEqual(state, before);
    });
    assert.equal(captureLossWalletEvidence(stateFixture(), null), null);
});

test('a closing proof belongs to this position, fresh flat holdings, and unchanged accounting components', async t => {
    const f = closingFixture(t);
    assert.equal(lossWalletProofMatches(f.state, f.broker.lastWalletProof, f.position, f.at, 5000), true);
    assert.equal(lossWalletProofMatches(f.state, f.broker.lastWalletProof, f.position, f.at + 5000, 5000), true);
    assert.equal(lossWalletProofMatches(f.state, f.broker.lastWalletProof, f.position, f.at + 5001, 5000), false);
    const mutations = {
        otherPosition: (s, p, proof) => { proof.position = structuredClone(p); },
        changedStatePosition: (s, p) => { s.position = structuredClone(p); },
        beforeEntry: (_s, p, proof) => { proof.evidence.checkedAt = p.openedAt - 1; },
        futureProof: (_s, _p, proof) => { proof.evidence.checkedAt++; },
        preRedeemHoldings: (_s, _p, proof) => { proof.holdings = [5, 0]; },
        fractionalHolding: (_s, _p, proof) => { proof.holdings = [.0000001, 0]; },
        liveHoldings: (_s, p) => { p.holdings = [0, 1]; },
        missingHoldings: (_s, _p, proof) => { delete proof.holdings; },
        newDeposit: s => { s.capitalFunding = { totalDeposited: .000001 }; },
        newWithdrawal: s => { s.profitTaking = { totalTokenDebited: .000001 }; },
        offsettingExternalAndTrade: s => { s.walletCashDelta--; s.externalWalletActivity = { cashDelta: 1 }; },
        offsettingDepositAndWithdrawal: s => { s.capitalFunding = { totalDeposited: 5 }; s.profitTaking = { totalTokenDebited: 5 }; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
        const state = structuredClone(f.state), position = state.position;
        const proof = { position, evidence: { ...f.after }, holdings: [0, 0] };
        mutate(state, position, proof);
        assert.equal(lossWalletProofMatches(state, proof, position, f.at, 5000), false);
    });
});

test('protected completion waits for a fresh post-redeem proof and saves it before the completion event', async t => {
    const mutations = {
        missing: f => { f.broker.lastWalletProof = null; },
        stale: f => { f.broker.lastWalletProof.evidence.checkedAt = f.at - 5001; },
        wrongPosition: f => { f.broker.lastWalletProof.position = structuredClone(f.position); },
        beforeRedeem: f => { f.broker.lastWalletProof.holdings = [5, 0]; },
        priorBlock: f => { f.broker.lastWalletProof.evidence.blockNumber = f.before.blockNumber - 1; },
        wrongActivation: f => { f.position.entrySignal.lossProtection.activationId = 'f'.repeat(64); },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, t => {
        const f = closingFixture(t); mutate(f);
        const before = structuredClone(f.state);
        f.engine.finish(f.at);
        assert.equal(f.state.position, f.position);
        assert.deepEqual(f.state, before);
        assert.equal(f.events.length, 0); assert.equal(f.closed(), 0);
    });
    await t.test('fresh proof', t => {
        const f = closingFixture(t), beforeCash = f.state.cash;
        f.engine.finish(f.at - 500);
        assert.equal(f.state.position, null); assert.equal(f.closed(), 1);
        const row = f.state.completed[0];
        assert.equal(row.pnl, -3); assert.equal(row.closedAt, f.at);
        assert.deepEqual(row.entrySignal.lossProtection.before, f.before);
        assert.deepEqual(row.entrySignal.lossProtection.after, f.after);
        const event = f.events.find(row => row.type === 'market_complete');
        assert.deepEqual(event.detail.entrySignal.lossProtection.after, f.after);
        assert.deepEqual(f.persisted.find(row => row.completed.length).completed[0].entrySignal.lossProtection.after, f.after);
        assert.equal(f.state.cash, beforeCash); assert.equal(f.state.stopped, null);
        f.broker.lastWalletProof.evidence.balance = 0;
        assert.equal(row.entrySignal.lossProtection.after.balance, 11.1);
    });
});

test('legacy positions finish without adding retrospective loss protection evidence', t => {
    const f = closingFixture(t);
    delete f.position.entrySignal.lossProtection; f.broker.lastWalletProof = null;
    f.engine.finish(f.at);
    assert.equal(f.state.position, null);
    assert.equal(f.state.completed[0].entrySignal.lossProtection, undefined);
    assert.equal(f.state.completed[0].pnl, -3);
});

test('broker publishes evidence only for canonical, exact matched reads and invalidates prior proof on failure', async t => {
    const f = closingFixture(t), data = { balance: 11.1, holdings: [0, 0], fail: false };
    const client = { rpc: { anchor: { number: 110, hash: hash('a') } },
        balance: async () => { if (data.fail) throw new Error('read_unavailable'); return data.balance; },
        holdings: async () => data.holdings };
    const broker = new LayaLiveBroker(f.settings, f.store, client); broker.reconcileBlock = 110;
    assert.equal(await broker.checkWallet(f.at), true);
    assert.equal(broker.lastWalletProof.position, f.position);
    assert.deepEqual(broker.lastWalletProof.evidence, f.after);
    assert.deepEqual(broker.lastWalletProof.holdings, [0, 0]);
    data.holdings[0] = 5;
    assert.deepEqual(broker.lastWalletProof.holdings, [0, 0], 'saved holdings do not alias mutable client responses');
    data.holdings = [0, 0]; data.fail = true;
    await assert.rejects(broker.checkWallet(f.at), /read_unavailable/);
    assert.equal(broker.lastWalletProof, null);
    data.fail = false; client.rpc.anchor.hash = hash('0');
    assert.equal(await broker.checkWallet(f.at), true);
    assert.equal(broker.lastWalletProof, null);
    client.rpc.anchor = { number: 109, hash: hash('a') };
    assert.equal(await broker.checkWallet(f.at), true);
    assert.equal(broker.lastWalletProof, null);
    client.rpc.anchor = { number: 110, hash: hash('a') };
    data.balance = 11.1000001;
    assert.equal(await broker.checkWallet(f.at), true, 'legacy EPS reconciliation is insufficient for loss protection');
    assert.equal(broker.lastWalletProof, null);
    data.balance = 11.1;
    client.balance = async () => { client.rpc.anchor.hash = hash('b'); return data.balance; };
    assert.equal(await broker.checkWallet(f.at), true);
    assert.equal(broker.lastWalletProof, null, 'changed canonical anchor cannot authorize a loss withdrawal');
});
