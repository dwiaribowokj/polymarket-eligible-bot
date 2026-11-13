const LATE_FIELDS = ['snapshotId', 'status', 'action', 'originalAction', 'requestedAt', 'receivedAt',
    'latencyMs', 'model', 'requestedModel', 'resolvedModel', 'inputHash', 'originalInputHash', 'promptHash',
    'informedPromptHash', 'contextVersion', 'decisionDeadlineAt', 'tokenUsageMatches', 'reasonCode',
    'reason', 'confidence', 'confidenceType', 'confidenceSource', 'probabilities', 'probabilityType',
    'answerConfidence', 'entropyConfidence', 'usage', 'cost', 'costBasis', 'requestSubmitted',
    'transportTimingMs', 'transport', 'responseBytes', 'submittedAt'];

export function recordProviderEvent(state, type, detail, now = Date.now()) {
    if (!['laya', 'gemini'].includes(detail.provider)) return;
    const snapshot = state.snapshots.find(row => row.snapshotId === detail.snapshotId);
    if (!snapshot) return;
    if (type === 'provider_pending') {
        snapshot.inferenceAttempts ||= {}; snapshot.inferenceStartedAts ||= {};
        snapshot.inferenceAttempts[detail.provider] = true;
        snapshot.inferenceStartedAts[detail.provider] = detail.startedAt || now;
    }
    if (type === 'provider_late_response') {
        const row = snapshot.providerDecisions?.[detail.provider];
        if (!row) return;
        row.lateResponse = Object.fromEntries(LATE_FIELDS.filter(key => detail[key] !== undefined)
            .map(key => [key, structuredClone(detail[key])]));
        row.lateResponse.requestedAt ??= snapshot.inferenceStartedAts?.[detail.provider];
        row.lateResponse.receivedAt ??= now;
        row.lateResponse.executable = false;
        row.lateDecision = detail.action; row.actualLatencyMs = detail.latencyMs;
        if (detail.usage !== undefined) row.usage = structuredClone(detail.usage);
        if (detail.cost !== undefined) row.cost = detail.cost;
        if (detail.costBasis !== undefined) row.costBasis = detail.costBasis;
    }
}

export function preserveLateEvidence(decision, previous) {
    if (!previous?.lateResponse) return decision;
    return { ...decision, ...Object.fromEntries(['lateResponse', 'lateDecision', 'actualLatencyMs', 'usage', 'cost', 'costBasis']
        .filter(key => previous[key] !== undefined).map(key => [key, structuredClone(previous[key])])) };
}
