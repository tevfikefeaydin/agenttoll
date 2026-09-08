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
 * authorization within the registered price and session budget, retries with PAYMENT-SIGNATURE, and
 * receives the data. No gas needed on the client — the facilitator settles.
 *
 * Hosted API: https://agenttoll.app
 */
import "dotenv/config";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { payingFetch } from "../src/pay.js";

const BASE_URL = (process.env.AGENTTOLL_URL ?? "http://localhost:4021").replace(/\/+$/, "");
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname);
const network = process.env.AGENTTOLL_NETWORK ?? (local ? process.env.NETWORK ?? "base-sepolia" : "base");
const recipient = process.env.AGENTTOLL_RECIPIENT ?? (local ? process.env.ADDRESS : undefined);
const key = process.env.AGENT_PRIVATE_KEY;

if (!key) {
  console.error("Set AGENT_PRIVATE_KEY in .env to run the paying client example.");
  process.exit(1);
}

const { fetchWithPayment, address, getPaymentBudget } = payingFetch(key, network, {
  baseUrl: BASE_URL,
  recipient,
  totalBudgetUsdc: process.env.AGENTTOLL_BUDGET_USDC,
  maxPerCallUsdc: process.env.AGENTTOLL_MAX_PER_CALL_USDC,
  timeoutMs: process.env.AGENTTOLL_TIMEOUT_MS === undefined ? undefined : Number(process.env.AGENTTOLL_TIMEOUT_MS),
});

console.log(`Agent wallet: ${address}`);
console.log("Payment budget:", getPaymentBudget());
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
      network === "base"
        ? "https://basescan.org"
        : "https://sepolia.basescan.org";
    console.log(`BaseScan: ${explorer}/tx/${tx}`);
  }
}
