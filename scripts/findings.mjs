/**
 * Turns today's radar + safety output into a post-ready finding.
 *
 * Pays for one radar call and a safety check on each of the top pools, then
 * prints the story the numbers tell, in English and Turkish, ready to paste.
 * The point is that the post IS the product: every claim in it just came off
 * the chain, and anyone can re-run the same two calls to verify it.
 *
 *   node scripts/findings.mjs            # top 4 pools (~$0.011)
 *   FINDINGS_POOLS=6 node scripts/findings.mjs
 *
 * Needs AGENT_PRIVATE_KEY in .env (the test wallet). Never post the output
 * without reading it first - it quotes live token names, which can be
 * anything.
 */
import "dotenv/config";
import { payingFetch } from "../dist/pay.js";

const BASE = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";
const POOLS = Math.min(Number(process.env.FINDINGS_POOLS ?? 4), 8);

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("AGENT_PRIVATE_KEY eksik (.env) - odeme yapilamaz.");
  process.exit(1);
}
const { fetchWithPayment } = payingFetch(key, "base");

async function paidJson(path) {
  const res = await fetchWithPayment(`${BASE}${path}`, { method: "GET" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

const money = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;

// 1) Radar: today's new pools with real liquidity.
const radar = await paidJson(`/api/base/radar?minLiquidity=15000&limit=${POOLS}`);
const pools = radar.pools.filter((p) => p.token);
if (!pools.length) {
  console.log("Radar bugun bos - paylasacak bulgu yok. (Bu da durust bir sonuc.)");
  process.exit(0);
}

// 2) Safety on each - sequentially, the upstreams rate-limit bursts.
const checked = [];
for (const pool of pools) {
  try {
    const s = await paidJson(`/api/base/safety/${pool.token}`);
    checked.push({ pool, safety: s });
    console.error(`  kontrol: ${pool.name} -> ${s.verdict}`);
  } catch (err) {
    console.error(`  atlandi: ${pool.name} (${String(err.message).slice(0, 60)})`);
  }
}
if (!checked.length) {
  console.log("Hicbir havuz kontrol edilemedi - upstream'ler yorgun, sonra tekrar dene.");
  process.exit(1);
}

// The service's verdict vocabulary (src/services/safety.ts):
// high-risk = a check failed · caution = warnings · insufficient-data · clear
const bad = checked.filter((c) => c.safety.verdict === "high-risk");
const risky = checked.filter((c) => !bad.includes(c) && c.safety.verdict !== "clear");
const cost = (0.003 + checked.length * 0.002).toFixed(3);

const TAG = { "high-risk": "🔴", caution: "🟡", "insufficient-data": "⚪", clear: "🟢" };
const line = (c) => {
  const flags = [...(c.safety.failed ?? []), ...(c.safety.warnings ?? [])].slice(0, 3);
  return `${TAG[c.safety.verdict] ?? "🟡"} ${c.pool.name} — liq ${money(c.pool.liquidityUsd)}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
};

const stamp = new Date().toISOString().slice(0, 10);
const out = [];
out.push("═".repeat(64));
out.push(`BULGU · ${stamp} · toplam maliyet $${cost} (2 endpoint, ${checked.length + 1} cagri)`);
out.push("═".repeat(64));
out.push("");
out.push("--- EN ---");
out.push(`Today on @base: ${radar.count} new pools crossed $15k liquidity.`);
out.push(`We ran safety checks on the top ${checked.length}:`);
out.push("");
checked.forEach((c) => out.push(line(c)));
out.push("");
if (bad.length) out.push(`${bad.length} of ${checked.length} failed a check that costs someone real money.`);
else if (risky.length) out.push(`None failed outright - but ${risky.length} carry warnings worth reading before you ape.`);
else out.push("A clean day - rare enough to be worth saying.");
out.push("");
out.push(`Two calls, $${cost}, verifiable by anyone:`);
out.push("agenttoll.app/api/base/radar -> /api/base/safety/{token}");
out.push("");
out.push("--- TR ---");
out.push(`Bugun @base'de ${radar.count} yeni havuz $15k likidite esigini gecti.`);
out.push(`Ilk ${checked.length} tanesine guvenlik kontrolu yaptik:`);
out.push("");
checked.forEach((c) => out.push(line(c)));
out.push("");
if (bad.length) out.push(`${checked.length} havuzdan ${bad.length} tanesi birinin parasina mal olacak bir kontrolden kaldi.`);
else if (risky.length) out.push(`Dupeduz kalan yok - ama ${risky.length} tanesi girmeden once okunmasi gereken uyarilar tasiyor.`);
else out.push("Temiz bir gun - soylemeye deger olacak kadar nadir.");
out.push("");
out.push(`Iki cagri, $${cost}, herkes dogrulayabilir:`);
out.push("agenttoll.app/api/base/radar -> /api/base/safety/{token}");
console.log(out.join("\n"));
