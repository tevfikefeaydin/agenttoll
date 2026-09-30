// "First toll collected" card: real E2E test output styled as a terminal window.
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
  <circle cx="1080" cy="70" r="220" fill="#0052FF" opacity="0.10"/>

  <!-- header: mini logo + title -->
  <g transform="translate(80,52) scale(0.115)">
    <rect width="512" height="512" rx="112" fill="#0052FF"/>
    <rect x="132" y="150" width="34" height="228" rx="17" fill="#fff"/>
    <rect x="346" y="150" width="34" height="228" rx="17" fill="#fff"/>
    <rect x="132" y="150" width="248" height="34" rx="17" fill="#fff"/>
    <circle cx="256" cy="330" r="52" fill="#fff"/>
    <circle cx="256" cy="330" r="34" fill="#0043E6"/>
    <circle cx="256" cy="330" r="14" fill="#fff"/>
  </g>
  <text x="152" y="92" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700" fill="#E8EDF7">First toll collected</text>
  <text x="1120" y="92" font-family="Segoe UI, Arial, sans-serif" font-size="24" fill="#8A97AF" text-anchor="end">agenttoll · x402 · base</text>

  <!-- terminal window -->
  <rect x="80" y="130" width="1040" height="440" rx="18" fill="#0A0F1C" stroke="#233150" stroke-width="2"/>
  <circle cx="116" cy="164" r="7" fill="#FF5F57"/>
  <circle cx="140" cy="164" r="7" fill="#FEBC2E"/>
  <circle cx="164" cy="164" r="7" fill="#28C840"/>

  <g font-family="Consolas, monospace" font-size="24">
    <text x="116" y="222" fill="#8A97AF">$ npm run example:client</text>
    <text x="116" y="262" fill="#E8EDF7">Agent wallet: 0x5F87...6f78</text>
    <text x="116" y="302" fill="#E8EDF7">Calling /api/price/eth  (price: $0.001) ...</text>
    <text x="116" y="342" fill="#FEBC2E">HTTP 402 Payment Required → signing USDC authorization ...</text>
    <text x="116" y="382" fill="#28C840">HTTP 200 OK</text>
    <text x="116" y="422" fill="#E8EDF7">{ symbol: 'eth', usd: 1902.36, change24h: 0.24 }</text>
    <text x="116" y="462" fill="#28C840">Payment receipt: success ✓  ($0.001 USDC)</text>
    <text x="116" y="502" fill="#3D7BFF">tx: 0xed7d755a...8d6b9dd1  (base-sepolia)</text>
    <text x="116" y="542" fill="#8A97AF">no API key · no subscription · settled onchain</text>
  </g>

  <text x="600" y="632" font-family="Segoe UI, Arial, sans-serif" font-size="26" fill="#8A97AF" text-anchor="middle">One request. One micropayment. One response.</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(join(out, "receipt-first-toll-1200x675.png"));
console.log("ok receipt-first-toll-1200x675.png");
