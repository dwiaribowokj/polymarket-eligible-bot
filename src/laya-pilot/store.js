import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { ShadowStore } from '../ai-shadow/store.js';

export class LayaStore extends ShadowStore {
    constructor(config) {
        // ShadowStore's constructor creates three arms. This period has one.
        super(Object.assign(Object.create(config), { dataDir: config.dataDir, root: null, sources: [] }));
        this.config = config;
        const arm = this.state.arms.laya;
        if (['control', '9router'].some(name => this.state.arms[name]?.position || this.state.arms[name]?.completed.length))
            throw new Error('laya_ledger_contains_other_strategy');
        this.state.arms = { laya: arm };
        this.state.purpose = 'paper_pilot_rehearsal';
        // Explicit whitelist: no wallet key, RPC credentials, or router secret.
        atomicJson(path.join(this.dir, 'manifest.json'), { id: config.id, paperOnly: true,
            createdAt: this.state.startedAt, deadline: this.state.deadline, sources: config.sources,
            policy: { provider: 'laya', model: config.model, sourceExperiment: config.sourceExperiment,
                capital: config.capital, shares: config.shares, entryCap: config.entryCap,
                drawdownStop: config.drawdownStop, maxMarkets: config.maxMarkets, hours: config.hours,
                decisionMs: config.decisionMs, dataAgeMs: config.dataAgeMs } });
        const frozen = path.join(this.dir, 'runtime-frozen');
        for (const [file] of config.sources) {
            const relative = file === 'entry' ? 'scripts/laya-pilot.js' : `src/laya-pilot/${file}`;
            const target = path.join(frozen, relative);
            if (!fs.existsSync(target)) {
                fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
                fs.copyFileSync(path.join(config.root, relative), target);
            }
        }
        this.save();
    }
}
