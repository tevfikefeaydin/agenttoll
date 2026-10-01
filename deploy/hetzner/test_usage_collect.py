"""Offline collector failure and atomicity tests; Docker is represented by a command fixture."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import usage_collect as c

CID = 'a' * 64
NOW = '2026-09-26T12:00:00.000Z'


def fake_store(args, data):
    request = json.loads(data)
    result = {'version': 2, 'containers': request['containers'], 'bundle': {
        'state': {'version': 2, 'startedAt': NOW, 'collectedAt': request['now'], 'segments': [], 'entryCount': 0},
        'report': {'coverage': {'complete': False, 'sourceWindowSince': request['sourceWindowSince'],
                               'sourceWindowUntil': request['sourceWindowUntil'],
                               'collectionBacklogSeconds': request['collectionBacklogSeconds']}}}}
    c.atomic_write(Path(args[-1]) / 'archive.json', result)
    return json.dumps(result).encode()


class CollectorTests(unittest.TestCase):
    def test_delayed_collection_advances_a_bounded_source_cursor(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            archive = directory / 'archive.json'
            archive.write_text(json.dumps({'version': 1, 'containers': [CID],
                'bundle': {'state': {'collectedAt': '2026-09-26T10:00:00.000Z'}, 'report': {}}}))
            windows = []
            requests = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    windows.append((args[3], args[5]))
                    return b''
                requests.append(json.loads(data))
                return fake_store(args, data)
            c.collect(directory, directory, run=run, now=NOW)
            self.assertEqual(windows[0][1], '2026-09-26T11:00:00.000Z')
            self.assertEqual(requests[0]['now'], NOW)
            self.assertEqual(requests[0]['sourceWindowUntil'], '2026-09-26T11:00:00.000Z')
            second = c.collect(directory, directory, run=run, now=NOW)
            self.assertEqual(windows[1], ('2026-09-26T10:50:00.000Z', NOW))
            self.assertEqual(second['bundle']['report']['coverage']['collectionBacklogSeconds'], 0)

    def test_bounded_initial_window_is_explicit_and_resume_uses_cursor(self):
        with tempfile.TemporaryDirectory() as d:
            windows = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    windows.append(args[3])
                    return b''
                return fake_store(args, data)
            c.collect(Path(d), Path(d), run=run, now=NOW, initial_hours=6)
            c.collect(Path(d), Path(d), run=run, now=NOW, initial_hours=6)
            self.assertEqual(windows, ['2026-09-26T06:00:00.000Z', '2026-09-26T06:50:00.000Z'])
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
            first = c.collect(Path(d), app, run=run, now=NOW, initial_hours=1)
            second = c.collect(Path(d), app, run=run, now='2026-09-26T12:05:00.000Z', initial_hours=1)
            self.assertEqual(second['bundle']['state']['entryCount'], 1)
            self.assertEqual(second['bundle']['report']['input']['matchingRecords'], 1)
            self.assertEqual(first['bundle']['state']['segments'], second['bundle']['state']['segments'])
            for p in Path(d).rglob('*.json'):
                self.assertNotIn('must-not-persist', p.read_text())
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
                return fake_store(args, data)
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

    def test_oversized_backlog_halves_window_without_dropping_sources_or_advancing_early(self):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            target = directory / 'archive.json'
            original = {'version': 1, 'containers': [CID], 'bundle': {
                'state': {'collectedAt': '2026-09-26T10:00:00.000Z'}, 'report': {}}}
            target.write_text(json.dumps(original))
            before = target.read_bytes()
            ends = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    self.assertEqual(target.read_bytes(), before)
                    ends.append(args[5])
                    if len(ends) == 1: raise c.OutputLimitExceeded('fixture bound')
                    return b''
                return fake_store(args, data)
            result = c.collect(directory, directory, run=run, now=NOW)
            self.assertEqual(ends, ['2026-09-26T11:00:00.000Z', '2026-09-26T10:30:00.000Z'])
            self.assertEqual(result['bundle']['report']['coverage']['collectionBacklogSeconds'], 5400)

    def test_source_command_failure_does_not_retry_or_commit_a_window(self):
        with tempfile.TemporaryDirectory() as d:
            calls = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    calls.append(args)
                    raise RuntimeError('Docker failed')
                self.fail('Failed window must not reach the store')
            with self.assertRaises(RuntimeError): c.collect(Path(d), Path(d), run=run, now=NOW)
            self.assertEqual(len(calls), 1)
            self.assertFalse((Path(d) / 'archive.json').exists())

    def test_large_already_collected_overlap_can_shrink_without_skipping_uncollected_time(self):
        self.check_overlap_recovery(400)
        # The forward window has reached one second, but the remaining overlap
        # is smaller than it. It must still shrink instead of causing a stall.
        self.check_overlap_recovery(1.2)

    def check_overlap_recovery(self, maximum_seconds):
        with tempfile.TemporaryDirectory() as d:
            directory = Path(d)
            (directory / 'archive.json').write_text(json.dumps({'version': 1, 'containers': [CID],
                'bundle': {'state': {'collectedAt': '2026-09-26T10:00:00.000Z'}, 'report': {}}}))
            windows = []
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs':
                    since, until = c.instant(args[3]), c.instant(args[5])
                    windows.append((since, until))
                    if (until-since).total_seconds() > maximum_seconds:
                        raise c.OutputLimitExceeded('fixture rate')
                    return b''
                return fake_store(args, data)
            result = c.collect(directory, directory, run=run, now=NOW)
            cursor = c.instant('2026-09-26T10:00:00.000Z')
            self.assertTrue(all(since <= cursor < until for since, until in windows))
            self.assertGreater(c.instant(result['bundle']['report']['coverage']['sourceWindowUntil']), cursor)

    def test_uncommitted_adapter_output_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            def run(args, data=None, limit=None):
                if args[1] == 'ps': return CID.encode()
                if args[1] == 'inspect': return json.dumps([{'Config': {'Labels': {'com.agenttoll.managed': 'autodeploy'}}}]).encode()
                if args[1] == 'logs': return b''
                response = fake_store(args, data)
                (Path(d) / 'archive.json').unlink()
                return response
            with self.assertRaisesRegex(ValueError, 'not committed'):
                c.collect(Path(d), Path(d), run=run, now=NOW)
if __name__ == '__main__': unittest.main()
