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


def collect(directory, app, run=command, now=None):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink(): raise ValueError('Archive directory cannot be a symlink')
    os.chmod(directory, 0o700)
    target = directory / 'archive.json'
    now = now or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    current = instant(now)
    previous = None
    if target.is_symlink(): raise ValueError('Archive cannot be a symlink')
    if target.exists():
        if not target.is_file() or target.stat().st_size > MAX_BUNDLE: raise ValueError('Invalid archive file')
        previous = json.loads(target.read_text(encoding='utf-8'))
        if not isinstance(previous, dict) or set(previous) != {'version', 'containers', 'bundle'} or previous['version'] != 1:
            raise ValueError('Invalid archive envelope')
        if not isinstance(previous['containers'], list) or len(previous['containers']) > 256 or any(not isinstance(c, str) or not re.fullmatch('[0-9a-f]{64}', c) for c in previous['containers']):
            raise ValueError('Invalid source history')
        if not isinstance(previous['bundle'], dict) or set(previous['bundle']) != {'state', 'report'}: raise ValueError('Invalid archive bundle')
        last = instant(previous['bundle']['state']['collectedAt'])
        if last > current: raise ValueError('Collection clock moved backwards')
        since = max(current - timedelta(days=30), last - timedelta(minutes=10))
    else: since = current - timedelta(days=30)
    sources = run(['docker', 'ps', '--all', '--no-trunc', '--filter', 'label=' + LABEL, '--format', '{{.ID}}'], limit=32768).decode().split()
    if not sources or len(sources) > 256 or len(set(sources)) != len(sources) or any(not re.fullmatch('[0-9a-f]{64}', c) for c in sources):
        raise ValueError('No managed sources or invalid source list')
    logs, total = [], 0
    for source in sources:
        metadata = json.loads(run(['docker', 'inspect', source], limit=1024 * 1024))
        if len(metadata) != 1 or metadata[0]['Config'].get('Labels', {}).get('com.agenttoll.managed') != 'autodeploy':
            raise ValueError('Source is not managed by AgentToll')
        output = run(['docker', 'logs', '--since', since.isoformat(), '--until', now, source], limit=MAX_LOG)
        total += len(output) + 1
        if total > MAX_LOG: raise ValueError('Combined log limit exceeded')
        logs.append(output.decode('utf-8', errors='strict'))
    request = {'state': previous['bundle']['state'] if previous else None, 'input': '\n'.join(logs), 'now': now}
    bundle = json.loads(run(['node', '--import', 'tsx', str(app / 'scripts' / 'usage-archive.mjs')],
                            data=json.dumps(request).encode(), limit=MAX_BUNDLE))
    if not isinstance(bundle, dict) or set(bundle) != {'state', 'report'} or bundle['state'].get('collectedAt') != now:
        raise ValueError('Invalid archive adapter result')
    bundle['report']['coverage']['managedContainersObserved'] = len(sources)
    bundle['report']['coverage']['previousContainersNowMissing'] = len(set(previous['containers']) - set(sources)) if previous else 0
    bundle['report']['coverage']['sourceWindowSince'] = since.isoformat()
    result = {'version': 1, 'containers': sources, 'bundle': bundle}
    atomic_write(target, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=Path('/var/lib/agenttoll-usage'))
    parser.add_argument('--app', type=Path, default=Path('/opt/agenttoll/usage/app'))
    args = parser.parse_args()
    # Linux host flock releases on every exit, including process crashes.
    import fcntl
    args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if args.directory.is_symlink(): raise ValueError('Archive directory cannot be a symlink')
    lock_path = args.directory / '.lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        collect(args.directory, args.app)
    print('Private usage archive updated; coverage remains best effort.')

if __name__ == '__main__':
    try: main()
    except Exception:
        # Avoid including untrusted logs, command output, file contents or secrets in journal.
        print('Usage collection failed; inspect service configuration and last-good archive timestamp. No successful collection claimed.', file=__import__('sys').stderr)
        raise SystemExit(1)
