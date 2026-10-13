// MERK-MODULE: Tale of Tiles. Alle tegel-specifieke dingen (patronen, tegeling,
// voeg, naamplaat) zitten HIER — de kern weet hier niks van.
// Levert: branding, onderwerpen (patronen), templates (video-types), en makeRender().
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { composeChrome, fitRect, loadLogo, loadImageFile, imagePalette, enrichPalette, FORMATS, escapeXml } from "../core/renderer.mjs";

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

// ---- de merk-module zelf ----
export function makeBrand({ ROOT, config }) {
  const branding = {
    name: "Tale of Tiles", footer: "taleoftiles.com",
    bg: "#1a1327", bg2: "#241a3a", gold: "#d6b35a", cream: "#f4ecdc", plate: "#eae4d7",
    // premium woordmerk + korte regel die zegt WAT we doen (altijd bovenin, herkenbaar)
    markSvg: ({ W, H }) => {
      const gold = "#d6b35a", cream = "#f4ecdc", midY = Math.round(H * 0.072), fs = Math.round(W * 0.05), ruleW = fs * 4.3, tag = Math.round(fs * 0.33);
      return `<polygon points="${star8(W / 2, midY - fs * 1.02, fs * 0.52, fs * 0.22)}" fill="${gold}"/>`
        + `<text x="${W / 2}" y="${midY + fs * 0.32}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fs}" letter-spacing="${(fs * 0.16).toFixed(1)}" fill="${gold}">TALE OF TILES</text>`
        + `<line x1="${W / 2 - ruleW}" y1="${midY + fs * 0.62}" x2="${W / 2 + ruleW}" y2="${midY + fs * 0.62}" stroke="${gold}" stroke-width="1.3" opacity="0.75"/>`
        + `<text x="${W / 2}" y="${midY + fs * 1.12}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="${tag}" letter-spacing="${(tag * 0.14).toFixed(1)}" fill="${cream}" opacity="0.82">HANDGEMAAKTE ZELLIGE NAAMBORDEN</text>`;
    },
  };
  const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
  const IMG_DIR = path.resolve(ROOT, "assets/images/taleoftiles");
  const MOCKUP_DIR = path.resolve(IMG_DIR, "mockups");
  let film = null, LOCKS = {}, patternList = [], imagePool = [], mockupPool = [];
  const baseCache = new Map(), svgCache = new Map();

  // Foto-pool: Mo legt zijn (Gemini-)foto's in assets/images/taleoftiles/.
  // Mockup-pool: lege-muur/ruimte-foto's in assets/images/taleoftiles/mockups/ —
  // daarop plakken we ons ÉCHTE paneel (in-situ), zodat de foto altijd het patroon matcht.
  async function loadImages() {
    imagePool = []; mockupPool = [];
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
      const uri = await loadImageFile(path.join(MOCKUP_DIR, f));
      if (!uri) continue;
      // Placement per mockup: optioneel sidecar-bestand "<zelfde-naam>.json" dat zegt
      // wáár op de muur het paneel komt. Vorm: { "cx":0.5, "cy":0.46, "h":0.4 }
      //   cx,cy = midden van het paneel (0..1 van breedte/hoogte van het 9:16-beeld)
      //   h     = hoogte van het paneel als fractie van de beeldhoogte (breedte volgt
      //           automatisch uit de patroon-verhouding). Geen json = terugval op midden.
      let place = null;
      try {
        const j = JSON.parse(await fs.readFile(path.join(MOCKUP_DIR, f.replace(/\.[^.]+$/, ".json")), "utf8"));
        const cx = Number(j.cx), cy = Number(j.cy), hh = Number(j.h);
        if (Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(hh) && hh > 0) place = { cx, cy, h: hh };
      } catch {}
      mockupPool.push({ id: f, uri, place });
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
    await loadImages();
    // badge-fallback: als er nog geen foto's in de map staan, pak het paneel-aan-de-muur van de site
    branding.badgeUri = imagePool[0] ? imagePool[0].uri : await loadLogo(config.productUrl || "https://taleoftiles.com/img/site/panel-on-wall.jpg");
    if (log) log(`foto-pool taleoftiles: ${imagePool.length} beeld(en), ${mockupPool.length} mockup(s)`);
  }
  async function listImages() { return imagePool.map((x) => ({ id: x.id, uri: x.uri })); }
  async function listMockups() { return mockupPool.map((x) => ({ id: x.id, uri: x.uri })); }
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
    { id: "satisfying", name: "Satisfying Build", music: ["calm", "oriental", "spanish"], defaults: { base: "confetti", endColorway: true, shapes: [] } },
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
    const tpl = templates.find((t) => t.id === templateId) || templates[0];
    const autoMusic = await pickMusic(tpl.music || ["calm"]);   // engine kiest zelf de muziek per type
    const isFlow = templateId === "satisfying";
    const loop = isFlow;   // naadloze loop
    // SATISFYING = doorlopend stromend kleurveld met vrij instelbare duur.
    // Andere templates = de storyboard-weg (losse scènes).
    let story = null, durSec, buildSec = 0;
    if (isFlow) { durSec = resolveDuration(opts); buildSec = Math.min(6, Math.max(2.5, durSec * 0.22)); }
    else { story = templateId === "colorway" ? storyboardColorway(opts) : storyboardFrom(opts); durSec = film.totalDuration(story); }
    const A = parsed.view[2] / parsed.view[3];
    const bandTop = Math.round(H * 0.155), bandBot = Math.round(H * 0.905);
    const fit = fitRect(Math.round(W * 0.78), bandBot - bandTop, A);   // smaller -> ruimte voor pilaren
    const panelW = fit.w, panelH = fit.h;
    const pad = Math.max(6 * SS, Math.round(panelW * 0.018));
    const innerW = panelW - pad * 2, innerH = panelH - pad * 2;
    const panelX = Math.round((W - panelW) / 2), panelY = Math.round(bandTop + (bandBot - bandTop - panelH) / 2);
    const name = (opts.name || "").trim();
    const palArr = PALS()[opts.palette] || film.PAL;
    const np = name ? plateColours(palArr) : null;
    // GEKOZEN SFEERBEELD (input-foto). Valt terug op de eerste in de pool, dan op de badge van de site.
    // Sfeerbeeld: handmatige keuze wint; anders kiest de engine zelf een willekeurige foto uit de pool.
    // Keuze (opts.image): een MOCKUP-id -> in-situ; een FOTO-id -> losse foto als startbeeld;
    // leeg = auto (in-situ als er mockups zijn, anders een willekeurige foto).
    const mById = (id) => mockupPool.find((m) => m.id === id);
    let chosenMockup = null, heroObj = null;
    if (opts.image) { chosenMockup = mById(opts.image) || null; if (!chosenMockup) heroObj = imgById(opts.image) || null; }
    else if (mockupPool.length) chosenMockup = mockupPool[Math.floor(Math.random() * mockupPool.length)];
    else if (imagePool.length) heroObj = imagePool[Math.floor(Math.random() * imagePool.length)];
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
        const bmos = film.buildSvg(parsed, bcols).replace(/<svg\b[^>]*>/i,
          `<svg x="${bx}" y="${by}" width="${bw}" height="${bh}" viewBox="0 0 ${bvw} ${bvh}" preserveAspectRatio="xMidYMid slice">`);
        badge = frame + `<g clip-path="url(#bdgclip)">${bmos}${glazeSvg(bx, by, bw, bh, "g")}</g>`;
      }
    }
    const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

    // CAMERA-REGIE (alleen met foto-bookend): intro zoomt in op de tegels in de foto,
    // lost op in het kale mozaïek dat inkleurt terwijl de camera terugtrekt; aan het eind
    // zoomt de camera weer in op het patroon, lost op in de foto, die langzaam uitzoomt.
    const camZoom = 1.7;   // getemperd: rustigere zoom (was 2.0)
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
    let insituFrame = null;
    if (insitu) {
      const finishedT = buildStart + Tb + 0.5;
      const finalCols = film.flowColorsAt(parsed, { palette: flowPal, durSec, buildSec: Tb, buildStart }, finishedT);
      // Plek op de muur: heeft de mockup een sidecar (place), dan daar; anders gecentreerd
      // op HETZELFDE midden als het opbouw-paneel met maat panelH/camZoom, zodat bij de
      // inzoom (×camZoom) het paneel precies op het opbouw-mozaïek valt (naadloze dissolve).
      const A2 = pw / ph;
      const pl = chosenMockup && chosenMockup.place;
      const wH = Math.round(pl ? pl.h * H : panelH / camZoom), wW = Math.round(wH * A2);
      const cxp = Math.round(pl ? pl.cx * W : W / 2), cyp = Math.round(pl ? pl.cy * H : panelY + panelH / 2);
      const wx = Math.round(cxp - wW / 2), wy = Math.round(cyp - wH / 2);
      const panelInner = film.buildSvg(parsed, finalCols).replace(/<svg\b[^>]*>/i,
        `<svg x="${wx}" y="${wy}" width="${wW}" height="${wH}" viewBox="0 0 ${pw} ${ph}" preserveAspectRatio="xMidYMid slice">`);
      // De NAAM óók op het paneel aan de muur (gebakken in het in-situ-beeld), gecentreerd en
      // op dezelfde plek/schaal als op het opbouw-paneel -> blijft staan door de dissolve heen.
      let nmPlate = "";
      if (name && np) {
        const plW = Math.round(wW * 0.62), plH = Math.round(plW * 200 / 560);
        const plX = Math.round(cxp - plW / 2), plY = Math.round(cyp - plH / 2);
        nmPlate = nameLayerSvg(name, np, 1).replace(/<svg\b[^>]*>/i,
          `<svg x="${plX}" y="${plY}" width="${plW}" height="${plH}" viewBox="0 0 560 200" preserveAspectRatio="xMidYMid meet">`);
      }
      const deco = `<rect x="${wx + 5}" y="${wy + 13}" width="${wW + 10}" height="${wH + 10}" rx="5" fill="#000" opacity="0.30"/>`   // schaduw
        + `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="#16110d"/>`                       // lijst
        + `<rect x="${wx - 7}" y="${wy - 7}" width="${wW + 14}" height="${wH + 14}" rx="4" fill="none" stroke="${branding.gold}" stroke-width="2.5"/>`;
      insituFrame = (scale) => `<g transform="translate(${cxp} ${cyp}) scale(${scale.toFixed(3)}) translate(${-cxp} ${-cyp})">`
        + `<image href="${mockup}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>${deco}${panelInner}${glazeSvg(wx, wy, wW, wH, "i")}${nmPlate}</g>`;
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
      let colors = isFlow ? film.flowColorsAt(parsed, { palette: flowPal, durSec, buildSec: Tb, buildStart, speed: tempoMul }, t) : film.colorsAt(parsed, story, t);
      if (tailK > 0) colors = colors.map((c) => _mix(c, film.BLANK, tailK));
      const vw = pw / zMos, vh = ph / zMos, vx = (pw - vw) / 2, vy = (ph - vh) / 2;
      const mosaic = film.buildSvg(parsed, colors).replace(/<svg\b[^>]*>/i,
        `<svg x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" viewBox="${vx.toFixed(2)} ${vy.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}" preserveAspectRatio="xMidYMid slice">`);
      // mozaïek in de volle (afgeronde) rechthoek + glazuur-glans erover (vast op het
      // paneel, zodat de lichtval blijft staan terwijl de tegels inkleuren)
      const inner = `${rectClip}<g clip-path="url(#pan)">${mosaic}${glazeSvg(panelX, panelY, panelW, panelH, "b")}</g>`;
      let overlay = "";
      // begin/eind + reveals: in-situ (paneel op de muur) of de oude foto-bookend
      if (bookend && photoK > 0.002) {
        const k = photoK.toFixed(3);
        if (insitu) {
          overlay += `<g opacity="${k}">${insituFrame(zPhoto)}</g>`;
        } else {
          const iw = panelW * zPhoto, ih = panelH * zPhoto, ix = panelX - (iw - panelW) / 2, iy = panelY - (ih - panelH) / 2;
          overlay += `<g clip-path="url(#pan)"><image href="${hero}" x="${ix.toFixed(1)}" y="${iy.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="xMidYMid slice" opacity="${k}"/></g>`;
        }
      }
      // Paneel-rand: bij in-situ NIET over de muurfoto tekenen (de echte lijst zit al in de
      // mockup) -> vervaagt mee met de foto; tijdens de opbouw juist vol in beeld.
      if (insitu) { const bOp = 1 - photoK; if (bOp > 0.003) overlay += `<g opacity="${bOp.toFixed(3)}">${rectBorder}</g>`; }
      else overlay += rectBorder;
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
        const outK = bookend ? photoK : tailK;
        // naam = vaste afsluiter: verschijnt op het afgemaakte paneel en blijft staan tot de outro
        const oStartN = durSec - (bookend ? To : 1.3);
        const nameStart = Math.min(buildStart + Tb + 0.5, oStartN - 2.6);
        const op = Math.max(0, Math.min(1, (t - nameStart) / 1.1)) * (1 - outK);
        if (op > 0.01) {
          const plateW = Math.round(panelW * 0.56), plateH = Math.round(plateW * 200 / 560);
          const plateX = Math.round(panelX + (panelW - plateW) / 2), plateY = Math.round(panelY + (panelH - plateH) / 2 + (1 - Math.min(1, op)) * 10);
          const pl = nameLayerSvg(name, np, 1).replace(/<svg\b[^>]*>/i, `<svg x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" viewBox="0 0 560 200" preserveAspectRatio="xMidYMid meet">`);
          overlay += `<g opacity="${op.toFixed(3)}">${pl}</g>`;
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
    init, listSubjects, listImages, listMockups, templates, makeRender, thumbSvg,
    options: ["palette", "duration", "reveal", "tempo", "name", "image"],
  };
}
