import { cached, fetchWithTimeout } from "./cache.js";

// Toll stats derived straight from the chain: every payment is a USDC Transfer
// to the payTo address, so the counter cannot lie and needs no database.
// Source: Blockscout's indexer (keyless, paginated), network-aware.
const MAINNET = (process.env.NETWORK ?? "base-sepolia") === "base";
const BLOCKSCOUT = MAINNET
  ? "https://base.blockscout.com/api/v2"
  : "https://base-sepolia.blockscout.com/api/v2";
const USDC = MAINNET
  ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAX_PAGES = 20; // 50 transfers/page; raise when the tollbooth gets busy
// Tolls are micro-payments; anything bigger is the owner funding the wallet.
const MAX_TOLL_UNITS = 50_000n; // $0.05

// The wallet we run our own tests from. Counted like any other payer, but
// reported separately so "did anyone else pay yet" is answerable at a glance.
const OWN_TEST_WALLET = "0x5f871f89b13f5c7f570a765aa54c211323f36f78";

interface TransferPage {
  items: { total?: { value?: string }; from?: { hash?: string }; timestamp?: string }[];
  next_page_params: Record<string, string | number> | null;
}

export async function getStats(payTo: string) {
  return cached("stats", 300_000, async () => {
    let count = 0;
    let revenue = 0n;
    let truncated = false;
    let params = "";
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    const payers = new Map<string, { calls: number; usdc: bigint }>();

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchWithTimeout(
        `${BLOCKSCOUT}/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC}${params}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
      const json = (await res.json()) as TransferPage;

      for (const item of json.items) {
        const value = BigInt(item.total?.value ?? "0");
        if (value === 0n || value > MAX_TOLL_UNITS) continue;
        count += 1;
        revenue += value;

        const from = item.from?.hash?.toLowerCase();
        if (from) {
          const seen = payers.get(from) ?? { calls: 0, usdc: 0n };
          payers.set(from, { calls: seen.calls + 1, usdc: seen.usdc + value });
        }
        // Blockscout returns newest first, so the last one we see is the oldest.
        if (item.timestamp) {
          lastAt ??= item.timestamp;
          firstAt = item.timestamp;
        }
      }

      if (!json.next_page_params) break;
      if (page === MAX_PAGES - 1) truncated = true;
      params =
        "&" +
        Object.entries(json.next_page_params)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join("&");
    }

    const external = [...payers.entries()].filter(([addr]) => addr !== OWN_TEST_WALLET);
    const externalCalls = external.reduce((sum, [, p]) => sum + p.calls, 0);
    const externalRevenue = external.reduce((sum, [, p]) => sum + p.usdc, 0n);

    return {
      tollsCollected: count,
      revenueUsdc: Number(revenue) / 1e6,
      uniquePayers: payers.size,
      // Everything above minus our own test wallet: the honest adoption signal.
      externalPayers: external.length,
      externalTolls: externalCalls,
      externalRevenueUsdc: Number(externalRevenue) / 1e6,
      topPayers: [...payers.entries()]
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 5)
        .map(([address, p]) => ({
          address,
          calls: p.calls,
          usdc: Number(p.usdc) / 1e6,
          self: address === OWN_TEST_WALLET,
        })),
      firstTollAt: firstAt,
      lastTollAt: lastAt,
      truncated,
      network: MAINNET ? "base" : "base-sepolia",
      source: "onchain (USDC transfers to the payTo address, via Blockscout)",
      at: new Date().toISOString(),
    };
  });
}
