import { FilterPaperStore } from '../laya-filter-paper/store.js';

export class DecisionPaperStore extends FilterPaperStore {
    recoverProvider(name, provider, now) {
        if (name !== 'gemini' || this.config.geminiRecoveryPolicy !== 'bounded-http-drain-and-persistent-cooldown-v1')
            return super.recoverProvider(name, provider, now);
        if (!provider.pending) return;
        // The old process may have submitted HTTP before dying. Keep a durable
        // quiet interval; never re-submit that snapshot after restarting.
        provider.recoveryAt = Math.max(provider.recoveryAt || 0,
            now + this.config.geminiDrainMs + this.config.geminiCooldownMs);
        provider.recoveryReason = 'restart_with_unknown_inference';
        provider.interrupted = { snapshotId: provider.pending.snapshotId, startedAt: provider.pending.startedAt,
            at: now, recoveryAt: provider.recoveryAt, cost: null };
        provider.attempted ||= {};
        if (typeof provider.pending.snapshotId === 'string') provider.attempted[provider.pending.snapshotId] ||= now;
        provider.pending = null;
    }
    constructor(config, now = Date.now()) {
        super(config, now);
        // Restart cannot resubmit an observed slot or leave an interrupted response pending forever.
        for (const snapshot of this.state.snapshots) for (const name of config.armNames) {
            snapshot.decisions ||= {}; snapshot.providerDecisions ||= {};
            const provider = ['laya', 'gemini'].includes(name);
            const decision = snapshot.decisions[name] || snapshot.providerDecisions[name];
            if (decision && decision.status !== 'pending') continue;
            const source = name === 'laya-filtered' ? 'laya' : name;
            const attempted = snapshot.inferenceAttempts?.[source] === true;
            const arm = this.state.arms[name];
            const reserved = arm.seen[snapshot.market]?.snapshotId === snapshot.snapshotId;
            const row = { ...decision, snapshotId: snapshot.snapshotId,
                status: attempted ? 'restart_with_unknown_inference' : 'restart_before_decision',
                action: 'SKIP', executable: false, cost: name === 'gemini' && attempted ? null : 0,
                entryDisposition: reserved ? 'reserved' : 'no_buy_decision', inferenceAttempted: provider && attempted,
                ...(source !== name ? { inferenceSource: source } : {}) };
            snapshot.decisions[name] = row;
            if (provider) snapshot.providerDecisions[name] = row;
            if (name === 'laya') snapshot.sharedDecision = row;
        }
        this.save();
    }
}
