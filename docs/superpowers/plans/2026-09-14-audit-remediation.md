# Audit remediation implementation plan

> For agentic workers: execute the independent tasks with `superpowers:dispatching-parallel-agents`; apply `superpowers:systematic-debugging` and `superpowers:verification-before-completion`. Root integrates; a different reviewer reviews the final product.

**Goal:** Close the AgentToll-owned defects confirmed in the 2026-09-14 audit, release the corrected MCP and API, and verify actual installed/live behavior.

**Architecture:** Preserve the existing Express/x402 v2 service, bounded payment client, static site and CI-gated Hetzner release controller. Add safe request/payment diagnostics at existing boundaries, test the real independently installed npm artifact, and improve provider coverage and observable data freshness without weakening payment or data-quality safeguards.

**Tech stack:** TypeScript, Node >=22, Express 5, x402 v2, npm, GitHub Actions, Docker/Hetzner.

**Spec:** Existing audit at `D:/Çalışma Alanı/01_Projeler/agenttoll-main/docs/audit/2026-09-14/REPORT.md` and its MCP/release subreports; user instruction: “bizden kaynaklı her türlü eksikliği kapat”.

## Constraints and acceptance

- Use the current main revision d7d0336 as baseline; retain all original-workspace changes and audit evidence.
- Each task owns separate files. Root owns integration, site, operations documentation, release and final evidence. No other worker commits, pushes, publishes or changes production.
- No signature, authorization payload, key, credential, query value or unverified wallet identity in logs. Verified public payer/transaction identifiers must be documented explicitly.
- Retain endpoint prices, canonical recipient/network, finite budgets and ambiguous-settlement no-retry behavior. No real payment test or additional paying schedule.
- Existing user's instruction covers fixing and releasing the verified deficiencies. Provider authentication barriers are reported only after a concrete tested artifact is ready; do not weaken authentication.
- Evidence separates synthetic payment tests, live unsigned checks, actual upstream calls and real historic/scheduled settlements.
- Third-party missing data remains explicitly partial. Improve demonstrable code defects; never invent a safety result or token price.

## Task MCP-RELEASE — packaged consumer behavior

Owner: mcp implementer. Reviewer: root; final reviewer independent. Files: `mcp/`, `scripts/mcp-package-smoke.mjs`, new `scripts/mcp-package-*.mjs`, `.github/workflows/publish-mcp.yml`, dedicated package tests. No shared root lock/package edits without root coordination.

- [x] Reproduce old 0.13.0 discrepancy using audit evidence and inspect current package source.
- [x] Bump to a genuinely new version 0.14.0 consistently in package, lock, server metadata and generated handshake version; document upgrade and minimum corrected version.
- [x] Make smoke install the actual packed tarball with its own freshly resolved dependencies outside ancestor node_modules. Check no-key startup, 23 tools, version, live-quote fixture and budget.
- [x] Exercise actual stdio process with offline fixtures for budget zero, mismatched recipient, endpoint overcharge, timeout and cancellation; prove no signed retry on rejection. Ephemeral unfunded key only, no external payment/network.
- [x] Make publishing consume the verified immutable tarball, check tag/version and verify the public installed artifact after release; retain secure existing npm authentication.
- [ ] Provide changed-file list and fresh commands/results; root performs registry publication and final npx verification.

## Task PAYMENT-DIAGNOSTICS — identifiable failures and aborts

Owner: payment implementer. Reviewer: root; final reviewer independent. Files: `src/app.ts`, `src/telemetry.ts`, `src/request-context.ts`, `src/operations-report.ts`, related API/payment/request/report tests, new payment-telemetry helper if needed. Do not edit root OPERATIONS.md.

- [x] Inspect installed SDK hooks/types and reproduce decode, requirement mismatch, verify decline, settlement decline/unknown and aborted response behaviors before changes.
- [x] Log bounded protocol/header generation, stage, allowlisted reason, facilitator attempt count/duration, sanitized client name/version, verified payer and successful transaction receipt where available. Distinguish claimed/unverified identity by omitting it.
- [x] Emit exactly one terminal record for finish or early close, including abort reason/outcome; preserve old report compatibility and current settlement-unknown protections.
- [x] Return explicit safe migration guidance for unsupported legacy X-PAYMENT/v1 submissions without silently accepting unverifiable data, while preserving unsigned v2 quotes and valid v2 payments.
- [x] Test all meaningful paths with fake facilitator/real middleware, malformed and sensitive fields, duplicate terminal events and cancellation races. Update offline operations summary for the new evidence.
- [x] Provide the exact schema and field semantics for root's operations documentation; no live edits or new paid calls.

## Task DATA-QUALITY — recoverable coverage gaps

Owner: data implementer. Reviewer: root; final reviewer independent. Files: `src/services/safety.ts`, `src/services/history.ts`, `src/services/scout.ts`, `src/services/prices.ts`, associated tests. Coordinate before touching shared sources/cache.

- [x] Investigate USDC safety Blockscout/RPC eight-second partial fallback and scorecard 5/26 token-price coverage using audit raw evidence and current provider behavior.
- [x] Reproduce concrete own-code omissions; implement bounded independent-provider fallbacks or corrected extraction only where supported by authoritative provider data.
- [x] Preserve honest missing/partial/error semantics, avoid safety inflation, and remain within the total request deadline.
- [x] Add regressions for provider failure and partially priced/checked results; compare live read-only service coverage before/after if feasible.
- [x] Return remaining external limits and exact live/synthetic evidence. Do not change payment settings, schedules or schemas incompatibly.

## Task SITE-OPS — onboarding, freshness and release guardrails

Owner: root. Reviewer: independent final reviewer. Files: `public/index.html`, `public/app.js`, public docs/discovery, `README.md`, `OPERATIONS.md`, `src/operations-check.ts`, associated tests, `src/services/basename.ts`, integration/generation scripts as needed.

- [x] Fix author CSS overriding the hidden Pay button and verify quote-to-pay visibility through the actual browser without connecting a wallet.
- [x] Align all install instructions with the corrected MCP version, document x402 v2 header and opaque watch cursor; keep any external directory inaccuracies recorded with canonical guidance.
- [x] Add actual snapshot age/completeness and live data-quality signals to existing unsigned operations checks. Detect delayed GitHub jobs without adding a paid schedule or falsely counting monitor traffic as users.
- [x] Include previously uninstrumented Basename network work in existing counters if an appropriate shared mechanism exists.
- [x] Run baseline and final offline suite, all typechecks, generated checks, API/web/MCP builds, independent package smoke, dependency audits and deployment-controller tests.
- [ ] Independently review final code/artifact. Commit only this task's reviewed files, update main without force, let existing successful-CI gate stage/verify/promote production; publish MCP via the verified workflow/tag.
- [ ] Verify registry tarball/version/23 tools/no-key mode, live unsigned API/proxy checks, browser flow, fresh safe diagnostics and exact running revision. Record prior release for rollback.
- [ ] Write `docs/remediation/2026-09-14/REPORT.md` with each finding's disposition, tests, deployed/published identities and any real external block. Final reviewer must not have authored production changes.

## Explicit evidence limit

The historical first missed calls from wallets 89c/c9 cannot be reconstructed from missing historical client/facilitator records. Correcting telemetry improves future diagnosis; no implementation may claim it recovered those records or guarantees wallet retention.
