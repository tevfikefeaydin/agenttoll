/** Browser wallet demo. public/app.js passes the quote the visitor inspected. */
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { base, baseSepolia } from "viem/chains";
import { toClientEvmSigner } from "@x402/evm";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { createPaymentClient, createPaymentDeadline, getNetworkConfig, registeredEndpoint } from "../src/payment-policy.js";

type Show = (html: string, tone?: "quote" | "ok" | "err" | "wait") => void;
interface BrowserPaymentOptions { quote?: unknown; recipient?: string; timeoutMs?: number; }
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string,
);

async function pay(endpoint: string, show: Show, options: BrowserPaymentOptions = {}) {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) {
    show('<span class="bad">No browser wallet found.</span><p class="dim">Install a Base-compatible wallet and reload, or call the API from your own code.</p>', "err");
    return;
  }

  let address: `0x${string}` | undefined;
  let networkName = "the quoted network";
  let signed = false;
  let deadline: ReturnType<typeof createPaymentDeadline> | undefined;
  try {
    deadline = createPaymentDeadline(options.timeoutMs ?? 120_000);
    const operation = deadline;
    const url = new URL(endpoint, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error("The demo only pays its own API origin.");
    registeredEndpoint(url.pathname);
    let displayedQuote = options.quote;
    if (displayedQuote === undefined) {
      const response = await operation.run(() => fetch(url, { signal: operation.signal, redirect: "error" }));
      if (response.status !== 402) throw new Error(`Expected a payment quote, received HTTP ${response.status}.`);
      const header = response.headers.get("payment-required");
      if (!header || header.length > 32_768) throw new Error("Missing or oversized payment quote.");
      try { displayedQuote = JSON.parse(atob(header)); } catch { throw new Error("Unrecognized payment quote."); }
    }
    const quotedNetwork = (displayedQuote as { accepts?: { network?: string }[] } | null)?.accepts?.[0]?.network;
    const network = quotedNetwork === "eip155:8453" ? "base" : quotedNetwork === "eip155:84532" ? "base-sepolia" : undefined;
    if (!network) throw new Error("Unrecognized payment network; only Base and Base Sepolia are supported.");
    const config = getNetworkConfig(network);
    networkName = config.name;
    const policyOptions = { baseUrl: url.origin, recipient: options.recipient, timeoutMs: options.timeoutMs ?? 120_000 };
    // Validate and copy the displayed terms before the first wallet prompt.
    const pinnedQuote = createPaymentClient(network, undefined, policyOptions).validateQuote(displayedQuote, url.href).quote;

    show('<span class="dim">Waiting for your wallet…</span>', "wait");
    const accounts = await operation.run(() => provider.request({ method: "eth_requestAccounts" }));
    if (!Array.isArray(accounts) || !/^0x[0-9a-fA-F]{40}$/.test(String(accounts[0]))) throw new Error("The wallet did not return an account.");
    address = accounts[0] as `0x${string}`;
    const expectedChainId = `0x${config.chainId.toString(16)}`;
    let chainId = await operation.run(() => provider.request({ method: "eth_chainId" }));
    if (String(chainId).toLowerCase() !== expectedChainId) {
      show('<span class="dim">Switching your wallet to ' + esc(config.name) + '…</span>', "wait");
      await operation.run(() => provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expectedChainId }] }));
      chainId = await operation.run(() => provider.request({ method: "eth_chainId" }));
    }
    if (String(chainId).toLowerCase() !== expectedChainId) throw new Error(`Your wallet is still not on ${config.name}. Switch the network manually and try again.`);

    const payer = address;
    const wallet = createWalletClient({ account: payer, chain: network === "base" ? base : baseSepolia, transport: custom(provider, { retryCount: 0 }) });
    const signer = toClientEvmSigner({
      address: payer,
      async signTypedData(message) {
        operation.check();
        // A wallet can change networks while the live quote is being fetched.
        const currentChain = await operation.run(() => provider.request({ method: "eth_chainId" }));
        if (String(currentChain).toLowerCase() !== expectedChainId) throw new Error(`Your wallet changed network; switch back to ${config.name}.`);
        operation.check();
        show('<span class="dim">Sign the USDC authorization in your wallet…</span>', "wait");
        const signature = await wallet.signTypedData({ account: payer, ...message } as Parameters<typeof wallet.signTypedData>[0]);
        signed = true;
        return signature;
      },
    });
    const client = createPaymentClient(network, signer, policyOptions);
    const response = await operation.run(() => client.fetchWithPayment(url, { signal: operation.signal }, pinnedQuote));
    if (!response.ok) {
      let reason = "";
      try {
        const header = response.headers.get("payment-required");
        reason = header ? String((JSON.parse(atob(header)) as { error?: string }).error ?? "") : "";
      } catch { /* Fall back to the HTTP status. */ }
      const noFunds = /reverted|insufficient|exceeds balance/i.test(reason);
      show('<span class="bad">Payment did not complete.</span><p class="dim">' +
        (noFunds ? `This wallet needs USDC on ${esc(config.name)}. USDC on another network cannot pay this quote.` :
          'The server returned: <code>' + esc(reason || `HTTP ${response.status}`) + '</code>. Check your wallet before retrying an authorized payment.') + '</p>', "err");
      return;
    }
    const data = await operation.run(() => response.json());
    let tx: string | undefined;
    try {
      const header = response.headers.get("payment-response");
      const candidate = header ? (decodePaymentResponseHeader(header) as { transaction?: string }).transaction : undefined;
      if (candidate && /^0x[0-9a-fA-F]{64}$/.test(candidate)) tx = candidate;
    } catch { /* Delivered data remains usable if settlement metadata is malformed. */ }
    show('<div class="line"><span class="tag good">HTTP ' + response.status + '</span> ' + (signed ? 'paid &amp; delivered' : 'delivered') + '</div>' +
      '<pre class="mini">' + esc(JSON.stringify(data, null, 2)) + '</pre>' +
      (tx ? '<div class="kv"><span>settled</span><b><a href="' + config.explorer + '/tx/' + tx + '" target="_blank" rel="noopener">view on BaseScan ↗</a></b></div>' : ''), "ok");
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    let friendly = message;
    let hint = "";
    if (/rejected|denied|4001/i.test(message) && !/invalid_signature/i.test(message)) {
      friendly = signed ? "The wallet request was rejected. Check your wallet before retrying the authorized payment." : "You rejected the wallet request; no payment was submitted.";
    } else if (/insufficient|balance|transfer amount exceeds/i.test(message)) {
      friendly = `That wallet needs USDC on ${networkName}.`;
    } else if (/invalid_payload|invalid_signature|verify/i.test(message)) {
      friendly = "The facilitator rejected the signature.";
      // The selected address lives outside try so diagnostics cannot mask the original error.
      let isContract = false;
      if (address && deadline && !deadline.signal.aborted) {
        try {
          const code = await deadline.run(() => provider.request({ method: "eth_getCode", params: [address!, "latest"] }));
          isContract = typeof code === "string" && code !== "0x";
        } catch { /* Diagnostics are optional. */ }
      }
      hint = isContract
        ? '<p class="dim">This is a smart contract wallet. The facilitator may not support its signature format; try a regular EOA wallet.</p>'
        : '<p class="dim">Check the wallet and the server error before retrying. If this persists, report it on <a href="https://github.com/tevfikefeaydin/agenttoll/issues">GitHub</a>.</p>';
    }
    show('<span class="bad">' + esc(friendly) + '</span>' + hint, "err");
  } finally { deadline?.close(); }
}

(window as unknown as { agentTollPay?: typeof pay }).agentTollPay = pay;
