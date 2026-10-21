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
import http from "node:http";
import { spawn } from "node:child_process";

const GV = "v21.0";
const OAUTH_DIALOG = `https://www.facebook.com/${GV}/dialog/oauth`;
const GRAPH = `https://graph.facebook.com/${GV}`;
// Rechten die we nodig hebben: pagina's zien/beheren/posten + Instagram posten.
const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "business_management",
  "instagram_basic",
  "instagram_content_publish",
].join(",");

// Gedeelde Meta-auth (één per taal). Geeft helpers die zowel de IG- als FB-module gebruiken.
export function makeMetaAuth({ ROOT } = {}) {
  const SECRETS = ROOT ? path.resolve(ROOT, "secrets") : path.resolve("secrets");
  const tokenPath = (lang) => path.join(SECRETS, `meta-${lang}.json`);

  function creds() {
    const id = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
    if (!id || !secret) throw new Error("META_APP_ID/SECRET ontbreken in .env");
    return { id, secret };
  }
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

  // LOGIN: loopback-flow. Opent Facebook-consent, vangt ?code, ruilt om naar long-lived user-token,
  // haalt de pagina + page-token + IG-id op en bewaart alles. De engine kiest de pagina:
  // we nemen de pagina die aan de juiste taal hangt. Nu (1 pagina per taal) pakken we de eerste;
  // als er meer zijn kiest de gebruiker later. targetPage (optioneel) = exacte paginanaam.
  function startLogin(lang, log = () => {}, targetPage = "") {
    const { id, secret } = creds();
    return new Promise((resolve, reject) => {
      let settled = false, killer = null;
      const finish = (err, val) => { if (settled) return; settled = true; clearTimeout(killer); try { server.close(); } catch {} err ? reject(err) : resolve(val); };
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://127.0.0.1");
          if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404); res.end(); return; }
          if (u.searchParams.has("error")) { res.end("Geannuleerd. Sluit dit tabblad."); finish(new Error("login geannuleerd")); return; }
          const code = u.searchParams.get("code");
          const port = server.address().port;
          const redirect = `http://127.0.0.1:${port}/`;
          // 1) code -> short-lived user token
          const t1 = await (await fetch(`${GRAPH}/oauth/access_token?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(redirect)}&code=${encodeURIComponent(code)}`)).json();
          if (!t1.access_token) throw new Error("geen user-token: " + (t1.error?.message || JSON.stringify(t1)).slice(0, 200));
          // 2) short -> long-lived user token (~60d)
          const t2 = await (await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${id}&client_secret=${secret}&fb_exchange_token=${t1.access_token}`)).json();
          const userToken = t2.access_token || t1.access_token;
          const expiresMs = Date.now() + (t2.expires_in ? t2.expires_in * 1000 : 60 * 86400000);
          // 3) pagina's + page-token
          const pages = await (await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`)).json();
          const list = pages.data || [];
          if (!list.length) throw new Error("geen Facebook-pagina gevonden onder dit account (koppel eerst een pagina)");
          let page = targetPage ? list.find((p) => (p.name || "").toLowerCase() === targetPage.toLowerCase()) : null;
          if (!page) page = list[0];   // 1 pagina per taal: de eerste
          // 4) IG-business-id (kan ontbreken als IG niet aan de pagina hangt)
          let igId = page.instagram_business_account && page.instagram_business_account.id;
          if (!igId) {
            const ig = await (await fetch(`${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`)).json();
            igId = ig.instagram_business_account && ig.instagram_business_account.id;
          }
          await writeToken(lang, { page_id: page.id, page_name: page.name, page_token: page.access_token, ig_id: igId || "", expires: expiresMs, saved: Date.now() });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<body style="font-family:system-ui;background:#1a1327;color:#f4ecdc;text-align:center;padding-top:80px"><h2>Meta ${lang.toUpperCase()} gekoppeld ✓</h2><p>${page.name}${igId ? " + Instagram" : " (geen IG gevonden — koppel Instagram aan de pagina)"}</p><p>Je kunt dit tabblad sluiten.</p></body>`);
          log(`Meta ${lang.toUpperCase()} gekoppeld: ${page.name}${igId ? " + IG" : " (geen IG!)"}`);
          finish(null, { ok: true });
        } catch (e) { try { res.writeHead(500); res.end(String(e.message)); } catch {} finish(e); }
      });
      server.on("error", (e) => finish(e));
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const params = new URLSearchParams({ client_id: id, redirect_uri: `http://127.0.0.1:${port}/`, response_type: "code", scope: SCOPES });
        const url = `${OAUTH_DIALOG}?${params}`;
        log(`Meta ${lang.toUpperCase()}: open de browser om te koppelen…`);
        log(`Opent niet vanzelf? Open deze link: ${url}`);
        try {
          if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { stdio: "ignore", detached: true, windowsHide: true }).unref();
          else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
        } catch {}
      });
      killer = setTimeout(() => finish(new Error("koppelen verlopen (geen login binnen 5 min)")), 5 * 60 * 1000);
    });
  }

  return { readToken, writeToken, status, startLogin, GRAPH };
}
