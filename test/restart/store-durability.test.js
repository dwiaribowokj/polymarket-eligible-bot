import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson } from '../../src/restart/store.js';
import { LiveStore as Store, compactLiveAiHistory } from '../../src/laya-live/store.js';
import { liveHistory } from '../../src/laya-live/recovery.js';
import { eligibleStrategySummary } from '../../src/eligible-live/strategy-epochs.js';

function fixture(t, mode = 'pilot') {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-durability-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { dataDir, fingerprint: 'fixture-baseline', capital: 20 };
    const store = new Store(settings, mode, 'late-entry');
    store.logger = () => {};
    return { settings, store, eventsFile: path.join(store.directory, 'late-entry.jsonl') };
}

test('pilot events persist complete compact state with the same atomic durability boundaries', t => {
    const { settings, store, eventsFile } = fixture(t);
    store.state.completed.push({ traded: true, pnl: 1, fees: 0.1, gas: 0.01,
        market: { slug: 'fixture-market' }, evidence: { receipts: ['receipt-a'] } });
    store.save();
    const previous = fs.readFileSync(store.filename, 'utf8');
    store.state.position = { market: { slug: 'next-market' }, holdings: [0, 0], orders: [],
        phase: 'reserved', intendedShares: 5 };
    const steps = [];
    const fsync = fs.fsyncSync, rename = fs.renameSync;
    t.mock.method(fs, 'fsyncSync', fd => {
        const type = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
        fsync(fd);
        steps.push(`fsync:${type}`);
    });
    t.mock.method(fs, 'renameSync', (from, to) => {
        assert.equal(fs.readFileSync(to, 'utf8'), previous);
        assert.deepEqual(steps, ['fsync:file']);
        rename(from, to);
        steps.push('rename');
    });
    store.logger = row => {
        assert.deepEqual(steps, ['fsync:file', 'rename', 'fsync:directory', 'fsync:file']);
        assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state, store.state);
        assert.deepEqual(JSON.parse(fs.readFileSync(eventsFile, 'utf8')), row);
        steps.push('logged');
    };

    store.event('entry_reserved', { market: 'next-market' });

    const bytes = fs.readFileSync(store.filename, 'utf8');
    assert.equal(bytes, JSON.stringify(store.state));
    assert.ok(bytes.length < JSON.stringify(store.state, null, 2).length);
    assert.deepEqual(steps, ['fsync:file', 'rename', 'fsync:directory', 'fsync:file', 'logged']);
    assert.equal(fs.statSync(store.filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(eventsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
});

test('paper ledgers and default atomic JSON retain their readable formatting', t => {
    const { store } = fixture(t, 'paper');
    store.save();
    assert.equal(fs.readFileSync(store.filename, 'utf8'), JSON.stringify(store.state, null, 2));
    const manifest = path.join(store.directory, 'manifest.json');
    const data = { identity: { version: 1 }, history: [{ id: 'first' }] };
    atomicJson(manifest, data);
    assert.equal(fs.readFileSync(manifest, 'utf8'), JSON.stringify(data, null, 2));
});

test('failed pilot file sync preserves the previous ledger and does not publish an event', t => {
    const { settings, store, eventsFile } = fixture(t);
    store.save();
    const previous = fs.readFileSync(store.filename, 'utf8');
    store.state.position = { phase: 'reserved', market: { slug: 'next-market' } };
    let logged = false;
    store.logger = () => { logged = true; };
    t.mock.method(fs, 'fsyncSync', () => { throw new Error('simulated file sync failure'); });

    assert.throws(() => store.event('entry_reserved'), /simulated file sync failure/);

    assert.equal(fs.readFileSync(store.filename, 'utf8'), previous);
    assert.equal(new Store(settings, 'pilot', 'late-entry').state.position, null);
    assert.equal(fs.existsSync(eventsFile), false);
    assert.equal(logged, false);
});

test('failed pilot directory sync is reported before the event can be acknowledged', t => {
    const { settings, store, eventsFile } = fixture(t);
    store.save();
    store.state.position = { phase: 'reserved', market: { slug: 'next-market' } };
    let logged = false;
    store.logger = () => { logged = true; };
    const fsync = fs.fsyncSync;
    t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.fstatSync(fd).isDirectory()) throw new Error('simulated directory sync failure');
        fsync(fd);
    });

    assert.throws(() => store.event('entry_reserved'), /simulated directory sync failure/);

    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state, store.state);
    assert.equal(fs.existsSync(eventsFile), false);
    assert.equal(logged, false);
});

test('telemetry events defer full JSON rewrites while durability-syncing JSONL until flush or heartbeat', t => {
    const { settings, store, eventsFile } = fixture(t);
    store.save();
    let ledgerSaves = 0;
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === store.filename) ledgerSaves++;
        rename(from, to);
    });
    const fsync = fs.fsyncSync;
    let fileSyncs = 0;
    t.mock.method(fs, 'fsyncSync', fd => {
        if (!fs.fstatSync(fd).isDirectory()) fileSyncs++;
        fsync(fd);
    });

    const eventsBefore = store.state.events;
    store.event('read_failed', { error: { category: 'timeout', stage: 'rpc_primary', httpStatus: '-' } });
    store.event('laya_book_status', { slug: 'btc-updown-5m-1', connected: true });
    store.event('laya_slot_skipped', { key: 'btc-updown-5m-1:90', reason: 'slot_late' });
    store.event('provider_preflight', { ready: true });
    store.event('laya_snapshot', { snapshotId: 'snap-1', slug: 'btc-updown-5m-1' });
    store.event('laya_decision', { snapshotId: 'snap-1', action: 'SKIP' });
    store.event('laya_entry_disposition', { snapshotId: 'snap-1', reason: 'entry_cost_above_cap' });
    store.saveDeferred();

    assert.equal(ledgerSaves, 0);
    assert.equal(fileSyncs, 7);
    assert.equal(store.dirty, true);
    assert.equal(store.state.events, eventsBefore + 7);
    assert.equal(store.state.operational.errors['rpc_primary:timeout:-'], 1);
    const jsonlRows = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(jsonlRows.length, 7);
    assert.equal(new Store(settings, 'pilot', 'late-entry').state.events, eventsBefore);

    store.event('heartbeat', { cash: 20 });
    assert.equal(ledgerSaves, 1);
    assert.equal(store.dirty, false);
    assert.equal(new Store(settings, 'pilot', 'late-entry').state.events, store.state.events);

    store.saveDeferred();
    assert.equal(store.dirty, true);
    store.flush();
    assert.equal(ledgerSaves, 2);
    assert.equal(store.dirty, false);
    store.flush();
    assert.equal(ledgerSaves, 2);
});

test('provider_probe stays deferred only when unpersisted, while non-probe holds and exposed events stay synchronous', t => {
    const { settings, store } = fixture(t);
    store.save();
    let ledgerSaves = 0;
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === store.filename) ledgerSaves++;
        rename(from, to);
    });

    store.state.entryHolds = { provider_probe: { retryable: true, firstAt: 1, failedAt: 1, retryAt: 2 } };
    store.event('live_entry_hold', { key: 'provider_probe', retryable: true });
    delete store.state.entryHolds.provider_probe;
    store.event('live_entry_hold_recovered', { key: 'provider_probe', proof: 'probe_finished' });
    assert.equal(ledgerSaves, 0);

    // If an intervening durable save wrote provider_probe to disk, clearing it must flush disk too.
    store.state.entryHolds.provider_probe = { retryable: true, firstAt: 2, failedAt: 2, retryAt: 3 };
    store.save();
    assert.equal(ledgerSaves, 1);
    delete store.state.entryHolds.provider_probe;
    store.event('live_entry_hold_recovered', { key: 'provider_probe', proof: 'probe_finished' });
    assert.equal(ledgerSaves, 2);
    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state.entryHolds, {});

    // Non-probe hold always saves durably.
    store.state.entryHolds.clock = { retryable: true, firstAt: 3, failedAt: 3, retryAt: 8 };
    store.event('live_entry_hold', { key: 'clock', retryable: true });
    assert.equal(ledgerSaves, 3);

    // Post-reservation disposition always saves durably.
    store.state.position = { market: { slug: 'btc-updown-5m-2' }, holdings: [0, 0], orders: [] };
    store.event('laya_entry_disposition', { snapshotId: 'snap-2', reason: 'order_rejected' });
    assert.equal(ledgerSaves, 4);
});

test('compactLiveAiHistory archives cold slots and snapshots safely while preserving epoch indices and recovery invariants', t => {
    const { settings, store, eventsFile } = fixture(t);
    const now = 1_800_000_000_000;
    const oldOpenSec = Math.floor((now - 10_800_000) / 1000);
    const freshOpenSec = Math.floor((now - 600_000) / 1000);

    const slots = {};
    for (let i = 0; i < 60; i++) {
        slots[`btc-updown-5m-${oldOpenSec - i * 300}:90`] = { at: (oldOpenSec - i * 300) * 1000, status: 'invalid', snapshotId: `old-snap-slot-${i}` };
    }
    slots[`btc-updown-5m-${freshOpenSec}:90`] = { at: freshOpenSec * 1000, status: 'observed', snapshotId: 'fresh-snap-slot' };
    slots['custom-non-matching:90'] = { at: now - 20_000_000, status: 'observed' };
    slots[`btc-updown-5m-${oldOpenSec - 999 * 300}:60`] = { at: 1000, status: 'observed', snapshotId: 'protected-uncertain-snap' };

    const snapshots = [];
    for (let i = 0; i < 40; i++) {
        const sid = i === 5 ? 'protected-uncertain-snap' : `snap-${i}`;
        snapshots.push({
            snapshotId: sid,
            market: `btc-updown-5m-${oldOpenSec + i * 300}`,
            slot: 90,
            at: i < 35 ? now - 10_000_000 + i * 1000 : now - 120_000 + i * 1000,
            provider: 'eligible',
            model: 'deterministic-eligible-v1',
            strategyEpochId: i < 10 ? 'epoch-a' : 'epoch-b',
            inputHash: `hash-${i}`,
            entryDisposition: 'entry_cost_above_cap',
            input: 'x'.repeat(500),
            decision: { action: 'SKIP', big: 'y'.repeat(500) },
        });
    }

    Object.assign(store.state, {
        decisionProvider: 'eligible',
        ai: { providers: {}, slots, snapshots, sourceExperiment: 'eligible-live-v1' },
        strategyEpochs: [
            { id: 'epoch-a', startedAt: 1000, runtimeId: 'r1', policy: { entryFilter: { maxCostPerShare: 0.82 } }, cashAtStart: 10, firstCompletedIndex: 0, firstSnapshotIndex: 0 },
            { id: 'epoch-b', startedAt: 2000, runtimeId: 'r2', policy: { entryFilter: { maxCostPerShare: 0.82 } }, cashAtStart: 12, firstCompletedIndex: 1, firstSnapshotIndex: 10 },
        ],
        currentStrategyEpochId: 'epoch-b',
        completed: [
            { slug: 'm1', traded: true, pnl: 1.5, entrySignal: { snapshotId: 'snap-2' } },
            { slug: 'm2', traded: true, pnl: -0.5, entrySignal: { snapshotId: 'snap-12', strategyEpochId: 'epoch-b' } },
            { slug: 'm3', traded: true, pnl: 0.25, uncertain: true, entrySignal: { snapshotId: 'protected-uncertain-snap', strategyEpochId: 'epoch-a' } },
        ],
    });
    store.save();

    const config = { policy: { entryFilter: { maxCostPerShare: 0.82 } }, paperEvidence: {} };
    const summaryBefore = eligibleStrategySummary(store.state, config);

    // Blocked when position/stop/withdrawal/provider invalid
    store.state.position = { market: { slug: 'open' }, holdings: [0, 0], orders: [] };
    assert.deepEqual(compactLiveAiHistory(store, { now }), { archivedSlots: 0, archivedSnapshots: 0 });
    store.state.position = null;
    store.state.stopped = { reason: 'operational_check_failed', at: now };
    assert.deepEqual(compactLiveAiHistory(store, { now }), { archivedSlots: 0, archivedSnapshots: 0 });
    store.state.stopped = null;
    store.state.profitTaking = { pending: { hash: '0x1' } };
    assert.deepEqual(compactLiveAiHistory(store, { now }), { archivedSlots: 0, archivedSnapshots: 0 });
    store.state.profitTaking = null;

    const result = compactLiveAiHistory(store, { now });
    assert.deepEqual(result, { archivedSlots: 60, archivedSnapshots: 14 });
    assert.equal(store.state.ai.snapshots.length, 40);
    assert.deepEqual(eligibleStrategySummary(store.state, config), summaryBefore);

    // Recent / matching-exclusion / protected items preserved unarchived
    assert.ok(store.state.ai.slots[`btc-updown-5m-${freshOpenSec}:90`]);
    assert.ok(store.state.ai.slots['custom-non-matching:90']);
    assert.ok(store.state.ai.slots[`btc-updown-5m-${oldOpenSec - 999 * 300}:60`]);
    assert.equal(Object.keys(store.state.ai.slots).length, 3);
    assert.equal(store.state.ai.snapshots[5].archived, undefined);
    assert.equal(store.state.ai.snapshots[5].input, 'x'.repeat(500));
    for (let i = 15; i < 40; i++) assert.equal(store.state.ai.snapshots[i].archived, undefined);
    assert.equal(store.state.ai.snapshots[0].archived, true);
    assert.equal(store.state.ai.snapshots[0].input, undefined);
    assert.equal(store.state.ai.snapshots[0].snapshotId, 'snap-0');
    assert.equal(store.state.ai.snapshots[0].strategyEpochId, 'epoch-a');

    const archiveFile = path.join(store.directory, 'late-entry.ai-archive.jsonl');
    assert.equal(fs.statSync(archiveFile).mode & 0o777, 0o600);
    const archivedRows = fs.readFileSync(archiveFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(archivedRows.length, 74);
    assert.equal(archivedRows.filter(r => r.kind === 'slot').length, 60);
    assert.equal(archivedRows.filter(r => r.kind === 'snapshot').length, 14);
    assert.equal(archivedRows.find(r => r.kind === 'snapshot' && r.index === 0).snapshot.input, 'x'.repeat(500));

    const persistedEvents = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(persistedEvents.at(-1).type, 'ai_history_archived');
    assert.deepEqual(new Store(settings, 'pilot', 'late-entry').state.ai.slots, store.state.ai.slots);
    assert.equal(liveHistory(settings).length, 1);

    // Idempotent second run does nothing
    assert.deepEqual(compactLiveAiHistory(store, { now }), { archivedSlots: 0, archivedSnapshots: 0 });
});

test('compactLiveAiHistory rolls back in-memory mutations if durable ledger save fails', t => {
    const { store } = fixture(t);
    const now = 1_800_000_000_000;
    const oldOpenSec = Math.floor((now - 10_800_000) / 1000);
    const snapshots = Array.from({ length: 30 }, (_, i) => ({
        snapshotId: `s-${i}`,
        market: `btc-updown-5m-${oldOpenSec}`,
        slot: 90,
        at: now - 10_000_000 + i * 1000,
        input: 'z'.repeat(100),
    }));
    Object.assign(store.state, {
        decisionProvider: 'eligible',
        ai: {
            providers: {},
            slots: { [`btc-updown-5m-${oldOpenSec}:90`]: { at: oldOpenSec * 1000, status: 'observed' } },
            snapshots,
            sourceExperiment: 'eligible-live-v1',
        },
    });
    store.save();
    const beforeAi = structuredClone(store.state.ai);

    const fsync = fs.fsyncSync;
    let calls = 0;
    t.mock.method(fs, 'fsyncSync', fd => {
        calls++;
        // Call #1 flushes ai-archive.jsonl; Call #2 flushes the tmp ledger file in LiveStore.save().
        if (calls === 2) throw new Error('simulated ledger sync failure');
        fsync(fd);
    });

    assert.throws(() => compactLiveAiHistory(store, { now, force: true }), /simulated ledger sync failure/);
    assert.deepEqual(store.state.ai, beforeAi);
});
