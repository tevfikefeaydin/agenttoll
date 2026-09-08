/**
 * Keeps our endpoints inside CDP's x402 Bazaar index.
 *
 * CDP drops a resource from discovery once it has gone 30 days without a
 * settled payment ("Resources that have been called at least once but have had
 * no activity in the last 30 days are excluded from results"). Until organic
 * traffic covers that on its own, this makes one real paid call a day, rotating
 * through the catalogue so every endpoint is touched well inside the window.
 *
 * It reads the catalogue rather than a list of its own. The list it used to
 * carry had drifted three endpoints behind ENDPOINTS, and because the Bazaar
 * indexes what the facilitator settles — not what /.well-known/x402 declares —
 * /api/try/spread, /api/base/radar/history and /api/base/scorecard were absent
 * from discovery for as long as they had existed. Deriving the paths means a
 * new endpoint is warmed without anyone remembering this file.
 *
 * Costs about $0.002 a day. Run it from a scheduled task:
 *   node scripts/keep-warm.mjs
 *   node scripts/keep-warm.mjs --path=/api/base/scorecard   # repair one now
 */
import "dotenv/config";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { ENDPOINTS } from "../dist/endpoints.js";

const BASE = process.env.AGENTTOLL_URL ?? "https://agenttoll.app";

// Which endpoints get warmed is the catalogue's business; how each one is
// called cheaply is this file's. A route's price is fixed, so nothing here
// changes what we pay — only how much work the call asks an upstream to do.
const PAY_TO = "0xe55359021a6a22d8385b827405991c56075f56f8";
const TUNING = {
  "/api/base/scout": { query: "?pools=1" },
  "/api/base/fresh": { query: "?minutes=10&limit=3" },
  "/api/base/scorecard": { query: "?days=1" },
  "/api/base/portfolio/{address}": { query: "?minValue=1000&limit=5" },
  "/api/watch/price/{symbol}": { query: "?ref=1900&pct=2" },
  // The catalogue's stand-in address is WETH, whose transaction history is far
  // too long for this endpoint to read inside the deadline — it answers 500
  // every time. Our own receiver is quiet enough to come back in a quarter of
  // a second, and a warming call only needs the route to settle.
  "/api/watch/address/{address}": { params: { address: PAY_TO } },
};

for (const path of Object.keys(TUNING)) {
  if (!ENDPOINTS.some((e) => e.path === path)) {
    throw new Error(`TUNING names ${path}, which the catalogue no longer has`);
  }
}

// Every path parameter already has a working stand-in in the catalogue — the
// same values the published examples are generated from.
const concrete = (endpoint) => {
  const tuning = TUNING[endpoint.path] ?? {};
  const params = { ...(endpoint.discovery?.pathParams ?? {}), ...(tuning.params ?? {}) };
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_, name) => {
    const value = params[name];
    if (value === undefined) throw new Error(`${endpoint.path}: no discovery.pathParams.${name} to call it with`);
    return encodeURIComponent(value);
  });
  return path + (tuning.query ?? "");
};

// A manual run can name one endpoint, so a listing that has already lapsed is
// repaired today instead of waiting for its turn in the rotation.
const asked = process.env.WARM_PATH?.trim() || process.argv.find((a) => a.startsWith("--path="))?.slice(7);
let path;
if (asked) {
  const endpoint = ENDPOINTS.find((e) => e.path === asked || concrete(e) === asked);
  if (!endpoint) {
    console.error(`No such endpoint: ${asked}\nCatalogue:\n${ENDPOINTS.map((e) => `  ${e.path}`).join("\n")}`);
    process.exit(1);
  }
  path = concrete(endpoint);
} else {
  // Rotate by day so a daily run covers the whole catalogue every three weeks.
  path = concrete(ENDPOINTS[Math.floor(Date.now() / 86_400_000) % ENDPOINTS.length]);
}

const key = process.env.AGENT_PRIVATE_KEY;
if (!key) {
  // Naming the path still makes this a useful dry run: it proves the catalogue
  // resolved to something callable without needing a funded wallet to find out.
  console.error(`AGENT_PRIVATE_KEY missing — would have paid for ${path}`);
  process.exit(1);
}

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
