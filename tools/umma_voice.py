#!/usr/bin/env python3
# umma_voice.py — genereert per scene een voice-over-fragment met KOKORO (lokaal, CPU, geen GPU),
# met de TOON per scene (rustig / nadruk / warm), zodat de stem klopt met wat er gezegd wordt.
# Draait LOKAAL op Mo's laptop. Schrijft assets/ummaunited/voice/<story>/<stem>/<nn>.wav + een
# import-script met de voice-paden. (Piper is vervangen door Kokoro; klinkt veel natuurlijker.)
#
# Eenmalig installeren:  pip install "pykokoro[cpu]"
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/umma_voice.py                 # beide delen, beide stemmen
#   python tools/umma_voice.py --voice man      # alleen de mannenstem
#   python tools/umma_voice.py --only 3         # alleen scene 3 opnieuw
#
# De TOON per scene staat in STORIES hieronder. Een zin die niet goed valt: alleen die regel
# wijzigen en opnieuw draaien met --only <nn>.
import argparse, os, sys, wave

# De twee gekozen Kokoro-stemmen (door Mo gekozen uit de test). a=Amerikaans, m=man, f=vrouw.
VOICES = {
    "man":   "am_michael",
    "vrouw": "af_bella",
}

# Toon-presets voor Kokoro: speed (tempo, <1 = trager/zwaarder, >1 = sneller) en sil = extra
# STILTE (seconden) die we na het fragment aanplakken, zodat een gedachte kan landen (adem,
# niet bam-bam-bam). De engine voegt tussen scenes ook nog een adempauze toe (VOICE_PAD).
TONE = {
    "rustig": dict(speed=1.00, sil=0.45),   # verhalend, vlot met een beetje rust
    "nadruk": dict(speed=0.92, sil=0.70),   # statement, zwaarder, laat de klap hangen
    "warm":   dict(speed=0.90, sil=0.85),   # payoff, rustig, laat het bezinken
    "hook":   dict(speed=0.96, sil=0.55),   # opening, pakkend maar met lucht
}

# Kokoro-synthesizer wordt per (stem, snelheid) één keer opgezet (model laadt dan één keer per
# combinatie). De snelheid zit in de SynthesisConfig, zodat de toon-per-scene echt doorwerkt.
_SYNTH_CACHE = {}
def _get_synth(voice_model, speed):
    key = (voice_model, round(speed, 3))
    if key in _SYNTH_CACHE:
        return _SYNTH_CACHE[key]
    from pykokoro import KokoroSynthesizer, SynthesisConfig, GenerationConfig
    cfg = SynthesisConfig(voice=voice_model, generation=GenerationConfig(lang="en-us", speed=speed))
    synth = KokoroSynthesizer(cfg).__enter__()
    _SYNTH_CACHE[key] = synth
    return synth

def _synthesize(voice_model, text, speed, sil, out_wav):
    synth = _get_synth(voice_model, speed)
    rendered = synth.synthesize_text(text, language="en-us", voice=voice_model)
    rendered.save_wav(out_wav)
    if sil and sil > 0:
        _append_silence(out_wav, sil)

def _append_silence(wav_path, seconds):
    # plak stilte achter de wav zodat er adem na de zin zit. Kokoro schrijft FLOAT-wav (format 3),
    # die de wave-module niet kan lezen; daarom werken we direct op de RIFF-bytes. Stilte = nullen
    # (0.0 in float en 0 in PCM zijn allebei nul-bytes). We lezen de fmt-chunk, berekenen hoeveel
    # bytes stilte nodig is, plakken die achter de data-chunk en werken de twee lengte-velden bij.
    try:
        import struct
        with open(wav_path, "rb") as f:
            data = bytearray(f.read())
        if data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
            return
        # byteRate staat op offset 28 in de standaard fmt-chunk
        byte_rate = struct.unpack_from("<I", data, 28)[0]
        if byte_rate <= 0:
            return
        # zoek de 'data'-chunk
        i = 12
        data_off = None; data_len = None
        while i + 8 <= len(data):
            cid = bytes(data[i:i+4]); clen = struct.unpack_from("<I", data, i+4)[0]
            if cid == b"data":
                data_off = i + 8; data_len = clen; break
            i += 8 + clen + (clen & 1)
        if data_off is None:
            return
        nbytes = int(byte_rate * seconds)
        # sample-uitlijning (4 bytes bij 32-bit mono; blockalign op offset 32)
        block_align = struct.unpack_from("<H", data, 32)[0] or 1
        nbytes -= (nbytes % block_align)
        silence = b"\x00" * nbytes
        # voeg stilte toe direct na de data-bytes
        insert_at = data_off + data_len
        new = data[:insert_at] + silence + data[insert_at:]
        # werk data-chunk-lengte (offset data_off-4) en RIFF-lengte (offset 4) bij
        struct.pack_into("<I", new, data_off - 4, data_len + nbytes)
        struct.pack_into("<I", new, 4, len(new) - 8)
        with open(wav_path, "wb") as f:
            f.write(new)
    except Exception:
        pass

# Het script "sword" (idee 1), per scene: nummer, toon, on-screen-tekst, en de VOICE-zin.
# De voice-zin is wat ingesproken wordt; de on-screen-tekst is de korte zin in beeld.
# TWEE DELEN. Knip op de natuurlijke breuk: deel 1 = HOE de islam opkwam (zonder dwang),
# eindigt op een cliffhanger die de grote test opzet (500 jaar kolonisatie). Deel 2 = de TEST,
# en dat het standhield (Indonesië 300 jaar, Bosnië, Spanje, payoff, CTA).
# SCRIPT v2 — scherper, trots, DIRECT tot de moslim-kijker (iedereen mag meekijken). Korte rake
# zinnen, pakkende haak, geen neutraal-documentaire-toon. Per scene: nr, toon, ON-SCREEN kernzin
# (groot in beeld bij statement/mythe), en de VOICE-zin (ook de ondertitel die meeloopt).
STORIES = {
  "sword1": {
    "title": "Spread by the sword? (1)",
    "scenes": [
      (1,  "hook",   "Spread by the sword?",
           "They say Islam was spread by the sword. That your faith was forced on the world. It is the one accusation they always reach for. So let us look at it, calmly, you and I."),
      (2,  "nadruk", "Every empire took land by the sword.",
           "Yes, Muslim empires conquered land. But so did every empire that ever existed. Rome, Persia, Britain, all of them took land by the sword. That is how the world was ruled. Conquering land tells you nothing about a faith. So that is not the real question."),
      (3,  "nadruk", "So what is the real question?",
           "Here is the real question. When the armies left, and the power was gone, what happened to the faith? Because that, and only that, tells you whether it was forced, or whether it was chosen."),
      (4,  "rustig", "What is forced, fades.",
           "Look at where faith was forced on people from above. The moment the empire fell, it drained away. Vanished, like it was never there. Because a faith held up by power dies the moment the power dies."),
      (5,  "rustig", "We left the people free.",
           "Now look at us. No one was ever forced to believe. People were left free, and over generations, by their own will, they chose it. Because faith is not placed in a heart by a sword. Guidance is from Allah alone."),
      (6,  "warm",   "Then came the hardest test.",
           "And that is why it held. But do not take my word for it. Because then came the hardest test this faith would ever face. That is part two."),
    ],
  },
  "sword2": {
    "title": "Spread by the sword? (2)",
    "scenes": [
      (1,  "nadruk", "They tried everything.",
           "For five hundred years, Europe ruled almost the entire Muslim world. And they did not just rule. They tried to pull the faith out by the root. They killed. They humiliated. They turned brother against brother. Everything a power can do, they did."),
      (2,  "rustig", "What enters freely cannot be ripped out.",
           "And it did not work. Indonesia. No army ever brought Islam there, only honest men. And three hundred years of Dutch rule could not take it back out. What enters a heart freely cannot be ripped out by force."),
      (3,  "warm",   "Surrounded, and still standing.",
           "Bosnia. Surrounded in the heart of Europe. Through wars meant to erase them from the earth. And still, today, they stand. Still praying. Still here."),
      (4,  "nadruk", "What is chosen, stays.",
           "And everywhere our people were once conquered, North Africa, the East, when the occupier finally left, the faith was still standing. That is the proof. What is forced, fades. What is chosen, stays."),
      (5,  "rustig", "The sword was always theirs.",
           "So remember this. The sword, the forcing, the burning, that was never ours. It was always theirs. And a faith taken by force leaves a wound. Look at the West today, turning its back on belief entirely. But that is their story to carry, not ours."),
      (6,  "warm",   "You are the proof.",
           "We never needed a sword. The truth only ever needed to be seen. That is why, after everything they threw at us, we are still here. So stand tall. Every time you pray, you are the proof that no empire could ever win. Follow Umma United."),
    ],
  },
}
# Gedeelde landgroepen voor beide delen.
# romemoslim = de door Rome beheerste landen die DAARNA moslim werden (en waar het opgelegde
# christendom nu weg is). BEWUST zonder Italie/Spanje/Griekenland: die bleven christelijk, dus
# die mee laten kleuren zou de tekst "dat geloof is daar verdwenen" tegenspreken.
_GROUPS = [
  "group romemoslim = Morocco, Algeria, Tunisia, Libya, Egypt, Syria, Lebanon, Turkey, Jordan, Iraq",
  "group europe_west = France, Spain, Italy, Portugal, Germany, Netherlands, Belgium",
  "group indonesia = Indonesia",
  "group bosnia = Bosnia and Herz.",
  "group spain = Spain",
]
STORIES["sword1"]["groups"] = _GROUPS
STORIES["sword2"]["groups"] = _GROUPS
# Choreografie per deel (scene-nr binnen DAT deel). Technieken gemengd, SFX op de kantels.
# tech: beeld = video/foto-achtergrond (uit assets/ummaunited/video/). vid: = video, img: = foto.
# tech: kaart/statement/mythe = getekend (geen media nodig).
# Beeld per scène afgestemd op het NIEUWE script (trots, niet aanvallend).
STORIES["sword1"]["map"] = [
  (1, "Spread by the sword?",            ["tech: mythe", "truth: Conquering land says nothing about faith.", "sfx: assets/ummaunited/sfx/sfx-zwaard.mp3"]),
  (2, "Every empire took land this way.", ["tech: beeld", "vid: vid-rome.mp4", "sfx: assets/ummaunited/sfx/sfx-boom.mp3"]),
  (3, "So what is the real question?",   ["tech: statement"]),
  (4, "What is forced, fades.",          ["tech: kaart", "fill: romemoslim=cream", "view: mena"]),
  (5, "We left the people free.",        ["tech: beeld", "vid: vid-gebed.mp4"]),
  (6, "Then came the hardest test.",     ["tech: statement", "kick: Part 2", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
]
STORIES["sword2"]["map"] = [
  (1, "They tried everything.",          ["tech: beeld", "vid: vid-kolonisatie.mp4", "sfx: assets/ummaunited/sfx/sfx-impact.mp3"]),
  (2, "And still, it did not leave.",    ["tech: beeld", "vid: vid-indonesie.mp4"]),
  (3, "Alone, surrounded, still here.",  ["tech: beeld", "vid: vid-bosnie.mp4"]),
  (4, "What is chosen, stays.",          ["tech: kaart", "fill: romemoslim=cream; spain=cream", "view: mena"]),
  (5, "The sword was always theirs.",    ["tech: statement"]),
  (6, "You are the proof.",              ["tech: beeld", "vid: vid-gebed-massa.mp4", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
]

def build_story(story_id, voice, root, only=0):
    story = STORIES[story_id]
    model = VOICES[voice]
    outdir = os.path.join(root, "assets", "ummaunited", "voice", story_id, voice)
    os.makedirs(outdir, exist_ok=True)
    made = []
    for num, tone, screen, voiceline in story["scenes"]:
        if only and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        try:
            _synthesize(model, voiceline, t["speed"], t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        made.append((num, wav)); print(f"  scene {num:02d} [{tone}] -> {wav}")
    if not only:
        lines = [f"title: {story['title']}", "view: belt"] + story["groups"]
        by = {num: wav for num, wav in made}
        # volle gesproken zin per scene-nr (voor de ondertitel die meeloopt met de stem)
        caption_by = {num: voiceline for (num, tone, screen, voiceline) in story["scenes"]}
        for num, screen, mapspec in story["map"]:
            parts = [f"scene {num}", screen] + list(mapspec)
            if caption_by.get(num):
                parts.append("caption: " + caption_by[num])
            if by.get(num):
                parts.append("voice: " + os.path.relpath(by[num], root).replace("\\", "/"))
            lines.append(" | ".join(parts))
        imp = os.path.join(outdir, f"_import-{voice}.txt")
        with open(imp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print("  import-script:", imp)
    print(f"  klaar: {len(made)} fragment(en)")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="all", help="sword1, sword2, of all (default: beide delen)")
    ap.add_argument("--voice", default="beide", choices=list(VOICES.keys()) + ["beide"])
    ap.add_argument("--only", type=int, default=0, help="alleen scene-nummer N opnieuw maken")
    ap.add_argument("--root", default=".", help="content-engine root")
    args = ap.parse_args()

    # vroege check: is Kokoro geinstalleerd?
    try:
        import pykokoro  # noqa
    except Exception:
        print("Kokoro is niet geinstalleerd. Doe eerst:  pip install \"pykokoro[cpu]\"")
        sys.exit(1)

    stories = ["sword1", "sword2"] if args.story == "all" else [args.story]
    voices = list(VOICES.keys()) if args.voice == "beide" else [args.voice]
    for sid in stories:
        if sid not in STORIES:
            print("onbekend verhaal:", sid); continue
        for voice in voices:
            print(f"\n=== {sid} · STEM: {voice} ({VOICES[voice]}) ===")
            build_story(sid, voice, args.root, args.only)

    # synthesizers netjes afsluiten
    for synth in _SYNTH_CACHE.values():
        try: synth.__exit__(None, None, None)
        except Exception: pass

if __name__ == "__main__":
    main()
