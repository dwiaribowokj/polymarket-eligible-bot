import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from '../restart/store.js';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);

function archiveRecord(state, dataDir, reason, now, bytes) {
    return { id: state.id, dataDir, archivedAt: now, reason,
        ledgerBeforeSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        results: Object.fromEntries(Object.entries(state.arms).map(([name, arm]) => [name, {
            cash: arm.cash, completed: arm.completed.length, pnl: arm.completed.reduce((n, row) => n + row.pnl, 0),
            drawdown: arm.drawdown, stopped: arm.stopped }])) };
}

// Caller holds the period lock, after its runner has drained inference and inventory.
export function archivePaperPeriod(dataDir, reason, now = Date.now()) {
    if (!path.isAbsolute(dataDir) || !/^[a-z][a-z0-9_-]{2,80}$/.test(reason || '')) throw new Error('invalid_paper_archive');
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'active.json')));
    if (!validId(marker.id)) throw new Error('paper_archive_identity_invalid');
    const dir = path.join(dataDir, marker.id), filename = path.join(dir, 'ledger.json');
    const bytes = fs.readFileSync(filename), state = JSON.parse(bytes);
    if (state.id !== marker.id) throw new Error('paper_archive_identity_mismatch');
    const backup = path.join(dir, 'ledger-before-archive.json');
    if (state.archivedAt) {
        if (state.archiveReason !== reason) throw new Error('paper_archive_reason_mismatch');
        const originalBytes = fs.readFileSync(backup), original = JSON.parse(originalBytes);
        if (original.id !== state.id || JSON.stringify(original.arms) !== JSON.stringify(state.arms)
            || JSON.stringify(original.providers) !== JSON.stringify(state.providers)) throw new Error('paper_archive_backup_mismatch');
        const archive = archiveRecord(state, dataDir, reason, state.archivedAt, originalBytes);
        atomicJson(path.join(dir, 'archive.json'), archive);
        return archive;
    }
    if (!Number.isFinite(now) || now < state.startedAt) throw new Error('paper_archive_time_invalid');
    if (Object.values(state.arms).some(arm => arm.position)) throw new Error('paper_archive_inventory_open');
    if (Object.values(state.providers).some(provider => provider.pending)) throw new Error('paper_archive_inference_pending');
    if (state.snapshots.some(snapshot => !state.markets[snapshot.market]?.payout)) throw new Error('paper_archive_labels_pending');
    if (fs.existsSync(backup)) {
        if (!fs.readFileSync(backup).equals(bytes)) throw new Error('paper_archive_backup_mismatch');
    } else fs.writeFileSync(backup, bytes, { flag: 'wx', mode: 0o600, flush: true });
    const archive = archiveRecord(state, dataDir, reason, now, bytes);
    state.archivedAt = now; state.archiveReason = reason; state.frozenAt ||= now;
    atomicJson(filename, state);
    atomicJson(path.join(dir, 'archive.json'), archive);
    return archive;
}

export function linkPaperHistory(dataDir, archive) {
    if (!path.isAbsolute(dataDir) || !path.isAbsolute(archive?.dataDir || '') || !validId(archive?.id)
        || !Number.isFinite(archive.archivedAt) || path.resolve(dataDir) === path.resolve(archive.dataDir))
        throw new Error('paper_history_link_invalid');
    const historyFile = path.join(dataDir, 'history.json');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile)) : { schema: 1, periods: [] };
    if (!Array.isArray(history.periods)) throw new Error('paper_history_invalid');
    if (!history.periods.some(row => row.id === archive.id && path.resolve(row.dataDir) === path.resolve(archive.dataDir)))
        history.periods.push({ id: archive.id, dataDir: path.resolve(archive.dataDir), archivedAt: archive.archivedAt, reason: archive.reason });
    atomicJson(historyFile, history);
}
