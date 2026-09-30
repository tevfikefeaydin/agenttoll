#!/usr/bin/env python3
"""Hourly read-only API/data checks, outside the application request process."""
import json
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


def collect(state_path=STATE):
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
    return dict(result, schemaVersion=1, checkedAt=datetime.now(timezone.utc).isoformat(), sourceRevision=revision, container=container)


def main():
    try:
        report = collect()
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
