import { fetchWithTimeout } from "./cache.js";

/** Only fixed diagnostic categories may be exposed in the public report. */
export class InvalidSafetySource extends Error {}
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const addressOf = (v: unknown) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
const validateAddress = (v: string) => {
  const address = addressOf(v);
  if (!address) throw new InvalidSafetySource("address");
  return address;
};

// These are provider allegations, not independently established facts. Context
// flags (e.g. mixers or sanctions) must never be labelled proof of a scam.
const maliciousFlags = ["cybercrime", "money_laundering", "financial_crime", "phishing_activities",
  "stealing_attack", "blackmail_activities", "malicious_mining_activities", "fake_token"] as const;
const reviewFlags = ["gas_abuse", "darkweb_transactions", "reinit", "fake_kyc", "blacklist_doubt",
  "fake_standard_interface", "sanctioned", "mixer", "honeypot_related_address"] as const;
export interface AddressRisk {
  complete: boolean;
  riskFlags: string[];
  reviewFlags: string[];
  maliciousContractsCreated: number | null;
  missing: string[];
}

export async function addressRisk(address: string, issues: string[]): Promise<AddressRisk> {
  const addr = validateAddress(address);
  const response = await fetchWithTimeout(`https://api.gopluslabs.io/api/v1/address_security/${addr}?chain_id=8453`, {
    headers: { Accept: "application/json" },
  }, 3000);
  if (!response.ok) throw new Error("Address risk source unavailable");
  const body = object(await response.json());
  const data = object(body?.result);
  if (body?.code !== 1 || !data) throw new InvalidSafetySource("response");
  const missing: string[] = [];
  const readFlags = (keys: readonly string[]) => keys.filter((key) => {
    const value = data[key];
    if (value === "1" || value === 1) return true;
    if (value !== "0" && value !== 0) missing.push(key);
    return false;
  });
  const riskFlags = readFlags(maliciousFlags);
  const warnings = readFlags(reviewFlags);
  const rawCount = data.number_of_malicious_contracts_created;
  const n = typeof rawCount === "number" ? rawCount :
    typeof rawCount === "string" && /^\d+$/.test(rawCount) ? Number(rawCount) : NaN;
  const maliciousContractsCreated = Number.isSafeInteger(n) && n >= 0 ? n : null;
  if (maliciousContractsCreated === null) missing.push("number_of_malicious_contracts_created");
  if (maliciousContractsCreated !== null && maliciousContractsCreated > 0) riskFlags.push("number_of_malicious_contracts_created");
  issues.push(...missing);
  return { complete: missing.length === 0, riskFlags, reviewFlags: warnings, maliciousContractsCreated, missing };
}

// An ABI describes an interface, not its permissions or behaviour. These hints
// never complete an owner-powers check, even when every known name is absent.
const relevantMethods = new Set(["mint", "configureMinter", "pause", "unpause", "blacklist", "unBlacklist",
  "transferOwnership", "renounceOwnership", "changeAdmin", "upgradeTo", "upgradeToAndCall"]);
export interface OwnerInterfaceEvidence {
  isProxy: boolean | null;
  methods: string[];
  implementationInspected: boolean;
}
export async function ownerInterface(address: string, issues: string[]): Promise<OwnerInterfaceEvidence | null> {
  const addr = validateAddress(address);
  // One shared deadline and at most one implementation: proxy graphs cannot
  // multiply requests or consume the whole paid endpoint's response budget.
  const signal = AbortSignal.timeout(5000);
  const load = async (target: string) => {
    const response = await fetchWithTimeout(`https://sourcify.dev/server/v2/contract/8453/${target}?fields=abi,proxyResolution`, {
      headers: { Accept: "application/json" }, signal,
    }, 3000);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Verified interface source unavailable");
    const data = object(await response.json());
    if (!data || String(data.chainId) !== "8453" || addressOf(data.address) !== target ||
      !["exact_match", "match"].includes(String(data.runtimeMatch)) || !Array.isArray(data.abi)) {
      throw new InvalidSafetySource("verified-interface");
    }
    return data;
  };
  const root = await load(addr);
  if (!root) return null;
  const methods = new Set<string>();
  const collect = (data: Record<string, unknown>) => {
    for (const item of (data.abi as unknown[]).slice(0, 1000)) {
      const entry = object(item);
      if (entry?.type === "function" && typeof entry.name === "string" && relevantMethods.has(entry.name)) methods.add(entry.name);
    }
  };
  collect(root);
  const proxy = object(root.proxyResolution);
  const isProxy = typeof proxy?.isProxy === "boolean" ? proxy.isProxy : null;
  if (isProxy === null) issues.push("proxy-resolution");
  let implementationInspected = false;
  if (isProxy) {
    const implementations = Array.isArray(proxy?.implementations) ? proxy.implementations : [];
    const target = implementations.length === 1 ? addressOf(object(implementations[0])?.address) : null;
    if (target && target !== addr) {
      try {
        const implementation = await load(target);
        if (implementation) { collect(implementation); implementationInspected = true; }
      } catch { /* preserve verified proxy interface; implementation stays unknown */ }
    }
    if (!implementationInspected) issues.push("implementation-interface");
  }
  return { isProxy, methods: [...methods].sort(), implementationInspected };
}

export interface PoolEvidence {
  observedPools: number;
  poolsWithLiquidity: number;
  reportedLiquidityUsd: number | null;
}
export async function poolEvidence(address: string, issues: string[]): Promise<PoolEvidence | null> {
  const addr = validateAddress(address);
  const response = await fetchWithTimeout(`https://api.dexscreener.com/token-pairs/v1/base/${addr}`, {
    headers: { Accept: "application/json" },
  }, 3000);
  if (!response.ok) throw new Error("Pool source unavailable");
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new InvalidSafetySource("pools");
  const pools = new Map<string, number | null>();
  for (const raw of data.slice(0, 100)) {
    const pair = object(raw);
    if (pair?.chainId !== "base") continue;
    const id = addressOf(pair.pairAddress);
    if (!id || ![object(pair.baseToken)?.address, object(pair.quoteToken)?.address].some(a => addressOf(a) === addr)) continue;
    const amount = object(pair.liquidity)?.usd;
    const liquidity = typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= Number.MAX_SAFE_INTEGER ? amount : null;
    if (pools.has(id)) {
      // Do not inflate the total with duplicate rows or pick one side of a disagreement.
      if (pools.get(id) !== liquidity) { pools.set(id, null); issues.push("conflicting-pool-liquidity"); }
    } else pools.set(id, liquidity);
  }
  if (!pools.size) return null;
  const amounts = [...pools.values()].filter((v): v is number => v !== null);
  if (amounts.length !== pools.size) issues.push("pool-liquidity");
  if (data.length > 100) issues.push("pool-limit");
  const sum = amounts.reduce((a, b) => a + b, 0);
  if (sum > Number.MAX_SAFE_INTEGER) issues.push("pool-liquidity-total");
  const total = amounts.length && sum <= Number.MAX_SAFE_INTEGER ? Math.round(sum * 100) / 100 : null;
  return { observedPools: pools.size, poolsWithLiquidity: amounts.length, reportedLiquidityUsd: total };
}
