// Tegel-canvas animatie-engine (kern, data-gedreven zodat alles door Remotion
// inputProps past). Eén bron van waarheid; de standalone renderer compileert dit
// bestand ook. Geen DOM nodig.

export const PAL = ["#c75a4e","#f79f45","#e4ce8c","#117573","#32949e","#7e95d7","#a1c981",
  "#efc7c8","#90a084","#45497d","#99bfc5","#f6ae91","#c67765","#e7c077","#663959","#94342f"];
export const WARM = ["#c75a4e","#f79f45","#e4ce8c","#f6ae91","#e7c077","#c67765","#efc7c8","#94342f"];
export const COOL = ["#117573","#32949e","#7e95d7","#45497d","#99bfc5","#90a084","#a1c981","#663959"];
export const BLANK = "#e8e5e2";
export const PLUM = "#2a2335";

export type Tile = { start: number; end: number; gx: number; gy: number; nx: number; ny: number; order: number };
export type Parsed = { svg: string; view: number[]; tiles: Tile[] };

// Scene-beschrijving = pure data (serialiseerbaar):
export type Scene =
  | { type: "confetti"; palette?: string[] }
  | { type: "fields"; palette?: string[] }
  | { type: "shape"; shape: "heart" | "star" | "diamond"; fg?: string[]; bg?: string };

export type Segment = { scene: Scene; hold: number; trans: number };
export type Storyboard = { buildSec: number; popSec: number; segments: Segment[] };

export function parseTiles(svg: string): Parsed {
  const view = (svg.match(/viewBox="([^"]+)"/) || [])[1].split(/\s+/).map(Number);
  const tokenRe = /<(g)\b([^>]*)>|<\/g>|<polygon\b([^>]*?)\/?>/gi;
  const translate = (t: string) => { let tx = 0, ty = 0, m: RegExpExecArray | null; const re = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\)/gi; while ((m = re.exec(t))) { tx += +m[1]; ty += +m[2]; } return { tx, ty }; };
  const centroid = (pts: string): [number, number] => { const n = pts.trim().split(/[\s,]+/).map(Number); let sx = 0, sy = 0, c = 0; for (let i = 0; i + 1 < n.length; i += 2) { sx += n[i]; sy += n[i + 1]; c++; } return c ? [sx / c, sy / c] : [0, 0]; };
  const tiles: Tile[] = []; const stack: { tx: number; ty: number }[] = []; let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(svg))) {
    if (m[1]) stack.push(translate(m[2] || ""));
    else if (/^<\/g>/i.test(m[0])) stack.pop();
    else if (m[3] !== undefined) {
      const pts = (m[0].match(/points="([^"]+)"/) || [])[1] || ""; const [cx, cy] = centroid(pts);
      const off = stack.reduce((a, s) => ({ tx: a.tx + s.tx, ty: a.ty + s.ty }), { tx: 0, ty: 0 });
      const gx = cx + off.tx, gy = cy + off.ty;
      tiles.push({ start: m.index, end: m.index + m[0].length, gx, gy, nx: gx / view[2], ny: gy / view[3], order: 0 });
    }
  }
  let s = 7; const h = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const jit = 0.1; const keyed = tiles.map((t, i) => ({ i, k: t.nx + t.ny + (h() - 0.5) * jit }));
  keyed.sort((a, b) => a.k - b.k); keyed.forEach((o, rank) => (tiles[o.i].order = rank / (tiles.length - 1 || 1)));
  return { svg, view, tiles };
}

function hx(c: string): [number, number, number] { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a: string, b: string, t: number): string { const A = hx(a), B = hx(b); const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t); return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1); }
function seeded(i: number): number { let s = (i * 2654435761) >>> 0; s ^= s >>> 15; return (s >>> 0) / 4294967295; }
const rndFrom = (arr: string[], seed: number) => arr[Math.floor(seed * arr.length) % arr.length];
const smooth = (p: number) => p * p * (3 - 2 * p);

function shapeInside(shape: string, nx: number, ny: number, view: number[]): boolean {
  const AR = view[2] / view[3];
  if (shape === "heart") { const u = (nx - 0.5) * AR * 2.5, v = (0.46 - ny) * 2.5; return Math.pow(u * u + v * v - 1, 3) - u * u * v * v * v < 0; }
  if (shape === "star") { const u = (nx - 0.5) * AR * 2.2, v = (ny - 0.5) * 2.2; const r = Math.hypot(u, v), a = Math.atan2(v, u); return r < 0.92 + 0.33 * Math.cos(8 * a); }
  const u = Math.abs(nx - 0.5) * AR, v = Math.abs(ny - 0.5); return u + v < 0.42; // diamond
}

function sceneColor(scene: Scene, tile: Tile, i: number, view: number[]): string {
  if (scene.type === "confetti") return rndFrom(scene.palette || PAL, seeded(i));
  if (scene.type === "fields") {
    const pal = scene.palette || PAL; const x = tile.nx * 6, y = tile.ny * 6;
    const n = Math.sin(x) + Math.sin(y * 1.3) + Math.sin((x + y) * 0.8) + Math.sin((x - y) * 1.1);
    let idx = Math.floor(((n + 4) / 8) * pal.length); idx = Math.max(0, Math.min(pal.length - 1, idx)); return pal[idx];
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
  const segColors = story.segments.map((seg) => tiles.map((tile, i) => sceneColor(seg.scene, tile, i, view)));
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
  let acc = story.segments[0].hold; let k = 0;
  for (let s = 1; s < story.segments.length; s++) { const dur = story.segments[s].trans + story.segments[s].hold; if (tt < acc + dur) { k = s; break; } acc += dur; k = s; }
  if (k === 0) { for (let i = 0; i < tiles.length; i++) out[i] = segColors[0][i]; return out; }
  const local = tt - acc; const tr = story.segments[k].trans;
  if (local < tr) { const e = smooth(tr > 0 ? local / tr : 1); for (let i = 0; i < tiles.length; i++) out[i] = mix(segColors[k - 1][i], segColors[k][i], e); }
  else { for (let i = 0; i < tiles.length; i++) out[i] = segColors[k][i]; }
  return out;
}

export function buildSvg(parsed: Parsed, colors: string[]): string {
  const { svg, tiles } = parsed; let out = ""; let cur = 0;
  for (let i = 0; i < tiles.length; i++) {
    out += svg.slice(cur, tiles[i].start);
    let tag = svg.slice(tiles[i].start, tiles[i].end);
    tag = tag.replace(/(style="[^"]*?fill:\s*)[^;"']+/i, `$1${colors[i]}`);
    out += tag; cur = tiles[i].end;
  }
  out += svg.slice(cur);
  return out;
}
