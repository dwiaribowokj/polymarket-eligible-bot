import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Store, atomicJson } from '../../src/restart/store.js';
import { loadEligibleConfig, eligibleConfigView } from '../../src/eligible-live/config.js';
import { bindRuntimeContinuation } from '../../src/eligible-live/continuation.js';
import { bindRiskPeriod, validateRiskPeriodRecord } from '../../src/eligible-live/period.js';
import { eligibleHistory, eligibleReadiness } from '../../src/eligible-live/preflight.js';
import { EligibleLiveProvider, ELIGIBLE_MODEL } from '../../src/eligible-live/provider.js';
import { BinanceLeadFeed, ELIGIBLE_BINANCE_LEAD_VETO } from '../../src/eligible-live/binance-lead.js';
import { ELIGIBLE_BUFFER_POLICY } from '../../src/eligible-live/entry-buffer.js';
import { assertEligibleBinanceLeadLive, assertEligibleEntryCostCap, evaluateEligibleEntryCostCap,
    prepareEligibleBinanceLead, validateEligibleEntryFilter } from '../../src/eligible-live/entry-cost-cap.js';
import { continuationProfitTaking, verifiedProfitTakingMigration } from '../../src/eligible-live/profit-policy-proof.js';
import { prepareProfitTakingPolicyMigration } from '../../src/eligible-live/profit-policy-migration.js';
import { LayaLiveEngine } from '../../src/laya-live/engine.js';
import { candidateChecks, metadataIdentity, ShadowEngine } from '../../src/ai-shadow/engine.js';
import { marketSlug } from '../../src/restart/strategy.js';

const start = Date.parse('2026-11-26T00:04:00Z');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => hash(JSON.stringify(value));
const identity = config => digest({ policy: config.policy, sources: config.sources,
    profitTaking: config.profitTaking }).slice(0, 16);
const wallet = `0x${'b'.repeat(40)}`;

function policy(gasUsd, maxCostPerShare = .82, withLead = true) {
    return {
        version: 'full-fill-all-in-cost-cap-v1',
        maxCostPerShare,
        gasUsd,
        basis: 'full_fill_at_frozen_limit',
        ...(withLead ? { binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO } : {}),
    };
}

function marketData({ price = .79, rate = .07, gasUsd = .05, index = 0, maxCostPerShare = .82, withLead = true } = {}) {
    const settings = { pilotHours: 48, maxDataAgeMs: 5000, shares: 5, entryCap: 5,
        late: { duration: 300 }, lateQuality: { maxSpread: .03, minDepth: 5 } };
    const entryFilter = policy(gasUsd, maxCostPerShare, withLead);
    const config = {
        settings,
        policy: { provider: 'eligible', model: ELIGIBLE_MODEL, aiSource: ELIGIBLE_MODEL, entryFilter },
        ai: {
            slots: [90, 60, 30], slotToleranceMs: 2000, decisionMs: 3000, dataAgeMs: 5000, latencyMs: 250,
            shares: 5, entryCap: 5, gasUsd, limitSlippageTicks: 1, limitSlippageUsd: .01, control: settings,
            entryFilter,
        },
    };
    const market = {
        slug: marketSlug('late-entry', settings, start),
        conditionId: 'lead-veto-condition',
        open: start - 240000,
        end: start + 60000,
        accepting: true,
        minimum: 5,
        tick: .01,
        ticks: [.01, .01],
        tokens: ['lead-veto-up', 'lead-veto-down'],
        outcomes: ['Up', 'Down'],
        fee: { rate, exponent: 1, takerOnly: true },
        negRisk: false,
    };
    const books = market.tokens.map((tokenId, i) => ({
        tokenId,
        conditionId: market.conditionId,
        tick: .01,
        timestamp: start - 100,
        fetchedAt: start - 100,
        bids: [{ price: i === index ? price - .02 : .20, size: 10 }],
        asks: [{ price: i === index ? price - .01 : .21, size: 10 }],
    }));
    const state = {
        mode: 'pilot', strategy: 'late-entry', startedAt: start - 3600000, cash: 20,
        walletStart: 20, walletCashDelta: 0, peakEquity: 20, maxDrawdown: 0, failures: 0,
        completed: [], seen: {}, stopped: null, position: null, decisionProvider: 'eligible',
        currentStrategyEpochId: 'lead-veto-epoch',
    };
    const allowed = candidateChecks(market, books, config.ai, state.cash, start)
        .flatMap(check => check.order ? [check.order] : []);
    assert.equal(allowed.length, 1);
    const snapshot = {
        market: market.slug, slot: 60, at: start, observedAt: start - 100,
        provider: 'eligible', model: ELIGIBLE_MODEL, allowed, entryFilter,
        validation: { at: start, generation: 1, identity: metadataIdentity(market) },
        decisionRequestedAt: start, decisionReceivedAt: start,
    };
    const input = {
        market: market.slug, seconds: 60, fee_rate: rate, fee_exponent: 1, shares: 5, entry_cap: 5,
        allowed: [index === 0 ? 'BUY_UP' : 'BUY_DOWN'],
        limit_cost_up_down: [0, 1].map(i => i === index ? [Math.round(allowed[0].price * 100), allowed[0].cost] : null),
    };
    const rehash = () => {
        snapshot.input = JSON.stringify(input);
        snapshot.inputHash = hash(snapshot.input);
        snapshot.snapshotId = hash(JSON.stringify({ slug: snapshot.market, seconds: snapshot.slot,
            now: snapshot.at, input: snapshot.input })).slice(0, 24);
    };
    rehash();
    return { settings, config, market, books, state, snapshot, input, rehash, index,
        spec: { ...allowed[0], kind: 'taker' } };
}

function seedFeed(feed, { now = start, midStart = 100000, ret5sBps = 0 } = {}) {
    const midEnd = midStart * (1 + ret5sBps / 10000);
    feed.ingest({ at: now - 5200, bid: midStart - 0.5, ask: midStart + 0.5, mid: midStart });
    feed.ingest({ at: now - 5000, bid: midStart - 0.5, ask: midStart + 0.5, mid: midStart });
    feed.ingest({ at: now - 100, bid: midEnd - 0.5, ask: midEnd + 0.5, mid: midEnd });
    return feed;
}

function continuationFixture(t, { profitTaking = true } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-lead-veto-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const env = {
        RESTART_DATA_DIR: dataDir,
        PROXY_WALLET_ADDRESS: wallet,
        PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        ...(profitTaking ? { LAYA_PROFIT_TAKING_ENABLED: 'true', LAYA_PROFIT_RECIPIENT: `0x${'c'.repeat(40)}` } : {}),
    };
    const original = loadEligibleConfig(env), originalProfitTaking = structuredClone(original.profitTaking);
    const old = new Store({ ...original.settings, fingerprint: '8899aabbccddeeff', capital: 20 }, 'pilot', 'late-entry');
    Object.assign(old.state, {
        decisionProvider: 'laya', startedAt: 1000, cash: 12, peakEquity: 23,
        maxDrawdown: 11, walletStart: 20, walletCashDelta: -8, liveFunding: { initialCapital: 20 },
        stopped: { reason: 'drawdown_limit', at: 2000 }, liveRiskStop: { reason: 'drawdown_limit', at: 2000 },
    });
    old.save();
    const pin = { baseline: old.state.baseline, strategy: 'late-entry',
        path: `${old.state.baseline}/pilot/late-entry.json`, sha256: hash(fs.readFileSync(old.filename)) };
    const payload = {
        schema: 1, runtimeId: original.runtimeId, wallet, dataDir,
        priorPeriodId: old.state.baseline, policySha256: digest(original.policy),
        profitTakingSha256: digest(original.profitTaking), createdAt: 3000, nonce: 'c'.repeat(64),
        acknowledgment: 'manual_new_risk_period', drawdownStop: 10, openingBalance: 12,
        approvedHistory: [pin], proof: {}, automaticActivation: false,
    };
    const periodId = digest(payload).slice(0, 16), risk = { periodId, ...payload };
    const riskRoot = path.join(dataDir, 'eligible-risk-periods', original.runtimeId);
    const riskFile = path.join(riskRoot, periodId, 'record.json');
    atomicJson(riskFile, risk);
    atomicJson(path.join(riskRoot, 'active.json'), { schema: 1, recordId: periodId });
    const backup = path.join(riskRoot, periodId, 'backups', old.state.baseline, 'late-entry.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(old.filename, backup);

    const current = new Store({ ...original.settings, fingerprint: periodId }, 'pilot', 'late-entry');
    Object.assign(current.state, {
        decisionProvider: 'eligible', startedAt: 4000, cash: 11, peakEquity: 14,
        maxDrawdown: 3, walletStart: 12, walletCashDelta: -1,
        liveFunding: { at: 4000, initialCapital: 12, capitalCap: null, allocation: 'available_balance' },
    });
    current.save();
    const manifestFile = path.join(dataDir, periodId, 'eligible-runtime', 'manifest.json');
    atomicJson(manifestFile, { id: periodId, policy: original.policy, sources: original.sources,
        profitTaking: original.profitTaking, startedAt: 4000 });
    const revision = config => {
        const filename = path.join(dataDir, periodId, 'eligible-runtime', 'revisions', config.runtimeId, 'manifest.json');
        atomicJson(filename, { id: periodId, runtimeId: config.runtimeId, startedAt: 4000,
            policy: config.policy, sources: config.sources, profitTaking: config.profitTaking });
        return filename;
    };
    const nextConfig = (previous, nextPolicy, profit, label) => {
        const config = { ...previous, policy: nextPolicy, profitTaking: profit,
            sources: [[`src/${label}.js`, hash(label)]],
            settings: { ...previous.settings, continuousTrading: true } };
        config.runtimeId = identity(config);
        return config;
    };

    const capPolicy = {
        ...original.policy, continuousTrading: true,
        entryFilter: { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: .85,
            gasUsd: original.policy.execution.gasUsd, basis: 'full_fill_at_frozen_limit' },
    };
    let prevConfig = nextConfig(original, capPolicy, original.profitTaking, 'cap');
    let prevApproval = {
        schema: 1, runtimeId: prevConfig.runtimeId, originalRuntimeId: original.runtimeId,
        periodId, originalManifestSha256: hash(fs.readFileSync(manifestFile)),
        riskRecordSha256: hash(fs.readFileSync(riskFile)), reason: 'user_entry_cost_cap',
        ledgerStartedAt: 4000, fundingSha256: digest(current.state.liveFunding),
        policyChange: { previousPolicySha256: digest(original.policy), currentPolicySha256: digest(capPolicy) },
    };
    const capFile = revision(prevConfig);

    const bufferConfig = nextConfig(prevConfig, { ...capPolicy, entryFilter: ELIGIBLE_BUFFER_POLICY },
        prevConfig.profitTaking, 'buffer');
    const bufferApproval = {
        ...prevApproval, runtimeId: bufferConfig.runtimeId, reason: 'user_entry_buffer',
        policyChange: { ...prevApproval.policyChange, currentPolicySha256: digest(bufferConfig.policy) },
        entryBufferMigration: { previousRuntimeId: prevConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(capFile)), previousContinuation: prevApproval,
            previousContinuationSha256: digest(prevApproval) },
    };
    const bufferFile = revision(bufferConfig);

    prevConfig = nextConfig(bufferConfig, capPolicy, bufferConfig.profitTaking, 'returned');
    prevApproval = {
        ...prevApproval, runtimeId: prevConfig.runtimeId, reason: 'user_return_cost_cap',
        entryCostCapReturn: { previousRuntimeId: bufferConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(bufferFile)), previousContinuation: bufferApproval,
            previousContinuationSha256: digest(bufferApproval) },
    };
    const profitFiles = [];
    if (profitTaking) {
        for (const [at, nextProfit, label] of [
            [6000, { ...original.profitTaking, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15 }, 'wallet'],
            [7000, { ...original.profitTaking, retainUsd: 10, trigger: 'wallet_balance', thresholdUsd: 15,
                lossProtection: { beforeTradeMinUsd: 14, afterLossMinUsd: 10, amountUsd: 5 } }, 'loss'],
        ]) {
            const filename = revision(prevConfig);
            profitFiles.push(filename);
            const next = nextConfig(prevConfig, capPolicy, nextProfit, label);
            prevApproval = {
                ...prevApproval, runtimeId: next.runtimeId,
                profitTakingMigration: {
                    previousRuntimeId: prevConfig.runtimeId,
                    previousManifestSha256: hash(fs.readFileSync(filename)),
                    previousContinuation: prevApproval,
                    previousContinuationSha256: digest(prevApproval),
                    previousProfitTaking: prevConfig.profitTaking,
                    currentProfitTakingSha256: digest(nextProfit),
                    approvedAt: at,
                },
                profitTakingStateMigration: { stateSha256: digest(current.state), approvedAt: at },
            };
            prevConfig = next;
        }
        const { enabled, ...ptPolicy } = prevConfig.profitTaking;
        current.state.profitTakingControl = {
            schema: 1, policy: ptPolicy, operation: null, disabled: null,
            lossProtection: { schema: 1, activatedAt: 7500, completedCount: 0,
                completedSha256: digest([]), consumed: [] },
        };
    }

    const cap082File = revision(prevConfig);
    current.state.continuousOperation = { enabledAt: 4500, runtimeId: prevConfig.runtimeId };
    current.save();
    const cap082Config = nextConfig(prevConfig, {
        ...capPolicy, entryFilter: { ...capPolicy.entryFilter, maxCostPerShare: .82 },
    }, prevConfig.profitTaking, 'cap082');
    const cap082Approval = {
        ...prevApproval, runtimeId: cap082Config.runtimeId, reason: 'user_entry_cost_cap_adjustment',
        policyChange: { ...prevApproval.policyChange, currentPolicySha256: digest(cap082Config.policy) },
        entryCostCapAdjustment: { previousRuntimeId: prevConfig.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(cap082File)), previousContinuation: structuredClone(prevApproval),
            previousContinuationSha256: digest(prevApproval), approvedAt: 8000 },
    };

    const previousFile = revision(cap082Config);
    current.state.continuousOperation = { enabledAt: 4500, runtimeId: cap082Config.runtimeId };
    current.save();

    const leadPolicy = {
        ...cap082Config.policy,
        entryFilter: { ...cap082Config.policy.entryFilter, binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO },
    };
    const config = nextConfig(cap082Config, leadPolicy, cap082Config.profitTaking, 'lead-veto');
    const approval = {
        ...cap082Approval,
        runtimeId: config.runtimeId,
        reason: 'user_entry_binance_lead_veto',
        policyChange: { ...cap082Approval.policyChange, currentPolicySha256: digest(config.policy) },
        entryBinanceLeadVeto: {
            previousRuntimeId: cap082Config.runtimeId,
            previousManifestSha256: hash(fs.readFileSync(previousFile)),
            previousContinuation: structuredClone(cap082Approval),
            previousContinuationSha256: digest(cap082Approval),
            approvedAt: 9000,
        },
    };
    delete approval.entryCostCapAdjustment;

    const approvalFile = path.join(dataDir, 'continuation.json');
    const save = () => atomicJson(approvalFile, approval);
    const repin = () => {
        config.runtimeId = identity(config);
        approval.runtimeId = config.runtimeId;
        approval.policyChange.currentPolicySha256 = digest(config.policy);
        approval.entryBinanceLeadVeto.previousContinuationSha256 = digest(approval.entryBinanceLeadVeto.previousContinuation);
        save();
    };
    save();
    return {
        config, approval, original, originalProfitTaking, current, old, risk, riskFile, manifestFile,
        cap082Config, cap082Approval, previousFile, profitFiles, capFile, bufferFile, periodId, dataDir,
        save, repin,
        bind: () => bindRiskPeriod(bindRuntimeContinuation(config, { ELIGIBLE_LIVE_CONTINUATION: approvalFile })),
    };
}

test('loadEligibleConfig and validateEligibleEntryFilter enforce binance lead-veto policy rules', () => {
    const valid = loadEligibleConfig({
        ELIGIBLE_CONTINUOUS_TRADING: 'true',
        ELIGIBLE_ENTRY_COST_CAP: 'true',
        ELIGIBLE_ENTRY_COST_CAP_MAX: '0.82',
        ELIGIBLE_ENTRY_BINANCE_LEAD_VETO: 'true',
    });
    assert.deepEqual(valid.policy.entryFilter, {
        version: 'full-fill-all-in-cost-cap-v1',
        maxCostPerShare: 0.82,
        gasUsd: 0.05,
        basis: 'full_fill_at_frozen_limit',
        binanceLeadVeto: ELIGIBLE_BINANCE_LEAD_VETO,
    });
    assert.deepEqual(eligibleConfigView(valid).entryFilter, valid.policy.entryFilter);

    assert.throws(() => loadEligibleConfig({ ELIGIBLE_ENTRY_BINANCE_LEAD_VETO: 'yes' }),
        /invalid_eligible_entry_binance_lead_veto/);
    assert.throws(() => loadEligibleConfig({ ELIGIBLE_ENTRY_BINANCE_LEAD_VETO: 'true' }),
        /eligible_entry_binance_lead_veto_requires_enabled_cap/);
    assert.throws(() => loadEligibleConfig({
        ELIGIBLE_ENTRY_COST_CAP: 'true',
        ELIGIBLE_ENTRY_BUFFER: 'true',
        ELIGIBLE_ENTRY_BINANCE_LEAD_VETO: 'true',
    }), /eligible_entry_filters_conflict/);

    assert.deepEqual(validateEligibleEntryFilter(valid.policy.entryFilter, { gasUsd: 0.05 }), valid.policy.entryFilter);
    assert.throws(() => validateEligibleEntryFilter({
        ...valid.policy.entryFilter, binanceLeadVeto: { ...ELIGIBLE_BINANCE_LEAD_VETO, thresholdBps: 3 },
    }), /invalid_eligible_entry_filter/);
    assert.throws(() => validateEligibleEntryFilter({
        ...valid.policy.entryFilter, binanceLeadVeto: false,
    }), /invalid_eligible_entry_filter/);
    assert.throws(() => validateEligibleEntryFilter({
        ...valid.policy.entryFilter, extra: true,
    }), /invalid_eligible_entry_filter/);
});

test('BinanceLeadFeed tracks 5s returns, fail-closed staleness, and watchdog drops', () => {
    let now = start;
    const sockets = [];
    let intervalCb = null;
    const feed = new BinanceLeadFeed({
        clock: () => now,
        socketFactory: url => {
            const ws = new EventEmitter();
            ws.url = url;
            ws.readyState = 1;
            ws.terminated = false;
            ws.ping = () => {};
            ws.terminate = () => { ws.terminated = true; };
            sockets.push(ws);
            return ws;
        },
        scheduleInterval: cb => { intervalCb = cb; return { unref() {} }; },
        cancelInterval: () => { intervalCb = null; },
        scheduleTimeout: () => ({ unref() {} }),
        cancelTimeout: () => {},
    });

    feed.start();
    assert.equal(sockets.length, 1);
    const ws = sockets[0];
    ws.emit('open');
    assert.equal(feed.status(now).connected, true);
    assert.equal(feed.status(now).ready, false);

    ws.emit('message', Buffer.from(JSON.stringify({ b: '99999.5', a: '100000.5' })));
    assert.equal(feed.status(now).ready, false);
    now += 5000;
    ws.emit('message', Buffer.from(JSON.stringify({ b: '99979.5', a: '99980.5' })));
    const s = feed.status(now);
    assert.equal(s.ready, true);
    assert.ok(Math.abs(s.ret5sBps - (-2)) < 1e-9);
    assert.equal(feed.adverseMove(0, 5000, 2, now), true);
    assert.equal(feed.adverseMove(1, 5000, 2, now), false);

    now += 3001;
    assert.equal(feed.status(now).ready, false);

    now += 8000;
    intervalCb();
    assert.equal(feed.staleDrops, 1);
    assert.equal(feed.connected, false);
    assert.equal(ws.terminated, true);

    feed.close();
    assert.equal(feed.status(now).ready, false);
});

test('prepareEligibleBinanceLead, EligibleLiveProvider, and assertEligibleBinanceLeadLive fail closed and veto adverse BTC moves', async () => {
    for (const [label, index, ret5sBps, pass, expectedReason] of [
        ['pass UP mild favorable', 0, 1.4, true, null],
        ['pass UP mild adverse within threshold', 0, -1.99, true, null],
        ['veto UP at -2.0 bps exact boundary', 0, -2.0, false, 'binance_lead_veto'],
        ['veto UP sharp drop', 0, -5.2, false, 'binance_lead_veto'],
        ['pass DOWN favorable drop', 1, -3.5, true, null],
        ['pass DOWN mild adverse within threshold', 1, 1.99, true, null],
        ['veto DOWN at +2.0 bps exact boundary', 1, 2.0, false, 'binance_lead_veto'],
        ['veto DOWN sharp spike', 1, 4.8, false, 'binance_lead_veto'],
    ]) {
        const f = marketData({ index, price: .79 });
        const feed = seedFeed(new BinanceLeadFeed({ clock: () => start }), { now: start, ret5sBps });
        prepareEligibleBinanceLead(f.snapshot, feed, f.config, start);
        const provider = new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => start });
        const decision = await provider.predict('eligible', f.snapshot);
        assert.equal(decision.entryFilter.pass, pass, label);
        assert.equal(decision.entryFilter.reason, expectedReason, label);
        assert.equal(decision.action, pass ? (index === 0 ? 'BUY_UP' : 'BUY_DOWN') : 'SKIP', label);
        if (pass) {
            const verified = assertEligibleEntryCostCap({ snapshot: f.snapshot, config: f.config,
                now: start + 100, market: f.market, spec: f.spec, decision });
            assert.equal(verified.pass, true, label);
            const live = assertEligibleBinanceLeadLive(feed, f.config, f.spec, start + 100, f.snapshot);
            assert.equal(live.ready, true, label);
        }
    }

    // Warming / missing feed fails closed
    {
        const f = marketData({ index: 0, price: .79 });
        prepareEligibleBinanceLead(f.snapshot, new BinanceLeadFeed({ clock: () => start }), f.config, start);
        const decision = await new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => start })
            .predict('eligible', f.snapshot);
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.entryFilter.pass, false);
        assert.equal(decision.entryFilter.reason, 'binance_feed_not_ready');
    }

    // Cost cap check precedes lead-veto check when cost > 0.82
    {
        const f = marketData({ index: 0, price: .81 });
        prepareEligibleBinanceLead(f.snapshot, null, f.config, start);
        const decision = await new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => start })
            .predict('eligible', f.snapshot);
        assert.equal(decision.action, 'SKIP');
        assert.equal(decision.entryFilter.reason, 'entry_cost_above_cap');
    }

    // Tampered or stale context fails closed
    {
        const f = marketData({ index: 0, price: .79 });
        const feed = seedFeed(new BinanceLeadFeed({ clock: () => start }), { now: start, ret5sBps: 1.5 });
        prepareEligibleBinanceLead(f.snapshot, feed, f.config, start);
        const tampered = structuredClone(f.snapshot);
        tampered.entryBinanceLead.ret5sBps = 10;
        const verdict = evaluateEligibleEntryCostCap(tampered, f.config, start);
        assert.equal(verdict.pass, false);
        assert.equal(verdict.reason, 'eligible_entry_filter_lead_context_invalid');
        const staleVerdict = evaluateEligibleEntryCostCap(f.snapshot, f.config, start + 3001);
        assert.equal(staleVerdict.pass, false);
        assert.equal(staleVerdict.reason, 'eligible_entry_filter_lead_context_stale');
    }

    // Live execution recheck vetoes if feed turns adverse or stale right before order submit
    {
        let now = start;
        const f = marketData({ index: 0, price: .79 });
        const feed = seedFeed(new BinanceLeadFeed({ clock: () => now }), { now: start, ret5sBps: 1.0 });
        prepareEligibleBinanceLead(f.snapshot, feed, f.config, now);
        const decision = await new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => now })
            .predict('eligible', f.snapshot);
        assert.equal(decision.action, 'BUY_UP');
        now = start + 250;
        feed.ingest({ at: now, bid: 99749.5, ask: 99750.5, mid: 99750 }); // -25 bps drop right before order submit
        assert.throws(
            () => assertEligibleBinanceLeadLive(feed, f.config, f.spec, now, f.snapshot),
            err => err.code === 'binance_lead_veto' && err.category === 'opportunity' && err.entryFilter?.reason === 'binance_lead_veto',
        );
        now = start + 5000;
        assert.throws(
            () => assertEligibleBinanceLeadLive(feed, f.config, f.spec, now, f.snapshot),
            err => err.code === 'binance_feed_not_ready' && err.category === 'opportunity',
        );
    }
});

test('LayaLiveEngine vetoes live entry before placing an order when Binance feed moves adversely', async t => {
    const f = marketData({ index: 0, price: .79 });
    let now = start;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'fetch', () => { throw new Error('network_forbidden_in_lead_veto_test'); });
    const events = [];
    const store = {
        state: f.state,
        save() {},
        event(type, detail = {}) { events.push({ type, ...detail }); },
        stop(reason) { this.state.stopped ||= { reason, at: now }; },
    };
    const stream = { generation: 1, tokens: f.market.tokens, snapshot: () => structuredClone(f.books) };
    let posted = false;
    const feed = seedFeed(new BinanceLeadFeed({ clock: () => now }), { now, ret5sBps: 0.5 });
    const client = {
        btc: { assess: () => ({ reason: 'btc_direction_disagrees' }) },
        books: async () => stream.snapshot(),
        marketInfo: async () => ({}),
        validateInfo() {},
        confirmedBlock: async () => 123,
        balance: async () => 20,
        holdings: async () => [0, 0],
        warmOrderMetadata: async () => {
            now += 250;
            for (const book of f.books) book.timestamp = book.fetchedAt = now - 100;
            feed.ingest({ at: now, bid: 99749.5, ask: 99750.5, mid: 99750 });
        },
        prepare: async () => { posted = true; return { orderId: '0x1', signed: {} }; },
        post: async () => { posted = true; return { ok: true }; },
    };
    t.mock.method(ShadowEngine.prototype, 'freshSnapshot', async () => ({
        initial: stream.snapshot(),
        timing: {},
        features: {
            observedAt: now - 100,
            state: { market: f.market.slug, seconds: 60, fee_rate: f.market.fee.rate,
                fee_exponent: f.market.fee.exponent, shares: 5, entry_cap: 5 },
        },
    }));
    const providers = new EligibleLiveProvider(f.config.ai, {}, () => {}, { clock: () => now });
    const engine = new LayaLiveEngine(f.config, store, client, stream, providers);
    engine.binanceLead = feed;
    engine.current = f.market;
    t.mock.method(engine.clockGate, 'fresh', () => true);
    t.mock.method(engine, 'awaitExecutionLatency', async snapshot => { now = snapshot.decisionReceivedAt + 250; });

    await engine.discover(start);
    assert.equal(posted, false);
    assert.equal(f.state.position, null);
    assert.equal(f.state.stopped, null);
    assert.equal(events.some(e => e.type === 'eligible_entry_filter_veto' && e.reason === 'binance_lead_veto'), true);
});

test('binance lead-veto continuation preserves full withdrawal chain and original risk period without writes', t => {
    const f = continuationFixture(t);
    const before = fs.readFileSync(f.current.filename), prior = fs.readFileSync(f.old.filename);
    const riskBefore = fs.readFileSync(f.riskFile), manifestBefore = fs.readFileSync(f.manifestFile);
    const config = f.bind();
    assert.equal(config.id, f.periodId);
    assert.equal(config.riskRuntimeId, f.original.runtimeId);
    assert.deepEqual(config.riskPeriod, f.risk);
    assert.equal(config.policy.entryFilter.maxCostPerShare, .82);
    assert.deepEqual(config.policy.entryFilter.binanceLeadVeto, ELIGIBLE_BINANCE_LEAD_VETO);
    assert.deepEqual(config.runtimeContinuation.entryBinanceLeadVeto.previousContinuation, f.cap082Approval);
    assert.deepEqual(verifiedProfitTakingMigration(config), f.cap082Approval.profitTakingMigration);
    assert.deepEqual(continuationProfitTaking(config), f.originalProfitTaking);
    assert.deepEqual(config.profitTaking, f.cap082Config.profitTaking);
    assert.deepEqual(validateRiskPeriodRecord(config, f.risk), f.risk);
    const readiness = eligibleReadiness({ config, history: eligibleHistory(config), operationalReady: true });
    assert.equal(readiness.readyForLive, true);
    assert.deepEqual(fs.readFileSync(f.current.filename), before);
    assert.deepEqual(fs.readFileSync(f.old.filename), prior);
    assert.deepEqual(fs.readFileSync(f.riskFile), riskBefore);
    assert.deepEqual(fs.readFileSync(f.manifestFile), manifestBefore);

    assert.throws(() => prepareProfitTakingPolicyMigration(f.current.state, config, 9001), /migration_unproven/);
});

test('binance lead-veto continuation rejects forged, reordered, or incomplete changes even after rehashing', async t => {
    const mutations = {
        changedThreshold: f => { f.config.policy.entryFilter.binanceLeadVeto = { ...ELIGIBLE_BINANCE_LEAD_VETO, thresholdBps: 3 }; },
        changedCap: f => { f.config.policy.entryFilter.maxCostPerShare = .85; },
        changedShares: f => { f.config.policy.shares = 6; },
        changedRecipient: f => { f.config.profitTaking.recipient = `0x${'a'.repeat(40)}`; },
        removedLossMigration: f => { delete f.approval.profitTakingMigration; },
        extraApprovalField: f => { f.approval.unreviewed = true; },
        extraMigrationField: f => { f.approval.entryBinanceLeadVeto.extra = true; },
        approvalTooEarly: f => { f.approval.entryBinanceLeadVeto.approvedAt = 7999; },
        predecessorId: f => { f.approval.entryBinanceLeadVeto.previousRuntimeId = 'f'.repeat(16); },
        predecessorHash: f => { f.approval.entryBinanceLeadVeto.previousManifestSha256 = 'f'.repeat(64); },
        predecessorApproval: f => { f.approval.entryBinanceLeadVeto.previousContinuation.fundingSha256 = 'f'.repeat(64); },
        predecessorReason: f => { f.approval.entryBinanceLeadVeto.previousContinuation.reason = 'user_return_cost_cap'; },
        recursiveVeto: f => { f.approval.entryBinanceLeadVeto.previousContinuation.entryBinanceLeadVeto = {}; },
        changedPreviousManifest: f => { fs.appendFileSync(f.previousFile, '\n'); },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        await t.test(name, t => {
            const f = continuationFixture(t);
            mutate(f);
            f.repin();
            assert.throws(f.bind, /eligible_(continuation|period)_/);
        });
    }
});
