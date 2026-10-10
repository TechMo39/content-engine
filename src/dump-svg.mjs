// Diagnose: haalt de ECHTE mozaiek-SVG van het eerste ontwerp op en schrijft 'm
// naar out/dump.svg, met een korte samenvatting van de structuur.
// Gebruik:  node src/dump-svg.mjs            (eerste ontwerp)
//           node src/dump-svg.mjs --only=<id>
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDesigns } from "./fetch-designs.mjs";
import { createExtractor } from "./extract-svg.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1];

const designs = await fetchDesigns({});
const item = only ? designs.find((d) => d.id === only) : designs[0];
if (!item) {
  console.error("Geen ontwerp gevonden.");
  process.exit(1);
}
console.log("Ontwerp:", item.name || item.id);

const ex = await createExtractor({ verbose: true });
const svg = await ex.extract(item.design);
await ex.close();

await fs.mkdir(path.resolve(ROOT, "out"), { recursive: true });
const outPath = path.resolve(ROOT, "out/dump.svg");
await fs.writeFile(outPath, svg, "utf8");

// Snelle structuur-telling
const count = (re) => (svg.match(re) || []).length;
const vb = (svg.match(/viewBox\s*=\s*"([^"]*)"/i) || [])[1] || "(geen)";
console.log("\n--- structuur ---");
console.log("lengte       :", svg.length, "tekens");
console.log("viewBox      :", vb);
console.log("<path>       :", count(/<path\b/gi));
console.log("<polygon>    :", count(/<polygon\b/gi));
console.log("<rect>       :", count(/<rect\b/gi));
console.log("<use>        :", count(/<use\b/gi));
console.log("<g>          :", count(/<g\b/gi));
console.log("transform=   :", count(/transform\s*=/gi));
console.log("clipPath     :", count(/clipPath/gi));
console.log("<image>      :", count(/<image\b/gi));
console.log("fill=        :", count(/fill\s*=/gi));
console.log("class=       :", count(/class\s*=/gi));
console.log("\nGeschreven naar out/dump.svg — stuur dat bestand.");
