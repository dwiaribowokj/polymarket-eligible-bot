import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinanceLeadFeed } from '../../scripts/strategy-candidates-paper/binance-feed.mjs';
import {
    ARM_DEFS,
    buildMarketContext,
    evaluateArm,
    smartMakerQuote,
} from '../../scripts/strategy-candidates-paper/strategies.mjs';
import { CandidatePaperStore } from '../../scripts/strategy-candidates-paper/store.mjs';
import { StrategyCandidatesEngine } from '../../scripts/strategy-candidates-paper/runner.mjs';

const FEE = { rate: 0.05, exponent: 1, takerOnly: true };

function makeMarket(open = 1795500000000) {
    return {
        slug: `btc-updown-5m-${open / 1000}`,
        conditionId: '0x' + 'a'.repeat(64),
        open,
        end: open + 300000,
        tokens: ['tok-up', 'tok-dn'],
        fee: FEE,
        minimum: 5,
        accepting: true,
        negRisk: false,
    };
}

function makeBooks({ upBid, upAsk, dnBid, dnAsk, upBidSz = 20, upAskSz = 20, dnBidSz = 20, dnAskSz = 20 }) {
    return [
        {
            tokenId: 'tok-up',
            bids: upBid !== null ? [{ price: upBid, size: upBidSz }] : [],
            asks: upAsk !== null ? [{ price: upAsk, size: upAskSz }] : [],
        },
        {
            tokenId: 'tok-dn',
            bids: dnBid !== null ? [{ price: dnBid, size: dnBidSz }] : [],
            asks: dnAsk !== null ? [{ price: dnAsk, size: dnAskSz }] : [],
        },
    ];
}

function makeSpotHistory(now, stepUsd = 5) {
    const pts = [];
    for (let i = 180; i >= 0; i--) {
        const sign = i % 2 === 0 ? 1 : -1;
        pts.push({ at: now - i * 1000, value: 62000 + sign * (stepUsd / 2) });
    }
    return pts;
}

function arm(name) {
    return ARM_DEFS.find(a => a.name === name);
}

test('BinanceLeadFeed computes causal return and adverse move for UP and DOWN', () => {
    let now = 1_700_000_000_000;
    const feed = new BinanceLeadFeed({ clock: () => now });
    feed.ingest({ at: now - 5000, bid: 60000, ask: 60000, mid: 60000 });
    feed.ingest({ at: now - 3000, bid: 60000, ask: 60000, mid: 60000 });
    feed.ingest({ at: now, bid: 59952, ask: 59952, mid: 59952 }); // -8.0 bps

    const ret5 = feed.returnBps(5000, now);
    assert.ok(ret5 < -7.9 && ret5 > -8.1);
    assert.equal(feed.adverseMove(0, 3000, 7.0, now), true);  // UP hit by -8 bps drop
    assert.equal(feed.adverseMove(1, 3000, 7.0, now), false); // DOWN benefits from drop
    assert.equal(feed.status(now).ready, true);

    now += 5000; // stale
    assert.equal(feed.latest(now), null);
    assert.equal(feed.adverseMove(0, 3000, 7.0, now), false);
});

test('smartMakerQuote penny-jumps on >=2c spread and filters thick 1c queues', () => {
    const penny = smartMakerQuote({ bestBid: 0.74, bestAsk: 0.76, bidSize1: 500 }, 0.82);
    assert.equal(penny.ok, true);
    assert.equal(penny.price, 0.75);
    assert.equal(penny.queueAhead, 0);
    assert.equal(penny.mode, 'penny_jump');

    const thin = smartMakerQuote({ bestBid: 0.75, bestAsk: 0.76, bidSize1: 45 }, 0.82);
    assert.equal(thin.ok, true);
    assert.equal(thin.price, 0.75);
    assert.equal(thin.queueAhead, 45);
    assert.equal(thin.mode, 'join_thin_bid');

    const thick = smartMakerQuote({ bestBid: 0.75, bestAsk: 0.76, bidSize1: 400 }, 0.82);
    assert.equal(thick.ok, false);
    assert.equal(thick.reason, 'maker_queue_too_thick');
});

test('v2 strategy arms isolate lead-veto, slot-90, imbalance, and smart maker rules', () => {
    const market = makeMarket();
    const now = market.end - 90000;
    const feed = new BinanceLeadFeed({ clock: () => now });
    feed.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
    feed.ingest({ at: now, bid: 62006, ask: 62006, mid: 62006 }); // +0.97 bps (favorable to UP)

    // Slot 90: UP favorite 0.74/0.76 (2c spread -> smart maker penny-jumps to 0.75, queueAhead=0)
    const ctx90 = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.74, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.26, upBidSz: 300, upAskSz: 50 }),
        btcPoints: makeSpotHistory(now, 5),
        binance: feed,
        seconds: 90,
        now,
    });
    assert.equal(evaluateArm(arm('control_fav_taker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_leadveto_taker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_60_imb_lead_taker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_only_lead_taker'), ctx90).action, 'BUY_UP');
    const mk = evaluateArm(arm('fav_smart_maker'), ctx90);
    assert.equal(mk.action, 'BUY_UP');
    assert.equal(mk.price, 0.75);
    assert.equal(mk.queueAhead, 0);
    assert.equal(evaluateArm(arm('late_lock_60_smart_maker'), ctx90).reason, 'slot_not_enabled');

    // Ask-heavy book vetoes ONLY fav_90_60_imb_lead_taker
    const ctxAskHeavy = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 10, upAskSz: 100 }),
        btcPoints: makeSpotHistory(now, 5),
        binance: feed,
        seconds: 90,
        now,
    });
    assert.equal(evaluateArm(arm('fav_leadveto_taker'), ctxAskHeavy).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_60_imb_lead_taker'), ctxAskHeavy).reason, 'ask_heavy_book_veto');

    // Binance lead-veto (-2.5 bps against UP) vetoes lead-protected arms, NOT control_fav_taker
    feed.ingest({ at: now + 100, bid: 61984, ask: 61984, mid: 61984 });
    const ctxLeadVeto = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 50, upAskSz: 20 }),
        btcPoints: makeSpotHistory(now + 100, 5),
        binance: feed,
        seconds: 90,
        now: now + 100,
    });
    assert.equal(evaluateArm(arm('control_fav_taker'), ctxLeadVeto).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_leadveto_taker'), ctxLeadVeto).reason, 'binance_lead_veto');
    assert.equal(evaluateArm(arm('fav_90_only_lead_taker'), ctxLeadVeto).reason, 'binance_lead_veto');
    assert.equal(evaluateArm(arm('fav_smart_maker'), ctxLeadVeto).reason, 'binance_lead_veto');

    // Slot 30: control & fav_leadveto allowed, fav_90_60_imb_lead & fav_90_only skipped
    const now30 = market.end - 30000;
    const feed30 = new BinanceLeadFeed({ clock: () => now30 });
    feed30.ingest({ at: now30 - 5000, bid: 62000, ask: 62000, mid: 62000 });
    feed30.ingest({ at: now30, bid: 62002, ask: 62002, mid: 62002 });
    const ctx30 = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25 }),
        btcPoints: makeSpotHistory(now30, 5),
        binance: feed30,
        seconds: 30,
        now: now30,
    });
    assert.equal(evaluateArm(arm('control_fav_taker'), ctx30).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_leadveto_taker'), ctx30).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_60_imb_lead_taker'), ctx30).reason, 'slot_not_enabled');
    assert.equal(evaluateArm(arm('fav_90_only_lead_taker'), ctx30).reason, 'slot_not_enabled');
});

test('StrategyCandidatesEngine fills smart penny-jump maker immediately on SELL trade and settles with 0% fee', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-v2-'));
    try {
        const market = makeMarket(1795500000000);
        let now = market.end - 90000;
        let currentBooks = makeBooks({ upBid: 0.74, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.26, upBidSz: 500, upAskSz: 50 });
        let tradeQueue = [];
        let payoutResult = null;

        const binance = new BinanceLeadFeed({ clock: () => now });
        binance.start = () => {};
        binance.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
        binance.ingest({ at: now - 2000, bid: 62001, ask: 62001, mid: 62001 });
        binance.ingest({ at: now, bid: 62002, ask: 62002, mid: 62002 });

        const store = new CandidatePaperStore({ directory: dir, startAt: now });
        const engine = new StrategyCandidatesEngine({
            client: {
                btc: { spot: makeSpotHistory(now, 5) },
                startBtcFeed() {},
                btcStatus() { return { ready: true }; },
                async market() { return market; },
                async payout() { return payoutResult; },
                close() {},
            },
            books: {
                watch() {},
                snapshot() { return currentBooks; },
                status() { return { connected: true }; },
                close() {},
            },
            trades: {
                ready: true,
                watch() {},
                reconnect() {},
                drain() { return tradeQueue.splice(0); },
                close() {},
            },
            binance,
            store,
            clock: () => now,
        });

        await engine.tick();
        assert.equal(engine.pendingTakers.length, 4); // 4 taker arms enter at slot 90
        assert.equal(engine.openMakers.length, 1);    // fav_smart_maker penny-jumps @ 0.75 with queueAhead=0
        assert.equal(engine.openMakers[0].price, 0.75);
        assert.equal(engine.openMakers[0].queueAhead, 0);

        // Advance 300ms -> takers fill at 0.76 + taker fee
        now += 300;
        await engine.tick();
        assert.equal(engine.pendingTakers.length, 0);

        // Mild -3 bps Binance wiggle (below 7 bps cancel threshold) should NOT cancel our maker!
        now += 1500;
        binance.ingest({ at: now, bid: 61982, ask: 61982, mid: 61982 });
        await engine.tick();
        assert.equal(engine.openMakers.length, 1);

        // Real SELL trade at 0.75 fills our 5 shares immediately (queueAhead=0)
        now += 500;
        tradeQueue.push({ tokenId: 'tok-up', side: 'SELL', price: 0.75, size: 5, at: now });
        await engine.tick();
        assert.equal(engine.openMakers.length, 0);

        // Settle UP ([1, 0])
        now = market.end + 10000;
        payoutResult = [1, 0];
        await engine.tick();

        const rep = store.report({ now });
        assert.equal(rep.arms.fav_smart_maker.wins, 1);
        assert.equal(rep.arms.fav_smart_maker.fees, 0);
        assert.equal(rep.arms.fav_smart_maker.netPnl, 1.2); // 5*(1-0.75) - 0.05 = 1.20
        assert.ok(rep.arms.fav_smart_maker.netPnl > rep.arms.control_fav_taker.netPnl);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Maker cancels on >=7 bps Binance adverse move', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-v2-cancel-'));
    try {
        const market = makeMarket(1795500300000);
        let now = market.end - 60000;
        const binance = new BinanceLeadFeed({ clock: () => now });
        binance.start = () => {};
        binance.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
        binance.ingest({ at: now - 2000, bid: 62001, ask: 62001, mid: 62001 });
        binance.ingest({ at: now, bid: 62002, ask: 62002, mid: 62002 });

        const store = new CandidatePaperStore({ directory: dir, startAt: now });
        const engine = new StrategyCandidatesEngine({
            client: {
                btc: { spot: makeSpotHistory(now, 5) },
                startBtcFeed() {},
                btcStatus() { return { ready: true }; },
                async market() { return market; },
                async payout() { return null; },
                close() {},
            },
            books: {
                watch() {},
                snapshot() { return makeBooks({ upBid: 0.93, upAsk: 0.95, dnBid: 0.05, dnAsk: 0.07, upBidSz: 40, upAskSz: 40 }); },
                status() { return { connected: true }; },
                close() {},
            },
            trades: { ready: true, watch() {}, reconnect() {}, drain() { return []; }, close() {} },
            binance,
            store,
            clock: () => now,
        });

        await engine.tick();
        assert.equal(engine.openMakers.length, 1);
        assert.equal(engine.openMakers[0].arm, 'late_lock_60_smart_maker');
        assert.equal(engine.openMakers[0].price, 0.94); // penny-jumped 0.93 -> 0.94

        // 2s later: sharp -8 bps Binance dump against UP -> triggers 7bps adverse cancel!
        now += 2000;
        binance.ingest({ at: now, bid: 61950, ask: 61950, mid: 61950 });
        await engine.tick();
        assert.equal(engine.openMakers.length, 0);

        const rep = store.report({ now });
        assert.equal(rep.arms.late_lock_60_smart_maker.adverseCancels, 1);
        assert.equal(rep.arms.late_lock_60_smart_maker.filled, 0);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
