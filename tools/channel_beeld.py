#!/usr/bin/env python3
# umma_beeld.py — vult automatisch beeld per beeld-beat, net zoals umma_voice.py de stem vult.
# Draait LOKAAL op Mo's laptop (internet nodig). Leest assets/channels/channel1/voice/<story>/<voice>/
# _timeline.json, en zoekt per beat rechtenvrij beeld (Wikimedia Commons: publiek domein + CC),
# downloadt het naar assets/channels/channel1/video/ en zet het pad op de beat (beat.img). Daarna kijk je
# het na in de studio en vervang je alleen de missers. De "getekend"-beats (tekst/kaart/CTA) slaat
# hij over; die tekent de engine zelf.
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_beeld.py                 # alle lege beats vullen
#   python tools/channel_beeld.py --only 10       # alleen scene 10
#   python tools/channel_beeld.py --force         # ook beats die al beeld hebben opnieuw ophalen
#
# Geen API-sleutel nodig. Alles via de open Wikimedia Commons API.
import argparse, os, sys, json, time, urllib.parse, urllib.request, urllib.error, re, subprocess

UA = "UmmaUnited-content-engine/1.0 (local research use; contact via app)"
API = "https://commons.wikimedia.org/w/api.php"

# VIDEO-bronnen (optioneel, gratis sleutel). Zonder sleutel pakt de tool gewoon foto's van
# Wikimedia; mét sleutel haalt hij CC0-video van Pexels/Pixabay voor de 'video'-beats, en valt
# alleen terug op een foto als er geen video is. Zet je sleutel in een bestand tools/channel-keys.json
#   { "pexels": "JOUW_PEXELS_SLEUTEL", "pixabay": "JOUW_PIXABAY_SLEUTEL" }
# of als omgevingsvariabele PEXELS_API_KEY / PIXABAY_API_KEY. Allebei mag, één is genoeg.
def load_keys(root):
    keys = {"pexels": os.environ.get("PEXELS_API_KEY", ""), "pixabay": os.environ.get("PIXABAY_API_KEY", "")}
    kf = os.path.join(root, "tools", "channel-keys.json")
    try:
        if os.path.exists(kf):
            d = json.load(open(kf, encoding="utf-8"))
            keys["pexels"] = keys["pexels"] or d.get("pexels", "")
            keys["pixabay"] = keys["pixabay"] or d.get("pixabay", "")
    except Exception:
        pass
    return keys

# BEAT-INDELING (zelfde als de studio-editor): na welke zin-index een nieuwe beeld-beat begint,
# plus het label per beat. Zo kan deze tool de beats zelf aanmaken als ze nog niet in het
# tijdlijn-bestand staan (bv. je hebt de editor nog niet geopend/opgeslagen). Staat de editor-versie
# er wel, dan gebruiken we die (jouw sleep-correcties winnen).
# Beeld-beats per scène voor het NIEUWE script (19 scènes, 0=intro ... 18=outro). SPLITS = na
# welke zin-index een nieuwe beeld-beat begint. Beeld wisselt op een nieuw idee/plek, niet per zin.
SPLITS = {
 0:[], 1:[4], 2:[5], 3:[3,5], 4:[2,4], 5:[4,6], 6:[2,4,5,8], 7:[4,7,9], 8:[2], 9:[2,6],
 10:[2,4], 11:[2,3,4], 12:[4], 13:[5,8], 14:[3,6], 15:[2,4], 16:[5,7], 17:[4], 18:[],
}
LABELS = {
 0:["intro (merk)"],
 1:["het zwaard / de beschuldiging","geschiedenis op tafel"],
 2:["de druk / de test","Rome en Europa vooruit"],
 3:["kaart: Romeinse Rijk","Theodosius 380 (foto)","tempels neergehaald"],
 4:["verdreven Joden (gravure)","dezelfde schaduw (gravure)","de wereld ervoor"],
 5:["kaart: twee rijken","Perzisch rijk (video)","op het hoogtepunt"],
 6:["kerk blijft open","synagoge / vuurtempel","moskee, vrij gebed","Umar in Jeruzalem","geleefde rechtvaardigheid"],
 7:["de echte vraag","vrij, generatie na generatie","het hart beweegt eerst","Rome's geloof valt weg"],
 8:["meer dan 1000 jaar","dieper geworteld"],
 9:["Europa vaart uit","kaart: koloniale greep","het zwaard, echt"],
 10:["moskee tot kathedraal","Quran uit de scholen","alles geprobeerd"],
 11:["het hield stand","Indonesie","Bosnie","Noord-Afrika"],
 12:["cijfers voor en na","geen leger neemt een hart"],
 13:["de verkeerde religie","gedwongen geloof (gravure)","lege kathedralen"],
 14:["een wond","afkeer van geloof","hun verhaal, niet het onze"],
 15:["geregeerd met recht","beschermde gebedshuizen","recht opende de harten"],
 16:["wiens hand aan het zwaard","de waarheid gezien","jij bent het bewijs"],
 17:["de waarheid loopt recht","volg ons (CTA)"],
 18:["outro (merk)"],
}

# VIDEO NORMALISEREN — opgehaalde clips zijn vaak 4K en soms 50fps; een laptop zonder losse GPU
# kan dat niet vlot in een videovak afspelen (preview blijft zwart). We zetten elke video om naar
# maximaal 1080p en 30fps, zelfde codec (H.264/yuv420p). Klein en overal afspeelbaar; de render
# leest hetzelfde bestand.
_FFMPEG_CACHE = {}
def _ffmpeg_bin(root):
    if "bin" not in _FFMPEG_CACHE:
        try:
            _FFMPEG_CACHE["bin"] = subprocess.check_output(
                ["node", "-e", "process.stdout.write(require('ffmpeg-static'))"],
                cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            _FFMPEG_CACHE["bin"] = "ffmpeg"
    return _FFMPEG_CACHE["bin"]

def normalize_video(path, root):
    ff = _ffmpeg_bin(root)
    tmp = path + ".norm.mp4"
    cmd = [ff, "-y", "-v", "error", "-i", path,
           "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
           "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "20",
           "-preset", "veryfast", "-movflags", "+faststart", "-an", tmp]
    try:
        subprocess.run(cmd, check=True)
        os.replace(tmp, path)
        return True
    except Exception as e:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except Exception: pass
        print(f"    normaliseren mislukt: {e}")
        return False

def ensure_beats(sc):
    # Herbouw de beeld-beats ELKE run uit SPLITS/LABELS — dat is de enige bron van waarheid voor de
    # beat-indeling. Media (img/vid) die al bij een beat met HETZELFDE label hoorde nemen we mee, zodat
    # gekozen/vervangen beeld niet verdwijnt bij een herbouw. Hierdoor blijft de keten na een
    # scriptwijziging altijd kloppen: oude beats/labels blijven niet meer hangen (dat was de bug).
    num = sc.get("scene"); sents = sc.get("sentences") or []
    old = {b.get("label"): b for b in (sc.get("beats") or []) if b.get("label")}
    if not sents:
        sc["beats"] = []; return
    splits = SPLITS.get(num, []); labs = LABELS.get(num, [])
    edges = [sents[0]["start"]] + [sents[i]["start"] for i in splits if i < len(sents)] + [sc.get("speech_end", sc.get("dur", 0))]
    beats = []
    for i in range(len(edges) - 1):
        lab = labs[i] if i < len(labs) else f"beeld {i+1}"
        prev = old.get(lab) or {}
        beats.append({"start": round(edges[i], 3), "dur": round(edges[i+1]-edges[i], 3),
                      "label": lab, "img": prev.get("img", ""), "vid": prev.get("vid", "")})
    sc["beats"] = beats

# ZOEKPLAN per scene -> per beat (in volgorde). kind: 'photo' = ophalen, 'drawn' = overslaan
# (engine tekent de tekst/kaart/CTA zelf). De query is de Engelse zoekterm op Commons.
# kind: 'video' = liefst video (Pexels/Pixabay met sleutel), anders foto als terugval;
#       'photo' = alleen foto (historisch/gravure, daar bestaat geen video van);
#       'drawn' = overslaan (engine tekent tekst/kaart/CTA zelf).
PLAN = {
 0:[("drawn","")],
 1:[("video","ancient sword blade dark dramatic slow"),("video","old library ancient books candlelight")],
 2:[("video","dark storm clouds dramatic time lapse"),("video","ancient roman ruins columns")],
 3:[("drawn",""),("photo","Theodosius I Roman emperor"),("video","ancient temple ruins stone")],
 4:[("photo","expulsion of the jews historical engraving"),("photo","medieval persecution jews engraving"),("video","dark medieval stone hall torch")],
 5:[("drawn",""),("video","ancient persian ruins ctesiphon arch"),("video","sunrise over old city skyline")],
 6:[("video","old church interior candles"),("video","synagogue interior menorah"),("video","mosque interior arches prayer"),("video","jerusalem old city dome of the rock"),("video","muslim men praying in mosque")],
 7:[("video","crowd people silhouette walking"),("video","old medina street life morocco"),("video","single candle flame dark"),("video","abandoned ruined church overgrown")],
 8:[("video","historic mosque minaret sunset"),("video","mosque courtyard people prayer")],
 9:[("video","old tall sailing ship ocean"),("drawn",""),("video","colonial soldiers marching archival")],
 10:[("photo","Ketchaoua Mosque Algiers"),("photo","french colonial algeria historical"),("video","dark dramatic storm sky")],
 11:[("video","mosque crowd prayer aerial"),("video","istiqlal mosque jakarta indonesia"),("video","mosque sarajevo bosnia"),("video","morocco mosque minaret medina")],
 12:[("video","mass prayer crowd aerial mosque"),("video","muslim man praying hands raised close up")],
 13:[("video","dark dramatic clouds sky"),("photo","medieval european cathedral engraving"),("video","empty european cathedral interior wide")],
 14:[("video","cracked stone wall dark"),("video","modern european city street empty"),("video","empty church pews interior")],
 15:[("video","alhambra islamic architecture arches"),("video","andalusian courtyard fountain old city"),("video","muslim prayer sujood warm light")],
 16:[("video","ancient sword blade close up"),("video","sunrise light over old city mosque"),("video","mass prayer crowd aerial sunset")],
 17:[("video","long straight empty road horizon"),("video","person walking path sunrise silhouette")],
 18:[("drawn","")],
}

# GETEKENDE KAART per scène: aparte kleur + label per gebied, plus een jaartal/periode-badge, zodat
# de kaart het verhaal vertelt (niet alleen een kaart tonen). Landgroepen staan als LANDNAMEN; de
# engine zet ze om naar kaart-id's. Kleuren: red/blue/orange/green/cream. Namen die niet in de
# kaart voorkomen worden simpelweg overgeslagen.
GROUPS = {
 "rome":      ["Morocco","Algeria","Tunisia","Libya","Egypt","Israel","Lebanon","Syria","Jordan","Turkey","Greece","Italy","Spain","Portugal","France"],
 "byz":       ["Syria","Egypt","Turkey","Lebanon","Jordan","Israel","Greece"],
 "persia":    ["Iran","Iraq","Afghanistan","Turkmenistan"],
 "colonised": ["Morocco","Algeria","Tunisia","Libya","Egypt","Indonesia","Malaysia","Bosnia and Herz.","Pakistan","Nigeria","Senegal"],
 "europe":    ["France","Spain","Portugal","United Kingdom","Netherlands","Belgium","Italy","Germany"],
}
# per scène: welke beat de kaart is (beat-index), de uitsnede (view), kleuren per groep (fills),
# labels per groep (tekst op het gebied), en de info-badge (jaartal/periode).
KAART = {
 3: {"beat": 0, "view": "mena", "kaartInfo": "Rome rules, from 380 AD",
     "fills": {"rome": "red"}, "labels": {"rome": "Roman Empire"}},
 5: {"beat": 0, "view": "mena", "kaartInfo": "The 630s: both empires fall",
     "fills": {"byz": "red", "persia": "blue"}, "labels": {"byz": "Roman Empire", "persia": "Persian Empire"}},
 9: {"beat": 1, "view": "belt", "kaartInfo": "Colonisation, 1500s to 1900s",
     "fills": {"europe": "red", "colonised": "orange"}, "labels": {"europe": "European empires", "colonised": "Muslim lands"}},
}

# ============================================================================================
# BEELDPLAN PER VERHAAL. SPLITS/LABELS/PLAN/KAART hierboven zijn van "sword". Een nieuw verhaal
# krijgt zijn EIGEN blok; de tool kiest op --story (valt terug op sword voor bestaand gedrag).
# Zo plakt sword's beeld (zwaarden/Rome/moskeeën/kaarten) nooit meer op een ander verhaal.
SPLITS_BY = {"sword": SPLITS}
LABELS_BY = {"sword": LABELS}
PLAN_BY   = {"sword": PLAN}
KAART_BY  = {"sword": KAART}
GROUPS_BY = {"sword": GROUPS}

# chose = "The Answer You Never Chose" (video 1). 14 scènes: 0=intro (getekend merk),
# 1..12 = inhoud (beeld ophalen), 13=outro (getekend merk). GEEN kaarten (geen geografie).
# Afgestemd op de GEGENEREERDE stem-tijdlijn (14 scènes), niet op de oude 12-scène-versie.
SPLITS_BY["chose"] = {
 0:[], 1:[6,12], 2:[5], 3:[4,8], 4:[6], 5:[3], 6:[4,9],
 7:[6], 8:[5,9,12,15], 9:[4], 10:[5,10,15], 11:[7,14], 12:[7,14,21], 13:[],
}
LABELS_BY["chose"] = {
 0:["intro (merk)"],
 1:["de vogel: geprogrammeerd","jij weegt, redeneert, kiest","een stil soort wonder"],
 2:["de lucht, een jas","duizend kleine keuzes per dag"],
 3:["de pijn die niet weggaat","naar wie het wel weet","je eigen grens zien = rationeel"],
 4:["de wet: eerst weten","de brug, jaren doorgerekend"],
 5:["een vraag waar het stopt","de grootste die er is"],
 6:["waarom ben je hier","wat is dit, wat als het eindigt","de kamer valt stil"],
 7:["ik had mijn antwoord ook","de barst in de muur"],
 8:["deur 1: thuis","deur 2: een moment","deur 3: de mensen om je heen","deur 4: de wereld / schermen","deur 5: de pijn"],
 9:["vier van buiten, een duwt weg","en beiden zeker dat ze kozen"],
 10:["volwassen nu (spiegel)","verweven met wie je bent","je verdedigt het (muur)","de scherpste geest verdedigt het best"],
 11:["er lag al een antwoord klaar","nooit een leeg vel","eerlijk: misschien een zesde"],
 12:["hoe weet je of het waar is","de mist: ieder zijn waarheid","de dageraad, de open weg","bestaat blijvende waarheid, video 2"],
 13:["outro (merk)"],
}
PLAN_BY["chose"] = {
 0:[("drawn","")],
 1:[("video","flock of birds migrating sky slow motion"),("video","silhouette person standing alone contemplative"),("video","close up human eye reflective looking")],
 2:[("video","grey overcast cloudy sky before rain"),("video","hands putting on coat jacket by door")],
 3:[("video","person holding side in pain discomfort"),("video","doctor examining patient hospital corridor"),("video","x-ray scan medical lightbox stethoscope")],
 4:[("video","old law books library shelves"),("video","steel bridge structure engineering low angle")],
 5:[("video","vast dark sky horizon at dusk"),("video","single closed door dim light")],
 6:[("video","deep space stars galaxy slow drift"),("video","single candle flame in darkness"),("video","empty quiet room light beam dust floating")],
 7:[("video","person sitting alone by window pensive"),("video","crack in old plaster wall close up")],
 8:[("video","warm family home interior evening silhouette"),("video","light flare bokeh abstract dreamy memory"),("video","crowd of people walking same direction street"),("video","television screens glowing dark room"),("video","person walking away alone in rain street")],
 9:[("video","row of old wooden doors dim hallway"),("video","forked path diverging two ways forest")],
 10:[("video","person reflection in mirror low light"),("video","interwoven threads rope macro texture"),("video","old stone fortress wall defensive"),("video","chess pieces board strategy close up")],
 11:[("video","blank sheet of paper on desk with pen"),("video","closed door with light behind it"),("video","hand writing in notebook close up")],
 12:[("video","figure standing in doorway bright light"),("video","foggy misty path early morning"),("video","vast dawn horizon open landscape"),("video","long empty road leading to horizon")],
 13:[("drawn","")],
}
KAART_BY["chose"]  = {}   # geen kaarten voor chose
GROUPS_BY["chose"] = {}

def select_story_plan(story):
    # Zet het actieve beeldplan op dat van <story> (valt terug op sword). Geeft True als het
    # verhaal een eigen plan heeft, anders False (dan draait het op het sword-plan).
    global SPLITS, LABELS, PLAN, KAART, GROUPS
    SPLITS = SPLITS_BY.get(story, SPLITS_BY["sword"])
    LABELS = LABELS_BY.get(story, LABELS_BY["sword"])
    PLAN   = PLAN_BY.get(story,   PLAN_BY["sword"])
    KAART  = KAART_BY.get(story,  KAART_BY["sword"])
    GROUPS = GROUPS_BY.get(story, GROUPS_BY["sword"])
    return story in SPLITS_BY


def apply_kaart(tl):
    # zet de kaart-velden op de juiste scènes en de landgroepen bovenin de tijdlijn; maakt de kaart-
    # beat leeg (geen foto/video) zodat de engine daar de getekende kaart tekent.
    tl["groups"] = GROUPS
    by = {s.get("scene"): s for s in tl.get("scenes", [])}
    for num, cfg in KAART.items():
        sc = by.get(num)
        if not sc:
            continue
        sc["tech"] = "kaart"
        sc["view"] = cfg["view"]
        sc["fills"] = cfg["fills"]
        sc["labels"] = cfg["labels"]
        sc["kaartInfo"] = cfg["kaartInfo"]
        beats = sc.get("beats") or []
        bi = cfg["beat"]
        if 0 <= bi < len(beats):
            beats[bi]["img"] = ""; beats[bi]["vid"] = ""   # getekend, geen media
        print(f"kaart scène {num}: {', '.join(cfg['labels'].values())}  [{cfg['kaartInfo']}]")

def _get(url, tries=4):
    # robuust tegen 429/503 (snelheidslimiet): lees Retry-After of gebruik oplopende backoff en
    # probeer opnieuw. Zo pakt één run alles, ook als een bron even op de rem gaat staan.
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 503):
                ra = e.headers.get("Retry-After")
                wait = int(ra) if (ra and ra.isdigit()) else (3 * (i + 1) + 2)
                print(f"    {e.code} (te snel) -> {wait}s wachten en opnieuw...")
                time.sleep(wait); continue
            raise
        except Exception as e:
            last = e; time.sleep(2 * (i + 1)); continue
    if last: raise last

def _api(params):
    params = {**params, "format": "json", "maxlag": "5"}  # maxlag = beleefd tegen Wikimedia
    url = API + "?" + urllib.parse.urlencode(params)
    return json.loads(_get(url).decode("utf-8", "replace"))

def _ok_license(ext):
    # accepteer publiek domein + CC-licenties; weiger onbekend/alle-rechten.
    lic = ((ext.get("LicenseShortName", {}) or {}).get("value", "") or "").lower()
    return any(k in lic for k in ["public domain", "cc0", "cc by", "cc-by", "pdm", "no restrictions"])

# RELEVANTIE: niet blind het eerste resultaat pakken, maar de treffer waarvan de tags (video) of
# de titel (foto) het best matchen met de zoekterm. Generieke woorden (dark/old/...) tellen licht,
# specifieke woorden (mosque/persian/jerusalem/...) tellen zwaar. Zo vallen rare/ongerelateerde
# treffers af en kiezen we het beeld dat echt bij de scène hoort.
_GENERIC = {"the", "a", "of", "and", "in", "on", "to", "at", "over", "with", "dark", "old",
            "ancient", "dramatic", "slow", "close", "up", "wide", "great", "real", "historical"}
def _relevance(text, query):
    t = " " + re.sub(r"[^a-z0-9]+", " ", (text or "").lower()) + " "
    qs = [w for w in re.findall(r"[a-z]+", query.lower()) if len(w) > 2]
    score = 0
    for w in qs:
        if (" " + w + " ") in t or (w + "s ") in t:
            score += 1 if w in _GENERIC else 3
    return score

def _search_image_once(gsrsearch, query):
    # één Commons-zoekopdracht -> lijst kandidaten (bruikbare licentie, bitmap).
    try:
        d = _api({
            "action": "query", "generator": "search",
            "gsrsearch": gsrsearch + " filetype:bitmap", "gsrnamespace": "6", "gsrlimit": "12",
            "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size", "iiurlwidth": "1920",
        })
    except Exception as e:
        print(f"    zoekfout: {e}"); return []
    pages = ((d.get("query") or {}).get("pages") or {})
    cands = []
    for p in pages.values():
        ii = (p.get("imageinfo") or [{}])[0]
        mime = ii.get("mime", "")
        if not mime.startswith("image/"): continue
        if mime in ("image/svg+xml",): continue
        ext = ii.get("extmetadata", {}) or {}
        if not _ok_license(ext): continue
        w = ii.get("width", 0) or ii.get("thumbwidth", 0)
        url = ii.get("thumburl") or ii.get("url")
        if not url: continue
        cred = ((ext.get("Artist", {}) or {}).get("value", "") or "")
        cred = re.sub("<[^>]+>", "", cred).strip()
        lic = ((ext.get("LicenseShortName", {}) or {}).get("value", "") or "")
        cands.append({"url": url, "mime": mime, "w": w, "credit": cred, "license": lic,
                      "title": p.get("title", "")})
    return cands

def search_image(query):
    # Commons-foto, GERANGSCHIKT OP RELEVANTIE (titel matcht de zoekterm), dan op breedte. Vindt de
    # volle zoekterm niks, dan nog een poging met alleen de SPECIFIEKE woorden (generieke eruit),
    # zodat historische termen als "expulsion jews" niet stil op niets uitlopen.
    cands = _search_image_once(query, query)
    if not cands:
        specific = " ".join(w for w in query.split() if w.lower() not in _GENERIC)
        if specific and specific != query:
            print(f"    (geen treffer, opnieuw met '{specific}')")
            cands = _search_image_once(specific, query)
    cands.sort(key=lambda c: (_relevance(c["title"], query), c["w"]), reverse=True)
    return cands[0] if cands else None

def ext_for(mime):
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(mime, ".jpg")

def _getj(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def search_video(query, keys, min_dur=0):
    # LANDSCAPE (16:9) video, GERANGSCHIKT OP RELEVANTIE: niet de bovenste treffer, maar de
    # liggende clip waarvan de Pixabay-tags het best bij de zoekterm passen (tie-break op resolutie).
    # Zo vallen rare/ongerelateerde clips af. Pexels als terugval (zelden een sleutel).
    try:
        if keys.get("pixabay"):
            d = _getj("https://pixabay.com/api/videos/?" + urllib.parse.urlencode({"key": keys["pixabay"], "q": query, "per_page": 30}))
            scored = []
            for h in d.get("hits", []):
                if min_dur and h.get("duration", 0) < min_dur:
                    continue
                vids = h.get("videos", {})
                best = None
                for size in ("large", "medium", "small"):
                    v = vids.get(size)
                    if v and v.get("url") and (v.get("width", 0) >= v.get("height", 0)) and v.get("width", 0) >= 1280:
                        best = v; break
                if not best:
                    continue
                rel = _relevance(h.get("tags", ""), query)
                scored.append((rel, best.get("width", 0), {"url": best["url"], "ext": ".mp4",
                               "credit": h.get("user", "Pixabay"), "license": "Pixabay License (free)"}))
            if scored:
                # hoogste relevantie eerst, dan hoogste resolutie
                scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
                if scored[0][0] == 0:
                    print("    (geen tag-match, beste gok)")
                return scored[0][2]
    except Exception as e:
        print(f"    pixabay-fout: {e}")
    try:
        if keys.get("pexels"):
            d = _getj("https://api.pexels.com/videos/search?" + urllib.parse.urlencode({"query": query, "per_page": 10, "orientation": "landscape"}),
                      headers={"Authorization": keys["pexels"]})
            for v in d.get("videos", []):
                if min_dur and v.get("duration", 0) < min_dur:
                    continue
                files = sorted(v.get("video_files", []), key=lambda f: (f.get("width") or 0), reverse=True)
                hd = next((f for f in files if (f.get("width") or 0) >= 1280 and (f.get("width", 0) >= f.get("height", 0))), files[0] if files else None)
                if hd and hd.get("link"):
                    return {"url": hd["link"], "ext": ".mp4", "credit": (v.get("user", {}) or {}).get("name", "Pexels"), "license": "Pexels License (free)"}
    except Exception as e:
        print(f"    pexels-fout: {e}")
    return None

def search_video_many(query, keys, n=3, min_dur=0):
    # Als search_video, maar levert de TOP-N liggende clips (voor de 3-kandidaten-keuze in de studio).
    out = []
    try:
        if keys.get("pixabay"):
            d = _getj("https://pixabay.com/api/videos/?" + urllib.parse.urlencode({"key": keys["pixabay"], "q": query, "per_page": 30}))
            scored = []
            for h in d.get("hits", []):
                if min_dur and h.get("duration", 0) < min_dur:
                    continue
                vids = h.get("videos", {}); best = None
                for size in ("large", "medium", "small"):
                    v = vids.get(size)
                    if v and v.get("url") and (v.get("width", 0) >= v.get("height", 0)) and v.get("width", 0) >= 1280:
                        best = v; break
                if not best:
                    continue
                rel = _relevance(h.get("tags", ""), query)
                scored.append((rel, best.get("width", 0), {"url": best["url"], "ext": ".mp4",
                               "credit": h.get("user", "Pixabay"), "license": "Pixabay License (free)"}))
            scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
            out = [s[2] for s in scored[:n]]
    except Exception as e:
        print(f"    pixabay-fout: {e}", file=sys.stderr)
    if len(out) < n:
        try:
            if keys.get("pexels"):
                d = _getj("https://api.pexels.com/videos/search?" + urllib.parse.urlencode({"query": query, "per_page": 10, "orientation": "landscape"}),
                          headers={"Authorization": keys["pexels"]})
                for v in d.get("videos", []):
                    if min_dur and v.get("duration", 0) < min_dur:
                        continue
                    files = sorted(v.get("video_files", []), key=lambda f: (f.get("width") or 0), reverse=True)
                    hd = next((f for f in files if (f.get("width") or 0) >= 1280 and (f.get("width", 0) >= f.get("height", 0))), files[0] if files else None)
                    if hd and hd.get("link"):
                        out.append({"url": hd["link"], "ext": ".mp4", "credit": (v.get("user", {}) or {}).get("name", "Pexels"), "license": "Pexels License (free)"})
                        if len(out) >= n:
                            break
        except Exception as e:
            print(f"    pexels-fout: {e}", file=sys.stderr)
    return out[:n]

def search_image_many(query, n=3):
    # Als search_image, maar de TOP-N foto's (voor de 3-kandidaten-keuze in de studio).
    cands = _search_image_once(query, query)
    if not cands:
        specific = " ".join(w for w in query.split() if w.lower() not in _GENERIC)
        if specific and specific != query:
            cands = _search_image_once(specific, query)
    cands.sort(key=lambda c: (_relevance(c["title"], query), c["w"]), reverse=True)
    return cands[:n]

def fetch_candidates(tl, num, bi, keys, outdir, story, channel, n, root):
    # STUDIO-MODUS: zoek N kandidaten voor EEN slot (scene num, beat-index bi 0-gebaseerd) en zet ze
    # klaar als s<NN>b<bi+1>__c<k>.<ext>. Verandert de tijdlijn NIET: de studio toont de N, jij kiest
    # er één (die wordt beat.vid/img), de rest blijft als reserve staan.
    sc = next((s for s in tl.get("scenes", []) if s.get("scene") == num), None)
    if sc is None:
        return []
    ensure_beats(sc)
    plan = PLAN.get(num, [])
    kind, query = plan[bi] if bi < len(plan) else ("drawn", "")
    if kind == "drawn" or not query:
        return []
    beats = sc.get("beats") or []
    beat = beats[bi] if bi < len(beats) else {}
    have_video = bool(keys.get("pexels") or keys.get("pixabay"))
    hits = []
    if kind == "video" and have_video:
        hits = [("vid", h) for h in search_video_many(query, keys, n, min_dur=max(4, int(beat.get("dur", 0))))]
    if len(hits) < n:   # te weinig video -> aanvullen met foto's zodat je altijd een keuze hebt
        for h in search_image_many(query, n - len(hits)):
            hits.append(("img", h))
    results = []
    for k, (soort, hit) in enumerate(hits[:n], start=1):
        ext = hit.get("ext") or ext_for(hit.get("mime", ""))
        fname = f"s{num:02d}b{bi+1}__c{k}{ext}"
        fpath = os.path.join(outdir, fname)
        try:
            data = _get(hit["url"])
            with open(fpath, "wb") as f:
                f.write(data)
        except Exception as e:
            print(f"    downloadfout kandidaat {k}: {e}", file=sys.stderr); continue
        isv = (soort == "vid")
        if isv:
            try:
                normalize_video(fpath, root)
            except Exception as e:
                print(f"    normfout kandidaat {k}: {e}", file=sys.stderr)
        results.append({"file": story + "/" + fname, "kind": "vid" if isv else "img",
                        "credit": hit.get("credit", ""), "license": hit.get("license", "")})
        time.sleep(0.6)
    return results

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword")
    ap.add_argument("--voice", default="man")
    ap.add_argument("--root", default=".")
    ap.add_argument("--only", type=int, default=0, help="alleen scene N")
    ap.add_argument("--force", action="store_true", help="ook beats die al beeld hebben opnieuw ophalen")
    ap.add_argument("--channel", default="channel1", help="kanaal-map onder assets/channels/")
    ap.add_argument("--candidates", type=int, default=0, help="studio-modus: N kandidaten voor EEN slot (met --only scene --beat index), i.p.v. de hele batch")
    ap.add_argument("--beat", type=int, default=0, help="0-gebaseerde beat-index binnen de scene (alleen met --candidates)")
    args = ap.parse_args()

    # kies het beeldplan van DIT verhaal (sword/chose/...); val terug op sword als het onbekend is
    if not select_story_plan(args.story):
        print(f"let op: geen eigen beeldplan voor '{args.story}' -> val terug op sword-plan")
    tlpath = os.path.join(args.root, "assets", "channels", args.channel, "voice", args.story, args.voice, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json:", tlpath, "\n-> draai eerst: python tools/channel_voice.py --voice", args.voice); return
    tl = json.load(open(tlpath, encoding="utf-8"))

    # BEELD PER PROJECT: elke video (verhaal) krijgt zijn eigen beeldmap, zodat scène+beat van het ene
    # verhaal nooit het beeld van een ander verhaal pakt. (Oud: één gedeelde map -> kruisbesmetting.)
    outdir = os.path.join(args.root, "assets", "channels", args.channel, "video", args.story)
    os.makedirs(outdir, exist_ok=True)
    keys = load_keys(args.root)
    # STUDIO-MODUS: 3 kandidaten voor één slot, als JSON terug (de engine roept dit per slot aan).
    if args.candidates:
        res = fetch_candidates(tl, args.only, args.beat, keys, outdir, args.story, args.channel, args.candidates, args.root)
        print("CANDIDATES_JSON:" + json.dumps({"candidates": res}))
        return
    have_video = bool(keys.get("pexels") or keys.get("pixabay"))
    print("video-bron:", ("Pexels/Pixabay actief" if have_video else "geen sleutel -> alleen foto's (Wikimedia)"))
    credits = []
    n_done = n_skip = n_fail = 0

    for sc in tl.get("scenes", []):
        num = sc.get("scene")
        if args.only and num != args.only: continue
        ensure_beats(sc)
        beats = sc.get("beats") or []
        plan = PLAN.get(num, [])
        for bi, beat in enumerate(beats):
            spec = plan[bi] if bi < len(plan) else ("drawn", "")
            kind, query = spec
            if kind == "drawn" or not query:
                continue
            # Alleen overslaan als het beeld AL in de eigen verhaal-map staat. Wijst het nog naar de
            # oude gedeelde map (of een ander verhaal), dan halen we het opnieuw op in deze map, zodat
            # elk project zijn eigen beeld krijgt (auto-migratie, geen --force nodig).
            cur = (beat.get("vid") or beat.get("img") or "").replace("\\", "/")
            own_prefix = "assets/channels/" + args.channel + "/video/" + args.story + "/"
            if cur and own_prefix in cur and not args.force:
                n_skip += 1; continue
            # HERGEBRUIK op naam: staan de kandidaten (of een oud enkel bestand) al op schijf? Dan
            # koppelen we terug ZONDER te downloaden. Voorkeur voor __c1 (de 3-kandidaten-opzet),
            # anders het oude enkele bestand s<NN>b<bi+1>.<ext>. Alleen echt niets -> hieronder zoeken.
            if not args.force:
                base = f"s{num:02d}b{bi+1}"
                found = None
                for ext in (".mp4", ".webm", ".jpg", ".jpeg", ".png", ".webp"):
                    if os.path.exists(os.path.join(outdir, base + "__c1" + ext)):
                        found = (base + "__c1" + ext, ext); break
                if not found:
                    for ext in (".mp4", ".webm", ".jpg", ".jpeg", ".png", ".webp"):
                        if os.path.exists(os.path.join(outdir, base + ext)):
                            found = (base + ext, ext); break
                if found:
                    fname, ext = found
                    rel = "assets/channels/" + args.channel + "/video/" + args.story + "/" + fname
                    isv = ext.lower() in (".mp4", ".webm")
                    beat["vid" if isv else "img"] = rel
                    beat.pop("img" if isv else "vid", None)
                    print(f"scene {num} beat {bi+1}: hergebruik {fname}")
                    n_skip += 1; continue
            # 3 KANDIDATEN METEEN: haal per blok 3 clips/foto's op (__c1/__c2/__c3) en zet __c1 als
            # standaard op de beat. Zo ziet de studio direct 3 keuzes zonder nog live te zoeken.
            print(f"scene {num} beat {bi+1}: zoek 3 kandidaten '{query}' ({kind})")
            res = fetch_candidates(tl, num, bi, keys, outdir, args.story, args.channel, 3, args.root)
            if not res:
                print("    niets bruikbaars gevonden -> laat leeg (zoek jij zelf)"); n_fail += 1; time.sleep(0.5); continue
            c1 = res[0]
            isv = c1["kind"] == "vid"
            beat["vid" if isv else "img"] = "assets/channels/" + args.channel + "/video/" + c1["file"]
            beat.pop("img" if isv else "vid", None)
            for c in res:
                credits.append(f"scene {num} beat {bi+1}: {c.get('file','')} | {c.get('license','')} | {c.get('credit','')}")
            print(f"    -> {len(res)} kandidaten klaar, standaard: {c1['file'].split('/')[-1]} ({'video' if isv else 'foto'})")
            n_done += 1

    # getekende kaarten (Rome / twee rijken / kolonisatie) in de tijdlijn zetten
    apply_kaart(tl)

    with open(tlpath, "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)
    cpath = os.path.join(outdir, "_credits.txt")
    with open(cpath, "a", encoding="utf-8") as f:
        f.write("\n".join(credits) + ("\n" if credits else ""))
    print(f"\nklaar: {n_done} opgehaald, {n_skip} overgeslagen (al beeld), {n_fail} niet gevonden.")
    print(f"tijdlijn bijgewerkt: {tlpath}")
    print(f"bronvermelding: {cpath}")
    print("Open de studio, controleer het beeld per beat, en vervang de missers.")

if __name__ == "__main__":
    main()
