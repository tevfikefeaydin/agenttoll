# Browser research tools

User approved the proposed product additions, excluding Telegram, on 15 September 2026. This is an architectural extension of the existing browser inspection flow. Implementation is authorized; no new approval is needed for routine reversible design decisions.

## Product behavior

- Add a research page with a saved-token list, report history, a comparison of 2–5 tokens, and a wallet portfolio panel. Keep the existing inspector as the entry point for single-token payments and the free dated example.
- A visitor can save a token and completed reports in this browser, reopen a report, remove a token, clear stored data and re-inspect with an explicit new price/payment. Storage is bounded, versioned and resilient to malformed/blocked/quota-exceeded storage. Explain browser-only persistence, and label examples/shared reports distinctly.
- Show changes between dated observations of the same token, including evidence becoming unavailable. Never describe lost evidence as an improvement or claim unchanged findings imply safety. A repeated cached observation is not a fresh check.
- Comparison shows eight named checks and coverage, dates and provenance per token. Missing reports/checks are unassessed. No investment ranking or invented safety score.
- Wallet lookup uses the existing paid portfolio endpoint. Show discovered holdings, unpriced/hidden/truncated/degraded coverage and time; do not claim all holdings were found. Allow selecting up to five ERC20 tokens for the existing paid safety endpoint. Quote lookup and inspections separately; no automatic purchases after the portfolio lookup.
- Before a multi-token inspection show the exact summed USDC quote, network and number of wallet authorizations. Process sequentially; retain completed results and receipts, stop after rejection/failure/uncertain outcome, never silently retry. No new API or price changes.
- Share a bounded sanitized report snapshot via URL fragment, excluding payment/wallet metadata, and export a legible PNG card. Shared snapshots are explicitly user-supplied and unverified; keep original observation dates, coverage and unknowns. Opening a shared URL does not pay or save automatically. Oversized/invalid fragments fail visibly. No server-side public report database is introduced.
- Telegram, background monitoring, notifications, accounts and subscriptions are outside scope.

## Visual design

Preserve the existing brand: navy #070B14, surfaces #0E1524/#131C2E, white #EAF0FA, Base blue #0052FF, amber #F1C574 for gaps and warnings. Use Segoe UI/system sans and monospace for addresses. Research uses a saved-token sidebar and a flexible report/comparison area; wallet holdings use a readable table. Mobile stacks panels with contained horizontal comparison scrolling. Keyboard focus, status announcements and explicit empty/error/loading states are required.

## Boundaries and acceptance

- No private keys, signatures or wallet account permissions stored or shared. All dynamic provider/local/shared text is escaped and bounded.
- Existing quote/recipient/chain validation, uncertain-payment safeguards, static sample and JSON download continue working.
- Meaningful model/storage/payment/share regressions, full existing tests, all typechecks/build/generated checks and actual desktop/mobile browser verification must pass. An independent reviewer must inspect the integrated final product.
- Existing unrelated reports and deployment notes in the original checkout remain untouched. Work is isolated in `.worktrees/research-tools` on `feat/research-tools`.
