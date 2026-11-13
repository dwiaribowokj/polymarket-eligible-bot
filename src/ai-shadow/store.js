import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { ARMS } from './config.js';

// Caller holds the shadow process lock. Rotation is explicit and never clears
// an existing stop or transfers results into the replacement experiment.
export function archiveActivePeriod(dataDir, reason, now = Date.now()) {
    if (!/^[a-z][a-z0-9_-]{2,80}$/.test(reason || '')) throw new Error('invalid_archive_reason');
    const active = path.join(dataDir, 'active.json');
    if (!fs.existsSync(active)) throw new Error('shadow_active_period_missing');
    const marker = JSON.parse(fs.readFileSync(active));
    if (!/^[a-zA-Z0-9_-]+$/.test(marker.id || '')) throw new Error('shadow_active_identity_invalid');
    const dir = path.join(dataDir, marker.id), filename = path.join(dir, 'ledger.json');
    const state = JSON.parse(fs.readFileSync(filename));
    if (state.id !== marker.id) throw new Error('shadow_ledger_identity_mismatch');
    if (Object.values(state.arms).some(arm => arm.position)) throw new Error('shadow_archive_inventory_open');
    if (Object.values(state.providers).some(provider => provider.pending)) throw new Error('shadow_archive_inference_pending');
    state.archivedAt = now; state.archiveReason = reason; state.frozenAt ||= now;
    atomicJson(filename, state);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ at: new Date(now).toISOString(),
        id: marker.id, type: 'period_archived', reason, deadline: state.deadline }) + '\n', { mode: 0o600 });
    // Rename the marker last; a crash before this step leaves startup blocked.
    fs.renameSync(active, path.join(dir, 'archived-active.json'));
    return state;
}

export class ShadowStore {
    constructor(config) {
        this.config = config; this.dir = path.join(config.dataDir, config.id);
        const active=path.join(config.dataDir,'active.json');
        if(fs.existsSync(active) && JSON.parse(fs.readFileSync(active)).id!==config.id)throw new Error('shadow_baseline_changed_use_frozen_period');
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        this.filename = path.join(this.dir, 'ledger.json');
        if (fs.existsSync(this.filename)) this.state = JSON.parse(fs.readFileSync(this.filename));
        else this.state = { schema: 1, id: config.id, startedAt: Date.now(), deadline: config.deadline,
            frozenAt: null, providers: {}, slots: {}, snapshots: [], markets: {}, errors: {},
            arms: Object.fromEntries(ARMS.map(name => [name, { cash: config.capital, peak: config.capital,
                drawdown: 0, shadowStop: null, stopped: null, seen: {}, position: null, completed: [], outcomes: {} }])) };
        if (this.state.id !== config.id) throw new Error('shadow_ledger_identity_mismatch');
        for (const arm of Object.values(this.state.arms)) {
            if (!Number.isFinite(arm.cash) || !arm.seen || !Array.isArray(arm.completed)) throw new Error('shadow_ledger_corrupt');
            if (arm.position?.status === 'pending') {
                arm.position.status = 'cancelled'; arm.position.reason = 'restart_during_pending_execution';
                arm.outcomes[arm.position.market.slug] = { pnl: 0, reason: arm.position.reason };
                arm.position = null;
            }
        }
        for (const provider of Object.values(this.state.providers)) {
            if (provider.pending) { provider.disabled = 'restart_with_unknown_inference'; provider.pending = null; }
        }
        const manifest = path.join(this.dir, 'manifest.json');
        if (!fs.existsSync(manifest)) atomicJson(manifest, { id: config.id, createdAt: this.state.startedAt,
            deadline: config.deadline, sources: config.sources, policy: Object.fromEntries(Object.entries(config)
                .filter(([key]) => !['control', 'ninerouterKey', 'root', 'dataDir', 'routerDb'].includes(key))), paperOnly: true });
        if(!fs.existsSync(active))atomicJson(active,{id:config.id,deadline:config.deadline,startedAt:this.state.startedAt});
        if(config.root){const frozen=path.join(this.dir,'runtime-frozen');fs.mkdirSync(frozen,{recursive:true,mode:0o700});
            for(const [file] of config.sources){const source=file==='entry'?'scripts/ai-shadow.js':file==='tokenizer'?'scripts/ai-shadow-tokenizer.py':`src/ai-shadow/${file}`;
                const target=path.join(frozen,source);if(!fs.existsSync(target)){fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.copyFileSync(path.join(config.root,source),target);}}
        }
        this.save();
    }
    save() { atomicJson(this.filename, this.state); }
    event(type, detail = {}) {
        const row = { at: new Date().toISOString(), id: this.config.id, type, ...detail };
        this.save();
        fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
        console.log(JSON.stringify(row));
    }
    error(stage, error) {
        const code = error?.code || (/^[a-z][a-z0-9_]{1,80}$/.test(error?.message || '') ? error.message : error?.name || 'Error');
        const key = `${stage}:${code}`; this.state.errors[key] = (this.state.errors[key] || 0) + 1;
        this.event('error', { stage, code, category:error?.category||null,httpStatus:error?.httpStatus||null,durationMs:error?.durationMs||null,
            ...(error?.tickContext?{tickContext:error.tickContext}:{}) });
    }
    freeze(now = Date.now()) {
        if (this.state.frozenAt || now < this.config.deadline) return;
        this.state.frozenAt = this.config.deadline;
        for (const [name, arm] of Object.entries(this.state.arms)) {
            if (arm.position?.status === 'pending') {
                arm.outcomes[arm.position.market.slug] = { pnl: 0, reason: 'deadline_pending_cancelled' };
                arm.position = null; this.event('pending_cancelled', { arm: name, reason: 'deadline' });
            }
        }
        this.event('entries_frozen', { deadline: new Date(this.config.deadline).toISOString() });
    }
}
