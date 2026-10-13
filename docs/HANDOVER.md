# CONTENT-ENGINE — HANDOVER / SYSTEM (lees dit VOLLEDIG voor je iets doet)

_Laatst bijgewerkt: 2026-10-13. Dit is de naadloze-overdracht voor de **content-engine**
(NIET de website — die heeft een eigen SYSTEM.md). Volgende chat: begin nooit blind en
nooit "heel algemeen". Doe eerst stap 0 en 1 hieronder, dán weet je exact waar we staan._

## STAP 0 — Vraag Mo de code op (één commando, één zip)
De code staat op Mo's laptop in `~/Desktop/content-engine` (Windows / Git Bash), niet bij
jou. Vraag Mo dit te draaien en de zip hierheen te sturen:
```
cd ~/Desktop/content-engine
git add -A && git commit -m "handover snapshot" 2>/dev/null; \
git archive -o ~/Downloads/content-engine-handover.zip HEAD -- \
  remotion src studio electron config.mjs package.json docs \
  assets/patterns assets/tile-locks.json fixtures
echo "klaar: ~/Downloads/content-engine-handover.zip"
```
Dit zipt alleen de essentie (geen node_modules/out/muziek/foto's). Jij pakt 'm uit, bv:
```
mkdir -p ~/ce && cd ~/ce && unzip -o /mnt/user-data/uploads/content-engine-handover.zip
```

## STAP 1 — Lees in deze volgorde (dan snap je het hele systeem)
1. **docs/content-strategy.md** — het WAAROM: doel (Tale of Tiles verkopen), doelgroep,
   markt, de content-types, en §9 publicatie/planning. **Dit is het ijkpunt; toets elk
   antwoord hieraan.**
2. **remotion/film.ts** — tegel-engine: patroon parsen + tegelen (port van de echte
   configurator), `finalColors`/`flowColorsAt` (satisfying = tegel-voor-tegel naar vaste
   eindkleur), `buildSvg`. Hier zit de "satisfying"-logica.
3. **src/core/renderer.mjs** — generieke kern: SVG→mp4 (resvg + gebundelde ffmpeg),
   **multi-core worker-pool**, `composeChrome`, `loadImageFile`/`imagePalette`/
   `enrichPalette` (kleur-match), klik-mechaniek (nu UIT).
4. **src/core/raster-worker.mjs** — worker die één frame rasterd (voor de pool).
5. **src/brands/taleoftiles.mjs** — HET HART van ToT: branding/woordmerk, naamplaat,
   patronen, templates, **in-situ composite** (paneel op mockup-muur), camera-regie,
   `makeRender`.
6. **src/brands/unclerank.mjs** — stub voor merk 2 (later).
7. **src/registry.mjs** — merken-registry.
8. **src/engine.mjs** — HTTP-server (poort 4600), endpoints, SSE-log.
9. **studio/engine.html** — de UI (merk → onderwerp → template → opties → render).
10. **electron/main.cjs** — desktop-app wrapper. **config.mjs** — knoppen/branding/paden.
11. **assets/patterns/*.svg**, **assets/tile-locks.json**, **fixtures/patterns.json** — patronen.
    (Mockups/foto's/muziek zitten NIET in de zip; dat zijn lokale assets in
    `assets/images/taleoftiles/mockups/`, `assets/images/taleoftiles/`, `assets/audio/`.)

## WAT IS DIT SYSTEEM
Een **lokale, generieke machine die automatisch social-media video's maakt** (9:16,
1080×1920, 24fps, H.264) om een merk te promoten. Architectuur: generieke **kern**
(renderer) → **merk-modules** (ToT, UncleRank) → **templates** (video-recepten) →
**registry** → **engine-server** → **UI**. Merk 1 = Tale of Tiles (eerst, want moeilijkst).
Merk 2 = UncleRank (apart bedrijf, pas ná ToT). Draait als desktop-app: `npm run app`
(Electron start `src/engine.mjs` → `studio/engine.html`). NIET `npm run engine`.

## WAAR WE STAAN (2026-10-13)
- **Satisfying Build (type 1): kern klaar.** Tegel voor tegel inkleuren → afgemaakt paneel
  → eindigt met de naam. Beweging uit de **camera** (trage zoom), niet uit kleuren.
  **In-situ**: ons echte paneel op een lege-muur-mockup → matcht altijd het patroon.
  Auto-muziek per type. Multi-core render.
- **Fouten die we achter ons lieten (niet herhalen):** abstract "dansend kleurveld"/plasma
  (eruit), constant tegel-getik (irritant, uit), lifestyle-sfeerbeelden met mismatchend
  patroon (vervangen door in-situ).
- **Direct volgende stap:** type 2 = **"Lege muur → jouw paneel (in situ)"** (before/after;
  bouwt op de in-situ-composite). Daarna Colorway A/B/C, Geen-twee-gelijk, Macro-glans.
- **Open gaten:** tekst/hook-overlay in de engine; échte zachte ASMR-sample; planlaag +
  publicatie naar TikTok/IG/FB (§9 strategie); échte Tetouan-atelierfootage; UncleRank.

## HOE JE WERKT MET MO (streng — dit voorkomt de ergernis)
- **Nederlands, kort, mensentaal.** Geen essays. Geen "ik ga nu…"-aankondiging — gewoon doen.
  Geen opsomming vooraf. Vraag niet telkens om goedkeuring; wees beslissend. Toets elk
  antwoord stil aan content-strategy.md en herhaal niet wat er al is.
- **Lever code als LOSSE bestanden** (de file-kaart/SendUserFile), nooit een zip voor levering.
- **Bij ELK geleverd bestand hoort een push-commando**, en het begint ALTIJD met de cd:
  ```
  cd ~/Desktop/content-engine
  mv ~/Downloads/<bestand> <pad-in-repo>
  git add -A && git commit -m "..." && git push
  ```
  Meerdere bestanden: één cd, dan meerdere mv's, dan één commit + push. Mo pusht zelf; jij
  levert bestand + commando. Vergeet het commando nooit (grote ergernis).
- **Doe het werk; stuur Mo geen huiswerk.** Geen handmatig gekozen dingen opleggen — de
  machine moet automatisch draaien. Duw hem nooit richting handwerk.
- **Geloof Mo** als hij zegt dat iets niet klopt of niet gefixt is. Niet tegenspreken, niet
  "even checken" — fix het.
- **Check/render zelf vóór levering**: bekijk frames (ffmpeg → PNG's → montage), kijk met je
  eigen ogen of het klopt. Lever niks ongezien.
- Lange video's duren even te renderen (multi-core helpt); dat is normaal.

## POINTERS
- Strategie/ijkpunt: `docs/content-strategy.md` (project: claude/content-strategy.md).
- Deze handover: project `claude/content-engine-handover.md` (+ repo `docs/HANDOVER.md`).
- Website-project (los, NIET dit): eigen `SYSTEM.md`.
