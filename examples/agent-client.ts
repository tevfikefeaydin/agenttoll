/**
 * Example: an AI agent paying for an AgentToll API call with USDC via x402.
 *
 * Usage:
 *   1. Put a funded Base Sepolia test wallet key in .env as AGENT_PRIVATE_KEY
 *      (get testnet USDC from https://faucet.circle.com — select Base Sepolia).
 *   2. Start the server:  npm run dev
 *   3. Run this client:   npm run example:client
 *
 * The wrapped fetch automatically: gets the 402 response, signs an EIP-3009
 * USDC authorization for the quoted price, retries with the X-PAYMENT header,
 * and receives the data. No gas needed on the client - the facilitator settles.
 */
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";

const BASE_URL = process.env.AGENTTOLL_URL ?? "http://localhost:4021";
const pk = process.env.AGENT_PRIVATE_KEY;

if (!pk) {
  console.error("Set AGENT_PRIVATE_KEY in .env to run the paying client example.");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
const fetchWithPay = wrapFetchWithPayment(fetch, account);

console.log(`Agent wallet: ${account.address}`);
console.log(`Calling ${BASE_URL}/api/price/eth (price: $0.001) ...`);

const res = await fetchWithPay(`${BASE_URL}/api/price/eth`, { method: "GET" });
console.log(`HTTP ${res.status}`);
console.log(await res.json());
