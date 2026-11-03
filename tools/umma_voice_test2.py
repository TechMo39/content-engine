#!/usr/bin/env python3
import os, sys
# (stem, tempo) — lager tempo = zwaarder/ouder/rustiger. Mijn selectie voor een trotse,
# documentaire-achtige verteller: diepe + nog niet gehoorde stemmen, mannen en vrouwen.
VOICES = [
    ("am_santa", 0.88), ("bm_daniel", 0.90), ("am_echo", 0.92), ("am_liam", 0.92),
    ("am_onyx", 0.86), ("bm_george", 0.84), ("am_fenrir", 0.86),
    ("af_nova", 0.92), ("af_river", 0.92), ("af_kore", 0.92), ("bf_alice", 0.92), ("af_jessica", 0.92),
]
TEXT = ("You have heard it your whole life. Islam was spread by the sword. Convert, or die. "
        "But the truth never needed a sword. It only ever needed to be seen. "
        "And every single time you rise to pray, you are the living proof.")
def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = os.path.join(root, "assets", "ummaunited", "voice", "_tests")
    os.makedirs(outdir, exist_ok=True)
    try:
        from pykokoro import KokoroSynthesizer, SynthesisConfig, GenerationConfig
    except Exception as e:
        print("Kokoro niet gevonden:", e); sys.exit(1)
    ok, fail = [], []
    for v, spd in VOICES:
        name = f"{v}_tempo{int(spd*100)}.wav"
        out = os.path.join(outdir, name)
        print(f"-> {name} ...", flush=True)
        try:
            cfg = SynthesisConfig(voice=v, generation=GenerationConfig(lang="en-us", speed=spd))
            synth = KokoroSynthesizer(cfg).__enter__()
            synth.synthesize_text(TEXT, language="en-us", voice=v).save_wav(out)
            try: synth.__exit__(None, None, None)
            except Exception: pass
            ok.append(name); print(f"   klaar: {out}")
        except Exception as e:
            fail.append(v); print(f"   OVERGESLAGEN ({v}): {e}")
    print(f"\nKlaar: {len(ok)} stemmen in {outdir}")
    for n in ok: print(f"   {n}")
    if fail: print("Niet gelukt (onbekend voor jouw Kokoro-versie): " + ", ".join(fail))
if __name__ == "__main__":
    main()
