import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeFilterPaper, saveFilterPaperReport, readFilterPaperReports } from '../../src/laya-filter-paper/report.js';

const ARMS = ['laya', 'spot-twap', 'price-cap-085', 'combined', 'model-edge'];
const START = Date.UTC(2026, 9, 20), DAY = 86400000;
const config = { id: 'test-period', capital: 20, deadline: Number.MAX_SAFE_INTEGER,
    decisionMs: 5000, shadowDrawdownStop: 2, drawdownStop: 10, bootstrapSamples: 200 };
function fixture() {
    return { id: config.id, startedAt: START, snapshots: [], markets: {}, slots: {}, errors: {},
        arms: Object.fromEntries(ARMS.map(name => [name, { cash: 20, drawdown: 0, shadowStop: null,
            stopped: null, seen: {}, position: null, completed: [], outcomes: {} }])) };
}
function snapshot(state, slug, end, decision = { status: 'ok', action: 'SKIP', latencyMs: 200, cost: 0 }) {
    state.markets[slug] = { end, conditionId: slug, payout: [1, 0] };
    const row = { snapshotId: `snapshot-${state.snapshots.length}`, market: slug, at: end - 60000,
        sharedDecision: { ...decision }, decisions: Object.fromEntries(ARMS.map(name => [name, { ...decision }])) };
    state.snapshots.push(row); return row;
}
function fill(state, name, slug, pnl, extra = {}) {
    const row = { slug, closedAt: state.markets[slug].end + 1000, pnl, fees: .1, gas: .01, shares: 5, ...extra };
    state.arms[name].completed.push(row);
    state.arms[name].seen[slug] = { snapshotId: state.snapshots.find(row => row.market === slug)?.snapshotId };
    state.arms[name].outcomes[slug] = { pnl, reason: 'settled' };
    return row;
}

test('empty paper report stays pure, has null samples and never treats no data as positive evidence', () => {
    const state = fixture(), before = JSON.stringify(state), report = summarizeFilterPaper(state, config, START);
    assert.equal(JSON.stringify(state), before);
    assert.equal(report.commonCohort.markets, 0);
    assert.equal(report.deadline, null);
    assert.equal(report.arms.laya.executionWinRate, null);
    assert.equal(report.arms.laya.tradingMeanCi95, null);
    assert.equal(report.arms.laya.latencyMs.p50, null);
    assert.equal(report.arms.laya.researchEligibility.eligible, false);
    assert.equal(report.arms.laya.netAfterAllAiCost, null);
    assert.equal(report.automaticPromotion, false);
    assert.equal(report.sufficientForLive, false);
});

test('common cohort requires official payout and every arm to conclude; missing evidence is never zero', () => {
    const state = fixture();
    snapshot(state, 'waiting-label', START + 300000); delete state.markets['waiting-label'].payout;
    const incomplete = snapshot(state, 'missing-decision', START + 600000);
    delete incomplete.decisions.combined;
    snapshot(state, 'pending-outcome', START + 900000);
    state.arms['spot-twap'].outcomes['pending-outcome'] = { pnl: 0, reason: 'awaiting_settlement' };
    snapshot(state, 'settled-missing-detail', START + 1200000);
    state.arms['model-edge'].outcomes['settled-missing-detail'] = { pnl: .5, reason: 'settled' };
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.commonCohort.markets, 0);
    assert.equal(report.commonCohort.officialLabelsPending, 1);
    assert.equal(report.commonCohort.unresolvedMarkets, 3);
    assert.equal(report.differences.combined.matchedMarkets, 0);
    assert.equal(report.commonCohort.unknownOutcomesCountedAsZero, false);
});

test('explicit skips, vetoes, timeouts and unavailable arms participate once per market', () => {
    const state = fixture(), end = START + 300000;
    snapshot(state, 'm1', end, { status: 'ok', action: 'BUY_UP', latencyMs: 1000, cost: .02 });
    fill(state, 'laya', 'm1', -.8);
    fill(state, 'spot-twap', 'm1', .6);
    state.arms['price-cap-085'].outcomes.m1 = { pnl: 0, reason: 'filter_veto' };
    state.snapshots[0].decisions['price-cap-085'].entryDisposition = 'filter_veto';
    state.snapshots[0].decisions.combined = { status: 'decision_timeout', action: 'SKIP', latencyMs: 5000 };
    state.snapshots[0].decisions['model-edge'] = { status: 'ok', action: 'BUY_UP', entryDisposition: 'arm_unavailable' };
    snapshot(state, 'm1', end);
    const report = summarizeFilterPaper(state, config, end + 10000);
    assert.equal(report.commonCohort.markets, 1);
    assert.equal(report.arms.laya.cohortTradingPnl, -.8);
    assert.equal(report.arms.combined.cohortNoExposureMarkets, 1);
    assert.equal(report.differences['spot-twap'].tradingDifference, 1.4);
    assert.equal(report.differences['price-cap-085'].tradingDifference, .8);
    assert.equal(report.differences.combined.tradingDifference, .8);
    assert.equal(report.differences['model-edge'].matchedMarkets, 1);
    assert.equal(report.differences.combined.includesSkipAndTimeout, true);
});

test('recorded net PnL includes fees and gas once and exact duplicated completion does not inflate it', () => {
    const state = fixture(); snapshot(state, 'm1', START + 300000);
    const row = fill(state, 'laya', 'm1', .69);
    state.arms.laya.completed.push(structuredClone(row));
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.arms.laya.tradingPnl, .69);
    assert.equal(report.arms.laya.fees, .1);
    assert.equal(report.arms.laya.gas, .01);
    assert.equal(report.arms.laya.completedFilled, 1);
    assert.equal(report.differences.combined.tradingDifference, -.69);
    state.arms.laya.completed[1].pnl = 99;
    assert.equal(summarizeFilterPaper(state, config, START + DAY).commonCohort.markets, 0);
});

test('pending, matched and filled inventory all exclude their market despite a zero outcome', () => {
    for (const status of ['pending', 'matched', 'filled']) {
        const state = fixture(); snapshot(state, 'm1', START + 300000);
        state.arms.combined.position = { status, market: { slug: 'm1' }, holdings: status === 'filled' ? 3 : 0,
            order: { shares: 5 }, fill: { shares: 3 }, entryCost: 2.4, mark: null, markFresh: false };
        state.arms.combined.outcomes.m1 = { pnl: 0, reason: 'filter_veto' };
        const report = summarizeFilterPaper(state, config, START + DAY);
        assert.equal(report.commonCohort.markets, 0, status);
        assert.deepEqual(report.openInventoryArms, ['combined']);
        assert.equal(report.arms.combined.activeInventory.mark, null);
        assert.equal(report.arms.combined.activeInventory.pendingShares, status === 'pending' ? 5 : status === 'matched' ? 3 : 0);
        assert.ok(report.arms.combined.researchEligibility.reasons.includes('unresolved_inventory'));
    }
});

test('high execution win rate can lose money; AI direction quality is independent from actual execution', () => {
    const state = fixture();
    for (let index = 0; index < 10; index++) {
        const slug = `m${index}`;
        snapshot(state, slug, START + (index + 1) * 300000, { status: 'ok', action: 'BUY_UP', latencyMs: 100, cost: 0 });
        fill(state, 'laya', slug, index === 9 ? -4.5 : .1);
    }
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.arms.laya.executionWinRate, .9);
    assert.equal(report.arms.laya.tradingPnl, -3.6);
    assert.equal(report.arms.laya.averageLoss, -4.5);
    assert.equal(report.arms.laya.settledPnlDrawdown, 4.5);
    assert.equal(report.aiDecisionQuality.winRate, 1);
    assert.equal(report.aiDecisionQuality.independentMarkets, 10);
    assert.ok(report.arms.laya.researchEligibility.reasons.includes('nonpositive_trading_pnl'));
});

test('shared inference cost is counted once and timeout waits stay separate from completed latency', () => {
    const state = fixture();
    snapshot(state, 'm1', START + 300000, { status: 'ok', action: 'SKIP', latencyMs: 100, cost: .02 });
    snapshot(state, 'm2', START + 600000, { status: 'decision_timeout', action: 'SKIP', latencyMs: 5000, cost: null });
    snapshot(state, 'm3', START + 900000, { status: 'decision_timeout', action: 'SKIP', latencyMs: 5000, actualLatencyMs: 7000, cost: 0 });
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.sharedInference.requests, 3);
    assert.equal(report.admission.attempted, 3);
    assert.deepEqual(report.admission.skippedReasons, {});
    assert.equal(report.sharedInference.knownApiCost, .02);
    assert.equal(report.sharedInference.unknownApiCostRequests, 1);
    assert.equal(report.sharedInference.localComputeCost, null);
    assert.equal(report.sharedInference.totalAiCost, null);
    assert.equal(report.sharedInference.latencyMs.completedResponses, 2);
    assert.equal(report.sharedInference.latencyMs.timeoutCount, 2);
    assert.equal(report.sharedInference.latencyMs.p50, 100);
    assert.equal(report.sharedInference.latencyMs.p95, 7000);
    assert.equal(report.sharedInference.waitingMs.samples, 3);
    assert.equal(report.commonCohort.markets, 3);
    for (const arm of Object.values(report.arms)) assert.equal(arm.aiCostAllocation, 'experiment_level_only');
});

test('adaptive timeout metrics count shared responses once and distinguish acceptance, reservation and late drain', () => {
    const state = fixture(), adaptiveConfig = { ...config, decisionMs: 3000,
        decisionTimeoutPolicy: 'snapshot-freshness-budget-v1' };
    const add = (slug, status, latencyMs, budget, extra = {}) => {
        const at = START + 240000;
        const row = snapshot(state, slug, START + 300000, { status, action: 'SKIP', latencyMs,
            requestedAt: at, ...(status === 'ok' ? { receivedAt: at + latencyMs } : {}),
            decisionBudgetMs: budget, decisionDeadlineAt: at + budget, ...extra });
        row.inferenceAttempted = true;
        row.decisionDeadlineAt = at + budget;
        row.timing = { decisionBudgetMs: budget, decisionDeadlineAt: row.decisionDeadlineAt };
        return row;
    };
    const accepted = add('accepted-buy', 'ok', 3500, 4600, { action: 'BUY_UP' });
    for (const decision of Object.values(accepted.decisions)) decision.entryDisposition = 'reserved';
    add('accepted-skip', 'ok', 4300, 4300);
    add('late-ok', 'ok', 4501, 4500, { action: 'BUY_UP' });
    add('late-drain', 'decision_timeout', 3100, 3100, { actualLatencyMs: 6000 });
    add('unresolved', 'decision_timeout', 3500, 3500);
    add('exact-reference', 'ok', 3000, 4600);
    const blocked = snapshot(state, 'blocked', START + 300000,
        { status: 'insufficient_input_headroom', action: 'SKIP', decisionBudgetMs: 0 });
    blocked.timing = { decisionBudgetMs: 0 };
    state.snapshots.push(structuredClone(accepted));
    const before = JSON.stringify(state), report = summarizeFilterPaper(state, adaptiveConfig, START + DAY);
    assert.equal(JSON.stringify(state), before);
    assert.equal(report.sharedInference.requests, 6);
    assert.deepEqual(report.sharedInference.adaptiveTimeout, {
        policy: 'snapshot-freshness-budget-v1', referenceMs: 3000, available: true, complete: true, recordedRequests: 6,
        decisionBudgetMs: { available: true, p50: 4300, p95: 4600, samples: 6 },
        completedResponsesOverReference: 4, acceptedOverReference: 2, reservedOverReference: 1,
        timedOutResponsesOverReference: 1, timeoutCount: 2, timeoutsWithoutResponse: 1,
    });
});

test('historical periods keep missing adaptive budgets and acceptance unavailable without hiding known timeouts', () => {
    const state = fixture();
    snapshot(state, 'old-response', START + 300000, { status: 'ok', action: 'BUY_UP', latencyMs: 3500 });
    snapshot(state, 'old-timeout', START + 600000,
        { status: 'decision_timeout', action: 'SKIP', latencyMs: 3000, actualLatencyMs: 5000 });
    const report = summarizeFilterPaper(state, { ...config, decisionMs: 3000 }, START + DAY);
    assert.deepEqual(report.sharedInference.adaptiveTimeout, {
        policy: null, referenceMs: 3000, available: false, complete: false, recordedRequests: 0,
        decisionBudgetMs: { available: false, p50: null, p95: null, samples: 0 },
        completedResponsesOverReference: 2, acceptedOverReference: null, reservedOverReference: null,
        timedOutResponsesOverReference: 1, timeoutCount: 1, timeoutsWithoutResponse: 0,
    });
    assert.equal(report.aiDecisionQuality.independentMarkets, 0);
});

test('invalid decision budgets remain final no-exposure outcomes in the official common cohort', () => {
    const state = fixture();
    snapshot(state, 'invalid-budget', START + 300000, { status: 'ok', action: 'BUY_UP',
        entryDisposition: 'invalid_decision_budget', latencyMs: 3500, cost: 0 });
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.commonCohort.markets, 1);
    assert.equal(report.commonCohort.unresolvedMarkets, 0);
    for (const arm of Object.values(report.arms)) {
        assert.equal(arm.cohortNoExposureMarkets, 1);
        assert.equal(arm.cohortTradingPnl, 0);
        assert.equal(arm.completedFilled, 0);
    }
});

test('a budget exhausted after local admission is counted as an attempt without claiming an HTTP submission', () => {
    const state = fixture();
    const row = snapshot(state, 'expired-locally', START + 300000, { status: 'decision_budget_expired',
        action: 'SKIP', entryDisposition: 'no_buy_decision', inferenceAttempted: true,
        requestSubmitted: false, reason: 'expired_before_dispatch', latencyMs: 4601, cost: 0 });
    row.inferenceAttempted = true;
    row.timing = { decisionBudgetMs: 4600, decisionDeadlineAt: row.at + 4600 };
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.sharedInference.requests, 1);
    assert.equal(report.sharedInference.requestsBasis, 'admitted_inference_attempts');
    assert.equal(report.sharedInference.knownNotSubmittedRequests, 1);
    assert.equal(report.sharedInference.latencyMs.completedResponses, 0);
    assert.equal(report.sharedInference.latencyMs.timeoutCount, 0);
    assert.equal(report.sharedInference.adaptiveTimeout.acceptedOverReference, 0);
    assert.equal(report.commonCohort.markets, 1);
});

test('adaptive AI quality accepts timely responses above three seconds and uses the recorded snapshot deadline', () => {
    const state = fixture(), adaptiveConfig = { ...config, decisionMs: 3000,
        decisionTimeoutPolicy: 'snapshot-freshness-budget-v1' };
    const at = START + 240000;
    const late = snapshot(state, 'm1', START + 300000, { status: 'ok', action: 'BUY_DOWN', latencyMs: 4501,
        requestedAt: at, receivedAt: at + 4501, decisionDeadlineAt: at + 5000 });
    late.decisionDeadlineAt = at + 4500;
    snapshot(state, 'm1', START + 300000, { status: 'ok', action: 'BUY_UP', latencyMs: 3500,
        requestedAt: at, receivedAt: at + 3500, decisionDeadlineAt: at + 4000 });
    const boundary = snapshot(state, 'm2', START + 300000, { status: 'ok', action: 'BUY_UP', latencyMs: 3600,
        requestedAt: at, receivedAt: at + 3600 });
    boundary.timing = { decisionDeadlineAt: at + 3600 };
    snapshot(state, 'missing-deadline', START + 300000, { status: 'ok', action: 'BUY_UP', latencyMs: 1000,
        requestedAt: at, receivedAt: at + 1000 });
    const report = summarizeFilterPaper(state, adaptiveConfig, START + DAY);
    assert.equal(report.aiDecisionQuality.independentMarkets, 2);
    assert.equal(report.aiDecisionQuality.wins, 2);
    for (const arm of Object.values(report.arms)) assert.equal(arm.signalQuality.independentMarkets, 2);
    assert.equal(report.sharedInference.adaptiveTimeout.complete, false);
});

test('admitted invalid and rejected HTTP responses count once while local validation failures do not', () => {
    const state = fixture();
    const completed = [
        { status: 'invalid', reason: 'probabilities_invalid', latencyMs: 1200, cost: .02 },
        { status: 'rejected', reason: 'disallowed_action', latencyMs: 1800, cost: .03 },
        { status: 'provider_error', httpStatus: 503, latencyMs: 2000, cost: null },
    ];
    for (const [index, decision] of completed.entries()) {
        const row = snapshot(state, `response-${index}`, START + 300000,
            { ...decision, action: 'SKIP', entryDisposition: 'no_buy_decision' });
        row.inferenceAttempted = true;
        row.inferenceStartedAt = row.at;
    }
    snapshot(state, 'local-invalid', START + 300000,
        { status: 'invalid', reason: 'snapshot_input_invalid', latencyMs: 0, cost: 0 });
    const pending = snapshot(state, 'pending', START + 300000);
    pending.inferenceAttempted = true;
    delete pending.sharedDecision; pending.decisions = {};
    const before = JSON.stringify(state), report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(JSON.stringify(state), before);
    assert.equal(report.sharedInference.requests, 4);
    assert.equal(report.sharedInference.knownApiCost, .05);
    assert.equal(report.sharedInference.unknownApiCostRequests, 2);
    assert.equal(report.sharedInference.status.invalid, 2);
    assert.equal(report.sharedInference.status.pending, 1);
    assert.equal(report.sharedInference.latencyMs.completedResponses, 3);
    assert.equal(report.sharedInference.latencyMs.p50, 1800);
    assert.equal(report.sharedInference.latencyMs.p95, 2000);
    assert.equal(report.sharedInference.latencyMs.timeoutCount, 0);
    assert.equal(report.arms.laya.latencyMs.completedResponses, 3);
});

test('an earlier veto stays unresolved while a later snapshot can still create exposure', () => {
    const state = fixture(), end = START + 300000;
    const first = snapshot(state, 'retry-market', end);
    first.decisions.combined = { status: 'ok', action: 'BUY_UP', entryDisposition: 'filter_veto' };
    state.arms.combined.outcomes['retry-market'] = { pnl: 0, reason: 'filter_veto' };
    const second = snapshot(state, 'retry-market', end);
    delete second.decisions.combined;
    assert.equal(summarizeFilterPaper(state, config, START + DAY).commonCohort.markets, 0);
    second.decisions.combined = { status: 'ok', action: 'SKIP', entryDisposition: 'no_buy_decision' };
    assert.equal(summarizeFilterPaper(state, config, START + DAY).commonCohort.markets, 1);
    second.decisions.combined = { status: 'ok', action: 'BUY_UP', entryDisposition: 'reserved' };
    assert.equal(summarizeFilterPaper(state, config, START + DAY).commonCohort.markets, 0);
});

test('decision quality takes first timely BUY once per official market, ignoring late and unlabeled responses', () => {
    const state = fixture(), end = START + 300000;
    snapshot(state, 'm1', end, { status: 'ok', action: 'BUY_DOWN', latencyMs: 6000 });
    snapshot(state, 'm1', end, { status: 'ok', action: 'BUY_UP', latencyMs: 3000 });
    snapshot(state, 'm1', end, { status: 'ok', action: 'BUY_DOWN', latencyMs: 1000 });
    snapshot(state, 'unlabeled', end, { status: 'ok', action: 'BUY_UP', latencyMs: 1000 });
    delete state.markets.unlabeled.payout;
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.aiDecisionQuality.independentMarkets, 1);
    assert.equal(report.aiDecisionQuality.wins, 1);
});

test('CI waits for seven observed WIB days and 100 cohort markets; elapsed time and filled thresholds are independent', () => {
    const state = fixture();
    for (let index = 0; index < 100; index++) {
        const slug = `m${index}`;
        snapshot(state, slug, START + (index % 7) * DAY + (index + 1) * 300000);
        for (const name of ARMS) fill(state, name, slug, name === 'laya' ? .2 : .3);
    }
    const report = summarizeFilterPaper(state, config, START + 8 * DAY);
    assert.equal(report.commonCohort.observedDays, 7);
    assert.equal(report.arms.laya.uncertainty.sufficient, true);
    assert.ok(report.arms.laya.tradingMeanCi95.lower > 0);
    assert.ok(report.differences.combined.tradingMeanDifferenceCi95.lower > 0);
    assert.equal(report.arms.laya.researchEligibility.eligible, true);
    assert.equal(report.arms.laya.researchEligibility.scope, 'paper_research_only');
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.automaticPromotion, false);
    state.startedAt = START + 2 * DAY;
    const shortElapsed = summarizeFilterPaper(state, config, START + 8 * DAY);
    assert.equal(shortElapsed.arms.laya.researchEligibility.eligible, false);
    assert.equal(shortElapsed.arms.laya.tradingMeanCi95, null);
    assert.ok(shortElapsed.arms.laya.researchEligibility.reasons.includes('insufficient_elapsed_days'));
    state.startedAt = START;
    state.arms.combined.completed.pop();
    delete state.arms.combined.outcomes.m99;
    delete state.arms.combined.seen.m99;
    assert.equal(summarizeFilterPaper(state, config, START + 8 * DAY).arms.combined.researchEligibility.eligible, false);
    for (const market of Object.values(state.markets)) market.end = START + 300000;
    const singleDay = summarizeFilterPaper(state, config, START + 8 * DAY);
    assert.equal(singleDay.arms.laya.tradingMeanCi95, null);
    assert.equal(singleDay.differences.combined.tradingMeanDifferenceCi95, null);
});

test('WIB date boundary controls daily clusters and small cohorts have no interval', () => {
    const state = fixture(), midnightWib = Date.UTC(2026, 9, 20, 17);
    snapshot(state, 'before', midnightWib - 1);
    snapshot(state, 'after', midnightWib);
    const report = summarizeFilterPaper(state, config, START + 8 * DAY);
    assert.equal(report.commonCohort.observedDays, 2);
    assert.equal(report.arms.laya.uncertainty.sufficient, false);
    assert.equal(report.arms.laya.tradingMeanCi95, null);
});

test('persistent stops and intratrade drawdown remain separate from settled drawdown', () => {
    const state = fixture(); snapshot(state, 'm1', START + 300000); fill(state, 'laya', 'm1', 1);
    state.arms.laya.drawdown = 10.2;
    state.arms.laya.shadowStop = { at: START + 1000, drawdown: 2.1 };
    state.arms.laya.stopped = { at: START + 2000, reason: 'research_drawdown_limit' };
    const report = summarizeFilterPaper(state, config, START + 8 * DAY);
    assert.equal(report.arms.laya.settledPnlDrawdown, 0);
    assert.equal(report.arms.laya.intratradePaperDrawdown, 10.2);
    assert.deepEqual(report.arms.laya.risk.pilotBreach, state.arms.laya.shadowStop);
    assert.deepEqual(report.arms.laya.risk.researchStop, state.arms.laya.stopped);
    assert.equal(report.arms.laya.risk.pilotDrawdownLimit, 2);
    assert.equal(report.arms.laya.risk.researchDrawdownLimit, 10);
});

test('execution outcomes expose no-fill, partial fill and failure counts without inventing filled trades', () => {
    const state = fixture();
    for (const slug of ['partial', 'no-fill', 'failed']) snapshot(state, slug, START + 300000);
    fill(state, 'laya', 'partial', .25, { shares: 2, partial: true, executionLatencyMs: 350 });
    state.arms.laya.outcomes['no-fill'] = { pnl: 0, reason: 'no_fill' };
    state.arms.laya.outcomes.failed = { pnl: 0, reason: 'execution_expired', code: 'execution_book_stale' };
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.commonCohort.markets, 3);
    assert.equal(report.arms.laya.completedFilled, 1);
    assert.equal(report.arms.laya.partialFills, 1);
    assert.equal(report.arms.laya.noFill, 1);
    assert.equal(report.arms.laya.executionFailures, 1);
    assert.equal(report.arms.laya.executionFailureReasons.execution_book_stale, 1);
    assert.equal(report.arms.laya.executionLatencyMs.p95, 350);
});

test('report writes private latest JSON and Indonesian Markdown without modifying its ledger', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-paper-report-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = fixture(), before = JSON.stringify(state);
    const report = saveFilterPaperReport({ ...config, dataDir: dir }, state, START);
    fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id: config.id, paperOnly: true }));
    fs.writeFileSync(path.join(dir, config.id, 'manifest.json'), JSON.stringify({ id: config.id, paperOnly: true, policy: config }));
    const reportDir = path.join(dir, config.id, 'reports');
    assert.equal(fs.statSync(reportDir).mode & 0o077, 0);
    for (const filename of ['latest.json', 'latest.md']) assert.equal(fs.statSync(path.join(reportDir, filename)).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reportDir, 'latest.json'))), report);
    assert.deepEqual(readFilterPaperReports({ ...config, dataDir: dir }), report);
    assert.deepEqual(readFilterPaperReports({ ...config, dataDir: dir }, true).history, []);
    const markdown = fs.readFileSync(path.join(reportDir, 'latest.md'), 'utf8');
    assert.match(markdown, /khusus riset paper/);
    assert.match(markdown, /Budget keputusan p50\/p95: belum tersedia untuk periode ini/);
    assert.equal(JSON.stringify(state), before);
    assert.throws(() => saveFilterPaperReport({ ...config, id: '../escape', dataDir: dir }, state, START), /identity_mismatch/);
});

test('slot coverage includes unobserved opportunities once while historical reason counters stay unavailable', () => {
    const state = fixture();
    snapshot(state, 'observed', START + 300000);
    state.slots = { 'observed:90': { status: 'observed' }, 'skipped:90': { status: 'no_valid_side' },
        'invalid:90': { status: 'invalid' }, 'reserved:90': { status: 'reserved' } };
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.slotCoverage.scheduled, 4);
    assert.equal(report.slotCoverage.observed, 1);
    assert.equal(report.slotCoverage.no_valid_side, 1);
    assert.equal(report.slotCoverage.invalid, 1);
    assert.equal(report.slotCoverage.observationRate, .25);
    assert.equal(report.opportunitySkips.total, 1);
    assert.equal(report.opportunitySkips.byReason, null);
    assert.equal(report.opportunitySkips.bySide, null);
    assert.equal(report.opportunitySkips.reasonsAvailable, false);
    assert.equal(report.executionQuality.available, false);
    assert.equal(report.executionQuality.comparableBatches, null);
    state.opportunitySkips = { schema: 1, complete: true, total: 1,
        byReason: { book_stale: 1 }, bySide: { UP: { book_stale: 1 }, DOWN: { book_stale: 1 } } };
    const current = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(current.opportunitySkips.total, 1);
    assert.equal(current.opportunitySkips.byReason.book_stale, 1);
    assert.equal(current.opportunitySkips.reasonsComplete, true);
    delete state.slots; delete state.opportunitySkips;
    const unknown = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(unknown.slotCoverage.scheduled, null);
    assert.equal(unknown.opportunitySkips.total, null);
});

test('report records admission headroom, exact execution failures and checks cross-arm source markers', () => {
    const state = fixture(), row = snapshot(state, 'm1', START + 300000,
        { status: 'insufficient_input_headroom', action: 'SKIP', latencyMs: 0, cost: 0 });
    row.timing = { maxInputAgeMs: 1900, inputHeadroomMs: 3100, inferenceInputAgeMs: 2100,
        inferenceHeadroomMs: 2900, decisionInputAgeMs: 4800 };
    row.executionBatches = [{ cohortId: 'cohort-1', executionAt: START + 240250, bookHash: 'same-book',
        bookSource: 'websocket', armNames: ['laya', 'combined'], inputAgeMs: 4200, headroomMs: 800 }];
    state.arms.laya.outcomes.m1 = { pnl: 0, reason: 'execution_expired', code: 'execution_spread_too_wide',
        executionCohortId: 'cohort-1', executionBookHash: 'same-book', executionAt: START + 240250 };
    state.arms.combined.outcomes.m1 = { pnl: 0, reason: 'no_fill',
        executionCohortId: 'cohort-1', executionBookHash: 'same-book', executionAt: START + 240250 };
    const report = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(report.sharedInference.requests, 0);
    assert.equal(report.admission.skippedReasons.insufficient_input_headroom, 1);
    assert.equal(report.pipelineTimingMs.inferenceHeadroomMs.p95, 2900);
    assert.equal(report.arms.laya.executionFailureReasons.execution_spread_too_wide, 1);
    assert.equal(report.executionQuality.sameBatchSourceRecorded, 1);
    assert.equal(report.executionQuality.verifiedArmSources, 1);
    assert.equal(report.executionQuality.inputAgeMs.p95, 4200);
    state.arms.combined.outcomes.m1.executionBookHash = 'different-book';
    const mismatch = summarizeFilterPaper(state, config, START + DAY);
    assert.equal(mismatch.executionQuality.verifiedArmSources, 0);
    assert.deepEqual(mismatch.executionQuality.mismatchedArmSources, ['cohort-1']);
    delete state.arms.combined.outcomes.m1.executionBookHash;
    assert.deepEqual(summarizeFilterPaper(state, config, START + DAY).executionQuality.unverifiableArmSources, ['cohort-1']);
    state.arms.combined.outcomes.m1.executionBookHash = 'same-book';
    state.arms.combined.outcomes.m1.executionAt++;
    assert.deepEqual(summarizeFilterPaper(state, config, START + DAY).executionQuality.mismatchedArmSources, ['cohort-1']);
    delete state.arms.combined.outcomes.m1.executionAt;
    assert.deepEqual(summarizeFilterPaper(state, config, START + DAY).executionQuality.unverifiableArmSources, ['cohort-1']);
});

test('fresh report and explicitly linked history use saved manifests regardless of current configuration', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-paper-history-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const currentDir = path.join(dir, 'current'), oldDir = path.join(dir, 'old');
    const writePeriod = (dataDir, id, cash) => {
        const periodDir = path.join(dataDir, id);
        fs.mkdirSync(periodDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id, paperOnly: true }));
        fs.writeFileSync(path.join(periodDir, 'manifest.json'), JSON.stringify({ id, paperOnly: true,
            policy: { ...config, capital: 31, shadowDrawdownStop: 3 } }));
        const state = { ...fixture(), id };
        state.arms.laya.cash = cash;
        fs.writeFileSync(path.join(periodDir, 'ledger.json'), JSON.stringify(state));
        saveFilterPaperReport({ ...config, id, dataDir }, state, START);
        return periodDir;
    };
    const current = writePeriod(currentDir, 'current', 18), old = writePeriod(oldDir, 'archived', 17);
    writePeriod(currentDir, 'unlinked', 1000);
    fs.writeFileSync(path.join(currentDir, 'active.json'), JSON.stringify({ id: 'current', paperOnly: true }));
    const archivedAt = '2026-10-20T02:00:00.000Z';
    const link = { id: 'archived', dataDir: oldDir, archivedAt };
    fs.writeFileSync(path.join(currentDir, 'history.json'), JSON.stringify({ periods: [link, link] }));
    const ledger = JSON.parse(fs.readFileSync(path.join(current, 'ledger.json'), 'utf8'));
    ledger.arms.laya.cash = 12;
    fs.writeFileSync(path.join(current, 'ledger.json'), JSON.stringify(ledger));
    const watched = [path.join(current, 'ledger.json'), path.join(old, 'ledger.json'), path.join(old, 'reports/latest.json')];
    const before = watched.map(file => fs.readFileSync(file, 'utf8'));
    const report = readFilterPaperReports({ dataDir: currentDir, id: 'changed-source-hash', capital: 999 }, true);
    assert.equal(report.id, 'current');
    assert.equal(report.arms.laya.cash, 12);
    assert.equal(report.arms.laya.capital, 31);
    assert.equal(report.arms.laya.risk.pilotDrawdownLimit, 3);
    assert.equal(report.history.length, 1);
    assert.equal(report.history[0].id, 'archived');
    assert.equal(report.history[0].arms.laya.cash, 17);
    assert.equal(report.history[0].archivedAt, archivedAt);
    assert.deepEqual(watched.map(file => fs.readFileSync(file, 'utf8')), before);
    for (const badLink of [{ ...link, id: '../escape' }, { ...link, dataDir: 'relative' }, { ...link, archivedAt: 'invalid' }]) {
        fs.writeFileSync(path.join(currentDir, 'history.json'), JSON.stringify({ periods: [badLink] }));
        assert.throws(() => readFilterPaperReports({ dataDir: currentDir }, true), /identity_mismatch/);
    }
    fs.writeFileSync(path.join(currentDir, 'history.json'), JSON.stringify({ periods: [link] }));
    fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ id: 'wrong-id', paperOnly: true, policy: config }));
    assert.throws(() => readFilterPaperReports({ dataDir: currentDir }, true), /identity_mismatch/);
    fs.writeFileSync(path.join(currentDir, 'active.json'), JSON.stringify({ id: '../escape', paperOnly: true }));
    assert.throws(() => readFilterPaperReports({ dataDir: currentDir }), /identity_mismatch/);
});

test('active ledger identity is checked even when a cached report exists', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-paper-identity-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = fixture();
    saveFilterPaperReport({ ...config, dataDir: dir }, state, START);
    fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ id: config.id, paperOnly: true }));
    fs.writeFileSync(path.join(dir, config.id, 'manifest.json'), JSON.stringify({ id: config.id, paperOnly: true, policy: config }));
    fs.writeFileSync(path.join(dir, config.id, 'ledger.json'), JSON.stringify({ ...state, id: 'wrong' }));
    assert.throws(() => readFilterPaperReports({ dataDir: dir }), /identity_mismatch/);
});
