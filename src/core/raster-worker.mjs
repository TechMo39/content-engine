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

parentPort.on("message", (m) => {
  try {
    const png = new Resvg(m.svg, {
      fitTo: { mode: "width", value: m.width },
      font: { loadSystemFonts: true, fontFiles: FONT_FILES },
    }).render().asPng();
    writeFileSync(m.out, png);
    parentPort.postMessage({ frame: m.frame });
  } catch (e) {
    parentPort.postMessage({ frame: m.frame, err: String((e && e.message) || e) });
  }
});
