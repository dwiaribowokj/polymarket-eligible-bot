#!/usr/bin/env python3
"""Read-only eligible-live monitor. Only its own tracker is ever written.

First run (or migration from the old tracker) establishes a silent baseline.
Use --init-baseline explicitly during installation; this never replays history.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

WIB = ZoneInfo('Asia/Jakarta')
TERMINAL_DIR = Path(__file__).resolve().parents[1]
SERVICE = 'polymarket-eligible-live.service'
TRACKER_FILE = TERMINAL_DIR / 'data/restart/cron-monitor-state.json'
COLLATERAL = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
RPCS = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org',
        'https://rpc.ankr.com/polygon']
VERSION = 3


def wallet_address(value):
    if (not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value)
            or int(value[2:], 16) == 0):
        return None
    return value.lower()


def service_info():
    try:
        res = subprocess.run(['systemctl', '--user', 'show', SERVICE,
                              '-p', 'ActiveState', '-p', 'SubState', '-p', 'WorkingDirectory',
                              '-p', 'Environment', '-p', 'MainPID'],
                             capture_output=True, text=True, timeout=8, check=True)
        info = dict(line.split('=', 1) for line in res.stdout.splitlines() if '=' in line)
        return info
    except (OSError, subprocess.SubprocessError):
        return {'ActiveState': 'unknown', 'SubState': 'unknown'}


def discover_ledger(info):
    """Import only the frozen runtime's pure config resolver; never run its CLI."""
    cwd = info.get('WorkingDirectory')
    if cwd and (Path(cwd) / 'src/eligible-live/config.js').is_file():
        try:
            # Do not let a wallet/config from the caller override the service.
            env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'XDG_CONFIG_HOME')
                   if key in os.environ}
            env.update(item.split('=', 1) for item in shlex.split(info.get('Environment', ''))
                       if '=' in item)
            node = shutil.which('node') or 'node'
            pid = info.get('MainPID', '0')
            if pid.isdigit() and pid != '0':
                node = os.readlink(f'/proc/{pid}/exe')
                env = dict(item.split('=', 1) for item in
                           Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in item)
            script = ("import {eligibleEnvironment,loadEligibleConfig} from './src/eligible-live/config.js';"
                      "const c=loadEligibleConfig(eligibleEnvironment());"
                      "console.log(JSON.stringify({id:c.id,dataDir:c.settings.dataDir,wallet:c.settings.wallet}));")
            res = subprocess.run([node, '--input-type=module', '-e', script], cwd=cwd,
                                 env=env, capture_output=True, text=True, timeout=12, check=True)
            config = json.loads(res.stdout.strip().splitlines()[-1])
            period = config['id']
            if (len(period) == 16 and all(c in '0123456789abcdef' for c in period)
                    and Path(config['dataDir']).is_absolute()):
                wallet = wallet_address(config.get('wallet'))
                # dotenv files may have changed since the live process started.
                # Only its initial environment can prove the active balance wallet.
                balance_verified = bool(pid.isdigit() and pid != '0' and wallet
                                        and wallet_address(env.get('PROXY_WALLET_ADDRESS')) == wallet)
                return (Path(config['dataDir']) / period / 'pilot/late-entry.json',
                        'runtime config', wallet, balance_verified)
        except (OSError, ValueError, TypeError, KeyError, IndexError, subprocess.SubprocessError):
            pass
    raise RuntimeError('ledger_runtime_unavailable_use_state_file')


def format_ts(value):
    if not value:
        return 'n/a'
    try:
        if isinstance(value, str) and not value.isdigit():
            dt = datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(WIB)
        else:
            dt = datetime.fromtimestamp(float(value) / 1000, tz=WIB)
        return dt.strftime('%d-%m-%Y %H:%M:%S WIB')
    except (ValueError, TypeError, OverflowError):
        return 'n/a'


def normalize_stop(value):
    if not value:
        return None
    if isinstance(value, dict):
        for key in ('reason', 'code', 'message', 'type'):
            if value.get(key):
                return normalize_stop(value[key])
        # Metadata timestamps/counters must not turn one stop into repeated alerts.
        value = {k: v for k, v in value.items()
                 if k not in ('at', 'timestamp', 'updatedAt', 'stoppedAt', 'count')}
        return json.dumps(value, sort_keys=True, separators=(',', ':'))
    return ' '.join(str(value).split())


def number(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def filled(trade):
    return (trade.get('traded') is True
            or any(number(o.get('filled')) > 0 or number(o.get('settled')) > 0
                   for o in trade.get('orders', []))
            or any(number(f.get('shares')) > 0 for f in trade.get('fills', [])))


def trade_key(trade):
    # An order ID can appear after the position is reserved. It must not turn
    # one entry into two alerts, nor may later PnL/fill updates replay a trade.
    return json.dumps([market_slug(trade), trade.get('openedAt')], separators=(',', ':'))


def market_slug(trade):
    return trade.get('slug') or (trade.get('market') or {}).get('slug', 'unknown')


def valid_trade(trade):
    return (isinstance(trade, dict)
            and (trade.get('market') is None or isinstance(trade['market'], dict))
            and all(isinstance(trade.get(key, []), list)
                    and all(isinstance(row, dict) for row in trade.get(key, []))
                    for key in ('orders', 'fills')))


def snapshot(data, info, path, error=None, wallet=None):
    completed = data.get('completed', [])
    position = data.get('position')
    return {'version': VERSION, 'service': SERVICE, 'ledger': str(path), 'wallet': wallet,
            'status': info.get('ActiveState', 'unknown'),
            'substatus': info.get('SubState', 'unknown'),
            'stop': normalize_stop(data.get('stopped')),
            'risk_stop': normalize_stop(data.get('liveRiskStop')),
            'error': error, 'ledger_baselined': error is None,
            'position': trade_key(position) if position else None,
            'seen_trades': [trade_key(t) for t in completed]}


def changes(data, current, previous):
    """Return only transitions, including stops and missing/unreadable ledger."""
    if (not previous or previous.get('version') != VERSION or previous.get('service') != SERVICE
            or current['ledger'] != previous.get('ledger')
            or current['wallet'] != previous.get('wallet')):
        return []
    messages = []
    health = ('status', 'substatus', 'stop', 'risk_stop', 'error')
    if any(current.get(k) != previous.get(k) for k in health):
        unhealthy = (current['status'] != 'active' or current['stop']
                     or current['risk_stop'] or current['error'])
        messages.append(('⚠️ **Eligible Live: berhenti / perlu perhatian**' if unhealthy
                         else '✅ **Eligible Live: pulih / aktif**')
                        + f"\n- **Service:** `{current['status']}/{current['substatus']}`"
                        + f"\n- **Alasan Stop:** `{current['stop'] or current['risk_stop'] or 'tidak ada'}`"
                        + (f"\n- **Ledger:** `{current['error']}`" if current['error'] else ''))
    # A different ledger is a new baseline, not a replay of another period.
    same_ledger = current['ledger'] == previous.get('ledger')
    seen = set(previous.get('seen_trades', []))
    if (same_ledger and not current['error']
            and previous.get('ledger_baselined', not previous.get('error'))):
        trade_number = 0
        for completion_number, trade in enumerate(data.get('completed', []), 1):
            trade_number += int(filled(trade))
            key = trade_key(trade)
            if key in seen:
                continue
            seen.add(key)
            pnl = number(trade.get('pnl'))
            result = ('Menang' if pnl > 0 else 'Kalah' if pnl < 0 else 'Impas') if filled(trade) else 'Tidak terisi / dilewati'
            messages.append(f"🔔 **Eligible Live: {result}**\n- **Nomor:** completion #{completion_number}"
                            + (f" / trade terisi #{trade_number}" if filled(trade) else " / tanpa fill")
                            + f"\n- **Market:** `{trade.get('slug', 'unknown')}`"
                            f"\n- **Waktu Entry:** {format_ts(trade.get('openedAt'))}"
                            f"\n- **Waktu Selesai:** {format_ts(trade.get('closedAt'))}"
                            f"\n- **Modal:** `{number(trade.get('entryCost')):.6f} pUSD`"
                            f" | **PnL:** `{pnl:+.6f} pUSD`")
        if current['position'] and current['position'] != previous.get('position'):
            p = data['position']
            messages.append(f"🎯 **Eligible Live: posisi baru**\n- **Market:** `{market_slug(p)}`"
                            f"\n- **Waktu Entry:** {format_ts(p.get('openedAt'))}"
                            f"\n- **Modal:** `{number(p.get('entryCost')):.6f} pUSD`")
    return messages


def get_onchain_balance(wallet):
    wallet = wallet_address(wallet)
    if not wallet:
        return None
    payload = {'jsonrpc': '2.0', 'method': 'eth_call', 'id': 1,
               'params': [{'to': COLLATERAL,
                            'data': '0x70a08231' + wallet[2:].zfill(64)}, 'latest']}
    for rpc in RPCS:
        try:
            req = urllib.request.Request(rpc, data=json.dumps(payload).encode(),
                                         headers={'Content-Type': 'application/json', 'User-Agent': 'OpenClawMonitor/2.0'})
            with urllib.request.urlopen(req, timeout=4) as response:
                return int(json.load(response)['result'], 16) / 1e6
        except Exception:
            continue
    # Some Polygon providers reject urllib (403) but accept Node's native fetch.
    try:
        script = """const [urls,payload]=process.argv.slice(1).map(JSON.parse);
for (const url of urls) { try {
 const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify(payload),signal:AbortSignal.timeout(4000)});
 const j=await r.json(); if(r.ok && /^0x[0-9a-f]+$/i.test(j.result)) {
 console.log(j.result); process.exit(0); }
} catch {} } process.exit(1);"""
        res = subprocess.run([shutil.which('node') or 'node', '--input-type=module', '-e', script,
                              json.dumps(RPCS), json.dumps(payload)],
                             capture_output=True, text=True, timeout=14, check=True)
        return int(res.stdout.strip(), 16) / 1e6
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def save_tracker(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            json.dump(state, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def run(args):
    info = service_info()
    if args.state_file:
        path, source = args.state_file.resolve(), 'explicit'
        # Explicit ledger mode also requires the user to select its wallet.
        # Without one, monitoring still works but no balance RPC is attempted.
        wallet = wallet_address(os.environ.get('PROXY_WALLET_ADDRESS'))
        balance_verified = bool(wallet)
    else:
        path, source, wallet, balance_verified = discover_ledger(info)
    if path.resolve() in (args.tracker.resolve(), Path(str(args.tracker) + '.lock').resolve()):
        raise RuntimeError('tracker_must_be_separate_from_ledger')
    data, error = {}, None
    try:
        data = json.loads(path.read_text())
        if (not isinstance(data, dict) or not isinstance(data.get('completed'), list)
                or any(not valid_trade(trade) for trade in data['completed'])
                or data.get('position') is not None and not valid_trade(data['position'])):
            raise ValueError('invalid ledger schema')
    except FileNotFoundError:
        data, error = {}, 'state file tidak ditemukan'
    except (OSError, ValueError):
        data, error = {}, 'state file tidak terbaca / invalid'
    try:
        previous = json.loads(args.tracker.read_text())
    except (OSError, ValueError):
        previous = None
    if (not isinstance(previous, dict) or not isinstance(previous.get('seen_trades', []), list)
            or any(not isinstance(key, str) for key in previous.get('seen_trades', []))):
        previous = None
    current = snapshot(data, info, path, error, wallet)
    messages = [] if args.init_baseline else changes(data, current, previous)
    # Preserve seen identities through transient ledger errors and list reordering.
    if (previous and previous.get('version') == VERSION and previous.get('service') == SERVICE
            and previous.get('ledger') == current['ledger']
            and previous.get('wallet') == wallet and not args.init_baseline):
        current['seen_trades'] = sorted(set(current['seen_trades']) | set(previous.get('seen_trades', [])))
        if error:
            current['ledger_baselined'] = previous.get('ledger_baselined', not previous.get('error'))
            current['position'] = previous.get('position')
    if messages:
        real = get_onchain_balance(wallet) if balance_verified else None
        completed = data.get('completed', [])
        count = sum(filled(t) for t in completed)
        cash = f"{number(data.get('cash')):.6f} pUSD" if not error else 'n/a'
        balance = (f'{real:.6f} pUSD' if real is not None else
                   'n/a (wallet runtime belum terverifikasi)' if wallet and not balance_verified else
                   'n/a (RPC tidak tersedia)' if wallet else 'n/a (wallet belum dikonfigurasi / invalid)')
        messages.append(f"- **Waktu Laporan:** {datetime.now(WIB).strftime('%d-%m-%Y %H:%M:%S WIB')}"
                        f"\n- **Kas Ledger:** `{cash}`"
                        f"\n- **Saldo Riil Wallet (On-Chain):** `{balance}`"
                        f"\n- **Completed:** {len(completed)} | **Terisi:** {count} | **Tidak terisi:** {len(completed) - count}"
                        f"\n- **Sumber Ledger ({source}):** `{path}`")
    save_tracker(args.tracker, current)
    return '\n\n'.join(messages) if messages else 'OK_SILENT'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--init-baseline', action='store_true', help='silently baseline current state, no RPC/history replay')
    parser.add_argument('--tracker', type=Path, default=TRACKER_FILE)
    parser.add_argument('--state-file', type=Path, help='explicit ledger; optional balance wallet from PROXY_WALLET_ADDRESS')
    args = parser.parse_args()
    if args.state_file and args.state_file.resolve() in (
            args.tracker.resolve(), Path(str(args.tracker) + '.lock').resolve()):
        parser.error('tracker_must_be_separate_from_ledger')
    args.tracker.parent.mkdir(parents=True, exist_ok=True)
    # Concurrent cron invocations cannot report the same transition twice.
    with open(str(args.tracker) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            print(run(args))
        except RuntimeError as error:
            print(str(error), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
