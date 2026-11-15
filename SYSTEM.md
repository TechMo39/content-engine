# CONTENT ENGINE — SYSTEM.md
Geef dit bestand aan het begin van een nieuwe chat over de content-engine. Bevat: het bevroren
mailarm-contract, hoe de engine in elkaar zit, hoe je 'm draait, wat af is en wat nog moet. Lees
dit VOORDAT je begint. De engine staat LOS van de Tale-of-Tiles-website-repo (`~/Desktop/tale-of-tiles`);
die heeft z'n eigen SYSTEM.md. Verwar de twee niet.

## ⛔ BEVROREN CONTRACT — CONTENT-ENGINE ⇄ LIVE MAILARM (NIET BREKEN)
De cold-mailarm van Tale of Tiles draait LIVE en automatisch. Een lokale render-tool (`tot_plaatjes.js` in het UncleRank-outreach-project) belt elke ochtend de **content-engine** (`~/Desktop/content-engine`, los van de website-repo) aan om per lead drie mail-plaatjes te renderen, zet ze op R2 en schrijft de URLs in D1. Wijzig je iets aan de content-engine, hou dan deze 8 punten HEEL — breekt er één, dan valt de mailsequence stil:
1. Endpoint blijft: `POST http://localhost:4600/api/mailstill`, body `{ names: [...], stijl }`, response per naam `{ name, style, file, url, ... }`.
2. De drie stijlen `klassiek`, `modern`, `kleurrijk` blijven bestaan onder exact die namen (`MS_STYLES` in `engine.mjs`). Elke lead heeft alle drie nodig.
3. Deterministisch: zelfde bedrijfsnaam + zelfde stijl = zelfde plaatje (`hashSeed(naam+"|"+stijl)`). Een her-render is dus nooit schadelijk.
4. De engine serveert het bestand op `GET /out/mail-stills/<slug>-<stijl>.jpg` — de mailarm haalt exact die `url` op om naar R2 te zetten. `slugify` + het `-<stijl>`-achtervoegsel niet wijzigen.
5. `GET /api/brands` blijft "ok" geven zolang de engine draait (liveness-check van de mailarm).
6. De engine blijft headless te starten met `STUDIO_NO_OPEN=1` + `windowsHide` (geen vensters). Breekt dat → venster-spam terug én de ochtendketen start de engine niet meer.
7. `renderLock` blijft het toevalsdeel (`makeRender`) serialiseren tussen video- en plaatjes-renders, zodat ze elkaar nooit vervuilen.
8. De engine blijft op poort 4600 luisteren.
Dit alles zit in `src/engine.mjs` (handler, `MS_STYLES`, `renderMailStill`, de `/out`-serving) en deels `src/brands/taleoftiles.mjs` (de insitu-render). Werk je BUITEN die onderdelen (nieuwe video-types, channels, planner, socials) → geen risico. Raak je er één aan → eerst zeggen, tegen deze flow testen, dán pushen.

## WAT IS DIT
Lokale, gratis content-fabriek op Mo's laptop. Maakt uit opgeslagen ontwerpen en scripts korte
video's (+ losse foto's en mail-plaatjes) voor meerdere TechBey-merken, plant ze per merk/taal en
post ze semi-automatisch. Doel (noordster): een content-FABRIEK voor meerdere merken, niet één
brand-tool. Draait op Mo's laptop (AMD Ryzen 5 4500U, 15 GB RAM, GEEN NVIDIA-GPU, 6 cores — laat
bij parallel renderen altijd 1 core vrij, max 5). Zware AI moet CPU-vriendelijk zijn.

Twee groepen output:
- **Bedrijven** (Tale of Tiles, UncleRank): postbare wegwerp-video's via de planner → archief →
  prullenbak (`tools/render_dag.mjs`).
- **Channels** (Truthward = channel1, en volgende): handgemaakte view-kanalen, blijven bewaard.

## ===== HOE DRAAI JE HET =====
Repo op Mo's machine: `~/Desktop/content-engine` (Windows / MINGW64 / Git Bash). Remote:
`TechMo39/content-engine` (GitHub). Sinds we git gebruiken: ALTIJD committen én pushen bij elke
levering — niet laten opstapelen als ongecommitte wijzigingen; Claude bewaakt de git-staat.
```
npm run app        # studio als eigen app-venster (Electron) — server op :4600
npm run engine     # alleen de server (node src/engine.mjs)
npm run build      # tegel-video's (Remotion), npm run film = tekenfilm
```
Python-pijplijn (Channels): `pip install chatterbox-tts soundfile`, dan
`python tools/channel_voice.py` (zie README).

CODE PUSHEN — standaardformat (Claude levert het bestand, Mo downloadt naar ~/Downloads):
BEGIN ALTIJD met de `cd`, anders belanden mv/git in de verkeerde map.
```
cd ~/Desktop/content-engine
cp ~/Downloads/<file> <doelpad>/<file>
git add -A && git commit -m "..." && git push
```
Grote terminal-output die Claude terug nodig heeft: laat het commando naar een bestand in
~/Downloads schrijven, nooit Mo laten plakken.

## ===== ARCHITECTUUR =====
- `src/engine.mjs` — de studio-server (:4600). Kiest merk → onderwerp → template → render, en
  bevat de endpoints voor de planner, socials, mail-stills, carrousel en de Channels (voice/
  beeld/audio, timeline, frame-preview). Weet zelf niks van tegels; dat zit in de merk-modules.
- `src/registry.mjs` — welke merk-modules bestaan (nieuw merk = één regel).
- `src/brands/` — `taleoftiles.mjs` (tegels/Remotion), `channel1.mjs` (Truthward), `unclerank.mjs`
  (data-animatie, kale SVG per frame).
- `src/core/` — `renderer.mjs`, `raster-worker.mjs`, `audio-overlay.mjs` (SVG → frames → mp4 + audio).
- `src/social/` — per platform één bestand (`youtube`, `tiktok`, `meta`+`instagram`/`facebook`,
  `whatsapp`), elk met 3 taal-accounts (NL/EN/FR). `index.mjs` = registry, `store.mjs` = logboek
  (`out/.social.json`), `r2.mjs` = upload via de worker, `post-texts.mjs` = teksten per type/taal.
- `studio/` — `index.html` (hub), `engine.html` (bedrijven: studio/planner/socials/mail/carrousel),
  `channel.html` (Channels-studio).
- `tools/` — `channel_voice|beeld|audio.py` (Channels-pijplijn), `render_dag.mjs` (nacht-render +
  archief-lifecycle), `post_dag.mjs` (poster), `mail-still.mjs`.
- `.bat` + `stil.vbs` — Windows Taakplanner-automatisering (zie README).
- `secrets/` — social-tokens (gitignored). `.env` — keys (UPLOAD_KEY, TOT_ADMIN_PW; gitignored).

## ===== CHANNELS / STEM (Truthward) =====
- Een project = `verhaal/stem` (bv. `chose/v1`); elke stem = een eigen `_timeline.json`.
- `channel_voice.py` draait **Chatterbox** stem-kloning (CPU, Engels). Per video 3 stemmen
  (v1/v2/v3) uit `voice-test/refs/ref7-9.wav`; Mo kiest er één in de studio (🎙 Stem-kiezer).
  Spreekt per CHUNK in (zinnen gegroepeerd onder `MAX_CHARS`); Chatterbox plaatst zelf adem/
  intonatie. Geen zin-voor-zin + handmatige pauzes meer (dat was de Kokoro-aanpak, eruit).
  Let op: losse te-korte zinnen (bv. "So.") crashen Chatterbox → daarom chunken. Zwaar op CPU
  (uren voor 3 volledige stemmen).
- Scripts worden in Truthward's EIGEN stem geschreven; voorbeeldvideo's dienen alleen als
  inspiratie voor de opbouw, niet om zinnen te kopiëren. Eigen CTA passend bij een klein kanaal.

## ===== VALIDATIE VOOR ELKE LEVERING =====
- `.mjs`: `node --check <bestand>` moet slagen.
- `.py`: `python3 -c "import ast; ast.parse(open('<bestand>').read())"`.
- `.html`: JS-scriptblokken parsen (`new Function(block)`), en visueel checken met Playwright
  headless waar het om beeld gaat.
- Channels: pauze-/zin-indices binnen de scène houden; render tegen exact het `_timeline.json`.

## ===== WERKAFSPRAKEN MO (streng) =====
- ALTIJD Nederlands, KORT. Geen essays, geen opsomming vooraf van wat je gaat doen.
- HELE bestanden leveren, geen patches. Alleen de GEWIJZIGDE bestanden, niks extra's ernaast.
- Lever code mét een commit+push-commando; laat niets ongecommit opstapelen (kapiteinsrol).
- Zelf-opruimend leveren: cp naar het doelpad + rm uit ~/Downloads in hetzelfde commando.
- Geen em-dashes. Geen nep-urgentie, geen nep-reviews. Geen afsluitende caveat-/disclaimer-blokken.
- Zelf beslissen en bouwen (kapitein); niet steeds aan Mo vragen wat te doen. Vraag het bestand
  op als je iets niet zeker weet, i.p.v. gokken.
- Als Mo zegt "het is niet gefixt / dat klopt niet": geloof hem, ga niet tegenspreken.
- Max 5 cores bij parallel renderen (1 vrijlaten).

## ===== WAT AF IS =====
- Multi-merk studio (:4600) met Tale of Tiles, UncleRank en Channels/Truthward.
- Per-merk planner (eigen week/kandidaten/slots, `out/.plan.json`) en per-merk socials-koppeling.
- Planner houdt een gekozen video vast, ook als het bestandspad wijzigt of de video verplaatst is.
- Channels-studio: beeld/muziek/SFX per scène via dezelfde pop-up-kiezer, per-scène afspelen met
  laad-gate, dissolve + muziek-crossfade in de render, 🎙 Stem-kiezer (v1/v2/v3).
- Truthward-stem op Chatterbox (Kokoro + "spread by the sword" eruit).
- Cold-mailarm LIVE (3 mail-stills/lead → R2 → D1). Nacht-render + poster via Taakplanner.

## ===== NOG TE DOEN =====
- Analytics (fase 3): creator-stats terug in Mo's eigen systeem — bewust uitgesteld tot er genoeg
  goede video's staan.
- Kwaliteitsslag retentie/hook per video-type (seconde-1 payoff, pattern-interrupts, geanimeerde
  captions).
- UncleRank-content verder uitbouwen als channel (NL-stem staat los van Truthward).
- Render naar de cloud (nu laptop-afhankelijk).
- `channel_beeld.py`: eigen beeldplan voor nieuwe verhalen (valt nu terug op het oude plan).
