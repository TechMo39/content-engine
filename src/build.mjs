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

  const outDir = path.resolve(ROOT, config.outDir);
  await fs.mkdir(outDir, { recursive: true });

  console.log("• Remotion bundelen...");
  const serveUrl = await bundle({
    entryPoint: path.resolve(ROOT, "remotion/index.ts"),
    onProgress: () => {},
  });

  console.log("• Configurator headless starten...");
  const extractor = await createExtractor({ verbose: !!args.verbose });

  try {
    for (const item of designs) {
      const name = item.name || item.design?.name || "";
      const d = item.design || {};
      const slug = slugify(name) + "-" + String(item.id).slice(-6);
      process.stdout.write(`  ↳ ${name || item.id} ... `);

      const svg = await extractor.extract(d);

      const inputProps = {
        svg,
        name,
        captions: defaultCaptions(name),
        brand: config.brand,
        site: config.site,
        audioSrc,
        revealMode: mode,
        revealStartSec: config.revealStartSec,
        revealEndSec: config.revealEndSec,
        popDurSec: config.popDurSec,
        tileSelector: config.tileSelector,
        // naamplaat-velden uit het ontwerp
        namefont: d.namefont || "serif",
        ink: d.ink || "gold",
        textScale: Number(d.textScale) || 1,
        plateScale: Number(d.plateScale) || 1,
        _fps: config.fps,
        _width: aspect.w,
        _height: aspect.h,
        _durationSec: config.durationSec,
      };

      const composition = await selectComposition({
        serveUrl,
        id: "TileBuild",
        inputProps,
      });

      const outputLocation = path.join(outDir, `${slug}.mp4`);
      await renderMedia({
        composition,
        serveUrl,
        codec: "h264",
        inputProps,
        outputLocation,
      });
      console.log(`klaar -> out/${slug}.mp4`);
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
