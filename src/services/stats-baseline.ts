export type StatsNetwork = "base" | "base-sepolia";

// This is a transfer-size heuristic, not proof that an API call was delivered.
export const MAX_TOLL_UNITS = 50_000n;
export const STATS_COUNTING_POLICY = "usdc-transfer-1-50000-v1";

export interface StatsBaseline {
  network: StatsNetwork;
  payTo: string;
  block: number;
  firstTollAt: string | null;
  lastTollAt: string | null;
  payers: Record<string, { calls: number; usdcUnits: string }>;
  schemaVersion?: 1;
  fromBlock?: number;
  blockHash?: string;
  countingPolicy?: string;
}

/** Validate before either the live reader or the snapshot writer trusts counts. */
export function parseStatsBaseline(input: unknown, payTo: string, network: StatsNetwork): StatsBaseline {
  const base = input as StatsBaseline | null;
  if (!base || base.network !== network || typeof base.payTo !== "string" || base.payTo.toLowerCase() !== payTo.toLowerCase()) {
    throw new Error(`No compatible stats baseline for network ${network} and recipient ${payTo}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(base.payTo)
    || !Number.isSafeInteger(base.block) || base.block < 0
    || !base.payers || typeof base.payers !== "object" || Array.isArray(base.payers)
    || ![base.firstTollAt, base.lastTollAt].every((value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value))))
    || (base.firstTollAt !== null && base.lastTollAt !== null && Date.parse(base.firstTollAt) > Date.parse(base.lastTollAt))) {
    throw new Error("Invalid stats baseline");
  }
  const addresses = new Set<string>();
  let calls = 0;
  for (const [addr, payer] of Object.entries(base.payers)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr) || addresses.has(addr.toLowerCase())
      || !payer || !Number.isSafeInteger(payer.calls) || payer.calls < 1
      || typeof payer.usdcUnits !== "string" || !/^\d+$/.test(payer.usdcUnits)
      || BigInt(payer.usdcUnits) < BigInt(payer.calls)
      || BigInt(payer.usdcUnits) > BigInt(payer.calls) * MAX_TOLL_UNITS) {
      throw new Error("Invalid stats baseline payer");
    }
    addresses.add(addr.toLowerCase());
    calls += payer.calls;
    if (!Number.isSafeInteger(calls)) throw new Error("Invalid stats baseline total");
  }
  const hasCheckpoint = [base.schemaVersion, base.fromBlock, base.blockHash, base.countingPolicy].some(value => value !== undefined);
  if (hasCheckpoint && (base.schemaVersion !== 1
    || !Number.isSafeInteger(base.fromBlock) || base.fromBlock! < 0 || base.fromBlock! > base.block
    || typeof base.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(base.blockHash)
    || base.countingPolicy !== STATS_COUNTING_POLICY
    || (calls > 0 && (base.firstTollAt === null || base.lastTollAt === null))
    || (calls === 0 && (base.firstTollAt !== null || base.lastTollAt !== null)))) {
    throw new Error("Invalid stats baseline checkpoint");
  }
  return base;
}
