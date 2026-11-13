import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eligibleEnvironment, loadEligibleConfig, eligibleConfigView } from '../../src/eligible-live/config.js';
import { main, parseEligibleArgs } from '../../scripts/eligible-live.js';
import { Store } from '../../src/restart/store.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-config-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('eligible config needs no AI credentials, model registry, or tokenizer', t => {
    const root = fixture(t);
    const config = loadEligibleConfig({ RESTART_DATA_DIR: root,
        PRIVATE_KEY: 'test-private-value', NINEROUTER_KEY: 'test-router-value',
        AI_SHADOW_ROUTER_DB: '/does-not-exist', AI_SHADOW_LAYA_URL: 'invalid' });
    assert.equal(config.policy.provider, 'eligible');
    assert.equal(config.ai.decisionProtocol, undefined);
    assert.equal(config.ai.control, config.settings);
    assert.equal(config.ai.latencyMs, 250);
    assert.equal(config.ai.dataAgeMs, 5000);
    assert.equal(config.settings.pilotHours, Infinity);
    assert.equal(config.settings.pilotMarkets, Infinity);
    assert.equal(config.settings.drawdownStop, 10);
    assert.equal(config.settings.dataDir, root);
    const view = JSON.stringify(eligibleConfigView(config));
    assert(!view.includes('test-private-value'));
    assert(!view.includes('test-router-value'));
    assert(!view.includes('/does-not-exist'));
    assert.deepEqual(fs.readdirSync(root), []);
});

test('continuous trading requires an exact opt-in and preserves the default policy', t => {
    const env = { RESTART_DATA_DIR: fixture(t) };
    const defaults = loadEligibleConfig(env);
    const disabled = loadEligibleConfig({ ...env, ELIGIBLE_CONTINUOUS_TRADING: 'false' });
    const enabled = loadEligibleConfig({ ...env, ELIGIBLE_CONTINUOUS_TRADING: 'true' });
    assert.equal(defaults.settings.continuousTrading, false);
    assert.equal(disabled.settings.continuousTrading, false);
    assert.equal(Object.hasOwn(defaults.policy, 'continuousTrading'), false);
    assert.equal(disabled.runtimeId, defaults.runtimeId);
    assert.deepEqual(disabled.policy, defaults.policy);
    assert.equal(enabled.settings.continuousTrading, true);
    assert.equal(enabled.settings.drawdownStop, 10);
    assert.deepEqual(enabled.policy, { ...defaults.policy, continuousTrading: true });
    assert.deepEqual(enabled.profitTaking, defaults.profitTaking);
    assert.notEqual(enabled.runtimeId, defaults.runtimeId);
    const view = eligibleConfigView(enabled);
    assert.equal(view.continuousTrading, true);
    assert.equal(view.limits.drawdownStop, null);
    assert.equal(view.limits.drawdownAlertThreshold, 10);
    assert.equal(view.limits.drawdownEnforcement, 'observe_only');
    assert.equal(eligibleConfigView(defaults).limits.drawdownStop, 10);
    assert.deepEqual(fs.readdirSync(env.RESTART_DATA_DIR), []);
    for (const value of ['', 'TRUE', 'True', '1', '0', 'yes', 'true ', true, false, null])
        assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_CONTINUOUS_TRADING: value }),
            /invalid_eligible_continuous_trading/);
});

test('eligible private env uses explicit precedence without changing process environment', t => {
    const root = fixture(t), configFile = path.join(root, 'config.env'), walletFile = path.join(root, 'wallet.env');
    fs.writeFileSync(walletFile, 'PRIVATE_KEY=test-wallet-key\nRESTART_DATA_DIR=/wallet/history\n');
    fs.writeFileSync(configFile, `POLYMARKET_ENV_FILE=${walletFile}\nRESTART_DATA_DIR=/private/history\n`);
    const before = JSON.stringify(process.env);
    const env = eligibleEnvironment({ ELIGIBLE_LIVE_CONFIG: configFile, RESTART_DATA_DIR: '/shell/history' }, root);
    assert.equal(env.PRIVATE_KEY, 'test-wallet-key');
    assert.equal(env.RESTART_DATA_DIR, '/shell/history');
    assert.equal(JSON.stringify(process.env) === before, true, 'environment changed');
    assert.throws(() => eligibleEnvironment({ ELIGIBLE_LIVE_CONFIG: 'relative' }, root), /absolute_path/);
    assert.throws(() => eligibleEnvironment({ ELIGIBLE_LIVE_CONFIG: path.join(root, 'missing') }, root), /unreadable/);
    assert.deepEqual(eligibleEnvironment({}, root), {});
});

test('cost cap is explicit, fingerprinted and shared with entry validation without altering default execution', t => {
    const env = { RESTART_DATA_DIR: fixture(t) };
    const plain = loadEligibleConfig(env), disabled = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP: 'false' });
    const config = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP: 'true' });
    assert.deepEqual(disabled.policy, plain.policy);
    assert.equal(disabled.id, plain.id);
    assert.deepEqual(config.policy.entryFilter, { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: .85,
        gasUsd: .05, basis: 'full_fill_at_frozen_limit' });
    assert.equal(config.ai.entryFilter, config.policy.entryFilter);
    assert.equal(config.settings.entryFilter, config.policy.entryFilter);
    assert.deepEqual(config.policy.execution, plain.policy.execution);
    assert.equal(config.policy.controlBaseline, plain.policy.controlBaseline);
    assert.notEqual(config.id, plain.id);
    assert.deepEqual(eligibleConfigView(config).entryFilter, config.policy.entryFilter);
    for (const value of ['', 'TRUE', 'yes', '.85', true])
        assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP: value }), /invalid_eligible_entry_cost_cap/);
});

test('explicit cost-cap limits are fingerprinted without changing execution, risk, or profit policies', t => {
    const env = { RESTART_DATA_DIR: fixture(t), ELIGIBLE_ENTRY_COST_CAP: 'true',
        ELIGIBLE_CONTINUOUS_TRADING: 'true' };
    const defaults = loadEligibleConfig(env);
    const explicit = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP_MAX: '0.85' });
    const tighter = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP_MAX: '0.82' });
    assert.equal(explicit.runtimeId, defaults.runtimeId);
    assert.deepEqual(explicit.policy, defaults.policy);
    assert.notEqual(tighter.runtimeId, defaults.runtimeId);
    assert.deepEqual(tighter.policy, { ...defaults.policy,
        entryFilter: { ...defaults.policy.entryFilter, maxCostPerShare: .82 } });
    assert.equal(tighter.ai.entryFilter, tighter.policy.entryFilter);
    assert.equal(tighter.settings.entryFilter, tighter.policy.entryFilter);
    assert.deepEqual(tighter.profitTaking, defaults.profitTaking);
    assert.equal(tighter.settings.continuousTrading, true);
    assert.equal(tighter.settings.automaticDeposits, true);
    assert.equal(eligibleConfigView(tighter).entryFilter.maxCostPerShare, .82);
    assert.deepEqual(fs.readdirSync(env.RESTART_DATA_DIR), []);
});

test('cost-cap limit rejects unsupported values and cannot silently activate or bypass another filter', t => {
    const env = { RESTART_DATA_DIR: fixture(t), ELIGIBLE_ENTRY_COST_CAP: 'true' };
    for (const value of ['', '.82', '.85', '0.820', '0.850', '0.81', '0.83', '0.84', '0.86',
        ' 0.82', '0.85 ', '8.2e-1', 'NaN', 'Infinity', .82, .85, true, false, null])
        assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP_MAX: value }),
            /invalid_eligible_entry_cost_cap_max/);
    for (const value of ['0.82', '0.85']) {
        for (const enabled of [undefined, 'false'])
            for (const buffer of [undefined, 'true'])
                assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_COST_CAP: enabled,
                    ELIGIBLE_ENTRY_BUFFER: buffer, ELIGIBLE_ENTRY_COST_CAP_MAX: value }),
                /eligible_entry_cost_cap_max_requires_enabled_cap/);
        assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_BUFFER: 'true',
            ELIGIBLE_ENTRY_COST_CAP_MAX: value }), /eligible_entry_filters_conflict/);
    }
});

test('eligible commands require explicit run --live and reject bypass arguments', () => {
    assert.equal(parseEligibleArgs([]).command, 'preflight');
    assert.equal(parseEligibleArgs(['run', '--live']).explicitLive, true);
    assert.equal(parseEligibleArgs(['new-period']).command, 'new-period');
    assert.throws(() => parseEligibleArgs(['new-period', '--live']));
    for (const args of [['run'], ['start'], ['run', '--live', '--reset'], ['run', '--live', '--live'],
        ['config', '--live'], ['report', '--reset']]) assert.throws(() => parseEligibleArgs(args));
});

test('buffer is an exclusive frozen paper rule with unchanged execution and risk preferences', t => {
    const env = { RESTART_DATA_DIR: fixture(t), ELIGIBLE_CONTINUOUS_TRADING: 'true' };
    const plain = loadEligibleConfig(env);
    const disabled = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_BUFFER: 'false' });
    const buffer = loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_BUFFER: 'true', ELIGIBLE_ENTRY_COST_CAP: 'false' });
    assert.equal(disabled.runtimeId, plain.runtimeId);
    assert.deepEqual(buffer.policy.entryFilter, { version: 'direction-volatility-buffer-v1',
        minBufferSigma: 1, useClosingThreshold: true, requireObservedClosing: true });
    assert.equal(buffer.settings.entryFilter, buffer.policy.entryFilter);
    assert.equal(buffer.ai.entryFilter, buffer.policy.entryFilter);
    assert.deepEqual(buffer.policy.execution, plain.policy.execution);
    assert.deepEqual(buffer.profitTaking, plain.profitTaking);
    assert.equal(buffer.settings.automaticDeposits, true);
    assert.equal(eligibleConfigView(buffer).limits.drawdownEnforcement, 'observe_only');
    assert.notEqual(buffer.runtimeId, plain.runtimeId);
    assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_BUFFER: 'true',
        ELIGIBLE_ENTRY_COST_CAP: 'true' }), /eligible_entry_filters_conflict/);
    for (const value of ['', 'TRUE', 'yes', '1', true, false, null])
        assert.throws(() => loadEligibleConfig({ ...env, ELIGIBLE_ENTRY_BUFFER: value }), /invalid_eligible_entry_buffer/);
});

test('eligible config/report remain read-only and preserve prior stop and history', async t => {
    const root = fixture(t), config = loadEligibleConfig({ RESTART_DATA_DIR: root });
    const old = new Store({ ...config.settings, fingerprint: 'old', capital: 20 }, 'pilot', 'late-entry');
    old.state.decisionProvider = 'laya'; old.state.stopped = { reason: 'drawdown_limit', at: Date.now() };
    old.state.liveRiskStop = { reason: 'drawdown_limit', limit: 10 };
    old.state.maxDrawdown = 10.5; old.save();
    const bytes = fs.readFileSync(old.filename), results = [];
    const deps = { config, write: row => results.push(row), clientFactory: () => { throw new Error('client_created'); } };
    assert.equal(await main(['config'], deps), 0);
    assert.equal(await main(['report'], deps), 0);
    assert.equal(results[1].previousLive.found, true);
    assert.equal(results[1].readyForLive, false);
    assert.equal(results[1].liveStarted, false);
    assert.deepEqual(fs.readFileSync(old.filename), bytes);
    assert.deepEqual(fs.readdirSync(root), ['old']);
});

test('eligible cannot use a new identity to bypass an existing stopped live period', async t => {
    const root = fixture(t), config = loadEligibleConfig({ RESTART_DATA_DIR: root });
    const old = new Store({ ...config.settings, fingerprint: 'old', capital: 20 }, 'pilot', 'late-entry');
    old.state.decisionProvider = 'laya'; old.state.stopped = { reason: 'drawdown_limit', at: Date.now() };
    old.state.liveRiskStop = { reason: 'drawdown_limit', limit: 10 }; old.save();
    const bytes = fs.readFileSync(old.filename), lockCalls = [];
    let released = 0, clients = 0;
    await assert.rejects(main(['run', '--live'], { config, write: () => {},
        acquireLock: async (...args) => { lockCalls.push(args); return async () => { released++; }; },
        clientFactory: () => { clients++; throw new Error('client_created'); } }), /history|stop/);
    assert.deepEqual(lockCalls, [[root, 'pilot']]);
    assert.equal(released, 1); assert.equal(clients, 0);
    assert.deepEqual(fs.readFileSync(old.filename), bytes);
    assert.deepEqual(fs.readdirSync(root), ['old']);
});

test('enabling continuous trading without continuation cannot bypass prior stops', async t => {
    const root = fixture(t), oldConfig = loadEligibleConfig({ RESTART_DATA_DIR: root });
    const old = new Store({ ...oldConfig.settings, capital: 20 }, 'pilot', 'late-entry');
    Object.assign(old.state, { decisionProvider: 'eligible', maxDrawdown: 11,
        stopped: { reason: 'drawdown_limit', at: 1000 }, liveRiskStop: { reason: 'drawdown_limit', limit: 10 } });
    old.save();
    const config = loadEligibleConfig({ RESTART_DATA_DIR: root, ELIGIBLE_CONTINUOUS_TRADING: 'true' });
    const before = fs.readFileSync(old.filename), results = [];
    assert.equal(await main(['report'], { config, write: row => results.push(row),
        clientFactory: () => { throw new Error('client_created'); } }), 0);
    assert.equal(results[0].readyForLive, false);
    for (const code of ['existing_pilot_history_requires_original_period', 'previous_live_pilot_stop',
        'previous_live_risk_stop', 'previous_live_drawdown_stop']) assert.ok(results[0].blockers.includes(code));
    assert.deepEqual(fs.readFileSync(old.filename), before);
});
