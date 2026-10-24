// Worker: doet alleen het zware werk — een SVG-string rasteren naar een PNG-bestand.
// De hoofdthread bouwt de frames (goedkoop) en verdeelt het rasteren (duur) over alle cores.
import { parentPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Eigen (premium) fonts meeladen zodat teksten niet op de logge systeem-serif vallen.
// assets/fonts/*.ttf — pad t.o.v. dit bestand, dus werkt ongeacht de werkmap/OS.
let FONT_FILES = [];
try {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");
  FONT_FILES = readdirSync(dir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)).map((f) => path.join(dir, f));
} catch { FONT_FILES = []; }

// SNELHEID: loadSystemFonts liet resvg bij ELK frame (1000+ per video) de hele Windows-
// fontmap doorzoeken — puur verspilde tijd, want de fonts wisselen nooit tussen frames.
// Onze eigen fonts (fontFiles hierboven) dekken alle merk-tekst; generieke namen in de SVG
// ("DejaVu Serif, serif") levert resvg zelf. Daarom systeem-fonts UIT -> fors sneller,
// over ALLE video-types. Lijken letters ooit verkeerd: zet loadSystemFonts terug op true.
const FONT_OPT = { loadSystemFonts: false, fontFiles: FONT_FILES };

parentPort.on("message", (m) => {
  try {
    const png = new Resvg(m.svg, {
      fitTo: { mode: "width", value: m.width },
      font: FONT_OPT,
    }).render().asPng();
    writeFileSync(m.out, png);
    parentPort.postMessage({ frame: m.frame });
  } catch (e) {
    parentPort.postMessage({ frame: m.frame, err: String((e && e.message) || e) });
  }
});
