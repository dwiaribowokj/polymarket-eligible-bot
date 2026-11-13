import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../../src/restart/store.js';
import { BASELINE } from '../../src/restart/config.js';
import { Engine } from '../../src/restart/engine.js';
import { reconcileReviewedHttp400 } from '../../src/laya-live/rejected-order.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { LayaLiveBroker } from '../../src/laya-live/broker.js';
import { okAsync } from '@polymarket/types';
import { RequestRejectedError, TimeoutError } from '@polymarket/client';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-http400-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const settings = { ...BASELINE, dataDir: dir, fingerprint: '0123456789abcdef', capital: 20 };
    const store = new Store(settings, 'pilot', 'late-entry'); store.logger = () => {};
    const orderId = '0x' + 'a'.repeat(64), now = Date.now(), end = now - 120001;
    Object.assign(store.state, { decisionProvider: 'laya', walletStart: 20, walletCashDelta: 0,
        liveFunding: { initialCapital: 20 }, stopped: { reason: 'unknown_order_submission', at: end - 90000 },
        seen: { market: { at: end - 90000 } }, ai: { providers: {}, snapshots: [{ snapshotId: 'decision', entryDisposition: 'order_unknown' }] },
        position: { market: { slug: 'market', tokens: ['1', '2'], end }, startingCash: 20, openedAt: end - 90000,
            orders: [{ orderId, status: 'unknown', signed: { orderType: 'FAK', sealed: true }, postAttemptAt: end - 90000,
                filled: 0, settled: 0, tradeIds: [], transactions: [] }], holdings: [0, 0], bought: [0, 0],
            entryCost: 0, fees: 0, gas: 0, rebate: 0, actions: [], receipts: {}, fills: [], pendingTrades: false,
            capitalHours: 0, exposureAt: end - 90000, lastDeployed: 0, payout: [0, 1], entrySignal: { snapshotId: 'decision' } } });
    store.event('order_submission_started', { orderId });
    store.event('submission_uncertain', { orderId, error: { code: 'http_rejected', category: 'api_rejection', httpStatus: 400 } });
    const rejection = JSON.parse(fs.readFileSync(store.filename + 'l', 'utf8').trim().split('\n').at(-1));
    const approval = { reviewed: true, periodId: store.state.baseline, runtimeId: 'new-runtime',
        stop: structuredClone(store.state.stopped), orderId, rejectionSha256: sha(JSON.stringify(rejection)) };
    const pin = () => { store.save(); approval.ledgerSha256 = sha(fs.readFileSync(store.filename)); };
    pin();
    const calls = [], client = { orderPresence: async () => ({ found: false, httpStatus: 200 }),
        ordersAndTrades: async () => ({ orders: [], trades: [] }), confirmedBlock: async () => 123,
        balance: async block => { calls.push(['balance', block]); return 20; },
        holdings: async (tokens, block) => { calls.push(['holdings', block]); return [0, 0]; } };
    return { settings, store, client, approval, pin, now, calls };
}

test('reviewed actual HTTP400 plus absent order and same-block balances resolves without repeating the market', async t => {
    const f = fixture(t), before = structuredClone(f.store.state);
    const proof = await reconcileReviewedHttp400(f.store, f.client, f.approval, f.now);
    assert.equal(proof.originalReasonUnknown, true); assert.deepEqual(f.calls, [['balance', 123], ['holdings', 123]]);
    assert.equal(f.store.state.stopped, null); assert.equal(f.store.state.position.orders[0].status, 'rejected');
    assert.equal(f.store.state.stopHistory[0].resolution, 'reviewed_http400_no_order');
    for (const key of ['cash', 'peakEquity', 'maxDrawdown', 'startedAt', 'liveFunding', 'walletCashDelta', 'seen'])
        assert.deepEqual(f.store.state[key], before[key]);
    assert.deepEqual(f.store.state.position.orders[0].signed, before.position.orders[0].signed);
    const engine = new Engine(f.settings, f.store, f.client, { close() {} });
    await engine.manage(null, f.now);
    assert.equal(f.store.state.position, null); assert.equal(f.store.state.completed.length, 1);
    assert.equal(f.store.state.completed[0].traded, false); assert.equal(f.store.state.completed[0].pnl, 0);
    assert.deepEqual(f.store.state.seen, before.seen);
    const restarted = new Store(f.settings, 'pilot', 'late-entry');
    assert.equal(restarted.state.completed[0].traded, false); assert.ok(restarted.state.seen.market);
});

test('null lookup never resolves timeout, risk stop, changed ledger, exposure or changed POST evidence', async t => {
    const changes = [
        f => { f.store.state.stopped.reason = 'drawdown_limit'; f.approval.stop = structuredClone(f.store.state.stopped); f.pin(); },
        f => { f.store.state.position.holdings[1] = 1; f.pin(); },
        f => { f.store.state.position.orders[0].tradeIds = ['pending']; f.pin(); },
        f => { f.store.state.position.actions.push({ status: 'unknown' }); f.pin(); },
        f => { f.store.state.maxDrawdown = 2; f.pin(); },
        f => { delete f.store.state.walletStart; f.pin(); },
        f => { f.store.state.ai.providers.laya = { pending: {} }; f.pin(); },
        f => { f.approval.ledgerSha256 = 'changed'; },
        f => { f.now = f.store.state.position.market.end + 119999; },
        f => {
            const log = fs.readFileSync(f.store.filename + 'l', 'utf8').trim().split('\n').map(JSON.parse);
            log.at(-1).error = { code: 'read_timeout', category: 'timeout' };
            fs.writeFileSync(f.store.filename + 'l', log.map(JSON.stringify).join('\n') + '\n');
            f.approval.rejectionSha256 = sha(JSON.stringify(log.at(-1)));
        },
    ];
    for (const change of changes) {
        const f = fixture(t); change(f); const before = fs.readFileSync(f.store.filename);
        await assert.rejects(reconcileReviewedHttp400(f.store, f.client, f.approval, f.now), /reconciliation_blocked/);
        assert.deepEqual(fs.readFileSync(f.store.filename), before);
    }
});

test('reconciliation refuses existing order, any market trade, unavailable proof or wallet difference', async t => {
    for (const changes of [
        { orderPresence: async () => ({ found: true, httpStatus: 200 }) },
        { orderPresence: async () => ({ found: false, httpStatus: 404 }) },
        { ordersAndTrades: async () => ({ orders: [], trades: [{ status: 'CONFIRMED' }] }) },
        { ordersAndTrades: async () => ({ orders: [{ id: 'other' }], trades: [] }) },
        { balance: async () => 19 }, { balance: async () => NaN },
        { holdings: async () => [0, 1] }, { holdings: async () => [0, NaN] },
    ]) {
        const f = fixture(t), before = fs.readFileSync(f.store.filename);
        await assert.rejects(reconcileReviewedHttp400(f.store, { ...f.client, ...changes }, f.approval, f.now), /reconciliation_blocked/);
        assert.deepEqual(fs.readFileSync(f.store.filename), before);
    }
});

test('official raw order lookup distinguishes HTTP200 null and never assumes a malformed response absent', async () => {
    const orderId = '0x' + 'a'.repeat(64);
    for (const [body, expected] of [[null, false], [{ id: orderId }, true]]) {
        const client = { authenticate: async () => ({ secureClob: {
            get: () => okAsync(new Response(JSON.stringify(body), { status: 200 })),
        } }) };
        assert.equal((await LayaTradingClient.prototype.orderPresence.call(client, orderId)).found, expected);
    }
    const malformed = { authenticate: async () => ({ secureClob: { get: () => okAsync(new Response('{}', { status: 200 })) } }) };
    await assert.rejects(LayaTradingClient.prototype.orderPresence.call(malformed, orderId), /invalid_order_lookup/);
    await assert.rejects(LayaTradingClient.prototype.orderPresence.call(malformed, 'bad-id'), /invalid_order_id/);
});

test('live client normalizes a real SDK400 while preserving thrown timeout uncertainty', async () => {
    const noMatch = new RequestRejectedError('no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.', { status: 400 });
    for (const error of [noMatch, new TimeoutError('timed out')]) {
        let posts = 0;
        const client = { authenticate: async () => ({ postOrder: async () => { posts++; throw error; } }) };
        if (error === noMatch) {
            const result = await LayaTradingClient.prototype.post.call(client, { sealed: true });
            assert.deepEqual(result, { ok: false, code: 'fak_not_filled', httpStatus: 400, definiteRejection: true });
        } else await assert.rejects(LayaTradingClient.prototype.post.call(client, { sealed: true }), e => e === error);
        assert.equal(posts, 1);
    }
});

test('recognized FAK no-fill rejection retains one attempt without stop, other definite400 stops without unknown exposure', async t => {
    for (const [code, stopped] of [['fak_not_filled', null], ['http_rejected', 'order_rejected'], ['invalid_signature', 'order_rejected']]) {
        const f = fixture(t), state = f.store.state;
        state.stopped = null; state.position.orders = []; delete state.position.submitAttemptedAt;
        const spec = { side: 'BUY', price: .83, shares: 5, tokenId: '2', index: 1, kind: 'taker' };
        let posts = 0;
        const client = { prepare: async () => ({ signed: { orderType: 'FAK' }, orderId: f.approval.orderId }),
            post: async () => { posts++; return { ok: false, code, httpStatus: 400, definiteRejection: true }; } };
        const broker = new LayaLiveBroker(f.settings, f.store, client, async () => {});
        assert.equal((await broker.submit(spec, f.now)).status, 'rejected');
        assert.equal(state.stopped?.reason ?? null, stopped); assert.equal(posts, 1);
        assert.deepEqual(state.position.holdings, [0, 0]);
        await assert.rejects(broker.submit(spec, f.now), /duplicate_entry/);
        assert.equal(posts, 1);
    }
});
