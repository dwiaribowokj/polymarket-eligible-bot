import test from 'node:test';
import assert from 'node:assert/strict';
import { startDecisionEpoch, evaluationSummary } from '../../src/laya-live/decision-epochs.js';

const descriptor = { protocolVersion: 'protocol-v1', variantId: 'candidate-v2',
    promptVersion: 'compact-v2', promptHash: 'a'.repeat(64), questionsHash: 'b'.repeat(64) };
const config = { id: 'period', runtimeId: 'runtime-v2', policy: { aiSource: 'legacy-source' },
    ai: { decisionProtocol: descriptor } };

function fixture() {
    return { baseline: 'original-period', startedAt: 1000, cash: 21.283945, peakEquity: 29.310139,
        maxDrawdown: 10.154083, walletStart: 30, walletCashDelta: -8.716055,
        stopped: { reason: 'manual_stop', at: 1500 }, liveFunding: { initialCapital: 30 },
        completed: [{ slug: 'legacy-market', traded: true, pnl: -1, entrySignal: { snapshotId: 'legacy' } }],
        seen: { 'legacy-market': { snapshotId: 'legacy' } }, position: null,
        ai: { sourceExperiment: 'legacy-source', providers: { laya: { disabled: 'existing_disable',
            tokenizerIdentity: 'tokenizer', pending: { snapshotId: 'old-pending' } } },
            slots: { 'legacy-market:90': { status: 'observed' } },
            snapshots: [{ snapshotId: 'legacy', decision: { status: 'ok', latencyMs: 200 }, entryDisposition: 'entry_reserved' }] } };
}

function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
}

test('starting an epoch adds provenance without changing financial history, providers, slots or a stop', () => {
    const state = fixture(), before = structuredClone(state);
    const epoch = startDecisionEpoch(state, config, 2000);
    assert.equal(epoch.protocol.variantId, 'candidate-v2');
    assert.equal(epoch.firstRuntimeId, 'runtime-v2');
    assert.equal(epoch.financialPeriodId, 'original-period');
    assert.deepEqual(epoch.indexes, { snapshots: 1, completed: 1, seenMarkets: 1 });
    assert.deepEqual(epoch.financialBaseline, { auditOnly: true, startedAt: 1000, cash: 21.283945,
        peakEquity: 29.310139, maxDrawdown: 10.154083, initialCapital: 30 });
    assert.equal(epoch.legacyEvidence.appliesToCurrentProtocol, false);
    assert.equal(epoch.legacyEvidence.sourceExperiment, 'legacy-source');
    const { evaluationEpochs, currentEvaluationEpochId, ...rest } = state.ai;
    assert.deepEqual({ ...state, ai: rest }, before);
    assert.equal(currentEvaluationEpochId, epoch.id);
    assert.equal(evaluationEpochs.length, 1);
});

test('restarts with the same protocol retain the first epoch boundary even when runtime changes', () => {
    const state = fixture(), first = startDecisionEpoch(state, config, 2000);
    const before = structuredClone(first);
    state.ai.snapshots.push({ snapshotId: 'new', evaluationEpochId: first.id });
    const reordered = Object.fromEntries(Object.entries(descriptor).reverse());
    const next = startDecisionEpoch(state, { ...config, runtimeId: 'runtime-v3', ai: { decisionProtocol: reordered } }, 9000);
    assert.strictEqual(next, first);
    assert.deepEqual(next, before);
    assert.equal(state.ai.evaluationEpochs.length, 1);
});

test('switching A to B to A creates three separate evaluations while preserving financial history', () => {
    const state = fixture(), before = structuredClone(state), first = startDecisionEpoch(state, config, 2000);
    const second = startDecisionEpoch(state, { ...config, ai: { decisionProtocol: { ...descriptor,
        promptHash: 'c'.repeat(64), promptVersion: 'compact-v3' } } }, 3000);
    assert.notEqual(second.id, first.id);
    assert.equal(state.ai.evaluationEpochs.length, 2);
    assert.equal(state.ai.currentEvaluationEpochId, second.id);
    const third = startDecisionEpoch(state, config, 4000);
    assert.notEqual(third.id, first.id);
    assert.deepEqual(third.protocol, first.protocol);
    assert.deepEqual(state.ai.evaluationEpochs.map(epoch => epoch.ordinal), [1, 2, 3]);
    assert.equal(state.ai.evaluationEpochs.length, 3);
    assert.equal(state.ai.currentEvaluationEpochId, third.id);
    assert.strictEqual(startDecisionEpoch(state, { ...config, runtimeId: 'restart' }, 5000), third);
    assert.equal(state.ai.evaluationEpochs.length, 3);
    const { evaluationEpochs, currentEvaluationEpochId, ...rest } = state.ai;
    assert.deepEqual({ ...state, ai: rest }, before);
});

test('evaluation attributes completed rows by their entry rather than settlement time and keeps legacy rows separate', () => {
    const state = fixture(), epoch = startDecisionEpoch(state, config, 2000);
    state.ai.snapshots.push(
        { snapshotId: 'buy', evaluationEpochId: epoch.id, decision: { status: 'ok', latencyMs: 100 }, entryDisposition: 'entry_reserved' },
        { snapshotId: 'timeout', evaluationEpochId: epoch.id, decision: { status: 'decision_timeout', actualLatencyMs: 4000 }, entryDisposition: 'decision_timeout' },
        { snapshotId: 'skip', evaluationEpochId: epoch.id, decision: { status: 'ok', latencyMs: 500 }, entryDisposition: 'skip' });
    state.completed.push(
        { slug: 'explicit', traded: true, pnl: 2, closedAt: 1500, entrySignal: { evaluationEpochId: epoch.id } },
        { slug: 'mapped', traded: true, pnl: -.5, closedAt: 5000, entrySignal: { snapshotId: 'buy' } },
        { slug: 'unfilled', traded: false, pnl: 0, entrySignal: { snapshotId: 'timeout' } },
        { slug: 'legacy-settled-later', traded: true, pnl: -.25, closedAt: 6000, entrySignal: { snapshotId: 'legacy' } });
    state.position = { market: { slug: 'active' }, openedAt: 5000, holdings: [5, 0], entryCost: 4.1,
        orders: [{ orderId: 'done', status: 'complete' }, { orderId: 'pending', status: 'submitting' }],
        entrySignal: { snapshotId: 'buy' } };
    const summary = evaluationSummary(state, config), current = summary.currentEpoch;
    assert.equal(summary.currentEpochId, epoch.id);
    assert.equal(summary.configuredMatchesCurrent, true);
    assert.equal(current.decisions, 3);
    assert.deepEqual(current.decisionStatus, { ok: 2, decision_timeout: 1 });
    assert.deepEqual(current.entryDispositions, { entry_reserved: 1, decision_timeout: 1, skip: 1 });
    assert.deepEqual(current.latencyMs, { p50: 500, p95: 500, samples: 3 });
    assert.equal(current.completedMarkets, 3);
    assert.equal(current.completedFilled, 2);
    assert.equal(current.realizedPnl, 1.5);
    assert.equal(current.wins, 1); assert.equal(current.losses, 1);
    assert.deepEqual(current.currentExposure, { slug: 'active', openedAt: 5000, holdings: [5, 0],
        entryCost: 4.1, pendingOrders: [{ orderId: 'pending', status: 'submitting' }] });
    assert.equal(summary.legacy.decisions, 1);
    assert.equal(summary.legacy.completedMarkets, 2);
    assert.equal(summary.legacy.realizedPnl, -1.25);
    assert.equal(summary.legacy.currentExposure, null);
});

test('reports are read-only, do not alias state, and keep unknown epoch tags out of legacy evaluation', () => {
    const state = fixture();
    startDecisionEpoch(state, config, 2000);
    state.ai.snapshots.push({ snapshotId: 'unknown', evaluationEpochId: 'unrecognized', decision: { status: 'ok', latencyMs: 0 } });
    state.completed.push({ traded: true, pnl: 1, entrySignal: { snapshotId: 'unknown' } });
    state.position = { market: { slug: 'legacy-position' }, holdings: [0, 5], orders: [], entrySignal: { snapshotId: 'legacy' } };
    const before = JSON.stringify(state), summary = evaluationSummary(freeze(state), freeze(structuredClone(config)));
    assert.equal(JSON.stringify(state), before);
    assert.equal(summary.unattributed.decisions, 1);
    assert.equal(summary.unattributed.completedFilled, 1);
    assert.equal(summary.legacy.decisions, 1);
    assert.equal(summary.legacy.completedFilled, 1);
    summary.epochs[0].protocol.variantId = 'mutated-report';
    summary.legacy.currentExposure.holdings[0] = 999;
    assert.equal(JSON.stringify(state), before);
    assert.equal(summary.financialHistoryPreserved, true);
});

test('legacy config does not create an epoch and malformed protocols fail before mutating state', () => {
    const state = fixture(), before = structuredClone(state);
    assert.equal(startDecisionEpoch(state, { ai: {} }, 2000), null);
    assert.deepEqual(state, before);
    assert.equal(evaluationSummary(state, { ai: {} }).currentEpoch, null);
    assert.throws(() => startDecisionEpoch(state, { ai: { decisionProtocol: { ...descriptor, promptHash: 'invalid' } } }, 2000),
        /live_evaluation_protocol_invalid/);
    assert.throws(() => startDecisionEpoch(state, config, NaN), /live_evaluation_state_invalid/);
    assert.deepEqual(state, before);
});

test('a report distinguishes a newly configured prompt from the persisted running epoch without changing it', () => {
    const state = fixture(), first = startDecisionEpoch(state, config, 2000), before = structuredClone(state);
    const changedConfig = { ...config, ai: { decisionProtocol: { ...descriptor, promptHash: 'c'.repeat(64) } } };
    const report = evaluationSummary(state, changedConfig);
    assert.equal(report.configuredProtocol.promptHash, 'c'.repeat(64));
    assert.equal(report.configuredMatchesCurrent, false);
    assert.equal(report.currentEpoch.id, first.id);
    assert.equal(report.currentEpoch.protocol.promptHash, descriptor.promptHash);
    assert.equal(report.epochs.length, 1);
    assert.deepEqual(state, before);
});

test('latency includes rejected, invalid and failed completed responses while excluding unavailable admissions', () => {
    const state = fixture(), epoch = startDecisionEpoch(state, config, 2000);
    const decisions = [
        { status: 'ok', latencyMs: 100 },
        { status: 'invalid', latencyMs: 2000 },
        { status: 'rejected', latencyMs: 3000 },
        { status: 'provider_error', latencyMs: 4000 },
        { status: 'provider_busy', latencyMs: 9000 },
        { status: 'preflight_unavailable', latencyMs: 9000 },
        { status: 'decision_timeout', latencyMs: 3000 },
        { status: 'decision_timeout', latencyMs: 3000, actualLatencyMs: 5000 },
        { status: 'provider_busy', latencyMs: 9000, actualLatencyMs: 6000 }
    ];
    state.ai.snapshots.push(...decisions.map((decision, index) => ({ snapshotId: `latency-${index}`,
        evaluationEpochId: epoch.id, decision })));
    assert.deepEqual(evaluationSummary(state, config).currentEpoch.latencyMs, { p50: 3000, p95: 5000, samples: 6 });
});
