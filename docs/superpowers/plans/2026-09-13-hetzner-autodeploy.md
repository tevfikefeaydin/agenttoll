# Hetzner automatic deployment plan

Goal: main code passing GitHub CI automatically reaches the existing Hetzner service.
Architecture: public pull controller, staged Docker release, validated Caddy reload,
durable rollback journal and serialized systemd timer.
Tech stack: Python 3 standard library, Git, Docker Buildx, Caddy 2, GitHub Actions.
Spec: `docs/superpowers/specs/2026-09-13-hetzner-autodeploy-design.md`.
Global constraints: preserve live behavior and other hosts; no signed payments,
root key export, unrelated user changes, Vercel deletion or broad resource pruning.

- [x] Add failing behavioral tests for CI identity/tree gating, pre-switch failure,
  post-switch rollback, interruption recovery and concurrent Caddy edits in
  `deploy/hetzner/test_autodeploy.py`.
- [x] Implement `deploy/hetzner/autodeploy.py` with a real command adapter and
  transaction controller; run the tests. Add the Python checks to existing CI.
- [x] Add systemd service/timer, active-release follow-up check and operator
  instructions. Review the final code independently before enabling production.
- [x] Run local application checks and isolated Linux deployment failure tests;
  install the controller, builder and restricted shared runtime environment.
- [ ] Commit only migration/automation changes, push to main, observe CI and a
  genuine automatic release, then verify API/proxy and unrelated hosts.
- [ ] Record live evidence and recovery commands; obtain independent final review.

Pre-activation review: migration_review accepted the code and rehearsal evidence.
27 deployment tests, 211 application tests, typechecks, generated/build/MCP
checks and both audits passed. Six isolated Linux cases include SIGKILL and
in-flight request drain. Canonical candidate 24/24 and bootstrap public 49/49
passed. Review revisions centralized cleanup/rollback semantics; source changes
were followed by focused regressions rather than repeated unmodified runs.
