import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, Store } from '../../src/restart/store.js';

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
