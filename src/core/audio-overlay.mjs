// AUDIO-OVERLAY — additief, merk-agnostisch. Legt extra audiosporen (stem, SFX) op de
// al-gerenderde mp4, over de bestaande audiobodem (muziek). Wordt alleen aangeroepen als een
// render-object `audio.tracks` meelevert (zoals Umma United). Raakt renderer.mjs NIET aan en
// kopieert het videospoor ongewijzigd (geen her-encode), dus kwaliteit blijft gelijk.
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// tracks = [{ file, atSec, gain }]  — file = absoluut pad; atSec = startmoment; gain = volume (1 = 100%)
export async function overlayAudio({ mp4, tracks, hasBaseAudio = true, log = () => {} }) {
  const valid = (tracks || []).filter((t) => t && t.file && existsSync(t.file));
  if (!valid.length) return;
  const FF = ffmpegPath || "ffmpeg";
  const tmp = path.join(path.dirname(mp4), ".aud-" + Date.now() + ".mp4");
  const args = ["-y", "-v", "error", "-i", mp4];
  for (const t of valid) args.push("-i", t.file);
  const chains = [], mix = [];
  if (hasBaseAudio) mix.push("0:a");
  valid.forEach((t, k) => {
    const ms = Math.max(0, Math.round((t.atSec || 0) * 1000));
    const g = (t.gain == null ? 1 : t.gain);
    chains.push(`[${k + 1}:a]adelay=${ms}:all=1,volume=${g}[a${k}]`);
    mix.push(`a${k}`);
  });
  const fc = (chains.length ? chains.join(";") + ";" : "") +
    `[${mix.join("][")}]amix=inputs=${mix.length}:normalize=0:duration=first[aout]`;
  args.push("-filter_complex", fc, "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", tmp);
  await new Promise((resolve, reject) => {
    const p = spawn(FF, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let e = ""; if (p.stderr) p.stderr.on("data", (d) => (e += d.toString()));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(e.trim().split("\n").pop() || ("ffmpeg " + c)))));
  });
  await fs.rename(tmp, mp4);
  log(`♪ audio-overlay: ${valid.length} extra spoor/sporen (stem/SFX) over de video`);
}
