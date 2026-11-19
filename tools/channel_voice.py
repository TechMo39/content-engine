#!/usr/bin/env python3
# channel_voice.py - voice-over met CHATTERBOX (lokaal, CPU), gekloond van een REFERENTIE-stem.
#
# AANPAK (terug naar wat werkte, Mo's afspraak): spreek per 2 zinnen in, en zet er een ECHTE adem
# tussen de blokken. GEEN knipmechanisme meer. Waarom dit klopt:
#   - 2 zinnen samen -> het model houdt de intonatie verbonden (geen "opdreunen"), en het blok is kort
#     genoeg dat Chatterbox het niet halverwege afkapt.
#   - we knippen NIETS terug. Elk blok is een schone opname. De ruimte tussen de zinnen bouwen we zelf
#     door een stilte TUSSEN de blokken te zetten -> geen foute knippen, geen splice-"effecten".
#   - ondertiteling: de start van elk blok is per constructie exact bekend. Zit een blok uit 2 zinnen,
#     dan schatten we binnen het blok alleen het MOMENT waarop de ondertiteltekst wisselt (op
#     lettergreep-gewicht). Dat is PUUR voor de tekst op het scherm; de audio wordt nooit geknipt.
#   - vangnet tegen Chatterbox-afkappen EN tegen de token-herhaling-ruis: komt een blok te kort terug,
#     of vuurt het model zijn herhaling-waarschuwing af, dan opnieuw met een andere seed en we houden
#     de schoonste opname.
#   - ingebouwde controle: per blok meten we of het in STILTE eindigt (schoon) of in GELUID (mogelijk
#     afgekapt), en printen dat. Zo is te zien wat eruit komt zonder te hoeven gokken.
#
# Draai (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_voice.py --story chose --voice v3  --only 1 --format 16:9   # scene 1, v3
#   python tools/channel_voice.py --story chose --voice alle --only 0 --format 16:9  # scene 0, v1+v2+v3
#   python tools/channel_voice.py --story chose --voice v3  --format 16:9            # alle scenes, v3
import argparse, os, sys, re, struct, json, logging, subprocess, shutil

VOICES = {
    "male1": "voice-test/refs/male1.wav",
    "male2": "voice-test/refs/male2.wav",
    "male3": "voice-test/refs/male3.wav",
    "male4": "voice-test/refs/male4.wav",
    "male5": "voice-test/refs/male5.wav",
    "male6": "voice-test/refs/male6.wav",
    "fem1": "voice-test/refs/fem1.wav",
    "fem2": "voice-test/refs/fem2.wav",
    "fem3": "voice-test/refs/fem3.wav",
}
LANG = "en"
LEAD_SILENCE = 3.0   # stilte vooraan de intro (logo in beeld)

TONE = {
    "rustig": dict(sil=0.55), "nadruk": dict(sil=0.80), "warm": dict(sil=0.95),
    "hook": dict(sil=0.65), "intro": dict(sil=0.70), "outro": dict(sil=0.90),
}

# Inspreek-instellingen. Lagere cfg = rustiger tempo (Mo: "praat te snel"); hogere herhaling-rem
# onderdrukt juist de token-herhaling die de ruis-artefacten veroorzaakt.
EXAGGERATION = 0.5
CFG_WEIGHT = 0.3
TEMPERATURE = 0.8
REPETITION_PENALTY = 2.0
MIN_P = 0.05

MAX_TRIES = 4
MIN_RATIO = 0.72          # een blok dat < 72% van de verwachte lengte terugkomt = waarschijnlijk afgekapt
BASE_SEED = 20261117

GROUP_MIN_SENTS = 2       # Mo's afspraak: minimaal 2 zinnen per blok
GROUP_SOFT_CHARS = 200    # alleen een 3e (korte) zin erbij als de eerste twee samen nog kort zijn
GAP_BETWEEN_GROUPS = 0.50 # echte adem TUSSEN de blokken (ruimte, geen gehaast)

# RUISREDUCTIE: de referentieclips (ref7/8/9.wav) hebben achtergrondgeluid dat Chatterbox meekloont.
# Een zachte ffmpeg-denoiser (afftdn) op het eindresultaat haalt die ruis onder de stem weg zonder
# de stem zelf aan te tasten. Zacht houden (te hard = "waterig").
DENOISE = True
DENOISE_DB = 12           # dB ruisreductie (zacht); hoger = meer weg maar meer kans op artefacten
_FFMPEG = None

def _ffmpeg_path(root):
    p = os.environ.get("FFMPEG_PATH")
    if p and os.path.isfile(p):
        return p
    for rel in ("node_modules/ffmpeg-static/ffmpeg.exe", "node_modules/ffmpeg-static/ffmpeg"):
        cand = os.path.join(root, *rel.split("/"))
        if os.path.isfile(cand):
            return cand
    return shutil.which("ffmpeg") or "ffmpeg"

def _denoise_wav(path):
    # in-place zachte ruisreductie; bij elke fout laten we het bestand gewoon zoals het was.
    if not DENOISE or not _FFMPEG:
        return False
    tmp = path + ".dn.wav"
    cmd = [_FFMPEG, "-y", "-i", path, "-af", f"afftdn=nr={DENOISE_DB}:nf=-25",
           "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", tmp]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        os.replace(tmp, path)
        return True
    except Exception as e:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        print(f"      (ruisreductie overgeslagen: {e})")
        return False

# ---------------------------------------------------------------------------------------------
# Let op Chatterbox' eigen herhaling-waarschuwing, zodat we een vuil blok kunnen overdoen.
class _RepWatch(logging.Handler):
    def __init__(self):
        super().__init__(); self.hit = False
    def emit(self, record):
        try:
            msg = record.getMessage().lower()
        except Exception:
            msg = ""
        if "repetition of token" in msg or "token_repetition=true" in msg:
            self.hit = True
_REPW = _RepWatch(); _REPW.setLevel(logging.WARNING)

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
    # herhaling-waarschuwing aan de analyzer-logger hangen
    lg = logging.getLogger("chatterbox.models.t3.inference.alignment_stream_analyzer")
    lg.addHandler(_REPW); lg.setLevel(logging.WARNING)
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
    base += 0.6 * len(re.findall(r"[,;:]", s))
    base += 0.9
    return max(base, 1.0)

def _expected_secs(text):
    syl = sum(_syllables(w) for w in re.findall(r"[A-Za-z']+", text))
    return max(0.6, syl / 3.6)

def _sentences(text):
    return [s.strip() for s in re.split(r'(?<=[.!?])\s+', text.strip()) if s.strip()]

def _group_sentences(sents):
    # blokken van MINIMAAL 2 zinnen; een 3e alleen als het blok nog kort is. Nooit een losse zin:
    # een overgebleven laatste zin gaat bij het vorige blok.
    groups = []; i = 0; n = len(sents)
    while i < n:
        idx = [i]; j = i + 1
        if j < n:
            idx.append(j); j += 1
        while j < n and sum(len(sents[k]) for k in idx) < GROUP_SOFT_CHARS and (j - i) < 3:
            idx.append(j); j += 1
        groups.append(([sents[k] for k in idx], idx)); i = j
    if len(groups) >= 2 and len(groups[-1][1]) < GROUP_MIN_SENTS:
        pt, pi = groups[-2]; lt, li = groups[-1]
        groups[-2] = (pt + lt, pi + li); groups.pop()
    return groups

# ---------------------------------------------------------------------------------------------
# GELUID (numpy): genereren (met vangnet), stilte aan de uiteinden wegknippen, staart-controle.
def _gen_group(ref_abs, text):
    import numpy as np
    m = _get_model()
    want = _expected_secs(text)
    sr = int(getattr(m, "sr", 24000))
    best = None; best_score = -1e9; best_clean = False; best_dur = 0.0
    for attempt in range(MAX_TRIES):
        _seed_everything(BASE_SEED + attempt * 101)
        _REPW.hit = False
        wav = _generate_once(m, text, ref_abs)
        arr = wav.squeeze().detach().cpu().numpy().astype(np.float32)
        dur = len(arr) / float(sr)
        clean = (not _REPW.hit) and (dur >= want * MIN_RATIO)
        # sterk voorkeur voor een schoon blok; daarbinnen de opname die het dichtst bij de
        # verwachte lengte zit (niet onnodig lang = geen staart-geleuter).
        score = (1000.0 if clean else 0.0) - abs(dur - want)
        if score > best_score:
            best_score = score; best = arr; best_clean = clean; best_dur = dur
        if clean:
            break
    x = np.clip(best, -1.0, 1.0)
    return (x * 32767.0).astype(np.int16), sr, best_clean, best_dur

def _env(i16, sr, win=0.02):
    import numpy as np
    w = max(1, int(win * sr))
    n = (len(i16) // w) * w
    if n == 0:
        return None, w
    f = np.abs(i16[:n].astype(np.float32)).reshape(-1, w)
    return f.mean(axis=1), w

def _trim_ends(i16, sr, thr_ratio=0.05, pad=0.05):
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

def _tail_is_silent(i16, sr, win=0.08, thr_ratio=0.08):
    # eindigt het blok netjes in stilte (schoon) of nog in geluid (mogelijk afgekapt)?
    import numpy as np
    env, w = _env(i16, sr)
    if env is None:
        return True
    peak = float(env.max()) or 1.0
    n = max(1, int(win / 0.02))
    tail = env[-n:]
    return float(tail.mean()) < peak * thr_ratio

def _silence_samples(sr, secs):
    import numpy as np
    return np.zeros(max(0, int(sr * secs)), dtype=np.int16)

def _write_pcm16(path, i16, sr):
    data = i16.astype("<i2").tobytes(); n = len(data)
    with open(path, "wb") as f:
        f.write(b"RIFF"); f.write(struct.pack("<I", 36 + n)); f.write(b"WAVE")
        f.write(b"fmt "); f.write(struct.pack("<IHHIIHH", 16, 1, 1, sr, sr * 2, 2, 16))
        f.write(b"data"); f.write(struct.pack("<I", n)); f.write(data)

def _synthesize_scene(ref_abs, scene_text, tail_sil, out_wav):
    import numpy as np
    sents = _sentences(scene_text)
    if not sents:
        i16, sr, _clean, _d = _gen_group(ref_abs, scene_text)
        i16 = _trim_ends(i16, sr)
        _write_pcm16(out_wav, i16, sr)
        _denoise_wav(out_wav)
        if tail_sil and tail_sil > 0:
            _append_silence(out_wav, tail_sil)
        d = _wav_duration(out_wav); return [(0.0, round(d, 3))], 0.0, round(d, 3), []
    groups = _group_sentences(sents)
    out = []; cursor = 0.0; sr = 24000
    sent_times = []   # (zin-index, abs_start, dur) -> voor de ondertiteling
    diag = []         # (zin-indexen, verwacht, gekregen, schoon, staart_stil) -> controle
    gap = None
    for gi, (gtexts, gidx) in enumerate(groups):
        text = " ".join(gtexts)
        i16, sr, clean, _dur = _gen_group(ref_abs, text)
        i16 = _trim_ends(i16, sr, thr_ratio=0.05, pad=0.05)
        gdur = len(i16) / float(sr)
        diag.append((gidx, _expected_secs(text), gdur, clean, _tail_is_silent(i16, sr)))
        # ondertitel-wissel BINNEN het blok, alleen voor de tekst op het scherm (audio blijft heel)
        weights = [_sent_weight(s) for s in gtexts]; tw = sum(weights) or 1.0
        acc = 0.0
        for si, s in enumerate(gtexts):
            st = cursor + gdur * (acc / tw)
            en = cursor + gdur * ((acc + weights[si]) / tw)
            sent_times.append((gidx[si], round(st, 3), round(en - st, 3)))
            acc += weights[si]
        if gap is None:
            gap = _silence_samples(sr, GAP_BETWEEN_GROUPS)
        out.append(i16); cursor += gdur
        if gi != len(groups) - 1:
            out.append(gap); cursor += GAP_BETWEEN_GROUPS
    full = np.concatenate(out) if out else np.zeros(0, dtype=np.int16)
    _write_pcm16(out_wav, full, sr)
    _denoise_wav(out_wav)
    if tail_sil and tail_sil > 0:
        _append_silence(out_wav, tail_sil)
    sent_times.sort(key=lambda x: x[0])
    segs = [(st, dd) for (_i, st, dd) in sent_times]
    sp0 = segs[0][0] if segs else 0.0
    sp1 = round(segs[-1][0] + segs[-1][1], 3) if segs else round(_wav_duration(out_wav), 3)
    return segs, sp0, sp1, diag

# ---------------------------------------------------------------------------------------------
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

def build_story(story_id, voice, root, only=-1, fmt="16:9", channel="channel1"):
    story = STORIES[story_id]
    ref_abs = os.path.join(root, VOICES[voice])
    if not os.path.isfile(ref_abs):
        print(f"  referentie-stem ontbreekt voor {voice}: {ref_abs}"); return
    global _FFMPEG
    if _FFMPEG is None:
        _FFMPEG = _ffmpeg_path(root)
        if DENOISE:
            print(f"  ruisreductie: aan ({DENOISE_DB} dB) via {_FFMPEG}")
    outdir = os.path.join(root, "assets", "channels", channel, "voice", story_id, voice)
    os.makedirs(outdir, exist_ok=True)
    made = []; durs = {}; sents_by = {}
    for num, tone, screen, voiceline in story["scenes"]:
        if only >= 0 and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        try:
            segs, sp0, sp1, diag = _synthesize_scene(ref_abs, voiceline, t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        if tone == "intro":
            _prepend_silence(wav, LEAD_SILENCE)
            segs = [(round(st + LEAD_SILENCE, 3), dd) for (st, dd) in segs]
            sp0 = round(sp0 + LEAD_SILENCE, 3); sp1 = round(sp1 + LEAD_SILENCE, 3)
        d = _wav_duration(wav)
        durs[num] = d; sents_by[num] = (segs, sp0, sp1)
        made.append((num, wav)); print(f"  scene {num:02d} [{tone}] {d:6.2f}s, {len(segs)} zin(nen) -> {wav}")
        # CONTROLE per blok: schoon + netjes in stilte geeindigd, of mogelijk afgekapt
        for (gidx, exp, got, clean, tail_ok) in diag:
            zin = "zin " + "+".join(str(i + 1) for i in gidx)
            vlag = "OK" if (clean and tail_ok) else ("afgekapt?" if not tail_ok else "ruis?")
            print(f"      {zin:<10} verwacht ~{exp:4.1f}s  kreeg {got:4.1f}s  "
                  f"{'schoon' if clean else 'overgedaan/vuil'}  "
                  f"{'eindigt in stilte' if tail_ok else 'EINDIGT IN GELUID'}  [{vlag}]")

    # ALTIJD de tijdlijn/import schrijven voor wat gemaakt is (ook bij een enkele --only scene).
    lines = [f"title: {story['title']}", "view: belt"] + story["groups"]
    by = {num: wav for num, wav in made}
    caption_by = {num: voiceline for (num, tone, screen, voiceline) in story["scenes"]}
    for num, screen, mapspec in story["map"]:
        if num not in by:
            continue
        parts = [f"scene {num}", screen] + list(mapspec)
        if caption_by.get(num):
            parts.append("caption: " + caption_by[num])
        parts.append("voice: " + os.path.relpath(by[num], root).replace("\\", "/"))
        lines.append(" | ".join(parts))
    imp = os.path.join(outdir, f"_import-{voice}.txt")
    with open(imp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    tone_by = {num: tone for (num, tone, screen, voiceline) in story["scenes"]}
    line_by = {num: voiceline for (num, tone, screen, voiceline) in story["scenes"]}
    tl_scenes = []; abs_t = 0.0
    for num, _wav in made:
        segs, sp0, sp1 = sents_by.get(num, (None, 0.0, durs.get(num, 0.0)))
        lines_s = _sentences(line_by.get(num, ""))
        sentences = []
        if segs:
            for i, (st, dd) in enumerate(segs):
                sentences.append({"i": i, "text": lines_s[i] if i < len(lines_s) else "",
                                  "start": st, "dur": dd, "abs_start": round(abs_t + st, 3)})
        tl_scenes.append({
            "scene": num, "tone": tone_by.get(num, ""),
            "wav": os.path.relpath(by[num], root).replace("\\", "/") if by.get(num) else "",
            "start": round(abs_t, 3), "dur": round(durs.get(num, 0.0), 3),
            "speech_start": sp0, "speech_end": sp1,
            "sentences": sentences, "beats": [], "sfx": [],
        })
        abs_t += durs.get(num, 0.0)
    timeline = {"story": story_id, "voice": voice, "format": fmt, "title": story["title"],
                "total_seconds": round(abs_t, 3), "total_mmss": f"{int(abs_t)//60}:{int(abs_t)%60:02d}",
                "scenes": tl_scenes}
    tj = os.path.join(outdir, "_timeline.json")

    # Bij een enkele --only her-render NIET de volledige tijdlijn overschrijven met
    # alleen die ene scene (anders raakt de timing van de rest van de video kwijt).
    # In plaats daarvan de bestaande volledige tijdlijn inladen, alleen de opnieuw
    # gemaakte scene(s) vervangen, en alle absolute starttijden opnieuw doorrekenen.
    if only >= 0 and os.path.isfile(tj):
        try:
            with open(tj, encoding="utf-8") as f:
                base = json.load(f)
            old_scenes = base.get("scenes", [])
            if old_scenes:
                new_by = {s["scene"]: s for s in tl_scenes}
                merged = [new_by.get(s.get("scene"), s) for s in old_scenes]
                for num_new, s_new in new_by.items():
                    if not any(s.get("scene") == num_new for s in old_scenes):
                        merged.append(s_new)
                merged.sort(key=lambda s: s.get("scene", 0))
                t = 0.0
                for s in merged:
                    s["start"] = round(t, 3)
                    for sent in s.get("sentences", []):
                        sent["abs_start"] = round(t + sent.get("start", 0.0), 3)
                    t += s.get("dur", 0.0)
                base["scenes"] = merged
                base["total_seconds"] = round(t, 3)
                base["total_mmss"] = f"{int(t)//60}:{int(t)%60:02d}"
                timeline = base
                tl_scenes = merged
        except Exception as e:
            print(f"      (tijdlijn-merge overgeslagen, volledige herschrijf: {e})")

    with open(tj, "w", encoding="utf-8") as f:
        json.dump(timeline, f, ensure_ascii=False, indent=2)
    print(f"  tijdlijn: {tj}  ({len(tl_scenes)} scene(s), {sum(len(s['sentences']) for s in tl_scenes)} zinnen)")
    print(f"  klaar: {len(made)} fragment(en)")

def main():
    global DENOISE, DENOISE_DB
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="chose")
    ap.add_argument("--voice", default="alle", choices=list(VOICES.keys()) + ["alle"])
    ap.add_argument("--only", type=int, default=-1, help="alleen scene-nummer N (0 is geldig); -1 = alle")
    ap.add_argument("--format", dest="fmt", default="16:9", choices=["16:9", "9:16"])
    ap.add_argument("--root", default=".")
    ap.add_argument("--channel", default="channel1")
    ap.add_argument("--no-denoise", dest="denoise", action="store_false", help="ruisreductie uit")
    ap.add_argument("--denoise-db", type=int, default=DENOISE_DB, help="dB ruisreductie (zacht ~12)")
    args = ap.parse_args()
    DENOISE = args.denoise
    DENOISE_DB = args.denoise_db

    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox is niet geinstalleerd. Doe eerst:  pip install chatterbox-tts soundfile")
        sys.exit(1)

    if args.story not in STORIES:
        print("onbekend verhaal:", args.story); sys.exit(1)
    voices = list(VOICES.keys()) if args.voice == "alle" else [args.voice]
    for voice in voices:
        scope = f"scene {args.only}" if args.only >= 0 else "alle scenes"
        print(f"\n=== {args.story} - STEM: {voice} ({VOICES[voice]}) - {scope} - {args.fmt} ===")
        build_story(args.story, voice, args.root, args.only, args.fmt, args.channel)

if __name__ == "__main__":
    main()
