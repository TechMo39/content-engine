// Worker: doet alleen het zware werk — een SVG-string rasteren naar een PNG-bestand.
// De hoofdthread bouwt de frames (goedkoop) en verdeelt het rasteren (duur) over alle cores.
import { parentPort } from "node:worker_threads";
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

parentPort.on("message", (m) => {
  try {
    const png = new Resvg(m.svg, { fitTo: { mode: "width", value: m.width }, font: { loadSystemFonts: true } }).render().asPng();
    writeFileSync(m.out, png);
    parentPort.postMessage({ frame: m.frame });
  } catch (e) {
    parentPort.postMessage({ frame: m.frame, err: String((e && e.message) || e) });
  }
});
