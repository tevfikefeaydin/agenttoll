const TOKENS: [string, string][] = [
  ["AERO (olgun)", "0x940181a94A35A4569E4529A3CDfB74e38FD98631"],
  ["DEGEN (olgun)", "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"],
  ["openhuman (1 gun)", "0x74bb95da6692c34ee9755ac87ea10366653dbc77"],
  ["dun bulunan", "0x2007e797e750060f77fd92cd4e9dbbfb6cea5614"],
];
for (const [label, addr] of TOKENS) {
  const a = await fetch(`https://base.blockscout.com/api/v2/addresses/${addr}`).then(x=>x.json()).catch(()=>({}));
  console.log(`${label.padEnd(20)} creator=${(a.creator_address_hash ?? "YOK").slice(0,14).padEnd(14)} status=${a.creation_status ?? "-"} scam=${a.is_scam ?? "-"} verified=${a.is_verified ?? "-"}`);
}
// deployer'i olan biri icin sinyalleri olc
const a = await fetch(`https://base.blockscout.com/api/v2/addresses/0x74bb95da6692c34ee9755ac87ea10366653dbc77`).then(x=>x.json());
const creator = a.creator_address_hash;
if (creator) {
  const c = await fetch(`https://base.blockscout.com/api/v2/addresses/${creator}/counters`).then(x=>x.json()).catch(()=>({}));
  console.log(`\ndeployer ${creator}`);
  console.log("counters:", JSON.stringify(c));
  const { baseRpc } = await import("./src/services/sources.js");
  const nonce = Number(BigInt(await baseRpc<string>("eth_getTransactionCount", [creator, "latest"])));
  const bal = Number(BigInt(await baseRpc<string>("eth_getBalance", [creator, "latest"]))) / 1e18;
  console.log(`RPC: nonce=${nonce} bakiye=${bal.toFixed(6)} ETH`);
  // ilk islem zamani (cuzdan yasi) - en eski sayfaya bakmak pahali mi?
  const t0 = Date.now();
  const txs = await fetch(`https://base.blockscout.com/api/v2/addresses/${creator}/transactions?filter=from`).then(x=>x.json()).catch(()=>({}));
  console.log(`ilk sayfa ${txs.items?.length ?? 0} islem, ${Date.now()-t0}ms | en yeni: ${txs.items?.[0]?.timestamp ?? "-"}`);
}
