import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildProtocolRequest, parseProtocolResponse, verifyProtocolContext } from './protocol.js';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const LIMITATIONS = Object.freeze(['historical_replay_not_paper_fills_or_profit',
    'selected_small_single_day_sample_not_live_qualification', 'latency_in_quiet_windows_not_live_p95',
    'choice_probabilities_not_market_win_probabilities', 'local_compute_cost_unknown',
    'no_automatic_prompt_or_model_deployment']);

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function ensureDirectory(directory) {
    const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!created) return;
    // A durable file inside a new directory also needs every new parent entry.
    const existingParent = path.dirname(path.resolve(created));
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
        syncDirectory(current);
        if (current === existingParent) break;
    }
}

export function save(file, value) {
    ensureDirectory(path.dirname(file));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
    } catch (error) {
        fs.closeSync(fd);
        fs.unlinkSync(temporary);
        throw error;
    }
    fs.closeSync(fd);
    try {
        fs.renameSync(temporary, file);
        syncDirectory(path.dirname(file));
    } catch (error) {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        throw error;
    }
}

function reserveInference(file, value) {
    ensureDirectory(path.dirname(file));
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error('tune_inference_uncertain');
        throw error;
    }
    // Even an incomplete marker blocks another inference after a crash.
    try {
        fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
}

function clearInference(file) {
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
}

// No inference near production's 90/60/30-second decision slots. Thirty seconds
// for a drained HTTP request still leaves at least sixty seconds before slot90.
export function quietGuard({ now, service, ledger, expectedPid, expectedTokenizer }) {
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('tune_clock_invalid');
    if (service?.ActiveState !== 'active' || service.SubState !== 'running'
        || !Number.isSafeInteger(expectedPid) || expectedPid < 1
        || Number(service.MainPID) !== expectedPid) throw new Error('tune_live_process_changed');
    if (!ledger || ledger.stopped || ledger.position) throw new Error('tune_live_not_idle');
    const provider = ledger.ai?.providers?.laya;
    if (!provider || provider.pending || provider.disabled || provider.unavailable) throw new Error('tune_live_provider_not_idle');
    if (typeof expectedTokenizer !== 'string' || !expectedTokenizer
        || provider.tokenizerIdentity !== expectedTokenizer) throw new Error('tune_tokenizer_changed');
    if (!Number.isFinite(ledger.lastTickAt) || ledger.lastTickAt > now || now - ledger.lastTickAt > 15_000)
        throw new Error('tune_live_heartbeat_stale');
    const elapsed = now % 300_000;
    if (elapsed < 30_000 || elapsed > 120_000) throw new Error('tune_outside_quiet_window');
    return { checkedAt: now, elapsedMs: elapsed, livePid: expectedPid, lastTickAt: ledger.lastTickAt };
}

// Select the first snapshot per resolved market, balanced by executable side.
// Settlement labels are used only AFTER inference, never for selection or input.
export function selectSnapshots(snapshots, count, resolvedMarkets = null) {
    if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('tune_pair_count_invalid');
    const seen = new Set(), groups = { BUY_UP: [], BUY_DOWN: [], other: [] };
    for (const s of [...snapshots].sort((a, b) => a.at - b.at)) {
        if (resolvedMarkets && !resolvedMarkets.has(s.market) || seen.has(s.market)) continue;
        buildProtocolRequest(s); // Validate exact input before any selection.
        seen.add(s.market);
        const allowed = JSON.parse(s.input).allowed.filter(action => action !== 'SKIP');
        groups[allowed.length === 1 ? allowed[0] : 'other'].push(s);
    }
    const selected = [];
    while (selected.length < count) {
        let added = false;
        for (const key of ['BUY_UP', 'BUY_DOWN', 'other']) {
            if (groups[key].length && selected.length < count) { selected.push(groups[key].shift()); added = true; }
        }
        if (!added) throw new Error('tune_insufficient_markets');
    }
    return selected;
}

function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(fraction * sorted.length) - 1];
}

export function summarize(rows, labels = [], candidateId = 'candidate-v1') {
    const labelMap = new Map(labels.map(row => [row.slug, row]));
    return Object.fromEntries(['baseline-v1', candidateId].map(variant => {
        const selected = rows.filter(row => row.variantId === variant);
        let buys = 0, labelledBuys = 0, correct = 0;
        for (const row of selected) {
            if (!row.executable) continue;
            buys++;
            const payout = labelMap.get(row.market)?.payout;
            if (!Array.isArray(payout) || payout.length !== 2 || !payout.every(value => value === 0 || value === 1) || payout[0] + payout[1] !== 1) continue;
            labelledBuys++;
            if (payout[row.action === 'BUY_UP' ? 0 : 1] === 1) correct++;
        }
        return [variant, { requests: selected.length, valid: selected.filter(row => row.status === 'ok').length,
            disallowed: selected.filter(row => row.reason === 'disallowed_action').length,
            skip: selected.filter(row => row.status === 'ok' && row.action === 'SKIP').length,
            timely: selected.filter(row => row.timely).length, buyDecisions: buys,
            timelyBuyDecisions: selected.filter(row => row.executable && row.timely).length,
            labelledBuyDecisions: labelledBuys, directionCorrect: correct,
            latencyMs: { p50: percentile(selected.map(row => row.latencyMs), .5), p95: percentile(selected.map(row => row.latencyMs), .95) },
            tradingProfit: null, computeCost: null }];
    }));
}

/** One request at a time, never retry. An uncertain marker exists BEFORE POST.
 * Crashes and timeouts cannot silently start another inference on restart. */
export async function replayPair(snapshot, { counter, expectedIdentity, guard, fetch: request = fetch,
    url, uncertainFile, persist, pairIndex = 0, clock = Date.now, timeoutMs = 30_000, candidateId = 'candidate-v1' }) {
    if (!['candidate-v1', 'candidate-v2'].includes(candidateId)) throw new Error('tune_candidate_unknown');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
        throw new Error('tune_timeout_invalid');
    if (fs.existsSync(uncertainFile)) throw new Error('tune_inference_uncertain');
    const rows = [];
    const variants = pairIndex % 2 ? [candidateId, 'baseline-v1'] : ['baseline-v1', candidateId];
    for (const variantId of variants) {
        const started = clock();
        const protocol = buildProtocolRequest(snapshot, { variantId });
        const context = await verifyProtocolContext(protocol, counter, { expectedIdentity });
        reserveInference(uncertainFile, { startedAt: started, snapshotId: snapshot.snapshotId, variantId,
            requestHash: protocol.requestHash, reason: 'inference_pending_or_uncertain' });
        let evidence;
        try { evidence = await guard(); }
        catch (error) {
            // No POST has started. Release only this exclusively owned marker.
            clearInference(uncertainFile);
            throw error;
        }
        let raw;
        try {
            // Timeout covers both headers and body. Aborting does not prove the
            // server stopped inference, so retain the marker on any failure.
            const response = await request(url + '/v1/systemone', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(protocol.request),
                signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
            if (!response.ok) throw new Error('tune_inference_http_rejected');
            const body = await response.text();
            if (body.length > 100_000) throw new Error('tune_response_too_large');
            raw = JSON.parse(body);
        } catch { throw new Error('tune_inference_uncertain'); }
        const latencyMs = clock() - started;
        const decoded = parseProtocolResponse(raw, protocol);
        const modelInputTokens = raw.usage?.input_tokens;
        const tokenUsageMatches = modelInputTokens === context.tokens;
        const normalized = tokenUsageMatches ? decoded : { ...decoded, action: 'SKIP', executable: false,
            status: 'invalid', reason: decoded.reason || 'token_usage_mismatch' };
        const row = { ...normalized, market: snapshot.market, latencyMs, timely: latencyMs <= 3000,
            replayOnly: true, context, modelInputTokens: modelInputTokens ?? null,
            tokenUsageMatches, guard: evidence, completedAt: clock() };
        rows.push(row);
        await persist(row); // Retain uncertain marker if durable result failed.
        clearInference(uncertainFile);
        if (normalized.status === 'invalid') throw new Error('tune_invalid_response');
    }
    return rows;
}
