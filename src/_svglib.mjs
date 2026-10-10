// Compileert remotion/svg.ts naar ESM en importeert het, zodat de Node-side
// test/preview exact dezelfde reveal-logica gebruikt als Remotion.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");

export async function loadSvgLib() {
  const outfile = path.resolve(ROOT, "out/.svglib.mjs");
  await esbuild.build({
    entryPoints: [path.resolve(ROOT, "remotion/svg.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    outfile,
  });
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}
