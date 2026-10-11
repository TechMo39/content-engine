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

const BLANK = "#e8e5e2";
const svg = makeFixtureSvg(22, 15);
const p = lib.parseSvg(svg, "polygon,path");
lib.orderTiles(p, "random");

ok(p.tiles.length > 300, `aantal steentjes gevonden: ${p.tiles.length}`);
ok(p.statics.length === p.tiles.length + 1, "statics en tiles sluiten aan (N+1)");
ok(p.tiles.every((t) => /^#[0-9a-f]{6}$/i.test(t.realFill)), "elk steentje heeft een echte kleur");

// order 0..N-1 uniek
const orders = [...p.tiles.map((t) => t.order)].sort((a, b) => a - b);
ok(orders[0] === 0 && orders[orders.length - 1] === p.tiles.length - 1, "order 0..N-1");

const blanks = (s) => (s.match(new RegExp(BLANK, "gi")) || []).length;

// frame 0: ALLE steentjes neutraal (nog niet ingekleurd), patroon wel compleet
const f0 = lib.buildFrameSvg(p, 0, opts);
ok(f0.includes("<rect"), "achtergrond-rect blijft behouden (SVG intact)");
ok(blanks(f0) >= p.tiles.length, `frame 0: alles neutraal (${blanks(f0)} blanks)`);
ok(!/opacity="0"/.test(f0), "frame 0: niets verborgen (vormen staan er al)");

// eindframe: niets meer neutraal (fixture heeft geen e8e5e2 in palet)
const endFrame = Math.ceil(opts.revealEndSec * fps) + 2;
const fEnd = lib.buildFrameSvg(p, endFrame, opts);
ok(blanks(fEnd) === 0, `eindframe: alles ingekleurd (${blanks(fEnd)} blanks)`);

// midframe: deels ingekleurd
const fMid = lib.buildFrameSvg(p, Math.round(fps * 3.5), opts);
const bMid = blanks(fMid);
ok(bMid > 0 && bMid < p.tiles.length, `midframe deels ingekleurd (${bMid} nog neutraal)`);

// willekeurig: order correleert NIET sterk met positie (anders dan radiaal/sweep)
const mx = p.view.x + p.view.w / 2, my = p.view.y + p.view.h / 2;
const firstFew = p.tiles.filter((t) => t.order < 20);
const spread = Math.max(...firstFew.map((t) => Math.hypot(t.gx - mx, t.gy - my)));
ok(spread > p.view.w * 0.2, `willekeurig: eerste 20 steentjes verspreid (max afstand ${spread.toFixed(0)})`);

console.log(fails ? `\n✗ ${fails} test(s) gefaald` : "\n✓ alle reveal-tests groen");
process.exit(fails ? 1 : 0);
