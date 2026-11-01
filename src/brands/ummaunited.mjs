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

// WAV-lengte (seconden) uit de header — geen ffprobe nodig. Faalt netjes (0).
async function wavDuration(absPath) {
  try {
    const fh = await fs.open(absPath, "r");
    try {
      const buf = Buffer.alloc(44);
      await fh.read(buf, 0, 44, 0);
      if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
      const byteRate = buf.readUInt32LE(28);
      const { size } = await fh.stat();
      const dataBytes = size - 44;
      return (byteRate > 0 && dataBytes > 0) ? dataBytes / byteRate : 0;
    } finally { await fh.close(); }
  } catch { return 0; }
}

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
        else if (key === "voice") { sc.voice = val; }
        else if (key === "sfx") { sc.sfx = val; }
        else if (key === "voicegain") { const g = parseFloat(val); if (g >= 0) sc.voiceGain = g; }
        else if (key === "sfxgain") { const g = parseFloat(val); if (g >= 0) sc.sfxGain = g; }
        else if (key === "tech") { sc.tech = val.toLowerCase(); }   // welke techniek beeldt deze scène uit
        else if (key === "truth") { sc.truth = val; }               // mythe-techniek: de waarheid onder de leugen
        else if (key === "kick") { sc.kick = val; }                 // kleine onderregel/kicker
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
    { id: "mix", name: "Gemengd (kaart + statement + mythe)", music: ["oriental", "calm"], defaults: {} },
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
    // scene-tijden: heeft een scène een stem? dan loopt de duur mee met de wav-lengte.
    const VOICE_PAD = 0.5;
    const durs = [];
    for (const s of story.scenes) {
      let d = Number(s.dur) || 2.6;
      if (s && s.voice) { const wl = await wavDuration(path.resolve(ROOT, s.voice)); if (wl > 0) d = wl + VOICE_PAD; }
      durs.push(d);
    }
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

    // --- beweging (stap 2): per land een lengtegraad-proxy voor de VEEG-overgangen ---
    const xById = {};
    if (MAP) for (const [id, d] of Object.entries(MAP.countries)) { const m = /M\s*(-?\d+(?:\.\d+)?)/.exec(d); xById[id] = m ? parseFloat(m[1]) : 1000; }
    const SWEEP = 0.9, STAGGER = 0.55;                 // veeg-duur + hoeveel links eerder gaat dan rechts
    const reveal = (p, frac) => sm(clamp01(p * (1 + STAGGER) - frac * STAGGER)); // links->rechts onthullen
    // lichte doorlopende push zodat het beeld nooit doodstil staat
    const pushView = (v, f) => { const cx = v[0] + v[2] / 2, cy = v[1] + v[3] / 2, w = v[2] * (1 - f), h = v[3] * (1 - f); return [cx - w / 2, cy - h / 2, w, h]; };

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

      // camera voor dit frame: east van scene i naar scene next + lichte doorlopende push
      const drift = 0.045 * sm(clamp01(t / mapEnd));
      const view = pushView(interpView(sceneViews[i], sceneViews[next], blend), drift);
      const { sc: scale, offX, offY } = cameraFor(view);
      const strokeRuler = (3.4 / scale).toFixed(2); // ~3.4px rand op scherm, los van zoom
      const prevI = Math.max(0, i - 1);
      const pIn = (t - starts[i]) / SWEEP;  // scene-entree-voortgang voor de veeg

      // kaart tekenen: LAAG 1 = identiteit (vulling), LAAG 2 = heerser (waas) — beide vegen in/uit
      let paths = "", rulerPaths = "";
      if (MAP) {
        for (const [id, d] of Object.entries(MAP.countries)) {
          const frac = clamp01((xById[id] - view[0]) / view[2]); // links=0, rechts=1 binnen het beeld
          // -- identiteit --
          const fi = layerColor(story.scenes[i], id, "fills");
          const fp = i > 0 ? layerColor(story.scenes[prevI], id, "fills") : null;
          const fn = layerColor(story.scenes[next], id, "fills");
          let fill;
          if (fi) fill = fp ? fi : lerpCol(COL.land, fi, reveal(pIn, frac)); // nieuw? veeg in vanuit land
          else fill = COL.land;
          if (blend > 0 && fn !== fi) fill = lerpCol(fi || COL.land, fn || COL.land, reveal(blend, frac));
          paths += `<path d="${d}" fill="${fill}" stroke="${COL.landEdge}" stroke-width="0.6"/>`;
          // -- heerser (waas eroverheen) --
          const ri = layerColor(story.scenes[i], id, "rule");
          const rp = i > 0 ? layerColor(story.scenes[prevI], id, "rule") : null;
          const rn = layerColor(story.scenes[next], id, "rule");
          let rop = 0, rc = COL.ruler;
          if (ri) { rc = ri; rop = rp ? 1 : reveal(pIn, frac); }       // nieuw? veeg in
          if (blend > 0) {
            if (ri && !rn) rop *= (1 - reveal(blend, frac));            // vertrekt? veeg uit
            else if (!ri && rn) { rc = rn; rop = Math.max(rop, reveal(blend, frac)); }
          }
          if (rop > 0.02) {
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
      const sStart = starts[showIdx], sEnd = sStart + durs[showIdx];
      // jaartal schuift net omhoog + crossfade in plaats van hard poppen
      const yIn = clamp01((t - sStart) / 0.35), ySlide = ((1 - sm(yIn)) * 12).toFixed(1);
      bar += `<g opacity="${yIn.toFixed(2)}" transform="translate(0 ${ySlide})"><text x="${W / 2}" y="${tbY - 14}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.06)}" fill="${COL.cream}">${escapeXml(story.scenes[showIdx].year)}</text></g>`;

      const capTxt = story.scenes[showIdx].text || "";
      // onderschrift faadt in EN uit (niet alleen in), zodat scènes niet hakkerig wisselen
      const capOp = clamp01((t - sStart) / 0.4) * clamp01((sEnd - t) / 0.35);

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
    // AUDIO (stap 3): per scène een optioneel stem- en/of SFX-spoor, op het startmoment van de scène.
    // De kern legt deze via de audio-overlay over de muziekbodem (alleen als er sporen zijn).
    const tracks = [];
    story.scenes.forEach((s, i) => {
      if (s && s.voice) tracks.push({ file: path.resolve(ROOT, s.voice), atSec: starts[i], gain: s.voiceGain == null ? 1.0 : s.voiceGain });
      if (s && s.sfx) tracks.push({ file: path.resolve(ROOT, s.sfx), atSec: starts[i], gain: s.sfxGain == null ? 0.8 : s.sfxGain });
    });

    // GEEN hook-first: bij een kaart-door-de-tijd is de reis naar het eind de payoff,
    // die geef je niet weg aan het begin. (De hook-machine in de kern blijft dus uit.)
    return { W, H, FPS, SS, durSec: total, sceneAt, audio: tracks.length ? { tracks } : undefined };
  }

  // ================================================================
  // SCÈNE-COMPOSITIE: een filmpje mengt technieken. Elke scène kiest een `tech`; de compositie
  // rendert ze achter elkaar op één tijdlijn (één sceneAt, resvg-veilig, raakt de kern niet).
  // Elke techniek = fn({W,H,p,scene,sub}) -> SVG-laag. p = voortgang 0..1 binnen de scène.
  // sub = hulpstukken (word-reveal, kader, sterrenveld) zodat technieken ze delen.
  // ================================================================

  // -- word-voor-woord reveal (overgenomen/herschreven uit Tale of Tiles' wordsReveal, Umma-stijl) --
  // Woord-voor-woord reveal via één gecentreerde <text> met <tspan> per woord: de renderer doet
  // de spatiëring (betrouwbaar, geen eigen breedte-schatting), de opacity per woord doet de reveal.
  function wordReveal(txt, cx, y, fs, fill, p) {
    const words = String(txt).split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    const per = 1 / words.length;
    let spans = "";
    words.forEach((w, i) => {
      const o = clamp01((p - i * per) / (per * 0.9));
      // spatie vóór elk woord behalve het eerste, als eigen tspan met em-breedte (renderers
      // strippen leidende spaties binnen tspans; een dx-spatie is betrouwbaar).
      if (i) spans += `<tspan dx="${(fs * 0.3).toFixed(1)}"> </tspan>`;
      spans += `<tspan fill="${fill}" fill-opacity="${o.toFixed(2)}">${escapeXml(w)}</tspan>`;
    });
    return `<text x="${cx}" y="${y}" text-anchor="middle" xml:space="preserve" font-family="${SERIF}" font-weight="800" font-size="${fs}">${spans}</text>`;
  }
  // -- rustig sterrenveld (merk-achtergrond, deterministisch) --
  function starfield(W, H, seed = 7) {
    let s = seed, out = "";
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, y = rnd() * H, r = 0.6 + rnd() * 1.8, o = 0.15 + rnd() * 0.5;
      out += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${COL.cream}" opacity="${o.toFixed(2)}"/>`;
    }
    return out;
  }
  const bgField = (W, H, seed) => `<rect width="${W}" height="${H}" fill="${COL.ink}"/>`
    + `<rect width="${W}" height="${H}" fill="${COL.navy}" opacity="0.5"/>` + starfield(W, H, seed);

  // -- TECHNIEK: statement (grote woord-voor-woord kernzin, merk-achtergrond) --
  function techStatement({ W, H, p, scene }) {
    const txt = scene.text || "";
    const fs = fitFs(txt, Math.round(W * 0.11), W * 0.80, 0.56);
    let g = bgField(W, H, (txt.length * 7) % 97);
    // zachte oranje gloed achter de tekst
    g += `<ellipse cx="${W / 2}" cy="${H * 0.46}" rx="${W * 0.44}" ry="${H * 0.14}" fill="${COL.orange}" opacity="${(0.10 * sm(p)).toFixed(2)}"/>`;
    g += wordReveal(txt, W / 2, H * 0.48, fs, COL.cream, p);
    // kicker onder de zin (scene.kick), rustig
    if (scene.kick) {
      const ko = clamp01((p - 0.5) / 0.3);
      g += `<text x="${W / 2}" y="${H * 0.60}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.045)}" letter-spacing="2" fill="${COL.orange}" opacity="${ko.toFixed(2)}">${escapeXml(scene.kick.toUpperCase())}</text>`;
    }
    return g;
  }

  // -- TECHNIEK: mythe (de beschuldiging verschijnt -> wordt doorgestreept -> waarheid eronder) --
  function techMythe({ W, H, p, scene }) {
    const claim = scene.text || "";               // de leugen/beschuldiging
    const truth = scene.truth || scene.kick || ""; // wat er echt is
    let g = bgField(W, H, (claim.length * 13) % 89);
    const fsC = fitFs(claim, Math.round(W * 0.085), W * 0.82, 0.56);
    const cy = truth ? H * 0.40 : H * 0.48;
    // claim verschijnt (0..0.4), streep eroverheen (0.4..0.7)
    const claimOp = clamp01(p / 0.3);
    g += `<text x="${W / 2}" y="${cy}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fsC}" fill="${COL.mute}" opacity="${claimOp.toFixed(2)}">${escapeXml(claim)}</text>`;
    const strike = clamp01((p - 0.35) / 0.3);
    if (strike > 0.01) {
      const halfW = Math.min(W * 0.80, claim.length * fsC * 0.30) * strike;
      g += `<line x1="${(W / 2 - halfW).toFixed(0)}" y1="${(cy - fsC * 0.32).toFixed(0)}" x2="${(W / 2 + halfW).toFixed(0)}" y2="${(cy - fsC * 0.32).toFixed(0)}" stroke="${COL.red}" stroke-width="${Math.round(W * 0.018)}" stroke-linecap="round"/>`;
    }
    // waarheid eronder, woord-voor-woord (0.6..1)
    if (truth) {
      const tp = clamp01((p - 0.6) / 0.4);
      const fsT = fitFs(truth, Math.round(W * 0.075), W * 0.82, 0.56);
      g += wordReveal(truth, W / 2, H * 0.58, fsT, COL.orange, tp);
    }
    return g;
  }

  // -- TECHNIEK: kaart (één scène) — toont de wereldkaart met deze scène z'n fills/rule/view.
  // Hergebruikt de kaart-tekenlogica, maar als los scène-beeld (geen eigen tijdlijn/tijdbalk).
  function techKaart({ W, H, p, scene, groups }) {
    const view = resolveView(scene.view) || REGIONS.belt;
    const bandTop = H * 0.16, bandBot = H * 0.74;
    const availW = W * 0.90, availH = bandBot - bandTop;
    const scale = Math.min(availW / view[2], availH / view[3]);
    const dW = view[2] * scale, dH = view[3] * scale;
    const offX = (W - dW) / 2 - view[0] * scale, offY = bandTop + (availH - dH) / 2 - view[1] * scale;
    const colorOf = (id, key) => {
      for (const [grp, col] of Object.entries(scene[key] || {})) {
        const ids = (groups[grp] || []); if (ids.includes(id)) return resolveColor(col) || col;
      }
      return null;
    };
    let paths = "", rulerPaths = "";
    if (MAP) {
      for (const [id, d] of Object.entries(MAP.countries)) {
        const fi = colorOf(id, "fills");
        const fill = fi ? lerpCol(COL.land, fi, sm(clamp01(p / 0.5))) : COL.land;   // veegt in
        paths += `<path d="${d}" fill="${fill}" stroke="${COL.landEdge}" stroke-width="0.6"/>`;
        const ri = colorOf(id, "rule");
        if (ri) {
          const rop = sm(clamp01(p / 0.5));
          rulerPaths += `<path d="${d}" fill="${ri}" fill-opacity="${(0.42 * rop).toFixed(2)}" stroke="${ri}" stroke-width="${(3.4 / scale).toFixed(2)}" stroke-opacity="${(0.9 * rop).toFixed(2)}" stroke-linejoin="round"/>`;
        }
      }
    }
    let g = `<rect width="${W}" height="${H}" fill="${COL.ink}"/>` + starfield(W, H, 11);
    g += `<g transform="translate(${offX.toFixed(2)} ${offY.toFixed(2)}) scale(${scale.toFixed(4)})">${paths}${rulerPaths}</g>`;
    // onderschrift (de korte zin in beeld)
    g += onderschrift(scene.text || "", W, H, clamp01(p / 0.3) * clamp01((1 - p) / 0.2 + 0.5));
    return g;
  }

  // techniek-register: naam -> fn
  const TECHS = { statement: techStatement, mythe: techMythe, kaart: techKaart };

  // COMPOSITIE-render: scènes met gemengde technieken -> één video.
  async function makeComposedRender({ subjectId, opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const picked = (subjectId && STORIES[subjectId] && STORIES[subjectId].scenes.length) ? STORIES[subjectId] : null;
    const scenes = opts.scenes || (picked && picked.scenes) || [];
    const groups = opts.groups || (picked && picked.groups) || {};
    const title = opts.title || (picked && picked.title) || "Umma United";

    // duur per scène: stem stuurt (wav-lengte + marge), anders dur of 3s.
    const VOICE_PAD = 0.5;
    const durs = [];
    for (const s of scenes) {
      let d = Number(s.dur) || 3.0;
      if (s && s.voice) { const wl = await wavDuration(path.resolve(ROOT, s.voice)); if (wl > 0) d = wl + VOICE_PAD; }
      durs.push(d);
    }
    const starts = []; let acc = 0; for (const d of durs) { starts.push(acc); acc += d; }
    const total = acc;

    // voor kaart-scènes binnen de compositie: we laten die één-scène als mini-kaart lopen.
    // (de volledige kaart-techniek met zijn eigen tijdlijn draaien we hier per scène af.)
    function sceneAt(frame) {
      const t = frame / FPS;
      let i = 0; for (let k = scenes.length - 1; k >= 0; k--) if (t >= starts[k]) { i = k; break; }
      const s = scenes[i];
      const p = clamp01((t - starts[i]) / Math.max(0.1, durs[i]));
      const techName = s.tech || "statement";
      const fn = TECHS[techName] || techStatement;
      const inner = fn({ W, H, p, scene: s, groups });
      // kader + merk op elke scène; CTA-fold-out op de laatste scène
      const isLast = i === scenes.length - 1;
      const ctaOp = isLast ? clamp01((p - 0.55) / 0.3) : 0;
      const ovl = kader(W, H) + (ctaOp > 0.01 ? ctaFoldout(W, H, ctaOp) : "");
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay: ovl, logoUri: "" });
    }

    // audio: stem + SFX per scène op het startmoment
    const tracks = [];
    scenes.forEach((s, i) => {
      if (s && s.voice) tracks.push({ file: path.resolve(ROOT, s.voice), atSec: starts[i], gain: s.voiceGain == null ? 1.0 : s.voiceGain });
      if (s && s.sfx) tracks.push({ file: path.resolve(ROOT, s.sfx), atSec: starts[i], gain: s.sfxGain == null ? 0.8 : s.sfxGain });
    });
    return { W, H, FPS, SS, durSec: total, sceneAt, audio: tracks.length ? { tracks } : undefined };
  }

  async function makeRender({ subjectId, opts = {}, format = "9:16" }) {
    const type = opts.type || opts.template || "kaart";
    switch (type) {
      case "kaart": return makeKaartRender({ subjectId, opts, format });
      case "mix":
      case "composed": return makeComposedRender({ subjectId, opts, format });
      default: return makeKaartRender({ subjectId, opts, format });
    }
  }

  return {
    id: "ummaunited", name: "Umma United", branding, init, listSubjects, templates, makeRender,
    options: ["type", "title", "durationSec", "mapView", "groups", "scenes"],
  };
}
