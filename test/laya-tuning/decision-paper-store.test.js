import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DecisionPaperStore } from '../../src/decision-paper/store.js';
import { DECISION_ARMS, loadDecisionPaperConfig } from '../../src/decision-paper/config.js';
import { parseArgs, writeReportAsync, inferenceAvailable } from '../../scripts/decision-paper.js';

function fixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-paper-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const config = loadDecisionPaperConfig({ NINEROUTER_KEY: 'never-publish-this', PRIVATE_KEY: '' }, dataDir);
    return { config, store: new DecisionPaperStore(config, 1000) };
}

test('period pins both complete prompts and source without writing private configuration', t => {
    const { config, store } = fixture(t);
    assert.deepEqual(config.armNames, ['laya', 'laya-filtered', 'gemini', 'eligible', 'skip']);
    assert.equal(config.entryFilter.minBufferSigma, 1);
    assert.equal(config.geminiModel, 'polymarket-decision');
    assert.equal(config.geminiResolvedModel, 'ag/gemini-3.8-flash-low');
    assert.equal(config.geminiDrainMs, 120000); assert.equal(config.geminiCooldownMs, 120000);
    assert.match(config.geminiPromptHash, /^[a-f0-9]{64}$/);
    assert.match(config.informedPromptHash, /^[a-f0-9]{64}$/);
    assert.equal(config.decisionProtocol.variantId, 'candidate-v2');
    assert.equal(config.policy.deadline, null); assert.equal(config.policy.maxMarkets, null);
    assert.ok(config.sources.some(([name]) => name === 'scripts/decision-prompt-replay.js'));
    assert.ok(config.sources.some(([name]) => name === 'src/decision-paper/gemini.js'));
    assert.ok(!fs.readFileSync(path.join(store.dir, 'manifest.json'), 'utf8').includes('never-publish-this'));
    assert.equal(loadDecisionPaperConfig({ NINEROUTER_KEY: 'different-private-key' }, config.dataDir).id, config.id);
    for (const arm of Object.values(store.state.arms)) assert.equal(arm.cash, 20);
    assert.throws(() => new DecisionPaperStore({ ...config, id: 'new-policy' }), /baseline_changed/);
});

test('crash before decision initialization becomes explicit no-entry for all arms', t => {
    const { config, store } = fixture(t);
    store.state.snapshots.push({ snapshotId: 'first', market: 'm', at: 1000, decisions: {}, providerDecisions: {}, inferenceAttempts: {} });
    store.save();
    const resumed = new DecisionPaperStore(config, 2000).state;
    for (const name of DECISION_ARMS) {
        const row = resumed.snapshots[0].decisions[name];
        assert.equal(row.status, 'restart_before_decision');
        assert.equal(row.entryDisposition, 'no_buy_decision');
        assert.equal(row.inferenceAttempted, false);
    }
});

test('restart preserves matched inventory, risk stop, and unknown cost of an interrupted Gemini request', t => {
    const { config, store } = fixture(t);
    const arm = store.state.arms.laya;
    arm.position = { status: 'matched', market: { slug: 'm' }, holdings: 2 };
    arm.seen.m = { snapshotId: 's', at: 1100 }; arm.stopped = { at: 1200, reason: 'research_drawdown_limit' };
    arm.drawdown = 10.1; arm.shadowStop = { at: 1150, drawdown: 2.2 };
    store.state.providers.gemini = { pending: { snapshotId: 's' }, attempted: { s: 1000 } };
    store.state.snapshots.push({ snapshotId: 's', market: 'm', at: 1000,
        decisions: { laya: { action: 'BUY_UP', status: 'ok', entryDisposition: 'reserved' } },
        providerDecisions: { gemini: { action: 'SKIP', status: 'pending', cost: 0 } },
        inferenceAttempts: { laya: true, gemini: true } });
    store.save();
    const resumed = new DecisionPaperStore(config, 2000).state;
    assert.deepEqual(resumed.arms.laya, arm);
    assert.equal(resumed.providers.gemini.disabled, undefined);
    assert.equal(resumed.providers.gemini.recoveryReason, 'restart_with_unknown_inference');
    assert.equal(resumed.providers.gemini.recoveryAt, 242000);
    assert.equal(resumed.providers.gemini.attempted.s, 1000);
    const snapshot = resumed.snapshots[0];
    assert.equal(snapshot.decisions.laya.action, 'BUY_UP');
    assert.equal(snapshot.decisions.gemini.status, 'restart_with_unknown_inference');
    assert.equal(snapshot.decisions.gemini.cost, null);
    assert.equal(snapshot.decisions.gemini.inferenceAttempted, true);
    assert.equal(snapshot.decisions.eligible.status, 'restart_before_decision');
});

test('another restart preserves an existing cooldown and does not reset risk or completed results', t => {
    const { config, store } = fixture(t);
    store.state.providers.gemini = { recoveryAt: 500000, recoveryReason: 'drain_timeout', pending: null,
        attempted: { old: 1000 } };
    store.state.arms.gemini.cash = 17; store.state.arms.gemini.drawdown = 11;
    store.state.arms.gemini.stopped = { at: 1500, reason: 'research_drawdown_limit' };
    store.save();
    const resumed = new DecisionPaperStore(config, 2000).state;
    assert.equal(resumed.providers.gemini.recoveryAt, 500000);
    assert.equal(resumed.providers.gemini.attempted.old, 1000);
    assert.equal(resumed.arms.gemini.cash, 17);
    assert.equal(resumed.arms.gemini.stopped.reason, 'research_drawdown_limit');
});

test('restart preserves interrupted diagnostic classification and never creates another provider for the filter', t => {
    const { config, store } = fixture(t);
    for (const name of ['laya', 'laya-filtered', 'gemini'])
        store.state.arms[name].stopped = { at: 1200, reason: 'research_drawdown_limit' };
    store.state.snapshots.push({ snapshotId: 's', market: 'm', at: 1500, decisions: {},
        providerDecisions: { laya: { status: 'pending', diagnosticOnly: true },
            gemini: { status: 'pending', diagnosticOnly: true } },
        inferenceAttempts: { laya: true, gemini: true } });
    store.save(); const resumed = new DecisionPaperStore(config, 2000).state;
    for (const name of ['laya', 'gemini']) {
        assert.equal(resumed.snapshots[0].providerDecisions[name].diagnosticOnly, true);
        assert.equal(resumed.snapshots[0].providerDecisions[name].status, 'restart_with_unknown_inference');
    }
    assert.equal(resumed.snapshots[0].decisions['laya-filtered'].inferenceAttempted, false);
    assert.equal(resumed.snapshots[0].decisions['laya-filtered'].inferenceSource, 'laya');
    assert.equal(resumed.arms['laya-filtered'].stopped.reason, 'research_drawdown_limit');
});

test('restart cancels unexecuted virtual entry without allowing a second attempt', t => {
    const { config, store } = fixture(t);
    store.state.arms.eligible.position = { status: 'pending', market: { slug: 'm' } };
    store.state.arms.eligible.seen.m = { snapshotId: 's', at: 1000 };
    store.save();
    const resumed = new DecisionPaperStore(config, 2000).state;
    assert.equal(resumed.arms.eligible.position, null);
    assert.equal(resumed.arms.eligible.outcomes.m.reason, 'restart_during_pending_execution');
    assert.equal(resumed.arms.eligible.seen.m.snapshotId, 's');
});

test('report worker keeps provider costs separate and cannot mutate ledger', async t => {
    const { config, store } = fixture(t), before = fs.readFileSync(store.filename, 'utf8');
    const result = await writeReportAsync(config);
    assert.equal(result.id, config.id);
    assert.equal(fs.readFileSync(store.filename, 'utf8'), before);
    const report = JSON.parse(fs.readFileSync(path.join(store.dir, 'reports/latest.json')));
    assert.deepEqual(Object.keys(report.arms), DECISION_ARMS);
    assert.equal(report.sufficientForLive, false);
    assert.ok(report.providerInference.gemini);
});

test('CLI cannot launch live, erase history, or accept relative outputs', () => {
    assert.equal(parseArgs(['report', '--out=/tmp/test', '--history']).history, true);
    for (const args of [['live'], ['run'], ['run', '--out=relative'], ['run', '--out=/tmp/a', '--reset'],
        ['run', '--out=/tmp/a', '--out=/tmp/b'], ['report', '--out=/tmp/a', '--smoke']]) assert.throws(() => parseArgs(args));
});

test('service guard allows its own runner but blocks another paper or unknown service status', async () => {
    const units = ['polymarket-laya-live.service', 'polymarket-laya-paper.service', 'polymarket-ai-shadow.service',
        'polymarket-laya-filter-paper.service', 'polymarket-decision-paper.service'];
    const output = (activePid = 0) => units.map(unit => `Id=${unit}\nActiveState=${unit === units[3] && activePid ? 'active' : 'inactive'}\nMainPID=${unit === units[3] ? activePid : 0}`).join('\n\n');
    assert.equal(await inferenceAvailable(async () => ({ stdout: output() }), 123), true);
    assert.equal(await inferenceAvailable(async () => ({ stdout: output(123) }), 123), true);
    assert.equal(await inferenceAvailable(async () => ({ stdout: output(124) }), 123), false);
    assert.equal(await inferenceAvailable(async () => ({ stdout: '' }), 123), false);
    assert.equal(await inferenceAvailable(async () => { throw new Error('timeout'); }, 123), false);
});
