// KERN — merk-agnostisch. Weet niks van tegels of welk merk dan ook.
// Twee taken: (1) frames -> mp4 (resvg + gebundelde ffmpeg), (2) de "chrome"
// rond een video samenstellen (achtergrond, logo, paneel, footer).
// Een merk-module levert een sceneAt(frame) -> SVG; de kern rendert dat.
import { Resvg } from "@resvg/resvg-js";
import ffmpegStatic from "ffmpeg-static";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const FFMPEG = ffmpegStatic || "ffmpeg";
export const FORMATS = { "9:16": [540, 960], "1:1": [720, 720], "16:9": [960, 540] };

export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// logo (http-url) eenmalig als data-URI ophalen zodat resvg het kan tekenen
const _logoCache = new Map();
export async function loadLogo(url) {
  if (!url || !/^https?:/.test(url)) return "";
  if (_logoCache.has(url)) return _logoCache.get(url);
  let uri = "";
  try {
    const r = await fetch(url);
    if (r.ok) { const ext = (url.split(".").pop() || "png").split(/[?#]/)[0]; uri = `data:image/${ext === "svg" ? "svg+xml" : ext};base64,` + Buffer.from(await r.arrayBuffer()).toString("base64"); }
  } catch {}
  _logoCache.set(url, uri); return uri;
}

// Een rechthoek met verhouding A inpassen in (Wmax x Hmax), zonder vervormen.
export function fitRect(Wmax, Hmax, A) {
  let w = Wmax, h = Math.round(w / A);
  if (h > Hmax) { h = Hmax; w = Math.round(h * A); }
  return { w, h };
}

// Merk-chrome: achtergrond-gloed, logo/merknaam boven, een paneel in het midden
// waar het merk z'n "veld" (inner) in zet, optioneel een plaat/overlay, footer onder.
// branding = { bg, bg2, gold, cream, name, footer, logoUri, panel:true/false }
export function composeChrome({ branding, W, H, panel, innerField, overlay = "", logoUri = "" }) {
  const b = branding;
  // merk-mark boven: merk levert eigen premium woordmerk (markSvg), anders logo-afbeelding, anders tekst
  const logoTag = b.markSvg ? b.markSvg({ W, H })
    : logoUri ? `<image href="${logoUri}" x="${W / 2 - 90}" y="${H * 0.05}" width="180" height="${H * 0.07}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${W / 2}" y="${H * 0.1}" text-anchor="middle" font-family="DejaVu Serif,serif" font-size="20" letter-spacing="4" fill="${b.gold}">${escapeXml((b.name || "").toUpperCase())}</text>`;
  const panelRect = panel
    ? `<rect x="${panel.x}" y="${panel.y}" width="${panel.w}" height="${panel.h}" rx="6" fill="${b.plate || "#eae4d7"}" stroke="${b.gold}" stroke-width="2"/>`
    : "";
  // footer: altijd duidelijk in beeld (subliminale merkherhaling) — goud, in een subtiele pill
  const fSize = Math.round(W * 0.034), fy = Math.round(H * 0.955), fw = fSize * (String(b.footer || "").length) * 0.64;
  const footer = b.footer
    ? `<g><rect x="${W / 2 - fw / 2 - 16}" y="${fy - fSize}" width="${fw + 32}" height="${fSize * 1.7}" rx="${fSize}" fill="#000000" opacity="0.22"/>`
      + `<text x="${W / 2}" y="${fy + fSize * 0.3}" text-anchor="middle" font-family="DejaVu Serif,serif" font-weight="700" font-size="${fSize}" letter-spacing="${fSize * 0.08}" fill="${b.gold}">${escapeXml(b.footer)}</text></g>`
    : "";
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs><radialGradient id="bg" cx="50%" cy="26%" r="90%"><stop offset="0%" stop-color="${b.bg2}"/><stop offset="70%" stop-color="${b.bg}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>${logoTag}
${panelRect}${innerField || ""}${overlay || ""}
${footer}</svg>`;
}

// Render een reeks frames (sceneAt(frame)->svg) naar een mp4. Supersampling SS voor scherpte.
// render = { W, H, FPS, SS, durSec, sceneAt }  music = absoluut pad of ""
export async function renderToMp4({ render, music = "", outDir, log = () => {}, namePrefix = "video" }) {
  const { W, H, FPS, SS = 2, durSec, sceneAt } = render;
  await fs.mkdir(outDir, { recursive: true });
  const tmp = path.resolve(outDir, ".frames-" + Date.now());
  await fs.mkdir(tmp, { recursive: true });
  const total = Math.round(durSec * FPS);
  log(`frames renderen: ${total} (${W}x${H} @${FPS}, ${SS}x)`);
  for (let f = 0; f < total; f++) {
    const r = new Resvg(sceneAt(f), { fitTo: { mode: "width", value: W * SS }, font: { loadSystemFonts: true } });
    await fs.writeFile(path.join(tmp, `f${String(f).padStart(4, "0")}.png`), r.render().asPng());
    if (f % 24 === 0 || f === total - 1) { log(`  frame ${f + 1}/${total}`); await new Promise((r2) => setImmediate(r2)); }
  }
  const outName = `${namePrefix}-${Date.now()}.mp4`;
  const outPath = path.resolve(outDir, outName);
  const fa = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%04d.png")];
  const hasMusic = music && existsSync(music);
  if (hasMusic) fa.push("-i", music, "-shortest");
  fa.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (hasMusic) fa.push("-c:a", "aac");
  fa.push(outPath);
  log(`ffmpeg: frames -> mp4${hasMusic ? " (+ muziek)" : ""}`);
  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, fa, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.on("error", (e) => reject(new Error("ffmpeg kon niet starten: " + e.message)));
    if (p.stderr) p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error("ffmpeg stopte met code " + c + (err ? " — " + err.trim().split("\n").pop() : "")))));
  });
  await fs.rm(tmp, { recursive: true, force: true });
  log("mp4 geschreven: " + outName);
  return { outName, outPath };
}
