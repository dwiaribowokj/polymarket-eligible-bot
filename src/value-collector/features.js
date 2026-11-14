import { createHash } from 'node:crypto';
import { validatedEarlyPaperBooks } from '../premarket-paper/early-book.js';
import { fee, round } from '../restart/math.js';

export const VALUE_OBSERVATION_SCHEMA = 'btc5m-value-observation-v1';
const integer = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isFinite(value) && value > 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const pointCopy = point => ({ at: point.at, value: point.value, receivedAt: point.receivedAt });
const freeze = value => {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
};

function limitsFor(config, btc) {
    const limits = { dataAgeMs: config.dataAgeMs ?? 5000, historyMs: config.historyMs ?? 180000,
        maxGapMs: config.maxGapMs ?? 5000, maxFeedDifferenceUsd: config.maxFeedDifferenceUsd
            ?? config.control?.lateSignal?.maxFeedDifferenceUsd ?? btc?.rule?.maxFeedDifferenceUsd ?? 3,
        quoteShares: config.quoteShares ?? [5, 10, 20], gasUsd: config.gasUsd };
    if (!integer(limits.dataAgeMs) || limits.dataAgeMs < 1 || limits.dataAgeMs > 5000
        || !integer(limits.historyMs) || limits.historyMs < 60000
        || !integer(limits.maxGapMs) || limits.maxGapMs < 1 || limits.maxGapMs > 5000
        || !Number.isFinite(limits.maxFeedDifferenceUsd) || limits.maxFeedDifferenceUsd < 0
        || !Array.isArray(limits.quoteShares) || !limits.quoteShares.length
        || !limits.quoteShares.every(positive) || new Set(limits.quoteShares).size !== limits.quoteShares.length
        || !Number.isFinite(limits.gasUsd) || limits.gasUsd < 0)
        throw new Error('value_observation_config_invalid');
    return { ...limits, quoteShares: [...limits.quoteShares] };
}

function pointStatus(point, at) {
    if (!point || !integer(point.at) || !integer(point.receivedAt) || !positive(point.value)) return 'invalid';
    if (point.at > at) return 'future_source';
    if (point.receivedAt > at) return 'late_receipt';
    if (point.receivedAt < point.at) return 'clock_conflict';
    return 'causal';
}

function history(btc, at, limits) {
    const points = [], excluded = { invalid: 0, future_source: 0, late_receipt: 0, clock_conflict: 0 };
    for (const point of Array.isArray(btc?.spot) ? btc.spot : []) {
        const status = pointStatus(point, at);
        if (status === 'causal') points.push(pointCopy(point));
        else excluded[status]++;
    }
    points.sort((a, b) => a.at - b.at || a.receivedAt - b.receivedAt);
    const latest = points.at(-1), ageMs = latest ? at - latest.at : null;
    const coverage = latest ? integrate(points, latest.at - limits.historyMs, latest.at, limits.maxGapMs)
        : { status: 'history_missing', integralUsdSeconds: null };
    const status = !latest ? 'history_missing' : ageMs > limits.dataAgeMs ? 'history_stale' : coverage.status;
    return { status, asOf: latest?.at ?? null, latest: latest ?? null, ageMs, points, excluded,
        requestedHistoryMs: limits.historyMs, availableHistoryMs: latest ? latest.at - points[0].at : 0,
        coverage: { start: latest ? latest.at - limits.historyMs : null, end: latest?.at ?? null, ...coverage } };
}

function integrate(points, start, end, maxGapMs) {
    const missing = status => ({ status, integralUsdSeconds: null });
    if (end < start || !points.length || end > points.at(-1).at) return missing('history_missing');
    const firstIndex = points.findLastIndex(point => point.at <= start);
    if (firstIndex < 0 || start - points[firstIndex].at > maxGapMs) return missing('history_missing');
    let previous = points[firstIndex], cursor = start, integral = 0;
    // Include every value at the anchor timestamp so a conflicting duplicate cannot disappear.
    const anchor = points.filter(point => point.at === previous.at);
    if (anchor.some(point => point.value !== previous.value)) return missing('history_conflict');
    for (const point of points.slice(firstIndex + 1)) {
        if (point.at > end) break;
        if (point.at === previous.at) {
            if (point.value !== previous.value) return missing('history_conflict');
            continue;
        }
        if (point.at - previous.at > maxGapMs) return missing('history_gap');
        integral += previous.value * (point.at - cursor) / 1000;
        previous = point; cursor = point.at;
    }
    if (end - previous.at > maxGapMs) return missing('history_gap');
    integral += previous.value * (end - cursor) / 1000;
    return { status: 'observed', integralUsdSeconds: integral };
}

function openingFor(market, btc, at, limits) {
    const observed = btc?.openings?.get?.(market.open), reference = market.reference;
    const openingStatus = pointStatus(observed, at);
    const referencePoint = reference && { at: reference.observedAt, receivedAt: reference.receivedAt, value: reference.value };
    const referenceStatus = pointStatus(referencePoint, at);
    const causalObserved = openingStatus === 'causal' ? pointCopy(observed) : null;
    const causalReference = referenceStatus === 'causal' ? {
        source: reference.source, open: reference.open, end: reference.end,
        observedAt: reference.observedAt, receivedAt: reference.receivedAt, value: reference.value } : null;
    let status = 'verified';
    if (!reference || !observed) status = 'reference_missing';
    else if (openingStatus !== 'causal' || referenceStatus !== 'causal') status = 'reference_noncausal';
    else if (reference.source !== 'chainlink_twap_60s' || reference.open !== market.open || reference.end !== market.end
        || reference.observedAt !== market.open || observed.at !== market.open
        || reference.receivedAt > market.open + limits.dataAgeMs || observed.receivedAt > market.open + limits.dataAgeMs)
        status = 'reference_unverified';
    else if (observed.value !== reference.value) status = 'reference_conflict';
    return { status, observed: causalObserved, reference: causalReference,
        observedInputStatus: openingStatus, referenceInputStatus: referenceStatus };
}

function twapFor(btc, at, limits) {
    if (!btc?.twap) return { status: 'twap_missing', point: null, ageMs: null };
    const status = pointStatus(btc.twap, at);
    if (status !== 'causal') return { status: `twap_${status}`, point: null, ageMs: null };
    const ageMs = at - btc.twap.at;
    return { status: ageMs > limits.dataAgeMs ? 'twap_stale' : 'observed', point: pointCopy(btc.twap), ageMs };
}

function closingFor(market, spot, opening, at, limits) {
    const windowStart = market.end - 60000, asOf = spot.asOf;
    const base = { status: null, method: 'piecewise_constant_source_observations',
        cutoffBasis: 'latest_causal_spot_source_time', snapshotAt: at, asOf,
        windowStart, windowEnd: market.end, referenceUsd: opening.status === 'verified' ? opening.reference.value : null,
        knownSeconds: asOf === null ? null : Math.max(0, Math.min(60, (asOf - windowStart) / 1000)),
        remainingSeconds: asOf === null ? null : Math.max(0, Math.min(60, (market.end - asOf) / 1000)),
        observedIntegralUsdSeconds: null, observedMeanUsd: null, requiredRemainingAverageUsd: null,
        upComparator: '>=', downComparator: '<', tieRule: 'UP' };
    const result = status => ({ ...base, status });
    if (opening.status !== 'verified') return result(opening.status);
    if (at >= market.end || at < market.open) return result('clock_outside_market');
    if (asOf === null) return result('history_missing');
    if (at - asOf > limits.dataAgeMs) return result('history_stale');
    if (asOf <= windowStart) return result('before_window');
    const observed = integrate(spot.points, windowStart, asOf, limits.maxGapMs);
    if (observed.status !== 'observed') return result(observed.status);
    return { ...base, status: 'observed', observedIntegralUsdSeconds: observed.integralUsdSeconds,
        observedMeanUsd: observed.integralUsdSeconds / base.knownSeconds,
        requiredRemainingAverageUsd: (base.referenceUsd * 60 - observed.integralUsdSeconds) / base.remainingSeconds };
}

function rollingFor(spot, twap, limits) {
    const end = twap.point?.at ?? null;
    const base = { status: twap.status, cutoffBasis: 'causal_twap_source_time',
        windowStart: end === null ? null : end - 60000, windowEnd: end,
        feedTwapUsd: twap.point?.value ?? null, observedIntegralUsdSeconds: null,
        observedMeanUsd: null, differenceUsd: null, maxDifferenceUsd: limits.maxFeedDifferenceUsd };
    if (twap.status !== 'observed') return base;
    const observed = integrate(spot.points, end - 60000, end, limits.maxGapMs);
    if (observed.status !== 'observed') return { ...base, status: observed.status };
    const observedMeanUsd = observed.integralUsdSeconds / 60;
    const differenceUsd = Math.abs(observedMeanUsd - twap.point.value);
    return { ...base, status: differenceUsd > limits.maxFeedDifferenceUsd ? 'twap_source_mismatch' : 'consistent',
        observedIntegralUsdSeconds: observed.integralUsdSeconds, observedMeanUsd, differenceUsd };
}

function quote(book, requestedShares, market, gasUsd) {
    const availableShares = book.asks.reduce((sum, level) => sum + level.size, 0), depthTake = [];
    let remaining = requestedShares, notionalUsd = 0, feeUsd = 0;
    for (const level of [...book.asks].sort((a, b) => a.price - b.price)) {
        const shares = Math.min(remaining, level.size);
        if (shares <= 0) break;
        depthTake.push({ price: level.price, shares });
        notionalUsd += shares * level.price; feeUsd += fee(shares, level.price, market.fee);
        remaining -= shares;
    }
    const status = requestedShares < market.minimum ? 'below_market_minimum'
        : availableShares < requestedShares ? 'insufficient_depth' : 'quoted';
    const quoted = status === 'quoted', allInCostUsd = quoted ? round(notionalUsd + feeUsd + gasUsd) : null;
    return { status, requestedShares, availableShares, depthTake, quotedShares: quoted ? requestedShares : null,
        notionalUsd: quoted ? round(notionalUsd) : null, feeUsd: quoted ? round(feeUsd) : null, assumedGasUsd: gasUsd,
        allInCostUsd, costPerShareUsd: quoted ? allInCostUsd / requestedShares : null,
        vwapUsd: quoted ? notionalUsd / requestedShares : null, marginalAskUsd: quoted ? depthTake.at(-1).price : null,
        basis: 'displayed_depth_at_observation_not_future_execution', feeBasis: 'existing_schedule_per_depth_level',
        gasBasis: 'fixed_assumption_per_complete_quote', payoutPerWinningShareUsd: 1 };
}

/** Freeze causal evidence only; labels are written to a separate append-only stream. */
export function buildValueObservation({ market, btc, pair, at, scheduledAt = at, config = {} }) {
    const slugOpen = /^btc-updown-5m-(\d+)$/.exec(market?.slug ?? '');
    if (!integer(at) || !integer(scheduledAt) || !integer(market?.open) || !integer(market?.end)
        || market.end - market.open !== 300000 || !slugOpen || Number(slugOpen[1]) * 1000 !== market.open
        || typeof market.conditionId !== 'string' || !market.conditionId
        || !Array.isArray(market.tokens) || market.tokens.length !== 2 || !market.tokens.every(token => typeof token === 'string' && token)
        || market.tokens[0] === market.tokens[1]) throw new Error('value_observation_identity_or_clock_invalid');
    const limits = limitsFor(config, btc), reasons = [];
    if (at < scheduledAt) reasons.push('clock_before_schedule');
    if (at < market.open || at >= market.end) reasons.push('clock_outside_market');
    const spot = history(btc, at, limits), opening = openingFor(market, btc, at, limits), twap = twapFor(btc, at, limits);
    const closingTwap = closingFor(market, spot, opening, at, limits), rollingTwap = rollingFor(spot, twap, limits);
    if (spot.status !== 'observed') reasons.push(spot.status);
    for (const [status, count] of Object.entries(spot.excluded)) if (count) reasons.push(`spot_${status}_excluded`);
    if (opening.status !== 'verified') reasons.push(opening.status);
    if (twap.status !== 'observed') reasons.push(twap.status);
    if (!['observed', 'before_window'].includes(closingTwap.status)) reasons.push(closingTwap.status);
    if (rollingTwap.status !== 'consistent') reasons.push(rollingTwap.status);
    let books = null, bookStatus = 'books_missing';
    if (pair) {
        try {
            books = validatedEarlyPaperBooks(market, pair, at, { maxVerificationAgeMs: limits.dataAgeMs,
                maxMetadataAgeMs: limits.dataAgeMs, maxHttpDateAgeMs: limits.dataAgeMs });
            bookStatus = 'verified';
        }
        catch (error) { bookStatus = error.message; }
    }
    if (bookStatus !== 'verified') reasons.push(bookStatus);
    const sides = ['UP', 'DOWN'].map((side, index) => ({ side, tokenId: market.tokens[index],
        book: books ? structuredClone(books[index]) : null,
        sourceAgeMs: books ? at - books[index].timestamp : null,
        sourceTimestampFresh: books ? at - books[index].timestamp <= limits.dataAgeMs : null,
        quotes: books ? limits.quoteShares.map(shares => quote(books[index], shares, market, limits.gasUsd)) : null }));
    const observation = { schema: VALUE_OBSERVATION_SCHEMA, at, scheduledAt, delayMs: at - scheduledAt,
        market: { slug: market.slug, open: market.open, end: market.end, conditionId: market.conditionId,
            tokens: [...market.tokens], minimum: market.minimum ?? null, ticks: [...(market.ticks ?? [market.tick ?? null, market.tick ?? null])],
            fee: market.fee ? { rate: market.fee.rate, exponent: market.fee.exponent, takerOnly: market.fee.takerOnly } : null,
            accepting: market.accepting ?? null, negRisk: market.negRisk ?? null },
        limits, quality: { status: reasons.length ? 'partial' : 'ready', reasons: [...new Set(reasons)] },
        opening, spot, twap, closingTwap, rollingTwap, bookStatus,
        bookEvidence: books ? structuredClone(pair.evidence) : null, sides };
    const featureHash = digest(observation);
    return freeze({ ...observation, featureHash, snapshotId: featureHash });
}

export function verifyValueObservation(observation) {
    if (!observation || observation.schema !== VALUE_OBSERVATION_SCHEMA) return false;
    const { featureHash, snapshotId, ...payload } = observation;
    return typeof featureHash === 'string' && featureHash === snapshotId && digest(payload) === featureHash;
}
