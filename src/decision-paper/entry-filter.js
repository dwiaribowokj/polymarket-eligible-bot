import { createHash } from 'node:crypto';

export const ENTRY_FILTER_POLICY = Object.freeze({ version: 'direction-volatility-buffer-v1',
    minBufferSigma: 1, useClosingThreshold: true });

const hash = value => createHash('sha256').update(value).digest('hex');
const positive = value => Number.isFinite(value) && value > 0;

/** A paper risk veto using frozen observations; the ratios are not win probabilities. */
export function evaluateEntryFilter(snapshot, action, policy = ENTRY_FILTER_POLICY) {
    const result = (pass, reason, metrics = null) => ({ version: ENTRY_FILTER_POLICY.version, pass, reason, metrics });
    if (!policy || policy.version !== ENTRY_FILTER_POLICY.version || !positive(policy.minBufferSigma)
        || typeof policy.useClosingThreshold !== 'boolean') return result(false, 'entry_filter_policy_invalid');
    if (action === 'SKIP') return result(true, null);
    if (!['BUY_UP', 'BUY_DOWN'].includes(action)) return result(false, 'entry_filter_action_invalid');
    if (typeof snapshot?.input !== 'string' || snapshot.inputHash !== hash(snapshot.input))
        return result(false, 'entry_filter_input_hash_mismatch');
    let input;
    try { input = JSON.parse(snapshot.input); } catch { return result(false, 'entry_filter_input_invalid'); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || !positive(input.seconds) || input.seconds > 300
        || !positive(input.sigma_milliusd) || !positive(input.open_usd)
        || !Array.isArray(input.delta_cents) || input.delta_cents.length !== 2 || !input.delta_cents.every(Number.isFinite)
        || !Array.isArray(input.allowed)) return result(false, 'entry_filter_input_invalid');
    if (!input.allowed.includes(action)) return result(false, 'entry_filter_action_not_allowed');

    const direction = action === 'BUY_UP' ? 1 : -1;
    const sigmaUsdPerSqrtSecond = input.sigma_milliusd / 1000;
    const horizonVolatilityUsd = sigmaUsdPerSqrtSecond * Math.sqrt(input.seconds);
    const spotBufferUsd = direction * input.delta_cents[0] / 100;
    const twapBufferUsd = direction * input.delta_cents[1] / 100;
    const closing = snapshot.informed?.calculated?.closingTwap;
    const metrics = { action, seconds: input.seconds, sigmaUsdPerSqrtSecond, horizonVolatilityUsd,
        spotBufferUsd, twapBufferUsd, spotBufferSigma: spotBufferUsd / horizonVolatilityUsd,
        twapBufferSigma: twapBufferUsd / horizonVolatilityUsd, minBufferSigma: policy.minBufferSigma,
        closingStatus: closing?.status ?? 'unavailable', closingBufferUsd: null, closingBufferSigma: null,
        closingHorizonVolatilityUsd: null, interpretation: 'uncalibrated_volatility_buffer_not_probability' };
    if (!positive(horizonVolatilityUsd) || !Number.isFinite(metrics.spotBufferSigma)
        || !Number.isFinite(metrics.twapBufferSigma)) return result(false, 'entry_filter_input_invalid');
    if (spotBufferUsd <= 0 || twapBufferUsd <= 0) return result(false, 'entry_filter_direction_conflict', metrics);
    if (Math.min(metrics.spotBufferSigma, metrics.twapBufferSigma) < policy.minBufferSigma)
        return result(false, 'entry_filter_insufficient_buffer', metrics);

    // A partial closing TWAP adds an observed threshold; missing history supplies no forecast.
    if (policy.useClosingThreshold && closing?.status === 'observed') {
        const context = snapshot.informed;
        if (context.originalInputHash !== snapshot.inputHash || context.snapshotId !== snapshot.snapshotId
            || context.at !== snapshot.at || closing.snapshotAt !== snapshot.at
            || !Number.isFinite(snapshot.at) || !Number.isFinite(closing.asOf) || closing.asOf > snapshot.at
            || !positive(closing.knownSeconds) || !positive(closing.remainingSeconds)
            || Math.abs(closing.knownSeconds + closing.remainingSeconds - 60) > 1e-6
            || !positive(closing.referenceUsd) || Math.abs(closing.referenceUsd - input.open_usd) > 0.005001
            || !positive(closing.requiredRemainingAverageUsd)) return result(false, 'entry_filter_closing_context_invalid', metrics);
        metrics.closingHorizonVolatilityUsd = sigmaUsdPerSqrtSecond * Math.sqrt(closing.remainingSeconds);
        metrics.closingBufferUsd = direction * (input.open_usd + input.delta_cents[0] / 100 - closing.requiredRemainingAverageUsd);
        metrics.closingBufferSigma = metrics.closingBufferUsd / metrics.closingHorizonVolatilityUsd;
        if (!Number.isFinite(metrics.closingBufferSigma)) return result(false, 'entry_filter_closing_context_invalid', metrics);
        if (metrics.closingBufferUsd <= 0) return result(false, 'entry_filter_closing_direction_conflict', metrics);
        if (metrics.closingBufferSigma < policy.minBufferSigma)
            return result(false, 'entry_filter_closing_insufficient_buffer', metrics);
    }
    return result(true, null, metrics);
}
