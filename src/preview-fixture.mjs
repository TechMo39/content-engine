// Lokale preview van de reveal-animatie, ZONDER browser/Remotion.
// Gebruikt exact dezelfde reveal-logica (remotion/svg.ts) + resvg + ffmpeg.
// Rendert tegen een FIXTURE-mozaiek (geen echt patroon) -> toont alleen de beweging.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { loadSvgLib } from "./_svglib.mjs";
import { makeFixtureSvg } from "../fixtures/fixture.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const W = 540, H = 960, FPS = 30, DUR = 6;
const BG_TOP = "#f3efe8", BG_BOT = "#e4ddd1", INK = "#1c1a17", ACCENT = "#9a7b46";

const lib = await loadSvgLib();
const opts = { fps: FPS, revealStartSec: 0.6, revealEndSec: 5.4, popDurSec: 0.5 };

const mosaic = makeFixtureSvg(22, 15);
const parsed = lib.parseSvg(mosaic, "path,polygon");
lib.orderTiles(parsed, "radial");
const aspect = parsed.view.w / parsed.view.h;

const captions = [
  { text: "Handgemaakt, steen voor steen", fromSec: 0.3, toSec: 3.2, name: false },
  { text: "Studio Vlinder", fromSec: 3.4, toSec: 5.6, name: true },
  { text: "Jouw naam in zellige", fromSec: 5.8, toSec: 6.0, name: false },
];

const panelPad = 8;
const panelW = Math.round(W * 0.84);
const panelInnerW = panelW - panelPad * 2;
const panelInnerH = Math.round(panelInnerW / aspect);
const panelH = panelInnerH + panelPad * 2;
const panelX = Math.round((W - panelW) / 2);
const panelY = Math.round(H * 0.3);

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function lerp(f, inF, a, b, outF) {
  if (f <= inF) return a;
  if (f >= outF) return b;
  return a + ((b - a) * (f - inF)) / (outF - inF);
}

function sceneSvg(frame) {
  const mosaicFrame = lib
    .buildFrameSvg(parsed, frame, opts)
    .replace(
      /<svg\b/i,
      `<svg x="${panelX + panelPad}" y="${panelY + panelPad}" width="${panelInnerW}" height="${panelInnerH}" preserveAspectRatio="xMidYMid meet"`
    );

  let caps = "";
  for (const c of captions) {
    const inF = c.fromSec * FPS, outF = c.toSec * FPS;
    let op = 0;
    op = Math.min(
      lerp(frame, inF, 0, 1, inF + 8),
      lerp(frame, outF - 8, 1, 0, outF)
    );
    op = Math.max(0, Math.min(1, op));
    if (op <= 0.01) continue;
    const size = c.name ? 44 : 27;
    const style = c.name ? 'font-weight="600"' : 'font-style="italic"';
    caps += `<text x="${W / 2}" y="${H * 0.78}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${size}" ${style} fill="${INK}" opacity="${op.toFixed(3)}">${esc(c.text)}</text>`;
  }

  const introScale = lerp(frame, 0, 0.965, 1, 18);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="28%" r="90%">
<stop offset="0%" stop-color="${BG_TOP}"/><stop offset="100%" stop-color="${BG_BOT}"/></radialGradient></defs>
<rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg)"/>
<text x="${W / 2}" y="${H * 0.09}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="18" letter-spacing="4" fill="${INK}" opacity="0.9">TALE OF TILES</text>
<g transform="translate(${W / 2} ${panelY + panelH / 2}) scale(${introScale.toFixed(3)}) translate(${-W / 2} ${-(panelY + panelH / 2)})">
<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="4" fill="#141414"/>
${mosaicFrame}
</g>
${caps}
<text x="${W / 2}" y="${H * 0.93}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="21" letter-spacing="1" fill="${ACCENT}">taleoftiles.com</text>
</svg>`;
}

const tmp = path.resolve(ROOT, "out/.frames");
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });

const total = DUR * FPS;
process.stdout.write(`• ${total} frames rasteren (resvg) `);
for (let f = 0; f < total; f++) {
  const r = new Resvg(sceneSvg(f), { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true } });
  const png = r.render().asPng();
  await fs.writeFile(path.join(tmp, `f${String(f).padStart(4, "0")}.png`), png);
  if (f % 30 === 0) process.stdout.write(".");
}
console.log(" klaar");

const outMp4 = path.resolve(ROOT, "out/preview-fixture.mp4");
console.log("• ffmpeg -> out/preview-fixture.mp4");
const res = spawnSync(
  "ffmpeg",
  ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%04d.png"),
   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outMp4],
  { stdio: ["ignore", "ignore", "pipe"] }
);
if (res.status !== 0) {
  console.error(res.stderr?.toString().slice(-500));
  process.exit(1);
}
// 1 still-frame halverwege voor snelle visuele check
const still = path.resolve(ROOT, "out/preview-still.png");
await fs.copyFile(path.join(tmp, `f${String(Math.round(total * 0.45)).padStart(4, "0")}.png`), still);
console.log("✓ klaar:", existsSync(outMp4) ? "out/preview-fixture.mp4 + out/preview-still.png" : "??");
