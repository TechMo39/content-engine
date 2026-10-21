// GENERIEKE STUDIO-SERVER. Kiest: merk -> onderwerp -> template -> opties -> render.
// Weet zelf niks van tegels; dat zit in de merk-modules. Start: npm run engine
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { buildRegistry } from "./registry.mjs";
import { buildSocial } from "./social/index.mjs";
import { makeSocialStore } from "./social/store.mjs";
import { loadEnv } from "./social/env.mjs";
import { r2Put, r2Delete } from "./social/r2.mjs";
import { renderToMp4 } from "./core/renderer.mjs";
import { Resvg } from "@resvg/resvg-js";
import ffmpegPath from "ffmpeg-static";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
loadEnv(ROOT);   // .env inlezen (YT_CLIENT_ID/SECRET e.d.) zonder bestaande env te overschrijven
const PORT = 4600;
const OUT = path.resolve(ROOT, config.outDir);
await fs.mkdir(OUT, { recursive: true });
// OUT netjes houden: ruim bij het opstarten de tijdelijke werk-/frame-mappen van eerdere of
// afgebroken renders op. Echte outputs (mp4's, mail-stills, build-bundels .mjs) blijven staan.
try {
  for (const e of await fs.readdir(OUT, { withFileTypes: true })) {
    const nm = e.name;
    if (e.isDirectory() && (/^\.walk-/.test(nm) || /^\.frames(-|$)/.test(nm) || nm === ".studioframes")) {
      await fs.rm(path.resolve(OUT, nm), { recursive: true, force: true });
    } else if (!e.isDirectory() && nm === "dump.svg") {
      await fs.rm(path.resolve(OUT, nm), { force: true });
    }
  }
} catch {}

const logClients = new Set();
function log(msg) { const line = String(msg); process.stdout.write("  " + line + "\n"); for (const c of logClients) { try { c.write(`data: ${JSON.stringify(line)}\n\n`); } catch {} } }

const reg = buildRegistry({ ROOT, config });
for (const b of reg.brands) { try { await b.init(log); } catch (e) { log(`merk ${b.id} init-fout: ${e.message}`); } }
log("merken geladen: " + reg.brands.map((b) => b.id).join(", "));

// ---- SOCIAL-ARM (losse laag, raakt het mail-contract niet) ----
// Kanalen (YouTube actief, rest stub) + lokaal logboek out/.social.json. Het casco posten
// komt in stap 2 (echte API's per kanaal). Nu: de video's uit de Bibliotheek tonen, per video
// auto-teksten voorstellen (bewerkbaar), en de post-status onthouden.
// publicUrlFor: Instagram eist een PUBLIEKE video-URL. We zetten de mp4 TIJDELIJK rechtstreeks in
// R2 (eigen S3-route, raakt de worker niet aan) onder social-tmp/. De worker serveert elk object
// al publiek op /img/<key>, dus die URL geven we door. cleanup() wist 'm na het posten weer.
const IMG_BASE = (process.env.TOT_IMG_BASE || "https://taleoftiles.com/img").replace(/\/$/, "");
async function publicUrlFor(videoPath) {
  const key = "social-tmp/ig-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".mp4";
  const buf = await fs.readFile(videoPath);
  await r2Put(key, buf, "video/mp4");
  const cleanup = async () => { try { await r2Delete(key); } catch {} };
  return { url: `${IMG_BASE}/${key}`, cleanup };
}

// Per-type maximale duur (seconden) voor "render alles". Alleen een plafond: kies je minder,
// dan geldt jouw keuze. Types die bij langere duur MEER brengen (satisfying/sfeer/geentwee) en
// de externe walkthrough staan er bewust NIET in -> die pakken je gekozen duur volledig.
const TYPE_MAX_SEC = {
  intro: 40,        // uitlegvideo: kort houden
  trio: 30, colorway: 30,
  cadeau: 35,
  onthul: 24, stopzodra: 24,   // raad-/reveal-clips: kort is spannender
  insitu: 24,
};

const social = buildSocial({ ROOT, publicUrlFor });
const socialStore = makeSocialStore(OUT);
log("social-platforms: " + social.platforms.map((p) => p.id + (p.enabled ? "" : "·stub")).join(", ") + " × " + social.LANGS.join("/"));

// ---- MAIL-STILL: per bedrijf één mail-afbeelding, LOKAAL gerenderd. Deterministisch per naam
// (zelfde bedrijf -> altijd hetzelfde plaatje), zodat het op R2 een stabiele URL kan krijgen.
const MAILSTILL_DIR = path.resolve(OUT, "mail-stills");
const FONTS_DIR = path.resolve(ROOT, "assets/fonts");
let FONT_FILES = [];
try { FONT_FILES = (await fs.readdir(FONTS_DIR)).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(FONTS_DIR, f)); } catch {}
function slugify(s) { return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "naam"; }
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// Math.random tijdelijk vervangen door een vaste reeks (seed uit de naam) -> dezelfde mockup+palet
async function withSeed(seed, fn) {
  const orig = Math.random; let x = (seed || 1) >>> 0;
  Math.random = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  try { return await fn(); } finally { Math.random = orig; }
}
// RENDER-SLOT: een video-render en een mail-still-render mogen NOOIT tegelijk de (globale)
// toevalsgenerator pakken. Deze mutex laat de kritieke secties netjes om de beurt gaan;
// de lange ffmpeg-encode van een video valt erbuiten, dus die blijft gewoon parallel lopen.
let _renderGate = Promise.resolve();
function renderLock(fn) { const run = _renderGate.then(fn, fn); _renderGate = run.then(() => {}, () => {}); return run; }
// De glazuur-families (vaste set). Door de familie + de mockup op de naam-hash te pinnen,
// omzeilen we de anti-herhaling (pickFresh) volledig -> zelfde bedrijf = altijd zelfde plaatje.
const MS_FAMILIES = ["kobalt", "mono_blauw", "oceaan", "smaragd", "mono_groen", "terracotta", "saffraan", "aubergine", "bont", "feest", "bont", "feest"];
// STIJLEN voor de mail (3 per naam, bewust ver uit elkaar). Elke stijl put uit een eigen set
// families; de naam-hash kiest er deterministisch één uit -> zelfde naam+stijl = zelfde plaatje.
//  - klassiek : warme aardetinten (terracotta/oker/diepgroen) — de veilige, tijdloze klassieker
//  - modern   : strak, koel monochroom (inktblauw/antraciet) — premium, veel rust
//  - kleurrijk: levendig meerkleurig (bont/feest, per-tegel scatter) — blikvanger
const MS_STYLES = {
  klassiek:  ["terracotta", "saffraan", "mono_groen"],
  modern:    ["mono_blauw", "kobalt", "oceaan"],
  kleurrijk: ["bont", "feest"],
};
function normStyle(s) { s = String(s || "").toLowerCase().trim(); return MS_STYLES[s] ? s : "klassiek"; }
let MS_MOCKUPS = null, MS_SUBJECTS = null;
async function mockupsOnce() { if (MS_MOCKUPS) return MS_MOCKUPS; try { MS_MOCKUPS = await reg.byId["taleoftiles"].listMockups(); } catch { MS_MOCKUPS = []; } return MS_MOCKUPS; }
async function subjectsOnce() { if (MS_SUBJECTS) return MS_SUBJECTS; try { MS_SUBJECTS = (await reg.byId["taleoftiles"].listSubjects()).map((s) => s.id); } catch { MS_SUBJECTS = []; } return MS_SUBJECTS; }
let mailChain = Promise.resolve();   // renders serialiseren (de seed is globaal, dus niet parallel)
async function renderMailStill(name, style) {
  const brand = reg.byId["taleoftiles"]; if (!brand) throw new Error("merk taleoftiles niet geladen");
  await fs.mkdir(MAILSTILL_DIR, { recursive: true });
  style = normStyle(style);
  const fams = MS_STYLES[style];
  const mkAll = await mockupsOnce(), subs = await subjectsOnce();
  // MAIL-VEILIGE MOCKUPS: alleen muren waar de auto-detectie een ruime, nette vrije plek vond
  // (niet te laag/klein/aan de rand) -> nooit een bord op de stoep/straat van een winkelpui.
  const mkSafe = mkAll.filter((m) => m.place && m.place.w >= 0.34 && m.place.h >= 0.24 && m.place.cy <= 0.58 && m.place.cx >= 0.30 && m.place.cx <= 0.70);
  const mk = (mkSafe.length ? mkSafe : mkAll).map((m) => m.id);
  // Seed uit naam ÉN stijl -> de drie stijlen pakken een andere familie/mockup/patroon,
  // dus visueel duidelijk uit elkaar. Deterministisch: zelfde naam+stijl = zelfde plaatje.
  const h = hashSeed(name + "|" + style);
  const fam = fams[h % fams.length];
  const image = mk.length ? mk[Math.floor(h / 97) % mk.length] : "";
  const subjectId = subs.length ? subs[Math.floor(h / 9973) % subs.length] : undefined;
  const svg = await renderLock(() => withSeed(h, async () => {
    const r = await brand.makeRender({ subjectId, templateId: "insitu", opts: { name, lang: "nl", palette: fam, image, hook: "none" }, format: "1:1", log: () => {} });
    r.SS = 1;
    return r.sceneAt(Math.round(r.durSec * 0.93 * r.FPS));   // eindbeeld: paneel vol + naam
  }));
  const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, fontFiles: FONT_FILES } }).render().asPng();
  const tmp = path.join(os.tmpdir(), "totms-" + Date.now() + ".png");
  await fs.writeFile(tmp, png);
  const file = slugify(name) + "-" + style + ".jpg";
  spawnSync(ffmpegPath, ["-y", "-v", "error", "-i", tmp, "-vf", "scale=600:-1:flags=lanczos", "-q:v", "4", path.join(MAILSTILL_DIR, file)], { stdio: "ignore", windowsHide: true });
  try { await fs.unlink(tmp); } catch {}
  const st = await fs.stat(path.join(MAILSTILL_DIR, file));
  return { name, style, file, url: "/out/mail-stills/" + encodeURIComponent(file), kb: Math.round(st.size / 1024) };
}
function enqueueMail(name, style) { const p = mailChain.then(() => renderMailStill(name, style)); mailChain = p.catch(() => {}); return p; }

// ---- BIBLIOTHEEK-helpers: metadata uit de bestandsnaam halen (<merk>-<type>[-en][-naam]-MMDD-HHMMSS.mp4) ----
const BRAND_IDS = reg.brands.map((b) => b.id).sort((a, b) => b.length - a.length);   // langste eerst (prefix-match)
const BRAND_NAME = Object.fromEntries(reg.brands.map((b) => [b.id, b.name]));
const TEMPLATE_IDS = new Set();
const TEMPLATE_NAME = {};
for (const b of reg.brands) for (const t of b.templates || []) { TEMPLATE_IDS.add(t.id); TEMPLATE_NAME[t.id] = t.name; }
const CT = { ".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".svg": "image/svg+xml" };
function titleCase(s) { return s.replace(/\b\w/g, (c) => c.toUpperCase()); }
function parseOutName(fileNoExt) {
  let date = null, core = fileNoExt;
  const m = fileNoExt.match(/-(\d{4})-(\d{6})$/);
  if (m) { const MM = m[1].slice(0, 2), DD = m[1].slice(2), HH = m[2].slice(0, 2), Mi = m[2].slice(2, 4); date = `${DD}-${MM} ${HH}:${Mi}`; core = fileNoExt.slice(0, m.index); }
  let brand = null;
  for (const bid of BRAND_IDS) { if (core === bid || core.startsWith(bid + "-")) { brand = bid; break; } }
  let rest = brand ? core.slice(brand.length).replace(/^-/, "") : core;
  let template = null, lang = "nl"; const nameParts = [];
  for (const p of rest.split("-").filter(Boolean)) {
    if (!template && TEMPLATE_IDS.has(p)) { template = p; continue; }
    if (p === "en" || p === "fr") { lang = p; continue; }
    nameParts.push(p);
  }
  return { brand, template, lang, name: nameParts.join(" "), date };
}

function json(res, o, c = 200) { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); }
function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }

// ---- RENDER-WACHTRIJ: elke render gaat hier doorheen, één tegelijk. ----
// Zo kun je er meerdere achter elkaar in de rij zetten (ook alle types in één klik) en
// later terugkomen; de engine werkt ze vanzelf af.
const queue = [];
let running = false;
function enqueue(job) { return new Promise((resolve) => { queue.push({ job, resolve }); drain(); }); }
async function drain() {
  if (running) return; running = true;
  while (queue.length) {
    const { job, resolve } = queue.shift();
    try {
      log(`▶ render — ${job.brand}/${job.template || "-"} (${job.format || "9:16"})${queue.length ? `  · nog ${queue.length} in de rij` : ""}`);
      resolve(await runOne(job));
    } catch (e) { log(`✗ FOUT: ${e.message}`); resolve({ error: e.message }); }
  }
  running = false;
}
function p2(n) { return String(n).padStart(2, "0"); }
function stamp() { const d = new Date(); return `${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`; }
function outBase(job) {
  const p = [job.brand, job.template || "video"];
  const _lg = job.opts && job.opts.lang; if (_lg === "en" || _lg === "fr") p.push(_lg);
  if (job.opts && job.opts.name) p.push(String(job.opts.name).replace(/\s+/g, ""));
  return (p.join("-").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 50) || "video") + "-" + stamp();
}
async function runOne(job) {
  const brand = reg.byId[job.brand];
  if (!brand) throw new Error("onbekend merk");
  // SLOT: niet-walkthrough renders delen de kritieke (random) sectie met de mail-plaatjes ->
  // via renderLock gaan ze om de beurt, nooit tegelijk. De walkthrough is extern/traag en
  // botst niet op de generator, dus die lockt niet (anders blokkeert 'ie de plaatjes minuten).
  const render = (job.template === "walkthrough")
    ? await brand.makeRender({ subjectId: job.subject, templateId: job.template, opts: job.opts || {}, format: job.format || "9:16", log })
    : await renderLock(() => brand.makeRender({ subjectId: job.subject, templateId: job.template, opts: job.opts || {}, format: job.format || "9:16", log }));
  // Een render mag de effectieve taal corrigeren (bv. walkthrough valt FR terug op EN) ->
  // dan klopt de taal in de bestandsnaam met wat er echt in de video staat.
  if (render && render.lang) job = { ...job, opts: { ...(job.opts || {}), lang: render.lang } };
  const base = outBase(job);
  // kant-en-klare mp4 (bv. website-walkthrough) -> direct met nette naam neerzetten
  if (render && render.prebuilt && existsSync(render.prebuilt)) {
    const outName = base + ".mp4";
    await fs.copyFile(render.prebuilt, path.resolve(OUT, outName));
    // werkmap van de walkthrough (.walk-*) meteen opruimen -> out blijft netjes
    if (render.cleanup) { try { await fs.rm(render.cleanup, { recursive: true, force: true }); } catch {} }
    log(`✓ klaar: /out/${outName}`);
    return { url: "/out/" + outName };
  }
  const music = job.music ? path.resolve(ROOT, config.audioDir, job.music) : (render.music || "");
  if (music) log(`♪ muziek: ${path.basename(music)}${job.music ? "" : " (automatisch)"}`);
  const r = await renderToMp4({ render, music, outDir: OUT, log, namePrefix: brand.id });
  const nice = base + ".mp4";
  try { await fs.rename(r.outPath, path.resolve(OUT, nice)); log(`✓ klaar: /out/${nice}`); return { url: "/out/" + nice }; }
  catch { log(`✓ klaar: /out/${r.outName}`); return { url: "/out/" + r.outName }; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await fs.readFile(path.resolve(ROOT, "studio/engine.html"))); return; }
    if (u.pathname.startsWith("/out/")) {
      const f = path.resolve(OUT, decodeURIComponent(u.pathname.slice(5)));
      if (!f.startsWith(OUT)) { res.writeHead(403); res.end("nee"); return; }   // geen pad-uitbraak
      if (existsSync(f)) { const ct = CT[path.extname(f).toLowerCase()] || "application/octet-stream"; res.writeHead(200, { "content-type": ct, "cache-control": "no-cache" }); res.end(await fs.readFile(f)); return; }
      res.writeHead(404); res.end("nope"); return;
    }
    if (u.pathname === "/api/log") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); res.write(`data: ${JSON.stringify("— verbonden —")}\n\n`); logClients.add(res); req.on("close", () => logClients.delete(res)); return; }
    if (u.pathname === "/api/brands") { json(res, { brands: reg.brands.map((b) => ({ id: b.id, name: b.name })) }); return; }
    if (u.pathname === "/api/subjects") { const b = reg.byId[u.searchParams.get("brand")]; if (!b) { json(res, { subjects: [] }); return; } json(res, { subjects: await b.listSubjects() }); return; }
    if (u.pathname === "/api/templates") { const b = reg.byId[u.searchParams.get("brand")]; if (!b) { json(res, { templates: [] }); return; } json(res, { templates: b.templates, options: b.options || [] }); return; }
    if (u.pathname === "/api/music") { let files = []; try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); } catch {} json(res, { files }); return; }
    if (u.pathname === "/api/images") {
      const b = reg.byId[u.searchParams.get("brand")];
      const pool = u.searchParams.get("pool") || "images";   // images | mockups | sfeer
      const fn = b && (pool === "sfeer" ? b.listSfeer : pool === "mockups" ? b.listMockups : b.listImages);
      if (!fn) { json(res, { images: [] }); return; }
      json(res, { images: await fn() }); return;
    }
    if (u.pathname === "/api/audio") { const f = u.searchParams.get("f") || ""; if (!/^[\w.\- ]+\.(mp3|wav|m4a|aac|ogg)$/i.test(f)) { res.writeHead(404); res.end(""); return; } const p = path.resolve(ROOT, config.audioDir, f); if (existsSync(p)) { res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "max-age=3600" }); res.end(await fs.readFile(p)); return; } res.writeHead(404); res.end(""); return; }
    if (u.pathname === "/api/tot-thumb") {
      const b = reg.byId["taleoftiles"]; const p = (u.searchParams.get("p") || "").replace(/\.svg$/i, "");
      if (!b || !b.thumbSvg || !/^[A-Za-z0-9_-]+$/.test(p)) { res.writeHead(404); res.end(""); return; }
      try { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" }); res.end(await b.thumbSvg(p)); } catch { res.writeHead(404); res.end(""); } return;
    }
    if (u.pathname === "/api/library") {
      const items = [];
      // 1) video's: losse mp4's in de out-map
      try {
        for (const f of await fs.readdir(OUT)) {
          if (!/\.mp4$/i.test(f)) continue;
          if (/-\d{12,}\.mp4$/i.test(f)) continue;   // tijdelijke render-output (naam = Date.now()), nog niet hernoemd
          let st; try { st = await fs.stat(path.join(OUT, f)); } catch { continue; }
          if (st.size < 4096) continue;              // halve/onvoltooide render overslaan
          const meta = parseOutName(f.replace(/\.mp4$/i, ""));
          items.push({
            kind: "video", url: "/out/" + encodeURIComponent(f), file: f,
            brand: meta.brand, brandName: meta.brand ? (BRAND_NAME[meta.brand] || meta.brand) : "—",
            type: meta.template, typeName: meta.template ? (TEMPLATE_NAME[meta.template] || titleCase(meta.template)) : "Video",
            name: meta.name || "", lang: meta.lang, date: meta.date,
            kb: Math.round(st.size / 1024), mtime: st.mtimeMs,
          });
        }
      } catch {}
      // 2) mail-stills: uit R2 (niet meer de lokale map), via het worker-endpoint.
      try {
        const resp = await fetch("https://taleoftiles.com/api/mail-stills");
        if (resp.ok) {
          for (const o of await resp.json()) {
            const file = String(o.key).replace(/^mail-stills\//, "");
            if (!/\.(jpe?g|png|webp)$/i.test(file)) continue;
            const bust = o.uploaded ? "?t=" + Date.parse(o.uploaded) : "";
            items.push({
              kind: "still",
              url: "https://taleoftiles.com/img/" + o.key + bust,
              file,
              brand: "taleoftiles", brandName: BRAND_NAME["taleoftiles"] || "Tale of Tiles",
              type: "mailstill", typeName: "Mail-still",
              name: titleCase(file.replace(/\.(jpe?g|png|webp)$/i, "").replace(/-/g, " ")),
              lang: "", date: null,
              kb: Math.round((o.size || 0) / 1024),
              mtime: o.uploaded ? Date.parse(o.uploaded) : 0,
            });
          }
        }
      } catch {}
      items.sort((a, b) => b.mtime - a.mtime);
      json(res, { items, brands: reg.brands.map((b) => ({ id: b.id, name: b.name })) });
      return;
    }
    if (u.pathname === "/api/mailstill" && req.method === "POST") {
      const bd = await readBody(req);
      // Outreach roept per lead 1 naam + 1 stijl aan ({naam, stijl}); de studio-tab stuurt een
      // lijst namen ({names}). Beide ondersteund. Stijl ontbreekt -> klassiek (backwards-compat).
      const style = normStyle(bd.stijl);
      const src = bd.naam != null ? [bd.naam] : (Array.isArray(bd.names) ? bd.names : String(bd.names || "").split("\n"));
      const names = src.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
      if (!names.length) { json(res, { error: "geen namen opgegeven" }, 400); return; }
      log(`▶ mail-plaatjes (${style}): ${names.length} bedrijf(ven)`);
      const items = [];
      for (const nm of names) {
        try { items.push(await enqueueMail(nm, style)); log(`✓ mail-still ${style}: ${nm}`); }
        catch (e) { items.push({ name: nm, style, error: e.message }); log(`✗ mail-still ${nm}: ${e.message}`); }
      }
      json(res, { items });
      return;
    }
    if (u.pathname === "/api/render" && req.method === "POST") {
      const bd = await readBody(req);
      if (!reg.byId[bd.brand]) { json(res, { error: "onbekend merk" }, 400); return; }
      // in de wachtrij; wacht op hét resultaat van deze job (zodat de speler de video toont)
      const result = await enqueue({ brand: bd.brand, subject: bd.subject, template: bd.template, format: bd.format || "9:16", music: bd.music || "", opts: bd.opts || {} });
      if (result.error) json(res, { error: result.error }, 500); else json(res, result);
      return;
    }
    if (u.pathname === "/api/render-all" && req.method === "POST") {
      const bd = await readBody(req);
      const brand = reg.byId[bd.brand];
      if (!brand) { json(res, { error: "onbekend merk" }, 400); return; }
      let n = 0;
      for (const t of brand.templates) {
        // Per-type max-duur: kies je bv. 45s voor "render alles", dan worden de types die
        // alleen REKKEN (en dus sloom worden bij lange duur) automatisch kort gehouden; de
        // types die juist MEER brengen bij langere duur pakken gewoon je gekozen duur.
        const opts = { ...(bd.opts || {}) };
        const cap = TYPE_MAX_SEC[t.id];
        if (cap && Number.isFinite(Number(opts.durationSec)) && Number(opts.durationSec) > cap) opts.durationSec = cap;
        enqueue({ brand: bd.brand, subject: bd.subject || null, template: t.id, format: bd.format || "9:16", music: bd.music || "", opts });
        n++;
      }
      log(`▶ wachtrij: ${n} types toegevoegd — ze worden één voor één gemaakt`);
      json(res, { queued: n });
      return;
    }

    // ---- SOCIAL-ARM endpoints (los van render + mail) ----
    // Elk platform (youtube/…) heeft DRIE taal-accounts (NL/EN/FR), elk eigen token.
    // Geeft per account de echte koppel-status (connected + kanaalnaam) terug.
    if (u.pathname === "/api/social/channels") {
      const accounts = [];
      for (const a of social.listAccounts()) {
        let connected = false, who = "";
        const p = social.platById[a.platform];
        if (p && p.enabled && p.authStatus) { try { const s = await p.authStatus(a.lang); connected = !!s.connected; who = s.who || ""; } catch {} }
        accounts.push({ ...a, connected, who });
      }
      json(res, { platforms: social.listPlatforms(), accounts, langs: social.LANGS });
      return;
    }
    // LOGIN: start de OAuth-koppeling voor één platform+taal. Opent de browser (desktop-flow)
    // en lost op zodra de gebruiker is ingelogd en het token lokaal is opgeslagen.
    if (u.pathname === "/api/social/login" && req.method === "POST") {
      const bd = await readBody(req);
      const p = social.platById[bd.platform];
      const lang = ["en", "fr"].includes(bd.lang) ? bd.lang : "nl";
      if (!p || !p.enabled || !p.startLogin) { json(res, { error: "kan dit platform niet koppelen" }, 400); return; }
      try { const r = await p.startLogin(lang, log); json(res, { ok: true, ...(r || {}) }); }
      catch (e) { log(`✗ koppelen ${bd.platform} ${lang.toUpperCase()}: ${e.message}`); json(res, { error: e.message }, 500); }
      return;
    }
    // Postbare video's = de afgewerkte mp4's in out/ (zelfde bron als de Bibliotheek). Per video
    // alleen het taal-account dat bij de taal van de video past (EN-video -> YouTube EN, enz.),
    // met de post-status per platform uit de store. posts gesleuteld op "<platform>-<lang>".
    if (u.pathname === "/api/social/videos") {
      const items = [];
      try {
        for (const f of await fs.readdir(OUT)) {
          if (!/\.mp4$/i.test(f)) continue;
          if (/-\d{12,}\.mp4$/i.test(f)) continue;   // tijdelijke render-output, nog niet hernoemd
          let st; try { st = await fs.stat(path.join(OUT, f)); } catch { continue; }
          if (st.size < 4096) continue;
          const meta = parseOutName(f.replace(/\.mp4$/i, ""));
          const lang = ["en", "fr"].includes(meta.lang) ? meta.lang : "nl";
          items.push({
            url: "/out/" + encodeURIComponent(f), file: f,
            brand: meta.brand, brandName: meta.brand ? (BRAND_NAME[meta.brand] || meta.brand) : "—",
            type: meta.template, typeName: meta.template ? (TEMPLATE_NAME[meta.template] || titleCase(meta.template)) : "Video",
            name: meta.name || "", lang, date: meta.date,
            kb: Math.round(st.size / 1024), mtime: st.mtimeMs,
            posts: await socialStore.forFile(f),
          });
        }
      } catch {}
      items.sort((a, b) => b.mtime - a.mtime);
      json(res, { items, platforms: social.listPlatforms() });
      return;
    }
    // Auto-teksten voorstellen voor één video (titel/omschrijving/tags) in de taal van de video.
    // platform bepaalt de hashtag-stijl; nu identiek per platform maar per-platform aanpasbaar.
    if (u.pathname === "/api/social/suggest") {
      const p = social.platById[u.searchParams.get("platform") || "youtube"] || social.platById.youtube;
      const type = u.searchParams.get("type") || "satisfying";
      const lang = u.searchParams.get("lang") || "nl";
      const name = u.searchParams.get("name") || "";
      json(res, p.suggest({ type, lang, name }));
      return;
    }
    // Teksten bewaren (concept) zonder te posten — de menselijke poort: eerst keuren/bewerken.
    if (u.pathname === "/api/social/save" && req.method === "POST") {
      const bd = await readBody(req);
      const lang = ["en", "fr"].includes(bd.lang) ? bd.lang : "nl";
      if (!bd.file || !bd.platform) { json(res, { error: "file en platform verplicht" }, 400); return; }
      const rec = await socialStore.set(bd.file, bd.platform, lang, {
        title: String(bd.title || "").slice(0, 100),
        description: String(bd.description || ""),
        tags: Array.isArray(bd.tags) ? bd.tags.slice(0, 15) : [],
        status: "draft",
      });
      json(res, { ok: true, post: rec });
      return;
    }
    // POSTEN: nu nog het casco. Het echte uploaden per taal-account komt in stap 2; tot dan geeft
    // het platform een nette fout terug en leggen we de status als "failed" vast (met reden).
    if (u.pathname === "/api/social/post" && req.method === "POST") {
      const bd = await readBody(req);
      const p = social.platById[bd.platform];
      const lang = ["en", "fr"].includes(bd.lang) ? bd.lang : "nl";
      if (!bd.file || !p) { json(res, { error: "onbekend platform of geen video" }, 400); return; }
      if (!p.enabled) { json(res, { error: p.label + " — binnenkort" }, 400); return; }
      // DUBBEL POSTEN VOORKOMEN: al geplaatst naar dit kanaal in deze taal? Dan weigeren tenzij
      // de UI expliciet force meestuurt (gebruiker bevestigde "toch nog een keer").
      const existing = await socialStore.get(bd.file, bd.platform, lang);
      if (existing && existing.status === "posted" && !bd.force) {
        json(res, { error: "al geplaatst", already: true, post: existing }, 409);
        return;
      }
      const meta = { title: bd.title || "", description: bd.description || "", tags: bd.tags || [] };
      await socialStore.set(bd.file, bd.platform, lang, { ...meta, status: "posting" });
      log(`▶ social: ${bd.platform} ${lang.toUpperCase()} ← ${bd.file}`);
      try {
        const r = await p.upload(path.resolve(OUT, bd.file), meta, lang, log);
        const rec = await socialStore.set(bd.file, bd.platform, lang, { status: "posted", postId: r.postId || "", url: r.url || "", at: Date.now() });
        log(`✓ social: ${bd.platform} ${lang.toUpperCase()} geplaatst — ${r.url || r.postId || ""}`);
        json(res, { ok: true, post: rec });
      } catch (e) {
        const rec = await socialStore.set(bd.file, bd.platform, lang, { status: "failed", error: e.message });
        log(`✗ social: ${bd.platform} ${lang.toUpperCase()} — ${e.message}`);
        json(res, { error: e.message, post: rec }, 500);
      }
      return;
    }

    res.writeHead(404); res.end("nope");
  } catch (e) { log("✗ serverfout: " + e.message); json(res, { error: e.message }, 500); }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Content Engine (generiek)  ->  ${url}\n  (laat dit venster open; dit is de server)\n`);
  if (process.env.STUDIO_NO_OPEN) return;
  try { const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]; spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref(); } catch {}
});

