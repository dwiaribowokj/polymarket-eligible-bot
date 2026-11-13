import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { summarizeEntryFilterPaper, saveEntryFilterPaperReport, readEntryFilterPaperReports }
    from '../../src/entry-filter-paper/report.js';
import { readEntryFilterRestBooks } from '../../src/entry-filter-paper/book-source.js';
import { loadEntryFilterPaperConfig, LIVE_COST_CAP_PROFILE } from '../../src/entry-filter-paper/config.js';
import { EntryFilterPaperStore } from '../../src/entry-filter-paper/store.js';

const ARMS = ['eligible', 'cost-cap', 'buffer', 'combined'];
const START = Date.UTC(2026, 9, 26), DAY = 86400000;
const config = { id: 'entry-period', experiment: 'entry-filter-paper-v1', armNames: ARMS,
    baselineArm: 'eligible', inferencePolicy: 'none', capital: 20, costCapPerShare: .85,
    entryFilter: { version: 'direction-volatility-buffer-v1', minBufferSigma: 1, useClosingThreshold: true },
    executionPolicy: 'shared-admission-and-immutable-execution-cohort-v2', bootstrapSamples: 100 };
const emptyArm = () => ({ cash: 20, peak: 20, drawdown: 0, seen: {}, position: null, completed: [], outcomes: {} });
const fixture = (id = config.id, arms = ARMS) => ({ id, startedAt: START, snapshots: [], slots: {}, markets: {}, providers: {},
    arms: Object.fromEntries(arms.map(name => [name, emptyArm()])) });
function snapshot(state, slug, payout = [1, 0]) {
    const end = START + (state.snapshots.length + 1) * 300000;
    const decision = { status: 'ok', action: 'SKIP', entryDisposition: 'no_buy_decision',
        inferenceAttempted: false, requestSubmitted: false, model: 'deterministic', cost: 0, latencyMs: 0 };
    const row = { snapshotId: `s-${slug}`, market: slug, at: end - 30000, executionBatches: [],
        sharedDecision: { ...decision }, decisions: Object.fromEntries(Object.keys(state.arms).map(name => [name, { ...decision }])) };
    state.markets[slug] = { end, payout }; state.snapshots.push(row);
    state.slots[slug] = { status: 'observed' };
    return row;
}
function fill(state, name, slug, pnl, extra = {}) {
    const row = { slug, snapshotId: `s-${slug}`, closedAt: state.markets[slug].end,
        marketEnd: state.markets[slug].end, pnl, shares: 5, fees: .05, gas: .05, entryCost: 4, ...extra };
    state.arms[name].completed.push(row);
    state.arms[name].outcomes[slug] = { reason: 'settled', pnl };
    state.arms[name].seen[slug] = true;
    return row;
}
function veto(state, name, slug, reason = 'filter_veto') {
    state.arms[name].outcomes[slug] = { pnl: 0, reason };
    const row = state.snapshots.find(row => row.market === slug);
    row.decisions[name].entryDisposition = reason === 'filter_veto' ? reason : 'no_buy_decision';
}
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-filter-report-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}
function period(directory, id = config.id, policy = config, state = fixture(id)) {
    const dir = path.join(directory, id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ id, paperOnly: true }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, paperOnly: true, policy }));
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(state));
    return dir;
}

test('deterministic shared decisions are not counted as inference and summaries remain pure', () => {
    const state = fixture(); snapshot(state, 'skip');
    const before = JSON.stringify(state), report = summarizeEntryFilterPaper(state, config, START + DAY);
    assert.equal(JSON.stringify(state), before);
    assert.deepEqual(Object.keys(report.arms), ARMS);
    assert.equal(report.baselineArm, 'eligible');
    assert.equal(report.inference.requests, 0);
    assert.equal(report.inference.providerCalls, 0);
    assert.equal(report.inference.totalAiCost, 0);
    assert.equal(report.inference.localComputeCost, null);
    assert.equal(report.sharedInference, undefined);
    assert.equal(report.aiDecisionQuality, undefined);
    assert.equal(report.admission, undefined);
    assert.equal(report.totalPnl, undefined);
    assert.equal(report.hypothesis.modelIndependent, true);
    assert.equal(report.hypothesis.preregistered, true);
    assert.equal(report.hypothesis.validatedProfitability, false);
    assert.equal(report.automaticPromotion, false);
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.arms.eligible.aiCostAllocation, 'no_inference');
    assert.equal(report.arms.eligible.netAfterAllAiCost, 0);
    assert.equal(report.arms.eligible.latencyMs, undefined);
    assert.equal(report.commonCohort.includesSkipAndNoFill, true);
    assert.equal(report.commonCohort.includesSkipAndTimeout, undefined);
    assert.equal(report.differences['cost-cap'].baseline, 'eligible');
});

test('contradictory inference evidence is rejected instead of reporting a false zero', () => {
    for (const mutate of [
        state => { state.snapshots[0].sharedDecision.inferenceAttempted = true; },
        state => { state.snapshots[0].inferenceAttempts = { laya: true }; },
        state => { state.snapshots[0].decisions.eligible.requestSubmitted = true; },
        state => { state.providers.laya = { pending: { at: START } }; },
    ]) {
        const state = fixture(); snapshot(state, 'm'); mutate(state);
        assert.throws(() => summarizeEntryFilterPaper(state, config), /inference_evidence_invalid/);
    }
});

test('gross and net payoff economics include observed fees, gas and full realized entry cost', () => {
    const state = fixture(); snapshot(state, 'win'); snapshot(state, 'loss', [0, 1]);
    fill(state, 'eligible', 'win', .95); fill(state, 'eligible', 'loss', -4.05);
    const arm = summarizeEntryFilterPaper(state, config, START + DAY).arms.eligible;
    assert.equal(arm.tradingPnl, -3.1);
    assert.equal(arm.economics.grossTradingPnl, -2.9);
    assert.equal(arm.economics.averageNetWin, .95);
    assert.equal(arm.economics.averageNetLoss, -4.05);
    assert.equal(arm.economics.realizedPayoffBreakEvenWinRate, .81);
    assert.equal(arm.economics.observedEntryCosts.meanAllInCostPerShare, .81);
    assert.equal(arm.economics.observedEntryCosts.shareWeightedAllInCostPerShare, .81);
    assert.equal(arm.economics.observedEntryCosts.complete, true);
    assert.equal(arm.economics.calibratedWinProbability, null);
    assert.equal(arm.economics.expectedProfitValidated, false);
});

test('partial fills expose actual gas per share and do not pretend the admission cap guaranteed it', () => {
    const state = fixture(); snapshot(state, 'partial');
    fill(state, 'cost-cap', 'partial', .11, { entryCost: .84, gas: .05, shares: 1, partial: true });
    const report = summarizeEntryFilterPaper(state, config, START + DAY), arm = report.arms['cost-cap'];
    assert.equal(report.hypothesis.costCapPerShare, .85);
    assert.equal(arm.economics.observedEntryCosts.meanAllInCostPerShare, .89);
    assert.equal(arm.partialFills, 1);
    assert.equal(arm.economics.realizedPayoffBreakEvenWinRate, null);
    assert.match(arm.economics.observedEntryCosts.partialFillCaveat, /partial_fill/);
    delete state.arms['cost-cap'].completed[0].entryCost;
    const missing = summarizeEntryFilterPaper(state, config, START + DAY).arms['cost-cap'].economics.observedEntryCosts;
    assert.equal(missing.complete, false);
    assert.equal(missing.missingFills, 1);
    assert.equal(missing.meanAllInCostPerShare, null);
});

test('paired deltas and omitted baseline outcomes include final skips and no-fills on official cohort only', () => {
    const state = fixture();
    for (const slug of ['loss', 'win', 'both', 'candidate-only']) snapshot(state, slug);
    fill(state, 'eligible', 'loss', -4.05); veto(state, 'cost-cap', 'loss');
    fill(state, 'eligible', 'win', .95); veto(state, 'cost-cap', 'win', 'no_fill');
    fill(state, 'eligible', 'both', .95); fill(state, 'cost-cap', 'both', 1.2);
    fill(state, 'cost-cap', 'candidate-only', .5);
    snapshot(state, 'unlabeled', null); fill(state, 'eligible', 'unlabeled', -4);
    snapshot(state, 'open'); fill(state, 'eligible', 'open', -4);
    state.arms.buffer.position = { market: { slug: 'open' }, status: 'filled', holdings: 5 };
    const report = summarizeEntryFilterPaper(state, config, START + DAY), difference = report.differences['cost-cap'];
    assert.equal(report.commonCohort.markets, 4);
    assert.equal(report.officialLabelsPending, 1);
    assert.equal(report.commonCohort.unresolvedMarkets, 1);
    assert.equal(report.commonCohort.unknownOutcomesCountedAsZero, false);
    assert.equal(difference.tradingDifference, 3.85);
    assert.equal(difference.outcomeTradeoff.lossesAvoided, 1);
    assert.equal(difference.outcomeTradeoff.winsMissed, 1);
    assert.equal(difference.outcomeTradeoff.lossAmountAvoided, 4.05);
    assert.equal(difference.outcomeTradeoff.winAmountMissed, .95);
    assert.equal(difference.outcomeTradeoff.filterVetoLossesAvoided, 1);
    assert.equal(difference.outcomeTradeoff.filterVetoWinsMissed, 0);
    assert.equal(difference.outcomeTradeoff.bothFilledMarkets, 1);
    assert.equal(difference.outcomeTradeoff.candidateOnlyFilledMarkets, 1);
    assert.equal(difference.outcomeTradeoff.hypotheticalFillsIncluded, false);
});

test('coverage, shared execution book mismatches and persistent risk evidence remain visible', () => {
    const state = fixture(), row = snapshot(state, 'same-book');
    state.slots.invalid = { status: 'invalid', reason: 'stale_book' };
    row.executionBatches.push({ cohortId: 'cohort', armNames: ['eligible', 'cost-cap'],
        bookHash: 'book', bookSource: 'websocket', executionAt: START + 1 });
    for (const name of ['eligible', 'cost-cap']) fill(state, name, 'same-book', .95, {
        executionCohortId: 'cohort', executionBookHash: 'book', executionAt: START + 1 });
    state.arms.eligible.stopped = { reason: 'research_drawdown_limit', evidence: { equity: 9 } };
    const report = summarizeEntryFilterPaper(state, config, START + DAY);
    assert.equal(report.slotCoverage.scheduled, 2);
    assert.equal(report.slotCoverage.invalidReasons.stale_book, 1);
    assert.equal(report.executionQuality.sameAdmissionAndExecutionBookRequired, true);
    assert.equal(report.executionQuality.verifiedArmSources, 1);
    assert.equal(report.arms.eligible.riskEvidence.research.equity, 9);
    state.arms['cost-cap'].completed[0].executionBookHash = 'changed-book';
    assert.deepEqual(summarizeEntryFilterPaper(state, config, START + DAY).executionQuality.mismatchedArmSources, ['cohort']);
});

test('operational counts distinguish snapshot samples, markets, filter rejections and pipeline failures', () => {
    const state = fixture(), first = snapshot(state, 'repeated');
    first.bookSource = 'rest'; first.timing = { waitMs: 300 };
    first.informed = { calculated: { closingTwap: { status: 'history_missing' } } };
    Object.assign(first.decisions.combined, { entryDisposition: 'filter_veto',
        filterReason: 'entry_filter_closing_context_unavailable' });
    Object.assign(first.decisions['cost-cap'], { entryDisposition: 'filter_veto', filterReason: 'entry_cost_above_cap' });
    const second = structuredClone(first);
    second.snapshotId = 'later-snapshot'; second.at += 5000;
    second.bookSource = 'websocket'; second.timing.waitMs = 100;
    second.informed.calculated.closingTwap.status = 'observed';
    second.decisions.combined.filterReason = 'entry_filter_insufficient_buffer';
    state.snapshots.push(second, structuredClone(first));
    const failed = snapshot(state, 'pipeline');
    Object.assign(failed.decisions.combined, { status: 'insufficient_input_headroom', entryDisposition: 'no_buy_decision' });
    Object.assign(failed.decisions.buffer, { entryDisposition: 'filter_veto' });
    state.slots.invalid = { status: 'invalid', reason: 'history_not_ready' };
    state.slots.rejected = { status: 'no_valid_side' };
    state.opportunitySkips = { schema: 1, complete: true, total: 1, byReason: { price_below_minimum: 1 }, bySide: {} };
    state.errors = { 'snapshot:history_not_ready': 1 };
    state.bookRecovery = { restAttempts: 3, restSuccesses: 2, restFailures: 1,
        lastStage: 'execution', lastFailure: 'execution_book_stale_or_future', lastRestVerifiedAt: START + 1000 };
    state.arms.combined.outcomes.expired = { reason: 'execution_expired', code: 'execution_stale', pnl: 0 };
    state.arms.combined.outcomes.unfilled = { reason: 'no_fill', pnl: 0 };
    const report = summarizeEntryFilterPaper(state, config, START + DAY), operational = report.operationalSummary;
    assert.deepEqual(operational.samples, { recordedRows: 4, uniqueSnapshots: 3, duplicateRows: 1,
        uniqueObservedMarkets: 2, basis: 'snapshot_id_or_identical_row_when_id_missing' });
    assert.deepEqual(operational.slots.pipelineInvalid, { slots: 1, byReason: { history_not_ready: 1 } });
    assert.equal(operational.slots.eligibilityRejected.slots, 1);
    assert.deepEqual(operational.slots.eligibilityRejected.byReason, { price_below_minimum: 1 });
    assert.deepEqual(operational.contextReadiness.closingByStatus, { history_missing: 1, observed: 1, unrecorded: 1 });
    assert.deepEqual(operational.observationSources, { rest: 1, websocket: 1, unrecorded: 1 });
    assert.deepEqual(operational.waitsMs.observation, { samples: 2, positiveSamples: 2, p50: 100, p95: 300, maximum: 300 });
    assert.equal(operational.arms.combined.decisions.strategyFilterRejections.samples, 1);
    assert.equal(operational.arms.combined.decisions.dataOrIntegrityFilterVetoes.samples, 1);
    assert.deepEqual(operational.arms.combined.decisions.pipelineFailures.byReason, { insufficient_input_headroom: 1 });
    assert.equal(operational.arms['cost-cap'].decisions.strategyFilterRejections.samples, 2);
    assert.equal(operational.arms['cost-cap'].decisions.strategyFilterRejections.uniqueMarkets, 1);
    assert.equal(operational.arms.buffer.decisions.unclassifiedFilterVetoes.samples, 1);
    assert.equal(operational.arms.buffer.decisions.dataOrIntegrityFilterVetoes.samples, 0);
    assert.equal(operational.arms.combined.execution.failedMarkets, 1);
    assert.equal(operational.arms.combined.execution.noFillMarkets, 1);
    assert.deepEqual(operational.arms.combined.execution.failureReasons, { execution_stale: 1 });
    assert.deepEqual(operational.errorsByStageAndReason, state.errors);
    assert.deepEqual(operational.bookRecovery, state.bookRecovery);
    assert.equal(operational.bookStream, null);
});

test('REST cohorts verify persisted source proof and matching arm execution markers without assuming websocket', async () => {
    const state = fixture(), row = snapshot(state, 'rest'), executionAt = START + 1000;
    const market = { slug: 'rest', conditionId: 'condition', open: START, end: START + 300000,
        tokens: ['up', 'down'], minimum: 5, ticks: [.01, .01], tick: .01, negRisk: false, accepting: true,
        fee: { rate: .07, exponent: 1, takerOnly: true } };
    const pair = await readEntryFilterRestBooks(market, { clock: () => executionAt,
        client: { async books() { return []; } }, fetchImpl: async url => {
            const body = url.pathname === '/book' ? { market: market.conditionId,
                asset_id: url.searchParams.get('token_id'), min_order_size: '5', tick_size: '.01', neg_risk: false,
                timestamp: String(executionAt - 100), hash: 'a'.repeat(40),
                bids: [{ price: '.79', size: '5' }], asks: [{ price: '.80', size: '5' }] }
                : { minimum_tick_size: '.01' };
            return new Response(JSON.stringify(body), { headers: { Date: new Date(executionAt).toUTCString(),
                'CF-Cache-Status': 'DYNAMIC' } });
        } });
    row.validation = pair.validation; row.bookSource = 'rest';
    const batch = { cohortId: 'rest-cohort', bookSource: 'rest', bookHash: pair.evidence.booksHash,
        executionAt, armNames: ['eligible', 'combined'], evidence: pair.evidence };
    row.executionBatches.push(batch);
    for (const name of batch.armNames) fill(state, name, 'rest', .95, { executionAt,
        executionCohortId: batch.cohortId, executionBookHash: batch.bookHash, executionBookSource: 'rest' });
    const report = summarizeEntryFilterPaper(state, config, START + DAY);
    assert.equal(report.executionQuality.verifiedArmSources, 1);
    assert.equal(report.executionQuality.sameBatchSourceRecorded, 1);
    assert.deepEqual(report.executionQuality.unverifiableArmSources, []);
    assert.equal(report.executionQuality.restEvidenceVerification.verifiedBatches, 1);
    assert.equal(report.executionQuality.restEvidenceVerification.fullBookDepthRevalidated, false);
    assert.deepEqual(report.operationalSummary.observationValidationSources, { rest: 1 });
    for (const mutate of [
        batch => { delete batch.evidence; },
        batch => { batch.evidence.booksHash = 'b'.repeat(64); },
        batch => { batch.evidence.books[0].sourceTimestampMs = executionAt - 5001; },
        batch => { batch.evidence.books[0].sourceAgeMs = 0; },
        batch => { batch.evidence.books[0].cacheStatus = 'HIT'; },
        batch => { batch.evidence.books[0].tickVerification.tokenId = 'wrong-token'; },
        batch => { batch.evidence.books[0].receivedAt = executionAt + 1; },
        batch => { batch.evidence.metadataVerifiedAt = executionAt - 5001; },
        batch => { batch.evidence.metadataIdentity = JSON.stringify(['changed-condition']); },
    ]) {
        const invalid = structuredClone(state); mutate(invalid.snapshots[0].executionBatches[0]);
        const quality = summarizeEntryFilterPaper(invalid, config, START + DAY).executionQuality;
        assert.equal(quality.verifiedArmSources, 0);
        assert.equal(quality.restEvidenceVerification.unavailableOrInvalidBatches, 1);
        assert.deepEqual(quality.unverifiableArmSources, ['rest-cohort']);
    }
    state.arms.combined.completed[0].executionBookSource = 'websocket';
    const mismatch = summarizeEntryFilterPaper(state, config, START + DAY).executionQuality;
    assert.equal(mismatch.verifiedArmSources, 0);
    assert.deepEqual(mismatch.mismatchedArmSources, ['rest-cohort']);
    assert.deepEqual(mismatch.unverifiableArmSources, []);
});

test('activity exposes seven unchanged wins and latest actual fill without counting duplicate completions or pending orders', () => {
    const state = fixture();
    for (let index = 1; index <= 7; index++) {
        const slug = `win-${index}`; snapshot(state, slug);
        fill(state, 'combined', slug, .95, { openedAt: START + index * 300000 - 30000,
            executionAt: START + index * 300000 - 29000 });
    }
    state.arms.combined.completed.push(structuredClone(state.arms.combined.completed[6]));
    state.arms['cost-cap'].position = { market: { slug: 'pending' }, status: 'pending', submittedAt: START + DAY - 1000,
        executionAt: START + DAY, holdings: 0, order: { shares: 5 } };
    const report = summarizeEntryFilterPaper(state, config, START + DAY);
    const activity = report.operationalSummary.arms.combined.activity;
    assert.equal(report.arms.combined.wins, 7);
    assert.equal(report.arms.combined.completedFilled, 7);
    assert.equal(report.arms.combined.tradingPnl, 6.65);
    assert.equal(activity.observedFilledMarkets, 7);
    assert.equal(activity.lastEntryAt, new Date(START + 2070000).toISOString());
    assert.equal(activity.lastFillAt, new Date(START + 2071000).toISOString());
    assert.equal(activity.lastCompletedAt, new Date(START + 2100000).toISOString());
    assert.equal(activity.timeWithoutTradeMs, DAY - 2071000);
    assert.equal(activity.timeSinceLastCompletedMs, DAY - 2100000);
    assert.equal(activity.noFillsRecorded, false);
    const pending = report.operationalSummary.arms['cost-cap'].activity;
    assert.equal(pending.noFillsRecorded, true);
    assert.equal(pending.lastFillAt, null);
    assert.equal(pending.timeWithoutTradeMs, DAY);
    assert.equal(pending.timeWithoutTradeBasis, 'period_start_no_fills_recorded');
    assert.equal(report.operationalSummary.startedAt, new Date(START).toISOString());
    assert.equal(report.operationalSummary.elapsedMs, DAY);
    assert.equal(report.totalPnl, undefined);
});

test('missing, future and ambiguous fill dates remain unknown; matched inventory supplies a recorded actual fill', () => {
    const state = fixture(); snapshot(state, 'missing');
    fill(state, 'eligible', 'missing', .95, { openedAt: START + 1000, closedAt: undefined });
    state.arms.buffer.position = { market: { slug: 'matched' }, status: 'matched', holdings: 0,
        fill: { shares: 2 }, executionAt: START + 2000, submittedAt: START + 1000 };
    let report = summarizeEntryFilterPaper(state, config, START + DAY);
    let activity = report.operationalSummary.arms.eligible.activity;
    assert.equal(activity.lastEntryAt, new Date(START + 1000).toISOString());
    assert.equal(activity.lastFillAt, null);
    assert.equal(activity.lastCompletedAt, null);
    assert.equal(activity.fillTimestampMissingMarkets, 1);
    assert.equal(activity.completionTimestampMissingMarkets, 1);
    assert.equal(activity.timeWithoutTradeMs, null);
    assert.equal(activity.timeWithoutTradeBasis, 'unknown_incomplete_fill_evidence');
    assert.equal(report.operationalSummary.arms.buffer.activity.openFilledMarket, 'matched');
    assert.equal(report.operationalSummary.arms.buffer.activity.timeWithoutTradeMs, DAY - 2000);
    state.arms.eligible.completed[0].executionAt = START + DAY + 1;
    report = summarizeEntryFilterPaper(state, config, START + DAY);
    assert.equal(report.operationalSummary.arms.eligible.activity.lastFillAt, null);
    assert.equal(report.operationalSummary.arms.eligible.activity.fillTimestampMissingMarkets, 1);
    state.arms.eligible.completed.push({ ...state.arms.eligible.completed[0], pnl: -1 });
    state.startedAt = undefined;
    report = summarizeEntryFilterPaper(state, config, START + DAY);
    activity = report.operationalSummary.arms.eligible.activity;
    assert.equal(activity.lastFillAt, null);
    assert.equal(activity.excludedCompletionMarkets, 1);
    assert.equal(activity.noFillsRecorded, false);
    assert.equal(activity.timeWithoutTradeMs, null);
    assert.equal(report.operationalSummary.startedAt, null);
    assert.equal(report.operationalSummary.elapsedMs, null);
    assert.equal(report.operationalSummary.arms.combined.activity.timeWithoutTradeMs, null);
});

test('report files and worker render provider-free economics with restrictive permissions', async t => {
    const directory = temporary(t), state = fixture(); snapshot(state, 'empty');
    const runtime = { ...config, dataDir: directory }; period(directory, config.id, config, state);
    saveEntryFilterPaperReport(runtime, state, START + DAY);
    const worker = new Worker(new URL('../../src/entry-filter-paper/report-worker.js', import.meta.url), { workerData: runtime });
    await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    const dir = path.join(directory, config.id, 'reports');
    const markdown = fs.readFileSync(path.join(dir, 'latest.md'), 'utf8');
    assert.match(markdown, /nol request inference/);
    assert.match(markdown, /Delta vs eligible/);
    assert.match(markdown, /partial fill/);
    assert.match(markdown, /tidak ada promosi live otomatis/);
    assert.match(markdown, /Mulai periode:/);
    assert.match(markdown, /umur observasi/);
    assert.match(markdown, /Waktu tanpa fill baru/);
    assert.match(markdown, /Kegagalan pipeline\/data/);
    assert.match(markdown, /Veto data\/konteks\/integritas/);
    assert.match(markdown, /Slot dan sampel tidak sama dengan jumlah market/);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'latest.md')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, 'latest.json')).mode & 0o777, 0o600);
});

test('active and explicitly linked history use stored policies and remain separate cohorts', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const state = fixture(); snapshot(state, 'current'); fill(state, 'eligible', 'current', .95);
    const previous = fixture('archived'); snapshot(previous, 'previous'); fill(previous, 'eligible', 'previous', -4.05);
    const observationPolicy = { version: 'observation-recovery-test-v2', closingSourceWait: { enabled: true },
        restRecovery: { enabled: true } };
    period(current, config.id, { ...config, observationPolicy }, state);
    period(old, 'archived', { ...config, costCapPerShare: .84 }, previous);
    const link = { id: 'archived', dataDir: old, archivedAt: START + DAY };
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [link, link] }));
    const report = readEntryFilterPaperReports({ dataDir: current, id: 'new-code-id', costCapPerShare: .1 }, true);
    assert.equal(report.id, config.id);
    assert.equal(report.hypothesis.costCapPerShare, .85);
    assert.deepEqual(report.operationalSummary.observationPolicy, observationPolicy);
    assert.deepEqual(report.periodPolicy.observationPolicy, observationPolicy);
    assert.equal(report.arms.eligible.completedFilled, 1);
    assert.equal(report.arms.eligible.tradingPnl, .95);
    assert.equal(report.history.length, 1);
    assert.equal(report.history[0].hypothesis.costCapPerShare, .84);
    assert.equal(report.history[0].periodPolicy.observationPolicy, null);
    assert.equal(report.history[0].operationalSummary.observationPolicy, null);
    assert.equal(report.operationalSummary.samples.uniqueObservedMarkets, 1);
    assert.equal(report.history[0].operationalSummary.samples.uniqueObservedMarkets, 1);
    assert.equal(report.history[0].arms.eligible.tradingPnl, -4.05);
    assert.equal(report.history[0].archivedAt, START + DAY);
    assert.equal(report.history[0].elapsedDays, 1);
    assert.equal(report.history[0].operationalSummary.elapsedMs, DAY);
    assert.equal(report.history[0].operationalSummary.evaluationAt, new Date(START + DAY).toISOString());
});

test('identity checks reject legacy experiments, mismatched ledgers and unsafe period paths', t => {
    const directory = temporary(t), state = fixture(); const dir = period(directory);
    assert.throws(() => saveEntryFilterPaperReport({ ...config, dataDir: directory, id: '../escape' }, state), /identity_mismatch/);
    assert.throws(() => summarizeEntryFilterPaper(state, { ...config, experiment: 'decision-paper-v3' }), /identity_mismatch/);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ ...state, id: 'other' }));
    assert.throws(() => readEntryFilterPaperReports({ dataDir: directory }), /identity_mismatch/);
    fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ periods: [{
        id: '../escape', dataDir: directory, archivedAt: START }] }));
    assert.throws(() => readEntryFilterPaperReports({ dataDir: directory }, true), /identity_mismatch/);
    const foreign = path.join(directory, 'foreign');
    period(foreign, 'legacy', { ...config, experiment: 'decision-paper-v3' }, fixture('legacy'));
    fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ periods: [{
        id: 'legacy', dataDir: foreign, archivedAt: START }] }));
    assert.throws(() => readEntryFilterPaperReports({ dataDir: directory }, true), /identity_mismatch/);
});

const TUNING_ARMS = ['cost-cap-control', 'cost-cap-90s', 'cost-cap-drop-2c'];
const tuningConfig = { ...config, id: 'live-tuning-period', profile: 'live-tuning-v1',
    armNames: TUNING_ARMS, baselineArm: 'cost-cap-control', slots: [90, 60, 30],
    tuningPolicy: { selectedSlotSeconds: 90, maximumAskDrop: .02 },
    armPolicies: { 'cost-cap-control': 'cost-cap-all-slots', 'cost-cap-90s': 'cost-cap-90-seconds-only',
        'cost-cap-drop-2c': 'cost-cap-skip-ask-drop-above-two-cents' } };

const COST_ARMS = ['cost-cap-control', 'cost-cap-082'];
const costConfig = { ...config, id: 'live-cost-period', profile: LIVE_COST_CAP_PROFILE,
    armNames: COST_ARMS, baselineArm: 'cost-cap-control', slots: [90, 60, 30],
    armCostCaps: { 'cost-cap-control': .85, 'cost-cap-082': .82 },
    tuningPolicy: { version: LIVE_COST_CAP_PROFILE, firstCheckpointHours: 24, promotion: 'manual-review-only' },
    armPolicies: { 'cost-cap-control': 'full-fill-all-in-cost-at-most-085',
        'cost-cap-082': 'full-fill-all-in-cost-at-most-082' } };

test('cost comparison loader reports both frozen caps and a separate two-arm checkpoint', t => {
    const directory = temporary(t), runtime = loadEntryFilterPaperConfig({}, directory, LIVE_COST_CAP_PROFILE);
    const store = new EntryFilterPaperStore(runtime, START);
    const first = saveEntryFilterPaperReport(runtime, store.state, START + DAY);
    assert.deepEqual(first.armNames, COST_ARMS);
    assert.deepEqual(first.hypothesis.armCostCaps, costConfig.armCostCaps);
    assert.equal(first.hypothesis.entryFilter, null);
    assert.match(first.hypothesis.interpretation, /separate_full_fill_all_in_cost_caps/);
    assert.equal(first.evaluationSchedule.parametersFrozen, true);
    assert.equal(first.evaluationSchedule.automaticPromotion, false);
    assert.equal(first.evaluationSchedule.independentHoldout.required, true);
    assert.ok(!first.limitations.includes('volatility_buffer_is_not_calibrated_win_probability'));
    for (const name of COST_ARMS) {
        assert.equal(first.arms[name].capital, 20);
        assert.deepEqual(first.arms[name].researchEligibility, first.commonEntryWindow.arms[name].researchEligibility);
        assert.ok(first.arms[name].researchEligibility.reasons.includes('insufficient_elapsed_days'));
        assert.equal(first.arms[name].researchEligibility.eligible, false);
    }
    const dir = path.join(directory, runtime.id, 'reports');
    const markdown = fs.readFileSync(path.join(dir, 'latest.md'), 'utf8');
    assert.match(markdown, /2 ledger virtual terpisah/);
    assert.match(markdown, /cost-cap-control maksimum \$0\.850000/);
    assert.match(markdown, /cost-cap-082 maksimum \$0\.820000/);
    assert.doesNotMatch(markdown, /Tiga arm|slot sisa|buffer volatilitas/);
    saveEntryFilterPaperReport(runtime, store.state, START + 2 * DAY);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint-24h.json')));
    assert.equal(checkpoint.generatedAt, first.generatedAt);
    assert.deepEqual(checkpoint.hypothesis.armCostCaps, costConfig.armCostCaps);
    const saved = readEntryFilterPaperReports({ dataDir: directory });
    assert.deepEqual(saved.periodPolicy.armCostCaps, costConfig.armCostCaps);
});

test('cost comparison stops its primary window at first arm stop and excludes later passive evidence', () => {
    const state = fixture(costConfig.id, COST_ARMS);
    const loss = snapshot(state, 'loss', [0, 1]);
    fill(state, 'cost-cap-control', loss.market, -4, { openedAt: loss.at });
    veto(state, 'cost-cap-082', loss.market);
    loss.decisions['cost-cap-082'].filterReason = 'entry_cost_above_cap';
    const win = snapshot(state, 'win');
    for (const name of COST_ARMS) fill(state, name, win.market, 1, { openedAt: win.at });
    const cutoff = START + DAY;
    state.arms['cost-cap-082'].stopped = { at: cutoff, reason: 'research_drawdown_limit' };
    const late = snapshot(state, 'later-control');
    late.at = cutoff + 1000;
    state.markets[late.market].end = late.at + 300000;
    fill(state, 'cost-cap-control', late.market, 5, { openedAt: late.at, closedAt: late.at + 301000 });
    for (let day = 2; day <= 8; day++) {
        const row = snapshot(state, `passive-${day}`);
        Object.assign(row, { at: START + day * DAY, passiveCollection: true, diagnosticOnly: true });
        state.markets[row.market].end = row.at + 300000;
    }
    const report = summarizeEntryFilterPaper(state, costConfig, START + 9 * DAY), window = report.commonEntryWindow;
    assert.equal(window.entryCutoffAt, new Date(cutoff).toISOString());
    assert.equal(window.cutoffReason, 'earliest_arm_research_stop');
    assert.deepEqual(window.commonCohort.marketIds, ['loss', 'win']);
    assert.equal(window.arms['cost-cap-control'].tradingPnl, -3);
    assert.equal(report.arms['cost-cap-control'].tradingPnl, 2);
    assert.equal(window.differences['cost-cap-082'].tradingDifference, 4);
    assert.equal(window.differences['cost-cap-082'].outcomeTradeoff.filterVetoLossesAvoided, 1);
    assert.equal(window.differences['cost-cap-082'].tradingMeanDifferenceCi95, null);
    assert.equal(report.collectionSummary.snapshots.diagnosticOnly, 7);
    for (const name of COST_ARMS) {
        assert.deepEqual(report.arms[name].researchEligibility, window.arms[name].researchEligibility);
        assert.ok(report.arms[name].researchEligibility.reasons.includes('insufficient_elapsed_days'));
        assert.equal(report.arms[name].researchEligibility.eligible, false);
    }
    assert.ok(report.arms['cost-cap-082'].researchEligibility.reasons.includes('research_drawdown_stop'));
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.automaticPromotion, false);
});

test('cost comparison research gate needs complete paired fills before independent holdout review', () => {
    const state = fixture(costConfig.id, COST_ARMS);
    for (let index = 0; index < 105; index++) {
        const row = snapshot(state, `paired-${index}`);
        row.at = START + (index % 7) * DAY + index * 1000;
        state.markets[row.market].end = row.at + 300000;
        for (const name of COST_ARMS)
            fill(state, name, row.market, 1, { openedAt: row.at, closedAt: row.at + 301000 });
        if (index < 6) delete state.markets[row.market].payout;
    }
    const incomplete = summarizeEntryFilterPaper(state, costConfig, START + 8 * DAY);
    assert.equal(incomplete.commonEntryWindow.commonCohort.markets, 99);
    for (const name of COST_ARMS) {
        const eligibility = incomplete.arms[name].researchEligibility;
        assert.equal(incomplete.arms[name].completedFilled, 105);
        assert.equal(eligibility.eligible, false);
        assert.ok(eligibility.reasons.includes('insufficient_common_cohort_filled_markets'));
        assert.ok(eligibility.reasons.includes('unresolved_common_cohort_markets'));
    }
    for (let index = 0; index < 6; index++) state.markets[`paired-${index}`].payout = [1, 0];
    const complete = summarizeEntryFilterPaper(state, costConfig, START + 8 * DAY);
    for (const name of COST_ARMS) assert.equal(complete.arms[name].researchEligibility.eligible, true);
    assert.equal(complete.commonEntryWindow.commonCohort.markets, 105);
    assert.equal(complete.commonEntryWindow.differences['cost-cap-082'].tradingDifference, 0);
    assert.equal(complete.evaluationSchedule.independentHoldout.status, 'not_evaluated_by_this_report');
    assert.equal(complete.automaticPromotion, false);
    assert.equal(complete.sufficientForLive, false);
});

test('cost comparison history keeps archived tuning policies and ledgers separate', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const state = fixture(costConfig.id, COST_ARMS); snapshot(state, 'current');
    const previous = fixture(tuningConfig.id, TUNING_ARMS); snapshot(previous, 'old');
    fill(previous, 'cost-cap-control', 'old', -4);
    period(current, costConfig.id, costConfig, state);
    const oldDir = period(old, tuningConfig.id, tuningConfig, previous);
    const before = fs.readFileSync(path.join(oldDir, 'ledger.json'), 'utf8');
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [{
        id: tuningConfig.id, dataDir: old, archivedAt: START + DAY }] }));
    const report = readEntryFilterPaperReports({ dataDir: current }, true);
    assert.deepEqual(report.armNames, COST_ARMS);
    assert.deepEqual(report.periodPolicy.armCostCaps, costConfig.armCostCaps);
    assert.equal(report.arms['cost-cap-control'].completedFilled, 0);
    assert.equal(report.history.length, 1);
    assert.deepEqual(report.history[0].armNames, TUNING_ARMS);
    assert.equal(report.history[0].periodPolicy.armCostCaps, null);
    assert.deepEqual(report.history[0].periodPolicy.tuningPolicy, tuningConfig.tuningPolicy);
    assert.equal(report.history[0].arms['cost-cap-control'].tradingPnl, -4);
    assert.equal(fs.readFileSync(path.join(oldDir, 'ledger.json'), 'utf8'), before);
});

test('actual live tuning loader produces a reportable policy and isolated empty three-arm period', t => {
    const directory = temporary(t), runtime = loadEntryFilterPaperConfig({}, directory, 'live-tuning-v1');
    const store = new EntryFilterPaperStore(runtime, START);
    const report = saveEntryFilterPaperReport(runtime, store.state, START + 1000);
    assert.equal(report.profile, 'live-tuning-v1');
    assert.deepEqual(report.armNames, TUNING_ARMS);
    assert.equal(report.baselineArm, 'cost-cap-control');
    assert.deepEqual(report.hypothesis.tuningPolicy, runtime.tuningPolicy);
    assert.equal(report.commonCohort.markets, 0);
    const saved = readEntryFilterPaperReports({ dataDir: directory });
    assert.equal(saved.id, runtime.id);
    assert.deepEqual(saved.armNames, TUNING_ARMS);
    assert.equal(saved.commonCohort.markets, 0);
});

test('live tuning compares all three arms against cost-cap control on the same cohort including final skips', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS);
    for (const slug of ['loss', 'win', 'all-skip']) snapshot(state, slug);
    fill(state, 'cost-cap-control', 'loss', -4);
    for (const [name, reason] of [['cost-cap-90s', 'entry_slot_not_selected'],
        ['cost-cap-drop-2c', 'entry_ask_drop_above_limit']]) {
        veto(state, name, 'loss');
        state.snapshots[0].decisions[name].filterReason = reason;
    }
    for (const name of TUNING_ARMS) fill(state, name, 'win', .95);
    const report = summarizeEntryFilterPaper(state, tuningConfig, START + DAY);
    assert.deepEqual(report.armNames, TUNING_ARMS);
    assert.equal(report.baselineArm, 'cost-cap-control');
    assert.equal(report.profile, 'live-tuning-v1');
    assert.equal(report.commonCohort.markets, 3);
    assert.equal(report.commonCohort.includesSkipAndNoFill, true);
    assert.deepEqual(report.commonCohort.marketIds, ['loss', 'win', 'all-skip']);
    assert.equal(report.arms['cost-cap-control'].tradingPnl, -3.05);
    for (const name of TUNING_ARMS.slice(1)) {
        assert.equal(report.arms[name].capital, 20);
        assert.equal(report.arms[name].completedFilled, 1);
        assert.equal(report.arms[name].cohortNoExposureMarkets, 2);
        assert.equal(report.differences[name].baseline, 'cost-cap-control');
        assert.equal(report.differences[name].tradingDifference, 4);
        assert.equal(report.differences[name].outcomeTradeoff.filterVetoLossesAvoided, 1);
        assert.equal(report.differences[name].outcomeTradeoff.neitherFilledMarkets, 1);
        assert.equal(report.operationalSummary.arms[name].decisions.strategyFilterRejections.samples, 1);
        assert.equal(report.arms[name].researchEligibility.eligible, false);
    }
    assert.deepEqual(report.hypothesis.tuningPolicy, tuningConfig.tuningPolicy);
    assert.equal(report.hypothesis.baselinePolicy, tuningConfig.armPolicies['cost-cap-control']);
    assert.equal(report.automaticPromotion, false);
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.evaluationSchedule.firstCheckpointAt, new Date(START + DAY).toISOString());
    assert.equal(report.evaluationSchedule.minimumDurationAt, new Date(START + 7 * DAY).toISOString());
    assert.equal(report.evaluationSchedule.minimumCompletedFilledPerArm, 100);
    assert.equal(report.evaluationSchedule.firstCheckpointReached, true);
    assert.equal(report.differences['cost-cap-90s'].tradingMeanDifferenceCi95, null);
});

test('execution ask-drop veto retains its BUY signal and consumed attempt but is a final no-exposure strategy outcome', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS), row = snapshot(state, 'drop');
    fill(state, 'cost-cap-control', 'drop', -4);
    veto(state, 'cost-cap-90s', 'drop');
    state.arms['cost-cap-drop-2c'].seen.drop = true;
    state.arms['cost-cap-drop-2c'].outcomes.drop = { reason: 'execution_filter_veto',
        code: 'entry_ask_drop_above_limit', pnl: 0 };
    Object.assign(row.decisions['cost-cap-drop-2c'], { action: 'BUY_UP',
        entryDisposition: 'execution_filter_veto', filterReason: 'entry_ask_drop_above_limit' });
    const report = summarizeEntryFilterPaper(state, tuningConfig, START + DAY);
    assert.equal(row.decisions['cost-cap-drop-2c'].action, 'BUY_UP');
    assert.equal(report.commonCohort.markets, 1);
    assert.equal(report.commonCohort.unresolvedMarkets, 0);
    assert.equal(report.arms['cost-cap-drop-2c'].attempts, 1);
    assert.equal(report.arms['cost-cap-drop-2c'].executionFailures, 0);
    assert.equal(report.arms['cost-cap-drop-2c'].cohortNoExposureMarkets, 1);
    assert.equal(report.differences['cost-cap-drop-2c'].tradingDifference, 4);
    assert.equal(report.differences['cost-cap-drop-2c'].outcomeTradeoff.filterVetoLossesAvoided, 1);
    const decisions = report.operationalSummary.arms['cost-cap-drop-2c'].decisions;
    assert.equal(decisions.strategyFilterRejections.samples, 1);
    assert.equal(decisions.pipelineFailures.samples, 0);
    assert.equal(decisions.dataOrIntegrityFilterVetoes.samples, 0);
    row.decisions['cost-cap-drop-2c'].entryDisposition = 'reserved';
    const unresolved = summarizeEntryFilterPaper(state, tuningConfig, START + DAY);
    assert.equal(unresolved.commonCohort.markets, 0);
    assert.equal(unresolved.commonCohort.unresolvedMarkets, 1);
});

test('tuning report renders its actual policies and keeps the first 24-hour checkpoint unchanged', t => {
    const directory = temporary(t), state = fixture(tuningConfig.id, TUNING_ARMS);
    snapshot(state, 'skip');
    const runtime = { ...tuningConfig, dataDir: directory };
    const reportDir = path.join(directory, tuningConfig.id, 'reports');
    const checkpointFile = path.join(reportDir, 'checkpoint-24h.json');
    saveEntryFilterPaperReport(runtime, state, START + DAY - 1);
    assert.equal(fs.existsSync(checkpointFile), false);
    const first = saveEntryFilterPaperReport(runtime, state, START + DAY);
    assert.equal(JSON.parse(fs.readFileSync(checkpointFile)).generatedAt, first.generatedAt);
    fill(state, 'cost-cap-control', 'skip', .95);
    saveEntryFilterPaperReport(runtime, state, START + 2 * DAY);
    assert.equal(JSON.parse(fs.readFileSync(checkpointFile)).arms['cost-cap-control'].completedFilled, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(reportDir, 'latest.json'))).arms['cost-cap-control'].completedFilled, 1);
    const markdown = fs.readFileSync(path.join(reportDir, 'latest.md'), 'utf8');
    assert.match(markdown, /3 ledger virtual terpisah; modal \$20\.000000 per arm/);
    assert.match(markdown, /Pembanding: cost-cap-control/);
    assert.match(markdown, /Delta vs cost-cap-control/);
    assert.match(markdown, /cost-cap-90-seconds-only/);
    assert.match(markdown, /Checkpoint awal:/);
    assert.match(markdown, /belum bukti kelulusan/);
    assert.match(markdown, /100 market selesai terisi per arm/);
    assert.equal(fs.statSync(checkpointFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(reportDir, 'checkpoint-24h.md')).mode & 0o777, 0o600);
});

test('new tuning and old four-arm periods retain their own policies, starts and cohorts in history', t => {
    const directory = temporary(t), current = path.join(directory, 'current'), old = path.join(directory, 'old');
    const state = fixture(tuningConfig.id, TUNING_ARMS); snapshot(state, 'current');
    fill(state, 'cost-cap-control', 'current', .95);
    const previous = fixture('archived'); snapshot(previous, 'old'); fill(previous, 'cost-cap', 'old', -4);
    period(current, tuningConfig.id, tuningConfig, state);
    period(old, 'archived', config, previous);
    fs.writeFileSync(path.join(current, 'history.json'), JSON.stringify({ periods: [{
        id: 'archived', dataDir: old, archivedAt: START + DAY }] }));
    const report = readEntryFilterPaperReports({ dataDir: current }, true);
    assert.deepEqual(report.armNames, TUNING_ARMS);
    assert.equal(report.baselineArm, 'cost-cap-control');
    assert.deepEqual(report.periodPolicy.tuningPolicy, tuningConfig.tuningPolicy);
    assert.equal(report.operationalSummary.samples.uniqueObservedMarkets, 1);
    assert.equal(report.history.length, 1);
    assert.deepEqual(report.history[0].armNames, ARMS);
    assert.equal(report.history[0].baselineArm, 'eligible');
    assert.equal(report.history[0].arms['cost-cap'].tradingPnl, -4);
    assert.equal(report.history[0].periodPolicy.profile, null);
    assert.equal(report.arms['cost-cap-control'].tradingPnl, .95);
});

test('configurable report arms still reject duplicate names, missing baseline and mismatched ledgers', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS);
    for (const policy of [
        { ...tuningConfig, armNames: ['cost-cap-control', 'cost-cap-control', 'cost-cap-drop-2c'] },
        { ...tuningConfig, baselineArm: 'eligible' },
        { ...tuningConfig, armNames: ['cost-cap-control', 'unexpected', 'cost-cap-drop-2c'] },
        { ...tuningConfig, armNames: ['cost-cap-control', '../escape', 'cost-cap-drop-2c'] },
    ]) assert.throws(() => summarizeEntryFilterPaper(state, policy), /identity_mismatch/);
});

test('common entry window ends at earliest stop and includes later settlements but excludes later entries', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS), cutoff = START + 500000;
    const early = snapshot(state, 'entered-before-stop');
    for (const name of TUNING_ARMS) fill(state, name, early.market, name === 'cost-cap-control' ? -4 : 1,
        { openedAt: early.at, executionAt: early.at + 10, closedAt: START + 2 * DAY });
    const later = snapshot(state, 'entered-after-stop');
    fill(state, 'cost-cap-control', later.market, 2, { openedAt: later.at, closedAt: START + 2 * DAY });
    state.arms['cost-cap-90s'].stopped = { at: cutoff, reason: 'research_drawdown' };
    state.arms['cost-cap-control'].stopped = { at: START + DAY, reason: 'research_drawdown' };
    const before = JSON.stringify(state), report = summarizeEntryFilterPaper(state, tuningConfig, START + 3 * DAY);
    assert.equal(JSON.stringify(state), before);
    const window = report.commonEntryWindow;
    assert.equal(window.entryCutoffAt, new Date(cutoff).toISOString());
    assert.equal(window.cutoffReason, 'earliest_arm_research_stop');
    assert.equal(window.settlementAsOf, new Date(START + 3 * DAY).toISOString());
    assert.equal(window.includesSettlementsAfterCutoff, true);
    assert.equal(window.arms['cost-cap-control'].completedFilled, 1);
    assert.equal(window.arms['cost-cap-control'].losses, 1);
    assert.equal(window.arms['cost-cap-control'].tradingPnl, -4);
    assert.deepEqual(window.arms['cost-cap-control'].excludedCompletedMarkets, { entry_after_cutoff: 1 });
    assert.deepEqual(window.commonCohort.marketIds, ['entered-before-stop']);
    assert.equal(window.differences['cost-cap-90s'].tradingDifference, 5);
    assert.equal(report.arms['cost-cap-control'].completedFilled, 2);
    assert.equal(report.arms['cost-cap-control'].tradingPnl, -2);
    assert.match(report.allPeriodTotalsBasis, /unequal_active_horizons/);
    assert.match(window.differences['cost-cap-90s'].outcomeTradeoff.interpretation, /not_a_causal/);
});

test('paired cohort excludes a market if one arm entered after cutoff instead of inventing a no-fill outcome', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS), row = snapshot(state, 'mixed-entry-times');
    const cutoff = row.at + 1000;
    fill(state, 'cost-cap-control', row.market, -4, { openedAt: cutoff, closedAt: cutoff + 2000 });
    fill(state, 'cost-cap-90s', row.market, 1, { openedAt: cutoff + 1, closedAt: cutoff + 2000 });
    state.arms['cost-cap-drop-2c'].stopped = { at: cutoff };
    const window = summarizeEntryFilterPaper(state, tuningConfig, START + DAY).commonEntryWindow;
    assert.equal(window.arms['cost-cap-control'].completedFilled, 1);
    assert.equal(window.arms['cost-cap-90s'].completedFilled, 0);
    assert.equal(window.commonCohort.markets, 0);
    assert.deepEqual(window.commonCohort.excludedMarkets,
        [{ market: row.market, reasons: ['entry_after_cutoff'] }]);
    assert.equal(window.differences['cost-cap-90s'].matchedMarkets, 0);
    assert.equal(window.differences['cost-cap-90s'].outcomeTradeoff.lossesAvoided, 0);
});

test('without a stop common window runs to now and reports unknown entry times without using settlement time', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS), row = snapshot(state, 'known');
    fill(state, 'cost-cap-control', row.market, 1, { openedAt: row.at });
    const unknown = snapshot(state, 'unknown-entry');
    fill(state, 'cost-cap-control', unknown.market, 2);
    const future = snapshot(state, 'future-settlement');
    fill(state, 'cost-cap-control', future.market, 3, { openedAt: future.at, closedAt: START + 2 * DAY });
    let window = summarizeEntryFilterPaper(state, tuningConfig, START + DAY).commonEntryWindow;
    assert.equal(window.available, true);
    assert.equal(window.entryCutoffAt, new Date(START + DAY).toISOString());
    assert.equal(window.cutoffReason, 'current_report_time');
    assert.equal(window.arms['cost-cap-control'].completedFilled, 1);
    assert.deepEqual(window.arms['cost-cap-control'].excludedCompletedMarkets,
        { entry_time_unknown: 1, settlement_after_as_of: 1 });
    state.arms['cost-cap-90s'].stopped = { reason: 'undated_stop' };
    window = summarizeEntryFilterPaper(state, tuningConfig, START + DAY).commonEntryWindow;
    assert.equal(window.available, false);
    assert.equal(window.entryCutoffAt, null);
    assert.equal(window.cutoffReason, 'research_stop_time_unknown');
    assert.equal(window.arms['cost-cap-control'].completedFilled, 0);
    assert.equal(window.commonCohort.markets, 0);
});

test('passive snapshots and labels remain fresh after stops without inflating trading days or fills', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS), row = snapshot(state, 'active');
    const cutoff = START + DAY;
    for (const name of TUNING_ARMS) {
        fill(state, name, row.market, 1, { openedAt: row.at });
        state.arms[name].stopped = { at: cutoff };
    }
    state.markets.active.labelResolvedAt = START + 300000;
    for (let day = 2; day <= 8; day++) {
        const passive = snapshot(state, `passive-${day}`);
        Object.assign(passive, { at: START + day * DAY, passiveCollection: true, diagnosticOnly: true,
            collectionPhase: 'all_stopped', allowed: [] });
        Object.assign(state.markets[passive.market], { end: passive.at + 1000, labelResolvedAt: passive.at + 2000 });
    }
    const report = summarizeEntryFilterPaper(state, { ...tuningConfig, profile: 'live-tuning-v2',
        passiveCollection: { enabled: true, afterArmStop: true } }, START + 8 * DAY + 3000);
    assert.equal(report.collectionSummary.snapshots.afterFirstResearchStop, 7);
    assert.equal(report.collectionSummary.snapshots.afterAllResearchStops, 7);
    assert.equal(report.collectionSummary.snapshots.diagnosticOnly, 7);
    assert.equal(report.collectionSummary.snapshots.ageMs, 3000);
    assert.equal(report.collectionSummary.officialLabels.postStopObservedMarketsLabeled, 7);
    assert.equal(report.collectionSummary.officialLabels.resolvedAfterFirstResearchStop, 7);
    assert.equal(report.collectionSummary.officialLabels.ageMs, 1000);
    assert.equal(report.collectionSummary.tradingEvidenceAddedByPassiveCollection, false);
    assert.equal(report.commonEntryWindow.elapsedDays, 1);
    assert.equal(report.commonEntryWindow.commonCohort.markets, 1);
    assert.equal(report.commonEntryWindow.commonCohort.observedDays, 1);
    for (const name of TUNING_ARMS) {
        assert.equal(report.commonEntryWindow.arms[name].completedFilled, 1);
        assert.equal(report.commonEntryWindow.arms[name].observedEntryDays, 1);
        assert.equal(report.arms[name].researchEligibility.eligible, false);
        assert.equal(report.arms[name].researchEligibility.basis, 'common_entry_window');
        assert.ok(report.arms[name].researchEligibility.reasons.includes('insufficient_observed_entry_days'));
        assert.equal(report.commonEntryWindow.arms[name].uncertainty.ci95, null);
    }
    assert.equal(report.evaluationSchedule.independentHoldout.required, true);
    assert.equal(report.evaluationSchedule.independentHoldout.status, 'not_evaluated_by_this_report');
    assert.equal(report.sufficientForLive, false);
});

test('v2 research gate requires completed fills in the paired cohort and excludes passive no-side observations', () => {
    const state = fixture(tuningConfig.id, TUNING_ARMS);
    for (let index = 0; index < 105; index++) {
        const row = snapshot(state, `filled-${index}`);
        row.at = START + (index % 7) * DAY + index * 1000;
        state.markets[row.market].end = row.at + 300000;
        for (const name of TUNING_ARMS)
            fill(state, name, row.market, 1, { openedAt: row.at, closedAt: row.at + 301000 });
        if (index < 6) delete state.markets[row.market].payout;
    }
    for (let day = 1; day <= 8; day++) {
        const row = snapshot(state, `no-side-${day}`);
        Object.assign(row, { at: START + day * DAY, passiveCollection: true, diagnosticOnly: false, allowed: [] });
        state.markets[row.market].end = row.at + 1000;
    }
    const report = summarizeEntryFilterPaper(state, { ...tuningConfig, profile: 'live-tuning-v2' }, START + 9 * DAY);
    assert.equal(report.commonEntryWindow.commonCohort.markets, 99);
    assert.equal(report.commonEntryWindow.commonCohort.observedDays, 7);
    for (const name of TUNING_ARMS) {
        assert.equal(report.commonEntryWindow.arms[name].completedFilled, 105);
        assert.equal(report.commonEntryWindow.arms[name].cohortFilledMarkets, 99);
        assert.equal(report.commonEntryWindow.arms[name].observedEntryDays, 7);
        assert.ok(report.arms[name].researchEligibility.reasons.includes('insufficient_common_cohort_filled_markets'));
        assert.ok(report.arms[name].researchEligibility.reasons.includes('unresolved_common_cohort_markets'));
        assert.equal(report.arms[name].researchEligibility.eligible, false);
    }
    for (let index = 0; index < 6; index++) state.markets[`filled-${index}`].payout = [1, 0];
    const complete = summarizeEntryFilterPaper(state, { ...tuningConfig, profile: 'live-tuning-v2' }, START + 9 * DAY);
    for (const name of TUNING_ARMS) assert.equal(complete.arms[name].researchEligibility.eligible, true);
    assert.equal(complete.commonEntryWindow.commonCohort.markets, 105);
    assert.equal(complete.evaluationSchedule.independentHoldout.status, 'not_evaluated_by_this_report');
    assert.equal(complete.sufficientForLive, false);
    assert.equal(complete.automaticPromotion, false);
    state.arms['cost-cap-control'].position = { market: { slug: 'undated-inventory' },
        status: 'filled', holdings: 5, entryCost: 4 };
    const inventory = summarizeEntryFilterPaper(state, { ...tuningConfig, profile: 'live-tuning-v2' }, START + 9 * DAY);
    assert.ok(inventory.arms['cost-cap-control'].activeInventory);
    assert.equal(inventory.arms['cost-cap-control'].researchEligibility.eligible, false);
    assert.ok(inventory.arms['cost-cap-control'].researchEligibility.reasons.includes('unresolved_inventory'));
    assert.ok(inventory.arms['cost-cap-control'].researchEligibility.reasons.includes('incomplete_inventory_entry_timestamp'));
});
