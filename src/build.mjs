// Orchestrator fase 1: ontwerpen -> echte SVG -> Remotion-render -> out/<slug>.mp4
//
// Gebruik:
//   node src/build.mjs                       (alles, live API + live site)
//   node src/build.mjs --file=fixtures/showcase-designs.json
//   node src/build.mjs --only=sc4ad5...      (1 ontwerp op id)
//   node src/build.mjs --limit=3             (eerste N)
//   node src/build.mjs --aspect=1:1          (9:16 default | 1:1 | 16:9)
//   node src/build.mjs --mode=sweep-x        (radial default | sweep-x | sweep-y | diagonal | random)
//
// Let op: dit vereist een werkende Chromium voor Playwright (extractie) en voor
// Remotion (render). Eenmalig: `npx playwright install chromium`.

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { config, defaultCaptions } from "../config.mjs";
import { fetchDesigns } from "./fetch-designs.mjs";
import { createExtractor } from "./extract-svg.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const ASPECTS = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

function parseArgs(argv) {
  const a = {};
  for (const s of argv.slice(2)) {
    const m = s.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) a[m[1]] = m[2] ?? true;
  }
  return a;
}

const slugify = (s) =>
  (s || "ontwerp")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "ontwerp";

// Codeer een ontwerp als de serverloze deel-code (zelfde formaat als de site).
export function encodeDesign(d) {
  const b64 = Buffer.from(JSON.stringify(d), "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Laad de film-engine (remotion/film.ts) voor het film-storyboard.
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";
async function loadFilm() {
  const out = path.resolve(ROOT, "out/.filmlib.mjs");
  await esbuild.build({ entryPoints: [path.resolve(ROOT, "remotion/film.ts")], bundle: true, format: "esm", platform: "node", logLevel: "silent", outfile: out });
  return import(pathToFileURL(out).href + "?t=" + Date.now());
}

const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml", gif: "image/gif" };

// Haal het logo op (URL of lokaal pad) en geef het terug als data-URI, zodat het
// RECHTSTREEKS in de video wordt gebakken (geen static-server nodig -> kan nooit
// 404'en). Jouw laptop kan bij taleoftiles.com.
async function prepareLogo() {
  const src = config.logoUrl || "";
  const toDataUri = (buf, ext) => {
    const mime = MIME[(ext || "png").toLowerCase()] || "image/png";
    return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
  };
  if (!src) {
    try {
      const a = path.resolve(ROOT, "assets");
      const f = (await fs.readdir(a)).find((x) => /^logo\.(png|jpg|jpeg|webp|svg|gif)$/i.test(x));
      if (f) return toDataUri(await fs.readFile(path.join(a, f)), f.split(".").pop());
    } catch {}
    return "";
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`logo ${res.status}`);
      const ext = (src.split(".").pop() || "png").split(/[?#]/)[0];
      return toDataUri(await res.arrayBuffer(), ext);
    } catch (e) {
      console.log(`  (logo niet opgehaald: ${e.message} — ga door zonder logo)`);
      return "";
    }
  }
  try {
    return toDataUri(await fs.readFile(path.resolve(ROOT, src)), src.split(".").pop());
  } catch {
    return "";
  }
}

async function pickAudio() {
  const dir = path.resolve(ROOT, config.audioDir);
  try {
    const files = (await fs.readdir(dir)).filter((f) =>
      /\.(mp3|m4a|wav|aac|ogg)$/i.test(f)
    );
    if (!files.length) return "";
    const chosen = files[0]; // simpel: eerste track. Later: per recept kiezen.
    const pub = path.resolve(ROOT, "remotion/public");
    await fs.mkdir(pub, { recursive: true });
    await fs.copyFile(path.join(dir, chosen), path.join(pub, chosen));
    return chosen;
  } catch {
    return "";
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const aspect = ASPECTS[args.aspect] || config.aspect;
  const mode = args.mode || config.revealMode;

  console.log("• Ontwerpen ophalen...");
  let designs = await fetchDesigns({ file: args.file });
  if (args.only) designs = designs.filter((d) => d.id === args.only);
  if (args.limit) designs = designs.slice(0, Number(args.limit));
  if (!designs.length) {
    console.error("Geen ontwerpen gevonden.");
    process.exit(1);
  }
  console.log(`  ${designs.length} ontwerp(en).`);

  const audioSrc = await pickAudio();
  console.log(audioSrc ? `• Muziek: ${audioSrc}` : "• Muziek: (geen)");
  const logoSrc = await prepareLogo();
  console.log(logoSrc ? `• Logo: ingebakken (${Math.round(logoSrc.length / 1024)} KB)` : "• Logo: (geen)");

  const outDir = path.resolve(ROOT, config.outDir);
  await fs.mkdir(outDir, { recursive: true });

  console.log("• Remotion bundelen...");
  const publicDir = path.resolve(ROOT, "remotion/public");
  await fs.mkdir(publicDir, { recursive: true });
  const serveUrl = await bundle({
    entryPoint: path.resolve(ROOT, "remotion/index.ts"),
    publicDir,
    onProgress: () => {},
  });

  const template = args.template || "build"; // build | film
  const film = template === "film" ? await loadFilm() : null;
  console.log(`• Template: ${template}`);

  console.log("• Configurator headless starten...");
  const extractor = await createExtractor({ verbose: !!args.verbose });

  try {
    for (const item of designs) {
      const name = item.name || item.design?.name || "";
      const d = item.design || {};
      const slug = slugify(name) + "-" + String(item.id).slice(-6);
      process.stdout.write(`  ↳ ${name || item.id} ... `);

      const svg = await extractor.extract(d);

      let compId, inputProps;
      if (template === "film") {
        compId = "TileFilm";
        inputProps = {
          svg,
          storyboard: film.defaultStoryboard(),
          brand: config.brand,
          site: config.site,
          audioSrc,
          logoSrc,
          colBg: config.brandColors.bg,
          colBg2: config.brandColors.bg2,
          colGold: config.brandColors.gold,
          colCream: config.brandColors.cream,
          _fps: config.fps,
          _width: aspect.w,
          _height: aspect.h,
        };
      } else {
        compId = "TileBuild";
        inputProps = {
          svg, name, captions: defaultCaptions(name),
          brand: config.brand, site: config.site, audioSrc,
          revealMode: mode, revealStartSec: config.revealStartSec, revealEndSec: config.revealEndSec,
          popDurSec: config.popDurSec, tileSelector: config.tileSelector,
          namefont: d.namefont || "serif", ink: d.ink || "gold",
          textScale: Number(d.textScale) || 1, plateScale: Number(d.plateScale) || 1,
          theme: config.theme, colBg: config.brandColors.bg, colBg2: config.brandColors.bg2,
          colGold: config.brandColors.gold, colCream: config.brandColors.cream, colInkOnPlate: config.brandColors.inkOnPlate,
          logoSrc, _fps: config.fps, _width: aspect.w, _height: aspect.h, _durationSec: config.durationSec,
        };
      }

      const composition = await selectComposition({ serveUrl, id: compId, inputProps, publicDir });
      const outputLocation = path.join(outDir, `${slug}.mp4`);
      await renderMedia({ composition, serveUrl, codec: "h264", inputProps, outputLocation, publicDir });

      // Kaartje per video: het exacte ontwerp + de deel-code, zodat je 'm later
      // als showcase kunt opslaan zonder natekenen. (save-showcase gebruikt dit.)
      const code = encodeDesign(d);
      await fs.writeFile(path.join(outDir, `${slug}.design.json`),
        JSON.stringify({ name, design: d, code, shareUrl: `${config.site.replace(/\/$/, "")}/#studio?d=${code}` }, null, 2));

      console.log(`klaar -> out/${slug}.mp4 (+ .design.json)`);
    }
  } finally {
    await extractor.close();
  }

  console.log("✓ Alles gerenderd naar", config.outDir);
}

main().catch((e) => {
  console.error("\n✗ Fout:", e.message);
  process.exit(1);
});
