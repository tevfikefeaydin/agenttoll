import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExpressAdapter, paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { getPrice } from "./services/prices.js";
import { getGas } from "./services/gas.js";
import { getTrending } from "./services/trending.js";
import { getBaseTokenPrice } from "./services/basetoken.js";
import { getAddressInfo } from "./services/address.js";
import { getFearGreed } from "./services/feargreed.js";
import { getBaseTrending } from "./services/basetrending.js";
import { getMarketBrief } from "./services/brief.js";
import { getStats } from "./services/stats.js";
import { getAddressActivity, getRadarSince, getPriceAlert } from "./services/watch.js";
import { errorResponse } from "./services/errors.js";
import { resolveBasename } from "./services/basename.js";
import { getNewTokenRadar } from "./services/radar.js";
import { getPortfolio } from "./services/portfolio.js";
import { getTokenSafety } from "./services/safety.js";
import { getScout } from "./services/scout.js";
import { getFreshPools } from "./services/fresh.js";
import { getRadarHistory, getScorecard } from "./services/history.js";
import { getTryPremium } from "./services/trypremium.js";
import { getTrySpread } from "./services/tryspread.js";

import { randomUUID } from "node:crypto";
import { readConfig } from "./config.js";
import { ENDPOINTS } from "./endpoints.js";
import { requestContext, withSignal, type RequestContext } from "./request-context.js";
import { cached } from "./services/cache.js";
import { baseRpc } from "./services/sources.js";
import { canonicalRoute, installPaymentDiagnosticFilter } from "./telemetry.js";
import { declineReason, inspectPayment, paymentSnapshot, paymentTelemetry, publicPayer, publicTransaction, sanitizedClient } from "./payment-telemetry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = readConfig();
const PAY_TO = config.payTo;
export const NETWORK = config.network;
export const PORT = config.port;
const CHAIN = config.chain;
const PUBLIC_BASE = config.publicUrl;
installPaymentDiagnosticFilter(() => Boolean(requestContext.getStore()?.payment));
const facilitatorHttp = new HTTPFacilitatorClient({
  ...(config.useCdp ? cdpFacilitator : { url: config.facilitatorUrl }),
  timeoutMs: Math.min(config.requestTimeoutMs, 8_000),
});

// The SDK's per-attempt timeout does not bound retries or the combined
// verify/handler/settle operation. Reuse the request's remaining deadline.
async function facilitatorCall<T>(load: () => Promise<T>, phase?: 'verify' | 'settle'): Promise<T> {
  const context = requestContext.getStore();
  const signal = context?.signal ?? AbortSignal.timeout(config.requestTimeoutMs);
  const payment = context?.payment;
  const settling = phase === 'settle';
  let started: number | undefined;
  try {
    signal.throwIfAborted();
    if (context && settling) context.settlementStarted = true;
    if (payment && phase) {
      started = Date.now();
      payment.paymentPhase = phase;
      payment.activeFacilitator = { phase, started };
      payment[settling ? 'facilitatorSettleCalls' : 'facilitatorVerifyCalls']++;
    }
    const result = await withSignal(Promise.resolve().then(() => { signal.throwIfAborted(); return load(); }), signal);
    if (payment && phase) {
      const response = result as { isValid?: boolean; success?: boolean; invalidReason?: string; errorReason?: string; payer?: string; transaction?: string };
      if (settling ? response.success === true : response.isValid === true) {
        payment.paymentReason = null;
        // Only successful, SDK-validated facilitator results establish public identity.
        if (!settling) payment.verifiedPayer = publicPayer(response.payer);
        if (settling) {
          payment.settlementConfirmed = true;
          payment.settlementTransaction = publicTransaction(response.transaction);
        }
      } else payment.paymentReason = declineReason(settling ? response.errorReason : response.invalidReason, settling);
    }
    return result;
  } catch (error) {
    // Structured payment declines belong to x402's 402 response path.
    // Only transport/protocol failures should become sanitized upstream errors.
    if (error instanceof VerifyError || error instanceof SettleError) {
      const reason = declineReason(error instanceof VerifyError ? error.invalidReason : error.errorReason, settling);
      if (payment) payment.paymentReason = reason;
      // SDK error paths may echo messages. Forward only fixed, allowlisted reasons.
      if (error instanceof VerifyError) throw new VerifyError(error.statusCode, { isValid: false, invalidReason: reason });
      throw new SettleError(error.statusCode, { success: false, errorReason: reason, transaction: '', network: CHAIN });
    }
    const name = error instanceof Error ? error.name : '';
    const timeout = name === 'TimeoutError' || name === 'FacilitatorTimeoutError';
    const safe = new DOMException(timeout ? 'Facilitator deadline exceeded' : 'Facilitator unavailable', timeout ? 'TimeoutError' : 'Error');
    if (context) context.facilitatorFailure = safe;
    if (payment) payment.paymentReason = signal.aborted && signal.reason?.name === 'AbortError' ? 'client_disconnected' : timeout ? 'request_timeout' : 'facilitator_unavailable';
    throw safe;
  } finally {
    if (payment && started !== undefined) {
      payment[settling ? 'facilitatorSettleMs' : 'facilitatorVerifyMs'] += Math.max(0, Date.now() - started);
      delete payment.activeFacilitator;
    }
  }
}
const facilitatorClient: FacilitatorClient = {
  getSupported: () => facilitatorCall(() => facilitatorHttp.getSupported()),
  verify: (payload, requirements) => facilitatorCall(() => facilitatorHttp.verify(payload, requirements), 'verify'),
  settle: (payload, requirements) => facilitatorCall(() => facilitatorHttp.settle(payload, requirements), 'settle'),
};

const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");
const normalizedPath = (value: string) => value.toLowerCase().replace(/\/+$/, "") || "/";

app.use((req, res, next) => {
  const method = req.method;
  const paymentSubmitted = Boolean(req.get("payment-signature") || req.get("x-payment"));
  const payment = paymentTelemetry(req.get('payment-signature'), req.get('x-payment'));
  const client = sanitizedClient(req.get('x-agenttoll-client'), req.get('user-agent'));
  let responseCode: string | null = null;
  const controller = new AbortController();
  const context: RequestContext = { requestId: randomUUID(), signal: controller.signal, upstreamCalls: 0,
    cacheHits: 0, cacheMisses: 0, coalescedLoads: 0, payment };
  res.setHeader("X-Request-Id", context.requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  const originalJson = res.json.bind(res);
  // x402 can send facilitator errors directly, without Express's error handler.
  res.json = (body: unknown) => {
    const upstreamFailure = context.facilitatorFailure ?? (context.signal.aborted ? context.signal.reason : undefined);
    const structured = body && typeof body === "object" && "requestId" in body && body.requestId === context.requestId;
    if (res.statusCode >= 400 && (upstreamFailure || (res.statusCode !== 402 && !structured))) {
      const result = errorResponse(upstreamFailure ?? { status: res.statusCode }, context.requestId);
      res.status(result.status);
      if (result.body.retryAfter) res.setHeader("Retry-After", String(result.body.retryAfter));
      body = result.body;
      if (context.settlementStarted) {
        res.removeHeader("Retry-After");
        body = { ...result.body, error: "Payment settlement could not be confirmed; inspect your receipt and wallet before retrying", retryable: false, retryAfter: null, paymentOutcome: "unknown" };
      }
    }
    if (body && typeof body === "object" && "code" in body && typeof body.code === "string" &&
      ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'REQUEST_TIMEOUT', 'UPSTREAM_UNAVAILABLE', 'NOT_READY', 'OVERLOADED', 'RATE_LIMITED', 'PAYMENT_UPGRADE_REQUIRED', 'MALFORMED_PAYMENT'].includes(body.code)) responseCode = body.code;
    return originalJson(body);
  };
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), config.requestTimeoutMs);
  timer.unref();
  let terminalLogged = false;
  const terminal = (event: 'finish' | 'abort') => {
    if (terminalLogged) return;
    terminalLogged = true;
    clearTimeout(timer);
    if (!/^\/(api|\.well-known)\//i.test(req.path)) return;
    const status = event === 'abort' ? 499 : res.statusCode;
    const settled = payment.settlementConfirmed;
    const paymentStage = settled ? "settled" : status === 402 ? (paymentSubmitted ? "rejected" : "quote") :
      context.settlementStarted ? "unknown" : paymentSubmitted ? "submitted" : "none";
    const abortReason = event === 'abort' ? (context.signal.reason?.name === 'TimeoutError' ? 'request_timeout' : 'client_disconnected') : null;
    if (abortReason) payment.paymentReason = abortReason;
    else if (context.signal.aborted) payment.paymentReason = 'request_timeout';
    else if (paymentStage === 'quote') payment.paymentReason = 'payment_required';
    else if (paymentStage === 'rejected' && !payment.paymentReason) payment.paymentReason = 'payment_invalid';
    else if (payment.paymentPhase === 'handler' && status >= 400) payment.paymentReason = 'handler_failed';
    const route = canonicalRoute(req.path);
    const log = status >= 500 ? console.error : console.log;
    log(JSON.stringify({ schemaVersion: 2, t: new Date().toISOString(), requestId: context.requestId,
      method, path: route, route, status, ms: Date.now() - started,
      terminal: event, abortReason, client, ...paymentSnapshot(payment),
      paymentStage, paymentSubmitted, errorCode: responseCode,
      upstreamCalls: context.upstreamCalls, cacheHits: context.cacheHits,
      cacheMisses: context.cacheMisses, coalescedLoads: context.coalescedLoads }));
  };
  res.once('close', () => {
    clearTimeout(timer);
    if (!res.writableFinished) {
      if (!controller.signal.aborted) controller.abort(new DOMException('Client disconnected', 'AbortError'));
      terminal('abort');
    }
  });
  res.once('finish', () => terminal('finish'));
  requestContext.run(context, next);
});

// Permit legacy headers only to deliver explicit v2 migration guidance.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, X-AgentToll-Client");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, X-Request-Id, Retry-After");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  // Express serves HEAD via GET. Meter it and challenge it before any data load.
  if (req.method === "HEAD") req.method = "GET";
  next();
});

const FREE_ENDPOINTS = [
  { path: "/api/stats", description: "Onchain tolls and distinct paying wallets for this deployment's payment network and receiving address" },
  { path: "/api/demo", description: "Static sample response shapes for every paid endpoint" },
  { path: "/api/health", description: "Process liveness and configured networks" },
  { path: "/api/ready", description: "Bounded facilitator and Base RPC readiness check" },
  { path: "/api/catalog", description: "This catalog" },
];
const FREE_PATHS = new Set([...FREE_ENDPOINTS.map(e => e.path), "/.well-known/x402", "/.well-known/agent-card.json"]);
const hits = new Map<string, { n: number; reset: number }>();
app.use((req, res, next) => {
  const pathname = normalizedPath(req.path);
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/.well-known/")) return next();
  const free = FREE_PATHS.has(pathname);
  const max = free ? 60 : 600;
  const now = Date.now();
  const key = `${free ? "free" : "paid"}:${req.ip ?? "?"}`;
  let slot = hits.get(key);
  if (!slot || slot.reset <= now) {
    // Expire old buckets without clearing active clients' limits.
    if (hits.size >= 5000) for (const [id, entry] of hits) if (entry.reset <= now) hits.delete(id);
    if (hits.size >= 5000) { res.setHeader("Retry-After", "60"); res.status(503).json({ error: "Rate limiter at capacity", code: "OVERLOADED", retryable: true, retryAfter: 60, requestId: res.getHeader("X-Request-Id") }); return; }
    slot = { n: 0, reset: now + 60_000 }; hits.set(key, slot);
  }
  if (++slot.n > max) {
    const retryAfter = Math.max(1, Math.ceil((slot.reset - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: `Rate limited: at most ${max} calls a minute per IP`, code: "RATE_LIMITED", retryable: true, retryAfter, requestId: res.getHeader("X-Request-Id") });
    return;
  }
  next();
});
app.use(express.json({ limit: "10kb" }));

// Build the SDK gate without starting network work at module load. Vercel can
// suspend that eager work after a free/static request, leaving the next caller
// with a stale initialization rejection. Only paid routes initialize now.
const resourceServer = new x402ResourceServer(facilitatorClient).register(CHAIN, new ExactEvmScheme());
// Observe SDK matching/extension decisions without duplicating its payment policy.
const findRequirements = resourceServer.findMatchingRequirements.bind(resourceServer);
resourceServer.findMatchingRequirements = (...args) => {
  const payment = requestContext.getStore()?.payment;
  if (payment) payment.paymentPhase = 'match';
  const result = findRequirements(...args);
  if (payment && !result) payment.paymentReason = 'requirements_mismatch';
  return result;
};
const validateExtensions = resourceServer.validateExtensions.bind(resourceServer);
resourceServer.validateExtensions = (...args) => {
  const result = validateExtensions(...args);
  const payment = requestContext.getStore()?.payment;
  if (payment && !result.valid) payment.paymentReason = 'extension_mismatch';
  return result;
};
const paymentServer = new x402HTTPResourceServer(resourceServer,
  Object.fromEntries(ENDPOINTS.map(endpoint => [endpoint.route, {
  accepts: { scheme: "exact", payTo: PAY_TO, price: endpoint.price, network: CHAIN },
  description: endpoint.description,
  extensions: declareDiscoveryExtension({ ...endpoint.discovery, output: { example: endpoint.discovery.output } }),
}])));
const paymentGate = paymentMiddlewareFromHTTPServer(paymentServer, undefined, undefined, false);
let paymentInitialized = false;
let paymentInitialization: Promise<void> | undefined;
app.use(async (req, res, next) => {
  const adapter = new ExpressAdapter(req);
  if (!paymentServer.requiresPayment({ adapter, path: req.path, method: req.method })) return next();
  try {
    const context = requestContext.getStore()!;
    const signal = context.signal;
    const payment = context.payment!;
    signal.throwIfAborted();
    const invalid = inspectPayment(req.get('payment-signature'), req.get('x-payment'), payment);
    if (invalid) {
      payment.paymentReason = invalid;
      res.status(402).json({ code: invalid === 'unsupported_version' ? 'PAYMENT_UPGRADE_REQUIRED' : 'MALFORMED_PAYMENT',
        error: invalid === 'unsupported_version'
          ? 'Upgrade to x402 v2: request a fresh unsigned quote, then send its v2 payment in PAYMENT-SIGNATURE. X-PAYMENT/v1 is unsupported. Inspect your wallet before signing again.'
          : 'Malformed payment. Request a fresh unsigned x402 v2 quote and use a compatible client.',
        retryable: false, requestId: context.requestId });
      return;
    }
    if (!paymentInitialized) {
      payment.paymentPhase = 'initialize';
      // Shared initialization has its own bounded facilitator deadline. One
      // disconnected caller must not cancel initialization for other callers.
      paymentInitialization ??= requestContext.exit(() => paymentServer.initialize())
        .then(() => { paymentInitialized = true; })
        .finally(() => { paymentInitialization = undefined; });
      await withSignal(paymentInitialization, signal);
    }
    payment.paymentPhase = req.get('payment-signature') ? 'match' : 'parse';
    await paymentGate(req, res, next);
  } catch (error) {
    // The SDK wraps initialization failures; preserve timeout classification
    // while the common responder keeps provider diagnostics out of the body.
    const cause = error instanceof Error && error.cause ? error.cause : error;
    const payment = requestContext.getStore()?.payment;
    if (payment && !payment.paymentReason) payment.paymentReason = cause instanceof Error &&
      ['TimeoutError', 'FacilitatorTimeoutError'].includes(cause.name) ? 'request_timeout' : 'facilitator_unavailable';
    next(cause);
  }
});

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0]) : String(v ?? ""));
const opt = (v: unknown): string | undefined => v === undefined ? undefined : one(v);

const serve = (load: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
  const context = requestContext.getStore()!;
  try {
    if (context.payment && context.payment.paymentHeader !== 'none') context.payment.paymentPhase = 'handler';
    context.signal.throwIfAborted();
    const value = await withSignal(Promise.resolve().then(() => load(req)), context.signal);
    const data = value as Record<string, unknown>;
    const at = typeof data?.at === "string" && Number.isFinite(Date.parse(data.at)) ? data.at : null;
    res.json({ ...data, meta: { requestId: context.requestId, servedAt: new Date().toISOString(),
      observedAt: at, ageSeconds: at ? Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 1000)) : null,
      dataNetwork: config.dataNetwork, paymentNetwork: NETWORK } });
  } catch (error) {
    if (res.destroyed) return;
    const result = errorResponse(error, context.requestId);
    if (result.body.retryAfter) res.setHeader("Retry-After", String(result.body.retryAfter));
    res.status(result.status).json(result.body);
  }
};

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "agenttoll", network: NETWORK, dataNetwork: config.dataNetwork }));
app.get("/api/ready", async (_req, res) => {
  const checks = await cached(`ready:${NETWORK}:${PAY_TO}`, 15_000, async () => {
    const parent = requestContext.getStore()!;
    const signal = AbortSignal.any([parent.signal, AbortSignal.timeout(4_000)]);
    return requestContext.run({ ...parent, signal }, async () => {
      const results = await Promise.allSettled([
        withSignal(facilitatorClient.getSupported().then(supported => {
          if (!supported.kinds.some(kind => kind.network === CHAIN && kind.scheme === "exact" && kind.x402Version === 2)) throw new Error("Payment network unsupported");
          return true;
        }), signal),
        withSignal(baseRpc<string>("eth_blockNumber").then(block => {
          if (!/^0x[0-9a-f]+$/i.test(block) || BigInt(block) <= 0n) throw new Error("Invalid RPC head");
          return true;
        }), signal),
      ]);
      return { facilitator: results[0].status === "fulfilled", baseRpc: results[1].status === "fulfilled", checkedAt: new Date().toISOString() };
    });
  });
  const ready = checks.facilitator && checks.baseRpc;
  if (!ready) res.setHeader("Retry-After", "15");
  res.status(ready ? 200 : 503).json({ ok: ready, network: NETWORK, dataNetwork: config.dataNetwork, checks,
    ...(ready ? {} : { code: "NOT_READY", retryable: true, retryAfter: 15 }), requestId: res.getHeader("X-Request-Id") });
});

app.get("/api/demo", (_req, res) => res.json({
  note: "Static sample shapes, one per paid endpoint. See /api/catalog for live requests.",
  samples: Object.fromEntries(ENDPOINTS.map(e => [e.route.replace(/^GET /, ""), e.discovery.output])),
}));
const CATALOG_ENDPOINTS = [
  ...ENDPOINTS.map(e => ({ path: e.path, method: "GET", price: e.price, description: e.description, tool: e.tool,
    parameters: { path: e.discovery.pathParamsSchema ?? null, query: e.discovery.inputSchema } })),
  ...FREE_ENDPOINTS.map(e => ({ ...e, method: "GET", price: "free" })),
];
app.get("/api/catalog", (_req, res) => res.json({ service: "agenttoll",
  description: "Base onchain data for AI agents, pay per call in USDC via x402. Open source (MIT).",
  network: NETWORK, dataNetwork: config.dataNetwork, payment: "x402", endpoints: CATALOG_ENDPOINTS }));
app.get("/.well-known/x402", (_req, res) => res.json({ x402Version: 2, name: "agenttoll",
  network: NETWORK, dataNetwork: config.dataNetwork, payTo: PAY_TO,
  openapi: `${PUBLIC_BASE}/openapi.json`, llms: `${PUBLIC_BASE}/llms.txt`, mcp: "https://www.npmjs.com/package/agenttoll-mcp",
  resources: ENDPOINTS.map(e => ({ resource: `${PUBLIC_BASE}${e.path}`, price: e.price, description: e.description })) }));
app.get("/.well-known/agent-card.json", (_req, res) => res.json({ name: "AgentToll",
  description: "HTTP and MCP data service: Base market data, verified Basenames, safety checks and versioned radar history, paid with USDC via x402.",
  url: PUBLIC_BASE, provider: { organization: "AgentToll", url: PUBLIC_BASE }, version: "1.0.0",
  identity: { payTo: PAY_TO }, dataNetwork: config.dataNetwork,
  interfaces: {
    http: { type: "rest", baseUrl: PUBLIC_BASE, payment: { protocol: "x402", version: 2, network: CHAIN, asset: "USDC" },
      openapi: `${PUBLIC_BASE}/openapi.json`, discovery: `${PUBLIC_BASE}/.well-known/x402` },
    mcp: { type: "stdio", package: "agenttoll-mcp", install: "npx agenttoll-mcp", registryUrl: "https://www.npmjs.com/package/agenttoll-mcp" },
  },
  skills: CATALOG_ENDPOINTS.map(e => ({ id: e.path, name: e.description.split(":")[0].slice(0, 60), description: e.description, price: e.price, url: `${PUBLIC_BASE}${e.path}` })),
  trust: { openSource: "https://github.com/tevfikefeaydin/agenttoll", onchainStats: `${PUBLIC_BASE}/api/stats`,
    trackRecord: "https://github.com/tevfikefeaydin/agenttoll/tree/main/data/scout",
    note: "Statistics are scoped to the configured payment network and receiving address. Immutable git revisions identify radar snapshots; payment receipts do not bind snapshot content." },
}));

app.get("/api/price/:symbol", serve((req) => getPrice(one(req.params.symbol))));
app.get("/api/gas", serve((req) => getGas(opt(req.query.gasLimit))));
app.get("/api/trending", serve((req) => getTrending(opt(req.query.limit))));
app.get("/api/base/token/:address", serve((req) => getBaseTokenPrice(one(req.params.address))));
app.get("/api/base/address/:address", serve((req) => getAddressInfo(one(req.params.address))));
app.get("/api/base/name/:query", serve((req) => resolveBasename(one(req.params.query))));
app.get("/api/base/safety/:address", serve((req) => getTokenSafety(one(req.params.address))));
app.get(
  "/api/base/scout",
  serve((req) => getScout(opt(req.query.minLiquidity), opt(req.query.pools))),
);
app.get(
  "/api/base/fresh",
  serve((req) => getFreshPools(opt(req.query.minutes), opt(req.query.limit), opt(req.query.fundedOnly))),
);
app.get("/api/base/radar/history", serve((req) => getRadarHistory(opt(req.query.date))));
app.get("/api/base/scorecard", serve((req) => getScorecard(opt(req.query.days))));
app.get(
  "/api/base/portfolio/:address",
  serve((req) =>
    getPortfolio(one(req.params.address), opt(req.query.minValue), opt(req.query.limit)),
  ),
);
app.get(
  "/api/base/radar",
  serve((req) => getNewTokenRadar(opt(req.query.minLiquidity), opt(req.query.limit))),
);
app.get("/api/base/trending", serve((req) => getBaseTrending(opt(req.query.limit))));
app.get("/api/feargreed", serve((req) => getFearGreed(opt(req.query.days))));
app.get("/api/brief", serve((req) => getMarketBrief(opt(req.query.symbols))));
app.get("/api/try/premium", serve((req) => getTryPremium(opt(req.query.asset))));
app.get("/api/try/spread", serve((req) => getTrySpread(opt(req.query.asset))));
app.get("/api/stats", serve(() => getStats(PAY_TO, NETWORK)));

app.get(
  "/api/watch/address/:address",
  serve((req) => getAddressActivity(one(req.params.address), opt(req.query.since))),
);
app.get("/api/watch/radar", serve((req) => getRadarSince(opt(req.query.since))));
app.get(
  "/api/watch/price/:symbol",
  serve((req) =>
    getPriceAlert(one(req.params.symbol), opt(req.query.ref), opt(req.query.pct)),
  ),
);

// Local static serving; on Vercel the public/ folder is served by the CDN.
app.use(express.static(path.join(__dirname, "..", "public")));

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const result = errorResponse(error, String(res.getHeader("X-Request-Id") ?? ""));
  if (result.body.retryAfter) res.setHeader("Retry-After", String(result.body.retryAfter));
  res.status(result.status).json(result.body);
});

export default app;
