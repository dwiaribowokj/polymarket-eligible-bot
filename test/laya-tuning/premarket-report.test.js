import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePremarketPaper, savePremarketPaperReport, readPremarketPaperReports }
    from '../../src/premarket-paper/report.js';

const ARMS = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const START = Date.UTC(2026, 9, 26), NOW = START + 86400000;
const config = { id: 'premarket-period', experiment: 'premarket-three-candles-paper-v1', armNames: ARMS,
    inferencePolicy: 'independent-laya-router-frozen-forecast-30s', capital: 20, shares: 5, entryCap: 5,
    costCapPerShare: .85, leadSeconds: 240, aiDecisionMs: 30000,
    providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' } };
const nearOpenConfig = { ...config, id: 'near-open-period', profile: 'near-open-30m-v1',
    activeArms: ['router-premarket'], leadSeconds: 60, candleCount: 30, candleIntervalMs: 60000,
    historyMs: 1800000, diagnosticHistoryMs: 1800000, signalPolicy: 'router-full-30m-candles-near-open-value-v1' };
const empty = () => ({ cash: 20, peak: 20, drawdown: 0, stopped: null, positions: {}, completed: [], outcomes: {} });
const fixture = (id = config.id) => ({ id, startedAt: START, snapshots: [], slots: {}, markets: {}, errors: {},
    arms: Object.fromEntries(ARMS.map(name => [name, empty()])) });
function market(state, slug, payout = [0, 1]) {
    state.markets[slug] = { slug, open: START + 300000, end: START + 600000, enrolledAt: START,
        payout, labelResolvedAt: START + 601000 };
    for (const name of ARMS) state.arms[name].outcomes[slug] = { reason: 'signal_not_met', noExposure: true, pnl: 0 };
}
function fill(state, name, slug, pnl, extra = {}) {
    const row = { slug, side: 'DOWN', pnl, shares: 5, fees: .05, gas: .05, entryCost: 4,
        closedAt: START + 601000, openedAt: START + 60000, executionAt: START + 60250, capitalHours: .6, ...extra };
    state.arms[name].completed.push(row);
    state.arms[name].outcomes[slug] = { reason: 'settled', noExposure: false, pnl };
    return row;
}
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'premarket-report-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function period(directory, id = config.id, policy = config, state = fixture(id)) {
    const dir = path.join(directory, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ id, paperOnly: true }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, paperOnly: true, policy }));
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(state)); return dir;
}

test('four isolated arms expose no fabricated accuracy or profitability before filled resolution', () => {
    const state = fixture(); market(state, 'skip');
    const before = JSON.stringify(state), report = summarizePremarketPaper(state, config, NOW);
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(Object.keys(report.arms), ARMS);
    assert.deepEqual(report.activeArms, ARMS);
    assert.ok(Object.values(report.arms).every(arm => arm.enabled));
    assert.equal(report.totalPnl, undefined);
    assert.equal(report.automaticPromotion, false);
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.hypothesis.validatedProfitability, false);
    assert.equal(report.hypothesis.illustrativePriceMeaning, 'per_share_example_not_total_budget_price_gate_or_fill_guarantee');
    assert.deepEqual(report.hypothesis.directions, ['Up', 'Down']);
    assert.equal(report.virtualCapital.armProfitsMayBeSummed, false);
    for (const arm of Object.values(report.arms)) {
        assert.equal(arm.accuracy.rate, null); assert.equal(arm.netWinRate, null);
        assert.equal(arm.completedFilled, 0); assert.equal(arm.noEntryMarkets, 1);
    }
    assert.equal(report.commonCohort.markets, 1);
    assert.equal(report.pairedComparisons['premarket-momentum'].neitherFilledMarkets, 1);
});

test('same enrolled cohort includes final skip and no-fill zero but excludes pending and unlabelled outcomes', () => {
    const state = fixture();
    for (const slug of ['win', 'loss', 'control-only', 'skip', 'pending', 'missing', 'unknown']) market(state, slug);
    fill(state, 'premarket-momentum', 'win', .95);
    fill(state, 'premarket-momentum', 'loss', -4.05); state.markets.loss.payout = [1, 0];
    fill(state, 'late-cost-cap', 'control-only', .5);
    state.arms['late-cost-cap'].outcomes.win = { noExposure: true, reason: 'no_fill', pnl: 0 };
    state.arms['router-premarket'].positions.pending = { market: { slug: 'pending' }, status: 'matched' };
    delete state.arms['laya-premarket'].outcomes.missing;
    state.markets.unknown.payout = null;
    state.markets.notEnrolled = { end: START + 600000, payout: [0, 1] };
    const report = summarizePremarketPaper(state, config, NOW), pair = report.pairedComparisons['premarket-momentum'];
    assert.equal(report.commonCohort.enrolledMarkets, 7);
    assert.equal(report.commonCohort.markets, 4);
    assert.equal(report.commonCohort.unknownOutcomesCountedAsZero, false);
    assert.deepEqual(report.commonCohort.excludedReasons, { arm_outcome_pending: 2, official_label_pending: 1 });
    assert.equal(pair.primaryPnl, -3.1); assert.equal(pair.controlPnl, .5);
    assert.equal(pair.primaryMinusControlPnl, -3.6);
    assert.equal(pair.primaryAveragePnlPerMarket, -.775);
    assert.equal(pair.primaryOnlyFilledMarkets, 2); assert.equal(pair.controlOnlyFilledMarkets, 1);
    assert.equal(report.arms['late-cost-cap'].noFillMarkets, 1);
    assert.equal(report.arms['router-premarket'].matchedUnsettled, 1);
});

test('official direction accuracy differs from net wins and excludes neutral payouts and incomplete rows', () => {
    const state = fixture();
    market(state, 'expensive'); fill(state, 'premarket-momentum', 'expensive', -.05);
    market(state, 'neutral', [.5, .5]); fill(state, 'premarket-momentum', 'neutral', -1.55);
    market(state, 'future'); fill(state, 'premarket-momentum', 'future', .95);
    state.markets.future.labelResolvedAt = NOW + 1;
    market(state, 'ambiguous'); fill(state, 'premarket-momentum', 'ambiguous', .95);
    fill(state, 'premarket-momentum', 'ambiguous', .9);
    const arm = summarizePremarketPaper(state, config, NOW).arms['premarket-momentum'];
    assert.equal(arm.completedFilled, 2); assert.equal(arm.wins, 0); assert.equal(arm.losses, 2);
    assert.deepEqual(arm.accuracy, { correct: 1, incorrect: 0, neutral: 1, denominator: 1, rate: 1,
        basis: 'actual_filled_officially_resolved_binary_outcomes_only' });
});

test('actual partial fill economics include gas per filled share and capital duration', () => {
    const state = fixture(); market(state, 'partial');
    fill(state, 'late-cost-cap', 'partial', .11, { shares: 1, entryCost: .84, fees: .01, gas: .05, partial: true, capitalHours: .1 });
    const report = summarizePremarketPaper(state, config, NOW), arm = report.arms['late-cost-cap'];
    assert.equal(arm.economics.grossTradingPnl, .17);
    assert.equal(arm.economics.averageFillPrice, .83);
    assert.equal(arm.economics.observedEntryCosts.meanAllInCostPerShare, .89);
    assert.equal(arm.economics.observedEntryCosts.aboveFullFillAdmissionCap, 1);
    assert.equal(arm.partialFills, 1); assert.equal(arm.economics.netPnlPerCapitalHour, 1.1);
    assert.match(report.hypothesis.partialFillCaveat, /partial_fill/);
    delete state.arms['late-cost-cap'].completed[0].fees;
    assert.equal(summarizePremarketPaper(state, config, NOW).arms['late-cost-cap'].economics.grossTradingPnl, null);
});

test('router unknown costs never become zero and valid decision accuracy is distinct from fill accuracy', () => {
    const state = fixture(); market(state, 'decision');
    state.snapshots.push({ snapshotId: 's1', market: { slug: 'decision' }, scheduledAt: START,
        observedAt: START, aiDeadlineAt: START + 30000, decisions: {
            'router-premarket': { status: 'ok', action: 'BUY_DOWN', startedAt: START, receivedAt: START + 1000,
                latencyMs: 1000, inferenceAttempted: true, requestSubmitted: true, cost: null,
                model: 'cx/gpt-6.1-sol', costBasis: 'subscription_usage_unpriced' },
            'laya-premarket': { status: 'ok', action: 'BUY_UP', startedAt: START, receivedAt: START + 2000,
                inferenceAttempted: true, requestSubmitted: true, cost: 0, model: 'laya' } } });
    let report = summarizePremarketPaper(state, config, NOW), router = report.arms['router-premarket'];
    assert.equal(router.inference.requests, 1); assert.equal(router.inference.submittedRequests, 1);
    assert.equal(router.inference.unknownCostRequests, 1); assert.equal(router.inference.totalCost, null);
    assert.equal(router.netAfterInference, null); assert.equal(router.tradingPnl, 0);
    assert.equal(router.informationalCriteria.inferenceCostKnown, false);
    assert.equal(router.informationalCriteria.positiveNetAfterInferenceExcludingCompute, null);
    assert.equal(router.inference.directionalDecisionAccuracy.rate, 1); assert.equal(router.accuracy.rate, null);
    assert.equal(report.arms['laya-premarket'].inference.totalCost, 0);
    assert.equal(report.arms['laya-premarket'].inference.computeCost, null);
    assert.deepEqual(router.inference.actualModels, ['cx/gpt-6.1-sol']);
    state.snapshots[0].decisions['router-premarket'].receivedAt = START + 30001;
    report = summarizePremarketPaper(state, config, NOW);
    assert.equal(report.arms['router-premarket'].inference.directionalDecisionAccuracy.rate, null);
});

test('model abstentions, invalid responses and execution dispositions remain separate from forecast direction', () => {
    const state = fixture();
    const decisions = [
        { status: 'ok', action: 'SKIP', reasonCode: 'no_positive_edge', entryDisposition: 'provider_skip',
            estimatedUpProbability: .51, forecastDirection: 'UP', rationale: 'Costs exceed the estimated edge.',
            expectedNetUsd: { BUY_UP: -.18, BUY_DOWN: -.23 } },
        { status: 'provider_error', action: 'SKIP', reason: 'invalid_response', entryDisposition: 'provider_error' },
        { status: 'decision_timeout', action: 'SKIP', entryDisposition: 'provider_late' },
        { status: 'ok', action: 'BUY_UP', reasonCode: 'positive_edge', entryDisposition: 'reserved',
            estimatedUpProbability: .7, forecastDirection: 'UP' },
        { status: 'ok', action: 'BUY_DOWN', reasonCode: 'positive_edge', entryDisposition: 'no_fill',
            estimatedUpProbability: .3, forecastDirection: 'DOWN' },
        { status: 'ok', action: 'SKIP', entryDisposition: 'provider_skip' },
        { status: 'ok', action: 'SKIP', reasonCode: 'insufficient_predictive_evidence', entryDisposition: 'provider_skip',
            estimatedUpProbability: null }
    ];
    for (const [index, decision] of decisions.entries()) {
        const slug = `decision-${index}`; market(state, slug);
        state.snapshots.push({ snapshotId: slug, market: { slug }, scheduledAt: START, observedAt: START,
            aiDeadlineAt: START + 30000, decisions: { 'router-premarket': { startedAt: START,
                receivedAt: START + 1000, inferenceAttempted: true, requestSubmitted: true, cost: null, ...decision } } });
    }
    const inference = summarizePremarketPaper(state, config, NOW).arms['router-premarket'].inference;
    assert.equal(inference.requests, 7); assert.equal(inference.validResponses, 5);
    assert.deepEqual(inference.requestStatuses, { ok: 5, provider_error: 1, decision_timeout: 1 });
    assert.deepEqual(inference.validActionCounts, { BUY_UP: 1, BUY_DOWN: 1, SKIP: 3 });
    assert.equal(inference.modelSkips, 3);
    assert.deepEqual(inference.modelSkipReasons, { no_positive_edge: 1, unknown: 1, insufficient_predictive_evidence: 1 });
    assert.deepEqual(inference.forecastDirectionCounts, { UP: 2, DOWN: 1, unknown: 2 });
    assert.deepEqual(inference.entryDispositions, { provider_skip: 3, provider_error: 1, provider_late: 1, reserved: 1, no_fill: 1 });
    const [skip, error, , buyUp, buyDown, legacy] = inference.requestsEvidence;
    assert.equal(skip.estimatedUpProbability, .51);
    assert.equal(skip.estimatedUpProbabilityType, 'self_reported_uncalibrated_market_probability');
    assert.equal(skip.estimatedProbabilityCalibrated, false);
    assert.equal(skip.rationale, 'Costs exceed the estimated edge.');
    assert.deepEqual(skip.expectedNetUsd, { BUY_UP: -.18, BUY_DOWN: -.23 });
    assert.equal(error.providerErrorReason, 'invalid_response');
    assert.equal(buyUp.action, 'BUY_UP'); assert.equal(buyDown.action, 'BUY_DOWN');
    assert.equal(legacy.reasonCode, 'unknown'); assert.equal(legacy.rationale, null);
    assert.equal(legacy.estimatedUpProbability, null); assert.equal(legacy.expectedNetUsd, null);
});

test('request diagnostics are bounded and malformed legacy estimates are not presented as probabilities', () => {
    const state = fixture(); market(state, 'diagnostics');
    state.snapshots.push({ market: { slug: 'diagnostics' }, decisions: { 'router-premarket': {
        status: 'ok', action: 'SKIP', requestSubmitted: true, reasonCode: 'not_a_contract_reason',
        rationale: '\n' + 'x'.repeat(500), estimatedUpProbability: 1.1, forecastDirection: 'UP_AND_DOWN',
        expectedNetUsd: { BUY_UP: Infinity, BUY_DOWN: '0.3', extra: 999 } } } });
    const inference = summarizePremarketPaper(state, config, NOW).arms['router-premarket'].inference;
    assert.deepEqual(inference.modelSkipReasons, { unknown: 1 });
    const diagnostic = inference.requestsEvidence[0];
    assert.equal(diagnostic.reasonCode, 'unknown'); assert.equal(diagnostic.rationale.length, 240);
    assert.ok(!diagnostic.rationale.includes('\n'));
    assert.equal(diagnostic.estimatedUpProbability, null); assert.equal(diagnostic.forecastDirection, 'unknown');
    assert.deepEqual(diagnostic.expectedNetUsd, { BUY_UP: null, BUY_DOWN: null });
});

test('selected router arm cannot claim a comparison against an inactive control', t => {
    const state = fixture(); market(state, 'router-only');
    fill(state, 'router-premarket', 'router-only', .95);
    for (const name of ARMS.filter(name => name !== 'router-premarket')) delete state.arms[name].outcomes['router-only'];
    const policy = { ...config, activeArms: ['router-premarket'], minDays: 1, minMarkets: 1 };
    const report = savePremarketPaperReport({ ...policy, dataDir: temporary(t) }, state, NOW);
    assert.deepEqual(Object.keys(report.arms), ARMS);
    assert.deepEqual(report.activeArms, ['router-premarket']);
    assert.equal(report.arms['router-premarket'].enabled, true);
    assert.equal(report.arms['router-premarket'].enrolledMarketEvidence.sufficientSample, true);
    assert.equal(report.commonCohort.markets, 1);
    assert.deepEqual(report.commonCohort.activeArms, ['router-premarket']);
    assert.match(report.commonCohort.basis, /selected_arms/);
    for (const name of ARMS.filter(name => name !== 'router-premarket')) {
        const arm = report.arms[name];
        assert.equal(arm.enabled, false); assert.equal(arm.enrolledMarketEvidence.available, false);
        assert.equal(arm.enrolledMarketEvidence.sufficientSample, false);
        assert.deepEqual(arm.enrolledMarketEvidence.reasons, ['arm_not_selected']);
        assert.equal(arm.informationalCriteria.automaticQualification, false);
    }
    for (const pair of Object.values(report.pairedComparisons)) {
        assert.equal(pair.available, false); assert.equal(pair.reason, 'arm_not_selected');
        assert.equal(pair.primaryPnl, null); assert.equal(pair.controlPnl, null);
        assert.equal(pair.primaryMinusControlPnl, null); assert.deepEqual(pair.rows, []);
        assert.equal(pair.pairedDeltaEvidence.sufficientSample, false);
        assert.equal(pair.informationalCriteria.positiveTradingDifference, null);
        assert.equal(pair.informationalCriteria.automaticQualification, false);
    }
});

test('markdown exposes valid skips and inactive comparisons without claiming zero control PnL', t => {
    const state = fixture(); market(state, 'skip');
    state.snapshots.push({ market: { slug: 'skip' }, decisions: { 'router-premarket': {
        status: 'ok', action: 'SKIP', requestSubmitted: true, reasonCode: 'no_positive_edge',
        estimatedUpProbability: .51, forecastDirection: 'UP', entryDisposition: 'provider_skip' } } });
    const directory = temporary(t);
    savePremarketPaperReport({ ...config, dataDir: directory, activeArms: ['router-premarket'] }, state, NOW);
    const md = fs.readFileSync(path.join(directory, config.id, 'reports', 'latest.md'), 'utf8');
    assert.match(md, /Arm aktif: router-premarket/);
    assert.match(md, /SKIP model 1 \(no_positive_edge=1\)/);
    assert.match(md, /aksi valid BUY_UP=0, BUY_DOWN=0, SKIP=1/);
    assert.match(md, /arah prediksi UP=1/);
    assert.match(md, /perbandingan tidak tersedia \(arm_not_selected/);
    assert.match(md, /belum terkalibrasi/);
    assert.doesNotMatch(md, /delta PnL trading 0\.0000/);
});

test('legacy manifests retain three-candle requirements without inventing recorded input coverage', t => {
    const state = fixture(); market(state, 'legacy');
    state.snapshots.push({ market: { slug: 'legacy' }, decisions: { 'router-premarket': {
        status: 'ok', action: 'SKIP', requestSubmitted: true } } });
    const directory = temporary(t), report = savePremarketPaperReport({ ...config, dataDir: directory }, state, NOW);
    assert.equal(report.profile, 'legacy-three-candles-v1');
    assert.equal(report.hypothesis.decisionLeadSeconds, 240);
    assert.equal(report.historyRequirements.candleCount, 3);
    assert.equal(report.historyRequirements.historyMs, 180000);
    assert.equal(report.historyRequirements.diagnosticHistoryMs, 900000);
    assert.equal(report.arms['router-premarket'].inference.requestsEvidence[0].contextCoverage, null);
    assert.equal(report.arms['router-premarket'].inference.requestsEvidence[0].inputCoverage, null);
    const md = fs.readFileSync(path.join(directory, config.id, 'reports', 'latest.md'), 'utf8');
    assert.match(md, /open minus 240 detik/);
    assert.match(md, /3 candle selesai 1 menit \(3 menit\); history diagnostik 15 menit/);
    assert.match(md, /tiga candle 1 menit selesai bearish/);
    assert.doesNotMatch(md, /Warmup LIVE utuh/);
});

test('near-open reports preserve full history requirements, observed context, and actual request coverage', t => {
    const state = fixture(nearOpenConfig.id); market(state, 'near-open');
    fill(state, 'router-premarket', 'near-open', .95);
    const historyStartAt = START - 1800000, historyEndAt = START;
    const inputCoverage = { source: 'chainlink_btc_usd', completeMinutes: 30, minuteBars: 30,
        fiveMinuteGroups: 6, historyStartAt, historyEndAt, decisionAt: START, truncated: false };
    state.snapshots.push({ snapshotId: 'long-snapshot', market: { slug: 'near-open' }, scheduledAt: START,
        features: { bars: Array.from({ length: 30 }, (_, i) => ({ start: historyStartAt + i * 60000,
            end: historyStartAt + (i + 1) * 60000 })), context: { schema: 'near-open-30m-v1',
            source: 'chainlink_btc_usd', historyStartAt, historyEndAt, bars5m: Array.from({ length: 6 }, () => ({})),
            returnsUsd: { s30: 1, s60: 2, m3: 3, m5: 4, m15: 5, m30: 6 } } },
        decisions: { 'router-premarket': { status: 'ok', action: 'BUY_DOWN', requestSubmitted: true,
            inputCoverage, inputBytes: 9123, inputHash: 'full-input-hash' } } });
    const directory = temporary(t);
    const report = savePremarketPaperReport({ ...nearOpenConfig, dataDir: directory }, state, NOW);
    assert.equal(report.profile, 'near-open-30m-v1');
    assert.equal(report.hypothesis.signal, nearOpenConfig.signalPolicy);
    assert.equal(report.hypothesis.decisionLeadSeconds, 60);
    assert.equal(report.hypothesis.aiDecisionMs, 30000);
    assert.equal(report.hypothesis.momentumRuleActive, false);
    assert.equal(report.historyRequirements.candleCount, 30);
    assert.equal(report.historyRequirements.historyMs, 1800000);
    assert.equal(report.historyRequirements.diagnosticHistoryMs, 1800000);
    assert.equal(report.historyRequirements.uninterruptedLiveWarmupRequired, true);
    assert.equal(report.historyRequirements.startupAndGapWarmupMs, 1800000);
    assert.equal(report.historyRequirements.historicalBackfillAllowed, false);
    assert.equal(report.historyRequirements.silentInputTruncationAllowed, false);
    const request = report.arms['router-premarket'].inference.requestsEvidence[0];
    assert.deepEqual(request.inputCoverage, inputCoverage);
    assert.equal(request.inputBytes, 9123); assert.equal(request.inputHash, 'full-input-hash');
    assert.deepEqual(request.contextCoverage, { basis: 'recorded_frozen_snapshot_features', schema: 'near-open-30m-v1',
        source: 'chainlink_btc_usd', completed1mCandles: 30, grouped5mCandles: 6, historyStartAt, historyEndAt,
        historyMs: 1800000, availableReturnWindows: ['s30', 's60', 'm3', 'm5', 'm15', 'm30'] });
    assert.ok(Object.values(report.pairedComparisons).every(pair => !pair.available && pair.primaryMinusControlPnl === null));
    const md = fs.readFileSync(path.join(directory, nearOpenConfig.id, 'reports', 'latest.md'), 'utf8');
    assert.match(md, /Profil: near-open-30m-v1/); assert.match(md, /open minus 60 detik; budget AI 30 detik/);
    assert.match(md, /30 candle selesai 1 menit \(30 menit\); history diagnostik 30 menit/);
    assert.match(md, /6 kelompok candle 5 menit/); assert.match(md, /minimal 30 menit, tanpa backfill/);
    assert.doesNotMatch(md, /open minus 240|Data 15 menit hanya diagnostik|tiga candle 1 menit selesai bearish/);
    assert.doesNotMatch(md, /laya-premarket: request AI 0/);

    delete state.snapshots[0].features; delete state.snapshots[0].decisions['router-premarket'].inputCoverage;
    const missing = summarizePremarketPaper(state, nearOpenConfig, NOW).arms['router-premarket'].inference.requestsEvidence[0];
    assert.equal(missing.contextCoverage, null); assert.equal(missing.inputCoverage, null);
});

test('near-open and archived legacy results retain their own manifest parameters and separate evidence', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const currentState = fixture(nearOpenConfig.id), oldState = fixture('previous');
    market(currentState, 'current-win'); fill(currentState, 'router-premarket', 'current-win', .95);
    market(oldState, 'old-loss'); fill(oldState, 'router-premarket', 'old-loss', -4.05);
    period(current, nearOpenConfig.id, nearOpenConfig, currentState);
    period(old, 'previous', { ...config, activeArms: ['router-premarket'] }, oldState);
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [{ id: 'previous', dataDir: old, archivedAt: NOW }] }));
    const report = readPremarketPaperReports({ dataDir: current, profile: 'legacy-three-candles-v1', leadSeconds: 999 }, true);
    assert.equal(report.profile, 'near-open-30m-v1'); assert.equal(report.hypothesis.decisionLeadSeconds, 60);
    assert.equal(report.historyRequirements.candleCount, 30); assert.equal(report.historyRequirements.historyMs, 1800000);
    assert.equal(report.history.length, 1); assert.equal(report.history[0].profile, 'legacy-three-candles-v1');
    assert.equal(report.history[0].hypothesis.decisionLeadSeconds, 240);
    assert.equal(report.history[0].historyRequirements.candleCount, 3);
    assert.equal(report.history[0].historyRequirements.diagnosticHistoryMs, 900000);
    assert.equal(report.arms['router-premarket'].tradingPnl, .95);
    assert.equal(report.history[0].arms['router-premarket'].tradingPnl, -4.05);
    assert.equal(report.commonCohort.markets, 1); assert.equal(report.history[0].commonCohort.markets, 1);
    assert.equal(report.totalPnl, undefined);
});

test('saved reports are restrictive and report history reads stored policy in separate cohorts', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const state = fixture(); market(state, 'win'); fill(state, 'premarket-momentum', 'win', .95);
    const oldState = fixture('previous'); market(oldState, 'loss'); fill(oldState, 'premarket-momentum', 'loss', -4.05);
    period(current, config.id, config, state); period(old, 'previous', { ...config, costCapPerShare: .84 }, oldState);
    savePremarketPaperReport({ ...config, dataDir: current }, state, NOW);
    const reports = path.join(current, config.id, 'reports');
    for (const file of ['latest.json', 'latest.md']) assert.equal(fs.statSync(path.join(reports, file)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(reports).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(path.join(reports, 'latest.md'), 'utf8'), /partial fill/);
    const link = { id: 'previous', dataDir: old, archivedAt: NOW };
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [link, link] }));
    const report = readPremarketPaperReports({ dataDir: current, id: 'other', costCapPerShare: .1 }, true);
    assert.equal(report.id, config.id); assert.equal(report.hypothesis.costCapPerShare, .85);
    assert.equal(report.history.length, 1); assert.equal(report.history[0].hypothesis.costCapPerShare, .84);
    assert.deepEqual(report.history[0].activeArms, ARMS);
    assert.equal(report.arms['premarket-momentum'].tradingPnl, .95);
    assert.equal(report.history[0].arms['premarket-momentum'].tradingPnl, -4.05);
});

test('identity and unsafe period IDs fail closed without credential-dependent configuration', t => {
    const directory = temporary(t), state = fixture(), dir = period(directory);
    assert.throws(() => summarizePremarketPaper(state, { ...config, experiment: 'entry-filter-paper-v1' }), /identity_mismatch/);
    for (const activeArms of [[], ['unknown'], ['router-premarket', 'router-premarket'], 'router-premarket'])
        assert.throws(() => summarizePremarketPaper(state, { ...config, activeArms }), /identity_mismatch/);
    assert.throws(() => savePremarketPaperReport({ ...config, id: '../escape', dataDir: directory }, state), /identity_mismatch/);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ ...state, id: 'other' }));
    assert.throws(() => readPremarketPaperReports({ dataDir: directory }), /identity_mismatch/);
    const emptyDir = path.join(directory, 'empty');
    assert.deepEqual(readPremarketPaperReports({ dataDir: emptyDir }, true).history, []);
});

test('one observed day has no bootstrap interval and skips do not satisfy minimum completed fills', () => {
    const state = fixture(); market(state, 'fill'); market(state, 'skip');
    fill(state, 'premarket-momentum', 'fill', 1);
    const report = summarizePremarketPaper(state, config, START + 8 * 86400000);
    const evidence = report.arms['premarket-momentum'].enrolledMarketEvidence;
    assert.equal(report.elapsedDays, 8); assert.equal(report.elapsedHours, 192);
    assert.equal(evidence.markets, 2); assert.equal(evidence.meanPnlPerMarket, .5);
    assert.equal(evidence.observedDays, 1); assert.equal(evidence.ci95, null);
    assert.deepEqual(evidence.completedFillsPerArm, [1]);
    assert.equal(evidence.sufficientSample, false);
    assert.deepEqual(evidence.reasons, ['insufficient_observed_days', 'insufficient_completed_fills']);
    assert.equal(evidence.positiveMeanCiLowerBound, null);
    assert.equal(report.pairedComparisons['premarket-momentum'].pairedDeltaEvidence.ci95, null);
    assert.equal(report.arms['premarket-momentum'].informationalCriteria.automaticQualification, false);
    assert.equal(report.automaticPromotion, false);
});

test('WIB day blocks preserve within-day dependence and paired covariance with deterministic resampling', () => {
    const state = fixture(), day = 86400000;
    // Both groups share one UTC date and one delayed settlement day, but span two scheduled WIB days.
    const ends = [START + 16 * 3600000 + 50 * 60000, START + 17 * 3600000 + 10 * 60000];
    for (let group = 0; group < 2; group++) for (let i = 0; i < 20; i++) {
        const slug = `day-${group}-${i}`, pnl = group === 0 ? 1 : -1;
        market(state, slug);
        state.markets[slug].end = ends[group];
        state.markets[slug].labelResolvedAt = START + day + 600000;
        fill(state, 'premarket-momentum', slug, pnl, { closedAt: START + day + 600000 });
        fill(state, 'late-cost-cap', slug, pnl - .25, { closedAt: START + day + 600000 });
    }
    const policy = { ...config, minDays: 7, minMarkets: 10, bootstrapSamples: 2000 };
    const report = summarizePremarketPaper(state, policy, START + 8 * day);
    const arm = report.arms['premarket-momentum'].enrolledMarketEvidence;
    const paired = report.pairedComparisons['premarket-momentum'].pairedDeltaEvidence;
    assert.equal(arm.observedDays, 2); assert.equal(arm.timezone, 'Asia/Jakarta');
    assert.equal(arm.dayBasis, 'scheduled_market_end'); assert.equal(arm.markets, 40);
    assert.deepEqual(arm.ci95, { lower: -1, upper: 1 });
    assert.deepEqual(report.arms['late-cost-cap'].enrolledMarketEvidence.ci95, { lower: -1.25, upper: .75 });
    assert.deepEqual(paired.ci95, { lower: .25, upper: .25 });
    assert.equal(paired.meanPnlPerMarket, .25);
    assert.deepEqual(paired.completedFillsPerArm, [40, 40]);
    assert.equal(paired.sufficientSample, false); assert.deepEqual(paired.reasons, ['insufficient_observed_days']);
    assert.equal(paired.positiveMeanCiLowerBound, true);
    assert.deepEqual(summarizePremarketPaper(state, policy, START + 8 * day)
        .pairedComparisons['premarket-momentum'].pairedDeltaEvidence, paired);
    assert.equal(report.sufficientForLive, false); assert.equal(report.totalPnl, undefined);
});

test('positive daily intervals and seven observed days remain informational after minimum fills are met', () => {
    const state = fixture(), day = 86400000;
    for (let i = 0; i < 7; i++) {
        const slug = `observed-${i}`; market(state, slug);
        state.markets[slug].end += i * day;
        state.markets[slug].labelResolvedAt += i * day;
        fill(state, 'premarket-momentum', slug, 1, { closedAt: state.markets[slug].labelResolvedAt });
        fill(state, 'late-cost-cap', slug, .5, { closedAt: state.markets[slug].labelResolvedAt });
    }
    const report = summarizePremarketPaper(state, { ...config, minDays: 7, minMarkets: 7, bootstrapSamples: 100 }, START + 8 * day);
    const arm = report.arms['premarket-momentum'], pair = report.pairedComparisons['premarket-momentum'];
    assert.equal(arm.enrolledMarketEvidence.sufficientSample, true);
    assert.deepEqual(arm.enrolledMarketEvidence.ci95, { lower: 1, upper: 1 });
    assert.equal(pair.pairedDeltaEvidence.sufficientSample, true);
    assert.deepEqual(pair.pairedDeltaEvidence.ci95, { lower: .5, upper: .5 });
    assert.equal(arm.informationalCriteria.positiveTradingPnl, true);
    assert.equal(arm.informationalCriteria.positiveNetAfterInferenceExcludingCompute, true);
    assert.equal(arm.informationalCriteria.automaticQualification, false);
    assert.equal(pair.informationalCriteria.automaticQualification, false);
    assert.equal(report.hypothesis.validatedProfitability, false);
    assert.equal(report.sufficientForLive, false); assert.equal(report.automaticPromotion, false);
});

test('entry cutoff freezes all evidence duration while later official settlement still counts', () => {
    const state = fixture(), day = 86400000;
    market(state, 'draining'); fill(state, 'laya-premarket', 'draining', .95);
    state.entryCutoffAt = START + 300000;
    const before = JSON.stringify(state);
    const draining = summarizePremarketPaper(state, config, START + 30 * day);
    assert.equal(JSON.stringify(state), before);
    assert.equal(draining.entryCutoffAt, state.entryCutoffAt);
    assert.equal(draining.archivedAt, null);
    assert.equal(draining.elapsedThroughAt, state.entryCutoffAt);
    assert.equal(draining.elapsedHours, .083333);
    assert.equal(draining.commonCohort.markets, 1);
    assert.equal(draining.arms['laya-premarket'].completedFilled, 1);
    assert.equal(draining.arms['laya-premarket'].tradingPnl, .95);
    for (const arm of Object.values(draining.arms)) {
        assert.equal(arm.enrolledMarketEvidence.elapsedDays, draining.elapsedDays);
        assert.ok(arm.enrolledMarketEvidence.reasons.includes('insufficient_elapsed_days'));
    }
    for (const pair of Object.values(draining.pairedComparisons)) {
        assert.equal(pair.pairedDeltaEvidence.elapsedDays, draining.elapsedDays);
        assert.ok(pair.pairedDeltaEvidence.reasons.includes('insufficient_elapsed_days'));
    }
    state.archivedAt = START + 900000;
    const archived = summarizePremarketPaper(state, config, START + 60 * day);
    assert.equal(archived.archivedAt, state.archivedAt);
    assert.equal(archived.elapsedDays, draining.elapsedDays);
    assert.equal(archived.arms['laya-premarket'].tradingPnl, .95);
});

test('evidence duration uses the earliest valid cutoff, archive or report time', () => {
    const state = fixture();
    state.entryCutoffAt = 'invalid'; state.archivedAt = new Date(START + 3600000).toISOString();
    const archived = summarizePremarketPaper(state, config, START + 30 * 86400000);
    assert.equal(archived.entryCutoffAt, null);
    assert.equal(archived.archivedAt, START + 3600000);
    assert.equal(archived.elapsedHours, 1);
    state.entryCutoffAt = START + 7200000;
    assert.equal(summarizePremarketPaper(state, config, START + 30 * 86400000).elapsedHours, 1);
    assert.equal(summarizePremarketPaper(state, config, START + 1800000).elapsedHours, .5);
});

test('history archive timestamp caps legacy evidence without overriding ledger cutoff or archive', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const state = fixture('legacy'); market(state, 'settled'); fill(state, 'premarket-momentum', 'settled', .95);
    period(current); const oldDir = period(old, 'legacy', config, state);
    const archivedAt = new Date(START + 3600000).toISOString();
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [{ id: 'legacy', dataDir: old, archivedAt }] }));
    t.mock.method(Date, 'now', () => START + 30 * 86400000);
    const legacy = readPremarketPaperReports({ dataDir: current }, true).history[0];
    assert.equal(legacy.archivedAt, START + 3600000);
    assert.equal(legacy.elapsedHours, 1);
    assert.equal(legacy.arms['premarket-momentum'].completedFilled, 1);
    assert.ok(legacy.arms['premarket-momentum'].enrolledMarketEvidence.reasons.includes('insufficient_elapsed_days'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(oldDir, 'ledger.json'))).archivedAt, undefined);
    state.entryCutoffAt = START + 1800000; state.archivedAt = START + 7200000;
    fs.writeFileSync(path.join(oldDir, 'ledger.json'), JSON.stringify(state));
    const explicit = readPremarketPaperReports({ dataDir: current }, true).history[0];
    assert.equal(explicit.archivedAt, state.archivedAt);
    assert.equal(explicit.entryCutoffAt, state.entryCutoffAt);
    assert.equal(explicit.elapsedHours, .5);
});
