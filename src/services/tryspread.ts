import { cached, fetchWithTimeout } from "./cache.js";
import { optionalEnum } from "./params.js";
import { getPrice } from "./prices.js";
import { officialUsdTry } from "./trypremium.js";

// Turkish exchange spread: what BTCTurk and Paribu actually quote in TRY,
// converted back to USD via the official rate and compared against the
// global USD price. /api/try/premium answers "how much more does crypto
// cost in lira"; this answers "which local exchange is charging that".
const ASSETS = {
  btc: { btcturk: "BTCTRY", paribu: "BTC_TL", global: "btc" },
  usdt: { btcturk: "USDTTRY", paribu: "USDT_TL", global: "usdt" },
} as const;

type Asset = keyof typeof ASSETS;

interface ExchangeQuote {
  name: string;
  try: number | null;
  impliedUsd: number | null;
  spreadPct: number | null;
  unavailable: boolean;
}

async function fromBtcTurk(pairSymbol: string): Promise<number> {
  const res = await fetchWithTimeout(
    `https://api.btcturk.com/api/v2/ticker?pairSymbol=${pairSymbol}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { pair: string; last: number }[] };
  const entry = data.data?.find((d) => d.pair === pairSymbol);
  if (!entry?.last) throw new Error(`no ${pairSymbol} entry from BTCTurk`);
  return entry.last;
}

async function fromParibu(pair: string): Promise<number> {
  const res = await fetchWithTimeout("https://www.paribu.com/ticker");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { last?: number }>;
  const last = data[pair]?.last;
  if (!last) throw new Error(`no ${pair} entry from Paribu`);
  return last;
}

async function quote(name: string, tryPrice: () => Promise<number>, official: number, globalUsd: number): Promise<ExchangeQuote> {
  try {
    const tryValue = await tryPrice();
    const impliedUsd = tryValue / official;
    return {
      name,
      try: tryValue,
      impliedUsd: Number(impliedUsd.toFixed(2)),
      spreadPct: Number(((impliedUsd / globalUsd - 1) * 100).toFixed(3)),
      unavailable: false,
    };
  } catch {
    return { name, try: null, impliedUsd: null, spreadPct: null, unavailable: true };
  }
}

export async function getTrySpread(assetRaw?: string) {
  const asset: Asset = optionalEnum("asset", assetRaw, Object.keys(ASSETS) as Asset[]) ?? "btc";
  const cfg = ASSETS[asset];

  return cached(`tryspread:${asset}`, 60_000, async () => {
    const [official, price] = await Promise.all([officialUsdTry(), getPrice(cfg.global)]);

    const exchanges = await Promise.all([
      quote("btcturk", () => fromBtcTurk(cfg.btcturk), official, price.usd),
      quote("paribu", () => fromParibu(cfg.paribu), official, price.usd),
    ]);

    if (exchanges.every((e) => e.unavailable)) {
      throw new Error("Both Turkish exchange sources are unavailable right now — please retry");
    }

    return {
      asset,
      officialUsdTry: official,
      globalUsd: price.usd,
      exchanges,
      at: new Date().toISOString(),
    };
  });
}
