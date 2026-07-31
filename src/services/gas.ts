const BASE_RPC = "https://mainnet.base.org";

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC returned ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export async function getGas() {
  const [gasPriceHex, blockNumberHex] = await Promise.all([
    rpc<string>("eth_gasPrice"),
    rpc<string>("eth_blockNumber"),
  ]);
  const gasPriceWei = BigInt(gasPriceHex);
  return {
    chain: "base",
    gasPriceWei: gasPriceWei.toString(),
    gasPriceGwei: Number(gasPriceWei) / 1e9,
    latestBlock: Number(BigInt(blockNumberHex)),
    at: new Date().toISOString(),
  };
}
