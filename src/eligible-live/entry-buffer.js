import { createHash } from 'node:crypto';
import { buildDecisionContext } from '../decision-paper/features.js';
import { ENTRY_FILTER_POLICY, evaluateEntryFilter } from '../decision-paper/entry-filter.js';
import { OperationalError } from '../restart/network.js';
import { validateEligibleEntryFilter, validateEligibleEntrySnapshot,
    evaluateEligibleEntryCostCap, assertEligibleEntryCostCap } from './entry-cost-cap.js';

export const ELIGIBLE_BUFFER_POLICY = Object.freeze({ ...ENTRY_FILTER_POLICY, requireObservedClosing: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw new Error(reason); };
const freeze = value => {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};

export function validateEligibleEntryPolicy(policy, options) {
    if (policy?.version !== ELIGIBLE_BUFFER_POLICY.version) return validateEligibleEntryFilter(policy, options);
    if (!record(policy) || Object.keys(policy).length !== Object.keys(ELIGIBLE_BUFFER_POLICY).length
        || Object.entries(ELIGIBLE_BUFFER_POLICY).some(([key, value]) => policy[key] !== value))
        fail('invalid_eligible_entry_filter');
    return ELIGIBLE_BUFFER_POLICY;
}

export function eligibleEntryPolicy(config) {
    const policy = config.policy ? config.policy.entryFilter : config.entryFilter;
    return validateEligibleEntryPolicy(policy, { gasUsd: config.ai?.gasUsd ?? config.gasUsd });
}

// Match the paper encoder's rounding using only fields required by BUFFER and its context.
function paperInput(snapshot) {
    const input = JSON.parse(snapshot.input);
    if (!record(input) || ![input.opening_twap, input.spot, input.twap, input.volatility_usd_sqrt_s]
        .every(value => Number.isFinite(value) && value > 0)) fail('eligible_entry_buffer_input_invalid');
    return JSON.stringify({ seconds: input.seconds, open_usd: input.opening_twap,
        delta_cents: [input.spot, input.twap].map(value => Number(((value - input.opening_twap) * 100).toFixed(0))),
        sigma_milliusd: Number((input.volatility_usd_sqrt_s * 1000).toFixed(0)),
        fee: [input.fee_rate, input.fee_exponent], shares: input.shares, cap_usd: input.entry_cap,
        limit_cost_up_down: input.limit_cost_up_down, allowed: input.allowed });
}

const marketContext = market => ({ slug: market.slug, open: market.open, end: market.end, reference: market.reference });

export function prepareEligibleEntryBuffer(snapshot, market, btc, config) {
    if (eligibleEntryPolicy(config)?.version !== ELIGIBLE_BUFFER_POLICY.version) return;
    try {
        const input = paperInput(snapshot), inputHash = hash(input);
        const adapted = { ...snapshot, input, inputHash, marketEnd: market.end };
        const context = { snapshotId: snapshot.snapshotId, at: snapshot.at, observedAt: snapshot.observedAt,
            originalInputHash: snapshot.inputHash, market: structuredClone(marketContext(market)), input, inputHash,
            informed: buildDecisionContext(adapted, market, btc, config.ai ?? config, snapshot.at) };
        snapshot.entryBuffer = freeze({ context, contextHash: hash(JSON.stringify(context)) });
    } catch (error) {
        snapshot.entryBuffer = freeze({ error: /^[a-z_]+$/.test(error.message)
            ? error.message : 'eligible_entry_buffer_context_invalid' });
    }
}

function bufferSnapshot(snapshot, config, now, market) {
    const buffer = snapshot.entryBuffer, context = buffer?.context;
    if (buffer?.error) fail(buffer.error);
    if (!record(context) || buffer.contextHash !== hash(JSON.stringify(context))
        || context.originalInputHash !== snapshot.inputHash || context.snapshotId !== snapshot.snapshotId
        || context.at !== snapshot.at || context.observedAt !== snapshot.observedAt
        || context.input !== paperInput(snapshot) || context.inputHash !== hash(context.input)
        || context.informed?.originalInput !== context.input || context.informed.originalInputHash !== context.inputHash
        || context.informed.snapshotId !== snapshot.snapshotId || context.informed.at !== snapshot.at
        || context.informed.observedAt !== snapshot.observedAt
        || context.informed.inputHash !== hash(context.informed.input)) fail('eligible_entry_buffer_context_invalid');
    if (!record(context.market) || context.market.slug !== snapshot.market
        || ![context.market.open, context.market.end].every(Number.isFinite)
        || context.market.end - context.market.open !== 300000 || snapshot.at < context.market.open
        || snapshot.at >= context.market.end || now >= context.market.end
        || market && !same(context.market, marketContext(market))) fail('eligible_entry_buffer_market_changed');
    const featureAt = context.market.end - JSON.parse(context.input).seconds * 1000;
    // The shared feature builder rounds seconds before the snapshot is persisted.
    if (!Number.isFinite(featureAt) || featureAt > snapshot.at + 5.001
        || snapshot.at - featureAt > (config.ai ?? config).dataAgeMs + 5.001)
        fail('eligible_entry_buffer_input_invalid');
    const closing = context.informed.calculated?.closingTwap;
    if (closing?.status === 'observed' && (!Number.isFinite(closing.asOf) || closing.asOf > snapshot.at
        || now - closing.asOf > (config.ai ?? config).dataAgeMs)) fail('eligible_entry_buffer_context_stale');
    return { ...snapshot, input: context.input, inputHash: context.inputHash, informed: context.informed };
}

export function evaluateEligibleEntryPolicy(snapshot, config, now, { market, spec } = {}) {
    const policy = eligibleEntryPolicy(config);
    if (policy?.version !== ELIGIBLE_BUFFER_POLICY.version)
        return evaluateEligibleEntryCostCap(snapshot, config, now, { market, spec });
    const base = { policy, inputHash: typeof snapshot?.inputHash === 'string' ? snapshot.inputHash : null,
        contextHash: snapshot?.entryBuffer?.contextHash ?? null, checkedAt: now };
    try {
        const order = validateEligibleEntrySnapshot(snapshot, policy, config, now, market, spec);
        const adapted = bufferSnapshot(snapshot, config, now, market);
        let verdict = evaluateEntryFilter(adapted, order.action, policy);
        // This is the BUFFER arm's final-minute rule, including its strict <60 cutoff.
        if (JSON.parse(adapted.input).seconds < 60 && adapted.informed.calculated.closingTwap.status !== 'observed')
            verdict = { ...verdict, pass: false, reason: 'entry_filter_closing_context_unavailable' };
        return { ...verdict, ...base };
    } catch (error) {
        return { version: policy.version, pass: false,
            reason: /^(eligible_entry_|decision_)/.test(error.message) ? error.message : 'eligible_entry_buffer_context_invalid',
            metrics: null, ...base };
    }
}

export function assertEligibleEntryPolicy({ snapshot, config, now, market, spec, decision }) {
    if (eligibleEntryPolicy(config)?.version !== ELIGIBLE_BUFFER_POLICY.version)
        return assertEligibleEntryCostCap({ snapshot, config, now, market, spec, decision });
    const verdict = evaluateEligibleEntryPolicy(snapshot, config, now, { market, spec });
    let reason = verdict.reason;
    if (verdict.pass && (!decision?.entryFilter?.pass || decision.action !== verdict.metrics.action
        || decision.entryFilter.inputHash !== verdict.inputHash || decision.entryFilter.contextHash !== verdict.contextHash
        || !same(decision.entryFilter.policy, verdict.policy) || !same(decision.entryFilter.metrics, verdict.metrics)))
        reason = 'eligible_entry_filter_decision_changed';
    if (reason) throw new OperationalError(reason, 'opportunity', { stage: 'entry_buffer_filter',
        entryFilter: { ...verdict, pass: false, reason } });
    return verdict;
}
