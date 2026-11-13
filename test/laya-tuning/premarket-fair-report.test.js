import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizePremarketPaper, savePremarketPaperReport, readPremarketPaperReports }
    from '../../src/premarket-paper/report.js';

const ARMS = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const ACTIVE = ['premarket-momentum', 'laya-premarket', 'router-premarket'];
const START = Date.UTC(2026, 9, 26), NOW = START + 86400000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = { id: 'fair-period', experiment: 'premarket-three-candles-paper-v1', armNames: ARMS,
    profile: 'fair-near-open-30m-v1', activeArms: ACTIVE,
    inferencePolicy: 'shared-compact-30m-evidence-independent-laya-router-30s-v1',
    capital: 20, shares: 5, entryCap: 5, leadSeconds: 60, aiDecisionMs: 30000,
    candleCount: 30, candleIntervalMs: 60000, historyMs: 1800000, diagnosticHistoryMs: 1800000,
    signalParameters: { minimumNormalizedStrength: { m5: .5, m15: 1, m30: 1 }, minimumAligned5mGroups: 5 },
    providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' },
    minDays: 1, minMarkets: 1, bootstrapSamples: 20 };
function fixture() {
    return { id: config.id, startedAt: START, snapshots: [], markets: {}, slots: {},
        arms: Object.fromEntries(ARMS.map(name => [name, { cash: 20, positions: {}, outcomes: {}, completed: [] }])) };
}
function addMarket(state, slug) {
    state.markets[slug] = { slug, open: START + 60000, end: START + 360000,
        enrolledAt: START, payout: [1, 0], labelResolvedAt: START + 361000 };
    for (const name of ACTIVE) state.arms[name].outcomes[slug] = { noExposure: true, pnl: 0,
        reason: name === 'laya-premarket' ? 'provider_timeout' : 'model_skip' };
    const input = `common-${slug}`, inputHash = hash(input), inputCoverage = { source: 'chainlink_btc_usd',
        completeMinutes: 30, minuteBars: 30, fiveMinuteGroups: 6,
        historyStartAt: START - 1800000, historyEndAt: START, decisionAt: START, truncated: false,
        encoding: 'fair-near-open-complete-cent-context-v1', fiveMinuteGroupsDerived: true,
        bookLevelsUpDown: [[5, 5], [5, 5]], quantization: { ohlc: 'nearest_USD_0.01' } };
    const commonInput = { input, inputHash, inputCoverage, inputBytes: input.length,
        contextTokens: 728, contextIdentity: hash('actual-tokenizer-identity'), contextVerified: true,
        semanticPromptHash: hash('shared-semantic-prompt') };
    const snapshot = { snapshotId: `snapshot-${slug}`, market: { slug }, scheduledAt: START, observedAt: START,
        decisionCutoffAt: START + 30000, aiDeadlineAt: START + 30000, commonInput,
        features: { bars: Array.from({ length: 30 }, (_, i) => ({ start: START - (30 - i) * 60000,
            end: START - (29 - i) * 60000 })), context: { schema: config.profile, source: 'chainlink_btc_usd',
            historyStartAt: START - 1800000, historyEndAt: START, bars5m: Array(6).fill({}) } },
        fairExecution: { status: 'skipped', scheduledAt: START + 30000, deadlineAt: START + 32000,
            adjudicatedAt: START + 30000, reason: 'no_valid_buy' },
        decisions: Object.fromEntries(ACTIVE.map(name => [name, { inputHash, inputCoverage,
            ...(name !== 'premarket-momentum' ? { offeredInputHash: inputHash, offeredInputCoverage: inputCoverage,
                offeredContextTokens: 728, offeredSemanticPromptHash: commonInput.semanticPromptHash } : {}),
            contextTokens: 728, contextIdentity: commonInput.contextIdentity, contextVerified: true,
            semanticPromptHash: commonInput.semanticPromptHash,
            status: name === 'laya-premarket' ? 'timeout' : 'ok', action: 'SKIP',
            requestSubmitted: name !== 'premarket-momentum', inferenceAttempted: name !== 'premarket-momentum',
            startedAt: START, receivedAt: START + 30000, cost: name === 'laya-premarket' ? 0 : null }])) };
    state.snapshots.push(snapshot); return snapshot;
}
function fill(state, name, slug, pnl) {
    state.arms[name].completed.push({ slug, side: 'UP', shares: 5, pnl, entryCost: 2.5,
        fees: .01, gas: .01, capitalHours: .1, closedAt: START + 361000,
        openedAt: START + 30000, executionAt: START + 30250, executionBookHash: hash('shared-execution-book') });
    state.arms[name].outcomes[slug] = { noExposure: false, pnl, reason: 'settled' };
    Object.assign(state.snapshots.find(snapshot => snapshot.market.slug === slug).fairExecution,
        { status: 'reserved', validatedAt: START + 30000, submittedAt: START + 30000,
            activeAt: START + 30250, validationBookHash: hash('shared-fresh-book') });
}
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-premarket-report-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function writePeriod(directory, policy, state) {
    const folder = path.join(directory, policy.id); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(directory, 'active.json'), JSON.stringify({ id: policy.id, paperOnly: true }));
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({ id: policy.id, paperOnly: true, policy }));
    fs.writeFileSync(path.join(folder, 'ledger.json'), JSON.stringify(state));
}

test('fair reports pair both AI arms against momentum, keeping timeout and skip final outcomes', () => {
    const state = fixture(); addMarket(state, 'skip'); addMarket(state, 'fill');
    fill(state, 'premarket-momentum', 'fill', 2.48); fill(state, 'router-premarket', 'fill', -2.52);
    const before = JSON.stringify(state), report = summarizePremarketPaper(state, config, NOW);
    assert.equal(JSON.stringify(state), before);
    assert.equal(report.controlArm, 'premarket-momentum');
    assert.deepEqual(report.activeArms, ACTIVE); assert.deepEqual(Object.keys(report.arms), ARMS);
    assert.deepEqual(report.historicalReferenceArms, ['late-cost-cap']);
    assert.equal(report.arms['late-cost-cap'].enabled, false);
    assert.equal(report.pairedComparisons['late-cost-cap'].available, false);
    assert.equal(report.pairedComparisons['late-cost-cap'].reason, 'arm_not_selected');
    assert.equal(report.pairedComparisons['premarket-momentum'], undefined);
    assert.equal(report.commonCohort.markets, 2); assert.equal(report.commonCohort.includesTimeoutAndProviderFailure, true);
    for (const name of ['laya-premarket', 'router-premarket']) {
        assert.equal(report.pairedComparisons[name].control, 'premarket-momentum');
        assert.equal(report.pairedComparisons[name].markets, 2);
    }
    assert.equal(report.pairedComparisons['router-premarket'].primaryMinusControlPnl, -5);
    assert.equal(report.comparability.status, 'verified');
    assert.equal(report.comparability.verifiedComparableMarkets, 2);
    assert.equal(report.arms['router-premarket'].inference.totalCost, null);
    assert.equal(report.arms['router-premarket'].netAfterInference, null);
    assert.equal(report.arms['laya-premarket'].inference.computeCost, null);
    assert.equal(report.virtualCapital.armProfitsMayBeSummed, false);
    assert.equal(report.automaticPromotion, false); assert.equal(report.sufficientForLive, false);
});

test('common cohort waits for all three active final outcomes but never the inactive historical reference', () => {
    const state = fixture(); addMarket(state, 'final'); addMarket(state, 'pending');
    delete state.arms['laya-premarket'].outcomes.pending;
    const report = summarizePremarketPaper(state, config, NOW);
    assert.deepEqual(report.commonCohort.marketIds, ['final']);
    assert.deepEqual(report.commonCohort.excludedReasons, { arm_outcome_pending: 1 });
    assert.equal(report.comparability.pairedMarkets, 1);
});

test('comparability verifies shared input, coverage, actual token budget, semantic prompt, and execution evidence', () => {
    const cases = [
        [snapshot => { snapshot.commonInput.input += 'changed'; }, 'common_input_hash_unverified'],
        [snapshot => { snapshot.decisions['router-premarket'].inputHash = hash('different'); }, 'router-premarket_input_hash_unverified'],
        [snapshot => { snapshot.decisions['laya-premarket'].inputCoverage = null; }, 'laya-premarket_input_coverage_unverified'],
        [snapshot => { snapshot.commonInput.contextTokens = 1025; }, 'actual_laya_context_unverified'],
        [snapshot => { delete snapshot.commonInput.contextVerified; }, 'actual_laya_context_unverified'],
        [snapshot => { snapshot.commonInput.inputCoverage.truncated = true; }, 'full_common_history_unverified'],
        [snapshot => { snapshot.features.bars.pop(); }, 'frozen_history_coverage_unverified'],
        [snapshot => { snapshot.decisions['router-premarket'].semanticPromptHash = hash('different'); }, 'router-premarket_semantic_prompt_unverified'],
        [snapshot => { snapshot.fairExecution.scheduledAt += 1; }, 'common_execution_cutoff_unverified'],
        [snapshot => { snapshot.fairExecution.status = 'reserved'; }, 'shared_execution_book_unverified']
    ];
    for (const [mutate, reason] of cases) {
        const state = fixture(); mutate(addMarket(state, 'case'));
        const report = summarizePremarketPaper(state, config, NOW);
        assert.equal(report.comparability.status, 'incomplete', reason);
        assert.equal(report.comparability.reasons[reason], 1, reason);
        assert.equal(report.pairedComparisons['router-premarket'].markets, 1);
        assert.equal(report.pairedComparisons['router-premarket'].informationalCriteria.comparabilityVerified, false);
        assert.ok(report.pairedComparisons['router-premarket'].pairedDeltaEvidence.reasons.includes('comparability_incomplete'));
    }
});

test('common submission time and book evidence verify while absent or duplicate snapshots remain incomplete', () => {
    const state = fixture(), snapshot = addMarket(state, 'buy');
    Object.assign(snapshot.fairExecution, { status: 'reserved', validatedAt: START + 30001,
        submittedAt: START + 30002, activeAt: START + 30252, validationBookHash: hash('shared-fresh-book') });
    assert.equal(summarizePremarketPaper(state, config, NOW).comparability.status, 'verified');
    snapshot.fairExecution.activeAt -= 1;
    assert.equal(summarizePremarketPaper(state, config, NOW).comparability.reasons.shared_execution_book_unverified, 1);
    state.snapshots.push(structuredClone(snapshot));
    assert.equal(summarizePremarketPaper(state, config, NOW).comparability.reasons.ambiguous_frozen_snapshot, 1);
    state.snapshots = [];
    assert.equal(summarizePremarketPaper(state, config, NOW).comparability.reasons.frozen_snapshot_missing, 1);
    assert.equal(summarizePremarketPaper(fixture(), config, NOW).comparability.status, 'incomplete');
});

test('offered input does not fabricate a request for a provider that was busy', () => {
    const state = fixture(), snapshot = addMarket(state, 'busy');
    Object.assign(snapshot.decisions['laya-premarket'], { status: 'busy', inferenceAttempted: false, requestSubmitted: false });
    delete snapshot.decisions['laya-premarket'].inputHash;
    delete snapshot.decisions['laya-premarket'].inputCoverage;
    const report = summarizePremarketPaper(state, config, NOW), row = report.comparability.rows[0];
    assert.equal(report.comparability.status, 'verified');
    assert.equal(row.arms['laya-premarket'].inputOfferedHash, snapshot.commonInput.inputHash);
    assert.equal(row.arms['laya-premarket'].inputSubmittedHash, null);
    assert.equal(row.arms['laya-premarket'].inputUse, 'provider_request_not_submitted');
    assert.equal(report.arms['laya-premarket'].inference.requests, 0);
    assert.equal(row.inputCoverage.quantization.ohlc, 'nearest_USD_0.01');
});

test('filled paired markets require matching actual execution times and books after the shared reservation', () => {
    for (const field of ['openedAt', 'executionAt', 'executionBookHash']) {
        const state = fixture(); addMarket(state, 'filled');
        fill(state, 'premarket-momentum', 'filled', 2.48); fill(state, 'router-premarket', 'filled', 2.48);
        assert.equal(summarizePremarketPaper(state, config, NOW).comparability.status, 'verified');
        const row = state.arms['router-premarket'].completed[0];
        row[field] = field === 'executionBookHash' ? hash('another-book') : row[field] + 1;
        const report = summarizePremarketPaper(state, config, NOW);
        assert.equal(report.comparability.status, 'incomplete');
        assert.equal(report.comparability.reasons.filled_execution_comparability_unverified, 1);
        assert.equal(report.commonCohort.markets, 1);
    }
});

test('documented uniform warmup and context failures retain zero outcomes without inventing input evidence', () => {
    const state = fixture(); addMarket(state, 'decision');
    for (const reason of ['completed_candles_warming', 'btc_history_gap', 'context_token_limit', 'slot_missed']) {
        const slug = `skip-${reason}`; addMarket(state, slug); state.snapshots.pop();
        state.slots[`${slug}:premarket`] = { status: 'skipped', scheduledAt: START, reason };
        for (const name of ACTIVE) state.arms[name].outcomes[slug] = { noExposure: true, pnl: 0,
            reason: reason === 'slot_missed' ? reason : 'observation_failed', code: reason };
    }
    const report = summarizePremarketPaper(state, config, NOW);
    assert.equal(report.commonCohort.markets, 5);
    assert.equal(report.comparability.status, 'verified');
    assert.equal(report.comparability.verifiedCohortMarkets, 5);
    assert.equal(report.comparability.decisionComparableMarkets, 1);
    assert.equal(report.comparability.verifiedUniformSkippedMarkets, 4);
    assert.equal(report.comparability.incompletePairedMarkets, 0);
    const warmup = report.comparability.rows.find(row => row.slug === 'skip-completed_candles_warming');
    assert.equal(warmup.status, 'verified_shared_skip');
    assert.equal(warmup.inputCoverage, null); assert.equal(warmup.contextVerified, false);
    assert.equal(warmup.arms['laya-premarket'].inputSubmittedHash, null);
    assert.equal(warmup.arms['laya-premarket'].requestSubmitted, false);
    assert.equal(report.pairedComparisons['router-premarket'].markets, 5);
    delete state.slots['skip-completed_candles_warming:premarket'];
    const missing = summarizePremarketPaper(state, config, NOW);
    assert.equal(missing.comparability.status, 'incomplete');
    assert.equal(missing.comparability.reasons.frozen_snapshot_missing, 1);
    state.arms['laya-premarket'].outcomes['skip-btc_history_gap'].code = 'another_reason';
    assert.equal(summarizePremarketPaper(state, config, NOW).comparability.incompletePairedMarkets, 2);
});

test('explicit early uniform cancellations retain complete cohort evidence including earlier model skips', () => {
    for (const reason of ['entry_cutoff', 'shutdown_pending_cancelled', 'restart_during_fair_decision']) {
        const state = fixture(), snapshot = addMarket(state, 'cancelled');
        Object.assign(snapshot.fairExecution, { status: 'skipped', reason, adjudicatedAt: START + 1000 });
        state.arms['premarket-momentum'].outcomes.cancelled.reason = reason;
        const report = summarizePremarketPaper(state, config, NOW);
        assert.equal(report.comparability.status, 'verified', reason);
        assert.equal(report.commonCohort.markets, 1);
        assert.equal(report.comparability.verifiedCohortMarkets, 1);
        assert.equal(report.comparability.verifiedUniformCancelledMarkets, 1);
        assert.equal(report.comparability.decisionComparableMarkets, 0);
        assert.equal(report.comparability.rows[0].status, 'verified_shared_cancel');
        assert.equal(report.comparability.uniformCancellationReasons[reason], 1);
        assert.equal(report.pairedComparisons['router-premarket'].informationalCriteria.comparabilityVerified, true);
    }
});

test('early cancellation cannot conceal a fill, pending exposure, mismatched evidence or unknown reason', () => {
    const cases = [
        (state, snapshot) => { snapshot.fairExecution.reason = 'unrecognized_cancel'; },
        (state, snapshot) => { snapshot.fairExecution.adjudicatedAt = START - 1; },
        (state, snapshot) => { snapshot.fairExecution.scheduledAt += 1; },
        (state, snapshot) => { snapshot.commonInput.input += 'tampered'; },
        state => { state.arms['laya-premarket'].positions.cancelled = { status: 'pending' }; },
        (state, snapshot) => {
            fill(state, 'router-premarket', 'cancelled', 2.48);
            Object.assign(snapshot.fairExecution, { status: 'skipped', reason: 'entry_cutoff', adjudicatedAt: START + 1000 });
        }
    ];
    for (const mutate of cases) {
        const state = fixture(), snapshot = addMarket(state, 'cancelled');
        Object.assign(snapshot.fairExecution, { status: 'skipped', reason: 'entry_cutoff', adjudicatedAt: START + 1000 });
        mutate(state, snapshot);
        const report = summarizePremarketPaper(state, config, NOW);
        assert.equal(report.comparability.status, 'incomplete');
        assert.equal(report.comparability.verifiedUniformCancelledMarkets, 0);
    }
});

test('fair markdown names all three arms, quantization and evidence limits', t => {
    const directory = temp(t), state = fixture(); addMarket(state, 'skip');
    savePremarketPaperReport({ ...config, dataDir: directory }, state, NOW);
    const md = fs.readFileSync(path.join(directory, config.id, 'reports/latest.md'), 'utf8');
    assert.match(md, /Arm aktif: premarket-momentum, laya-premarket, router-premarket/);
    assert.match(md, /Kontrol paired: premarket-momentum/);
    assert.match(md, /late-cost-cap tidak aktif; hanya referensi historis/);
    assert.match(md, /OHLC dibulatkan ke sen/); assert.match(md, /tokenizer Laya 1.024 token/);
    assert.match(md, /Comparability: verified/);
    assert.match(md, /laya-premarket - premarket-momentum/); assert.match(md, /router-premarket - premarket-momentum/);
    assert.match(md, /biaya compute belum termasuk/);
    assert.doesNotMatch(md, /Router menilai Up, Down, atau SKIP dari seluruh konteks/);
});

test('fair history keeps old router-only profile parameters and samples separate', t => {
    const directory = temp(t), oldDirectory = temp(t), state = fixture(); addMarket(state, 'current');
    const oldConfig = { ...config, id: 'old-router-period', profile: 'near-open-30m-v1',
        activeArms: ['router-premarket'], inferencePolicy: 'independent-laya-router-frozen-forecast-30s' };
    const oldState = fixture(); oldState.id = oldConfig.id; addMarket(oldState, 'old'); fill(oldState, 'router-premarket', 'old', 2.48);
    writePeriod(directory, config, state); writePeriod(oldDirectory, oldConfig, oldState);
    fs.writeFileSync(path.join(directory, 'history.json'), JSON.stringify({ periods: [
        { id: oldConfig.id, dataDir: oldDirectory, archivedAt: NOW }
    ] }));
    const report = readPremarketPaperReports({ dataDir: directory }, true);
    assert.equal(report.profile, config.profile); assert.equal(report.controlArm, 'premarket-momentum');
    assert.equal(report.commonCohort.markets, 1); assert.equal(report.arms['router-premarket'].tradingPnl, 0);
    assert.equal(report.history[0].profile, oldConfig.profile); assert.equal(report.history[0].controlArm, 'late-cost-cap');
    assert.equal(report.history[0].arms['router-premarket'].tradingPnl, 2.48);
    assert.equal(report.comparability.historicalPeriodsPooled, false);
    assert.equal(report.history[0].comparability, undefined);
});

test('fair profile rejects incomplete or substituted active cohorts and wrong inference identity', () => {
    for (const activeArms of [['router-premarket'], ARMS, ['late-cost-cap', 'laya-premarket', 'router-premarket']])
        assert.throws(() => summarizePremarketPaper(fixture(), { ...config, activeArms }, NOW), /identity_mismatch/);
    assert.throws(() => summarizePremarketPaper(fixture(), { ...config,
        inferencePolicy: 'independent-laya-router-frozen-forecast-30s' }, NOW), /identity_mismatch/);
});
