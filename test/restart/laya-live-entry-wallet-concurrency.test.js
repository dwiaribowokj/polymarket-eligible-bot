import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { LayaLiveBroker, WALLET_TRADE_OVERLAP_MS } from '../../src/laya-live/broker.js';
import { OperationalError } from '../../src/restart/network.js';

const hash = byte => `0x${byte.repeat(64)}`;
const market = { conditionId: hash('1'), tokens: ['1', '2'] };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function fixture(t, { manual = true } = {}) {
    let now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => assert.fail('Entry wallet tests must remain offline'));
    const state = { position: null, walletStart: 20, walletCashDelta: 0, cash: 20, stopped: null };
    const store = { state, save() { assert.fail('No admission persistence'); },
        stop() { assert.fail('Unexpected admission stop'); }, event() {} };
    const gates = { snapshot: deferred(), balance: deferred(), holdings: deferred(), account: deferred() };
    const calls = [], writes = [], settings = { maxDataAgeMs: 5000 };
    const write = name => () => { writes.push(name); assert.fail(`Unexpected financial operation: ${name}`); };
    const client = {
        rpc: { anchor: null },
        async confirmedBlock() {
            calls.push({ name: 'snapshot', at: now });
            const block = await gates.snapshot.promise;
            client.rpc.anchor = { number: block, hash: hash('a') };
            return block;
        },
        async balance(block) { calls.push({ name: 'balance', at: now, block }); return gates.balance.promise; },
        async holdings(tokens, block) {
            calls.push({ name: 'holdings', at: now, block });
            assert.deepEqual(tokens, market.tokens);
            return gates.holdings.promise;
        },
        async ordersAndTrades(...args) {
            calls.push({ name: 'account', at: now });
            assert.deepEqual(args, [], 'All account orders and trades remain required');
            return gates.account.promise;
        },
        async verifiedReceipt(transactionHash, block) {
            calls.push({ name: 'receipt', at: now, block });
            assert.equal(client.rpc.anchor.number, block);
            return { transactionHash, status: 1, blockNumber: block - 1, blockHash: hash('b'), confirmations: 2 };
        },
        prepare: write('prepare'), post: write('post'), cancel: write('cancel'),
        prepareAction: write('prepareAction'), broadcastAction: write('broadcastAction'),
    };
    const broker = new LayaLiveBroker(settings, store, client);
    let defers = 0;
    broker.externalActivity = { enabled: () => manual, defer() { defers++; } };
    return { broker, client, state, calls, writes, gates, settings, get defers() { return defers; },
        advance(ms) { now += ms; },
        resolveWallet() { gates.snapshot.resolve(100); gates.balance.resolve(20); gates.holdings.resolve([0, 0]); } };
}

test('fresh all-account query overlaps the snapshot chain and final manual proof waits for both', async t => {
    const f = fixture(t), before = structuredClone(f.state), startedAt = Date.now();
    const pending = f.broker.entryWallet(market);
    await nextTurn();
    assert.deepEqual(f.calls.map(call => [call.name, call.at]), [['snapshot', startedAt], ['account', startedAt]]);
    f.advance(842); f.gates.snapshot.resolve(100);
    await nextTurn();
    assert.deepEqual(f.calls.slice(2).map(call => [call.name, call.block, call.at]), [
        ['balance', 100, startedAt + 842], ['holdings', 100, startedAt + 842],
    ]);
    f.advance(258); f.gates.balance.resolve(20); f.gates.holdings.resolve([0, 0]);
    await nextTurn();
    assert.equal(f.calls.some(call => call.name === 'receipt'), false);
    f.advance(1070);
    f.gates.account.resolve({ orders: [{ id: hash('2'), conditionId: hash('3'), tokenId: '5',
        side: 'BUY', originalSize: 5, sizeMatched: 1, price: .6 }],
    trades: [{ status: 'MATCHED', transactionHash: hash('4') }] });
    const witness = await pending;
    assert.equal(witness.checkedAt - witness.startedAt, 2170, 'Account and RPC latency overlap rather than add');
    assert.equal(witness.block, 100); assert.equal(witness.balance, 20); assert.equal(witness.spendable, 16);
    assert.deepEqual(witness.holdings, [0, 0]);
    assert.deepEqual(f.calls.at(-1), { name: 'receipt', at: startedAt + 2170, block: 100 });
    assert.deepEqual(f.state, before); assert.deepEqual(f.writes, []);
});

function auditedEpoch(state) {
    state.startedAt = Date.now() - 86400000;
    state.currentStrategyEpochId = 'audited-epoch';
    state.strategyEpochs = [{ id: state.currentStrategyEpochId, startedAt: Date.now() - 3600000,
        walletProof: { verificationStartedAt: Date.now() - 3620000, verifiedAt: Date.now() - 3600500,
            blockNumber: 90, blockHash: hash('b'), balance: 20, expectedBalance: 20,
            confirmedNonce: '2', pendingNonce: '2', safeNonce: '3', pendingSafeNonce: '3',
            trades: { apiTerminal: 1310, receiptConfirmed: [] } } }];
    return state.strategyEpochs[0].walletProof;
}

test('audited epochs bound only historical trades from audit-start with overlap, never from now', async t => {
    const f = fixture(t), proof = auditedEpoch(f.state);
    const expected = { after: String(Math.floor((proof.verificationStartedAt - WALLET_TRADE_OVERLAP_MS) / 1000)) };
    assert.deepEqual(f.broker.walletTradeQuery(), expected);
    const before = structuredClone(f.state);
    f.client.ordersAndTrades = async (...args) => {
        assert.deepEqual(args, [null, expected], 'All-market open orders remain required');
        return { orders: [], trades: [{ status: 'MATCHED', transactionHash: hash('4') }] };
    };
    const pending = f.broker.entryWallet(market);
    f.resolveWallet();
    const witness = await pending;
    assert.equal(witness.spendable, 20);
    assert.equal(f.calls.filter(call => call.name === 'receipt').length, 1);
    f.advance(86400000);
    assert.deepEqual(f.broker.walletTradeQuery(), expected, 'The boundary must not discard pending trades as time advances');
    assert.deepEqual(f.state, before); assert.deepEqual(f.writes, []);
});

test('older proof versions keep the whole period and exposed positions widen the window', async t => {
    const f = fixture(t), proof = auditedEpoch(f.state);
    delete proof.verificationStartedAt;
    assert.deepEqual(f.broker.walletTradeQuery(), {
        after: String(Math.floor((f.state.startedAt - WALLET_TRADE_OVERLAP_MS) / 1000)),
    });
    proof.verificationStartedAt = Date.now() - 3620000;
    f.state.position = { openedAt: f.state.startedAt - 1000 };
    assert.deepEqual(f.broker.walletTradeQuery(), {
        after: String(Math.floor((f.state.position.openedAt - WALLET_TRADE_OVERLAP_MS) / 1000)),
    });
});

test('missing or invalid exhaustive audit proof never opts in to truncated history', async t => {
    const mutations = [
        state => { delete state.strategyEpochs; },
        state => { state.strategyEpochs = {}; },
        state => { state.currentStrategyEpochId = 'other'; },
        state => { delete state.strategyEpochs[0].walletProof; },
        state => { state.strategyEpochs[0].startedAt = Date.now() + 1; },
        state => { state.strategyEpochs[0].walletProof.pendingSafeNonce = '4'; },
        state => { state.strategyEpochs[0].walletProof.expectedBalance = 19; },
        state => { state.strategyEpochs[0].walletProof.blockHash = hash('0'); },
        state => { delete state.strategyEpochs[0].walletProof.trades.receiptConfirmed; },
        state => { state.strategyEpochs[0].walletProof.trades.receiptConfirmed = [{}]; },
        state => { state.strategyEpochs[0].walletProof.verificationStartedAt = Date.now(); },
        state => { state.position = {}; },
    ];
    const f = fixture(t);
    for (const mutate of mutations) {
        f.state.position = null; auditedEpoch(f.state); mutate(f.state);
        assert.equal(f.broker.walletTradeQuery(), null);
    }
});

test('bounded wallet history does not bypass an unconfirmed trade, manual reservations, or read expiry', async t => {
    for (const fault of ['unconfirmed', 'overlap', 'slow']) await t.test(fault, async t => {
        const f = fixture(t); auditedEpoch(f.state);
        f.client.ordersAndTrades = async () => {
            if (fault === 'slow') f.advance(5001);
            return { orders: fault === 'overlap' ? [{ id: hash('2'), conditionId: market.conditionId,
                tokenId: '1', side: 'BUY', originalSize: 5, sizeMatched: 1, price: .6 }] : [],
            trades: fault === 'unconfirmed' ? [{ status: 'MATCHED', transactionHash: hash('4') }] : [] };
        };
        f.client.verifiedReceipt = async () => null;
        const pending = f.broker.entryWallet(market); f.resolveWallet();
        await assert.rejects(pending, { code: fault === 'unconfirmed' ? 'external_trades_pending'
            : fault === 'overlap' ? 'external_market_overlap' : 'entry_wallet_expired' });
        assert.deepEqual(f.writes, []);
    });
});

test('receipt-confirmed legacy MATCHED trades remain audited evidence rather than being reset or credited', async t => {
    const f = fixture(t), proof = auditedEpoch(f.state);
    proof.trades.receiptConfirmed = [{ transactionHash: hash('4'), source: 'known_receipt' }];
    f.state.externalWalletActivity = { cashDelta: 0, receipts: [], walletProof: { trades: { receiptConfirmed: [
        { transactionHash: hash('4'), blockNumber: 80, blockHash: hash('c') },
    ] } } };
    const before = structuredClone(f.state), query = f.broker.walletTradeQuery();
    assert.ok(query);
    f.client.ordersAndTrades = async (...args) => {
        assert.deepEqual(args, [null, query]);
        return { orders: [], trades: [{ status: 'MATCHED', transactionHash: hash('4') }] };
    };
    f.client.verifiedReceipt = () => assert.fail('Already proven historical receipts must not add wallet latency');
    const pending = f.broker.entryWallet(market); f.resolveWallet();
    assert.equal((await pending).balance, 20);
    assert.deepEqual(f.state, before); assert.deepEqual(f.writes, []);
});

test('fast account rejection drains the pending snapshot and both pinned reads before returning', async t => {
    const f = fixture(t), error = new OperationalError('invalid_api_data', 'validation');
    f.client.ordersAndTrades = () => { throw error; };
    let finished = false;
    const pending = f.broker.entryWallet(market).finally(() => { finished = true; });
    const rejected = assert.rejects(pending, e => e === error);
    await nextTurn();
    assert.equal(finished, false); assert.equal(f.client.rpc.anchor, null);
    f.gates.snapshot.resolve(100); await nextTurn();
    assert.equal(finished, false);
    f.gates.balance.resolve(20); await nextTurn();
    assert.equal(finished, false);
    f.gates.holdings.resolve([0, 0]); await rejected;
    assert.equal(finished, true); assert.equal(f.client.rpc.anchor.number, 100);
    assert.equal(f.calls.some(call => call.name === 'receipt'), false);
});

test('snapshot rejection drains account rejection and preserves deterministic RPC error precedence', async t => {
    const f = fixture(t);
    f.client.confirmedBlock = () => { throw new OperationalError('rpc_block_mismatch', 'validation'); };
    let finished = false;
    const pending = f.broker.entryWallet(market).finally(() => { finished = true; });
    const rejected = assert.rejects(pending, { code: 'rpc_block_mismatch' });
    await nextTurn(); assert.equal(finished, false);
    f.gates.account.reject(new OperationalError('read_timeout', 'timeout'));
    await rejected; await nextTurn();
    assert.equal(f.calls.some(call => ['balance', 'holdings', 'receipt'].includes(call.name)), false);
});

test('a failed pinned read drains its siblings and preserves a later identity failure', async t => {
    const f = fixture(t);
    let finished = false;
    const pending = f.broker.entryWallet(market).finally(() => { finished = true; });
    const rejected = assert.rejects(pending, { code: 'rpc_block_mismatch' });
    f.gates.snapshot.resolve(100); await nextTurn();
    f.gates.balance.reject(new OperationalError('read_timeout', 'timeout'));
    await nextTurn(); assert.equal(finished, false);
    f.gates.account.resolve({ orders: [], trades: [] });
    await nextTurn(); assert.equal(finished, false);
    f.gates.holdings.reject(new OperationalError('rpc_block_mismatch', 'validation'));
    await rejected; await nextTurn();
    assert.equal(f.calls.some(call => call.name === 'receipt'), false);
});

test('an early holdings identity failure is not masked by a later balance timeout', async t => {
    const f = fixture(t), pending = f.broker.entryWallet(market);
    const rejected = assert.rejects(pending, { code: 'rpc_block_mismatch' });
    f.gates.snapshot.resolve(100); f.gates.account.resolve({ orders: [], trades: [] });
    await nextTurn();
    f.gates.holdings.reject(new OperationalError('rpc_block_mismatch', 'validation'));
    await nextTurn();
    f.gates.balance.reject(new OperationalError('read_timeout', 'timeout'));
    await rejected;
});

test('an account validation failure is not masked by a simultaneous snapshot timeout', async t => {
    const f = fixture(t), pending = f.broker.entryWallet(market);
    const rejected = assert.rejects(pending, { code: 'invalid_api_data' });
    await nextTurn();
    f.gates.snapshot.reject(new OperationalError('read_timeout', 'timeout'));
    f.gates.account.reject(new OperationalError('invalid_api_data', 'validation'));
    await rejected;
});

test('a temporary read failure still becomes an unavailable-wallet opportunity after draining', async t => {
    const f = fixture(t), pending = f.broker.entryWallet(market);
    const rejected = assert.rejects(pending, { code: 'entry_wallet_unavailable', category: 'opportunity' });
    f.gates.snapshot.resolve(100); f.gates.account.resolve({ orders: [], trades: [] });
    await nextTurn();
    f.gates.balance.reject(new OperationalError('read_timeout', 'timeout'));
    f.gates.holdings.resolve([0, 0]);
    await rejected;
});

for (const slow of ['account', 'snapshot']) {
    test(`slow ${slow} still expires the original entry-wallet freshness window`, async t => {
        const f = fixture(t), pending = f.broker.entryWallet(market);
        const rejected = assert.rejects(pending, { code: 'entry_wallet_expired' });
        if (slow === 'account') f.resolveWallet();
        else f.gates.account.resolve({ orders: [], trades: [] });
        await nextTurn(); f.advance(5001);
        if (slow === 'account') f.gates.account.resolve({ orders: [], trades: [] });
        else f.resolveWallet();
        await rejected; assert.deepEqual(f.writes, []);
    });
}

test('a nonterminal manual trade still requires a canonical receipt after both reads', async t => {
    const f = fixture(t);
    f.client.verifiedReceipt = async () => null;
    const pending = f.broker.entryWallet(market);
    f.resolveWallet();
    f.gates.account.resolve({ orders: [], trades: [{ status: 'MATCHED', transactionHash: hash('4') }] });
    await assert.rejects(pending, { code: 'external_trades_pending' });
    assert.deepEqual(f.writes, []);
});

test('manual market overlap still rejects the witness', async t => {
    const f = fixture(t), pending = f.broker.entryWallet(market);
    f.resolveWallet();
    f.gates.account.resolve({ orders: [{ id: hash('2'), conditionId: market.conditionId, tokenId: market.tokens[0],
        side: 'BUY', originalSize: 5, sizeMatched: 0, price: .6 }], trades: [] });
    await assert.rejects(pending, { code: 'external_market_overlap' });
    assert.deepEqual(f.writes, []);
});

test('disabled manual activity does not query account and still checks pinned balances', async t => {
    const f = fixture(t, { manual: false }), pending = f.broker.entryWallet(market);
    f.resolveWallet();
    const witness = await pending;
    assert.equal(witness.block, 100); assert.equal(witness.externalOrders, undefined);
    assert.equal(f.calls.some(call => call.name === 'account'), false);
    assert.deepEqual(f.calls.filter(call => call.block !== undefined).map(call => call.block), [100, 100]);
});
