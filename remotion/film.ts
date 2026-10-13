// Tegel-canvas animatie-engine (kern, data-gedreven zodat alles door Remotion
// inputProps past). Eén bron van waarheid; de standalone renderer compileert dit
// bestand ook. Geen DOM nodig.

export const PAL = ["#c75a4e","#f79f45","#e4ce8c","#117573","#32949e","#7e95d7","#a1c981",
  "#efc7c8","#90a084","#45497d","#99bfc5","#f6ae91","#c67765","#e7c077","#663959","#94342f"];
export const WARM = ["#c75a4e","#f79f45","#e4ce8c","#f6ae91","#e7c077","#c67765","#efc7c8","#94342f"];
export const COOL = ["#117573","#32949e","#7e95d7","#45497d","#99bfc5","#90a084","#a1c981","#663959"];
export const BLANK = "#e8e5e2";
export const PLUM = "#2a2335";
// Voeg (exact uit page.ts, var VOEG): gips-crème #eae4d7 breedte 5 tussen ingekleurde
// tegels; donker contour #b9a98c breedte 2 op de nog-neutrale (raw) tegels; neutraal #e8e5e2.
export const VOEG = "#eae4d7";
export const VOEG_RAW = "#b9a98c";
export const VOEG_PX = 5, VOEG_RAW_PX = 2;

export type Tile = { start: number; end: number; gx: number; gy: number; nx: number; ny: number; order: number; key: string };
export type Parsed = { svg: string; view: number[]; tiles: Tile[]; _cache?: { story: Storyboard; seg: string[][] }; _flow?: { key: string; fin: string[] } };

// Scene-beschrijving = pure data (serialiseerbaar):
export type Scene =
  | { type: "confetti"; palette?: string[] }
  | { type: "fields"; palette?: string[] }
  | { type: "shape"; shape: "heart" | "star" | "diamond"; fg?: string[]; bg?: string };

export type Segment = { scene: Scene; hold: number; trans: number };
export type Storyboard = { buildSec: number; popSec: number; segments: Segment[] };

// ---- PATROON TEGELEN (exacte port van mTileField uit de site) --------------
// Neemt de kale patroon-eenheid + de lock {n,gx,gy} en legt 'm naadloos als
// raster neer. stepX = contentbreedte + gx. Elke cel krijgt data-cell="i_j" en
// elke tegel data-idx -> samen de sleutel c{i}_{j}_i{idx} (zoals de site).
export type Lock = { n?: number; gx?: number; gy?: number };

// Transform toepassen op een punt (port van mApplyTf, page.ts): eerst rotate, dan translate.
function applyTf(x: number, y: number, tf: string | null): [number, number] {
  if (!tf) return [x, y];
  const rot = tf.match(/rotate\(\s*(-?[0-9.]+)(?:[ ,]+(-?[0-9.]+)[ ,]+(-?[0-9.]+))?/);
  if (rot) { const a = +rot[1] * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); let rx = 0, ry = 0; if (rot[2] !== undefined) { rx = +rot[2]; ry = +rot[3]; } const dx = x - rx, dy = y - ry; x = rx + dx * c - dy * s; y = ry + dx * s + dy * c; }
  const tr = tf.match(/translate\(\s*(-?[0-9.]+)(?:[ ,]+(-?[0-9.]+))?/);
  if (tr) { x += +tr[1]; if (tr[2] !== undefined) y += +tr[2]; }
  return [x, y];
}
// Punten uit een path-d (port van mPathPts, page.ts).
function pathPts(d: string): [number, number][] {
  const pts: [number, number][] = []; let x = 0, y = 0, sx = 0, sy = 0, m: RegExpExecArray | null;
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  while ((m = re.exec(d))) {
    const nums = (m[2].match(/-?[0-9.]+(?:e-?[0-9]+)?/g) || []).map(Number);
    const rel = m[1] === m[1].toLowerCase(), c = m[1].toUpperCase(); let i = 0;
    if (c === "M") { x = rel ? x + nums[0] : nums[0]; y = rel ? y + nums[1] : nums[1]; sx = x; sy = y; pts.push([x, y]); i = 2; for (; i + 1 < nums.length; i += 2) { x = rel ? x + nums[i] : nums[i]; y = rel ? y + nums[i + 1] : nums[i + 1]; pts.push([x, y]); } }
    else if (c === "L") { for (; i + 1 < nums.length; i += 2) { x = rel ? x + nums[i] : nums[i]; y = rel ? y + nums[i + 1] : nums[i + 1]; pts.push([x, y]); } }
    else if (c === "H") { for (; i < nums.length; i++) { x = rel ? x + nums[i] : nums[i]; pts.push([x, y]); } }
    else if (c === "V") { for (; i < nums.length; i++) { y = rel ? y + nums[i] : nums[i]; pts.push([x, y]); } }
    else if (c === "C") { for (; i + 5 < nums.length; i += 6) { x = rel ? x + nums[i + 4] : nums[i + 4]; y = rel ? y + nums[i + 5] : nums[i + 5]; pts.push([x, y]); } }
    else if (c === "S" || c === "Q") { for (; i + 3 < nums.length; i += 4) { x = rel ? x + nums[i + 2] : nums[i + 2]; y = rel ? y + nums[i + 3] : nums[i + 3]; pts.push([x, y]); } }
    else if (c === "T") { for (; i + 1 < nums.length; i += 2) { x = rel ? x + nums[i] : nums[i]; y = rel ? y + nums[i + 1] : nums[i + 1]; pts.push([x, y]); } }
    else if (c === "Z") { x = sx; y = sy; }
  }
  return pts;
}
// Transform-bewuste bounding box van de patroon-inhoud (port van mContentBBox, page.ts).
// DIT is de echte herhaal-eenheid; zonder transforms klopte mijn eenheid niet -> "los van elkaar".
function contentBBox(inner: string) {
  const xs: number[] = [], ys: number[] = []; let e: RegExpExecArray | null;
  const add = (x: number, y: number, tf: string | null) => { const p = applyTf(x, y, tf); xs.push(p[0]); ys.push(p[1]); };
  const rp = /<polygon([^>]*)>/g;
  while ((e = rp.exec(inner))) { const a = " " + e[1]; const pm = a.match(/points="([^"]*)"/); if (!pm) continue; const tf = (a.match(/transform="([^"]*)"/) || [])[1] || null; const n = (pm[1].match(/-?[0-9.]+/g) || []).map(Number); for (let i = 0; i + 1 < n.length; i += 2) add(n[i], n[i + 1], tf); }
  const rr = /<rect([^>]*)>/g;
  while ((e = rr.exec(inner))) { const a = " " + e[1]; const xm = a.match(/ x="([^"]*)"/), ym = a.match(/ y="([^"]*)"/), wm = a.match(/ width="([^"]*)"/), hm = a.match(/ height="([^"]*)"/); const tf = (a.match(/transform="([^"]*)"/) || [])[1] || null; if (xm && ym && wm && hm) { const x = +xm[1], y = +ym[1], w = +wm[1], h = +hm[1]; add(x, y, tf); add(x + w, y, tf); add(x + w, y + h, tf); add(x, y + h, tf); } }
  const rd = /<path([^>]*)>/g;
  while ((e = rd.exec(inner))) { const a = " " + e[1]; const dm = a.match(/ d="([^"]*)"/); if (!dm) continue; const tf = (a.match(/transform="([^"]*)"/) || [])[1] || null; const pts = pathPts(dm[1]); for (let k = 0; k < pts.length; k++) add(pts[k][0], pts[k][1], tf); }
  if (xs.length < 2) return { minx: 0, miny: 0, w: 700, h: 700 };
  const mnx = Math.min(...xs), mny = Math.min(...ys);
  return { minx: mnx, miny: mny, w: Math.max(...xs) - mnx, h: Math.max(...ys) - mny };
}
// nummer elke vorm (polygon/rect/path) met data-idx, zodat elke tegel een adres heeft
function numberShapes(inner: string): string {
  let i = 0;
  return inner.replace(/<(polygon|rect|path)\b/gi, (_m, t) => `<${t} data-idx="${i++}"`);
}

export function tilePattern(baseSvg: string, lock: Lock, nX: number, nY: number): string {
  const gt = baseSvg.indexOf(">", baseSvg.indexOf("<svg"));
  const end = baseSvg.lastIndexOf("</svg>");
  let inner = gt >= 0 && end > gt ? baseSvg.slice(gt + 1, end) : baseSvg;
  inner = numberShapes(inner);
  const bb = contentBBox(inner);
  const cw = bb.w || 700, ch = bb.h || 700, minx = bb.minx || 0, miny = bb.miny || 0;
  const gx = lock && lock.gx ? lock.gx : 0, gy = lock && lock.gy ? lock.gy : 0;
  const stepX = cw + gx, stepY = ch + gy;
  const canvasW = stepX * nX, canvasH = stepY * nY;
  const offX = -gx / 2, offY = -gy / 2;
  // bleed-cellen (-1..n+1) vullen de randen na de centrering -> geen gaten aan de rand (zoals mTileField)
  let cells = "";
  for (let j = -1; j <= nY + 1; j++) for (let i = -1; i <= nX + 1; i++) {
    const tx = (i * stepX - minx - offX).toFixed(1), ty = (j * stepY - miny - offY).toFixed(1);
    cells += `<g data-cell="${i}_${j}" transform="translate(${tx},${ty})">${inner}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasW.toFixed(0)} ${canvasH.toFixed(0)}" preserveAspectRatio="none">${cells}</svg>`;
}

export function parseTiles(svg: string, reveal: string = "diag"): Parsed {
  const view = (svg.match(/viewBox="([^"]+)"/) || [])[1].split(/\s+/).map(Number);
  const tokenRe = /<(g)\b([^>]*)>|<\/g>|<(polygon|rect|path)\b([^>]*?)\/?>/gi;
  const translate = (t: string) => { let tx = 0, ty = 0, m: RegExpExecArray | null; const re = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\)/gi; while ((m = re.exec(t))) { tx += +m[1]; ty += +m[2]; } return { tx, ty }; };
  // middelpunt van een vorm, ongeacht type (polygon/rect/path)
  const centerOf = (tag: string, tagName: string): [number, number] => {
    if (tagName === "rect") { const g = (k: string) => parseFloat((tag.match(new RegExp('(?:^|\\s)' + k + '="([^"]*)"')) || [])[1] || "0"); return [g("x") + g("width") / 2, g("y") + g("height") / 2]; }
    const src = tagName === "path" ? (tag.match(/\bd="([^"]*)"/) || [])[1] || "" : (tag.match(/points="([^"]*)"/) || [])[1] || "";
    const n = (src.match(/-?[0-9.]+/g) || []).map(Number); let sx = 0, sy = 0, c = 0; for (let i = 0; i + 1 < n.length; i += 2) { sx += n[i]; sy += n[i + 1]; c++; } return c ? [sx / c, sy / c] : [0, 0];
  };
  const tiles: Tile[] = []; const stack: { tx: number; ty: number }[] = []; const cellStack: string[] = []; let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(svg))) {
    if (m[1]) { stack.push(translate(m[2] || "")); const cm = (m[2] || "").match(/data-cell="([^"]+)"/); cellStack.push(cm ? cm[1] : (cellStack[cellStack.length - 1] || "")); }
    else if (/^<\/g>/i.test(m[0])) { stack.pop(); cellStack.pop(); }
    else if (m[3] !== undefined) {
      const [cx, cy] = centerOf(m[0], m[3].toLowerCase());
      const off = stack.reduce((a, s) => ({ tx: a.tx + s.tx, ty: a.ty + s.ty }), { tx: 0, ty: 0 });
      const gx = cx + off.tx, gy = cy + off.ty;
      const cell = cellStack[cellStack.length - 1] || "";
      const idx = (m[0].match(/data-idx="([0-9-]+)"/) || [])[1] || "";
      tiles.push({ start: m.index, end: m.index + m[0].length, gx, gy, nx: 0, ny: 0, order: 0, key: cell ? `c${cell}_i${idx}` : "" });
    }
  }
  // Genormaliseerde positie (0..1) op basis van de ECHTE tegel-grenzen, niet het
  // tekenvak/viewBox — robuust als een patroon een rare viewBox of coördinaten heeft
  // (voorkomt dat Vlakken/vormen omvallen naar één egale kleur).
  let miX = Infinity, maX = -Infinity, miY = Infinity, maY = -Infinity;
  for (const t of tiles) { if (Number.isFinite(t.gx)) { if (t.gx < miX) miX = t.gx; if (t.gx > maX) maX = t.gx; } if (Number.isFinite(t.gy)) { if (t.gy < miY) miY = t.gy; if (t.gy > maY) maY = t.gy; } }
  const spanX = maX - miX || 1, spanY = maY - miY || 1;
  for (const t of tiles) { t.nx = Number.isFinite(t.gx) ? (t.gx - miX) / spanX : 0.5; t.ny = Number.isFinite(t.gy) ? (t.gy - miY) / spanY : 0.5; }
  setReveal({ svg, view, tiles }, reveal);
  return { svg, view, tiles };
}

// Bepaalt de volgorde waarin tegels inkleuren (de "opbouw"-beweging).
export function setReveal(parsed: Parsed, reveal: string = "diag"): void {
  const { tiles } = parsed;
  let s = 7; const h = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jit = 0.045;
  const keyFn = (t: Tile): number => {
    if (reveal === "radial") return Math.hypot(t.nx - 0.5, (t.ny - 0.5) * 1.2);   // bloei vanuit midden
    if (reveal === "down") return t.ny;                                            // van boven naar beneden
    if (reveal === "up") return 1 - t.ny;                                          // van onder naar boven
    return t.nx + t.ny;                                                            // diagonaal (standaard)
  };
  const keyed = tiles.map((t, i) => ({ i, k: keyFn(t) + (h() - 0.5) * jit }));
  keyed.sort((a, b) => a.k - b.k); keyed.forEach((o, rank) => (tiles[o.i].order = rank / (tiles.length - 1 || 1)));
}

function hx(c: string): [number, number, number] { if (typeof c !== "string" || c.charCodeAt(0) !== 35) c = "#140f1e"; const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
// Tint (0..360) van een kleur — om een palet op kleur te sorteren zodat naburige
// kleuren op elkaar lijken en het stromen vloeiend wordt i.p.v. springerig.
function hue(c: string): number { const r = hx(c).map((x) => x / 255), mx = Math.max(r[0], r[1], r[2]), mn = Math.min(r[0], r[1], r[2]), d = mx - mn; if (!d) return 0; let h = 0; if (mx === r[0]) h = ((r[1] - r[2]) / d) % 6; else if (mx === r[1]) h = (r[2] - r[0]) / d + 2; else h = (r[0] - r[1]) / d + 4; return (h * 60 + 360) % 360; }
function mix(a: string, b: string, t: number): string { t = t < 0 ? 0 : t > 1 ? 1 : t; const A = hx(a), B = hx(b); const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t); return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1); }
function seeded(i: number): number { let s = (i * 2654435761) >>> 0; s ^= s >>> 15; return (s >>> 0) / 4294967295; }
// HSL-hulp voor natuurlijke tegel-variatie (handgeglazuurd: geen twee gelijk).
function _toHsl(hex: string): [number, number, number] { let [r, g, b] = hx(hex).map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; } h = ((h * 60) + 360) % 360; const l = (mx + mn) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); return [h, s, l]; }
function _fromHsl(h: number, s: number, l: number): string { s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l)); const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2; let r = 0, g = 0, b = 0; const k = ((Math.floor(h / 60) % 6) + 6) % 6; if (k === 0) [r, g, b] = [c, x, 0]; else if (k === 1) [r, g, b] = [x, c, 0]; else if (k === 2) [r, g, b] = [0, c, x]; else if (k === 3) [r, g, b] = [0, x, c]; else if (k === 4) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x]; const R = Math.round((r + m) * 255), G = Math.round((g + m) * 255), B = Math.round((b + m) * 255); return "#" + ((1 << 24) + (R << 16) + (G << 8) + B).toString(16).slice(1); }
// Elke tegel krijgt een piepklein eigen afwijkinkje in tint/verzadiging/helderheid,
// zoals handgeglazuurde zellige die per stuk net iets anders uit de oven komt.
function tileVary(hex: string, i: number): string {
  if (typeof hex !== "string" || hex[0] !== "#") return hex;
  const r1 = seeded(i * 7 + 1), r2 = seeded(i * 13 + 5), r3 = seeded(i * 17 + 9);
  const [h, s, l] = _toHsl(hex);
  // Dieper/voller glazuur i.p.v. licht-pastel: helderheid omlaag, verzadiging iets op,
  // plus een piepkleine per-tegel afwijking (handgeglazuurd -> geen twee gelijk).
  const dl = Math.max(0.2, Math.min(0.6, l * 0.82)) + (r3 - 0.5) * 0.08;
  const ds = Math.min(1, s * 1.12 * (1 + (r2 - 0.5) * 0.12));
  return _fromHsl(h + (r1 - 0.5) * 9, ds, dl);
}
const rndFrom = (arr: string[], seed: number) => arr[Math.floor(seed * arr.length) % arr.length];
const smooth = (p: number) => p * p * (3 - 2 * p);

function shapeInside(shape: string, nx: number, ny: number, view: number[]): boolean {
  let AR = view[2] / view[3]; if (!Number.isFinite(AR) || AR <= 0) AR = 1;
  if (shape === "heart") { const u = (nx - 0.5) * AR * 2.5, v = (0.46 - ny) * 2.5; return Math.pow(u * u + v * v - 1, 3) - u * u * v * v * v < 0; }
  if (shape === "star") { const u = (nx - 0.5) * AR * 2.2, v = (ny - 0.5) * 2.2; const r = Math.hypot(u, v), a = Math.atan2(v, u); return r < 0.92 + 0.33 * Math.cos(8 * a); }
  const u = Math.abs(nx - 0.5) * AR, v = Math.abs(ny - 0.5); return u + v < 0.42; // diamond
}

function sceneColor(scene: Scene, tile: Tile, i: number, view: number[]): string {
  if (scene.type === "confetti") return rndFrom(scene.palette || PAL, seeded(i));
  if (scene.type === "fields") {
    const pal = scene.palette || PAL; const x = tile.nx * 6, y = tile.ny * 6;
    const n = Math.sin(x) + Math.sin(y * 1.3) + Math.sin((x + y) * 0.8) + Math.sin((x - y) * 1.1);
    let idx = Math.floor(((n + 4) / 8) * pal.length); if (!Number.isFinite(idx)) idx = 0; idx = Math.max(0, Math.min(pal.length - 1, idx)); return pal[idx];
  }
  return shapeInside(scene.shape, tile.nx, tile.ny, view) ? rndFrom(scene.fg || WARM, seeded(i)) : (scene.bg || PLUM);
}

export function defaultStoryboard(): Storyboard {
  return {
    buildSec: 2.6, popSec: 0.6,
    segments: [
      { scene: { type: "confetti" }, hold: 1.4, trans: 0 },
      { scene: { type: "shape", shape: "heart" }, hold: 1.8, trans: 0.9 },
      { scene: { type: "shape", shape: "star" }, hold: 1.8, trans: 0.9 },
      { scene: { type: "fields" }, hold: 1.8, trans: 0.9 },
    ],
  };
}

export function totalDuration(story: Storyboard): number {
  let d = story.buildSec + story.segments[0].hold;
  for (let s = 1; s < story.segments.length; s++) d += story.segments[s].trans + story.segments[s].hold;
  return d;
}

export function colorsAt(parsed: Parsed, story: Storyboard, t: number): string[] {
  const { tiles, view } = parsed;
  // Scene-kleuren 1x berekenen en cachen (niet elk frame opnieuw) — scheelt enorm.
  if (!parsed._cache || parsed._cache.story !== story) {
    parsed._cache = { story, seg: story.segments.map((seg) => tiles.map((tile, i) => sceneColor(seg.scene, tile, i, view))) };
  }
  const segColors = parsed._cache.seg;
  const out = new Array<string>(tiles.length);
  if (t < story.buildSec) {
    for (let i = 0; i < tiles.length; i++) {
      const start = tiles[i].order * (story.buildSec - story.popSec);
      const p = Math.max(0, Math.min(1, (t - start) / story.popSec));
      out[i] = p <= 0 ? BLANK : p >= 1 ? segColors[0][i] : mix(BLANK, segColors[0][i], smooth(p));
    }
    return out;
  }
  const tt = t - story.buildSec;
  // Eerste scène houdt vast tot segments[0].hold -> toon die direct (geen transitie)
  if (tt < story.segments[0].hold) { for (let i = 0; i < tiles.length; i++) out[i] = segColors[0][i]; return out; }
  let acc = story.segments[0].hold; let k = 0;
  for (let s = 1; s < story.segments.length; s++) { const dur = story.segments[s].trans + story.segments[s].hold; if (tt < acc + dur) { k = s; break; } acc += dur; k = s; }
  if (k === 0) { for (let i = 0; i < tiles.length; i++) out[i] = segColors[0][i]; return out; }
  const local = tt - acc; const tr = story.segments[k].trans;
  if (local < tr) { const e = smooth(tr > 0 ? local / tr : 1); for (let i = 0; i < tiles.length; i++) out[i] = mix(segColors[k - 1][i], segColors[k][i], e); }
  else { for (let i = 0; i < tiles.length; i++) out[i] = segColors[k][i]; }
  return out;
}

// SATISFYING-MOTOR: één doorlopend stromend kleurveld dat NOOIT stilstaat en
// naadloos loopt (einde == begin). Vervangt de losse kleur-stappen-met-stilstand.
// - organisch: een reizend plasma (golven die over het paneel kruipen), kleuren
//   morphen vloeiend door het (op tint gesorteerde) palet.
// - glans: een bewegende lichtband trekt diagonaal over de tegels.
// - opbouw: aan het begin kleuren de tegels in op volgorde (tile.order).
// opts = { palette, durSec, buildSec, reveal? }  — alle timing schaalt met durSec.
export type FlowOpts = { palette?: string[]; durSec: number; buildSec?: number; buildStart?: number; speed?: number };
// Eén vaste, samenhangende inkleuring per tegel (zoals een echt paneel): egale
// kleur-regio's, geen willekeur. 1× berekend en gecachet.
function finalColors(parsed: Parsed, base: string[]): string[] {
  const key = base.join(",");
  if (parsed._flow && parsed._flow.key === key) return parsed._flow.fin;
  const pal = base.length ? base : PAL;
  const fin = parsed.tiles.map((tile) => {
    const x = tile.nx * 6, y = tile.ny * 6;
    const n = Math.sin(x) + Math.sin(y * 1.3) + Math.sin((x + y) * 0.8) + Math.sin((x - y) * 1.1);
    let idx = Math.floor(((n + 4) / 8) * pal.length);
    idx = Math.max(0, Math.min(pal.length - 1, idx));
    return tileVary(pal[idx], tile.order ? Math.round(tile.order * 99991) : 0);
  });
  parsed._flow = { key, fin };
  return fin;
}
// SATISFYING = tegel voor tegel inkleuren naar de VASTE eindkleur, en dan blijven
// staan. Geen dansende/wisselende kleuren meer — de beweging komt van de camera.
export function flowColorsAt(parsed: Parsed, opts: FlowOpts, t: number): string[] {
  const { tiles } = parsed;
  const base = opts.palette && opts.palette.length ? opts.palette : PAL;
  const dur = opts.durSec > 0 ? opts.durSec : 24;
  const build = Math.max(0.5, opts.buildSec ?? dur * 0.5);   // tegels vullen over deze (lange) periode
  const bStart = Math.max(0, opts.buildStart ?? 0);
  const fin = finalColors(parsed, base);
  const pop = Math.min(0.7, build * 0.35);                   // hoe lang één tegel doet over inkleuren
  const out = new Array<string>(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    const revealT = bStart + tiles[i].order * build;         // elke tegel heeft z'n eigen moment (op volgorde)
    if (t < revealT) { out[i] = BLANK; continue; }           // nog kaal
    const q = Math.min(1, (t - revealT) / pop);
    out[i] = q >= 1 ? fin[i] : mix(BLANK, fin[i], smooth(q)); // kleurt in en blijft dan staan
  }
  return out;
}

// Zet fill + voeg-rand + randbreedte op één tegel-tag (werkt of 'style' bestaat of niet)
function paintTile(tag: string, fill: string, stroke: string, sw: number): string {
  const set = (t: string, prop: string, val: string, re: RegExp) => re.test(t) ? t.replace(re, `${prop}:${val}`) : (/style="/i.test(t) ? t.replace(/style="/i, `style="${prop}:${val};`) : t);
  tag = set(tag, "fill", fill, /fill:\s*[^;"']+/i);
  tag = set(tag, "stroke", stroke, /stroke:\s*[^;"'-][^;"']*/i);
  tag = set(tag, "stroke-width", String(sw), /stroke-width:\s*[^;"']+/i);
  tag = set(tag, "stroke-linejoin", "round", /stroke-linejoin:\s*[^;"']+/i);
  if (!/style="/i.test(tag)) tag = tag.replace(/\s*\/?>$/, ` style="fill:${fill};stroke:${stroke};stroke-width:${sw};stroke-linejoin:round"$&`);
  return tag;
}

export function buildSvg(parsed: Parsed, colors: string[]): string {
  const { svg, tiles } = parsed; let out = ""; let cur = 0;
  // voeg-breedte constant in patroon-coordinaten (exact zoals page.ts: VOEG.px=5, rawPx=2)
  for (let i = 0; i < tiles.length; i++) {
    out += svg.slice(cur, tiles[i].start);
    let tag = svg.slice(tiles[i].start, tiles[i].end);
    const col = colors[i] || BLANK;
    const raw = col === BLANK;
    tag = paintTile(tag, col, raw ? VOEG_RAW : VOEG, raw ? VOEG_RAW_PX : VOEG_PX);
    out += tag; cur = tiles[i].end;
  }
  out += svg.slice(cur);
  return out;
}
