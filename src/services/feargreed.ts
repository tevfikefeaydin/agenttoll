import { cached } from "./cache.js";

// Crypto Fear & Greed index (alternative.me, free & keyless).
export async function getFearGreed() {
  return cached("feargreed", 300_000, async () => {
    const res = await fetch("https://api.alternative.me/fng/?limit=2");
    if (!res.ok) throw new Error(`Upstream index source returned ${res.status}`);
    const json = (await res.json()) as {
      data: { value: string; value_classification: string; timestamp: string }[];
    };
    const [today, yesterday] = json.data;
    return {
      value: Number(today.value),
      classification: today.value_classification,
      yesterday: yesterday ? Number(yesterday.value) : null,
      at: new Date().toISOString(),
    };
  });
}
