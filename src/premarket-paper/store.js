import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';

const safeCode = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_:-]{0,100}$/.test(value) ? value : 'operation_failed';
export class PremarketPaperStore {
    constructor(config, now = Date.now()) {
        this.config = config;
        if (!/^[a-zA-Z0-9_-]+$/.test(config.id || '')) throw new Error('paper_identity_invalid');
        this.dir = path.join(config.dataDir, config.id); this.filename = path.join(this.dir, 'ledger.json');
        const active = path.join(config.dataDir, 'active.json');
        if (fs.existsSync(active) && JSON.parse(fs.readFileSync(active)).id !== config.id)
            throw new Error('paper_baseline_changed_use_new_directory');
        if (fs.existsSync(active) && !fs.existsSync(this.filename)) throw new Error('paper_ledger_missing');
        this.state = fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename)) : {
            schema: 1, id: config.id, startedAt: now, arms: Object.fromEntries(config.armNames.map(name => [name,
                { cash: config.capital, peak: config.capital, drawdown: 0, stopped: null, positions: {}, completed: [], outcomes: {} }])),
            markets: {}, slots: {}, snapshots: [], errors: {}, providers: {} };
        if (this.state.id !== config.id || JSON.stringify(Object.keys(this.state.arms || {}).sort()) !== JSON.stringify([...config.armNames].sort()))
            throw new Error('paper_ledger_identity_mismatch');
        for (const arm of Object.values(this.state.arms)) {
            if (![arm.cash, arm.peak, arm.drawdown].every(Number.isFinite) || arm.cash < 0 || !arm.positions || !arm.outcomes || !Array.isArray(arm.completed))
                throw new Error('paper_ledger_corrupt');
            for (const [slug, position] of Object.entries(arm.positions)) {
                if (!['pending', 'matched', 'filled'].includes(position.status) || position.market?.slug !== slug)
                    throw new Error('paper_position_corrupt');
                if (position.status === 'pending') {
                    arm.outcomes[slug] = { pnl: 0, noExposure: true, reason: 'restart_during_pending_execution' };
                    delete arm.positions[slug];
                } else if (![position.entryCost, position.holdings, position.fees].every(Number.isFinite)
                    || !(position.entryCost > 0 && position.holdings > 0)) throw new Error('paper_position_corrupt');
            }
        }
        for (const slot of Object.values(this.state.slots)) if (slot.status === 'reserved') {
            slot.status = 'skipped'; slot.reason = 'restart_during_observation';
        }
        this.state.providers ||= {};
        for (const snapshot of this.state.snapshots) for (const [name, decision] of Object.entries(snapshot.decisions || {})) {
            if (!['requested', 'pending', 'running'].includes(decision.status)) continue;
            Object.assign(decision, { status: 'restart_during_provider_request', action: 'SKIP', entryDisposition: 'restart_during_provider_request' });
            const arm = this.state.arms[name], slug = snapshot.market?.slug;
            if (arm && slug && !arm.positions[slug] && !arm.outcomes[slug]) arm.outcomes[slug] = {
                pnl: 0, noExposure: true, reason: 'restart_during_provider_request' };
        }
        const manifest = path.join(this.dir, 'manifest.json');
        if (!fs.existsSync(manifest)) atomicJson(manifest, { id: config.id, createdAt: this.state.startedAt,
            paperOnly: true, sources: config.sources, policy: config.policy });
        this.save();
        if (!fs.existsSync(active)) atomicJson(active, { id: config.id, startedAt: this.state.startedAt, paperOnly: true });
    }
    save() { atomicJson(this.filename, this.state); }
    event(type, detail = {}) {
        this.save();
        const row = { ...detail, type, id: this.config.id, at: new Date().toISOString() };
        try {
            fs.appendFileSync(path.join(this.dir, 'events.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
            console.log(JSON.stringify(row));
        } catch {
            const error = new Error('paper_event_log_failed'); error.durableStateCommitted = true; throw error;
        }
    }
    error(stage, error) {
        const code = safeCode(error?.code || error?.message);
        const key = `${safeCode(stage)}:${code}`;
        this.state.errors[key] = (this.state.errors[key] || 0) + 1;
        this.event('error', { stage: safeCode(stage), code });
    }
}
