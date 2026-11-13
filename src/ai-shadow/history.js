import crypto from 'node:crypto';
import WebSocket from 'ws';
import { compactInput } from './encoding.js';

export class BookHistory {
    constructor({ onEvent = () => {}, clock = Date.now } = {}) { this.onEvent = onEvent; this.clock = clock; this.reset(); }
    reset() { this.books = new Map(); this.history = []; this.readyAt = null; this.lastAt = null; this.generation = (this.generation || 0) + 1; }
    watch(tokens) {
        this.close(); this.reset(); this.tokens = [...tokens];
        const socket = this.socket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market',
            { handshakeTimeout: 5000, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
        let lost = false;
        const invalidate = () => { if (lost) return; lost = true; clearInterval(this.ping); this.reset(); this.onEvent('book_gap'); };
        socket.on('open', () => {
            const openedAt=this.clock();
            socket.send(JSON.stringify({ assets_ids: tokens, type: 'market', custom_feature_enabled: true }));
            this.ping = setInterval(() => {
                if (this.clock() - (this.lastAt || openedAt) > 5000) { invalidate(); socket.terminate(); }
                else if (socket.readyState === WebSocket.OPEN) socket.send('PING');
            }, 2000);
        });
        socket.on('message', data => {
            if (data.toString() === 'PONG') return;
            try { const rows = JSON.parse(data.toString()); for (const row of Array.isArray(rows) ? rows : [rows]) this.ingest(row); }
            catch { invalidate(); socket.terminate(); }
        });
        socket.on('close', invalidate); socket.on('error', invalidate);
    }
    ingest(row, receivedAt = this.clock()) {
        const at = Number(row.timestamp);
        if (!Number.isFinite(at) || at > receivedAt || receivedAt - at > 5000) return;
        if (this.lastAt && receivedAt - this.lastAt > 5000) { this.reset(); this.onEvent('book_gap'); this.socket?.terminate(); return; }
        if (row.event_type === 'tick_size_change') { this.reset(); this.onEvent('book_tick_changed'); this.socket?.terminate(); return; }
        const levels = rows => new Map((rows || []).map(l => [Number(l.price), Number(l.size)])
            .filter(([p, s]) => Number.isFinite(p) && p > 0 && p < 1 && Number.isFinite(s) && s > 0));
        if (row.event_type === 'book' && this.tokens?.includes(row.asset_id)) {
            const old = this.books.get(row.asset_id); if (old && at < old.at) return;
            this.books.set(row.asset_id, { bids: levels(row.bids), asks: levels(row.asks), at,
                conditionId: row.market ?? old?.conditionId,
                tick: row.tick_size === undefined ? old?.tick : Number(row.tick_size), receivedAt });
        } else if (row.event_type === 'price_change') {
            for (const change of row.price_changes || []) {
                if (!this.tokens?.includes(change.asset_id)) continue;
                const book = this.books.get(change.asset_id); if (!book || at < book.at) continue;
                if (row.market !== book.conditionId) { this.reset(); this.onEvent('book_identity_changed'); this.socket?.terminate(); return; }
                const side = change.side === 'BUY' ? book.bids : change.side === 'SELL' ? book.asks : null;
                const price = Number(change.price), size = Number(change.size);
                if (!side || !Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(size) || size < 0) continue;
                if (size === 0) side.delete(price); else side.set(price, size); book.at = at; book.receivedAt = receivedAt;
            }
        } else return;
        this.lastAt = receivedAt;
        if (this.tokens.every(t => this.books.has(t))) this.readyAt ??= receivedAt;
        if (this.readyAt && (!this.history.length || receivedAt - this.history.at(-1).receivedAt >= 1000)) {
            this.history.push({ at, receivedAt, books: this.snapshot(receivedAt, false) });
            this.history = this.history.filter(p => p.receivedAt >= receivedAt - 185000);
        }
    }
    snapshot(now = this.clock(), requireWarm = true) {
        if (!this.tokens?.every(t => this.books.has(t)) || !this.lastAt || now - this.lastAt > 5000
            || requireWarm && (!this.readyAt || now - this.readyAt < 180000)) return null;
        return this.tokens.map(t => {
            const book = this.books.get(t);
            if (now - book.at > 5000) return null;
            return { tokenId: t, conditionId: book.conditionId, tick: book.tick, timestamp: book.at, fetchedAt: book.receivedAt,
                bids: [...book.bids].sort((a,b) => b[0]-a[0]).map(([price,size]) => ({price,size})),
                asks: [...book.asks].sort((a,b) => a[0]-b[0]).map(([price,size]) => ({price,size})) };
        }).every(Boolean) ? this.tokens.map(t => {
            const b=this.books.get(t); return { tokenId:t, conditionId:b.conditionId, tick:b.tick, timestamp:b.at, fetchedAt:b.receivedAt,
                bids:[...b.bids].sort((a,c)=>c[0]-a[0]).map(([price,size])=>({price,size})),
                asks:[...b.asks].sort((a,c)=>a[0]-c[0]).map(([price,size])=>({price,size})) };
        }) : null;
    }
    close() { clearInterval(this.ping); if (this.socket) { this.socket.removeAllListeners(); this.socket.on('error',()=>{}); this.socket.terminate(); this.socket=null; } }
}

const rounded = (n, decimals = 2) => Number(n.toFixed(decimals));
// Lossless with respect to the existing rounded features. JSON text avoids the
// extra whitespace that Laya's Python serializer adds to a state object.
export function encodeFeatures(state) {
    const cents = value => rounded((value - state.opening_twap) * 100, 0);
    return compactInput({ seconds: state.seconds, open_usd: state.opening_twap,
        spot_twap_delta_cents: [cents(state.spot), cents(state.twap)],
        margin_cents: rounded(state.margin_usd * 100, 0),
        sigma_milliusd_sqrt_s: rounded(state.volatility_usd_sqrt_s * 1000, 0),
        returns_millibps_5_15_30_60_180: state.returns_bps_5_15_30_60_180.map(v => rounded(v * 1000, 0)),
        bars_30s_OHLC_delta_cents_oldest_first: state.bars_30s_OHLC_oldest_first.map(bar => bar.map(cents)),
        books_price_cents_up_down: state.books_up_down.map(book => Object.fromEntries(['bids', 'asks'].map(side =>
            [side, book[side].map(([price, size]) => [rounded(price * 100, 2), size])]))),
        fee: [state.fee_rate, state.fee_exponent], shares: state.shares, cap_usd: state.entry_cap,
        ...(state.limit_cost_up_down ? { limit_cost_up_down: state.limit_cost_up_down } : {}), allowed: state.allowed });
}
export function makeFeatures(signal, market, books, ws, now) {
    if(books.length!==2 || books.some(b=>!Number.isFinite(b.timestamp) || b.timestamp>now || now-b.timestamp>5000))throw new Error('snapshot_book_stale_or_future');
    const points = signal.spot.filter(p => p.at <= now && p.receivedAt <= now && p.at >= now - 185000);
    const latest = points.at(-1), status = signal.status(now), opening = signal.openings.get(market.open);
    if (!status.ready || !latest || !opening || !market.reference || market.reference.value !== opening.value
        || now - points[0].at < 180000 || !ws.snapshot(now) || points.some((p,i) => i && p.at-points[i-1].at>5000))
        throw new Error('history_not_ready');
    if (signal.twap.at > now || signal.twap.receivedAt > now) throw new Error('future_twap');
    const bars = [];
    for (let i=6; i>0; i--) {
        const start=latest.at-i*30000, end=start+30000;
        const first=points.findLast(p=>p.at<=start), within=points.filter(p=>p.at>start && p.at<=end);
        if (!first || start-first.at>5000 || !within.length) throw new Error('bar_history_gap');
        const values=[first.value,...within.map(p=>p.value)];
        bars.push(values.length ? [rounded(values[0]),rounded(Math.max(...values)),rounded(Math.min(...values)),rounded(values.at(-1))] : null);
    }
    const returns = [5,15,30,60,180].map(seconds => {
        const p=points.findLast(p=>p.at<=latest.at-seconds*1000);
        if (!p || latest.at-seconds*1000-p.at>5000) throw new Error('return_history_gap');
        return rounded((latest.value/p.value-1)*10000,3);
    });
    let variance=0,elapsed=0;
    for(let i=1;i<points.length;i++){variance+=(points[i].value-points[i-1].value)**2;elapsed+=(points[i].at-points[i-1].at)/1000;}
    const state={ market:market.slug, seconds:rounded((market.end-now)/1000), opening_twap:rounded(opening.value),
        spot:rounded(latest.value), twap:rounded(signal.twap.value), margin_usd:rounded(signal.twap.value-opening.value),
        volatility_usd_sqrt_s:rounded(Math.sqrt(variance/elapsed),3), returns_bps_5_15_30_60_180:returns,
        bars_30s_OHLC_oldest_first:bars, books_up_down:books.map(b=>({
            bids:b.bids.slice(0,5).map(l=>[rounded(l.price,4),rounded(l.size,2)]),
            asks:b.asks.slice(0,5).map(l=>[rounded(l.price,4),rounded(l.size,2)])})),
        fee_rate:market.fee.rate, fee_exponent:market.fee.exponent, shares:5, entry_cap:5 };
    const observedAt=Math.min(latest.at,signal.twap.at,...books.map(b=>b.timestamp));
    return { state, observedAt, inputHash:crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex') };
}
