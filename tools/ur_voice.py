#!/usr/bin/env python3
# ur_voice.py - NL voice-over voor UncleRank-renders. HERGEBRUIKT de Truthward-stemketen
# (tools/channel_voice.py): exact dezelfde Chatterbox-synthese, alleen NL + referenties uit
# voice-test/refs-ur/ + UR-scripts per type. Per run WILLEKEURIG één stem gekozen (Mo's afspraak
# in de UR-chat: random een stem). Output: assets/unclerank/voice/<type>/NN.wav (NN = regelindex).
#
# Eenmalig:  pip install chatterbox-tts soundfile librosa
# Draai (Git Bash, in ~/Desktop/content-engine):
#   python tools/ur_voice.py --type roi
#   python tools/ur_voice.py --type roi --voice NL_commercial_3   # vaste stem i.p.v. random
import argparse, os, sys, glob, random, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_voice' importeerbaar is
import channel_voice as cv

cv.LANG = "nl"   # NL-stem (Truthward draait op "en")

# Voice-over-regels per type, in DEZELFDE volgorde als de beats in unclerank.mjs (UR_BEATS).
# GETALLEN FONETISCH uitschrijven - Chatterbox leest cijfers/euro's anders fout (Mo's les).
UR_SCRIPTS = {
    "roi": [
        "Elke maand veertig nieuwe bedrijven om te bellen.",
        "Elk met een mankement dat jij kunt fixen.",
        "Eén nieuwe klant levert je al snel zesduizend euro op.",
        "En jij betaalt maar negenentachtig euro per maand. Twee euro drieëntwintig per bedrijf.",
        "Eén klant, en je maand is er zo uit. Begin gratis, zeven dagen.",
    ],
}

TAIL_SIL = 0.35   # kleine adem na elke regel

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
    ap.add_argument("--type", required=True, help="UR-type, bv. roi")
    ap.add_argument("--voice", default="", help="vaste ref-naam zonder .wav; leeg = random")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    lines = UR_SCRIPTS.get(args.type)
    if not lines:
        print(f"geen script voor type '{args.type}'. Bekend: {list(UR_SCRIPTS)}"); sys.exit(1)

    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox ontbreekt. Doe eerst:  pip install chatterbox-tts soundfile librosa"); sys.exit(1)

    ref = pick_voice(args.root, args.voice)
    cv._FFMPEG = cv._ffmpeg_path(args.root)   # voor de ruisreductie, net als Truthward
    outdir = os.path.join(args.root, "assets", "unclerank", "voice", args.type)
    os.makedirs(outdir, exist_ok=True)
    print(f"=== UR-stem: {args.type} - ref: {os.path.basename(ref)} - {len(lines)} regel(s) ===")
    durs = []
    for i, line in enumerate(lines):
        wav = os.path.join(outdir, f"{i:02d}.wav")
        try:
            cv._synthesize_scene(ref, line, TAIL_SIL, wav)
        except Exception as e:
            print(f"  regel {i:02d}: FOUT -> {e}"); continue
        d = cv._wav_duration(wav)
        durs.append({"i": i, "wav": f"{i:02d}.wav", "dur": d, "text": line})
        print(f"  regel {i:02d}  {d:5.2f}s  -> {wav}")
    with open(os.path.join(outdir, "_voice.json"), "w", encoding="utf-8") as f:
        json.dump({"type": args.type, "ref": os.path.basename(ref), "lines": durs}, f, ensure_ascii=False, indent=2)
    print(f"klaar: {len(durs)} regel(s) in {outdir}  (stem: {os.path.basename(ref)})")
    print("Render daarna dit type in de studio; de engine legt stem + muziek er automatisch op.")

if __name__ == "__main__":
    main()
