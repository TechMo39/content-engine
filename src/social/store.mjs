// SOCIAL-STORE: lokaal logboek van wat waarheen gepost is. Eén JSON-bestand in out/
// (.social.json), losgekoppeld van alles wat met het mail-contract te maken heeft.
// Sleutel per record = "<videobestand>|<kanaal>". Bewaart status, post-id, url, teksten,
// tijd en laatste cijfers. In-memory cache + atomische schrijf (tmp -> rename) zodat een
// crash het bestand nooit half achterlaat.
import fs from "node:fs/promises";
import path from "node:path";

export function makeSocialStore(OUT) {
  const FILE = path.resolve(OUT, ".social.json");
  let data = null;        // { version, posts: { "<file>|<channel>": record } }
  let writing = Promise.resolve();

  async function load() {
    if (data) return data;
    try { data = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { data = { version: 1, posts: {} }; }
    if (!data.posts) data.posts = {};
    return data;
  }
  async function persist() {
    const tmp = FILE + ".tmp";
    const body = JSON.stringify(data, null, 2);
    writing = writing.then(async () => {
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, FILE);
    }, async () => { await fs.writeFile(tmp, body); await fs.rename(tmp, FILE); });
    return writing;
  }
  const keyOf = (file, channel) => `${file}|${channel}`;

  // Alle records als platte lijst (voor de UI).
  async function all() { await load(); return Object.values(data.posts); }
  // Records per videobestand, als map { channel: record } (voor de UI per video).
  async function forFile(file) {
    await load();
    const out = {};
    for (const r of Object.values(data.posts)) if (r.file === file) out[r.channel] = r;
    return out;
  }
  async function get(file, channel) { await load(); return data.posts[keyOf(file, channel)] || null; }

  // Maak/overschrijf een record met een nieuwe status. Merge: bestaande velden blijven staan.
  async function set(file, channel, patch) {
    await load();
    const k = keyOf(file, channel);
    const prev = data.posts[k] || { file, channel, status: "none", postId: "", url: "", title: "", description: "", tags: [], stats: null, at: 0, updated: 0 };
    data.posts[k] = { ...prev, ...patch, file, channel, updated: Date.now() };
    await persist();
    return data.posts[k];
  }
  async function remove(file, channel) {
    await load();
    delete data.posts[keyOf(file, channel)];
    await persist();
  }

  return { load, all, forFile, get, set, remove };
}
