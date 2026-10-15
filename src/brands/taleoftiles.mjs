// MERK-MODULE: Tale of Tiles. Alle tegel-specifieke dingen (patronen, tegeling,
// voeg, naamplaat) zitten HIER — de kern weet hier niks van.
// Levert: branding, onderwerpen (patronen), templates (video-types), en makeRender().
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { composeChrome, fitRect, loadLogo, loadImageFile, imagePalette, enrichPalette, imageGridRGB, blurImageFile, FORMATS, escapeXml } from "../core/renderer.mjs";

// AUTOMATISCHE MUUR-DETECTIE: lees een mockup-foto en bepaal zélf waar het paneel op de
// muur komt (midden-x, midden-y, hoogte — genormaliseerd 0..1 van het 9:16-beeld). Zoekt
// het grootste rustige, egale muurvlak op ooghoogte en vermijdt meubels/vloer/plafond.
// Geen handwerk: dit draait bij het laden van elke mockup. null = geen duidelijk vlak.
async function detectWallRect(absPath) {
  const GW = 80, GH = 142, AR = 0.66;   // fijner raster (kleine objecten als een mok ook zien)
  const px = await imageGridRGB(absPath, GW, GH);
  if (!px) return null;
  const n = GW * GH, at = (x, y) => y * GW + x;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = px[i * 3] / 255, g = px[i * 3 + 1] / 255, b = px[i * 3 + 2] / 255; lum[i] = (Math.max(r, g, b) + Math.min(r, g, b)) / 2; }
  // gradient (textuur): laag = glad vlak (muur); hoog = rand/object/meubel
  const grad = new Float32Array(n);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = at(x, y); let gx = 0, gy = 0; if (x + 1 < GW) gx = Math.abs(lum[i] - lum[at(x + 1, y)]); if (y + 1 < GH) gy = Math.abs(lum[i] - lum[at(x, y + 1)]); grad[i] = gx + gy; }
  // muurkleur = gemiddelde van gladde cellen in de boven-centrale band
  let wr = 0, wg = 0, wb = 0, wc = 0;
  for (let y = Math.floor(GH * 0.08); y < GH * 0.50; y++) for (let x = Math.floor(GW * 0.22); x < GW * 0.78; x++) { const i = at(x, y); if (grad[i] < 0.04) { wr += px[i * 3]; wg += px[i * 3 + 1]; wb += px[i * 3 + 2]; wc++; } }
  if (wc < 30) return null;
  wr /= wc; wg /= wc; wb /= wc;
  const wLum = (Math.max(wr, wg, wb) + Math.min(wr, wg, wb)) / 2 / 255;
  // muur-masker: glad EN kleur dicht bij de muurkleur EN niet veel feller/donkerder dan de muur
  // (objecten, planken, mokken, ramen, schaduwen -> GEEN muur; daar mag het paneel niet op/overheen).
  const wall = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const dr = px[i * 3] - wr, dg = px[i * 3 + 1] - wg, db = px[i * 3 + 2] - wb; const d = Math.sqrt(dr * dr + dg * dg + db * db); wall[i] = (grad[i] < 0.05 && d < 40 && lum[i] < wLum + 0.09 && lum[i] > wLum - 0.14) ? 1 : 0; }
  // DISTANCE TRANSFORM: afstand van elke muur-cel tot het dichtstbijzijnde niet-muur (object
  // of beeldrand). Het paneel komt in het punt met de MEESTE vrije ruimte -> altijd zo ver
  // mogelijk van kapstok/jas/meubel/plant/mok/raam, met marge rondom (lege muur = lege muur).
  const INF = 1e6, dist = new Float32Array(n);
  for (let i = 0; i < n; i++) dist[i] = wall[i] ? INF : 0;
  const rel = (i, j, d) => { if (dist[j] + d < dist[i]) dist[i] = dist[j] + d; };
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = at(x, y);
    if (x === 0 || y === 0 || x === GW - 1 || y === GH - 1) dist[i] = Math.min(dist[i], 1);   // beeldrand telt als object
    if (x > 0) rel(i, at(x - 1, y), 1);
    if (y > 0) rel(i, at(x, y - 1), 1);
    if (x > 0 && y > 0) rel(i, at(x - 1, y - 1), 1.414);
    if (x < GW - 1 && y > 0) rel(i, at(x + 1, y - 1), 1.414);
  }
  for (let y = GH - 1; y >= 0; y--) for (let x = GW - 1; x >= 0; x--) {
    const i = at(x, y);
    if (x < GW - 1) rel(i, at(x + 1, y), 1);
    if (y < GH - 1) rel(i, at(x, y + 1), 1);
    if (x < GW - 1 && y < GH - 1) rel(i, at(x + 1, y + 1), 1.414);
    if (x > 0 && y < GH - 1) rel(i, at(x - 1, y + 1), 1.414);
  }
  // beste centrum: max vrije ruimte, met lichte voorkeur voor horizontaal midden en niet te
  // laag (ooghoogte / boven de meubels).
  let best = null;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const d = dist[at(x, y)]; if (d < 4) continue;
    const cx = x / GW, cy = y / GH;
    const score = d - Math.abs(cx - 0.5) * 6 - Math.max(0, cy - 0.5) * 10;
    if (!best || score > best.score) best = { score, d, cx, cy };
  }
  if (!best) return null;
  // paneelhoogte volgt de vrije ruimte (2×afstand) met marge; begrensd op redelijk formaat.
  const hC = Math.min(GH * 0.5, Math.max(GH * 0.22, best.d * 2 * 0.78));
  return { cx: best.cx, cy: best.cy, h: hC / GH };
}

// ---- naamplaat (port van mPlateColours + mNameLayerSvg uit page.ts) ----
function _hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _mix(a, b, t) { const A = _hexRgb(a), B = _hexRgb(b); const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t); return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1); }
function _lum(h) { const r = _hexRgb(h); return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; }
// 8-puntige zellige-ster (khatim) als sier bij het woordmerk
function star8(cx, cy, R, r) { const p = []; for (let i = 0; i < 16; i++) { const a = Math.PI / 8 * i - Math.PI / 2, rad = i % 2 ? r : R; p.push((cx + rad * Math.cos(a)).toFixed(1) + "," + (cy + rad * Math.sin(a)).toFixed(1)); } return p.join(" "); }
// Moorse hoefijzer-/spitsboog die het rechthoekige paneel bovenin tot een punt brengt.
function moorArch(x, y, w, h) {
  const cx = x + w / 2, sh = h * 0.40, sy = y + sh, bulge = w * 0.055;
  return `M ${x} ${y + h} L ${x} ${sy} `
    + `C ${(x - bulge).toFixed(1)} ${(sy - sh * 0.5).toFixed(1)} ${(cx - w * 0.30).toFixed(1)} ${y} ${cx} ${y} `
    + `C ${(cx + w * 0.30).toFixed(1)} ${y} ${(x + w + bulge).toFixed(1)} ${(sy - sh * 0.5).toFixed(1)} ${x + w} ${sy} `
    + `L ${x + w} ${y + h} Z`;
}
// Slanke pilaar met kapiteel en basis (goud contour op plum) — paleis-gevoel.
function column(cx, topY, botY, cw, gold, plum) {
  const x = cx - cw / 2, capH = cw * 0.85, baseH = cw * 0.75, sx = (cw * 0.22).toFixed(1);
  return `<rect x="${(x - cw * 0.22).toFixed(1)}" y="${topY.toFixed(1)}" width="${(cw * 1.44).toFixed(1)}" height="${capH.toFixed(1)}" rx="2" fill="${plum}" stroke="${gold}" stroke-width="1.6"/>`
    + `<rect x="${x.toFixed(1)}" y="${(topY + capH).toFixed(1)}" width="${cw}" height="${(botY - topY - capH - baseH).toFixed(1)}" fill="${plum}" stroke="${gold}" stroke-width="1.4"/>`
    + `<line x1="${(cx - cw * 0.16).toFixed(1)}" y1="${(topY + capH + 3).toFixed(1)}" x2="${(cx - cw * 0.16).toFixed(1)}" y2="${(botY - baseH - 3).toFixed(1)}" stroke="${gold}" stroke-width="0.8" opacity="0.5"/>`
    + `<line x1="${(cx + cw * 0.16).toFixed(1)}" y1="${(topY + capH + 3).toFixed(1)}" x2="${(cx + cw * 0.16).toFixed(1)}" y2="${(botY - baseH - 3).toFixed(1)}" stroke="${gold}" stroke-width="0.8" opacity="0.5"/>`
    + `<rect x="${(x - cw * 0.22).toFixed(1)}" y="${(botY - baseH).toFixed(1)}" width="${(cw * 1.44).toFixed(1)}" height="${baseH.toFixed(1)}" rx="2" fill="${plum}" stroke="${gold}" stroke-width="1.6"/>`;
}
// Mozaïek-medaillon (khatim-ster + ring) — het merk-symbool dat de video opent/sluit.
function medallion(cx, cy, R, gold) {
  const s1 = star8(cx, cy, R, R * 0.42);
  return `<g>`
    + `<circle cx="${cx}" cy="${cy}" r="${(R * 1.28).toFixed(1)}" fill="none" stroke="${gold}" stroke-width="2"/>`
    + `<circle cx="${cx}" cy="${cy}" r="${(R * 1.14).toFixed(1)}" fill="none" stroke="${gold}" stroke-width="1" opacity="0.55"/>`
    + `<polygon points="${s1}" fill="none" stroke="${gold}" stroke-width="2.6"/>`
    + `<g transform="rotate(22.5 ${cx} ${cy})"><polygon points="${s1}" fill="none" stroke="${gold}" stroke-width="1.5" opacity="0.7"/></g>`
    + `<circle cx="${cx}" cy="${cy}" r="${(R * 0.13).toFixed(1)}" fill="${gold}"/></g>`;
}
function plateColours(cols) {
  cols = (cols || []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  if (!cols.length) cols = ["#7d8f6e", "#2f4858", "#e8e5e2"];
  const sorted = cols.slice().sort((a, b) => _lum(a) - _lum(b));
  const darkest = sorted[0];
  let edge = cols[0], best = -1;
  cols.forEach((c) => { const r = _hexRgb(c); const sat = Math.max(r[0], r[1], r[2]) - Math.min(r[0], r[1], r[2]); if (sat > best) { best = sat; edge = c; } });
  return { plate: _mix(edge, "#f4efe6", 0.70), ink: _mix(darkest, "#1a1512", 0.35), edge };
}
function nameLayerSvg(nm, np, scale) {
  const vw = 560, vh = 200;
  const stone = np.plate, stoneDark = _mix(stone, "#000000", 0.28), stoneLight = _mix(stone, "#ffffff", 0.55), band = np.edge;
  const engrave = _mix(np.ink || np.edge || stone, "#000000", 0.15);
  let fpx = Math.round(vh * 0.36 * (scale || 1));
  const words = (nm || "").split(" "); let lines = [nm];
  if (nm.length > 14 && words.length > 1) { const mid = Math.ceil(words.length / 2); lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")]; fpx = Math.round(fpx * 0.82); }
  // Premium editorial serif op de naamplaat (Cormorant) i.p.v. de logge DejaVu.
  const FF = SERIF, WT = 600, TR = 6, CW = 0.52;
  const innerW = vw - 90;
  let L = 0; for (const l of lines) L = Math.max(L, l.length);
  const estW = L * (fpx * CW + TR);
  if (estW > innerW) fpx = Math.max(14, Math.floor(fpx * innerW / estW));
  const lh = fpx * 1.2, y0 = vh / 2 - (lines.length - 1) * lh / 2 + fpx * 0.34;
  const brass = "#b08d57";
  let out = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`;
  out += `<rect x="6" y="6" width="${vw - 12}" height="${vh - 12}" rx="18" fill="${band}"/>`;
  out += `<rect x="12" y="12" width="${vw - 24}" height="${vh - 24}" rx="14" fill="${stoneDark}"/>`;
  out += `<rect x="15" y="15" width="${vw - 30}" height="${vh - 30}" rx="12" fill="${stone}"/>`;
  out += `<rect x="26" y="24" width="${vw - 52}" height="${vh - 48}" rx="8" fill="none" stroke="${brass}" stroke-width="2"/>`;
  out += `<rect x="30" y="28" width="${vw - 60}" height="${vh - 56}" rx="6" fill="none" stroke="${stoneDark}" stroke-width="1" opacity="0.4"/>`;
  const tl = (x, y, ln, f) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FF}" font-weight="${WT}" font-size="${fpx}" letter-spacing="${TR}" fill="${f}">${escapeXml(ln).toUpperCase()}</text>`;
  for (let li = 0; li < lines.length; li++) { const yy = y0 + li * lh; out += tl(vw / 2 + 1, yy + 1, lines[li], stoneDark); out += tl(vw / 2 - 1, yy - 1, lines[li], stoneLight); out += tl(vw / 2, yy, lines[li], engrave); }
  const sy = y0 + (lines.length - 1) * lh + fpx * 0.62, sw = vw * 0.14;
  out += `<line x1="${vw / 2 - sw}" y1="${sy}" x2="${vw / 2 + sw}" y2="${sy}" stroke="${stoneDark}" stroke-width="1.5"/>`;
  out += `<polygon points="${vw / 2},${sy - 4} ${vw / 2 + 6},${sy} ${vw / 2},${sy + 4} ${vw / 2 - 6},${sy}" fill="${stoneDark}"/>`;
  out += `</svg>`;
  return out;
}

// GLAZUUR-GLANS: echte zellige glimt en vangt licht. Deze laag legt over een paneel-
// rechthoek een lichtval van linksboven (sheen), een diagonale glans en een zachte
// vignet voor diepte, zodat de tegels niet plat/digitaal ogen maar geglazuurd. sfx =
// uniek achtervoegsel zodat gradient-id's niet botsen (build/in-situ/badge in 1 frame).
function glazeSvg(x, y, w, h, sfx) {
  const gid = "glz" + sfx, sid = "shn" + sfx, vid = "vig" + sfx;
  return `<defs>`
    // zachte, matte glans (geen felle digitale highlight): licht van linksboven
    + `<linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">`
    + `<stop offset="0" stop-color="#fff4e0" stop-opacity="0.10"/>`
    + `<stop offset="0.28" stop-color="#fff4e0" stop-opacity="0.03"/>`
    + `<stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>`
    + `<stop offset="0.8" stop-color="#120a04" stop-opacity="0.10"/>`
    + `<stop offset="1" stop-color="#120a04" stop-opacity="0.26"/></linearGradient>`
    + `<radialGradient id="${sid}" cx="31%" cy="21%" r="60%">`
    + `<stop offset="0" stop-color="#fff6e8" stop-opacity="0.13"/>`
    + `<stop offset="42%" stop-color="#fff6e8" stop-opacity="0.03"/>`
    + `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${vid}" cx="50%" cy="45%" r="74%">`
    + `<stop offset="48%" stop-color="#000000" stop-opacity="0"/>`
    + `<stop offset="100%" stop-color="#1c0f06" stop-opacity="0.34"/></radialGradient></defs>`
    // FILTER: warme, dempende "oven-glazuur"-tint over het hele paneel -> doffer/dieper,
    // minder digitaal-licht; daarna de diepte (vignet), dan de zachte glans.
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#3a2414" opacity="0.16"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${vid})"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${gid})"/>`
    + `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${sid})"/>`;
}

// HOOK-OVERLAY: korte, pakkende tekst bovenin de eerste ~1,5s (short-form wint of verliest
// in de eerste seconden). Leesbaar op elke achtergrond via een zachte donkere pill + goud
// randje. Wrapt naar max 2 regels en schaalt mee. op = zichtbaarheid 0..1.
// Premium editorial serif (meegeladen uit assets/fonts; valt terug op systeem-serif).
const SERIF = "Cormorant Garamond, DejaVu Serif, serif";

// Woord-afbreking in max. 2 regels (op spaties), zo gebalanceerd mogelijk.
function wrap2(txt, maxLen) {
  const words = String(txt).split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words;
  let lines = [""];
  for (const w of words) { const cand = (lines[lines.length - 1] ? lines[lines.length - 1] + " " : "") + w; if (cand.length > maxLen && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = cand; }
  if (lines.length > 2) { const mid = Math.ceil(words.length / 2); lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")]; }
  return lines;
}

// VERHAAL-ONDERSCHRIFT (premium): een elegante regel (Cormorant) met een goud kicker-label
// en een dun goudlijntje, over een zachte onderste scrim zodat het leesbaar op de muur/foto
// valt. pos: "lower" = filmische onderregel (in-situ/sfeer), "top" = bovenin (satisfying).
function captionOverlay(main, kicker, W, H, op, pos = "lower") {
  if (!main || op <= 0.01) return "";
  const O = Math.max(0, Math.min(1, op));
  const lines = wrap2(main, 24);
  const longest = Math.max(...lines.map((l) => l.length));
  let fs = Math.round(W * 0.056);
  if (longest * fs * 0.50 > W * 0.84) fs = Math.floor(W * 0.84 / (longest * 0.50));
  const kfs = Math.round(fs * 0.34);
  const lh = fs * 1.06;
  const rise = (1 - O) * (H * 0.012);   // komt heel licht omhoog zetten
  let cy;
  if (pos === "top") cy = Math.round(H * 0.15);
  else cy = Math.round(H * 0.815);
  const blockH = (kicker ? kfs + fs * 0.5 : 0) + 10 + lh * lines.length;
  let y = cy - blockH / 2 + rise;
  let out = "";
  // zachte scrim voor leesbaarheid (alleen onderregel)
  if (pos !== "top") {
    out += `<defs><linearGradient id="capscrim" x1="0" y1="0" x2="0" y2="1">`
      + `<stop offset="0" stop-color="#0a0712" stop-opacity="0"/><stop offset="1" stop-color="#0a0712" stop-opacity="${(0.62 * O).toFixed(3)}"/></linearGradient></defs>`
      + `<rect x="0" y="${Math.round(H * 0.66)}" width="${W}" height="${Math.round(H * 0.34)}" fill="url(#capscrim)"/>`;
  }
  out += `<g opacity="${O.toFixed(3)}" text-anchor="middle">`;
  if (kicker) {
    y += kfs;
    out += `<text x="${W / 2}" y="${y.toFixed(0)}" font-family="${SERIF}" font-weight="600" font-size="${kfs}" letter-spacing="${(kfs * 0.42).toFixed(1)}" fill="#d6b35a">${escapeXml(kicker.toUpperCase())}</text>`;
    // dun goudlijntje onder de kicker
    const rw = Math.round(W * 0.085);
    y += fs * 0.5;
    out += `<rect x="${(W / 2 - rw / 2).toFixed(0)}" y="${y.toFixed(0)}" width="${rw}" height="1.4" fill="#d6b35a" opacity="0.8"/>`;
    y += 10;
  }
  lines.forEach((l, i) => {
    y += lh;
    out += `<text x="${W / 2}" y="${(y - lh * 0.28).toFixed(0)}" font-family="${SERIF}" font-weight="500" font-size="${fs}" letter-spacing="${(fs * 0.015).toFixed(1)}" fill="#f6efe0">${escapeXml(l)}</text>`;
  });
  out += `</g>`;
  return out;
}

function hookOverlay(txt, W, H, op) {
  if (!txt || op <= 0.01) return "";
  const words = String(txt).split(/\s+/);
  let lines = [""];
  for (const w of words) { const cand = (lines[lines.length - 1] ? lines[lines.length - 1] + " " : "") + w; if (cand.length > 16 && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = cand; }
  if (lines.length > 2) { const mid = Math.ceil(words.length / 2); lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")]; }
  const longest = Math.max(...lines.map((l) => l.length));
  let fs = Math.round(W * 0.082);
  if (longest * fs * 0.56 > W * 0.86) fs = Math.floor(W * 0.86 / (longest * 0.56));
  const lh = fs * 1.18, blockH = lh * lines.length, cy = Math.round(H * 0.205);
  const y0 = cy - blockH / 2 + fs * 0.78;
  const pillW = Math.min(W * 0.92, longest * fs * 0.58 + fs * 1.3), pillH = blockH + fs * 0.7;
  const px = ((W - pillW) / 2).toFixed(0), py = (cy - pillH / 2).toFixed(0), rx = (pillH * 0.3).toFixed(0);
  let out = `<g opacity="${op.toFixed(3)}">`;
  out += `<rect x="${px}" y="${py}" width="${pillW.toFixed(0)}" height="${pillH.toFixed(0)}" rx="${rx}" fill="#160f22" opacity="0.52"/>`;
  out += `<rect x="${px}" y="${py}" width="${pillW.toFixed(0)}" height="${pillH.toFixed(0)}" rx="${rx}" fill="none" stroke="#d6b35a" stroke-width="1.5" opacity="0.7"/>`;
  lines.forEach((l, i) => { const yy = (y0 + i * lh).toFixed(0); out += `<text x="${W / 2}" y="${yy}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fs}" letter-spacing="${(fs * 0.02).toFixed(1)}" fill="#f4ecdc">${escapeXml(l)}</text>`; });
  out += `</g>`;
  return out;
}

// ---- de merk-module zelf ----
export function makeBrand({ ROOT, config }) {
  const branding = {
    name: "Tale of Tiles", footer: "taleoftiles.com",
    bg: "#1a1327", bg2: "#241a3a", gold: "#d6b35a", cream: "#f4ecdc", plate: "#eae4d7",
    // ECHTE logo (van taleoftiles.com) op een strak crème plaatje (donker script leest niet op
    // de donkere kop), met de tagline eronder. Valt terug op het getekende woordmerk als het
    // logobestand ontbreekt.
    markSvg: ({ W, H }) => {
      const gold = "#d6b35a", cream = "#f4ecdc", tag = Math.round(W * 0.0165);
      if (branding.markLogo) {
        const ar = 389 / 96;
        const lw = Math.round(W * 0.44), lh = Math.round(lw / ar);
        const px = Math.round(lw * 0.055), py = Math.round(lh * 0.34);
        const pw = lw + px * 2, ph = lh + py * 2;
        const plateX = Math.round((W - pw) / 2), plateY = Math.round(H * 0.032), rx = Math.round(ph * 0.24);
        const lx = plateX + px, ly = plateY + py;
        const tagY = plateY + ph + tag * 1.7;
        return `<defs><radialGradient id="lgsh" cx="50%" cy="46%" r="52%"><stop offset="0.58" stop-color="#0a0712" stop-opacity="0.38"/><stop offset="1" stop-color="#0a0712" stop-opacity="0"/></radialGradient></defs>`
          + `<ellipse cx="${plateX + pw / 2}" cy="${plateY + ph + 6}" rx="${pw / 2 + 10}" ry="${ph * 0.5}" fill="url(#lgsh)"/>`
          + `<rect x="${plateX}" y="${plateY}" width="${pw}" height="${ph}" rx="${rx}" fill="#f6f1e8"/>`
          + `<rect x="${plateX}" y="${plateY}" width="${pw}" height="${ph}" rx="${rx}" fill="none" stroke="${gold}" stroke-width="1.6" opacity="0.55"/>`
          + `<image href="${branding.markLogo}" x="${lx}" y="${ly}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet"/>`
          + `<text x="${W / 2}" y="${tagY}" text-anchor="middle" font-family="${SERIF}" font-weight="500" font-size="${tag}" letter-spacing="${(tag * 0.26).toFixed(1)}" fill="${cream}" opacity="0.8">HANDGEMAAKTE ZELLIGE NAAMBORDEN</text>`;
      }
      const midY = Math.round(H * 0.072), fs = Math.round(W * 0.05), ruleW = fs * 4.3, tag2 = Math.round(fs * 0.33);
      return `<polygon points="${star8(W / 2, midY - fs * 1.02, fs * 0.52, fs * 0.22)}" fill="${gold}"/>`
        + `<text x="${W / 2}" y="${midY + fs * 0.32}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fs}" letter-spacing="${(fs * 0.16).toFixed(1)}" fill="${gold}">TALE OF TILES</text>`
        + `<line x1="${W / 2 - ruleW}" y1="${midY + fs * 0.62}" x2="${W / 2 + ruleW}" y2="${midY + fs * 0.62}" stroke="${gold}" stroke-width="1.3" opacity="0.75"/>`
        + `<text x="${W / 2}" y="${midY + fs * 1.12}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="${tag2}" letter-spacing="${(tag2 * 0.14).toFixed(1)}" fill="${cream}" opacity="0.82">HANDGEMAAKTE ZELLIGE NAAMBORDEN</text>`;
    },
  };
  const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
  const IMG_DIR = path.resolve(ROOT, "assets/images/taleoftiles");
  const MOCKUP_DIR = path.resolve(IMG_DIR, "mockups");
  const SFEER_DIR = path.resolve(IMG_DIR, "sfeer");   // sfeerbeelden = mood/B-roll (begin/eind i.p.v. in-situ)
  let film = null, LOCKS = {}, patternList = [], imagePool = [], mockupPool = [], sfeerPool = [];
  const baseCache = new Map(), svgCache = new Map();

  // Foto-pool: Mo legt zijn (Gemini-)foto's in assets/images/taleoftiles/.
  // Mockup-pool: lege-muur/ruimte-foto's in assets/images/taleoftiles/mockups/ —
  // daarop plakken we ons ÉCHTE paneel (in-situ), zodat de foto altijd het patroon matcht.
  async function loadImages() {
    imagePool = []; mockupPool = []; sfeerPool = [];
    let files = [];
    try { files = (await fs.readdir(IMG_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch {}
    for (const f of files) {
      const abs = path.join(IMG_DIR, f);
      const uri = await loadImageFile(abs);
      if (!uri) continue;
      let pal = [];
      try { pal = enrichPalette(await imagePalette(abs, 7), 8); } catch {}
      imagePool.push({ id: f, uri, pal });
    }
    let mfiles = [];
    try { mfiles = (await fs.readdir(MOCKUP_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch {}
    for (const f of mfiles) {
      const abs = path.join(MOCKUP_DIR, f);
      const uri = await loadImageFile(abs);
      if (!uri) continue;
      // AUTOMATISCH: lees de foto uit en bepaal zelf waar het paneel op de muur komt.
      // Geen handwerk, geen sidecar. Lukt detectie niet -> null -> terugval op midden.
      let place = null;
      try { place = await detectWallRect(abs); } catch {}
      // vooraf geblurde muur (scherptediepte) — één keer, niet elk frame
      let blur = "";
      try { blur = await blurImageFile(abs); } catch {}
      mockupPool.push({ id: f, uri, blur, place });
    }
    // SFEERBEELDEN: mood/B-roll (zellige-closeups, gestylde scènes, atelier). Worden als
    // echt begin/eind-beeld gebruikt (foto-bookend) i.p.v. ons paneel op een mockup-muur.
    let sfiles = [];
    try { sfiles = (await fs.readdir(SFEER_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch {}
    for (const f of sfiles) {
      const abs = path.join(SFEER_DIR, f);
      const uri = await loadImageFile(abs);
      if (!uri) continue;
      let pal = [];
      try { pal = enrichPalette(await imagePalette(abs, 7), 8); } catch {}
      sfeerPool.push({ id: f, uri, pal });
    }
  }
  const imgById = (id) => imagePool.find((x) => x.id === id);

  async function init(log) {
    const libOut = path.resolve(ROOT, config.outDir, ".totlib.mjs");
    await esbuild.build({ entryPoints: [path.resolve(ROOT, "remotion/film.ts")], bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: libOut });
    film = await import(pathToFileURL(libOut).href + "?t=" + Date.now());
    try { LOCKS = JSON.parse(await fs.readFile(path.resolve(ROOT, "assets/tile-locks.json"), "utf8")); } catch {}
    try { patternList = JSON.parse(await fs.readFile(path.resolve(ROOT, "fixtures/patterns.json"), "utf8")).patterns; } catch {}
    branding.logoUri = await loadLogo(config.logoUrl);
    try { branding.markLogo = await loadImageFile(path.resolve(ROOT, "assets/brand/logo.png")); } catch { branding.markLogo = ""; }
    await loadImages();
    // badge-fallback: als er nog geen foto's in de map staan, pak het paneel-aan-de-muur van de site
    branding.badgeUri = imagePool[0] ? imagePool[0].uri : await loadLogo(config.productUrl || "https://taleoftiles.com/img/site/panel-on-wall.jpg");
    if (log) log(`foto-pool taleoftiles: ${imagePool.length} beeld(en), ${mockupPool.length} mockup(s), ${sfeerPool.length} sfeerbeeld(en)`);
  }
  async function listImages() { return imagePool.map((x) => ({ id: x.id, uri: x.uri })); }
  async function listMockups() { return mockupPool.map((x) => ({ id: x.id, uri: x.uri })); }
  async function listSfeer() { return sfeerPool.map((x) => ({ id: x.id, uri: x.uri })); }
  async function getBase(pattern) {
    if (baseCache.has(pattern)) return baseCache.get(pattern);
    const file = path.resolve(ROOT, "assets/patterns", pattern + ".svg");
    let base;
    try { base = await fs.readFile(file, "utf8"); }
    catch { throw new Error(`patroon ${pattern} niet gevonden in assets/patterns/ — draai eerst de fetch (README)`); }
    baseCache.set(pattern, base); return base;
  }
  function unitSize(base, lock) { const u = film.parseTiles(film.tilePattern(base, lock, 1, 1)); return { w: u.view[2], h: u.view[3] }; }
  function tileCounts(base, lock, panelAspect) {
    const u = unitSize(base, lock); let ua = u.w / u.h;
    if (!Number.isFinite(ua) || ua <= 0) ua = 1;
    const SHORT = 3; let nX, nY;
    if (panelAspect <= 1) { nX = SHORT; nY = Math.max(2, Math.round(nX * ua / panelAspect)); }
    else { nY = SHORT; nX = Math.max(2, Math.round(nY * panelAspect / ua)); }
    if (!Number.isFinite(nX) || nX < 2) nX = 2; if (!Number.isFinite(nY) || nY < 2) nY = 2;
    return { nX: Math.min(10, nX), nY: Math.min(12, nY) };
  }
  async function getPatternSvg(pattern, nX, nY) {
    const key = `${pattern}_${nX}x${nY}`;
    if (svgCache.has(key)) return svgCache.get(key);
    const panel = film.tilePattern(await getBase(pattern), LOCKS[pattern] || {}, nX, nY);
    svgCache.set(key, panel); return panel;
  }
  // Paletten: oude brede sets (back-compat) + de curated glazuur-families.
  const PALS = () => ({ modern: film.PAL, warm: film.WARM, cool: film.COOL, ...film.GLAZE_FAMILIES });
  // AUTOMATISCHE paletkeuze: tenzij de UI expliciet een familie/warm/cool kiest, pakt de
  // engine zélf een curated glazuur-familie (anti-herhaling), zodat elk paneel een strak,
  // diep kleurenverhaal heeft i.p.v. bont. "modern"/leeg/"auto" => automatisch.
  // HOOK-tekst: automatisch gekozen (anti-herhaling), NL/EN, met de naam erin. opts.hook
  // overschrijft met eigen tekst; opts.hook="none"/false zet 'm uit. opts.lang = "nl"/"en".
  let lastStory = -1;
  // VERHAAL per type: een reeks korte beats (kicker + regel) die mét de ambiance meelopen —
  // geen losse hook, maar een boog (spanning -> ambacht -> payoff). Premium toon, geen cliché.
  // B2B + particulier bij in-situ; ambacht/erfgoed bij sfeer; kort/visueel bij satisfying.
  // Rode draad: EEUWENOUD -> NIEUWE TOEPASSING. Echte zellige komt uit Fès (bakermat).
  // Social = de schoonheid & het verhaal (ambacht, eyecatcher, erfgoed) + zachte comment-CTA;
  // niet "bestel je naambord" (dat staat op de site). Doelgroep: particulier én zakelijk.
  const STORIES = {
    insitu: {   // muur / gevel — eyecatcher, weerbestendig, eerste indruk
      nl: [
        [{ k: "Fès", t: "Wat eeuwen aan paleismuren hing…" }, { t: "…nu aan die van jou." }, { t: "Jouw naam, in echt glazuur." }],
        [{ k: "De gevel", t: "De eerste indruk begint buiten." }, { t: "Zon, regen, vorst — het glazuur lacht erom." }, { t: "Jaren later nog net zo diep van kleur." }],
        [{ t: "Een schilderij hang je óp de muur." }, { t: "Dit wórdt de muur." }, { k: "Comments", t: "Welke naam zou jij kiezen?" }],
        [{ k: "Ambacht", t: "Tegel voor tegel, met de hand gezet." }, { t: "Geen twee gelijk." }, { t: "Een eyecatcher bij de deur." }],
      ],
      en: [
        [{ k: "Fès", t: "What once lined palace walls…" }, { t: "…now lines yours." }, { t: "Your name, in real glaze." }],
        [{ k: "The façade", t: "The first impression starts outside." }, { t: "Sun, rain, frost — the glaze doesn't care." }, { t: "Years on, still this deep." }],
        [{ t: "A painting hangs on the wall." }, { t: "This becomes it." }, { k: "Comments", t: "Which name would you pick?" }],
        [{ k: "Craft", t: "Tile by tile, set by hand." }, { t: "No two alike." }, { t: "An eyecatcher at the door." }],
      ],
      fr: [
        [{ k: "Fès", t: "Ce qui ornait les palais…" }, { t: "…orne désormais votre mur." }, { t: "Votre nom, en véritable émail." }],
        [{ t: "Soleil, pluie, gel — l'émail s'en moque." }, { t: "Des années après, toujours aussi intense." }, { k: "Commentaires", t: "Quel nom choisiriez-vous ?" }],
      ],
    },
    sfeer: {   // ambacht / erfgoed / Fès — oud -> nieuw
      nl: [
        [{ k: "Fès", t: "De bakermat van de zellige." }, { t: "Elke tegel met de hand gesneden." }, { t: "Geen twee stukjes gelijk." }],
        [{ t: "Een ambacht van duizend jaar." }, { k: "Vandaag", t: "Een toepassing van nu." }, { t: "Met jouw naam erin." }],
        [{ t: "Klei, water, vuur — en geduld." }, { t: "Zo wordt echte zellige gemaakt." }, { t: "Gemaakt om door te geven." }],
      ],
      en: [
        [{ k: "Fès", t: "The birthplace of zellige." }, { t: "Every tile cut by hand." }, { t: "No two pieces alike." }],
        [{ t: "A thousand-year craft." }, { k: "Today", t: "A use for now." }, { t: "With your name." }],
        [{ t: "Clay, water, fire — and patience." }, { t: "This is how real zellige is made." }, { t: "Made to pass on." }],
      ],
      fr: [
        [{ k: "Fès", t: "Le berceau du zellige." }, { t: "Chaque carreau taillé à la main." }, { t: "Aucun identique." }],
        [{ t: "Un art millénaire." }, { k: "Aujourd'hui", t: "Un usage d'aujourd'hui." }, { t: "Avec votre nom." }],
      ],
    },
    satisfying: {   // kort/visueel — uniek, oud->nieuw, tactiel
      nl: [
        [{ t: "Blijf kijken." }, { t: "Jouw naam, oneindig uniek." }],
        [{ t: "Geen twee hetzelfde." }, { t: "Met de hand gezet." }],
        [{ t: "Duizend jaar oud." }, { t: "Jouw muur van nu." }],
        [{ t: "Je wil er je hand overheen halen." }],
      ],
      en: [
        [{ t: "Keep watching." }, { t: "Your name, endlessly unique." }],
        [{ t: "No two the same." }, { t: "Set by hand." }],
        [{ t: "A thousand years old." }, { t: "Your wall today." }],
        [{ t: "You'll want to touch it." }],
      ],
      fr: [
        [{ t: "Regardez jusqu'au bout." }, { t: "Votre nom, unique." }],
        [{ t: "Fait main." }, { t: "Aucun identique." }],
      ],
    },
  };
  function resolveStory(opts, name, templateId) {
    if (opts.hook === false || opts.hook === "none" || opts.hook === null) return [];
    if (typeof opts.hook === "string" && opts.hook.trim()) return [{ t: opts.hook.trim() }];
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl";
    const t = STORIES[templateId] ? templateId : "satisfying";
    const sets = STORIES[t][lang] || STORIES[t].nl;
    let idx = Math.floor(Math.random() * sets.length);
    if (sets.length > 1 && idx === lastStory) idx = (idx + 1) % sets.length;
    lastStory = idx;
    return sets[idx].map((b) => ({ ...b }));
  }
  let lastFamily = "";
  function resolvePalette(opts, templateId) {
    const fams = Object.keys(film.GLAZE_FAMILIES);
    const k = opts.palette;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    if (k === "warm" || k === "cool" || fams.includes(k)) return { key: k, arr: PALS()[k] };   // handmatige keuze wint
    // SATISFYING + IN-SITU: levendig/gevarieerd (breed palet door elkaar). Mo: tegels in
    // één strakke familie oogt saai/lelijk aan de muur -> dus ook in-situ bont & gevarieerd.
    if (templateId === "satisfying" || templateId === "insitu") {
      const vivid = ["modern", "warm", "cool"];
      let pool = vivid.filter((v) => v !== lastFamily); if (!pool.length) pool = vivid;
      const key = pick(pool); lastFamily = key; return { key, arr: PALS()[key] };
    }
    // SFEERBEELD: matcht met de foto-kleuren (flowPal); hier nog curated familie als basis.
    let pool = fams.filter((f) => f !== lastFamily); if (!pool.length) pool = fams;
    const key = pick(pool); lastFamily = key; return { key, arr: PALS()[key] };
  }
  function storyboardFrom(opts) {
    const pal = PALS()[opts.palette] || film.PAL;
    const tempo = { snel: 1.2, normaal: 1.8, rustig: 2.6 }[opts.tempo] || 1.8;
    const segs = [{ scene: { type: opts.base === "fields" ? "fields" : "confetti", palette: pal }, hold: tempo, trans: 0 }];
    for (const sh of (opts.shapes || [])) segs.push({ scene: { type: "shape", shape: sh, fg: pal }, hold: tempo, trans: 0.9 });
    if (opts.endColorway) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
    if (segs.length === 1) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
    return { buildSec: Number(opts.buildSec) || 3.0, popSec: 0.3, segments: segs };
  }
  // Vrij instelbare duur (seconden) vanuit de UI-schuif; valt terug op de oude
  // presets of 24s. Alle satisfying-timing (opbouw, flow, bookend, naam) schaalt hiermee.
  function resolveDuration(opts) {
    const n = Number(opts.durationSec ?? opts.duration);
    if (Number.isFinite(n) && n > 0) return Math.max(6, Math.min(600, n));   // tot 10 min, geen kunstmatige cap
    return { kort: 14, middel: 24, lang: 38 }[opts.duration] || 24;
  }
  // SATISFYING (template 1, geperfectioneerd): langer + trager + naadloze loop.
  // Begint neutraal -> kleurt rustig in -> ademt door kleurlagen -> vervaagt aan het eind
  // weer naar neutraal, zodat de video naadloos opnieuw begint (loop).
  function storyboardSatisfying(opts) {
    const dur = { kort: 14, middel: 24, lang: 38 }[opts.duration] || 24;
    const pal = PALS()[opts.palette] || film.PAL;
    const buildSec = Math.min(7, dur * 0.3);
    const rest = dur - buildSec;
    const breaths = Math.max(2, Math.round(rest / 7));   // aantal rustige kleur-ademhalingen
    const hold = rest / (breaths + 1);
    const palOrder = ["modern", "warm", "cool"];
    const segs = [{ scene: { type: "fields", palette: pal }, hold, trans: 0 }];
    for (let i = 1; i <= breaths; i++) segs.push({ scene: { type: "fields", palette: PALS()[palOrder[i % palOrder.length]] }, hold, trans: Math.min(1.6, hold * 0.55) });
    return { buildSec, popSec: 0.4, segments: segs };
  }
  // COLORWAY-SWITCH (template 2): zelfde patroon, kleuren fietsen door 3 paletten op de beat.
  function storyboardColorway(opts) {
    const order = ["modern", "warm", "cool"];
    const tempo = { snel: 1.1, normaal: 1.6, rustig: 2.2 }[opts.tempo] || 1.6;
    const segs = order.map((p, i) => ({ scene: { type: "fields", palette: PALS()[p] }, hold: tempo, trans: i === 0 ? 0 : 0.5 }));
    return { buildSec: Number(opts.buildSec) || 2.4, popSec: 0.3, segments: segs };
  }

  // Elk template zegt welke muziek-categorieën erbij passen. De engine kiest er
  // automatisch een track uit (op prefix in assets/audio, bv. "oriental-03.mp3").
  const templates = [
    { id: "satisfying", name: "Satisfying Build", music: ["calm", "oriental", "spanish"], defaults: { bookend: "none" } },   // type 1: puur de opbouw, geen muur
    { id: "insitu", name: "Lege muur (in-situ)", music: ["calm", "oriental", "spanish"], defaults: { bookend: "auto" } },   // type 2: paneel op een mockup-muur
    { id: "sfeer", name: "Sfeerbeeld", music: ["calm", "oriental", "spanish"], defaults: { bookend: "sfeer" } },
    { id: "trio", name: "Trio (3 patronen)", music: ["calm", "oriental", "spanish"], defaults: {} },   // type 4: 3 patronen -> inzoomen -> inkleuren -> muur
    { id: "colorway", name: "Colorway A/B/C", music: ["upbeat", "lofi", "boombap"], defaults: {} },
    { id: "shapes", name: "Vormen", music: ["lofi", "calm"], defaults: { base: "fields", shapes: ["heart", "star"], endColorway: true } },
  ];

  // Kies automatisch een track uit de categorieën van een template. Val terug op
  // alles als er (nog) niks in die categorie staat. Nooit twee keer achter elkaar
  // dezelfde (anti-herhaling) zodat je echt variatie hoort.
  let lastMusic = "";
  async function pickMusic(cats) {
    let files = [];
    try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)); } catch {}
    if (!files.length) return "";
    const want = files.filter((f) => (cats || []).some((c) => f.toLowerCase().startsWith(c + "-")));
    let pool = want.length ? want : files;
    if (pool.length > 1 && lastMusic) { const p2 = pool.filter((f) => f !== lastMusic); if (p2.length) pool = p2; }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    lastMusic = pick;
    return path.resolve(ROOT, config.audioDir, pick);
  }

  // AUTO-NAAM: als er geen naam is ingevuld kiest de engine er zelf één (anti-herhaling).
  // Fictieve namen — mix van zaaknamen (verkoopt het gevelbord), familie/huis en voornamen.
  // Zwaarder NL + EN, dan FR. Nooit echte personen/merken.
  const NAMES = [
    // NL — zaak
    "Café De Kaai", "Brasserie 't Anker", "Bakkerij Noordhoek", "Salon Nour", "Atelier Vonk",
    "Koffiehuis Mokka", "Restaurant Olij", "Café De Hoek", "Lunchroom Fleur", "Slagerij Van Dijk",
    // NL — familie / voornaam
    "Familie De Vries", "Huize Berg", "Familie El Amrani", "Sofie", "Daan", "Imane", "Youssef", "Lotte", "Noor",
    // EN
    "The Copper Spoon", "Harbour & Co.", "Nord Coffee", "The Ivy Table", "The Harpers", "Olivia", "Liam", "Maya", "Leo",
    // FR
    "Chez Amélie", "Maison Dorée", "Café du Coin", "L'Atelier Bleu", "Camille", "Léa", "Hugo",
  ];
  let lastName = "";
  function pickName() {
    let pool = NAMES.filter((n) => n !== lastName); if (!pool.length) pool = NAMES;
    const pick = pool[Math.floor(Math.random() * pool.length)]; lastName = pick; return pick;
  }

  // AUTO-PATROON: de engine kiest zelf een patroon (anti-herhaling) zodat Mo niks hoeft te
  // kiezen — alleen Render. Geldt voor ALLE types. pickPatterns(n) voor meerdere (trio).
  let lastPattern = "";
  function pickPatterns(n = 1) {
    const pool = (patternList || []).filter(Boolean);
    if (!pool.length) return [];
    if (n <= 1) {
      let c = pool.filter((p) => p !== lastPattern); if (!c.length) c = pool;
      const pick = c[Math.floor(Math.random() * c.length)]; lastPattern = pick; return [pick];
    }
    // n verschillende patronen
    const shuffled = pool.slice().sort(() => Math.random() - 0.5);
    const out = shuffled.slice(0, Math.min(n, shuffled.length));
    lastPattern = out[out.length - 1];
    return out;
  }
  async function listSubjects() {
    return (patternList || []).map((id) => ({ id, thumb: "/api/tot-thumb?p=" + id }));
  }

  // SATISFYING (type 1, herbouwd): toont STEEDS EEN ANDER patroon (auto), elk krisp tegel-voor-
  // tegel ingekleurd op een WITTE 3D-ondergrond, dan door naar het volgende patroon. Geen naam.
  async function makeSatisfyingRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const storyBeats = resolveStory(opts, "", "satisfying");
    const REVEALS = ["radial", "down", "up", "diag"];
    const nSeg = Math.max(1, Math.round(durSec / 6.5));   // elk ~6,5s een ander patroon
    const pats = pickPatterns(nSeg); while (pats.length && pats.length < nSeg) pats.push(pats[pats.length - 1]);
    const prep = [];
    for (let i = 0; i < pats.length; i++) {
      const pid = pats[i], b = await getBase(pid), lock = LOCKS[pid] || {};
      const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
      const svg = await getPatternSvg(pid, nX, nY);
      const parsed = film.parseTiles(svg, REVEALS[i % REVEALS.length]);   // elke ronde andere vulrichting
      const palArr = resolvePalette({}, "satisfying").arr || film.PAL;
      const finalCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
      prep.push({ pid, parsed, palArr, finalCols, aspect: parsed.view[2] / parsed.view[3] });
    }
    if (!prep.length) throw new Error("satisfying: geen patronen");
    const bandTop = Math.round(H * 0.175), bandBot = Math.round(H * 0.90);
    const rectFor = (aspect) => { let h = bandBot - bandTop, w = Math.round(h * aspect); if (w > W * 0.82) { w = Math.round(W * 0.82); h = Math.round(w / aspect); } return { x: Math.round((W - w) / 2), y: Math.round(H * 0.52 - h / 2), w, h }; };
    const Tseg = durSec / nSeg, Tx = Math.min(0.5, Tseg * 0.12);
    function fillColors(P, tl) {
      const Tfill = Tseg * 0.72;
      return film.flowColorsAt(P.parsed, { palette: P.palArr, durSec: Tfill, buildSec: Tfill, buildStart: 0, popSec: 0.12 }, tl);   // krisp tegel-voor-tegel
    }
    function drawPanel(P, cols, id, op) {
      const r = rectFor(P.aspect), pw = P.parsed.view[2], ph = P.parsed.view[3];
      const wrap = `<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(P.parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(P.parsed, cols).replace(/<svg\b[^>]*>/i, wrap);
      const rr = Math.max(6, r.w * 0.03);
      return `<g opacity="${op.toFixed(3)}"><clipPath id="${id}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rr}"/></clipPath>`
        + `<g clip-path="url(#${id})">${mos}${glazeSvg(r.x, r.y, r.w, r.h, id)}</g>`
        + `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rr}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/></g>`;
    }
    function sceneAt(frame) {
      const t = frame / FPS;
      const seg = Math.min(nSeg - 1, Math.floor(t / Tseg)), tl = t - seg * Tseg;
      let inner = "";
      if (seg > 0 && tl < Tx) { const P0 = prep[seg - 1]; inner += drawPanel(P0, P0.finalCols, "sp" + (seg - 1), 1 - smooth(tl / Tx)); }   // vorige uit-faden
      const P = prep[seg];
      const inOp = (seg > 0 && tl < Tx) ? smooth(tl / Tx) : 1;
      inner += drawPanel(P, fillColors(P, tl), "sp" + seg, inOp);
      let overlay = "";
      if (storyBeats.length) {
        const tA = 0.4, tB = durSec * 0.5, n = storyBeats.length, slot = (tB - tA) / n, fade = Math.min(0.6, slot * 0.3);
        for (let i = 0; i < n; i++) {
          const s0 = tA + i * slot, s1 = s0 + slot; let bo = 0;
          if (t >= s0 && t < s1) { if (t < s0 + fade) bo = smooth((t - s0) / fade); else if (t > s1 - fade) bo = 1 - smooth((t - (s1 - fade)) / fade); else bo = 1; }
          if (bo > 0.01) overlay += captionOverlay(storyBeats[i].t, storyBeats[i].k, W, H, bo, "lower");
        }
      }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // TRIO (type 4): toont 3 auto-gekozen patronen naast elkaar -> zoomt in op #1 -> kleurt in
  // -> hangt aan de muur -> terug naar de 3 -> #2 -> #3. De 3 slots "vullen" zich gaandeweg.
  async function makeTrioRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const name = (opts.name || "").trim() || pickName();   // geen naam ingevuld -> engine kiest zelf
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    // 3 verschillende patronen
    let pats = pickPatterns(3);
    while (pats.length && pats.length < 3) pats.push(pats[pats.length - 1]);
    const prep = [];
    for (let i = 0; i < pats.length; i++) {
      const pid = pats[i];
      const base = await getBase(pid); const lock = LOCKS[pid] || {};
      const { nX, nY } = tileCounts(base, lock, PANEL_ASPECT);
      const svg = await getPatternSvg(pid, nX, nY);
      const parsed = film.parseTiles(svg, "radial");
      const palArr = resolvePalette({}, "insitu").arr || film.PAL;   // levendig/gevarieerd per patroon
      const np = name ? plateColours(palArr) : null;
      const finalCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
      const blankCols = new Array(parsed.tiles.length).fill(film.BLANK);
      const mk = mockupPool.length ? mockupPool[Math.floor(Math.random() * mockupPool.length)] : null;
      const aspect = parsed.view[2] / parsed.view[3];
      prep.push({ i, pid, parsed, palArr, np, finalCols, blankCols, mk, aspect });
    }
    if (!prep.length) throw new Error("trio: geen patronen beschikbaar");
    while (prep.length < 3) prep.push(prep[prep.length - 1]);
    const lerp = (a, b, k) => a + (b - a) * k;
    const centerRect = (aspect) => { let h = Math.round(H * 0.70), w = Math.round(h * aspect); if (w > W * 0.80) { w = Math.round(W * 0.80); h = Math.round(w / aspect); } return { x: Math.round((W - w) / 2), y: Math.round(H * 0.52 - h / 2), w, h }; };
    const slotRect = (idx, aspect) => { let h = Math.round(H * 0.26), w = Math.round(h * aspect); if (w > W * 0.29) { w = Math.round(W * 0.29); h = Math.round(w / aspect); } const cx = [W * 0.185, W * 0.5, W * 0.815][idx], cy = H * 0.47; return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h }; };
    const lerpRect = (A, B, k) => ({ x: lerp(A.x, B.x, k), y: lerp(A.y, B.y, k), w: lerp(A.w, B.w, k), h: lerp(A.h, B.h, k) });
    function drawPanel(parsed, cols, r, id, withFrame) {
      const pw = parsed.view[2], ph = parsed.view[3];
      const wrap = `<svg x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrap);
      const rr = Math.max(4, r.w * 0.03);
      let s = `<clipPath id="${id}"><rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="${rr.toFixed(1)}"/></clipPath>`;
      s += `<g clip-path="url(#${id})">${mos}${glazeSvg(r.x, r.y, r.w, r.h, id)}</g>`;
      if (withFrame) s += `<rect x="${r.x.toFixed(1)}" y="${r.y.toFixed(1)}" width="${r.w.toFixed(1)}" height="${r.h.toFixed(1)}" rx="${rr.toFixed(1)}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      return s;
    }
    function insituComposite(P) {
      const pw = P.parsed.view[2], ph = P.parsed.view[3], A2 = pw / ph;
      const pl = P.mk && P.mk.place;
      const wH = Math.round(pl ? pl.h * H : H * 0.34), wW = Math.round(wH * A2);
      const cx = Math.round(pl ? pl.cx * W : W / 2), cy = Math.round(pl ? pl.cy * H : H * 0.46);
      const wx = cx - Math.round(wW / 2), wy = cy - Math.round(wH / 2);
      const roomImg = P.mk && P.mk.blur ? P.mk.blur : (P.mk ? P.mk.uri : "");
      const room = roomImg ? `<image href="${roomImg}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : `<rect width="${W}" height="${H}" fill="#241a3a"/>`;
      const sh = `<radialGradient id="tsh${P.i}" cx="50%" cy="48%" r="50%"><stop offset="0.55" stop-color="#120b05" stop-opacity="0.5"/><stop offset="1" stop-color="#120b05" stop-opacity="0"/></radialGradient>`;
      const shadow = `<defs>${sh}</defs><rect x="${wx - 20}" y="${wy - 4}" width="${wW + 40}" height="${wH + 50}" fill="url(#tsh${P.i})"/>`;
      const deco = `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="#16110d"/><rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      const panel = drawPanel(P.parsed, P.finalCols, { x: wx, y: wy, w: wW, h: wH }, "tw" + P.i, false);
      let nm = "";
      if (name && P.np) { const plW = Math.round(wW * 0.62), plH = Math.round(plW * 200 / 560), plX = cx - Math.round(plW / 2), plY = cy - Math.round(plH / 2); nm = nameLayerSvg(name, P.np, 1).replace(/<svg\b[^>]*>/i, `<svg x="${plX}" y="${plY}" width="${plW}" height="${plH}" viewBox="0 0 560 200" preserveAspectRatio="xMidYMid meet">`); }
      return room + shadow + deco + panel + nm;
    }
    const Ta = durSec / 3;
    function colorsFor(j, t) {
      const P = prep[j], s = j * Ta, bs = s + Ta * 0.24, be = s + Ta * 0.54;
      if (t < bs) return P.blankCols;
      if (t >= be) return P.finalCols;
      return film.flowColorsAt(P.parsed, { palette: P.palArr, durSec: be - bs, buildSec: be - bs, buildStart: 0 }, t - bs);
    }
    function sceneAt(frame) {
      const t = frame / FPS;
      const a = Math.min(2, Math.floor(t / Ta)), f = (t - a * Ta) / Ta;
      let featureK, wallK;
      if (f < 0.14) { featureK = 0; wallK = 0; }
      else if (f < 0.24) { featureK = smooth((f - 0.14) / 0.10); wallK = 0; }
      else if (f < 0.60) { featureK = 1; wallK = 0; }
      else if (f < 0.70) { featureK = 1; wallK = smooth((f - 0.60) / 0.10); }
      else if (f < 0.82) { featureK = 1; wallK = 1; }
      else if (f < 0.88) { featureK = 1; wallK = 1 - smooth((f - 0.82) / 0.06); }
      else { featureK = 1 - smooth((f - 0.88) / 0.12); wallK = 0; }
      const Pa = prep[a];
      const fRect = lerpRect(slotRect(a, Pa.aspect), centerRect(Pa.aspect), featureK);
      let inner = "", overlay = "";
      // de twee niet-actieve patronen op hun slot (vervagen bij inzoom)
      const slotOp = 1 - featureK;
      if (slotOp > 0.003) { let g = ""; for (let j = 0; j < 3; j++) { if (j === a) continue; g += drawPanel(prep[j].parsed, colorsFor(j, t), slotRect(j, prep[j].aspect), "ts" + j, true); } inner += `<g opacity="${slotOp.toFixed(3)}">${g}</g>`; }
      // het actieve patroon: beweegt/groeit van slot naar midden terwijl het inkleurt
      inner += drawPanel(Pa.parsed, colorsFor(a, t), fRect, "tf", true);
      // aan de muur (dissolve erover)
      if (wallK > 0.003) overlay += `<g opacity="${wallK.toFixed(3)}">${insituComposite(Pa)}</g>`;
      // caption bij de openings-trio
      if (a === 0 && f < 0.16) { const op = (f < 0.10 ? Math.min(1, f / 0.04) : 1 - smooth((f - 0.10) / 0.06)); if (op > 0.01) overlay += captionOverlay(name ? name + " — in drie stijlen" : "Eén naam, drie stijlen", null, W, H, op, "top"); }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // bouw een render-plan voor de kern: { W,H,FPS,SS,durSec, sceneAt(frame) }
  async function makeRender({ subjectId, templateId, opts = {}, format = "9:16" }) {
    if (templateId === "trio") return await makeTrioRender({ opts, format });
    if (templateId === "satisfying") return await makeSatisfyingRender({ opts, format });
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    // GEEN onderwerp gekozen? Engine kiest zelf een patroon (alle types) -> Mo klikt enkel Render.
    if (!subjectId || !(patternList || []).includes(subjectId)) { const p = pickPatterns(1)[0]; if (p) subjectId = p; }
    const base = await getBase(subjectId);
    const lock = LOCKS[subjectId] || {};
    const { nX, nY } = tileCounts(base, lock, PANEL_ASPECT);
    const svg = await getPatternSvg(subjectId, nX, nY);
    const parsed = film.parseTiles(svg, opts.reveal || "radial");
    if (!parsed.tiles.length) throw new Error(`patroon ${subjectId} heeft 0 tegels`);
    const tpl = templates.find((t) => t.id === templateId) || templates[0];
    const autoMusic = await pickMusic(tpl.music || ["calm"]);   // engine kiest zelf de muziek per type
    const isFlow = templateId === "satisfying" || templateId === "insitu" || templateId === "sfeer";
    const isSatis = templateId === "satisfying";
    const loop = isFlow;   // naadloze loop
    // SATISFYING = doorlopend stromend kleurveld met vrij instelbare duur.
    // Andere templates = de storyboard-weg (losse scènes).
    let story = null, durSec, buildSec = 0;
    if (isFlow) { durSec = resolveDuration(opts); buildSec = Math.min(6, Math.max(2.5, durSec * 0.22)); }
    else { story = templateId === "colorway" ? storyboardColorway(opts) : storyboardFrom(opts); durSec = film.totalDuration(story); }
    const A = parsed.view[2] / parsed.view[3];
    const bandTop = Math.round(H * 0.155), bandBot = Math.round(H * 0.905);
    const fit = fitRect(Math.round(W * 0.78), bandBot - bandTop, A);   // smaller -> ruimte voor pilaren
    let panelW = fit.w, panelH = fit.h;
    const pad = Math.max(6 * SS, Math.round(panelW * 0.018));
    const innerW = panelW - pad * 2, innerH = panelH - pad * 2;
    let panelX = Math.round((W - panelW) / 2), panelY = Math.round(bandTop + (bandBot - bandTop - panelH) / 2);
    const name = (opts.name || "").trim() || pickName();   // geen naam ingevuld -> engine kiest zelf
    const palArr = resolvePalette(opts, templateId).arr || film.PAL;
    const np = name ? plateColours(palArr) : null;
    // SATISFYING-CYCLUS: een rij GEVARIEERDE paletten — elke ronde vult 'ie opnieuw in
    // een ander kleurenverhaal. Eerste ronde = het gekozen palet (sluit aan op badge/naam),
    // daarna geschud door de andere levendige paletten/families.
    const cyclePals = (() => {
      const all = PALS(); const seen = new Set(); const list = [];
      const add = (arr) => { if (arr && arr.length) { const k = arr.join(","); if (!seen.has(k)) { seen.add(k); list.push(arr); } } };
      add(palArr);
      const order = ["modern", "warm", "cool", "saffraan", "smaragd", "kobalt", "terracotta", "aubergine"].sort(() => Math.random() - 0.5);
      for (const key of order) add(all[key]);
      return list;
    })();
    const storyBeats = resolveStory(opts, name, templateId);   // verhaal-beats (per type), lopen mee met de ambiance
    const storyPos = "lower";   // onderregel voor álle types (bovenin zit nu het logo)
    // GEKOZEN SFEERBEELD (input-foto). Valt terug op de eerste in de pool, dan op de badge van de site.
    // Sfeerbeeld: handmatige keuze wint; anders kiest de engine zelf een willekeurige foto uit de pool.
    // Keuze (opts.image): een MOCKUP-id -> in-situ; een FOTO-id -> losse foto als startbeeld;
    // leeg = auto (in-situ als er mockups zijn, anders een willekeurige foto).
    // Begin/eind-beeld: "insitu" = ons paneel op een mockup-muur; "sfeer" = een echt
    // sfeerbeeld (mood/B-roll) dat in de tegels oplost en terug; "auto" = in-situ als er
    // mockups zijn, anders sfeer, anders losse foto. Het template "Sfeerbeeld" zet 'm op sfeer.
    const want = opts.bookend || (tpl.defaults && tpl.defaults.bookend) || "auto";
    const rnd = (a) => a[Math.floor(Math.random() * a.length)];
    const mById = (id) => mockupPool.find((m) => m.id === id);
    const sById = (id) => sfeerPool.find((s) => s.id === id);
    let chosenMockup = null, heroObj = null;
    if (opts.image) { chosenMockup = mById(opts.image) || null; if (!chosenMockup) heroObj = sById(opts.image) || imgById(opts.image) || null; }
    else if (want === "none") { /* puur de opbouw, geen begin/eind-beeld (type 1) */ }
    else if (want === "sfeer") { heroObj = sfeerPool.length ? rnd(sfeerPool) : (imagePool.length ? rnd(imagePool) : null); }
    else if (want === "insitu") { chosenMockup = mockupPool.length ? rnd(mockupPool) : null; }
    else { // auto
      if (mockupPool.length) chosenMockup = rnd(mockupPool);
      else if (sfeerPool.length) heroObj = rnd(sfeerPool);
      else if (imagePool.length) heroObj = rnd(imagePool);
    }
    const hero = heroObj ? heroObj.uri : "";
    const insitu = loop && !!chosenMockup;       // in-situ = ons paneel op de mockup-muur
    const mockup = chosenMockup ? chosenMockup.uri : "";
    // Kleur: bij in-situ stuurt het Palet (neutrale muur); anders kleur-match met de foto.
    const flowPal = insitu ? palArr : (heroObj && heroObj.pal && heroObj.pal.length >= 4 ? heroObj.pal : palArr);
    const bookend = loop && (!!hero || insitu);   // bookend: in-situ of foto
    const bk = 1.5;
    // klein gekaderd beeld bovenin links: ECHTE productfoto als die er is; anders het
    // AFGEMAAKTE paneel (nooit een lege mockup-muur — dat oogt leeg/kapot).
    let badge = "";
    {
      const bw = Math.round(W * 0.17), bh = Math.round(bw * 1.2), bx = Math.round(W * 0.045), by = Math.round(H * 0.032);
      const bvw = parsed.view[2], bvh = parsed.view[3];
      const frame = `<rect x="${bx - 2}" y="${by - 2}" width="${bw + 4}" height="${bh + 4}" rx="8" fill="#140f1e" stroke="${branding.gold}" stroke-width="2"/>`
        + `<clipPath id="bdgclip"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="6"/></clipPath>`;
      if (hero) {
        badge = frame + `<image href="${hero}" x="${bx}" y="${by}" width="${bw}" height="${bh}" preserveAspectRatio="xMidYMid slice" clip-path="url(#bdgclip)"/>`;
      } else {
        // afgemaakt paneel (alle tegels op eindkleur) als mini-preview
        const bcols = film.flowColorsAt(parsed, { palette: flowPal, durSec, buildSec: 1, buildStart: 0 }, durSec + 100);
        const wrapBdg = `<svg x="${bx}" y="${by}" width="${bw}" height="${bh}" viewBox="0 0 ${bvw} ${bvh}" preserveAspectRatio="xMidYMid slice">`;
        const bmos = film.buildSvg(parsed, bcols).replace(/<svg\b[^>]*>/i, wrapBdg)
          + film.buildGlaze(parsed, bcols).replace(/<svg\b[^>]*>/i, wrapBdg);
        badge = frame + `<g clip-path="url(#bdgclip)">${bmos}${glazeSvg(bx, by, bw, bh, "g")}</g>`;
      }
    }
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

    // CAMERA-REGIE (alleen met foto-bookend): intro zoomt in op de tegels in de foto,
    // lost op in het kale mozaïek dat inkleurt terwijl de camera terugtrekt; aan het eind
    // zoomt de camera weer in op het patroon, lost op in de foto, die langzaam uitzoomt.
    const camZoom = 1.22;   // RUSTIGE zoom: te veel zoom op 24fps strobet/schokt (was 1.7/2.0)
    // OPBOUW is het grote middenstuk: tegel voor tegel inkleuren terwijl de camera
    // héél langzaam terugtrekt. Daarna een korte HOLD op het afgemaakte paneel.
    let Ti = 3.5, Dt = 1.0, To = 3.5, Tb, Thold;
    if (bookend) { const mid = Math.max(2, durSec - Ti - To); Tb = mid * 0.66; Thold = mid - Tb; }
    else { Ti = 0; Tb = Math.max(1, durSec * 0.6); Thold = 0; }
    const buildStart = bookend ? Ti : 0;   // inkleuren start ná de intro-inzoom
    const pw = parsed.view[2], ph = parsed.view[3];
    // tegel-klik UIT — het constante getik was irritant, niet satisfying. Alleen muziek
    // eronder. (Mechaniek blijft in de kern; later eventueel met een échte ASMR-sample.)
    const clicks = [];
    // IN-SITU: ons AFGEMAAKTE paneel op de mockup-muur geplakt. De camera kan er als één
    // geheel op inzoomen; bij max zoom lost het op in de opbouw-animatie (zelfde patroon).
    // IN-SITU v2: de tegels bouwen ZICH OP OP DE MUUR (niet op een losse achtergrond).
    // De mockup-muur staat de hele tijd achter het paneel; het opbouw-mozaïek valt precies in
    // de lijst op de gedetecteerde vrije muurplek. Geen positie-sprong meer bij de overgang.
    let insituWall = "";          // vaste achtergrond: muur (blur/DoF) + contactschaduw + lijst
    if (insitu) {
      const A2 = pw / ph;
      const pl = chosenMockup && chosenMockup.place;
      const wH = Math.round(pl ? pl.h * H : panelH), wW = Math.round(wH * A2);
      const cxp = Math.round(pl ? pl.cx * W : W / 2), cyp = Math.round(pl ? pl.cy * H : panelY + panelH / 2);
      const wx = Math.round(cxp - wW / 2), wy = Math.round(cyp - wH / 2);
      // het paneel-rechthoek = de muurplek: alles (opbouw, clip, rand, naam) volgt deze plek
      panelX = wx; panelY = wy; panelW = wW; panelH = wH;
      // VOORAF geblurde muur (scherptediepte, 1x gebakken i.p.v. elk frame) -> veel sneller.
      const roomImg = (chosenMockup && chosenMockup.blur) ? chosenMockup.blur : mockup;
      const room = `<image href="${roomImg}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`;
      // zachte slagschaduw zónder filter (radiaal verloop) -> het paneel hangt echt aan de muur
      const sh = `<radialGradient id="psh" cx="50%" cy="48%" r="50%"><stop offset="0.55" stop-color="#120b05" stop-opacity="0.52"/><stop offset="1" stop-color="#120b05" stop-opacity="0"/></radialGradient>`;
      const shadow = `<defs>${sh}</defs><rect x="${wx - 22}" y="${wy - 6}" width="${wW + 44}" height="${wH + 54}" fill="url(#psh)"/>`;
      const deco = `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="#16110d"/>`
        + `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      insituWall = room + shadow + deco;
    }
    // Paleis-frame: Moorse boog om het paneel + twee pilaren + mozaïek-medaillon-watermerk.
    const archD = moorArch(panelX, panelY, panelW, panelH);
    const plumCol = "#201734";
    const colW = Math.min(Math.round(panelX * 0.5), Math.round(W * 0.052)), colTop = panelY + panelH * 0.34, colBot = panelY + panelH;
    const cols = column(Math.round(panelX * 0.5), colTop, colBot, colW, branding.gold, plumCol) + column(Math.round(W - panelX * 0.5), colTop, colBot, colW, branding.gold, plumCol);
    const archLine = `<path d="${archD}" fill="none" stroke="${branding.gold}" stroke-width="3"/>`;
    // Het paneel is in het MIDDEN een gewone (afgeronde) rechthoek; de boog + pilaren
    // komen alleen aan begin/eind. De "corner-mask" dekt met de achtergrond de hoeken
    // boven de boog af -> boog-silhouet; op 0 opacity zie je de volle rechthoek.
    const rectClip = `<clipPath id="pan"><rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="10"/></clipPath>`;
    const rectBorder = `<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="10" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
    const maskRectD = `M ${panelX - 3} ${panelY - 3} H ${panelX + panelW + 3} V ${panelY + panelH + 3} H ${panelX - 3} Z`;
    const cornerMaskD = `${maskRectD} ${archD}`;
    const breath = (tt) => 1 + 0.10 * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * (tt / durSec)));   // heel zachte zoom-adem (getemperd)
    // Mid-reveals: toon tussen het patroon door een paar keer het ECHTE paneel (de foto)
    // — patroon -> eindresultaat zellige -> patroon. Puls 0..1..0 op een paar momenten in de flow.
    function revealK(tt) {
      const fS = Ti + Tb, fE = durSec - To, span = fE - fS;
      if (span < 7) return 0;
      const n = Math.max(1, Math.round(span / 11)), rl = 2.8;
      for (let i = 1; i <= n; i++) { const c = fS + span * (i / (n + 1)), d = Math.abs(tt - c); if (d < rl / 2) return smooth(Math.min(1, (1 - d / (rl / 2)) * 1.7)); }
      return 0;
    }

    function sceneAt(frame) {
      const t = frame / FPS, tleft = durSec - t;
      // Camera: bookendK = foto aan begin/eind (mét medaillon); rK = foto-reveal tussendoor
      // (zónder medaillon). zMos/zPho = inzoom op mozaïek/foto.
      let bookendK = 0, zMos = 1, zPho = 1, tailK = 0, frameK = 0;
      if (bookend) {
        const bEnd = Ti + Tb, oStart = durSec - To, oZi = oStart + To * 0.45, oDis = oZi + To * 0.30;
        if (t < Ti) {                                   // intro: foto zoomt langzaam in -> kale tegels
          zPho = 1 + (camZoom - 1) * smooth(t / Ti); zMos = camZoom;
          bookendK = t < Ti - Dt ? 1 : 1 - smooth((t - (Ti - Dt)) / Dt);   // trage dissolve foto -> kaal mozaïek
        } else if (t < bEnd) {                          // OPBOUW: tegel voor tegel, camera trekt héél langzaam terug
          zMos = camZoom - (camZoom - 1) * smooth((t - Ti) / Tb);
        } else if (t < oStart) {                        // HOLD: afgemaakt paneel, zachte zoom-adem
          zMos = breath(t);
        } else if (t < oZi) {                           // outro: inzoomen op het patroon
          zMos = 1 + (camZoom - 1) * smooth((t - oStart) / (oZi - oStart));
        } else if (t < oDis) {                          // dissolve paneel -> foto (beide ingezoomd)
          zMos = camZoom; zPho = camZoom; bookendK = smooth((t - oZi) / (oDis - oZi));
        } else {                                        // foto zoomt langzaam uit -> naadloos terug naar begin
          bookendK = 1; zMos = camZoom; zPho = camZoom - (camZoom - 1) * smooth((t - oDis) / (durSec - oDis));
        }
        // boog + pilaren ALLEEN aan begin/eind; vervaagt vroeg in de opbouw, komt terug bij de outro-foto
        const fFade = Math.min(Tb, 3);
        if (t < Ti) frameK = 1;
        else if (t < Ti + fFade) frameK = 1 - smooth((t - Ti) / fFade);
        else if (t < oZi) frameK = 0;
        else if (t < oDis) frameK = smooth((t - oZi) / (oDis - oZi));
        else frameK = 1;
        if (insitu) frameK = 0;   // in-situ: de ruimte is het kader, geen boog/pilaren
      } else if (loop && tleft < 1.3) tailK = Math.min(1, Math.max(0, 1 - tleft / 1.3));
      const rK = bookend ? revealK(t) : 0;              // het échte paneel tussendoor tonen
      const photoK = Math.max(bookendK, rK);            // totale foto-zichtbaarheid
      const zPhoto = bookendK >= rK ? zPho : 1.05;      // reveal: héél lichte zoom
      const medOp = bookendK * 0.8;                     // medaillon ALLEEN aan begin/eind
      const tempoMul = { snel: 1.6, normaal: 1.0, rustig: 0.6 }[opts.tempo] || 1.0;   // Tempo stuurt de flow-snelheid
      const isCycle = isSatis && !bookend;   // pure satisfying = eindeloze vul/leeg/hervul-cyclus
      let colors = isCycle
        ? film.cycleColorsAt(parsed, { palettes: cyclePals, durSec, speed: tempoMul }, t)
        : (isFlow ? film.flowColorsAt(parsed, { palette: flowPal, durSec, buildSec: Tb, buildStart, speed: tempoMul }, t) : film.colorsAt(parsed, story, t));
      if (tailK > 0) colors = colors.map((c) => _mix(c, film.BLANK, tailK));
      const vw = pw / zMos, vh = ph / zMos, vx = (pw - vw) / 2, vy = (ph - vh) / 2;
      const wrapB = `<svg x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" viewBox="${vx.toFixed(2)} ${vy.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}" preserveAspectRatio="xMidYMid slice">`;
      const mosaic = film.buildSvg(parsed, colors).replace(/<svg\b[^>]*>/i, wrapB)
        + film.buildGlaze(parsed, colors).replace(/<svg\b[^>]*>/i, wrapB);   // + per-tegel glazuur-reliëf
      // LICHTVEEG: één zachte glans trekt diagonaal over het afgemaakte paneel (glazuur
      // vangt licht) — loopt ná de opbouw, tijdens de hold.
      let sweep = "";
      {
        const hs = buildStart + Tb + 0.2, he = (bookend ? durSec - To : durSec) - 0.3;
        if (!isCycle && t > hs && t < he) {
          const p = (t - hs) / Math.max(0.1, he - hs);
          const bw2 = panelW * 0.24, cxs = panelX - panelW * 0.35 + p * (panelW * 1.7), cy2 = panelY + panelH / 2;
          sweep = `<defs><linearGradient id="swp" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff6e6" stop-opacity="0"/><stop offset="0.5" stop-color="#fff6e6" stop-opacity="0.20"/><stop offset="1" stop-color="#fff6e6" stop-opacity="0"/></linearGradient></defs>`
            + `<rect x="${(cxs - bw2 / 2).toFixed(1)}" y="${(panelY - panelH * 0.3).toFixed(1)}" width="${bw2.toFixed(1)}" height="${(panelH * 1.6).toFixed(1)}" fill="url(#swp)" transform="rotate(14 ${cxs.toFixed(1)} ${cy2.toFixed(1)})"/>`;
        }
      }
      // mozaïek in de volle (afgeronde) rechthoek + glazuur-glans + lichtveeg erover (vast op
      // het paneel, zodat de lichtval blijft staan terwijl de tegels inkleuren)
      // IN-SITU: de muur (DoF) + lijst staan ACHTER het mozaïek; het paneel bouwt in de lijst.
      const inner = `${insituWall}${rectClip}<g clip-path="url(#pan)">${mosaic}${glazeSvg(panelX, panelY, panelW, panelH, "b")}${sweep}</g>`;
      let overlay = "";
      // Oude foto-bookend (alleen bij sfeer/losse foto): paneel -> echte foto. In-situ heeft
      // de muur al permanent in beeld, dus geen aparte foto-dissolve meer.
      if (!insitu && bookend && photoK > 0.002) {
        const k = photoK.toFixed(3);
        const iw = panelW * zPhoto, ih = panelH * zPhoto, ix = panelX - (iw - panelW) / 2, iy = panelY - (ih - panelH) / 2;
        overlay += `<g clip-path="url(#pan)"><image href="${hero}" x="${ix.toFixed(1)}" y="${iy.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="xMidYMid slice" opacity="${k}"/></g>`;
      }
      // Paneel-rand: in-situ heeft al een gouden lijst in insituWall, dus hier niet dubbel.
      if (!insitu) overlay += rectBorder;
      // boog + pilaren ALLEEN aan begin/eind (corner-mask dekt de hoeken met de achtergrond af)
      if (frameK > 0.003) {
        const fk = frameK.toFixed(3);
        overlay += `<path d="${cornerMaskD}" fill-rule="evenodd" fill="url(#bg)" opacity="${fk}"/><g opacity="${fk}">${archLine}${cols}</g>`;
      }
      // medaillon alleen aan begin/eind, en niet in-situ (de ruimte spreekt voor zich)
      if (!insitu && medOp > 0.004) overlay += `<g opacity="${medOp.toFixed(3)}">${medallion(W / 2, panelY + panelH * 0.42, panelW * 0.24, branding.gold)}</g>`;
      overlay += badge;
      // De NAAM is de payoff: graveert tijdens de vrije flow, verdwijnt met de outro-foto.
      if (name && np) {
        const outK = (bookend && !insitu) ? photoK : tailK;
        let op;
        if (isCycle) {
          // SATISFYING: de naam pulseert mee met elke ronde — graveert zodra het paneel vol is
          // (de payoff) en vervaagt als 't weer leegloopt, zodat je de hele cyclus blijft zien.
          const cycN = Math.max(1, Math.round((durSec * tempoMul) / 7));
          const Tc = durSec / cycN, Tf = Tc * 0.46, Th = Tc * 0.12, Td = Tc * 0.40;
          const tl = t - Math.min(cycN - 1, Math.floor(t / Tc)) * Tc;
          const up = Tf * 0.72, down = Tf + Th + Td * 0.22;
          if (tl < up) op = 0;
          else if (tl < Tf) op = smooth((tl - up) / Math.max(0.1, Tf - up));
          else if (tl < down) op = 1;
          else op = Math.max(0, 1 - smooth((tl - down) / Math.max(0.1, Tc - down)));
          op *= (1 - outK);
        } else {
          // naam = vaste afsluiter: verschijnt op het afgemaakte paneel en blijft staan tot de outro
          const oStartN = durSec - (bookend ? To : 1.3);
          const nameStart = Math.min(buildStart + Tb + 0.5, oStartN - 2.6);
          op = Math.max(0, Math.min(1, (t - nameStart) / 1.1)) * (1 - outK);
        }
        if (op > 0.01) {
          const plateW = Math.round(panelW * 0.56), plateH = Math.round(plateW * 200 / 560);
          const plateX = Math.round(panelX + (panelW - plateW) / 2), plateY = Math.round(panelY + (panelH - plateH) / 2 + (1 - Math.min(1, op)) * 10);
          const pl = nameLayerSvg(name, np, 1).replace(/<svg\b[^>]*>/i, `<svg x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" viewBox="0 0 560 200" preserveAspectRatio="xMidYMid meet">`);
          overlay += `<g opacity="${op.toFixed(3)}">${pl}</g>`;
        }
      }
      // VERHAAL: de beats lopen één voor één mee met de opbouw/ambiance (cross-fade),
      // en zijn weg vóór de naam de payoff wordt. Premium onderregel (in-situ/sfeer) of
      // elegante bovenregel (satisfying).
      if (storyBeats.length) {
        const tA = bookend ? Ti * 0.45 : 0.4;
        const tB = bookend ? Ti + Tb + Thold * 0.5 : durSec * 0.52;
        const n = storyBeats.length, slot = (tB - tA) / n, fade = Math.min(0.6, slot * 0.3);
        for (let i = 0; i < n; i++) {
          const s0 = tA + i * slot, s1 = s0 + slot;
          let bo = 0;
          if (t >= s0 && t < s1) {
            if (t < s0 + fade) bo = smooth((t - s0) / fade);
            else if (t > s1 - fade) bo = 1 - smooth((t - (s1 - fade)) / fade);
            else bo = 1;
          }
          if (bo > 0.01) overlay += captionOverlay(storyBeats[i].t, storyBeats[i].k, W, H, bo, storyPos);
        }
      }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks };
  }

  // thumbnail: kaal patroon leesbaar (cream op plum) — voor de patroonkiezer
  async function thumbSvg(pattern) {
    let svg = await getBase(pattern);
    return svg.replace(/fill:\s*#[0-9a-fA-F]{3,6}/g, "fill:#e8dcc0").replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#e8dcc0"')
      .replace(/stroke:\s*#[0-9a-fA-F]{3,6}/g, "stroke:#3a2d52").replace(/stroke="#[0-9a-fA-F]{3,6}"/g, 'stroke="#3a2d52"');
  }

  return {
    id: "taleoftiles", name: "Tale of Tiles", branding,
    init, listSubjects, listImages, listMockups, listSfeer, templates, makeRender, thumbSvg,
    options: ["palette", "duration", "reveal", "tempo", "name", "image", "bookend"],
  };
}
