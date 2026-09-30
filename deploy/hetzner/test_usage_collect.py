"""Offline collector failure and atomicity tests; Docker is represented by a command fixture."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import usage_collect as c

CID = 'a' * 64
NOW = '2026-09-26T12:00:00.000Z'
class CollectorTests(unittest.TestCase):
    def test_bounded_initial_window_is_explicit_and_resume_uses_cursor(self):
        with tempfile.TemporaryDirectory() as d:
            windows = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    windows.append(args[3])
                    return b''
                return json.dumps({'state': {'collectedAt': NOW}, 'report': {'coverage': {'complete': False}}}).encode()
            c.collect(Path(d), Path(d), run=run, now=NOW, initial_hours=6)
            c.collect(Path(d), Path(d), run=run, now=NOW, initial_hours=6)
            self.assertEqual(windows, ['2026-09-26T06:00:00+00:00', '2026-09-26T11:50:00+00:00'])
    def test_real_archive_adapter_survives_collector_restart_and_overlap(self):
        app = Path(__file__).resolve().parents[2]
        log = json.dumps({'schemaVersion': 2, 'requestId': 'integration-quote', 't': NOW,
            'route': '/api/gas', 'method': 'GET', 'status': 402, 'terminal': 'finish',
            'abortReason': None, 'paymentStage': 'quote', 'paymentSubmitted': False,
            'paymentHeader': 'none', 'protocolVersion': 'none', 'paymentPhase': 'none',
            'paymentReason': None, 'facilitatorVerifyCalls': 0, 'facilitatorSettleCalls': 0,
            'facilitatorVerifyMs': 0, 'facilitatorSettleMs': 0, 'secret': 'must-not-persist'})
        def run(args, data=None, limit=c.MAX_LOG):
            if args[0] == 'node': return c.command(args, data=data, limit=limit)
            if args[1] == 'ps': return CID.encode()
            if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
            if args[1] == 'logs': return log.encode()
            self.fail('Unexpected command')
        with tempfile.TemporaryDirectory() as d:
            first = c.collect(Path(d), app, run=run, now=NOW)
            second = c.collect(Path(d), app, run=run, now='2026-09-26T12:05:00.000Z')
            self.assertEqual(len(second['bundle']['state']['entries']), 1)
            self.assertEqual(second['bundle']['report']['input']['matchingRecords'], 1)
            self.assertEqual(first['bundle']['state']['entries'], second['bundle']['state']['entries'])
            self.assertNotIn('must-not-persist', (Path(d) / 'archive.json').read_text())
    def test_docker_logs_includes_stderr_but_other_commands_discard_it(self):
        import sys
        real_popen = c.subprocess.Popen
        def fake_docker(args, **kwargs):
            return real_popen([sys.executable, '-c',
                'import sys; print("stdout"); print("stderr", file=sys.stderr)'], **kwargs)
        with patch.object(c.subprocess, 'Popen', side_effect=fake_docker):
            self.assertIn(b'stderr', c.command(['docker', 'logs', CID]))
            self.assertNotIn(b'stderr', c.command(['docker', 'inspect', CID]))
    def test_collection_selects_only_managed_and_commits_one_private_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            commands = []
            def run(args, data=None, limit=None):
                commands.append(args)
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs': return b'{"secret":"never archive raw logs"}'
                return json.dumps({'state': {'collectedAt': NOW}, 'report': {'coverage': {'complete': False}}}).encode()
            result = c.collect(Path(d), Path(d), run=run, now=NOW)
            saved = json.loads((Path(d) / 'archive.json').read_text())
            self.assertEqual(saved, result)
            self.assertNotIn('never archive', json.dumps(saved))
            self.assertIn('label=com.agenttoll.managed=autodeploy', commands[0])
            self.assertFalse(saved['bundle']['report']['coverage']['complete'])
    def test_source_failure_and_replace_failure_leave_last_good_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'archive.json'
            good = {'version': 1, 'containers': [CID], 'bundle': {'state': {'collectedAt': NOW}, 'report': {}}}
            p.write_text(json.dumps(good))
            before = p.read_bytes()
            with self.assertRaises(Exception):
                c.collect(Path(d), Path(d), run=lambda *a, **k: (_ for _ in ()).throw(RuntimeError('docker failed')), now=NOW)
            self.assertEqual(p.read_bytes(), before)
            with patch.object(c.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError): c.atomic_write(p, {'new': True})
            self.assertEqual(p.read_bytes(), before)
    def test_corrupt_state_fails_before_reading_sources(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / 'archive.json').write_text('{}')
            with self.assertRaises(Exception): c.collect(Path(d), Path(d), run=lambda *a, **k: self.fail('source read before validation'), now=NOW)
    def test_bounded_process_rejects_oversized_output_and_nonzero(self):
        import sys
        with self.assertRaises(Exception): c.command([sys.executable, '-c', 'print("x" * 10000)'], limit=100)
        with self.assertRaises(Exception): c.command([sys.executable, '-c', 'raise SystemExit(1)'])
if __name__ == '__main__': unittest.main()
