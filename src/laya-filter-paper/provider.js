import { AsyncLocalStorage } from 'node:async_hooks';
import { LayaLiveProvider } from '../laya-live/provider.js';
import { ADAPTIVE_TIMEOUT_POLICY, decisionBudget } from './decision-budget.js';

export class FilterPaperProvider extends LayaLiveProvider {
    constructor(config, state, onEvent = () => {}, options = {}) {
        const budgetContext = new AsyncLocalStorage();
        const providerConfig = { ...config };
        // The inherited manager installs its timer after the durable pending event.
        // Read the remaining absolute budget there, without changing shared/live config.
        Object.defineProperty(providerConfig, 'decisionMs', { enumerable: true, get() {
            const deadline = budgetContext.getStore()?.decisionDeadlineAt;
            return deadline === undefined ? config.decisionMs : Math.max(0, deadline - Date.now());
        } });
        super(providerConfig, state, onEvent, options);
        this.paperConfig = config; this.budgetContext = budgetContext;
        const request = this.fetch.bind(this);
        this.fetch = async (...args) => {
            const budget = budgetContext.getStore();
            if (budget && Date.now() >= budget.decisionDeadlineAt) {
                budget.expiredBeforeDispatch = true;
                // A local expiry must not be classified as an uncertain HTTP submission.
                throw new Error('invalid_response');
            }
            return request(...args);
        };
    }

    async predict(name, snapshot) {
        if (name !== 'laya') throw new Error('laya_only');
        if (this.paperConfig.decisionTimeoutPolicy !== ADAPTIVE_TIMEOUT_POLICY) return super.predict(name, snapshot);
        if (this.closed || this.state[name]?.disabled || this.active.has(name) || this.state[name]?.pending
            || this.availability[name] === false) return super.predict(name, snapshot);
        let budget;
        try {
            budget = decisionBudget(this.paperConfig, snapshot, Date.now());
            if (snapshot.decisionDeadlineAt !== budget.decisionDeadlineAt) throw new Error('decision_deadline_mismatch');
        } catch (error) {
            return { snapshotId: snapshot.snapshotId, status: 'invalid_decision_budget', action: 'SKIP',
                reason: error.message, latencyMs: 0, cost: 0 };
        }
        const detail = { ...budget, timeoutPolicy: ADAPTIVE_TIMEOUT_POLICY };
        if (!budget.decisionBudgetMs) return { snapshotId: snapshot.snapshotId, status: 'decision_budget_expired',
            action: 'SKIP', latencyMs: 0, cost: 0, ...detail };
        return this.budgetContext.run(budget, async () => {
            const decision = await super.predict(name, snapshot);
            if (budget.expiredBeforeDispatch) return { ...decision, ...detail, status: 'decision_budget_expired',
                action: 'SKIP', executable: false, reason: 'expired_before_dispatch', requestSubmitted: false };
            // A stalled event loop may deliver a completed response before an overdue timer.
            if (decision.status === 'ok' && decision.receivedAt > budget.decisionDeadlineAt)
                return { ...decision, ...detail, status: 'decision_timeout', action: 'SKIP',
                    executable: false, lateDecision: decision.action, actualLatencyMs: decision.latencyMs,
                    reason: 'decision_deadline_exceeded' };
            return { ...decision, ...detail };
        });
    }
}
