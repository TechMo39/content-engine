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

  // ---- ZICHTBARE CURSOR: een zwevende aanwijzer in de pagina, zodat de kijker ZIET dat er
  // geklikt wordt (de echte klik gaat nog steeds via dispatchEvent, dit is puur beeld). We
  // injecteren 'm één keer en bewegen 'm vloeiend naar het doel, met een klik-rimpel.
  const cursorInit = async (page) => page.evaluate(() => {
    if (document.getElementById("__wtcur")) return;
    const c = document.createElement("div"); c.id = "__wtcur";
    c.style.cssText = "position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transition:none;will-change:transform;transform:translate(-100px,-100px)";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M2 2 L2 20 L7 15 L11 23 L14 22 L10 14 L17 14 Z" fill="#fff" stroke="#1a1327" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const r = document.createElement("div"); r.id = "__wtrip";
    r.style.cssText = "position:fixed;left:0;top:0;width:34px;height:34px;border-radius:50%;z-index:2147483646;pointer-events:none;border:2px solid #d6b35a;opacity:0;transform:translate(-100px,-100px) scale(0.3)";
    document.body.appendChild(r);
  });
  // viewport-positie (midden) van een element, rekening houdend met document.zoom
  const centerOf = async (page, sel) => page.evaluate((s) => {
    const el = document.querySelector(s); if (!el) return null;
    const z = parseFloat(document.documentElement.style.zoom || "1") || 1;
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.width / 2) * z, y: (r.top + r.height / 2) * z };
  }, sel);
  const cursorSet = async (page, x, y) => page.evaluate(([X, Y]) => { const c = document.getElementById("__wtcur"); if (c) c.style.transform = `translate(${X}px,${Y}px)`; }, [x, y]);
  // beweeg de cursor vloeiend van z'n huidige plek naar (x,y) over sec seconden (filmt mee)
  let curX = W / 2, curY = H / 2;
  const cursorMove = async (page, x, y, sec = 0.5) => {
    const n = Math.max(1, Math.round((sec || 0.5) * FPS)), fx = curX, fy = curY;
    for (let i = 0; i < n; i++) { const k = ease(i / (n - 1 || 1)); await cursorSet(page, fx + (x - fx) * k, fy + (y - fy) * k); await shot(page); }
    curX = x; curY = y;
  };
  // klik-rimpel op de cursor-plek (beeld); de echte klik doet de caller via dispatchEvent
  const cursorTap = async (page, sec = 0.22) => {
    await page.evaluate(([X, Y]) => { const r = document.getElementById("__wtrip"); if (r) { r.style.transition = "none"; r.style.transform = `translate(${X - 4}px,${Y - 4}px) scale(0.3)`; r.style.opacity = "0.9"; requestAnimationFrame(() => { r.style.transition = "transform .22s ease-out,opacity .22s ease-out"; r.style.transform = `translate(${X - 4}px,${Y - 4}px) scale(1.5)`; r.style.opacity = "0"; }); } }, [curX, curY]);
    await hold(page, sec);
  };
  // beweeg cursor naar een selector + tik (puur beeld); geeft terug of het element bestond
  const cursorToSel = async (page, sel, moveSec = 0.5) => {
    const p = await centerOf(page, sel); if (!p) return false;
    await cursorMove(page, p.x, p.y, moveSec); await cursorTap(page); return true;
  };

  // ---- FOCUS OP ÉÉN ELEMENT: scroll + zoom zo dat dit element groot en rustig in beeld staat.
  // Vervangt het heen-en-weer tussen vaste zooms: we richten de "camera" op wat er nu toe doet.
  const focusOn = async (page, sel, { zoom = 1.6, topFrac = 0.30, sec = 1.0 } = {}) => {
    await setZoom(page, 1);                                   // meet op ware grootte
    const y = await yOf(page, sel); if (y == null) return false;
    await scrollToY(page, Math.max(0, y - H * topFrac), sec * 0.6);
    // zoom vloeiend op (een paar tussenstappen) i.p.v. een harde sprong
    const steps = Math.max(1, Math.round(sec * 0.4 * FPS));
    for (let i = 1; i <= steps; i++) { await setZoom(page, 1 + (zoom - 1) * ease(i / steps)); await shot(page); }
    // na het inzoomen het element terug netjes in beeld schuiven
    const y2 = await yOf(page, sel); if (y2 != null) await scrollToY(page, Math.max(0, y2 - H * (topFrac / zoom)), 0.4);
    return true;
  };

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
  await cursorInit(page);
  await hold(page, 0.6);

  // 1) GEEN homepage-rondleiding meer (die kostte alleen tijd en toonde niet het ontwerpen).
  // We gaan DIRECT naar de configurator — dat is waar de walkthrough over gaat.
  log("direct naar configurator");
  if (!(await scrollToSel(page, "#ontwerpen", H * 0.06, 1.2))) await scrollToSel(page, "#studio", H * 0.06, 1.2);
  mark("homepageEnd");   // behouden als marker-naam voor finish.mjs (= begin configurator)
  await hold(page, 0.6);

  // 3) PATROON kiezen — eerst een willekeurige CATEGORIE openen (anders zijn de meeste
  //    patronen verborgen: in de code staat .patgrid{display:none}, alleen .open staat in
  //    beeld), daarna een willekeurig patroon uit die geopende categorie. Zo zijn ALLE
  //    patronen bereikbaar en roteert het patroon echt per run.
  mark("patternStart");
  await expandAcc(page, ["patroon", "pattern"]);
  await hold(page, 0.4);
  // FOCUS op het patroon-keuzegebied (rustige, grote uitsnede op wat er nu toe doet).
  await focusOn(page, "#mPattern", { zoom: 1.35, topFrac: 0.14, sec: 1.0 });
  const cats = page.locator("#mPattern .patcat");
  const ncat = await cats.count().catch(() => 0);
  log("patroon-categorieen: " + ncat);
  const fieldTiles = page.locator("#mSvgStage .pfield polygon, #mSvgStage .pfield path, #mSvgStage .pfield rect");
  let patternOk = false, lastPatSig = null;
  for (let attempt = 0; attempt < 5 && !patternOk; attempt++) {
    if (ncat) {                                  // open een (nieuwe) willekeurige categorie
      const ci = Math.floor(Math.random() * ncat);
      log("  categorie #" + ci);
      await cats.nth(ci).scrollIntoViewIfNeeded().catch(() => {});
      await cursorToSel(page, `#mPattern .patcat:nth-of-type(${ci + 1})`, 0.45).catch(() => {});   // cursor naar de categorie
      await cats.nth(ci).click({ force: true }).catch(() => {});
      await hold(page, 0.5);
    }
    let pat = page.locator("#mPattern .patgrid.open .patbtn");
    let npat = await pat.count().catch(() => 0);
    if (!npat) { pat = page.locator(".patbtn:visible"); npat = await pat.count().catch(() => 0); }
    if (!npat) { log("  geen patronen zichtbaar in categorie"); continue; }
    const pk = Math.floor(Math.random() * npat);
    log("  -> patroon #" + pk + " (van " + npat + " in categorie)");
    await pat.nth(pk).scrollIntoViewIfNeeded().catch(() => {});
    // CURSOR zichtbaar naar de gekozen patroon-knop bewegen en tikken (beeld), dan echt klikken.
    try { const bb = await pat.nth(pk).boundingBox(); if (bb) { const z = await page.evaluate(() => parseFloat(document.documentElement.style.zoom || "1") || 1); await cursorMove(page, (bb.x + bb.width / 2) * z, (bb.y + bb.height / 2) * z, 0.5); await cursorTap(page); } } catch {}
    await pat.nth(pk).click({ force: true }).catch(() => {});
    const n = await waitCount(fieldTiles, 18, 400);   // wacht tot de tegels gerenderd zijn (max ~7s)
    if (n > 0) { log("  tegels gerenderd: " + n); patternOk = true; }
    else log("  geen tegels, andere categorie/patroon...");
  }
  await hold(page, 1.0);

  // 4) INKLEUREN — betrouwbaar: we klikken NIET op schermcoordinaten (die liepen weg bij
  //    re-render/scroll en raakten soms de formaat-balk), maar sturen de klik rechtstreeks
  //    naar de juiste tegel via z'n eigen id (data-sig voor groepen, data-tid per tegel).
  //    Mode: TOT_MODE=simpel|detail|auto (auto=willekeurig). Dichtheid detail: TOT_DENSITY.
  let mode = (process.env.TOT_MODE || "auto").toLowerCase();
  if (mode !== "simpel" && mode !== "detail") mode = Math.random() < 0.5 ? "simpel" : "detail";
  log("inkleur-modus: " + mode);
  mark("colorStart");

  // FOCUS op de live preview + het palet (dat is de hero: hier gebeurt het inkleuren).
  await focusOn(page, "#mSvgStage", { zoom: 1.6, topFrac: 0.24, sec: 1.1 });

  let sw = page.locator(".tilesw");
  let nsw = await waitCount(sw, 30, 400);                 // ruim wachten tot de palet-strip er is (~12s)
  if (!nsw) { sw = page.locator(".swset span, .swatches .sw"); nsw = await waitCount(sw, 10, 400); }
  // HARMONIEUZE kleuren: NIET elke tegel een willekeurige swatch (dat botst -> lelijk, zoals
  // Mo zag), maar een BEPERKT, samenhangend setje naburige swatches (tonaal verwant op de
  // strip) voor dit filmpje. Zo oogt het paneel als één kleurenverhaal i.p.v. confetti.
  const palN = Math.min(5, Math.max(3, nsw || 3));
  const palStart = nsw > palN ? Math.floor(Math.random() * (nsw - palN)) : 0;
  const palIdx = Array.from({ length: palN }, (_, i) => palStart + i);
  // kies een swatch; met showCursor=true beweegt de zichtbare cursor er eerst heen + tikt
  // (zodat de kijker ZIET dat er een kleur gekozen wordt). De echte selectie blijft dispatchEvent.
  const pickCol = async (showCursor = false) => {
    if (!nsw) return;
    const idx = palIdx[Math.floor(Math.random() * palIdx.length)];
    if (showCursor) { try { const bb = await sw.nth(idx).boundingBox(); if (bb) { const z = await page.evaluate(() => parseFloat(document.documentElement.style.zoom || "1") || 1); await cursorMove(page, (bb.x + bb.width / 2) * z, (bb.y + bb.height / 2) * z, 0.4); await cursorTap(page, 0.12); } } catch {} }
    await sw.nth(idx).dispatchEvent("click").catch(() => {});
  };
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
  let gi = 0;
  // RUSTIGER: minder groepen (max 18 i.p.v. 40) en LANGERE holds, zodat elke kleurklik te volgen
  // is i.p.v. een flikkering. De eerste vier laten we met de zichtbare cursor zien zodat de kijker
  // het mechanisme snapt; daarna iets vlotter, maar nog steeds met rust tussen de klikken.
  for (const sig of sigs.slice(0, 18)) {
    const showIt = gi < 4;
    await pickCol(showIt);
    const grp = page.locator('#mSvgStage .pfield [data-sig="' + sig + '"]').first();
    if (showIt) { try { const bb = await grp.boundingBox(); if (bb) { const z = await page.evaluate(() => parseFloat(document.documentElement.style.zoom || "1") || 1); await cursorMove(page, (bb.x + bb.width / 2) * z, (bb.y + bb.height / 2) * z, 0.5); await cursorTap(page, 0.18); } } catch {} }
    await grp.dispatchEvent("click").catch(() => {});
    await hold(page, showIt ? 0.7 : 0.45);
    gi++;
  }
  await hold(page, 1.2);

  // 4b) alleen DETAIL: tegel-voor-tegel verfijnen (veeg boven->onder), op het al volle paneel.
  if (mode === "detail") {
    const cmTile = page.locator('#mColorMode [data-cm="tile"]').first();
    if (await cmTile.count().catch(() => 0)) { await cmTile.dispatchEvent("click").catch(() => {}); await hold(page, 0.5); }
    // volgorde 1x bepalen op positie; klikken daarna via stabiel data-tid (schuift niet mee)
    const order = await page.$$eval(tileSel, (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { tid: e.getAttribute("data-tid"), y: r.top, x: r.left }; }).filter((t) => t.tid).sort((a, b) => (Math.round(a.y / 14) - Math.round(b.y / 14)) || (a.x - b.x)).map((t) => t.tid)).catch(() => []);
    // RUSTIGER: veel MINDER tegels (standaard 40 i.p.v. 160) en LANGERE holds per tegel, zodat je
    // echt ZIET dat er tegel voor tegel ingekleurd wordt i.p.v. een razendsnelle flikkering. De
    // cursor volgt nu elke 3e tegel (meer zichtbare hand), met een iets langere beweging.
    const want = Number(process.env.TOT_DENSITY || 40);
    const STEP = Math.max(1, Math.round(order.length / Math.max(1, want)));
    let c = 0;
    for (let i = 0; i < order.length; i += STEP) {
      if (c % 3 === 0) await pickCol(c < 4);   // eerste paar kleurkeuzes zichtbaar met de cursor
      const tile = page.locator('#mSvgStage .pfield [data-tid="' + order[i] + '"]').first();
      if (c % 3 === 0) { try { const bb = await tile.boundingBox(); if (bb) { const z = await page.evaluate(() => parseFloat(document.documentElement.style.zoom || "1") || 1); await cursorMove(page, (bb.x + bb.width / 2) * z, (bb.y + bb.height / 2) * z, 0.22); } } catch {} }
      await tile.dispatchEvent("click").catch(() => {});
      await hold(page, 0.2);
      c++;
    }
    await hold(page, 1.4);
  }
  } // einde inkleur-blok (alleen uitgevoerd als er swatches waren)
  mark("colorEnd");

  // 5) NAAM typen — nu pas, op het al ingekleurde paneel. Accordion "Jouw tekst" openklappen.
  mark("nameStart");
  await setZoom(page, 1);                                // uitzoomen zodat het naamveld bereikbaar is
  await expandAcc(page, ["tekst", "text"]);
  await hold(page, 0.4);
  const nm = page.locator("#mName").first();
  if (await nm.count().catch(() => 0)) {
    log("typ naam: " + NAME);
    await nm.scrollIntoViewIfNeeded().catch(() => {});
    // FOCUS op het naamveld + de cursor er zichtbaar heen bewegen en erin "klikken".
    await focusOn(page, "#mName", { zoom: 1.5, topFrac: 0.26, sec: 0.9 });
    await cursorToSel(page, "#mName", 0.5).catch(() => {});
    await nm.click().catch(() => {});
    await nm.fill("").catch(() => {});
    for (const ch of NAME) { await nm.type(ch, { delay: 0 }).catch(() => {}); await shot(page); await shot(page); await shot(page); }
    await hold(page, 0.6);
  } else log("let op: #mName niet gevonden");

  // 6) VOORBEELD: het complete paneel (patroon + kleur + naam) groot en RUSTIG in beeld.
  // Langer laten staan zodat de kijker het eindresultaat echt opneemt (was 2.0s).
  mark("preview");
  await focusOn(page, "#mSvgStage", { zoom: 1.6, topFrac: 0.22, sec: 1.4 });
  await hold(page, 3.0);

  // 7) BEKIJK IN EEN RUIMTE: in situ — kantoor, gevel, balie. Per scene de cursor zichtbaar op de
  // knop, dan RUSTIG de scene tonen. Langere holds (was 0.8/1.5) zodat elke ruimte blijft hangen.
  mark("scenes");
  if (await page.locator("#mScenePick").count().catch(() => 0)) {
    await setZoom(page, 1);
    await scrollToSel(page, "#mScenePick", H * 0.12, 1.0);
    for (const [val, label] of [["office", "Kantoor"], ["facade", "Gevel"], ["wall", "Balie"]]) {
      const b = page.locator('#mScenePick [data-scene="' + val + '"]').first();
      if (!(await b.count().catch(() => 0))) continue;
      log("ruimte: " + label);
      await cursorToSel(page, '#mScenePick [data-scene="' + val + '"]', 0.55).catch(() => {});   // cursor op de knop
      await b.dispatchEvent("click").catch(() => {});
      await hold(page, 1.1);
      await focusOn(page, "#mSceneStage", { zoom: 1.25, topFrac: 0.16, sec: 1.1 });               // rustige inzoom op de scene
      await hold(page, 2.2);
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
