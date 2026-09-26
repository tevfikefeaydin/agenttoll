# Research growth — production release

Released 2026-09-26 at 20:19 UTC (23:19 Europe/Istanbul).

- Application revision: `25c8273551addbb0efb2c05bf8ad2d8946aca327`.
- Host collector follow-up: `40215349e24712ce7fc2dcc1416358be03f122d4`.
- Both revisions passed GitHub verification:
  [application CI](https://github.com/tevfikefeaydin/agenttoll/actions/runs/36268905265),
  [collector CI](https://github.com/tevfikefeaydin/agenttoll/actions/runs/36269183356).
- Release directory: `/opt/agenttoll/releases/20260926T201909Z-25c8273551ad`.
- Image: `sha256:d6d4cea3d826e8405a68a4923ae3e6d4a8a8a944ebf0e25ef556bba67168fa23`.
- Previous validated revision `41281bc6ed68c172fda371b996737c48fa55a949`
  remains available through the normal controller rollback procedure.
- Controller current state has no pending, failed or cleanup transaction.

## Checks after publication

All 24 live unsigned API checks passed at 20:21 UTC. HTTPS proxy/static checks
passed. Public homepage, research HTML/JS and privacy notice hashes match the
release files exactly. The live browser loaded the discovery tab, displayed a
0.003 USDC quote on Base mainnet and cancelled it without a wallet or payment.
No production payment or settlement was authorized.

## Active usage collection

The host had no Node installation. A private Node v24.21.0/npm 11.19.0 runtime
was copied from the already-pinned running AgentToll image into
`/opt/agenttoll/usage/node`, with no change to global host runtime configuration.
The collector and its locked dependencies live separately from rotating releases.

The initial historical import exceeded the bounded log reader and stopped
without enabling the timer. Added and tested explicit `--initial-hours` bootstrap
configuration. The installed service imports six hours on its first run, then
resumes its saved cursor; it does not claim a complete historical backfill.
All 37 deployment tests passed after this change, including the real Node
adapter integration and first-run/resume-window regression.

`agenttoll-usage.timer` is enabled and active, collecting every five minutes.
Collection began at 20:20:39 UTC. An independently triggered follow-up succeeded
at 20:21:56 UTC with the same archive start, 3,912 retained records, four observed
managed containers and no delayed collection. The first retained observation is
14:20:42 UTC. Archive permissions are 0600. Public payer and receipt records
remain private; no raw archive was copied into this repository.

Coverage remains best effort. Monitor the collection timestamp and configured
50,000-record/20 MB limits; failures preserve the previous bundle rather than
silently dropping records. Records expire on successful polls after 30 days
from collection. Disable the timer before collector rollback or maintenance.

Local deployment evidence is in `output/release-20260926/` (API/proxy results and
aggregate live verification). User interviews remain an unexecuted pilot plan.
