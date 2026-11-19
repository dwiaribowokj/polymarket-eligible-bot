// Successful path in both pinned engines: reserve entry -> reserve submit ->
// revalidate -> prepare/sign -> persist order -> validate -> persist intent -> POST.
// Routine validate() compute/any extra tick reads have no paired duration.
// This is a timing estimate, never permission to sign or an observed network send.
export function estimateSubmission(timing, calibration) {
    const finite = v => Number.isFinite(v) && v >= 0;
    if (timing?.status !== 'ready' || !Number.isSafeInteger(timing.readyAt) || timing.readyAt <= 0
        || !finite(timing.stages?.modeledDecisionPersistMs)) throw new Error('paper_submission_timing_missing');
    if (calibration?.schema !== 1 || calibration.unit !== 'ms' || calibration.estimator !== 'median'
        || !Number.isSafeInteger(calibration.sampleCount) || calibration.sampleCount < 5
        || !Number.isSafeInteger(calibration.recordedThroughExclusive) || calibration.recordedThroughExclusive <= 0
        || !Number.isSafeInteger(timing.sourceAt) || timing.sourceAt < calibration.recordedThroughExclusive
        || !finite(calibration.prepareMs) || !finite(calibration.checkToStartedEventMs)
        || calibration.writesToPreSign !== 2 || calibration.writesToFinalCheck !== 3 || calibration.writesToPost !== 4)
        throw new Error('paper_submission_calibration_invalid');
    const saveMs = timing.stages.modeledDecisionPersistMs;
    const preSignValidationAt = Math.ceil(timing.readyAt + 2 * saveMs);
    const finalValidationAt = Math.ceil(timing.readyAt + 3 * saveMs + calibration.prepareMs);
    const submitReadyAt = Math.ceil(timing.readyAt + 4 * saveMs + calibration.prepareMs + calibration.checkToStartedEventMs);
    return { preSignValidationAt, finalValidationAt, submitReadyAt };
}
