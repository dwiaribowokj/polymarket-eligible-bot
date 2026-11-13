import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeDecisionPaper, writeDecisionPaperReport, readDecisionPaperReports } from '../../src/decision-paper/report.js';

const ARMS = ['laya', 'gemini', 'eligible', 'skip'];
const OLD_ARMS = ['laya', 'spot-twap', 'price-cap-085', 'combined', 'model-edge'];
const START = Date.UTC(2026, 9, 20), DAY = 86400000;
const config = { id: 'new-period', experiment: 'decision-paper-v1', armNames: ARMS, capital: 20,
    decisionMs: 5000, deadline: Number.MAX_SAFE_INTEGER, bootstrapSamples: 200,
    layaModel: 'typed-decisions', geminiModel: 'ag/gemini-3.8-flash-low',
    decisionProtocol: { variantId: 'candidate-v2', promptHash: 'original-prompt' }, informedPromptHash: 'informed-prompt' };
const emptyArm = () => ({ cash: 20, drawdown: 0, seen: {}, position: null, completed: [], outcomes: {} });
const fixture = () => ({ id: config.id, startedAt: START, snapshots: [], slots: {}, markets: {},
    providers: {}, arms: Object.fromEntries(ARMS.map(name => [name, emptyArm()])) });

function snapshot(state, slug, end, laya = {}, gemini = {}) {
    const decision = extra => ({ status: 'ok', action: 'SKIP', latencyMs: 100, cost: 0, ...extra });
    const row = { snapshotId: `snapshot-${state.snapshots.length}`, market: slug, at: end - 60000,
        inferenceAttempts: { laya: true, gemini: true },
        providerDecisions: { laya: decision(laya), gemini: decision(gemini) },
        decisions: { laya: decision(laya), gemini: decision(gemini), eligible: decision({}), skip: decision({}) } };
    row.sharedDecision = { ...row.providerDecisions.laya };
    state.markets[slug] = { end, payout: [1, 0] };
    state.snapshots.push(row);
    return row;
}

function fill(state, name, slug, pnl) {
    const row = { slug, closedAt: state.markets[slug].end, pnl, shares: 5, fees: .1, gas: .01 };
    state.arms[name].completed.push(row);
    state.arms[name].outcomes[slug] = { reason: 'settled', pnl };
    state.arms[name].seen[slug] = true;
    return row;
}

test('four-arm report is pure and describes configurations without summing virtual profits', () => {
    const state = fixture(), before = JSON.stringify(state), report = summarizeDecisionPaper(state, config, START);
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(Object.keys(report.arms), ARMS);
    assert.equal(report.commonCohort.markets, 0);
    assert.equal(report.arms.gemini.researchEligibility.eligible, false);
    assert.equal(report.sharedInference, undefined);
    assert.equal(report.totalPnl, undefined);
    assert.equal(report.configurationComparison.pureModelAdvantageIsolated, false);
    assert.equal(report.configurationComparison.virtualArmProfitsAreAdditive, false);
    assert.equal(report.configurationComparison.executionWaitsForSlowerProvider, false);
    assert.equal(report.configurationComparison.eligibleLatencyMs, 250);
    assert.equal(report.executionQuality.sameExecutionBookRequiredAcrossProviders, false);
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.automaticPromotion, false);
});

test('five-arm filter report preserves controls, shared cost attribution and persisted risk evidence', () => {
    const state = fixture(); state.arms['laya-filtered'] = emptyArm();
    const row = snapshot(state, 'm1', START + 300000, { action: 'BUY_UP', cost: .01 });
    row.decisions['laya-filtered'] = { status: 'ok', action: 'SKIP', originalAction: 'BUY_UP',
        entryDisposition: 'filter_veto', filterReason: 'entry_filter_insufficient_buffer', inferenceSource: 'laya' };
    state.arms['laya-filtered'].stopped = { reason: 'research_drawdown_limit', evidence: { equity: 10 } };
    const report = summarizeDecisionPaper(state, { ...config, armNames: [...ARMS, 'laya-filtered'],
        entryFilter: { version: 'direction-volatility-buffer-v1', minBufferSigma: 1 } }, START + DAY);
    assert.equal(report.armNames.length, 5);
    assert.equal(report.providerInference.laya.requests, 1);
    assert.equal(report.arms['laya-filtered'].knownApiCost, .01);
    assert.equal(report.arms['laya-filtered'].netAfterAllAiCost, null);
    assert.equal(report.arms['laya-filtered'].aiCostAllocation, 'shared_laya_counterfactual_not_additive');
    assert.equal(report.entryFilterDiagnostics.vetoedSnapshots, 1);
    assert.equal(report.entryFilterDiagnostics.duplicateInferenceRequests, 0);
    assert.equal(report.entryFilterDiagnostics.validatedProfitability, false);
    assert.equal(report.arms['laya-filtered'].riskEvidence.research.equity, 10);
    assert.ok(report.comparisons.laya['laya-filtered']);
    assert.ok(report.comparisons.eligible['laya-filtered']);
    assert.equal(report.arms['laya-filtered'].signalQuality.independentMarkets, 0);
});

test('late response phase telemetry is aggregated once and never pretends to measure upstream queue', () => {
    const state = fixture();
    const row = snapshot(state, 'm1', START + 300000, {}, { status: 'decision_timeout', cost: null });
    row.providerDecisions.gemini.lateResponse = { status: 'ok', latencyMs: 7000,
        transportTimingMs: { localPreparation: 5, responseHeaders: 6900, firstContent: 6950, bodyComplete: 6995 } };
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.providerInference.gemini.transportTimingMs.firstContent.p50, 6950);
    assert.equal(report.providerInference.gemini.transportTimingMs.firstContent.samples, 1);
    assert.equal(report.providerInference.gemini.transportTimingMs.firstReasoning.samples, 0);
    assert.equal(report.providerInference.gemini.routerQueueMs, null);
});

test('post-stop diagnostic answers stay separate from trading and pre-stop directional evidence', () => {
    const state = fixture(), row = snapshot(state, 'm1', START + 300000,
        { action: 'BUY_UP', diagnosticOnly: true, cost: .25 });
    row.decisions.laya.entryDisposition = 'arm_stopped';
    state.arms.laya.stopped = { reason: 'research_drawdown_limit' };
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.providerInference.laya.requests, 1);
    assert.equal(report.providerInference.laya.knownApiCost, .25);
    assert.equal(report.providerInference.laya.postStopCosts.knownApiCost, .25);
    assert.equal(report.arms.laya.knownApiCost, 0);
    assert.equal(report.arms.laya.netAfterKnownApiCost, 0);
    assert.equal(report.aiDecisionQuality.laya.independentMarkets, 0);
    assert.equal(report.arms.laya.signalQuality.independentMarkets, 0);
    assert.equal(report.responseDecisionQuality.laya.timely.responses, 0);
    assert.equal(report.postStopDecisionQuality.laya.timely.responses, 1);
    assert.equal(report.postStopDecisionQuality.laya.timely.wins, 1);
    assert.equal(report.arms.laya.completedFilled, 0);
    assert.equal(report.arms.laya.tradingPnl, 0);
});

test('each provider attempt and late response cost are counted once despite legacy aliases and duplicated snapshots', () => {
    const state = fixture();
    const first = snapshot(state, 'm1', START + 300000,
        { cost: 0, latencyMs: 100, model: 'typed-decisions', promptHash: 'original-prompt' },
        { cost: .02, latencyMs: 250, model: 'gemini-pinned', requestedModel: config.geminiModel, promptHash: 'gemini-prompt' });
    snapshot(state, 'm2', START + 600000, { status: 'decision_timeout', cost: null, latencyMs: 5000 },
        { status: 'decision_timeout', cost: .03, latencyMs: 5000, actualLatencyMs: 7000 });
    state.snapshots.push(structuredClone(first));
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.snapshots, 2);
    assert.equal(report.providerInference.laya.requests, 2);
    assert.equal(report.providerInference.gemini.requests, 2);
    assert.equal(report.providerInference.gemini.knownApiCost, .05);
    assert.equal(report.providerInference.laya.unknownApiCostRequests, 1);
    assert.equal(report.providerInference.gemini.unknownApiCostRequests, 0);
    assert.equal(report.providerInference.gemini.latencyMs.p95, 7000);
    assert.equal(report.providerInference.gemini.latencyMs.completedResponses, 2);
    assert.equal(report.providerInference.laya.latencyMs.completedResponses, 1);
    assert.equal(report.providerInference.laya.latencyMs.timeoutsWithoutResponse, 1);
    assert.equal(report.providerInference.gemini.latencyMs.timeoutCount, 1);
    assert.equal(report.providerInference.gemini.waitingMs.p95, 5000);
    assert.equal(report.providerInference.laya.totalAiCost, null);
    assert.equal(report.arms.gemini.netAfterKnownApiCost, -.05);
    assert.equal(report.arms.laya.knownApiCost, 0);
    assert.equal(report.arms.eligible.aiCostAllocation, 'no_inference');
    assert.equal(report.providerInference.laya.identity.configuredPromptHash, 'original-prompt');
    assert.deepEqual(report.providerInference.gemini.identity.observedModels, ['gemini-pinned']);
});

test('pending attempts survive missing response rows and disabled provider decisions do not invent requests', () => {
    const state = fixture(), row = snapshot(state, 'm1', START + 300000);
    delete row.providerDecisions.gemini;
    row.providerDecisions.laya = { status: 'provider_disabled', action: 'SKIP', cost: 0 };
    row.inferenceAttempts.laya = false;
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.providerInference.gemini.requests, 1);
    assert.equal(report.providerInference.gemini.status.pending, 1);
    assert.equal(report.providerInference.gemini.unknownApiCostRequests, 1);
    assert.equal(report.providerInference.laya.requests, 0);
    assert.equal(report.providerInference.laya.status.provider_disabled, 1);
    assert.equal(report.providerInference.laya.status.ok, undefined);
});

test('a response decoded after its deadline has completed latency but remains a timeout', () => {
    const state = fixture(), end = START + 300000, at = end - 60000;
    snapshot(state, 'm1', end, {}, { status: 'decision_timeout', action: 'SKIP',
        requestedAt: at, receivedAt: at + 5200, latencyMs: 5200, requestSubmitted: true });
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.providerInference.gemini.latencyMs.p50, 5200);
    assert.equal(report.providerInference.gemini.latencyMs.completedResponses, 1);
    assert.equal(report.providerInference.gemini.latencyMs.timeoutCount, 1);
    assert.equal(report.providerInference.gemini.latencyMs.timeoutsWithoutResponse, 0);
    assert.equal(report.aiDecisionQuality.gemini.independentMarkets, 0);
});

test('late valid BUY responses measure official direction without creating fills or trading profit', () => {
    const state = fixture(), row = snapshot(state, 'late-buy', START + 300000, {},
        { status: 'decision_timeout', action: 'SKIP', latencyMs: 5000, cost: null,
            requestedModel: 'polymarket-decision', resolvedModel: 'ag/gemini-3.8-flash-low' });
    row.inputHash = 'original-hash';
    row.informed = { inputHash: 'enriched-hash' };
    row.state = { allowed: ['BUY_UP'] };
    row.providerDecisions.gemini.lateResponse = { snapshotId: row.snapshotId, status: 'ok', action: 'BUY_UP',
        requestedAt: row.at, receivedAt: row.at + 75000, latencyMs: 75000, executable: false,
        originalInputHash: 'original-hash', inputHash: 'enriched-hash', model: 'gemini-3.8-flash-n',
        confidence: .7, reasonCode: 'favorable_edge', usage: { prompt_tokens: 10, completion_tokens: 2 }, cost: .02 };
    state.snapshots.push(structuredClone(row));
    const before = JSON.stringify(state), report = summarizeDecisionPaper(state,
        { ...config, geminiModel: 'polymarket-decision', geminiResolvedModel: 'ag/gemini-3.8-flash-low' }, START + DAY);
    assert.equal(JSON.stringify(state), before);
    const quality = report.responseDecisionQuality.gemini;
    assert.equal(quality.timely.responses, 0);
    assert.equal(quality.late.responses, 1);
    assert.equal(quality.late.buyResponses, 1);
    assert.equal(quality.late.officiallyLabeledBuyResponses, 1);
    assert.equal(quality.late.wins, 1);
    assert.equal(quality.late.winRate, 1);
    assert.equal(quality.allValid.independentMarkets, 1);
    assert.equal(quality.changesTradingResults, false);
    assert.equal(quality.late.latencyMs.p95, 75000);
    assert.match(quality.lateResponseLimitation, /no_hypothetical_fill_or_profit/);
    assert.equal(report.aiDecisionQuality.gemini.independentMarkets, 0);
    assert.equal(report.pairedDecisionQuality.markets, 0);
    assert.equal(report.arms.gemini.completedFilled, 0);
    assert.equal(report.arms.gemini.tradingPnl, 0);
    assert.equal(report.providerInference.gemini.requests, 1);
    assert.equal(report.providerInference.gemini.status.decision_timeout, 1);
    assert.equal(report.providerInference.gemini.knownApiCost, .02);
    assert.equal(report.providerInference.gemini.latencyMs.p95, 75000);
    assert.equal(report.providerInference.gemini.latencyMs.timeoutsWithoutResponse, 0);
    assert.equal(report.arms.gemini.netAfterKnownApiCost, -.02);
    assert.equal(report.providerInference.gemini.identity.configuredModel, 'polymarket-decision');
    assert.equal(report.providerInference.gemini.identity.configuredResolvedModel, 'ag/gemini-3.8-flash-low');
    assert.deepEqual(report.providerInference.gemini.identity.resolvedModels, ['ag/gemini-3.8-flash-low']);
    assert.deepEqual(report.providerInference.gemini.identity.requestedModels, ['polymarket-decision']);
    assert.deepEqual(report.providerInference.gemini.identity.observedModels, ['gemini-3.8-flash-n']);
});

test('response diagnostics exclude invalid, disallowed, mismatched and unreceived late decisions', () => {
    const state = fixture();
    const variants = [
        { status: 'invalid' }, { status: 'rejected' }, { status: 'provider_error' },
        { requestSubmitted: false }, { tokenUsageMatches: false },
        { reason: 'disallowed_action' }, { action: 'BUY_DOWN' }, { snapshotId: 'another-snapshot' },
        { originalInputHash: 'another-input' }, { inputHash: 'another-context' },
        { receivedAt: START + 2 * DAY }, { receivedAt: START }, { requestedAt: null },
    ];
    for (const [index, extra] of variants.entries()) {
        const row = snapshot(state, `invalid-${index}`, START + 300000, {},
            { status: 'decision_timeout', action: 'SKIP', cost: null });
        row.inputHash = 'original'; row.informed = { inputHash: 'enriched' };
        row.allowed = [{ index: 0 }];
        row.providerDecisions.gemini.lateResponse = { status: 'ok', action: 'BUY_UP', requestedAt: row.at,
            receivedAt: row.at + 6000, latencyMs: 6000, executable: false,
            snapshotId: row.snapshotId, inputHash: 'enriched', originalInputHash: 'original', ...extra };
    }
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.responseDecisionQuality.gemini.allValid.responses, 0);
    assert.equal(report.responseDecisionQuality.gemini.late.independentMarkets, 0);
    assert.equal(report.arms.gemini.completedFilled, 0);
    assert.equal(report.providerInference.gemini.unknownApiCostRequests, variants.length);
});

test('response diagnostics retain SKIPs and separate cohorts while selecting one BUY per labeled market', () => {
    const state = fixture(), late = snapshot(state, 'same-market', START + 300000, {},
        { status: 'decision_timeout', action: 'SKIP', cost: .02 });
    late.providerDecisions.gemini.lateResponse = { status: 'ok', action: 'BUY_UP', requestedAt: late.at,
        receivedAt: late.at + 6000, latencyMs: 6000, executable: false, cost: .02 };
    const timely = snapshot(state, 'same-market', START + 300000, {}, { action: 'BUY_DOWN', cost: 0 });
    timely.at += 10000;
    const skipped = snapshot(state, 'skip', START + 600000, {}, { status: 'decision_timeout', cost: 0 });
    skipped.providerDecisions.gemini.lateResponse = { status: 'ok', action: 'SKIP', requestedAt: skipped.at,
        receivedAt: skipped.at + 6000, latencyMs: 6000, cost: null };
    const unlabeled = snapshot(state, 'unlabeled', START + 900000, {}, { action: 'BUY_UP' });
    delete state.markets[unlabeled.market].payout;
    const report = summarizeDecisionPaper(state, config, START + DAY), quality = report.responseDecisionQuality.gemini;
    assert.equal(quality.timely.responses, 2);
    assert.equal(quality.timely.officiallyLabeledBuyResponses, 1);
    assert.equal(quality.timely.losses, 1);
    assert.equal(quality.late.responses, 2);
    assert.equal(quality.late.skipResponses, 1);
    assert.equal(quality.late.wins, 1);
    assert.equal(quality.allValid.responses, 4);
    assert.equal(quality.allValid.buyResponses, 3);
    assert.equal(quality.allValid.independentMarkets, 1);
    assert.equal(quality.allValid.wins, 1);
    assert.equal(report.aiDecisionQuality.gemini.losses, 1);
    assert.equal(report.providerInference.gemini.knownApiCost, .02);
    assert.equal(report.providerInference.gemini.unknownApiCostRequests, 1);
});

test('provider availability exposes durable pending and recovery state separately from disabling', () => {
    const state = fixture();
    state.providers.gemini = { pending: { snapshotId: 'pending' }, recoveryAt: START + 120000,
        recoveryReason: 'inference_unresolved', disabled: null };
    const report = summarizeDecisionPaper(state, config, START);
    assert.deepEqual(report.providerInference.gemini.availability, { pending: true,
        recoveryAt: START + 120000, recoveryReason: 'inference_unresolved', disabled: null, unavailable: null });
    state.providers.gemini = { pending: null, recoveryAt: null, recoveryReason: null, disabled: null };
    const recovered = summarizeDecisionPaper(state, config, START + 180000);
    assert.equal(recovered.providerInference.gemini.availability.pending, false);
    assert.equal(recovered.providerInference.gemini.availability.recoveryAt, null);
    assert.equal(recovered.providerInference.gemini.availability.disabled, null);
});

test('valid non-executable SKIP responses still count as timely without receiving a direction score', () => {
    const state = fixture(), row = snapshot(state, 'skip', START + 300000);
    row.decisionDeadlineAt = row.at + 5000;
    row.providerDecisions.laya = { status: 'ok', action: 'SKIP', requestedAt: row.at,
        receivedAt: row.at + 100, latencyMs: 100, executable: false };
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.responseDecisionQuality.laya.timely.responses, 1);
    assert.equal(report.responseDecisionQuality.laya.timely.skipResponses, 1);
    assert.equal(report.responseDecisionQuality.laya.late.responses, 0);
    assert.equal(report.responseDecisionQuality.laya.allValid.independentMarkets, 0);
});

test('transport failures remain waiting-time evidence while an HTTP rejection has completed response latency', () => {
    const state = fixture(), end = START + 300000, at = end - 60000;
    snapshot(state, 'transport', end, {}, { status: 'provider_error', requestedAt: at,
        receivedAt: at + 2300, latencyMs: 2300, requestSubmitted: true, httpStatus: null,
        reason: 'request_failed', cost: null });
    snapshot(state, 'http', end + 300000, {}, { status: 'provider_error', requestedAt: at + 300000,
        receivedAt: at + 300300, latencyMs: 300, requestSubmitted: true, httpStatus: 503,
        reason: 'provider_http_failed', cost: null });
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.equal(report.providerInference.gemini.requests, 2);
    assert.equal(report.providerInference.gemini.latencyMs.completedResponses, 1);
    assert.equal(report.providerInference.gemini.latencyMs.p95, 300);
    assert.equal(report.providerInference.gemini.waitingMs.p95, 2300);
    assert.equal(report.providerInference.gemini.unknownApiCostRequests, 2);
    assert.equal(report.providerInference.laya.localComputeCost, null);
    assert.equal(report.providerInference.laya.totalAiCost, null);
    assert.equal(report.arms.laya.netAfterAllAiCost, null);
});

test('both baselines use exactly the same official cohort including skips and timeouts', () => {
    const state = fixture();
    snapshot(state, 'm1', START + 300000);
    fill(state, 'laya', 'm1', -.8);
    fill(state, 'gemini', 'm1', .6);
    fill(state, 'eligible', 'm1', .2);
    snapshot(state, 'm2', START + 600000, { status: 'decision_timeout', cost: null }, { action: 'SKIP' });
    fill(state, 'eligible', 'm2', -.5);
    const missing = snapshot(state, 'missing', START + 900000);
    delete missing.decisions.gemini;
    snapshot(state, 'unlabeled', START + 1200000);
    delete state.markets.unlabeled.payout;
    snapshot(state, 'open', START + 1500000);
    state.arms.gemini.position = { market: { slug: 'open' }, status: 'filled', holdings: 5 };
    const report = summarizeDecisionPaper(state, config, START + DAY);
    assert.deepEqual(report.commonCohort.marketIds, ['m1', 'm2']);
    assert.equal(report.commonCohort.officialLabelsPending, 1);
    assert.equal(report.commonCohort.unresolvedMarkets, 2);
    assert.equal(report.comparisons.laya.gemini.tradingDifference, 1.4);
    assert.equal(report.comparisons.eligible.gemini.tradingDifference, .9);
    assert.equal(report.comparisons.eligible.laya.tradingDifference, -.5);
    assert.equal(report.comparisons.eligible.skip.tradingDifference, .3);
    for (const comparisons of Object.values(report.comparisons)) for (const comparison of Object.values(comparisons)) {
        assert.equal(comparison.matchedMarkets, 2);
        assert.equal(comparison.includesSkipAndTimeout, true);
        assert.equal(comparison.tradingMeanDifferenceCi95, null);
        assert.ok(comparison.uncertainty.reasons.includes('insufficient_cohort_markets'));
    }
});

test('provider direction quality uses raw timely decisions independently of fills and rejects late answers', () => {
    const state = fixture(), adaptive = { ...config, decisionTimeoutPolicy: 'snapshot-freshness-budget-v1' };
    const row = snapshot(state, 'm1', START + 300000);
    row.decisionDeadlineAt = row.at + 4600;
    row.providerDecisions.laya = { status: 'ok', action: 'BUY_UP', requestedAt: row.at,
        receivedAt: row.at + 3500, latencyMs: 3500 };
    row.providerDecisions.gemini = { status: 'ok', action: 'BUY_DOWN', requestedAt: row.at,
        receivedAt: row.at + 100, latencyMs: 100 };
    row.decisions.laya = { ...row.providerDecisions.laya, entryDisposition: 'arm_unavailable' };
    fill(state, 'laya', 'm1', -.5);
    const late = snapshot(state, 'late', START + 600000);
    late.decisionDeadlineAt = late.at + 4000;
    late.providerDecisions.gemini = { status: 'ok', action: 'BUY_UP', requestedAt: late.at,
        receivedAt: late.at + 4001, latencyMs: 4001 };
    const report = summarizeDecisionPaper(state, adaptive, START + DAY);
    assert.equal(report.aiDecisionQuality.laya.winRate, 1);
    assert.equal(report.aiDecisionQuality.gemini.winRate, 0);
    assert.equal(report.aiDecisionQuality.gemini.independentMarkets, 1);
    assert.equal(report.arms.laya.tradingPnl, -.5);
    assert.equal(report.arms.laya.executionWinRate, 0);
    assert.equal(report.pairedDecisionQuality.markets, 1);
    assert.equal(report.pairedDecisionQuality.sameSnapshotMarkets, 1);
    assert.equal(report.pairedDecisionQuality.byProvider.gemini.losses, 1);
});

test('paired differences bootstrap daily only after elapsed days, observed days and common markets suffice', () => {
    const state = fixture();
    for (let index = 0; index < 105; index++) {
        const slug = `market-${index}`;
        snapshot(state, slug, START + Math.floor(index / 15) * DAY + 300000 + index * 1000);
        fill(state, 'laya', slug, .1);
        fill(state, 'gemini', slug, .3);
        fill(state, 'eligible', slug, .2);
    }
    const report = summarizeDecisionPaper(state, config, START + 8 * DAY);
    assert.equal(report.commonCohort.observedDays, 7);
    assert.equal(report.comparisons.eligible.gemini.uncertainty.sufficient, true);
    assert.ok(Math.abs(report.comparisons.eligible.gemini.tradingMeanDifferenceCi95.lower - .1) < 1e-8);
    assert.ok(report.comparisons.eligible.laya.tradingMeanDifferenceCi95.upper < 0);
    assert.equal(report.comparisons.laya.gemini.uncertainty.timezone, 'Asia/Jakarta');
    assert.equal(report.comparisons.laya.gemini.uncertainty.method, 'daily_cluster_bootstrap');
});

test('private report files use the durable ledger and retain explicit limitations', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const state = fixture(), period = path.join(dataDir, config.id);
    fs.mkdirSync(period);
    fs.writeFileSync(path.join(period, 'ledger.json'), JSON.stringify(state));
    const report = writeDecisionPaperReport({ ...config, dataDir });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(period, 'reports', 'latest.json'))), report);
    assert.equal(fs.statSync(path.join(period, 'reports', 'latest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(period, 'reports', 'latest.md')).mode & 0o777, 0o600);
    const markdown = fs.readFileSync(path.join(period, 'reports', 'latest.md'), 'utf8');
    assert.match(markdown, /tidak mengisolasi keunggulan model murni/);
    assert.match(markdown, /Profit arm virtual tidak dijumlahkan/);
    assert.match(markdown, /Delta vs eligible/);
    assert.match(markdown, /insufficient_cohort_markets/);
    assert.match(markdown, /tanpa profit hipotetis/);
    assert.match(markdown, /model respons/);
    assert.match(markdown, /recoveryAt/);
    assert.match(markdown, /Tidak ada cutoff confidence aktif/);
    assert.throws(() => writeDecisionPaperReport({ ...config, id: '../unsafe', dataDir }), /identity_mismatch/);
});

test('history preserves legacy v1/v2/v3 policies and arms alongside the new period', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-history-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const writePeriod = (state, policy) => {
        const dir = path.join(dataDir, state.id);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(state));
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: state.id, paperOnly: true, policy }));
    };
    writePeriod(fixture(), config);
    fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id: config.id, paperOnly: true }));
    const periods = [];
    for (const version of [1, 2, 3]) {
        const id = `legacy-v${version}`, state = { ...fixture(), id,
            arms: Object.fromEntries(OLD_ARMS.map(name => [name, emptyArm()])) };
        writePeriod(state, { ...config, id, schema: version, armNames: OLD_ARMS,
            experiment: `laya-independent-filter-paper-v${version}`,
            decisionTimeoutPolicy: version === 3 ? 'snapshot-freshness-budget-v1' : null });
        periods.push({ id, dataDir, archivedAt: START + version * 1000 });
    }
    fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify({ periods: [...periods, periods[0]] }));
    const report = readDecisionPaperReports({ dataDir }, true);
    assert.equal(report.experiment, 'decision-paper-v1');
    assert.equal(report.history.length, 3);
    assert.deepEqual(report.history.map(row => row.id), ['legacy-v3', 'legacy-v2', 'legacy-v1']);
    for (const row of report.history) {
        assert.deepEqual(Object.keys(row.arms), OLD_ARMS);
        assert.equal(row.providerInference, undefined);
        assert.equal(row.sharedInference.requests, 0);
    }
    assert.equal(report.history[0].periodPolicy.decisionTimeoutPolicy, 'snapshot-freshness-budget-v1');
    assert.equal(report.history[1].periodPolicy.decisionTimeoutPolicy, null);
    assert.throws(() => readDecisionPaperReports({ dataDir: 'relative' }), /identity_mismatch/);
    fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id: config.id, paperOnly: false }));
    assert.throws(() => readDecisionPaperReports({ dataDir }, true), /identity_mismatch/);
});
