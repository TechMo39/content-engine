#!/usr/bin/env python3
# channel_audio.py - vult automatisch MUZIEK (per blok) en GELUIDSEFFECTEN (op de kantelpunten) in de
# tijdlijn, net zoals channel_beeld.py dat voor het beeld doet. Draait LOKAAL op Mo's laptop.
#
# PER VERHAAL: net als channel_beeld.py kent dit script een eigen plan per verhaal. Alleen "chose"
# bestaat nu (video 1); sword is verwijderd. Een onbekend verhaal krijgt geen audioplan (niets gedaan).
# De muziek- en SFX-bestandsnamen zijn per verhaal gescoped, zodat verhalen elkaars audio niet overschrijven.
#
# Bron: Freesound, gefilterd op CC0 (mag commercieel, geen naamsvermelding nodig). We downloaden de
# voorbeeld-mp3 (geen OAuth nodig). Limiet Freesound: 60/min, 2000/dag -> ruim; we pacen + retryen.
# Eenmalig een gratis sleutel halen op https://freesound.org/apiv2/apply en zetten in
# tools/channel-keys.json :  { "freesound": "JOUW_SLEUTEL" }   (of env FREESOUND_API_KEY)
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_audio.py --story chose --voice v3          # muziek per blok + sfx op de kantelpunten
#   python tools/channel_audio.py --story chose --voice v3 --force  # ook al-gevulde opnieuw ophalen
#
# MUZIEK staat per BLOK (groep scenes), niet per scene -> niet te veel afwisseling. SFX alleen op de
# gekozen momenten. Jij hoort het terug op de montagetafel en vervangt de missers.
import argparse, os, re, json, time, urllib.parse, urllib.request, urllib.error, subprocess, shutil, tempfile

API = "https://freesound.org/apiv2"

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
# Per punt een LIJST zoektermen van specifiek naar breed. Freesound geeft op lange, zeldzame
# woordcombinaties vaak 0 terug; daarom proberen we de termen op volgorde tot er iets gevonden is.
SFX_CHOSE = [
 {"scene":5,  "q":["cinematic sub drop","sub drop","deep boom","cinematic impact","impact"]},       # de wending
 {"scene":11, "q":["cinematic swell","ambient swell","soft swell","cinematic transition","swell"]},  # het antwoord landt
 {"scene":12, "q":["cinematic riser","ambient riser","riser","cinematic transition","whoosh"]},      # twijfel open -> video 2
]

# PLAN "truth" - "Is Anything Actually True?" (video 2, 19 scenes: 0=intro ... 18=outro).
# Nuchter en logisch opgebouwd, GEEN triomf. Zacht bed dat de redenering volgt: rustig -> spanning bij
# het ontleden -> stilte rond de hoofdvraag (scene 12) -> stevig maar ingetogen bij het antwoord ->
# gewicht bij "maar een kan waar zijn" -> open/hoopvol naar video 3.
TRACKS_TRUTH = {
 "quiet":   "soft reflective ambient piano",                 # intro + haak + "ieders eigen waarheid"
 "warm":    "warm contemplative ambient strings",            # we eindigen op een antwoord + smaak
 "tension": "subtle tension ambient drone introspective",    # werkelijkheid, de tegenwerping, valt om
 "build":   "building suspense ambient low pulse",           # niemand leeft zo, de truc, geen zekerheid
 "suspend": "sparse suspended ambient tone minimal",         # één conclusie + de hoofdvraag (rust/pauze)
 "resolve": "grounded resolving ambient strings calm",       # het antwoord: ja, stevig maar ingetogen
 "weight":  "somber reflective ambient drone heavy",         # maar een kan waar zijn + de methode
 "open":    "soft ambient piano unresolved hopeful",         # we gaan door -> video 3, outro (open)
}
BLOCKS_TRUTH = [
 {"from":0,  "to":2,  "track":"quiet"},     # intro, de haak, "ieders eigen waarheid"
 {"from":3,  "to":4,  "track":"warm"},      # we eindigen op een antwoord, smaak
 {"from":5,  "to":7,  "track":"tension"},   # werkelijkheid heeft het laatste woord, de tegenwerping, valt om
 {"from":8,  "to":10, "track":"build"},     # niemand leeft zo, de stille truc, geen zekerheid
 {"from":11, "to":12, "track":"suspend"},   # één conclusie, de hoofdvraag + pauze
 {"from":13, "to":13, "track":"resolve"},   # het antwoord: ja
 {"from":14, "to":16, "track":"weight"},    # maar een kan waar zijn, de enige eerlijke manier, afschrijven
 {"from":17, "to":18, "track":"open"},      # we beginnen volgende keer, outro -> open
]
# SFX subtiel en filmisch (meer voelen dan horen), alleen op de kantelpunten, NOOIT triomf.
# Per punt een LIJST zoektermen van specifiek naar breed (Freesound geeft op lange combinaties vaak 0).
SFX_TRUTH = [
 {"scene":7,  "q":["cinematic impact","deep boom","subtle impact","cinematic transition","impact"]},  # de gedachte valt om
 {"scene":11, "q":["cinematic riser","ambient riser","riser","cinematic transition","whoosh"]},        # opbouw naar de hoofdvraag
 {"scene":13, "q":["cinematic swell","ambient swell","soft swell","cinematic transition","swell"]},    # het antwoord landt
 {"scene":17, "q":["cinematic riser","ambient riser","riser","cinematic transition","whoosh"]},        # door naar video 3
]

# verhaal-id -> plan. Onbekend verhaal = geen plan (niets gedaan).
PLANS = {
 "chose": {"tracks": TRACKS_CHOSE, "blocks": BLOCKS_CHOSE, "sfx": SFX_CHOSE},
 "truth": {"tracks": TRACKS_TRUTH, "blocks": BLOCKS_TRUTH, "sfx": SFX_TRUTH},
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
        # SFX: een effect is KORT. Liefst <= 30s (swells/risers mogen wat langer; daarboven is het een
        # track, geen effect). CC0 eerst, dan het kortste. HQ-voorbeeld-mp3 (kort, dus snel).
        short = [c for c in cands if c["dur"] <= 30] or cands
        short.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, c["dur"]))
        b = short[0]; url = b["hq"] or b["lq"]
    return {"url": url, "name": b["name"], "user": b["user"], "dur": b["dur"], "lic": b["lic"]}

def _query_ladder(q, kind):
    # Maak van een (mogelijk lange) zoekterm een reeks van specifiek naar breed. Een string wordt
    # stap voor stap korter; een lijst gebruiken we zoals-ie is. Altijd een generieke terugval
    # achteraan, zodat er voor een filmpje praktisch altijd iets te vinden is.
    out = []
    def add(x):
        x = (x or "").strip()
        if x and x not in out: out.append(x)
    if isinstance(q, (list, tuple)):
        for x in q: add(x)
    else:
        w = str(q).split()
        add(q)
        if len(w) >= 3: add(" ".join(w[-3:]))
        if len(w) >= 2: add(" ".join(w[-2:]))
        if w: add(w[-1])
    if kind == "sfx":
        for g in ("cinematic transition", "whoosh", "cinematic impact", "ambient swell"): add(g)
    else:
        for g in ("ambient", "cinematic ambient", "soft piano"): add(g)
    return out

def search_best(q, key, prefer_long=False):
    # Probeer de zoektermen op volgorde (specifiek -> breed) tot er een bruikbare treffer is.
    kind = "music" if prefer_long else "sfx"
    primary = (q[0] if isinstance(q, (list, tuple)) and q else q)
    for qq in _query_ladder(q, kind):
        hit = search_cc0(qq, key, prefer_long=prefer_long)
        if hit:
            if qq != primary: print(f"    (gevonden via bredere term '{qq}')")
            return hit
    return None

def _search_list(query, key, prefer_long=False):
    # Zoals search_cc0, maar geeft de HELE geschikte lijst terug (gesorteerd), zodat we er meerdere
    # kandidaten uit kunnen stagen voor de studio-keuze.
    params = {"query": query, "page_size": 20, "token": key,
              "fields": "id,name,username,duration,previews,license", "sort": "score"}
    url = API + "/search/text/?" + urllib.parse.urlencode(params)
    try:
        d = json.loads(_get(url).decode("utf-8", "replace"))
    except Exception as e:
        print(f"    zoekfout: {e}"); return []
    out = []
    for r in d.get("results", []):
        lab = _license_label(r.get("license", ""))
        if not lab:
            continue
        pv = (r.get("previews") or {})
        hq = pv.get("preview-hq-mp3"); lq = pv.get("preview-lq-mp3")
        if not (hq or lq):
            continue
        dur = r.get("duration", 0) or 0
        pref = (lq or hq) if prefer_long else (hq or lq)
        out.append({"url": pref, "name": r.get("name", ""), "user": r.get("username", ""), "dur": dur, "lic": lab})
    if prefer_long:
        fit = [c for c in out if 20 <= c["dur"] <= 240] or out
        fit.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, -min(c["dur"], 240)))
        return fit
    short = [c for c in out if c["dur"] <= 30] or out
    short.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, c["dur"]))
    return short

def search_many(q, key, n, prefer_long=False):
    # Verzamel tot n VERSCHILLENDE bruikbare treffers, van specifieke naar bredere zoekterm.
    kind = "music" if prefer_long else "sfx"
    seen = set(); picked = []
    for qq in _query_ladder(q, kind):
        for c in _search_list(qq, key, prefer_long=prefer_long):
            if c["url"] in seen:
                continue
            seen.add(c["url"]); picked.append(c)
            if len(picked) >= n:
                return picked
    return picked

def _stage(hits, outdir, base, n):
    # Download de kandidaten naar <base>1.mp3, <base>2.mp3, ... en geef de bestandsnamen terug.
    out = []
    for i, h in enumerate(hits[:n], 1):
        fn = f"{base}{i}.mp3"; fp = os.path.join(outdir, fn)
        try:
            download(h["url"], fp); out.append(fn)
        except Exception as e:
            print(f"    stage-fout {fn}: {e}")
    return out

def run_candidates(args, key):
    # STUDIO-MODUS: zoek N kandidaat-audiobestanden, stage ze op schijf en print CANDIDATES_JSON.
    # Hiermee werken de studio-knoppen "3 geluiden" (sfx) en "3 muziekbedden" (music).
    n = max(1, int(args.candidates))
    what = (args.what or "sfx").lower()
    if not key:
        print("CANDIDATES_JSON:" + json.dumps({"candidates": [], "reason": "geen Freesound-sleutel ingesteld"}))
        return
    if what == "music":
        outdir = os.path.join(args.root, "assets", "channels", args.channel, "muziek")
        os.makedirs(outdir, exist_ok=True)
        base = f"{args.story}__muziek__c"
        q = args.q or "soft reflective ambient piano"
        hits = search_many(q, key, n, prefer_long=True)
    else:
        outdir = os.path.join(args.root, "assets", "channels", args.channel, "sfx")
        os.makedirs(outdir, exist_ok=True)
        pid = re.sub(r"[^\w-]", "", (args.pid or "x")) or "x"
        base = f"sfx__{pid}__c"
        q = args.q or "cinematic transition"
        hits = search_many(q, key, n, prefer_long=False)
    files = _stage(hits, outdir, base, n)
    reason = "" if files else "geen bruikbare geluiden gevonden voor deze zoekterm"
    print("CANDIDATES_JSON:" + json.dumps({"candidates": [{"file": f} for f in files], "reason": reason}))

def download(url, outpath):
    # de voorbeeld-mp3 is publiek (cdn.freesound.org), dus GEEN token meesturen (die liet de
    # verbinding hangen). Gewoon ophalen met time-out + retry via _get.
    data = _get(url)
    with open(outpath, "wb") as f: f.write(data)

# ---- LOUDNESS-NORMALISATIE --------------------------------------------------------------------
# Chatterbox levert elke clip op een iets ander volume (onstabiel), en opgehaalde muziek is wisselend
# hard gemasterd. Daarom trekken we alles naar VASTE niveaus: stem naar de VOORGROND, muziek naar een
# zachte ACHTERGROND. Zo klinkt elke video gelijk en staat de stem altijd boven de muziek.
VOICE_LUFS = -16.0   # stem: helder op de voorgrond
MUSIC_LUFS = -20.0   # muziek: consistent, zacht (de 0.22-gain in preview/render maakt 'm nog zachter)
_FFMPEG = None

def _ffmpeg_path(root):
    p = os.environ.get("FFMPEG_PATH")
    if p and os.path.exists(p):
        return p
    for rel in ("node_modules/ffmpeg-static/ffmpeg.exe", "node_modules/ffmpeg-static/ffmpeg"):
        cand = os.path.join(root, rel)
        if os.path.exists(cand):
            return cand
    return shutil.which("ffmpeg")

def loudnorm(root, path, lufs):
    # Normaliseer EEN audiobestand naar <lufs> integrated loudness, in-place, duur blijft gelijk.
    global _FFMPEG
    if _FFMPEG is None:
        _FFMPEG = _ffmpeg_path(root)
    if not _FFMPEG or not os.path.exists(path):
        return False
    ext = os.path.splitext(path)[1].lower()
    enc = ["-c:a", "pcm_s16le"] if ext == ".wav" else ["-c:a", "libmp3lame", "-b:a", "192k"]
    fd, tmp = tempfile.mkstemp(suffix=ext); os.close(fd)
    cmd = [_FFMPEG, "-y", "-i", path, "-af", f"loudnorm=I={lufs}:TP=-1.5:LRA=11", "-ar", "44100"] + enc + [tmp]
    try:
        r = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.getsize(tmp) > 0:
            shutil.move(tmp, path); return True
    except Exception:
        pass
    if os.path.exists(tmp):
        try: os.remove(tmp)
        except Exception: pass
    return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="chose"); ap.add_argument("--voice", default="v3")
    ap.add_argument("--root", default="."); ap.add_argument("--force", action="store_true")
    ap.add_argument("--channel", default="channel1", help="kanaal-map onder assets/channels/")
    ap.add_argument("--sfx-only", dest="sfx_only", action="store_true",
                    help="alleen SFX (her)zoeken en plaatsen; muziek in de tijdlijn ongemoeid laten")
    ap.add_argument("--level", action="store_true",
                    help="trek bestaande stem + muziek van deze film op niveau (normaliseer in-place), zonder opnieuw te zoeken of inspreken")
    # studio-modus (door de engine aangeroepen): N kandidaten zoeken en stagen i.p.v. de tijdlijn vullen
    ap.add_argument("--candidates", type=int, default=0, help="studio-modus: N kandidaat-audiobestanden zoeken")
    ap.add_argument("--what", default="", help="studio-modus: 'music' of 'sfx'")
    ap.add_argument("--pid", default="", help="studio-modus (sfx): stabiele punt-id")
    ap.add_argument("--q", default="", help="studio-modus: zoekterm")
    ap.add_argument("--scene", type=int, default=None, help="studio-modus (sfx): scenenummer, optioneel")
    args = ap.parse_args()

    # STUDIO-MODUS: de engine vraagt N kandidaten (voor de picker). Geen tijdlijn nodig; print JSON en stop.
    if args.candidates and args.candidates > 0:
        run_candidates(args, load_key(args.root)); return

    # kies het audioplan van DIT verhaal. Alleen "chose" bestaat; onbekend verhaal -> niets doen.
    plan = PLANS.get(args.story)
    if not plan:
        print(f"geen audioplan voor '{args.story}' (alleen 'chose' bestaat). Niets gedaan."); return
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

    # --level: normaliseer de BESTAANDE audio van deze film in-place en stop. Geen zoeken/download,
    # geen opnieuw inspreken. Stem -> voorgrond, muziek -> zacht. Lost "stem te zacht / muziek te hard" op.
    if args.level:
        nv = nm = 0
        for s in scenes:
            vp = s.get("wav")
            if vp and loudnorm(args.root, os.path.join(args.root, vp), VOICE_LUFS): nv += 1
        done = set()
        for b in (tl.get("music") or []):
            mp = b.get("file")
            if mp and mp not in done and loudnorm(args.root, os.path.join(args.root, mp), MUSIC_LUFS):
                done.add(mp); nm += 1
        print(f"genormaliseerd: {nv} stem-clips -> {VOICE_LUFS:.0f} LUFS (voorgrond), {nm} muziekbedden -> {MUSIC_LUFS:.0f} LUFS (zacht).")
        print("Herlaad de studio en speel af; de stem staat nu helder boven de muziek. Niks opnieuw ingesproken.")
        return

    mdir = os.path.join(args.root, "assets", "channels", args.channel, "muziek")
    sdir = os.path.join(args.root, "assets", "channels", args.channel, "sfx")
    os.makedirs(mdir, exist_ok=True); os.makedirs(sdir, exist_ok=True)
    credits = []
    n_mus = n_sfx = n_fail = 0

    # ---- MUZIEK per sfeer (met --sfx-only overslaan, dan blijft bestaande muziek in de tijdlijn) ----
    if args.sfx_only:
        print("--sfx-only: muziek in de tijdlijn blijft ongemoeid, alleen SFX wordt (her)zocht.")
    else:
        # Per verhaal gescoped, zodat verhalen nooit dezelfde muziek-bestandsnaam delen.
        track_file = {}
        for name, query in TRACKS.items():
            fname = f"{args.story}-{name}.mp3"; fpath = os.path.join(mdir, fname)
            rel = "assets/channels/" + args.channel + "/muziek/" + fname
            if os.path.exists(fpath) and not args.force:
                track_file[name] = rel; print(f"sfeer '{name}': staat al ({fname})"); continue
            print(f"sfeer '{name}': zoek muziek '{query}'")
            hit = search_best(query, key, prefer_long=True)
            if not hit:
                print("    geen bruikbare muziek gevonden -> laat leeg"); n_fail += 1; time.sleep(1.2); continue
            print(f"    treffer: {hit['name'][:42]} ({hit['lic']}, {hit['dur']:.0f}s), downloaden...")
            try:
                download(hit["url"], fpath)
            except Exception as e:
                print(f"    downloadfout: {e}"); n_fail += 1; time.sleep(1.2); continue
            loudnorm(args.root, fpath, MUSIC_LUFS)   # elk bed naar hetzelfde zachte niveau
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
    # verhaal gescoped, zodat verhalen elkaars effecten niet overschrijven.
    for sx in SFX:
        s = by_num.get(sx["scene"])
        if not s: continue
        # einde van de spraak binnen de scene; valt terug op de sceneduur
        t = round(float(s.get("speech_end", s.get("dur", 0))), 3)
        s["sfx"] = []   # eventueel oude effecten op deze scene wissen (een schoon effect per scene)
        fname = f"{args.story}_s{sx['scene']:02d}_end.mp3"; fpath = os.path.join(sdir, fname)
        qprimary = sx["q"][0] if isinstance(sx["q"], (list, tuple)) and sx["q"] else sx["q"]
        print(f"scene {sx['scene']} sfx @ einde ({t:.1f}s): zoek '{qprimary}'")
        hit = search_best(sx["q"], key)
        if not hit:
            # Niets bruikbaars gevonden: tOch een LEEG SFX-blok op dit kantelpunt zetten (met de
            # zoekterm erbij), zodat het in de studio als klikbaar "nog geen geluid"-blok verschijnt
            # en je er zelf een geluid bij kunt kiezen in plaats van helemaal geen blok te zien.
            s["sfx"].append({"t": t, "name": "end", "q": qprimary})
            print("    geen bruikbaar effect gevonden -> leeg blok klaargezet om zelf te kiezen"); n_fail += 1; time.sleep(1.2); continue
        print(f"    treffer: {hit['name'][:42]} ({hit['lic']}), downloaden...")
        try:
            download(hit["url"], fpath)
        except Exception as e:
            # download mislukt: ook hier een leeg blok laten staan om zelf te vullen
            s["sfx"].append({"t": t, "name": "end", "q": qprimary})
            print(f"    downloadfout: {e} -> leeg blok klaargezet om zelf te kiezen"); n_fail += 1; time.sleep(1.2); continue
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
