/**
 * Example: an AI agent paying for an AgentToll API call with USDC via x402.
 *
 * Usage:
 *   1. Put a funded wallet key in .env as AGENT_PRIVATE_KEY.
 *      Testnet USDC: https://faucet.circle.com (select Base Sepolia).
 *   2. Start the server:  npm run dev
 *   3. Run this client:   npm run example:client
 *
 * The wrapped fetch automatically: reads the 402 quote, signs a USDC
 * authorization for the amount asked, retries with the payment header, and
 * receives the data. No gas needed on the client — the facilitator settles.
 *
 * Hosted API: https://agenttoll.app
 */
import "dotenv/config";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { payingFetch } from "../src/pay.js";

const BASE_URL = process.env.AGENTTOLL_URL ?? "http://localhost:4021";
const key = process.env.AGENT_PRIVATE_KEY;

if (!key) {
  console.error("Set AGENT_PRIVATE_KEY in .env to run the paying client example.");
  process.exit(1);
}

const { fetchWithPayment, address } = payingFetch(key);

console.log(`Agent wallet: ${address}`);
console.log(`Calling ${BASE_URL}/api/price/eth (price: $0.001) ...`);

const res = await fetchWithPayment(`${BASE_URL}/api/price/eth`, { method: "GET" });
console.log(`HTTP ${res.status}`);
console.log(await res.json());

const header = res.headers.get("payment-response");
if (header) {
  const receipt = decodePaymentResponseHeader(header);
  console.log("Payment receipt:", receipt);
  const tx = (receipt as { transaction?: string }).transaction;
  if (tx) {
    const explorer =
      (process.env.NETWORK ?? "base") === "base"
        ? "https://basescan.org"
        : "https://sepolia.basescan.org";
    console.log(`BaseScan: ${explorer}/tx/${tx}`);
  }
}
