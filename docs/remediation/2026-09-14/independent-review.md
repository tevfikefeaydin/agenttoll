# Independent implementation review — 14 September 2026

Reviewer: `/root/final_review`, independent of all implementation/evidence authors. Workspace: `D:/Çalışma Alanı/01_Projeler/_Worktrees/agenttoll-remediation-20260914`; baseline: `d7d0336`. The implementation plan and component reports were read. The reviewer changed no production source, committed/pushed nothing, published nothing and made no real payment.

**Decision: GO for release of the reviewed source and CI candidate after one minor correction. No unresolved material finding in this scope.** The incremental review below also covers the completed Registry publication path and final operator/product documentation. Actual deployment, npm/Registry publication, installed monitoring and the complete live product still require their own evidence.

## Scope

- MCP-RELEASE: `mcp/`, `scripts/mcp-package-smoke.mjs`, new consumer/fixture scripts, package regression tests and `.github/workflows/publish-mcp.yml`.
- DATA-QUALITY: `src/services/history.ts`, `src/services/safety.ts`, their regression tests, and saved before/provider/after observations.
- Scope subsequently extended by root to PAYMENT-DIAGNOSTICS: `src/app.ts`, `src/payment-telemetry.ts`, `src/telemetry.ts`, `src/request-context.ts`, `src/operations-report.ts` and related tests.
- Completed SITE-OPS code subsequently reviewed: hidden-button CSS/early guard, Basename cancellation/instrumentation, `src/operations-data.ts`, `scripts/ops-data.mjs`, the package script, `deploy/hetzner/monitor.py` and its service/timer/tests. Root retains actual browser, full integration, documentation and release verification.

## Finding found and resolved

**IR-01 — minor, corrected: malformed snapshot token could break valid scorecard data.**

The new fallback at `src/services/history.ts:154` called `p.token.toLowerCase()` after a truthiness check. The existing scorecard loop had already classified a numeric `token: 123` as missing, but the later fallback revisited that row and threw `TypeError: p.token.toLowerCase is not a function`. Thus one malformed historical row discarded an otherwise valid scorecard response.

The reviewer reproduced this independently with a valid snapshot row plus `token: 123`; all fetches were replaced by in-memory GitHub/snapshot/DexScreener responses. No network or provider was involved. The data owner added string guards both to fallback selection and to snapshot/pool matching (`history.ts:154,179`) and two regressions beginning at `tests/history.test.ts:230`.

The reviewer reran the original independent reproduction after the correction: one valid row remained and `poolsWithoutToken` was 1, with no exception. The updated history/safety/prices suite passed 55 tests, zero failures. The correction is accepted.

## Fresh independent verification

Every PowerShell session running builds/tests/Python initialized `D:/Çalışma Alanı/01_Projeler/Use-ProjectEnvironment.ps1` from this worktree first.

| Command/check | Reviewer-observed result |
|---|---|
| `node --import tsx --test tests/mcp-package.test.ts tests/mcp-package-release.test.ts tests/payment.test.ts tests/history.test.ts tests/safety.test.ts tests/prices.test.ts` | Initial combined run: 79 passed, zero failures. IR-01 was found afterward with the separate adversarial fixture, so this initial pass alone was not treated as sufficient. |
| `node --import tsx --test tests/history.test.ts tests/safety.test.ts tests/prices.test.ts` | After IR-01 correction: 55 passed, zero failures; includes the two new malformed-snapshot regressions. |
| `npm run smoke:mcp -- --tarball docs/remediation/2026-09-14/mcp-artifact/agenttoll-mcp.tgz` | Installed the retained archive into a new temporary project with no ancestor `node_modules`; all seven real stdio cases passed. This independently reran the consumer behavior rather than merely checking the producer's JSON. |
| `npm run typecheck --prefix mcp` | Exit 0. |
| `npm run smoke:mcp -- --verify-artifact docs/remediation/2026-09-14/mcp-artifact` | Exit 0; retained archive integrity unchanged. The release regression also rejected changed bytes and a mismatched tag. |
| `node --import tsx --test tests/payment-diagnostics.test.ts tests/api-payment.test.ts tests/operations-api.test.ts tests/request-context.test.ts tests/operations-report.test.ts tests/operations-data.test.ts tests/basename.test.ts` | 62 passed, zero failures, including real local Express/x402 middleware with fake facilitator responses, disconnect races, log redaction, data monitoring and Basename cancellation. |
| `python -m unittest discover -s deploy/hetzner -p test_monitor.py -v` | 3 passed. Validates active-container selection, malformed state/output rejection and exclusion of raw subprocess diagnostics. Docker was mocked; this is not evidence of installed systemd operation. |
| Scoped `git diff --check` | Exit 0. |

These run counts overlap and must not be summed into a unique-test total.

The independent consumer verification finished at `2026-09-14T16:22:09.990Z`. Its freshly resolved dependencies were MCP SDK 1.30.0, x402 core/evm/fetch 2.25.0 and viem 2.56.5. Every case exposed 23 tools and version 0.14.0. Keyless quote/budget inspection worked. Zero budget, recipient mismatch, 100x overcharge, timeout and cancellation each produced **zero signed retries** and no spent/reserved budget. Timeout completed in 127 ms and cancellation in 30 ms; the deliberately late quotes remained aborted. The normal synthetic case produced one intercepted retry and 0.001 USDC of in-memory fixture accounting.

Independently checked archive:

```text
agenttoll-mcp@0.14.0
sha512-Z2iq14geGkMjMMbwr+0SIQyW+4Xzw2sS5t9PohjkAXVJdO6rrFUSbgENZM1bbTNLGWlQernx2wULdvgmH0VhjA==
```

## Substantive review conclusions

**Packaging and payment controls.** Version/package/lock/handshake metadata agree. The release workflow builds and packs once, tests the real archive with an independently resolved consumer dependency tree, verifies its hash immediately before publishing that same archive with lifecycle scripts disabled, and subsequently compares explicit public-registry bytes before rerunning the consumer scenarios. It retains existing authentication. The runtime fixture replaces fetch entirely, prohibits socket connections, permits only the synthetic origin, and retains event type/client/abort information rather than key, signature or authorization data. Runtime subprocess environments are an allowlist without inherited payment credentials. This closes the original source-versus-published-artifact test gap; successful publication remains a separate pending action.

**Price/safety truthfulness.** The fallback accepts only requested Base pools whose provider pool identity and token relationship match a recorded snapshot. It extracts base and quote token prices separately, keeps complete primary observations, bounds the additional work to four parallel batches of at most 30 pools and four seconds each, performs no new retries, and honors caller cancellation. Missing liquidity remains unknown; explicit low observed liquidity is distinguished from absence and receives no computed return or median contribution. Source and selected pool are exposed. The saved before/after cohort is pinned to `d7d03360514aaabd5b004698f926b7c29f0e1b0b`; the after observation has 11 priced and 15 low-observed-liquidity rows, not 26 priced winners/losses. `complete:false` remains. Safety avoids the redundant keyed explorer retry and now labels missing fallback RPC fields as partial; the USDC example still has only five of eight checks complete and a caution verdict.

**Diagnostics and delivery semantics.** The new records separate parse/match/verify/handler/settle boundaries, header generation, bounded decline reasons and terminal abort/finish. Only successful SDK-validated facilitator results may supply a format-checked public payer/transaction; claimed authorization identity and arbitrary errors are omitted. Successful settlement and successful delivery remain separate: aborted settlement waits remain unknown, late completions cannot rewrite emitted evidence, and no retry is introduced. The request record is emitted once. The narrowly scoped suppression matches the actual installed SDK's extension-response diagnostic and preserves unrelated logs; its version dependency is explicitly documented. The report accepts old rows and validates new enums/counters without exporting client/payer identities or inventing historical causes.

**Completed operations code.** The hidden attribute now overrides author display CSS, and prerequisite checking precedes loading the wallet library. Basename counts actual RPC attempts and respects caller cancellation. Data monitoring distinguishes freshness, partial coverage and unavailability, checks summary/row consistency, and bounds hung loaders. The hourly host monitor invokes only the active validated AgentToll container with an argument array, uses the zero-budget/no-signer unsigned checker plus direct provider reads, preserves partial coverage and writes the latest report atomically with restrictive permissions. It adds no paying schedule. The Python/unit evidence cannot replace a post-install Linux/systemd invocation.

## Explicit acceptance limits / next review

No live facilitator settlement, real wallet signing, npm publication, MCP Registry publication, application deployment or monitor installation was performed by this reviewer. Registry-byte equality after publication is still to be observed. Provider availability, freshness and disagreement can change; saved before/after observations are not a controlled latency or market-data-accuracy benchmark. The global request deadline bounds total work; the four-batch cap applies to the new fallback, not all pre-existing snapshot/primary-provider work. The direct data check does not validate the payment gate, and synthetic payment accounting does not establish onchain settlement. Historical missing client/facilitator records remain unrecoverable by these fixes.

Root's actual browser flow, release identities, public consumer verification and installed monitoring evidence remain separate from this reviewer's local execution. The final documentation and saved integrated-check evidence were subsequently inspected below. Any subsequent source change in this reviewed scope needs corresponding reinspection; this component acceptance does not silently cover changed code.

## Incremental final review: Registry publication, documentation and monitor

The additional reviewed scope is `scripts/mcp-registry-publish.mjs`, `tests/mcp-registry.test.ts`, `.github/workflows/publish-mcp-registry.yml`, the dependent job in `publish-mcp.yml`, `.github/workflows/README-mcp-registry.md`, final `OPERATIONS.md` and Hetzner runbook changes, product installation/privacy/terms text, consistency checks, and the initial remediation `REPORT.md`. The production monitor implementation and service/timer were reinspected. No production implementation was edited by this reviewer.

**Registry release path: accepted.** The dependent workflow runs only after the npm job, including public byte comparison and consumer testing, succeeds. The reusable/manual Registry job checks out a strict canonical release tag and retests the already public package. It does not republish npm. The client verifies canonical repository/namespace/version, retained archive integrity and public npm metadata before requesting credentials. Its OIDC URL allowlist, audience, redirect rejection and per-request deadlines are explicit. Tokens remain in memory and are absent from returned evidence and bounded error messages.

The pre-write exact-version lookup makes an identical active record a read-only success and rejects a conflict. There is one publish attempt; subsequent automatic polling is read-only. Public acceptance checks the complete tagged server definition and active state, normalizing only omitted false environment-variable flags from the official model. This is a bounded publication check, not a claim that the Registry has accepted this release already.

The reviewer freshly ran `node --import tsx --test tests/mcp-registry.test.ts`: **22 passed, zero failures**; `node --check scripts/mcp-registry-publish.mjs` passed. The cases exercise credential ordering, tag/identity/integrity rejection, conflicting records, secret-flag changes, omitted false flags, sanitization, one-write behavior and delayed visibility. These calls use synthetic API responses; no OIDC credential was requested or Registry write made. The reviewer independently fetched the [live official OpenAPI schema](https://registry.modelcontextprotocol.io/openapi.json) read-only and confirmed the used `/v0.1/auth/github-oidc`, `/v0.1/publish` and `/v0.1/servers/{serverName}/versions/{version}` routes. The schema also exposes the `/v0` aliases used by the [official publisher](https://github.com/modelcontextprotocol/registry/blob/main/cmd/publisher/auth/github-oidc.go); that version difference is not a release defect.

**Final monitor and documentation: accepted within the stated operating scope.** The Python monitor's three tests passed again. The runbook requires the new application release before separately installing the host files, documents the 85-second host deadline, 25-second data deadline, hourly UTC schedule, atomic restricted report and service failure for unavailable/stale data. Recoverable individual-provider errors and partial coverage are distinguished from a failed complete check. No paid request, notification or new paying schedule is introduced. Actual Linux/systemd installation remains untested by this reviewer.

Installation examples consistently pin MCP 0.14.0 and explain upgrade/restart and v2 migration. Privacy/operations descriptions distinguish self-reported client version from identity and successful facilitator-validated public payment identifiers from unverified payloads or independent chain verification. Terms distinguish handler failure before settlement from delivery failure after settlement; data caveats retain partial coverage and route-specific cache limits. This is engineering consistency review, not legal certification.

The initial consolidated report explicitly leaves npm/Registry publication, Hetzner rollout and first monitor execution pending. Its saved full-suite output records **271 passed, zero failures/skips**, with 29,510 ms duration; deployment output records **30 Python tests passed**. The saved typecheck output covers API, web, MCP and tests. Both dependency audit JSON files report zero advisories at capture time. The saved data report confirms `ok:true`, `degraded:true`, 11 priced / 15 low-observed-liquidity / 0 unavailable tokens and safety 5/8. All **13 local report links exist**. These are independent artifact checks of root's combined runs, not a claim that this reviewer reran all 271 tests. Final `git diff --check` passed.

**Go/no-go boundary:** GO for the reviewed release candidate and its CI publication/rollout procedure. No remaining blocker was found in the reviewed code or final documentation. Successful GitHub OIDC/ownership acceptance, explicit public npm byte equality and consumer behavior, active Registry record, deployed source/image identity, live unsigned checks and installed monitor output must still be observed before claiming the remediation is live. No real settlement was exercised, and historical customer-cause uncertainty remains unchanged.
