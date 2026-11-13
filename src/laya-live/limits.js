// A null policy duration means continuous live operation. Runtime settings use
// Infinity so the shared pilot risk checks still enforce every other limit.
export function liveDeadline(state, settings) {
    const hours = settings.pilotHours;
    if (!Number.isFinite(state.startedAt) || state.startedAt < 0)
        throw new Error('invalid_live_time_limit');
    if (hours === Infinity) return Infinity;
    if (!Number.isFinite(hours) || hours <= 0)
        throw new Error('invalid_live_time_limit');
    return state.startedAt + hours * 3600000;
}

export function liveDeadlineISO(state, settings) {
    const deadline = liveDeadline(state, settings);
    return deadline === Infinity ? null : new Date(deadline).toISOString();
}
