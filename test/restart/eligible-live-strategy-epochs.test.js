import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeEligibleStrategyEpoch, eligibleStrategySummary } from '../../src/eligible-live/strategy-epochs.js';
import { main, parseCostCapMigrationArgs } from '../../scripts/eligible-migrate-cost-cap.js';

const config = { id: 'period', runtimeId: 'runtime', policy: { provider: 'eligible', entryFilter: {
    version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: .85, gasUsd: .05, basis: 'full_fill_at_frozen_limit' } } };
const state = () => ({ startedAt: 1000, cash: 1.25, peakEquity: 22, maxDrawdown: 21, completed: [],
    seen: {}, ai: { snapshots: [] }, position: null });

test('fresh cost-cap epoch records its policy once and preserves financial history', () => {
    const s = state(), before = structuredClone(s);
    const epoch = initializeEligibleStrategyEpoch(s, config, 2000);
    assert.equal(s.strategyEpochs.length, 1);
    assert.equal(initializeEligibleStrategyEpoch(s, config, 3000), epoch);
    for (const key of Object.keys(before)) assert.deepEqual(s[key], before[key], key);
    assert.deepEqual(epoch.policy, config.policy);
    assert.equal(eligibleStrategySummary(s, config).current.realizedPnl, 0);
});

test('existing trading history requires explicit migration instead of automatically starting a new cohort', () => {
    for (const edit of [s => s.completed.push({ pnl: -4 }), s => s.ai.snapshots.push({ snapshotId: 'old' }),
        s => s.seen.old = {}, s => s.position = {}]) {
        const s = state(); edit(s); const before = structuredClone(s);
        assert.throws(() => initializeEligibleStrategyEpoch(s, config, 2000), /epoch_mismatch/);
        assert.deepEqual(s, before);
    }
    const s = state(); initializeEligibleStrategyEpoch(s, config, 2000);
    assert.throws(() => initializeEligibleStrategyEpoch(s, { ...config, policy: { ...config.policy, shares: 6 } }, 3000), /epoch_mismatch/);
});

test('epoch report separates losses before migration and outcomes after it without importing virtual profit', () => {
    const s = state(); const epoch = initializeEligibleStrategyEpoch(s, config, 2000);
    s.ai.snapshots.push({ snapshotId: 'old' }, { snapshotId: 'new', strategyEpochId: epoch.id });
    s.completed.push({ traded: true, pnl: -4, entrySignal: { snapshotId: 'old' } },
        { traded: true, pnl: 1, entrySignal: { strategyEpochId: epoch.id } },
        { traded: false, pnl: -.01, entrySignal: { snapshotId: 'new' } },
        { traded: true, pnl: 2, entrySignal: { strategyEpochId: 'unknown' } });
    const before = structuredClone(s), result = eligibleStrategySummary(s, config);
    assert.equal(result.current.realizedPnl, .99);
    assert.equal(result.current.filled, 1); assert.equal(result.current.completedAttempts, 2);
    assert.equal(result.legacy.realizedPnl, -4); assert.equal(result.unattributedCompleted, 1);
    assert.equal(result.paperProfitIncluded, false); assert.equal(result.riskReset, false);
    assert.deepEqual(s, before);
});

test('migration CLI defaults to review, requires exact apply and keeps the pilot lock through proof', async () => {
    assert.deepEqual(parseCostCapMigrationArgs([]), { apply: false });
    for (const args of [['--live'], ['--reset'], ['--apply', '--apply']]) assert.throws(() => parseCostCapMigrationArgs(args));
    for (const args of [[], ['--apply']]) {
        const events = [], results = [], cfg = { ...config, settings: { dataDir: '/tmp/example-pilot' }, ai: {} };
        const store = { state: {} }, review = { summary: { ready: true } };
        const dependencies = { loadConfig: () => cfg, acquireLock: async (dir, name) => {
            assert.equal(dir, cfg.settings.dataDir); assert.equal(name, 'pilot'); events.push('lock');
            return async () => events.push('release'); },
            readHistory: () => [{ baseline: cfg.id, strategy: 'late-entry' }], storeFactory: () => store,
            clientFactory: () => ({ close() { events.push('client_close'); } }),
            providerFactory: () => ({ close() { events.push('provider_close'); } }),
            prepare: async () => { events.push('proof'); return review; },
            apply: (s, r, options) => { assert.equal(s, store); assert.equal(r, review); assert.equal(options.explicitApply, true);
                events.push('apply'); return { epochId: 'new', archiveSha256: 'backup' }; }, write: row => results.push(row) };
        assert.equal(await main(args, dependencies), 0);
        assert.deepEqual(events, ['lock', 'proof', ...(args.length ? ['apply'] : []), 'provider_close', 'client_close', 'release']);
        assert.equal(results[0].liveStarted, false); assert.equal(results[0].financialWrites, false);
        assert.equal(results[0].applied, args.length > 0);
    }
});
