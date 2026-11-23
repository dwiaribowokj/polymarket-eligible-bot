import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinanceLeadFeed } from '../../scripts/strategy-candidates-paper/binance-feed.mjs';
import {
    ARM_DEFS,
    buildMarketContext,
    computeSigma,
    evaluateArm,
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
    feed.ingest({ at: now, bid: 59985, ask: 59985, mid: 59985 }); // -2.5 bps

    const ret5 = feed.returnBps(5000, now);
    assert.ok(ret5 < -2.4 && ret5 > -2.6);
    assert.equal(feed.adverseMove(0, 3000, 2.0, now), true);  // UP hit by -2.5 bps drop
    assert.equal(feed.adverseMove(1, 3000, 2.0, now), false); // DOWN benefits from drop
    assert.equal(feed.status(now).ready, true);

    now += 5000; // stale
    assert.equal(feed.latest(now), null);
    assert.equal(feed.adverseMove(0, 3000, 2.0, now), false);
});

test('Strategy arms respect slot, cost cap, volatility, imbalance, and Binance lead-veto', () => {
    const market = makeMarket();
    const now = market.end - 90000;
    const feed = new BinanceLeadFeed({ clock: () => now });
    feed.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
    feed.ingest({ at: now, bid: 62006, ask: 62006, mid: 62006 }); // +0.97 bps (favorable to UP)

    // Slot 90: UP favorite 0.75/0.76, high vol (sigma ~ 5.0), bid-heavy book
    const ctx90 = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 50, upAskSz: 20 }),
        btcPoints: makeSpotHistory(now, 5),
        binance: feed,
        seconds: 90,
        now,
    });
    assert.ok(ctx90.sigma >= 4.0);
    assert.equal(evaluateArm(arm('control_fav_taker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_filtered_taker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_filtered_maker'), ctx90).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('fav_90_filtered_maker'), ctx90).price, 0.75);
    assert.equal(evaluateArm(arm('contrarian_dog_60_taker'), ctx90).reason, 'slot_not_enabled');

    // Ask-heavy book veto
    const ctxAskHeavy = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 10, upAskSz: 100 }),
        btcPoints: makeSpotHistory(now, 5),
        binance: feed,
        seconds: 90,
        now,
    });
    assert.equal(evaluateArm(arm('fav_90_filtered_taker'), ctxAskHeavy).reason, 'ask_heavy_book_veto');
    assert.equal(evaluateArm(arm('fav_90_filtered_maker'), ctxAskHeavy).reason, 'ask_heavy_book_veto');

    // Low volatility veto
    const ctxLowVol = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 50, upAskSz: 20 }),
        btcPoints: makeSpotHistory(now, 1), // sigma ~ 1.0 < 3.39
        binance: feed,
        seconds: 90,
        now,
    });
    assert.equal(evaluateArm(arm('fav_90_filtered_taker'), ctxLowVol).reason, 'low_volatility_veto');

    // Binance lead-veto when Binance drops -2 bps against UP
    feed.ingest({ at: now + 100, bid: 61985, ask: 61985, mid: 61985 });
    const ctxLeadVeto = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 50, upAskSz: 20 }),
        btcPoints: makeSpotHistory(now + 100, 5),
        binance: feed,
        seconds: 90,
        now: now + 100,
    });
    assert.equal(evaluateArm(arm('fav_90_filtered_taker'), ctxLeadVeto).reason, 'binance_lead_veto');
    assert.equal(evaluateArm(arm('fav_90_filtered_maker'), ctxLeadVeto).reason, 'binance_lead_veto');

    // Slot 60: contrarian underdog triggers on DOWN 0.25/0.26
    const now60 = market.end - 60000;
    const feed60 = new BinanceLeadFeed({ clock: () => now60 });
    feed60.ingest({ at: now60 - 5000, bid: 62000, ask: 62000, mid: 62000 });
    feed60.ingest({ at: now60, bid: 62002, ask: 62002, mid: 62002 });
    const ctx60 = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.74, upAsk: 0.75, dnBid: 0.25, dnAsk: 0.26 }),
        btcPoints: makeSpotHistory(now60, 5),
        binance: feed60,
        seconds: 60,
        now: now60,
    });
    assert.equal(evaluateArm(arm('contrarian_dog_60_taker'), ctx60).action, 'BUY_DOWN');
    assert.equal(evaluateArm(arm('contrarian_dog_60_maker'), ctx60).action, 'BUY_DOWN');
    assert.equal(evaluateArm(arm('contrarian_dog_60_maker'), ctx60).price, 0.25);

    // Slot 60: extreme favorite 0.94/0.95 triggers late_lock_60_maker
    const ctxLock = buildMarketContext({
        market,
        books: makeBooks({ upBid: 0.94, upAsk: 0.95, dnBid: 0.05, dnAsk: 0.06 }),
        btcPoints: makeSpotHistory(now60, 5),
        binance: feed60,
        seconds: 60,
        now: now60,
    });
    assert.equal(evaluateArm(arm('late_lock_60_maker'), ctxLock).action, 'BUY_UP');
    assert.equal(evaluateArm(arm('late_lock_60_maker'), ctxLock).price, 0.94);
});

test('StrategyCandidatesEngine executes taker sweep, maker queue fill, Binance adverse cancel, and official CTF settlement', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-paper-'));
    try {
        const market = makeMarket(1795500000000);
        let now = market.end - 60000;
        let currentBooks = makeBooks({ upBid: 0.74, upAsk: 0.75, dnBid: 0.25, dnAsk: 0.26, dnBidSz: 10 });
        let tradeQueue = [];
        let payoutResult = null;

        const fakeClient = {
            btc: { spot: makeSpotHistory(now, 5) },
            startBtcFeed() {},
            btcStatus() { return { ready: true }; },
            async market() { return market; },
            async payout() { return payoutResult; },
            close() {},
        };
        const fakeBooks = {
            watch() {},
            snapshot() { return currentBooks; },
            status() { return { connected: true }; },
            close() {},
        };
        const fakeTrades = {
            ready: true,
            watch() {},
            reconnect() {},
            drain() { return tradeQueue.splice(0); },
            close() {},
        };
        const binance = new BinanceLeadFeed({ clock: () => now });
        binance.start = () => {};
        binance.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
        binance.ingest({ at: now, bid: 62000, ask: 62000, mid: 62000 });

        const store = new CandidatePaperStore({ directory: dir, startAt: now });
        const engine = new StrategyCandidatesEngine({
            client: fakeClient,
            books: fakeBooks,
            trades: fakeTrades,
            binance,
            store,
            clock: () => now,
        });

        // Tick at slot 60s: triggers control_fav_taker (UP), contrarian_dog_60_taker (DOWN), contrarian_dog_60_maker (DOWN @ 0.25, queueAhead 10)
        await engine.tick();
        assert.equal(engine.pendingTakers.length, 2);
        assert.equal(engine.openMakers.length, 1);

        // Advance 300ms past latencyMs -> takers sweep the book
        now += 300;
        await engine.tick();
        assert.equal(engine.pendingTakers.length, 0);

        // Feed real SELL trades on DOWN @ 0.25: 10 shares clear queueAhead, 5 shares fill our maker order!
        now += 2000;
        tradeQueue.push({ tokenId: 'tok-dn', side: 'SELL', price: 0.25, size: 15, at: now });
        await engine.tick();
        assert.equal(engine.openMakers.length, 0);

        // Market closes and settles DOWN ([0, 1])!
        now = market.end + 10000;
        payoutResult = [0, 1];
        await engine.tick();

        const rep = store.report({ now });
        assert.equal(rep.liveTransactions, 0);
        // control_fav_taker bought UP -> lost
        assert.equal(rep.arms.control_fav_taker.losses, 1);
        assert.ok(rep.arms.control_fav_taker.netPnl < -3.7);
        // contrarian_dog_60_taker bought DOWN @ 0.26 + taker fee + 0.05 gas -> won ~3.60
        assert.equal(rep.arms.contrarian_dog_60_taker.wins, 1);
        assert.ok(rep.arms.contrarian_dog_60_taker.fees > 0);
        // contrarian_dog_60_maker bought DOWN @ 0.25 with 0 fee + 0.05 gas -> won 5*(1-0.25)-0.05 = 3.70!
        assert.equal(rep.arms.contrarian_dog_60_maker.wins, 1);
        assert.equal(rep.arms.contrarian_dog_60_maker.fees, 0);
        assert.equal(rep.arms.contrarian_dog_60_maker.netPnl, 3.7);
        assert.ok(rep.arms.contrarian_dog_60_maker.netPnl > rep.arms.contrarian_dog_60_taker.netPnl);

        // Verify SQLite restart durability
        store.close();
        const reloaded = new CandidatePaperStore({ directory: dir });
        const rep2 = reloaded.report({ now });
        assert.equal(rep2.arms.contrarian_dog_60_maker.netPnl, 3.7);
        assert.equal(rep2.arms.control_fav_taker.losses, 1);
        reloaded.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('Maker order cancels immediately on Binance adverse move and retains zero fee', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cand-cancel-'));
    try {
        const market = makeMarket(1795500300000);
        let now = market.end - 90000;
        const binance = new BinanceLeadFeed({ clock: () => now });
        binance.start = () => {};
        binance.ingest({ at: now - 5000, bid: 62000, ask: 62000, mid: 62000 });
        binance.ingest({ at: now, bid: 62005, ask: 62005, mid: 62005 });

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
                snapshot() { return makeBooks({ upBid: 0.75, upAsk: 0.76, dnBid: 0.24, dnAsk: 0.25, upBidSz: 40, upAskSz: 15 }); },
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
        assert.equal(engine.openMakers[0].arm, 'fav_90_filtered_maker');

        // 3.5 seconds later, Binance dumps -2.5 bps against UP -> adverse cancel!
        now += 3500;
        binance.ingest({ at: now, bid: 61989, ask: 61989, mid: 61989 });
        await engine.tick();
        assert.equal(engine.openMakers.length, 0);

        const rep = store.report({ now });
        assert.equal(rep.arms.fav_90_filtered_maker.adverseCancels, 1);
        assert.equal(rep.arms.fav_90_filtered_maker.filled, 0);
        assert.equal(rep.arms.fav_90_filtered_maker.gas, 0);
        store.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
