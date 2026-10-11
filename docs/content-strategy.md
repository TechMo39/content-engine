# Tale of Tiles — Content Strategie (2026-10-11)

Richtkader voor de content-engine: wie we bereiken, welke content (subliminaal vs
direct), via welke kanalen, en wat we nog nodig hebben. De engine (renderer +
templates + studio) is het gereedschap; dit is waaróm. Samengevoegd met een extern
template-voorstel (Gemini) — de slimste ideeën daaruit zijn hieronder verwerkt.

## Positionering
Premium, handgemaakt, persoonlijk, erfgoed. "Jouw naam, met de hand gelegd in tegel."
Geen massaproduct — rust, ambacht, uniciteit ("geen twee gelijk"), duurzaam
("verbleekt niet"). Alle content moet dat voelen; de plum/goud-branding ondersteunt dit.

## Doelgroepen (op prioriteit)
1. **Nederlandse MKB / horeca & retail** — café, kapsalon, restaurant, boutiek,
   barbier, advocaat, tandarts, bakker. Naamplaat aan de gevel / achter de balie.
   Sluit direct aan op UncleRank-leads → outreach-haak. (Primair, meest actionable.)
2. **High-end B2B / multipliers** — interieurarchitecten, boetiekhotels, high-end
   restaurants, vastgoedstylisten. Hogere orderwaarde, plaatsen het in klantprojecten.
3. **Particulier / cadeau (B2C)** — woning, huwelijk, geboorte, housewarming, uniek
   huisnummer/naambord, keuken-achterwand, wandart. Emotioneel, esthetiek, uniciteit.
4. **Erfgoed / diaspora** — affiniteit met Marokkaans ambacht, authenticiteit.

## Content-type: subliminaal vs direct
- **Subliminaal (top of funnel — merkgevoel + retentie):** satisfying opbouw,
  kleuren-cyclus. Werkt op mute-autoplay. Rust/schoonheid aan het merk koppelen.
- **Verhaal (consideration):** de maalem die op gehoor hakt, "geen twee gelijk,"
  waarom handgemaakt. Vereist échte ateliervideo uit Tetouan.
- **Direct (conversion):** before/after, "ontwerp jouw paneel," prijs/aanbod,
  "[Bedrijfsnaam] in zellige," paneel in situ.
- **Social proof:** echte installaties, klantverhalen, reviews.
- **Outreach (1-op-1):** gepersonaliseerde render met bedrijfsnaam uit UncleRank →
  DM/mail. Hoge ROI, lage kosten.

## Kanalen
TikTok, Instagram Reels, YouTube Shorts. **Pinterest** apart: sterk en onderschat voor
interieur/decor, evergreen zoekverkeer — aanrader. Meta Ads voor de B2B/direct-templates.

## De 4 canonieke templates (engine: `template_type`)
Elke template = vaste animatie/muziek/tekst-stramien + inputdata (ontwerp, kleuren,
naam, patroon). Eén variabele erbij en de machine rolt 10-20 varianten uit.

1. **Satisfying Build** (subliminaal, B2C) — KLAAR. Patroon kleurt steen-voor-steen in
   (golf), eindigt met naamplaat. Audio: lo-fi / ASMR tegel-klik (als audiolaag, geen
   screencap). Hook: "Wanneer je geen standaard naambord wilt voor je nieuwe voordeur."
2. **Corporate Identity / B2B Flex** (direct + outreach) — toont een herkenbaar
   bedríjfstype (hip koffiehuis, architectenbureau, boetiekhotel); naam klikt in het
   patroon. Voor e-mailoutreach (UncleRank-namen) + Meta Ads. Audio: strakke chill/house.
   Hook: "Upgrade je receptie of horecazaak met handgemaakte zellige branding."
3. **Colorway Switch / A-B-C** (subliminaal + engagement) — zelfde patroon + naam fietst
   op de beat door 3 kleurenpaletten. Tekst: "Welke kies jij? A, B of C?" → comments →
   algoritme. Audio: ritmische beat met duidelijke drop op elke wissel.
4. **Problem vs. Solution** (direct / advertentie) — harde cut van saaie grijze muur
   naar adembenemend zellige-paneel met naam. Muziek slaat om bij het resultaat.
   Hook: "Stop met saaie muren → bouw je eigen zellige kunst."

Latere templates: ambacht-verhaal (vereist ateliervideo), uitleg/how-it-works (VO).

## Productieprincipes
- **Beat-synced:** animatie-overgangen (kleurwissel, before/after-cut) op de muziek
  timen. Muziek is dus niet alleen sfeer maar stuurt de timing.
- **Clean render, geen screencap:** we trekken de echte SVG en animeren die; ASMR-geluid
  komt als audiolaag.
- **Formaat parametrisch:** 9:16 default, 1:1 en 16:9 als vlag.

## Distributie (hoe het de deur uit gaat)
- **E-mail (B2B):** volledig automatisch. Gepersonaliseerde render per lead → Resend
  verstuurt. Geen ban-risico. Dit raakt de 8-dagen warm-up-deadline → prioriteit.
- **Social (TikTok/IG/Pinterest):** engine rendert video's + captions + hashtags naar een
  wachtrij; posten via de NATIVE planners van Meta/TikTok (gratis, veilig). Geen
  volautomatisch posten naar accounts — dat kost accounts (ban/shadowban).

## Wat we nog nodig hebben (gaten)
- **Muziek** (royaltyvrij) — Mo levert; wordt een keuze in de studio. Blokkeert beat-sync.
- **Echte ateliervideo/foto's uit Tetouan** (maalem, hakken, werkplaats) — grootste
  contentgat; authentiek en niet te faken. Blokkeert verhaal/ambacht-template.
- **Plaatsings-/mockupbeelden** + eerste klantbewijs voor social proof.
- **Voice-over** (zelf inspreken of lokale TTS) voor uitleg/verhaal.
- **Hooks/copy** per template & doelgroep (NL, evt. EN) — startcopy hierboven.
- **Andere site-bronnen** trekken dan alleen het mozaïek (preview-beelden, ontwerp-data).

## Volgorde (prioriteit n.a.v. deadline)
1. **Template 2 (gepersonaliseerde naam/bedrijf) + Resend-koppeling** — e-mailoutreach
   moet klaar zijn als de warm-up over ~8 dagen afloopt.
2. **Template 3 (Colorway Switch / A-B-C)** — bouwt op wat er staat, engagement-motor.
3. **Studio-UI** zodra er meerdere templates + muziek te kiezen zijn.
4. Daarna: Template 4 (before/after), ambacht-verhaal, uitleg, postworkflow.
