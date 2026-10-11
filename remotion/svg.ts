// Gedeelde, pure SVG-logica. Geen DOM nodig -> werkt in Node (test/rasterizer)
// en in de browser (Remotion render).
//
// Aanpak: de uit #mSvgStage getrokken SVG blijft HELEMAAL intact (alle <g>,
// transforms, inline styles, defs/style blijven staan). We onthullen de
// steentjes IN PLACE: op elke tile-polygon zetten we per frame extra opacity +
// een schaal rond het eigen midden. Zo klopt kleur, voeg en positie 1-op-1 met
// de site.

export type Tile = {
  openTag: string; // het <polygon ...> openingstag (zonder </polygon>)
  cx: number; // lokaal middelpunt
  cy: number;
  gx: number; // globaal middelpunt (lokaal + ouder-translates) voor volgorde
  gy: number;
  order: number; // inkleur-rang 0..N-1 (bepaalt timing, niet de positie)
  realFill: string; // de echte kleur van dit steentje
};

// Neutrale "nog niet ingekleurd"-kleur (voeg/raw). Elk steentje start hierop en
// kleurt dan in naar zijn echte kleur.
const BLANK_FILL = "#e8e5e2";

export type ParsedSvg = {
  // Rebuild = statics[0] + tile[0] + statics[1] + tile[1] + ... + statics[N]
  statics: string[];
  tiles: Tile[];
  view: { x: number; y: number; w: number; h: number };
};

export type RevealMode =
  | "radial"
  | "sweep-x"
  | "sweep-y"
  | "diagonal"
  | "random";

export type RevealOpts = {
  mode?: RevealMode;
  fps: number;
  revealStartSec: number;
  revealEndSec: number;
  popDurSec: number;
  tileSelector?: string;
};

const numAttr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m ? m[1] : undefined;
};

function parseView(svg: string) {
  const open = (svg.match(/<svg\b[^>]*>/i) || [""])[0];
  const vb = numAttr(open, "viewBox");
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite))
      return { x: p[0], y: p[1], w: p[2], h: p[3] };
  }
  return { x: 0, y: 0, w: 100, h: 100 };
}

function polygonCentroid(points: string): { cx: number; cy: number } {
  const n = points.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  let sx = 0, sy = 0, c = 0;
  for (let i = 0; i + 1 < n.length; i += 2) {
    sx += n[i];
    sy += n[i + 1];
    c++;
  }
  return c ? { cx: sx / c, cy: sy / c } : { cx: 0, cy: 0 };
}

function pathCentroid(d: string): { cx: number; cy: number } {
  const n = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
  let sx = 0, sy = 0, c = 0;
  for (let i = 0; i + 1 < n.length; i += 2) {
    sx += n[i];
    sy += n[i + 1];
    c++;
  }
  return c ? { cx: sx / c, cy: sy / c } : { cx: 0, cy: 0 };
}

// Som van alle translate(x[,y]) in een transform-string.
function translateOf(transform: string): { tx: number; ty: number } {
  let tx = 0, ty = 0;
  const re = /translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transform))) {
    tx += parseFloat(m[1]);
    ty += m[2] ? parseFloat(m[2]) : 0;
  }
  return { tx, ty };
}

function isTile(tagName: string, openTag: string, selectorTags: string[]): boolean {
  if (!selectorTags.includes(tagName)) return false;
  // Voorkeur: echte steentjes dragen class="mtile" (en/of data-sig).
  // Zijn die er, dan ALLEEN die. Anders: elk element in de selector.
  return true;
}

export function parseSvg(svg: string, tileSelector = "polygon,path"): ParsedSvg {
  const selectorTags = tileSelector.split(",").map((s) => s.trim().toLowerCase());
  const view = parseView(svg);

  // Tokeniseer lineair: <g ...>, </g>, en kandidaat-tiles, in documentvolgorde.
  // Houd een stack van translate-offsets bij voor globale posities.
  const tokenRe = /<(g)\b([^>]*)>|<\/g>|<(polygon|path|rect)\b([^>]*?)(\/?)>/gi;

  // Eerst: bevat de SVG tiles met class="mtile"? Dan is dat de selector.
  const hasMtile = /class\s*=\s*"[^"]*\bmtile\b[^"]*"/i.test(svg);

  type Raw = { start: number; end: number; openTag: string; cx: number; cy: number; gx: number; gy: number; realFill: string };
  const raws: Raw[] = [];
  const stack: Array<{ tx: number; ty: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(svg))) {
    if (m[1]) {
      // <g ...>
      const t = translateOf(m[2] || "");
      stack.push(t);
    } else if (m[0] === "</g>" || /^<\/g>/i.test(m[0])) {
      stack.pop();
    } else if (m[3]) {
      const tagName = m[3].toLowerCase();
      const openTag = m[0].replace(/\/>$/, ">"); // normaliseer naar "...>"
      const selected = hasMtile
        ? /class\s*=\s*"[^"]*\bmtile\b[^"]*"/i.test(openTag)
        : isTile(tagName, openTag, selectorTags);
      if (!selected) continue;
      let c = { cx: 0, cy: 0 };
      if (tagName === "polygon") c = polygonCentroid(numAttr(openTag, "points") || "");
      else if (tagName === "path") c = pathCentroid(numAttr(openTag, "d") || "");
      else if (tagName === "rect") {
        const x = parseFloat(numAttr(openTag, "x") || "0");
        const y = parseFloat(numAttr(openTag, "y") || "0");
        const w = parseFloat(numAttr(openTag, "width") || "0");
        const h = parseFloat(numAttr(openTag, "height") || "0");
        c = { cx: x + w / 2, cy: y + h / 2 };
      }
      const off = stack.reduce(
        (a, s) => ({ tx: a.tx + s.tx, ty: a.ty + s.ty }),
        { tx: 0, ty: 0 }
      );
      raws.push({
        start: m.index,
        end: m.index + m[0].length,
        openTag,
        cx: c.cx,
        cy: c.cy,
        gx: c.cx + off.tx,
        gy: c.cy + off.ty,
        realFill: fillOf(openTag),
      });
    }
  }

  // Bouw statics + tiles. De oorspronkelijke tag (incl. eventuele "/>" en de
  // losse </polygon>) blijft in de statics; wij vervangen alleen de opening.
  const statics: string[] = [];
  const tiles: Tile[] = [];
  let cursor = 0;
  for (const r of raws) {
    statics.push(svg.slice(cursor, r.start));
    tiles.push({ openTag: r.openTag, cx: r.cx, cy: r.cy, gx: r.gx, gy: r.gy, order: 0, realFill: r.realFill });
    cursor = r.end;
  }
  statics.push(svg.slice(cursor));

  return { statics, tiles, view };
}

// ---- Reveal-volgorde (zet alleen .order, herschikt NIET) --------------------
export function orderTiles(p: ParsedSvg, mode: RevealMode = "radial"): void {
  const { x, y, w, h } = p.view;
  const mx = x + w / 2, my = y + h / 2;
  const key = (t: Tile) => {
    switch (mode) {
      case "sweep-x": return t.gx;
      case "sweep-y": return t.gy;
      case "diagonal": return t.gx + t.gy;
      case "random": return stableHash(t.openTag);
      case "radial":
      default: return Math.hypot(t.gx - mx, t.gy - my);
    }
  };
  const idx = p.tiles.map((t, i) => ({ i, k: key(t) }));
  idx.sort((a, b) => a.k - b.k);
  idx.forEach((o, rank) => (p.tiles[o.i].order = rank));
}

function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function tileProgress(order: number, total: number, frame: number, o: RevealOpts): number {
  const startF = o.revealStartSec * o.fps;
  const endF = o.revealEndSec * o.fps;
  const span = Math.max(1, endF - startF);
  const popF = Math.max(1, o.popDurSec * o.fps);
  const slot = total > 1 ? order / (total - 1) : 0;
  const tileStart = startF + slot * (span - popF);
  return Math.max(0, Math.min(1, (frame - tileStart) / popF));
}

// Bouw de volledige SVG-string voor 1 frame: het patroon staat er VOLLEDIG
// (alle vormen zichtbaar), maar elk steentje heeft z'n kleur pas als het is
// "ingekleurd". Voor die tijd toont het de neutrale voegkleur. De voeg/stroke
// blijft altijd zichtbaar.
export function buildFrameSvg(p: ParsedSvg, frame: number, o: RevealOpts): string {
  const total = p.tiles.length;
  let out = p.statics[0];
  for (let i = 0; i < total; i++) {
    const t = p.tiles[i];
    const prog = tileProgress(t.order, total, frame, o);
    out += colorTile(t, prog);
    out += p.statics[i + 1];
  }
  return out;
}

function colorTile(t: Tile, prog: number): string {
  let fill: string;
  if (prog <= 0) fill = BLANK_FILL;
  else if (prog >= 1) fill = t.realFill;
  else fill = mixHex(BLANK_FILL, t.realFill, easeInOut(prog));
  return setFill(t.openTag, fill);
}

// Lees de echte fill uit style="fill:#..." of fill="#...".
function fillOf(tag: string): string {
  const s = tag.match(/style\s*=\s*"([^"]*)"/i);
  if (s) {
    const f = s[1].match(/fill\s*:\s*([^;"']+)/i);
    if (f) return f[1].trim();
  }
  const fa = tag.match(/\bfill\s*=\s*"([^"]+)"/i);
  return fa ? fa[1].trim() : "#b0a99c";
}

// Zet de fill (in de style als die er is, anders als attribuut).
function setFill(tag: string, fill: string): string {
  if (/style\s*=\s*"[^"]*fill\s*:/i.test(tag)) {
    return tag.replace(/(style\s*=\s*"[^"]*?fill\s*:\s*)[^;"']+/i, `$1${fill}`);
  }
  if (/\bfill\s*=\s*"/i.test(tag)) {
    return tag.replace(/\bfill\s*=\s*"[^"]*"/i, `fill="${fill}"`);
  }
  return tag.replace(/^<([a-zA-Z]+)/, `<$1 fill="${fill}"`);
}

function mixHex(a: string, b: string, t: number): string {
  const pa = hex(a), pb = hex(b);
  if (!pa || !pb) return t >= 0.5 ? b : a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}

function hex(c: string): [number, number, number] | null {
  const m = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
