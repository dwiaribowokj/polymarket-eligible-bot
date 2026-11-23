import WebSocket from 'ws';

const ENDPOINTS = [
    'wss://stream.binance.com:9443/ws/btcusdt@bookTicker',
    'wss://data-stream.binance.vision/ws/btcusdt@bookTicker',
];
const MAX_HISTORY_MS = 35000;
const STALE_MS = 3000;

export class BinanceLeadFeed {
    constructor({
        endpoints = ENDPOINTS,
        clock = Date.now,
        socketFactory = (url, options) => new WebSocket(url, options),
        maxHistoryMs = MAX_HISTORY_MS,
        staleMs = STALE_MS,
        reconnectBaseMs = 1000,
        reconnectMaxMs = 30000,
    } = {}) {
        Object.assign(this, { endpoints, clock, socketFactory, maxHistoryMs, staleMs, reconnectBaseMs, reconnectMaxMs });
        this.points = [];
        this.socket = null;
        this.endpointIndex = 0;
        this.failures = 0;
        this.reconnectTimer = null;
        this.closed = false;
        this.connected = false;
        this.messages = 0;
    }

    start() {
        if (this.closed || this.socket) return;
        const url = this.endpoints[this.endpointIndex % this.endpoints.length];
        let ws;
        try {
            ws = this.socketFactory(url, { handshakeTimeout: 5000, perMessageDeflate: false });
        } catch {
            this._scheduleReconnect();
            return;
        }
        this.socket = ws;
        ws.on('open', () => {
            if (this.socket !== ws || this.closed) return;
            this.connected = true;
            this.failures = 0;
        });
        ws.on('message', raw => {
            if (this.socket !== ws || this.closed) return;
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch { return; }
            const bid = Number(msg?.b), ask = Number(msg?.a);
            if (!(bid > 0) || !(ask > 0) || !Number.isFinite(bid) || !Number.isFinite(ask) || bid > ask) return;
            this.ingest({ at: this.clock(), bid, ask, mid: (bid + ask) / 2 });
        });
        const onDrop = () => {
            if (this.socket !== ws) return;
            this.socket = null;
            this.connected = false;
            try { ws.terminate(); } catch { /* ignore */ }
            if (!this.closed) {
                this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
                this._scheduleReconnect();
            }
        };
        ws.on('close', onDrop);
        ws.on('error', onDrop);
    }

    ingest(point) {
        if (!point || !Number.isFinite(point.at) || !Number.isFinite(point.mid) || point.mid <= 0) return;
        const last = this.points.at(-1);
        if (last && point.at < last.at) return;
        if (last && point.at === last.at) this.points[this.points.length - 1] = point;
        else this.points.push(point);
        this.messages++;
        const cutoff = point.at - this.maxHistoryMs;
        while (this.points.length > 1 && this.points[1].at < cutoff) this.points.shift();
    }

    _scheduleReconnect() {
        if (this.closed || this.reconnectTimer) return;
        this.failures++;
        const waitMs = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.failures - 1, 10));
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.closed) this.start();
        }, waitMs);
        this.reconnectTimer.unref?.();
    }

    latest(now = this.clock()) {
        const last = this.points.at(-1);
        if (!last || now < last.at || now - last.at > this.staleMs) return null;
        return last;
    }

    returnBps(lookbackMs, now = this.clock()) {
        const cur = this.latest(now);
        if (!cur || !Number.isFinite(lookbackMs) || lookbackMs <= 0) return null;
        const target = cur.at - lookbackMs;
        let prior = null;
        for (let i = this.points.length - 1; i >= 0; i--) {
            if (this.points[i].at <= target) { prior = this.points[i]; break; }
        }
        if (!prior || target - prior.at > this.staleMs) return null;
        return ((cur.mid - prior.mid) / prior.mid) * 10000;
    }

    adverseMove(sideIndex, lookbackMs, thresholdBps, now = this.clock()) {
        const ret = this.returnBps(lookbackMs, now);
        if (ret === null) return false;
        const dir = sideIndex === 0 ? 1 : -1;
        return dir * ret <= -thresholdBps;
    }

    status(now = this.clock()) {
        const cur = this.latest(now);
        return {
            connected: this.connected,
            ready: cur !== null && this.returnBps(5000, now) !== null,
            mid: cur?.mid ?? null,
            ageMs: cur ? now - cur.at : null,
            ret3sBps: this.returnBps(3000, now),
            ret5sBps: this.returnBps(5000, now),
            samples: this.points.length,
            messages: this.messages,
            failures: this.failures,
        };
    }

    close() {
        this.closed = true;
        this.connected = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        if (this.socket) {
            try { this.socket.removeAllListeners(); this.socket.on('error', () => {}); this.socket.terminate(); } catch { /* ignore */ }
            this.socket = null;
        }
    }
}
