#!/usr/bin/env python3
import os, argparse
VOICE_MODEL = "bm_george"
SPEED = 0.88
INTRO_TEXT = ("Welcome to Umma United. This is where we hand you back the side of the story you "
              "were never told. Our history. Our pride. Our present.")
OUTRO_TEXT = ""
def _ensure_espeak():
    if os.environ.get("ESPEAKNG_RUNTIME_EXECUTABLE"): return
    for c in (r"C:\Program Files\eSpeak NG\espeak-ng.exe", r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe"):
        if os.path.isfile(c):
            os.environ["ESPEAKNG_RUNTIME_EXECUTABLE"] = c
            os.environ["PATH"] = os.path.dirname(c) + os.pathsep + os.environ.get("PATH", ""); return
def _synth(text, out):
    from pykokoro import KokoroSynthesizer, SynthesisConfig, GenerationConfig
    cfg = SynthesisConfig(voice=VOICE_MODEL, generation=GenerationConfig(lang="en-us", speed=SPEED))
    s = KokoroSynthesizer(cfg).__enter__()
    s.synthesize_text(text, language="en-us", voice=VOICE_MODEL).save_wav(out)
    try: s.__exit__(None, None, None)
    except Exception: pass
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--story", default="sword"); ap.add_argument("--voice", default="man"); a = ap.parse_args()
    _ensure_espeak()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    vdir = os.path.join(root, "assets", "ummaunited", "voice", a.story, a.voice); os.makedirs(vdir, exist_ok=True)
    ip = os.path.join(vdir, "_intro.wav"); print("intro inspreken ->", ip, flush=True); _synth(INTRO_TEXT, ip); print("   klaar")
    if OUTRO_TEXT.strip():
        op = os.path.join(vdir, "_outro.wav"); print("outro inspreken ->", op, flush=True); _synth(OUTRO_TEXT, op); print("   klaar")
    print("\nKlaar. Render opnieuw om de gesproken intro te horen.")
if __name__ == "__main__": main()
