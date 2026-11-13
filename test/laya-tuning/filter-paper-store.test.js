import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FilterPaperStore } from '../../src/laya-filter-paper/store.js';
import { publicReader } from '../../src/laya-filter-paper/client.js';
import { ARM_NAMES, loadFilterPaperConfig } from '../../src/laya-filter-paper/config.js';
import { parseArgs, inferenceAvailable, writeReportAsync } from '../../scripts/laya-filter-paper.js';

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filter-paper-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = { id: 'test-period', dataDir: dir, armNames: ARM_NAMES, capital: 20,
        deadline: Number.MAX_SAFE_INTEGER, policy: { paperOnly: true }, sources: [],
        privateKey: 'not-for-manifest', layaUrl: 'http://private.invalid/?token=secret' };
    return { config, store: new FilterPaperStore(config, 1000) };
}

test('independent capital, safe manifest, no inherited deadline and no baseline overwrite', t => {
    const { config, store } = fixture(t);
    assert.equal(Object.keys(store.state.arms).length, 5);
    for (const arm of Object.values(store.state.arms)) assert.equal(arm.cash, 20);
    store.freeze(Date.parse('2026-10-20'));
    assert.equal(store.state.frozenAt, null);
    const manifest = fs.readFileSync(path.join(store.dir, 'manifest.json'), 'utf8');
    assert.ok(!manifest.includes('not-for-manifest') && !manifest.includes('token='));
    assert.throws(() => new FilterPaperStore({ ...config, id: 'changed' }), /baseline_changed/);
    fs.unlinkSync(store.filename);
    assert.throws(() => new FilterPaperStore(config), /ledger_missing/);
});

test('restart cancels unexecuted virtual attempt but preserves fill, stop and unknown inference', t => {
    const { config, store } = fixture(t);
    store.state.arms.laya.position = { status: 'pending', market: { slug: 'market-a' } };
    const held = store.state.arms['model-edge'];
    held.position = { status: 'filled', shares: 3, market: { slug: 'market-b' } };
    held.cash = 17.2; held.peak = 24; held.drawdown = 10.1; held.stopped = { reason: 'drawdown_limit', at: 1500 };
    held.shadowStop = { at: 1400 }; held.seen['market-b'] = { at: 1300 };
    store.state.providers.laya = { pending: { snapshotId: 's', startedAt: 1500 } };
    store.save();
    const resumed = new FilterPaperStore(config, 2000).state;
    assert.equal(resumed.arms.laya.position, null);
    assert.ok(resumed.arms.laya.seen['market-a']);
    assert.deepEqual(resumed.arms['model-edge'], held);
    assert.equal(resumed.providers.laya.disabled, 'restart_with_unknown_inference');
});

test('paper reader exposes reads only and blocks underlying financial operations', async () => {
    let raw;
    class FakeClient {
        constructor() { raw = this; this.btc = {}; this.clock = { at: 100 }; }
        market() {} books() {} payout() {} serverTime() {} tickSize() {} startBtcFeed() {} btcStatus() {} close() {}
    }
    const reader = publicReader({}, () => {}, FakeClient);
    assert.ok(Object.isFrozen(reader));
    assert.deepEqual(reader.clock, { at: 100 }); raw.clock = { at: 200 }; assert.equal(reader.clock.at, 200);
    for (const name of ['prepare', 'post', 'cancel', 'prepareAction', 'broadcastAction']) {
        assert.equal(reader[name], undefined);
        await assert.rejects(raw[name](), /paper_transaction_forbidden/);
    }
    for (const name of ['authenticate', 'secure', 'privateKey', 'ordersAndTrades', 'walletHealth']) assert.equal(reader[name], undefined);
});

test('CLI rejects live/reset flags and requires explicit independent directory', () => {
    assert.equal(parseArgs(['run', '--out=/tmp/paper-test']).command, 'run');
    for (const args of [['live'], ['run'], ['run', '--out=relative'], ['run', '--out=/tmp/a', '--reset'],
        ['run', '--out=/tmp/a', '--out=/tmp/b'], ['report', '--out=/tmp/a', '--smoke']]) assert.throws(() => parseArgs(args));
});

test('inference yields when competing service active or status unknown', async () => {
    assert.equal(await inferenceAvailable(async () => ({ stdout: 'inactive\ninactive\nfailed\n' })), true);
    for (const stdout of ['active\ninactive\ninactive', 'activating\ninactive\ninactive', 'inactive'])
        assert.equal(await inferenceAvailable(async () => ({ stdout })), false);
    assert.equal(await inferenceAvailable(async () => { throw new Error('timeout'); }), false);
});

test('config pins model-edge baseline, prompt, source and no deadline without leaking env', t => {
    const { config: fixtureConfig } = fixture(t);
    const config = loadFilterPaperConfig({ PRIVATE_KEY: 'not-for-manifest' }, fixtureConfig.dataDir);
    assert.equal(config.deadline, Number.MAX_SAFE_INTEGER);
    assert.equal(config.policy.deadline, null);
    assert.equal(config.decisionProtocol.variantId, 'candidate-v2');
    assert.equal(config.modelEdgePolicy.minMarginUsd, 5);
    assert.equal(config.modelEdgePolicy.minZ, 1.5);
    assert.equal(config.modelEdgePolicy.minModelEdge, .05);
    assert.equal(config.control.minDays, 7);
    assert.equal(config.policy.schema, 3);
    assert.equal(config.decisionTimeoutPolicy, 'snapshot-freshness-budget-v1');
    assert.equal(config.inferenceReserveMs, 150);
    assert.equal(config.dataAgeMs - config.decisionMs - config.latencyMs - config.inferenceReserveMs, 1600);
    assert.equal(config.reportMs, 60000);
    assert.ok(config.sources.some(([file]) => file === 'src/laya-filter-paper/engine.js'));
    assert.ok(!JSON.stringify(config.policy).includes('not-for-manifest'));
});

test('report worker reads durable ledger and leaves trading state untouched', async t => {
    const { config, store } = fixture(t);
    const before = fs.readFileSync(store.filename, 'utf8');
    const result = await writeReportAsync(config);
    assert.equal(result.id, config.id);
    assert.equal(fs.readFileSync(store.filename, 'utf8'), before);
    const report = JSON.parse(fs.readFileSync(path.join(store.dir, 'reports/latest.json')));
    assert.equal(report.paperOnly, true);
    assert.equal(report.sufficientForLive, false);
    assert.equal(report.arms.laya.cash, 20);
});
