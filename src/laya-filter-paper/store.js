import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';

const safeCode = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_:-]{0,100}$/.test(value) ? value : null;
const skipCounters = complete => ({ schema: 1, complete, total: 0, byReason: {},
    bySide: { UP: {}, DOWN: {} }, slots: {} });
const increment = (counts, reason) => {
    Object.defineProperty(counts, reason, { value: (Object.hasOwn(counts, reason) ? counts[reason] : 0) + 1,
        writable: true, enumerable: true, configurable: true });
};

export class FilterPaperStore {
    constructor(config, now = Date.now()) {
        this.config = config;
        if (!/^[a-zA-Z0-9_-]+$/.test(config.id || '')) throw new Error('paper_identity_invalid');
        this.dir = path.join(config.dataDir, config.id);
        const active = path.join(config.dataDir, 'active.json');
        if (fs.existsSync(active) && JSON.parse(fs.readFileSync(active)).id !== config.id)
            throw new Error('paper_baseline_changed_use_new_directory');
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.filename = path.join(this.dir, 'ledger.json');
        const exists = fs.existsSync(this.filename);
        if (fs.existsSync(active) && !exists) throw new Error('paper_ledger_missing');
        this.state = exists ? JSON.parse(fs.readFileSync(this.filename)) : {
            schema: 1, id: config.id, startedAt: now, deadline: null, frozenAt: null,
            providers: {}, slots: {}, snapshots: [], markets: {}, errors: {},
            opportunitySkips: skipCounters(true),
            arms: Object.fromEntries(config.armNames.map(name => [name, { cash: config.capital, peak: config.capital,
                drawdown: 0, shadowStop: null, stopped: null, seen: {}, position: null, completed: [], outcomes: {} }])) };
        if (this.state.id !== config.id || this.state.archivedAt) throw new Error('paper_ledger_identity_mismatch');
        if (JSON.stringify(Object.keys(this.state.arms).sort()) !== JSON.stringify([...config.armNames].sort()))
            throw new Error('paper_ledger_arms_mismatch');
        for (const arm of Object.values(this.state.arms)) {
            if (![arm.cash, arm.peak, arm.drawdown].every(Number.isFinite) || arm.cash < 0 || !arm.seen
                || !Array.isArray(arm.completed) || !arm.outcomes) throw new Error('paper_ledger_corrupt');
            if (arm.position?.status === 'pending') {
                const slug = arm.position.market.slug;
                arm.seen[slug] ||= { at: now };
                arm.outcomes[slug] = { pnl: 0, reason: 'restart_during_pending_execution' };
                arm.position = null;
            }
        }
        for (const [name, provider] of Object.entries(this.state.providers)) this.recoverProvider(name, provider, now);
        const manifest = path.join(this.dir, 'manifest.json');
        if (!fs.existsSync(manifest)) atomicJson(manifest, { id: config.id, createdAt: this.state.startedAt,
            paperOnly: true, sources: config.sources, policy: config.policy });
        this.save();
        if (!fs.existsSync(active)) atomicJson(active, { id: config.id, startedAt: this.state.startedAt, paperOnly: true });
    }
    recoverProvider(name, provider) {
        if (provider.pending) { provider.disabled = 'restart_with_unknown_inference'; provider.pending = null; }
    }
    save() { atomicJson(this.filename, this.state); }
    event(type, detail = {}) {
        return this.eventBatch([{ type, detail }]);
    }
    eventBatch(events) {
        const at = new Date().toISOString(), rows = events.map(({ type, detail = {} }) => ({
            ...detail, at, id: this.config.id, type }));
        for (const row of rows) {
            if (row.type !== 'opportunity_skipped') continue;
            if (typeof row.slug !== 'string' || !row.slug || !Number.isFinite(row.slot))
                throw new Error('paper_skip_identity_invalid');
            const key = `${row.slug}:${row.slot}`;
            if (row.slotKey !== undefined && row.slotKey !== key) throw new Error('paper_skip_identity_invalid');
            const skips = this.state.opportunitySkips ||= skipCounters(false);
            if (Object.hasOwn(skips.slots, key)) continue;
            const sideReasons = Object.fromEntries(['UP', 'DOWN'].map((side, index) => [side,
                safeCode(row.sideReasons?.[side] ?? row.reasons?.[index]) || 'unknown']));
            const reasons = [...new Set(Object.values(sideReasons))];
            skips.slots[key] = { slug: row.slug, slot: row.slot, reasons, sideReasons };
            skips.total++;
            for (const reason of reasons) increment(skips.byReason, reason);
            for (const [side, reason] of Object.entries(sideReasons)) increment(skips.bySide[side], reason);
        }
        this.save();
        // Logging follows the atomic ledger commit; callers must never roll back committed balances.
        try {
            if (rows.length) fs.appendFileSync(path.join(this.dir, 'events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
            for (const row of rows) console.log(JSON.stringify(row));
        } catch {
            const error = new Error('paper_event_log_failed');
            error.durableStateCommitted = true;
            throw error;
        }
    }
    error(stage, error) {
        const code = safeCode(error?.code) || safeCode(error?.message) || safeCode(error?.name) || 'operation_failed';
        const key = `${safeCode(stage) || 'operation'}:${code}`;
        this.state.errors[key] = (this.state.errors[key] || 0) + 1;
        this.event('error', { stage: safeCode(stage), code, category: safeCode(error?.category),
            httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
            durationMs: Number.isFinite(error?.durationMs) ? error.durationMs : null });
    }
    freeze(now = Date.now()) {
        if (this.state.frozenAt || now < this.config.deadline) return;
        this.state.frozenAt = now;
        for (const arm of Object.values(this.state.arms)) if (arm.position?.status === 'pending') {
            arm.outcomes[arm.position.market.slug] = { pnl: 0, reason: 'deadline_pending_cancelled' };
            arm.position = null;
        }
        this.event('entries_frozen');
    }
}
