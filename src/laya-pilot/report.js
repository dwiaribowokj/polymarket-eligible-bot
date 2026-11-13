import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from '../restart/store.js';
import { dailyBootstrap, round } from '../restart/math.js';

export function summarizeLaya(state, now = Date.now()) {
    const arm = state.arms.laya, rows = arm.completed;
    const decisions = state.snapshots.map(s => s.decisions.laya).filter(Boolean);
    const latencies = decisions.map(d => d.actualLatencyMs ?? (d.status === 'ok' ? d.latencyMs : null)).filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * p) - 1)] : null;
    const days = (Math.min(state.frozenAt || now, state.deadline) - state.startedAt) / 86400000;
    const pnl = round(rows.reduce((sum, r) => sum + r.pnl, 0));
    const ci95 = dailyBootstrap(rows.map(row => ({ ...row, closedAt: row.closedAt + 7 * 3600000 })));
    return { at: new Date(now).toISOString(), id: state.id, paperOnly: true, liveReady: false,
        purpose: 'paper_pilot_rehearsal', decision: 'belum layak pilot',
        reasons: [...(days < 7 ? ['need_7_days'] : []), ...(rows.length < 100 ? ['need_100_filled_markets'] : []),
            ...(pnl <= 0 ? ['nonpositive_net_profit'] : []), ...(!ci95 || ci95.lower <= 0 ? ['uncertain_expectancy'] : []),
            ...(arm.shadowStop ? ['pilot_drawdown_limit_breached'] : []), 'manual_live_activation_required'],
        startedAt: state.startedAt, deadline: state.deadline, frozenAt: state.frozenAt, days: round(days),
        cash: arm.cash, netTradingPnl: pnl, ci95, completedMarkets: rows.length,
        fees: round(rows.reduce((s, r) => s + r.fees, 0)), gas: round(rows.reduce((s, r) => s + r.gas, 0)),
        aiApiCost: 0, aiComputeCost: null, netAfterAllCosts: null, aiComputeCostBasis: 'local_compute_unpriced',
        maxDrawdown: arm.drawdown, stopped: arm.stopped, shadowStop: arm.shadowStop,
        inventory: arm.position ? { market: arm.position.market.slug, status: arm.position.status, shares: arm.position.holdings } : null,
        attempts: Object.keys(arm.seen).length, partialFills: rows.filter(r => r.partial).length,
        noFill: Object.values(arm.outcomes).filter(r => r.reason === 'no_fill').length,
        executionExpired: Object.values(arm.outcomes).filter(r => r.reason === 'execution_expired').length,
        decisions: decisions.length, timeouts: decisions.filter(d => d.status === 'decision_timeout').length,
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), completedResponses: latencies.length }, errors: state.errors,
        bootstrapTimezone: 'Asia/Jakarta',
        lastHeartbeatAt: state.lastHeartbeatAt || null, provider: state.providers.laya || null };
}

export function saveLayaReport(config, state) {
    const result = summarizeLaya(state);
    atomicJson(path.join(config.dataDir, state.id, 'reports/latest.json'), result);
    return result;
}

export function readLayaReports(config, history = false) {
    if (!fs.existsSync(config.dataDir)) return [];
    return fs.readdirSync(config.dataDir, { withFileTypes: true }).filter(d => d.isDirectory() && (history || d.name === config.id)).flatMap(d => {
        const file = path.join(config.dataDir, d.name, 'ledger.json');
        return fs.existsSync(file) ? [summarizeLaya(JSON.parse(fs.readFileSync(file)))] : [];
    });
}
