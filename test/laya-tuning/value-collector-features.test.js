import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readEarlyPaperBooks } from '../../src/premarket-paper/early-book.js';
import { fee, round } from '../../src/restart/math.js';
import { buildValueObservation, verifyValueObservation } from '../../src/value-collector/features.js';

const OPEN = Date.parse('2026-11-14T05:00:00Z');
const BASE = 83000.123456789;

async function fixture({ elapsed = 270000, spotPrice = () => BASE, twapPrice = BASE, asks, sourceAgeMs = 100 } = {}) {
    const at = OPEN + elapsed;
    const market = { slug: `btc-updown-5m-${OPEN / 1000}`, open: OPEN, end: OPEN + 300000,
        conditionId: 'condition', tokens: ['up', 'down'], minimum: 5,
        ticks: [.01, .01], tick: .01, negRisk: false, accepting: true,
        fee: { rate: .07, exponent: 1, takerOnly: true }, reference: { source: 'chainlink_twap_60s',
            open: OPEN, end: OPEN + 300000, observedAt: OPEN, receivedAt: OPEN + 100, value: BASE } };
    const btc = { spot: [], twap: { at, receivedAt: at, value: twapPrice },
        openings: new Map([[OPEN, { at: OPEN, receivedAt: OPEN + 100, value: BASE }]]) };
    for (let time = at - 245000; time <= at; time += 1000)
        btc.spot.push({ at: time, receivedAt: time, value: spotPrice(time) });
    const pair = await readEarlyPaperBooks(market, { metadataVerifiedAt: at, clock: () => at,
        fetchImpl: async input => {
            const url = new URL(input), token = url.searchParams.get('token_id');
            const body = url.pathname === '/tick-size' ? { minimum_tick_size: .01 }
                : { market: market.conditionId, asset_id: token, min_order_size: '5', tick_size: '.01',
                    neg_risk: false, timestamp: String(at - sourceAgeMs), hash: 'a'.repeat(40),
                    bids: [{ price: '.19', size: '10' }],
                    asks: asks?.[token] ?? [{ price: '.20', size: '2' }, { price: '.21', size: '4' },
                        { price: '.22', size: '20' }] };
            return new Response(JSON.stringify(body), { headers: { Date: new Date(at).toUTCString(), 'CF-Cache-Status': 'DYNAMIC' } });
        } });
    const config = { dataAgeMs: 5000, historyMs: 180000, maxGapMs: 5000,
        maxFeedDifferenceUsd: 3, quoteShares: [5, 10, 20], gasUsd: .05 };
    return { market, btc, pair, at, scheduledAt: at - 100, config };
}

test('collector keeps both complete books outside the old price band and quotes actual displayed depth', async () => {
    const f = await fixture(), row = buildValueObservation(f);
    assert.equal(row.quality.status, 'ready');
    assert.deepEqual(row.quality.reasons, []);
    assert.deepEqual(row.sides.map(side => side.side), ['UP', 'DOWN']);
    for (const side of row.sides) {
        assert.equal(side.book.asks[0].price, .2);
        assert.deepEqual(side.quotes.map(quote => quote.requestedShares), [5, 10, 20]);
        const quote = side.quotes[0], expectedFee = fee(2, .2, f.market.fee) + fee(3, .21, f.market.fee);
        assert.equal(quote.status, 'quoted');
        assert.deepEqual(quote.depthTake, [{ price: .2, shares: 2 }, { price: .21, shares: 3 }]);
        assert.equal(quote.notionalUsd, 1.03);
        assert.equal(quote.feeUsd, round(expectedFee));
        assert.equal(quote.allInCostUsd, round(1.03 + expectedFee + .05));
        assert.equal(quote.costPerShareUsd, quote.allInCostUsd / 5);
        assert.equal(quote.marginalAskUsd, .21);
        assert.match(quote.basis, /not_future_execution/);
        assert.equal(quote.filled, undefined);
    }
    assert.deepEqual(row.bookEvidence, f.pair.evidence);
    assert.equal(row.bookEvidence.books[0].receivedAt, f.at);
    assert.equal(row.sides[0].sourceAgeMs, 100);
    assert.equal(row.sides[0].sourceTimestampFresh, true);
    assert.equal(row.spot.points.length, 246);
    assert.equal(row.spot.latest.value, BASE);
    assert.equal(row.opening.reference.value, BASE);
    assert.equal(row.payout, undefined);
    assert.equal(row.label, undefined);
    assert.equal(row.modelProbability, undefined);
});

test('empty and insufficient books remain observable without invented complete quote costs', async () => {
    const f = await fixture({ asks: { up: [{ price: '.99', size: '6' }], down: [] } });
    const row = buildValueObservation(f);
    assert.equal(row.quality.status, 'ready');
    assert.equal(row.sides[0].quotes[0].status, 'quoted');
    assert.equal(row.sides[0].quotes[1].status, 'insufficient_depth');
    assert.equal(row.sides[0].quotes[1].quotedShares, null);
    assert.equal(row.sides[0].quotes[1].allInCostUsd, null);
    for (const quote of row.sides[1].quotes) {
        assert.equal(quote.status, 'insufficient_depth');
        assert.equal(quote.notionalUsd, null);
        assert.equal(quote.availableShares, 0);
        assert.deepEqual(quote.depthTake, []);
    }
});

test('all book levels are retained rather than truncating to top five', async () => {
    const levels = Array.from({ length: 12 }, (_, index) => ({ price: (.2 + index / 100).toFixed(2), size: '2' }));
    const row = buildValueObservation(await fixture({ asks: { up: levels } }));
    assert.equal(row.sides[0].book.asks.length, 12);
    assert.equal(row.sides[0].quotes[2].status, 'quoted');
    assert.equal(row.sides[0].quotes[2].depthTake.length, 10);
});

test('closing integral and remaining threshold use exact causal spot values and latest spot cutoff', async () => {
    const f = await fixture({ spotPrice: time => time < OPEN + 255000 ? BASE + 2 : BASE + 4,
        twapPrice: BASE + 2.5 });
    f.btc.twap.at -= 1000; f.btc.twap.receivedAt -= 1000;
    const row = buildValueObservation(f), close = row.closingTwap;
    const exactIntegral = f.btc.spot.filter(point => point.at >= OPEN + 240000 && point.at < f.at)
        .reduce((sum, point) => sum + point.value, 0);
    assert.equal(close.status, 'observed');
    assert.equal(close.asOf, f.at);
    assert.equal(close.knownSeconds, 30);
    assert.equal(close.remainingSeconds, 30);
    assert.equal(close.observedIntegralUsdSeconds, exactIntegral);
    assert.equal(close.requiredRemainingAverageUsd, (BASE * 60 - exactIntegral) / 30);
    assert.equal(close.observedMeanUsd, exactIntegral / 30);
    assert.equal(close.upComparator, '>=');
    assert.equal(close.tieRule, 'UP');
    assert.equal(row.rollingTwap.windowEnd, f.at - 1000);
    assert.equal(row.rollingTwap.cutoffBasis, 'causal_twap_source_time');
});

test('before closing window is normal with no invented observed integral or threshold', async () => {
    const row = buildValueObservation(await fixture({ elapsed: 210000 }));
    assert.equal(row.quality.status, 'ready');
    assert.equal(row.closingTwap.status, 'before_window');
    assert.equal(row.closingTwap.knownSeconds, 0);
    assert.equal(row.closingTwap.remainingSeconds, 60);
    assert.equal(row.closingTwap.observedIntegralUsdSeconds, null);
    assert.equal(row.closingTwap.requiredRemainingAverageUsd, null);
});

test('future source, late receipt and contradictory clocks never enter frozen causal price features', async () => {
    const f = await fixture();
    f.btc.spot.push({ at: f.at + 1, receivedAt: f.at + 1, value: 999001 });
    f.btc.spot.push({ at: f.at - 500, receivedAt: f.at + 1, value: 999002 });
    f.btc.spot.push({ at: f.at - 100, receivedAt: f.at - 101, value: 999003 });
    const row = buildValueObservation(f);
    assert.deepEqual(row.spot.excluded, { invalid: 0, future_source: 1, late_receipt: 1, clock_conflict: 1 });
    assert.equal(row.spot.points.length, 246);
    assert.equal(row.spot.latest.value, BASE);
    assert.equal(row.quality.status, 'partial');
    for (const secretFutureValue of [999001, 999002, 999003]) assert.equal(JSON.stringify(row).includes(secretFutureValue), false);
    assert.ok(row.spot.points.every(point => point.at <= f.at && point.receivedAt <= f.at && point.receivedAt >= point.at));
});

test('history gap and source conflicts make integrals unavailable instead of bridging missing prices', async () => {
    const gap = await fixture();
    gap.btc.spot = gap.btc.spot.filter(point => point.at <= OPEN + 250000 || point.at >= OPEN + 257000);
    const gapped = buildValueObservation(gap);
    assert.equal(gapped.spot.status, 'history_gap');
    assert.equal(gapped.closingTwap.status, 'history_gap');
    assert.equal(gapped.closingTwap.observedIntegralUsdSeconds, null);
    const conflict = await fixture();
    conflict.btc.spot.push({ at: OPEN + 240000, receivedAt: OPEN + 240001, value: BASE + 1 });
    const conflicted = buildValueObservation(conflict);
    assert.equal(conflicted.closingTwap.status, 'history_conflict');
    assert.equal(conflicted.spot.status, 'history_conflict');
    assert.equal(conflicted.closingTwap.requiredRemainingAverageUsd, null);
});

test('missing history, stale source and invalid opening remain explicit and cannot produce ready data', async () => {
    const missing = await fixture(); missing.btc.spot = missing.btc.spot.slice(-60);
    const warmup = buildValueObservation(missing);
    assert.equal(warmup.spot.status, 'history_missing');
    assert.equal(warmup.quality.status, 'partial');
    const stale = await fixture(); stale.btc.spot = stale.btc.spot.filter(point => point.at <= stale.at - 6000);
    assert.equal(buildValueObservation(stale).spot.status, 'history_stale');
    const lateReference = await fixture(); lateReference.market.reference.receivedAt = OPEN + 5001;
    assert.equal(buildValueObservation(lateReference).opening.status, 'reference_unverified');
    const conflictingReference = await fixture(); conflictingReference.market.reference.value += 1;
    assert.equal(buildValueObservation(conflictingReference).opening.status, 'reference_conflict');
    const missingReference = await fixture(); missingReference.btc.openings.clear();
    assert.equal(buildValueObservation(missingReference).closingTwap.status, 'reference_missing');
});

test('noncausal reference and TWAP values remain null without leaking their values', async () => {
    const f = await fixture();
    f.btc.twap = { at: f.at - 1000, receivedAt: f.at + 1, value: 999004 };
    f.market.reference.value = 999005; f.market.reference.receivedAt = f.at + 1;
    const row = buildValueObservation(f);
    assert.equal(row.twap.status, 'twap_late_receipt');
    assert.equal(row.twap.point, null);
    assert.equal(row.opening.status, 'reference_noncausal');
    assert.equal(row.opening.reference, null);
    assert.equal(JSON.stringify(row).includes('999004'), false);
    assert.equal(JSON.stringify(row).includes('999005'), false);
});

test('rolling TWAP consistency uses an observed interval at the TWAP cutoff and enforces frozen tolerance', async () => {
    const mismatched = buildValueObservation(await fixture({ twapPrice: BASE + 4 }));
    assert.equal(mismatched.rollingTwap.status, 'twap_source_mismatch');
    assert.equal(mismatched.quality.status, 'partial');
    assert.ok(Math.abs(mismatched.rollingTwap.differenceUsd - 4) < 1e-8);
    const ahead = await fixture(); ahead.btc.spot.pop();
    const uncovered = buildValueObservation(ahead);
    assert.equal(uncovered.rollingTwap.status, 'history_missing');
    assert.equal(uncovered.rollingTwap.observedMeanUsd, null);
    assert.equal(uncovered.closingTwap.asOf, ahead.at - 1000);
});

test('unavailable, expired, identity-changed or tampered books preserve independent spot observations', async () => {
    for (const mutate of [f => { f.pair = null; }, f => { f.pair.books[0].asks[0].size += 100; },
        f => { f.market.fee.rate = .08; }, f => { f.at += 5001; }]) {
        const f = await fixture(); mutate(f);
        const row = buildValueObservation(f);
        assert.notEqual(row.bookStatus, 'verified');
        assert.equal(row.quality.status, 'partial');
        assert.equal(row.sides[0].book, null);
        assert.equal(row.sides[1].quotes, null);
        assert.equal(row.bookEvidence, null);
        assert.equal(row.spot.points.length, 246);
    }
});

test('old exchange timestamp remains labeled in a freshly verified complete REST book', async () => {
    const f = await fixture({ sourceAgeMs: 120000 }), row = buildValueObservation(f);
    assert.equal(row.quality.status, 'ready');
    assert.equal(row.bookStatus, 'verified');
    for (const side of row.sides) {
        assert.equal(side.sourceAgeMs, 120000);
        assert.equal(side.sourceTimestampFresh, false);
        assert.equal(side.book.timestamp, f.at - 120000);
        assert.equal(side.book.fetchedAt, f.at);
        assert.equal(side.quotes[0].status, 'quoted');
    }
    assert.equal(row.bookEvidence.books[0].sourceAgeMs, 120000);
    assert.equal(row.bookEvidence.books[0].receivedAt, f.at);
    assert.equal(row.bookEvidence.books[0].cachePolicy, 'no-store');
});

test('future source or receipt and stale HTTP verification remain rejected despite current-book collection', async () => {
    await assert.rejects(fixture({ sourceAgeMs: -1 }), /source_timestamp_invalid/);
    const future = await fixture();
    future.pair.books[0].timestamp = future.at + 1;
    future.pair.books[0].sourceTimestamp = String(future.at + 1);
    Object.assign(future.pair.evidence.books[0], { sourceTimestamp: String(future.at + 1),
        sourceTimestampMs: future.at + 1, sourceAgeMs: -1 });
    future.pair.evidence.booksHash = createHash('sha256').update(JSON.stringify(future.pair.books)).digest('hex');
    assert.equal(buildValueObservation(future).bookStatus, 'early_book_evidence_invalid');
    const lateReceipt = await fixture(); lateReceipt.at -= 1;
    assert.equal(buildValueObservation(lateReceipt).bookStatus, 'early_book_verification_expired');
    const staleHttp = await fixture(); staleHttp.pair.evidence.books[0].httpDateAt -= 6000;
    assert.equal(buildValueObservation(staleHttp).bookStatus, 'early_book_response_cached_or_stale');
    const expiredMetadata = await fixture(); expiredMetadata.pair.evidence.metadataVerifiedAt -= 5001;
    assert.equal(buildValueObservation(expiredMetadata).bookStatus, 'early_book_metadata_expired');
});

test('snapshot hash detects changes and all retained objects are detached and immutable', async () => {
    const f = await fixture(), row = buildValueObservation(f);
    assert.equal(verifyValueObservation(row), true);
    assert.equal(verifyValueObservation(JSON.parse(JSON.stringify(row))), true);
    const sorted = value => Array.isArray(value) ? value.map(sorted)
        : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
    assert.equal(verifyValueObservation(JSON.parse(JSON.stringify(sorted(row)))), true);
    assert.throws(() => { row.sides[0].book.asks[0].size = 999; }, TypeError);
    assert.throws(() => { row.spot.points[0].value = 999; }, TypeError);
    f.btc.spot[0].value = 999; f.market.reference.value = 999;
    f.pair.books[0].asks[0].size = 999; f.config.quoteShares.push(100);
    assert.equal(verifyValueObservation(row), true);
    assert.notEqual(row.spot.points[0].value, 999);
    assert.deepEqual(row.limits.quoteShares, [5, 10, 20]);
    const edited = structuredClone(row); edited.sides[0].quotes[0].allInCostUsd += 1;
    assert.equal(verifyValueObservation(edited), false);
    assert.equal(verifyValueObservation(null), false);
});

test('clock anomalies and market identity mismatch cannot masquerade as ready samples', async () => {
    const early = await fixture(); early.scheduledAt = early.at + 1;
    assert.ok(buildValueObservation(early).quality.reasons.includes('clock_before_schedule'));
    const closed = await fixture(); closed.at = closed.market.end;
    assert.ok(buildValueObservation(closed).quality.reasons.includes('clock_outside_market'));
    const otherMarket = await fixture(); otherMarket.market.slug = 'btc-updown-15m-1';
    assert.throws(() => buildValueObservation(otherMarket), /identity_or_clock_invalid/);
    const invalid = await fixture(); invalid.config.gasUsd = -1;
    assert.throws(() => buildValueObservation(invalid), /config_invalid/);
});
