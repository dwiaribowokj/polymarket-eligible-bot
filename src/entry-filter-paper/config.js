import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadFilterPaperConfig } from '../laya-filter-paper/config.js';
import { ENTRY_FILTER_POLICY } from '../decision-paper/entry-filter.js';
import { DECISION_CONTEXT_VERSION } from '../decision-paper/features.js';

export const ENTRY_FILTER_ARMS = Object.freeze(['eligible', 'cost-cap', 'buffer', 'combined']);
export const LIVE_TUNING_PROFILE = 'live-tuning-v1';
export const LIVE_TUNING_RECOVERY_PROFILE = 'live-tuning-v2';
export const LIVE_COST_CAP_PROFILE = 'live-cost-cap-v1';
export const isLiveTuningProfile = profile => [LIVE_TUNING_PROFILE, LIVE_TUNING_RECOVERY_PROFILE,
    LIVE_COST_CAP_PROFILE].includes(profile);
export const LIVE_TUNING_ARMS = Object.freeze(['cost-cap-control', 'cost-cap-90s', 'cost-cap-drop-2c']);
export const LIVE_COST_CAP_ARMS = Object.freeze(['cost-cap-control', 'cost-cap-082']);
export const LIVE_TUNING_POLICY = Object.freeze({ version: LIVE_TUNING_PROFILE,
    selectedSlotSeconds: 90, maxAskDropUsd: 0.02, askDropComparison: 'strictly-greater',
    askDropBasis: 'snapshot-best-ask-to-shared-execution-best-ask',
    vetoConsumesMarketAttempt: true, firstCheckpointHours: 24,
    promotion: 'manual-review-only',
    fillSimulation: 'fixed-five-shares-depth-sweep-live-fak-may-fill-more-on-price-improvement' });
export const ENTRY_OBSERVATION_POLICY = Object.freeze({ version: 'causal-closing-and-rest-recovery-v2',
    slots: [90, 57, 30], closingDelayMs: 3000, btcHistoryMs: 180000, maxSourceAgeMs: 5000,
    restFallback: 'independent-current-book-and-tick-verification', persistence: 'atomic-decision-cohort' });

export function loadEntryFilterPaperConfig(env = process.env, out, profile = null) {
    if (profile !== null && !isLiveTuningProfile(profile)) throw new Error('invalid_entry_filter_profile');
    const base = loadFilterPaperConfig(env, out);
    const { layaModel, layaDrainMs, providerMetadataMs, inputUsdPerMillion, outputUsdPerMillion,
        decisionProtocol, ...executionPolicy } = base.policy;
    const policy = { ...executionPolicy, schema: 2, experiment: 'entry-filter-paper-v2',
        armNames: [...ENTRY_FILTER_ARMS], baselineArm: 'eligible', inferencePolicy: 'none',
        executionPolicy: 'deterministic-shared-admission-and-verified-book-recovery-v2',
        observationPolicy: { ...ENTRY_OBSERVATION_POLICY }, slots: [...ENTRY_OBSERVATION_POLICY.slots],
        snapshotAgeTargetMs: 4600, snapshotSlotReserveMs: 500,
        executionBook: 'validated-websocket-or-fresh-rest',
        decisionMs: 0, decisionProtocol: null, costCapPerShare: 0.85,
        costCapPolicy: 'full-fill-at-frozen-limit-including-fees-and-gas-v1',
        partialFillEconomics: 'actual-cost-reported-cap-not-guaranteed',
        entryFilter: { ...ENTRY_FILTER_POLICY }, contextVersion: DECISION_CONTEXT_VERSION,
        closingContextPolicy: 'observed-required-within-final-minute-v1',
        comparison: 'independent-deterministic-entry-filter-variants',
        modelEdgeUse: 'shared-data-validation-and-diagnostics-only',
        armPolicies: { eligible: 'buy-single-eligible-side-without-ai',
            'cost-cap': 'full-fill-all-in-cost-at-most-085', buffer: ENTRY_FILTER_POLICY.version,
            combined: 'cost-cap-and-direction-volatility-buffer' } };
    if (isLiveTuningProfile(profile)) Object.assign(policy, {
        profile, experiment: 'entry-filter-paper-live-tuning-v1', armNames: [...LIVE_TUNING_ARMS],
        baselineArm: 'cost-cap-control', executionPolicy: 'shared-admission-and-immutable-execution-cohort-v2',
        observationPolicy: { version: 'live-cost-cap-websocket-v1', slots: [90, 60, 30],
            btcHistoryMs: 180000, maxSourceAgeMs: 5000, restFallback: 'none',
            persistence: 'atomic-decision-cohort' },
        slots: [90, 60, 30], snapshotAgeTargetMs: 1600, snapshotSlotReserveMs: 100,
        executionBook: 'validated-websocket', closingContextPolicy: 'not-required-by-live-cost-cap',
        comparison: 'independent-preregistered-slot-and-ask-drop-variants',
        tuningPolicy: { ...LIVE_TUNING_POLICY },
        armPolicies: { 'cost-cap-control': 'full-fill-all-in-cost-at-most-085',
            'cost-cap-90s': 'cost-cap-and-only-90-second-slot',
            'cost-cap-drop-2c': 'cost-cap-and-execution-ask-drop-at-most-002' }
    });
    if ([LIVE_TUNING_RECOVERY_PROFILE, LIVE_COST_CAP_PROFILE].includes(profile)) Object.assign(policy, {
        experiment: 'entry-filter-paper-live-tuning-v2',
        executionPolicy: 'shared-admission-and-verified-book-recovery-v2',
        executionBook: 'validated-websocket-or-fresh-rest',
        observationPolicy: { ...policy.observationPolicy, version: 'live-cost-cap-verified-rest-recovery-v2',
            restFallback: 'independent-current-book-and-tick-verification' },
        tuningPolicy: { ...policy.tuningPolicy, version: LIVE_TUNING_RECOVERY_PROFILE },
        passiveCollection: { enabled: true, afterArmStop: true, whileArmsBusy: true,
            decisions: 'diagnostic-only-when-unavailable' },
        evaluationPolicy: { version: 'seven-day-frozen-policy-v1', durationMs: 7 * 86400000,
            minCompletedFillsPerArm: 100, minObservedDays: 7,
            comparisonWindow: 'common-entry-window-ending-at-first-arm-stop',
            holdout: 'next-independent-seven-day-period', promotion: 'manual-review-only' }
    });
    if (profile === LIVE_COST_CAP_PROFILE) Object.assign(policy, {
        experiment: 'entry-filter-paper-live-cost-cap-v1', armNames: [...LIVE_COST_CAP_ARMS],
        comparison: 'independent-preregistered-all-in-cost-cap-085-vs-082',
        armCostCaps: { 'cost-cap-control': 0.85, 'cost-cap-082': 0.82 },
        armPolicies: { 'cost-cap-control': 'full-fill-all-in-cost-at-most-085',
            'cost-cap-082': 'full-fill-all-in-cost-at-most-082' },
        tuningPolicy: { version: LIVE_COST_CAP_PROFILE, firstCheckpointHours: 24,
            admissionVetoConsumesMarketAttempt: false, reservedOrderConsumesMarketAttempt: true,
            promotion: 'manual-review-only', fillSimulation: LIVE_TUNING_POLICY.fillSimulation }
    });
    const sources = [...base.sources];
    const cli = 'scripts/entry-filter-paper.js';
    sources.push([cli, crypto.createHash('sha256').update(fs.readFileSync(path.join(base.root, cli))).digest('hex')]);
    sources.sort(([a], [b]) => a.localeCompare(b));
    const id = crypto.createHash('sha256').update(JSON.stringify({ policy, sources })).digest('hex').slice(0, 16);
    return { ...policy, id, policy, sources, root: base.root, dataDir: base.dataDir,
        control: base.control, deadline: Number.MAX_SAFE_INTEGER };
}
