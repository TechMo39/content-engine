// Trekt de ECHTE mozaiek-SVG uit de configurator. We laden de site headless,
// passen per ontwerp mApplyFullDesign(design) toe en lezen #mSvgStage uit.
// Zo is het beeld pixel-getrouw: zelfde tiling, kleuren en voeg als op de site,
// en het blijft automatisch in sync als de site verandert.
import { chromium } from "playwright";
import { config } from "../config.mjs";

export async function createExtractor({ verbose = false } = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1100 },
    deviceScaleFactor: 1,
  });
  if (verbose) page.on("pageerror", (e) => console.warn("  [page error]", e.message));

  await page.goto(config.pageUrl, { waitUntil: "networkidle", timeout: 60000 });

  // Wacht tot de apply-functie bestaat (configurator geboot).
  await page.waitForFunction(
    (fn) => typeof window[fn] === "function",
    config.applyFn,
    { timeout: 45000 }
  ).catch(() => {
    throw new Error(
      `window.${config.applyFn} niet gevonden op ${config.pageUrl}. ` +
        `Klopt applyFn/stageSelector in config.mjs? (aangeleverd door de website-chat)`
    );
  });

  async function extract(design) {
    await page.evaluate(
      ({ fn, d }) => {
        // kan sync of een promise teruggeven
        return Promise.resolve(window[fn](d));
      },
      { fn: config.applyFn, d: design }
    );
    await page.waitForSelector(config.readyProbe, { timeout: 20000 });
    await page.waitForTimeout(450); // even laten settelen (async tekenwerk)

    const svg = await page.$eval(config.stageSelector, (el) => {
      const s =
        el.tagName.toLowerCase() === "svg" ? el : el.querySelector("svg");
      return s ? s.outerHTML : el.innerHTML;
    });
    if (!svg || !/<svg/i.test(svg))
      throw new Error("Geen <svg> uit #mSvgStage gekregen.");
    return svg;
  }

  async function close() {
    await browser.close();
  }

  return { extract, close };
}
