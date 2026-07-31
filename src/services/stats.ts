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

interface TransferPage {
  items: { total?: { value?: string } }[];
  next_page_params: Record<string, string | number> | null;
}

export async function getStats(payTo: string) {
  return cached("stats", 300_000, async () => {
    let count = 0;
    let revenue = 0n;
    let truncated = false;
    let params = "";
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
      }
      if (!json.next_page_params) break;
      if (page === MAX_PAGES - 1) truncated = true;
      params =
        "&" +
        Object.entries(json.next_page_params)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join("&");
    }
    return {
      tollsCollected: count,
      revenueUsdc: Number(revenue) / 1e6,
      truncated,
      network: MAINNET ? "base" : "base-sepolia",
      source: "onchain (USDC transfers to the payTo address, via Blockscout)",
      at: new Date().toISOString(),
    };
  });
}
