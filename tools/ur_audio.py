#!/usr/bin/env python3
# ur_audio.py - muziekbodem voor UncleRank-renders. HERGEBRUIKT de Truthward-muziek-matcher
# (tools/channel_audio.py: Freesound, CC0/CC-BY, commercieel veilig). Haalt per mood EEN track op,
# maakt 'm ZACHT (bodem onder de stem) en zet 'm in assets/unclerank/muziek/ur-<mood>.mp3 -
# een EIGEN UR-map (merk-gescheiden) zodat er geen Truthward/ToT-muziek in lekt.
#
# Vereist tools/channel-keys.json met { "freesound": "SLEUTEL" } (gratis op freesound.org/apiv2/apply).
# Draai (Git Bash, in ~/Desktop/content-engine):
#   python tools/ur_audio.py            # haalt wat nog mist
#   python tools/ur_audio.py --force    # alles opnieuw
import argparse, os, sys, subprocess, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_audio' importeerbaar is
import channel_audio as ca

# mood -> meerdere zoektermen (probeer tot er één een bruikbare CC0/CC-BY-track geeft). Mo vervangt
# de missers handmatig in de map.
UR_MOODS = {
    "upbeat": ["uplifting corporate background music", "motivational corporate", "positive business background", "upbeat ambient"],
    "calm":   ["calm ambient background", "soft piano background", "minimal ambient", "gentle corporate background"],
    "lofi":   ["lofi hip hop", "chill lofi beat", "lofi background", "chillhop instrumental"],
}
MUSIC_VOL = 0.15   # bodem wordt zacht INGEBAKKEN; de renderer legt 'm op 0.75 -> ~0.11 effectief (stem domineert)

def _ffmpeg(root):
    for rel in ("node_modules/ffmpeg-static/ffmpeg.exe", "node_modules/ffmpeg-static/ffmpeg"):
        cand = os.path.join(root, *rel.split("/"))
        if os.path.isfile(cand):
            return cand
    return shutil.which("ffmpeg") or "ffmpeg"

def soften(src, dst, ff):
    cmd = [ff, "-y", "-i", src, "-af", f"volume={MUSIC_VOL}", "-ac", "2", "-ar", "44100", dst]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    key = ca.load_key(args.root)
    if not key:
        print("Geen Freesound-sleutel. Zet 'freesound' in tools/channel-keys.json"
              " (gratis op https://freesound.org/apiv2/apply)."); sys.exit(1)
    mdir = os.path.join(args.root, "assets", "unclerank", "muziek")
    os.makedirs(mdir, exist_ok=True)
    ff = _ffmpeg(args.root)
    for mood, queries in UR_MOODS.items():
        out = os.path.join(mdir, f"ur-{mood}.mp3")
        if os.path.exists(out) and not args.force:
            print(f"{mood}: staat al ({os.path.basename(out)})"); continue
        hit = None
        for query in queries:
            print(f"{mood}: zoek '{query}'")
            hit = ca.search_cc0(query, key, prefer_long=True)
            if hit:
                break
        if not hit:
            print("   niets bruikbaars gevonden (alle termen) -> overslaan"); continue
        tmp = out + ".raw.mp3"
        try:
            ca.download(hit["url"], tmp)
            soften(tmp, out, ff)
        except Exception as e:
            print(f"   fout: {e}")
        finally:
            try:
                if os.path.exists(tmp): os.remove(tmp)
            except Exception:
                pass
        if os.path.exists(out):
            print(f"   -> {os.path.basename(out)}  ({hit['lic']}, {hit['dur']:.0f}s, zacht)")
    print("klaar. Beluister in assets/unclerank/muziek/ en vervang eventueel de missers.")

if __name__ == "__main__":
    main()
