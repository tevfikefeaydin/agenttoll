# Browser research tools — implementation and verification

## Delivered behavior

The approved five additions are implemented on `feat/research-tools`, based on `942595c`. This record describes local acceptance; this feature has not been published to GitHub main or production.

| Addition | User-visible behavior |
| --- | --- |
| Watchlist and history | My research saves tokens and dated reports in this browser. Reports can be reopened, removed, or cleared. The inspector has an explicit save preference. |
| What changed? | Compares observations of the same token and origin, including lost evidence. Cached observations, missing dates and same-time conflicts remain explicit. |
| Wallet holdings | Separately prices a holdings lookup, shows provider coverage and unpriced/missing holdings, then lets the visitor inspect up to five selected ERC20 tokens. |
| Token comparison | Two to five tokens, all eight checks, evidence coverage, observation dates and report origin. Missing evidence is unassessed. |
| Sharing | Sanitized snapshot link and 1200×1200 PNG card. Shared snapshots are unverified, keep original dates, and exclude payment/wallet metadata. |

Entry points: `/research.html`, the new My research navigation, inspector report actions, and `/shared-report.html#report=...` links. Telegram and other notification services are excluded.

## Implementation boundaries

- Reuses existing portfolio/safety endpoints and payment client. Each call has its own authorization. The reviewed total and network are visible before purchase; quotes expire after 60 seconds. A failed or uncertain step stops the batch and retains completed payloads/receipts. Uncertain outcomes require acknowledgement; a fresh remaining batch excludes received calls.
- Versioned local storage retains up to 50 watched tokens and 100 reports, at most ten per token, within a conservative 2 MB limit. Failed writes preserve prior disk data and keep changes in page memory. Storage reconciliation replays page-only edits onto the latest observed disk state, respecting other tabs' removals. This is browser-local storage, not an account or cross-device synchronization service.
- Canonical report sanitization bounds input and recomputes coverage. Examples, inspections and shared snapshots remain different origins. Sharing is limited to 15,000 UTF-8 payload bytes / 20,000 encoded characters; a shared report is not a server-authenticated record.
- Existing CSP is preserved. Shared CSS sources are inlined into generated HTML at build time. New static assets are included in the deployment verifier (32 proxy/static checks).
- No runtime dependencies, API fees, MCP version or payment recipient were changed.

## Verification

- Node 22.23.2 and Node 24.13.0: **416 tests passed on each**, no failures.
- API, browser, MCP and test typechecks: passed.
- API/browser and standalone MCP builds: passed. Generated metadata and browser assets match source.
- Deployment controller/monitor regressions: **30 passed**.
- Actual MCP tarball installed into a separate temporary consumer: seven offline payment-policy scenarios passed, 23 tools exposed. This used ephemeral unfunded fixture keys and no real settlement.
- Application and MCP dependency audits: **zero reported vulnerabilities** at verification time.
- `git diff --check`: passed.
- Local Chromium browser fixture uses the production CSP and fake EIP-1193 authorizations. Core flows: **27 assertions**. Wallet/partial-payment flows: **24 assertions**. Storage, rejection, malformed delivery/link and UI edge cases: **22 assertions**. Independent acceptance and additional adversarial checks are recorded in [independent-review.md](independent-review.md).
- PNG card and desktop/mobile screenshots were visually inspected. Report card is 1200×1200; mobile width is 390 px with contained comparison scrolling. No uncaught application JavaScript errors were observed. Expected unsigned HTTP 402 responses and blocked local Kaspersky script injection appear in console logs; application styles/scripts loaded under the original CSP.
- One unsigned live portfolio quote and agent-card read confirmed the production network/recipient/origin and exact query-specific resource URL. Paid delivery tests are fixture tests, not live payment evidence. No real payment was made.

Local reproducible browser scripts, fixture server, logs and screenshots are retained under `output/playwright/research/` in the feature worktree. These are ignored test artifacts. Durable source regressions are in the five new `tests/*research*`, `tests/portfolio-model.test.ts` and `tests/report-share.test.ts` files.

## Review corrections

1. Wallet evidence table lacked its scroll container: page overflow at 390 px. Added the container and independently verified five-token selection.
2. Replacing holdings DOM on checkbox changes lost keyboard focus. Selection now updates its own result region; Space and Tab retain the expected focus.
3. Payment completion could replace changes saved from another browser tab. Added a three-way reconciliation helper with eight regressions and deferred storage refresh; independent two-tab reproduction now retains the other tab's token.
4. Payment network was inside collapsed details. It is now visible beside the total before purchase.

## Remaining product limits

Reports and wallet discovery depend on upstream coverage; no safety guarantee or complete portfolio claim is made. Observations may be cached. Shared URLs carry editable user-supplied evidence. Browser data is removed when site storage is cleared. Multi-call inspection requires multiple wallet confirmations and may need a new quote if approvals take longer than one minute.
