// Renders the brand SVGs to PNG at the sizes each platform expects.
// Usage: npm run brand:png
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const jobs = [
  ["logo.svg", "logo-512.png", 512, 512],
  ["logo.svg", "logo-400.png", 400, 400], // X/Farcaster profile picture
  ["banner.svg", "banner-1500x500.png", 1500, 500], // X header
  ["teaser.svg", "teaser-1200x675.png", 1200, 675], // post image (16:9)
];

for (const [src, dest, w, h] of jobs) {
  await sharp(join(here, src), { density: 300 })
    .resize(w, h)
    .png()
    .toFile(join(out, dest));
  console.log(`ok  ${dest} (${w}x${h})`);
}
