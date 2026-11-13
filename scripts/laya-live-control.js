import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT = 'polymarket-laya-live.service';

export function parseControlArgs(argv) {
    const [command = 'status'] = argv;
    if (argv.length > 1 || !['status', 'check', 'config', 'start', 'stop', 'logs', 'help'].includes(command))
        throw new Error('use_laya_live_status_check_config_start_stop_logs');
    return command;
}

async function runFile(file, args) {
    return new Promise(resolve => {
        execFile(file, args, { cwd: ROOT, timeout: 90000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr });
        });
    });
}

export function installUnit({ directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd/user'),
    template = path.join(ROOT, 'deploy', UNIT) } = {}) {
    const destination = path.join(directory, UNIT), content = fs.readFileSync(template);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try { fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.readFileSync(destination).equals(content)) throw new Error('installed_live_unit_differs');
    }
}

function jsonResult(result) {
    try { return JSON.parse(result.stdout); }
    catch { throw new Error('live_check_report_unavailable'); }
}

export async function controlMain(argv, { run = runFile, install = installUnit, write = console.log } = {}) {
    const command = parseControlArgs(argv);
    const cli = action => run(process.execPath, [path.join(ROOT, 'scripts/laya-live.js'), action]);
    const service = (...args) => run('systemctl', ['--user', ...args]);
    const checkedService = async (...args) => {
        const result = await service(...args);
        if (result.code !== 0) throw new Error('live_service_command_failed');
        return result;
    };
    if (command === 'help') {
        write('./scripts/laya-live status | check | config | start | stop | logs');
        write('start memeriksa guard lalu menjalankan layanan dengan uang nyata. Default hanya status.');
        return 0;
    }
    if (command === 'config') {
        const result = await cli('config');
        if (result.code !== 0) throw new Error('live_config_unavailable');
        write(JSON.stringify(jsonResult(result), null, 2)); return 0;
    }
    if (command === 'status') {
        const [report, status] = await Promise.all([cli('report'), service('show', UNIT, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID')]);
        if (report.code !== 0) throw new Error('live_check_report_unavailable');
        const row = jsonResult(report);
        write(`Ledger live: ${row.liveStarted ? 'sudah dimulai' : 'belum dimulai'}.`);
        write(status.code === 0 ? status.stdout.trim() : 'Layanan live belum tersedia atau systemd user tidak dapat dibaca.');
        if (row.rehearsal?.found) write(`Rehearsal: PnL ${row.rehearsal.netTradingPnl} virtual; stop ${row.rehearsal.riskStopActive ? 'aktif' : 'tidak aktif'}.`);
        if (row.blockers?.length) write(`Guard: ${row.blockers.join(', ')}.`);
        if (row.warnings?.length) write(`Catatan paper: ${row.warnings.join(', ')}.`);
        write('Pemeriksaan wallet terbaru: ./scripts/laya-live check'); return 0;
    }
    if (command === 'logs') {
        const result = await run('journalctl', ['--user', '-u', UNIT, '-n', '50', '--no-pager']);
        if (result.code !== 0) throw new Error('live_logs_unavailable');
        write(result.stdout.trim()); return 0;
    }
    if (command === 'stop') {
        const status = await service('show', UNIT, '-p', 'LoadState', '--value');
        if (status.code === 0 && status.stdout.trim() === 'not-found') {
            write('Layanan live belum terpasang; tidak ada yang dihentikan.'); return 0;
        }
        await checkedService('stop', UNIT);
        write('Layanan live dihentikan. Cek status inventory sebelum menjalankannya kembali.'); return 0;
    }
    // Both check and start run the same read-only preflight. An unsuccessful
    // check cannot install a unit, start a service, or reset any ledger/stop.
    const result = await cli('preflight'), row = jsonResult(result);
    write(`Laya: ${row.provider?.laya?.ready ? 'siap' : 'belum siap'}; saldo ${row.balance ?? 'tidak diketahui'} pUSD; tanpa minimum modal startup.`);
    if (row.allocatedCapital !== undefined) write(`Alokasi modal: ${row.allocatedCapital ?? 'tidak diketahui'} pUSD; tanpa batas modal startup.`);
    if (row.warnings?.length) write(`Catatan paper: ${row.warnings.join(', ')}.`);
    const allowed = result.code === 0 && row.operationalReady === true && row.readyForLive === true
        && row.startAllowed === true && row.automaticActivation === false
        && Array.isArray(row.blockers) && row.blockers.length === 0;
    const recovery = result.code === 1 && row.startAllowed === true && row.recoveryOnly === true
        && row.readyForLive === false && row.otherPilotHistory === false && row.automaticActivation === false
        && Array.isArray(row.blockers) && row.blockers.length > 0;
    if (!allowed) {
        write(`Entry live diblokir: ${row.blockers?.join(', ') || 'live_preflight_blocked'}.`);
        for (const check of row.checks || []) if (!check.ok) write(`Pemeriksaan gagal: ${check.name} (${check.error?.code || 'failed'}).`);
        if (command !== 'start' || !recovery) return 1;
        write('Hanya recovery inventory yang sudah terbuka; entry baru tetap dihentikan.');
    } else {
        write('Seluruh guard startup lulus.');
    }
    if (command === 'check') return 0;
    install();
    await checkedService('daemon-reload');
    await checkedService('start', UNIT);
    const status = await checkedService('show', UNIT, '-p', 'ActiveState', '-p', 'MainPID');
    write('Perintah start live diterima; layanan memakai uang nyata.');
    write(status.stdout.trim());
    write('Pantau: ./scripts/laya-live status atau ./scripts/laya-live logs');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    controlMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
        const code = /^[a-z][a-z_]{1,80}$/.test(error.message || '') ? error.message : 'live_control_failed';
        console.error(`Laya: ${code}. Tidak ada guard yang direset.`); process.exitCode = 1;
    });
}
