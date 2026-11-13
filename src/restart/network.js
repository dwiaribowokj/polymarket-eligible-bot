import { setTimeout as sleep } from 'node:timers/promises';

export const TRANSPORT = Object.freeze({ timeoutMs: 3000, retries: 1, retryMinMs: 500, retryMaxMs: 1000,
    circuitFailures: 3, circuitMs: 30000, clockMs: 30000, markMs: 5000, payoutMs: 15000, payoutMaxMs: 60000 });

export class OperationalError extends Error {
    constructor(code, category = 'validation', detail = {}) {
        super(code); this.name = 'OperationalError'; this.code = code; this.category = category;
        Object.assign(this, detail);
    }
}

const nativeCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'NETWORK_ERROR', 'TIMEOUT']);
const localErrors = new Map([
    ['Stale orderbook', ['stale_book', 'stale_data']],
    ['Market constraints changed', ['market_constraints_changed', 'validation']],
    ['Gamma and CLOB metadata disagree', ['metadata_mismatch', 'validation']],
    ['Invalid server clock', ['invalid_server_clock', 'stale_data']],
    ['Clock or latency invalid', ['invalid_server_clock', 'stale_data']],
]);

export function classifyError(error) {
    if (error instanceof OperationalError) return error;
    const chain = [], seen = new Set();
    for (let e = error; e && chain.length < 6 && !seen.has(e); e = e.cause || e.error) {
        seen.add(e); chain.push(e);
    }
    const operational = chain.find(e => e instanceof OperationalError);
    if (operational) return operational;
    const httpStatus = chain.map(e => Number(e.status || e.statusCode || e.response?.status))
        .find(n => Number.isInteger(n) && n >= 400 && n <= 599);
    const retryAfter = chain.map(e => Number(e.retryAfter)).find(n => Number.isFinite(n) && n >= 0);
    let code = 'request_failed', category = 'unknown';
    const local = localErrors.get(error?.message);
    if (local) [code, category] = local;
    else if (httpStatus === 429 || chain.some(e => e.name === 'RateLimitError')) {
        code = 'rate_limited'; category = 'rate_limit';
    } else if (httpStatus >= 500) { code = 'http_server_error'; category = 'transport'; }
    else if (httpStatus) { code = 'http_rejected'; category = 'api_rejection'; }
    else if (chain.some(e => ['TimeoutError', 'AbortError'].includes(e.name) || ['TIMEOUT', 'ETIMEDOUT'].includes(e.code))) {
        code = 'read_timeout'; category = 'timeout';
    } else if (chain.some(e => e.name === 'TransportError' || nativeCodes.has(e.code)
        || e instanceof TypeError && e.message === 'fetch failed')) { code = 'transport_failed'; category = 'transport'; }
    else if (chain.some(e => e.code === 'CALL_EXCEPTION')) { code = 'contract_call_failed'; category = 'contract'; }
    else if (chain.some(e => ['UnexpectedResponseError', 'UserInputError', 'SyntaxError'].includes(e.name))) {
        code = 'invalid_api_data'; category = 'validation';
    }
    return new OperationalError(code, category, { httpStatus, retryAfter });
}

export function safeError(error, detail = {}) {
    const e = classifyError(error);
    const result = { name: 'OperationalError', code: e.code, category: e.category };
    for (const field of ['stage', 'endpoint']) {
        const value = detail[field] ?? e[field];
        if (typeof value === 'string' && /^[a-z0-9_-]{1,64}$/.test(value)) result[field] = value;
    }
    for (const field of ['httpStatus', 'durationMs', 'attempts', 'dataAgeMs', 'retryAfter']) {
        const value = detail[field] ?? e[field];
        if (Number.isFinite(value) && value >= 0) result[field] = Math.round(value * 1000) / 1000;
    }
    return result;
}

export const retryable = error => ['transport', 'timeout', 'rate_limit'].includes(classifyError(error).category);

export class ReadCoordinator {
    constructor(options = {}) {
        this.policy = { ...TRANSPORT, ...options.policy }; this.now = options.now || Date.now;
        this.sleep = options.sleep || sleep; this.random = options.random || Math.random;
        this.onEvent = options.onEvent || (() => {}); this.inflight = new Map(); this.endpoints = new Map();
    }
    event(type, detail) { this.onEvent({ type, ...detail }); }
    state(endpoint) {
        if (!this.endpoints.has(endpoint)) this.endpoints.set(endpoint, { streak: 0, openUntil: 0, probe: false, outageAt: null });
        return this.endpoints.get(endpoint);
    }
    run(key, endpoint, stage, task, options = {}) {
        if (this.inflight.has(key)) return this.inflight.get(key);
        const pending = this.perform(endpoint, stage, task, options).finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending); return pending;
    }
    async perform(endpoint, stage, task, { deadline = Infinity, retries = this.policy.retries } = {}) {
        const state = this.state(endpoint), started = this.now(); let attempts = 0, probing = false;
        if (this.now() < (state.notBefore || 0)) throw new OperationalError('rate_limit_wait', 'rate_limit',
            { endpoint, stage, attempts: 0, durationMs: 0, retryAfter: (state.notBefore - this.now()) / 1000 });
        if (state.openUntil) {
            if (this.now() < state.openUntil || state.probe) throw new OperationalError('circuit_open', 'circuit',
                { endpoint, stage, attempts: 0, durationMs: 0 });
            state.probe = true; probing = true;
        }
        try {
            for (let attempt = 0; attempt <= (probing ? 0 : retries); attempt++) {
                if (this.now() >= deadline) throw new OperationalError('entry_window_elapsed', 'opportunity', { stage, endpoint, attempts });
                attempts++;
                const controller = new AbortController();
                const budget = Math.min(this.policy.timeoutMs, deadline - this.now());
                let timer;
                try {
                    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
                        reject(budget < this.policy.timeoutMs
                            ? new OperationalError('entry_window_elapsed', 'opportunity')
                            : new OperationalError('read_timeout', 'timeout'));
                        controller.abort();
                    }, budget); });
                    const value = await Promise.race([Promise.resolve().then(() => task(controller.signal, attempt)), timeout]);
                    if (this.now() >= deadline) throw new OperationalError('entry_window_elapsed', 'opportunity');
                    if (state.outageAt !== null) this.event('endpoint_recovered', { endpoint, stage,
                        outageMs: Math.max(0, this.now() - state.outageAt) });
                    state.streak = 0; state.openUntil = 0; state.outageAt = null;
                    return value;
                } catch (error) {
                    clearTimeout(timer);
                    const e = classifyError(error);
                    Object.assign(e, { endpoint, stage, attempts, durationMs: Math.max(0, this.now() - started) });
                    if (retryable(e)) {
                        if (e.retryAfter > 0) state.notBefore = Math.max(state.notBefore || 0, this.now() + e.retryAfter * 1000);
                        state.outageAt ??= this.now(); state.streak++;
                        if (probing || state.streak >= this.policy.circuitFailures) {
                            state.openUntil = this.now() + this.policy.circuitMs;
                            this.event('circuit_opened', { endpoint, stage, until: state.openUntil });
                        }
                    }
                    this.event('read_failed', { error: safeError(e) });
                    if (!retryable(e) || attempt >= retries || probing || state.openUntil > this.now()) throw e;
                    const jitter = this.policy.retryMinMs + this.random() * (this.policy.retryMaxMs - this.policy.retryMinMs);
                    const pause = Math.max(jitter, (e.retryAfter || 0) * 1000);
                    if (this.now() + pause >= deadline) throw new OperationalError('entry_window_elapsed', 'opportunity',
                        { endpoint, stage, attempts, durationMs: this.now() - started });
                    if (pause > this.policy.timeoutMs) {
                        // Keep ticks and deadline handling responsive while respecting a long Retry-After.
                        state.openUntil = Math.max(state.openUntil, this.now() + pause);
                        this.event('rate_limit_deferred', { endpoint, stage, until: state.openUntil });
                        throw e;
                    }
                    await this.sleep(pause);
                } finally { clearTimeout(timer); }
            }
        } finally { if (probing) state.probe = false; }
    }
}

export async function fetchResponse(url, options = {}) {
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(TRANSPORT.timeoutMs),
        headers: { 'User-Agent': 'polymarket-reactivation/1.0', ...options.headers } });
    if (!response.ok) {
        const header = response.headers.get('retry-after');
        const retryAfter = header === null ? undefined : /^\d+(\.\d+)?$/.test(header) ? Number(header)
            : Math.max(0, (Date.parse(header) - Date.now()) / 1000);
        throw classifyError({ status: response.status, retryAfter });
    }
    return response;
}
