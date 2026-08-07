import { getTokenSafety } from "./src/services/safety.js";
const r = await getTokenSafety("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as any;
console.log("USDC verdict:", r.verdict);
for (const c of r.checks) console.log(`  ${c.status.padEnd(8)} ${c.id}`);
console.log("\nunchecked:", r.unchecked.join(", "));
// Blockscout USDC icin creator veriyor mu, ham kontrol
const a = await fetch("https://base.blockscout.com/api/v2/addresses/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").then(x=>x.json());
console.log("\nham blockscout: creator =", a.creator_address_hash ?? "null", "| is_contract =", a.is_contract, "| proxy impl =", (a.implementations?.length ?? 0));
