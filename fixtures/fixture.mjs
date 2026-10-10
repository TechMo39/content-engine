// Genereert een representatieve mozaiek-SVG (geen echt patroon, wel dezelfde
// structuur: een <rect> achtergrond/voeg + veel losse <polygon> steentjes).
// Alleen voor lokaal testen/preview van de reveal-animatie.

const PALETTE = [
  "#c75a4e", "#45497d", "#e7c077", "#117573", "#a25662", "#e4ce8c",
  "#90a084", "#f79f45", "#663959", "#425563", "#94342f", "#7e95d7",
  "#1c1a17", "#cab19c", "#32949e", "#8f4d36",
];
const VOEG = "#eae4d7";

export function makeFixtureSvg(cols = 22, rows = 15) {
  const W = 100, H = (W * rows) / cols;
  const cw = W / cols, ch = H / rows;
  let s = `<svg viewBox="0 0 ${W} ${H.toFixed(2)}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<rect x="0" y="0" width="${W}" height="${H.toFixed(2)}" fill="${VOEG}"/>`;
  const g = 0.12; // voeg-marge tussen steentjes
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw + g, y0 = r * ch + g;
      const x1 = (c + 1) * cw - g, y1 = (r + 1) * ch - g;
      const col = PALETTE[(r * 3 + c * 5 + Math.floor(rnd() * 3)) % PALETTE.length];
      // twee driehoeken per cel -> mozaiek-gevoel
      const diag = (r + c) % 2 === 0;
      if (diag) {
        s += `<polygon points="${x0},${y0} ${x1},${y0} ${x0},${y1}" fill="${col}"/>`;
        s += `<polygon points="${x1},${y0} ${x1},${y1} ${x0},${y1}" fill="${PALETTE[(r + c + 2) % PALETTE.length]}"/>`;
      } else {
        s += `<polygon points="${x0},${y0} ${x1},${y0} ${x1},${y1}" fill="${col}"/>`;
        s += `<polygon points="${x0},${y0} ${x1},${y1} ${x0},${y1}" fill="${PALETTE[(r + c + 5) % PALETTE.length]}"/>`;
      }
    }
  }
  s += `</svg>`;
  return s;
}
