# Browser Research Tools Implementation Plan

> Agentic workers: use the shared collaboration playbook and scoped parallel tasks; parent integrates and obtains independent final review.

**Goal:** Implement all approved browser additions except Telegram.
**Architecture:** Browser-local report library + existing paid API calls + a new research page + a bounded fragment-based sharing page.
**Tech stack:** TypeScript, DOM, esbuild, Node test runner, existing x402/viem payment client; no new runtime dependencies.
**Spec:** `docs/superpowers/specs/2026-09-15-research-tools.md`

## Global constraints

Preserve payment validation, unknown evidence and report timestamps. Max five inspections per explicit batch. No automatic retry or Telegram. All remote/local inputs are untrusted. Keep unrelated files untouched.

## Tasks and ownership

- [x] T1 — Report model and browser storage. Agent owns `web/research-model.ts`, `web/research-store.ts`, focused tests and any agreed extraction from `web/token-report.ts`. Test missing/duplicate checks, bounded malformed storage, same cached observation, evidence loss, history limits and token matching. Publish exact interfaces before integration.
- [x] T2 — Paid workflow and portfolio parsing. Separate agent owns `web/research-payment.ts`, `web/portfolio-model.ts` and focused tests. Reuse existing `pay` and policy checks. Test exact summed quotes, obsolete terms, sequential partial completion, failed/ambiguous payments, duplicate/invalid tokens and incomplete holdings.
- [x] T3 — Sharing. Delegated to `research_sharing`; parent integrates `web/report-share.ts`, `web/shared-report.ts`, `web/shared-report.html`, `tests/report-share.test.ts`. Encode only sanitized report evidence in a bounded versioned URL fragment; validate/label unverified imported snapshots, export timestamped PNG card.
- [x] T4 — Product integration. Parent owns `web/research.ts`, `web/research.html`, inspector actions/integration and relevant CSS. Add watch/history/diffs/comparison/wallet controls, explicit budgets and receipts, good desktop/mobile behavior. Update build/check scripts and generate public assets.
- [x] T5 — Documentation and verification. Parent updates privacy, README, homepage navigation, deployment static checks if required. Run full tests/typechecks/build/generated/deployment checks and actual browser scenarios. Independent reviewer owns only its review/evidence files and must approve the final integrated product.

## Verification sequence

1. Establish clean baseline with `npm test` in the worktree.
2. Each data/payment/share task writes behavior tests first, observes a failure, implements and runs its focused tests.
3. Parent checks module interfaces before connecting UI; run web/test typechecks and regenerate built assets.
4. Browser fixture routes exercise successful paid delivery, cached data, missing evidence, reload/history, comparison, portfolio partial coverage, rejected and ambiguous payments, malformed/oversized shared URLs and storage failure without actual payment.
5. Local real browser checks at desktop and mobile sizes verify all controls, no overflow, working downloads and no browser errors. Clearly distinguish fixture runs from any live unpaid validation.
6. Full suite plus independent review; resolve concrete defects and rerun affected checks.

## Decisions

- Store up to 50 watched tokens and 100 bounded snapshots, with at most ten per token. Browser-only storage avoids adding accounts and retains the current simple payment model.
- Sharing carries user-supplied evidence in the URL fragment and labels it unverified; server authentication/storage would expand this task substantially.
- A portfolio lookup and subsequent token scans are separately reviewed purchases. Multiple existing endpoint calls require one wallet authorization each.

## Evidence

See `docs/audit/2026-09-15-research-tools/implementation.md`, `verification.json` and the independent review. Final suites pass 416 tests each on Node 22 and 24. Three-way browser storage reconciliation was added after an independently reproduced cross-tab data-loss finding; eight focused regressions cover additions, deletions, conflicts, provenance and retention.

Independent final acceptance: accepted for local delivery, no open critical/important findings; 111 focused tests and 85 browser assertions passed, plus the two-tab reproduction, keyboard/overflow and visible-network checks. All 14 reviewed source/asset hashes match.
