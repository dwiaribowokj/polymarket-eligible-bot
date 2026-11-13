import { TradingClient } from '../restart/client.js';
import { safeError, ReadCoordinator, OperationalError, fetchResponse, classifyError } from '../restart/network.js';
import { publicReader } from '../laya-filter-paper/client.js';
import { EARLY_PAPER_CLOCK } from './transport.js';

const externalCandles = config => ['early-reversal-30x5m-v1', 'next-reversal-30x5m-v1'].includes(config.profile);

export const PREMARKET_FEED_WATCHDOG = Object.freeze({
    version: 'source-price-stall-subscription-recovery-v1',
    staleMs: 15000, pollMs: 1000, closeWaitMs: 5000,
    retryMinMs: 2000, retryMaxMs: 30000, stableResetMs: 60000,
    closurePolicy: 'await-handle-close-and-iterator-end-then-sdk-idle-cooldown',
});

export class PremarketBtcFeed {
    constructor({ btc, authenticate, emit = () => {}, policy = PREMARKET_FEED_WATCHDOG,
        clock = Date.now, scheduleInterval = setInterval, cancelInterval = clearInterval }) {
        Object.assign(this, { btc, authenticate, emit, policy, clock, scheduleInterval, cancelInterval });
        for (const key of ['staleMs', 'pollMs', 'closeWaitMs', 'retryMinMs', 'retryMaxMs', 'stableResetMs'])
            if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error('premarket_feed_policy_invalid');
        if (policy.retryMinMs < 2000 || policy.retryMaxMs < policy.retryMinMs || policy.pollMs >= policy.staleMs)
            throw new Error('premarket_feed_policy_invalid');
        this.source = null; this.generation = 0; this.failures = 0; this.retryAt = 0; this.closed = false; this.timer = null;
    }
    start() {
        if (this.closed || !this.btc) return;
        if (!this.timer) {
            this.timer = this.scheduleInterval(() => this.pulse(), this.policy.pollMs);
            this.timer?.unref?.();
        }
        this.pulse();
    }
    active(source) { return this.source === source && !source.retired && !this.closed; }
    ages(now = this.clock()) {
        const pointAge = point => point && Number.isFinite(point.at) && Number.isFinite(point.receivedAt)
            && point.at <= now && point.receivedAt <= now && point.receivedAt >= point.at
            ? Math.max(now - point.at, now - point.receivedAt) : null;
        return { spotAgeMs: pointAge(this.source?.lastSpot), twapAgeMs: pointAge(this.source?.lastTwap) };
    }
    status(now = this.clock()) {
        return { generation: this.source?.generation ?? this.generation,
            phase: this.closed ? 'closed' : this.source?.phase ?? 'backoff',
            retryAt: this.source ? null : this.retryAt, failures: this.failures, ...this.ages(now) };
    }
    pulse() {
        if (this.closed) return;
        const now = this.clock(), source = this.source;
        if (!source) {
            if (now < this.retryAt) return;
            const next = this.source = { generation: ++this.generation, startedAt: now, phase: 'connecting',
                stream: null, retired: false, workFinished: false, closeConfirmed: false };
            this.btc.spot = []; this.btc.twap = null;
            next.task = this.run(next);
            next.task.catch(() => {});
            return;
        }
        if (source.retired) {
            if (!source.waitEmitted && now - source.retiredAt >= this.policy.closeWaitMs) {
                source.waitEmitted = true;
                this.emit({ type: 'btc_feed_close_wait', generation: source.generation, reason: source.closeFailed ? 'close_failed' : 'close_or_iterator_pending',
                    waitMs: now - source.retiredAt, phase: source.phase });
            }
            return;
        }
        const ages = this.ages(now), elapsed = now - source.startedAt;
        if (elapsed < 0 || Object.values(ages).some(age => (age ?? elapsed) > this.policy.staleMs)) {
            this.retire(source, elapsed < 0 ? 'clock_reversed' : source.phase === 'connecting' ? 'initial_feed_stall' : 'source_price_stall', ages);
            return;
        }
        if (Object.values(ages).every(age => age !== null && age <= this.btc.rule.maxAgeMs)) {
            source.healthySince ??= now;
            if (now - source.healthySince >= this.policy.stableResetMs) this.failures = 0;
        } else source.healthySince = null;
    }
    async run(source) {
        try {
            const feedClient = await this.authenticate();
            if (!this.active(source)) return;
            const stream = await feedClient.subscribe([
                { topic: 'prices.crypto', symbols: ['btcusd'] },
                { topic: 'prices.crypto.twap', symbols: ['btcusd'] },
            ]);
            source.stream = stream;
            if (!this.active(source)) { this.closeStream(source); return; }
            source.phase = 'streaming';
            this.emit({ type: 'btc_feed_connected', source: 'chainlink_polybolt', windowSeconds: 60, generation: source.generation });
            for await (const event of stream) {
                // Retirement is synchronous; queued messages from the old iterator cannot repopulate history.
                if (!this.active(source)) continue;
                this.btc.ingest(event, this.clock());
                const spot = this.btc.spot.at(-1), twap = this.btc.twap;
                if (spot && (!source.lastSpot || spot.at > source.lastSpot.at)) source.lastSpot = { ...spot };
                if (twap && (!source.lastTwap || twap.at > source.lastTwap.at)) source.lastTwap = { ...twap };
            }
            if (this.active(source)) this.retire(source, 'stream_ended');
        } catch (error) {
            if (this.active(source)) this.retire(source, 'feed_failed', { error: safeError(error, { stage: 'btc_feed' }) });
        } finally {
            source.workFinished = true;
            this.release(source);
        }
    }
    retire(source, reason, detail = {}) {
        if (this.source !== source || source.retired) return;
        source.retired = true; source.retiredAt = this.clock(); source.phase = 'closing';
        if (reason !== 'shutdown') this.failures++;
        // Previously observed opening references remain valid; price windows must warm from scratch.
        this.btc.spot = []; this.btc.twap = null;
        this.emit({ type: 'btc_feed_gap', generation: source.generation, reason, ...detail });
        if (detail.error) this.emit({ type: 'btc_feed_failed', generation: source.generation, reason, error: detail.error });
        this.closeStream(source);
        this.release(source);
    }
    closeStream(source) {
        if (!source.stream || source.closeTask) return;
        source.closeTask = Promise.resolve().then(() => source.stream.close()).then(() => {
            source.closeConfirmed = true; this.release(source);
        }, error => {
            source.closeFailed = true; source.phase = 'close_blocked';
            this.emit({ type: 'btc_feed_close_failed', generation: source.generation,
                error: safeError(error, { stage: 'btc_feed_close' }) });
        });
        source.closeTask.catch(() => {});
    }
    release(source) {
        if (this.source !== source || !source.retired || !source.workFinished || source.stream && !source.closeConfirmed) return;
        this.source = null;
        if (this.closed) { this.resolveClosed?.(); return; }
        const retryMs = Math.min(this.policy.retryMaxMs,
            this.policy.retryMinMs * 2 ** Math.min(Math.max(0, this.failures - 1), 16));
        // The SDK releases an unused pooled price socket after one second. Never immediately reuse it.
        this.retryAt = this.clock() + retryMs;
        this.emit({ type: 'btc_feed_retry_scheduled', generation: source.generation, retryAt: this.retryAt,
            retryMs, failures: this.failures, evidence: 'subscription_close_and_iterator_finished' });
    }
    close() {
        if (this.closeTask) return this.closeTask;
        this.closed = true;
        if (this.timer) { this.cancelInterval(this.timer); this.timer = null; }
        this.closeTask = new Promise(resolve => { this.resolveClosed = resolve; });
        if (this.source) this.retire(this.source, 'shutdown');
        else this.resolveClosed();
        return this.closeTask;
    }
}

export class PremarketTradingClient extends TradingClient {
    constructor(settings, options = {}) {
        super(settings);
        this.paperFeed = new PremarketBtcFeed({ ...options, btc: this.btc,
            authenticate: options.authenticate || (() => this.authenticate()), emit: event => this.onEvent?.(event) });
    }
    startBtcFeed() { if (!this.closed) this.paperFeed.start(); }
    btcStatus() { return { ...this.btc.status(this.paperFeed.clock()), watchdog: this.paperFeed.status() }; }
    close() {
        const closing = this.paperFeed.close();
        if (!this.closed) super.close();
        return closing;
    }
}

export class EarlyPremarketTradingClient extends PremarketTradingClient {
    constructor(settings, options = {}) {
        super(settings, options);
        this.clockReads = new ReadCoordinator({ policy: EARLY_PAPER_CLOCK });
        this.clockReads.onEvent = event => this.onEvent?.(event);
    }
    clockSampleFresh(now = Date.now()) {
        return this.clock && Number.isFinite(this.clock.at) && Number.isFinite(this.clock.skewMs)
            && now >= this.clock.at && now - this.clock.at < EARLY_PAPER_CLOCK.validMs;
    }
    async serverTime() {
        if (this.clockSampleFresh() && Date.now() - this.clock.at < EARLY_PAPER_CLOCK.refreshMs)
            return Date.now() + this.clock.skewMs;
        this.clockPending ||= this.clockReads.run('early:server_time', 'clob', 'server_time', async signal => {
            const before = Date.now();
            const raw = await (await fetchResponse('https://clob.polymarket.com/time', { signal })).json();
            const value = (typeof raw === 'number' || typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw))
                ? Number(raw) * 1000 : NaN;
            const after = Date.now(), durationMs = after - before, skewMs = value - (before + after) / 2;
            if (!Number.isFinite(value) || value <= 0 || Math.abs(skewMs) > this.settings.maxClockSkewMs
                || durationMs < 0 || durationMs > Math.min(this.settings.maxDataAgeMs, EARLY_PAPER_CLOCK.timeoutMs))
                throw new OperationalError('invalid_server_clock', 'stale_data', { stage: 'server_time', durationMs });
            return { at: after, skewMs, durationMs };
        }).then(clock => { this.clock = clock; }).catch(error => {
            const failure = classifyError(error);
            if (!['transport', 'timeout', 'rate_limit', 'circuit'].includes(failure.category)) {
                this.clock = null; throw error;
            }
            if (!this.clockSampleFresh()) throw error;
            // Refresh failure cannot extend the last independently verified sample.
        }).finally(() => { this.clockPending = null; });
        await this.clockPending;
        if (!this.clockSampleFresh()) throw new OperationalError('invalid_server_clock', 'stale_data', { stage: 'server_time' });
        return Date.now() + this.clock.skewMs;
    }
}

export function premarketReader(config, onEvent, options = {}) {
    const Client = externalCandles(config) ? EarlyPremarketTradingClient : PremarketTradingClient;
    class ConfiguredClient extends Client {
        constructor(control) { super(control, { ...options, policy: config.feedWatchdog }); }
    }
    const reader = publicReader(config.control, onEvent, ConfiguredClient);
    // External candles supply early forecasts; keep official market metadata
    // validation and CTF payout reads without opening the authenticated feed.
    if (externalCandles(config)) return Object.freeze({ ...reader,
        get clock() { return reader.clock; }, startBtcFeed() {} });
    return reader;
}
