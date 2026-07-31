import { cached, fetchWithTimeout } from "./cache.js";

const BASE_RPC = "https://mainnet.base.org";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchWithTimeout(BASE_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Base RPC returned ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

// Snapshot of a Base address: ETH balance, tx count, contract or EOA.
export async function getAddressInfo(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error("Invalid address");
  }
  const addr = address.toLowerCase();
  return cached(`address:${addr}`, 15_000, async () => {
    const [balanceHex, nonceHex, code] = await Promise.all([
      rpc<string>("eth_getBalance", [addr, "latest"]),
      rpc<string>("eth_getTransactionCount", [addr, "latest"]),
      rpc<string>("eth_getCode", [addr, "latest"]),
    ]);
    return {
      chain: "base",
      address: addr,
      ethBalance: Number(BigInt(balanceHex)) / 1e18,
      txCount: Number(BigInt(nonceHex)),
      isContract: code !== "0x",
      at: new Date().toISOString(),
    };
  });
}
