import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilterPaperStore } from '../../src/laya-filter-paper/store.js';
import { ARM_NAMES } from '../../src/laya-filter-paper/config.js';
import { archivePaperPeriod, linkPaperHistory } from '../../src/laya-filter-paper/period.js';
import { atomicJson } from '../../src/restart/store.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-period-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = { dataDir, id: 'v1', capital: 20, armNames: ARM_NAMES, policy: {}, sources: [] };
    return { config, store: new FilterPaperStore(config, 1000) };
}

test('archive preserves cash, historical losses and source ledger without copying them into new period', t => {
    const { config, store } = fixture(t);
    store.state.arms.laya.cash = 14; store.state.arms.laya.drawdown = 8;
    store.state.arms.laya.completed.push({ slug: 'ended', pnl: -6 });
    store.state.arms.laya.stopped = { at: 2000, reason: 'research_drawdown_limit' }; store.save();
    const before = fs.readFileSync(store.filename);
    const result = archivePaperPeriod(config.dataDir, 'execution_comparability_fix', 3000);
    assert.ok(fs.readFileSync(path.join(store.dir, 'ledger-before-archive.json')).equals(before));
    const archived = JSON.parse(fs.readFileSync(store.filename));
    assert.deepEqual(archived.arms, store.state.arms);
    assert.equal(archived.frozenAt, 3000); assert.equal(result.results.laya.pnl, -6);
    fs.unlinkSync(path.join(store.dir, 'archive.json'));
    assert.deepEqual(archivePaperPeriod(config.dataDir, 'execution_comparability_fix', 4000), result);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.dir, 'archive.json'))), result);
    assert.throws(() => new FilterPaperStore(config), /identity_mismatch/);
    const next = path.join(config.dataDir, 'next-period');
    linkPaperHistory(next, result); linkPaperHistory(next, result);
    assert.equal(JSON.parse(fs.readFileSync(path.join(next, 'history.json'))).periods.length, 1);
    const newStore = new FilterPaperStore({ ...config, id: 'v2', dataDir: next }, 3001);
    assert.equal(newStore.state.arms.laya.cash, 20);
    assert.equal(newStore.state.arms.laya.completed.length, 0);
});

test('archive refuses inventory, pending inference, and unresolved official outcomes', t => {
    const { config, store } = fixture(t);
    for (const status of ['pending', 'matched', 'filled']) {
        store.state.arms.laya.position = { status }; store.save();
        assert.throws(() => archivePaperPeriod(config.dataDir, 'new_period', 3000), /inventory_open/);
    }
    store.state.arms.laya.position = null;
    store.state.providers.laya = { pending: { snapshotId: 'test' } }; store.save();
    assert.throws(() => archivePaperPeriod(config.dataDir, 'new_period', 3000), /inference_pending/);
    store.state.providers.laya.pending = null;
    store.state.snapshots.push({ snapshotId: 'test', market: 'unresolved' }); store.save();
    assert.throws(() => archivePaperPeriod(config.dataDir, 'new_period', 3000), /labels_pending/);
    assert.equal(fs.existsSync(path.join(store.dir, 'ledger-before-archive.json')), false);
});

test('archive validates identity and retry backup before mutation', t => {
    const { config, store } = fixture(t);
    assert.throws(() => archivePaperPeriod(config.dataDir, '../bad', 3000), /invalid_paper_archive/);
    atomicJson(path.join(config.dataDir, 'active.json'), { id: '../escape' });
    assert.throws(() => archivePaperPeriod(config.dataDir, 'new_period', 3000), /identity_invalid/);
    atomicJson(path.join(config.dataDir, 'active.json'), { id: config.id });
    fs.copyFileSync(store.filename, path.join(store.dir, 'ledger-before-archive.json'));
    assert.equal(archivePaperPeriod(config.dataDir, 'new_period', 3000).id, config.id);
    assert.throws(() => linkPaperHistory('relative', { id: 'v1', dataDir: config.dataDir, archivedAt: 3000 }), /link_invalid/);
});
