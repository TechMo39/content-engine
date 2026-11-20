#!/usr/bin/env python3
# ur_voice.py - NL voice-over voor UncleRank-renders. HERGEBRUIKT de Truthward-stemketen
# (tools/channel_voice.py): exact dezelfde Chatterbox-synthese, alleen NL + referenties uit
# voice-test/refs-ur/ + per run WILLEKEURIG één stem.
#
# v2 (Mo's feedback "script gaat te snel, neemt zijn tijd niet"): we spreken nu PER REGEL in en zetten
# een ECHTE PAUZE tussen de regels. Zo krijgt elk punt rust, is het te volgen (ook voor wie het voor het
# eerst ziet), en kennen we de EXACTE duur van elke regel -> beeld en stem tegelen perfect (de engine
# zet elke kaart precies zo lang als z'n regel + adem).
#
# Uitspraak: Chatterbox leest Engelse termen/cijfers soms fout. PHON zet ze fonetisch om, ALLEEN in de
# stem (de kaarten tonen de echte term). "lead" -> "lied" is zeker; SEO/SEA/ads zijn een beste gok,
# makkelijk bij te stellen in de PHON-tabel hieronder als het nog raar klinkt.
#
# Draai (Git Bash, in ~/Desktop/content-engine):
#   python tools/ur_voice.py --type aanbod --variant 0 --lines <regels.json>
import argparse, os, sys, glob, random, json, subprocess, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_voice' importeerbaar is
import channel_voice as cv

cv.LANG = "nl"   # NL-stem (Truthward draait op "en")

# --- uitspraak-correcties, ALLEEN voor de stem (kaarten blijven de echte term tonen) ----------------
# Pas gerust aan als iets nog raar klinkt; "lead"->"lied" is zeker goed.
PHON = [
    (r"\bleads\b", "lieds"),
    (r"\blead\b", "lied"),
    (r"\bSEO\b", "es-ee-oo"),
    (r"\bSEA\b", "es-ee-aa"),
    (r"\bads\b", "edds"),
    (r"\bSaaS\b", "sas"),
]
def phon(s):
    for pat, rep in PHON:
        s = re.sub(pat, rep, s, flags=re.IGNORECASE)
    return s

TAIL_SIL  = 0.45   # adem aan het eind
LEAD_SIL  = 0.45   # aanloop zodat het eerste woord niet abrupt begint
PAUSE     = 0.65   # STILTE TUSSEN REGELS - dit geeft de rust die Mo mist
SLOWER_CFG = 0.20  # rustiger tempo (lager cfg = langzamer)
LOUDNORM = "loudnorm=I=-13:TP=-1.5:LRA=11"


def normalize_loud(path):
    ff = cv._FFMPEG or "ffmpeg"
    tmp = path + ".ln.wav"
    try:
        subprocess.run([ff, "-y", "-v", "error", "-i", path, "-af", LOUDNORM,
                        "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", tmp],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        os.replace(tmp, path)
        return True
    except Exception as e:
        try:
            if os.path.exists(tmp): os.remove(tmp)
        except Exception:
            pass
        print(f"  (loudnorm overgeslagen: {e})")
        return False


def pick_voice(root, want):
    refs = sorted(glob.glob(os.path.join(root, "voice-test", "refs-ur", "*.wav")))
    if not refs:
        print("Geen refs in voice-test/refs-ur/ - zet daar de NL_commercial_*.wav neer."); sys.exit(1)
    if want:
        for r in refs:
            if os.path.splitext(os.path.basename(r))[0].lower() == want.lower():
                return r
        print(f"stem '{want}' niet gevonden; beschikbaar: {[os.path.basename(x) for x in refs]}"); sys.exit(1)
    return random.choice(refs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", required=True)
    ap.add_argument("--variant", type=int, default=-1)
    ap.add_argument("--lines", default="", help="JSON-bestand met de in te spreken regels (van de engine)")
    ap.add_argument("--voice", default="", help="vaste ref-naam zonder .wav; leeg = random")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    lines = None
    if args.lines:
        try:
            with open(args.lines, encoding="utf-8") as f:
                lines = json.load(f)
        except Exception as e:
            print(f"kon --lines niet lezen ({e})")
    lines = [s.strip() for s in (lines or []) if s and s.strip()]
    if not lines:
        print(f"geen regels voor type '{args.type}'. Geef --lines."); sys.exit(1)

    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox ontbreekt. Doe eerst:  pip install chatterbox-tts soundfile librosa"); sys.exit(1)

    ref = pick_voice(args.root, args.voice)
    cv._FFMPEG = cv._ffmpeg_path(args.root)
    cv.CFG_WEIGHT = SLOWER_CFG
    ff = cv._FFMPEG or "ffmpeg"
    outdir = os.path.join(args.root, "assets", "unclerank", "voice", args.type)
    if args.variant >= 0:
        outdir = os.path.join(outdir, f"v{args.variant}")
    os.makedirs(outdir, exist_ok=True)

    print(f"=== UR-stem: {args.type} v{args.variant} - ref: {os.path.basename(ref)} - {len(lines)} regel(s), per regel met pauze ===")

    # 1) elke regel apart inspreken (met uitspraak-correctie), duur onthouden
    seg_wavs, durs = [], []
    for i, line in enumerate(lines):
        seg = os.path.join(outdir, f"_line{i:02d}.wav")
        try:
            cv._synthesize_scene(ref, phon(line), 0.0, seg)   # geen tail; pauzes regelen we zelf
        except Exception as e:
            print(f"  FOUT bij regel {i} -> {e}"); sys.exit(1)
        durs.append(cv._wav_duration(seg))
        seg_wavs.append(seg)
        print(f"  regel {i}: {durs[i]:.2f}s")

    # 2) pauze tussen de regels, en een adem aan het eind
    for i, seg in enumerate(seg_wavs):
        cv._append_silence(seg, PAUSE if i < len(seg_wavs) - 1 else TAIL_SIL)

    # 3) aan elkaar plakken (zelfde formaat -> copy), aanloopstilte ervoor, en LUID normaliseren
    out_wav = os.path.join(outdir, "voice.wav")
    listf = os.path.join(outdir, "_concat.txt")
    with open(listf, "w", encoding="utf-8") as f:
        for seg in seg_wavs:
            f.write("file '" + os.path.abspath(seg).replace("'", "'\\''") + "'\n")
    subprocess.run([ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listf, "-c", "copy", out_wav],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    if LEAD_SIL > 0:
        cv._prepend_silence(out_wav, LEAD_SIL)
    normalize_loud(out_wav)
    total = cv._wav_duration(out_wav)

    # 4) timeline met EXACTE per-regel duur INCLUSIEF de pauze, zodat de beats precies tegelen tot 'total'
    lines_tl, cursor = [], 0.0
    for i, line in enumerate(lines):
        trail = PAUSE if i < len(lines) - 1 else TAIL_SIL
        d = durs[i] + trail + (LEAD_SIL if i == 0 else 0.0)   # regel 0 draagt de aanloopstilte
        lines_tl.append({"i": i, "text": line, "start": round(cursor, 3), "dur": round(d, 3)})
        cursor += d
    tl = {"type": args.type, "variant": args.variant, "ref": os.path.basename(ref),
          "wav": "voice.wav", "total": round(total, 3), "pause": PAUSE, "lines": lines_tl}
    with open(os.path.join(outdir, "_timeline.json"), "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)

    # 5) opruimen
    for seg in seg_wavs:
        try: os.remove(seg)
        except Exception: pass
    try: os.remove(listf)
    except Exception: pass

    print(f"klaar: voice.wav  {total:.2f}s  ({len(lines)} regels, pauze {PAUSE}s) in {outdir}  (stem: {os.path.basename(ref)})")


if __name__ == "__main__":
    main()
