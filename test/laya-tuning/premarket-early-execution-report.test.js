import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EARLY_PROFILE, earlyPremarketFeatures, buildEarlyPremarketInput } from '../../src/premarket-paper/early-context.js';
import { EARLY_BOOK_POLICY } from '../../src/premarket-paper/early-book.js';
import { summarizePremarketPaper, savePremarketPaperReport } from '../../src/premarket-paper/report.js';

const AT = Date.parse('2026-10-28T10:16:00Z'), NOW = AT + 900000;
const ARMS = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const ACTIVE = ARMS.filter(name => name !== 'late-cost-cap');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const config = { id: 'early-execution-report', profile: EARLY_PROFILE, paperOnly: true,
    experiment: 'premarket-three-candles-paper-v1', armNames: ARMS, activeArms: ACTIVE,
    inferencePolicy: 'shared-compact-150m-binance-evidence-independent-laya-router-30s-v1',
    capital: 20, shares: 5, entryCap: 5, leadSeconds: 540, candleCount: 30, candleIntervalMs: 300000,
    historyMs: 9000000, diagnosticHistoryMs: 9000000, candleCacheMaxAgeMs: 90000,
    slotToleranceMs: 10000, aiDecisionMs: 30000, latencyMs: 250, signalParameters: { minimumPriorStreak: 3 },
    bookPolicy: EARLY_BOOK_POLICY, earlyExecution: { version: 'bounded-shared-rest-fak-v1', retryWindowMs: 30000, retryMs: 1000 },
    providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' }, bootstrapSamples: 20 };

function fixture() {
    const market = { slug: 'btc-updown-5m-early-report', conditionId: 'condition', tokens: ['up', 'down'],
        open: AT + 540000, end: AT + 840000, accepting: true, negRisk: false, minimum: 5,
        tick: .01, ticks: [.01, .01], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const windowEnd = AT - 60000, observedAt = AT - 10000;
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: windowEnd - 9000000, windowEnd, expectedLatestClosedAt: windowEnd,
        observedAt, fetchedAt: observedAt,
        bars: Array.from({ length: 30 }, (_, i) => ({ openAt: windowEnd - (30 - i) * 300000,
            closeAt: windowEnd - (29 - i) * 300000, open: 80000 + i, high: 80003 + i,
            low: 79999 + i, close: 80002 + i, observedAt })) };
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
    const snapshot = { snapshotId: 'early-execution-snapshot', market, scheduledAt: AT, at: capturedAt,
        observedAt, aiDeadlineAt: cutoff, decisionCutoffAt: cutoff,
        features: earlyPremarketFeatures(history, market, AT, config), books: captureBooks, bookEvidence: captureEvidence,
        orders: { BUY_UP: { price: .51, shares: 5, cost: 2.7 }, BUY_DOWN: { price: .51, shares: 5, cost: 2.7 } },
        fairExecution: { status: 'reserved', scheduledAt: cutoff, deadlineAt, adjudicatedAt: cutoff,
            validatedAt: submittedAt, submittedAt, activeAt, validationBookHash: hash('validation'),
            attempts: [{ startedAt: cutoff, finishedAt: cutoff + 100, status: 'failed', code: 'early_book_read_timeout' },
                { startedAt: cutoff + 1100, finishedAt: submittedAt, status: 'verified' }],
            executionAt, executionBookHash: evidence.booksHash, executionEvidence: evidence, executionBooks: books } };
    const common = snapshot.commonInput = { ...buildEarlyPremarketInput(snapshot, config), contextVerified: true,
        contextTokens: 800, contextIdentity: hash('tokenizer'), semanticPromptHash: hash('prompt') };
    snapshot.decisions = Object.fromEntries(ACTIVE.map(name => [name, { status: 'ok', action: 'BUY_UP',
        inputHash: common.inputHash, inputCoverage: common.inputCoverage, offeredInputHash: common.inputHash,
        offeredInputCoverage: common.inputCoverage, semanticPromptHash: common.semanticPromptHash,
        offeredSemanticPromptHash: common.semanticPromptHash, contextTokens: 800,
        contextIdentity: common.contextIdentity, contextVerified: true,
        requestSubmitted: name !== 'premarket-momentum', inferenceAttempted: name !== 'premarket-momentum',
        startedAt: capturedAt, receivedAt: capturedAt + 7000, decisionCompletedAt: capturedAt + 7000, cost: null }]));
    const slug = market.slug, state = { id: config.id, startedAt: AT, snapshots: [snapshot], slots: {},
        markets: { [slug]: { ...market, enrolledAt: AT, payout: [1, 0], labelResolvedAt: AT + 850000 } },
        arms: Object.fromEntries(ARMS.map(name => [name, { cash: 20, peak: 20, drawdown: 0, positions: {},
            outcomes: { [slug]: { noExposure: name === 'late-cost-cap', pnl: name === 'late-cost-cap' ? 0 : 2.4,
                reason: name === 'late-cost-cap' ? 'arm_not_selected' : 'settled' } },
            completed: name === 'late-cost-cap' ? [] : [{ slug, side: 'UP', shares: 5, pnl: 2.4, entryCost: 2.55,
                fees: .05, gas: .05, capitalHours: .1, closedAt: AT + 850000, openedAt: submittedAt,
                executionAt, executionBookHash: evidence.booksHash, orderLimit: .51, executionEvidence: evidence }] }])) };
    return { state, snapshot, timing: snapshot.fairExecution, evidence,
        fill: state.arms['laya-premarket'].completed[0], config: structuredClone(config) };
}

function report(f) { return summarizePremarketPaper(f.state, f.config, NOW); }

test('new early report verifies shared fresh REST fills while preserving old exchange timestamps and unpriced AI', t => {
    const f = fixture(), before = structuredClone(f.state), summary = report(f);
    assert.deepEqual(f.state, before);
    assert.equal(summary.comparability.status, 'verified', JSON.stringify(summary.comparability.reasons));
    assert.equal(summary.operational.executionAttempts, 2);
    assert.equal(summary.operational.bookPolicy.sourceAgeIsNotReceiptAge, true);
    assert.equal(summary.operational.executionPolicy.captureToleranceMs, 10000);
    assert.equal(summary.operational.executionPolicy.postSubmissionRetries, false);
    for (const name of ['laya-premarket', 'router-premarket']) {
        assert.equal(summary.arms[name].inference.totalCost, null);
        assert.equal(summary.arms[name].netAfterInference, null);
        assert.equal(summary.arms[name].inference.computeCost, null);
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-execution-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    savePremarketPaperReport({ ...f.config, dataDir }, f.state, NOW);
    const markdown = fs.readFileSync(path.join(dataDir, config.id, 'reports/latest.md'), 'utf8');
    assert.match(markdown, /Capture maksimal 10 detik/);
    assert.match(markdown, /umur receipt maksimal 5 detik/);
    assert.match(markdown, /satu FAK tanpa retry setelah submission/);
});

const cases = [
    ['late capture', f => { f.snapshot.at = AT + 10001; }, 'early_capture_timing_unverified'],
    ['capture book verified after capture', f => { f.snapshot.bookEvidence.verifiedAt = f.snapshot.at + 1; }, 'early_capture_book_unverified'],
    ['missing capture proof', f => { delete f.snapshot.bookEvidence; }, 'early_capture_book_unverified'],
    ['changed decision budget', f => { f.snapshot.aiDeadlineAt++; }, 'early_capture_timing_unverified'],
    ['changed retry deadline', f => { f.timing.deadlineAt++; }, 'early_execution_window_unverified'],
    ['late fill', f => { f.fill.executionAt = f.timing.deadlineAt + 1; }, 'early_execution_window_unverified'],
    ['fill at market open', f => { f.fill.executionAt = f.snapshot.market.open; }, 'early_execution_window_unverified'],
    ['activation beyond deadline', f => { f.timing.activeAt = f.timing.deadlineAt + 1; }, 'early_execution_window_unverified'],
    ['missing attempts', f => { delete f.timing.attempts; }, 'early_execution_attempts_unverified'],
    ['retry too soon', f => { f.timing.attempts[1].startedAt--; }, 'early_execution_attempts_unverified'],
    ['retry before cutoff', f => { f.timing.attempts[0].startedAt--; }, 'early_execution_attempts_unverified'],
    ['retry after success', f => { f.timing.attempts[0].status = 'verified'; }, 'early_execution_attempts_unverified'],
    ['missing limit', f => { delete f.fill.orderLimit; }, 'early_frozen_order_unverified'],
    ['repriced limit', f => { f.fill.orderLimit = .52; }, 'early_frozen_order_unverified'],
    ['wrong side', f => { f.fill.side = 'DOWN'; }, 'early_frozen_order_unverified'],
    ['late finalized decision', f => { f.snapshot.decisions['laya-premarket'].decisionCompletedAt = f.snapshot.aiDeadlineAt + 1; }, 'early_frozen_order_unverified'],
    ['read before activation', f => { f.evidence.startedAt = f.timing.activeAt - 1; }, 'early_execution_receipt_unverified'],
    ['read deadline outside window', f => { f.evidence.deadlineAt++; }, 'early_execution_receipt_unverified'],
    ['tick deadline outside window', f => { f.evidence.books[0].tickVerification.deadlineAt++; }, 'early_execution_receipt_unverified'],
    ['missing actual depth', f => { delete f.timing.executionBooks; }, 'early_execution_receipt_unverified'],
    ['changed actual depth', f => { f.timing.executionBooks[0].asks[0].price = .52; }, 'early_execution_receipt_unverified'],
    ['different shared hash', f => { f.timing.executionBookHash = hash('another'); }, 'early_execution_receipt_unverified'],
    ['different shared fill time', f => { f.timing.executionAt++; }, 'early_execution_receipt_unverified'],
    ['HTTP cache hit', f => { f.evidence.books[0].cacheStatus = 'HIT'; }, 'early_execution_receipt_unverified'],
    ['HTTP cached age', f => { f.evidence.books[0].httpAge = 1; }, 'early_execution_receipt_unverified'],
    ['stale HTTP date', f => { f.evidence.books[0].httpDateAt -= 6000; }, 'early_execution_receipt_unverified'],
    ['unverified receipt RTT', f => { f.evidence.books[0].roundTripMs = 3001; }, 'early_execution_receipt_unverified'],
    ['stale metadata', f => { f.evidence.metadataVerifiedAt = f.fill.executionAt - 5001; }, 'early_execution_receipt_unverified'],
    ['changed fee metadata', f => { f.snapshot.market.fee.rate = .08; }, 'early_execution_receipt_unverified'],
    ['market not accepting', f => { f.snapshot.market.accepting = false; }, 'early_execution_receipt_unverified'],
    ['missing snapshot', f => { f.state.snapshots = []; }, 'early_execution_receipt_unverified'],
];
for (const [name, mutate, reason] of cases) test(`early report rejects ${name}`, () => {
    const f = fixture(); mutate(f);
    const summary = report(f);
    assert.equal(summary.comparability.status, 'incomplete');
    assert.equal(summary.comparability.reasons[reason], 1, JSON.stringify(summary.comparability.reasons));
});

test('early report counts late finalized decisions outside directional accuracy', () => {
    const f = fixture(); f.snapshot.decisions['laya-premarket'].decisionCompletedAt = f.snapshot.aiDeadlineAt + 1;
    assert.equal(report(f).arms['laya-premarket'].inference.directionalDecisionAccuracy.denominator, 0);
    delete f.snapshot.decisions['laya-premarket'].decisionCompletedAt;
    assert.equal(report(f).arms['laya-premarket'].inference.directionalDecisionAccuracy.denominator, 1);
});

test('new early reports retain uniform no-input skips and pre-cutoff cancellations', () => {
    for (const captured of [false, true]) {
        const f = fixture(), slug = f.snapshot.market.slug;
        for (const name of ACTIVE) {
            f.state.arms[name].completed = [];
            f.state.arms[name].outcomes[slug] = { noExposure: true, pnl: 0,
                reason: captured ? 'entry_cutoff' : 'observation_failed', ...(captured ? {} : { code: 'candle_history_stale' }) };
        }
        if (captured) Object.assign(f.timing, { status: 'skipped', reason: 'entry_cutoff',
            adjudicatedAt: f.snapshot.at + 1000, attempts: [] });
        else {
            f.state.snapshots = [];
            f.state.slots[`${slug}:premarket`] = { status: 'skipped', scheduledAt: AT, reason: 'candle_history_stale' };
        }
        assert.equal(report(f).comparability.status, 'verified');
    }
});

test('historical early periods keep their recorded execution policy without new REST requirements', () => {
    const f = fixture(); delete f.config.bookPolicy; delete f.config.earlyExecution;
    f.config.slotToleranceMs = 2000;
    delete f.timing.attempts; delete f.timing.executionEvidence; delete f.timing.executionBooks;
    delete f.timing.executionBookHash; delete f.timing.executionAt;
    for (const name of ACTIVE) {
        delete f.state.arms[name].completed[0].orderLimit;
        delete f.state.arms[name].completed[0].executionEvidence;
    }
    const summary = report(f);
    assert.equal(summary.comparability.status, 'verified');
    assert.equal(summary.operational.bookPolicy, undefined);
});

test('bounded early policy cannot silently omit its declared quote policy', () => {
    const f = fixture(); delete f.config.bookPolicy;
    assert.throws(() => report(f), /report_identity_mismatch/);
});
