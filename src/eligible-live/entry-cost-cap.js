import { createHash } from 'node:crypto';
import { fee, round } from '../restart/math.js';
import { OperationalError } from '../restart/network.js';
import { ELIGIBLE_BINANCE_LEAD_VETO } from './binance-lead.js';

export { ELIGIBLE_BINANCE_LEAD_VETO };

export const ELIGIBLE_ENTRY_FILTER_VERSION = 'full-fill-all-in-cost-cap-v1';
const BASIS = 'full_fill_at_frozen_limit';
const actions = ['BUY_UP', 'BUY_DOWN'];
const LEAD_CONTEXT_KEYS = ['source', 'at', 'ready', 'connected', 'mid', 'ageMs', 'ret5sBps', 'samples', 'messages'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = reason => { throw new Error(reason); };

function validBinanceLeadVeto(value) {
    const keys = Object.keys(ELIGIBLE_BINANCE_LEAD_VETO);
    return record(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => value[key] === ELIGIBLE_BINANCE_LEAD_VETO[key]);
}

export function validateEligibleEntryFilter(policy, { gasUsd } = {}) {
    if (policy === undefined) return null;
    if (!record(policy)) fail('invalid_eligible_entry_filter');
    const hasLead = Object.hasOwn(policy, 'binanceLeadVeto');
    if (Object.keys(policy).length !== (hasLead ? 5 : 4)
        || policy.version !== ELIGIBLE_ENTRY_FILTER_VERSION || policy.basis !== BASIS
        || ![.82, .85].includes(policy.maxCostPerShare) || !Number.isFinite(policy.gasUsd) || policy.gasUsd < 0
        || gasUsd !== undefined && policy.gasUsd !== gasUsd
        || hasLead && !validBinanceLeadVeto(policy.binanceLeadVeto))
        fail('invalid_eligible_entry_filter');
    return Object.freeze({ version: policy.version, maxCostPerShare: policy.maxCostPerShare,
        gasUsd: policy.gasUsd, basis: policy.basis,
        ...(hasLead ? { binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } : {}) });
}

export function eligibleEntryFilter(config) {
    const policy = config.policy ? config.policy.entryFilter : config.entryFilter;
    return validateEligibleEntryFilter(policy, { gasUsd: config.ai?.gasUsd ?? config.gasUsd });
}

// Match the paper cost-cap's rounded full-fill arithmetic, without requiring its TWAP context.
export function calculateFullFillEntryCost({ price, shares, schedule, gasUsd }) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1 || shares !== 5
        || !record(schedule) || ![schedule.rate, schedule.exponent, gasUsd].every(value => Number.isFinite(value) && value >= 0))
        fail('eligible_entry_cost_inputs_invalid');
    const feeUsd = fee(shares, price, schedule), allInCostUsd = round(shares * price + feeUsd + gasUsd);
    return { shares, limitPriceUsd: price, notionalUsd: round(shares * price), feeUsd, gasUsd,
        allInCostUsd, breakEvenProbability: allInCostUsd / shares, costBasis: BASIS, payoutPerWinningShareUsd: 1 };
}

export function validateEligibleEntrySnapshot(snapshot, policy, config, now, market, spec) {
    const settings = config.ai ?? config;
    if (!record(snapshot) || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId
        || typeof snapshot.input !== 'string' || hash(snapshot.input) !== snapshot.inputHash)
        fail('eligible_entry_filter_snapshot_hash_mismatch');
    if (snapshot.snapshotId !== hash(JSON.stringify({ slug: snapshot.market, seconds: snapshot.slot,
        now: snapshot.at, input: snapshot.input })).slice(0, 24))
        fail('eligible_entry_filter_snapshot_hash_mismatch');
    if (!same(snapshot.entryFilter, policy)) fail('eligible_entry_filter_policy_changed');
    if (![now, snapshot.at, snapshot.observedAt, snapshot.validation?.at].every(Number.isFinite)
        || snapshot.observedAt > snapshot.at || snapshot.at > now || snapshot.validation.at > now
        || !Number.isFinite(settings.dataAgeMs) || settings.dataAgeMs <= 0
        || now - Math.min(snapshot.observedAt, snapshot.validation.at) > settings.dataAgeMs)
        fail('eligible_entry_filter_snapshot_stale');
    let input, identity;
    try { input = JSON.parse(snapshot.input); identity = JSON.parse(snapshot.validation.identity); }
    catch { fail('eligible_entry_filter_snapshot_invalid'); }
    if (snapshot.provider !== 'eligible' || snapshot.model !== 'deterministic-eligible-v1'
        || !record(input) || !Array.isArray(identity) || identity.length !== 6
        || typeof identity[0] !== 'string' || !identity[0]
        || !Array.isArray(identity[1]) || identity[1].length !== 2 || identity[1][0] === identity[1][1]
        || !identity[1].every(token => typeof token === 'string' && token)
        || !record(identity[4]) || input.fee_rate !== identity[4].rate || input.fee_exponent !== identity[4].exponent
        || input.market !== snapshot.market || typeof snapshot.market !== 'string' || !snapshot.market
        || input.shares !== 5 || input.entry_cap !== 5
        || !Array.isArray(input.allowed) || input.allowed.length !== 1
        || !Array.isArray(snapshot.allowed) || snapshot.allowed.length !== 1
        || !Array.isArray(input.limit_cost_up_down) || input.limit_cost_up_down.length !== 2)
        fail('eligible_entry_filter_snapshot_invalid');
    const order = snapshot.allowed[0], index = order?.index;
    if (![0, 1].includes(index) || input.allowed[0] !== actions[index]
        || order.tokenId !== identity[1][index] || order.side !== 'BUY' || order.shares !== 5
        || order.kind !== undefined && order.kind !== 'taker') fail('eligible_entry_filter_order_mismatch');
    const cost = calculateFullFillEntryCost({ price: order.price, shares: order.shares,
        schedule: identity[4], gasUsd: policy.gasUsd ?? settings.gasUsd });
    const encoded = input.limit_cost_up_down[index];
    if (!Array.isArray(encoded) || encoded.length !== 2 || encoded[0] !== round(order.price * 100)
        || encoded[1] !== cost.allInCostUsd || order.cost !== cost.allInCostUsd
        || input.limit_cost_up_down[1 - index] !== null)
        fail('eligible_entry_filter_cost_mismatch');
    if (market && (market.slug !== snapshot.market || market.conditionId !== identity[0]
        || !same(market.tokens, identity[1]) || !same(market.fee, identity[4])))
        fail('eligible_entry_filter_market_changed');
    if (spec && (['index', 'tokenId', 'price', 'shares', 'side', 'cost'].some(key => spec[key] !== order[key])
        || spec.kind !== 'taker')) fail('eligible_entry_filter_order_mismatch');
    const current = market ? calculateFullFillEntryCost({ price: order.price, shares: order.shares,
        schedule: market.fee, gasUsd: settings.gasUsd }) : cost;
    if (!same(current, cost)) fail('eligible_entry_filter_cost_mismatch');
    return { action: actions[index], index, tokenId: order.tokenId, ...current };
}

function validateEligibleBinanceLeadContext(snapshot, policy, settings, now) {
    const leadPolicy = policy.binanceLeadVeto;
    const entryLead = snapshot.entryBinanceLead;
    if (!record(entryLead) || typeof entryLead.contextHash !== 'string' || !entryLead.contextHash)
        fail('eligible_entry_filter_lead_context_invalid');
    const { contextHash, ...lead } = entryLead;
    if (Object.keys(lead).length !== LEAD_CONTEXT_KEYS.length
        || LEAD_CONTEXT_KEYS.some(key => !Object.hasOwn(lead, key)))
        fail('eligible_entry_filter_lead_context_invalid');
    if (hash(JSON.stringify({ snapshotId: snapshot.snapshotId, policy: leadPolicy, lead })) !== contextHash)
        fail('eligible_entry_filter_lead_context_invalid');
    if (lead.source !== leadPolicy.source || !Number.isFinite(lead.at) || lead.at > now
        || now - lead.at > leadPolicy.staleMs
        || Number.isFinite(settings.dataAgeMs) && now - lead.at > settings.dataAgeMs)
        fail('eligible_entry_filter_lead_context_stale');
    return lead;
}

function costCapEntryPolicy(config) {
    const rawPolicy = config.policy ? config.policy.entryFilter : config.entryFilter;
    if (!rawPolicy || rawPolicy.version !== ELIGIBLE_ENTRY_FILTER_VERSION) return null;
    return eligibleEntryFilter(config);
}

export function prepareEligibleBinanceLead(snapshot, binanceLead, config, now = Date.now()) {
    const policy = costCapEntryPolicy(config);
    if (!policy?.binanceLeadVeto) return null;
    const status = typeof binanceLead?.status === 'function' ? binanceLead.status(now) : null;
    const lead = {
        source: policy.binanceLeadVeto.source,
        at: now,
        ready: status?.ready === true,
        connected: typeof status?.connected === 'boolean' ? status.connected : null,
        mid: Number.isFinite(status?.mid) ? status.mid : null,
        ageMs: Number.isFinite(status?.ageMs) ? status.ageMs : null,
        ret5sBps: Number.isFinite(status?.ret5sBps) ? status.ret5sBps : null,
        samples: Number.isSafeInteger(status?.samples) ? status.samples : null,
        messages: Number.isSafeInteger(status?.messages) ? status.messages : null,
    };
    const entryBinanceLead = {
        ...lead,
        contextHash: hash(JSON.stringify({ snapshotId: snapshot.snapshotId, policy: policy.binanceLeadVeto, lead })),
    };
    snapshot.entryBinanceLead = entryBinanceLead;
    return entryBinanceLead;
}

function buildBinanceLeadMetrics({ index, leadPolicy, checkedAt, ready, connected, mid, ageMs, ret5sBps, adverse }) {
    const dir = index === 0 ? 1 : -1;
    const directionalRet5sBps = ret5sBps !== null ? (dir * ret5sBps || 0) : null;
    return {
        source: leadPolicy.source,
        at: checkedAt,
        ready,
        connected,
        mid,
        ageMs,
        ret5sBps,
        directionalRet5sBps,
        lookbackMs: leadPolicy.lookbackMs,
        thresholdBps: leadPolicy.thresholdBps,
        staleMs: leadPolicy.staleMs,
        failClosed: leadPolicy.failClosed,
        adverse,
    };
}

export function evaluateEligibleEntryCostCap(snapshot, config, now, { market, spec } = {}) {
    const policy = eligibleEntryFilter(config);
    if (!policy) return null;
    let validated;
    try {
        const snapshotMetrics = validateEligibleEntrySnapshot(snapshot, policy, config, now, market, spec);
        const leadContext = policy.binanceLeadVeto
            ? validateEligibleBinanceLeadContext(snapshot, policy, config.ai ?? config, now) : null;
        validated = { snapshotMetrics, leadContext };
    } catch (error) {
        return { version: policy.version, policy, pass: false,
            reason: /^eligible_entry_/.test(error.message) ? error.message : 'eligible_entry_filter_snapshot_invalid',
            inputHash: typeof snapshot?.inputHash === 'string' ? snapshot.inputHash : null, checkedAt: now, metrics: null };
    }
    const { snapshotMetrics, leadContext } = validated;
    const metrics = {
        ...snapshotMetrics,
        costCapPerShare: policy.maxCostPerShare,
        interpretation: 'full_fill_break_even_not_predicted_win_probability',
        partialFillCapGuaranteed: false,
    };
    const costPass = metrics.breakEvenProbability <= policy.maxCostPerShare;
    if (!policy.binanceLeadVeto) {
        return { version: policy.version, policy, pass: costPass, reason: costPass ? null : 'entry_cost_above_cap',
            inputHash: snapshot.inputHash, checkedAt: now, metrics };
    }
    const dir = metrics.index === 0 ? 1 : -1;
    const leadFresh = leadContext.ready === true && leadContext.ret5sBps !== null
        && leadContext.ageMs !== null && leadContext.ageMs >= 0 && leadContext.ageMs <= policy.binanceLeadVeto.staleMs;
    const adverse = leadFresh && dir * leadContext.ret5sBps <= -policy.binanceLeadVeto.thresholdBps;
    const reason = !costPass ? 'entry_cost_above_cap'
        : !leadFresh ? 'binance_feed_not_ready'
        : adverse ? 'binance_lead_veto'
        : null;
    const binanceLead = buildBinanceLeadMetrics({
        index: metrics.index,
        leadPolicy: policy.binanceLeadVeto,
        checkedAt: leadContext.at,
        ready: leadContext.ready,
        connected: leadContext.connected,
        mid: leadContext.mid,
        ageMs: leadContext.ageMs,
        ret5sBps: leadContext.ret5sBps,
        adverse,
    });
    return { version: policy.version, policy, pass: reason === null, reason,
        inputHash: snapshot.inputHash, checkedAt: now, metrics: { ...metrics, binanceLead } };
}

export function assertEligibleEntryCostCap({ snapshot, config, now, market, spec, decision }) {
    const verdict = evaluateEligibleEntryCostCap(snapshot, config, now, { market, spec });
    if (!verdict) return null;
    let reason = verdict.reason;
    if (verdict.pass && (!decision?.entryFilter?.pass || decision.action !== verdict.metrics.action
        || decision.entryFilter.inputHash !== verdict.inputHash || !same(decision.entryFilter.policy, verdict.policy)
        || !same(decision.entryFilter.metrics, verdict.metrics))) reason = 'eligible_entry_filter_decision_changed';
    if (reason) throw new OperationalError(reason, 'opportunity', { stage: 'entry_cost_filter',
        entryFilter: { ...verdict, pass: false, reason } });
    return verdict;
}

export function assertEligibleBinanceLeadLive(binanceLead, config, spec, now = Date.now(), snapshot = null) {
    const policy = costCapEntryPolicy(config);
    const leadPolicy = policy?.binanceLeadVeto;
    if (!leadPolicy) return null;
    const index = spec?.index;
    if (![0, 1].includes(index)) throw new Error('eligible_entry_filter_order_mismatch');
    const status = typeof binanceLead?.status === 'function' ? binanceLead.status(now) : null;
    const ageMs = Number.isFinite(status?.ageMs) ? status.ageMs : null;
    const ret5sBps = Number.isFinite(status?.ret5sBps) ? status.ret5sBps : null;
    const leadFresh = status?.ready === true && ret5sBps !== null
        && ageMs !== null && ageMs >= 0 && ageMs <= leadPolicy.staleMs;
    const dir = index === 0 ? 1 : -1;
    const adverse = leadFresh && dir * ret5sBps <= -leadPolicy.thresholdBps;
    const reason = !leadFresh ? 'binance_feed_not_ready' : adverse ? 'binance_lead_veto' : null;
    if (reason) {
        throw new OperationalError(reason, 'opportunity', {
            stage: 'entry_cost_filter',
            entryFilter: {
                version: policy.version,
                policy,
                pass: false,
                reason,
                inputHash: typeof snapshot?.inputHash === 'string' ? snapshot.inputHash : null,
                checkedAt: now,
                metrics: {
                    index,
                    action: actions[index],
                    binanceLead: buildBinanceLeadMetrics({
                        index,
                        leadPolicy,
                        checkedAt: now,
                        ready: status?.ready === true,
                        connected: typeof status?.connected === 'boolean' ? status.connected : null,
                        mid: Number.isFinite(status?.mid) ? status.mid : null,
                        ageMs,
                        ret5sBps,
                        adverse,
                    }),
                },
            },
        });
    }
    return {
        ready: true,
        mid: Number.isFinite(status?.mid) ? status.mid : null,
        ageMs,
        ret5sBps,
        checkedAt: now,
    };
}
