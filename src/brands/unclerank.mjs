// MERK-MODULE: UncleRank, data-animatie video's voor het portaal (AnchorRank).
//
// Zelfstandig opgezet: elke frame is een KALE, complete SVG (geen afhankelijkheid van de tegel-
// helpers van Tale of Tiles). De engine rastert sceneAt(frame) -> frames -> mp4, net als bij de
// andere merken. UncleRank verschijnt vanzelf in de Studio-kiezer (registry.mjs voegt hem toe).
//
// Contract dat makeRender teruggeeft, gelijk aan taleoftiles: { W, H, FPS, SS, durSec, sceneAt, music, clicks }.
// sceneAt(frame) -> volledige <svg> string voor dat frame.
//
// Types nu: "roi" (Eén klant betaalt je jaar), "gat" (Het harde cijfer) en "portaal" (schermopname
// van het publieke portaal, de kring). Bron-cijfers komen uit opts of vallen terug op nette
// standaarden; de stem (Engels/Kokoro) en meer types volgen.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";

const FORMATS = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };
const FFMPEG = process.env.FFMPEG || ffmpegStatic || "ffmpeg";

// Eigen UR-fonts voor het rasteren van de tekstkaarten in de portaal-montage (zelfde set als de
// raster-worker; systeem-fonts uit = voorspelbaar + snel). Pad t.o.v. dit bestand, dus OS-onafhankelijk.
let UR_FONT_FILES = [];
try {
  const _fdir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "fonts");
  UR_FONT_FILES = fs.readdirSync(_fdir).filter((f) => /\.(ttf|otf|ttc)$/i.test(f)).map((f) => path.join(_fdir, f));
} catch { UR_FONT_FILES = []; }

// Draai een sub-proces en stuur elke uitvoer-regel LIVE door naar log() (zoals taleoftiles),
// zodat de voortgang in het app-paneel én de terminal verschijnt.
function runStreamed(node, args, env, log, tag) {
  return new Promise((resolve) => {
    const ch = spawn(node, args, { env, windowsHide: true });
    let buf = "";
    const flush = (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (log) log((tag ? tag + " " : "") + line); else process.stdout.write(line + "\n");
      }
    };
    ch.stdout.on("data", flush); ch.stderr.on("data", flush);
    ch.on("close", (code) => { if (buf.trim()) { if (log) log((tag ? tag + " " : "") + buf.trim()); else process.stdout.write(buf); } resolve({ status: code }); });
    ch.on("error", (e) => { if (log) log((tag ? tag + " " : "") + "fout: " + e.message); resolve({ status: 1 }); });
  });
}

// Zorg dat er een UncleRank-logo-png is om op de video te stempelen. finish.mjs valt standaard
// terug op het Tale-of-Tiles-logo; dat willen we hier NIET. Bestaat er een UR-logo, gebruik dat;
// anders genereren we ter plekke een nette UR-wordmark (cyaan op transparant) in de work-map.
function ensureLogo(ROOT, work, opts) {
  const cands = [
    opts && opts.logo,
    path.resolve(ROOT, "assets/unclerank/brand/logo.png"),
    path.resolve(ROOT, "assets/brand/unclerank.png"),
    path.resolve(ROOT, "assets/unclerank/logo.png"),
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  // genereren: wordmark "UncleRank" met ffmpeg drawtext op transparant
  const out = path.join(work, "ur-logo.png");
  const fontCands = [
    path.resolve(ROOT, "assets/fonts/Fraunces-600.ttf"),
    path.resolve(ROOT, "assets/fonts/CormorantGaramond-600.ttf"),
  ];
  let font = ""; for (const f of fontCands) { try { if (fs.existsSync(f)) { font = f; break; } } catch {} }
  const ff = font ? `:fontfile='${font.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
  try {
    const r = spawnSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black@0:s=640x180,format=rgba",
      "-vf", `drawtext=text='UncleRank'${ff}:fontcolor=0x00b8e6:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2,format=rgba`,
      "-frames:v", "1", out], { windowsHide: true });
    if (r.status === 0 && fs.existsSync(out)) return out;
  } catch {}
  return (opts && opts.logo) || "";
}

// Huisstijl van het portaal: donker navy, cyaan accent, groen voor winst.
const C = {
  bg0: "#0a1623", bg1: "#0e2032", ink: "#e8eef5", mut: "#8aa0b5",
  accent: "#00b8e6", accentDark: "#0a5f78", green: "#19c37d", line: "#1d3146",
};

// UncleRank = strakke SANS (niet de Tale-of-Tiles-serif). De sans-font "UR Sans" ligt in
// assets/fonts/ (eigen naam zodat andere merken niks merken); valt netjes terug op system-sans.
const SANS = "'UR Sans', Arial, Helvetica, sans-serif";

// Het echte UR-merk: de UR-mark (favicon, transparant) wordt als data-URI in elke frame gestempeld;
// het uitgeschreven "UncleRank" tekenen we als scherpe vector in de merkkleuren. Één keer geladen.
let MARK_URI = "";
function loadMark(ROOT) {
  if (MARK_URI) return MARK_URI;
  const cands = [
    path.resolve(ROOT, "assets/unclerank/brand/mark.png"),
    path.resolve(ROOT, "assets/unclerank/brand/logo-mark.png"),
  ];
  for (const p of cands) {
    try { if (fs.existsSync(p)) { MARK_URI = "data:image/png;base64," + fs.readFileSync(p).toString("base64"); return MARK_URI; } } catch {}
  }
  return MARK_URI;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x); return x * x * (3 - 2 * x); };
// fade-in over [a,b], vol blijven tot c, fade-out over [c,d]. Ontbrekende c/d = blijft staan.
const win = (t, a, b, c = 1e9, d = 1e9) => {
  if (t < a) return 0;
  if (t < b) return smooth((t - a) / Math.max(0.001, b - a));
  if (t < c) return 1;
  if (t < d) return 1 - smooth((t - c) / Math.max(0.001, d - c));
  return 0;
};
const eur = (n) => "€" + new Intl.NumberFormat("nl-NL").format(Math.round(n));

function bg(W, H) {
  return `<defs><radialGradient id="bg" cx="50%" cy="38%" r="80%">
    <stop offset="0" stop-color="${C.bg1}"/><stop offset="1" stop-color="${C.bg0}"/></radialGradient></defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg)"/>`;
}
// Merk-lockup bovenin: de echte UR-mark + "UncleRank" (Uncle = licht, Rank = cyaan), altijd zichtbaar.
function wordmark(W, H, op = 1) {
  if (op <= 0.001) return "";
  // Lockup lager dan de bovenrand: op TikTok/Reels zit daar de platform-UI (Volgend / Voor jou, LIVE,
  // zoeken). Op ~0.072 werd de UR-lockup daar tussen weggedrukt; 0.14 zet 'm in de veilige zone eronder.
  const topY = Math.round(H * 0.14);
  const mk = Math.round(W * 0.075);            // mark-grootte
  const fs = Math.round(W * 0.05);             // woordmerk-tekst
  const gap = Math.round(mk * 0.26);
  const wordEst = fs * 4.9;                     // "UncleRank"-breedte-benadering: ALLEEN om de lockup te centreren
  const totalW = mk + gap + wordEst;
  const x0 = Math.round(W / 2 - totalW / 2);
  const baY = topY + Math.round(fs * 0.36);     // baseline ~ verticaal midden van de mark
  const tx0 = x0 + mk + gap;
  let g = `<g opacity="${op.toFixed(3)}">`;
  if (MARK_URI) g += `<image x="${x0}" y="${topY - Math.round(mk / 2)}" width="${mk}" height="${mk}" href="${MARK_URI}" preserveAspectRatio="xMidYMid meet"/>`;
  // ÉÉN tekst-element met twee tspans = altijd "UncleRank" aaneen (geen gat), kleur-split Uncle/Rank.
  g += `<text x="${tx0}" y="${baY}" font-family="${SANS}" font-size="${fs}" font-weight="800" text-anchor="start"><tspan fill="${C.ink}">Uncle</tspan><tspan fill="${C.accent}">Rank</tspan></text>`;
  g += `</g>`;
  return g;
}
// Alleen de UR-mark, gecentreerd (voor een sober merk-moment, bv. op een slot/CTA).
function markOnly(cx, cy, size, op = 1) {
  if (!MARK_URI || op <= 0.001) return "";
  return `<image x="${Math.round(cx - size / 2)}" y="${Math.round(cy - size / 2)}" width="${size}" height="${size}" href="${MARK_URI}" opacity="${op.toFixed(3)}" preserveAspectRatio="xMidYMid meet"/>`;
}

// ---- AUDIO (hergebruikt Truthward-keten) --------------------------------------------------
// Per type: de momenten (atSec) waarop de voice-over-regels vallen, één wav per regel. De wavs
// maakt tools/ur_voice.py (NL-Chatterbox, willekeurige stem uit voice-test/refs-ur/) in
// assets/unclerank/voice/<type>/NN.wav. De regel-TEKST staat in ur_voice.py; hier alleen de timing,
// zodat beeld en stem op dezelfde beats vallen. Nieuwe types: voeg een beats-rij toe + script in ur_voice.
// Beat-FRACTIES van de totale duur. De echte duur komt van de ingesproken stem (Truthward-stijl:
// video volgt de stem); het beeld verschijnt op deze fracties zodat beeld en stem meelopen.
const UR_BEATS = {
  roi: [0.03, 0.22, 0.42, 0.66, 0.88],   // hook · aanbod · pakketten · waarde · CTA(stop)
};
// AFWISSELING: per type meerdere varianten (andere woorden, andere stem-regels, zelfde boodschap +
// timing). De render kiest er willekeurig één (anti-herhaling), zodat beeld én stem per render
// wisselen. Elke variant = de tekst-blokken op het scherm + de bijbehorende stem-regels (zelfde
// volgorde als UR_BEATS). Cijfers blijven structureel (uit opts); alleen de bewoording wisselt.
const UR_CTA_URL = "portaal.unclerank.com/bureaus";   // CTA-URL op de slotkaart; pas aan als de bureaus-pagina verandert
const UR_VARIANTS = {
  roi: [
    {
      hook: ["Stop met bellen", "zonder reden."],
      offer: ["Geen gekochte lijst.", "Een dossier per bedrijf."],
      valueLabel: ["wat één gewonnen klant", "je per maand oplevert"],
      cta: "Begin gratis, 7 dagen.",
      voice: [
        "Stop met bellen zonder reden.",
        "Geen gekochte lijst, maar een dossier per bedrijf, met de meting en de reden om te bellen.",
        "Kies veertig, honderd of vierhonderd bedrijven per maand, een paar euro per bedrijf.",
        "Win er één, en die levert je vijfhonderd tot tweeduizend vijfhonderd euro per maand op.",
        "Begin gratis. Zeven dagen.",
      ],
    },
    {
      hook: ["Bellen zonder reden?", "Daar stoppen we mee."],
      offer: ["Geen lijst.", "Een reden om te bellen."],
      valueLabel: ["zoveel verdient", "één klant per maand"],
      cta: "Pak je gratis week.",
      voice: [
        "Bellen zonder reden? Daar stoppen we mee.",
        "Geen lijst, maar een reden om te bellen: de meting en het mankement per bedrijf.",
        "Veertig, honderd of vierhonderd bedrijven per maand, een paar euro per stuk.",
        "Eén gewonnen klant verdient al vijfhonderd tot tweeduizend vijfhonderd euro per maand.",
        "Pak je gratis week.",
      ],
    },
  ],
  // THEMA "HET AANBOD" (montage: tekstkaarten + stukjes schermopname). Elke variant = een ANDERE
  // invalshoek op dezelfde boodschap (verse leads met een reden, per vak), met eigen stem én eigen
  // kaarten. De render kiest telkens een verse (blijvende anti-herhaling), zodat geen twee renders
  // gelijk zijn. Kaart-rollen in vaste volgorde [hook, pijn, oplossing, waarde, cta]; PORTAAL_SEQUENCE
  // plaatst ze met de opname-stukjes ertussen. GEEN meetmethode noemen (bedrijfsgeheim): enkel het
  // signaal en de waarde. De opname werkt als beeld, niet als het verhaal.
  portaal: [
    { // A, timing is alles
      voice: [
        "Heb jij een online marketingbureau? Dan ken je dit probleem maar al te goed.",
        "Je hebt een dienst die werkt. Alleen zit je agenda niet vanzelf vol.",
        "Dus bel je bedrijven. Koud. Van een lijst die je ergens vandaan hebt.",
        "En negen van de tien keer krijg je nee. Niet omdat jouw dienst niet deugt.",
        "Maar omdat je op het verkeerde moment belt. Datzelfde bedrijf had vorige maand misschien ja gezegd.",
        "Want bij koud bellen draait alles om timing. En timing kun je niet raden.",
        "Daar is UncleRank voor. Wij houden Nederlandse bedrijven continu in de gaten.",
        "En we zien het zodra er iets verandert waar jij, met jouw vak, precies op aansluit.",
        "Een voorbeeld. Een bedrijf stopt met adverteren. Voor een advertentiebureau is dat het moment om te bellen.",
        "Zulke signalen krijg jij elke week, netjes gesorteerd op jouw vak: SEO, SEA, web, content of reclame.",
        "Zo bel je nooit meer blind, maar een bedrijf waar nu echt iets speelt, met de reden erbij.",
        "En dat hoor je meteen. Geen koud gesprek, maar een gesprek dat ergens over gaat.",
        "Benieuwd welke bedrijven dat vandaag zijn? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook",  title: "Heb jij een\nmarketingbureau?", sub: "Dan ken je\ndit probleem." },
        { key: "l2",    title: "Je dienst\nwerkt",              sub: "Maar je agenda\nvult niet vanzelf." },
        { key: "l3",    title: "Dus bel je\nkoud",              sub: "Van een\nlijst." },
        { key: "l4",    title: "Negen keer\nnee",               sub: "Niet omdat je\ndienst slecht is." },
        { key: "l5",    title: "Verkeerde\nmoment",             sub: "Daar gaat\nhet mis." },
        { key: "l6",    title: "Alles draait\nom timing",       sub: "En die raad\nje niet." },
        { key: "l7",    title: "Daarom:\nUncleRank",            sub: "Wij volgen\nde bedrijven." },
        { key: "l8",    title: "Er verandert\niets",            sub: "Precies\njouw kans." },
        { key: "l9",    title: "Stopt met\nadverteren", sub: "Het moment\nvoor jou.", shot: "lead" },
        { key: "l10",   title: "Elke week,\nper vak", sub: "SEO, SEA, web,\ncontent, reclame.", shot: "signaal" },
        { key: "l11",   title: "Nooit meer\nblind bellen",      sub: "Met de reden\nerbij." },
        { key: "l12",   title: "Dat hoor\nje meteen",           sub: "Een echt\ngesprek." },
        { key: "cta",   title: "Benieuwd?",                     sub: UR_CTA_URL, outro: true },
      ],
    },
    { // B, een lijst is geen lead
      voice: [
        "Iedereen kan een lijst met bedrijven kopen. Maar dat is een telefoonboek, geen leads.",
        "Je weet van die namen helemaal niets. Niet of ze iets nodig hebben, niet of het nu speelt.",
        "Dus bel je ze allemaal af, en de meeste hebben geen idee waarom je belt.",
        "Dat is zonde van jouw tijd, en zonde van je naam bij dat bedrijf.",
        "Een echte lead is iets heel anders. Dat is een bedrijf waar nu iets mis is dat jij kunt oplossen.",
        "En laat dat precies zijn wat UncleRank voor je vindt.",
        "Wij houden Nederlandse bedrijven in de gaten en zien wanneer er iets verandert.",
        "Bijvoorbeeld een website die al maanden stilstaat. Voor een webbouwer een open deur.",
        "Of een bedrijf dat slecht gevonden wordt. Voor een SEO-bureau precies jouw klant.",
        "Elk signaal komt bij je binnen met de reden erbij, gesorteerd op jouw vak.",
        "Geen koude namen meer, maar bedrijven met een concrete reden om nu te bellen.",
        "Je belt minder, maar je raakt veel vaker. Dat scheelt je uren per week.",
        "Wil je zien welke bedrijven dat vandaag zijn? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Een lijst\nis geen lead",  sub: "Dat is een\ntelefoonboek." },
        { key: "l2",   title: "Je weet er\nniks van",      sub: "Nodig? Speelt\nhet nu?" },
        { key: "l3",   title: "Dus bel je\nalles af",      sub: "Niemand weet\nwaarom je belt." },
        { key: "l4",   title: "Zonde van\nje tijd",        sub: "En van je naam\nbij dat bedrijf." },
        { key: "l5",   title: "Een echte\nlead",           sub: "Een bedrijf waar\nnu iets mis is." },
        { key: "l6",   title: "Dat vindt\nUncleRank",      sub: "Voor\njou." },
        { key: "l7",   title: "Wij volgen\nde bedrijven",  sub: "En zien als er\niets verandert." },
        { key: "l8",   title: "Site staat\nmaanden stil", sub: "Open deur\nvoor een webbouwer.", shot: "lead" },
        { key: "l9",   title: "Slecht\ngevonden", sub: "Precies jouw\nSEO-klant.", shot: "lead2" },
        { key: "l10",  title: "Met de reden\nerbij", sub: "Gesorteerd\nop jouw vak.", shot: "signaal" },
        { key: "l11",  title: "Geen koude\nnamen meer",    sub: "Een concrete\nreden." },
        { key: "l12",  title: "Minder bellen,\nvaker raak", sub: "Scheelt je\nuren." },
        { key: "cta",  title: "Benieuwd?",                 sub: UR_CTA_URL, outro: true },
      ],
    },
    { // C, het moment dat het klopt
      voice: [
        "Stel je belt een bedrijf, en je voelt meteen: dit klopt. Ze luisteren, het gesprek loopt.",
        "Dat gebeurt niet vaak bij koud bellen. Meestal bel je iemand die nergens op zit te wachten.",
        "Het verschil zit niet in jouw praatje. Het zit in het moment waarop je belt.",
        "Een bedrijf dat vorige week nog tevreden was, kan deze week een probleem hebben.",
        "En precies op dat soort momenten wil jij aan de lijn zijn. Als eerste.",
        "Dat is wat UncleRank doet. Wij houden Nederlandse bedrijven in de gaten.",
        "En zodra er iets verandert waar jij iets mee kunt, zie jij dat.",
        "Een bedrijf dat net stopte met adverteren. Een site die ineens pagina's verliest.",
        "Allemaal signalen dat er nu iets speelt, klaargezet per vak: SEO, SEA, web, content of reclame.",
        "Jij belt dus niet meer koud, maar op het moment dat het bedrijf je het hardst nodig heeft.",
        "En dat hoor je terug in elk gesprek. Warmer, korter, en veel vaker raak.",
        "Een zo'n klant verdient je abonnement al terug, vaak in de eerste maand.",
        "Wil je het zelf zien? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Soms klopt\neen gesprek",  sub: "Ze luisteren,\nhet loopt." },
        { key: "l2",   title: "Zo gaat het\nzelden",       sub: "Bij koud\nbellen." },
        { key: "l3",   title: "Niet je\npraatje",          sub: "Maar het\nmoment." },
        { key: "l4",   title: "Vorige week\ntevreden",     sub: "Deze week\neen probleem." },
        { key: "l5",   title: "Daar wil\nje zijn",         sub: "Als\neerste." },
        { key: "l6",   title: "Dat doet\nUncleRank",       sub: "Wij volgen\nde bedrijven." },
        { key: "l7",   title: "Er verandert\niets", sub: "Jij ziet\nhet.", shot: "dossier-kop" },
        { key: "l8",   title: "Ads gestopt.\nPagina's weg.", sub: "De\nsignalen.", shot: "signaal" },
        { key: "l9",   title: "Nu speelt\nhet", sub: "Per vak\nklaargezet.", shot: "waarde" },
        { key: "l10",  title: "Niet meer\nkoud",           sub: "Maar op het\njuiste moment." },
        { key: "l11",  title: "Warmer,\nkorter",           sub: "Veel vaker\nraak." },
        { key: "l12",  title: "Een klant",                 sub: "Verdient je\nabonnement terug." },
        { key: "cta",  title: "Zelf zien?",                sub: UR_CTA_URL, outro: true },
      ],
    },
  ],

  // ===== THEMA 2: "VOOR JOUW VAK", per vak het echte signaal uit het dossier (geen meetmethode) =====
  vak: [
    { // SEO
      voice: [
        "Jij bent een SEO-bureau. Je weet precies wat je voor een bedrijf kunt betekenen.",
        "Alleen: welk bedrijf heeft het nu echt nodig? Dat zie je van buitenaf niet.",
        "Dus bel je maar wat, en de meeste bedrijven vinden zichzelf wel prima vindbaar.",
        "Terwijl er juist bedrijven zijn waar het gat enorm is. Die weten dat zelf niet.",
        "Daar is UncleRank voor. Wij meten Nederlandse bedrijven door op hun vindbaarheid.",
        "En we zien het als er elke maand duizenden mensen zoeken, maar dat bedrijf er bijna niks van pakt.",
        "Al die zoekers gaan nu naar de concurrent. Dat is puur gemiste omzet.",
        "Dat bedrijf krijg jij, met het cijfer er al bij, nog voordat je belt.",
        "Zo begin je geen koud praatje, maar een gesprek over geld dat blijft liggen.",
        "Benieuwd welke bedrijven dat zijn? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Jij bent een\nSEO-bureau",   sub: "Je weet wat je\nkunt betekenen." },
        { key: "l2",   title: "Maar wie heeft\nhet nu nodig?", sub: "Dat zie je\nniet." },
        { key: "l3",   title: "Dus bel je\nmaar wat",        sub: "De meeste vinden\nzich wel vindbaar." },
        { key: "l4",   title: "Er zijn bedrijven\nmet een gat", sub: "Die het zelf\nniet weten." },
        { key: "l5",   title: "Daarom:\nUncleRank",          sub: "Wij meten de\nvindbaarheid." },
        { key: "l6",   title: "Duizenden\nzoekers",          sub: "Dit bedrijf pakt\ner bijna niks." },
        { key: "l7",   title: "Alles naar\nde concurrent",   sub: "Pure gemiste\nomzet." },
        { key: "l8",   title: "Jij krijgt het,\nmet cijfer",  sub: "Nog voor\nje belt." },
        { key: "l9",   title: "Geen koud\npraatje",          sub: "Een gesprek\nover geld." },
        { key: "cta",  title: "Benieuwd?",                   sub: UR_CTA_URL, outro: true },
      ],
    },
    { // Web
      voice: [
        "Jij bouwt websites. En je ziet elke dag sites waarvan je denkt: hier kan ik zoveel aan verbeteren.",
        "Maar die bedrijven bellen je niet. Ze weten vaak niet eens dat hun site ze klanten kost.",
        "Dus zoek je zelf naar werk, en bel je bedrijven waarvan je de site niet eens kent.",
        "Zonde, want precies die rammelende sites zijn jouw beste gesprekken.",
        "Daar helpt UncleRank je mee. Wij kijken continu naar Nederlandse bedrijven.",
        "En we zien het: een trage site, een verouderde bouw, of een pagina die al maanden stilstaat.",
        "Dat is geen koude naam, dat is een bedrijf met een probleem dat jij kunt oplossen.",
        "Je belt dus met een concrete reden, en dat hoor je meteen aan de andere kant.",
        "Geen ingewikkeld verhaal, gewoon: ik zag iets aan jullie site. Dat opent elke deur.",
        "Wil je zien welke sites dat zijn? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Jij bouwt\nwebsites",         sub: "En ziet overal\nwat beter kan." },
        { key: "l2",   title: "Maar ze bellen\nje niet",     sub: "Ze weten niet dat\nhun site ze klanten kost." },
        { key: "l3",   title: "Dus zoek je\nzelf werk",      sub: "Blind, zonder\nde site te kennen." },
        { key: "l4",   title: "Juist die\nsites",            sub: "Zijn je beste\ngesprekken." },
        { key: "l5",   title: "Daarom:\nUncleRank",          sub: "Wij kijken naar\nde bedrijven." },
        { key: "l6",   title: "Traag, oud,\nstilgevallen",   sub: "De staat van\nde site." },
        { key: "l7",   title: "Een probleem\ndat jij oplost", sub: "Geen koude\nnaam." },
        { key: "l8",   title: "Je belt met\neen reden",       sub: "Dat hoor je\nmeteen." },
        { key: "l9",   title: "Ik zag iets\naan je site",     sub: "Dat opent\nelke deur." },
        { key: "cta",  title: "Wil je zien?",                sub: UR_CTA_URL, outro: true },
      ],
    },
    { // SEA / ads
      voice: [
        "Jij draait advertenties voor bedrijven. En je weet: op het juiste moment is dat goud waard.",
        "Maar je weet niet welk bedrijf er nu klaar voor is. Dus bel je koud, en vaak te vroeg.",
        "Het bedrijf dat je belt draait misschien al jaren niks, en voelt de urgentie niet.",
        "Terwijl er bedrijven zijn waar de zoekvraag groot is, en niemand die erop adverteert.",
        "Dat is wat UncleRank voor je ziet. Wij meten Nederlandse bedrijven door.",
        "Een dure klik, veel vraag, en een leeg speelveld. Dat is een open doel voor jou.",
        "Of een bedrijf dat net stopte met adverteren, en nu zichtbaar terrein verliest.",
        "Die signalen krijg jij binnen, met de reden erbij, klaar om te bellen.",
        "Zo bel je niet meer op goed geluk, maar precies waar een eerste ads-traject te winnen is.",
        "Benieuwd waar dat nu speelt? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Jij draait\nadvertenties",    sub: "Op het juiste moment\ngoud waard." },
        { key: "l2",   title: "Maar wie is\ner klaar voor?",  sub: "Dus bel je koud,\nte vroeg." },
        { key: "l3",   title: "Geen\nurgentie",              sub: "Ze draaien al\njaren niks." },
        { key: "l4",   title: "Er is vraag,\nniemand adverteert", sub: "Een leeg\nspeelveld." },
        { key: "l5",   title: "Dat ziet\nUncleRank",          sub: "Wij meten de\nbedrijven door." },
        { key: "l6",   title: "Dure klik,\nveel vraag",       sub: "Een open doel\nvoor jou." },
        { key: "l7",   title: "Net gestopt\nmet ads",         sub: "Verliest nu\nterrein." },
        { key: "l8",   title: "Met de reden\nerbij",          sub: "Klaar om\nte bellen." },
        { key: "l9",   title: "Niet op\ngoed geluk",          sub: "Waar echt iets\nte winnen is." },
        { key: "cta",  title: "Waar speelt\nhet nu?",         sub: UR_CTA_URL, outro: true },
      ],
    },
  ],

  // ===== THEMA 3: "GEEN KOUDE LIJST", kwaliteit en het verschil met een gekochte lijst =====
  geenlijst: [
    { // A, telefoonboek
      voice: [
        "Je kunt overal een lijst met bedrijven kopen. Duizend namen, voor een paar tientjes.",
        "Maar laten we eerlijk zijn: dat is geen lijst met leads. Dat is een telefoonboek.",
        "Want je weet van die namen helemaal niets. Niet of ze iets nodig hebben, niet of het nu speelt.",
        "Dus bel je ze allemaal af, en bij negen van de tien is het antwoord meteen nee.",
        "Dat is zonde van je tijd, en erger: je brandt je naam op bij bedrijven die je later wel had kunnen helpen.",
        "Een echte lead is iets heel anders. Dat is een bedrijf waar nu iets mis is dat jij kunt oplossen.",
        "En precies dat is wat UncleRank voor je zoekt, in plaats van zomaar namen.",
        "Elk bedrijf dat je krijgt heeft een concrete reden eronder, klaar voor jouw vak.",
        "Je belt dus minder, maar je raakt veel vaker. En elk gesprek gaat ergens over.",
        "Wil je het verschil zien? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Een lijst\nkoop je overal",  sub: "Duizend namen,\neen paar tientjes." },
        { key: "l2",   title: "Maar dat zijn\ngeen leads",   sub: "Dat is een\ntelefoonboek." },
        { key: "l3",   title: "Je weet er\nniks van",        sub: "Nodig? Speelt\nhet nu?" },
        { key: "l4",   title: "Negen keer\nnee",             sub: "Meteen\nal." },
        { key: "l5",   title: "Je brandt\nje naam op",       sub: "Bij bedrijven die\nje later nodig had." },
        { key: "l6",   title: "Een echte\nlead",             sub: "Een bedrijf waar\nnu iets mis is." },
        { key: "l7",   title: "Dat zoekt\nUncleRank",        sub: "Geen zomaar\nnamen." },
        { key: "l8",   title: "Met een\nconcrete reden",     sub: "Klaar voor\njouw vak." },
        { key: "l9",   title: "Minder bellen,\nvaker raak",  sub: "Elk gesprek gaat\nergens over." },
        { key: "cta",  title: "Zie het\nverschil",           sub: UR_CTA_URL, outro: true },
      ],
    },
    { // B, kwaliteit boven kwantiteit
      voice: [
        "Veel bureaus denken: hoe meer bedrijven ik bel, hoe meer klanten ik krijg.",
        "Maar zo werkt het niet meer. Bellen zonder reden kost je vooral tijd en goede wil.",
        "Honderd koude telefoontjes voor twee gesprekken, dat is geen strategie, dat is uitputting.",
        "Het gaat niet om hoeveel bedrijven je belt. Het gaat om welke, en wanneer.",
        "Daarom draait UncleRank het om. Wij geven je geen lange lijst, maar een korte.",
        "Alleen bedrijven waar nu aantoonbaar iets speelt dat bij jouw vak past.",
        "Een bedrijf dat slecht gevonden wordt. Een site die stilstaat. Een merk dat niemand kent.",
        "Stuk voor stuk een reden om te bellen, met de onderbouwing erbij.",
        "Zo bel je een handvol bedrijven per week, en haal je er meer uit dan uit honderd koude.",
        "Benieuwd hoe kort die lijst is? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Meer bellen,\nmeer klanten?", sub: "Zo dacht\niedereen." },
        { key: "l2",   title: "Zo werkt\nhet niet meer",     sub: "Het kost vooral\ntijd." },
        { key: "l3",   title: "Honderd calls,\ntwee gesprekken", sub: "Dat is\nuitputting." },
        { key: "l4",   title: "Niet hoeveel,\nmaar welke",   sub: "En\nwanneer." },
        { key: "l5",   title: "UncleRank\ndraait het om",    sub: "Geen lange lijst,\neen korte." },
        { key: "l6",   title: "Alleen waar\niets speelt",    sub: "Passend bij\njouw vak." },
        { key: "l7",   title: "Slecht gevonden.\nSite stil.", sub: "Merk dat\nniemand kent." },
        { key: "l8",   title: "Elk met\neen reden",          sub: "Met de\nonderbouwing." },
        { key: "l9",   title: "Een handvol\nper week",       sub: "Meer dan uit\nhonderd koude." },
        { key: "cta",  title: "Hoe kort\nis die lijst?",     sub: UR_CTA_URL, outro: true },
      ],
    },
    { // C, een naam is geen lead
      voice: [
        "Een naam op een lijst vertelt je niks. Het is een bedrijf, meer niet.",
        "Je weet niet wat er speelt, of ze budget hebben, of ze uberhaupt een probleem hebben.",
        "Dus elk telefoontje is gokken. En gokken voelt het bedrijf aan de andere kant feilloos aan.",
        "Daarom begint een goed gesprek niet met een naam, maar met een reden.",
        "En die reden, die levert UncleRank. Wij meten Nederlandse bedrijven continu door.",
        "We zien waar iets mis is, of waar iets net is veranderd, netjes per vak uitgesplitst.",
        "Jij krijgt dus geen naam, maar een bedrijf plus het signaal: dit is er aan de hand.",
        "Daarmee bel je niet koud, maar begin je het gesprek al halverwege.",
        "Dat scheelt je tijd, en het levert je veel vaker een ja op.",
        "Wil je zien hoe zo'n signaal eruitziet? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Een naam\nis geen lead",     sub: "Een bedrijf,\nmeer niet." },
        { key: "l2",   title: "Je weet niet\nwat er speelt", sub: "Budget?\nProbleem?" },
        { key: "l3",   title: "Elk telefoontje\nis gokken",  sub: "En dat\nvoelen ze." },
        { key: "l4",   title: "Begin niet met\neen naam",    sub: "Maar met\neen reden." },
        { key: "l5",   title: "Die levert\nUncleRank",       sub: "Wij meten\ndoor." },
        { key: "l6",   title: "Waar iets\nmis is",           sub: "Per vak\nuitgesplitst." },
        { key: "l7",   title: "Bedrijf plus\nhet signaal",   sub: "Dit is er\naan de hand." },
        { key: "l8",   title: "Je begint\nhalverwege",       sub: "Niet\nkoud." },
        { key: "l9",   title: "Minder tijd,\nvaker ja",      sub: "Zo\nsimpel." },
        { key: "cta",  title: "Zie een\nsignaal",            sub: UR_CTA_URL, outro: true },
      ],
    },
  ],

  // ===== THEMA 4: "DE KRING", exclusiviteit, doorspelen, urgentie (gegrond op het portaal-model) =====
  kring: [
    { // A, het verloren signaal
      voice: [
        "Je belt een klant voor je eigen dienst. Een normaal gesprek, tot hij iets laat vallen.",
        "Mijn website moet eigenlijk eerst op de schop, zegt hij. Maar dat is niet jouw vak.",
        "Vroeger hing je op, en was dat signaal gewoon weg. Weggegooid.",
        "Terwijl het voor een ander bureau goud waard is: een klant die het zelf net heeft gezegd.",
        "Daar is de kring van UncleRank voor. Een club van bureaus die elkaar dit soort signalen toespeelt.",
        "Hoor jij iets wat niet jouw dienst is? Een klik, en je markeert het in de kring.",
        "Het bureau dat dat wel doet, een webbouwer bijvoorbeeld, krijgt het als hete lead binnen.",
        "En andersom krijg jij de signalen die anderen horen maar zelf niet kunnen gebruiken.",
        "Zo verdient iedereen aan gesprekken die anders in de prullenbak waren verdwenen.",
        "Ook meedoen? Kijk wat de kring is, de link staat in beeld.",
      ],
      queries: ["business professional phone call office", "web developer laptop screen office", "", "colleagues handshake office deal", "business team meeting office", "", "", "", "", ""],
      cards: [
        { key: "hook", title: "Een normaal\ngesprek",       sub: "Tot hij iets\nlaat vallen." },
        { key: "l2",   title: "Mijn site moet\neerst op de schop", sub: "Niet jouw\nvak." },
        { key: "l3",   title: "Vroeger\nweg",               sub: "Signaal\nweggegooid." },
        { key: "l4",   title: "Voor een ander\ngoud waard",  sub: "Hij zei het\nzelf net." },
        { key: "l5",   title: "Daarvoor is\nde kring",       sub: "Bureaus die elkaar\nsignalen toespelen." },
        { key: "l6",   title: "Hoor je iets?\nMarkeer het",  sub: "Een\nklik." },
        { key: "l7",   title: "Het juiste bureau\nkrijgt het", sub: "Als hete\nlead." },
        { key: "l8",   title: "En jij krijgt\nterug",        sub: "Wat anderen\nhoren." },
        { key: "l9",   title: "Iedereen\nverdient",          sub: "Aan gesprekken die\nweg waren." },
        { key: "cta",  title: "Ook\nmeedoen?",               sub: UR_CTA_URL, outro: true },
      ],
    },
    { // B, geven en terugkrijgen
      voice: [
        "In een werkweek hoor je zoveel langskomen waar je zelf niks mee kunt.",
        "Een klant die het over adverteren heeft, terwijl jij alleen websites bouwt.",
        "Of iemand die vraagt naar SEO, terwijl dat jouw dienst niet is.",
        "Allemaal kansen, en ze verdwijnen op het moment dat je ophangt. Zonde.",
        "In de kring van UncleRank gooi je ze niet meer weg. Je speelt ze door.",
        "Jij geeft de signalen die niet bij jou passen aan het bureau dat het wel doet.",
        "En dat bureau doet precies hetzelfde voor jou, voor jouw vak.",
        "Zo komt er elke week warm werk binnen waar je zelf bijna niks voor hoefde te doen.",
        "Je voedt de kring, en je eet eruit. Dat is het hele idee.",
        "Benieuwd hoe dat werkt? Kijk wat de kring is, de link staat in beeld.",
      ],
      queries: ["colleagues talking office meeting", "marketing team discussion office", "", "", "business handshake office deal", "", "team collaboration office project", "", "", ""],
      cards: [
        { key: "hook", title: "Je hoort\nveel langskomen",  sub: "Waar je zelf\nniks mee kunt." },
        { key: "l2",   title: "Een klant\nwil ads",         sub: "Jij bouwt\nwebsites." },
        { key: "l3",   title: "Of vraagt\nnaar SEO",        sub: "Niet jouw\ndienst." },
        { key: "l4",   title: "Kansen die\nverdwijnen",     sub: "Zodra je\nophangt." },
        { key: "l5",   title: "In de kring\ngooi je niks weg", sub: "Je speelt ze\ndoor." },
        { key: "l6",   title: "Jij geeft\nwat niet past",   sub: "Aan het juiste\nbureau." },
        { key: "l7",   title: "En zij doen\nhetzelfde",     sub: "Voor jouw\nvak." },
        { key: "l8",   title: "Elke week\nwarm werk",       sub: "Zonder er iets\nvoor te doen." },
        { key: "l9",   title: "Voed de kring,\neet eruit",  sub: "Het hele\nidee." },
        { key: "cta",  title: "Hoe\nwerkt het?",            sub: UR_CTA_URL, outro: true },
      ],
    },
    { // C, waarom een kring, geen lijst
      voice: [
        "Waarom zou je in een kring gaan zitten, en niet gewoon leads kopen?",
        "Omdat een gekochte lijst dood is. Iedereen heeft dezelfde, en niemand zei iets.",
        "Een kring leeft. Het zijn echte signalen, uit echte gesprekken, van mensen die je vertrouwt.",
        "Een klant die tegen een collega-bureau zegt dat hij iets nodig heeft, dat beweegt.",
        "En alleen de leden van de kring krijgen die signalen te zien. Niemand anders.",
        "Dat is de exclusiviteit: niet de lead zelf, maar de kring eromheen.",
        "Je zit met bureaus die elkaar geen concurrent vinden, maar elkaar werk gunnen.",
        "Ieder zijn vak, ieder zijn signalen, en samen veel meer bereik dan alleen.",
        "Zo bouw je aan leads die je nergens kunt kopen, omdat ze van binnenuit komen.",
        "Wil je erbij horen? Kijk wat de kring is, de link staat in beeld.",
      ],
      queries: ["business people networking office", "", "team collaboration meeting office", "", "business group discussion office", "", "colleagues handshake office", "", "", ""],
      cards: [
        { key: "hook", title: "Kring, of\nlijst kopen?",    sub: "Dat is het\nverschil." },
        { key: "l2",   title: "Een lijst\nis dood",         sub: "Iedereen heeft\ndezelfde." },
        { key: "l3",   title: "Een kring\nleeft",           sub: "Echte signalen,\nechte gesprekken." },
        { key: "l4",   title: "Een klant\nzegt iets",       sub: "Dat\nbeweegt." },
        { key: "l5",   title: "Alleen leden\nzien het",     sub: "Niemand\nanders." },
        { key: "l6",   title: "Dat is de\nexclusiviteit",   sub: "Niet de lead,\nde kring." },
        { key: "l7",   title: "Geen\nconcurrenten",         sub: "Ze gunnen elkaar\nwerk." },
        { key: "l8",   title: "Ieder\nzijn vak",            sub: "Samen meer\nbereik." },
        { key: "l9",   title: "Leads die je\nniet koopt",   sub: "Ze komen van\nbinnenuit." },
        { key: "cta",  title: "Erbij\nhoren?",              sub: UR_CTA_URL, outro: true },
      ],
    },
  ],

  // ===== THEMA 5: "HOE HET WERKT", het model in stappen en het harde cijfer (uit bureaus.mjs) =====
  hoewerkt: [
    { // A, het model in drie stappen
      voice: [
        "Hoe werkt UncleRank nou eigenlijk? Heel simpel, in drie stappen.",
        "Stap een: wij meten Nederlandse bedrijven elke week opnieuw door.",
        "Niet een keer, maar continu, zodat we zien wanneer er iets verandert.",
        "Stap twee: alles wat in orde is, valt af. Een bedrijf zonder probleem is geen lead.",
        "Wat overblijft, is een korte lijst bedrijven waar nu echt iets speelt.",
        "Stap drie: dat bedrijf gaat naar een bureau in dat vak. Niet naar tien tegelijk.",
        "Drie weken lang is het van jou alleen. Jij belt, en niemand anders in jouw discipline.",
        "Zo krijg je geen afgetrapte lijst, maar een verse lead met ruimte om te scoren.",
        "Meten, filteren, en exclusief doorgeven. Dat is het hele systeem.",
        "Wil je het in actie zien? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Hoe werkt\nUncleRank?",      sub: "In drie\nstappen." },
        { key: "l2",   title: "Stap een:\nmeten",           sub: "Elke week\nopnieuw." },
        { key: "l3",   title: "Niet een\nkeer",             sub: "Maar\ncontinu." },
        { key: "l4",   title: "Stap twee:\nfilteren",       sub: "Wat in orde is,\nvalt af." },
        { key: "l5",   title: "Wat\noverblijft",            sub: "Bedrijven waar\niets speelt." },
        { key: "l6",   title: "Stap drie:\neen bureau",     sub: "Niet tien\ntegelijk." },
        { key: "l7",   title: "Drie weken\nvan jou",        sub: "Jij belt,\nniemand anders." },
        { key: "l8",   title: "Geen afgetrapte\nlijst",     sub: "Een verse\nlead." },
        { key: "l9",   title: "Meten, filteren,\ndoorgeven", sub: "Het hele\nsysteem." },
        { key: "cta",  title: "In actie\nzien?",            sub: UR_CTA_URL, outro: true },
      ],
    },
    { // B, het harde cijfer
      voice: [
        "Laat ik je laten zien waarom dit werkt, met een echt voorbeeld.",
        "Stel, een koeriersbedrijf in Amsterdam. Elke maand zoeken bijna drieduizend mensen op koerier.",
        "Van al die zoekers haalt dit bedrijf er ongeveer een binnen. Een.",
        "De rest, bijna drieduizend mogelijke klanten, gaat elke maand naar de concurrent.",
        "Voor een SEO-bureau is dat een traject van vijfhonderd tot tweeduizend vijfhonderd euro per maand.",
        "Dat bedrijf weet dit zelf niet. Het ziet alleen dat de telefoon te weinig gaat.",
        "UncleRank rekent dit soort gaten voor je uit, nog voordat je belt.",
        "Jij komt dus niet binnen met een praatje, maar met een cijfer dat pijn doet, en dat jij oplost.",
        "Dat is geen koud gesprek meer. Dat is een bedrijf laten zien wat het elke maand misloopt.",
        "Benieuwd wat jouw markt oplevert? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Waarom dit\nwerkt",          sub: "Een echt\nvoorbeeld." },
        { key: "l2",   title: "Koerier in\nAmsterdam",      sub: "3.000 zoekers\nper maand." },
        { key: "l3",   title: "Dit bedrijf\npakt er een",   sub: "Een." },
        { key: "l4",   title: "De rest naar\nde concurrent", sub: "Elke\nmaand." },
        { key: "l5",   title: "500 tot\n2.500 euro",        sub: "per maand,\nvoor SEO." },
        { key: "l6",   title: "Ze weten\nhet niet",         sub: "Alleen dat de\ntelefoon stil is." },
        { key: "l7",   title: "UncleRank rekent\nhet voor", sub: "Nog voor\nje belt." },
        { key: "l8",   title: "Niet met\neen praatje",      sub: "Met een cijfer\ndat pijn doet." },
        { key: "l9",   title: "Laten zien wat\nze mislopen", sub: "Geen koud\ngesprek." },
        { key: "cta",  title: "Wat levert\njouw markt op?", sub: UR_CTA_URL, outro: true },
      ],
    },
    { // C, geen risico
      voice: [
        "Misschien denk je: klinkt mooi, maar werkt het ook voor mij?",
        "Daarom kun je UncleRank gewoon een week gratis proberen. Zonder gedoe.",
        "Je ziet meteen de echte bedrijven in jouw vak, met het signaal erbij.",
        "Geen demo met nepdata, maar de leads die je die week ook echt kunt bellen.",
        "Bevalt het niet? Dan stop je, en heeft het je niks gekost.",
        "Bevalt het wel, dan reken je even uit wat een nieuwe klant je oplevert.",
        "Een klant verdient je abonnement vaak al in de eerste maand terug.",
        "De rest van het jaar is dan puur winst, elke maand opnieuw.",
        "Het enige wat je riskeert, is een week van je tijd om het te zien.",
        "Dus waarom niet? Probeer het portaal een week gratis. De link staat in beeld.",
      ],
      cards: [
        { key: "hook", title: "Werkt het\nvoor mij?",       sub: "Logische\nvraag." },
        { key: "l2",   title: "Probeer het\ngratis",        sub: "Een week,\nzonder gedoe." },
        { key: "l3",   title: "Meteen de\nechte bedrijven", sub: "Met het signaal\nerbij." },
        { key: "l4",   title: "Geen\nnepdata",              sub: "Leads die je echt\nkunt bellen." },
        { key: "l5",   title: "Bevalt niet?\nJe stopt",     sub: "Het kostte\nje niks." },
        { key: "l6",   title: "Bevalt wel?\nReken uit",     sub: "Wat een klant\noplevert." },
        { key: "l7",   title: "Een klant",                 sub: "Verdient je\nabonnement terug." },
        { key: "l8",   title: "De rest\nis winst",          sub: "Elke maand\nopnieuw." },
        { key: "l9",   title: "Je riskeert\neen week",      sub: "Van je\ntijd." },
        { key: "cta",  title: "Waarom\nniet?",              sub: UR_CTA_URL, outro: true },
      ],
    },
  ],

  // ===== TYPE "DE ONDERNEMER": eerste persoon, de bureau-eigenaar die z'n ervaring snoevend/met een
  // knipoog brengt. Teast de edge (aanbod + kring) zonder de mechaniek te verklappen; cold-viewer-veilig,
  // altijd een zachte CTA. Zakelijke founder-footage eronder (zelfde business-pijplijn als de kring). =====
  ondernemer: [
    { // A, vroeger blind, nu gericht
      voice: [
        "Ik run al een paar jaar een marketingbureau. En ik ga je eerlijk iets vertellen.",
        "Vroeger was nieuwe klanten vinden het deel van mijn werk waar ik het meest tegenop zag.",
        "Ik belde bedrijven af van een lijst, zonder te weten of ze me nodig hadden.",
        "De meeste gesprekken waren koud, ongemakkelijk, en leverden niks op.",
        "Tot ik stopte met bellen op goed geluk, en begon te bellen op het juiste moment.",
        "Nu bel ik een bedrijf pas als ik weet dat er iets is veranderd, iets wat ik kan oplossen.",
        "Een site die stilstaat, een bedrijf dat net stopte met adverteren, dat soort dingen.",
        "En het verschil is enorm. Dezelfde telefoontjes, maar nu klopt het bijna altijd.",
        "Ik bel minder, ik stress minder, en ik haal meer klanten binnen dan ooit.",
        "Hoe ik precies weet wanneer ik moet bellen? Kijk maar waar deze video naartoe linkt.",
      ],
      queries: ["confident business owner office portrait", "", "businessman phone call office", "", "", "professional working laptop office", "", "", "", ""],
      cards: [
        { key: "hook", title: "Ik run een\nmarketingbureau", sub: "En ik ben\neerlijk." },
        { key: "l2",   title: "Klanten\nvinden",             sub: "Daar zag ik\ntegenop." },
        { key: "l3",   title: "Ik belde\nblind af",          sub: "Van een\nlijst." },
        { key: "l4",   title: "Koud,\nongemakkelijk",        sub: "Leverde\nniks op." },
        { key: "l5",   title: "Tot ik\nstopte",              sub: "Met bellen op\ngoed geluk." },
        { key: "l6",   title: "Nu bel ik\nmet een reden",    sub: "Als er iets\nis veranderd." },
        { key: "l7",   title: "Site stil,\nads gestopt",     sub: "Dat soort\ndingen." },
        { key: "l8",   title: "Dezelfde\ntelefoontjes",      sub: "Nu klopt\nhet." },
        { key: "l9",   title: "Minder bellen,\nmeer klanten", sub: "En veel minder\nstress." },
        { key: "cta",  title: "Hoe ik dat\nweet?",           sub: UR_CTA_URL, outro: true },
      ],
    },
    { // B, Sst, het geheim
      voice: [
        "Mensen vragen me weleens: hoe kom jij toch steeds aan nieuwe klanten?",
        "En dan lach ik een beetje, want dat verklap ik niet zomaar.",
        "Laat ik het zo zeggen: ik hoor en zie dingen die mijn concurrenten missen.",
        "Een bedrijf waar net iets verandert, precies op het moment dat het nog niemand opvalt.",
        "En dan ben ik degene die belt. Niet als tiende, maar als eerste.",
        "Mijn concurrenten zijn nog honderd namen van een lijst aan het afbellen.",
        "Terwijl ik een paar bedrijven bel waar ik al weet dat er iets speelt.",
        "Dat scheelt me uren, en het levert me gesprekken op die ergens over gaan.",
        "Nee, ik ga je niet precies vertellen hoe. Maar ik geef je wel een hint.",
        "Kijk maar waar deze video naartoe linkt. Dan snap je het zo.",
      ],
      queries: ["confident businessman office smiling", "", "business professional office portrait", "", "", "busy office people walking", "", "", "", ""],
      cards: [
        { key: "hook", title: "Hoe kom jij\naan klanten?",  sub: "Vragen ze\nme." },
        { key: "l2",   title: "Dan lach\nik",               sub: "Dat verklap\nik niet." },
        { key: "l3",   title: "Ik zie wat\nanderen missen",  sub: "Net op\ntijd." },
        { key: "l4",   title: "Net iets\nverandert",         sub: "Voor het\niemand opvalt." },
        { key: "l5",   title: "Ik bel\nals eerste",          sub: "Niet als\ntiende." },
        { key: "l6",   title: "Zij bellen\nhonderd namen",   sub: "Van een\nlijst." },
        { key: "l7",   title: "Ik bel er\neen paar",         sub: "Waar iets\nspeelt." },
        { key: "l8",   title: "Scheelt\nuren",               sub: "Echte\ngesprekken." },
        { key: "l9",   title: "Hoe? Dat\nzeg ik niet",       sub: "Maar een\nhint." },
        { key: "cta",  title: "Sst.",                        sub: UR_CTA_URL, outro: true },
      ],
    },
    { // C, laat de concurrent maar koud bellen
      voice: [
        "Weet je wat ik mijn concurrenten gun? Dat ze lekker koud blijven bellen.",
        "Echt. Laat ze maar honderd bedrijven per dag afbellen voor twee gesprekken.",
        "Ik deed dat vroeger ook, en ik werd er doodmoe van. Veel werk, weinig resultaat.",
        "Tot ik doorhad dat het niet om hard werken gaat, maar om op het juiste moment bellen.",
        "Nu bel ik alleen nog bedrijven waar nu echt iets speelt. En dat weet ik van tevoren.",
        "Een bedrijf dat ineens slechter gevonden wordt, of z'n site heeft laten versloffen.",
        "Dat zijn de gesprekken waar een klant uit komt. En die pak ik er zo tussenuit.",
        "Minder bellen, meer binnenhalen. Dat is het verschil tussen druk zijn en slim zijn.",
        "Mijn concurrenten snappen nog steeds niet hoe ik het doe. En dat houd ik graag zo.",
        "Wil jij ook slim werken in plaats van hard? Kijk waar deze video naartoe linkt.",
      ],
      queries: ["confident business owner office", "", "", "businessman thinking office", "", "", "successful businessman office portrait", "", "", ""],
      cards: [
        { key: "hook", title: "Weet je wat\nik ze gun?",    sub: "Lekker koud\nblijven bellen." },
        { key: "l2",   title: "Honderd calls\nper dag",      sub: "Voor twee\ngesprekken." },
        { key: "l3",   title: "Dat deed ik\nook",            sub: "Ik werd er\nmoe van." },
        { key: "l4",   title: "Niet hard\nwerken",           sub: "Maar op het\njuiste moment." },
        { key: "l5",   title: "Alleen waar\niets speelt",    sub: "En dat weet\nik vooraf." },
        { key: "l6",   title: "Slechter\ngevonden",          sub: "Of site laten\nversloffen." },
        { key: "l7",   title: "Daar komt een\nklant uit",    sub: "Die pak ik\nertussenuit." },
        { key: "l8",   title: "Minder bellen,\nmeer binnen", sub: "Druk, of\nslim." },
        { key: "l9",   title: "Ze snappen\nhet niet",        sub: "En dat\nhoud ik zo." },
        { key: "cta",  title: "Ook slim\nwerken?",           sub: UR_CTA_URL, outro: true },
      ],
    },
  ],
};
const LAST_VARIANT = {};   // anti-herhaling: niet twee keer achter elkaar dezelfde variant
function pickVariant(templateId) {
  const vs = UR_VARIANTS[templateId];
  if (!vs || !vs.length) return 0;
  if (vs.length === 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * vs.length); } while (i === LAST_VARIANT[templateId]);
  LAST_VARIANT[templateId] = i;
  return i;
}
// BLIJVENDE anti-herhaling over renders heen (ook na herstart): welke varianten recent gebruikt zijn
// staat in een klein state-bestand, zodat je niet twee keer snel dezelfde invalshoek rendert. Blokkeert
// ~60% van de pool; valt terug op de hele pool als alles recent is. Per type een eigen geschiedenis.
function pickFreshVariant(ROOT, templateId, n) {
  if (!n || n <= 1) return 0;
  const sf = path.resolve(ROOT, "assets", "unclerank", ".ur-state.json");
  let st = {};
  try { st = JSON.parse(fs.readFileSync(sf, "utf8")) || {}; } catch {}
  const hist = Array.isArray(st[templateId]) ? st[templateId] : [];
  const keep = Math.max(1, Math.floor(n * 0.6));
  const recent = hist.slice(-keep);
  let avail = [];
  for (let i = 0; i < n; i++) if (!recent.includes(i)) avail.push(i);
  if (!avail.length) avail = Array.from({ length: n }, (_, i) => i);
  const pick = avail[Math.floor(Math.random() * avail.length)];
  hist.push(pick); while (hist.length > n) hist.shift();
  st[templateId] = hist;
  try { fs.mkdirSync(path.dirname(sf), { recursive: true }); fs.writeFileSync(sf, JSON.stringify(st)); } catch {}
  return pick;
}
// Laad stem-wavs + muziekbodem additief in het render-object (Truthward: render.music + audio.tracks).
// Raakt de kern NIET: de engine legt render.music onder de video en overlayAudio mixt de stem erover.
function voiceDir(ROOT, templateId, vi) {
  // elke variant z'n eigen stem-map: assets/unclerank/voice/<type>/v<vi>/
  return path.resolve(ROOT, "assets/unclerank/voice", templateId, "v" + vi);
}
function attachAudio(ROOT, templates, templateId, render, vi = 0) {
  // muziekbodem: eigen UR-map (merk-gescheiden), mood = eerste music-tag van het type
  try {
    const tpl = templates.find((t) => t.id === templateId);
    const mood = (tpl && tpl.music && tpl.music[0]) || "calm";
    const mp = path.resolve(ROOT, "assets/unclerank/muziek", "ur-" + mood + ".mp3");
    if (fs.existsSync(mp)) render.music = mp;
  } catch {}
  // stem: ÉÉN doorlopend voice.wav (hele variant in één opname, Truthward-stijl) over de muziek.
  // De stem is in ur_voice.py al LUID genormaliseerd (loudnorm), dus hier gain 1.0, geen clipping.
  if (UR_BEATS[templateId]) {
    const w = path.join(voiceDir(ROOT, templateId, vi), "voice.wav");
    try { if (fs.existsSync(w)) render.audio = { tracks: [{ file: w, atSec: 0, gain: 1.0 }] }; } catch {}
  }
  return render;
}
function tx(x, y, s, { fs, w = 400, fill = C.ink, op = 1, anchor = "middle", ls = 0 }) {
  if (op <= 0.001) return "";
  return `<text x="${x}" y="${y}" fill="${fill}" opacity="${op.toFixed(3)}" font-family="${SANS}"
    font-size="${fs}" font-weight="${w}" letter-spacing="${ls}" text-anchor="${anchor}">${esc(s)}</text>`;
}
// Een tekst over meerdere regels (handmatig gesplitst), gecentreerd rond y.
function block(x, y, lines, o) {
  const lh = o.fs * 1.18;
  const start = y - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) => tx(x, start + i * lh, l, o)).join("");
}
function root(W, H, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>`;
}

// ---- PORTAAL-MONTAGE: tekstkaarten tussen de schermopname -----------------------------------
// De 4 kaarten vertellen het verhaal (momentopname -> wij meten dagelijks -> beweging over tijd ->
// geen leadlijst). De opname-stukjes komen ertussen als illustratie. Titel mag 2 regels via "\n".
// Volgorde van de montage: hook + pijn zijn tekst-only; de opname-stukjes (het echte portaal) komen
// pas bij de oplossing en de waarde. Elk item heeft een gewicht voor de duur-verdeling (kaarten korter,
// opname-stukjes iets langer). card = index in de kaarten van de gekozen variant.
const PORTAAL_SEQUENCE = [
  { kind: "card", i: 0, w: 1.3 },   // context: "online marketingbureau?"
  { kind: "card", i: 1, w: 1.2 },   // pijn: "koud bellen werkt niet"
  { kind: "card", i: 2, w: 1.3 },   // wat doen we: "maak kennis met UncleRank"
  { kind: "clip", i: 0, w: 1.7 },   // opname: het portaal met de bedrijven (de lijst)
  { kind: "card", i: 3, w: 1.2 },   // waarde: "bel op het juiste moment"
  { kind: "clip", i: 1, w: 1.7 },   // opname: een bedrijf openen -> het signaal in het dossier
  { kind: "card", i: 4, w: 1.3 },   // CTA: "probeer het gratis"
];
// Eén tekstkaart -> complete SVG (donker merk-vlak, UR-lockup boven, grote titel + subtekst, cyaan tik).
function makeCardSvg({ W, H, title, sub, outro = false }) {
  const cx = W / 2;
  const fsS = Math.round(W * 0.039);
  const cy = Math.round(H * (outro ? 0.42 : 0.44));
  const tLines = String(title).split("\n");
  // Titelgrootte: start op de basis, maar KRIMP automatisch als de langste regel te breed wordt,
  // zodat geen enkele titel tegen de rand loopt (K = geschatte tekenbreedte van UR Sans bold).
  const base = Math.round(W * (outro ? 0.086 : 0.074));
  const longest = Math.max(1, ...tLines.map((l) => l.length));
  const K = 0.62, fitW = 0.84 * W;
  const fsT = Math.max(Math.round(W * 0.050), Math.min(base, Math.floor(fitW / (K * longest))));
  let s = bg(W, H) + wordmark(W, H, 1);
  // cyaan tik boven de titel
  s += `<rect x="${cx - 44}" y="${cy - Math.round(fsT * (tLines.length / 2)) - 56}" width="88" height="6" rx="3" fill="${C.accent}"/>`;
  s += block(cx, cy, tLines, { fs: fsT, w: 800, fill: C.ink });
  if (sub) {
    const sLines = String(sub).split("\n");
    const subY = cy + Math.round(fsT * (tLines.length / 2)) + Math.round(fsS * 1.9);
    s += block(cx, subY, sLines, { fs: fsS, w: 500, fill: C.mut });
  }
  if (outro) s += markOnly(cx, Math.round(H * 0.70), Math.round(W * 0.15), 1);
  return root(W, H, s);
}
// TRANSPARANTE variant van de kaart: dezelfde tekst/lockup, maar ZONDER de donkere achtergrond, met
// een leesbaarheids-scrim, zodat hij als bijschrift OVER bewegend beeld kan liggen (Truthward-logica:
// beeld onder, tekst erover). Alles buiten de scrim/tekst is doorzichtig (Resvg bewaart de alpha).
// Dezelfde titel-autofit als makeCardSvg, zodat tekst nooit tegen de rand loopt.
function makeCaptionSvg({ W, H, title, sub, outro = false }) {
  const cx = W / 2;
  const fsS = Math.round(W * 0.039);
  const cy = Math.round(H * (outro ? 0.42 : 0.44));
  const tLines = String(title).split("\n");
  const base = Math.round(W * (outro ? 0.086 : 0.074));
  const longest = Math.max(1, ...tLines.map((l) => l.length));
  const K = 0.62, fitW = 0.84 * W;
  const fsT = Math.max(Math.round(W * 0.050), Math.min(base, Math.floor(fitW / (K * longest))));
  const sLines = sub ? String(sub).split("\n") : [];
  let s = "";
  // 1) lichte doorzichtige tint over het hele beeld, zodat heldere beelden de tekst niet wegspoelen
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#07131f" opacity="0.30"/>`;
  // 2) donkere afloop onderaan (waar vaak de meeste details zitten) voor extra contrast
  s += `<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#07131f" stop-opacity="0"/>
    <stop offset="0.55" stop-color="#07131f" stop-opacity="0.35"/>
    <stop offset="1" stop-color="#07131f" stop-opacity="0.85"/></linearGradient></defs>`;
  s += `<rect x="0" y="${Math.round(H * 0.45)}" width="${W}" height="${Math.round(H * 0.55)}" fill="url(#scrim)"/>`;
  // 3) donker paneel achter het tekstblok (titel + sub), afgerond, half doorzichtig: altijd leesbaar
  const nT = tLines.length, nS = sLines.length;
  const panTop = cy - Math.round(fsT * (nT / 2)) - Math.round(fsT * 0.95);
  const panBot = cy + Math.round(fsT * (nT / 2)) + (nS ? Math.round(fsS * (1.9 + nS * 1.25)) : Math.round(fsT * 0.3));
  const panX = Math.round(W * 0.085), panW = Math.round(W * 0.83);
  s += `<rect x="${panX}" y="${panTop}" width="${panW}" height="${Math.max(80, panBot - panTop)}" rx="28" fill="#07131f" opacity="0.62"/>`;
  // 4) lockup, cyaan tik, titel, sub (identiek aan de gewone kaart)
  s += wordmark(W, H, 1);
  s += `<rect x="${cx - 44}" y="${cy - Math.round(fsT * (nT / 2)) - 56}" width="88" height="6" rx="3" fill="${C.accent}"/>`;
  s += block(cx, cy, tLines, { fs: fsT, w: 800, fill: C.ink });
  if (nS) {
    const subY = cy + Math.round(fsT * (nT / 2)) + Math.round(fsS * 1.9);
    s += block(cx, subY, sLines, { fs: fsS, w: 500, fill: C.ink });
  }
  if (outro) s += markOnly(cx, Math.round(H * 0.70), Math.round(W * 0.15), 1);
  return root(W, H, s);
}
// Achtergrond-"kaart" voor een portaal-shot: UR-donker + lockup boven + een label onderaan. Het
// uitgeknipte verkoop-blok (lead-kaart, signaal, waarde, ...) komt hier GECENTREERD overheen, zo staat
// elk deel schoon en groot in beeld — isoleren i.p.v. een zachte zoom op de hele pagina.
function makeShotCardBg({ W, H, kicker }) {
  let s = bg(W, H);
  s += wordmark(W, H, 1);
  if (kicker) {
    const ky = Math.round(H * 0.85);
    s += `<rect x="${Math.round(W / 2 - 44)}" y="${ky - 54}" width="88" height="6" rx="3" fill="${C.accent}"/>`;
    s += `<text x="${W / 2}" y="${ky}" fill="${C.mut}" font-family="${SANS}" font-size="${Math.round(W * 0.042)}" font-weight="700" letter-spacing="3" text-anchor="middle">${esc(String(kicker).toUpperCase())}</text>`;
  }
  return root(W, H, s);
}
// SVG-kaart -> PNG (eigen UR-fonts, geen systeem-fonts), voor de ffmpeg-montage.
function rasterCard(svg, W, outPng) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { loadSystemFonts: false, fontFiles: UR_FONT_FILES } }).render().asPng();
  fs.writeFileSync(outPng, png);
}

// ---- TYPE: ROI, "Eén klant en 't is terugverdiend" (WAARDE vs kost) -----------------------
// De ECHTE pakketten (uit de verkooppagina, alle drie, niet één). Volume is het verschil.
const ROI_PAKKETTEN = [
  { naam: "Start", aantal: 40, prijs: 89 },
  { naam: "Groot", aantal: 100, prijs: 179, top: true },
  { naam: "Maximaal", aantal: 400, prijs: 599 },
];
const ROI_KLANT_MIN = 500, ROI_KLANT_MAX = 2500;   // wat één gewonnen klant per maand oplevert (SEO-traject)
function buildRoi({ opts, W, H, variant, durSec }) {
  const FPS = 30, SS = 1;
  const dur = Number(durSec) || Number(opts.durSec) || 16;   // duur volgt de stem (Truthward-stijl)
  const v = variant || UR_VARIANTS.roi[0];
  const b = UR_BEATS.roi.map((f) => f * dur);                // [hook, aanbod, pakketten, waarde, CTA]
  const cx = W / 2, fsHook = Math.round(W * 0.058), fsLbl = Math.round(W * 0.034);
  // elk beat verschijnt en verdwijnt weer vóór het volgende (één ding tegelijk, rustig)
  const beat = (i) => win(t_, b[i], b[i] + 0.6, b[i + 1] - 0.5, b[i + 1] - 0.15);
  let t_ = 0;
  function sceneAt(frame) {
    t_ = frame / FPS; const t = t_;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // 1) HOOK, de propositie
    s += block(cx, H * 0.40, v.hook, { fs: Math.round(W * 0.07), w: 800, fill: C.ink, op: beat(0) });
    // 2) AANBOD, geen lijst, een dossier met reden
    s += block(cx, H * 0.40, v.offer, { fs: fsHook, w: 800, fill: C.ink, op: beat(1) });
    // 3) PAKKETTEN, alle drie, volume is het verschil
    const pOp = beat(2);
    if (pOp > 0.001) {
      s += tx(cx, H * 0.22, "Kies je volume", { fs: fsLbl, w: 600, fill: C.mut, op: pOp });
      ROI_PAKKETTEN.forEach((p, i) => {
        const y = H * 0.36 + i * H * 0.13;
        const col = p.top ? C.accent : C.ink;
        s += tx(cx, y, p.aantal + " bedrijven   ·   " + eur(p.prijs) + " p/m",
          { fs: Math.round(W * 0.052), w: 800, fill: col, op: pOp });
        if (p.top) s += tx(cx, y + H * 0.035, "meest gekozen", { fs: Math.round(W * 0.028), w: 700, fill: C.accent, op: pOp });
      });
      s += tx(cx, H * 0.80, "een paar euro per bedrijf", { fs: fsLbl, w: 500, fill: C.mut, op: pOp });
    }
    // 4) WAARDE, wat één gewonnen klant per maand oplevert (echt, uit de pagina), groen
    const wOp = beat(3);
    if (wOp > 0.001) {
      s += tx(cx, H * 0.42, eur(ROI_KLANT_MIN) + " – " + eur(ROI_KLANT_MAX), { fs: Math.round(W * 0.11), w: 800, fill: C.green, op: wOp });
      s += block(cx, H * 0.52, v.valueLabel, { fs: fsLbl, w: 500, fill: C.mut, op: wOp });
    }
    // 5) CTA, laatste zin, blijft staan tot het eind (video stopt hierop)
    s += tx(cx, H * 0.50, v.cta, { fs: Math.round(W * 0.06), w: 800, fill: C.ink, op: win(t, b[4], b[4] + 0.6) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec: dur, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: GAT, "Het harde cijfer" -------------------------------------------------------
function buildGat({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const volume = Number(opts.volume) || 2900;
  const term = String(opts.term || "koerier");
  const stad = String(opts.stad || "Amsterdam");
  const cx = W / 2, fsBig = Math.round(W * 0.17), fsLbl = Math.round(W * 0.042);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // opbouw: het grote getal, dan de context, dan de klap.
    s += tx(cx, H * 0.42, new Intl.NumberFormat("nl-NL").format(volume), { fs: fsBig, w: 800, fill: "#ffffff", op: win(t, 0.6, 1.8) });
    s += block(cx, H * 0.56, [`people a month search for "${term}"`, `in ${stad}.`],
      { fs: fsLbl, w: 500, fill: C.mut, op: win(t, 1.8, 2.8) });
    // de klap
    const kOp = win(t, 5.0, 6.2);
    if (kOp > 0.001) {
      s += tx(cx, H * 0.70, "This business catches one.", { fs: Math.round(W * 0.055), w: 800, fill: C.accent, op: kOp });
    }
    s += block(cx, H * 0.84, ["The rest go to the competitor.", "You show the owner the number."],
      { fs: Math.round(W * 0.038), w: 600, fill: C.ink, op: win(t, 8.0, 9.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// Kleine motieven voor de nieuwe types (zelfde stijl: navy/cyaan/groen, kale SVG).
function ring(cx, cy, r, op) {
  let g = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${C.line}" stroke-width="3" opacity="${op.toFixed(3)}"/>`;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    g += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${Math.round(r * 0.11)}" fill="${C.accent}" opacity="${op.toFixed(3)}"/>`;
  }
  return g;
}

// ---- TYPE: KRING, "De kring uitgelegd" ----------------------------------------------------
function buildKring({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 17;
  const cx = W / 2, fsH = Math.round(W * 0.06), fsB = Math.round(W * 0.05), fsS = Math.round(W * 0.034);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    // 1 hook
    s += block(cx, H * 0.34, ["You only work", "half your market."], { fs: fsH, w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 3.2, 4.0) });
    // 2 de handel
    s += block(cx, H * 0.34, ["Every agency sits on leads", "it can't use itself."], { fs: fsB, w: 700, fill: C.ink, op: win(t, 4.2, 5.2, 7.4, 8.2) });
    // 3 de kring in beeld
    const ringOp = win(t, 8.4, 9.4, 12.6, 13.4);
    if (ringOp > 0.001) s += ring(cx, H * 0.40, Math.round(W * 0.2), ringOp);
    s += block(cx, H * 0.63, ["A closed circle.", "SEO · SEA · web · content · ads."], { fs: fsS, w: 600, fill: C.mut, op: win(t, 9.2, 10.2, 12.6, 13.4) });
    // 4 exclusiviteit
    s += block(cx, H * 0.40, ["Each dossier:", "3 weeks, yours alone."], { fs: fsB, w: 800, fill: C.accent, op: win(t, 13.0, 14.0) });
    // 5 CTA
    s += block(cx, H * 0.87, ["UncleRank, the circle.", "Try a week, free."], { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op: win(t, 15.2, 16.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// WAT WE PER VAKGEBIED METEN. De echte set signalen uit het dossier (meerdere per vak, niet één
// regel). Gedeeld door 'bureaus' (overzicht, cyclus) en 'signalen' (diep op één vak).
const VAK = {
  seo:     { naam: "SEO", sig: ["Ranks on page 4 for its own service", "Most of its searches go to rivals", "A homepage too thin to rank"] },
  sea:     { naam: "SEA", sig: ["No Google Ads running, for months", "No tracking, blind to what works", "A pricey-click market he's not in"] },
  web:     { naam: "Web", sig: ["Loads in 4+ seconds", "Falls apart on mobile", "A dated template build"] },
  content: { naam: "Content", sig: ["No blog, or one that died in 2022", "A homepage under 300 words", "Market questions left unanswered"] },
  reclame: { naam: "Ads & brand", sig: ["Advertises nowhere", "Nearly invisible on social", "A handful of weak reviews"] },
};
const VAK_ORDER = ["seo", "sea", "web", "content", "reclame"];

// ---- TYPE: BUREAUS, "Wat we per vak zien" (cyclus over de 5 vakgebieden) -------------------
function buildBureaus({ opts, W, H }) {
  const FPS = 30, SS = 1;
  const per = 2.6;                                   // tijd per vak op scherm
  const durSec = Number(opts.durSec) || Math.round(2.0 + VAK_ORDER.length * per + 2.5);
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["Five trades.", "For each, what we see."], { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 2.0, 2.6) });
    VAK_ORDER.forEach((k, i) => {
      const a = 2.4 + i * per;
      const op = win(t, a, a + 0.5, a + per - 0.3, a + per + 0.2);
      if (op <= 0.001) return;
      const v = VAK[k];
      s += tx(cx, H * 0.3, v.naam, { fs: Math.round(W * 0.09), w: 800, fill: C.accent, op });
      v.sig.forEach((line, j) => {
        s += tx(cx, H * 0.46 + j * H * 0.09, line, { fs: Math.round(W * 0.038), w: 500, fill: C.ink, op });
      });
    });
    s += tx(cx, H * 0.88, "Each sees only the leads that fit them.", { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 2.4 + VAK_ORDER.length * per + 0.2, 2.4 + VAK_ORDER.length * per + 1.2) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: SIGNALEN, diep op ÉÉN vak (opts.vak = seo/sea/web/content/reclame) --------------
function buildSignalen({ opts, W, H }) {
  const FPS = 30, SS = 1;
  const v = VAK[String(opts.vak || "seo").toLowerCase()] || VAK.seo;
  const durSec = Number(opts.durSec) || Math.round(2.0 + v.sig.length * 1.8 + 4);
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["What we find", "for " + v.naam + "."], { fs: Math.round(W * 0.058), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const y0 = H * 0.38, rh = H * 0.1;
    v.sig.forEach((line, i) => {
      const op = win(t, 2.2 + i * 1.8, 3.0 + i * 1.8);
      if (op <= 0.001) return;
      const y = y0 + i * rh;
      // gecentreerd (geen bullet) zodat lange regels netjes binnen beeld blijven
      s += tx(cx, y, line, { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op });
    });
    const endA = 2.2 + v.sig.length * 1.8 + 0.4;
    s += block(cx, H * 0.78, ["The flaws, already found.", "On every lead."], { fs: Math.round(W * 0.044), w: 800, fill: C.accent, op: win(t, endA, endA + 1.0) });
    s += block(cx, H * 0.92, ["UncleRank, try a week, free."], { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, endA + 1.6, endA + 2.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: ACTUEEL, "Altijd actueel" (dagelijkse verversing) ------------------------------
function buildActueel({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["Yesterday's lead list", "is already stale."], { fs: Math.round(W * 0.055), w: 800, fill: C.ink, op: win(t, 0.4, 1.4, 3.4, 4.2) });
    s += block(cx, H * 0.34, ["We re-check every site,", "every single day."], { fs: Math.round(W * 0.055), w: 800, fill: C.accent, op: win(t, 4.4, 5.4) });
    s += block(cx, H * 0.56, ["So the reason you call", "is today's reason -", "not last month's."], { fs: Math.round(W * 0.044), w: 600, fill: C.ink, op: win(t, 7.4, 8.4) });
    s += tx(cx, H * 0.82, "Fresh dossiers. Current flaws.", { fs: Math.round(W * 0.04), w: 700, fill: C.green, op: win(t, 10.4, 11.2) });
    s += tx(cx, H * 0.9, "UncleRank, the circle.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 11.6, 12.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: EXCLUSIEF, "3 weken exclusief" (schaarste) -------------------------------------
function buildExclusief({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const cx = W / 2, fsBig = Math.round(W * 0.15), fsLbl = Math.round(W * 0.04);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.28, ["A lead you get,", "no one else gets."], { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // het grote "3 weken" met een krimpende balk eronder
    const nOp = win(t, 2.6, 3.6);
    s += tx(cx, H * 0.5, "3 weeks", { fs: fsBig, w: 800, fill: C.accent, op: nOp });
    const barOp = win(t, 3.6, 4.2);
    if (barOp > 0.001) {
      const bw = W * 0.6, bx = cx - bw / 2, by = H * 0.56, bh = H * 0.018;
      const fill = clamp(1 - (t - 4.2) / 6);      // loopt langzaam leeg
      s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${C.line}" opacity="${barOp.toFixed(3)}"/>`;
      s += `<rect x="${bx}" y="${by}" width="${(bw * fill).toFixed(1)}" height="${bh}" rx="${bh / 2}" fill="${C.accent}" opacity="${barOp.toFixed(3)}"/>`;
    }
    s += tx(cx, H * 0.62, "yours alone", { fs: fsLbl, w: 500, fill: C.mut, op: win(t, 4.0, 4.8) });
    s += block(cx, H * 0.76, ["No bidding war.", "No shared inbox."], { fs: Math.round(W * 0.044), w: 700, fill: C.ink, op: win(t, 6.5, 7.5) });
    s += block(cx, H * 0.9, ["UncleRank, the circle."], { fs: Math.round(W * 0.038), w: 600, fill: C.mut, op: win(t, 10.5, 11.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: VOORNA, "Koude outreach vs warme kring" ---------------------------------------
function buildVoorna({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const colW = W * 0.42, lx = W * 0.27, rx = W * 0.73;
  const fsHd = Math.round(W * 0.042), fsLi = Math.round(W * 0.03);
  function column(x, title, lines, color, op, yTop) {
    if (op <= 0.001) return "";
    const bx = x - colW / 2, bh = H * 0.42, by = yTop;
    let g = `<rect x="${bx}" y="${by}" width="${colW}" height="${bh}" rx="18" fill="${color}" opacity="${(op * 0.1).toFixed(3)}"/>`
      + `<rect x="${bx}" y="${by}" width="${colW}" height="${bh}" rx="18" fill="none" stroke="${color}" stroke-width="2.5" opacity="${op.toFixed(3)}"/>`;
    g += tx(x, by + bh * 0.16, title, { fs: fsHd, w: 800, fill: color, op });
    lines.forEach((l, i) => { g += tx(x, by + bh * 0.36 + i * fsLi * 1.5, l, { fs: fsLi, w: 500, fill: C.ink, op }); });
    return g;
  }
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(W / 2, H * 0.2, "Two ways to fill your pipeline.", { fs: Math.round(W * 0.046), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const yTop = H * 0.3;
    s += column(lx, "Cold outreach", ["Lists you bought", "No reason to call", "Ignored, every time"], C.mut, win(t, 2.0, 3.0), yTop);
    s += column(rx, "The circle", ["A real flaw, named", "A reason to call", "3 weeks, yours"], C.accent, win(t, 3.6, 4.6), yTop);
    s += tx(W / 2, H * 0.84, "One of them actually picks up.", { fs: Math.round(W * 0.04), w: 700, fill: C.green, op: win(t, 7.0, 8.0) });
    s += tx(W / 2, H * 0.92, "UncleRank, try a week, free.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 9.5, 10.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: HOEHETWERKT, "Hoe het werkt" (3 stappen) --------------------------------------
function buildHoehetwerkt({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2, fsH = Math.round(W * 0.056), fsN = Math.round(W * 0.06), fsR = Math.round(W * 0.04);
  const steps = [
    ["1", "Pick your trade", "SEO, SEA, web, content or ads."],
    ["2", "Get your list", "Every morning, leads that fit you."],
    ["3", "Call with a reason", "Their flaw, named. Not a cold name."],
  ];
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.2, ["No lists.", "No scraping."], { fs: fsH, w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    const y0 = H * 0.36, rh = H * 0.16, x0 = W * 0.14;
    steps.forEach((st, i) => {
      const op = win(t, 2.2 + i * 2.0, 3.0 + i * 2.0);
      if (op <= 0.001) return;
      const y = y0 + i * rh;
      s += `<circle cx="${x0}" cy="${y - fsN * 0.3}" r="${Math.round(fsN * 0.62)}" fill="none" stroke="${C.accent}" stroke-width="3" opacity="${op.toFixed(3)}"/>`;
      s += tx(x0, y - fsN * 0.08, st[0], { fs: fsN, w: 800, fill: C.accent, op });
      s += tx(x0 + W * 0.1, y - fsN * 0.18, st[1], { fs: fsR, w: 800, fill: C.ink, op, anchor: "start" });
      s += tx(x0 + W * 0.1, y + fsR * 0.6, st[2], { fs: Math.round(fsR * 0.74), w: 500, fill: C.mut, op, anchor: "start" });
    });
    s += block(cx, H * 0.9, ["UncleRank, try a week, free."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 11.0, 12.0) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: BEZWAAR, "Is dit niet gewoon een lead-lijst?" ---------------------------------
function buildBezwaar({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["“Isn't this just", "another lead list?”"], { fs: Math.round(W * 0.055), w: 600, fill: C.mut, op: win(t, 0.4, 1.4, 3.6, 4.4) });
    s += tx(cx, H * 0.34, "No.", { fs: Math.round(W * 0.14), w: 800, fill: "#ffffff", op: win(t, 4.6, 5.6) });
    const lines = [
      ["Every lead comes with its flaw.", 7.0],
      ["A reason to call, not a name.", 8.6],
      ["3 weeks, yours alone.", 10.2],
    ];
    lines.forEach((l, i) => {
      s += tx(cx, H * 0.52 + i * H * 0.08, l[0], { fs: Math.round(W * 0.042), w: 700, fill: i === 2 ? C.accent : C.ink, op: win(t, l[1], l[1] + 0.9) });
    });
    s += block(cx, H * 0.88, ["UncleRank, the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 11.8, 12.6) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: MANKEMENT, "Een naam is geen lead" (cyclus van gebreken) -----------------------
function buildMankement({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  const flaws = ["Ranks on page 4.", "No ads in 8 months.", "A template site.", "A blog that died in 2022."];
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.24, ["A name is", "not a lead."], { fs: Math.round(W * 0.062), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // elk gebrek apart in/uit, midden op het scherm
    flaws.forEach((f, i) => {
      const a = 2.6 + i * 1.7;
      s += tx(cx, H * 0.5, f, { fs: Math.round(W * 0.056), w: 800, fill: C.accent, op: win(t, a, a + 0.5, a + 1.1, a + 1.6) });
    });
    s += block(cx, H * 0.72, ["Every one -", "a reason to call."], { fs: Math.round(W * 0.05), w: 800, fill: "#ffffff", op: win(t, 9.8, 10.8) });
    s += block(cx, H * 0.9, ["UncleRank, the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 12.5, 13.3) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: REKENSOM, "Wat kost een warme lead hier?" -------------------------------------
function buildRekensom({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 14;
  const kostMnd = Number(opts.kostMnd) || 89;
  const dossiers = Number(opts.dossiers) || 60;
  const per = kostMnd / dossiers;
  const cx = W / 2, fsBig = Math.round(W * 0.1);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.24, ["What does a warm", "lead cost you here?"], { fs: Math.round(W * 0.052), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += tx(cx, H * 0.44, eur(kostMnd) + " / month", { fs: fsBig, w: 800, fill: "#cdd9e6", op: win(t, 2.6, 3.6) });
    s += tx(cx, H * 0.55, "÷ ~" + dossiers + " dossiers a month", { fs: Math.round(W * 0.04), w: 500, fill: C.mut, op: win(t, 4.4, 5.4) });
    s += tx(cx, H * 0.68, "under " + eur(Math.ceil(per)) + " a lead", { fs: Math.round(W * 0.09), w: 800, fill: C.green, op: win(t, 6.6, 7.6) });
    s += block(cx, H * 0.84, ["One call closes.", "The math is already done."], { fs: Math.round(W * 0.04), w: 600, fill: C.ink, op: win(t, 9.4, 10.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: GRATISWEEK, het aanbod / CTA --------------------------------------------------
function buildGratisweek({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 12;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.3, ["A week", "in the circle."], { fs: Math.round(W * 0.08), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += tx(cx, H * 0.5, "Free. No card today.", { fs: Math.round(W * 0.05), w: 700, fill: C.accent, op: win(t, 2.6, 3.6) });
    s += block(cx, H * 0.62, ["See your leads", "before you pay a cent."], { fs: Math.round(W * 0.04), w: 500, fill: C.mut, op: win(t, 4.4, 5.4) });
    // knop
    const bOp = win(t, 6.8, 7.8);
    if (bOp > 0.001) {
      const bw = W * 0.62, bh = H * 0.082, bx = cx - bw / 2, by = H * 0.76;
      s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${bh * 0.3}" fill="${C.accent}" opacity="${bOp.toFixed(3)}"/>`;
      s += tx(cx, by + bh * 0.66, "Start free →", { fs: Math.round(W * 0.045), w: 800, fill: "#04121c", op: bOp });
    }
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: OMDRAAI, de pivot (scan-tool -> lead-lijst voor bureaus) ----------------------
function buildOmdraai({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.3, ["Most tools tell the owner", "what's wrong with his site."], { fs: Math.round(W * 0.05), w: 600, fill: C.mut, op: win(t, 0.4, 1.4, 3.8, 4.6) });
    s += tx(cx, H * 0.34, "We flipped it.", { fs: Math.round(W * 0.1), w: 800, fill: C.accent, op: win(t, 4.8, 5.8) });
    s += block(cx, H * 0.56, ["Now the agency gets the list:", "who to call, and why."], { fs: Math.round(W * 0.046), w: 700, fill: C.ink, op: win(t, 7.4, 8.4) });
    s += block(cx, H * 0.74, ["Their flaw, already found.", "Your opening line, already written."], { fs: Math.round(W * 0.036), w: 500, fill: C.mut, op: win(t, 10.0, 11.0) });
    s += block(cx, H * 0.9, ["UncleRank, the circle."], { fs: Math.round(W * 0.036), w: 600, fill: C.mut, op: win(t, 12.6, 13.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: VOLUME, "elke ochtend nieuwe dossiers" (tellende cijfer) -----------------------
function buildVolume({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 13;
  const target = Number(opts.aantal) || 10;
  const cx = W / 2, fsBig = Math.round(W * 0.2);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(cx, H * 0.3, "Every morning:", { fs: Math.round(W * 0.056), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    // het getal telt op van 0 naar target
    const nOp = win(t, 2.0, 2.8);
    if (nOp > 0.001) {
      const n = Math.round(target * smooth(clamp((t - 2.2) / 1.6)));
      s += tx(cx, H * 0.5, String(n), { fs: fsBig, w: 800, fill: "#ffffff", op: nOp });
    }
    s += block(cx, H * 0.62, ["new dossiers.", "Already checked."], { fs: Math.round(W * 0.044), w: 600, fill: C.accent, op: win(t, 4.4, 5.4) });
    s += block(cx, H * 0.8, ["You don't hunt.", "You just pick up the phone."], { fs: Math.round(W * 0.042), w: 700, fill: C.ink, op: win(t, 7.0, 8.0) });
    s += block(cx, H * 0.92, ["UncleRank, try a week, free."], { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 10.0, 10.8) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: DELEN, "Delen loont" (de give-and-take van de kring) --------------------------
function buildDelen({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 15;
  const cx = W / 2;
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += block(cx, H * 0.26, ["You spot a flaw", "that isn't your trade."], { fs: Math.round(W * 0.052), w: 800, fill: C.ink, op: win(t, 0.4, 1.4) });
    s += block(cx, H * 0.46, ["Pass it to the circle.", "We make the intro."], { fs: Math.round(W * 0.05), w: 700, fill: C.accent, op: win(t, 3.2, 4.2) });
    s += block(cx, H * 0.64, ["Share, and you move up -", "hot leads come back to you."], { fs: Math.round(W * 0.042), w: 600, fill: C.ink, op: win(t, 6.4, 7.4) });
    s += tx(cx, H * 0.82, "Everyone feeds the pot they eat from.", { fs: Math.round(W * 0.036), w: 700, fill: C.green, op: win(t, 10.0, 11.0) });
    s += tx(cx, H * 0.9, "UncleRank, the circle.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 11.8, 12.6) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

// ---- TYPE: RESULTAAT, "Eén telefoontje" (de hele loop) -----------------------------------
function buildResultaat({ opts, W, H }) {
  const FPS = 30, SS = 1, durSec = Number(opts.durSec) || 12;
  const cx = W / 2, fs = Math.round(W * 0.062);
  function sceneAt(frame) {
    const t = frame / FPS;
    let s = bg(W, H) + wordmark(W, H, win(t, 0.2, 1.0));
    s += tx(cx, H * 0.32, "One flaw, named.", { fs, w: 800, fill: C.ink, op: win(t, 0.6, 1.6) });
    s += tx(cx, H * 0.46, "One call that lands.", { fs, w: 800, fill: C.ink, op: win(t, 2.6, 3.6) });
    s += tx(cx, H * 0.6, "One new client.", { fs: Math.round(W * 0.072), w: 800, fill: C.accent, op: win(t, 4.6, 5.6) });
    s += block(cx, H * 0.78, ["That's the whole loop.", "No cold lists. No luck."], { fs: Math.round(W * 0.04), w: 600, fill: C.mut, op: win(t, 7.4, 8.4) });
    s += tx(cx, H * 0.9, "UncleRank, try a week, free.", { fs: Math.round(W * 0.034), w: 600, fill: C.mut, op: win(t, 9.6, 10.4) });
    return root(W, H, s);
  }
  return { W, H, FPS, SS, durSec, sceneAt, music: null, clicks: [] };
}

export function makeBrand({ ROOT, config } = {}) {
  loadMark(ROOT);   // UR-mark eenmalig inladen als data-URI (voor het woordmerk/lockup)
  const branding = { navy: C.bg0, accent: C.accent };
  // DE VIJF THEMA'S (Mo's indeling, 19 nov). Elk thema is één type met een eigen variant-pool die
  // rouleert (blijvende anti-herhaling), zodat geen twee renders gelijk zijn. "Het aanbod" gebruikt de
  // portaal-opname als beeld; de andere vier zijn kaart-montages (tekstkaarten + stem). De oude losse
  // type-builders (gat, bureaus, bezwaar, mankement, omdraai, exclusief, voorna, volume, signalen,
  // actueel, delen, resultaat, rekensom, gratisweek, roi, hoehetwerkt) blijven als code staan maar zijn
  // uit de studio-lijst; hun inhoud is opgegaan in de thema-pools hierboven (UR_VARIANTS).
  const templates = [
    { id: "aanbod",   name: "Het aanbod (verse leads)",        music: [], defaults: {} },
    { id: "vak",      name: "Voor jouw vak (per discipline)",  music: [], defaults: {} },
    { id: "geenlijst", name: "Geen koude lijst",               music: [], defaults: {} },
    { id: "kring",    name: "De kring (exclusief)",            music: [], defaults: {} },
    { id: "hoewerkt", name: "Hoe het werkt",                   music: [], defaults: {} },
    { id: "ondernemer", name: "De ondernemer (ervaring)",      music: [], defaults: {} },
  ];
  // De Studio wil een onderwerp kunnen kiezen; UncleRank is type-gedreven, dus één dummy-onderwerp.
  async function listSubjects() { return [{ id: "ur", thumb: null }]; }
  async function pickMusic() { return null; }   // eerst stil renderen; muziek/stem komt erbij

  // PORTAAL-MONTAGE: de schermopname is AANVULLEND, niet het hele filmpje. Opbouw = tekstkaart (intro)
  // -> stukje opname -> tekstkaart -> stukje opname -> tekstkaart -> stukje opname -> slot-kaart. De
  // opname (lijst -> hot lead -> dossier, data al vervaagd door de recorder) wordt in 3 stukjes geknipt
  // en tussen de kaarten gezet; een NL-vertelstem loopt eroverheen. Verhaal = momentopname vs. dagelijks
  // meten over tijd (GEEN leadlijst). Contenttoon: geen muziek. Levert een kant-en-klare mp4 via
  // { prebuilt }. Draait lokaal (browser + login + Chatterbox). Faalt een stap, dan degradeert hij netjes.
  async function makePortalRender({ opts = {}, format = "9:16", log }) {
    const node = process.execPath;
    const PY = process.env.UR_PYTHON || "python";
    const recorder = path.resolve(ROOT, "tools/portal-capture.mjs");
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const FPS = 30;
    const outDir = (config && config.outDir) ? config.outDir : "out";
    const work = path.resolve(ROOT, outDir, ".portal-" + Date.now());
    await fs.promises.mkdir(work, { recursive: true });
    const final = path.join(work, "portal-final.mp4");
    const ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-preset", "veryfast"];

    // 0) kies een VERSE variant (andere invalshoek dan recent), blijvend over renders heen. Elke
    //    variant heeft z'n eigen stem (eigen voice-map vXX) én z'n eigen kaarten.
    const POOL = UR_VARIANTS.portaal || [];
    const vi = pickFreshVariant(ROOT, "portaal", POOL.length);
    const variant = POOL[vi] || {};
    const CARDS = Array.isArray(variant.cards) && variant.cards.length ? variant.cards : [];
    if (log) log(`● variant ${String.fromCharCode(65 + vi)} van ${POOL.length} gekozen`);

    // 1) NL-stem genereren (de vertelling). Duur bepaalt de totale lengte; de opname-stukjes volgen.
    let voiceWav = "", T = Number(opts.seconds) || 20, TL = null;
    try {
      const vdir = voiceDir(ROOT, "portaal", vi);
      const wavp = path.join(vdir, "voice.wav");
      const linesFile = path.join(vdir, "_lines.json");
      const wantLines = (variant && Array.isArray(variant.voice)) ? JSON.stringify(variant.voice) : "";
      let haveLines = null; try { haveLines = await fs.promises.readFile(linesFile, "utf8"); } catch {}
      if ((opts.versStem) || !fs.existsSync(wavp) || (wantLines && haveLines !== wantLines)) {
        await fs.promises.mkdir(vdir, { recursive: true });
        if (wantLines) await fs.promises.writeFile(linesFile, wantLines, "utf8");
        if (log) log("● UR-stem genereren (het aanbod, NL), dit duurt even…");
        const args = [path.resolve(ROOT, "tools/ur_voice.py"), "--type", "portaal", "--variant", String(vi), "--root", ROOT];
        if (wantLines) args.push("--lines", linesFile);
        if (opts.voice) args.push("--voice", String(opts.voice));
        await runStreamed(PY, args, { ...process.env, FFMPEG }, log, "· stem:");
      }
      if (fs.existsSync(wavp)) {
        voiceWav = wavp;
        try { const tl = JSON.parse(await fs.promises.readFile(path.join(vdir, "_timeline.json"), "utf8")); if (tl && tl.total) { T = Number(tl.total); TL = tl; } } catch {}
      }
    } catch (e) { if (log) log("stem-stap overgeslagen: " + e.message); }

    // 2) duur per onderdeel uit de gewichten in PORTAAL_SEQUENCE. Kaarten en opname-stukjes krijgen
    //    een leesbare bodem. De opname nemen we precies zo lang op als de opname-stukjes samen.
    const SEQ = PORTAAL_SEQUENCE;
    const sumW = SEQ.reduce((a, s) => a + (s.w || 1), 0);
    const FLOOR = { card: 2.3, clip: 2.6 };
    const durOf = SEQ.map((s) => Math.max(FLOOR[s.kind] || 2.3, +(((s.w || 1) / sumW) * T).toFixed(2)));
    const clipDurs = SEQ.map((s, k) => (s.kind === "clip" ? durOf[k] : 0)).filter((d) => d > 0);
    const clipsTotal = Math.max(10, +clipDurs.reduce((a, d) => a + d, 0).toFixed(2));

    // 3) opname van het portaal (ingelogd via opgeslagen state), lengte = de opname-stukjes samen
    const stateCand = opts.state || process.env.UR_PORTAL_STATE || path.resolve(ROOT, "assets/unclerank/portal-state.json");
    const recEnv = {
      ...process.env, FFMPEG,
      UR_OUT: work, UR_W: String(W), UR_H: String(H),
      UR_PORTAL_URL: (opts.url || process.env.UR_PORTAL_URL || "https://portaal.unclerank.com"),
      UR_SECONDS: String(Math.round(clipsTotal)),
    };
    try { if (stateCand && fs.existsSync(stateCand)) recEnv.UR_PORTAL_STATE = stateCand; } catch {}
    if (log) log("● portaal-opname van de live site…");
    const raw = path.join(work, "portal-walkthrough.mp4");
    const r1 = await runStreamed(node, [recorder], recEnv, log, "· opname:");
    const haveRec = (r1.status === 0 && fs.existsSync(raw));
    // gerichte stills (de slimme weg: push-in op de verkoop-delen). Maakte de recorder ze, dan gebruiken
    // we die; anders vallen we terug op stukjes uit de walkthrough-opname, of op alleen tekstkaarten.
    let SHOTS = [];
    try {
      const sj = JSON.parse(await fs.promises.readFile(path.join(work, "portal-shots.json"), "utf8"));
      SHOTS = (sj.shots || []).map((s) => ({ ...s, path: path.join(work, s.file) })).filter((s) => fs.existsSync(s.path));
    } catch {}
    const haveShots = SHOTS.length > 0;
    if (haveShots && log) log(`● ${SHOTS.length} gerichte beelden gevonden — push-in op de verkoop-delen`);
    else if (!haveRec && log) log("opname faalde, montage met alleen tekstkaarten");

    // 4) segment-helpers (allemaal zelfde codec/res/fps -> veilig aan elkaar te plakken)
    async function cardSeg(card, dur, i) {
      try {
        const png = path.join(work, `card-${i}-${card.key}.png`);
        rasterCard(makeCardSvg({ W, H, title: card.title, sub: card.sub, outro: !!card.outro }), W, png);
        const mp4 = path.join(work, `seg-${String(i).padStart(2, "0")}-card.mp4`);
        const r = await runStreamed(FFMPEG, ["-y", "-v", "error", "-loop", "1", "-t", String(dur), "-i", png,
          "-vf", `scale=${W}:${H},fps=${FPS},format=yuv420p`, ...ENC, mp4], { ...process.env }, log, "· kaart:");
        if (r.status === 0 && fs.existsSync(mp4)) return mp4;
      } catch (e) { if (log) log("kaart overgeslagen: " + e.message); }
      return null;
    }
    async function clipSeg(startSec, dur, i) {
      if (!haveRec) return null;
      try {
        const mp4 = path.join(work, `seg-${String(i).padStart(2, "0")}-clip.mp4`);
        const r = await runStreamed(FFMPEG, ["-y", "-v", "error", "-ss", String(startSec), "-t", String(dur), "-i", raw,
          "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p`,
          "-an", ...ENC, mp4], { ...process.env }, log, "· clip:");
        if (r.status === 0 && fs.existsSync(mp4)) return mp4;
      } catch (e) { if (log) log("clip overgeslagen: " + e.message); }
      return null;
    }
    // Basiszoom: het blok VULT de breedte (kleine marge), met een hoogte-rem zodat een hoog blok niet
    // overloopt. De portaal-blokken zijn bijna schermbreed, dus zonder deze aanpak zou de zoom te zacht
    // zijn om op te vallen. Vloer 1.22 (altijd duidelijk ingezoomd), plafond 2.1 (smal blok = dieper).
    function adaptiveZoom(r) {
      const zW = W / Math.max(1, r.w + 0.015 * W);
      const zH = H / Math.max(1, r.h + 0.06 * H);
      return Math.max(1.22, Math.min(2.1, Math.min(zW, zH)));
    }
    // push-in op een stilstaand portaal-beeld richting het verkoop-deel (ffmpeg zoompan). De camera
    // begint AL op het blok (schermvullend) en duwt nog iets verder in, i.p.v. vanaf de volle pagina —
    // zo zie je meteen het deel dat telt. De blur zit in de pixels, dus ingezoomd blijft data vervaagd.
    // labels onder het uitgeknipte blok, per type shot
    const SHOT_KICKER = { lead: "Een verse lead", lead2: "Een verse lead", "dossier-kop": "Het dossier",
      signaal: "Wat we op de site zien", waarde: "Wat de klus waard is" };
    async function pushinSeg(shot, dur, i) {
      try {
        if (!shot || !fs.existsSync(shot.path)) return null;
        const r = shot.rect || { x: 0, y: 0, w: W, h: H };
        // 1) de EXACTE box van het blok (licht gepad, geklemd op het beeld)
        const pad = Math.round(0.012 * W);
        let bx = Math.max(0, Math.round(r.x - pad)), by = Math.max(0, Math.round(r.y - pad));
        let bw = Math.min(W - bx, Math.round(r.w + 2 * pad)), bh = Math.min(H - by, Math.round(r.h + 2 * pad));
        bw -= bw % 2; bh -= bh % 2;
        if (bw < 24 || bh < 24) return null;
        // 2) doelgrootte op de kaart: breed vullen, maar niet te hoog (ruimte voor lockup + label)
        const maxW = Math.round(W * 0.90), maxH = Math.round(H * 0.60);
        let sw = maxW, sh = Math.round(bh * (maxW / bw));
        if (sh > maxH) { sh = maxH; sw = Math.round(bw * (maxH / bh)); }
        sw -= sw % 2; sh -= sh % 2;
        const oy = Math.round((H - sh) / 2 + H * 0.03);     // iets onder het midden
        // 3) achtergrond-kaart (UR-donker + lockup + label) en het blok erop, met zachte push voor leven
        const bgPng = path.join(work, `shotbg-${String(i).padStart(2, "0")}.png`);
        rasterCard(makeShotCardBg({ W, H, kicker: SHOT_KICKER[shot.name] || "Uit het portaal" }), W, bgPng);
        // STILSTAAND: geen zoompan-push (die rondt per frame af en laat de scherpe tekst trillen).
        // Het blok staat schoon op de kaart; de montage-cuts geven het ritme.
        const fc = `[0:v]crop=${bw}:${bh}:${bx}:${by},scale=${sw}:${sh},drawbox=x=0:y=0:w=iw:h=ih:color=0x24405c@1:t=3[blk];`
          + `[1:v][blk]overlay=(W-w)/2:${oy}:format=auto,fps=${FPS},setsar=1,format=yuv420p[v]`;
        const mp4 = path.join(work, `seg-${String(i).padStart(2, "0")}-shot.mp4`);
        const r2 = await runStreamed(FFMPEG, ["-y", "-v", "error",
          "-framerate", String(FPS), "-loop", "1", "-t", String(dur), "-i", shot.path,
          "-framerate", String(FPS), "-loop", "1", "-t", String(dur), "-i", bgPng,
          "-filter_complex", fc, "-map", "[v]", ...ENC, mp4], { ...process.env }, log, "· inzoom:");
        if (r2.status === 0 && fs.existsSync(mp4)) return mp4;
      } catch (e) { if (log) log("inzoom overgeslagen: " + e.message); }
      return null;
    }

    // 5) de montage opbouwen. MET gerichte beelden: de kaarten zijn de ruggengraat en de push-ins
    //    komen op de plek waar ze iets bewijzen — de lead-kaarten na "de oplossing", de dossier-
    //    blokken (waarom nu / signaal / waarde) na "de waarde". ZONDER: de oude volgorde met stukjes
    //    uit één walkthrough. Faalt een onderdeel, dan valt het stil weg; de rest loopt door.
    if (log) log("● montage bouwen…");
    const segs = []; const push = (p) => { if (p) segs.push(p); };
    // ÉÉN onderdeel per stemregel (kaart i hoort bij regel i). Heeft een kaart een shot-slot
    // (card.shot = "lead"/"signaal"/...) én is dat portaal-beeld opgehaald, dan tonen we dáár het
    // uitgeknipte portaal-blok i.p.v. de tekstkaart; anders gewoon de tekstkaart (volwaardige terugval).
    // Elk onderdeel duurt precies zo lang als z'n regel + adem -> beeld en stem lopen gelijk, en de
    // lengte van de video volgt de (nu langere) stem. Zo niet beschikbaar: oude walkthrough-cut.
    const perLine = CARDS.length > 0;
    if (perLine) {
      const shotByName = {}; for (const s of SHOTS) shotByName[s.name] = s;
      const lineDur = (TL && Array.isArray(TL.lines) && TL.lines.length >= CARDS.length)
        ? TL.lines.map((l) => Number(l.dur) || 0) : null;
      for (let i = 0; i < CARDS.length; i++) {
        const card = CARDS[i] || {};
        const dur = lineDur ? Math.max(1.8, +Number(lineDur[i] || 0).toFixed(2))
                            : Math.max(2.4, +(T / CARDS.length).toFixed(2));
        const shot = card.shot ? shotByName[card.shot] : null;
        if (shot) push(await pushinSeg(shot, dur, i));
        else push(await cardSeg(card, dur, i));
      }
    } else {
      let clipAt = 0;
      for (let i = 0; i < SEQ.length; i++) {
        const s = SEQ[i];
        if (s.kind === "card") {
          push(await cardSeg(CARDS[s.i] || {}, durOf[i], i));
        } else {
          push(await clipSeg(clipAt, durOf[i], i));
          clipAt += durOf[i];
        }
      }
    }

    // 6) alles aan elkaar plakken. Lukt er niets, degradeer naar opname (met/zonder stem) of hard falen.
    let base = "";
    if (segs.length >= 2) {
      const montage = path.join(work, "portal-montage.mp4");
      const listFile = path.join(work, "concat.txt");
      await fs.promises.writeFile(listFile, segs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
      const rc = await runStreamed(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, ...ENC, montage], { ...process.env }, log, "· plakken:");
      base = (rc.status === 0 && fs.existsSync(montage)) ? montage : (segs[0] || "");
    } else if (segs.length === 1) {
      base = segs[0];
    }
    if (!base) {                                                                // geen enkel segment -> val terug op de kale opname
      if (!haveRec) throw new Error("portaal-opname faalde én geen tekstkaarten, draait de engine op de machine met de browser en is het portaal bereikbaar?");
      base = raw;
    }

    // 7) vertelstem over de montage (stem is al luid genormaliseerd; geen muziek). De VIDEO is leidend:
    // apad vult de stem met stilte tot het einde, zodat de slot-kaart blijft staan. Mix faalt -> stil.
    if (voiceWav && fs.existsSync(voiceWav)) {
      if (log) log("● vertelstem over de montage leggen…");
      const r2 = await runStreamed(FFMPEG, ["-y", "-v", "error", "-i", base, "-i", voiceWav,
        "-filter_complex", "[1:a]apad[a]", "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-shortest", final], { ...process.env }, log, "· mix:");
      if (r2.status !== 0) { if (log) log("mix faalde, montage zonder stem"); await fs.promises.copyFile(base, final); }
    } else {
      await fs.promises.copyFile(base, final);
    }

    return { prebuilt: final, music: "", lang: "nl", cleanup: work };
  }

  // KAART-MONTAGE voor de thema's zonder opname (Voor jouw vak, Geen koude lijst, De kring, Hoe het
  // werkt). Zelfde bewezen kaartlogica als "Het aanbod", maar zonder recorder: kies een verse variant
  // (blijvende anti-herhaling), spreek de stem in, render elke kaart, plak ze, leg de stem erover. De
  // video volgt de stem. Elke variant heeft eigen stem (eigen vXX-map) én eigen kaarten.
  async function makeCardMontageRender(templateId, { opts = {}, format = "9:16", log } = {}) {
    const PY = process.env.UR_PYTHON || "python";
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    const FPS = 30;
    const outDir = (config && config.outDir) ? config.outDir : "out";
    const work = path.resolve(ROOT, outDir, "." + templateId + "-" + Date.now());
    await fs.promises.mkdir(work, { recursive: true });
    const final = path.join(work, templateId + "-final.mp4");
    const ENC = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-preset", "veryfast"];

    // 0) verse variant
    const POOL = UR_VARIANTS[templateId] || [];
    const vi = pickFreshVariant(ROOT, templateId, POOL.length);
    const variant = POOL[vi] || {};
    const CARDS = Array.isArray(variant.cards) && variant.cards.length ? variant.cards : [];
    if (log) log(`● ${templateId}: variant ${vi + 1} van ${POOL.length} gekozen`);
    if (!CARDS.length) throw new Error("geen kaarten voor " + templateId + " variant " + vi);

    // 1) stem (eigen mapje per variant); de duur bepaalt de totale lengte
    let voiceWav = "", T = Number(opts.seconds) || 18, TL = null;
    try {
      const vdir = voiceDir(ROOT, templateId, vi);
      const wavp = path.join(vdir, "voice.wav");
      const linesFile = path.join(vdir, "_lines.json");
      const wantLines = Array.isArray(variant.voice) ? JSON.stringify(variant.voice) : "";
      let haveLines = null; try { haveLines = await fs.promises.readFile(linesFile, "utf8"); } catch {}
      if ((opts.versStem) || !fs.existsSync(wavp) || (wantLines && haveLines !== wantLines)) {
        await fs.promises.mkdir(vdir, { recursive: true });
        if (wantLines) await fs.promises.writeFile(linesFile, wantLines, "utf8");
        if (log) log("● UR-stem genereren (" + templateId + ", NL), dit duurt even…");
        const args = [path.resolve(ROOT, "tools/ur_voice.py"), "--type", templateId, "--variant", String(vi), "--root", ROOT];
        if (wantLines) args.push("--lines", linesFile);
        if (opts.voice) args.push("--voice", String(opts.voice));
        await runStreamed(PY, args, { ...process.env, FFMPEG }, log, "· stem:");
      }
      if (fs.existsSync(wavp)) {
        voiceWav = wavp;
        try { const tl = JSON.parse(await fs.promises.readFile(path.join(vdir, "_timeline.json"), "utf8")); if (tl && tl.total) { T = Number(tl.total); TL = tl; } } catch {}
      }
    } catch (e) { if (log) log("stem-stap overgeslagen: " + e.message); }

    // 1b) BEELD (optioneel; alleen thema's met een 'queries'-lijst, nu: de kring). Per kaart zoekt
    //     tools/ur_beeld.py op basis van het script rechtenvrij beeld (video via Pixabay/Pexels, anders
    //     een foto via Wikimedia) en zet het klaar. Dat beeld komt ONDER de tekst te liggen (zelfde
    //     logica als Truthward). ADDITIEF: vindt een zoekterm niks, of draait dit zonder internet (cloud),
    //     dan staat die kaart simpelweg niet in de manifest en valt hij terug op de gewone tekstkaart.
    const BEELD_PER = 5;                 // hoeveel beelden per kaart klaargezet worden om uit te rouleren
    const beeldPoolByIdx = {};           // i -> [{kind, path}, ...]  (de poel per kaart)
    const hasQ = (q) => (Array.isArray(q) ? q.some((x) => (x || "").trim()) : (q || "").trim());
    const QUERIES = Array.isArray(variant.queries) ? variant.queries : null;
    if (QUERIES && QUERIES.some(hasQ)) {
      try {
        const bdir = path.resolve(ROOT, "assets", "unclerank", "beeld", templateId, "v" + vi);
        const qFile = path.join(bdir, "_queries.json");
        const manFile = path.join(bdir, "_beeld.json");
        const wantQ = JSON.stringify({ queries: QUERIES, per: BEELD_PER });
        let haveQ = null; try { haveQ = await fs.promises.readFile(qFile, "utf8"); } catch {}
        // ophalen gebeurt ÉÉN keer (poel gecachet). Alleen opnieuw zoeken als het nog niet bestaat
        // of de zoektermen zijn gewijzigd. De rotatie zelf gebeurt per render, uit de gecachete poel.
        if (opts.versBeeld || !fs.existsSync(manFile) || haveQ !== wantQ) {
          if (log) log("● beeld zoeken (" + templateId + ", rechtenvrij), dit kan even duren…");
          const bargs = [path.resolve(ROOT, "tools/ur_beeld.py"), "--type", templateId,
            "--variant", String(vi), "--queries", JSON.stringify(QUERIES), "--per", String(BEELD_PER), "--root", ROOT];
          try { await runStreamed(PY, bargs, { ...process.env, FFMPEG }, log, "· beeld:"); }
          catch (e) { if (log) log("beeld-stap overgeslagen: " + e.message); }
        }
        const man = JSON.parse(await fs.promises.readFile(manFile, "utf8"));
        for (const it of (man.items || [])) {
          const pool = (it.media || [])
            .map((m) => ({ kind: m.kind, path: path.join(bdir, m.file) }))
            .filter((m) => fs.existsSync(m.path));
          if (pool.length) beeldPoolByIdx[it.i] = pool;
        }
        const nB = Object.keys(beeldPoolByIdx).length;
        const nTot = Object.values(beeldPoolByIdx).reduce((a, p) => a + p.length, 0);
        if (log && nB) log(`● ${nB} kaart(en) met beeld (${nTot} in de poel, rouleert per render); de rest blijft tekst`);
      } catch (e) { if (log) log("beeld overgeslagen (alles tekst): " + e.message); }
    }

    // 2) duur per kaart. Kaart i hoort bij stemregel i, dus als de stem per-regel timing meegeeft (nieuwe
    //    ur_voice: elke regel apart ingesproken met een pauze), zetten we elke kaart precies zo lang als
    //    z'n regel + adem -> beeld en stem lopen gelijk. Anders eerlijk verdeeld over de totale duur.
    const nC = CARDS.length;
    let durs;
    if (TL && Array.isArray(TL.lines) && TL.lines.length >= nC) {
      durs = CARDS.map((_, i) => Math.max(1.8, +(Number(TL.lines[i].dur) || 0).toFixed(2)));
    } else {
      const wts = CARDS.map((_, i) => (i === 0 ? 1.25 : i === nC - 1 ? 1.2 : 1.0));
      const sumW = wts.reduce((a, b) => a + b, 0);
      durs = wts.map((w) => Math.max(2.4, +((w / sumW) * T).toFixed(2)));
    }

    // 3) elke kaart -> segment (zelfde codec/res/fps)
    if (log) log("● kaarten renderen…");
    const segs = [];
    for (let i = 0; i < CARDS.length; i++) {
      const card = CARDS[i] || {};
      const mp4 = path.join(work, `seg-${String(i).padStart(2, "0")}.mp4`);
      // verse keuze uit de poel van deze kaart (zelfde blijvende anti-herhaling als de varianten),
      // zodat dezelfde variant bij elke render ander beeld krijgt zonder dat iemand iets aanpast
      const pool = beeldPoolByIdx[i];
      const media = (pool && pool.length) ? pool[pickFreshVariant(ROOT, `${templateId}:beeld:v${vi}:c${i}`, pool.length)] : null;
      let done = false;
      // a) MET beeld eronder: scale/crop naar 9:16, bijschrift (transparant + scrim) erover
      if (media) {
        try {
          const cap = path.join(work, `cap-${String(i).padStart(2, "0")}.png`);
          rasterCard(makeCaptionSvg({ W, H, title: card.title, sub: card.sub, outro: !!card.outro }), W, cap);
          const inArgs = media.kind === "vid"
            ? ["-stream_loop", "-1", "-t", String(durs[i]), "-i", media.path]   // video loopt tot de kaartduur
            : ["-loop", "1", "-t", String(durs[i]), "-i", media.path];          // foto blijft staan
          const fc = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1[bg];`
                   + `[bg][1:v]overlay=0:0:format=auto,format=yuv420p[v]`;
          const r = await runStreamed(FFMPEG, ["-y", "-v", "error", ...inArgs, "-i", cap,
            "-filter_complex", fc, "-map", "[v]", "-t", String(durs[i]), ...ENC, mp4], { ...process.env }, log, "· beeldkaart:");
          if (r.status === 0 && fs.existsSync(mp4)) { segs.push(mp4); done = true; }
        } catch (e) { if (log) log("beeldkaart faalde, terug naar tekst: " + e.message); }
      }
      // b) TERUGVAL: gewone volle tekstkaart (ongewijzigd gedrag)
      if (!done) {
        try {
          const png = path.join(work, `card-${String(i).padStart(2, "0")}-${card.key || i}.png`);
          rasterCard(makeCardSvg({ W, H, title: card.title, sub: card.sub, outro: !!card.outro }), W, png);
          const r = await runStreamed(FFMPEG, ["-y", "-v", "error", "-loop", "1", "-t", String(durs[i]), "-i", png,
            "-vf", `scale=${W}:${H},fps=${FPS},setsar=1,format=yuv420p`, ...ENC, mp4], { ...process.env }, log, "· kaart:");
          if (r.status === 0 && fs.existsSync(mp4)) segs.push(mp4);
        } catch (e) { if (log) log("kaart overgeslagen: " + e.message); }
      }
    }
    if (!segs.length) throw new Error("geen kaart-segmenten gerenderd voor " + templateId);

    // 4) plakken
    let base = segs[0];
    if (segs.length >= 2) {
      const montage = path.join(work, templateId + "-montage.mp4");
      const listFile = path.join(work, "concat.txt");
      await fs.promises.writeFile(listFile, segs.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
      const rc = await runStreamed(FFMPEG, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listFile, ...ENC, montage], { ...process.env }, log, "· plakken:");
      if (rc.status === 0 && fs.existsSync(montage)) base = montage;
    }

    // 5) vertelstem over de montage (video leidend; apad + shortest houdt de slot-kaart heel)
    if (voiceWav && fs.existsSync(voiceWav)) {
      if (log) log("● vertelstem over de montage leggen…");
      const r2 = await runStreamed(FFMPEG, ["-y", "-v", "error", "-i", base, "-i", voiceWav,
        "-filter_complex", "[1:a]apad[a]", "-map", "0:v", "-map", "[a]",
        "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", "-shortest", final], { ...process.env }, log, "· mix:");
      if (r2.status !== 0) { if (log) log("mix faalde, montage zonder stem"); await fs.promises.copyFile(base, final); }
    } else {
      await fs.promises.copyFile(base, final);
    }
    return { prebuilt: final, music: "", lang: "nl", cleanup: work };
  }

  const BUILDERS = {
    roi: buildRoi, gat: buildGat, kring: buildKring, bureaus: buildBureaus, exclusief: buildExclusief,
    voorna: buildVoorna, hoehetwerkt: buildHoehetwerkt, bezwaar: buildBezwaar, mankement: buildMankement,
    rekensom: buildRekensom, gratisweek: buildGratisweek, omdraai: buildOmdraai, volume: buildVolume,
    signalen: buildSignalen, actueel: buildActueel, delen: buildDelen, resultaat: buildResultaat,
  };
  // Stem + muziek worden BIJ DE RENDER aangemaakt (niet handmatig in Git Bash): de engine roept
  // ur_audio.py (muziekbodem, eenmalig per mood) en ur_voice.py (NL-stem) zelf aan, met voortgang
  // in het studio-log, net zoals de portaal-opname. Faalt een stap, dan rendert de video stil door.
  // Genereert muziek + stem BIJ DE RENDER en geeft de totale STEM-DUUR terug (de video volgt de stem).
  async function ensureAudioAssets(templateId, vi, opts, log) {
    const PY = process.env.UR_PYTHON || "python";
    const tpl = templates.find((t) => t.id === templateId);
    const mood = (tpl && tpl.music && tpl.music[0]) || "calm";
    // 1) muziekbodem (eenmalig per mood)
    try {
      const mp = path.resolve(ROOT, "assets/unclerank/muziek", "ur-" + mood + ".mp3");
      if (!fs.existsSync(mp)) {
        if (log) log("♪ UR-muziek ophalen (eenmalig)…");
        await runStreamed(PY, [path.resolve(ROOT, "tools/ur_audio.py"), "--root", ROOT], { ...process.env, FFMPEG }, log, "· muziek:");
      }
    } catch (e) { if (log) log("muziek-stap overgeslagen: " + e.message); }
    // 2) NL-stem van de GEKOZEN variant: de HELE tekst in één opname (Truthward-stijl, pauzes + afkap-
    //    vangnet), rustiger tempo. ur_voice schrijft voice.wav + _timeline.json (met de totale duur).
    let total;
    try {
      const vdir = voiceDir(ROOT, templateId, vi);
      const wavp = path.join(vdir, "voice.wav");
      const linesFile = path.join(vdir, "_lines.json");
      const variant = (UR_VARIANTS[templateId] || [])[vi];
      const wantLines = (variant && Array.isArray(variant.voice)) ? JSON.stringify(variant.voice) : "";
      let haveLines = null;
      try { haveLines = await fs.promises.readFile(linesFile, "utf8"); } catch {}
      const stale = wantLines && haveLines !== wantLines;   // script gewijzigd -> opnieuw inspreken (duurzaam, geen handmatig wissen)
      if ((opts && opts.versStem) || !fs.existsSync(wavp) || stale) {
        await fs.promises.mkdir(vdir, { recursive: true });
        if (wantLines) await fs.promises.writeFile(linesFile, wantLines, "utf8");
        if (log) log(stale ? "● Script gewijzigd, UR-stem opnieuw inspreken…" : "● UR-stem genereren (Chatterbox, NL), dit duurt even…");
        const args = [path.resolve(ROOT, "tools/ur_voice.py"), "--type", templateId, "--variant", String(vi), "--root", ROOT];
        if (wantLines) args.push("--lines", linesFile);
        if (opts && opts.voice) args.push("--voice", String(opts.voice));
        await runStreamed(PY, args, { ...process.env, FFMPEG }, log, "· stem:");
      }
      try {
        const tl = JSON.parse(await fs.promises.readFile(path.join(vdir, "_timeline.json"), "utf8"));
        if (tl && tl.total) total = Number(tl.total);
      } catch {}
    } catch (e) { if (log) log("stem-stap overgeslagen: " + e.message); }
    return total;
  }
  async function makeRender({ templateId = "roi", opts = {}, format = "9:16", log } = {}) {
    const [W, H] = FORMATS[format] || FORMATS["9:16"];
    if (templateId === "aanbod" || templateId === "portaal") return await makePortalRender({ opts, format, log });
    if (["vak", "geenlijst", "kring", "hoewerkt", "ondernemer"].includes(templateId)) return await makeCardMontageRender(templateId, { opts, format, log });
    const fn = BUILDERS[templateId] || buildRoi;
    const vi = pickVariant(templateId);                                  // afwisseling per render
    const variant = (UR_VARIANTS[templateId] || [])[vi];
    let durSec;
    if (UR_BEATS[templateId]) durSec = await ensureAudioAssets(templateId, vi, opts, log);  // duur volgt de stem
    const render = fn({ opts, W, H, variant, durSec });
    return attachAudio(ROOT, templates, templateId, render, vi);
  }
  // De engine roept bij het laden brand.init(log) aan (zoals taleoftiles). UncleRank is type-
  // gedreven en heeft niets te laden, dus init is een no-op, maar moet wél bestaan.
  async function init() { return; }
  return {
    id: "unclerank", name: "UncleRank", footer: "unclerank.com",
    branding, templates, options: [], init, listSubjects, pickMusic, makeRender,
  };
}
