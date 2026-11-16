#!/usr/bin/env python3
# channel_audio.py - vult automatisch MUZIEK (per blok) en GELUIDSEFFECTEN (op de kantelpunten) in de
# tijdlijn, net zoals channel_beeld.py dat voor het beeld doet. Draait LOKAAL op Mo's laptop.
#
# PER VERHAAL: net als channel_beeld.py kent dit script nu een eigen plan per verhaal. "sword" is het
# oude plan (18 scenes, eindigt op triumph). "chose" = de bespiegelende video 1 (14 scenes) die bewust
# ingetogen en OPEN eindigt. Een onbekend verhaal valt terug op het sword-plan. De muziek- en SFX-
# bestandsnamen zijn per verhaal gescoped, zodat chose en sword elkaars audio nooit overschrijven.
#
# Bron: Freesound, gefilterd op CC0 (mag commercieel, geen naamsvermelding nodig). We downloaden de
# voorbeeld-mp3 (geen OAuth nodig). Limiet Freesound: 60/min, 2000/dag -> ruim; we pacen + retryen.
# Eenmalig een gratis sleutel halen op https://freesound.org/apiv2/apply en zetten in
# tools/channel-keys.json :  { "freesound": "JOUW_SLEUTEL" }   (of env FREESOUND_API_KEY)
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_audio.py --story chose --voice v1   # muziek per blok + sfx op de kantelpunten
#   python tools/channel_audio.py --story chose --voice v1 --force   # ook al-gevulde opnieuw ophalen
#
# MUZIEK staat per BLOK (groep scenes), niet per scene -> niet te veel afwisseling. SFX alleen op de
# gekozen momenten. Jij hoort het terug op de montagetafel en vervangt de missers.
import argparse, os, json, time, urllib.parse, urllib.request, urllib.error

API = "https://freesound.org/apiv2"

# =================================================================================================
# PLAN "sword" (het oude verhaal, 18 scenes). MUZIEK PER BLOK: scene-bereik (van..t/m) + stemming/
# zoekterm. Een blok krijgt een doorlopend muziekje; op de blok-grenzen laat de render het overvloeien.
TRACKS_SWORD = {
 "opening": "cinematic ambient mysterious tension",   # intro + haak + test
 "dark":    "dark cinematic drone ominous",            # Rome / dwang, en de wond
 "hope":    "emotional cinematic strings uplifting",   # vrijheid / rechtvaardigheid
 "tension": "tense cinematic drums dramatic",          # koloniale test
 "triumph": "epic emotional cinematic uplifting",      # het hield stand / payoff / CTA
}
BLOCKS_SWORD = [
 {"from":0,  "to":2,  "track":"opening"},
 {"from":3,  "to":4,  "track":"dark"},
 {"from":5,  "to":8,  "track":"hope"},
 {"from":9,  "to":10, "track":"tension"},
 {"from":11, "to":12, "track":"triumph"},
 {"from":13, "to":14, "track":"dark"},
 {"from":15, "to":18, "track":"triumph"},
]
SFX_SWORD = [
 {"scene":1,  "q":"cinematic orchestral impact hit"},   # einde haak
 {"scene":4,  "q":"deep cinematic drum hit"},            # einde Rome-dwang
 {"scene":5,  "q":"epic orchestral stinger"},            # de ommekeer
 {"scene":9,  "q":"dark cinematic impact drum"},         # de echte test
 {"scene":12, "q":"emotional cinematic strings swell"},  # "no army ever took a heart"
 {"scene":16, "q":"triumphant orchestral swell"},        # climax
]

# =================================================================================================
# PLAN "chose" - "The Answer You Never Chose" (video 1, 14 scenes: 0=intro ... 13=outro).
# Bespiegelend en nuchter, GEEN triomf. De muziek blijft zacht en bouwt naar een OPEN, onopgelost
# einde (de video bruggt naar video 2, dus hij mag niet "afsluiten"). Vijf stemmingen over vijf blokken:
TRACKS_CHOSE = {
 "quiet":   "soft reflective ambient piano",             # intro + "je kunt denken"
 "warm":    "warm contemplative ambient strings",        # de nuchtere mens (dokter, brug, de ene vraag)
 "intimate":"emotional ambient piano slow intimate",     # de grote vraag + de eigen bekentenis
 "unease":  "subtle tension ambient drone introspective",# de vijf deuren + de val
 "open":    "soft ambient piano unresolved emotional",   # het antwoord, de twijfel, outro (open eind)
}
BLOCKS_CHOSE = [
 {"from":0,  "to":2,  "track":"quiet"},     # intro, de vogel, de duizend kleine keuzes
 {"from":3,  "to":5,  "track":"warm"},      # naar wie het weet, eerst kijken, behalve een vraag
 {"from":6,  "to":7,  "track":"intimate"},  # waarom ben je hier, "het was ik ook"
 {"from":8,  "to":10, "track":"unease"},    # de vijf deuren, geen ervan is nadenken, de val
 {"from":11, "to":13, "track":"open"},      # het antwoord, is het wel waar, outro -> open eind
]
# SFX subtiel en filmisch, je voelt ze meer dan je ze hoort. Alleen op drie kantelpunten; NOOIT triomf.
SFX_CHOSE = [
 {"scene":5,  "q":"deep soft cinematic sub drop"},       # de wending: behalve op de ene vraag
 {"scene":11, "q":"warm soft cinematic swell ambient"},  # het antwoord landt, rustig
 {"scene":12, "q":"soft cinematic riser ambient subtle"},# de twijfel die openblijft -> video 2
]

# verhaal-id -> plan. Onbekend verhaal valt terug op sword (bestaand gedrag).
PLANS = {
 "sword": {"tracks": TRACKS_SWORD, "blocks": BLOCKS_SWORD, "sfx": SFX_SWORD},
 "chose": {"tracks": TRACKS_CHOSE, "blocks": BLOCKS_CHOSE, "sfx": SFX_CHOSE},
}

def load_key(root):
    k = os.environ.get("FREESOUND_API_KEY", "")
    kf = os.path.join(root, "tools", "channel-keys.json")
    try:
        if os.path.exists(kf):
            d = json.load(open(kf, encoding="utf-8")); k = k or d.get("freesound", "")
    except Exception:
        pass
    return k

def _get(url, tries=4, timeout=25):
    # Connection: close voorkomt de klassieke urllib-hang (de server houdt de keep-alive open en
    # read() blijft wachten). Browser-achtige kop + Referer zodat de Freesound-CDN niet dichtklapt.
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Referer": "https://freesound.org/", "Accept": "*/*", "Connection": "close",
    }
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                chunks = []
                while True:
                    b = r.read(65536)
                    if not b: break
                    chunks.append(b)
                return b"".join(chunks)
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

def _license_label(url):
    # Freesound geeft de licentie als URL. Commercieel VEILIG = CC0 of CC-BY (naamsvermelding).
    # Weiger NonCommercial (-nc) en NoDerivatives (-nd).
    u = (url or "").lower()
    if "by-nc" in u or "by-nd" in u or "noncommercial" in u or "/nc" in u:
        return None
    if "zero" in u or "publicdomain" in u:
        return "CC0"
    if "/by/" in u or "licenses/by" in u:
        return "CC-BY"
    return None

def search_cc0(query, key, prefer_long=False):
    # Zoek op de korte term; FILTER NIET op de server (dat gaf nul), maar haal de treffers op en kies
    # zelf het eerste dat CC0 of CC-BY is (commercieel oke). Voor muziek pakken we het langste.
    params = {"query": query, "page_size": 15, "token": key,
              "fields": "id,name,username,duration,previews,license", "sort": "score"}
    url = API + "/search/text/?" + urllib.parse.urlencode(params)
    try:
        d = json.loads(_get(url).decode("utf-8", "replace"))
    except Exception as e:
        print(f"    zoekfout: {e}"); return None
    res = d.get("results", [])
    cands = []
    for r in res:
        lab = _license_label(r.get("license", ""))
        if not lab:
            continue
        pv = (r.get("previews") or {})
        hq = pv.get("preview-hq-mp3"); lq = pv.get("preview-lq-mp3")
        if not (hq or lq):
            continue
        cands.append({"hq": hq, "lq": lq, "name": r.get("name", ""), "user": r.get("username", ""),
                      "dur": r.get("duration", 0) or 0, "lic": lab})
    if not cands:
        print(f"    {len(res)} treffers, maar geen bruikbare (CC0/CC-BY met preview)"); return None
    if prefer_long:
        # MUZIEK: de render loopt de track, dus we hoeven geen reuzebestand. Kies een NORMAAL formaat
        # (20-240s) en de LICHTE voorbeeld-mp3 (snel binnen). CC0 eerst, dan het langste binnen de cap.
        fit = [c for c in cands if 20 <= c["dur"] <= 240] or cands
        fit.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, -min(c["dur"], 240)))
        b = fit[0]; url = b["lq"] or b["hq"]
    else:
        # SFX: een effect is KORT. Liefst <= 15s (anders is het een track, geen effect). CC0 eerst,
        # dan het kortste. HQ-voorbeeld-mp3 (kort, dus snel).
        short = [c for c in cands if c["dur"] <= 15] or cands
        short.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, c["dur"]))
        b = short[0]; url = b["hq"] or b["lq"]
    return {"url": url, "name": b["name"], "user": b["user"], "dur": b["dur"], "lic": b["lic"]}

def download(url, outpath):
    # de voorbeeld-mp3 is publiek (cdn.freesound.org), dus GEEN token meesturen (die liet de
    # verbinding hangen). Gewoon ophalen met time-out + retry via _get.
    data = _get(url)
    with open(outpath, "wb") as f: f.write(data)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="chose"); ap.add_argument("--voice", default="v1")
    ap.add_argument("--root", default="."); ap.add_argument("--force", action="store_true")
    ap.add_argument("--channel", default="channel1", help="kanaal-map onder assets/channels/")
    args = ap.parse_args()

    # kies het audioplan van DIT verhaal (sword/chose/...); val terug op sword als het onbekend is
    plan = PLANS.get(args.story)
    if not plan:
        print(f"let op: geen eigen audioplan voor '{args.story}' -> val terug op sword-plan")
        plan = PLANS["sword"]
    TRACKS = plan["tracks"]; BLOCKS = plan["blocks"]; SFX = plan["sfx"]

    key = load_key(args.root)
    if not key:
        print("Geen Freesound-sleutel. Haal er gratis een op https://freesound.org/apiv2/apply en zet"
              " 'freesound' in tools/channel-keys.json. Dan draai je dit opnieuw."); return

    tlpath = os.path.join(args.root, "assets", "channels", args.channel, "voice", args.story, args.voice, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json:", tlpath); return
    tl = json.load(open(tlpath, encoding="utf-8"))
    scenes = tl.get("scenes", [])
    by_num = {s.get("scene"): s for s in scenes}

    mdir = os.path.join(args.root, "assets", "channels", args.channel, "muziek")
    sdir = os.path.join(args.root, "assets", "channels", args.channel, "sfx")
    os.makedirs(mdir, exist_ok=True); os.makedirs(sdir, exist_ok=True)
    credits = []
    n_mus = n_sfx = n_fail = 0

    # ---- MUZIEK per sfeer: haal elke track EEN keer op (<verhaal>-<sfeer>.mp3) ----
    # Per verhaal gescoped, zodat chose en sword nooit dezelfde muziek-bestandsnaam delen.
    track_file = {}
    for name, query in TRACKS.items():
        fname = f"{args.story}-{name}.mp3"; fpath = os.path.join(mdir, fname)
        rel = "assets/channels/" + args.channel + "/muziek/" + fname
        if os.path.exists(fpath) and not args.force:
            track_file[name] = rel; print(f"sfeer '{name}': staat al ({fname})"); continue
        print(f"sfeer '{name}': zoek muziek '{query}'")
        hit = search_cc0(query, key, prefer_long=True)
        if not hit:
            print("    geen bruikbare muziek gevonden -> laat leeg"); n_fail += 1; time.sleep(1.2); continue
        print(f"    treffer: {hit['name'][:42]} ({hit['lic']}, {hit['dur']:.0f}s), downloaden...")
        try:
            download(hit["url"], fpath)
        except Exception as e:
            print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(1.2); continue
        track_file[name] = rel
        credits.append(f"muziek '{name}': {hit['name']} by {hit['user']} (Freesound, {hit['lic']})")
        print(f"    -> {fname}  ({hit['lic']}, {hit['dur']:.0f}s)"); n_mus += 1; time.sleep(1.2)

    # ---- blokken op de tijdlijn zetten met de bijbehorende sfeer-track ----
    music = []
    for blk in BLOCKS:
        a = by_num.get(blk["from"]); b = by_num.get(blk["to"])
        if not a or not b: continue
        rel = track_file.get(blk["track"])
        if not rel:
            print(f"blok scene {blk['from']}-{blk['to']}: sfeer '{blk['track']}' mist, overgeslagen"); continue
        start = round(a.get("start", 0), 3)
        end = round(b.get("start", 0) + b.get("dur", 0), 3)
        music.append({"start": start, "end": end, "file": rel, "mood": blk["track"]})
        print(f"blok scene {blk['from']}-{blk['to']}: {blk['track']}  ({start:.0f}s -> {end:.0f}s)")
    tl["music"] = music

    # ---- SFX AAN HET EINDE van de scene (versterkt wat net gezegd is), NOOIT middenin ----
    # Plaatsing = speech_end van de scene (na de laatste zin). We overschrijven altijd (force-gedrag)
    # zodat oude/verkeerde effecten verdwijnen; elke scene krijgt hooguit een effect. Bestandsnaam per
    # verhaal gescoped (chose en sword deelden scene 5 en 12 -> anders overschreven ze elkaar).
    for sx in SFX:
        s = by_num.get(sx["scene"])
        if not s: continue
        # einde van de spraak binnen de scene; valt terug op de sceneduur
        t = round(float(s.get("speech_end", s.get("dur", 0))), 3)
        s["sfx"] = []   # eventueel oude effecten op deze scene wissen (een schoon effect per scene)
        fname = f"{args.story}_s{sx['scene']:02d}_end.mp3"; fpath = os.path.join(sdir, fname)
        print(f"scene {sx['scene']} sfx @ einde ({t:.1f}s): zoek '{sx['q']}'")
        hit = search_cc0(sx["q"], key)
        if not hit:
            print("    geen bruikbaar effect gevonden -> laat leeg"); n_fail += 1; time.sleep(1.2); continue
        print(f"    treffer: {hit['name'][:42]} ({hit['lic']}), downloaden...")
        try:
            download(hit["url"], fpath)
        except Exception as e:
            print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(1.2); continue
        s["sfx"].append({"t": t, "name": "end", "file": "assets/channels/" + args.channel + "/sfx/" + fname})
        credits.append(f"sfx scene {sx['scene']}: {hit['name']} by {hit['user']} (Freesound, {hit['lic']})")
        print(f"    -> {fname}  ({hit['lic']})"); n_sfx += 1; time.sleep(1.2)

    with open(tlpath, "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)
    with open(os.path.join(mdir, "_credits.txt"), "a", encoding="utf-8") as f:
        f.write("\n".join(credits) + ("\n" if credits else ""))
    print(f"\nklaar: {n_mus} muziek-blokken, {n_sfx} effecten, {n_fail} niet gevonden.")
    print("Open de studio, beluister het, en vervang de missers.")

if __name__ == "__main__":
    main()
