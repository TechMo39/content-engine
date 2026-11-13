#!/usr/bin/env python3
# channel_audio.py — vult MUZIEK en GELUIDSEFFECTEN in de tijdlijn, met dezelfde
# "kies uit 3"-opzet als channel_beeld.py voor beeld. Draait LOKAAL op Mo's laptop.
#
# WAT ANDERS IS DAN BEELD (de eenheid verschilt per type):
#   MUZIEK = 3 kandidaat-BEDDEN per VIDEO (niet per blok). Eén doorlopend bed onder de hele
#            video. Bestanden: <story>__muziek__c1/__c2/__c3.mp3 in assets/channels/<ch>/muziek/.
#            __c1 is standaard; in de studio beluister je de 3 en zet je er één vast.
#   SFX    = 3 kandidaat-GELUIDEN per PUNT. Bestanden: sfx__<punt>__c1/__c2/__c3.mp3 in
#            assets/channels/<ch>/sfx/. __c1 is standaard; kiezen per punt in de studio.
#
# Zelfde logica als beeld: __c1/2/3, __c1 = standaard, reeds gekozen NIET overschrijven bij
# opnieuw ophalen, en een studio-modus (--candidates) die CANDIDATES_JSON:{...} print zodat de
# engine per muziek/SFX-slot 3 kandidaten kan ophalen zonder de commandoregel.
#
# Bron: Freesound, CC0/CC-BY (commercieel oké). Eenmalig gratis sleutel op
# https://freesound.org/apiv2/apply en zetten in tools/channel-keys.json : { "freesound": "..." }
# (of env FREESOUND_API_KEY).
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_audio.py --story chose --voice man          # muziek-bed (3) + sfx (3 per punt)
#   python tools/channel_audio.py --story chose --voice man --force   # ook al-gevulde opnieuw ophalen
#   # studio-modus (door de engine aangeroepen):
#   python tools/channel_audio.py --candidates 3 --what music --story chose --voice man
#   python tools/channel_audio.py --candidates 3 --what sfx --scene 4 --pid s04_end --q "deep cinematic drum hit" --story chose --voice man
import argparse, os, sys, json, time, re, urllib.parse, urllib.request, urllib.error

API = "https://freesound.org/apiv2"

# MUZIEK-BED per verhaal: één zoekterm voor het doorlopende bed onder de hele video. We halen de
# TOP-3 lange tracks op als kandidaten; jij kiest er één in de studio. Val terug op een nette
# algemene term als het verhaal niet in de lijst staat.
MUSIC_QUERY = {
    "sword": "cinematic emotional documentary underscore",
    "chose": "ambient contemplative cinematic piano underscore",
}
MUSIC_QUERY_DEFAULT = "cinematic emotional underscore ambient"

# SFX op de kantelpunten van het verhaal (voor de batch). Gekoppeld aan de ZIN/scène-index; de
# tool leest de gemeten starttijd uit de tijdlijn. In de studio kun je per punt opnieuw 3 ophalen.
SFX = [
    {"scene": 1,  "q": "cinematic orchestral impact hit"},
    {"scene": 4,  "q": "deep cinematic drum hit"},
    {"scene": 5,  "q": "epic orchestral stinger"},
    {"scene": 9,  "q": "dark cinematic impact drum"},
    {"scene": 12, "q": "emotional cinematic strings swell"},
    {"scene": 16, "q": "triumphant orchestral swell"},
]
SFX_Q_DEFAULT = "cinematic impact hit sub boom"

# ---- Freesound-plumbing (ongewijzigd t.o.v. de werkende versie) ----------------------------

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
                print(f"    {e.code} (limiet) -> {wait}s wachten...", file=sys.stderr); time.sleep(wait); continue
            raise
        except Exception as e:
            last = e; time.sleep(2 * (i + 1)); continue
    if last: raise last

def _license_label(url):
    u = (url or "").lower()
    if "by-nc" in u or "by-nd" in u or "noncommercial" in u or "/nc" in u:
        return None
    if "zero" in u or "publicdomain" in u:
        return "CC0"
    if "/by/" in u or "licenses/by" in u:
        return "CC-BY"
    return None

def _candidates(query, key):
    # Haal de bruikbare treffers (CC0/CC-BY met preview-mp3) op voor een zoekterm.
    params = {"query": query, "page_size": 20, "token": key,
              "fields": "id,name,username,duration,previews,license", "sort": "score"}
    url = API + "/search/text/?" + urllib.parse.urlencode(params)
    try:
        d = json.loads(_get(url).decode("utf-8", "replace"))
    except Exception as e:
        print(f"    zoekfout: {e}", file=sys.stderr); return []
    out = []
    for r in d.get("results", []):
        lab = _license_label(r.get("license", ""))
        if not lab:
            continue
        pv = (r.get("previews") or {})
        hq = pv.get("preview-hq-mp3"); lq = pv.get("preview-lq-mp3")
        if not (hq or lq):
            continue
        out.append({"hq": hq, "lq": lq, "name": r.get("name", ""), "user": r.get("username", ""),
                    "dur": r.get("duration", 0) or 0, "lic": lab})
    return out

def search_cc0_many(query, key, n=3, prefer_long=False):
    # Als de oude search_cc0, maar levert de TOP-N (voor de 3-kandidaten-keuze). Muziek = langste
    # bedden (CC0 eerst); SFX = kortste effecten (CC0 eerst).
    cands = _candidates(query, key)
    if not cands:
        return []
    if prefer_long:
        fit = [c for c in cands if 20 <= c["dur"] <= 240] or cands
        fit.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, -min(c["dur"], 240)))
        for c in fit:
            c["url"] = c["lq"] or c["hq"]
        return fit[:n]
    short = [c for c in cands if c["dur"] <= 15] or cands
    short.sort(key=lambda c: (0 if c["lic"] == "CC0" else 1, c["dur"]))
    for c in short:
        c["url"] = c["hq"] or c["lq"]
    return short[:n]

def download(url, outpath):
    data = _get(url)
    with open(outpath, "wb") as f:
        f.write(data)

# ---- hergebruik-helpers (zelfde idee als beeld: __c1 = standaard, niet opnieuw downloaden) ----

AUDIO_EXTS = (".mp3", ".m4a", ".wav", ".aac", ".ogg")

def _staged(dirpath, prefix):
    # bestaande kandidaten <prefix>__c1/2/3.* op schijf, gesorteerd (c1 eerst).
    try:
        files = [f for f in os.listdir(dirpath)
                 if f.startswith(prefix + "__c") and os.path.splitext(f)[1].lower() in AUDIO_EXTS]
    except Exception:
        files = []
    files.sort()
    return files

def _safe(s):
    return re.sub(r"[^\w.\-]+", "_", str(s or "")).strip("_") or "x"

def fetch_music_candidates(story, key, mdir, channel, n, force):
    # 3 kandidaat-BEDDEN voor de hele video: <story>__muziek__c1/2/3.mp3. Hergebruik: staan ze er al
    # en geen --force, koppel terug ZONDER te downloaden.
    os.makedirs(mdir, exist_ok=True)
    prefix = _safe(story) + "__muziek"
    if not force:
        ex = _staged(mdir, prefix)
        if ex:
            return [{"file": f} for f in ex[:max(n, len(ex))]]
    query = MUSIC_QUERY.get(story, MUSIC_QUERY_DEFAULT)
    hits = search_cc0_many(query, key, n, prefer_long=True)
    if not hits:
        print(f"    geen bruikbaar muziek-bed voor '{query}'", file=sys.stderr); return []
    out = []
    for k, hit in enumerate(hits[:n], start=1):
        fname = f"{prefix}__c{k}.mp3"; fpath = os.path.join(mdir, fname)
        try:
            download(hit["url"], fpath)
        except Exception as e:
            print(f"    downloadfout bed {k}: {e}", file=sys.stderr); continue
        out.append({"file": fname, "credit": hit.get("user", ""), "license": hit.get("lic", ""),
                    "name": hit.get("name", ""), "dur": round(hit.get("dur", 0))})
        time.sleep(1.0)
    return out

def fetch_sfx_candidates(pid, query, key, sdir, channel, n, force):
    # 3 kandidaat-GELUIDEN voor één punt: sfx__<pid>__c1/2/3.mp3. Hergebruik als bij muziek/beeld.
    os.makedirs(sdir, exist_ok=True)
    prefix = "sfx__" + _safe(pid)
    if not force:
        ex = _staged(sdir, prefix)
        if ex:
            return [{"file": f} for f in ex[:max(n, len(ex))]]
    hits = search_cc0_many(query or SFX_Q_DEFAULT, key, n, prefer_long=False)
    if not hits:
        print(f"    geen bruikbaar effect voor '{query}'", file=sys.stderr); return []
    out = []
    for k, hit in enumerate(hits[:n], start=1):
        fname = f"{prefix}__c{k}.mp3"; fpath = os.path.join(sdir, fname)
        try:
            download(hit["url"], fpath)
        except Exception as e:
            print(f"    downloadfout effect {k}: {e}", file=sys.stderr); continue
        out.append({"file": fname, "credit": hit.get("user", ""), "license": hit.get("lic", ""),
                    "name": hit.get("name", "")})
        time.sleep(0.9)
    return out

# ---- main ----------------------------------------------------------------------------------

def _total_seconds(tl):
    scenes = tl.get("scenes", [])
    if not scenes:
        return float(tl.get("total_seconds", 0) or 0)
    return round(max((s.get("start", 0) + s.get("dur", 0)) for s in scenes), 3)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword")
    ap.add_argument("--voice", default="man")
    ap.add_argument("--root", default=".")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--channel", default="channel1", help="kanaal-map onder assets/channels/")
    # studio-modus (door de engine aangeroepen): 3 kandidaten voor één slot, als JSON terug.
    ap.add_argument("--candidates", type=int, default=0, help="studio-modus: N kandidaten i.p.v. de batch")
    ap.add_argument("--what", default="", choices=["", "music", "sfx"], help="music of sfx (met --candidates)")
    ap.add_argument("--pid", default="", help="punt-id voor sfx (bv. s04_end)")
    ap.add_argument("--q", default="", help="zoekterm voor sfx (anders standaard)")
    ap.add_argument("--scene", type=int, default=0, help="scène-nummer (sfx-plaatsing)")
    args = ap.parse_args()

    key = load_key(args.root)
    if not key:
        print("Geen Freesound-sleutel. Haal er gratis een op https://freesound.org/apiv2/apply en zet"
              " 'freesound' in tools/channel-keys.json. Dan draai je dit opnieuw.", file=sys.stderr)
        if args.candidates:
            print("CANDIDATES_JSON:" + json.dumps({"candidates": []}))
        return

    mdir = os.path.join(args.root, "assets", "channels", args.channel, "muziek")
    sdir = os.path.join(args.root, "assets", "channels", args.channel, "sfx")

    # ---------- STUDIO-MODUS: 3 kandidaten voor één slot, als JSON terug ----------
    if args.candidates:
        if args.what == "music":
            res = fetch_music_candidates(args.story, key, mdir, args.channel, args.candidates, args.force)
        elif args.what == "sfx":
            pid = args.pid or (f"s{args.scene:02d}_end" if args.scene else "punt")
            res = fetch_sfx_candidates(pid, args.q, key, sdir, args.channel, args.candidates, args.force)
        else:
            res = []
        print("CANDIDATES_JSON:" + json.dumps({"candidates": res}))
        return

    # ---------- BATCH: muziek-bed (3) + sfx per kantelpunt (3), __c1 standaard ----------
    tlpath = os.path.join(args.root, "assets", "channels", args.channel, "voice", args.story, args.voice, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json:", tlpath, file=sys.stderr); return
    tl = json.load(open(tlpath, encoding="utf-8"))
    scenes = tl.get("scenes", [])
    by_num = {s.get("scene"): s for s in scenes}
    total = _total_seconds(tl)
    credits = []
    n_mus = n_sfx = n_fail = 0

    # MUZIEK: één doorlopend bed onder de hele video. Haal 3 bedden op (c1 standaard). Reeds gekozen
    # bed NIET overschrijven: staat er al een tl["music"] met een bestaand bestand en geen --force,
    # dan laten we de keuze staan en stagen we alleen de kandidaten.
    beds = fetch_music_candidates(args.story, key, mdir, args.channel, 3, args.force)
    if beds:
        n_mus = len([b for b in beds if "credit" in b])  # alleen vers-gedownloade tellen
        cur = (tl.get("music") or [{}])[0] if tl.get("music") else {}
        cur_file = (cur.get("file") or "").replace("\\", "/")
        cur_ok = bool(cur_file) and os.path.exists(os.path.join(args.root, *cur_file.split("/")))
        if cur_ok and not args.force:
            print(f"muziek-bed: keuze blijft staan ({cur_file.split('/')[-1]}); {len(beds)} kandidaten klaar")
        else:
            c1 = beds[0]["file"]
            rel = "assets/channels/" + args.channel + "/muziek/" + c1
            tl["music"] = [{"start": 0, "end": total, "file": rel, "mood": "bed"}]
            print(f"muziek-bed: standaard {c1} (0 -> {total:.0f}s), {len(beds)} kandidaten klaar")
        for b in beds:
            if "name" in b:
                credits.append(f"muziek: {b.get('file','')} | {b.get('license','')} | {b.get('name','')} by {b.get('credit','')}")
    else:
        print("geen muziek-bed gevonden -> laat leeg", file=sys.stderr); n_fail += 1

    # SFX op de kantelpunten: per punt 3 kandidaten (c1 standaard). Reeds gekozen effect op dat punt
    # niet overschrijven (reuse). We plaatsen op het einde van de spraak binnen de scène.
    for sx in SFX:
        s = by_num.get(sx["scene"])
        if not s:
            continue
        pid = f"s{sx['scene']:02d}_end"
        t = round(float(s.get("speech_end", s.get("dur", 0))), 3)
        existing = s.get("sfx") or []
        chosen = next((f for f in existing if f.get("name") == "end" and f.get("file")), None)
        chosen_ok = False
        if chosen:
            cf = (chosen.get("file") or "").replace("\\", "/")
            chosen_ok = bool(cf) and os.path.exists(os.path.join(args.root, *cf.split("/")))
        res = fetch_sfx_candidates(pid, sx["q"], key, sdir, args.channel, 3, args.force)
        if not res:
            print(f"scène {sx['scene']} sfx: niets gevonden", file=sys.stderr); n_fail += 1; continue
        if chosen_ok and not args.force:
            print(f"scène {sx['scene']} sfx @ {t:.1f}s: keuze blijft staan; {len(res)} kandidaten klaar")
        else:
            c1 = res[0]["file"]
            rel = "assets/channels/" + args.channel + "/sfx/" + c1
            others = [f for f in existing if f.get("name") != "end"]
            others.append({"t": t, "name": "end", "file": rel, "q": sx["q"]})
            s["sfx"] = others
            print(f"scène {sx['scene']} sfx @ {t:.1f}s: standaard {c1}, {len(res)} kandidaten klaar")
            n_sfx += 1
        for c in res:
            if "name" in c:
                credits.append(f"sfx {pid}: {c.get('file','')} | {c.get('license','')} | {c.get('name','')} by {c.get('credit','')}")

    with open(tlpath, "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)
    try:
        with open(os.path.join(mdir, "_credits.txt"), "a", encoding="utf-8") as f:
            f.write("\n".join(credits) + ("\n" if credits else ""))
    except Exception:
        pass
    print(f"\nklaar: muziek-bed + {n_sfx} effecten gezet, {n_fail} niet gevonden.")
    print("Open de studio: beluister de 3 muziekbedden en de 3 per SFX-punt, en zet je keuzes vast.")

if __name__ == "__main__":
    main()
