import { payingFetch } from "../dist/pay.js";
import { createPaymentClient, HOSTED_URL, registeredEndpoint } from "../dist/payment-policy.js";

/** Parse before any wallet or HTTP work; a misspelled preview flag must not pay. */
export function automationOptions({ allowPath = false } = {}) {
  let mode;
  let path;
  for (const argument of process.argv.slice(2)) {
    if (argument === "--dry-run" || argument === "--quote-only") {
      if (mode) throw new Error("Choose only one of --dry-run and --quote-only.");
      mode = argument.slice(2);
    } else if (allowPath && argument.startsWith("--path=")) {
      if (path !== undefined || !argument.slice(7).trim()) throw new Error("Provide one nonempty --path.");
      path = argument.slice(7).trim();
    } else {
      throw new Error(`Unknown automation option: ${argument}`);
    }
  }
  const configuredMode = process.env.AGENTTOLL_MODE ?? "pay";
  if (!["pay", "dry-run", "quote-only"].includes(configuredMode)) {
    throw new Error("AGENTTOLL_MODE must be pay, dry-run, or quote-only.");
  }
  return { mode: mode ?? configuredMode, path };
}

/** Each scheduled operation owns a budget for one registered endpoint. */
export function automationPayment(requestPath, mode) {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
    throw new Error("Automation requires a registered endpoint path.");
  }
  const baseUrl = new URL(process.env.AGENTTOLL_URL ?? HOSTED_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  const network = process.env.AGENTTOLL_NETWORK ?? (local ? process.env.NETWORK ?? "base-sepolia" : "base");
  const recipient = process.env.AGENTTOLL_RECIPIENT ?? (local ? process.env.ADDRESS : undefined);
  const url = new URL(requestPath, baseUrl);
  const endpoint = registeredEndpoint(url.pathname);
  const amount = BigInt(endpoint.amount);
  const price = `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
  const options = {
    baseUrl: baseUrl.href, recipient,
    totalBudgetUsdc: process.env.AGENTTOLL_BUDGET_USDC ?? price,
    maxPerCallUsdc: process.env.AGENTTOLL_MAX_PER_CALL_USDC ?? price,
    timeoutMs: process.env.AGENTTOLL_TIMEOUT_MS === undefined ? undefined : Number(process.env.AGENTTOLL_TIMEOUT_MS),
  };
  // Validate origin, recipient, chain, limits and timeout even in offline mode.
  // Preview clients never construct a signing account or inspect the private key.
  let client = createPaymentClient(network, undefined, options);
  if (mode === "pay") {
    const key = process.env.AGENT_PRIVATE_KEY;
    if (!key) throw new Error("AGENT_PRIVATE_KEY missing; use --dry-run or --quote-only to inspect without paying.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("AGENT_PRIVATE_KEY must be a valid 32-byte hex private key.");
    client = payingFetch(key, network, options);
  }
  return { ...client, mode, path: requestPath, url: url.href };
}

export async function previewAutomation(client) {
  if (client.mode === "pay") return false;
  const quote = client.mode === "quote-only" ? await client.getPaymentQuote(client.path) : undefined;
  console.log(JSON.stringify({
    ok: true, mode: client.mode, path: client.path, url: client.url,
    ...(quote ? { quote } : {}), budget: client.getPaymentBudget(),
  }));
  return true;
}

export function automationFailure(error, client, context = {}) {
  console.error(JSON.stringify({
    ok: false, ...context,
    error: String(error instanceof Error ? error.message : error).slice(0, 300),
    ...(client ? { mode: client.mode, path: client.path, budget: client.getPaymentBudget() } : {}),
  }));
  process.exitCode = 1;
}
