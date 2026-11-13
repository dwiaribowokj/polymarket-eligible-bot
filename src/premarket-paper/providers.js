import crypto from 'node:crypto';
import { ProtocolCounter } from '../laya-tuning/counter.js';
import { parseProtocolResponse } from '../laya-tuning/protocol.js';
import { buildCompactPremarketInput, COMPACT_PREMARKET_PROMPT, COMPACT_PREMARKET_QUESTIONS,
    COMPACT_PREMARKET_PROMPT_VERSION } from './compact-context.js';
import { EARLY_PROFILE, NEXT_PROFILE, isCandleProfile, buildEarlyPremarketInput, EARLY_PREMARKET_PROMPT,
    EARLY_PREMARKET_PROMPT_VERSION, EARLY_PREMARKET_QUESTIONS, NEXT_PREMARKET_PROMPT,
    NEXT_PREMARKET_PROMPT_VERSION, NEXT_PREMARKET_QUESTIONS } from './early-context.js';
import { NEXT_ROUTER_DIRECTIONAL_PROMPT, routerDirectionalPolicy, routerDirectionalPromptEvidence,
    normalizeRouterDirectionalResponse } from './router-directional.js';

export const PREMARKET_PROMPT_VERSION = 'future-window-value-explained-v2';
export const PREMARKET_PROMPT = 'Paper BTC 5m forecast BEFORE opening: predict closing Chainlink 60s TWAP versus FUTURE opening TWAP, not current spot. Unknown future TWAPs are expected, not missing historical data. Past momentum may persist or reverse during seconds_to_open and the 300s market. bars are completed 1m OHLC offsets in cents from price_anchor_usd, oldest first. books_up_down is [UP,DOWN], each [bids,asks] of [USD/share,shares]. entry_up_down is [UP,DOWN]; total_cost_usd includes fees and settlement gas once. A winning share pays $1, losing $0; expected net USD = shares * estimated win probability - total_cost_usd. Estimate from supplied evidence, allowing uncertainty; buy only an allowed side with defensible positive expected net, otherwise SKIP. Confidence is not calibrated win probability.';
export const NEAR_OPEN_PROMPT_VERSION = 'near-open-full-30m-context-v1';
export const NEAR_OPEN_PROMPT = PREMARKET_PROMPT + ' This experiment captures 60s before opening. Evaluate ALL 30 completed 1m bars, the six 5m groups of those same bars, and returns over 30s/60s/3m/5m/15m/30m. Five-minute groups overlap the 1m evidence; do not count them as independent confirmations. Context identifies the exact UTC window; no partial candle is included. Distinguish sustained trend, range, and a recent reversal using the supplied OHLC, wider history, and volatility. A short streak alone is insufficient evidence. Returns are price changes in USD, not percentages; 5m OHLC uses the same cent offsets. Do not infer volume, news, or a calibrated win probability from missing data. Explain the main historical evidence and any conflict in one short rationale. More history does not guarantee a predictable outcome.';
const earlyProfile = config => config?.profile === EARLY_PROFILE;
const nextProfile = config => config?.profile === NEXT_PROFILE;
const fairProfile = config => config?.profile === 'fair-near-open-30m-v1' || isCandleProfile(config);
const sharedPrompt = config => nextProfile(config) ? NEXT_PREMARKET_PROMPT
    : earlyProfile(config) ? EARLY_PREMARKET_PROMPT : COMPACT_PREMARKET_PROMPT;
const longProfile = config => config?.profile === 'near-open-30m-v1' || fairProfile(config);
const promptVersion = config => nextProfile(config) ? NEXT_PREMARKET_PROMPT_VERSION
    : earlyProfile(config) ? EARLY_PREMARKET_PROMPT_VERSION : fairProfile(config) ? COMPACT_PREMARKET_PROMPT_VERSION
    : longProfile(config) ? NEAR_OPEN_PROMPT_VERSION : PREMARKET_PROMPT_VERSION;
const questionsFor = config => nextProfile(config) ? NEXT_PREMARKET_QUESTIONS
    : earlyProfile(config) ? EARLY_PREMARKET_QUESTIONS : fairProfile(config) ? COMPACT_PREMARKET_QUESTIONS : PREMARKET_QUESTIONS;
export const ROUTER_REASON_CODES = Object.freeze(['positive_edge', 'no_positive_edge',
    'insufficient_predictive_evidence', 'conflicting_signals', 'no_allowed_buy']);
export const ROUTER_OUTPUT_INSTRUCTIONS = ' Return only JSON with exactly snapshotId (copied), action (BUY_UP|BUY_DOWN|SKIP), estimatedUpProbability (number 0..1, or null if evidence cannot support an estimate), reasonCode (positive_edge|no_positive_edge|insufficient_predictive_evidence|conflicting_signals|no_allowed_buy), rationale (one sentence, max 240 characters, cite supplied evidence). BUY requires a numeric estimate and positive expected net for that side, with reasonCode positive_edge. SKIP requires another reasonCode; uncertainty alone does not make valid data invalid. Estimate probabilities without claiming calibration. No tools or external facts.';
export const FAIR_ROUTER_OUTPUT_INSTRUCTIONS = ' Return only JSON with exactly snapshotId (copied), action (BUY_UP|BUY_DOWN|SKIP), reasonCode (positive_edge|no_positive_edge|insufficient_predictive_evidence|conflicting_signals|no_allowed_buy), rationale (one sentence, max 240 characters, cite supplied evidence). BUY uses positive_edge; SKIP uses another reasonCode. Both models select among the same three actions; numeric win probabilities are not required. No tools or external facts.';
export const NEXT_ROUTER_OUTPUT_INSTRUCTIONS = ' Return only JSON with exactly snapshotId (copied), action (allowed signal BUY or SKIP), reasonCode (positive_edge|no_positive_edge|insufficient_predictive_evidence|conflicting_signals|no_allowed_buy), rationale (one sentence, max 240 characters, cite supplied evidence). Confirming BUY uses positive_edge; SKIP uses another reasonCode. SKIP is always valid; the opposite direction is forbidden. Numeric win probabilities are not required. No tools or external facts.';
export const PREMARKET_QUESTIONS = Object.freeze({ action: { type: 'choice', instructions: PREMARKET_PROMPT,
    criteria: { BUY_UP: 'Future closing TWAP at least future opening; Up allowed.',
        BUY_DOWN: 'Future closing TWAP below future opening; Down allowed.', SKIP: 'Uncertain or no advantage.' } } });
const ACTIONS = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const rounded = value => Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw new Error(reason); };
const usageView = raw => object(raw) ? Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens',
    'prompt_tokens', 'completion_tokens'].filter(k => Number.isSafeInteger(raw[k]) && raw[k] >= 0).map(k => [k, raw[k]])) : null;
const safeReason = error => /^[a-z][a-z0-9_]{1,80}$/.test(error?.message || '') ? error.message : 'provider_transport_error';

export function buildPremarketInput(snapshot, config = {}) {
    if (isCandleProfile(config)) return buildEarlyPremarketInput(snapshot, config);
    const features = snapshot?.features, bars = features?.bars, market = snapshot?.market;
    const extended = longProfile(config);
    if (!Array.isArray(bars) || bars.length !== (extended ? 30 : 3) || !market || !Number.isFinite(snapshot.at)
        || ![market.open, market.end, features.decisionAt, features.observedAt].every(Number.isFinite)
        || market.end <= market.open || snapshot.at >= market.open || features.openingTwap?.value !== null
        || features.decisionAt > snapshot.at || features.observedAt > features.decisionAt
        || bars.some((b, i) => !b || ![b.start, b.end, b.latestReceivedAt].every(Number.isFinite)
            || b.end - b.start !== 60000 || i > 0 && b.start !== bars[i - 1].end
            || b.end > features.decisionAt || b.latestReceivedAt > features.decisionAt))
        fail('premarket_provider_input_invalid');
    if (bars.some(b => ['open', 'high', 'low', 'close'].some(k => !(Number.isFinite(b[k]) && b[k] > 0))
        || b.high < Math.max(b.open, b.close) || b.low > Math.min(b.open, b.close))) fail('premarket_provider_input_invalid');
    const anchor = bars[0].open, diagnostics = snapshot.features.diagnosticOnly || {};
    const ohlc = b => ['open', 'high', 'low', 'close'].map(k => rounded((b[k] - anchor) * 100));
    let context, inputCoverage;
    if (extended) {
        const c = features.context;
        if (!c || c.schema !== config.profile || c.source !== 'chainlink_btc_usd' || c.requiredMinutes !== 30
            || !Number.isFinite(features.observedReceivedAt) || features.observedReceivedAt < features.observedAt
            || features.observedReceivedAt > features.decisionAt || features.decisionAt - features.observedAt > 5000
            || bars.some(b => b.start % 60000 !== 0 || b.end % 60000 !== 0)
            || c.aggregation5m !== 'consecutive_groups_of_five_completed_1m_bars'
            || c.historyStartAt !== bars[0].start || c.historyEndAt !== bars.at(-1).end
            || c.completedThroughAt !== features.decisionAt || c.historyEndAt !== features.decisionAt
            || market.open - features.decisionAt !== 60000 || market.end - market.open !== 300000
            || !Array.isArray(c.bars5m) || c.bars5m.length !== 6
            || !c.returnsUsd || ['s30', 's60', 'm3', 'm5', 'm15', 'm30'].some(k => !Number.isFinite(c.returnsUsd[k])))
            fail('premarket_context_invalid');
        for (let i = 0; i < 6; i++) {
            const group = bars.slice(i * 5, i * 5 + 5), actual = c.bars5m[i];
            const expected = { start: group[0].start, end: group.at(-1).end, open: group[0].open,
                high: Math.max(...group.map(b => b.high)), low: Math.min(...group.map(b => b.low)), close: group.at(-1).close,
                latestReceivedAt: Math.max(...group.map(b => b.latestReceivedAt)) };
            if (!actual || Object.entries(expected).some(([k, value]) => actual[k] !== value)) fail('premarket_context_invalid');
        }
        context = { source: c.source, schema: c.schema, window_start_utc: new Date(c.historyStartAt).toISOString(),
            window_end_utc: new Date(c.historyEndAt).toISOString(), decision_at_utc: new Date(features.decisionAt).toISOString(),
            complete_minutes: 30, candle_interval_seconds: 60, aggregation_5m: c.aggregation5m,
            bars_5m: c.bars5m.map(ohlc),
            returns_usd: Object.fromEntries(['s30', 's60', 'm3', 'm5', 'm15', 'm30'].map(k => [k, rounded(c.returnsUsd[k])])) };
        inputCoverage = { source: c.source, completeMinutes: 30, minuteBars: bars.length, fiveMinuteGroups: c.bars5m.length,
            historyStartAt: c.historyStartAt, historyEndAt: c.historyEndAt, decisionAt: features.decisionAt, truncated: false };
    }
    const allowed = ACTIONS.filter(action => action === 'SKIP' || snapshot.orders?.[action]);
    const input = JSON.stringify({ snapshotId: snapshot.snapshotId, price_anchor_usd: rounded(anchor),
        seconds_to_open: rounded((market.open - snapshot.at) / 1000), market_seconds: (market.end - market.open) / 1000,
        opening_twap: null, bars: bars.map(ohlc), ...(context ? { context } : {}),
        diagnostics: Object.fromEntries(['historySeconds', 'full15MinutesAvailable', 'sigmaUsdSqrtSecond',
            'move180Usd', 'normalized180', 'latest30sMoveUsd'].filter(k => diagnostics[k] !== undefined)
            .map(k => [k, k === 'full15MinutesAvailable' ? diagnostics[k] === true : rounded(diagnostics[k])])),
        books_up_down: snapshot.books.map(b => [b.bids, b.asks].map(rows => rows.slice(0, 5).map(l => [rounded(l.price), rounded(l.size)]))),
        entry_up_down: ['BUY_UP', 'BUY_DOWN'].map(action => {
            const order = snapshot.orders[action];
            if (!order) return null;
            if (!(Number.isFinite(order.price) && order.price > 0 && order.price < 1
                && Number.isFinite(order.shares) && order.shares > 0 && Number.isFinite(order.cost) && order.cost > 0))
                fail('premarket_provider_order_invalid');
            return { limit_usd_per_share: order.price, shares: order.shares, total_cost_usd: order.cost,
                break_even_probability: rounded(order.cost / order.shares) };
        }), allowed });
    const inputBytes = Buffer.byteLength(input);
    if (inputBytes > (extended ? 16384 : 8000)) fail('premarket_provider_input_too_large');
    const encoded = { input, inputHash: hash(input), allowed, ...(inputCoverage ? { inputCoverage, inputBytes } : {}) };
    return fairProfile(config) ? buildCompactPremarketInput(encoded) : encoded;
}

export function normalizeRouterResponse(raw, config, snapshot, allowed) {
    if (routerDirectionalPolicy(config)) return normalizeRouterDirectionalResponse(raw, config, snapshot, allowed);
    const expected = config.routerModel?.split('/').slice(1).join('/');
    if (!object(raw) || ![config.routerModel, expected].includes(raw.model)) fail('model_mismatch');
    const choices = raw.choices;
    if (!Array.isArray(choices) || choices.length !== 1 || choices[0].finish_reason !== 'stop') fail('invalid_response');
    const message = choices[0].message;
    if (!object(message) || message.role !== 'assistant' || message.refusal || message.tool_calls?.length
        || message.function_call || typeof message.content !== 'string' || message.content.length > 2048) fail('invalid_response');
    let answer;
    try { answer = JSON.parse(message.content); } catch { fail('invalid_response'); }
    if (!object(answer) || Object.keys(answer).some(k => !['snapshotId', 'action', 'confidence',
        'estimatedUpProbability', 'reasonCode', 'rationale'].includes(k))
        || answer.snapshotId !== snapshot.snapshotId || !ACTIONS.includes(answer.action)
        || !(fairProfile(config) && answer.estimatedUpProbability === undefined)
            && answer.estimatedUpProbability !== null && (!Number.isFinite(answer.estimatedUpProbability)
            || answer.estimatedUpProbability < 0 || answer.estimatedUpProbability > 1)
        || !ROUTER_REASON_CODES.includes(answer.reasonCode) || typeof answer.rationale !== 'string'
        || !answer.rationale.trim() || answer.rationale.length > 240 || /[\u0000-\u001f]/.test(answer.rationale)
        || answer.confidence !== undefined && (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1))
        fail('invalid_response');
    if (!allowed.includes(answer.action)) fail('disallowed_action');
    if (nextProfile(config) && !buildPremarketInput(snapshot, config).allowed.includes(answer.action)) fail('disallowed_action');
    const p = answer.estimatedUpProbability ?? null;
    const expectedNetUsd = Object.fromEntries(['BUY_UP', 'BUY_DOWN'].map((action, i) => {
        const order = snapshot.orders?.[action];
        return [action, p === null || !order ? null : rounded(order.shares * (i === 0 ? p : 1 - p) - order.cost)];
    }));
    if (answer.action !== 'SKIP' && (answer.reasonCode !== 'positive_edge'
        || !fairProfile(config) && (p === null || !(expectedNetUsd[answer.action] > 0)))) fail('router_buy_without_positive_edge');
    if (answer.action === 'SKIP' && answer.reasonCode === 'positive_edge') fail('router_reason_action_mismatch');
    if (answer.reasonCode === 'no_allowed_buy' && allowed.some(action => action !== 'SKIP')) fail('router_reason_action_mismatch');
    if (!fairProfile(config) && answer.reasonCode === 'no_positive_edge' && (p === null
        || allowed.some(action => action !== 'SKIP' && expectedNetUsd[action] > 0))) fail('router_reason_action_mismatch');
    return { action: answer.action, rawAction: answer.action, model: raw.model, confidence: answer.confidence ?? null,
        estimatedUpProbability: p, estimatedUpProbabilityType: 'self_reported_uncalibrated_market_probability',
        forecastDirection: p === null ? null : p === .5 ? 'NEUTRAL' : p > .5 ? 'UP' : 'DOWN',
        reasonCode: answer.reasonCode, rationale: answer.rationale.trim(), expectedNetUsd,
        responseHash: hash(message.content), responseValidation: 'strict_local_contract', upstreamSchemaEnforcement: 'unverified',
        confidenceType: 'self_reported_not_calibrated_win_probability', usage: usageView(raw.usage) };
}

export function routerRequest(config, encoded) {
    return { model: config.routerModel, stream: false, reasoning_effort: config.routerReasoning,
        max_completion_tokens: 4096, messages: [{ role: 'system', content: routerDirectionalPolicy(config)
            ? NEXT_ROUTER_DIRECTIONAL_PROMPT : (fairProfile(config) ? sharedPrompt(config)
            : longProfile(config) ? NEAR_OPEN_PROMPT : PREMARKET_PROMPT)
            + (fairProfile(config) ? ' Choices: ' + JSON.stringify(questionsFor(config).action.criteria)
                + (nextProfile(config) ? NEXT_ROUTER_OUTPUT_INSTRUCTIONS : FAIR_ROUTER_OUTPUT_INSTRUCTIONS) : ROUTER_OUTPUT_INSTRUCTIONS) },
            { role: 'user', content: encoded.input }], response_format: { type: 'json_object' } };
}

async function jsonResponse(response) {
    if (!response.ok) {
        const error = new Error('provider_http_rejected'); error.httpStatus = response.status; throw error;
    }
    if (!response.body?.getReader) return response.json();
    const reader = response.body.getReader(); let size = 0, text = '';
    const decoder = new TextDecoder();
    try {
        for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 65536) { await reader.cancel(); fail('provider_response_too_large'); }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        try { return JSON.parse(text); } catch { fail('invalid_response'); }
    } finally { reader.releaseLock(); }
}

export class PremarketProviders {
    constructor(config, state = {}, emit = () => {}, options = {}) {
        Object.assign(this, { config, state, emit });
        this.fetch = options.fetch || fetch; this.counter = options.counter || new ProtocolCounter(config);
        this.clock = options.clock || Date.now; this.active = new Map(); this.controllers = new Map(); this.closed = false;
        this.available = {}; this.lastPreflight = 0;
        this.names = config.activeArms ? ['laya', 'router'].filter(name => config.activeArms.includes(`${name}-premarket`)) : ['laya', 'router'];
        if (longProfile(config) && !fairProfile(config) && (this.names.length !== 1 || this.names[0] !== 'router')) fail('premarket_long_history_requires_router_only');
        if (!/^cx\/gpt-(?:6-astra|6\.1-sol)$/.test(config.routerModel || '')) fail('premarket_fixed_router_model_required');
        for (const name of ['laya', 'router']) {
            const saved = this.state[name] ||= {};
            if (saved.pending) {
                saved.disabled = 'inference_unresolved_after_restart';
                this.emit('provider_disabled', { provider: name, reason: saved.disabled });
            }
        }
    }
    async prepareSnapshot(snapshot) {
        if (!fairProfile(this.config)) fail('shared_context_profile_required');
        const encoded = buildPremarketInput(snapshot, this.config);
        const info = await this.counter.start();
        const count = await this.counter.count(encoded.input, questionsFor(this.config));
        const saved = this.state.laya;
        if (saved.tokenizerIdentity && saved.tokenizerIdentity !== info.identity) {
            saved.disabled = 'laya_artifact_changed'; fail(saved.disabled);
        }
        if (info.maxTokens !== 1024 || !info.identity || count.identity !== info.identity
            || count.valid !== true || !Number.isInteger(count.tokens) || count.tokens < 1 || count.tokens > 1024
            || count.truncated || count.instructionTruncated || count.optionsTruncated || count.stateTruncated)
            fail('shared_context_invalid');
        saved.tokenizerIdentity = info.identity;
        return { ...encoded, contextTokens: count.tokens, contextIdentity: count.identity,
            contextVerified: true, semanticPromptHash: hash(sharedPrompt(this.config)) };
    }
    async preflight() {
        if (this.preflightPending) return this.preflightPending;
        this.preflightPending = (async () => {
            const result = {};
            await Promise.all(this.names.map(async name => {
                const saved = this.state[name];
                try {
                    if (saved.disabled) fail(saved.disabled);
                    if (name === 'laya') {
                        const health = await jsonResponse(await this.fetch(this.config.layaUrl + '/health', { signal: AbortSignal.timeout(5000) }));
                        if (!health.loaded?.includes('typed-decisions')) fail('laya_checkpoint_unavailable');
                        const tokenizer = await this.counter.start();
                        if (tokenizer.maxTokens !== 1024 || !tokenizer.identity) fail('laya_context_mismatch');
                        if (saved.tokenizerIdentity && saved.tokenizerIdentity !== tokenizer.identity) {
                            saved.disabled = 'laya_artifact_changed'; fail(saved.disabled);
                        }
                        saved.tokenizerIdentity = tokenizer.identity;
                        result[name] = { ready: true, model: 'typed-decisions', tokenizerIdentity: tokenizer.identity };
                    } else {
                        const data = await jsonResponse(await this.fetch(this.config.ninerouterUrl.replace(/\/$/, '') + '/models', {
                            headers: { Authorization: 'Bearer ' + this.config.ninerouterKey, 'x-9r-internal-models-fetch': '1' },
                            signal: AbortSignal.timeout(5000) }));
                        if (!data.data?.some(row => row.id === this.config.routerModel && row.owned_by !== 'combo')) fail('router_model_unavailable');
                        result[name] = { ready: true, model: this.config.routerModel };
                    }
                } catch (error) { result[name] = { ready: false, reason: safeReason(error) }; }
                this.available[name] = result[name].ready;
                saved.unavailable = result[name].ready ? null : result[name].reason;
            }));
            this.lastPreflight = this.clock(); this.emit('provider_preflight', result); return result;
        })().finally(() => { this.preflightPending = null; });
        return this.preflightPending;
    }
    async predict(name, snapshot) {
        if (!['laya', 'router'].includes(name)) fail('unknown_provider');
        if (!this.names.includes(name)) fail('provider_not_selected');
        const start = this.clock(), saved = this.state[name], deadline = snapshot.aiDeadlineAt;
        let submitted = false, requestEvidence = null;
        const base = status => ({ snapshotId: snapshot.snapshotId, status, action: 'SKIP', model: null,
            requestedModel: name === 'laya' ? 'typed-decisions' : this.config.routerModel,
            startedAt: start, receivedAt: this.clock(), latencyMs: Math.max(0, this.clock() - start),
            requestSubmitted: submitted, inferenceAttempted: submitted,
            cost: name === 'router' && submitted ? null : 0,
            costBasis: name === 'router' && submitted ? 'subscription_usage_unpriced' : 'local_api_only_compute_unpriced',
            computeCostUnknown: true, confidence: null, ...(submitted ? requestEvidence : {}) });
        if (this.closed || saved.disabled) return base(saved.disabled || 'provider_closed');
        if (this.active.has(name) || saved.pending) return base('provider_busy');
        if (!Number.isFinite(deadline) || deadline <= start || deadline > snapshot.at + this.config.aiDecisionMs
            || (nextProfile(this.config) ? deadline > snapshot.at + 30000 || deadline > snapshot.market.open + 90000
                : deadline >= snapshot.market.open)) return base('decision_budget_invalid');
        let timeout, hardTimer;
        const controller = new AbortController();
        saved.pending = { snapshotId: snapshot.snapshotId, startedAt: start, deadline, submitted: false };
        this.emit('provider_pending', { provider: name, ...saved.pending });
        let timedOut = false;
        const task = (async () => {
            if (!this.lastPreflight || this.clock() - this.lastPreflight >= 60000 || this.available[name] === false)
                await this.preflight();
            if (!this.available[name]) fail('provider_unavailable');
            let encoded = buildPremarketInput(snapshot, this.config);
            if (fairProfile(this.config)) {
                const shared = snapshot.commonInput;
                if (!shared?.contextVerified || shared.inputHash !== encoded.inputHash || shared.input !== encoded.input
                    || shared.semanticPromptHash !== hash(sharedPrompt(this.config))
                    || shared.contextIdentity !== this.state.laya.tokenizerIdentity
                    || !Number.isInteger(shared.contextTokens) || shared.contextTokens < 1 || shared.contextTokens > 1024
                    || nextProfile(this.config) && JSON.stringify(shared.allowed) !== JSON.stringify(encoded.allowed))
                    fail('shared_context_unverified');
                encoded = shared;
            }
            let count;
            if (name === 'laya') {
                count = fairProfile(this.config) ? { valid: true, tokens: encoded.contextTokens, identity: encoded.contextIdentity }
                    : await this.counter.count(encoded.input, questionsFor(this.config));
                if (!count.valid || count.tokens > 1024 || count.identity !== saved.tokenizerIdentity) fail('context_or_artifact_invalid');
            }
            if (this.closed || this.clock() >= deadline) fail('decision_budget_expired');
            const request = name === 'laya' ? { model: 'typed-decisions', state: encoded.input, questions: questionsFor(this.config) }
                : routerRequest(this.config, encoded);
            requestEvidence = { inputHash: encoded.inputHash, promptVersion: promptVersion(this.config),
                ...(name === 'router' ? routerDirectionalPromptEvidence(this.config) : {}),
                ...(fairProfile(this.config) ? { contextTokens: encoded.contextTokens, contextIdentity: encoded.contextIdentity,
                    contextVerified: true, semanticPromptHash: encoded.semanticPromptHash } : {}),
                ...(encoded.inputCoverage ? { inputCoverage: encoded.inputCoverage, inputBytes: encoded.inputBytes } : {}) };
            saved.pending = { ...saved.pending, submitted: true, inputHash: encoded.inputHash,
                requestHash: hash(JSON.stringify(request)), promptVersion: promptVersion(this.config),
                ...(name === 'router' ? routerDirectionalPromptEvidence(this.config) : {}),
                ...(fairProfile(this.config) ? { contextTokens: encoded.contextTokens, contextIdentity: encoded.contextIdentity,
                    contextVerified: true, semanticPromptHash: encoded.semanticPromptHash } : {}),
                ...(encoded.inputCoverage ? { inputCoverage: encoded.inputCoverage, inputBytes: encoded.inputBytes } : {}) };
            this.emit('provider_request', { provider: name, ...saved.pending });
            submitted = true;
            const raw = await jsonResponse(await this.fetch(name === 'laya' ? this.config.layaUrl + '/v1/systemone'
                : this.config.ninerouterUrl.replace(/\/$/, '') + '/chat/completions', {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    ...(name === 'router' ? { Authorization: 'Bearer ' + this.config.ninerouterKey } : {}) },
                body: JSON.stringify(request), signal: controller.signal }));
            let row;
            if (name === 'laya') {
                row = parseProtocolResponse(raw, { snapshotId: snapshot.snapshotId, inputHash: encoded.inputHash,
                    allowedLabels: encoded.allowed, promptVersion: promptVersion(this.config) });
                if (row.status !== 'ok') fail(row.reason || 'invalid_response');
                if (raw.usage?.input_tokens !== count.tokens) fail('token_usage_mismatch');
                row = { ...row, usage: usageView(raw.usage) };
            } else row = normalizeRouterResponse(raw, this.config, snapshot, encoded.allowed);
            return { ...base('ok'), ...row, inputHash: encoded.inputHash, promptVersion: promptVersion(this.config),
                ...(encoded.inputCoverage ? { inputCoverage: encoded.inputCoverage, inputBytes: encoded.inputBytes } : {}),
                receivedAt: this.clock(), latencyMs: Math.max(0, this.clock() - start) };
        })().catch(error => {
            const reason = safeReason(error);
            if (['model_mismatch', 'laya_artifact_changed'].includes(reason)) saved.disabled = reason;
            return { ...base('provider_error'), reason, httpStatus: error.httpStatus || null };
        }).then(row => {
            if (timedOut) this.emit('provider_late_response', { provider: name, ...row });
            return row;
        }).finally(() => {
            clearTimeout(hardTimer); this.active.delete(name); this.controllers.delete(name);
            saved.pending = null; this.emit('provider_drained', { provider: name, snapshotId: snapshot.snapshotId });
        });
        this.active.set(name, task); this.controllers.set(name, controller);
        // One request may finish after its decision deadline; it never enters twice.
        hardTimer = setTimeout(() => {
            saved.disabled = 'inference_unresolved';
            this.emit('provider_disabled', { provider: name, reason: saved.disabled }); controller.abort();
        }, this.config.providerDrainMs ?? 60000);
        try {
            const row = await Promise.race([task, new Promise(resolve => { timeout = setTimeout(() => {
                timedOut = true; resolve(base('decision_timeout'));
            }, Math.max(0, deadline - this.clock())); })]);
            if (row.status === 'ok' && row.receivedAt > deadline)
                return { ...row, status: 'decision_timeout', originalAction: row.action, action: 'SKIP' };
            return row;
        } finally { clearTimeout(timeout); }
    }
    async drain(timeoutMs = 60000) {
        let timer;
        try { return await Promise.race([Promise.allSettled([...this.active.values()]).then(() => true),
            new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
        finally { clearTimeout(timer); }
    }
    close() {
        this.closed = true;
        for (const [name, controller] of this.controllers) {
            this.state[name].disabled ||= 'inference_unresolved'; controller.abort();
        }
        this.counter.close();
    }
}
