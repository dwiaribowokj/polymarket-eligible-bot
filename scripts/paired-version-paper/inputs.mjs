import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { verifyValueObservation } from '../../src/value-collector/features.js';

export const sha = data => createHash('sha256').update(data).digest('hex');
export const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function optional(file) {
    try { return json(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function collectorEvidence(root, marketEnd, seconds) {
    const open = marketEnd - 300000, slug = 'btc-updown-5m-' + open / 1000, at = marketEnd - seconds * 1000;
    const row = optional(path.join(root, 'observations', new Date(at).toISOString().slice(0, 10), slug, at + '.json'));
    if (!row || row.status !== 'ready') return null;
    const f = row.features, m = f?.market;
    if (row.slug !== slug || row.scheduledAt !== at || row.id !== slug + ':' + at || row.marketEnd !== marketEnd
        || row.seconds !== seconds || row.clock?.verified !== true || !verifyValueObservation(f)
        || f.quality?.status !== 'ready' || f.at !== row.at || f.scheduledAt !== at || m?.slug !== slug
        || m.open !== open || m.end !== marketEnd || m.conditionId !== row.conditionId
        || !['UP','DOWN'].every((v,i) => f.sides?.[i]?.side === v && f.sides[i].tokenId === m.tokens[i]))
        throw new Error('invalid_collector_evidence');
    return row;
}
export function reference(root, end, knownAt = Date.now()) {
    for (const seconds of [270,240,210,180,150,120,90,75,60,50,40,30,20,15,10,5]) {
        if (end - seconds * 1000 > knownAt) break;
        const row = collectorEvidence(root, end, seconds);
        if (row && row.at <= knownAt) return row;
    }
    return null;
}
export function label(root, condition) {
    if (!/^0x[0-9a-f]{64}$/i.test(condition)) throw new Error('invalid_label_key');
    const key = sha(condition.toLowerCase());
    return optional(path.join(root, 'labels', key.slice(0,2), key + '.json'));
}
// Keep the large private ledger off the WebSocket event loop. Only causally relevant
// market inputs and stage durations cross this worker boundary.
export function project(state, id, slot) {
    if (state.mode !== 'pilot' || state.strategy !== 'late-entry' || state.baseline !== id.periodId
        || state.continuousOperation?.runtimeId !== id.liveRuntimeId || state.currentStrategyEpochId !== id.epochId)
        throw new Error('source_period_or_runtime_changed');
    if (!slot) return { verified: true };
    const rows = state.ai.snapshots.filter(s => s.market === slot.slug && s.slot === slot.seconds
        && s.at >= slot.scheduledAt && s.at <= slot.scheduledAt + 2000);
    if (rows.length > 1) throw new Error('duplicate_source_snapshot');
    const s = rows[0], slotStatus = state.ai.slots[slot.slug + ':' + slot.seconds]?.status;
    if (!s) return { reason: slotStatus === 'no_valid_side' ? 'source_no_valid_side' : 'source_slot_' +
        (['invalid','observed','pending','missed'].includes(slotStatus) ? slotStatus : 'not_observed') };
    if (s.strategyEpochId !== id.epochId || s.entryFilter?.maxCostPerShare !== 0.82) throw new Error('source_strategy_changed');
    const keys = ['market','slot','at','observedAt','snapshotId','provider','model','input','inputHash','allowed','validation',
        'entryFilter','decisionRequestedAt','decisionReceivedAt','walletReadMs','walletWaitMs','metadataWarmupMs','snapshotPersistMs'];
    return { snapshot: { ...Object.fromEntries(keys.filter(k=>Object.hasOwn(s,k)).map(k=>[k,s[k]])),
        walletReadSucceeded: Boolean(s.wallet && typeof s.wallet === 'object') } };
}
if (!isMainThread && workerData?.pairedInput) {
    parentPort.on('message', slot => {
        try { parentPort.postMessage(project(json(workerData.ledger), workerData.identity, slot)); }
        catch (e) { parentPort.postMessage({ fatal: /^[a-z_]+$/.test(e.message) ? e.message : 'source_ledger_read_failed' }); }
    });
}
export class SnapshotReader {
    constructor(ledger, identity) {
        this.worker = new Worker(new URL(import.meta.url), {workerData:{pairedInput:true,ledger,identity}});
    }
    async read(slot) {
        return new Promise((resolve, reject) => {
            const done=(err,v)=>{clearTimeout(timeout); this.worker.off('error',fail); this.worker.off('message',receive);
                this.worker.off('exit',exit); err ? reject(err) : resolve(v);};
            const fail=e=>done(e), exit=()=>fail(new Error('source_reader_exited'));
            const receive=v=>v.fatal ? fail(new Error(v.fatal)) : done(null,v);
            const timeout=setTimeout(()=>fail(new Error('source_reader_timeout')),10000);
            this.worker.once('exit',exit).once('error',fail).once('message',receive); this.worker.postMessage(slot);
        });
    }
    close() { return this.worker.terminate(); }
}
