import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";

/**
 * Automated safety checks for a Base token.
 *
 * Two sources answer different questions, so this endpoint does not fall through
 * from one to the other the way the rest do — it asks both and merges:
 *
 *   GoPlus      static analysis of the contract, plus holder and LP data
 *   honeypot.is an actual simulated buy and sell, which catches traps that
 *               only appear at execution time
 *
 * Where a source is missing, its checks report `unknown`. That distinction is
 * the whole point: on a safety endpoint, "we could not check" must never be
 * rendered as "passed", because the caller is about to risk money on it.
 */

const GOPLUS = "https://api.gopluslabs.io/api/v1/token_security/8453";
const HONEYPOT = "https://api.honeypot.is/v2/IsHoneypot";

export type Status = "pass" | "warn" | "fail" | "unknown";

export interface Check {
  id: string;
  status: Status;
  detail: string;
}

/** GoPlus returns everything as strings, and percentages as fractions. */
const flag = (v: unknown): boolean => v === "1" || v === 1;
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 0.503260 means 50.3%, not 0.5%. */
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Number((n * 100).toFixed(2));
};

interface GoPlusToken {
  token_name?: string;
  token_symbol?: string;
  is_honeypot?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  transfer_tax?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  transfer_pausable?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  trading_cooldown?: string;
  anti_whale_modifiable?: string;
  owner_change_balance?: string;
  external_call?: string;
  honeypot_with_same_creator?: string;
  creator_percent?: string;
  owner_percent?: string;
  holder_count?: string;
  lp_holder_count?: string;
  is_in_cex?: { listed?: string; cex_list?: string[] };
  holders?: { percent?: string; is_contract?: number; is_locked?: number; tag?: string }[];
  lp_holders?: { percent?: string; is_locked?: number; tag?: string }[];
}

interface HoneypotResult {
  token?: { name?: string; symbol?: string; totalHolders?: number };
  summary?: { risk?: string; riskLevel?: number; flags?: unknown[] };
  simulationSuccess?: boolean;
  honeypotResult?: { isHoneypot?: boolean };
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number };
  contractCode?: { openSource?: boolean; isProxy?: boolean };
}

async function fromGoPlus(address: string): Promise<GoPlusToken | null> {
  const res = await fetchWithTimeout(`${GOPLUS}?contract_addresses=${address}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GoPlus returned ${res.status}`);
  const json = (await res.json()) as { result?: Record<string, GoPlusToken> };
  // An unknown token yields an empty result rather than an error.
  return json.result?.[address.toLowerCase()] ?? null;
}

async function fromHoneypot(address: string): Promise<HoneypotResult | null> {
  const res = await fetchWithTimeout(`${HONEYPOT}?address=${address}&chainID=8453`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`honeypot.is returned ${res.status}`);
  const json = (await res.json()) as HoneypotResult & { error?: string };
  if (json.error) throw new Error(`honeypot.is: ${json.error}`);
  return json;
}

/** Owner powers worth naming, in the order a caller cares about them. */
const OWNER_POWERS: { key: keyof GoPlusToken; label: string }[] = [
  { key: "is_mintable", label: "owner can mint new supply" },
  { key: "transfer_pausable", label: "transfers can be paused" },
  { key: "is_blacklisted", label: "addresses can be blacklisted" },
  { key: "slippage_modifiable", label: "tax rate can be changed" },
  { key: "personal_slippage_modifiable", label: "per-address tax can be set" },
  { key: "can_take_back_ownership", label: "ownership can be reclaimed" },
  { key: "hidden_owner", label: "ownership is hidden" },
  { key: "selfdestruct", label: "contract can self-destruct" },
  { key: "trading_cooldown", label: "trading cooldown enforced" },
  { key: "anti_whale_modifiable", label: "max transaction size can be changed" },
  { key: "owner_change_balance", label: "owner can change balances" },
];

function buildChecks(gp: GoPlusToken | null, hp: HoneypotResult | null): Check[] {
  const checks: Check[] = [];

  // 1. Can you sell it again? Simulation is the stronger evidence, so it wins.
  const simTrapped = hp?.honeypotResult?.isHoneypot === true;
  const staticTrapped = flag(gp?.is_honeypot) || flag(gp?.cannot_sell_all) || flag(gp?.cannot_buy);
  if (simTrapped || staticTrapped) {
    checks.push({
      id: "honeypot",
      status: "fail",
      detail: simTrapped
        ? "A simulated buy could not be sold again — this is a honeypot"
        : "Static analysis reports the token cannot be bought or fully sold",
    });
  } else if (hp?.simulationSuccess === true) {
    checks.push({ id: "honeypot", status: "pass", detail: "A simulated buy and sell both succeeded" });
  } else if (gp) {
    checks.push({
      id: "honeypot",
      status: "warn",
      detail: "Static analysis found no trap, but a live buy/sell could not be simulated",
    });
  } else {
    checks.push({ id: "honeypot", status: "unknown", detail: "No source could check this" });
  }

  // 2. Taxes. GoPlus reports fractions, honeypot.is reports percentages.
  const buy = hp?.simulationResult?.buyTax ?? pct(gp?.buy_tax);
  const sell = hp?.simulationResult?.sellTax ?? pct(gp?.sell_tax);
  const worst = Math.max(buy ?? 0, sell ?? 0);
  if (buy === null && sell === null) {
    checks.push({ id: "taxes", status: "unknown", detail: "Trading tax could not be determined" });
  } else {
    checks.push({
      id: "taxes",
      status: worst >= 10 ? "fail" : worst >= 5 ? "warn" : "pass",
      detail: `Buy tax ${buy ?? "?"}%, sell tax ${sell ?? "?"}%`,
    });
  }

  // 3. Source code. Unverified means nobody can audit what the contract does.
  const open = gp ? flag(gp.is_open_source) : hp?.contractCode?.openSource;
  checks.push(
    open === undefined
      ? { id: "verified", status: "unknown", detail: "Could not tell whether the source is published" }
      : open
        ? { id: "verified", status: "pass", detail: "Contract source is verified and public" }
        : { id: "verified", status: "fail", detail: "Contract source is not published — its behaviour cannot be audited" },
  );

  // 4. What the owner can still do to holders.
  if (!gp) {
    checks.push({ id: "owner-powers", status: "unknown", detail: "Contract permissions could not be read" });
  } else {
    const powers = OWNER_POWERS.filter(({ key }) => flag(gp[key])).map(({ label }) => label);
    const severe = powers.some((p) =>
      /mint|paused|blacklist|tax can be changed|per-address tax|self-destruct|change balances/.test(p),
    );
    checks.push({
      id: "owner-powers",
      status: powers.length === 0 ? "pass" : severe ? "warn" : "warn",
      detail: powers.length === 0 ? "No dangerous owner privileges found" : `Owner can: ${powers.join(", ")}`,
    });
  }

  // 5. Holder concentration. A locked or contract-held position is not the same
  // risk as one wallet that can dump, so both figures are reported.
  const holders = gp?.holders ?? [];
  if (!holders.length) {
    checks.push({ id: "concentration", status: "unknown", detail: "Holder distribution unavailable" });
  } else {
    const top10 = holders.slice(0, 10);
    const total = top10.reduce((s, h) => s + (num(h.percent) ?? 0), 0) * 100;
    const movable =
      top10.filter((h) => !h.is_locked && !h.is_contract).reduce((s, h) => s + (num(h.percent) ?? 0), 0) * 100;
    checks.push({
      id: "concentration",
      status: movable >= 50 ? "fail" : movable >= 25 ? "warn" : "pass",
      detail: `Top 10 hold ${total.toFixed(1)}% of supply; ${movable.toFixed(1)}% sits in wallets that are neither locked nor contracts`,
    });
  }

  // 6. Can the floor be pulled? The question is not whether a lock contract
  // exists — plenty of sound tokens have none — but whether any single actor
  // can withdraw enough liquidity to strand holders. So this measures the
  // largest unlocked provider, not the absence of a lock.
  const lp = gp?.lp_holders ?? [];
  if (!gp) {
    checks.push({ id: "liquidity", status: "unknown", detail: "Liquidity ownership could not be read" });
  } else if (!lp.length) {
    checks.push({ id: "liquidity", status: "unknown", detail: "No liquidity-provider data for this token" });
  } else {
    const shares = lp.map((h) => ({ locked: Boolean(h.is_locked), share: (num(h.percent) ?? 0) * 100 }));
    const accounted = shares.reduce((s, h) => s + h.share, 0);
    if (accounted <= 0) {
      // Providers exist but their shares came back empty. Reporting that as a
      // pass would turn missing data into reassurance.
      checks.push({
        id: "liquidity",
        status: "unknown",
        detail: "Liquidity providers are listed but their shares are not reported yet",
      });
    } else {
      const locked = shares.filter((h) => h.locked).reduce((s, h) => s + h.share, 0);
      const biggest = Math.max(...shares.filter((h) => !h.locked).map((h) => h.share), 0);
      const providers = num(gp.lp_holder_count) ?? lp.length;
      checks.push({
        id: "liquidity",
        status: locked >= 50 || biggest < 25 ? "pass" : biggest >= 50 ? "fail" : "warn",
        detail:
          `${locked.toFixed(1)}% of liquidity is locked or burned; the largest single provider that can still ` +
          `withdraw holds ${biggest.toFixed(1)}%, across ${providers} provider${providers === 1 ? "" : "s"}`,
      });
    }
  }

  // 7. Creator's own stake, which is the supply most likely to hit the market.
  const creator = pct(gp?.creator_percent);
  checks.push(
    creator === null
      ? { id: "creator-stake", status: "unknown", detail: "Creator balance unavailable" }
      : {
          id: "creator-stake",
          status: creator >= 20 ? "warn" : "pass",
          detail: `The creator holds ${creator}% of supply`,
        },
  );

  return checks;
}

export async function getTokenSafety(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    badRequest("Invalid token address — expected 0x + 40 hex chars");
  }
  const addr = address.toLowerCase();

  return cached(`safety:${addr}`, 300_000, async () => {
    // Both are asked at once and either may fail; only a total blackout is an
    // error, because a partial answer with honest `unknown` checks is still
    // worth more than nothing.
    const [gpResult, hpResult] = await Promise.allSettled([fromGoPlus(addr), fromHoneypot(addr)]);
    const gp = gpResult.status === "fulfilled" ? gpResult.value : null;
    const hp = hpResult.status === "fulfilled" ? hpResult.value : null;

    if (!gp && !hp) {
      throw new Error("Both safety sources are unavailable right now — please retry");
    }
    if (gp === null && hpResult.status === "fulfilled" && !hp?.token?.name) {
      badRequest("That address is not a token we can analyse on Base");
    }

    const checks = buildChecks(gp, hp);
    const failed = checks.filter((c) => c.status === "fail");
    const warned = checks.filter((c) => c.status === "warn");
    const unknown = checks.filter((c) => c.status === "unknown");

    const sources: string[] = [];
    if (gp) sources.push("goplus");
    if (hp) sources.push("honeypot.is");

    return {
      chain: "base",
      token: addr,
      name: gp?.token_name ?? hp?.token?.name ?? null,
      symbol: gp?.token_symbol ?? hp?.token?.symbol ?? null,
      // Deliberately not called "safe": these are automated checks, and a token
      // can pass all of them and still be a bad trade. "clear" additionally
      // requires that the checks actually ran — a token too new to have holder
      // or liquidity data is unknown, not clean, and saying otherwise is how a
      // safety endpoint gets someone hurt.
      verdict: failed.length
        ? "high-risk"
        : warned.length
          ? "caution"
          : unknown.length
            ? "insufficient-data"
            : "clear",
      failed: failed.map((c) => c.id),
      warnings: warned.map((c) => c.id),
      unchecked: unknown.map((c) => c.id),
      checks,
      holderCount: num(gp?.holder_count) ?? hp?.token?.totalHolders ?? null,
      listedOnCex: flag(gp?.is_in_cex?.listed) ? (gp?.is_in_cex?.cex_list ?? []) : [],
      sources,
      disclaimer:
        "Automated checks against public data, not investment advice. Passing every check does not make a token safe.",
      at: new Date().toISOString(),
    };
  });
}
