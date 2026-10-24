// Tale of Tiles — CONTENT-READY STAP (de "montage" om de ruwe walkthrough-opname heen).
// Wordt door de engine aangeroepen als onderdeel van het type; neemt de ruwe mp4 + markers
// en maakt er een post-klaar filmpje van: hook vooraan, snelheid geramd op de fasegrenzen,
// caption (ieder-z'n-smaak-lijn), logo, en muziek (track die de engine koos).
//
// Aanroep:  node tools/finish.mjs <ruwe.mp4>
// Env (de engine vult deze):
//   TOT_MARKERS   pad naar markers.json (standaard <ruwe>.markers.json of naast de mp4)
//   TOT_CAPTION   openingszin op de hook        (bv. "Everyone has their own taste.")
//   TOT_CAPTION2  eindregel                      (bv. "Design yours · Tale of Tiles")
//   TOT_MUSIC     absoluut pad naar audiotrack   (de engine kiest 'm via pickMusic)
//   TOT_LOGO      logo-png                        (standaard assets/brand/logo.png)
//   TOT_FONT      ttf                             (standaard assets/fonts/CormorantGaramond-600.ttf)
//   TOT_FINAL     uitvoerpad                      (standaard naast de ruwe: site-final.mp4)
//   TOT_SEED      getal voor lichte variatie per filmpje (anders willekeurig)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// drawtext-paden voor ffmpeg: op Windows breekt een pad met "C:\..." de filtergraph (de ":" is
// een scheidingsteken). Forward slashes + de dubbele punt escapen lost dat op.
const dt = (p) => String(p).replace(/\\/g, "/").replace(/:/g, "\\:");

const RAW = process.argv[2] || "./out/site-walkthrough.mp4";
const FF = process.env.FFMPEG || "ffmpeg";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // Windows-proof
const LOGO = process.env.TOT_LOGO || path.join(ROOT, "assets/brand/logo.png");
const FONT = process.env.TOT_FONT || path.join(ROOT, "assets/fonts/Fraunces-600.ttf");   // premium (was Cormorant)
// GUIDE-STAPPEN: korte begeleidende regels die de kijker door de site/configurator leiden
// (1 patroon -> 2 kleuren -> 3 naam -> 4 op je muur). JSON-array van strings via env.
let STEPS = [];
try { STEPS = JSON.parse(process.env.TOT_STEPS || "[]"); if (!Array.isArray(STEPS)) STEPS = []; } catch { STEPS = []; }
const CAP1 = process.env.TOT_CAPTION || "";
const CAP2 = process.env.TOT_CAPTION2 || "";
const MUSIC = process.env.TOT_MUSIC || "";
const FINAL = process.env.TOT_FINAL || path.join(path.dirname(RAW), "site-final.mp4");
const SEED = Number(process.env.TOT_SEED || Math.floor(Math.random() * 1e6));

const rnd = (() => { let s = SEED % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const jitter = (base, amt) => +(base + (rnd() * 2 - 1) * amt).toFixed(3);

function dur(file) {
  // duur uit ffmpeg zelf (geen ffprobe nodig; ffmpeg-static levert geen ffprobe)
  const r = spawnSync(FF, ["-hide_banner", "-i", file], { encoding: "utf8" });
  const mm = (r.stderr || "").match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return mm ? (+mm[1]) * 3600 + (+mm[2]) * 60 + parseFloat(mm[3]) : 0;
}
// ffmpeg ALTIJD met de tijdelijke map als werkmap draaien. Zo kunnen de font en de caption-
// tekstbestanden als KÁLE bestandsnamen in het drawtext-filter (geen "C:\..." -> geen dubbele
// punt die ffmpeg als optie-scheiding leest -> geen "Both text and text file provided"). In/uit-
// bestanden mogen wél absolute paden zijn: die gaan via -i / output-arg, niet door de filtergraph.
function ff(args) { const r = spawnSync(FF, ["-v", "error", "-y", ...args], { stdio: "inherit", cwd: tmp }); if (r.status !== 0) throw new Error("ffmpeg faalde: " + args.join(" ")); }

if (!fs.existsSync(RAW)) { console.error("ruwe opname niet gevonden: " + RAW); process.exit(1); }
const D = dur(RAW);

// markers lezen (met nette terugval op verhoudingen als ze ontbreken)
let m = {};
const mp = process.env.TOT_MARKERS || path.join(path.dirname(RAW), "site-walkthrough.markers.json");
try { m = JSON.parse(fs.readFileSync(mp, "utf8")); } catch {}
const colorStart = m.colorStart ?? D * 0.28;
const preview = m.preview ?? D * 0.62;
const scenes = m.scenes ?? D * 0.70;
const end = m.end ?? D;
// extra fase-markers (nieuw in de opname) met nette terugval als ze ontbreken
const patternStart = m.patternStart ?? (m.homepageEnd ?? D * 0.04);
const nameStart = m.nameStart ?? (colorStart + (preview - colorStart) * 0.72);

// pad zelf opbouwen (NIET de return van mkdirSync gebruiken: die geeft op Windows soms een
// extended-length pad "\\?\C:\..." terug, en dat breekt het drawtext-filter).
const tmp = path.join(os.tmpdir(), "tot-finish-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const seg = (name) => path.join(tmp, name);
const FPS = 30;

// Font naar de werkmap kopiëren en als kále naam "font.ttf" in de filters gebruiken (geen pad
// met dubbele punt). Lukt het kopiëren niet, dan laten we fontfile weg (ffmpeg pakt z'n default).
let FONTARG = "";
try { if (fs.existsSync(FONT)) { fs.copyFileSync(FONT, path.join(tmp, "font.ttf")); FONTARG = "fontfile=font.ttf:"; } } catch {}

// per-filmpje lichte variatie in de snelheid (binnen de grote lijn)
const spIntro = jitter(2.6, 0.4);   // homepage + naar de configurator: snel
const spBuild = jitter(1.0, 0.08);  // inkleuren + naam: de hero, rustig
const spFin = jitter(1.2, 0.12);    // voorbeeld + ruimtes: iets sneller

// 1) drie segmenten op snelheid zetten
ff(["-i", RAW, "-ss", "0", "-to", String(colorStart), "-filter:v", `setpts=PTS/${spIntro},fps=${FPS}`, "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", seg("A.mp4")]);
ff(["-i", RAW, "-ss", String(colorStart), "-to", String(preview), "-filter:v", `setpts=PTS/${spBuild},fps=${FPS}`, "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", seg("B.mp4")]);
ff(["-i", RAW, "-ss", String(preview), "-to", String(end), "-filter:v", `setpts=PTS/${spFin},fps=${FPS}`, "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", seg("C.mp4")]);

// 2) HOOK: ~1.5s payoff uit de scenes, met de openingscaption (payoff-first)
const hookStart = Math.min(end - 1.8, scenes + 1.0);
let hookVf = `setpts=PTS,fps=${FPS}`;
if (CAP1) {
  fs.writeFileSync(seg("cap1.txt"), CAP1);
  // zelfde sterke, leesbare stijl als de guide-stappen (witte contour + stevige donkere balk)
  hookVf += `,drawtext=${FONTARG}textfile=cap1.txt:fontsize=50:fontcolor=white:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.62:boxborderw=30:x=(w-text_w)/2:y=h*0.72`;
}
ff(["-i", RAW, "-ss", String(hookStart), "-t", "1.6", "-filter:v", hookVf, "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", seg("hook.mp4")]);

// 3) aan elkaar: hook + A + B + C
const list = seg("list.txt");
fs.writeFileSync(list, ["hook.mp4", "A.mp4", "B.mp4", "C.mp4"].map((f) => `file '${seg(f).replace(/\\/g, "/")}'`).join("\n") + "\n");
ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", seg("body.mp4")]);
const bodyDur = dur(seg("body.mp4"));

// 4) logo + eindcaption, en muziek erbij
const fc = [];
fc.push("[1]scale=210:-1[lg]");
fc.push("[0][lg]overlay=W-w-34:H-h-150:format=auto[v1]");
let vlab = "[v1]";
// GUIDE-STAPPEN GESYNCHRONISEERD MET HET BEELD: de oude code plakte de teksten op VASTE fracties
// (7/34/60/82%), los van wat er op dat moment scrollde -> tekst klopte niet met beeld (Mo's klacht).
// Nu koppelen we elke stap aan de ECHTE fase-marker uit de opname, omgerekend naar de body-tijdlijn
// (hook 1.6s vooraan + de 3 versnelde segmenten A/B/C). Zo staat "Kies je patroon" ook écht bij het
// patroon kiezen, "Kies je kleuren" bij het inkleuren, enz.
const HOOK_LEN = 1.6;
const aLen = colorStart / spIntro;                 // body-duur van segment A
const bLen = (preview - colorStart) / spBuild;     // body-duur van segment B
// zet een RUW tijdstip (seconden in de originele opname) om naar body-seconden
function rawToBody(raw) {
  if (raw <= colorStart) return HOOK_LEN + raw / spIntro;                       // in A
  if (raw <= preview)    return HOOK_LEN + aLen + (raw - colorStart) / spBuild; // in B
  return HOOK_LEN + aLen + bLen + Math.max(0, raw - preview) / spFin;           // in C
}
// GEMEENSCHAPPELIJKE, GOED LEESBARE caption-stijl: grotere tekst, stevige donkere balk met wat
// doorzicht (leest op de lichte site), dikke rand, en een dunne witte contourlijn om de letters
// (borderw) zodat ze nooit wegvallen. Vaste plek net onder het midden (botst niet met de site-koppen
// bovenin en niet met de prijs-balk onderin).
const capStyle = (txtfile, t0, t1) =>
  `drawtext=${FONTARG}textfile=${txtfile}:fontsize=52:fontcolor=white:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.60:boxborderw=28:x=(w-text_w)/2:y=h*0.72:enable='between(t,${t0},${t1})'`;
if (STEPS.length) {
  // elke stap z'n eigen fase-venster (ruw), omgerekend naar body-tijd; tekst staat van het begin
  // van de fase tot kort erna zichtbaar (niet de hele fase, anders blijft 'ie te lang hangen).
  const windows = [
    [patternStart, colorStart],   // 1 · Kies je patroon
    [colorStart, nameStart],      // 2 · Kies je kleuren
    [nameStart, preview],         // 3 · Zet je naam erop
    [scenes, end],                // 4 · Aan je muur
  ];
  STEPS.slice(0, 4).forEach((txt, i) => {
    if (!txt) return;
    fs.writeFileSync(seg(`st${i}.txt`), String(txt));
    const [r0, r1] = windows[i] || [patternStart, end];
    const b0 = rawToBody(r0 + 0.3);                                  // net ná het begin van de fase
    const b1 = Math.min(b0 + 3.0, rawToBody(r1));                    // max ~3s zichtbaar, binnen de fase
    const t0 = +Math.max(0, b0).toFixed(2), t1 = +Math.max(t0 + 1.2, b1).toFixed(2);
    fc.push(`[${vlab.slice(1, -1)}]${capStyle(`st${i}.txt`, t0, t1)}[vs${i}]`);
    vlab = `[vs${i}]`;
  });
}
if (CAP2) {
  fs.writeFileSync(seg("cap2.txt"), CAP2);
  const t = +(bodyDur - 2.6).toFixed(2);
  // eindregel bovenin (onder de site-koppen), zelfde leesbare stijl
  fc.push(`[${vlab.slice(1, -1)}]drawtext=${FONTARG}textfile=cap2.txt:fontsize=50:fontcolor=white:borderw=3:bordercolor=black@0.85:box=1:boxcolor=black@0.62:boxborderw=28:x=(w-text_w)/2:y=h*0.14:enable='gte(t,${t})'[v2]`);
  vlab = "[v2]";
}
const args = ["-i", seg("body.mp4"), "-i", LOGO];
const hasMusic = MUSIC && fs.existsSync(MUSIC);
if (hasMusic) args.push("-i", MUSIC);
args.push("-filter_complex", fc.join(";"), "-map", vlab);
if (hasMusic) { args.push("-map", "2:a", "-c:a", "aac", "-shortest"); }
args.push("-r", String(FPS), "-pix_fmt", "yuv420p", "-c:v", "libx264", FINAL);
ff(args);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log("KLAAR -> " + FINAL + "  (" + dur(FINAL).toFixed(1) + "s, uit " + D.toFixed(1) + "s ruw" + (hasMusic ? " + muziek" : "") + ")");
