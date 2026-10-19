# TALE OF TILES — SYSTEM.md
Geef dit bestand aan het begin van een nieuwe chat. Bevat: hoe pushen, welke pagina's er zijn, wat de site technisch doet, wat af is en wat nog moet. Lees dit VOORDAT je begint te werken — begin niet blind.

## ⛔ BEVROREN CONTRACT — CONTENT-ENGINE ⇄ LIVE MAILARM (NIET BREKEN)
De cold-mailarm van Tale of Tiles draait LIVE en automatisch. Een lokale render-tool (`tot_plaatjes.js` in het UncleRank-outreach-project) belt elke ochtend de **content-engine** (`~/Desktop/content-engine`, los van deze website-repo) aan om per lead drie mail-plaatjes te renderen, zet ze op R2 en schrijft de URLs in D1. Wijzig je iets aan de content-engine, hou dan deze 8 punten HEEL — breekt er één, dan valt de mailsequence stil:
1. Endpoint blijft: `POST http://localhost:4600/api/mailstill`, body `{ names: [...], stijl }`, response per naam `{ name, style, file, url, ... }`.
2. De drie stijlen `klassiek`, `modern`, `kleurrijk` blijven bestaan onder exact die namen (`MS_STYLES` in `engine.mjs`). Elke lead heeft alle drie nodig.
3. Deterministisch: zelfde bedrijfsnaam + zelfde stijl = zelfde plaatje (`hashSeed(naam+"|"+stijl)`). Een her-render is dus nooit schadelijk.
4. De engine serveert het bestand op `GET /out/mail-stills/<slug>-<stijl>.jpg` — de mailarm haalt exact die `url` op om naar R2 te zetten. `slugify` + het `-<stijl>`-achtervoegsel niet wijzigen.
5. `GET /api/brands` blijft "ok" geven zolang de engine draait (liveness-check van de mailarm).
6. De engine blijft headless te starten met `STUDIO_NO_OPEN=1` + `windowsHide` (geen vensters). Breekt dat → venster-spam terug én de ochtendketen start de engine niet meer.
7. `renderLock` blijft het toevalsdeel (`makeRender`) serialiseren tussen video- en plaatjes-renders, zodat ze elkaar nooit vervuilen.
8. De engine blijft op poort 4600 luisteren.
Dit alles zit in `content-engine/src/engine.mjs` (handler, `MS_STYLES`, `renderMailStill`, de `/out`-serving) en deels `src/brands/taleoftiles.mjs` (de insitu-render). Werk je BUITEN die onderdelen (nieuwe video-types, `film.ts`, losse tweaks) → geen risico. Raak je er één aan → eerst zeggen, tegen deze flow testen, dán pushen. De mailarm is NIET deze website-repo; verwar de twee niet.

## WAT IS DIT
Tale of Tiles (taleoftiles.com): webshop die je naam/spreuk/ontwerp omzet naar een handgemaakt mozaiek-naampaneel (met de hand gehakte glazuur-steentjes tot een mozaiek, GEEN grote tegels). Doelgroep: welgestelde Europese/Nederlandse klanten, zakelijk EN particulier.
- Merk = PREMIUM, MODERN. NOOIT "Marokko/Marokkaans" of een plaatsnaam in klant-copy noemen.
- Bedrijf: TechBey B.V. (KvK 97194832). Staat in de juridische paginas + footer (Stripe eist dit).
- Eigenaar: Mo. Woont in Tetouan, bouwt solo.
- Er is een TWEEDE, apart project "YALSOU" (high-end fragment-kunst). NOOIT door elkaar halen. De README die soms meekomt hoort bij YALSOU, niet bij dit project.

## LIVE
- Live URL: https://taleoftiles.com (Cloudflare Registrar-domein, gekoppeld als custom domain op de worker).
- Worker-naam: yalsou-configurator (het oude workers.dev-adres bestaat nog als worker-adres).
- Stripe: LIVE en werkend (echte betalingen). Betaalmethoden aan: iDEAL|Wero, Bancontact, Visa, Mastercard, Apple Pay, Google Pay, Klarna.

## ===== HOE PUSHEN / UPLOADEN (belangrijkste deel) =====
Repo op Mo's machine: ~/Desktop/tale-of-tiles  (Windows / MINGW64 / Git Bash)
Bronbestanden in: ~/Desktop/tale-of-tiles/src/
  - page.ts   = hele homepage + configurator (HTML+CSS+JS in EEN backtick-template `export const PAGE`). In Claude's werkkopie heet dit live.ts.
  - i18n.ts   = alle klant-teksten NL+EN. NL en EN MOETEN evenveel keys hebben (anders blijft tekst in 1 taal hangen).
  - index.ts  = Cloudflare Worker: routes, API-endpoints, losse paginas (dnLegalPage), Stripe-code, mail, track-pagina.
  - pricing.ts = SERVER-side prijsberekening. 1-OP-1 KOPIE van mPrice() in page.ts. Wijzig je de prijs in page.ts, wijzig pricing.ts identiek, anders betaalt de klant het verkeerde bedrag.
  - adminpage.ts = admin (bestellingen, werkplaat/productieblad, patroon-locks, kostprijs-schatting).
  - assets.ts, model/* = bestaan alleen op Mo's machine, niet bij Claude.

CODE PUSHEN — standaard format (Claude levert het bestand, Mo downloadt naar ~/Downloads, dan):
BELANGRIJK: het commando MOET beginnen met `cd ~/Desktop/tale-of-tiles`. Zonder die cd belanden de
mv, git en wrangler in de verkeerde map (dan mislukt het of pusht er niks). Claude: geef dit cd-commando
ALTIJD als eerste regel mee in elk push-commando dat je aan Mo levert. Nooit vergeten.
```
cd ~/Desktop/tale-of-tiles
mv ~/Downloads/<file> src/<file>
git add -A
git commit -m "..."
git push
unset CLOUDFLARE_API_TOKEN
npx wrangler deploy
```
Meerdere bestanden: begin met de cd, dan meerdere mv's, dan 1 commit + push + deploy. Voorbeeld:
```
cd ~/Desktop/tale-of-tiles
mv ~/Downloads/page.ts src/page.ts
mv ~/Downloads/index.ts src/index.ts
git add -A && git commit -m "..." && git push && npx wrangler deploy
```
LET OP bij deploy: ALTIJD eerst `unset CLOUDFLARE_API_TOKEN` (een stale token geeft auth-fouten).
Git remote: TechMo39/tale-of-tiles (GitHub). Sinds we git gebruiken: ALTIJD git push erbij, anders geen versiebeheer.

AFBEELDINGEN / PDF UPLOADEN NAAR R2 (bucket: yalsou-configurator-images):
```
npx wrangler r2 object put yalsou-configurator-images/<key> --file ~/Downloads/<file> --content-type <type> --remote
npx wrangler r2 object get yalsou-configurator-images/<key> --file ~/Downloads/<naam> --remote
```
De worker serveert alles onder /img/<key> (route in index.ts: path.startsWith("/img/")).
R2 keys in gebruik:
  - patronen (SVG):        patterns/<S-id>.svg     -> /img/patterns/<id>.svg   (104 velden + border S9xx)
  - glazuurtegels (webp):  colours/<id>.webp       -> /img/colours/<id>.webp   (~93 tegels, ids 1001-1127)
  - showcase designs:      site/designs/<slug>.png
  - hero (zakelijke gevel): site/tale-of-tiles.jpg  (wordt op 2 plekken gebruikt tenzij aangepast)
  - naambord halverwege:   site/panel-on-wall.jpg
  - ambacht-fotos:         site/craft/craft-1..6.jpg
  - status-badges track:   site/status/status-1..12.png
  - handleiding PDF:       site/montagehandleiding.pdf (NL), site/mounting-guide-en.pdf (EN) -> aparte routes
  - MAIL-STILLS (mailarm): mail-stills/<slug>-<stijl>.jpg -> /img/mail-stills/...  (geschreven door tot_plaatjes.js via /api/mail-still-upload; NIET handmatig aankomen)
BELANGRIJK: cache is lang op /img -> na elke upload ALTIJD Ctrl+Shift+R, of check met ?t=999.

WRANGLER: v4. D1 database: dn-store-db (id a5ec8fde-da59-4a65-b3da-e33825416de8). Bindings in code: dn_store_db (D1), dn_store_images / yalsou_configurator_images (R2), env.AI.
D1 direct queryen kan (SELECT/ALTER via `npx wrangler d1 execute dn-store-db --remote --command "..."`). Auth-fout 7403/7500 = of token-issue (unset CLOUDFLARE_API_TOKEN) of een echte SQL-fout (bv ontbrekende kolom — die staat dan in de melding).

## ===== VALIDATIE VOOR ELKE LEVERING (verplicht) =====
- page.ts / index.ts / pricing.ts / i18n.ts / adminpage.ts: esbuild transform MOET slagen (Claude checkt: `esbuild.transformSync(bestand, {loader:"ts"})`).
- VALKUIL: esbuild slikt backslashes in regexen binnen de PAGE-backtick. Gebruik tekenklasse [/] ipv \/, [(] ipv \(, [ ] ipv \s.
- Frontend prijs (mPrice in page.ts) MOET exact gelijk zijn aan server prijs (panelTotalPrice in pricing.ts). Test dit over veel combinaties (patroon x maat x vorm x rand x tegelgrootte); mismatches = klant betaalt fout.
- ZELF renderen/checken met Playwright headless (localhost:8799 serveert de PAGE-string; patterns uit map, colours als effen test-pngs). Visueel kijken, niet alleen tekst.
- 1 losse ongesloten (function(){ maakt de HELE page-JS dood. Test met page.on('pageerror').

## ===== WELKE PAGINA'S / ROUTES =====
KLANT (in index.ts):
  - /                     homepage + configurator (de hele PAGE uit page.ts)
  - /track/<token>        "Volg je bestelling" status-pagina (na betaling)
  - /track/success        redirect-pagina na Stripe-betaling -> maakt order aan -> /track/<token>
  - /api/track/<token>    JSON voor de track-pagina (order + alle panelen + totaalprijs)
  - /terms /voorwaarden, /privacy, /shipping /verzending, /contact  (tweetalig via dnLegalPage, ?lang=nl/en)
  - /montagehandleiding.pdf, /mounting-guide-en.pdf
  - /api/checkout (POST)  -> Stripe checkout-sessie (dynamische prijs, verzendzones)
  - /stripe/webhook       checkout.session.completed -> order in D1 (panel_order) + bevestigingsmail
  - /api/save-cart, /api/save-preview, /api/save-design  (mandje/preview/ontwerp opslaan)
  - /api/mosaic-request, /api/cart-order  (aanvraag/mandje-order fallback-flows)
  - /api/mail-stills (lijst R2 mail-stills) + /api/mail-still-upload (PUT, x-upload-key) — mailarm/Library, NIET aankomen
  - /img/<key>            R2-assets
ADMIN (/admin, Basic Auth, wachtwoord = ADMIN_PASSWORD secret):
  - Bestellingen (panel_order): status per paneel bijwerken, volglink, WERKPLAAT/productieblad openen.
  - Patronen locken (N/gx/gy per patroon), standaardkleuren.
  - Kostprijs-schatting per bestelling (marge-inzicht, fiberglas-cijfers).

## ===== WAT DE SITE TECHNISCH DOET (kern) =====
- CONFIGURATOR (page.ts): klant kiest PATROON (stap 1, staat open, eerste categorie uitgeklapt), dan NAAM (stap 2, optioneel — leeg = alleen ontwerp), formaat, vorm (rechthoek/ovaal/cirkel), rand aan/uit, tegelgrootte (grof/normaal/fijn), lijst/extra's. Live preview verandert mee.
- PATRONEN: categorieen die Mo ziet: Achtsters, Vierkant & Baksteen, Ruit & Driehoek, Waaier & Zeshoek, Gebogen & Golf. Patronen hebben NAMEN (PATTERN_NAMES), NOOIT S-nummers tegen Mo noemen.
- KLEUREN: per tegel-groep inkleurbaar (Simpel = per groep, Gedetailleerd = per tegel). Voeg (cementlijn) blijft altijd zichtbaar op ingekleurde steentjes (kleur #9a9488).
- TEGELGROOTTE: grof/normaal/fijn = N-stap (minder/meer, grotere/kleinere steentjes op zelfde paneel). Alleen bij patronen die er zichtbaar op reageren (MTILE_RESPONSIVE). Prijs: fijner +16%/stap, grover -10%/stap.
- PRIJS (FIBERGLAS-model, sinds cement->fiberglas): tegels (opstart EUR 8,90 + EUR 110/m2 x complexiteit) + fiberglas-drager EUR 20/m2 + frame/omtrek + ophangsysteem (3,50/6/12 naar formaat) + verpakking (5/18) + verzending (22 kg/m2 x ~4/kg), dan glijdende markup. Cirkel/ovaal = ~78,5% oppervlak (minder stenen = goedkoper). Rand = vaste +EUR 65/strekkende meter na markup. Naamplaat apart. + VASTE bezorgbijdrage EUR 29,95 per bestelling (apart in mandje/mails).
- WERKPLAAT/PRODUCTIEBLAD (mNumberedSheet): paint-by-numbers, nummer op elk echt getekend steentje, legenda per kleur + apart RAND-blok (R1/R2) met hakmaat en aantal. Wordt bij "in mandje" per paneel als afbeelding vastgelegd.
- MANDJE: drawer, meerdere panelen + shop-producten, per item snapshot van het echte ontwerp met de naam erop (niet een vast plaatje). Item-label = "Patroonnaam - NAAM". Subtotaal + Bezorging 29,95 + Totaal. "Veilig betalen via Stripe" + 7 betaallogo's (inline in code).
- BETALING: Stripe checkout (mode payment), server herberekent de prijs uit pricing.ts (client-bedrag wordt NOOIT vertrouwd). Verzendzones EU/NA/ROW.
- TRACK: /track/<token> toont alle panelen van de bestelling (via order_group), per paneel naam/stijl/vorm/formaat/prijs + ordertotaal, 12-staps status met badge-illustraties.
- MAIL: via Resend HTTP-API (Workers kunnen geen SMTP). Afzender overal hello@taleoftiles.com. Ontvangen gaat naar echte cPanel-mailboxen (hello@ en support@, MX -> cPanel). Resend mag versturen via de send.-subdomein DNS + resend._domainkey (LATEN STAAN). Interne melding naar hello@.

## ===== WERKAFSPRAKEN MO (streng) =====
- ALTIJD Nederlands, KORT. Geen essays, geen opsomming vooraf van wat je gaat doen.
- NOOIT S-nummers tegen Mo. Patronen hebben namen.
- HELE bestanden leveren (present_files), geen patches.
- ALLE punten die Mo in een bericht noemt afmaken, niet alleen de laatste zin. Dat is Mo's grootste ergernis.
- ZELF checken/renderen voor levering. Visueel, door de ogen van de klant (customer journey).
- Als Mo zegt "het is niet gefixt / dat klopt niet": GELOOF hem, ga niet tegenspreken of "checken".
- Zelf beslissen en bouwen als customer-journey-specialist; niet aan Mo vragen wat te doen.
- Geen em-dashes in klant-copy. Geen nep-urgentie, geen nep-reviews. Schaarste mag subtiel ("handgemaakt in kleine batches"), geen aftel-timers.
- WINDOWS DEFENDER kan een .ts-download vals als "virus" flaggen (heuristiek op <script>/data: in de code). Geen echt virus. Mo heeft realtime-scanning uit staan; lever gewoon .ts. Als het terugkomt: map uitsluiten in Defender, of base64 leveren en `base64 -d` bij het pushen.

## ===== WAT AF IS (sept 2026) =====
- Live op taleoftiles.com met werkende Stripe (echte betalingen).
- Fiberglas-prijsmodel (verkoop + admin-kostprijs), frontend==server geverifieerd.
- Configurator: patroon = stap 1 (open), naam = stap 2 (optioneel). Klik op een stap scrollt hem in beeld.
- Werkplaat met raster-nummering + apart telbaar RAND-blok. Voeg (cement) altijd zichtbaar.
- Cirkel/ovaal goedkoper (minder stenen). Tegelgrootte grof/normaal/fijn met eerlijke prijs.
- Mandje toont echt ontwerp-snapshot met naam; leesbaar bij meerdere items; label = patroon + naam.
- Track-pagina toont alle panelen + per-paneel prijs + totaal; net status-rondje.
- 7 echte betaallogo's (iDEAL|Wero, Bancontact, Visa, Mastercard, Apple Pay, Google Pay, Klarna) + "Veilig betalen via Stripe".
- Mail vanaf hello@taleoftiles.com; ontvangst via cPanel-mailboxen.
- Juridische paginas tweetalig met TechBey B.V. + KvK.
- Hero = zakelijke gevel; naambord-op-muur halverwege de pagina.
- Showcase carrousel met bedrijfsnamen, muted/Hollandse + TOT-kleuren, 60x40 formaat.
- COLD-MAILARM LIVE: content-engine rendert 3 mail-stills/lead (klassiek/modern/kleurrijk) -> R2 -> D1 -> ToT-sequence. Zie het bevroren contract bovenaan.

## ===== NOG TE DOEN / OVERDRACHT (Mo's volgorde) =====
1. WEBSITE ONLINE ZETTEN — laatste technische doorloop VOOR echt live gaan: end-to-end Stripe-testbestellingen op mobiel EN desktop (bevestigingsmail in inbox niet spam, adres in backend, bedrag klopt met configurator, incl. rand + tegelgrootte 'fijn' + cirkel/ovaal). Mobiele checkout doorklikken.
2. ADMIN / WERKPLAAT VEREENVOUDIGEN — NIEUW INZICHT VAN MO: de Marokkaanse makers die de designs echt maken hebben ALLEEN het formaat + het design (het gekleurde ontwerp) nodig. NIET de volledige productieplaat/paint-by-numbers met alle nummers en tellingen. Dus de admin/werkplaat kan versimpeld: per bestelling het design-beeld + de maat, meer niet nodig voor de uitvoerder. (De uitgebreide werkplaat bestaat nog; Mo wil 'm terugbrengen tot wat de maker echt gebruikt.)

## KLEINER / LATER
- iDEAL|Wero-logo is nu Mo's aangeleverde PNG (base64 inline); de andere 6 zijn SVG. Kan later door officiele iDEAL|Wero SVG.
- Klarna verschijnt in NL/BE soms alleen bij bepaalde bedragen; check dat het echt als optie opduikt.
- Homepage cosmetisch verder verfijnen. "Vaas"-vormen bij naden in enkele patronen (geparkeerd, cache/deploy-verschil).
