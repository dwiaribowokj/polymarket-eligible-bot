import { FilterPaperEngine } from '../laya-filter-paper/engine.js';
import { decisionBudget } from '../laya-filter-paper/decision-budget.js';
import { buildDecisionContext } from './features.js';
import { preserveLateEvidence } from './events.js';
import { evaluateEntryFilter } from './entry-filter.js';

const skipped = (snapshot, status) => ({ snapshotId: snapshot.snapshotId, status, action: 'SKIP',
    executable: false, latencyMs: 0, cost: 0, inferenceAttempted: false });

export class DecisionPaperEngine extends FilterPaperEngine {
    prepareSnapshot(snapshot, market) {
        snapshot.filterVerdicts = structuredClone(snapshot.filterVerdicts);
        for (const verdict of Object.values(snapshot.filterVerdicts))
            for (const name of this.armNames) verdict[name] = { pass: true, reason: null };
        snapshot.providerDecisions = {}; snapshot.inferenceAttempts = {};
        try { snapshot.informed = buildDecisionContext(snapshot, market, this.client.btc, this.config, snapshot.at); }
        catch (error) { snapshot.contextError = /^[a-z_]+$/.test(error.message) ? error.message : 'decision_context_invalid'; }
        if (this.armNames.includes('laya-filtered')) for (const [action, verdict] of Object.entries(snapshot.filterVerdicts))
            verdict['laya-filtered'] = evaluateEntryFilter(snapshot, action, this.config.entryFilter);
    }
    admit(name, decision, snapshot, market) {
        const at = this.clock();
        const row = { ...preserveLateEvidence(decision, snapshot.providerDecisions[name]), admittedAt: at,
            inferenceAttempted: snapshot.inferenceAttempts[name] === true };
        if (['laya', 'gemini'].includes(name)) snapshot.providerDecisions[name] = row;
        if (name === 'laya') snapshot.sharedDecision = row;
        const events = [{ type: 'decision', detail: { provider: name, shared: false, ...row } }];
        // One Laya response, admission timestamp and execution cohort isolate the filter effect.
        const targets = name === 'laya' && this.armNames.includes('laya-filtered') ? ['laya', 'laya-filtered'] : [name];
        for (const target of targets) {
            const applied = snapshot.decisions[target] = target === name ? row : {
                ...structuredClone(row), inferenceAttempted: false, inferenceSource: 'laya' };
            this.apply(target, applied, snapshot, market, snapshot.allowed, at, events);
            if (target === 'laya-filtered' && applied.entryDisposition === 'filter_veto') {
                applied.originalAction = applied.action; applied.action = 'SKIP'; applied.executable = false;
            }
        }
        this.eventBatch(events);
        return row;
    }
    async dispatchDecisions(snapshot, market, finalGate, inferenceAt) {
        const inputAge = inferenceAt - snapshot.observedAt;
        const metadataAge = inferenceAt - this.validationObservedAt(snapshot.validation);
        const reason = finalGate === false ? 'inference_gate_blocked'
            : inputAge < 0 || inputAge > this.maxInputAgeMs() ? 'insufficient_input_headroom'
                : metadataAge < 0 || metadataAge > this.maxInputAgeMs() ? 'insufficient_validation_headroom' : null;
        if (reason) {
            for (const name of this.armNames.filter(name => name !== 'laya-filtered'))
                this.admit(name, skipped(snapshot, reason), snapshot, market);
            return;
        }
        const budget = decisionBudget(this.config, snapshot, inferenceAt);
        snapshot.decisionDeadlineAt = budget.decisionDeadlineAt; Object.assign(snapshot.timing, budget);
        snapshot.sharedDecision = skipped(snapshot, 'pending');
        for (const name of ['laya', 'gemini']) snapshot.providerDecisions[name] = {
            ...skipped(snapshot, 'pending'), cost: name === 'gemini' ? null : 0 };
        this.store.save();
        // The no-AI comparator pays the same execution latency, without an artificial AI wait.
        for (const name of ['eligible', 'skip']) {
            const at = this.clock(), index = snapshot.allowed.length === 1 ? snapshot.allowed[0].index : -1;
            const action = name === 'eligible' && index >= 0 ? ['BUY_UP', 'BUY_DOWN'][index] : 'SKIP';
            this.admit(name, { ...skipped(snapshot, 'ok'), action, executable: action !== 'SKIP',
                requestedAt: at, receivedAt: at, model: 'deterministic', policy: this.config.armPolicies?.[name] }, snapshot, market);
        }
        const results = await Promise.allSettled(['laya', 'gemini'].map(async name => {
            let decision;
            const targets = name === 'laya' && this.armNames.includes('laya-filtered') ? ['laya', 'laya-filtered'] : [name];
            const executionAvailable = targets.some(target => snapshot.eligibleArms[target] && this.available(target, market.slug));
            const diagnosticOnly = !executionAvailable && this.config.providerObservationPolicy === 'continue-after-risk-stop-v1'
                && targets.every(target => this.store.state.arms[target]?.stopped);
            if (diagnosticOnly) Object.assign(snapshot.providerDecisions[name], {
                diagnosticOnly: true, diagnosticReason: 'execution_risk_stopped' });
            if (!executionAvailable && !diagnosticOnly)
                decision = skipped(snapshot, 'arm_unavailable');
            else if (name === 'gemini' && snapshot.contextError) decision = skipped(snapshot, snapshot.contextError);
            else if (this.closed || this.store.state.frozenAt) decision = skipped(snapshot, 'closed');
            else {
                const now = this.clock();
                if (now - snapshot.observedAt > this.maxInputAgeMs()
                    || now - this.validationObservedAt(snapshot.validation) > this.maxInputAgeMs())
                    decision = skipped(snapshot, 'insufficient_dispatch_headroom');
                else {
                    try { decision = await this.providers.predict(name, snapshot); }
                    catch { decision = { ...skipped(snapshot, 'provider_error'), cost: name === 'laya' ? 0 : null,
                        reason: 'provider_operation_failed' }; }
                }
            }
            if (diagnosticOnly) decision = { ...decision, diagnosticOnly: true, diagnosticReason: 'execution_risk_stopped' };
            this.admit(name, decision, snapshot, market);
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
    }
}
