#!/usr/bin/env python3
# channel_voice.py — genereert per scène een voice-over-fragment met CHATTERBOX (lokaal, CPU),
# gekloond van een REFERENTIE-stem. Per verhaal maken we DRIE stemmen (v1 / v2 / v3), elk uit een
# eigen referentie-wav, zodat je later IN DE STUDIO kiest welke stem de video krijgt. Elke stem is
# een eigen project (eigen map + eigen _timeline.json), dus kiezen in de studio = die stem laden.
#
# Draait LOKAAL op Mo's laptop (Git Bash, in ~/Desktop/content-engine):
#   python tools/channel_voice.py                      # verhaal "chose", alle 3 de stemmen
#   python tools/channel_voice.py --voice v2           # alleen stem v2
#   python tools/channel_voice.py --only 3             # alleen scène 3 opnieuw (alle stemmen)
#   python tools/channel_voice.py --story fitra        # NIEUW verhaal (zet eerst het script hieronder)
#   python tools/channel_voice.py --format 9:16        # de afgeleide short
#
# Chatterbox is eenmalig te installeren met:  pip install chatterbox-tts soundfile
# (zelfde content-engine als UncleRank; is die al eens gedraaid, dan staat Chatterbox er al.)
#
# De DRIE referentie-stemmen staan onderin bij VOICES. Een stem vervangen = die ene wav vervangen.
import argparse, os, sys, re, math, array, struct, json

# ---------------------------------------------------------------------------------------------
# DE DRIE STEMMEN. Elk is een korte, schone referentie-opname (24k mono) die Chatterbox kloont.
# De sleutel (v1/v2/v3) is tegelijk de projectnaam-stem waaronder de studio het toont.
VOICES = {
    "v1": "voice-test/refs/ref7.wav",
    "v2": "voice-test/refs/ref8.wav",
    "v3": "voice-test/refs/ref9.wav",
}
LANG = "en"   # Truthward = Engels

# Stilte VOORAAN de intro-wav (seconden): het logo staat zo eerst rustig in beeld voordat de stem
# begint. Pas dit getal aan voor een langere/kortere logo-hold aan het begin.
LEAD_SILENCE = 3.0

# Toon-presets: sil = extra STILTE (seconden) die we na het fragment aanplakken, zodat een gedachte
# kan landen (adem, niet bam-bam-bam). Chatterbox heeft geen tempo-knop; de rust zit in deze stiltes
# plus het PAUZE-plan hieronder. De engine voegt tussen scènes nog een adempauze toe (VOICE_PAD).
TONE = {
    "rustig": dict(sil=0.45),
    "nadruk": dict(sil=0.70),
    "warm":   dict(sil=0.85),
    "hook":   dict(sil=0.55),
    "intro":  dict(sil=0.60),
    "outro":  dict(sil=0.80),
}

# Chatterbox heeft een natuurlijke, gekloonde stem die ZELF adem en intonatie plaatst. Anders dan de
# vorige engine hoeven we dus NIET zin-voor-zin in te spreken met kunstmatige pauzes ertussen (traag
# en liet korte zinnen als "So." crashen). We spreken per CHUNK in: zinnen van een scène gegroepeerd
# tot stukken net onder de modellimiet, elk in EEN keer ingesproken en aan elkaar geplakt.
MAX_CHARS = 300   # veilige lengte per Chatterbox-aanroep (te korte stukjes crashen, te lange kappen af)

# ---------------------------------------------------------------------------------------------
# CHATTERBOX-MODEL. Eén keer laden per proces; de referentie-stem geven we per generate-call mee,
# dus hetzelfde model bedient alle drie de stemmen. Perth (de watermerk-laag) kan ontbreken of een
# bug geven op CPU; daarom zetten we vooraf een onschadelijke stub klaar als perth niet importeert.
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

def _synthesize(ref_abs, text, sil, out_wav):
    # één stuk tekst inspreken met de gekloonde stem en als standaard PCM-16 wav wegschrijven.
    import soundfile as sf
    m = _get_model()
    wav = m.generate(text, language_id=LANG, audio_prompt_path=ref_abs)
    sf.write(out_wav, wav.squeeze().detach().cpu().numpy(), m.sr, subtype="PCM_16")
    if sil and sil > 0:
        _append_silence(out_wav, sil)

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
    base = sum(_syllables(w) for w in re.findall(r"[A-Za-z']+", s))
    base += 0.6 * len(re.findall(r"[,;:]", s))   # interne pauzes kosten tijd
    base += 0.9                                  # zin-eind-pauze
    return max(base, 1.0)

def _group_sentences(sents, max_chars=MAX_CHARS):
    # Groepeer hele zinnen tot stukken net onder max_chars. Elk stuk onthoudt welke zin-indices erin
    # zitten, zodat we straks per zin de tijd kunnen schatten. Zo wordt een losse "So." nooit apart
    # ingesproken (dat crasht), maar samengevoegd met de buurzin.
    groups = []; cur = []; cur_idx = []; cur_len = 0
    for i, s in enumerate(sents):
        add = len(s) + (1 if cur else 0)
        if cur and cur_len + add > max_chars:
            groups.append((" ".join(cur), cur_idx)); cur = []; cur_idx = []; cur_len = 0
            add = len(s)
        cur.append(s); cur_idx.append(i); cur_len += add
    if cur:
        groups.append((" ".join(cur), cur_idx))
    return groups

def _synthesize_scene(ref_abs, scene_text, tail_sil, out_wav):
    # Spreek de scène in per CHUNK (niet per zin): Chatterbox plaatst de pauzes zelf. Plak de chunks
    # aan elkaar met een mini-adem ertussen, en zet achteraan een korte staart-stilte (tail_sil).
    # Lever een GESCHAT (start, duur) per zin terug (lettergreep-gewicht binnen de gemeten chunk-duur)
    # voor de ondertitel; in de studio kun je grenzen alsnog verschuiven.
    sents = _sentences(scene_text)
    if not sents:
        _synthesize(ref_abs, scene_text, tail_sil, out_wav)
        d = _wav_duration(out_wav); return [(0.0, round(d, 3))], 0.0, round(d, 3)
    groups = _group_sentences(sents)
    parts = []; seg = [None] * len(sents); cursor = 0.0
    GAP = 0.12   # mini-adem tussen chunks; de rest van het ritme doet Chatterbox zelf
    for gi, (text, idxs) in enumerate(groups):
        tmp = f"{out_wav}.g{gi:02d}.wav"
        _synthesize(ref_abs, text, 0.0, tmp)
        gdur = _wav_duration(tmp)
        weights = [_sent_weight(sents[i]) for i in idxs]; tot = sum(weights) or 1.0
        c = cursor
        for i, w in zip(idxs, weights):
            dd = gdur * (w / tot); seg[i] = (round(c, 3), round(dd, 3)); c += dd
        last = (gi == len(groups) - 1)
        if not last and GAP > 0:
            _append_silence(tmp, GAP)
        parts.append(tmp)
        cursor += gdur + (0.0 if last else GAP)
    if tail_sil and tail_sil > 0:
        _append_silence(parts[-1], tail_sil)
    _concat_wavs(parts, out_wav)
    for p in parts:
        try: os.remove(p)
        except Exception: pass
    segs = [s for s in seg if s is not None]
    sp0 = segs[0][0] if segs else 0.0
    sp1 = round(segs[-1][0] + segs[-1][1], 3) if segs else round(_wav_duration(out_wav), 3)
    return segs, sp0, sp1

# ---------------------------------------------------------------------------------------------
# WAV-HELPERS (byte-niveau, RIFF). Werken op de standaard PCM-16 wavs die soundfile schrijft:
# stilte aanplakken/voorzetten, exacte duur meten, en meerdere wavs naadloos aan elkaar plakken.
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

def _concat_wavs(paths, out_wav):
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

def _wav_duration(wav_path):
    # exacte duur (seconden): data_bytes / byteRate (offset 28), via dezelfde RIFF-logica.
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
    # plak stilte (nul-bytes) achter de data-chunk en werk de twee lengte-velden bij.
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
    # plak stilte VOORAAN (vóór de eerste zin): het logo staat zo eerst rustig in beeld.
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
# SCRIPT. Per scène: nummer, toon, ON-SCREEN kernzin, en de VOLLE gesproken zin (= de ondertitel).
# GEEN m-dashes in de tekst. Scène 0 = merk-intro MET de vaste CTA-aanzet (like / comment / share /
# subscribe), die in beeld samenloopt met de CTA-animatie + chimes tijdens de sterren-intro.
STORIES = {
  # VIDEO 1 — "The Answer You Never Chose". Engels, 16:9. De kijker denkt overal rationeel na, behalve
  # over de grootste vraag (ons bestaan): daar nam hij zijn antwoord blind over. Vijf deuren = HET
  # antwoord. Identiteit (scène 10) dicht de "ik ben nu volwassen"-tegenwerping. Slot bruggt naar
  # video 2 (absolute waarheid). Regels: islam nooit als antwoord, "de meeste mensen" niet "iedereen".
  "chose": {
    "title": "The Answer You Never Chose",
    "scenes": [
      (0,  "intro",  "Truthward",
           "Welcome to Truthward. This channel is new, and small, and honest about both. Here is what we do. We take the questions that are too large to fit into a normal day, the ones you feel for a second and then push aside, and we refuse to push them aside. One at a time. Slowly. We follow each one as far as it goes, even when it stops being comfortable. If that is something you have been quietly looking for, then the most useful thing you can do is come back. Like it only if it earned that. Disagree in the comments, because we would rather be corrected than left comfortable. And subscribe, so the next question reaches you instead of getting lost. That is all. Now take a breath. And let us begin."),
      (1,  "rustig", "You can think.",
           "Here is something that is true about you, right now, that you almost never stop to notice. You can think. A bird flying south chose nothing. The answer was built into it before it was born. Where to go. What to eat. What to run from. It never has to wonder. You are not built like that. You wake up in front of questions nothing prepared you for, and you have to work them out yourself. You weigh. You reason. You decide. That is a strange and quiet gift. And you use it every single day without once calling it remarkable."),
      (2,  "rustig", "A thousand calls a day.",
           "Most of the time you do not even feel it happening. You glance at the sky and you take a coat. Nothing to it. But slow it down. You read the world in front of you, you weighed it, and you made a call. You do that a thousand times before noon. You just never give it a name."),
      (3,  "nadruk", "Go to who knows.",
           "And the moment something actually matters, you get more careful, not less. A pain shows up and it does not leave. You do not guess. You do not open yourself up at the kitchen table. You stop, and you think one honest thought. I do not know enough about this. So I will go to someone who does. Sit with that, because it is the whole thing in one move. You saw the edge of your own knowing, and you walked toward someone who could see past it. That is not weakness. That is the most rational thing a person ever does."),
      (4,  "rustig", "Look first, decide after.",
           "And once you see it, you see it everywhere. You do not defend yourself in a courtroom on a hunch. You find someone who knows the law. You do not trust a bridge because it looks sturdy. Someone spent years proving it holds. The move never changes. You look first. You decide after. To just accept a thing, handed to you, and never once check it, would be reckless. And somewhere in you, you already know that."),
      (5,  "nadruk", "Except one question.",
           "Except there is one place where all of that stops. One question where the careful, checking, reasoning version of you simply does not show up. And it is not a small question. It is the largest one there is. Larger than your health. Larger than your money. Larger than anything you would ever stand in a courtroom to defend."),
      (6,  "nadruk", "Why are you here.",
           "Here it is. Why are you here. What is this. What happens when it ends. Do not rush past those. Sit in them for a second, because every other thing you do is standing on top of the answer you gave them. And on this one, the biggest of them all, most people never looked. Not once. They did not weigh it. They did not go to anyone who might know. They simply hold an answer. And when you ask them, gently, where it came from, the room goes quiet."),
      (7,  "warm",   "It was me.",
           "And I am not saying this from above anyone. I am saying it because it was me. I had my answer too. I carried it for years like it was mine, like I had earned it. Until one ordinary day I asked myself one simple thing. Did I ever once sit down with the biggest question there is and do what I would do for a crack in a wall. Actually look, before I trust it. And the honest answer was no. Never. It had been handed to me. And I had spent my whole life calling it mine."),
      (8,  "rustig", "Five doors.",
           "So I started paying attention. If people did not reason their way to this answer, then how did it get in. And as far as I can tell, it comes through five quiet doors. The first is home. Your parents believed something, or believed in nothing, and it was yours before you could speak. The second is a single moment. Something happened you could not explain, you took it as proof, and you never went back to it. The third is the people around you. Everyone leaned one way, and leaning with them was easier than standing alone. The fourth is the world itself. The films, the songs, the things school handed you as simply true. A thousand soft pushes you never felt as pushes. And the fifth is pain. Someone hurt you in the name of their answer, so you took the opposite one. Not because you weighed it. Because you were walking away from them."),
      (9,  "nadruk", "None of it is reasoning.",
           "Now look at those five honestly. Four of them are something arriving from outside you. One of them is you pushing something away. And not a single one of them is you sitting down and reasoning it through. And yet for most people, that is how they came to hold the most important thing they believe. One person swallowed it whole. The next spat it out just as fast. And both of them walked away certain that they had chosen."),
      (10, "nadruk", "But I am grown now.",
           "Now you might be thinking, fine, I was a child, I did not choose it then. But I am grown now. If it were wrong, I would have gone back and checked. And here is the uncomfortable part. Most of us never do. And it is not because we are not clever enough. It is that by now the answer is not just something you hold. It has grown into who you are. It is woven through the people you belong to. And when a thing sits that close to you, you do not test it. You guard it. You take the same sharp mind that picks the right doctor and you turn it around, and you point it at defending the answer instead of examining it. That is the trap. The sharper the mind, the better it gets at defending. It is not the careless who are most stuck here. Very often it is the brightest."),
      (11, "nadruk", "The answer.",
           "So. Why does the one creature that can think stop thinking, right here, on the question that matters most. I promised you an answer, so here it is, plainly. It is not that people are foolish. It is that an answer was already waiting for them. Through one of those five doors, something got filled in long before they arrived. There was never a blank page in front of them asking to be filled. And the one time they might have gone back to check, the answer had already become a part of them. So they guarded it instead. That is the answer. And I will be honest about mine. These are the five doors I could find. Maybe there is a sixth, and maybe you are the one who finds it. They are not carved in stone just because they came out of my head. That is the entire point of this channel. But look at them honestly, and ask yourself one thing. Is even one of them a reason to be sure of anything."),
      (12, "warm",   "Is any of it true?",
           "And this is where it starts to itch. If your answer to the largest question did not come from you, but from where you happened to be born, and who raised you, and what once hurt you, then how could you ever really know if it is true. Most people never reach that question. But most is not all. Some people do go back. Some do sit down with it. That is the only reason anyone has ever changed their mind about anything. So maybe you are one of the ones who looks. This time. And the second you try, something steps into the doorway. A quiet voice that says, who cares, it is all just opinion anyway. Your truth, my truth, nobody is really right. And if that is true, then this whole thing is pointless before it starts. So before we go anywhere near what the answer might be, we have to deal with that one first. Is there such a thing as a truth that stays true whether you believe it or not. Or is all of it just opinion. Until we have looked at that, honestly, nothing else we say has any ground to stand on. And that is exactly where we go next."),
      (13, "outro",  "Truthward",
           "If this gave you something to sit with tonight, then stay with us. We take one honest question at a time, and we follow it wherever it goes. No preaching. No noise. Just an honest look, from a channel that is only getting started. Subscribe, so the next one finds you. Comment with where you think this is wrong, because that is how we get sharper. And the next question we open is the one underneath all of this. Whether any truth can hold at all, no matter who believes it. I would be glad to have you there when we look."),
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
    durs = {}      # scène-nr -> gemeten duur (sec) van de voice-wav (incl. aangeplakte stilte)
    sents_by = {}  # scène-nr -> per-zin [(start, dur)] + speech-grenzen (het meetrooster)
    for num, tone, screen, voiceline in story["scenes"]:
        if only and num != only:
            continue
        t = TONE[tone]
        wav = os.path.join(outdir, f"{num:02d}.wav")
        try:
            segs, sp0, sp1 = _synthesize_scene(ref_abs, voiceline, t["sil"], wav)
        except Exception as e:
            print(f"  scene {num}: FOUT -> {e}"); continue
        # INTRO: stilte VOORAAN zodat het logo eerst rustig in beeld staat voordat de stem begint.
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

        # GEDEELDE TIJDLIJN: de ene databron die preview EN eindrender voedt. Per scène absolute
        # starttijd + duur, plus het per-zin-meetrooster (start/dur binnen de scène-wav).
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

    # vroege check: is Chatterbox geinstalleerd?
    try:
        import chatterbox.mtl_tts  # noqa
    except Exception:
        print("Chatterbox is niet geinstalleerd. Doe eerst:  pip install chatterbox-tts soundfile")
        sys.exit(1)

    if args.story not in STORIES:
        print("onbekend verhaal:", args.story); sys.exit(1)
    voices = list(VOICES.keys()) if args.voice == "alle" else [args.voice]
    for voice in voices:
        print(f"\n=== {args.story} · STEM: {voice} ({VOICES[voice]}) · FORMAAT: {args.fmt} ===")
        build_story(args.story, voice, args.root, args.only, args.fmt, args.channel)

if __name__ == "__main__":
    main()
