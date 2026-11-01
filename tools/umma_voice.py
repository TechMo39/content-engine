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
TONE = {
    "rustig": dict(length=1.12, sil=0.55, noise=0.80),   # verhalend, neutraal
    "nadruk": dict(length=1.30, sil=0.80, noise=0.75),   # zwaar statement, traag + nadrukkelijk
    "warm":   dict(length=1.35, sil=0.95, noise=0.82),   # payoff, langzaam, lange pauzes, gevoel
    "hook":   dict(length=1.18, sil=0.70, noise=0.80),   # opening, iets gezet maar pakkend
}

# Het script "sword" (idee 1), per scene: nummer, toon, on-screen-tekst, en de VOICE-zin.
# De voice-zin is wat ingesproken wordt; de on-screen-tekst is de korte zin in beeld.
STORIES = {
  "sword": {
    "title": "Spread by the sword?",
    "scenes": [
      (1,  "hook",   "Spread by the sword? Look who's pointing.",
           "Today you'll hear it everywhere. Islam was spread by the sword. Convert, or die. It's become the accusation of our time. But more often than not, the one pointing the finger is the one who's guilty of it."),
      (2,  "nadruk", "Rome. This is what forcing a faith looks like.",
           "If you want to see a faith truly forced on people, look at Rome. For centuries, Rome and Byzantium ruled North Africa, Syria and Egypt. Christianity, imposed from above. Hold on to another belief, and you were taxed harder, shut out, or persecuted. That is what forcing a religion actually looks like."),
      (3,  "rustig", "Forced faith dies with the power behind it.",
           "And those same lands today? That imposed Christianity is almost gone. Because what you force with power disappears the moment the power does."),
      (4,  "nadruk", "It couldn't even hold on at home.",
           "And here's the irony. Look at Western Europe itself, the very heart of that empire. Islam barely ever ruled there. And yet today, most of it has walked away from religion altogether. The faith Rome forced on the world couldn't even hold on at home."),
      (5,  "rustig", "The locals chose it. Over generations.",
           "Islam spread differently. It didn't grow because Arabs moved in and replaced everyone. The armies passed through, but it was the local people themselves, the Egyptians, the Berbers, the Persians, who chose it, generation after generation, by their own will."),
      (6,  "rustig", "Indonesia. No army. Just trade.",
           "And nowhere proves it like Indonesia. No Muslim army ever set foot there. It became the largest Muslim country on earth through one thing. Trade. Merchants came to do business, the locals saw how they lived and how they kept their word, and adopted the faith entirely on their own."),
      (7,  "nadruk", "500 years of colonisation. No one converted.",
           "Then came Europe. Five hundred years of colonisation, over nearly the whole Muslim world. Christian armies, Christian schools, real power. And it converted almost no one."),
      (8,  "nadruk", "300 years of Dutch rule. Still Muslim.",
           "Take Indonesia again. The Dutch ruled it for three hundred years. Three centuries of colonial power. And they changed nothing. A people who became Muslim with no ruler forcing them, stayed Muslim under three hundred years of rule that tried."),
      (9,  "warm",   "Bosnia. Alone, surrounded, still here.",
           "Or Bosnia. Alone in Europe, far from any Muslim land, surrounded for centuries, through wars that tried to erase them. And still, today, Muslim. Respect to our Bosnian brothers."),
      (10, "rustig", "Spain: the faith left only when the people were forced out.",
           "There's only one place Islam truly disappeared. Spain. But not because people changed their minds. Muslims there were given three choices. Convert, leave, or die. They weren't persuaded, they were driven out. The faith only left when the people were forced to. Which proves the whole point. Where the people stayed, Islam stayed."),
      (11, "warm",   "You can't rewrite the truth.",
           "So when someone tells you this faith was forced on the world, remember. An accusation often turns out to be the exact opposite of the truth. You can rewrite the story. You cannot rewrite the truth. Rulers changed. Empires fell. Your people stayed. And that is something to be proud of."),
      (12, "warm",   "Umma United — know your history.",
           "Follow Umma United. Know your history, and you know yourself."),
    ],
    # Landen-groepen (Engelse namen; de engine kent ze via de kaart-asset + aliassen).
    "groups": [
      "group rome = Morocco, Algeria, Tunisia, Libya, Egypt, Syria, Lebanon, Turkey, Greece, Italy, Spain",
      "group europe_west = France, Spain, Italy, Portugal, Germany, Netherlands, Belgium",
      "group belt = Morocco, Algeria, Tunisia, Libya, Egypt, Saudi Arabia, Iraq, Iran, Pakistan, Bangladesh, Malaysia, Indonesia, Turkey, Syria, Jordan, Afghanistan, Uzbekistan",
      "group indonesia = Indonesia",
      "group bosnia = Bosnia and Herz.",
      "group spain = Spain",
    ],
    # Per scene: de TECHNIEK (mythe/kaart/statement) + die techniek z'n velden.
    # - mythe (scène 1): de leugen -> doorgestreept -> waarheid eronder (truth:).
    # - kaart (geo-scènes): fill/rule/view op de wereldkaart.
    # - statement (payoff/CTA): grote kernzin, woord-voor-woord.
    # Technieken GEMENGD: beeld (historische foto + zoom) waar een plek/sfeer telt, kaart waar
    # geografie de klap draagt, statement voor de payoffs, mythe voor de hook. SFX op de kantels.
    "map": [
      (1,  "Islam was spread by the sword.",                                  ["tech: mythe", "truth: Look who's really pointing.", "sfx: assets/ummaunited/sfx/sfx-zwaard.mp3"]),
      (2,  "Rome. This is what forcing a faith looks like.",                  ["tech: beeld", "img: beeld-rome.jpg", "sfx: assets/ummaunited/sfx/sfx-boom.mp3"]),
      (3,  "Forced faith dies with the power behind it.",                     ["tech: kaart", "rule: rome=cream", "view: mena"]),
      (4,  "It couldn't even hold on at home.",                               ["tech: kaart", "fill: europe_west=cream", "view: europe"]),
      (5,  "The locals chose it. Over generations.",                          ["tech: beeld", "img: beeld-kaart.jpg"]),
      (6,  "Indonesia. No army. Just trade.",                                 ["tech: beeld", "img: beeld-indonesie.jpg"]),
      (7,  "500 years of colonisation. No one converted.",                    ["tech: beeld", "img: beeld-kolonisatie.jpg", "sfx: assets/ummaunited/sfx/sfx-impact.mp3"]),
      (8,  "300 years of Dutch rule. Still Muslim.",                          ["tech: kaart", "fill: indonesia=orange", "rule: indonesia=ruler", "view: sea"]),
      (9,  "Bosnia. Alone, surrounded, still here.",                          ["tech: beeld", "img: beeld-bosnie.jpg"]),
      (10, "Spain: the faith left only when the people were forced out.",     ["tech: beeld", "img: beeld-spanje.jpg"]),
      (11, "You can't rewrite the truth.",                                    ["tech: statement", "sfx: assets/ummaunited/sfx/sfx-riser.mp3"]),
      (12, "Umma United — know your history.",                                ["tech: statement"]),
    ],
  },
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", required=True, help="verhaal-id, bv. sword")
    ap.add_argument("--voice", default="beide", choices=list(VOICES.keys()) + ["beide"],
                    help="man, vrouw, of beide (default: beide — zet allebei klaar om later te kiezen)")
    ap.add_argument("--only", type=int, default=0, help="alleen scene-nummer N opnieuw maken")
    ap.add_argument("--root", default=".", help="content-engine root")
    args = ap.parse_args()

    story = STORIES.get(args.story)
    if not story:
        print("onbekend verhaal:", args.story); sys.exit(1)

    voices = list(VOICES.keys()) if args.voice == "beide" else [args.voice]

    for voice in voices:
        model = VOICES[voice]
        print(f"\n=== STEM: {voice} ({model}) ===")
        # Stem zelf ophalen als die nog niet op de machine staat (geen handwerk voor de gebruiker).
        subprocess.run([sys.executable, "-m", "piper.download_voices", model],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # Elke stem in z'n EIGEN submap, zodat man en vrouw naast elkaar blijven staan en je
        # later in de content engine per filmpje kunt kiezen welke je gebruikt.
        outdir = os.path.join(args.root, "assets", "ummaunited", "voice", args.story, voice)
        os.makedirs(outdir, exist_ok=True)

        made = []
        for num, tone, screen, voiceline in story["scenes"]:
            if args.only and num != args.only:
                continue
            t = TONE[tone]
            wav = os.path.join(outdir, f"{num:02d}.wav")
            cmd = [sys.executable, "-m", "piper", "-m", model,
                   "--length-scale", str(t["length"]),
                   "--sentence-silence", str(t["sil"]),
                   "--noise-scale", str(t["noise"]),
                   "-f", wav]
            p = subprocess.run(cmd, input=voiceline.encode("utf-8"),
                               stderr=subprocess.PIPE)
            if p.returncode != 0:
                print(f"scene {num}: FOUT\n", p.stderr.decode(errors="ignore")[-400:]); continue
            made.append((num, tone, screen, wav))
            print(f"scene {num:02d} [{tone}] -> {wav}")

        # import-script per stem: stem + KAART-choreografie samen, klaar om in de studio te plakken.
        if not args.only:
            lines = [f"title: {story['title']}", "view: belt"]
            lines += story.get("groups", [])
            made_by_num = {num: wav for num, tone, screen, wav in made}
            for num, screen, mapspec in story["map"]:
                wav = made_by_num.get(num)
                parts = [f"scene {num}", screen]
                parts += mapspec            # fill/rule/view per scene
                if wav:
                    rel = os.path.relpath(wav, args.root).replace("\\", "/")
                    parts.append(f"voice: {rel}")
                lines.append(" | ".join(parts))
            imp = os.path.join(outdir, f"_import-{voice}.txt")
            with open(imp, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
            print("import-script:", imp)
        print(f"klaar: {len(made)} fragment(en), stem = {voice}")

if __name__ == "__main__":
    main()
