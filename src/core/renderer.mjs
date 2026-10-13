// KERN — merk-agnostisch. Weet niks van tegels of welk merk dan ook.
// Twee taken: (1) frames -> mp4 (resvg + gebundelde ffmpeg), (2) de "chrome"
// rond een video samenstellen (achtergrond, logo, paneel, footer).
// Een merk-module levert een sceneAt(frame) -> SVG; de kern rendert dat.
import { Resvg } from "@resvg/resvg-js";
import ffmpegStatic from "ffmpeg-static";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";

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

// Lokaal beeldbestand (jpg/png/webp) als data-URI inladen zodat resvg het kan
// tekenen. Voor foto's die als INPUT in de video komen (sfeerbeeld/bookend/badge).
const _imgCache = new Map();
export async function loadImageFile(absPath) {
  if (!absPath || !existsSync(absPath)) return "";
  if (_imgCache.has(absPath)) return _imgCache.get(absPath);
  let uri = "";
  try {
    const buf = await fs.readFile(absPath);
    const ext = (absPath.split(".").pop() || "png").toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext;
    uri = `data:image/${mime};base64,` + buf.toString("base64");
  } catch {}
  _imgCache.set(absPath, uri); return uri;
}

// Haal de LEVENDIGE hoofdkleuren uit een foto (voor kleur-match met het sfeerbeeld).
// Schaalt het beeld klein met ffmpeg, leest de pixels, negeert grijs/bruin/muur en
// bundelt op tint. Geeft ~n hex-kleuren terug (meest voorkomend + verzadigd eerst).
export function imagePalette(absPath, n = 7) {
  return new Promise((resolve) => {
    if (!absPath || !existsSync(absPath)) { resolve([]); return; }
    const args = ["-v", "error", "-i", absPath, "-vf", "scale=40:40:flags=area", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
    execFile(FFMPEG, args, { encoding: "buffer", maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout || !stdout.length) { resolve([]); return; }
      const px = stdout, bins = new Map();
      for (let i = 0; i + 2 < px.length; i += 3) {
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        const s = mx ? d / mx : 0, v = mx;
        if (s < 0.22 || v < 0.16 || v > 0.97) continue;   // grijs/muur/te donker/uitgeblazen overslaan
        let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; }
        h = ((h * 60) + 360) % 360;
        const key = Math.round(h / 15) % 24, w = s * v;   // 24 tint-bakken, gewogen op verzadiging×helderheid
        const e = bins.get(key) || { w: 0, r: 0, g: 0, b: 0 }; e.w += w; e.r += px[i] * w; e.g += px[i + 1] * w; e.b += px[i + 2] * w; bins.set(key, e);
      }
      const arr = [...bins.values()].sort((a, b) => b.w - a.w).slice(0, n);
      const toHex = (e) => { const r = Math.round(e.r / e.w), g = Math.round(e.g / e.w), b = Math.round(e.b / e.w); return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1); };
      resolve(arr.map(toHex));
    });
  });
}

// Lees een mockup-foto als klein RGB-raster (gw x gh), op dezelfde manier bijgesneden
// als hij in beeld komt (cover/slice naar 9:16). Geeft een Buffer (rgb24) of null.
// Hiermee bepaalt de engine AUTOMATISCH waar op de muur het paneel komt — geen handwerk.
export function imageGridRGB(absPath, gw, gh) {
  return new Promise((resolve) => {
    if (!absPath || !existsSync(absPath)) { resolve(null); return; }
    const args = ["-v", "error", "-i", absPath, "-vf",
      `scale=${gw}:${gh}:force_original_aspect_ratio=increase,crop=${gw}:${gh}`,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
    execFile(FFMPEG, args, { encoding: "buffer", maxBuffer: 1 << 22 }, (err, stdout) => {
      if (err || !stdout || stdout.length < gw * gh * 3) { resolve(null); return; }
      resolve(stdout);
    });
  });
}

// --- kleurhulp (HSL) voor het opbouwen van een familie-palet rond de foto-kleuren ---
function _rgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _toHsl(hex) { let [r, g, b] = _rgb(hex).map((x) => x / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; } h = ((h * 60) + 360) % 360; const l = (mx + mn) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); return { h, s, l }; }
function _toHex({ h, s, l }) { s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l)); const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2; let r = 0, g = 0, b = 0; const k = Math.floor(h / 60) % 6; if (k === 0) [r, g, b] = [c, x, 0]; else if (k === 1) [r, g, b] = [x, c, 0]; else if (k === 2) [r, g, b] = [0, c, x]; else if (k === 3) [r, g, b] = [0, x, c]; else if (k === 4) [r, g, b] = [x, 0, c]; else[r, g, b] = [c, 0, x]; const R = Math.round((r + m) * 255), G = Math.round((g + m) * 255), B = Math.round((b + m) * 255); return "#" + ((1 << 24) + (R << 16) + (G << 8) + B).toString(16).slice(1); }

// Bouw een vol, levendig flow-palet rond de foto-hoofdkleuren: per kleur wat
// analoge tinten + licht/donker varianten, met een verzadigings-boost zodat het
// niet melkig wordt. Weinig kleuren in de foto -> familie rond die ene tint.
export function enrichPalette(cols, target = 8) {
  const base = (cols || []).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
  if (!base.length) return [];
  const H = base.map(_toHsl);
  const out = [];
  for (const b of H) {
    const s = Math.min(1, Math.max(0.45, b.s * 1.18)), l = Math.min(0.62, Math.max(0.4, b.l));
    out.push({ h: b.h, s, l });
    out.push({ h: (b.h + 20) % 360, s: s * 0.95, l: Math.min(0.72, l + 0.12) });
    out.push({ h: (b.h + 340) % 360, s, l: Math.max(0.28, l - 0.14) });
    out.push({ h: b.h, s: Math.min(1, s * 1.08), l: Math.max(0.24, l - 0.22) });
    out.push({ h: b.h, s: s * 0.85, l: Math.min(0.8, l + 0.24) });
  }
  const hex = []; for (const c of out) { const h = _toHex(c); if (!hex.includes(h)) hex.push(h); }
  return hex.slice(0, Math.max(5, target));
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

// Bouw een zachte "tegel-klik" geluidslaag (ASMR): een korte, houten tik op elk
// opgegeven moment. Schrijft een mono 16-bit WAV van durSec seconden.
async function writeClickWav(clicks, durSec, outPath) {
  const sr = 44100, n = Math.ceil(durSec * sr), data = new Float32Array(n);
  let seed = 777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (const ct of clicks) {
    const i0 = Math.floor(ct * sr), len = Math.floor(0.018 * sr);
    const amp = 0.20 + rnd() * 0.08, freq = 1200 + rnd() * 600;
    for (let k = 0; k < len && i0 + k < n && i0 + k >= 0; k++) {
      const tt = k / sr, env = Math.exp(-tt * 150);
      let s = Math.sin(2 * Math.PI * freq * tt) * env;
      if (k < 0.003 * sr) s += (rnd() * 2 - 1) * Math.exp(-tt * 700) * 0.5;   // korte aanslag-transiënt
      data[i0 + k] += s * amp;
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, data[i])); buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2); }
  await fs.writeFile(outPath, buf);
}

// Render een reeks frames (sceneAt(frame)->svg) naar een mp4. Supersampling SS voor scherpte.
// Rasteren (het dure werk) wordt over alle cores verdeeld; de hoofdthread bouwt de SVG's.
// render = { W, H, FPS, SS, durSec, sceneAt }  music = absoluut pad of ""
export async function renderToMp4({ render, music = "", outDir, log = () => {}, namePrefix = "video", workers = 0 }) {
  const { W, H, FPS, SS = 2, durSec, sceneAt } = render;
  await fs.mkdir(outDir, { recursive: true });
  const tmp = path.resolve(outDir, ".frames-" + Date.now());
  await fs.mkdir(tmp, { recursive: true });
  const total = Math.round(durSec * FPS);
  const nWorkers = Math.max(1, workers || Math.max(1, (os.cpus().length || 2) - 1));
  log(`frames renderen: ${total} (${W * SS}x${H * SS} @${FPS}) — ${nWorkers} core(s)`);
  const wp = new URL("./raster-worker.mjs", import.meta.url);
  const pool = Array.from({ length: nWorkers }, () => new Worker(wp));
  try {
    await new Promise((resolve, reject) => {
      if (total === 0) { resolve(); return; }
      let next = 0, done = 0, failed = false;
      const assign = (w) => {
        if (next >= total) return;
        const f = next++;
        let svg; try { svg = sceneAt(f); } catch (e) { failed = true; reject(e); return; }
        w.postMessage({ svg, out: path.join(tmp, `f${String(f).padStart(5, "0")}.png`), width: W * SS, frame: f });
      };
      for (const w of pool) {
        w.on("message", (m) => {
          if (failed) return;
          if (m.err) { failed = true; reject(new Error("rasterfout frame " + m.frame + ": " + m.err)); return; }
          done++;
          if (done % 48 === 0 || done === total) log(`  frame ${done}/${total}`);
          if (next < total) assign(w); else if (done === total) resolve();
        });
        w.on("error", (e) => { if (!failed) { failed = true; reject(e); } });
      }
      for (const w of pool) assign(w);
    });
  } finally {
    for (const w of pool) w.terminate();
  }
  const outName = `${namePrefix}-${Date.now()}.mp4`;
  const outPath = path.resolve(outDir, outName);
  // tegel-klik-laag (ASMR) opbouwen als er klik-momenten zijn
  const clicks = render.clicks || [];
  let clickWav = "";
  if (clicks.length) { clickWav = path.join(tmp, "clicks.wav"); await writeClickWav(clicks, durSec, clickWav); }
  const hasMusic = music && existsSync(music), hasClicks = !!clickWav;
  const fa = ["-y", "-framerate", String(FPS), "-i", path.join(tmp, "f%05d.png")];
  let ai = 1, mi = -1, ci = -1;
  if (hasMusic) { fa.push("-i", music); mi = ai++; }
  if (hasClicks) { fa.push("-i", clickWav); ci = ai++; }
  fa.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (mi >= 0 && ci >= 0) fa.push("-filter_complex", `[${mi}:a]volume=0.75[m];[${ci}:a]volume=1.0[c];[m][c]amix=inputs=2:duration=longest:normalize=0[a]`, "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-shortest");
  else if (mi >= 0) fa.push("-map", "0:v", "-map", `${mi}:a`, "-c:a", "aac", "-shortest");
  else if (ci >= 0) fa.push("-map", "0:v", "-map", `${ci}:a`, "-c:a", "aac", "-shortest");
  fa.push(outPath);
  log(`ffmpeg: frames -> mp4${hasMusic ? " + muziek" : ""}${hasClicks ? " + tegel-klik" : ""}`);
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
