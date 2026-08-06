/**
 * Turns today's scout output into a post-ready finding.
 *
 * One paid call to /api/base/scout - the radar and the safety checks composed
 * server-side - then prints the story the numbers tell, in English and
 * Turkish, ready to paste. The point is that the post IS the product: every
 * claim just came off the chain, and anyone can re-run the same call to
 * verify it.
 *
 *   node scripts/findings.mjs                 # top 3 pools ($0.008)
 *   FINDINGS_POOLS=4 node scripts/findings.mjs
 *
 * Needs AGENT_PRIVATE_KEY in .env (the test wallet). Never post the output
 * without reading it first - it quotes live token names, which can be
 * anything.
 */
import "dotenv/config";
import { payingFetch } from "../dist/pay.js";

const BASE = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";
const POOLS = Math.min(Number(process.env.FINDINGS_POOLS ?? 3), 4);

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("AGENT_PRIVATE_KEY eksik (.env) - odeme yapilamaz.");
  process.exit(1);
}
const { fetchWithPayment } = payingFetch(key, "base");

const res = await fetchWithPayment(`${BASE}/api/base/scout?minLiquidity=15000&pools=${POOLS}`, {
  method: "GET",
});
if (!res.ok) {
  console.error(`scout -> ${res.status}: ${(await res.text()).slice(0, 160)}`);
  process.exit(1);
}
const scout = await res.json();

const checked = scout.pools.filter((p) => p.safety);
if (!checked.length) {
  console.log(
    scout.pools.length
      ? "Havuzlar bulundu ama hicbiri kontrol edilemedi - sonra tekrar dene."
      : "Radar bugun bos - paylasacak bulgu yok. (Bu da durust bir sonuc.)",
  );
  process.exit(0);
}

const money = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;

// Verdict vocabulary (src/services/safety.ts):
// high-risk = a check failed · caution = warnings · insufficient-data · clear
const TAG = { "high-risk": "🔴", caution: "🟡", "insufficient-data": "⚪", clear: "🟢" };
const line = (p) => {
  const flags = [...(p.safety.failed ?? []), ...(p.safety.warnings ?? [])].slice(0, 3);
  return `${TAG[p.safety.verdict] ?? "🟡"} ${p.name} — liq ${money(p.liquidityUsd)}${flags.length ? ` · ${flags.join(", ")}` : ""}`;
};

const s = scout.summary;
const stamp = new Date().toISOString().slice(0, 10);
const out = [];
out.push("═".repeat(64));
out.push(`BULGU · ${stamp} · tek cagri, $0.008 (/api/base/scout)`);
out.push("═".repeat(64));
out.push("");
out.push("--- EN ---");
out.push(`Today on @base: ${s.found} new pools crossed $15k liquidity.`);
out.push(`Safety verdicts on the top ${s.checked}, from one API call:`);
out.push("");
checked.forEach((p) => out.push(line(p)));
out.push("");
if (s.highRisk) out.push(`${s.highRisk} of ${s.checked} failed a check that costs someone real money.`);
else if (s.caution) out.push(`None failed outright - but ${s.caution} carry warnings worth reading before you ape.`);
else out.push("A clean day - rare enough to be worth saying.");
out.push("");
out.push("One call, $0.008, verifiable by anyone:");
out.push("agenttoll.app/api/base/scout");
out.push("");
out.push("--- TR ---");
out.push(`Bugun @base'de ${s.found} yeni havuz $15k likidite esigini gecti.`);
out.push(`Ilk ${s.checked} tanesinin guvenlik karari, tek API cagrisiyla:`);
out.push("");
checked.forEach((p) => out.push(line(p)));
out.push("");
if (s.highRisk) out.push(`${s.checked} havuzdan ${s.highRisk} tanesi birinin parasina mal olacak bir kontrolden kaldi.`);
else if (s.caution) out.push(`Dupeduz kalan yok - ama ${s.caution} tanesi girmeden once okunmasi gereken uyarilar tasiyor.`);
else out.push("Temiz bir gun - soylemeye deger olacak kadar nadir.");
out.push("");
out.push("Tek cagri, $0.008, herkes dogrulayabilir:");
out.push("agenttoll.app/api/base/scout");
console.log(out.join("\n"));
