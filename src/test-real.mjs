// Preview van de reveal + branding tegen de ECHTE dump.svg, met de ACTUELE config.
// NB: dit is een losse rasterizer-preview (resvg). Het echte logo laadt in de
// Remotion-render op de laptop; hier tonen we een kader op de logo-plek.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { loadSvgLib } from "./_svglib.mjs";
import { config, defaultCaptions } from "../config.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const W = 540, H = 960, FPS = config.fps;
const C = config.brandColors;
const NAME = "Makers & Co.";

const lib = await loadSvgLib();
const svg = await fs.readFile(path.resolve(ROOT, "fixtures/dump.svg"), "utf8");
const parsed = lib.parseSvg(svg, config.tileSelector);
lib.orderTiles(parsed, config.revealMode);
console.log("tiles:", parsed.tiles.length, "| duur:", config.durationSec + "s | theme:", config.theme);

const aspect = parsed.view.w / parsed.view.h;
const opts = {
  fps: FPS,
  revealStartSec: config.revealStartSec,
  revealEndSec: config.revealEndSec,
  popDurSec: config.popDurSec,
};

const pad = 9, panelW = Math.round(W * 0.84), innerW = panelW - pad * 2;
const innerH = Math.round(innerW / aspect), panelH = innerH + pad * 2;
const panelX = Math.round((W - panelW) / 2), panelY = Math.round(H * 0.3);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const embed = (f) => f.replace(/<svg\b[^>]*>/i, (o) =>
  o.replace(/\s(width|height|preserveAspectRatio)\s*=\s*"[^"]*"/gi, "")
   .replace(/<svg\b/i, `<svg x="${panelX + pad}" y="${panelY + pad}" width="${innerW}" height="${innerH}" preserveAspectRatio="xMidYMid meet"`));

function plateLayer(frame) {
  const appear = (config.revealEndSec - 1.1) * FPS;
  const op = Math.max(0, Math.min((frame - appear) / 14, 1));
  if (op <= 0.01) return "";
  const pcx = W / 2, pcy = panelY + panelH / 2;
  const pw = panelW * 0.56, ph = panelH * 0.3;
  const fs = panelH * 0.1 * 1.35;
  const line = panelW * 0.05;
  return `<g opacity="${op.toFixed(2)}">
<rect x="${pcx - pw / 2}" y="${pcy - ph / 2}" width="${pw}" height="${ph}" rx="4" fill="rgba(244,237,223,0.97)" stroke="${C.gold}" stroke-width="2.5"/>
<rect x="${pcx - pw / 2 - 4}" y="${pcy - ph / 2 - 4}" width="${pw + 8}" height="${ph + 8}" rx="5" fill="none" stroke="${C.gold}" stroke-width="1"/>
<text x="${pcx}" y="${pcy - ph * 0.02}" text-anchor="middle" dominant-baseline="middle" font-family="DejaVu Serif, Georgia, serif" font-size="${fs}" font-weight="600" letter-spacing="${fs * 0.08}" fill="${C.inkOnPlate}">MAKERS &amp; CO.</text>
<line x1="${pcx - line - fs * 0.3}" y1="${pcy + ph * 0.3}" x2="${pcx - fs * 0.3}" y2="${pcy + ph * 0.3}" stroke="${C.gold}" stroke-width="2"/>
<rect x="${pcx - fs * 0.13}" y="${pcy + ph * 0.3 - fs * 0.13}" width="${fs * 0.26}" height="${fs * 0.26}" fill="${C.gold}" transform="rotate(45 ${pcx} ${pcy + ph * 0.3})"/>
<line x1="${pcx + fs * 0.3}" y1="${pcy + ph * 0.3}" x2="${pcx + line + fs * 0.3}" y2="${pcy + ph * 0.3}" stroke="${C.gold}" stroke-width="2"/>
</g>`;
}

function capLayer(frame) {
  let out = "";
  for (const c of defaultCaptions(NAME)) {
    const inF = c.fromSec * FPS, outF = c.toSec * FPS;
    let op = Math.max(0, Math.min(Math.min((frame - inF) / 8, (outF - frame) / 8), 1));
    if (op <= 0.01) continue;
    out += `<text x="${W / 2}" y="${H * 0.76}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="27" font-style="italic" fill="${C.cream}" opacity="${op.toFixed(2)}">${esc(c.text)}</text>`;
  }
  return out;
}

const scene = (frame) => {
  const dark = config.theme !== "light";
  const bg = dark ? C.bg : "#f3efe8";
  const bg2 = dark ? C.bg2 : "#e4ddd1";
  const cream = dark ? C.cream : "#6b5a3a";
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="26%" r="90%"><stop offset="0%" stop-color="${bg2}"/><stop offset="70%" stop-color="${bg}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<!-- logo-plek (kader; echt logo in Remotion-render) -->
<rect x="${W / 2 - 70}" y="${H * 0.05}" width="140" height="44" rx="6" fill="none" stroke="${C.gold}" stroke-width="1" opacity="0.5"/>
<text x="${W / 2}" y="${H * 0.05 + 28}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="16" letter-spacing="3" fill="${C.gold}">TALE OF TILES</text>
<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="6" fill="#140f1e" stroke="${C.gold}" stroke-width="2"/>
${embed(lib.buildFrameSvg(parsed, frame, opts))}
${plateLayer(frame)}
${capLayer(frame)}
<rect x="${W / 2 - 115}" y="${H * 0.9 - 26}" width="230" height="52" rx="26" fill="${C.gold}"/>
<text x="${W / 2}" y="${H * 0.9 + 1}" text-anchor="middle" dominant-baseline="middle" font-family="DejaVu Serif, Georgia, serif" font-size="22" font-weight="600" fill="#2a2010">Ontwerp jouw paneel</text>
<text x="${W / 2}" y="${H * 0.955}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="17" letter-spacing="2" fill="${cream}" opacity="0.85">taleoftiles.com</text>
</svg>`;
};

await fs.mkdir(path.resolve(ROOT, "out"), { recursive: true });
const D = config.durationSec;
for (const t of [1, D * 0.4, D * 0.8, D - 0.5]) {
  const label = t.toFixed(1);
  const r = new Resvg(scene(Math.round(t * FPS)), { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true } });
  await fs.writeFile(path.resolve(ROOT, `out/brand-${label}.png`), r.render().asPng());
  console.log("geschreven: out/brand-" + label + ".png");
}
