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
// Merk-hashtags (altijd) + type-specifieke hashtags (per video-type). Geen # hier; dat zet
// hashline erop. Alles kleine letters, accenten mogen (YouTube accepteert ze).
const BASE_TAGS = {
  nl: ["zellige", "mozaïek", "handgemaakt", "taleoftiles"],
  en: ["zellige", "mosaic", "handmade", "taleoftiles"],
  fr: ["zellige", "mosaïque", "faitmain", "taleoftiles"],
};
const TYPE_TAGS = {
  satisfying: { nl: ["oddlysatisfying", "satisfying", "ambacht"], en: ["oddlysatisfying", "satisfying", "craft"], fr: ["satisfaisant", "oddlysatisfying", "artisanat"] },
  insitu:     { nl: ["naambord", "interieur", "wanddecoratie"], en: ["nameplate", "interior", "walldecor"], fr: ["plaque", "interieur", "decomurale"] },
  sfeer:      { nl: ["ambacht", "erfgoed", "atelier"], en: ["craft", "heritage", "workshop"], fr: ["artisanat", "patrimoine", "atelier"] },
  trio:       { nl: ["naambord", "ontwerp", "kleuren"], en: ["nameplate", "design", "colours"], fr: ["plaque", "design", "couleurs"] },
  colorway:   { nl: ["kleuren", "interieur", "ontwerp"], en: ["colours", "interior", "design"], fr: ["couleurs", "interieur", "design"] },
  geentwee:   { nl: ["uniek", "handwerk", "naambord"], en: ["unique", "handmade", "nameplate"], fr: ["unique", "faitmain", "plaque"] },
  walkthrough:{ nl: ["ontwerp", "configurator", "naambord"], en: ["design", "custom", "nameplate"], fr: ["design", "surmesure", "plaque"] },
  stopzodra:  { nl: ["raadspel", "satisfying", "mozaïek"], en: ["guessinggame", "satisfying", "mosaic"], fr: ["devinette", "satisfaisant", "mosaïque"] },
  onthul:     { nl: ["raadspel", "reveal", "mozaïek"], en: ["reveal", "guessinggame", "mosaic"], fr: ["reveal", "devinette", "mosaïque"] },
  cadeau:     { nl: ["cadeau", "housewarming", "persoonlijkcadeau"], en: ["gift", "housewarming", "giftidea"], fr: ["cadeau", "cremaillere", "ideecadeau"] },
  intro:      { nl: ["naambord", "ambacht", "interieur"], en: ["nameplate", "craft", "interior"], fr: ["plaque", "artisanat", "interieur"] },
};
// Titels per type (2 varianten, roulerend). Jouw merkstem; geen plaatsnaam in de titel.
const TITLES = {
  satisfying: { nl: ["Handgemaakt, steen voor steen", "Zie het ontstaan, stukje voor stukje"], en: ["Handmade, tile by tile", "Watch it take shape, piece by piece"], fr: ["Fait main, carreau par carreau", "Regardez-le prendre forme"] },
  insitu:     { nl: ["Jouw naam aan de muur", "Je naam verdient beter dan plastic"], en: ["Your name on the wall", "Your name deserves better than plastic"], fr: ["Votre nom au mur", "Votre nom mérite mieux que du plastique"] },
  sfeer:      { nl: ["Een eeuwenoud ambacht", "Weken werk in één paneel"], en: ["An age-old craft", "Weeks of work in one panel"], fr: ["Un art ancestral", "Des semaines de travail dans un panneau"] },
  trio:       { nl: ["Eén naam, drie stijlen", "Welke zou jij ophangen?"], en: ["One name, three styles", "Which would you hang?"], fr: ["Un nom, trois styles", "Lequel accrocheriez-vous ?"] },
  colorway:   { nl: ["Welke kleur past bij jou?", "Eén paneel, drie kleurwegen"], en: ["Which colour fits you?", "One panel, three colourways"], fr: ["Quelle couleur vous ressemble ?", "Un panneau, trois couleurs"] },
  geentwee:   { nl: ["Geen twee gelijk", "Eén naam, oneindig uniek"], en: ["No two alike", "One name, endlessly unique"], fr: ["Aucun identique", "Un nom, infiniment unique"] },
  walkthrough:{ nl: ["Ontwerp jouw paneel", "Zo maak je het zelf"], en: ["Design your panel", "Make it yourself"], fr: ["Composez votre panneau", "Créez le vôtre"] },
  stopzodra:  { nl: ["Stop zodra je het herkent", "Raad jij wat het is?"], en: ["Pause when you recognise it", "Can you guess what it is?"], fr: ["Arrête quand tu reconnais", "Devinez ce que c'est"] },
  onthul:     { nl: ["Raad wat eronder zit", "Herken jij het al?"], en: ["Guess what's underneath", "Can you tell yet?"], fr: ["Devinez ce qui se cache", "Reconnaissez-vous ?"] },
  cadeau:     { nl: ["Een cadeau dat blijft", "Geef iets dat niemand anders geeft"], en: ["A gift that lasts", "Give what no one else gives"], fr: ["Un cadeau qui dure", "Offrez ce que personne n'offre"] },
  intro:      { nl: ["Dit is Tale of Tiles", "Handgemaakte mozaïekkunst met jouw naam"], en: ["This is Tale of Tiles", "Handmade mosaic art with your name"], fr: ["Voici Tale of Tiles", "L'art mosaïque fait main, à votre nom"] },
};
// Beschrijvingen per type (2 varianten, roulerend). In jouw site-stem: ambacht laten voelen,
// "geen twee gelijk", zachte maar duidelijke CTA. Geen em-dash. {naam} wordt ingevuld of weg.
const DESCS = {
  satisfying: {
    nl: ["Honderden stukjes, met de hand gelegd, tot jouw naam er staat. Geen twee komen er identiek uit, en dat is precies de bedoeling.", "Tegel voor tegel, puur op gevoel. Zo groeit een handgemaakt naambord dat jaren meegaat."],
    en: ["Hundreds of pieces, laid by hand, until your name takes shape. No two come out identical, and that is exactly the point.", "Tile by tile, purely on feel. This is how a handmade nameplate that lasts for years takes shape."],
    fr: ["Des centaines de pièces posées à la main, jusqu'à ce que votre nom apparaisse. Aucune n'est identique, et c'est exactement le but.", "Carreau par carreau, au ressenti. Ainsi naît une plaque faite main qui dure des années."],
  },
  insitu: {
    nl: ["Geen plastic bordje, maar een handgemaakt paneel in echt glazuur. Aan je gevel, achter de balie of in de hal.", "Overal waar een naam ertoe doet, hoort er een die je met trots laat zien. Met de hand gelegd, in echt glazuur."],
    en: ["No plastic sign, but a handmade panel in real glaze. On your facade, behind the counter or in the hall.", "Anywhere a name matters, it deserves one you show with pride. Laid by hand, in real glaze."],
    fr: ["Pas une plaque en plastique, mais un panneau fait main en véritable émail. Sur votre façade, derrière le comptoir ou dans l'entrée.", "Partout où un nom compte, il en mérite un que l'on montre avec fierté. Posé à la main, en véritable émail."],
  },
  sfeer: {
    nl: ["Klei, zon, vuur en geduld. Elke tegel met de hand gesneden en geglazuurd, zoals het al eeuwen gaat. Haast bestaat hier niet.", "Weken werk zitten in één paneel. Dat is precies waarom er nergens een tweede bestaat dat op het jouwe lijkt."],
    en: ["Clay, sun, fire and patience. Every tile cut and glazed by hand, the way it has been done for ages. Haste does not exist here.", "Weeks of work go into a single panel. That is exactly why no other one like yours exists."],
    fr: ["Argile, soleil, feu et patience. Chaque carreau taillé et émaillé à la main, comme depuis des siècles. La hâte n'existe pas ici.", "Des semaines de travail dans un seul panneau. C'est pourquoi aucun autre ne ressemble au vôtre."],
  },
  trio: {
    nl: ["Dezelfde naam, drie keer anders. Welke zou jij aan je muur hangen? Zeg het in de comments.", "Eén naam, drie stijlen, met de hand gelegd. Jij kiest, wij maken."],
    en: ["Same name, three different looks. Which would you hang on your wall? Tell us in the comments.", "One name, three styles, laid by hand. You choose, we make it."],
    fr: ["Même nom, trois styles. Lequel accrocheriez-vous ? Dites-le en commentaire.", "Un nom, trois styles, posés à la main. Vous choisissez, nous réalisons."],
  },
  colorway: {
    nl: ["Eén paneel, drie kleurwegen. Welke past bij jouw huis? A, B of C?", "Zelfde patroon, andere kleuren. Zeg in de comments welke jij zou kiezen."],
    en: ["One panel, three colourways. Which fits your home? A, B or C?", "Same pattern, different colours. Tell us in the comments which one you'd pick."],
    fr: ["Un panneau, trois couleurs. Laquelle pour chez vous ? A, B ou C ?", "Même motif, autres couleurs. Dites en commentaire laquelle vous choisiriez."],
  },
  geentwee: {
    nl: ["Met de hand gemaakt, dus nooit twee gelijk. Net als jouw naam. Oneindig veel ontwerpen, één naam.", "Ander patroon, andere kleuren, dezelfde naam. Welke wordt die van jou?"],
    en: ["Made by hand, so never two alike. Just like your name. Endless designs, one name.", "New pattern, new colours, same name. Which one becomes yours?"],
    fr: ["Fait main, donc jamais deux pareils. Comme votre nom. Une infinité de designs, un nom.", "Nouveau motif, nouvelles couleurs, même nom. Lequel sera le vôtre ?"],
  },
  walkthrough: {
    nl: ["Jij doet het leuke deel, wij het handwerk. Kies je patroon, je kleuren en je naam. Ontwerp jouw paneel op taleoftiles.com.", "Typ je naam en zie je ontwerp verschijnen in glanzende tegel. Ontwerp die van jou op taleoftiles.com."],
    en: ["You do the fun part, we do the craft. Pick your pattern, your colours and your name. Design yours at taleoftiles.com.", "Type your name and watch your design appear in glossy tile. Design yours at taleoftiles.com."],
    fr: ["Vous faites la partie amusante, nous l'artisanat. Choisissez motif, couleurs et nom. Composez le vôtre sur taleoftiles.com.", "Tapez votre nom et voyez votre design apparaître en carreau brillant. Composez le vôtre sur taleoftiles.com."],
  },
  stopzodra: {
    nl: ["Extreem ingezoomd op het mozaïek. Stop zodra je herkent wat het is. Lukt het jou?", "Raad jij wat er ontstaat voordat het bord vol is? Zeg het in de comments."],
    en: ["Zoomed right into the mosaic. Pause the moment you recognise it. Can you?", "Can you guess what it is before the panel fills up? Tell us in the comments."],
    fr: ["Zoom extrême sur la mosaïque. Arrêtez dès que vous reconnaissez. Vous y arrivez ?", "Devinez ce qui apparaît avant que le panneau soit plein. Dites-le en commentaire."],
  },
  onthul: {
    nl: ["Onder het patroon zit een beeld verstopt. Herken jij het voordat het helemaal onthuld is?", "De tegels doven één voor één uit. Raad jij wat eronder zit?"],
    en: ["An image is hidden under the pattern. Can you recognise it before it is fully revealed?", "The tiles fade one by one. Can you guess what's underneath?"],
    fr: ["Une image se cache sous le motif. La reconnaissez-vous avant la fin ?", "Les carreaux s'effacent un à un. Devinez ce qui se cache dessous."],
  },
  cadeau: {
    nl: ["Wat geef je iemand die alles al heeft? Een handgemaakt naambord in echt glazuur, met hun naam. Een cadeau dat ze nooit meer weggeven.", "Geen bloemen die verwelken, maar kunst die blijft. Ontwerp een cadeau op taleoftiles.com."],
    en: ["What do you give someone who has everything? A handmade nameplate in real glaze, with their name. A gift they'll never give away.", "No flowers that wilt, but art that lasts. Design a gift at taleoftiles.com."],
    fr: ["Que offrir à qui a déjà tout ? Une plaque faite main en véritable émail, à leur nom. Un cadeau qu'on ne redonne jamais.", "Pas des fleurs qui fanent, mais de l'art qui dure. Composez un cadeau sur taleoftiles.com."],
  },
  intro: {
    nl: ["Handgemaakte mozaïekkunst met jouw naam, in echt glazuur. Jij kiest patroon, kleuren en naam, wij leggen het met de hand. Ontwerp jouw paneel op taleoftiles.com.", "Een eeuwenoud ambacht, nu met jouw naam aan de muur. Ontwerp die van jou op taleoftiles.com."],
    en: ["Handmade mosaic art with your name, in real glaze. You pick pattern, colours and name, we lay it by hand. Design yours at taleoftiles.com.", "An age-old craft, now with your name on the wall. Design yours at taleoftiles.com."],
    fr: ["De l'art mosaïque fait main, à votre nom, en véritable émail. Vous choisissez motif, couleurs et nom, nous posons à la main. Composez le vôtre sur taleoftiles.com.", "Un art ancestral, désormais avec votre nom au mur. Composez le vôtre sur taleoftiles.com."],
  },
};
// kleine deterministische keuze zodat per video een stabiele (maar verschillende) variant valt
function pick(arr, seed) { if (!arr || !arr.length) return ""; return arr[Math.abs(seed) % arr.length]; }
function seedOf(s) { let h = 0; s = String(s || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function suggest({ type, lang, name, seed } = {}) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  const t = TITLES[type] ? type : "satisfying";
  const sd = Number.isFinite(seed) ? seed : seedOf((type || "") + "|" + (name || "") + "|" + lg);
  // titel
  let title = pick((TITLES[t] && TITLES[t][lg]) || TITLES[t].nl, sd);
  if (name) title = `${name} · ${title}`;
  // beschrijving
  const body = pick((DESCS[t] && DESCS[t][lg]) || DESCS[t].nl, sd + 1);
  // hashtags: #Shorts + merk + type-specifiek (uniek gehouden)
  const brand = BASE_TAGS[lg] || BASE_TAGS.nl;
  const typed = (TYPE_TAGS[t] && TYPE_TAGS[t][lg]) || [];
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
