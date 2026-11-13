import { createHash } from 'node:crypto';
import { round } from '../restart/math.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) ? value : null;
const protocolKeys = ['protocolVersion', 'variantId', 'promptVersion', 'promptHash', 'questionsHash'];

function protocolView(config) {
    const descriptor = config.ai?.decisionProtocol;
    if (descriptor === undefined || descriptor === null) return null;
    if (!isObject(descriptor) || protocolKeys.some(key => typeof descriptor[key] !== 'string' || !descriptor[key])
        || ['promptHash', 'questionsHash'].some(key => !/^[a-f0-9]{64}$/.test(descriptor[key])))
        throw new Error('live_evaluation_protocol_invalid');
    return Object.fromEntries(protocolKeys.map(key => [key, descriptor[key]]));
}

const epochId = (protocol, ordinal) => createHash('sha256').update(JSON.stringify({ protocol, ordinal })).digest('hex').slice(0, 16);

/** Append prompt provenance to the existing ledger; financial state is audit-only. */
export function startDecisionEpoch(state, config, now = Date.now()) {
    const protocol = protocolView(config);
    if (!protocol) return null;
    if (!isObject(state?.ai) || !Array.isArray(state.ai.snapshots) || !Array.isArray(state.completed)
        || !isObject(state.seen) || !Number.isSafeInteger(now) || now < 0
        || state.ai.evaluationEpochs !== undefined && !Array.isArray(state.ai.evaluationEpochs))
        throw new Error('live_evaluation_state_invalid');
    const epochs = state.ai.evaluationEpochs || [];
    if (epochs.some(epoch => !isObject(epoch) || typeof epoch.id !== 'string')
        || new Set(epochs.map(epoch => epoch.id)).size !== epochs.length)
        throw new Error('live_evaluation_history_invalid');
    // Only a restart of the latest protocol belongs to the same evaluation.
    // Returning to an older prompt starts fresh proof without merging cohorts.
    let epoch = epochs.at(-1);
    if (!epoch || JSON.stringify(epoch.protocol) !== JSON.stringify(protocol)) {
        const ordinal = epochs.length + 1, id = epochId(protocol, ordinal);
        if (epochs.some(row => row.id === id)) throw new Error('live_evaluation_history_invalid');
        epoch = { schema: 1, id, ordinal, protocol, startedAt: now,
            firstRuntimeId: config.runtimeId || config.id || null,
            financialPeriodId: state.baseline || config.id || null,
            indexes: { snapshots: state.ai.snapshots.length, completed: state.completed.length,
                seenMarkets: Object.keys(state.seen).length },
            financialBaseline: { auditOnly: true, startedAt: finite(state.startedAt),
                cash: finite(state.cash), peakEquity: finite(state.peakEquity), maxDrawdown: finite(state.maxDrawdown),
                initialCapital: finite(state.liveFunding?.initialCapital) },
            legacyEvidence: { sourceExperiment: state.ai.sourceExperiment || config.policy?.aiSource || null,
                appliesToCurrentProtocol: false, reason: 'legacy_prompt_evidence_is_separate' } };
        if (!state.ai.evaluationEpochs) state.ai.evaluationEpochs = epochs;
        epochs.push(epoch);
    }
    state.ai.currentEvaluationEpochId = epoch.id;
    return epoch;
}

function counts(values) {
    const result = {};
    for (const value of values) {
        Object.defineProperty(result, value, { value: (Object.hasOwn(result, value) ? result[value] : 0) + 1,
            writable: true, enumerable: true, configurable: true });
    }
    return result;
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function metrics(snapshots, rows, position) {
    const completedStatuses = new Set(['ok', 'invalid', 'rejected', 'provider_error']);
    const latency = snapshots.map(snapshot => snapshot.decision?.actualLatencyMs
        ?? (completedStatuses.has(snapshot.decision?.status) ? snapshot.decision.latencyMs : null))
        .filter(value => Number.isFinite(value) && value >= 0);
    const filled = rows.filter(row => row.traded);
    return { decisions: snapshots.length,
        decisionStatus: counts(snapshots.map(snapshot => snapshot.decision?.status || 'pending')),
        entryDispositions: counts(snapshots.map(snapshot => snapshot.entryDisposition || 'unrecorded')),
        latencyMs: { p50: percentile(latency, .5), p95: percentile(latency, .95), samples: latency.length },
        completedMarkets: rows.length, completedFilled: filled.length,
        wins: filled.filter(row => row.pnl > 0).length, losses: filled.filter(row => row.pnl < 0).length,
        realizedPnl: round(rows.reduce((sum, row) => sum + (finite(row.pnl) ?? 0), 0)),
        currentExposure: position ? { slug: position.market?.slug || null, openedAt: finite(position.openedAt),
            holdings: structuredClone(position.holdings || [0, 0]), entryCost: finite(position.entryCost),
            pendingOrders: (position.orders || []).filter(order => !['complete', 'rejected', 'cancelled'].includes(order.status))
                .map(order => ({ orderId: order.orderId || null, status: order.status || null })) } : null };
}

/** Read-only prompt evaluation; lifetime capital, PnL and risk remain in the main report. */
export function evaluationSummary(state, config) {
    const protocol = protocolView(config), ai = state?.ai;
    const epochs = ai?.evaluationEpochs || [], snapshots = ai?.snapshots || [], completed = state?.completed || [];
    const snapshotEpochs = new Map(snapshots.map(snapshot => [snapshot.snapshotId, snapshot.evaluationEpochId || null]));
    const epochOf = row => row?.entrySignal?.evaluationEpochId
        || snapshotEpochs.get(row?.entrySignal?.snapshotId) || null;
    const positionEpochId = epochOf(state?.position);
    const summaries = epochs.map(epoch => ({ ...structuredClone(epoch),
        ...metrics(snapshots.filter(snapshot => snapshot.evaluationEpochId === epoch.id),
            completed.filter(row => epochOf(row) === epoch.id),
            state?.position && positionEpochId === epoch.id ? state.position : null) }));
    const knownIds = new Set(epochs.map(epoch => epoch.id));
    const currentEpochId = ai?.currentEvaluationEpochId || null;
    const currentEpoch = summaries.find(epoch => epoch.id === currentEpochId) || null;
    return { financialHistoryPreserved: true, configuredProtocol: protocol,
        configuredMatchesCurrent: !!protocol && !!currentEpoch
            && JSON.stringify(protocol) === JSON.stringify(currentEpoch.protocol),
        currentEpochId, currentEpoch,
        epochs: summaries,
        legacy: { legacyEvidence: true,
            ...metrics(snapshots.filter(snapshot => !snapshot.evaluationEpochId),
                completed.filter(row => !epochOf(row)), state?.position && !positionEpochId ? state.position : null) },
        unattributed: metrics(snapshots.filter(snapshot => snapshot.evaluationEpochId && !knownIds.has(snapshot.evaluationEpochId)),
            completed.filter(row => epochOf(row) && !knownIds.has(epochOf(row))),
            state?.position && positionEpochId && !knownIds.has(positionEpochId) ? state.position : null) };
}
