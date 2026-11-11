#!/usr/bin/env python3
# umma_voice.py — genereert per scene een voice-over-fragment met KOKORO (lokaal, CPU, geen GPU),
# met de TOON per scene (rustig / nadruk / warm), zodat de stem klopt met wat er gezegd wordt.
# Draait LOKAAL op Mo's laptop. Schrijft assets/channels/channel1/voice/<story>/<stem>/<nn>.wav + een
# import-script met de voice-paden. (Piper is vervangen door Kokoro; klinkt veel natuurlijker.)
#
# Eenmalig installeren:  pip install "pykokoro[cpu]"
# Gebruik (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_voice.py                 # beide delen, beide stemmen
#   python tools/channel_voice.py --voice man      # alleen de mannenstem
#   python tools/channel_voice.py --only 3         # alleen scene 3 opnieuw
#   python tools/channel_voice.py --story fitra --voice man --format 16:9   # NIEUW project
#   python tools/channel_voice.py --story fitra --voice man --format 9:16   # de afgeleide short
#
# PROJECT = <story>/<voice>. Elk project krijgt een eigen map en een eigen _timeline.json, dus
# een nieuw project overschrijft NOOIT een bestaand project. Het FORMAAT (16:9 lang / 9:16 short)
# wordt in de tijdlijn opgeslagen zodat de studio het per project onthoudt.
#
# De TOON per scene staat in STORIES hieronder. Een zin die niet goed valt: alleen die regel
# wijzigen en opnieuw draaien met --only <nn>.
import argparse, os, sys, wave, re, math, array, struct, json

# De twee gekozen Kokoro-stemmen (door Mo gekozen uit de test). a=Amerikaans, m=man, f=vrouw.
VOICES = {
    "man":   "bm_george",
    "vrouw": "af_bella",
}

# ---------------------------------------------------------------------------------------------
# FONETISCHE LAAG. De STEM leest een fonetische versie van de tekst, zodat lastige woorden goed
# klinken (Kokoro sprak bv. "a" uit als "AY", en "Allah"/"Quran" raar). De ONDERTITEL blijft de
# gewone Engelse tekst; het fonetische is puur intern en komt nergens in beeld. We vervangen alleen
# HELE woorden, met gelijk aantal lettergrepen, zodat de zin-timing exact gelijk blijft.
# Nieuwe probleemwoorden fix je door één regel aan PRON toe te voegen.
ARTICLE_FIX = True   # lidwoord "a" -> "uh" (anders zegt Kokoro "AY"); zet op False als het niet bevalt
PRON = {
    "Allah": "Allaah",   # ah-LAAH
    "Quran": "Kuraan",   # koe-RAAN
    "Umar":  "Oomar",    # OE-mar
}
_PRON_L = {k.lower(): v for k, v in PRON.items()}
def _match_case(src, repl):
    if src.isupper(): return repl.upper()
    if src[:1].isupper(): return repl[:1].upper() + repl[1:]
    return repl
def to_phonetic(text):
    def _rep(m):
        w = m.group(0); v = _PRON_L.get(w.lower())
        return _match_case(w, v) if v else w
    out = re.sub(r"[A-Za-z']+", _rep, text)
    if ARTICLE_FIX:
        out = re.sub(r"\ba\b", "uh", out)
        out = re.sub(r"\bA\b", "Uh", out)
    return out

# Kokoro ('github:v1.0:fp32') weigert een aanvraag boven ~510 tokens. Bij deze stem/taal ligt het
# aantal tokens dicht bij het aantal tekens, dus we houden een veilige grens op TEKENS aan en
# knippen een langere scene op zinsgrenzen in stukken die elk ruim onder de limiet blijven. De
# stukken worden daarna naadloos aan elkaar geplakt tot een scene-wav (zelfde stem/tempo), zodat
# de intonatie doorloopt als een verhaal.
MAX_CHARS = 490

# Stilte VOORAAN de intro-wav (seconden): het logo staat zo eerst rustig in beeld voordat de stem
# begint. Pas dit getal aan voor een langere/kortere logo-hold aan het begin.
LEAD_SILENCE = 3.0

# Toon-presets voor Kokoro: speed (tempo, <1 = trager/zwaarder, >1 = sneller) en sil = extra
# STILTE (seconden) die we na het fragment aanplakken, zodat een gedachte kan landen (adem,
# niet bam-bam-bam). De engine voegt tussen scenes ook nog een adempauze toe (VOICE_PAD).
TONE = {
    "rustig": dict(speed=0.79, sil=0.45),   # verhalend, iets vlotter
    "nadruk": dict(speed=0.75, sil=0.70),   # statement, zwaarder, laat de klap hangen
    "warm":   dict(speed=0.75, sil=0.85),   # payoff, rustig, laat het bezinken
    "hook":   dict(speed=0.77, sil=0.55),   # haak
    "intro":  dict(speed=0.79, sil=0.60),   # opening
    "outro":  dict(speed=0.77, sil=0.80),   # afsluiter, met lucht
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

def _sentence_breaks(text):
    # RUST TUSSEN ZINNEN: zet een regeleinde NA elke punt/uitroep/vraagteken, zodat Kokoro daar
    # ZELF ademt (in de juiste woorden, geen geknipt geluid). De stem doet de pauze, wij knippen
    # niets in de opname. Dubbele enter = iets langere adem.
    return re.sub(r'([.!?])\s+', r'\1\n\n', text.strip())

def _synthesize(voice_model, text, speed, sil, out_wav):
    synth = _get_synth(voice_model, speed)
    text = _sentence_breaks(text)   # adem na elke zin via regeleindes (natuurlijke pauze)
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

def _prepend_silence(wav_path, seconds):
    # Plak stilte VOORAAN de wav (vóór de eerste zin). Gebruikt voor de intro: zo staat het logo
    # een paar seconden rustig in beeld voordat de stem begint. Zelfde RIFF-logica als _append_silence,
    # maar de stilte komt direct NA de data-chunk-header (vóór de audio) i.p.v. aan het eind.
    try:
        import struct
        with open(wav_path, "rb") as f:
            data = bytearray(f.read())
        if data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
            return
        byte_rate = struct.unpack_from("<I", data, 28)[0]
        if byte_rate <= 0:
            return
        i = 12; data_off = None; data_len = None
        while i + 8 <= len(data):
            cid = bytes(data[i:i+4]); clen = struct.unpack_from("<I", data, i+4)[0]
            if cid == b"data":
                data_off = i + 8; data_len = clen; break
            i += 8 + clen + (clen & 1)
        if data_off is None:
            return
        block_align = struct.unpack_from("<H", data, 32)[0] or 1
        nbytes = int(byte_rate * seconds); nbytes -= (nbytes % block_align)
        if nbytes <= 0:
            return
        silence = b"\x00" * nbytes
        # stilte VOOR de audio-data invoegen (bij data_off), audio schuift op
        new = data[:data_off] + silence + data[data_off:]
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
  # LANGE VIDEO — ÉÉN doorlopend verhaal "Spread by the sword?" (herschreven 4 nov, door Mo
  # goedgekeurd). Scène 0 = merk-intro met missie + CTA; 1-17 = het verhaal; 18 = outro + CTA.
  # Per scène: nr, toon, korte on-screen kernzin, en de VOLLE gesproken zin (= de ondertitel).
  # De STEM leest een FONETISCHE versie hiervan (zie to_phonetic); de ondertitel blijft deze tekst.
  # GEEN m-dashes in de tekst.
  "sword": {
    "title": "Spread by the sword?",
    "scenes": [
      (0,  "intro",  "Umma United",
           "Welcome to Umma United. Here is what we do on this channel. All your life you have been handed stories about who you are and where you come from, told so often and so confidently that they begin to feel like facts set in stone. We take those stories down, and we hold them up against the real history, the dates, the places, the record that was actually left behind. And more often than not, they do not survive the light. If that is the kind of thing you want more of, subscribe before we begin. Now, let us start with the biggest story of them all."),
      (1,  "hook",   "Spread by the sword?",
           "There is one accusation thrown at Islam more than any other. That it was never truly chosen. That it was forced onto the world at the edge of a sword. Convert, or die. You hear it in classrooms, in documentaries, in half the arguments online. So tonight we are not going to get angry, and we are not going to get defensive. We are simply going to test it, with real history, real dates, and real places. And then the truth can speak for itself."),
      (2,  "nadruk", "Here is the test.",
           "Here is the test, and it is a fair one. A faith that is only held up by force has a single weakness. The moment that force is gone, it falls. If people never truly believed it, they do not wait a generation to walk away. They let go the instant no one is standing over them anymore. So we do not need to raise our voices. We only need to watch what force actually does to belief. What quietly collapses the second the pressure lifts, and what refuses to break even with the full weight of an empire bearing down on it. We are going to see both. First in Rome, and then in the empires of Europe."),
      (3,  "rustig", "Start with Rome.",
           "Start with Rome. This was not some local kingdom. It was the superpower of its age, ruling tens of millions of people across three continents, from the cold edge of Britain to the sands of Arabia. And in the year 380, the emperor Theodosius signed a decree that bound that entire machine to one single religion. From that day on, one form of Christianity was the law of the state, and every other belief was, quite literally, a crime. Temples were pulled down. Other Christians were hunted as heretics. And for the next two and a half centuries, across Syria, across Egypt, and all along North Africa, you believed what the empire ordered you to believe, or you paid for it."),
      (4,  "nadruk", "A world of force.",
           "And no one paid more dearly than the Jews. They were taxed for their faith and shut out of public life, and in Jerusalem, their own holy city, they were forbidden from even living there at all. Whole communities survived one new law away from losing everything. And anyone else whose belief did not match the emperor's lived under that very same shadow. Hold on to this picture, because it is the world that came before. A world where the ruler alone decided what your soul was permitted to believe."),
      (5,  "nadruk", "Two empires fall.",
           "Now watch what replaced it. In the 630s, within a single generation, the Muslims did something the world thought impossible. They did not face down one superpower. They faced two. They took the Christian Roman east, and alongside it they brought down the entire Persian empire, the other great power of the age, with its own state religion enforced from the top. Two empires that had divided the known world between them, now in the hands of the believers. And it is right here, at the very height of that power, that the whole accusation quietly falls apart."),
      (6,  "warm",   "They forced no one.",
           "Because the Muslims forced no one. The Christian kept his church. The Jew kept his synagogue. The Zoroastrian of Persia kept his fire. Every one of them stayed free to worship exactly as he always had, his place of prayer protected, and he was not even asked to take up a weapon for the state. Look at what Umar, may Allah be pleased with him, did the day he took Jerusalem. He walked into a city that had banned Jews for close to five hundred years, and he lifted that ban and invited them to come home. The conqueror arrived and undid the cruelty of the ones who came before him. And this was not the good manners of one unusual man. This was what the faith itself demanded of them. Because Islam is clear that no one can place belief inside another person's heart. Guidance comes from Allah alone. So the task of a believer was only ever to carry the message, to rule with justice and not with injustice, and to leave the hearts to the One who made them."),
      (7,  "nadruk", "The real question.",
           "So now ask the real question, the one that takes the whole accusation apart. If Islam was spread by forcing people to convert, the conversions would have come at once. Convert this week, or die. But that is the opposite of what the record shows. For a long time after the conquests, most people in those lands stayed Christian, stayed Jewish, stayed Zoroastrian, and they were left in peace to do exactly that. They had been handed something they never had under Rome or Persia, the simple freedom to choose. And only after living inside that freedom did they begin, slowly, over generations, to turn to Islam on their own, until in the end it became the faith of the overwhelming majority. That is the fingerprint of a faith that is chosen. The heart has to move first, and that takes time. Now set it beside the faith that Rome truly did force. The day Rome's power left those lands, that faith did not hold on for generations. It fell away almost at once, because for so many it had never really been theirs to begin with."),
      (8,  "rustig", "A thousand years.",
           "And what the believers built did not last for a season. It stood for well over a thousand years. Long enough, many times over, for a forced faith to crack and crumble into nothing. Instead it only grew deeper, generation after generation, held up by no army at all, but by people who had come to it with open eyes and chosen it as their own."),
      (9,  "nadruk", "The test returns.",
           "And then, almost a thousand years later, the test arrived again, this time from the opposite direction. Starting in the 1500s, and rising over the next four hundred years, it was Europe's turn to sail out across the world. The Portuguese and the Spanish, then the Dutch, the French, and the British. They took North Africa. They took Indonesia. They took the Muslim lands of the Balkans. And this time the sword was no figure of speech. It was real, it was foreign, and a great deal of it was pointed straight at the faith itself."),
      (10, "nadruk", "They tried everything.",
           "And they did not come to govern gently and leave people to their prayers. In Algeria, France turned the great mosques into cathedrals and seized the endowments that had kept the faith running for centuries. The language of the Quran was driven out of the schools. Rulers set community against community so that a people could never again stand as one. Everything an empire is capable of doing to tear a faith out by its roots, they tried, with real power, for generation after generation. So if a forced faith cannot survive, then this one, crushed for centuries under the most advanced empires on earth, should have been wiped from the map."),
      (11, "warm",   "It held.",
           "It was not. When the Europeans finally lowered their flags and sailed home after the Second World War, the faith was still standing exactly where they had first found it. Indonesia walked out of centuries of Dutch rule and is today the largest Muslim nation on earth, with nearly nine in ten of its people Muslim. Bosnia, surrounded in the very heart of Europe, is still Muslim and still praying. And all along North Africa, the people who walked out into freedom carried the very same faith they had carried into occupation."),
      (12, "rustig", "No army takes a heart.",
           "So line it all up, and the verdict is almost embarrassing in how clear it is. Count the believers in those lands before the colonisers ever arrived, and count them again the day they left. The number barely moves. The most powerful empires the world had ever built, with everything they owned aimed at one single thing, and they could not shift it an inch. Because you cannot conquer what never lived in the soil to begin with. It lived in the heart. And no army in all of history has ever taken a heart."),
      (13, "nadruk", "The wrong religion.",
           "So let us return, one last time, to the rule we began with. A faith held up by force cannot last. The moment the force is gone, the people let it go. It is completely true. They had simply aimed it at the wrong religion all along. Because there was a faith in this story that truly was forced, first by Rome and then across the whole of Europe. Convert, or be ruined. And if you want to see how that story ends, you do not need a history book. Walk through Europe today and look at its great cathedrals. They stand almost empty."),
      (14, "nadruk", "A wound.",
           "And it is worth asking, with no trace of mockery in it, why that is. When a faith is pressed onto people by force, through generation after generation, it does not simply fade away cleanly. It leaves a wound. And a wounded people do not only turn away from the one faith that was forced upon them. Given enough time, they grow wary of faith itself. That may well be a part of what Europe is living through now, that reflex to push religion out of sight, because somewhere far back in its memory, religion first arrived as a hand closing around the throat. Their own rule came true, in their own home, upon their own faith. That is their history to carry, and it was never ours."),
      (15, "warm",   "Ruled with justice.",
           "Because ours was never forced upon a single soul. Our forefathers walked into the two greatest empires on the face of the earth, and where those empires had ruled through cruelty, our forefathers ruled through justice. They freed the hunted. They guarded the churches, the synagogues, and the fire temples of the very people they had just defeated. And it was that justice, and not any blade, that finally opened the hearts. They forced their faith, and in the end they lost it. We offered ours with an open hand, and we are the ones still holding it today."),
      (16, "warm",   "You are the proof.",
           "So the next time someone tells you that your faith was spread by the sword, you will not need to argue, and you will not need to raise your voice. You know the history now. You know the dates. You know whose hand was truly on the blade, and you know what your own forefathers did with the power they held in theirs. They used it to establish what was right and to put an end to what was wrong. The truth never needed a sword. All it ever needed was to be seen clearly. That is why, after Rome, after Persia, after every empire that ever came for it, you are still standing here today, with well over a billion others beside you. And every single time you rise to your feet to pray, you yourself are the living proof of it."),
      (17, "warm",   "The truth runs straight.",
           "And think, for a moment, about how much a lie has to carry just to stay on its feet. It has to bend the facts, bury half of them, and count on you never once going back to check. The truth carries none of that weight. It simply walks in a straight line. And we are going to keep walking it, story after story, through everything they told you was settled and beyond question. So if you are tired of being made to feel small about who you are, do not just watch this and leave. Subscribe, and stand with us, because there is a great deal more of this still to come."),
      (18, "outro",  "Umma United",
           "Umma United. Subscribe, so the next story finds you. We will see you in the next one."),
    ],
  },

  # VIDEO 1 van de nieuwe reeks — "The Answer You Never Chose" (werktitel). Engels, mannenstem,
  # 16:9. De kijker denkt overal rationeel na (dokter/advocaat = de rationele daad), behalve over
  # de grootste vraag (ons bestaan): daar nam hij zijn antwoord blind over. De vijf deuren zijn
  # HET antwoord van de video. Identiteit (scene 10) dicht de "ik ben nu volwassen"-tegenwerping.
  # Slot opent bewust, geen bom maar een kwartje, en bruggt naar video 2 (absolute waarheid).
  # De stille disclaimer-kaart aan het begin is een BEELD-laag in de studio, geen gesproken scene.
  # Regels: islam nooit als antwoord, "de meeste mensen" niet "iedereen", geen m-dashes.
  "chose": {
    "title": "The Answer You Never Chose",
    "scenes": [
      (1,  "hook",   "You check everything.",
           "There is one thing you would never let a stranger do to you. Operate on you without first checking who they are. You will read the reviews on a ten euro phone case before you buy it. But the biggest question you will ever face, the one about why you are even here, most people answered without looking into it even once. And they will defend that answer to their last breath. Does that strike you as strange? It should. So let us do the one thing almost nobody does with it. Let us actually look."),
      (2,  "rustig", "You can think.",
           "Start with what you are. A bird does not decide to fly south. It is born with the answer already inside it, where to go, what to eat, what to run from. It runs its program and never once asks a question. You are not built like that. You wake up in front of choices nothing prepared you for, and you have to work them out yourself. You weigh things. You reason. You decide. No other creature on this earth does that. It is the one thing that is truly yours."),
      (3,  "rustig", "A thousand small choices.",
           "And you do it so often you do not even notice. You glance at the sky and grab a jacket. A tiny moment. But that tiny moment is the whole thing. You took in the world, you weighed it, and you made a call. You do that a thousand times a day without ever once calling it thinking."),
      (4,  "nadruk", "You go to who knows.",
           "And when it gets serious, you do something even smarter. A pain shows up and will not leave. You do not start cutting into yourself in the kitchen. You stop, and you think, I do not know enough about this, so I will go to someone who does. Look at what that is. You saw the edge of your own knowledge, and you walked toward the person who could fill the gap. That is not weakness. Seeing your own limit and acting on it is about the most rational thing a human being can do."),
      (5,  "rustig", "Find out first.",
           "And it is everywhere. You do not argue your own court case on a feeling, you find someone who knows the law. You do not walk onto a bridge because it looks solid, someone spent years proving it holds your weight. You do not take a medicine because the box looks nice, you want to know what it does. Anywhere the stakes are real, you do the same thing. You find out first, and you decide second. Taking something on blind, just because it was put in front of you, that would be reckless. And you know it."),
      (6,  "nadruk", "Except one question.",
           "Except on one question. There is exactly one place where most people switch that whole machine off. And it is not a small one. It is the biggest there is. Bigger than your health, bigger than your money, bigger than any case in any court. Why are you here. What is this. What happens when it ends. On that one, most people never find out first. They just have an answer. They carry it their whole life. And if you ask them when they actually looked into it, the room goes quiet."),
      (7,  "warm",   "I caught myself.",
           "And I am not standing above anyone here. I am telling you this because it was me. I had my answer too. I carried it like it was mine, like I had earned it. Until one day I asked myself a simple thing. When did I ever sit down with the biggest question there is, and do what I would do for a crack in a wall, find out before I trust it? And the honest answer was never. Not once. It had been handed to me, and I had spent years calling it my own."),
      (8,  "rustig", "Five doors.",
           "So I started paying attention to where people actually get this answer, if not from looking into it. And as far as I can tell, it comes in through about five doors. The first is home. Your parents believed something, or believed in nothing, and it was yours before you could even speak. The second is a single moment. Something happened you could not explain, and you took it as proof, and never went back to it. The third is the people around you. Everyone leaned one way, and leaning with them was easier than standing alone. The fourth is the world itself. The films, the shows, the things school handed you as simply true. A thousand small pushes you never once felt as pushes. And the fifth is pain. Someone hurt you in the name of their answer, so you took the opposite one. Not because you weighed it, but because you were running from them."),
      (9,  "nadruk", "Not one is thinking.",
           "Now look at those five. Four of them are something arriving from outside you. One is you pushing something away. And not one of them is you sitting down and reasoning it out. Yet for most people, this is how they came to hold the most important thing they believe. One swallowed it whole. The next spat it out just as fast. And both of them were certain they had chosen."),
      (10, "nadruk", "But I am grown now.",
           "And here is the part that is harder to shake. You might be thinking, fine, I was a child, I did not pick it back then. But I am grown now. If it were wrong, I would have gone back to check. Most of us never do. And it is not because we are not clever enough. It is that by now the answer is not just something you think. It is part of who you are. It is woven into the people you belong to. And when something sits that close, you do not test it. You protect it. You take that same sharp mind that picks the right doctor, and you point it at defending your answer instead of examining it. That is the strange part. The sharper the mind, the better it gets at the defending. It is not the careless who are most stuck here. Often it is the brightest."),
      (11, "nadruk", "Five reasons. The answer.",
           "So. Why does the thinking creature not think, right here, on the one question that matters most? That is the question I promised to answer, so here it is, plainly. Not because people are stupid. Because an answer was already waiting. Through one of those five doors, there was always something filled in before you arrived. There was never a blank page in front of you asking to be filled. And the one time you might have gone back to check, the answer had already become part of you, so you guarded it instead. That is the answer. And I will be honest about my own. These are the five doors I could find. Maybe there is a sixth. They are not fixed in stone just because they came out of my head, that is the whole point of this. But look at them honestly, and ask yourself whether even one of them is a reason to be sure of anything."),
      (12, "warm",   "Is any of it true?",
           "And this is where it starts to itch. If your answer to the biggest question did not come from you, but from where you happened to be born, and who raised you, and what hurt you, then how would you ever know if it is true? Most people never reach that question. But most is not all. Some do go back. Some do sit down with it. That is the only reason anyone has ever changed their mind about anything. So maybe you are one who looks, this time. And the moment you try, something stands in the doorway. A voice that says, who cares, it is all just opinion anyway. Your truth, my truth, nobody is really right. And if that is true, this whole thing is pointless. So before we go anywhere near what the answer might be, we have to deal with that one first. Is there even such a thing as a truth that stays true, whether you believe it or not. Or is all of it just opinion. Until we settle that, nothing else has any ground to stand on. That is the next one."),
    ],
  },
}
STORIES["sword"]["groups"] = []
STORIES["chose"]["groups"] = []
STORIES["chose"]["map"] = [
  (num, screen, ["tech: statement"]) for (num, tone, screen, voiceline) in STORIES["chose"]["scenes"]
]
# map = per-scène de getekende basis (statement). Het ECHTE beeld (video/foto per scène) wordt in
# de volgende stap bepaald, niet hier. Elke scène krijgt hier gewoon een veilige getekende techniek
# zodat de keten compleet is; de studio/engine negeert tech bij media-beats.
STORIES["sword"]["map"] = [
  (num, screen, ["tech: statement"]) for (num, tone, screen, voiceline) in STORIES["sword"]["scenes"]
]

def build_story(story_id, voice, root, only=0, fmt="16:9"):
    story = STORIES[story_id]
    model = VOICES[voice]
    outdir = os.path.join(root, "assets", "channels", "channel1", "voice", story_id, voice)
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
            _synthesize(model, to_phonetic(voiceline), t["speed"], t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        # INTRO: stilte VOORAAN zodat het logo eerst rustig in beeld staat voordat de stem begint
        # (geen gelijk-op-seconde-1-praten). De zin-meting hieronder meet op de verschoven wav, dus
        # speech_start schuift mee en de ondertiteling blijft op tijd.
        if tone == "intro":
            _prepend_silence(wav, LEAD_SILENCE)
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
            "format": fmt,
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
        # Het FORMAAT (16:9 lang / 9:16 short) staat hier zodat de studio het per project onthoudt.
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
            "format": fmt,
            "title": story["title"],
            "total_seconds": round(abs_t, 3),
            "total_mmss": f"{int(abs_t)//60}:{int(abs_t)%60:02d}",
            "scenes": tl_scenes,
        }
        tj = os.path.join(outdir, "_timeline.json")
        with open(tj, "w", encoding="utf-8") as f:
            json.dump(timeline, f, ensure_ascii=False, indent=2)
        print(f"  tijdlijn:     {tj}  ({len(tl_scenes)} scenes, {sum(len(s['sentences']) for s in tl_scenes)} zinnen, formaat {fmt})")
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
    ap.add_argument("--story", default="sword", help="projectnaam (= verhaal-slug, eigen map)")
    ap.add_argument("--voice", default="beide", choices=list(VOICES.keys()) + ["beide"])
    ap.add_argument("--only", type=int, default=0, help="alleen scene-nummer N opnieuw maken")
    ap.add_argument("--format", dest="fmt", default="16:9", choices=["16:9", "9:16"],
                    help="16:9 = lange video, 9:16 = afgeleide short; reist mee in de tijdlijn")
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
            print(f"\n=== {sid} · STEM: {voice} ({VOICES[voice]}) · FORMAAT: {args.fmt} ===")
            build_story(sid, voice, args.root, args.only, args.fmt)

    # synthesizers netjes afsluiten
    for synth in _SYNTH_CACHE.values():
        try: synth.__exit__(None, None, None)
        except Exception: pass

if __name__ == "__main__":
    main()
