# Research Growth Implementation Plan

> Execute with superpowers:subagent-driven-development, scoped owners and independent review.

**Goal:** durable usage evidence and a connected discovery, inspection and revisit workflow.
**Architecture:** existing receipt summary plus private host collector; existing browser payment state machine plus bounded discovery/digest models.
**Tech stack:** TypeScript, Node 22+, Python, systemd, existing vanilla HTML/CSS.
**Spec:** ../specs/2026-09-26-research-growth-design.md

## Global constraints

No automatic spending, production deployment, new dependencies or fabricated user evidence. Preserve existing uncommitted files. Do not store arbitrary log fields. Limits, missing data, source types and observed times remain explicit.

## Tasks and ownership

- [x] G1 (measurement implementer; root integration): add private bounded collector/model, tests and deployment units. Own new usage archive files and collector-specific docs; do not modify existing shared files until coordinated. Red test: replay same input twice then summarize yields one settlement; conflicting same-ID receipt remains excluded. Also test restart, source failure, retention, malformed state, oversized input and atomic preservation.
- [x] G2 (browser implementer; root integration): extend web/research* and new discovery/digest/reminder models, focused tests. Existing ResearchPayments interface owns quote/pay/cancel. Red tests cover null tokens, wrong chain, nonfinite numbers, missing date, unsafe strings, evidence loss and repeat cached observation. Browser flow must purchase discovery separately and link valid token to inspector.
- [x] G3 (root): site positioning, privacy/runbook integration, pilot script and acceptance records. Generated web builds happen only after G2 is ready.
- [x] G4 (root): first full verification with captured command results; resolve regressions.
- [x] G5 (fresh non-author reviewer): whole-change adversarial review and second verification, including executable local flows. Resolve findings and rerun affected checks before delivery.

## Review focus

Overlapping logs and conflicting identities across collection runs; write failures must not advance collection cursor; deployment/container turnover and gaps; asynchronous stale browser quotes; untrusted token names/addresses and source timestamps; same-time conflicting saved reports; keyboard/mobile usability; explicit payment boundaries.

## Ledger

- 2026-09-26 resume: recovered interrupted session; completed G1–G5 locally.
  Fresh reviewer found health-probe capacity, observation-coverage and partial
  source-loss bugs; reproduced and fixed all three. Also fixed Docker stderr
  loss. Final suite: 444 application tests and 35 deployment tests, typechecks,
  builds, generated consistency, seven MCP smoke cases and zero npm audit
  vulnerabilities. Browser fixture and 24 live unsigned checks passed.
  See `docs/audit/2026-09-26-growth-verification.md` for evidence and limitations.
  Deployment and timer activation remain outside this implementation scope.

- 2026-09-26: source status inspected, existing local reports preserved. Shared playbooks already linked. Feature branch created. User delegates implementation choices and asks for two verification passes.
- Ruling: opt-in calendar reminder delivers a return path without unrequested external messaging or new automatic spending. Server webhooks/Telegram remain a future distinct authorization subsystem.
