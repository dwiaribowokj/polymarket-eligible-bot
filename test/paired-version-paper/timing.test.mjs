import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateTimingArm, loadTimingArm } from '../../scripts/paired-version-paper/timing.mjs';
import { EligibleLiveProvider } from '../../src/eligible-live/provider.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const filter = Object.freeze({ version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.82, gasUsd: 0.05,
    basis: 'full_fill_at_frozen_limit' });
const exec = Object.freeze({ slots: [90, 60, 30], dataAgeMs: 5000, gasUsd: 0.05,
    latencyMs: 250, decisionMs: 3000, inferenceReserveMs: 150 });
const arm = mode => ({ mode, entryFilter: filter, execution: exec, Provider: EligibleLiveProvider });
function fixture() {
    const at = 30000, market = 'btc-test-market', slot = 90;
    const identity = JSON.stringify(['mock', ['100', '200'], 5, [0.01, 0.01], { rate: 0, exponent: 1 }, false]);
    const input = JSON.stringify({ market, allowed: ['BUY_DOWN'], shares: 5, entry_cap: 5, fee_rate: 0, fee_exponent: 1,
        limit_cost_up_down: [null, [75, 3.8]] });
    return { at, market, slot, input, inputHash: digest(input), snapshotId: digest(JSON.stringify({
        slug: market, seconds: slot, now: at, input })).slice(0, 24), model: 'deterministic-eligible-v1', provider: 'eligible',
        entryFilter: { ...filter }, observedAt: 29600, validation: { at: 29900, generation: 7, identity },
        allowed: [{ index: 1, side: 'BUY', tokenId: '200', shares: 5, price: 0.75, cost: 3.8 }],
        decisionRequestedAt: 30320, decisionReceivedAt: 30320, snapshotPersistMs: 300,
        walletReadMs: 1200, walletWaitMs: 430, metadataWarmupMs: 500, walletReadSucceeded: true };
}

test('serial wallet runs beside metadata; only the old persistence delta shifts decision time', async () => {
    const data = fixture();
    const old = await evaluateTimingArm(arm('serial'), data, { oldToNewPersistRatio: 1.5 });
    const current = await evaluateTimingArm(arm('overlap'), data, { oldToNewPersistRatio: 1.5 });
    assert.deepEqual([old.action, current.action, old.index, current.limitPrice], ['BUY_DOWN', 'BUY_DOWN', 1, 0.75]);
    assert.deepEqual([old.decisionAt, old.readyAt], [30470, 32120]);
    assert.deepEqual([current.decisionAt, current.readyAt], [30320, 31120]);
    assert.equal(old.stages.walletCriticalMs, 1200);
    assert.equal(current.stages.walletCriticalMs, 430);
    assert.equal(current.stages.joinAt, 30820); // 500ms metadata is the critical path.
});

test('an earlier arm can fit the freshness budget while serially scheduled reads miss it', async () => {
    const data = { ...fixture(), observedAt: 26700 };
    assert.equal((await evaluateTimingArm(arm('serial'), data)).reason, 'insufficient_execution_headroom');
    assert.equal((await evaluateTimingArm(arm('overlap'), data)).status, 'ready');
});

test('shared decision-to-validation minimum overlaps reads; it is not extra latency', async () => {
    const data = { ...fixture(), snapshotPersistMs: 10, walletReadMs: 20, walletWaitMs: 3, metadataWarmupMs: 5 };
    assert.equal((await evaluateTimingArm(arm('overlap'), data)).readyAt, 30570);
});

test('recorded buy, wallet cash and final outcome never override the causal decision', async () => {
    const data = fixture(), base = await evaluateTimingArm(arm('overlap'), data);
    data.decision = { action: 'BUY_UP' };
    data.entryDisposition = 'order_rejected';
    data.executionEvidence = { bestAsk: 0.02 };
    data.wallet = { balance: 0 };
    data.pnl = -50;
    assert.deepEqual(await evaluateTimingArm(arm('overlap'), data), base);
    assert.equal(base.action, 'BUY_DOWN');
    assert.equal((await evaluateTimingArm(arm('overlap'), { ...data, walletReadSucceeded: false })).status, 'unavailable');
    assert.equal((await evaluateTimingArm(arm('overlap'), { ...data, walletWaitMs: null })).readyAt, null);
});

test('mutated input and missing clocks cannot generate paper opportunities', async () => {
    const data = fixture();
    for (const partial of [{ input: data.input + ' ' }, { decisionRequestedAt: null }, { validation: {} }]) {
        const res = await evaluateTimingArm(arm('serial'), { ...data, ...partial });
        assert.equal(res.status, 'unavailable');
        assert.equal(res.readyAt, null);
    }
    await assert.rejects(() => evaluateTimingArm(arm('serial'), data, { oldToNewPersistRatio: 0 }), /benchmark/);
});

test('configured manifest and actual source bytes must match before importing the provider', async t => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const dir = await mkdtemp(path.join(tmpdir(), 'paired-provider-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const list = ['package.json', 'src/eligible-live/provider.js', 'src/eligible-live/entry-buffer.js',
        'src/eligible-live/entry-cost-cap.js', 'src/decision-paper/features.js', 'src/decision-paper/entry-filter.js',
        'src/restart/math.js', 'src/restart/network.js'];
    const sources = await Promise.all(list.map(async f => [f, digest(await readFile(path.join(root, f)))]));
    const manifest = { runtimeId: 'abcdef0123456789', sources, policy: { provider: 'eligible', inference: false,
        execution: exec, entryFilter: filter } };
    const manifestPath = path.join(dir, 'manifest.json');
    const load = async () => {
        const bytes = JSON.stringify(manifest);
        await writeFile(manifestPath, bytes);
        return loadTimingArm({ root, manifestPath, manifestSha256: digest(bytes), mode: 'serial' });
    };
    const loaded = await load();
    assert.equal((await evaluateTimingArm(loaded, fixture())).status, 'ready');
    sources[0][1] = 'a'.repeat(64);
    await assert.rejects(load, /arm_source_mismatch/);
    await assert.rejects(() => loadTimingArm({ root, manifestPath, manifestSha256: 'b'.repeat(64), mode: 'serial' }),
        /manifest_hash_mismatch/);
});
