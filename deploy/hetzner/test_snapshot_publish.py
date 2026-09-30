"""Real Git publication regressions; local bare origins only, no wallet/network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).resolve().parents[2] / 'scripts/publish-snapshot.mjs'


class SnapshotPublishTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='agenttoll-publish-test-')
        self.root = Path(self.temporary.name)
        self.origin = self.root / 'origin.git'
        self.origin.mkdir()
        self.git(self.origin, 'init', '--bare', '--initial-branch=main')
        self.author = self.root / 'author'
        self.git(self.root, 'clone', str(self.origin), str(self.author))
        self.write(self.author, 'README.md', 'Initial\n')
        self.write(self.author, 'data/stats.json', '{"block":1}\n')
        self.write(self.author, 'data/scout/2026-09-29.json', '{"date":"2026-09-29"}\n')
        self.write(self.author, 'data/scout/index.json', '{"dates":["2026-09-29"]}\n')
        self.commit(self.author, 'initial')
        self.git(self.author, 'push', 'origin', 'main')
        self.job = self.root / 'job'
        self.git(self.root, 'clone', str(self.origin), str(self.job))
        self.artifact = self.root / 'capture'
        self.env = {**os.environ, 'GITHUB_ACTIONS': 'false'}

    def tearDown(self):
        self.temporary.cleanup()

    def git(self, cwd, *args):
        return subprocess.check_output(['git', '-C', str(cwd), '-c', 'user.name=Test',
                                        '-c', 'user.email=test@example.invalid', *args], stderr=subprocess.DEVNULL)

    def write(self, cwd, name, value):
        target = cwd / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value, encoding='utf-8', newline='\n')

    def commit(self, cwd, message):
        self.git(cwd, 'add', '.')
        self.git(cwd, 'commit', '-m', message)

    def helper(self, *args, check=True):
        result = subprocess.run(['node', str(HELPER), *args], cwd=self.job, env=self.env,
                                capture_output=True, text=True, timeout=20)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def capture(self, kind):
        self.helper('--capture', kind, '--artifact-dir', str(self.artifact))
        return json.loads((self.artifact / 'capture.json').read_text())

    def remote(self, name):
        return self.git(self.origin, 'show', 'main:' + name).decode()

    def rejection_hook(self, reject_count):
        count = self.root / 'push-count'
        hook = self.origin / 'hooks/pre-receive'
        hook.write_text('#!/bin/sh\n'
                        f'printf x >> "{count}"\n'
                        f'if [ "$(wc -c < "{count}")" -le {reject_count} ]; then exit 1; fi\n'
                        'exit 0\n', encoding='utf-8', newline='\n')
        hook.chmod(0o755)
        return count

    def test_scout_rebases_saved_capture_and_rebuilds_index_without_overwriting(self):
        filename = 'data/scout/2026-09-30.json'
        captured = '{"date":"2026-09-30","settlement":"public-receipt"}\n'
        self.write(self.job, filename, captured)
        self.write(self.job, '.env.production', 'SECRET=excluded\n')
        self.capture('scout')
        original_head = self.git(self.job, 'rev-parse', 'HEAD')
        # Other main changes and a separate dated snapshot arrive after checkout.
        self.write(self.author, 'README.md', 'Main advanced\n')
        self.write(self.author, 'data/scout/2026-09-28.json', '{"date":"2026-09-28"}\n')
        self.commit(self.author, 'main advanced')
        self.git(self.author, 'push', 'origin', 'main')
        count = self.rejection_hook(1)
        self.helper('--publish', str(self.artifact))
        self.assertEqual(count.read_text(), 'xx')
        self.assertEqual(self.remote(filename), captured)
        self.assertEqual(self.remote('README.md'), 'Main advanced\n')
        self.assertEqual(json.loads(self.remote('data/scout/index.json'))['dates'],
                         ['2026-09-28', '2026-09-29', '2026-09-30'])
        self.assertEqual((self.artifact / filename).read_text(), captured)
        self.assertEqual((self.job / filename).read_text(), captured)
        self.assertEqual(self.git(self.job, 'rev-parse', 'HEAD'), original_head)
        self.assertFalse((self.artifact / '.env.production').exists())
        self.assertNotIn('SECRET', (self.artifact / 'capture.json').read_text())

    def test_stats_publishes_on_current_main_and_preserves_capture(self):
        captured = '{"block":2}\n'
        self.write(self.job, 'data/stats.json', captured)
        self.capture('stats')
        self.write(self.author, 'README.md', 'Concurrent source change\n')
        self.commit(self.author, 'new source')
        self.git(self.author, 'push', 'origin', 'main')
        self.helper('--publish', str(self.artifact))
        self.assertEqual(self.remote('data/stats.json'), captured)
        self.assertEqual(self.remote('README.md'), 'Concurrent source change\n')
        self.assertEqual((self.artifact / 'data/stats.json').read_text(), captured)

    def test_conflicting_same_path_is_never_overwritten_for_both_kinds(self):
        for kind, filename in [('scout', 'data/scout/2026-09-30.json'), ('stats', 'data/stats.json')]:
            with self.subTest(kind=kind):
                self.artifact = self.root / ('capture-' + kind)
                self.write(self.job, filename, '{"capture":"ours"}\n')
                self.capture(kind)
                self.write(self.author, filename, '{"capture":"remote"}\n')
                self.commit(self.author, 'conflicting ' + kind)
                self.git(self.author, 'push', 'origin', 'main')
                result = self.helper('--publish', str(self.artifact), check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIn('changed independently', result.stderr)
                self.assertEqual(self.remote(filename), '{"capture":"remote"}\n')
                self.assertEqual((self.artifact / filename).read_text(), '{"capture":"ours"}\n')

    def test_three_failed_pushes_leave_original_capture_for_recovery(self):
        filename = 'data/scout/2026-09-30.json'
        self.write(self.job, filename, '{"date":"2026-09-30"}\n')
        self.capture('scout')
        count = self.rejection_hook(3)
        result = self.helper('--publish', str(self.artifact), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('three attempts', result.stderr)
        self.assertEqual(count.read_text(), 'xxx')
        self.assertTrue((self.artifact / filename).exists())
        self.assertFalse(any((self.root / 'capture').glob('**/node_modules')))
        self.assertEqual(self.git(self.job, 'worktree', 'list').decode().count('\n'), 1)

    def test_identical_remote_capture_succeeds_without_replacement(self):
        filename = 'data/scout/2026-09-30.json'
        captured = '{"date":"2026-09-30"}\n'
        self.write(self.job, filename, captured)
        self.capture('scout')
        self.write(self.author, filename, captured)
        self.commit(self.author, 'same capture already published')
        self.git(self.author, 'push', 'origin', 'main')
        self.helper('--publish', str(self.artifact))
        self.assertEqual(self.remote(filename), captured)
        self.assertEqual(json.loads(self.remote('data/scout/index.json'))['dates'],
                         ['2026-09-29', '2026-09-30'])
        self.assertIn('already published', self.helper('--publish', str(self.artifact)).stdout)

    def test_existing_capture_cannot_be_overwritten_and_invalid_json_is_retained(self):
        filename = 'data/scout/2026-09-30.json'
        self.write(self.job, filename, '{"interrupted":')
        self.capture('scout')
        self.assertEqual((self.artifact / filename).read_text(), '{"interrupted":')
        self.assertEqual(self.helper('--publish', str(self.artifact), check=False).returncode, 1)
        self.write(self.job, filename, '{}\n')
        result = self.helper('--capture', 'scout', '--artifact-dir', str(self.artifact), check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Refusing to overwrite', result.stderr)
        self.assertEqual((self.artifact / filename).read_text(), '{"interrupted":')


if __name__ == '__main__':
    unittest.main()
