import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE } from '../../src/restart/config.js';
import { BtcSignal as PublicBtcSignal } from '../../src/restart/signal.js';
import { BtcSignal as LiveBtcSignal } from '../../src/laya-live/signal.js';
import { TradingClient } from '../../src/restart/client.js';
import { LayaTradingClient } from '../../src/laya-live/client.js';

const OPEN = 1_800_000_000_000;
const rule = BASELINE.lateSignal;
const twap = (at, value = 83000) => ({ topic: 'prices.crypto.twap', type: 'update',
    payload: { symbol: 'btcusd', timestamp: at, value: String(value), windowSeconds: 60 } });
const spot = (at, value = 83000) => ({ ...twap(at, value), topic: 'prices.crypto' });

for (const [name, BtcSignal] of [['public', PublicBtcSignal], ['LIVE', LiveBtcSignal]]) {
    test(`${name}: a fresh delayed boundary captures the opening without rolling latest TWAP back`, () => {
        const events = [], signal = new BtcSignal(rule, event => events.push(event));
        signal.ingest(twap(OPEN + 1000, 83010), OPEN + 1100);
        const latest = signal.twap;
        signal.ingest(twap(OPEN), OPEN + 1200);
        const opening = signal.openings.get(OPEN);
        assert.strictEqual(signal.twap, latest);
        assert.deepEqual(latest, { at: OPEN + 1000, value: 83010, receivedAt: OPEN + 1100 });
        assert.deepEqual(opening, { at: OPEN, value: 83000, receivedAt: OPEN + 1200 });
        assert.ok(Object.isFrozen(opening));

        signal.ingest(twap(OPEN), OPEN + 1300);
        signal.ingest(twap(OPEN, 82900), OPEN + 1400);
        assert.strictEqual(signal.openings.get(OPEN), opening);
        assert.strictEqual(signal.twap, latest);
        assert.deepEqual(events, [
            { type: 'btc_opening_observed', opening: { ...opening }, source: 'chainlink_twap_60s' },
            { type: 'btc_opening_conflict', opening: { ...opening },
                conflicting: { at: OPEN, value: 82900, receivedAt: OPEN + 1400 }, source: 'chainlink_twap_60s' },
        ]);
        events[0].opening.value = 1;
        events[1].opening.receivedAt = OPEN + 4900;
        assert.deepEqual(opening, { at: OPEN, value: 83000, receivedAt: OPEN + 1200 });
    });

    test(`${name}: five-second freshness and exact 60-second TWAP boundary requirements remain enforced`, () => {
        assert.equal(rule.maxAgeMs, 5000);
        for (const receivedAt of [OPEN - 1, OPEN + 5000, OPEN + 5001]) {
            const signal = new BtcSignal(rule);
            signal.ingest(twap(OPEN + 1000), OPEN + 1100);
            const latest = signal.twap;
            signal.ingest(twap(OPEN), receivedAt);
            assert.equal(signal.openings.has(OPEN), receivedAt === OPEN + 5000);
            assert.strictEqual(signal.twap, latest);
        }
        for (const event of [twap(OPEN + 1), spot(OPEN),
            { ...twap(OPEN), payload: { ...twap(OPEN).payload, windowSeconds: 30 } }]) {
            const signal = new BtcSignal(rule);
            signal.ingest(event, OPEN + 100);
            assert.equal(signal.openings.size, 0);
        }
    });

    test(`${name}: nonfinite and nonpositive inputs cannot create openings or replace valid latest TWAP`, () => {
        const invalid = [
            ...[NaN, Infinity, -Infinity].map(timestamp => ({ payload: { timestamp } })),
            ...[NaN, Infinity, -Infinity, 0, -1].map(value => ({ payload: { value } })),
            ...[NaN, Infinity, -Infinity].map(receivedAt => ({ receivedAt })),
        ];
        for (const entry of invalid) {
            const events = [], signal = new BtcSignal(rule, event => events.push(event));
            signal.ingest(twap(OPEN + 1000), OPEN + 1100);
            const latest = signal.twap, event = twap(OPEN);
            signal.ingest({ ...event, payload: { ...event.payload, ...entry.payload } },
                'receivedAt' in entry ? entry.receivedAt : OPEN + 1200);
            assert.strictEqual(signal.twap, latest);
            assert.equal(signal.openings.size, 0);
            assert.deepEqual(events, []);
        }
    });

    test(`${name}: snapshot rows capture a delayed boundary using their own finite timestamp and value`, () => {
        const signal = new BtcSignal(rule);
        signal.ingest({ ...twap(OPEN), type: 'subscribe', payload: { ...twap(OPEN).payload, data: [
            { timestamp: OPEN + 1000, value: '83010' },
            { timestamp: OPEN, value: '83000' },
            { timestamp: OPEN - 300000, value: '82900' },
            {}, { timestamp: OPEN }, { value: '83000' },
            { timestamp: Infinity, value: '83000' },
        ] } }, OPEN + 1200);
        assert.deepEqual(signal.twap, { at: OPEN + 1000, value: 83010, receivedAt: OPEN + 1200 });
        assert.deepEqual([...signal.openings.values()], [{ at: OPEN, value: 83000, receivedAt: OPEN + 1200 }]);
    });

    test(`${name}: feed gaps reset observation history and retain the first opening`, () => {
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

    test(`${name}: delayed opening observation retains the 180-second direct volatility warmup`, () => {
        assert.equal(rule.lookbackSeconds, 180);
        const signal = new BtcSignal(rule), market = { open: OPEN, end: OPEN + 300000,
            reference: { source: 'chainlink_twap_60s', open: OPEN, end: OPEN + 300000,
                value: 83000, observedAt: OPEN, receivedAt: OPEN + 1200 } };
        signal.ingest(spot(OPEN + 1000, 83010), OPEN + 1100);
        signal.ingest(twap(OPEN + 1000, 83010), OPEN + 1100);
        const assess = () => signal.assess(market, { index: 0, price: .85, shares: 5 }, BASELINE, OPEN + 1200);
        assert.equal(assess().reason, 'btc_opening_twap_unobserved');
        signal.ingest(twap(OPEN), OPEN + 1200);
        assert.equal(assess().reason, 'btc_volatility_warmup');
    });
}

test('LayaTradingClient installs an independent LIVE collector before feed consumption', t => {
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_signal_fixture'); });
    const settings = { ...BASELINE, rpcUrl: 'http://127.0.0.1:1', strategies: ['late-entry'] };
    const client = new LayaTradingClient(settings), control = new TradingClient(settings);
    t.after(() => { client.close(); control.close(); });
    assert.equal(client.btc.constructor, LiveBtcSignal);
    assert.equal(control.btc.constructor, PublicBtcSignal);
    assert.equal(client.btc instanceof PublicBtcSignal, false);
    assert.equal(client.btcTask, undefined);
    const events = [];
    client.onEvent = event => events.push(event);
    client.btc.ingest(twap(OPEN + 1000), OPEN + 1100);
    client.btc.ingest(twap(OPEN), OPEN + 1200);
    assert.equal(client.btc.openings.get(OPEN).receivedAt, OPEN + 1200);
    assert.equal(events.filter(event => event.type === 'btc_opening_observed').length, 1);
    assert.equal(control.btc.openings.size, 0);
});
