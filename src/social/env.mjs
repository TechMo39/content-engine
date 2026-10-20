// Mini .env-loader (geen dependency). Leest <root>/.env en zet regels in process.env,
// zonder bestaande waarden te overschrijven. Formaat: KEY=waarde, één per regel; # = commentaar.
// Waarden mogen tussen "..." of '...' staan. Stil als er geen .env is.
import fs from "node:fs";
import path from "node:path";

export function loadEnv(root) {
  try {
    const txt = fs.readFileSync(path.resolve(root, ".env"), "utf8");
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch {}
}
