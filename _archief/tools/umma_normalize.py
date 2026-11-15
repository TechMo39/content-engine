#!/usr/bin/env python3
# umma_normalize.py - eenmalige omzetting van bestaande beeld-video's naar een formaat dat de app
# vlot afspeelt. Opgehaalde clips zijn soms 4K en/of 50fps; een laptop zonder losse GPU kan dat niet
# in een videovak decoderen, dus blijft de preview zwart. Dit script zet elke te zware video om naar
# maximaal 1080p en 30fps (zelfde codec, H.264/yuv420p). Clips die al klein genoeg zijn blijven ongemoeid.
#
#   python tools/umma_normalize.py            # zet alle te zware video's om
#   python tools/umma_normalize.py --all      # zet ALLE video's om (ook de al-kleine)
#
import argparse, os, re, subprocess

VIDEO_DIR = os.path.join("assets", "ummaunited", "video")
_FF = {}

def ffmpeg_bin(root):
    if "bin" not in _FF:
        try:
            _FF["bin"] = subprocess.check_output(
                ["node", "-e", "process.stdout.write(require('ffmpeg-static'))"],
                cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
        except Exception:
            _FF["bin"] = "ffmpeg"
    return _FF["bin"]

def probe(ff, path):
    # lees resolutie en fps uit de ffmpeg -i uitvoer (stderr)
    out = subprocess.run([ff, "-hide_banner", "-i", path], capture_output=True, text=True).stderr
    res = re.search(r", (\d{2,5})x(\d{2,5})", out)
    fps = re.search(r"(\d+(?:\.\d+)?)\s*fps", out)
    w = int(res.group(1)) if res else 0
    h = int(res.group(2)) if res else 0
    f = float(fps.group(1)) if fps else 0.0
    return w, h, f

def normalize(ff, path):
    tmp = path + ".norm.mp4"
    cmd = [ff, "-y", "-v", "error", "-i", path,
           "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
           "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "20",
           "-preset", "veryfast", "-movflags", "+faststart", "-an", tmp]
    subprocess.run(cmd, check=True)
    os.replace(tmp, path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="repo-root (standaard huidige map)")
    ap.add_argument("--all", action="store_true", help="ook video's omzetten die al klein genoeg zijn")
    args = ap.parse_args()

    vdir = os.path.join(args.root, VIDEO_DIR)
    if not os.path.isdir(vdir):
        print("map niet gevonden:", vdir); return
    ff = ffmpeg_bin(args.root)
    vids = sorted(f for f in os.listdir(vdir) if f.lower().endswith((".mp4", ".webm", ".mov", ".mkv", ".m4v")))
    if not vids:
        print("geen video's gevonden in", vdir); return

    done = skip = fail = 0
    for f in vids:
        p = os.path.join(vdir, f)
        w, h, fps = probe(ff, p)
        zwaar = w > 1920 or h > 1080 or fps > 30.9
        if not zwaar and not args.all:
            print(f"  {f}: {w}x{h} {fps:g}fps -> al goed, overslaan")
            skip += 1
            continue
        print(f"  {f}: {w}x{h} {fps:g}fps -> omzetten naar max 1080p30 ...", flush=True)
        try:
            normalize(ff, p)
            done += 1
        except Exception as e:
            print(f"    MISLUKT: {e}")
            fail += 1
    print(f"\nklaar: {done} omgezet, {skip} overgeslagen (al goed), {fail} mislukt.")
    print("Open daarna de Umma-tab in de app opnieuw en selecteer een video-beat.")

if __name__ == "__main__":
    main()
