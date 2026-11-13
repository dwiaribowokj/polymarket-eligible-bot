import fs from 'node:fs';
import path from 'node:path';
import { FilterPaperStore } from '../laya-filter-paper/store.js';

const unfinished = row => !row || ['pending', 'running', 'requested'].includes(row.status);
const sameSnapshot = (row, snapshot) => row && (!row.snapshotId || row.snapshotId === snapshot.snapshotId);
const telemetryEvents = new Set(['book_gap', 'book_ordering_recovered', 'book_stream_open',
    'book_message_rejected', 'book_reconnect_scheduled', 'book_tick_changed',
    'btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected', 'error']);

export class EntryFilterPaperStore extends FilterPaperStore {
    constructor(config, now = Date.now()) {
        super(config, now);
        for (const snapshot of this.state.snapshots) {
            snapshot.decisions ||= {};
            for (const name of config.armNames) {
                const decision = snapshot.decisions[name];
                if (!unfinished(decision)) continue;
                const arm = this.state.arms[name], position = arm.position;
                const reserved = sameSnapshot(arm.seen[snapshot.market], snapshot)
                    || position?.market.slug === snapshot.market && sameSnapshot(position, snapshot)
                    || arm.completed.some(row => (row.slug || row.market?.slug) === snapshot.market && sameSnapshot(row, snapshot))
                    || arm.outcomes[snapshot.market]?.reason === 'settled' && sameSnapshot(arm.outcomes[snapshot.market], snapshot);
                // A recorded reservation may still have inventory or an uncertain outcome.
                // Only a snapshot with no execution evidence becomes an explicit no-entry.
                snapshot.decisions[name] = { ...decision, snapshotId: snapshot.snapshotId,
                    status: reserved ? 'restart_after_reservation' : 'restart_before_decision',
                    action: reserved ? decision?.action || snapshot.sharedDecision?.action || 'SKIP' : 'SKIP',
                    executable: false, cost: 0, inferenceAttempted: false, requestSubmitted: false,
                    model: 'deterministic', entryDisposition: reserved ? 'reserved' : 'no_buy_decision' };
            }
            if (unfinished(snapshot.sharedDecision)) snapshot.sharedDecision = {
                snapshotId: snapshot.snapshotId, status: 'restart_before_decision', action: 'SKIP', executable: false,
                cost: 0, inferenceAttempted: false, requestSubmitted: false, model: 'deterministic' };
        }
        this.save();
    }
    eventBatch(events) {
        // Feed diagnostics only append; heartbeat, explicit saves and state events
        // checkpoint their counters without rewriting the ledger on each message.
        if (events.length && events.every(({ type }) => telemetryEvents.has(type))) {
            const at = new Date().toISOString(), rows = events.map(({ type, detail = {} }) => ({
                ...detail, at, id: this.config.id, type }));
            try {
                fs.appendFileSync(path.join(this.dir, 'events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
                for (const row of rows) console.log(JSON.stringify(row));
            } catch {
                throw new Error('paper_event_log_failed');
            }
            return;
        }
        return super.eventBatch(events.map(({ type, detail }) => {
            if (type !== 'snapshot') return { type, detail };
            const snapshot = this.state.snapshots.find(row => row.snapshotId === detail?.snapshotId);
            return { type, detail: snapshot ? { ...detail, filterVerdicts: snapshot.filterVerdicts,
                contextError: snapshot.contextError || null, contextVersion: snapshot.informed?.version || null,
                inferencePolicy: 'none' } : detail };
        }));
    }
}
