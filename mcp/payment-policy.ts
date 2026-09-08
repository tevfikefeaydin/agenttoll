import { ExactEvmScheme, type ClientEvmSigner } from "@x402/evm";
import { x402Client, x402HTTPClient } from "@x402/fetch";
import { ENDPOINT_MANIFEST } from "./endpoint-manifest.js";

export const HOSTED_URL = "https://agenttoll.app";
export const HOSTED_RECIPIENT = "0xe55359021a6a22d8385b827405991c56075f56f8";

const NETWORKS = {
  base: {
    network: "eip155:8453" as const, chainId: 8453, name: "Base mainnet",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", domainName: "USD Coin",
    explorer: "https://basescan.org",
  },
  "base-sepolia": {
    network: "eip155:84532" as const, chainId: 84532, name: "Base Sepolia",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", domainName: "USDC",
    explorer: "https://sepolia.basescan.org",
  },
};

export function getNetworkConfig(network: string) {
  if (network !== "base" && network !== "base-sepolia") {
    throw new Error("Payment network must be base or base-sepolia.");
  }
  return NETWORKS[network];
}

export interface PaymentClientOptions {
  baseUrl?: string;
  recipient?: string;
  /** Session limit in USDC, at most six decimal places. Defaults to 1 USDC. */
  totalBudgetUsdc?: string | number;
  /** May lower, but never raise, the registered endpoint ceiling. */
  maxPerCallUsdc?: string | number;
  /** Total deadline, including quote, signing, retry and response body. */
  timeoutMs?: number;
}

type PaymentRequired = Parameters<x402Client["createPaymentPayload"]>[0];
type Requirement = PaymentRequired["accepts"][number];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usdcAmount(value: string | number, label: string): bigint {
  const text = String(value);
  if (!/^(0|[1-9]\d{0,15})(\.\d{1,6})?$/.test(text)) {
    throw new Error(`${label} must be a finite nonnegative USDC amount with at most six decimals.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is too large.`);
  return amount;
}

function formatUsdc(amount: bigint): string {
  return `${amount / 1_000_000n}.${(amount % 1_000_000n).toString().padStart(6, "0")}`;
}

/** Binds the full operation to one deadline, even if a wallet ignores abort. */
export function createPaymentDeadline(timeoutMs = 30_000, callerSignal?: AbortSignal | null) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("Payment timeout must be an integer from 1 to 300000 milliseconds.");
  }
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason ?? new Error("Payment aborted."));
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  const timer = setTimeout(() => controller.abort(new Error("Payment timed out; inspect the payment budget before retrying.")), timeoutMs);
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    check,
    async run<T>(work: () => Promise<T>): Promise<T> {
      check();
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve().then(() => { check(); return work(); }).then(resolve, reject).finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
        });
      });
    },
    close() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export function registeredEndpoint(path: string) {
  const segments = path.split("/");
  if (segments.some(segment => {
    try { return /[\\/#?{}]/.test(decodeURIComponent(segment)) || [".", ".."].includes(decodeURIComponent(segment)); }
    catch { return true; }
  })) throw new Error("Invalid registered endpoint path.");
  const endpoint = ENDPOINT_MANIFEST.find(entry => {
    const pattern = entry.path.split("/");
    return pattern.length === segments.length && pattern.every((part, index) =>
      /^\{[^{}]+\}$/.test(part) ? segments[index].length > 0 : part === segments[index],
    );
  });
  if (!endpoint) throw new Error("Payment is only allowed for a registered AgentToll endpoint.");
  return endpoint;
}

/** The policy owns a finite budget for this client instance; amounts never use float arithmetic. */
export function createPaymentClient(network: string, signer?: ClientEvmSigner, options: PaymentClientOptions = {}) {
  const chain = getNetworkConfig(network);
  const baseUrl = new URL(options.baseUrl ?? HOSTED_URL);
  if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password ||
      baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("Payment baseUrl must be an HTTP(S) origin without credentials or a path.");
  }
  const recipient = options.recipient ?? (baseUrl.origin === HOSTED_URL ? HOSTED_RECIPIENT : undefined);
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient)) {
    throw new Error("An explicit valid payment recipient is required for a custom API host.");
  }
  const total = usdcAmount(options.totalBudgetUsdc ?? "1", "Total budget");
  const perCall = options.maxPerCallUsdc === undefined ? undefined : usdcAmount(options.maxPerCallUsdc, "Per-call ceiling");
  const timeoutMs = options.timeoutMs ?? 30_000;
  // Fail configuration early, before any network operation or wallet prompt.
  createPaymentDeadline(timeoutMs).close();
  let spent = 0n;
  let reserved = 0n;

  function requestUrl(input: string | URL | Request): URL {
    const url = new URL(input instanceof Request ? input.url : String(input), baseUrl);
    if (url.origin !== baseUrl.origin || url.username || url.password || url.hash) {
      throw new Error("Payment URL must use the configured API origin.");
    }
    registeredEndpoint(url.pathname);
    return url;
  }

  function validateQuote(value: unknown, url: URL) {
    const endpoint = registeredEndpoint(url.pathname);
    if (!record(value) || value.x402Version !== 2 || !Array.isArray(value.accepts) || value.accepts.length !== 1 ||
        !record(value.resource) || typeof value.resource.url !== "string") {
      throw new Error("Unrecognized x402 v2 payment quote; exactly one payment option is required.");
    }
    let resource: URL;
    try { resource = new URL(value.resource.url); } catch { throw new Error("Invalid payment quote resource URL."); }
    if (resource.origin !== url.origin || resource.pathname !== url.pathname || resource.username || resource.password || resource.hash) {
      throw new Error("Payment quote resource does not match the requested endpoint.");
    }
    const accepted = value.accepts[0];
    if (!record(accepted) || accepted.scheme !== "exact") throw new Error("Only exact USDC payment quotes are supported.");
    if (accepted.network !== chain.network) throw new Error(`Payment quote network must be ${chain.network}.`);
    if (typeof accepted.asset !== "string" || accepted.asset.toLowerCase() !== chain.asset.toLowerCase()) {
      throw new Error("Payment quote asset must be the configured network's USDC contract.");
    }
    if (typeof accepted.payTo !== "string" || accepted.payTo.toLowerCase() !== recipient!.toLowerCase()) {
      throw new Error("Payment quote recipient does not match the configured recipient.");
    }
    if (typeof accepted.amount !== "string" || !/^[1-9]\d{0,15}$/.test(accepted.amount)) {
      throw new Error("Payment quote amount must be a positive integer in micro-USDC.");
    }
    const amount = BigInt(accepted.amount);
    const ceiling = perCall === undefined || perCall > BigInt(endpoint.amount) ? BigInt(endpoint.amount) : perCall;
    if (amount > ceiling) throw new Error(`Payment quote exceeds the ${formatUsdc(ceiling)} USDC endpoint price ceiling.`);
    if (!Number.isSafeInteger(accepted.maxTimeoutSeconds) || (accepted.maxTimeoutSeconds as number) < 1 ||
        (accepted.maxTimeoutSeconds as number) > 300) {
      throw new Error("Payment quote authorization lifetime must be between 1 and 300 seconds.");
    }
    if (!record(accepted.extra) || accepted.extra.name !== chain.domainName || accepted.extra.version !== "2" ||
        (accepted.extra.assetTransferMethod !== undefined && accepted.extra.assetTransferMethod !== "eip3009") ||
        (accepted.extra.paymentFlow !== undefined && accepted.extra.paymentFlow !== "authorization")) {
      throw new Error("Unrecognized USDC signing domain or transfer method in payment quote.");
    }
    // Copy only recognized signing data. Server extensions cannot request extra signatures.
    const requirement: Requirement = {
      scheme: "exact", network: chain.network, amount: accepted.amount,
      asset: accepted.asset, payTo: accepted.payTo, maxTimeoutSeconds: accepted.maxTimeoutSeconds as number,
      extra: { name: chain.domainName, version: "2" },
    };
    const quote: PaymentRequired = { x402Version: 2, resource: { url: resource.href }, accepts: [requirement] };
    return { quote, requirement, amount, endpoint, ceiling };
  }

  async function fetchOnce(request: Request, deadline: ReturnType<typeof createPaymentDeadline>) {
    const response = await deadline.run(() => fetch(request, { signal: deadline.signal, redirect: "manual" }));
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Error("Payment requests do not follow redirects; use the configured API origin directly.");
    }
    if (response.url && new URL(response.url).origin !== baseUrl.origin) throw new Error("Payment response changed origin.");
    // Read the body inside the deadline too. Consumers get an ordinary buffered Response.
    const body = await deadline.run(() => response.arrayBuffer());
    return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }

  function decodeQuote(response: Response, url: URL) {
    const header = response.headers.get("payment-required");
    if (!header || header.length > 32_768) throw new Error("Missing or oversized x402 payment quote header.");
    let value: unknown;
    try { value = JSON.parse(atob(header)); } catch { throw new Error("Malformed x402 payment quote header."); }
    return validateQuote(value, url);
  }

  function makeRequest(input: string | URL | Request, init?: RequestInit) {
    const url = requestUrl(input);
    const request = new Request(input instanceof Request ? input : url, init);
    if (request.method !== "GET") throw new Error("Registered AgentToll payment endpoints only allow GET.");
    if (request.headers.has("payment-signature") || request.headers.has("x-payment")) {
      throw new Error("Payment signatures must be created by this bounded client.");
    }
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return { url, request, callerSignal };
  }

  const getPaymentBudget = () => ({
    totalUsdc: formatUsdc(total), spentUsdc: formatUsdc(spent), reservedUsdc: formatUsdc(reserved),
    remainingUsdc: formatUsdc(total - spent - reserved), network: chain.network,
    recipient, asset: chain.asset, apiOrigin: baseUrl.origin, timeoutMs,
    maxPerCallUsdc: perCall === undefined ? null : formatUsdc(perCall),
    canSign: Boolean(signer),
  });

  async function getPaymentQuote(path: string, init?: RequestInit) {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Quote inspection requires a registered endpoint path, not a URL.");
    const { url, request, callerSignal } = makeRequest(path, init);
    const deadline = createPaymentDeadline(timeoutMs, callerSignal);
    try {
      const response = await fetchOnce(new Request(request, { signal: deadline.signal, redirect: "manual" }), deadline);
      if (response.status !== 402) throw new Error(`Expected a payment quote, received HTTP ${response.status}.`);
      const checked = decodeQuote(response, url);
      return {
        endpoint: checked.endpoint.path, amountUsdc: formatUsdc(checked.amount),
        ceilingUsdc: formatUsdc(checked.ceiling), quote: checked.quote,
      };
    } finally { deadline.close(); }
  }

  async function fetchWithPayment(input: string | URL | Request, init?: RequestInit, expectedQuote?: unknown) {
    const { url, request, callerSignal } = makeRequest(input, init);
    const expected = expectedQuote === undefined ? undefined : validateQuote(expectedQuote, url);
    const deadline = createPaymentDeadline(timeoutMs, callerSignal);
    let reservation = 0n;
    let signing = false;
    let signed = false;
    try {
      const unsigned = new Request(request, { signal: deadline.signal, redirect: "manual" });
      const response = await fetchOnce(unsigned, deadline);
      if (response.status !== 402) return response;
      const checked = decodeQuote(response, url);
      if (expected && JSON.stringify(expected.requirement) !== JSON.stringify(checked.requirement)) {
        throw new Error("Payment quote changed since it was displayed. Request a new quote before paying.");
      }
      if (!signer) throw new Error("No paying wallet configured. Quote and budget inspection are available without a private key.");
      deadline.check();
      // This check and increment deliberately contain no await: concurrent callers cannot oversubscribe.
      if (spent + reserved + checked.amount > total) throw new Error("Insufficient remaining payment budget.");
      reservation = checked.amount;
      reserved += reservation;
      const guardedSigner: ClientEvmSigner = {
        address: signer.address,
        async signTypedData(message) {
          deadline.check();
          signing = true;
          try {
            const signature = await signer.signTypedData(message);
            signed = true;
            return signature;
          } finally { signing = false; }
        },
      };
      const client = new x402Client().register(chain.network, new ExactEvmScheme(guardedSigner));
      const httpClient = new x402HTTPClient(client);
      const payload = await deadline.run(() => client.createPaymentPayload(checked.quote));
      deadline.check();
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(httpClient.encodePaymentSignatureHeader(payload))) headers.set(name, value);
      const paid = await fetchOnce(new Request(request, { headers, signal: deadline.signal, redirect: "manual" }), deadline);
      if (paid.ok) { reserved -= reservation; spent += reservation; reservation = 0n; }
      // Any signed failure remains reserved. An HTTP error cannot revoke a redeemable authorization.
      return paid;
    } finally {
      if (reservation && !signed && !signing) reserved -= reservation;
      deadline.close();
    }
  }

  return { fetchWithPayment, getPaymentBudget, getPaymentQuote, validateQuote: (value: unknown, path: string) => validateQuote(value, requestUrl(path)) };
}
