// Live toll counter, read straight from the chain via /api/stats.
fetch("/api/stats")
  .then((r) => r.json())
  .then((s) => {
    const el = document.getElementById("toll-counter");
    if (!el) return;
    // An error body (upstream indexer hiccup) has no tollsCollected — fall
    // back to the static line instead of leaving "reading the chain…" stuck.
    const count = (value) => Number.isSafeInteger(value) && value >= 0;
    if (!count(s.tollsCollected)) {
      el.textContent = "Onchain statistics temporarily unavailable";
      return;
    }
    const n = (v) => "<strong>" + v.toLocaleString("en-US") + "</strong>";
    // Both figures use the same scope. Transfers alone do not prove API sales.
    const external = count(s.externalPayers) && count(s.externalTolls);
    el.innerHTML = external
      ? n(s.externalPayers) + (s.externalPayers === 1 ? " external wallet · " : " external wallets · ") +
        n(s.externalTolls) + " qualifying transfers"
      : n(s.tollsCollected) + " qualifying USDC transfers";
    if (s.partial || s.truncated) el.innerHTML += " (partial)";
    el.title = external
      ? "Excludes known operator test wallets. Small USDC transfers are not authenticated API sales or unique people."
      : "Includes operator activity. Small USDC transfers are not authenticated API sales or unique people.";
  })
  .catch(() => {
    const el = document.getElementById("toll-counter");
    if (el) el.textContent = "Onchain statistics temporarily unavailable";
  });

// Border appears on the nav once the hero starts scrolling away.
const nav = document.getElementById("nav");
const onScroll = () => nav && nav.classList.toggle("scrolled", window.scrollY > 24);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Reveal-on-scroll. The hidden state is opt-in via .js-anim, so if this script
// never runs the page shows everything instead of going blank.
const reveals = document.querySelectorAll(".rv");
const revealAll = () => reveals.forEach((el) => el.classList.add("in"));
document.documentElement.classList.add("js-anim");

if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
  revealAll();
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  reveals.forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 3, 2) * 70}ms`;
    io.observe(el);
  });
  // Safety net: if the observer never fires (suspended rendering, odd browser),
  // show everything rather than leaving sections invisible.
  setTimeout(revealAll, 2500);
}

// ---- live demo ----------------------------------------------------------
// Stage 1 (the quote) is a plain fetch, so it costs no extra bytes and works
// for every visitor. Stage 2 pulls the wallet bundle only when asked.
const ENDPOINT = "/api/base/fresh";
let displayedQuote;
let displayedRecipient;
const demoOut = document.getElementById("demo-out");
const quoteBtn = document.getElementById("demo-quote");
const payBtn = document.getElementById("demo-pay");

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function show(html, tone = "quote") {
  if (!demoOut) return;
  demoOut.dataset.tone = tone;
  demoOut.innerHTML = html;
  demoOut.hidden = false;
}

if (quoteBtn) {
  quoteBtn.addEventListener("click", async () => {
    quoteBtn.disabled = true;
    displayedQuote = undefined;
    displayedRecipient = undefined;
    if (payBtn) payBtn.hidden = true;
    show('<span class="dim">Requesting ' + ENDPOINT + " …</span>", "wait");
    try {
      const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(10000), redirect: "error" });
      // x402 v2 puts the quote in the PAYMENT-REQUIRED header (base64 JSON);
      // the body is deliberately empty. Reading the body here is the v1 shape
      // and shows every visitor an error.
      let quote = null;
      try {
        const header = res.headers.get("payment-required");
        quote = header ? JSON.parse(atob(header)) : null;
      } catch {
        /* fall through to the error below */
      }
      const accept = quote?.accepts?.[0];
      if (res.status !== 402 || !accept) {
        show('<span class="bad">Unexpected response: HTTP ' + res.status + "</span>", "err");
        return;
      }
      const identityResponse = await fetch("/.well-known/agent-card.json", { signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!identityResponse.ok) throw new Error("Could not read the deployment payment configuration.");
      const identity = await identityResponse.json();
      const recipient = identity.identity?.payTo;
      if (typeof recipient !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(recipient) ||
          recipient.toLowerCase() !== String(accept.payTo).toLowerCase() ||
          identity.interfaces?.http?.payment?.network !== accept.network) {
        throw new Error("The quote recipient or network differs from the deployment configuration.");
      }
      displayedQuote = quote;
      displayedRecipient = recipient;
      const to = String(accept.payTo);
      const network =
        accept.network === "eip155:8453"
          ? "Base mainnet"
          : accept.network === "eip155:84532"
            ? "Base Sepolia"
            : accept.network;
      show(
        '<div class="line"><span class="tag warn">HTTP 402</span> Payment Required</div>' +
          '<div class="kv"><span>price</span><b>$' +
          (Number(accept.amount) / 1e6).toFixed(3) +
          " USDC</b></div>" +
          '<div class="kv"><span>network</span><b>' + esc(network) + "</b></div>" +
          '<div class="kv"><span>pay to</span><b>' +
          esc(to.slice(0, 10)) + "…" + esc(to.slice(-6)) +
          "</b></div>" +
          '<p class="dim">That is the whole protocol — a price your agent can read and pay on ' +
          "its own. Pay it below to get the data.</p>",
        "quote",
      );
      if (payBtn) payBtn.hidden = false;
    } catch (err) {
      show('<span class="bad">' + esc(err.message) + "</span>", "err");
    } finally {
      quoteBtn.disabled = false;
    }
  });
}

if (payBtn) {
  let loading;
  payBtn.addEventListener("click", async () => {
    payBtn.disabled = true;
    try {
      if (!window.agentTollPay) {
        show('<span class="dim">Loading the payment library…</span>', "wait");
        loading ??= new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "/demo.js";
          s.onload = resolve;
          s.onerror = () => { loading = undefined; s.remove(); reject(new Error("Could not load the payment library.")); };
          document.head.appendChild(s);
        });
        await loading;
      }
      if (!displayedQuote || !displayedRecipient) throw new Error("Request and inspect a payment quote first.");
      await window.agentTollPay(ENDPOINT, show, { quote: displayedQuote, recipient: displayedRecipient });
    } catch (err) {
      show('<span class="bad">' + esc(err.message) + "</span>", "err");
    } finally {
      payBtn.disabled = false;
    }
  });
}

// The hero video is opt-in: the still is always painted first, and the 200 KB
// clip only loads on a wide screen, with motion allowed and a decent connection.
// Everyone else keeps the poster and downloads nothing extra.
const video = document.getElementById("hero-video");
const still = document.getElementById("hero-still");
const saveData = navigator.connection?.saveData;
const slow = /2g/.test(navigator.connection?.effectiveType ?? "");

if (
  video &&
  innerWidth >= 900 &&
  !saveData &&
  !slow &&
  !matchMedia("(prefers-reduced-motion: reduce)").matches
) {
  video.hidden = false;
  video.preload = "auto";
  video.addEventListener(
    "playing",
    () => {
      video.classList.add("ready");
      // Drop the still once the clip is actually painting, to save memory.
      setTimeout(() => still && still.remove(), 900);
    },
    { once: true },
  );
  video.play().catch(() => {
    video.hidden = true; // autoplay refused — the poster stays
  });
}
