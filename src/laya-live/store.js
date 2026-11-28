import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../restart/store.js';

const ARCHIVE_SLOT_KEY = /^btc-updown-5m-(\d+):(\d+)$/;
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const DEFERRED_TELEMETRY_EVENTS = new Set([
    'laya_supervisor_heartbeat', 'laya_book_status', 'read_failed', 'endpoint_recovered',
    'rpc_failover', 'rpc_rejection', 'circuit_opened', 'book_stream_open', 'book_gap',
    'book_reconnect_scheduled', 'book_ordering_recovered', 'book_tick_changed', 'book_message_rejected',
    'btc_opening_observed', 'btc_feed_gap', 'metadata_tick_updated', 'live_rpc_recovery_wait',
    'external_activity_deferred', 'laya_market_watched', 'laya_report_retry',
    'eligible_continuous_recovery_retry', 'settlement_stop_recovery_deferred',
    'closed_market_book_invalidation', 'settled_hold_book_recovery_wait',
    'provider_preflight', 'eligible_provider_health_ready', 'laya_provider_health_ready',
    'laya_slot_skipped', 'laya_snapshot_skipped', 'laya_opportunity_skipped',
    'laya_book_recovery_wait', 'laya_feed_recovery_wait', 'laya_feed_disparity_wait',
    'laya_decision_expired', 'live_entry_data_rejected', 'laya_watch_failed',
    'diagnostic_entry_validated',
]);

const DEFERRED_PRE_POSITION_EVENTS = new Set([
    'laya_snapshot', 'laya_decision', 'laya_entry_disposition', 'eligible_entry_filter_veto',
    'laya_execution_constraints_changed', 'laya_execution_unmarketable',
]);

function isDeferredEvent(state, type, detail, providerProbePersisted) {
    if (DEFERRED_TELEMETRY_EVENTS.has(type)) return true;
    if (DEFERRED_PRE_POSITION_EVENTS.has(type)) return !state?.position;
    if (type === 'live_entry_hold') {
        return detail?.key === 'provider_probe' && detail?.retryable === true && !providerProbePersisted;
    }
    if (type === 'live_entry_hold_recovered') {
        return detail?.key === 'provider_probe' && !providerProbePersisted;
    }
    return false;
}

/**
 * Append closed slot metadata and aged decision snapshots to a sibling NDJSON
 * archive while keeping in-memory indices and protected recovery rows intact.
 */
export function compactLiveAiHistory(store, options = {}) {
    const {
        now = Date.now(),
        maxSlotAgeMs = 7_200_000,
        keepRecentSnapshots = 25,
        maxSnapshotAgeMs = 7_200_000,
        minSlots = 50,
        minSnapshots = 10,
        force = false,
    } = options;
    const state = store?.state;
    if (state?.mode !== 'pilot' || state.decisionProvider !== 'eligible'
        || typeof store?.directory !== 'string' || !store.directory.length || typeof store.event !== 'function'
        || state.position != null || state.stopped != null || state.liveRiskStop != null
        || state.frozenAt != null || state.profitTaking?.pending != null
        || state.profitTakingControl?.operation != null
        || !Number.isSafeInteger(now) || now <= 0 || !isPlainObject(state.ai))
        return { archivedSlots: 0, archivedSnapshots: 0 };

    const protectedSnapshotIds = new Set();
    if (Array.isArray(state.completed)) {
        for (const row of state.completed) {
            if ((row?.uncertain || row?.pendingTrades) && row.entrySignal?.snapshotId)
                protectedSnapshotIds.add(row.entrySignal.snapshotId);
        }
    }

    const slotCutoff = now - maxSlotAgeMs;
    const slots = isPlainObject(state.ai.slots) ? state.ai.slots : null;
    const slotKeys = [];
    if (slots) {
        for (const [key, slot] of Object.entries(slots)) {
            const match = ARCHIVE_SLOT_KEY.exec(key);
            if (!match) continue;
            const marketEndMs = (Number(match[1]) + 300) * 1000;
            if (!Number.isSafeInteger(marketEndMs) || marketEndMs > slotCutoff) continue;
            if (slot?.snapshotId && protectedSnapshotIds.has(slot.snapshotId)) continue;
            slotKeys.push(key);
        }
    }

    const snapshotCutoff = now - maxSnapshotAgeMs;
    const snapshots = Array.isArray(state.ai.snapshots) ? state.ai.snapshots : null;
    const snapshotIndices = [];
    if (snapshots) {
        const limit = Math.max(0, snapshots.length - Math.max(0, keepRecentSnapshots));
        for (let i = 0; i < limit; i++) {
            const snapshot = snapshots[i];
            if (!isPlainObject(snapshot) || snapshot.archived === true) continue;
            if (!Number.isSafeInteger(snapshot.at) || snapshot.at > snapshotCutoff) continue;
            if (snapshot.snapshotId && protectedSnapshotIds.has(snapshot.snapshotId)) continue;
            snapshotIndices.push(i);
        }
    }

    if (!slotKeys.length && !snapshotIndices.length)
        return { archivedSlots: 0, archivedSnapshots: 0 };
    if (!force && slotKeys.length < minSlots && snapshotIndices.length < minSnapshots)
        return { archivedSlots: 0, archivedSnapshots: 0 };

    const lines = [];
    for (const key of slotKeys)
        lines.push(JSON.stringify({ archivedAt: now, kind: 'slot', key, slot: slots[key] }));
    for (const i of snapshotIndices)
        lines.push(JSON.stringify({ archivedAt: now, kind: 'snapshot', index: i, snapshot: snapshots[i] }));

    // Must use .jsonl so liveHistory() in recovery.js never scans it as a ledger.
    const archiveFile = path.join(store.directory, `${state.strategy}.ai-archive.jsonl`);
    fs.mkdirSync(store.directory, { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(archiveFile);
    const fd = fs.openSync(archiveFile, 'a', 0o600);
    try {
        fs.writeSync(fd, `${lines.join('\n')}\n`);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (!existed) {
        const dir = fs.openSync(store.directory, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }

    const removedSlots = slotKeys.map(key => [key, slots[key]]);
    const replacedSnapshots = snapshotIndices.map(i => [i, snapshots[i]]);
    try {
        for (const key of slotKeys) delete slots[key];
        for (const i of snapshotIndices) {
            const s = snapshots[i];
            snapshots[i] = {
                snapshotId: s.snapshotId,
                market: s.market,
                slot: s.slot,
                at: s.at,
                ...(s.provider !== undefined ? { provider: s.provider } : {}),
                ...(s.model !== undefined ? { model: s.model } : {}),
                ...(s.strategyEpochId !== undefined ? { strategyEpochId: s.strategyEpochId } : {}),
                ...(s.inputHash !== undefined ? { inputHash: s.inputHash } : {}),
                ...(s.entryDisposition !== undefined ? { entryDisposition: s.entryDisposition } : {}),
                archived: true,
            };
        }
        store.event('ai_history_archived', {
            archivedSlots: slotKeys.length,
            archivedSnapshots: snapshotIndices.length,
            remainingSlots: slots ? Object.keys(slots).length : 0,
            totalSnapshots: snapshots ? snapshots.length : 0,
            archiveFile: path.basename(archiveFile),
        });
    } catch (error) {
        for (const [key, slot] of removedSlots) slots[key] = slot;
        for (const [i, snapshot] of replacedSnapshots) snapshots[i] = snapshot;
        throw error;
    }
    return { archivedSlots: slotKeys.length, archivedSnapshots: snapshotIndices.length };
}

// Keep live I/O tuning outside the source-pinned paper control baseline.
export class LiveStore extends Store {
    constructor(settings, mode, strategy) {
        super(settings, mode, strategy);
        this.dirty = false;
        this._deferNextSave = false;
        this._providerProbePersisted = Boolean(this.state?.entryHolds?.provider_probe);
    }
    save(options = {}) {
        if (this.state.mode !== 'pilot') return super.save();
        if (options?.deferred === true || this._deferNextSave) {
            this.dirty = true;
            return;
        }
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const tmp = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.filename);
        const dir = fs.openSync(path.dirname(this.filename), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        this.dirty = false;
        this._providerProbePersisted = Boolean(this.state?.entryHolds?.provider_probe);
    }
    saveDeferred() { this.save({ deferred: true }); }
    flush() { if (this.dirty) this.save(); }
    event(type, detail = {}) {
        if (this.state.mode !== 'pilot'
            || !isDeferredEvent(this.state, type, detail, this._providerProbePersisted))
            return super.event(type, detail);
        this._deferNextSave = true;
        try { return super.event(type, detail); }
        finally { this._deferNextSave = false; }
    }
}
