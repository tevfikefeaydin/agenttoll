# GitHub to Hetzner automatic releases

Task: `hetzner-autodeploy`. Owner: root; independent reviewer: migration_review.
Architectural scope: add the missing release controller to the existing Docker/Caddy service.
The user's “onu da yap” authorizes implementation and activation of automatic deployment.

The host checks public GitHub every five minutes. It deploys only a successful
`consistency.yml` push/manual run from this repository's main branch whose release
inputs match current main. Pull requests, forks, failed/pending runs and stale
code cannot reach production. Data snapshots and documentation alone do not
restart the service. No GitHub token, SSH private key or payment wallet is added.

The controller is installed under `/opt/agenttoll/deployer` by the operator;
repository changes cannot silently replace this host control program. It fetches
an exact checked revision, builds in a dedicated resource-limited BuildKit
builder, and starts a hardened candidate container using the existing runtime
credentials. It runs the existing 24 unsigned API checks before promotion.

Bootstrap changes the marked AgentToll block once to import a dedicated snippet.
Promotion then atomically changes only that snippet inside the existing Caddy
volume; the shared file and other hosts remain byte-identical. Validate before
write and reload without restarting Caddy. Check the public API and 25 proxy/static/TLS assertions before
recording success and gracefully stopping the old container. Keep the previous
container/image for rollback. Failed checks restore the old upstream. A durable
transaction journal restores the old release after interruption; a process lock
serializes manual and scheduled operations. A failed CI attempt is not retried
until an operator retries, CI is rerun, or new code passes CI.

Minimum free disk space gates builds, with three recent owned releases plus
current/previous retained and a bounded dedicated build cache. No broad Docker pruning or changes to
unrelated containers. Existing Vercel rollback, payment schedules, canonical
receiver, pricing, domain and CDP credentials stay intact. The one-time migration
check resolves the active release under the same lock so future code releases do
not produce false static-file comparisons.

Acceptance evidence: meaningful CI selection and rollback/crash tests; successful
Linux Docker candidate and isolated failure rehearsal; a real pushed main
revision passing GitHub CI and being automatically served; public checks and
unchanged unrelated Caddy hosts; active timer and documented recovery commands.

Tradeoff: a public pull controller avoids new credentials and inbound deployment
access, at the cost of up to five minutes after CI and server-side build time.
GitHub API failures or low disk space pause new releases while the current one
keeps serving. Runtime checks do not exercise real payment settlement.

References: [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[Caddy reload](https://caddyserver.com/docs/command-line#caddy-reload),
[resource-limited BuildKit](https://docs.docker.com/build/builders/drivers/docker-container/).
