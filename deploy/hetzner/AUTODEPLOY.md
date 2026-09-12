# Automatic GitHub → Hetzner deployment

Push code to `tevfikefeaydin/agenttoll`'s `main` branch. The existing
[verification workflow](https://github.com/tevfikefeaydin/agenttoll/actions/workflows/consistency.yml)
must succeed. Hetzner checks every five minutes, then builds and verifies the
new version before routing traffic to it. No deploy key or GitHub token is used.

The controller accepts only this repository's main push/manual CI runs. It
matches release inputs against current main again immediately before promotion.
An old successful attempt cannot override a newer failed/pending attempt.
Data snapshots and documentation alone do not restart the service. These daily
GitHub jobs continue using the same domain and existing payment settings.

## On the server

- Controller: `/opt/agenttoll/deployer/autodeploy.py` (operator-owned).
- Configuration: `/opt/agenttoll/deployer/config.json`.
- Current/previous release and interrupted transaction: `deployer/state/*.json`.
- Runtime secrets: `/opt/agenttoll/shared/runtime.env`, root-only mode 0600.
- Current files: `/opt/agenttoll/current` → an immutable revision's release directory.
- Build: dedicated `agenttoll-builder`, limited to 1.5 GiB RAM and 1.5 CPUs.
- Timer: `agenttoll-deploy.timer`; release logs: `agenttoll-deploy.service`.
- Boot recovery: `agenttoll-deploy-recovery.service`, before Docker starts.

The current application container name is recorded in `state/current.json`.
Automatic releases use unique names and do not use the bootstrap Compose project.
The runtime file uses Docker CLI `KEY=value` syntax without surrounding quotes;
Compose's quoted dotenv values must be normalized before copying to this file.
At bootstrap its values were compared directly with the running production
container without printing credentials.

```sh
systemctl status agenttoll-deploy.timer
journalctl -u agenttoll-deploy.service -n 80 --no-pager
python3 /opt/agenttoll/deployer/autodeploy.py --status
docker logs --since 10m "$(python3 -c 'import json; print(json.load(open("/opt/agenttoll/deployer/state/current.json"))["container"])')"
```

Each successful release has `release.json`, `build.log`, `candidate-api.json`,
`public-api.json`, and `public-proxy.json`. Probe containers have no runtime
environment or wallet. The candidate probe connects to the candidate's private
loopback address and explicitly preserves canonical Host/protocol, checking all
24 API/unsigned quote assertions. Public HTTPS then runs those checks and the
25 proxy/static checks. None authorizes a real payment.

## Routing and failure handling

The shared Caddyfile imports `/data/agenttoll/upstream.caddy` only inside the
AgentToll block. The host file is
`/var/lib/docker/volumes/altyapi_caddy_data/_data/agenttoll/upstream.caddy`.
Each release validates a complete candidate with the running Caddy binary,
checks for concurrent edits, and atomically replaces only this small snippet.
The shared file and other hosts are not rewritten for releases. Caddy reloads
without restarting, and the active configuration must name the new container.

The old container keeps running through all public checks. If they fail, the
controller restores the old upstream, then drains the failed candidate. Both
old and failed processes receive up to 135 seconds to finish accepted requests.
A durable pending journal supports interrupted-operation recovery, including
file recovery before Docker on boot. A shared lock serializes deployment,
rollback and the one-time post-migration check. A separate durable cleanup record
retries old-container draining after a successful commit without marking the
validated new release as failed.

Boot recovery rebuilds the snippet from an operator-owned template even if the
snippet is missing or malformed. It quarantines corrupt pending JSON and falls
back to the last atomic current-release record. If both records are unusable,
AgentToll returns 503 and the recovery service reports a failure for investigation.
Other sites' Docker startup deliberately remains independent of AgentToll state.

The previous container/image and original migration release remain available.
An unsuccessful deployment attempt is held until new CI, an explicit retry,
or a new code revision. A failed check cannot repeatedly replace production.

```sh
# Retry after inspecting and addressing the failure (no new source needed).
python3 /opt/agenttoll/deployer/autodeploy.py --retry

# Restore the previous validated container and hold the failed CI attempt.
python3 /opt/agenttoll/deployer/autodeploy.py --rollback

# Pause/resume future automatic releases. The running application keeps serving.
systemctl disable --now agenttoll-deploy.timer
systemctl enable --now agenttoll-deploy.timer

# Request a normal check immediately.
systemctl start agenttoll-deploy.service
```

Do not run `docker compose up` from an automatic release. Its environment and
container are managed by the controller; Compose documents the original bootstrap.
If `pending.json` remains, fix the logged proxy/process issue and rerun the
service so it completes recovery before attempting anything new.

GitHub/API outages, malformed results and less than 5 GiB free disk pause new
builds while the current application remains running. Inspect disk usage and
remove only specifically identified old AgentToll artifacts when needed. The
controller keeps three recent owned releases plus current/previous/pending
cleanup releases, removes only matching stopped containers/images with its own
label, and leaves the original migration release intact. The dedicated BuildKit
cache has a 3 GB target; no shared Docker prune runs. No notifications are sent.

## Controller and CI policy changes

Regular application changes publish automatically. The controller itself is
deliberately installed separately; do not execute the fetched repository's host
scripts as root. To update it, review and run the offline/Linux rehearsal tests,
pause the timer, acquire the deployment lock, install the reviewed files, and
resume the timer. `config.json` pins the Git blob IDs of `consistency.yml` and
`.dockerignore`: policy changes need operator review before updating these pins.
When changing build-context inputs, update `RELEASE_INPUTS` too. This prevents a
changed CI workflow from silently weakening the production gate.

```sh
python3 -m unittest discover -s deploy/hetzner -p 'test_*.py'
# On Linux with Docker, using an already-built AgentToll image:
python3 deploy/hetzner/rehearse.py IMAGE /tmp/agenttoll-rehearsal.json
```

Vercel remains a migration fallback. Its Git integration may create backup
deployments, but the canonical domain continues pointing to Hetzner. An MCP
package version bump or npm publication is not part of this release pipeline.
