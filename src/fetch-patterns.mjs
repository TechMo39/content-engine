// Eenmalig: haal alle patroon-SVG's + de tile-locks van de site naar assets/.
// Draai op je laptop (die bij taleoftiles.com kan):  node src/fetch-patterns.mjs
import fs from "node:fs/promises"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const SITE = (/^https?:\/\//.test(config.site) ? config.site : "https://" + config.site).replace(/\/$/, "");
await fs.mkdir(path.resolve(ROOT, "assets/patterns"), { recursive: true });
const ids = JSON.parse(await fs.readFile(path.resolve(ROOT, "fixtures/patterns.json"), "utf8")).patterns;
process.stdout.write("tile-locks... ");
try { const r = await fetch(SITE + "/api/tile-locks"); await fs.writeFile(path.resolve(ROOT, "assets/tile-locks.json"), await r.text()); console.log("ok"); }
catch (e) { console.log("mislukt:", e.message); }
let ok = 0;
for (const id of ids) {
  try { const r = await fetch(`${SITE}/img/patterns/${id}.svg`); if (r.ok) { await fs.writeFile(path.resolve(ROOT, "assets/patterns", id + ".svg"), await r.text()); ok++; process.stdout.write("."); } }
  catch {}
}
console.log(`\n${ok}/${ids.length} patronen opgehaald -> assets/patterns/`);
