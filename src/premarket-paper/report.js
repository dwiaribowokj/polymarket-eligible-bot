import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';
import { EARLY_PROFILE, NEXT_PROFILE, isCandleProfile, buildEarlyPremarketInput, earlyReversalDecision } from './early-context.js';
import { validatedEarlyPaperBooks } from './early-book.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY, routerDirectionalPolicy, routerDirectionalPromptEvidence } from './router-directional.js';

const ARMS = ['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket'];
const CONTROL = 'late-cost-cap';
const ACTIONS = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
const MODEL_REASONS = new Set(['positive_edge', 'no_positive_edge', 'insufficient_predictive_evidence',
    'conflicting_signals', 'no_allowed_buy', 'direction_matches_signal', 'direction_opposes_signal']);
const EXPERIMENT = 'premarket-three-candles-paper-v1';
const INFERENCE = 'independent-laya-router-frozen-forecast-30s';
const FAIR_INFERENCE = 'shared-compact-30m-evidence-independent-laya-router-30s-v1';
const EARLY_INFERENCE = 'shared-compact-150m-binance-evidence-independent-laya-router-30s-v1';
const NEXT_INFERENCE = 'shared-compact-150m-next-candle-confirmation-laya-router-30s-v1';
const LEGACY_PROFILE = 'legacy-three-candles-v1';
const NEAR_OPEN_PROFILE = 'near-open-30m-v1';
const FAIR_PROFILE = 'fair-near-open-30m-v1';
const FAIR_ARMS = ['premarket-momentum', 'laya-premarket', 'router-premarket'];
const DAY = 86400000, WIB = 7 * 3600000;
const finite = Number.isFinite;
const timestamp = value => typeof value === 'number' && finite(value) ? value
    : typeof value === 'string' && value.trim() && finite(Date.parse(value)) ? Date.parse(value) : null;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const identityError = () => new Error('premarket_paper_report_identity_mismatch');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const sum = values => round(values.reduce((total, value) => total + value, 0));
const mean = values => values.length ? round(sum(values) / values.length) : null;
const counts = values => values.reduce((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});
const sameArms = names => Array.isArray(names) && names.length === ARMS.length && ARMS.every(name => names.includes(name));
const activeArmsOf = config => config.activeArms ?? ARMS;
const profileOf = config => config.profile ?? LEGACY_PROFILE;
const fairProfile = config => profileOf(config) === FAIR_PROFILE || isCandleProfile(config);
const controlOf = config => fairProfile(config) ? 'premarket-momentum' : CONTROL;
const boundedEarlyExecution = config => isCandleProfile(config)
    && config.earlyExecution?.version === 'bounded-shared-rest-fak-v1';
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const modelReason = row => MODEL_REASONS.has(row.reasonCode) ? row.reasonCode : 'unknown';
const forecastDirection = row => ['UP', 'DOWN', 'NEUTRAL'].includes(row.forecastDirection) ? row.forecastDirection : 'unknown';
const forecastStrength = row => ['weak', 'moderate', 'strong'].includes(row.forecastStrength) ? row.forecastStrength : 'unknown';
const providerPromptEvidence = row => Object.fromEntries(['providerTask', 'providerPromptVersion', 'providerPromptHash']
    .map(field => [field, row?.[field] ?? null]));
const promptMatches = (row, expected, offered = false) => Object.entries(expected)
    .every(([field, value]) => row?.[offered ? `offered${field[0].toUpperCase()}${field.slice(1)}` : field] === value);
const decisionDiagnostics = (row, directional = false) => ({ reasonCode: modelReason(row),
    rationale: typeof row.rationale === 'string' ? row.rationale.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : null,
    estimatedUpProbability: finite(row.estimatedUpProbability) && row.estimatedUpProbability >= 0
        && row.estimatedUpProbability <= 1 ? row.estimatedUpProbability : null,
    estimatedUpProbabilityType: directional ? 'directional_not_calibrated' : 'self_reported_uncalibrated_market_probability',
    estimatedProbabilityCalibrated: false,
    forecastDirection: forecastDirection(row),
    ...(directional ? { forecastStrength: forecastStrength(row), forecastStrengthType: 'directional_not_calibrated',
        ...providerPromptEvidence(row),
        expectedProfitClaimed: false, calibratedProbabilityClaimed: false } : {}),
    expectedNetUsd: row.expectedNetUsd && typeof row.expectedNetUsd === 'object'
        ? Object.fromEntries(ACTIONS.slice(0, 2).map(action => [action, finite(row.expectedNetUsd[action])
            ? row.expectedNetUsd[action] : null])) : null });
const slugOf = row => row.slug || (typeof row.market === 'string' ? row.market : row.market?.slug);
const sideIndex = side => side === 0 || ['UP', 'BUY_UP'].includes(String(side).toUpperCase()) ? 0
    : side === 1 || ['DOWN', 'BUY_DOWN'].includes(String(side).toUpperCase()) ? 1 : null;
const validPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(value => finite(value) && value >= 0 && value <= 1)
    && Math.abs(payout[0] + payout[1] - 1) < 0.00001;
const labeled = (market, now) => finite(market.end) && market.end <= now && validPayout(market.payout)
    && (!finite(market.labelResolvedAt) || market.labelResolvedAt <= now);

function directionalContractValid(row, allowed) {
    if (!['UP', 'DOWN'].includes(row.forecastDirection) || forecastStrength(row) === 'unknown'
        || !Array.isArray(allowed) || !allowed.includes('SKIP')) return false;
    const directionAction = `BUY_${row.forecastDirection}`, buyAllowed = allowed.some(action => action !== 'SKIP');
    const action = allowed.includes(directionAction) ? directionAction : 'SKIP';
    const reason = !buyAllowed ? 'no_allowed_buy' : action === 'SKIP' ? 'direction_opposes_signal' : 'direction_matches_signal';
    return row.action === action && row.reasonCode === reason;
}

function policyOf(config) { return { ...(config.policy || {}), ...config }; }
function validatePolicy(config) {
    const active = activeArmsOf(config);
    const next = profileOf(config) === NEXT_PROFILE;
    if (config.routerPolicy !== undefined && (config.routerPolicy !== NEXT_ROUTER_DIRECTIONAL_POLICY || !next))
        throw identityError();
    const expectedInference = next ? NEXT_INFERENCE : profileOf(config) === EARLY_PROFILE ? EARLY_INFERENCE
        : profileOf(config) === FAIR_PROFILE ? FAIR_INFERENCE : INFERENCE;
    if (config.experiment !== EXPERIMENT || config.inferencePolicy !== expectedInference || !sameArms(config.armNames)
        || ![LEGACY_PROFILE, NEAR_OPEN_PROFILE, FAIR_PROFILE, EARLY_PROFILE, NEXT_PROFILE].includes(profileOf(config))
        || !finite(config.capital) || config.capital <= 0 || !finite(config.shares) || config.shares <= 0
        || !Array.isArray(active) || !active.length || new Set(active).size !== active.length
        || active.some(name => !ARMS.includes(name)))
        throw identityError();
    if (fairProfile(config) && (active.length !== FAIR_ARMS.length
        || FAIR_ARMS.some(name => !active.includes(name)))) throw identityError();
    if (isCandleProfile(config) && (config.leadSeconds !== (next ? -5 : 540) || config.candleCount !== 30
        || config.candleIntervalMs !== 300000 || config.historyMs !== 9000000)) throw identityError();
    if (next && (config.rolePolicy !== 'streak-signal-confirmation-or-skip-v1'
        || config.controlPolicy !== 'next-candle-streak-reversal-with-ai-confirmation-filters'
        || config.slotToleranceMs !== 10000 || config.aiDecisionMs !== 30000 || config.entryEndOffsetMs !== 90000
        || config.earlyExecution?.retryWindowMs !== 30000 || config.earlyExecution?.retryMs !== 1000)) throw identityError();
    if (isCandleProfile(config) && (next || config.bookPolicy || config.earlyExecution)) {
        const book = config.bookPolicy, execution = config.earlyExecution;
        if (!boundedEarlyExecution(config) || book?.schema !== 'early-paper-rest-current-depth-v1'
            || book.paperOnly !== true || !safeTime(execution.retryWindowMs) || execution.retryWindowMs < 1
            || !safeTime(execution.retryMs) || execution.retryMs < 1 || execution.retryMs > execution.retryWindowMs
            || !safeTime(config.slotToleranceMs) || !safeTime(config.aiDecisionMs)
            || ['maxRoundTripMs', 'maxVerificationAgeMs', 'maxMetadataAgeMs', 'maxHttpDateAgeMs']
                .some(key => !safeTime(book[key]) || book[key] < 1)) throw identityError();
    }
}

function historyRequirements(config) {
    if (isCandleProfile(config)) return { candleCount: 30, candleIntervalMs: 300000,
        historyMs: 9000000, diagnosticHistoryMs: 9000000, grouped5mCandleCount: 0, native5mCandleCount: 30,
        uninterruptedLiveWarmupRequired: false, historicalBackfillAllowed: true, startupAndGapWarmupMs: 0,
        returnWindowsSeconds: [300, 900, 1800, 3600, 9000], source: 'binance_spot', symbol: 'BTCUSDT',
        cacheMaxAgeMs: config.candleCacheMaxAgeMs ?? config.historyMaxAgeMs ?? 90000,
        outcomeSource: 'official_ctf_payout', silentInputTruncationAllowed: false };
    const nearOpen = [NEAR_OPEN_PROFILE, FAIR_PROFILE].includes(profileOf(config));
    return { candleCount: config.candleCount ?? (nearOpen ? 30 : 3), candleIntervalMs: config.candleIntervalMs ?? 60000,
        historyMs: config.historyMs ?? (nearOpen ? 1800000 : 180000),
        diagnosticHistoryMs: config.diagnosticHistoryMs ?? (nearOpen ? 1800000 : 900000),
        grouped5mCandleCount: nearOpen ? 6 : 0,
        uninterruptedLiveWarmupRequired: nearOpen, historicalBackfillAllowed: nearOpen ? false : null,
        startupAndGapWarmupMs: config.historyMs ?? (nearOpen ? 1800000 : 180000),
        returnWindowsSeconds: nearOpen ? [30, 60, 180, 300, 900, 1800] : [],
        source: 'chainlink_btc_usd', silentInputTruncationAllowed: false };
}

function contextCoverage(snapshot) {
    const features = snapshot.features, bars = features?.bars, context = features?.context;
    if (!Array.isArray(bars) && !context) return null;
    const start = timestamp(context?.historyStartAt ?? bars?.[0]?.start);
    const end = timestamp(context?.historyEndAt ?? bars?.at(-1)?.end);
    if ([EARLY_PROFILE, NEXT_PROFILE].includes(context?.schema)) return {
        basis: 'recorded_frozen_snapshot_features', schema: context.schema, source: context.source, symbol: context.symbol,
        completed1mCandles: 0, grouped5mCandles: 0, native5mCandles: Array.isArray(bars) ? bars.length : null,
        candleIntervalMs: context.candleIntervalMs, historyStartAt: start, historyEndAt: end,
        historyMs: finite(start) && finite(end) && end >= start ? end - start : null,
        availableReturnWindows: ['m5', 'm15', 'm30', 'm60', 'm150'].filter(name => finite(context.returnsUsd?.[name])) };
    return { basis: 'recorded_frozen_snapshot_features', schema: context?.schema ?? null, source: context?.source ?? null,
        completed1mCandles: Array.isArray(bars) ? bars.length : null,
        grouped5mCandles: Array.isArray(context?.bars5m) ? context.bars5m.length : null,
        historyStartAt: start, historyEndAt: end, historyMs: finite(start) && finite(end) && end >= start ? end - start : null,
        availableReturnWindows: ['s30', 's60', 'm3', 'm5', 'm15', 'm30'].filter(name => finite(context?.returnsUsd?.[name])) };
}

function inputCoverage(row) {
    if (!row.inputCoverage || typeof row.inputCoverage !== 'object') return null;
    const coverage = row.inputCoverage, count = key => Number.isInteger(coverage[key]) && coverage[key] >= 0 ? coverage[key] : null;
    return { source: ['chainlink_btc_usd', 'binance_spot'].includes(coverage.source) ? coverage.source : null,
        completeMinutes: count('completeMinutes'), minuteBars: count('minuteBars'), fiveMinuteGroups: count('fiveMinuteGroups'),
        historyStartAt: timestamp(coverage.historyStartAt), historyEndAt: timestamp(coverage.historyEndAt),
        decisionAt: timestamp(coverage.decisionAt), truncated: typeof coverage.truncated === 'boolean' ? coverage.truncated : null,
        ...(coverage.source === 'binance_spot' ? { symbol: coverage.symbol, fiveMinuteBars: count('fiveMinuteBars'),
            candleIntervalMs: count('candleIntervalMs'), observedAt: timestamp(coverage.observedAt),
            fetchedAt: timestamp(coverage.fetchedAt), marketOpenAt: timestamp(coverage.marketOpenAt),
            marketEndAt: timestamp(coverage.marketEndAt) } : {}),
        ...(coverage.encoding ? { encoding: coverage.encoding, fiveMinuteGroupsDerived: coverage.fiveMinuteGroupsDerived === true,
            bookLevelsUpDown: coverage.bookLevelsUpDown ?? null, quantization: coverage.quantization ?? null } : {}),
        ...(coverage.confirmationOnly !== undefined ? { confirmationOnly: coverage.confirmationOnly === true,
            signalAction: coverage.signalAction ?? null, priorStreak: coverage.priorStreak ?? null } : {}) };
}

function earlyExecutionBookVerified(evidence, execution, snapshot, at, bookHash, config) {
    if (!snapshot?.market || !execution) return false;
    if (!evidence || !validHash(evidence.booksHash) || evidence.booksHash !== bookHash
        || !safeTime(evidence.startedAt) || evidence.startedAt < execution.activeAt
        || !safeTime(evidence.deadlineAt) || evidence.deadlineAt > execution.deadlineAt
        || !Array.isArray(evidence.books) || evidence.books.length !== 2
        || evidence.books.some(row => !safeTime(row?.deadlineAt) || row.deadlineAt > execution.deadlineAt
            || !safeTime(row.tickVerification?.deadlineAt) || row.tickVerification.deadlineAt > execution.deadlineAt))
        return false;
    try {
        validatedEarlyPaperBooks(snapshot.market, { books: execution.executionBooks, evidence }, at, config.bookPolicy);
        return true;
    } catch { return false; }
}

function earlyCaptureBookVerified(snapshot, config) {
    if (!snapshot?.bookEvidence || !safeTime(snapshot.bookEvidence.deadlineAt)
        || snapshot.bookEvidence.deadlineAt > snapshot.scheduledAt + config.slotToleranceMs) return false;
    try {
        validatedEarlyPaperBooks(snapshot.market, { books: snapshot.books, evidence: snapshot.bookEvidence },
            snapshot.at, config.bookPolicy);
        return true;
    } catch { return false; }
}

function fairComparability(state, markets, paired, results, config) {
    const early = isCandleProfile(config), next = profileOf(config) === NEXT_PROFILE;
    const directional = routerDirectionalPolicy(config), routerPrompt = routerDirectionalPromptEvidence(config);
    const rows = Object.keys(markets).map(slug => {
        const snapshots = (state.snapshots || []).filter(snapshot => slugOf(snapshot) === slug);
        const slot = state.slots?.[`${slug}:premarket`];
        const uniformSkip = snapshots.length === 0 && slot?.status === 'skipped'
            && typeof slot.reason === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(slot.reason)
            && slot.scheduledAt === markets[slug].open - (next ? -5000 : early ? 540000 : 60000) && FAIR_ARMS.every(name => {
                const outcome = state.arms[name].outcomes?.[slug], result = results[name].get(slug);
                return result && !result.pending && !result.filled && outcome?.noExposure === true && outcome.pnl === 0
                    && (outcome.reason === 'observation_failed' && outcome.code === slot.reason
                        || outcome.reason === 'entry_cutoff' && outcome.code === slot.reason
                        || outcome.reason === 'slot_missed' && slot.reason === 'slot_missed');
            });
        if (uniformSkip) return { slug, snapshotId: null, status: 'verified_shared_skip', reasons: [],
            uniformSkipReason: slot.reason, scheduledAt: slot.scheduledAt,
            commonInputHash: null, inputCoverage: null, contextCoverage: null,
            contextTokens: null, contextIdentity: null, contextVerified: false, semanticPromptHash: null,
            arms: Object.fromEntries(FAIR_ARMS.map(name => [name, { inputOfferedHash: null, inputSubmittedHash: null,
                inputUse: 'not_generated_uniform_skip', status: state.arms[name].outcomes[slug].reason,
                action: 'SKIP', requestSubmitted: false, offeredInputCoverage: null, inputCoverage: null }])),
            decisionCutoffAt: null, execution: null, filledExecution: [] };
        const snapshot = snapshots.length === 1 ? snapshots[0] : null, common = snapshot?.commonInput;
        const coverage = inputCoverage(common || {}), reasons = [];
        if (!snapshot) reasons.push(snapshots.length ? 'ambiguous_frozen_snapshot' : 'frozen_snapshot_missing');
        if (!validHash(common?.inputHash) || typeof common?.input !== 'string'
            || crypto.createHash('sha256').update(common.input).digest('hex') !== common.inputHash)
            reasons.push('common_input_hash_unverified');
        if (early ? !coverage || coverage.source !== 'binance_spot' || coverage.symbol !== 'BTCUSDT'
            || coverage.completeMinutes !== 150 || coverage.minuteBars !== 0 || coverage.fiveMinuteBars !== 30
            || coverage.fiveMinuteGroups !== 0 || coverage.fiveMinuteGroupsDerived !== false
            || coverage.candleIntervalMs !== 300000 || coverage.truncated !== false
            || coverage.historyEndAt - coverage.historyStartAt !== 9000000
            || coverage.historyEndAt !== Math.floor(coverage.decisionAt / 300000) * 300000
            || coverage.decisionAt !== snapshot?.scheduledAt || coverage.marketOpenAt !== markets[slug].open
            || coverage.marketEndAt !== markets[slug].end || coverage.marketOpenAt - coverage.decisionAt !== (next ? -5000 : 540000)
            || next && (coverage.historyEndAt !== coverage.marketOpenAt || coverage.marketEndAt !== coverage.marketOpenAt + 300000)
            || !finite(coverage.observedAt) || coverage.observedAt > coverage.decisionAt
            || coverage.observedAt < coverage.historyEndAt
            || coverage.fetchedAt !== null && (!finite(coverage.fetchedAt) || coverage.fetchedAt > coverage.decisionAt)
            || coverage.decisionAt - coverage.observedAt > (config.candleCacheMaxAgeMs ?? config.historyMaxAgeMs ?? 90000)
            || coverage.quantization?.ohlc !== 'nearest_USD_0.01'
            : !coverage || coverage.source !== 'chainlink_btc_usd' || coverage.completeMinutes !== 30
            || coverage.minuteBars !== 30 || coverage.fiveMinuteGroups !== 6 || coverage.fiveMinuteGroupsDerived !== true
            || coverage.truncated !== false || coverage.historyEndAt - coverage.historyStartAt !== 1800000
            || coverage.decisionAt !== snapshot?.scheduledAt || coverage.historyEndAt > coverage.decisionAt
            || coverage.quantization?.ohlc !== 'nearest_USD_0.01') reasons.push('full_common_history_unverified');
        const observed = snapshot ? contextCoverage(snapshot) : null;
        if (early ? !observed || observed.schema !== profileOf(config)
            || observed.source !== 'binance_spot' || observed.symbol !== 'BTCUSDT'
            || observed.native5mCandles !== 30 || observed.candleIntervalMs !== 300000 || observed.historyMs !== 9000000
            || observed.historyStartAt !== coverage?.historyStartAt || observed.historyEndAt !== coverage?.historyEndAt
            || observed.availableReturnWindows.length !== 5
            : !observed || observed.completed1mCandles !== 30 || observed.grouped5mCandles !== 6
                || observed.historyMs !== 1800000) reasons.push('frozen_history_coverage_unverified');
        if (common?.contextVerified !== true || !Number.isInteger(common?.contextTokens)
            || common.contextTokens < 1 || common.contextTokens > 1024 || !validHash(common?.contextIdentity)
            || !validHash(common?.semanticPromptHash)) reasons.push('actual_laya_context_unverified');
        let confirmation = null;
        if (next) {
            try {
                // Rebuild the offered input from the frozen candles and quotes to verify the action gate.
                const replay = buildEarlyPremarketInput(snapshot, config);
                const signal = earlyReversalDecision(replay.context, config.signalParameters);
                confirmation = { rolePolicy: config.rolePolicy, signal, allowedActions: replay.allowed,
                    openingTwap: snapshot.features.openingTwap, confirmationOnly: true };
                if (replay.input !== common?.input || replay.inputHash !== common?.inputHash
                    || JSON.stringify(replay.context) !== JSON.stringify(common?.context)
                    || JSON.stringify(replay.allowed) !== JSON.stringify(common?.allowed)
                    || JSON.stringify(inputCoverage(replay)) !== JSON.stringify(coverage))
                    reasons.push('next_confirmation_input_unverified');
                const control = snapshot.decisions?.['premarket-momentum'];
                if (control?.status === 'ok' && control.action !== signal.action
                    || FAIR_ARMS.slice(1).some(name => snapshot.decisions?.[name]?.status === 'ok'
                        && !replay.allowed.includes(snapshot.decisions[name].action)))
                    reasons.push('next_confirmation_action_unverified');
            } catch { reasons.push('next_confirmation_input_unverified'); }
        }
        const arms = Object.fromEntries(FAIR_ARMS.map(name => {
            const decision = snapshot?.decisions?.[name], provider = name !== 'premarket-momentum';
            const offeredHash = provider ? decision?.offeredInputHash : decision?.inputHash;
            const offeredCoverage = provider ? inputCoverage({ inputCoverage: decision?.offeredInputCoverage })
                : inputCoverage(decision || {});
            if (!validHash(offeredHash) || offeredHash !== common?.inputHash)
                reasons.push(`${name}_offered_input_hash_unverified`);
            if (!offeredCoverage || !coverage || JSON.stringify(offeredCoverage) !== JSON.stringify(coverage))
                reasons.push(`${name}_offered_input_coverage_unverified`);
            if (provider && decision?.offeredSemanticPromptHash !== common?.semanticPromptHash)
                reasons.push(`${name}_offered_semantic_prompt_unverified`);
            if ((!provider || decision?.requestSubmitted === true)
                && (!decision || decision.inputHash !== common?.inputHash || !validHash(decision.inputHash)))
                reasons.push(`${name}_input_hash_unverified`);
            if ((!provider || decision?.requestSubmitted === true)
                && (!decision || !coverage || JSON.stringify(inputCoverage(decision)) !== JSON.stringify(coverage)))
                reasons.push(`${name}_input_coverage_unverified`);
            if (provider && decision?.requestSubmitted === true && decision.semanticPromptHash !== common?.semanticPromptHash)
                reasons.push(`${name}_semantic_prompt_unverified`);
            if (directional && name === 'router-premarket') {
                if (!promptMatches(decision, routerPrompt, true)) reasons.push(`${name}_offered_provider_prompt_unverified`);
                if (decision?.requestSubmitted === true && !promptMatches(decision, routerPrompt))
                    reasons.push(`${name}_provider_prompt_unverified`);
                if (decision?.status === 'ok' && !directionalContractValid(decision, common?.allowed))
                    reasons.push(`${name}_directional_forecast_unverified`);
            }
            return [name, { inputOfferedHash: offeredHash || null,
                inputSubmittedHash: provider && decision?.requestSubmitted === true ? decision.inputHash || null : null,
                inputUse: provider ? decision?.requestSubmitted === true ? 'provider_request_submitted' : 'provider_request_not_submitted'
                    : decision ? 'deterministic_rule_evaluated' : 'not_recorded',
                status: decision?.status ?? null, action: decision?.action ?? null,
                requestSubmitted: provider ? decision?.requestSubmitted === true : null,
                ...(directional && name === 'router-premarket' ? {
                    offeredProviderTask: decision?.offeredProviderTask ?? null,
                    offeredProviderPromptVersion: decision?.offeredProviderPromptVersion ?? null,
                    offeredProviderPromptHash: decision?.offeredProviderPromptHash ?? null,
                    ...providerPromptEvidence(decision) } : {}),
                offeredInputCoverage: offeredCoverage,
                inputCoverage: inputCoverage(decision || {}) }];
        }));
        const execution = snapshot?.fairExecution;
        const uniformEarlyCancellation = execution?.status === 'skipped'
            && ['entry_cutoff', 'shutdown_pending_cancelled', 'restart_during_fair_decision'].includes(execution.reason)
            && finite(execution.adjudicatedAt) && execution.adjudicatedAt >= snapshot?.scheduledAt
            && execution.adjudicatedAt < snapshot?.decisionCutoffAt && FAIR_ARMS.every(name => {
                const outcome = state.arms[name].outcomes?.[slug], result = results[name].get(slug);
                return !state.arms[name].positions?.[slug] && result && !result.pending && !result.filled
                    && outcome?.noExposure === true && outcome.pnl === 0;
            });
        if (!snapshot || snapshot.decisionCutoffAt !== snapshot.aiDeadlineAt
            || snapshot.decisionCutoffAt !== execution?.scheduledAt
            || !finite(snapshot.decisionCutoffAt) || !finite(execution?.adjudicatedAt)
            || (execution.adjudicatedAt < snapshot.decisionCutoffAt && !uniformEarlyCancellation)
            || !['reserved', 'skipped'].includes(execution.status)) reasons.push('common_execution_cutoff_unverified');
        if (execution?.status === 'reserved' && (!validHash(execution.validationBookHash)
            || !finite(execution.validatedAt) || !finite(execution.submittedAt) || !finite(execution.activeAt)
            || execution.submittedAt < execution.validatedAt || execution.activeAt < execution.submittedAt + 250))
            reasons.push('shared_execution_book_unverified');
        if (execution?.status === 'skipped' && !execution.reason) reasons.push('common_execution_skip_reason_missing');
        const fills = FAIR_ARMS.flatMap(name => {
            const result = results[name].get(slug);
            return result?.filled ? [{ arm: name, submittedAt: result.row.openedAt ?? null,
                executionAt: result.row.executionAt ?? null, executionBookHash: result.row.executionBookHash ?? null,
                ...(boundedEarlyExecution(config) ? { side: result.row.side, orderLimit: result.row.orderLimit ?? null,
                    executionEvidence: result.row.executionEvidence ?? null } : {}) }] : [];
        });
        if (fills.length && (execution?.status !== 'reserved' || fills.some(fill => !validHash(fill.executionBookHash)
            || fill.submittedAt !== execution.submittedAt || !finite(fill.executionAt)
            || fill.executionAt < execution.activeAt)
            || new Set(fills.map(fill => fill.executionBookHash)).size !== 1
            || new Set(fills.map(fill => fill.executionAt)).size !== 1)) reasons.push('filled_execution_comparability_unverified');
        if (boundedEarlyExecution(config)) {
            const prefix = next ? 'next' : 'early';
            const deadline = Math.min(snapshot?.decisionCutoffAt + config.earlyExecution.retryWindowMs,
                markets[slug].open + (next ? 90000 : -1000));
            if (!safeTime(snapshot?.at) || snapshot.at < snapshot.scheduledAt
                || snapshot.at - snapshot.scheduledAt > config.slotToleranceMs
                || snapshot.aiDeadlineAt !== (next ? snapshot.at + config.aiDecisionMs
                    : Math.min(snapshot.at + config.aiDecisionMs, markets[slug].open - (config.latencyMs ?? 250) - 1)))
                reasons.push(`${prefix}_capture_timing_unverified`);
            if (!earlyCaptureBookVerified(snapshot, config)) reasons.push(`${prefix}_capture_book_unverified`);
            if (execution?.deadlineAt !== deadline || execution?.status === 'reserved'
                && (!safeTime(execution.submittedAt) || execution.submittedAt < snapshot.decisionCutoffAt
                    || execution.submittedAt > deadline || execution.activeAt > deadline)
                || fills.some(fill => !safeTime(fill.executionAt) || fill.executionAt > deadline
                    || (next ? fill.executionAt >= deadline || fill.executionAt >= markets[slug].end
                        : fill.executionAt >= markets[slug].open))) reasons.push(`${prefix}_execution_window_unverified`);
            const attempts = execution?.attempts;
            if (!Array.isArray(attempts) || attempts.length > Math.floor(config.earlyExecution.retryWindowMs / config.earlyExecution.retryMs) + 1
                || attempts.some((attempt, index) => !safeTime(attempt?.startedAt) || !safeTime(attempt.finishedAt)
                    || attempt.startedAt < snapshot?.decisionCutoffAt || attempt.startedAt > deadline
                    || attempt.finishedAt < attempt.startedAt || !['failed', 'verified'].includes(attempt.status)
                    || attempt.status === 'verified' && (attempt.finishedAt > deadline || index !== attempts.length - 1)
                    || index > 0 && attempt.startedAt < attempts[index - 1].finishedAt + config.earlyExecution.retryMs)
                || execution?.status === 'reserved' && (attempts.at(-1)?.status !== 'verified'
                    || attempts.at(-1).finishedAt > execution.submittedAt)) reasons.push(`${prefix}_execution_attempts_unverified`);
            if (fills.some(fill => {
                const action = ACTIONS[sideIndex(fill.side)], order = snapshot?.orders?.[action];
                const decision = snapshot?.decisions?.[fill.arm];
                return !order || !finite(fill.orderLimit) || fill.orderLimit !== order.price
                    || decision?.status !== 'ok' || decision.action !== action
                    || !safeTime(decision.receivedAt) || decision.receivedAt > snapshot.aiDeadlineAt
                    || finite(decision.decisionCompletedAt) && decision.decisionCompletedAt > snapshot.aiDeadlineAt;
            })) reasons.push(`${prefix}_frozen_order_unverified`);
            if (fills.some(fill => !earlyExecutionBookVerified(fill.executionEvidence, execution, snapshot,
                fill.executionAt, fill.executionBookHash, config)
                || fill.executionAt !== execution.executionAt || fill.executionBookHash !== execution.executionBookHash
                || JSON.stringify(fill.executionEvidence) !== JSON.stringify(execution?.executionEvidence)))
                reasons.push(`${prefix}_execution_receipt_unverified`);
        }
        return { slug, snapshotId: snapshot?.snapshotId ?? null,
            status: reasons.length ? 'incomplete' : uniformEarlyCancellation ? 'verified_shared_cancel' : 'verified', reasons,
            uniformCancellationReason: uniformEarlyCancellation ? execution.reason : null,
            commonInputHash: common?.inputHash || null, inputCoverage: coverage, contextCoverage: observed,
            contextTokens: Number.isInteger(common?.contextTokens) ? common.contextTokens : null,
            contextIdentity: common?.contextIdentity ?? null, contextVerified: common?.contextVerified === true,
            semanticPromptHash: common?.semanticPromptHash ?? null, arms,
            ...(next ? { confirmation } : {}),
            decisionCutoffAt: snapshot?.decisionCutoffAt ?? null, execution: execution ?? null, filledExecution: fills };
    });
    const pairedIds = new Set(paired.map(row => row.slug)), eligible = rows.filter(row => pairedIds.has(row.slug));
    const decisions = eligible.filter(row => row.status === 'verified');
    const uniform = eligible.filter(row => row.status === 'verified_shared_skip');
    const cancellations = eligible.filter(row => row.status === 'verified_shared_cancel');
    const verified = [...decisions, ...uniform, ...cancellations];
    return { required: true, status: eligible.length && verified.length === eligible.length ? 'verified' : 'incomplete',
        controlArm: 'premarket-momentum', activeArms: [...FAIR_ARMS],
        basis: 'same_frozen_input_offered_and_common_execution_opportunity_including_provider_failures',
        enrolledMarkets: rows.length, pairedMarkets: eligible.length, verifiedComparableMarkets: decisions.length,
        decisionComparableMarkets: decisions.length, verifiedUniformSkippedMarkets: uniform.length,
        verifiedUniformCancelledMarkets: cancellations.length,
        uniformCancellationReasons: counts(cancellations.map(row => row.uniformCancellationReason)),
        uniformSkipReasons: counts(uniform.map(row => row.uniformSkipReason)), verifiedCohortMarkets: verified.length,
        incompletePairedMarkets: eligible.length - verified.length, verifiedMarketIds: verified.map(row => row.slug),
        reasons: counts(eligible.flatMap(row => row.reasons)),
        noPairedMarkets: eligible.length === 0, providerSubmissionIsNotAssumed: true,
        ...(directional ? { routerPolicy: config.routerPolicy, sameFrozenInput: true, differentProviderPrompts: true,
            comparisonMeaning: 'same_features_and_execution_with_different_provider_tasks_and_prompts' } : {}),
        historicalPeriodsPooled: false, rows };
}

function unavailableEvidence(config, elapsedDays, filledCounts) {
    return { ...dailyEvidence([], config, elapsedDays, filledCounts), available: false, reason: 'arm_not_selected',
        sufficientSample: false, reasons: ['arm_not_selected'] };
}

function evidencePeriod(state, now) {
    const entryCutoffAt = timestamp(state.entryCutoffAt), archivedAt = timestamp(state.archivedAt);
    const elapsedThroughAt = Math.min(now, ...[entryCutoffAt, archivedAt].filter(finite));
    return { entryCutoffAt, archivedAt, elapsedThroughAt,
        elapsedDays: Math.max(0, elapsedThroughAt - state.startedAt) / DAY };
}

function dailyEvidence(rows, config, elapsedDays, filledCounts) {
    const minDays = config.minDays ?? 7, minFilled = config.minMarkets ?? 100;
    const samples = config.bootstrapSamples ?? 10000;
    // Group by the scheduled market end, so delayed labels cannot move paired observations between days.
    const shifted = rows.map(row => ({ closedAt: row.closedAt + WIB, pnl: row.pnl }));
    const observedDays = new Set(shifted.map(row => new Date(row.closedAt).toISOString().slice(0, 10))).size;
    const ci95 = observedDays >= 2 ? dailyBootstrap(shifted, samples) : null;
    const reasons = [];
    if (elapsedDays < minDays) reasons.push('insufficient_elapsed_days');
    if (observedDays < minDays) reasons.push('insufficient_observed_days');
    if (filledCounts.some(count => count < minFilled)) reasons.push('insufficient_completed_fills');
    return { method: 'daily_block_bootstrap', timezone: 'Asia/Jakarta', dayBasis: 'scheduled_market_end',
        resamplingUnit: 'whole_day_including_all_market_rows', seed: 42, bootstrapSamples: samples,
        markets: rows.length, observedDays, meanPnlPerMarket: mean(rows.map(row => row.pnl)), ci95,
        minimumObservedDaysForInterval: 2, elapsedDays: round(elapsedDays),
        minimumElapsedAndObservedDays: minDays, minimumCompletedFillsPerArm: minFilled,
        completedFillsPerArm: filledCounts, sufficientSample: reasons.length === 0, reasons,
        positiveMeanCiLowerBound: ci95 === null ? null : ci95.lower > 0,
        includesFinalSkipAndNoFill: true, inferenceCostsIncluded: false,
        informationalOnly: true, profitabilityValidated: false, sufficientForLive: false };
}

function completedRows(arm, now) {
    const rows = new Map(), ambiguous = new Set();
    for (const row of arm.completed || []) {
        const slug = slugOf(row);
        if (!slug) continue;
        if (!finite(row.pnl) || !finite(row.shares) || row.shares <= 0 || row.uncertain || row.traded === false
            || !finite(row.closedAt) || row.closedAt > now || sideIndex(row.side) === null) ambiguous.add(slug);
        else if (rows.has(slug) && JSON.stringify(rows.get(slug)) !== JSON.stringify(row)) ambiguous.add(slug);
        else rows.set(slug, row);
    }
    for (const slug of ambiguous) rows.delete(slug);
    return { rows, ambiguous };
}

function resultFor(arm, completed, slug, market) {
    if (arm.positions?.[slug]) return { pending: 'open_inventory' };
    if (completed.ambiguous.has(slug)) return { pending: 'ambiguous_completion' };
    const row = completed.rows.get(slug), outcome = arm.outcomes?.[slug];
    if (row) {
        if (outcome?.noExposure || outcome?.uncertain || finite(outcome?.pnl) && Math.abs(outcome.pnl - row.pnl) > 0.00001)
            return { pending: 'outcome_completion_mismatch' };
        if (row.closedAt < market.end) return { pending: 'completion_before_market_end' };
        return { pnl: row.pnl, filled: true, reason: 'settled', row };
    }
    if (outcome?.noExposure === true && outcome.pnl === 0 && !outcome.uncertain)
        return { pnl: 0, filled: false, reason: outcome.reason || 'no_entry' };
    return { pending: outcome?.reason === 'settled' ? 'settled_completion_missing' : 'outcome_pending' };
}

function inferenceSummary(name, state, markets, config, now) {
    const provider = config.providerArms?.[name] || null;
    const directional = provider === 'router' && routerDirectionalPolicy(config);
    const decisions = (state.snapshots || []).flatMap(snapshot => {
        const decision = snapshot.decisions?.[name];
        return decision ? [{ ...decision, market: slugOf(snapshot), snapshotId: snapshot.snapshotId || null,
            scheduledAt: snapshot.scheduledAt, observedAt: snapshot.observedAt,
            allowedActions: snapshot.commonInput?.allowed, commonInputHash: snapshot.commonInput?.inputHash,
            commonSemanticPromptHash: snapshot.commonInput?.semanticPromptHash,
            contextCoverage: contextCoverage(snapshot),
            decisionDeadlineAt: decision.decisionDeadlineAt ?? snapshot.aiDeadlineAt }] : [];
    });
    const requests = provider ? decisions.filter(row => row.inferenceAttempted === true || row.requestSubmitted === true) : [];
    const known = requests.filter(row => finite(row.cost) && row.cost >= 0);
    const latency = requests.map(row => row.actualLatencyMs ?? row.latencyMs).filter(value => finite(value) && value >= 0);
    const valid = decisions.filter(row => row.status === 'ok' && ACTIONS.includes(row.action));
    const modelSkips = provider ? valid.filter(row => row.action === 'SKIP') : [];
    const predictions = new Map();
    for (const row of decisions) {
        const market = markets[row.market], index = sideIndex(row.action);
        if (predictions.has(row.market) || index === null || row.status !== 'ok' || row.timely === false
            || !market || !labeled(market, now) || !finite(row.receivedAt) || row.receivedAt > now
            || finite(row.decisionDeadlineAt) && (row.receivedAt > row.decisionDeadlineAt
                || finite(row.decisionCompletedAt) && row.decisionCompletedAt > row.decisionDeadlineAt)) continue;
        predictions.set(row.market, market.payout[index]);
    }
    const values = [...predictions.values()], correct = values.filter(value => value === 1).length;
    const incorrect = values.filter(value => value === 0).length;
    const forecasts = provider ? forecastSummary(decisions, markets, config, directional, now) : {};
    return { provider, requests: requests.length, submittedRequests: requests.filter(row => row.requestSubmitted === true).length,
        pending: decisions.filter(row => ['pending', 'requested', 'running'].includes(row.status)).length,
        statuses: counts(decisions.map(row => row.status || 'unknown')), knownCost: sum(known.map(row => row.cost)),
        requestStatuses: counts(requests.map(row => row.status || 'unknown')),
        validResponses: valid.length,
        validActionCounts: { BUY_UP: 0, BUY_DOWN: 0, SKIP: 0, ...counts(valid.map(row => row.action)) },
        forecastDirectionCounts: counts(valid.map(forecastDirection)),
        ...(directional ? { forecastStrengthCounts: counts(valid.map(forecastStrength)),
            routerPolicy: config.routerPolicy, expectedProviderPrompt: routerDirectionalPromptEvidence(config),
            forecastPolicy: 'directional_forecast_first_then_signal_confirmation_without_probability_or_expected_profit_claim' } : {}),
        ...forecasts,
        modelSkips: modelSkips.length, modelSkipReasons: counts(modelSkips.map(modelReason)),
        entryDispositions: counts(decisions.map(row => row.entryDisposition || 'unknown')),
        unknownCostRequests: requests.length - known.length, costComplete: requests.length === known.length,
        totalCost: requests.length === known.length ? sum(known.map(row => row.cost)) : null,
        actualModels: [...new Set(requests.map(row => row.model || row.actualModel).filter(Boolean))],
        requestedModels: [...new Set(requests.map(row => row.requestedModel).filter(Boolean))],
        computeCost: null, computeCostIncluded: false,
        meanLatencyMs: mean(latency), latencySamples: latency.length,
        requestsEvidence: requests.map(row => ({ snapshotId: row.snapshotId, market: row.market,
            scheduledAt: row.scheduledAt, observedAt: row.observedAt, startedAt: row.startedAt,
            receivedAt: row.receivedAt ?? null, decisionDeadlineAt: row.decisionDeadlineAt ?? null,
            status: row.status, action: row.action, model: row.model || null,
            contextCoverage: row.contextCoverage, inputHash: row.inputHash || null,
            inputCoverage: inputCoverage(row), inputBytes: Number.isInteger(row.inputBytes) && row.inputBytes > 0 ? row.inputBytes : null,
            ...(fairProfile(config) ? { contextTokens: Number.isInteger(row.contextTokens) ? row.contextTokens : null,
                contextIdentity: row.contextIdentity ?? null, contextVerified: row.contextVerified === true,
                semanticPromptHash: row.semanticPromptHash ?? null } : {}),
            entryDisposition: row.entryDisposition || null, providerErrorReason: row.status !== 'ok' ? row.reason || null : null,
            ...decisionDiagnostics(row, directional),
            requestSubmitted: row.requestSubmitted === true, cost: finite(row.cost) ? row.cost : null,
            costBasis: row.costBasis || null })),
        directionalDecisionAccuracy: { correct, incorrect, neutral: values.length - correct - incorrect,
            denominator: correct + incorrect, rate: correct + incorrect ? round(correct / (correct + incorrect)) : null,
            basis: 'timely_valid_buy_decisions_with_official_binary_labels_regardless_of_fill' } };
}

function forecastSummary(decisions, markets, config, directional, now) {
    const recordedMarkets = new Set(decisions.map(row => row.market));
    const coverage = { enrolledMarkets: Object.keys(markets).length, recordedDecisions: decisions.length,
        withoutRecordedDecision: Object.keys(markets).filter(slug => !recordedMarkets.has(slug)).length,
        withheld: 0, pending: 0, invalid: 0, unknown: 0,
        late: 0, neutral: 0, timelyDirectional: 0, pendingLabels: 0, duplicateMarkets: 0,
        basis: 'recorded_provider_decisions_including_skip_with_missing_historical_forecasts_unknown' };
    const predictions = new Map(), directions = [], strengths = [], expected = routerDirectionalPromptEvidence(config);
    for (const row of decisions) {
        if (!row.requestSubmitted && !row.inferenceAttempted) { coverage.withheld++; continue; }
        if (['pending', 'requested', 'running'].includes(row.status)) { coverage.pending++; continue; }
        if (row.status !== 'ok' || !ACTIONS.includes(row.action)) { coverage.invalid++; continue; }
        const direction = forecastDirection(row);
        if (direction === 'unknown') { coverage.unknown++; continue; }
        if (directional && (!directionalContractValid(row, row.allowedActions) || row.requestSubmitted !== true
            || !promptMatches(row, expected) || !promptMatches(row, expected, true)
            || !validHash(row.inputHash) || row.inputHash !== row.commonInputHash
            || row.offeredInputHash !== row.commonInputHash
            || row.semanticPromptHash !== row.commonSemanticPromptHash
            || row.offeredSemanticPromptHash !== row.commonSemanticPromptHash)) { coverage.invalid++; continue; }
        if (!finite(row.receivedAt) || !finite(row.decisionDeadlineAt)) { coverage.unknown++; continue; }
        if (row.timely === false || row.receivedAt > now || row.receivedAt > row.decisionDeadlineAt
            || finite(row.decisionCompletedAt) && (row.decisionCompletedAt > row.decisionDeadlineAt || row.decisionCompletedAt > now)) {
            coverage.late++; continue;
        }
        if (direction === 'NEUTRAL') { coverage.neutral++; continue; }
        coverage.timelyDirectional++; directions.push(direction); strengths.push(forecastStrength(row));
        const market = markets[row.market];
        if (!market || !labeled(market, now)) { coverage.pendingLabels++; continue; }
        if (predictions.has(row.market)) { coverage.duplicateMarkets++; continue; }
        predictions.set(row.market, { payout: market.payout[sideIndex(direction)], action: row.action });
    }
    const values = [...predictions.values()], correct = values.filter(row => row.payout === 1).length;
    const incorrect = values.filter(row => row.payout === 0).length;
    return { forecastCoverage: coverage,
        timelyForecastDirectionCounts: counts(directions),
        ...(directional ? { timelyForecastStrengthCounts: counts(strengths) } : {}),
        forecastDirectionCountsBasis: 'all_status_ok_action_valid_recorded_responses_including_skip_not_an_accuracy_denominator',
        directionalForecastAccuracy: { correct, incorrect, neutral: values.length - correct - incorrect,
            denominator: correct + incorrect, rate: correct + incorrect ? round(correct / (correct + incorrect)) : null,
            skippedDecisions: values.filter(row => row.action === 'SKIP' && [0, 1].includes(row.payout)).length,
            basis: 'timely_valid_recorded_forecast_directions_with_official_binary_labels_including_skip_regardless_of_fill',
            inferredFromAction: false } };
}

function armSummary(name, arm, results, markets, config, now, state, elapsedDays) {
    const enabled = activeArmsOf(config).includes(name);
    const final = [...results.entries()].filter(([slug, result]) => !result.pending && labeled(markets[slug], now));
    const fills = final.filter(([, result]) => result.filled).map(([, result]) => result.row);
    const wins = fills.filter(row => row.pnl > 0), losses = fills.filter(row => row.pnl < 0);
    const directional = fills.map(row => markets[slugOf(row)].payout[sideIndex(row.side)]);
    const correct = directional.filter(payout => payout === 1).length, incorrect = directional.filter(payout => payout === 0).length;
    const costs = fills.filter(row => finite(row.entryCost) && row.entryCost >= 0
        && finite(row.gas) && row.gas >= 0 && finite(row.fees) && row.fees >= 0 && row.entryCost >= row.fees);
    const completeCosts = costs.length === fills.length;
    const shares = sum(costs.map(row => row.shares)), entryCost = sum(costs.map(row => row.entryCost));
    const fees = sum(costs.map(row => row.fees)), gas = sum(costs.map(row => row.gas));
    const allIn = costs.map(row => (row.entryCost + row.gas) / row.shares);
    const prices = costs.map(row => (row.entryCost - row.fees) / row.shares);
    const pnl = sum(fills.map(row => row.pnl));
    const holding = fills.filter(row => finite(row.capitalHours) && row.capitalHours >= 0);
    const capitalHours = holding.length === fills.length ? sum(holding.map(row => row.capitalHours)) : null;
    const positions = Object.values(arm.positions || {}), noEntry = final.filter(([, result]) => !result.filled);
    const averageWin = mean(wins.map(row => row.pnl)), averageLoss = mean(losses.map(row => row.pnl));
    const inference = inferenceSummary(name, state, markets, config, now);
    const evidence = enabled ? { ...dailyEvidence(final.map(([slug, result]) => ({ closedAt: markets[slug].end, pnl: result.pnl })),
        config, elapsedDays, [fills.length]), available: true }
        : unavailableEvidence(config, elapsedDays, [fills.length]);
    const netAfterInference = inference.totalCost === null ? null : round(pnl - inference.totalCost);
    return { name, enabled, initialVirtualCapital: config.capital, cash: finite(arm.cash) ? arm.cash : null,
        peakEquity: finite(arm.peak) ? arm.peak : null, realizedEquityDrawdown: finite(arm.drawdown) ? arm.drawdown : null,
        stopped: arm.stopped || null, completedFilled: fills.length, wins: wins.length, losses: losses.length,
        breakeven: fills.length - wins.length - losses.length, netWinRate: fills.length ? round(wins.length / fills.length) : null,
        accuracy: { correct, incorrect, neutral: directional.length - correct - incorrect,
            denominator: correct + incorrect, rate: correct + incorrect ? round(correct / (correct + incorrect)) : null,
            basis: 'actual_filled_officially_resolved_binary_outcomes_only' },
        tradingPnl: pnl, averageWin, averageLoss, averagePnlPerFilledMarket: mean(fills.map(row => row.pnl)),
        enrolledMarketEvidence: evidence,
        informationalCriteria: { enabled, sufficientSample: evidence.sufficientSample, positiveTradingPnl: enabled && pnl > 0,
            positiveMeanCiLowerBound: evidence.positiveMeanCiLowerBound,
            inferenceCostKnown: inference.costComplete,
            positiveNetAfterInferenceExcludingCompute: !enabled || netAfterInference === null ? null : netAfterInference > 0,
            noPendingInventory: positions.length === 0, armNotStopped: !arm.stopped,
            computeCostKnown: false, automaticQualification: false },
        resolvedOutcomeMarkets: final.length, noEntryMarkets: noEntry.length,
        noEntryReasons: counts(noEntry.map(([, result]) => result.reason)),
        noFillMarkets: noEntry.filter(([, result]) => result.reason === 'no_fill').length,
        pendingOrders: positions.filter(position => position.status === 'pending').length,
        matchedUnsettled: positions.filter(position => position.status === 'matched').length,
        filledUnresolved: positions.filter(position => position.status === 'filled').length,
        pendingOrUnresolvedMarkets: Object.keys(markets).length - final.length,
        partialFills: fills.filter(row => row.partial === true || row.shares < config.shares - 0.00001).length,
        economics: { netTradingPnl: pnl, grossTradingPnl: completeCosts ? round(pnl + fees + gas) : null,
            fees: completeCosts ? fees : null, gas: completeCosts ? gas : null,
            netPnlBasis: 'settlement_payout_minus_entry_notional_fees_and_gas',
            averageFillPrice: mean(prices), shareWeightedFillPrice: shares ? round((entryCost - fees) / shares) : null,
            observedEntryCosts: { fills: costs.length, missingFills: fills.length - costs.length, complete: completeCosts,
                meanAllInCostPerShare: mean(allIn), shareWeightedAllInCostPerShare: shares ? round((entryCost + gas) / shares) : null,
                maximumAllInCostPerShare: allIn.length ? round(Math.max(...allIn)) : null,
                admissionCostCapPerShare: name === CONTROL ? config.costCapPerShare : null,
                aboveFullFillAdmissionCap: name === CONTROL
                    ? allIn.filter(value => value > config.costCapPerShare + 0.00001).length : null,
                basis: 'actual_entry_notional_plus_fees_and_gas_divided_by_actual_filled_shares' },
            realizedPayoffBreakEvenWinRate: averageWin > 0 && averageLoss < 0
                ? round(-averageLoss / (averageWin - averageLoss)) : null,
            capitalHours, capitalHoursComplete: holding.length === fills.length,
            netPnlPerCapitalHour: capitalHours > 0 ? round(pnl / capitalHours) : null,
            calibratedWinProbability: null, expectedProfitValidated: false },
        inference, netAfterInference,
        netAfterInferenceExcludesComputeCost: true, tradingPnlExcludesInferenceCost: true, sufficientForLive: false };
}

export function summarizePremarketPaper(state, input, now = Date.now()) {
    const config = policyOf(input); validatePolicy(config);
    const activeArms = activeArmsOf(config), profile = profileOf(config), history = historyRequirements(config);
    const control = controlOf(config), fair = fairProfile(config), early = isCandleProfile(config), next = profile === NEXT_PROFILE;
    if (!validId(config.id) || state.id !== config.id || !sameArms(Object.keys(state.arms || {}))) throw identityError();
    // Freeze evidence duration at entry shutdown, while labels and settlements still use the report time.
    const { entryCutoffAt, archivedAt, elapsedThroughAt, elapsedDays } = evidencePeriod(state, now);
    const markets = Object.fromEntries(Object.entries(state.markets || {})
        .filter(([, market]) => finite(market.enrolledAt) && market.enrolledAt <= now));
    const completed = Object.fromEntries(ARMS.map(name => [name, completedRows(state.arms[name], now)]));
    const results = Object.fromEntries(ARMS.map(name => [name, new Map(Object.entries(markets)
        .map(([slug, market]) => [slug, resultFor(state.arms[name], completed[name], slug, market)]))]));
    const paired = [], excluded = {};
    for (const [slug, market] of Object.entries(markets)) {
        const reason = market.end > now ? 'market_not_ended' : !labeled(market, now) ? 'official_label_pending'
            : activeArms.some(name => results[name].get(slug).pending) ? 'arm_outcome_pending' : null;
        if (reason) { excluded[reason] = (excluded[reason] || 0) + 1; continue; }
        paired.push({ slug, arms: Object.fromEntries(activeArms.map(name => {
            const result = results[name].get(slug);
            return [name, { pnl: result.pnl, filled: result.filled }];
        })) });
    }
    const comparability = fair ? fairComparability(state, markets, paired, results, config) : null;
    const comparisons = Object.fromEntries(ARMS.filter(name => name !== control).map(name => {
        if (!activeArms.includes(name) || !activeArms.includes(control)) return [name, {
            primary: name, control, available: false, reason: 'arm_not_selected',
            inactiveArms: [name, control].filter(arm => !activeArms.includes(arm)), markets: 0,
            primaryPnl: null, controlPnl: null, primaryMinusControlPnl: null, meanDeltaPerEnrolledResolvedMarket: null,
            primaryAveragePnlPerMarket: null, controlAveragePnlPerMarket: null,
            bothFilledMarkets: 0, primaryOnlyFilledMarkets: 0, controlOnlyFilledMarkets: 0, neitherFilledMarkets: 0,
            pairedDeltaEvidence: unavailableEvidence(config, elapsedDays, [0, 0]),
            informationalCriteria: { sufficientSample: false, positiveTradingDifference: null,
                positiveMeanDeltaCiLowerBound: null, automaticQualification: false },
            inferenceCostsIncluded: false, rows: [], profitabilityValidated: false }];
        const rows = paired.map(row => ({ slug: row.slug, primaryPnl: row.arms[name].pnl,
            controlPnl: row.arms[control].pnl, delta: round(row.arms[name].pnl - row.arms[control].pnl),
            primaryFilled: row.arms[name].filled, controlFilled: row.arms[control].filled }));
        const primaryPnl = sum(rows.map(row => row.primaryPnl)), controlPnl = sum(rows.map(row => row.controlPnl));
        const evidence = dailyEvidence(rows.map(row => ({ closedAt: markets[row.slug].end, pnl: row.delta })),
            config, elapsedDays, [rows.filter(row => row.primaryFilled).length, rows.filter(row => row.controlFilled).length]);
        if (fair && comparability.status !== 'verified') {
            evidence.sufficientSample = false;
            evidence.reasons.push('comparability_incomplete');
        }
        return [name, { primary: name, control, available: true, markets: rows.length, primaryPnl, controlPnl,
            primaryMinusControlPnl: round(primaryPnl - controlPnl), meanDeltaPerEnrolledResolvedMarket: mean(rows.map(row => row.delta)),
            primaryAveragePnlPerMarket: mean(rows.map(row => row.primaryPnl)), controlAveragePnlPerMarket: mean(rows.map(row => row.controlPnl)),
            bothFilledMarkets: rows.filter(row => row.primaryFilled && row.controlFilled).length,
            primaryOnlyFilledMarkets: rows.filter(row => row.primaryFilled && !row.controlFilled).length,
            controlOnlyFilledMarkets: rows.filter(row => !row.primaryFilled && row.controlFilled).length,
            neitherFilledMarkets: rows.filter(row => !row.primaryFilled && !row.controlFilled).length,
            pairedDeltaEvidence: evidence,
            ...(fair ? { comparability: { status: comparability.status,
                verifiedComparableMarkets: comparability.verifiedComparableMarkets,
                verifiedUniformSkippedMarkets: comparability.verifiedUniformSkippedMarkets,
                verifiedUniformCancelledMarkets: comparability.verifiedUniformCancelledMarkets,
                incompletePairedMarkets: comparability.incompletePairedMarkets } } : {}),
            informationalCriteria: { sufficientSample: evidence.sufficientSample,
                positiveTradingDifference: primaryPnl > controlPnl,
                ...(fair ? { comparabilityVerified: comparability.status === 'verified' } : {}),
                positiveMeanDeltaCiLowerBound: evidence.positiveMeanCiLowerBound, automaticQualification: false },
            inferenceCostsIncluded: false, rows, profitabilityValidated: false }];
    }));
    const slots = Object.values(state.slots || {});
    return { id: config.id, experiment: config.experiment, profile, historyRequirements: history,
        ...(routerDirectionalPolicy(config) ? { routerPolicy: config.routerPolicy,
            providerComparisonPolicy: { sameFrozenInput: true, differentProviderPrompts: true,
                sameExecutionGuards: true, pureModelComparison: false,
                'premarket-momentum': { task: 'deterministic_streak_reversal_signal' },
                'laya-premarket': { task: 'streak_signal_confirmation_or_skip', promptPolicy: 'unchanged_next_laya_prompt' },
                'router-premarket': { ...routerDirectionalPromptEvidence(config),
                    task: 'forecast_direction_then_confirm_allowed_signal_or_skip',
                    expectedProfitClaimed: false, calibratedProbabilityClaimed: false } } } : {}),
        generatedAt: new Date(now).toISOString(), startedAt: state.startedAt,
        entryCutoffAt, archivedAt, elapsedThroughAt,
        elapsedDays: round(elapsedDays), elapsedHours: round(elapsedDays * 24),
        minimumEvidence: { elapsedAndObservedDays: config.minDays ?? 7, completedFilledPerArm: config.minMarkets ?? 100,
            bootstrapSamples: config.bootstrapSamples ?? 10000, timezone: 'Asia/Jakarta', informationalOnly: true },
        paperOnly: true, armNames: [...ARMS], activeArms: [...activeArms], controlArm: control,
        ...(early ? { armLabels: { 'premarket-momentum': 'streak-reversal', 'laya-premarket': 'laya-premarket',
            'router-premarket': 'router-premarket', 'late-cost-cap': 'late-cost-cap' }, controlLabel: 'streak-reversal' } : {}),
        ...(fair ? { historicalReferenceArms: [CONTROL] } : {}),
        inferencePolicy: config.inferencePolicy, automaticPromotion: false, sufficientForLive: false,
        hypothesis: { preregistered: true, validatedProfitability: false, directions: ['Up', 'Down'],
            signal: config.signalPolicy ?? (fair ? 'multi-horizon-30m-momentum-v1'
                : profile === NEAR_OPEN_PROFILE ? 'router-full-30m-candles-near-open-value-v1'
                : 'three_completed_one_minute_bearish_lower_closes_down_or_bullish_higher_closes_up_else_skip'),
            decisionLeadSeconds: config.leadSeconds, diagnosticHistoryMs: history.diagnosticHistoryMs,
            diagnostics15mAffectAdmission: early ? false : profile === NEAR_OPEN_PROFILE || fair,
            momentumRuleActive: early ? false : activeArms.includes('premarket-momentum'),
            ...(early ? { streakReversalRuleActive: activeArms.includes('premarket-momentum'),
                ruleParameters: config.signalParameters ?? { minimumPriorStreak: 3 },
                predictorSource: 'binance_spot_BTCUSDT', outcomeSource: 'official_ctf_payout',
                targetDefinition: next ? 'immediate_next_5m_closing_Chainlink_60s_TWAP_versus_opening_TWAP'
                    : 'future_5m_closing_Chainlink_60s_TWAP_versus_future_opening_TWAP',
                quantizedDojiBreaksStreak: true, probabilityPolicy: 'none_direction_only' } : {}),
            ...(next ? { rolePolicy: config.rolePolicy, controlPolicy: config.controlPolicy,
                nextCandleTarget: true, decisionOffsetAfterOpenMs: 5000, historyEndsAtTargetOpen: true,
                openingTwapPolicy: 'unknown_recorded_null_not_used_for_admission',
                aiMaySkipValidSignal: true, oppositeDirectionBuyAllowed: false } : {}),
            ...(fair ? { ...(!early ? { momentumParameters: config.signalParameters ?? null } : {}),
                commonExecutionPolicy: config.executionPolicy ?? null } : {}),
            historyRequirements: history,
            sourceAndReceiptCutoff: 'each_candle_and_source_point_must_be_known_by_the_scheduled_decision_time',
            illustrativePriceUsd: 0.5, illustrativePriceMeaning: 'per_share_example_not_total_budget_price_gate_or_fill_guarantee',
            premarketPriceBand: null, lateControlAskBand: fair ? null : [0.72, 0.9],
            aiDecisionMs: config.aiDecisionMs, aiPolicy: routerDirectionalPolicy(config)
                ? 'laya_confirmation_and_gpt_directional_confirmation_from_same_frozen_snapshot'
                : next ? 'streak_signal_confirmation_or_skip_from_same_frozen_snapshot'
                : 'independent_predictions_from_same_frozen_premarket_snapshot',
            costCapPerShare: fair ? null : config.costCapPerShare,
            costCapBasis: fair ? null : 'late_control_full_target_fill_including_fees_and_gas',
            partialFillCaveat: 'actual_partial_fill_gas_per_share_can_exceed_full_fill_admission_cost_cap' },
        virtualCapital: { perArm: config.capital, sharesPerOrder: config.shares, entryCapPerArm: config.entryCap,
            pooledAcrossArms: false, armProfitsMayBeSummed: false },
        arms: Object.fromEntries(ARMS.map(name => [name, armSummary(name, state.arms[name], results[name], markets, config, now, state, elapsedDays)])),
        commonCohort: { enrolledMarkets: Object.keys(markets).length, markets: paired.length,
            activeArms: [...activeArms],
            ...(fair ? { controlArm: control, comparabilityStatus: comparability.status,
                includesTimeoutAndProviderFailure: true } : {}),
            marketIds: paired.map(row => row.slug), excludedMarkets: Object.keys(markets).length - paired.length, excludedReasons: excluded,
            basis: activeArms.length === ARMS.length ? 'same_enrolled_markets_with_official_labels_and_final_outcomes_for_all_arms'
                : 'same_enrolled_markets_with_official_labels_and_final_outcomes_for_selected_arms',
            includesSkipAndNoFill: true, noEntryPnl: 0, unknownOutcomesCountedAsZero: false },
        pairedComparisons: comparisons,
        ...(fair ? { comparability } : {}),
        slotCoverage: { scheduled: slots.length, status: counts(slots.map(row => row.status || 'unknown')),
            reasons: counts(slots.filter(row => row.reason).map(row => row.reason)) },
        operational: { lastHeartbeatAt: state.lastHeartbeatAt ?? null, lastTickAt: state.lastTickAt ?? null,
            clock: state.clock || null, errors: state.errors || {},
            ...(config.clockPolicy ? { clockPolicy: config.clockPolicy } : {}),
            ...(config.transportPolicy ? { transportPolicy: config.transportPolicy } : {}),
            ...(boundedEarlyExecution(config) ? { bookPolicy: { ...config.bookPolicy,
                authority: 'fresh_rest_full_snapshot', sourceTimestampMeaning: 'exchange_book_timestamp',
                sourceAgeIsNotReceiptAge: true, executionReadAfterActivationRequired: true },
                executionPolicy: { ...config.earlyExecution, captureToleranceMs: config.slotToleranceMs,
                    aiDecisionMs: config.aiDecisionMs, minimumActivationDelayMs: config.latencyMs ?? 250,
                    ...(next ? { marketOpenOffsetLimitMs: 90000, beforeMarketEndRequired: true, postOpenEntry: true }
                        : { marketOpenSafetyMs: 1000 }), frozenLimits: true, postSubmissionRetries: false },
                executionAttempts: (state.snapshots || []).reduce((total, snapshot) =>
                    total + (snapshot.fairExecution?.attempts?.length || 0), 0) } : {}) },
        limitations: ['paper_execution_is_not_live_fill_evidence', 'partial_fills_can_raise_gas_cost_per_share',
            'unresolved_and_pending_outcomes_are_excluded_from_comparisons', 'virtual_arm_profits_must_not_be_summed',
            'historical_periods_are_separate_and_must_not_be_pooled',
            'local_compute_cost_unknown', 'no_automatic_live_promotion'] };
}

function markdown(report) {
    const money = value => finite(value) ? value.toFixed(4) : '-';
    const rate = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '-';
    const frequencies = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join(', ') || '-';
    const history = report.historyRequirements, fair = fairProfile(report), early = isCandleProfile(report), next = report.profile === NEXT_PROFILE;
    const nearOpen = report.profile === NEAR_OPEN_PROFILE || report.profile === FAIR_PROFILE;
    const label = name => report.armLabels?.[name] || name;
    return [`# Premarket paper ${report.id}`, '',
        'Riset paper. Tidak ada promosi live otomatis; profitabilitas belum tervalidasi.',
        'Setiap arm memakai modal virtual terpisah. Profit arm dan hasil periode historis tidak boleh digabung.', '',
        `Profil: ${report.profile}. Keputusan pada open ${next ? 'plus 5' : `minus ${report.hypothesis.decisionLeadSeconds}`} detik; budget AI ${report.hypothesis.aiDecisionMs / 1000} detik${next ? ' sejak capture aktual' : ''}.`,
        `History wajib: ${history.candleCount} candle selesai ${history.candleIntervalMs / 60000} menit (${history.historyMs / 60000} menit); history diagnostik ${history.diagnosticHistoryMs / 60000} menit.`,
        ...(nearOpen ? [`Konteks: ${history.grouped5mCandleCount} kelompok candle 5 menit; return 30/60 detik dan 3/5/15/30 menit. Warmup LIVE utuh setelah startup/gap: minimal ${history.startupAndGapWarmupMs / 60000} menit, tanpa backfill atau pemotongan input.`] : []), '',
        ...(early ? ['Konteks: 30 candle Binance BTCUSDT 5 menit yang sudah selesai, mencakup 150 menit. Cache historis diperbolehkan; tidak menunggu warmup live 150 menit.',
            'Return 5/15/30/60/150 menit dan volatilitas berasal dari OHLC yang sama. Binance hanya prediktor; hasil memakai payout CTF resmi untuk perbandingan TWAP Chainlink pada market target.',
            next ? 'Market target adalah candle 5 menit tepat setelah candle reversal pertama. History berakhir saat market target dibuka; keputusan dijadwalkan 5 detik sesudahnya dan fill terjadi setelah cutoff AI bersama. Opening TWAP yang belum diketahui dicatat null dan tidak digunakan untuk admission.'
                : 'Market target dibuka 540 detik setelah keputusan, bukan candle berikutnya. Waktu pengambilan keputusan dan fill paper berbeda karena cutoff AI bersama 30 detik.'] : []),
        ...(report.operational.bookPolicy ? [
            `Capture maksimal ${report.operational.executionPolicy.captureToleranceMs / 1000} detik setelah jadwal; semua candle tetap wajib diketahui pada jadwal semula.`,
            `Book paper memakai snapshot REST penuh tanpa cache: RTT maksimal ${report.operational.bookPolicy.maxRoundTripMs / 1000} detik dan umur receipt maksimal ${report.operational.bookPolicy.maxVerificationAgeMs / 1000} detik. Timestamp exchange disimpan terpisah dan tidak diganti waktu receipt.`,
            `Validasi bersama dapat diulang setiap ${report.operational.executionPolicy.retryMs / 1000} detik hingga ${report.operational.executionPolicy.retryWindowMs / 1000} detik setelah cutoff AI, ${next ? 'dengan deadline maksimal 90 detik setelah market dibuka dan fill wajib sebelum deadline serta market berakhir' : 'dengan batas sebelum market dibuka'}. Limit awal tetap; setelah antrean minimal ${report.operational.executionPolicy.minimumActivationDelayMs}ms, satu pembacaan REST baru dipakai bersama untuk satu FAK tanpa retry setelah submission.`] : []),
        `Arm aktif: ${report.activeArms.map(label).join(', ')}. Arm tidak dipilih tidak menjadi kontrol atau bukti performa.`, '',
        ...(report.routerPolicy ? [
            `Kebijakan GPT: ${report.routerPolicy}. Input beku dan guard eksekusi sama; prompt dan tugas provider berbeda, sehingga hasil bukan perbandingan model murni.`,
            `Laya tetap memakai prompt konfirmasi. GPT memprediksi UP/DOWN dengan kekuatan weak/moderate/strong; arah yang cocok dengan sinyal BUY yang diizinkan menghasilkan BUY, arah berlawanan menghasilkan SKIP. Hash prompt GPT aktual: ${report.providerComparisonPolicy['router-premarket'].providerPromptHash}.`,
            'Kekuatan prediksi adalah penilaian kualitatif, bukan probabilitas terkalibrasi atau bukti expected profit. Tanpa sinyal atau izin entry, GPT tidak dipanggil dan coverage mencatat withheld.'
        ] : []),
        ...(fair ? [`Kontrol paired: ${label(report.controlArm)}. late-cost-cap tidak aktif; hanya referensi historis, bukan kontrol fair.`,
            early ? 'Semua arm memakai 30 OHLC 5 menit yang sama, dibulatkan ke sen dan dikodekan sebagai delta tanpa menghilangkan candle. Doji setelah pembulatan memutus streak.'
                : 'Semua arm memakai input ringkas bersama: 30 candle utuh, OHLC dibulatkan ke sen, dan enam kelompok 5 menit diturunkan dari candle yang sama. Kuantisasi mengurangi presisi harga; history tidak dipotong.',
            'Input dan pertanyaan aktual wajib lolos tokenizer Laya 1.024 token. Kegagalan validasi membatalkan entry seluruh cohort.',
            `Comparability: ${report.comparability.status}; ${report.comparability.verifiedCohortMarkets}/${report.comparability.pairedMarkets} market paired memiliki bukti cohort lengkap: ${report.comparability.decisionComparableMarkets} keputusan dengan input/eksekusi bersama, ${report.comparability.verifiedUniformSkippedMarkets} SKIP seragam sebelum input terbentuk, ${report.comparability.verifiedUniformCancelledMarkets} pembatalan bersama sebelum cutoff tanpa exposure.`,
            `Bukti tidak lengkap: ${frequencies(report.comparability.reasons)}. Hash input yang ditawarkan dan hash request yang benar-benar dikirim dicatat terpisah.`,
            'Ketiga arm menunggu cutoff keputusan bersama; BUY valid memakai validasi book dan waktu antrean bersama.', ''] : []),
        '| Arm | Filled resolved | Net W/L | Akurasi fill | PnL net | Harga fill | Biaya all-in/share | Partial | Pending |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...ARMS.map(name => { const arm = report.arms[name];
            if (!arm.enabled) return `| ${label(name)} (tidak aktif) | - | - | - | - | - | - | - | - |`;
            return `| ${label(name)} | ${arm.completedFilled} | ${arm.wins}/${arm.losses} | ${rate(arm.accuracy.rate)} | ${money(arm.tradingPnl)} | ${money(arm.economics.averageFillPrice)} | ${money(arm.economics.observedEntryCosts.meanAllInCostPerShare)} | ${arm.partialFills} | ${arm.pendingOrUnresolvedMarkets} |`; }), '',
        `Cohort bersama: ${report.commonCohort.markets}/${report.commonCohort.enrolledMarkets} market enrolled.`,
        `Durasi: ${report.elapsedDays} hari. Minimum bukti: ${report.minimumEvidence.elapsedAndObservedDays} hari elapsed dan observed, ${report.minimumEvidence.completedFilledPerArm} fills selesai per arm.`,
        'CI 95% bootstrap memakai blok hari WIB dan PnL per market enrolled yang sudah final, termasuk skip/no-fill nol. CI kosong sebelum dua hari teramati; CI yang tersedia sebelum minimum bukti tetap belum cukup.',
        ...report.activeArms.map(name => { const evidence = report.arms[name].enrolledMarketEvidence;
            return `- ${label(name)}: CI mean PnL/market ${evidence.ci95 ? `[${money(evidence.ci95.lower)}, ${money(evidence.ci95.upper)}]` : '-'}; hari ${evidence.observedDays}; bukti ${evidence.reasons.join(', ') || 'minimum sampel terpenuhi'}.`; }),
        ...Object.values(report.pairedComparisons).map(pair => pair.available
            ? `- ${pair.primary} - ${pair.control}: delta PnL trading ${money(pair.primaryMinusControlPnl)}; biaya inference belum termasuk.`
            : `- ${pair.primary} - ${pair.control}: perbandingan tidak tersedia (${pair.reason}: ${pair.inactiveArms.join(', ')}).`),
        ...Object.values(report.pairedComparisons).filter(pair => pair.available).map(pair => `- ${pair.primary}: CI paired mean delta/market ${pair.pairedDeltaEvidence.ci95 ? `[${money(pair.pairedDeltaEvidence.ci95.lower)}, ${money(pair.pairedDeltaEvidence.ci95.upper)}]` : '-'}; bukti ${pair.pairedDeltaEvidence.reasons.join(', ') || 'minimum sampel terpenuhi'}.`),
        ...report.activeArms.map(name => `- ${label(name)}: request AI ${report.arms[name].inference.requests}; biaya tidak diketahui ${report.arms[name].inference.unknownCostRequests}; net setelah inference ${money(report.arms[name].netAfterInference)}.`),
        ...report.activeArms.filter(name => report.arms[name].inference.provider).flatMap(name => {
            const inference = report.arms[name].inference;
            return [`- ${name}: status request ${frequencies(inference.requestStatuses)}; aksi valid ${frequencies(inference.validActionCounts)}.`,
                `- ${name}: arah prediksi ${frequencies(inference.forecastDirectionCounts)}; arah dapat diprediksi meski keputusan trading SKIP.`,
                `- ${name}: akurasi arah prediksi tepat waktu ${rate(inference.directionalForecastAccuracy.rate)} (${inference.directionalForecastAccuracy.correct}/${inference.directionalForecastAccuracy.denominator}), termasuk ${inference.directionalForecastAccuracy.skippedDecisions} keputusan SKIP; withheld ${inference.forecastCoverage.withheld}, pending ${inference.forecastCoverage.pending}, unknown ${inference.forecastCoverage.unknown}, invalid ${inference.forecastCoverage.invalid}, late ${inference.forecastCoverage.late}, label tertunda ${inference.forecastCoverage.pendingLabels}.`,
                `- ${name}: SKIP model ${inference.modelSkips} (${frequencies(inference.modelSkipReasons)}); eksekusi ${frequencies(inference.entryDispositions)}.`];
        }),
        report.routerPolicy ? 'GPT directional tidak mengestimasi probabilitas atau expectedNetUsd. Alasan dan prediksi historis yang tidak direkam ditampilkan sebagai unknown.'
            : 'Estimasi probabilitas model belum terkalibrasi; expectedNetUsd adalah estimasi dari probabilitas itu, bukan bukti profit. Alasan historis yang tidak direkam ditampilkan sebagai unknown.',
        'Perbandingan memasukkan skip/no-fill final sebagai PnL nol. Pending, unresolved, dan label resmi tertunda dikeluarkan; bukan kemenangan.',
        'Akurasi fill hanya memakai fill berlabel resmi biner; akurasi prediksi arah juga mencakup SKIP yang memiliki prediksi valid tepat waktu. Net win rate dan akurasi arah berbeda karena biaya.',
        'Kriteria sampel, net profit, dan batas bawah CI hanya informasi riset; tidak memberi kualifikasi live. Biaya inference yang tidak diketahui tetap kosong dan biaya compute belum termasuk.',
        ...(report.activeArms.includes(CONTROL) ? ['Cost cap admission kontrol mengasumsikan full fill; biaya aktual partial fill termasuk fee dan gas bisa melebihi cap.'] : []),
        early ? `Streak-reversal: minimal ${report.hypothesis.ruleParameters.minimumPriorStreak} candle UP berurutan lalu tepat satu DOWN memilih DOWN; kebalikannya memilih UP. Doji memutus streak. ${next ? report.routerPolicy
            ? 'Laya boleh mengonfirmasi atau SKIP. GPT harus BUY jika prediksi arahnya cocok dengan BUY sinyal yang diizinkan, selain itu SKIP. Tanpa pola, semua arm SKIP dan AI tidak dipanggil.'
            : 'Laya serta GPT hanya boleh mengonfirmasi BUY searah sinyal atau memilih SKIP; sinyal valid tidak mewajibkan BUY. Tanpa pola, semua arm SKIP dan AI tidak dipanggil.' : 'Laya serta GPT menilai semua 30 candle secara independen dan tidak wajib mengikuti aturan deterministik.'}`
            : fair ? `Momentum menilai keselarasan return 5/15/30 menit dan enam kelompok 5 menit; Laya serta GPT memilih Up, Down, atau SKIP secara independen dari konteks 30 menit yang sama. Parameter momentum: ${JSON.stringify(report.hypothesis.momentumParameters)}.`
            : nearOpen ? 'Router menilai Up, Down, atau SKIP dari seluruh konteks 30 menit yang dibekukan. Aturan momentum tiga candle tidak menjadi gate entry profil ini.'
            : report.hypothesis.momentumRuleActive
                ? `Sinyal momentum pada open minus ${report.hypothesis.decisionLeadSeconds} detik: tiga candle 1 menit selesai bearish dan lower-close untuk Down, atau bullish dan higher-close untuk Up; selain itu skip. Data ${history.diagnosticHistoryMs / 60000} menit hanya diagnostik.`
                : `AI menilai Up, Down, atau SKIP dari ${history.candleCount} candle selesai yang dibekukan pada open minus ${report.hypothesis.decisionLeadSeconds} detik.`,
        `Harga $0.50 hanya contoh harga per share, bukan total budget, price gate, atau jaminan fill. Premarket memakai ${report.virtualCapital.sharesPerOrder} shares, depth full target dan cap all-in $${report.virtualCapital.entryCapPerArm}.`, ''].join('\n');
}

export function savePremarketPaperReport(config, state, now = Date.now()) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const report = summarizePremarketPaper(state, config, now), directory = path.join(config.dataDir, config.id, 'reports');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    atomicJson(path.join(directory, 'latest.json'), report);
    const filename = path.join(directory, 'latest.md');
    fs.writeFileSync(filename, markdown(report), { mode: 0o600 }); fs.chmodSync(filename, 0o600);
    return report;
}

export function readPremarketPaperReports(config, history = false) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const dataDir = path.resolve(config.dataDir), activeFile = path.join(dataDir, 'active.json');
    const active = fs.existsSync(activeFile) ? read(activeFile) : null;
    if (fs.existsSync(activeFile) && (!validId(active?.id) || active.paperOnly !== true)) throw identityError();
    const readPeriod = (directory, id, archivedAt = null) => {
        if (!path.isAbsolute(directory) || !validId(id)) throw identityError();
        const folder = path.join(directory, id), manifest = read(path.join(folder, 'manifest.json'));
        if (manifest.id !== id || manifest.paperOnly !== true || !manifest.policy) throw identityError();
        const policy = { ...manifest.policy, id, dataDir: directory }; validatePolicy(policy);
        const state = read(path.join(folder, 'ledger.json'));
        if (timestamp(state.archivedAt) === null && timestamp(archivedAt) !== null) state.archivedAt = archivedAt;
        const report = summarizePremarketPaper(state, policy);
        return { ...report, periodPolicy: manifest.policy };
    };
    const result = active ? readPeriod(dataDir, active.id)
        : { id: null, decision: 'belum_dimulai', paperOnly: true, automaticPromotion: false, sufficientForLive: false };
    if (history) {
        const filename = path.join(dataDir, 'history.json'), index = fs.existsSync(filename) ? read(filename) : { periods: [] };
        if (!Array.isArray(index?.periods)) throw identityError();
        const seen = new Set(active ? [`${dataDir}:${active.id}`] : []);
        result.history = index.periods.flatMap(period => {
            if (!period || !validId(period.id) || typeof period.dataDir !== 'string' || !path.isAbsolute(period.dataDir)
                || !['number', 'string'].includes(typeof period.archivedAt) || !finite(new Date(period.archivedAt).getTime())) throw identityError();
            const directory = path.resolve(period.dataDir), key = `${directory}:${period.id}`;
            if (seen.has(key)) return [];
            seen.add(key); return [readPeriod(directory, period.id, period.archivedAt)];
        }).sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    }
    return result;
}

if (!isMainThread && workerData?.kind === 'premarket-paper-report') {
    const config = workerData.config;
    if (!validId(config?.id) || typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const state = read(path.join(config.dataDir, config.id, 'ledger.json'));
    parentPort.postMessage(savePremarketPaperReport(config, state));
}
