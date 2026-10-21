// SOCIAL-PLATFORM: Facebook (pagina-video's). Deelt de Meta-auth (meta.mjs). Facebook accepteert
// een directe video-upload, dus geen publieke URL nodig. Post een mp4 als pagina-video met caption.
import fsp from "node:fs/promises";

// Auto-teksten lenen we van de YouTube-suggest (zelfde merkstem per type/taal).
export function makeFacebook({ auth, suggest }) {
  return {
    id: "facebook", label: "Facebook", enabled: true, needsAuth: true,
    suggest,
    async authStatus(lang) { return auth.status(lang); },
    async startLogin(lang, log) { return auth.startLogin(lang, log); },
    async upload(videoPath, meta, lang, log = () => {}) {
      const tok = await auth.readToken(lang);
      if (!tok || !tok.page_token) throw new Error(`Facebook ${lang.toUpperCase()} niet gekoppeld`);
      if (tok.expires && tok.expires < Date.now()) throw new Error(`Facebook ${lang.toUpperCase()} token verlopen — opnieuw koppelen`);
      const desc = [meta.title, meta.description].filter(Boolean).join("\n\n");
      log(`Facebook ${lang.toUpperCase()}: uploaden…`);
      const buf = await fsp.readFile(videoPath);
      // multipart met de video als 'source' + description + token
      const form = new FormData();
      form.append("description", desc);
      form.append("access_token", tok.page_token);
      form.append("source", new Blob([buf], { type: "video/mp4" }), "video.mp4");
      const r = await fetch(`${auth.GRAPH}/${tok.page_id}/videos`, { method: "POST", body: form });
      const j = await r.json();
      if (!r.ok || !j.id) throw new Error("FB-upload faalde: " + (j.error?.message || JSON.stringify(j)).slice(0, 300));
      return { postId: j.id, url: `https://www.facebook.com/${j.id}` };
    },
    async stats(postId, lang) {
      try {
        const tok = await auth.readToken(lang);
        if (!tok) return null;
        const r = await fetch(`${auth.GRAPH}/${postId}/video_insights?metric=total_video_views&access_token=${tok.page_token}`);
        const j = await r.json();
        const views = j.data && j.data[0] && j.data[0].values && j.data[0].values[0] && j.data[0].values[0].value;
        return { views: views || 0 };
      } catch { return null; }
    },
  };
}
