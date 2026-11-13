// Diagnostic wrappers only. No trading client, engine, ledger mutation, retries,
// or changes to the fingerprinted experiment runtime.
import { performance } from 'node:perf_hooks';

const ms = value => Math.round(value * 1000) / 1000;
export function safeWindow(now, ledger, config) {
    const phaseMs = ((now % 300000) + 300000) % 300000;
    if (ledger.id !== config.id) return 'baseline_changed';
    if (ledger.frozenAt || now >= config.deadline) return 'deadline_or_frozen';
    // Production persists a heartbeat every 60s, with asynchronous I/O jitter.
    if (!Number.isFinite(ledger.lastHeartbeatAt) || now - ledger.lastHeartbeatAt > 90000
        || ledger.lastHeartbeatAt > now + 2000) return 'heartbeat_stale';
    if (Object.values(ledger.providers).some(p => p.pending)) return 'production_inference_pending';
    if (Object.values(ledger.providers).some(p => p.disabled)) return 'production_provider_disabled';
    // The first production decision is 210s into the market. Even a full 30s
    // drain must finish >=60s beforehand. Avoid turnover/startup too.
    if (phaseMs < 15000 || phaseMs + config.layaDrainMs + 60000 > 210000) return 'outside_quiet_window';
    return null;
}

export class StageProfiler {
    constructor({ fetch, counter, pin, now = () => performance.now() }) {
        this.rawFetch = fetch; this.rawCounter = counter; this.rawPin = pin; this.now = now;
        this.current = new Map();
        this.counter = {
            start: () => counter.start(), close: () => counter.close(),
            count: async input => {
                const row = this.current.get('laya'), start = now();
                try { return await counter.count(input); }
                finally { if (row) row.tokenizerMs = ms(now() - start); }
            },
        };
        this.pin = () => {
            const row = this.current.get('9router'), start = now();
            try { return pin(); }
            finally { if (row) row.pinChecksMs.push(ms(now() - start)); }
        };
        this.fetch = async (url, options) => {
            if (options?.method !== 'POST') return fetch(url, options);
            const name = url.endsWith('/v1/systemone') ? 'laya' : '9router';
            const row = this.current.get(name);
            if (!row) throw new Error('profile_request_without_sample');
            if (row.submits) throw new Error('profile_duplicate_submit');
            row.submits = 1;
            const start = now(); row.fetchAt = start;
            row.localPreparationMs = ms(start - row.started - row.tokenizerMs);
            try {
                const response = await fetch(url, options);
                row.httpHeadersWaitMs = ms(now() - start); row.httpStatus = response.status;
                // Do not copy arbitrary headers, URLs, request/response bodies,
                // signed payloads, API keys, or exception messages into evidence.
                const timing = response.headers?.get('server-timing') || '';
                row.serverTiming = [...timing.matchAll(/(?:^|,)\s*([a-zA-Z][\w-]{0,40})\s*;\s*dur=(\d+(?:\.\d+)?)/g)]
                    .map(m => ({ metric: m[1], durationMs: Number(m[2]) }));
                return { ok: response.ok, status: response.status, json: async () => {
                    const readStart = now();
                    const body = await response.text(); row.bodyReadMs = ms(now() - readStart);
                    const parseStart = now();
                    try {
                        const data = JSON.parse(body);
                        row.responseModel = typeof data.routing?.model === 'string' ? data.routing.model : data.model;
                        row.responseModel = typeof row.responseModel === 'string' && /^[\w./-]{1,100}$/.test(row.responseModel)
                            ? row.responseModel : null;
                        row.inputTokens = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? null;
                        row.outputTokens = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? null;
                        return data;
                    } finally { row.jsonParseMs = ms(now() - parseStart); row.parsedAt = now(); }
                } };
            } catch (error) {
                row.httpHeadersWaitMs ??= ms(now() - start);
                row.transportFailed = true;
                throw error;
            }
        };
    }
    begin(provider, snapshot) {
        if (this.current.has(provider)) throw new Error('profile_sample_not_drained');
        const row = { provider, snapshotId: snapshot.snapshotId, started: this.now(), submits: 0,
            tokenizerMs: 0, pinChecksMs: [], httpStatus: null, serverTiming: [] };
        this.current.set(provider, row); return row;
    }
    event(type, detail) {
        const row = this.current.get(detail.provider); if (!row) return;
        if (type === 'provider_late_response') {
            row.actualProviderLatencyMs = detail.latencyMs; row.lateStatus = detail.status;
        }
        if (type === 'provider_drain_error') { row.drainError = true; row.errorCode = detail.reason; }
        if (type === 'provider_disabled') row.disabled = detail.reason;
        if (type === 'provider_drained') {
            row.completed = this.now(); row.totalMs = ms(row.completed - row.started);
            row.responseValidationMs = row.parsedAt === undefined ? null : ms(row.completed - row.parsedAt);
        }
    }
    finish(provider, decision) {
        const row = this.current.get(provider);
        if (!row || row.completed === undefined) throw new Error('profile_sample_not_drained');
        row.decisionStatus = decision.status; row.decisionWaitingMs = decision.latencyMs;
        if (decision.status === 'ok') row.actualProviderLatencyMs = decision.latencyMs;
        const { started, fetchAt, parsedAt, completed, ...safe } = row;
        this.current.delete(provider); return safe;
    }
}

export function percentiles(values) {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
    // Nearest rank: with a tiny sample p95 is intentionally the maximum.
    return { n: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null,
        p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
}
