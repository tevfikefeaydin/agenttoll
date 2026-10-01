import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import monitor


class MonitorTests(unittest.TestCase):
    def state(self, directory, **changes):
        path = Path(directory) / 'current.json'
        path.write_text(json.dumps(dict(sha='a' * 40,
            container='agenttoll-r-20260914t162500z-aaaaaaaaaaaa', **changes)), encoding='utf-8')
        return path

    def test_monitor_uses_only_active_container_and_keeps_partial_coverage_visible(self):
        with tempfile.TemporaryDirectory() as directory:
            state = self.state(directory)
            evidence = {'ok': True, 'degraded': True, 'api': {'ok': True}, 'data': {'ok': True, 'degraded': True}}
            with patch.object(monitor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                    'ignored raw upstream output\nAGENTTOLL_MONITOR ' + json.dumps(evidence), 'private diagnostic')) as run:
                result = monitor.collect(state)
            command = run.call_args.args[0]
            self.assertEqual(command[:4], ['docker', 'exec', '-w', '/app'])
            self.assertEqual(command[4], 'agenttoll-r-20260914t162500z-aaaaaaaaaaaa')
            self.assertNotIn('shell', run.call_args.kwargs)
            self.assertTrue(result['ok'])
            self.assertTrue(result['degraded'])
            self.assertEqual(result['sourceRevision'], 'a' * 40)
            self.assertNotIn('private diagnostic', json.dumps(result))

    def test_invalid_state_cannot_select_an_unrelated_container(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'current.json'
            state.write_text(json.dumps({'sha': 'a' * 40, 'container': 'other-project'}))
            with patch.object(monitor.subprocess, 'run') as run:
                self.assertRaises(ValueError, monitor.collect, state)
                run.assert_not_called()

    def test_failed_incomplete_or_oversized_results_fail_closed(self):
        for output in ['AGENTTOLL_MONITOR {}', 'AGENTTOLL_MONITOR ' + 'x' * 100_001, 'not JSON']:
            with self.subTest(output=output[:30]), tempfile.TemporaryDirectory() as directory:
                with patch.object(monitor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, output, 'secret')):
                    self.assertRaises(ValueError, monitor.collect, self.state(directory))

    def test_stale_usage_archive_fails_monitor_even_when_api_and_data_are_available(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'archive.json'
            archive.write_text(json.dumps({'version': 2, 'bundle': {'state': {
                'collectedAt': '2026-09-28T09:16:37.288Z', 'entryCount': 28344},
                'report': {'coverage': {'collectionBacklogSeconds': 0}}}}))
            evidence = {'ok': True, 'degraded': False, 'api': {'ok': True}, 'data': {'ok': True}}
            with patch.object(monitor.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0,
                    'AGENTTOLL_MONITOR ' + json.dumps(evidence), '')):
                result = monitor.collect(self.state(directory), usage_path=archive,
                                         now=datetime(2026, 10, 1, tzinfo=timezone.utc))
            self.assertFalse(result['ok'])
            self.assertTrue(result['api']['ok'])
            self.assertEqual(result['usage']['status'], 'stale')

    def test_usage_health_rejects_future_or_missing_times_and_reports_backlog(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'archive.json'
            now = datetime(2026, 10, 1, tzinfo=timezone.utc)
            self.assertEqual(monitor.usage_status(p, now)['status'], 'missing')
            for stamp in [None, '2026-10-02T00:00:00.000Z']:
                p.write_text(json.dumps({'version': 2, 'bundle': {'state': {'collectedAt': stamp},
                    'report': {'coverage': {}}}}))
                result = monitor.usage_status(p, now)
                self.assertFalse(result['ok'])
                self.assertEqual(result['status'], 'invalid')
            p.write_text(json.dumps({'version': 2, 'bundle': {'state': {'collectedAt': '2026-09-30T23:59:00.000Z'},
                'report': {'coverage': {'collectionBacklogSeconds': 3600}}, 'secret': 'do-not-copy'}}))
            result = monitor.usage_status(p, now)
            self.assertEqual(result['status'], 'catching_up')
            self.assertFalse(result['ok'])
            self.assertNotIn('do-not-copy', json.dumps(result))

    def test_recent_collection_cannot_hide_a_stale_source_cursor(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'archive.json'
            p.write_text(json.dumps({'version': 2, 'bundle': {
                'state': {'collectedAt': '2026-10-01T11:46:00.000Z'},
                'report': {'coverage': {'sourceWindowUntil': '2026-10-01T11:32:00.000Z',
                                        'collectionBacklogSeconds': 840}}}}))
            result = monitor.usage_status(p, datetime(2026, 10, 1, 12, tzinfo=timezone.utc))
            self.assertFalse(result['ok'])
            self.assertEqual(result['status'], 'catching_up')
            self.assertEqual(result['sourceLagSeconds'], 1680)


if __name__ == '__main__':
    unittest.main()
