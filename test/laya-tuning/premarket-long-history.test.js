import test from 'node:test';
import assert from 'node:assert/strict';
import { PremarketHistory, premarketFeatures } from '../../src/premarket-paper/features.js';

const MINUTE = 60000;
const decisionAt = Date.parse('2026-10-27T01:04:00Z');
const market = { open: decisionAt + MINUTE };
const config = { profile: 'near-open-30m-v1', leadSeconds: 60, historyMs: 30 * MINUTE,
    diagnosticHistoryMs: 30 * MINUTE, candleCount: 30, maxGapMs: 5000, dataAgeMs: 5000 };
const point = (at, value = 83000 + (at - decisionAt) / 1000) => ({ at, receivedAt: at, value });
const prices = (start = decisionAt - 30 * MINUTE, end = decisionAt, step = 1000) =>
    Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => point(start + i * step));
const features = points => premarketFeatures(points, market, decisionAt, config);

test('near-open context contains 30 complete UTC minute bars and six exact rolling five-minute groups', () => {
    const points = prices(), result = features(points);
    assert.equal(result.action, 'BUY_UP');
    assert.equal(result.bars.length, 30);
    assert.equal(result.observedAt, decisionAt);
    assert.equal(result.bars[0].start, decisionAt - 30 * MINUTE);
    assert.equal(result.bars.at(-1).end, decisionAt);
    assert.equal(result.bars.at(-1).close, points.at(-2).value);
    assert.equal(result.bars.every(bar => bar.start % MINUTE === 0 && bar.end - bar.start === MINUTE), true);
    assert.equal(result.bars.reduce((sum, bar) => sum + bar.samples, 0), 1800);
    assert.equal(result.context.schema, config.profile);
    assert.equal(result.context.source, 'chainlink_btc_usd');
    assert.equal(result.context.completedThroughAt, decisionAt);
    assert.equal(result.context.historyStartAt, decisionAt - 30 * MINUTE);
    assert.equal(result.context.historyEndAt, decisionAt);
    assert.equal(result.context.requiredMinutes, 30);
    assert.equal(result.context.aggregation5m, 'consecutive_groups_of_five_completed_1m_bars');
    assert.equal(result.context.bars5m.length, 6);
    for (let index = 0; index < 6; index++) {
        const group = result.bars.slice(index * 5, index * 5 + 5);
        assert.deepEqual(result.context.bars5m[index], { start: group[0].start, end: group.at(-1).end,
            open: group[0].open, high: group.at(-1).high, low: group[0].low, close: group.at(-1).close,
            samples: 300, latestReceivedAt: group.at(-1).latestReceivedAt });
    }
    assert.notEqual(result.context.bars5m[0].start % (5 * MINUTE), 0);
    assert.deepEqual(result.context.returnsUsd, { s30: 30, s60: 60, m3: 180, m5: 300, m15: 900, m30: 1800 });
    assert.equal(result.diagnosticOnly.move180Usd, 179);
    assert.equal(result.diagnosticOnly.historySeconds, 1800);
    assert.equal(result.openingTwap.value, null);
});

test('directional diagnostic uses the last three bars even when the earlier 27 move the other way', () => {
    const points = prices().map(p => ({ ...p, value: p.at < decisionAt - 3 * MINUTE
        ? 85000 - (p.at - (decisionAt - 30 * MINUTE)) / 1000 : p.value }));
    const result = features(points);
    assert.equal(result.action, 'BUY_UP');
    assert.ok(result.bars[0].close < result.bars[0].open);
    assert.equal(result.diagnosticOnly.move180Usd, 179);
});

test('one, three, and 29 complete minutes cannot satisfy 30-minute warmup', () => {
    for (const minutes of [1, 3, 29]) {
        const result = features(prices(decisionAt - minutes * MINUTE));
        assert.equal(result.reason, 'completed_candles_warming');
        assert.equal(result.bars, undefined);
    }
});

test('missing middle candle and sub-minute gaps anywhere in the full window fail closed', () => {
    for (const [start, duration] of [[decisionAt - 24 * MINUTE, MINUTE],
        [decisionAt - 18 * MINUTE, 5000], [decisionAt - 7000, 5000]]) {
        const points = prices().filter(p => p.at < start || p.at >= start + duration);
        assert.equal(features(points).reason, 'btc_history_gap');
    }
    assert.equal(features(prices().filter(p => p.at <= decisionAt - 5000)).bars.length, 30);
    assert.equal(features(prices().filter(p => p.at <= decisionAt - 6000)).reason, 'btc_feed_stale_or_warming');
    assert.equal(features(prices(undefined, undefined, 5000)).bars.length, 30);
    const widened = { ...config, maxGapMs: 10000, dataAgeMs: 10000 };
    assert.equal(premarketFeatures(prices().filter(p => p.at <= decisionAt - 6000), market, decisionAt, widened)
        .reason, 'btc_feed_stale_or_warming');
});

test('timestamps, values, and ordering are validated without silently sorting malformed input', () => {
    for (const [key, value] of [['at', NaN], ['at', Infinity], ['receivedAt', NaN],
        ['receivedAt', Infinity], ['value', NaN], ['value', Infinity], ['value', 0], ['value', -1]]) {
        const points = prices(); points[700][key] = value;
        assert.equal(features(points).reason, 'btc_history_invalid', `${key}=${value}`);
    }
    const shuffled = prices();
    [shuffled[700], shuffled[701]] = [shuffled[701], shuffled[700]];
    assert.equal(features(shuffled).reason, 'btc_history_out_of_order');
    const duplicate = prices(); duplicate.splice(700, 0, { ...duplicate[700] });
    assert.equal(features(duplicate).reason, 'btc_history_out_of_order');
    const receiptReversal = prices(); receiptReversal[700].receivedAt += 2000;
    assert.equal(features(receiptReversal).reason, 'btc_history_out_of_order');
    for (const at of [NaN, Infinity, decisionAt + 1]) {
        assert.equal(premarketFeatures(prices(), market, at, config).reason, 'invalid_premarket_decision_time');
    }
});

test('future source samples and receipts after decision never alter complete bars or summaries', () => {
    const baseline = features(prices());
    const future = prices();
    future.push({ at: decisionAt + 1000, receivedAt: decisionAt + 1000, value: 1 });
    future.push({ at: decisionAt - 1000, receivedAt: decisionAt + 1, value: 999999 });
    assert.deepEqual(features(future), baseline);
    const late = prices().map(p => p.at >= decisionAt - 12 * MINUTE && p.at < decisionAt - 11 * MINUTE
        ? { ...p, receivedAt: decisionAt + 1 } : p);
    assert.equal(features(late).reason, 'btc_history_gap');
    const backfill = prices().map(p => ({ ...p, receivedAt: decisionAt }));
    assert.equal(features(backfill).reason, 'completed_candles_warming');
    const negativeReceipt = prices().map(p => p.at >= decisionAt - 12 * MINUTE && p.at < decisionAt - 11 * MINUTE
        ? { ...p, receivedAt: p.at - 1 } : p);
    assert.equal(features(negativeReceipt).reason, 'btc_history_gap');
});

test('partial current minute stays outside candle context while coverage and returns continue through decision', () => {
    const at = decisionAt + 30000, points = prices(decisionAt - 30 * MINUTE, at);
    const result = premarketFeatures(points, { open: at + MINUTE }, at, config);
    assert.equal(result.bars.length, 30);
    assert.equal(result.context.completedThroughAt, decisionAt);
    assert.equal(result.context.bars5m.at(-1).end, decisionAt);
    assert.equal(result.observedAt, at);
    assert.deepEqual(result.context.returnsUsd, { s30: 30, s60: 60, m3: 180, m5: 300, m15: 900, m30: 1800 });
    const gap = points.filter(p => p.at < decisionAt + 10000 || p.at >= decisionAt + 20000);
    assert.equal(premarketFeatures(gap, { open: at + MINUTE }, at, config).reason, 'btc_history_gap');
});

test('live history starts a full warmup without using preexisting snapshots and retains required context', () => {
    const history = new PremarketHistory({ ...config, diagnosticHistoryMs: 900000 });
    assert.equal(history.keepMs, 30 * MINUTE + 65000);
    const start = decisionAt - 30 * MINUTE;
    history.capture({ spot: prices(start - 30 * MINUTE, start) }, start);
    assert.deepEqual(history.points, [point(start)]);
    for (const p of prices(start + 1000)) history.capture({ spot: [p] }, p.receivedAt);
    assert.equal(features(history.points).bars.length, 30);
    assert.equal(history.points.length, 1801);
});

test('a live gap or feed reset clears all warmup and cannot be repaired using old points', () => {
    const history = new PremarketHistory(config), before = decisionAt - 30 * MINUTE;
    history.capture({ spot: [point(before)] }, before);
    history.capture({ spot: [point(before + 6000)] }, before + 6000);
    assert.deepEqual(history.points, [point(before + 6000)]);
    history.capture({ spot: prices(before, before + 6000) }, before + 6000);
    assert.deepEqual(history.points, [point(before + 6000)]);
    for (const p of prices(before + 7000)) history.capture({ spot: [p] }, p.receivedAt);
    assert.equal(features(history.points).reason, 'completed_candles_warming');
    history.reset();
    history.capture({ spot: prices() }, decisionAt);
    assert.deepEqual(history.points, [point(decisionAt)]);
    assert.equal(features(history.points).reason, 'completed_candles_warming');
});

test('live capture rejects stale backfill, impossible receipt times, out-of-order input, and stale final coverage', () => {
    for (const spot of [prices().map(p => ({ ...p, receivedAt: decisionAt })),
        [point(decisionAt - 10000)], [{ ...point(decisionAt), receivedAt: decisionAt - 1 }],
        [{ ...point(decisionAt), receivedAt: decisionAt + 1 }]]) {
        const history = new PremarketHistory(config);
        history.capture({ spot }, decisionAt);
        assert.ok(history.points.every(p => p.at === decisionAt && p.receivedAt === decisionAt));
        assert.equal(features(history.points).reason, history.points.length ? 'completed_candles_warming' : 'btc_feed_stale_or_warming');
    }
    const history = new PremarketHistory(config);
    history.capture({ spot: [point(decisionAt)] }, decisionAt);
    history.capture({ spot: [point(decisionAt + 2000), point(decisionAt + 1000)] }, decisionAt + 2000);
    assert.equal(history.points.length, 0);
    history.capture({ spot: [point(decisionAt + 3000)] }, decisionAt + 3000);
    history.capture({ spot: [point(decisionAt + 3000)] }, decisionAt + 9000);
    assert.equal(history.points.length, 0);
});

test('live receipt order cannot reverse across separate capture calls', () => {
    const history = new PremarketHistory(config);
    history.capture({ spot: [point(decisionAt)] }, decisionAt);
    history.capture({ spot: [{ ...point(decisionAt + 1000), receivedAt: decisionAt + 5000 }] }, decisionAt + 5000);
    history.capture({ spot: [point(decisionAt + 2000)] }, decisionAt + 5001);
    assert.equal(history.points.length, 0);
});

test('historical profile retains its three-bar decision and diagnostic retention defaults', () => {
    const historical = { ...config, profile: 'three-candles-v1', leadSeconds: 240,
        historyMs: 3 * MINUTE, diagnosticHistoryMs: 15 * MINUTE };
    const result = premarketFeatures(prices(decisionAt - 3 * MINUTE), { open: decisionAt + 240000 }, decisionAt, historical);
    assert.equal(result.bars.length, 3);
    assert.equal(result.context, undefined);
    assert.equal(result.action, 'BUY_UP');
    assert.equal(new PremarketHistory(historical).keepMs, 15 * MINUTE + 65000);
});
