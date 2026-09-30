// Builds a scannable payment card for funding the test agent wallet.
import QRCode from "qrcode";
import sharp from "sharp";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");

const TO = "0x5F871F89B13f5c7f570A765aA54C211323F36f78";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT_UNITS = 100000; // 0.1 USDC (6 decimals)

// EIP-681: opens a wallet with recipient, token and amount prefilled.
const uri = `ethereum:${USDC}@8453/transfer?address=${TO}&uint256=${AMOUNT_UNITS}`;

const qr = await QRCode.toBuffer(uri, {
  width: 620,
  margin: 1,
  errorCorrectionLevel: "M",
  color: { dark: "#0B1220", light: "#FFFFFF" },
});

const W = 900, H = 1120;
const card = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" rx="28" fill="#0B1220"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="28" fill="none" stroke="#233150" stroke-width="2"/>

  <text x="${W / 2}" y="84" font-family="Segoe UI, Arial, sans-serif" font-size="40" font-weight="700"
        fill="#E8EDF7" text-anchor="middle">Fund the test wallet</text>
  <text x="${W / 2}" y="128" font-family="Segoe UI, Arial, sans-serif" font-size="26"
        fill="#8A97AF" text-anchor="middle">0.1 USDC · Base network</text>

  <rect x="140" y="170" width="620" height="620" rx="18" fill="#FFFFFF"/>

  <text x="${W / 2}" y="852" font-family="Segoe UI, Arial, sans-serif" font-size="22"
        fill="#8A97AF" text-anchor="middle">Recipient (test agent wallet)</text>
  <text x="${W / 2}" y="892" font-family="Consolas, monospace" font-size="24"
        fill="#E8EDF7" text-anchor="middle">0x5F871F89B13f5c7f570A</text>
  <text x="${W / 2}" y="926" font-family="Consolas, monospace" font-size="24"
        fill="#E8EDF7" text-anchor="middle">765aA54C211323F36f78</text>

  <rect x="120" y="962" width="660" height="52" rx="26" fill="#0B1220" stroke="#3D7BFF" stroke-width="2"/>
  <text x="${W / 2}" y="996" font-family="Segoe UI, Arial, sans-serif" font-size="24"
        fill="#7BA6FF" text-anchor="middle">Network: Base  ·  Asset: USDC</text>

  <text x="${W / 2}" y="1062" font-family="Segoe UI, Arial, sans-serif" font-size="20"
        fill="#5B6B85" text-anchor="middle">Scan with any wallet — amount is prefilled (EIP-681)</text>
</svg>`;

await sharp(Buffer.from(card))
  .composite([{ input: qr, top: 175, left: 140 }])
  .png()
  .toFile(join(out, "fund-test-wallet-qr.png"));

console.log("ok fund-test-wallet-qr.png");
console.log("uri:", uri);
