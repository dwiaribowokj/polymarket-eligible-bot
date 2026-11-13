import WebSocket from 'ws';

export class TradeFeed {
    constructor() { this.tokens = []; this.events = []; this.ready = false; this.seen = new Set(); this.generation = 0; }
    watch(tokens) {
        if (tokens.join(',') === this.tokens.join(',') && this.socket) return;
        this.close(); this.tokens = [...tokens]; this.events = []; this.seen.clear();
        const initialized = new Set();
        if (tokens.length === 0) return;
        this.socket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', {
            handshakeTimeout: 12000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false,
        });
        this.lastMessageAt = Date.now();
        this.socket.on('open', () => {
            this.socket.send(JSON.stringify({ assets_ids: tokens, type: 'market', custom_feature_enabled: true }));
            this.ping = setInterval(() => {
                if (Date.now() - this.lastMessageAt > 30000) { lost(); this.socket?.terminate(); return; }
                if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('PING');
            }, 10000);
        });
        this.socket.on('message', raw => {
            this.lastMessageAt = Date.now();
            if (raw.toString() === 'PONG') return;
            let messages; try { messages = JSON.parse(raw.toString()); } catch { return; }
            for (const message of Array.isArray(messages) ? messages : [messages]) {
                if (message.event_type === 'book' && tokens.includes(message.asset_id)) {
                    initialized.add(message.asset_id); this.ready = initialized.size === tokens.length;
                }
                if (message.event_type !== 'last_trade_price' || !tokens.includes(message.asset_id)) continue;
                const at = Number(message.timestamp), price = Number(message.price), size = Number(message.size);
                if (!Number.isFinite(at) || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
                const key = `${message.asset_id}:${at}:${price}:${size}:${message.side}`;
                if (this.seen.has(key)) continue;
                this.seen.add(key);
                if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
                this.events.push({ tokenId: message.asset_id, at, price, size, side: message.side });
                if (this.events.length > 10000) { this.events = []; this.ready = false; this.generation++; }
            }
        });
        let disconnected = false;
        const lost = () => { if (disconnected) return; disconnected = true;
            this.ready = false; this.generation++; clearInterval(this.ping); };
        this.socket.on('close', lost); this.socket.on('error', lost);
    }
    drain() { return this.events.splice(0); }
    reconnect() {
        if (this.tokens.length && (!this.socket || this.socket.readyState === WebSocket.CLOSED)) {
            const tokens = [...this.tokens]; this.tokens = []; this.watch(tokens);
        }
    }
    close() {
        clearInterval(this.ping); this.ready = false;
        if (this.socket) { this.socket.removeAllListeners(); this.socket.on('error', () => {}); this.socket.terminate(); this.socket = null; }
    }
}
