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

// ---- TYPE: BUREAUS — "Voor wie: de 5 bureautypes" ------------------------------------------
function buildBureaus({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2, fsH = Math.round(W * 0.058), fsR = Math.round(W * 0.044);
  const rows = [
    ["SEO", "ranks too low on Google"],
    ["SEA", "no ads running for months"],
    ["Web", "a site built on a template"],
    ["Content", "a blog that died in 2022"],
    ["Ads", "invisible on every channel"],
  ];
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["Five kinds of agency.", "Five kinds of lead."], { fs: fsH, w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const x0 = W * 0.12, y0 = H * 0.36, rh = H * 0.1;
    rows.forEach((r, i) => {
      const op = win(t, 2.0 + i * 1.3, 2.8 + i * 1.3);
      if (op <= 0.001) return;
      const y = y0 + i * rh;
      s += tx(x0, y, r[0], { fs: fsR, w: 800, fill: C.accent, op, anchor: "start" });
      s += tx(x0 + W * 0.26, y, r[1], { fs: Math.round(fsR * 0.82), w: 500, fill: C.ink, op, anchor: "start" });
    });
    s += tx(cx, H * 0.9, "Each sees only the leads that fit them.", { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 9.0, 10.0) });
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

export function makeBrand({ ROOT, config } = {}) {
  const branding = { navy: C.bg0, accent: C.accent };
  const templates = [
    { id: "roi", name: "Eén klant betaalt je jaar", music: ["upbeat", "calm", "lofi"], defaults: {} },
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
    if (templateId === "kring") return buildKring({ opts, W, H });
    if (templateId === "bureaus") return buildBureaus({ opts, W, H });
    if (templateId === "exclusief") return buildExclusief({ opts, W, H });
    if (templateId === "voorna") return buildVoorna({ opts, W, H });
    if (templateId === "hoehetwerkt") return buildHoehetwerkt({ opts, W, H });
    if (templateId === "bezwaar") return buildBezwaar({ opts, W, H });
    if (templateId === "mankement") return buildMankement({ opts, W, H });
    if (templateId === "rekensom") return buildRekensom({ opts, W, H });
    if (templateId === "gratisweek") return buildGratisweek({ opts, W, H });
    return buildRoi({ opts, W, H });
  }
  return {
    id: "unclerank", name: "UncleRank", footer: "unclerank.com",
    branding, templates, options: [], listSubjects, pickMusic, makeRender,
  };
}
