# DATA-QUALITY implementation evidence

Owner: data implementer. Independent review and release: root/final reviewer. No paid endpoint, signing key, production mutation, commit or publish was used by this worker.

## Observed defects and changes

- **Scorecard:** actual DexScreener response contains only five pairs for the 26-token seven-day cohort. This is provider coverage, not evidence that the missing tokens lost all liquidity. The implementation previously stopped there although the snapshots already contain exact pool identifiers. An actual GeckoTerminal multi-pool request returned all 26 recorded pools. `history.ts` now queries that independent provider for missing primary observations, verifies the Base pool ID and token relationship against a recorded snapshot, handles base/quote token fields independently, and selects the deepest observed fallback pool. Known primary observations are retained. Each row exposes additive `priceSource` and `pricePool` fields.
- **Bounded fallback:** up to four parallel requests of at most 30 pool IDs, four seconds per request, no retry. The existing request-context cancellation remains authoritative. `fallbackPriceBatchesFailed` and `fallbackPoolsSkipped` are additive coverage fields; `priceBatchesFailed` retains its original primary-provider meaning. Oversized historical input cannot increase this fallback cap. This is a cap on the new fallback, not a new cap on all pre-existing history/snapshot work.
- **Safety:** the original deployed USDC audit spent 8,002 ms in `blockscout+rpc`, followed by a successful 144 ms GoPlus creator/RPC fallback. The shared Blockscout helper retries once with a configured key; the safety caller failed to disable that same-provider retry despite having an independent fallback. `safety.ts` now requests one bounded four-second explorer attempt. GoPlus/fresh RPC fallbacks also attach missing RPC field issues, so partially readable RPC data no longer reports source status `ok`.

No changes were required in `prices.ts`, `scout.ts`, shared sources or cache. Safety checks, strict missing-field rules, price thresholds, payment behavior and original response fields are retained.

## Evidence

| Evidence | Observation |
|---|---|
| `data-quality-before.json` | Actual local calls before production edits: the same immutable cohort has 26 tokens, five priced, 21 unavailable. |
| `data-quality-providers.json` | Actual read-only provider responses and the local baseline snapshot pool list: DexScreener five pairs, GeckoTerminal 26 exact recorded pools. |
| `data-quality-after.json` | Actual local calls after implementation: scorecard 1,840 ms / 11 upstream calls; 11 priced, 15 low-observed-liquidity, zero unavailable, no failed/skipped fallback batches. USDC 4,358 ms / six upstream calls; five of eight checks complete. |
| `data-quality-tests.log` | 55 focused history/safety/prices tests pass. Covers malformed/wrong-chain/wrong-token/unsolicited pools, quote-token extraction, explicit zero versus absent liquidity, primary outage recovery, source attribution, bounded fallback, caller cancellation, keyed-explorer retry omission and partial RPC source status. |
| `tests/history.test.ts`, `tests/safety.test.ts` | Four new behavior regressions were run before production edits and failed on missing fallback results, two explorer requests instead of one, and `ok` instead of `partial`. They pass after the fixes. |

`npm run typecheck:api` and `npm run typecheck:tests` pass. One concurrent rerun briefly encountered the root worker's not-yet-created `src/operations-data.js` import; after that file was created, the full test typecheck was rerun successfully. Commands were run after the workspace environment helper. Root performs the full integration/build suite. The repeatable `data-quality-live.mjs` probe calls service functions directly with a 25-second signal per service and prints JSON; it does not use the paid API. Run it from the repository root with `node --import tsx docs/remediation/2026-09-14/data-quality-live.mjs`.

## Remaining external limits

- These are sequential live observations of a changing market, not a controlled price/latency benchmark. The local before probe had no Blockscout key and explorer availability varied; do not claim a measured local twofold speedup. The audit establishes the deployed eight-second symptom, and the synthetic keyed-outage regression establishes removal of the second attempt.
- Blockscout remained unavailable in the after probe. USDC owner powers, liquidity ownership and explorer scam flag remain incomplete; the verdict remains `caution`, and unknown checks are not promoted to passing.
- Provider quotes are reported observations, not a guarantee of executable price or last-trade freshness. The raw pool responses include inactive pools and disagreement between providers. The method describes source priority and each row identifies the selected pool/provider; no provider consensus is claimed.
- A low-liquidity result refers only to the observed pool(s), not proof that all liquidity disappeared. It has no computed return and stays outside the median. Missing or failed fallback data remains unavailable. Future cohorts may still be incomplete, and sample coverage always remains `complete: false`.
- GeckoTerminal's public quota can rate-limit the additional requests. There are no retries, paid credentials or new paying schedules.

Provider contracts consulted: [DexScreener API reference](https://docs.dexscreener.com/api/reference), [GeckoTerminal API reference](https://api.geckoterminal.com/docs/index.html), [GeckoTerminal public API FAQ](https://apiguide.geckoterminal.com/faq).

## Independent review correction

The final reviewer reproduced a new malformed-snapshot regression: numeric `token: 123`, previously counted as a missing token, caused the new fallback filter to call `toLowerCase` on a number. A new regression first failed with that exact TypeError. Both the fallback candidate filter and snapshot relationship match now require string tokens. Two new fixtures verify that malformed rows increment `poolsWithoutToken` while valid primary and fallback observations survive, including a malformed row sharing the valid pool ID. The focused suite now passes 55/55. An initial combined rerun also exposed backwards mock-clock ordering between the new tests and the existing cancellation test; its clock was moved forward, preserving its actual abort assertion. These changes affect malformed-input handling only; the recorded valid live-provider observations remain applicable.
