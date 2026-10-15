// Tale of Tiles — WEBSITE / CONFIGURATOR WALKTHROUGH (opname)
// Neemt de ECHTE live site op via Playwright, frame-voor-frame (screenshot per frame ->
// ffmpeg -> mp4). Draait op JOUW laptop (die bereikt taleoftiles.com). 9:16, 1080x1920.
//
// Draaien:
//   npm i playwright            (eenmalig)
//   npx playwright install chromium   (eenmalig)
//   node tools/site-capture.mjs
// Opties via env:
//   TOT_URL=https://taleoftiles.com   TOT_NAME="Café De Kaai"   TOT_FPS=18   TOT_OUT=./out
//
// Dit is de RUWE opname. Branding/muziek/captions (jouw sarcastische lijn) komen er later
// in de engine omheen. We finetunen de stappen samen op basis van wat eruit komt.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const URL = process.env.TOT_URL || "https://taleoftiles.com";
const NAME = process.env.TOT_NAME || "Café De Kaai";
const FPS = Number(process.env.TOT_FPS || 18);
const OUT = process.env.TOT_OUT || "./out";
const W = 1080, H = 1920;
const ffmpegBin = process.env.FFMPEG || "ffmpeg";   // of het ffmpeg-static pad

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

(async () => {
  const tmp = fs.mkdirSync(path.join(os.tmpdir(), "tot-site-" + Date.now()), { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  let frame = 0;
  const shot = async (page) => { await page.screenshot({ path: path.join(tmp, `f${String(frame++).padStart(5, "0")}.png`), clip: { x: 0, y: 0, width: W, height: H } }).catch(() => {}); };
  const hold = async (page, sec) => { for (let i = 0; i < Math.max(1, Math.round(sec * FPS)); i++) await shot(page); };
  const scrollTo = async (page, toY, sec) => { const from = await page.evaluate(() => window.scrollY); const n = Math.max(1, Math.round(sec * FPS)); for (let i = 0; i < n; i++) { const y = from + (toY - from) * ease(i / (n - 1 || 1)); await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y)); await shot(page); } };
  const yOf = async (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return window.scrollY + r.top; }, sel);
  const log = (m) => console.log("  " + m);

  // sandbox-vriendelijke launch (werkt ook met vooraf-geïnstalleerde chromium); op jouw
  // laptop pakt-ie gewoon de standaard chromium.
  const launchOpts = { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] };
  if (process.env.PW_CHROME) { launchOpts.executablePath = process.env.PW_CHROME; launchOpts.ignoreDefaultArgs = ["--headless"]; launchOpts.args.unshift("--headless=new"); }
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  await page.setViewportSize({ width: W, height: H });
  log("open " + URL);
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 }).catch(() => page.goto(URL, { timeout: 60000 }));
  await sleep(1200);

  // cookie-/consent-knop best-effort wegklikken
  for (const t of ["Accepteren", "Accepteer", "Akkoord", "Accept", "Sta toe", "OK"]) { const bt = page.locator(`button:has-text("${t}")`).first(); if (await bt.count().catch(() => 0)) { await bt.click({ timeout: 1000 }).catch(() => {}); break; } }
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(page, 1.0);

  // 1) HOMEPAGE rustig doorscrollen langs de secties
  log("scroll homepage");
  const H1 = await page.evaluate(() => document.body.scrollHeight);
  const stops = [];
  for (const sel of ["#voorbeelden", "#videos"]) { const y = await yOf(page, sel); if (y != null) stops.push(Math.max(0, y - H * 0.15)); }
  if (!stops.length) { stops.push(H1 * 0.33, H1 * 0.6); }
  for (const s of stops) { await scrollTo(page, s, 2.2); await hold(page, 1.1); }

  // 2) naar de CONFIGURATOR
  const yCfg = (await yOf(page, "#ontwerpen")) ?? (await yOf(page, "#studio"));
  if (yCfg != null) { log("naar configurator"); await scrollTo(page, Math.max(0, yCfg - H * 0.08), 2.0); await hold(page, 0.8); }

  // 3) NAAM typen
  const nm = page.locator("#mName").first();
  if (await nm.count().catch(() => 0)) {
    log("typ naam: " + NAME);
    await nm.scrollIntoViewIfNeeded().catch(() => {});
    await nm.click().catch(() => {}); await nm.fill("").catch(() => {});
    for (const ch of NAME) { await nm.type(ch, { delay: 0 }).catch(() => {}); await shot(page); await shot(page); }
    await hold(page, 1.0);
  } else log("let op: #mName niet gevonden");

  // 4) PATROON kiezen
  const pats = page.locator("#mPattern button, #mPattern [role=button], #mPattern img, #mPattern > *");
  const np = await pats.count().catch(() => 0);
  if (np) { log("kies patroon (" + np + " beschikbaar)"); await pats.nth(Math.min(2, np - 1)).click({ force: true }).catch(() => {}); await hold(page, 1.3); }
  else log("let op: #mPattern items niet gevonden");

  // 5) GEDETAILLEERDE kleurmodus + tegel-voor-tegel inkleuren
  const cm = page.locator("#mColorMode button, #mColorMode > *");
  const ncm = await cm.count().catch(() => 0);
  if (ncm > 1) { log("kleurmodus: gedetailleerd"); await cm.nth(ncm - 1).click({ force: true }).catch(() => {}); await hold(page, 0.7); }
  const sw = page.locator("#mPalette button, #mPalette [role=button], #mPalette > *");
  const nsw = await sw.count().catch(() => 0);
  const tiles = page.locator("#mSvgStage [data-i], #mSvgStage polygon, #mSvgStage path, #mSvgStage rect");
  const nt = await tiles.count().catch(() => 0);
  log("kleuren: " + nsw + " swatches, " + nt + " tegels");
  for (let i = 0; i < Math.min(12, nt); i++) {
    if (nsw) await sw.nth(i % nsw).click({ force: true }).catch(() => {});
    await tiles.nth((i * 7) % nt).click({ force: true }).catch(() => {});
    await hold(page, 0.35);
  }
  await hold(page, 1.4);

  // 6) (optioneel) vorm/maat even wisselen voor variatie
  for (const sel of ["#mShape", "#mPlateSize"]) { const ctl = page.locator(sel + " button, " + sel + " > *"); const n = await ctl.count().catch(() => 0); if (n > 1) { await ctl.nth(1).click({ force: true }).catch(() => {}); await hold(page, 0.9); } }
  await hold(page, 1.6);

  await browser.close();

  // frames -> mp4
  log("frames: " + frame + " -> mp4");
  await new Promise((res, rej) => {
    const args = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%05d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", `scale=${W}:${H}`, path.join(OUT, "site-walkthrough.mp4")];
    const pr = spawn(ffmpegBin, args, { stdio: "ignore" });
    pr.on("error", rej); pr.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg " + c))));
  });
  console.log("KLAAR -> " + path.join(OUT, "site-walkthrough.mp4"));
})().catch((e) => { console.error("FOUT:", e.message); process.exit(1); });
