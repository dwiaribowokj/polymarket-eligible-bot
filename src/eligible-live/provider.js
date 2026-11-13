import { eligibleEntryPolicy, evaluateEligibleEntryPolicy } from './entry-buffer.js';

export const ELIGIBLE_MODEL = 'deterministic-eligible-v1';

export function eligibleAction(allowed) {
    return Array.isArray(allowed) && allowed.length === 1 && [0, 1].includes(allowed[0]?.index)
        ? ['BUY_UP', 'BUY_DOWN'][allowed[0].index] : 'SKIP';
}

export class EligibleLiveProvider {
    constructor(config, state = {}, onEvent = () => {}, { clock = Date.now } = {}) {
        eligibleEntryPolicy(config);
        Object.assign(this, { config, state, onEvent, clock });
        this.active = new Set();
        this.closed = false;
    }
    async preflight() {
        const ready = !this.closed && !this.state.eligible?.disabled;
        const result = { ready, model: ELIGIBLE_MODEL, inferenceAttempted: false,
            ...(ready ? {} : { reason: this.closed ? 'closed' : this.state.eligible.disabled }) };
        this.onEvent('provider_preflight', { provider: 'eligible', ...result });
        return { eligible: result };
    }
    async predict(name, snapshot) {
        if (name !== 'eligible') throw new Error('eligible_only');
        const at = this.clock(), status = this.closed ? 'closed' : this.state.eligible?.disabled ? 'disabled' : 'ok';
        const entryFilter = status === 'ok' ? evaluateEligibleEntryPolicy(snapshot, this.config, at) : null;
        const action = status === 'ok' && (!entryFilter || entryFilter.pass) ? eligibleAction(snapshot?.allowed) : 'SKIP';
        return { provider: 'eligible', model: ELIGIBLE_MODEL, snapshotId: snapshot?.snapshotId,
            status, action, executable: action !== 'SKIP', inferenceAttempted: false,
            ...(entryFilter ? { entryFilter, ...(entryFilter.reason ? { reason: entryFilter.reason } : {}) } : {}),
            requestedAt: at, receivedAt: at, latencyMs: 0, cost: 0 };
    }
    close() { this.closed = true; }
}
