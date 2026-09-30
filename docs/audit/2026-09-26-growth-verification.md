# Research growth verification — 2026-09-26

## Final follow-up audit

User requested one further check after delivery. Fixed impossible UTC dates
being accepted by the archive (for example February 30), and made switching
research tabs cancel an in-flight quote. Controls recover after asynchronous
cancellation; a quote arriving late cannot reopen a purchase in another tab.

Added an archive date regression and a Python collector integration test using
the real Node adapter across two collection runs. The archive keeps one copy
of overlapping requests and excludes the synthetic secret field. Temporary
Playwright MCP outputs are now ignored by Git.

Final checks: **445/445 application tests**, **36/36 deployment tests**, all
four typechecks, application/web build, generated consistency and whitespace
checks passed. A browser check with a 2.5-second delayed identity response
confirmed cancellation, enabled tabs and a successful fresh quote afterward,
with zero wallet calls or signed requests. The local fixture was stopped.
No additional deployment, timer activation or real payment was performed.

## Delivered locally

- Private bounded usage archive, host collector and installable five-minute
  systemd schedule; overlapping records and receipts are deduplicated.
- Separately quoted pool discovery, inspection links and watchlist actions.
- Dated saved-inspection digest with missing evidence and conflicting dates.
- User-downloaded calendar reminder and a five-participant pilot protocol.
- Updated homepage, privacy notice and archive installation/rollback runbook.

Changes remain in the working tree on `feat/research-growth-20260926`.
No production deployment, timer activation, real payment or participant contact
was performed. Existing unrelated local changes were preserved.

## First verification

- Full application suite: 441 passed before independent-review fixes.
- Python deployment suite: 35 passed, including collector stderr regression.
- API, web, MCP and test typechecks: passed.
- Application/web and MCP builds: passed.
- Generated files, endpoint policy and OpenAPI consistency: passed.
- Both npm dependency audits: zero reported vulnerabilities.
- MCP packed-artifact smoke: seven cases passed, 23 tools exposed per case.
  Used isolated `C:\tmp` because the default Windows temporary directory had
  an ancestor `node_modules`; fresh dependencies were installed from npm.

## Second verification and fixes

Independent read-only reviewer found three issues, each reproduced with a
failing regression and fixed:

1. Successful unsigned health probes could fill the usage archive. They are
   now omitted; 40,000 probes followed by a payment retain only that payment.
2. Coverage began at collection start while totals included older imported
   observations. `retainedSince` now uses the first dated included request;
   `collectionStartedAt` separately describes when collection began.
3. Partial provider evidence becoming unavailable was labelled unchanged.
   The digest now marks partial-to-unavailable or missing source status as loss.

The parent also reproduced and fixed Docker stderr loss: successful `docker
logs` includes both streams; other command diagnostics remain discarded.

After fixes: all 444 application tests and all typechecks passed. The 15 focused
growth/archive tests passed. Build and generated consistency checks passed.
The independent reviewer rechecked all three fixes and the installation docs,
ran the focused tests, and reported no remaining blockers.

## Local browser acceptance

Used `docs/research/growth-browser-fixture.mjs` on loopback with an unfunded
ephemeral test account and synthetic responses; no chain settlement occurred.

- Discovery quote displayed 0.003 test USDC with zero wallet calls or signed
  requests before clicking Pay.
- Explicit test purchase delivered two pools. Only the attributed token had
  inspection/save actions; a missing token address remained unavailable.
- An HTML-looking pool name rendered as text, with zero injected images.
- Save survived reload and the digest correctly reported no saved inspections.
- Calendar download produced `agenttoll-research-reminder.ics`.
- Cancelling a quote and downloading a reminder added no wallet calls or
  signed requests. Changing tabs invalidated the visible quote.
- At 390 × 844, watchlist and discovery had no horizontal document overflow.
- Browser console contained expected HTTP 402 quote entries; no observed
  application runtime exception.

## Existing live service baseline

At 2026-09-26 20:00:42 UTC, `npm run ops:check` passed all 24 checks:
health, readiness, catalog and 21 unsigned price quotes. `canSign` was false;
spent and reserved budgets were zero. This checks the existing live service,
not deployment of these local changes or real paid data delivery.

## Limits and next operational actions

- Install/enable the collector using `deploy/hetzner/USAGE-ARCHIVE.md` when
  releasing. Linux/systemd activation was not exercised on the Windows host.
- Coverage stays best effort: rotation/deletion can lose records; limits stop
  collection explicitly. Monitor timestamps. Expiry runs on successful polls.
- Provider invoice costs, visitor counts and human conversion are not inferred.
- The five-user pilot is ready but has no completed participants or outcomes.
- Real mainnet settlement was not tested. No claim of zero possible defects.
