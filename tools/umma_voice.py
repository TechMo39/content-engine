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
import argparse, os, sys, wave, re, math, array, struct, json

# De twee gekozen Kokoro-stemmen (door Mo gekozen uit de test). a=Amerikaans, m=man, f=vrouw.
VOICES = {
    "man":   "am_michael",
    "vrouw": "af_bella",
}

# Kokoro ('github:v1.0:fp32') weigert een aanvraag boven ~510 tokens. Bij deze stem/taal ligt het
# aantal tokens dicht bij het aantal tekens, dus we houden een veilige grens op TEKENS aan en
# knippen een langere scene op zinsgrenzen in stukken die elk ruim onder de limiet blijven. De
# stukken worden daarna naadloos aan elkaar geplakt tot een scene-wav (zelfde stem/tempo), zodat
# de intonatie doorloopt als een verhaal.
MAX_CHARS = 490

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

def _split_for_tokens(text, max_chars=MAX_CHARS):
    # Knip op zinsgrenzen (. ! ?) en groepeer zinnen tot net onder max_chars, zodat elk stuk ruim
    # onder Kokoro's 510-token-limiet blijft. De naad valt zo altijd op een zin-einde.
    text = text.strip()
    if len(text) <= max_chars:
        return [text]
    sents = re.split(r'(?<=[.!?])\s+', text)
    chunks, cur = [], ""
    for s in sents:
        s = s.strip()
        if not s:
            continue
        if cur and len(cur) + 1 + len(s) > max_chars:
            chunks.append(cur); cur = s
        else:
            cur = (cur + " " + s).strip() if cur else s
    if cur:
        chunks.append(cur)
    return chunks or [text]

def _read_wav_parts(path):
    # (bytes, offset-van-data-payload, lengte-van-data) via RIFF-logica (werkt op float32-wav).
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        return data, None, None
    i = 12
    while i + 8 <= len(data):
        cid = bytes(data[i:i+4]); clen = struct.unpack_from("<I", data, i+4)[0]
        if cid == b"data":
            return data, i + 8, clen
        i += 8 + clen + (clen & 1)
    return data, None, None

def _concat_wavs(paths, out_wav):
    # Plak meerdere wavs (zelfde fmt) aan elkaar: header van het eerste stuk, payloads achter
    # elkaar, lengte-velden (data-chunk + RIFF) bijwerken.
    base, doff, dlen = _read_wav_parts(paths[0])
    if doff is None:
        with open(paths[0], "rb") as f, open(out_wav, "wb") as g:
            g.write(f.read())
        return
    payloads = [bytes(base[doff:doff + dlen])]
    for p in paths[1:]:
        d, o, l = _read_wav_parts(p)
        if o is not None:
            payloads.append(bytes(d[o:o + l]))
    allpay = b"".join(payloads)
    header = bytearray(base[:doff])
    struct.pack_into("<I", header, doff - 4, len(allpay))
    new = header + allpay
    struct.pack_into("<I", new, 4, len(new) - 8)
    with open(out_wav, "wb") as f:
        f.write(new)

def _synthesize(voice_model, text, speed, sil, out_wav):
    synth = _get_synth(voice_model, speed)
    chunks = _split_for_tokens(text)
    if len(chunks) == 1:
        rendered = synth.synthesize_text(chunks[0], language="en-us", voice=voice_model)
        rendered.save_wav(out_wav)
    else:
        parts = []
        for idx, ch in enumerate(chunks):
            tmp = f"{out_wav}.part{idx}.wav"
            r = synth.synthesize_text(ch, language="en-us", voice=voice_model)
            r.save_wav(tmp)
            parts.append(tmp)
        _concat_wavs(parts, out_wav)
        for p in parts:
            try: os.remove(p)
            except Exception: pass
    if sil and sil > 0:
        _append_silence(out_wav, sil)

# ---------------------------------------------------------------------------------------------
# PER-ZIN-MEETROOSTER (fase 1). De scene wordt als EEN vloeiende alinea ingesproken (intonatie
# blijft heel), en daarna knippen we die opname in zinnen met EXACTE tijden. Methode, geverifieerd
# op Mo's echte stem: we detecteren de stiltes in de opname, schatten per zin de lengte uit de
# lettergrepen, en leggen de knip op de echte pauze die het dichtst bij die schatting ligt. Zo
# raakt geen zin kwijt, ook niet bij korte zinnen zonder hoorbare pauze. Deze tijden zijn de
# ruggengraat voor de ondertiteling en voor het plaatsen van beeld.
def _load_f32_wav(path):
    d = open(path, "rb").read()
    i = 12; doff = dlen = None
    while i + 8 <= len(d):
        cid = d[i:i+4]; clen = struct.unpack_from("<I", d, i+4)[0]
        if cid == b"data": doff = i+8; dlen = clen
        i += 8 + clen + (clen & 1)
    if doff is None:
        return array.array("f"), 24000
    sr = struct.unpack_from("<I", d, 24)[0] or 24000
    sm = array.array("f"); sm.frombytes(d[doff:doff+dlen])
    return sm, sr

def _rms_env(sm, sr, winsec=0.02):
    win = max(1, int(winsec*sr)); env = []
    for s in range(0, len(sm), win):
        c = sm[s:s+win]
        if not c: break
        env.append((s/sr, math.sqrt(sum(x*x for x in c)/len(c))))
    return env, win/sr

def _detect_gaps(env, winsec, rel=0.06, minlen=0.10):
    peak = max((e for _, e in env), default=0.0) or 1e-9
    thr = peak*rel
    runs = []; j = 0; n = len(env)
    while j < n:
        if env[j][1] < thr:
            k = j
            while k < n and env[k][1] < thr: k += 1
            st = env[j][0]; ln = (k-j)*winsec
            runs.append((st+ln/2, st, ln)); j = k
        else:
            j += 1
    return [(c, st, ln) for (c, st, ln) in runs if ln >= minlen]

def _sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s.strip()]

def _syllables(w):
    w = w.lower(); v = "aeiouy"; c = 0; prev = False
    for ch in w:
        isv = ch in v
        if isv and not prev: c += 1
        prev = isv
    if w.endswith("e") and c > 1: c -= 1
    return max(1, c)

def _sent_weight(s):
    base = sum(_syllables(w) for w in re.findall(r"[a-zA-Z']+", s))
    base += 0.6*len(re.findall(r"[,;:]", s))   # interne pauzes kosten tijd
    base += 0.9                                 # zin-eind-pauze
    return base

def split_sentences(wav_path, text, snap_win=0.35):
    # Geef [(start, dur) per zin] (tijden binnen de wav) + speech_start/speech_end. Robuust ook als
    # er weinig pauzes zijn: de syllabe-schatting bepaalt de verwachte knip, en als er een echte
    # stilte dichtbij is snappen we daarnaartoe (netter), anders houden we de schatting. Altijd
    # oplopend, nooit een zin kwijt.
    sm, sr = _load_f32_wav(wav_path)
    dur = len(sm)/sr if sr else 0.0
    sents = _sentences(text); N = len(sents)
    if dur <= 0 or N == 0:
        return [(0.0, round(dur, 3))], 0.0, round(dur, 3)
    env, winsec = _rms_env(sm, sr)
    gaps = _detect_gaps(env, winsec)
    sp_start, sp_end = 0.0, dur
    if gaps and gaps[0][1] < 0.30: sp_start = gaps[0][1] + gaps[0][2]
    if gaps and (gaps[-1][1] + gaps[-1][2]) >= dur - 0.10: sp_end = gaps[-1][1]
    if N <= 1:
        return [(round(sp_start, 3), round(sp_end - sp_start, 3))], round(sp_start, 3), round(sp_end, 3)
    w = [_sent_weight(s) for s in sents]; tot = sum(w) or 1.0
    cum = 0.0; exp = []
    for ww in w[:-1]:
        cum += ww; exp.append(sp_start + (sp_end - sp_start)*cum/tot)
    cent = sorted(c for (c, st, ln) in gaps if sp_start < c < sp_end)
    bounds = []; prev = sp_start; used = set()
    for k, e in enumerate(exp):
        best = None; bestd = snap_win
        for ci, c in enumerate(cent):
            if ci in used or c <= prev + 0.15: continue
            dd = abs(c - e)
            if dd < bestd: bestd = dd; best = (ci, c)
        if best is not None:
            used.add(best[0]); b = best[1]
        else:
            b = max(e, prev + 0.15)
        b = min(b, sp_end - 0.15*(N - 1 - k))
        bounds.append(b); prev = b
    cuts = [sp_start] + bounds + [sp_end]
    segs = [(round(cuts[i], 3), round(cuts[i+1] - cuts[i], 3)) for i in range(N)]
    return segs, round(sp_start, 3), round(sp_end, 3)

def _wav_duration(wav_path):
    # exacte duur (seconden) van een wav, OOK als het een float32-wav van Kokoro is (die de
    # wave-module niet kan lezen). We lezen byteRate (offset 28) en de lengte van de data-chunk
    # en delen: duur = data_bytes / byteRate. Dit is dezelfde RIFF-logica als _append_silence.
    try:
        import struct
        with open(wav_path, "rb") as f:
            data = f.read()
        if data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
            return 0.0
        byte_rate = struct.unpack_from("<I", data, 28)[0]
        if byte_rate <= 0:
            return 0.0
        i = 12
        while i + 8 <= len(data):
            cid = data[i:i+4]; clen = struct.unpack_from("<I", data, i+4)[0]
            if cid == b"data":
                return round(clen / byte_rate, 3)
            i += 8 + clen + (clen & 1)
        return 0.0
    except Exception:
        return 0.0

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
  # LANGE VIDEO (8-10 min) — ÉÉN doorlopend verhaal, 16 verhaalscènes. GEEN twee delen meer.
  # Per scène: nr, toon, korte on-screen kernzin (alleen bij statement/mythe groot in beeld),
  # en de VOLLE gesproken zin (= ook de meelopende ondertitel). GEEN m-dashes in de tekst.
  "sword": {
    "title": "Spread by the sword?",
    "scenes": [
      (1,  "hook",   "Spread by the sword?",
           "You have heard it your whole life. Islam was spread by the sword. Convert, or die. And underneath that sentence sits a rule they are very proud of. A faith that is forced on people never lasts. The moment the pressure lifts, the people let it go. Remember that rule. Because today we are going to follow it all the way to the end. And it does not lead where they think it does."),
      (2,  "nadruk", "The rule is true.",
           "I am not going to tell you the rule is wrong. The rule is true. A faith held up by force really does fall the moment the force is gone. So the only honest question left is this one. In all of history, which faith was actually spread that way? Not which one was accused of it. Which one was really built on the blade. Let us go and look."),
      (3,  "rustig", "Go back to Rome.",
           "Go back to Rome. For three hundred years Rome ruled the lands around the Mediterranean. Syria, Egypt, across North Africa to the edge of Morocco, up into Anatolia. And once the empire took one faith as its own, that faith became the law. Not an invitation. A command, carried by the power of the state."),
      (4,  "nadruk", "Baptism, or ruin.",
           "And if your belief was not theirs, you learned what that meant. The Jews knew it first. Taxed, pushed out, driven from city after city, blamed for whatever the empire needed blamed. And they were not alone. Anyone who would not take the official faith, other Christians, old believers, whole peoples, lived under the same shadow. Baptism, or ruin. This is what a forced faith actually looks like. Not a story. A boot."),
      (5,  "rustig", "Then the Muslims came.",
           "Now hold that picture, because here is the part they never tell you. When the Muslims came to those same lands, Syria, Egypt, across to Morocco, the people did not meet them as conquerors to be feared. For many of them, it was relief. The weight they had carried under Rome, the taxes for believing wrong, the choice of convert or suffer, that weight lifted. The Jews who had been hunted found, under Muslim rule, a place they could live, pray, and breathe. Ask the Jews. Read the history. It is written down."),
      (6,  "warm",   "No one was forced.",
           "And here is why it felt like relief. Under Muslim rule, you were not forced to become Muslim. The Christian who wanted to stay Christian, stayed Christian. The Jew kept his synagogue. The churches stayed open. The law was clear. Faith is not something you hammer into a person. No human can place belief in a heart. Guidance is from Allah alone. So the Muslims did not try to do Allah's work with a sword. They carried the message, lived it honestly, dealt justly, and left the hearts to Allah."),
      (7,  "rustig", "For centuries.",
           "And so it stood. Not for a year. Not for a generation. For centuries. These lands were ruled by Muslims for hundreds and hundreds of years. Long enough for empires to rise and fall. Long enough that if Islam were truly nothing but a sword held to the throat, the proof would be everywhere. Instead, over all those generations, people came to it freely, at their own pace, family by family, because of what they saw, not because of what they were threatened with."),
      (8,  "nadruk", "Then came the test.",
           "Then, about a thousand years later, the tide turned the other way. Now it was Europe that marched out. And this time the sword was real, and it was aimed straight at the faith. It began with Spain. Then the British, the Dutch, the French. Across North Africa. Into Indonesia. Into the Balkans, into Bosnia. For centuries their flags flew over the Muslim world. And here, finally, we can test the rule. Their own rule. If a forced faith cannot last, then a faith crushed by five hundred years of empire should have nothing left."),
      (9,  "nadruk", "They tried everything.",
           "And do not imagine they were gentle. Do not tell yourself they simply ruled and let people be. They tried to take the faith out. They killed. They humiliated. They outlawed the language of the Quran in the street and the school. They turned brother against brother so a people could not stand together. Everything an empire can do to erase a thing, they did it. This was the sword, finally, for real. So, did it work?"),
      (10, "warm",   "It held.",
           "No. When the empires finally packed up and left, after everything, the faith was still there. Indonesia, after centuries of foreign rule, walked into independence and remained what it was, the largest Muslim nation on earth. Bosnia, surrounded, hunted, marked for erasure in the very heart of Europe, still standing, still praying, still here. Across North Africa, independence came after the Second World War, and the people who emerged were the same people who went in."),
      (11, "rustig", "No army takes a heart.",
           "Look at it plainly. Count the believers in those lands before the colonisers came. Count them after they left. The number barely moves. Hundreds of years of the most powerful empires in history, with every weapon and every school and every law turned against one single thing, and they could not shift it. Because you cannot conquer what does not live in the land. It lived in the heart. And no army has ever taken a heart."),
      (12, "nadruk", "The wrong religion.",
           "So let us go back to their rule. A forced faith never lasts. The moment the force is gone, the people let it go. They are right. That rule is true. They just pointed it at the wrong religion. Because the faith that was forced, in Rome, across Europe, convert or be ruined, look at those same lands today. The churches stand empty. A whole continent has quietly walked away from God."),
      (13, "nadruk", "A forced faith leaves a wound.",
           "And ask yourself honestly why. It is not an accident. When a faith is pressed onto people by force, generation after generation, it leaves a wound. And a wounded people do not just leave one faith. They grow a quiet aversion to faith itself. That is what you see in Europe now. Not only an empty church. A reflex of pushing religion away, because somewhere in their history religion arrived as a hand around the throat. Their rule came true, in their own home, on their own faith. That is not something to laugh at. It is the proof."),
      (14, "warm",   "Two opposite endings.",
           "And ours? Ours was never forced. It came as relief after cruelty. It was chosen freely, over centuries, in lands where you were free to refuse it. And when the real sword finally came, not to spread it, but to destroy it, it did not fall. They forced their faith and lost it. We were given ours freely, and we kept it. The same rule. Two opposite endings. That is the whole story."),
      (15, "warm",   "You are the proof.",
           "So the next time someone tells you your faith was spread by the sword, you do not need to raise your voice. You know the history now. You know whose hand actually held the blade, and what it cost them. The truth never needed a sword. It only ever needed to be seen. That is why, after Rome, after empires, after five hundred years of everything they could throw at it, we are still here. And every single time you rise to pray, you are the living proof that the truth never needed a sword."),
      (16, "warm",   "The truth runs straight.",
           "This is what we do here. We show you the other side of the story, the one you were never handed. Because a lie has to travel in crooked lines. It has to bend the facts, hide half of them, and hope you never check. The truth does not need any of that. The truth runs straight. So if you are tired of being told to feel small about who you are, stay with us. Follow Umma United, and hold your head high."),
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
STORIES["sword"]["groups"] = _GROUPS
# Choreografie per deel (scene-nr binnen DAT deel). Technieken gemengd, SFX op de kantels.
# tech: beeld = video/foto-achtergrond (uit assets/ummaunited/video/). vid: = video, img: = foto.
# tech: kaart/statement/mythe = getekend (geen media nodig).
# Beeld per scène afgestemd op het NIEUWE script (trots, niet aanvallend).
# LANGE VIDEO — 16 scènes. BEELD NOG LEEG (getekende basis): echte video/foto bepalen we PAS
# na het meten van de stem (Blok C), dan instrueert Claude Mo gericht per scène. Hier staat nu
# alleen de veilige getekende techniek die bij de tekst past, zodat de keten compleet is en de
# kaart de tekst nooit tegenspreekt. SFX ook nog niet gekoppeld (gebeurt na meting).
STORIES["sword"]["map"] = [
  (1,  "Spread by the sword?",            ["tech: mythe", "truth: Which faith was really built on the blade?"]),
  (2,  "The rule is true.",               ["tech: statement"]),
  (3,  "Rome ruled it all.",              ["tech: kaart", "fill: romemoslim=red", "view: mena"]),
  (4,  "Baptism, or ruin.",               ["tech: statement"]),
  (5,  "Then the Muslims came.",          ["tech: kaart", "fill: romemoslim=cream", "view: mena"]),
  (6,  "No one was forced.",              ["tech: statement"]),
  (7,  "For centuries.",                  ["tech: kaart", "fill: romemoslim=cream", "view: mena"]),
  (8,  "Then came the test.",             ["tech: statement", "kick: The test"]),
  (9,  "They tried everything.",          ["tech: statement"]),
  (10, "It held.",                        ["tech: kaart", "fill: indonesia=cream; bosnia=cream; romemoslim=cream", "view: belt"]),
  (11, "No army takes a heart.",          ["tech: statement"]),
  (12, "The wrong religion.",             ["tech: kaart", "fill: europe_west=red", "view: europe"]),
  (13, "A forced faith leaves a wound.",  ["tech: statement"]),
  (14, "Two opposite endings.",           ["tech: statement"]),
  (15, "You are the proof.",              ["tech: statement"]),
  (16, "The truth runs straight.",        ["tech: statement", "kick: Umma United"]),
]

def build_story(story_id, voice, root, only=0):
    story = STORIES[story_id]
    model = VOICES[voice]
    outdir = os.path.join(root, "assets", "ummaunited", "voice", story_id, voice)
    os.makedirs(outdir, exist_ok=True)
    made = []
    durs = {}   # scene-nr -> gemeten duur (sec) van de voice-wav (incl. aangeplakte stilte)
    sents_by = {}  # scene-nr -> per-zin [(start, dur)] + speech-grenzen (het meetrooster)
    for num, tone, screen, voiceline in story["scenes"]:
        if only and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        try:
            _synthesize(model, voiceline, t["speed"], t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        d = _wav_duration(wav)
        durs[num] = d
        # knip de vloeiende alinea in zinnen met exacte tijden (ruggengraat voor ondertitel + beeld)
        try:
            segs, sp0, sp1 = split_sentences(wav, voiceline)
        except Exception as e:
            segs, sp0, sp1 = None, 0.0, d
            print(f"  scene {num}: zin-knip overgeslagen ({e})")
        sents_by[num] = (segs, sp0, sp1)
        nz = len(segs) if segs else 0
        made.append((num, wav)); print(f"  scene {num:02d} [{tone}] {d:6.2f}s, {nz} zin(nen) -> {wav}")
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

        # DUUR-METING wegschrijven: de spil van de timeline. Per scène de EXACTE gemeten duur,
        # plus toon en de volle zin, zodat Claude hiermee de timeline kan vullen en gericht het
        # beeld + de sound effects per scène kan bepalen (lengte >= zinsduur).
        tone_by = {num: tone for (num, tone, screen, voiceline) in story["scenes"]}
        line_by = {num: voiceline for (num, tone, screen, voiceline) in story["scenes"]}
        total = round(sum(durs.get(n, 0.0) for n in durs), 2)
        meta = {
            "story": story_id,
            "voice": voice,
            "title": story["title"],
            "total_seconds": total,
            "total_mmss": f"{int(total)//60}:{int(total)%60:02d}",
            "scenes": [
                {"scene": num, "tone": tone_by.get(num, ""),
                 "seconds": durs.get(num, 0.0), "line": line_by.get(num, "")}
                for num, _wav in made
            ],
        }
        dj = os.path.join(outdir, "_durations.json")
        with open(dj, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"  duur-meting: {dj}  (totaal {meta['total_mmss']})")

        # GEDEELDE TIJDLIJN (fase 1): de ene databron die straks preview EN eindrender voedt.
        # Per scene: absolute starttijd + duur in de hele video, plus het per-zin-meetrooster
        # (start/dur binnen de scene-wav). Beeld-beats en effecten worden hier later in gevuld.
        tl_scenes = []
        abs_t = 0.0
        for num, _wav in made:
            segs, sp0, sp1 = sents_by.get(num, (None, 0.0, durs.get(num, 0.0)))
            lines = _sentences(line_by.get(num, ""))
            sentences = []
            if segs:
                for i, (st, dd) in enumerate(segs):
                    sentences.append({
                        "i": i,
                        "text": lines[i] if i < len(lines) else "",
                        "start": st,          # binnen de scene-wav
                        "dur": dd,
                        "abs_start": round(abs_t + st, 3),   # in de hele video
                    })
            sc = {
                "scene": num,
                "tone": tone_by.get(num, ""),
                "wav": os.path.relpath(by[num], root).replace("\\", "/") if by.get(num) else "",
                "start": round(abs_t, 3),            # absolute start in de video
                "dur": round(durs.get(num, 0.0), 3), # volle scene-duur (incl. adem-stilte)
                "speech_start": sp0,
                "speech_end": sp1,
                "sentences": sentences,
                "beats": [],   # beeld-beats (groepen zinnen); vult Claude later
                "sfx": [],     # effect-punten; vult Claude later
            }
            tl_scenes.append(sc)
            abs_t += durs.get(num, 0.0)
        timeline = {
            "story": story_id,
            "voice": voice,
            "title": story["title"],
            "total_seconds": round(abs_t, 3),
            "total_mmss": f"{int(abs_t)//60}:{int(abs_t)%60:02d}",
            "scenes": tl_scenes,
        }
        tj = os.path.join(outdir, "_timeline.json")
        with open(tj, "w", encoding="utf-8") as f:
            json.dump(timeline, f, ensure_ascii=False, indent=2)
        print(f"  tijdlijn:     {tj}  ({len(tl_scenes)} scenes, {sum(len(s['sentences']) for s in tl_scenes)} zinnen)")
    print(f"  klaar: {len(made)} fragment(en)")

def _ensure_espeak():
    # Kokoro valt voor woorden buiten zijn woordenboek (bv. "Quran", namen, plaatsnamen) terug op
    # eSpeak NG. Staat die niet op PATH, dan zoeken we de standaard Windows-installatieplek en
    # wijzen we er zelf naar, zodat Mo nooit een variabele hoeft te zetten. eSpeak NG moet wel
    # eenmalig geinstalleerd zijn (winget install eSpeak-NG.eSpeak-NG).
    if os.environ.get("ESPEAKNG_RUNTIME_EXECUTABLE"):
        return
    for c in (r"C:\Program Files\eSpeak NG\espeak-ng.exe",
              r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe"):
        if os.path.isfile(c):
            os.environ["ESPEAKNG_RUNTIME_EXECUTABLE"] = c
            os.environ["PATH"] = os.path.dirname(c) + os.pathsep + os.environ.get("PATH", "")
            return

def main():
    _ensure_espeak()
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword", help="sword (het lange verhaal, default)")
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

    stories = ["sword"] if args.story in ("all", "sword") else [args.story]
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
