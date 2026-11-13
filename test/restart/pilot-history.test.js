import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASELINE } from '../../src/restart/config.js';
import { atomicJson, otherLiveExposure, pilotHistory, Store } from '../../src/restart/store.js';
import { report, saveReport } from '../../src/restart/report.js';
import { newPosition } from '../../src/restart/strategy.js';

const now = Date.parse('2026-10-18T12:00:00Z');

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-history-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, fingerprint: 'current-paper', dataDir,
        strategies: ['late-entry'], lateSignal: null, evaluationEndsAt: null };
    const closed = { slug: 'btc-updown-15m-1792310400', openedAt: now - 3600000,
        closedAt: now - 2700000, traded: true, pnl: 0.13, fees: 0, gas: 0.02,
        rebate: 0, capitalHours: 1.2, partial: false, oneSided: false, uncertain: false };

    // Original wallet pilots have no Laya provider, funding or AI metadata.
    const legacy = new Store({ ...settings, fingerprint: 'legacy-wallet' }, 'pilot', 'maker-mm');
    Object.assign(legacy.state, { startedAt: now - 86400000, cash: 20.13, peakEquity: 20.13,
        walletStart: 20, walletCashDelta: 0.13, completed: [closed], seen: { [closed.slug]: true } });
    legacy.save();

    const laya = new Store({ ...settings, fingerprint: 'laya-wallet' }, 'pilot', 'late-entry');
    const market = { slug: 'btc-updown-5m-1792324800', conditionId: `0x${'a'.repeat(64)}`,
        tokens: ['1', '2'], outcomes: ['Up', 'Down'], open: now - 280000, end: now + 20000,
        fee: { rate: 0.07, exponent: 1, takerOnly: true } };
    Object.assign(laya.state, { startedAt: now - 7200000, cash: 15.844, peakEquity: 20,
        maxDrawdown: 0.1, walletStart: 20, walletCashDelta: -4.156, decisionProvider: 'laya',
        liveFunding: { initialCapital: 20 }, ai: { snapshots: [], providers: {} },
        completed: [{ ...closed, pnl: -0.1, fees: 0.02, gas: 0.01 }] });
    laya.state.position = newPosition(market, { cost: 4.056 }, laya.state, now - 1000);
    Object.assign(laya.state.position, { startingCash: 19.9, holdings: [5, 0], bought: [5, 0],
        orders: [{ orderId: 'owned-complete', status: 'complete', settled: 5 },
            { orderId: 'owned-pending', status: 'accepted', settled: 0 }] });
    laya.save();

    atomicJson(path.join(laya.directory, 'laya-manifest.json'), { id: laya.state.baseline,
        policy: { schema: 4, provider: 'laya' }, sources: [['src/laya-live/engine.js', 'offline-fixture']],
        startedAt: laya.state.startedAt });
    atomicJson(path.join(laya.directory, 'laya-report.json'), { liveStarted: true,
        baseline: laya.state.baseline, strategy: laya.state.strategy, completedMarkets: 1, netRealizedPnl: -0.1 });
    // Unknown JSON artifacts cannot masquerade as additional strategy ledgers.
    atomicJson(path.join(laya.directory, 'snapshot.json'), laya.state);
    fs.writeFileSync(path.join(laya.directory, 'diagnostic.json'), '{not-a-ledger');
    const files = [legacy.filename, ...fs.readdirSync(laya.directory).map(file => path.join(laya.directory, file))];
    const before = files.map(file => [file, fs.readFileSync(file)]);
    return { settings, legacy, laya, before };
}

test('report and saved checkpoints include legacy wallet and Laya pilots while ignoring auxiliary JSON', t => {
    const f = fixture(t);
    const states = pilotHistory(f.settings);
    assert.equal(states.length, 2);
    assert.equal(states.find(state => state.baseline === 'legacy-wallet').decisionProvider, undefined);
    assert.deepEqual(otherLiveExposure(f.settings), [{ baseline: 'laya-wallet', strategy: 'late-entry' }]);

    const result = report(f.settings, now, true);
    assert.equal(result.pilots.length, 2);
    const legacy = result.pilots.find(pilot => pilot.baseline === 'legacy-wallet');
    assert.equal(legacy.strategy, 'maker-mm');
    assert.equal(legacy.completedMarkets, 1);
    assert.equal(legacy.netRealizedPnl, 0.13);
    assert.equal(legacy.cash, 20.13);
    assert.equal(legacy.fees, 0);
    assert.equal(legacy.gas, 0.02);
    assert.deepEqual(legacy.inventory, [0, 0]);
    const laya = result.pilots.find(pilot => pilot.baseline === 'laya-wallet');
    assert.equal(laya.netRealizedPnl, -0.1);
    assert.equal(laya.activeMarket, f.laya.state.position.market.slug);
    assert.deepEqual(laya.inventory, [5, 0]);
    assert.deepEqual(laya.pendingOrders, ['owned-pending']);

    const saved = saveReport(f.settings, now, true);
    const filename = path.join(f.settings.dataDir, f.settings.fingerprint, 'evaluation-report.json');
    assert.deepEqual(saved, result);
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), result);
    for (const [file, bytes] of f.before) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('manifest and report parse errors do not affect discovery of actual pilot ledgers', t => {
    const f = fixture(t);
    for (const name of ['laya-manifest.json', 'laya-report.json'])
        fs.writeFileSync(path.join(f.laya.directory, name), '{broken-auxiliary');
    assert.equal(report(f.settings, now).pilots.length, 2);
});

test('malformed actual ledgers fail history, exposure checks and reports with the ledger filename', async t => {
    const cases = [
        ['invalid JSON', () => '{bad-json'],
        ['missing completed rows', state => { delete state.completed; return JSON.stringify(state); }],
        ['wrong baseline', state => JSON.stringify({ ...state, baseline: 'another-wallet' })],
        ['wrong mode', state => JSON.stringify({ ...state, mode: 'paper' })],
        ['wrong strategy', state => JSON.stringify({ ...state, strategy: 'maker-mm' })],
        ['invalid cash', state => JSON.stringify({ ...state, cash: null })],
        ['invalid completed row', state => JSON.stringify({ ...state, completed: [null] })],
        ['incomplete traded row', state => JSON.stringify({ ...state, completed: [{ traded: true, pnl: 1 }] })],
        ['invalid position orders', state => JSON.stringify({ ...state,
            position: { ...state.position, orders: null } })],
    ];
    for (const [name, corrupt] of cases) await t.test(name, child => {
        const f = fixture(child);
        fs.writeFileSync(f.laya.filename, corrupt(structuredClone(f.laya.state)));
        for (const read of [() => pilotHistory(f.settings), () => otherLiveExposure(f.settings),
            () => report(f.settings, now), () => saveReport(f.settings, now)]) {
            assert.throws(read, error => error.message.includes(f.laya.filename)
                && !(error instanceof TypeError));
        }
        assert.equal(fs.existsSync(path.join(f.settings.dataDir,
            f.settings.fingerprint, 'evaluation-report.json')), false);
    });
});

test('corrupt legacy strategy files remain visible to report and live exposure guards', t => {
    const f = fixture(t);
    fs.writeFileSync(f.legacy.filename, '{corrupt-legacy-wallet');
    assert.throws(() => pilotHistory(f.settings), error => error.message.includes(f.legacy.filename));
    assert.throws(() => report(f.settings, now), error => error.message.includes(f.legacy.filename));
    assert.throws(() => otherLiveExposure(f.settings), error => error.message.includes(f.legacy.filename));
});
