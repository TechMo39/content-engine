// Tale of Tiles — content-engine config.
// Alle knoppen op een plek. Verander hier formaat, reveal-stijl, tempo, merk-copy.

export const config = {
  // ---- Bron van de ontwerpen -------------------------------------------------
  // Draait op Mo's laptop, dus taleoftiles.com is gewoon bereikbaar.
  apiUrl: process.env.TOT_API || "https://taleoftiles.com/api/showcase-designs",

  // De configurator wordt headless geladen om de ECHTE mozaiek-SVG te krijgen
  // (zelfde tiling/kleuren/voeg als de site). Default = live site.
  // Wil je tegen een lokale build testen: zet TOT_PAGE op je lokale URL.
  pageUrl: process.env.TOT_PAGE || "https://taleoftiles.com/",

  // Namen die de site aanlevert. Klopt er iets niet -> pas hier 1 regel aan,
  // niet de code in. (Aangeleverd door de website-chat.)
  applyFn: "mApplyFullDesign", // window-functie die een volledig ontwerp toepast
  stageSelector: "#mSvgStage", // element met de mozaiek-SVG erin
  // Element dat moet bestaan voordat we de SVG uitlezen (render klaar):
  readyProbe: "#mSvgStage svg, #mSvgStage path, #mSvgStage polygon",

  // ---- Video -----------------------------------------------------------------
  fps: 30,
  // 9:16 voor TikTok/Reels. Voor 1:1 -> {w:1080,h:1080}, 16:9 -> {w:1920,h:1080}.
  aspect: { w: 1080, h: 1920 },
  durationSec: 15,

  // ---- Branding (exact uit taleoftiles.com) ---------------------------------
  brandColors: {
    bg: "#1a1327", // diep plum (hero-achtergrond)
    bg2: "#241a3a", // iets warmer plum voor de radial
    gold: "#d6b35a", // goud (knop/accent)
    cream: "#f4ecdc", // crème (tekst)
    inkOnPlate: "#4a3a2a", // tekstkleur op de naamplaat
  },
  // Logo: de engine haalt dit bij het renderen op van je site (jouw laptop kan
  // erbij). Leeg laten of een lokaal pad (assets/logo.png) kan ook.
  logoUrl: "https://taleoftiles.com/logo.png",
  // "dark" = plum merk-achtergrond (aanbevolen, zoals de site). "light" = beige.
  theme: "dark",

  // ---- Reveal (de "satisfying" opbouw) --------------------------------------
  // Welke elementen zijn "steentjes". polygon+path dekt de meeste patronen.
  // Gebruikt een patroon <rect> voor vierkante tegels -> "polygon,path,rect".
  tileSelector: "polygon,path",
  // Het patroon staat meteen VOLLEDIG (nog neutraal/ongekleurd); daarna kleurt
  // elk steentje in. Volgorde = willekeurig (niet vanuit het midden).
  revealMode: "wave", // wave | random | radial | sweep-x | sweep-y | diagonal
  revealStartSec: 0.6, // eerste steentje kleurt in
  revealEndSec: 12.6, // laatste steentje kleurt in (inkleuren vult bijna de clip)
  popDurSec: 0.6, // hoe lang 1 steentje doet over inkleuren (bredere, zachtere golf-rand)

  // ---- Overlay / merk --------------------------------------------------------
  brand: "Tale of Tiles",
  site: "taleoftiles.com",
  // Royaltyvrije muziek: leg bestanden in deze map, dan kiest de engine er een.
  // Leeg => geen muziek (bewuste keuze: geen willekeurige muziek onder het merk).
  audioDir: "./assets/audio",
  logo: "", // optioneel pad naar een logo-png voor de CTA

  // ---- Output ----------------------------------------------------------------
  outDir: "./out",
};

// Merk-veilige captions per ontwerp (NL). Geen em-dashes, geen nep-urgentie,
// geen plaatsnaam/"Marokkaans". Pas vrij aan.
export function defaultCaptions(name) {
  const n = (name || "").trim();
  // De naam staat nu op de NAAMPLAAT op het paneel (zoals op de site), dus niet
  // meer als losse caption. Alleen de opbouw-regel vroeg in de clip.
  return [{ text: "Handgemaakt, steen voor steen", fromSec: 0.4, toSec: 5.0 }];
}
