import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { controlMain, installUnit, parseControlArgs } from '../../scripts/laya-live-control.js';
import { ROOT } from '../../src/restart/config.js';

function fixture(overrides = {}, code = 0) {
    const calls = [], output = [];
    const report = { operationalReady: true, readyForLive: true, startAllowed: true, recoveryOnly: false,
        automaticActivation: false, otherPilotHistory: false, blockers: [], checks: [], balance: 20.465657,
        provider: { laya: { ready: true } }, ...overrides };
    const ops = { write: line => output.push(line), install: () => calls.push(['install']),
        run: async (file, args) => {
            calls.push([file, ...args]);
            return file === process.execPath ? { code, stdout: JSON.stringify(report) }
                : { code: 0, stdout: 'ActiveState=active\nMainPID=123\n' };
        } };
    return { calls, output, ops };
}

test('control defaults to status and accepts only explicit commands', () => {
    assert.equal(parseControlArgs([]), 'status'); assert.equal(parseControlArgs(['start']), 'start');
    for (const args of [['--live'], ['start', '--force'], ['restart'], ['start', 'stop']]) assert.throws(() => parseControlArgs(args));
    const wrapper = path.join(ROOT, 'scripts/laya-live');
    assert.equal(spawnSync('bash', ['-n', wrapper]).status, 0);
    assert.equal(spawnSync(wrapper, ['help'], { env: { ...process.env, POLYMARKET_NODE: process.execPath } }).status, 0);
});

test('blocked start cannot install, start, reset a stop, or submit an order', async () => {
    const f = fixture({ readyForLive: false, startAllowed: false, blockers: ['persistent_pilot_stop'] }, 1);
    assert.equal(await controlMain(['start'], f.ops), 1);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].at(-1), 'preflight');
    assert.ok(f.output.some(line => line.includes('persistent_pilot_stop')));
});

test('successful check and config remain read-only and never install a live service', async () => {
    for (const command of ['check', 'config']) {
        const f = fixture(); assert.equal(await controlMain([command], f.ops), 0);
        assert.equal(f.calls.length, 1); assert.equal(f.calls[0].at(-1), command === 'check' ? 'preflight' : 'config');
    }
});

test('status reads the existing report and systemd status without a funding trigger', async () => {
    const f = fixture({ liveStarted: false, rehearsal: { found: true, netTradingPnl: -4.01006, riskStopActive: true } });
    assert.equal(await controlMain([], f.ops), 0); assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].at(-1), 'report'); assert.ok(f.calls[1].includes('show'));
    assert.ok(f.output.some(line => line.includes('-4.01006')));
});

test('manual start checks before installing and starting the unit, without enable or restart', async () => {
    const f = fixture(); assert.equal(await controlMain(['start'], f.ops), 0);
    assert.deepEqual(f.calls.map(call => call[0] === process.execPath ? call.at(-1) : call.slice(0, 3)), [
        'preflight', ['install'], ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'start'], ['systemctl', '--user', 'show'],
    ]);
    assert.equal(f.calls.flat().includes('enable'), false); assert.equal(f.calls.flat().includes('restart'), false);
});

test('manual start accepts paper warnings and unrestricted startup capital after a successful preflight', async () => {
    const f = fixture({ balance: 18.18504, requiredBalance: 0, allocatedCapital: 18.18504, capitalCap: null,
        warnings: ['rehearsal_risk_stop_recorded'] });
    assert.equal(await controlMain(['start'], f.ops), 0);
    assert.ok(f.calls.some(call => call.includes('start')));
    assert.ok(f.output.some(line => line.includes('rehearsal_risk_stop_recorded')));
    assert.ok(f.output.some(line => line.includes('Alokasi modal: 18.18504')));
    assert.ok(f.output.some(line => line.includes('tanpa batas modal startup')));
});

test('unknown or contradictory preflight output cannot start a service', async () => {
    for (const changes of [{ readyForLive: undefined }, { automaticActivation: true }, { startAllowed: false }, { blockers: ['stop'] }]) {
        const f = fixture(changes); assert.equal(await controlMain(['start'], f.ops), 1); assert.equal(f.calls.length, 1);
    }
});

test('manual start can recover open inventory while retaining the entry stop', async () => {
    const changes = { readyForLive: false, startAllowed: true, recoveryOnly: true, blockers: ['persistent_pilot_stop'] };
    const f = fixture(changes, 1); assert.equal(await controlMain(['start'], f.ops), 0);
    assert.ok(f.output.some(line => line.includes('Hanya recovery')));
    const check = fixture(changes, 1); assert.equal(await controlMain(['check'], check.ops), 1);
    assert.equal(check.calls.length, 1);
});

test('unit installation is idempotent and preserves a different existing unit', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laya-unit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const template = path.join(dir, 'template'), directory = path.join(dir, 'units');
    fs.writeFileSync(template, '[Service]\nRestart=no\n'); installUnit({ template, directory });
    const installed = path.join(directory, 'polymarket-laya-live.service');
    assert.equal(fs.statSync(installed).mode & 0o777, 0o600); installUnit({ template, directory });
    fs.writeFileSync(installed, 'custom'); assert.throws(() => installUnit({ template, directory }), /installed_live_unit_differs/);
    assert.equal(fs.readFileSync(installed, 'utf8'), 'custom');
});

test('stop only stops the named live unit', async () => {
    const f = fixture(); assert.equal(await controlMain(['stop'], f.ops), 0);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1], ['systemctl', '--user', 'stop', 'polymarket-laya-live.service']);
});

test('stop is harmless before a live unit has ever been installed', async () => {
    const calls = [];
    assert.equal(await controlMain(['stop'], { write() {}, run: async (file, args) => {
        calls.push([file, ...args]); return { code: 0, stdout: 'not-found\n' };
    } }), 0);
    assert.equal(calls.length, 1); assert.ok(calls[0].includes('show')); assert.equal(calls[0].includes('stop'), false);
});
