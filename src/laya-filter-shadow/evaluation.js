import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
    ? value : JSON.stringify(value)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new Error(`filter_shadow_${code}`); };
const round = value => Math.round(value * 1e6) / 1e6;
const actions = ['BUY_UP', 'BUY_DOWN'];
const protocolKeys = ['protocolVersion', 'variantId', 'promptVersion', 'promptHash', 'questionsHash'];
const protocol = value => Object.fromEntries(protocolKeys.map(key => [key, value?.[key] ?? null]));
export const RULES = Object.freeze({ version: 1, shares: 5, entryCap: 5, minPrice: .72, maxPrice: .90,
    lastSeconds: 20, lastMinPrice: .80, priceCap: .85, captureAgeMs: 5000,
    candidates: ['control', 'spot-twap', 'price-cap-085', 'combined'],
    alignment: 'both_deltas_strictly_align_with_chosen_action_zero_is_veto',
    cohort: 'whole_markets_starting_after_registration_captured_before_decision',
    missingData: 'exclude_with_reason_never_backfill', minimumDays: 7, minimumFilled: 100,
    bootstrapIterations: 2000, automaticPromotion: false, captureEndAt: null });

function sourceView(source) {
    if (!record(source) || source.mode !== 'pilot' || source.strategy !== 'late-entry'
        || source.decisionProvider !== 'laya' || typeof source.baseline !== 'string'
        || !Array.isArray(source.ai?.snapshots) || !Array.isArray(source.completed)
        || typeof source.ai.currentEvaluationEpochId !== 'string') fail('source_invalid');
    const epoch = source.ai.evaluationEpochs?.find(e => e.id === source.ai.currentEvaluationEpochId);
    const tokenizer = source.ai.providers?.laya?.tokenizerIdentity;
    if (!epoch || protocolKeys.some(k => typeof epoch.protocol?.[k] !== 'string')
        || typeof tokenizer !== 'string' || !tokenizer) fail('source_provenance_missing');
    return { baseline: source.baseline, epochId: epoch.id, protocol: protocol(epoch.protocol),
        tokenizerIdentity: tokenizer, model: 'typed-decisions' };
}

export function createExperiment(source, { now, sourcePath, codeHash, sourceHash }) {
    if (!Number.isSafeInteger(now) || now < 0 || ![sourcePath, codeHash, sourceHash].every(v => typeof v === 'string' && v))
        fail('registration_invalid');
    const manifest = { schema: 1, registeredAt: now, firstMarketOpenAt: (Math.floor(now / 300000) + 1) * 300000,
        sourcePath, sourceHash, codeHash, source: sourceView(source), rules: structuredClone(RULES),
        excludedHistoricalSnapshots: source.ai.snapshots.map(s => s.snapshotId),
        excludedHistoricalMarkets: source.completed.map(r => r.slug),
        automaticLiveChanges: false, extraInference: false, aiComputeCost: null };
    const id = hash(manifest);
    return { schema: 1, id, manifest, captures: [], excluded: [], scores: [], issues: [],
        registeredAt: now, lastPollAt: null, lastSuccessfulReadAt: null, captureStopped: null };
}

export function validateExperiment(state, codeHash) {
    if (state?.schema !== 1 || hash(state.manifest) !== state.id || state.manifest.codeHash !== codeHash
        || JSON.stringify(state.manifest.rules) !== JSON.stringify(RULES)
        || !['captures', 'excluded', 'scores', 'issues'].every(k => Array.isArray(state[k]))) fail('experiment_changed');
    for (const rows of [state.captures, state.excluded, state.scores])
        if (new Set(rows.map(r => r.snapshotId)).size !== rows.length) fail('duplicate_state_id');
    for (const capture of state.captures) {
        const expected = parseSnapshot(capture.frozenSnapshot, capture.capturedAt, state.manifest);
        if (hash(frozenCapture(expected)) !== hash(frozenCapture(capture))) fail('capture_state_changed');
    }
    for (const score of state.scores) {
        const capture = state.captures.find(c => c.snapshotId === score.snapshotId);
        if (!capture || hash(score) !== hash(scoreFromEvidence(capture, score.completionEvidence))) fail('score_state_changed');
    }
}

const immutableSnapshot = snapshot => ({ snapshotId: snapshot.snapshotId, market: snapshot.market,
    at: snapshot.at, observedAt: snapshot.observedAt, slot: snapshot.slot, inputHash: snapshot.inputHash,
    evaluationEpochId: snapshot.evaluationEpochId, decisionProtocol: protocol(snapshot.decisionProtocol),
    validation: { identity: snapshot.validation?.identity ?? null },
    input: snapshot.input, allowed: snapshot.allowed?.map(o => ({ index: o.index, price: o.price, shares: o.shares, cost: o.cost })) });
const frozenCapture = capture => Object.fromEntries(['snapshotId', 'market', 'conditionId', 'marketOpen', 'marketEnd',
    'sourceAt', 'capturedAt', 'epochId', 'inputHash', 'immutableHash', 'featureView', 'sides', 'frozenSnapshot'].map(k => [k, capture[k]]));

function parseSnapshot(snapshot, now, manifest) {
    const match = /^btc-updown-5m-(\d+)$/.exec(snapshot.market || '');
    if (!match) fail('market_invalid');
    const open = Number(match[1]) * 1000, end = open + 300000;
    if (!Number.isSafeInteger(open) || open % 300000 !== 0 || open < manifest.firstMarketOpenAt) fail('market_before_registration');
    if (!Number.isSafeInteger(snapshot.at) || snapshot.at < manifest.registeredAt || snapshot.at > now
        || snapshot.at < open || snapshot.at >= end || now >= end) fail('snapshot_not_prospective');
    if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt > snapshot.at
        || now - snapshot.observedAt > RULES.captureAgeMs || now - snapshot.at > RULES.captureAgeMs) fail('capture_stale');
    if (snapshot.evaluationEpochId !== manifest.source.epochId
        || JSON.stringify(protocol(snapshot.decisionProtocol)) !== JSON.stringify(manifest.source.protocol)) fail('snapshot_epoch_changed');
    if (typeof snapshot.input !== 'string' || hash(snapshot.input) !== snapshot.inputHash) fail('input_hash_invalid');
    let input;
    try { input = JSON.parse(snapshot.input); } catch { fail('input_json_invalid'); }
    let metadata;
    try { metadata = JSON.parse(snapshot.validation?.identity); } catch { fail('metadata_identity_invalid'); }
    if (!Array.isArray(metadata) || typeof metadata[0] !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(metadata[0]))
        fail('metadata_identity_invalid');
    if (!record(input) || input.shares !== RULES.shares || input.cap_usd !== RULES.entryCap
        || !Number.isFinite(input.seconds) || input.seconds < 10 || input.seconds > 90
        || Math.abs(snapshot.at + input.seconds * 1000 - end) > 200
        || !Array.isArray(input.delta_cents) || input.delta_cents.length !== 2
        || !input.delta_cents.every(Number.isFinite) || !Array.isArray(input.allowed)
        || !input.allowed.length || new Set(input.allowed).size !== input.allowed.length
        || input.allowed.some(a => !actions.includes(a)) || !Array.isArray(snapshot.allowed)
        || snapshot.allowed.length !== input.allowed.length) fail('features_invalid');
    const minimum = input.seconds <= RULES.lastSeconds ? RULES.lastMinPrice : RULES.minPrice;
    const sides = {};
    for (const action of input.allowed) {
        const index = action === 'BUY_UP' ? 0 : 1, direction = index === 0 ? 1 : -1;
        const orders = snapshot.allowed.filter(o => o.index === index), order = orders[0];
        const compactCost = input.limit_cost_up_down?.[index];
        if (orders.length !== 1 || ![order?.price, order?.shares, order?.cost].every(Number.isFinite)
            || order.shares !== RULES.shares || order.price < minimum || order.price > RULES.maxPrice
            || order.cost < order.price * order.shares - 1e-6 || order.cost > RULES.entryCap
            || !Array.isArray(compactCost) || !compactCost.every(Number.isFinite)
            || Math.abs(compactCost[0] - order.price * 100) > 1e-6
            || Math.abs(compactCost[1] - order.cost) > 1e-6) fail('entry_terms_invalid');
        const aligned = input.delta_cents.every(delta => delta * direction > 0), price = order.price <= RULES.priceCap;
        sides[action] = { limitPrice: order.price, estimatedEntryCost: order.cost,
            estimatedUnitCost: order.cost / order.shares,
            verdicts: { control: true, 'spot-twap': aligned, 'price-cap-085': price, combined: aligned && price } };
    }
    return { snapshotId: snapshot.snapshotId, market: snapshot.market, conditionId: metadata[0], marketOpen: open, marketEnd: end,
        sourceAt: snapshot.at, capturedAt: now, epochId: snapshot.evaluationEpochId,
        inputHash: snapshot.inputHash, immutableHash: hash(immutableSnapshot(snapshot)),
        frozenSnapshot: immutableSnapshot(snapshot),
        featureView: { seconds: input.seconds, deltaCents: input.delta_cents, slot: snapshot.slot }, sides,
        decision: null, status: 'awaiting_decision' };
}

function issue(state, code, snapshotId, now) {
    if (!state.issues.some(i => i.code === code && i.snapshotId === snapshotId))
        state.issues.push({ code, snapshotId, at: now });
}
function exclude(state, snapshotId, reason, now) {
    if (!state.excluded.some(row => row.snapshotId === snapshotId)) state.excluded.push({ snapshotId, reason, at: now });
}
const decisionView = snapshot => snapshot.decision ? {
    action: snapshot.decision.action, status: snapshot.decision.status, model: snapshot.decision.model,
    receivedAt: snapshot.decisionReceivedAt ?? snapshot.decision.receivedAt,
    latencyMs: Number.isFinite(snapshot.decision.latencyMs) ? snapshot.decision.latencyMs : null,
} : null;
const completionView = row => ({ slug: row.slug, conditionId: row.conditionId, closedAt: row.closedAt,
    traded: row.traded, uncertain: row.uncertain, pnl: row.pnl, fees: row.fees, gas: row.gas,
    entryCost: row.entryCost, partial: row.partial, payout: row.payout,
    entrySignal: { snapshotId: row.entrySignal?.snapshotId, action: row.entrySignal?.action,
        inputHash: row.entrySignal?.inputHash, epochId: row.entrySignal?.evaluationEpochId, model: row.entrySignal?.model } });
const officialPayout = payout => Array.isArray(payout) && payout.length === 2
    && payout.every(x => x === 0 || x === 1) && payout[0] + payout[1] === 1;
function scoreFromEvidence(capture, evidence) {
    const decision = capture.decision;
    if (!decision || decision.status !== 'ok' || !capture.sides[decision.action]
        || decision.model !== 'typed-decisions' || !Number.isSafeInteger(decision.receivedAt)
        || decision.receivedAt <= capture.capturedAt || decision.receivedAt >= capture.marketEnd
        || !record(evidence) || evidence.slug !== capture.market || evidence.conditionId !== capture.conditionId
        || evidence.traded !== true || evidence.uncertain || !officialPayout(evidence.payout)
        || !Number.isSafeInteger(evidence.closedAt) || evidence.closedAt < capture.marketEnd
        || ![evidence.pnl,evidence.fees,evidence.gas,evidence.entryCost].every(Number.isFinite)
        || evidence.entrySignal?.snapshotId !== capture.snapshotId || evidence.entrySignal.action !== decision.action
        || evidence.entrySignal.inputHash !== capture.inputHash || evidence.entrySignal.epochId !== capture.epochId
        || evidence.entrySignal.model !== decision.model) fail('score_evidence_invalid');
    return { snapshotId: capture.snapshotId, market: capture.market, epochId: capture.epochId,
        action: decision.action, closedAt: evidence.closedAt,
        dayWIB: new Date(evidence.closedAt + 7 * 3600000).toISOString().slice(0,10),
        actualPnl: evidence.pnl, feesIncluded: evidence.fees, gasIncluded: evidence.gas, entryCost: evidence.entryCost,
        partial: !!evidence.partial, payout: [...evidence.payout],
        completionEvidence: structuredClone(evidence), completionHash: hash(evidence),
        decisionEvidenceHash: hash(decision), verdicts: structuredClone(capture.sides[decision.action].verdicts) };
}

/** Mutates observer state only. The production ledger is never written or executed. */
export function observe(state, source, now) {
    if (!Number.isSafeInteger(now) || now < state.registeredAt || now < (state.lastPollAt ?? 0)) fail('clock_invalid');
    const view = sourceView(source), manifest = state.manifest;
    if (view.baseline !== manifest.source.baseline) fail('source_baseline_changed');
    if (JSON.stringify(view) !== JSON.stringify(manifest.source)) {
        state.captureStopped ||= { reason: 'source_provenance_changed', at: now };
        issue(state, 'source_provenance_changed', null, now);
    }
    const snapshots = new Map();
    for (const snapshot of source.ai.snapshots) {
        if (snapshots.has(snapshot.snapshotId)) fail('duplicate_source_snapshot');
        snapshots.set(snapshot.snapshotId, snapshot);
    }
    const historical = new Set(manifest.excludedHistoricalSnapshots);
    for (const snapshot of source.ai.snapshots) {
        const id = snapshot.snapshotId;
        if (historical.has(id) || state.captures.some(c => c.snapshotId === id) || state.excluded.some(c => c.snapshotId === id)) continue;
        if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) fail('snapshot_id_invalid');
        if (state.captureStopped) { exclude(state, id, 'registration_provenance_changed', now); continue; }
        if (source.completed.some(row => row.slug === snapshot.market)
            || source.position?.market?.slug === snapshot.market && source.position.payout != null) {
            exclude(state, id, 'outcome_already_known', now); continue;
        }
        try {
            const capture = parseSnapshot(snapshot, now, manifest);
            if (snapshot.decision != null || snapshot.decisionReceivedAt != null) {
                exclude(state, id, 'first_seen_after_decision', now); continue;
            }
            state.captures.push(capture);
        } catch (error) {
            if (!error.message.startsWith('filter_shadow_')) throw error;
            exclude(state, id, error.message.slice(14), now);
        }
    }
    const completed = new Map();
    for (const row of source.completed) {
        const id = row.entrySignal?.snapshotId;
        if (!id) continue;
        if (completed.has(id)) fail('duplicate_source_completion');
        completed.set(id, row);
    }
    for (const capture of state.captures) {
        const snap = snapshots.get(capture.snapshotId), row = completed.get(capture.snapshotId);
        const priorScore = state.scores.find(r => r.snapshotId === capture.snapshotId);
        if (priorScore && (!row || hash(completionView(row)) !== priorScore.completionHash))
            issue(state, 'scored_result_revised', capture.snapshotId, now);
        if (!snap || hash(immutableSnapshot(snap)) !== capture.immutableHash) {
            capture.status = 'evidence_changed'; issue(state, 'snapshot_evidence_changed', capture.snapshotId, now); continue;
        }
        const decision = decisionView(snap);
        if (!decision) {
            if (capture.decision) { capture.status = 'evidence_changed'; issue(state, 'decision_evidence_missing', capture.snapshotId, now); }
            continue;
        }
        if (capture.decision && hash(capture.decision) !== hash(decision)) {
            capture.status = 'evidence_changed'; issue(state, 'decision_evidence_changed', capture.snapshotId, now); continue;
        }
        capture.decision ||= decision;
        if (!Number.isSafeInteger(decision.receivedAt) || decision.receivedAt <= capture.capturedAt
            || decision.receivedAt > now || decision.model !== manifest.source.model) {
            capture.status = 'decision_not_prospective'; issue(state, 'decision_timing_or_model_invalid', capture.snapshotId, now); continue;
        }
        if (decision.status !== 'ok' || decision.action === 'SKIP') { capture.status = 'no_executable_decision'; continue; }
        if (!capture.sides[decision.action]) { capture.status = 'decision_invalid'; continue; }
        capture.status = 'awaiting_completion';
        if (!row) continue;
        if (row.slug !== capture.market || row.conditionId !== capture.conditionId || row.entrySignal.action !== decision.action
            || row.entrySignal.inputHash !== capture.inputHash || row.entrySignal.evaluationEpochId !== capture.epochId
            || row.entrySignal.model !== decision.model || !Number.isSafeInteger(row.closedAt)
            || row.closedAt < capture.sourceAt || row.closedAt > now) {
            capture.status = 'evidence_changed'; issue(state, 'completion_identity_changed', capture.snapshotId, now); continue;
        }
        if (row.uncertain) {
            capture.status = 'uncertain_completion';
            if (state.scores.some(r => r.snapshotId === capture.snapshotId)) issue(state, 'scored_result_revised', capture.snapshotId, now);
            continue;
        }
        if (!row.traded) { capture.status = 'no_fill'; continue; }
        if (row.closedAt < capture.marketEnd || !officialPayout(row.payout)
            || ![row.pnl, row.fees, row.gas, row.entryCost].every(Number.isFinite)) {
            capture.status = 'awaiting_official_completion'; continue;
        }
        const result = scoreFromEvidence(capture, completionView(row));
        const prior = state.scores.find(r => r.snapshotId === capture.snapshotId);
        if (prior && hash(prior) !== hash(result)) {
            capture.status = 'evidence_changed'; issue(state, 'scored_result_revised', capture.snapshotId, now); continue;
        }
        if (!prior) state.scores.push(result);
        capture.status = 'scored';
    }
    // Detect truncation/removal of already-scored source rows, too.
    for (const score of state.scores) if (!completed.has(score.snapshotId)) issue(state, 'scored_completion_missing', score.snapshotId, now);
    state.sourceHealth = { lastTickAt: Number.isSafeInteger(source.lastTickAt) ? source.lastTickAt : null,
        stoppedReason: typeof source.stopped?.reason === 'string' ? source.stopped.reason : null,
        entryHoldCount: record(source.entryHolds) ? Object.keys(source.entryHolds).length : 0,
        hasPosition: source.position != null };
    state.lastPollAt = now; state.lastSuccessfulReadAt = now;
}

function count(values) {
    const result = {};
    for (const value of values) result[value] = (result[value] || 0) + 1;
    return result;
}
function settledDrawdown(rows, candidate) {
    let equity = 0, peak = 0, max = 0;
    for (const row of [...rows].sort((a,b) => a.closedAt - b.closedAt)) {
        equity += row.verdicts[candidate] ? row.actualPnl : 0;
        peak = Math.max(peak, equity); max = Math.max(max, peak - equity);
    }
    return round(max);
}
function dayBootstrap(rows, candidate, eligible, seed) {
    if (!eligible) return null;
    const grouped = new Map();
    for (const row of rows) {
        const day = grouped.get(row.dayWIB) || { count: 0, control: 0, filtered: 0 };
        day.count++; day.control += row.actualPnl; day.filtered += row.verdicts[candidate] ? row.actualPnl : 0;
        grouped.set(row.dayWIB, day);
    }
    const days = [...grouped.values()], means = [], deltas = [];
    let random = parseInt(hash(seed).slice(0,8),16) || 1;
    const next = () => { random ^= random << 13; random ^= random >>> 17; random ^= random << 5; return (random >>> 0) / 4294967296; };
    for (let i = 0; i < RULES.bootstrapIterations; i++) {
        let n = 0, control = 0, filtered = 0;
        for (let j = 0; j < days.length; j++) {
            const day = days[Math.floor(next() * days.length)]; n += day.count; control += day.control; filtered += day.filtered;
        }
        means.push(filtered / n); deltas.push((filtered - control) / n);
    }
    const interval = values => { values.sort((a,b) => a-b); return [.025,.975].map(p => round(values[Math.floor((values.length - 1) * p)])); };
    return { method: 'paired_day_cluster_bootstrap', iterations: RULES.bootstrapIterations,
        meanPnlPerCohortMarket95: interval(means), improvementPerCohortMarket95: interval(deltas) };
}

export function report(state, now) {
    const tainted = new Set(state.issues.filter(i => i.snapshotId).map(i => i.snapshotId));
    const rows = state.scores.filter(r => !tainted.has(r.snapshotId));
    const days = new Set(rows.map(r => r.dayWIB)).size;
    const minimumEvidence = now - state.registeredAt >= RULES.minimumDays * 86400000
        && days >= RULES.minimumDays && rows.length >= RULES.minimumFilled;
    const total = round(rows.reduce((sum,r) => sum + r.actualPnl, 0));
    const candidates = Object.fromEntries(RULES.candidates.map(id => {
        const retained = rows.filter(r => r.verdicts[id]), vetoed = rows.filter(r => !r.verdicts[id]);
        const pnl = round(retained.reduce((sum,r) => sum + r.actualPnl,0));
        return [id, { cohortFilledMarkets: rows.length, retained: retained.length, vetoed: vetoed.length,
            retainedWins: retained.filter(r => r.actualPnl > 0).length, retainedLosses: retained.filter(r => r.actualPnl < 0).length,
            avoidedLosses: vetoed.filter(r => r.actualPnl < 0).length, missedWins: vetoed.filter(r => r.actualPnl > 0).length,
            conditionalPnl: pnl, differenceFromControl: round(pnl - total),
            settledPnlDrawdown: settledDrawdown(rows, id), aiComputeCost: null,
            uncertainty: dayBootstrap(rows, id, minimumEvidence, state.id + id) }];
    }));
    const decisions = state.captures.filter(c => c.decision);
    return { schema: 1, experimentId: state.id, generatedAt: now, registeredAt: state.registeredAt,
        firstMarketOpenAt: state.manifest.firstMarketOpenAt, lastPollAt: state.lastPollAt,
        lastSuccessfulReadAt: state.lastSuccessfulReadAt, captureStopped: state.captureStopped,
        source: state.manifest.source, rules: state.manifest.rules,
        status: state.captureStopped ? 'capture_paused_provenance_changed'
            : state.lastReadError ? 'source_read_failed'
            : state.sourceHealth?.stoppedReason ? 'waiting_source_stopped'
            : Number.isSafeInteger(state.sourceHealth?.lastTickAt) && now - state.sourceHealth.lastTickAt > 30000
                ? 'waiting_source_heartbeat' : 'collecting',
        sourceHealth: state.sourceHealth || null,
        sufficientForLive: false, automaticPromotion: false,
        interpretation: 'conditional_veto_overlay_on_actual_laya_entries_not_independent_paper_returns',
        counts: { captured: state.captures.length, excluded: state.excluded.length,
            exclusions: count(state.excluded.map(r => r.reason)), phases: count(state.captures.map(r => r.status)),
            decisionStatuses: count(decisions.map(c => c.decision.status)), scored: rows.length,
            taintedScores: state.scores.length - rows.length, daysWIB: days, sourceReadErrors: state.sourceReadErrors || 0 },
        issues: state.issues, lastReadError: state.lastReadError || null, minimumEvidence,
        uncertaintyUnavailableReason: minimumEvidence ? null : 'needs_7_days_and_100_filled_cohort_markets',
        candidates, limitations: [
            'Veto uses frozen pre-decision features; completed fills and official payout come from the production ledger without additional chain verification.',
            'No alternative slots, re-entry, capital, risk-stop paths or execution are simulated after a veto.',
            'Conditional PnL includes recorded trading fees/gas once; AI/compute and counterfactual withdrawal costs are unknown.',
            'Settled PnL drawdown excludes open inventory marks and is not live wallet drawdown.',
            'Price cap is a preregistered exploratory proxy; confidence is not calibrated win probability.',
            'Only newly observed valid production snapshots are covered; coverage is conditional on existing live gates.',
            'This observer never qualifies or promotes a strategy to live.' ] };
}
