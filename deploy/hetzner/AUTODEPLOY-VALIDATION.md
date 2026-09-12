# Automatic deployment activation — 13 September 2026

**Live and verified.** The timer deployed the successful main CI revision without
a manual deploy command. The user authorized enabling this release path after
the Hetzner migration. Independent reviewer `migration_review` accepted the
implementation and final live evidence.

## Actual release

- Source: `c83262b68141a1451ff1fd4ab884ac60c449decd`.
- [GitHub CI run 34723036404](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34723036404):
  main/push, attempt 1, completed successfully; checkout/setup-node use pinned commits.
- First timer check at 22:33 UTC waited because CI was still running.
- Next timer check at **22:38:16 UTC** built the verified revision; deployment
  completed at **22:39:09 UTC** (13 September 01:39:09 Europe/Istanbul).
- Release: `/opt/agenttoll/releases/20260912T223818Z-c83262b68141`.
- Image ID: `sha256:fe0634bc2017fd80666834a0100d7fd00ddd33cda86ee6e093e73f6937fc972f`.
- Container: `agenttoll-r-20260912t223818z-c83262b68141`.
- Timer enabled/active; service succeeded; `pending`, `cleanup` and `failed` are empty.

The active Caddy route names only the new container. Its image ID and source
label match the recorded release. It runs as `node`, with a read-only filesystem,
no published application port and zero restarts. Nine runtime settings, including
receiver, Base network and CDP credentials, match the old container exactly;
values were compared privately and credentials are absent from the evidence.

The previous migration container stopped with exit 0 after `shutdown_complete`.
Its image, environment and release files remain available for rollback. Later
documentation/evidence-only commits intentionally do not replace this image.

## Observed checks

| Check | Result | Evidence |
| --- | --- | --- |
| Application regression tests | 211 passed | Successful CI offline test step |
| Deployment regressions | 27 passed on Windows/Linux | Successful CI Python step; independent rerun |
| Types, generated surfaces, builds, MCP smoke, audits | Passed; both audits reported zero vulnerabilities | [CI evidence](evidence/autodeploy-github-ci.json) |
| Real isolated Docker/Caddy failure rehearsal | 6 passed | [Linux rehearsal](evidence/autodeploy-linux-rehearsal.json) |
| Actual candidate API/quote probe | 24/24 | [Candidate](evidence/autodeploy-live-candidate.json) |
| Actual public API/quote probe | 24/24 | [Public API](evidence/autodeploy-live-public-api.json) |
| HTTPS content/proxy checks | 25/25 | [Public proxy](evidence/autodeploy-live-public-proxy.json) |
| Direct Hetzner HTTPS health samples spanning deployment | 45/45 HTTP 200 | [Availability window](evidence/autodeploy-availability.json) |
| Other hosted sites | All seven statuses unchanged | [Before](evidence/autodeploy-shared-hosts-before.json), [after](evidence/autodeploy-shared-hosts-after.json) |
| Live release, routing, environment equality, graceful old shutdown | Passed | [Activated state](evidence/autodeploy-activated.json), [service journal](evidence/autodeploy-service-journal.txt) |

The isolated rehearsal covers candidate, public-check and reload failures; a
SIGKILL after switching; completion of an in-flight request while the failed
candidate drains; and successful promotion. Offline tests additionally cover
CI identity/attempt/tree gates, corrupt boot records, atomic write interruption,
concurrent Caddy edits, immutable images, scoped retention, cleanup retry and
emergency/repeated rollback.

The candidate checker shares only the candidate's network namespace and uses
native HTTP to loopback with canonical Host/protocol. It supports both URL and
Request inputs. The independent checker has no runtime credentials, signer or
payment budget. This specifically avoids Node fetch's ignored Host override and
proves the candidate's quotes, rather than accidentally testing the old service.

## Shared proxy and DNS observation

The one-time routing import bootstrap preserved the shared file's inode and
passed 49 public checks. Its backup and hashes are in the
[bootstrap record](evidence/autodeploy-routing-bootstrap.json). During the actual
automatic release the shared Caddyfile stayed byte-identical:
`09992271f0022b69fae513ccba4fa1540443da263dc86242adc75708fba9e8df`.
Caddy was not restarted: its start time remains 21:06:01 UTC from before this task.

**Full DNS cache expiry is still a scheduled observation.** The old DNS TTL was
four hours. A local probe at 22:37–22:38 UTC reached the retained Vercel origin
and received HTTP 200 in all 13 samples; its strict Hetzner-IP assertion is
therefore false in the [raw cache observation](evidence/autodeploy-cached-vercel-observation.json).
It is not counted as Hetzner availability evidence.

The early 22:41 UTC follow-up passed all 24 API checks and
[25 normal-DNS proxy checks](evidence/autodeploy-early-dns-proxy.json), but its
separate `www` TLS connection still reached cached Vercel routing at `64.29.17.1`
and returned a valid TLS 307 redirect. Its overall result is correctly retained
as [false](evidence/autodeploy-early-dns-followup.json). The apex reached Hetzner;
both DNS providers queried from the workstation returned the new address.

The existing one-time check remains scheduled for **13 September 01:40 UTC /
04:40 Istanbul**, after the old TTL expires. It now locks deployments and resolves
the active release/image at execution time. Its future result is not claimed
here. The `autodeploy-followup-check-*` evidence files are the earlier 22:34 UTC
preflight, not the scheduled post-TTL result. Vercel remains available throughout.

No real payment or settlement was tested, no wallet key was read, and no GitHub
deployment credential was added. Use [the runbook](AUTODEPLOY.md) for status,
pause/resume, retry, policy updates and rollback.
