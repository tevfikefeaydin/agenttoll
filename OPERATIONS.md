# AgentToll operations

The service, scheduled data jobs and standalone MCP package have separate checks. A healthy process or a valid 402 quote does not establish that a paid data request will settle successfully.

The canonical service moved to Hetzner (`167.233.31.87`) on 2026-09-12 at
approximately 21:24 UTC. Runtime, proxy, certificates, release identity and
rollback instructions are in the [Hetzner runbook](deploy/hetzner/README.md).
Application logs come from the container recorded in
`/opt/agenttoll/deployer/state/current.json`. Main code passing CI is published
by the [automatic deployment controller](deploy/hetzner/AUTODEPLOY.md).
Vercel remains available as the migration rollback origin.

## Checks that do not pay

```bash
npm run ops:check
npm run ops:data
npm run ops:data -- --strict
npm run ops:report -- --input requests.ndjson

npm run build
node scripts/keep-warm.mjs --dry-run
node scripts/keep-warm.mjs --quote-only --path=/api/base/scout
node scripts/snapshot.mjs --dry-run
node scripts/snapshot.mjs --quote-only
```

`ops:check` checks liveness, readiness, the catalog and all 21 registered payment quotes. It creates a client with no signer and a zero budget; it never reads a private key, follows a redirect, or sends a signed request. Default limits are five seconds per check and sixty seconds overall. Exit 1 means one or more checks failed. Each invocation creates real unsigned traffic; account for monitoring calls when interpreting usage. The hourly unsigned monitor is described below.

Set `AGENTTOLL_URL`, `AGENTTOLL_NETWORK` and an explicitly trusted `AGENTTOLL_RECIPIENT` to check a self-hosted instance. The hosted default is `https://agenttoll.app` on Base. Setting a testnet network cannot change the hosted payment network. No `.env` file is loaded by the operations commands.

`ops:report` reads at most 20 MiB of newline-delimited application JSON (direct request records, or JSON objects with a `message` containing the record). It makes no network calls. It outputs status counts, server errors, nearest-rank p50/p95 latency, instrumented data-provider/cache totals, payment outcomes, canonical endpoint groups, payment phases/reasons and facilitator timing. An empty/unusable export exits 1. Duplicate request IDs and invalid lines are reported separately. It describes only the supplied records; it cannot restore events lost to retention or sampling.

`ops:data` calls read-only public data services directly: the latest immutable scout snapshot, seven-snapshot scorecard and a USDC safety benchmark. It has one 25-second deadline and never loads a wallet key or payment client. Snapshot age is measured from its actual `at` timestamp; more than 30 hours is stale. `captureDelaySeconds` compares the capture to the existing 07:23 UTC daily scout schedule. A successful GitHub job alone does not establish fresh data. Invalid/future timestamps and summary/row inconsistencies fail validation.

The data report keeps `ok` (availability/freshness) separate from `degraded` (partial coverage). It records priced, low-observed-liquidity and unavailable token counts plus completed safety checks. A low-liquidity observation does not establish that every pool disappeared; unknown checks stay unknown. Default exit 1 means unavailable/stale; `--strict` additionally exits 2 for partial coverage. This benchmark does not inspect every endpoint/token and does not exercise the public payment gate.

The independently installed `agenttoll-monitor.timer` runs these unsigned API and data checks hourly on Hetzner, outside the serving process. The latest report is `/opt/agenttoll/monitor/latest.json`; history is in `journalctl -u agenttoll-monitor.service`. It records the active source revision, calls no paying endpoint with a signature, sends no notifications and changes no payment schedule. See [monitor setup](deploy/hetzner/README.md#read-only-monitoring). Expected third-party partial coverage remains visible without turning it into a process outage. A stale/unavailable result fails the service run for inspection.

## Request and payment evidence

New request logs have `schemaVersion: 2`; the report still reads version 1. Logs include UTC `t`, `requestId`, original HTTP `method`, canonical `path`/`route`, `status`, `ms`, allowlisted `errorCode`, `paymentSubmitted`, `paymentStage` and data-provider/cache counters. Exactly one `terminal: finish|abort` record is emitted. Aborts use local status marker 499, not a response sent to the client, and `abortReason: client_disconnected|request_timeout`. Discovery requests are logged too. HTTP 5xx records go to stderr.

Payment diagnostics include `paymentHeader` (header name/generation only), `protocolVersion` (decoded, unverified), `paymentPhase` (initialize/parse/match/verify/handler/settle), a fixed allowlisted `paymentReason`, and verify/settle invocation counts and waiting milliseconds. Shared `/supported` initialization and its SDK retries are excluded. In-flight duration is captured up to abort; late results do not rewrite a terminal record. Basename RPCs now participate in the separate data-provider counters and obey caller cancellation.

`paymentSubmitted` means a payment header was present, not that a valid signature was verified. Logs omit signatures, authorization payloads, private keys, raw user-agent strings, IPs, query values and requested wallet/name/symbol values. `client` accepts only known product names and numeric versions from `X-AgentToll-Client` or User-Agent; it is self-reported, not identity. `verifiedPayer` comes only from a successful SDK-validated facilitator verification response; `settlementTransaction` only from a successful facilitator settlement with a valid hash shape. They are public payment identifiers, not unique customers or an independent chain recheck. Unverified or rejected payer claims are never retained. The public [privacy notice](public/privacy.html) describes this policy and size-based Docker log rotation (3 × 10 MB).

An x402 2.21 SDK diagnostic can print arbitrary nested fields from `EXTENSION-RESPONSES`. A narrowly scoped adapter suppresses only its exact diagnostic prefix while inside payment request context. Ordinary logging is preserved. Review the adapter and its real SDK regression whenever upgrading x402. `X-PAYMENT`/v1 callers receive `PAYMENT_UPGRADE_REQUIRED` with v2 instructions; malformed input receives `MALFORMED_PAYMENT`. Neither is forwarded for verification or charged.

| Payment stage | Meaning |
| --- | --- |
| `none` | No payment submitted and no quote returned |
| `quote` | Unsigned request returned 402 |
| `rejected` | A request carrying a payment header returned 402, including invalid payloads and failed settlement receipts |
| `submitted` | A request carrying a payment header completed without a confirmed settlement response |
| `settled` | Confirmed successful facilitator settlement; delivery can still abort afterward, recorded separately in `terminal` |
| `unknown` | Settlement was attempted but its outcome cannot be confirmed |

An unsigned quote and its signed retry are two requests. Do not count 402 as a server error or divide unrelated signed/unsigned requests into a customer conversion rate. Legacy logs could label rejected payments as quotes or unsuccessful receipts as settled; the report retains their status/latency but excludes them from verified payment-stage counts. Data-provider counters do not include facilitator calls. Vercel routing/static logs and these application records cover different surfaces.

`/api/stats` uses a separate onchain heuristic: incoming USDC transfers of 1–50,000 micro-USDC. Field names such as `tollsCollected` and `revenueUsdc` are retained for API compatibility. These totals include tests and unsolicited transfers; they are not authenticated API sales. `external*` excludes only the known operator wallets, not every possible test wallet. Respect `partial`, `truncated`, source and timestamp notes. A distinct wallet is not a unique person or business.

## Scheduled jobs

The existing daily payment schedules remain payment-enabled. Manual keep-warm/scout workflow dispatch defaults to `dry-run`; `quote-only` performs unsigned inspection; `pay` enables the existing behavior. Preview jobs receive no wallet secret, and only a paying scout job commits snapshot data. Local invocations without a preview flag retain their previous payment behavior.

The automation client validates registered endpoint prices, origin, recipient, asset, chain and finite budget before signing. Its default budget covers one call at the selected endpoint's price. CI explicitly caps each run at 0.008 USDC and a 30-second payment deadline. Unknown or conflicting command-line options fail before payment. Inspect the emitted `budget` on failure: a reserved authorization may still be redeemable. Do not automatically rerun an ambiguous signed payment. The budget is per process, not a persistent daily wallet limit.

The read-only stats baseline job uses finalized-block checkpoints. On its first run after this change, a legacy `data/stats.json` is rebuilt completely to establish its start block, counting policy and boundary hash. Later runs resume at `block + 1`, verify the old boundary, and verify the new boundary before atomically replacing the file. At the audited height a full scan was 926 chunks; an ordinary day of 43,200 blocks is about 22 chunks. These are request-count calculations, not measured latency savings. The 45-minute job limit can stop a degraded migration without replacing the prior file.

The manual `full_rebuild` workflow input or `node --import tsx scripts/stats-snapshot.mjs --full-rebuild` rebuilds the configured range. Invalid/mismatched checkpoints fail closed. A custom receiver requires an explicit `STATS_FROM_BLOCK`. A checkpoint proves boundary consistency, not that an RPC returned every log. The live stats tail still reads the latest head; this is not a reorg-proof accounting ledger. Live indexer work has an eight-second total budget, followed by at most nine seconds for the chain fallback, subject to the caller's shorter deadline.

## Release and rollback

Before a release, run `npm test`, `npm run typecheck`, `npm run check:generated`, `npm run build`, `npm run build --prefix mcp`, `npm run smoke:mcp`, both dependency audits, and `python -m unittest discover -s deploy/hetzner -p 'test_*.py'`. CI uses Node 22; production uses Node 24. The packaged smoke installs the actual tarball with freshly resolved dependencies outside the repository, starts its real stdio process and checks all 23 tools, keyless quotes, schema validation and payment guardrails with blocked network and ephemeral unfunded keys.

MCP 0.14.0 is the first corrected release artifact. A local version string is not publication evidence: tag `mcp-v<version>` only after review, publish the same verified tarball, then download the explicit public npm version, compare SHA-512 and repeat consumer tests. The workflow retains both pre/postpublication evidence. Install examples pin the tested version; existing long-running or explicitly pinned older MCP clients require an upgrade and restart.

Record the current production image, release directory and source revision
before publishing. Read the active release from the controller's `state/current.json`;
the original migration release was
`20260912T204138Z-6a40554f991b-hetzner`; its full identity and checks are in
[the migration record](deploy/hetzner/VALIDATION.md). The retained Vercel rollback
deployment is `dpl_9uvkZdUSuif9GfBfojU8XDrF44jG` at
`897b4ca103c3be82243401c31d37c0d93516f5a6`. Follow the user's release authorization.
The Hetzner timer publishes successful main CI revisions with staged checks and
automatic failure rollback. Vercel Git integration remains separate. This host
migration does not require an MCP version bump or npm publication.

After an approved deployment, run the unsigned check, inspect fresh canonical
request logs and check daily workflow results. Keep production payment
verification as a separately authorized test with a dedicated funded wallet.
If a Docker release regresses, restore the previous validated image and
environment; the migration runbook also records the DNS rollback to Vercel.
Keep the last good published data snapshot; code rollback does not undo a
settled payment. Runtime rollback does not revert GitHub workflow files, so
handle a workflow regression in the repository as well.
