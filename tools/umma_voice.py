#!/usr/bin/env python3
# umma_voice.py — genereert per scene een voice-over-fragment met Piper, met de TOON per scene
# (rustig / nadruk / warm), zodat de stem klopt met wat er gezegd wordt. Draait LOKAAL op Mo's
# laptop. Schrijft assets/ummaunited/voice/<story>/<nn>.wav + een import-script met de voice-paden.
#
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/umma_voice.py --story sword --voice man
#   python tools/umma_voice.py --story sword --voice vrouw
#
# De TOON per scene staat in SCENES hieronder (door Claude ingesteld op het script). Een zin
# die later niet goed valt pas je chirurgisch aan: alleen die ene regel in SCENES wijzigen en
# opnieuw draaien met --only <nn>.
import argparse, os, subprocess, sys, json

# De twee gekozen stemmen
VOICES = {
    "man":   "en_US-hfc_male-medium",
    "vrouw": "en_US-kristin-medium",
}

# Toon-presets: length-scale (tempo, hoger=trager), sentence-silence (pauze na zin), noise-scale (variatie)
# STRAKKER tempo dan eerst (de video werd 4 min; pauzes waren te lang). Nu vlotter, past bij een short.
TONE = {
    "rustig": dict(length=1.0,  sil=0.35, noise=0.80),   # verhalend, vlot
    "nadruk": dict(length=1.1,  sil=0.45, noise=0.75),   # statement, iets gezet
    "warm":   dict(length=1.12, sil=0.5,  noise=0.82),   # payoff, met gevoel maar niet sloom
    "hook":   dict(length=1.0,  sil=0.4,  noise=0.80),   # opening, pakkend
}

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
      (1,  "hook",   "They say we spread Islam by the sword.",
           "They told you Islam was spread by the sword. You've heard it so often you almost believe it. So let's talk about who actually used the sword."),
      (2,  "nadruk", "Rome forced its faith. At the point of a blade.",
           "Rome ruled North Africa, Syria, Egypt. Christianity, forced from above. Believe something else, and you were taxed, shut out, or killed. That is what the sword really looks like."),
      (3,  "rustig", "And today? That faith is almost gone there.",
           "Look at those same lands now. That forced Christianity? Almost gone. Because what you take by force, you lose the moment the force is gone."),
      (4,  "nadruk", "It couldn't even survive in Europe itself.",
           "And the heart of that empire, Europe itself? Today most of it has walked away from religion completely. The faith Rome forced on the world couldn't even survive at home."),
      (5,  "rustig", "Islam didn't need an army. People chose it.",
           "Islam spread differently. Not by replacing people, but by convincing them. The Egyptians, the Berbers, the Persians, they chose it themselves, generation after generation."),
      (6,  "rustig", "Indonesia: the biggest Muslim nation. No army ever came.",
           "Indonesia proves it. No Muslim army ever set foot there. It became the largest Muslim country on earth through trade. People saw how the merchants lived, and chose their faith freely."),
      (7,  "warm",   "Then came the real test. Part 2.",
           "So it grew without the sword. But then came the real test. Five hundred years of foreign power, built to break us. Did we bend? Part two."),
    ],
  },
  "sword2": {
    "title": "Spread by the sword? (2)",
    "scenes": [
      (1,  "nadruk", "500 years of colonisation. Almost no one converted.",
           "Then came Europe. Five hundred years of colonial rule over almost the whole Muslim world. Their armies, their schools, their power. And still, almost no one converted."),
      (2,  "nadruk", "300 years of Dutch rule. Indonesia stayed Muslim.",
           "The Dutch ruled Indonesia for three hundred years. Three centuries of power. And they changed nothing. A people who chose Islam freely, kept it under the rule that tried to take it."),
      (3,  "warm",   "Bosnia stood alone. And never let go.",
           "Bosnia. Alone in Europe, surrounded for centuries, through wars meant to erase them. And still, today, Muslim. Respect to our Bosnian brothers."),
      (4,  "rustig", "Spain is the proof. The people were driven out.",
           "Only one place lost Islam. Spain. Not because minds changed, but because Muslims were given three choices. Convert, leave, or die. They weren't persuaded. They were driven out. Where the people stayed, Islam stayed."),
      (5,  "warm",   "You can rewrite the story. Not the truth.",
           "So when they tell you your faith was forced on the world, remember. The accuser is usually the guilty one. You can rewrite the story. You cannot rewrite the truth. And your people never broke."),
      (6,  "warm",   "Be proud. This is who you are.",
           "Rulers came and went. Your people stayed. Be proud of that. Follow Umma United, and know who you are."),
    ],
  },
}
# Gedeelde landgroepen voor beide delen.
_GROUPS = [
  "group rome = Morocco, Algeria, Tunisia, Libya, Egypt, Syria, Lebanon, Turkey, Greece, Italy, Spain",
  "group europe_west = France, Spain, Italy, Portugal, Germany, Netherlands, Belgium",
  "group indonesia = Indonesia",
  "group bosnia = Bosnia and Herz.",
  "group spain = Spain",
]
STORIES["sword1"]["groups"] = _GROUPS
STORIES["sword2"]["groups"] = _GROUPS
# Choreografie per deel (scene-nr binnen DAT deel). Technieken gemengd, SFX op de kantels.
STORIES["sword1"]["map"] = [
  (1, "Islam was spread by the sword.",                   ["tech: mythe", "truth: Look who's really pointing.", "sfx: assets/ummaunited/sfx/sfx-zwaard.mp3"]),
  (2, "Rome. This is what forcing a faith looks like.",   ["tech: beeld", "img: beeld-rome.jpg", "sfx: assets/ummaunited/sfx/sfx-boom.mp3"]),
  (3, "Forced faith dies with the power behind it.",      ["tech: kaart", "rule: rome=cream", "view: mena"]),
  (4, "It couldn't even hold on at home.",                ["tech: kaart", "fill: europe_west=cream", "view: europe"]),
  (5, "The locals chose it. Over generations.",           ["tech: beeld", "img: beeld-kaart.jpg"]),
  (6, "Indonesia. No army. Just trade.",                  ["tech: beeld", "img: beeld-indonesie.jpg"]),
  (7, "Then came the greatest test. Part 2.",             ["tech: statement", "kick: Part 2", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
]
STORIES["sword2"]["map"] = [
  (1, "500 years of colonisation. No one converted.",                ["tech: beeld", "img: beeld-kolonisatie.jpg", "sfx: assets/ummaunited/sfx/sfx-impact.mp3"]),
  (2, "300 years of Dutch rule. Still Muslim.",                      ["tech: kaart", "fill: indonesia=orange", "rule: indonesia=ruler", "view: sea"]),
  (3, "Bosnia. Alone, surrounded, still here.",                      ["tech: beeld", "img: beeld-bosnie.jpg"]),
  (4, "Spain: the faith left only when the people were forced out.", ["tech: beeld", "img: beeld-spanje.jpg"]),
  (5, "You can't rewrite the truth.",                                ["tech: statement", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
  (6, "Umma United — know your history.",                            ["tech: statement"]),
]

def build_story(story_id, voice, root, only=0):
    story = STORIES[story_id]
    model = VOICES[voice]
    subprocess.run([sys.executable, "-m", "piper.download_voices", model],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    outdir = os.path.join(root, "assets", "ummaunited", "voice", story_id, voice)
    os.makedirs(outdir, exist_ok=True)
    made = []
    for num, tone, screen, voiceline in story["scenes"]:
        if only and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        cmd = [sys.executable, "-m", "piper", "-m", model,
               "--length-scale", str(t["length"]), "--sentence-silence", str(t["sil"]),
               "--noise-scale", str(t["noise"]), "-f", wav]
        p = subprocess.run(cmd, input=voiceline.encode("utf-8"), stderr=subprocess.PIPE)
        if p.returncode != 0:
            print(f"  scene {num}: FOUT\n", p.stderr.decode(errors="ignore")[-400:]); continue
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

    stories = ["sword1", "sword2"] if args.story == "all" else [args.story]
    for sid in stories:
        if sid not in STORIES:
            print("onbekend verhaal:", sid); continue
    voices = list(VOICES.keys()) if args.voice == "beide" else [args.voice]
    for sid in stories:
        if sid not in STORIES: continue
        for voice in voices:
            print(f"\n=== {sid} · STEM: {voice} ({VOICES[voice]}) ===")
            build_story(sid, voice, args.root, args.only)

if __name__ == "__main__":
    main()
