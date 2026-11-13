import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, loadSettings, requireRuntime } from '../restart/config.js';
import { PREMARKET_FEED_WATCHDOG } from './client.js';
import { EARLY_PROFILE, NEXT_PROFILE, isCandleProfile } from './early-context.js';
import { EARLY_BOOK_POLICY } from './early-book.js';
import { EARLY_PAPER_TRANSPORT, EARLY_PAPER_CLOCK } from './transport.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY } from './router-directional.js';

export const PREMARKET_ARMS = Object.freeze(['premarket-momentum', 'late-cost-cap', 'laya-premarket', 'router-premarket']);
export const FAIR_PREMARKET_ARMS = Object.freeze(['premarket-momentum', 'laya-premarket', 'router-premarket']);
export const FAIR_SIGNAL_PARAMETERS = Object.freeze({
    windowsSeconds: Object.freeze({ m5: 300, m15: 900, m30: 1800 }),
    minimumNormalizedStrength: Object.freeze({ m5: 0.5, m15: 1, m30: 1 }),
    minimumAligned5mGroups: 5, total5mGroups: 6,
    reversalWindowSeconds: 60, maximumOpposingReversalUsd: 0, probabilityPolicy: 'none_direction_only'
});
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function parsePremarketActiveArms(value) {
    if (value === undefined) return [...PREMARKET_ARMS];
    if (typeof value !== 'string') throw new Error('premarket_active_arms_invalid');
    const names = value.split(',').map(name => name.trim());
    if (!names.length || new Set(names).size !== names.length || names.some(name => !PREMARKET_ARMS.includes(name)))
        throw new Error('premarket_active_arms_invalid');
    return PREMARKET_ARMS.filter(name => names.includes(name));
}

export function selectedPremarketProviders(config) {
    const active = config.activeArms ?? config.armNames ?? PREMARKET_ARMS;
    return [...new Set(Object.entries(config.providerArms || {}).filter(([arm]) => active.includes(arm)).map(([, name]) => name))];
}

export function loadPremarketPaperConfig(env = process.env, out) {
    requireRuntime();
    if (!out || !path.isAbsolute(out)) throw new Error('absolute_paper_output_required');
    const dataDir = path.resolve(out);
    const control = loadSettings({ ...env, RESTART_DATA_DIR: path.join(dataDir, 'settings') }, 'late-entry');
    control.minDays = 7; control.evaluationEndsAt = null;
    const profile = env.PREMARKET_PROFILE ?? 'legacy-three-candles-v1';
    if (!['legacy-three-candles-v1', 'near-open-30m-v1', 'fair-near-open-30m-v1', EARLY_PROFILE, NEXT_PROFILE].includes(profile)) throw new Error('premarket_profile_invalid');
    const routerPolicy = env.PREMARKET_ROUTER_POLICY;
    if (routerPolicy !== undefined && (routerPolicy !== NEXT_ROUTER_DIRECTIONAL_POLICY || profile !== NEXT_PROFILE))
        throw new Error('premarket_router_policy_invalid');
    const early = isCandleProfile({ profile });
    const fair = profile === 'fair-near-open-30m-v1' || early;
    const nearOpen = !early && (fair || profile === 'near-open-30m-v1');
    const activeArms = parsePremarketActiveArms(env.PREMARKET_ACTIVE_ARMS ?? (fair ? FAIR_PREMARKET_ARMS.join(',')
        : nearOpen ? 'router-premarket' : undefined));
    if (nearOpen && !fair && (activeArms.length !== 1 || activeArms[0] !== 'router-premarket'))
        throw new Error('premarket_long_history_requires_router_only');
    if (fair && JSON.stringify(activeArms) !== JSON.stringify(FAIR_PREMARKET_ARMS))
        throw new Error('premarket_fair_requires_three_arm_cohort');
    const policy = { schema: 1, experiment: 'premarket-three-candles-paper-v1', paperOnly: true,
        profile, armNames: [...PREMARKET_ARMS], activeArms,
        capital: 20, shares: 5, entryCap: 5, maxActiveMarketsPerArm: 1,
        leadSeconds: nearOpen ? 60 : 240, slots: [90, 60, 30], slotToleranceMs: 2000,
        candleCount: nearOpen ? 30 : 3, candleIntervalMs: 60000,
        dataAgeMs: 5000, maxGapMs: 5000, historyMs: nearOpen ? 1800000 : 180000,
        diagnosticHistoryMs: nearOpen ? 1800000 : 900000,
        feedWatchdog: { ...PREMARKET_FEED_WATCHDOG },
        latencyMs: 250, settlementMs: 2500, reportMs: 60000, gasUsd: control.paperGasUsd,
        limitSlippageTicks: 1, limitSlippageUsd: 0.01, costCapPerShare: 0.85,
        drawdownStop: 10, inferencePolicy: 'independent-laya-router-frozen-forecast-30s',
        providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' }, aiDecisionMs: 30000,
        decisionMs: 30000, providerDrainMs: 60000,
        routerModel: env.PREMARKET_ROUTER_MODEL || 'cx/gpt-6.1-sol', routerReasoning: 'medium',
        promotionPolicy: 'never_automatic',
        signalPolicy: fair ? 'common-context-5m-15m-30m-consistent-volatility-normalized-momentum-v1'
            : nearOpen ? 'router-full-30m-candles-near-open-value-v1'
            : 'three-completed-utc-minute-bars-bearish-lower-closes-down-bullish-higher-closes-up-v1',
        candlePolicy: 'source-time-half-open-minute-bins-observed-by-fixed-decision-time-v1',
        diagnosticPolicy: nearOpen ? 'full-30m-context-and-six-grouped-5m-bars-v1' : 'volatility-and-reversal-recorded-only-no-gates',
        cohortPolicy: 'all-prospectively-enrolled-markets-including-skips',
        riskPolicy: 'realized-equity-drawdown-no-unrealized-mark-claim',
        executionPolicy: 'one-frozen-limit-fak-at-least-250ms-later-fresh-websocket-no-chase',
        controlPolicy: 'existing-single-eligible-side-and-085-all-in-full-fill-cost-cap',
        controlBaseline: control.fingerprint, minDays: 7, minMarkets: 100, bootstrapSamples: 10000 };
    if (fair) Object.assign(policy, {
        signalParameters: FAIR_SIGNAL_PARAMETERS,
        hypothesisPolicy: 'prospective-untuned-momentum-rule-no-calibrated-probability-or-performance-guarantee',
        inferencePolicy: 'shared-compact-30m-evidence-independent-laya-router-30s-v1',
        executionPolicy: 'shared-decision-cutoff-fresh-validation-frozen-limit-fak-at-least-250ms-v1',
        controlPolicy: 'full-30m-momentum-same-snapshot-cost-and-execution-guards',
        historicalReferenceArms: ['late-cost-cap'],
        historicalReferencePolicy: 'inactive-different-entry-time-not-a-fair-paired-control'
    });
    if (early) Object.assign(policy, {
        leadSeconds: 540, candleCount: 30, candleIntervalMs: 300000,
        slotToleranceMs: 10000,
        bookPolicy: { ...EARLY_BOOK_POLICY },
        transportPolicy: { ...EARLY_PAPER_TRANSPORT }, clockPolicy: { ...EARLY_PAPER_CLOCK },
        earlyExecution: { version: 'bounded-shared-rest-fak-v1', retryWindowMs: 30000, retryMs: 1000 },
        executionPolicy: 'shared-cutoff-bounded-readiness-uncached-rest-single-fak-v2',
        historyMs: 9000000, diagnosticHistoryMs: 9000000, candleCacheMaxAgeMs: 90000,
        candleSource: { source: 'binance_spot', symbol: 'BTCUSDT', interval: '5m',
            settlementSource: 'official_polymarket_ctf_payout', historicalBackfillAllowed: true },
        signalParameters: { minimumPriorStreak: 3 },
        signalPolicy: 'prior-direction-streak-followed-by-one-opposite-closed-5m-candle-v1',
        candlePolicy: 'thirty-closed-utc-5m-binance-bars-observed-by-fixed-decision-time-v1',
        diagnosticPolicy: 'full-150m-context-closed-bars-only-no-live-history-warmup-v1',
        inferencePolicy: 'shared-compact-150m-binance-evidence-independent-laya-router-30s-v1',
        controlPolicy: 'untuned-streak-reversal-same-snapshot-cost-and-execution-guards',
        hypothesisPolicy: 'prospective-untuned-streak-reversal-not-an-established-predictive-edge'
    });
    if (profile === NEXT_PROFILE) Object.assign(policy, {
        leadSeconds: -5, entryEndOffsetMs: 90000,
        rolePolicy: 'streak-signal-confirmation-or-skip-v1',
        inferencePolicy: 'shared-compact-150m-next-candle-confirmation-laya-router-30s-v1',
        controlPolicy: 'next-candle-streak-reversal-with-ai-confirmation-filters',
        signalPolicy: 'first-opposite-closed-5m-bar-followed-by-immediate-next-market-v1',
        hypothesisPolicy: 'prospective-next-candle-continuation-no-established-edge',
        timingPolicy: 'first-reversal-close-plus-5s-target-immediate-successor-entry-before-open-plus-90s',
    });
    if (routerPolicy !== undefined) policy.routerPolicy = routerPolicy;
    const candleCache = early ? env.PREMARKET_CANDLE_CACHE || path.join(path.dirname(dataDir), 'market-history', 'btcusdt-5m.json') : null;
    if (early && !path.isAbsolute(candleCache)) throw new Error('premarket_candle_cache_requires_absolute_path');
    const files = new Set(['package.json', 'package-lock.json', 'scripts/ai-shadow-tokenizer.py']);
    const collect = file => {
        if (files.has(file)) return;
        files.add(file);
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
            const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
            if (fs.existsSync(path.join(ROOT, dependency))) collect(dependency);
        }
    };
    for (const file of fs.readdirSync(path.join(ROOT, 'src/premarket-paper')).filter(file => file.endsWith('.js')))
        collect(`src/premarket-paper/${file}`);
    collect('scripts/premarket-paper.js');
    // loadSettings fingerprints these sources even when they are not direct imports.
    for (const file of fs.readdirSync(path.join(ROOT, 'src/restart')).filter(file => file.endsWith('.js')))
        collect(`src/restart/${file}`);
    collect('src/restart.js');
    const sources = [...files].sort().map(file => [file, digest(fs.readFileSync(path.join(ROOT, file)))]);
    const id = digest(JSON.stringify({ policy, sources })).slice(0, 16);
    return { ...policy, id, policy, sources, root: ROOT, dataDir, control, ...(early ? { candleCache } : {}),
        layaUrl: env.AI_SHADOW_LAYA_URL || 'http://127.0.0.1:8090',
        layaContainer: env.AI_SHADOW_LAYA_CONTAINER || 'laya-server',
        ninerouterUrl: env.NINEROUTER_URL || 'http://127.0.0.1:20128/v1', ninerouterKey: env.NINEROUTER_KEY || '' };
}
