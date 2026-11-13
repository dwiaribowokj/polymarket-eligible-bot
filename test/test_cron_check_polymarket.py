import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('monitor', ROOT / 'scripts/cron-check-polymarket.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'ledger.json'
        self.data = json.loads((ROOT / 'test/fixtures/cron-monitor/ledger.json').read_text())
        self.write()
        self.environment = patch.dict(os.environ, {'PROXY_WALLET_ADDRESS': '0x' + '1' * 40})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.args = argparse.Namespace(state_file=self.path, tracker=Path(self.tmp.name) / 'tracker.json', init_baseline=False)
        self.info = {'ActiveState': 'active', 'SubState': 'running'}
        self.service = patch.object(m, 'service_info', side_effect=lambda: self.info)
        self.service.start()
        self.addCleanup(self.service.stop)
        self.rpc = patch.object(m, 'get_onchain_balance', return_value=10.123456)
        self.balance = self.rpc.start()
        self.addCleanup(self.rpc.stop)

    def write(self):
        self.path.write_text(json.dumps(self.data))

    def run_monitor(self):
        return m.run(self.args)

    def test_baseline_and_old_tracker_no_historical_replay(self):
        self.args.tracker.write_text('{"last_completed_count":0}')
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.balance.assert_not_called()

    def test_stopped_dedup_and_normalized_reason(self):
        self.run_monitor()
        self.data['stopped'] = {'reason': 'risk_limit', 'at': 1}
        self.write()
        self.assertIn('risk_limit', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.data['stopped']['at'] = 2
        self.write()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.data['stopped'] = 'risk_limit'
        self.write()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.data['stopped'] = None
        self.write()
        self.assertIn('pulih', self.run_monitor())

    def test_dead_service_once_and_recovery(self):
        self.run_monitor()
        self.info = {'ActiveState': 'inactive', 'SubState': 'dead'}
        report = self.run_monitor()
        self.assertIn('inactive/dead', report)
        self.assertIn('WIB', report)
        self.assertIn('12.500000', report)
        self.assertIn('10.123456', report)
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.info = {'ActiveState': 'active', 'SubState': 'running'}
        self.assertIn('pulih', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_trade_once_and_filled_unfilled_counts(self):
        self.run_monitor()
        self.data['completed'].extend([
            {'slug': 'new-filled', 'openedAt': 1792828141523, 'closedAt': 1792828293880,
             'traded': True, 'pnl': 1, 'entryCost': 4},
            {'slug': 'new-unfilled', 'openedAt': 1792828141523, 'traded': False, 'pnl': 0}])
        self.write()
        report = self.run_monitor()
        self.assertIn('new-filled', report)
        self.assertIn('new-unfilled', report)
        self.assertIn('Terisi:** 2', report)
        self.assertIn('Tidak terisi:** 1', report)
        self.assertNotIn('historical', report)
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.data['completed'].reverse()
        self.write()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_missing_state_dedup_no_trade_replay_on_recovery(self):
        self.run_monitor()
        self.path.unlink()
        self.assertIn('tidak ditemukan', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.write()
        self.assertNotIn('historical', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_initially_missing_ledger_does_not_replay_history(self):
        self.path.unlink()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.write()
        report = self.run_monitor()
        self.assertIn('pulih', report)
        self.assertNotIn('historical', report)
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_explicit_baseline_silences_stop(self):
        self.data['stopped'] = {'reason': 'existing_stop'}
        self.write()
        self.args.init_baseline = True
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.args.init_baseline = False
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.balance.assert_not_called()

    def test_fill_evidence_without_traded_flag(self):
        self.assertTrue(m.filled({'orders': [{'filled': '2.1'}]}))
        self.assertFalse(m.filled({'orders': [{'filled': 0, 'status': 'rejected'}]}))

    def test_wallet_change_starts_silent_baseline(self):
        self.run_monitor()
        os.environ['PROXY_WALLET_ADDRESS'] = '0x' + '2' * 40
        self.data['completed'].append({'slug': 'different-wallet-history'})
        self.data['stopped'] = 'existing_stop'
        self.write()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.balance.assert_not_called()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_new_ledger_starts_silent_baseline(self):
        self.run_monitor()
        self.args.state_file = Path(self.tmp.name) / 'other-ledger.json'
        self.args.state_file.write_text(json.dumps({**self.data, 'stopped': 'existing_stop'}))
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.balance.assert_not_called()

    def test_missing_or_invalid_wallet_never_queries_rpc(self):
        for wallet in ['', 'invalid', '0x' + '0' * 40]:
            with self.subTest(wallet=wallet):
                os.environ['PROXY_WALLET_ADDRESS'] = wallet
                self.args.tracker.unlink(missing_ok=True)
                self.data['stopped'] = None
                self.write()
                self.run_monitor()
                self.data['stopped'] = 'risk_limit'
                self.write()
                self.assertIn('wallet belum dikonfigurasi / invalid', self.run_monitor())
        self.balance.assert_not_called()

    def test_explicit_wallet_is_normalized_and_not_printed(self):
        os.environ['PROXY_WALLET_ADDRESS'] = '0x' + 'aB' * 20
        self.run_monitor()
        self.info = {'ActiveState': 'inactive', 'SubState': 'dead'}
        report = self.run_monitor()
        self.balance.assert_called_once_with('0x' + 'ab' * 20)
        self.assertNotIn(os.environ['PROXY_WALLET_ADDRESS'], report)

    def test_tracker_cannot_overwrite_ledger(self):
        original = self.path.read_bytes()
        for tracker in [self.path, self.path.parent / 'ledger']:
            with self.subTest(tracker=tracker):
                if tracker != self.path:
                    self.args.state_file = Path(str(tracker) + '.lock')
                    self.args.state_file.write_bytes(original)
                self.args.tracker = tracker
                with self.assertRaisesRegex(RuntimeError, 'tracker_must_be_separate_from_ledger'):
                    self.run_monitor()
                self.assertEqual(self.args.state_file.read_bytes(), original)

    def test_corrupt_ledger_reports_once_then_recovers(self):
        self.run_monitor()
        self.path.write_text(json.dumps({'completed': [None]}))
        self.assertIn('invalid', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')
        self.write()
        self.assertIn('pulih', self.run_monitor())
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_live_position_market_and_order_updates_are_reported_once(self):
        self.run_monitor()
        self.data['position'] = {'market': {'slug': 'new-position'}, 'openedAt': 1700000400000,
                                 'orders': [], 'entryCost': 4}
        self.write()
        self.assertIn('new-position', self.run_monitor())
        self.data['position']['orders'].append({'orderId': 'later-order', 'filled': 5})
        self.write()
        self.assertEqual(self.run_monitor(), 'OK_SILENT')

    def test_unverified_runtime_wallet_never_queries_rpc(self):
        self.args.state_file = None
        with patch.object(m, 'discover_ledger', return_value=(self.path, 'runtime config', '0x' + '2' * 40, False)):
            self.run_monitor()
            self.info = {'ActiveState': 'inactive', 'SubState': 'dead'}
            self.assertIn('wallet runtime belum terverifikasi', self.run_monitor())
        self.balance.assert_not_called()


class DiscoveryTests(unittest.TestCase):
    def test_failure_never_uses_a_historical_ledger(self):
        with self.assertRaisesRegex(RuntimeError, 'ledger_runtime_unavailable_use_state_file'):
            m.discover_ledger({})

    @patch.object(m.Path, 'is_file', return_value=True)
    @patch.object(m.subprocess, 'run')
    def test_runtime_uses_period_id_and_its_wallet(self, run, _is_file):
        runtime_wallet = '0x' + '2' * 40
        run.return_value.stdout = json.dumps({'id': 'a' * 16, 'runtimeId': 'b' * 16,
                                              'dataDir': '/tmp/monitor-fixture', 'wallet': runtime_wallet})
        with patch.dict(os.environ, {'PROXY_WALLET_ADDRESS': '0x' + '3' * 40}):
            path, source, wallet, balance_verified = m.discover_ledger({'WorkingDirectory': '/tmp/runtime-fixture'})
        self.assertEqual(path, Path('/tmp/monitor-fixture') / ('a' * 16) / 'pilot/late-entry.json')
        self.assertEqual(source, 'runtime config')
        self.assertEqual(wallet, runtime_wallet)
        self.assertFalse(balance_verified)
        env = run.call_args.kwargs['env']
        self.assertNotIn('PROXY_WALLET_ADDRESS', env)
        self.assertEqual(run.call_args.kwargs['cwd'], '/tmp/runtime-fixture')

    @patch.object(m.Path, 'read_text')
    @patch.object(m.os, 'readlink', return_value='/tmp/node-fixture')
    @patch.object(m.Path, 'is_file', return_value=True)
    @patch.object(m.subprocess, 'run')
    def test_active_process_wallet_must_match_resolver(self, run, _is_file, _readlink, read_text):
        startup_wallet = '0x' + '2' * 40
        for configured in [startup_wallet, '0x' + '3' * 40]:
            with self.subTest(configured=configured):
                read_text.return_value = f'PROXY_WALLET_ADDRESS={startup_wallet}\0PATH=/usr/bin\0'
                run.return_value.stdout = json.dumps({'id': 'a' * 16, 'dataDir': '/tmp/monitor-fixture',
                                                      'wallet': configured})
                result = m.discover_ledger({'WorkingDirectory': '/tmp/runtime-fixture', 'MainPID': '123'})
                self.assertEqual(result[3], configured == startup_wallet)
                self.assertEqual(run.call_args.args[0][0], '/tmp/node-fixture')
                self.assertEqual(run.call_args.kwargs['env']['PROXY_WALLET_ADDRESS'], startup_wallet)

    @patch.object(m.Path, 'read_text', return_value='PATH=/usr/bin\0')
    @patch.object(m.os, 'readlink', return_value='/tmp/node-fixture')
    @patch.object(m.Path, 'is_file', return_value=True)
    @patch.object(m.subprocess, 'run')
    def test_active_process_without_wallet_cannot_borrow_callers_wallet(self, run, _is_file, _readlink, _read_text):
        wallet = '0x' + '2' * 40
        run.return_value.stdout = json.dumps({'id': 'a' * 16, 'dataDir': '/tmp/monitor-fixture', 'wallet': wallet})
        with patch.dict(os.environ, {'PROXY_WALLET_ADDRESS': wallet}):
            result = m.discover_ledger({'WorkingDirectory': '/tmp/runtime-fixture', 'MainPID': '123'})
        self.assertFalse(result[3])
        self.assertNotIn('PROXY_WALLET_ADDRESS', run.call_args.kwargs['env'])

    def test_invalid_wallet_is_rejected_before_network(self):
        with patch.object(m.urllib.request, 'urlopen') as request:
            self.assertIsNone(m.get_onchain_balance('invalid'))
            self.assertIsNone(m.get_onchain_balance('0x' + '0' * 40))
        request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
