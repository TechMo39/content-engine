// SOCIAL-PLATFORM: Instagram (Reels). Deelt de Meta-auth (meta.mjs). Instagram vereist een
// PUBLIEKE video-URL (geen directe upload). De engine zet de mp4 daarom eerst op R2 via de ToT-worker
// en geeft de publieke taleoftiles.com-URL door. publicUrlFor(videoPath) regelt dat uploaden.
//
// Flow: POST /{ig_id}/media (media_type=REELS, video_url, caption) -> creation_id
//       status pollen tot FINISHED -> POST /{ig_id}/media_publish (creation_id) -> media id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // 1) video publiek maken (R2)
      log(`Instagram ${lang.toUpperCase()}: video publiceren naar R2…`);
      const videoUrl = await publicUrlFor(videoPath, lang);
      if (!videoUrl) throw new Error("kon geen publieke video-URL maken");
      const caption = [meta.title, meta.description].filter(Boolean).join("\n\n");
      // 2) media container maken
      const create = await (await fetch(`${auth.GRAPH}/${tok.ig_id}/media`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ media_type: "REELS", video_url: videoUrl, caption, access_token: tok.page_token }),
      })).json();
      if (!create.id) throw new Error("IG-container faalde: " + (create.error?.message || JSON.stringify(create)).slice(0, 300));
      // 3) status pollen (video verwerken kan even duren)
      log(`Instagram ${lang.toUpperCase()}: verwerken…`);
      let ready = false;
      for (let i = 0; i < 30; i++) {
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
