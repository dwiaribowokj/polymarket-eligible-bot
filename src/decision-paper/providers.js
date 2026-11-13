import { FilterPaperProvider } from '../laya-filter-paper/provider.js';
import { GeminiPaperProvider } from './gemini.js';

export class DecisionProviders {
    constructor(config, state, emit, options = {}) {
        this.laya = new FilterPaperProvider(config, state, emit, options.laya);
        this.gemini = new GeminiPaperProvider(config, state, emit, options.gemini);
    }
    get active() { return new Map([...this.laya.active].map(([key, value]) => [`laya:${key}`, value])
        .concat([...this.gemini.active].map(([key, value]) => [`gemini:${key}`, value.task]))); }
    async preflight() {
        const [laya, gemini] = await Promise.all([this.laya.preflight(), this.gemini.preflight()]);
        return { laya: laya.laya, gemini };
    }
    predict(name, snapshot) {
        if (!['laya', 'gemini'].includes(name)) throw new Error('unknown_decision_provider');
        return this[name].predict(name, snapshot);
    }
    async drain(timeoutMs = this.laya.paperConfig.providerShutdownDrainMs ?? 30000) {
        let timer;
        const pending = Promise.allSettled([...this.active.values()]);
        try {
            const drained = await Promise.race([pending.then(() => true), new Promise(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            })]);
            if (!drained) this.gemini.close();
            return drained;
        } finally { clearTimeout(timer); }
    }
    close() { this.laya.close(); this.gemini.close(); }
}
