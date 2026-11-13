import { createHash } from 'node:crypto';
import { INFORMED_PROMPT, INFORMED_PROMPT_SHA256 } from './features.js';
import { decisionBudget } from '../laya-filter-paper/decision-budget.js';
import { routerPin } from '../ai-shadow/config.js';

export const GEMINI_MODEL = 'polymarket-decision';
export const GEMINI_ROUTE_MODEL = 'ag/gemini-3.8-flash-low';
// 9router strips the provider prefix and the registry's `(low)` thinking suffix.
// Its non-streaming translator returns modelVersion verbatim. A 2026-10-20
// read-only probe of the single pinned route returned gemini-3.8-flash-n.
export const GEMINI_RESPONSE_MODELS = Object.freeze([GEMINI_ROUTE_MODEL, 'gemini-3.8-flash-low', 'gemini-3.8-flash-n']);
export const GEMINI_REASON_CODES = Object.freeze(['favorable_edge', 'insufficient_edge',
    'conflicting_signals', 'insufficient_data', 'disallowed_action']);
export const GEMINI_PROMPT = INFORMED_PROMPT + ' Decide directly from the supplied snapshot.'
    + ' Return exactly one compact JSON object: {"action":"BUY_UP"}, {"action":"BUY_DOWN"}, or {"action":"SKIP"}.'
    + ' No other keys, explanations, tools, or markdown.';
export const GEMINI_TRANSPORT = 'bounded-sse-v1';
const digest = value => createHash('sha256').update(value).digest('hex');
export const GEMINI_PROMPT_SHA256 = digest(GEMINI_PROMPT);
const ACTIONS = new Set(['BUY_UP', 'BUY_DOWN', 'SKIP']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const failure = (code, httpStatus) => Object.assign(new Error(code), { code, httpStatus });
const emptyTimings = () => ({ localPreparation: null, responseHeaders: null, firstByte: null,
    firstReasoning: null, firstContent: null, finish: null, bodyComplete: null, contentToComplete: null, routerQueue: null });

function apiBase(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
            throw new Error();
        url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1$/, '') + '/v1';
        return url.href.replace(/\/$/, '');
    } catch { throw failure('router_configuration_invalid'); }
}

async function boundedJson(response, maxBytes, onBytes = () => {}) {
    if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw failure('provider_http_failed', Number.isInteger(response.status) ? response.status : null);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (declared > maxBytes) {
        await response.body?.cancel?.().catch(() => {});
        throw failure('response_too_large');
    }
    if (!response.body?.getReader) {
        const row = await response.json();
        const length = Buffer.byteLength(JSON.stringify(row));
        onBytes(length);
        if (length > maxBytes) throw failure('response_too_large');
        return row;
    }
    const reader = response.body.getReader(), chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            onBytes(value.byteLength);
            if (length > maxBytes) { await reader.cancel(); throw failure('response_too_large'); }
            chunks.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { reader.releaseLock(); }
}

async function boundedCompletion(response, responseModels, mark, onBytes) {
    if (!response.ok || !response.headers?.get?.('content-type')?.includes('text/event-stream')) {
        mark('transport', 'json');
        try { return await boundedJson(response, 65536, onBytes); }
        catch (error) {
            if (error.code === 'response_too_large') error.transportUncertain = true;
            throw error;
        }
    }
    mark('transport', 'sse');
    const declared = Number(response.headers.get('content-length'));
    if (declared > 65536) {
        await response.body?.cancel?.().catch(() => {});
        throw Object.assign(failure('response_too_large'), { transportUncertain: true });
    }
    if (!response.body?.getReader) throw Object.assign(failure('invalid_response'), { transportUncertain: true });
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0, buffer = '', content = '', model = null, id = null, usage, stopped = false, done = false;
    const event = raw => {
        const data = [];
        for (const line of raw.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            if (!line.startsWith('data:')) throw failure('invalid_response');
            data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) return;
        if (done) throw failure('invalid_response');
        const value = data.join('\n');
        if (value === '[DONE]') {
            if (!stopped) throw failure('invalid_response');
            done = true; return;
        }
        let row;
        try { row = JSON.parse(value); } catch { throw failure('invalid_response'); }
        if (!object(row) || row.error) throw failure('invalid_response');
        if (!responseModels.includes(row.model) || model && row.model !== model) throw failure('model_mismatch');
        if (typeof row.id !== 'string' || !row.id || row.id.length > 160 || id && row.id !== id)
            throw failure('invalid_response');
        id = row.id;
        model = row.model;
        if (!Array.isArray(row.choices) || row.choices.length > 1) throw failure('invalid_response');
        if (row.usage !== undefined && row.usage !== null) {
            if (!object(row.usage)) throw failure('invalid_response');
            usage = row.usage;
        }
        if (!row.choices.length) {
            if (!stopped || !row.usage) throw failure('invalid_response');
            return;
        }
        const choice = row.choices[0], delta = choice?.delta;
        if (stopped || choice?.index !== 0 || !object(delta)
            || Object.keys(delta).some(key => !['role', 'content', 'reasoning_content'].includes(key))
            || delta.role !== undefined && delta.role !== 'assistant'
            || delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string'
            || delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string')
            throw failure('invalid_response');
        // Keep phase timestamps only; model reasoning text is never retained.
        if (delta.reasoning_content) mark('firstReasoning');
        if (delta.content) {
            mark('firstContent'); content += delta.content;
            if (Buffer.byteLength(content) > 1024) throw failure('response_too_large');
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            if (choice.finish_reason !== 'stop') throw failure('invalid_response');
            stopped = true; mark('finish');
        }
    };
    try {
        for (;;) {
            const { done: ended, value } = await reader.read();
            if (ended) break;
            length += value.byteLength; onBytes(value.byteLength);
            if (length > 65536) throw failure('response_too_large');
            try { buffer += decoder.decode(value, { stream: true }); }
            catch { throw failure('invalid_response'); }
            // Normalize CRLF after joining chunks, including a split CR/LF pair.
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
            }
        }
        try { buffer += decoder.decode(); }
        catch { throw failure('invalid_response'); }
        if (buffer.trim() || !stopped || !content || !model) throw failure('invalid_response');
        // This router omits [DONE] for Gemini: explicit stop plus clean EOF is required.
        return { model, choices: [{ index: 0, finish_reason: 'stop', message: { content } }], usage };
    } catch (error) {
        await reader.cancel().catch(() => {});
        error.transportUncertain = true;
        throw error;
    } finally { reader.releaseLock(); }
}

function usageView(value) {
    if (!object(value)) return null;
    const usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'])
        if (count(value[key])) usage[key] = value[key];
    for (const [key, raw] of [['reasoning_tokens', value.completion_tokens_details?.reasoning_tokens],
        ['cached_tokens', value.prompt_tokens_details?.cached_tokens]]) if (count(raw)) usage[key] = raw;
    return Object.keys(usage).length ? usage : null;
}

export class GeminiPaperProvider {
    constructor(config, state, onEvent = () => {}, options = {}) {
        if (config.geminiModel !== undefined && config.geminiModel !== GEMINI_MODEL)
            throw failure('gemini_model_not_pinned');
        if (config.geminiResolvedModel !== undefined && config.geminiResolvedModel !== GEMINI_ROUTE_MODEL)
            throw failure('gemini_route_not_pinned');
        const responseModels = config.allowedResponseModels ?? config.geminiResponseModels ?? GEMINI_RESPONSE_MODELS;
        if (!Array.isArray(responseModels) || !responseModels.length
            || responseModels.some(model => !GEMINI_RESPONSE_MODELS.includes(model)))
            throw failure('gemini_response_models_not_pinned');
        this.config = config; this.state = state; this.state.gemini ||= {};
        this.onEvent = onEvent; this.fetch = options.fetch || globalThis.fetch;
        this.pin = options.pin || (() => routerPin(config.routerDb, GEMINI_MODEL));
        this.now = options.clock || (() => Date.now());
        this.drainMs = config.geminiDrainMs ?? 120000;
        this.cooldownMs = config.geminiCooldownMs ?? 120000;
        if (![this.drainMs, this.cooldownMs].every(value => Number.isSafeInteger(value) && value > 0))
            throw failure('gemini_timeout_configuration_invalid');
        this.baseUrl = apiBase(config.routerUrl);
        this.key = config.routerKey ?? config.key;
        this.responseModels = Object.freeze([...responseModels]);
        this.active = new Map(); this.closed = false;
        this.availability = { gemini: false }; this.health = { ready: false, reason: 'preflight_required' };
    }

    getHealth() {
        return { ...this.health, ready: this.health.ready && !this.closed && !this.state.gemini.disabled
                && !this.state.gemini.recoveryAt,
            model: GEMINI_MODEL, resolvedModel: GEMINI_ROUTE_MODEL, responseModels: [...this.responseModels],
            promptHash: GEMINI_PROMPT_SHA256, informedPromptHash: INFORMED_PROMPT_SHA256,
            transportPolicy: GEMINI_TRANSPORT,
            busy: this.active.has('gemini'), disabled: this.state.gemini.disabled || null,
            recoveryAt: this.state.gemini.recoveryAt || null, recoveryReason: this.state.gemini.recoveryReason || null };
    }

    verifyPin() {
        try { if (this.pin() === GEMINI_ROUTE_MODEL) return; } catch {}
        throw failure('router_pin_changed');
    }

    async preflight() {
        const state = this.state.gemini, controller = new AbortController();
        this.availability.gemini = false;
        const timeoutMs = Math.min(5000, Math.max(1, this.config.providerReadMs || 3000));
        let timer;
        try {
            if (this.closed) throw failure('provider_closed');
            if (state.disabled && !['model_mismatch', 'router_pin_changed'].includes(state.disabled))
                throw failure('provider_disabled');
            if (this.active.size || state.pending) throw failure('provider_busy');
            if (state.recoveryAt && this.now() < state.recoveryAt) throw failure('provider_cooldown');
            if (typeof this.key !== 'string' || !this.key) throw failure('router_key_missing');
            this.verifyPin();
            const read = (async () => {
                const response = await this.fetch(this.baseUrl + '/models', { method: 'GET', redirect: 'error',
                    headers: { Authorization: 'Bearer ' + this.key, Accept: 'application/json',
                        'x-9r-internal-models-fetch': '1' }, signal: controller.signal });
                return boundedJson(response, 1024 * 1024);
            })();
            const catalog = await Promise.race([read, new Promise((resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(failure('provider_read_timeout')); }, timeoutMs);
            })]);
            if (!Array.isArray(catalog?.data) || !catalog.data.some(row => row?.id === GEMINI_MODEL))
                throw failure('gemini_model_unavailable');
            if (this.closed) throw failure('provider_closed');
            if (this.active.size || state.pending) throw failure('provider_busy');
            if (state.disabled && !['model_mismatch', 'router_pin_changed'].includes(state.disabled))
                throw failure('provider_disabled');
            this.verifyPin();
            if (state.disabled) state.disabled = null;
            state.recoveryAt = null; state.recoveryReason = null;
            this.health = { ready: true, checkedAt: this.now() };
        } catch (error) {
            const known = ['provider_closed', 'provider_disabled', 'router_key_missing', 'provider_read_timeout',
                'gemini_model_unavailable', 'provider_http_failed', 'response_too_large', 'router_pin_changed',
                'provider_busy', 'provider_cooldown'];
            this.health = { ready: false, reason: known.includes(error?.code) ? error.code : 'router_probe_failed',
                ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}), checkedAt: this.now() };
        } finally { clearTimeout(timer); }
        state.unavailable = this.health.ready ? null : this.health.reason;
        try {
            await this.onEvent('provider_preflight', { provider: 'gemini', ...this.getHealth() });
            this.availability.gemini = this.health.ready;
        }
        catch {
            state.disabled = 'provider_persistence_failed'; this.availability.gemini = false;
            this.health = { ready: false, reason: state.disabled, checkedAt: this.now() };
        }
        return this.getHealth();
    }

    evidence(snapshot, startedAt = null) {
        return { snapshotId: snapshot?.snapshotId, requestedModel: GEMINI_MODEL, resolvedModel: GEMINI_ROUTE_MODEL,
            model: null, action: 'SKIP',
            requestedAt: startedAt, receivedAt: null, latencyMs: 0, requestSubmitted: false,
            submittedAt: null, transport: null, responseBytes: 0, transportTimingMs: emptyTimings(),
            usage: null, cost: null, costBasis: 'unknown', promptHash: GEMINI_PROMPT_SHA256,
            informedPromptHash: INFORMED_PROMPT_SHA256, inputHash: snapshot?.informed?.inputHash || null,
            originalInputHash: snapshot?.informed?.originalInputHash || null,
            contextVersion: snapshot?.informed?.version || null, decisionDeadlineAt: snapshot?.decisionDeadlineAt ?? null };
    }

    transportEvidence(attempt) {
        const timing = { ...attempt.transportTimingMs };
        if (timing.firstContent !== null && timing.bodyComplete !== null)
            timing.contentToComplete = Math.max(0, timing.bodyComplete - timing.firstContent);
        return { submittedAt: attempt.submittedAt ?? null, transport: attempt.transport ?? null,
            responseBytes: attempt.responseBytes || 0, transportTimingMs: timing };
    }

    validate(snapshot) {
        const context = snapshot?.informed;
        if (typeof snapshot?.snapshotId !== 'string' || !snapshot.snapshotId || snapshot.snapshotId.length > 160
            || !Number.isFinite(snapshot.decisionDeadlineAt) || !object(context)
            || context.snapshotId !== snapshot.snapshotId || typeof context.input !== 'string'
            || Buffer.byteLength(context.input) > 32768 || context.inputHash !== digest(context.input)
            || typeof snapshot.input !== 'string' || snapshot.inputHash !== digest(snapshot.input)
            || context.originalInputHash !== snapshot.inputHash) throw failure('snapshot_identity_invalid');
        const input = JSON.parse(context.input), original = JSON.parse(snapshot.input);
        if (!object(input) || !Array.isArray(input.allowed) || new Set(input.allowed).size !== input.allowed.length
            || input.allowed.some(action => !ACTIONS.has(action)) || !object(original) || !Array.isArray(original.allowed)
            || JSON.stringify(input.allowed) !== JSON.stringify(original.allowed)
            || context.originalInput !== undefined && context.originalInput !== snapshot.input)
            throw failure('snapshot_identity_invalid');
        return new Set([...input.allowed, 'SKIP']);
    }

    normalize(row, snapshot, allowed, startedAt) {
        const base = this.evidence(snapshot, startedAt), receivedAt = this.now();
        base.receivedAt = receivedAt; base.latencyMs = Math.max(0, receivedAt - startedAt); base.requestSubmitted = true;
        if (!object(row) || !this.responseModels.includes(row.model)) throw failure('model_mismatch');
        const choice = row.choices?.[0], content = choice?.message?.content;
        if (!Array.isArray(row.choices) || row.choices.length !== 1 || choice.finish_reason !== 'stop'
            || choice.message?.tool_calls || choice.message?.refusal || typeof content !== 'string'
            || Buffer.byteLength(content) > 1024) throw failure('invalid_response');
        let parsed;
        try { parsed = JSON.parse(content); } catch { throw failure('invalid_response'); }
        if (!object(parsed) || Object.keys(parsed).some(key => !['action', 'reasonCode', 'confidence'].includes(key))
            || !ACTIONS.has(parsed.action) || parsed.reasonCode !== undefined && !GEMINI_REASON_CODES.includes(parsed.reasonCode)
            || parsed.confidence !== undefined && (!Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1))
            throw failure('invalid_response');
        const usage = usageView(row.usage), inputRate = this.config.inputUsdPerMillion, outputRate = this.config.outputUsdPerMillion;
        const cost = count(usage?.prompt_tokens) && count(usage?.completion_tokens)
            && Number.isFinite(inputRate) && inputRate >= 0 && Number.isFinite(outputRate) && outputRate >= 0
            ? (usage.prompt_tokens * inputRate + usage.completion_tokens * outputRate) / 1e6 : null;
        return { ...base, model: row.model, status: allowed.has(parsed.action) ? 'ok' : 'rejected',
            action: allowed.has(parsed.action) ? parsed.action : 'SKIP', executable: allowed.has(parsed.action),
            ...(allowed.has(parsed.action) ? {} : { reason: 'disallowed_action' }), reasonCode: parsed.reasonCode ?? null,
            confidence: parsed.confidence ?? null, confidenceKind: 'decision_confidence_not_outcome_probability',
            usage, cost, costBasis: cost === null ? 'unknown' : 'configured_rates' };
    }

    async predict(name, snapshot) {
        if (name !== 'gemini') throw failure('gemini_only');
        const state = this.state.gemini, base = this.evidence(snapshot);
        const skip = status => ({ ...base, status, executable: false });
        if (this.closed || state.disabled) return skip(state.disabled || 'provider_closed');
        if (this.active.has(name) || state.pending) return skip('provider_busy');
        if (state.recoveryAt) return { ...skip(this.now() < state.recoveryAt ? 'provider_cooldown' : 'preflight_unavailable'),
            recoveryAt: state.recoveryAt };
        if (!this.availability.gemini) return skip('preflight_unavailable');
        if (Object.hasOwn(state.attempted || {}, snapshot?.snapshotId)) return skip('snapshot_already_attempted');
        let allowed;
        try { allowed = this.validate(snapshot); } catch { return skip('snapshot_identity_invalid'); }
        const startedAt = this.now();
        try {
            if (snapshot.decisionDeadlineAt !== decisionBudget(this.config, snapshot, startedAt).decisionDeadlineAt)
                return skip('invalid_decision_budget');
        } catch { return skip('invalid_decision_budget'); }
        if (startedAt >= snapshot.decisionDeadlineAt) return skip('decision_budget_expired');
        const attempt = { controller: new AbortController(), startedAt, finished: false, submitted: false,
            evidence: this.evidence(snapshot, startedAt), transportTimingMs: emptyTimings() };
        this.active.set(name, attempt);
        state.attempted ||= {};
        Object.defineProperty(state.attempted, snapshot.snapshotId, { value: startedAt, enumerable: true, configurable: true });
        state.pending = { snapshotId: snapshot.snapshotId, startedAt, decisionDeadlineAt: snapshot.decisionDeadlineAt,
            model: GEMINI_MODEL, inputHash: snapshot.informed.inputHash, promptHash: GEMINI_PROMPT_SHA256 };
        try { await this.onEvent('provider_pending', { provider: name, ...state.pending }); }
        catch {
            state.disabled ||= 'provider_persistence_failed'; this.active.delete(name);
            return { ...skip('provider_persistence_failed'), requestedAt: startedAt };
        }
        try { this.verifyPin(); }
        catch {
            state.disabled = 'router_pin_changed'; state.pending = null;
            this.availability.gemini = false;
            try { await this.onEvent('provider_disabled', { provider: name, reason: state.disabled,
                snapshotId: snapshot.snapshotId, requestSubmitted: false }); }
            catch { state.disabled = 'provider_persistence_failed'; }
            this.active.delete(name);
            return { ...skip(state.disabled), requestedAt: startedAt };
        }
        if (this.closed || this.now() >= snapshot.decisionDeadlineAt) {
            state.pending = null;
            try { await this.onEvent('provider_drained', { provider: name, snapshotId: snapshot.snapshotId, requestSubmitted: false }); }
            catch { state.disabled = 'provider_persistence_failed'; }
            this.active.delete(name);
            if (state.disabled) return { ...skip(state.disabled), requestedAt: startedAt };
            return { ...skip(this.closed ? 'provider_closed' : 'decision_budget_expired'), requestedAt: startedAt,
                latencyMs: Math.max(0, this.now() - startedAt) };
        }
        const result = new Promise(resolve => { attempt.resolve = resolve; });
        const timedSkip = status => ({ ...this.evidence(snapshot, startedAt), status, executable: false,
            requestSubmitted: attempt.submitted, latencyMs: Math.max(0, this.now() - startedAt),
            ...this.transportEvidence(attempt) });
        attempt.decisionTimer = setTimeout(() => {
            attempt.finished = true; attempt.resolve(timedSkip('decision_timeout'));
        }, Math.max(0, snapshot.decisionDeadlineAt - this.now()));
        attempt.drainTimer = setTimeout(() => {
            this.cooldown(attempt, 'inference_drain_timeout');
            attempt.controller.abort();
            if (!attempt.finished) { attempt.finished = true; attempt.resolve(timedSkip('inference_drain_timeout')); }
        }, Math.max(0, startedAt + this.drainMs - this.now()));
        const request = { model: GEMINI_MODEL, stream: true, stream_options: { include_usage: true }, reasoning_effort: 'low', max_tokens: 128,
            messages: [{ role: 'system', content: GEMINI_PROMPT }, { role: 'user', content: snapshot.informed.input }],
            response_format: { type: 'json_object' } };
        attempt.submitted = true;
        attempt.submittedAt = this.now();
        attempt.transportTimingMs.localPreparation = Math.max(0, attempt.submittedAt - startedAt);
        const mark = (name, value) => {
            if (name === 'transport') attempt.transport = value;
            else if (attempt.transportTimingMs[name] === null)
                attempt.transportTimingMs[name] = Math.max(0, this.now() - attempt.submittedAt);
        };
        const task = (async () => {
            const response = await this.fetch(this.baseUrl + '/chat/completions', { method: 'POST', redirect: 'error',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + this.key },
                body: JSON.stringify(request), signal: attempt.controller.signal });
            mark('responseHeaders');
            let data;
            try { data = await boundedCompletion(response, this.responseModels, mark, bytes => {
                mark('firstByte'); attempt.responseBytes = (attempt.responseBytes || 0) + bytes;
            }); }
            catch (error) { if (error instanceof SyntaxError) throw failure('invalid_response'); throw error; }
            mark('bodyComplete');
            this.verifyPin();
            return { ...this.normalize(data, snapshot, allowed, startedAt), ...this.transportEvidence(attempt) };
        })();
        attempt.task = task.then(row => this.finish(attempt, snapshot, row), error => {
            if (['model_mismatch', 'router_pin_changed'].includes(error?.code)) {
                state.disabled ||= error.code; this.availability.gemini = false;
            }
            const known = ['model_mismatch', 'router_pin_changed', 'invalid_response', 'response_too_large', 'provider_http_failed'];
            if ((!known.includes(error?.code) || error?.transportUncertain) && !attempt.cooldownReason)
                this.cooldown(attempt, 'inference_transport_uncertain');
            const row = { ...timedSkip('provider_error'), receivedAt: this.now(),
                reason: known.includes(error?.code) ? error.code : attempt.cooldownReason || 'request_failed',
                httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null };
            return this.finish(attempt, snapshot, row);
        }).catch(() => {
            state.disabled ||= 'provider_persistence_failed';
            if (!attempt.finished) { attempt.finished = true; attempt.resolve(timedSkip('provider_persistence_failed')); }
        });
        return result;
    }

    async finish(attempt, snapshot, row) {
        attempt.transportSettled = true;
        clearTimeout(attempt.drainTimer);
        const late = attempt.finished || row.receivedAt >= snapshot.decisionDeadlineAt || this.closed;
        const state = this.state.gemini;
        // Aborting our HTTP stream does not prove upstream inference was cancelled.
        // Only the owner may release this local single flight after it settles.
        const ownsFlight = this.active.get('gemini') === attempt;
        if (ownsFlight && state.pending?.snapshotId === snapshot.snapshotId) state.pending = null;
        try {
            await attempt.cooldownEvent;
            if (late) await this.onEvent(row.status === 'provider_error' ? 'provider_drain_error' : 'provider_late_response',
                { provider: 'gemini', ...row, executable: false });
            await this.onEvent('provider_drained', { provider: 'gemini', snapshotId: snapshot.snapshotId,
                requestSubmitted: true, disabled: state.disabled || null, recoveryAt: state.recoveryAt || null,
                recoveryReason: state.recoveryReason || null });
            if (!late && (attempt.finished || this.now() >= snapshot.decisionDeadlineAt || this.closed))
                await this.onEvent(row.status === 'provider_error' ? 'provider_drain_error' : 'provider_late_response',
                    { provider: 'gemini', ...row, executable: false });
        } catch {
            clearTimeout(attempt.decisionTimer);
            state.disabled ||= 'provider_persistence_failed';
            if (!attempt.finished) { attempt.finished = true; attempt.resolve({ ...row, action: 'SKIP', executable: false,
                status: 'provider_persistence_failed' }); }
            if (this.active.get('gemini') === attempt) this.active.delete('gemini'); return;
        }
        clearTimeout(attempt.decisionTimer);
        if (this.active.get('gemini') === attempt) this.active.delete('gemini');
        if (!attempt.finished) {
            attempt.finished = true;
            attempt.resolve(late || this.now() >= snapshot.decisionDeadlineAt ? { ...row, action: 'SKIP', executable: false, status: 'decision_timeout',
                lateDecision: row.action, reason: 'decision_deadline_exceeded' } : row);
        }
    }

    cooldown(attempt, reason) {
        if (attempt.cooldownReason || this.active.get('gemini') !== attempt) return;
        attempt.cooldownReason = reason;
        const state = this.state.gemini;
        state.recoveryAt = this.now() + this.cooldownMs; state.recoveryReason = reason;
        this.availability.gemini = false;
        this.health = { ready: false, reason: 'provider_cooldown', checkedAt: this.now() };
        const detail = { provider: 'gemini', snapshotId: attempt.evidence.snapshotId, reason,
            recoveryAt: state.recoveryAt, requestSubmitted: attempt.submitted, cost: null, costBasis: 'unknown',
            upstreamCancellationConfirmed: false };
        try { attempt.cooldownEvent = Promise.resolve(this.onEvent('provider_cooldown', detail))
            .catch(() => { state.disabled = 'provider_persistence_failed'; }); }
        catch { state.disabled = 'provider_persistence_failed'; }
    }

    close() {
        this.closed = true; this.availability.gemini = false;
        for (const attempt of this.active.values()) {
            clearTimeout(attempt.decisionTimer); clearTimeout(attempt.drainTimer);
            if (attempt.submitted && !attempt.transportSettled) this.cooldown(attempt, 'closed_with_unknown_inference');
            attempt.controller.abort();
            if (!attempt.finished && attempt.resolve) {
                attempt.finished = true;
                attempt.resolve({ ...attempt.evidence, status: 'provider_closed', executable: false,
                    requestSubmitted: attempt.submitted, latencyMs: Math.max(0, this.now() - attempt.startedAt),
                    ...this.transportEvidence(attempt) });
            }
        }
    }
}
