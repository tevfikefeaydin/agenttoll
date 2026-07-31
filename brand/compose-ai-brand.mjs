// Produces the AI-based logo and X banner from the Higgsfield raws.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");

// --- Logo: mild center-crop so the mark fills more of a small avatar ---
const crop = 1740; // central 85% of 2048
const left = Math.round((2048 - crop) / 2);
for (const size of [512, 400]) {
  await sharp(join(out, "ai-logo-raw.png"))
    .extract({ left, top: left, width: crop, height: crop })
    .resize(size, size)
    .png()
    .toFile(join(out, `ai-logo-${size}.png`));
  console.log(`ok ai-logo-${size}.png`);
}

// --- Banner: crop 3168x1344 -> 3:1 band, resize to 1500x500, add wordmark ---
const overlay = `
<svg width="1500" height="500" xmlns="http://www.w3.org/2000/svg">
  <text x="120" y="212" font-family="Segoe UI, Arial, sans-serif" font-size="80"
        font-weight="700" fill="#FFFFFF" letter-spacing="-2">AgentToll</text>
  <text x="124" y="272" font-family="Segoe UI, Arial, sans-serif" font-size="31"
        fill="#B9C4D8">Pay-per-call APIs for AI agents</text>
  <text x="124" y="316" font-family="Segoe UI, Arial, sans-serif" font-size="31"
        fill="#B9C4D8">USDC micropayments, settled on Base via x402</text>
  <g font-family="Segoe UI, Arial, sans-serif" font-size="23">
    <rect x="124" y="352" width="170" height="44" rx="22" fill="#0B1220" fill-opacity="0.6" stroke="#3D7BFF" stroke-width="2"/>
    <text x="209" y="381" fill="#7BA6FF" text-anchor="middle">Built on Base</text>
    <rect x="310" y="352" width="184" height="44" rx="22" fill="#0B1220" fill-opacity="0.6" stroke="#8A97AF" stroke-opacity="0.45" stroke-width="2"/>
    <text x="402" y="381" fill="#B9C4D8" text-anchor="middle">x402 protocol</text>
    <rect x="510" y="352" width="216" height="44" rx="22" fill="#0B1220" fill-opacity="0.6" stroke="#8A97AF" stroke-opacity="0.45" stroke-width="2"/>
    <text x="618" y="381" fill="#B9C4D8" text-anchor="middle">Open source · MIT</text>
  </g>
</svg>`;

await sharp(join(out, "ai-banner-raw.png"))
  .extract({ left: 0, top: 240, width: 3168, height: 1056 })
  .resize(1500, 500)
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
  .png()
  .toFile(join(out, "ai-banner-1500x500.png"));
console.log("ok ai-banner-1500x500.png");
