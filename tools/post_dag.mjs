// post_dag.mjs
// Poster (laag 3): leest het goedgekeurde plan (out/.plan.json) en post wat aan de beurt is naar
// de GEKOPPELDE kanalen, via de bestaande /api/social/post. Caption komt van /api/social/suggest.
//
// - Draait elke ~15 min via Taakplanner + StartWhenAvailable, dus mis je een post om 10:00 omdat
//   je laptop uit was, dan gaat die er zodra je 'm aanzet alsnog uit (catch-up).
// - Start de engine ALLEEN als er iets te posten is (nodig voor de API-koppelingen); gebruikt een
//   al draaiende app als die er is en laat 'm met rust. Hibernate NIET (draait overdag).
// - Dubbel posten is onmogelijk: de social-store weigert een 2e post per file+platform+taal (409).
//
//   node tools/post_dag.mjs            (DROOG: toont wat 'ie zou posten)
//   node tools/post_dag.mjs --doen     (echt posten wat due is)

import { spawn, spawnSync } from "child_process";
import net from "net";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";

const ENGINE = "http://localhost:4600";
const ENGINE_DIR = path.resolve(os.homedir(), "Desktop", "content-engine");
const ENGINE_ENTRY = path.join(ENGINE_DIR, "src", "engine.mjs");
const OUT_LOG_DIR = path.join(ENGINE_DIR, "out", "logs");
const PLAN_FILE = path.join(ENGINE_DIR, "out", ".plan.json");

const DOEN = process.argv.includes("--doen");
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));
const nu = () => new Date().toLocaleTimeString("nl-NL");
const log = (s) => console.log(`[${nu()}] ${s}`);
// ALLES op Europe/Amsterdam (zoals de planner + engine), anders mixen we tijdzones door elkaar
// en klopt "vandaag"/"due" rond middernacht niet. (todayStr gebruikte UTC, nowMin lokale tijd.)
const AMS = "Europe/Amsterdam";
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: AMS });   // YYYY-MM-DD, Amsterdam
const dateStrOffset = (dagen) => { const d = new Date(); d.setDate(d.getDate() - dagen); return d.toLocaleDateString("en-CA", { timeZone: AMS }); };
const nowMin = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: AMS, hour12: false }); const m = /^(\d{1,2}):(\d{2})/.exec(s); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ""); return m ? (+m[1]) * 60 + (+m[2]) : 0; };
// INHAAL: hoeveel dagen terug nog gemiste gepland-posts oppakken (laptop was uit / laat goedgekeurd).
const INHAAL_DAGEN = 2;

// --- engine-beheer (zelfde patroon als render_dag/tot_plaatjes) ---
let onzeEngine = null;
function stopOnzeEngine() {
  if (!onzeEngine || !onzeEngine.pid) return;
  const pid = onzeEngine.pid; onzeEngine = null;
  try { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); else process.kill(pid); } catch (_) {}
}
process.on("exit", stopOnzeEngine);
async function engineLeeft() { try { const r = await fetch(ENGINE + "/api/brands"); return r.ok; } catch { return false; } }
function poortBezet(poort = 4600, host = "127.0.0.1") {
  return new Promise((res) => { const s = net.connect({ port: poort, host }); let k = false; const af = (b) => { if (k) return; k = true; s.destroy(); res(b); }; s.on("connect", () => af(true)); s.on("error", () => af(false)); s.setTimeout(1500, () => af(false)); });
}
async function startEngine() {
  if (!fs.existsSync(ENGINE_ENTRY)) throw new Error("content-engine niet gevonden: " + ENGINE_ENTRY);
  log("engine starten (headless, stil)…");
  let fout = "";
  const kind = spawn(process.execPath, [ENGINE_ENTRY], { cwd: ENGINE_DIR, windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, STUDIO_NO_OPEN: "1" } });
  onzeEngine = kind;
  try { kind.stderr.on("data", (d) => { fout += d.toString(); if (fout.length > 6000) fout = fout.slice(-6000); }); } catch (_) {}
  for (let i = 0; i < 90; i++) { await slaap(1000); if (await engineLeeft()) { log("engine antwoordt na " + (i + 1) + "s"); return true; } if (i % 3 === 2) log("…wachten op engine (" + (i + 1) + "s)"); }
  if (fout.trim()) console.error(fout.trim().split("\n").slice(-10).map((l) => "    " + l).join("\n"));
  return false;
}
async function zorgVoorEngine() {
  if (await engineLeeft()) { log("engine draait al — gebruiken, met rust laten."); return true; }
  if (await poortBezet()) { log("iets op 4600 maar antwoordt nog niet; wachten…"); for (let i = 0; i < 180; i++) { await slaap(1000); if (await engineLeeft()) return true; } return false; }
  log("geen engine op 4600 — zelf starten.");
  return await startEngine();
}

// http-helpers (geen fetch-timeout; een IG-upload kan lang duren)
function getJson(p) { return new Promise((res, rej) => { http.get(ENGINE + p, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
function postJson(p, body) {
  return new Promise((res, rej) => {
    const b = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: 4600, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(b) } }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { let j = {}; try { j = JSON.parse(d); } catch {} res({ status: r.statusCode, json: j }); }); });
    req.on("error", rej); req.write(b); req.end();
  });
}

(async function main() {
  await fs.promises.mkdir(OUT_LOG_DIR, { recursive: true }).catch(() => {});
  const date = todayStr();
  // Plan rechtstreeks van schijf -> we starten de engine NIET als er niks due is.
  let planAll = {}; try { planAll = JSON.parse(await fs.promises.readFile(PLAN_FILE, "utf8")); } catch {}
  // DUE = gepland + nog niet gepost + tijd voorbij. Vandaag telt een slot pas als tijd <= nu;
  // EERDERE dagen (tot INHAAL_DAGEN terug) tellen ALTIJD (die tijd is sowieso voorbij) -> gemiste
  // posts (laptop was uit, of laat goedgekeurd rond middernacht) worden alsnog ingehaald. De store
  // blokkeert dubbel posten, dus een al-gepost slot kan hier geen tweede keer uit.
  const dagen = [];
  for (let i = INHAAL_DAGEN; i >= 1; i--) dagen.push(dateStrOffset(i));   // oudste eerst
  dagen.push(date);                                                       // dan vandaag
  const nowM = nowMin();
  const due = [];
  for (const d of dagen) {
    const slots = (planAll[d] && planAll[d].slots) || [];
    for (const s of slots) {
      if (!s.file || s.status !== "gepland") continue;
      if (d === date && toMin(s.time) > nowM) continue;   // vandaag: alleen als de tijd al voorbij is
      due.push({ s, d });                                  // onthoud bij welke dag dit slot hoort
    }
  }
  log(`plan: ${due.length} due (vandaag + ${INHAAL_DAGEN} dag(en) inhaal)` + (DOEN ? "" : "  [DROOG]"));
  if (!due.length) { log("niets te posten; engine niet gestart."); process.exit(0); }

  if (!(await zorgVoorEngine())) { console.error("Geen engine beschikbaar. Stop."); process.exit(1); }
  let chan; try { chan = await getJson("/api/social/channels"); } catch { chan = { accounts: [] }; }
  const connected = {};   // lang -> [platform, ...]
  for (const a of (chan.accounts || [])) if (a.connected) (connected[a.lang] = connected[a.lang] || []).push(a.platform);

  let gepost = 0, mislukt = 0;
  for (const { s, d } of due) {
    let plats = connected[s.lang] || [];
    // WhatsApp is GEEN auto-post-kanaal (handmatige export via QR/link in de Socials-tab).
    plats = plats.filter((p) => p !== "whatsapp");
    // CARROUSEL (foto-post): alleen Instagram en Facebook kunnen dit. YouTube/TikTok overslaan.
    const isCarousel = /\.carrousel\.json$/i.test(s.file || "");
    if (isCarousel) plats = plats.filter((p) => p === "instagram" || p === "facebook");
    // PER-PLATFORM KEUZE: heeft dit slot een platform-selectie, dan alleen die (en alleen de
    // gekoppelde ervan). Leeg/afwezig = alle gekoppelde kanalen van de taal (oud gedrag).
    if (Array.isArray(s.platforms) && s.platforms.length) plats = plats.filter((p) => s.platforms.includes(p));
    if (!plats.length) { log(`⚠ ${s.time} ${s.lang.toUpperCase()}: geen gekoppeld/gekozen kanaal, overslaan.`); continue; }
    let okAny = false, errAny = false;
    for (const platform of plats) {
      const label = `${d === date ? "" : d + " "}${s.time} ${s.lang.toUpperCase()} → ${platform}${d === date ? "" : " (inhaal)"}`;
      if (!DOEN) { log("(droog) zou posten: " + label + "  (" + (s.typeName || s.type) + ")"); okAny = true; continue; }
      let cap = { title: "", description: "", tags: [] };
      try { cap = await getJson(`/api/social/suggest?platform=${encodeURIComponent(platform)}&type=${encodeURIComponent(s.type || "")}&lang=${encodeURIComponent(s.lang)}&name=`); } catch {}
      log("▶ posten: " + label);
      let r; try { r = await postJson("/api/social/post", { file: s.file, platform, lang: s.lang, title: cap.title, description: cap.description, tags: cap.tags }); } catch (e) { r = { status: 0, json: { error: e.message } }; }
      if (r.status === 200) { log("✓ geplaatst: " + label); okAny = true; }
      else if (r.status === 409) { log("• al eerder geplaatst: " + label); okAny = true; }
      else { log("✗ mislukt: " + label + " — " + ((r.json && r.json.error) || r.status)); errAny = true; }
    }
    // PER-KANAAL INHAAL: faalde één kanaal, dan laten we het slot op "gepland" staan zodat de
    // VOLGENDE ronde het opnieuw probeert. De al-geslaagde kanalen worden dan door de server
    // geweigerd met 409 ("al geplaatst") -> geen dubbele post. Pas als ALLE gekozen kanalen
    // gelukt zijn, zetten we het slot op "geplaatst" en verhuizen we het bestand. Zo blijft een
    // gefaald kanaal (bv. een YouTube-token dat net dood was) nooit meer achter.
    s.status = errAny ? "gepland" : (okAny ? "geplaatst" : "gepland");
    if (okAny) gepost++; if (errAny) mislukt++;
    // Verplaatsen naar out/geplaatst/ ALLEEN als alles gelukt is (geen fouten). Anders laten we het
    // bestand staan zodat de volgende ronde de gefaalde kanalen alsnog kan posten.
    // Bij een CARROUSEL verhuizen ook de losse beelden mee, niet alleen het manifest.
    if (DOEN && okAny && !errAny) {
      try {
        const geplaatstDir = path.join(ENGINE_DIR, "out", "geplaatst");
        await fs.promises.mkdir(geplaatstDir, { recursive: true });
        const src = path.join(ENGINE_DIR, "out", s.file);
        if (isCarousel && fs.existsSync(src)) {
          let man = {}; try { man = JSON.parse(fs.readFileSync(src, "utf8")); } catch {}
          for (const im of (man.images || [])) { const is = path.join(ENGINE_DIR, "out", im); if (fs.existsSync(is)) await fs.promises.rename(is, path.join(geplaatstDir, im)).catch(() => {}); }
          await fs.promises.rename(src, path.join(geplaatstDir, s.file)); s.url = "/out/geplaatst/" + encodeURIComponent(s.file); log("  → carrousel verplaatst naar out/geplaatst/");
        } else if (fs.existsSync(src)) { await fs.promises.rename(src, path.join(geplaatstDir, s.file)); s.url = "/out/geplaatst/" + encodeURIComponent(s.file); log("  → verplaatst naar out/geplaatst/"); }
      } catch (e) { log("  (kon niet verplaatsen: " + (e.message || e) + ")"); }
    }
  }

  // Status terugschrijven in het plan (alle dagen; de slot-objecten zijn in planAll bijgewerkt).
  if (DOEN) { try { await fs.promises.writeFile(PLAN_FILE, JSON.stringify(planAll, null, 2)); } catch {} }
  log(`KLAAR — ${gepost} slot(s) (deels) gepost, ${mislukt} met fouten.`);
  stopOnzeEngine();
  process.exit(0);
})().catch((e) => { console.error("post_dag faalde:", e && e.message || e); process.exit(1); });


