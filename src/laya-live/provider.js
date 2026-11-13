import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { LayaProvider } from '../laya-pilot/provider.js';
import { LiveDecisionProtocol, decisionProtocolView } from './decision-protocol.js';
import { OperationalError, safeError } from '../restart/network.js';

const LOOP_RESOLUTION_MS = 20;
const rounded = value => Number.isFinite(value) ? Math.round(Math.max(0, value) * 1000) / 1000 : null;

// The shared provider measures through token validation and HTTP decoding.
// Capture its local start before durable drain/decision logging delays the
// caller. Remote response bodies cannot supply either timestamp.
export class LayaLiveProvider extends LayaProvider {
    constructor(config, state, onEvent = () => {}, options = {}) {
        const decisionProtocol = config.decisionProtocol === undefined ? null : new LiveDecisionProtocol(config, state, options);
        super(config, state, onEvent, decisionProtocol?.options || options);
        this.decisionProtocol = decisionProtocol;
        this.timingContext = new AsyncLocalStorage();
        this.timingAttempts = new Set();
        const counter = this.counter, fetch = this.fetch.bind(this);
        // Keep the shared tokenizer's receiver, identity checks, and lifecycle.
        this.counter = {
            start: (...args) => counter.start(...args),
            close: (...args) => counter.close(...args),
            count: async (...args) => {
                const timing = this.timingContext.getStore();
                if (!timing?.admitted) return counter.count(...args);
                timing.stage = 'tokenizer'; timing.stageStarted = performance.now();
                try { return await counter.count(...args); }
                finally {
                    timing.tokenizerMs = performance.now() - timing.stageStarted;
                    timing.stage = 'local';
                }
            },
        };
        this.fetch = async (...args) => {
            const timing = this.timingContext.getStore();
            if (!timing?.admitted) return fetch(...args);
            timing.stage = 'inference_headers'; timing.stageStarted = timing.httpStarted = performance.now();
            let response;
            try { response = await fetch(...args); }
            finally {
                timing.inferenceHeadersMs = performance.now() - timing.httpStarted;
                timing.inferenceHttpMs = timing.inferenceHeadersMs;
                timing.stage = 'local';
            }
            // Only the inherited prediction consumes this facade. Preflight
            // receives the original response, including retry-after headers.
            return { ok: response.ok, status: response.status, json: async () => {
                timing.stage = 'inference_body'; timing.stageStarted = performance.now();
                try { return await response.json(); }
                finally {
                    timing.inferenceBodyMs = performance.now() - timing.stageStarted;
                    timing.inferenceHttpMs = performance.now() - timing.httpStarted;
                    timing.stage = 'local';
                }
            } };
        };
        let sink = this.onEvent;
        // The live runner replaces onEvent after preflight. Preserve that
        // contract and enrich existing events without adding durable writes.
        const emit = (type, detail) => {
            detail = this.decisionProtocol?.event(type, detail) || detail;
            const timing = this.timingContext.getStore();
            if (timing && type === 'provider_pending') {
                timing.admitted = true; timing.started = performance.now(); timing.stage = 'local';
                timing.loopStart = performance.eventLoopUtilization();
                timing.loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
                timing.loopDelay.enable(); this.timingAttempts.add(timing);
            }
            if (timing?.admitted && ['provider_drained', 'provider_late_response', 'provider_drain_error'].includes(type)) {
                if (type === 'provider_drained') {
                    timing.stage = 'drained'; this.finishTiming(timing);
                }
                detail = { ...detail, snapshotId: timing.snapshotId, timing: this.timingSnapshot(timing, type) };
            }
            const before = performance.now();
            try { return sink(type, detail); }
            finally { if (timing?.admitted) timing.eventCallbackMs += performance.now() - before; }
        };
        Object.defineProperty(this, 'onEvent', { configurable: true, get: () => emit, set: value => { sink = value; } });
    }

    async read(...args) {
        try { return await super.read(...args); }
        catch (error) {
            const status = error?.httpStatus;
            const detail = { httpStatus: status,
                ...(Number.isFinite(error?.retryAfterMs) ? { retryAfter: Math.max(0, error.retryAfterMs / 1000) } : {}) };
            const classified = status === 429 ? new OperationalError('rate_limited', 'rate_limit', detail)
                : status >= 500 ? new OperationalError('http_server_error', 'transport', detail)
                : status >= 400 ? new OperationalError('http_rejected', 'api_rejection', detail)
                : error?.message === 'provider_retry_after'
                    ? new OperationalError('rate_limit_wait', 'rate_limit', {
                        retryAfter: Math.max(0, ((this.readBackoff.get(args[0]) || 0) - Date.now()) / 1000) }) : error;
            this.preflightReadError = safeError(classified, { stage: 'provider_health', endpoint: 'laya' });
            throw error;
        }
    }

    async preflight() {
        this.preflightReadError = null;
        const result = await super.preflight();
        // Preserve HTTP/transport evidence for runtime retry decisions. A
        // generic probe reason cannot distinguish a 503 from authorization.
        if (!result.laya.ready && this.preflightReadError) result.laya.error = this.preflightReadError;
        if (this.decisionProtocol) result.laya.decisionProtocol = decisionProtocolView();
        return result;
    }

    finishTiming(timing) {
        timing.loopDelay?.disable(); this.timingAttempts.delete(timing);
    }

    timingSnapshot(timing, observation) {
        const now = performance.now(), elapsedMs = now - timing.started;
        const tokenizerMs = timing.stage === 'tokenizer' ? now - timing.stageStarted : timing.tokenizerMs;
        const inferenceHeadersMs = timing.stage === 'inference_headers' ? now - timing.httpStarted : timing.inferenceHeadersMs;
        const inferenceBodyMs = timing.stage === 'inference_body' ? now - timing.stageStarted : timing.inferenceBodyMs;
        const inferenceHttpMs = ['inference_headers', 'inference_body'].includes(timing.stage)
            ? now - timing.httpStarted : timing.inferenceHttpMs;
        const loop = performance.eventLoopUtilization(timing.loopStart), histogram = timing.loopDelay;
        // HTTP spans include server queueing/compute and network/body decode;
        // the client cannot infer server-only model execution from these spans.
        // Native loop-delay samples include their configured sampling interval.
        return { observation, stage: timing.stage, elapsedMs: rounded(elapsedMs),
            tokenizerMs: rounded(tokenizerMs), inferenceHeadersMs: rounded(inferenceHeadersMs),
            inferenceBodyMs: rounded(inferenceBodyMs), inferenceHttpMs: rounded(inferenceHttpMs),
            localOverheadMs: rounded(elapsedMs - (tokenizerMs || 0) - (inferenceHttpMs || 0)),
            eventCallbackMs: rounded(timing.eventCallbackMs), eventLoopActiveMs: rounded(loop.active),
            eventLoopIdleMs: rounded(loop.idle), eventLoopUtilization: rounded(loop.utilization),
            eventLoopDelaySampleCount: histogram.count, eventLoopDelayResolutionMs: LOOP_RESOLUTION_MS,
            eventLoopDelayMaxMs: histogram.count ? rounded(histogram.max / 1e6) : null };
    }

    async predict(name, snapshot) {
        if (name !== 'laya') throw new Error('laya_only');
        let attempt;
        if (this.decisionProtocol) {
            try { attempt = this.decisionProtocol.attempt(snapshot); }
            catch (error) { return this.decisionProtocol.invalidSnapshot(snapshot, error); }
        }
        const timing = { snapshotId: snapshot.snapshotId, admitted: false, tokenizerMs: null,
            inferenceHeadersMs: null, inferenceBodyMs: null, inferenceHttpMs: null, eventCallbackMs: 0 };
        const predict = () => this.timingContext.run(timing, async () => {
            try {
                const pending = super.predict(name, snapshot);
                const marker = this.state[name]?.pending;
                const requestedAt = marker?.snapshotId === snapshot.snapshotId ? marker.startedAt : null;
                let decision = await pending;
                if (this.decisionProtocol) decision = this.decisionProtocol.decision(decision, attempt);
                if (timing.admitted) decision = { ...decision, timing: this.timingSnapshot(timing, 'decision') };
                if (decision.status !== 'ok' || !Number.isFinite(requestedAt)
                    || !Number.isFinite(decision.latencyMs) || decision.latencyMs < 0) return decision;
                return { ...decision, requestedAt, receivedAt: requestedAt + decision.latencyMs };
            } finally {
                if (!this.active.has(name)) this.finishTiming(timing);
            }
        });
        return this.decisionProtocol ? this.decisionProtocol.context.run(attempt, predict) : predict();
    }

    close() {
        for (const timing of this.timingAttempts) this.finishTiming(timing);
        super.close();
    }
}
