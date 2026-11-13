import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { ProtocolCounter } from '../laya-tuning/counter.js';
import { buildProtocolRequest, parseProtocolResponse, verifyProtocolContext } from '../laya-tuning/protocol.js';

const VARIANT = 'candidate-v2';
// Questions do not depend on state. Derive their identity without exposing a
// fabricated market snapshot in config, preflight, or provider events.
const metadataInput = JSON.stringify({ allowed: ['SKIP'] });
const metadataProtocol = buildProtocolRequest({ snapshotId: 'protocol-metadata', input: metadataInput,
    inputHash: createHash('sha256').update(metadataInput).digest('hex') }, { variantId: VARIANT });
const METADATA = Object.freeze(Object.fromEntries(['protocolVersion', 'variantId', 'promptVersion',
    'promptHash', 'questionsHash'].map(key => [key, metadataProtocol[key]])));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeReason = error => /^[a-z_]+$/.test(error?.message) ? error.message : 'protocol_input_invalid';

/** Stable public identity; inputHash and requestHash belong to actual attempts. */
export function decisionProtocolView() { return { ...METADATA }; }

function protocolIdentity(protocol) {
    return { ...METADATA, snapshotId: protocol.snapshotId, inputHash: protocol.inputHash,
        requestHash: protocol.requestHash };
}

function usageView(raw) {
    if (!isObject(raw)) return null;
    return Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']
        .filter(key => Number.isSafeInteger(raw[key]) && raw[key] >= 0).map(key => [key, raw[key]]));
}

/** Adapt only LIVE. The inherited manager retains admission, durable pending
 * events, the decision deadline, and the single late drain without retries. */
export class LiveDecisionProtocol {
    constructor(config, state, options) {
        if (!isObject(config.decisionProtocol) || Object.entries(METADATA)
            .some(([key, value]) => config.decisionProtocol[key] !== value))
            throw new Error('live_decision_protocol_mismatch');
        this.context = new AsyncLocalStorage();
        const counter = options.counter || new ProtocolCounter(config);
        const request = options.fetch || globalThis.fetch;
        const binding = this;
        this.options = { ...options, counter: {
            start: async (...args) => {
                const info = await counter.start(...args);
                if (typeof info?.identity !== 'string' || !info.identity)
                    throw new Error('protocol_tokenizer_identity_mismatch');
                return info;
            },
            close: (...args) => counter.close(...args),
            count: async input => {
                const attempt = binding.context.getStore();
                try {
                    if (!attempt || input !== attempt.protocol.request.state) throw new Error('protocol_state_mismatch');
                    attempt.verified = await verifyProtocolContext(attempt.protocol, counter,
                        { expectedIdentity: state.laya?.tokenizerIdentity });
                    return attempt.verified;
                } catch (error) {
                    if (attempt) attempt.failureReason = safeReason(error);
                    throw new Error('context_or_artifact_invalid');
                }
            },
        }, fetch: async function(url, init) {
            const attempt = binding.context.getStore();
            if (!attempt) return request.call(this, url, init);
            let inherited;
            try { inherited = JSON.parse(init?.body); } catch { /* rejected below */ }
            if (!attempt.verified || url !== config.layaUrl + '/v1/systemone' || init?.method !== 'POST'
                || !isObject(inherited) || inherited.model !== attempt.protocol.request.model
                || inherited.state !== attempt.protocol.request.state
                || JSON.stringify(Object.keys(inherited).sort()) !== JSON.stringify(['model', 'questions', 'state'])) {
                attempt.failureReason = 'protocol_request_mismatch';
                // This facade has not sent anything. Use an inherited local
                // validation category, which cannot mark transport uncertain.
                throw new Error('invalid_response');
            }
            const response = await request.call(this, url, { ...init, body: JSON.stringify(attempt.protocol.request) });
            return { ok: response.ok, status: response.status, headers: response.headers, json: async () => {
                const raw = await response.json();
                let decoded = parseProtocolResponse(raw, attempt.protocol);
                const modelInputTokens = raw?.usage?.input_tokens;
                const tokenUsageMatches = Number.isSafeInteger(modelInputTokens) && modelInputTokens === attempt.verified.tokens;
                const usageValid = isObject(raw?.usage) && ['input_tokens', 'output_tokens', 'total_tokens',
                    'prompt_tokens', 'completion_tokens'].every(key => raw.usage[key] === undefined
                        || Number.isSafeInteger(raw.usage[key]) && raw.usage[key] >= 0);
                if (!tokenUsageMatches || !usageValid) decoded = { ...decoded, action: 'SKIP', executable: false,
                    status: 'invalid', reason: decoded.reason || (usageValid ? 'token_usage_mismatch' : 'token_usage_invalid') };
                attempt.response = { ...decoded, modelInputTokens: Number.isSafeInteger(modelInputTokens) ? modelInputTokens : null,
                    tokenUsageMatches };
                if (decoded.reason === 'model_mismatch') throw new Error('model_mismatch');
                // The shared normalizer sees only a validated no-entry/action
                // facade. Enrichment below retains the actual parser verdict.
                return { model: decoded.model || attempt.protocol.request.model,
                    answers: { action: { choice: decoded.action,
                        ...(decoded.confidence !== null ? { answer_confidence: decoded.confidence } : {}) } },
                    usage: usageView(raw?.usage) };
            } };
        } };
    }

    attempt(snapshot) {
        return { protocol: buildProtocolRequest(snapshot, { variantId: VARIANT }), verified: null, response: null };
    }

    invalidSnapshot(snapshot, error) {
        return { ...METADATA, snapshotId: snapshot?.snapshotId, action: 'SKIP', status: 'invalid', executable: false,
            model: null, latencyMs: 0, cost: 0, reason: safeReason(error) };
    }

    decision(row, attempt = this.context.getStore()) {
        if (!attempt) return row;
        const decoded = attempt.response;
        return { ...row, ...protocolIdentity(attempt.protocol), ...(decoded || {}),
            status: row.status === 'ok' ? decoded?.status || 'invalid' : row.status,
            action: row.status === 'ok' ? decoded?.action || 'SKIP' : 'SKIP',
            executable: row.status === 'ok' && decoded?.executable === true,
            reason: decoded?.reason || attempt.failureReason || row.reason || null,
            ...(attempt.verified ? { context: attempt.verified } : {}) };
    }

    event(type, detail) {
        if (type === 'provider_preflight') return { ...detail, decisionProtocol: decisionProtocolView() };
        const attempt = this.context.getStore();
        if (!attempt || !['provider_pending', 'provider_drained', 'provider_late_response', 'provider_drain_error'].includes(type))
            return detail;
        return ['provider_late_response', 'provider_drain_error'].includes(type) ? this.decision(detail, attempt)
            : { ...detail, ...protocolIdentity(attempt.protocol) };
    }
}
