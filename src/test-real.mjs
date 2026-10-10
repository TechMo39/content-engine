// Test de reveal tegen de ECHTE dump.svg met de ACTUELE config-timing.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { loadSvgLib } from "./_svglib.mjs";
import { config, defaultCaptions } from "../config.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const W = 540, H = 960, FPS = config.fps;
const BG_TOP = "#f3efe8", BG_BOT = "#e4ddd1", INK = "#1c1a17", ACCENT = "#9a7b46";
const NAME = "Makers & Co.";

const lib = await loadSvgLib();
const svg = await fs.readFile(path.resolve(ROOT, "fixtures/dump.svg"), "utf8");
const parsed = lib.parseSvg(svg, config.tileSelector);
lib.orderTiles(parsed, config.revealMode);
console.log("tiles:", parsed.tiles.length);

const aspect = parsed.view.w / parsed.view.h;
const opts = {
  fps: FPS,
  revealStartSec: config.revealStartSec,
  revealEndSec: config.revealEndSec,
  popDurSec: config.popDurSec,
};
const caps = defaultCaptions(NAME);

const pad = 8, panelW = Math.round(W * 0.84), innerW = panelW - pad * 2;
const innerH = Math.round(innerW / aspect), panelH = innerH + pad * 2;
const panelX = Math.round((W - panelW) / 2), panelY = Math.round(H * 0.3);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const embed = (f) => f.replace(/<svg\b[^>]*>/i, (o) =>
  o.replace(/\s(width|height|preserveAspectRatio)\s*=\s*"[^"]*"/gi, "")
   .replace(/<svg\b/i, `<svg x="${panelX + pad}" y="${panelY + pad}" width="${innerW}" height="${innerH}" preserveAspectRatio="xMidYMid meet"`));

function capLayer(frame) {
  let out = "";
  for (const c of caps) {
    const inF = c.fromSec * FPS, outF = c.toSec * FPS;
    let op = Math.max(0, Math.min(Math.min((frame - inF) / 8, (outF - frame) / 8), 1));
    if (op <= 0.01) continue;
    const isName = c.text === NAME;
    out += `<text x="${W / 2}" y="${H * 0.78}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${isName ? 44 : 27}" ${isName ? 'font-weight="600"' : 'font-style="italic"'} fill="${INK}" opacity="${op.toFixed(2)}">${esc(c.text)}</text>`;
  }
  return out;
}

const INK_HEX = { gold: "#b2894c", terra: "#b2674e" };
function plateLayer(frame) {
  const appear = (config.revealEndSec - 1.1) * FPS;
  const op = Math.max(0, Math.min((frame - appear) / 14, 1));
  if (op <= 0.01) return "";
  const inkHex = INK_HEX[config.plateInk] || INK_HEX.gold; // test: gold
  const pcx = W / 2, pcy = panelY + panelH / 2;
  const pw = panelW * 0.6, ph = panelH * 0.34;
  const fs = panelH * 0.11 * 1.35;
  const line = panelW * 0.06;
  return `<g opacity="${op.toFixed(2)}">
<rect x="${pcx - pw / 2}" y="${pcy - ph / 2}" width="${pw}" height="${ph}" rx="4" fill="rgba(244,237,223,0.97)" stroke="${inkHex}" stroke-width="2.5"/>
<rect x="${pcx - pw / 2 - 4}" y="${pcy - ph / 2 - 4}" width="${pw + 8}" height="${ph + 8}" rx="5" fill="none" stroke="${inkHex}" stroke-width="1"/>
<text x="${pcx}" y="${pcy - ph * 0.02}" text-anchor="middle" dominant-baseline="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${fs}" font-weight="600" letter-spacing="${fs * 0.08}" fill="#4a3a2a">MAKERS &amp; CO.</text>
<line x1="${pcx - line - fs * 0.3}" y1="${pcy + ph * 0.3}" x2="${pcx - fs * 0.3}" y2="${pcy + ph * 0.3}" stroke="${inkHex}" stroke-width="2"/>
<rect x="${pcx - fs * 0.13}" y="${pcy + ph * 0.3 - fs * 0.13}" width="${fs * 0.26}" height="${fs * 0.26}" fill="${inkHex}" transform="rotate(45 ${pcx} ${pcy + ph * 0.3})"/>
<line x1="${pcx + fs * 0.3}" y1="${pcy + ph * 0.3}" x2="${pcx + line + fs * 0.3}" y2="${pcy + ph * 0.3}" stroke="${inkHex}" stroke-width="2"/>
</g>`;
}

const scene = (frame) => `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="28%" r="90%"><stop offset="0%" stop-color="${BG_TOP}"/><stop offset="100%" stop-color="${BG_BOT}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<text x="${W / 2}" y="${H * 0.09}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="18" letter-spacing="4" fill="${INK}" opacity="0.9">TALE OF TILES</text>
<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="4" fill="#141414"/>
${embed(lib.buildFrameSvg(parsed, frame, opts))}
${plateLayer(frame)}
${capLayer(frame)}
<text x="${W / 2}" y="${H * 0.93}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="21" fill="${ACCENT}">taleoftiles.com</text>
</svg>`;

await fs.mkdir(path.resolve(ROOT, "out"), { recursive: true });
for (const t of [1.5, 3.5, 5.5, 7.5]) {
  const r = new Resvg(scene(Math.round(t * FPS)), { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true } });
  await fs.writeFile(path.resolve(ROOT, `out/real-t${t}.png`), r.render().asPng());
  console.log("geschreven: out/real-t" + t + ".png");
}
