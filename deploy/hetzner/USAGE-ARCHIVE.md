# Private usage archive

Status: installable, not activated by this change. Requires Linux, systemd,
Docker, Python 3 and Node 22+ with npm. No new service or paid dependency.
The service also searches `/opt/agenttoll/usage/node/bin` for a private Node
installation. On a Docker-only host, provision Node there before starting it;
the runtime may be copied from the existing pinned AgentToll image. Keep its
`bin/node`, `lib/node_modules/npm` and `bin/npm` link together and verify both
version commands. This leaves the host's global Node configuration unchanged.

## Install on the host

Use a reviewed checkout containing the archive files. Keep this runtime separate
from the application release directories so container replacement cannot remove it.
The collector reads only containers labelled `com.agenttoll.managed=autodeploy`.

```sh
sudo install -d -m 700 /opt/agenttoll/usage /opt/agenttoll/usage/app
sudo cp deploy/hetzner/usage_collect.py /opt/agenttoll/usage/
sudo cp package.json package-lock.json /opt/agenttoll/usage/app/
sudo cp -R src scripts /opt/agenttoll/usage/app/
sudo npm ci --prefix /opt/agenttoll/usage/app --include=dev --ignore-scripts
sudo install -m 644 deploy/hetzner/agenttoll-usage.service /etc/systemd/system/
sudo install -m 644 deploy/hetzner/agenttoll-usage.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start agenttoll-usage.service
sudo systemctl status agenttoll-usage.service --no-pager
```

Inspect `/var/lib/agenttoll-usage/archive.json` privately. Confirm
`bundle.state.collectedAt` is recent, then enable scheduling:

```sh
sudo systemctl enable --now agenttoll-usage.timer
sudo systemctl list-timers agenttoll-usage.timer
```

The installed service's first collection requests retained logs from the last
six hours to stay within bounded input on busy hosts. Older logs are not imported
by that bootstrap. The standalone CLI defaults to 720 hours; use
`--initial-hours 1..720` to choose an explicit first-run window. This option
does not reset an existing archive cursor or change record retention. Later runs
overlap the previous collection by ten minutes. Docker stdout and stderr are
both collected, so 5xx terminal records are included. Failed commands, bounds,
invalid state and write failures do not advance the last-good bundle.

## Interpret and monitor

The private envelope contains `containers`, `bundle.state` and `bundle.report`.
Only `bundle.report` is intended for sharing after review. State contains public
payer/receipt evidence; never commit it or publish it as a web asset. Arbitrary
log fields and payment signatures are excluded; request IDs are hashed.

- Retention: records expire 30 days after first collection on a successful run.
  A stopped collector retains its last bundle; monitor its timestamp and remove
  archives deliberately when decommissioning. Backups need their own retention.
- Bounds: 50,000 records, 20 MB state/log input, 64 KB per log line and 25 MB
  output bundle. A bound fails the run rather than silently dropping evidence.
  Investigate capacity if the archive stops updating; do not label gaps zero use.
- `coverage.complete` is always false. Inspect `delayedCollection`,
  `previousContainersNowMissing`, `sourceWindowSince` and ignored-line counts.
  Rotation or container deletion between polls can lose observations.
  `retainedSince` is the first dated request included in the report (null when
  absent); `collectionStartedAt` is when archiving began, not the start of
  imported historical observations. Successful unsigned health probes are
  omitted; conflict detection covers retained records, not discarded probes.
- Replay is deduplicated by request and validated receipt. Conflicting request
  evidence stays excluded for its retained lifetime. Wallet counts are not
  people, and non-operator wallets can include tests. Costs are not collected.
- The state directory is private (0700), bundle files are 0600, and writes use
  a temporary file plus atomic replacement. Only one host collector may run.

## Disable and rollback

```sh
sudo systemctl disable --now agenttoll-usage.timer
sudo systemctl stop agenttoll-usage.service
```

This does not alter the API or delete evidence. Keep the private bundle if
required, or remove it explicitly under the operator's retention policy.
For collector upgrades, stop the timer, preserve a private backup, update the
separate runtime, run once and verify the timestamp before restarting the timer.
An older runtime may reject newer state versions; never overwrite a valid
archive with an empty state to hide a failure.
