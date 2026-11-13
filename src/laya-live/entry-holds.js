import { safeError } from './network.js';

const temporary = new Map([
    ['read_timeout', 'timeout'], ['transport_failed', 'transport'], ['http_server_error', 'transport'],
    ['rate_limited', 'rate_limit'], ['rate_limit_wait', 'rate_limit'], ['circuit_open', 'circuit'],
    ['rpc_endpoint_forbidden', 'transport'], ['rpc_unavailable', 'transport'], ['rpc_read_rejected', 'transport'],
    ['rpc_missing_block', 'transport'], ['rpc_reference_unavailable', 'transport'],
    ['rpc_missing_reference_block', 'transport'], ['rpc_snapshot_behind', 'transport'],
]);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

// Call only at an identified read boundary. A transport failure after a write
// does not prove whether that write happened and must never enter this path.
export function temporaryReadFailure(error) {
    const e = error?.name === 'OperationalError' && typeof error.code === 'string'
        && typeof error.category === 'string' ? error : safeError(error);
    return temporary.get(e.code) === e.category;
}

// Gamma's exact current-market slug lookup can briefly return 404 at opening.
// This is not a general transport/4xx exception: only a read started and failed
// in the first 30 seconds of the same five-minute market may use it.
export function openingMarketReadUnavailable(error, attemptedAt, failedAt = attemptedAt) {
    if (!timestamp(attemptedAt) || !timestamp(failedAt) || failedAt < attemptedAt
        || failedAt - Math.floor(attemptedAt / 300000) * 300000 > 30000) return false;
    return marketDiscoveryUnavailable(error);
}

export function marketDiscoveryUnavailable(error) {
    const diagnostic = error?.name === 'OperationalError' ? error : safeError(error);
    return diagnostic.code === 'http_rejected' && diagnostic.category === 'api_rejection'
        && diagnostic.httpStatus === 404 && diagnostic.endpoint === 'gamma' && diagnostic.stage === 'market_discovery';
}

export function entryHeld(state) {
    return !!state.liveRiskStop || !!state.entryHolds && (typeof state.entryHolds !== 'object'
        || Array.isArray(state.entryHolds) || Object.keys(state.entryHolds).length > 0);
}

export function readRetryReady(state, key, now = Date.now()) {
    const hold = state.entryHolds?.[key];
    return !hold || hold.retryable === true && timestamp(now) && timestamp(hold.retryAt) && now >= hold.retryAt;
}

export function holdEntry(store, key, error, { now = Date.now(), delayMs = 5000,
    retryable = false, endpointState } = {}) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || !timestamp(now)) throw new Error('invalid_live_entry_hold');
    const state = store.state;
    if (state.entryHolds && (typeof state.entryHolds !== 'object' || Array.isArray(state.entryHolds))) {
        store.stop('invalid_live_entry_hold_state'); return null;
    }
    const holds = state.entryHolds ||= {}, previous = holds[key];
    // A transient response can never erase a persistent diagnosis for a key.
    if (previous && previous.retryable !== true) return previous;
    const diagnostic = safeError(error), attempts = (previous?.attempts || 0) + 1;
    const base = Math.min(60000, Math.max(1000, Number.isFinite(delayMs) ? delayMs : 5000));
    const delay = Math.min(60000, base * 2 ** Math.min(attempts - 1, 6));
    const retryAt = Math.ceil(Math.max(now + delay, now + (diagnostic.retryAfter || 0) * 1000,
        timestamp(endpointState?.openUntil) ? endpointState.openUntil : 0,
        timestamp(endpointState?.notBefore) ? endpointState.notBefore : 0));
    const record = holds[key] = { retryable: retryable === true, firstAt: previous?.firstAt ?? now,
        failedAt: now, retryAt, attempts, error: diagnostic };
    if (!previous || previous.error?.code !== diagnostic.code || previous.retryable !== record.retryable)
        store.event('live_entry_hold', { key, ...record });
    else store.save();
    return record;
}

export function clearEntryHold(store, key, { now = Date.now(), proof } = {}) {
    const holds = store.state.entryHolds, hold = holds?.[key];
    if (!hold || hold.retryable !== true || !timestamp(now) || typeof proof !== 'string' || !proof) return false;
    delete holds[key];
    store.event('live_entry_hold_recovered', { key, proof, outageMs: Math.max(0, now - hold.firstAt), attempts: hold.attempts });
    return true;
}
