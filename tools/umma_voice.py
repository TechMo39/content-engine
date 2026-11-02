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
           "You have heard it your whole life. That Islam was forced on the world at the point of a sword. Convert, or die. You have heard it so many times that somewhere, quietly, a part of you started to believe it. Today, I want to give you that part of you back."),
      (2,  "nadruk", "Here is what force actually looks like.",
           "Because if you want to see a faith that truly was forced on people, you do not need to look at us. Look at Rome. For three hundred years Rome ruled North Africa, Egypt, Syria, and it handed every one of them a single religion from above. Keep your own belief, and you were taxed, shut out, or killed."),
      (3,  "rustig", "So where is that faith today?",
           "So let me ask you something simple. All of that power. All of that pressure. For all of those centuries. Where is that faith in those lands today? It is almost gone. Because this is the nature of force. The moment the hand holding the sword lets go, whatever it was holding up, falls."),
      (4,  "nadruk", "It could not even hold its own home.",
           "And it was not only the edges of the empire. Look at its very heart, Europe itself. The faith it forced on half the world could not even keep its grip at home. Today most of Europe has walked away from religion entirely. That is what force always leaves behind in the end. An empty room."),
      (5,  "rustig", "No sword can reach a heart.",
           "Now understand why Islam did the opposite. No human being can force faith into a heart. Guidance comes from Allah alone, and no army that has ever marched can hand it out. All our people did was carry the message, live it honestly, and deal justly, and those who saw it, Allah opened their hearts to the truth."),
      (6,  "rustig", "No army ever reached these shores.",
           "And if any doubt remains, look at the largest Muslim nation on earth today. Indonesia. No Muslim army ever set foot on its shores. No conquest. No empire. Only honest traders in a dishonest world, and a people who saw the truth in how they lived, and reached for it themselves."),
      (7,  "warm",   "Then came the real test.",
           "So no, this faith was never spread by the sword. It spread because hearts recognised the truth when they finally saw it. But then came the real test. Five hundred years of empires with every weapon on earth, all of it aimed at tearing it back out. Did it break? That is part two."),
    ],
  },
  "sword2": {
    "title": "Spread by the sword? (2)",
    "scenes": [
      (1,  "nadruk", "Then the whole world came for it.",
           "In part one, you saw that Islam was never forced on anyone. Now comes the real test. For five hundred years, Europe colonised almost the entire Muslim world. Their armies, their schools, their wealth, their power, all of it turned against one single thing. Our faith. And after all of it, almost no one let go."),
      (2,  "nadruk", "Three centuries of power. Nothing moved.",
           "Take that same Indonesia. The Dutch ruled it for three hundred years. Three centuries of foreign power standing over a people who had chosen Islam entirely on their own. And in all that time, with everything an empire has, they could not move it. What was never forced in, could not be forced out."),
      (3,  "warm",   "Alone, surrounded, and still standing.",
           "Then look at Bosnia. Alone in the heart of Europe, far from any Muslim land, surrounded for centuries, through wars built to erase them from the map completely. And still, today, they are standing. Still praying. Still here. To our brothers and sisters in Bosnia, we see you, and we are proud of you."),
      (4,  "rustig", "The one exception proves the rule.",
           "There is only one place on earth where Islam was truly erased. Spain. But look closely at how. Not because hearts were changed. The Muslims there were given three choices. Convert, leave, or die. They were not argued out of their faith. They were driven out of their homes at the edge of a blade. The faith only left because the people were forced to leave with it."),
      (5,  "warm",   "Once the truth takes the heart.",
           "And that, my brother, my sister, is the whole point. Once the truth has taken hold of a heart, there is no empire on earth strong enough to pull it back out. But a lie held up by force lasts only as long as the force itself. The moment people are free, they free themselves from it. That is why the forced faiths faded, and why we are still here."),
      (6,  "warm",   "You are the proof.",
           "So the next time someone tells you your faith was forced on the world, you will know the truth. The truth was always the strongest thing in the room. It never needed a sword. It only needed to be seen. And every time you stand to pray, you are the living proof that no empire could ever win. Hold your head high. Follow Umma United."),
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
STORIES["sword1"]["map"] = [
  (1, "Spread by the sword?",               ["tech: mythe", "truth: Look who really held the blade.", "sfx: assets/ummaunited/sfx/sfx-zwaard.mp3"]),
  (2, "This is what force looks like.",      ["tech: beeld", "vid: vid-rome.mp4", "sfx: assets/ummaunited/sfx/sfx-boom.mp3"]),
  (3, "So where is that faith now?",         ["tech: kaart", "fill: romemoslim=cream", "view: mena"]),
  (4, "It lost its own home.",               ["tech: kaart", "fill: europe_west=cream", "view: europe"]),
  (5, "No sword reaches a heart.",           ["tech: beeld", "vid: vid-gebed.mp4"]),
  (6, "No army ever came here.",             ["tech: beeld", "vid: vid-indonesie.mp4"]),
  (7, "Then came the real test.",            ["tech: statement", "kick: Part 2", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
]
STORIES["sword2"]["map"] = [
  (1, "The whole world came for it.",        ["tech: beeld", "vid: vid-kolonisatie.mp4", "sfx: assets/ummaunited/sfx/sfx-impact.mp3"]),
  (2, "300 years. Nothing moved.",           ["tech: kaart", "fill: indonesia=orange", "rule: indonesia=ruler", "view: sea"]),
  (3, "Alone, and still standing.",          ["tech: beeld", "vid: vid-bosnie.mp4"]),
  (4, "One exception proves it.",            ["tech: beeld", "img: foto-spanje.jpg"]),
  (5, "Truth takes the heart.",              ["tech: beeld", "vid: vid-gebed-massa.mp4", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
  (6, "You are the proof.",                  ["tech: beeld", "vid: vid-gebed.mp4"]),
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
