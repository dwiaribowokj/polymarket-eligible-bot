import test from 'node:test';
import assert from 'node:assert/strict';
import { FilterPaperEngine } from '../../src/laya-filter-paper/engine.js';
import { sweep } from '../../src/restart/math.js';

function fixture() {
    let now = Date.parse('2026-10-21T05:28:35Z');
    const market = { slug: 'btc-updown-5m-1792560300', conditionId: 'condition',
        tokens: ['up', 'down'], open: now - 215000, end: now + 85000,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const config = { armNames: ['laya'], capital: 20, gasUsd: .05, dataAgeMs: 5000,
        drawdownStop: 10, shadowDrawdownStop: 2, deadline: Number.MAX_SAFE_INTEGER };
    const position = { market, snapshotId: 'snapshot', status: 'filled', holdings: 5, entryCost: 4.24704,
        fees: .04704, order: { index: 0, shares: 5, price: .87, snapshotPrice: .86, cost: 4.43959 },
        fill: { shares: 5, cash: -4.24704, fees: .04704, notional: 4.2 },
        submittedAt: now - 3000, executionAt: now - 2700, settleAt: now - 200,
        lastCapitalAt: now, capitalHours: 0 };
    const arm = { cash: 9, peak: 20, drawdown: 0, stopped: null, shadowStop: null,
        seen: {}, outcomes: {}, completed: [], position };
    const state = { arms: { laya: arm }, snapshots: [], markets: {}, errors: {}, frozenAt: null };
    const events = []; let saved;
    const store = { state, save() { saved = structuredClone(state); },
        event(type, detail) { this.save(); events.push({ type, ...structuredClone(detail) }); },
        error(stage, error) { state.errors[`${stage}:${error.message}`] = true; } };
    let bids = [{ price: .15, size: 10 }];
    const client = { books: async () => [{ bids: structuredClone(bids), timestamp: now, fetchedAt: now }],
        btc: { status: () => ({ ready: true }) }, payout: async () => [1, 0] };
    const books = { generation: 1, tokens: market.tokens, snapshot: () => [] };
    const engine = new FilterPaperEngine(config, store, client, books, {}, { clock: () => now });
    return { engine, config, arm, position, market, state, store, client, events,
        get now() { return now; }, get saved() { return saved; }, advance(ms) { now += ms; },
        bids(value) { bids = value; } };
}

test('risk trigger retains the public valuation evidence after recovery, redemption, and serialization', async () => {
    const f = fixture(); await f.engine.manageArm('laya', f.now);
    const trigger = structuredClone(f.arm.stopped.evidence), pilot = structuredClone(f.arm.shadowStop.evidence);
    const marked = sweep([{ price: .15, size: 10 }], 5, 0, 'SELL', f.market.fee);
    assert.equal(trigger.basis, 'liquidation_mark');
    assert.equal(trigger.cash, 9); assert.equal(trigger.equity, 9 + marked.cash);
    assert.equal(trigger.peak, 20); assert.equal(trigger.drawdown, 20 - trigger.equity);
    assert.equal(trigger.position.status, 'filled'); assert.equal(trigger.position.market, f.market.slug);
    assert.equal(trigger.position.snapshotId, 'snapshot'); assert.equal(trigger.position.holdings, 5);
    assert.equal(trigger.position.entryCost, 4.24704); assert.equal(trigger.position.mark, marked.cash);
    assert.equal(trigger.position.markSource, 'rest'); assert.equal(trigger.position.markFresh, true);
    assert.equal(trigger.position.markObservedAt, f.now); assert.equal(trigger.position.markReceivedAt, f.now);
    assert.equal(trigger.position.markBook.bestBid, .15); assert.equal(trigger.position.markBook.bidLevels, 1);
    assert.equal(trigger.position.markBook.bidDepthShares, 10); assert.equal(trigger.position.markBook.liquidatedShares, 5);
    assert.equal(trigger.position.markBook.unliquidatedShares, 0);
    assert.equal(trigger.position.markBook.liquidationFees, marked.fees);
    assert.match(trigger.position.markBook.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.saved.arms.laya.stopped.evidence, trigger);
    assert.deepEqual(f.events.find(row => row.type === 'risk_threshold').evidence, trigger);

    f.advance(5000); f.bids([{ price: .1, size: 10 }]); await f.engine.manageArm('laya', f.now);
    assert.ok(f.arm.maxDrawdownEvidence.drawdown > trigger.drawdown);
    assert.equal(f.arm.maxDrawdownEvidence.position.markBook.bestBid, .1);
    assert.deepEqual(f.arm.stopped.evidence, trigger); assert.deepEqual(f.arm.shadowStop.evidence, pilot);
    f.advance(5000); f.bids([{ price: .9, size: 10 }]); await f.engine.manageArm('laya', f.now);
    f.advance(90000); await f.engine.manageArm('laya', f.now);
    assert.equal(f.arm.position, null); assert.equal(f.arm.completed.length, 1);
    assert.ok(f.arm.completed[0].pnl > 0); assert.equal(f.arm.cash, 13.95);
    const reloaded = JSON.parse(JSON.stringify(f.saved));
    assert.deepEqual(reloaded.arms.laya.stopped.evidence, trigger);
    assert.deepEqual(reloaded.arms.laya.shadowStop.evidence, pilot);
    assert.equal(reloaded.arms.laya.maxDrawdownEvidence.position.markBook.bestBid, .1);
    assert.equal(f.events.filter(row => row.type === 'risk_threshold').length, 1);
});

test('empty and partial fresh bid depth remain distinguishable from missing or stale valuations', async () => {
    for (const bids of [[], [{ price: .8, size: 1 }]]) {
        const f = fixture(); f.bids(bids); await f.engine.manageArm('laya', f.now);
        const evidence = f.arm.stopped.evidence, book = evidence.position.markBook;
        assert.equal(book.bidLevels, bids.length); assert.equal(book.liquidatedShares, bids.length);
        assert.equal(book.unliquidatedShares, 5 - bids.length); assert.equal(book.bidDepthShares, bids.length);
        assert.equal(book.bestBid, bids.length ? .8 : null);
        assert.equal(evidence.position.markFresh, true);
        assert.equal(evidence.position.mark, sweep(bids, 5, 0, 'SELL', f.market.fee).cash);
    }
    for (const failure of ['missing', 'stale']) {
        const f = fixture();
        f.client.books = failure === 'missing' ? async () => { throw new Error('read_timeout'); }
            : async () => [{ bids: [], timestamp: f.now - 5001, fetchedAt: f.now }];
        await f.engine.manageArm('laya', f.now);
        assert.equal(f.arm.valuationKnown, false); assert.equal(f.arm.drawdown, 0);
        assert.equal(f.arm.stopped, null); assert.equal(f.arm.shadowStop, null);
        assert.equal(f.arm.maxDrawdownEvidence, undefined);
        assert.equal(f.events.filter(row => row.type === 'risk_threshold').length, 0);
    }
});

test('official settlement captures the redeemed market even after its position is removed', async () => {
    const f = fixture(); f.advance(90000); f.client.payout = async () => [0, 1];
    await f.engine.manageArm('laya', f.now);
    assert.equal(f.arm.position, null); assert.equal(f.arm.cash, 8.95);
    const evidence = f.arm.stopped.evidence;
    assert.equal(evidence.basis, 'official_settlement'); assert.equal(evidence.equity, 8.95);
    assert.equal(evidence.position.market, f.market.slug); assert.equal(evidence.position.mark, null);
    assert.deepEqual(evidence.settlement, { payout: [0, 1], redeemed: 0, pnl: -4.29704, gas: .05 });
    assert.deepEqual(f.saved.arms.laya.stopped.evidence, evidence);
    assert.equal(f.events.filter(row => row.type === 'risk_threshold').length, 1);
});

test('a pre-execution stop records the pending reservation without debiting cash', () => {
    const f = fixture(); Object.assign(f.position, { status: 'pending', holdings: 0, entryCost: 0,
        fees: 0, activeAt: f.now, snapshotObservedAt: f.now, validation: {} });
    delete f.position.fill;
    f.engine.executeCohort('pending-cohort', ['laya']);
    assert.equal(f.arm.position, null); assert.equal(f.arm.cash, 9);
    const evidence = f.arm.stopped.evidence;
    assert.equal(evidence.basis, 'pre_execution_cash'); assert.equal(evidence.position.status, 'pending');
    assert.equal(evidence.position.holdings, 0); assert.equal(evidence.position.matchedShares, null);
    assert.equal(evidence.position.mark, null); assert.equal(evidence.equity, 9);
    assert.deepEqual(f.saved.arms.laya.stopped.evidence, evidence);
});

test('pilot and research stops retain separate trigger evidence across later breaches', async () => {
    const f = fixture(); f.arm.cash = 17; await f.engine.manageArm('laya', f.now);
    const pilot = structuredClone(f.arm.shadowStop.evidence);
    assert.equal(f.arm.stopped, null); assert.equal(pilot.cash, 17);
    f.arm.cash = 9; f.advance(5000); await f.engine.manageArm('laya', f.now);
    assert.equal(f.arm.stopped.evidence.cash, 9);
    assert.deepEqual(f.arm.shadowStop.evidence, pilot);
    assert.ok(f.arm.stopped.evidence.at > pilot.at);
    assert.deepEqual(f.saved.arms.laya.shadowStop.evidence, pilot);
    assert.equal(f.events.filter(row => row.type === 'risk_threshold').length, 2);
});

test('matched inventory is debited once before recording the filled liquidation valuation', async () => {
    const f = fixture(); f.arm.cash = 13.24704;
    Object.assign(f.position, { status: 'matched', holdings: 0, entryCost: 0, fees: 0, settleAt: f.now + 2500 });
    await f.engine.manageArm('laya', f.now);
    assert.equal(f.arm.cash, 13.24704); assert.equal(f.arm.stopped, null);
    assert.equal(f.arm.maxDrawdownEvidence, undefined);
    f.advance(2500); await f.engine.manageArm('laya', f.now);
    const evidence = structuredClone(f.arm.stopped.evidence);
    assert.equal(evidence.cash, 9); assert.equal(evidence.position.status, 'filled');
    assert.equal(evidence.position.matchedCost, 4.24704); assert.equal(evidence.position.matchedShares, 5);
    assert.equal(evidence.position.entryCost, evidence.position.matchedCost);
    await f.engine.manageArm('laya', f.now);
    assert.equal(f.arm.cash, 9); assert.deepEqual(f.arm.stopped.evidence, evidence);
});

test('existing persistent stops without evidence are preserved without invented historical details', async () => {
    const f = fixture(); f.arm.position = null;
    f.arm.stopped = { at: f.now - 10000, reason: 'research_drawdown_limit' };
    f.arm.shadowStop = { at: f.now - 20000, drawdown: 3 };
    const stop = structuredClone(f.arm.stopped), pilot = structuredClone(f.arm.shadowStop);
    await f.engine.manageArm('laya', f.now);
    assert.deepEqual(f.arm.stopped, stop); assert.deepEqual(f.arm.shadowStop, pilot);
    assert.equal(f.events.length, 0);
});
