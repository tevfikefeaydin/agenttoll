/**
 * Wallet half of the browser demo. Bundled to public/demo.js by
 * `npm run build:web` and loaded on demand — the quote step in app.js is a
 * plain fetch, so nobody downloads this unless they choose to pay.
 *
 * Exposed as window.agentTollPay(); app.js calls it once the bundle lands.
 */
import { createWalletClient, custom, type EIP1193Provider } from "viem";
import { base } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const BASE_CHAIN_ID = "0x2105"; // 8453

type Show = (html: string, tone?: "quote" | "ok" | "err" | "wait") => void;

const esc = (s: unknown) =>
  String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

async function pay(endpoint: string, show: Show) {
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) {
    show(
      '<span class="bad">No browser wallet found.</span><p class="dim">Install a Base-compatible ' +
        "wallet (Coinbase Wallet, MetaMask, Rabby…) and reload — or just call the API from your " +
        "own code, which is what agents do anyway.</p>",
      "err",
    );
    return;
  }

  try {
    show('<span class="dim">Waiting for your wallet…</span>', "wait");
    const [address] = (await provider.request({ method: "eth_requestAccounts" })) as string[];

    // x402 settles on Base mainnet, so make sure the wallet is there.
    const chainId = (await provider.request({ method: "eth_chainId" })) as string;
    if (chainId !== BASE_CHAIN_ID) {
      show('<span class="dim">Switching your wallet to Base…</span>', "wait");
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }],
      });
    }

    const wallet = createWalletClient({
      account: address as `0x${string}`,
      chain: base,
      transport: custom(provider),
    });

    show('<span class="dim">Sign the USDC authorization in your wallet…</span>', "wait");
    const res = await wrapFetchWithPayment(fetch, wallet)(endpoint);
    const data = await res.json();

    const header = res.headers.get("x-payment-response");
    const tx = header ? decodeXPaymentResponse(header)?.transaction : null;

    show(
      '<div class="line"><span class="tag good">HTTP 200</span> paid &amp; delivered</div>' +
        '<pre class="mini">' +
        esc(JSON.stringify(data, null, 2)) +
        "</pre>" +
        (tx
          ? '<div class="kv"><span>settled</span><b><a href="https://basescan.org/tx/' +
            esc(tx) +
            '" target="_blank" rel="noopener">view on BaseScan ↗</a></b></div>'
          : ""),
      "ok",
    );
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const friendly = /rejected|denied|4001/i.test(msg)
      ? "You rejected the signature — nothing was charged."
      : /insufficient|balance|transfer amount exceeds/i.test(msg)
        ? "That wallet has no USDC on Base. It needs about a cent."
        : msg;
    show('<span class="bad">' + esc(friendly) + "</span>", "err");
  }
}

(window as unknown as { agentTollPay?: typeof pay }).agentTollPay = pay;
