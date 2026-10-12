// MERK-MODULE: Tale of Tiles. Alle tegel-specifieke dingen (patronen, tegeling,
// voeg, naamplaat) zitten HIER — de kern weet hier niks van.
// Levert: branding, onderwerpen (patronen), templates (video-types), en makeRender().
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { composeChrome, fitRect, loadLogo, FORMATS, escapeXml } from "../core/renderer.mjs";

// ---- naamplaat (port van mPlateColours + mNameLayerSvg uit page.ts) ----
function _hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _mix(a, b, t) { const A = _hexRgb(a), B = _hexRgb(b); const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t); return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1); }
function _lum(h) { const r = _hexRgb(h); return 0.2126 * r[0] + 0.7152 * r[1] + 0.0722 * r[2]; }
// 8-puntige zellige-ster (khatim) als sier bij het woordmerk
function star8(cx, cy, R, r) { const p = []; for (let i = 0; i < 16; i++) { const a = Math.PI / 8 * i - Math.PI / 2, rad = i % 2 ? r : R; p.push((cx + rad * Math.cos(a)).toFixed(1) + "," + (cy + rad * Math.sin(a)).toFixed(1)); } return p.join(" "); }
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
  let fpx = Math.round(vh * 0.30 * (scale || 1));
  const words = (nm || "").split(" "); let lines = [nm];
  if (nm.length > 14 && words.length > 1) { const mid = Math.ceil(words.length / 2); lines = [words.slice(0, mid).join(" "), words.slice(mid).join(" ")]; fpx = Math.round(fpx * 0.82); }
  const FF = "DejaVu Serif,serif", WT = 700, TR = 4, CW = 0.72;
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

// ---- de merk-module zelf ----
export function makeBrand({ ROOT, config }) {
  const branding = {
    name: "Tale of Tiles", footer: "taleoftiles.com",
    bg: "#1a1327", bg2: "#241a3a", gold: "#d6b35a", cream: "#f4ecdc", plate: "#eae4d7",
    // premium woordmerk (altijd herkenbaar bovenin): zellige-ster + serif-caps + goud lijntje
    markSvg: ({ W, H }) => {
      const gold = "#d6b35a", midY = Math.round(H * 0.082), fs = Math.round(W * 0.05), ruleW = fs * 4.3;
      return `<polygon points="${star8(W / 2, midY - fs * 1.02, fs * 0.52, fs * 0.22)}" fill="${gold}"/>`
        + `<text x="${W / 2}" y="${midY + fs * 0.32}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fs}" letter-spacing="${(fs * 0.16).toFixed(1)}" fill="${gold}">TALE OF TILES</text>`
        + `<line x1="${W / 2 - ruleW}" y1="${midY + fs * 0.66}" x2="${W / 2 + ruleW}" y2="${midY + fs * 0.66}" stroke="${gold}" stroke-width="1.3" opacity="0.75"/>`;
    },
  };
  const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
  let film = null, LOCKS = {}, patternList = [];
  const baseCache = new Map(), svgCache = new Map();

  async function init(log) {
    const libOut = path.resolve(ROOT, config.outDir, ".totlib.mjs");
    await esbuild.build({ entryPoints: [path.resolve(ROOT, "remotion/film.ts")], bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: libOut });
    film = await import(pathToFileURL(libOut).href + "?t=" + Date.now());
    try { LOCKS = JSON.parse(await fs.readFile(path.resolve(ROOT, "assets/tile-locks.json"), "utf8")); } catch {}
    try { patternList = JSON.parse(await fs.readFile(path.resolve(ROOT, "fixtures/patterns.json"), "utf8")).patterns; } catch {}
    branding.logoUri = await loadLogo(config.logoUrl);
  }
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
  const PALS = () => ({ modern: film.PAL, warm: film.WARM, cool: film.COOL });
  function storyboardFrom(opts) {
    const pal = PALS()[opts.palette] || film.PAL;
    const tempo = { snel: 1.2, normaal: 1.8, rustig: 2.6 }[opts.tempo] || 1.8;
    const segs = [{ scene: { type: opts.base === "fields" ? "fields" : "confetti", palette: pal }, hold: tempo, trans: 0 }];
    for (const sh of (opts.shapes || [])) segs.push({ scene: { type: "shape", shape: sh, fg: pal }, hold: tempo, trans: 0.9 });
    if (opts.endColorway) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
    if (segs.length === 1) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
    return { buildSec: Number(opts.buildSec) || 3.0, popSec: 0.3, segments: segs };
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

  const templates = [
    { id: "satisfying", name: "Satisfying Build", defaults: { base: "confetti", endColorway: true, shapes: [] } },
    { id: "colorway", name: "Colorway A/B/C", defaults: {} },
    { id: "shapes", name: "Vormen", defaults: { base: "fields", shapes: ["heart", "star"], endColorway: true } },
  ];

  async function listSubjects() {
    return (patternList || []).map((id) => ({ id, thumb: "/api/tot-thumb?p=" + id }));
  }

  // bouw een render-plan voor de kern: { W,H,FPS,SS,durSec, sceneAt(frame) }
  async function makeRender({ subjectId, templateId, opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
    const base = await getBase(subjectId);
    const lock = LOCKS[subjectId] || {};
    const { nX, nY } = tileCounts(base, lock, PANEL_ASPECT);
    const svg = await getPatternSvg(subjectId, nX, nY);
    const parsed = film.parseTiles(svg, opts.reveal || "radial");
    if (!parsed.tiles.length) throw new Error(`patroon ${subjectId} heeft 0 tegels`);
    const story = templateId === "colorway" ? storyboardColorway(opts) : templateId === "satisfying" ? storyboardSatisfying(opts) : storyboardFrom(opts);
    const loop = templateId === "satisfying";   // naadloze loop: eindig neutraal
    const durSec = film.totalDuration(story);
    const A = parsed.view[2] / parsed.view[3];
    const bandTop = Math.round(H * 0.155), bandBot = Math.round(H * 0.905);
    const fit = fitRect(Math.round(W * 0.86), bandBot - bandTop, A);
    const panelW = fit.w, panelH = fit.h;
    const pad = Math.max(6 * SS, Math.round(panelW * 0.018));
    const innerW = panelW - pad * 2, innerH = panelH - pad * 2;
    const panelX = Math.round((W - panelW) / 2), panelY = Math.round(bandTop + (bandBot - bandTop - panelH) / 2);
    const name = (opts.name || "").trim();
    const palArr = PALS()[opts.palette] || film.PAL;
    const np = name ? plateColours(palArr) : null;

    function sceneAt(frame) {
      const t = frame / FPS;
      let colors = film.colorsAt(parsed, story, t);
      let tailK = 0;
      if (loop) { const tail = 1.3, tleft = durSec - t; if (tleft < tail) tailK = Math.min(1, Math.max(0, 1 - tleft / tail)); if (tailK > 0) colors = colors.map((c) => _mix(c, film.BLANK, tailK)); }
      const inner = film.buildSvg(parsed, colors).replace(/<svg\b[^>]*>/i,
        `<svg x="${panelX + pad}" y="${panelY + pad}" width="${innerW}" height="${innerH}" viewBox="0 0 ${parsed.view[2]} ${parsed.view[3]}" preserveAspectRatio="xMidYMid meet">`);
      let overlay = "";
      if (name && np) {
        let op = Math.max(0, Math.min(1, (t - (durSec - 2.2)) / 1.0)) * (1 - tailK);
        if (op > 0.01) {
          const plateW = Math.round(panelW * 0.56), plateH = Math.round(plateW * 200 / 560);
          const plateX = Math.round(panelX + (panelW - plateW) / 2), plateY = Math.round(panelY + (panelH - plateH) / 2 + (1 - op) * 10);
          const pl = nameLayerSvg(name, np, 1).replace(/<svg\b[^>]*>/i, `<svg x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" viewBox="0 0 560 200" preserveAspectRatio="xMidYMid meet">`);
          overlay = `<g opacity="${op.toFixed(3)}">${pl}</g>`;
        }
      }
      return composeChrome({ branding, W, H, panel: { x: panelX, y: panelY, w: panelW, h: panelH }, innerField: inner, overlay, logoUri: branding.logoUri });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // thumbnail: kaal patroon leesbaar (cream op plum) — voor de patroonkiezer
  async function thumbSvg(pattern) {
    let svg = await getBase(pattern);
    return svg.replace(/fill:\s*#[0-9a-fA-F]{3,6}/g, "fill:#e8dcc0").replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#e8dcc0"')
      .replace(/stroke:\s*#[0-9a-fA-F]{3,6}/g, "stroke:#3a2d52").replace(/stroke="#[0-9a-fA-F]{3,6}"/g, 'stroke="#3a2d52"');
  }

  return {
    id: "taleoftiles", name: "Tale of Tiles", branding,
    init, listSubjects, templates, makeRender, thumbSvg,
    options: ["palette", "duration", "reveal", "tempo", "name"],
  };
}
