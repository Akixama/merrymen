/**
 * Generate the scoreboard tab icon at 1x/2x/3x.
 *
 * Run: node scripts/tab-icon.mjs   (from mobile/)
 *
 * The template ships home.png and explore.png and nothing else, so a third tab
 * needs a third glyph. Drawn as SVG and rasterised rather than hand-pixelled so
 * the three densities are genuinely the same shape.
 *
 * Pure white on transparent: NativeTabs renders these with renderingMode
 * "template", which discards colour and tints the alpha channel to match the tab
 * bar. Anything other than a clean silhouette would come out muddy.
 */
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "images", "tabIcons");

// Three ascending bars — reads as "results" at 24px, where a trophy or a line
// chart turns to mush.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <g fill="#ffffff">
    <rect x="7"  y="27" width="9" height="14" rx="2.5"/>
    <rect x="19.5" y="18" width="9" height="23" rx="2.5"/>
    <rect x="32" y="9"  width="9" height="32" rx="2.5"/>
  </g>
</svg>`;

for (const [scale, suffix] of [
  [1, ""],
  [2, "@2x"],
  [3, "@3x"],
]) {
  const size = 24 * scale;
  const file = path.join(OUT, `scoreboard${suffix}.png`);
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
  console.log(`[tab-icon] scoreboard${suffix}.png (${size}x${size})`);
}
