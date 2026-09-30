# Automatic deployment activation — 13 September 2026

The timer deployed the CI-approved main revision automatically. This document
summarizes the original activation, not the current running release.

- Source revision: `c83262b68141a1451ff1fd4ab884ac60c449decd`.
- [Main verification passed](https://github.com/tevfikefeaydin/agenttoll/actions/runs/34723036404).
- The initial timer check waited for CI. The following check completed the release
  at 22:39 UTC on 12 September (01:39 in Istanbul on 13 September).
- Candidate and public API probes passed all 24 unsigned assertions.
- The proxy/static checks passed all 25 assertions then in use.
- All six isolated Docker/proxy recovery scenarios passed, including interrupted
  promotion, rollback and completion of an in-flight request during draining.
- Application and deployment suites passed 211 and 27 tests respectively.
- The old application drained gracefully. Shared proxy configuration and unrelated
  service responses were preserved; the proxy was not restarted.

The first DNS follow-up still observed cached routing for one hostname. Later
scheduled and independent checks confirmed cache expiry and passed all 49 live
API/proxy assertions plus both TLS peer checks. The earlier failed observation
was not counted as successful origin verification.

Raw release state, host paths, runtime comparisons, DNS results, service journals
and shared-host captures are retained privately. Their removal from the current
public tree does not alter the recorded outcomes. The migration compatibility
data in `test_autodeploy.py` is explicitly synthetic.

No wallet key or signed payment was used. For current state and operational
commands, use the [controller runbook](AUTODEPLOY.md).
