import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { BASELINE } from '../../src/restart/config.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { marketSlug, newPosition } from '../../src/restart/strategy.js';
import { OperationalError } from '../../src/restart/network.js';

const open = 1792367400000, wallet = `0x${'1'.repeat(40)}`, other = `0x${'2'.repeat(40)}`;
const fillHash = `0x${'a'.repeat(64)}`, redeemHash = `0x${'b'.repeat(64)}`, blockHash = `0x${'c'.repeat(64)}`;
const conditionId = `0x${'e'.repeat(64)}`, zero = ethers.constants.AddressZero, zeroHash = ethers.constants.HashZero;
const operator = CONTRACTS.autoRedeemOperator, collateral = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)',
]);
const exchange = new ethers.utils.Interface([
    'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)',
]);
const log = (iface, event, address, args, logIndex) => ({ address, logIndex, ...iface.encodeEventLog(iface.getEvent(event), args) });
const cash = (from, to, amount, index) => log(erc20, 'Transfer', CONTRACTS.collateralToken, [from, to, amount], index);
const token = (from, to, amount, index, by = other) => log(ctf, 'TransferSingle', CONTRACTS.conditionalTokens,
    [by, from, to, '2', amount], index);
class OfflineSocket extends EventEmitter {
    constructor() { super(); this.readyState = 0; }
    open() { this.readyState = 1; this.emit('open'); }
    send() {}
    frame(row) { this.emit('message', JSON.stringify(row)); }
    terminate() { this.readyState = 3; this.emit('close'); }
}

async function fixture(t) {
    let now = open + 43098, redeemed = false, engine;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_settled_feed_test'); });
    const settings = { ...BASELINE, wallet, drawdownStop: 10, pilotHours: Infinity, pilotMarkets: Infinity };
    const config = { settings, policy: { aiSource: 'offline-settled-feed' }, ai: { slots: [60], slotToleranceMs: 2000,
        decisionMs: 3000, dataAgeMs: 5000, shares: 5, entryCap: 5, gasUsd: .05, control: settings } };
    const market = { slug: marketSlug('late-entry', settings, open), conditionId, open, end: open + 300000,
        tokens: ['1', '2'], negRisk: false, minimum: 5, accepting: true, ticks: [.01, .01], tick: .01,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const state = { mode: 'pilot', strategy: 'late-entry', startedAt: open, cash: 30, peakEquity: 30, maxDrawdown: 0,
        stopped: null, failures: 0, dataGaps: 0, completed: [], seen: {}, walletStart: 30, walletCashDelta: 0,
        liveFunding: { initialCapital: 30 } };
    const events = [], sockets = [], timers = new Set();
    const store = { state, save() {}, event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { state.stopped ||= { reason, at: now }; } };
    const stream = new LiveBookHistory({ clock: () => now, onEvent: (type, detail) => engine.bookEvent(type, detail),
        socketFactory: () => { const socket = new OfflineSocket(); sockets.push(socket); return socket; },
        scheduleInterval: fn => { timers.add(fn); return fn; }, cancelInterval: fn => timers.delete(fn) });
    const signed = { salt: '1', maker: wallet, signer: wallet, tokenId: '2', makerAmount: '3950000',
        takerAmount: '5000000', side: 'BUY', signatureType: 2, timestamp: String(open + 215000),
        metadata: zeroHash, builder: zeroHash, orderType: 'FAK' };
    const types = { Order: [['salt', 'uint256'], ['maker', 'address'], ['signer', 'address'], ['tokenId', 'uint256'],
        ['makerAmount', 'uint256'], ['takerAmount', 'uint256'], ['side', 'uint8'], ['signatureType', 'uint8'],
        ['timestamp', 'uint256'], ['metadata', 'bytes32'], ['builder', 'bytes32']].map(([name, type]) => ({ name, type })) };
    const orderId = ethers.utils._TypedDataEncoder.hash({ name: 'Polymarket CTF Exchange', version: '2', chainId: 137,
        verifyingContract: CONTRACTS.standardExchange }, types, { ...signed, side: 0 });
    const fill = { transactionHash: fillHash, blockHash, status: 1, confirmations: 3, blockNumber: 99,
        logs: [cash(wallet, other, 4016348, 10), token(other, wallet, 5197366, 11),
            log(exchange, 'OrderFilled', CONTRACTS.standardExchange,
                [orderId, wallet, other, 0, '2', 3949998, 5197366, 66350, zeroHash, zeroHash], 12)] };
    const redemption = { transactionHash: redeemHash, blockHash, status: 1, confirmations: 3, blockNumber: 199,
        logs: [log(ctf, 'TransferBatch', CONTRACTS.conditionalTokens, [operator, wallet, operator, ['1', '2'], [0, 5197366]], 10),
            token(operator, zero, 5197366, 11, operator),
            log(ctf, 'PayoutRedemption', CONTRACTS.conditionalTokens,
                [operator, collateral, zeroHash, conditionId, [1, 2], 5197366], 13), cash(zero, wallet, 5197366, 16)] };
    const quotes = watched => watched.tokens.map((tokenId, index) => ({ tokenId, conditionId: watched.conditionId,
        timestamp: now, fetchedAt: now, tick: .01,
        bids: [{ price: index === 1 ? .76 : .21, size: 20 }], asks: [{ price: index === 1 ? .77 : .22, size: 20 }] }));
    const client = { btc: { openings: new Map() }, startBtcFeed() {}, books: t.mock.fn(async watched => quotes(watched)),
        market: async slug => ({ ...market, slug, open: market.end, end: market.end + 300000,
            conditionId: `0x${'f'.repeat(64)}`, tokens: ['3', '4'] }),
        confirmedBlock: async () => redeemed ? 200 : 100,
        ordersAndTrades: async () => ({ orders: [], trades: [{ id: 'confirmed-fill', conditionId, assetId: '2', side: 'BUY',
            traderSide: 'TAKER', takerOrderId: orderId, size: '5.197366', price: '.76', status: 'CONFIRMED', transactionHash: fillHash }] }),
        verifiedReceipt: async hash => hash === fillHash ? fill : hash === redeemHash && redeemed ? redemption : null,
        order: async () => { throw new Error('terminal order must not be looked up'); },
        cancel: async () => { throw new Error('terminal order must not be cancelled'); },
        payoutAtBlock: async () => redeemed ? [0, 1] : null, payout: async () => redeemed ? [0, 1] : null,
        listAutoRedemptions: async () => redeemed ? [redeemHash] : [],
        balance: async () => redeemed ? 31.181018 : 25.983652, holdings: async () => redeemed ? [0, 0] : [0, 5.197366],
        marketInfo: async () => ({}), validateInfo() {}, tickSize: async () => .01,
        prepare: t.mock.fn(async () => { throw new Error('financial_write_forbidden'); }),
        post: t.mock.fn(async () => { throw new Error('financial_write_forbidden'); }),
        prepareAction: t.mock.fn(async () => { throw new Error('financial_write_forbidden'); }),
        broadcastAction: t.mock.fn(async () => { throw new Error('financial_write_forbidden'); }) };
    const providers = { predict: t.mock.fn(async () => { throw new Error('inference_forbidden'); }) };
    engine = new LayaLiveEngine(config, store, client, stream, providers); engine.current = market;
    t.mock.method(engine.clockGate, 'fresh', () => true); t.mock.method(engine, 'checkClock', async () => true);
    const spec = { tokenId: '2', index: 1, side: 'BUY', kind: 'taker', shares: 5, price: .79, cost: 4.058065 };
    const position = state.position = newPosition(market, { orders: [spec], cost: spec.cost }, state, open + 215000);
    position.orders.push({ ...spec, orderId, signed, status: 'accepted', apiSubmissionStatus: 'matched',
        transactions: [fillHash], tradeIds: ['confirmed-fill'], settled: 0, filled: 0 });
    position.entrySignal = { provider: 'laya' }; state.seen[market.slug] = { at: position.openedAt, cost: spec.cost };
    client.redemptionScan = { complete: true, key: JSON.stringify([wallet, conditionId, market.tokens, position.openedAt]) };
    const pair = (watched = engine.current) => quotes(watched).forEach(book => sockets.at(-1).frame({ event_type: 'book',
        asset_id: book.tokenId, market: book.conditionId, timestamp: now, tick_size: '.01', bids: book.bids, asks: book.asks }));
    stream.watch(market.tokens, market); sockets[0].open();
    for (let i = 0; i <= 180; i++) { pair(); if (i < 180) now += 1000; }
    assert.equal(now, open + 223098); assert.ok(stream.snapshot(now));
    await engine.broker.reconcile(null, now); assert.equal(await engine.broker.checkWallet(), true);
    assert.equal(position.orders[0].receiptProvenComplete, true); assert.equal(position.pendingTrades, false);
    assert.deepEqual(position.holdings, [0, 5.197366]); assert.equal(position.entryCost, 4.016348);
    t.after(() => stream.close());
    return { engine, stream, client, providers, state, position, market, events, sockets, pair,
        get now() { return now; }, advance(ms) { now += ms; }, redeem() { redeemed = true; },
        gap(code = 1013, reason = 'try again later') { sockets.at(-1).emit('close', code, Buffer.from(reason)); } };
}

test('receipt-proven improved FAK survives active-market 1013, reconciles once, and requires 180 seconds of fresh history', async t => {
    const f = await fixture(t), seen = structuredClone(f.state.seen), generation = f.stream.generation;
    assert.equal(f.engine.broker.settledBookHoldReady(), true);
    for (let i = 0; i < 17; i++) { f.advance(1000); f.pair(); }
    f.advance(512); assert.equal(f.now, open + 240610); f.gap();
    assert.equal(f.state.stopped, null); assert.equal(f.state.position, f.position); assert.deepEqual(f.state.seen, seen);
    assert.equal(f.stream.snapshot(f.now), null); assert.equal(f.stream.history.length, 0);
    assert.equal(f.stream.readyAt, null); assert.ok(f.stream.generation > generation);
    assert.ok(f.events.some(event => event.type === 'settled_hold_book_recovery_wait' && event.closeCode === 1013));
    f.advance(1000); await f.engine.tick(); assert.equal(f.sockets.length, 2);
    f.sockets.at(-1).open(); f.pair(); assert.equal(f.state.stopped, null);
    assert.ok(f.client.books.mock.callCount() > 0, 'REST risk marks continue independently of the socket');
    assert.equal(f.state.position.pendingTrades, false); assert.equal(f.state.dataGaps, 0); assert.equal(f.state.position.uncertain, false);
    f.advance(open + 416000 - f.now); f.redeem(); await f.engine.tick();
    assert.equal(f.state.position, null); assert.equal(f.state.stopped, null); assert.equal(f.state.cash, 31.181018);
    assert.equal(f.state.completed.length, 1); assert.equal(f.events.filter(event => event.type === 'protocol_auto_redeem_settled').length, 1);
    assert.deepEqual(f.state.seen, seen); f.sockets.at(-1).open(); f.pair();
    await assert.rejects(f.engine.observe(f.engine.current, 60, 'warming'), /live_entry_held/);
    for (let i = 0; i < 179; i++) { f.advance(1000); f.pair(); }
    f.advance(999); f.pair(); assert.equal(f.stream.snapshot(f.now), null);
    await assert.rejects(f.engine.observe(f.engine.current, 60, 'still-warming'), /live_entry_held/);
    assert.equal(f.providers.predict.mock.callCount(), 0); f.advance(1); f.pair(); assert.ok(f.stream.snapshot(f.now));
    await f.engine.recoverEntryReads();
    assert.equal(f.state.entryHolds.book_stream, undefined);
    for (const method of ['prepare', 'post', 'prepareAction', 'broadcastAction']) assert.equal(f.client[method].mock.callCount(), 0);
    assert.equal(f.state.completed.length, 1); assert.equal(f.engine.settings.drawdownStop, 10);
});

test('transport holds never mutate pending orders or accounting and never authorize entry', async t => {
    const mutations = {
        unknown: f => { f.position.orders[0].status = 'unknown'; }, pending: f => { f.position.pendingTrades = true; },
        unproven: f => { delete f.position.orders[0].receiptProvenComplete; },
        receipt: f => { delete f.position.receipts[fillHash]; },
        holding: f => { f.position.holdings[1] -= .000001; },
        cash: f => { f.position.receipts[fillHash].cash += .000001; },
        identity: f => { f.position.receipts[fillHash].conditionId = zeroHash; },
        negativeBlock: f => { f.position.receipts[fillHash].blockNumber = -1; },
        action: f => { f.position.actions.push({ status: 'pending' }); },
        fault: f => { f.state.reconciliationFaults = { invalid_owned_trade: { count: 1 } }; },
        uncertain: f => { f.position.uncertain = true; },
    };
    for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
        const f = await fixture(t); mutate(f); assert.equal(f.engine.broker.settledBookHoldReady(), false);
        const before = structuredClone(f.position); f.gap();
        assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.book_stream.retryable, true);
        assert.deepEqual(f.position, before);
        await assert.rejects(f.engine.observe(f.market, 60, 'held'), /live_entry_held/);
        assert.equal(f.client.post.mock.callCount(), 0); assert.equal(f.providers.predict.mock.callCount(), 0);
    });
});

test('semantic book faults and policy closes remain persistent while socket transport errors hold entry', async t => {
    for (const kind of ['identity', 'tick', 'json', 'delta', 'ambiguous', 'policy', 'protocol', 'socket_error'])
        await t.test(kind, async t => {
            const f = await fixture(t); assert.equal(f.engine.broker.settledBookHoldReady(), true);
            if (kind === 'policy') f.gap(1008, 'policy');
            else if (kind === 'protocol') f.gap(1013, 'invalid protocol');
            else if (kind === 'socket_error') f.sockets[0].emit('error', new Error('opaque error'));
            else if (kind === 'json') f.sockets[0].emit('message', '{');
            else f.engine.bookEvent(kind === 'identity' ? 'book_identity_changed' : kind === 'tick' ? 'book_tick_changed' : 'book_gap',
                { reason: kind === 'delta' ? 'invalid_delta' : 'equal_time_delta_conflict', continuityPreserved: false });
            if (kind === 'socket_error') {
                assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.book_stream.retryable, true);
            } else assert.equal(f.state.stopped.reason, 'live_book_feed_gap');
        });
});

test('settled transport recovery never clears prior stops or waives REST risk and data checks', async t => {
    for (const mode of ['prior_drawdown', 'prior_feed', 'rest_failure', 'drawdown']) await t.test(mode, async t => {
        const f = await fixture(t);
        if (mode.startsWith('prior_')) f.state.stopped = { reason: mode === 'prior_drawdown' ? 'drawdown_limit' : 'live_book_feed_gap', at: f.now - 1 };
        const before = structuredClone(f.state.stopped); f.gap();
        if (before) assert.deepEqual(f.state.stopped, before);
        else {
            assert.equal(f.state.stopped, null);
            if (mode === 'rest_failure') f.client.books = async () => { throw new OperationalError('read_timeout', 'timeout'); };
            else f.state.peakEquity = 41;
            f.advance(1000); await f.engine.tick();
            if (mode === 'rest_failure') {
                assert.equal(f.state.stopped, null); assert.equal(f.state.entryHolds.maintenance_mark.retryable, true);
            } else assert.equal(f.state.stopped.reason, 'drawdown_limit');
        }
    });
});
