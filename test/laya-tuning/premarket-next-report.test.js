import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EARLY_PROFILE, NEXT_PROFILE, earlyPremarketFeatures, buildEarlyPremarketInput } from '../../src/premarket-paper/early-context.js';
import { EARLY_BOOK_POLICY } from '../../src/premarket-paper/early-book.js';
import { summarizePremarketPaper, savePremarketPaperReport, readPremarketPaperReports } from '../../src/premarket-paper/report.js';

const AT = Date.parse('2026-10-28T10:15:05Z'), NOW = AT + 900000;
const ARMS = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const ACTIVE = ARMS.filter(name => name !== 'late-cost-cap');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = { id: 'next-report', profile: NEXT_PROFILE, paperOnly: true,
    experiment: 'premarket-three-candles-paper-v1', armNames: ARMS, activeArms: ACTIVE,
    inferencePolicy: 'shared-compact-150m-next-candle-confirmation-laya-router-30s-v1',
    rolePolicy: 'streak-signal-confirmation-or-skip-v1', entryEndOffsetMs: 90000,
    controlPolicy: 'next-candle-streak-reversal-with-ai-confirmation-filters',
    capital: 20, shares: 5, entryCap: 5, leadSeconds: -5, candleCount: 30, candleIntervalMs: 300000,
    historyMs: 9000000, diagnosticHistoryMs: 9000000, candleCacheMaxAgeMs: 90000,
    slotToleranceMs: 10000, aiDecisionMs: 30000, latencyMs: 250, signalParameters: { minimumPriorStreak: 3 },
    bookPolicy: EARLY_BOOK_POLICY, earlyExecution: { version: 'bounded-shared-rest-fak-v1', retryWindowMs: 30000, retryMs: 1000 },
    providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' }, bootstrapSamples: 20 };

function fixture(pattern = 'down') {
    const market = { slug: 'btc-updown-5m-next-report', conditionId: 'condition', tokens: ['up', 'down'],
        open: AT - 5000, end: AT + 295000, accepting: true, negRisk: false, minimum: 5,
        tick: .01, ticks: [.01, .01], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const windowEnd = market.open, observedAt = AT - 1000;
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: windowEnd - 9000000, windowEnd, expectedLatestClosedAt: windowEnd,
        observedAt, fetchedAt: observedAt,
        bars: Array.from({ length: 30 }, (_, i) => ({ openAt: windowEnd - (30 - i) * 300000,
            closeAt: windowEnd - (29 - i) * 300000, open: 80000 + i, high: 80003 + i,
            low: 79999 + i, close: 80000 + i + (pattern === 'up' ? i === 29 ? 2 : -1 : pattern === 'down' && i === 29 ? -1 : 2), observedAt })) };
    const capturedAt = AT + 1000, cutoff = capturedAt + 30000, submittedAt = cutoff + 1200;
    const activeAt = submittedAt + 250, executionAt = activeAt + 200, deadlineAt = cutoff + 30000;
    const books = market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        sourceTick: .01, minimum: 5, negRisk: false, timestamp: AT - 3600000, fetchedAt: executionAt,
        sourceTimestamp: String(AT - 3600000), sourceHash: 'a'.repeat(40),
        bids: [{ price: .49, size: 10 }], asks: [{ price: .50, size: 10 }] }));
    const response = (tokenId, endpoint) => ({ tokenId, endpoint: `https://clob.polymarket.com/${endpoint}`,
        requestStartedAt: activeAt, receivedAt: executionAt, roundTripMs: 200, deadlineAt,
        status: 200, cachePolicy: 'no-store', cacheBust: true, httpDateAt: Math.floor(executionAt / 1000) * 1000,
        httpAge: null, cacheStatus: 'DYNAMIC' });
    const evidence = { schema: EARLY_BOOK_POLICY.schema, paperOnly: true, authority: 'fresh_rest_full_snapshot',
        sourceTimestampMeaning: 'exchange_book_timestamp', startedAt: activeAt, verifiedAt: executionAt, deadlineAt,
        metadataVerifiedAt: submittedAt, metadataIdentity: JSON.stringify([market.conditionId, market.tokens,
            market.minimum, market.ticks, market.fee.rate, market.fee.exponent, market.fee.takerOnly, false, true]),
        booksHash: hash(JSON.stringify(books)), books: books.map(book => ({ ...response(book.tokenId, 'book'),
            sourceTimestamp: book.sourceTimestamp, sourceTimestampMs: book.timestamp,
            sourceAgeMs: executionAt - book.timestamp, sourceHash: book.sourceHash,
            sourceTick: book.sourceTick, tick: book.tick, tickVerification: response(book.tokenId, 'tick-size') })) };
    const captureBooks = structuredClone(books), captureEvidence = structuredClone(evidence);
    for (const book of captureBooks) book.fetchedAt = capturedAt;
    Object.assign(captureEvidence, { startedAt: capturedAt - 200, verifiedAt: capturedAt,
        deadlineAt: AT + 3000, metadataVerifiedAt: AT, booksHash: hash(JSON.stringify(captureBooks)) });
    for (const proof of captureEvidence.books) {
        proof.sourceAgeMs = capturedAt - proof.sourceTimestampMs;
        for (const row of [proof, proof.tickVerification]) Object.assign(row, { requestStartedAt: capturedAt - 200,
            receivedAt: capturedAt, deadlineAt: AT + 3000, httpDateAt: Math.floor(capturedAt / 1000) * 1000 });
    }
    const snapshot = { snapshotId: 'next-report-snapshot', market, scheduledAt: AT, at: capturedAt,
        observedAt, aiDeadlineAt: cutoff, decisionCutoffAt: cutoff,
        features: earlyPremarketFeatures(history, market, AT, config), books: captureBooks, bookEvidence: captureEvidence,
        orders: { BUY_UP: pattern === 'up' ? { price: .51, shares: 5, cost: 2.7 } : null,
            BUY_DOWN: pattern === 'down' ? { price: .51, shares: 5, cost: 2.7 } : null },
        fairExecution: { status: 'reserved', scheduledAt: cutoff, deadlineAt, adjudicatedAt: cutoff,
            validatedAt: submittedAt, submittedAt, activeAt, validationBookHash: hash('validation'),
            attempts: [{ startedAt: cutoff, finishedAt: cutoff + 100, status: 'failed', code: 'early_book_read_timeout' },
                { startedAt: cutoff + 1100, finishedAt: submittedAt, status: 'verified' }],
            executionAt, executionBookHash: evidence.booksHash, executionEvidence: evidence, executionBooks: books } };
    const common = snapshot.commonInput = { ...buildEarlyPremarketInput(snapshot, config), contextVerified: true,
        contextTokens: 800, contextIdentity: hash('tokenizer'), semanticPromptHash: hash('prompt') };
    snapshot.decisions = Object.fromEntries(ACTIVE.map(name => [name, { status: 'ok', action: pattern === 'up' ? 'BUY_UP' : pattern === 'down' ? 'BUY_DOWN' : 'SKIP',
        inputHash: common.inputHash, inputCoverage: common.inputCoverage, offeredInputHash: common.inputHash,
        offeredInputCoverage: common.inputCoverage, semanticPromptHash: common.semanticPromptHash,
        offeredSemanticPromptHash: common.semanticPromptHash, contextTokens: 800,
        contextIdentity: common.contextIdentity, contextVerified: true,
        requestSubmitted: name !== 'premarket-momentum', inferenceAttempted: name !== 'premarket-momentum',
        startedAt: capturedAt, receivedAt: capturedAt + 7000, decisionCompletedAt: capturedAt + 7000, cost: null }]));
    const slug = market.slug, state = { id: config.id, startedAt: AT, snapshots: [snapshot], slots: {},
        markets: { [slug]: { ...market, enrolledAt: AT, payout: pattern === 'up' ? [1, 0] : [0, 1], labelResolvedAt: market.end + 10000 } },
        arms: Object.fromEntries(ARMS.map(name => [name, { cash: 20, peak: 20, drawdown: 0, positions: {},
            outcomes: { [slug]: { noExposure: name === 'late-cost-cap', pnl: name === 'late-cost-cap' ? 0 : 2.4,
                reason: name === 'late-cost-cap' ? 'arm_not_selected' : 'settled' } },
            completed: name === 'late-cost-cap' ? [] : [{ slug, side: pattern === 'up' ? 'UP' : 'DOWN', shares: 5, pnl: 2.4, entryCost: 2.55,
                fees: .05, gas: .05, capitalHours: .1, closedAt: market.end + 10000, openedAt: submittedAt,
                executionAt, executionBookHash: evidence.booksHash, orderLimit: .51, executionEvidence: evidence }] }])) };
    return { state, snapshot, history, timing: snapshot.fairExecution, evidence,
        fill: state.arms['laya-premarket'].completed[0], config: structuredClone(config) };
}

function report(f) { return summarizePremarketPaper(f.state, f.config, NOW); }

function noExposure(f, name, reason = 'provider_skip') {
    f.state.arms[name].completed = [];
    f.state.arms[name].outcomes[f.snapshot.market.slug] = { noExposure: true, pnl: 0, reason };
}

for (const direction of ['down', 'up']) test(`next report verifies immediate successor ${direction} fills and confirmation role`, () => {
    const f = fixture(direction), before = structuredClone(f.state), summary = report(f);
    assert.deepEqual(f.state, before);
    assert.equal(summary.comparability.status, 'verified', JSON.stringify(summary.comparability.reasons));
    const row = summary.comparability.rows[0], action = direction === 'down' ? 'BUY_DOWN' : 'BUY_UP';
    assert.equal(row.inputCoverage.historyEndAt, f.snapshot.market.open);
    assert.equal(row.inputCoverage.decisionAt, f.snapshot.market.open + 5000);
    assert.deepEqual(row.confirmation.allowedActions, [action, 'SKIP']);
    assert.equal(row.confirmation.signal.action, action);
    assert.equal(row.confirmation.openingTwap.value, null);
    assert.equal(row.confirmation.confirmationOnly, true);
    assert.ok(row.filledExecution.every(fill => fill.executionAt > f.snapshot.market.open));
    assert.equal(summary.hypothesis.nextCandleTarget, true);
    assert.equal(summary.hypothesis.aiMaySkipValidSignal, true);
    assert.equal(summary.hypothesis.oppositeDirectionBuyAllowed, false);
    assert.equal(summary.hypothesis.rolePolicy, config.rolePolicy);
    assert.equal(summary.operational.executionPolicy.postOpenEntry, true);
    assert.equal(summary.operational.executionPolicy.marketOpenOffsetLimitMs, 90000);
    assert.equal(summary.operational.executionPolicy.postSubmissionRetries, false);
    assert.equal(summary.operational.executionAttempts, 2);
    for (const name of ['laya-premarket', 'router-premarket']) {
        assert.equal(summary.arms[name].inference.totalCost, null);
        assert.equal(summary.arms[name].netAfterInference, null);
        assert.equal(summary.arms[name].inference.computeCost, null);
    }
});

const cases = [
    ['late capture', f => { f.snapshot.at = AT + 10001; }, 'next_capture_timing_unverified'],
    ['missing capture receipt', f => { delete f.snapshot.bookEvidence; }, 'next_capture_book_unverified'],
    ['AI budget shortened to pre-open', f => { f.snapshot.aiDeadlineAt = f.snapshot.market.open - 1; }, 'next_capture_timing_unverified'],
    ['wrong execution deadline', f => { f.timing.deadlineAt++; }, 'next_execution_window_unverified'],
    ['fill at deadline', f => { f.fill.executionAt = f.timing.deadlineAt; }, 'next_execution_window_unverified'],
    ['fill after deadline', f => { f.fill.executionAt = f.timing.deadlineAt + 1; }, 'next_execution_window_unverified'],
    ['fill at open plus 90s', f => { f.fill.executionAt = f.snapshot.market.open + 90000; }, 'next_execution_window_unverified'],
    ['fill at market end', f => { f.fill.executionAt = f.snapshot.market.end; }, 'next_execution_window_unverified'],
    ['missing readiness attempts', f => { delete f.timing.attempts; }, 'next_execution_attempts_unverified'],
    ['readiness retry too soon', f => { f.timing.attempts[1].startedAt--; }, 'next_execution_attempts_unverified'],
    ['retry after readiness success', f => { f.timing.attempts[0].status = 'verified'; }, 'next_execution_attempts_unverified'],
    ['repriced limit', f => { f.fill.orderLimit = .52; }, 'next_frozen_order_unverified'],
    ['late completed decision', f => { f.snapshot.decisions['laya-premarket'].decisionCompletedAt = f.snapshot.aiDeadlineAt + 1; }, 'next_frozen_order_unverified'],
    ['missing execution receipt', f => { f.fill.executionEvidence = null; }, 'next_execution_receipt_unverified'],
    ['execution REST request before activation', f => { f.evidence.startedAt = f.timing.activeAt - 1; }, 'next_execution_receipt_unverified'],
    ['later target market', f => { f.state.markets[f.snapshot.market.slug].open += 300000; }, 'full_common_history_unverified'],
    ['missing final candle', f => { f.snapshot.features.bars.pop(); }, 'frozen_history_coverage_unverified'],
    ['fabricated opening TWAP', f => { f.snapshot.features.openingTwap.value = 80000; }, 'next_confirmation_input_unverified'],
    ['changed offered action mask', f => { f.snapshot.commonInput.allowed = ['BUY_UP', 'BUY_DOWN', 'SKIP']; }, 'next_confirmation_input_unverified'],
    ['changed context signal', f => { f.snapshot.commonInput.context.reversalSignal.action = 'BUY_UP'; }, 'next_confirmation_input_unverified'],
    ['changed coverage role', f => { f.snapshot.commonInput.inputCoverage.confirmationOnly = false; }, 'next_confirmation_input_unverified'],
    ['opposite Laya BUY', f => { f.snapshot.decisions['laya-premarket'].action = 'BUY_UP'; }, 'next_confirmation_action_unverified'],
    ['opposite GPT BUY', f => { f.snapshot.decisions['router-premarket'].action = 'BUY_UP'; }, 'next_confirmation_action_unverified'],
    ['opposite deterministic BUY', f => { f.snapshot.decisions['premarket-momentum'].action = 'BUY_UP'; }, 'next_confirmation_action_unverified'],
];
for (const [name, mutate, reason] of cases) test(`next report rejects ${name}`, () => {
    const f = fixture(); mutate(f);
    const summary = report(f);
    assert.equal(summary.comparability.status, 'incomplete');
    assert.equal(summary.comparability.reasons[reason], 1, JSON.stringify(summary.comparability.reasons));
});

test('next AI can SKIP a valid signal while the control fills', () => {
    const f = fixture();
    for (const name of ['laya-premarket', 'router-premarket']) {
        f.snapshot.decisions[name].action = 'SKIP';
        noExposure(f, name);
    }
    const summary = report(f);
    assert.equal(summary.comparability.status, 'verified', JSON.stringify(summary.comparability.reasons));
    assert.equal(summary.arms['premarket-momentum'].completedFilled, 1);
    assert.equal(summary.arms['laya-premarket'].completedFilled, 0);
    assert.equal(summary.arms['laya-premarket'].inference.modelSkips, 1);
    assert.equal(summary.arms['laya-premarket'].inference.totalCost, null);
});

test('next no-pattern SKIP retains common input and records that neither AI was called', () => {
    const f = fixture('none');
    for (const name of ACTIVE) {
        noExposure(f, name, 'signal_not_met');
        if (name !== 'premarket-momentum') Object.assign(f.snapshot.decisions[name], {
            status: 'signal_not_met', requestSubmitted: false, inferenceAttempted: false });
    }
    Object.assign(f.timing, { status: 'skipped', reason: 'no_eligible_decisions', attempts: [] });
    const summary = report(f), row = summary.comparability.rows[0];
    assert.equal(summary.comparability.status, 'verified', JSON.stringify(summary.comparability.reasons));
    assert.deepEqual(row.confirmation.allowedActions, ['SKIP']);
    assert.equal(row.confirmation.signal.action, 'SKIP');
    assert.equal(row.arms['laya-premarket'].inputUse, 'provider_request_not_submitted');
    assert.equal(row.arms['router-premarket'].inputUse, 'provider_request_not_submitted');
    assert.equal(summary.arms['laya-premarket'].inference.requests, 0);
    assert.equal(summary.arms['router-premarket'].inference.requests, 0);
});

test('next uniform pre-input skip uses open plus five seconds', () => {
    const f = fixture(), slug = f.snapshot.market.slug;
    for (const name of ACTIVE) {
        noExposure(f, name, 'observation_failed');
        f.state.arms[name].outcomes[slug].code = 'candle_history_stale';
    }
    f.state.snapshots = [];
    f.state.slots[`${slug}:premarket`] = { status: 'skipped', scheduledAt: AT, reason: 'candle_history_stale' };
    assert.equal(report(f).comparability.status, 'verified');
    f.state.slots[`${slug}:premarket`].scheduledAt = f.snapshot.market.open - 540000;
    assert.equal(report(f).comparability.status, 'incomplete');
});

test('next report exposes recorded clock and transport policies with readiness evidence', () => {
    const f = fixture();
    f.state.clock = { status: 'verified', verifiedAt: AT };
    f.config.clockPolicy = { version: 'clock-fixture', maxRoundTripMs: 3000 };
    f.config.transportPolicy = { version: 'transport-fixture' };
    const summary = report(f);
    assert.deepEqual(summary.operational.clock, f.state.clock);
    assert.deepEqual(summary.operational.clockPolicy, f.config.clockPolicy);
    assert.deepEqual(summary.operational.transportPolicy, f.config.transportPolicy);
    assert.deepEqual(summary.comparability.rows[0].execution.attempts, f.timing.attempts);
});

test('next markdown names the immediate target and optional AI confirmation without pre-open claims', t => {
    const f = fixture(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    savePremarketPaperReport({ ...f.config, dataDir }, f.state, NOW);
    const text = fs.readFileSync(path.join(dataDir, config.id, 'reports/latest.md'), 'utf8');
    assert.match(text, /open plus 5 detik/);
    assert.match(text, /budget AI 30 detik sejak capture aktual/);
    assert.match(text, /tepat setelah candle reversal pertama/);
    assert.match(text, /Opening TWAP .* null/);
    assert.match(text, /maksimal 90 detik setelah market dibuka/);
    assert.match(text, /sinyal valid tidak mewajibkan BUY/);
    assert.match(text, /Tanpa pola, semua arm SKIP dan AI tidak dipanggil/);
    assert.doesNotMatch(text, /540 detik setelah keputusan|batas sebelum market dibuka|tidak wajib mengikuti/);
});

test('next active and archived early periods retain separate policy and evidence', t => {
    const f = fixture(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'next-history-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const archivedId = 'archived-early';
    const archivedPolicy = { ...f.config, id: archivedId, profile: EARLY_PROFILE, leadSeconds: 540,
        inferencePolicy: 'shared-compact-150m-binance-evidence-independent-laya-router-30s-v1' };
    const archivedState = { ...structuredClone(f.state), id: archivedId, snapshots: [], markets: {} };
    for (const arm of Object.values(archivedState.arms)) Object.assign(arm, { completed: [], outcomes: {} });
    for (const [policy, state] of [[f.config, f.state], [archivedPolicy, archivedState]]) {
        const directory = path.join(dataDir, policy.id); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ id: policy.id, paperOnly: true, policy }));
        fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(state));
    }
    fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id: f.config.id, paperOnly: true }));
    fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify({ periods: [
        { id: archivedId, dataDir, archivedAt: AT - 1000 } ] }));
    const summary = readPremarketPaperReports({ dataDir }, true);
    assert.equal(summary.profile, NEXT_PROFILE);
    assert.equal(summary.hypothesis.decisionLeadSeconds, -5);
    assert.equal(summary.history.length, 1);
    assert.equal(summary.history[0].profile, EARLY_PROFILE);
    assert.equal(summary.history[0].hypothesis.decisionLeadSeconds, 540);
    assert.equal(summary.history[0].hypothesis.aiPolicy, 'independent_predictions_from_same_frozen_premarket_snapshot');
    assert.equal(summary.history[0].hypothesis.nextCandleTarget, undefined);
    assert.equal(summary.comparability.historicalPeriodsPooled, false);
    assert.equal(summary.history[0].commonCohort.enrolledMarkets, 0);
    assert.equal(summary.commonCohort.enrolledMarkets, 1);
});

test('next policy cannot silently change its timing or AI role', () => {
    for (const mutate of [
        f => { f.config.rolePolicy = 'independent'; },
        f => { f.config.leadSeconds = 540; },
        f => { f.config.aiDecisionMs = 20000; },
        f => { f.config.entryEndOffsetMs = 120000; },
        f => { delete f.config.bookPolicy; },
    ]) {
        const f = fixture(); mutate(f);
        assert.throws(() => report(f), /report_identity_mismatch/);
    }
});
