import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export function atomicJson(filename, data, { compact = false } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const tmp = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data, null, compact ? undefined : 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, filename);
    const dir = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class Store {
    constructor(settings, mode, strategy) {
        this.logger = row => console.log(JSON.stringify(row));
        this.settings = settings;
        this.directory = path.join(settings.dataDir, settings.fingerprint, mode);
        this.filename = path.join(this.directory, `${strategy}.json`);
        if (fs.existsSync(this.filename)) {
            this.state = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
            if (this.state.baseline !== settings.fingerprint || this.state.mode !== mode || this.state.strategy !== strategy)
                throw new Error('Ledger identity mismatch');
            if (!Number.isFinite(this.state.cash) || !Array.isArray(this.state.completed) || !this.state.seen
                || !Number.isFinite(this.state.peakEquity) || !Number.isFinite(this.state.maxDrawdown))
                throw new Error('Ledger is incomplete or corrupt');
        } else {
            this.state = { version: 1, baseline: settings.fingerprint, mode, strategy,
                startedAt: Date.now(), cash: settings.capital, peakEquity: settings.capital,
                maxDrawdown: 0, stopped: null, position: null, completed: [], seen: {},
                failures: 0, dataGaps: 0, walletStart: null, legacyPositions: [], events: 0 };
        }
    }
    save() { atomicJson(this.filename, this.state, { compact: this.state.mode === 'pilot' }); }
    event(type, detail = {}) {
        const row = { at: new Date().toISOString(), strategy: this.state.strategy, mode: this.state.mode,
            baseline: this.state.baseline, type, ...detail };
        this.state.events++;
        const metrics = this.state.operational ||= { errors: {}, recoveredOutageMs: 0, longestOutageMs: 0,
            circuitsOpened: 0, rpcFailovers: 0, skippedEntryChecks: 0, outages: {} };
        if (type === 'read_failed') {
            const error = detail.error || {}, key = `${error.stage || 'unknown'}:${error.category || 'unknown'}:${error.httpStatus || '-'}`;
            metrics.errors[key] = (metrics.errors[key] || 0) + 1;
            metrics.failedReadMs = (metrics.failedReadMs || 0) + (error.durationMs || 0);
            metrics.longestFailedReadMs = Math.max(metrics.longestFailedReadMs || 0, error.durationMs || 0);
            if (['timeout', 'transport', 'rate_limit'].includes(error.category)) metrics.outages[error.endpoint] ||= Date.now();
        }
        if (['retry', 'book_retry', 'payout_retry'].includes(type) && detail.error) {
            metrics.applicationErrors ||= {};
            const error = detail.error, key = `${error.stage || type}:${error.category || 'unknown'}:${error.code}`;
            metrics.applicationErrors[key] = (metrics.applicationErrors[key] || 0) + 1;
        }
        if (type === 'endpoint_recovered') {
            metrics.recoveredOutageMs += detail.outageMs;
            metrics.longestOutageMs = Math.max(metrics.longestOutageMs, detail.outageMs);
            delete metrics.outages[detail.endpoint];
        }
        if (type === 'circuit_opened') metrics.circuitsOpened++;
        if (type === 'rpc_failover') metrics.rpcFailovers++;
        if (type === 'entry_check_skipped') metrics.skippedEntryChecks++;
        if (type === 'entry_window_missed') metrics.missedEntryWindows = (metrics.missedEntryWindows || 0) + 1;
        if (['entry_observed', 'execution_snapshot', 'fak_complete', 'late_signal_expired'].includes(type)) {
            const diagnostics = this.state.diagnostics ||= { decisionChecks: 0, reasons: {}, noFillAttempts: 0,
                signalExpired: 0, executionSnapshots: 0, latencyMs: { count: 0, total: 0, min: null, max: 0 } };
            if (type === 'entry_observed') {
                diagnostics.decisionChecks++;
                const reason = detail.reason || 'accepted'; diagnostics.reasons[reason] = (diagnostics.reasons[reason] || 0) + 1;
            }
            if (type === 'fak_complete' && !detail.filled) diagnostics.noFillAttempts++;
            if (type === 'late_signal_expired') {
                diagnostics.signalExpired++;
                diagnostics.expiryReasons ||= {};
                const reason = detail.reason || 'unknown';
                diagnostics.expiryReasons[reason] = (diagnostics.expiryReasons[reason] || 0) + 1;
            }
            if (type === 'execution_snapshot') {
                diagnostics.executionSnapshots++;
                const latency = diagnostics.latencyMs, value = detail.effectiveLatencyMs;
                if (Number.isFinite(value)) { latency.count++; latency.total += value;
                    latency.min = latency.min === null ? value : Math.min(latency.min, value); latency.max = Math.max(latency.max, value); }
            }
        }
        this.save();
        const fd = fs.openSync(path.join(this.directory, `${this.state.strategy}.jsonl`), 'a', 0o600);
        try { fs.writeSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        this.logger(row);
    }
    stop(reason) {
        if (this.state.stopped) return;
        this.state.stopped = { reason, at: Date.now() };
        if (this.state.mode === 'paper') this.state.frozenAt ||= this.state.stopped.at;
        this.event('stopped', { reason });
    }
}

export async function acquireLock(dataDir, mode) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(dataDir, `${mode}.lock`);
    fs.closeSync(fs.openSync(filename, 'a', 0o600));
    // Kernel flock survives PID reuse and releases automatically after parent pipe closes.
    const code = 'process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});process.stdout.write("locked\\n");process.stdin.on("end",()=>process.exit(0));process.stdin.resume();';
    const holder = spawn('flock', ['--exclusive', '--nonblock', filename, process.execPath, '-e', code],
        { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
    await new Promise((resolve, reject) => {
        holder.once('error', reject);
        holder.once('exit', () => reject(new Error(`${mode} is already running or flock is unavailable`)));
        holder.stdout.once('data', resolve);
    });
    holder.stdin.on('error', () => {});
    fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    return async () => {
        if (holder.exitCode !== null) return;
        await new Promise(resolve => { holder.once('exit', resolve); holder.stdin.end(); });
    };
}

export function readTrials(settings) {
    return (settings.strategies || ['late-entry', 'maker-mm']).map(strategy => {
        const file = path.join(settings.dataDir, settings.fingerprint, 'paper', `${strategy}.json`);
        return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    });
}

export function paperExposure(settings) {
    if (!fs.existsSync(settings.dataDir)) return [];
    return fs.readdirSync(settings.dataDir, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
        const directory = path.join(settings.dataDir, d.name, 'paper');
        if (!fs.existsSync(directory)) return [];
        return fs.readdirSync(directory).filter(f => f.endsWith('.json')).flatMap(f => {
            const state = JSON.parse(fs.readFileSync(path.join(directory, f), 'utf8'));
            return state.position ? [{ baseline: state.baseline, strategy: state.strategy }] : [];
        });
    });
}

export function trialManifest(settings) {
    const filename = path.join(settings.dataDir, settings.fingerprint, 'trial-manifest.json');
    if (!fs.existsSync(filename)) atomicJson(filename, { baseline: settings.fingerprint, strategies: settings.strategies,
        createdAt: Date.now(), evaluationEndsAt: settings.evaluationEndsAt, minimumDays: settings.minDays, telemetrySchema: 2,
        experiment: settings.experiment, parameters: { capital: settings.capital, shares: settings.shares,
            entryCap: settings.entryCap, late: settings.late, lateQuality: settings.lateQuality,
            lateSignal: settings.lateSignal, paperDrawdownStop: settings.paperDrawdownStop,
            paperShadowDrawdownStop: settings.paperShadowDrawdownStop, latencyMs: settings.latencyMs } });
}

export function otherLiveExposure(settings) {
    return pilotHistory(settings).filter(state => state.position).map(state => ({ baseline: state.baseline, strategy: state.strategy }));
}

export function pilotHistory(settings) {
    if (!fs.existsSync(settings.dataDir)) return [];
    const found = [];
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    for (const baseline of fs.readdirSync(settings.dataDir, { withFileTypes: true })) {
        if (!baseline.isDirectory()) continue;
        const dir = path.join(settings.dataDir, baseline.name, 'pilot');
        if (!fs.existsSync(dir)) continue;
        // A pilot directory also contains manifests and generated reports.
        // Strategy filenames identify ledgers, including pilots predating Laya.
        for (const strategy of ['late-entry', 'maker-mm']) {
            const filename = path.join(dir, `${strategy}.json`);
            if (!fs.existsSync(filename)) continue;
            let state;
            try { state = JSON.parse(fs.readFileSync(filename, 'utf8')); }
            catch (error) { throw new Error(`Cannot read pilot ledger ${filename}: ${error.message}`, { cause: error }); }
            if (!isRecord(state)) throw new Error(`Pilot ledger is incomplete or corrupt: ${filename}`);
            if (state.baseline !== baseline.name || state.mode !== 'pilot' || state.strategy !== strategy)
                throw new Error(`Pilot ledger identity mismatch: ${filename}`);
            if (!Number.isFinite(state.cash) || !Number.isFinite(state.startedAt)
                || !Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown)
                || !Number.isFinite(state.failures) || !isRecord(state.seen) || !Array.isArray(state.completed)
                || state.completed.some(row => !isRecord(row) || row.traded
                    && ![row.pnl, row.fees, row.gas].every(Number.isFinite)))
                throw new Error(`Pilot ledger is incomplete or corrupt: ${filename}`);
            const position = state.position;
            if (position != null && (!isRecord(position) || !isRecord(position.market)
                || typeof position.market.slug !== 'string' || !Array.isArray(position.holdings)
                || position.holdings.length !== 2 || !position.holdings.every(Number.isFinite)
                || !Array.isArray(position.orders)
                || position.orders.some(order => !isRecord(order) || typeof order.status !== 'string')))
                throw new Error(`Pilot ledger position is incomplete or corrupt: ${filename}`);
            found.push(state);
        }
    }
    return found;
}
