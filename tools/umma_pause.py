#!/usr/bin/env python3
# umma_pause.py — voegt ADEMRUIMTE (stilte) toe binnen een scène, op een zin-grens, en schuift de
# tijdlijn netjes op. Draait NA umma_voice en VOOR umma_beeld/umma_audio, zodat beeld/muziek/effecten
# daarna vanzelf op de nieuwe tijden vallen.
#
# De pauzes staan in PAUSES (per scène, inhoud-gestuurd — hier bepaald). Zo blijft de stem één
# vloeiende opname per scène; we knippen er alleen een stilte tussen op het gekozen punt.
#
# Draaien:  python tools/umma_pause.py --voice man
import argparse, os, json, struct

# PAUZES per scène: lijst van {"na": zin-index, "sec": seconden}. "na" = na die zin valt de stilte.
# Inhoud-gestuurd: op dramatische punten even laten landen.
PAUSES = {
    1:  [{"na": 2, "sec": 0.5}, {"na": 6, "sec": 0.4}],   # na "Convert, or die." en "Remember that rule."
    4:  [{"na": 5, "sec": 0.4}],                           # na "Baptism, or ruin."
    9:  [{"na": 8, "sec": 0.5}],                           # na "This was the sword, finally, for real." (voor "So, did it work?")
    10: [{"na": 0, "sec": 0.5}],                           # na "No."
    11: [{"na": 6, "sec": 0.4}],                           # na "It lived in the heart."
    13: [{"na": 10, "sec": 0.4}],                          # na "It is the proof."
    15: [{"na": 4, "sec": 0.4}],                           # na "It only ever needed to be seen."
}


def _wav_parts(path):
    d = open(path, "rb").read()
    if d[:4] != b"RIFF" or d[8:12] != b"WAVE":
        raise ValueError("geen WAV: " + path)
    i = 12; fmt = None; doff = dlen = None
    while i + 8 <= len(d):
        cid = d[i:i+4]; clen = struct.unpack_from("<I", d, i+4)[0]
        if cid == b"fmt ": fmt = d[i+8:i+8+clen]
        elif cid == b"data": doff = i+8; dlen = clen
        i += 8 + clen + (clen & 1)
    if fmt is None or doff is None:
        raise ValueError("WAV mist fmt/data: " + path)
    ch = struct.unpack_from("<H", fmt, 2)[0]
    sr = struct.unpack_from("<I", fmt, 4)[0]
    bits = struct.unpack_from("<H", fmt, 14)[0]
    block = ch * (bits // 8)   # bytes per frame
    return d, doff, dlen, sr, block


def insert_silence(path, at_sec, dur_sec):
    """Voegt dur_sec stilte toe op tijdstip at_sec in de wav (stilte = nul-bytes, werkt voor PCM en float)."""
    d, doff, dlen, sr, block = _wav_parts(path)
    at = doff + max(0, min(dlen, int(round(at_sec * sr)) * block))
    nbytes = int(round(dur_sec * sr)) * block
    new = bytearray(d[:at] + b"\x00" * nbytes + d[at:])
    struct.pack_into("<I", new, doff - 4, dlen + nbytes)   # data-chunk grootte
    struct.pack_into("<I", new, 4, len(new) - 8)           # RIFF grootte
    open(path, "wb").write(new)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--story", default="sword")
    ap.add_argument("--voice", default="man")
    a = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    vdir = os.path.join(root, "assets", "ummaunited", "voice", a.story, a.voice)
    tlpath = os.path.join(vdir, "_timeline.json")
    if not os.path.exists(tlpath):
        print("geen _timeline.json — draai eerst umma_voice.py"); return
    tl = json.load(open(tlpath, encoding="utf-8"))

    n_applied = 0
    for sc in tl.get("scenes", []):
        num = sc.get("scene")
        plan = PAUSES.get(num)
        if not plan:
            continue
        sents = sc.get("sentences") or []
        wav = os.path.join(root, sc.get("wav", "").replace("/", os.sep))
        if not (sc.get("wav") and os.path.exists(wav)):
            print(f"scène {num}: wav ontbreekt, pauze overgeslagen"); continue
        # pauzes van ACHTER naar VOREN toepassen, zodat eerdere inserts de latere posities niet verschuiven
        for pz in sorted(plan, key=lambda p: p["na"], reverse=True):
            ni = pz["na"]; sec = float(pz["sec"])
            if ni >= len(sents):
                print(f"scène {num}: zin {ni} bestaat niet, overgeslagen"); continue
            # de stilte valt op het eind van zin ni (= start van de volgende zin, of het eind van de spraak)
            cut = sents[ni]["start"] + sents[ni]["dur"] if (ni + 1 >= len(sents)) else sents[ni + 1]["start"]
            insert_silence(wav, cut, sec)
            # tijdlijn bijwerken: alles ná de knip schuift op binnen de scène
            for j in range(ni + 1, len(sents)):
                sents[j]["start"] = round(sents[j]["start"] + sec, 3)
            sc["dur"] = round(sc.get("dur", 0.0) + sec, 3)
            if sc.get("speech_end") is not None:
                sc["speech_end"] = round(sc["speech_end"] + sec, 3)
            n_applied += 1
            print(f"scène {num}: +{sec:.2f}s stilte na zin {ni}")

    # absolute tijden herberekenen (scènes achter elkaar, zinnen binnen de scène)
    abs_t = 0.0
    for sc in tl.get("scenes", []):
        sc["start"] = round(abs_t, 3)
        for se in sc.get("sentences", []):
            se["abs_start"] = round(abs_t + se["start"], 3)
        abs_t += sc.get("dur", 0.0)
    tl["total_seconds"] = round(abs_t, 3)
    tl["total_mmss"] = f"{int(abs_t)//60}:{int(abs_t)%60:02d}"

    json.dump(tl, open(tlpath, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\nKlaar: {n_applied} pauze(s) toegevoegd. Nieuwe totale duur: {tl['total_mmss']}")
    print("Nu umma_beeld.py en umma_audio.py (opnieuw) draaien, dan kloppen beeld + muziek op de nieuwe tijden.")


if __name__ == "__main__":
    main()
