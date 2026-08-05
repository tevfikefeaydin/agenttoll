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

/** Contract accounts sign via ERC-1271/6492, which changes what can go wrong. */
async function isSmartWallet(provider: EIP1193Provider, address: string): Promise<boolean> {
  try {
    const code = (await provider.request({
      method: "eth_getCode",
      params: [address as `0x${string}`, "latest"],
    })) as string;
    return Boolean(code) && code !== "0x";
  } catch {
    return false;
  }
}

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
    let chainId = (await provider.request({ method: "eth_chainId" })) as string;
    if (chainId !== BASE_CHAIN_ID) {
      show('<span class="dim">Switching your wallet to Base…</span>', "wait");
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID }],
      });
      // The switch resolves before some wallets finish, and signing on the
      // wrong chain produces a valid-looking signature the facilitator then
      // rejects. Confirm before we ask for anything.
      chainId = (await provider.request({ method: "eth_chainId" })) as string;
    }
    if (chainId !== BASE_CHAIN_ID) {
      show(
        '<span class="bad">Your wallet is still not on Base.</span><p class="dim">Switch the ' +
          "network to Base manually and try again — signing on another chain produces a payment " +
          "the facilitator will reject.</p>",
        "err",
      );
      return;
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
    let friendly = msg;
    let hint = "";

    if (/rejected|denied|4001/i.test(msg)) {
      friendly = "You rejected the signature — nothing was charged.";
    } else if (/insufficient|balance|transfer amount exceeds/i.test(msg)) {
      friendly = "That wallet has no USDC on Base. It needs about a cent.";
    } else if (/invalid_payload|invalid_signature|verify/i.test(msg)) {
      friendly = "The facilitator rejected the signature.";
      // Smart-contract wallets sign via ERC-1271/6492 rather than a plain
      // ECDSA signature, and not every facilitator accepts that for the
      // EIP-3009 authorization this flow uses. Say so instead of guessing.
      const isContract = await isSmartWallet(provider, wallet.account.address);
      hint = isContract
        ? "<p class=\"dim\">This wallet is a smart contract account (Base Account, Safe, …). " +
          "Those sign differently and the facilitator does not always accept it for this " +
          "payment type yet. A regular EOA wallet works — or just call the API from code, " +
          "which is the path agents use.</p>"
        : "<p class=\"dim\">Nothing was charged. If this keeps happening, please open an " +
          '<a href="https://github.com/tevfikefeaydin/agenttoll/issues">issue</a> — the demo ' +
          "reports the facilitator's own wording above.</p>";
    }
    show('<span class="bad">' + esc(friendly) + "</span>" + hint, "err");
  }
}

(window as unknown as { agentTollPay?: typeof pay }).agentTollPay = pay;
