// SOCIAL-PLATFORM: Instagram (Reels). Deelt de Meta-auth (meta.mjs). Instagram vereist een
// PUBLIEKE video-URL (geen directe upload). De engine zet de mp4 daarom eerst op R2 via de ToT-worker
// en geeft de publieke taleoftiles.com-URL door. publicUrlFor(videoPath) regelt dat uploaden.
//
// Flow: POST /{ig_id}/media (media_type=REELS, video_url, caption) -> creation_id
//       status pollen tot FINISHED -> POST /{ig_id}/media_publish (creation_id) -> media id
import { spawn } from "node:child_process";
import { FFMPEG } from "../core/renderer.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// COVER-FRAME: de eerste frame van onze video's is een (bijna) leeg paneel, dus als cover lelijk.
// We lezen de duur met ffmpeg en laten Instagram een frame op ~90% pakken als cover (daar is het
// paneel altijd vol/af, ook bij herhalende patronen). Lukt het lezen niet -> geen offset (default).
function probeDurationMs(videoPath) {
  return new Promise((resolve) => {
    try {
      const ch = spawn(FFMPEG, ["-i", videoPath], { windowsHide: true });
      let err = "";
      ch.stderr.on("data", (d) => { err += d.toString(); });
      ch.on("close", () => {
        const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) resolve(Math.round(((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000));
        else resolve(0);
      });
      ch.on("error", () => resolve(0));
    } catch { resolve(0); }
  });
}

export function makeInstagram({ auth, suggest, publicUrlFor }) {
  return {
    id: "instagram", label: "Instagram", enabled: true, needsAuth: true,
    suggest,
    async authStatus(lang) { return auth.status(lang); },
    async startLogin(lang, log) { return auth.startLogin(lang, log); },
    async upload(videoPath, meta, lang, log = () => {}) {
      const tok = await auth.readToken(lang);
      if (!tok || !tok.page_token) throw new Error(`Instagram ${lang.toUpperCase()} niet gekoppeld`);
      if (!tok.ig_id) throw new Error(`geen Instagram-account aan de pagina (${lang.toUpperCase()}) gekoppeld`);
      if (tok.expires && tok.expires < Date.now()) throw new Error(`Instagram ${lang.toUpperCase()} token verlopen — opnieuw koppelen`);
      if (typeof publicUrlFor !== "function") throw new Error("Instagram heeft een publieke video-URL nodig (R2-hosting nog niet ingesteld)");
      // 1) video tijdelijk publiek maken (R2 via de worker). cleanup() wist 'm straks weer.
      log(`Instagram ${lang.toUpperCase()}: video tijdelijk uploaden…`);
      const hosted = await publicUrlFor(videoPath, lang);
      const videoUrl = hosted && (hosted.url || hosted);
      const cleanup = hosted && hosted.cleanup;
      if (!videoUrl) throw new Error("kon geen publieke video-URL maken");
      try {
        const caption = [meta.title, meta.description].filter(Boolean).join("\n\n");
        // cover-frame op ~90% (niet de lege begin-frame). thumb_offset in ms; 0/onbekend -> weglaten.
        const durMs = await probeDurationMs(videoPath);
        const thumbOffset = durMs > 0 ? Math.round(durMs * 0.9) : 0;
        if (thumbOffset > 0) log(`Instagram ${lang.toUpperCase()}: cover-frame op ${(thumbOffset / 1000).toFixed(1)}s`);
        // 2) media container maken
        const create = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption, ...(thumbOffset > 0 ? { thumb_offset: thumbOffset } : {}), access_token: tok.page_token }),
        })).json();
        if (!create.id) throw new Error("IG-container faalde: " + (create.error?.message || JSON.stringify(create)).slice(0, 300));
        // 3) status pollen (video verwerken kan even duren)
        log(`Instagram ${lang.toUpperCase()}: verwerken…`);
        let ready = false;
        for (let i = 0; i < 45; i++) {
          await sleep(4000);
          const st = await (await fetch(`${auth.GRAPH}/${create.id}?fields=status_code&access_token=${tok.page_token}`)).json();
          if (st.status_code === "FINISHED") { ready = true; break; }
          if (st.status_code === "ERROR") throw new Error("IG verwerking mislukt");
        }
        if (!ready) throw new Error("IG verwerking duurde te lang");
        // 4) publiceren
        const pub = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media_publish`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ creation_id: create.id, access_token: tok.page_token }),
        })).json();
        if (!pub.id) throw new Error("IG publiceren faalde: " + (pub.error?.message || JSON.stringify(pub)).slice(0, 300));
        return { postId: pub.id, url: `https://www.instagram.com/reel/${pub.id}` };
      } finally {
        // video weer van R2 verwijderen (gelukt of niet) — niks blijft staan
        if (typeof cleanup === "function") { try { await cleanup(); log(`Instagram ${lang.toUpperCase()}: tijdelijke video van R2 verwijderd`); } catch {} }
      }
    },
    // CARROUSEL (swipebare foto-post): meerdere STILSTAANDE beelden als één Instagram-post.
    // Flow (officieel, bevestigd okt 2026): per beeld een child-container (image_url +
    // is_carousel_item=true) -> een CAROUSEL-parent met children=[ids] -> media_publish.
    // imagePaths = lokale PNG/JPG-paden; elk wordt eerst publiek gemaakt via publicUrlFor (R2),
    // en na afloop weer opgeruimd. 2..10 beelden, zelfde verhouding.
    async uploadCarousel(imagePaths, meta, lang, log = () => {}) {
      const tok = await auth.readToken(lang);
      if (!tok || !tok.page_token) throw new Error(`Instagram ${lang.toUpperCase()} niet gekoppeld`);
      if (!tok.ig_id) throw new Error(`geen Instagram-account aan de pagina (${lang.toUpperCase()}) gekoppeld`);
      if (tok.expires && tok.expires < Date.now()) throw new Error(`Instagram ${lang.toUpperCase()} token verlopen — opnieuw koppelen`);
      if (typeof publicUrlFor !== "function") throw new Error("Instagram-carrousel heeft publieke beeld-URL's nodig (R2 niet ingesteld)");
      const paths = (imagePaths || []).filter(Boolean);
      if (paths.length < 2) throw new Error("carrousel heeft minstens 2 beelden nodig");
      if (paths.length > 10) throw new Error("carrousel mag hoogstens 10 beelden hebben");
      const caption = [meta.title, meta.description].filter(Boolean).join("\n\n");
      const cleanups = [];
      try {
        // 1) elk beeld publiek maken + een child-container aanmaken
        const childIds = [];
        for (let i = 0; i < paths.length; i++) {
          log(`Instagram ${lang.toUpperCase()}: carrousel-beeld ${i + 1}/${paths.length} uploaden…`);
          const hosted = await publicUrlFor(paths[i], lang);
          const imageUrl = hosted && (hosted.url || hosted);
          if (hosted && hosted.cleanup) cleanups.push(hosted.cleanup);
          if (!imageUrl) throw new Error("kon geen publieke beeld-URL maken");
          const child = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ image_url: imageUrl, is_carousel_item: true, access_token: tok.page_token }),
          })).json();
          if (!child.id) throw new Error("IG child-container faalde: " + (child.error?.message || JSON.stringify(child)).slice(0, 200));
          childIds.push(child.id);
        }
        // 2) parent CAROUSEL-container
        const parent = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ media_type: "CAROUSEL", children: childIds.join(","), caption, access_token: tok.page_token }),
        })).json();
        if (!parent.id) throw new Error("IG carrousel-container faalde: " + (parent.error?.message || JSON.stringify(parent)).slice(0, 200));
        // 3) verwerking afwachten (meestal snel voor foto's)
        log(`Instagram ${lang.toUpperCase()}: carrousel verwerken…`);
        for (let i = 0; i < 30; i++) {
          await sleep(2500);
          const st = await (await fetch(`${auth.GRAPH}/${parent.id}?fields=status_code&access_token=${tok.page_token}`)).json();
          if (st.status_code === "FINISHED") break;
          if (st.status_code === "ERROR") throw new Error("IG carrousel-verwerking mislukt");
        }
        // 4) publiceren
        const pub = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media_publish`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ creation_id: parent.id, access_token: tok.page_token }),
        })).json();
        if (!pub.id) throw new Error("IG carrousel publiceren faalde: " + (pub.error?.message || JSON.stringify(pub)).slice(0, 200));
        return { postId: pub.id, url: `https://www.instagram.com/p/${pub.id}` };
      } finally {
        // de tijdelijke R2-beelden pas NA het publiceren opruimen (IG heeft ze tot dan nodig)
        for (const c of cleanups) { try { await c(); } catch {} }
      }
    },
    async stats(postId, lang) {
      try {
        const tok = await auth.readToken(lang);
        if (!tok) return null;
        const r = await fetch(`${auth.GRAPH}/${postId}/insights?metric=plays,likes,comments&access_token=${tok.page_token}`);
        const j = await r.json();
        const m = {}; (j.data || []).forEach((d) => { m[d.name] = d.values && d.values[0] && d.values[0].value; });
        return { views: m.plays || 0, likes: m.likes || 0, comments: m.comments || 0 };
      } catch { return null; }
    },
  };
}
