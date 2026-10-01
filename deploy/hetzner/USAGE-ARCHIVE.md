# Private usage archive

Installing application code does not activate or update this separate runtime. Requires Linux, systemd,
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
six hours in bounded windows. Older logs are not imported
by that bootstrap. The standalone CLI defaults to 720 hours; use
`--initial-hours 1..720` to choose an explicit first-run window. This option
does not reset an existing archive cursor or change record retention. Later runs
resume `coverage.sourceWindowUntil` and overlap it by ten minutes. Each window
advances at most one hour. Oversized windows halve the larger of the forward
window or the already-collected overlap. The start never moves past the saved
cursor, so uncollected time is not skipped; `sourceWindowSince` records the
actual replay range. A one-second uncollected window that still exceeds the
input bound fails without advancing the archive. Each service run processes at most
12 windows (`--max-windows 1..12`), then the next run resumes the cursor.
`collectedAt` records the actual collection time, not the end of a backlog window.
Docker stdout and stderr are
both collected, so 5xx terminal records are included. Failed commands, bounds,
invalid state and write failures do not advance the last-good bundle.

## Interpret and monitor

The version 2 private envelope contains `containers`, `bundle.state` and
`bundle.report`. The state references immutable, SHA-256 checked JSON files in
`segments/`. Keep the manifest and its referenced segments together when backing
up, copying or restoring. Version 1 archives migrate on the next successful run;
request digests, conflict flags, first-seen dates and receipt evidence survive.
Only `bundle.report` is intended for sharing after review. State contains public
payer/receipt evidence; never commit it or publish it as a web asset. Arbitrary
log fields and payment signatures are excluded; request IDs are hashed.

- Retention: records expire 30 days after first collection on a successful run.
  A stopped collector retains its last bundle; monitor its timestamp and remove
  archives deliberately when decommissioning. Backups need their own retention.
- Bounds: 500,000 retained records, 384 MiB total serialized segments, at most
  128 segments, each at most 5,000 records or 5 MiB. Input remains limited to
  20 MiB per window and 64 KiB per log line; the manifest is limited to 25 MiB.
  A bound fails the run rather than silently dropping evidence. At 80% of any
  storage bound, `coverage.capacityWarning` becomes true. Inspect `utilization`
  and `limits` before increasing traffic; do not label missing periods zero use.
- `coverage.complete` is always false. Inspect `delayedCollection`,
  `previousContainersNowMissing`, `sourceWindowSince`, `sourceWindowUntil`,
  `collectionBacklogSeconds` and ignored-line counts. `lastDelayedCollectionAt`
  and `lastMissingContainersAt` preserve known gaps after collection catches up.
  Rotation or container deletion between polls can lose observations.
  `retainedSince` is the first dated request included in the report (null when
  absent); `collectionStartedAt` is when archiving began, not the start of
  imported historical observations. Successful unsigned health probes are
  omitted; conflict detection covers retained records, not discarded probes.
- The report covers all retained segments. Replay is deduplicated globally by
  request and validated receipt; segment totals must not be added together. Conflicting request
  evidence stays excluded for its retained lifetime. Wallet counts are not
  people, and non-operator wallets can include tests. Costs are not collected.
- The state directory is private (0700), files are 0600, and writes use
  temporary files plus atomic replacement. Segments are synced before the
  manifest is replaced. Unreferenced owned segments are pruned only after that
  commit; a crash before it leaves the last committed manifest usable.
  Only one host collector may run, including during maintenance.

### Monitor collection health

For hosts running both the monitor and collector, add a systemd drop-in:

```ini
# /etc/systemd/system/agenttoll-monitor.service.d/usage.conf
[Service]
ExecStart=
ExecStart=/usr/bin/python3 /opt/agenttoll/monitor/monitor.py --usage-archive /var/lib/agenttoll-usage/archive.json
```

Install the matching `monitor.py`, reload systemd and run the monitor once.
Its `usage` component fails when the archive is missing, invalid, older than
15 minutes, has a source cursor more than 15 minutes behind the current time, or exceeds the capacity
warning threshold. No identities or request records enter the health output.
Check both services after upgrades; healthy API responses alone do not establish
that usage collection is working. The generic monitor remains usable on hosts
without this optional collector.

## Disable and rollback

```sh
sudo systemctl disable --now agenttoll-usage.timer
sudo systemctl stop agenttoll-usage.service
```

This does not alter the API or delete evidence. Keep the private bundle if
required, or remove it explicitly under the operator's retention policy.
For collector upgrades, stop the timer, preserve a private backup, update the
separate runtime, run once and verify the timestamp and source backlog before
restarting the timer. Rehearse migration on a private copy first. To roll back
across state versions, restore the matching runtime and complete archive backup
together; keep new evidence separately for reconciliation.
An older runtime may reject newer state versions; never overwrite a valid
archive with an empty state to hide a failure.
