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
// Klein woordmerk bovenin, altijd zichtbaar.
function wordmark(W, H, op = 1) {
  const y = Math.round(H * 0.085), fs = Math.round(W * 0.05);
  return `<text x="${W / 2}" y="${y}" fill="${C.ink}" opacity="${op}" font-family="Arial, Helvetica, sans-serif"
    font-size="${fs}" font-weight="800" letter-spacing="${fs * 0.08}" text-anchor="middle">UNCLERANK</text>
    <text x="${W / 2}" y="${y + fs * 0.75}" fill="${C.mut}" opacity="${op * 0.9}" font-family="Arial, Helvetica, sans-serif"
    font-size="${Math.round(fs * 0.34)}" letter-spacing="2" text-anchor="middle">een reden om te bellen, geen lijst</text>`;
}
function tx(x, y, s, { fs, w = 400, fill = C.ink, op = 1, anchor = "middle", ls = 0 }) {
  if (op <= 0.001) return "";
  return `<text x="${x}" y="${y}" fill="${fill}" opacity="${op.toFixed(3)}" font-family="Arial, Helvetica, sans-serif"
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

// ---- TYPE: ROI — "Eén klant betaalt je jaar" ----------------------------------------------
function buildRoi({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 16;
  const jaarKost = Number(opts.kost) || 1068;     // een jaar Start (uit bureaus.mjs)
  const klant = Number(opts.omzet) || 6000;       // wat die ene klant opbrengt
  const cx = W / 2, fsBig = Math.round(W * 0.145), fsLbl = Math.round(W * 0.035), fsHook = Math.round(W * 0.058);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // 1) hook
    s += block(cx, H * 0.26, ["What's one new", "client worth to you?"],
      { fs: fsHook, w: 800, fill: C.ink, op: win(t, 0.3, 1.4, 3.4, 4.2), anchor: "middle" });
    // 2) de kost (rood-neutraal), schuift naar boven als de omzet komt
    const costOp = win(t, 3.4, 4.3);
    const costY = H * 0.46 - smooth(clamp((t - 7.5) / 1.0)) * H * 0.07;
    s += tx(cx, costY, eur(jaarKost), { fs: fsBig, w: 800, fill: "#cdd9e6", op: costOp });
    s += tx(cx, costY + fsBig * 0.42, "a year of UncleRank", { fs: fsLbl, w: 500, fill: C.mut, op: costOp });
    // 3) de klant (wit, groot) met pijl
    const omOp = win(t, 7.6, 8.6);
    const omY = H * 0.58;
    s += tx(cx, omY - fsBig * 0.62, "↓", { fs: Math.round(fsBig * 0.5), w: 400, fill: C.accent, op: win(t, 7.2, 8.0) });
    s += tx(cx, omY, eur(klant), { fs: fsBig, w: 800, fill: "#ffffff", op: omOp });
    s += tx(cx, omY + fsBig * 0.42, "one new client", { fs: fsLbl, w: 500, fill: C.accent, op: omOp });
    // 4) winst
    const wOp = win(t, 11.0, 12.0);
    if (wOp > 0.001) {
      const bw = W * 0.62, bh = H * 0.11, bx = cx - bw / 2, by = H * 0.70;
      s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh * 0.28}" fill="${C.green}" opacity="${(wOp * 0.16).toFixed(3)}"/>`
        + `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh * 0.28}" fill="none" stroke="${C.green}" stroke-width="2.5" opacity="${wOp.toFixed(3)}"/>`;
      s += tx(cx, by + bh * 0.64, "Everything above that is profit.", { fs: Math.round(W * 0.045), w: 800, fill: C.green, op: wOp });
    }
    // 5) CTA
    const cOp = win(t, 13.6, 14.4);
    s += block(cx, H * 0.87, ["Start free. 7 days.", "No card charged today."],
      { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op: cOp });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
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

export function makeBrand({ ROOT, config } = {}) {
  const branding = { navy: C.bg0, accent: C.accent };
  const templates = [
    { id: "roi", name: "Eén klant betaalt je jaar", music: ["upbeat", "calm", "lofi"], defaults: {} },
    { id: "gat", name: "Het gat (het harde cijfer)", music: ["upbeat", "calm", "lofi"], defaults: {} },
    { id: "portaal", name: "Portaal-opname (de kring)", music: ["upbeat", "lofi", "calm"], defaults: {} },
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

  async function makeRender({ templateId = "roi", opts = {}, format = "9:16", log } = {}) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    if (templateId === "portaal") return await makePortalRender({ opts, format, log });
    if (templateId === "gat") return buildGat({ opts, W, H });
    return buildRoi({ opts, W, H });
  }
  return {
    id: "unclerank", name: "UncleRank", footer: "unclerank.com",
    branding, templates, options: [], listSubjects, pickMusic, makeRender,
  };
}
