// SOCIAL-PLATFORM: YouTube (Shorts). Drie taal-accounts (NL/EN/FR), elk een eigen kanaal
// + eigen token. Kaal via fetch, geen googleapis-dependency (Node 22 heeft fetch/FormData).
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
// De tekst-POOLS (titels, omschrijvingen, hashtag-pools per type) staan in post-texts.mjs,
// bewust langs verschillende hoeken (herkomst/maalem/oud-modern/anti-plastic/cadeau/bedrijf/
// garantie/materiaal/zintuiglijk). Hier alleen de vaste merk-tags + de keuze-logica.
import { TITLES, DESCS, TYPE_TAG_POOL } from "./post-texts.mjs";

// Merk-hashtags (altijd mee, voor herkenning). Geen # hier; dat zet hashline erop.
const BASE_TAGS = {
  nl: ["zellige", "mozaïek", "handgemaakt", "taleoftiles"],
  en: ["zellige", "mosaic", "handmade", "taleoftiles"],
  fr: ["zellige", "mosaïque", "faitmain", "taleoftiles"],
};
// kleine deterministische keuze zodat per video een stabiele (maar verschillende) variant valt
function pick(arr, seed) { if (!arr || !arr.length) return ""; return arr[Math.abs(seed) % arr.length]; }
function seedOf(s) { let h = 0; s = String(s || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Normaliseren om een eerder gebruikte tekst te herkennen (naam-prefix + hoofdletters/spaties
// weg), zodat "Noor · Geen twee gelijk" matcht met de variant "Geen twee gelijk".
function norm(s) { return String(s || "").toLowerCase().replace(/^.*?·\s*/, "").replace(/\s+/g, " ").trim(); }

// Kies uit arr de EERSTE variant die nog niet in `used` zit; zijn ze allemaal gebruikt, val dan
// terug op de minst recent gebruikte (die het verst achteraan in `used` staat), met de seed als
// tie-breaker. Zo wisselt elke nieuwe post af met wat er al staat, in plaats van te herhalen.
function pickFresh(arr, used, seed) {
  if (!arr || !arr.length) return "";
  const usedNorm = (used || []).map(norm);
  const fresh = arr.filter((x) => !usedNorm.includes(norm(x)));
  if (fresh.length) return fresh[Math.abs(seed) % fresh.length];
  // alles al eens gebruikt: neem degene wiens recentste gebruik het LANGST geleden is.
  // used staat nieuwste-eerst, dus indexOf(norm(x)) = hoe recent (0 = net gebruikt); de variant
  // met de HOOGSTE "hoe lang geleden" wint, zodat we door de hele lijst blijven rouleren.
  let best = arr[0], bestAge = -1;
  for (const x of arr) {
    const age = usedNorm.indexOf(norm(x));       // 0 = meest recent, groter = langer geleden
    if (age > bestAge) { bestAge = age; best = x; }
  }
  return best;
}

// Kies `count` tags uit de pool, startend op een seed-afhankelijk punt en roterend door de lijst.
// Opeenvolgende posts (andere seed) beginnen op een ander punt -> wisselende hashtag-selectie,
// terwijl elke selectie zelf uniek blijft (geen dubbele tags binnen één post).
function pickTags(pool, seed, count) {
  if (!pool || !pool.length) return [];
  const n = Math.min(count, pool.length);
  const start = Math.abs(seed) % pool.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

// suggest: stelt titel/omschrijving/hashtags voor voor één video.
// `recent` (optioneel) = { titles:[...], descs:[...] } met de teksten die al voor dit type+taal
// gepost zijn (nieuwste eerst). Daarmee vermijdt suggest herhaling en wordt het opbouwend.
export function suggest({ type, lang, name, seed, recent } = {}) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  const t = TITLES[type] ? type : "satisfying";
  const sd = Number.isFinite(seed) ? seed : seedOf((type || "") + "|" + (name || "") + "|" + lg);
  const usedTitles = (recent && recent.titles) || [];
  const usedDescs = (recent && recent.descs) || [];
  // titel: kies een die nog niet gebruikt is voor dit type+taal
  let title = pickFresh((TITLES[t] && TITLES[t][lg]) || TITLES[t].nl, usedTitles, sd);
  if (name) title = `${name} · ${title}`;
  // beschrijving: idem, los van de titel-keuze
  const body = pickFresh((DESCS[t] && DESCS[t][lg]) || DESCS[t].nl, usedDescs, sd + 1);
  // hashtags: #Shorts + vaste merk-tags + een WISSELENDE greep uit de type-pool, zodat de
  // hashtags per post verschillen i.p.v. elke keer dezelfde drie. De greep rouleert met de seed
  // (een ander startpunt in de pool per video) en varieert ook licht in aantal (3 of 4).
  const brand = BASE_TAGS[lg] || BASE_TAGS.nl;
  const pool = (TYPE_TAG_POOL[t] && TYPE_TAG_POOL[t][lg]) || [];
  // De greep SCHUIFT op met het aantal al-geposte video's van dit type+taal (uit recent), zodat
  // opeenvolgende posts telkens verderop in de pool beginnen -> echt wisselende hashtags. Zonder
  // recent valt het terug op de seed. Een priemstap (×5) voorkomt dat het aantal en de poollengte
  // in hetzelfde ritme lopen (anders zou je steeds dezelfde subset zien).
  const postCount = usedTitles.length;
  const tagOffset = (recent ? postCount * 5 : Math.abs(sd)) + 2;
  const typed = pickTags(pool, tagOffset, 3 + (postCount % 2));   // 3 of 4 type-tags, wisselend
  const all = [...new Set([...brand, ...typed])];
  const hashline = "#Shorts " + all.map((x) => "#" + x.replace(/[^\p{L}\p{N}]/gu, "")).join(" ");
  const description = body + "\n\n" + hashline;
  return { title: title.slice(0, 100), description, tags: all };
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
        // Browser openen met de VOLLEDIGE url. `cmd /c start` opent de browser (zoals eerst),
        // maar cmd ziet de &-tekens als commando-scheiders en kapt de url af (-> response_type
        // viel weg). Fix: de & voor cmd escapen als ^& zodat de hele url doorkomt.
        try {
          if (process.platform === "win32") {
            const cmdUrl = url.replace(/&/g, "^&");
            spawn("cmd", ["/c", "start", "", cmdUrl], { stdio: "ignore", detached: true, windowsHide: true }).unref();
          } else {
            const bin = process.platform === "darwin" ? "open" : "xdg-open";
            spawn(bin, [url], { stdio: "ignore", detached: true }).unref();
          }
        } catch {}
      });
      // veiligheidsklep: geen login binnen 5 min -> server sluiten, geen zombie-poort
      killer = setTimeout(() => finish(new Error("koppelen verlopen (geen login binnen 5 min)")), 5 * 60 * 1000);
    });
  }

  async function authStatus(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) return { connected: false, who: "" };
    // EERLIJKE STATUS: een refresh-token kan DOOD zijn (verlopen/ingetrokken -> invalid_grant).
    // Dan moet de UI "niet gekoppeld" tonen zodat de Koppel-knop terugkomt, i.p.v. vals groen
    // "gekoppeld" (dan kon je niet opnieuw koppelen zonder het secrets-bestand te wissen).
    // We bewijzen dat het token WERKT door een access-token te halen; lukt dat niet -> niet gekoppeld.
    let at;
    try { at = await accessToken(lang); }
    catch { return { connected: false, who: "", expired: true }; }   // token dood -> toon als los te koppelen
    // token werkt; de kanaalnaam ophalen is mooi-meegenomen, maar een mislukte naam-ophaal mag de
    // status niet op dood zetten (het token is immers wél geldig).
    try {
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

