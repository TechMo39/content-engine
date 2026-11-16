#!/usr/bin/env python3
# channel_voice.py - genereert per scene een voice-over met CHATTERBOX (lokaal, CPU), gekloond van een
# REFERENTIE-stem. Per verhaal DRIE stemmen (v1/v2/v3); je kiest er een in de studio.
#
# DIT IS DE FLOW-VERSIE. Het probleem van de vorige versie: het script werd in piepkleine stukjes van
# 1 a 2 zinnen geknipt en los ingesproken, daarna aan elkaar geplakt. Gevolg: rare stiltes op de naden,
# geen intonatie, zinnen die los van elkaar klinken. Deze versie:
#  1. spreekt in GROTERE, samenhangende stukken in (hele gedachten van een paar zinnen), zodat het model
#     intonatie opbouwt en de zinnen met elkaar verbindt (niet de hele alinea tegelijk -> dan kapt hij af);
#  2. knipt de stilte aan het begin en eind van elk stuk weg, zodat de zinnen in elkaar overlopen i.p.v.
#     die gaten, met een korte, gecontroleerde adem tussen de stukken;
#  3. vangt het afkappen/herhalen van Chatterbox af: een herhaling-rem in de generatie plus opnieuw
#     inspreken (andere seed) als een stuk te kort terugkomt;
#  4. houdt de ondertitel strak door de ECHTE pauzes in het geluid te meten (stilte-detectie) en de
#     zin-grenzen daarop te leggen, i.p.v. de tijd te gokken.
#
# Draait LOKAAL (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_voice.py --story chose --voice v3 --format 16:9
#   python tools/channel_voice.py --story chose --voice v3 --only 3     # alleen scene 3 opnieuw
#
# Eenmalig installeren:  pip install chatterbox-tts soundfile
import argparse, os, sys, re, struct, json

# ---------------------------------------------------------------------------------------------
VOICES = {
    "v1": "voice-test/refs/ref7.wav",
    "v2": "voice-test/refs/ref8.wav",
    "v3": "voice-test/refs/ref9.wav",
}
LANG = "en"   # Truthward = Engels

# Stilte VOORAAN de intro-wav (seconden): logo staat eerst rustig in beeld voordat de stem begint.
LEAD_SILENCE = 3.0

# Toon-presets: sil = extra STILTE (seconden) achter de hele scene, zodat een gedachte kan landen.
TONE = {
    "rustig": dict(sil=0.55),
    "nadruk": dict(sil=0.80),
    "warm":   dict(sil=0.95),
    "hook":   dict(sil=0.65),
    "intro":  dict(sil=0.70),
    "outro":  dict(sil=0.90),
}

# INSPREEK-INSTELLINGEN. Dicht bij de natuurlijke/expressieve standaard gehouden (anders wordt het vlak),
# met alleen een herhaling-rem erbij om het blijven-hangen in een woord tegen te gaan.
EXAGGERATION = 0.5
CFG_WEIGHT = 0.5
TEMPERATURE = 0.8
REPETITION_PENALTY = 1.3
MIN_P = 0.05

# VANGNET tegen afkappen: komt een stuk veel te kort terug (door Chatterbox afgekapt), dan opnieuw met
# een andere seed, tot het lang genoeg is; we houden het langste van de pogingen.
MAX_TRIES = 4
MIN_RATIO = 0.72           # geaccepteerd als de duur >= dit deel van de verwachte duur
BASE_SEED = 20261116

# CHUNK-GROOTTE: grotere, samenhangende stukken (betere intonatie/flow) maar niet de hele alinea
# (te lang = afkappen). Streefgrootte in tekens; harde bovengrens voor de veiligheid.
CHUNK_CHARS = 200
MAX_CHARS = 300
BREATH = 0.14              # korte adem (seconden) tussen de stukken

# ---------------------------------------------------------------------------------------------
# CHATTERBOX-MODEL. Een keer laden per proces; de referentie-stem geven we per generate-call mee.
_CB = {}
def _get_model():
    if "m" in _CB:
        return _CB["m"]
    try:
        import perth  # noqa
    except Exception:
        import types
        pm = types.ModuleType("perth")
        class _Dummy:
            def __init__(self, *a, **k): pass
            def apply_watermark(self, wav, *a, **k): return wav
            def get_watermark(self, *a, **k): return None
        pm.PerthImplicitWatermarker = _Dummy
        pm.DummyWatermarker = _Dummy
        sys.modules["perth"] = pm
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS
    _CB["m"] = ChatterboxMultilingualTTS.from_pretrained(device="cpu")
    return _CB["m"]

def _seed_everything(seed):
    import random
    random.seed(seed)
    try:
        import numpy as _np; _np.random.seed(seed % (2**32))
    except Exception: pass
    try:
        import torch as _t; _t.manual_seed(seed)
    except Exception: pass

def _generate_once(m, text, ref_abs):
    # roep generate aan met onze instellingen; valt netjes terug als een oudere Chatterbox-versie een
    # van de knoppen niet kent (andere signature), zodat het nooit op een TypeError klapt.
    base = dict(language_id=LANG, audio_prompt_path=ref_abs)
    tune = dict(exaggeration=EXAGGERATION, cfg_weight=CFG_WEIGHT, temperature=TEMPERATURE,
                repetition_penalty=REPETITION_PENALTY, min_p=MIN_P)
    for drop in ([], ["min_p"], ["min_p", "repetition_penalty"],
                 ["min_p", "repetition_penalty", "exaggeration", "cfg_weight", "temperature"]):
        kw = {**base, **{k: v for k, v in tune.items() if k not in drop}}
        try:
            return m.generate(text, **kw)
        except TypeError:
            continue
    return m.generate(text, **base)

def _syllables(w):
    w = w.lower(); v = "aeiouy"; c = 0; prev = False
    for ch in w:
        isv = ch in v
        if isv and not prev: c += 1
        prev = isv
    if w.endswith("e") and c > 1: c -= 1
    return max(1, c)

def _sent_weight(s):
    base = sum(_syllables(w) for w in re.findall(r"[A-Za-z']+", s))
    base += 0.6 * len(re.findall(r"[,;:]", s))   # interne pauzes kosten tijd
    base += 0.9                                  # zin-eind-pauze
    return max(base, 1.0)

def _expected_secs(text):
    syl = sum(_syllables(w) for w in re.findall(r"[A-Za-z']+", text))
    return max(0.6, syl / 3.6)   # ~3.6 lettergrepen/sec verteltempo

def _sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s.strip()]

def _group_sentences(sents):
    # Grotere, samenhangende stukken: hele zinnen tot ~CHUNK_CHARS (harde grens MAX_CHARS). Zo bouwt het
    # model intonatie over meerdere zinnen; een heel lange losse zin gaat alleen (valt vanzelf zo uit).
    groups = []; cur = []; cur_idx = []; cur_len = 0
    for i, s in enumerate(sents):
        add = len(s) + (1 if cur else 0)
        if cur and cur_len + add > CHUNK_CHARS:
            groups.append((" ".join(cur), cur_idx)); cur = []; cur_idx = []; cur_len = 0; add = len(s)
        cur.append(s); cur_idx.append(i); cur_len += add
    if cur:
        groups.append((" ".join(cur), cur_idx))
    return groups

# ---------------------------------------------------------------------------------------------
# GELUID-HELPERS (numpy). Chatterbox levert float [-1,1]; wij werken op int16-samples zodat we stilte
# kunnen wegknippen en de echte pauzes kunnen meten voor de ondertitel.
def _gen_chunk(ref_abs, text):
    # Genereer EEN stuk met vangnet; geef (int16-samples, sr) terug met de stilte aan begin+eind weg.
    import numpy as np
    m = _get_model()
    want = _expected_secs(text)
    best = None; best_dur = -1.0; sr = int(getattr(m, "sr", 24000))
    for attempt in range(MAX_TRIES):
        _seed_everything(BASE_SEED + attempt * 101)
        wav = _generate_once(m, text, ref_abs)
        arr = wav.squeeze().detach().cpu().numpy().astype(np.float32)
        dur = len(arr) / float(sr)
        if dur > best_dur:
            best = arr; best_dur = dur
        if dur >= want * MIN_RATIO:
            break
    x = np.clip(best, -1.0, 1.0)
    i16 = (x * 32767.0).astype(np.int16)
    i16 = _trim_ends(i16, sr)
    return i16, sr

def _env(i16, sr, win=0.02):
    import numpy as np
    w = max(1, int(win * sr))
    n = (len(i16) // w) * w
    if n == 0:
        return None, w
    f = np.abs(i16[:n].astype(np.float32)).reshape(-1, w)
    return f.mean(axis=1), w

def _trim_ends(i16, sr, thr_ratio=0.06, pad=0.03):
    import numpy as np
    env, w = _env(i16, sr)
    if env is None:
        return i16
    peak = float(env.max()) or 1.0
    above = np.where(env >= peak * thr_ratio)[0]
    if len(above) == 0:
        return i16
    start = max(0, int(above[0] * w) - int(pad * sr))
    end = min(len(i16), int((above[-1] + 1) * w) + int(pad * sr))
    return i16[start:end]

def _pause_centers(i16, sr, thr_ratio=0.06, min_pause=0.13):
    # middens (seconden) van echte stiltes binnen een stuk; dit zijn de zin-grenzen om op te snappen.
    import numpy as np
    env, w = _env(i16, sr)
    if env is None:
        return []
    peak = float(env.max()) or 1.0
    low = env < (peak * thr_ratio)
    centers = []; i = 0; N = len(low)
    while i < N:
        if low[i]:
            j = i
            while j < N and low[j]:
                j += 1
            if (j - i) * w / sr >= min_pause:
                centers.append(((i + j) / 2.0) * w / sr)
            i = j
        else:
            i += 1
    return centers

def _sentence_bounds(idxs, sents, chunk_dur, pauses):
    # per zin (start, duur) binnen het stuk: schat op lettergreep-gewicht, snap de grenzen naar de
    # dichtstbijzijnde echte pauze; zo loopt de ondertitel strak mee.
    k = len(idxs)
    if k == 1:
        return [(0.0, chunk_dur)]
    weights = [_sent_weight(sents[i]) for i in idxs]
    tot = sum(weights) or 1.0
    est = []; acc = 0.0
    for wgt in weights[:-1]:
        acc += chunk_dur * (wgt / tot); est.append(acc)
    TOL = 0.45; used = set(); snapped = []
    for e in est:
        best = None; bd = TOL
        for p in pauses:
            if id(p) in used:
                continue
            if abs(p - e) < bd:
                bd = abs(p - e); best = p
        if best is not None:
            used.add(id(best)); snapped.append(best)
        else:
            snapped.append(e)
    edges = [0.0] + sorted(snapped) + [chunk_dur]
    for i in range(1, len(edges)):
        if edges[i] <= edges[i - 1] + 0.05:
            edges[i] = min(chunk_dur, edges[i - 1] + 0.05)
    return [(round(edges[i], 3), round(max(0.05, edges[i + 1] - edges[i]), 3)) for i in range(k)]

def _silence_samples(sr, secs):
    import numpy as np
    return np.zeros(max(0, int(sr * secs)), dtype=np.int16)

def _write_pcm16(path, i16, sr):
    data = i16.astype("<i2").tobytes()
    n = len(data)
    with open(path, "wb") as f:
        f.write(b"RIFF"); f.write(struct.pack("<I", 36 + n)); f.write(b"WAVE")
        f.write(b"fmt "); f.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
        f.write(b"data"); f.write(struct.pack("<I", n)); f.write(data)

def _synthesize_scene(ref_abs, scene_text, tail_sil, out_wav):
    # Spreek de scene in per samenhangend stuk, plak ze met een korte adem, en meet per zin de echte tijd.
    import numpy as np
    sents = _sentences(scene_text)
    if not sents:
        i16, sr = _gen_chunk(ref_abs, scene_text)
        _write_pcm16(out_wav, i16, sr)
        if tail_sil and tail_sil > 0:
            _append_silence(out_wav, tail_sil)
        d = _wav_duration(out_wav); return [(0.0, round(d, 3))], 0.0, round(d, 3)
    groups = _group_sentences(sents)
    parts = []; seg = [None] * len(sents); cursor = 0.0; sr = 24000
    for gi, (text, idxs) in enumerate(groups):
        i16, sr = _gen_chunk(ref_abs, text)
        cdur = len(i16) / float(sr)
        bounds = _sentence_bounds(idxs, sents, cdur, _pause_centers(i16, sr))
        for j, i in enumerate(idxs):
            st, dd = bounds[j]
            seg[i] = (round(cursor + st, 3), dd)
        parts.append(i16)
        cursor += cdur
        if gi != len(groups) - 1:
            parts.append(_silence_samples(sr, BREATH))
            cursor += BREATH
    full = np.concatenate(parts) if parts else np.zeros(0, dtype=np.int16)
    _write_pcm16(out_wav, full, sr)
    if tail_sil and tail_sil > 0:
        _append_silence(out_wav, tail_sil)
    segs = [s for s in seg if s is not None]
    sp0 = segs[0][0] if segs else 0.0
    sp1 = round(segs[-1][0] + segs[-1][1], 3) if segs else round(_wav_duration(out_wav), 3)
    return segs, sp0, sp1

# ---------------------------------------------------------------------------------------------
# RIFF-helpers voor duur meten en stilte voor/achter plakken (werken op de PCM-16 wavs die we schrijven).
def _read_wav_parts(path):
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

def _wav_duration(wav_path):
    try:
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
    try:
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
        nbytes = int(byte_rate * seconds)
        block_align = struct.unpack_from("<H", data, 32)[0] or 1
        nbytes -= (nbytes % block_align)
        silence = b"\x00" * nbytes
        insert_at = data_off + data_len
        new = data[:insert_at] + silence + data[insert_at:]
        struct.pack_into("<I", new, data_off - 4, data_len + nbytes)
        struct.pack_into("<I", new, 4, len(new) - 8)
        with open(wav_path, "wb") as f:
            f.write(new)
    except Exception:
        pass

def _prepend_silence(wav_path, seconds):
    try:
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
        new = data[:data_off] + silence + data[data_off:]
        struct.pack_into("<I", new, data_off - 4, data_len + nbytes)
        struct.pack_into("<I", new, 4, len(new) - 8)
        with open(wav_path, "wb") as f:
            f.write(new)
    except Exception:
        pass

# ---------------------------------------------------------------------------------------------
# SCRIPT. Per scene: nummer, toon, ON-SCREEN kernzin, en de VOLLE gesproken zin (= de ondertitel).
# GEEN m-dashes. Islam nooit als antwoord; "de meeste mensen" niet "iedereen"; geen aannames die een
# scepticus/atheist meteen afwijst.
STORIES = {
  "chose": {
    "title": "The Answer You Never Chose",
    "scenes": [
      (0,  "intro",  "Truthward",
           "Welcome to Truthward. Good to have you here. Here is the whole idea behind this channel. In every video, we take one real question, and we do our honest best to answer it. We reason it through, step by step, and we look at it honestly, without preaching and without telling you what to think. And by the end, we will usually have more than an answer. We will have a new question or two worth chasing, and those become the next videos. That is really all this is. Because the truth is never as complicated as people make it sound. It is honest, and simple enough for anyone to follow. So all we try to do here is bring it back to the surface, one question at a time. If you want to come along for that, subscribe so the next question finds you. Leave a comment, especially if you see it differently. And if it was worth your time, a like helps. Alright. Let us begin."),
      (1,  "rustig", "You think, all day.",
           "Let me show you something you do all day long and never once notice. You think. From the moment you wake up, you are making decisions. You look outside, and you decide what to wear. You decide what to eat, and which way to take to work. You decide whether to cross the road now or wait for that car to pass. You decide what to say to someone, and what to keep to yourself. None of it feels like anything. But every single one of those is your brain doing the same quiet thing. Reading the situation, weighing it, and making a call. You do it hundreds of times a day, and you never once stop to give it a name."),
      (2,  "rustig", "You are different.",
           "Now here is what makes that so strange. Think about an animal for a moment. A bird getting ready to fly south does not sit there weighing its options. It does not wonder whether it is making the right call. It just goes, the way it always has. That is instinct, not a decision. You are different. You can stop before you act. You can question what you are doing, and even question the way you are thinking about it. You can reason about things that are not in front of you at all, things you cannot see or touch. You do this constantly, without ever noticing. And it is exactly this ability, the one you lean on all day without a second thought, that the rest of this video is about."),
      (3,  "nadruk", "You go to who knows.",
           "And watch what you do when something actually matters. You do not get more reckless. You get more careful. Say something goes wrong with your car, something you do not understand. You do not open the hood and start pulling at wires and hope for the best. You take it to someone who actually knows engines. And think about what really happens in that moment. You looked at the situation, you saw the edge of what you know, and you decided to go to someone who knows more. That is not you being lazy or giving up. That is your mind working exactly the way it should. Knowing what you do not know is one of the smartest things a person can do."),
      (4,  "rustig", "Prove it first.",
           "And you want a reason before you believe something, especially when it counts. A stranger walks up and tells you to hand over your savings, and no matter how friendly he is, something in you says, wait, prove it first. A doctor gives you a pill, and it is fair to ask what it is and what it does before you swallow it. You do this without even thinking about it. You do not just accept things because someone said them with confidence. You look first, and you decide after. And deep down you know that simply taking something on someone else's word, and never once checking it, would be a foolish way to live."),
      (5,  "nadruk", "Except one question.",
           "So here is the strange part. With all of that, there is one question where every bit of it just switches off. One place where the careful, reasoning, show-me-first version of you simply does not show up. And it is not some small thing tucked away in a corner of your life. It is the biggest question there is. Bigger than your health, bigger than your money, bigger than anything you would ever think twice about anywhere else."),
      (6,  "nadruk", "Why are you here.",
           "Here it is. Why are you here. What is all of this, really. And what happens when it is over. Do not rush past those. Sit in them for a second, because every other thing you do is quietly built on top of the answer you gave them. And on this one, the biggest of them all, most people never actually stopped to think. Not once. They did not look at it the way they look at everything else. They just carry an answer around. And if you ask them, gently, where that answer came from, the room usually goes quiet."),
      (7,  "warm",   "It was me too.",
           "And I am not saying this from above anyone. I am saying it because it was me. I had my answer too. I carried it around for years like it was mine, like I had earned it somewhere along the way. Until one ordinary day I stopped and asked myself one simple thing. Have I ever actually sat down with this, the single biggest question there is, and looked at it the way I would look at anything else that mattered. And the honest answer was no. Not once. It had been handed to me a long time ago, and I had spent my whole life calling it my own."),
      (8,  "rustig", "Five quiet doors.",
           "So I started paying attention. If people did not reason their way to this answer, then how did it get in? And as far as I can tell, it comes in through five quiet doors. The first is home. Your parents believed something, or they believed in nothing, and it was already yours before you could even speak. The second is a single moment. Something happened that you could not explain, you took it as proof, and you never went back to look at it again. The third is the people around you. Everyone near you leaned one way, and leaning with them was easier than standing alone. The fourth is the world itself. The films, the songs, the things you were taught as if they were just obviously true. A thousand small nudges you never once felt as nudges. And the fifth is pain. Someone hurt you in the name of their answer, so you took the opposite one. Not because you weighed it, but because you were walking away from them."),
      (9,  "nadruk", "None of it is reasoning.",
           "Now look at those five honestly. Four of them are something coming at you from the outside and settling in. One of them is you shoving something away. And not a single one of them is you sitting down and reasoning it through. And yet, for most people, that is exactly how they came to hold the most important thing they believe. One person took it in whole and never questioned it. The next threw it out just as fast. And both of them walked away completely sure that they had chosen it themselves."),
      (10, "nadruk", "You defend it.",
           "Now you might be thinking, fine, I was a kid, of course I did not choose it back then. But I am grown now. If it were wrong, I would have gone back and checked. And here is the uncomfortable part. Most of us never do. And it is not because we are not smart enough. It is that by now the answer is not just something you hold in your head. It has grown into who you are. It is tangled up with the people you belong to. And when something sits that close to you, you stop testing it and you start protecting it. You take that same sharp mind that picks the right mechanic, and you point it at defending your answer instead of checking it. That is the trap. And the sharper the mind, the better it gets at defending. It is not the careless people who are most stuck here. Very often, it is the smartest ones."),
      (11, "nadruk", "The answer.",
           "So. Why does that reasoning, the thing you do all day without noticing, switch off right here, on the question that matters more than any other? I promised you an answer, so here it is, plainly. It is not that people are stupid. It is that an answer was already sitting there, waiting for them. Through one of those five doors, it got filled in long before they ever showed up to ask. There was never a blank page in front of them waiting to be filled. And the one time they might have gone back to check it, the answer had already become a part of who they are. So they protected it instead. That is the answer. And let me be honest about my own. These are the five doors I could find. Maybe there is a sixth that I missed, and maybe you are the one who finds it. They are not set in stone just because they came out of my head. But look at them honestly, and ask yourself one thing. Is even one of them a real reason to be sure of anything?"),
      (12, "warm",   "Is any of it true?",
           "And this is where it starts to itch. If your answer to the biggest question of all did not really come from you, but from where you happened to be born, and who raised you, and what once hurt you, then how could you ever actually know whether it is true? Most people never even get to that question. But most is not all. Some people do go back. Some do sit down and look. That is the only reason anyone, ever, has changed their mind about anything. So maybe you are one of the ones who looks. This time. And the second you try, something steps in the way. A quiet voice that says, who cares, it is all just opinion anyway. Your truth, my truth, nobody is really right. And if that were true, then this whole thing is pointless before it even starts. So before we go anywhere near what the answer might be, we have to deal with that one first. Is there such a thing as a truth that stays true whether you believe it or not? Or is all of it just opinion? Until we have looked at that honestly, nothing else we say has any ground to stand on. And that is exactly where we go next."),
      (13, "outro",  "Truthward",
           "If this gave you something to sit with tonight, then stay with us. One honest question at a time, followed as far as it actually goes. The next one is the question hiding underneath this whole video. Whether any truth can hold at all, no matter who believes it. Subscribe so you are here when we look at it. And if you think I got something wrong somewhere, say so, because that is exactly how this gets sharper. I will see you in the next one."),
    ],
  },
}
STORIES["chose"]["groups"] = []
STORIES["chose"]["map"] = [
  (num, screen, ["tech: statement"]) for (num, tone, screen, voiceline) in STORIES["chose"]["scenes"]
]

def build_story(story_id, voice, root, only=0, fmt="16:9", channel="channel1"):
    story = STORIES[story_id]
    ref_abs = os.path.join(root, VOICES[voice])
    if not os.path.isfile(ref_abs):
        print(f"  referentie-stem ontbreekt voor {voice}: {ref_abs}"); return
    outdir = os.path.join(root, "assets", "channels", channel, "voice", story_id, voice)
    os.makedirs(outdir, exist_ok=True)
    made = []
    durs = {}
    sents_by = {}
    for num, tone, screen, voiceline in story["scenes"]:
        if only and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        try:
            segs, sp0, sp1 = _synthesize_scene(ref_abs, voiceline, t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        if tone == "intro":
            _prepend_silence(wav, LEAD_SILENCE)
            segs = [(round(st + LEAD_SILENCE, 3), dd) for (st, dd) in segs]
            sp0 = round(sp0 + LEAD_SILENCE, 3); sp1 = round(sp1 + LEAD_SILENCE, 3)
        d = _wav_duration(wav)
        durs[num] = d
        sents_by[num] = (segs, sp0, sp1)
        nz = len(segs) if segs else 0
        made.append((num, wav)); print(f"  scene {num:02d} [{tone}] {d:6.2f}s, {nz} zin(nen) -> {wav}")
    if not only:
        lines = [f"title: {story['title']}", "view: belt"] + story["groups"]
        by = {num: wav for num, wav in made}
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

        tone_by = {num: tone for (num, tone, screen, voiceline) in story["scenes"]}
        line_by = {num: voiceline for (num, tone, screen, voiceline) in story["scenes"]}
        total = round(sum(durs.get(n, 0.0) for n in durs), 2)
        meta = {
            "story": story_id, "voice": voice, "format": fmt, "title": story["title"],
            "total_seconds": total, "total_mmss": f"{int(total)//60}:{int(total)%60:02d}",
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

        tl_scenes = []
        abs_t = 0.0
        for num, _wav in made:
            segs, sp0, sp1 = sents_by.get(num, (None, 0.0, durs.get(num, 0.0)))
            lines_s = _sentences(line_by.get(num, ""))
            sentences = []
            if segs:
                for i, (st, dd) in enumerate(segs):
                    sentences.append({
                        "i": i, "text": lines_s[i] if i < len(lines_s) else "",
                        "start": st, "dur": dd, "abs_start": round(abs_t + st, 3),
                    })
            sc = {
                "scene": num, "tone": tone_by.get(num, ""),
                "wav": os.path.relpath(by[num], root).replace("\\", "/") if by.get(num) else "",
                "start": round(abs_t, 3), "dur": round(durs.get(num, 0.0), 3),
                "speech_start": sp0, "speech_end": sp1,
                "sentences": sentences, "beats": [], "sfx": [],
            }
            tl_scenes.append(sc)
            abs_t += durs.get(num, 0.0)
        timeline = {
            "story": story_id, "voice": voice, "format": fmt, "title": story["title"],
            "total_seconds": round(abs_t, 3),
            "total_mmss": f"{int(abs_t)//60}:{int(abs_t)%60:02d}",
            "scenes": tl_scenes,
        }
        tj = os.path.join(outdir, "_timeline.json")
        with open(tj, "w", encoding="utf-8") as f:
            json.dump(timeline, f, ensure_ascii=False, indent=2)
        print(f"  tijdlijn:     {tj}  ({len(tl_scenes)} scenes, {sum(len(s['sentences']) for s in tl_scenes)} zinnen, formaat {fmt})")
    print(f"  klaar: {len(made)} fragment(en)")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="chose", help="projectnaam (= verhaal-slug, eigen map)")
    ap.add_argument("--voice", default="alle", choices=list(VOICES.keys()) + ["alle"],
                    help="v1 / v2 / v3, of 'alle' voor alle drie de stemmen")
    ap.add_argument("--only", type=int, default=0, help="alleen scene-nummer N opnieuw maken")
    ap.add_argument("--format", dest="fmt", default="16:9", choices=["16:9", "9:16"],
                    help="16:9 = lange video, 9:16 = afgeleide short; reist mee in de tijdlijn")
    ap.add_argument("--root", default=".", help="content-engine root")
    ap.add_argument("--channel", default="channel1", help="kanaal-map onder assets/channels/")
    args = ap.parse_args()

    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox is niet geinstalleerd. Doe eerst:  pip install chatterbox-tts soundfile")
        sys.exit(1)

    if args.story not in STORIES:
        print("onbekend verhaal:", args.story); sys.exit(1)
    voices = list(VOICES.keys()) if args.voice == "alle" else [args.voice]
    for voice in voices:
        print(f"\n=== {args.story} - STEM: {voice} ({VOICES[voice]}) - FORMAAT: {args.fmt} ===")
        build_story(args.story, voice, args.root, args.only, args.fmt, args.channel)

if __name__ == "__main__":
    main()
