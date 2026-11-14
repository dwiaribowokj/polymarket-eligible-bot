import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, loadSettings, requireRuntime } from '../restart/config.js';
import { sourceManifest } from '../laya-filter-paper/config.js';

export const VALUE_SLOTS = Object.freeze([270, 240, 210, 180, 150, 120, 90, 75, 60, 50, 40, 30, 20, 15, 10, 5]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function loadValueCollectorConfig(env = process.env, out) {
    requireRuntime();
    if (!out || !path.isAbsolute(out)) throw new Error('absolute_collector_output_required');
    const dataDir = path.resolve(out);
    const control = loadSettings({ ...env, RESTART_DATA_DIR: path.join(dataDir, 'settings') }, 'late-entry');
    const policy = { schema: 1, experiment: 'btc-five-minute-value-data-v1', readOnly: true,
        asset: 'btc', durationMs: 300000, slots: [...VALUE_SLOTS], slotToleranceMs: 2000,
        captureBudgetMs: 3000, dataAgeMs: 5000, historyMs: 180000, maxGapMs: 5000,
        maxFeedDifferenceUsd: 3, maxClockSkewMs: control.maxClockSkewMs,
        quoteShares: [5, 10, 20], gasUsd: control.paperGasUsd,
        quotePolicy: 'visible_ask_depth_plus_taker_fee_and_assumed_gas_not_a_fill',
        cutoffPolicy: 'latest_causal_spot_source_time',
        bookPolicy: 'independent_fresh_rest_full_depth_preserve_exchange_age', selectionPolicy: 'all_scheduled_slots_both_sides',
        labelPolicy: 'official_confirmed_ctf_payout_separate_from_features',
        trainingPolicy: 'no_training_or_promotion_during_collection',
        clockMaxAgeMs: 30000, heartbeatMs: 10000, labelRetryMs: 15000,
        maxStorageBytes: 4 * 1024 ** 3, minFreeBytes: 2 * 1024 ** 3 };
    const sources = [...sourceManifest(), ['scripts/value-collector.js',
        hash(fs.readFileSync(path.join(ROOT, 'scripts/value-collector.js')))]].sort(([a], [b]) => a.localeCompare(b));
    const id = hash(JSON.stringify({ policy, sources })).slice(0, 16);
    return { ...policy, id, policy, sources, control, dataDir };
}
