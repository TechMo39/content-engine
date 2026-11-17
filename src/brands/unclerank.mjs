// MERK-MODULE: UncleRank — data-animatie video's voor het portaal (AnchorRank).
//
// Zelfstandig opgezet: elke frame is een KALE, complete SVG (geen afhankelijkheid van de tegel-
// helpers van Tale of Tiles). De engine rastert sceneAt(frame) -> frames -> mp4, net als bij de
// andere merken. UncleRank verschijnt vanzelf in de Studio-kiezer (registry.mjs voegt hem toe).
//
// Contract dat makeRender teruggeeft, gelijk aan taleoftiles: { W, H, FPS, SS, durSec, sceneAt, music, clicks }.
// sceneAt(frame) -> volledige <svg> string voor dat frame.
//
// Types nu: "roi" (Eén klant betaalt je jaar), "gat" (Het harde cijfer) en "portaal" (schermopname
// van het publieke portaal — de kring). Bron-cijfers komen uit opts of vallen terug op nette
// standaarden; de stem (Engels/Kokoro) en meer types volgen.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FORMATS = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };
const FFMPEG = process.env.FFMPEG || "ffmpeg";

// Draai een sub-proces en stuur elke uitvoer-regel LIVE door naar log() (zoals taleoftiles),
// zodat de voortgang in het app-paneel én de terminal verschijnt.
function runStreamed(node, args, env, log, tag) {
  return new Promise((resolve) => {
    const ch = spawn(node, args, { env, windowsHide: true });
    let buf = "";
    const flush = (d) => {
      buf += d.toString(); let i;
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

// Zorg dat er een UncleRank-logo-png is om op de video te stempelen. finish.mjs valt standaard
// terug op het Tale-of-Tiles-logo; dat willen we hier NIET. Bestaat er een UR-logo, gebruik dat;
// anders genereren we ter plekke een nette UR-wordmark (cyaan op transparant) in de work-map.
function ensureLogo(ROOT, work, opts) {
  const cands = [
    opts && opts.logo,
    path.resolve(ROOT, "assets/unclerank/brand/logo.png"),
    path.resolve(ROOT, "assets/brand/unclerank.png"),
    path.resolve(ROOT, "assets/unclerank/logo.png"),
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  // genereren: wordmark "UncleRank" met ffmpeg drawtext op transparant
  const out = path.join(work, "ur-logo.png");
  const fontCands = [
    path.resolve(ROOT, "assets/fonts/Fraunces-600.ttf"),
    path.resolve(ROOT, "assets/fonts/CormorantGaramond-600.ttf"),
  ];
  let font = ""; for (const f of fontCands) { try { if (fs.existsSync(f)) { font = f; break; } } catch {} }
  const ff = font ? `:fontfile='${font.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
  try {
    const r = spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black@0:s=640x180,format=rgba",
      "-vf", `drawtext=text='UncleRank'${ff}:fontcolor=0x00b8e6:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2,format=rgba`,
      "-frames:v", "1", out], { windowsHide: true });
    if (r.status === 0 && fs.existsSync(out)) return out;
  } catch {}
  return (opts && opts.logo) || "";
}

// Huisstijl van het portaal: donker navy, cyaan accent, groen voor winst.
const C = {
  bg0: "#0a1623", bg1: "#0e2032", ink: "#e8eef5", mut: "#8aa0b5",
  accent: "#00b8e6", accentDark: "#0a5f78", green: "#19c37d", line: "#1d3146",
};

// UncleRank = strakke SANS (niet de Tale-of-Tiles-serif). De sans-font "UR Sans" ligt in
// assets/fonts/ (eigen naam zodat andere merken niks merken); valt netjes terug op system-sans.
const SANS = "'UR Sans', Arial, Helvetica, sans-serif";

// Het echte UR-merk: de UR-mark (favicon, transparant) wordt als data-URI in elke frame gestempeld;
// het uitgeschreven "UncleRank" tekenen we als scherpe vector in de merkkleuren. Één keer geladen.
let MARK_URI = "";
function loadMark(ROOT) {
  if (MARK_URI) return MARK_URI;
  const cands = [
    path.resolve(ROOT, "assets/unclerank/brand/mark.png"),
    path.resolve(ROOT, "assets/unclerank/brand/logo-mark.png"),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) { MARK_URI = "data:image/png;base64," + fs.readFileSync(p).toString("base64"); return MARK_URI; } } catch {}
  }
  return MARK_URI;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
// fade-in over [a,b], vol blijven tot c, fade-out over [c,d]. Ontbrekende c/d = blijft staan.
const win = (t, a, b, c = 1e9, d = 1e9) => {
  if (t < a) return 0;
  if (t < b) return smooth((t - a) / Math.max(0.001, b - a));
  if (t < c) return 1;
  if (t < d) return 1 - smooth((t - c) / Math.max(0.001, d - c));
  return 0;
};
const eur = (n) => "€" + new Intl.NumberFormat("nl-NL").format(Math.round(n));

function bg(W, H) {
  return `<defs><radialGradient id="bg" cx="50%" cy="38%" r="80%">
    <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></radialGradient></defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg)"/>`;
}
// Merk-lockup bovenin: de echte UR-mark + "UncleRank" (Uncle = licht, Rank = cyaan), altijd zichtbaar.
function wordmark(W, H, op = 1) {
  if (op <= 0.001) return "";
  const topY = Math.round(H * 0.072);
  const mk = Math.round(W * 0.075);            // mark-grootte
  const fs = Math.round(W * 0.05);             // woordmerk-tekst
  const gap = Math.round(mk * 0.26);
  const wordEst = fs * 4.9;                     // "UncleRank"-breedte-benadering: ALLEEN om de lockup te centreren
  const totalW = mk + gap + wordEst;
  const x0 = Math.round(W / 2 - totalW / 2);
  const baY = topY + Math.round(fs * 0.36);     // baseline ~ verticaal midden van de mark
  const tx0 = x0 + mk + gap;
  let g = `<g opacity="${op.toFixed(3)}">`;
  if (MARK_URI) g += `<image x="${x0}" y="${topY - Math.round(mk / 2)}" width="${mk}" height="${mk}" href="${MARK_URI}" preserveAspectRatio="xMidYMid meet"/>`;
  // ÉÉN tekst-element met twee tspans = altijd "UncleRank" aaneen (geen gat), kleur-split Uncle/Rank.
  g += `<text x="${tx0}" y="${baY}" font-family="${SANS}" font-size="${fs}" font-weight="800" text-anchor="start"><tspan fill="${C.ink}">Uncle</tspan><tspan fill="${C.accent}">Rank</tspan></text>`;
  g += `</g>`;
  return g;
}
// Alleen de UR-mark, gecentreerd (voor een sober merk-moment, bv. op een slot/CTA).
function markOnly(cx, cy, size, op = 1) {
  if (!MARK_URI || op <= 0.001) return "";
  return `<image x="${Math.round(cx - size / 2)}" y="${Math.round(cy - size / 2)}" width="${size}" height="${size}" href="${MARK_URI}" opacity="${op.toFixed(3)}" preserveAspectRatio="xMidYMid meet"/>`;
}

// ---- AUDIO (hergebruikt Truthward-keten) --------------------------------------------------
// Per type: de momenten (atSec) waarop de voice-over-regels vallen, één wav per regel. De wavs
// maakt tools/ur_voice.py (NL-Chatterbox, willekeurige stem uit voice-test/refs-ur/) in
// assets/unclerank/voice/<type>/NN.wav. De regel-TEKST staat in ur_voice.py; hier alleen de timing,
// zodat beeld en stem op dezelfde beats vallen. Nieuwe types: voeg een beats-rij toe + script in ur_voice.
// Beat-FRACTIES van de totale duur. De echte duur komt van de ingesproken stem (Truthward-stijl:
// video volgt de stem); het beeld verschijnt op deze fracties zodat beeld en stem meelopen.
const UR_BEATS = {
  roi: [0.03, 0.24, 0.45, 0.66, 0.85],   // hook · warm · waarde · kost · ROI+CTA
};
// AFWISSELING: per type meerdere varianten (andere woorden, andere stem-regels, zelfde boodschap +
// timing). De render kiest er willekeurig één (anti-herhaling), zodat beeld én stem per render
// wisselen. Elke variant = de tekst-blokken op het scherm + de bijbehorende stem-regels (zelfde
// volgorde als UR_BEATS). Cijfers blijven structureel (uit opts); alleen de bewoording wisselt.
const UR_VARIANTS = {
  roi: [
    {
      hook: ["Elke maand 40 nieuwe", "bedrijven om te bellen."],
      warm: ["Elk met een mankement", "dat jij kunt fixen."],
      valueLabel: ["wat één nieuwe klant", "je oplevert"],
      roi: ["Eén klant en je maand", "is er zo uit."],
      cta: "Begin gratis — 7 dagen.",
      voice: [
        "Elke maand veertig nieuwe bedrijven om te bellen.",
        "Elk met een mankement dat jij kunt fixen.",
        "Eén nieuwe klant levert je al snel zesduizend euro op.",
        "En jij betaalt maar negenentachtig euro per maand.",
        "Eén klant en je maand is er zo uit, dus begin gratis.",
      ],
    },
    {
      hook: ["40 verse leads,", "elke maand opnieuw."],
      warm: ["Elk bedrijf met een gat", "dat jij kunt dichten."],
      valueLabel: ["zoveel is één", "nieuwe klant waard"],
      roi: ["Eén deal en je zit", "al in de plus."],
      cta: "Pak je gratis week.",
      voice: [
        "Veertig verse leads, elke maand opnieuw.",
        "Elk bedrijf met een gat dat jij kunt dichten.",
        "Zoveel is één nieuwe klant jou al waard, zesduizend euro.",
        "En jij betaalt maar negenentachtig euro per maand.",
        "Eén deal en je zit al in de plus, dus pak je gratis week.",
      ],
    },
  ],
};
const LAST_VARIANT = {};   // anti-herhaling: niet twee keer achter elkaar dezelfde variant
function pickVariant(templateId) {
  const vs = UR_VARIANTS[templateId];
  if (!vs || !vs.length) return 0;
  if (vs.length === 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * vs.length); } while (i === LAST_VARIANT[templateId]);
  LAST_VARIANT[templateId] = i;
  return i;
}
// Laad stem-wavs + muziekbodem additief in het render-object (Truthward: render.music + audio.tracks).
// Raakt de kern NIET: de engine legt render.music onder de video en overlayAudio mixt de stem erover.
function voiceDir(ROOT, templateId, vi) {
  // elke variant z'n eigen stem-map: assets/unclerank/voice/<type>/v<vi>/
  return path.resolve(ROOT, "assets/unclerank/voice", templateId, "v" + vi);
}
function attachAudio(ROOT, templates, templateId, render, vi = 0) {
  // muziekbodem: eigen UR-map (merk-gescheiden), mood = eerste music-tag van het type
  try {
    const tpl = templates.find((t) => t.id === templateId);
    const mood = (tpl && tpl.music && tpl.music[0]) || "calm";
    const mp = path.resolve(ROOT, "assets/unclerank/muziek", "ur-" + mood + ".mp3");
    if (fs.existsSync(mp)) render.music = mp;
  } catch {}
  // stem: ÉÉN doorlopend voice.wav (hele variant in één opname, Truthward-stijl) over de muziek.
  // De stem is in ur_voice.py al LUID genormaliseerd (loudnorm), dus hier gain 1.0 — geen clipping.
  if (UR_BEATS[templateId]) {
    const w = path.join(voiceDir(ROOT, templateId, vi), "voice.wav");
    try { if (fs.existsSync(w)) render.audio = { tracks: [{ file: w, atSec: 0, gain: 1.0 }] }; } catch {}
  }
  return render;
}
function tx(x, y, s, { fs, w = 400, fill = C.ink, op = 1, anchor = "middle", ls = 0 }) {
  if (op <= 0.001) return "";
  return `<text x="${x}" y="${y}" fill="${fill}" opacity="${op.toFixed(3)}" font-family="${SANS}"
    font-size="${fs}" font-weight="${w}" letter-spacing="${ls}" text-anchor="${anchor}">${esc(s)}</text>`;
}
// Een tekst over meerdere regels (handmatig gesplitst), gecentreerd rond y.
function block(x, y, lines, o) {
  const lh = o.fs * 1.18;
  const start = y - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) => tx(x, start + i * lh, l, o)).join("");
}
function root(W, H, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>`;
}

// ---- TYPE: ROI — "Eén klant en 't is terugverdiend" (WAARDE vs kost) -----------------------
function buildRoi({ opts, W, H, variant, durSec }) {
  const FPS = 30, SS = 1;
  const dur = Number(durSec) || Number(opts.durSec) || 16;   // duur volgt de stem (Truthward-stijl)
  const prijs = Number(opts.kostMnd) || 89;          // START-pakket per maand (kost)
  const klantWaarde = Number(opts.klantWaarde) || 6000; // WAT één nieuwe klant OPLEVERT
  const perBedrijf = opts.perBedrijf || "€2,23";     // kost per bedrijf (START)
  const v = variant || UR_VARIANTS.roi[0];           // afwisseling: de gekozen woord-variant
  const b = UR_BEATS.roi.map((f) => f * dur);        // beats op de tijdlijn: [hook,warm,waarde,kost,roi+cta]
  const cx = W / 2, fsHook = Math.round(W * 0.056), fsLbl = Math.round(W * 0.035);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // 1) hook — verschijnt op b[0], weg vóór b[1]
    s += block(cx, H * 0.30, v.hook, { fs: fsHook, w: 800, fill: C.ink, op: win(t, b[0], b[0] + 0.9, b[1] - 0.4, b[1] + 0.2) });
    // 2) warm — b[1]..b[2]
    s += block(cx, H * 0.30, v.warm, { fs: fsHook, w: 700, fill: C.ink, op: win(t, b[1], b[1] + 0.9, b[2] - 0.4, b[2] + 0.2) });
    // 3) DE WAARDE — wat één nieuwe klant OPLEVERT (de hero, groen), blijft vanaf b[2]
    s += tx(cx, H * 0.42, eur(klantWaarde), { fs: Math.round(W * 0.16), w: 800, fill: C.green, op: win(t, b[2], b[2] + 0.8) });
    s += block(cx, H * 0.505, v.valueLabel, { fs: fsLbl, w: 500, fill: C.mut, op: win(t, b[2] + 0.5, b[2] + 1.2) });
    // 4) DE KOST — klein contrast, b[3]
    s += tx(cx, H * 0.64, "Jij betaalt " + eur(prijs) + " per maand", { fs: Math.round(W * 0.052), w: 800, fill: C.ink, op: win(t, b[3], b[3] + 0.7) });
    s += tx(cx, H * 0.695, perBedrijf + " per bedrijf", { fs: fsLbl, w: 500, fill: C.mut, op: win(t, b[3] + 0.4, b[3] + 1.1) });
    // 5) ROI-landing + CTA, b[4]
    s += block(cx, H * 0.82, v.roi, { fs: Math.round(W * 0.044), w: 800, fill: C.green, op: win(t, b[4], b[4] + 0.7) });
    s += tx(cx, H * 0.92, v.cta, { fs: Math.round(W * 0.036), w: 600, fill: C.ink, op: win(t, b[4] + 0.5, b[4] + 1.2) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec: dur, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: GAT — "Het harde cijfer" -------------------------------------------------------
function buildGat({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const volume = Number(opts.volume) || 2900;
  const term = String(opts.term || "koerier");
  const stad = String(opts.stad || "Amsterdam");
  const cx = W / 2, fsBig = Math.round(W * 0.17), fsLbl = Math.round(W * 0.042);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // opbouw: het grote getal, dan de context, dan de klap.
    s += tx(cx, H * 0.42, new Intl.NumberFormat("nl-NL").format(volume), { fs: fsBig, w: 800, fill: "#ffffff", op: win(t, 0.6, 1.8) });
    s += block(cx, H * 0.56, [`people a month search for "${term}"`, `in ${stad}.`],
      { fs: fsLbl, w: 500, fill: C.mut, op: win(t, 1.8, 2.8) });
    // de klap
    const kOp = win(t, 5.0, 6.2);
    if (kOp > 0.001) {
      s += tx(cx, H * 0.70, "This business catches one.", { fs: Math.round(W * 0.055), w: 800, fill: C.accent, op: kOp });
    }
    s += block(cx, H * 0.84, ["The rest go to the competitor.", "You show the owner the number."],
      { fs: Math.round(W * 0.038), w: 600, fill: C.ink, op: win(t, 8.0, 9.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// Kleine motieven voor de nieuwe types (zelfde stijl: navy/cyaan/groen, kale SVG).
function ring(cx, cy, r, op) {
  let g = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.line}" stroke-width="3" opacity="${op.toFixed(3)}"/>`;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.round(r * 0.11)}" fill="${C.accent}" opacity="${op.toFixed(3)}"/>`;
  }
  return g;
}

// ---- TYPE: KRING — "De kring uitgelegd" ----------------------------------------------------
function buildKring({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 17;
  const cx = W / 2, fsH = Math.round(W * 0.06), fsB = Math.round(W * 0.05), fsS = Math.round(W * 0.034);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // 1 hook
    s += block(cx, H * 0.34, ["You only work", "half your market."], { fs: fsH, w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 3.2, 4.0) });
    // 2 de handel
    s += block(cx, H * 0.34, ["Every agency sits on leads", "it can't use itself."], { fs: fsB, w: 700, fill: C.ink, op: win(t, 4.2, 5.2, 7.4, 8.2) });
    // 3 de kring in beeld
    const ringOp = win(t, 8.4, 9.4, 12.6, 13.4);
    if (ringOp > 0.001) s += ring(cx, H * 0.40, Math.round(W * 0.2), ringOp);
    s += block(cx, H * 0.63, ["A closed circle.", "SEO · SEA · web · content · ads."], { fs: fsS, w: 600, fill: C.mut, op: win(t, 9.2, 10.2, 12.6, 13.4) });
    // 4 exclusiviteit
    s += block(cx, H * 0.40, ["Each dossier:", "3 weeks, yours alone."], { fs: fsB, w: 800, fill: C.accent, op: win(t, 13.0, 14.0) });
    // 5 CTA
    s += block(cx, H * 0.87, ["UncleRank — the circle.", "Try a week, free."], { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op: win(t, 15.2, 16.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// WAT WE PER VAKGEBIED METEN. De echte set signalen uit het dossier (meerdere per vak, niet één
// regel). Gedeeld door 'bureaus' (overzicht, cyclus) en 'signalen' (diep op één vak).
const VAK = {
  seo:     { naam: "SEO", sig: ["Ranks on page 4 for its own service", "Most of its searches go to rivals", "A homepage too thin to rank"] },
  sea:     { naam: "SEA", sig: ["No Google Ads running, for months", "No tracking — blind to what works", "A pricey-click market he's not in"] },
  web:     { naam: "Web", sig: ["Loads in 4+ seconds", "Falls apart on mobile", "A dated template build"] },
  content: { naam: "Content", sig: ["No blog, or one that died in 2022", "A homepage under 300 words", "Market questions left unanswered"] },
  reclame: { naam: "Ads & brand", sig: ["Advertises nowhere", "Nearly invisible on social", "A handful of weak reviews"] },
};
const VAK_ORDER = ["seo", "sea", "web", "content", "reclame"];

// ---- TYPE: BUREAUS — "Wat we per vak zien" (cyclus over de 5 vakgebieden) -------------------
function buildBureaus({ opts, W, H }) {
  const FPS = 30, SS = 1;
  const per = 2.6;                                   // tijd per vak op scherm
  const durSec = Number(opts.durSec) || Math.round(2.0 + VAK_ORDER.length * per + 2.5);
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["Five trades.", "For each, what we see."], { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 2.0, 2.6) });
    VAK_ORDER.forEach((k, i) => {
      const a = 2.4 + i * per;
      const op = win(t, a, a + 0.5, a + per - 0.3, a + per + 0.2);
      if (op <= 0.001) return;
      const v = VAK[k];
      s += tx(cx, H * 0.3, v.naam, { fs: Math.round(W * 0.09), w: 800, fill: C.accent, op });
      v.sig.forEach((line, j) => {
        s += tx(cx, H * 0.46 + j * H * 0.09, line, { fs: Math.round(W * 0.038), w: 500, fill: C.ink, op });
      });
    });
    s += tx(cx, H * 0.88, "Each sees only the leads that fit them.", { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 2.4 + VAK_ORDER.length * per + 0.2, 2.4 + VAK_ORDER.length * per + 1.2) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: SIGNALEN — diep op ÉÉN vak (opts.vak = seo/sea/web/content/reclame) --------------
function buildSignalen({ opts, W, H }) {
  const FPS = 30, SS = 1;
  const v = VAK[String(opts.vak || "seo").toLowerCase()] || VAK.seo;
  const durSec = Number(opts.durSec) || Math.round(2.0 + v.sig.length * 1.8 + 4);
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["What we find", "for " + v.naam + "."], { fs: Math.round(W * 0.058), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const y0 = H * 0.38, rh = H * 0.1;
    v.sig.forEach((line, i) => {
      const op = win(t, 2.2 + i * 1.8, 3.0 + i * 1.8);
      if (op <= 0.001) return;
      const y = y0 + i * rh;
      // gecentreerd (geen bullet) zodat lange regels netjes binnen beeld blijven
      s += tx(cx, y, line, { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op });
    });
    const endA = 2.2 + v.sig.length * 1.8 + 0.4;
    s += block(cx, H * 0.78, ["The flaws, already found.", "On every lead."], { fs: Math.round(W * 0.044), w: 800, fill: C.accent, op: win(t, endA, endA + 1.0) });
    s += block(cx, H * 0.92, ["UncleRank — try a week, free."], { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, endA + 1.6, endA + 2.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: ACTUEEL — "Altijd actueel" (dagelijkse verversing) ------------------------------
function buildActueel({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["Yesterday's lead list", "is already stale."], { fs: Math.round(W * 0.055), w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 3.4, 4.2) });
    s += block(cx, H * 0.34, ["We re-check every site,", "every single day."], { fs: Math.round(W * 0.055), w: 800, fill: C.accent, op: win(t, 4.4, 5.4) });
    s += block(cx, H * 0.56, ["So the reason you call", "is today's reason —", "not last month's."], { fs: Math.round(W * 0.044), w: 600, fill: C.ink, op: win(t, 7.4, 8.4) });
    s += tx(cx, H * 0.82, "Fresh dossiers. Current flaws.", { fs: Math.round(W * 0.04), w: 700, fill: C.green, op: win(t, 10.4, 11.2) });
    s += tx(cx, H * 0.9, "UncleRank — the circle.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 11.6, 12.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: EXCLUSIEF — "3 weken exclusief" (schaarste) -------------------------------------
function buildExclusief({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const cx = W / 2, fsBig = Math.round(W * 0.15), fsLbl = Math.round(W * 0.04);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.28, ["A lead you get,", "no one else gets."], { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // het grote "3 weken" met een krimpende balk eronder
    const nOp = win(t, 2.6, 3.6);
    s += tx(cx, H * 0.5, "3 weeks", { fs: fsBig, w: 800, fill: C.accent, op: nOp });
    const barOp = win(t, 3.6, 4.2);
    if (barOp > 0.001) {
      const bw = W * 0.6, bx = cx - bw / 2, by = H * 0.56, bh = H * 0.018;
      const fill = clamp(1 - (t - 4.2) / 6);      // loopt langzaam leeg
      s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${C.line}" opacity="${barOp.toFixed(3)}"/>`;
      s += `<rect x="${bx}" y="${by}" width="${(bw * fill).toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="${C.accent}" opacity="${barOp.toFixed(3)}"/>`;
    }
    s += tx(cx, H * 0.62, "yours alone", { fs: fsLbl, w: 500, fill: C.mut, op: win(t, 4.0, 4.8) });
    s += block(cx, H * 0.76, ["No bidding war.", "No shared inbox."], { fs: Math.round(W * 0.044), w: 700, fill: C.ink, op: win(t, 6.5, 7.5) });
    s += block(cx, H * 0.9, ["UncleRank — the circle."], { fs: Math.round(W * 0.038), w: 600, fill: C.mut, op: win(t, 10.5, 11.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: VOORNA — "Koude outreach vs warme kring" ---------------------------------------
function buildVoorna({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const colW = W * 0.42, lx = W * 0.27, rx = W * 0.73;
  const fsHd = Math.round(W * 0.042), fsLi = Math.round(W * 0.03);
  function column(x, title, lines, color, op, yTop) {
    if (op <= 0.001) return "";
    const bx = x - colW / 2, bh = H * 0.42, by = yTop;
    let g = `<rect x="${bx}" y="${by}" width="${colW}" height="${bh}" rx="18" fill="${color}" opacity="${(op * 0.1).toFixed(3)}"/>`
      + `<rect x="${bx}" y="${by}" width="${colW}" height="${bh}" rx="18" fill="none" stroke="${color}" stroke-width="2.5" opacity="${op.toFixed(3)}"/>`;
    g += tx(x, by + bh * 0.16, title, { fs: fsHd, w: 800, fill: color, op });
    lines.forEach((l, i) => { g += tx(x, by + bh * 0.36 + i * fsLi * 1.5, l, { fs: fsLi, w: 500, fill: C.ink, op }); });
    return g;
  }
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(W / 2, H * 0.2, "Two ways to fill your pipeline.", { fs: Math.round(W * 0.046), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const yTop = H * 0.3;
    s += column(lx, "Cold outreach", ["Lists you bought", "No reason to call", "Ignored, every time"], C.mut, win(t, 2.0, 3.0), yTop);
    s += column(rx, "The circle", ["A real flaw, named", "A reason to call", "3 weeks, yours"], C.accent, win(t, 3.6, 4.6), yTop);
    s += tx(W / 2, H * 0.84, "One of them actually picks up.", { fs: Math.round(W * 0.04), w: 700, fill: C.green, op: win(t, 7.0, 8.0) });
    s += tx(W / 2, H * 0.92, "UncleRank — try a week, free.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 9.5, 10.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: HOEHETWERKT — "Hoe het werkt" (3 stappen) --------------------------------------
function buildHoehetwerkt({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2, fsH = Math.round(W * 0.056), fsN = Math.round(W * 0.06), fsR = Math.round(W * 0.04);
  const steps = [
    ["1", "Pick your trade", "SEO, SEA, web, content or ads."],
    ["2", "Get your list", "Every morning, leads that fit you."],
    ["3", "Call with a reason", "Their flaw, named. Not a cold name."],
  ];
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["No lists.", "No scraping."], { fs: fsH, w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const y0 = H * 0.36, rh = H * 0.16, x0 = W * 0.14;
    steps.forEach((st, i) => {
      const op = win(t, 2.2 + i * 2.0, 3.0 + i * 2.0);
      if (op <= 0.001) return;
      const y = y0 + i * rh;
      s += `<circle cx="${x0}" cy="${y - fsN * 0.3}" r="${Math.round(fsN * 0.62)}" fill="none" stroke="${C.accent}" stroke-width="3" opacity="${op.toFixed(3)}"/>`;
      s += tx(x0, y - fsN * 0.08, st[0], { fs: fsN, w: 800, fill: C.accent, op });
      s += tx(x0 + W * 0.1, y - fsN * 0.18, st[1], { fs: fsR, w: 800, fill: C.ink, op, anchor: "start" });
      s += tx(x0 + W * 0.1, y + fsR * 0.6, st[2], { fs: Math.round(fsR * 0.74), w: 500, fill: C.mut, op, anchor: "start" });
    });
    s += block(cx, H * 0.9, ["UncleRank — try a week, free."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 11.0, 12.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: BEZWAAR — "Is dit niet gewoon een lead-lijst?" ---------------------------------
function buildBezwaar({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["“Isn't this just", "another lead list?”"], { fs: Math.round(W * 0.055), w: 600, fill: C.mut, op: win(t, 0.4, 1.4, 3.6, 4.4) });
    s += tx(cx, H * 0.34, "No.", { fs: Math.round(W * 0.14), w: 800, fill: "#ffffff", op: win(t, 4.6, 5.6) });
    const lines = [
      ["Every lead comes with its flaw.", 7.0],
      ["A reason to call — not a name.", 8.6],
      ["3 weeks, yours alone.", 10.2],
    ];
    lines.forEach((l, i) => {
      s += tx(cx, H * 0.52 + i * H * 0.08, l[0], { fs: Math.round(W * 0.042), w: 700, fill: i === 2 ? C.accent : C.ink, op: win(t, l[1], l[1] + 0.9) });
    });
    s += block(cx, H * 0.88, ["UncleRank — the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 11.8, 12.6) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: MANKEMENT — "Een naam is geen lead" (cyclus van gebreken) -----------------------
function buildMankement({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  const flaws = ["Ranks on page 4.", "No ads in 8 months.", "A template site.", "A blog that died in 2022."];
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.24, ["A name is", "not a lead."], { fs: Math.round(W * 0.062), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // elk gebrek apart in/uit, midden op het scherm
    flaws.forEach((f, i) => {
      const a = 2.6 + i * 1.7;
      s += tx(cx, H * 0.5, f, { fs: Math.round(W * 0.056), w: 800, fill: C.accent, op: win(t, a, a + 0.5, a + 1.1, a + 1.6) });
    });
    s += block(cx, H * 0.72, ["Every one —", "a reason to call."], { fs: Math.round(W * 0.05), w: 800, fill: "#ffffff", op: win(t, 9.8, 10.8) });
    s += block(cx, H * 0.9, ["UncleRank — the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 12.5, 13.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: REKENSOM — "Wat kost een warme lead hier?" -------------------------------------
function buildRekensom({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const kostMnd = Number(opts.kostMnd) || 89;
  const dossiers = Number(opts.dossiers) || 60;
  const per = kostMnd / dossiers;
  const cx = W / 2, fsBig = Math.round(W * 0.1);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.24, ["What does a warm", "lead cost you here?"], { fs: Math.round(W * 0.052), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += tx(cx, H * 0.44, eur(kostMnd) + " / month", { fs: fsBig, w: 800, fill: "#cdd9e6", op: win(t, 2.6, 3.6) });
    s += tx(cx, H * 0.55, "÷ ~" + dossiers + " dossiers a month", { fs: Math.round(W * 0.04), w: 500, fill: C.mut, op: win(t, 4.4, 5.4) });
    s += tx(cx, H * 0.68, "under " + eur(Math.ceil(per)) + " a lead", { fs: Math.round(W * 0.09), w: 800, fill: C.green, op: win(t, 6.6, 7.6) });
    s += block(cx, H * 0.84, ["One call closes.", "The math is already done."], { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op: win(t, 9.4, 10.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: GRATISWEEK — het aanbod / CTA --------------------------------------------------
function buildGratisweek({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 12;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.3, ["A week", "in the circle."], { fs: Math.round(W * 0.08), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += tx(cx, H * 0.5, "Free. No card today.", { fs: Math.round(W * 0.05), w: 700, fill: C.accent, op: win(t, 2.6, 3.6) });
    s += block(cx, H * 0.62, ["See your leads", "before you pay a cent."], { fs: Math.round(W * 0.04), w: 500, fill: C.mut, op: win(t, 4.4, 5.4) });
    // knop
    const bOp = win(t, 6.8, 7.8);
    if (bOp > 0.001) {
      const bw = W * 0.62, bh = H * 0.082, bx = cx - bw / 2, by = H * 0.76;
      s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh * 0.3}" fill="${C.accent}" opacity="${bOp.toFixed(3)}"/>`;
      s += tx(cx, by + bh * 0.66, "Start free →", { fs: Math.round(W * 0.045), w: 800, fill: "#04121c", op: bOp });
    }
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: OMDRAAI — de pivot (scan-tool -> lead-lijst voor bureaus) ----------------------
function buildOmdraai({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.3, ["Most tools tell the owner", "what's wrong with his site."], { fs: Math.round(W * 0.05), w: 600, fill: C.mut, op: win(t, 0.4, 1.4, 3.8, 4.6) });
    s += tx(cx, H * 0.34, "We flipped it.", { fs: Math.round(W * 0.1), w: 800, fill: C.accent, op: win(t, 4.8, 5.8) });
    s += block(cx, H * 0.56, ["Now the agency gets the list:", "who to call, and why."], { fs: Math.round(W * 0.046), w: 700, fill: C.ink, op: win(t, 7.4, 8.4) });
    s += block(cx, H * 0.74, ["Their flaw, already found.", "Your opening line, already written."], { fs: Math.round(W * 0.036), w: 500, fill: C.mut, op: win(t, 10.0, 11.0) });
    s += block(cx, H * 0.9, ["UncleRank — the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 12.6, 13.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: VOLUME — "elke ochtend nieuwe dossiers" (tellende cijfer) -----------------------
function buildVolume({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const target = Number(opts.aantal) || 10;
  const cx = W / 2, fsBig = Math.round(W * 0.2);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(cx, H * 0.3, "Every morning:", { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // het getal telt op van 0 naar target
    const nOp = win(t, 2.0, 2.8);
    if (nOp > 0.001) {
      const n = Math.round(target * smooth(clamp((t - 2.2) / 1.6)));
      s += tx(cx, H * 0.5, String(n), { fs: fsBig, w: 800, fill: "#ffffff", op: nOp });
    }
    s += block(cx, H * 0.62, ["new dossiers.", "Already checked."], { fs: Math.round(W * 0.044), w: 600, fill: C.accent, op: win(t, 4.4, 5.4) });
    s += block(cx, H * 0.8, ["You don't hunt.", "You just pick up the phone."], { fs: Math.round(W * 0.042), w: 700, fill: C.ink, op: win(t, 7.0, 8.0) });
    s += block(cx, H * 0.92, ["UncleRank — try a week, free."], { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 10.0, 10.8) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: DELEN — "Delen loont" (de give-and-take van de kring) --------------------------
function buildDelen({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["You spot a flaw", "that isn't your trade."], { fs: Math.round(W * 0.052), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += block(cx, H * 0.46, ["Pass it to the circle.", "We make the intro."], { fs: Math.round(W * 0.05), w: 700, fill: C.accent, op: win(t, 3.2, 4.2) });
    s += block(cx, H * 0.64, ["Share, and you move up —", "hot leads come back to you."], { fs: Math.round(W * 0.042), w: 600, fill: C.ink, op: win(t, 6.4, 7.4) });
    s += tx(cx, H * 0.82, "Everyone feeds the pot they eat from.", { fs: Math.round(W * 0.036), w: 700, fill: C.green, op: win(t, 10.0, 11.0) });
    s += tx(cx, H * 0.9, "UncleRank — the circle.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 11.8, 12.6) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: RESULTAAT — "Eén telefoontje" (de hele loop) -----------------------------------
function buildResultaat({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 12;
  const cx = W / 2, fs = Math.round(W * 0.062);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(cx, H * 0.32, "One flaw, named.", { fs, w: 800, fill: C.ink, op: win(t, 0.6, 1.6) });
    s += tx(cx, H * 0.46, "One call that lands.", { fs, w: 800, fill: C.ink, op: win(t, 2.6, 3.6) });
    s += tx(cx, H * 0.6, "One new client.", { fs: Math.round(W * 0.072), w: 800, fill: C.accent, op: win(t, 4.6, 5.6) });
    s += block(cx, H * 0.78, ["That's the whole loop.", "No cold lists. No luck."], { fs: Math.round(W * 0.04), w: 600, fill: C.mut, op: win(t, 7.4, 8.4) });
    s += tx(cx, H * 0.9, "UncleRank — try a week, free.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 9.6, 10.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

export function makeBrand({ ROOT, config } = {}) {
  loadMark(ROOT);   // UR-mark eenmalig inladen als data-URI (voor het woordmerk/lockup)
  const branding = { navy: C.bg0, accent: C.accent };
  const templates = [
    { id: "roi", name: "Eén klant en 't is terugverdiend", music: ["upbeat", "calm", "lofi"], defaults: {} },
    { id: "gat", name: "Het gat (het harde cijfer)", music: ["upbeat", "calm", "lofi"], defaults: {} },
    { id: "portaal", name: "Portaal-opname (de kring)", music: ["upbeat", "lofi", "calm"], defaults: {} },
    { id: "kring", name: "De kring uitgelegd", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "bureaus", name: "Voor wie: 5 bureautypes", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "exclusief", name: "3 weken exclusief", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "voorna", name: "Koud vs warm (kring)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "hoehetwerkt", name: "Hoe het werkt (3 stappen)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "bezwaar", name: "Is dit niet gewoon een lijst?", music: ["upbeat", "lofi", "calm"], defaults: {} },
    { id: "mankement", name: "Een naam is geen lead", music: ["upbeat", "lofi", "calm"], defaults: {} },
    { id: "rekensom", name: "Wat kost een warme lead", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "gratisweek", name: "Gratis week (aanbod)", music: ["upbeat", "lofi", "calm"], defaults: {} },
    { id: "omdraai", name: "De omdraai (de pivot)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "volume", name: "Elke ochtend nieuw", music: ["upbeat", "lofi", "calm"], defaults: {} },
    { id: "signalen", name: "Wat we vinden (per vak)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "actueel", name: "Altijd actueel (dagelijks)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "delen", name: "Delen loont (kring)", music: ["calm", "lofi", "upbeat"], defaults: {} },
    { id: "resultaat", name: "Eén telefoontje", music: ["upbeat", "lofi", "calm"], defaults: {} },
  ];
  // De Studio wil een onderwerp kunnen kiezen; UncleRank is type-gedreven, dus één dummy-onderwerp.
  async function listSubjects() { return [{ id: "ur", thumb: null }]; }
  async function pickMusic() { return null; }   // eerst stil renderen; muziek/stem komt erbij

  // PORTAAL-OPNAME (de kring): neemt het PUBLIEKE portaal op als scroll-walkthrough en maakt 'm
  // content-ready. Draait lokaal (browser + site nodig). Levert een KANT-EN-KLARE mp4 via
  // { prebuilt } — net als taleoftiles' walkthrough — zodat de engine de SVG-pijplijn overslaat.
  // Hergebruikt tools/finish.mjs ONGEWIJZIGD via env; de recorder is het aparte tools/portal-capture.mjs.
  async function makePortalRender({ opts = {}, format = "9:16", log }) {
    const node = process.execPath;
    const recorder = path.resolve(ROOT, "tools/portal-capture.mjs");
    const finisher = path.resolve(ROOT, "tools/finish.mjs");
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const outDir = (config && config.outDir) ? config.outDir : "out";
    const work = path.resolve(ROOT, outDir, ".portal-" + Date.now());
    await fs.promises.mkdir(work, { recursive: true });
    const lang = ["nl", "fr"].includes(opts.lang) ? opts.lang : "en";   // UR = Engels (exclusieve uitstraling)

    // 1) opnemen -> ruwe mp4 + markers. Het portaal zit achter login; we geven een opgeslagen
    // login-state mee (opts.state, env, of standaard assets/unclerank/portal-state.json).
    const stateCand = opts.state || process.env.UR_PORTAL_STATE || path.resolve(ROOT, "assets/unclerank/portal-state.json");
    const recEnv = {
      ...process.env, FFMPEG,
      UR_OUT: work, UR_W: String(W), UR_H: String(H),
      UR_PORTAL_URL: (opts.url || process.env.UR_PORTAL_URL || "https://portaal.unclerank.com"),
    };
    try { if (stateCand && fs.existsSync(stateCand)) recEnv.UR_PORTAL_STATE = stateCand; } catch {}
    if (opts.seconds) recEnv.UR_SECONDS = String(opts.seconds);
    if (log) log("● portaal-opname van de live site start…");
    const r1 = await runStreamed(node, [recorder], recEnv, log, "· opname:");
    if (r1.status !== 0) throw new Error("portaal-opname faalde, draait de engine op de machine met de browser en is het portaal bereikbaar?");
    const raw = path.join(work, "portal-walkthrough.mp4");
    const markers = path.join(work, "portal-walkthrough.markers.json");

    // 2) captions kiezen, dan content-ready maken (finish.mjs, ongewijzigd). Muziek blijft leeg:
    // UR rendert eerst stil, de Engelse stem/muziek komt er in een latere stap bij.
    const music = opts.music || null;
    const caps = ({
      en: [opts.caption || "One client can pay for your whole year.", opts.caption2 || "The circle · UncleRank"],
      nl: [opts.caption || "Eén klant betaalt je hele jaar.", opts.caption2 || "De kring · UncleRank"],
    })[lang] || ["", "The circle · UncleRank"];
    const steps = opts.steps || ({
      en: ["Agencies share their overflow leads", "One trusted circle", "Each dossier, 3 weeks exclusive", "Claim your spot"],
      nl: ["Bureaus delen hun overschot aan leads", "Eén vertrouwde kring", "Elk dossier, 3 weken exclusief", "Claim je plek"],
    })[lang];
    const logo = ensureLogo(ROOT, work, opts);
    const finEnv = {
      ...process.env, FFMPEG,
      TOT_MARKERS: markers, TOT_CAPTION: caps[0], TOT_CAPTION2: caps[1],
      TOT_STEPS: JSON.stringify(steps), TOT_FINAL: path.join(work, "portal-final.mp4"),
    };
    if (logo) finEnv.TOT_LOGO = logo;
    if (music) finEnv.TOT_MUSIC = music;
    if (log) log("● portaal, content-ready (hook, snelheid, caption, muziek)…");
    const r2 = await runStreamed(node, [finisher, raw], finEnv, log, "· montage:");
    if (r2.status !== 0) throw new Error("content-ready stap (finish) faalde");

    return { prebuilt: path.join(work, "portal-final.mp4"), music: "", lang, cleanup: work };
  }

  const BUILDERS = {
    roi: buildRoi, gat: buildGat, kring: buildKring, bureaus: buildBureaus, exclusief: buildExclusief,
    voorna: buildVoorna, hoehetwerkt: buildHoehetwerkt, bezwaar: buildBezwaar, mankement: buildMankement,
    rekensom: buildRekensom, gratisweek: buildGratisweek, omdraai: buildOmdraai, volume: buildVolume,
    signalen: buildSignalen, actueel: buildActueel, delen: buildDelen, resultaat: buildResultaat,
  };
  // Stem + muziek worden BIJ DE RENDER aangemaakt (niet handmatig in Git Bash): de engine roept
  // ur_audio.py (muziekbodem, eenmalig per mood) en ur_voice.py (NL-stem) zelf aan, met voortgang
  // in het studio-log — net zoals de portaal-opname. Faalt een stap, dan rendert de video stil door.
  // Genereert muziek + stem BIJ DE RENDER en geeft de totale STEM-DUUR terug (de video volgt de stem).
  async function ensureAudioAssets(templateId, vi, opts, log) {
    const PY = process.env.UR_PYTHON || "python";
    const tpl = templates.find((t) => t.id === templateId);
    const mood = (tpl && tpl.music && tpl.music[0]) || "calm";
    // 1) muziekbodem (eenmalig per mood)
    try {
      const mp = path.resolve(ROOT, "assets/unclerank/muziek", "ur-" + mood + ".mp3");
      if (!fs.existsSync(mp)) {
        if (log) log("♪ UR-muziek ophalen (eenmalig)…");
        await runStreamed(PY, [path.resolve(ROOT, "tools/ur_audio.py"), "--root", ROOT], { ...process.env, FFMPEG }, log, "· muziek:");
      }
    } catch (e) { if (log) log("muziek-stap overgeslagen: " + e.message); }
    // 2) NL-stem van de GEKOZEN variant: de HELE tekst in één opname (Truthward-stijl, pauzes + afkap-
    //    vangnet), rustiger tempo. ur_voice schrijft voice.wav + _timeline.json (met de totale duur).
    let total;
    try {
      const vdir = voiceDir(ROOT, templateId, vi);
      const wavp = path.join(vdir, "voice.wav");
      if ((opts && opts.versStem) || !fs.existsSync(wavp)) {
        await fs.promises.mkdir(vdir, { recursive: true });
        const variant = (UR_VARIANTS[templateId] || [])[vi];
        const linesFile = path.join(vdir, "_lines.json");
        if (variant && Array.isArray(variant.voice)) {
          await fs.promises.writeFile(linesFile, JSON.stringify(variant.voice), "utf8");
        }
        if (log) log("● UR-stem genereren (Chatterbox, NL) — dit duurt even…");
        const args = [path.resolve(ROOT, "tools/ur_voice.py"), "--type", templateId, "--variant", String(vi), "--root", ROOT];
        if (variant && Array.isArray(variant.voice)) args.push("--lines", linesFile);
        if (opts && opts.voice) args.push("--voice", String(opts.voice));
        await runStreamed(PY, args, { ...process.env, FFMPEG }, log, "· stem:");
      }
      try {
        const tl = JSON.parse(await fs.promises.readFile(path.join(vdir, "_timeline.json"), "utf8"));
        if (tl && tl.total) total = Number(tl.total);
      } catch {}
    } catch (e) { if (log) log("stem-stap overgeslagen: " + e.message); }
    return total;
  }
  async function makeRender({ templateId = "roi", opts = {}, format = "9:16", log } = {}) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    if (templateId === "portaal") return await makePortalRender({ opts, format, log });
    const fn = BUILDERS[templateId] || buildRoi;
    const vi = pickVariant(templateId);                                  // afwisseling per render
    const variant = (UR_VARIANTS[templateId] || [])[vi];
    let durSec;
    if (UR_BEATS[templateId]) durSec = await ensureAudioAssets(templateId, vi, opts, log);  // duur volgt de stem
    const render = fn({ opts, W, H, variant, durSec });
    return attachAudio(ROOT, templates, templateId, render, vi);
  }
  // De engine roept bij het laden brand.init(log) aan (zoals taleoftiles). UncleRank is type-
  // gedreven en heeft niets te laden, dus init is een no-op — maar moet wél bestaan.
  async function init() { return; }
  return {
    id: "unclerank", name: "UncleRank", footer: "unclerank.com",
    branding, templates, options: [], init, listSubjects, pickMusic, makeRender,
  };
}
