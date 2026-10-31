// MERK-MODULE: Umma United — faceless YouTube-kanaal (moslim van nu, trots/humor).
// Parallel aan Tale of Tiles; raakt de kern en de tegel-logica NIET aan.
//
// TYPE 1 — "kaart" (de kaart-door-de-tijd):
//   Een wereldkaart met een tijdbalk; een WAARDE PER GEBIED verandert of houdt stand
//   terwijl de tijd vordert. De getoonde laag voer je in (geloof, belasting, ...), dat
//   maakt het format oneindig. Jouw stem komt er later onder.
//
// Alles deterministisch, resvg-veilig: platte landvormen (uit assets/ummaunited/worldmap.json),
// herkleurd per frame, group-transform om het kaartvenster in het 9:16-beeld te zetten.
// Geen geneste/ingezoomde SVG naar resvg.
import fs from "node:fs/promises";
import path from "node:path";
import { composeChrome, FORMATS, escapeXml } from "../core/renderer.mjs";

// ---------------------------------------------------------------- huisstijl
const COL = {
  ink: "#0d1427", navy: "#111a33", navy2: "#1b2748",
  cream: "#f5efe1", orange: "#ff7a2f", red: "#c0392b",
  blue: "#2756a0", blue2: "#3f7fd0", green: "#2aa84a", mute: "#9fb6d8",
  land: "#26324f", landEdge: "#0d1427",
  ruler: "#5fb6d8", // koloniale heerser-markering (koel staal-cyaan, hoog contrast met oranje)
};
const SANS = "DejaVu Sans,sans-serif";
const SERIF = "DejaVu Serif,serif";
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sm = (p) => { p = clamp01(p); return p * p * (3 - 2 * p); };

// ---------------------------------------------------------------- camera / regio's
// De kaart is equirectangular op een 2000x1000-basis. Een "view" is [x,y,w,h] in die
// basis: het venster dat in beeld komt. Kleiner venster = verder ingezoomd.
function lonLat(lon, lat) { return [(lon + 180) / 360 * 2000, (90 - lat) / 180 * 1000]; }
function box(lonMin, latMin, lonMax, latMax, pad = 0) {
  const nw = lonLat(lonMin, latMax), se = lonLat(lonMax, latMin);
  let x = nw[0], y = nw[1], w = se[0] - nw[0], h = se[1] - nw[1];
  x -= w * pad; y -= h * pad; w *= 1 + 2 * pad; h *= 1 + 2 * pad;
  return [x, y, w, h];
}
// Benoemde gebieden — "zoom in op elk gebied naar keuze" zonder coördinaten te hoeven weten.
const REGIONS = {
  world: [0, 0, 2000, 1000],
  belt: [455, 150, 1360, 470],          // de gordel (MENA -> Zuidoost-Azië), standaard
  mena: box(-15, 10, 62, 42, 0.04),
  maghreb: box(-18, 19, 13, 38, 0.06),
  arabia: box(32, 11, 60, 33, 0.05),
  levant: box(33, 29, 43, 38, 0.08),
  turkey: box(25, 35, 45, 43, 0.08),
  iberia: box(-10, 35, 5, 44, 0.08),    // Andalusië
  westafrica: box(-18, 4, 16, 25, 0.05),
  hornafrica: box(32, -2, 52, 18, 0.06),
  southasia: box(60, 6, 92, 37, 0.04),
  sea: box(92, -11, 142, 22, 0.04),     // Zuidoost-Azië (Indonesië/Maleisië)
  europe: box(-12, 35, 45, 60, 0.04),
  centralasia: box(46, 35, 80, 52, 0.05),
};
// view resolven uit een regionaam ("sea") of een expliciete bbox ([x,y,w,h]).
function resolveView(v) {
  if (!v) return null;
  if (Array.isArray(v) && v.length === 4) return v.map(Number);
  if (typeof v === "string" && REGIONS[v]) return REGIONS[v].slice();
  return null;
}
// soepel tussen twee views: centrum lineair, grootte geometrisch -> voelt als echte zoom.
function interpView(a, b, t) {
  if (!b || t <= 0) return a;
  if (t >= 1) return b;
  const e = sm(t);
  const acx = a[0] + a[2] / 2, acy = a[1] + a[3] / 2, bcx = b[0] + b[2] / 2, bcy = b[1] + b[3] / 2;
  const cx = acx + (bcx - acx) * e, cy = acy + (bcy - acy) * e;
  const w = a[2] * Math.pow(b[2] / a[2], e), h = a[3] * Math.pow(b[3] / a[3], e);
  return [cx - w / 2, cy - h / 2, w, h];
}

// kleur-interpolatie
function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lerpCol(a, b, t) {
  const A = hex(a), B = hex(b);
  const r = Math.round(A[0] + (B[0] - A[0]) * t), g = Math.round(A[1] + (B[1] - A[1]) * t), bl = Math.round(A[2] + (B[2] - A[2]) * t);
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
}

// ---------------------------------------------------------------- verhaal-script
// Een verhaal is een leesbaar tekstbestand (assets/ummaunited/stories/<naam>.txt).
// Landen schrijf je op NAAM (of ISO-nummer). Format:
//   title: ...
//   view: belt            (basis-blik; regionaam of x,y,w,h)
//   group belt = Marokko, Algerije, Indonesië, ...
//   scene 1700 | Europe rules. The faith stays. | fill: belt=orange | rule: belt=ruler | view: belt | dur: 3.0
// fill = identiteit (wie de mensen zijn), rule = heerser (waas eroverheen). Kleuren:
// orange red ruler green blue blue2 cream  (of een eigen #hexcode).
const COLORS = {
  orange: COL.orange, red: COL.red, ruler: COL.ruler, green: COL.green,
  blue: COL.blue, blue2: COL.blue2, cream: COL.cream, mute: COL.mute, navy: COL.navy, land: COL.land,
};
// losse schrijfwijzen -> officiële naam in de kaart-asset
const ALIASES = {
  uae: "United Arab Emirates", emirates: "United Arab Emirates", saudi: "Saudi Arabia", ksa: "Saudi Arabia",
  bosnia: "Bosnia and Herz.", turkiye: "Turkey", "türkiye": "Turkey", usa: "United States of America",
  uk: "United Kingdom", "s. sudan": "S. Sudan",
};
function resolveColor(tok) {
  tok = String(tok).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(tok)) return tok;
  return COLORS[tok.toLowerCase()] || null;
}
function parseViewToken(str) {
  const parts = String(str).split(",").map((s) => s.trim());
  if (parts.length === 4 && parts.every((p) => /^-?\d+(\.\d+)?$/.test(p))) return parts.map(Number);
  return String(str).trim(); // regionaam
}
// text -> { title, mapView, groups, scenes, warnings }. name2id = { landnaam(lowercase): isoId }.
function parseStory(text, name2id) {
  const resolveId = (tok) => {
    tok = String(tok).trim(); if (!tok) return null;
    if (/^\d+$/.test(tok)) return tok;                       // ruwe ISO-id
    const key = tok.toLowerCase();
    if (name2id[key]) return name2id[key];
    const al = ALIASES[key]; if (al && name2id[al.toLowerCase()]) return name2id[al.toLowerCase()];
    return null;
  };
  const out = { title: "", mapView: null, groups: {}, scenes: [], warnings: [] };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^title\s*:/i.test(line)) { out.title = line.replace(/^title\s*:/i, "").trim(); continue; }
    if (/^view\s*:/i.test(line)) { out.mapView = resolveView(parseViewToken(line.replace(/^view\s*:/i, "").trim())); continue; }
    let m = line.match(/^group\s+([^=]+)=(.*)$/i);
    if (m) {
      const gname = m[1].trim(), ids = [];
      for (const part of m[2].split(",")) {
        const id = resolveId(part);
        if (id) ids.push(id); else if (part.trim()) out.warnings.push("land niet gevonden: " + part.trim());
      }
      out.groups[gname] = ids; continue;
    }
    if (/^scene\s+/i.test(line)) {
      const segs = line.replace(/^scene\s+/i, "").split("|").map((s) => s.trim());
      const sc = { year: segs[0] || "", text: segs[1] || "", fills: {}, rule: {}, dur: 2.6 };
      for (let k = 2; k < segs.length; k++) {
        const seg = segs[k], ci = seg.indexOf(":"); if (ci < 0) continue;
        const key = seg.slice(0, ci).trim().toLowerCase(), val = seg.slice(ci + 1).trim();
        if (key === "fill" || key === "rule") {
          for (const pair of val.split(";")) {
            const eq = pair.indexOf("="); if (eq < 0) continue;
            const g = pair.slice(0, eq).trim(), c = resolveColor(pair.slice(eq + 1));
            if (!out.groups[g]) out.warnings.push("scene gebruikt onbekende groep: " + g);
            if (c) (key === "fill" ? sc.fills : sc.rule)[g] = c; else out.warnings.push("kleur onbekend: " + pair.trim());
          }
        } else if (key === "view") {
          const v = resolveView(parseViewToken(val)); if (v) sc.view = parseViewToken(val); else out.warnings.push("view onbekend: " + val);
        } else if (key === "dur") { const d = parseFloat(val); if (d > 0) sc.dur = d; }
      }
      out.scenes.push(sc); continue;
    }
    out.warnings.push("regel genegeerd: " + line);
  }
  return out;
}

// ---------------------------------------------------------------- gedeelde chrome
function kader(W, H) {
  const m = Math.round(W * 0.035), r = Math.round(W * 0.04);
  return `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" rx="${r}" fill="none" stroke="${COL.orange}" stroke-width="${Math.round(W * 0.012)}"/>`
    + `<rect x="${m + 7}" y="${m + 7}" width="${W - 2 * m - 14}" height="${H - 2 * m - 14}" rx="${r - 5}" fill="none" stroke="${COL.cream}" stroke-width="2" opacity="0.45"/>`;
}
// lettergrootte die binnen maxW past (ruwe breedte-schatting per teken)
function fitFs(txt, baseFs, maxW, perChar = 0.56) {
  const need = String(txt).length * baseFs * perChar;
  return need <= maxW ? baseFs : Math.max(10, Math.floor(baseFs * maxW / need));
}
function titel(txt, W, H, op = 1) {
  if (!txt) return "";
  const fs2 = fitFs(txt, Math.round(W * 0.058), W * 0.86, 0.6);
  return `<text x="${W / 2}" y="${H * 0.125}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fs2}" fill="${COL.cream}" opacity="${op.toFixed(2)}">${escapeXml(txt)}</text>`;
}
function onderschrift(txt, W, H, op = 1) {
  if (!txt) return "";
  const fs2 = fitFs(txt, Math.round(W * 0.05), W * 0.80, 0.56), y = Math.round(H * 0.84);
  const bw = Math.min(W * 0.88, fs2 * String(txt).length * 0.58);
  return `<g opacity="${op.toFixed(2)}">`
    + `<rect x="${W / 2 - bw / 2 - 16}" y="${y - fs2}" width="${bw + 32}" height="${fs2 * 1.7}" rx="${fs2}" fill="#000000" opacity="0.34"/>`
    + `<text x="${W / 2}" y="${y + fs2 * 0.3}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${fs2}" fill="${COL.cream}">${escapeXml(txt)}</text></g>`;
}

// ---------------------------------------------------------------- CTA-identiteitslaag
// Vaste merk-fold-out (abonnee-motor). Vouwt in op het emotionele hoogtepunt (eind).
// Herbruikbaar over ELK type. op = 0..1 (schuift omhoog + fade).
function ctaFoldout(W, H, op) {
  if (op <= 0.01) return "";
  const e = sm(op);
  const panelH = H * 0.26, panelW = W * 0.84;
  const x = (W - panelW) / 2;
  const yRest = H * 0.52;                  // eindpositie
  const y = yRest + (1 - e) * H * 0.2;     // schuift omhoog in
  const r = Math.round(W * 0.05);
  const fs1 = Math.round(W * 0.05), fs2 = Math.round(W * 0.044);
  let g = `<g opacity="${e.toFixed(2)}">`;
  // scrim over het hele beeld zodat de CTA de schone focus is
  g += `<rect x="0" y="0" width="${W}" height="${H}" fill="${COL.ink}" opacity="${(0.45 * e).toFixed(2)}"/>`;
  // donker paneel met oranje rand
  g += `<rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="${r}" fill="${COL.ink}" opacity="0.98"/>`;
  g += `<rect x="${x}" y="${y}" width="${panelW}" height="${panelH}" rx="${r}" fill="none" stroke="${COL.orange}" stroke-width="4"/>`;
  // regel 1: wie we zijn
  g += `<text x="${W / 2}" y="${y + panelH * 0.30}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fs1}" fill="${COL.cream}">We are Umma United.</text>`;
  // regel 2: de missie-CTA
  g += `<text x="${W / 2}" y="${y + panelH * 0.52}" text-anchor="middle" font-family="${SANS}" font-size="${fs2}" fill="${COL.mute}">Subscribe so we can go deeper.</text>`;
  // subscribe-chip (oranje pil)
  const chipW = W * 0.4, chipH = panelH * 0.26, cx = (W - chipW) / 2, cy = y + panelH * 0.64;
  g += `<rect x="${cx}" y="${cy}" width="${chipW}" height="${chipH}" rx="${chipH / 2}" fill="${COL.orange}"/>`;
  g += `<text x="${W / 2}" y="${cy + chipH * 0.70}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(chipH * 0.5)}" fill="${COL.ink}">SUBSCRIBE</text>`;
  g += `</g>`;
  return g;
}

export function makeBrand({ ROOT = "." } = {}) {
  const branding = {
    name: "Umma United", footer: "UMMA UNITED",
    bg: COL.ink, bg2: COL.navy2, gold: COL.orange, cream: COL.cream, plate: COL.navy,
  };
  let MAP = null;        // { viewBox:[x,y,w,h], countries:{id:path}, names:{id:name} }
  let NAME2ID = {};      // landnaam(lowercase) -> isoId, uit de kaart-asset
  let STORIES = {};      // verhaal-id (titel/bestandsnaam) -> geparseerd verhaal

  async function init() {
    try {
      const raw = await fs.readFile(path.resolve(ROOT, "assets/ummaunited/worldmap.json"), "utf8");
      MAP = JSON.parse(raw);
    } catch { MAP = null; }
    // naam -> id tabel bouwen zodat verhalen landen op naam mogen schrijven
    NAME2ID = {};
    if (MAP && MAP.names) for (const [id, nm] of Object.entries(MAP.names)) { if (id && id !== "undefined") NAME2ID[String(nm).toLowerCase()] = id; }
    // verhalen inladen uit assets/ummaunited/stories/*.txt (of .story)
    STORIES = {};
    try {
      const dir = path.resolve(ROOT, "assets/ummaunited/stories");
      for (const f of await fs.readdir(dir)) {
        if (!/\.(txt|story)$/i.test(f)) continue;
        const text = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = parseStory(text, NAME2ID);
        const id = parsed.title || f.replace(/\.(txt|story)$/i, "");
        STORIES[id] = parsed;
      }
    } catch { /* geen stories-map = alleen het demo-verhaal */ }
  }

  async function listSubjects() {
    const ids = Object.keys(STORIES);
    if (ids.length) return ids.map((id) => ({ id }));
    return [{ id: "Demo: Rome -> 2026" }];   // altijd iets te kiezen; valt terug op het ingebouwde demo-verhaal
  }

  const templates = [
    { id: "kaart", name: "Kaart door de tijd", music: ["oriental", "calm"], defaults: {} },
  ];

  // ---- demo-verhaal (idee 1), zodat het type standalone rendert ----
  function demoStory() {
    const med = ["380", "724", "620", "250", "300", "792", "818", "434", "788", "012", "504", "760", "376", "422", "191", "705", "070", "008"];
    const islam = ["504", "012", "788", "434", "818", "682", "368", "364", "760", "376", "422", "724", "795", "860", "762", "586", "051", "031", "398", "400", "275"];
    const belt2026 = ["504", "012", "788", "434", "818", "682", "368", "364", "760", "422", "792", "795", "860", "762", "586", "004", "795", "398", "417", "360", "458", "050", "854", "466", "562", "478", "706", "729", "148", "686"];
    return {
      mapView: [455, 150, 1360, 470],
      groups: {
        rome: med,
        islam: islam,
        belt: belt2026,
      },
      scenes: [
        // fills = IDENTITEIT (wie de mensen zijn); rule = HEERSER (wie regeert, markering eroverheen)
        { year: "117 AD", text: "Rome rules. Become Roman.", fills: { rome: COL.red }, rule: { rome: COL.red }, dur: 2.6 },
        { year: "750 AD", text: "Islam spreads, by choice", fills: { islam: COL.orange }, rule: { islam: COL.orange }, dur: 2.8 },
        { year: "1700", text: "Europe rules. The faith stays.", fills: { belt: COL.orange }, rule: { belt: COL.ruler }, dur: 3.0 },
        { year: "2026", text: "From Morocco to Indonesia: still ours", fills: { belt: COL.orange }, rule: {}, dur: 2.8 },
      ],
    };
  }

  async function makeKaartRender({ subjectId, opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    // gekozen verhaal uit de studio (subjectId) -> anders het ingebouwde demo-verhaal
    const picked = (subjectId && STORIES[subjectId] && STORIES[subjectId].scenes.length) ? STORIES[subjectId] : null;
    const dem = demoStory();
    const story = {
      mapView: opts.mapView || (picked && picked.mapView) || dem.mapView,
      groups: opts.groups || (picked && picked.groups) || dem.groups,
      scenes: opts.scenes || (picked && picked.scenes) || dem.scenes,
    };
    const title = opts.title || (picked && picked.title) || "They never conquered our faith";
    // scene-tijden
    const durs = story.scenes.map((s) => Number(s.dur) || 2.6);
    const mapEnd = durs.reduce((a, b) => a + b, 0);      // kaart speelt tot hier
    const CTA_DUR = 2.8;                                  // daarna de CTA-fold-out erover
    const total = mapEnd + CTA_DUR;
    const starts = []; let acc = 0; for (const d of durs) { starts.push(acc); acc += d; }
    const TRANS = 0.7; // morph-duur aan het eind van elke scene

    // kaart-venster -> beeld (de camera). availW/availH/bandTop staan vast;
    // de view kan per scene verschillen en east soepel in -> echte zoom.
    const bandTop = H * 0.20, bandBot = H * 0.78;
    const availW = W * 0.92, availH = bandBot - bandTop;
    function cameraFor(view) {
      const sc = Math.min(availW / view[2], availH / view[3]);
      const dW = view[2] * sc, dH = view[3] * sc;
      return { sc, offX: (W - dW) / 2 - view[0] * sc, offY: bandTop + (availH - dH) / 2 - view[1] * sc };
    }
    // basis-view: opts.region ("sea") of opts.mapView (bbox), anders het verhaal zijn mapView.
    const baseView = resolveView(opts.region) || resolveView(opts.mapView) || resolveView(story.mapView) || dem.mapView;
    // per scene: eigen view (regionaam of bbox) of de basis. Camera east tussen scene-views.
    const sceneViews = story.scenes.map((s) => resolveView(s.view) || baseView);

    // land -> kleur in een laag (fills=identiteit, rule=heerser) in een gegeven scene
    function layerColor(scene, id, key) {
      let c = null;
      for (const [grp, col] of Object.entries(scene[key] || {})) {
        const ids = story.groups[grp] || [];
        if (ids.includes(id)) c = col;
      }
      return c;
    }

    function sceneIndexAt(t) {
      for (let i = story.scenes.length - 1; i >= 0; i--) if (t >= starts[i]) return i;
      return 0;
    }
    function sceneAt(frame) {
      const tRaw = frame / FPS;
      // kaart bevriest op het eind; de CTA speelt daarna eroverheen
      const t = Math.min(mapEnd - 0.001, tRaw);
      const i = sceneIndexAt(t);
      const next = Math.min(story.scenes.length - 1, i + 1);
      const endOfI = starts[i] + durs[i];
      let blend = 0;
      if (next !== i && t > endOfI - TRANS) blend = sm((t - (endOfI - TRANS)) / TRANS);

      // camera voor dit frame: east van scene i naar scene next (zoom volgt de morph)
      const view = interpView(sceneViews[i], sceneViews[next], blend);
      const { sc: scale, offX, offY } = cameraFor(view);
      const strokeRuler = (3.4 / scale).toFixed(2); // ~3.4px rand op scherm, los van zoom

      // kaart tekenen: LAAG 1 = identiteit (vulling)
      let paths = "", rulerPaths = "";
      if (MAP) {
        for (const [id, d] of Object.entries(MAP.countries)) {
          const ca = layerColor(story.scenes[i], id, "fills");
          const cb = layerColor(story.scenes[next], id, "fills");
          let fill;
          if (ca == null && cb == null) fill = COL.land;
          else { const from = ca || COL.land, to = cb || COL.land; fill = blend > 0 ? lerpCol(from, to, blend) : from; }
          paths += `<path d="${d}" fill="${fill}" stroke="${COL.landEdge}" stroke-width="0.6"/>`;
          // LAAG 2 = heerser (markering eroverheen): dikke gekleurde rand, fade met blend
          const ra = layerColor(story.scenes[i], id, "rule");
          const rb = layerColor(story.scenes[next], id, "rule");
          const oA = ra ? 1 : 0, oB = rb ? 1 : 0;
          const rop = oA + (oB - oA) * blend;
          if (rop > 0.02) {
            const rc = ra || rb || COL.ruler;
            // koele waas over het gebied (oranje blijft eronder zichtbaar) + dikke rand
            rulerPaths += `<path d="${d}" fill="${rc}" fill-opacity="${(0.42 * rop).toFixed(2)}" stroke="${rc}" stroke-width="${strokeRuler}" stroke-opacity="${(0.9 * rop).toFixed(2)}" stroke-linejoin="round"/>`;
          }
        }
      } else {
        paths = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${COL.cream}" font-family="${SANS}" font-size="20">kaart-asset ontbreekt</text>`;
      }
      const mapG = `<g transform="translate(${offX.toFixed(2)} ${offY.toFixed(2)}) scale(${scale.toFixed(4)})">${paths}${rulerPaths}</g>`;

      // tijdbalk onderaan (loopt over de kaart-fase; vol tijdens CTA)
      const tbY = H * 0.80, tbX = W * 0.1, tbW = W * 0.8;
      const prog = clamp01(t / mapEnd);
      let bar = `<rect x="${tbX}" y="${tbY}" width="${tbW}" height="6" rx="3" fill="${COL.navy2}"/>`
        + `<rect x="${tbX}" y="${tbY}" width="${(tbW * prog).toFixed(1)}" height="6" rx="3" fill="${COL.orange}"/>`
        + `<circle cx="${(tbX + tbW * prog).toFixed(1)}" cy="${tbY + 3}" r="8" fill="${COL.orange}"/>`;
      const showIdx = blend > 0.5 ? next : i;
      bar += `<text x="${W / 2}" y="${tbY - 14}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.06)}" fill="${COL.cream}">${escapeXml(story.scenes[showIdx].year)}</text>`;

      const capTxt = story.scenes[showIdx].text || "";
      const capOp = clamp01((t - starts[showIdx]) / 0.5);

      // CTA-laag vouwt in tijdens de laatste fase (na mapEnd); tijdbalk + onderschrift faden weg
      const ctaOp = tRaw > mapEnd ? clamp01((tRaw - mapEnd) / 0.5) : 0;
      const fade = (1 - ctaOp).toFixed(2);

      // titel: verschijnt bij de opening als statement, faadt dan weg zodat de kaart ademruimte krijgt
      let titleOp = clamp01(t / 0.4);
      if (t > 2.8) titleOp = clamp01((3.4 - t) / 0.6);
      titleOp *= (1 - ctaOp);

      const inner = mapG + `<g opacity="${fade}">${bar}</g>`;
      const ovl = kader(W, H) + titel(title, W, H, titleOp) + onderschrift(capTxt, W, H, capOp * (1 - ctaOp)) + ctaFoldout(W, H, ctaOp);
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay: ovl, logoUri: "" });
    }
    // GEEN hook-first: bij een kaart-door-de-tijd is de reis naar het eind de payoff,
    // die geef je niet weg aan het begin. (De hook-machine in de kern blijft dus uit.)
    return { W, H, FPS, SS, durSec: total, sceneAt };
  }

  async function makeRender({ subjectId, opts = {}, format = "9:16" }) {
    const type = opts.type || opts.template || "kaart";
    switch (type) {
      case "kaart": return makeKaartRender({ subjectId, opts, format });
      default: return makeKaartRender({ subjectId, opts, format });
    }
  }

  return {
    id: "ummaunited", name: "Umma United", branding, init, listSubjects, templates, makeRender,
    options: ["type", "title", "durationSec", "mapView", "groups", "scenes"],
  };
}
