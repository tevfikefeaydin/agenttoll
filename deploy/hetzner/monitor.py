#!/usr/bin/env python3
"""Hourly read-only API/data checks, outside the application request process."""
import argparse
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

STATE = Path('/opt/agenttoll/deployer/state/current.json')
LATEST = Path('/opt/agenttoll/monitor/latest.json')
PREFIX = 'AGENTTOLL_MONITOR '
NODE_CHECK = r'''
import { checkService } from './dist/operations-check.js';
import { checkDataQuality } from './dist/operations-data.js';
const [api, data] = await Promise.all([
  checkService({ baseUrl: process.env.PUBLIC_URL, network: process.env.NETWORK, recipient: process.env.ADDRESS }),
  checkDataQuality(),
]);
console.log('AGENTTOLL_MONITOR ' + JSON.stringify({ ok: api.ok && data.ok, degraded: data.degraded, api, data }));
'''


def usage_status(path, now=None):
    """Expose only collection health; never copy usage records or identities."""
    current = now or datetime.now(timezone.utc)
    target = Path(path)
    try:
        if target.is_symlink(): raise ValueError('Invalid archive')
        if not target.exists(): return {'ok': False, 'status': 'missing'}
        if not target.is_file() or target.stat().st_size > 25 * 1024 * 1024:
            raise ValueError('Invalid archive')
        value = json.loads(target.read_text(encoding='utf-8'))
        if value['version'] not in (1, 2): raise ValueError('Invalid archive version')
        state, coverage = value['bundle']['state'], value['bundle']['report']['coverage']
        def instant(stamp):
            if not isinstance(stamp, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', stamp):
                raise ValueError('Invalid archive timestamp')
            return datetime.fromisoformat(stamp.replace('Z', '+00:00'))
        collected = instant(state['collectedAt'])
        age = (current - collected).total_seconds()
        cursor = instant(coverage.get('sourceWindowUntil', state['collectedAt']))
        backlog = coverage.get('collectionBacklogSeconds', 0)
        if (age < 0 or cursor > collected or isinstance(backlog, bool) or
                not isinstance(backlog, (float, int)) or not math.isfinite(backlog) or backlog < 0):
            raise ValueError('Invalid collection health')
        backlog = max(backlog, (collected - cursor).total_seconds())
        source_lag = age + backlog
        capacity = coverage.get('capacityWarning', False)
        if not isinstance(capacity, bool): raise ValueError('Invalid capacity health')
        status = 'stale' if age > 900 else 'catching_up' if source_lag > 900 else 'capacity_warning' if capacity else 'current'
        return {'ok': status == 'current', 'status': status,
                'collectedAt': state['collectedAt'], 'ageSeconds': int(age),
                'collectionBacklogSeconds': int(backlog), 'sourceLagSeconds': int(source_lag), 'capacityWarning': capacity}
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return {'ok': False, 'status': 'invalid'}


def collect(state_path=STATE, usage_path=None, now=None):
    state = json.loads(Path(state_path).read_text(encoding='utf-8'))
    container = state.get('container', '')
    revision = state.get('sha', '')
    if not isinstance(container, str) or not re.fullmatch(r'agenttoll-r-\d{8}t\d{6}z-[a-f0-9]{12}', container):
        raise ValueError('Invalid active AgentToll container')
    if not isinstance(revision, str) or not re.fullmatch(r'[a-f0-9]{40}', revision):
        raise ValueError('Invalid active revision')
    process = subprocess.run(['docker', 'exec', '-w', '/app', container, 'node', '--input-type=module', '-e', NODE_CHECK],
                             capture_output=True, text=True, timeout=85, check=False)
    if process.returncode or len(process.stdout) > 100_000:
        raise ValueError('Monitor subprocess unavailable')
    lines = [line[len(PREFIX):] for line in process.stdout.splitlines() if line.startswith(PREFIX)]
    if len(lines) != 1:
        raise ValueError('Missing monitor result')
    result = json.loads(lines[0])
    if not isinstance(result, dict) or not isinstance(result.get('ok'), bool) or not isinstance(result.get('degraded'), bool):
        raise ValueError('Invalid monitor result')
    for key in ('api', 'data'):
        if not isinstance(result.get(key), dict) or not isinstance(result[key].get('ok'), bool):
            raise ValueError('Invalid component result')
    if result['ok'] != (result['api']['ok'] and result['data']['ok']):
        raise ValueError('Inconsistent monitor result')
    if usage_path is not None:
        result['usage'] = usage_status(usage_path, now)
        result['ok'] = result['ok'] and result['usage']['ok']
        result['degraded'] = result['degraded'] or not result['usage']['ok']
    return dict(result, schemaVersion=1, checkedAt=(now or datetime.now(timezone.utc)).isoformat(), sourceRevision=revision, container=container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--usage-archive', type=Path, help='Also require a current private usage archive')
    args = parser.parse_args()
    try:
        report = collect(usage_path=args.usage_archive)
    except Exception:
        # Never copy subprocess stderr, provider exception text or credentials.
        report = {'schemaVersion': 1, 'ok': False, 'degraded': True,
                  'checkedAt': datetime.now(timezone.utc).isoformat(), 'error': 'MONITOR_UNAVAILABLE'}
    LATEST.parent.mkdir(parents=True, exist_ok=True)
    temporary = LATEST.with_suffix('.tmp')
    temporary.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600)
    os.replace(temporary, LATEST)
    print(json.dumps(report))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
