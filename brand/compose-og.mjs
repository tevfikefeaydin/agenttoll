// Builds the link-preview card (og.png) and the GitHub social preview
// from the AI hero render, with the wordmark composited on the clean left side.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const src = join(out, "ai-og-raw.png");

function overlay(w, h) {
  const s = w / 1200; // scale everything off the 1200-wide design
  const px = (v) => Math.round(v * s);
  return Buffer.from(`
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <text x="${px(72)}" y="${px(232)}" font-family="Segoe UI, Arial, sans-serif" font-size="${px(82)}"
        font-weight="700" fill="#FFFFFF" letter-spacing="${px(-2)}">AgentToll</text>
  <text x="${px(76)}" y="${px(290)}" font-family="Segoe UI, Arial, sans-serif" font-size="${px(30)}"
        fill="#B9C4D8">Pay-per-call APIs for AI agents</text>
  <text x="${px(76)}" y="${px(334)}" font-family="Segoe UI, Arial, sans-serif" font-size="${px(30)}"
        fill="#B9C4D8">USDC micropayments on Base via x402</text>
  <g font-family="Segoe UI, Arial, sans-serif" font-size="${px(23)}">
    <rect x="${px(76)}" y="${px(372)}" width="${px(188)}" height="${px(46)}" rx="${px(23)}"
          fill="#0B1220" fill-opacity="0.6" stroke="#3D7BFF" stroke-width="${px(2)}"/>
    <text x="${px(170)}" y="${px(402)}" fill="#7BA6FF" text-anchor="middle">Base mainnet</text>
    <rect x="${px(280)}" y="${px(372)}" width="${px(178)}" height="${px(46)}" rx="${px(23)}"
          fill="#0B1220" fill-opacity="0.6" stroke="#8A97AF" stroke-opacity="0.45" stroke-width="${px(2)}"/>
    <text x="${px(369)}" y="${px(402)}" fill="#B9C4D8" text-anchor="middle">No API keys</text>
  </g>
  <text x="${px(76)}" y="${px(468)}" font-family="Consolas, monospace" font-size="${px(22)}"
        fill="#8FA0BC">agenttoll.base.eth</text>
</svg>`);
}

const jobs = [
  ["og.png", 1200, 630, join(here, "..", "public")], // site link preview + README hero
  ["github-social-1280x640.png", 1280, 640, out], // GitHub repo social preview
];

for (const [name, w, h, dir] of jobs) {
  await sharp(src)
    .resize(w, h, { fit: "cover", position: "right" })
    .composite([{ input: overlay(w, h), top: 0, left: 0 }])
    .png({ quality: 90 })
    .toFile(join(dir, name));
  console.log(`ok ${name} (${w}x${h})`);
}
