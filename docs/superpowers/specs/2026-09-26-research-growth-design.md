# Research growth and durable usage

User intent: implement the recommendations autonomously and check the final result twice. Existing unrelated working files must remain intact. No real payments, unsolicited messages, new paid services or production deployment are required for this implementation.

## Design

1. Durable operational measurement: installable host-side collector and systemd timer read only AgentToll managed-container logs. Keep bounded private records across application replacement, generate daily/weekly usage through the existing receipt validator, atomically preserve last good reports on failure. Repeated collection must not inflate counts; conflicting requests must remain excluded. Every report discloses retained-window coverage and collection gaps. No public analytics endpoint or wallet identities in aggregate reports. Raw arbitrary log fields, signatures and secrets must never be archived. Retention and limits are explicit; service setup is documented and not silently activated.
2. Guided research: extend the existing research page with an explicitly quoted radar discovery purchase, dated/partial pool results, and token actions leading to inspection and saved research. Existing per-request payment verification, expiry, ambiguity acknowledgement and cancellation remain authoritative. No automatic paid requests. Null token attribution cannot become an inspectable token. Introduce a watchlist-wide change digest comparing only dated saved inspections of the same token and provenance, with loss of evidence prominent. Add an explicit downloadable local calendar reminder to revisit research; it makes no network calls or automatic purchases. Do not implement server-side paid monitoring or unsolicited notifications without a durable authorization design.
3. Pilot readiness: a five-user task script, concrete success measurements and a fillable results record; never invent interviews or outcomes. Position the site around discover → inspect → revisit while preserving its agent/API audience. Explain existing sources, dated evidence and gaps.

## Acceptance

- A collector replay across restarts counts each request/receipt once, retains conflicts, rejects malformed state, handles limits and preserves last good state on command/write failures.
- Archive excludes arbitrary log payloads and has bounded retention and private file permissions. Production install and rollback steps are reviewable.
- Radar quote is free; only an explicit wallet approval permits spending. Paid discovery and safety remain separately priced, with no implied safety claims.
- Empty, malformed, missing-address and partial discovery states are usable; stale/cancelled quote results cannot revive a purchase.
- Digest excludes examples/shared snapshots from live change claims and distinguishes unchanged evidence, unavailable dates, conflicts and new risk/evidence loss.
- Calendar reminder is user initiated, contains no wallet/payment data and creates no background task.
- First verification: focused regressions, full offline suite, deployment tests, typechecks, generated consistency, builds, package smoke and dependency audits.
- Second verification: independent adversarial review and actual local browser/HTTP task flow, then fixes and relevant reruns. Live unsigned health checks are a separate baseline, not evidence of deploying new code.

## Decisions

Use existing Node/TypeScript and Python/systemd infrastructure without new product dependencies. Autonomous authorization permits concrete design choices; avoid redundant approval handoffs. Use separate implementation owners and a fresh final reviewer as required by the shared collaboration playbook. Work on a feature branch in the shared checkout so existing local evidence remains available; no checkout/reset/stash of user files.
