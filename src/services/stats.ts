import { cached, fetchWithTimeout } from "./cache.js";

// Toll stats derived straight from the chain: every payment is a USDC Transfer
// to the payTo address, so the counter cannot lie and needs no database.
// Source: Blockscout's indexer for Base Sepolia (keyless, paginated).
const BLOCKSCOUT = "https://base-sepolia.blockscout.com/api/v2";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAX_PAGES = 20; // 50 transfers/page; raise when the tollbooth gets busy

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
        `${BLOCKSCOUT}/addresses/${payTo}/token-transfers?type=ERC-20&filter=to&token=${USDC_SEPOLIA}${params}`,
        { headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`Indexer returned ${res.status}`);
      const json = (await res.json()) as TransferPage;
      for (const item of json.items) {
        count += 1;
        revenue += BigInt(item.total?.value ?? "0");
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
      network: "base-sepolia",
      source: "onchain (USDC transfers to the payTo address, via Blockscout)",
      at: new Date().toISOString(),
    };
  });
}
