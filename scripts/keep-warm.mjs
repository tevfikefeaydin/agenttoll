/**
 * Keeps our endpoints inside CDP's x402 Bazaar index.
 *
 * CDP drops a resource from discovery once it has gone 30 days without a
 * settled payment ("Resources that have been called at least once but have had
 * no activity in the last 30 days are excluded from results"). Until organic
 * traffic covers that on its own, this makes one real paid call a day, rotating
 * through the catalogue so every endpoint is touched roughly every two weeks.
 *
 * Costs about $0.002 a day. Run it from a scheduled task:
 *   node scripts/keep-warm.mjs
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";

// Only paid endpoints matter — free ones are never indexed by the facilitator.
const ENDPOINTS = [
  "/api/price/eth",
  "/api/gas",
  "/api/trending",
  "/api/feargreed",
  "/api/brief",
  "/api/try/premium",
  "/api/base/trending",
  "/api/base/radar",
  "/api/base/token/0x940181a94a35a4569e4529a3cdfb74e38fd98631",
  "/api/base/address/0xe55359021a6a22d8385b827405991c56075f56f8",
  "/api/base/portfolio/0x1985ea6e9c68e1c272d8209f3b478ac2fdb25c87?minValue=1000&limit=5",
  "/api/base/safety/0x940181a94a35a4569e4529a3cdfb74e38fd98631",
  "/api/base/scout?pools=1",
  "/api/base/fresh?minutes=10&limit=3",
  "/api/base/name/agenttoll.base.eth",
  "/api/watch/radar",
  "/api/watch/price/eth?ref=1900&pct=2",
  "/api/watch/address/0xe55359021a6a22d8385b827405991c56075f56f8",
];

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  console.error("AGENT_PRIVATE_KEY missing — cannot make a paid call.");
  process.exit(1);
}

// Rotate by day so a daily run covers the whole catalogue every two weeks.
const dayIndex = Math.floor(Date.now() / 86_400_000);
const path = ENDPOINTS[dayIndex % ENDPOINTS.length];

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: base, transport: http() });
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(toClientEvmSigner(account, publicClient)) }],
});

try {
  const started = Date.now();
  const res = await pay(`${BASE}${path}`, { method: "GET" });
  const receipt = res.headers.get("payment-response");
  const tx = receipt
    ? JSON.parse(Buffer.from(receipt, "base64").toString("utf8")).transaction
    : null;
  console.log(
    JSON.stringify({
      ok: res.ok,
      path,
      status: res.status,
      ms: Date.now() - started,
      tx,
      wallet: account.address,
    }),
  );
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  console.error(JSON.stringify({ ok: false, path, error: String(err.message).slice(0, 200) }));
  process.exit(1);
}
