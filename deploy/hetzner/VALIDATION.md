# Migration verification — 2026-09-12

Status: **live on Hetzner; DNS, managed HTTPS and application checks passed**.
The A/CNAME switch completed at approximately 21:24 UTC on 2026-09-12.
The isolated AgentToll production container is healthy. Vercel remains available
for clients with cached DNS and for rollback. Both temporary bootstrap TXT
records were removed after user approval, verified on all four authoritative
nameservers.

## Release identity

- Host: `167.233.31.87`, `ubuntu-4gb-fsn1-2`.
- Base source revision: `6a40554f991b`, plus the local Hetzner packaging and
  graceful shutdown changes in this working tree.
- Release: `20260912T204138Z-6a40554f991b-hetzner`.
- Server directory: `/opt/agenttoll/releases/20260912T204138Z-6a40554f991b-hetzner`.
- Transferred source archive SHA-256:
  `b15986e79a55f42fcd6e7cc487493d27750021f78cffd45a3166e2fb486c6d63`.
- Runtime image: `agenttoll:20260912T204138Z-6a40554f991b-hetzner`.
- Runtime image ID:
  `sha256:ba4e1a69d97f09f6b9a580e7ef397adfb1445a36cdfb82583d1f9e0d4352b56c`.
- Node base image: `node:24-bookworm-slim`, manifest digest
  `sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553`.

## Observed checks

| Check | Result | Scope |
| --- | --- | --- |
| Local `npm run build` | Passed | Compiled API and browser bundle |
| Local `npm test` | 211/211 passed | Offline regression suite, including payment lifecycle fixtures |
| Independent `npm run typecheck` | Passed | API, browser, MCP and tests |
| Independent `npm run check:generated` | Passed | Shared policy, manifest, generated examples and browser consistency |
| Docker production build on Hetzner | Passed | Actual Linux image and production dependencies |
| Compose `config --quiet`, `up -d --wait` | Passed | Real production env; container healthy |
| Linux lifecycle subprocess tests | 2/2 passed | Real SIGTERM drains active requests; force deadline terminates stalled requests |
| Runtime container user | UID 1000 | Unprivileged Node user |
| Runtime filesystem | Read-only; write probe rejected | `/app/.env` and `/app/.env.production` absent |
| Isolated runtime HTTP smoke | 9/9 returned 200 | Network disabled, fixture Base Sepolia configuration, no payments |
| Shared Caddy candidate validation | Passed | Existing whole config plus the AgentToll host blocks, validated inside Caddy 2.11.4 |
| Vercel live baseline | 24/24 passed | Mainnet liveness, readiness, catalog and 21 unsigned quotes |
| Hetzner internal production checks | 24/24 passed | Real mainnet configuration and new IP-restricted CDP key |
| Hetzner HTTPS checks before DNS | 24/24 passed | Forced DNS mapping to Hetzner, canonical SNI and normal TLS verification |
| Hetzner proxy/content checks | 25/25 passed | Static content, clean aliases, video ranges, headers, discovery, www redirect and CORS |
| Hetzner provider reads | 4/4 passed | Price, gas, trending and scout functions; no paid HTTP requests |
| Other shared Caddy sites | 7/7 unchanged | Statuses match the immediate pre-change baseline |
| Credential byte preservation | Passed | Runtime ID and secret hash match approved local JSON; 64 decoded secret bytes; no secret printed |
| Trusted bootstrap certificate | Passed | TLS 1.3, Let's Encrypt YE2, apex and www SANs, expires 2026-12-11 |
| Final public DNS application checks | 24/24 passed | Resolver returned `167.233.31.87`; canonical HTTPS origin, no forced mapping |
| Final old/new proxy comparison | 25/25 each passed | Same checker on old Vercel IP and Hetzner, including expanded CORS and discovery assertions |
| Final Caddy-managed TLS | Passed for both names | External fingerprints match separate managed certificates in persistent storage |
| Post-cutover runtime | Healthy, 0 restarts | About 70 MiB / 768 MiB; no published port 4021 |
| Post-cutover telemetry | 0 server errors | 51 API/discovery requests observed since 21:24 UTC; 0 unknown payment outcomes |
| Remaining free API surfaces | 2/2 passed | `/api/demo` has 21 samples; `/api/stats` returns 200 with Base data/payment networks |
| Chrome functional smoke | Passed | Home page and counters render; live quote button shows $0.004 USDC, Base mainnet and the expected receiver |
| Final shared-host comparison | 7/7 unchanged | Repeated after final managed-certificate reload at 21:37:59 UTC |
| Independent final review | No blockers found | Reviewed DNS, TLS, paired 25-check reports, 24-check public report, runtime and runbook |
| Post-TTL check driver preflight | Passed | 24 API checks, 25 proxy checks and two TLS names; no credentials mounted |
| One-time follow-up timer | Scheduled, not yet executed | 2026-09-13 01:40 UTC / 04:40 Europe/Istanbul; systemd unit validation passed |

The nine runtime smoke paths were `/`, `/run.html`, `/terms.html`,
`/privacy.html`, `/demo.js`, `/openapi.json`, `/api/health`, `/api/catalog`,
and `/.well-known/agent-card.json`. Clean aliases have since passed through
the actual HTTPS proxy. The early `Caddyfile.candidate` was not activated;
a fresh candidate was built from the current live configuration at cutover.

The image was run with `--network none`, `--read-only`, a temporary `/tmp`,
`--cap-drop ALL`, and `--security-opt no-new-privileges:true`. This verifies
packaging and basic operation, not production upstream availability.

The executed structural/build/signal/proxy commands were:

```sh
cd /opt/agenttoll/releases/20260912T204138Z-6a40554f991b-hetzner
export AGENTTOLL_RELEASE=20260912T204138Z-6a40554f991b-hetzner
docker build --tag agenttoll:$AGENTTOLL_RELEASE .
docker compose config --no-env-resolution --quiet
docker build --target build --tag agenttoll-build:$AGENTTOLL_RELEASE .
docker run --rm --network none --read-only --tmpfs /tmp:size=32m --user node --mount type=bind,src="$PWD/tests",dst=/app/tests,readonly --entrypoint node agenttoll-build:$AGENTTOLL_RELEASE --import tsx --test tests/server-lifecycle.test.ts
cat /opt/autoagent/companies/altyapi/Caddyfile deploy/hetzner/Caddyfile > Caddyfile.candidate
docker cp Caddyfile.candidate altyapi-caddy-1:/tmp/agenttoll-validate.caddy
docker exec altyapi-caddy-1 caddy validate --config /tmp/agenttoll-validate.caddy --adapter caddyfile
docker image inspect agenttoll:$AGENTTOLL_RELEASE --format '{{.Id}}'
```

Each completed with exit 0. Caddy reported an existing formatting warning at
line 5 of the combined configuration, then `Valid configuration`. The tests
used actual SIGTERM on Linux; Windows exercises the same listener through
the process event because Windows does not deliver POSIX SIGTERM.

## Production preparation and evidence

The user approved creating the `AgentToll-Hetzner` CDP key. It is restricted
to `167.233.31.87/32`, with View permission and no Trade or Transfer permission.
The old Vercel key and environment remain untouched. The runtime environment
is mode 0600 and contains the new CDP credential plus the existing optional
Blockscout key. No wallet private key was loaded or copied.

The deployed application code matches Vercel production revision
`897b4ca103c3be82243401c31d37c0d93516f5a6` apart from the documented shutdown
support. The local base revision differs only in GitHub data snapshots;
`git diff HEAD origin/main -- src public web scripts package.json package-lock.json vercel.json`
was empty. Public text comparisons normalize CRLF/LF; no textual differences
were found. Binary content is compared exactly.

The current shared Caddy configuration had been changed independently at
21:06 UTC. Those changes were preserved. The backup taken immediately before
our additive change is:

`/opt/agenttoll/releases/20260912T204138Z-6a40554f991b-hetzner/Caddyfile.before-agenttoll-20260912T211809Z`

Backup SHA-256: `243b7147be1e72432eebc08f50b84db6f562ebf77944d599fcf773b4d7b5c6f4`.
The bind-mounted file inode was retained. Caddy was reloaded and its container
start time stayed `2026-09-12T21:06:01.722537366Z`, restart count 0.
The duplicate `X-Content-Type-Options` header observed in the first proxy check
was fixed with `header { defer }`, then all proxy checks passed.

DNS-01 validation issued a bootstrap certificate without changing the A/CNAME
records. Real certificate files are stored in the persistent Caddy data volume
under `/data/agenttoll-bootstrap/`; the private key is mode 0600. This manual
certificate was replaced by Caddy-managed certificates before removing its
static TLS configuration. Caddy obtained both managed certificates at
21:25:30 UTC. The external TLS check at 21:28:52 UTC confirmed their exact
fingerprints; both expire on 2026-12-11 and use Caddy's automatic renewal.

The final Caddyfile SHA-256 is
`94d567da49182f4e8de198753439f65d5d6e9b79100abe25630412c027d53dd8`.
The entire pre-migration Caddyfile is still an exact byte prefix of the active
file, proving unrelated blocks were preserved. Caddy's start time and restart
count remained unchanged through all of this migration's reloads.

Machine-readable results are under [evidence](evidence/). The keyless proxy
checker can be rerun with:

```sh
node deploy/hetzner/verify-proxy.mjs 167.233.31.87 report.json
```

Run this from a local checkout after `npm run build`; it imports the compiled
endpoint registry. Documentation and evidence were updated after the immutable
runtime image build; the recorded image ID and source archive hash remain the
identity of the running application bytes.

## Completion notes

1. DNS is `A @ 167.233.31.87`, `CNAME www agenttoll.app`, both TTL 1800.
   All four authoritative nameservers and Google/Cloudflare resolvers agreed.
   No apex AAAA or CAA was introduced. Email TXT records are unchanged.
2. Caddy now manages both certificates; no manual bootstrap certificate
   dependency remains in the active configuration.
3. Both temporary ACME TXT records were deleted after user approval. Squarespace
   shows only the final A/CNAME custom records, and all four authoritative
   nameservers confirm both challenge TXT records are absent.
4. The previous Vercel deployment and credential remain intact for rollback.
   Keep them for at least the old TTL plus a safety margin; no deletion is
   scheduled. Subsequent releases use the [automatic deployment controller](AUTODEPLOY.md);
   this record describes the original migration release.
5. A persistent, one-time `agenttoll-post-cutover-check.timer` is active for
   2026-09-13 01:40 UTC, after the previous DNS TTL expires. Its tested driver
   uses no credentials or signer. Reports will be saved under
   `/opt/agenttoll/checks/`; future timer results are not claimed by this record.

No real payment was sent and no wallet key was read. These checks establish
readiness, quoting and provider connectivity; they do not exercise settlement.
See [the runbook](README.md) for the
specific original DNS values, operational commands and rollback procedure.
