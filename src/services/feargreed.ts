import { cached, fetchWithTimeout } from "./cache.js";
import { optionalInt } from "./params.js";

interface Reading {
  value: string;
  value_classification: string;
  timestamp: string;
}

// One upstream call covers every span a caller can ask for, so the history
// window is free and the provider only ever sees one request per TTL.
const MAX_DAYS = 30;

async function readings(): Promise<Reading[]> {
  return cached("feargreed", 300_000, async () => {
    const res = await fetchWithTimeout(`https://api.alternative.me/fng/?limit=${MAX_DAYS + 1}`);
    if (!res.ok) throw new Error(`Upstream index source returned ${res.status}`);
    const json = (await res.json()) as { data?: Reading[] };
    if (!json.data?.length) throw new Error("Upstream index source returned no readings");
    return json.data;
  });
}

/**
 * Crypto Fear & Greed index (alternative.me, free & keyless).
 * `days` (1-30) adds a daily history array — enough for an agent to see whether
 * sentiment is turning rather than just where it stands today.
 */
export async function getFearGreed(daysRaw?: string) {
  const days = optionalInt("days", daysRaw, { min: 1, max: MAX_DAYS });
  const data = await readings();
  const [today, yesterday] = data;
  const index = {
    value: Number(today.value),
    classification: today.value_classification,
    yesterday: yesterday ? Number(yesterday.value) : null,
    at: new Date().toISOString(),
  };
  if (days === undefined) return index;

  return {
    ...index,
    days,
    history: data.slice(0, days).map((r) => ({
      date: new Date(Number(r.timestamp) * 1000).toISOString(),
      value: Number(r.value),
      classification: r.value_classification,
    })),
  };
}
