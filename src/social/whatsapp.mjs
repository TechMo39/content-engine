// SOCIAL-PLATFORM: WhatsApp. Er is GEEN officiele API om naar WhatsApp Kanalen/Status te posten
// (alleen onofficiele third-party diensten, met ban-risico). Daarom is WhatsApp geen auto-post-
// kanaal maar een HANDMATIGE EXPORT VIA INTERNET: de engine zet de video op R2 (publieke /img/-URL,
// zelfde route die de worker al serveert) en geeft die URL + caption terug. De Socials-tab toont
// er een QR + link bij. Mo scant de QR met z'n telefoon -> video opent -> downloaden -> zelf in
// WhatsApp posten. needsAuth:false -> geen "Koppel"-knop, het kanaal geldt meteen als klaar.
import fs from "node:fs/promises";
import path from "node:path";

export function makeWhatsApp({ suggest, r2Put, imgBase } = {}) {
  const BASE = (imgBase || "https://taleoftiles.com/img").replace(/\/$/, "");
  // type uit de videonaam halen (taleoftiles-<type>-<datum>-...mp4), voor een nette fallback-caption.
  const typeOf = (file) => {
    const base = path.basename(file || "").replace(/\.[^.]+$/, "");
    const parts = base.split("-");
    return parts.length > 1 ? parts[1] : "";
  };
  // R2-sleutel = stabiel per bestand+taal, zodat dezelfde video dezelfde URL houdt (opnieuw
  // "exporteren" overschrijft gewoon) en de map niet volloopt met duplicaten.
  const keyFor = (file, lang) => `whatsapp/${lang}/${path.basename(file)}`;

  return {
    id: "whatsapp",
    label: "WhatsApp",
    enabled: true,
    needsAuth: false,
    suggest,

    // Geen login nodig: de export is altijd "verbonden".
    async authStatus(lang) {
      return { connected: true, who: "export via link" };
    },

    // EXPORT: zet de mp4 op R2 (publieke /img/-URL) en geef die + de caption terug. Geen
    // auto-post; de Socials-tab toont er een QR/link bij. meta = {title, description, tags}.
    async upload(videoPath, meta = {}, lang, log) {
      const lg = ["en", "fr"].includes(lang) ? lang : "nl";
      if (typeof r2Put !== "function") throw new Error("WhatsApp-export heeft R2 nodig (UPLOAD_KEY in .env + worker-route)");

      const key = keyFor(videoPath, lg);
      const buf = await fs.readFile(videoPath);
      await r2Put(key, buf, "video/mp4");
      const url = `${BASE}/${key}`;

      // caption: meta.description, anders een suggest-tekst voor deze taal/type, anders merk-regel.
      let caption = (meta && typeof meta.description === "string") ? meta.description.trim() : "";
      if (!caption && typeof suggest === "function") {
        try { caption = (suggest({ type: typeOf(videoPath), lang: lg }) || {}).description || ""; } catch {}
        caption = (caption || "").trim();
      }
      if (!caption) caption = "Tale of Tiles, handgemaakte mozaiekkunst. taleoftiles.com";

      if (typeof log === "function") log("WhatsApp " + lg.toUpperCase() + ": op R2 gezet -> " + url + " (scan de QR in de Socials-tab, download op je telefoon, post zelf in WhatsApp).");
      // whatsapp:true zodat de UI weet dat dit geen echte post is maar een export (QR tonen).
      return { url, postId: key, whatsapp: true, caption };
    },

    async stats(postId, lang) {
      return null;
    },
  };
}
