// Tale of Tiles — Studio. Lokale interface: kies een PATROON, de engine genereert
// de kleuren (tegel-voor-tegel), kies template/muziek/formaat, bekijk de video,
// sla een winnaar op als showcase.  Start:  npm run studio-app  /  npm run app
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Resvg } from "@resvg/resvg-js";
import ffmpegStatic from "ffmpeg-static";
import { config } from "../config.mjs";

const FFMPEG = ffmpegStatic || "ffmpeg"; // gebundelde ffmpeg (geen systeem-install nodig)
// ---- live operatie-log (naar de studio-UI via SSE) ----
const logClients = new Set();
function log(msg) {
  const line = typeof msg === "string" ? msg : String(msg);
  process.stdout.write("  " + line + "\n");
  for (const c of logClients) { try { c.write(`data: ${JSON.stringify(line)}\n\n`); } catch {} }
}

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 4599;
const OUT = path.resolve(ROOT, config.outDir);
await fs.mkdir(OUT, { recursive: true });

// animatie-engine laden
const libOut = path.resolve(OUT, ".studiolib.mjs");
await esbuild.build({ entryPoints: [path.resolve(ROOT, "remotion/film.ts")], bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: libOut });
const film = await import(pathToFileURL(libOut).href + "?t=" + Date.now());

const C = config.brandColors;
const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
const patternList = JSON.parse(await fs.readFile(path.resolve(ROOT, "fixtures/patterns.json"), "utf8")).patterns;

// hex -> kleur-id (voor opslaan als showcase)
const HEX2ID = {};
try { const tc = JSON.parse(await fs.readFile(path.resolve(ROOT, "fixtures/tile-colors.sample.json"), "utf8")).MTILE_HEX || {}; for (const id in tc) HEX2ID[tc[id].toLowerCase()] = "t" + id; } catch {}

const svgCache = new Map();      // pattern -> getegelde panel-SVG
const designCache = new Map();   // token -> generated design (voor opslaan)
let busy = false;

// Lock-waardes {n,gx,gy} per patroon (van /api/tile-locks, eenmalig opgehaald)
let LOCKS = {};
try { LOCKS = JSON.parse(await fs.readFile(path.resolve(ROOT, "assets/tile-locks.json"), "utf8")); } catch {}

// Patroon tegelen uit de lokale kale SVG + lock. Geen configurator nodig, offline.
// nX/nY passen zich aan het formaat aan, zodat de tegels vierkant blijven (niet
// vervormd) en het paneel netjes gevuld is. SHORT = aantal eenheden op de korte as.
const baseCache = new Map();     // pattern -> kale SVG
async function getBase(pattern) {
  if (baseCache.has(pattern)) return baseCache.get(pattern);
  const file = path.resolve(ROOT, "assets/patterns", pattern + ".svg");
  let base;
  try { base = await fs.readFile(file, "utf8"); }
  catch { throw new Error(`patroon ${pattern} niet gevonden in assets/patterns/ — draai eerst de fetch (zie README)`); }
  baseCache.set(pattern, base); return base;
}
// native grootte van één eenheid (incl. lock-naden) -> voor de verhouding
function unitSize(base, lock) {
  const u = film.parseTiles(film.tilePattern(base, lock, 1, 1));
  return { w: u.view[2], h: u.view[3] };
}
// kies nX/nY zodat de getegelde verhouding ~panelAspect is én de tegels vierkant blijven
function tileCounts(base, lock, panelAspect) {
  const u = unitSize(base, lock);
  let ua = u.w / u.h;                  // native eenheid-verhouding
  if (!Number.isFinite(ua) || ua <= 0) ua = 1;  // degenereerde eenheid -> vierkant aannemen
  const SHORT = 3;                     // ~3 eenheden op de korte as -> rustige, premium dichtheid
  let nX, nY;
  if (panelAspect <= 1) { nX = SHORT; nY = Math.max(2, Math.round(nX * ua / panelAspect)); }
  else { nY = SHORT; nX = Math.max(2, Math.round(nY * panelAspect / ua)); }
  if (!Number.isFinite(nX) || nX < 2) nX = 2;
  if (!Number.isFinite(nY) || nY < 2) nY = 2;
  nX = Math.min(10, nX); nY = Math.min(12, nY);
  return { nX, nY };
}
async function getPatternSvg(pattern, nX, nY) {
  const key = `${pattern}_${nX}x${nY}`;
  if (svgCache.has(key)) return svgCache.get(key);
  const base = await getBase(pattern);
  const panel = film.tilePattern(base, LOCKS[pattern] || {}, nX, nY);
  svgCache.set(key, panel); return panel;
}
// pas een rechthoek met verhouding A in (Wmax x Hmax), zonder vervormen
function fitRect(Wmax, Hmax, A) {
  let w = Wmax, h = Math.round(w / A);
  if (h > Hmax) { h = Hmax; w = Math.round(h * A); }
  return { w, h };
}

let logoDataUri = "";
async function loadLogo() {
  if (logoDataUri) return logoDataUri;
  try { if (config.logoUrl && /^https?:/.test(config.logoUrl)) { const r = await fetch(config.logoUrl); if (r.ok) { const ext = (config.logoUrl.split(".").pop() || "png").split(/[?#]/)[0]; logoDataUri = `data:image/${ext === "svg" ? "svg+xml" : ext};base64,` + Buffer.from(await r.arrayBuffer()).toString("base64"); } } } catch {}
  return logoDataUri;
}

function escapeXml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function json(res, o, c = 200) { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); }
function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }

function storyboardFrom(opts) {
  const pals = { modern: film.PAL, warm: film.WARM, cool: film.COOL };
  const pal = pals[opts.palette] || film.PAL;
  const tempo = { snel: 1.2, normaal: 1.8, rustig: 2.6 }[opts.tempo] || 1.8;
  const segs = [{ scene: { type: opts.base === "fields" ? "fields" : "confetti", palette: pal }, hold: tempo, trans: 0 }];
  for (const sh of (opts.shapes || [])) segs.push({ scene: { type: "shape", shape: sh, fg: pal }, hold: tempo, trans: 0.9 });
  if (opts.endColorway) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
  if (segs.length === 1) segs.push({ scene: { type: "fields", palette: pal }, hold: tempo, trans: 0.9 });
  return { buildSec: Number(opts.buildSec) || 2.6, popSec: 0.3, segments: segs };
}

// bouw een opslaanbaar ontwerp uit de eind-kleuren (tegel-voor-tegel -> tileColors)
function designFromColors(pattern, parsed, colors, name = "") {
  const tileColors = {};
  for (let i = 0; i < parsed.tiles.length; i++) { const k = parsed.tiles[i].key; if (!k) continue; const id = HEX2ID[(colors[i] || "").toLowerCase()]; if (id) tileColors[k] = id; }
  return { pattern, groupColors: {}, tileColors, size: { w: 100, h: 70, tile: 5 }, shape: "rect", border: { on: false, pattern: "S900", groupColors: {}, tileColors: {} }, name, namefont: "romeins", ink: "auto", textScale: 1, plateScale: 1, tileGrade: "normaal" };
}

async function renderVideo({ pattern, template, opts, format, music, name }) {
  name = (name || "").trim();
  // ontwerp-ruimte op basis-formaat; raster op 2x -> scherpere tegelranden & tekst
  const FMT = { "9:16": [540, 960], "1:1": [720, 720], "16:9": [960, 540] }[format] || [540, 960];
  const [W, H] = FMT, SS = 2, FPS = 24;
  // doel-verhouding van het paneel per formaat (korte as = breedte bij 9:16)
  const PANEL_ASPECT = { "9:16": 0.70, "1:1": 1.0, "16:9": 1.55 }[format] || 0.70;
  const base = await getBase(pattern);
  const { nX, nY } = tileCounts(base, LOCKS[pattern] || {}, PANEL_ASPECT);
  const svg = await getPatternSvg(pattern, nX, nY);
  const parsed = film.parseTiles(svg, opts.reveal || "radial");
  if (!parsed.tiles.length) throw new Error(`patroon ${pattern} heeft 0 tegels (raster-type, nog niet ondersteund) — kies een polygoon-patroon zoals S101`);
  const story = storyboardFrom(opts);
  const DUR = template === "film" ? film.totalDuration(story) : 7;
  const buildOnly = { buildSec: DUR - 1, popSec: 0.3, segments: [{ scene: { type: opts.base === "fields" ? "fields" : "confetti", palette: ({ modern: film.PAL, warm: film.WARM, cool: film.COOL })[opts.palette] || film.PAL }, hold: 1, trans: 0 }] };
  const activeStory = template === "film" ? story : buildOnly;
  // echte getegelde verhouding -> paneel krijgt exact deze vorm (geen letterbox, geen rek)
  const A = parsed.view[2] / parsed.view[3];
  const bandTop = Math.round(H * 0.155), bandBot = Math.round(H * 0.905);
  const fit = fitRect(Math.round(W * 0.86), bandBot - bandTop, A);
  const panelW = fit.w, panelH = fit.h;
  const pad = Math.max(6 * SS, Math.round(panelW * 0.018));
  const innerW = panelW - pad * 2, innerH = panelH - pad * 2;
  const panelX = Math.round((W - panelW) / 2), panelY = Math.round(bandTop + (bandBot - bandTop - panelH) / 2);
  const logo = await loadLogo();

  function scene(frame) {
    const inner = film.buildSvg(parsed, film.colorsAt(parsed, activeStory, frame / FPS)).replace(/<svg\b[^>]*>/i,
      `<svg x="${panelX + pad}" y="${panelY + pad}" width="${innerW}" height="${innerH}" viewBox="0 0 ${parsed.view[2]} ${parsed.view[3]}" preserveAspectRatio="xMidYMid meet">`);
    const logoTag = logo ? `<image href="${logo}" x="${W / 2 - 90}" y="${H * 0.05}" width="180" height="${H * 0.07}" preserveAspectRatio="xMidYMid meet"/>`
      : `<text x="${W / 2}" y="${H * 0.1}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="20" letter-spacing="4" fill="${C.gold}">TALE OF TILES</text>`;
    // Naamplaat (verschijnt aan het eind, zet het ontwerp neer als product): naam op
    // een stenen plaat, "romeins" serif, inkt #4a3a2a — zoals de configurator.
    let plate = "";
    if (name) {
      const t = frame / FPS, fadeStart = DUR - 2.2;
      const op = Math.max(0, Math.min(1, (t - fadeStart) / 1.0));
      if (op > 0) {
        const plateW = Math.round(panelW * 0.80), plateH = Math.max(40, Math.round(panelH * 0.14));
        const plateX = Math.round((W - plateW) / 2);
        const plateY = panelY + panelH - plateH - Math.round(panelH * 0.06) + Math.round((1 - op) * 14);
        const fs = Math.min(Math.round(plateH * 0.44), Math.round(plateW * 1.5 / Math.max(3, name.length)));
        plate = `<g opacity="${op.toFixed(3)}">`
          + `<rect x="${plateX + 4}" y="${plateY + 6}" width="${plateW}" height="${plateH}" rx="9" fill="#000000" opacity="0.20"/>`
          + `<rect x="${plateX}" y="${plateY}" width="${plateW}" height="${plateH}" rx="9" fill="#efe9dd" stroke="#c9bfa6" stroke-width="1.5"/>`
          + `<rect x="${plateX + 5}" y="${plateY + 5}" width="${plateW - 10}" height="${plateH - 10}" rx="6" fill="none" stroke="#d8cdb4" stroke-width="1"/>`
          + `<text x="${W / 2}" y="${plateY + plateH / 2}" text-anchor="middle" dominant-baseline="central" font-family="DejaVu Serif,serif" font-size="${fs}" letter-spacing="1.5" fill="#4a3a2a">${escapeXml(name)}</text>`
          + `</g>`;
      }
    }
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs><radialGradient id="bg" cx="50%" cy="26%" r="90%"><stop offset="0%" stop-color="${C.bg2}"/><stop offset="70%" stop-color="${C.bg}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${logoTag}
<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="6" fill="#eae4d7" stroke="${C.gold}" stroke-width="2"/>${inner}${plate}
<text x="${W / 2}" y="${H * 0.95}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="20" letter-spacing="2" fill="${C.cream}" opacity="0.85">taleoftiles.com</text></svg>`;
  }

  const tmp = path.resolve(OUT, ".frames-" + Date.now()); await fs.mkdir(tmp, { recursive: true });
  const total = Math.round(DUR * FPS);
  log(`patroon ${pattern}: ${parsed.tiles.length} tegels`);
  log(`frames renderen: ${total} (${template}, ${format})`);
  for (let f = 0; f < total; f++) {
    const r = new Resvg(scene(f), { fitTo: { mode: "width", value: W * SS }, font: { loadSystemFonts: true } });
    await fs.writeFile(path.join(tmp, `f${String(f).padStart(4, "0")}.png`), r.render().asPng());
    if (f % 24 === 0 || f === total - 1) { log(`  frame ${f + 1}/${total}`); await new Promise((r2) => setImmediate(r2)); } // yield -> log leeft live
  }
  const outName = `studio-${Date.now()}.mp4`;
  const outPath = path.resolve(OUT, outName);
  const fa = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%04d.png")];
  const musicPath = music ? path.resolve(ROOT, config.audioDir, music) : "";
  if (musicPath && existsSync(musicPath)) fa.push("-i", musicPath, "-shortest");
  fa.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (musicPath && existsSync(musicPath)) fa.push("-c:a", "aac");
  fa.push(outPath);
  log(`ffmpeg: frames -> mp4${musicPath ? " (+ muziek)" : ""}`);
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, fa, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.on("error", (e) => reject(new Error("ffmpeg kon niet starten: " + e.message)));
    if (p.stderr) p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg stopte met code " + c + (err ? " — " + err.trim().split("\n").pop() : "")))));
  });
  await fs.rm(tmp, { recursive: true, force: true });

  // opslaanbaar ontwerp uit de eind-kleuren bewaren
  const finalColors = film.colorsAt(parsed, activeStory, DUR - 0.01);
  const token = outName.replace(/\.mp4$/, "");
  designCache.set(token, designFromColors(pattern, parsed, finalColors, name));
  log("mp4 geschreven: " + outName);
  return { url: "/out/" + outName, token };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await fs.readFile(path.resolve(ROOT, "studio/index.html"))); return; }
    if (u.pathname.startsWith("/out/")) { const f = path.resolve(OUT, u.pathname.slice(5)); if (existsSync(f)) { res.writeHead(200, { "content-type": "video/mp4" }); res.end(await fs.readFile(f)); return; } res.writeHead(404); res.end("nope"); return; }
    if (u.pathname === "/api/log") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify("— verbonden met de studio —")}\n\n`);
      logClients.add(res); req.on("close", () => logClients.delete(res)); return;
    }
    if (u.pathname === "/api/patterns") { json(res, { patterns: patternList, thumbBase: "/api/thumb?p=" }); return; }
    if (u.pathname === "/api/thumb") {
      const p = (u.searchParams.get("p") || "").replace(/\.svg$/i, "");
      if (!/^[A-Za-z0-9_-]+$/.test(p)) { res.writeHead(400); res.end(""); return; }
      try {
        let svg = await getBase(p);
        // leesbaar maken: tegel-fills -> cream, randen -> plum (anders wit-op-wit, onzichtbaar)
        svg = svg.replace(/fill:\s*#[0-9a-fA-F]{3,6}/g, "fill:#e8dcc0")
                 .replace(/fill="#[0-9a-fA-F]{3,6}"/g, 'fill="#e8dcc0"')
                 .replace(/stroke:\s*#[0-9a-fA-F]{3,6}/g, "stroke:#3a2d52")
                 .replace(/stroke="#[0-9a-fA-F]{3,6}"/g, 'stroke="#3a2d52"');
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
        res.end(svg); return;
      } catch { res.writeHead(404); res.end(""); return; }
    }
    if (u.pathname === "/api/music") { let files = []; try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); } catch {} json(res, { files }); return; }
    if (u.pathname === "/api/render" && req.method === "POST") {
      const b = await readBody(req);
      if (!b.pattern) { log("FOUT: geen patroon gekozen"); json(res, { error: "geen patroon gekozen" }, 400); return; }
      if (busy) { log("⏳ er loopt al een render — even wachten tot die klaar is"); json(res, { error: "er loopt al een render, wacht tot die klaar is" }, 409); return; }
      busy = true;
      log(`▶ render gestart — patroon ${b.pattern}, ${b.template || "film"}, ${b.format || "9:16"}`);
      try {
        const r = await renderVideo({ pattern: b.pattern, template: b.template || "film", opts: b.opts || {}, format: b.format || "9:16", music: b.music || "", name: b.name || "" });
        log(`✓ klaar: ${r.url}`);
        json(res, r);
      } catch (e) { log(`✗ FOUT: ${e.message}`); json(res, { error: e.message }, 500); }
      finally { busy = false; }
      return;
    }
    if (u.pathname === "/api/save-showcase" && req.method === "POST") {
      const b = await readBody(req);
      const design = designCache.get(b.token);
      if (!design) { json(res, { ok: false, log: "Niks om op te slaan (render eerst)." }); return; }
      const code = Buffer.from(JSON.stringify(design), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const name = (b.name || "").trim() || design.pattern;
      const { spawnSync } = await import("node:child_process");
      const rr = spawnSync("node", [path.resolve(ROOT, "src/save-showcase.mjs"), `--code=${code}`, `--name=${name}`], { encoding: "utf8" });
      json(res, { ok: rr.status === 0, log: (rr.stdout || "") + (rr.stderr || "") }); return;
    }
    res.writeHead(404); res.end("nope");
  } catch (e) { log("✗ serverfout: " + e.message); json(res, { error: e.message }, 500); }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Tale of Tiles Studio  ->  ${url}\n  (laat dit venster open staan; dit is de server)\n`);
  if (process.env.STUDIO_NO_OPEN) return;
  try { const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]; spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
});
