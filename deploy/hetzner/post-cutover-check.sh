#!/usr/bin/env bash
# One-time, read-only migration observation. No environment or wallet is mounted.
set -uo pipefail

# Share the deployment lock and resolve the active release at execution time.
exec 9>/opt/agenttoll/deployer/deploy.lock
flock -w 1200 9 || exit 1
release_dir=$(readlink -f /opt/agenttoll/current)
case "$release_dir" in /opt/agenttoll/releases/*) ;; *) exit 1 ;; esac
image=$(python3 -c 'import json; r=json.load(open("/opt/agenttoll/deployer/state/current.json")); print(r.get("image_id", r["image"]))')
report_dir="/opt/agenttoll/checks/$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$report_dir"
result=0

docker run --rm -i --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 \
  --entrypoint node "$image" --input-type=module > "$report_dir/api-tls.json" <<'JS' || result=1
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { checkService } from './dist/operations-check.js';
const report = await checkService({ baseUrl: 'https://agenttoll.app', network: 'base',
  recipient: '0xe55359021a6a22d8385b827405991c56075f56f8' });
report.tls = [];
for (const hostname of ['agenttoll.app', 'www.agenttoll.app']) {
  const dns = await lookup(hostname);
  const peer = await new Promise((resolve, reject) => {
    https.get(`https://${hostname}/api/health`, { signal: AbortSignal.timeout(15000) }, response => {
      const cert = response.socket.getPeerCertificate();
      resolve({ hostname, resolvedAddress: dns.address, remoteAddress: response.socket.remoteAddress,
        authorized: response.socket.authorized, status: response.statusCode,
        fingerprint256: cert.fingerprint256, validTo: cert.valid_to });
      response.resume();
    }).on('error', reject);
  });
  peer.ok = peer.authorized && peer.resolvedAddress === '167.233.31.87' &&
    peer.remoteAddress === '167.233.31.87' && peer.status === (hostname === 'agenttoll.app' ? 200 : 301);
  report.tls.push(peer);
}
report.ok = report.ok && report.tls.every(peer => peer.ok);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
JS

docker run --rm --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 \
  --mount "type=bind,src=$release_dir/deploy/hetzner/verify-proxy.mjs,dst=/app/deploy/hetzner/verify-proxy.mjs,readonly" \
  --mount "type=bind,src=$release_dir/vercel.json,dst=/app/vercel.json,readonly" \
  --entrypoint node "$image" /app/deploy/hetzner/verify-proxy.mjs \
  > "$report_dir/proxy.json" || result=1

printf 'AgentToll read-only migration check: exit=%s reports=%s\n' "$result" "$report_dir"
exit "$result"
