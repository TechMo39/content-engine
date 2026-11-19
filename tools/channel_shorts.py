#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
channel_shorts.py - maak 1 of 2 verticale promo-Shorts (9:16) uit een volle 16:9 video.

De volle video (uit de render) is 16:9. Shorts zijn verticaal (9:16, 1080x1920). Deze tool:
  - kiest 1 of 2 sterke stukken (standaard: de opening-hook + een nadruk-scene uit de tijdlijn),
  - knipt die eruit,
  - zet 16:9 om naar 9:16 met een wazige, donkere achtergrond (niks valt weg, ziet er pro uit),
  - plakt onderaan een CTA ("FULL VIDEO ON OUR CHANNEL"),
  - schrijft per Short een tekstje met de volledige-video-link erbij (voor beschrijving + 'gerelateerde video').

De LINK zelf zet je niet in de pixels maar bij het uploaden van de Short: als gerelateerde video,
in de beschrijving en als vastgezette comment (zie het .txt dat hierbij hoort).

Voorbeeld:
  python tools/channel_shorts.py \
    --video out/channels/channel1/truthward-the-answer-you-never-chose-v2.mp4 \
    --story chose --voice v2 --url https://youtu.be/kEzeJsavMVU --count 2

Of met eigen tijdvensters (seconden):
  python tools/channel_shorts.py --video <pad>.mp4 --clips "6-44,266-298" --url <link>
"""
import argparse, json, os, shutil, subprocess, sys

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
OUT_W, OUT_H = 1080, 1920
MIN_LEN, MAX_LEN = 12.0, 178.0          # Shorts mogen tot 3 min (180s); promo's houden we kort (auto ~32-36s)
CTA_TEXT = "FULL VIDEO ON OUR CHANNEL"

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def _resolve_bins(root):
    # Zoek ffmpeg/ffprobe zoals de andere tools: eerst env, dan de meegeleverde static-binary
    # (node_modules), anders de PATH. Zo werkt het op Windows zonder losse installatie.
    global FFMPEG, FFPROBE
    for c in ([os.environ.get("FFMPEG_PATH")] if os.environ.get("FFMPEG_PATH") else []) + [
            os.path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe"),
            os.path.join(root, "node_modules", "ffmpeg-static", "ffmpeg")]:
        if c and os.path.isfile(c):
            FFMPEG = c
            break
    else:
        FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
    for c in ([os.environ.get("FFPROBE_PATH")] if os.environ.get("FFPROBE_PATH") else []) + [
            os.path.join(root, "node_modules", "ffprobe-static", "bin", "win32", "x64", "ffprobe.exe"),
            os.path.join(root, "node_modules", "ffprobe-static", "ffprobe")]:
        if c and os.path.isfile(c):
            FFPROBE = c
            break
    else:
        FFPROBE = shutil.which("ffprobe") or "ffprobe"


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode("utf-8", "replace")[-1500:])
        raise RuntimeError("ffmpeg faalde")
    return p


def probe_dur(path):
    try:
        p = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                            "-of", "default=nw=1:nk=1", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return float(p.stdout.decode().strip())
    except Exception:
        return 0.0   # ffprobe niet gevonden of onleesbaar -> lengte onbekend, knippen werkt nog steeds


def load_timeline(root, channel, story, voice):
    tj = os.path.join(root, "assets", "channels", channel, "voice", story, voice, "_timeline.json")
    if not os.path.isfile(tj):
        return None
    try:
        with open(tj, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def clamp_clip(start, end, total):
    start = max(0.0, float(start))
    end = min(float(end), total if total else end)
    if end - start < MIN_LEN:
        end = start + MIN_LEN
    if end - start > MAX_LEN:
        end = start + MAX_LEN
    if total and end > total:
        end = total
        start = max(0.0, end - MAX_LEN)
    return round(start, 2), round(end, 2)


def auto_clips(tl, total, count):
    """Standaardkeuze: Short 1 = de opening-hook (na de merk-intro), Short 2 = een nadruk-scene."""
    clips = []
    scenes = (tl or {}).get("scenes", [])
    # Short 1: hook. Start bij de eerste niet-intro scene, ~36s lang.
    hook_start = 0.0
    for s in scenes:
        if s.get("tone") not in ("intro",):
            hook_start = float(s.get("start", 0.0))
            break
    clips.append(clamp_clip(hook_start, hook_start + 36, total))
    if count >= 2:
        # Short 2: een 'nadruk'-scene (of anders de scene rond het midden).
        pick = None
        for s in scenes:
            if s.get("tone") == "nadruk":
                pick = s
                break
        if pick is None and scenes:
            pick = scenes[len(scenes) // 2]
        if pick is not None:
            st = float(pick.get("start", total / 2 if total else 0))
            clips.append(clamp_clip(st, st + 32, total))
    # geen tijdlijn -> val terug op begin en midden
    if not scenes:
        clips = [clamp_clip(0, 36, total)]
        if count >= 2 and total > 90:
            mid = total * 0.45
            clips.append(clamp_clip(mid, mid + 32, total))
    return clips[:count]


def make_short(video, start, end, out_path):
    dur = round(end - start, 2)
    # 16:9 -> 9:16: wazige vergrote achtergrond + de echte video gecentreerd, CTA onderaan.
    cta = CTA_TEXT.replace(":", "\\:").replace("'", "")
    fc = (
        "[0:v]split=2[a][b];"
        f"[a]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},"
        "boxblur=luma_radius=24:luma_power=2,eq=brightness=-0.22[bg];"
        f"[b]scale={OUT_W}:-2[fg];"
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[base];"
        f"[base]drawtext=fontfile={FONT}:text='{cta}':fontcolor=white:fontsize=46:"
        "box=1:boxcolor=black@0.55:boxborderw=24:x=(w-text_w)/2:y=h-280[v]"
    )
    run([FFMPEG, "-y", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", video,
         "-filter_complex", fc, "-map", "[v]", "-map", "0:a?",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", "30",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
         "-movflags", "+faststart", out_path])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True, help="pad naar de volle 16:9 mp4")
    ap.add_argument("--story", default="")
    ap.add_argument("--voice", default="")
    ap.add_argument("--root", default=".")
    ap.add_argument("--channel", default="channel1")
    ap.add_argument("--count", type=int, default=2, help="aantal Shorts (1 of 2)")
    ap.add_argument("--clips", default="", help="eigen tijdvensters in seconden, bv '6-44,266-298'")
    ap.add_argument("--url", default="", help="link naar de volledige video (voor het .txt)")
    args = ap.parse_args()

    _resolve_bins(args.root)
    if not os.path.isfile(args.video):
        print(f"video niet gevonden: {args.video}"); sys.exit(1)
    total = probe_dur(args.video)
    count = max(1, min(2, args.count))

    if args.clips.strip():
        clips = []
        for part in args.clips.split(","):
            if "-" in part:
                a, b = part.split("-", 1)
                clips.append(clamp_clip(float(a), float(b), total))
        clips = clips[:count] if count else clips
    else:
        tl = load_timeline(args.root, args.channel, args.story, args.voice)
        clips = auto_clips(tl, total, count)

    outdir = os.path.join(args.root, "assets", "channels", args.channel, "shorts") \
        if False else os.path.join(args.root, "out", "channels", args.channel, "shorts")
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(args.video))[0]

    out_root = os.path.join(args.root, "out")
    results = []
    for i, (st, en) in enumerate(clips, 1):
        out_path = os.path.join(outdir, f"{base}-short{i}.mp4")
        print(f"Short {i}: {st:.1f}s -> {en:.1f}s  ({en - st:.1f}s)  -> {out_path}")
        make_short(args.video, st, en, out_path)
        link = args.url or "<link naar de volledige video>"
        upload_text = ("Beschrijving (plak in de Short): Full video on our channel. " + link +
                       "\nGerelateerde video (koppel bij upload): " + link +
                       "\nVastgezette comment: Full video here -> " + link)
        # tekstje ook naast de clip wegschrijven
        with open(os.path.splitext(out_path)[0] + "-upload.txt", "w", encoding="utf-8") as f:
            f.write("SHORT-UPLOAD\n" + upload_text + "\n")
        try:
            rel = os.path.relpath(out_path, out_root).replace(os.sep, "/")
            url_path = "/out/" + rel
        except Exception:
            url_path = out_path
        results.append({"url": url_path, "txt": upload_text})

    print(f"\nklaar: {len(results)} short(s) in {outdir}")
    if not args.url:
        print("tip: geef --url mee met de link van de volledige video, dan staat die meteen in de upload-tekstjes.")
    # machine-leesbaar voor de studio/engine
    print("SHORTS_JSON:" + json.dumps({"shorts": results}))


if __name__ == "__main__":
    main()
