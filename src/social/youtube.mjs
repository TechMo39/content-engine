// SOCIAL-PLATFORM: YouTube (Shorts). Drie taal-accounts (NL/EN/FR), elk een eigen kanaal
// + eigen token. Kaal via fetch, geen googleapis-dependency (Node 22 heeft fetch/FormData).
//
// OAuth: "loopback" desktop-flow. De engine opent een tijdelijk servertje op een vrije poort,
// stuurt de gebruiker naar Google's consent, vangt de ?code op localhost op, wisselt 'm om
// voor een refresh-token en bewaart dat in secrets/yt-<taal>.json. Daarna nooit meer inloggen:
// het refresh-token levert on-the-fly een access-token.
//
// Upload: resumable upload (videos.insert) -> Short als de video 9:16 en <=3min is (YouTube
// merkt Shorts zelf; we hoeven alleen #Shorts in de titel/omschrijving niet eens). privacy
// "public" of "private" meegeven.
//
// Views: YouTube Analytics API (query) op het kanaal, per video.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
// Scopes: upload + eigen kanaal lezen + analytics lezen.
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");

// ---- auto-teksten (titel/omschrijving/tags) per type & taal ----
// Merk-hashtags (altijd) + type-specifieke hashtags (per video-type). Geen # hier; dat zet
// hashline erop. Alles kleine letters, accenten mogen (YouTube accepteert ze).
const BASE_TAGS = {
  nl: ["zellige", "mozaïek", "handgemaakt", "taleoftiles"],
  en: ["zellige", "mosaic", "handmade", "taleoftiles"],
  fr: ["zellige", "mosaïque", "faitmain", "taleoftiles"],
};
const TYPE_TAGS = {
  satisfying: { nl: ["oddlysatisfying", "satisfying", "ambacht"], en: ["oddlysatisfying", "satisfying", "craft"], fr: ["satisfaisant", "oddlysatisfying", "artisanat"] },
  insitu:     { nl: ["naambord", "interieur", "wanddecoratie"], en: ["nameplate", "interior", "walldecor"], fr: ["plaque", "interieur", "decomurale"] },
  sfeer:      { nl: ["ambacht", "erfgoed", "atelier"], en: ["craft", "heritage", "workshop"], fr: ["artisanat", "patrimoine", "atelier"] },
  trio:       { nl: ["naambord", "ontwerp", "kleuren"], en: ["nameplate", "design", "colours"], fr: ["plaque", "design", "couleurs"] },
  colorway:   { nl: ["kleuren", "interieur", "ontwerp"], en: ["colours", "interior", "design"], fr: ["couleurs", "interieur", "design"] },
  geentwee:   { nl: ["uniek", "handwerk", "naambord"], en: ["unique", "handmade", "nameplate"], fr: ["unique", "faitmain", "plaque"] },
  walkthrough:{ nl: ["ontwerp", "configurator", "naambord"], en: ["design", "custom", "nameplate"], fr: ["design", "surmesure", "plaque"] },
  stopzodra:  { nl: ["raadspel", "satisfying", "mozaïek"], en: ["guessinggame", "satisfying", "mosaic"], fr: ["devinette", "satisfaisant", "mosaïque"] },
  onthul:     { nl: ["raadspel", "reveal", "mozaïek"], en: ["reveal", "guessinggame", "mosaic"], fr: ["reveal", "devinette", "mosaïque"] },
  cadeau:     { nl: ["cadeau", "housewarming", "persoonlijkcadeau"], en: ["gift", "housewarming", "giftidea"], fr: ["cadeau", "cremaillere", "ideecadeau"] },
  intro:      { nl: ["naambord", "ambacht", "interieur"], en: ["nameplate", "craft", "interior"], fr: ["plaque", "artisanat", "interieur"] },
};
// Titels per type (6 varianten, roulerend met anti-herhaling). Jouw merkstem; geen plaatsnaam
// in de titel, geen em-dash. Meer varianten = meer afwisseling voordat het rondloopt.
const TITLES = {
  satisfying: {
    nl: ["Handgemaakt, steen voor steen", "Zie het ontstaan, stukje voor stukje", "Honderd stukjes, één naam", "Puur handwerk, geen knopje", "Kijk hoe de naam verschijnt", "Dit kalmeert meer dan het lijkt"],
    en: ["Handmade, tile by tile", "Watch it take shape, piece by piece", "A hundred pieces, one name", "Pure handwork, no shortcuts", "Watch the name appear", "More calming than it looks"],
    fr: ["Fait main, carreau par carreau", "Regardez-le prendre forme", "Cent pièces, un seul nom", "Du vrai travail à la main", "Regardez le nom apparaître", "Plus apaisant qu'il n'y paraît"],
  },
  insitu: {
    nl: ["Jouw naam aan de muur", "Je naam verdient beter dan plastic", "Zo staat het bij jou thuis", "Aan de gevel of in de hal", "Een naam om trots op te zijn", "Echt glazuur, geen sticker"],
    en: ["Your name on the wall", "Your name deserves better than plastic", "This is how it looks at home", "On the facade or in the hall", "A name to be proud of", "Real glaze, not a sticker"],
    fr: ["Votre nom au mur", "Votre nom mérite mieux que du plastique", "Voilà chez vous", "Sur la façade ou dans l'entrée", "Un nom dont on est fier", "Du vrai émail, pas un autocollant"],
  },
  sfeer: {
    nl: ["Een eeuwenoud ambacht", "Weken werk in één paneel", "Klei, zon, vuur en geduld", "Zoals het al eeuwen gaat", "Haast bestaat hier niet", "Het atelier van dichtbij"],
    en: ["An age-old craft", "Weeks of work in one panel", "Clay, sun, fire and patience", "The way it's been done for ages", "Haste doesn't exist here", "Inside the workshop"],
    fr: ["Un art ancestral", "Des semaines de travail dans un panneau", "Argile, soleil, feu et patience", "Comme depuis des siècles", "La hâte n'existe pas ici", "L'atelier de près"],
  },
  trio: {
    nl: ["Eén naam, drie stijlen", "Welke zou jij ophangen?", "Dezelfde naam, drie keer anders", "Kies jij A, B of C?", "Drie sferen, één naam", "Welke past bij jouw huis?"],
    en: ["One name, three styles", "Which would you hang?", "Same name, three different looks", "Do you pick A, B or C?", "Three moods, one name", "Which fits your home?"],
    fr: ["Un nom, trois styles", "Lequel accrocheriez-vous ?", "Même nom, trois versions", "A, B ou C ?", "Trois ambiances, un nom", "Lequel pour chez vous ?"],
  },
  colorway: {
    nl: ["Welke kleur past bij jou?", "Eén paneel, drie kleurwegen", "Zelfde patroon, andere kleuren", "A, B of C?", "Drie keer dezelfde naam", "Welke kleur wordt die van jou?"],
    en: ["Which colour fits you?", "One panel, three colourways", "Same pattern, different colours", "A, B or C?", "The same name, three ways", "Which colour becomes yours?"],
    fr: ["Quelle couleur vous ressemble ?", "Un panneau, trois couleurs", "Même motif, autres couleurs", "A, B ou C ?", "Le même nom, trois fois", "Quelle couleur sera la vôtre ?"],
  },
  geentwee: {
    nl: ["Geen twee gelijk", "Eén naam, oneindig uniek", "Nooit tweemaal hetzelfde", "Elk paneel is een unicum", "Zoals jouw naam: uniek", "Oneindig veel ontwerpen"],
    en: ["No two alike", "One name, endlessly unique", "Never the same twice", "Every panel is one of one", "Unique, just like your name", "Endless designs"],
    fr: ["Aucun identique", "Un nom, infiniment unique", "Jamais deux fois pareil", "Chaque panneau est unique", "Unique, comme votre nom", "Une infinité de designs"],
  },
  walkthrough: {
    nl: ["Ontwerp jouw paneel", "Zo maak je het zelf", "Jij kiest, wij leggen", "Typ je naam en zie het verschijnen", "In een minuut jouw ontwerp", "Patroon, kleur en naam kiezen"],
    en: ["Design your panel", "Make it yourself", "You choose, we lay it", "Type your name and watch it appear", "Your design in a minute", "Pick pattern, colour and name"],
    fr: ["Composez votre panneau", "Créez le vôtre", "Vous choisissez, nous posons", "Tapez votre nom et regardez", "Votre design en une minute", "Motif, couleur et nom"],
  },
  stopzodra: {
    nl: ["Stop zodra je het herkent", "Raad jij wat het is?", "Pauzeer op het juiste moment", "Herken jij het patroon?", "Hoe snel zie jij het?", "Stop op het goede beeld"],
    en: ["Pause when you recognise it", "Can you guess what it is?", "Stop at the right moment", "Do you recognise the pattern?", "How fast do you see it?", "Pause on the right frame"],
    fr: ["Arrête quand tu reconnais", "Devinez ce que c'est", "Pause au bon moment", "Reconnaissez-vous le motif ?", "Vous le voyez vite ?", "Arrêtez sur la bonne image"],
  },
  onthul: {
    nl: ["Raad wat eronder zit", "Herken jij het al?", "Het beeld vormt zich langzaam", "Zie jij het voor het eind?", "Wat zit er onder de tegels?", "Tegel voor tegel onthuld"],
    en: ["Guess what's underneath", "Can you tell yet?", "The image slowly forms", "Can you see it before the end?", "What's under the tiles?", "Revealed tile by tile"],
    fr: ["Devinez ce qui se cache", "Reconnaissez-vous ?", "L'image se forme lentement", "Vous le voyez avant la fin ?", "Que cache la mosaïque ?", "Révélé carreau par carreau"],
  },
  cadeau: {
    nl: ["Een cadeau dat blijft", "Geef iets dat niemand anders geeft", "Voor wie alles al heeft", "Geen bloemen, maar kunst", "Een cadeau met hun naam", "Blijft jaren hangen"],
    en: ["A gift that lasts", "Give what no one else gives", "For the person who has everything", "Not flowers, but art", "A gift with their name", "It stays on the wall for years"],
    fr: ["Un cadeau qui dure", "Offrez ce que personne n'offre", "Pour qui a déjà tout", "Pas des fleurs, de l'art", "Un cadeau à leur nom", "Il reste des années au mur"],
  },
  intro: {
    nl: ["Dit is Tale of Tiles", "Handgemaakte mozaïekkunst met jouw naam", "Jouw naam in echt glazuur", "Een eeuwenoud ambacht, nu van jou", "Zo ontstaat jouw naambord", "Van klei tot naam aan de muur"],
    en: ["This is Tale of Tiles", "Handmade mosaic art with your name", "Your name in real glaze", "An age-old craft, now yours", "This is how your nameplate is made", "From clay to a name on the wall"],
    fr: ["Voici Tale of Tiles", "L'art mosaïque fait main, à votre nom", "Votre nom en véritable émail", "Un art ancestral, désormais le vôtre", "Voilà comment naît votre plaque", "De l'argile au nom au mur"],
  },
};
// Beschrijvingen per type (2 varianten, roulerend). In jouw site-stem: ambacht laten voelen,
// "geen twee gelijk", zachte maar duidelijke CTA. Geen em-dash. {naam} wordt ingevuld of weg.
const DESCS = {
  satisfying: {
    nl: [
      "Honderden stukjes, met de hand gelegd, tot jouw naam er staat. Geen twee komen er identiek uit, en dat is precies de bedoeling.",
      "Tegel voor tegel, puur op gevoel. Zo groeit een handgemaakt naambord dat jaren meegaat.",
      "Geen printer, geen mal. Alleen een paar handen, echt glazuur en veel geduld.",
      "Kijk hoe losse steentjes langzaam een naam worden. Dit is hoe het al eeuwen gaat.",
      "Elk stukje apart gesneden en gelegd. Daarom lijkt geen enkel paneel op het andere.",
      "Rustgevend om naar te kijken, nog mooier aan de muur. Handwerk van begin tot eind.",
    ],
    en: [
      "Hundreds of pieces, laid by hand, until your name takes shape. No two come out identical, and that is exactly the point.",
      "Tile by tile, purely on feel. This is how a handmade nameplate that lasts for years takes shape.",
      "No printer, no mould. Just a pair of hands, real glaze and a lot of patience.",
      "Watch loose pieces slowly become a name. This is how it has been done for ages.",
      "Every piece cut and placed on its own. That is why no two panels look alike.",
      "Calming to watch, even better on the wall. Handwork from start to finish.",
    ],
    fr: [
      "Des centaines de pièces posées à la main, jusqu'à ce que votre nom apparaisse. Aucune n'est identique, et c'est exactement le but.",
      "Carreau par carreau, au ressenti. Ainsi naît une plaque faite main qui dure des années.",
      "Pas d'imprimante, pas de moule. Juste des mains, du vrai émail et beaucoup de patience.",
      "Regardez des pièces éparses devenir lentement un nom. C'est ainsi depuis des siècles.",
      "Chaque pièce taillée et posée à part. C'est pourquoi aucun panneau ne se ressemble.",
      "Apaisant à regarder, encore plus beau au mur. Du fait main de bout en bout.",
    ],
  },
  insitu: {
    nl: [
      "Geen plastic bordje, maar een handgemaakt paneel in echt glazuur. Aan je gevel, achter de balie of in de hal.",
      "Overal waar een naam ertoe doet, hoort er een die je met trots laat zien. Met de hand gelegd, in echt glazuur.",
      "Zo staat het straks bij jou aan de muur. Een naam in keramiek die opvalt zonder te schreeuwen.",
      "Een naambord dat je gasten meteen zien. Handgemaakt, duurzaam en helemaal van jou.",
      "Thuis, in de zaak of bij de voordeur. Een paneel dat jaren meegaat en nooit verveelt.",
      "De eerste indruk begint bij je naam. Geef hem het paneel dat hij verdient.",
    ],
    en: [
      "No plastic sign, but a handmade panel in real glaze. On your facade, behind the counter or in the hall.",
      "Anywhere a name matters, it deserves one you show with pride. Laid by hand, in real glaze.",
      "This is how it will look on your wall. A name in ceramic that stands out without shouting.",
      "A nameplate your guests notice right away. Handmade, durable and entirely yours.",
      "At home, in the shop or by the front door. A panel that lasts for years and never tires.",
      "First impressions start with your name. Give it the panel it deserves.",
    ],
    fr: [
      "Pas une plaque en plastique, mais un panneau fait main en véritable émail. Sur votre façade, derrière le comptoir ou dans l'entrée.",
      "Partout où un nom compte, il en mérite un que l'on montre avec fierté. Posé à la main, en véritable émail.",
      "Voilà comment il sera sur votre mur. Un nom en céramique qui se remarque sans crier.",
      "Une plaque que vos invités remarquent aussitôt. Faite main, durable et entièrement la vôtre.",
      "Chez vous, à la boutique ou à l'entrée. Un panneau qui dure des années sans lasser.",
      "La première impression commence par votre nom. Offrez-lui le panneau qu'il mérite.",
    ],
  },
  sfeer: {
    nl: [
      "Klei, zon, vuur en geduld. Elke tegel met de hand gesneden en geglazuurd, zoals het al eeuwen gaat. Haast bestaat hier niet.",
      "Weken werk zitten in één paneel. Dat is precies waarom er nergens een tweede bestaat dat op het jouwe lijkt.",
      "In het atelier gaat niets snel. De klei bepaalt het tempo, de handen doen de rest.",
      "Zon om te drogen, vuur om te harden, handen om te leggen. Een ambacht dat tijd vraagt.",
      "Elke kleur komt uit de oven net iets anders. Die kleine verschillen maken het echt.",
      "Zo zag handwerk er altijd al uit. Rustig, precies en zonder een enkele snelkoppeling.",
    ],
    en: [
      "Clay, sun, fire and patience. Every tile cut and glazed by hand, the way it has been done for ages. Haste does not exist here.",
      "Weeks of work go into a single panel. That is exactly why no other one like yours exists.",
      "Nothing is fast in the workshop. The clay sets the pace, the hands do the rest.",
      "Sun to dry, fire to harden, hands to lay. A craft that takes its time.",
      "Every colour comes out of the kiln a little different. Those small differences make it real.",
      "This is what handwork always looked like. Calm, precise and without a single shortcut.",
    ],
    fr: [
      "Argile, soleil, feu et patience. Chaque carreau taillé et émaillé à la main, comme depuis des siècles. La hâte n'existe pas ici.",
      "Des semaines de travail dans un seul panneau. C'est pourquoi aucun autre ne ressemble au vôtre.",
      "À l'atelier, rien ne va vite. L'argile donne le rythme, les mains font le reste.",
      "Le soleil pour sécher, le feu pour durcir, les mains pour poser. Un art qui prend son temps.",
      "Chaque couleur sort du four un peu différente. Ces petits écarts rendent le tout authentique.",
      "Voilà ce qu'a toujours été le fait main. Calme, précis et sans le moindre raccourci.",
    ],
  },
  trio: {
    nl: [
      "Dezelfde naam, drie keer anders. Welke zou jij aan je muur hangen? Zeg het in de comments.",
      "Eén naam, drie stijlen, met de hand gelegd. Jij kiest, wij maken.",
      "Drie sferen voor dezelfde naam. Welke past het best bij jouw huis?",
      "Van rustig tot uitgesproken. Drie kanten van hetzelfde ambacht, één naam.",
      "Moeilijke keuze? Laat in de comments weten of het A, B of C wordt.",
      "Dezelfde letters, drie werelden. Jij hoeft alleen maar te kiezen.",
    ],
    en: [
      "Same name, three different looks. Which would you hang on your wall? Tell us in the comments.",
      "One name, three styles, laid by hand. You choose, we make it.",
      "Three moods for the same name. Which one fits your home best?",
      "From calm to bold. Three sides of the same craft, one name.",
      "Tough choice? Let us know in the comments if it's A, B or C.",
      "Same letters, three worlds. All you have to do is choose.",
    ],
    fr: [
      "Même nom, trois styles. Lequel accrocheriez-vous ? Dites-le en commentaire.",
      "Un nom, trois styles, posés à la main. Vous choisissez, nous réalisons.",
      "Trois ambiances pour le même nom. Laquelle va le mieux chez vous ?",
      "Du sobre à l'affirmé. Trois facettes du même art, un seul nom.",
      "Choix difficile ? Dites en commentaire si c'est A, B ou C.",
      "Mêmes lettres, trois mondes. Vous n'avez plus qu'à choisir.",
    ],
  },
  colorway: {
    nl: [
      "Eén paneel, drie kleurwegen. Welke past bij jouw huis? A, B of C?",
      "Zelfde patroon, andere kleuren. Zeg in de comments welke jij zou kiezen.",
      "Dezelfde naam, drie kleurstemmingen. Warm, koel of ergens daartussen?",
      "Kleur verandert alles. Kijk wat hetzelfde ontwerp doet in drie paletten.",
      "Welke kleur voelt als thuis? Laat het ons weten in de comments.",
      "Drie keer hetzelfde, en toch compleet anders. Dat doet kleur met een paneel.",
    ],
    en: [
      "One panel, three colourways. Which fits your home? A, B or C?",
      "Same pattern, different colours. Tell us in the comments which one you'd pick.",
      "Same name, three colour moods. Warm, cool or somewhere in between?",
      "Colour changes everything. See what one design does across three palettes.",
      "Which colour feels like home? Let us know in the comments.",
      "Three times the same, yet completely different. That is what colour does to a panel.",
    ],
    fr: [
      "Un panneau, trois couleurs. Laquelle pour chez vous ? A, B ou C ?",
      "Même motif, autres couleurs. Dites en commentaire laquelle vous choisiriez.",
      "Même nom, trois ambiances de couleur. Chaud, froid ou entre les deux ?",
      "La couleur change tout. Voyez le même design en trois palettes.",
      "Quelle couleur vous semble chez vous ? Dites-le en commentaire.",
      "Trois fois le même, et pourtant tout autre. Voilà ce que fait la couleur.",
    ],
  },
  geentwee: {
    nl: [
      "Met de hand gemaakt, dus nooit twee gelijk. Net als jouw naam. Oneindig veel ontwerpen, één naam.",
      "Ander patroon, andere kleuren, dezelfde naam. Welke wordt die van jou?",
      "Omdat alles met de hand gaat, bestaat jouw paneel maar één keer. Precies zoals het hoort.",
      "Geen twee panelen zijn gelijk, ook niet met dezelfde naam. Dat is de charme van handwerk.",
      "Oneindig veel patronen en kleuren, en toch is er maar één van jou.",
      "Uniek is geen marketingwoord hier. Het is gewoon wat er gebeurt als mensen het maken.",
    ],
    en: [
      "Made by hand, so never two alike. Just like your name. Endless designs, one name.",
      "New pattern, new colours, same name. Which one becomes yours?",
      "Because everything is done by hand, your panel exists only once. Exactly as it should.",
      "No two panels are the same, even with the same name. That is the charm of handwork.",
      "Endless patterns and colours, and still there is only one of yours.",
      "Unique isn't a marketing word here. It is simply what happens when people make it.",
    ],
    fr: [
      "Fait main, donc jamais deux pareils. Comme votre nom. Une infinité de designs, un nom.",
      "Nouveau motif, nouvelles couleurs, même nom. Lequel sera le vôtre ?",
      "Comme tout est fait main, votre panneau n'existe qu'une fois. Exactement comme il se doit.",
      "Aucun panneau n'est identique, même avec le même nom. C'est le charme du fait main.",
      "Une infinité de motifs et de couleurs, et pourtant un seul est le vôtre.",
      "Unique n'est pas un mot marketing ici. C'est ce qui arrive quand des mains le font.",
    ],
  },
  walkthrough: {
    nl: [
      "Jij doet het leuke deel, wij het handwerk. Kies je patroon, je kleuren en je naam. Ontwerp jouw paneel op taleoftiles.com.",
      "Typ je naam en zie je ontwerp verschijnen in glanzende tegel. Ontwerp die van jou op taleoftiles.com.",
      "Patroon kiezen, kleuren kiezen, naam intikken. In een minuut staat jouw ontwerp klaar op taleoftiles.com.",
      "Geen ontwerpervaring nodig. De configurator doet het werk, jij kiest alleen wat mooi is. taleoftiles.com.",
      "Zo simpel is het: spelen tot het klopt, dan leggen wij het met de hand. Begin op taleoftiles.com.",
      "Jouw idee, onze handen. Stel het samen op taleoftiles.com en wij maken het echt.",
    ],
    en: [
      "You do the fun part, we do the craft. Pick your pattern, your colours and your name. Design yours at taleoftiles.com.",
      "Type your name and watch your design appear in glossy tile. Design yours at taleoftiles.com.",
      "Pick a pattern, pick colours, type a name. Your design is ready in a minute at taleoftiles.com.",
      "No design skills needed. The configurator does the work, you just choose what looks good. taleoftiles.com.",
      "It's this simple: play until it's right, then we lay it by hand. Start at taleoftiles.com.",
      "Your idea, our hands. Put it together at taleoftiles.com and we'll make it real.",
    ],
    fr: [
      "Vous faites la partie amusante, nous l'artisanat. Choisissez motif, couleurs et nom. Composez le vôtre sur taleoftiles.com.",
      "Tapez votre nom et voyez votre design apparaître en carreau brillant. Composez le vôtre sur taleoftiles.com.",
      "Choisissez un motif, des couleurs, un nom. Votre design est prêt en une minute sur taleoftiles.com.",
      "Aucune compétence requise. Le configurateur fait le travail, vous choisissez ce qui vous plaît. taleoftiles.com.",
      "C'est simple : jouez jusqu'à ce que ce soit juste, puis nous posons à la main. Sur taleoftiles.com.",
      "Votre idée, nos mains. Composez-le sur taleoftiles.com et nous le réalisons vraiment.",
    ],
  },
  stopzodra: {
    nl: [
      "Extreem ingezoomd op het mozaïek. Stop zodra je herkent wat het is. Lukt het jou?",
      "Raad jij wat er ontstaat voordat het bord vol is? Zeg het in de comments.",
      "Pauzeer op het moment dat je het ziet. Was je eerder of later dan je dacht?",
      "Van heel dichtbij ziet alles er anders uit. Herken jij het patroon op tijd?",
      "Een klein spelletje: stop de video op het juiste beeld. Hoe scherp is jouw oog?",
      "Kijk goed naar de details. Ergens klikt het, en dan zie je wat het is.",
    ],
    en: [
      "Zoomed right into the mosaic. Pause the moment you recognise it. Can you?",
      "Can you guess what it is before the panel fills up? Tell us in the comments.",
      "Pause the second you see it. Were you earlier or later than you thought?",
      "Everything looks different up close. Can you recognise the pattern in time?",
      "A little game: stop the video on the right frame. How sharp is your eye?",
      "Look closely at the details. At some point it clicks, and then you see it.",
    ],
    fr: [
      "Zoom extrême sur la mosaïque. Arrêtez dès que vous reconnaissez. Vous y arrivez ?",
      "Devinez ce qui apparaît avant que le panneau soit plein. Dites-le en commentaire.",
      "Faites pause au moment où vous le voyez. Plus tôt ou plus tard que prévu ?",
      "De très près, tout semble différent. Reconnaissez-vous le motif à temps ?",
      "Un petit jeu : arrêtez la vidéo sur la bonne image. Votre œil est-il affûté ?",
      "Regardez bien les détails. À un moment ça fait tilt, et là vous voyez.",
    ],
  },
  onthul: {
    nl: [
      "Onder het patroon zit een beeld verstopt. Herken jij het voordat het helemaal onthuld is?",
      "De tegels doven één voor één uit. Raad jij wat eronder zit?",
      "Stukje voor stukje komt het beeld tevoorschijn. Zie jij het al halverwege?",
      "Eerst alleen tegels, dan langzaam een vorm. Wanneer valt bij jou het kwartje?",
      "Een beeld dat zich opbouwt uit mozaïek. Hou je het vol tot het einde?",
      "Kijk hoe de naam of vorm zich onthult, tegel na tegel. Had jij het geraden?",
    ],
    en: [
      "An image is hidden under the pattern. Can you recognise it before it is fully revealed?",
      "The tiles fade one by one. Can you guess what's underneath?",
      "Piece by piece the image appears. Do you see it halfway through?",
      "First just tiles, then slowly a shape. When does it click for you?",
      "An image building itself from mosaic. Can you hold out until the end?",
      "Watch the name or shape reveal itself, tile after tile. Did you guess it?",
    ],
    fr: [
      "Une image se cache sous le motif. La reconnaissez-vous avant la fin ?",
      "Les carreaux s'effacent un à un. Devinez ce qui se cache dessous.",
      "Pièce par pièce, l'image apparaît. La voyez-vous à mi-chemin ?",
      "D'abord des carreaux, puis lentement une forme. Quand est-ce que ça fait tilt ?",
      "Une image qui se construit en mosaïque. Tenez-vous jusqu'au bout ?",
      "Regardez le nom ou la forme se révéler, carreau après carreau. Vous aviez deviné ?",
    ],
  },
  cadeau: {
    nl: [
      "Wat geef je iemand die alles al heeft? Een handgemaakt naambord in echt glazuur, met hun naam. Een cadeau dat ze nooit meer weggeven.",
      "Geen bloemen die verwelken, maar kunst die blijft. Ontwerp een cadeau op taleoftiles.com.",
      "Een cadeau met hun naam erop, met de hand gemaakt. Dat vergeet niemand snel.",
      "Voor een housewarming, een jubileum of zomaar. Een paneel dat jaren blijft hangen.",
      "Iets persoonlijks dat niet in een winkel ligt. Stel het samen op taleoftiles.com.",
      "Geef geen spulletje, maar iets met betekenis. Een naam in glazuur, speciaal voor hen.",
    ],
    en: [
      "What do you give someone who has everything? A handmade nameplate in real glaze, with their name. A gift they'll never give away.",
      "No flowers that wilt, but art that lasts. Design a gift at taleoftiles.com.",
      "A gift with their name on it, made by hand. That is not easily forgotten.",
      "For a housewarming, an anniversary or just because. A panel that stays on the wall for years.",
      "Something personal you won't find in a shop. Put it together at taleoftiles.com.",
      "Don't give a thing, give something with meaning. A name in glaze, just for them.",
    ],
    fr: [
      "Que offrir à qui a déjà tout ? Une plaque faite main en véritable émail, à leur nom. Un cadeau qu'on ne redonne jamais.",
      "Pas des fleurs qui fanent, mais de l'art qui dure. Composez un cadeau sur taleoftiles.com.",
      "Un cadeau à leur nom, fait main. Ça ne s'oublie pas facilement.",
      "Pour une crémaillère, un anniversaire ou sans raison. Un panneau qui reste des années.",
      "Quelque chose de personnel qu'on ne trouve pas en magasin. Composez-le sur taleoftiles.com.",
      "N'offrez pas un objet, offrez du sens. Un nom en émail, rien que pour eux.",
    ],
  },
  intro: {
    nl: [
      "Handgemaakte mozaïekkunst met jouw naam, in echt glazuur. Jij kiest patroon, kleuren en naam, wij leggen het met de hand. Ontwerp jouw paneel op taleoftiles.com.",
      "Een eeuwenoud ambacht, nu met jouw naam aan de muur. Ontwerp die van jou op taleoftiles.com.",
      "Dit is Tale of Tiles: echte zellige, met de hand gelegd, met jouw naam erop. Kijk op taleoftiles.com.",
      "Van losse tegels tot een naam die blijft. Zo werkt het, en zo begin je op taleoftiles.com.",
      "Geen massaproduct, maar handwerk op jouw naam. Ontdek het op taleoftiles.com.",
      "Wij maken naampanelen zoals ze eeuwen geleden gemaakt werden. Ontwerp het jouwe op taleoftiles.com.",
    ],
    en: [
      "Handmade mosaic art with your name, in real glaze. You pick pattern, colours and name, we lay it by hand. Design yours at taleoftiles.com.",
      "An age-old craft, now with your name on the wall. Design yours at taleoftiles.com.",
      "This is Tale of Tiles: real zellige, laid by hand, with your name on it. See taleoftiles.com.",
      "From loose tiles to a name that lasts. This is how it works, and how you start at taleoftiles.com.",
      "Not a mass product, but handwork with your name on it. Discover it at taleoftiles.com.",
      "We make nameplates the way they were made centuries ago. Design yours at taleoftiles.com.",
    ],
    fr: [
      "De l'art mosaïque fait main, à votre nom, en véritable émail. Vous choisissez motif, couleurs et nom, nous posons à la main. Composez le vôtre sur taleoftiles.com.",
      "Un art ancestral, désormais avec votre nom au mur. Composez le vôtre sur taleoftiles.com.",
      "Voici Tale of Tiles : du vrai zellige, posé à la main, à votre nom. Voir taleoftiles.com.",
      "De carreaux épars à un nom qui dure. Voilà comment ça marche, et comment commencer sur taleoftiles.com.",
      "Pas un produit de masse, mais du fait main à votre nom. À découvrir sur taleoftiles.com.",
      "Nous faisons des plaques comme il y a des siècles. Composez la vôtre sur taleoftiles.com.",
    ],
  },
};
// kleine deterministische keuze zodat per video een stabiele (maar verschillende) variant valt
function pick(arr, seed) { if (!arr || !arr.length) return ""; return arr[Math.abs(seed) % arr.length]; }
function seedOf(s) { let h = 0; s = String(s || ""); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// Normaliseren om een eerder gebruikte tekst te herkennen (naam-prefix + hoofdletters/spaties
// weg), zodat "Noor · Geen twee gelijk" matcht met de variant "Geen twee gelijk".
function norm(s) { return String(s || "").toLowerCase().replace(/^.*?·\s*/, "").replace(/\s+/g, " ").trim(); }

// Kies uit arr de EERSTE variant die nog niet in `used` zit; zijn ze allemaal gebruikt, val dan
// terug op de minst recent gebruikte (die het verst achteraan in `used` staat), met de seed als
// tie-breaker. Zo wisselt elke nieuwe post af met wat er al staat, in plaats van te herhalen.
function pickFresh(arr, used, seed) {
  if (!arr || !arr.length) return "";
  const usedNorm = (used || []).map(norm);
  const fresh = arr.filter((x) => !usedNorm.includes(norm(x)));
  if (fresh.length) return fresh[Math.abs(seed) % fresh.length];
  // alles al eens gebruikt: neem degene wiens recentste gebruik het LANGST geleden is.
  // used staat nieuwste-eerst, dus indexOf(norm(x)) = hoe recent (0 = net gebruikt); de variant
  // met de HOOGSTE "hoe lang geleden" wint, zodat we door de hele lijst blijven rouleren.
  let best = arr[0], bestAge = -1;
  for (const x of arr) {
    const age = usedNorm.indexOf(norm(x));       // 0 = meest recent, groter = langer geleden
    if (age > bestAge) { bestAge = age; best = x; }
  }
  return best;
}

// suggest: stelt titel/omschrijving/hashtags voor voor één video.
// `recent` (optioneel) = { titles:[...], descs:[...] } met de teksten die al voor dit type+taal
// gepost zijn (nieuwste eerst). Daarmee vermijdt suggest herhaling en wordt het opbouwend.
export function suggest({ type, lang, name, seed, recent } = {}) {
  const lg = ["en", "fr"].includes(lang) ? lang : "nl";
  const t = TITLES[type] ? type : "satisfying";
  const sd = Number.isFinite(seed) ? seed : seedOf((type || "") + "|" + (name || "") + "|" + lg);
  const usedTitles = (recent && recent.titles) || [];
  const usedDescs = (recent && recent.descs) || [];
  // titel: kies een die nog niet gebruikt is voor dit type+taal
  let title = pickFresh((TITLES[t] && TITLES[t][lg]) || TITLES[t].nl, usedTitles, sd);
  if (name) title = `${name} · ${title}`;
  // beschrijving: idem, los van de titel-keuze
  const body = pickFresh((DESCS[t] && DESCS[t][lg]) || DESCS[t].nl, usedDescs, sd + 1);
  // hashtags: #Shorts + merk + type-specifiek (uniek gehouden)
  const brand = BASE_TAGS[lg] || BASE_TAGS.nl;
  const typed = (TYPE_TAGS[t] && TYPE_TAGS[t][lg]) || [];
  const all = [...new Set([...brand, ...typed])];
  const hashline = "#Shorts " + all.map((x) => "#" + x.replace(/[^\p{L}\p{N}]/gu, "")).join(" ");
  const description = body + "\n\n" + hashline;
  return { title: title.slice(0, 100), description, tags: all };
}

export function makePlatform({ ROOT } = {}) {
  const SECRETS = ROOT ? path.resolve(ROOT, "secrets") : path.resolve("secrets");
  const tokenPath = (lang) => path.join(SECRETS, `yt-${lang}.json`);

  function creds() {
    const id = process.env.YT_CLIENT_ID, secret = process.env.YT_CLIENT_SECRET;
    if (!id || !secret) throw new Error("YT_CLIENT_ID/SECRET ontbreken in .env");
    return { id, secret };
  }
  async function readToken(lang) {
    try { return JSON.parse(await fsp.readFile(tokenPath(lang), "utf8")); } catch { return null; }
  }
  async function writeToken(lang, data) {
    await fsp.mkdir(SECRETS, { recursive: true });
    await fsp.writeFile(tokenPath(lang), JSON.stringify(data, null, 2));
  }

  // Access-token halen uit het opgeslagen refresh-token (ververst vanzelf).
  async function accessToken(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) throw new Error(`YouTube ${lang.toUpperCase()} niet gekoppeld`);
    const { id, secret } = creds();
    const body = new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: tok.refresh_token, grant_type: "refresh_token" });
    const r = await fetch(TOKEN, { method: "POST", body });
    if (!r.ok) throw new Error("token verversen faalde: " + (await r.text()).slice(0, 200));
    const j = await r.json();
    return j.access_token;
  }

  // LOGIN per taal: open een loopback-servertje, stuur de gebruiker naar Google, vang de code,
  // ruil 'm voor een refresh-token, bewaar. De belofte lost op zodra de gebruiker klaar is.
  // De engine opent de browser; opent die niet, dan staat de link ook in het log.
  function startLogin(lang, log = () => {}) {
    const { id, secret } = creds();
    return new Promise((resolve, reject) => {
      let settled = false, killer = null;
      const finish = (err, val) => {
        if (settled) return; settled = true;
        clearTimeout(killer);
        try { server.close(); } catch {}
        err ? reject(err) : resolve(val);
      };
      const server = http.createServer(async (req, res) => {
        try {
          const u = new URL(req.url, "http://127.0.0.1");
          if (!u.searchParams.has("code") && !u.searchParams.has("error")) { res.writeHead(404); res.end(); return; }
          if (u.searchParams.has("error")) { res.end("Geannuleerd. Je kunt dit tabblad sluiten."); finish(new Error("login geannuleerd")); return; }
          const code = u.searchParams.get("code");
          const port = server.address().port;
          const body = new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: `http://127.0.0.1:${port}`, grant_type: "authorization_code" });
          const r = await fetch(TOKEN, { method: "POST", body });
          const j = await r.json();
          if (!r.ok || !j.refresh_token) {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<h2>Koppelen mislukt</h2><p>" + (j.error_description || j.error || "geen refresh-token") + "</p><p>Sluit dit tabblad en probeer opnieuw.</p>");
            finish(new Error("geen refresh-token (al eens gekoppeld? trek toegang in bij Google en probeer opnieuw)")); return;
          }
          await writeToken(lang, { refresh_token: j.refresh_token, scope: j.scope, saved: Date.now() });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<body style="font-family:system-ui;background:#1a1327;color:#f4ecdc;text-align:center;padding-top:80px"><h2>YouTube ${lang.toUpperCase()} gekoppeld ✓</h2><p>Je kunt dit tabblad sluiten en terug naar de studio.</p></body>`);
          finish(null, { ok: true });
        } catch (e) { try { res.writeHead(500); res.end(String(e.message)); } catch {} finish(e); }
      });
      server.on("error", (e) => finish(e));
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const params = new URLSearchParams({ client_id: id, redirect_uri: `http://127.0.0.1:${port}`, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent" });
        const url = `${AUTH}?${params}`;
        log(`YouTube ${lang.toUpperCase()}: open de browser om te koppelen…`);
        log(`Opent niet vanzelf? Open deze link: ${url}`);
        // Browser openen met de VOLLEDIGE url. `cmd /c start` opent de browser (zoals eerst),
        // maar cmd ziet de &-tekens als commando-scheiders en kapt de url af (-> response_type
        // viel weg). Fix: de & voor cmd escapen als ^& zodat de hele url doorkomt.
        try {
          if (process.platform === "win32") {
            const cmdUrl = url.replace(/&/g, "^&");
            spawn("cmd", ["/c", "start", "", cmdUrl], { stdio: "ignore", detached: true, windowsHide: true }).unref();
          } else {
            const bin = process.platform === "darwin" ? "open" : "xdg-open";
            spawn(bin, [url], { stdio: "ignore", detached: true }).unref();
          }
        } catch {}
      });
      // veiligheidsklep: geen login binnen 5 min -> server sluiten, geen zombie-poort
      killer = setTimeout(() => finish(new Error("koppelen verlopen (geen login binnen 5 min)")), 5 * 60 * 1000);
    });
  }

  async function authStatus(lang) {
    const tok = await readToken(lang);
    if (!tok || !tok.refresh_token) return { connected: false, who: "" };
    // probeer de kanaalnaam op te halen (bewijs dat het token werkt)
    try {
      const at = await accessToken(lang);
      const r = await fetch(`${API}/channels?part=snippet&mine=true`, { headers: { authorization: "Bearer " + at } });
      const j = await r.json();
      const ch = j.items && j.items[0];
      return { connected: true, who: ch ? ch.snippet.title : "" };
    } catch { return { connected: true, who: "" }; }
  }

  // UPLOAD: resumable. video = absoluut pad, meta = {title, description, tags}, privacy default public.
  async function upload(videoPath, meta, lang, log = () => {}) {
    const at = await accessToken(lang);
    const stat = await fsp.stat(videoPath);
    const snippet = {
      snippet: { title: (meta.title || "Tale of Tiles").slice(0, 100), description: meta.description || "", tags: (meta.tags || []).slice(0, 15), categoryId: "22" },
      status: { privacyStatus: meta.privacy || "public", selfDeclaredMadeForKids: false },
    };
    // 1) sessie starten
    const init = await fetch(`${UPLOAD}?part=snippet,status&uploadType=resumable`, {
      method: "POST",
      headers: { authorization: "Bearer " + at, "content-type": "application/json", "x-upload-content-length": String(stat.size), "x-upload-content-type": "video/*" },
      body: JSON.stringify(snippet),
    });
    if (!init.ok) throw new Error("upload-sessie faalde: " + (await init.text()).slice(0, 300));
    const loc = init.headers.get("location");
    if (!loc) throw new Error("geen upload-URL van YouTube");
    // 2) de bytes sturen (in één PUT; de bestanden zijn klein genoeg)
    log(`YouTube ${lang.toUpperCase()}: uploaden (${Math.round(stat.size / 1024)} KB)…`);
    const buf = await fsp.readFile(videoPath);
    const put = await fetch(loc, { method: "PUT", headers: { "content-type": "video/*", "content-length": String(stat.size) }, body: buf });
    if (!put.ok) throw new Error("upload faalde: " + (await put.text()).slice(0, 300));
    const j = await put.json();
    return { postId: j.id, url: "https://youtu.be/" + j.id };
  }

  // VIEWS per video via Analytics API (kanaal = de ingelogde gebruiker).
  async function stats(postId, lang) {
    try {
      const at = await accessToken(lang);
      const end = new Date().toISOString().slice(0, 10);
      const params = new URLSearchParams({ ids: "channel==MINE", startDate: "2020-01-01", endDate: end, metrics: "views,likes,comments,estimatedMinutesWatched", filters: "video==" + postId });
      const r = await fetch(`${ANALYTICS}?${params}`, { headers: { authorization: "Bearer " + at } });
      if (!r.ok) return null;
      const j = await r.json();
      const row = j.rows && j.rows[0];
      if (!row) return { views: 0, likes: 0, comments: 0, minutes: 0 };
      return { views: row[0], likes: row[1], comments: row[2], minutes: row[3] };
    } catch { return null; }
  }

  return {
    id: "youtube", label: "YouTube", enabled: true, needsAuth: true,
    suggest, startLogin, authStatus, upload, stats,
  };
}
