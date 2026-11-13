// Historical-input latency probe only. It has no TradingClient, execution
// engine, order API or experiment ledger, and cannot create paper/live fills.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/ai-shadow/config.js';
import { encodeFeatures } from '../src/ai-shadow/history.js';
import { ProviderManager } from '../src/ai-shadow/providers.js';
import { atomicJson } from '../src/restart/store.js';
import { fee, round } from '../src/restart/math.js';

dotenv.config({ path: path.join(os.homedir(), '.config/polymarket-ai-shadow.env'), quiet: true });
const config = loadConfig(), args = process.argv.slice(2);
if (args.length !== 1 || !/^--source-period=[a-zA-Z0-9_-]+$/.test(args[0])) throw new Error('benchmark_source_period_required');
const sourceId = args[0].slice('--source-period='.length);
const source = JSON.parse(fs.readFileSync(path.join(config.dataDir, sourceId, 'ledger.json')));
const snapshots = source.snapshots.slice(-20), rows = [], pending = new Map();
if (snapshots.length < 20) throw new Error('benchmark_requires_twenty_snapshots');
const providers = new ProviderManager(config, {}, (type, detail) => {
    if (type === 'provider_late_response') pending.set(`${detail.provider}:${detail.snapshotId}`, detail);
});
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.floor((values.length-1)*p)];
try {
    const health = await providers.preflight();
    if (!health.laya.ready || !health['9router'].ready) throw new Error('benchmark_preflight_failed');
    for (const snapshot of snapshots) {
        const state={...snapshot.state};
        // Older ledgers lack the new limit fields. Add a conservative maximum
        // one-cent allowance for input-size/latency measurement only. This is
        // not a replay of fills or a claim about the historical exchange tick.
        state.limit_cost_up_down ||= [0,1].map(index=>{
            if(!state.allowed.includes(index===0?'BUY_UP':'BUY_DOWN'))return null;
            const price=round(Math.min(.90,state.books_up_down[index].asks[0][0]+config.limitSlippageUsd));
            return [round(price*100),round(config.shares*price+fee(config.shares,price,
                {rate:state.fee_rate,exponent:state.fee_exponent})+config.gasUsd)];
        });
        const input = encodeFeatures(state);
        const decisions = await Promise.all(['laya', '9router'].map(async provider => {
            const result = await providers.predict(provider, { ...snapshot, input });
            return { provider, snapshotId: snapshot.snapshotId, status: result.status, latencyMs: result.latencyMs,
                model: result.model, inputTokens: result.usage?.input_tokens ?? result.usage?.prompt_tokens ?? null };
        }));
        // No queued inference; wait for a timed-out HTTP call to drain before
        // measuring the next sample. A persistent disable remains a failure.
        await Promise.allSettled([...providers.active.values()]);
        for (const row of decisions) {
            const late = pending.get(`${row.provider}:${row.snapshotId}`);
            row.actualLatencyMs = late?.latencyMs ?? (row.status === 'ok' ? row.latencyMs : null);
            row.model ||= late?.model ?? null;
            row.inputTokens ||= late?.usage?.input_tokens ?? late?.usage?.prompt_tokens ?? null;
            rows.push(row); console.log(JSON.stringify(row));
        }
    }
    const summary = Object.fromEntries(['laya', '9router'].map(provider => {
        const samples = rows.filter(row => row.provider === provider), times = samples.map(row => row.actualLatencyMs).filter(Number.isFinite);
        return [provider, { requests: samples.length, timely: samples.filter(row => row.status === 'ok').length,
            actualLatencyMs: { p50: times.length ? percentile(times, .5) : null, p95: times.length ? percentile(times, .95) : null },
            maxInputTokens: Math.max(...samples.map(row => row.inputTokens || 0)) }];
    }));
    const report = { generatedAt: new Date().toISOString(), configId: config.id, sourceId, historicalInputsOnly: true,
        decisionMs: config.decisionMs, model: config.ninerouterResolvedModel, reasoningEffort: config.ninerouterReasoningEffort,
        summary, rows, limitations: ['twenty_requests_per_engine', 'latency_probe_not_trading_evidence', 'no_profit_evaluation',
            ...(snapshots.some(s=>!s.state.limit_cost_up_down)?['synthetic_maximum_limits_for_older_inputs']:[])] };
    atomicJson(path.join(config.dataDir, 'validation', `latency-${config.id}.json`), report);
    console.log(JSON.stringify({ summary, artifact: `data/ai-shadow/validation/latency-${config.id}.json` }));
    if (Object.values(summary).some(row => row.timely < 16)) process.exitCode = 1;
} finally { providers.close(); }
