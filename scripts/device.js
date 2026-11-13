import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { controlMain, parseControlArgs } from './laya-live-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODES = ['paper', 'live'];

function requireNode24(version) {
    if (!/^24\./.test(version)) throw new Error('device_requires_node_24');
}

// ExecStart accepts quoted arguments and C escapes. The ':' prefix keeps
// dollar signs in device paths literal; percent specifiers still need escaping.
export function quoteSystemd(value) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error('device_invalid_unit_path');
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
    return `"${escaped}"`;
}

// These path directives take a single literal path, including spaces. They do
// not accept shell quotes or C escapes. A final '/.' protects a trailing space
// or backslash from the unit file's whitespace/line-continuation rules.
function systemdPath(value) {
    quoteSystemd(value);
    const escaped = value.replace(/%/g, '%%');
    return /[\\ ]$/.test(value) ? `${escaped}/.` : escaped;
}

function modeUnit(mode) {
    if (!MODES.includes(mode)) throw new Error('device_invalid_mode');
    return `polymarket-laya-${mode}.service`;
}

function replaceDirective(content, name, value) {
    const matcher = new RegExp(`^${name}=.*$`, 'gm');
    if ([...content.matchAll(matcher)].length !== 1) throw new Error('device_invalid_unit_template');
    return content.replace(matcher, () => `${name}=${value}`);
}

export function renderDeviceUnit({ mode = 'paper', root = ROOT, node = process.execPath,
    home = os.homedir(), template = path.join(root, 'deploy', modeUnit(mode)) } = {}) {
    modeUnit(mode);
    for (const location of [root, node, home]) {
        if (!path.isAbsolute(location)) throw new Error('device_requires_absolute_paths');
        quoteSystemd(location);
    }
    // systemd rejects these characters in executable names even when quoted.
    if (/["'\\]/.test(node)) throw new Error('device_unsupported_node_path');
    let content = fs.readFileSync(template, 'utf8');
    content = replaceDirective(content, 'WorkingDirectory', systemdPath(root));
    content = replaceDirective(content, 'EnvironmentFile', `-${systemdPath(path.join(home, '.config', 'polymarket-ai-shadow.env'))}`);
    const args = mode === 'live' ? ['scripts/laya-live.js', 'run', '--live'] : ['scripts/laya-pilot.js', 'paper'];
    content = replaceDirective(content, 'ExecStart', `:${[node, ...args].map(quoteSystemd).join(' ')}`);
    if (mode === 'paper') {
        content = replaceDirective(content, 'StandardOutput', 'journal');
        content = replaceDirective(content, 'StandardError', 'journal');
    }
    return content;
}

// Create only. A unit for another checkout/device, including a running unit,
// must be reviewed separately instead of silently replaced.
export function installDeviceUnit({ mode = 'paper', directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user'),
    ...renderOptions } = {}) {
    const destination = path.join(directory, modeUnit(mode));
    const content = renderDeviceUnit({ ...renderOptions, mode });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = fs.lstatSync(destination);
        if (!existing.isFile() || fs.readFileSync(destination, 'utf8') !== content) throw new Error('device_installed_unit_differs');
    }
    return destination;
}

async function runFile(file, args, { cwd = ROOT, inherit = false } = {}) {
    if (inherit) {
        return new Promise(resolve => {
            const child = spawn(file, args, { cwd, stdio: 'inherit' });
            child.once('error', () => resolve({ code: 1, stdout: '', stderr: '' }));
            child.once('exit', code => resolve({ code: Number.isInteger(code) ? code : 1, stdout: '', stderr: '' }));
        });
    }
    return new Promise(resolve => {
        execFile(file, args, { cwd, timeout: 90000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr });
        });
    });
}

function help(write) {
    write('node scripts/device.js install [--mode=paper|live]');
    write('node scripts/device.js live status|check|config|start|stop|logs');
    write('node scripts/device.js paper');
    write('Node 24 diperlukan. Install hanya menulis unit user systemd; tidak start, enable, atau daemon-reload.');
    write('Default install: paper (dana virtual). Live start memakai guard yang sama dan uang nyata.');
}

export async function deviceMain(argv, { run = runFile, write = console.log, nodeVersion = process.versions.node,
    root = ROOT, node = process.execPath, home = os.homedir(), directory,
    install = installDeviceUnit } = {}) {
    const [command = 'help', ...args] = argv;
    if (['help', '--help', '-h'].includes(command) && args.length === 0) { help(write); return 0; }
    if (!['install', 'live', 'paper'].includes(command)) throw new Error('device_use_help');
    requireNode24(nodeVersion);
    if (command === 'install') {
        if (args.length > 1 || (args.length === 1 && !/^--mode=(paper|live)$/.test(args[0]))) throw new Error('device_install_use_mode_paper_or_live');
        const mode = args.length ? args[0].slice('--mode='.length) : 'paper';
        const destination = install({ mode, root, node, home, ...(directory ? { directory } : {}) });
        write(`Unit ${mode} terpasang: ${destination}`);
        write('Belum dijalankan atau diaktifkan. Muat unit secara manual: systemctl --user daemon-reload');
        return 0;
    }
    if (command === 'paper') {
        if (args.length) throw new Error('device_paper_accepts_no_arguments');
        const result = await run(node, [path.join(root, 'scripts', 'laya-pilot.js'), 'paper'], { cwd: root, inherit: true });
        return result.code;
    }
    parseControlArgs(args);
    return controlMain(args, { run, write,
        install: () => install({ mode: 'live', root, node, home, ...(directory ? { directory } : {}) }) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    deviceMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
        const code = /^[a-z][a-z_]{1,80}$/.test(error.message || '') ? error.message : 'device_command_failed';
        console.error(`Device: ${code}. Gunakan node scripts/device.js help. Tidak ada guard yang direset.`);
        process.exitCode = 1;
    });
}
