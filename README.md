# Tale of Tiles — Content Engine

Lokale, gratis machine die uit je opgeslagen ontwerpen video's maakt. Draait op je
laptop (praat over HTTP met de live site). Zie `docs/content-strategy.md` voor het waarom.

## Wat het doet
1. Haalt ontwerpen op uit `/api/showcase-designs`.
2. Opent de configurator **headless** en leest het echte mozaïek-SVG uit (`mApplyFullDesign`
   → `#mSvgStage`). Pixel-getrouw, blijft in sync met de site.
3. Rendert met **Remotion** een video (9:16), in je plum/goud-branding met logo.

## Twee templates (zelfde motor)
- **build** — satisfying opbouw: tegel-voor-tegel inkleuren (golf) + naamplaat. `npm run build`
- **film** — tegel-canvas tekenfilm: opbouw → vormen (hart/ster) → kleuren-wissel, morphend
  op één patroon. `npm run film`

De animatie-engine zit in `remotion/film.ts` (de "scenes" en het storyboard — kleuren en
vormen zijn data, dus makkelijk uit te breiden).

## Eenmalige setup
```
npm install
npx playwright install chromium
```

## De studio als desktop-app (eigen venster, geen browser)
```
npm run app
```
Opent de studio in een eigen app-venster. (Of `npm run studio-app` voor de versie die
in je browser opent.) Een los te delen .exe/zip voor iemand anders is een aparte verpak-stap.

## Video's maken
```
npm run build                 # satisfying-opbouw, alle ontwerpen
npm run film                  # tekenfilm, alle ontwerpen
node src/build.mjs --template=film --limit=1        # 1 ontwerp
node src/build.mjs --only=<id> --aspect=1:1         # 9:16 (default) | 1:1 | 16:9
```
Output in `out/`. Per video komt er ook een `out/<naam>.design.json` — dat is het **kaartje**
met het exacte ontwerp + de deel-code, zodat je 'm later als showcase kunt opslaan.

## Snel de tekenfilm zien (zonder site)
```
npm run film-preview          # -> out/film-proof.mp4 (resvg+ffmpeg, fixture-patroon)
```

## Een winnaar opslaan als showcase
Niks wordt automatisch opgeslagen. Vind je een video mooi, sla dan dát ene ontwerp op:
```
node src/save-showcase.mjs --slug=<naam-uit-out>
```
Vereist je admin-wachtwoord in `.env` (nooit in de chat, nooit in git — staat in `.gitignore`):
```
TOT_ADMIN_PW=jouwwachtwoord
```
Het gebruikt hetzelfde endpoint als de builder (`/api/showcase-save`). Verschijnt daarna in
je admin + op de site.

## Muziek
Leg royaltyvrije tracks in `assets/audio/`. De engine kiest er een en zet 'm onder de video.
Leeg = geen muziek.

## Afstellen — `config.mjs`
Formaat, duur, branding-kleuren, logo-URL, en (voor build) reveal-stijl/tempo. De tekenfilm
stel je af in `remotion/film.ts` (het storyboard: welke vormen, welke kleuren, tempo).

## Mappen
```
config.mjs              instellingen + branding
remotion/
  film.ts               tegel-canvas animatie-engine (scenes + storyboard)
  TileFilm.tsx          film-compositie
  svg.ts, TileBuild.tsx satisfying-opbouw compositie
  Root.tsx, index.ts    Remotion-registratie
src/
  build.mjs             orchestrator (ophalen -> extractie -> render -> sidecar)
  render-film.mjs       offline tekenfilm-preview (resvg+ffmpeg)
  save-showcase.mjs     1 ontwerp opslaan als showcase (admin)
  extract-svg.mjs       headless configurator -> echte SVG
  fetch-designs.mjs     ontwerpen ophalen
  dump-svg.mjs          diagnose: echte SVG + structuur
  test-*.mjs            tests
fixtures/               fixture + echte dump.svg + voorbeeld-JSON
docs/content-strategy.md
out/                    video's + .design.json kaartjes
assets/audio/           jouw muziek
```
