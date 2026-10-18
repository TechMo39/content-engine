// MERK-MODULE: Tale of Tiles. Alle tegel-specifieke dingen (patronen, tegeling,
// voeg, naamplaat) zitten HIER — de kern weet hier niks van.
// Levert: branding, onderwerpen (patronen), templates (video-types), en makeRender().
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { composeChrome, fitRect, loadLogo, loadImageFile, imagePalette, enrichPalette, imageGridRGB, blurImageFile, FORMATS, escapeXml, FFMPEG } from "../core/renderer.mjs";

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
  // PLAAT kleurt nu DUIDELIJK mee met het patroon: meer verzadigde tint dan voorheen (was 70%
  // naar crème = bijna neutraal). Een leesbaarheidsvloer tilt 'm zo nodig terug naar crème,
  // zodat de donkere letters altijd leesbaar blijven — ook op een diep/donker palet.
  let plate = _mix(edge, "#f6f1e8", 0.52);
  for (let i = 0; i < 2 && _lum(plate) < 168; i++) plate = _mix(plate, "#f8f3ea", 0.5);
  return { plate, ink: _mix(darkest, "#17120e", 0.20), edge };
}
// NAAMPLAAT die zich AANPAST aan de tekst: de plaatbreedte (viewBox-vw) wordt afgeleid van de
// werkelijke tekstbreedte bij een vaste, leesbare korpsgrootte, zodat de letters NOOIT buiten
// de plaat vallen (vroeger liep lange tekst over de rand). Lange namen -> bredere plaat (en bij
// >16 tekens netjes 2 regels). Geeft { svg, vw, vh } terug; platePlace zet 'm op maat neer.
function nameLayerSvg(nm, np) {
  const stone = np.plate, stoneDark = _mix(stone, "#000000", 0.28), stoneLight = _mix(stone, "#ffffff", 0.55), band = np.edge;
  const engrave = _mix(np.ink || np.edge || stone, "#000000", 0.15), brass = "#b08d57";
  const FF = SERIF, WT = 600, TR = 4, CW = 0.60, fpx = 92;   // vaste leesbare korpsgrootte; plaat groeit mee
  const words = (nm || "").trim().split(/\s+/).filter(Boolean);
  let lines = words.length ? [nm.trim()] : [""];
  if ((nm || "").length > 16 && words.length > 1) { const mid = Math.ceil(words.length / 2); lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")]; }
  const lineW = (l) => l.length * fpx * CW + Math.max(0, l.length - 1) * TR;
  const longest = Math.max(1, ...lines.map(lineW));
  const padX = Math.round(fpx * 1.15), lh = fpx * 1.12;
  const vw = Math.max(360, Math.round(longest + padX * 2));
  const vh = Math.round(lines.length * lh + fpx * 1.15);
  const y0 = vh / 2 - (lines.length - 1) * lh / 2 + fpx * 0.33;
  let out = `<svg viewBox="0 0 ${vw} ${vh}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`;
  out += `<rect x="6" y="6" width="${vw - 12}" height="${vh - 12}" rx="18" fill="${band}"/>`;
  out += `<rect x="12" y="12" width="${vw - 24}" height="${vh - 24}" rx="14" fill="${stoneDark}"/>`;
  out += `<rect x="15" y="15" width="${vw - 30}" height="${vh - 30}" rx="12" fill="${stone}"/>`;
  out += `<rect x="26" y="22" width="${vw - 52}" height="${vh - 44}" rx="8" fill="none" stroke="${brass}" stroke-width="2"/>`;
  const tl = (x, y, ln, f) => `<text x="${x}" y="${y}" text-anchor="middle" font-family="${FF}" font-weight="${WT}" font-size="${fpx}" letter-spacing="${TR}" fill="${f}">${escapeXml(String(ln).toUpperCase())}</text>`;
  for (let li = 0; li < lines.length; li++) { const yy = y0 + li * lh; out += tl(vw / 2 + 1, yy + 1, lines[li], stoneDark); out += tl(vw / 2 - 1, yy - 1, lines[li], stoneLight); out += tl(vw / 2, yy, lines[li], engrave); }
  out += `</svg>`;
  return { svg: out, vw, vh };
}
// Zet een naamplaat gecentreerd op (cx,cy) met een doel-HOOGTE; breedte volgt de tekst-aspect,
// begrensd op maxW (dan schaalt 'ie mee kleiner, maar valt nooit buiten de plaat).
function platePlace(nm, np, cx, cy, plH, maxW) {
  const r = nameLayerSvg(nm, np);
  let h = plH, w = Math.round(h * r.vw / r.vh);
  if (maxW && w > maxW) { w = Math.round(maxW); h = Math.round(w * r.vh / r.vw); }
  const x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
  return r.svg.replace(/<svg\b[^>]*>/i, `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${r.vw} ${r.vh}" preserveAspectRatio="xMidYMid meet">`);
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
const SERIF = "Fraunces, Cormorant Garamond, DejaVu Serif, serif";

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
      // SLOGAN onder het logo (merkkeuze #1), taal-afhankelijk. Geen "zellige" meer.
      const slg = ({ nl: "JOUW NAAM, VERTELD IN TEGELS.", en: "YOUR NAME, TOLD IN TILES.", fr: "VOTRE NOM, RACONTÉ EN CARREAUX." })[branding.lang] || "JOUW NAAM, VERTELD IN TEGELS.";
      if (branding.markLogo) {
        const ar = 389 / 96;
        const lw = Math.round(W * 0.36), lh = Math.round(lw / ar);   // kleiner (was 0.44) — hing te veel over de panelen
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
          + `<text x="${W / 2}" y="${tagY}" text-anchor="middle" font-family="${SERIF}" font-weight="500" font-size="${tag}" letter-spacing="${(tag * 0.26).toFixed(1)}" fill="${cream}" opacity="0.8">${slg}</text>`;
      }
      const midY = Math.round(H * 0.072), fs = Math.round(W * 0.05), ruleW = fs * 4.3, tag2 = Math.round(fs * 0.33);
      return `<polygon points="${star8(W / 2, midY - fs * 1.02, fs * 0.52, fs * 0.22)}" fill="${gold}"/>`
        + `<text x="${W / 2}" y="${midY + fs * 0.32}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fs}" letter-spacing="${(fs * 0.16).toFixed(1)}" fill="${gold}">TALE OF TILES</text>`
        + `<line x1="${W / 2 - ruleW}" y1="${midY + fs * 0.62}" x2="${W / 2 + ruleW}" y2="${midY + fs * 0.62}" stroke="${gold}" stroke-width="1.3" opacity="0.75"/>`
        + `<text x="${W / 2}" y="${midY + fs * 1.12}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="${tag2}" letter-spacing="${(tag2 * 0.14).toFixed(1)}" fill="${cream}" opacity="0.82">${slg}</text>`;
    },
  };
  const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
  const IMG_DIR = path.resolve(ROOT, "assets/images/taleoftiles");
  const MOCKUP_DIR = path.resolve(IMG_DIR, "mockups");
  const SFEER_DIR = path.resolve(IMG_DIR, "sfeer");   // sfeerbeelden = mood/B-roll (begin/eind i.p.v. in-situ)
  const GUESS_DIR = path.resolve(IMG_DIR, "guess");   // raad-beelden: herkenbare silhouetten/foto's voor stopzodra
  let film = null, LOCKS = {}, patternList = [], imagePool = [], mockupPool = [], sfeerPool = [], guessPool = [];
  const baseCache = new Map(), svgCache = new Map();

  // PERSISTENTE ANTI-HERHALING: onthoud de laatst gebruikte keuzes (patroon, naam, muziek,
  // familie, mockup, sfeerbeeld) in een klein JSON in out/, zodat elke render écht nieuw is —
  // niet alleen binnen één draaiende sessie, maar ook ná een herstart. "Ik wil altijd nieuwe
  // filmpjes." Houdt ~60% van elke pool als "recent gebruikt" tegen en rouleert door de rest.
  const STATE_FILE = path.resolve(ROOT, config.outDir, ".engine-state.json");
  let recent = { patterns: [], names: [], music: [], families: [], mockups: [], sfeer: [] };
  async function loadState() { try { const j = JSON.parse(await fs.readFile(STATE_FILE, "utf8")); recent = { ...recent, ...(j || {}) }; } catch {} }
  let _saveT = null;
  function saveState() { if (_saveT) clearTimeout(_saveT); _saveT = setTimeout(() => { fs.writeFile(STATE_FILE, JSON.stringify(recent)).catch(() => {}); }, 300); }
  // kies één vers item uit pool dat niet in de recente historie zit (val terug op de hele pool
  // als alles recent is). onthoud daarna; trim de historie op ~60% van de poolgrootte.
  function pickFresh(pool, key) {
    const arr = (pool || []).filter((x) => x != null);
    if (!arr.length) return null;
    const hist = recent[key] || (recent[key] = []);
    const keep = Math.max(1, Math.min(arr.length - 1, Math.floor(arr.length * 0.6)));
    let avail = arr.filter((x) => !hist.includes(x));
    if (!avail.length) avail = arr;
    const pick = avail[Math.floor(Math.random() * avail.length)];
    hist.push(pick); while (hist.length > keep) hist.shift();
    saveState();
    return pick;
  }
  // n verschillende verse items (voor trio/geentwee: meerdere patronen tegelijk).
  function pickFreshN(pool, key, n) {
    const out = [], arr = (pool || []).filter(Boolean);
    for (let i = 0; i < n && arr.length; i++) { const p = pickFresh(arr.filter((x) => !out.includes(x)), key); if (p == null) break; out.push(p); }
    return out;
  }
  // vers object uit een pool met .id (mockups/sfeer).
  function pickFreshObj(pool, key) { const id = pickFresh((pool || []).map((x) => x.id), key); return id ? (pool.find((x) => x.id === id) || null) : null; }

  // Foto-pool: Mo legt zijn (Gemini-)foto's in assets/images/taleoftiles/.
  // Mockup-pool: lege-muur/ruimte-foto's in assets/images/taleoftiles/mockups/ —
  // daarop plakken we ons ÉCHTE paneel (in-situ), zodat de foto altijd het patroon matcht.
  async function loadImages() {
    imagePool = []; mockupPool = []; sfeerPool = []; guessPool = [];
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
    // RAAD-BEELDEN (stopzodra), per LEVEL-map: makkelijk / gemiddeld / moeilijk / expert.
    // Ingelezen als klein RGB-raster zodat we hun kleur op de TEGELS kunnen projecteren
    // (het beeld zit in de gekleurde tegels). Elk beeld onthoudt z'n level.
    for (const lvl of ["makkelijk", "gemiddeld", "moeilijk", "expert"]) {
      let qfiles = [];
      try { qfiles = (await fs.readdir(path.join(GUESS_DIR, lvl))).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort(); } catch {}
      for (const f of qfiles) {
        const abs = path.join(GUESS_DIR, lvl, f);
        let grid = null, uri = "";
        try { grid = await imageGridRGB(abs, 96, 132); } catch {}
        try { uri = await loadImageFile(abs); } catch {}   // ook als afbeelding (voor onthul)
        if (grid) guessPool.push({ id: lvl + "/" + f, grid, uri, gw: 96, gh: 132, level: lvl });
      }
    }
  }
  const imgById = (id) => imagePool.find((x) => x.id === id);

  async function init(log) {
    await loadState();   // persistente anti-herhaling laden
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
    if (log) log(`foto-pool taleoftiles: ${imagePool.length} beeld(en), ${mockupPool.length} mockup(s), ${sfeerPool.length} sfeerbeeld(en), ${guessPool.length} raad-beeld(en)`);
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
  // VERHAAL = Tale of Tiles overbrengen: WIE we zijn (handgemaakte zellige, eeuwenoud
  // ambacht uit Fès), WAT we maken (jouw naam in echt glazuur), en de PAYOFF voor de
  // kijker (een schilderij op z'n muur / gevel / bureau). Premium, geen cliché, geen
  // "blijf kijken". De kijker moet na het filmpje weten wat Tale of Tiles is en doet.
  // VERHAAL-PIJLERS, verspreid over de types (zodat niet elke video hetzelfde zegt):
  //   insitu     -> TOEPASSING + KWALITEIT (op je muur/gevel, weerbestendig, kleur die blijft)
  //   sfeer      -> ERFGOED + AMBACHT (wie we zijn, hoe het gemaakt wordt, eeuwenoud -> nu)
  //   satisfying -> OPNIEUW TOT LEVEN (oud ambacht in een nieuw jasje; je ziet het ontstaan)
  //   geentwee   -> AMBACHT/UNIEK + keuze (met de hand, nooit twee gelijk, jouw naam)
  // Elk type heeft 3-4 WISSELENDE sets; samen vertellen ze het hele verhaal. Geen "zellige".
  const STORIES = {
    insitu: {   // TOEPASSING + KWALITEIT. GEEN gevel/buiten-only-claims (mockup kan ook binnen zijn).
      nl: [
        [{ k: "Tale of Tiles", t: "Jouw naam, met de hand gemaakt." }, { t: "In echt glazuur — kleur die blijft." }, { t: "Een schilderij aan je muur." }],
        [{ k: "Echt glazuur", t: "Verbleekt niet, jaren diep van kleur." }, { t: "Binnen én buiten, aan je muur." }, { t: "Met de hand gezet, tegel voor tegel." }],
        [{ k: "Fès", t: "Wat eeuwen aan paleismuren hing…" }, { t: "…nu als kunst aan die van jou." }, { t: "Geen twee gelijk." }],
        [{ t: "Eén naam. Eén kunstwerk." }, { k: "Tale of Tiles", t: "Handgemaakt, voor jouw muur of gevel." }],
      ],
      en: [
        [{ k: "Tale of Tiles", t: "Your name, made by hand." }, { t: "In real glaze — colour that stays." }, { t: "A painting for your wall." }],
        [{ k: "Real glaze", t: "Won't fade, deep colour for years." }, { t: "Indoors or out, on your wall." }, { t: "Set by hand, tile by tile." }],
        [{ k: "Fès", t: "What once lined palace walls…" }, { t: "…now art on yours." }, { t: "No two alike." }],
      ],
      fr: [
        [{ k: "Tale of Tiles", t: "Votre nom, fait main." }, { t: "En véritable émail — une couleur qui dure." }, { t: "Un tableau pour votre mur." }],
        [{ k: "Véritable émail", t: "Ne pâlit pas, des années de couleur." }, { t: "Posé à la main, carreau par carreau." }],
      ],
    },
    sfeer: {   // ERFGOED + AMBACHT: eeuwenoud ambacht uit Fès -> vandaag, met jouw naam.
      nl: [
        [{ k: "Fès", t: "Een ambacht van duizend jaar." }, { t: "Elke tegel met de hand gesneden en geglazuurd." }, { t: "Geen twee stukjes gelijk." }],
        [{ t: "Klei, water, vuur — en geduld." }, { k: "Tale of Tiles", t: "Zo maken wij jouw naambord." }, { t: "Een schilderij om door te geven." }],
        [{ t: "Eeuwenoud ambacht uit de paleizen van Fès." }, { k: "Vandaag", t: "In een nieuw jasje." }, { t: "Met jouw naam erin." }],
        [{ t: "Het bestaat niet voor niets al eeuwen." }, { k: "Tale of Tiles", t: "Met de hand gemaakt, voor nu." }],
      ],
      en: [
        [{ k: "Fès", t: "A thousand-year craft." }, { t: "Every tile cut and glazed by hand." }, { t: "No two pieces alike." }],
        [{ t: "Clay, water, fire — and patience." }, { k: "Tale of Tiles", t: "This is how we make your nameplate." }, { t: "A painting to pass on." }],
        [{ t: "Age-old craft from the palaces of Fès." }, { k: "Today", t: "In a new form." }, { t: "With your name in it." }],
      ],
      fr: [
        [{ k: "Fès", t: "Un art millénaire." }, { t: "Chaque carreau taillé et émaillé à la main." }, { t: "Aucun identique." }],
        [{ t: "Argile, eau, feu — et patience." }, { k: "Tale of Tiles", t: "Voilà comment naît votre plaque." }],
      ],
    },
    satisfying: {   // OPNIEUW TOT LEVEN: oud ambacht in een nieuw jasje; je ziet het ontstaan.
      nl: [
        [{ t: "Eeuwenoud ambacht…" }, { k: "Tale of Tiles", t: "…opnieuw tot leven gebracht." }, { t: "Jouw naam, tegel voor tegel." }],
        [{ k: "Fès", t: "Van paleismuren…" }, { t: "…naar jouw muur van nu." }, { t: "Met de hand gemaakt." }],
        [{ t: "Tegel voor tegel, met de hand." }, { k: "Tale of Tiles", t: "Een oud ambacht, in een nieuw jasje." }, { t: "Geen twee gelijk." }],
      ],
      en: [
        [{ t: "Age-old craft…" }, { k: "Tale of Tiles", t: "…brought back to life." }, { t: "Your name, tile by tile." }],
        [{ k: "Fès", t: "From palace walls…" }, { t: "…to your wall today." }, { t: "Made by hand." }],
        [{ t: "Tile by tile, by hand." }, { k: "Tale of Tiles", t: "An old craft, in a new form." }, { t: "No two alike." }],
      ],
      fr: [
        [{ t: "Un art ancestral…" }, { k: "Tale of Tiles", t: "…ramené à la vie." }, { t: "Votre nom, carreau par carreau." }],
        [{ k: "Fès", t: "Un art millénaire." }, { t: "Carreau par carreau, à la main." }],
      ],
    },
    geentwee: {   // AMBACHT/UNIEK + keuze: met de hand, nooit twee gelijk — net als jouw naam.
      nl: [
        [{ k: "Tale of Tiles", t: "Eén naam, oneindig veel ontwerpen." }, { t: "Elk met de hand gemaakt — nooit twee gelijk." }, { t: "Welke zou jij kiezen?" }],
        [{ t: "Elk paneel met de hand gezet." }, { k: "Jouw naam", t: "In echt glazuur." }, { t: "Een kunstwerk voor je muur." }],
        [{ t: "Zoveel ontwerpen als je wilt." }, { k: "Tale of Tiles", t: "Geen twee dezelfde — net als jouw naam." }],
      ],
      en: [
        [{ k: "Tale of Tiles", t: "One name, endless designs." }, { t: "Each made by hand — never two alike." }, { t: "Which would you pick?" }],
        [{ t: "Every panel set by hand." }, { k: "Your name", t: "In real glaze." }, { t: "A piece of art for your wall." }],
      ],
      fr: [
        [{ k: "Tale of Tiles", t: "Un nom, une infinité de designs." }, { t: "Fait main — jamais deux pareils." }],
      ],
    },
  };
  function resolveStory(opts, name, templateId) {
    if (opts.hook === false || opts.hook === "none" || opts.hook === null) return [];
    if (typeof opts.hook === "string" && opts.hook.trim()) return [{ t: opts.hook.trim() }];
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    const t = STORIES[templateId] ? templateId : "satisfying";
    const sets = STORIES[t][lang] || STORIES[t].nl;
    let idx = Math.floor(Math.random() * sets.length);
    if (sets.length > 1 && idx === lastStory) idx = (idx + 1) % sets.length;
    lastStory = idx;
    return sets[idx].map((b) => ({ ...b }));
  }
  // PALET-KEUZE bepaalt UIT WELKE glazuur-families de engine kiest — zodat de knop écht iets
  // doet, en consistent over ALLE types: "warm" = warme families, "koel"/"cool" = koele,
  // "auto"/leeg = alle families (mix, met anti-herhaling). Zo is er altijd verschil.
  const WARM_FAMS = ["terracotta", "saffraan", "aubergine"];
  const COOL_FAMS = ["kobalt", "mono_blauw", "oceaan", "smaragd", "mono_groen"];
  function familyPool(opts) {
    const fams = Object.keys(film.GLAZE_FAMILIES);
    const k = (opts && opts.palette) || "";
    if (k === "warm") return fams.filter((f) => WARM_FAMS.includes(f));
    if (k === "cool" || k === "koel") return fams.filter((f) => COOL_FAMS.includes(f));
    return fams;   // auto/modern/leeg = alle families
  }
  function resolvePalette(opts, templateId) {
    const fams = Object.keys(film.GLAZE_FAMILIES);
    if (fams.includes(opts.palette)) return { key: opts.palette, arr: PALS()[opts.palette] };   // expliciete familie wint
    const pool = familyPool(opts);
    const key = pickFresh(pool, "families") || pool[0] || fams[0];
    return { key, arr: PALS()[key] };
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
    { id: "colorway", name: "Colorway A/B/C", music: ["calm", "oriental", "spanish"], defaults: {} },     // poll: zelfde paneel, 3 kleurwegen
    { id: "geentwee", name: "Geen twee gelijk", music: ["upbeat", "lofi", "calm"], defaults: {} },        // outreach/USP: naam vast, patronen flitsen
    { id: "walkthrough", name: "Website walkthrough", music: ["upbeat", "lofi", "calm"], defaults: {} },  // live site/configurator opname -> content-ready (lokaal)
    { id: "stopzodra", name: "Stop zodra je 't ziet (game)", music: ["upbeat", "lofi", "calm"], defaults: {} },  // type 8: zoom-uit raadspel
    { id: "onthul", name: "Onthul (raad-foto achter patroon)", music: ["calm", "lofi", "upbeat"], defaults: {} },  // type 9: patroon dooft uit -> foto erachter
    { id: "cadeau", name: "Cadeau (uitpakken → onthullen)", music: ["calm", "oriental", "spanish"], defaults: {} },  // type 10: verkoop/BOFU — cadeau-reveal
  ];

  // Kies automatisch een track uit de categorieën van een template. Val terug op
  // alles als er (nog) niks in die categorie staat. Nooit twee keer achter elkaar
  // dezelfde (anti-herhaling) zodat je echt variatie hoort.
  async function pickMusic(cats) {
    let files = [];
    try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)); } catch {}
    if (!files.length) return "";
    const want = files.filter((f) => (cats || []).some((c) => f.toLowerCase().startsWith(c + "-")));
    const pool = want.length ? want : files;
    const pick = pickFresh(pool, "music") || pool[0];
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
  function pickName() { return pickFresh(NAMES, "names") || NAMES[0]; }

  // AUTO-PATROON: de engine kiest zelf een patroon (anti-herhaling) zodat Mo niks hoeft te
  // kiezen — alleen Render. Geldt voor ALLE types. pickPatterns(n) voor meerdere (trio).
  function pickPatterns(n = 1) {
    const pool = (patternList || []).filter(Boolean);
    if (!pool.length) return [];
    if (n <= 1) { const p = pickFresh(pool, "patterns"); return p ? [p] : []; }
    return pickFreshN(pool, "patterns", Math.min(n, pool.length));
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
    const name = (opts.name || "").trim() || pickName();   // de naam = waar het naartoe bouwt
    const storyBeats = resolveStory(opts, name, "satisfying");
    // Organische vulrichtingen (geen lineaire sweeps -> geen blokken). Elk patroon een andere.
    const REVEALS = ["spiralout", "radial", "spiral"];
    // Traditioneel glazuur-palet per patroon (kobalt/terracotta/smaragd/...), NIET de regenboog —
    // dát is wat echte zellige-uitstraling geeft i.p.v. snoep. Anti-herhaling door te schudden.
    const famOrder = familyPool(opts).slice().sort(() => Math.random() - 0.5);   // Palet-keuze (warm/koel/auto)
    // ~13s per patroon: rustig genoeg om de opbouw te voelen, maar het bord komt écht vol.
    const nSeg = Math.max(1, Math.round(durSec / 13));
    const pats = pickPatterns(nSeg); while (pats.length && pats.length < nSeg) pats.push(pats[pats.length - 1]);
    const prep = [];
    for (let i = 0; i < pats.length; i++) {
      const pid = pats[i], b = await getBase(pid), lock = LOCKS[pid] || {};
      const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
      const svg = await getPatternSvg(pid, nX, nY);
      const parsed = film.parseTiles(svg, REVEALS[i % REVEALS.length]);
      const palArr = film.GLAZE_FAMILIES[famOrder[i % famOrder.length]] || film.PAL;
      const np = plateColours(palArr);
      const finalCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
      prep.push({ pid, parsed, palArr, np, finalCols, aspect: parsed.view[2] / parsed.view[3] });
    }
    if (!prep.length) throw new Error("satisfying: geen patronen");
    const bandTop = Math.round(H * 0.175), bandBot = Math.round(H * 0.90);
    const rectFor = (aspect) => { let h = bandBot - bandTop, w = Math.round(h * aspect); if (w > W * 0.82) { w = Math.round(W * 0.82); h = Math.round(w / aspect); } return { x: Math.round((W - w) / 2), y: Math.round(H * 0.52 - h / 2), w, h }; };
    const Tseg = durSec / nSeg, Tx = Math.min(0.7, Tseg * 0.06);
    const Tfill = Tseg * 0.70;   // rustig opbouwen is de hoofdmoot, dan een royale payoff-hold
    function fillColors(P, tl) {
      return film.flowColorsAt(P.parsed, { palette: P.palArr, durSec: Tfill, buildSec: Tfill, buildStart: 0, popSec: 0.05 }, tl);
    }
    function drawPanel(P, cols, id, op, z = 1, pan = { x: 0, y: 0 }) {
      const r = rectFor(P.aspect), pw = P.parsed.view[2], ph = P.parsed.view[3];
      // doorlopende camera: zoom + hele trage drift -> het beeld leeft, hypnotiserend
      const vw = pw / z, vh = ph / z, vx = (pw - vw) / 2 + pan.x * pw, vy = (ph - vh) / 2 + pan.y * ph;
      const wrap = `<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" preserveAspectRatio="xMidYMid slice">`;
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
      if (seg > 0 && tl < Tx) { const P0 = prep[seg - 1]; inner += drawPanel(P0, P0.finalCols, "sp" + (seg - 1), 1 - smooth(tl / Tx)); }
      const P = prep[seg];
      const inOp = (seg > 0 && tl < Tx) ? smooth(tl / Tx) : 1;
      // camera: terugtrekken (1.14 -> 1.0) tijdens het vullen, daarna zacht "ademen" op het volle
      // bord + hele trage drift -> nooit stil, chill. Opbouw is de ster, geen payoff vooraf.
      const fillK = Math.min(1, tl / Tfill);
      let z = 1 + 0.14 * (1 - smooth(fillK));
      if (tl > Tfill) z = 1 + 0.025 * (0.5 - 0.5 * Math.cos(((tl - Tfill) / Math.max(0.1, Tseg - Tfill)) * Math.PI * 2));
      const pan = { x: 0.010 * Math.sin(t * 0.5 + seg * 1.7), y: 0.008 * Math.cos(t * 0.38 + seg) };
      inner += drawPanel(P, fillColors(P, tl), "sp" + seg, inOp, z, pan);
      // PAYOFF: zodra het bord vol is trekt een zachte lichtveeg over het glazuur -> het "landt"
      if (tl > Tfill) {
        const r = rectFor(P.aspect), rr = Math.max(6, r.w * 0.03);
        const p = Math.min(1, (tl - Tfill) / Math.max(0.4, (Tseg - Tfill) * 0.6));
        const bw = r.w * 0.5, cxs = r.x - bw + p * (r.w + bw * 1.5), cy = r.y + r.h / 2;
        inner += `<defs><linearGradient id="sfsw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff7ea" stop-opacity="0"/><stop offset="0.5" stop-color="#fff7ea" stop-opacity="0.30"/><stop offset="1" stop-color="#fff7ea" stop-opacity="0"/></linearGradient><clipPath id="sfswc"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rr}"/></clipPath></defs>`
          + `<g clip-path="url(#sfswc)"><rect x="${cxs.toFixed(0)}" y="${(r.y - r.h * 0.2).toFixed(0)}" width="${bw.toFixed(0)}" height="${(r.h * 1.4).toFixed(0)}" fill="url(#sfsw)" transform="rotate(14 ${(cxs + bw / 2).toFixed(0)} ${cy.toFixed(0)})"/></g>`;
      }
      let overlay = "";
      // CLIMAX: de naam graveert op het volle bord (dat is "waar het naartoe bouwt").
      if (name) {
        const r = rectFor(P.aspect);
        const nameUp = Math.max(0, Math.min(1, (tl - Tfill * 0.96) / Math.max(0.4, Tseg * 0.12)));
        const nameDown = tl > Tseg - Tx && seg < nSeg - 1 ? 1 - smooth((tl - (Tseg - Tx)) / Tx) : 1;
        const op = nameUp * nameDown;
        if (op > 0.01) {
          const cyN = r.y + r.h / 2 + (1 - smooth(op)) * 10;
          overlay += `<g opacity="${op.toFixed(3)}">${platePlace(name, P.np, r.x + r.w / 2, cyN, Math.round(r.h * 0.17), r.w * 0.9)}</g>`;
        }
      }
      if (storyBeats.length) {
        const tA = 0.5, tB = Math.min(durSec * 0.5, Tfill * 0.9), n = storyBeats.length, slot = (tB - tA) / n, fade = Math.min(0.6, slot * 0.3);
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

  // COLORWAY A/B/C (poll/engagement): bouwt één paneel tegel-voor-tegel in kleurweg A,
  // morpht dan op de beat naar B en C. Bijschrift: "Welke past bij jou? A/B/C."
  async function makeColorwayRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const name = (opts.name || "").trim() || pickName();
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    const pid = pickPatterns(1)[0];
    const b = await getBase(pid), lock = LOCKS[pid] || {};
    const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
    const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "radial");
    // 3 contrasterende families (uit 3 verschillende kleurgroepen) -> duidelijk andere kleurwegen
    const _cpool = familyPool(opts);
    const _cauto = !(["warm", "cool", "koel"].includes(opts.palette || ""));
    let fams;
    if (_cauto) { const cwGroups = [["kobalt", "mono_blauw", "oceaan"], ["smaragd", "mono_groen"], ["terracotta", "saffraan"], ["aubergine"]]; const cwPick = (a) => a[Math.floor(Math.random() * a.length)]; fams = cwGroups.slice().sort(() => Math.random() - 0.5).slice(0, 3).map(cwPick); }
    else { const sh = _cpool.slice().sort(() => Math.random() - 0.5); fams = [sh[0], sh[1 % sh.length], sh[2 % sh.length]]; }
    const pals3 = fams.map((f) => film.GLAZE_FAMILIES[f]);
    const finals = pals3.map((p) => film.flowColorsAt(parsed, { palette: p, durSec: 1, buildSec: 1, buildStart: 0 }, 1000));
    const nps = pals3.map((p) => plateColours(p));
    const pw = parsed.view[2], ph = parsed.view[3], A = pw / ph;
    let h = Math.round(H * 0.70), w = Math.round(h * A); if (w > W * 0.80) { w = Math.round(W * 0.80); h = Math.round(w / A); }
    const px = Math.round((W - w) / 2), py = Math.round(H * 0.52 - h / 2);
    const rr = Math.max(8, w * 0.03);
    const poll = { nl: "Welke past bij jou? A · B · C", en: "Which fits you? A · B · C", fr: "Lequel pour vous ? A · B · C" }[lang];
    const Tb = durSec * 0.34, Tc = durSec * 0.72;   // bouw A -> beat-snap A/B/C -> vergelijk A|B|C
    const hold = 1.3;                                // snap-interval (op de beat)
    const drawCW = (cols, r, id) => {
      const wrp = `<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      const m = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrp) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrp);
      const rc = Math.max(6, r.w * 0.03);
      return `<clipPath id="${id}"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rc}"/></clipPath><g clip-path="url(#${id})">${m}${glazeSvg(r.x, r.y, r.w, r.h, id)}</g><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rc}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
    };
    const badge = (letter, cx, cy, rad, op) => `<g opacity="${op.toFixed(3)}"><circle cx="${cx}" cy="${cy}" r="${rad}" fill="#1a1327" opacity="0.74"/><circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/><text x="${cx}" y="${(cy + rad * 0.36).toFixed(0)}" text-anchor="middle" font-family="${SERIF}" font-weight="600" font-size="${(rad * 1.15).toFixed(0)}" fill="#f6efe0">${letter}</text></g>`;
    function sceneAt(frame) {
      const t = frame / FPS;
      let inner = "", overlay = "";
      if (t < Tc) {
        let idx, cols;
        if (t < Tb) { idx = 0; cols = film.flowColorsAt(parsed, { palette: pals3[0], durSec: Tb * 0.78, buildSec: Tb * 0.78, buildStart: 0, popSec: 0.05 }, t); }
        else { idx = Math.floor((t - Tb) / hold) % 3; cols = finals[idx]; }   // SNAP op de beat
        inner += drawCW(cols, { x: px, y: py, w, h }, "cwbig");
        const rad = Math.round(w * 0.085), bx = px + w - rad * 1.15, by = py + rad * 1.15;
        const bOp = t < Tb ? Math.max(0, Math.min(1, (t - Tb * 0.78) / 0.4)) : 1;
        overlay += badge(["A", "B", "C"][idx], bx, by, rad, bOp);
        if (name) { const op = t < Tb ? Math.max(0, Math.min(1, (t - Tb * 0.78) / 0.5)) : 1; if (op > 0.01) overlay += `<g opacity="${op.toFixed(3)}">${platePlace(name, nps[idx], px + w / 2, py + h / 2, Math.round(h * 0.16), w * 0.9)}</g>`; }
      } else {
        // VERGELIJK: A | B | C naast elkaar (kies maar)
        const k = Math.min(1, (t - Tc) / 0.5);
        let mh = Math.round(H * 0.42), mw = Math.round(mh * A); if (mw > W * 0.30) { mw = Math.round(W * 0.30); mh = Math.round(mw / A); }
        const cxs = [W * 0.19, W * 0.5, W * 0.81], cy = Math.round(H * 0.5);
        for (let j = 0; j < 3; j++) { const r = { x: Math.round(cxs[j] - mw / 2), y: Math.round(cy - mh / 2), w: mw, h: mh }; inner += `<g opacity="${k.toFixed(3)}">${drawCW(finals[j], r, "cwm" + j)}</g>`; const rad = Math.round(mw * 0.17); overlay += badge(["A", "B", "C"][j], r.x + r.w - rad * 1.05, r.y + rad * 1.05, rad, k); }
      }
      const pollOp = t > Tb ? Math.min(1, (t - Tb) / 0.5) : 0;
      if (pollOp > 0.01) overlay += captionOverlay(poll, "Zeg het in de comments", W, H, pollOp, "lower");
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // MACRO-GLANS LOOP (premium/Pinterest): close-up van het glanzende glazuur dat licht vangt;
  // trage drift + lichtveeg, naadloze loop. Mute-proof, evergreen. Geen naam.
  async function makeMacroRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    const pid = pickPatterns(1)[0];
    const b = await getBase(pid), lock = LOCKS[pid] || {};
    const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
    const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "radial");
    const palArr = (film.VIVID || film.PAL).slice().sort(() => Math.random() - 0.5);
    const cols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
    const pw = parsed.view[2], ph = parsed.view[3];
    const line = { nl: "Echt glazuur. Met de hand gezet.", en: "Real glaze. Set by hand.", fr: "Véritable émail. Posé à la main." }[lang];
    function sceneAt(frame) {
      const t = frame / FPS, ph2 = t / durSec * 2 * Math.PI;   // volle periode = durSec -> loopt naadloos
      const zoom = 2.3;                                        // macro inzoom
      const vw = pw / zoom, vh = ph / zoom;
      const cx = 0.5 + 0.17 * Math.sin(ph2), cy = 0.5 + 0.12 * Math.cos(ph2);   // trage cirkel-drift
      const vx = Math.max(0, Math.min(pw - vw, pw * cx - vw / 2)), vy = Math.max(0, Math.min(ph - vh, ph * cy - vh / 2));
      const wrap = `<svg x="0" y="0" width="${W}" height="${H}" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrap);
      // lichtveeg: bright diagonale band die herhaalt (2 keer per loop) -> glazuur vangt licht
      const sp = (t / durSec * 2) % 1, bw = W * 0.5, cxs = -bw + sp * (W + bw * 2);
      const sweep = `<defs><linearGradient id="msw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff7ea" stop-opacity="0"/><stop offset="0.5" stop-color="#fff7ea" stop-opacity="0.26"/><stop offset="1" stop-color="#fff7ea" stop-opacity="0"/></linearGradient></defs>`
        + `<rect x="${cxs.toFixed(0)}" y="${(-H * 0.2).toFixed(0)}" width="${bw.toFixed(0)}" height="${(H * 1.4).toFixed(0)}" fill="url(#msw)" transform="rotate(16 ${(cxs + bw / 2).toFixed(0)} ${(H / 2).toFixed(0)})"/>`;
      const inner = mos + sweep;
      let overlay = "";
      // subtiele vignette voor diepte
      overlay += `<defs><radialGradient id="mvig" cx="50%" cy="48%" r="72%"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#0a0712" stop-opacity="0.5"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#mvig)"/>`;
      // één rustige regel in het begin, dan vrij beeld
      if (t < 3.2) { const op = t < 2.2 ? Math.min(1, t / 0.5) : 1 - smooth((t - 2.2) / 1.0); if (op > 0.01) overlay += captionOverlay(line, null, W, H, op, "lower"); }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // GEEN TWEE GELIJK (outreach/USP): ÉÉN (bedrijfs)naam blijft vast op de plaat, terwijl de
  // patronen + kleuren er razendsnel achter langs flitsen. "1 naam, oneindig uniek."
  async function makeGeenRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const name = (opts.name || "").trim() || pickName();   // dynamisch: outreach vult bedrijfsnaam
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    const storyBeats = resolveStory(opts, name, "geentwee");   // ToT-verhaal loopt mee
    const fams = familyPool(opts);   // Palet-keuze (warm/koel/auto)
    const N = Math.min((patternList || []).length || 1, 16);
    const pats = pickPatterns(N);
    const prep = [];
    for (let i = 0; i < pats.length; i++) {
      const pid = pats[i], b = await getBase(pid), lock = LOCKS[pid] || {};
      const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
      const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "radial");
      // elk ontwerp een ander traditioneel glazuur-familie (authentiek zellige, geen regenboog)
      const palArr = film.GLAZE_FAMILIES[fams[i % fams.length]] || film.PAL;
      const finalCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
      // naamplaat kleurt MEE met dít ontwerp (per paneel een eigen plaat) i.p.v. één vaste kleur
      prep.push({ parsed, finalCols, aspect: parsed.view[2] / parsed.view[3], np: name ? plateColours(palArr) : null });
    }
    const bandTop = Math.round(H * 0.175), bandBot = Math.round(H * 0.90);
    const rectFor = (aspect) => { let h = bandBot - bandTop, w = Math.round(h * aspect); if (w > W * 0.82) { w = Math.round(W * 0.82); h = Math.round(w / aspect); } return { x: Math.round((W - w) / 2), y: Math.round(H * 0.52 - h / 2), w, h }; };
    function sceneAt(frame) {
      const t = frame / FPS;
      // RUSTIGER tempo (was te snel): elk ontwerp ~0.9s -> licht versnellend naar ~0.55s.
      const flash = Math.max(0.55, 0.9 - t * 0.008);
      // tel hoeveel flitsen al voorbij zijn (met versnelling) voor een stabiele index
      let acc = 0, k = 0, idx = 0; while (acc < t && k < 10000) { acc += Math.max(0.55, 0.9 - acc * 0.008); if (acc <= t) idx++; k++; }
      const P = prep[idx % prep.length];
      const r = rectFor(P.aspect);
      const wrap = `<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" viewBox="0 0 ${P.parsed.view[2]} ${P.parsed.view[3]}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(P.parsed, P.finalCols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(P.parsed, P.finalCols).replace(/<svg\b[^>]*>/i, wrap);
      const rr = Math.max(6, r.w * 0.03);
      let inner = `<clipPath id="gtc"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rr}"/></clipPath><g clip-path="url(#gtc)">${mos}${glazeSvg(r.x, r.y, r.w, r.h, "gtc")}</g><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${rr}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      let overlay = "";
      if (name && P.np) { overlay += platePlace(name, P.np, r.x + r.w / 2, r.y + r.h / 2, Math.round(r.h * 0.16), r.w * 0.9); }
      // ToT-verhaal loopt mee als onderregel (één beat per keer, cross-fade) -> gewicht/kwaliteit
      if (storyBeats.length) {
        const tA = 0.5, tB = durSec - 0.4, n = storyBeats.length, slot = (tB - tA) / n, fade = Math.min(0.6, slot * 0.28);
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
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    // 3 verschillende patronen
    let pats = pickPatterns(3);
    while (pats.length && pats.length < 3) pats.push(pats[pats.length - 1]);
    // 3 ECHT CONTRASTERENDE glazuur-families: kies uit 3 verschillende kleur-groepen
    // (blauw / groen / teal / warm / paars) zodat de drie borden duidelijk verschillen
    // i.p.v. 2x blauw. Dat is het punt van trio: drie duidelijk andere sferen.
    const _tpool = familyPool(opts);
    const _tauto = !(["warm", "cool", "koel"].includes(opts.palette || ""));
    let fams3;
    if (_tauto) { const famGroups = [["kobalt", "mono_blauw", "oceaan"], ["smaragd", "mono_groen"], ["terracotta", "saffraan"], ["aubergine"]]; const pickOne = (a) => a[Math.floor(Math.random() * a.length)]; fams3 = famGroups.slice().sort(() => Math.random() - 0.5).slice(0, 3).map(pickOne); }
    else { const sh = _tpool.slice().sort(() => Math.random() - 0.5); fams3 = [sh[0], sh[1 % sh.length], sh[2 % sh.length]]; }
    const prep = [];
    for (let i = 0; i < pats.length; i++) {
      const pid = pats[i];
      const base = await getBase(pid); const lock = LOCKS[pid] || {};
      const { nX, nY } = tileCounts(base, lock, PANEL_ASPECT);
      const svg = await getPatternSvg(pid, nX, nY);
      const parsed = film.parseTiles(svg, "radial");
      const palArr = film.GLAZE_FAMILIES[fams3[i]] || film.PAL;   // contrasterende familie per bord
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
      if (name && P.np) { nm = platePlace(name, P.np, cx, cy, Math.round(wH * 0.18), wW * 0.9); }
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
      // OPENING: onderregel (niet "top" -> botste op het logo). Zet de opzet neer.
      const openTxt = { nl: "Eén naam, drie stijlen", en: "One name, three styles", fr: "Un nom, trois styles" }[lang];
      const openKick = name || "Tale of Tiles";
      if (a === 0 && f < 0.20) { const op = (f < 0.12 ? Math.min(1, f / 0.05) : 1 - smooth((f - 0.12) / 0.08)); if (op > 0.01) overlay += captionOverlay(openTxt, openKick, W, H, op, "lower"); }
      // SLOT: CTA op het laatste bord -> engagement + "maak 'm zelf (mooier)"
      const ctaMain = { nl: "Welke vind jij het mooiste?", en: "Which one's your favourite?", fr: "Lequel préférez-vous ?" }[lang];
      const ctaKick = { nl: "Of ontwerp 'm zelf mooier", en: "Or design yours", fr: "Ou créez le vôtre" }[lang];
      if (a === 2 && f > 0.42) { const op = (f < 0.52 ? smooth((f - 0.42) / 0.10) : (f > 0.86 ? 1 - smooth((f - 0.86) / 0.1) : 1)); if (op > 0.01) overlay += captionOverlay(ctaMain, ctaKick, W, H, op, "lower"); }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // bouw een render-plan voor de kern: { W,H,FPS,SS,durSec, sceneAt(frame) }
  // WEBSITE-WALKTHROUGH: neemt de LIVE site op (recorder) en maakt 'm content-ready (finish:
  // hook, snelheid op de markers, caption, logo, muziek). Draait lokaal — heeft de browser en
  // de live site nodig. Levert een KANT-EN-KLARE mp4 terug via { prebuilt }, zodat de engine
  // 'm direct gebruikt en de SVG-frame-pijplijn overslaat.
  // Draai een sub-proces en stuur elke uitvoer-regel LIVE door naar log() — zo verschijnt de
  // walkthrough-voortgang in het app-paneel (SSE) én in de terminal, net als de andere types.
  // (Vroeger: stdio:"inherit" -> alleen terminal, paneel bleef leeg.)
  function runStreamed(node, args, env, log, tag) {
    return new Promise((resolve) => {
      const ch = spawn(node, args, { env });
      let buf = "";
      const flush = (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          if (log) log((tag ? tag + " " : "") + line); else process.stdout.write(line + "\n");
        }
      };
      ch.stdout.on("data", flush); ch.stderr.on("data", flush);
      ch.on("close", (code) => { if (buf.trim()) { if (log) log((tag ? tag + " " : "") + buf.trim()); else process.stdout.write(buf); } resolve({ status: code }); });
      ch.on("error", (e) => { if (log) log((tag ? tag + " " : "") + "fout: " + e.message); resolve({ status: 1 }); });
    });
  }

  async function makeWalkthroughRender({ opts = {}, log }) {
    const node = process.execPath;
    const recorder = path.resolve(ROOT, "tools/site-capture.mjs");
    const finisher = path.resolve(ROOT, "tools/finish.mjs");
    const ffmpeg = FFMPEG || "ffmpeg";
    const work = path.resolve(ROOT, config.outDir, ".walk-" + Date.now());
    await fs.mkdir(work, { recursive: true });
    const lang = (opts.lang === "en") ? "en" : "nl"; branding.lang = lang;
    const mode = (opts.mode === "simpel" || opts.mode === "detail") ? opts.mode : (Math.random() < 0.5 ? "simpel" : "detail");
    const name = (opts.name || "").trim();

    // 1) opnemen -> ruwe mp4 + markers
    const recEnv = { ...process.env, TOT_OUT: work, TOT_LANG: lang, TOT_MODE: mode, FFMPEG: ffmpeg };
    if (name) recEnv.TOT_NAME = name;
    if (log) log("● walkthrough — opname van de live site start…");
    const r1 = await runStreamed(node, [recorder], recEnv, log, "· opname:");
    if (r1.status !== 0) throw new Error("opname (site-capture) faalde — draait de engine op de machine met de browser en is de site bereikbaar?");
    const raw = path.join(work, "site-walkthrough.mp4");

    // 2) muziek + captions kiezen, dan content-ready maken
    const music = await pickMusic(["upbeat", "lofi", "calm"]);
    const caps = ({
      nl: ["Gelukkig heeft iedereen zijn eigen smaak.", "Ontwerp die van jou · Tale of Tiles"],
      en: ["Luckily, everyone has their own taste.", "Design yours · Tale of Tiles"],
    })[lang];
    // GUIDE-STAPPEN: neem de kijker mee door de configurator i.p.v. kaal de site tonen.
    const steps = ({
      nl: ["Kies je patroon", "Kleur 'm in — kleurgroepen of per tegel", "Zet je naam erop", "Zie 't op je muur"],
      en: ["Pick your pattern", "Colour it — by group or tile", "Add your name", "See it on your wall"],
    })[lang];
    const finEnv = { ...process.env, FFMPEG: ffmpeg, TOT_CAPTION: caps[0], TOT_CAPTION2: caps[1], TOT_STEPS: JSON.stringify(steps), TOT_FINAL: path.join(work, "site-final.mp4") };
    if (music) finEnv.TOT_MUSIC = music;
    if (log) log("● walkthrough — content-ready (hook, snelheid, caption, muziek)…");
    const r2 = await runStreamed(node, [finisher, raw], finEnv, log, "· montage:");
    if (r2.status !== 0) throw new Error("content-ready stap (finish) faalde");

    return { prebuilt: path.join(work, "site-final.mp4"), music: "" };
  }

  // TYPE 8 — "Stop zodra je 't ziet" (guess/engagement): de camera start extreem ingezoomd op
  // het afgemaakte naambord; je ziet alleen losse tegels en kunt niet zien wat het is. Hij
  // zoomt héél langzaam uit -> je raadt het, en de volledige plaat + naam lost op als antwoord.
  // Zoom is de hele truc (wat Mo wil: zoom goed gebruiken). Traditioneel palet.
  async function makeGuessRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const durSec = (opts.durationSec == null && opts.duration == null) ? 11 : resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["upbeat", "lofi", "calm"]);
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    // FIJN, UNIFORM zellige-mozaïek (kleine vierkante tegeltjes — klassiek zellige). Zo
    // resolveert het beeld ALTIJD; grote/gestreepte patronen maakten het onleesbaar.
    const GX = 26, GY = 36;   // ~0.72 portret, genoeg resolutie voor een herkenbaar beeld
    const gridSvg = (() => { const cw = 100; let c = ""; for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) c += `<rect x="${i * cw}" y="${j * cw}" width="${cw}" height="${cw}"/>`; return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GX * cw} ${GY * cw}" preserveAspectRatio="none">${c}</svg>`; })();
    const parsed = film.parseTiles(gridSvg, "radial");
    // HET BEELD ZIT IN DE TEGELKLEUREN, IN KLEUR: elke tegel krijgt de dichtstbijzijnde
    // Tale of Tiles-glazuurtint van het bronbeeld. Zo vórmen de gekleurde tegels het beeld
    // (vrolijke merk-kleuren, geen zwart-wit, geen naamplaat).
    const PAL_HEX = Object.values(film.GLAZE_FAMILIES).flat();
    const PAL_RGB = PAL_HEX.map((hh) => { const n = parseInt(hh.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; });
    const nearest = (r, g, b) => { let bi = 0, bd = 1e18; for (let k = 0; k < PAL_RGB.length; k++) { const p = PAL_RGB[k], dr = r - p[0], dg = g - p[1], db = b - p[2], d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; bi = k; } } return PAL_HEX[bi]; };
    // LEVEL kiezen -> beeld uit díe map (makkelijk/gemiddeld/moeilijk/expert). De render
    // pakt een level en dan een beeld uit dat level; het level wordt ook in beeld getoond.
    const LV = ["makkelijk", "gemiddeld", "moeilijk", "expert"].filter((l) => guessPool.some((g) => g.level === l));
    const level = LV.length ? pickFresh(LV, "guesslevel") : null;
    const lvlPool = level ? guessPool.filter((g) => g.level === level) : guessPool;
    const gimg = lvlPool.length ? pickFreshObj(lvlPool, "guess") : null;
    const toneFor = (nx, ny) => {
      if (!gimg) return PAL_HEX[Math.floor(Math.random() * PAL_HEX.length)];
      const gx = Math.max(0, Math.min(gimg.gw - 1, Math.round(nx * (gimg.gw - 1))));
      const gy = Math.max(0, Math.min(gimg.gh - 1, Math.round(ny * (gimg.gh - 1))));
      const i = (gy * gimg.gw + gx) * 3;
      return nearest(gimg.grid[i], gimg.grid[i + 1], gimg.grid[i + 2]);
    };
    const cols = parsed.tiles.map((tl) => toneFor(tl.nx, tl.ny));
    const pw = parsed.view[2], ph = parsed.view[3], A = pw / ph;
    let h = Math.round(H * 0.72), w = Math.round(h * A); if (w > W * 0.82) { w = Math.round(W * 0.82); h = Math.round(w / A); }
    const px = Math.round((W - w) / 2), py = Math.round(H * 0.52 - h / 2), rr = Math.max(8, w * 0.03);
    const fx = 0.34 + Math.random() * 0.32, fy = 0.30 + Math.random() * 0.30;   // willekeurig startpunt
    const Z0 = 2.6;   // sterke maar veilige inzoom (resvg paniekeert boven ~3.5)
    const line = { nl: "Stop zodra je 't herkent", en: "Pause when you recognise it", fr: "Arrête quand tu reconnais" }[lang];
    // het LEVEL als gouden kicker boven de regel (zo zie je: dit is een makkelijke/moeilijke)
    const LVL_LBL = { makkelijk: { nl: "Makkelijk", en: "Easy", fr: "Facile" }, gemiddeld: { nl: "Gemiddeld", en: "Medium", fr: "Moyen" }, moeilijk: { nl: "Moeilijk", en: "Hard", fr: "Difficile" }, expert: { nl: "Expert", en: "Expert", fr: "Expert" } };
    const kick = level ? (LVL_LBL[level][lang] || LVL_LBL[level].nl) : { nl: "Wat is het?", en: "What is it?", fr: "Qu'est-ce que c'est ?" }[lang];
    const intro = { nl: "Raad wat het is", en: "Guess what it is", fr: "Devinez quoi" }[lang];
    // INTRO: eerst even stilstaan (ingezoomd) + het spel uitleggen, dán pas uitzoomen/onthullen.
    const Tintro = Math.min(2.8, durSec * 0.22);
    function sceneAt(frame) {
      const t = frame / FPS;
      const k = t < Tintro ? 0 : smooth(Math.min(1, (t - Tintro) / ((durSec - Tintro) * 0.82)));   // hold -> uitzoomen
      const z = Z0 + (1 - Z0) * k;
      const cx = fx + (0.5 - fx) * k, cy = fy + (0.5 - fy) * k;
      const vw = pw / z, vh = ph / z;
      let vx = pw * cx - vw / 2, vy = ph * cy - vh / 2;
      vx = Math.max(0, Math.min(pw - vw, vx)); vy = Math.max(0, Math.min(ph - vh, vy));
      const wrap = `<svg x="${px}" y="${py}" width="${w}" height="${h}" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrap);
      let inner = `<clipPath id="gz"><rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${rr}"/></clipPath><g clip-path="url(#gz)">${mos}${glazeSvg(px, py, w, h, "gz")}</g><rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${rr}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      let overlay = "";
      // INTRO-uitleg tijdens de stilstand; daarna de "stop zodra je 't herkent"-regel.
      if (t < Tintro) { const op = t < 0.5 ? Math.min(1, t / 0.5) : (t > Tintro - 0.5 ? 1 - smooth((t - (Tintro - 0.5)) / 0.5) : 1); overlay += captionOverlay(intro, kick, W, H, op, "lower"); }
      else if (k < 0.72) { const op = k > 0.60 ? 1 - smooth((k - 0.60) / 0.12) : Math.min(1, (t - Tintro) / 0.5); overlay += captionOverlay(line, kick, W, H, op, "lower"); }
      // HET ANTWOORD: alleen vanaf 'gemiddeld' (bij 'makkelijk' te voor de hand liggend/kinderachtig),
      // subtiel en premium zodra het beeld vol is onthuld.
      if (gimg && level && level !== "makkelijk" && k > 0.86) {
        const word = gimg.id.split("/").pop().replace(/\.(png|jpe?g|webp)$/i, "").replace(/-/g, " ");
        const ans = { nl: `Het is een ${word}`, en: `It's a ${word}`, fr: `C'est un ${word}` }[lang];
        const op = smooth(Math.min(1, (k - 0.86) / 0.1));
        overlay += captionOverlay(ans, null, W, H, op, "lower");
      }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // ONTHUL (raad-game, andere mechaniek dan stopzodra): een VOL ingekleurd zellige-patroon
  // bedekt een DUIDELIJK, herkenbaar beeld (uit de level-mappen). De tegels doven tegel-voor-
  // tegel uit (worden doorzichtig) en aan het eind valt de tegel-grid helemaal weg, zodat je
  // het beeld scherp ziet. Zelfde levels + antwoord als stopzodra. (Drukke foto's werden ruis.)
  async function makeRevealRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.72, "1:1": 1.0, "16:9": 1.5 }[format] || 0.72;
    const durSec = (opts.durationSec == null && opts.duration == null) ? 14 : resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "lofi", "upbeat"]);
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    // DUIDELIJK beeld uit de level-mappen (met uri). Val terug op een sfeerbeeld als er geen is.
    const LV = ["makkelijk", "gemiddeld", "moeilijk", "expert"].filter((l) => guessPool.some((g) => g.level === l && g.uri));
    const level = LV.length ? pickFresh(LV, "guesslevel") : null;
    const lvlPool = level ? guessPool.filter((g) => g.level === level && g.uri) : [];
    const gimg = lvlPool.length ? pickFreshObj(lvlPool, "guess") : null;
    const photoUri = gimg ? gimg.uri : (sfeerPool[0] ? sfeerPool[0].uri : "");
    const pid = pickPatterns(1)[0];
    const b = await getBase(pid), lock = LOCKS[pid] || {};
    const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
    const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "radial");   // radial: edge-tegels krijgen hoge order
    const palArr = resolvePalette(opts, "satisfying").arr || film.PAL;
    const glaze = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
    const pw = parsed.view[2], ph = parsed.view[3], Ap = pw / ph;
    let h = Math.round(H * 0.72), w = Math.round(h * Ap); if (w > W * 0.82) { w = Math.round(W * 0.82); h = Math.round(w / Ap); }
    const x = Math.round((W - w) / 2), y = Math.round(H * 0.52 - h / 2), rr = Math.max(8, w * 0.03);
    const line = { nl: "Stop zodra je 't herkent", en: "Pause when you recognise it", fr: "Arrête quand tu reconnais" }[lang];
    const LVL_LBL = { makkelijk: { nl: "Makkelijk", en: "Easy", fr: "Facile" }, gemiddeld: { nl: "Gemiddeld", en: "Medium", fr: "Moyen" }, moeilijk: { nl: "Moeilijk", en: "Hard", fr: "Difficile" }, expert: { nl: "Expert", en: "Expert", fr: "Expert" } };
    const kick = level ? (LVL_LBL[level][lang] || LVL_LBL[level].nl) : { nl: "Wat zie jij?", en: "What is it?", fr: "Qu'est-ce ?" }[lang];
    const intro = { nl: "Raad wat er onder zit", en: "Guess what's underneath", fr: "Devinez ce qui se cache" }[lang];
    // INTRO: eerst even stilstaan op het volle patroon + uitleg, dán pas onthullen.
    const Tintro = Math.min(2.8, durSec * 0.22);
    const revWin = (durSec - Tintro) * 0.72;
    const photoImg = photoUri ? `<image href="${photoUri}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#241a3a"/>`;
    function sceneAt(frame) {
      const t = frame / FPS;
      const p = t < Tintro ? 0 : smooth(Math.min(1, (t - Tintro) / revWin));   // hold -> onthullen
      const cols = new Array(parsed.tiles.length);
      // VAN BUITEN NAAR BINNEN: edge-tegels (hoge order) verdwijnen eerst, het midden (waar het
      // object zit) blijft het langst bedekt -> spannend tot het eind.
      for (let i = 0; i < parsed.tiles.length; i++) cols[i] = (parsed.tiles[i].order > 1 - p) ? "none" : glaze[i];
      const wrap = `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      const mosaic = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrap);
      // de tegel-grid valt aan het eind HELEMAAL weg -> je ziet het beeld scherp (geen ruis)
      const gridOp = p < 0.80 ? 1 : 1 - smooth((p - 0.80) / 0.20);
      let inner = `<clipPath id="rv"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}"/></clipPath>`
        + `<g clip-path="url(#rv)">${photoImg}<g opacity="${gridOp.toFixed(3)}">${mosaic}</g></g>`
        + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      let overlay = "";
      if (t < Tintro) { const op = t < 0.5 ? Math.min(1, t / 0.5) : (t > Tintro - 0.5 ? 1 - smooth((t - (Tintro - 0.5)) / 0.5) : 1); overlay += captionOverlay(intro, kick, W, H, op, "lower"); }
      else if (p < 0.72) { const op = p > 0.60 ? 1 - smooth((p - 0.60) / 0.12) : Math.min(1, (t - Tintro) / 0.5); overlay += captionOverlay(line, kick, W, H, op, "lower"); }
      // ANTWOORD vanaf 'gemiddeld' (niet bij makkelijk), zodra het beeld vol onthuld is
      if (gimg && level && level !== "makkelijk" && p > 0.86) {
        const word = gimg.id.split("/").pop().replace(/\.(png|jpe?g|webp)$/i, "").replace(/-/g, " ");
        const ans = { nl: `Het is een ${word}`, en: `It's a ${word}`, fr: `C'est un ${word}` }[lang];
        overlay += captionOverlay(ans, null, W, H, smooth(Math.min(1, (p - 0.86) / 0.1)), "lower");
      }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // SFEER (herbouwd): wisselt ons ÉIGEN patroon (liggend, rechthoekig — net als de
  // configurator, GEEN boog/pilaren) af met een ÉCHT sfeerbeeld (ambacht/atelier/ruimte/
  // architectuur). Rustig tempo (sfeer = ook een beetje satisfying): foto -> patroon kleurt
  // in -> foto -> vol patroon met de naam. Captions vertellen het Tale of Tiles-verhaal.
  async function makeSfeerRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 1.5, "1:1": 1.2, "16:9": 1.9 }[format] || 1.5;   // liggend
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const name = (opts.name || "").trim() || pickName();
    const storyBeats = resolveStory(opts, name, "sfeer");
    // CURATIE: beelden die duidelijk ambacht/setting tonen (handen, atelier, ruimte,
    // architectuur) i.p.v. abstracte mozaïek-closeups die op ons eigen paneel lijken.
    // #24 (Arabisch schrift) en #42 (glitch) eruit. Val terug op alles als er te weinig matcht.
    const GOOD = new Set(["sfeer-07", "sfeer-13", "sfeer-15", "sfeer-16", "sfeer-19", "sfeer-20", "sfeer-21", "sfeer-26", "sfeer-28", "sfeer-30", "sfeer-31", "sfeer-33", "sfeer-34", "sfeer-36", "sfeer-37", "sfeer-38", "sfeer-39", "sfeer-40", "sfeer-41"]);
    const goodPool = sfeerPool.filter((s) => GOOD.has(s.id.replace(/\.(jpe?g|png|webp)$/i, "")));
    const sPool = goodPool.length >= 2 ? goodPool : sfeerPool;
    const photoA = pickFreshObj(sPool, "sfeer") || sPool[0] || null;
    const photoB = pickFreshObj(sPool.filter((s) => !photoA || s.id !== photoA.id), "sfeer") || photoA;
    const pid = pickPatterns(1)[0];
    const b = await getBase(pid), lock = LOCKS[pid] || {};
    const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
    const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "radial");
    const palArr = resolvePalette(opts, "sfeer").arr || film.PAL;
    const np = plateColours(palArr);
    const pw = parsed.view[2], ph = parsed.view[3], A = pw / ph;
    let w = Math.round(W * 0.86), h = Math.round(w / A);
    if (h > H * 0.60) { h = Math.round(H * 0.60); w = Math.round(h * A); }
    const x = Math.round((W - w) / 2), y = Math.round(H * 0.52 - h / 2), rr = Math.max(8, w * 0.03);
    const rectClip = (id) => `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}"/></clipPath>`;
    const border = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rr}" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
    const photoLayer = (obj, kb) => {
      if (!obj) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#241a3a"/>`;
      const z = 1.06 + 0.12 * kb, iw = w * z, ih = h * z, ix = x - (iw - w) / 2 - (w * 0.03) * (kb - 0.5), iy = y - (ih - h) / 2;
      return `<image href="${obj.uri}" x="${ix.toFixed(1)}" y="${iy.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="xMidYMid slice"/>`;
    };
    const patternLayer = (cols) => {
      const wrap = `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      return film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrap) + glazeSvg(x, y, w, h, "sf");
    };
    const DX = Math.min(0.6, durSec * 0.03);
    const T0 = durSec * 0.24, T1 = durSec * 0.56, T2 = durSec * 0.78;   // foto A | patroon kleurt | foto B | vol + naam
    const fullCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
    const layerAt = (t) => {
      if (t < T0) return { svg: photoLayer(photoA, smooth(t / T0)), nm: 0 };
      if (t < T1) { const cols = film.flowColorsAt(parsed, { palette: palArr, durSec: (T1 - T0) * 0.92, buildSec: (T1 - T0) * 0.92, buildStart: 0, popSec: 0.08 }, t - T0); return { svg: patternLayer(cols), nm: 0 }; }
      if (t < T2) return { svg: photoLayer(photoB, smooth((t - T1) / (T2 - T1))), nm: 0 };
      return { svg: patternLayer(fullCols), nm: smooth(Math.min(1, (t - T2 - 0.4) / 1.0)) };
    };
    function sceneAt(frame) {
      const t = frame / FPS;
      const cur = layerAt(t);
      let inner = `${rectClip("sfc")}<g clip-path="url(#sfc)">${cur.svg}`;
      for (const B of [T0, T1, T2]) { if (t > B - DX && t < B) { const nx = layerAt(B + 0.001); const k = smooth((t - (B - DX)) / DX); inner += `<g opacity="${k.toFixed(3)}">${nx.svg}</g>`; } }
      inner += `</g>` + border;
      let overlay = "";
      if (name && cur.nm > 0.01) {
        overlay += `<g opacity="${cur.nm.toFixed(3)}">${platePlace(name, np, x + w / 2, y + h / 2, Math.round(h * 0.17), w * 0.9)}</g>`;
      }
      if (storyBeats.length) {
        const tA = 0.5, tB = durSec - 0.5, n = storyBeats.length, slot = (tB - tA) / n, fade = Math.min(0.6, slot * 0.28);
        for (let i = 0; i < n; i++) { const s0 = tA + i * slot, s1 = s0 + slot; let bo = 0; if (t >= s0 && t < s1) { if (t < s0 + fade) bo = smooth((t - s0) / fade); else if (t > s1 - fade) bo = 1 - smooth((t - (s1 - fade)) / fade); else bo = 1; } if (bo > 0.01) overlay += captionOverlay(storyBeats[i].t, storyBeats[i].k, W, H, bo, "lower"); }
      }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  // CADEAU (verkoop/BOFU): het paneel verschijnt eerst als een INGEPAKT cadeau (lint + strik +
  // label), pakt zichzelf uit en onthult het handgemaakte zellige-bord. Werkt MÉT naam
  // (persoonlijk/bedrijf) én ZONDER naam (als stuk kunst). "Wat geef je…?" -> onthulling -> CTA.
  async function makeCadeauRender({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.74, "1:1": 1.0, "16:9": 1.5 }[format] || 0.74;
    const durSec = resolveDuration(opts);
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
    const autoMusic = await pickMusic(["calm", "oriental", "spanish"]);
    const lang = ["en", "fr"].includes(opts.lang) ? opts.lang : "nl"; branding.lang = lang;
    // MÉT naam of ZONDER (kunst): expliciete naam wint; anders willekeurig naam óf kunst.
    const explicit = (opts.name || "").trim();
    const named = explicit ? explicit : (Math.random() < 0.5 ? pickName() : null);
    const pid = pickPatterns(1)[0];
    const b = await getBase(pid), lock = LOCKS[pid] || {};
    const { nX, nY } = tileCounts(b, lock, PANEL_ASPECT);
    const parsed = film.parseTiles(await getPatternSvg(pid, nX, nY), "spiralout");
    const palArr = resolvePalette(opts, "insitu").arr || film.PAL;
    const np = named ? plateColours(palArr) : null;
    const gold = branding.gold;
    const wrapCol = palArr[0];   // "cadeaupapier" = diepste tint van de familie, goud lint erover
    const fullCols = film.flowColorsAt(parsed, { palette: palArr, durSec: 1, buildSec: 1, buildStart: 0 }, 1000);
    const BLANKS = new Array(parsed.tiles.length).fill(film.BLANK);
    const pw = parsed.view[2], ph = parsed.view[3], A = pw / ph;
    let h = Math.round(H * 0.62), w = Math.round(h * A); if (w > W * 0.80) { w = Math.round(W * 0.80); h = Math.round(w / A); }
    const px = Math.round((W - w) / 2), py = Math.round(H * 0.52 - h / 2), rr = Math.max(8, w * 0.03);
    const cxp = px + w / 2, cyp = py + h / 2, bw = Math.round(w * 0.085);   // dunner, eleganter lint
    // TWEE muur-settings voor het slot (zodat men ziet WAT het is: een bord aan de muur).
    const mk1 = mockupPool.length ? pickFreshObj(mockupPool, "mockups") : null;
    const mk2 = mockupPool.length ? (pickFreshObj(mockupPool.filter((m) => !mk1 || m.id !== mk1.id), "mockups") || mk1) : null;

    // Het paneel (tegels + glans + rand + eventueel naam) getekend in een willekeurige rechthoek.
    function panelInRect(X, Y, RW, RH, cols, nameOn, id) {
      const rr2 = Math.max(6, RW * 0.03);
      const wrapB = `<svg x="${X}" y="${Y}" width="${RW}" height="${RH}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`;
      const mos = film.buildSvg(parsed, cols).replace(/<svg\b[^>]*>/i, wrapB) + film.buildGlaze(parsed, cols).replace(/<svg\b[^>]*>/i, wrapB);
      let s = `<clipPath id="cp${id}"><rect x="${X}" y="${Y}" width="${RW}" height="${RH}" rx="${rr2}"/></clipPath>`
        + `<g clip-path="url(#cp${id})">${mos}${glazeSvg(X, Y, RW, RH, "cg" + id)}</g>`
        + `<rect x="${X}" y="${Y}" width="${RW}" height="${RH}" rx="${rr2}" fill="none" stroke="${gold}" stroke-width="2.5"/>`;
      if (nameOn && named && np) s += `<g>${platePlace(named, np, X + RW / 2, Y + RH / 2, Math.round(RH * 0.17), RW * 0.9)}</g>`;
      return s;
    }
    // Het paneel aan een ECHTE muur (mockup + diepte + lijst) — hergebruikt de in-situ-opmaak.
    function wallScene(mk, cols, id) {
      const A2 = pw / ph, pl = mk && mk.place;
      let wH = Math.round(pl ? pl.h * H : H * 0.34), wW = Math.round(wH * A2);
      const maxW = Math.round(W * 0.78), maxH = Math.round(H * 0.40);
      if (wW > maxW) { wW = maxW; wH = Math.round(wW / A2); }
      if (wH > maxH) { wH = maxH; wW = Math.round(wH * A2); }
      let cx = Math.round(pl ? pl.cx * W : W / 2), cy = Math.round(pl ? pl.cy * H : H * 0.46);
      cx = Math.max(Math.round(wW / 2 + W * 0.04), Math.min(W - Math.round(wW / 2 + W * 0.04), cx));
      cy = Math.max(Math.round(wH / 2 + H * 0.205), Math.min(H - Math.round(wH / 2 + H * 0.12), cy));
      const wx = Math.round(cx - wW / 2), wy = Math.round(cy - wH / 2);
      const roomImg = (mk && mk.blur) ? mk.blur : (mk ? mk.uri : "");
      const room = roomImg ? `<image href="${roomImg}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` : `<rect width="${W}" height="${H}" fill="#241a3a"/>`;
      const sh = `<radialGradient id="csh${id}" cx="50%" cy="48%" r="50%"><stop offset="0.55" stop-color="#120b05" stop-opacity="0.52"/><stop offset="1" stop-color="#120b05" stop-opacity="0"/></radialGradient>`;
      const shadow = `<defs>${sh}</defs><rect x="${wx - 20}" y="${wy - 6}" width="${wW + 40}" height="${wH + 50}" fill="url(#csh${id})"/>`;
      const deco = `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="#16110d"/>`
        + `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="none" stroke="${gold}" stroke-width="2.5"/>`;
      return room + shadow + deco + panelInRect(wx, wy, wW, wH, cols, true, id);
    }
    // PREMIUM inpak: papier met verloop + satijnen glans, een dun satijnen lint met highlight,
    // een nette strik en een zachte slagschaduw. Geen platte vlakken meer.
    const bowSvg = (s, op, sc) => {
      const lobe = _mix(gold, "#fff8e6", 0.0), lobeHi = _mix(gold, "#fff8e6", 0.45), knot = _mix(gold, "#000000", 0.22);
      return `<g opacity="${op.toFixed(3)}" transform="translate(${cxp} ${cyp}) scale(${sc.toFixed(3)}) translate(${-cxp} ${-cyp})">`
        + `<ellipse cx="${cxp - s * 0.60}" cy="${cyp}" rx="${s * 0.60}" ry="${s * 0.42}" fill="${lobe}" transform="rotate(-20 ${cxp - s * 0.60} ${cyp})"/>`
        + `<ellipse cx="${cxp + s * 0.60}" cy="${cyp}" rx="${s * 0.60}" ry="${s * 0.42}" fill="${lobe}" transform="rotate(20 ${cxp + s * 0.60} ${cyp})"/>`
        + `<ellipse cx="${cxp - s * 0.66}" cy="${cyp - s * 0.10}" rx="${s * 0.30}" ry="${s * 0.14}" fill="${lobeHi}" opacity="0.6" transform="rotate(-20 ${cxp - s * 0.66} ${cyp})"/>`
        + `<ellipse cx="${cxp + s * 0.66}" cy="${cyp - s * 0.10}" rx="${s * 0.30}" ry="${s * 0.14}" fill="${lobeHi}" opacity="0.6" transform="rotate(20 ${cxp + s * 0.66} ${cyp})"/>`
        + `<path d="M ${cxp - s * 0.16} ${cyp} L ${cxp - s * 0.92} ${cyp + s * 1.35} L ${cxp - s * 0.40} ${cyp + s * 1.18} Z" fill="${lobe}"/>`
        + `<path d="M ${cxp + s * 0.16} ${cyp} L ${cxp + s * 0.92} ${cyp + s * 1.35} L ${cxp + s * 0.40} ${cyp + s * 1.18} Z" fill="${lobe}"/>`
        + `<rect x="${cxp - s * 0.22}" y="${cyp - s * 0.32}" width="${s * 0.44}" height="${s * 0.64}" rx="${s * 0.12}" fill="${knot}"/></g>`;
    };
    const wrapDefs = `<defs>`
      + `<linearGradient id="cadpaper" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${_mix(wrapCol, "#ffffff", 0.16)}"/><stop offset="1" stop-color="${_mix(wrapCol, "#000000", 0.20)}"/></linearGradient>`
      + `<linearGradient id="cadsheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0.12"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>`
      + `<linearGradient id="cadribH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${_mix(gold, "#000000", 0.28)}"/><stop offset="0.5" stop-color="${_mix(gold, "#fff6df", 0.38)}"/><stop offset="1" stop-color="${_mix(gold, "#000000", 0.28)}"/></linearGradient>`
      + `<linearGradient id="cadribV" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${_mix(gold, "#000000", 0.28)}"/><stop offset="0.5" stop-color="${_mix(gold, "#fff6df", 0.38)}"/><stop offset="1" stop-color="${_mix(gold, "#000000", 0.28)}"/></linearGradient>`
      + `<radialGradient id="cadbsh" cx="50%" cy="52%" r="55%"><stop offset="0.5" stop-color="#0a0712" stop-opacity="0.45"/><stop offset="1" stop-color="#0a0712" stop-opacity="0"/></radialGradient></defs>`;
    function wrapOverlay(wrapK) {
      const s = Math.round(w * 0.14), sc = 0.45 + 0.55 * wrapK;
      const shadow = `<ellipse cx="${cxp}" cy="${py + h + 10}" rx="${w * 0.52}" ry="${h * 0.10}" fill="url(#cadbsh)" opacity="${(wrapK * 0.8).toFixed(3)}"/>`;
      return wrapDefs + shadow
        + `<g clip-path="url(#cpc)" opacity="${wrapK.toFixed(3)}">`
        + `<rect x="${px}" y="${py}" width="${w}" height="${h}" fill="url(#cadpaper)"/>`
        + `<rect x="${px}" y="${py}" width="${w}" height="${h}" fill="url(#cadsheen)"/>`
        + `<rect x="${Math.round(cxp - bw / 2)}" y="${py}" width="${bw}" height="${h}" fill="url(#cadribV)"/>`
        + `<rect x="${px}" y="${Math.round(cyp - bw / 2)}" width="${w}" height="${bw}" fill="url(#cadribH)"/>`
        + `<rect x="${Math.round(cxp - bw / 2)}" y="${py}" width="${Math.max(2, bw * 0.16)}" height="${h}" fill="#fff6df" opacity="0.5"/>`
        + `<rect x="${px}" y="${Math.round(cyp - bw / 2)}" width="${w}" height="${Math.max(2, bw * 0.16)}" fill="#fff6df" opacity="0.5"/>`
        + `</g>`
        + `<rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${rr}" fill="none" stroke="${gold}" stroke-width="2" opacity="${(wrapK * 0.7).toFixed(3)}"/>`
        + bowSvg(s, wrapK, sc);
    }

    const Du = Math.min(1.3, durSec * 0.08);
    const T1 = durSec * 0.24, Tb = durSec * 0.56, Tswap = durSec * 0.80;   // ingepakt | uitpakken+opbouw | muur #1 | muur #2
    const Wd = Math.min(1.0, durSec * 0.08);   // overgang paneel -> muur
    const Sd = Math.min(0.8, durSec * 0.06);   // overgang muur #1 -> muur #2
    const hooks = {
      nl: ["Wat geef je iemand die alles al heeft?", "Op zoek naar een cadeau dat niemand anders geeft?"],
      en: ["What do you give someone who has everything?", "Looking for a gift no one else gives?"],
    };
    const hook = (hooks[lang] || hooks.nl)[Math.floor(Math.random() * 2)];
    const revealLine = named
      ? { nl: "Een handgemaakt naambord — met hun naam, in echt glazuur.", en: "A handmade nameplate — with their name, in real glaze.", fr: "Une plaque faite main — à leur nom, en véritable émail." }[lang]
      : { nl: "Met de hand gemaakt. Een stuk kunst voor aan de muur.", en: "Made by hand. A piece of art for the wall.", fr: "Fait main. Une œuvre pour le mur." }[lang];
    const cta = { nl: "Geef iets dat blijft.", en: "Give something that lasts.", fr: "Offrez ce qui dure." }[lang];

    function sceneAt(frame) {
      const t = frame / FPS;
      const cols = (t < T1) ? BLANKS
        : film.flowColorsAt(parsed, { palette: palArr, durSec: (Tb - T1), buildSec: (Tb - T1) * 0.82, buildStart: 0, popSec: 0.05 }, t - T1);
      // clip voor de inpak-overlay (zelfde rechthoek als het gecentreerde paneel)
      let inner = `<clipPath id="cpc"><rect x="${px}" y="${py}" width="${w}" height="${h}" rx="${rr}"/></clipPath>`;
      // kruisfade gecentreerd paneel -> paneel aan de muur
      const wallK = t < Tb ? 0 : smooth(Math.min(1, (t - Tb) / Wd));
      // 1) GECENTREERD: het uitpakkende cadeau + opbouwend paneel (vervaagt als de muur komt)
      if (wallK < 0.999) {
        const nameOn = t > T1 + Du;
        let center = panelInRect(px, py, w, h, cols, nameOn, "c");
        const wrapK = t < T1 ? 1 : 1 - smooth((t - T1) / Du);
        if (wrapK > 0.003) center += wrapOverlay(wrapK);
        inner += `<g opacity="${(1 - wallK).toFixed(3)}">${center}</g>`;
      }
      // 2) AAN DE MUUR: eerst setting #1, dan #2 (zodat men ziet wat het is)
      if (wallK > 0.001) {
        const swapK = t >= Tswap ? smooth(Math.min(1, (t - Tswap) / Sd)) : 0;
        if (swapK < 0.999) inner += `<g opacity="${(wallK * (1 - swapK)).toFixed(3)}">${wallScene(mk1, fullCols, "1")}</g>`;
        if (swapK > 0.001) inner += `<g opacity="${(wallK * swapK).toFixed(3)}">${wallScene(mk2, fullCols, "2")}</g>`;
      }
      let overlay = "";
      // captions: haak -> onthulregel -> CTA (CTA valt op het muurbeeld)
      if (t < T1 + 0.3) { const op = t < 0.6 ? Math.min(1, t / 0.6) : (t > T1 - 0.5 ? 1 - smooth((t - (T1 - 0.5)) / 0.8) : 1); if (op > 0.01) overlay += captionOverlay(hook, { nl: "Het cadeau", en: "The gift", fr: "Le cadeau" }[lang], W, H, op, "lower"); }
      else if (t < Tb) { const op = t < T1 + Du + 0.3 ? smooth((t - (T1 + Du)) / 0.6) : (t > Tb - 0.6 ? 1 - smooth((t - (Tb - 0.6)) / 0.6) : 1); if (op > 0.01) overlay += captionOverlay(revealLine, null, W, H, op, "lower"); }
      else { const op = t < Tb + Wd + 0.3 ? smooth((t - (Tb + Wd * 0.3)) / 0.6) : 1; if (op > 0.01) overlay += captionOverlay(cta, "Tale of Tiles", W, H, op, "lower"); }
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt, music: autoMusic, clicks: [] };
  }

  async function makeRender({ subjectId, templateId, opts = {}, format = "9:16", log }) {
    if (templateId === "walkthrough") return await makeWalkthroughRender({ opts, format, log });
    if (templateId === "cadeau") return await makeCadeauRender({ opts, format });
    if (templateId === "stopzodra") return await makeGuessRender({ opts, format });
    if (templateId === "onthul") return await makeRevealRender({ opts, format });
    if (templateId === "trio") return await makeTrioRender({ opts, format });
    if (templateId === "satisfying") return await makeSatisfyingRender({ opts, format });
    if (templateId === "colorway") return await makeColorwayRender({ opts, format });
    if (templateId === "geentwee") return await makeGeenRender({ opts, format });
    if (templateId === "sfeer") return await makeSfeerRender({ opts, format });
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    // IN-SITU = een naambord/schilderij -> LIGGEND (landscape) op de muur. Andere types staand.
    const PANEL_ASPECT = (templateId === "insitu")
      ? ({ "9:16": 1.5, "1:1": 1.2, "16:9": 1.9 }[format] || 1.5)
      : ({ "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70);
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
    else if (want === "sfeer") { heroObj = sfeerPool.length ? pickFreshObj(sfeerPool, "sfeer") : (imagePool.length ? rnd(imagePool) : null); }
    else if (want === "insitu") { chosenMockup = mockupPool.length ? pickFreshObj(mockupPool, "mockups") : null; }   // anti-herhaling achtergrond
    else { // auto
      if (mockupPool.length) chosenMockup = pickFreshObj(mockupPool, "mockups");
      else if (sfeerPool.length) heroObj = pickFreshObj(sfeerPool, "sfeer");
      else if (imagePool.length) heroObj = rnd(imagePool);
    }
    // IN-SITU = de muur IS het onderwerp. Wat er ook met opts.image gebeurde (ongeldig id,
    // een sfeer-id dat blijft hangen bij het wisselen van type): dit type krijgt ALTIJD een
    // muur. Eerst een mockup-foto; is die er niet, dan een synthetische plaster-muur.
    // Nooit meer het paneel op de lege achtergrond.
    if (templateId === "insitu" && !chosenMockup) {
      chosenMockup = mockupPool.length ? pickFreshObj(mockupPool, "mockups") : null;
    }
    const hero = heroObj ? heroObj.uri : "";
    const insitu = loop && (templateId === "insitu" || !!chosenMockup);   // in-situ = paneel aan de muur
    const mockup = chosenMockup ? chosenMockup.uri : "";
    // Kleur: bij in-situ stuurt het Palet (neutrale muur); anders kleur-match met de foto.
    const flowPal = insitu ? palArr : (heroObj && heroObj.pal && heroObj.pal.length >= 4 ? heroObj.pal : palArr);
    const bookend = loop && (!!hero || insitu);   // bookend: in-situ of foto
    const bk = 1.5;
    // Mini-thumbnail linksboven verwijderd: botste met het woordmerk en was rommelig/overbodig
    // (het echte paneel staat al groot in beeld). Schoner kader = premium.
    const badge = "";
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
      let wH = Math.round(pl ? pl.h * H : panelH), wW = Math.round(wH * A2);
      // LIGGEND paneel mag de muur niet overspoelen: begrens op een deel van het beeld,
      // zodat de ruimte eromheen zichtbaar blijft (een schilderij hángt aan de muur).
      const maxW = Math.round(W * 0.80), maxH = Math.round(H * 0.40);
      if (wW > maxW) { wW = maxW; wH = Math.round(wW / A2); }
      if (wH > maxH) { wH = maxH; wW = Math.round(wH * A2); }
      let cxp = Math.round(pl ? pl.cx * W : W / 2), cyp = Math.round(pl ? pl.cy * H : panelY + panelH / 2);
      // binnen beeld houden: top onder het logo (H*0.17), onder vrij van de onderrand/meubels.
      cxp = Math.max(Math.round(wW / 2 + W * 0.04), Math.min(W - Math.round(wW / 2 + W * 0.04), cxp));
      cyp = Math.max(Math.round(wH / 2 + H * 0.205), Math.min(H - Math.round(wH / 2 + H * 0.12), cyp));
      const wx = Math.round(cxp - wW / 2), wy = Math.round(cyp - wH / 2);
      // het paneel-rechthoek = de muurplek: alles (opbouw, clip, rand, naam) volgt deze plek
      panelX = wx; panelY = wy; panelW = wW; panelH = wH;
      // VOORAF geblurde muur (scherptediepte, 1x gebakken i.p.v. elk frame) -> veel sneller.
      const roomImg = chosenMockup ? (chosenMockup.blur ? chosenMockup.blur : mockup) : "";
      // Echte muur-mockup als die er is; anders een warme plaster-muur zodat het paneel
      // ALTIJD aan een muur hangt (de template heet niet voor niets "Lege muur").
      const room = roomImg
        ? `<image href="${roomImg}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`
        : `<defs><linearGradient id="plaster" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="#efe7d8"/><stop offset="0.5" stop-color="#e5d9c5"/><stop offset="1" stop-color="#d3c4ab"/></linearGradient>`
          + `<radialGradient id="plasterV" cx="50%" cy="42%" r="78%"><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#3a2d1a" stop-opacity="0.24"/></radialGradient></defs>`
          + `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#plaster)"/>`
          + `<rect x="0" y="${Math.round(H * 0.82)}" width="${W}" height="${Math.round(H * 0.18)}" fill="#c4b392" opacity="0.5"/>`
          + `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#plasterV)"/>`;
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
      if (bookend && insitu) {
        // IN-SITU: de muur is het kader. GEEN foto-intro/outro-zoom. Het paneel bouwt zich
        // op de muur op en BLIJFT daarna hangen — de video eindigt op het opgehangen werk
        // in de ruimte (de payoff die "...tot aan jouw muur" belooft). De lange hold na de
        // opbouw is bewust: je ziet het kunstwerk rustig aan de muur hangen.
        zMos = 1; zPho = 1; bookendK = 0; frameK = 0;
      } else if (bookend) {
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
        const hs = buildStart + Tb + 0.2, he = (bookend && !insitu ? durSec - To : durSec) - 0.3;
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
          const cyN = panelY + panelH / 2 + (1 - Math.min(1, op)) * 10;
          const pl = platePlace(name, np, panelX + panelW / 2, cyN, Math.round(panelH * 0.20), panelW * 0.9);
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
