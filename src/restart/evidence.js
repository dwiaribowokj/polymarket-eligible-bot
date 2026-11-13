import { EPS, round } from './math.js';

export function bookEvidence(market, books, now) {
    return { slug: market.slug, conditionId: market.conditionId, observedAt: now,
        remainingSeconds: round((market.end - now) / 1000), minimum: market.minimum,
        fee: market.fee, settlement: 'official_ctf_payout',
        books: books.map((book, index) => ({ index, tokenId: market.tokens[index], outcome: market.outcomes?.[index],
            tick: market.ticks?.[index] ?? market.tick, timestamp: book.timestamp ?? null,
            fetchedAt: book.fetchedAt ?? now, dataAgeMs: book.timestamp ? Math.max(0, now - book.timestamp) : null,
            bids: (book.bids || []).map(level => ({ ...level })), asks: (book.asks || []).map(level => ({ ...level })) })) };
}

export function quoteQuality(plan, books, settings, { requireDepth = true } = {}) {
    const rule = settings.lateQuality;
    if (!rule) return { reason: null };
    const order = plan.orders[0], book = books[order.index];
    const bid = book.bids[0]?.price, ask = book.asks[0]?.price;
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return { reason: 'missing_bid_or_ask' };
    const spread = round(ask - bid);
    const depth = round(book.asks.filter(l => l.price <= order.price + EPS).reduce((s, l) => s + l.size, 0));
    const reason = spread < -EPS ? 'crossed_book' : spread > rule.maxSpread + EPS ? 'wide_spread'
        : requireDepth && depth < rule.minDepth - EPS ? 'insufficient_entry_depth' : null;
    return { reason, spread, depth };
}

export class QuoteStability {
    constructor() { this.slug = null; this.samples = []; }
    reset() { this.samples = []; }
    observe(slug, index, price, now, rule) {
        if (rule.stableMs === 0) {
            this.reset();
            return { reason: null, mode: 'execution_recheck', stableMs: 0, move: 0 };
        }
        if (slug !== this.slug) { this.slug = slug; this.reset(); }
        const previous = this.samples.at(-1);
        if (previous && (previous.index !== index || now - previous.at > rule.maxSampleGapMs || now <= previous.at)) this.reset();
        this.samples.push({ index, price, at: now });
        // Keep the sample immediately before the window, so sparse polling cannot imply stability.
        while (this.samples.length > 1 && this.samples[1].at <= now - rule.stableMs) this.samples.shift();
        const move = Math.max(...this.samples.map(s => s.price)) - Math.min(...this.samples.map(s => s.price));
        if (move > rule.maxMove + EPS) { this.samples = [this.samples.at(-1)]; return { reason: 'unstable_quote', stableMs: 0, move: round(move) }; }
        const stableMs = now - this.samples[0].at;
        return { reason: stableMs < rule.stableMs ? 'quote_warmup' : null, stableMs, move: round(move) };
    }
}
