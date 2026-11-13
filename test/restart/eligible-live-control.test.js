import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { controlMain, installEligibleUnit, parseControlArgs, renderEligibleUnit, runFile,
    PREFLIGHT_TIMEOUT_MS, UNIT } from '../../scripts/eligible-live-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function directoryFixture(t) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible control '));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    return { temp, root: path.join(temp, 'checkout space'), home: path.join(temp, 'home space'), directory: path.join(temp, 'units') };
}

function fixture(overrides = {}, code = 0) {
    const calls = [], output = [];
    const report = { operationalReady: true, readyForLive: true, startAllowed: true, recoveryOnly: false,
        automaticActivation: false, blockers: [], checks: [], balance: 18.18504, ...overrides };
    const ops = { root: '/srv/checkout space', home: '/srv/eligible home', node: '/opt/node 24/bin/node',
        nodeVersion: '24.20.0', write: line => output.push(line),
        install: options => { calls.push({ file: 'install', options }); return '/private/units/' + UNIT; },
        run: async (file, args, options) => {
            calls.push({ file, args, options });
            return file === ops.node ? { code, stdout: JSON.stringify(report) }
                : { code: 0, stdout: 'LoadState=loaded\nActiveState=active\nMainPID=123\n' };
        } };
    return { calls, output, ops };
}

test('proven automatic external activity recovers only a wallet stop on explicit start', async () => {
    const review = { readyForLive: false, startAllowed: false, recoveryOnly: false, continuousTrading: true,
        blockers: ['persistent_pilot_stop'], stopped: { reason: 'wallet_ledger_mismatch' },
        externalActivityRecoveryAvailable: true, externalActivityReview: { ready: true, balance: 18 } };
    const check = fixture(review, 1);
    assert.equal(await controlMain(['check'], check.ops), 0);
    assert.equal(check.calls.length, 1);
    const start = fixture(review, 1);
    assert.equal(await controlMain(['start'], start.ops), 0);
    assert.ok(start.calls.some(call => call.file === 'systemctl' && call.args.includes('start')));
    for (const change of [{ stopped: { reason: 'drawdown_limit' } }, { operationalReady: false },
        { externalActivityReview: null }, { continuousTrading: false },
        { blockers: ['persistent_pilot_stop', 'persistent_live_risk_stop'] }]) {
        const invalid = fixture({ ...review, ...change }, 1);
        assert.equal(await controlMain(['start'], invalid.ops), 1);
        assert.equal(invalid.calls.length, 1);
    }
});

test('poly defaults to status and rejects extra arguments, arbitrary units, and command injection', async () => {
    assert.equal(parseControlArgs([]), 'status');
    for (const command of ['help', 'status', 'check', 'config', 'new-period', 'install', 'start', 'stop', 'logs'])
        assert.equal(parseControlArgs([command]), command);
    for (const args of [['restart'], ['start', '--force'], ['start', UNIT], ['stop', 'polymarket-laya-live.service'],
        ['start; touch /tmp/no'], ['--live'], ['install', '--enable'], ['logs', '-f'], ['help', 'start'],
        ['new-period', '--live'], ['new-period', '--force'], ['new-period', '--drawdown=0'], ['new-period', 'start']]) {
        const fail = () => assert.fail('invalid arguments cannot execute or install');
        await assert.rejects(controlMain(args, { run: fail, install: fail }));
    }
});

test('help performs no environment, subprocess, or installation operations', async () => {
    const f = fixture();
    assert.equal(await controlMain(['help'], { ...f.ops, root: '/dev/null/invalid', nodeVersion: '22.0.0' }), 0);
    assert.equal(f.calls.length, 0);
    assert.ok(f.output.some(line => line.includes('tanpa AI')));
});

test('operational commands require Node 24', async () => {
    for (const command of ['status', 'check', 'config', 'new-period', 'install', 'start', 'stop', 'logs']) {
        const f = fixture();
        await assert.rejects(controlMain([command], { ...f.ops, nodeVersion: '22.20.0' }), /eligible_requires_node_24/);
        assert.equal(f.calls.length, 0);
    }
});

test('blocked start reports prior drawdown without installing, running systemd, or changing a ledger', async () => {
    const f = fixture({ readyForLive: false, startAllowed: false, blockers: ['persistent_pilot_stop'], previousLive: {
        found: true, periods: [{ stopped: { reason: 'drawdown_limit' }, liveRiskStopped: true,
            maxDrawdown: 0.227, positionOpen: false, withdrawalPending: false }], blockers: ['persistent_pilot_stop'],
    } }, 1);
    assert.equal(await controlMain(['start'], f.ops), 1);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.at(-1), 'preflight');
    assert.ok(f.output.some(line => line.includes('drawdown_limit') && line.includes('0.227')));
    assert.ok(f.output.some(line => line.includes('stop live sebelumnya masih aktif')));
});

test('unknown, contradictory, and recovery-only preflight reports cannot start a service', async () => {
    for (const changes of [{ operationalReady: false }, { readyForLive: undefined }, { startAllowed: false },
        { automaticActivation: true }, { blockers: undefined }, { blockers: 'none' }, { blockers: ['stop'] },
        { recoveryOnly: true }, { readyForLive: false, startAllowed: true, recoveryOnly: true }]) {
        const f = fixture(changes);
        assert.equal(await controlMain(['start'], f.ops), 1);
        assert.equal(f.calls.length, 1);
    }
    const f = fixture({}, 1);
    assert.equal(await controlMain(['start'], f.ops), 1); assert.equal(f.calls.length, 1);
});

test('manual start accepts only the freshly proven fee incident and still checks before systemd', async () => {
    const reviewed = { readyForLive: false, startAllowed: true, recoveryOnly: true,
        blockers: ['persistent_pilot_stop'], reviewedRecovery: { ready: true, reason: 'verified_fill_fee_above_estimate' } };
    const f = fixture(reviewed, 1);
    assert.equal(await controlMain(['start'], f.ops), 0);
    assert.equal(f.calls[0].args.at(-1), 'preflight');
    assert.ok(f.calls.some(call => call.file === 'systemctl' && call.args.includes('start')));
    const check = fixture(reviewed, 1);
    assert.equal(await controlMain(['check'], check.ops), 0);
    assert.equal(check.calls.length, 1);
    for (const changes of [{ operationalReady: false }, { blockers: ['persistent_live_drawdown_stop'] },
        { blockers: ['persistent_pilot_stop', 'persistent_live_risk_stop'] },
        { reviewedRecovery: { ready: true, reason: 'unknown' } }, { startAllowed: false }, { automaticActivation: true }]) {
        const invalid = fixture({ ...reviewed, ...changes }, 1);
        assert.equal(await controlMain(['start'], invalid.ops), 1);
        assert.equal(invalid.calls.length, 1);
    }
});

test('continuous recovery starts only its narrow candidate while check remains read-only', async () => {
    const recovery = { readyForLive: false, startAllowed: false, recoveryOnly: false,
        continuousRecoveryAvailable: true, blockers: ['persistent_pilot_stop'] };
    for (const code of [0, 1]) {
        const f = fixture(recovery, code);
        assert.equal(await controlMain(['start'], f.ops), 0);
        assert.equal(f.calls[0].args.at(-1), 'preflight');
        assert.ok(f.calls.some(call => call.file === 'systemctl' && call.args.includes('start')));
        assert.ok(f.output.some(line => line.includes('Entry menunggu bukti')));
        assert.equal(f.calls.some(call => call.args?.includes('enable')), false);
    }
    const check = fixture(recovery, 1);
    assert.equal(await controlMain(['check'], check.ops), 0);
    assert.equal(check.calls.length, 1);
    for (const changes of [{ continuousRecoveryAvailable: false }, { continuousRecoveryAvailable: 'true' },
        { operationalReady: false }, { startAllowed: true }, { readyForLive: true }, { recoveryOnly: true },
        { automaticActivation: true }, { blockers: [] }, { blockers: undefined },
        { blockers: ['persistent_live_risk_stop'] },
        { blockers: ['persistent_pilot_stop', 'live_preflight_blocked'] },
        { blockers: ['persistent_pilot_stop', 'persistent_live_drawdown_stop'] }]) {
        const invalid = fixture({ ...recovery, ...changes }, 1);
        assert.equal(await controlMain(['start'], invalid.ops), 1);
        assert.equal(invalid.calls.length, 1);
    }
    const failed = fixture(recovery, 2);
    assert.equal(await controlMain(['start'], failed.ops), 1);
    assert.equal(failed.calls.length, 1);
});

test('malformed preflight output fails without echoing subprocess errors or installing', async () => {
    for (const stdout of ['', 'not JSON private_key=hidden-value', 'null', '[]']) {
        const f = fixture();
        f.ops.run = async (...args) => { f.calls.push(args); return { code: 1, stdout, stderr: 'private secret' }; };
        await assert.rejects(controlMain(['start'], f.ops), /eligible_preflight_report_unavailable/);
        assert.equal(f.calls.length, 1);
        assert.deepEqual(f.output, ['Memeriksa wallet, order, dan deposit. Batas waktu 10 menit.',
            'Laporan pemeriksaan tidak tersedia. Startup tidak dilanjutkan.']);
    }
});

test('preflight alone gets ten minutes and emits progress until the report completes', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const f = fixture(), run = f.ops.run;
    let finish;
    f.ops.run = async (...args) => {
        const result = await run(...args);
        await new Promise(resolve => { finish = resolve; });
        return result;
    };
    const pending = controlMain(['check'], f.ops);
    await Promise.resolve();
    assert.equal(f.output[0], 'Memeriksa wallet, order, dan deposit. Batas waktu 10 menit.');
    assert.equal(f.calls[0].options.timeoutMs, 600000);
    assert.equal(f.calls[0].options.killSignal, 'SIGKILL');
    t.mock.timers.tick(45000);
    assert.deepEqual(f.output.slice(1), [15, 30, 45].map(seconds =>
        `Pemeriksaan wallet, order, dan deposit masih berjalan (${seconds} detik).`));
    finish(); assert.equal(await pending, 0);
    const after = [...f.output];
    t.mock.timers.tick(600000); assert.deepEqual(f.output, after);
    assert.equal(f.calls.length, 1);
    for (const command of ['config', 'status', 'new-period']) {
        const other = fixture({ created: true, id: 'period', runtimeId: 'runtime', drawdownStop: 10, openingBalance: 1 });
        assert.equal(await controlMain([command], other.ops), 0);
        assert.equal(Object.hasOwn(other.calls[0].options, 'timeoutMs'), false);
        assert.equal(Object.hasOwn(other.calls[0].options, 'killSignal'), false);
    }
});

test('timeout, unavailable report and subprocess rejection clear progress and never start or leak output', async t => {
    for (const mode of ['timeout', 'empty', 'invalid', 'rejected', 'failed']) await t.test(mode, async t => {
        t.mock.timers.enable({ apis: ['setInterval'] });
        const f = fixture(), secret = 'fixture-preflight-secret';
        let complete;
        f.ops.run = async (file, args, options) => {
            f.calls.push({ file, args, options });
            await new Promise(resolve => { complete = resolve; });
            if (mode === 'rejected') throw new Error(secret);
            const stdout = mode === 'empty' ? '' : mode === 'invalid' ? secret : JSON.stringify({
                operationalReady: true, readyForLive: true, startAllowed: true, recoveryOnly: false,
                automaticActivation: false, blockers: [], detail: secret,
            });
            return { code: mode === 'failed' ? 2 : 0, stdout, stderr: secret, timedOut: mode === 'timeout' };
        };
        const pending = controlMain(['start'], { ...f.ops, env: { PRIVATE_KEY: secret } });
        t.mock.timers.tick(30000); complete();
        if (mode === 'failed') assert.equal(await pending, 1);
        else await assert.rejects(pending, error => error.message === (mode === 'timeout'
            ? 'eligible_preflight_timeout' : 'eligible_preflight_report_unavailable'));
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].args.at(-1), 'preflight');
        assert.equal(f.output.join('\n').includes(secret), false);
        const after = [...f.output]; t.mock.timers.tick(600000); assert.deepEqual(f.output, after);
        if (mode === 'timeout') assert.ok(f.output.some(line => line.includes('10 menit dan dihentikan')));
    });
});

test('runFile enforces the requested bound and kills the timed-out child, preserving normal exit behavior', async () => {
    const timedOut = await runFile(process.execPath, ['-e',
        'process.stdout.write(String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { timeoutMs: 150, killSignal: 'SIGKILL' });
    assert.equal(timedOut.timedOut, true); assert.equal(timedOut.code, 1);
    const pid = Number(timedOut.stdout);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    const failed = await runFile(process.execPath, ['-e', 'process.stdout.write("done"); process.exitCode = 3;']);
    assert.equal(failed.code, 3); assert.equal(failed.stdout, 'done'); assert.equal(failed.timedOut, false);
    const absent = await runFile('/missing-eligible-control-node', []);
    assert.equal(absent.code, 1); assert.equal(absent.timedOut, false);
});

test('check and config are read-only and use the selected checkout and executable', async () => {
    for (const command of ['check', 'config']) {
        const f = fixture();
        assert.equal(await controlMain([command], f.ops), 0);
        assert.deepEqual(f.calls, [{ file: f.ops.node,
            args: [path.join(f.ops.root, 'scripts', 'eligible-live.js'), command === 'check' ? 'preflight' : 'config'],
            options: { cwd: f.ops.root, env: process.env,
                ...(command === 'check' ? { timeoutMs: PREFLIGHT_TIMEOUT_MS, killSignal: 'SIGKILL' } : {}) } }]);
    }
});

test('new-period only forwards preparation and explains retained history and manual activation', async () => {
    const f = fixture({ created: true, id: 'eligible-new-period', runtimeId: 'eligible-runtime', drawdownStop: 10,
        openingBalance: 18.18504, previousLive: { found: true, periods: [{ stopped: { reason: 'drawdown_limit' },
            liveRiskStopped: true, maxDrawdown: 10.5, positionOpen: false, withdrawalPending: false }] } });
    assert.equal(await controlMain(['new-period'], f.ops), 0);
    assert.deepEqual(f.calls, [{ file: f.ops.node,
        args: [path.join(f.ops.root, 'scripts', 'eligible-live.js'), 'new-period'],
        options: { cwd: f.ops.root, env: process.env } }]);
    assert.ok(f.output.some(line => line.includes('18.18504') && line.includes('$10')));
    assert.ok(f.output.some(line => line.includes('drawdown_limit') && line.includes('10.5')));
    assert.ok(f.output.some(line => line.includes('periode lama tetap tersimpan')));
    assert.ok(f.output.some(line => line.includes('diverifikasi ulang saat start')));
    assert.ok(f.output.some(line => line.includes('poly check, lalu poly start')));
});

test('failed new-period only exposes a safe code and never activates services', async () => {
    for (const [stderr, expected] of [
        [JSON.stringify({ type: 'eligible_live_failed', code: 'previous_live_inventory_open', detail: 'private secret' }),
            'previous_live_inventory_open'],
        [JSON.stringify({ code: 'private_key=hidden-value' }), 'eligible_new_period_failed'],
        ['private secret', 'eligible_new_period_failed'],
        ['', 'eligible_new_period_failed'],
    ]) {
        const f = fixture();
        f.ops.run = async (file, args) => {
            f.calls.push({ file, args });
            return { code: 1, stdout: JSON.stringify({ created: true, automaticActivation: false }), stderr };
        };
        await assert.rejects(controlMain(['new-period'], f.ops), error => error.message === expected);
        assert.deepEqual(f.calls, [{ file: f.ops.node,
            args: [path.join(f.ops.root, 'scripts', 'eligible-live.js'), 'new-period'] }]);
        assert.equal(f.output.length, 0);
    }
});

test('new-period rejects incomplete or contradictory success without activation', async () => {
    const success = { created: true, id: 'eligible-new-period', runtimeId: 'eligible-runtime', drawdownStop: 10,
        openingBalance: 18.18504, automaticActivation: false };
    for (const changes of [{ created: false }, { automaticActivation: true }, { drawdownStop: 0 },
        { drawdownStop: null }, { id: undefined }, { runtimeId: '' }, { openingBalance: '18.18504' }]) {
        const f = fixture({ ...success, ...changes });
        await assert.rejects(controlMain(['new-period'], f.ops), /eligible_new_period_report_unavailable/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].args.at(-1), 'new-period');
        assert.equal(f.output.length, 0);
    }
    for (const stdout of ['', 'not JSON private_key=hidden-value', 'null', '[]']) {
        const f = fixture();
        f.ops.run = async (file, args) => { f.calls.push({ file, args }); return { code: 0, stdout }; };
        await assert.rejects(controlMain(['new-period'], f.ops), /eligible_new_period_report_unavailable/);
        assert.equal(f.calls.length, 1);
        assert.equal(f.output.length, 0);
    }
});

test('status reads only the report and this service status', async () => {
    const f = fixture({ liveStarted: false });
    assert.equal(await controlMain([], f.ops), 0);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].args.at(-1), 'report');
    assert.deepEqual(f.calls[1].args, ['--user', 'show', UNIT, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID']);
});

test('install writes a manual unit without checking, reloading, enabling, or starting', async () => {
    const f = fixture();
    assert.equal(await controlMain(['install'], f.ops), 0);
    assert.deepEqual(f.calls, [{ file: 'install', options: { root: f.ops.root, node: f.ops.node, home: f.ops.home, env: process.env } }]);
});

test('explicit start preflights before installation and only starts the eligible unit', async () => {
    const f = fixture();
    assert.equal(await controlMain(['start'], f.ops), 0);
    assert.deepEqual(f.calls.map(call => call.file === f.ops.node ? call.args.at(-1)
        : call.file === 'install' ? 'install' : call.args.slice(0, 2)), [
        'preflight', 'install', ['--user', 'daemon-reload'], ['--user', 'start'], ['--user', 'show'],
    ]);
    assert.deepEqual(f.calls[3].args, ['--user', 'start', UNIT]);
    assert.equal(f.calls.some(call => call.file === 'systemctl' && call.args.includes('enable')), false);
    assert.equal(f.calls.some(call => call.file === 'systemctl' && call.args.includes('restart')), false);
});

test('install or daemon-reload failure prevents a start command', async () => {
    const f = fixture();
    f.ops.install = () => { throw new Error('eligible_installed_unit_differs'); };
    await assert.rejects(controlMain(['start'], f.ops), /eligible_installed_unit_differs/);
    assert.equal(f.calls.length, 1);
    const failed = fixture(), run = failed.ops.run;
    failed.ops.run = async (...args) => {
        const result = await run(...args);
        return args[0] === 'systemctl' ? { code: 1, stdout: '', stderr: 'secret' } : result;
    };
    await assert.rejects(controlMain(['start'], failed.ops), /eligible_service_command_failed/);
    assert.equal(failed.calls.length, 3);
});

test('stop targets only the eligible unit and missing units need no stop operation', async () => {
    const f = fixture();
    assert.equal(await controlMain(['stop'], f.ops), 0);
    assert.deepEqual(f.calls.map(call => call.args), [
        ['--user', 'show', UNIT, '-p', 'LoadState', '--value'], ['--user', 'stop', UNIT],
    ]);
    const missing = fixture();
    missing.ops.run = async (...args) => { missing.calls.push(args); return { code: 0, stdout: 'not-found\n' }; };
    assert.equal(await controlMain(['stop'], missing.ops), 0); assert.equal(missing.calls.length, 1);
});

test('config and logs redact credential fields and environment values', async t => {
    const { root, home } = directoryFixture(t);
    fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    fs.writeFileSync(path.join(root, '.env'), 'PRIVATE_KEY=fixture-private-key\nCLOB_API_SECRET=fixture-secret-value\n');
    const external = path.join(root, 'wallet.env');
    fs.writeFileSync(external, 'CLOB_API_PASSPHRASE=fixture-passphrase-value\nCLOB_API_SECRET=fixture-external-secret\n');
    fs.writeFileSync(path.join(home, '.config', 'polymarket-eligible-live.env'), `POLYMARKET_ENV_FILE="${external}"\n`);
    const config = fixture({ privateKey: 'fixture-private-key', nested: { credentials: { key: 'other-hidden-value' } },
        note: 'fixture-secret-value', strategy: 'eligible' });
    assert.equal(await controlMain(['config'], { ...config.ops, root, home }), 0);
    assert.equal(config.output.join('\n').includes('fixture-'), false);
    assert.equal(config.output.join('\n').includes('other-hidden-value'), false);
    assert.ok(config.output.join('\n').includes('eligible'));
    const logs = fixture();
    logs.ops.run = async (file, args) => {
        logs.calls.push({ file, args });
        return { code: 0, stdout: 'fixture-private-key fixture-secret-value fixture-external-secret fixture-passphrase-value\nBearer hidden-token\n' };
    };
    assert.equal(await controlMain(['logs'], { ...logs.ops, root, home }), 0);
    assert.deepEqual(logs.calls[0], { file: 'journalctl', args: ['--user', '-u', UNIT, '-n', '50', '--no-pager'] });
    assert.equal(logs.output.join('\n').includes('fixture-'), false);
    assert.equal(logs.output.join('\n').includes('hidden-token'), false);
});

test('unit rendering escapes device paths, selects only the eligible runner, and cannot auto-enable', () => {
    const root = '/srv/project space/100%/quote"back\\slash/$project', node = '/opt/node 24/100%/$node';
    const home = '/home/user space/100%/$user';
    const content = renderEligibleUnit({ root, node, home });
    assert.ok(content.includes('WorkingDirectory=/srv/project space/100%%/quote"back\\slash/$project\n'));
    assert.ok(content.includes('Environment=\n'));
    assert.equal(content.includes('EnvironmentFile='), false);
    assert.ok(content.includes('ExecStart=:"/opt/node 24/100%%/$node" "scripts/eligible-live.js" "run" "--live"'));
    assert.ok(content.includes('Restart=no\n'));
    assert.equal(content.includes('RestartSec='), false);
    assert.equal(content.includes('StartLimitIntervalSec='), false);
    assert.equal(content.includes('[Install]'), false);
    assert.equal(content.includes('laya-live.js'), false);
    assert.equal(content.includes('polymarket-ai-shadow.env'), false);
    for (const suffix of [' ', '\\'])
        assert.ok(renderEligibleUnit({ root: '/srv/project' + suffix }).includes(`WorkingDirectory=/srv/project${suffix}/.\n`));
});

test('continuous units retry crashes while manual stop remains a systemctl stop', async t => {
    const { root, home } = directoryFixture(t), env = { ELIGIBLE_CONTINUOUS_TRADING: 'true' };
    const content = renderEligibleUnit({ root, home, env });
    assert.match(content, /^Environment="ELIGIBLE_CONTINUOUS_TRADING=true"$/m);
    assert.match(content, /^Restart=on-failure\nRestartSec=5$/m);
    assert.match(content, /^\[Unit\]\nStartLimitIntervalSec=0$/m);
    assert.equal(content.includes('[Install]'), false);
    assert.equal(content.includes('WantedBy='), false);
    const f = fixture();
    assert.equal(await controlMain(['stop'], { ...f.ops, root, home, env }), 0);
    assert.deepEqual(f.calls.map(call => call.args), [
        ['--user', 'show', UNIT, '-p', 'LoadState', '--value'], ['--user', 'stop', UNIT],
    ]);
    assert.equal(f.calls.some(call => call.file === 'install'), false);
});

test('continuous unit flag follows external, private, checkout, then process precedence', t => {
    const { temp, root, home } = directoryFixture(t);
    fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    const wallet = path.join(temp, 'wallet.env'), alternate = path.join(temp, 'alternate.env');
    const privateFile = path.join(home, '.config', 'polymarket-eligible-live.env');
    fs.writeFileSync(wallet, 'ELIGIBLE_CONTINUOUS_TRADING=true\n');
    fs.writeFileSync(alternate, 'ELIGIBLE_CONTINUOUS_TRADING=false\n');
    fs.writeFileSync(privateFile, `POLYMARKET_ENV_FILE="${wallet}"\n`);
    const rendered = env => renderEligibleUnit({ root, home, env });
    const assertMode = (env, enabled) => {
        const content = rendered(env);
        assert.ok(content.includes(`ELIGIBLE_CONTINUOUS_TRADING=${enabled}`));
        assert.ok(content.includes(`Restart=${enabled ? 'on-failure' : 'no'}\n`));
    };
    assertMode({}, true);
    assertMode({ POLYMARKET_ENV_FILE: alternate }, false);
    fs.writeFileSync(privateFile, `POLYMARKET_ENV_FILE="${wallet}"\nELIGIBLE_CONTINUOUS_TRADING=false\n`);
    assertMode({}, false);
    fs.writeFileSync(path.join(root, '.env'), 'ELIGIBLE_CONTINUOUS_TRADING=true\n');
    assertMode({}, true);
    assertMode({ ELIGIBLE_CONTINUOUS_TRADING: 'false' }, false);
    const selected = path.join(temp, 'selected.env');
    fs.writeFileSync(selected, 'ELIGIBLE_CONTINUOUS_TRADING=false\n');
    fs.writeFileSync(path.join(root, '.env'), `ELIGIBLE_LIVE_CONFIG="${selected}"\n`);
    assertMode({}, false);
    assertMode({ ELIGIBLE_LIVE_CONFIG: privateFile, ELIGIBLE_CONTINUOUS_TRADING: 'true' }, true);
    const pinned = rendered({ ELIGIBLE_CONTINUOUS_TRADING: 'true' });
    assert.match(pinned, /^Environment="ELIGIBLE_LIVE_CONFIG=.*" "ELIGIBLE_CONTINUOUS_TRADING=true"$/m);
    fs.writeFileSync(privateFile, `POLYMARKET_ENV_FILE="${wallet}"\n`);
    fs.writeFileSync(path.join(root, '.env'), `ELIGIBLE_LIVE_CONFIG="${selected}"\nPOLYMARKET_ENV_FILE="${alternate}"\n`);
    assertMode({ ELIGIBLE_LIVE_CONFIG: '' }, false);
    const defaultPrivate = rendered({ ELIGIBLE_LIVE_CONFIG: '', POLYMARKET_ENV_FILE: '' });
    assert.match(defaultPrivate, /^Environment="ELIGIBLE_LIVE_CONFIG=" "ELIGIBLE_CONTINUOUS_TRADING=true"$/m);
    assert.match(defaultPrivate, /^Restart=on-failure$/m);
});

test('continuous unit mode rejects non-boolean values and conflicting restart directives', t => {
    const { temp, root, home } = directoryFixture(t);
    for (const value of ['', 'TRUE', '1', 'yes', 'true\nRestart=always', true, false, null])
        assert.throws(() => renderEligibleUnit({ root, home, env: { ELIGIBLE_CONTINUOUS_TRADING: value } }),
            /invalid_eligible_continuous_trading/);
    fs.mkdirSync(root); fs.writeFileSync(path.join(root, '.env'), 'ELIGIBLE_CONTINUOUS_TRADING=yes\n');
    assert.throws(() => renderEligibleUnit({ root, home, env: {} }), /invalid_eligible_continuous_trading/);
    assert.match(renderEligibleUnit({ root, home, env: { ELIGIBLE_CONTINUOUS_TRADING: 'false' } }), /^Restart=no$/m);
    const template = path.join(temp, 'template'), base = fs.readFileSync(path.join(ROOT, 'deploy', UNIT), 'utf8');
    for (const content of [base.replace('[Unit]', '[Other]'), base + '\n[Unit]\n',
        base.replace('Restart=no', 'Restart=no\nRestartSec=60'), base.replace('[Unit]', '[Unit]\nStartLimitIntervalSec=60')]) {
        fs.writeFileSync(template, content);
        assert.throws(() => renderEligibleUnit({ root, home, template, env: { ELIGIBLE_CONTINUOUS_TRADING: 'true' } }),
            /eligible_invalid_unit_template/);
    }
});

test('unit wallet pin follows runtime precedence without exporting credentials', t => {
    const { temp, root, home } = directoryFixture(t);
    fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    const walletFile = path.join(temp, 'wallet.env');
    const privateFile = path.join(home, '.config', 'polymarket-eligible-live.env');
    const wallets = ['1', '2', '3'].map(value => `0x${value.repeat(40)}`);
    const processWallet = `0x${'aB'.repeat(20)}`;
    fs.writeFileSync(walletFile, `PROXY_WALLET_ADDRESS=${wallets[0]}\nPRIVATE_KEY=fixture-wallet-private-key\n`);
    fs.writeFileSync(privateFile, `POLYMARKET_ENV_FILE="${walletFile}"\nCLOB_API_SECRET=fixture-api-secret\n`);
    const assertWallet = (env, expected) => {
        const content = renderEligibleUnit({ root, home, env });
        assert.match(content, new RegExp(`^Environment="PROXY_WALLET_ADDRESS=${expected}"$`, 'm'));
        assert.equal(content.includes('PRIVATE_KEY'), false);
        assert.equal(content.includes('CLOB_API_SECRET'), false);
        assert.equal(content.includes('fixture-'), false);
        assert.equal(content.includes('EnvironmentFile='), false);
    };
    assertWallet({}, wallets[0]);
    fs.appendFileSync(privateFile, `PROXY_WALLET_ADDRESS=${wallets[1]}\n`);
    assertWallet({}, wallets[1]);
    fs.writeFileSync(path.join(root, '.env'), `PROXY_WALLET_ADDRESS=${wallets[2]}\n`);
    assertWallet({}, wallets[2]);
    assertWallet({ PROXY_WALLET_ADDRESS: processWallet }, processWallet);
});

test('unit rendering rejects invalid configured wallets before installation', t => {
    const { root, home, directory } = directoryFixture(t);
    for (const wallet of ['', null, false, 123, 'invalid', `0x${'0'.repeat(40)}`,
        `0x${'1'.repeat(39)}`, `0x${'1'.repeat(40)}\nRestart=always`, `0x${'1'.repeat(64)}`]) {
        assert.throws(() => installEligibleUnit({ root, home, directory, env: { PROXY_WALLET_ADDRESS: wallet } }),
            /invalid_eligible_wallet_address/);
        assert.equal(fs.existsSync(path.join(directory, UNIT)), false);
    }
    assert.match(renderEligibleUnit({ root, home, env: {} }), /^Environment=$/m);
});

test('installed wallet pin wins over later dotenv changes in the runtime resolver', t => {
    const { temp, root, home, directory } = directoryFixture(t);
    fs.mkdirSync(root); fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    const walletFile = path.join(temp, 'wallet.env');
    const privateFile = path.join(home, '.config', 'polymarket-eligible-live.env');
    const wallet = `0x${'1'.repeat(40)}`, replacement = `0x${'2'.repeat(40)}`;
    fs.writeFileSync(walletFile, `PROXY_WALLET_ADDRESS=${wallet}\n`);
    fs.writeFileSync(privateFile, `POLYMARKET_ENV_FILE="${walletFile}"\n`);
    const options = { root, home, directory, env: { ELIGIBLE_LIVE_CONFIG: privateFile } };
    const installed = installEligibleUnit(options), original = fs.readFileSync(installed, 'utf8');
    const pinned = original.match(/"PROXY_WALLET_ADDRESS=(0x[\da-fA-F]{40})"/)?.[1];
    assert.equal(pinned, wallet);
    assert.equal(installEligibleUnit(options), installed);
    fs.writeFileSync(walletFile, `PROXY_WALLET_ADDRESS=${replacement}\n`);
    fs.appendFileSync(privateFile, `PROXY_WALLET_ADDRESS=${replacement}\n`);
    fs.writeFileSync(path.join(root, '.env'), `PROXY_WALLET_ADDRESS=${replacement}\n`);
    const script = `import dotenv from ${JSON.stringify(import.meta.resolve('dotenv'))};
import {eligibleEnvironment} from ${JSON.stringify(new URL('../../src/eligible-live/config.js', import.meta.url).href)};
dotenv.config({path:process.argv[1],quiet:true});
console.log(JSON.stringify({wallet:eligibleEnvironment().PROXY_WALLET_ADDRESS}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, path.join(root, '.env')], {
        cwd: root, env: { PATH: process.env.PATH,
            ELIGIBLE_LIVE_CONFIG: privateFile, PROXY_WALLET_ADDRESS: pinned },
        encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).wallet, wallet);
    assert.throws(() => installEligibleUnit(options), /eligible_installed_unit_differs/);
    assert.equal(fs.readFileSync(installed, 'utf8'), original);
});

test('invalid unit paths and malformed templates cannot inject directives', t => {
    for (const options of [{ root: '/srv/project\nExecStart=/unsafe' }, { home: '/home/user\0' },
        { root: 'relative' }, { node: 'node' }, { node: '/opt/node"bin' }]) assert.throws(() => renderEligibleUnit(options));
    const { temp } = directoryFixture(t), template = path.join(temp, 'template');
    for (const content of ['[Service]\nRestart=no\nWorkingDirectory=/one\nWorkingDirectory=/two\nExecStart=/node\n',
        renderEligibleUnit() + '\n[Install]\nWantedBy=default.target\n', renderEligibleUnit().replace('Restart=no', 'Restart=always')]) {
        fs.writeFileSync(template, content);
        assert.throws(() => renderEligibleUnit({ template }), /eligible_invalid_unit_template/);
    }
});

test('custom config selection is shared by CLI, unit installation, and log redaction', async t => {
    const { temp, root, home } = directoryFixture(t);
    fs.mkdirSync(root);
    const configFile = path.join(temp, 'custom 100% $settings.env'), walletFile = path.join(temp, 'wallet.env');
    fs.writeFileSync(configFile, `POLYMARKET_ENV_FILE="${walletFile}"\nCLOB_API_SECRET=custom-private-secret\n`);
    fs.writeFileSync(walletFile, 'CLOB_API_KEY=custom-wallet-secret\n');
    const env = { ELIGIBLE_LIVE_CONFIG: configFile };
    const content = renderEligibleUnit({ root, home, env });
    assert.ok(content.includes(`Environment="ELIGIBLE_LIVE_CONFIG=${configFile.replace(/%/g, '%%')}"\n`));
    assert.equal(content.includes('EnvironmentFile='), false);
    const f = fixture();
    assert.equal(await controlMain(['check'], { ...f.ops, root, home, env }), 0);
    assert.equal(f.calls[0].options.env, env);
    const installed = fixture();
    assert.equal(await controlMain(['install'], { ...installed.ops, root, home, env }), 0);
    assert.equal(installed.calls[0].options.env, env);
    const logs = fixture();
    logs.ops.run = async () => ({ code: 0, stdout: 'custom-private-secret custom-wallet-secret' });
    assert.equal(await controlMain(['logs'], { ...logs.ops, root, home, env }), 0);
    assert.equal(logs.output.join('\n').includes('custom-'), false);
    fs.writeFileSync(path.join(root, '.env'), `ELIGIBLE_LIVE_CONFIG="${configFile}"\n`);
    assert.equal(renderEligibleUnit({ root, home, env: {} }), content);
    for (const selected of ['relative.env', '/tmp/file\nExecStart=/unsafe'])
        assert.throws(() => renderEligibleUnit({ root, home, env: { ELIGIBLE_LIVE_CONFIG: selected } }));
});

test('unit installation is private and idempotent, preserving mismatched or symlinked units', t => {
    const { temp, directory } = directoryFixture(t);
    const destination = installEligibleUnit({ directory });
    assert.equal(destination, path.join(directory, UNIT));
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(installEligibleUnit({ directory }), destination);
    fs.writeFileSync(destination, 'existing unit');
    assert.throws(() => installEligibleUnit({ directory }), /eligible_installed_unit_differs/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing unit');
    const other = path.join(temp, 'symlink units'); fs.mkdirSync(other);
    const target = path.join(temp, 'target'); fs.writeFileSync(target, renderEligibleUnit());
    fs.symlinkSync(target, path.join(other, UNIT));
    assert.throws(() => installEligibleUnit({ directory: other }), /eligible_installed_unit_differs/);
    assert.equal(fs.readFileSync(target, 'utf8'), renderEligibleUnit());
});

test('wrapper works from another cwd through a symlink and a checkout with spaces', t => {
    const { temp, root } = directoryFixture(t);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const wrapper = path.join(root, 'scripts', 'poly');
    fs.copyFileSync(path.join(ROOT, 'scripts', 'poly'), wrapper); fs.chmodSync(wrapper, 0o755);
    fs.writeFileSync(path.join(root, 'scripts', 'eligible-live-control.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const link = path.join(temp, 'poly link'); fs.symlinkSync(wrapper, link);
    assert.equal(spawnSync('bash', ['-n', wrapper]).status, 0);
    const result = spawnSync(link, ['help'], { cwd: '/', encoding: 'utf8', env: { ...process.env, POLYMARKET_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ['help']);
    const invalid = spawnSync(link, ['help'], { cwd: '/', encoding: 'utf8', env: { ...process.env, POLYMARKET_NODE: '/missing node24' } });
    assert.equal(invalid.status, 1); assert.ok(invalid.stderr.includes('Node.js 24'));
});
