// SOCIAL: Meta (Instagram + Facebook). Beide platforms hangen aan ÉÉN Facebook-login per taal,
// dus we delen hier de auth + token-opslag. Kaal via fetch, geen SDK.
//
// Koppelen (per taal, één keer):
//   1) Facebook-login (loopback desktop-flow) -> short-lived user-token
//   2) omruilen naar LONG-LIVED user-token (~60 dagen)
//   3) /me/accounts -> de Pagina + haar page-access-token (lang geldig zolang user-token geldig)
//   4) page -> instagram_business_account id
//   bewaren in secrets/meta-<lang>.json: { page_id, page_token, ig_id, expires, page_name }
//
// Posten:
//   Facebook: POST /{page_id}/videos met de mp4 als upload (source). Direct, geen publieke URL nodig.
//   Instagram: Reels vereisen een PUBLIEKE video-URL. De engine zet de mp4 op R2 (via de ToT-worker)
//     en geeft die URL door: POST /{ig_id}/media (media_type=REELS, video_url, caption) -> creation_id,
//     status pollen, dan POST /{ig_id}/media_publish. (publishVideoUrl levert de publieke URL.)
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const GV = "v21.0";
const GRAPH = `https://graph.facebook.com/${GV}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Rechten voor Instagram posten + de pagina-koppeling lezen. pages_manage_posts (FB-video
// posten) vraagt aparte/geavanceerde toegang en blokkeert anders de device-login, dus die
// laten we hier weg; Instagram werkt hiermee. FB-posten voegen we toe zodra die scope rond is.
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

// Gedeelde Meta-auth (één per taal). Geeft helpers die zowel de IG- als FB-module gebruiken.
export function makeMetaAuth({ ROOT } = {}) {
  const SECRETS = ROOT ? path.resolve(ROOT, "secrets") : path.resolve("secrets");
  const tokenPath = (lang) => path.join(SECRETS, `meta-${lang}.json`);

  function creds() {
    const id = process.env.META_APP_ID, secret = process.env.META_APP_SECRET, clientToken = process.env.META_CLIENT_TOKEN;
    if (!id || !secret) throw new Error("META_APP_ID/SECRET ontbreken in .env");
    return { id, secret, clientToken };
  }
  const inProgress = {};   // lang -> true, voorkomt dubbel pollen
  async function readToken(lang) { try { return JSON.parse(await fsp.readFile(tokenPath(lang), "utf8")); } catch { return null; } }
  async function writeToken(lang, data) { await fsp.mkdir(SECRETS, { recursive: true }); await fsp.writeFile(tokenPath(lang), JSON.stringify(data, null, 2)); }

  // Status voor de UI: gekoppeld? kanaalnaam? bijna verlopen? (Meta page-tokens ~60 dagen.)
  async function status(lang) {
    const t = await readToken(lang);
    if (!t || !t.page_token) return { connected: false, who: "" };
    const daysLeft = t.expires ? Math.round((t.expires - Date.now()) / 86400000) : null;
    const expiring = daysLeft != null && daysLeft <= 7;
    return { connected: true, who: t.page_name || "", igId: t.ig_id || "", pageId: t.page_id, daysLeft, expiring };
  }

  // Van user-token -> pagina + page-token + IG-id -> opslaan. Gedeeld door device-flow.
  async function finalizeFromUserToken(lang, userToken, longExpiresMs, log, targetPage = "") {
    const { id, secret } = creds();
    // user-token verlengen naar long-lived (~60d) als het nog kort is
    let token = userToken, expiresMs = longExpiresMs || (Date.now() + 60 * 86400000);
    try {
      const t2 = await (await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${userToken}`)).json();
      if (t2.access_token) { token = t2.access_token; if (t2.expires_in) expiresMs = Date.now() + t2.expires_in * 1000; }
    } catch {}
    const pages = await (await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${token}`)).json();
    const list = pages.data || [];
    if (!list.length) throw new Error("geen Facebook-pagina gevonden onder dit account");
    let page = targetPage ? list.find((p) => (p.name || "").toLowerCase() === targetPage.toLowerCase()) : null;
    if (!page) page = list[0];
    let igId = page.instagram_business_account && page.instagram_business_account.id;
    if (!igId) {
      const ig = await (await fetch(`${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`)).json();
      igId = ig.instagram_business_account && ig.instagram_business_account.id;
    }
    await writeToken(lang, { page_id: page.id, page_name: page.name, page_token: page.access_token, ig_id: igId || "", expires: expiresMs, saved: Date.now() });
    log(`✓ Meta ${lang.toUpperCase()} gekoppeld: ${page.name}${igId ? " + Instagram" : " (geen IG aan de pagina!)"}`);
    return { page_name: page.name, ig: !!igId };
  }

  // LOGIN via "Facebook Login for Devices": geen redirect-URL / https nodig (werkt voor een lokale
  // desktop-app). Vraagt een code, toont die, de gebruiker voert 'm in op facebook.com/device,
  // en de engine pollt tot het token binnen is. Geeft {user_code, verification_uri} direct terug;
  // het ophalen van het token gebeurt daarna op de achtergrond (status springt op connected).
  async function startLogin(lang, log = () => {}) {
    const { id, secret, clientToken } = creds();
    if (inProgress[lang]) throw new Error(`koppelen ${lang.toUpperCase()} loopt al — voer de code in op facebook.com/device`);
    // App-access-token voor device-login: client token als die er is, anders app_id|app_secret
    // (beide zijn geldige app-tokens; zo is geen aparte client token nodig).
    const appToken = clientToken ? `${id}|${clientToken}` : `${id}|${secret}`;
    const init = await (await fetch(`${GRAPH}/device/login`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: appToken, scope: SCOPES }),
    })).json();
    if (!init.code || !init.user_code) throw new Error("device-login faalde: " + (init.error?.message || JSON.stringify(init)).slice(0, 200) + " (staat 'Login from Devices' aan?)");
    const verifyUrl = init.verification_uri || "https://www.facebook.com/device";
    const interval = Math.max(5, init.interval || 5);
    const expiresAt = Date.now() + (init.expires_in || 420) * 1000;
    log(`Meta ${lang.toUpperCase()}: ga naar ${verifyUrl} en voer de code in: ${init.user_code}`);
    // browser openen op de device-pagina met de code voorgevuld
    try {
      const u = `https://www.facebook.com/device?user_code=${init.user_code}`;
      if (process.platform === "win32") spawn("cmd", ["/c", "start", "", u.replace(/&/g, "^&")], { stdio: "ignore", detached: true, windowsHide: true }).unref();
      else spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { stdio: "ignore", detached: true }).unref();
    } catch {}
    // achtergrond-poll
    inProgress[lang] = true;
    (async () => {
      try {
        while (Date.now() < expiresAt) {
          await sleep(interval * 1000);
          const st = await (await fetch(`${GRAPH}/device/login_status`, {
            method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ access_token: appToken, code: init.code }),
          })).json();
          if (st.access_token) { await finalizeFromUserToken(lang, st.access_token, st.expires_in ? Date.now() + st.expires_in * 1000 : 0, log); break; }
          const sub = st.error && st.error.error_subcode;
          if (sub === 1349174) continue;              // nog niet bevestigd
          if (sub === 1349172) { await sleep(interval * 1000); continue; }  // te snel
          if (sub === 1349152) { log(`✗ Meta ${lang.toUpperCase()}: code verlopen, probeer opnieuw`); break; }
          // andere fout -> stoppen
          if (st.error) { log(`✗ Meta ${lang.toUpperCase()}: ${st.error.message || "login mislukt"}`); break; }
        }
      } catch (e) { log(`✗ Meta ${lang.toUpperCase()}: ${e.message}`); }
      finally { delete inProgress[lang]; }
    })();
    return { ok: true, pending: true, userCode: init.user_code, verifyUrl };
  }

  return { readToken, writeToken, status, startLogin, GRAPH };
}
