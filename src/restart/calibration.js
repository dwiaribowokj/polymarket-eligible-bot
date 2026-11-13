import { round } from './math.js';

export function normalCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t
        * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - tail : tail;
}

export function temperatureProbability(z, temperature = 1) {
    if (!Number.isFinite(z) || !Number.isFinite(temperature) || temperature < 1 || temperature > 8)
        throw new Error('Invalid probability calibration');
    return normalCdf(z / temperature);
}

export function probabilityMetrics(rows, temperature = 1) {
    if (!rows.length) return null;
    let brier = 0, logLoss = 0, predicted = 0, wins = 0;
    for (const row of rows) {
        const p = temperatureProbability(row.z, temperature), bounded = Math.max(1e-9, Math.min(1 - 1e-9, p));
        brier += (p - row.outcome) ** 2;
        logLoss -= row.outcome * Math.log(bounded) + (1 - row.outcome) * Math.log(1 - bounded);
        predicted += p; wins += row.outcome;
    }
    return { markets: rows.length, wins, meanPrediction: round(predicted / rows.length),
        winRate: round(wins / rows.length), brier: round(brier / rows.length), logLoss: round(logLoss / rows.length) };
}

// One first qualifying prediction per market. Later snapshots of the same
// settlement outcome cannot create extra independent calibration samples.
export function fitTemperature(input, { minTrainingMarkets = 20, minValidationMarkets = 10 } = {}) {
    const rows = [...input].sort((a, b) => a.open - b.open || a.conditionId.localeCompare(b.conditionId));
    const seen = new Set();
    for (const r of rows) {
        if (!r.conditionId || seen.has(r.conditionId)) throw new Error('Duplicate calibration market');
        seen.add(r.conditionId);
        if (r.source !== 'official_ctf_payout' || ![0, 1].includes(r.outcome)
            || !Number.isFinite(r.z) || !Number.isFinite(r.open) || !Number.isFinite(r.end)
            || !Number.isFinite(r.observedAt) || r.end <= r.open || r.observedAt < r.open || r.observedAt >= r.end)
            throw new Error('Invalid official calibration sample');
    }
    const split = Math.floor(rows.length * 2 / 3), training = rows.slice(0, split), validation = rows.slice(split);
    if (training.length < minTrainingMarkets || validation.length < minValidationMarkets)
        throw new Error('Insufficient independent calibration markets');
    if (Math.max(...training.map(r => r.end)) > validation[0].open)
        throw new Error('Calibration training overlaps validation');
    let temperature = 1, bestLoss = Infinity;
    // The grid and chronological split are fixed before fitting. The held-out
    // block only assesses the chosen temperature; it never chooses parameters.
    for (let step = 0; step <= 700; step++) {
        const candidate = round(1 + step / 100);
        const loss = probabilityMetrics(training, candidate).logLoss;
        if (loss < bestLoss) { temperature = candidate; bestLoss = loss; }
    }
    const trainingRaw = probabilityMetrics(training), trainingAdjusted = probabilityMetrics(training, temperature);
    const validationRaw = probabilityMetrics(validation), validationAdjusted = probabilityMetrics(validation, temperature);
    const improved = validationAdjusted.logLoss < validationRaw.logLoss
        && validationAdjusted.brier < validationRaw.brier;
    return { method: 'probit_temperature_v1', temperature, status: 'provisional', researchOnly: true,
        qualifiedForLive: false, independentMarkets: rows.length, trainingMarkets: training.length,
        validationMarkets: validation.length, trainedThrough: Math.max(...training.map(r => r.end)),
        validationStartsAt: validation[0].open, validationEndsAt: Math.max(...validation.map(r => r.end)),
        heldOutImproved: improved,
        training: { raw: trainingRaw, adjusted: trainingAdjusted },
        validation: { raw: validationRaw, adjusted: validationAdjusted },
        limitations: ['small_sample', 'few_observed_days', 'selected_entry_candidates',
            'historical_predictions_are_not_simulated_fills', 'requires_new_frozen_paper_period'] };
}
