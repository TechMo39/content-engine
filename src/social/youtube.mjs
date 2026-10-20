// SOCIAL-PLATFORM: YouTube (Shorts). Drie taal-accounts (NL/EN/FR), elk een eigen kanaal
// + eigen token. Kaal via fetch — geen googleapis-dependency (Node 22 heeft fetch/FormData).
//
// OAuth: "loopback" desktop-flow. De engine opent een tijdelijk servertje op een vrije poort,
// stuurt de gebruiker naar Google's consent, vangt de ?code op localhost op, wisselt 'm om
// voor een refresh-token en bewaart dat in secrets/yt-<taal>.json. Daarna nooit meer inloggen:
// het refresh-token levert on-the-fly een access-token.
//
// Upload: resumable upload (videos.insert) -> Short als de video 9:16 en <=3min is (YouTube
// merkt Shorts zelf; we hoeven alleen #Shorts in de titel/omschrijving niet eens). privacy
// "public" of "private" meegeven.
//
// Views: YouTube Analytics API (query) op het kanaal, per video.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
// Scopes: upload + eigen kanaal lezen + analytics lezen.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

// ---- auto-teksten (titel/omschrijving/tags) per type & taal ----
const TAGS = {
  nl: ["zellige", "mozaïek", "handgemaakt", "naambord", "ambacht", "interieur"],
  en: ["zellige", "mosaic", "handmade", "nameplate", "craft", "interior"],
  fr: ["zellige", "mosaïque", "faitmain", "artisanat", "deco", "interieur"],
};
const TITLE = {
  nl: { satisfying: "Handgemaakt mozaïek, steen voor steen", insitu: "Een handgemaakt naambord op je muur", sfeer: "Een eeuwenoud ambacht, met de hand", trio: "Eén naam, drie stijlen", colorway: "Welke kleur past bij jou?", geentwee: "Eén naam, oneindig uniek", walkthrough: "Ontwerp je eigen mozaïek-naambord", stopzodra: "Stop zodra je het herkent", onthul: "Raad wat eronder zit", cadeau: "Een cadeau dat een leven lang meegaat", intro: "Dit is Tale of Tiles" },
  en: { satisfying: "Handmade mosaic, tile by tile", insitu: "A handmade nameplate on your wall", sfeer: "An age-old craft, by hand", trio: "One name, three styles", colorway: "Which colour fits you?", geentwee: "One name, endlessly unique", walkthrough: "Design your own mosaic nameplate", stopzodra: "Pause when you recognise it", onthul: "Guess what's underneath", cadeau: "A gift that lasts a lifetime", intro: "This is Tale of Tiles" },
  fr: { satisfying: "Mosaïque faite main, carreau par carreau", insitu: "Une plaque faite main sur votre mur", sfeer: "Un art ancestral, à la main", trio: "Un nom, trois styles", colorway: "Quelle couleur vous ressemble ?", geentwee: "Un nom, infiniment unique", walkthrough: "Composez votre plaque en mosaïque", stopzodra: "Arrête quand tu reconnais", onthul: "Devinez ce qui se cache", cadeau: "Un cadeau qui dure toute une vie", intro: "Voici Tale of Tiles" },
};
const DESC = {
  nl: "Handgemaakte mozaïekkunst met jouw naam, in echt glazuur. Tale of Tiles — taleoftiles.com",
  en: "Handmade mosaic art with your name, in real glaze. Tale of Tiles — taleoftiles.com",
  fr: "De l'art mosaïque fait main, à votre nom, en véritable émail. Tale of Tiles — taleoftiles.com",
};
function suggest({ type, lang, name } = {}) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  let title = (TITLE[lg] && TITLE[lg][type]) || TITLE[lg].satisfying;
  if (name) title = `${name} — ${title}`;
  const tags = TAGS[lg].slice();
  const hashline = tags.map((t) => "#" + t.replace(/[^\p{L}\p{N}]/gu, "")).join(" ");
  // #Shorts helpt YouTube de video als Short te tonen
  const description = DESC[lg] + "\n\n#Shorts " + hashline;
  return { title: title.slice(0, 100), description, tags };
}

export function makePlatform({ ROOT } = {}) {
  const SECRETS = ROOT ? path.resolve(ROOT, "secrets") : path.resolve("secrets");
  const tokenPath = (lang) => path.join(SECRETS, `yt-${lang}.json`);

  function creds() {
    const id = process.env.YT_CLIENT_ID, secret = process.env.YT_CLIENT_SECRET;
    if (!id || !secret) throw new Error("YT_CLIENT_ID/SECRET ontbreken in .env");
    return { id, secret };
  }
  async function readToken(lang) {
    try { return JSON.parse(await fsp.readFile(tokenPath(lang), "utf8")); } catch { return null; }
  }
  async function writeToken(lang, data) {
    await fsp.mkdir(SECRETS, { recursive: true });
    await fsp.writeFile(tokenPath(lang), JSON.stringify(data, null, 2));
  }

  // Access-token halen uit het opgeslagen refresh-token (ververst vanzelf).
  async function accessToken(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) throw new Error(`YouTube ${lang.toUpperCase()} niet gekoppeld`);
    const { id, secret } = creds();
    const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" });
    const r = await fetch(TOKEN, { method: "POST", body });
    if (!r.ok) throw new Error("token verversen faalde: " + (await r.text()).slice(0, 200));
    const j = await r.json();
    return j.access_token;
  }

  // LOGIN per taal: open een loopback-servertje, stuur de gebruiker naar Google, vang de code,
  // ruil 'm voor een refresh-token, bewaar. De belofte lost op zodra de gebruiker klaar is.
  // De engine opent de browser; opent die niet, dan staat de link ook in het log.
  function startLogin(lang, log = () => {}) {
    const { id, secret } = creds();
    return new Promise((resolve, reject) => {
      let settled = false, killer = null;
      const finish = (err, val) => {
        if (settled) return; settled = true;
        clearTimeout(killer);
        try { server.close(); } catch {}
        err ? reject(err) : resolve(val);
      };
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://127.0.0.1");
          if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404); res.end(); return; }
          if (u.searchParams.has("error")) { res.end("Geannuleerd. Je kunt dit tabblad sluiten."); finish(new Error("login geannuleerd")); return; }
          const code = u.searchParams.get("code");
          const port = server.address().port;
          const body = new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: `http://127.0.0.1:${port}`, grant_type: "authorization_code" });
          const r = await fetch(TOKEN, { method: "POST", body });
          const j = await r.json();
          if (!r.ok || !j.refresh_token) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<h2>Koppelen mislukt</h2><p>" + (j.error_description || j.error || "geen refresh-token") + "</p><p>Sluit dit tabblad en probeer opnieuw.</p>");
            finish(new Error("geen refresh-token (al eens gekoppeld? trek toegang in bij Google en probeer opnieuw)")); return;
          }
          await writeToken(lang, { refresh_token: j.refresh_token, scope: j.scope, saved: Date.now() });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<body style="font-family:system-ui;background:#1a1327;color:#f4ecdc;text-align:center;padding-top:80px"><h2>YouTube ${lang.toUpperCase()} gekoppeld ✓</h2><p>Je kunt dit tabblad sluiten en terug naar de studio.</p></body>`);
          finish(null, { ok: true });
        } catch (e) { try { res.writeHead(500); res.end(String(e.message)); } catch {} finish(e); }
      });
      server.on("error", (e) => finish(e));
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const params = new URLSearchParams({ client_id: id, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent" });
        const url = `${AUTH}?${params}`;
        log(`YouTube ${lang.toUpperCase()}: open de browser om te koppelen…`);
        log(`Opent niet vanzelf? Open deze link: ${url}`);
        try {
          const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
          spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
        } catch {}
      });
      // veiligheidsklep: geen login binnen 5 min -> server sluiten, geen zombie-poort
      killer = setTimeout(() => finish(new Error("koppelen verlopen (geen login binnen 5 min)")), 5 * 60 * 1000);
    });
  }

  async function authStatus(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) return { connected: false, who: "" };
    // probeer de kanaalnaam op te halen (bewijs dat het token werkt)
    try {
      const at = await accessToken(lang);
      const r = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: "Bearer " + at } });
      const j = await r.json();
      const ch = j.items && j.items[0];
      return { connected: true, who: ch ? ch.snippet.title : "" };
    } catch { return { connected: true, who: "" }; }
  }

  // UPLOAD: resumable. video = absoluut pad, meta = {title, description, tags}, privacy default public.
  async function upload(videoPath, meta, lang, log = () => {}) {
    const at = await accessToken(lang);
    const stat = await fsp.stat(videoPath);
    const snippet = {
      snippet: { title: (meta.title || "Tale of Tiles").slice(0, 100), description: meta.description || "", tags: (meta.tags || []).slice(0, 15), categoryId: "22" },
      status: { privacyStatus: meta.privacy || "public", selfDeclaredMadeForKids: false },
    };
    // 1) sessie starten
    const init = await fetch(`${UPLOAD}?part=snippet,status&uploadType=resumable`, {
      method: "POST",
      headers: { authorization: "Bearer " + at, "content-type": "application/json", "x-upload-content-length": String(stat.size), "x-upload-content-type": "video/*" },
      body: JSON.stringify(snippet),
    });
    if (!init.ok) throw new Error("upload-sessie faalde: " + (await init.text()).slice(0, 300));
    const loc = init.headers.get("location");
    if (!loc) throw new Error("geen upload-URL van YouTube");
    // 2) de bytes sturen (in één PUT; de bestanden zijn klein genoeg)
    log(`YouTube ${lang.toUpperCase()}: uploaden (${Math.round(stat.size / 1024)} KB)…`);
    const buf = await fsp.readFile(videoPath);
    const put = await fetch(loc, { method: "PUT", headers: { "content-type": "video/*", "content-length": String(stat.size) }, body: buf });
    if (!put.ok) throw new Error("upload faalde: " + (await put.text()).slice(0, 300));
    const j = await put.json();
    return { postId: j.id, url: "https://youtu.be/" + j.id };
  }

  // VIEWS per video via Analytics API (kanaal = de ingelogde gebruiker).
  async function stats(postId, lang) {
    try {
      const at = await accessToken(lang);
      const end = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ ids: "channel==MINE", startDate: "2020-01-01", endDate: end, metrics: "views,likes,comments,estimatedMinutesWatched", filters: "video==" + postId });
      const r = await fetch(`${ANALYTICS}?${params}`, { headers: { authorization: "Bearer " + at } });
      if (!r.ok) return null;
      const j = await r.json();
      const row = j.rows && j.rows[0];
      if (!row) return { views: 0, likes: 0, comments: 0, minutes: 0 };
      return { views: row[0], likes: row[1], comments: row[2], minutes: row[3] };
    } catch { return null; }
  }

  return {
    id: "youtube", label: "YouTube", enabled: true, needsAuth: true,
    suggest, startLogin, authStatus, upload, stats,
  };
}
