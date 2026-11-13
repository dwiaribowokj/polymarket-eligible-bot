const reads = new Set(['serverTime', 'market', 'books', 'marketInfo', 'validateInfo', 'tickSize',
    'startBtcFeed', 'btcStatus', 'walletHealth', 'positions', 'ordersAndTrades', 'order',
    'gasPriceUsd', 'confirmedBlock', 'balance', 'holdings', 'payout', 'receipt', 'receiptGas', 'close', 'warmOrderMetadata']);

// The engine receives this restricted facade, never the raw SDK/provider or a
// signing/submission method. Its separately injected observer vetoes entry
// before any real ledger reservation. Both barriers are tested independently.
export function readOnlyLiveClient(client, onBlocked = () => {}) {
    return new Proxy({}, { get(_target, name) {
        if (name === 'btc') return client.btc;
        if (reads.has(name)) return typeof client[name] === 'function' ? client[name].bind(client) : undefined;
        if (['prepare', 'post', 'cancel', 'prepareAction', 'prepareSafeCall', 'prepareProfitTransfer', 'broadcastAction', 'authenticate'].includes(name))
            return () => { onBlocked(name); throw new Error('diagnostic_financial_operation_blocked'); };
        return undefined;
    } });
}
