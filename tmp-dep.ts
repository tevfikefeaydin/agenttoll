import { getFreshPools } from "./src/services/fresh.js";
const r = await getFreshPools("60", "10");
const tok = r.pools.find(p => p.token)?.token!;
console.log("test tokeni:", tok, "\n");

// 1) Blockscout adres kaydi: deployer + olusturma islemi var mi?
const a = await fetch(`https://base.blockscout.com/api/v2/addresses/${tok}`).then(x=>x.json()).catch(e=>({err:String(e)}));
console.log("addresses/{token} anahtarlari:", Object.keys(a).join(", ").slice(0, 300));
console.log("  creator:", a.creator_address_hash ?? "-", "| creation tx:", (a.creation_transaction_hash ?? a.creation_tx_hash ?? "-").slice(0,20));
console.log("  is_contract:", a.is_contract, "| verified:", a.is_verified);

const creator = a.creator_address_hash;
if (creator) {
  // 2) Deployer hakkinda ne var?
  const d = await fetch(`https://base.blockscout.com/api/v2/addresses/${creator}`).then(x=>x.json()).catch(()=>({}));
  console.log("\ndeployer anahtarlari:", Object.keys(d).join(", ").slice(0, 260));
  const c = await fetch(`https://base.blockscout.com/api/v2/addresses/${creator}/counters`).then(x=>x.json()).catch(()=>({}));
  console.log("counters:", JSON.stringify(c).slice(0, 240));
  // 3) RPC'den nonce ve bakiye (ucuz, kesin)
  const { baseRpc } = await import("./src/services/sources.js");
  const nonce = await baseRpc<string>("eth_getTransactionCount", [creator, "latest"]);
  const bal = await baseRpc<string>("eth_getBalance", [creator, "latest"]);
  console.log(`RPC: nonce=${Number(BigInt(nonce))} bakiye=${Number(BigInt(bal))/1e18} ETH`);
}
