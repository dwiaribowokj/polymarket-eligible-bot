import { OperationalError, safeError } from '../restart/network.js';
import { clearEntryHold, holdEntry } from './entry-holds.js';

export const LIVE_CLOCK = Object.freeze({ freshMs: 30000, refreshAheadMs: 10000, retryMs: 5000, retryMaxMs: 60000 });

const temporary = new Map([
    ['read_timeout', 'timeout'], ['transport_failed', 'transport'], ['http_server_error', 'transport'],
    ['rate_limited', 'rate_limit'], ['rate_limit_wait', 'rate_limit'], ['circuit_open', 'circuit'],
]);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const continuous = (settings, state) => settings.continuousTrading === true
    && state.mode === 'pilot' && state.decisionProvider === 'eligible';
const clockResponseFailure = error => {
    const e = safeError(error);
    return (e.code === 'invalid_server_clock' && e.category === 'stale_data'
        || e.code === 'invalid_api_data' && e.category === 'validation')
        && (!e.stage || e.stage === 'server_time') && (!e.endpoint || e.endpoint === 'clob');
};

export function temporaryClockFailure(error) {
    const e = safeError(error);
    return temporary.get(e.code) === e.category
        && (!e.stage || e.stage === 'server_time') && (!e.endpoint || e.endpoint === 'clob');
}

// A successful sample is trusted only in this process. Outage diagnosis and
// bounded retry deadlines survive restart; an outage never becomes a loss.
export class LiveClockGate {
    constructor(settings, store, client) {
        Object.assign(this, { settings, store, client });
        this.verifiedAt = null; this.pending = null;
    }
    fresh(now = Date.now()) {
        const state = this.store.state.liveClock;
        return state?.status === 'verified' && timestamp(now) && timestamp(this.verifiedAt)
            && now >= this.verifiedAt && now - this.verifiedAt < LIVE_CLOCK.freshMs;
    }
    check({ proactive = false } = {}) {
        this.pending ||= this.probe({ proactive }).finally(() => { this.pending = null; });
        return this.pending;
    }
    fail(error, now, outageAt = null, preserveState = false) {
        const previous = this.store.state.liveClock, diagnostic = safeError(error, { stage: 'server_time', endpoint: 'clob' });
        this.verifiedAt = null;
        if (preserveState) this.invalidState = true;
        if (!preserveState) this.store.state.liveClock = { status: 'failed', outageAt, failedAt: now, error: diagnostic };
        this.store.state.failures++;
        this.store.stop('operational_check_failed');
        if (previous?.status !== 'failed') this.store.event('live_clock_failed', { error: diagnostic,
            outageMs: timestamp(outageAt) && timestamp(now) ? Math.max(0, now - outageAt) : 0 });
        return false;
    }
    async probe({ proactive = false } = {}) {
        if (this.invalidState) return false;
        const now = Date.now(), previous = this.store.state.liveClock;
        if (!timestamp(now)) return this.fail(new OperationalError('invalid_server_clock', 'stale_data'), now);
        const retryResponses = continuous(this.settings, this.store.state), holds = this.store.state.entryHolds;
        if (retryResponses && holds != null && (typeof holds !== 'object' || Array.isArray(holds)
            || holds.clock != null && (typeof holds.clock !== 'object' || Array.isArray(holds.clock)
                || ![true, false].includes(holds.clock.retryable)
                || ![holds.clock.firstAt, holds.clock.failedAt, holds.clock.retryAt].every(timestamp)
                || !Number.isSafeInteger(holds.clock.attempts) || holds.clock.attempts < 1)))
            return this.fail(new OperationalError('invalid_live_entry_hold_state', 'validation'), now, null, true);
        if (retryResponses && holds?.clock?.retryable === false) return false;
        if (previous?.status === 'failed') return false;
        if (previous && (!['verified', 'waiting'].includes(previous.status)
            || previous.status === 'waiting' && (!timestamp(previous.outageAt) || previous.outageAt > now
                || !timestamp(previous.retryAt))
            || retryResponses && (previous.status === 'verified' && !timestamp(previous.verifiedAt)
                || previous.status === 'waiting' && (!Number.isSafeInteger(previous.attempts) || previous.attempts < 1))))
            return this.fail(new OperationalError('invalid_live_clock_state', 'validation'), now, null, retryResponses);
        const outageAt = previous?.status === 'waiting' ? previous.outageAt : null;
        const refresh = proactive && [this.verifiedAt, this.client.clock?.at].some(at => timestamp(at)
            && now - at >= LIVE_CLOCK.freshMs - LIVE_CLOCK.refreshAheadMs);
        if (this.fresh(now) && !refresh) return true;
        if (timestamp(this.verifiedAt) && now < this.verifiedAt)
            return this.fail(new OperationalError('invalid_server_clock', 'stale_data'), now, outageAt);
        if (outageAt !== null && now < previous.retryAt) return false;
        try {
            // Renew before a tick's metadata/wallet work can cross expiry.
            // Force a real network sample, also on outage recovery: the last
            // rejected proactive probe may precede the old cache's expiry.
            // Never re-date a cached offset or use it to clear that hold.
            const server = await (refresh || outageAt !== null
                ? this.client.serverTime({ force: true }) : this.client.serverTime()), after = Date.now();
            if (!timestamp(after) || after < now || !Number.isFinite(server)
                || Math.abs(server - after) > this.settings.maxClockSkewMs)
                throw new OperationalError('invalid_server_clock', 'stale_data');
            // The client may return a still-fresh cached sample. Its original
            // verification time must not gain another thirty seconds here.
            const sampledAt = this.client.clock?.at ?? after;
            if (!timestamp(sampledAt) || sampledAt > after || after - sampledAt >= LIVE_CLOCK.freshMs)
                throw new OperationalError('invalid_server_clock', 'stale_data');
            this.verifiedAt = sampledAt;
            this.store.state.liveClock = { status: 'verified', verifiedAt: sampledAt,
                ...(outageAt !== null ? { recoveredAt: after, lastOutageMs: after - outageAt } : {}) };
            clearEntryHold(this.store, 'clock', { now: after, proof: 'fresh_verified_server_time' });
            if (outageAt !== null) this.store.event('live_clock_recovered', { outageMs: after - outageAt });
            else this.store.save();
            return true;
        } catch (error) {
            const after = Date.now(), since = outageAt ?? now;
            this.verifiedAt = null;
            if (!timestamp(after) || after < now
                || !(temporaryClockFailure(error) || retryResponses && clockResponseFailure(error)))
                return this.fail(error, after, since);
            const diagnostic = safeError(error, { stage: 'server_time', endpoint: 'clob' });
            const endpoint = this.client.reads?.endpoints?.get('clob');
            const hold = holdEntry(this.store, 'clock', error, { now: after, delayMs: LIVE_CLOCK.retryMs,
                retryable: true, endpointState: endpoint });
            if (!hold || hold.retryable !== true) return false;
            const retryAt = hold.retryAt;
            this.store.state.liveClock = { status: 'waiting', outageAt: since, retryAt,
                attempts: (previous?.status === 'waiting' ? previous.attempts || 0 : 0) + 1, error: diagnostic };
            this.store.state.failures++;
            if (previous?.status !== 'waiting' || previous.error?.code !== diagnostic.code)
                this.store.event('live_clock_wait', { error: diagnostic, outageMs: after - since,
                    nextDelayMs: retryAt - after });
            else this.store.save();
            return false;
        }
    }
}
