import { createHash } from 'node:crypto';
import { metadataIdentity } from '../ai-shadow/engine.js';
import { encodeFeatures } from '../ai-shadow/history.js';

export const MOMENTUM30_POLICY = Object.freeze({ version: 'directional-momentum30-v1',
    source: 'frozen-state-returns-bps-5-15-30-60-180', returnIndex: 2, horizonSeconds: 30,
    rule: 'direction-times-return30-strictly-positive', zeroPolicy: 'reject', missingPolicy: 'reject',
    inputPolicy: 'hash-market-and-causal-validation', thresholdSelection: 'fixed-zero-no-magnitude-optimization',
    interpretation: 'directional-filter-not-calibrated-win-probability' });

const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function evaluateMomentum30(snapshot, action, { market, now, dataAgeMs, policy = MOMENTUM30_POLICY } = {}) {
    const result = (pass, reason, metrics = null) => ({ version: MOMENTUM30_POLICY.version, pass, reason, metrics });
    if (!record(policy) || Object.keys(policy).length !== Object.keys(MOMENTUM30_POLICY).length
        || Object.entries(MOMENTUM30_POLICY).some(([key, value]) => policy[key] !== value))
        return result(false, 'entry_momentum_policy_invalid');
    if (!['BUY_UP', 'BUY_DOWN'].includes(action)) return result(false, 'entry_momentum_action_invalid');
    if (typeof snapshot?.input !== 'string' || snapshot.inputHash !== hash(snapshot.input))
        return result(false, 'entry_momentum_input_hash_mismatch');
    if (snapshot.snapshotId !== hash(JSON.stringify({ market: snapshot.market, seconds: snapshot.slot,
        now: snapshot.at, input: snapshot.input })).slice(0, 24))
        return result(false, 'entry_momentum_snapshot_identity_invalid');
    if (!record(market) || market.slug !== snapshot.market || snapshot.state?.market !== snapshot.market
        || snapshot.marketEnd !== market.end || market.end - market.open !== 300000
        || snapshot.validation?.identity !== metadataIdentity(market))
        return result(false, 'entry_momentum_market_mismatch');
    const times = [now, snapshot.at, snapshot.observedAt, snapshot.validation.at, market.open, market.end];
    const tickAt = snapshot.validation.tickVerifiedAt ?? snapshot.validation.at;
    if (!times.every(Number.isFinite) || !Number.isFinite(tickAt) || !Number.isFinite(dataAgeMs) || dataAgeMs <= 0
        || snapshot.observedAt > snapshot.at || snapshot.validation.at > snapshot.at || tickAt > snapshot.at
        || snapshot.at > now || snapshot.at < market.open || now >= market.end
        || now - Math.min(snapshot.observedAt, snapshot.validation.at, tickAt) > dataAgeMs)
        return result(false, 'entry_momentum_snapshot_stale');
    const returns = snapshot.state?.returns_bps_5_15_30_60_180;
    if (!Array.isArray(returns) || returns.length !== 5 || !returns.every(value => Number.isFinite(value)
        && Number((value * 1000).toFixed(0)) / 1000 === value))
        return result(false, 'entry_momentum_return_unavailable');
    try {
        // The hash binds the compact encoding; compare it with the saved state
        // so an unverified or later return cannot replace the captured signal.
        const input = JSON.parse(snapshot.input), featureAt = market.end - input.seconds * 1000;
        const index = action === 'BUY_UP' ? 0 : 1;
        if (encodeFeatures(snapshot.state) !== snapshot.input || !Number.isFinite(featureAt)
            || input.seconds <= 0 || input.seconds > 300 || featureAt > snapshot.at + 5.001
            || snapshot.at - featureAt > dataAgeMs + 5.001 || snapshot.observedAt > featureAt + 5.001
            || !Array.isArray(input.allowed) || !input.allowed.includes(action)
            || !snapshot.allowed?.some(order => order.index === index && order.tokenId === market.tokens[index]))
            return result(false, 'entry_momentum_input_invalid');
    } catch { return result(false, 'entry_momentum_input_invalid'); }
    const return30Bps = returns[2], directionalReturn30Bps = (action === 'BUY_UP' ? 1 : -1) * return30Bps;
    const metrics = { action, return30Bps, directionalReturn30Bps, inputHash: snapshot.inputHash,
        horizonSeconds: 30, interpretation: MOMENTUM30_POLICY.interpretation };
    return result(directionalReturn30Bps > 0,
        directionalReturn30Bps > 0 ? null : 'entry_momentum_not_aligned', metrics);
}

// Compare the decimal quotes themselves, without a floating-point boundary allowance.
export function exactAskDropAboveLimit(snapshotAsk, executionAsk, limit) {
    const decimal = value => {
        const [mantissa, exponent = '0'] = value.toString().split('e');
        const [integer, fraction = ''] = mantissa.split('.');
        return { units: BigInt(integer + fraction), places: fraction.length - Number(exponent) };
    };
    if (![snapshotAsk, executionAsk, limit].every(Number.isFinite)
        || snapshotAsk <= 0 || snapshotAsk >= 1 || executionAsk <= 0 || executionAsk >= 1 || limit < 0)
        throw new Error('execution_ask_drop_inputs_invalid');
    const values = [snapshotAsk, executionAsk, limit].map(decimal), places = Math.max(...values.map(value => value.places));
    const [before, after, allowed] = values.map(value => value.units * 10n ** BigInt(places - value.places));
    return before - after > allowed;
}
