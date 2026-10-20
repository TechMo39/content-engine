// SOCIAL-STORE: lokaal logboek van wat waarheen gepost is. Eén JSON-bestand in out/
// (.social.json), losgekoppeld van alles wat met het mail-contract te maken heeft.
// Een post hoort bij een ACCOUNT = platform + taal, dus de sleutel = "<video>|<platform>|<lang>".
// Bewaart status, post-id, url, teksten, tijd en laatste cijfers. In-memory cache + atomische
// schrijf (tmp -> rename) zodat een crash het bestand nooit half achterlaat.
import fs from "node:fs/promises";
import path from "node:path";

export function makeSocialStore(OUT) {
  const FILE = path.resolve(OUT, ".social.json");
  let data = null;        // { version, posts: { "<video>|<platform>|<lang>": record } }
  let writing = Promise.resolve();

  async function load() {
    if (data) return data;
    try { data = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { data = { version: 2, posts: {} }; }
    if (!data.posts) data.posts = {};
    return data;
  }
  async function persist() {
    const tmp = FILE + ".tmp";
    const body = JSON.stringify(data, null, 2);
    const run = async () => { await fs.writeFile(tmp, body); await fs.rename(tmp, FILE); };
    writing = writing.then(run, run);
    return writing;
  }
  const keyOf = (file, platform, lang) => `${file}|${platform}|${lang}`;
  const accId = (platform, lang) => `${platform}-${lang}`;

  async function all() { await load(); return Object.values(data.posts); }
  // Records per videobestand, als map { "<platform>-<lang>": record } (voor de UI per video).
  async function forFile(file) {
    await load();
    const out = {};
    for (const r of Object.values(data.posts)) if (r.file === file) out[accId(r.platform, r.lang)] = r;
    return out;
  }
  async function get(file, platform, lang) { await load(); return data.posts[keyOf(file, platform, lang)] || null; }

  async function set(file, platform, lang, patch) {
    await load();
    const k = keyOf(file, platform, lang);
    const prev = data.posts[k] || { file, platform, lang, status: "none", postId: "", url: "", title: "", description: "", tags: [], stats: null, at: 0, updated: 0 };
    data.posts[k] = { ...prev, ...patch, file, platform, lang, updated: Date.now() };
    await persist();
    return data.posts[k];
  }
  async function remove(file, platform, lang) {
    await load();
    delete data.posts[keyOf(file, platform, lang)];
    await persist();
  }

  return { load, all, forFile, get, set, remove };
}
