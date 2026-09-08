import { cached, fetchWithTimeout } from "./cache.js";
import { badRequest } from "./errors.js";
import { launcherOf } from "./fresh.js";
import { baseRpc, blockscoutFetch } from "./sources.js";

/**
 * Automated safety checks for a Base token.
 *
 * Two sources answer different questions, so this endpoint does not fall through
 * from one to the other the way the rest do — it asks both and merges:
 *
 *   GoPlus      static analysis of the contract, plus holder and LP data
 *   honeypot.is an actual simulated buy and sell, which catches traps that
 *               only appear at execution time
 *   deployer    who shipped the contract, read from the explorer and the chain
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
  /** Coverage is independent of risk: an incomplete check can still fail. */
  complete: boolean;
  missing: string[];
  sources: string[];
  conflicts: string[];
}

/** GoPlus returns everything as strings, and percentages as fractions. */
const flag = (v: unknown): boolean | null =>
  v === "1" || v === 1 ? true : v === "0" || v === 0 ? false : null;
const num = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim()))) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const fraction = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n <= 1 ? n : null;
};
const count = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
};
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v : null;
/** 0.503260 means 50.3%, not 0.5%. */
const pct = (v: unknown): number | null => {
  const n = fraction(v);
  return n === null ? null : Number((n * 100).toFixed(2));
};

interface SourceStatus {
  status: "ok" | "partial" | "not-found" | "unavailable" | "invalid";
  /** Retrieval time, not a claim about the provider's underlying observation time. */
  fetchedAt: string;
  durationMs: number;
  issues: string[];
}

class InvalidSource extends Error {}

async function observe<T>(load: (issues: string[]) => Promise<T | null>) {
  const start = Date.now();
  const source: SourceStatus = { status: "ok", fetchedAt: "", durationMs: 0, issues: [] };
  let value: T | null = null;
  try {
    value = await load(source.issues);
    source.status = value === null ? "not-found" : source.issues.length ? "partial" : "ok";
  } catch (error) {
    source.status = error instanceof InvalidSource ? "invalid" : "unavailable";
    // Field paths and failure categories are useful; raw upstream errors are not
    // part of this public result and may contain request details.
    source.issues.push(error instanceof InvalidSource ? error.message : "request-failed");
  }
  source.fetchedAt = new Date().toISOString();
  source.durationMs = Date.now() - start;
  return { value, source };
}

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
  creator_address?: string;
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

async function fromGoPlus(address: string, issues: string[]): Promise<GoPlusToken | null> {
  const res = await fetchWithTimeout(`${GOPLUS}?contract_addresses=${address}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GoPlus returned ${res.status}`);
  const json = record(await res.json());
  if (!json || (json.code !== undefined && json.code !== 1) || !record(json.result)) throw new InvalidSource("response");
  // An unknown token yields an empty result rather than an error.
  const raw = record(json.result)![address.toLowerCase()];
  if (raw === undefined || raw === null) return null;
  const input = record(raw);
  if (!input) throw new InvalidSource("token");
  const output: Record<string, unknown> = {};
  const set = (target: Record<string, unknown>, key: string, rawValue: unknown, parse: (v: unknown) => unknown, path = key) => {
    const value = parse(rawValue);
    if (value !== null) target[key] = value;
    else if (rawValue !== undefined) issues.push(path);
  };
  for (const key of ["is_honeypot", "cannot_buy", "cannot_sell_all", "is_open_source", ...OWNER_POWERS.map(({ key }) => key)]) {
    set(output, key, input[key], (v) => flag(v) === null ? null : flag(v) ? "1" : "0");
  }
  for (const key of ["buy_tax", "sell_tax", "creator_percent"]) {
    set(output, key, input[key], (v) => fraction(v)?.toString() ?? null);
  }
  for (const key of ["holder_count", "lp_holder_count"]) set(output, key, input[key], (v) => count(v)?.toString() ?? null);
  for (const key of ["token_name", "token_symbol"]) set(output, key, input[key], text);
  set(output, "creator_address", input.creator_address, (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null);
  for (const key of ["holders", "lp_holders"]) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key])) { issues.push(key); continue; }
    output[key] = input[key].slice(0, 10).map((rawHolder, index) => {
      const holder = record(rawHolder);
      const out: Record<string, unknown> = {};
      if (!holder) { issues.push(`${key}[${index}]`); return out; }
      set(out, "percent", holder.percent, (v) => fraction(v)?.toString() ?? null, `${key}[${index}].percent`);
      for (const field of key === "holders" ? ["is_locked", "is_contract"] : ["is_locked"]) {
        set(out, field, holder[field], (v) => flag(v) === null ? null : Number(flag(v)), `${key}[${index}].${field}`);
      }
      return out;
    });
  }
  const cex = record(input.is_in_cex);
  if (cex && flag(cex.listed) !== null) {
    output.is_in_cex = { listed: flag(cex.listed) ? "1" : "0", cex_list: Array.isArray(cex.cex_list) ? cex.cex_list.filter((v): v is string => typeof v === "string") : [] };
  }
  return output as GoPlusToken;
}

async function fromHoneypot(address: string, issues: string[]): Promise<HoneypotResult | null> {
  const res = await fetchWithTimeout(`${HONEYPOT}?address=${address}&chainID=8453`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`honeypot.is returned ${res.status}`);
  const json = record(await res.json());
  if (!json || json.error) throw new InvalidSource("response");
  const output: HoneypotResult = {};
  const bool = (v: unknown) => typeof v === "boolean" ? v : null;
  const read = <T>(parent: Record<string, unknown>, key: string, parser: (v: unknown) => T | null, path = key): T | undefined => {
    const value = parser(parent[key]);
    if (value === null && parent[key] !== undefined) issues.push(path);
    return value ?? undefined;
  };
  output.simulationSuccess = read(json, "simulationSuccess", bool);
  for (const [key, fields, parser] of [
    ["honeypotResult", ["isHoneypot"], bool],
    ["contractCode", ["openSource", "isProxy"], bool],
    ["simulationResult", ["buyTax", "sellTax", "transferTax"], (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null],
  ] as const) {
    if (json[key] === undefined) continue;
    const input = record(json[key]);
    if (!input) { issues.push(key); continue; }
    const out: Record<string, unknown> = {};
    for (const field of fields) out[field] = read(input, field, parser as (v: unknown) => unknown, `${key}.${field}`);
    Object.assign(output, { [key]: out });
  }
  const token = record(json.token);
  if (token) output.token = { name: read(token, "name", text, "token.name"), symbol: read(token, "symbol", text, "token.symbol"), totalHolders: read(token, "totalHolders", count, "token.totalHolders") };
  else if (json.token !== undefined) issues.push("token");
  return output;
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

function makeCheck(id: string, status: Status, detail: string, sources: string[], missing: string[] = [], conflicts: string[] = []): Check {
  if (status === "pass" && (missing.length || conflicts.length)) status = conflicts.length ? "warn" : "unknown";
  return { id, status, detail, complete: missing.length === 0 && conflicts.length === 0 && status !== "unknown", missing, sources, conflicts };
}

function buildChecks(gp: GoPlusToken | null, hp: HoneypotResult | null): Check[] {
  const checks: Check[] = [];
  const providers = (staticEvidence: boolean, simulatedEvidence: boolean) => [
    ...(staticEvidence ? ["goplus"] : []), ...(simulatedEvidence ? ["honeypot.is"] : []),
  ];

  // A clean simulation is positive evidence only with an explicit result.
  // A contrary risk report is retained rather than overridden by precedence.
  const simTrapped = hp?.honeypotResult?.isHoneypot === true;
  const simClean = hp?.simulationSuccess === true && hp?.honeypotResult?.isHoneypot === false;
  const staticFlags = [flag(gp?.is_honeypot), flag(gp?.cannot_sell_all), flag(gp?.cannot_buy)];
  const staticTrapped = staticFlags.some((v) => v === true);
  const staticClean = staticFlags.every((v) => v === false);
  checks.push(makeCheck(
    "honeypot", simTrapped || staticTrapped ? "fail" : simClean ? "pass" : staticClean ? "warn" : "unknown",
    simTrapped ? "honeypot.is reports that the token is a honeypot" : staticTrapped ? "Static analysis reports the token cannot be bought or fully sold" :
      simClean ? "A simulated buy and sell both succeeded with an explicit negative honeypot result" : "A complete buy/sell simulation is unavailable",
    providers(staticFlags.some((v) => v !== null), hp?.honeypotResult?.isHoneypot !== undefined),
    simClean || simTrapped ? [] : ["successful-buy-sell-simulation"],
    (staticTrapped && simClean) || (staticClean && simTrapped) ? ["honeypot"] : [],
  ));

  // Taxes from an unsuccessful simulation are unmeasured. Each direction must
  // be known to pass, while a known excessive tax can fail an incomplete check.
  const gpBuy = pct(gp?.buy_tax);
  const gpSell = pct(gp?.sell_tax);
  const hpBuy = hp?.simulationSuccess === true ? hp.simulationResult?.buyTax ?? null : null;
  const hpSell = hp?.simulationSuccess === true ? hp.simulationResult?.sellTax ?? null : null;
  const higher = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);
  const buy = higher(gpBuy, hpBuy);
  const sell = higher(gpSell, hpSell);
  const worst = Math.max(buy ?? 0, sell ?? 0);
  const taxConflicts = [
    ...(gpBuy !== null && hpBuy !== null && Math.abs(gpBuy - hpBuy) > 0.01 ? ["buy-tax"] : []),
    ...(gpSell !== null && hpSell !== null && Math.abs(gpSell - hpSell) > 0.01 ? ["sell-tax"] : []),
  ];
  checks.push(makeCheck("taxes", worst >= 10 ? "fail" : worst >= 5 ? "warn" : "pass",
    `Buy tax ${buy ?? "?"}%, sell tax ${sell ?? "?"}%${taxConflicts.length ? "; sources disagree, highest measured tax shown" : ""}`,
    providers(gpBuy !== null || gpSell !== null, hpBuy !== null || hpSell !== null),
    [...(buy === null ? ["buy-tax"] : []), ...(sell === null ? ["sell-tax"] : [])], taxConflicts));

  const gpOpen = flag(gp?.is_open_source);
  const hpOpen = hp?.contractCode?.openSource ?? null;
  const closed = gpOpen === false || hpOpen === false;
  const open = gpOpen === true || hpOpen === true;
  checks.push(makeCheck("verified", closed ? "fail" : open ? "pass" : "unknown",
    closed ? "A source reports that contract code is not published" : open ? "Contract source is verified and public" : "Could not tell whether the source is published",
    providers(gpOpen !== null, hpOpen !== null), open || closed ? [] : ["open-source"],
    gpOpen !== null && hpOpen !== null && gpOpen !== hpOpen ? ["open-source"] : []));

  const powers = OWNER_POWERS.filter(({ key }) => flag(gp?.[key]) === true).map(({ label }) => label);
  const missingPowers = OWNER_POWERS.filter(({ key }) => flag(gp?.[key]) === null).map(({ key }) => String(key));
  checks.push(makeCheck("owner-powers", powers.length ? "warn" : "pass",
    powers.length ? `Owner can: ${powers.join(", ")}` : missingPowers.length ? "Some contract permissions could not be read" : "No dangerous owner privileges found",
    providers(!!gp, false), missingPowers));

  // GoPlus supplies the top ten holders. A shorter list needs a holder count
  // confirming that there are fewer than ten; unknown shares/flags stay missing.
  const holders = gp?.holders ?? [];
  const missingHolders: string[] = [];
  const holderCount = count(gp?.holder_count);
  if (!holders.length || holders.length < Math.min(holderCount ?? 10, 10)) missingHolders.push("top-holder-list");
  if (holderCount !== null && holderCount < holders.length) missingHolders.push("holder-count");
  let total = 0;
  let movable = 0;
  holders.forEach((holder, i) => {
    const proportion = fraction(holder.percent);
    const share = proportion === null ? null : proportion * 100;
    const locked = flag(holder.is_locked);
    const contract = flag(holder.is_contract);
    if (share === null) missingHolders.push(`holders[${i}].percent`);
    if (locked === null) missingHolders.push(`holders[${i}].is_locked`);
    if (contract === null) missingHolders.push(`holders[${i}].is_contract`);
    if (share !== null) {
      total += share;
      if (locked === false && contract === false) movable += share;
    }
  });
  const allHoldersListed = holderCount !== null && holderCount <= 10 && holders.length === holderCount;
  // A top-ten sample may cover only part of supply. A list explicitly covering
  // every holder must account for all supply, allowing 0.01 percentage-point
  // provider rounding. Sum original shares, not individually rounded display values.
  if (total > 100.01 || (allHoldersListed && total < 99.99)) missingHolders.push("holder-share-total");
  checks.push(makeCheck("concentration", movable >= 50 ? "fail" : movable >= 25 ? "warn" : "pass",
    holders.length ? `${missingHolders.length ? "Reported" : "Top 10"} holders account for ${total.toFixed(1)}% of supply; ${movable.toFixed(1)}% is confirmed neither locked nor contract-held${missingHolders.length ? "; distribution is incomplete" : ""}` : "Holder distribution unavailable",
    providers(holders.length > 0, false), missingHolders));

  // Assess the largest measured unlocked provider even when another provider
  // locks half the liquidity. Unknown shares cannot be silently counted as zero.
  const lp = gp?.lp_holders ?? [];
  const missingLp: string[] = [];
  const providerCount = count(gp?.lp_holder_count);
  if (!lp.length || lp.length < Math.min(providerCount ?? 10, 10)) missingLp.push("top-liquidity-provider-list");
  if (providerCount !== null && providerCount < lp.length) missingLp.push("liquidity-provider-count");
  let accounted = 0;
  let lockedShare = 0;
  let biggest = 0;
  for (const [i, holder] of lp.entries()) {
    const proportion = fraction(holder.percent);
    const share = proportion === null ? null : proportion * 100;
    const locked = flag(holder.is_locked);
    if (share === null) missingLp.push(`lp_holders[${i}].percent`);
    if (locked === null) missingLp.push(`lp_holders[${i}].is_locked`);
    if (share !== null) {
      accounted += share;
      if (locked === true) lockedShare += share;
      if (locked === false) biggest = Math.max(biggest, share);
    }
  }
  const allProvidersListed = providerCount !== null && providerCount <= 10 && lp.length === providerCount;
  if (accounted <= 0 || accounted > 100.01 || (allProvidersListed && accounted < 99.99)) missingLp.push("liquidity-share-total");
  checks.push(makeCheck("liquidity", biggest >= 50 ? "fail" : biggest >= 25 ? "warn" : "pass",
    lp.length ? `${lockedShare.toFixed(1)}% of liquidity is reported locked or burned; the largest confirmed unlocked provider holds ${biggest.toFixed(1)}%${missingLp.length ? "; ownership data is incomplete" : ""}` : "Liquidity ownership unavailable",
    providers(lp.length > 0, false), missingLp));

  const creator = pct(gp?.creator_percent);
  checks.push(makeCheck("creator-stake", creator !== null && creator >= 20 ? "warn" : "pass",
    creator === null ? "Creator balance unavailable" : `The creator holds ${creator}% of supply`,
    providers(creator !== null, false), creator === null ? ["creator-percent"] : []));
  return checks;
}

// ---------------------------------------------------------------------------
// Who shipped this contract.
//
// The strongest shared trait of a rug is not in the bytecode, it is in the
// wallet that deployed it: a throwaway funded minutes earlier, used a handful
// of times, holding dust. That is cheap to establish - the explorer names the
// creator, and the chain itself gives an exact transaction count and balance
// that no indexer can be stale about.
// ---------------------------------------------------------------------------

const BLOCKSCOUT_ADDR = "https://base.blockscout.com/api/v2/addresses";
/** Below this, a wallet has barely been used; above it, it has a life. */
const THROWAWAY_TXS = 10;
const ESTABLISHED_TXS = 25;

export interface Deployer {
  address: string;
  /**
   * Which wallet this actually is. The contract's creator when an index knows
   * it; otherwise whoever opened the token's pool — a different question with
   * the same purpose, and for a launchpad launch usually the better answer,
   * since the creator there is just the factory.
   */
  basis: "contract-creator" | "pool-opener";
  isContract: boolean | null;
  txCount: number | null;
  balanceEth: number | null;
  firstSeen: string | null;
  ageHours: number | null;
  flaggedScam: boolean | null;
}

async function fromDeployer(token: string, issues: string[]): Promise<{ deployer: Deployer | null; flaggedScam: boolean | null }> {
  const res = await blockscoutFetch(`${BLOCKSCOUT_ADDR}/${token}`, {
    headers: { Accept: "application/json" },
  });
  const info = record(await res.json());
  if (!info) throw new InvalidSource("address");
  const creator = info.creator_address_hash;
  const flaggedScam = typeof info.is_scam === "boolean" ? info.is_scam : null;
  if (flaggedScam === null) issues.push("is_scam");
  // No creator on record is its own answer, and a different one from "the
  // lookup failed" — that case throws and is reported separately, because
  // telling a caller a contract is unindexed when we simply could not reach
  // the explorer is exactly the sort of confident wrong answer this endpoint
  // exists to avoid.
  if (!creator) return { deployer: null, flaggedScam };
  if (typeof creator !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(creator)) {
    issues.push("creator_address_hash");
    return { deployer: null, flaggedScam };
  }
  const deployer = await deployerFromCreator(creator, flaggedScam);
  if (deployer.isContract === null) issues.push("rpc.code");
  if (deployer.txCount === null) issues.push("rpc.transaction-count");
  if (deployer.balanceEth === null) issues.push("rpc.balance");
  return { deployer, flaggedScam };
}

/**
 * Everything about a creator that the chain itself can answer: whether it is a
 * contract, how used the wallet is, what it holds. Split out because the hard
 * part is only ever learning *who* the creator is — once we have an address,
 * this works off plain RPC and needs no explorer at all.
 *
 * `withAge` is the one part that still wants an explorer, so the caller can
 * turn it off when it already knows Blockscout is unreachable.
 */
async function deployerFromCreator(
  creator: string,
  flaggedScam: boolean | null,
  withAge = true,
  basis: Deployer["basis"] = "contract-creator",
): Promise<Deployer> {
  const [codeResult, nonceResult, balanceResult] = await Promise.allSettled([
    baseRpc<string>("eth_getCode", [creator, "latest"]),
    baseRpc<string>("eth_getTransactionCount", [creator, "latest"]),
    baseRpc<string>("eth_getBalance", [creator, "latest"]),
  ]);
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === "fulfilled" ? r.value : null);
  const code = value(codeResult);
  const nonceHex = value(nonceResult);
  const balanceHex = value(balanceResult);

  const isContract = typeof code === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(code) ? code !== "0x" : null;
  const quantity = (hex: unknown): number | null => {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
    const n = Number(BigInt(hex));
    return Number.isFinite(n) ? n : null;
  };
  const nonce = quantity(nonceHex);
  const txCount = nonce !== null && Number.isSafeInteger(nonce) ? nonce : null;
  const balance = quantity(balanceHex);

  // A wallet with few transactions fits on one page, so its first one - and
  // therefore its age - is one request away. A busy wallet is established by
  // definition, and paging back through it would buy nothing.
  let firstSeen: string | null = null;
  if (withAge && isContract === false && txCount !== null && txCount > 0 && txCount <= 50) {
    try {
      const txRes = await blockscoutFetch(`${BLOCKSCOUT_ADDR}/${creator}/transactions?filter=from`, {
        headers: { Accept: "application/json" },
      });
      const items = record(await txRes.json())?.items;
      const timestamp = Array.isArray(items) ? record(items[items.length - 1])?.timestamp : null;
      if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) <= Date.now()) firstSeen = timestamp;
    } catch {
      /* age is a bonus; the transaction count already carries the signal */
    }
  }

  return {
    address: creator.toLowerCase(),
    basis,
    isContract,
    txCount,
    balanceEth: balance === null ? null : balance / 1e18,
    firstSeen,
    ageHours:
      firstSeen === null ? null : Math.round((Date.now() - Date.parse(firstSeen)) / 3_600_000),
    flaggedScam,
  };
}

function deployerCheck(d: Deployer | null, lookupFailed: boolean, flaggedScam: boolean | null): Pick<Check, "id" | "status" | "detail"> {
  if (flaggedScam === true) {
    return { id: "deployer", status: "fail", detail: "The explorer flags this contract as a scam" };
  }
  if (lookupFailed) {
    return { id: "deployer", status: "unknown", detail: "The deployer could not be looked up right now" };
  }
  if (!d) {
    return {
      id: "deployer",
      status: "unknown",
      detail:
        "No creator is on record for this contract — it is either too new to be indexed or was deployed at genesis",
    };
  }
  if (d.isContract === null) {
    return { id: "deployer", status: "unknown", detail: "The deployer's contract code could not be read" };
  }
  // Launchpads deploy through a factory, so a contract creator is the normal
  // case there and says nothing about the wallet behind it either way.
  if (d.isContract) {
    return {
      id: "deployer",
      status: "pass",
      detail:
        d.basis === "pool-opener"
          ? `The pool was opened by a contract (${d.address.slice(0, 10)}…), typically a router or an aggregator`
          : `Deployed by a contract (${d.address.slice(0, 10)}…), which is how launchpads ship tokens`,
    };
  }
  if (d.txCount === null) {
    return { id: "deployer", status: "unknown", detail: "The deployer's activity could not be read" };
  }

  const age = d.ageHours === null ? "" : `, first active ${d.ageHours < 48 ? `${d.ageHours}h` : `${Math.round(d.ageHours / 24)}d`} ago`;
  const balance = d.balanceEth === null ? "" : ` and holds ${d.balanceEth.toFixed(5)} ETH`;
  const who = d.basis === "pool-opener" ? "The wallet that opened the pool has" : "The deployer is a wallet with";
  const body = `${who} ${d.txCount} transaction${d.txCount === 1 ? "" : "s"}${age}${balance}`;

  if (d.txCount < THROWAWAY_TXS) {
    return {
      id: "deployer",
      // A throwaway is a strong signal, not proof: plenty of honest launches
      // start from a fresh wallet, so this warns rather than condemns.
      status: "warn",
      detail: `${body} — consistent with a wallet created to launch one token`,
    };
  }
  if (d.txCount < ESTABLISHED_TXS) {
    return { id: "deployer", status: "warn", detail: `${body} — lightly used` };
  }
  return { id: "deployer", status: "pass", detail: body };
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
    const [gpResult, hpResult, depResult] = await Promise.all([
      observe((issues) => fromGoPlus(addr, issues)),
      observe((issues) => fromHoneypot(addr, issues)),
      observe((issues) => fromDeployer(addr, issues)),
    ]);
    const gp = gpResult.value;
    const hp = hpResult.value;
    const deployerFromBlockscout = depResult.value?.deployer ?? null;
    const flaggedScam = depResult.value?.flaggedScam ?? null;
    const sourceStatus: Record<string, SourceStatus> = {
      goplus: gpResult.source, "honeypot.is": hpResult.source, "blockscout+rpc": depResult.source,
    };

    if (!gp && !hp && flaggedScam !== true) {
      throw new Error("Both safety sources are unavailable right now — please retry");
    }

    // Blockscout is the only source that carries a scam flag, and also the
    // least reliable thing this endpoint touches: while it was down, and for
    // any token too new for it to have indexed, the deployer check went
    // "unchecked" on every call — 76% of the tokens in our own snapshots.
    // GoPlus has already told us who the creator is, and everything after
    // that is plain RPC, so fall back to it rather than giving up. Age is
    // skipped there: it is the one part that still needs an explorer, and we
    // would only be waiting out the same timeout twice.
    let deployer = deployerFromBlockscout;
    let deployerFailed = depResult.source.status === "unavailable" || depResult.source.status === "invalid";
    let deployerSource = deployer ? "blockscout+rpc" : null;
    if ((deployerFailed || !deployer) && gp?.creator_address) {
      const fallback = await observe(() => deployerFromCreator(gp.creator_address!, flaggedScam, false));
      sourceStatus["goplus+rpc"] = fallback.source;
      if (fallback.value) {
        deployer = fallback.value;
        deployerFailed = false;
        deployerSource = "goplus+rpc";
      }
    }

    // Last resort, and the only one that works on a token minutes old: if it
    // launched inside the fresh window, the chain knows who opened its pool
    // even though no index has heard of the token. A different question from
    // "who deployed the contract" — for a launchpad launch, a better one, and
    // the answer says which it is.
    if (!deployer) {
      try {
        const launcher = await launcherOf(addr);
        if (launcher) {
          const fallback = await observe(() => deployerFromCreator(launcher.address, flaggedScam, false, "pool-opener"));
          sourceStatus["fresh+rpc"] = fallback.source;
          if (fallback.value) {
            deployer = fallback.value;
            deployerFailed = false;
            deployerSource = "fresh+rpc";
          }
        }
      } catch {
        /* keep whatever the earlier attempts concluded */
      }
    }

    const depCheck = deployerCheck(deployer, deployerFailed, flaggedScam);
    const missingDeployer = !deployer ? ["deployer"] : [
      ...(deployer.isContract === null ? ["contract-code"] : []),
      ...(deployer.isContract !== true && deployer.txCount === null ? ["transaction-count"] : []),
      ...(deployer.flaggedScam === null ? ["scam-flag"] : []),
    ];
    const deployerSources = [...(deployerSource ? [deployerSource] : []),
      ...(flaggedScam !== null && deployerSource !== "blockscout+rpc" ? ["blockscout+rpc"] : [])];
    const checks = [...buildChecks(gp, hp), makeCheck("deployer", depCheck.status, depCheck.detail, deployerSources, missingDeployer)];
    const failed = checks.filter((c) => c.status === "fail");
    const warned = checks.filter((c) => c.status === "warn");
    const incomplete = checks.filter((c) => !c.complete);

    const sources: string[] = [];
    if (gp) sources.push("goplus");
    if (hp) sources.push("honeypot.is");
    if (deployerSource) sources.push(deployerSource);
    if (flaggedScam !== null && deployerSource !== "blockscout+rpc") sources.push("blockscout+rpc");

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
          : incomplete.length
            ? "insufficient-data"
            : "clear",
      failed: failed.map((c) => c.id),
      warnings: warned.map((c) => c.id),
      unchecked: incomplete.map((c) => c.id),
      checks,
      coverage: { complete: incomplete.length === 0, completedChecks: checks.length - incomplete.length, totalChecks: checks.length },
      deployer,
      holderCount: count(gp?.holder_count) ?? hp?.token?.totalHolders ?? null,
      listedOnCex: flag(gp?.is_in_cex?.listed) ? (gp?.is_in_cex?.cex_list ?? []) : [],
      sources,
      sourceStatus,
      disclaimer:
        "Automated checks against public data, not investment advice. Passing every check does not make a token safe.",
      at: new Date().toISOString(),
    };
  });
}
