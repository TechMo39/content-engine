// Rendert de tegel-canvas tekenfilm naar een echte mp4 (resvg + ffmpeg).
// Bewijs van de animatie-engine: opbouw -> hart -> ster -> kleuren-wissel, 1 patroon.
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import esbuild from "esbuild";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
// Laad de animatie-engine uit remotion/film.ts (één bron van waarheid).
const outfile = path.resolve(ROOT,"out/.filmlib.mjs");
await esbuild.build({ entryPoints:[path.resolve(ROOT,"remotion/film.ts")], bundle:true, format:"esm", platform:"node", logLevel:"silent", outfile });
const { parseTiles, defaultStoryboard, colorsAt, totalDuration, buildSvg } = await import(pathToFileURL(outfile).href+"?t="+Date.now());

const W=540, H=960, FPS=24;
const C={bg:"#1a1327",bg2:"#241a3a",gold:"#d6b35a",cream:"#f4ecdc"};

const svg = await fs.readFile(path.resolve(ROOT,"fixtures/dump.svg"),"utf8");
const parsed = parseTiles(svg);
const story = defaultStoryboard();
const DUR = totalDuration(story);
console.log("tegels:",parsed.tiles.length,"| duur:",DUR.toFixed(1)+"s");

const aspect = parsed.view[2]/parsed.view[3];
const pad=9, panelW=Math.round(W*0.84), innerW=panelW-pad*2;
const innerH=Math.round(innerW/aspect), panelH=innerH+pad*2;
const panelX=Math.round((W-panelW)/2), panelY=Math.round(H*0.29);

function scene(frame){
  const t=frame/FPS;
  const colors=colorsAt(parsed,story,t);
  const inner=buildSvg(parsed,colors).replace(/<svg\b[^>]*>/i,
    `<svg x="${panelX+pad}" y="${panelY+pad}" width="${innerW}" height="${innerH}" viewBox="0 0 ${parsed.view[2]} ${parsed.view[3]}" preserveAspectRatio="xMidYMid meet">`);
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs><radialGradient id="bg" cx="50%" cy="26%" r="90%"><stop offset="0%" stop-color="${C.bg2}"/><stop offset="70%" stop-color="${C.bg}"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<text x="${W/2}" y="${H*0.1}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="20" letter-spacing="4" fill="${C.gold}">TALE OF TILES</text>
<rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="6" fill="#140f1e" stroke="${C.gold}" stroke-width="2"/>
${inner}
<text x="${W/2}" y="${H*0.95}" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="20" letter-spacing="2" fill="${C.cream}" opacity="0.85">taleoftiles.com</text>
</svg>`;
}

const tmp=path.resolve(ROOT,"out/.film"); await fs.rm(tmp,{recursive:true,force:true}); await fs.mkdir(tmp,{recursive:true});
const total=Math.round(DUR*FPS);
process.stdout.write(`• ${total} frames rasteren `);
for(let f=0; f<total; f++){
  const r=new Resvg(scene(f),{fitTo:{mode:"width",value:W},font:{loadSystemFonts:true}});
  await fs.writeFile(path.join(tmp,`f${String(f).padStart(4,"0")}.png`), r.render().asPng());
  if(f%24===0) process.stdout.write(".");
}
console.log(" klaar");

const out=path.resolve(ROOT,"out/film-proof.mp4");
const res=spawnSync("ffmpeg",["-y","-framerate",String(FPS),"-i",path.join(tmp,"f%04d.png"),
  "-c:v","libx264","-pix_fmt","yuv420p","-movflags","+faststart",out],{stdio:["ignore","ignore","pipe"]});
if(res.status!==0){ console.error(res.stderr?.toString().slice(-400)); process.exit(1); }
await fs.rm(tmp,{recursive:true,force:true});
console.log("✓ out/film-proof.mp4");
