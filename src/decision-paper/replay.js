import fs from 'node:fs';
import path from 'node:path';
import { buildProtocolRequest, parseProtocolResponse, verifyProtocolContext } from '../laya-tuning/protocol.js';
import { digest, ensureDirectory, save } from '../laya-tuning/replay.js';
import { INFORMED_QUESTIONS, INFORMED_PROMPT_SHA256 } from './features.js';

export const REPLAY_SERVICES = Object.freeze(['polymarket-laya-filter-paper.service', 'polymarket-decision-paper.service',
    'polymarket-laya-live.service', 'polymarket-laya-paper.service', 'polymarket-ai-shadow.service',
    'polymarket-paper.service']);
export const REPLAY_VARIANTS = Object.freeze(['candidate-v2', 'informed-v1']);
export const REPLAY_LIMITATIONS = Object.freeze(['historical_prompt_only_replay_on_identical_original_input',
    'enriched_cost_and_closing_twap_fields_not_reconstructed', 'small_chronological_sample_not_live_qualification',
    'quiet_server_latency_not_live_p95', 'labels_evaluated_after_inference_only',
    'choice_probabilities_not_market_win_probabilities', 'compute_cost_unknown',
    'no_fills_no_hypothetical_pnl_no_winner_claim_no_automatic_deployment']);
const safeReason = error => /^(?:prompt_replay_|protocol_|snapshot_|allowed_|option_)[a-z_]+$/.test(error?.message)
    ? error.message : 'prompt_replay_failed';
const clone = value => JSON.parse(JSON.stringify(value));
const frozen = value => {
    if (value && typeof value === 'object') { for (const row of Object.values(value)) frozen(row); Object.freeze(value); }
    return value;
};

export function buildPromptReplayProtocol(snapshot, variantId = 'candidate-v2') {
    const baseline = buildProtocolRequest(snapshot, { variantId: 'candidate-v2' });
    if (variantId === 'candidate-v2') return baseline;
    if (variantId !== 'informed-v1') throw new Error('prompt_replay_variant_invalid');
    const questions = clone(INFORMED_QUESTIONS), request = { ...baseline.request, questions };
    const protocolVersion = 'decision-prompt-replay-v1', promptVersion = 'informed-original-input-v1';
    return frozen({ ...baseline, protocolVersion, variantId, promptVersion,
        promptHash: digest(JSON.stringify({ protocolVersion, variantId, promptVersion, questions })),
        informedPromptHash: INFORMED_PROMPT_SHA256, questionsHash: digest(JSON.stringify(questions)),
        requestHash: digest(JSON.stringify(request)), request });
}

/** Selection depends only on timestamps and identity, never labels, action results, or resolution availability. */
export function selectReplaySnapshots(snapshots, pairs = 4) {
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 12) throw new Error('prompt_replay_pair_count_invalid');
    if (!Array.isArray(snapshots)) throw new Error('prompt_replay_snapshots_invalid');
    const selected = [], seen = new Set();
    for (const snapshot of snapshots) {
        if (!snapshot || !Number.isFinite(snapshot.at) || typeof snapshot.market !== 'string' || !snapshot.market
            || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId) throw new Error('prompt_replay_snapshot_identity_invalid');
    }
    const sorted = [...snapshots].sort((a, b) => a.at - b.at || a.market.localeCompare(b.market)
        || a.snapshotId.localeCompare(b.snapshotId));
    for (const snapshot of sorted) {
        if (seen.has(snapshot.market)) continue;
        buildPromptReplayProtocol(snapshot);
        seen.add(snapshot.market);
        selected.push(frozen({ snapshotId: snapshot.snapshotId, market: snapshot.market, at: snapshot.at,
            input: snapshot.input, inputHash: snapshot.inputHash }));
        if (selected.length === pairs) return selected;
    }
    throw new Error('prompt_replay_insufficient_markets');
}

export function verifyReplayServices(rows, now = Date.now()) {
    if (!Array.isArray(rows) || rows.length !== REPLAY_SERVICES.length) throw new Error('prompt_replay_services_unknown');
    const services = REPLAY_SERVICES.map(unit => {
        const matches = rows.filter(row => row.Id === unit), row = matches[0];
        if (matches.length !== 1 || !['inactive', 'failed'].includes(row.ActiveState)
            || !['dead', 'failed'].includes(row.SubState) || String(row.MainPID) !== '0')
            throw new Error('prompt_replay_competing_service_active');
        return { unit, state: row.ActiveState, subState: row.SubState, pid: 0 };
    });
    return { checkedAt: now, services };
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function reserve(file, value) {
    ensureDirectory(path.dirname(file));
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('prompt_replay_inference_uncertain'); throw error; }
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
}
function release(file) { fs.unlinkSync(file); syncDirectory(path.dirname(file)); }

/** One POST at a time. Ambiguous transport/body/persistence failures retain the durable reservation. */
export async function replayPromptPair(snapshot, { counter, expectedIdentity, guard, fetch: request = globalThis.fetch,
    url, uncertainFile, persist, pairIndex = 0, clock = Date.now, timeoutMs = 30000 }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('prompt_replay_timeout_invalid');
    if (typeof guard !== 'function' || typeof persist !== 'function') throw new Error('prompt_replay_callbacks_required');
    if (fs.existsSync(uncertainFile)) throw new Error('prompt_replay_inference_uncertain');
    const variants = pairIndex % 2 ? [...REPLAY_VARIANTS].reverse() : [...REPLAY_VARIANTS], rows = [];
    for (const variantId of variants) {
        const protocol = buildPromptReplayProtocol(snapshot, variantId);
        const context = await verifyProtocolContext(protocol, counter, { expectedIdentity });
        reserve(uncertainFile, { snapshotId: snapshot.snapshotId, originalInputHash: snapshot.inputHash, variantId,
            promptHash: protocol.promptHash, requestHash: protocol.requestHash, reservedAt: clock(), reason: 'inference_pending_or_uncertain' });
        let guardEvidence;
        try { guardEvidence = await guard(); }
        catch (error) { release(uncertainFile); throw error; }
        const requestedAt = clock();
        let raw;
        try {
            const response = await request(url.replace(/\/$/, '') + '/v1/systemone', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(protocol.request),
                signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
            if (!response.ok) throw new Error('http_rejected');
            const body = await response.text();
            if (body.length > 100000) throw new Error('response_too_large');
            raw = JSON.parse(body);
        } catch { throw new Error('prompt_replay_inference_uncertain'); }
        const receivedAt = clock(), actualLatencyMs = receivedAt - requestedAt;
        const decoded = parseProtocolResponse(raw, protocol), modelInputTokens = raw?.usage?.input_tokens;
        const tokenUsageMatches = Number.isSafeInteger(modelInputTokens) && modelInputTokens === context.tokens;
        const timingValid = Number.isFinite(actualLatencyMs) && actualLatencyMs >= 0 && actualLatencyMs <= timeoutMs;
        const normalized = tokenUsageMatches && timingValid ? decoded : { ...decoded, action: 'SKIP', executable: false,
            status: 'invalid', reason: !tokenUsageMatches ? 'token_usage_mismatch' : 'response_deadline_exceeded' };
        const row = { ...normalized, market: snapshot.market, originalInputHash: snapshot.inputHash, requestedAt, receivedAt,
            actualLatencyMs, latencyMs: actualLatencyMs, timely: actualLatencyMs >= 0 && actualLatencyMs <= 3000,
            timelyBasis: 'diagnostic_3000ms_threshold_not_replayed_execution', context,
            modelInputTokens: modelInputTokens ?? null, tokenUsageMatches, guard: guardEvidence,
            replayOnly: true, cost: null, computeCost: null, costBasis: 'local_compute_unpriced' };
        await persist(row);
        rows.push(row); release(uncertainFile);
        if (row.status === 'invalid') throw new Error('prompt_replay_response_invalid');
    }
    return rows;
}

export function summarizePromptReplay(rows, markets = {}) {
    const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
    return Object.fromEntries(REPLAY_VARIANTS.map(variantId => {
        const results = rows.filter(row => row.variantId === variantId), buys = results.filter(row => row.status === 'ok' && row.executable);
        const labelled = buys.flatMap(row => {
            const market = markets[row.market], payout = market?.payout ?? market?.officialPayout;
            if (!Array.isArray(payout) || payout.length !== 2 || !payout.every(value => value === 0 || value === 1)
                || payout[0] + payout[1] !== 1) return [];
            return [{ correct: payout[row.action === 'BUY_UP' ? 0 : 1] === 1 }];
        });
        const latencies = results.map(row => row.actualLatencyMs).filter(value => Number.isFinite(value) && value >= 0);
        return [variantId, { requests: results.length, valid: results.filter(row => row.status === 'ok').length,
            skips: results.filter(row => row.status === 'ok' && row.action === 'SKIP').length,
            disallowed: results.filter(row => row.reason === 'disallowed_action').length, buyDecisions: buys.length,
            labelledBuyDecisions: labelled.length, directionCorrect: labelled.filter(row => row.correct).length,
            directionAccuracy: labelled.length ? labelled.filter(row => row.correct).length / labelled.length : null,
            timelyResponses: results.filter(row => row.timely).length,
            latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), samples: latencies.length },
            tradingProfit: null, computeCost: null, winner: null }];
    }));
}

export async function runPromptReplay({ ledgerFile, out, pairs = 4, reservationDir, counter, guard,
    fetch: request = globalThis.fetch, url = 'http://127.0.0.1:8090', clock = Date.now, timeoutMs = 30000 }) {
    if (![ledgerFile, out, reservationDir].every(value => typeof value === 'string' && path.isAbsolute(value)))
        throw new Error('prompt_replay_absolute_paths_required');
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/')
        throw new Error('prompt_replay_local_endpoint_required');
    const sourceBytes = fs.readFileSync(ledgerFile), source = JSON.parse(sourceBytes);
    const selected = selectReplaySnapshots(source.snapshots ?? source.ai?.snapshots, pairs);
    const artifact = path.join(out, 'results.json'), manifestFile = path.join(out, 'manifest.json');
    if (fs.existsSync(artifact) || fs.existsSync(manifestFile)) throw new Error('prompt_replay_output_exists');
    ensureDirectory(out); ensureDirectory(reservationDir);
    const lock = path.join(reservationDir, 'replay.lock'), uncertainFile = path.join(reservationDir, 'inference-uncertain.json');
    if (fs.existsSync(uncertainFile)) throw new Error('prompt_replay_inference_uncertain');
    try { reserve(lock, { pid: process.pid, startedAt: clock(), artifact }); }
    catch { throw new Error('prompt_replay_reservation_held'); }
    if (fs.existsSync(artifact) || fs.existsSync(manifestFile)) {
        release(lock); throw new Error('prompt_replay_output_exists');
    }
    const report = { startedAt: clock(), status: 'preflight', sourceHash: digest(sourceBytes),
        selection: 'first_chronological_snapshot_per_market_no_labels', pairs, rows: [], contextChecks: [], limitations: REPLAY_LIMITATIONS };
    try {
        const info = await counter.start(), expectedIdentity = info?.identity;
        if (typeof expectedIdentity !== 'string' || !expectedIdentity || info.maxTokens !== 1024)
            throw new Error('prompt_replay_tokenizer_invalid');
        const priorIdentity = source.providers?.laya?.tokenizerIdentity ?? source.ai?.providers?.laya?.tokenizerIdentity;
        if (priorIdentity && priorIdentity !== expectedIdentity) throw new Error('prompt_replay_tokenizer_changed');
        report.tokenizerIdentity = expectedIdentity;
        const selectedManifest = [];
        for (const snapshot of selected) {
            const protocols = [];
            for (const variantId of REPLAY_VARIANTS) {
                const protocol = buildPromptReplayProtocol(snapshot, variantId);
                const context = await verifyProtocolContext(protocol, counter, { expectedIdentity });
                report.contextChecks.push(context);
                protocols.push({ variantId, promptHash: protocol.promptHash, questionsHash: protocol.questionsHash,
                    requestHash: protocol.requestHash, context, questions: protocol.request.questions });
            }
            selectedManifest.push({ ...snapshot, protocols });
        }
        save(manifestFile, { schema: 1, createdAt: clock(), sourceHash: report.sourceHash, sourceFile: ledgerFile,
            model: 'typed-decisions', tokenizerIdentity: expectedIdentity, selection: report.selection,
            pairOrder: 'alternate_baseline_first_and_informed_first', timeoutMs, selected: selectedManifest,
            limitations: REPLAY_LIMITATIONS });
        report.manifestHash = digest(fs.readFileSync(manifestFile)); report.status = 'running'; save(artifact, report);
        for (const [pairIndex, snapshot] of selected.entries()) {
            await replayPromptPair(snapshot, { counter, expectedIdentity, guard, fetch: request, url: endpoint.origin,
                uncertainFile, pairIndex, clock, timeoutMs,
                persist: async row => { report.rows.push(row); save(artifact, report); } });
        }
        report.status = 'completed';
    } catch (error) { report.status = 'stopped'; report.reason = safeReason(error); }
    finally {
        report.finishedAt = clock();
        // Official labels are accessed only after all attempted inference has finished or stopped.
        report.summary = summarizePromptReplay(report.rows, source.markets ?? {});
        report.inferenceUncertain = fs.existsSync(uncertainFile);
        try { save(artifact, report); } finally { release(lock); }
    }
    return { artifact, manifest: fs.existsSync(manifestFile) ? manifestFile : null, status: report.status, reason: report.reason ?? null,
        pairs, completedRequests: report.rows.length, inferenceUncertain: report.inferenceUncertain,
        maxTokens: report.contextChecks.length ? Math.max(...report.contextChecks.map(row => row.tokens)) : null,
        summary: report.summary, limitations: report.limitations };
}
