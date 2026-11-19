import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateSubmission } from '../../scripts/paired-version-paper/submission.mjs';

const c = { schema: 1, unit: 'ms', estimator: 'median', sampleCount: 11, recordedThroughExclusive: 200,
    writesToPreSign: 2, writesToFinalCheck: 3, writesToPost: 4, prepareMs: 9, checkToStartedEventMs: 32 };
const t = { status: 'ready', readyAt: 1000, sourceAt: 500, stages: { modeledDecisionPersistMs: 275 } };
test('time for signing and the final durable submit-intent write falls on the correct side of validation', () => {
    assert.deepEqual(estimateSubmission(t, c), { preSignValidationAt: 1550, finalValidationAt: 1834, submitReadyAt: 2141 });
    assert.deepEqual(estimateSubmission(t, { ...c, roundtripMs: 12345 }), estimateSubmission(t,c));
});
test('rejects incomplete, future and non-submittable cases', () => {
    assert.throws(() => estimateSubmission({ ...t, status: 'skip' }, c), /timing_missing/);
    for (const wrong of [{ recordedThroughExclusive: 501 }, { writesToPost: 3 }, { prepareMs: null }, { sampleCount: 0 }])
        assert.throws(() => estimateSubmission(t, { ...c, ...wrong }), /calibration_invalid/);
});
