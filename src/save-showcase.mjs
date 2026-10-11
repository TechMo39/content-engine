// Sla ÉÉN ontwerp op als showcase in je admin — alleen als jij dit aanroept.
// Gebruikt je admin-wachtwoord uit de omgeving (TOT_ADMIN_PW), nooit hardcoded.
// Zelfde endpoint als de builder: POST /api/showcase-save (Basic auth admin:pw).
//
// Gebruik:
//   node src/save-showcase.mjs --slug=makers-co-904c5b         (uit out/<slug>.design.json)
//   node src/save-showcase.mjs --file=pad/naar/design.json
//   node src/save-showcase.mjs --code=<deel-code> --name="Cafe Jax"
//
// Zet eerst je wachtwoord (niet in de chat, niet in git):
//   .env  ->  TOT_ADMIN_PW=jouwwachtwoord
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const m = s.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [s, true];
}));

// .env inladen (simpel), zodat TOT_ADMIN_PW beschikbaar is.
try {
  const env = await fs.readFile(path.resolve(ROOT, ".env"), "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PW = process.env.TOT_ADMIN_PW || "";
if (!PW) {
  console.error("✗ Geen admin-wachtwoord. Zet TOT_ADMIN_PW in .env (niet in de chat, niet in git).");
  process.exit(1);
}

const decodeCode = (code) => {
  let b = code.replace(/-/g, "+").replace(/_/g, "/"); b += "=".repeat((-b.length % 4 + 4) % 4);
  return JSON.parse(Buffer.from(b, "base64").toString("utf8"));
};

// Ontwerp + naam bepalen
let design, name = args.name || "";
if (args.code) design = decodeCode(args.code);
else {
  const file = args.file ? path.resolve(ROOT, args.file)
    : args.slug ? path.resolve(ROOT, config.outDir, `${args.slug}.design.json`) : null;
  if (!file || !existsSync(file)) { console.error("✗ Geef --slug, --file of --code. Bestand niet gevonden."); process.exit(1); }
  const j = JSON.parse(await fs.readFile(file, "utf8"));
  design = j.design || j; name = name || j.name || "";
}
if (!name) name = design.name || design.pattern || "Ontwerp";

const base = config.site.replace(/\/$/, "");
const auth = "Basic " + Buffer.from("admin:" + PW).toString("base64");

// Optioneel voorbeeld-plaatje: out/<slug>.preview.png -> /api/save-preview
let previewId = "";
if (args.slug) {
  const png = path.resolve(ROOT, config.outDir, `${args.slug}.preview.png`);
  if (existsSync(png)) {
    try {
      const b64 = "data:image/png;base64," + (await fs.readFile(png)).toString("base64");
      const r = await fetch(base + "/api/save-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ img: b64 }) });
      const j = await r.json(); previewId = (j && j.id) || "";
    } catch {}
  }
}

console.log(`• Opslaan als showcase: "${name}" (patroon ${design.pattern})`);
const res = await fetch(base + "/api/showcase-save", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: auth },
  body: JSON.stringify({ name, design, preview: previewId }),
});
if (res.status === 401) { console.error("✗ Wachtwoord fout (401)."); process.exit(1); }
const out = await res.json().catch(() => ({}));
if (out && out.ok) console.log(`✓ Opgeslagen als showcase. Staat nu in je admin + op de site.`);
else { console.error("✗ Mislukt:", JSON.stringify(out)); process.exit(1); }
