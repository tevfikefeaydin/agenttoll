import { cached, fetchWithTimeout } from "./cache.js";
import { optionalInt } from "./params.js";

interface Reading {
  value: number;
  classification: string;
  at: string | null;
}

// One upstream call covers every span a caller can ask for, so the history
// window is free and the provider only ever sees one request per TTL.
const MAX_DAYS = 30;

function reading(input: unknown): Reading {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid sentiment reading");
  const raw = input as Record<string, unknown>;
  const value = typeof raw.value === "number" || (typeof raw.value === "string" && raw.value.trim()) ? Number(raw.value) : NaN;
  if (!Number.isInteger(value) || value < 0 || value > 100 || typeof raw.value_classification !== "string" || !raw.value_classification.trim()) {
    throw new Error("Invalid sentiment reading");
  }
  const timestamp = typeof raw.timestamp === "number" || (typeof raw.timestamp === "string" && /^\d+$/.test(raw.timestamp))
    ? Number(raw.timestamp) : NaN;
  const at = Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= Math.floor(Date.now() / 1000)
    ? new Date(timestamp * 1000).toISOString() : null;
  return { value, classification: raw.value_classification, at };
}

async function readings(): Promise<{ data: Reading[]; fetchedAt: string }> {
  return cached("feargreed", 300_000, async () => {
    const res = await fetchWithTimeout(`https://api.alternative.me/fng/?limit=${MAX_DAYS + 1}`);
    if (!res.ok) throw new Error(`Upstream index source returned ${res.status}`);
    const json = (await res.json()) as { data?: unknown };
    if (!Array.isArray(json?.data) || !json.data.length) throw new Error("Upstream index source returned no readings");
    return { data: json.data.map(reading), fetchedAt: new Date().toISOString() };
  });
}

/**
 * Crypto Fear & Greed index (alternative.me, free & keyless).
 * `days` (1-30) adds a daily history array — enough for an agent to see whether
 * sentiment is turning rather than just where it stands today.
 */
export async function getFearGreed(daysRaw?: string) {
  const days = optionalInt("days", daysRaw, { min: 1, max: MAX_DAYS });
  const { data, fetchedAt } = await readings();
  const [today, yesterday] = data;
  const index = {
    value: today.value,
    classification: today.classification,
    yesterday: yesterday?.value ?? null,
    at: today.at,
    fetchedAt,
  };
  if (days === undefined) return index;

  return {
    ...index,
    days,
    history: data.slice(0, days).map((r) => ({
      date: r.at,
      value: r.value,
      classification: r.classification,
    })),
  };
}
