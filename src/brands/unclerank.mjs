// MERK-MODULE (stub): UncleRank — bureau-portaal. Totaal ander beeld dan Tale of
// Tiles: geen patronen, maar een SaaS/scan-animatie. Bewijst dat de KERN generiek is:
// hetzelfde render-systeem, een compleet ander merk. Later uit te breiden met echte
// scan-data en meer templates.
import { composeChrome, FORMATS, escapeXml } from "../core/renderer.mjs";

export function makeBrand() {
  const branding = {
    name: "UncleRank", footer: "unclerank.com",
    bg: "#0b1220", bg2: "#13213b", gold: "#39d98a", cream: "#e6edf7",
  };

  async function init() {}
  async function listSubjects() {
    return [{ id: "Bakkerij Jansen" }, { id: "Café De Hoek" }, { id: "Garage Smeets" }].map((s) => ({ id: s.id }));
  }
  const templates = [{ id: "scanscore", name: "Scan-score reveal", defaults: {} }];

  async function makeRender({ subjectId, opts = {}, format = "9:16" }) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const SS = 2, FPS = 24, durSec = 6;
    const bedrijf = (opts.name || subjectId || "Jouw bedrijf").trim();
    const target = 42;                         // "gevonden" score (demo)
    const cx = W / 2, cy = Math.round(H * 0.44), R = Math.round(W * 0.26);
    const C = 2 * Math.PI * R;
    function sceneAt(frame) {
      const t = frame / FPS;
      const p = Math.max(0, Math.min(1, (t - 0.6) / 2.6));          // ring vult 0..1
      const ease = p * p * (3 - 2 * p);
      const score = Math.round(target * ease);
      const dash = `${(C * ease * (score / 100)).toFixed(1)} ${C.toFixed(1)}`;
      const showFix = t > 3.6 ? Math.min(1, (t - 3.6) / 0.8) : 0;
      const ring = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#223049" stroke-width="18"/>`
        + `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${branding.gold}" stroke-width="18" stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 ${cx} ${cy})"/>`
        + `<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-weight="700" font-size="${Math.round(R * 0.7)}" fill="${branding.cream}">${score}</text>`
        + `<text x="${cx}" y="${cy + R * 0.7}" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-size="22" fill="#8aa0c0">online-score</text>`;
      const head = `<text x="${cx}" y="${H * 0.2}" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-weight="700" font-size="30" fill="${branding.cream}">${escapeXml(bedrijf)}</text>`;
      const fix = showFix ? `<g opacity="${showFix.toFixed(2)}"><rect x="${W * 0.12}" y="${H * 0.72}" width="${W * 0.76}" height="${H * 0.1}" rx="14" fill="#16233d"/><text x="${cx}" y="${H * 0.785}" text-anchor="middle" font-family="DejaVu Sans,sans-serif" font-weight="700" font-size="26" fill="${branding.gold}">Wij fixen dit voor je →</text></g>` : "";
      return composeChrome({ branding, W, H, panel: null, innerField: head + ring + fix, logoUri: "" });
    }
    return { W, H, FPS, SS, durSec, sceneAt };
  }

  return { id: "unclerank", name: "UncleRank", branding, init, listSubjects, templates, makeRender, options: ["name"] };
}
