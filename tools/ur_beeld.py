#!/usr/bin/env python3
# ur_beeld.py - zoekt op basis van het script per kaart RECHTENVRIJ beeld en zet het klaar als
# achtergrond voor een UncleRank-thema (nu: "De kring"). Video via Pixabay/Pexels, anders een foto
# via Wikimedia Commons. HERGEBRUIKT tools/channel_beeld.py (Truthward): exact dezelfde zoek-,
# download- en normaliseer-functies, zodat het beeld net zo betrouwbaar binnenkomt als bij de channel.
#
# Draait LOKAAL op Mo's laptop (internet nodig). Faalt een zoekterm, dan komt die kaart niet in de
# manifest en valt de render voor die kaart terug op de gewone tekstkaart. Additief: het breekt niks.
#
# Gebruik (door de engine aangeroepen, niet handmatig):
#   python tools/ur_beeld.py --type kring --variant 0 --queries '["handshake office","team meeting"]' --root .
import argparse, os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_beeld' importeerbaar is
import channel_beeld as cb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", required=True, help="UR-thema, bv. kring")
    ap.add_argument("--variant", type=int, default=0)
    ap.add_argument("--queries", required=True, help="JSON-lijst met zoektermen, één per kaart; lege string = overslaan")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    try:
        queries = json.loads(args.queries)
        if not isinstance(queries, list):
            raise ValueError("queries moet een lijst zijn")
    except Exception as e:
        print("kon --queries niet lezen:", e); sys.exit(1)

    keys = cb.load_keys(args.root)
    if not (keys.get("pixabay") or keys.get("pexels")):
        print("  (geen Pixabay/Pexels-sleutel; alleen Wikimedia-foto's)")
    outdir = os.path.join(args.root, "assets", "unclerank", "beeld", args.type, f"v{args.variant}")
    os.makedirs(outdir, exist_ok=True)

    manifest = []
    for i, q in enumerate(queries):
        q = (q or "").strip()
        if not q:
            continue
        print(f"=== beeld {i}: '{q}' ===")
        got = None
        # 1) liefst video (liggend, rechtenvrij)
        try:
            hit = cb.search_video(q, keys, min_dur=2)
            if hit and hit.get("url"):
                raw = cb._get(hit["url"])
                fp = os.path.join(outdir, f"clip-{i}.mp4")
                with open(fp, "wb") as f:
                    f.write(raw)
                cb.normalize_video(fp, args.root)   # naar <=1080p/30fps, zelfde codec; overal afspeelbaar
                got = {"i": i, "kind": "vid", "file": os.path.basename(fp),
                       "credit": hit.get("credit", ""), "license": hit.get("license", "")}
                print(f"    video ok ({hit.get('credit', '')})")
        except Exception as e:
            print(f"    video-fout: {e}")
        # 2) anders een foto (Wikimedia Commons: publiek domein + CC)
        if not got:
            try:
                im = cb.search_image(q)
                if im and im.get("url"):
                    raw = cb._get(im["url"])
                    ext = cb.ext_for(im.get("mime", "image/jpeg"))
                    fp = os.path.join(outdir, f"img-{i}{ext}")
                    with open(fp, "wb") as f:
                        f.write(raw)
                    got = {"i": i, "kind": "img", "file": os.path.basename(fp),
                           "credit": im.get("credit", ""), "license": im.get("license", "")}
                    print("    foto ok")
            except Exception as e:
                print(f"    foto-fout: {e}")
        if got:
            manifest.append(got)
        else:
            print("    niets gevonden, deze kaart blijft tekst")

    with open(os.path.join(outdir, "_beeld.json"), "w", encoding="utf-8") as f:
        json.dump({"type": args.type, "variant": args.variant, "items": manifest}, f, ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, "_queries.json"), "w", encoding="utf-8") as f:
        json.dump(queries, f, ensure_ascii=False)
    gewenst = len([q for q in queries if (q or "").strip()])
    print(f"klaar: {len(manifest)}/{gewenst} beelden gevonden")


if __name__ == "__main__":
    main()
