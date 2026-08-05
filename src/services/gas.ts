import { baseRpc } from "./sources.js";
import { getPrice } from "./prices.js";
import { optionalInt } from "./params.js";

/**
 * Current Base gas price and head block. Pass a gasLimit to also price a
 * transaction of that size — the question an agent actually has before it
 * decides whether to send one. 21,000 is a plain transfer; an ERC-20 transfer
 * is around 65,000; a swap is usually 150,000-300,000.
 */
export async function getGas(gasLimitRaw?: string) {
  const gasLimit = optionalInt("gasLimit", gasLimitRaw, { min: 21_000, max: 30_000_000 });

  const [gasPriceHex, blockNumberHex] = await Promise.all([
    baseRpc<string>("eth_gasPrice"),
    baseRpc<string>("eth_blockNumber"),
  ]);
  const gasPriceWei = BigInt(gasPriceHex);
  const gas = {
    chain: "base",
    gasPriceWei: gasPriceWei.toString(),
    gasPriceGwei: Number(gasPriceWei) / 1e9,
    latestBlock: Number(BigInt(blockNumberHex)),
    at: new Date().toISOString(),
  };
  if (gasLimit === undefined) return gas;

  // Costing the transaction needs an ETH price, so only fetch one when asked.
  const eth = await getPrice("eth");
  const ethCost = (Number(gasPriceWei) * gasLimit) / 1e18;
  return {
    ...gas,
    estimate: {
      gasLimit,
      ethCost: Number(ethCost.toFixed(12)),
      usdCost: Number((ethCost * eth.usd).toFixed(6)),
      ethUsd: eth.usd,
    },
  };
}
