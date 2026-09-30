# Migration verification — 12 September 2026

The canonical service moved to Hetzner at approximately 21:24 UTC. DNS, managed
HTTPS and application checks passed. This is a historical summary; it does not
assert the current runtime state.

## Observed results

- 211 application tests, typechecks, generated-file checks and builds passed.
- The production image ran as an unprivileged user with a read-only filesystem
  and no published application port.
- Candidate and public API checks passed all 24 unsigned assertions.
- HTTPS proxy/static checks passed all 25 assertions used at the time.
- Four direct provider checks passed; unrelated services retained their previous
  responses and the shared proxy was reloaded without a restart.
- Caddy managed both certificates after migration. Temporary certificate
  bootstrap records were removed; private keys remained on the host.
- The previous origin and release were retained for rollback and DNS cache expiry.

No real payment was authorized by these checks. They established the tested
readiness, quoting, routing and provider behavior, not settlement guarantees.

Raw DNS, TLS, runtime and shared-host captures are retained privately. They were
removed from the current public tree to avoid disclosing operator inventory and
unrelated service names; no redacted capture is presented as original evidence.

Use the [deployment runbook](README.md) for a new installation and the
[controller runbook](AUTODEPLOY.md) for the current release, retry and rollback.
