#!/usr/bin/env node
// Dependency-free publication tool. Never reads a ledger or exports Git history.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = new Set(['.env.example', '.gitignore', '.nvmrc', 'README.md', 'SECURITY.md', 'AGENTS.md',
    'package.json', 'package-lock.json', 'LICENSE', 'LICENSE.md', 'NOTICE', 'CONTRIBUTING.md']);
const PUBLIC_DOCS = new Set(['docs/setup.md', 'docs/reference.md']);
const PRIVATE_FILE_KEYS = new Set(['POLYMARKET_ENV_FILE', 'ELIGIBLE_LIVE_CONFIG']);

export function privatePath(file) {
    const parts = file.replaceAll('\\', '/').split('/');
    const name = parts.at(-1);
    if (parts.some(p => ['.git', 'node_modules', 'data', 'logs', 'private', 'secrets', 'credentials',
        'wallets', '.config', 'release', 'releases', '__pycache__', 'coverage'].includes(p)))
        return file !== 'logs/.gitkeep';
    if (name === '.env.example') return false;
    return /(^\.env(?:\.|$)|\.env(?:\.|$)|^\.(?:envrc|npmrc|netrc)$)/i.test(name)
        || /\.(?:pem|key|p12|pfx|keystore|log|jsonl|sqlite\w*|db(?:-.*)?|bak|backup|old|tmp|zip|tar|gz|pyc)$/i.test(name)
        || /(?:wallet|credentials).*\.json$/i.test(name)
        || file.startsWith('docs/') && !PUBLIC_DOCS.has(file);
}

export function publishable(file) {
    if (privatePath(file)) return false;
    return ROOT_FILES.has(file) || PUBLIC_DOCS.has(file)
        || file === 'test/test_cron_check_polymarket.py'
        || /^(?:src|test)\/.+\.(?:js|cjs|mjs|json)$/.test(file)
        || /^scripts\/.+\.(?:js|cjs|mjs|py|sh)$/.test(file) || ['scripts/laya-live', 'scripts/poly'].includes(file)
        || /^deploy\/polymarket-laya-(?:live|paper|filter-shadow|filter-paper)\.service$/.test(file)
        || file === 'deploy/polymarket-decision-paper.service'
        || file === 'deploy/polymarket-eligible-live.service'
        || file === 'deploy/polymarket-entry-filter-paper.service'
        || file === 'deploy/polymarket-premarket-paper.service'
        || file === 'deploy/polymarket-market-history.service'
        || file === 'deploy/polymarket-value-collector.service'
        || /^\.githooks\/(?:pre-commit|pre-push)$/.test(file);
}

function placeholder(value) {
    return !value || /^(?:\.{3}|<.*>|YOUR_.*|0xYOUR_.*|(?:example|placeholder|dummy|test|fake|secret|token|key|password|passphrase)(?:[-_].*)?)$/i.test(value)
        || /(?:process\.env|env\.|\.example(?:\.|\/|:|$)|example\.com)/i.test(value);
}

export function scanContent(file, bytes, knownPrivate = []) {
    const content = bytes.toString('utf8'), findings = [];
    const addresses = knownPrivate.filter(value => /^0x[a-f0-9]{40}$/i.test(value)).map(value => value.toLowerCase());
    const add = (line, type) => {
        if (!findings.some(f => f.line === line && f.type === type)) findings.push({ file, line, type });
    };
    if (content.includes('\0')) { add(1, 'binary_not_allowed'); return findings; }
    const lines = content.split('\n');
    lines.forEach((line, index) => {
        if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(line)) add(index + 1, 'private_key');
        if (/(?:ghp_|github_pat_|glpat-|sk-proj-|sk-svcacct-|xox[baprs]-)[A-Za-z0-9_-]{20,}/.test(line)) add(index + 1, 'api_token');
        if (/(?:PRIVATE_KEY|privateKey|private_key)["'\s]*[:=]\s*["']?(?:0x)?[a-f0-9]{64}\b/i.test(line)) add(index + 1, 'private_key');
        const assignment = line.match(/^\s*(?:export\s+)?(?:PRIVATE_KEY|[A-Z_]*WALLET_ADDRESS|LAYA_PROFIT_RECIPIENT|CLOB_API_(?:KEY|SECRET|PASSPHRASE)|NINEROUTER_KEY|[A-Z_]*(?:PASSWORD|API_SECRET))\s*=\s*["']?([^\s#"']+)/);
        if (assignment && !placeholder(assignment[1])) add(index + 1, 'private_configuration');
        for (const raw of line.match(/https?:\/\/[^\s"'`<>]+/g) || []) {
            try {
                const url = new URL(raw.replace(/[),;]+$/, ''));
                const example = /(?:^|\.)example\.(?:com|org|net)$|\.(?:example|test|invalid)$/.test(url.hostname);
                if (!example && (url.username || url.password)) add(index + 1, 'url_credentials');
                for (const [key, value] of url.searchParams)
                    if (/^(?:api[-_]?key|token|secret|password|signature|access_token)$/i.test(key)
                        && value.length >= 8 && !placeholder(value) && !example) add(index + 1, 'url_token');
            } catch { /* Ignore source-code URL expressions. */ }
        }
        if (knownPrivate.some(value => line.includes(value))
            || addresses.some(value => line.toLowerCase().includes(value))) add(index + 1, 'local_private_value');
    });
    return findings;
}

export function localPrivateValues(files) {
    const values = new Set(), visited = new Set();
    const pending = files.map(file => ({ file, optional: true }));
    for (let index = 0; index < pending.length; index++) {
        const { file, optional } = pending[index];
        let resolved, content, fd;
        try {
            resolved = fs.realpathSync(file);
            if (visited.has(resolved)) continue;
            visited.add(resolved);
            // Follow private config symlinks, but never block on pipes or read devices.
            fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
            if (!fs.fstatSync(fd).isFile()) throw new Error('not_regular_file');
            content = fs.readFileSync(fd, 'utf8');
        } catch (error) {
            if (optional && error.code === 'ENOENT') continue;
            throw new Error('private_configuration_unreadable');
        } finally {
            if (fd !== undefined) fs.closeSync(fd);
        }
        for (const line of content.split('\n')) {
            const match = line.match(/^\s*(?:export\s+)?([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
            if (!match) continue;
            const name = match[1];
            let value = match[2];
            if (/^["'`]/.test(value)) {
                const end = value.indexOf(value[0], 1);
                if (end < 0) throw new Error('private_configuration_unreadable');
                value = value.slice(1, end);
            } else value = value.split('#')[0].trim();
            // Paths are literal config values; never evaluate shell interpolation.
            if (PRIVATE_FILE_KEYS.has(name) && value)
                pending.push({ file: path.resolve(path.dirname(resolved), value), optional: false });
            const sensitive = /PRIVATE_KEY|WALLET_ADDRESS|LAYA_PROFIT_RECIPIENT|API_KEY|API_SECRET|PASSPHRASE|PASSWORD|NINEROUTER_KEY/.test(name)
                || /RPC.*URL/.test(name) && /(?:@|\?|\/v[23]\/)/.test(value);
            if (sensitive && value.length >= 8 && !placeholder(value)) values.add(value);
        }
    }
    return [...values];
}

export function defaultPrivateFiles(root = ROOT, { home = os.homedir(), env = process.env } = {}) {
    return [path.join(root, '.env'), path.join(home, '.config/polymarket-eligible-live.env'),
        path.join(home, '.config/polymarket-ai-shadow.env'),
        ...[...PRIVATE_FILE_KEYS].map(key => env[key]).filter(Boolean)];
}

// The running deployment binds these original bytes to its period identity.
// Normalize machine defaults in the NEW export only, never in that deployment.
export function portableBytes(file, bytes) {
    let text = bytes.toString('utf8');
    if (/^deploy\/polymarket-laya-(?:live|paper)\.service$/.test(file)) {
        text = text.replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/opt/polymarket-eligible-bot')
            .replace(/^EnvironmentFile=.*$/m, 'EnvironmentFile=-%h/.config/polymarket-ai-shadow.env')
            .replace(/^ExecStart=\S+( .*)$/m, 'ExecStart=/usr/bin/node$1')
            .replace(/^StandardOutput=append:.*$/m, 'StandardOutput=journal')
            .replace(/^StandardError=append:.*$/m, 'StandardError=journal');
    } else if (file === 'scripts/laya-live') {
        text = text.replace(/^node_bin=.*$/m, 'node_bin="${POLYMARKET_NODE:-$(command -v node || true)}"')
            .replace('"$repo_dir/scripts/laya-live-control.js" "$@"', '"$repo_dir/scripts/device.js" live "$@"');
    } else if (file === 'src/ai-shadow/config.js') {
        text = text.replace(/routerDb: env\.AI_SHADOW_ROUTER_DB \|\| ['"]\/[^'"\n]+['"],/,
            "routerDb: env.AI_SHADOW_ROUTER_DB || path.join(ROOT, '..', '9router-data', 'db', 'data.sqlite'),");
    }
    return Buffer.from(text);
}

function walk(root, dir = '') {
    const out = [];
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const file = dir ? `${dir}/${item.name}` : item.name;
        if (privatePath(file)) continue;
        if (item.isDirectory()) out.push(...walk(root, file));
        else out.push(file);
    }
    return out;
}

function git(root, args, options = {}) {
    return execFileSync('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function readWorkingFile(root, file) {
    let location = root;
    for (const part of file.split('/')) {
        if (!part || part === '.' || part === '..') throw new Error('invalid_publication_path');
        location = path.join(location, part);
        if (fs.lstatSync(location).isSymbolicLink()) throw new Error('publication_symlink');
    }
    const stat = fs.statSync(location);
    if (!stat.isFile()) throw new Error('publication_not_regular_file');
    return { file, bytes: fs.readFileSync(location), mode: stat.mode & 0o111 ? 0o755 : 0o644 };
}

export function inspectRelease(root = ROOT, { staged = false, privateFiles = defaultPrivateFiles(root) } = {}) {
    let names;
    try {
        // Require the exact Git root: a directory nested in another repo must not
        // accidentally export the parent's files or consider them staged here.
        if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString().trim()) !== fs.realpathSync(root)) throw new Error('not_git_root');
        names = git(root, staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
            : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
    } catch {
        if (staged) throw new Error('staged_check_requires_git_repository');
        names = walk(root);
    }
    const known = localPrivateValues(privateFiles), findings = [], records = [];
    let omitted = 0;
    for (const file of [...new Set(names)].sort()) {
        if (file === 'logs/.gitkeep') { omitted++; continue; }
        if (privatePath(file)) { findings.push({ file, line: 1, type: 'private_path' }); continue; }
        if (!publishable(file)) {
            omitted++;
            if (staged) findings.push({ file, line: 1, type: 'not_in_release_allowlist' });
            continue;
        }
        try {
            let row;
            if (staged) {
                const entry = git(root, ['ls-files', '--stage', '-z', '--', file]).toString();
                const mode = entry.split(' ')[0];
                if (!['100644', '100755'].includes(mode)) throw new Error('publication_not_regular_file');
                row = { file, bytes: git(root, ['show', `:${file}`]), mode: mode === '100755' ? 0o755 : 0o644 };
            } else {
                if (!fs.existsSync(path.join(root, file))) continue; // Unstaged deletion.
                row = readWorkingFile(root, file);
            }
            findings.push(...scanContent(file, row.bytes, known));
            const portable = portableBytes(file, row.bytes);
            if (!portable.equals(row.bytes)) findings.push(...scanContent(file, portable, known));
            const homePrefix = os.homedir() + path.sep;
            if ((staged ? row.bytes : portable).toString('utf8').includes(homePrefix))
                findings.push({ file, line: 1, type: 'personal_device_path' });
            // Index checks validate original staged bytes; exports use normalized
            // defaults and consequently get a fresh source/period identity.
            records.push({ ...row, bytes: staged ? row.bytes : portable });
        } catch {
            findings.push({ file, line: 1, type: 'unreadable_or_unsafe_file' });
        }
    }
    return { records, findings, omitted };
}

export function exportRelease(root, destination, report = inspectRelease(root)) {
    if (report.findings.length) throw new Error('publication_check_failed');
    const requested = path.resolve(destination);
    const target = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
    const relative = path.relative(fs.realpathSync(root), target);
    if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
        throw new Error('export_must_be_outside_source_repository');
    if (fs.existsSync(target)) throw new Error('export_destination_exists');
    // Audit all bytes first, then create a new directory; never overwrite a repo.
    fs.mkdirSync(target, { mode: 0o700 });
    for (const row of report.records) {
        const output = path.join(target, row.file);
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o755 });
        fs.writeFileSync(output, row.bytes, { flag: 'wx', mode: row.mode });
    }
    return { directory: target, files: report.records.length, historyIncluded: false,
        privateConfigIncluded: false, gitInitialized: false, pushed: false };
}

export function releaseMain(argv, { root = ROOT, write = console.log } = {}) {
    const [command = 'check', ...args] = argv;
    if (command === 'help' || command === '--help') {
        write('release.js check [--staged] | export /new/directory (no commit/push)'); return 0;
    }
    if (!['check', 'export'].includes(command) || command === 'check' && args.some(a => a !== '--staged')
        || command === 'check' && args.length > 1 || command === 'export' && args.length !== 1) throw new Error('invalid_release_arguments');
    const report = inspectRelease(root, { staged: args.includes('--staged') && command === 'check' });
    write(JSON.stringify({ ok: !report.findings.length, filesChecked: report.records.length,
        omitted: report.omitted, findings: report.findings }, null, 2));
    if (report.findings.length) return 1;
    if (command === 'export') write(JSON.stringify(exportRelease(root, args[0], report), null, 2));
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { process.exitCode = releaseMain(process.argv.slice(2)); }
    catch (error) {
        // Never include filesystem/command errors that could embed secret bytes.
        console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'release_failed'); process.exitCode = 1;
    }
}
