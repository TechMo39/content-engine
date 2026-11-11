// GENERIEKE STUDIO-SERVER. Kiest: merk -> onderwerp -> template -> opties -> render.
// Weet zelf niks van tegels; dat zit in de merk-modules. Start: npm run engine
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFile } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { buildRegistry } from "./registry.mjs";
import { buildSocial } from "./social/index.mjs";
import { makeSocialStore } from "./social/store.mjs";
import { loadEnv } from "./social/env.mjs";
import { r2Put, r2Delete } from "./social/r2.mjs";
import { renderToMp4 } from "./core/renderer.mjs";
import { overlayAudio } from "./core/audio-overlay.mjs";
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

// ---- OUTPUT-ORDENING (kanaal-as, stap 1) -------------------------------------------------
// Renders landen per merk in een eigen submap van out/, i.p.v. allemaal plat in out/.
//  - BEDRIJVEN (planner, wegwerp): out/<merk>/  -> met de archief->prullenbak-lifecycle (render_dag.mjs)
//  - CHANNELS (handgemaakt): blijven voorlopig plat in out/ en verhuizen in stap 2 naar out/channels/<kanaal>/
// Alles backwards-compatible: oude losse mp4's in out/ worden nog gewoon gelezen én opgeruimd.
const BUSINESS_BRANDS = new Set(["taleoftiles", "unclerank"]);
function outSubFor(brandId) { return BUSINESS_BRANDS.has(brandId) ? brandId : "channels/" + brandId; }
// Mappen in out/ die GEEN renders zijn (nooit als video tonen/opruimen).
const OUT_SKIP_DIRS = new Set(["archief", "geplaatst", "mail-stills", "carrousel", "logs"]);
// Alle afgewerkte renders onder out/ (losse out/ + bedrijfsmappen + later channels/<kanaal>/),
// tot 2 niveaus diep. Geeft per video het rel-pad t.o.v. out/ (= de sleutel overal: url, store, delete).
async function listRenderFiles() {
  const found = [];
  async function walk(dir, rel, depth) {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (depth >= 2 || e.name.startsWith(".") || OUT_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name), rel ? rel + "/" + e.name : e.name, depth + 1);
      } else if (/\.mp4$/i.test(e.name)) {
        if (/-\d{12,}\.mp4$/i.test(e.name)) continue;   // tijdelijke render-output, nog niet hernoemd
        const abs = path.join(dir, e.name);
        let st; try { st = await fs.stat(abs); } catch { continue; }
        if (st.size < 4096) continue;
        found.push({ rel: rel ? rel + "/" + e.name : e.name, base: e.name, abs, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  await walk(OUT, "", 0);
  return found;
}
// Rel-pad -> veilige /out/-URL (elk segment apart ge-encodeerd).
function outUrl(rel) { return "/out/" + String(rel).split("/").map(encodeURIComponent).join("/"); }

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
  droste: 60,   // oneindige inzoom: duur wordt gesnapt op hele tunnel-cycli (naadloze loop)
};

const social = buildSocial({ ROOT, publicUrlFor });
const socialStore = makeSocialStore(OUT);

// ---- PLANNING (laag 2): dagvoorstel -> jij keurt goed/swapt. Opslag out/.plan.json. ----
const PLAN_FILE = path.join(OUT, ".plan.json");
const PLAN_TIMES = ["11:00", "19:00"];
const PLAN_LANGS = ["nl", "en", "fr"];
const planToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });   // Europese dag
async function readPlan() { try { return JSON.parse(await fs.readFile(PLAN_FILE, "utf8")); } catch { return {}; } }
async function writePlan(p) { try { await fs.writeFile(PLAN_FILE, JSON.stringify(p, null, 2)); } catch {} }
// Verse video-kandidaten uit out/ (zelfde bron als de Bibliotheek).
async function planCandidates() {
  const out = [];
  // PLANNER = de BEDRIJVEN (semi-automatisch): alleen renders van bedrijf-merken komen in de
  // kandidatenpool. Channels (handgemaakt) plan je niet, die horen hier niet thuis.
  try {
    for (const r of await listRenderFiles()) {
      const m = parseOutName(r.base.replace(/\.mp4$/i, ""));
      if (!BUSINESS_BRANDS.has(m.brand)) continue;
      const _d = new Date(r.mtimeMs), _p = (n) => String(n).padStart(2, "0");
      const datum = _p(_d.getDate()) + "-" + _p(_d.getMonth() + 1) + " " + _p(_d.getHours()) + ":" + _p(_d.getMinutes());
      out.push({ file: r.rel, url: outUrl(r.rel), type: m.template || null, typeName: m.template ? (TEMPLATE_NAME[m.template] || titleCase(m.template)) : "Video", lang: ["en", "fr"].includes(m.lang) ? m.lang : "nl", name: m.name || "", datum, mtime: r.mtimeMs });
    }
  } catch {}
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}
// Al geposte of al geplande bestanden -> niet opnieuw voorstellen.
async function planUsedFiles() {
  const used = new Set();
  try { for (const r of await socialStore.all()) if (r && r.file) used.add(r.file); } catch {}
  const p = await readPlan();
  for (const d of Object.keys(p)) for (const s of ((p[d] && p[d].slots) || [])) if (s.file) used.add(s.file);
  return used;
}
log("social-platforms: " + social.platforms.map((p) => p.id + (p.enabled ? "" : "·stub")).join(", ") + " × " + social.LANGS.join("/"));

// ---- ANTI-HERHALING: welke titels/omschrijvingen zijn al gepost (of als concept bewaard) voor
// een bepaald video-TYPE + taal. Leest het sociale logboek, bepaalt het type uit de bestandsnaam
// (zelfde parser als de Bibliotheek), en geeft de teksten terug met de nieuwste eerst. suggest()
// kiest daarmee een variant die nog niet gebruikt is. Puur lezen; raakt niets aan de render/mail.
async function recentTexts(type, lang) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  const rows = [];
  try {
    for (const r of await socialStore.all()) {
      if (!r || (r.lang || "nl") !== lg) continue;
      const meta = parseOutName(String(r.file || "").replace(/\.mp4$/i, ""));
      if (meta.template !== type) continue;
      if (!r.title && !r.description) continue;
      rows.push(r);
    }
  } catch {}
  rows.sort((a, b) => (b.updated || b.at || 0) - (a.updated || a.at || 0));   // nieuwste eerst
  return {
    titles: rows.map((r) => r.title).filter(Boolean),
    // alleen de eerste regel van de omschrijving vergelijken (zonder de hashtag-staart)
    descs: rows.map((r) => String(r.description || "").split("\n")[0]).filter(Boolean),
  };
}

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

// ================= CARROUSEL (swipebare IG/FB foto-post) — EIGEN SPOOR, los van de video-planner =================
// Een carrousel is GEEN video. Hij leeft volledig apart in out/carrousel/ en raakt de video-
// planner/poster NIET aan. Per taal: 2 beelden (ontwerp + echte foto, van het dagelijkse
// before/after-paar van de site) + een manifest met de post-status per kanaal. Flow in de UI:
// "Maak carrousel" -> beelden verschijnen ter GOEDKEURING -> per taal 1 knop "Post naar IG+FB".
// Pinterest pikt de Engelse IG-post daarna zelf op (niks voor te bouwen).
const CAROUSEL_DIR = path.resolve(OUT, "carrousel");
async function readCarManifest(lang) {
  try { return JSON.parse(await fs.readFile(path.join(CAROUSEL_DIR, lang + ".json"), "utf8")); } catch { return null; }
}
async function writeCarManifest(lang, data) {
  await fs.mkdir(CAROUSEL_DIR, { recursive: true });
  await fs.writeFile(path.join(CAROUSEL_DIR, lang + ".json"), JSON.stringify(data, null, 2));
}
// Genereer de 2 beelden voor één taal via de merk-module (makeCarouselScenes), rastert ze naar
// jpg in out/carrousel/, en schrijft/ververst het manifest (post-status blijft behouden als die
// er al was en het nog hetzelfde ontwerp is). Serialiseert via renderLock (gedeelde generator).
async function makeCarousel(lang) {
  const brand = reg.byId["taleoftiles"];
  if (!brand || !brand.makeCarouselScenes) throw new Error("merk taleoftiles kent geen carrousel");
  lang = ["en", "fr"].includes(lang) ? lang : "nl";
  await fs.mkdir(CAROUSEL_DIR, { recursive: true });
  const built = await renderLock(() => brand.makeCarouselScenes({ opts: { lang }, log }));
  const scenes = built.scenes || [];
  if (scenes.length < 2) throw new Error("carrousel: minder dan 2 beelden");
  const caption = (built.caption || "").trim();
  const slug = slugify(caption || "carrousel");
  const images = [];
  for (let i = 0; i < scenes.length; i++) {
    const png = new Resvg(scenes[i], { fitTo: { mode: "width", value: built.W || 1080 }, font: { loadSystemFonts: true, fontFiles: FONT_FILES } }).render().asPng();
    const tmp = path.join(os.tmpdir(), "totcar-" + Date.now() + "-" + i + ".png");
    await fs.writeFile(tmp, png);
    const jpg = `${lang}-${slug}-${i + 1}.jpg`;
    spawnSync(ffmpegPath, ["-y", "-v", "error", "-i", tmp, "-q:v", "3", path.join(CAROUSEL_DIR, jpg)], { stdio: "ignore", windowsHide: true });
    try { await fs.unlink(tmp); } catch {}
    images.push(jpg);
  }
  // nieuw ontwerp -> post-status resetten; zelfde ontwerp -> bestaande status bewaren
  const prev = await readCarManifest(lang);
  const posts = (prev && prev.slug === slug) ? (prev.posts || {}) : {};
  const man = { lang, slug, caption, images, posts, created: Date.now() };
  await writeCarManifest(lang, man);
  log(`✓ carrousel ${lang.toUpperCase()}: ${images.length} beelden (${caption || "zonder naam"})`);
  return man;
}
// Post één taal-carrousel naar één kanaal (instagram|facebook) via het platform z'n uploadCarousel.
async function postCarousel(lang, platform) {
  const man = await readCarManifest(lang);
  if (!man || !(man.images || []).length) throw new Error("geen carrousel voor " + lang.toUpperCase());
  const p = social.platById[platform];
  if (!p || typeof p.uploadCarousel !== "function") throw new Error(platform + " kan geen carrousel posten");
  const imgs = man.images.map((im) => path.join(CAROUSEL_DIR, im));
  const meta = { title: man.caption || "", description: (p.suggest ? (p.suggest({ type: "insitu", lang, name: man.caption }).description || "") : "") };
  const r = await p.uploadCarousel(imgs, meta, lang, log);
  man.posts = man.posts || {};
  man.posts[platform] = { status: "posted", postId: r.postId || "", url: r.url || "", at: Date.now() };
  await writeCarManifest(lang, man);
  return r;
}

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
  let gedaan = 0, mislukt = 0;
  while (queue.length) {
    const { job, resolve } = queue.shift();
    try {
      log(`▶ render — ${job.brand}/${job.template || "-"} (${job.format || "9:16"})${queue.length ? `  · nog ${queue.length} in de rij` : ""}`);
      const r = await runOne(job);
      // Een render die geen bruikbaar resultaat teruggeeft telt ook als mislukt, zodat
      // een stille leegloop (bv. walkthrough zonder prebuilt) niet onopgemerkt verdwijnt.
      if (r && r.error) { mislukt++; log(`✗ FOUT: ${job.template || "-"} — ${r.error}`); }
      else if (!r || !r.url) { mislukt++; log(`✗ FOUT: ${job.template || "-"} — geen video teruggekregen`); }
      else gedaan++;
      resolve(r);
    } catch (e) { mislukt++; log(`✗ FOUT: ${job.template || "-"} — ${e.message}`); resolve({ error: e.message }); }
  }
  running = false;
  // Eindtelling pas loggen als er echt een batch was (meer dan één gemaakt of iets mislukt).
  if (gedaan + mislukt > 1 || mislukt) log(`■ wachtrij leeg — ${gedaan} klaar${mislukt ? `, ${mislukt} mislukt` : ""}`);
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
    const sub = outSubFor(job.brand);
    const subDir = sub ? path.resolve(OUT, sub) : OUT;
    await fs.mkdir(subDir, { recursive: true });
    const outName = base + ".mp4";
    await fs.copyFile(render.prebuilt, path.resolve(subDir, outName));
    // werkmap van de walkthrough (.walk-*) meteen opruimen -> out blijft netjes
    if (render.cleanup) { try { await fs.rm(render.cleanup, { recursive: true, force: true }); } catch {} }
    const relUrl = sub ? sub + "/" + outName : outName;
    log(`✓ klaar: /out/${relUrl}`);
    return { url: "/out/" + relUrl };
  }
  const music = job.music ? path.resolve(ROOT, config.audioDir, job.music) : (render.music || "");
  if (music) log(`♪ muziek: ${path.basename(music)}${job.music ? "" : " (automatisch)"}`);
  const r = await renderToMp4({ render, music, outDir: OUT, log, namePrefix: brand.id });
  // AUDIO-OVERLAY (additief): alleen als de render extra sporen meelevert (bv. Umma stem/SFX).
  // Tegel-/mailrenders geven geen render.audio mee, dus die worden hier nooit geraakt.
  if (render.audio && Array.isArray(render.audio.tracks) && render.audio.tracks.length) {
    try { await overlayAudio({ mp4: r.outPath, tracks: render.audio.tracks, hasBaseAudio: !!music, log }); }
    catch (e) { log("audio-overlay overgeslagen: " + e.message); }
  }
  const sub = outSubFor(job.brand);
  const subDir = sub ? path.resolve(OUT, sub) : OUT;
  await fs.mkdir(subDir, { recursive: true });
  const nice = base + ".mp4";
  const relUrl = sub ? sub + "/" + nice : nice;
  try { await fs.rename(r.outPath, path.resolve(subDir, nice)); log(`✓ klaar: /out/${relUrl}`); return { url: "/out/" + relUrl }; }
  catch { log(`✓ klaar: /out/${r.outName}`); return { url: "/out/" + r.outName }; }
}

// MEDIA SERVEREN MET RANGE-ONDERSTEUNING. Een <audio>/<video>-element in de app vraagt een
// mediabestand per byte-range op en wil het als SEEKBAAR openen. Als de server altijd 200 + de
// hele buffer terugstuurt zonder "Accept-Ranges", blijft het element wachten (de mp3-muziek/SFX
// hingen daardoor en speelden nooit; de video in de preview kon niet seeken). Deze helper leest de
// bestandsgrootte, honoreert een "Range: bytes=.."-verzoek met 206 Partial Content + stream, en
// zet op elk antwoord "Accept-Ranges: bytes". Streamt (createReadStream) i.p.v. alles in geheugen.
function serveMedia(req, res, filePath, contentType) {
  let st;
  try { st = statSync(filePath); } catch { res.writeHead(404); res.end(""); return; }
  const total = st.size;
  const baseHeaders = { "content-type": contentType, "accept-ranges": "bytes", "cache-control": "max-age=3600" };
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { ...baseHeaders, "content-range": `bytes */${total}` });
      res.end(""); return;
    }
    res.writeHead(206, { ...baseHeaders, "content-range": `bytes ${start}-${end}/${total}`, "content-length": (end - start + 1) });
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => { try { res.end(); } catch {} });
    stream.pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, "content-length": total });
  const stream = createReadStream(filePath);
  stream.on("error", () => { try { res.end(); } catch {} });
  stream.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await fs.readFile(path.resolve(ROOT, "studio/engine.html"))); return; }
    // TWEEDE STUDIO — Umma United scène-editor (eigen pagina, los van de tegel-studio).
    if (u.pathname === "/channels") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await fs.readFile(path.resolve(ROOT, "studio/channel.html"))); return; }
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
    // ---- PLANNING-endpoints (laag 2) ----
    if (u.pathname === "/api/plan" && req.method === "GET") {
      const date = u.searchParams.get("date") || planToday();
      const plan = await readPlan();
      const slots = (plan[date] && plan[date].slots) || [];
      // LIVE post-status per slot uit het sociale logboek (PUUR LEZEN): welke kanalen van dit
      // bestand+taal zijn echt geplaatst (posted) of mislukt (failed). Zo kan de Planning een
      // waarschuwing tonen zonder iets aan de render/mail/poster te veranderen.
      for (const s of slots) {
        if (!s || !s.file) continue;
        try {
          const recs = await socialStore.forFile(s.file);
          const posted = [], failed = [];
          for (const r of Object.values(recs)) {
            if (!r || (r.lang || "nl") !== (s.lang || "nl")) continue;
            if (r.status === "posted") posted.push(r.platform);
            else if (r.status === "failed") failed.push(r.platform);
          }
          s.live = { posted, failed };
        } catch {}
      }
      json(res, { date, times: PLAN_TIMES, langs: PLAN_LANGS, slots, candidates: await planCandidates(), accounts: social.listAccounts() });
      return;
    }
    if (u.pathname === "/api/plan/propose" && req.method === "POST") {
      const bd = await readBody(req);
      const date = bd.date || planToday();
      const cands = await planCandidates();
      const used = await planUsedFiles();
      const byLang = {};
      for (const l of PLAN_LANGS) byLang[l] = cands.filter((c) => c.lang === l && !used.has(c.file));
      const slots = [];
      for (const time of PLAN_TIMES) {
        for (const lang of PLAN_LANGS) {
          const pool = byLang[lang];
          const gekozen = slots.filter((s) => s.lang === lang).map((s) => s.type);   // spreiding: ander type per taal
          const pick = pool.find((c) => !gekozen.includes(c.type)) || pool[0] || null;
          if (pick) pool.splice(pool.indexOf(pick), 1);
          slots.push({ time, lang, file: pick ? pick.file : null, url: pick ? pick.url : null, type: pick ? pick.type : null, typeName: pick ? pick.typeName : null, platforms: [], status: "concept" });
        }
      }
      const plan = await readPlan();
      plan[date] = { slots };
      await writePlan(plan);
      json(res, { date, slots });
      return;
    }
    if (u.pathname === "/api/plan/save" && req.method === "POST") {
      const bd = await readBody(req);
      const date = bd.date || planToday();
      const plan = await readPlan();
      plan[date] = { slots: (bd.slots || []).map((s) => ({ time: s.time, lang: s.lang, file: s.file || null, url: s.url || null, type: s.type || null, typeName: s.typeName || null, platforms: Array.isArray(s.platforms) ? s.platforms : [], status: s.status || "gepland" })) };
      await writePlan(plan);
      json(res, { ok: true, date, slots: plan[date].slots });
      return;
    }
    // Weekoverzicht: 7 dagen (ma-zo) rond de gevraagde datum, met tellingen per dag.
    if (u.pathname === "/api/plan/week" && req.method === "GET") {
      const base = u.searchParams.get("date") || planToday();
      const d = new Date(base + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // terug naar maandag
      const plan = await readPlan();
      const days = [];
      for (let i = 0; i < 7; i++) {
        const dd = new Date(d); dd.setUTCDate(d.getUTCDate() + i);
        const ds = dd.toISOString().slice(0, 10);
        const slots = (plan[ds] && plan[ds].slots) || [];
        days.push({ date: ds, filled: slots.filter((s) => s.file).length, gepland: slots.filter((s) => s.status === "gepland").length });
      }
      json(res, { weekStart: days[0].date, days });
      return;
    }
    // Kandidaat afkeuren = mp4 uit out/ verwijderen (reject).
    if (u.pathname === "/api/candidate/delete" && req.method === "POST") {
      const bd = await readBody(req);
      const f = String(bd.file || "");
      if (!f || f.includes("..") || path.isAbsolute(f) || !/\.mp4$/i.test(f)) { json(res, { error: "ongeldige bestandsnaam" }, 400); return; }
      const p = path.resolve(OUT, f);
      if (p !== OUT && !p.startsWith(OUT + path.sep)) { json(res, { error: "nee" }, 403); return; }
      try { await fs.unlink(p); json(res, { ok: true }); } catch (e) { json(res, { error: e.message }, 500); }
      return;
    }
    if (u.pathname === "/api/music") { let files = []; try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); } catch {} json(res, { files }); return; }
    // UMMA — muziek UITSLUITEND uit de eigen map assets/channels/channel1/muziek/ (gescheiden van Tale of Tiles).
    if (u.pathname === "/api/channel-music") { let files = []; try { files = (await fs.readdir(path.resolve(ROOT, "assets/channels/channel1/muziek"))).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); } catch {} json(res, { files }); return; }
    if (u.pathname === "/api/channel-audio") { const f = u.searchParams.get("f") || ""; if (!/^[\w.\- ]+\.(mp3|wav|m4a|aac|ogg)$/i.test(f)) { res.writeHead(404); res.end(""); return; } const p = path.resolve(ROOT, "assets/channels/channel1/muziek", f); if (existsSync(p)) { serveMedia(req, res, p, "audio/mpeg"); return; } res.writeHead(404); res.end(""); return; }
    // UMMA SFX — serveer een effect-bestand uit assets/channels/channel1/sfx/ zodat de studio-preview de SFX kan afspelen
    if (u.pathname === "/api/channel-sfx") { const f = u.searchParams.get("f") || ""; if (!/^[\w.\- ]+\.(mp3|wav|m4a|aac|ogg)$/i.test(f)) { res.writeHead(404); res.end(""); return; } const p = path.resolve(ROOT, "assets/channels/channel1/sfx", f); if (existsSync(p)) { serveMedia(req, res, p, "audio/mpeg"); return; } res.writeHead(404); res.end(""); return; }
    // UMMA TIJDLIJN — de gedeelde databron voor de nieuwe scène-editor: het _timeline.json dat
    // umma_voice.py per stem schrijft (per scène de zinnen met exacte tijden). Puur lezen.
    if (u.pathname === "/api/channel-timeline" && req.method === "GET") {
      const story = (u.searchParams.get("story") || "sword").replace(/[^\w-]/g, "");
      const voice = (u.searchParams.get("voice") || "man").replace(/[^\w-]/g, "");
      const p = path.resolve(ROOT, "assets/channels/channel1/voice", story, voice, "_timeline.json");
      if (existsSync(p)) { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" }); res.end(await fs.readFile(p)); return; }
      json(res, { error: "geen _timeline.json gevonden; draai eerst python tools/channel_voice.py --voice " + voice }, 404); return;
    }
    // UMMA TIJDLIJN — de bewerkte tijdlijn opslaan (sleep-correcties, beeld-beats, sfx), terug naar
    // hetzelfde _timeline.json zodat de render exact deze tijdlijn leest (geen afwijking meer).
    if (u.pathname === "/api/channel-timeline-save" && req.method === "POST") {
      const bd = await readBody(req);
      if (!bd || !Array.isArray(bd.scenes)) { json(res, { error: "ongeldige tijdlijn" }, 400); return; }
      const story = String(bd.story || "sword").replace(/[^\w-]/g, "");
      const voice = String(bd.voice || "man").replace(/[^\w-]/g, "");
      const p = path.resolve(ROOT, "assets/channels/channel1/voice", story, voice, "_timeline.json");
      try { await fs.writeFile(p, JSON.stringify(bd, null, 2), "utf8"); json(res, { ok: true, saved: path.relative(ROOT, p).replace(/\\/g, "/") }); }
      catch (e) { json(res, { error: e.message }, 500); }
      return;
    }
    // UMMA STEM — een scène-wav teruggeven voor de audio-preview in de editor (01.wav .. 16.wav).
    if (u.pathname === "/api/channel-voice" && req.method === "GET") {
      const story = (u.searchParams.get("story") || "sword").replace(/[^\w-]/g, "");
      const voice = (u.searchParams.get("voice") || "man").replace(/[^\w-]/g, "");
      const n = (u.searchParams.get("n") || "").replace(/[^\d]/g, "");
      if (!n) { res.writeHead(404); res.end(""); return; }
      const p = path.resolve(ROOT, "assets/channels/channel1/voice", story, voice, n.padStart(2, "0") + ".wav");
      if (existsSync(p)) { serveMedia(req, res, p, "audio/wav"); return; }
      res.writeHead(404); res.end(""); return;
    }
    // UMMA BEELD — serveer het opgehaalde beeld/video per beat (uit assets/channels/channel1/video/) zodat
    // de editor een thumbnail per beat kan tonen en je de missers direct ziet.
    if (u.pathname.startsWith("/channel-media/")) {
      const base = path.resolve(ROOT, "assets/channels/channel1/video");
      const f = path.resolve(base, decodeURIComponent(u.pathname.slice("/channel-media/".length)));
      if (!f.startsWith(base)) { res.writeHead(403); res.end("nee"); return; }
      if (existsSync(f)) { const ct = CT[path.extname(f).toLowerCase()] || "application/octet-stream"; serveMedia(req, res, f, ct); return; }
      res.writeHead(404); res.end(""); return;
    }
    // UMMA POSTER — één stilstaand frame (jpg) uit een videobestand, zodat de studio-preview video's
    // als afbeelding kan tonen. De ingebouwde app-browser schildert mp4-frames niet betrouwbaar; een
    // jpg rendert altijd. Frames worden gecachet in assets/channels/channel1/video/.posters/.
    if (u.pathname === "/api/channel-poster" && req.method === "GET") {
      // f = optioneel één submap (verhaal) + bestandsnaam, bv. "chose/s01b1.mp4" of "s01b1.mp4"
      const raw = (u.searchParams.get("f") || "").replace(/\\/g, "/");
      if (raw.includes("..") || !/^(?:[\w-]+\/)?[\w.\- ]+\.(mp4|webm|mov|mkv|m4v)$/i.test(raw)) { res.writeHead(404); res.end(""); return; }
      const base = path.resolve(ROOT, "assets/channels/channel1/video");
      const src = path.resolve(base, raw);
      if ((src !== base && !src.startsWith(base + path.sep)) || !existsSync(src)) { res.writeHead(404); res.end(""); return; }
      const pdir = path.join(base, ".posters");
      const out = path.join(pdir, raw.replace(/\//g, "__").replace(/\.[^.]+$/, ".jpg"));
      const draw = (ss) => new Promise((resolve) => {
        execFile(ffmpegPath, ["-y", "-v", "error", "-ss", String(ss), "-i", src, "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", out], { windowsHide: true }, (e) => resolve(!e && existsSync(out)));
      });
      try {
        if (!existsSync(out)) {
          await fs.mkdir(pdir, { recursive: true });
          if (!(await draw(1))) await draw(0);   // korte clip? pak frame 0
        }
        if (!existsSync(out)) { res.writeHead(404); res.end(""); return; }
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-cache" });
        res.end(await fs.readFile(out));
      } catch (e) { res.writeHead(500); res.end(""); return; }
      return;
    }
    // UMMA BEELD — lijst van alle opgehaalde/geüploade bestanden in assets/channels/channel1/video/,
    // zodat de studio een weggegooid beeld terug kan koppelen en lege beats kan vullen.
    if (u.pathname === "/api/channel-media-list" && req.method === "GET") {
      // Beeld PER PROJECT: heeft dit verhaal een eigen beeldmap, dan tonen we alleen díé bestanden
      // (als verhaal/bestand). Bestaat die map nog niet (oud, plat project), dan de losse map — zo
      // blijft een bestaand plat project werken en ziet een nieuw project alleen z'n eigen beeld.
      const story = (u.searchParams.get("story") || "").replace(/[^\w-]/g, "");
      const rx = /\.(mp4|webm|jpg|jpeg|png|webp)$/i;
      let files = [];
      try {
        const sdir = story && path.resolve(ROOT, "assets/channels/channel1/video", story);
        if (sdir && existsSync(sdir)) files = (await fs.readdir(sdir)).filter((f) => rx.test(f)).map((f) => story + "/" + f);
        else files = (await fs.readdir(path.resolve(ROOT, "assets/channels/channel1/video"))).filter((f) => rx.test(f));
      } catch {}
      json(res, { files });
      return;
    }
    // UMMA BEELD — upload: zet een eigen plaatje/video per beat neer in assets/channels/channel1/video/
    // en geef het relatieve pad terug; de studio zet dat in beat.img of beat.vid.
    if (u.pathname === "/api/channel-beeld-upload" && req.method === "POST") {
      const bd = await readBody(req);
      const story = String(bd.story || "").replace(/[^\w-]/g, "");   // upload in de map van dit project
      let safe = String(bd.name || "beeld").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);
      const b64 = String(bd.dataB64 || "").replace(/^data:[^,]*,/, "");
      if (!b64) { json(res, { error: "geen beeld ontvangen" }, 400); return; }
      if (!/\.(mp4|webm|jpg|jpeg|png|webp)$/i.test(safe)) safe += ".jpg";
      const sub = story ? "assets/channels/channel1/video/" + story : "assets/channels/channel1/video";
      const dir = path.resolve(ROOT, sub); await fs.mkdir(dir, { recursive: true });
      const fname = Date.now() + "-" + safe;
      await fs.writeFile(path.join(dir, fname), Buffer.from(b64, "base64"));
      const isVid = /\.(mp4|webm)$/i.test(fname);
      const rel = (story ? story + "/" : "") + fname;
      json(res, { path: "assets/channels/channel1/video/" + rel, file: rel, kind: isVid ? "vid" : "img" });
      return;
    }
    // UMMA — audio-upload (stem/SFX per scène). Slaat op in assets/channels/channel1/audio/ en geeft het
    // relatieve pad terug; de Umma-studio zet dat pad per scène in opts. Los van alles hierboven.
    if (u.pathname === "/api/channel-upload" && req.method === "POST") {
      const bd = await readBody(req);
      const safe = String(bd.name || "clip").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 50);
      const b64 = String(bd.dataB64 || "").replace(/^data:[^,]*,/, "");
      if (!b64) { json(res, { error: "geen audio ontvangen" }, 400); return; }
      const dir = path.resolve(ROOT, "assets/channels/channel1/audio"); await fs.mkdir(dir, { recursive: true });
      const fname = Date.now() + "-" + (/\.(mp3|wav|m4a|aac|ogg)$/i.test(safe) ? safe : safe + ".mp3");
      await fs.writeFile(path.join(dir, fname), Buffer.from(b64, "base64"));
      json(res, { path: "assets/channels/channel1/audio/" + fname });
      return;
    }
    // UMMA — nieuwste klaarstaande import-script teruggeven, zodat de studio bij openen vanzelf
    // de scènes toont (geen plakken). Zoekt in assets/channels/channel1/voice/<verhaal>/<stem>/_import-*.txt,
    // pakt het meest recent gewijzigde. Puur lezen, raakt niets aan.
    if (u.pathname === "/api/channel-latest-script" && req.method === "GET") {
      try {
        const base = path.resolve(ROOT, "assets/channels/channel1/voice");
        let best = null;
        for (const story of await fs.readdir(base).catch(() => [])) {
          const sdir = path.join(base, story);
          for (const voice of await fs.readdir(sdir).catch(() => [])) {
            const vdir = path.join(sdir, voice);
            for (const f of await fs.readdir(vdir).catch(() => [])) {
              if (!/^_import-.*\.txt$/i.test(f)) continue;
              const fp = path.join(vdir, f);
              let st; try { st = await fs.stat(fp); } catch { continue; }
              if (!best || st.mtimeMs > best.mtime) best = { path: fp, mtime: st.mtimeMs, name: story + "/" + voice + "/" + f };
            }
          }
        }
        if (!best) { json(res, { text: null }); return; }
        json(res, { text: await fs.readFile(best.path, "utf8"), name: best.name });
      } catch (e) { json(res, { text: null, error: e.message }); }
      return;
    }
    // UMMA — ALLE klaarstaande import-scripts als lijst (voor "render alle delen"). Per deel+stem
    // één item met id (verhaal/stem), titel en de scripttekst. De studio kan ze zo achter elkaar
    // in de render-wachtrij zetten (de engine-wachtrij verwerkt ze één voor één).
    if (u.pathname === "/api/channel-scripts" && req.method === "GET") {
      const items = [];
      try {
        const base = path.resolve(ROOT, "assets/channels/channel1/voice");
        for (const story of (await fs.readdir(base).catch(() => [])).sort()) {
          const sdir = path.join(base, story);
          for (const voice of (await fs.readdir(sdir).catch(() => [])).sort()) {
            const vdir = path.join(sdir, voice);
            for (const f of await fs.readdir(vdir).catch(() => [])) {
              if (!/^_import-.*\.txt$/i.test(f)) continue;
              let text = ""; try { text = await fs.readFile(path.join(vdir, f), "utf8"); } catch { continue; }
              const titleLine = (text.split("\n").find((l) => /^title\s*:/i.test(l)) || "").replace(/^title\s*:/i, "").trim();
              items.push({ id: story + "/" + voice, story, voice, title: titleLine || story, text });
            }
          }
        }
      } catch {}
      json(res, { items });
      return;
    }
    // UMMA — live voorbeeld: rendert ÉÉN frame (midden in de gekozen scène) als PNG, zodat de
    // studio toont wat je maakt terwijl je bouwt. Geen video, dus snel. Alleen voor Umma.
    if (u.pathname === "/api/channel-preview" && req.method === "POST") {
      const bd = await readBody(req);
      const brand = reg.byId["channel1"];
      if (!brand) { json(res, { error: "umma niet geladen" }, 400); return; }
      try {
        const render = await brand.makeRender({ subjectId: null, templateId: "kaart", opts: bd.opts || {}, format: bd.format || "9:16", log: () => {} });
        const i = Math.max(0, Math.min((render.scenesCount || 1) - 1, Number(bd.scene) || 0));
        const frame = render.previewFrameFor ? render.previewFrameFor(i) : 0;
        const svg = render.sceneAt(frame);
        const png = new Resvg(svg, { fitTo: { mode: "width", value: 420 }, font: { loadSystemFonts: true, fontFiles: FONT_FILES } }).render().asPng();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" }); res.end(png); return;
      } catch (e) { json(res, { error: e.message }, 500); return; }
    }
    // UMMA — OVERZICHT-FRAME: rendert ÉÉN echt frame van een scène/beat uit dezelfde tekencode als
    // de video-render (techniek + chrome + ondertitel). Zo toont de studio ELKE scène zoals hij in
    // de video komt (ook de getekende, die vroeger alleen een grijs labeltje gaven). Video-beats
    // geven 204 terug -> de studio toont die rechtstreeks met het echte videobestand.
    if (u.pathname === "/api/channel-frame" && req.method === "GET") {
      const brand = reg.byId["channel1"];
      if (!brand || !brand.previewFrameSVG) { res.writeHead(404); res.end(""); return; }
      try {
        const r = await brand.previewFrameSVG({
          story: u.searchParams.get("story") || "sword",
          voice: u.searchParams.get("voice") || "man",
          sceneNum: u.searchParams.has("scene") ? Number(u.searchParams.get("scene")) : 1,
          beatIndex: Number(u.searchParams.get("beat")) || 0,
          p: u.searchParams.has("p") ? Number(u.searchParams.get("p")) : 0.6,
          format: u.searchParams.get("format") || "9:16",
        });
        if (!r || r.video) { res.writeHead(204); res.end(""); return; }
        const png = new Resvg(r.svg, { fitTo: { mode: "width", value: (r.W || 540) * 2 }, font: { loadSystemFonts: true, fontFiles: FONT_FILES } }).render().asPng();
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" }); res.end(png); return;
      } catch (e) { res.writeHead(404); res.end(""); return; }
    }
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
      // 1) video's: alle afgewerkte mp4's onder out/ (losse out/ + bedrijfsmappen + channels/<kanaal>/)
      try {
        for (const r of await listRenderFiles()) {
          const meta = parseOutName(r.base.replace(/\.mp4$/i, ""));
          items.push({
            kind: "video", url: outUrl(r.rel), file: r.rel,
            brand: meta.brand, brandName: meta.brand ? (BRAND_NAME[meta.brand] || meta.brand) : "—",
            type: meta.template, typeName: meta.template ? (TEMPLATE_NAME[meta.template] || titleCase(meta.template)) : "Video",
            name: meta.name || "", lang: meta.lang, date: meta.date,
            kb: Math.round(r.size / 1024), mtime: r.mtimeMs,
          });
        }
      } catch {}
      // 2) mail-stills: BEWUST NIET meer inladen in de Bibliotheek. Mo gebruikt ze niet, en de
      // netwerk-call naar de worker + een img per still bij elke laadbeurt belastten de weergave.
      // De mailarm zelf (R2-upload) blijft volledig ongemoeid; alleen het TONEN hier is uit. De
      // "Mail-plaatjes"-tab blijft gewoon werken (die genereert/toont ze via /api/mailstill).
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
    // ---- CARROUSEL-endpoints (eigen spoor, raken de video-planner/poster NIET) ----
    // Serveer de carrousel-beelden (out/carrousel/<file>) voor de preview in de UI.
    if (u.pathname.startsWith("/carrousel/")) {
      const f = path.resolve(CAROUSEL_DIR, decodeURIComponent(u.pathname.slice("/carrousel/".length)));
      if (!f.startsWith(CAROUSEL_DIR)) { res.writeHead(403); res.end("nee"); return; }
      if (existsSync(f)) { const ct = CT[path.extname(f).toLowerCase()] || "application/octet-stream"; res.writeHead(200, { "content-type": ct, "cache-control": "no-cache" }); res.end(await fs.readFile(f)); return; }
      res.writeHead(404); res.end("nope"); return;
    }
    // Overzicht: per taal het klaarstaande paar + post-status (voor de goedkeur-tab).
    if (u.pathname === "/api/carousel/list" && req.method === "GET") {
      const out = {};
      for (const lang of ["nl", "en", "fr"]) {
        const m = await readCarManifest(lang);
        out[lang] = m ? { caption: m.caption, images: (m.images || []).map((im) => "/carrousel/" + encodeURIComponent(im)), posts: m.posts || {}, created: m.created } : null;
      }
      json(res, { langs: ["nl", "en", "fr"], items: out });
      return;
    }
    // Maak de carrousel voor één taal (of alle drie met {langs:["nl","en","fr"]}).
    if (u.pathname === "/api/carousel/make" && req.method === "POST") {
      const bd = await readBody(req);
      const langs = Array.isArray(bd.langs) && bd.langs.length ? bd.langs : [bd.lang || "nl"];
      const items = {};
      for (const lang of langs) {
        try { const m = await makeCarousel(lang); items[lang] = { caption: m.caption, images: m.images.map((im) => "/carrousel/" + encodeURIComponent(im)), posts: m.posts || {} }; }
        catch (e) { items[lang] = { error: e.message }; log(`✗ carrousel ${lang}: ${e.message}`); }
      }
      json(res, { items });
      return;
    }
    // Post één taal-carrousel naar de gekozen kanalen (default IG+FB). Menselijke poort: dit
    // gebeurt pas als de gebruiker op de knop drukt (na goedkeuring).
    if (u.pathname === "/api/carousel/post" && req.method === "POST") {
      const bd = await readBody(req);
      const lang = ["en", "fr"].includes(bd.lang) ? bd.lang : "nl";
      const platforms = Array.isArray(bd.platforms) && bd.platforms.length ? bd.platforms : ["instagram", "facebook"];
      const results = {};
      for (const platform of platforms) {
        try { const r = await postCarousel(lang, platform); results[platform] = { ok: true, url: r.url || "" }; log(`✓ carrousel ${lang.toUpperCase()} → ${platform}`); }
        catch (e) { results[platform] = { ok: false, error: e.message }; log(`✗ carrousel ${lang.toUpperCase()} → ${platform}: ${e.message}`); }
      }
      json(res, { results });
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
      // SELECTIE: stuurt de UI een lijst type-id's mee (bd.types), dan renderen we ALLEEN die,
      // in de volgorde van het template-lijstje. Geen (of lege) lijst = alle types (zoals voorheen).
      const want = Array.isArray(bd.types) && bd.types.length ? new Set(bd.types) : null;
      const sel = want ? brand.templates.filter((t) => want.has(t.id)) : brand.templates;
      // BEWIJS: laat zien wat de UI stuurde en wat we er echt van gaan maken. Zie je hier
      // 2 gevraagd maar 1 gekozen, dan stuurde de UI een verkeerde/onbekende id. Zie je
      // 2 gekozen maar straks 1 klaar, dan faalde er een render (zoek de ✗ FOUT-regel).
      if (want) log(`• selectie ontvangen: [${[...want].join(", ")}] → ${sel.length} match(es): [${sel.map((t) => t.id).join(", ")}]`);
      let n = 0;
      for (const t of sel) {
        // Per-type max-duur: kies je bv. 45s voor "render alles", dan worden de types die
        // alleen REKKEN (en dus sloom worden bij lange duur) automatisch kort gehouden; de
        // types die juist MEER brengen bij langere duur pakken gewoon je gekozen duur.
        const opts = { ...(bd.opts || {}) };
        const cap = TYPE_MAX_SEC[t.id];
        if (cap && Number.isFinite(Number(opts.durationSec)) && Number(opts.durationSec) > cap) opts.durationSec = cap;
        enqueue({ brand: bd.brand, subject: bd.subject || null, template: t.id, format: bd.format || "9:16", music: bd.music || "", opts });
        n++;
      }
      log(`▶ wachtrij: ${n} ${want ? "gekozen " : ""}type${n === 1 ? "" : "s"} toegevoegd — ze worden één voor één gemaakt`);
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
    // TIKTOK CALLBACK: de worker (/tiktok/callback op taleoftiles.com) stuurt de ?code&state
    // hierheen (browser-fetch naar localhost). We wisselen de code -> token via completeLogin.
    // CORS open op deze route zodat de fetch vanaf taleoftiles.com naar localhost mag.
    if (u.pathname === "/api/social/tiktok-cb") {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const code = u.searchParams.get("code") || "";
      const state = u.searchParams.get("state") || "";
      const err = u.searchParams.get("error") || "";
      // taal uit de state (we zetten "<rnd>_<lang>" in startLogin)
      const lang = (state.split("_").pop() || "nl").toLowerCase();
      const tt = social.platById["tiktok"];
      if (err) { log(`✗ TikTok ${lang.toUpperCase()}: ${err}`); json(res, { error: err }); return; }
      if (!code || !tt || !tt.completeLogin) { json(res, { error: "geen code of TikTok niet beschikbaar" }, 400); return; }
      try { await tt.completeLogin(lang, code, state, log); json(res, { ok: true }); }
      catch (e) { log(`✗ TikTok ${lang.toUpperCase()}: ${e.message}`); json(res, { error: e.message }, 500); }
      return;
    }
    // Postbare video's = de afgewerkte mp4's in out/ (zelfde bron als de Bibliotheek). Per video
    // alleen het taal-account dat bij de taal van de video past (EN-video -> YouTube EN, enz.),
    // met de post-status per platform uit de store. posts gesleuteld op "<platform>-<lang>".
    if (u.pathname === "/api/social/videos") {
      const items = [];
      try {
        for (const r of await listRenderFiles()) {
          const meta = parseOutName(r.base.replace(/\.mp4$/i, ""));
          const lang = ["en", "fr"].includes(meta.lang) ? meta.lang : "nl";
          items.push({
            url: outUrl(r.rel), file: r.rel,
            brand: meta.brand, brandName: meta.brand ? (BRAND_NAME[meta.brand] || meta.brand) : "—",
            type: meta.template, typeName: meta.template ? (TEMPLATE_NAME[meta.template] || titleCase(meta.template)) : "Video",
            name: meta.name || "", lang, date: meta.date,
            kb: Math.round(r.size / 1024), mtime: r.mtimeMs,
            posts: await socialStore.forFile(r.rel),
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
      // ANTI-HERHALING: verzamel de titels/omschrijvingen die al voor dit type+taal gepost zijn,
      // zodat suggest een nog-niet-gebruikte variant kiest (opbouwend i.p.v. telkens hetzelfde).
      const recent = await recentTexts(type, lang);
      json(res, p.suggest({ type, lang, name, recent }));
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


