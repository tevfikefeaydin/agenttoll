# Hetzner deployment

Production moved to Hetzner on **2026-09-12 at approximately 21:24 UTC**
(2026-09-13 00:24 Europe/Istanbul). See [VALIDATION.md](VALIDATION.md)
and the [evidence directory](evidence/) for observed results.

Subsequent code releases use the [automatic deployment controller](AUTODEPLOY.md).
Use that runbook for current status, logs and rollback. The Compose/cutover
instructions below describe the original migration and a fresh bootstrap.

Target: `167.233.31.87` (`ubuntu-4gb-fsn1-2`, Ubuntu 24.04, Docker Compose).
The existing `altyapi-caddy-1` container owns ports 80 and 443 and joins
`altyapi_default`. AgentToll initially used a separate Compose project and the same proxy
network. Application port 4021 is available only inside that network, with no
published host port. Existing containers on this network are trusted peers.

## Runtime and credentials

The image runs Node.js 24 as the unprivileged `node` user. It includes the
compiled Express application, browser assets and production dependencies.
`.dockerignore` admits only build inputs. Environment files and wallet files
must not be included in archives or images.

Keep `.env.production` on the server restricted with `chmod 600`. Its settings
are listed in `runtime.env.example`. The approved `AgentToll-Hetzner` CDP key
is restricted to this server's IPv4 address with View permission. The old
Vercel credential remains untouched for rollback. The optional existing
Blockscout credential was retained.
Compose pins the canonical public receiving address and `NETWORK=base`.
Do not copy local `.env`
or any `AGENT_PRIVATE_KEY`. Compose sets `PUBLIC_URL=https://agenttoll.app`
and `TRUST_PROXY=1`; the only public proxy is Caddy. If a CDN or another proxy
is later added, review the trusted proxy topology first.

Build and start from the release directory containing `compose.yaml`:

```sh
cd /opt/agenttoll/current
# The prepared release's .env already contains its unique image label.
# For a new release, set a new UTC timestamp/source-revision label first.
docker compose build
docker compose up -d --wait --wait-timeout 120
docker compose exec -T agenttoll node -e "fetch('http://127.0.0.1:4021/api/health').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
docker compose exec -T agenttoll node -e "fetch('http://127.0.0.1:4021/api/ready').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
docker compose ps
```

Persist the release label in the server release directory's `.env` for later
Compose commands, and record the image ID from `docker image inspect` with
the source revision and verification results. Do not reuse a release label
for a different build.

The periodic container health check uses process liveness only. `/api/ready`
separately verifies the configured payment facilitator and Base RPC; an
upstream outage must not continually restart the application.

## Proxy and cutover

The shared configuration is
`/opt/autoagent/companies/altyapi/Caddyfile`, mounted read-only in Caddy at
`/etc/caddy/Caddyfile`. Back it up before appending the marked block from this
directory. Validate a candidate inside the running Caddy container so its
existing environment substitutions resolve correctly. Write into the existing
bind-mounted file without replacing its inode, then use `caddy reload` rather
than restarting the shared container. Retain all unrelated host blocks.

The block preserves Vercel's security headers, `/run`, legal-page aliases,
favicon rewrite and canonical `www` redirect. Express owns the API and
discovery routes directly; `/api/*` must **not** be rewritten to `/api/index`.
Keep payment headers and OPTIONS responses intact.

The initial migration prepared a trusted certificate **before changing DNS**.
Certbot 5.8.0 used manual DNS-01 TXT challenges for the apex and `www`; the
private key stayed on Hetzner. Caddy first served this temporary certificate
from `/data/agenttoll-bootstrap/` in its persistent data volume. Both hostnames
were then tested with normal TLS verification and explicit routing to Hetzner:

```sh
curl --fail --resolve agenttoll.app:443:167.233.31.87 https://agenttoll.app/api/health
```

Squarespace manages the domain's authoritative DNS. The records observed before
migration on 2026-09-12 were:

| Host | Type | Previous value | Hetzner value |
| --- | --- | --- | --- |
| `@` | A | `216.198.79.1` | `167.233.31.87` |
| `www` | CNAME | `a2e78d0e63b91668.vercel-dns-017.com` | `agenttoll.app` |

Both changed records now have a 30-minute TTL. The previous TTL was four hours.
All four authoritative Squarespace nameservers, Cloudflare DNS and Google DNS
returned the new values at 21:24 UTC. There was no apex AAAA or CAA record.
Unrelated email TXT records were preserved.

After authoritative DNS switched, each AgentToll host block temporarily used
**two separate directives** (supported by the installed Caddy 2.11.4):

```caddyfile
tls /data/agenttoll-bootstrap/fullchain.pem /data/agenttoll-bootstrap/privkey.pem
tls force_automate
```

The adapted config contained both `load_files` and `automate` loaders.
Caddy acquired a separate managed certificate for each hostname while the
trusted static certificate remained available. Only after both successful
issuances and persistent certificate files were confirmed were the static
`tls` lines removed. The final [Caddyfile](Caddyfile) retains `tls force_automate`.
External TLS fingerprints then matched the managed certificates. Their keys
are mode 0600 in `altyapi_caddy_data`; renewal is now Caddy's responsibility.
The Certbot bootstrap certificate is no longer referenced by the active config.
This follows [Caddy's TLS automation](https://caddyserver.com/docs/caddyfile/directives/tls)
and [automatic HTTPS](https://caddyserver.com/docs/automatic-https) behavior.

Verify HTTPS for both hostnames, all static aliases, health/readiness,
discovery identity and every unsigned x402 quote before considering the
migration complete. Unsigned quotes do not prove real settlement; testing a
real payment is a separate user-authorized operation.

From a local checkout after `npm run build`, the read-only proxy checker verifies
all static content (text line endings normalized), media ranges, clean aliases,
security headers, discovery identity, both CORS payment generations and one
unsigned HTTPS challenge:

```sh
node deploy/hetzner/verify-proxy.mjs 167.233.31.87 report.json
```

The existing `dist/operations-check.js` separately verifies readiness, catalog
and all 21 unsigned endpoint quotes. Neither checker loads a signer.

## Operations and rollback

```sh
docker compose ps
docker compose logs --tail 100 agenttoll
docker stats --no-stream
```

Runtime caches and per-IP limits are in memory. Use one application instance
unless those limits are redesigned for multiple instances. Historical snapshots
and the stats baseline are read from GitHub, so no local database volume needs
to be migrated. Existing scheduled GitHub workflows use `agenttoll.app` and
continue to reach that origin after DNS changes.
The scout job (07:23 UTC) and keep-warm job (06:17 UTC) default to paid calls.
Avoid these windows and any active paid workflow during cutover; if necessary,
pause the relevant jobs before the switch and resume after verification.
Never blindly retry a signed request whose settlement result is unknown.

The standalone server drains active requests on SIGTERM/SIGINT, with a force
deadline of `REQUEST_TIMEOUT_MS + 5000`. Compose allows 135 seconds, longer
than the maximum supported request deadline plus the drain margin. This
reduces interrupted-payment risk during later container replacements.

Subsequent main code releases are deployed by the [automatic controller](AUTODEPLOY.md)
after CI and staged checks. Its rollback command replaces the old Compose update procedure.

The original migration release is
`/opt/agenttoll/releases/20260912T204138Z-6a40554f991b-hetzner`.
`/opt/agenttoll/current` follows the latest validated release. Application logs
use Docker's bounded local driver.

A one-time read-only follow-up is scheduled for **2026-09-13 01:40 UTC**
(04:40 Europe/Istanbul), after the former four-hour DNS TTL has expired.
`agenttoll-post-cutover-check.timer` invokes the tested
[post-cutover-check.sh](post-cutover-check.sh). It checks all 24 API/quote
conditions, 25 proxy conditions and both TLS hostnames using normal DNS.
It mounts no credentials, has no signer and sends no payments. Its preflight
passed before scheduling. Reports are written to `/opt/agenttoll/checks/<UTC>/`;
the timer has not yet fired as of this migration record. It does not remove
Vercel or send notifications.

```sh
systemctl status agenttoll-post-cutover-check.timer
journalctl -u agenttoll-post-cutover-check.service
```

Keep the previous Vercel deployment available through the cutover and at least
the old four-hour DNS TTL plus a safety margin (24 hours is recorded for this
migration; no automatic Vercel deletion is scheduled). If a live
check fails, restore the previous Squarespace A/CNAME records and verify the
Vercel origin. Do not delete the Vercel project until the migration is verified.
DNS rollback also needs time to propagate; preserve both origins meanwhile.
For a proxy rollback, preserve any later changes to other sites and remove or
replace only the marked AgentToll block. The immediate pre-migration backup is
`Caddyfile.before-agenttoll-20260912T211809Z` in the release directory. A full
backup restore is appropriate only if no unrelated edits occurred afterward.
Validate and reload in place. Never stop or recreate unrelated containers.
