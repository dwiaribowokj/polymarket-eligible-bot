import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ValueCollectorStore } from '../../src/value-collector/store.js';

const OPEN = 1794632400000;
const CONDITION = `0x${'1'.repeat(64)}`;
const SLUG = `btc-updown-5m-${OPEN / 1000}`;
const observation = (offset = 210000, changes = {}) => ({ id: `${SLUG}:${OPEN + offset}`,
    slug: SLUG, marketEnd: OPEN + 300000, conditionId: CONDITION,
    scheduledAt: OPEN + offset, at: OPEN + offset + 100, status: 'ready',
    features: { opening: 81000, bids: { UP: [[0.7, 20]], DOWN: [[0.29, 10]] } }, ...changes });
const label = (changes = {}) => ({ conditionId: CONDITION, slug: SLUG, marketEnd: OPEN + 300000,
    at: OPEN + 360000, official: true, source: 'ctf_payout', payout: [1, 0], outcome: 'UP', ...changes });

function fixture(t, policy = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'value-collector-store-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { id: 'collector-period', policy: { readOnly: true, slots: [90, 60, 30], ...policy },
        sources: [['collector.js', 'source-sha']], dataDir };
    const store = new ValueCollectorStore(config);
    return { config, store };
}

test('observation publication is immutable, private, and idempotent across key ordering', t => {
    const { store } = fixture(t), row = observation();
    assert.equal(store.recordObservation(row), true);
    const filename = store.observationFilename(row), bytes = fs.readFileSync(filename, 'utf8');
    assert.equal(store.recordObservation(Object.fromEntries(Object.entries(row).reverse())), false);
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
    assert.throws(() => store.recordObservation({ ...row, status: 'partial' }), /collector_record_conflict/);
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
    assert.equal(store.state.counts.observations, 1);
    assert.deepEqual(store.state.counts.statuses, { ready: 1, partial: 0, missed: 0 });
    assert.equal(store.state.lastSlotAt, row.scheduledAt);
    for (const item of [store.directory, path.dirname(filename)]) assert.equal(fs.statSync(item).mode & 0o077, 0);
    for (const item of [filename, store.filename, path.join(store.directory, 'manifest.json')])
        assert.equal(fs.statSync(item).mode & 0o077, 0);
});

test('roundtrip preserves nested insertion order and externally computed JSON evidence hashes', t => {
    const { store, config } = fixture(t);
    const books = { UP: { timestamp: OPEN, bids: [[0.7, 20]], asks: [[0.71, 10]] },
        DOWN: { timestamp: OPEN, bids: [[0.28, 10]], asks: [[0.29, 20]] } };
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const row = observation(210000, { features: { books, booksHash: hash(books) } });
    store.recordObservation(row);
    const persisted = JSON.parse(fs.readFileSync(store.observationFilename(row), 'utf8'));
    assert.equal(JSON.stringify(persisted.features.books), JSON.stringify(books));
    assert.equal(hash(persisted.features.books), persisted.features.booksHash);
    assert.equal(hash(persisted), hash(row));
    const resumed = new ValueCollectorStore(config);
    assert.equal(resumed.recordObservation(row), false);
    assert.equal(fs.readFileSync(store.observationFilename(row), 'utf8'), `${JSON.stringify(row)}\n`);
});

test('crash after publishing observations before checkpoint restores cursor, coverage and pending labels', t => {
    const { store, config } = fixture(t);
    store.state.clock = { verified: true };
    store.state.health = { readOnly: true };
    store.state.lastTickAt = OPEN;
    store.save();
    store.recordObservation(observation());
    store.recordObservation(observation(240000, { status: 'partial' }));
    store.recordObservation(observation(270000, { status: 'missed', conditionId: null, at: OPEN + 330000 }));
    assert.equal(JSON.parse(fs.readFileSync(store.filename)).counts.observations, 0);
    const resumed = new ValueCollectorStore(config);
    assert.equal(resumed.state.lastSlotAt, OPEN + 270000);
    assert.equal(resumed.state.lastTickAt, OPEN);
    assert.deepEqual(resumed.state.counts.statuses, { ready: 1, partial: 1, missed: 1 });
    assert.deepEqual(resumed.state.clock, { verified: true });
    assert.deepEqual(resumed.state.health, { readOnly: true });
    assert.deepEqual(Object.keys(resumed.state.pending), [CONDITION]);
    assert.equal(resumed.state.pending[CONDITION].firstObservedAt, OPEN + 210100);
    assert.equal(resumed.recordObservation(observation()), false);
    assert.equal(resumed.state.counts.observations, 3);
});

test('cursor checkpoint cannot hide an observation never durably published', t => {
    const { store, config } = fixture(t);
    store.recordObservation(observation());
    store.state.lastSlotAt = OPEN + 295000;
    store.save();
    assert.equal(new ValueCollectorStore(config).state.lastSlotAt, OPEN + 210000);
});

test('crash after official label publication removes stale pending state without rewriting feature bytes', t => {
    const { store, config } = fixture(t), row = observation();
    store.recordObservation(row);
    store.save();
    const filename = store.observationFilename(row), bytes = fs.readFileSync(filename, 'utf8');
    assert.equal(store.recordLabel(label()), true);
    assert.equal(JSON.parse(fs.readFileSync(store.filename)).counts.labels, 0);
    assert.ok(JSON.parse(fs.readFileSync(store.filename)).pending[CONDITION]);
    const resumed = new ValueCollectorStore(config);
    assert.equal(resumed.state.counts.labels, 1);
    assert.deepEqual(resumed.state.pending, {});
    assert.equal(fs.readFileSync(filename, 'utf8'), bytes);
    assert.equal(resumed.recordLabel(label()), false);
    assert.throws(() => resumed.recordLabel(label({ outcome: 'DOWN', payout: [0, 1] })), /collector_record_conflict/);
    assert.equal(resumed.state.counts.labels, 1);
    assert.equal(fs.statSync(resumed.labelFilename(CONDITION)).mode & 0o077, 0);
});

test('pending includes partial observations and later observations do not reopen officially labeled markets', t => {
    const { store, config } = fixture(t);
    store.recordObservation(observation(210000, { status: 'partial', features: null }));
    assert.ok(store.state.pending[CONDITION]);
    store.recordLabel(label());
    store.recordObservation(observation(240000, { at: OPEN + 400000, status: 'missed' }));
    assert.deepEqual(store.state.pending, {});
    assert.deepEqual(new ValueCollectorStore(config).state.pending, {});
});

test('manifest rejects policy, source and identity changes instead of silently mixing periods', t => {
    const { store, config } = fixture(t);
    const manifestFile = path.join(store.directory, 'manifest.json'), bytes = fs.readFileSync(manifestFile, 'utf8');
    for (const changed of [{ id: 'other' }, { policy: { ...config.policy, slots: [30] } },
        { sources: [['collector.js', 'different-source-sha']] }])
        assert.throws(() => new ValueCollectorStore({ ...config, ...changed }), /collector_manifest_mismatch/);
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), bytes);
    assert.equal(new ValueCollectorStore(config).state.id, config.id);
});

test('labels require confirmed payout evidence and market identity after settlement', t => {
    const { store } = fixture(t);
    assert.throws(() => store.recordLabel(label()), /collector_label_without_observation/);
    store.recordObservation(observation());
    for (const changes of [{ official: false }, { at: OPEN + 299999 }, { source: 'spot_prediction' },
        { payout: [0.5, 0.4] }, { payout: [1, 1] }, { payout: [-0.1, 1.1] }, { payout: [0, 1] }])
        assert.throws(() => store.recordLabel(label(changes)), /collector_label_invalid/);
    assert.throws(() => store.recordLabel(label({ slug: `btc-updown-5m-${OPEN / 1000 + 300}`,
        marketEnd: OPEN + 600000, at: OPEN + 700000 })), /collector_condition_conflict/);
    assert.equal(store.recordLabel(label({ payout: [0.5, 0.5], outcome: 'SPLIT' })), true);
});

test('invalid paths, slot identities, conditions and non-finite input fail before publication', t => {
    const { store } = fixture(t);
    for (const changes of [{ slug: '../../escape' }, { id: 'duplicate-another-slot' }, { scheduledAt: OPEN - 1 },
        { at: OPEN }, { marketEnd: OPEN + 299999 }, { conditionId: '../../elsewhere' }, { features: { quote: NaN } }])
        assert.throws(() => store.recordObservation(observation(210000, changes)), /collector_/);
    assert.equal(store.state.counts.observations, 0);
    assert.equal(fs.existsSync(path.join(store.directory, 'observations')), false);
});

test('interrupted temporary file is ignored and published corrupt data prevents recovery', t => {
    const { store, config } = fixture(t), row = observation();
    store.recordObservation(row);
    fs.writeFileSync(`${store.observationFilename(row)}.interrupted.tmp`, '{partial', { mode: 0o600 });
    assert.equal(new ValueCollectorStore(config).state.counts.observations, 1);
    fs.writeFileSync(store.observationFilename(row), '{corrupt', { mode: 0o600 });
    assert.throws(() => new ValueCollectorStore(config), SyntaxError);
});

test('counter-only diagnostics whitelist event names and never persist caller messages', t => {
    const { store, config } = fixture(t);
    store.event('btc_feed_failed', { message: 'private?token=never-log-this' });
    assert.throws(() => store.event('private?token=never-log-this'), /collector_event_invalid/);
    assert.deepEqual(store.state.counts.events, { btc_feed_failed: 1 });
    assert.ok(!fs.readFileSync(store.filename, 'utf8').includes('never-log-this'));
    assert.deepEqual(new ValueCollectorStore(config).state.counts.events, { btc_feed_failed: 1 });
});

test('process lock may precede initial manifest but an unmanifested dataset is rejected', t => {
    const { store, config } = fixture(t);
    fs.unlinkSync(path.join(store.directory, 'manifest.json'));
    assert.throws(() => new ValueCollectorStore(config), /collector_manifest_missing/);
    fs.unlinkSync(store.filename);
    fs.writeFileSync(path.join(store.directory, 'value-collector.lock'), '', { mode: 0o600 });
    assert.equal(new ValueCollectorStore(config).state.counts.observations, 0);
});

test('recovery keeps only counters and unresolved identities rather than historical feature arrays', t => {
    const { store, config } = fixture(t);
    store.recordObservation(observation());
    store.recordObservation(observation(240000));
    store.recordLabel(label());
    const resumed = new ValueCollectorStore(config);
    assert.equal(resumed.state.counts.observations, 2);
    assert.equal(resumed.state.counts.labels, 1);
    assert.deepEqual(resumed.state.pending, {});
    const checkpoint = fs.readFileSync(store.filename, 'utf8');
    assert.ok(!checkpoint.includes('opening'));
    assert.ok(!checkpoint.includes('81000'));
    assert.ok(checkpoint.length < 1000);
});

test('storage budget stops new observations and labels while retaining prior bytes and idempotency', t => {
    const row = observation(), budget = Buffer.byteLength(JSON.stringify(row)) + 1;
    const { store, config } = fixture(t, { maxStorageBytes: budget, minFreeBytes: 0 });
    assert.equal(store.recordObservation(row), true);
    assert.equal(store.state.storageBytes, budget);
    assert.equal(store.recordObservation(row), false);
    const bytes = fs.readFileSync(store.observationFilename(row));
    assert.throws(() => store.recordObservation(observation(240000)), /collector_storage_budget_exhausted/);
    assert.throws(() => store.recordLabel(label()), /collector_storage_budget_exhausted/);
    assert.deepEqual(fs.readFileSync(store.observationFilename(row)), bytes);
    assert.equal(store.state.counts.observations, 1);
    assert.equal(store.state.counts.labels, 0);
    const resumed = new ValueCollectorStore(config);
    assert.equal(resumed.state.storageBytes, budget);
    assert.ok(resumed.state.pending[CONDITION]);
    assert.throws(() => resumed.recordObservation(observation(240000)), /collector_storage_budget_exhausted/);
});

test('free-space floor protects the host and is evaluated before creating a record', t => {
    const { store } = fixture(t, { maxStorageBytes: 1_000_000, minFreeBytes: 1024 });
    t.mock.method(fs, 'statfsSync', () => ({ bavail: 1n, bsize: 1024n }));
    assert.throws(() => store.recordObservation(observation()), /collector_storage_budget_exhausted/);
    assert.equal(store.state.storageBytes, 0);
    assert.equal(fs.existsSync(path.join(store.directory, 'observations')), false);
});

test('storage accounting includes label bytes and recovers accurately without checkpoint updates', t => {
    const { store, config } = fixture(t);
    store.recordObservation(observation());
    store.recordLabel(label());
    const expected = fs.statSync(store.observationFilename(observation())).size + fs.statSync(store.labelFilename(CONDITION)).size;
    assert.equal(store.state.storageBytes, expected);
    assert.equal(new ValueCollectorStore(config).state.storageBytes, expected);
});
