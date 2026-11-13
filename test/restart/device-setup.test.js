import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deviceMain, installDeviceUnit, quoteSystemd, renderDeviceUnit } from '../../scripts/device.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function directoryFixture(t) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'device-setup-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    return { temp, directory: path.join(temp, 'units') };
}

function controllerFixture(overrides = {}, preflightCode = 0) {
    const calls = [], output = [];
    const report = { operationalReady: true, readyForLive: true, startAllowed: true, recoveryOnly: false,
        automaticActivation: false, otherPilotHistory: false, blockers: [], checks: [], balance: 20,
        provider: { laya: { ready: true } }, ...overrides };
    const run = async (file, args, options) => {
        calls.push([file, ...args]);
        if (file === process.execPath) return { code: preflightCode, stdout: JSON.stringify(report) };
        return { code: 0, stdout: 'ActiveState=active\nMainPID=123\n' };
    };
    return { calls, output, ops: { run, nodeVersion: '24.20.0', write: line => output.push(line) } };
}

test('device help is the default and cannot install or run commands', async () => {
    for (const args of [[], ['help'], ['--help'], ['-h']]) {
        const output = [];
        const fail = () => assert.fail('help must not operate on the device');
        assert.equal(await deviceMain(args, { run: fail, install: fail, write: line => output.push(line), nodeVersion: '22.0.0' }), 0);
        assert.ok(output.some(line => line.includes('--mode=paper|live')));
    }
});

test('operational commands require Node 24 before installation or subprocesses', async () => {
    for (const version of ['22.20.0', '23.1.0', '25.0.0', '124.0.0']) {
        for (const args of [['install'], ['live', 'start'], ['paper']]) {
            const fail = () => assert.fail('wrong Node version must not operate on the device');
            await assert.rejects(deviceMain(args, { run: fail, install: fail, nodeVersion: version }), /device_requires_node_24/);
        }
    }
});

test('unit rendering substitutes device paths and escapes systemd arguments', () => {
    const root = '/srv/trading space/100%/quote"back\\slash/$project';
    const node = '/opt/node 24/100%/$node';
    const home = '/home/user space/100%/$user';
    for (const mode of ['paper', 'live']) {
        const content = renderDeviceUnit({ root, node, home, mode, template: path.join(ROOT, 'deploy', `polymarket-laya-${mode}.service`) });
        assert.ok(content.includes('WorkingDirectory=/srv/trading space/100%%/quote"back\\slash/$project\n'));
        assert.ok(content.includes('EnvironmentFile=-/home/user space/100%%/$user/.config/polymarket-ai-shadow.env\n'));
        assert.ok(content.includes('ExecStart=:"/opt/node 24/100%%/$node"'));
        assert.equal(content.includes('/home/legacy-device/'), false);
        if (mode === 'live') {
            assert.ok(content.includes('"scripts/laya-live.js" "run" "--live"'));
            assert.equal(content.includes('[Install]'), false);
            assert.ok(content.includes('Restart=no'));
        } else {
            assert.ok(content.includes('"scripts/laya-pilot.js" "paper"'));
            assert.ok(content.includes('StandardOutput=journal\nStandardError=journal'));
            assert.equal(content.includes('append:'), false);
        }
    }
});

test('invalid paths and malformed templates cannot generate unit directives', t => {
    assert.throws(() => quoteSystemd('/home/user\nExecStart=/unsafe'), /device_invalid_unit_path/);
    assert.throws(() => quoteSystemd('/home/user\0'), /device_invalid_unit_path/);
    assert.throws(() => renderDeviceUnit({ node: 'node' }), /device_requires_absolute_paths/);
    assert.throws(() => renderDeviceUnit({ node: '/opt/node"bin' }), /device_unsupported_node_path/);
    assert.throws(() => renderDeviceUnit({ mode: 'other' }), /device_invalid_mode/);
    const { temp } = directoryFixture(t), template = path.join(temp, 'template');
    fs.writeFileSync(template, '[Service]\nWorkingDirectory=/one\nWorkingDirectory=/two\n');
    assert.throws(() => renderDeviceUnit({ template }), /device_invalid_unit_template/);
});

test('working directory paths ending in a space or backslash cannot alter unit lines', () => {
    const template = path.join(ROOT, 'deploy', 'polymarket-laya-live.service');
    for (const root of ['/srv/project ', '/srv/project\\']) {
        const content = renderDeviceUnit({ root, mode: 'live', template });
        assert.ok(content.includes(`WorkingDirectory=${root}/.\nEnvironmentFile=`));
    }
});

test('install defaults to paper, creates a private portable unit, and is idempotent', async t => {
    const { directory } = directoryFixture(t), calls = [], output = [];
    const options = { directory, nodeVersion: '24.20.0', run: (...args) => calls.push(args), write: line => output.push(line) };
    assert.equal(await deviceMain(['install'], options), 0);
    const destination = path.join(directory, 'polymarket-laya-paper.service');
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(destination, 'utf8'), renderDeviceUnit());
    assert.equal(await deviceMain(['install', '--mode=paper'], options), 0);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(path.join(directory, 'polymarket-laya-live.service')), false);
    assert.ok(output.some(line => line.includes('Belum dijalankan')));
});

test('explicit live install does not run preflight, reload, enable, or start', async t => {
    const { directory } = directoryFixture(t);
    assert.equal(await deviceMain(['install', '--mode=live'], { directory, nodeVersion: '24.0.0', write() {},
        run: () => assert.fail('install must not execute processes') }), 0);
    assert.equal(fs.readFileSync(path.join(directory, 'polymarket-laya-live.service'), 'utf8'), renderDeviceUnit({ mode: 'live' }));
});

test('existing mismatched or symlinked units are preserved and rejected', t => {
    const { temp, directory } = directoryFixture(t);
    fs.mkdirSync(directory);
    const destination = path.join(directory, 'polymarket-laya-live.service');
    fs.writeFileSync(destination, 'existing active device unit\n');
    assert.throws(() => installDeviceUnit({ mode: 'live', directory }), /device_installed_unit_differs/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing active device unit\n');
    const otherDirectory = path.join(temp, 'symlinked-units'); fs.mkdirSync(otherDirectory);
    const target = path.join(temp, 'target'); fs.writeFileSync(target, renderDeviceUnit({ mode: 'live' }));
    fs.symlinkSync(target, path.join(otherDirectory, 'polymarket-laya-live.service'));
    assert.throws(() => installDeviceUnit({ mode: 'live', directory: otherDirectory }), /device_installed_unit_differs/);
    assert.equal(fs.readFileSync(target, 'utf8'), renderDeviceUnit({ mode: 'live' }));
});

test('blocked portable live start keeps the original guard and creates no unit', async t => {
    const { directory } = directoryFixture(t);
    const f = controllerFixture({ readyForLive: false, startAllowed: false, blockers: ['persistent_pilot_stop'] }, 1);
    assert.equal(await deviceMain(['live', 'start'], { ...f.ops, directory }), 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].at(-1), 'preflight');
    assert.equal(fs.existsSync(directory), false);
});

test('portable live start installs only after preflight and retains manual activation', async t => {
    const { directory } = directoryFixture(t), f = controllerFixture();
    assert.equal(await deviceMain(['live', 'start'], { ...f.ops, directory }), 0);
    assert.deepEqual(f.calls.map(call => call[0] === process.execPath ? call.at(-1) : call.slice(0, 3)), [
        'preflight', ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'start'], ['systemctl', '--user', 'show'],
    ]);
    assert.equal(fs.readFileSync(path.join(directory, 'polymarket-laya-live.service'), 'utf8'), renderDeviceUnit({ mode: 'live' }));
    assert.equal(f.calls.flat().includes('enable'), false);
    assert.equal(f.calls.flat().includes('restart'), false);
});

test('portable start refuses a mismatched existing unit before service mutation', async t => {
    const { directory } = directoryFixture(t), f = controllerFixture();
    fs.mkdirSync(directory);
    const destination = path.join(directory, 'polymarket-laya-live.service'); fs.writeFileSync(destination, 'existing running unit');
    await assert.rejects(deviceMain(['live', 'start'], { ...f.ops, directory }), /device_installed_unit_differs/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].at(-1), 'preflight');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing running unit');
});

test('portable check, config, status, logs, and stop retain controller behavior', async () => {
    for (const command of ['check', 'config', 'status', 'logs', 'stop']) {
        const f = controllerFixture();
        assert.equal(await deviceMain(['live', command], { ...f.ops, install: () => assert.fail('only start may install') }), 0);
        assert.equal(f.calls.flat().includes('daemon-reload'), false);
        assert.equal(f.calls.flat().includes('start'), false);
    }
});

test('paper runs the paper entry with Node 24 and inherited terminal output', async () => {
    const calls = [];
    assert.equal(await deviceMain(['paper'], { nodeVersion: '24.20.0', run: async (...args) => {
        calls.push(args); return { code: 7 };
    } }), 7);
    assert.deepEqual(calls, [[process.execPath, [path.join(ROOT, 'scripts', 'laya-pilot.js'), 'paper'], { cwd: ROOT, inherit: true }]]);
});

test('invalid arguments never reach installation or service commands', async () => {
    for (const args of [['install', '--mode=other'], ['install', '--mode=live', '--force'], ['live', 'restart'],
        ['live', 'start', '--force'], ['paper', '--live'], ['start'], ['help', 'start']]) {
        const fail = () => assert.fail('invalid arguments must not operate on the device');
        await assert.rejects(deviceMain(args, { run: fail, install: fail, nodeVersion: '24.20.0' }));
    }
});
