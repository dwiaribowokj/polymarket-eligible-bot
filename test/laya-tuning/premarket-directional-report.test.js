import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPremarketPaperConfig } from '../../src/premarket-paper/config.js';
import { NEXT_PROFILE, NEXT_PREMARKET_PROMPT, earlyPremarketFeatures, buildEarlyPremarketInput } from '../../src/premarket-paper/early-context.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY, routerDirectionalPromptEvidence } from '../../src/premarket-paper/router-directional.js';
import { summarizePremarketPaper, savePremarketPaperReport, readPremarketPaperReports } from '../../src/premarket-paper/report.js';

const AT = Date.parse('2026-10-28T10:15:05Z'), NOW = AT + 900000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const configuration = loadPremarketPaperConfig({ PREMARKET_PROFILE: NEXT_PROFILE,
    PREMARKET_ROUTER_POLICY: NEXT_ROUTER_DIRECTIONAL_POLICY }, '/tmp/directional-report-fixture');

function fixture() {
    const config = { ...structuredClone(configuration.policy), id: 'directional-report', bootstrapSamples: 20 };
    const market = { slug: 'btc-updown-5m-directional-report', conditionId: 'condition', tokens: ['up', 'down'],
        open: AT - 5000, end: AT + 295000, accepting: true, negRisk: false, minimum: 5,
        tick: .01, ticks: [.01, .01], fee: { rate: .07, exponent: 1, takerOnly: true } };
    const observedAt = AT - 1000, at = AT + 1000, deadlineAt = AT + 3000, cutoff = at + 30000;
    const history = { ready: true, source: 'binance_spot', symbol: 'BTCUSDT', intervalMs: 300000,
        windowStart: market.open - 9000000, windowEnd: market.open, expectedLatestClosedAt: market.open,
        observedAt, fetchedAt: observedAt, bars: Array.from({ length: 30 }, (_, i) => ({
            openAt: market.open - (30 - i) * 300000, closeAt: market.open - (29 - i) * 300000,
            open: 80000 + i, high: 80003 + i, low: 79999 + i, close: 80000 + i + (i === 29 ? -1 : 2), observedAt })) };
    const books = market.tokens.map(tokenId => ({ tokenId, conditionId: market.conditionId, tick: .01,
        sourceTick: .01, minimum: 5, negRisk: false, timestamp: AT - 3600000, fetchedAt: at,
        sourceTimestamp: String(AT - 3600000), sourceHash: 'a'.repeat(40),
        bids: [{ price: .49, size: 10 }], asks: [{ price: .50, size: 10 }] }));
    const response = (tokenId, endpoint) => ({ tokenId, endpoint: `https://clob.polymarket.com/${endpoint}`,
        requestStartedAt: at - 200, receivedAt: at, roundTripMs: 200, deadlineAt, status: 200,
        cachePolicy: 'no-store', cacheBust: true, httpDateAt: at, httpAge: null, cacheStatus: 'DYNAMIC' });
    const bookEvidence = { schema: config.bookPolicy.schema, paperOnly: true, authority: 'fresh_rest_full_snapshot',
        sourceTimestampMeaning: 'exchange_book_timestamp', startedAt: at - 200, verifiedAt: at, deadlineAt,
        metadataVerifiedAt: AT, metadataIdentity: JSON.stringify([market.conditionId, market.tokens,
            market.minimum, market.ticks, market.fee.rate, market.fee.exponent, market.fee.takerOnly, false, true]),
        booksHash: hash(JSON.stringify(books)), books: books.map(book => ({ ...response(book.tokenId, 'book'),
            sourceTimestamp: book.sourceTimestamp, sourceTimestampMs: book.timestamp,
            sourceAgeMs: at - book.timestamp, sourceHash: book.sourceHash, sourceTick: .01, tick: .01,
            tickVerification: response(book.tokenId, 'tick-size') })) };
    const snapshot = { snapshotId: 'directional-snapshot', market, scheduledAt: AT, at, observedAt,
        aiDeadlineAt: cutoff, decisionCutoffAt: cutoff, books, bookEvidence,
        features: earlyPremarketFeatures(history, market, AT, config),
        orders: { BUY_UP: null, BUY_DOWN: { price: .51, shares: 5, cost: 2.7 } },
        fairExecution: { status: 'skipped', reason: 'early_book_read_timeout', scheduledAt: cutoff,
            adjudicatedAt: cutoff + 30000, deadlineAt: cutoff + 30000, attempts: [] } };
    const common = snapshot.commonInput = { ...buildEarlyPremarketInput(snapshot, config),
        contextVerified: true, contextTokens: 800, contextIdentity: hash('tokenizer'), semanticPromptHash: hash(NEXT_PREMARKET_PROMPT) };
    snapshot.decisions = Object.fromEntries(config.activeArms.map(name => [name, { status: 'ok',
        action: name === 'premarket-momentum' ? 'BUY_DOWN' : 'SKIP', inputHash: common.inputHash,
        inputCoverage: common.inputCoverage, offeredInputHash: common.inputHash, offeredInputCoverage: common.inputCoverage,
        semanticPromptHash: common.semanticPromptHash, offeredSemanticPromptHash: common.semanticPromptHash,
        contextTokens: 800, contextIdentity: common.contextIdentity, contextVerified: true,
        requestSubmitted: name !== 'premarket-momentum', inferenceAttempted: name !== 'premarket-momentum',
        startedAt: at, receivedAt: at + 7000, decisionCompletedAt: at + 7000, cost: null }]));
    const router = snapshot.decisions['router-premarket'], prompt = routerDirectionalPromptEvidence(config);
    Object.assign(router, prompt, { forecastDirection: 'UP', forecastStrength: 'weak', reasonCode: 'direction_opposes_signal',
        rationale: 'The wider rise outweighs one opposing candle.' },
    Object.fromEntries(Object.entries(prompt).map(([key, value]) => [`offered${key[0].toUpperCase()}${key.slice(1)}`, value])));
    const state = { id: config.id, startedAt: AT, snapshots: [snapshot], slots: {},
        markets: { [market.slug]: { ...market, enrolledAt: AT, payout: [1, 0], labelResolvedAt: market.end + 10000 } },
        arms: Object.fromEntries(config.armNames.map(name => [name, { cash: 20, peak: 20, drawdown: 0,
            positions: {}, completed: [], outcomes: { [market.slug]: { noExposure: true, pnl: 0,
                reason: name === 'late-cost-cap' ? 'arm_not_selected' : 'provider_skip' } } }])) };
    return { config, state, snapshot, router };
}

const report = f => summarizePremarketPaper(f.state, f.config, NOW);
const inference = f => report(f).arms['router-premarket'].inference;

test('directional report verifies the same input and distinct actual GPT prompt without changing Laya evidence', () => {
    const f = fixture(), before = structuredClone(f), summary = report(f);
    assert.deepEqual(f, before);
    assert.equal(summary.comparability.status, 'verified', JSON.stringify(summary.comparability.reasons));
    assert.equal(summary.routerPolicy, NEXT_ROUTER_DIRECTIONAL_POLICY);
    assert.equal(summary.providerComparisonPolicy.sameFrozenInput, true);
    assert.equal(summary.providerComparisonPolicy.differentProviderPrompts, true);
    assert.equal(summary.providerComparisonPolicy.pureModelComparison, false);
    const row = summary.comparability.rows[0];
    assert.equal(row.arms['router-premarket'].inputSubmittedHash, row.arms['laya-premarket'].inputSubmittedHash);
    assert.equal(row.semanticPromptHash, hash(NEXT_PREMARKET_PROMPT));
    assert.notEqual(row.arms['router-premarket'].providerPromptHash, row.semanticPromptHash);
    assert.equal(row.arms['laya-premarket'].providerPromptHash, undefined);
    assert.equal(summary.arms['router-premarket'].inference.requestsEvidence[0].forecastStrength, 'weak');
    assert.equal(summary.arms['router-premarket'].inference.modelSkipReasons.direction_opposes_signal, 1);
});

for (const [field, expectedReason] of [
    ['offeredProviderPromptHash', 'router-premarket_offered_provider_prompt_unverified'],
    ['providerPromptHash', 'router-premarket_provider_prompt_unverified'],
    ['providerTask', 'router-premarket_provider_prompt_unverified'],
    ['providerPromptVersion', 'router-premarket_provider_prompt_unverified'],
    ['semanticPromptHash', 'router-premarket_semantic_prompt_unverified'],
    ['offeredSemanticPromptHash', 'router-premarket_offered_semantic_prompt_unverified'],
    ['inputHash', 'router-premarket_input_hash_unverified'],
    ['offeredInputHash', 'router-premarket_offered_input_hash_unverified'],
]) test(`directional report rejects forged ${field}`, () => {
    const f = fixture(); f.router[field] = hash('forged');
    const summary = report(f);
    assert.equal(summary.comparability.status, 'incomplete');
    assert.equal(summary.comparability.reasons[expectedReason], 1);
    assert.equal(summary.arms['router-premarket'].inference.directionalForecastAccuracy.denominator, 0);
});

test('explicit opposing SKIP forecast is scored against official settlement separately from BUY decisions', () => {
    const f = fixture(), actual = inference(f);
    assert.equal(actual.directionalDecisionAccuracy.denominator, 0);
    assert.equal(actual.directionalForecastAccuracy.correct, 1);
    assert.equal(actual.directionalForecastAccuracy.denominator, 1);
    assert.equal(actual.directionalForecastAccuracy.skippedDecisions, 1);
    assert.equal(actual.directionalForecastAccuracy.inferredFromAction, false);
    assert.deepEqual(actual.timelyForecastDirectionCounts, { UP: 1 });
    assert.deepEqual(actual.timelyForecastStrengthCounts, { weak: 1 });
    f.state.markets[f.snapshot.market.slug].payout = [0, 1];
    assert.equal(inference(f).directionalForecastAccuracy.incorrect, 1);
});

for (const [label, mutate, bucket] of [
    ['provider failure', f => { f.router.status = 'provider_error'; }, 'invalid'],
    ['late receipt', f => { f.router.receivedAt = f.snapshot.aiDeadlineAt + 1; }, 'late'],
    ['late completed decision', f => { f.router.decisionCompletedAt = f.snapshot.aiDeadlineAt + 1; }, 'late'],
    ['timely false', f => { f.router.timely = false; }, 'late'],
    ['missing direction', f => { delete f.router.forecastDirection; }, 'unknown'],
    ['missing strength', f => { delete f.router.forecastStrength; }, 'invalid'],
    ['matching direction with SKIP', f => { f.router.forecastDirection = 'DOWN'; }, 'invalid'],
    ['pending provider', f => { f.router.status = 'requested'; }, 'pending'],
    ['withheld provider', f => { Object.assign(f.router, { status: 'signal_not_met', requestSubmitted: false, inferenceAttempted: false }); }, 'withheld'],
]) test(`forecast accuracy excludes ${label} with explicit coverage`, () => {
    const f = fixture(); mutate(f); const actual = inference(f);
    assert.equal(actual.directionalForecastAccuracy.denominator, 0);
    assert.equal(actual.forecastCoverage[bucket], 1);
});

test('pending official labels remain pending and a BUY is not synthesized into a forecast', () => {
    const f = fixture(); delete f.state.markets[f.snapshot.market.slug].payout;
    assert.equal(inference(f).forecastCoverage.pendingLabels, 1);
    assert.equal(inference(f).directionalForecastAccuracy.denominator, 0);
    delete f.config.routerPolicy; delete f.router.forecastDirection; f.router.action = 'BUY_DOWN';
    f.state.markets[f.snapshot.market.slug].payout = [0, 1];
    assert.equal(inference(f).directionalDecisionAccuracy.denominator, 1);
    assert.equal(inference(f).directionalForecastAccuracy.denominator, 0);
    assert.equal(inference(f).forecastCoverage.unknown, 1);
});

test('offered prompt remains required when provider request is withheld', () => {
    const f = fixture(); Object.assign(f.router, { status: 'arm_stopped', requestSubmitted: false, inferenceAttempted: false });
    delete f.router.providerPromptHash; delete f.router.providerTask; delete f.router.providerPromptVersion;
    assert.equal(report(f).comparability.status, 'verified');
    delete f.router.offeredProviderPromptHash;
    assert.equal(report(f).comparability.reasons['router-premarket_offered_provider_prompt_unverified'], 1);
});

test('directional markdown discloses different tasks and forecasts on SKIP without profit claims', t => {
    const f = fixture(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directional-report-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    savePremarketPaperReport({ ...f.config, dataDir }, f.state, NOW);
    const text = fs.readFileSync(path.join(dataDir, f.config.id, 'reports/latest.md'), 'utf8');
    assert.match(text, /prompt dan tugas provider berbeda/);
    assert.match(text, /termasuk 1 keputusan SKIP/);
    assert.match(text, /bukan probabilitas terkalibrasi atau bukti expected profit/);
    assert.match(text, /Hash prompt GPT aktual: [a-f0-9]{64}/);
});

test('new policy and old next period remain separately readable without pooling forecasts', t => {
    const f = fixture(), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directional-history-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const old = fixture(); old.config.id = old.state.id = 'legacy-next'; delete old.config.routerPolicy;
    delete old.router.forecastDirection; delete old.router.forecastStrength;
    for (const [policy, state] of [[f.config, f.state], [old.config, old.state]]) {
        const directory = path.join(dataDir, policy.id); fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ id: policy.id, paperOnly: true, policy }));
        fs.writeFileSync(path.join(directory, 'ledger.json'), JSON.stringify(state));
    }
    fs.writeFileSync(path.join(dataDir, 'active.json'), JSON.stringify({ id: f.config.id, paperOnly: true }));
    fs.writeFileSync(path.join(dataDir, 'history.json'), JSON.stringify({ periods: [
        { id: old.config.id, dataDir, archivedAt: AT + 600000 } ] }));
    const summary = readPremarketPaperReports({ dataDir }, true);
    assert.equal(summary.history.length, 1);
    assert.equal(summary.history[0].routerPolicy, undefined);
    assert.equal(summary.history[0].comparability.status, 'verified');
    assert.equal(summary.history[0].arms['router-premarket'].inference.forecastCoverage.unknown, 1);
    assert.equal(summary.arms['router-premarket'].inference.directionalForecastAccuracy.denominator, 1);
    assert.equal(summary.commonCohort.enrolledMarkets, 1);
    assert.equal(summary.comparability.historicalPeriodsPooled, false);
});

test('report cannot accept unsupported router policies or attach directional policy to another profile', () => {
    const f = fixture(); f.config.routerPolicy = 'unknown';
    assert.throws(() => report(f), /report_identity_mismatch/);
    f.config.routerPolicy = NEXT_ROUTER_DIRECTIONAL_POLICY; f.config.profile = 'legacy-three-candles-v1';
    assert.throws(() => report(f), /report_identity_mismatch/);
});
