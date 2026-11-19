import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LiveBookHistory } from '../../src/laya-live/book-history.js';
import { fee, round } from '../../src/restart/math.js';

export const QUOTE_POLICY = Object.freeze({
    slots: Object.freeze([90, 60, 30]), leadMs: 5000, trailMs: 15000,
    sampleMs: 100, maxOffsetMs: 300, maxAgeMs: 5000, retainMs: 360000,
    maxSamples: 1600, maxAsks: 128, gasUsd: 0.05, maxSpread: 0.02,
    timingBasis: 'first_scheduled_book_sample_at_or_after_ready_not_exchange_arrival',
    matchBasis: 'visible_fak_principal_budget_no_queue_or_competing_flow',
});
const Q = QUOTE_POLICY;
const time = n => Number.isSafeInteger(n) && n >= 0;
const ticks = new Set([0.1, 0.01, 0.001, 0.0001]);
const grid = (p, tick) => Number.isFinite(p) && Math.abs(p / tick - Math.round(p / tick)) <= 1e-8;
const price = p => Number.isFinite(p) && p > 0 && p < 1;
const unavailable = reason => ({ status: 'unavailable', reason });

function validMarket(m) {
    return m && time(m.open) && m.end - m.open === 300000 && m.open % 300000 === 0
        && m.slug === 'btc-updown-5m-' + (m.open / 1000) && /^0x[0-9a-f]{64}$/i.test(m.conditionId)
        && Array.isArray(m.tokens) && m.tokens.length === 2 && m.tokens[0] !== m.tokens[1]
        && m.tokens.every(t => typeof t === 'string' && /^\d+$/.test(t))
        && m.accepting === true && m.negRisk === false && Number.isFinite(m.minimum) && m.minimum > 0
        && Number.isFinite(m.fee?.rate) && m.fee.rate >= 0 && m.fee.rate <= 1
        && Number.isFinite(m.fee?.exponent) && m.fee.exponent > 0 && typeof m.fee.takerOnly === 'boolean';
}
const identity = (m, ts) => [m.conditionId, m.tokens, m.minimum, ts, m.fee, m.negRisk];

async function readTicks(m, clock) {
    return Promise.all(m.tokens.map(async token => {
        const url = new URL('https://clob.polymarket.com/tick-size');
        url.searchParams.set('token_id', token);
        url.searchParams.set('_paper_verify', randomUUID());
        const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store' }, signal: AbortSignal.timeout(1800) });
        const received = clock(), serverAt = Date.parse(response.headers.get('date'));
        const age = response.headers.get('age'), cache = response.headers.get('cf-cache-status');
        if (!response.ok || !time(serverAt) || serverAt > received + 1000 || received - serverAt > Q.maxAgeMs
            || (age !== null && age !== '0') || (cache !== null && !['DYNAMIC', 'BYPASS', 'MISS', 'EXPIRED'].includes(cache.toUpperCase()))) {
            await response.body?.cancel(); throw new Error('tick_endpoint_unverified');
        }
        const tick = Number((await response.json()).minimum_tick_size);
        if (!ticks.has(tick)) throw new Error('tick_endpoint_value_invalid');
        return tick;
    }));
}

function depth(book, m, i, tick, now) {
    if (book?.tokenId !== m.tokens[i] || book.conditionId !== m.conditionId) return null;
    if (![book.timestamp, book.fetchedAt].every(n => time(n) && n <= now && now - n <= Q.maxAgeMs)
        || book.timestamp > book.fetchedAt || !ticks.has(tick)) return null;
    if (book.tick !== undefined && (!ticks.has(book.tick) || book.tick < tick || !grid(book.tick, tick))) return null;
    if (![book.bids, book.asks].every(side => Array.isArray(side) && side.every(l =>
        price(l.price) && grid(l.price, tick) && Number.isFinite(l.size) && l.size > 0))) return null;
    if (book.asks.some((l, j) => j && book.asks[j - 1].price >= l.price)
        || book.bids.some((l, j) => j && book.bids[j - 1].price <= l.price)
        || book.bids[0]?.price > book.asks[0]?.price) return null;
    return { tokenId: book.tokenId, conditionId: book.conditionId, timestamp: book.timestamp, fetchedAt: book.fetchedAt,
        tick, streamTick: book.tick ?? null, bids: book.bids.slice(0, 1), asks: book.asks.slice(0, Q.maxAsks),
        depthTruncated: book.asks.length > Q.maxAsks };
}

// The clock-driven tape is populated independently of decisions, fills and eventual outcomes.
// A gap or invalid first sample cannot be replaced with a more favorable later book.
export class PairedQuoteTape {
    constructor({ clock = Date.now, stream, tickReader = readTicks, schedule = setInterval, cancel = clearInterval } = {}) {
        Object.assign(this, { clock, tickReader, schedule, cancel });
        this.stream = stream ?? new LiveBookHistory({ clock });
        this.samples = []; this.accepted = 0; this.rejected = 0; this.tickFailures = 0;
    }
    watch(market) {
        if (!validMarket(market)) throw new Error('invalid_paired_quote_market');
        if (this.closed) throw new Error('paired_quote_tape_closed');
        const m = { slug: market.slug, open: market.open, end: market.end, conditionId: market.conditionId,
            tokens: [...market.tokens], minimum: market.minimum, accepting: true, negRisk: false,
            fee: { rate: market.fee.rate, exponent: market.fee.exponent, takerOnly: market.fee.takerOnly } };
        if (this.market?.slug === m.slug && !isDeepStrictEqual(this.market, m))
            throw new Error('paired_quote_market_identity_changed');
        if (this.market && this.market.open > m.open) throw new Error('paired_quote_market_regressed');
        if (this.market?.slug !== m.slug) {
            this.market = m; this.tickProof = null; this.tickRequest = null; this.nextTickRead = 0;
            this.stream.watch(m.tokens, m);
        }
        if (!this.timer) {
            this.timer = this.schedule(() => this.sample(), Q.sampleMs);
            this.timer?.unref?.();
        }
    }
    sample() {
        const m = this.market, now = this.clock();
        if (this.closed || !m || !time(now)) return;
        while (this.samples.length && this.samples[0].at < now - Q.retainMs) this.samples.shift();
        if (!Q.slots.some(slot => {
            const delta = now - (m.end - slot * 1000);
            return delta >= -Q.leadMs && delta <= Q.trailMs;
        })) return;
        this.stream.watch(m.tokens, m);
        if (!this.tickRequest && now >= this.nextTickRead) {
            this.nextTickRead = now + 2500;
            const req = Promise.resolve().then(() => this.tickReader(m, this.clock)).then(values => {
                const at = this.clock();
                if (this.closed || this.market !== m) return;
                if (!Array.isArray(values) || values.length !== 2 || !values.every(t => ticks.has(t))
                    || !time(at) || at < now || at - now > 2000) throw new Error('tick_read_invalid');
                this.tickProof = { ticks: [...values], at, startedAt: now };
            }).catch(() => {
                if (!this.closed && this.market === m) { this.tickProof = null; this.tickFailures++; }
            }).finally(() => { if (this.tickRequest === req) this.tickRequest = null; });
            this.tickRequest = req;
        }
        const previous = this.samples.at(-1);
        if (previous && now <= previous.at) return;
        const proof = this.tickProof, frame = this.stream.snapshot(now, false);
        const row = { at: now, market: m, generation: this.stream.generation };
        if (!proof || now < proof.at || now - proof.startedAt > Q.maxAgeMs) row.reason = 'tick_unverified';
        else if (!Array.isArray(frame) || frame.length !== 2) row.reason = 'book_stream_unavailable';
        else {
            const pair = frame.map((b, i) => depth(b, m, i, proof.ticks[i], now));
            if (!pair.every(Boolean)) row.reason = 'book_depth_identity_or_age';
            else Object.assign(row, { pair, ticks: proof.ticks, tickVerifiedAt: proof.at });
        }
        if (row.pair) this.accepted++; else this.rejected++;
        this.samples.push(row);
        if (this.samples.length > Q.maxSamples) this.samples.shift();
    }
    select({ slug, conditionId, tokenId, targetAt }) {
        const now = this.clock(), base = { targetAt };
        if (!time(targetAt) || !time(now)) return { ...base, ...unavailable('invalid_ready_time') };
        if (targetAt > now) return { ...base, status: 'pending', reason: 'target_in_future' };
        const index = this.samples.findIndex(s => s.market.slug === slug && s.at >= targetAt);
        if (index < 0) return now - targetAt <= Q.maxOffsetMs
            ? { ...base, status: 'pending', reason: 'awaiting_sample' } : { ...base, ...unavailable('no_timely_sample') };
        const row = this.samples[index], prior = this.samples[index - 1], i = row.market.tokens.indexOf(tokenId);
        Object.assign(base, { observedAt: row.at, offsetMs: row.at - targetAt });
        if (row.market.conditionId !== conditionId || i < 0) return { ...base, ...unavailable('quote_identity_changed') };
        if (row.at - targetAt > Q.maxOffsetMs || !prior || prior.market.slug !== slug
            || row.at - prior.at > Q.maxOffsetMs) return { ...base, ...unavailable('no_timely_sample') };
        if (row.reason) return { ...base, ...unavailable(row.reason) };
        if (!prior.pair || prior.generation !== row.generation) return { ...base, ...unavailable('book_continuity_unproven') };
        return { ...base, status: 'ready', market: { ...structuredClone(row.market), ticks: [...row.ticks] },
            generation: row.generation, tickVerifiedAt: row.tickVerifiedAt, index: i, book: structuredClone(row.pair[i]) };
    }
    status() {
        return { market: this.market?.slug ?? null, connected: !this.closed && !!this.stream.status?.(this.clock())?.connected,
            retained: this.samples.length, accepted: this.accepted, rejected: this.rejected, tickFailures: this.tickFailures,
            lastSampleAt: this.samples.at(-1)?.at ?? null, lastReason: this.samples.at(-1)?.reason ?? null };
    }
    close() {
        this.closed = true;
        if (this.timer) this.cancel(this.timer);
        this.stream.close();
    }
}

// A BUY FAK signs a cash amount (shares * frozen limit). Better displayed prices
// can yield more than five shares. Fees are charged on each consumed level.
export function simulatePaperFak({ quote, limitPrice, shares = 5, gasUsd = Q.gasUsd, validationIdentity, stage = 'validation' } = {}) {
    if (stage !== 'validation' && stage !== 'arrival') return unavailable('unknown_quote_stage');
    if (quote?.status !== 'ready') return unavailable(quote?.reason || 'missing_quote');
    const { book, market, observedAt, targetAt, index } = quote;
    if (!validMarket(market) || !Array.isArray(market.ticks) || market.ticks.length !== 2
        || !market.ticks.every(t => ticks.has(t)) || ![0, 1].includes(index) || book?.tokenId !== market.tokens[index]
        || book.conditionId !== market.conditionId || book.tick !== market.ticks[index]
        || !time(observedAt) || !time(targetAt) || observedAt < targetAt || observedAt - targetAt > Q.maxOffsetMs
        || !depth(book, market, index, book.tick, observedAt)) return unavailable('quote_proof_invalid');
    if (validationIdentity !== undefined) {
        let expected;
        try { expected = typeof validationIdentity === 'string' ? JSON.parse(validationIdentity) : validationIdentity; }
        catch { return unavailable('snapshot_metadata_invalid'); }
        // Only portable fee fields are copied to the tape. Validate any additional
        // fee fields in the actual decision guard upstream.
        if (!Array.isArray(expected) || expected.length !== 6 || expected[0] !== market.conditionId
            || !isDeepStrictEqual(expected[1], market.tokens) || expected[2] !== market.minimum
            || !isDeepStrictEqual(expected[3], market.ticks) || expected[5] !== false
            || !Object.entries(market.fee).every(([k,v]) => expected[4]?.[k] === v)) return unavailable('snapshot_metadata_changed');
    }
    if (shares !== 5 || !price(limitPrice) || !grid(limitPrice, book.tick) || !Number.isFinite(gasUsd) || gasUsd < 0)
        return unavailable('frozen_order_invalid');
    const bestAsk = book.asks[0]?.price ?? null, bestBid = book.bids[0]?.price ?? null;
    const budget = round(shares * limitPrice);
    const base = { stage, targetAt, observedAt, offsetMs: observedAt - targetAt, exchangeAt: book.timestamp,
        receivedAt: book.fetchedAt, tokenId: book.tokenId, conditionId: market.conditionId, index,
        limitPrice, requestedShares: shares, principalBudget: budget, bestAsk, bestBid, tick: book.tick };
    const noFill = reason => ({ ...base, status: 'no_fill', reason, shares: 0, principal: 0,
        fees: 0, gas: 0, entryCost: 0, allInCost: 0, averagePrice: null });
    const remainingMs = market.end - observedAt;
    if (market.minimum > shares || remainingMs <= 0 || observedAt < market.open) return noFill('execution_constraints_changed');
    if (stage === 'validation') {
        if (remainingMs < 10000 || remainingMs > 90000) return noFill('execution_constraints_changed');
        if (bestBid === null || bestAsk === null) return noFill('no_two_sided_depth');
        if (bestAsk < (remainingMs <= 20000 ? 0.80 : 0.72) - 1e-8 || bestAsk > 0.90 + 1e-8
            || round(bestAsk - bestBid) > Q.maxSpread) return noFill('execution_constraints_changed');
    }
    // Once submitted, only the signed parameters constrain exchange matching;
    // a cheaper ask or a wider spread cannot retrospectively invalidate an order.
    if (bestAsk === null || bestAsk > limitPrice + 1e-8) return noFill('frozen_limit_unmarketable');
    let units = 0, principal = 0, fees = 0;
    for (const level of book.asks) {
        if (level.price > limitPrice + 1e-8) break;
        const fill = Math.floor((Math.min(level.size, (budget - principal) / level.price) + 1e-10) * 1e6) / 1e6;
        if (fill <= 0) break;
        units += fill; principal += fill * level.price; fees += fee(fill, level.price, market.fee);
        if (budget - principal < 1e-6) break;
    }
    if (budget - principal >= 1e-6 && book.depthTruncated && book.asks.at(-1).price < limitPrice)
        return unavailable('depth_truncated');
    if (!units) return noFill('insufficient_executable_depth');
    const full = budget - principal < 1e-6;
    return { ...base, status: full ? 'filled' : 'partial', shares: round(units), principal: round(principal), fees: round(fees),
        gas: gasUsd, entryCost: round(principal + fees), allInCost: round(principal + fees + gasUsd), averagePrice: round(principal / units) };
}
