import test from 'node:test';
import assert from 'node:assert/strict';
import { recordProviderEvent, preserveLateEvidence } from '../../src/decision-paper/events.js';

test('late diagnostic response preserves identity and cost without converting timeout into entry', () => {
    const decision = { snapshotId: 's', status: 'decision_timeout', action: 'SKIP', executable: false, cost: null };
    const snapshot = { snapshotId: 's', providerDecisions: { gemini: decision } };
    const state = { snapshots: [snapshot] };
    recordProviderEvent(state, 'provider_pending', { provider: 'gemini', snapshotId: 's', startedAt: 1000 });
    recordProviderEvent(state, 'provider_late_response', { provider: 'gemini', snapshotId: 's', status: 'ok',
        action: 'BUY_DOWN', model: 'gemini-3.8-flash-n', requestedModel: 'polymarket-decision',
        inputHash: 'h', originalInputHash: 'old', requestedAt: 1000, receivedAt: 91000, latencyMs: 90000,
        confidence: .7, usage: { prompt_tokens: 400 }, cost: null, raw: 'private-not-for-ledger' });
    assert.equal(snapshot.inferenceAttempts.gemini, true);
    assert.equal(decision.action, 'SKIP'); assert.equal(decision.status, 'decision_timeout');
    assert.equal(decision.lateResponse.action, 'BUY_DOWN'); assert.equal(decision.lateResponse.executable, false);
    assert.equal(decision.lateResponse.model, 'gemini-3.8-flash-n');
    assert.equal(decision.lateResponse.raw, undefined);
    assert.equal(decision.actualLatencyMs, 90000); assert.equal(decision.cost, null);
});

test('response arriving before timeout admission retains diagnostic evidence exactly once', () => {
    const previous = { status: 'pending', cost: null };
    const state = { snapshots: [{ snapshotId: 's', providerDecisions: { gemini: previous } }] };
    recordProviderEvent(state, 'provider_late_response', { provider: 'gemini', snapshotId: 's', status: 'ok',
        action: 'BUY_UP', latencyMs: 5000, cost: .002, usage: { prompt_tokens: 20 } });
    const admitted = preserveLateEvidence({ status: 'decision_timeout', action: 'SKIP', executable: false, cost: null }, previous);
    assert.equal(admitted.status, 'decision_timeout'); assert.equal(admitted.action, 'SKIP');
    assert.equal(admitted.lateResponse.action, 'BUY_UP'); assert.equal(admitted.cost, .002);
    assert.notEqual(admitted.lateResponse, previous.lateResponse);
    recordProviderEvent(state, 'provider_late_response', { provider: 'gemini', snapshotId: 'unknown', action: 'BUY_UP' });
    assert.equal(state.snapshots.length, 1);
});
