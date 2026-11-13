import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';
import { summarizeFilterPaper } from '../laya-filter-paper/report.js';
import { summarizeLayaConfidence } from './confidence.js';

const ARMS = ['laya', 'gemini', 'eligible', 'skip'];
const PROVIDERS = ['laya', 'gemini'];
const WIB = 7 * 3600000;
const REQUEST_STATUSES = new Set(['ok', 'decision_timeout', 'timeout', 'provider_error']);
const ACTIONS = new Set(['BUY_UP', 'BUY_DOWN', 'SKIP']);
const finite = Number.isFinite;
const sum = values => round(values.reduce((total, value) => total + (finite(value) ? value : 0), 0));
const unique = values => [...new Set(values.filter(value => value !== undefined && value !== null))];
const countBy = (rows, key) => rows.reduce((counts, row) => {
    const value = row[key];
    if (typeof value === 'string' && value) Object.defineProperty(counts, value, {
        value: (Object.hasOwn(counts, value) ? counts[value] : 0) + 1, enumerable: true, configurable: true });
    return counts;
}, {});
const percentiles = values => {
    const sorted = values.filter(value => finite(value) && value >= 0).sort((a, b) => a - b);
    const at = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
    return { p50: at(.5), p95: at(.95), samples: sorted.length };
};
const snapshotRows = state => [...new Map((state.snapshots || []).map((snapshot, index) =>
    [snapshot.snapshotId || index, snapshot])).values()];
const providerDecision = (snapshot, name) => snapshot.providerDecisions?.[name]
    ?? (name === 'laya' && !snapshot.providerDecisions ? snapshot.sharedDecision : null);

function providerRows(snapshots, name) {
    return snapshots.flatMap(snapshot => {
        const decision = providerDecision(snapshot, name), attempted = snapshot.inferenceAttempts?.[name] === true
            || decision?.inferenceAttempted === true;
        return decision || attempted ? [{ snapshot, decision: { ...(decision || { status: 'pending', cost: null }),
            inferenceAttempted: attempted } }] : [];
    });
}

function completedLatency(decision) {
    if (decision.lateResponse) {
        const latency = completedLatency({ ...decision.lateResponse, inferenceAttempted: true });
        if (latency !== null) return latency;
    }
    const decodedAfterDeadline = ['decision_timeout', 'timeout'].includes(decision.status)
        && finite(decision.receivedAt) && finite(decision.requestedAt)
        && decision.receivedAt >= decision.requestedAt && decision.requestSubmitted !== false;
    const completed = decision.status === 'ok' || decodedAfterDeadline || decision.inferenceAttempted
        && (['invalid', 'rejected'].includes(decision.status)
            || decision.status === 'provider_error' && finite(decision.httpStatus));
    const value = decision.actualLatencyMs ?? (completed ? decision.latencyMs
        ?? decision.receivedAt - decision.requestedAt : null);
    return finite(value) && value >= 0 ? value : null;
}

function timely(snapshot, decision, config, now) {
    if (decision.status !== 'ok' || decision.timely === false || decision.executable === false
        || ['late_response', 'stale_input'].includes(decision.entryDisposition)) return false;
    const deadline = snapshot.decisionDeadlineAt ?? snapshot.timing?.decisionDeadlineAt ?? decision.decisionDeadlineAt;
    if (finite(deadline) || config.decisionTimeoutPolicy === 'snapshot-freshness-budget-v1')
        return finite(deadline) && finite(decision.requestedAt) && finite(decision.receivedAt)
            && decision.requestedAt >= snapshot.at && decision.receivedAt >= decision.requestedAt
            && decision.receivedAt <= Math.min(deadline, now);
    const requestedAt = decision.requestedAt ?? snapshot.at, latency = completedLatency(decision);
    return !(finite(latency) && finite(config.decisionMs) && latency > config.decisionMs
        || finite(decision.receivedAt) && (decision.receivedAt > now || decision.receivedAt < requestedAt)
        || finite(decision.receivedAt) && finite(requestedAt) && finite(config.decisionMs)
            && decision.receivedAt - requestedAt > config.decisionMs);
}

function providerSummary(rows, name, state, config) {
    const decisions = rows.map(row => row.decision);
    const responses = decisions.flatMap(decision => [decision, ...(decision.lateResponse ? [decision.lateResponse] : [])]);
    const requests = decisions.filter(decision => decision.inferenceAttempted || REQUEST_STATUSES.has(decision.status));
    const latencies = requests.map(completedLatency), timeouts = requests.filter(decision =>
        ['decision_timeout', 'timeout'].includes(decision.status));
    const requestCost = decision => Object.hasOwn(decision.lateResponse || {}, 'cost') ? decision.lateResponse.cost : decision.cost;
    const unknownApiCostRequests = requests.filter(decision => !finite(requestCost(decision))).length;
    const metadata = state.providers?.[name] || {};
    return { requests: requests.length, requestsBasis: 'admitted_inference_attempts_once_per_provider_snapshot',
        status: countBy(decisions, 'status'), reasons: countBy(decisions, 'reason'),
        knownNotSubmittedRequests: requests.filter(decision => decision.requestSubmitted === false).length,
        knownApiCost: sum(requests.map(requestCost)), unknownApiCostRequests,
        apiCostComplete: unknownApiCostRequests === 0, localComputeCost: null, totalAiCost: null,
        costCountedOnce: true, costAllocation: 'provider_level_only',
        latencyMs: { ...percentiles(latencies), completedResponses: latencies.filter(finite).length,
            timeoutCount: timeouts.length, timeoutsWithoutResponse: timeouts.filter(decision => completedLatency(decision) === null).length },
        waitingMs: percentiles(requests.map(decision => decision.latencyMs)),
        transportTimingMs: Object.fromEntries(['localPreparation', 'responseHeaders', 'firstByte', 'firstReasoning',
            'firstContent', 'finish', 'bodyComplete', 'contentToComplete'].map(phase => [phase,
            percentiles(requests.map(decision => (decision.lateResponse || decision).transportTimingMs?.[phase]))])),
        routerQueueMs: null,
        transportTimingLimitation: 'client_observed_phases_cannot_separate_router_queue_network_and_model_compute',
        decisionBudgetMs: percentiles(rows.map(({ snapshot, decision }) => decision.decisionBudgetMs
            ?? snapshot.timing?.decisionBudgetMs)),
        identity: { configuredModel: config[`${name}Model`] || null,
            configuredResolvedModel: config[`${name}ResolvedModel`] || null,
            requestedModels: unique(responses.map(decision => decision.requestedModel)),
            resolvedModels: unique(responses.map(decision => decision.resolvedModel)),
            observedModels: unique(responses.map(decision => decision.model)),
            promptHashes: unique(responses.map(decision => decision.promptHash)),
            configuredPromptHash: name === 'laya' ? config.decisionProtocol?.promptHash || null
                : config.geminiPromptHash || null,
            configuredInformedPromptHash: name === 'gemini' ? config.informedPromptHash || null : null,
            inputPolicy: name === 'laya' ? 'original_candidate_v2_snapshot' : 'same_base_snapshot_plus_deterministic_context',
            informedPromptHashes: unique(responses.map(decision => decision.informedPromptHash)),
            contextVersions: unique(responses.map(decision => decision.contextVersion)),
            decisionProtocol: name === 'laya' ? config.decisionProtocol || null : null },
        availability: { disabled: metadata.disabled || null, pending: !!metadata.pending,
            recoveryAt: finite(metadata.recoveryAt) ? metadata.recoveryAt : null,
            recoveryReason: metadata.recoveryReason || null, unavailable: metadata.unavailable || null } };
}

function officialPayout(snapshot, state, now) {
    const market = state.markets?.[snapshot.market], payout = market?.payout ?? market?.officialPayout;
    return market && finite(market.end) && market.end <= now && Array.isArray(payout) && payout.length === 2
        && payout.every(value => finite(value) && value >= 0 && value <= 1)
        && Math.abs(sum(payout) - 1) <= .00001 ? payout : null;
}

function selectedSignals(rows, state, config, now, accept = timely) {
    const selected = new Map();
    for (const { snapshot, decision } of [...rows].sort((a, b) => a.snapshot.at - b.snapshot.at)) {
        const payout = officialPayout(snapshot, state, now);
        if (!payout || selected.has(snapshot.market) || decision.diagnosticOnly || !['BUY_UP', 'BUY_DOWN'].includes(decision.action)
            || !accept(snapshot, decision, config, now)) continue;
        selected.set(snapshot.market, { snapshotId: snapshot.snapshotId, action: decision.action,
            payout: payout[decision.action === 'BUY_UP' ? 0 : 1] });
    }
    return selected;
}

function quality(signals, selection = 'first_timely_buy_per_officially_labeled_market') {
    const values = [...signals.values()].map(row => row.payout), wins = values.filter(value => value === 1).length;
    return { selection, independentMarkets: values.length,
        wins, losses: values.filter(value => value === 0).length,
        neutral: values.filter(value => value > 0 && value < 1).length,
        winRate: values.length ? round(wins / values.length) : null,
        excludesSkipAndTimeout: true, measures: 'direction_only_not_profit_or_calibrated_probability' };
}

function validResponse(snapshot, decision, now, late) {
    if (decision.status !== 'ok' || !ACTIONS.has(decision.action) || decision.reason === 'disallowed_action'
        || decision.requestSubmitted === false || decision.tokenUsageMatches === false
        || decision.snapshotId !== undefined && decision.snapshotId !== snapshot.snapshotId
        || decision.originalInputHash != null && snapshot.inputHash != null && decision.originalInputHash !== snapshot.inputHash
        || decision.inputHash != null && snapshot.inputHash != null
            && ![snapshot.inputHash, snapshot.informed?.inputHash].includes(decision.inputHash)) return false;
    if (late && (!finite(decision.requestedAt) || !finite(decision.receivedAt))
        || finite(decision.requestedAt) && decision.requestedAt < snapshot.at
        || finite(decision.receivedAt) && (decision.receivedAt > now
            || decision.receivedAt < (decision.requestedAt ?? snapshot.at))) return false;
    let allowed = snapshot.state?.allowed;
    if (!Array.isArray(allowed) && typeof snapshot.input === 'string') {
        try { allowed = JSON.parse(snapshot.input)?.allowed; } catch { return false; }
    }
    if (!Array.isArray(allowed) && Array.isArray(snapshot.allowed)) allowed = snapshot.allowed.map(order =>
        typeof order === 'string' ? order : order.index === 0 ? 'BUY_UP' : order.index === 1 ? 'BUY_DOWN' : null);
    return decision.action === 'SKIP' || !Array.isArray(allowed) || allowed.includes(decision.action);
}

function responseQuality(rows, state, config, now) {
    const valid = rows.flatMap(({ snapshot, decision }) => {
        const response = decision.lateResponse || decision;
        // A valid SKIP is intentionally non-executable even when it arrives on time.
        const late = !!decision.lateResponse || !timely(snapshot, { ...response, executable: true }, config, now);
        return validResponse(snapshot, response, now, late) ? [{ snapshot, decision: response, late }] : [];
    });
    return { ...Object.fromEntries(['timely', 'late', 'allValid'].map(name => {
        const selected = valid.filter(row => name === 'allValid' || row.late === (name === 'late'));
        const buy = selected.filter(row => row.decision.action !== 'SKIP');
        const signals = selectedSignals(selected, state, config, now, () => true);
        const { excludesSkipAndTimeout, ...direction } = quality(signals,
            `first_${name === 'allValid' ? 'valid' : name}_buy_per_officially_labeled_market`);
        return [name, { ...direction, responses: selected.length, buyResponses: buy.length,
            skipResponses: selected.length - buy.length,
            officiallyLabeledBuyResponses: buy.filter(row => officialPayout(row.snapshot, state, now)).length,
            latencyMs: percentiles(selected.map(row => completedLatency(row.decision))),
            excludesSkipFromDirection: true, includesLateResponses: name !== 'timely' }];
    })), limitation: 'conditions_on_valid_buy_responses_and_official_labels_first_snapshot_per_market_cohorts_can_differ',
    lateResponseLimitation: 'response_can_arrive_after_market_end_direction_only_no_hypothetical_fill_or_profit',
    changesTradingResults: false };
}

function eligibleComparisons(state, report, config) {
    const armNames = Object.keys(report.arms);
    const pnlByArm = Object.fromEntries(armNames.map(name => [name,
        new Map((state.arms?.[name]?.completed || []).map(row =>
            [row.slug || (typeof row.market === 'string' ? row.market : row.market?.slug), row.pnl]))]));
    return Object.fromEntries(armNames.filter(name => name !== 'eligible').map(name => {
        // The inherited cohort has already rejected missing, conflicting and unresolved outcomes.
        const rows = report.commonCohort.marketIds.map(slug => ({ closedAt: state.markets[slug].end + WIB,
            pnl: round((pnlByArm[name].get(slug) || 0) - (pnlByArm.eligible.get(slug) || 0)) }));
        const uncertainty = { ...report.arms[name].uncertainty,
            ci95: report.arms[name].uncertainty.sufficient
                ? dailyBootstrap(rows, Math.max(100, Math.floor(config.bootstrapSamples || 2000))) : null };
        const total = sum(rows.map(row => row.pnl));
        return [name, { baseline: 'eligible', matchedMarkets: rows.length, tradingDifference: total,
            meanDifference: rows.length ? round(total / rows.length) : null,
            includesSkipAndTimeout: true, uncertainty, tradingMeanDifferenceCi95: uncertainty.ci95 }];
    }));
}

export function summarizeDecisionPaper(state, config, now = Date.now()) {
    const snapshots = snapshotRows(state), normalizedState = { ...state, snapshots };
    const armNames = config.armNames || ARMS;
    const report = summarizeFilterPaper(normalizedState, { ...config, armNames }, now);
    const rows = Object.fromEntries(PROVIDERS.map(name => [name, providerRows(snapshots, name)]));
    const providerInference = Object.fromEntries(PROVIDERS.map(name => [name, providerSummary(rows[name], name, state, config)]));
    const costScope = (selected, name) => {
        const summary = providerSummary(selected, name, state, config);
        return Object.fromEntries(['requests', 'knownApiCost', 'unknownApiCostRequests', 'apiCostComplete']
            .map(key => [key, summary[key]]));
    };
    for (const name of PROVIDERS) providerInference[name].postStopCosts =
        costScope(rows[name].filter(row => row.decision.diagnosticOnly), name);
    const signals = Object.fromEntries(PROVIDERS.map(name => [name, selectedSignals(rows[name], state, config, now)]));
    const aiDecisionQuality = Object.fromEntries(PROVIDERS.map(name => [name, quality(signals[name])]));
    const responseDecisionQuality = Object.fromEntries(PROVIDERS.map(name => [name,
        responseQuality(rows[name].filter(row => !row.decision.diagnosticOnly), state, config, now)]));
    const postStopDecisionQuality = Object.fromEntries(PROVIDERS.map(name => [name,
        responseQuality(rows[name].filter(row => row.decision.diagnosticOnly)
            .map(row => ({ ...row, decision: { ...row.decision, diagnosticOnly: false } })), state, config, now)]));
    const pairedMarkets = [...signals.laya.keys()].filter(slug => signals.gemini.has(slug));
    const pairedQuality = { selection: 'markets_with_a_timely_buy_from_both_providers', markets: pairedMarkets.length,
        sameSnapshotMarkets: pairedMarkets.filter(slug => signals.laya.get(slug).snapshotId === signals.gemini.get(slug).snapshotId).length,
        byProvider: Object.fromEntries(PROVIDERS.map(name => [name,
            quality(new Map(pairedMarkets.map(slug => [slug, signals[name].get(slug)])))])),
        excludesSkipAndTimeout: true, limitation: 'selection_and_snapshot_timing_can_differ_not_a_profit_comparison' };
    const comparisons = { laya: report.differences, eligible: eligibleComparisons(state, report, config) };
    for (const name of armNames) {
        const source = name === 'laya-filtered' ? 'laya' : name;
        const inference = providerInference[source] ? costScope(rows[source].filter(({ snapshot, decision }) =>
            !decision.diagnosticOnly && snapshot.eligibleArms?.[name] !== false), source) : null;
        report.arms[name].aiCostAllocation = name === 'laya-filtered' ? 'shared_laya_counterfactual_not_additive'
            : inference ? 'own_provider_only' : 'no_inference';
        report.arms[name].knownApiCost = inference?.knownApiCost ?? 0;
        report.arms[name].unknownApiCostRequests = inference?.unknownApiCostRequests ?? 0;
        report.arms[name].aiCostScope = 'inference_while_arm_available_excludes_post_stop_observation';
        report.arms[name].netAfterKnownApiCost = round(report.arms[name].tradingPnl - (inference?.knownApiCost || 0));
        report.arms[name].netAfterAllAiCost = inference ? null : report.arms[name].tradingPnl;
        report.arms[name].riskEvidence = {
            research: state.arms[name]?.stopped?.evidence || null,
            pilot: state.arms[name]?.shadowStop?.evidence || null,
            maximum: state.arms[name]?.maxDrawdownEvidence || null };
    }
    delete report.sharedInference;
    delete report.admission;
    return { ...report, experiment: config.experiment || 'decision-paper-v1',
        experimentType: 'independent_decision_configuration_comparison', armNames: [...armNames],
        comparisons, providerInference, aiDecisionQuality, pairedDecisionQuality: pairedQuality,
        entryFilterDiagnostics: armNames.includes('laya-filtered') ? {
            policy: config.entryFilter, validatedProfitability: false,
            interpretation: 'prospective_candidate_uncalibrated_volatility_buffer_not_win_probability',
            inferenceSource: 'laya', duplicateInferenceRequests: 0, oneRequestPerSnapshot: true,
            candidateOnlyRequests: rows.laya.filter(({ snapshot, decision }) => decision.inferenceAttempted
                && snapshot.eligibleArms?.['laya-filtered'] && !snapshot.eligibleArms?.laya).length,
            vetoedSnapshots: snapshots.filter(s => s.decisions?.['laya-filtered']?.entryDisposition === 'filter_veto').length,
            reasons: countBy(snapshots.map(s => s.decisions?.['laya-filtered']).filter(Boolean), 'filterReason'),
            sameAdmissionAndExecutionCohortWhenBothReserve: true } : null,
        responseDecisionQuality, postStopDecisionQuality,
        layaConfidenceDiagnostics: summarizeLayaConfidence({ ...state,
            snapshots: snapshots.filter(s => !providerDecision(s, 'laya')?.diagnosticOnly) }, now),
        configurationComparison: { interpretation: 'model_prompt_input_and_latency_configurations',
            pureModelAdvantageIsolated: false, baseSnapshotShared: true, enrichedInputProvider: 'gemini',
            laya: 'original_candidate_v2_prompt_and_input',
            ...(armNames.includes('laya-filtered') ? { 'laya-filtered': 'same_laya_response_plus_fixed_direction_volatility_gate' } : {}),
            gemini: 'same_base_snapshot_plus_frozen_break_even_cost_and_closing_twap_context',
            eligible: 'deterministic_eligible_side_without_inference', skip: 'always_skip',
            executionPolicy: config.executionPolicy || 'independent-response-admission-v1',
            executionWaitsForSlowerProvider: false, eligibleLatencyMs: config.latencyMs ?? 250,
            tradingPnlIncludesActualResponseLatency: true, virtualArmProfitsAreAdditive: false },
        executionQuality: { ...report.executionQuality,
            interpretation: 'independent_response_admission_shared_guards_execution_books_may_differ',
            sameExecutionBookRequiredAcrossProviders: false },
        limitations: unique([...report.limitations.filter(reason => reason !== 'same_batch_execution_markers_unavailable'),
            'different_prompt_and_input_configurations_do_not_isolate_model_advantage',
            'response_latency_affects_execution_opportunity', 'direction_quality_conditions_on_timely_buy',
            'late_response_can_arrive_after_market_end_and_is_not_executable',
            'virtual_arm_profits_must_not_be_summed']) };
}

function markdown(report) {
    const money = value => finite(value) ? `$${value.toFixed(6)}` : 'belum diketahui';
    const rate = value => finite(value) ? `${(value * 100).toFixed(1)}%` : '-';
    const confidence = report.layaConfidenceDiagnostics.cohorts.allValid;
    return [`# Decision paper - ${report.id}`, '',
        `Diperbarui: ${report.generatedAt}. ${report.armNames.length} ledger virtual terpisah, $${report.arms.laya.capital} per arm.`,
        'Perbandingan konfigurasi model, prompt, input, dan latency; hasil tidak mengisolasi keunggulan model murni.',
        'Laya memakai candidate-v2 asli. Gemini memakai snapshot dasar yang sama ditambah perhitungan biaya break-even dan konteks TWAP penutupan.',
        'Arm eligible memakai aturan deterministik; arm skip selalu tanpa entry. Profit arm virtual tidak dijumlahkan.', '',
        ...(report.entryFilterDiagnostics ? [
            'laya-filtered memakai respons Laya yang sama, dengan filter arah dan buffer volatilitas tetap. Tidak ada inference duplikat per snapshot; kedua arm yang lolos memakai timestamp admission dan book eksekusi cohort yang sama. Kandidat yang masih tersedia dapat menambah jumlah snapshot yang dinilai.',
            `Veto filter: ${report.entryFilterDiagnostics.vetoedSnapshots} snapshot; alasan ${JSON.stringify(report.entryFilterDiagnostics.reasons)}. Buffer bukan probabilitas menang; kandidat belum terbukti menguntungkan.`, '' ] : []),
        '| Arm | Filled | Win rate eksekusi | PnL setelah fee/gas | Delta vs Laya | Delta vs eligible | DD intratrade |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...Object.entries(report.arms).map(([name, arm]) => `| ${name} | ${arm.completedFilled} | ${rate(arm.executionWinRate)} | ${money(arm.tradingPnl)} | ${name === 'laya' ? '-' : money(report.comparisons.laya[name].tradingDifference)} | ${name === 'eligible' ? '-' : money(report.comparisons.eligible[name].tradingDifference)} | ${money(arm.intratradePaperDrawdown)} |`), '',
        `Delta memakai cohort bersama ${report.commonCohort.markets} market berlabel resmi, termasuk SKIP dan timeout final. Label tertunda: ${report.officialLabelsPending}; hasil belum selesai: ${report.commonCohort.unresolvedMarkets}. Hasil tak diketahui tidak dianggap nol.`,
        'Eksekusi dimulai ketika masing-masing respons siap; respons cepat tidak menunggu provider lambat. Latency nyata memengaruhi kesempatan dan harga fill.', '',
        '| Provider | Requests | Respons p50/p95 (ms) | Timeout | Biaya API diketahui | Biaya request belum diketahui | BUY tepat / berlabel |',
        '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...PROVIDERS.map(name => {
            const provider = report.providerInference[name], signal = report.aiDecisionQuality[name];
            return `| ${name} | ${provider.requests} | ${provider.latencyMs.p50 ?? '-'} / ${provider.latencyMs.p95 ?? '-'} | ${provider.latencyMs.timeoutCount} | ${money(provider.knownApiCost)} | ${provider.unknownApiCostRequests} | ${signal.wins} / ${signal.independentMarkets} |`;
        }), '',
        ...PROVIDERS.map(name => {
            const { identity, availability } = report.providerInference[name];
            return `- ${name}: model konfigurasi ${identity.configuredModel || 'belum tercatat'}; model diminta ${identity.requestedModels.join(', ') || 'belum tercatat'}; route ${identity.configuredResolvedModel || identity.resolvedModels.join(', ') || '-'}; model respons ${identity.observedModels.join(', ') || 'belum tercatat'}; prompt ${identity.promptHashes.join(', ') || identity.configuredPromptHash || 'belum tercatat'}. Pending: ${availability.pending}; recoveryAt: ${availability.recoveryAt ?? '-'}; recoveryReason: ${availability.recoveryReason || '-'}; disabled: ${availability.disabled || '-'}.`;
        }), '',
        'Biaya dihitung sekali per provider dan snapshot. Biaya komputasi lokal serta total biaya AI belum diketahui. Waktu menunggu timeout terpisah dari latency respons selesai.',
        'Kualitas arah menggunakan BUY pertama yang tepat waktu per market berlabel resmi, terpisah dari PnL eksekusi. Metrik ini mengecualikan SKIP/timeout dan bukan estimasi probabilitas terkalibrasi.',
        '', '| Provider | Valid tepat waktu / terlambat | BUY tepat / berlabel tepat waktu | BUY tepat / berlabel terlambat | BUY tepat / berlabel semua valid |',
        '| --- | ---: | ---: | ---: | ---: |',
        ...PROVIDERS.map(name => {
            const quality = report.responseDecisionQuality[name];
            const result = name => `${quality[name].wins} / ${quality[name].independentMarkets}`;
            return `| ${name} | ${quality.timely.responses} / ${quality.late.responses} | ${result('timely')} | ${result('late')} | ${result('allValid')} |`;
        }), '',
        'Diagnostik respons memakai BUY valid pertama per market pada masing-masing kelompok dan payout resmi. SKIP dihitung sebagai respons valid tetapi tidak diberi nilai arah. Kelompok dapat berbeda; jumlah market antarkelompok tidak dijumlahkan.',
        'Setelah seluruh arm eksekusi provider berhenti karena risiko, inference dapat berlanjut hanya untuk observasi. Hasil itu dipisah dalam postStopDecisionQuality; tidak ada entry atau reset drawdown.',
        'Respons terlambat tetap tanpa fill dan tanpa profit hipotetis; jawaban dapat tiba sesudah market berakhir. Diagnostik ini tidak menggantikan perbandingan eksekusi atau membuktikan keunggulan model.',
        'Confidence Laya adalah skor pilihan action, bukan probabilitas menang. Tidak ada cutoff confidence aktif. Diagnostik berikut memakai respons valid pertama yang diterima per market, termasuk respons terlambat; rincian kelompok waktu tersedia di layaConfidenceDiagnostics pada laporan JSON.',
        '', '| Sisi Laya | BUY per market | Skor pilihan min / maks | Arah menang / berlabel |',
        '| --- | ---: | ---: | ---: |',
        ...Object.entries(confidence.bySide).map(([side, row]) =>
            `| ${side} | ${row.buyResponses} | ${rate(row.metrics.selectedActionProbability.minimum)} / ${rate(row.metrics.selectedActionProbability.maximum)} | ${row.wins} / ${row.officiallyLabeledBuyResponses} |`), '',
        `Bin skor pilihan Laya (respons per market): ${confidence.bins.filter(row => row.independentMarkets)
            .map(row => `[${rate(row.lower)}, ${rate(row.upper)}${row.upperInclusive ? ']' : ')'}: ${row.independentMarkets}`)
            .join('; ') || 'belum ada respons valid'}. Batas bin hanya untuk observasi; perbedaan skor antar sisi tidak membuktikan cutoff tertentu memperbaiki hasil.`,
        `Bootstrap harian Asia/Jakarta memerlukan ${report.minimumEvidence.days} hari dan ${report.minimumEvidence.completedFilledPerArm} market pada cohort; CI kosong bila bukti belum cukup.`,
        ...Object.entries(report.comparisons).flatMap(([baseline, comparisons]) => Object.entries(comparisons).map(([name, comparison]) =>
            `- ${name} vs ${baseline}: ${comparison.uncertainty.sufficient ? `CI 95% mean delta ${JSON.stringify(comparison.tradingMeanDifferenceCi95)}` : comparison.uncertainty.reasons.join(', ')}.`)), '',
        'Khusus riset paper; tidak ada promosi live otomatis.', ''].join('\n');
}

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
const identityError = () => new Error('decision_paper_report_identity_mismatch');
const read = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

export function writeDecisionPaperReport(config) {
    if (!validId(config.id) || typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const state = read(path.join(config.dataDir, config.id, 'ledger.json'));
    if (state.id !== config.id || !state.arms || typeof state.arms !== 'object' || Array.isArray(state.arms)) throw identityError();
    const report = summarizeDecisionPaper(state, config), dir = path.join(config.dataDir, config.id, 'reports');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    atomicJson(path.join(dir, 'latest.json'), report);
    const filename = path.join(dir, 'latest.md');
    fs.writeFileSync(filename, markdown(report), { mode: 0o600 });
    fs.chmodSync(filename, 0o600);
    return report;
}

export function readDecisionPaperReports(config, history = false) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw identityError();
    const dataDir = path.resolve(config.dataDir), activeFile = path.join(dataDir, 'active.json');
    const active = fs.existsSync(activeFile) ? read(activeFile) : null;
    if (fs.existsSync(activeFile) && (!active || !validId(active.id) || active.paperOnly !== true)) throw identityError();
    const readPeriod = (directory, id, archivedAt = null) => {
        if (typeof directory !== 'string' || !path.isAbsolute(directory) || !validId(id)) throw identityError();
        const periodDir = path.join(directory, id), manifest = read(path.join(periodDir, 'manifest.json'));
        if (manifest.id !== id || manifest.paperOnly !== true || !manifest.policy
            || typeof manifest.policy !== 'object' || Array.isArray(manifest.policy)) throw identityError();
        const policy = { ...manifest.policy, id, dataDir: directory }, ledgerFile = path.join(periodDir, 'ledger.json');
        let report;
        if (fs.existsSync(ledgerFile)) {
            const state = read(ledgerFile);
            if (state.id !== id || !state.arms || typeof state.arms !== 'object' || Array.isArray(state.arms)) throw identityError();
            const isDecisionPeriod = policy.experiment?.startsWith('decision-paper-')
                || ARMS.every(name => policy.armNames?.includes(name));
            report = isDecisionPeriod ? summarizeDecisionPaper(state, policy) : summarizeFilterPaper(state, policy);
        } else {
            report = read(path.join(periodDir, 'reports', 'latest.json'));
            if (report.id !== id || report.paperOnly !== true) throw identityError();
        }
        return { ...report, experiment: manifest.policy.experiment || report.experiment || null,
            periodPolicy: { schema: policy.schema ?? null, experiment: policy.experiment || null,
                decisionTimeoutPolicy: policy.decisionTimeoutPolicy || null,
                executionPolicy: policy.executionPolicy || null, armNames: Object.keys(report.arms || {}) },
            ...(archivedAt === null ? {} : { archivedAt }) };
    };
    const result = active ? readPeriod(dataDir, active.id)
        : { id: null, decision: 'belum_dimulai', paperOnly: true, automaticPromotion: false, sufficientForLive: false };
    if (history) {
        const historyFile = path.join(dataDir, 'history.json'), index = fs.existsSync(historyFile) ? read(historyFile) : { periods: [] };
        if (!index || !Array.isArray(index.periods)) throw identityError();
        const seen = new Set(active ? [`${dataDir}:${active.id}`] : []);
        result.history = index.periods.flatMap(period => {
            if (!period || !validId(period.id) || typeof period.dataDir !== 'string' || !path.isAbsolute(period.dataDir)
                || !['number', 'string'].includes(typeof period.archivedAt)
                || !finite(new Date(period.archivedAt).getTime())) throw identityError();
            const directory = path.resolve(period.dataDir), key = `${directory}:${period.id}`;
            if (seen.has(key)) return [];
            seen.add(key);
            return [readPeriod(directory, period.id, period.archivedAt)];
        }).sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
    }
    return result;
}
