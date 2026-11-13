import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderResponseErrorCode, RequestRejectedError, TimeoutError, TransportError,
    UnexpectedResponseError } from '@polymarket/client';
import { OperationalError } from '../../src/restart/network.js';
import { normalizePostRejection, isBenignNoFill } from '../../src/laya-live/order-errors.js';

const fakMessage = 'no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.';
const rejection = (message = fakMessage, options = {}) => new RequestRejectedError(message, { status: 400, ...options });
const result = code => ({ ok: false, code, httpStatus: 400, definiteRejection: true });

test('official SDK HTTP 400 FAK no-match is a definite, benign rejection', () => {
    const normalized = normalizePostRejection(rejection());
    assert.deepEqual(normalized, result('fak_not_filled'));
    assert.equal(isBenignNoFill(normalized), true);
});

test('SDK response URL suffix is removed before exact legacy message matching', () => {
    for (const suffix of [' (https://clob.polymarket.com/order)', ' (http://fixture.invalid/order)', ' ()'])
        assert.deepEqual(normalizePostRejection(rejection(fakMessage + suffix)), result('fak_not_filled'));
});

test('known legacy messages retain the SDK canonical rejection codes', () => {
    const fixtures = [
        ['the market is not yet ready to process new orders', 'market_not_ready'],
        ['invalid nonce', 'invalid_nonce'],
        ['invalid expiration', 'invalid_expiration'],
        ['invalid post-only order: order crosses book', 'post_only_would_cross'],
        ['post-only mode: only post-only orders and cancels are allowed', 'post_only_mode'],
        ["order couldn't be fully filled. FOK orders are fully filled or killed.", 'fok_not_filled'],
        ['not enough balance / allowance', 'insufficient_balance_or_allowance'],
    ];
    for (const [message, code] of fixtures) {
        const normalized = normalizePostRejection(rejection(message));
        assert.deepEqual(normalized, result(code));
        assert.equal(isBenignNoFill(normalized), false);
    }
});

test('only known explicit canonical SDK codes are retained', () => {
    for (const code of Object.values(OrderResponseErrorCode)) {
        const normalized = normalizePostRejection(rejection('venue rejection', { code }));
        assert.deepEqual(normalized, result(code === 'unknown' ? 'http_rejected' : code));
        assert.equal(isBenignNoFill(normalized), code === 'fak_not_filled');
    }
});

test('explicit machine code takes precedence over legacy text', () => {
    assert.deepEqual(normalizePostRejection(rejection(fakMessage, { code: 'invalid_nonce' })), result('invalid_nonce'));
    assert.deepEqual(normalizePostRejection(rejection(fakMessage, { code: 'unrecognized_code' })), result('http_rejected'));
});

test('unrecognized SDK HTTP 400 remains a definite rejection with a safe generic code', () => {
    const secret = 'fixture-secret-signature=do-not-retain';
    const error = rejection(`arbitrary rejection ${secret} (https://fixture.invalid/order?key=${secret})`,
        { code: secret, cause: { signature: secret } });
    error.payload = { secret };
    const normalized = normalizePostRejection(error);
    assert.deepEqual(normalized, result('http_rejected'));
    assert.equal(isBenignNoFill(normalized), false);
    assert.equal(JSON.stringify(normalized).includes(secret), false);
    assert.deepEqual(Object.keys(normalized).sort(), ['code', 'definiteRejection', 'httpStatus', 'ok']);
});

test('FAK text must match exactly to qualify as benign', () => {
    for (const message of [fakMessage.toUpperCase(), `prefix ${fakMessage}`, `${fakMessage} suffix`,
        `${fakMessage} (not-a-url)`, `${fakMessage} `, 'fak_not_filled', 'unmatched']) {
        const normalized = normalizePostRejection(rejection(message));
        assert.deepEqual(normalized, result('http_rejected'));
        assert.equal(isBenignNoFill(normalized), false);
    }
});

test('other SDK HTTP statuses preserve unknown submission handling', () => {
    for (const status of [0, 200, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, '400', undefined])
        assert.equal(normalizePostRejection(rejection(fakMessage, { status })), null);
});

test('timeout, transport and malformed response errors cannot establish rejection', () => {
    const cause = rejection();
    for (const error of [new TimeoutError('Timed out'), new TransportError('fetch failed', { cause }),
        new UnexpectedResponseError('Malformed order response', { cause }),
        new SyntaxError('Unexpected JSON'), Object.assign(new Error('timeout'), { name: 'AbortError', status: 400 })])
        assert.equal(normalizePostRejection(error), null);
});

test('OperationalError and nested SDK errors cannot establish rejection', () => {
    const cause = rejection();
    for (const error of [new OperationalError('http_rejected', 'api_rejection', { httpStatus: 400, cause }),
        new Error('wrapper', { cause }), { error: cause }, { cause }])
        assert.equal(normalizePostRejection(error), null);
});

test('plain errors and forged SDK error names/statuses cannot establish rejection', () => {
    for (const error of [null, undefined, fakMessage, new Error(fakMessage),
        { name: 'RequestRejectedError', message: fakMessage, status: 400 },
        Object.assign(new Error(fakMessage), { name: 'RequestRejectedError', status: 400, code: 'fak_not_filled' })])
        assert.equal(normalizePostRejection(error), null);
});

test('benign no-fill requires all exact proof fields and a rejected outcome', () => {
    const valid = result('fak_not_filled');
    for (const change of [{ ok: true }, { ok: undefined }, { definiteRejection: undefined }, { definiteRejection: 1 },
        { httpStatus: '400' }, { httpStatus: 200 }, { code: 'unmatched' }, { code: 'http_rejected' }])
        assert.equal(isBenignNoFill({ ...valid, ...change }), false);
    for (const invalid of [null, undefined, false, {}, { ok: false, code: 'fak_not_filled' }])
        assert.equal(isBenignNoFill(invalid), false);
});
