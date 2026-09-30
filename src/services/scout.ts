import { getNewTokenRadar } from "./radar.js";
import { getTokenSafety } from "./safety.js";
import { optionalInt, optionalNumber } from "./params.js";

/**
 * The radar and the safety check, composed: today's new pools with a safety
 * verdict already attached. One call instead of N+1 — this is the endpoint
 * version of the exact workflow our findings posts run by hand.
 *
 * Deliberately bounded: the safety upstreams answer one token per request, so
 * a wide scout would be a lot of upstream traffic for one call. An agent that
 * wants the full list cheaper still has the radar + per-token safety calls —
 * scout sells the shortcut, not exclusivity.
 *
 * The checks run concurrently. They used to be sequential, on the assumption
 * that the upstreams rate-limit bursts; measuring showed that assumption came
 * from the wrong observation. GoPlus returns only one token per request no
 * matter how many addresses you send, which is a batching limit, not a rate
 * limit — three concurrent requests answer cleanly in well under a second,
 * while the same three in series took twelve and timed out twice, because a
 * slow lookup blocked the ones behind it.
 */

const DEFAULT_POOLS = 3;
const MAX_POOLS = 4;
const DEFAULT_MIN_LIQUIDITY_USD = 15_000;

interface ScoutSafety {
  verdict: string;
  failed: string[];
  warnings: string[];
  unchecked: string[];
}

export async function getScout(minLiquidityRaw?: string, poolsRaw?: string) {
  const minLiquidity =
    optionalNumber("minLiquidity", minLiquidityRaw, { min: 0, max: 1_000_000_000 }) ??
    DEFAULT_MIN_LIQUIDITY_USD;
  const poolCount = optionalInt("pools", poolsRaw, { min: 1, max: MAX_POOLS }) ?? DEFAULT_POOLS;

  const radar = await getNewTokenRadar(String(minLiquidity), String(poolCount));

  type ScoutPool = (typeof radar.pools)[number] & { safety: ScoutSafety | null };
  const pools: ScoutPool[] = [];
  let checked = 0;
  let unchecked = 0;
  const settled = await Promise.allSettled(
    radar.pools.map(async (pool) => (pool.token ? await getTokenSafety(pool.token) : null)),
  );

  radar.pools.forEach((pool, i) => {
    const result = settled[i];
    const s = result.status === "fulfilled" ? result.value : null;
    if (!s) {
      // A pool whose check could not run is reported with safety: null, never
      // dropped — an agent must be able to see that the answer is incomplete.
      unchecked++;
      pools.push({ ...pool, safety: null });
      return;
    }
    checked++;
    pools.push({
      ...pool,
      safety: {
        verdict: s.verdict,
        failed: s.failed,
        warnings: s.warnings,
        unchecked: s.unchecked,
      },
    });
  });

  const byVerdict = (v: string) => pools.filter((p) => p.safety?.verdict === v).length;

  return {
    chain: "base",
    minLiquidityUsd: minLiquidity,
    pools,
    summary: {
      found: radar.count,
      checked,
      unchecked,
      highRisk: byVerdict("high-risk"),
      caution: byVerdict("caution"),
      insufficientData: byVerdict("insufficient-data"),
      clear: byVerdict("clear"),
    },
    source: radar.source,
    disclaimer:
      "Automated checks against public data, not investment advice. Passing every check does not make a token safe.",
    at: new Date().toISOString(),
  };
}
