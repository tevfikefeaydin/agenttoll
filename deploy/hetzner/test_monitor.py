import json
import subprocess
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
