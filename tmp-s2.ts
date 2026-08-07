import { getTokenSafety } from "./src/services/safety.js";
const CASES: [string, string][] = [
  ["AERO (olgun)", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"],
  ["openhuman (rug)", "0x74bb95da6692c34ee9755ac87ea10366653dbc77"],
  ["USDC (kurumsal)", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
];
for (const [label, addr] of CASES) {
  const t0 = Date.now();
  const r = await getTokenSafety(addr) as any;
  const d = r.deployer;
  console.log(`\n${label} (${Date.now()-t0}ms) -> ${r.verdict}`);
  console.log(`  deployer: ${d ? `${d.address.slice(0,12)}... contract=${d.isContract} tx=${d.txCount} bal=${d.balanceEth?.toFixed(5)} yas=${d.ageHours ?? "-"}h` : "BILINMIYOR"}`);
  console.log(`  check: ${r.checks.find((c: any) => c.id === "deployer")?.status} — ${r.checks.find((c: any) => c.id === "deployer")?.detail.slice(0, 95)}`);
}
