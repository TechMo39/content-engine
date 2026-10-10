# Tale of Tiles — Content Engine (fase 1)

Lokale, gratis renderer die per opgeslagen ontwerp een **satisfying tegel-voor-tegel
opbouw-video** maakt (9:16, TikTok/Reels). Geen SaaS, draait op je laptop.

Dit is **fase 1** uit `content-engine-plan.md`: renderer + 1 sjabloon (opbouw + captions,
muziek optioneel). Scriptwriter, voice-over, outreach-mail en posten komen later.

## Hoe het werkt (kort)
1. Haalt de ontwerpen op uit `GET /api/showcase-designs`.
2. Opent de **echte configurator headless** (Playwright), past per ontwerp
   `mApplyFullDesign(design)` toe en leest de mozaiek-SVG uit `#mSvgStage`.
   → pixel-getrouw: zelfde tiling, kleuren en voeg als de site, blijft in sync.
3. **Remotion** onthult die SVG steentje voor steentje (radiaal), met merk-frame,
   captions en CTA, en rendert naar `out/<naam>.mp4`.

De reveal-logica zit in `remotion/svg.ts` en wordt door zowel de render als de
test gebruikt (één bron van waarheid).

## Eenmalige setup
```
cd ~/Desktop/content-engine
npm install
npx playwright install chromium
```

## Meteen zien (geen site nodig)
Rendert een preview tegen een fixture-mozaiek met resvg + ffmpeg:
```
npm run preview-fixture      # -> out/preview-fixture.mp4
```
Toont puur de beweging/compositie (niet een echt patroon).

## Echte video's maken
```
npm run build                              # alle ontwerpen, live
node src/build.mjs --limit=1               # alleen de eerste
node src/build.mjs --only=<ontwerp-id>     # één specifiek ontwerp
node src/build.mjs --aspect=1:1            # 9:16 (default) | 1:1 | 16:9
node src/build.mjs --mode=sweep-x          # radial (default) | sweep-x | sweep-y | diagonal | random
```
Output in `out/`.

## Interactief afstellen
```
npm run studio               # Remotion Studio, opent met een fixture-ontwerp
```
Schuif door de tijdlijn, pas `remotion/TileBuild.tsx` aan, zie het live.

## Muziek
Zet royaltyvrije tracks in `assets/audio/`. De engine kiest er dan één en zet 'm
onder de video. Leeg = **geen** muziek (bewust: geen willekeurige muziek onder het merk).

## Afstellen — `config.mjs`
Alles op één plek: formaat (`aspect`), duur, reveal-stijl/tempo (`revealMode`,
`revealStartSec/EndSec`, `popDurSec`), captions (`defaultCaptions`), merk-copy.

**Als de extractie niks vindt:** de site-namen staan in `config.mjs`
(`applyFn` = `mApplyFullDesign`, `stageSelector` = `#mSvgStage`,
`tileSelector` = `path,polygon`). Gebruikt een patroon vierkante `<rect>`-steentjes,
zet `tileSelector` op `"path,polygon,rect"`. Eén regel, niet de code in.

## Test
```
npm test                     # controleert de reveal-logica (zonder browser)
```

## Wat draait waar
- **Op je laptop:** extractie (Chromium via Playwright) + eindrender (Remotion).
- **Offline/overal:** `preview-fixture` en `test` (geen site/Chromium nodig).

## Mappen
```
config.mjs            alle instellingen
remotion/
  svg.ts              parse + reveal-volgorde + per-frame opbouw (gedeeld)
  TileBuild.tsx       de compositie (frame, captions, CTA, muziek)
  Root.tsx, index.ts  Remotion-registratie
src/
  build.mjs           orchestrator (ophalen -> extractie -> render)
  extract-svg.mjs     headless configurator -> echte SVG
  fetch-designs.mjs   ontwerpen ophalen (live of --file)
  preview-fixture.mjs offline preview (resvg + ffmpeg)
  test-reveal.mjs     logica-test
fixtures/             fixture-mozaiek + voorbeeld-JSON
out/                  gerenderde video's
assets/audio/         jouw muziek (leeg = geen muziek)
```
