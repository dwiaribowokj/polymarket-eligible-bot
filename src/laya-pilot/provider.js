import { ProviderManager } from '../ai-shadow/providers.js';

export class LayaProvider extends ProviderManager {
    async preflight() {
        const state = this.state.laya ||= {};
        let result;
        try {
            const health = await this.read(this.config.layaUrl + '/health');
            if (!health.loaded?.includes('typed-decisions')) throw new Error('laya_checkpoint_unavailable');
            const tokenizer = await this.counter.start();
            if (tokenizer.maxTokens !== 1024) throw new Error('laya_context_mismatch');
            if (state.tokenizerIdentity && state.tokenizerIdentity !== tokenizer.identity) {
                state.disabled ||= 'laya_artifact_changed';
                throw new Error('laya_artifact_changed');
            }
            state.tokenizerIdentity = tokenizer.identity;
            result = { ready: !state.disabled, model: 'typed-decisions', tokenizer,
                ...(state.disabled ? { reason: state.disabled } : {}) };
        } catch (error) {
            result = { ready: false, reason: /^[a-z_]+$/.test(error.message) ? error.message : 'laya_probe_failed' };
        }
        this.availability.laya = result.ready;
        state.unavailable = result.ready ? null : result.reason;
        if (!result.ready) state.unavailableSince ||= Date.now();
        else if (state.unavailableSince) {
            const ms = Date.now() - state.unavailableSince;
            state.recoveredOutageMs = (state.recoveredOutageMs || 0) + ms;
            state.longestOutageMs = Math.max(state.longestOutageMs || 0, ms);
            state.unavailableSince = null;
        }
        this.onEvent('provider_preflight', { provider: 'laya', ready: result.ready, reason: result.reason || null });
        return { laya: result };
    }
    async predict(name, snapshot) {
        if (name !== 'laya') throw new Error('laya_only');
        return super.predict(name, snapshot);
    }
}
