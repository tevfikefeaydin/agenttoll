import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

/**
 * A fetch that pays x402 quotes automatically, for our own scripts and the
 * examples. x402 v2 needs the chain in CAIP-2 form and a scheme registration
 * per network, so this keeps that wiring in one place.
 */
export function payingFetch(privateKey: string, network = process.env.NETWORK ?? "base") {
  const mainnet = network === "base";
  const chain = mainnet ? base : baseSepolia;
  const caip2 = mainnet ? "eip155:8453" : "eip155:84532";

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain, transport: http() });
  const signer = toClientEvmSigner(account, publicClient);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: caip2, client: new ExactEvmScheme(signer) }],
  });

  return { fetchWithPayment, address: account.address };
}
