// tools/portal-capture.mjs
// -------------------------------------------------------------------------
// SLIMME recorder voor de UncleRank-content. Neemt het portaal INGELOGD op, maar niet meer als
// platte scroll: hij mikt op de delen die VERKOPEN en zet er per deel een stilstaand beeld van klaar
// met de bounding-box van het element erbij. De engine (makePortalRender) maakt daar daarna een
// rustige push-in (inzoomen) van met ffmpeg-zoompan, waarbij de zoom zich aanpast aan de grootte van
// het element. Zo zie je gericht: een hot lead met z'n vak + reden, en in het dossier "Waarom nu",
// "Wat er op hun site staat" (het signaal) en "Wat de klus waard is" (de euro-waarde).
//
// Alle herleidbare bedrijfs-/contactdata blijft vervaagd (naam, telefoon, domein, e-mail) — in de
// stills én wanneer erop ingezoomd wordt (de blur zit in de pixels). Branche en stad blijven staan.
//
// Draait op JOUW laptop (bereikt de site + heeft de browser + de login-sessie). Lukt het gericht
// vastleggen niet (andere opmaak, niet ingelogd, geen dossier), dan valt hij netjes terug op de oude
// vloeiende scroll-walkthrough, zodat een render nooit leeg is.
//
// Uitvoer in UR_OUT:
//   portal-shots.json         { w, h, fps, shots:[{name, file, rect:{x,y,w,h}}] }  (de slimme weg)
//   shot-NN-*.png             de stills per doel
//   portal-walkthrough.mp4    alleen als terugval (geen enkel doel gevonden)
//
// Env: UR_PORTAL_URL, UR_PORTAL_STATE (login storageState), UR_OUT, UR_W/UR_H, UR_SECONDS (terugval-
//      scrollduur), UR_FPS, UR_BLUR (komma-selectors), FFMPEG, PW_CHROME. --login = sessie opslaan.
//
// EENMALIG INLOGGEN:
//   UR_PORTAL_STATE=assets/unclerank/portal-state.json \
//   UR_PORTAL_URL=https://portaal.unclerank.com node tools/portal-capture.mjs --login
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

// ALLE herleidbare bedrijfs-/contactdata vervagen (naam, telefoon, domein, e-mail), in de lijst én
// het dossier. Branche en stad blijven (generiek). Overschrijfbaar via UR_BLUR.
const BLUR_SEL = process.env.UR_BLUR || [
  ".kaart .naam",
  ".kaart .onder .mono",
  ".kaart .onder span:not(.mono):not(:has(b))",
  ".balk .naam",
  ".dkop h1",
  ".bel a",
  "a[href^='mailto:']",
  "a[href^='tel:']",
].join(", ");

const log = (...a) => console.log(...a);
const ease = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ---- EENMALIGE LOGIN-STAND -------------------------------------------------------------------
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
  const haveState = STATE && fs.existsSync(STATE);
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, storageState: haveState ? STATE : undefined });
  const page = await ctx.newPage();

  // Bedrijfsdata vervagen + scrollbar weg, via init-script op ELKE pagina (lijst én dossier).
  await page.addInitScript((sel) => {
    const parts = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    const css = parts.map((p) => p + "{filter:blur(9px) !important}").join(" ")
      + " ::-webkit-scrollbar{width:0;height:0} html{scrollbar-width:none} *{scroll-behavior:auto !important}";
    const add = () => { const s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
    if (document.head) add(); else document.addEventListener("DOMContentLoaded", add);
  }, BLUR_SEL);

  log("portaal-opname: " + URL + (haveState ? " (ingelogd)" : " (NIET ingelogd — zet UR_PORTAL_STATE)"));
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 }).catch(async () => {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(600);

  // ---- helpers -------------------------------------------------------------------------------
  let shotN = 0;
  const shots = [];
  // Zet een element verticaal in het midden, laat de pagina tot rust komen, screenshot de viewport,
  // en bewaar de bounding-box van het element (viewport-coördinaten) zodat de engine erop kan inzoomen.
  const captureTarget = async (name, selector, nth = 0) => {
    try {
      const rect = await page.evaluate(({ sel, k }) => {
        const els = Array.from(document.querySelectorAll(sel));
        const el = els[k];
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        return null; // rect lezen we NA het settelen opnieuw
      }, { sel: selector, k: nth });
      await sleep(450);
      const box = await page.evaluate(({ sel, k }) => {
        const el = Array.from(document.querySelectorAll(sel))[k];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return null;
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      }, { sel: selector, k: nth });
      if (!box) return false;
      // box binnen de viewport klemmen
      const rc = {
        x: Math.max(0, Math.min(W - 1, box.x)),
        y: Math.max(0, Math.min(H - 1, box.y)),
        w: Math.max(8, Math.min(W, box.w)),
        h: Math.max(8, Math.min(H, box.h)),
      };
      if (rc.x + rc.w > W) rc.w = W - rc.x;
      if (rc.y + rc.h > H) rc.h = H - rc.y;
      const file = `shot-${String(shotN++).padStart(2, "0")}-${name}.png`;
      await page.screenshot({ path: path.join(OUT, file), clip: { x: 0, y: 0, width: W, height: H } });
      shots.push({ name, file, rect: rc });
      log(`  ✓ ${name}  box ${rc.w}x${rc.h} @ ${rc.x},${rc.y}`);
      return true;
    } catch (e) {
      log(`  · ${name} overgeslagen: ${e.message}`);
      return false;
    }
  };

  // ---- 1) LIJST: een paar representatieve lead-kaarten (vak + reden + label), hotste eerst --------
  // volgorde van voorkeur per kaart; we pakken tot 2 kaarten zodat je vak-variatie ziet
  const CARD_SEL = ".kaart:has(.label.bellen), .kaart:has(.label.gesprek), a.kaart, .kaart";
  const nCards = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SEL).catch(() => 0);
  if (nCards > 0) {
    await captureTarget("lead", CARD_SEL, 0);
    if (nCards > 2) await captureTarget("lead2", CARD_SEL, 2);
  }

  // ---- 2) DOSSIER: doorklikken op de hotste kaart en de verkoop-blokken inzoomen -----------------
  const HOT = ".kaart:has(.label.gesprek), .kaart:has(.label.bellen), a.kaart";
  try {
    const hasHot = await page.evaluate((sel) => !!document.querySelector(sel), HOT);
    if (hasHot) {
      await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: "center" }); }, HOT);
      await sleep(300);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 30000 }).catch(() => {}),
        page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.click(); }, HOT),
      ]);
      await sleep(700);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
      // de blokken die verkopen, in verhaalvolgorde (uit dossier.mjs: .vak met .vakkop):
      await captureTarget("dossier-kop", ".dkop", 0);                         // wie + vak + label
      // "Waarom nu" / "Uit een gesprek"
      if (!(await captureTarget("waarom", ".vak.waarom", 0)))
        await captureTarget("waarom", ".vak.gemeld", 0);
      // "Wat er op hun site staat" = het signaal (blok met .vondsten)
      await captureTarget("signaal", ".vak:has(.vondsten)", 0);
      // "Wat de klus waard is" = de euro-waarde (blok met .klus; we mikken op het bedrag)
      if (!(await captureTarget("waarde", ".vak:has(.klus) .klus", 0)))
        await captureTarget("waarde", ".vak:has(.klus)", 0);
    }
  } catch (e) { log("dossier-stap overgeslagen: " + e.message); }

  // ---- shots wegschrijven, of terugvallen op de oude scroll-walkthrough --------------------------
  if (shots.length) {
    fs.writeFileSync(path.join(OUT, "portal-shots.json"), JSON.stringify({ w: W, h: H, fps: 30, shots }, null, 2));
    log(`klaar: ${shots.length} gericht beeld -> portal-shots.json`);
    await browser.close();
    process.exit(0);
  }

  // ===== TERUGVAL: oude vloeiende scroll-walkthrough naar één mp4 (zodat een render nooit leeg is) ==
  log("geen gerichte beelden gevonden — terugval naar scroll-walkthrough");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urportal-"));
  let frame = 0;
  const shot = async () => {
    await page.screenshot({ path: path.join(tmp, `f${String(frame++).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: W, height: H } }).catch(() => {});
  };
  const scrollToY = async (toY, sec) => {
    const from = await page.evaluate(() => window.scrollY);
    const n = Math.max(1, Math.round(sec * FPS));
    for (let i = 0; i < n; i++) {
      const y = from + (toY - from) * ease(i / (n - 1 || 1));
      await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y));
      await shot();
    }
  };
  const hold = async (sec) => { const n = Math.max(1, Math.round(sec * FPS)); for (let i = 0; i < n; i++) await shot(); };
  const maxY = await page.evaluate((vh) => Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - vh), H);
  const stops = []; for (let i = 1; i <= 5; i++) stops.push(Math.round(maxY * i / 5));
  const per = Math.max(0.7, SECS / Math.max(1, stops.length));
  await hold(0.7);
  for (const y of stops) { await scrollToY(y, per); await hold(0.4); }
  await browser.close();

  log("frames: " + frame + " -> mp4");
  await new Promise((res, rej) => {
    const args = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", `scale=${W}:${H}`, path.join(OUT, "portal-walkthrough.mp4")];
    const pr = spawn(ffmpegBin, args, { stdio: "ignore", windowsHide: true });
    pr.on("error", rej);
    pr.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  log("klaar (terugval): " + path.join(OUT, "portal-walkthrough.mp4"));
})().catch((e) => { console.error("portaal-opname faalde: " + (e && e.message || e)); process.exit(1); });
