# AgentToll audit fixes implementation plan

> Agentic workers: use test-driven development for behavioral fixes and independent task review. Parallel dispatch is limited to the disjoint file ownership below.

**Goal:** Resolve all twelve findings and the concrete maintenance defects in PROJECT_REVIEW_2026-09-08.md, preserving the existing API and payment model.

**Architecture:** Keep Express, TypeScript and the existing service modules. Use one endpoint registry for prices and generated discovery artifacts, bounded automatic payments, explicit missing data, and deterministic offline regression tests.

**Tech stack:** Node 22+, TypeScript, node:test through tsx, x402 v2, viem, Express 5.

**Spec:** PROJECT_REVIEW_2026-09-08.md; user instruction: “hepsini düzelt”. This authorizes fixes and supporting improvements, including budget inspection and quote-only operation. Broader product experiments such as a new SDK product or an entirely new fixed-horizon analytics pipeline are ideas, not defects to silently add.

## Global constraints

- Never read or print wallet secrets. Never send a real payment, publish, push or deploy as part of testing.
- Preserve existing untracked brand-out/ and the original audit record. All code changes stay on fix/audit-findings-20260908 in this workspace.
- Mock only external HTTP/RPC/payment settlement boundaries. Run meaningful failing regressions before fixing behavior; documentation changes need no artificial tests.
- Tests live in tests/*.test.ts, using node:test and node:assert/strict. Run individual files with node --import tsx --test tests/<name>.test.ts.
- All production dependency manifests/lockfiles, generated discovery artifacts and CI belong to the integration owner (/root).
- Shared playbooks are a junction, not copied files. The named link helper is absent, so the same NTFS junction was created directly.

## Task A: Safety and verified identity

Owner: safety worker. Reviewer: /root, followed by independent final reviewer.
Files: src/services/safety.ts, src/services/basename.ts; tests/safety.test.ts, tests/basename.test.ts.

- [x] Reproduce absent owner flags, one-sided tax data, null percentages, contradictory/malformed providers and false reverse names.
- [x] Validate source data at runtime, preserve unknowns, expose check coverage/source timing without falsely passing unmeasured checks.
- [x] Forward-resolve reverse names and require the original address; bound all resolver RPC timeouts/retries.
- [x] Verify fully measured clean data can still pass and genuine detected risk remains visible even with missing fields.

Acceptance examples: assert.notEqual(partial.verdict, 'clear'); assert.ok(partial.unchecked.includes('owner-powers')); assert.equal(spoofed.name, null).

## Task B: Data correctness and resumable watches

Owner: data worker. Reviewer: /root, followed by independent final reviewer.
Files: src/services/watch.ts, src/services/history.ts, src/services/prices.ts, src/services/stats.ts and corresponding tests only.

- [x] Reproduce 51-event omission, even-sized medians, missing prices, reversed USDT pairs and foreign statistics baselines.
- [x] Implement bounded, resumable wallet pagination, stable cursor ordering/deduplication and explicit incomplete coverage for radar watches. Base market data stays on mainnet independently of payment network.
- [x] Correct medians, preserve unavailable outcomes, expose cohort/snapshot coverage, pin history reads to an immutable git revision and expose provenance.
- [x] Correct USDT pair direction/24h change, label currency assumptions, validate finite positive quotes.
- [x] Validate statistics baselines against network and receiving address; keep cache entries scoped to both. Custom/testnet installations must never inherit hosted mainnet totals.
- [x] Run focused offline regressions, report compatibility changes and documentation needed.

Acceptance examples: assert.equal(new Set([...page1.events,...page2.events].map(e=>e.hash)).size,51); assert.equal(cohort.medianChangePct,50); assert.equal(customStats.tollsCollected,0).

## Task C: Bounded payment clients and browser error handling

Owner: payment worker. Reviewer: /root, followed by independent final reviewer.
Files: src/pay.ts, src/payment-policy.ts, mcp/server.ts, mcp/payment-policy.ts (generated copy), web/demo.ts, payment/browser tests. No manifest or lockfile edits.

- [x] Reproduce excessive quotes and concurrent budget oversubscription before implementing policy.
- [x] Require registered endpoint price ceilings, explicit USDC/network/recipient checks, a finite session budget and total timeout before signing. Preserve reservations for ambiguous post-signature failures.
- [x] Add no-cost MCP budget and quote tools; read MCP version from its package metadata without requiring unavailable files in the npm tarball.
- [x] Fix browser catch scope, derive network from its quote, reject unrecognized quotes and bound payment fetches.
- [x] Verify normal quotes sign, expensive/wrong-destination/wrong-network quotes never sign, concurrent calls cannot exceed the budget, and user cancellation/error paths return useful messages.

Interfaces: the integration owner supplies src/endpoint-manifest.ts and mcp/endpoint-manifest.ts, exporting ENDPOINT_MANIFEST: readonly {path:string; price:string; amount:string; tool:string}[]; paths use {parameter}, amount is integer micro-USDC. Canonical payment policy lives in src/payment-policy.ts and is copied into mcp at build/check time. Existing payingFetch(privateKey, network) remains usable with optional third configuration argument.

## Task D: API integration and test/build infrastructure

Owner: /root. Reviewer: independent final reviewer.
Files: src/app.ts, src/config.ts, src/endpoints.ts, src/endpoint-manifest.ts, src/services/cache.ts, src/services/params.ts, src/services/fresh.ts, src/services/errors.ts, src/services/gas.ts, scripts, package manifests, CI, generated surfaces and docs.

- [x] Add failing tests for CORS, normalized rate limits, configuration validation, shared cache loads and strict fundedOnly parsing.
- [x] Fix CORS v1/v2, scoped proxy trust, normalized metering/logging and structured error responses with request IDs.
- [x] Validate configuration, distinguish payment/data networks, add bounded readiness and consistent response freshness metadata.
- [x] Coalesce cache loads, preserve caller abort signals, add short gas caching and enforce request deadlines.
- [x] Build a typed endpoint registry; generate fee manifests and derive paywall/catalog/manifest/OpenAPI fields from it. Verify mappings rather than regex counts alone.
- [x] Add root, MCP and web typechecks; deterministic test command; explicit esbuild dependency; generated artifact checks; update both dependency trees and audit again.
- [x] Update security/environment/onboarding documents, MCP version/counts, frozen demo copy and snapshot integrity wording/metadata.

## Task E: Final verification and delivery

Owner: /root. Reviewer: new independent agent that did not implement any task.

- [x] Run all behavioral tests, all typechecks, builds, generated surface consistency and both production audits.
- [x] Exercise local payment middleware success/failure without real settlement and cross-origin HTTP headers plus browser payment code with fake credentials/providers.
- [x] Have independent reviewer inspect complete code and rerun representative scenarios; fix material findings and verify again.
- [x] Record each finding's resolution and evidence in a completion report. State clearly that local fixes are not a production deployment.

## Completion record — 2026-09-08

All scoped tasks are complete. See [PROJECT_FIXES_2026-09-08.md](../../../PROJECT_FIXES_2026-09-08.md) for the finding-by-finding evidence and compatibility limits. Final full suite: 148/148 passed on Node 22.23.2; API/web/MCP/examples/test typechecks, builds, generated checks and actual MCP tarball smoke passed. Root and MCP dependency audits report zero advisories. An independent reviewer reran all 148 tests, typechecks, generated checks and the 9 payment lifecycle tests, then accepted the implementation with no material findings remaining. Browser coverage uses HTTP integration and mocked wallet/DOM execution; a real wallet extension was not exercised. Changes remain local; no payment, commit, push, publication or deployment occurred.
