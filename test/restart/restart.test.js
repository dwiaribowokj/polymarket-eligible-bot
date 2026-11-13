import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { Store, acquireLock, otherLiveExposure } from '../../src/restart/store.js';
import { comparison, dailyBootstrap, evaluate, fee, makerFill, riskReason, sweep } from '../../src/restart/math.js';
import { entryPlan, newPosition } from '../../src/restart/strategy.js';
import { PaperBroker } from '../../src/restart/paper.js';
import { LiveBroker, ownedTradeParts } from '../../src/restart/live.js';
import { TradingClient, CONTRACTS, receiptMovements } from '../../src/restart/client.js';
import { Engine } from '../../src/restart/engine.js';
import { parseArgs } from '../../src/restart.js';
import { report, saveReport } from '../../src/restart/report.js';

const wallet = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const schedule = { rate: 0.07, exponent: 1, takerOnly: true };
function fixture(t, mode = 'paper', strategy = 'late-entry') {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-restart-test-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, lateSignal: null, paperDrawdownStop: 2, fingerprint: 'test', dataDir, paperGasUsd: 0.05, wallet };
    const store = new Store(settings, mode, strategy); store.logger = () => {};
    const now = Date.now();
    const market = { slug: 'test-market', conditionId: `0x${'a'.repeat(64)}`, tokens: ['1', '2'],
        outcomes: ['Up', 'Down'], tick: 0.01, minimum: 5, fee: schedule, accepting: true,
        open: now - 275000, end: now + 25000 };
    const books = [{ asks: [{ price: 0.8, size: 5 }], bids: [{ price: 0.79, size: 10 }] },
        { asks: [{ price: 0.21, size: 5 }], bids: [{ price: 0.20, size: 10 }] }];
    const plan = entryPlan('late-entry', market, books, settings, 20, now);
    store.state.position = newPosition(market, plan, store.state, now);
    const feed = { ready: true, generation: 0, events: [], drain() { return this.events.splice(0); }, watch() {}, reconnect() {}, close() {} };
    return { settings, store, market, books, now, plan, feed };
}
function transferLog(address, from, to, value) {
    const iface = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
    return { address, ...iface.encodeEventLog(iface.getEvent('Transfer'), [from, to, ethers.utils.parseUnits(String(value), 6)]) };
}
function tokenLog(from, to, id, value) {
    const iface = new ethers.utils.Interface(['event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)']);
    return { address: CONTRACTS.conditionalTokens, ...iface.encodeEventLog(iface.getEvent('TransferSingle'),
        [other, from, to, id, ethers.utils.parseUnits(String(value), 6)]) };
}
const buyReceipt = shares => ({ status: 1, confirmations: 2, blockNumber: 123,
    logs: [transferLog(CONTRACTS.collateralToken, wallet, other, shares * 0.8 + fee(shares, 0.8, schedule)),
        tokenLog(other, wallet, '1', shares)] });

test('CLI defaults to paper and requires explicit valid pilot strategy', () => {
    assert.equal(parseArgs([]).command, 'paper');
    assert.throws(() => parseArgs(['pilot']), /explicit/);
    assert.throws(() => parseArgs(['pilot', '--strategy=sniper']), /Unknown/);
    assert.throws(() => parseArgs(['pilot', '--strategy=maker-mm', '--new-trial']), /only/);
    assert.throws(() => parseArgs(['pilot', '--strategy=maker-mm', '--save']), /only/);
    assert.equal(parseArgs(['report', '--save']).save, true);
});
test('late entry uses executable ask, fixed windows, final 20-second threshold', t => {
    const f = fixture(t);
    assert.equal(f.plan.orders[0].price, 0.8);
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 5000), null);
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 91000), null);
    f.books[0].asks[0].price = 0.79;
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 19000), null);
    f.books[0].asks[0].price = 0.9;
    assert.ok(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.market.end - 19000));
    f.books[0].asks[0].price = 0.91;
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.now), null);
});
test('minimum and fee-inclusive budget are enforced without silently upsizing', t => {
    const f = fixture(t);
    f.market.minimum = 6;
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 20, f.now), null);
    f.market.minimum = 5;
    assert.equal(entryPlan('late-entry', f.market, f.books, f.settings, 4, f.now), null);
    assert.equal(entryPlan('late-entry', f.market, f.books, { ...f.settings, entryCap: 4 }, 20, f.now), null);
});
test('maker bids use postOnly plan, five shares each and combined cap', t => {
    const f = fixture(t, 'paper', 'maker-mm');
    f.market.open = f.now - 15000; f.market.end = f.market.open + 900000;
    const plan = entryPlan('maker-mm', f.market, f.books, f.settings, 20, f.now);
    assert.ok(plan.cost <= 4.9);
    assert.ok(plan.orders.every(o => o.shares === 5 && o.kind === 'maker'));
    assert.equal(entryPlan('maker-mm', f.market, f.books, f.settings, 20, f.market.open + 5000), null);
});
test('depth sweep produces partial FAK fill and charges correct fees', () => {
    const r = sweep([{ price: 0.8, size: 2 }, { price: 0.81, size: 50 }], 5, 0.8, 'BUY', schedule);
    assert.equal(r.shares, 2); assert.equal(r.cash, -1.6224); assert.equal(r.fees, 0.0224);
});
test('maker requires observed sell volume beyond queue; price touch and buys do not fill', () => {
    const o = { status: 'open', price: 0.49, shares: 5, filled: 0, queueAhead: 10, activeAt: 100 };
    assert.equal(makerFill(o, { side: 'BUY', price: 0.49, size: 100, at: 200 }), 0);
    assert.equal(makerFill(o, { side: 'SELL', price: 0.49, size: 100, at: 99 }), 0);
    assert.equal(makerFill(o, { side: 'SELL', price: 0.49, size: 10, at: 200 }), 0);
    assert.equal(makerFill(o, { side: 'SELL', price: 0.49, size: 2, at: 201 }), 2);
});
test('paper partial fill waits for settlement, survives restart, and never chases remainder', async t => {
    const f = fixture(t), b = new PaperBroker(f.settings, f.store, {}, f.feed);
    f.books[0].asks[0].size = 2;
    const order = await b.submit(f.plan.orders[0], f.now);
    await b.reconcile(f.books, f.now + 300);
    assert.equal(order.filled, 2); assert.equal(f.store.state.position.holdings[0], 0); assert.ok(b.pending());
    const restarted = new Store(f.settings, 'paper', 'late-entry'); restarted.logger = () => {};
    const next = new PaperBroker(f.settings, restarted, {}, f.feed);
    await next.reconcile(f.books, f.now + 3000);
    assert.equal(restarted.state.position.holdings[0], 2); assert.equal(restarted.state.position.orders.length, 1);
    assert.equal(next.pending(), false);
});
test('paper postOnly rejection does not become a taker fill', async t => {
    const f = fixture(t, 'paper', 'maker-mm'), b = new PaperBroker(f.settings, f.store, {}, f.feed);
    await b.submit({ ...f.plan.orders[0], kind: 'maker' }, f.now);
    await b.reconcile(f.books, f.now + 300);
    assert.equal(f.store.state.position.orders[0].status, 'rejected');
    assert.deepEqual(f.store.state.position.holdings, [0, 0]);
});
test('paper maker fills stay pending before merge and queue remains conservative', async t => {
    const f = fixture(t, 'paper', 'maker-mm'), b = new PaperBroker(f.settings, f.store, {}, f.feed);
    const order = await b.submit({ ...f.plan.orders[0], price: 0.79, kind: 'maker' }, f.now);
    await b.reconcile(f.books, f.now + 300);
    assert.equal(order.queueAhead, 10);
    f.feed.events.push({ tokenId: '1', price: 0.79, size: 13, side: 'SELL', at: f.now + 400 });
    await b.reconcile(f.books, f.now + 400);
    assert.equal(order.filled, 3); assert.equal(f.store.state.position.holdings[0], 0);
    await b.reconcile(f.books, f.now + 3000);
    assert.equal(f.store.state.position.holdings[0], 3);
});
test('timeout after submit persists signed identity; restart never POSTs a duplicate', async t => {
    const f = fixture(t, 'pilot'); let posts = 0, prepares = 0;
    const client = { prepare: async () => { prepares++; return { orderId: 'owned', signed: { salt: 'fixed' } }; },
        post: async () => { posts++; throw new Error('timeout'); }, ordersAndTrades: async () => ({ orders: [], trades: [] }),
        order: async () => ({ status: 'CANCELED', sizeMatched: '0' }) };
    const b = new LiveBroker(f.settings, f.store, client);
    await b.submit(f.plan.orders[0], f.now);
    assert.equal(f.store.state.stopped.reason, 'unknown_order_submission');
    const restarted = new Store(f.settings, 'pilot', 'late-entry'); restarted.logger = () => {};
    const next = new LiveBroker(f.settings, restarted, client);
    await next.reconcile(null, f.now + 1000);
    assert.equal(posts, 1); assert.equal(prepares, 1); assert.equal(restarted.state.position.orders[0].orderId, 'owned');
});
test('accepted order is not a settled fill; only owned confirmed receipts update ledger', async t => {
    const f = fixture(t, 'pilot'); let receipt = null;
    const client = { prepare: async () => ({ orderId: 'owned', signed: {} }), post: async () => ({ ok: true, orderId: 'owned', status: 'matched' }),
        order: async () => ({ status: 'MATCHED', sizeMatched: '2' }),
        ordersAndTrades: async () => ({ orders: [], trades: [{ id: 'trade1', traderSide: 'TAKER', takerOrderId: 'owned',
            size: '2', price: '0.8', status: 'CONFIRMED', transactionHash: 'tx' }] }), receipt: async () => receipt };
    const b = new LiveBroker(f.settings, f.store, client);
    await b.submit(f.plan.orders[0], f.now);
    assert.deepEqual(f.store.state.position.holdings, [0, 0]);
    await b.reconcile(null, f.now + 1000); assert.ok(b.pending());
    receipt = buyReceipt(2);
    await b.reconcile(null, f.now + 2000);
    assert.equal(f.store.state.position.holdings[0], 2); assert.equal(f.store.state.cash, 18.3776);
    await b.reconcile(null, f.now + 3000);
    assert.equal(f.store.state.cash, 18.3776); assert.equal(f.store.state.position.fills.length, 1);
});
test('failed trade settlement stops entry and does not create inventory', async t => {
    const f = fixture(t, 'pilot');
    f.store.state.position.orders.push({ orderId: 'owned', status: 'accepted', shares: 5, filled: 0, settled: 0 });
    const b = new LiveBroker(f.settings, f.store, { order: async () => ({ status: 'MATCHED', sizeMatched: '2' }),
        ordersAndTrades: async () => ({ orders: [], trades: [{ id: 'bad', traderSide: 'TAKER', takerOrderId: 'owned',
            size: '2', price: '0.8', status: 'FAILED' }] }) });
    await b.reconcile(null, f.now);
    assert.equal(f.store.state.stopped.reason, 'trade_settlement_failed'); assert.deepEqual(f.store.state.position.holdings, [0, 0]);
});
test('cancel only IDs persisted in bot ledger', async t => {
    const f = fixture(t, 'pilot'); const cancelled = [];
    f.store.state.position.orders = [{ orderId: 'ours', status: 'open' }];
    const b = new LiveBroker(f.settings, f.store, { cancel: async id => cancelled.push(id) });
    await b.cancelOwned(); assert.deepEqual(cancelled, ['ours']);
    assert.ok(b.pending(), 'cancel acknowledgement must retain exposure until reconciliation');
});
test('fill racing cancellation is settled before market can be completed', async t => {
    const f = fixture(t, 'pilot'); let matched = false;
    f.store.state.position.orders = [{ orderId: 'ours', index: 0, side: 'BUY', price: 0.8,
        shares: 5, status: 'open', filled: 0, settled: 0 }];
    const client = { cancel: async () => {}, order: async () => ({ status: 'CANCELED', sizeMatched: matched ? '2' : '0' }),
        ordersAndTrades: async () => ({ orders: [], trades: matched ? [{ id: 'race', traderSide: 'TAKER', takerOrderId: 'ours',
            size: '2', price: '0.8', status: 'CONFIRMED', transactionHash: 'race-tx' }] : [] }), receipt: async () => buyReceipt(2) };
    const b = new LiveBroker(f.settings, f.store, client);
    await b.cancelOwned(); await b.reconcile(null, f.now + 1000);
    assert.ok(b.pending()); matched = true;
    await b.reconcile(null, f.now + 31000);
    assert.equal(b.pending(), false); assert.equal(f.store.state.position.holdings[0], 2);
});
test('stop and market/time limits do not reset when position is open', t => {
    const f = fixture(t, 'pilot'); f.store.state.startedAt = f.now - 48 * 3600000;
    assert.equal(riskReason(f.store.state, f.settings, f.now, 20), 'time_limit');
    f.store.state.startedAt = f.now; f.store.state.completed = Array(30).fill({});
    assert.equal(riskReason(f.store.state, f.settings, f.now, 20), 'market_limit');
});
test('one-sided inventory that cannot be sold remains exposed after maker cutoff', async t => {
    const f = fixture(t, 'paper', 'maker-mm');
    f.store.state.position.holdings = [5, 0]; f.store.state.position.bought = [5, 0];
    f.books[0].bids = [];
    const e = new Engine(f.settings, f.store, {}, f.feed);
    await e.manage(f.books, f.market.end - 50000);
    assert.ok(f.store.state.position); assert.deepEqual(f.store.state.position.holdings, [5, 0]);
    assert.equal(f.store.state.completed.length, 0);
});
test('market closing does not turn locked inventory into an artificial $2 drawdown', async t => {
    const f = fixture(t, 'pilot');
    f.store.state.cash = 15.9; f.store.state.walletStart = 20; f.store.state.walletCashDelta = -4.1;
    f.store.state.position.holdings = [5, 0]; f.store.state.position.markBooks = f.books;
    const client = { serverTime: async () => Date.now(), ordersAndTrades: async () => ({ orders: [], trades: [] }),
        balance: async () => 15.9, holdings: async () => [5, 0], payout: async () => null };
    const e = new Engine(f.settings, f.store, client, f.feed);
    await e.tick(f.market.end + 1000);
    assert.equal(f.store.state.stopped, null); assert.ok(f.store.state.position);
    assert.ok(f.store.state.maxDrawdown < 1);
});
test('persisted stop and $2 drawdown survive restart; open position is retained', t => {
    const f = fixture(t, 'pilot');
    assert.equal(riskReason(f.store.state, f.settings, f.now, 18), 'drawdown_limit');
    f.store.stop('drawdown_limit');
    const restarted = new Store(f.settings, 'pilot', 'late-entry');
    assert.equal(restarted.state.stopped.reason, 'drawdown_limit'); assert.ok(restarted.state.position);
    assert.equal(restarted.state.maxDrawdown, 2);
    assert.deepEqual(otherLiveExposure({ ...f.settings, fingerprint: 'new-code' }), [{ baseline: 'test', strategy: 'late-entry' }]);
});
test('wallet reconciliation blocks new entry on unaccounted transfer', async t => {
    const f = fixture(t, 'pilot'); f.store.state.walletStart = 20;
    const b = new LiveBroker(f.settings, f.store, { balance: async () => 19, holdings: async () => [0, 0] });
    assert.equal(await b.checkWallet(), false); assert.equal(f.store.state.stopped.reason, 'wallet_ledger_mismatch');
});
test('one-confirmation fill does not create false wallet mismatch or settled inventory', async t => {
    const f = fixture(t, 'pilot'); f.store.state.walletStart = 20;
    f.store.state.position.orders = [{ orderId: 'owned', index: 0, side: 'BUY', price: 0.8,
        shares: 5, status: 'accepted', filled: 0, settled: 0 }];
    const blocks = [];
    const client = { confirmedBlock: async () => 122, order: async () => ({ status: 'MATCHED', sizeMatched: '2' }),
        ordersAndTrades: async () => ({ orders: [], trades: [{ id: 'pending', traderSide: 'TAKER', takerOrderId: 'owned',
            size: '2', price: '0.8', status: 'CONFIRMED', transactionHash: 'pending-tx' }] }),
        receipt: async () => ({ ...buyReceipt(2), confirmations: 1, blockNumber: 123 }),
        balance: async block => { blocks.push(block); return block < 123 ? 20 : 18.3776; },
        holdings: async (_, block) => block < 123 ? [0, 0] : [2, 0] };
    const b = new LiveBroker(f.settings, f.store, client);
    await b.reconcile(null, f.now); assert.equal(await b.checkWallet(), true);
    assert.deepEqual(f.store.state.position.holdings, [0, 0]); assert.deepEqual(blocks, [122]);
    assert.equal(f.store.state.stopped, null);
});
test('redeem pending transaction resumes using same hash, then confirms without double accounting', async t => {
    const f = fixture(t, 'pilot'); let knownReceipt = null; const broadcasts = [];
    f.store.state.position.holdings = [2, 0]; f.store.state.position.payout = [1, 0];
    const client = { prepareAction: async () => ({ kind: 'redeem', hash: 'redeem-tx', raw: 'same-raw', createdAt: f.now,
        status: 'prepared', polUsd: 0.1 }), broadcastAction: async a => broadcasts.push(a.raw),
        receipt: async () => knownReceipt, actionSucceeded: () => true, receiptGas: () => 0.01 };
    const b = new LiveBroker(f.settings, f.store, client);
    await b.action('redeem', 0, f.now);
    const restarted = new Store(f.settings, 'pilot', 'late-entry'); restarted.logger = () => {};
    const next = new LiveBroker(f.settings, restarted, client);
    await next.reconcileActions(f.now + 31000);
    assert.deepEqual(broadcasts, ['same-raw', 'same-raw']);
    knownReceipt = { confirmations: 2, logs: [transferLog(CONTRACTS.collateralToken, other, wallet, 2),
        tokenLog(wallet, ethers.constants.AddressZero, '1', 2)] };
    await next.reconcileActions(f.now + 32000); await next.reconcileActions(f.now + 33000);
    assert.equal(restarted.state.cash, 21.99); assert.deepEqual(restarted.state.position.holdings, [0, 0]);
});
test('temporary redeem preparation failure is retriable after restart', async t => {
    const f = fixture(t, 'pilot'); let attempts = 0;
    const client = { prepareAction: async () => { if (++attempts === 1) throw new Error('RPC temporary');
        return { kind: 'redeem', hash: 'retry', raw: 'raw', createdAt: f.now, status: 'prepared' }; }, broadcastAction: async () => {} };
    const b = new LiveBroker(f.settings, f.store, client);
    await assert.rejects(b.action('redeem', 0, f.now)); f.store.save();
    const nextStore = new Store(f.settings, 'pilot', 'late-entry'); nextStore.logger = () => {};
    await new LiveBroker(f.settings, nextStore, client).action('redeem', 0, f.now + 1000);
    assert.equal(attempts, 2); assert.equal(nextStore.state.position.actions.length, 1);
});
test('Safe outer status one is insufficient when inner operation failed', () => {
    const client = Object.create(TradingClient.prototype); client.settings = { wallet };
    const iface = new ethers.utils.Interface(['event ExecutionFailure(bytes32 txHash,uint256 payment)', 'event ExecutionSuccess(bytes32 txHash,uint256 payment)']);
    const hash = `0x${'0'.repeat(64)}`;
    const receipt = { status: 1, logs: [{ address: wallet, ...iface.encodeEventLog(iface.getEvent('ExecutionFailure'), [hash, 0]) }] };
    assert.equal(client.actionSucceeded(receipt), false);
    receipt.logs = [{ address: wallet, ...iface.encodeEventLog(iface.getEvent('ExecutionSuccess'), [hash, 0]) }];
    assert.equal(client.actionSucceeded(receipt), true);
});
test('maker queue lost at restart is invalidated and cancelled', async t => {
    const f = fixture(t, 'paper', 'maker-mm');
    f.store.state.position.orders = [{ orderId: 'paper-owned', kind: 'maker', status: 'open' }];
    const e = new Engine(f.settings, f.store, {}, f.feed);
    await e.boot();
    assert.equal(f.store.state.position.orders[0].status, 'cancelled');
    assert.equal(f.store.state.position.uncertain, true); assert.equal(f.store.state.dataGaps, 1);
});
test('late position waits for official payout, including non-spot outcome, before redeem', async t => {
    const f = fixture(t); let payout = null;
    f.store.state.position.holdings = [5, 0]; f.store.state.position.bought = [5, 0];
    f.store.state.cash = 16; f.store.state.position.orders = [];
    const e = new Engine(f.settings, f.store, { payout: async () => payout }, f.feed);
    await e.manage(null, f.market.end + 1000); assert.ok(f.store.state.position);
    payout = [0, 1];
    await e.manage(null, f.market.end + 17000);
    assert.equal(f.store.state.position, null); assert.equal(f.store.state.completed[0].pnl, -4.05);
});
test('maker pairs merge only confirmed holdings; sub-minimum remainder is carried to settlement', async t => {
    const f = fixture(t, 'paper', 'maker-mm');
    f.market.end = f.now + 50000; f.store.state.position.market = f.market;
    f.store.state.position.holdings = [3, 2]; f.store.state.position.bought = [3, 2];
    const e = new Engine(f.settings, f.store, {}, f.feed);
    await e.manage(f.books, f.now);
    assert.deepEqual(f.store.state.position.holdings, [1, 0]);
    assert.equal(f.store.state.position.orders.length, 0); assert.ok(f.store.state.position);
});
test('evaluation requires seven observed days, 100 closed markets and positive daily bootstrap lower bound', t => {
    const f = fixture(t); const state = f.store.state; state.position = null;
    state.startedAt = f.now - 8 * 86400000;
    state.completed = Array.from({ length: 105 }, (_, i) => ({ traded: true, closedAt: state.startedAt + Math.floor(i / 15) * 86400000 + 5000,
        pnl: 0.1, fees: 0, gas: 0.05, rebate: 0, capitalHours: 1, partial: false, oneSided: false }));
    assert.equal(evaluate(state, f.settings, f.now).eligible, true);
    assert.equal(comparison([state, null], f.settings, f.now).selected, 'late-entry');
    state.completed.forEach(r => { r.closedAt = f.now - 1000; });
    assert.equal(evaluate(state, f.settings, f.now).eligible, false);
    state.baseline = 'changed'; assert.ok(evaluate(state, f.settings, f.now).reasons.includes('baseline_changed'));
});
test('unfinished losing inventory and execution data gaps prevent pilot selection', t => {
    const f = fixture(t); const state = f.store.state;
    assert.ok(evaluate(state, f.settings, f.now).reasons.includes('unresolved_inventory'));
    state.dataGaps = 1;
    assert.ok(evaluate(state, f.settings, f.now).reasons.includes('incomplete_execution_data'));
    const rows = Array.from({ length: 14 }, (_, i) => ({ closedAt: f.now - i * 86400000, pnl: i === 0 ? -5 : 0.1 }));
    assert.ok(dailyBootstrap(rows, 1000).lower < 0);
});
test('maker account trades never attribute another maker order to bot', () => {
    assert.equal(ownedTradeParts({ traderSide: 'MAKER', makerOrders: [{ orderId: 'other', matchedAmount: '5', price: '.5' }] }, [{ orderId: 'ours' }]).length, 0);
});
test('receipt transfers only count pUSD and relevant CTF token IDs', () => {
    const movement = receiptMovements({ logs: [transferLog(other, other, wallet, 100), tokenLog(other, wallet, '999', 100)] }, wallet, ['1', '2']);
    assert.deepEqual(movement, { cash: 0, holdings: [0, 0] });
});
test('exclusive process lock prevents two instances and ledger corruption fails closed', async t => {
    const f = fixture(t); const release = await acquireLock(f.settings.dataDir, 'paper');
    await assert.rejects(acquireLock(f.settings.dataDir, 'paper'), /already running/); await release();
    const again = await acquireLock(f.settings.dataDir, 'paper'); await again();
    f.store.save(); fs.writeFileSync(f.store.filename, '{bad-json');
    assert.throws(() => new Store(f.settings, 'paper', 'late-entry'));
});

test('Saturday deadline blocks early pilot even after sample and profit requirements pass', t => {
    const f = fixture(t), state = f.store.state;
    state.position = null; state.startedAt = f.now - 6 * 86400000;
    state.completed = Array.from({ length: 105 }, (_, i) => ({ traded: true, closedAt: state.startedAt + Math.floor(i / 15) * 86400000 + 5000,
        pnl: 0.1, fees: 0, gas: 0, rebate: 0, capitalHours: 1, partial: false, oneSided: false }));
    const settings = { ...f.settings, minDays: 5, evaluationEndsAt: f.now + 1000 };
    assert.ok(evaluate(state, settings, f.now).reasons.includes('evaluation_window_open'));
    assert.equal(evaluate(state, settings, f.now + 1000).eligible, true);
});
test('deadline freezes paper even with too few markets and retains open inventory', async t => {
    const f = fixture(t); f.settings.evaluationEndsAt = f.now - 1000; f.settings.minDays = 5;
    f.store.state.position.holdings = [2, 0];
    let submissions = 0;
    const client = { serverTime: async () => Date.now(), books: async () => f.books };
    const e = new Engine(f.settings, f.store, client, f.feed);
    e.discover = async () => { submissions++; };
    await e.tick(f.now);
    assert.equal(f.store.state.frozenAt, f.settings.evaluationEndsAt);
    assert.equal(submissions, 0); assert.ok(f.store.state.position);
    assert.equal(evaluate(f.store.state, f.settings, f.now).eligible, false);
});
test('API clock outage at deadline still closes paper entry window', async t => {
    const f = fixture(t); f.settings.evaluationEndsAt = f.now - 1000; f.store.state.position = null;
    const e = new Engine(f.settings, f.store, { serverTime: async () => { throw new Error('offline'); } }, f.feed);
    await e.tick(f.now);
    assert.equal(f.store.state.frozenAt, f.settings.evaluationEndsAt);
    assert.equal(f.store.state.position, null);
});
test('paper maker ignores transactions after cutoff and cancels pending entry', async t => {
    const f = fixture(t, 'paper', 'maker-mm'), b = new PaperBroker(f.settings, f.store, {}, f.feed);
    const order = await b.submit({ ...f.plan.orders[0], price: 0.79, kind: 'maker' }, f.now);
    await b.reconcile(f.books, f.now + 300);
    f.store.state.frozenAt = f.now + 400;
    f.feed.events.push({ tokenId: '1', price: 0.79, size: 100, side: 'SELL', at: f.now + 401 });
    await b.reconcile(f.books, f.now + 500);
    assert.equal(order.filled, 0);
    const late = await b.submit(f.plan.orders[0], f.now + 500);
    assert.equal(late.status, 'cancelled');
});
test('scheduled report works offline and marks unresolved exposure provisional', t => {
    const f = fixture(t); f.settings.evaluationEndsAt = f.now - 1000;
    f.store.save();
    const result = report(f.settings, f.now);
    assert.equal(result.provisional, true); assert.equal(result.selected, null);
    assert.equal(result.evaluationEndsAt, new Date(f.settings.evaluationEndsAt).toISOString());
    saveReport(f.settings, f.now);
    const saved = JSON.parse(fs.readFileSync(path.join(f.settings.dataDir, 'test/evaluation-report.json'), 'utf8'));
    assert.equal(saved.decision, 'belum layak'); assert.equal(saved.provisional, true);
});
