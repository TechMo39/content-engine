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

let busy = false;
function json(res, o, c = 200) { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); }
function readBody(req) { return new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(await fs.readFile(path.resolve(ROOT, "studio/engine.html"))); return; }
    if (u.pathname.startsWith("/out/")) { const f = path.resolve(OUT, u.pathname.slice(5)); if (existsSync(f)) { res.writeHead(200, { "content-type": "video/mp4" }); res.end(await fs.readFile(f)); return; } res.writeHead(404); res.end("nope"); return; }
    if (u.pathname === "/api/log") { res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }); res.write(`data: ${JSON.stringify("— verbonden —")}\n\n`); logClients.add(res); req.on("close", () => logClients.delete(res)); return; }
    if (u.pathname === "/api/brands") { json(res, { brands: reg.brands.map((b) => ({ id: b.id, name: b.name })) }); return; }
    if (u.pathname === "/api/subjects") { const b = reg.byId[u.searchParams.get("brand")]; if (!b) { json(res, { subjects: [] }); return; } json(res, { subjects: await b.listSubjects() }); return; }
    if (u.pathname === "/api/templates") { const b = reg.byId[u.searchParams.get("brand")]; if (!b) { json(res, { templates: [] }); return; } json(res, { templates: b.templates, options: b.options || [] }); return; }
    if (u.pathname === "/api/music") { let files = []; try { files = (await fs.readdir(path.resolve(ROOT, config.audioDir))).filter((f) => /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)); } catch {} json(res, { files }); return; }
    if (u.pathname === "/api/images") { const b = reg.byId[u.searchParams.get("brand")]; if (!b || !b.listImages) { json(res, { images: [] }); return; } json(res, { images: await b.listImages() }); return; }
    if (u.pathname === "/api/tot-thumb") {
      const b = reg.byId["taleoftiles"]; const p = (u.searchParams.get("p") || "").replace(/\.svg$/i, "");
      if (!b || !b.thumbSvg || !/^[A-Za-z0-9_-]+$/.test(p)) { res.writeHead(404); res.end(""); return; }
      try { res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" }); res.end(await b.thumbSvg(p)); } catch { res.writeHead(404); res.end(""); } return;
    }
    if (u.pathname === "/api/render" && req.method === "POST") {
      const bd = await readBody(req);
      const brand = reg.byId[bd.brand];
      if (!brand) { json(res, { error: "onbekend merk" }, 400); return; }
      if (busy) { log("⏳ er loopt al een render"); json(res, { error: "er loopt al een render" }, 409); return; }
      busy = true;
      log(`▶ render — ${brand.id}/${bd.subject || "-"}/${bd.template || "-"} (${bd.format || "9:16"})`);
      try {
        const render = await brand.makeRender({ subjectId: bd.subject, templateId: bd.template, opts: bd.opts || {}, format: bd.format || "9:16" });
        // Muziek: handmatige keuze wint; anders de track die het merk automatisch per type koos.
        const music = bd.music ? path.resolve(ROOT, config.audioDir, bd.music) : (render.music || "");
        if (music) log(`♪ muziek: ${path.basename(music)}${bd.music ? "" : " (automatisch)"}`);
        const r = await renderToMp4({ render, music, outDir: OUT, log, namePrefix: brand.id });
        log(`✓ klaar: /out/${r.outName}`);
        json(res, { url: "/out/" + r.outName });
      } catch (e) { log(`✗ FOUT: ${e.message}`); json(res, { error: e.message }, 500); }
      finally { busy = false; }
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
