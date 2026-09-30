// Announcement card for the npm launch: an agent buying its own data.
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");

const svg = `
<svg width="1200" height="675" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B1220"/>
      <stop offset="1" stop-color="#0E1830"/>
    </linearGradient>
    <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
      <path d="M 60 0 L 0 0 0 60" fill="none" stroke="#8A97AF" stroke-opacity="0.06" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect width="1200" height="675" fill="url(#grid)"/>
  <circle cx="1090" cy="80" r="230" fill="#0052FF" opacity="0.10"/>

  <g transform="translate(80,48) scale(0.115)">
    <rect width="512" height="512" rx="112" fill="#0052FF"/>
    <rect x="132" y="150" width="34" height="228" rx="17" fill="#fff"/>
    <rect x="346" y="150" width="34" height="228" rx="17" fill="#fff"/>
    <rect x="132" y="150" width="248" height="34" rx="17" fill="#fff"/>
    <circle cx="256" cy="330" r="52" fill="#fff"/>
    <circle cx="256" cy="330" r="34" fill="#0043E6"/>
    <circle cx="256" cy="330" r="14" fill="#fff"/>
  </g>
  <text x="152" y="88" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700" fill="#E8EDF7">Your agent can now buy its own data</text>
  <text x="1120" y="88" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#8A97AF" text-anchor="end">npm · x402 · base</text>

  <rect x="80" y="126" width="1040" height="452" rx="18" fill="#0A0F1C" stroke="#233150" stroke-width="2"/>
  <circle cx="116" cy="160" r="7" fill="#FF5F57"/>
  <circle cx="140" cy="160" r="7" fill="#FEBC2E"/>
  <circle cx="164" cy="160" r="7" fill="#28C840"/>

  <g font-family="Consolas, monospace" font-size="24">
    <text x="116" y="218" fill="#8A97AF">$ claude mcp add agenttoll -- npx -y agenttoll-mcp</text>
    <text x="116" y="258" fill="#28C840">✓ connected — 10 tools loaded</text>
    <text x="116" y="318" fill="#E8EDF7">&gt; "What are the hottest new tokens on Base today?"</text>
    <text x="116" y="378" fill="#FEBC2E">⚙ get_new_token_radar() — paying $0.003 USDC via x402 ...</text>
    <text x="116" y="418" fill="#28C840">✓ settled on Base</text>
    <text x="116" y="478" fill="#E8EDF7">15 fresh pools with real liquidity, spam filtered:</text>
    <text x="116" y="518" fill="#3D7BFF">UXOS/ETH · $30k liq  ·  KEYCAT/WETH · $84k liq  ·  ...</text>
  </g>

  <text x="600" y="632" font-family="Segoe UI, Arial, sans-serif" font-size="26" fill="#8A97AF" text-anchor="middle">npx agenttoll-mcp  ·  no API keys  ·  from $0.001/call</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(join(out, "npx-launch-1200x675.png"));
console.log("ok npx-launch-1200x675.png");
