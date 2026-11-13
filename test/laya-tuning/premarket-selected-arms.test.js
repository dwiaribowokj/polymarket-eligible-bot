import test from 'node:test';
import assert from 'node:assert/strict';
import { PREMARKET_ARMS, loadPremarketPaperConfig, parsePremarketActiveArms,
    selectedPremarketProviders } from '../../src/premarket-paper/config.js';

test('active arms require a nonempty unique known selection and normalize to canonical order', () => {
    assert.deepEqual(parsePremarketActiveArms(), [...PREMARKET_ARMS]);
    assert.deepEqual(parsePremarketActiveArms('router-premarket, premarket-momentum'), ['premarket-momentum', 'router-premarket']);
    for (const value of ['', ' ', ',', 'router-premarket,', ',router-premarket', 'router-premarket,router-premarket',
        'all', 'gpt', 'Router-premarket', null, ['router-premarket']])
        assert.throws(() => parsePremarketActiveArms(value), /premarket_active_arms_invalid/);
});

test('selected arms are fingerprinted while all ledger arms remain available', () => {
    const full = loadPremarketPaperConfig({}, '/tmp/premarket-config-tests');
    const router = loadPremarketPaperConfig({ PREMARKET_ACTIVE_ARMS: 'router-premarket' }, '/tmp/premarket-config-tests');
    const mixed = loadPremarketPaperConfig({ PREMARKET_ACTIVE_ARMS: 'router-premarket,premarket-momentum' }, '/tmp/premarket-config-tests');
    const canonical = loadPremarketPaperConfig({ PREMARKET_ACTIVE_ARMS: 'premarket-momentum,router-premarket' }, '/tmp/premarket-config-tests');
    assert.deepEqual(full.activeArms, [...PREMARKET_ARMS]);
    assert.deepEqual(router.armNames, [...PREMARKET_ARMS]);
    assert.deepEqual(router.policy.activeArms, ['router-premarket']);
    assert.notEqual(full.id, router.id);
    assert.notEqual(mixed.id, router.id);
    assert.equal(mixed.id, canonical.id);
});

test('provider requirements include only selected provider arms and preserve legacy fixture defaults', () => {
    const config = { armNames: [...PREMARKET_ARMS], providerArms: { 'laya-premarket': 'laya', 'router-premarket': 'router' } };
    assert.deepEqual(selectedPremarketProviders(config), ['laya', 'router']);
    assert.deepEqual(selectedPremarketProviders({ ...config, activeArms: ['router-premarket'] }), ['router']);
    assert.deepEqual(selectedPremarketProviders({ ...config, activeArms: ['laya-premarket'] }), ['laya']);
    assert.deepEqual(selectedPremarketProviders({ ...config, activeArms: ['premarket-momentum', 'late-cost-cap'] }), []);
});

test('near-open profile freezes thirty complete minutes and a sixty-second lead in a separate identity', () => {
    const legacy = loadPremarketPaperConfig({}, '/tmp/premarket-config-tests');
    const near = loadPremarketPaperConfig({ PREMARKET_PROFILE: 'near-open-30m-v1' }, '/tmp/premarket-config-tests');
    assert.equal(legacy.leadSeconds, 240); assert.equal(legacy.candleCount, 3);
    assert.equal(near.leadSeconds, 60); assert.equal(near.candleCount, 30);
    assert.equal(near.historyMs, 1800000); assert.equal(near.diagnosticHistoryMs, 1800000);
    assert.equal(near.aiDecisionMs, 30000); assert.equal(near.routerModel, legacy.routerModel);
    assert.deepEqual(near.activeArms, ['router-premarket']); assert.notEqual(near.id, legacy.id);
    for (const arms of ['laya-premarket', 'router-premarket,laya-premarket', 'premarket-momentum'])
        assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: near.profile, PREMARKET_ACTIVE_ARMS: arms }, '/tmp/premarket-config-tests'),
            /premarket_long_history_requires_router_only/);
    assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: 'random' }, '/tmp/premarket-config-tests'), /premarket_profile_invalid/);
});
