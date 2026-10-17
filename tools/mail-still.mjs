// Tale of Tiles — MAIL-STILL EXPORT.
// Maakt per naam/bedrijf ÉÉN mail-geoptimaliseerde afbeelding: het tegelbord mét díe naam,
// op een muur-mockup, met logo + slogan + taleoftiles.com. Bedoeld voor de outreach-sequence:
// die leest de bedrijfsnaam uit de lead -> roept dit aan -> krijgt een lichte JPG terug die
// persoonlijk én spamfilter-vriendelijk is (geen video, één gehoste afbeelding).
//
// GEEN nieuwe dependency: rasteren met resvg (al aanwezig), comprimeren met ffmpeg-static.
//
// Gebruik (één naam):
//   node tools/mail-still.mjs "Café De Kaai"
// Batch (CSV met een kolom bedrijfsnaam):
//   node tools/mail-still.mjs --csv leads.csv --col bedrijf
// Opties:
//   --out <map>       uitvoermap            (standaard: out/mail-stills)
//   --format 1:1|16:9|9:16                  (standaard: 1:1 — beste in de inbox)
//   --width <px>      breedte van de JPG    (standaard: 600 — standaard mailbreedte)
//   --lang nl|en      taal van de slogan    (standaard: nl)
//   --palette auto|warm|cool                (standaard: auto)
//   --quality <2-6>   ffmpeg -q:v, lager=scherper/groter (standaard: 4)
// Resultaat: <out>/<slug>.jpg per naam + <out>/manifest.json (naam -> bestand), zodat de
// sequence elke lead aan z'n afbeelding kan koppelen.

import { Resvg } from "@resvg/resvg-js";
import ffmpegPath from "ffmpeg-static";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---- argumenten ----
const argv = process.argv.slice(2);
const opt = (flag, def) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const names = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const csv = opt("--csv", "");
const col = opt("--col", "");
const outDir = path.resolve(ROOT, opt("--out", path.join("out", "mail-stills")));
const format = ["1:1", "16:9", "9:16"].includes(opt("--format", "1:1")) ? opt("--format", "1:1") : "1:1";
const width = Math.max(200, Math.min(1200, Number(opt("--width", "600")) || 600));
const lang = opt("--lang", "nl") === "en" ? "en" : "nl";
const palette = ["auto", "warm", "cool"].includes(opt("--palette", "auto")) ? opt("--palette", "auto") : "auto";
const quality = Math.max(2, Math.min(8, Number(opt("--quality", "4")) || 4));

// ---- namenlijst samenstellen (los of uit CSV) ----
function readCsvNames(file, column) {
  const txt = fs.readFileSync(file, "utf8").replace(/\r/g, "");
  const rows = txt.split("\n").filter((l) => l.trim().length);
  if (!rows.length) return [];
  const split = (l) => l.split(l.includes(";") && !l.includes(",") ? ";" : ","); // ; of , als scheidingsteken
  const header = split(rows[0]).map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  let ci = column ? header.indexOf(column.toLowerCase()) : 0;
  if (ci < 0) { console.error(`kolom "${column}" niet gevonden. Beschikbaar: ${header.join(", ")}`); process.exit(1); }
  return rows.slice(1).map((l) => (split(l)[ci] || "").trim().replace(/^"|"$/g, "")).filter(Boolean);
}
let LIST = names.slice();
if (csv) { try { LIST = readCsvNames(path.resolve(csv), col); } catch (e) { console.error("CSV lezen faalde: " + e.message); process.exit(1); } }
if (!LIST.length) { console.error('Geef een naam op, bv.  node tools/mail-still.mjs "Café De Kaai"   (of --csv leads.csv --col bedrijf)'); process.exit(1); }

const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "naam";

// ---- brand + fonts klaarzetten ----
const { makeBrand } = await import(pathToFileURL(path.join(ROOT, "src/brands/taleoftiles.mjs")).href);
const { config } = await import(pathToFileURL(path.join(ROOT, "config.mjs")).href);
const fontsDir = path.join(ROOT, "assets/fonts");
const FONTS = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => path.join(fontsDir, f)) : [];

const brand = makeBrand({ ROOT, config: { ...config, outDir: path.resolve(ROOT, config.outDir || "out"), audioDir: path.resolve(ROOT, config.audioDir || "assets/audio") } });
await brand.init(() => {});
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tot-still-"));

function compress(pngBuf, outFile) {
  const inPng = path.join(tmp, "f.png"); fs.writeFileSync(inPng, pngBuf);
  const r = spawnSync(ffmpegPath, ["-y", "-v", "error", "-i", inPng, "-vf", `scale=${width}:-1:flags=lanczos`, "-q:v", String(quality), outFile], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg-compressie faalde");
}

const manifest = [];
let ok = 0;
for (const name of LIST) {
  try {
    // hook:"none" -> geen verhaal-caption in het beeld; de mailtekst draagt de boodschap.
    const r = await brand.makeRender({ templateId: "insitu", opts: { name, lang, palette, hook: "none" }, format, log: () => {} });
    r.SS = 1;
    const { W, H, FPS, durSec, sceneAt } = r;
    const svg = sceneAt(Math.round(durSec * 0.93 * FPS));   // eindbeeld: paneel vol + naam zichtbaar
    const png = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: true, fontFiles: FONTS } }).render().asPng();
    const file = path.join(outDir, slug(name) + ".jpg");
    compress(png, file);
    const kb = Math.round(fs.statSync(file).size / 1024);
    manifest.push({ name, file: path.relative(ROOT, file).replace(/\\/g, "/"), kb });
    console.log(`✓ ${name}  ->  ${path.relative(ROOT, file)}  (${kb}KB)`);
    ok++;
  } catch (e) {
    console.error(`✗ ${name}  —  ${e.message}`);
    manifest.push({ name, file: null, error: e.message });
  }
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\nKLAAR — ${ok}/${LIST.length} afbeeldingen in ${path.relative(ROOT, outDir)}  (+ manifest.json)`);
