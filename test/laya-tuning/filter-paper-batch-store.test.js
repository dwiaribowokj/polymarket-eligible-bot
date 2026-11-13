import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilterPaperStore } from '../../src/laya-filter-paper/store.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-paper-batch-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    t.mock.method(console, 'log', () => {});
    const config = { id: 'batch-period', dataDir, armNames: ['laya', 'combined'], capital: 20,
        policy: { paperOnly: true }, sources: [], deadline: Number.MAX_SAFE_INTEGER };
    const store = new FilterPaperStore(config, 1000);
    return { config, store, ledger: () => JSON.parse(fs.readFileSync(store.filename, 'utf8')) };
}

test('one opportunity per slot survives repeats, batched duplicate events and restart with per-side reasons', t => {
    const { config, store, ledger } = fixture(t);
    const detail = { slug: 'market-a', slot: 90, reasons: ['book_stale', 'book_stale'] };
    store.state.slots['market-a:90'] = { status: 'no_valid_side' };
    store.eventBatch([{ type: 'opportunity_skipped', detail }, { type: 'opportunity_skipped', detail }]);
    store.event('opportunity_skipped', detail);
    const resumed = new FilterPaperStore(config, 2000);
    resumed.event('opportunity_skipped', detail);
    resumed.event('opportunity_skipped', { slug: 'market-a', slot: 60, slotKey: 'market-a:60',
        sideReasons: { UP: 'spread_too_wide', DOWN: 'book_stale' } });
    const skips = ledger().opportunitySkips;
    assert.equal(skips.total, 2);
    assert.equal(skips.complete, true);
    assert.deepEqual(skips.byReason, { book_stale: 2, spread_too_wide: 1 });
    assert.deepEqual(skips.bySide, { UP: { book_stale: 1, spread_too_wide: 1 }, DOWN: { book_stale: 2 } });
    assert.equal(Object.keys(skips.slots).length, 2);
});

test('legacy ledger does not acquire fabricated historical skip counters on restart', t => {
    const { config, store, ledger } = fixture(t);
    delete store.state.opportunitySkips;
    store.state.slots['old-market:90'] = { status: 'no_valid_side' };
    store.save();
    const resumed = new FilterPaperStore(config, 2000);
    assert.equal(resumed.state.opportunitySkips, undefined);
    resumed.event('opportunity_skipped', { slug: 'new-market', slot: 90, reasons: ['book_stale', 'book_stale'] });
    assert.equal(ledger().opportunitySkips.complete, false);
    assert.equal(ledger().opportunitySkips.total, 1);
});

test('event batch commits all arm changes once before appending a single payload', t => {
    const { store, ledger } = fixture(t);
    store.state.arms.laya.cash = 18;
    store.state.arms.combined.cash = 17;
    const save = t.mock.method(store, 'save', store.save.bind(store));
    const originalAppend = fs.appendFileSync;
    const append = t.mock.method(fs, 'appendFileSync', (...args) => {
        assert.equal(ledger().arms.laya.cash, 18);
        assert.equal(ledger().arms.combined.cash, 17);
        return originalAppend(...args);
    });
    store.eventBatch([{ type: 'matched', detail: { arm: 'laya' } }, { type: 'matched', detail: { arm: 'combined' } }]);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(append.mock.callCount(), 1);
    const events = fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(events.map(row => row.arm), ['laya', 'combined']);
    assert.equal(events[0].at, events[1].at);
    assert.equal(fs.statSync(path.join(store.dir, 'events.jsonl')).mode & 0o077, 0);
});

test('log write failure reports a sanitized committed-state marker and preserves every financial mutation', t => {
    const { config, store, ledger } = fixture(t);
    store.state.arms.laya.cash = 18;
    store.state.arms.combined.cash = 17;
    t.mock.method(fs, 'appendFileSync', () => { throw new Error('private-path?token=secret'); });
    assert.throws(() => store.eventBatch([{ type: 'matched', detail: { arm: 'laya' } },
        { type: 'matched', detail: { arm: 'combined' } }]), error => {
        assert.equal(error.message, 'paper_event_log_failed');
        assert.equal(error.durableStateCommitted, true);
        assert.ok(!JSON.stringify(error).includes('secret'));
        return true;
    });
    assert.equal(ledger().arms.laya.cash, 18);
    assert.equal(ledger().arms.combined.cash, 17);
    const resumed = new FilterPaperStore(config, 2000);
    assert.equal(resumed.state.arms.laya.cash, 18);
    assert.equal(resumed.state.arms.combined.cash, 17);
});

test('failed ledger commit emits no events and error telemetry keeps private messages out of the ledger', t => {
    const { store, ledger } = fixture(t);
    store.error('snapshot', new Error('http://private.invalid?token=secret'));
    assert.deepEqual(ledger().errors, { 'snapshot:Error': 1 });
    assert.ok(!fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8').includes('secret'));
    const before = fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8');
    t.mock.method(store, 'save', () => { throw new Error('save_failed'); });
    assert.throws(() => store.eventBatch([{ type: 'matched', detail: { arm: 'laya' } }]), /save_failed/);
    assert.equal(fs.readFileSync(path.join(store.dir, 'events.jsonl'), 'utf8'), before);
});
