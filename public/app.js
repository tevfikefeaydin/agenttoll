// Live toll counter, read straight from the chain via /api/stats.
fetch("/api/stats")
  .then((r) => r.json())
  .then((s) => {
    const el = document.getElementById("toll-counter");
    if (!el || typeof s.tollsCollected !== "number") return;
    el.innerHTML =
      "<strong>" +
      s.tollsCollected.toLocaleString("en-US") +
      "</strong> tolls · <strong>$" +
      s.revenueUsdc.toFixed(3) +
      "</strong> USDC settled onchain";
  })
  .catch(() => {
    const el = document.getElementById("toll-counter");
    if (el) el.textContent = "Live on Base mainnet";
  });

// Border appears on the nav once the hero starts scrolling away.
const nav = document.getElementById("nav");
const onScroll = () => nav && nav.classList.toggle("scrolled", window.scrollY > 24);
addEventListener("scroll", onScroll, { passive: true });
onScroll();

// Reveal-on-scroll, skipped entirely when the visitor prefers reduced motion.
const reveals = document.querySelectorAll(".rv");
if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
  reveals.forEach((el) => el.classList.add("in"));
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
