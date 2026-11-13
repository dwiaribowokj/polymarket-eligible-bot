// Keep LIVE feed collection independent of the frozen research runtime.
import { fee, round } from '../restart/math.js';
import { temperatureProbability } from '../restart/calibration.js';

export class BtcSignal {
    constructor(rule, onEvent = () => {}) {
        this.rule = rule; this.onEvent = onEvent; this.spot = []; this.twap = null; this.openings = new Map();
    }
    ingest(event, receivedAt = Date.now()) {
        if (event.dropped > 0) {
            this.spot = []; this.twap = null;
            this.onEvent({ type: 'btc_feed_gap', dropped: event.dropped });
        }
        if (event.type === 'subscribe' && event.payload?.symbol === 'btcusd') {
            // Seed only points fresh at receipt. Older snapshot data must never
            // shorten the required period of direct volatility observation.
            for (const p of Array.isArray(event.payload.data) ? event.payload.data : []) {
                if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
                // Each snapshot row must supply its own source time and value.
                this.ingest({ ...event, type: 'update', dropped: 0,
                    payload: { ...event.payload, ...p, timestamp: p.timestamp, value: p.value, data: undefined } }, receivedAt);
            }
            return;
        }
        const p = event.payload, at = Number(p?.timestamp), value = Number(p?.value);
        if (event.type !== 'update' || p?.symbol !== 'btcusd' || !(value > 0)
            || !Number.isFinite(value) || !Number.isFinite(at) || !Number.isFinite(receivedAt)
            || at > receivedAt || receivedAt - at > this.rule.maxAgeMs) return;
        const point = { at, value, receivedAt };
        if (event.topic === 'prices.crypto.twap' && p.windowSeconds === 60) {
            if (!this.twap || at > this.twap.at) this.twap = point;
            // Boundary updates may arrive after a newer TWAP. Observe the opening
            // independently without rolling back latest or revising its first value.
            if (at % 300000 === 0) {
                const opening = this.openings.get(at);
                if (!opening) {
                    const observed = Object.freeze({ ...point });
                    this.openings.set(at, observed);
                    this.onEvent({ type: 'btc_opening_observed', opening: { ...observed }, source: 'chainlink_twap_60s' });
                } else if (opening.value !== value) {
                    this.onEvent({ type: 'btc_opening_conflict', opening: { ...opening },
                        conflicting: { ...point }, source: 'chainlink_twap_60s' });
                }
            }
            for (const start of this.openings.keys()) if (start < this.twap.at - 900000) this.openings.delete(start);
        } else if (event.topic === 'prices.crypto') {
            const previous = this.spot.at(-1);
            if (previous && at <= previous.at) return;
            if (previous && at - previous.at > this.rule.maxGapMs) {
                this.spot = []; this.twap = null;
                this.onEvent({ type: 'btc_feed_gap', gapMs: at - previous.at });
            }
            this.spot.push(point);
            while (this.spot.length > 1 && this.spot[1].at < at - (this.rule.lookbackSeconds + 65) * 1000) this.spot.shift();
        }
    }
    status(now = Date.now()) {
        const latest = this.spot.at(-1);
        return { spotAt: latest?.at ?? null, twapAt: this.twap?.at ?? null,
            spot: latest?.value ?? null, twap: this.twap?.value ?? null, samples: this.spot.length,
            ageMs: latest ? now - latest.at : null,
            ready: !!latest && !!this.twap && now - latest.at <= this.rule.maxAgeMs
                && now - this.twap.at <= this.rule.maxAgeMs };
    }
    integral(start, end) {
        const first = this.spot.findLast(p => p.at <= start);
        if (!first || start - first.at > this.rule.maxGapMs) return null;
        let value = first.value, at = start, total = 0;
        for (const p of this.spot) {
            if (p.at <= start) continue;
            if (p.at > end) break;
            if (p.at - at > this.rule.maxGapMs) return null;
            total += value * (p.at - at); value = p.value; at = p.at;
        }
        if (end - at > this.rule.maxGapMs) return null;
        return (total + value * (end - at)) / 1000;
    }
    assess(market, order, settings, now = Date.now()) {
        const rule = this.rule, latest = this.spot.at(-1), status = this.status(now);
        const calibration = rule.calibration;
        const base = { ...status, model: calibration ? 'chainlink_twap_temperature_research_v2'
            : 'chainlink_twap_brownian_research_v1', calibrated: false,
            calibration: calibration ? { id: calibration.id, method: calibration.method,
                temperature: calibration.temperature, status: calibration.status,
                datasetSha256: calibration.datasetSha256 } : null,
            reference: market.reference || null };
        const reject = reason => ({ ...base, reason });
        if (!status.ready) return reject('btc_feed_stale_or_warming');
        const opening = this.openings.get(market.open);
        if (!opening) return reject('btc_opening_twap_unobserved');
        const ref = market.reference;
        if (!ref || ref.source !== 'chainlink_twap_60s' || ref.open !== market.open || ref.end !== market.end
            || ref.observedAt !== market.open || ref.value !== opening.value || !(ref.value > 0)
            || ref.receivedAt < market.open || ref.receivedAt > market.open + rule.maxAgeMs
            || now - ref.observedAt > rule.referenceMaxAgeMs) return reject('btc_reference_unverified');
        Object.assign(base, { openingTwap: { ...opening } });
        const observedAt = Math.min(latest.at, this.twap.at);
        if (observedAt <= market.open || observedAt > now || now >= market.end) return reject('twap_window_unavailable');
        const history = this.spot.filter(p => p.at >= observedAt - rule.lookbackSeconds * 1000 && p.at <= observedAt);
        if (history.length < Math.ceil(rule.lookbackSeconds * 1000 / rule.maxGapMs)
            || history.at(-1).at - history[0].at < (rule.lookbackSeconds - 3) * 1000)
            return reject('btc_volatility_warmup');
        let variance = 0, elapsed = 0;
        for (let i = 1; i < history.length; i++) {
            const dt = (history[i].at - history[i - 1].at) / 1000;
            if (dt * 1000 > rule.maxGapMs) return reject('btc_history_gap');
            variance += (history[i].value - history[i - 1].value) ** 2; elapsed += dt;
        }
        const knownSeconds = Math.max(0, (observedAt - (market.end - 60000)) / 1000);
        const known = knownSeconds > 0 ? this.integral(market.end - 60000, observedAt) : 0;
        const rolling = this.integral(observedAt - 60000, observedAt);
        if (known === null || rolling === null) return reject('btc_history_gap');
        const feedDifference = Math.abs(rolling / 60 - this.twap.value);
        Object.assign(base, { observedAt, feedDifference: round(feedDifference) });
        if (feedDifference > rule.maxFeedDifferenceUsd) return reject('btc_twap_source_mismatch');
        const current = history.at(-1).value, remaining = (market.end - observedAt) / 1000;
        const futureWindowSeconds = Math.min(remaining, 60);
        const projection = (known + current * futureWindowSeconds) / 60;
        const sigmaPerSecond = Math.max(rule.volatilityFloorUsd, Math.sqrt(variance / elapsed));
        // Before the final minute, include Brownian variation between now and
        // the beginning of the averaging window. Never integrate future prices.
        const leadSeconds = Math.max(0, remaining - 60);
        const uncertainty = rule.volatilityMultiplier * sigmaPerSecond
            * Math.sqrt(leadSeconds + futureWindowSeconds ** 3 / (3 * 60 ** 2));
        const direction = order.index === 0 ? 1 : -1;
        const margin = direction * (projection - ref.value);
        const z = (margin - rule.referenceBufferUsd) / uncertainty;
        const temperature = calibration?.temperature ?? 1;
        if (calibration && (!Number.isFinite(temperature) || temperature < 1 || temperature > 8
            || !Number.isFinite(calibration.validationEndsAt) || calibration.validationEndsAt >= market.open))
            return reject('btc_calibration_unverified');
        const rawModelProbability = temperatureProbability(z);
        const modelProbability = temperatureProbability(z, temperature);
        const netCostPerShare = order.price + fee(order.shares, order.price, market.fee) / order.shares
            + settings.paperGasUsd / order.shares;
        Object.assign(base, { projection: round(projection), remainingSeconds: round(remaining),
            knownSeconds: round(knownSeconds), futureWindowSeconds: round(futureWindowSeconds), leadSeconds: round(leadSeconds),
            sigmaPerSecond: round(sigmaPerSecond), uncertainty: round(uncertainty), margin: round(margin),
            z: round(z), calibrationZ: round(z / temperature), rawModelProbability: round(rawModelProbability),
            rawModelEdge: round(rawModelProbability - netCostPerShare),
            modelProbability: round(modelProbability), netCostPerShare: round(netCostPerShare),
            modelEdge: round(modelProbability - netCostPerShare) });
        if (direction * (this.twap.value - ref.value) <= 0 || direction * (current - ref.value) <= 0)
            return reject('btc_direction_disagrees');
        if (margin < rule.minMarginUsd || z < rule.minZ || modelProbability - netCostPerShare < rule.minModelEdge)
            return reject('btc_edge_insufficient');
        return { ...base, reason: null };
    }
}
