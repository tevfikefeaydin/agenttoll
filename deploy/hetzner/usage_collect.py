#!/usr/bin/env python3
"""Bounded, private, best-effort managed-container usage collection. No raw log files."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading

MAX_LOG = 20 * 1024 * 1024
MAX_BUNDLE = 25 * 1024 * 1024
LABEL = 'com.agenttoll.managed=autodeploy'


class OutputLimitExceeded(RuntimeError):
    """Only a bounded Docker log window may be retried with a smaller range."""


def command(args, data=None, limit=MAX_LOG):
    """Bound container stdout and stderr together; discard other command diagnostics."""
    stderr = subprocess.STDOUT if args[:2] == ['docker', 'logs'] else subprocess.DEVNULL
    process = subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=stderr)
    chunks, failure = [], []
    def read():
        size = 0
        try:
            while True:
                chunk = process.stdout.read(65536)
                if not chunk: break
                size += len(chunk)
                if size > limit:
                    failure.append('output limit'); process.kill(); break
                chunks.append(chunk)
        finally: process.stdout.close()
    def write():
        try: process.stdin.write(data)
        except (BrokenPipeError, OSError): pass
        finally: process.stdin.close()
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    writer = None
    if data is not None:
        writer = threading.Thread(target=write, daemon=True); writer.start()
    try: process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(); failure.append('timeout')
    reader.join()
    if writer: writer.join()
    if 'output limit' in failure: raise OutputLimitExceeded('Collection output limit exceeded')
    if process.returncode or failure: raise RuntimeError('Collection command failed or exceeded a bound')
    return b''.join(chunks)


def atomic_write(path, value):
    payload = json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode()
    if len(payload) > MAX_BUNDLE: raise ValueError('Archive bundle limit')
    descriptor, name = tempfile.mkstemp(prefix='.archive-', dir=path.parent)
    try:
        os.chmod(name, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(payload); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        if os.name == 'posix':
            fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        if os.path.exists(name): os.unlink(name)


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value):
        raise ValueError('Invalid collection timestamp')
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def timestamp(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def collect(directory, app, run=command, now=None, initial_hours=720, window_minutes=60):
    if not isinstance(initial_hours, int) or not 1 <= initial_hours <= 720:
        raise ValueError('Initial collection window must be 1 to 720 hours')
    if not isinstance(window_minutes, int) or not 1 <= window_minutes <= 60:
        raise ValueError('Collection window must be 1 to 60 minutes')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink(): raise ValueError('Archive directory cannot be a symlink')
    os.chmod(directory, 0o700)
    target = directory / 'archive.json'
    now = now or timestamp(datetime.now(timezone.utc))
    current = instant(now)
    previous = None
    if target.is_symlink(): raise ValueError('Archive cannot be a symlink')
    if target.exists():
        if not target.is_file() or target.stat().st_size > MAX_BUNDLE: raise ValueError('Invalid archive file')
        previous = json.loads(target.read_text(encoding='utf-8'))
        if not isinstance(previous, dict) or set(previous) != {'version', 'containers', 'bundle'} or previous['version'] not in (1, 2):
            raise ValueError('Invalid archive envelope')
        if not isinstance(previous['containers'], list) or len(previous['containers']) > 256 or any(not isinstance(c, str) or not re.fullmatch('[0-9a-f]{64}', c) for c in previous['containers']):
            raise ValueError('Invalid source history')
        if not isinstance(previous['bundle'], dict) or set(previous['bundle']) != {'state', 'report'}: raise ValueError('Invalid archive bundle')
        last = instant(previous['bundle']['state']['collectedAt'])
        if last > current: raise ValueError('Collection clock moved backwards')
        coverage = previous['bundle']['report'].get('coverage', {})
        cursor = instant(coverage.get('sourceWindowUntil', previous['bundle']['state']['collectedAt']))
        if cursor > last: raise ValueError('Source cursor is ahead of collection time')
        cursor = max(current - timedelta(days=30), cursor)
        since = max(current - timedelta(days=30), cursor - timedelta(minutes=10))
    else:
        cursor = current - timedelta(hours=initial_hours)
        since = cursor
    until = min(current, cursor + timedelta(minutes=window_minutes))
    sources = run(['docker', 'ps', '--all', '--no-trunc', '--filter', 'label=' + LABEL, '--format', '{{.ID}}'], limit=32768).decode().split()
    if not sources or len(sources) > 256 or len(set(sources)) != len(sources) or any(not re.fullmatch('[0-9a-f]{64}', c) for c in sources):
        raise ValueError('No managed sources or invalid source list')
    for source in sources:
        metadata = json.loads(run(['docker', 'inspect', source], limit=1024 * 1024))
        if len(metadata) != 1 or metadata[0]['Config'].get('Labels', {}).get('com.agenttoll.managed') != 'autodeploy':
            raise ValueError('Source is not managed by AgentToll')
    while True:
        logs, total = [], 0
        try:
            for source in sources:
                output = run(['docker', 'logs', '--since', timestamp(since), '--until', timestamp(until), source], limit=MAX_LOG)
                total += len(output) + 1
                if total > MAX_LOG: raise OutputLimitExceeded('Combined log limit exceeded')
                logs.append(output.decode('utf-8', errors='strict'))
            break
        except OutputLimitExceeded:
            remaining = (until - cursor).total_seconds()
            overlap = (cursor - since).total_seconds()
            # Shrink the larger part of the range. Only already-collected time
            # may be removed from the start; never skip past the saved cursor.
            if overlap > 0 and (overlap >= remaining or remaining <= 1):
                since = cursor - timedelta(seconds=overlap / 2 if overlap > 1 else 0)
            elif remaining > 1:
                until = cursor + timedelta(seconds=max(1, remaining / 2))
            else:
                raise OutputLimitExceeded('Minimum uncollected log window exceeds the input limit')
    request = {'input': '\n'.join(logs), 'now': now, 'containers': sources,
               'sourceWindowSince': timestamp(since), 'sourceWindowUntil': timestamp(until),
               'collectionBacklogSeconds': max(0, int((current - until).total_seconds()))}
    result = json.loads(run(['node', '--import', 'tsx', str(app / 'scripts' / 'usage-archive-store.mjs'),
                             '--directory', str(directory)],
                            data=json.dumps(request, ensure_ascii=False, separators=(',', ':')).encode(), limit=MAX_BUNDLE))
    if (not isinstance(result, dict) or set(result) != {'version', 'containers', 'bundle'} or result['version'] != 2
            or result['containers'] != sources or result['bundle']['state'].get('collectedAt') != now
            or result['bundle']['report']['coverage'].get('sourceWindowUntil') != timestamp(until)):
        raise ValueError('Invalid archive adapter result')
    if not target.is_file() or target.is_symlink() or target.stat().st_size > MAX_BUNDLE:
        raise ValueError('Archive manifest was not committed')
    if json.loads(target.read_text(encoding='utf-8')) != result:
        raise ValueError('Archive manifest differs from committed result')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/var/lib/agenttoll-usage'))
    parser.add_argument('--app', type=Path, default=Path('/opt/agenttoll/usage/app'))
    parser.add_argument('--initial-hours', type=int, default=720,
                        help='First-run log window (1-720 hours); subsequent runs resume the saved cursor')
    parser.add_argument('--max-windows', type=int, default=12,
                        help='At most 1-12 bounded catch-up windows per invocation')
    args = parser.parse_args()
    if not 1 <= args.max_windows <= 12: raise ValueError('Invalid catch-up window count')
    # Linux host flock releases on every exit, including process crashes.
    import fcntl
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.directory.is_symlink(): raise ValueError('Archive directory cannot be a symlink')
    lock_path = args.directory / '.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for _ in range(args.max_windows):
            result = collect(args.directory, args.app, initial_hours=args.initial_hours)
            if not result['bundle']['report']['coverage']['collectionBacklogSeconds']: break
    print('Private usage archive updated; coverage remains best effort.')

if __name__ == '__main__':
    try: main()
    except Exception:
        # Avoid including untrusted logs, command output, file contents or secrets in journal.
        print('Usage collection failed; inspect service configuration and last-good archive timestamp. No successful collection claimed.', file=__import__('sys').stderr)
        raise SystemExit(1)
