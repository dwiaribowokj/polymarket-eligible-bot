import { OrderResponseErrorCode, RequestRejectedError } from '@polymarket/client';

// Exact legacy messages from @polymarket/bindings@0.12.0 order-response.ts.
const messageCodes = new Map([
    ['the market is not yet ready to process new orders', OrderResponseErrorCode.MARKET_NOT_READY],
    ['invalid nonce', OrderResponseErrorCode.INVALID_NONCE],
    ['invalid expiration', OrderResponseErrorCode.INVALID_EXPIRATION],
    ['invalid post-only order: order crosses book', OrderResponseErrorCode.POST_ONLY_WOULD_CROSS],
    ['post-only mode: only post-only orders and cancels are allowed', OrderResponseErrorCode.POST_ONLY_MODE],
    ["order couldn't be fully filled. FOK orders are fully filled or killed.", OrderResponseErrorCode.FOK_NOT_FILLED],
    ['no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.',
        OrderResponseErrorCode.FAK_NOT_FILLED],
    ['not enough balance / allowance', OrderResponseErrorCode.INSUFFICIENT_BALANCE_OR_ALLOWANCE],
]);
const knownCodes = new Set(Object.values(OrderResponseErrorCode).filter(code => code !== OrderResponseErrorCode.UNKNOWN));

export function normalizePostRejection(error) {
    // The SDK throws this class directly for an HTTP rejection. Never infer a
    // definite outcome from a wrapper, lookalike, transport or schema failure.
    if (!(error instanceof RequestRejectedError) || error.status !== 400) return null;

    // ServiceClient appends ` (response.url)` to legacy JSON errors. Strip only
    // that suffix; arbitrary prefixes, suffixes and case changes stay unknown.
    const message = error.message.replace(/ \((?:https?:\/\/[^\s()]*|)\)$/, '');
    const code = error.code === undefined ? messageCodes.get(message)
        : knownCodes.has(error.code) ? error.code : undefined;
    return { ok: false, code: code || 'http_rejected', httpStatus: 400, definiteRejection: true };
}

export function isBenignNoFill(result) {
    return result?.ok === false && result.definiteRejection === true && result.httpStatus === 400
        && result.code === OrderResponseErrorCode.FAK_NOT_FILLED;
}
