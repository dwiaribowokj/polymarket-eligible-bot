import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectRelease, exportRelease, scanContent, privatePath, publishable, localPrivateValues, defaultPrivateFiles, portableBytes } from '../../scripts/release.js';

function fixture(t, gitRepo = false) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-release-'));
    const root = path.join(base, 'source'); fs.mkdirSync(root);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (gitRepo) git('init', '-q');
    return { base, root, put, git, inspect: options => inspectRelease(root, { privateFiles: [], ...options }) };
}

test('publication path policy excludes environment variants, runtime and private notes', () => {
    assert.equal(publishable('deploy/polymarket-laya-filter-shadow.service'), true);
    assert.equal(publishable('deploy/polymarket-laya-filter-paper.service'), true);
    assert.equal(publishable('deploy/polymarket-premarket-paper.service'), true);
    for (const file of ['.env', '.env.production', '.env.production.example', 'config/wallet.env', 'data/diagnostics/x.json',
        'src/credentials.json', 'secrets/token.js', 'logs/service.log', 'docs/incident.md', 'wallet.key']) {
        assert.equal(privatePath(file), true, file); assert.equal(publishable(file), false, file);
    }
    for (const file of ['.env.example', 'AGENTS.md', 'docs/setup.md', 'docs/reference.md', 'src/restart/calibration-model.json', 'scripts/laya-live',
        'scripts/cron-check-polymarket.py', 'test/test_cron_check_polymarket.py', '.githooks/pre-commit'])
        assert.equal(publishable(file), true, file);
});

test('scanner redacts findings and detects private keys, actual assignments and known local secrets', () => {
    const key = '0x' + 'a'.repeat(64), secret = 'opaque-private-value-' + 'b'.repeat(20);
    const bytes = Buffer.from(`PRIVATE_KEY=${key}\nconst custom = '${secret}';\n`);
    const findings = scanContent('src/settings.js', bytes, [secret]);
    assert.ok(findings.some(f => f.type === 'private_key'));
    assert.ok(findings.some(f => f.type === 'local_private_value'));
    assert.equal(JSON.stringify(findings).includes(key), false);
    assert.equal(JSON.stringify(findings).includes(secret), false);
    assert.ok(scanContent('README.md', Buffer.from('https://' + 'user:actual-long-secret@rpc.vendor.net')).length);
    assert.equal(scanContent('.env.example', Buffer.from('PRIVATE_KEY=\nCLOB_API_KEY=\n')).length, 0);
    assert.equal(scanContent('test/example.js', Buffer.from('https://user:password@rpc.example')).length, 0);
});

test('binary files cannot enter source export', () => {
    assert.equal(scanContent('src/payload.json', Buffer.from([0, 1, 2]))[0].type, 'binary_not_allowed');
});

test('export normalizes machine paths without changing originals or strategy parameters', () => {
    const oldHome = '/home/' + 'old-owner';
    const unit = Buffer.from(`WorkingDirectory=${oldHome}/bot\nEnvironmentFile=-${oldHome}/.config/bot.env\nExecStart=${oldHome}/node scripts/laya-live.js run --live\n`);
    const before = Buffer.from(unit);
    const output = portableBytes('deploy/polymarket-laya-live.service', unit).toString();
    assert.ok(output.includes('WorkingDirectory=/opt/polymarket-eligible-bot'));
    assert.ok(output.includes('ExecStart=/usr/bin/node scripts/laya-live.js run --live'));
    assert.equal(output.includes(oldHome), false); assert.deepEqual(unit, before);
    const config = Buffer.from(`routerDb: env.AI_SHADOW_ROUTER_DB || '${oldHome}/router/data.sqlite',`);
    const portable = portableBytes('src/ai-shadow/config.js', config);
    assert.equal(portable.toString().includes(oldHome), false);
    assert.deepEqual(portableBytes('src/ai-shadow/config.js', portable), portable);
    const wrapper = portableBytes('scripts/laya-live', Buffer.from(`node_bin="${oldHome}/node"\n`));
    assert.ok(wrapper.toString().includes('command -v node'));
    const strategy = Buffer.from('shares: 5, entryCap: 5, drawdownStop: 2');
    assert.deepEqual(portableBytes('src/laya-live/config.js', strategy), strategy);
});

test('clean export has no Git history, runtime, env or incident reports and preserves executable mode', t => {
    const f = fixture(t, true);
    f.put('README.md', '# Bot\n'); f.put('.env.example', 'PRIVATE_KEY=\n');
    f.put('.gitignore', '.env\ndata/\nlogs/\ndocs/incident.md\n');
    f.put('.env', 'PRIVATE_KEY=private\n'); f.put('data/ledger.json', '{"signed":"private"}');
    f.put('logs/a.log', 'private'); f.put('docs/incident.md', 'private');
    f.put('docs/setup.md', '# Setup\n'); f.put('scripts/run.sh', '#!/bin/sh\nexit 0\n');
    f.put('docs/reference.md', '# Reference\n'); f.put('AGENTS.md', '# Project instructions\n');
    fs.chmodSync(path.join(f.root, 'scripts/run.sh'), 0o755);
    const report = f.inspect(); assert.deepEqual(report.findings, []);
    const destination = path.join(f.base, 'public');
    const exported = exportRelease(f.root, destination, report);
    assert.equal(exported.historyIncluded, false); assert.equal(exported.pushed, false);
    assert.equal(fs.existsSync(path.join(destination, 'README.md')), true);
    assert.equal(fs.readFileSync(path.join(destination, 'docs/reference.md'), 'utf8'), '# Reference\n');
    assert.equal(fs.readFileSync(path.join(destination, 'AGENTS.md'), 'utf8'), '# Project instructions\n');
    for (const file of ['.git', '.env', 'data', 'logs', 'docs/incident.md']) assert.equal(fs.existsSync(path.join(destination, file)), false, file);
    assert.ok(fs.statSync(path.join(destination, 'scripts/run.sh')).mode & 0o111);
    assert.throws(() => exportRelease(f.root, destination, report), /export_destination_exists/);
    assert.throws(() => exportRelease(f.root, path.join(f.root, 'nested'), report), /outside_source/);
    fs.symlinkSync(f.root, path.join(f.base, 'alias'));
    assert.throws(() => exportRelease(f.root, path.join(f.base, 'alias', 'nested'), report), /outside_source/);
});

test('forced tracked secrets are blocked despite gitignore and export allowlist', t => {
    const f = fixture(t, true);
    f.put('.gitignore', '.env\ndata/\n'); f.put('.env', 'PRIVATE_KEY=private');
    f.put('data/signed.json', '{}'); f.git('add', '-f', '.env', 'data/signed.json');
    const report = f.inspect();
    assert.deepEqual(report.findings.map(f => f.file), ['.env', 'data/signed.json']);
    assert.throws(() => exportRelease(f.root, path.join(f.base, 'public'), report), /publication_check_failed/);
});

test('staged check reads index bytes even when working copy has been cleaned', t => {
    const f = fixture(t, true), key = '0x' + 'b'.repeat(64);
    f.put('src/settings.js', `PRIVATE_KEY=${key}\n`); f.git('add', '.');
    f.put('src/settings.js', '// cleaned\n');
    assert.equal(f.inspect().findings.length, 0);
    assert.ok(f.inspect({ staged: true }).findings.some(f => f.type === 'private_key'));
});

test('unapproved staged files and staged symlinks fail closed', t => {
    const f = fixture(t, true);
    f.put('personal-notes.md', 'private'); f.put('README.md', '# Bot');
    fs.mkdirSync(path.join(f.root, 'scripts')); fs.symlinkSync('../README.md', path.join(f.root, 'scripts/linked.js'));
    f.git('add', '.');
    const report = f.inspect({ staged: true });
    assert.ok(report.findings.some(f => f.type === 'not_in_release_allowlist'));
    assert.ok(report.findings.some(f => f.type === 'unreadable_or_unsafe_file'));
});

test('working-tree source symlink is never copied', t => {
    const f = fixture(t);
    f.put('README.md', '# Bot'); fs.mkdirSync(path.join(f.root, 'src'));
    fs.symlinkSync('../README.md', path.join(f.root, 'src/linked.js'));
    assert.ok(f.inspect().findings.some(f => f.type === 'unreadable_or_unsafe_file'));
});

test('known local configuration is read without exposing values or treating public endpoints as secrets', t => {
    const f = fixture(t), wallet = '0x' + '7'.repeat(40);
    const secret = 'private-long-token-' + 'c'.repeat(10);
    f.put('.env', `PRIVATE_KEY="${secret}"\nPROXY_WALLET_ADDRESS=${wallet}\nPOLYGON_RPC_URL=https://public.example\n`);
    assert.deepEqual(localPrivateValues([path.join(f.root, '.env')]), [secret, wallet]);
    f.put('src/config.js', `export const account = '${wallet}';`);
    assert.ok(f.inspect({ privateFiles: [path.join(f.root, '.env')] }).findings.some(f => f.type === 'local_private_value'));
});

test('default private sources include eligible, research and explicit environment selectors', t => {
    const f = fixture(t), home = path.join(f.base, 'home');
    const explicit = path.join(f.base, 'explicit.env'), walletConfig = path.join(f.base, 'wallet.env');
    const files = defaultPrivateFiles(f.root, { home, env: {
        ELIGIBLE_LIVE_CONFIG: explicit, POLYMARKET_ENV_FILE: walletConfig,
    } });
    assert.deepEqual(files, [path.join(f.root, '.env'), path.join(home, '.config/polymarket-eligible-live.env'),
        path.join(home, '.config/polymarket-ai-shadow.env'), walletConfig, explicit]);
    const recipient = '0x' + 'AbCd'.repeat(10);
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    fs.writeFileSync(files[1], `LAYA_PROFIT_RECIPIENT=${recipient}\n`);
    f.put('README.md', `Account: ${recipient.toLowerCase()}\n`);
    assert.deepEqual(f.inspect({ privateFiles: files }).findings,
        [{ file: 'README.md', line: 1, type: 'local_private_value' }]);
    const script = `import os from 'node:os';
        import { inspectRelease } from ${JSON.stringify(new URL('../../scripts/release.js', import.meta.url).href)};
        os.homedir = () => process.argv[2];
        console.log(JSON.stringify(inspectRelease(process.argv[1]).findings));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, f.root, home], {
        env: { ...process.env, POLYMARKET_ENV_FILE: '', ELIGIBLE_LIVE_CONFIG: '' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.deepEqual(JSON.parse(output), [{ file: 'README.md', line: 1, type: 'local_private_value' }]);
});

test('private file references recurse with quoted paths, comments and symlink cycle protection', t => {
    const f = fixture(t), recipient = '0x' + 'aBcD'.repeat(10), wallet = '0x' + 'bCdE'.repeat(10);
    const secret = 'nested-credential-' + 'e'.repeat(24);
    f.put('.env', 'ELIGIBLE_LIVE_CONFIG="private/live config.env" # local selector\n');
    f.put('private/live config.env', ['POLYMARKET_ENV_FILE=wallet.env# linked credentials',
        `LAYA_PROFIT_RECIPIENT='${recipient}'`, ''].join('\n'));
    f.put('private/wallet.env', [`PROXY_WALLET_ADDRESS=${wallet}`, `CLOB_API_SECRET=${secret}`,
        'ELIGIBLE_LIVE_CONFIG=../alias.env', ''].join('\n'));
    fs.symlinkSync('.env', path.join(f.root, 'alias.env'));
    const values = localPrivateValues([path.join(f.root, '.env')]);
    assert.deepEqual(values, [recipient, wallet, secret]);
    const findings = scanContent('README.md', Buffer.from(`${recipient.toUpperCase()}\n${wallet.toLowerCase()}\n${secret}`), values);
    assert.equal(findings.length, 3);
    for (const value of values) assert.equal(JSON.stringify(findings).toLowerCase().includes(value.toLowerCase()), false);
    assert.equal(scanContent('README.md', Buffer.from(secret.toUpperCase()), values).length, 0);
});

test('missing or non-regular referenced private configurations fail without disclosing paths', t => {
    const f = fixture(t);
    assert.deepEqual(localPrivateValues([path.join(f.root, 'absent.env')]), []);
    f.put('.env', 'POLYMARKET_ENV_FILE=private/missing.env\n');
    assert.throws(() => localPrivateValues([path.join(f.root, '.env')]),
        error => error.message === 'private_configuration_unreadable');
    f.put('.env', 'POLYMARKET_ENV_FILE=private\n'); fs.mkdirSync(path.join(f.root, 'private'));
    assert.throws(() => localPrivateValues([path.join(f.root, '.env')]),
        error => error.message === 'private_configuration_unreadable');
});

test('staged scans catch recipient variants from nested private files after cleanup on disk', t => {
    const f = fixture(t, true), recipient = '0x' + 'aBCd'.repeat(10);
    f.put('.gitignore', '.env\nprivate/\n');
    f.put('.env', 'ELIGIBLE_LIVE_CONFIG=private/live.env\n');
    f.put('private/live.env', `LAYA_PROFIT_RECIPIENT=${recipient}\n`);
    f.put('README.md', `Destination: ${recipient.toLowerCase()}\n`); f.git('add', 'README.md');
    f.put('README.md', '# Bot\n');
    assert.deepEqual(f.inspect({ privateFiles: [path.join(f.root, '.env')] }).findings, []);
    assert.deepEqual(f.inspect({ staged: true, privateFiles: [path.join(f.root, '.env')] }).findings,
        [{ file: 'README.md', line: 1, type: 'local_private_value' }]);
});

test('wallet and withdrawal recipient assignments are rejected even without local private files', () => {
    const address = '0x' + 'e'.repeat(40);
    for (const name of ['PROXY_WALLET_ADDRESS', 'WALLET_ADDRESS', 'LAYA_PROFIT_RECIPIENT']) {
        assert.deepEqual(scanContent('.env.example', Buffer.from(`${name}=${address}\n`)),
            [{ file: '.env.example', line: 1, type: 'private_configuration' }]);
        assert.deepEqual(scanContent('.env.example', Buffer.from(`${name}=\n`)), []);
    }
});
