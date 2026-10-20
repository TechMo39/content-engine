// SOCIAL-KANAAL: YouTube (Shorts). Casco — de echte API-koppeling (OAuth, upload,
// analytics) komt in stap 2. Nu levert dit alleen de kanaal-vorm + auto-teksten, zodat
// de UI en de store al kloppen. upload() gooit bewust een nette fout tot de API er is.
//
// Vorm die ELK kanaal deelt (zodat een nieuw kanaal = één bestand erbij):
//   id, label, enabled, needsAuth
//   suggest({ type, lang, name })  -> { title, description, tags[] }   (auto-teksten)
//   async authStatus()             -> { connected, who }               (stap 2)
//   async upload(video, meta, log) -> { postId, url }                  (stap 2)
//   async stats(postId)            -> { views, ... }                   (stap 2)

// Hashtags per taal — kort, relevant, geen spam. Zelfde geest als de captions in de engine.
const TAGS = {
  nl: ["zellige", "mozaïek", "handgemaakt", "naambord", "ambacht", "interieur"],
  en: ["zellige", "mosaic", "handmade", "nameplate", "craft", "interior"],
  fr: ["zellige", "mosaïque", "faitmain", "artisanat", "deco", "interieur"],
};
// Per type een korte, merk-veilige openingszin (geen nep-urgentie, geen plaatsnaam).
const TITLE = {
  nl: {
    satisfying: "Handgemaakt mozaïek, steen voor steen",
    insitu: "Een handgemaakt naambord op je muur",
    sfeer: "Een eeuwenoud ambacht, met de hand",
    trio: "Eén naam, drie stijlen",
    colorway: "Welke kleur past bij jou?",
    geentwee: "Eén naam, oneindig uniek",
    walkthrough: "Ontwerp je eigen mozaïek-naambord",
    stopzodra: "Stop zodra je het herkent",
    onthul: "Raad wat eronder zit",
    cadeau: "Een cadeau dat een leven lang meegaat",
    intro: "Dit is Tale of Tiles",
  },
  en: {
    satisfying: "Handmade mosaic, tile by tile",
    insitu: "A handmade nameplate on your wall",
    sfeer: "An age-old craft, by hand",
    trio: "One name, three styles",
    colorway: "Which colour fits you?",
    geentwee: "One name, endlessly unique",
    walkthrough: "Design your own mosaic nameplate",
    stopzodra: "Pause when you recognise it",
    onthul: "Guess what's underneath",
    cadeau: "A gift that lasts a lifetime",
    intro: "This is Tale of Tiles",
  },
  fr: {
    satisfying: "Mosaïque faite main, carreau par carreau",
    insitu: "Une plaque faite main sur votre mur",
    sfeer: "Un art ancestral, à la main",
    trio: "Un nom, trois styles",
    colorway: "Quelle couleur vous ressemble ?",
    geentwee: "Un nom, infiniment unique",
    walkthrough: "Composez votre plaque en mosaïque",
    stopzodra: "Arrête quand tu reconnais",
    onthul: "Devinez ce qui se cache",
    cadeau: "Un cadeau qui dure toute une vie",
    intro: "Voici Tale of Tiles",
  },
};
const DESC = {
  nl: "Handgemaakte mozaïekkunst met jouw naam, in echt glazuur. Tale of Tiles — taleoftiles.com",
  en: "Handmade mosaic art with your name, in real glaze. Tale of Tiles — taleoftiles.com",
  fr: "De l'art mosaïque fait main, à votre nom, en véritable émail. Tale of Tiles — taleoftiles.com",
};

function suggest({ type, lang, name } = {}) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  let title = (TITLE[lg] && TITLE[lg][type]) || TITLE[lg].satisfying;
  if (name) title = `${name} — ${title}`;
  const tags = TAGS[lg].slice();
  const hashline = tags.map((t) => "#" + t.replace(/[^\p{L}\p{N}]/gu, "")).join(" ");
  const description = DESC[lg] + "\n\n" + hashline;
  return { title: title.slice(0, 100), description, tags };
}

export function makeChannel() {
  return {
    id: "youtube",
    label: "YouTube",
    enabled: true,          // casco: zichtbaar en actief in de UI; upload faalt nog tot stap 2
    needsAuth: true,
    suggest,
    async authStatus() { return { connected: false, who: "" }; },   // stap 2 vult dit
    async upload() { throw new Error("YouTube-koppeling nog niet ingesteld (stap 2: OAuth + upload)"); },
    async stats() { return null; },
  };
}
