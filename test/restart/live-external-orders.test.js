import test from 'node:test';
import assert from 'node:assert/strict';
import { externalOrderReservations } from '../../src/laya-live/external-orders.js';

const order = changes => ({ id: `0x${'1'.repeat(64)}`, conditionId: `0x${'2'.repeat(64)}`,
    tokenId: '123', originalSize: '5', sizeMatched: '2', price: '0.8', side: 'BUY', ...changes });

test('manual BUY reserves remaining payout; SELL reserves no cash and still blocks its own market', () => {
    const buy = order(), sell = order({ id: `0x${'3'.repeat(64)}`, side: 'SELL' });
    const result = externalOrderReservations([buy, sell], { market: { conditionId: buy.conditionId, tokens: ['123', '456'] } });
    assert.deepEqual(result, { count: 2, reservedPUSD: 3, overlaps: true });
    assert.equal(externalOrderReservations([buy], { market: { conditionId: `0x${'4'.repeat(64)}`, tokens: ['789', '987'] } }).overlaps, false);
    assert.deepEqual(externalOrderReservations([buy], { owned: [buy.id] }), { count: 0, reservedPUSD: 0, overlaps: false });
});

test('malformed manual order amounts/identity cannot silently become spendable cash', () => {
    for (const changes of [{ id: 'unknown' }, { conditionId: '' }, { tokenId: '' }, { side: 'unknown' },
        { sizeMatched: '6' }, { sizeMatched: '-1' }, { originalSize: 'NaN' }, { price: '0' }, { price: '1' }])
        assert.throws(() => externalOrderReservations([order(changes)]), /external_orders_unproven/);
    assert.throws(() => externalOrderReservations([order(), order()]), /external_orders_unproven/);
});
