// Composites the brand typography over the AI-generated background.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");

const overlay = `
<svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
  <text x="600" y="112" font-family="Segoe UI, Arial, sans-serif" font-size="68"
        font-weight="700" fill="#FFFFFF" text-anchor="middle" letter-spacing="-1">AgentToll</text>
  <text x="600" y="163" font-family="Segoe UI, Arial, sans-serif" font-size="27"
        fill="#B9C4D8" text-anchor="middle">Pay-per-call APIs for AI agents — on Base</text>
  <rect x="496" y="196" width="208" height="52" rx="26" fill="#0052FF"/>
  <text x="600" y="231" font-family="Segoe UI, Arial, sans-serif" font-size="24"
        font-weight="600" fill="#FFFFFF" text-anchor="middle">Coming soon</text>
  <text x="600" y="648" font-family="Consolas, monospace" font-size="20"
        fill="#8FA0BC" text-anchor="middle" opacity="0.9">HTTP 402 · USDC · x402 · base</text>
</svg>`;

await sharp(join(out, "ai-bg-raw.png"))
  .resize(1200, 675, { fit: "cover" })
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
  .png()
  .toFile(join(out, "teaser-ai-1200x675.png"));

console.log("ok teaser-ai-1200x675.png");
