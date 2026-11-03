#!/usr/bin/env python3
# kokoro_test.py — TEST van de Kokoro-stem (lokaal, CPU, geen GPU) als alternatief voor Piper.
# Spreekt een paar ECHTE zinnen uit ons "Spread by the sword?"-script in, met meerdere stemmen
# (mannen + vrouwen, Amerikaans-Engels), zodat Mo met eigen oren kan vergelijken.
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   pip install "pykokoro[cpu]"          # eenmalig; model wordt bij 1e gebruik vanzelf gedownload
#   python tools/kokoro_test.py          # maakt test-wavs in assets/ummaunited/voice/_kokoro_test/
#
# Daarna luister je de wavs in die map. Zeg welke stem(men) je het beste vindt, dan bouw ik
# Kokoro in als tweede stem-optie naast Piper (jij kiest per video: Piper of Kokoro, man/vrouw).
import os, sys

# Een paar zinnen uit het echte script, met verschillende tonen (hook, nadruk, warm/payoff).
LINES = {
    "hook": "You have heard it your whole life. That Islam was forced on the world at the point of a sword. Convert, or die.",
    "nadruk": "If you want to see a faith that truly was forced on people, you do not need to look at us. Look at Rome.",
    "payoff": "Every time you stand to pray, you are the living proof that no empire could ever win. Hold your head high.",
}

# Stemmen om te proberen. Kokoro-naamgeving: a=Amerikaans, f=vrouw, m=man.
# Een paar van de bekendste/natuurlijkste stemmen; pas de lijst gerust aan.
VOICES = [
    ("am_michael", "man"),     # Amerikaanse man, rustig/gezaghebbend
    ("am_adam",    "man"),     # Amerikaanse man, iets lichter
    ("af_heart",   "vrouw"),   # Amerikaanse vrouw, warm (vaak favoriet)
    ("af_sarah",   "vrouw"),   # Amerikaanse vrouw, helder
    ("af_bella",   "vrouw"),   # Amerikaanse vrouw, expressief
]

def main():
    root = "."
    for a in sys.argv[1:]:
        if a.startswith("--root="):
            root = a.split("=", 1)[1]
    try:
        from pykokoro import KokoroSynthesizer, SynthesisConfig, GenerationConfig
    except Exception as e:
        print("Kokoro is nog niet geinstalleerd. Doe eerst:  pip install \"pykokoro[cpu]\"")
        print("Fout:", e)
        sys.exit(1)

    outdir = os.path.join(root, "assets", "ummaunited", "voice", "_kokoro_test")
    os.makedirs(outdir, exist_ok=True)
    print("Test-wavs komen in:", outdir)

    for voice, label in VOICES:
        try:
            cfg = SynthesisConfig(voice=voice, generation=GenerationConfig(lang="en-us"))
            with KokoroSynthesizer(cfg) as synth:
                for tone, text in LINES.items():
                    r = synth.synthesize_text(text, language="en-us", voice=voice)
                    fn = os.path.join(outdir, f"{voice}__{tone}.wav")
                    r.save_wav(fn)
                    print(f"  {voice} [{label}] {tone} -> {fn}")
        except Exception as e:
            print(f"  {voice}: FOUT -> {e}")

    print("\nKlaar. Luister de wavs in", outdir, "en zeg welke stem je het beste vindt.")

if __name__ == "__main__":
    main()
