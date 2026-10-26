// render_dag.mjs
// Content-producer voor de ochtend: rendert elke dag een verse set video's naar out/, zodat
// Mo 's ochtends alleen nog hoeft te beoordelen. Zelfde engine-beheer als tot_plaatjes.js:
// start de engine zo nodig zelf (headless, stil), gebruikt een al draaiende app als die er is
// en laat 'm met rust, en sluit alleen af wat wij zelf startten.
//
// LOGT ALLES LIVE: elke stap van het opstarten, en de ECHTE engine-log (zelfde stroom als het
// OPERATIES-paneel, via /api/log) stroomt mee, plus per render een regel vooraf en erna met
// tijd. Je ziet dus altijd wat hij doet en waar hij eventueel vastloopt.
//
// Draaien:
//   node tools/render_dag.mjs                         (DROOG: toont wat 'ie zou doen)
//   node tools/render_dag.mjs --doen                  (alle types x NL/EN/FR)
//   node tools/render_dag.mjs --doen --talen nl       (alleen NL - handig om te testen)
//   node tools/render_dag.mjs --doen --types satisfying,trio --talen nl   (kleine test)
//   node tools/render_dag.mjs --doen --hiberna        (na afloop hibernaten - voor de nacht-taak)

import { spawn, spawnSync } from "child_process";
import net from "net";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";

const ENGINE = "http://localhost:4600";
const ENGINE_DIR = path.resolve(os.homedir(), "Desktop", "content-engine");
const ENGINE_ENTRY = path.join(ENGINE_DIR, "src", "engine.mjs");
const BRAND = "taleoftiles";
const OUT_LOG_DIR = path.join(ENGINE_DIR, "out", "logs");
const MARKER = path.join(OUT_LOG_DIR, "render_dag.txt");   // inhaal.bat checkt de datum hiervan
const SWEEP_DAGEN = 7;   // kandidaten die zo lang ongebruikt in out/ staan -> out/archief/

// Opruimen: verse pool klein houden. Geposte video's staan al in out/geplaatst/ (door de poster),
// dus wat hier nog in out/ staat en ouder is dan SWEEP_DAGEN is ongebruikt -> naar out/archief/.
async function sweepArchief() {
  const outDir = path.join(ENGINE_DIR, "out");
  const archief = path.join(outDir, "archief");
  const grens = Date.now() - SWEEP_DAGEN * 24 * 3600 * 1000;
  let verplaatst = 0;
  try {
    for (const f of await fs.promises.readdir(outDir)) {
      if (!/\.mp4$/i.test(f)) continue;
      const src = path.join(outDir, f);
      let st; try { st = await fs.promises.stat(src); } catch { continue; }
      if (!st.isFile() || st.mtimeMs > grens) continue;
      await fs.promises.mkdir(archief, { recursive: true });
      try { await fs.promises.rename(src, path.join(archief, f)); verplaatst++; } catch (_) {}
    }
  } catch (_) {}
  if (verplaatst) log(`archief: ${verplaatst} ongebruikte video('s) ouder dan ${SWEEP_DAGEN} dagen -> out/archief/`);
}

const heeft = (v) => process.argv.includes("--" + v);
const arg = (naam, standaard) => {
  const i = process.argv.indexOf("--" + naam);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : standaard;
};
const DOEN = heeft("doen");
const HIBERNA = heeft("hiberna");
const TALEN = String(arg("talen", "nl,en,fr")).split(",").map((s) => s.trim()).filter(Boolean);
const TYPES_ARG = String(arg("types", "")).trim();
const FORMAT = arg("format", "9:16");
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const nu = () => new Date().toLocaleTimeString("nl-NL");
const log = (s) => console.log(`[${nu()}] ${s}`);

// --- engine-beheer (1-op-1 patroon uit tot_plaatjes.js) --------------------
let onzeEngine = null;   // blijft null als er al een engine (jouw app) draaide -> die raken we niet aan
function stopOnzeEngine() {
  if (!onzeEngine || !onzeEngine.pid) return;
  const pid = onzeEngine.pid; onzeEngine = null;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(pid);
  } catch (_) { /* al weg, prima */ }
}
process.on("exit", stopOnzeEngine);

async function engineLeeft() { try { const r = await fetch(ENGINE + "/api/brands"); return r.ok; } catch { return false; } }
function poortBezet(poort = 4600, host = "127.0.0.1") {
  return new Promise((res) => {
    const s = net.connect({ port: poort, host });
    let klaar = false;
    const af = (bezet) => { if (klaar) return; klaar = true; s.destroy(); res(bezet); };
    s.on("connect", () => af(true));
    s.on("error", () => af(false));
    s.setTimeout(1500, () => af(false));
  });
}
async function startEngine() {
  if (!fs.existsSync(ENGINE_ENTRY)) throw new Error("content-engine niet gevonden op " + ENGINE_ENTRY);
  log("engine starten (headless, stil)…  " + ENGINE_ENTRY);
  let fout = "";
  const kind = spawn(process.execPath, [ENGINE_ENTRY], {
    cwd: ENGINE_DIR, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, STUDIO_NO_OPEN: "1" },
  });
  onzeEngine = kind;
  try { kind.stderr.on("data", (d) => { fout += d.toString(); if (fout.length > 6000) fout = fout.slice(-6000); }); } catch (_) {}
  kind.on("exit", (code) => { if (code && code !== 0) log("LET OP: engine-proces stopte met code " + code); });
  // Tot 90s wachten (koude start bundelt eerst film.ts via esbuild). Elke 3s een teken van leven.
  for (let i = 0; i < 90; i++) {
    await slaap(1000);
    if (await engineLeeft()) { log("engine antwoordt (/api/brands ok) na " + (i + 1) + "s"); return true; }
    if (i % 3 === 2) log("…wachten op engine (" + (i + 1) + "s)");
  }
  log("engine startte niet binnen 90s.");
  if (fout.trim()) { console.error("  De engine zei zelf:"); console.error(fout.trim().split("\n").slice(-12).map((l) => "    " + l).join("\n")); }
  return false;
}
async function zorgVoorEngine() {
  log("engine zoeken op :4600…");
  if (await engineLeeft()) { log("er draait al een engine op 4600 -> die gebruiken, met rust laten."); return true; }
  if (await poortBezet()) {
    log("iets luistert op 4600 maar antwoordt nog niet (engine is bezig of start op). Wachten…");
    for (let i = 0; i < 300; i++) { await slaap(1000); if (await engineLeeft()) { log("engine antwoordt nu."); return true; } if (i % 5 === 4) log("…nog steeds wachten (" + (i + 1) + "s)"); }
    log("engine op 4600 bleef 5 minuten onbereikbaar. Stop.");
    return false;
  }
  log("geen engine op 4600 -> zelf starten.");
  return await startEngine();
}

// Live engine-log meelezen (zelfde stroom als het OPERATIES-paneel). Zo zie je de echte
// render-voortgang (frames, '✓ klaar') in plaats van een stil scherm.
async function volgEngineLog() {
  try {
    const r = await fetch(ENGINE + "/api/log");
    if (!r.ok || !r.body) return;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch { break; }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          const m = line.match(/^data:\s?(.*)$/);
          if (!m) continue;
          let msg = m[1];
          try { msg = JSON.parse(m[1]); } catch (_) {}
          if (msg && String(msg).trim() && !/verbonden/i.test(String(msg))) console.log("        engine | " + msg);
        }
      }
    })();
  } catch (_) { /* log-stream is optioneel */ }
}

async function haalTypes() {
  const r = await fetch(ENGINE + "/api/templates?brand=" + encodeURIComponent(BRAND));
  if (!r.ok) throw new Error("/api/templates gaf " + r.status);
  const j = await r.json();
  return (j.templates || []).map((t) => t.id).filter(Boolean);
}
// /api/render blokkeert tot de render klaar is (server-side wachtrij, 1 tegelijk) en geeft { url }.
// Via node:http i.p.v. fetch, want fetch (undici) kapt een aanvraag standaard af na 5 min -> bij
// een langere render (iris!) gaf dat ten onrechte "fetch failed" terwijl de engine gewoon doorging.
// http heeft geen standaard-timeout: de aanvraag blijft open zolang de render duurt.
function renderEen(template, lang) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ brand: BRAND, template, format: FORMAT, opts: { lang } });
    const req = http.request(
      { host: "127.0.0.1", port: 4600, path: "/api/render", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error("/api/render gaf " + res.statusCode + (data ? " - " + data.slice(0, 200) : "")));
          try { const j = JSON.parse(data); resolve(j.url || data); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);   // GEEN req.setTimeout -> blijft open zolang de render duurt
    req.write(body); req.end();
  });
}

(async function main() {
  await fs.promises.mkdir(OUT_LOG_DIR, { recursive: true }).catch(() => {});
  await sweepArchief();    // eerst opruimen: ongebruikte oude kandidaten naar out/archief/
  if (!(await zorgVoorEngine())) { console.error("Geen engine beschikbaar. Stop."); process.exit(1); }
  await volgEngineLog();   // vanaf nu stroomt de engine-log mee

  let types = TYPES_ARG ? TYPES_ARG.split(",").map((s) => s.trim()).filter(Boolean) : await haalTypes();
  if (!types.length) { console.error("Geen types gevonden. Stop."); process.exit(1); }
  const totaal = types.length * TALEN.length;
  log("talen: " + TALEN.join(", "));
  log("types: " + types.join(", "));
  log("te renderen: " + totaal + (DOEN ? "" : "  (DROOG - geef --doen om echt te renderen)"));

  let ok = 0, fail = 0, done = 0;
  for (const lang of TALEN) {
    for (const t of types) {
      done++;
      const label = `${done}/${totaal}  ${t} [${lang}]`;
      if (!DOEN) { log("(droog) " + label); continue; }
      const t0 = Date.now();
      log("▶ rendert " + label + " …");
      try { const url = await renderEen(t, lang); log("✓ klaar " + label + "  (" + ((Date.now() - t0) / 1000).toFixed(0) + "s) -> " + url); ok++; }
      catch (e) { log("✗ MISLUKT " + label + ": " + (e && e.message || e)); fail++; }
    }
  }

  const samenvatting = `${new Date().toISOString()}  klaar: ${ok} ok, ${fail} mislukt (talen ${TALEN.join("/")}, ${types.length} types)`;
  log("ALLES KLAAR -> " + ok + " ok, " + fail + " mislukt");
  if (DOEN) { try { await fs.promises.appendFile(MARKER, samenvatting + "\n"); } catch (_) {} }

  stopOnzeEngine();

  if (DOEN && HIBERNA) {
    log("dag-render klaar, laptop gaat in slaapstand (hibernate).");
    if (process.platform === "win32") spawnSync("shutdown", ["/h"], { windowsHide: true, stdio: "ignore" });
  }
  process.exit(0);
})().catch((e) => { console.error("render_dag faalde:", e && e.message || e); process.exit(1); });
