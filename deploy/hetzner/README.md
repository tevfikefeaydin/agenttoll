# Hetzner deployment

The hosted API uses Docker and Caddy. Application releases follow the
[automatic deployment runbook](AUTODEPLOY.md). This document describes a fresh
bootstrap; existing automatic releases must not be replaced with Compose.

Keep the host inventory, origin IP, shared proxy paths, network names, runtime
credentials and raw verification reports in private operator storage. The
standard application directory used by these templates is `/opt/agenttoll`.
It is an installation convention, not a credential. Do not publish the names or
configuration of unrelated services sharing the host.

## Runtime and credentials

The image runs Node.js 24 as the unprivileged `node` user. Its filesystem is
read-only, capabilities are dropped, and the application port is reachable only
on the configured Docker proxy network. Existing containers on that network are
trusted peers. Caddy is the single public proxy; review `TRUST_PROXY` if another
proxy or CDN is introduced.

Store the production runtime values in a server-local file restricted to mode
0600. `runtime.env.example` documents the required settings. The hosted API needs
a public receiving address and facilitator credentials, never a paying wallet
private key. Use a facilitator credential restricted to the required permissions
and origin IP. Keep environment files and wallet files out of archives and images.

For a fresh Compose bootstrap, set `AGENTTOLL_RELEASE` to a unique release label
and `PROXY_NETWORK` to the existing Caddy network in a private `.env` or the shell.
The network has no repository default. Create `.env.production` from the reviewed
runtime template, then validate and start the new application:

```sh
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 120
docker compose ps
```

Compose sets the canonical URL and Base mainnet receiving configuration. Do not
copy a development `.env` or a paying wallet key into production. The health check
uses process liveness; temporary upstream failures must not repeatedly restart
a healthy application. The 135-second shutdown grace lets accepted requests drain.

## Proxy and TLS

Keep the existing Caddyfile location, proxy container name and storage mount in
private operator configuration. Back up the current configuration before adding
the marked AgentToll block from [Caddyfile](Caddyfile). Validate the whole candidate
with the running Caddy binary and reload it without replacing unrelated host
blocks or restarting the shared proxy. A bind-mounted Caddyfile must retain its
inode when updated.

The proxy preserves security headers, static/legal aliases, canonical redirects,
CORS and both payment-header generations. Express owns `/api/*`; do not rewrite
these routes to a serverless entry point. Caddy manages the production TLS
certificates; private keys stay in protected proxy storage.

Test the candidate with canonical Host/SNI and normal certificate verification
before changing DNS. Pass the approved target address explicitly from private
configuration when using the proxy checker:

```sh
npm run build
: "${AGENTTOLL_EXPECTED_IP:?Set the approved origin address}"
mkdir -p output
node deploy/hetzner/verify-proxy.mjs "$AGENTTOLL_EXPECTED_IP" output/proxy-report.json
npm run ops:check
```

With no target-IP argument, the proxy checker uses public DNS. It checks static
file bytes, media ranges, aliases, security headers, identity, redirects, CORS and
an unsigned payment quote. `ops:check` separately checks readiness, the catalog
and all 21 unsigned quotes. Neither command authorizes payment.

The optional one-time DNS/TLS observer requires `AGENTTOLL_EXPECTED_IP` and fails
before taking the deployment lock if that value is absent or invalid:

```sh
AGENTTOLL_EXPECTED_IP="$APPROVED_ORIGIN_IP" bash deploy/hetzner/post-cutover-check.sh
```

The expected IP must come from the approved private inventory, not a DNS response
being tested. Keep generated reports outside version control.

## Read-only monitoring

Install the reviewed `monitor.py` and its systemd units separately from application
releases. Verify the units before enabling `agenttoll-monitor.timer`. Its hourly
run checks unsigned API responses, source availability and snapshot age, using the
current release and no paying wallet. It has an 85-second host deadline; private
reports are replaced atomically with mode 0600.

A source fallback may preserve availability while coverage remains degraded.
A green readiness check does not prove complete provider data or real settlement.
See [OPERATIONS.md](../../OPERATIONS.md) and the
[private usage archive guide](USAGE-ARCHIVE.md) for the separate data and usage
checks. Review logs locally; publish only a summary that excludes host inventory,
credentials and customer records.

## Rollback and host maintenance

Use the controller's recorded previous release and deployment lock for application
rollback. Preserve the previous image, routing and runtime settings until the new
release passes its checks. Inspect pending recovery before retrying a failed
release; never blindly repeat a request with an uncertain payment outcome.

For the original bootstrap or a DNS migration, record the previous DNS/proxy
values privately and retain both origins through DNS cache expiry and an agreed
safety window. Preserve later unrelated proxy edits when restoring a route.
Do not recreate other containers or prune shared Docker state.

The public [migration summary](VALIDATION.md) and
[automatic release summary](AUTODEPLOY-VALIDATION.md) retain the observed results.
Raw host captures are kept privately. The migration compatibility regression in
`test_autodeploy.py` uses explicitly synthetic data.
