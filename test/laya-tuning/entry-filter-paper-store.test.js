import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EntryFilterPaperStore } from '../../src/entry-filter-paper/store.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-filter-store-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const log = t.mock.method(console, 'log', () => {});
    const config = { id: 'entry-store-period', dataDir, armNames: ['eligible', 'combined'], capital: 20,
        policy: { paperOnly: true }, sources: [], deadline: Number.MAX_SAFE_INTEGER };
    const store = new EntryFilterPaperStore(config, 1000);
    const eventFile = path.join(store.dir, 'events.jsonl');
    return { config, store, log, eventFile,
        ledger: () => JSON.parse(fs.readFileSync(store.filename, 'utf8')),
        events: () => fs.readFileSync(eventFile, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('feed diagnostics append immediately without rewriting the ledger and heartbeat checkpoints error counters', t => {
    const { store, ledger, events, eventFile, log } = fixture(t);
    const before = fs.readFileSync(store.filename, 'utf8');
    const save = t.mock.method(store, 'save', store.save.bind(store));
    const telemetry = ['book_gap', 'book_ordering_recovered', 'book_stream_open', 'book_message_rejected',
        'book_reconnect_scheduled', 'book_tick_changed', 'btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected'];
    for (let i = 0; i < 10; i++) store.eventBatch(telemetry.map(type => ({ type, detail: { generation: i } })));
    store.error('snapshot', new Error('http://private.invalid?token=secret'));
    assert.equal(save.mock.callCount(), 0);
    assert.equal(fs.readFileSync(store.filename, 'utf8'), before);
    assert.equal(events().length, 91);
    assert.equal(events()[0].type, 'book_gap');
    assert.equal(events()[0].id, store.config.id);
    assert.equal(events()[0].at, events()[8].at);
    assert.equal(fs.statSync(eventFile).mode & 0o077, 0);
    assert.deepEqual(store.state.errors, { 'snapshot:Error': 1 });
    assert.ok(!fs.readFileSync(eventFile, 'utf8').includes('secret'));
    assert.ok(!JSON.stringify(log.mock.calls).includes('secret'));

    store.state.lastHeartbeatAt = 61000;
    store.event('heartbeat', { clockFresh: true });
    assert.equal(save.mock.callCount(), 1);
    assert.equal(ledger().lastHeartbeatAt, 61000);
    assert.deepEqual(ledger().errors, { 'snapshot:Error': 1 });
    store.error('book', { code: 'quote_timeout' });
    store.save();
    assert.deepEqual(ledger().errors, { 'snapshot:Error': 1, 'book:quote_timeout': 1 });
});

test('decision and reservation batch commits once before logging and restart preserves deduplication', t => {
    const { store, config, ledger, events } = fixture(t);
    const snapshot = { snapshotId: 'snapshot-a', market: 'market-a', decisions: {},
        sharedDecision: { status: 'ok', action: 'BUY_UP' }, filterVerdicts: { BUY_UP: { combined: { pass: true } } } };
    store.state.snapshots.push(snapshot);
    for (const name of config.armNames) {
        snapshot.decisions[name] = { status: 'ok', action: 'BUY_UP', entryDisposition: 'reserved' };
        store.state.arms[name].seen[snapshot.market] = { snapshotId: snapshot.snapshotId, at: 1100 };
        store.state.arms[name].position = { snapshotId: snapshot.snapshotId, status: 'pending', market: { slug: snapshot.market } };
    }
    const save = t.mock.method(store, 'save', store.save.bind(store));
    const originalAppend = fs.appendFileSync;
    const append = t.mock.method(fs, 'appendFileSync', (...args) => {
        assert.equal(ledger().snapshots[0].decisions.combined.entryDisposition, 'reserved');
        assert.equal(ledger().arms.eligible.position.status, 'pending');
        return originalAppend(...args);
    });
    store.eventBatch([{ type: 'snapshot', detail: { snapshotId: snapshot.snapshotId } },
        { type: 'decision', detail: snapshot.sharedDecision }, { type: 'book_gap', detail: { generation: 2 } }]);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(append.mock.callCount(), 1);
    assert.deepEqual(events()[0].filterVerdicts, snapshot.filterVerdicts);
    append.mock.restore();

    const resumed = new EntryFilterPaperStore(config, 2000);
    for (const name of config.armNames) {
        assert.equal(resumed.state.arms[name].position, null);
        assert.equal(resumed.state.arms[name].seen[snapshot.market].snapshotId, snapshot.snapshotId);
        assert.equal(resumed.state.arms[name].outcomes[snapshot.market].reason, 'restart_during_pending_execution');
        assert.equal(resumed.state.snapshots[0].decisions[name].entryDisposition, 'reserved');
    }
    assert.deepEqual(new EntryFilterPaperStore(config, 3000).state.arms, resumed.state.arms);
});

test('fills, settlement balances and risk stops remain durable across repeated restart', t => {
    const { store, config, ledger } = fixture(t);
    const held = store.state.arms.eligible, settled = store.state.arms.combined;
    held.cash = 17.5;
    held.seen['market-a'] = { snapshotId: 'snapshot-a' };
    held.position = { snapshotId: 'snapshot-a', status: 'filled', holdings: 5, entryCost: 2.5,
        market: { slug: 'market-a' } };
    settled.cash = 9; settled.drawdown = 11;
    settled.stopped = { at: 1100, reason: 'drawdown_limit' };
    settled.shadowStop = { at: 1000, reason: 'shadow_drawdown_limit' };
    settled.seen['market-b'] = { snapshotId: 'snapshot-b' };
    settled.outcomes['market-b'] = { snapshotId: 'snapshot-b', pnl: -11, reason: 'settled' };
    settled.completed.push({ slug: 'market-b', snapshotId: 'snapshot-b', pnl: -11 });
    const expected = structuredClone(store.state.arms);
    store.eventBatch([{ type: 'fill_settled', detail: { arm: 'eligible' } },
        { type: 'official_settlement', detail: { arm: 'combined' } }, { type: 'risk_threshold', detail: { arm: 'combined' } }]);
    assert.deepEqual(ledger().arms, expected);
    assert.deepEqual(new EntryFilterPaperStore(config, 2000).state.arms, expected);
    assert.deepEqual(new EntryFilterPaperStore(config, 3000).state.arms, expected);
});

test('snapshot-only and unrecognized events keep the default durable commit path', t => {
    const { store, config, ledger } = fixture(t);
    store.state.snapshots.push({ snapshotId: 'before-decision', market: 'market-a', decisions: {} });
    store.event('snapshot', { snapshotId: 'before-decision' });
    assert.equal(ledger().snapshots.length, 1);
    const resumed = new EntryFilterPaperStore(config, 2000);
    assert.equal(resumed.state.snapshots[0].sharedDecision.status, 'restart_before_decision');
    assert.equal(resumed.state.snapshots[0].decisions.eligible.entryDisposition, 'no_buy_decision');
    resumed.state.arms.eligible.cash = 19;
    resumed.event('future_state_event');
    assert.equal(ledger().arms.eligible.cash, 19);
});

test('skipped opportunities still commit unique counters and slot state together', t => {
    const { store, config, ledger } = fixture(t);
    const detail = { slug: 'market-a', slot: 90, reasons: ['book_stale', 'book_stale'] };
    store.state.slots['market-a:90'] = { status: 'no_valid_side' };
    store.eventBatch([{ type: 'book_gap' }, { type: 'opportunity_skipped', detail }]);
    const resumed = new EntryFilterPaperStore(config, 2000);
    resumed.event('opportunity_skipped', detail);
    assert.equal(ledger().opportunitySkips.total, 1);
    assert.equal(ledger().slots['market-a:90'].status, 'no_valid_side');
});

test('telemetry logging failures are sanitized without claiming a ledger commit', t => {
    const { store, ledger } = fixture(t);
    t.mock.method(fs, 'appendFileSync', () => { throw new Error('private-path?token=secret'); });
    assert.throws(() => store.error('valuation', new Error('private-path?token=secret')), error => {
        assert.equal(error.message, 'paper_event_log_failed');
        assert.notEqual(error.durableStateCommitted, true);
        assert.ok(!JSON.stringify(error).includes('secret'));
        return true;
    });
    assert.deepEqual(ledger().errors, {});
    assert.deepEqual(store.state.errors, { 'valuation:Error': 1 });
});

test('console failure after a financial commit keeps the sanitized committed-state marker', t => {
    const { store, config, ledger, events, log } = fixture(t);
    log.mock.restore();
    t.mock.method(console, 'log', () => { throw new Error('private-console?token=secret'); });
    store.state.arms.eligible.cash = 18;
    assert.throws(() => store.event('matched', { arm: 'eligible' }), error => {
        assert.equal(error.message, 'paper_event_log_failed');
        assert.equal(error.durableStateCommitted, true);
        assert.ok(!JSON.stringify(error).includes('secret'));
        return true;
    });
    assert.equal(events()[0].type, 'matched');
    assert.equal(ledger().arms.eligible.cash, 18);
    assert.equal(new EntryFilterPaperStore(config, 2000).state.arms.eligible.cash, 18);
});

test('failed state commit emits neither financial nor mixed telemetry events', t => {
    const { store, eventFile, ledger } = fixture(t);
    store.event('book_gap');
    const before = fs.readFileSync(eventFile, 'utf8');
    store.state.arms.eligible.cash = 18;
    t.mock.method(store, 'save', () => { throw new Error('save_failed'); });
    assert.throws(() => store.eventBatch([{ type: 'book_gap' }, { type: 'matched' }]), /save_failed/);
    assert.equal(fs.readFileSync(eventFile, 'utf8'), before);
    assert.equal(ledger().arms.eligible.cash, 20);
});
