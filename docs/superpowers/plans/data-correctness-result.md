# Task B result — data correctness and resumable watches

Owner: `/root/data_correctness`. Scope: `src/services/{watch,history,prices,stats}.ts` and the four corresponding `tests/*.test.ts` files. No shared implementation files, manifests, scripts, original audit record or brand files were changed by this worker. No commit, payment, secret access, publication or deployment was performed.

## Behavior and acceptance evidence

| Requirement | Implementation / observable result | Regression evidence |
| --- | --- | --- |
| 51+ wallet events remain resumable | One upstream page / at most 50 events per request; continuation retains the original lower boundary and Blockscout block/index position. The second call delivers event 51. | `tests/watch.test.ts`: 51-event window; old backfill page deduplication |
| Stable ordering and bounded cursors | Wallet `cursor` is an opaque `w1.` value bound to the address, with bounded decompression, numeric pagination fields and no arbitrary URL. Results order by block/transaction position/hash. Polling rechecks a 120-second overlap and retains up to 100 hashes. | Same-time delayed event, recent delayed event, seen-hash suppression, wrong-address cursor, oversized/decompression payload, arbitrary pagination URL rejection |
| Explicit watch coverage | Wallet exposes `hasMore`, `partial`, `coverage`; radar always exposes `partial: true` and `coverage.complete: false` for its limited, ranked listing. | Radar coverage regression |
| Base market data independent of settlement | Wallet always queries `base.blockscout.com`; other owned market calls explicitly use Base mainnet endpoints. | Sepolia payment configuration still reads Base mainnet wallet data |
| Correct cohort median | Empty → null; singleton → that value; odd → middle; even → mean of both middle values. `[0, 100]` yields 50. | `tests/history.test.ts`: even, odd, empty and singleton cohort regressions |
| Missing data stays unknown | No quote/pair/known liquidity produces nullable liquidity values and `outcome: unavailable`; a measured deepest pair below $100 is `low-observed-liquidity`. Missing snapshots and price-source failures are counted separately. | Missing price/snapshot, missing liquidity, malformed pair and price outage regressions |
| Explicit cohort coverage | Includes unassessed first sightings; records selected/loaded snapshot counts, missing dates, pools without safety/token data, token pricing counts, failed batches, sample selection and variable holding periods. | First unassessed sighting remains unassessed when seen later; requested vs loaded snapshot evidence |
| Immutable history provenance | Resolves `main` to a verified 40-hex SHA once per index load. The index, snapshots, snapshot cache and scorecard cache are bound to that SHA. Missing/invalid SHA fails explicitly. | Immutable URLs/provenance and invalid revision regressions |
| Correct USDT conversion | Binance `USDCUSDT` is inverted for USDT. A 1.1 quote yields 0.9090909091 USD under USDC parity; +10% becomes approximately −9.090909%. Positive finite prices are required; missing/invalid changes remain null. | `tests/prices.test.ts`: inverse quote/change, invalid quotes and real-USD fallback |
| Currency assumptions remain visible | Price responses include `quoteCurrency` and `assumptions`; Binance explicitly assumes USDT or USDC dollar parity. Price alerts retain this metadata and the original price observation time. | Exchange parity and price-alert metadata regressions |
| Statistics cannot mix installations | Baseline identity and payload are validated before use. Cache keys include network and normalized recipient. A compatible baseline adds only subsequent qualifying logs; a foreign baseline never rejects an otherwise valid empty indexer result. | `tests/stats.test.ts`: custom stats = 0, hosted stats = 7, separate testnet totals, positive baseline + tail |
| No unbounded foreign-baseline fallback | `fromChain` rejects incompatible or malformed baselines before any RPC call. If no source is usable, the existing unavailable error path applies. Testnet RPC and token contract selection follows the requested stats network. | Foreign network/recipient and malformed baseline produce zero RPC calls; testnet contract/RPC regression |

## Validation commands and observed results

Initial reproduction, before production changes:

```text
node --import tsx --test tests/watch.test.ts tests/history.test.ts tests/prices.test.ts tests/stats.test.ts
13 tests, 0 pass, 13 fail, exit 1
```

The failures included 50 rather than 51 unique wallet events, median 100 rather than 50, custom-recipient toll count 7 rather than 0, mainnet data using Sepolia, mutable history paths and reversed USDT pricing. Additional red/green cycles exposed and fixed old-page duplicate replay, malformed price-row handling and alert metadata loss.

Final focused run:

```text
node --import tsx --test tests/watch.test.ts tests/history.test.ts tests/prices.test.ts tests/stats.test.ts
23 tests, 23 pass, 0 fail, exit 0
```

Owned production files plus their tests also pass strict TypeScript checking:

```text
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck src/services/watch.ts src/services/history.ts src/services/prices.ts src/services/stats.ts tests/watch.test.ts tests/history.test.ts tests/prices.test.ts tests/stats.test.ts
exit 0, no diagnostics
```

`git diff --check -- src/services/watch.ts src/services/history.ts src/services/prices.ts src/services/stats.ts` returned exit 0. Git reported only the workspace's LF/CRLF conversion notices.

A whole-root `npx tsc --noEmit` initially passed. A later concurrent root check reported only in-progress `safety.ts` diagnostics at lines 460–521; the safety/integration owners were notified. Whole-project final validation belongs to `/root`.

All regression IO was mocked at the HTTP/RPC boundary; no live source availability or production settlement is claimed.

## Interfaces and documentation for the integration owner

- `getStats(payTo, network?)`, `fromChain(payTo, network?)`, `latestBlock(network?)`, `blockMinedAt(block, network?)`, `scanTollLogs(payTo, fromBlock, toBlock, network?)`; exported `StatsNetwork = 'base' | 'base-sepolia'`. Omitting network preserves the `NETWORK` environment default. Application callers should pass validated configuration, and the hosted baseline script should pass `'base'` explicitly. `LOG_CHUNK` is unchanged.
- Wallet `since` accepts a legacy ISO timestamp, interpreted inclusively to avoid dropping same-time transactions. New wallet replies contain an opaque cursor; callers must echo it unchanged and drain `hasMore` until false before ordinary polling. Radar cursors remain ISO strings, accompanied by explicit partial coverage.
- Wallet overlap is bounded to 120 seconds and 100 retained hashes. `coverage.replayPossible` signals when the bound has been exceeded; consumers should deduplicate by transaction hash. Indexer omissions and older reorganizations are not an exhaustive chain guarantee. A source page that violates the documented 50-item contract fails explicitly rather than silently dropping rows.
- `Price` adds `quoteCurrency: 'USD' | 'USDT' | 'USDC'` and `assumptions: string[]`. Price alerts add those fields plus `source` and `priceObservedAt`. Other downstream price aggregations can preserve these assumptions where relevant.
- Scorecard token `liquidityGone`, `liquidityNowUsd` and potentially historical liquidity are nullable. Token `outcome` is `priced`, `unavailable` or `low-observed-liquidity`. Cohorts add `priced`/`unavailable`; a new `unassessed` cohort keeps tokens whose first snapshot had no safety verdict.
- Scorecard `coverage` describes published-snapshot selection, loaded/missing snapshots and data availability. `days` retains the existing latest-published-snapshots interpretation; holding periods vary. `trackRecord.daysCovered` counts snapshots actually loaded.
- History provenance adds `revision` and `integrity`; commit/raw/index links use the immutable SHA. A payment transaction proves payment and does not authenticate the snapshot's bytes or capture time. SHA resolution failure is an upstream error, never a fabricated or silently mutable provenance claim.

Protocol references consulted: Blockscout's [pagination documentation](https://docs.blockscout.com/devs/apis/rest) and [address-transactions schema](https://docs.blockscout.com/api-reference/get-address-transactions) document `next_page_params` and block/index positions. GitHub's [commit REST API](https://docs.github.com/en/rest/commits/commits) documents resolving a branch reference to an immutable commit SHA.
