**September 30 audit remediation**

This change addresses the sixteen code/operation findings and dependency advisory
finding reviewed at commit `96c2080c2fbce83a1493abe27e5d188bfa9de82f`. Review of the
replacement Python client also identified a matching Node payment-policy issue:
validated optional transfer hints must survive quote normalization.

| Finding | Result and regression coverage |
| --- | --- |
| API namespace/rate-limit mismatch | Alternate route forms cannot reach payment verification without Express preflight; rejected requests are logged. `request-boundaries.test.ts`. |
| Homepage uncertain payment retry | Reviewed quotes are single use; possible authorizations require wallet/receipt acknowledgement before another quote. Concurrent loading/payment is guarded. `public-app.test.ts`. |
| CrewAI payment trust and budget | Dedicated client checks exact origin/resource/network/USDC/recipient/domain/ceiling/lifetime; one atomic process budget. `tests/python/test_crewai_payment.py`. |
| CrewAI unbounded HTTP calls | Total deadline and cancellation cover quote, signing, retry and bounded response reads; pending/signed failures retain reservations. Python tests include stalled real loopback HTTP. |
| Incomplete request body deadline | API GET/HEAD bodies receive 400 and a closed connection; stalled JSON parsing stops at the request deadline. `request-boundaries.test.ts`. |
| Portfolio unseen tail | Every early stop with remaining pages marks coverage incomplete. Source floor, observed-only counts and unknown remaining token count are explicit. `portfolio.test.ts`. |
| Invalid Base token prices | Both providers require finite positive prices; invalid data triggers fallback or error. `basetoken.test.ts`. |
| Radar lower liquidity floor | Valid low-liquidity and empty listings are cached; caller floor is applied afterwards. `radar.test.ts`. |
| Sentiment cached observation age | Provider observation dates survive caching; unavailable dates stay null and fetch time is separate. `feargreed.test.ts`. |
| Fresh pool head race | Initialize and ModifyLiquidity reads share the captured block head. `fresh.test.ts`. |
| Regressing radar cursor | Cursor preserves the incoming high watermark through listing changes. `watch.test.ts`. |
| Older CI success selection | Attempt chronology supersedes run numbers; ambiguous conflicting observations fail closed. `test_autodeploy.py`. |
| Corrupt pending recovery | Schema-invalid transactions are quarantined and current routing restored; the recorded migration bootstrap remains compatible. `test_autodeploy.py`. |
| Snapshot push race/lost capture | Save captured bytes before publishing; replay only those bytes onto fresh main with three bounded attempts. Same-path divergence requires review. Artifacts survive failed publication for fourteen days. `test_snapshot_publish.py`. |
| Dependency advisories | Root and MCP lockfiles use `fast-uri@3.1.8` and `ip-address@10.7.2`. Both full npm audits report zero advisories at verification time. |
| Zero hook counted as bespoke | Zero-address hooks are excluded; usage-based interpretation is qualified. `fresh.test.ts`. |
| Cached price alias symbol | Aliases reuse the observation but shape the symbol for each request. `prices.test.ts`. |
| Additional x402 matching issue | Already validated EIP-3009/authorization hints are preserved; unrelated signing data is stripped. `payment.test.ts` uses the actual SDK matcher and unfunded signing. |

PR review follow-up:

- A request-specific Python transport checks cancellation after connection setup
  and before sending headers. Direct and proxy connection pools keep their
  existing TLS behavior; delayed DNS or connection setup cannot send a late
  authorization. Loopback regressions reproduce cancellation and timeout during
  DNS, connection, TLS and proxy tunnel setup, and retain the uncertain payment
  reservation. Separate adapters do not share cancellation state.
- Radar validates finite, nonnegative provider liquidity independently of the
  caller's floor. Malformed primary values trigger fallback; valid empty and
  low-liquidity listings remain supported and cacheable.
- Snapshot test fixtures and Git hooks explicitly write UTF-8/LF, matching the
  generators and avoiding false conflicts on Windows with Git newline conversion.

The Python example is deliberately limited to the registered token-safety route.
It no longer uses an unrestricted generic payment SDK. Requirements and usage are
documented in [examples/PYTHON.md](../../../examples/PYTHON.md). The separate
Python CI workflow exercises its actual helper and tool callback with a stubbed
CrewAI host; real signatures use unfunded disposable accounts and HTTP is mocked
or loopback-only. Installing the full CrewAI dependency set was additionally
checked through pip resolution.

Verification commands:

Local verification passed 518 JavaScript/TypeScript tests, 49 deployment tests,
31 Python client/transport tests and seven independent MCP tarball scenarios. Typechecking,
generated-file consistency and both builds passed. Both complete npm dependency
audits reported zero advisories. No live payment was authorized.

```sh
npm test
npm run typecheck
npm run check:generated
npm run build
npm --prefix mcp run build
npm run smoke:mcp
npm audit
npm --prefix mcp audit
python3 -m unittest discover -s deploy/hetzner -p 'test_*.py'
# In a virtual environment with examples/requirements-payment.txt installed:
python -m unittest discover -s tests/python -p 'test_*.py' -v
```

The original CI policy file remains unchanged. The Python workflow is separate
so the Hetzner controller's pinned main verification policy is preserved.
Application source and GitHub workflow changes take effect through their normal
merge/release paths. The operator-owned Hetzner controller does **not** update
from a repository push: its two fixes require separately installing the reviewed
controller under the existing deployment-lock procedure in
[AUTODEPLOY.md](../../../deploy/hetzner/AUTODEPLOY.md). No npm release or real
mainnet settlement verification is claimed.

Post-merge controller installation was completed separately on Hetzner after
33 Linux controller tests and all six isolated Docker/proxy rehearsal checks
passed. The timer was paused, the deployment lock acquired, and the reviewed
controller installed with a backup of the previous files; the timer was then
resumed. The 33 tests also passed against the installed files. Configuration and
CI policy pins remained unchanged.

The Linux rehearsal now uses valid 40-character revision IDs. Its interrupted
deployment scenario checks that the valid journal survives file recovery, that
transaction recovery clears it, and that the failed candidate stops. This
prevents the corrupt-journal fallback from masking a transaction-recovery failure.

Budgets remain in-memory per client/process. Python cannot interrupt every DNS
or signing implementation; callers return at their deadline and late connections
check cancellation before sending payment headers. Cancellation cannot recall
an authorization already transmitted. These boundaries are documented
rather than represented as wallet-wide or persistent controls.
