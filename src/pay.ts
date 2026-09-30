import { privateKeyToAccount } from "viem/accounts";
import { toClientEvmSigner } from "@x402/evm";
import { createPaymentClient, type PaymentClientOptions } from "./payment-policy.js";

/**
 * Automatically pays registered AgentToll endpoints within a finite session
 * budget (1 USDC by default). Custom origins require an explicit recipient.
 * Inspect getPaymentBudget() after failures: signed authorizations remain reserved.
 */
export function payingFetch(privateKey: string, network = process.env.NETWORK ?? "base", options: PaymentClientOptions = {}) {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return { ...createPaymentClient(network, toClientEvmSigner(account), options), address: account.address };
}
