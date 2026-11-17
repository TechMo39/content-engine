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

TAIL_SIL = 0.35   # kleine adem aan het eind
LEAD_SIL = 0.40   # kleine aanloop zodat het eerste woord niet abrupt begint
SLOWER_CFG = 0.20 # rustiger tempo (lager cfg = langzamer; Mo: "rustiger laten spreken")

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
    ap.add_argument("--variant", type=int, default=-1, help="variant-index; -1 = geen submap")
    ap.add_argument("--lines", default="", help="JSON-bestand met de in te spreken regels (van de engine); leeg = ingebouwd script")
    ap.add_argument("--voice", default="", help="vaste ref-naam zonder .wav; leeg = random")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    # regels: van de engine (gekozen variant) als --lines gegeven is, anders het ingebouwde script
    lines = None
    if args.lines:
        try:
            with open(args.lines, encoding="utf-8") as f:
                lines = json.load(f)
        except Exception as e:
            print(f"kon --lines niet lezen ({e}); val terug op ingebouwd script")
    if not lines:
        lines = UR_SCRIPTS.get(args.type)
    if not lines:
        print(f"geen regels voor type '{args.type}'. Geef --lines of voeg een script toe. Bekend: {list(UR_SCRIPTS)}"); sys.exit(1)

    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox ontbreekt. Doe eerst:  pip install chatterbox-tts soundfile librosa"); sys.exit(1)

    ref = pick_voice(args.root, args.voice)
    cv._FFMPEG = cv._ffmpeg_path(args.root)   # voor de ruisreductie, net als Truthward
    cv.CFG_WEIGHT = SLOWER_CFG                 # rustiger tempo
    outdir = os.path.join(args.root, "assets", "unclerank", "voice", args.type)
    if args.variant >= 0:
        outdir = os.path.join(outdir, f"v{args.variant}")
    os.makedirs(outdir, exist_ok=True)

    # HELE tekst in ÉÉN opname (Truthward-stijl: _synthesize_scene groepeert de zinnen 2-per-blok met
    # een echte adem ertussen + afkap-vangnet). Niet zin-voor-zin -> geen afgekapte, rommelige stukjes.
    text = " ".join(s.strip() for s in lines if s and s.strip())
    out_wav = os.path.join(outdir, "voice.wav")
    print(f"=== UR-stem: {args.type} v{args.variant} - ref: {os.path.basename(ref)} - {len(lines)} regel(s), één opname ===")
    try:
        segs, sp0, sp1, diag = cv._synthesize_scene(ref, text, TAIL_SIL, out_wav)
    except Exception as e:
        print(f"  FOUT bij inspreken -> {e}"); sys.exit(1)
    if LEAD_SIL and LEAD_SIL > 0:
        cv._prepend_silence(out_wav, LEAD_SIL)   # kleine aanloop vooraan
    total = cv._wav_duration(out_wav)
    # per-regel timing (informatief); de engine gebruikt alleen 'total' en spreidt het beeld daarover
    lines_tl = []
    for i, s in enumerate(lines):
        st = round(segs[i][0] + LEAD_SIL, 3) if i < len(segs) else None
        dd = round(segs[i][1], 3) if i < len(segs) else None
        lines_tl.append({"i": i, "text": s, "start": st, "dur": dd})
    tl = {"type": args.type, "variant": args.variant, "ref": os.path.basename(ref),
          "wav": "voice.wav", "total": round(total, 3), "lines": lines_tl}
    with open(os.path.join(outdir, "_timeline.json"), "w", encoding="utf-8") as f:
        json.dump(tl, f, ensure_ascii=False, indent=2)
    print(f"klaar: voice.wav  {total:.2f}s  ({len(lines)} regels) in {outdir}  (stem: {os.path.basename(ref)})")

if __name__ == "__main__":
    main()
