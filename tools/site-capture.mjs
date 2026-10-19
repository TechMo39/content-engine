// Tale of Tiles — WEBSITE / CONFIGURATOR WALKTHROUGH (opname) — v2
// Neemt de ECHTE live site op via Playwright, frame-voor-frame (screenshot per frame ->
// ffmpeg -> mp4). Draait op JOUW laptop (die bereikt taleoftiles.com). 9:16, 1080x1920.
//
// Draaien (vanuit ~/Desktop/content-engine):
//   npm i playwright                 (eenmalig)
//   npx playwright install chromium  (eenmalig)
//   FFMPEG=./node_modules/ffmpeg-static/ffmpeg node tools/site-capture.mjs
// Opties via env:
//   TOT_URL=https://taleoftiles.com  TOT_NAME="Café De Kaai"  TOT_FPS=18  TOT_OUT=./out
//
// Dit is de RUWE opname. Branding/muziek/captions (jouw sarcastische lijn) komen er later
// in de engine omheen. We finetunen de stappen samen op basis van wat eruit komt.
//
// v2-fixes t.o.v. v1 (op basis van page.ts): echte selectors —
//   kleuren = .swset span   | tegels verven = klik .pfield polygon/path/rect
//   naam    = eerst accordion "Jouw tekst" openklappen, dan typen (anders blijft 't leeg)
//   patroon = .patbtn       | detail-modus = #mColorMode [data-cm="tile"]
//   in situ = #mScenePick [data-scene="wall"]

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const URL = process.env.TOT_URL || "https://taleoftiles.com";
const LANG = ((process.env.TOT_LANG || "nl").toLowerCase() === "en") ? "en" : "nl";   // NL of EN site
const NAVURL = LANG === "en" ? (URL + (URL.includes("?") ? "&" : "?") + "lang=en") : URL;
const NAME = process.env.TOT_NAME || "Café De Kaai";
const FPS = Number(process.env.TOT_FPS || 18);
const OUT = process.env.TOT_OUT || "./out";
const W = 1080, H = 1920;
const ffmpegBin = process.env.FFMPEG || "ffmpeg";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

(async () => {
  const tmp = fs.mkdirSync(path.join(os.tmpdir(), "tot-site-" + Date.now()), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  let frame = 0;
  // markers: tijdstip (sec) van elke fase -> zodat de content-ready stap exact weet waar te
  // versnellen/vertragen en waar de captions komen (i.p.v. schatten).
  const marks = { fps: FPS };
  const mark = (k) => { marks[k] = +(frame / FPS).toFixed(2); };
  const shot = async (page) => { await page.screenshot({ path: path.join(tmp, `f${String(frame++).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: W, height: H } }).catch(() => {}); };
  const hold = async (page, sec) => { for (let i = 0; i < Math.max(1, Math.round(sec * FPS)); i++) await shot(page); };
  const scrollToY = async (page, toY, sec) => { const from = await page.evaluate(() => window.scrollY); const n = Math.max(1, Math.round(sec * FPS)); for (let i = 0; i < n; i++) { const y = from + (toY - from) * ease(i / (n - 1 || 1)); await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y)); await shot(page); } };
  const yOf = async (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return window.scrollY + r.top; }, sel);
  const scrollToSel = async (page, sel, off, sec) => { const y = await yOf(page, sel); if (y != null) { await scrollToY(page, Math.max(0, y - (off ?? H * 0.12)), sec ?? 1.4); return true; } return false; };
  const log = (m) => console.log("  " + m);
  // pagina-zoom: maakt de live preview groot in beeld (de eyecatcher). Raakt het klikken niet,
  // want dat gaat via tegel-id (dispatchEvent), niet via schermpositie.
  const setZoom = async (page, z) => page.evaluate((zz) => { document.documentElement.style.zoom = String(zz); }, z).catch(() => {});
  // wacht tot een selector daadwerkelijk >0 elementen heeft (max tries*ms)
  const waitCount = async (loc, tries = 15, ms = 400) => { for (let k = 0; k < tries; k++) { const n = await loc.count().catch(() => 0); if (n > 0) return n; await sleep(ms); } return 0; };

  // accordion met kop-tekst t openklappen als-ie dicht staat
  const expandAcc = async (page, needles) => page.evaluate((arr) => {
    const hs = [...document.querySelectorAll(".acc-h")];
    const h = hs.find((x) => { const t = (x.textContent || "").toLowerCase(); return arr.some((n) => t.includes(n)); });
    if (!h) return false;
    const panel = h.closest(".acc");
    if (panel && panel.classList.contains("collapsed")) h.click();
    return true;
  }, (Array.isArray(needles) ? needles : [needles]).map((s) => s.toLowerCase()));

  // sandbox-vriendelijke launch; op jouw laptop pakt-ie de standaard chromium.
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  if (process.env.PW_CHROME) { launchOpts.executablePath = process.env.PW_CHROME; launchOpts.ignoreDefaultArgs = ["--headless"]; launchOpts.args.unshift("--headless=new"); }
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewportSize({ width: W, height: H });
  log("open " + NAVURL + " (taal: " + LANG + ")");
  await page.goto(NAVURL, { waitUntil: "networkidle", timeout: 60000 }).catch(() => page.goto(NAVURL, { timeout: 60000 }));
  await sleep(1200);

  // cookie-/consent best-effort wegklikken
  for (const t of ["Accepteren", "Accepteer", "Akkoord", "Accept", "Sta toe", "OK"]) { const bt = page.locator(`button:has-text("${t}")`).first(); if (await bt.count().catch(() => 0)) { await bt.click({ timeout: 1000 }).catch(() => {}); break; } }

  // TAAL: op mobiel is de taalknop verstopt en de ?lang=en wordt genegeerd -> forceer Engels
  // direct in de pagina (zet de globale LANG en roep de vertaalfunctie aan).
  if (LANG === "en") {
    log("forceer Engels");
    await page.evaluate(() => { try { window.LANG = "en"; localStorage.setItem("tot_lang", "en"); if (typeof applyLang === "function") applyLang(); if (typeof mRender === "function") mRender(); } catch (e) {} }).catch(() => {});
    await sleep(1000);
    const lbl = ((await page.locator("#langLabel").first().textContent().catch(() => "")) || "").trim().toUpperCase();
    if (lbl === "EN") { await page.locator(".langtog").first().click().catch(() => {}); await sleep(700); }   // fallback
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(page, 1.0);

  // 1) HOMEPAGE rustig doorscrollen langs de secties
  log("scroll homepage");
  const H1 = await page.evaluate(() => document.body.scrollHeight);
  const stops = [];
  for (const sel of ["#voorbeelden", "#videos"]) { const y = await yOf(page, sel); if (y != null) stops.push(Math.max(0, y - H * 0.15)); }
  if (!stops.length) { stops.push(H1 * 0.30, H1 * 0.55); }
  for (const s of stops) { await scrollToY(page, s, 2.2); await hold(page, 1.0); }
  mark("homepageEnd");

  // 2) naar de CONFIGURATOR
  log("naar configurator");
  if (!(await scrollToSel(page, "#ontwerpen", H * 0.06, 2.0))) await scrollToSel(page, "#studio", H * 0.06, 2.0);
  await hold(page, 0.8);

  // 3) PATROON kiezen — eerst een willekeurige CATEGORIE openen (anders zijn de meeste
  //    patronen verborgen: in de code staat .patgrid{display:none}, alleen .open staat in
  //    beeld), daarna een willekeurig patroon uit die geopende categorie. Zo zijn ALLE
  //    patronen bereikbaar en roteert het patroon echt per run.
  await expandAcc(page, ["patroon", "pattern"]);
  await hold(page, 0.5);
  const cats = page.locator("#mPattern .patcat");
  const ncat = await cats.count().catch(() => 0);
  log("patroon-categorieen: " + ncat);
  const fieldTiles = page.locator("#mSvgStage .pfield polygon, #mSvgStage .pfield path, #mSvgStage .pfield rect");
  let patternOk = false;
  for (let attempt = 0; attempt < 5 && !patternOk; attempt++) {
    if (ncat) {                                  // open een (nieuwe) willekeurige categorie
      const ci = Math.floor(Math.random() * ncat);
      log("  categorie #" + ci);
      await cats.nth(ci).scrollIntoViewIfNeeded().catch(() => {});
      await cats.nth(ci).click({ force: true }).catch(() => {});
      await hold(page, 0.6);
    }
    let pat = page.locator("#mPattern .patgrid.open .patbtn");
    let npat = await pat.count().catch(() => 0);
    if (!npat) { pat = page.locator(".patbtn:visible"); npat = await pat.count().catch(() => 0); }
    if (!npat) { log("  geen patronen zichtbaar in categorie"); continue; }
    const pk = Math.floor(Math.random() * npat);
    log("  -> patroon #" + pk + " (van " + npat + " in categorie)");
    await pat.nth(pk).scrollIntoViewIfNeeded().catch(() => {});
    await hold(page, 0.3);
    await pat.nth(pk).click({ force: true }).catch(() => {});
    const n = await waitCount(fieldTiles, 18, 400);   // wacht tot de tegels gerenderd zijn (max ~7s)
    if (n > 0) { log("  tegels gerenderd: " + n); patternOk = true; }
    else log("  geen tegels, andere categorie/patroon...");
  }
  await hold(page, 1.2);

  // 4) INKLEUREN — betrouwbaar: we klikken NIET op schermcoordinaten (die liepen weg bij
  //    re-render/scroll en raakten soms de formaat-balk), maar sturen de klik rechtstreeks
  //    naar de juiste tegel via z'n eigen id (data-sig voor groepen, data-tid per tegel).
  //    Mode: TOT_MODE=simpel|detail|auto (auto=willekeurig). Dichtheid detail: TOT_DENSITY.
  let mode = (process.env.TOT_MODE || "auto").toLowerCase();
  if (mode !== "simpel" && mode !== "detail") mode = Math.random() < 0.5 ? "simpel" : "detail";
  log("inkleur-modus: " + mode);
  mark("colorStart");

  await setZoom(page, 1.7);                              // INZOOMEN op de live preview = eyecatcher
  await scrollToSel(page, "#mSvgStage", H * 0.26, 1.2);

  let sw = page.locator(".tilesw");
  let nsw = await waitCount(sw, 30, 400);                 // ruim wachten tot de palet-strip er is (~12s)
  if (!nsw) { sw = page.locator(".swset span, .swatches .sw"); nsw = await waitCount(sw, 10, 400); }
  // HARMONIEUZE kleuren: NIET elke tegel een willekeurige swatch (dat botst -> lelijk, zoals
  // Mo zag), maar een BEPERKT, samenhangend setje naburige swatches (tonaal verwant op de
  // strip) voor dit filmpje. Zo oogt het paneel als één kleurenverhaal i.p.v. confetti.
  const palN = Math.min(5, Math.max(3, nsw || 3));
  const palStart = nsw > palN ? Math.floor(Math.random() * (nsw - palN)) : 0;
  const palIdx = Array.from({ length: palN }, (_, i) => palStart + i);
  const pickCol = async () => { if (nsw) await sw.nth(palIdx[Math.floor(Math.random() * palIdx.length)]).dispatchEvent("click").catch(() => {}); };  // samenhangend
  const tileSel = "#mSvgStage .pfield polygon, #mSvgStage .pfield path, #mSvgStage .pfield rect";
  const nt = await waitCount(page.locator(tileSel), 20, 400);
  log("kleuren: " + nsw + " swatches, " + nt + " tegels");

  if (!nsw) {
    log("LET OP: geen kleur-swatches gevonden -> inkleuren OVERGESLAGEN (voorkomt een blanco paneel)");
  } else {
  // 4a) VOL kleuren in GROEP-modus: één klik per UNIEKE groep (data-sig) -> elke groep kleurt.
  const cmGroup = page.locator('#mColorMode [data-cm="group"]').first();
  if (await cmGroup.count().catch(() => 0)) { await cmGroup.dispatchEvent("click").catch(() => {}); await hold(page, 0.5); }
  const sigs = await page.$$eval(tileSel, (els) => [...new Set(els.map((e) => e.getAttribute("data-sig")).filter(Boolean))]).catch(() => []);
  log("groepen: " + sigs.length);
  for (const sig of sigs.slice(0, 40)) {
    await pickCol();
    await page.locator('#mSvgStage .pfield [data-sig="' + sig + '"]').first().dispatchEvent("click").catch(() => {});
    await hold(page, sigs.length <= 10 ? 0.5 : 0.28);
  }
  await hold(page, 1.2);

  // 4b) alleen DETAIL: tegel-voor-tegel verfijnen (veeg boven->onder), op het al volle paneel.
  if (mode === "detail") {
    const cmTile = page.locator('#mColorMode [data-cm="tile"]').first();
    if (await cmTile.count().catch(() => 0)) { await cmTile.dispatchEvent("click").catch(() => {}); await hold(page, 0.5); }
    // volgorde 1x bepalen op positie; klikken daarna via stabiel data-tid (schuift niet mee)
    const order = await page.$$eval(tileSel, (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { tid: e.getAttribute("data-tid"), y: r.top, x: r.left }; }).filter((t) => t.tid).sort((a, b) => (Math.round(a.y / 14) - Math.round(b.y / 14)) || (a.x - b.x)).map((t) => t.tid)).catch(() => []);
    const want = Number(process.env.TOT_DENSITY || 160);
    const STEP = Math.max(1, Math.round(order.length / Math.max(1, want)));
    let c = 0;
    for (let i = 0; i < order.length; i += STEP) {
      if (c % 3 === 0) await pickCol();
      await page.locator('#mSvgStage .pfield [data-tid="' + order[i] + '"]').first().dispatchEvent("click").catch(() => {});
      await hold(page, 0.07);
      c++;
    }
    await hold(page, 1.4);
  }
  } // einde inkleur-blok (alleen uitgevoerd als er swatches waren)
  mark("colorEnd");

  // 5) NAAM typen — nu pas, op het al ingekleurde paneel. Accordion "Jouw tekst" openklappen.
  await setZoom(page, 1);                                // uitzoomen zodat het naamveld bereikbaar is
  await expandAcc(page, ["tekst", "text"]);
  await hold(page, 0.4);
  const nm = page.locator("#mName").first();
  if (await nm.count().catch(() => 0)) {
    log("typ naam: " + NAME);
    await nm.scrollIntoViewIfNeeded().catch(() => {});
    await hold(page, 0.4);
    await nm.click().catch(() => {});
    await nm.fill("").catch(() => {});
    for (const ch of NAME) { await nm.type(ch, { delay: 0 }).catch(() => {}); await shot(page); await shot(page); await shot(page); }
    await hold(page, 0.5);
  } else log("let op: #mName niet gevonden");

  // 6) VOORBEELD: het complete paneel (patroon + kleur + naam) groot in beeld
  mark("preview");
  await setZoom(page, 1.7);
  await scrollToSel(page, "#mSvgStage", H * 0.24, 1.4);
  await hold(page, 1.9);
  await setZoom(page, 1);

  // 7) BEKIJK IN EEN RUIMTE: in situ — kantoor, gevel, balie — per scene INZOOMEN op het voorbeeld
  mark("scenes");
  if (await page.locator("#mScenePick").count().catch(() => 0)) {
    for (const [val, label] of [["office", "Kantoor"], ["facade", "Gevel"], ["wall", "Balie"]]) {
      const b = page.locator('#mScenePick [data-scene="' + val + '"]').first();
      if (!(await b.count().catch(() => 0))) continue;
      log("ruimte: " + label);
      await setZoom(page, 1);
      await scrollToSel(page, "#mSceneStage", H * 0.18, 0.8);
      await b.dispatchEvent("click").catch(() => {});
      await hold(page, 1.0);                     // de volle scene tonen (paneel netjes op de muur)
      await setZoom(page, 1.2);                  // lichte inzoom — paneel blijft realistisch op de muur
      await scrollToSel(page, "#mSceneStage", H * 0.16, 1.0);
      await hold(page, 1.6);
    }
    await setZoom(page, 1);
    await hold(page, 1.0);
  }

  mark("end");
  await browser.close();

  // markers wegschrijven naast de mp4 (voor de content-ready stap in de engine)
  try { fs.writeFileSync(path.join(OUT, "site-walkthrough.markers.json"), JSON.stringify(marks)); } catch {}

  // frames -> mp4
  log("frames: " + frame + " -> mp4");
  await new Promise((res, rej) => {
    const args = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", `scale=${W}:${H}`, path.join(OUT, "site-walkthrough.mp4")];
    const pr = spawn(ffmpegBin, args, { stdio: "ignore", windowsHide: true });
    pr.on("error", rej); pr.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  });
  console.log("KLAAR -> " + path.join(OUT, "site-walkthrough.mp4"));
})().catch((e) => { console.error("FOUT:", e.message); process.exit(1); });
