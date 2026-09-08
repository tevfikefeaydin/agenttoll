# Task A: safety and verified identity — implementation evidence

Date: 2026-09-08. Implementer: `/root/safety_identity`. Review owner: `/root`, then the independent final reviewer. This is implementation evidence, not independent approval or a production deployment.

## Scope

Changed only `src/services/safety.ts`, `src/services/basename.ts`, `tests/safety.test.ts`, `tests/basename.test.ts`, and this requested evidence record. No manifests, lockfiles, shared configuration, generated discovery files, other services, commits, pushes, payments, or deployments were changed or performed. Wallet secrets were not read. Existing brand output was left alone.

Read the task plan and `playbooks/agent-isbirligi.md`; used systematic debugging, test-driven development and verification-before-completion. All test doubles replace the external `fetch` boundary. Production services, caching, merging, validation, viem ABI encoding/decoding and contract reads execute normally. Unexpected external requests fail inside the fixtures; there is no live provider or settlement evidence claimed here.

## Reproduction and verification commands

All commands ran from `C:/Users/tevfi/OneDrive/Documents/agenttoll-main`.

| Command / stage | Observed result |
| --- | --- |
| `node --import tsx --test tests/safety.test.ts`, before service edits | Exit 1; 0 passed, 26 failed. The audit fixture returned `clear` instead of `insufficient-data`. Malformed holder collections threw `top10.reduce is not a function`. GoPlus 20% buy tax and an explicit unverified-code report were masked by the other provider. |
| `node --import tsx --test tests/basename.test.ts`, before service edits | After correcting the test fixture to accept viem's canonical trailing slash in RPC URLs, exit 1; 0 passed, 9 failed. The false claim `someone-else.base.eth` was returned as a primary name. Three unavailable providers were called 12 times. A hanging request exceeded the test's seven-second deadline. |
| `node --import tsx --test tests/safety.test.ts`, first implementation | Exit 0; 26 passed. |
| Same safety command, after three additional edge regressions and before their fixes | Exit 1; 26 passed, 3 failed. Numeric normalization lost a tiny valid fraction; a missing creator lost the explorer scam flag; an explorer scam was hidden behind the two-provider outage error. |
| Same safety command, after those fixes | Exit 0; 29 passed. |
| `node --import tsx --test tests/safety.test.ts tests/basename.test.ts`, final | Exit 0; 39 passed, 0 failed, 0 skipped/cancelled; 8475.838 ms reported duration. Includes the forward-lookup compatibility guard. Hanging RPC test completed in 4536.2063 ms and observed underlying request cancellation. |
| `npx tsc --noEmit --pretty false`, final | Exit 0, no diagnostics. |
| `git diff --check -- src/services/safety.ts src/services/basename.ts tests/safety.test.ts tests/basename.test.ts` | Exit 0, no whitespace errors. Git emitted only the workspace's LF-to-CRLF conversion notices. |

## Acceptance evidence

Evidence is executable in `tests/safety.test.ts` and `tests/basename.test.ts`.

| Acceptance / failure mode | Observed final behavior |
| --- | --- |
| Missing owner flags, missing sell tax, null holder and creator percentages | `verdict: "insufficient-data"`; `owner-powers`, `taxes`, `concentration` and `creator-stake` are `unknown` and listed in `unchecked`. |
| Fully measured clean token | `clear`; zero unchecked checks; coverage reports 8 completed of 8. Each check has source attribution and no missing fields. Retrieval timestamp parses and duration is nonnegative. |
| Known high buy tax with no sell tax | `high-risk`; taxes `fail`, `complete: false`, and taxes also appear in `unchecked`. |
| Mint permission with another owner flag absent | Owner check remains `warn`, names minting, and remains unchecked. |
| Null, empty/whitespace string, boolean, array, object, infinity text, negative and >100% fraction | Creator, holder and affected LP checks remain unknown. Known LP shares do not hide an unmeasured share. |
| Malformed collections, provider body or unsuccessful GoPlus envelope | No holder-reduction crash and no falsely passed checks; malformed source or field paths are visible in source metadata. |
| Conflicting static/simulated taxes or verification status | Higher measured tax and explicit unverified-source risk remain failures; conflict names are exposed. |
| Successful simulation without a honeypot result; taxes attached to a failed simulation | Incomplete simulation cannot pass the honeypot check; failed simulation's tax fields do not prove unknown taxes are zero. |
| String `"0"` holder flags | 60% movable concentration remains a failure, rather than being mistaken for locked/contract-held supply. |
| 50% locked LP plus a separate 50% unlocked LP | Largest withdrawable share fails; the lock no longer masks another provider's risk. |
| Truncated top-holder list or impossible aggregate shares | Incomplete coverage, never a clean pass. |
| Malformed deployer bytecode | Deployer type becomes null and the deployer check remains unchecked. |
| Honeypot signal with missing fields; explorer scam without creator; scam during safety-provider outage | Detected risk remains visible as `high-risk`. Creator fallback preserves the separately observed scam flag. |
| Tiny valid fraction | Numeric normalization preserves it as measured input and clean data can still pass. |
| Reverse name resolving to another address, zero address, missing resolver, failed read, or a different namespace | No primary name is exposed; address remains the original address. |
| Matching reverse and forward records | Verified name is exposed after exactly four contract reads: reverse resolver, reverse name, forward resolver, forward address. |
| `primaryName` enrichment | Uses the same verified and cached resolution path; spoofed claims return null. |
| Existing forward name lookup | Still returns the normalized name, address, registration status and optional records. |
| Unavailable/hanging resolver providers | At most one attempt per provider; hanging transport is cancelled. |

## Interfaces and semantics for integration

Existing verdict strings, check IDs and entry points remain. The following metadata is additive:

```ts
interface Check {
  id: string;
  status: "pass" | "warn" | "fail" | "unknown";
  detail: string;
  complete: boolean;
  missing: string[];
  sources: string[];
  conflicts: string[];
}

coverage: {
  complete: boolean;
  completedChecks: number;
  totalChecks: number;
}

sourceStatus: Record<string, {
  status: "ok" | "partial" | "not-found" | "unavailable" | "invalid";
  fetchedAt: string;
  durationMs: number;
  issues: string[];
}>;
```

`complete` requires no missing measurements or unresolved conflicts. `unchecked` now includes incomplete warnings/failures as well as unknown checks, so it can overlap `failed` and `warnings`. Severity remains independent of coverage. A high-risk observation is not erased to label the whole response unknown. Consumers should not infer that presence in `unchecked` cancels a detected risk.

`sources` keeps the existing string-array shape. `sourceStatus` includes attempted GoPlus, honeypot.is and Blockscout/RPC loads, plus executed creator fallbacks. `fetchedAt` is local retrieval completion time, not a provider observation timestamp or chain block time. `durationMs` covers the source load; validation issue strings are field paths/failure categories and contain no raw error/request text. An `ok` source response alone does not assert complete check coverage; use `checks` and `coverage`.

`Deployer.isContract` and `Deployer.flaggedScam` are now `boolean | null`. RPC failure/malformed bytecode and unavailable scam flags remain unknown. A known Blockscout scam flag is retained independently of whether the creator can be identified. Otherwise the existing two-provider outage error remains when neither analytical provider supplied data.

`BasenameResult` adds optional `verification: "verified" | "mismatch" | "unavailable" | "invalid-name" | "no-name"` on reverse lookups. `hasPrimaryName: true` and a non-null reverse `name` require a nonzero forward address matching the original address, case-insensitively. Reverse claims must already be valid fully qualified ASCII `.base.eth` names; no suffix is added to rewrite a claim. The existing forward-name normalization is unchanged.

Resolver HTTP attempts have a 1500 ms timeout and zero transport retries. Fallback has zero retries, so it cannot repeat the provider set. A six-second overall lookup deadline covers sequential and parallel lookup stages, including body reads, aborts outstanding fetches, and clears its timer on completion. Verified enrichment shares the existing 60-second basename cache. Safety keeps its existing five-minute cache; timestamps therefore represent the cached observation, with response freshness handled by integration.

## Primary-source references checked

GoPlus explicitly distinguishes missing flags and empty taxes from measured negatives; holder and LP records describe top-ten lists and 0–1 shares. [GoPlus response details](https://docs.gopluslabs.io/reference/response-details)

Honeypot.is documents that a successful simulation includes explicit result objects; a honeypot result can also exist independently after an unsuccessful simulation. [Honeypot.is response documentation](https://docs.honeypot.is/ishoneypot)

ENS requires forward resolution to verify a reverse claim before display. [ENS primary names](https://docs.ens.domains/web/reverse/)

The installed viem transport implementation was inspected to verify the separate HTTP and fallback retry layers and cancellation behavior, with its official transport documentation checked as context. [HTTP transport](https://viem.sh/docs/clients/transports/http), [fallback transport](https://viem.sh/docs/clients/transports/fallback)

## Remaining review scope

No known Task A acceptance case remains unhandled. Parent integration and independent review must still run the full repository suite and verify documentation/generated examples that consume the changed metadata. These tests validate deterministic fixture handling and cancellation; they do not establish current provider availability, token safety, or a live production deployment.
