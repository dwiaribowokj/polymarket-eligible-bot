import fs from 'node:fs';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expectedWalletBalance } from './recovery.js';
import { EPS } from '../restart/math.js';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Operator-reviewed migration for the old handler which discarded an actual
// HTTP 400 rejection. A timeout, null lookup alone, risk stop or real exposure
// can never use this path. Call under the shared pilot lock with service stopped.
export async function reconcileReviewedHttp400(store, client, approval, now = Date.now()) {
    const state = store.state, p = state.position, order = p?.orders?.[0];
    const pinned = () => sha(fs.readFileSync(store.filename)) === approval.ledgerSha256;
    const fail = () => { throw new Error('reviewed_http400_reconciliation_blocked'); };
    if (approval.reviewed !== true || approval.periodId !== state.baseline || !pinned()
        || !isDeepStrictEqual(state.stopped, approval.stop) || state.stopped?.reason !== 'unknown_order_submission'
        || !Number.isFinite(now) || !Number.isFinite(p?.market?.end) || now < p.market.end + 120000
        || p.orders.length !== 1 || order.orderId !== approval.orderId || order.status !== 'unknown'
        || order.signed?.orderType !== 'FAK' || !Number.isFinite(order.postAttemptAt)
        || order.filled !== 0 || order.settled !== 0 || order.tradeIds?.length || order.transactions?.length
        || p.holdings?.length !== 2 || p.holdings.some(h => h !== 0) || p.bought?.some(h => h !== 0)
        || p.fills?.length || p.actions?.length || Object.keys(p.receipts || {}).length || p.pendingTrades
        || p.entryCost !== 0 || p.fees !== 0 || p.gas !== 0 || p.rebate !== 0
        || state.completed?.length || state.maxDrawdown !== 0 || state.peakEquity !== state.cash
        || state.cash !== state.liveFunding?.initialCapital || state.walletCashDelta !== 0
        || Object.values(state.ai?.providers || {}).some(provider => provider.pending || provider.disabled)) fail();
    const events = fs.readFileSync(store.filename + 'l', 'utf8').trim().split('\n').map(JSON.parse);
    const own = events.filter(event => event.orderId === order.orderId);
    const rejection = own.filter(event => event.type === 'submission_uncertain');
    if (own.filter(event => event.type === 'order_submission_started').length !== 1 || rejection.length !== 1
        || rejection[0].error?.httpStatus !== 400 || rejection[0].error?.category !== 'api_rejection'
        || rejection[0].error?.code !== 'http_rejected' || own.some(event => event.type === 'order_accepted')
        || sha(JSON.stringify(rejection[0])) !== approval.rejectionSha256) fail();
    const [presence, account, block] = await Promise.all([
        client.orderPresence(order.orderId), client.ordersAndTrades(p.market), client.confirmedBlock(),
    ]);
    const [balance, holdings] = await Promise.all([client.balance(block), client.holdings(p.market.tokens, block)]);
    const expectedBalance = expectedWalletBalance(state);
    // Require an entirely empty account cohort for this market, avoiding both
    // manual activity and pending/unindexed owned trades. Confirmed balances
    // and holdings are read from the exact same block.
    if (presence.found !== false || presence.httpStatus !== 200 || account.orders.length || account.trades.length
        || !Number.isSafeInteger(block) || !Number.isFinite(balance) || !Number.isFinite(expectedBalance)
        || Math.abs(balance - expectedBalance) > EPS
        || holdings.length !== 2 || holdings.some(h => !Number.isFinite(h) || Math.abs(h) > EPS) || !pinned()) fail();
    const proof = { orderId: order.orderId, httpStatus: 400, orderAbsent: true, accountOrders: 0, accountTrades: 0,
        block, balance, holdings, checkedAt: Date.now(), originalReasonUnknown: true };
    order.status = 'rejected'; order.rejection = { code: 'reviewed_http400', httpStatus: 400, definiteRejection: true };
    order.reconciliation = proof;
    const snapshot = state.ai?.snapshots?.find(s => s.snapshotId === p.entrySignal?.snapshotId);
    if (snapshot) snapshot.entryDisposition = 'order_rejected_reviewed_http400';
    state.stopHistory ||= [];
    state.stopHistory.push({ ...state.stopped, recoveredAt: Date.now(), runtimeId: approval.runtimeId,
        resolution: 'reviewed_http400_no_order', orderId: order.orderId });
    state.stopped = null;
    // Preserve seen, the original reservation, signed order and POST timestamp.
    // The normal engine closes this zero-fill position; it cannot submit again.
    store.event('http400_rejection_reconciled', proof);
    return proof;
}
