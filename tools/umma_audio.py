#!/usr/bin/env python3
# umma_audio.py — vult automatisch MUZIEK (per blok) en GELUIDSEFFECTEN (op de kantelpunten) in de
# tijdlijn, net zoals umma_beeld.py dat voor het beeld doet. Draait LOKAAL op Mo's laptop.
#
# Bron: Freesound, gefilterd op CC0 (mag commercieel, geen naamsvermelding nodig). We downloaden de
# voorbeeld-mp3 (geen OAuth nodig). Limiet Freesound: 60/min, 2000/dag -> ruim; we pacen + retryen.
# Eenmalig een gratis sleutel halen op https://freesound.org/apiv2/apply en zetten in
# tools/umma-keys.json :  { "freesound": "JOUW_SLEUTEL" }   (of env FREESOUND_API_KEY)
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/umma_audio.py            # muziek per blok + sfx op de kantelpunten
#   python tools/umma_audio.py --force    # ook al-gevulde opnieuw ophalen
#
# MUZIEK staat per BLOK (groep scènes), niet per scène -> niet te veel afwisseling. SFX alleen op de
# gekozen momenten. Jij hoort het terug op de montagetafel en vervangt de missers.
import argparse, os, json, time, urllib.parse, urllib.request, urllib.error

API = "https://freesound.org/apiv2"

# MUZIEK PER BLOK: scène-bereik (van..t/m) + stemming/zoekterm. Een blok krijgt één doorlopend
# muziekje; op de blok-grenzen laat de render het overvloeien.
BLOCKS = [
 {"from":1,  "to":4,  "mood":"tense dark cinematic ambient underscore"},
 {"from":5,  "to":7,  "mood":"warm hopeful emotional strings ambient"},
 {"from":8,  "to":11, "mood":"tense building cinematic drums rise then resolve"},
 {"from":12, "to":16, "mood":"reflective solemn then warm uplifting cinematic"},
]

# SFX OP DE KANTELPUNTEN: (scène, seconde-binnen-de-scène, zoekterm). Bewust weinig, alleen waar het
# verhaal kantelt. De seconde mag ruw; op de montagetafel schuif je hem exact goed.
SFX = [
 {"scene":4,  "t":25.8, "q":"deep boot stomp impact"},        # "A boot."
 {"scene":8,  "t":0.4,  "q":"low tension riser whoosh"},       # the tide turned
 {"scene":9,  "t":7.9,  "q":"hard short hit impact dark"},     # They killed. They humiliated.
 {"scene":10, "t":0.4,  "q":"turning point soft impact"},      # "No."
 {"scene":12, "t":20.0, "q":"empty hollow reverb tone"},       # lege kerken
 {"scene":15, "t":23.9, "q":"warm uplifting swell riser"},     # payoff: you are the proof
]

def load_key(root):
    k = os.environ.get("FREESOUND_API_KEY", "")
    kf = os.path.join(root, "tools", "umma-keys.json")
    try:
        if os.path.exists(kf):
            d = json.load(open(kf, encoding="utf-8")); k = k or d.get("freesound", "")
    except Exception:
        pass
    return k

def _get(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "UmmaUnited/1.0"})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (429, 503):
                ra = e.headers.get("Retry-After")
                wait = int(ra) if (ra and ra.isdigit()) else (5 * (i + 1))
                print(f"    {e.code} (limiet) -> {wait}s wachten..."); time.sleep(wait); continue
            raise
        except Exception as e:
            last = e; time.sleep(2 * (i + 1)); continue
    if last: raise last

def search_cc0(query, key, want_min=0, want_max=0):
    # zoek CC0-geluid; geef de voorbeeld-mp3-URL + meta van de beste treffer, of None.
    flt = 'license:"Creative Commons 0"'
    if want_min: flt += f" duration:[{want_min} TO {want_max or 600}]"
    params = {
        "query": query, "filter": flt, "page_size": 12, "token": key,
        "fields": "id,name,username,duration,previews,license",
        "sort": "score",
    }
    url = API + "/search/text/?" + urllib.parse.urlencode(params)
    try:
        d = json.loads(_get(url).decode("utf-8", "replace"))
    except Exception as e:
        print(f"    zoekfout: {e}"); return None
    for r in d.get("results", []):
        pv = (r.get("previews") or {})
        mp3 = pv.get("preview-hq-mp3") or pv.get("preview-lq-mp3")
        if mp3:
            return {"url": mp3, "name": r.get("name", ""), "user": r.get("username", ""),
                    "dur": r.get("duration", 0), "id": r.get("id")}
    return None

def download(url, key, outpath):
    # voorbeeld-mp3 heeft geen OAuth nodig; token meesturen kan geen kwaad.
    u = url + ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(key)
    data = _get(u)
    with open(outpath, "wb") as f: f.write(data)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword"); ap.add_argument("--voice", default="man")
    ap.add_argument("--root", default="."); ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    key = load_key(args.root)
    if not key:
        print("Geen Freesound-sleutel. Haal er gratis een op https://freesound.org/apiv2/apply en zet"
              " 'freesound' in tools/umma-keys.json. Dan draai je dit opnieuw."); return

    tlpath = os.path.join(args.root, "assets", "ummaunited", "voice", args.story, args.voice, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json:", tlpath); return
    tl = json.load(open(tlpath, encoding="utf-8"))
    scenes = tl.get("scenes", [])
    by_num = {s.get("scene"): s for s in scenes}

    mdir = os.path.join(args.root, "assets", "ummaunited", "muziek")
    sdir = os.path.join(args.root, "assets", "ummaunited", "sfx")
    os.makedirs(mdir, exist_ok=True); os.makedirs(sdir, exist_ok=True)
    credits = []
    n_mus = n_sfx = n_fail = 0

    # ---- MUZIEK per blok ----
    music = []
    for bi, blk in enumerate(BLOCKS):
        a = by_num.get(blk["from"]); b = by_num.get(blk["to"])
        if not a or not b: continue
        start = round(a.get("start", 0), 3)
        end = round(b.get("start", 0) + b.get("dur", 0), 3)
        fname = f"blok{bi+1}.mp3"; fpath = os.path.join(mdir, fname)
        if os.path.exists(fpath) and not args.force:
            music.append({"start": start, "end": end, "file": "assets/ummaunited/muziek/" + fname, "mood": blk["mood"]})
            print(f"blok {bi+1} (scène {blk['from']}-{blk['to']}): muziek staat al"); continue
        print(f"blok {bi+1} (scène {blk['from']}-{blk['to']}): zoek muziek '{blk['mood']}'")
        need = end - start
        hit = search_cc0(blk["mood"], key, want_min=max(20, int(need * 0.5)))
        if not hit:
            print("    geen CC0-muziek gevonden -> laat leeg (zoek jij)"); n_fail += 1; time.sleep(1.2); continue
        try:
            download(hit["url"], key, fpath)
        except Exception as e:
            print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(1.2); continue
        music.append({"start": start, "end": end, "file": "assets/ummaunited/muziek/" + fname, "mood": blk["mood"]})
        credits.append(f"muziek blok {bi+1}: {hit['name']} by {hit['user']} (Freesound, CC0)")
        print(f"    -> {fname}  (CC0, {hit['dur']:.0f}s)"); n_mus += 1; time.sleep(1.2)
    tl["music"] = music

    # ---- SFX op de kantelpunten ----
    for sx in SFX:
        s = by_num.get(sx["scene"])
        if not s: continue
        beats = s.setdefault("sfx", [])
        fname = f"s{sx['scene']:02d}_{int(sx['t'])}.mp3"; fpath = os.path.join(sdir, fname)
        already = any(f.get("file") for f in beats if abs(float(f.get("t", -9)) - sx["t"]) < 0.2)
        if already and not args.force:
            print(f"scène {sx['scene']} sfx @ {sx['t']}s: staat al"); continue
        print(f"scène {sx['scene']} sfx @ {sx['t']}s: zoek '{sx['q']}'")
        hit = search_cc0(sx["q"], key, want_min=0)
        if not hit:
            print("    geen CC0-effect gevonden -> laat leeg (zoek jij)"); n_fail += 1; time.sleep(1.2); continue
        try:
            download(hit["url"], key, fpath)
        except Exception as e:
            print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(1.2); continue
        beats[:] = [f for f in beats if abs(float(f.get("t", -9)) - sx["t"]) >= 0.2]
        beats.append({"t": sx["t"], "name": sx["q"].split()[0], "file": "assets/ummaunited/sfx/" + fname})
        credits.append(f"sfx scène {sx['scene']}: {hit['name']} by {hit['user']} (Freesound, CC0)")
        print(f"    -> {fname}  (CC0)"); n_sfx += 1; time.sleep(1.2)

    with open(tlpath, "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)
    with open(os.path.join(mdir, "_credits.txt"), "a", encoding="utf-8") as f:
        f.write("\n".join(credits) + ("\n" if credits else ""))
    print(f"\nklaar: {n_mus} muziek-blokken, {n_sfx} effecten, {n_fail} niet gevonden.")
    print("Open de studio, beluister het, en vervang de missers.")

if __name__ == "__main__":
    main()
