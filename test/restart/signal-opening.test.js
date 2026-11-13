import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal } from '../../src/restart/signal.js';

const OPEN = 1_800_000_000_000;
const rule = BASELINE.lateSignal;
const twap = (at, value = 83000) => ({ topic: 'prices.crypto.twap', type: 'update',
    payload: { symbol: 'btcusd', timestamp: at, value: String(value), windowSeconds: 60 } });
const spot = (at, value = 83000) => ({ ...twap(at, value), topic: 'prices.crypto' });
const snapshot = data => ({ ...twap(OPEN), type: 'subscribe',
    payload: { ...twap(OPEN).payload, data } });

test('a fresh delayed exact opening is captured after a newer TWAP without rolling latest back', () => {
    const events = [], signal = new BtcSignal(rule, event => events.push(event));
    signal.ingest(twap(OPEN + 1000, 83010), OPEN + 1100);
    const latest = signal.twap;
    signal.ingest(twap(OPEN, 83000), OPEN + 1200);

    assert.strictEqual(signal.twap, latest);
    assert.deepEqual(signal.twap, { at: OPEN + 1000, value: 83010, receivedAt: OPEN + 1100 });
    assert.deepEqual(signal.openings.get(OPEN), { at: OPEN, value: 83000, receivedAt: OPEN + 1200 });
    assert.deepEqual(events, [{ type: 'btc_opening_observed',
        opening: { at: OPEN, value: 83000, receivedAt: OPEN + 1200 }, source: 'chainlink_twap_60s' }]);
});

test('duplicate and conflicting opening updates preserve the first value and receipt time', () => {
    const events = [], signal = new BtcSignal(rule, event => events.push(event));
    signal.ingest(twap(OPEN), OPEN + 100);
    const opening = signal.openings.get(OPEN);
    assert.ok(Object.isFrozen(opening));
    assert.notStrictEqual(signal.twap, opening);
    signal.ingest(twap(OPEN + 1000, 83010), OPEN + 1100);
    const latest = signal.twap;
    signal.ingest(twap(OPEN), OPEN + 1200);
    signal.ingest(twap(OPEN, 82900), OPEN + 1300);

    assert.strictEqual(signal.openings.get(OPEN), opening);
    assert.deepEqual(opening, { at: OPEN, value: 83000, receivedAt: OPEN + 100 });
    assert.strictEqual(signal.twap, latest);
    assert.deepEqual(events.map(event => event.type), ['btc_opening_observed', 'btc_opening_conflict']);
    assert.deepEqual(events[1], { type: 'btc_opening_conflict', opening: { ...opening },
        conflicting: { at: OPEN, value: 82900, receivedAt: OPEN + 1300 }, source: 'chainlink_twap_60s' });
    events[0].opening.value = 1;
    events[1].opening.receivedAt = OPEN + 4000;
    assert.deepEqual(opening, { at: OPEN, value: 83000, receivedAt: OPEN + 100 });
});

test('opening receipt age accepts five seconds exactly and rejects stale or future sources', () => {
    const fresh = new BtcSignal(rule);
    fresh.ingest(twap(OPEN + 1000), OPEN + 1100);
    fresh.ingest(twap(OPEN), OPEN + 5000);
    assert.equal(fresh.openings.get(OPEN).receivedAt, OPEN + 5000);
    for (const receivedAt of [OPEN - 1, OPEN + 5001]) {
        const signal = new BtcSignal(rule);
        signal.ingest(twap(OPEN + 1000), OPEN + 1100);
        const latest = signal.twap;
        signal.ingest(twap(OPEN), receivedAt);
        assert.equal(signal.openings.size, 0);
        assert.strictEqual(signal.twap, latest);
    }
});

test('nonfinite source values, timestamps and receipt times cannot create openings or latest TWAP', () => {
    const invalid = [
        ...[NaN, Infinity, -Infinity].map(timestamp => ({ payload: { timestamp } })),
        ...[NaN, Infinity, -Infinity, 0, -1].map(value => ({ payload: { value } })),
        ...[NaN, Infinity, -Infinity].map(receivedAt => ({ receivedAt })),
        { payload: { symbol: 'ethusd' } }, { payload: { windowSeconds: 30 } },
        { payload: { windowSeconds: '60' } }, { type: 'unknown' }, { topic: 'untrusted' },
    ];
    for (const entry of invalid) {
        const event = twap(OPEN), events = [], signal = new BtcSignal(rule, event => events.push(event));
        signal.ingest({ ...event, ...entry, payload: { ...event.payload, ...entry.payload } },
            'receivedAt' in entry ? entry.receivedAt : OPEN + 100);
        assert.equal(signal.openings.size, 0);
        assert.equal(signal.twap, null);
        assert.deepEqual(events, []);
    }
});

test('only exact five-minute 60-second TWAP boundaries create openings', () => {
    const signal = new BtcSignal(rule);
    signal.ingest(twap(OPEN + 1), OPEN + 100);
    assert.equal(signal.twap.at, OPEN + 1);
    signal.ingest(spot(OPEN), OPEN + 100);
    assert.equal(signal.spot.length, 1);
    assert.equal(signal.openings.size, 0);
});

test('fresh snapshot rows can capture an out-of-order opening using their own timestamp and value', () => {
    const signal = new BtcSignal(rule);
    signal.ingest(snapshot([
        { timestamp: OPEN + 1000, value: '83010' },
        { timestamp: OPEN, value: '83000' },
        { timestamp: OPEN - 300000, value: '82900' },
    ]), OPEN + 1200);
    assert.deepEqual(signal.twap, { at: OPEN + 1000, value: 83010, receivedAt: OPEN + 1200 });
    assert.deepEqual([...signal.openings.values()], [{ at: OPEN, value: 83000, receivedAt: OPEN + 1200 }]);
});

test('invalid snapshots cannot inherit an opening from the parent payload or bypass receipt checks', () => {
    for (const data of [undefined, null, {}, 'bad', [null, [], 1, 'bad', {},
        { timestamp: OPEN }, { value: '83000' },
        { timestamp: Infinity, value: '83000' }, { timestamp: OPEN, value: 'Infinity' },
        { timestamp: OPEN - 300000, value: '83000' },
        { timestamp: OPEN + 1000, value: '83000' }]]) {
        const events = [], signal = new BtcSignal(rule, event => events.push(event));
        assert.doesNotThrow(() => signal.ingest(snapshot(data), OPEN + 100));
        assert.equal(signal.openings.size, 0);
        assert.equal(signal.twap, null);
        assert.deepEqual(events, []);
    }
    const stale = new BtcSignal(rule);
    stale.ingest(snapshot([{ timestamp: OPEN, value: '83000' }]), OPEN + 5001);
    assert.equal(stale.openings.size, 0);
});

test('opening pruning retains the fifteen-minute boundary and advances with latest TWAP', () => {
    const signal = new BtcSignal(rule);
    for (const at of [OPEN, OPEN + 300000, OPEN + 900000]) signal.ingest(twap(at), at + 100);
    assert.deepEqual([...signal.openings.keys()], [OPEN, OPEN + 300000, OPEN + 900000]);
    signal.ingest(twap(OPEN + 900001), OPEN + 900100);
    assert.deepEqual([...signal.openings.keys()], [OPEN + 300000, OPEN + 900000]);
    const latest = signal.twap, opening = signal.openings.get(OPEN + 900000);
    signal.ingest(twap(OPEN + 900000), OPEN + 900200);
    assert.strictEqual(signal.twap, latest);
    assert.strictEqual(signal.openings.get(OPEN + 900000), opening);
});

test('spot gaps and declared drops retain openings while resetting the existing feed state', () => {
    const events = [], signal = new BtcSignal(rule, event => events.push(event));
    signal.ingest(spot(OPEN), OPEN + 100);
    signal.ingest(twap(OPEN), OPEN + 100);
    const opening = signal.openings.get(OPEN);
    signal.ingest(spot(OPEN + 6000), OPEN + 6100);
    assert.equal(signal.spot.length, 1);
    assert.equal(signal.twap, null);
    assert.strictEqual(signal.openings.get(OPEN), opening);
    signal.ingest({ ...twap(OPEN + 7000), dropped: 2 }, OPEN + 7100);
    assert.equal(signal.spot.length, 0);
    assert.equal(signal.twap.at, OPEN + 7000);
    assert.strictEqual(signal.openings.get(OPEN), opening);
    assert.deepEqual(events.filter(event => event.type === 'btc_feed_gap'), [
        { type: 'btc_feed_gap', gapMs: 6000 }, { type: 'btc_feed_gap', dropped: 2 },
    ]);
});

test('a delayed opening satisfies observation but cannot bypass direct volatility warmup', () => {
    const signal = new BtcSignal(rule), market = { open: OPEN, end: OPEN + 300000,
        reference: { source: 'chainlink_twap_60s', open: OPEN, end: OPEN + 300000,
            value: 83000, observedAt: OPEN, receivedAt: OPEN + 1200 } };
    signal.ingest(spot(OPEN + 1000, 83010), OPEN + 1100);
    signal.ingest(twap(OPEN + 1000, 83010), OPEN + 1100);
    const assess = () => signal.assess(market, { index: 0, price: 0.85, shares: 5 }, BASELINE, OPEN + 1200);
    assert.equal(assess().reason, 'btc_opening_twap_unobserved');
    signal.ingest(twap(OPEN), OPEN + 1200);
    assert.equal(assess().reason, 'btc_volatility_warmup');
});
