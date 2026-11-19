// Model the earliest pre-reservation book validation. Do not import live clients,
// load account credentials, sign, or treat this timestamp as an observed POST.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = data => createHash('sha256').update(data).digest('hex');
const ms = n => Number.isFinite(n) && n >= 0;
const timestamp = n => Number.isSafeInteger(n) && n > 0;
const goodPin = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const own = (o, k) => Object.hasOwn(o, k);
const importedFiles = ['package.json', 'src/eligible-live/provider.js', 'src/eligible-live/entry-buffer.js',
    'src/eligible-live/entry-cost-cap.js', 'src/decision-paper/features.js', 'src/decision-paper/entry-filter.js',
    'src/restart/math.js', 'src/restart/network.js'];

export async function loadTimingArm({ root, manifestPath, manifestSha256, mode }) {
    if (!['serial', 'overlap'].includes(mode) || !goodPin(manifestSha256)
        || !path.isAbsolute(root) || !path.isAbsolute(manifestPath)) throw new Error('invalid_arm_pin');
    const bytes = await readFile(manifestPath);
    if (hash(bytes) !== manifestSha256) throw new Error('manifest_hash_mismatch');
    const manifest = JSON.parse(bytes), base = await realpath(root);
    const sources = new Map(manifest.sources);
    if (sources.size !== manifest.sources.length || !importedFiles.every(file => sources.has(file)))
        throw new Error('incomplete_arm_sources');
    for (const [file, expected] of sources) {
        if (typeof file !== 'string' || !file || file.startsWith('.') || file.includes('..')
            || path.isAbsolute(file) || !goodPin(expected)) throw new Error('invalid_arm_source');
        const target = path.join(base, file);
        if (await realpath(target) !== target || hash(await readFile(target)) !== expected)
            throw new Error('arm_source_mismatch');
    }
    const { policy, runtimeId } = manifest, execution = policy?.execution;
    if (!/^[a-f0-9]{16}$/.test(runtimeId) || policy?.provider !== 'eligible' || policy.inference !== false
        || policy.entryFilter?.version !== 'full-fill-all-in-cost-cap-v1'
        || policy.entryFilter.maxCostPerShare !== 0.82 || !ms(execution?.gasUsd)
        || execution.gasUsd !== policy.entryFilter.gasUsd || execution.latencyMs !== 250
        || !ms(execution.inferenceReserveMs) || !ms(execution.decisionMs) || !ms(execution.dataAgeMs)
        || execution.dataAgeMs <= execution.latencyMs + execution.inferenceReserveMs)
        throw new Error('unsupported_paired_policy');
    const { EligibleLiveProvider } = await import(pathToFileURL(path.join(base, 'src/eligible-live/provider.js')).href);
    return Object.freeze({ mode, runtimeId, manifestSha256, execution: Object.freeze({ ...execution }),
        entryFilter: Object.freeze({ ...policy.entryFilter }), Provider: EligibleLiveProvider });
}

// For both source revisions snapshot publication precedes the deterministic
// decision; wallet, metadata and decision then join, followed by another durable
// event. Only the newer revision starts the wallet during initial preparation.
// The old serial read's duration is counterfactual: same total observed read,
// started later. The newer arm uses the actual residual wait for that same read.
// One matched-store benchmark ratio scales persistence for the serial arm.
export async function evaluateTimingArm(arm, snapshot, { oldToNewPersistRatio = 1 } = {}) {
    if (!Number.isFinite(oldToNewPersistRatio) || oldToNewPersistRatio < 0.2 || oldToNewPersistRatio > 10)
        throw new Error('invalid_persistence_benchmark');
    const out = { status: 'unavailable', reason: null, action: null, readyAt: null, decisionAt: null, stages: null,
        sourceAt: null, dataAgeMs: arm.execution.dataAgeMs, index: null, limitPrice: null, tokenId: null, shares: null };
    const reject = (reason, status = 'unavailable') => ({ ...out, status, reason });
    const s = snapshot, cfg = arm.execution;
    if (!s || typeof s !== 'object' || !timestamp(s.at) || !timestamp(s.observedAt) || !timestamp(s.validation?.at)
        || s.observedAt > s.at || s.validation.at > s.at || s.provider !== 'eligible'
        || s.model !== 'deterministic-eligible-v1' || !cfg.slots?.includes(s.slot)) return reject('invalid_snapshot');
    // validation.tickVerifiedAt may be mutated on a later validate() call. A
    // timestamp from after snapshot creation was not yet available at admission.
    const validation = { at: s.validation.at, generation: s.validation.generation, identity: s.validation.identity };
    if (own(s.validation, 'tickVerifiedAt') && !timestamp(s.validation.tickVerifiedAt)) return reject('invalid_tick_time');
    if (s.validation.tickVerifiedAt <= s.at) validation.tickVerifiedAt = s.validation.tickVerifiedAt;
    const persist = s.snapshotPersistMs, request = s.decisionRequestedAt, received = s.decisionReceivedAt;
    if (!ms(persist) || !timestamp(request) || !timestamp(received) || request < s.at || received < request
        || received - request > cfg.decisionMs || request - s.at + 2 < persist)
        return reject('decision_timing_unavailable');
    const modeledPersist = persist * (arm.mode === 'serial' ? oldToNewPersistRatio : 1);
    // request - snapshot.at already includes the snapshot write. Adjust by
    // the difference, never add a whole extra write before the decision.
    const decisionAt = Math.max(s.at, Math.ceil(request + modeledPersist - persist));
    const sourceAt = Math.min(s.observedAt, validation.at, validation.tickVerifiedAt ?? Infinity);
    out.decisionAt = decisionAt;
    out.sourceAt = sourceAt;
    out.stages = { observedRequestAt: request, observedSnapshotPersistMs: persist, modeledSnapshotPersistMs: modeledPersist,
        modeledDecisionPersistMs: modeledPersist, decisionMs: received - request };
    const reserve = cfg.latencyMs + cfg.inferenceReserveMs;
    const filterInput = { model: s.model, provider: s.provider, snapshotId: s.snapshotId, input: s.input,
        inputHash: s.inputHash, observedAt: s.observedAt, at: s.at, market: s.market, slot: s.slot, validation,
        allowed: s.allowed, entryFilter: s.entryFilter };
    if (typeof s.input !== 'string' || hash(s.input) !== s.inputHash
        || s.snapshotId !== hash(JSON.stringify({ slug: s.market, seconds: s.slot, now: s.at, input: s.input })).slice(0, 24))
        return reject('snapshot_hash_mismatch');
    if (decisionAt - s.observedAt > cfg.dataAgeMs - reserve) return reject('insufficient_input_headroom', 'skip');
    if (decisionAt - Math.min(validation.at, validation.tickVerifiedAt ?? Infinity) > cfg.dataAgeMs - reserve)
        return reject('insufficient_validation_headroom', 'skip');
    const provider = new arm.Provider({ ...cfg, entryFilter: arm.entryFilter }, {}, () => {}, { clock: () => decisionAt });
    let decision;
    try { decision = await provider.predict('eligible', filterInput); } finally { provider.close(); }
    out.action = decision.action;
    if (decision.action === 'SKIP') {
        const reason = decision.reason || 'eligible_skip';
        return reject(reason, ['entry_cost_above_cap', 'eligible_skip'].includes(reason) ? 'skip' : 'unavailable');
    }
    const index = ['BUY_UP', 'BUY_DOWN'].indexOf(decision.action);
    const selected = s.allowed?.find(o => o.index === index);
    if (decision.status !== 'ok' || !decision.entryFilter?.pass || index < 0 || !selected)
        return reject('invalid_eligible_result');
    Object.assign(out, { index, limitPrice: selected.price, shares: selected.shares, tokenId: selected.tokenId });
    if (!ms(s.walletReadMs) || !ms(s.walletWaitMs) || !ms(s.metadataWarmupMs)) return reject('wallet_or_metadata_timing_unavailable');
    // The live engine installs this witness only after both reads resolve.
    // Accept a redacted completion flag for exported ledgers. No balance,
    // nonce, position, submission result, settlement or PnL is consulted.
    const verified = own(s, 'walletReadSucceeded') ? s.walletReadSucceeded === true
        : s.wallet !== null && typeof s.wallet === 'object' && !Array.isArray(s.wallet);
    if (!verified) return reject('wallet_or_metadata_read_unverified');
    const wait = arm.mode === 'serial' ? s.walletReadMs : s.walletWaitMs;
    const joinAt = decisionAt + Math.max(received - request, wait, s.metadataWarmupMs);
    const headroomAt = Math.ceil(joinAt + modeledPersist);
    // awaitExecutionLatency is a floor relative to decision receipt, not a
    // second fixed wait on top of the wallet read or durable decision event.
    const readyAt = Math.ceil(Math.max(headroomAt, decisionAt + (received - request) + cfg.latencyMs));
    Object.assign(out.stages, { walletTotalMs: s.walletReadMs, walletResidualMs: s.walletWaitMs,
        walletCriticalMs: wait, metadataWarmupMs: s.metadataWarmupMs, joinAt: Math.ceil(joinAt),
        headroomAt, candidateReadyAt: readyAt });
    if (headroomAt - sourceAt > cfg.dataAgeMs - reserve) return reject('insufficient_execution_headroom', 'skip');
    if (readyAt - sourceAt > cfg.dataAgeMs) return reject('stale_input_at_validation', 'skip');
    return { ...out, status: 'ready', readyAt };
}
