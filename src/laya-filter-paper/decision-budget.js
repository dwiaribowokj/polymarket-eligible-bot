export const ADAPTIVE_TIMEOUT_POLICY = 'snapshot-freshness-budget-v1';

export function decisionBudget(config, snapshot, now) {
    const sourceTimes = [snapshot.observedAt, snapshot.validation?.at];
    if (snapshot.validation?.tickVerifiedAt !== undefined) sourceTimes.push(snapshot.validation.tickVerifiedAt);
    const reserveMs = config.latencyMs + (config.inferenceReserveMs ?? 150);
    const minSeconds = config.late?.minSeconds ?? config.control?.late?.minSeconds;
    if (!Number.isFinite(now) || !Number.isFinite(snapshot.at) || snapshot.at > now
        || sourceTimes.some(at => !Number.isFinite(at) || at > snapshot.at)
        || !Number.isFinite(snapshot.marketEnd) || snapshot.marketEnd <= snapshot.at
        || !Number.isFinite(config.dataAgeMs) || config.dataAgeMs <= 0
        || !Number.isFinite(reserveMs) || reserveMs < 0
        || !Number.isFinite(minSeconds) || minSeconds < 0 || !Number.isFinite(config.deadline))
        throw new Error('invalid_decision_budget');
    const executionDeadlineAt = Math.min(...sourceTimes.map(at => at + config.dataAgeMs),
        snapshot.marketEnd - minSeconds * 1000, config.deadline);
    const decisionDeadlineAt = Math.floor(executionDeadlineAt - reserveMs);
    return { decisionDeadlineAt, executionDeadlineAt, decisionBudgetMs: Math.max(0, decisionDeadlineAt - now) };
}
