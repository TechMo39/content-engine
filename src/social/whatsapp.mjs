// SOCIAL-PLATFORM: WhatsApp. Er is GEEN officiele API om naar WhatsApp Kanalen/Status te posten
// (alleen onofficiele third-party diensten, met ban-risico). Daarom is WhatsApp geen auto-post-
// kanaal maar een HANDMATIGE EXPORT: de engine zet de video + caption klaar in een map, en Mo
// post die zelf in de WhatsApp-app. Zelfde vorm als een echt platform, maar needsAuth:false ->
// de UI toont geen "Koppel"-knop en het kanaal geldt meteen als klaar.
import fs from "node:fs/promises";
import path from "node:path";

export function makeWhatsApp({ suggest } = {}) {
  // type uit de videonaam halen (taleoftiles-<type>-<datum>-...mp4), voor een nette fallback-caption.
  const typeOf = (file) => {
    const base = path.basename(file || "").replace(/\.[^.]+$/, "");
    const parts = base.split("-");
    return parts.length > 1 ? parts[1] : "";
  };

  return {
    id: "whatsapp",
    label: "WhatsApp",
    enabled: true,
    needsAuth: false,
    suggest,

    // Geen login nodig: de export-map is altijd "verbonden".
    async authStatus(lang) {
      return { connected: true, who: "export-map" };
    },

    // Niet via API posten: kopieer de mp4 naar out/whatsapp/<lang>/ en schrijf de caption ernaast
    // in een .txt met dezelfde basename. Mo post het daarna handmatig in WhatsApp.
    async upload(videoPath, meta = {}, lang, log) {
      const lg = ["en", "fr"].includes(lang) ? lang : "nl";
      const out = path.dirname(videoPath);                 // render-outputmap (OUT)
      const dir = path.join(out, "whatsapp", lg);
      await fs.mkdir(dir, { recursive: true });

      const baseName = path.basename(videoPath);
      const stem = baseName.replace(/\.[^.]+$/, "");
      const destVideo = path.join(dir, baseName);
      const destText = path.join(dir, stem + ".txt");

      // video kopieren (overschrijft een eerdere export van dezelfde video)
      await fs.copyFile(videoPath, destVideo);

      // caption: meta.description, anders een suggest-tekst voor deze taal/type, anders merk-regel.
      let caption = (meta && typeof meta.description === "string") ? meta.description.trim() : "";
      if (!caption && typeof suggest === "function") {
        try { caption = (suggest({ type: typeOf(videoPath), lang: lg }) || {}).description || ""; } catch {}
        caption = (caption || "").trim();
      }
      if (!caption) caption = "Tale of Tiles, handgemaakte mozaiekkunst. taleoftiles.com";
      await fs.writeFile(destText, caption + "\n", "utf8");

      if (typeof log === "function") log("WhatsApp " + lg.toUpperCase() + ": klaargezet in " + dir + " (video + caption .txt). Handmatig posten in WhatsApp.");
      return { url: dir, postId: "" };
    },

    async stats(postId, lang) {
      return null;
    },
  };
}
