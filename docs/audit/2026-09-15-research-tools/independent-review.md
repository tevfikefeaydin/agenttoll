# Independent research-tools review

Reviewer: `/root/research_review`, a separate agent that has made no product-code changes.

Scope: working changes and added files in `feat/research-tools`, based on `942595c`, against the approved specification and plan dated 2026-09-15. Product checks use the local fixture origin `http://127.0.0.1:4321`. No real chain transaction or external payment provider was used.

## Final assessment — 2026-09-15

**Accepted for local delivery.** No open critical or important findings remain in the reviewed final product. All three important findings below were reproduced, fixed by the implementation owners, and independently retested. The visible payment-network improvement was also verified. The implementation stays within the approved scope.

## Strengths

- Quotes are bound to the API origin, recipient, Base payment network, exact endpoint/query and exact micro-USDC amounts. Batch objects are immutable, expire, and are single-use. The existing production `pay` implementation is reused.
- Sequential batches keep delivered payloads and receipt metadata before the UI parses a response, stop after failures, and block subsequent purchases after an ambiguous outcome until explicit acknowledgement.
- Canonical evidence has bounded strings/arrays and known check IDs. Coverage and verdicts are recomputed; duplicate/malformed/incomplete checks cannot silently become complete passes. Wallet and token responses must match the requested address.
- History keeps observation dates and provenance, distinguishes same-time conflicts from fresh checks, and identifies evidence loss. Shared fragments whitelist evidence, omit wallet/payment fields, bound payload size, and label imported snapshots as unverified.

## Findings

### Important — fixed: another tab's saved research was overwritten during payment

- References at first reproduction: `web/research.ts:51`, `web/research.ts:297`, `web/research-store.ts:163`.
- The storage event handler drops events while `payments.busy`. The delivered-report path later saves from its stale in-memory `library`. `writeResearchStore` reads the latest stored value only as a validity guard, then replaces it with that stale library.
- Independent reproduction: tab A starts a two-token purchase. A page-local route holds the first signed response. Tab B saves watched token `0x7777777777777777777777777777777777777777` through the actual Save control. Release A's response and let both reports complete. The saved token from B disappears from localStorage.
- Measured localStorage watchlist before A resumes: `[0x777…777]`; after both A deliveries: `[0x222…222, 0x333…333]`. `missingOtherTabToken: true`.
- Reproduction artifact: `output/playwright/research/independent-storage-race.js`; isolated browser session `research-independent`.
- The final implementation adds three-way reconciliation against the last observed disk baseline and processes deferred storage updates. It preserves pending page-only additions and respects remote removals; eight new regression cases cover these rules and retention limits.
- Final independent rerun: before `[0x777…777]`; after `[0x333…333, 0x222…222, 0x777…777]`; `missingOtherTabToken: false`. Both purchased reports complete and the second tab's saved token remains.
- Final evidence: `output/playwright/research/independent-storage-race-fixed.log`.

### Important — fixed: wallet comparisons overflow the mobile page

- Reference: `web/research.html:54`, the `wallet-risk-results` container.
- Before the fix, two selected holdings at 390×844 produced `document.documentElement.scrollWidth = 505` for `innerWidth = 390` because the table lacked its horizontal scroll container.
- The parent added `comparison-wrap`. Independent rerun with five selected tokens produced page width 390; the evidence table scrolls inside its own container.
- Evidence: `output/playwright/research/independent-wallet-overflow-before.png` and `output/playwright/research/independent-wallet-mobile-fixed.png`. Both screenshots were visually inspected.

### Important — fixed: selecting a holding loses keyboard focus

- Reference at first reproduction: `web/research.ts:215`.
- Rebuilding the whole holdings table removed the focused checkbox. Space on the third checkbox moved focus to BODY; the next Tab restarted at the first holding.
- The parent split selection rendering from holdings rendering. Independent keyboard rerun keeps focus on the third checkbox after Space and moves to the fourth after Tab.
- Evidence: `output/playwright/research/independent-wallet-verify.js`.

### Minor — fixed: the payment network was hidden in collapsed details

- Reference: `web/research.html:57`.
- The network now appears beside the purchase total. Independent mobile verification observed `Pay with USDC on Base mainnet.` and `0.006` before payment, with Payment details still collapsed.
- Evidence: `output/playwright/research/independent-final-network.log` and `independent-final-purchase-mobile.png`.

## Independent final verification

- Read the approved specification, plan, and shared `playbooks/agent-isbirligi.md`.
- Reviewed new report model, storage, payment coordinator, portfolio parser, sharing module, research UI, inspector integration, shared page, CSS/build integration, and their focused tests.
- Ran all five focused Node test files again on the final source: **111 passed, 0 failed**. This includes the actual default `pay` implementation with an offline EIP-1193 provider. Evidence: `output/playwright/research/independent-final-unit.log`.
- Re-executed the integrated UI scenarios in a separate Chromium session after final integration. The core/wallet/edge scripts were copied from the implementation's scenario scripts, with separate evidence filenames; they were independently executed and their returned results inspected.

| Final browser checks | Observed result | Evidence under `output/playwright/research/` |
| --- | --- | --- |
| Example, watchlist, reload/history, dated tax change, comparison, inspector, sharing, PNG, desktop/mobile | 27/27 assertions; no uncaught page JavaScript errors | `independent-final-core.js`, `independent-final-history-desktop.png`, `independent-final-compare-desktop.png`, `independent-final-history-mobile.png`, `independent-final-report-card.png` |
| Separate portfolio lookup, partial coverage, selection, sequential payment, second-step failure, retained receipt, blocked retry and remaining-only resumption | 24/24 assertions; no uncaught page JavaScript errors | `independent-final-wallet.log`, `independent-final-wallet-mobile.png`, `independent-final-partial-payment-desktop.png` |
| Save opt-out, quota failure, clipboard fallback, clear/cancel, keyboard tabs, invalidated quote, rejected signature, wrong-token delivery, oversized link and mobile home navigation | 22/22 assertions; no uncaught page JavaScript errors | `independent-final-edge.log`, `independent-final-home-mobile.png` |
| Adversarial shared text, metadata exclusion, preserved date, unchanged storage, mobile layout, shared PNG and oversized fragment | 12/12 assertions | `independent-shared-final.log`, `independent-shared-mobile.png`, `independent-shared-card.png` |
| Cross-tab update while a signed delivery is pending | Other tab's token and both delivered reports retained | `independent-storage-race-fixed.log` |
| Five-token mobile selection and keyboard progression | Page width 390; table scroll contained; Space retains focus, Tab reaches next checkbox | `independent-wallet-verify.js`, `independent-wallet-mobile-fixed.png` |
| Purchase network visible before authorization | Base mainnet displayed beside exact `0.006` total | `independent-final-network.log`, `independent-final-purchase-mobile.png` |

Visually inspected the recorded before/after mobile defect, final desktop history/comparison/partial-payment layouts, mobile purchase panel, and shared/inspection PNG cards. Original observation dates, coverage gaps, provenance and partial-completion state remain legible. Expected HTTP 402/504 fixture responses appear in console output; the final scenario runs observed no uncaught application JavaScript errors.

The final integration verification record in [implementation.md](implementation.md) was also read. It records the implementation owner's Node 22.23.2 and Node 24.13.0 full-suite results (416/416 each), typechecks, generated checks, deployment tests and MCP package checks. Those broader checks are owner-produced evidence; the executions listed above are this reviewer's independent evidence.

## Reviewed asset identity

Independently recomputed all 14 newline-normalized SHA-256 values in [verification.json](verification.json): **14/14 match the final source and generated assets**. The comparison includes all new TypeScript modules, inspector integration and the three generated browser entries. Evidence: `output/playwright/research/independent-source-hashes.json`.

Final generated assets inspected in this review (raw file-byte SHA-256; HTML line-ending normalization produces the manifest's separate normalized value):

| Asset | Hash |
| --- | --- |
| `public/research.js` | `E03B1651398280CF002764307F5C3D09BA662750D5CF59D1D07ECBF09DCDD83F` |
| `public/research.html` | `69920B7EA3DD1FC8D049B0C02B71628987F42B36188EF6B8132CF34FB8A2A89B` |
| `public/inspect.js` | `B91A28BB3B24768CDF27A397C2365B87CEFE940B66D0D60F448529C5BC633F02` |
| `public/shared-report.js` | `283BD97C5ECD4BE137B904B78448493C2AB80AE09D3BC7DD97137F61C74E692C` |

This acceptance covers the final local implementation and controlled fixture behavior. Actual provider discovery/settlement remains outside the independent fixture evidence.
