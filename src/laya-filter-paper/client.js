import { TradingClient } from '../restart/client.js';

export function publicReader(control, onEvent, Client = TradingClient) {
    const raw = new Client(control);
    // Polybolt feed authentication proves ownership, but paper cannot submit financial operations.
    for (const operation of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction'])
        raw[operation] = async () => { throw new Error('paper_transaction_forbidden'); };
    raw.onEvent = event => onEvent?.(event);
    return Object.freeze({ btc: raw.btc, get clock() { return raw.clock; },
        market: raw.market.bind(raw), books: raw.books.bind(raw), payout: raw.payout.bind(raw),
        marketInfo: (...args) => raw.marketInfo(...args), validateInfo: (...args) => raw.validateInfo(...args),
        serverTime: raw.serverTime.bind(raw), tickSize: raw.tickSize.bind(raw),
        startBtcFeed: raw.startBtcFeed.bind(raw), btcStatus: raw.btcStatus.bind(raw), close: raw.close.bind(raw) });
}
