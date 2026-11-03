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
import argparse, os, json, time, urllib.parse, urllib.request, re

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
SPLITS = {1:[2,5],2:[2,6],3:[2],4:[2,4],5:[1,3],6:[2,5,8],7:[3,6],8:[2,8],9:[2,6],10:[1,2,3],
          11:[3,4],12:[4,6],13:[2,5,7],14:[3,6],15:[2,4],16:[1,3,5]}
LABELS = {
 1:["donkere verovering","de regel (tekst)","horizon vooruit"],
 2:["de regel bevestigd (tekst)","een kling, de echte vraag","overgang: op pad"],
 3:["kaart: Rome (getekend)","Romeins staatsgezag"],
 4:["vervolgde Joden onder Rome","bredere vervolging","Baptism or ruin (tekst)"],
 5:["moslims komen","verlichting, last valt weg","Joden vinden beschutting"],
 6:["christen blijft christen","synagoge en kerk open","hidayah (tekst)","de boodschap geleefd"],
 7:["eeuwenlang (tekst)","kaart: bestuur (getekend)","vrij, generatie na generatie"],
 8:["Europa koloniseert","kaart: koloniale greep (getekend)","de test van hun regel"],
 9:["niet zacht geregeerd","Quran verboden, verdeeld","alles gedaan, werkte het?"],
 10:["Nee, het bleef","Indonesie","Bosnie","Noord-Afrika"],
 11:["cijfers voor/na (getekend)","machtigste rijken","in het hart"],
 12:["hun regel is waar (getekend)","kaart Europa (getekend)","lege kerken"],
 13:["waarom? een wond","afkeer van geloof","hand om de keel (getekend)","het bewijs"],
 14:["nooit gedwongen","het zwaard viel niet","twee einden (getekend)"],
 15:["stem niet verheffen (tekst)","waarheid gezien (tekst)","gebed: jij bent het bewijs"],
 16:["dit doen we hier (tekst)","leugen reist krom (tekst)","waarheid loopt recht (tekst)","CTA logo (getekend)"],
}

def ensure_beats(sc):
    # bouw de beeld-beats als ze nog niet in de scene staan (zelfde indeling als de editor).
    if sc.get("beats"):
        return
    num = sc.get("scene"); sents = sc.get("sentences") or []
    if not sents:
        sc["beats"] = []; return
    splits = SPLITS.get(num, []); labs = LABELS.get(num, [])
    edges = [sents[0]["start"]] + [sents[i]["start"] for i in splits if i < len(sents)] + [sc.get("speech_end", sc.get("dur", 0))]
    beats = []
    for i in range(len(edges) - 1):
        beats.append({"start": round(edges[i], 3), "dur": round(edges[i+1]-edges[i], 3),
                      "label": labs[i] if i < len(labs) else f"beeld {i+1}", "img": ""})
    sc["beats"] = beats

# ZOEKPLAN per scene -> per beat (in volgorde). kind: 'photo' = ophalen, 'drawn' = overslaan
# (engine tekent de tekst/kaart/CTA zelf). De query is de Engelse zoekterm op Commons.
# kind: 'video' = liefst video (Pexels/Pixabay met sleutel), anders foto als terugval;
#       'photo' = alleen foto (historisch/gravure, daar bestaat geen video van);
#       'drawn' = overslaan (engine tekent tekst/kaart/CTA zelf).
PLAN = {
 1:[("photo","medieval battle sword knights engraving"),("drawn",""),("video","desert road horizon sunrise")],
 2:[("drawn",""),("video","antique sword blade close up"),("drawn","")],
 3:[("drawn",""),("video","roman forum ruins rome")],
 4:[("photo","expulsion of the jews history engraving"),("photo","medieval persecution engraving"),("drawn","")],
 5:[("video","old medina gate morocco"),("video","sunrise over old city"),("photo","historic synagogue interior morocco")],
 6:[("video","old church interior candles"),("photo","historic synagogue morocco"),("drawn",""),("video","muslims praying in mosque")],
 7:[("drawn",""),("drawn",""),("video","medina street life morocco")],
 8:[("video","colonial troops marching archive"),("drawn",""),("drawn","")],
 9:[("photo","colonial era north africa historical"),("photo","french colonial algeria historical"),("drawn","")],
 10:[("drawn",""),("video","istiqlal mosque jakarta indonesia"),("video","mosque sarajevo bosnia"),("video","mosque morocco minaret")],
 11:[("drawn",""),("drawn",""),("video","muslim man praying close up")],
 12:[("drawn",""),("drawn",""),("video","empty european church interior")],
 13:[("video","modern european city street"),("photo","empty cathedral europe"),("drawn",""),("drawn","")],
 14:[("video","muslim prayer sujood"),("video","crowd praying mosque"),("drawn","")],
 15:[("drawn",""),("drawn",""),("video","mass prayer mosque aerial crowd")],
 16:[("drawn",""),("drawn",""),("drawn",""),("drawn","")],
}

def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()

def _api(params):
    params = {**params, "format": "json"}
    url = API + "?" + urllib.parse.urlencode(params)
    return json.loads(_get(url).decode("utf-8", "replace"))

def _ok_license(ext):
    # accepteer publiek domein + CC-licenties; weiger onbekend/alle-rechten.
    lic = ((ext.get("LicenseShortName", {}) or {}).get("value", "") or "").lower()
    return any(k in lic for k in ["public domain", "cc0", "cc by", "cc-by", "pdm", "no restrictions"])

def search_image(query):
    # zoek bestanden (namespace 6) op Commons; pak de eerste met bruikbare licentie + goede breedte.
    try:
        d = _api({
            "action": "query", "generator": "search",
            "gsrsearch": query + " filetype:bitmap", "gsrnamespace": "6", "gsrlimit": "8",
            "prop": "imageinfo", "iiprop": "url|extmetadata|mime|size", "iiurlwidth": "1920",
        })
    except Exception as e:
        print(f"    zoekfout: {e}"); return None
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
    # grootste eerst (scherper beeld)
    cands.sort(key=lambda c: c["w"], reverse=True)
    return cands[0] if cands else None

def ext_for(mime):
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(mime, ".jpg")

def _getj(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8", "replace"))

def search_video(query, keys, min_dur=0):
    # Pexels eerst (als sleutel), anders Pixabay. Geeft {url, ext, credit, license} of None.
    try:
        if keys.get("pexels"):
            d = _getj("https://api.pexels.com/videos/search?" + urllib.parse.urlencode({"query": query, "per_page": 8, "orientation": "portrait"}),
                      headers={"Authorization": keys["pexels"]})
            for v in d.get("videos", []):
                if min_dur and v.get("duration", 0) < min_dur:
                    continue
                files = sorted(v.get("video_files", []), key=lambda f: (f.get("height") or 0), reverse=True)
                hd = next((f for f in files if (f.get("height") or 0) >= 1080), files[0] if files else None)
                if hd and hd.get("link"):
                    return {"url": hd["link"], "ext": ".mp4", "credit": (v.get("user", {}) or {}).get("name", "Pexels"), "license": "Pexels License (free)"}
    except Exception as e:
        print(f"    pexels-fout: {e}")
    try:
        if keys.get("pixabay"):
            d = _getj("https://pixabay.com/api/videos/?" + urllib.parse.urlencode({"key": keys["pixabay"], "q": query, "per_page": 8}))
            for h in d.get("hits", []):
                if min_dur and h.get("duration", 0) < min_dur:
                    continue
                vids = h.get("videos", {})
                pick = vids.get("large") or vids.get("medium") or vids.get("small")
                if pick and pick.get("url"):
                    return {"url": pick["url"], "ext": ".mp4", "credit": h.get("user", "Pixabay"), "license": "Pixabay License (free)"}
    except Exception as e:
        print(f"    pixabay-fout: {e}")
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
            rel = "assets/ummaunited/video/" + fname
            beat["vid" if is_video else "img"] = rel
            beat.pop("img" if is_video else "vid", None)  # oude tegenpool opruimen
            credits.append(f"scene {num} beat {bi+1}: {hit.get('title','')} | {hit['license']} | {hit['credit']}")
            print(f"    -> {fname}  ({'video' if is_video else 'foto'}, {hit['license']})")
            n_done += 1
            time.sleep(0.6)  # beleefd tegen de API's

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
