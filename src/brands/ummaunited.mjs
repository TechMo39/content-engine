// MERK-MODULE: Umma United — faceless YouTube-kanaal (geschiedenis/trots, humor).
// Totaal ander beeld dan Tale of Tiles: geen tegels, maar getekende vormen, kaarten,
// tijdlijnen, tellers, iconen en tekst. Bewijst dat de KERN generiek is: hetzelfde
// render-systeem, een compleet ander merk.
//
// 10 video-types (skelet, bedoeld om per type verder uit te bouwen):
//   split      Split-screen tegenstelling (twee werelden, zelfde moment)
//   zoomin     Uitvergroting (klein detail opent zich tot een verhaal)
//   raadsel    Wie-ben-ik (aanwijzingen -> onthulling)
//   mythe      Tegenwerping (bekende claim -> stuk voor stuk afgebroken)
//   dagin      Tijdcapsule (een dag van toen, uur voor uur)
//   ranglijst  Ranglijst (top 5 die opbouwt naar nr 1)
//   oorsprong  Oorsprong (ding van nu -> waar het begon)
//   brief      Brief / ooggetuige (één stem vertelt wat hij ziet)
//   watals     Wat-als (scharnierpunt -> twee takken)
//   reis       Kaart-reis (route tekent zich, stip/schip beweegt)
//
// Alles deterministisch, resvg-veilig (platte vormen, geen geneste/ingezoomde SVG),
// geen AI. Jouw stem komt er later onder (aparte bouwstap); de timing hier is nu op
// de klok, zodat elk type NU al rendert en te beoordelen is.
import { composeChrome, FORMATS, escapeXml } from "../core/renderer.mjs";

// ---------------------------------------------------------------- huisstijl
const COL = {
  navy: "#111a33", navy2: "#1b2748", ink: "#0d1427",
  cream: "#f5efe1", orange: "#ff7a2f", red: "#c0392b",
  blue: "#2756a0", blue2: "#3f7fd0", mute: "#9fb6d8",
};
const SANS = "DejaVu Sans,sans-serif";
const SERIF = "DejaVu Serif,serif";

// makkelijke easing
const sm = (p) => { p = Math.max(0, Math.min(1, p)); return p * p * (3 - 2 * p); };
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------------------------------------------------------------- iconen-bibliotheek
// Platte vormen, opgebouwd uit path/polygon/rect/circle. Gecentreerd rond (cx,cy),
// grootte s. Kleur via fill. Dit is het begin van de herbruikbare icoon-set.
function icoKoepel(cx, cy, s, fill) {
  const w = s, h = s * 0.9;
  return `<path d="M ${cx - w / 2} ${cy + h / 2} L ${cx - w / 2} ${cy} `
    + `C ${cx - w / 2} ${cy - h * 0.8}, ${cx + w / 2} ${cy - h * 0.8}, ${cx + w / 2} ${cy} `
    + `L ${cx + w / 2} ${cy + h / 2} Z" fill="${fill}"/>`
    + `<rect x="${cx - 2}" y="${cy - h * 0.95}" width="4" height="${h * 0.3}" fill="${fill}"/>`;
}
function icoBoek(cx, cy, s, fill) {
  const w = s, h = s * 0.72;
  return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="3" fill="${fill}"/>`
    + `<rect x="${cx - 1.5}" y="${cy - h / 2}" width="3" height="${h}" fill="${COL.ink}"/>`;
}
function icoBoog(cx, cy, s, fill) {
  const w = s * 0.8, h = s;
  return `<path d="M ${cx - w / 2} ${cy + h / 2} L ${cx - w / 2} ${cy - h * 0.1} `
    + `C ${cx - w / 2} ${cy - h * 0.7}, ${cx + w / 2} ${cy - h * 0.7}, ${cx + w / 2} ${cy - h * 0.1} `
    + `L ${cx + w / 2} ${cy + h / 2} L ${cx + w * 0.3} ${cy + h / 2} L ${cx + w * 0.3} ${cy} `
    + `C ${cx + w * 0.3} ${cy - h * 0.35}, ${cx - w * 0.3} ${cy - h * 0.35}, ${cx - w * 0.3} ${cy} `
    + `L ${cx - w * 0.3} ${cy + h / 2} Z" fill="${fill}"/>`;
}
function icoStar8(cx, cy, R, fill) {
  const r = R * 0.42, p = [];
  for (let i = 0; i < 16; i++) { const a = Math.PI / 8 * i - Math.PI / 2, rad = i % 2 ? r : R; p.push((cx + rad * Math.cos(a)).toFixed(1) + "," + (cy + rad * Math.sin(a)).toFixed(1)); }
  return `<polygon points="${p.join(" ")}" fill="${fill}"/>`;
}
function icoPen(cx, cy, s, fill) {
  return `<path d="M ${cx - s * 0.4} ${cy + s * 0.4} L ${cx + s * 0.3} ${cy - s * 0.3} L ${cx + s * 0.45} ${cy - s * 0.15} L ${cx - s * 0.25} ${cy + s * 0.55} Z" fill="${fill}"/>`
    + `<polygon points="${cx - s * 0.4},${cy + s * 0.4} ${cx - s * 0.25},${cy + s * 0.55} ${cx - s * 0.48},${cy + s * 0.58}" fill="${COL.ink}"/>`;
}
function icoHut(cx, cy, s, fill) {
  const w = s, h = s * 0.6;
  return `<rect x="${cx - w / 2}" y="${cy - h * 0.1}" width="${w}" height="${h}" fill="${fill}"/>`
    + `<polygon points="${cx - w * 0.6},${cy - h * 0.1} ${cx},${cy - h * 0.8} ${cx + w * 0.6},${cy - h * 0.1}" fill="${fill}"/>`;
}
function icoKandelaar(cx, cy, s, fill) {
  return `<rect x="${cx - 2}" y="${cy - s * 0.4}" width="4" height="${s * 0.8}" fill="${fill}"/>`
    + `<ellipse cx="${cx}" cy="${cy - s * 0.5}" rx="4" ry="7" fill="${COL.orange}"/>`;
}
// icoon kiezen op naam (voor de configurator later)
function ico(name, cx, cy, s, fill) {
  switch (name) {
    case "koepel": return icoKoepel(cx, cy, s, fill);
    case "boek": return icoBoek(cx, cy, s, fill);
    case "boog": return icoBoog(cx, cy, s, fill);
    case "ster": return icoStar8(cx, cy, s * 0.6, fill);
    case "pen": return icoPen(cx, cy, s, fill);
    case "hut": return icoHut(cx, cy, s, fill);
    case "kaars": return icoKandelaar(cx, cy, s, fill);
    default: return `<circle cx="${cx}" cy="${cy}" r="${s * 0.4}" fill="${fill}"/>`;
  }
}

// ---------------------------------------------------------------- gedeelde chrome
// Het KADER (fotoboek-rand) in de merkkleur: op ELKE video, de vaste handtekening.
function kader(W, H) {
  const m = Math.round(W * 0.035), r = Math.round(W * 0.04);
  return `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" rx="${r}" `
    + `fill="none" stroke="${COL.orange}" stroke-width="${Math.round(W * 0.012)}"/>`
    + `<rect x="${m + 7}" y="${m + 7}" width="${W - 2 * m - 14}" height="${H - 2 * m - 14}" rx="${r - 5}" `
    + `fill="none" stroke="${COL.cream}" stroke-width="2" opacity="0.5"/>`;
}
// grote titel bovenin
function titel(txt, W, H, op = 1) {
  if (!txt) return "";
  const fs = Math.round(W * 0.07);
  return `<text x="${W / 2}" y="${H * 0.14}" text-anchor="middle" font-family="${SERIF}" font-weight="700" `
    + `font-size="${fs}" fill="${COL.cream}" opacity="${op.toFixed(2)}">${escapeXml(txt)}</text>`;
}
// onderschrift (één regel, komt op; later vervangen we de klok-timing door jouw stem)
function onderschrift(txt, W, H, op = 1) {
  if (!txt) return "";
  const fs = Math.round(W * 0.052);
  const y = Math.round(H * 0.86);
  const bw = Math.min(W * 0.86, fs * String(txt).length * 0.62);
  return `<g opacity="${op.toFixed(2)}">`
    + `<rect x="${W / 2 - bw / 2 - 18}" y="${y - fs}" width="${bw + 36}" height="${fs * 1.7}" rx="${fs}" fill="#000000" opacity="0.30"/>`
    + `<text x="${W / 2}" y="${y + fs * 0.3}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${fs}" fill="${COL.cream}">${escapeXml(txt)}</text></g>`;
}

export function makeBrand() {
  const branding = {
    name: "Umma United", footer: "UMMA UNITED",
    bg: COL.ink, bg2: COL.navy2, gold: COL.orange, cream: COL.cream, plate: COL.navy,
  };

  async function init() {}
  async function listSubjects() {
    // "onderwerpen" zijn hier losse ideeën; het echte script komt via opts.
    return [{ id: "Córdoba 1000" }, { id: "Het Huis der Wijsheid" }, { id: "Al-Zahrawi" }].map((s) => ({ id: s.id }));
  }

  const templates = [
    { id: "split", name: "Split-screen tegenstelling", music: ["calm", "oriental"], defaults: {} },
    { id: "zoomin", name: "Uitvergroting (detail opent)", music: ["calm", "lofi"], defaults: {} },
    { id: "raadsel", name: "Wie-ben-ik (raadspel)", music: ["upbeat", "lofi"], defaults: {} },
    { id: "mythe", name: "Tegenwerping (claim afbreken)", music: ["upbeat", "calm"], defaults: {} },
    { id: "dagin", name: "Tijdcapsule (dag van toen)", music: ["calm", "oriental"], defaults: {} },
    { id: "ranglijst", name: "Ranglijst (top 5)", music: ["upbeat", "lofi"], defaults: {} },
    { id: "oorsprong", name: "Oorsprong (van nu naar begin)", music: ["calm", "oriental"], defaults: {} },
    { id: "brief", name: "Brief / ooggetuige", music: ["calm", "oriental"], defaults: {} },
    { id: "watals", name: "Wat-als (twee takken)", music: ["calm", "lofi"], defaults: {} },
    { id: "reis", name: "Kaart-reis (route)", music: ["calm", "oriental"], defaults: {} },
  ];

  // taal-helper voor de default-teksten
  function L(opts, nl, en, fr) { const l = opts.lang; return l === "en" ? en : l === "fr" ? fr : nl; }

  // ============================================================= 1. SPLIT
  async function makeSplit({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 9;
    const title = opts.title || L(opts, "Zelfde jaar. Twee werelden.", "Same year. Two worlds.", "Même année. Deux mondes.");
    const sub = opts.caption || L(opts, "Europa, jaar 1000", "Europe, year 1000", "Europe, an 1000");
    const leftIcons = (opts.left || "hut,kaars").split(",").map((s) => s.trim()).filter(Boolean);
    const rightIcons = (opts.right || "boog,boek,ster").split(",").map((s) => s.trim()).filter(Boolean);
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01((t - 0.4) / 1.6);
      const half = W / 2;
      let f = "";
      // linker helft (donker)
      f += `<rect x="0" y="0" width="${half}" height="${H}" fill="#0a1020" opacity="0.0"/>`;
      // rechter helft (warm)
      f += `<rect x="${half}" y="0" width="${half}" height="${H}" fill="#241a10" opacity="${(0.0 + 0.25 * sm(p)).toFixed(2)}"/>`;
      // deellijn
      f += `<rect x="${half - 2}" y="${H * 0.2}" width="4" height="${H * 0.55}" fill="${COL.orange}" opacity="0.8"/>`;
      // iconen links (verschijnen eerst), rechts (verschijnen na)
      const cyBase = H * 0.5;
      leftIcons.forEach((nm, i) => { const op = clamp01((t - 0.6 - i * 0.3) / 0.5); f += `<g opacity="${op.toFixed(2)}">${ico(nm, half * 0.5, cyBase - 40 + i * 90, W * 0.16, COL.mute)}</g>`; });
      rightIcons.forEach((nm, i) => { const op = clamp01((t - 1.8 - i * 0.35) / 0.5); f += `<g opacity="${op.toFixed(2)}">${ico(nm, half + half * 0.5, cyBase - 90 + i * 90, W * 0.16, COL.orange)}</g>`; });
      const ovl = kader(W, H) + titel(title, W, H) + onderschrift(sub, W, H, clamp01((t - 0.2) / 0.6));
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt, hookAt: 0.9 };
  }

  // ============================================================= 2. ZOOMIN
  async function makeZoomin({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 8;
    const title = opts.title || L(opts, "Kijk eens beter.", "Look closer.", "Regarde mieux.");
    const detail = opts.icon || "ster";
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01(t / durSec);
      // één detail dat groeit (scale op een <g> — veilig, geen geneste svg)
      const scale = 1 + sm(p) * 6;
      const cx = W / 2, cy = H * 0.5;
      let f = `<g transform="translate(${cx} ${cy}) scale(${scale.toFixed(3)}) translate(${-cx} ${-cy})">`;
      f += ico(detail, cx, cy, W * 0.12, COL.orange);
      f += `</g>`;
      // na de helft: het "nieuwe" dat zich opent (tekst/vorm die opdoemt)
      const rev = clamp01((t - durSec * 0.55) / (durSec * 0.3));
      if (rev > 0) f += `<g opacity="${rev.toFixed(2)}">${icoBoek(cx, cy, W * 0.4, COL.cream)}</g>`;
      const ovl = kader(W, H) + titel(title, W, H, clamp01((0.8 - p) / 0.3)) + onderschrift(opts.caption || "", W, H, rev);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 3. RAADSEL
  async function makeRaadsel({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 10;
    const clues = (opts.clues || L(opts,
      "Hij leefde rond het jaar 1000|Hij schreef 30 boeken|Chirurgen gebruiken zijn werk nog steeds",
      "He lived around the year 1000|He wrote 30 books|Surgeons still use his work today",
      "Il vécut vers l'an 1000|Il écrivit 30 livres|Les chirurgiens utilisent encore son travail")).split("|");
    const answer = opts.answer || "Al-Zahrawi";
    function sceneAt(frame) {
      const t = frame / FPS;
      let f = "";
      const per = (durSec - 2.5) / clues.length;
      clues.forEach((c, i) => {
        const t0 = 0.5 + i * per, op = clamp01((t - t0) / 0.5) * clamp01((durSec - 2.0 - t) / 0.6 + 1);
        if (op > 0.01) {
          const y = H * 0.3 + i * H * 0.12, fs = Math.round(W * 0.05);
          f += `<g opacity="${Math.min(1, op).toFixed(2)}"><rect x="${W * 0.1}" y="${y - fs}" width="${W * 0.8}" height="${fs * 2.0}" rx="12" fill="${COL.navy2}"/>`
            + `<text x="${W / 2}" y="${y + fs * 0.35}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${COL.cream}">${escapeXml(c)}</text></g>`;
        }
      });
      // onthulling
      const rev = clamp01((t - (durSec - 1.8)) / 0.8);
      let f2 = f;
      if (rev > 0.01) {
        f2 = `<g opacity="${rev.toFixed(2)}">${icoStar8(W / 2, H * 0.4, W * 0.18, COL.orange)}`
          + `<text x="${W / 2}" y="${H * 0.62}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${Math.round(W * 0.09)}" fill="${COL.cream}">${escapeXml(answer)}</text></g>`;
      }
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Wie ben ik?", "Who am I?", "Qui suis-je?"), W, H, clamp01((durSec - 1.8 - t) / 0.5));
      return composeChrome({ branding, W, H, panel: null, innerField: f2, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 4. MYTHE
  async function makeMythe({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 8;
    const claim = opts.claim || L(opts, "“De donkere middeleeuwen”", "“The Dark Ages”", "“Les âges sombres”");
    const truth = opts.truth || L(opts, "In Córdoba brandden de straatlantaarns.", "In Córdoba the streetlamps were lit.", "À Cordoue, les lampadaires brillaient.");
    function sceneAt(frame) {
      const t = frame / FPS;
      const fs = Math.round(W * 0.075);
      let f = `<text x="${W / 2}" y="${H * 0.4}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${fs}" fill="${COL.cream}">${escapeXml(claim)}</text>`;
      // doorstreep na 2s
      const strike = clamp01((t - 2.0) / 0.6);
      if (strike > 0) f += `<rect x="${W * 0.15}" y="${H * 0.4 - fs * 0.25}" width="${W * 0.7 * strike}" height="6" fill="${COL.red}"/>`;
      // waarheid onderaan
      const rev = clamp01((t - 2.8) / 0.8);
      if (rev > 0) f += onderschrift(truth, W, H, rev);
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Wat ze je niet vertelden", "What they never told you", "Ce qu'on ne t'a pas dit"), W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 5. DAGIN (tijdcapsule)
  async function makeDagin({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 10;
    const stops = (opts.items || "kaars,boek,boog,ster").split(",").map((s) => s.trim()).filter(Boolean);
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01(t / durSec);
      const cx = W / 2, cy = H * 0.42, R = W * 0.26;
      let f = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${COL.navy2}" stroke-width="10"/>`;
      // wijzer draait
      const a = -Math.PI / 2 + p * 2 * Math.PI;
      f += `<line x1="${cx}" y1="${cy}" x2="${(cx + R * 0.8 * Math.cos(a)).toFixed(1)}" y2="${(cy + R * 0.8 * Math.sin(a)).toFixed(1)}" stroke="${COL.orange}" stroke-width="6" stroke-linecap="round"/>`;
      f += `<circle cx="${cx}" cy="${cy}" r="8" fill="${COL.orange}"/>`;
      // iconen per "uur" verschijnen rond de klok
      stops.forEach((nm, i) => {
        const ta = -Math.PI / 2 + (i / stops.length) * 2 * Math.PI;
        const op = clamp01((p - i / stops.length) / 0.08);
        f += `<g opacity="${op.toFixed(2)}">${ico(nm, cx + R * 1.15 * Math.cos(ta), cy + R * 1.15 * Math.sin(ta), W * 0.1, COL.cream)}</g>`;
      });
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Een dag in Córdoba, jaar 1000", "A day in Córdoba, year 1000", "Un jour à Cordoue, an 1000"), W, H, 1) + onderschrift(opts.caption || "", W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 6. RANGLIJST
  async function makeRanglijst({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 10;
    // items: "label:waarde" per item, grootste = nr 1
    const raw = (opts.items || "Baghdad:1200|Córdoba:1000|Caïro:800|Fez:600|Damascus:500").split("|");
    const items = raw.map((s) => { const [lab, v] = s.split(":"); return { lab: (lab || "").trim(), v: Number(v) || 0 }; });
    const maxV = Math.max(1, ...items.map((x) => x.v));
    function sceneAt(frame) {
      const t = frame / FPS;
      let f = "";
      const top = H * 0.26, bh = H * 0.09, gap = H * 0.025;
      items.forEach((it, i) => {
        const t0 = 0.4 + i * 0.5, gp = sm(clamp01((t - t0) / 0.9));
        const y = top + i * (bh + gap);
        const bw = (W * 0.76) * (it.v / maxV) * gp;
        f += `<rect x="${W * 0.12}" y="${y}" width="${W * 0.76}" height="${bh}" rx="10" fill="${COL.navy2}"/>`;
        f += `<rect x="${W * 0.12}" y="${y}" width="${bw.toFixed(1)}" height="${bh}" rx="10" fill="${i === 0 ? COL.orange : COL.blue2}"/>`;
        f += `<text x="${W * 0.14}" y="${y + bh * 0.66}" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.045)}" fill="${COL.cream}">${escapeXml(it.lab)}</text>`;
        const shown = Math.round(it.v * gp);
        f += `<text x="${W * 0.86}" y="${y + bh * 0.66}" text-anchor="end" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.045)}" fill="${COL.cream}">${shown}</text>`;
      });
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Grootste steden, jaar 1000", "Biggest cities, year 1000", "Plus grandes villes, an 1000"), W, H, 1) + onderschrift(opts.caption || "", W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 7. OORSPRONG
  async function makeOorsprong({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 8;
    const nu = opts.now || L(opts, "Het ziekenhuis", "The hospital", "L'hôpital");
    const toen = opts.then || L(opts, "Bimaristan, Baghdad, 805", "Bimaristan, Baghdad, 805", "Bimaristan, Bagdad, 805");
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01(t / durSec);
      const cx = W / 2, cy = H * 0.45;
      // fase 1: modern ding; fase 2: terug naar het begin (crossfade op opacity)
      const op1 = clamp01((0.5 - p) / 0.2 + 1) * clamp01((0.55 - p) / 0.15);
      const op2 = clamp01((p - 0.5) / 0.15);
      let f = `<g opacity="${clamp01(1 - op2).toFixed(2)}">${icoBoek(cx, cy, W * 0.3, COL.mute)}`
        + `<text x="${cx}" y="${H * 0.66}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${Math.round(W * 0.07)}" fill="${COL.cream}">${escapeXml(nu)}</text></g>`;
      f += `<g opacity="${op2.toFixed(2)}">${icoKoepel(cx, cy, W * 0.34, COL.orange)}`
        + `<text x="${cx}" y="${H * 0.66}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${Math.round(W * 0.06)}" fill="${COL.cream}">${escapeXml(toen)}</text></g>`;
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Waar het begon", "Where it began", "Où tout a commencé"), W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 8. BRIEF
  async function makeBrief({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 10;
    const lines = (opts.lines || L(opts,
      "Ik liep door de markt van Baghdad.|Honderd talen, duizend geuren.|En overal: boeken.",
      "I walked through the market of Baghdad.|A hundred tongues, a thousand scents.|And everywhere: books.",
      "J'ai traversé le marché de Bagdad.|Cent langues, mille parfums.|Et partout: des livres.")).split("|");
    function sceneAt(frame) {
      const t = frame / FPS;
      // perkament-vlak
      let f = `<rect x="${W * 0.1}" y="${H * 0.26}" width="${W * 0.8}" height="${H * 0.46}" rx="14" fill="${COL.navy2}" opacity="0.6"/>`;
      const per = (durSec - 1.5) / lines.length;
      lines.forEach((ln, i) => {
        const op = clamp01((t - (0.6 + i * per)) / 0.6);
        if (op > 0.01) {
          const y = H * 0.36 + i * H * 0.1, fs = Math.round(W * 0.052);
          f += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="${SERIF}" font-style="italic" font-size="${fs}" fill="${COL.cream}" opacity="${op.toFixed(2)}">${escapeXml(ln)}</text>`;
        }
      });
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Een reiziger schreef...", "A traveler wrote...", "Un voyageur écrivit..."), W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 9. WATALS
  async function makeWatals({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 9;
    const brA = opts.branchA || L(opts, "Wat we verloren", "What we lost", "Ce qu'on a perdu");
    const brB = opts.branchB || L(opts, "Wat had kunnen zijn", "What could have been", "Ce qui aurait pu être");
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01((t - 0.5) / 2.0);
      const x0 = W / 2, y0 = H * 0.28, yf = H * 0.55;
      let f = `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${yf}" stroke="${COL.cream}" stroke-width="5"/>`;
      // twee takken groeien
      const ax = x0 - W * 0.3 * sm(p), bx = x0 + W * 0.3 * sm(p), by = yf + H * 0.18 * sm(p);
      f += `<line x1="${x0}" y1="${yf}" x2="${ax.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${COL.red}" stroke-width="5"/>`;
      f += `<line x1="${x0}" y1="${yf}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${COL.orange}" stroke-width="5"/>`;
      const opT = clamp01((t - 2.2) / 0.8);
      if (opT > 0) {
        const fs = Math.round(W * 0.045);
        f += `<text x="${ax.toFixed(1)}" y="${(by + 40).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${COL.cream}" opacity="${opT.toFixed(2)}">${escapeXml(brA)}</text>`;
        f += `<text x="${bx.toFixed(1)}" y="${(by + 40).toFixed(1)}" text-anchor="middle" font-family="${SANS}" font-size="${fs}" fill="${COL.cream}" opacity="${opT.toFixed(2)}">${escapeXml(brB)}</text>`;
      }
      const ovl = kader(W, H) + titel(opts.title || L(opts, "Wat als...", "What if...", "Et si..."), W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // ============================================================= 10. REIS
  async function makeReis({ opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = Number(opts.durationSec) || 9;
    // route-punten genormaliseerd (0..1) binnen het kaart-vlak
    const pts = (opts.route || "0.2,0.3|0.5,0.45|0.8,0.65").split("|").map((s) => { const [x, y] = s.split(",").map(Number); return { x, y }; });
    const from = opts.from || "Córdoba", to = opts.to || "Baghdad";
    function sceneAt(frame) {
      const t = frame / FPS, p = clamp01((t - 0.5) / (durSec - 2.0));
      const mx = W * 0.1, my = H * 0.24, mw = W * 0.8, mh = H * 0.5;
      // kaart-vlak
      let f = `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" rx="14" fill="${COL.blue}" opacity="0.25"/>`;
      const P = pts.map((pt) => ({ x: mx + pt.x * mw, y: my + pt.y * mh }));
      // route als path, progressief getekend (benader met segmenten)
      let drawn = "";
      const total = P.length - 1;
      const prog = p * total;
      for (let i = 0; i < total; i++) {
        const seg = clamp01(prog - i);
        if (seg <= 0) break;
        const a = P[i], b = P[i + 1];
        const ex = a.x + (b.x - a.x) * seg, ey = a.y + (b.y - a.y) * seg;
        drawn += `${i === 0 ? `M ${a.x} ${a.y}` : ""} L ${ex.toFixed(1)} ${ey.toFixed(1)} `;
      }
      if (drawn) f += `<path d="${drawn}" fill="none" stroke="${COL.orange}" stroke-width="5" stroke-dasharray="2 10" stroke-linecap="round"/>`;
      // bewegende stip (het "schip")
      const idx = Math.min(total - 1, Math.floor(prog)), seg = clamp01(prog - idx);
      const a = P[idx] || P[0], b = P[idx + 1] || P[0];
      const sx = a.x + (b.x - a.x) * seg, sy = a.y + (b.y - a.y) * seg;
      f += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="10" fill="${COL.cream}"/>`;
      // begin/eind labels
      f += `<text x="${P[0].x}" y="${P[0].y - 16}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.04)}" fill="${COL.cream}">${escapeXml(from)}</text>`;
      f += `<text x="${P[P.length - 1].x}" y="${P[P.length - 1].y + 32}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="${Math.round(W * 0.04)}" fill="${COL.cream}">${escapeXml(to)}</text>`;
      const ovl = kader(W, H) + titel(opts.title || L(opts, "De route van kennis", "The road of knowledge", "La route du savoir"), W, H, 1) + onderschrift(opts.caption || "", W, H, 1);
      return composeChrome({ branding, W, H, panel: null, innerField: f, overlay: ovl, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  // -------------------------------------------------------------- dispatch
  async function makeRender({ subjectId, opts = {}, format = "9:16" }) {
    const type = opts.type || opts.template || "split";
    const o = { ...opts };
    switch (type) {
      case "split": return makeSplit({ opts: o, format });
      case "zoomin": return makeZoomin({ opts: o, format });
      case "raadsel": return makeRaadsel({ opts: o, format });
      case "mythe": return makeMythe({ opts: o, format });
      case "dagin": return makeDagin({ opts: o, format });
      case "ranglijst": return makeRanglijst({ opts: o, format });
      case "oorsprong": return makeOorsprong({ opts: o, format });
      case "brief": return makeBrief({ opts: o, format });
      case "watals": return makeWatals({ opts: o, format });
      case "reis": return makeReis({ opts: o, format });
      default: return makeSplit({ opts: o, format });
    }
  }

  return {
    id: "ummaunited", name: "Umma United", branding, init, listSubjects, templates, makeRender,
    options: ["type", "title", "caption", "lang", "durationSec",
      "left", "right", "icon", "clues", "answer", "claim", "truth",
      "items", "now", "then", "lines", "branchA", "branchB", "route", "from", "to"],
  };
}
