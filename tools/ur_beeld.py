#!/usr/bin/env python3
# ur_beeld.py - zoekt op basis van het script per kaart RECHTENVRIJ beeld en zet er PER KAART MEERDERE
# klaar (een poel), zodat de render elke keer automatisch een vers beeld kan kiezen. Video via
# Pixabay/Pexels, anders foto's via Wikimedia Commons. HERGEBRUIKT tools/channel_beeld.py (Truthward):
# exact dezelfde zoek-, download- en normaliseer-functies, dus net zo betrouwbaar als bij de channel.
#
# Zelfroterend: het ophalen gebeurt ÉÉN keer (de poel wordt gecachet). Daarna rouleert de engine per
# render een vers beeld uit de poel (zelfde anti-herhaling als de varianten). Niemand hoeft zoektermen
# te onderhouden. Pas pas iets aan als je een heel andere invalshoek wilt.
#
# Draait LOKAAL op Mo's laptop (internet nodig). Vindt een zoekterm niks, of draait dit zonder net
# (cloud), dan blijft die kaart gewoon tekst. Additief: het breekt niks.
#
# Gebruik (door de engine aangeroepen):
#   python tools/ur_beeld.py --type kring --variant 0 --queries '["handshake office", ["team meeting","colleagues talking"]]' --per 5 --root .
import argparse, os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_beeld' importeerbaar is
import channel_beeld as cb


def _as_list(q):
    # een kaart mag één zoekterm hebben of meerdere (rijkere poel); normaliseer naar een lijst strings
    if isinstance(q, list):
        return [str(x).strip() for x in q if str(x).strip()]
    q = (q or "").strip()
    return [q] if q else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", required=True, help="UR-thema, bv. kring")
    ap.add_argument("--variant", type=int, default=0)
    ap.add_argument("--queries", required=True, help="JSON-lijst; per kaart een string OF een lijst strings; leeg = overslaan")
    ap.add_argument("--per", type=int, default=5, help="hoeveel beelden per kaart klaarzetten (de poel om uit te rouleren)")
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

    PER = max(1, int(args.per))
    manifest = []
    for i, raw in enumerate(queries):
        terms = _as_list(raw)
        if not terms:
            continue
        print(f"=== kaart {i}: {terms} ===")
        pool = []           # lijst van {kind, file, credit, license}
        seen_urls = set()
        j = 0

        def _save_video(hit):
            nonlocal j
            url = hit.get("url")
            if not url or url in seen_urls:
                return False
            seen_urls.add(url)
            fp = os.path.join(outdir, f"clip-{i}-{j}.mp4")
            cb_bytes = cb._get(url)
            with open(fp, "wb") as f:
                f.write(cb_bytes)
            cb.normalize_video(fp, args.root)
            pool.append({"kind": "vid", "file": os.path.basename(fp),
                         "credit": hit.get("credit", ""), "license": hit.get("license", "")})
            j += 1
            return True

        def _save_image(im):
            nonlocal j
            url = im.get("url")
            if not url or url in seen_urls:
                return False
            seen_urls.add(url)
            ext = cb.ext_for(im.get("mime", "image/jpeg"))
            fp = os.path.join(outdir, f"img-{i}-{j}{ext}")
            raw_bytes = cb._get(url)
            with open(fp, "wb") as f:
                f.write(raw_bytes)
            pool.append({"kind": "img", "file": os.path.basename(fp),
                         "credit": im.get("credit", ""), "license": im.get("license", "")})
            j += 1
            return True

        # 1) liefst video's (beweging), verdeeld over de zoektermen van deze kaart
        per_term = max(1, PER // max(1, len(terms)))
        for t in terms:
            if len(pool) >= PER:
                break
            try:
                for hit in cb.search_video_many(t, keys, n=per_term + 1, min_dur=2):
                    if len(pool) >= PER:
                        break
                    try:
                        _save_video(hit)
                    except Exception as e:
                        print(f"    video-download fout: {e}")
            except Exception as e:
                print(f"    video-zoekfout '{t}': {e}")
        # 2) poel aanvullen met foto's als er nog ruimte is
        if len(pool) < PER:
            for t in terms:
                if len(pool) >= PER:
                    break
                try:
                    for im in cb.search_image_many(t, n=per_term + 1):
                        if len(pool) >= PER:
                            break
                        try:
                            _save_image(im)
                        except Exception as e:
                            print(f"    foto-download fout: {e}")
                except Exception as e:
                    print(f"    foto-zoekfout '{t}': {e}")

        if pool:
            manifest.append({"i": i, "media": pool})
            print(f"    poel: {len(pool)} beeld(en)")
        else:
            print("    niets gevonden, deze kaart blijft tekst")

    with open(os.path.join(outdir, "_beeld.json"), "w", encoding="utf-8") as f:
        json.dump({"type": args.type, "variant": args.variant, "per": PER, "items": manifest}, f, ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, "_queries.json"), "w", encoding="utf-8") as f:
        json.dump({"queries": queries, "per": PER}, f, ensure_ascii=False)
    gewenst = len([q for q in queries if _as_list(q)])
    total = sum(len(it["media"]) for it in manifest)
    print(f"klaar: {len(manifest)}/{gewenst} kaarten met beeld, {total} beelden in totaal")


if __name__ == "__main__":
    main()
