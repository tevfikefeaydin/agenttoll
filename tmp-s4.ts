import { getTokenSafety } from "./src/services/safety.js";
for (const [label, addr] of [["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"], ["WETH (genesis)", "0x4200000000000000000000000000000000000006"]] as [string,string][]) {
  try {
    const r = await getTokenSafety(addr) as any;
    const dc = r.checks.find((c: any) => c.id === "deployer");
    console.log(`${label}: ${r.verdict} | deployer ${dc.status} — ${dc.detail.slice(0, 88)}`);
  } catch (e) { console.log(`${label}: kaynak hatasi (${String((e as Error).message).slice(0,40)})`); }
  await new Promise(r => setTimeout(r, 3000));
}
