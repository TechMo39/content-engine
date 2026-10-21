// SOCIAL-PLATFORM: TikTok (Content Posting API). Drie taal-accounts (NL/EN/FR), elk een eigen
// kanaal + eigen token. Kaal via fetch, geen SDK.
//
// OAuth: TikTok's authorize-pagina eist HTTPS als redirect (geen http://localhost zoals YouTube).
// Daarom loopt de koppeling via de WORKER-route /tiktok/callback op taleoftiles.com:
//   1) engine opent de TikTok-inlog-URL (met PKCE code_challenge + state)
//   2) gebruiker geeft toestemming
//   3) TikTok stuurt ?code&state naar https://taleoftiles.com/tiktok/callback
//   4) die worker-pagina POST de code naar onze eigen engine op http://localhost:4600/api/social/tiktok-cb
//      (de engine draait lokaal; de pagina doet een fetch naar localhost vanuit de browser van Mo)
//   5) engine wisselt de code -> access+refresh token, bewaart in secrets/tiktok-<lang>.json
// Als de worker de code niet kan doorsturen (browser blokkeert localhost), toont de pagina de code
// zodat Mo 'm kan plakken; startLogin pollt daarom OOK een lokaal bestandje/geheugen.
//
// Posten: Content Posting API, push_by_file (direct bestand, GEEN publieke URL / R2 nodig).
//   - init:    POST /v2/post/publish/video/init/   -> publish_id + upload_url
//   - upload:  PUT upload_url (de mp4-bytes, met Content-Range)
//   - status:  POST /v2/post/publish/status/fetch/ (pollen tot PUBLISH_COMPLETE)
// In de SANDBOX met Direct Post aan -> post_mode "DIRECT_POST" (meteen op het profiel van de
// testgebruiker). Zonder Direct-Post-recht valt 'ie terug op "MEDIA_UPLOAD" (concept/inbox).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

const AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN = "https://open.tiktokapis.com/v2/oauth/token/";
const API = "https://open.tiktokapis.com/v2";
// Redirect = onze worker-route (HTTPS, TikTok eist dat). De worker stuurt de code terug.
const REDIRECT = (process.env.TIKTOK_REDIRECT || "https://taleoftiles.com/tiktok/callback").replace(/\s+/g, "");
// Scopes die in de app aanstaan. video.publish = direct posten (sandbox/na audit), video.upload =
// concept. We vragen beide + user.info.basic; TikTok geeft wat is toegestaan.
const SCOPES = ["user.info.basic", "video.upload", "video.publish"].join(",");

// ---- auto-teksten lenen we van de gedeelde suggest (zelfde merkstem per type/taal) ----
// (wordt via index.mjs binnengegeven, net als instagram/facebook)

function b64url(buf) { return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function makePkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function makeTikTok({ ROOT, suggest } = {}) {
  const SECRETS = ROOT ? path.resolve(ROOT, "secrets") : path.resolve("secrets");
  const tokenPath = (lang) => path.join(SECRETS, `tiktok-${lang}.json`);
  // lopende login-flows: lang -> { verifier, state, resolve, reject, timer }
  const pending = {};

  function creds() {
    const key = process.env.TIKTOK_CLIENT_KEY, secret = process.env.TIKTOK_CLIENT_SECRET;
    if (!key || !secret) throw new Error("TIKTOK_CLIENT_KEY/SECRET ontbreken in .env");
    return { key, secret };
  }
  async function readToken(lang) { try { return JSON.parse(await fsp.readFile(tokenPath(lang), "utf8")); } catch { return null; } }
  async function writeToken(lang, data) { await fsp.mkdir(SECRETS, { recursive: true }); await fsp.writeFile(tokenPath(lang), JSON.stringify(data, null, 2)); }

  // Access-token vers houden: ververst met het refresh-token als 'ie (bijna) verlopen is.
  async function accessToken(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) throw new Error(`TikTok ${lang.toUpperCase()} niet gekoppeld`);
    // 2 min marge
    if (tok.access_token && tok.access_expires && tok.access_expires - Date.now() > 120000) return tok.access_token;
    const { key, secret } = creds();
    const body = new URLSearchParams({ client_key: key, client_secret: secret, grant_type: "refresh_token", refresh_token: tok.refresh_token });
    const r = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error("TikTok token verversen faalde: " + (j.error_description || j.error || JSON.stringify(j)).slice(0, 200));
    const next = {
      ...tok,
      access_token: j.access_token,
      access_expires: Date.now() + (j.expires_in || 86400) * 1000,
      refresh_token: j.refresh_token || tok.refresh_token,   // TikTok kan een nieuw refresh-token teruggeven
      refresh_expires: j.refresh_expires_in ? Date.now() + j.refresh_expires_in * 1000 : tok.refresh_expires,
      scope: j.scope || tok.scope,
      open_id: j.open_id || tok.open_id,
    };
    await writeToken(lang, next);
    return next.access_token;
  }

  // De engine roept dit aan als de worker de code heeft doorgestuurd (zie engine-route
  // /api/social/tiktok-cb). Wisselt code -> token, rondt de wachtende startLogin af.
  async function completeLogin(lang, code, state, log = () => {}) {
    const p = pending[lang];
    if (!p) throw new Error(`geen lopende TikTok-koppeling voor ${lang.toUpperCase()}`);
    if (state && p.state && state !== p.state) throw new Error("state klopt niet (beveiliging)");
    const { key, secret } = creds();
    const body = new URLSearchParams({
      client_key: key, client_secret: secret,
      code: decodeURIComponent(code), grant_type: "authorization_code",
      redirect_uri: REDIRECT, code_verifier: p.verifier,
    });
    const r = await fetch(TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    if (!r.ok || !j.access_token) {
      const msg = (j.error_description || j.error || JSON.stringify(j)).slice(0, 300);
      p.reject && p.reject(new Error("TikTok token faalde: " + msg));
      cleanupPending(lang);
      throw new Error("TikTok token faalde: " + msg);
    }
    await writeToken(lang, {
      access_token: j.access_token,
      access_expires: Date.now() + (j.expires_in || 86400) * 1000,
      refresh_token: j.refresh_token,
      refresh_expires: j.refresh_expires_in ? Date.now() + j.refresh_expires_in * 1000 : 0,
      scope: j.scope || "",
      open_id: j.open_id || "",
      saved: Date.now(),
    });
    log(`✓ TikTok ${lang.toUpperCase()} gekoppeld`);
    p.resolve && p.resolve({ ok: true });
    cleanupPending(lang);
    return { ok: true };
  }
  function cleanupPending(lang) { const p = pending[lang]; if (p && p.timer) clearTimeout(p.timer); delete pending[lang]; }

  // LOGIN: zet een PKCE-paar + state klaar, open de TikTok-inlog-URL in de browser. De flow rondt
  // af zodra de worker de code naar /api/social/tiktok-cb heeft gestuurd (-> completeLogin).
  function startLogin(lang, log = () => {}) {
    const { key } = creds();
    if (pending[lang]) throw new Error(`koppelen ${lang.toUpperCase()} loopt al — maak de TikTok-login in de browser af`);
    const { verifier, challenge } = makePkce();
    const state = b64url(crypto.randomBytes(16)) + "_" + lang;   // lang in de state zodat de worker 'm terugvindt
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanupPending(lang); reject(new Error("koppelen verlopen (geen login binnen 5 min)")); }, 5 * 60 * 1000);
      pending[lang] = { verifier, state, resolve, reject, timer };
      const params = new URLSearchParams({
        client_key: key, response_type: "code", scope: SCOPES,
        redirect_uri: REDIRECT, state,
        code_challenge: challenge, code_challenge_method: "S256",
      });
      const url = `${AUTH}?${params}`;
      log(`TikTok ${lang.toUpperCase()}: open de browser om te koppelen…`);
      log(`Opent niet vanzelf? Open deze link: ${url}`);
      try {
        if (process.platform === "win32") {
          spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { stdio: "ignore", detached: true, windowsHide: true }).unref();
        } else {
          spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
        }
      } catch {}
      // de belofte lost op via completeLogin() als de worker de code stuurt
    });
  }

  async function authStatus(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) return { connected: false, who: "" };
    // probeer de gebruikersnaam op te halen (bewijs dat het token werkt)
    try {
      const at = await accessToken(lang);
      const r = await fetch(`${API}/user/info/?fields=open_id,display_name`, { headers: { authorization: "Bearer " + at } });
      const j = await r.json();
      const name = j && j.data && j.data.user && j.data.user.display_name;
      return { connected: true, who: name || "" };
    } catch { return { connected: true, who: "" }; }
  }

  // UPLOAD: push_by_file. Probeer DIRECT_POST (sandbox/na audit); mag dat niet, val terug op
  // MEDIA_UPLOAD (concept in de TikTok-inbox). meta = {title, description, tags}.
  async function upload(videoPath, meta, lang, log = () => {}) {
    const at = await accessToken(lang);
    const stat = await fsp.stat(videoPath);
    const size = stat.size;
    // TikTok eist chunk-info; voor <=64MB mag het in één chunk.
    const CHUNK = size;
    const title = [meta.title, meta.description].filter(Boolean).join("\n\n").slice(0, 2200) || (meta.title || "Tale of Tiles");

    // Welke modus mag deze koppeling? Uit de scope in het token afleiden.
    const tok = await readToken(lang);
    const canDirect = (tok && tok.scope || "").includes("video.publish");
    const mode = canDirect ? "DIRECT_POST" : "MEDIA_UPLOAD";
    const initUrl = `${API}/post/publish/${canDirect ? "video/init" : "inbox/video/init"}/`;

    const postInfo = canDirect
      ? { title, privacy_level: "SELF_ONLY", disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 }
      : undefined;   // inbox-upload neemt geen post_info (gebruiker vult titel zelf in de app)
    const initBody = {
      ...(postInfo ? { post_info: postInfo } : {}),
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: CHUNK, total_chunk_count: 1 },
    };
    log(`TikTok ${lang.toUpperCase()}: ${canDirect ? "direct post (SELF_ONLY)" : "concept naar inbox"} — init (${Math.round(size / 1024)} KB)…`);
    const initRes = await fetch(initUrl, {
      method: "POST",
      headers: { authorization: "Bearer " + at, "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(initBody),
    });
    const initJson = await initRes.json();
    if (!initRes.ok || !initJson.data || !initJson.data.upload_url) {
      throw new Error("TikTok init faalde: " + (initJson.error && (initJson.error.message || initJson.error.code) || JSON.stringify(initJson)).toString().slice(0, 300));
    }
    const uploadUrl = initJson.data.upload_url;
    const publishId = initJson.data.publish_id;

    // bytes uploaden (één chunk)
    log(`TikTok ${lang.toUpperCase()}: uploaden…`);
    const buf = await fsp.readFile(videoPath);
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "video/mp4",
        "content-length": String(size),
        "content-range": `bytes 0-${size - 1}/${size}`,
      },
      body: buf,
    });
    if (!(put.status >= 200 && put.status < 300)) {
      throw new Error("TikTok upload faalde: HTTP " + put.status + " " + (await put.text()).slice(0, 200));
    }

    // status pollen tot klaar (of tot de inbox-draft klaarstaat)
    log(`TikTok ${lang.toUpperCase()}: verwerken…`);
    let finalStatus = "", publicUrl = "";
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await fetch(`${API}/post/publish/status/fetch/`, {
        method: "POST",
        headers: { authorization: "Bearer " + at, "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: publishId }),
      });
      const sj = await st.json();
      const s = sj && sj.data && sj.data.status;
      if (s === "PUBLISH_COMPLETE") { finalStatus = s; if (sj.data.publicaly_available_post_id && sj.data.publicaly_available_post_id[0]) publicUrl = ""; break; }
      if (s === "SEND_TO_USER_INBOX") { finalStatus = s; break; }   // concept staat klaar in de app
      if (s === "FAILED") throw new Error("TikTok verwerking mislukt: " + (sj.data && sj.data.fail_reason || "onbekend"));
    }
    if (!finalStatus) throw new Error("TikTok verwerking duurde te lang (nog bezig — check de TikTok-app)");

    const url = canDirect ? "https://www.tiktok.com/" + (tok.open_id ? "" : "") : "";
    const note = canDirect ? "geplaatst (privé/SELF_ONLY in sandbox)" : "concept klaargezet in je TikTok-inbox";
    log(`✓ TikTok ${lang.toUpperCase()}: ${note}`);
    return { postId: publishId, url, note };
  }

  async function stats(postId, lang) {
    // Organische per-video stats via API zijn beperkt; we geven null tenzij er iets betrouwbaars is.
    return null;
  }

  return {
    id: "tiktok", label: "TikTok", enabled: true, needsAuth: true,
    suggest, startLogin, authStatus, upload, stats,
    // intern, door de engine-route gebruikt:
    completeLogin,
  };
}
