import { setTimeout as delay } from 'node:timers/promises';
import { OperationalError, safeError } from '../restart/network.js';
import { clearEntryHold, holdEntry, temporaryReadFailure } from './entry-holds.js';
import { profitWithdrawalPending } from './profit-taking.js';

const riskStops = new Set(['drawdown_limit', 'capital_exhausted', 'bankrupt']);
const diagnosticError = error => new OperationalError(error?.code || 'request_failed',
    error?.category || 'unknown', error || {});

// Entry affordability and an operational stop are not evidence of insolvency.
// The risk evaluator owns the durable capital/drawdown latch.
export function automaticLiveExit(state, { continuousTrading = false } = {}) {
    if (continuousTrading === true) return null;
    const reason = state.liveRiskStop?.reason || state.stopped?.reason;
    return riskStops.has(reason) && !state.position && !profitWithdrawalPending(state) ? reason : null;
}

function consoleDiagnostic(type, detail) {
    try { console.error(JSON.stringify({ type, ...detail })); } catch { /* Logging cannot kill supervision. */ }
}

// Fresh entries require successful operational preflight. Existing exposure
// may enter the established recovery-only path with entries latched off.
// A blocked explicit run remains observable and retries read-only checks; a
// manual signal drains the current check before returning.
export async function waitForLiveStartup({ check, state, signal, onResult = () => {},
    emit = consoleDiagnostic, intervalMs = 30000, heartbeatMs = 60000, continuousTrading = false }) {
    let lastResult = null;
    const log = (type, detail) => { try { emit(type, detail); } catch { /* diagnostic only */ } };
    const heartbeat = () => log('laya_startup_heartbeat', { phase: 'preflight',
        stopped: state.stopped || null, liveRiskStop: state.liveRiskStop || null,
        operationalReady: lastResult?.output?.operationalReady ?? false,
        blockers: lastResult?.output?.blockers || ['live_preflight_required'] });
    const timer = setInterval(heartbeat, heartbeatMs);
    try {
        heartbeat();
        while (!signal?.aborted) {
            if (automaticLiveExit(state, { continuousTrading })) return null;
            try {
                lastResult = await check();
                try { onResult(lastResult); } catch (error) { log('laya_startup_report_failed', { error: safeError(error) }); }
                if (signal?.aborted) return null;
                if (lastResult.output.startAllowed === true
                    && (lastResult.output.operationalReady === true || lastResult.output.recoveryOnly === true))
                    return lastResult;
            } catch (error) { log('laya_startup_retry', { error: safeError(error) }); }
            try { await delay(intervalMs, undefined, { signal }); }
            catch (error) { if (!signal?.aborted) throw error; }
        }
        return null;
    } finally { clearInterval(timer); }
}

// Only this awaited loop may run financial ticks. Watchdogs inspect/report and
// perform single-flight read-only health checks; they never replay an order,
// transaction, or inference when a tick is slow or throws.
export class LiveSupervisor {
    constructor({ engine, store, providers, profitTaking, continuousRecovery, report = () => {}, signal,
        now = Date.now, diagnostic = consoleDiagnostic, probeIntervalMs = 30000,
        probeTimeoutMs = 12000, heartbeatMs = 60000, reportIntervalMs = 1800000,
        reportRetryMs = 30000, providerName = engine.config?.policy?.provider ?? 'laya',
        continuousTrading = false }) {
        if (!['laya', 'eligible'].includes(providerName)
            || store.state.decisionProvider && store.state.decisionProvider !== providerName)
            throw new Error('live_provider_identity_mismatch');
        Object.assign(this, { engine, store, providers, profitTaking, continuousRecovery, report, signal, now,
            diagnostic, probeIntervalMs, probeTimeoutMs, heartbeatMs, reportIntervalMs, reportRetryMs,
            providerName, continuousTrading });
        this.nextProbe = now() + probeIntervalMs;
        this.nextHeartbeat = 0; this.nextReport = 0; this.reportFailures = 0;
        this.ending = false; this.closed = false; this.sleepAbort = new AbortController();
    }
    log(type, detail = {}) {
        try { this.diagnostic(type, detail); } catch { /* diagnostic only */ }
    }
    event(type, detail = {}) {
        try { this.store.event(type, detail); }
        catch (error) { this.log('laya_supervisor_log_failed', { event: type, error: safeError(error) }); }
    }
    hold(key, error, options = {}) {
        try { return holdEntry(this.store, key, error, { now: this.now(), ...options }); }
        catch (failure) { this.log('laya_supervisor_log_failed', { event: 'live_entry_hold', error: safeError(failure) }); }
    }
    clear(key, proof) {
        try { clearEntryHold(this.store, key, { now: this.now(), proof }); }
        catch (error) { this.log('laya_supervisor_log_failed', { event: 'live_entry_hold_recovered', error: safeError(error) }); }
    }
    financialError(stage, error) {
        // A generic throw does not prove that a side effect was absent. Keep
        // entries blocked persistently, while normal broker reconciliation and
        // inventory maintenance continue under their original durable intents.
        this.hold('runtime_error', error);
        this.event('laya_runtime_retry', { stage, error: safeError(error) });
    }
    requestStop(reason = 'manual_signal') {
        if (this.ending) return;
        this.ending = true; this.endReason = reason;
        this.engine.closed = true;
        if (this.profitTaking) this.profitTaking.closed = true;
        if (this.continuousRecovery) this.continuousRecovery.closed = true;
        this.sleepAbort.abort();
    }
    heartbeat() {
        const now = this.now();
        if (now < this.nextHeartbeat) return;
        this.nextHeartbeat = now + this.heartbeatMs;
        const state = this.store.state;
        this.event('laya_supervisor_heartbeat', { cash: state.cash,
            activeMarket: state.position?.market?.slug ?? null,
            stopped: state.stopped || null, liveRiskStop: state.liveRiskStop || null,
            entryHolds: state.entryHolds || {}, tickInFlight: !!this.tickInFlight,
            healthProbeInFlight: !!this.probeInFlight });
    }
    maybeReport(force = false) {
        if (this.reportInFlight || !force && this.now() < this.nextReport) return this.reportInFlight;
        this.nextReport = this.now() + this.reportIntervalMs;
        const pending = Promise.resolve().then(() => this.report()).then(() => {
            this.reportFailures = 0;
        }, error => {
            this.reportFailures++;
            this.nextReport = this.now() + Math.min(300000,
                this.reportRetryMs * 2 ** Math.min(4, this.reportFailures - 1));
            this.event('laya_report_retry', { error: safeError(error), nextReportAt: this.nextReport });
        }).finally(() => { if (this.reportInFlight === pending) this.reportInFlight = null; });
        this.reportInFlight = pending;
        return pending;
    }
    maybeProbe() {
        if (this.ending || this.probeInFlight || this.continuousRecovery?.pending
            || this.now() < this.nextProbe || this.providers.active?.size) return;
        // Block decision admission before yielding to preflight. Even a fresh
        // healthy provider is never probed concurrently with new decisions.
        this.hold('provider_probe', new OperationalError('provider_health_check', 'opportunity'), { retryable: true });
        let timedOut = false, timer;
        const raw = Promise.resolve().then(() => this.providers.preflight());
        const timeout = new Promise(resolve => { timer = setTimeout(() => {
            timedOut = true;
            resolve({ [this.providerName]: { ready: false, error: safeError(new OperationalError('read_timeout', 'timeout',
                { stage: 'provider_health', endpoint: this.providerName })) } });
        }, this.probeTimeoutMs); });
        const bounded = Promise.race([raw, timeout]).then(result => {
            if (this.ending) return;
            const health = result?.[this.providerName];
            if (health?.ready === true && !this.providers.state?.[this.providerName]?.disabled) {
                this.clear('provider_health', 'fresh_provider_preflight');
                this.nextProbe = this.now() + this.probeIntervalMs;
                this.event(`${this.providerName}_provider_health_ready`);
            } else {
                const error = diagnosticError(health?.error || { code: health?.reason || 'invalid_provider_health', category: 'validation' });
                const retryable = temporaryReadFailure(error);
                const hold = this.hold(retryable ? 'provider_health' : 'provider_semantics', error, { retryable });
                this.nextProbe = Math.max(this.now() + this.probeIntervalMs, hold?.retryAt || 0);
            }
            this.clear('provider_probe', 'provider_health_probe_finished');
        }, error => {
            if (this.ending) return;
            const retryable = temporaryReadFailure(error);
            const hold = this.hold(retryable ? 'provider_health' : 'provider_semantics', error, { retryable });
            this.nextProbe = Math.max(this.now() + this.probeIntervalMs, hold?.retryAt || 0);
            this.clear('provider_probe', 'provider_health_probe_finished');
        }).catch(error => {
            this.log('laya_supervisor_probe_failed', { error: safeError(error) });
        }).finally(() => { clearTimeout(timer); });
        // A timed-out read remains single-flight until the underlying request
        // actually drains. Its late result never clears a failed health gate.
        this.probeInFlight = raw;
        this.probeBounded = bounded;
        raw.then(() => {}, () => {}).finally(() => {
            if (this.probeInFlight === raw) this.probeInFlight = null;
            if (timedOut) this.nextProbe = Math.max(this.nextProbe, this.now() + this.probeIntervalMs);
        });
    }
    background() {
        if (this.ending) return;
        this.heartbeat(); this.maybeReport(); this.maybeProbe();
    }
    async run() {
        if (this.running) throw new Error('live_supervisor_already_running');
        this.running = true;
        const stop = () => this.requestStop();
        this.signal?.addEventListener('abort', stop, { once: true });
        if (this.signal?.aborted) this.requestStop();
        const interval = Math.max(1, Math.min(1000, this.heartbeatMs, this.probeIntervalMs, this.reportRetryMs));
        const timer = setInterval(() => this.background(), interval);
        try {
            while (!this.ending) {
                const initialRisk = automaticLiveExit(this.store.state, this);
                if (initialRisk) { this.requestStop(initialRisk); break; }
                this.background();
                let withdrawalPending = profitWithdrawalPending(this.store.state);
                this.tickInFlight = true;
                try {
                    try { withdrawalPending = !!(await this.profitTaking?.tick()) || profitWithdrawalPending(this.store.state); }
                    catch (error) { this.financialError('profit_taking', error); }
                    if (!this.ending && (this.store.state.position
                        || !withdrawalPending && !profitWithdrawalPending(this.store.state))) {
                        try { await this.engine.tick(); }
                        catch (error) { this.financialError('engine_tick', error); }
                    }
                    if (!this.ending && this.continuousTrading === true) {
                        try { await this.continuousRecovery?.tick(); }
                        catch (error) { this.event('eligible_continuous_recovery_retry', { error: safeError(error) }); }
                    }
                } finally { this.tickInFlight = false; }
                const reason = automaticLiveExit(this.store.state, this);
                if (reason) this.requestStop(reason);
                if (this.ending) break;
                let pause = 1000;
                try { pause = this.engine.nextDelay(); }
                catch (error) { this.financialError('tick_delay', error); }
                if (!Number.isFinite(pause) || pause < 1) pause = 1000;
                try { await delay(pause, undefined, { signal: this.sleepAbort.signal }); }
                catch (error) { if (!this.ending) this.financialError('tick_wait', error); }
            }
        } finally {
            this.requestStop(); clearInterval(timer);
            this.signal?.removeEventListener('abort', stop);
            // Read-only health is bounded. Financial work above is always
            // awaited, and inference retains its existing provider drain.
            await this.probeBounded;
            try { await this.engine.shutdown(); }
            catch (error) { this.financialError('shutdown', error); }
            await Promise.allSettled([...(this.providers.active?.values() || [])]);
            await this.reportInFlight;
            await this.maybeReport(true);
            this.closed = true;
        }
        return { reason: this.endReason };
    }
}
