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
npm run ops:report -- --input requests.ndjson

npm run build
node scripts/keep-warm.mjs --dry-run
node scripts/keep-warm.mjs --quote-only --path=/api/base/scout
node scripts/snapshot.mjs --dry-run
node scripts/snapshot.mjs --quote-only
```

`ops:check` checks liveness, readiness, the catalog and all 21 registered payment quotes. It creates a client with no signer and a zero budget; it never reads a private key, follows a redirect, or sends a signed request. Default limits are five seconds per check and sixty seconds overall. Exit 1 means one or more checks failed. Each invocation creates real unsigned traffic; account for monitoring calls when interpreting usage. This release does not enable a new background monitoring schedule.

Set `AGENTTOLL_URL`, `AGENTTOLL_NETWORK` and an explicitly trusted `AGENTTOLL_RECIPIENT` to check a self-hosted instance. The hosted default is `https://agenttoll.app` on Base. Setting a testnet network cannot change the hosted payment network. No `.env` file is loaded by the operations commands.

`ops:report` reads at most 20 MiB of newline-delimited application JSON (direct request records, or JSON objects with a `message` containing the record). It makes no network calls. It outputs status counts, server errors, nearest-rank p50/p95 latency, instrumented data-provider/cache totals, payment outcomes and canonical endpoint groups. An empty/unusable export exits 1. Duplicate request IDs and invalid lines are reported separately. It describes only the supplied records; it cannot restore events lost to retention or sampling.

## Request and payment evidence

Request logs have `schemaVersion: 1`, UTC `t`, `requestId`, original HTTP `method`, canonical `path`/`route`, `status`, `ms`, `errorCode`, `paymentSubmitted`, `paymentStage` and data-provider/cache counters. `paymentSubmitted` means a payment header was present; it does not establish a valid signature. Dynamic wallet/name/symbol values and query strings are not included. Discovery requests are logged too. HTTP 5xx records go to stderr.

| Payment stage | Meaning |
| --- | --- |
| `none` | No payment submitted and no quote returned |
| `quote` | Unsigned request returned 402 |
| `rejected` | A request carrying a payment header returned 402, including invalid payloads and failed settlement receipts |
| `submitted` | A request carrying a payment header completed without a confirmed settlement response |
| `settled` | Successful HTTP response with a payment receipt |
| `unknown` | Settlement was attempted but its outcome cannot be confirmed |

An unsigned quote and its signed retry are two requests. Do not count 402 as a server error or divide unrelated signed/unsigned requests into a customer conversion rate. Legacy logs could label rejected payments as quotes or unsuccessful receipts as settled; the report retains their status/latency but excludes them from verified payment-stage counts. Data-provider counters do not include facilitator calls. Vercel routing/static logs and these application records cover different surfaces.

`/api/stats` uses a separate onchain heuristic: incoming USDC transfers of 1–50,000 micro-USDC. Field names such as `tollsCollected` and `revenueUsdc` are retained for API compatibility. These totals include tests and unsolicited transfers; they are not authenticated API sales. `external*` excludes only the known operator wallets, not every possible test wallet. Respect `partial`, `truncated`, source and timestamp notes. A distinct wallet is not a unique person or business.

## Scheduled jobs

The existing daily payment schedules remain payment-enabled. Manual keep-warm/scout workflow dispatch defaults to `dry-run`; `quote-only` performs unsigned inspection; `pay` enables the existing behavior. Preview jobs receive no wallet secret, and only a paying scout job commits snapshot data. Local invocations without a preview flag retain their previous payment behavior.

The automation client validates registered endpoint prices, origin, recipient, asset, chain and finite budget before signing. Its default budget covers one call at the selected endpoint's price. CI explicitly caps each run at 0.008 USDC and a 30-second payment deadline. Unknown or conflicting command-line options fail before payment. Inspect the emitted `budget` on failure: a reserved authorization may still be redeemable. Do not automatically rerun an ambiguous signed payment. The budget is per process, not a persistent daily wallet limit.

The read-only stats baseline job uses finalized-block checkpoints. On its first run after this change, a legacy `data/stats.json` is rebuilt completely to establish its start block, counting policy and boundary hash. Later runs resume at `block + 1`, verify the old boundary, and verify the new boundary before atomically replacing the file. At the audited height a full scan was 926 chunks; an ordinary day of 43,200 blocks is about 22 chunks. These are request-count calculations, not measured latency savings. The 45-minute job limit can stop a degraded migration without replacing the prior file.

The manual `full_rebuild` workflow input or `node --import tsx scripts/stats-snapshot.mjs --full-rebuild` rebuilds the configured range. Invalid/mismatched checkpoints fail closed. A custom receiver requires an explicit `STATS_FROM_BLOCK`. A checkpoint proves boundary consistency, not that an RPC returned every log. The live stats tail still reads the latest head; this is not a reorg-proof accounting ledger. Live indexer work has an eight-second total budget, followed by at most nine seconds for the chain fallback, subject to the caller's shorter deadline.

## Release and rollback

Before an approved release, run `npm test`, `npm run typecheck`, `npm run check:generated`, `npm run build`, `npm run build --prefix mcp`, `npm run smoke:mcp`, and audits for both npm trees. CI uses Node 22; the configured production runtime is Node 24. The packaged smoke test starts the actual tarball with 23 MCP tools and no wallet.

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
