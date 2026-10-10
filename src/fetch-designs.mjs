// Haal de opgeslagen ontwerpen op. Live via de API, of uit een lokaal JSON-bestand
// (handig om offline/zonder site te draaien).
import fs from "node:fs/promises";
import { config } from "../config.mjs";

export async function fetchDesigns({ file } = {}) {
  if (file) {
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    return raw.items || [];
  }
  const res = await fetch(config.apiUrl);
  if (!res.ok) throw new Error(`showcase-designs API gaf ${res.status}`);
  const json = await res.json();
  return json.items || [];
}
