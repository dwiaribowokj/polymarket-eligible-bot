import assert from 'node:assert/strict';
import test from 'node:test';
import { PairedQuoteTape, simulatePaperFak } from '../../scripts/paired-version-paper/quotes.mjs';

const market = { open: 300000, end: 600000, slug: 'btc-updown-5m-300', conditionId: '0x' + 'a'.repeat(64),
    tokens: ['111', '222'], minimum: 5, ticks: [.01, .01], negRisk: false, accepting: true,
    fee: { rate: .07, exponent: 1, takerOnly: true } };
const at = 510500;
const book = (now, index = 0, ask = .74) => ({ tokenId: market.tokens[index], conditionId: market.conditionId,
    timestamp: now - 45, fetchedAt: now - 30, tick: .01,
    bids: [{ price: Math.round((ask - .01) * 100) / 100, size: 15 }], asks: [{ price: ask, size: 50 }] });
const ready = () => ({ status: 'ready', targetAt: at, observedAt: at, market, index: 0, book: book(at) });
const policyIdentity = JSON.stringify([market.conditionId, market.tokens, 5, market.ticks, market.fee, false]);

function tape(options = {}) {
    let now = at - 1000, ask = .74, bad = false;
    const stream = { generation: 2, watch() {}, close() {}, snapshot() {
        return bad ? null : [book(now, 0, ask), book(now, 1, .26)];
    } };
    const instance = new PairedQuoteTape({ clock: () => now, schedule: () => 1, cancel() {}, stream,
        tickReader: async () => [.01, .01], ...options });
    instance.watch(market);
    const select = (t = at, tokenId = '111') => instance.select({ slug: market.slug, conditionId: market.conditionId, tokenId, targetAt: t });
    return { instance, stream, select, sample(time, p = .74, fault = false) {
        now = time; ask = p; bad = fault; instance.sample();
    }, set(time) { now = time; } };
}

test('choose the earliest independently sampled quote after each arm is ready, never a later more favorable price', async () => {
    const t = tape();
    t.sample(at - 900); await t.instance.tickRequest;
    t.sample(at - 100, .74); t.sample(at + 10, .76); t.sample(at + 110, .72);
    const one = t.select(), two = t.select(at + 50);
    assert.equal(one.status, 'ready'); assert.equal(one.book.asks[0].price, .76); assert.equal(one.offsetMs, 10);
    assert.equal(two.book.asks[0].price, .72); assert.equal(two.offsetMs, 60);
    one.book.asks[0].price = .1; assert.equal(t.select().book.asks[0].price, .76);
    assert.equal(t.select(at, '999').reason, 'quote_identity_changed');
    assert.equal(t.select(at + 200).status, 'pending');
    t.set(at + 520); assert.equal(t.select(at + 200).reason, 'no_timely_sample');
    t.instance.close();
});

test('data gaps including reconnect and stale tick reads cannot become modeled zero-exposure trades', async () => {
    const t = tape();
    t.sample(at - 900); await t.instance.tickRequest;
    t.sample(at - 100); t.sample(at + 10, .74, true); t.sample(at + 110);
    assert.equal(t.select().reason, 'book_stream_unavailable');
    assert.equal(t.select(at + 50).reason, 'book_continuity_unproven');
    t.stream.generation++; t.sample(at + 210);
    assert.equal(t.select(at + 140).reason, 'book_continuity_unproven');
    t.sample(at + 710);
    assert.equal(t.select(at + 700).reason, 'no_timely_sample');
    t.sample(at + 6000); assert.equal(t.instance.samples.at(-1).reason, 'tick_unverified');
    assert.deepEqual(simulatePaperFak({ quote: t.select(at + 700), limitPrice: .76 }), { status: 'unavailable', reason: 'no_timely_sample' });
    t.instance.close();
});

test('cash-budget FAK sweeps price improvement and deducts fees and gas once; partial fills do not assume hidden depth', () => {
    const quote = ready();
    quote.book.asks = [{ price: .74, size: 1 }, { price: .75, size: 10 }];
    const fill = simulatePaperFak({ quote, limitPrice: .78, validationIdentity: policyIdentity });
    assert.equal(fill.status, 'filled'); assert.ok(fill.shares > 5); assert.equal(fill.principalBudget, 3.9);
    assert.equal(fill.principal, 3.9); assert.equal(fill.allInCost, fill.entryCost + .05);
    assert.equal(fill.entryCost, Math.round((fill.principal + fill.fees) * 1e6) / 1e6);
    quote.book.asks = [{ price: .74, size: .1 }, { price: .8, size: 20 }];
    const partial = simulatePaperFak({ quote, limitPrice: .78 });
    assert.equal(partial.status, 'partial'); assert.equal(partial.shares, .1); assert.equal(partial.principal, .074);
    assert.equal(partial.gas, .05); assert.equal(partial.fees, .00135);
    const unmarketable = simulatePaperFak({ quote, limitPrice: .73 });
    assert.equal(unmarketable.status, 'no_fill'); assert.equal(unmarketable.allInCost, 0);
    quote.book.asks = [{ price: .74, size: 1 }]; quote.book.depthTruncated = true;
    assert.deepEqual(simulatePaperFak({ quote, limitPrice: .78 }), { status: 'unavailable', reason: 'depth_truncated' });
});

test('reject mismatched decision metadata, stale or invalid prices, wide spreads and changes to minimum or time window', () => {
    const quote = ready();
    assert.equal(simulatePaperFak({ quote, limitPrice: .78, validationIdentity: policyIdentity.replace('111', '911') }).reason, 'snapshot_metadata_changed');
    assert.equal(simulatePaperFak({ quote, limitPrice: .785 }).reason, 'frozen_order_invalid');
    quote.book.timestamp = at - 5001;
    assert.equal(simulatePaperFak({ quote, limitPrice: .78 }).reason, 'quote_proof_invalid');
    quote.book = book(at, 0); quote.book.bids[0].price -= .04;
    assert.equal(simulatePaperFak({ quote, limitPrice: .78 }).reason, 'execution_constraints_changed');
    quote.book = book(at, 0, .70); assert.equal(simulatePaperFak({ quote, limitPrice: .78 }).reason, 'execution_constraints_changed');
    quote.book = book(at); quote.market = { ...market, minimum: 6 };
    assert.equal(simulatePaperFak({ quote, limitPrice: .78 }).reason, 'execution_constraints_changed');
});

test('validated order can improve below the entry band or remain unfilled at arrival without relaxing data checks', () => {
    const quote = ready();
    const run = stage => simulatePaperFak({ quote, limitPrice: .74, validationIdentity: policyIdentity, stage });
    assert.equal(run('validation').averagePrice, .74);
    quote.book = book(at, 0, .65); quote.book.bids = [];
    assert.equal(run('validation').status, 'no_fill');
    const improved = run('arrival');
    assert.equal(improved.status, 'filled');
    assert.equal(improved.averagePrice, .65); assert.equal(improved.principal, 3.70);
    assert.ok(improved.shares > 5);
    quote.book = book(at, 0, .76);
    const chased = run('arrival');
    assert.equal(chased.status, 'no_fill'); assert.equal(chased.reason, 'frozen_limit_unmarketable');
    quote.book.asks = []; assert.equal(run('arrival').status, 'no_fill');
    quote.book = book(at, 1, .65); assert.equal(run('arrival').reason, 'quote_proof_invalid');
    quote.book = book(at, 0, .65); quote.book.timestamp -= 6000;
    assert.equal(run('arrival').reason, 'quote_proof_invalid');
    assert.equal(run('invalid').reason, 'unknown_quote_stage');
});
