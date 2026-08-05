import { baseRpc } from "./sources.js";

export async function getGas() {
  const [gasPriceHex, blockNumberHex] = await Promise.all([
    baseRpc<string>("eth_gasPrice"),
    baseRpc<string>("eth_blockNumber"),
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
