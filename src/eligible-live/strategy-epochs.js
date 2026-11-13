import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { round } from '../restart/math.js';

export function initializeEligibleStrategyEpoch(state, config, now = Date.now()) {
    if (!config.policy.entryFilter) return null;
    const epochs = state.strategyEpochs || [];
    const invalid = () => { throw new Error('eligible_strategy_epoch_mismatch'); };
    if (!Array.isArray(epochs) || !Array.isArray(state.completed) || !Array.isArray(state.ai?.snapshots)
        || !Number.isSafeInteger(now) || now < state.startedAt) invalid();
    const current = epochs.find(epoch => epoch.id === state.currentStrategyEpochId);
    if (current) {
        if (current !== epochs.at(-1) || !isDeepStrictEqual(current.policy, config.policy)) invalid();
        return current;
    }
    // Existing trading history requires the reviewed, flat-wallet migration.
    if (epochs.length || state.currentStrategyEpochId || state.completed.length || state.ai.snapshots.length
        || state.position || Object.keys(state.seen || {}).length) invalid();
    const identity = { periodId: config.id, runtimeId: config.runtimeId || config.id, startedAt: now,
        firstCompletedIndex: 0, firstSnapshotIndex: 0 };
    const epoch = { id: createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 16),
        ...identity, policy: structuredClone(config.policy), cashAtStart: state.cash,
        reason: config.policy.entryFilter.version === 'direction-volatility-buffer-v1'
            ? 'fresh_entry_buffer' : 'fresh_entry_cost_cap' };
    state.strategyEpochs = [epoch]; state.currentStrategyEpochId = epoch.id;
    return epoch;
}

export function eligibleStrategySummary(state, config) {
    const snapshots = state.ai?.snapshots || [], completed = state.completed || [], epochs = state.strategyEpochs || [];
    const bySnapshot = new Map(snapshots.map(row => [row.snapshotId, row.strategyEpochId || null]));
    const epochOf = row => row?.entrySignal?.strategyEpochId || bySnapshot.get(row?.entrySignal?.snapshotId) || null;
    const metrics = id => {
        const rows = completed.filter(row => epochOf(row) === id), filled = rows.filter(row => row.traded);
        return { completedAttempts: rows.length, filled: filled.length,
            wins: filled.filter(row => row.pnl > 0).length, losses: filled.filter(row => row.pnl < 0).length,
            realizedPnl: round(rows.reduce((sum, row) => sum + row.pnl, 0)),
            snapshots: snapshots.filter(row => (row.strategyEpochId || null) === id).length,
            activeMarket: state.position && epochOf(state.position) === id ? state.position.market?.slug || null : null };
    };
    const summaries = epochs.map(epoch => ({ id: epoch.id, startedAt: epoch.startedAt,
        runtimeId: epoch.runtimeId, entryFilter: epoch.policy?.entryFilter || null,
        cashAtStart: epoch.cashAtStart, ...metrics(epoch.id) }));
    const current = summaries.find(epoch => epoch.id === state.currentStrategyEpochId) || null;
    const known = new Set(epochs.map(epoch => epoch.id));
    return { financialHistoryPreserved: true, riskReset: false, activeEntryFilter: config.policy.entryFilter || null,
        currentEpochId: state.currentStrategyEpochId || null, current, epochs: summaries,
        legacy: metrics(null), unattributedCompleted: completed.filter(row => epochOf(row) && !known.has(epochOf(row))).length,
        paperProfitIncluded: false, statisticalQualification: false };
}
