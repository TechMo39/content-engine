#!/usr/bin/env python3
# umma_beeld.py — vult automatisch beeld per beeld-beat, net zoals umma_voice.py de stem vult.
# Draait LOKAAL op Mo's laptop (internet nodig). Leest assets/ummaunited/voice/<story>/<voice>/
# _timeline.json, en zoekt per beat rechtenvrij beeld (Wikimedia Commons: publiek domein + CC),
# downloadt het naar assets/ummaunited/video/ en zet het pad op de beat (beat.img). Daarna kijk je
# het na in de studio en vervang je alleen de missers. De "getekend"-beats (tekst/kaart/CTA) slaat
# hij over; die tekent de engine zelf.
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/umma_beeld.py                 # alle lege beats vullen
#   python tools/umma_beeld.py --only 10       # alleen scene 10
#   python tools/umma_beeld.py --force         # ook beats die al beeld hebben opnieuw ophalen
#
# Geen API-sleutel nodig. Alles via de open Wikimedia Commons API.
import argparse, os, json, time, urllib.parse, urllib.request, urllib.error, re, subprocess

UA = "UmmaUnited-content-engine/1.0 (local research use; contact via app)"
API = "https://commons.wikimedia.org/w/api.php"

# VIDEO-bronnen (optioneel, gratis sleutel). Zonder sleutel pakt de tool gewoon foto's van
# Wikimedia; mét sleutel haalt hij CC0-video van Pexels/Pixabay voor de 'video'-beats, en valt
# alleen terug op een foto als er geen video is. Zet je sleutel in een bestand tools/umma-keys.json
#   { "pexels": "JOUW_PEXELS_SLEUTEL", "pixabay": "JOUW_PIXABAY_SLEUTEL" }
# of als omgevingsvariabele PEXELS_API_KEY / PIXABAY_API_KEY. Allebei mag, één is genoeg.
def load_keys(root):
    keys = {"pexels": os.environ.get("PEXELS_API_KEY", ""), "pixabay": os.environ.get("PIXABAY_API_KEY", "")}
    kf = os.path.join(root, "tools", "umma-keys.json")
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

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword")
    ap.add_argument("--voice", default="man")
    ap.add_argument("--root", default=".")
    ap.add_argument("--only", type=int, default=0, help="alleen scene N")
    ap.add_argument("--force", action="store_true", help="ook beats die al beeld hebben opnieuw ophalen")
    args = ap.parse_args()

    tlpath = os.path.join(args.root, "assets", "ummaunited", "voice", args.story, args.voice, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json:", tlpath, "\n-> draai eerst: python tools/umma_voice.py --voice", args.voice); return
    tl = json.load(open(tlpath, encoding="utf-8"))

    outdir = os.path.join(args.root, "assets", "ummaunited", "video")
    os.makedirs(outdir, exist_ok=True)
    keys = load_keys(args.root)
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
            if (beat.get("img") or beat.get("vid")) and not args.force:
                n_skip += 1; continue
            # HERGEBRUIK: staat het beeld voor deze beat al op schijf (s<NN>b<bi+1>.<ext>)? Dan koppelen
            # we dat terug ZONDER iets te downloaden. De tijdlijn was vers/leeg, maar de bestanden staan
            # er nog; zo herstellen we de koppeling op naam i.p.v. nieuw te zoeken. Alleen als er echt
            # geen bestand is (of --force), gaan we daaronder pas zoeken.
            if not args.force:
                base = f"s{num:02d}b{bi+1}"
                found = None
                for ext in (".mp4", ".webm", ".jpg", ".jpeg", ".png", ".webp"):
                    cand = os.path.join(outdir, base + ext)
                    if os.path.exists(cand):
                        found = (base + ext, ext); break
                if found:
                    fname, ext = found
                    rel = "assets/ummaunited/video/" + fname
                    isv = ext.lower() in (".mp4", ".webm")
                    beat["vid" if isv else "img"] = rel
                    beat.pop("img" if isv else "vid", None)
                    print(f"scene {num} beat {bi+1}: hergebruik {fname} ({'video' if isv else 'foto'})")
                    n_skip += 1; continue
            print(f"scene {num} beat {bi+1}: zoek '{query}' ({kind})")
            hit = None; is_video = False
            # 'video'-beat + sleutel -> eerst video proberen (lang genoeg voor de beat)
            if kind == "video" and have_video:
                hit = search_video(query, keys, min_dur=max(4, int(beat.get("dur", 0))))
                if hit:
                    is_video = True
            if not hit:  # foto-terugval (ook voor video-beats zonder sleutel of zonder treffer)
                hit = search_image(query)
            if not hit:
                print("    niets bruikbaars gevonden -> laat leeg (zoek jij zelf)"); n_fail += 1; time.sleep(0.5); continue
            ext = hit.get("ext") or ext_for(hit.get("mime", ""))
            fname = f"s{num:02d}b{bi+1}{ext}"
            fpath = os.path.join(outdir, fname)
            try:
                data = _get(hit["url"])
                with open(fpath, "wb") as f: f.write(data)
            except Exception as e:
                print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(0.5); continue
            if is_video and normalize_video(fpath, args.root):
                print("    genormaliseerd -> max 1080p30 (app-afspeelbaar)")
            rel = "assets/ummaunited/video/" + fname
            beat["vid" if is_video else "img"] = rel
            beat.pop("img" if is_video else "vid", None)  # oude tegenpool opruimen
            credits.append(f"scene {num} beat {bi+1}: {hit.get('title','')} | {hit['license']} | {hit['credit']}")
            print(f"    -> {fname}  ({'video' if is_video else 'foto'}, {hit['license']})")
            n_done += 1
            time.sleep(1.3)  # beleefd tegen de API's (voorkomt de 429-snelheidslimiet)

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
