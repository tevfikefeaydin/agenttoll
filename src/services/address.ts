import { cached } from "./cache.js";
import { badRequest } from "./errors.js";
import { baseRpc } from "./sources.js";

// Snapshot of a Base address: ETH balance, tx count, contract or EOA.
export async function getAddressInfo(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    badRequest("Invalid address — expected 0x + 40 hex chars");
  }
  const addr = address.toLowerCase();
  return cached(`address:${addr}`, 15_000, async () => {
    const [balanceHex, nonceHex, code] = await Promise.all([
      baseRpc<string>("eth_getBalance", [addr, "latest"]),
      baseRpc<string>("eth_getTransactionCount", [addr, "latest"]),
      baseRpc<string>("eth_getCode", [addr, "latest"]),
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
