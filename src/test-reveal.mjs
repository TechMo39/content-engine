// Logica-test voor het reveal-moduul. Draait zonder browser.
import { loadSvgLib } from "./_svglib.mjs";
import { makeFixtureSvg } from "../fixtures/fixture.mjs";

let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fails++;
};

const lib = await loadSvgLib();
const fps = 30,
  opts = { fps, revealStartSec: 0.6, revealEndSec: 5.4, popDurSec: 0.5 };

const svg = makeFixtureSvg(22, 15);
const p = lib.parseSvg(svg, "polygon,path");
lib.orderTiles(p, "radial");

ok(p.tiles.length > 300, `aantal steentjes gevonden: ${p.tiles.length}`);
ok(p.statics.length === p.tiles.length + 1, "statics en tiles sluiten aan (N+1)");

// order 0..N-1 uniek
const orders = [...p.tiles.map((t) => t.order)].sort((a, b) => a - b);
ok(orders[0] === 0 && orders[orders.length - 1] === p.tiles.length - 1, "order 0..N-1");

// radiaal: tile met order 0 zit dichter bij centrum dan die met hoogste order
const mx = p.view.x + p.view.w / 2, my = p.view.y + p.view.h / 2;
const first = p.tiles.find((t) => t.order === 0);
const last = p.tiles.find((t) => t.order === p.tiles.length - 1);
const dFirst = Math.hypot(first.gx - mx, first.gy - my);
const dLast = Math.hypot(last.gx - mx, last.gy - my);
ok(dFirst < dLast, `radiaal: eerste(${dFirst.toFixed(1)}) < laatste(${dLast.toFixed(1)})`);

// originele structuur blijft intact: achtergrond-rect zit nog in de output
const f0 = lib.buildFrameSvg(p, 0, opts);
ok(f0.includes("<rect"), "achtergrond-rect blijft behouden (SVG intact)");

// frame 0: alles opacity 0 ; eindframe: niets meer op 0
const endFrame = Math.ceil(opts.revealEndSec * fps) + 2;
const fEnd = lib.buildFrameSvg(p, endFrame, opts);
const zeros0 = (f0.match(/opacity="0"/g) || []).length;
const zerosEnd = (fEnd.match(/opacity="0"/g) || []).length;
ok(zeros0 === p.tiles.length, `frame 0: alle steentjes onzichtbaar (${zeros0})`);
ok(zerosEnd === 0, `eindframe: geen enkel steentje meer op opacity 0`);

// midframe: tussenin
const fMid = lib.buildFrameSvg(p, Math.round(fps * 3), opts);
const zerosMid = (fMid.match(/opacity="0"/g) || []).length;
ok(zerosMid > 0 && zerosMid < p.tiles.length, `midframe tussenin (${zerosMid} nog verborgen)`);
ok(/transform="translate/.test(fMid), "reveal zet transform op onthulde steentjes");

console.log(fails ? `\n✗ ${fails} test(s) gefaald` : "\n✓ alle reveal-tests groen");
process.exit(fails ? 1 : 0);
