// GENERIEKE STUDIO-SERVER. Kiest: merk -> onderwerp -> template -> opties -> render.
// Weet zelf niks van tegels; dat zit in de merk-modules. Start: npm run engine
import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { buildRegistry } from "./registry.mjs";
import { renderToMp4 } from "./core/renderer.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const PORT = 4600;
const OUT = path.resolve(ROOT, config.outDir);
await fs.mkdir(OUT, { recursive: true });

const logClients = new Set();
function log(msg) { const line = String(msg); process.stdout.write("  " + line + "\n"); for (const c of logClients) { try { c.write(`data: ${JSON.stringify(line)}\n\n`); } catch {} } }

const reg = buildRegistry({ ROOT, config });
for (const b of reg.brands) { try { await b.init(log); } catch (e) { log(`merk ${b.id} init-fout: ${e.message}`); } }
log("merken geladen: " + reg.brands.map((b) => b.id).join(", "));

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
    if (p === "en") { lang = "en"; continue; }
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
  if (job.opts && job.opts.lang === "en") p.push("en");
  if (job.opts && job.opts.name) p.push(String(job.opts.name).replace(/\s+/g, ""));
  return (p.join("-").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 50) || "video") + "-" + stamp();
}
async function runOne(job) {
  const brand = reg.byId[job.brand];
  if (!brand) throw new Error("onbekend merk");
  const render = await brand.makeRender({ subjectId: job.subject, templateId: job.template, opts: job.opts || {}, format: job.format || "9:16", log });
  const base = outBase(job);
  // kant-en-klare mp4 (bv. website-walkthrough) -> direct met nette naam neerzetten
  if (render && render.prebuilt && existsSync(render.prebuilt)) {
    const outName = base + ".mp4";
    await fs.copyFile(render.prebuilt, path.resolve(OUT, outName));
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
      // 2) mail-stills: jpg/png in out/mail-stills
      try {
        const sd = path.join(OUT, "mail-stills");
        for (const f of await fs.readdir(sd)) {
          if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
          let st; try { st = await fs.stat(path.join(sd, f)); } catch { continue; }
          items.push({
            kind: "still", url: "/out/mail-stills/" + encodeURIComponent(f), file: f,
            brand: "taleoftiles", brandName: BRAND_NAME["taleoftiles"] || "Tale of Tiles",
            type: "mailstill", typeName: "Mail-still",
            name: titleCase(f.replace(/\.(jpe?g|png|webp)$/i, "").replace(/-/g, " ")), lang: "", date: null,
            kb: Math.round(st.size / 1024), mtime: st.mtimeMs,
          });
        }
      } catch {}
      items.sort((a, b) => b.mtime - a.mtime);
      json(res, { items, brands: reg.brands.map((b) => ({ id: b.id, name: b.name })) });
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
      for (const t of brand.templates) { enqueue({ brand: bd.brand, subject: bd.subject || null, template: t.id, format: bd.format || "9:16", music: bd.music || "", opts: bd.opts || {} }); n++; }
      log(`▶ wachtrij: ${n} types toegevoegd — ze worden één voor één gemaakt`);
      json(res, { queued: n });
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
