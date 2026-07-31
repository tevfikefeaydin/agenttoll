// Live toll counter, read straight from the chain via /api/stats.
fetch("/api/stats")
  .then((r) => r.json())
  .then((s) => {
    const el = document.getElementById("toll-counter");
    if (el && typeof s.tollsCollected === "number") {
      el.textContent =
        s.tollsCollected.toLocaleString("en-US") +
        " tolls collected · $" +
        s.revenueUsdc.toFixed(3) +
        " USDC onchain";
    }
  })
  .catch(() => {});
