import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPremarketPaperConfig } from '../../src/premarket-paper/config.js';
import { EARLY_PROFILE, NEXT_PROFILE } from '../../src/premarket-paper/early-context.js';
import { NEXT_ROUTER_DIRECTIONAL_POLICY } from '../../src/premarket-paper/router-directional.js';

const out = '/tmp/premarket-directional-config-tests';

test('directional router is an explicit next-profile opt-in with a distinct fingerprint', () => {
    const legacy = loadPremarketPaperConfig({ PREMARKET_PROFILE: NEXT_PROFILE }, out);
    const directional = loadPremarketPaperConfig({ PREMARKET_PROFILE: NEXT_PROFILE,
        PREMARKET_ROUTER_POLICY: NEXT_ROUTER_DIRECTIONAL_POLICY }, out);
    assert.equal(Object.hasOwn(legacy.policy, 'routerPolicy'), false);
    assert.equal(directional.routerPolicy, NEXT_ROUTER_DIRECTIONAL_POLICY);
    assert.notEqual(directional.id, legacy.id);
    const { routerPolicy, ...unchanged } = directional.policy;
    assert.deepEqual(unchanged, legacy.policy);
    assert.deepEqual(directional.activeArms, ['premarket-momentum', 'laya-premarket', 'router-premarket']);
});

test('unsupported router policies and profiles are rejected rather than silently ignored', () => {
    for (const routerPolicy of ['', 'legacy', 'next-directional-v2', null, true])
        assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: NEXT_PROFILE,
            PREMARKET_ROUTER_POLICY: routerPolicy }, out), /premarket_router_policy_invalid/);
    for (const profile of [undefined, 'legacy-three-candles-v1', 'near-open-30m-v1', 'fair-near-open-30m-v1', EARLY_PROFILE])
        assert.throws(() => loadPremarketPaperConfig({ PREMARKET_PROFILE: profile,
            PREMARKET_ROUTER_POLICY: NEXT_ROUTER_DIRECTIONAL_POLICY }, out), /premarket_router_policy_invalid/);
});

test('all existing profiles preserve their absent router-policy serialization', () => {
    for (const profile of ['legacy-three-candles-v1', 'near-open-30m-v1', 'fair-near-open-30m-v1', EARLY_PROFILE, NEXT_PROFILE]) {
        const config = loadPremarketPaperConfig({ PREMARKET_PROFILE: profile }, out);
        assert.equal(Object.hasOwn(config.policy, 'routerPolicy'), false);
        assert.equal(config.paperOnly, true);
        assert.equal(config.promotionPolicy, 'never_automatic');
    }
});
