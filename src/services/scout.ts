import { getNewTokenRadar } from "./radar.js";
import { getTokenSafety } from "./safety.js";
import { optionalInt, optionalNumber } from "./params.js";

/**
 * The radar and the safety check, composed: today's new pools with a safety
 * verdict already attached. One call instead of N+1 — this is the endpoint
 * version of the exact workflow our findings posts run by hand.
 *
 * Deliberately bounded: safety upstreams answer one token per request and
 * rate-limit bursts, so scout checks a few pools sequentially rather than
 * many in parallel. An agent that wants the full list cheaper still has the
 * radar + per-token safety calls — scout sells the shortcut, not exclusivity.
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
  for (const pool of radar.pools) {
    if (!pool.token) {
      unchecked++;
      pools.push({ ...pool, safety: null });
      continue;
    }
    try {
      // Sequential on purpose — see the header comment.
      const s = await getTokenSafety(pool.token);
      checked++;
      const safety: ScoutSafety = {
        verdict: s.verdict,
        failed: s.failed,
        warnings: s.warnings,
        unchecked: s.unchecked,
      };
      pools.push({ ...pool, safety });
    } catch {
      // A pool whose check could not run is reported with safety: null, never
      // dropped — an agent must be able to see that the answer is incomplete.
      unchecked++;
      pools.push({ ...pool, safety: null });
    }
  }

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
