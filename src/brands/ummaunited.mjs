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
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { composeChrome, FORMATS, escapeXml } from "../core/renderer.mjs";
const execFileP = promisify(execFile);
const _require = createRequire(import.meta.url);
// pad naar de resvg-module, zodat de worker 'm zeker kan laden (niet afhankelijk van eval-require).
function resvgModulePath() { try { return _require.resolve("@resvg/resvg-js"); } catch { return "@resvg/resvg-js"; } }

// Worker-pool die SVG-strings parallel naar PNG-bestanden rastert (resvg), over meerdere cores.
// Elke worker laadt resvg zelf (CJS require, werkt in een worker-thread). .run(jobs) verdeelt de
// jobs over de workers en wacht tot alles klaar is. .destroy() sluit ze af.
const RASTER_WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
let Resvg;
try { const m = require(workerData.resvgPath); Resvg = m.Resvg || (m.default && m.default.Resvg) || m.default || m; } catch (e) { parentPort.postMessage({ fatal: String(e && e.message || e) }); }
const width = workerData.width;
parentPort.on("message", (job) => {
  if (job === null) { process.exit(0); return; }
  try {
    const r = new Resvg(job.svg, { fitTo: { mode: "width", value: width } });
    fs.writeFileSync(job.path, r.render().asPng());
    parentPort.postMessage({ i: job.i });
  } catch (e) { parentPort.postMessage({ i: job.i, err: String(e && e.message || e) }); }
});
`;
function makeRasterPool(size, width) {
  const resvgPath = resvgModulePath();
  const workers = [];
  for (let k = 0; k < size; k++) {
    const w = new Worker(RASTER_WORKER_SRC, { eval: true, workerData: { width, resvgPath } });
    w.on("error", () => {});
    workers.push({ w, busy: false });
  }
  async function run(jobs, onProgress) {
    return new Promise((resolve, reject) => {
      let next = 0, done = 0; const total = jobs.length;
      if (!total) return resolve();
      let failed = null;
      const feed = (slot) => {
        if (next >= total) { return; }
        const job = jobs[next++]; slot.busy = true;
        slot.w.postMessage({ i: job._i, svg: job.svg, path: job.path });
      };
      workers.forEach((slot) => {
        slot.w.removeAllListeners("message");
        slot.w.on("message", (msg) => {
          if (msg && msg.fatal) { failed = msg.fatal; return reject(new Error(msg.fatal)); }
          if (msg && msg.err) { failed = msg.err; }
          done++; if (onProgress) onProgress(done);
          if (done >= total) return resolve();
          feed(slot);
        });
      });
      jobs.forEach((j, idx) => { j._i = idx; });
      // start: geef elke worker één job
      for (const slot of workers) { if (next < total) feed(slot); }
    });
  }
  function destroy() { for (const s of workers) { try { s.w.postMessage(null); } catch {} try { s.w.terminate(); } catch {} } }
  return { size, run, destroy };
}

// FFmpeg-pad bepalen. Op Mo's laptop staat "ffmpeg" NIET los op het PATH (spawn ENOENT), maar de
// kern gebruikt hem wel — vrijwel zeker via het npm-pakket ffmpeg-static (gebundelde binary).
// We proberen: FFMPEG_PATH env -> ffmpeg-static -> kaal "ffmpeg" (laatste redmiddel).
let _FFMPEG = null;
async function ffmpegPath() {
  if (_FFMPEG) return _FFMPEG;
  if (process.env.FFMPEG_PATH) { _FFMPEG = process.env.FFMPEG_PATH; return _FFMPEG; }
  try {
    const mod = await import("ffmpeg-static");
    const p = mod.default || mod;
    if (p && typeof p === "string") { _FFMPEG = p; return _FFMPEG; }
  } catch {}
  _FFMPEG = "ffmpeg";   // fallback; faalt dit met ENOENT dan loggen we dat luid
  return _FFMPEG;
}

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

// Beeld inladen als data-URI (jpg/png/webp), met cache. Zodat resvg het in de SVG kan tekenen.
// Faalt netjes (lege string) als het bestand ontbreekt.
const _imgCache = new Map();
async function loadImageURI(absPath) {
  if (_imgCache.has(absPath)) return _imgCache.get(absPath);
  let uri = "";
  try {
    const buf = await fs.readFile(absPath);
    const ext = absPath.toLowerCase().split(".").pop();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    uri = `data:${mime};base64,${buf.toString("base64")}`;
  } catch { uri = ""; }
  _imgCache.set(absPath, uri);
  return uri;
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
        else if (key === "img") { sc.img = val; }                   // foto-achtergrond: bestandsnaam in assets/ummaunited/video/ (of /beeld/)
        else if (key === "vid") { sc.vid = val; }                   // video-achtergrond: bestandsnaam in assets/ummaunited/video/
        else if (key === "caption") { sc.caption = val; }           // de VOLLE gesproken zin -> ondertitel die meeloopt met de stem
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
  // BOVENIN (de onderrand is voor de meelopende ondertitel, zodat die twee nooit botsen).
  const fs2 = fitFs(txt, Math.round(W * 0.05), W * 0.80, 0.56), y = Math.round(H * 0.235);
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
    name: "Umma United", footer: "",   // GEEN footer-tekst onderaan (logo staat rechtsboven)
    bg: COL.ink, bg2: COL.navy2, gold: COL.orange, cream: COL.cream, plate: COL.navy,
  };
  let MAP = null;        // { viewBox:[x,y,w,h], countries:{id:path}, names:{id:name} }
  let NAME2ID = {};      // landnaam(lowercase) -> isoId, uit de kaart-asset
  let STORIES = {};      // verhaal-id (titel/bestandsnaam) -> geparseerd verhaal
  let LOGO_URI = "";     // het echte ronde embleem (assets/ummaunited/brand/logo.png) als data-URI

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
    // het echte logo inladen (data-URI), voor de chrome i.p.v. platte tekst
    LOGO_URI = await loadImageURI(path.resolve(ROOT, "assets/ummaunited/brand/logo.png"));
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

  // -- TECHNIEK: mythe. GEEN lelijke rode streep meer. De beschuldiging verschijnt stevig, blijft
  // even staan, en LOST DAN OP: de woorden drijven licht uiteen en vervagen (alsof de leugen geen
  // grond heeft en uit elkaar valt). Daaronder RIJST de waarheid op in warm oranje. Stijlvol,
  // volwassen, past bij een serieus statement.
  function techMythe({ W, H, p, scene }) {
    const claim = scene.text || "";               // de leugen/beschuldiging
    const truth = scene.truth || scene.kick || ""; // wat er echt is
    let g = bgField(W, H, (claim.length * 13) % 89);
    const fsC = fitFs(claim, Math.round(W * 0.082), W * 0.84, 0.56);
    const cy = truth ? H * 0.38 : H * 0.46;

    // fasen: verschijnen 0..0.28, vasthouden 0.28..0.5, oplossen 0.5..0.82
    const appear = clamp01(p / 0.28);
    const dissolve = clamp01((p - 0.5) / 0.32);
    const d = sm(dissolve);
    // de claim per woord laten uiteendrijven: elk woord schuift iets naar buiten + omhoog en vervaagt
    const words = claim.split(/\s+/).filter(Boolean);
    const claimOp = appear * (1 - d);
    if (claimOp > 0.01) {
      // tijdens oplossen: letter-spacing groeit, hele regel drijft iets omhoog, opacity zakt
      const drift = -d * H * 0.03;
      const spacing = (d * fsC * 0.18).toFixed(1);
      const blurOp = claimOp.toFixed(2);
      g += `<text x="${W / 2}" y="${(cy + drift).toFixed(0)}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fsC}" letter-spacing="${spacing}" fill="${COL.cream}" opacity="${blurOp}">${escapeXml(claim)}</text>`;
      // subtiele "echo" die verder uiteen drijft (geeft het uiteenvallen diepte), alleen tijdens oplossen
      if (d > 0.05) {
        const drift2 = -d * H * 0.06;
        const sp2 = (d * fsC * 0.4).toFixed(1);
        g += `<text x="${W / 2}" y="${(cy + drift2).toFixed(0)}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fsC}" letter-spacing="${sp2}" fill="${COL.cream}" opacity="${(claimOp * 0.4).toFixed(2)}">${escapeXml(claim)}</text>`;
      }
    }
    // de waarheid rijst op (0.58..1): vanaf iets lager naar z'n plek, vervaagt in
    if (truth) {
      const tp = clamp01((p - 0.58) / 0.4);
      const te = sm(tp);
      const ty = H * 0.56 + (1 - te) * H * 0.04;
      const fsT = fitFs(truth, Math.round(W * 0.072), W * 0.84, 0.56);
      g += `<g opacity="${te.toFixed(2)}"><text x="${W / 2}" y="${ty.toFixed(0)}" text-anchor="middle" font-family="${SERIF}" font-weight="800" font-size="${fsT}" fill="${COL.orange}">${escapeXml(truth)}</text></g>`;
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
    // GEEN onderschrift meer: de meelopende ondertiteling onderaan is de enige tekst (geen dubbel).
    return g;
  }

  // -- TECHNIEK: beeld (historische foto op de achtergrond + langzame zoom "Ken Burns" +
  // donkere gradient onderaan zodat de tekst leesbaar is + de kernzin eroverheen). scene.imgURI
  // wordt vooraf ingeladen (zie makeComposedRender). Geen beeld -> valt terug op het sterrenveld.
  function techBeeld({ W, H, p, scene }) {
    const uri = scene.imgURI || "";
    let g;
    if (uri) {
      // Ken Burns: langzaam inzoomen (1.08 -> 1.00) + lichte pan, zodat het beeld leeft.
      const z = 1.14 - 0.12 * sm(p);
      const iw = W * z, ih = H * z;
      const ox = (W - iw) / 2 - (W * 0.03) * (0.5 - p);   // subtiele pan
      const oy = (H - ih) / 2;
      g = `<image href="${uri}" x="${ox.toFixed(1)}" y="${oy.toFixed(1)}" width="${iw.toFixed(1)}" height="${ih.toFixed(1)}" preserveAspectRatio="xMidYMid slice"/>`;
      // donkere wasem over het geheel + sterkere gradient onderaan voor de tekst
      g += `<rect width="${W}" height="${H}" fill="${COL.ink}" opacity="0.28"/>`;
      g += `<defs><linearGradient id="bshade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.45" stop-color="${COL.ink}" stop-opacity="0"/><stop offset="1" stop-color="${COL.ink}" stop-opacity="0.92"/></linearGradient></defs>`;
      g += `<rect width="${W}" height="${H}" fill="url(#bshade)"/>`;
    } else {
      g = bgField(W, H, 23);
    }
    // GEEN losse kernzin meer op beeld-scènes: de enige tekst is de meelopende ondertiteling
    // onderaan (die loopt gelijk met de stem). Een tweede regel bovenin zou dubbelop zijn.
    // Alleen de kicker (bv. "PART 2") blijft als los accent toegestaan.
    if (scene.kick) {
      const ko = clamp01((p - 0.4) / 0.3);
      g += `<text x="${W / 2}" y="${H * 0.20}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.05)}" letter-spacing="3" fill="${COL.orange}" opacity="${ko.toFixed(2)}">${escapeXml(scene.kick.toUpperCase())}</text>`;
    }
    return g;
  }

  // -- CHROME: het logo-embleem KLEIN RECHTSBOVEN (geen merknaam-tekst erbij). Discreet watermerk.
  function logoChrome(W, H) {
    const sz = Math.round(W * 0.11);
    const x = W - sz - Math.round(W * 0.065);   // rechterhoek, binnen het kader
    const y = Math.round(H * 0.045);
    if (!LOGO_URI) {
      // fallback: alleen "UU" in een cirkel als het logo-bestand ontbreekt (geen lange wordmark)
      return `<circle cx="${x + sz / 2}" cy="${y + sz / 2}" r="${sz / 2}" fill="none" stroke="${COL.orange}" stroke-width="2"/>`
        + `<text x="${x + sz / 2}" y="${y + sz * 0.64}" text-anchor="middle" font-family="${SERIF}" font-weight="800" font-size="${Math.round(sz * 0.44)}" fill="${COL.orange}">UU</text>`;
    }
    return `<image href="${LOGO_URI}" x="${x}" y="${y}" width="${sz}" height="${sz}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  // -- ONDERTITEL: de VOLLE gesproken zin onderaan, woord-voor-woord mee met de scène (karaoke-
  // stijl). Op een donkere balk zodat het altijd leesbaar is, ongeacht het beeld eronder.
  function ondertitelMee(caption, W, H, p) {
    const txt = String(caption || "").trim();
    if (!txt) return "";
    const words = txt.split(/\s+/);
    const fs = Math.round(W * 0.044), lh = fs * 1.3;
    // Breedte-fit: schat tekenbreedte (~0.56*fs per teken) en vul regels tot ~86% van W.
    const maxLineW = W * 0.86, charW = fs * 0.56;
    const lines = []; let cur = [];
    const lineWidth = (arr) => arr.join(" ").length * charW;
    for (const w of words) {
      if (cur.length && lineWidth([...cur, w]) > maxLineW) { lines.push(cur); cur = [w]; }
      else cur.push(w);
    }
    if (cur.length) lines.push(cur);
    // Toon maximaal een venster van 3 regels rond de "actieve" regel (anders wordt het een muur tekst).
    const activeIdx = Math.min(words.length - 1, Math.floor(clamp01(p) * words.length));
    // bepaal in welke regel het actieve woord zit
    let acc = 0, activeLine = 0;
    for (let li = 0; li < lines.length; li++) { if (activeIdx < acc + lines[li].length) { activeLine = li; break; } acc += lines[li].length; }
    const WIN = 3;
    let from = Math.max(0, activeLine - 1);
    let to = Math.min(lines.length, from + WIN);
    from = Math.max(0, to - WIN);
    const shown = lines.slice(from, to);
    const totalH = shown.length * lh;
    const yTop = H * 0.885 - totalH;
    let g = `<rect x="${W * 0.05}" y="${(yTop - fs * 0.8).toFixed(0)}" width="${W * 0.90}" height="${(totalH + fs * 1.0).toFixed(0)}" rx="${fs * 0.55}" fill="#000000" opacity="0.6"/>`;
    // globale woord-index bij begin van de getoonde regels
    let wi = 0; for (let li = 0; li < from; li++) wi += lines[li].length;
    shown.forEach((ln, li) => {
      const y = yTop + li * lh + fs;
      let tspans = "";
      ln.forEach((w) => {
        const on = wi <= activeIdx;
        tspans += `<tspan fill="${on ? COL.cream : COL.mute}" fill-opacity="${on ? 1 : 0.5}">${escapeXml(w)}</tspan><tspan> </tspan>`;
        wi++;
      });
      g += `<text x="${W / 2}" y="${y.toFixed(0)}" text-anchor="middle" xml:space="preserve" font-family="${SANS}" font-weight="700" font-size="${fs}">${tspans}</text>`;
    });
    return g;
  }

  // -- OUTRO: korte missie-regel onder de CTA (alleen de laatste scène). Vertelt in 1 adem waar
  // Umma United voor staat, zodat de allereerste video het kanaal meteen plaatst.
  function missieRegel(W, H, op) {
    if (op <= 0.01) return "";
    const l1 = "UMMA UNITED";
    const l2 = "Our history. Our pride. Our present.";
    const fs1 = Math.round(W * 0.052), fs2 = Math.round(W * 0.040);
    const y = H * 0.135;
    return `<g opacity="${op.toFixed(2)}">`
      + `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-weight="800" font-size="${fs1}" letter-spacing="3" fill="${COL.orange}">${l1}</text>`
      + `<text x="${W / 2}" y="${(y + fs1 * 1.15).toFixed(0)}" text-anchor="middle" font-family="${SANS}" font-weight="600" font-size="${fs2}" fill="${COL.cream}">${escapeXml(l2)}</text>`
      + `</g>`;
  }

  // -- PER-ZIN-ONDERTITEL uit _timeline.json (de gedeelde tijdlijn die de editor opslaat). Zo is
  // de render EXACT gelijk aan wat Mo in de editor ziet: de juiste zin op zijn gemeten tijd, i.p.v.
  // de hele alinea uitgesmeerd over de scène. Terugval op het oude caption-gedrag als er geen
  // tijdlijn is (bestand ontbreekt of een scène staat er niet in) -> nooit een regressie.
  async function loadSceneSents(scenes) {
    try {
      const vp = (scenes.find((s) => s && s.voice) || {}).voice || "";
      const m = vp.replace(/\\/g, "/").match(/voice\/([^/]+)\/([^/]+)\//);
      if (!m) return null;
      const p = path.resolve(ROOT, "assets/ummaunited/voice", m[1], m[2], "_timeline.json");
      const tl = JSON.parse(await fs.readFile(p, "utf8"));
      if (!tl || !Array.isArray(tl.scenes)) return null;
      return scenes.map((s, i) => {
        const ts = tl.scenes[i] || tl.scenes.find((x) => x.scene === i + 1);
        return ts && Array.isArray(ts.sentences) && ts.sentences.length ? ts.sentences : null;
      });
    } catch { return null; }
  }
  // de actieve zin op een tijdstip binnen de scène (seconden): de laatst-begonnen zin, zodat de
  // ondertitel doorloopt tot de volgende begint (geen knippergaten). null -> geen tijdlijn, val terug.
  function activeSentText(sents, localTime) {
    if (!sents || !sents.length) return null;
    let cur = sents[0];
    for (const se of sents) { if (localTime >= se.start) cur = se; else break; }
    return cur ? cur.text : null;
  }
  // de beeld-beats per scène uit dezelfde tijdlijn (start/dur + img/vid). Hiermee wisselt het beeld
  // BINNEN een scène op de beat-grenzen, precies zoals de editor toont. null -> geen tijdlijn.
  async function loadSceneBeats(scenes) {
    try {
      const vp = (scenes.find((s) => s && s.voice) || {}).voice || "";
      const m = vp.replace(/\\/g, "/").match(/voice\/([^/]+)\/([^/]+)\//);
      if (!m) return null;
      const p = path.resolve(ROOT, "assets/ummaunited/voice", m[1], m[2], "_timeline.json");
      const tl = JSON.parse(await fs.readFile(p, "utf8"));
      if (!tl || !Array.isArray(tl.scenes)) return null;
      return scenes.map((s, i) => {
        const ts = tl.scenes[i] || tl.scenes.find((x) => x.scene === i + 1);
        return ts && Array.isArray(ts.beats) ? ts.beats : null;
      });
    } catch { return null; }
  }
  // muziek-per-blok + effecten-per-moment uit dezelfde tijdlijn. music = [{start,end,file}],
  // sfxByIndex[i] = [{t,file}] per scène. null -> geen tijdlijn (val terug op het oude gedrag).
  async function loadTimelineAudio(scenes) {
    try {
      const vp = (scenes.find((s) => s && s.voice) || {}).voice || "";
      const m = vp.replace(/\\/g, "/").match(/voice\/([^/]+)\/([^/]+)\//);
      if (!m) return null;
      const p = path.resolve(ROOT, "assets/ummaunited/voice", m[1], m[2], "_timeline.json");
      const tl = JSON.parse(await fs.readFile(p, "utf8"));
      if (!tl || !Array.isArray(tl.scenes)) return null;
      const music = Array.isArray(tl.music) ? tl.music.filter((b) => b && b.file) : [];
      const sfxByIndex = scenes.map((s, i) => {
        const ts = tl.scenes[i] || tl.scenes.find((x) => x.scene === i + 1);
        return ts && Array.isArray(ts.sfx) ? ts.sfx.filter((x) => x && x.file) : [];
      });
      return { music, sfxByIndex };
    } catch { return null; }
  }

  // techniek-register: naam -> fn
  const TECHS = { statement: techStatement, mythe: techMythe, kaart: techKaart, beeld: techBeeld };

  // COMPOSITIE-render: scènes met gemengde technieken -> één video.
  async function makeComposedRender({ subjectId, opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24;
    const picked = (subjectId && STORIES[subjectId] && STORIES[subjectId].scenes.length) ? STORIES[subjectId] : null;
    const scenes = opts.scenes || (picked && picked.scenes) || [];
    const groups = opts.groups || (picked && picked.groups) || {};
    const title = opts.title || (picked && picked.title) || "Umma United";

    // duur per scène: stem stuurt (wav-lengte + marge), anders dur of 3s.
    // VOICE_PAD = ADEMPAUZE na de stem binnen elke scène: na de laatste zin loopt alleen de
    // muziek nog ~0.9s door voordat de volgende scène begint. Zo is het niet bam-bam-bam maar
    // krijgt de kijker lucht om het beeld en de zin te laten landen.
    const VOICE_PAD = 0.9;
    const durs = [];
    for (const s of scenes) {
      let d = Number(s.dur) || 3.0;
      if (s && s.voice) { const wl = await wavDuration(path.resolve(ROOT, s.voice)); if (wl > 0) d = wl + VOICE_PAD; }
      durs.push(d);
      if (s && s.img) { s.imgURI = await loadImageURI(path.resolve(ROOT, "assets/ummaunited/beeld", s.img)); }
    }
    const starts = []; let acc = 0; for (const d of durs) { starts.push(acc); acc += d; }
    const total = acc;

    // ondertitel-bron: de gedeelde tijdlijn (per-zin-tijden). subAt kiest de juiste zin op tijd,
    // of valt terug op de hele caption als er geen tijdlijn is.
    const sentsByIndex = await loadSceneSents(scenes);
    const subAt = (i, p) => { const tx = sentsByIndex && activeSentText(sentsByIndex[i], p * durs[i]); return tx != null ? ondertitelMee(tx, W, H, 1) : ondertitelMee(scenes[i].caption, W, H, p); };

    // De CHROME-overlay van een scène (kader, logo, ondertitel, flits, CTA/missie). Los van de
    // achtergrond, zodat we dezelfde overlay OVER een video kunnen leggen (video-modus) of over
    // de techniek-SVG (gewone modus). Geeft de overlay-SVG-string terug.
    function sceneOverlay(i, p) {
      const s = scenes[i];
      const isFirst = i === 0, isLast = i === scenes.length - 1;
      const showLogo = isFirst;
      const ctaOp = isLast ? clamp01((p - 0.55) / 0.3) : 0;
      const flashDur = 0.12;
      const flashOp = 0; // witte flits uit: de zachte in/uit-fade in de render vervangt 'm
      const flash = flashOp > 0.01 ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${COL.cream}" opacity="${flashOp.toFixed(2)}"/>` : "";
      const ctaOpen = ctaOp > 0.01;
      return flash + kader(W, H)
        + (showLogo ? logoChrome(W, H) : "")
        + (ctaOpen ? "" : subAt(i, p))
        + (ctaOpen ? ctaFoldout(W, H, ctaOp) + missieRegel(W, H, ctaOp) : "");
    }

    // voor kaart-scènes binnen de compositie: we laten die één-scène als mini-kaart lopen.
    function sceneAt(frame) {
      const t = frame / FPS;
      let i = 0; for (let k = scenes.length - 1; k >= 0; k--) if (t >= starts[k]) { i = k; break; }
      const s = scenes[i];
      const p = clamp01((t - starts[i]) / Math.max(0.1, durs[i]));
      const techName = s.tech || "statement";
      const fn = TECHS[techName] || techStatement;
      const inner = fn({ W, H, p, scene: s, groups });
      const ovl = sceneOverlay(i, p);
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay: ovl, logoUri: "" });
    }

    // audio: stem (BOVEN de muziek) + SFX per scène op het startmoment.
    // voiceGain 1.6 default zodat het gesprokene duidelijk boven de achtergrondmuziek uitkomt.
    const tracks = [];
    scenes.forEach((s, i) => {
      if (s && s.voice) tracks.push({ file: path.resolve(ROOT, s.voice), atSec: starts[i], gain: s.voiceGain == null ? 1.6 : s.voiceGain });
      if (s && s.sfx) tracks.push({ file: path.resolve(ROOT, s.sfx), atSec: starts[i], gain: s.sfxGain == null ? 0.5 : s.sfxGain });
    });

    // MUZIEK — STRIKT GESCHEIDEN van Tale of Tiles. Umma leest UITSLUITEND uit zijn eigen map
    // assets/ummaunited/muziek/ (nooit uit assets/audio/, waar Tale of Tiles zit). Zo kan onze
    // muziek nooit in een Tale of Tiles-filmpje belanden, en andersom ook niet.
    // Kies de LANGSTE track, zodat de muziek niet korter is dan de video (anders kapt -shortest af).
    let music = opts.music ? path.resolve(ROOT, "assets/ummaunited/muziek", opts.music) : await pickUmmaMusic(total);
    return { W, H, FPS, SS, durSec: total, sceneAt, music, audio: tracks.length ? { tracks } : undefined };
  }

  // ====================================================================================
  // VIDEO-COMPOSITIE: scènes met VIDEO (of foto) als achtergrond + de SVG-chrome eroverheen.
  // Bouwt zelf de volledige mp4 met ffmpeg en geeft { prebuilt, cleanup } terug (de kern
  // gebruikt die direct, zie engine runOne). Raakt de gedeelde renderer NIET aan.
  // Rastert SVG met @resvg/resvg-js (dezelfde dep die de kern al gebruikt).
  // ====================================================================================
  async function makeComposedVideoRender({ subjectId, opts = {}, format = "9:16", log }) {
    const say = (m) => { try { if (log) log(m); else console.log(m); } catch {} };
    const FFMPEG = await ffmpegPath();       // echte ffmpeg-binary (niet kaal "ffmpeg" op PATH)
    const ff = (args) => execFileP(FFMPEG, args);
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const FPS = 24, SS = 2;                 // SS2 -> 1080x1920
    const OW = W * SS, OH = H * SS;
    const picked = (subjectId && STORIES[subjectId] && STORIES[subjectId].scenes.length) ? STORIES[subjectId] : null;
    const scenes = opts.scenes || (picked && picked.scenes) || [];
    const groups = opts.groups || (picked && picked.groups) || {};

    // resvg laden (zoals de kern gebruikt). Robuust voor zowel ESM- als CJS-vorm: de class kan
    // onder .Resvg, .default.Resvg of direct op de module zitten, afhankelijk van de versie.
    // Faalt het echt, dan val terug op de gewone (SVG-only) render — MAAR we loggen de reden luid,
    // zodat we niet stilletjes op zwarte schermen eindigen.
    let Resvg;
    try {
      const mod = await import("@resvg/resvg-js");
      Resvg = mod.Resvg || (mod.default && mod.default.Resvg) || mod.default || mod;
      if (typeof Resvg !== "function") throw new Error("Resvg-class niet gevonden in @resvg/resvg-js (vorm: " + Object.keys(mod).join(",") + ")");
    } catch (e) {
      (log ? log : console.log)("video-render kan @resvg/resvg-js niet laden -> terug naar tekst-render: " + (e && e.message || e));
      return null;
    }
    // test de rasterizer met een mini-SVG; faalt dat, dan weten we het NU i.p.v. halverwege.
    const rasterize = (svg) => {
      const r = new Resvg(svg, { fitTo: { mode: "width", value: OW } });
      return r.render().asPng();
    };
    try { rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#000"/></svg>`); }
    catch (e) {
      (log ? log : console.log)("video-render: resvg rastert niet -> terug naar tekst-render: " + (e && e.message || e));
      return null;
    }

    // PARALLELLE RASTERING over ALLE CPU-cores (zoals de kern). Een worker-pool rastert de SVG-
    // frames tegelijk i.p.v. één voor één -> ~N keer sneller zonder kwaliteitsverlies (exact
    // hetzelfde beeld). Faalt de pool (bv. worker kan resvg niet laden), dan val ik netjes terug
    // op sequentieel rasteren in deze thread, zodat het altijd blijft werken.
    // ALLE cores MIN ÉÉN: laat altijd 1 core vrij voor de rest van Mo's systeem (anders loopt de
    // laptop vol en kan hij niks anders meer doen). Op een 6-core machine -> 5 workers.
    const NCORES = Math.max(1, (os.cpus() ? os.cpus().length : 2) - 1);
    let pool = null;
    try { pool = makeRasterPool(Math.min(NCORES, 8), OW); } catch { pool = null; }
    say(pool ? `rasteren over ${pool.size} core(s)` : `rasteren op 1 core`);
    // rastert een lijst {svg, path} parallel (pool) of sequentieel (fallback); roept onProgress(done).
    // Faalt de pool (bv. worker kan resvg niet laden), dan val ik NIET terug op zwarte schermen maar
    // doe ik het sequentieel in deze thread -> trager maar correct. De pool wordt dan uitgezet.
    async function rasterizeFrames(jobs, onProgress) {
      if (pool) {
        try { await pool.run(jobs, onProgress); return; }
        catch (e) { say("parallelle rastering faalde (" + (e && e.message || e) + ") -> sequentieel"); try { pool.destroy(); } catch {} pool = null; }
      }
      let done = 0;
      for (const j of jobs) { await fs.writeFile(j.path, rasterize(j.svg)); done++; if (onProgress) onProgress(done); }
    }

    // duur per scène (stem stuurt, + adempauze), en media vooraf resolven.
    const VOICE_PAD = 0.9;
    const durs = [];
    for (const s of scenes) {
      let d = Number(s.dur) || 3.0;
      if (s && s.voice) { const wl = await wavDuration(path.resolve(ROOT, s.voice)); if (wl > 0) d = wl + VOICE_PAD; }
      durs.push(d);
    }
    const starts = []; let acc = 0; for (const d of durs) { starts.push(acc); acc += d; }
    const total = acc;

    // ondertitel-bron: de gedeelde tijdlijn (per-zin-tijden), gelijk aan de editor.
    const sentsByIndex = await loadSceneSents(scenes);
    const subAt = (i, p) => { const tx = sentsByIndex && activeSentText(sentsByIndex[i], p * durs[i]); return tx != null ? ondertitelMee(tx, W, H, 1) : ondertitelMee(scenes[i].caption, W, H, p); };
    // beeld-beats uit dezelfde tijdlijn -> per beat een eigen achtergrond binnen de scène.
    const beatsByIndex = await loadSceneBeats(scenes);
    // muziek-per-blok + effecten-per-moment uit dezelfde tijdlijn.
    const tlAudio = await loadTimelineAudio(scenes);
    // media-pad oplossen: een volledig pad (met /) valt onder ROOT, anders onder de video-map.
    const resolveMedia = (x) => !x ? "" : (String(x).includes("/") ? path.resolve(ROOT, x) : path.resolve(ROOT, "assets/ummaunited/video", x));
    const resolveAudio = (x) => !x ? "" : path.resolve(ROOT, x);

    // overlay-chrome per scène (zelfde logica als sceneOverlay in de SVG-render).
    function overlaySVG(i, p) {
      const s = scenes[i];
      const isFirst = i === 0, isLast = i === scenes.length - 1;
      const ctaOp = isLast ? clamp01((p - 0.55) / 0.3) : 0;
      const flashDur = 0.12;
      const flashOp = 0; // witte flits uit: de zachte in/uit-fade in de render vervangt 'm
      const flash = flashOp > 0.01 ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${COL.cream}" opacity="${flashOp.toFixed(2)}"/>` : "";
      const ctaOpen = ctaOp > 0.01;
      const body = flash + kader(W, H)
        + (isFirst ? logoChrome(W, H) : "")
        + (ctaOpen ? "" : subAt(i, p))
        + (ctaOpen ? ctaFoldout(W, H, ctaOp) + missieRegel(W, H, ctaOp) : "");
      // transparante SVG (geen achtergrond-rect) zodat de video/techniek eronder doorschijnt
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
    }
    // volledige scène-SVG (mét techniek-achtergrond) voor scènes zonder video/foto (kaart/statement/mythe)
    function fullSceneSVG(i, p) {
      const s = scenes[i];
      const fn = TECHS[s.tech || "statement"] || techStatement;
      const inner = fn({ W, H, p, scene: s, groups });
      const ovl = overlayBody(i, p);
      return composeChrome({ branding, W, H, panel: null, innerField: inner, overlay: ovl, logoUri: "" });
    }
    function overlayBody(i, p) {
      const s = scenes[i];
      const isFirst = i === 0, isLast = i === scenes.length - 1;
      const ctaOp = isLast ? clamp01((p - 0.55) / 0.3) : 0;
      const flashDur = 0.12;
      const flashOp = 0; // witte flits uit: de zachte in/uit-fade in de render vervangt 'm
      const flash = flashOp > 0.01 ? `<rect x="0" y="0" width="${W}" height="${H}" fill="${COL.cream}" opacity="${flashOp.toFixed(2)}"/>` : "";
      const ctaOpen = ctaOp > 0.01;
      return flash + kader(W, H)
        + (isFirst ? logoChrome(W, H) : "")
        + (ctaOpen ? "" : subAt(i, p))
        + (ctaOpen ? ctaFoldout(W, H, ctaOp) + missieRegel(W, H, ctaOp) : "");
    }

    say(`video-render gestart: ${scenes.length} scènes, ${total.toFixed(1)}s`);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "umma-vid-"));
    const sceneClips = [];
    try {
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const dur = durs[i];
        const sdir = path.join(work, `s${i}`);
        await fs.mkdir(sdir, { recursive: true });

        // SEGMENTEN: per beeld-beat een eigen achtergrond (video/foto/techniek). Het beeld wisselt
        // zo BINNEN de scène op de beat-grenzen, precies zoals de editor toont. De ondertitel en de
        // audio blijven op tijd (p loopt continu door de scène). Geen beats of geen media-beats ->
        // één segment = de hele scène (oud gedrag, geen regressie).
        const beats = (beatsByIndex && beatsByIndex[i]) || null;
        let segs;
        if (beats && beats.length && beats.some((b) => b.vid || b.img)) {
          const edges = [0];
          for (let k = 1; k < beats.length; k++) edges.push(Math.min(dur, Math.max(0, Number(beats[k].start) || 0)));
          edges.push(dur);
          segs = beats.map((b, k) => ({ b, start: edges[k], end: edges[k + 1] }));
        } else {
          segs = [{ b: { vid: s.vid, img: s.img }, start: 0, end: dur }];
        }

        const onProg = () => {};
        let segIdx = 0;
        for (const seg of segs) {
          const segDur = +(seg.end - seg.start).toFixed(3);
          if (segDur <= 0.03) { segIdx++; continue; }
          const nF = Math.max(1, Math.round(segDur * FPS));
          // ZACHTE OVERGANG: scène-randen vloeien wat langer in/uit (FD); tussen beeldblokken BINNEN
          // een scène een kórte zachte dip (BD) i.p.v. een harde cut, zodat het beeld niet van scherm
          // naar scherm knalt. De dip zit alleen op de beeld-laag; de chrome en audio lopen door, en
          // de ondertitel-timing blijft exact (elke beat houdt z'n eigen lengte). Te korte beats
          // (< ~0.6s) slaan de extra dip over, anders zou het blok bijna helemaal donker zijn.
          const FD = 0.22, BD = 0.14;
          const canDip = segDur > 0.6;
          const fo = Math.max(0, segDur - FD).toFixed(2);
          const foB = Math.max(0, segDur - BD).toFixed(2);
          const vf = [];
          if (segIdx === 0) vf.push(`fade=t=in:st=0:d=${FD}`);
          else if (canDip) vf.push(`fade=t=in:st=0:d=${BD}`);
          if (segIdx === segs.length - 1) vf.push(`fade=t=out:st=${fo}:d=${FD}`);
          else if (canDip) vf.push(`fade=t=out:st=${foB}:d=${BD}`);
          const fadeChain = vf.length ? "," + vf.join(",") : "";
          const fadeVf = vf.join(",");
          const vidFile = resolveMedia(seg.b.vid);
          const imgFile = resolveMedia(seg.b.img);
          const hasVid = vidFile && await exists(vidFile);
          const hasImg = !hasVid && imgFile && await exists(imgFile);
          const segdir = path.join(sdir, `g${segIdx}`);
          await fs.mkdir(segdir, { recursive: true });
          const bron = hasVid ? `video ${path.basename(vidFile)}` : hasImg ? `foto ${path.basename(imgFile)}` : `getekend (${s.tech || "statement"})`;
          say(`  scène ${i + 1}/${scenes.length} beat ${segIdx + 1}/${segs.length}: ${bron}, ${segDur.toFixed(1)}s`);
          const clip = path.join(work, `clip${i}_${segIdx}.mp4`);
          // p loopt CONTINU over de hele scène (seg.start + f/FPS)/dur, zodat de ondertitel de juiste
          // zin op tijd toont en de flits/CTA op de scène-grenzen vallen, niet op beat-grenzen.
          if (hasVid || hasImg) {
            const jobs = [];
            for (let f = 0; f < nF; f++) {
              const p = clamp01((seg.start + f / FPS) / dur);
              jobs.push({ svg: overlaySVG(i, p), path: path.join(segdir, `o${String(f).padStart(4, "0")}.png`) });
            }
            await rasterizeFrames(jobs, onProg);
            if (hasVid) {
              // video schalen+croppen tot 9:16, iets donkerder. -stream_loop -1 LOOPT de bron zodat
              // hij ALTIJD de volle beat-duur vult, ook als het bestand korter is. De PNG-overlay
              // (shortest) bepaalt de harde beat-lengte.
              await ff(["-y", "-stream_loop", "-1", "-i", vidFile,
                "-framerate", String(FPS), "-i", path.join(segdir, "o%04d.png"),
                "-filter_complex",
                `[0:v]scale=${OW}:${OH}:force_original_aspect_ratio=increase,crop=${OW}:${OH},eq=brightness=-0.10:saturation=1.05,fps=${FPS}[bg];[bg][1:v]overlay=0:0:format=auto:shortest=1${fadeChain}[v]`,
                "-map", "[v]", "-r", String(FPS), "-t", segDur.toFixed(2), "-pix_fmt", "yuv420p", "-an", clip]);
            } else {
              // foto: langzame Ken Burns zoom + overlay
              const zf = Math.max(1, Math.round(segDur * FPS));
              await ff(["-y", "-loop", "1", "-t", segDur.toFixed(2), "-i", imgFile,
                "-framerate", String(FPS), "-i", path.join(segdir, "o%04d.png"),
                "-filter_complex",
                `[0:v]scale=${OW * 1.15}:${OH * 1.15}:force_original_aspect_ratio=increase,crop=${OW}:${OH},zoompan=z='min(zoom+0.0006,1.12)':d=${zf}:s=${OW}x${OH}:fps=${FPS},eq=brightness=-0.08[bg];[bg][1:v]overlay=0:0:format=auto:shortest=1${fadeChain}[v]`,
                "-map", "[v]", "-r", String(FPS), "-t", segDur.toFixed(2), "-pix_fmt", "yuv420p", "-an", clip]);
            }
          } else {
            // getekende beat: volledige scène-SVG (techniek + chrome) per frame -> clip
            const jobs = [];
            for (let f = 0; f < nF; f++) {
              const p = clamp01((seg.start + f / FPS) / dur);
              jobs.push({ svg: fullSceneSVG(i, p), path: path.join(segdir, `f${String(f).padStart(4, "0")}.png`) });
            }
            await rasterizeFrames(jobs, onProg);
            await ff(["-y", "-framerate", String(FPS), "-i", path.join(segdir, "f%04d.png"),
              ...(fadeVf ? ["-vf", fadeVf] : []),
              "-r", String(FPS), "-t", segDur.toFixed(2), "-pix_fmt", "yuv420p", clip]);
          }
          sceneClips.push(clip);
          segIdx++;
        }
      }

      // scène-clips aan elkaar (concat demuxer)
      say(`  scènes samenvoegen...`);
      const listFile = path.join(work, "list.txt");
      await fs.writeFile(listFile, sceneClips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      const silent = path.join(work, "silent.mp4");
      await ff(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", silent]);

      // AUDIO. Twee fouten uit de vorige versie opgelost:
      //  1) amix DEELT de som door het aantal sporen (gemiddelde) -> alles werd veel te zacht
      //     (-37 dB). Nu amix met normalize=0 (optellen i.p.v. middelen), zodat de stem op volle
      //     sterkte blijft; daarna loudnorm over het geheel naar uitzend-niveau (-16 LUFS) zodat
      //     de hele video lekker luid en consistent klinkt.
      //  2) De STEM is de ster: die mengen we los op vol niveau; muziek is een ZACHTE bodem eronder;
      //     SFX kort op de kantels. Zo komt de spreker duidelijk boven de muziek uit.
      say(`  audio mixen (stem boven, muziek zacht eronder, dan loudnorm)...`);
      const inputs = ["-i", silent];
      const aFilters = [];
      const aFiltersPush = (x) => aFilters.push(x);
      let idx = 1; // 0 = de stille video
      const voiceLabels = [], bedLabels = [];
      // MUZIEK: per blok (uit de tijdlijn) met overvloei op de blok-grenzen (afade in/out), zachte
      // bodem. Geen tijdlijn-muziek -> terugval op één doorlopende track (oud gedrag).
      const blocks = (tlAudio && tlAudio.music && tlAudio.music.length) ? tlAudio.music : null;
      if (blocks) {
        for (const b of blocks) {
          const bf = resolveAudio(b.file); if (!(bf && await exists(bf))) continue;
          const bdur = Math.max(0.5, (Number(b.end) || 0) - (Number(b.start) || 0));
          const ms = Math.round((Number(b.start) || 0) * 1000);
          const fo = Math.max(0, bdur - 0.6).toFixed(2);
          inputs.push("-stream_loop", "-1", "-i", bf);
          aFiltersPush(`[${idx}:a]atrim=0:${bdur.toFixed(2)},volume=0.32,afade=t=in:st=0:d=0.6,afade=t=out:st=${fo}:d=0.6,adelay=${ms}|${ms}[m${idx}]`);
          bedLabels.push(`[m${idx}]`); idx++;
        }
      } else {
        const music = opts.music ? path.resolve(ROOT, "assets/ummaunited/muziek", opts.music) : await pickUmmaMusic(total);
        if (music && await exists(music)) {
          inputs.push("-stream_loop", "-1", "-i", music);
          aFiltersPush(`[${idx}:a]volume=0.35,atrim=0:${total.toFixed(2)}[m]`); bedLabels.push("[m]"); idx++;
        }
      }
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        if (s && s.voice) { const vf = path.resolve(ROOT, s.voice); if (await exists(vf)) {
          inputs.push("-i", vf);
          aFiltersPush(`[${idx}:a]adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)}[v${i}]`); voiceLabels.push(`[v${i}]`); idx++;
        }}
        // SFX: op hun moment (scène-start + t) uit de tijdlijn; anders de oude enkele s.sfx.
        const sfxList = (tlAudio && tlAudio.sfxByIndex && tlAudio.sfxByIndex[i]) || (s && s.sfx ? [{ t: 0, file: s.sfx }] : []);
        for (const fx of sfxList) {
          const xf = resolveAudio(fx.file); if (!(xf && await exists(xf))) continue;
          const at = Math.round((starts[i] + (Number(fx.t) || 0)) * 1000);
          inputs.push("-i", xf);
          aFiltersPush(`[${idx}:a]adelay=${at}|${at},volume=0.6[x${idx}]`); bedLabels.push(`[x${idx}]`); idx++;
        }
      }
      const out = path.join(work, "final.mp4");
      const allLabels = [...voiceLabels, ...bedLabels];
      if (allLabels.length) {
        // optellen (normalize=0), dan hard begrenzen tegen klippen, dan loudnorm naar -16 LUFS
        const mix = `${allLabels.join("")}amix=inputs=${allLabels.length}:duration=longest:normalize=0:dropout_transition=0[sum];[sum]alimiter=limit=0.95,loudnorm=I=-16:TP=-1.5:LRA=11,atrim=0:${total.toFixed(2)}[a]`;
        await ff(["-y", ...inputs,
          "-filter_complex", [...aFilters, mix].join(";"),
          "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
      } else {
        await fs.copyFile(silent, out);
      }
      say(`video-render klaar (${total.toFixed(1)}s).`);
      if (pool) try { pool.destroy(); } catch {}
      return { prebuilt: out, cleanup: work, W, H, FPS, SS, durSec: total };
    } catch (e) {
      if (pool) try { pool.destroy(); } catch {}
      try { await fs.rm(work, { recursive: true, force: true }); } catch {}
      throw e;
    }
  }

  async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

  // Kies uit assets/ummaunited/muziek/ de langste track (>= videolengte als dat kan).
  async function pickUmmaMusic(minSec = 0) {
    const dir = path.resolve(ROOT, "assets/ummaunited/muziek");
    let files = [];
    try { files = (await fs.readdir(dir)).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)); } catch { return ""; }
    if (!files.length) return "";
    // sorteer op bestandsgrootte (proxy voor lengte): grootste eerst -> langste track
    const withSize = [];
    for (const f of files) { try { const st = await fs.stat(path.join(dir, f)); withSize.push([f, st.size]); } catch {} }
    withSize.sort((a, b) => b[1] - a[1]);
    return withSize.length ? path.resolve(dir, withSize[0][0]) : "";
  }

  async function makeRender({ subjectId, opts = {}, format = "9:16", log }) {
    let type = opts.type || opts.template || "kaart";
    // AUTOMATISCH: als het gekozen verhaal (of opts) scènes met een `tech`-veld bevat, gebruik
    // de compositie — zo hoeft de studio geen aparte "mix"-keuze te hebben; Importeer + Render volstaat.
    const picked = subjectId && STORIES[subjectId] ? STORIES[subjectId] : null;
    const sc = opts.scenes || (picked && picked.scenes) || [];
    if (type === "kaart" && sc.some((s) => s && s.tech)) type = "mix";
    // Heeft ook maar één scène OF beeld-beat VIDEO/foto? Dan de video-compositie (ffmpeg, prebuilt).
    // Faalt resvg-js daar (null), val terug op de gewone SVG-render. We kijken ook naar de beats in
    // _timeline.json, want daar zet de beeld-tool het beeld per beat neer.
    let beatMedia = false;
    try { const bb = await loadSceneBeats(sc); beatMedia = !!(bb && bb.some((arr) => arr && arr.some((b) => b && (b.vid || b.img)))); } catch {}
    const hasMedia = sc.some((s) => s && (s.vid || s.img)) || beatMedia;
    if ((type === "mix" || type === "composed") && hasMedia) {
      try {
        const r = await makeComposedVideoRender({ subjectId, opts, format, log });
        if (r) return r;
      } catch (e) { if (log) log("video-render faalde, val terug op tekst-render: " + (e && e.message || e)); }
    }
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
