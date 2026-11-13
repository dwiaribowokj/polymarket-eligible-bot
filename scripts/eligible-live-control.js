import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { quoteSystemd } from './device.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const UNIT = 'polymarket-eligible-live.service';
export const PREFLIGHT_TIMEOUT_MS = 10 * 60 * 1000;
const PREFLIGHT_PROGRESS_MS = 15000;
const COMMANDS = ['help', 'status', 'check', 'config', 'new-period', 'install', 'start', 'stop', 'logs'];
const SECRET_KEY = /private.?key|api.?key|secret|passphrase|password|mnemonic|seed|authorization|credentials|(?:access|refresh|auth).?token|ninerouter.?key/i;
const GUARDS = {
    persistent_pilot_stop: 'stop live sebelumnya masih aktif; ledger harus ditinjau',
    persistent_live_risk_stop: 'batas risiko live sebelumnya telah tercapai',
    existing_pilot_history_requires_original_period: 'riwayat pilot sebelumnya masih mengunci periode live',
    prior_live_drawdown_stop: 'drawdown pada live sebelumnya masih memblokir startup',
    previous_live_drawdown_stop: 'drawdown pada live sebelumnya masih memblokir startup',
    prior_live_risk_stop: 'stop risiko live sebelumnya masih aktif',
    previous_live_risk_stop: 'stop risiko live sebelumnya masih aktif',
    previous_live_pilot_stop: 'stop pilot live sebelumnya masih aktif; ledger harus ditinjau',
    previous_live_inventory_open: 'inventory live sebelumnya belum ditutup',
    previous_live_profit_withdrawal_pending: 'penarikan profit sebelumnya belum selesai',
    persistent_live_drawdown_stop: 'batas drawdown live telah tercapai',
    live_preflight_required: 'jalankan poly check untuk pemeriksaan wallet terbaru',
    live_preflight_blocked: 'pemeriksaan operasional atau wallet belum lulus',
    wallet_ledger_mismatch: 'saldo wallet berbeda dari catatan ledger',
    insufficient_polygon_gas: 'saldo POL untuk gas belum cukup',
    insufficient_pusd: 'saldo pUSD belum cukup',
};

export function parseControlArgs(argv) {
    const [command = 'status'] = argv;
    if (argv.length > 1 || !COMMANDS.includes(command)) throw new Error('eligible_use_poly_help');
    return command;
}

function replaceDirective(content, name, value) {
    const matcher = new RegExp(`^${name}=.*$`, 'gm');
    if ([...content.matchAll(matcher)].length !== 1) throw new Error('eligible_invalid_unit_template');
    return content.replace(matcher, () => `${name}=${value}`);
}

function readEnv(filename, optional = true) {
    try { return dotenv.parse(fs.readFileSync(filename)); }
    catch (error) {
        if (optional && error.code === 'ENOENT') return {};
        throw new Error('eligible_environment_unreadable');
    }
}

function selectedConfig(root, env) {
    const selected = { ...readEnv(path.join(root, '.env')), ...env }.ELIGIBLE_LIVE_CONFIG;
    if (selected) {
        if (!path.isAbsolute(selected)) throw new Error('eligible_config_requires_absolute_path');
        quoteSystemd(selected);
    }
    return selected || null;
}

function controlEnvironment(root, home, env) {
    const rootEnv = readEnv(path.join(root, '.env')), configFile = selectedConfig(root, env);
    const runtimeEnv = { ...rootEnv, ...env };
    const privateEnv = readEnv(configFile || path.join(home, '.config', 'polymarket-eligible-live.env'), !configFile);
    const externalFile = runtimeEnv.POLYMARKET_ENV_FILE || privateEnv.POLYMARKET_ENV_FILE;
    if (externalFile && !path.isAbsolute(externalFile)) throw new Error('eligible_env_requires_absolute_path');
    const externalEnv = externalFile ? readEnv(externalFile, false) : {};
    return { configFile, sources: [rootEnv, externalEnv, privateEnv, env],
        values: { ...externalEnv, ...privateEnv, ...runtimeEnv } };
}

export function renderEligibleUnit({ root = ROOT, node = process.execPath, home = os.homedir(), env = process.env,
    template = path.join(ROOT, 'deploy', UNIT) } = {}) {
    for (const location of [root, node, home]) {
        if (!path.isAbsolute(location)) throw new Error('eligible_requires_absolute_paths');
        quoteSystemd(location);
    }
    if (/["'\\]/.test(node)) throw new Error('eligible_unsupported_node_path');
    let content = fs.readFileSync(template, 'utf8');
    if (/^\s*\[Install\]/m.test(content) || !/^Restart=no$/m.test(content))
        throw new Error('eligible_invalid_unit_template');
    const literalPath = value => value.replace(/%/g, '%%') + (/[\\ ]$/.test(value) ? '/.' : '');
    content = replaceDirective(content, 'WorkingDirectory', literalPath(root));
    const { configFile, values } = controlEnvironment(root, home, env);
    const continuous = values.ELIGIBLE_CONTINUOUS_TRADING;
    if (continuous !== undefined && !['true', 'false'].includes(continuous))
        throw new Error('invalid_eligible_continuous_trading');
    // The runner parses private settings once, after the checkout's .env;
    // EnvironmentFile would incorrectly promote private values over .env.
    const environment = configFile ? [`ELIGIBLE_LIVE_CONFIG=${configFile}`]
        : env.ELIGIBLE_LIVE_CONFIG === '' ? ['ELIGIBLE_LIVE_CONFIG='] : [];
    if (continuous !== undefined) environment.push(`ELIGIBLE_CONTINUOUS_TRADING=${continuous}`);
    const wallet = values.PROXY_WALLET_ADDRESS;
    if (wallet !== undefined) {
        if (typeof wallet !== 'string' || !/^0x[\da-fA-F]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet))
            throw new Error('invalid_eligible_wallet_address');
        // Pin only the public address so monitoring can prove the running wallet.
        environment.push(`PROXY_WALLET_ADDRESS=${wallet}`);
    }
    content = replaceDirective(content, 'Environment', environment.map(quoteSystemd).join(' '));
    if (continuous === 'true') {
        if ([...content.matchAll(/^\[Unit\]$/gm)].length !== 1 || /^(?:RestartSec|StartLimitIntervalSec)=/m.test(content))
            throw new Error('eligible_invalid_unit_template');
        content = content.replace(/^\[Unit\]$/m, '[Unit]\nStartLimitIntervalSec=0');
        content = replaceDirective(content, 'Restart', 'on-failure\nRestartSec=5');
    }
    return replaceDirective(content, 'ExecStart', `:${[node, 'scripts/eligible-live.js', 'run', '--live'].map(quoteSystemd).join(' ')}`);
}

export function installEligibleUnit({ directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user'),
    ...renderOptions } = {}) {
    const destination = path.join(directory, UNIT), content = renderEligibleUnit(renderOptions);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.lstatSync(destination).isFile() || fs.readFileSync(destination, 'utf8') !== content)
            throw new Error('eligible_installed_unit_differs');
    }
    return destination;
}

export async function runFile(file, args, { cwd = ROOT, env = process.env,
    timeoutMs = 90000, killSignal = 'SIGTERM' } = {}) {
    return new Promise(resolve => {
        execFile(file, args, { cwd, env, timeout: timeoutMs, killSignal, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            const timedOut = error?.killed === true && error.signal === killSignal
                && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr, timedOut });
        });
    });
}

function jsonResult(result, unavailableCode = 'eligible_check_report_unavailable') {
    try {
        const row = JSON.parse(result.stdout);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
        return row;
    } catch { throw new Error(unavailableCode); }
}

function outputFilter(root, home, env) {
    const { sources } = controlEnvironment(root, home, env);
    const secrets = [...new Set(sources.flatMap(source => Object.entries(source))
        .filter(([key, value]) => SECRET_KEY.test(key) && typeof value === 'string' && value.length >= 8)
        .map(([, value]) => value))].sort((a, b) => b.length - a.length);
    const text = value => {
        let result = String(value);
        for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
        return result.replace(/\b(?:0x)?[a-f0-9]{64}\b/gi, '[REDACTED]')
            .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
            .replace(/((?:private.?key|api.?key|secret|passphrase|password|mnemonic|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[REDACTED]')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    };
    const json = value => {
        if (Array.isArray(value)) return value.map(json);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : json(item)]));
        return typeof value === 'string' ? text(value) : value;
    };
    return { text, json };
}

function safeCode(value) { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : 'unknown_guard'; }
function guardDescription(value) {
    const code = safeCode(value);
    return GUARDS[code] ? `${code}: ${GUARDS[code]}` : code;
}
function writeGuards(row, write) {
    if (Array.isArray(row.blockers)) for (const blocker of row.blockers) write(`Guard: ${guardDescription(blocker)}.`);
    const previous = row.previousLive;
    if (previous?.found && Array.isArray(previous.periods)) {
        for (const period of previous.periods) {
            const stop = safeCode(period.stopped?.reason || (period.liveRiskStopped ? 'live_risk_stop' : 'none'));
            const drawdown = Number.isFinite(period.maxDrawdown) ? period.maxDrawdown : 'belum diketahui';
            const label = period.riskAcknowledged ? 'Riwayat live diakui untuk periode baru' : 'Riwayat live';
            write(`${label}: stop ${stop}; drawdown ${drawdown}; inventory ${period.positionOpen ? 'terbuka' : 'kosong'}; penarikan ${period.withdrawalPending ? 'tertunda' : 'tidak tertunda'}.`);
        }
    }
    if (Array.isArray(row.checks)) for (const check of row.checks) {
        if (check && check.ok === false) write(`Pemeriksaan gagal: ${safeCode(check.name)} (${guardDescription(check.error?.code)}).`);
    }
}
function writeServiceStatus(result, write) {
    if (result.code !== 0) { write('Layanan belum tersedia atau systemd user belum dapat dibaca.'); return; }
    const lines = String(result.stdout).split('\n').filter(line => /^(?:LoadState|ActiveState)=[a-z-]+$|^MainPID=\d+$/.test(line));
    write(lines.length ? lines.join('\n') : 'Status layanan belum diketahui.');
}

export async function controlMain(argv, { run = runFile, install = installEligibleUnit, write = console.log,
    root = ROOT, node = process.execPath, nodeVersion = process.versions.node, home = os.homedir(), env = process.env, directory } = {}) {
    const command = parseControlArgs(argv);
    if (command === 'help') {
        write('poly status | check | config | new-period | install | start | stop | logs');
        write('Eligible live tanpa AI. Default: status. Konfigurasi runtime dari .env proyek dan konfigurasi eligible privat.');
        write('install hanya menulis unit manual; start memeriksa guard lalu menggunakan uang nyata.');
        write('new-period menyiapkan periode risiko baru dengan drawdown $10; aktivasi tetap manual.');
        write('Riwayat ledger, stop, dan drawdown periode lama tetap tersimpan.');
        return 0;
    }
    if (!/^24\./.test(nodeVersion)) throw new Error('eligible_requires_node_24');
    const filter = outputFilter(root, home, env), emit = line => write(filter.text(line));
    const cli = action => run(node, [path.join(root, 'scripts', 'eligible-live.js'), action],
        { cwd: root, env, ...(action === 'preflight' ? { timeoutMs: PREFLIGHT_TIMEOUT_MS, killSignal: 'SIGKILL' } : {}) });
    const service = (...args) => run('systemctl', ['--user', ...args], { cwd: root });
    const checkedService = async (...args) => {
        const result = await service(...args);
        if (result.code !== 0) throw new Error('eligible_service_command_failed');
        return result;
    };
    const installUnit = () => install({ root, node, home, env, ...(directory ? { directory } : {}) });
    if (command === 'new-period') {
        const result = await cli('new-period');
        if (result.code !== 0) {
            let code = 'eligible_new_period_failed';
            try {
                const reported = safeCode(JSON.parse(result.stderr).code);
                if (reported !== 'unknown_guard') code = reported;
            } catch {}
            throw new Error(code);
        }
        const row = jsonResult(result, 'eligible_new_period_report_unavailable');
        if (row.created !== true || row.automaticActivation !== false || row.drawdownStop !== 10
            || typeof row.id !== 'string' || !row.id || typeof row.runtimeId !== 'string' || !row.runtimeId
            || !Number.isFinite(row.openingBalance)) throw new Error('eligible_new_period_report_unavailable');
        emit(`Periode risiko baru disiapkan; saldo terverifikasi ${row.openingBalance} pUSD; batas drawdown $10.`);
        if (row.tradeReadiness?.receiptConfirmed?.length)
            emit(`${row.tradeReadiness.receiptConfirmed.length} trade lama dikonfirmasi melalui receipt dan market selesai; inventory on-chain kosong.`);
        writeGuards({ previousLive: row.previousLive }, emit);
        emit('Riwayat ledger, stop, dan drawdown periode lama tetap tersimpan.');
        emit('Puncak equity periode baru memakai saldo yang diverifikasi ulang saat start.');
        emit('Belum dijalankan. Gunakan poly check, lalu poly start untuk aktivasi manual.');
        return 0;
    }
    if (command === 'install') {
        emit(`Unit manual terpasang: ${installUnit()}`);
        emit('Belum dijalankan. Gunakan poly check, lalu poly start untuk aktivasi manual.');
        return 0;
    }
    if (command === 'config') {
        const result = await cli('config');
        if (result.code !== 0) throw new Error('eligible_config_unavailable');
        write(JSON.stringify(filter.json(jsonResult(result)), null, 2));
        return 0;
    }
    if (command === 'status') {
        const [report, status] = await Promise.all([cli('report'), service('show', UNIT, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID')]);
        if (report.code !== 0) throw new Error('eligible_check_report_unavailable');
        const row = jsonResult(report);
        emit(`Eligible live tanpa AI: ${row.liveStarted ? 'ledger sudah dimulai' : 'ledger belum dimulai'}.`);
        writeServiceStatus(status, emit);
        writeGuards(row, emit);
        emit('Pemeriksaan wallet terbaru: poly check');
        return 0;
    }
    if (command === 'logs') {
        const result = await run('journalctl', ['--user', '-u', UNIT, '-n', '50', '--no-pager'], { cwd: root });
        if (result.code !== 0) throw new Error('eligible_logs_unavailable');
        emit(result.stdout.trim()); return 0;
    }
    if (command === 'stop') {
        const status = await service('show', UNIT, '-p', 'LoadState', '--value');
        if (status.code === 0 && status.stdout.trim() === 'not-found') {
            emit('Layanan belum terpasang; tidak ada yang dihentikan.'); return 0;
        }
        await checkedService('stop', UNIT);
        emit('Layanan dihentikan. Periksa status inventory melalui poly status.'); return 0;
    }
    // Recovery admission starts the proof loop; preflight itself cannot clear a stop.
    emit('Memeriksa wallet, order, dan deposit. Batas waktu 10 menit.');
    let elapsedMs = 0, result;
    const progress = setInterval(() => {
        elapsedMs += PREFLIGHT_PROGRESS_MS;
        emit(`Pemeriksaan wallet, order, dan deposit masih berjalan (${elapsedMs / 1000} detik).`);
    }, PREFLIGHT_PROGRESS_MS);
    progress.unref?.();
    try { result = await cli('preflight'); }
    catch {
        emit('Laporan pemeriksaan tidak tersedia. Startup tidak dilanjutkan.');
        throw new Error('eligible_preflight_report_unavailable');
    }
    finally { clearInterval(progress); }
    if (result?.timedOut === true) {
        emit('Pemeriksaan melewati batas 10 menit dan dihentikan. Startup tidak dilanjutkan.');
        throw new Error('eligible_preflight_timeout');
    }
    let row;
    try { row = jsonResult(result, 'eligible_preflight_report_unavailable'); }
    catch {
        emit('Laporan pemeriksaan tidak tersedia. Startup tidak dilanjutkan.');
        throw new Error('eligible_preflight_report_unavailable');
    }
    emit(`Eligible tanpa AI; saldo ${Number.isFinite(row.balance) ? row.balance : 'belum diketahui'} pUSD.`);
    if (Number.isFinite(row.botCash)) emit(`Kas bot ${row.botCash} pUSD; hasil transaksi manual dicatat terpisah.`);
    writeGuards(row, emit);
    const allowed = result.code === 0 && row.operationalReady === true && row.readyForLive === true
        && row.startAllowed === true && row.automaticActivation === false
        && Array.isArray(row.blockers) && row.blockers.length === 0 && row.recoveryOnly !== true;
    const reviewed = [0, 1].includes(result.code) && row.operationalReady === true && row.startAllowed === true
        && row.readyForLive === false && row.recoveryOnly === true && row.automaticActivation === false
        && row.reviewedRecovery?.ready === true && row.reviewedRecovery.reason === 'verified_fill_fee_above_estimate'
        && Array.isArray(row.blockers) && row.blockers.length === 1 && row.blockers[0] === 'persistent_pilot_stop';
    const continuousRecovery = [0, 1].includes(result.code) && row.continuousRecoveryAvailable === true
        && row.operationalReady === true && row.readyForLive === false && row.startAllowed === false
        && row.recoveryOnly === false && row.automaticActivation === false
        && Array.isArray(row.blockers) && row.blockers.length === 1 && row.blockers[0] === 'persistent_pilot_stop';
    const depositRecovery = [0, 1].includes(result.code) && row.capitalDepositRecoveryAvailable === true
        && row.capitalDepositReview?.ready === true && (row.capitalDepositReview.amount > 0
            || row.capitalDepositReview.amount === 0 && row.capitalDepositReview.alreadyCredited === true)
        && row.continuousTrading === true && row.automaticActivation === false
        && Array.isArray(row.blockers) && row.blockers.length > 0
        && row.blockers.every(reason => ['persistent_pilot_stop', 'live_preflight_blocked'].includes(reason));
    const externalRecovery = [0, 1].includes(result.code) && row.externalActivityRecoveryAvailable === true
        && row.externalActivityReview?.ready === true && row.operationalReady === true
        && row.continuousTrading === true && row.automaticActivation === false
        && row.stopped?.reason === 'wallet_ledger_mismatch'
        && Array.isArray(row.blockers) && row.blockers.length === 1 && row.blockers[0] === 'persistent_pilot_stop';
    if (!allowed && !reviewed && !continuousRecovery && !depositRecovery && !externalRecovery) {
        emit('Startup live diblokir. Stop dan riwayat drawdown tetap tersimpan.'); return 1;
    }
    emit(externalRecovery ? 'Aktivitas manual terverifikasi. Start akan mencatatnya terpisah sebelum entry.'
        : depositRecovery ? 'Deposit terverifikasi. Start akan mencatat tambahan modal otomatis sebelum entry.'
        : continuousRecovery ? 'Pemulihan operasional tersedia. Entry menunggu bukti wallet, order, dan data terbaru.'
        : reviewed ? 'Receipt dan biaya sudah terverifikasi. Start akan merekonsiliasi posisi pada periode yang sama.'
            : 'Seluruh guard startup lulus. Aktivasi tetap manual.');
    if (command === 'check') return 0;
    installUnit();
    await checkedService('daemon-reload');
    await checkedService('start', UNIT);
    emit('Perintah start diterima; eligible live menggunakan uang nyata.');
    writeServiceStatus(await checkedService('show', UNIT, '-p', 'ActiveState', '-p', 'MainPID'), emit);
    emit('Pantau: poly status atau poly logs');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    controlMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
        const code = /^[a-z][a-z_]{1,80}$/.test(error.message || '') ? error.message : 'eligible_control_failed';
        console.error(`Poly: ${code}. Gunakan poly help. Riwayat ledger tetap tersimpan.`);
        process.exitCode = 1;
    });
}
