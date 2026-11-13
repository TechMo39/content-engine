// tools/portal-capture.mjs
// -------------------------------------------------------------------------
// APARTE recorder voor de UncleRank-content: neemt het PUBLIEKE portaal op
// (portaal.unclerank.com) als vloeiende scroll-walkthrough, frame-voor-frame
// (screenshot per frame -> ffmpeg -> mp4). 9:16, 1080x1920.
//
// Staat LOS van tools/site-capture.mjs (die is Tale-of-Tiles-specifiek en
// draait 's nachts automatisch). Deze raakt die niet aan en deelt er niks mee.
//
// Draait op JOUW laptop (die bereikt de site + heeft de browser). Levert een
// RUWE mp4 + markers.json; de content-ready stap (hook/snelheid/caption/muziek)
// doet het bestaande tools/finish.mjs er daarna overheen, ONGEWIJZIGD, via env.
//
// Gebruik (standalone test):
//   npx playwright install chromium            (eenmalig)
//   FFMPEG=./node_modules/ffmpeg-static/ffmpeg \
//   UR_PORTAL_URL=https://portaal.unclerank.com UR_OUT=./out \
//   node tools/portal-capture.mjs
//
// Env:
//   UR_PORTAL_URL  publieke pagina om op te nemen (standaard portaal.unclerank.com)
//   UR_FPS         frames/sec (standaard 18)
//   UR_OUT         uitvoermap (standaard ./out)
//   UR_SECONDS     totale scroll-duur in sec (standaard 14) — ruw, finish.mjs ramp't later
//   UR_W / UR_H    formaat (standaard 1080x1920, 9:16)
//   UR_PORTAL_STATE  pad naar opgeslagen login (Playwright storageState .json). Bestaat-ie, dan
//                    neemt de recorder INGELOGD op. Maak 'm eenmalig met de login-stand hieronder.
//   FFMPEG         pad naar ffmpeg (anders "ffmpeg" op PATH)
//   PW_CHROME      pad naar een chrome/chromium als playwright's eigen build ontbreekt
//
// EENMALIG INLOGGEN (portaal zit achter login):
//   UR_PORTAL_STATE=assets/unclerank/portal-state.json \
//   UR_PORTAL_URL=https://portaal.unclerank.com node tools/portal-capture.mjs --login
//   -> opent een ZICHTBARE browser; log in; druk daarna Enter in de terminal. De sessie wordt
//      opgeslagen in UR_PORTAL_STATE en bij elke opname hergebruikt (geen wachtwoord in env).
// -------------------------------------------------------------------------

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL   = process.env.UR_PORTAL_URL || "https://portaal.unclerank.com";
const STATE = process.env.UR_PORTAL_STATE || "";
const LOGIN = process.argv.includes("--login");
const FPS   = Number(process.env.UR_FPS || 18);
const OUT   = process.env.UR_OUT || "./out";
const SECS  = Number(process.env.UR_SECONDS || 14);
const W     = Number(process.env.UR_W || 1080);
const H     = Number(process.env.UR_H || 1920);
const ffmpegBin = process.env.FFMPEG || "ffmpeg";

// Bedrijfsnamen vervagen. Selectors van het UncleRank-portaal (vandaag.mjs: .kaart .naam,
// dossier.mjs: .dkop h1, ui.mjs balk: .balk .naam). Overschrijfbaar via UR_BLUR.
const BLUR_SEL = process.env.UR_BLUR || ".kaart .naam, .dkop h1, .balk .naam";
// Doorklikken naar een dossier: de hele lead-kaart is een link (<a class="kaart" href="/dossier?…">).
// Standaard aan; UR_OPEN_DOSSIER=0 zet het uit. De HOT lead herkennen we aan z'n label.
const OPEN_DOSSIER = process.env.UR_OPEN_DOSSIER !== "0";

const log = (...a) => console.log(...a);
const ease = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }; // smoothstep
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urportal-"));

  let frame = 0;
  // markers: tijdstip (sec) per fase. We hergebruiken de SLEUTELS die finish.mjs
  // verwacht (patternStart/colorStart/nameStart/preview/scenes), zodat de hook
  // en de snelheidsramp daar landen waar het verhaal z'n climax heeft (de kring/
  // dossier-onthulling onderaan). finish.mjs heeft nette terugval als er een mist.
  const marks = { fps: FPS };
  const mark = (k) => { marks[k] = +(frame / FPS).toFixed(2); };

  const shot = async (page) => {
    await page.screenshot({
      path: path.join(tmp, `f${String(frame++).padStart(5, "0")}.png`),
      clip: { x: 0, y: 0, width: W, height: H },
    }).catch(() => {});
  };

  // Vloeiend scrollen van de huidige positie naar toY over `sec` seconden,
  // frame-voor-frame. Geen pagina-specifieke selectors -> werkt op elke pagina.
  const scrollToY = async (page, toY, sec) => {
    const from = await page.evaluate(() => window.scrollY);
    const n = Math.max(1, Math.round(sec * FPS));
    for (let i = 0; i < n; i++) {
      const y = from + (toY - from) * ease(i / (n - 1 || 1));
      await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y));
      await shot(page);
    }
  };
  // Een paar frames stil blijven staan (adempauze bij een sectie).
  const hold = async (page, sec) => { const n = Math.max(1, Math.round(sec * FPS)); for (let i = 0; i < n; i++) await shot(page); };

  // ---- EENMALIGE LOGIN-STAND: zichtbare browser, jij logt in, wij bewaren de sessie ----
  if (LOGIN) {
    if (!STATE) { console.error("zet UR_PORTAL_STATE op een pad om de login in op te slaan"); process.exit(1); }
    const b = await chromium.launch({ headless: false, args: ["--disable-dev-shm-usage"] });
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    log("\n>> Log nu in de geopende browser in op het portaal.");
    log(">> Klaar? Druk hier Enter om de sessie op te slaan…\n");
    await new Promise((res) => { process.stdin.resume(); process.stdin.once("data", res); });
    fs.mkdirSync(path.dirname(path.resolve(STATE)), { recursive: true });
    await ctx.storageState({ path: STATE });
    await b.close();
    log("login opgeslagen -> " + STATE);
    process.exit(0);
  }

  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  if (process.env.PW_CHROME) {
    launchOpts.executablePath = process.env.PW_CHROME;
    launchOpts.ignoreDefaultArgs = ["--headless"];
    launchOpts.args.unshift("--headless=new");
  }
  const browser = await chromium.launch(launchOpts);
  // ingelogde sessie meeladen als die er is, anders gewoon publiek
  const haveState = STATE && fs.existsSync(STATE);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, storageState: haveState ? STATE : undefined });
  const page = await ctx.newPage();

  // BEDRIJFSNAMEN VERVAGEN + scrollbar weg, via init-script zodat het op ELKE pagina geldt
  // (de lijst én het dossier waar we naartoe klikken), vóór de eerste paint.
  await page.addInitScript((sel) => {
    const css = sel + "{filter:blur(8px) !important;} "
      + "::-webkit-scrollbar{width:0;height:0} html{scrollbar-width:none}";
    const add = () => { const s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  }, BLUR_SEL);

  log("portaal-opname: " + URL + (haveState ? " (ingelogd)" : ""));
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 }).catch(async () => {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);

  // Scroll de HUIDIGE pagina vloeiend van boven naar beneden, frame-voor-frame. Robuust:
  // natuurlijke blokken (kaarten/vakken/secties) als ankers, anders gelijke stappen.
  const scrollThrough = async (secs) => {
    const geo = await page.evaluate((vh) => {
      const full = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const seen = new Set(); let tops = [];
      document.querySelectorAll("section, header, footer, main > div, .kaart, .vak, [class*='block']").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height < vh * 0.18) return;
        const y = Math.round(window.scrollY + r.top);
        if (y < 0 || y > full) return;
        const b = Math.round(y / 40); if (seen.has(b)) return; seen.add(b); tops.push(y);
      });
      tops.sort((a, b) => a - b); return { full, tops };
    }, H);
    const maxY = Math.max(0, geo.full - H);
    let stops = (geo.tops || []).filter((y) => y <= maxY);
    if (stops.length < 3) { stops = []; for (let i = 1; i <= 5; i++) stops.push(Math.round(maxY * i / 5)); }
    if (stops.length > 6) { const keep = []; const st = (stops.length - 1) / 5; for (let i = 0; i < 6; i++) keep.push(stops[Math.round(i * st)]); stops = keep; }
    if (stops[stops.length - 1] < maxY - 8) stops.push(maxY);
    stops = [...new Set(stops)].sort((a, b) => a - b);
    const per = Math.max(0.7, secs / Math.max(1, stops.length));
    for (const y of stops) { await scrollToY(page, y, per); await hold(page, 0.4); }
  };

  // de heetste lead kiezen: een gemeld dossier ("Uit een gesprek") is het sterkst, dan een
  // "bellen"-label, anders de eerste kaart. Zelfde keuze voor scrollen én klikken.
  const HOT = ".kaart:has(.label.gesprek), .kaart:has(.label.bellen), a.kaart";
  const listSecs = OPEN_DOSSIER ? SECS * 0.45 : SECS;

  // 1) LIJST: wie bel je vandaag, en waarom
  mark("patternStart");
  await hold(page, 0.7);
  mark("colorStart");
  await scrollThrough(listSecs);

  // 2) HOT LEAD openen en het dossier laten zien (waarom nu / wat er mis is / wat 't waard is)
  let opened = false;
  if (OPEN_DOSSIER) {
    const hasHot = await page.evaluate((sel) => !!document.querySelector(sel), HOT);
    if (hasHot) {
      await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: "center" }); }, HOT);
      await hold(page, 0.5);
      mark("nameStart");            // overgang naar het dossier
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {}),
        page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, HOT),
      ]);
      await sleep(700);
      await page.evaluate(() => window.scrollTo(0, 0));
      await hold(page, 0.6);
      mark("preview");             // dossier in beeld
      await scrollThrough(SECS * 0.55);
      opened = true;
    }
  }
  if (!opened) mark("nameStart");
  mark("scenes");                  // payoff voor de hook
  await hold(page, 0.9);
  mark("end");

  await browser.close();

  // markers wegschrijven naast de ruwe mp4 (voor de content-ready stap)
  try { fs.writeFileSync(path.join(OUT, "portal-walkthrough.markers.json"), JSON.stringify(marks)); } catch {}

  // frames -> mp4
  log("frames: " + frame + " -> mp4");
  await new Promise((res, rej) => {
    const args = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", `scale=${W}:${H}`,
      path.join(OUT, "portal-walkthrough.mp4")];
    const pr = spawn(ffmpegBin, args, { stdio: "ignore", windowsHide: true });
    pr.on("error", rej);
    pr.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  log("klaar: " + path.join(OUT, "portal-walkthrough.mp4"));
})().catch((e) => { console.error("portaal-opname faalde: " + (e && e.message || e)); process.exit(1); });
