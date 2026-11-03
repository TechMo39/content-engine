#!/usr/bin/env python3
# umma_voice_test.py — laat EEN stuk tekst door meerdere Kokoro-MANNENstemmen inspreken,
# zodat je ze naast elkaar kunt beluisteren en de beste kiest. Verandert NIETS aan de video;
# schrijft alleen test-wavs in assets/ummaunited/voice/_tests/.
import os, sys

VOICES = ["am_michael","am_fenrir","am_onyx","am_puck","am_eric","am_adam","bm_george","bm_fable","bm_lewis"]

TEXT = ("You have heard it your whole life. Islam was spread by the sword. Convert, or die. "
        "But the truth never needed a sword. It only ever needed to be seen. "
        "And every single time you rise to pray, you are the living proof.")

SPEED = 0.95

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = os.path.join(root, "assets", "ummaunited", "voice", "_tests")
    os.makedirs(outdir, exist_ok=True)
    try:
        from pykokoro import KokoroSynthesizer, SynthesisConfig, GenerationConfig
    except Exception as e:
        print("Kokoro niet gevonden. Installeer:  pip install \"pykokoro[cpu]\"\nFout:", e); sys.exit(1)
    ok, fail = [], []
    for v in VOICES:
        out = os.path.join(outdir, v + ".wav")
        print(f"-> {v} ...", flush=True)
        try:
            cfg = SynthesisConfig(voice=v, generation=GenerationConfig(lang="en-us", speed=SPEED))
            synth = KokoroSynthesizer(cfg).__enter__()
            synth.synthesize_text(TEXT, language="en-us", voice=v).save_wav(out)
            try: synth.__exit__(None, None, None)
            except Exception: pass
            ok.append(v); print(f"   klaar: {out}")
        except Exception as e:
            fail.append(v); print(f"   OVERGESLAGEN ({v}): {e}")
    print("\n--------------------------------------------------")
    print(f"Klaar: {len(ok)} stemmen in  {outdir}")
    for v in ok: print(f"   {v}.wav")
    if fail: print("Niet gelukt: " + ", ".join(fail) + "  (onbekende stem voor jouw Kokoro-versie -> overgeslagen)")

if __name__ == "__main__":
    main()
