#!/usr/bin/env python3
# ur_beeld.py - zoekt op basis van het script per kaart RECHTENVRIJ beeld en zet er PER KAART MEERDERE
# klaar (een poel), zodat de render elke keer automatisch een vers beeld kan kiezen.
#
# GERICHT (v2): voor UncleRank willen we ZAKELIJK beeld, geen huiselijke/decoratieve stock. Daarom:
#   - zoekt in Pixabay's categorie "business",
#   - gooit treffers weg met huiselijke/eten-/natuur-tags (koffiemok, keuken, eten, huisdier, strand…)
#     tenzij de zoekterm daar zelf om vraagt,
#   - neemt ALLEEN video (geen willekeurige foto's). Vindt een kaart niks, dan komt die niet in de
#     manifest en valt de render terug op de schone tekstkaart. Zo nooit meer een random mok in beeld.
# Foto's (Wikimedia) alleen met --allowphotos (standaard uit).
#
# HERGEBRUIKT tools/channel_beeld.py (Truthward) voor downloaden/normaliseren/relevantie — die laat ik
# ongemoeid (de channel blijft werken). De strengere business-zoek zit hier.
#
# Zelfroterend: ophalen gebeurt ÉÉN keer (poel gecachet); de engine rouleert per render. Draait LOKAAL
# (internet nodig). Geen sleutel/zonder net = niks gevonden = alles tekst.
#
# Gebruik (door de engine):
#   python tools/ur_beeld.py --type kring --variant 0 --queries '["business team meeting office", ...]' --per 5 --root .
import argparse, os, sys, json, re, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # zodat 'channel_beeld' importeerbaar is
import channel_beeld as cb

# huiselijke / eten / natuur / vrije-tijd tags die niet bij een B2B-marketingverhaal passen
BAD_TAGS = {
    "coffee", "cup", "mug", "tea", "kitchen", "food", "cake", "dessert", "drink", "breakfast",
    "lunch", "dinner", "cooking", "restaurant", "cafe", "bar", "alcohol", "wine", "beer", "cocktail",
    "fruit", "vegetable", "home", "house", "bedroom", "living", "sofa", "couch", "baby", "child",
    "children", "kid", "toddler", "pet", "dog", "cat", "animal", "bird", "flower", "garden", "plant",
    "nature", "forest", "tree", "mountain", "beach", "sea", "ocean", "sunset", "sky", "snow",
    "wedding", "party", "holiday", "christmas", "birthday", "gym", "fitness", "yoga", "sport",
    "game", "toy", "fashion", "makeup", "hair", "candle", "decoration",
}


def _as_list(q):
    if isinstance(q, list):
        return [str(x).strip() for x in q if str(x).strip()]
    q = (q or "").strip()
    return [q] if q else []


def _tags_ok(tags, query):
    # keur een treffer af als z'n tags huiselijk/eten/natuur zijn EN de zoekterm daar zelf niet om vraagt
    t = set(re.findall(r"[a-z]+", (tags or "").lower()))
    qs = set(re.findall(r"[a-z]+", (query or "").lower()))
    return not ((t & BAD_TAGS) - qs)


def search_video_business(query, keys, n=5, min_dur=2):
    # ZAKELIJKE liggende video's: eerst categorie business, daarna aanvullen zonder categorie; overal
    # de huiselijke/eten-tags eruit. Gesorteerd op tag-relevantie, dan resolutie. Pixabay only.
    if not keys.get("pixabay"):
        return []

    def run(params):
        try:
            d = cb._getj("https://pixabay.com/api/videos/?" + urllib.parse.urlencode(params))
            return d.get("hits", []) or []
        except Exception as e:
            print(f"    pixabay-fout: {e}")
            return []

    base = {"key": keys["pixabay"], "q": query, "per_page": 50, "safesearch": "true"}
    hits = run({**base, "category": "business"})
    if len(hits) < n:
        hits = hits + run(base)   # categorie te smal? vul aan, maar met dezelfde tag-filter
    scored, seen = [], set()
    for h in hits:
        hid = h.get("id")
        if hid in seen:
            continue
        seen.add(hid)
        if min_dur and h.get("duration", 0) < min_dur:
            continue
        if not _tags_ok(h.get("tags", ""), query):
            continue
        vids = h.get("videos", {}) or {}
        best = None
        for size in ("large", "medium", "small"):
            v = vids.get(size)
            if v and v.get("url") and v.get("width", 0) >= v.get("height", 0) and v.get("width", 0) >= 1280:
                best = v
                break
        if not best:
            continue
        rel = cb._relevance(h.get("tags", ""), query)
        scored.append((rel, best.get("width", 0), {"url": best["url"], "ext": ".mp4",
                       "credit": h.get("user", "Pixabay"), "license": "Pixabay License (free)"}))
    scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
    return [s[2] for s in scored[:n]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", required=True)
    ap.add_argument("--variant", type=int, default=0)
    ap.add_argument("--queries", required=True, help="JSON-lijst; per kaart een string OF lijst strings; leeg = overslaan")
    ap.add_argument("--per", type=int, default=5, help="poelgrootte per kaart")
    ap.add_argument("--allowphotos", action="store_true", help="sta Wikimedia-foto's toe als er geen zakelijke video is (standaard uit)")
    ap.add_argument("--root", default=".")
    args = ap.parse_args()

    try:
        queries = json.loads(args.queries)
        if not isinstance(queries, list):
            raise ValueError("queries moet een lijst zijn")
    except Exception as e:
        print("kon --queries niet lezen:", e); sys.exit(1)

    keys = cb.load_keys(args.root)
    if not keys.get("pixabay"):
        print("  (geen Pixabay-sleutel — zonder sleutel geen zakelijke video; alles blijft tekst)")
    outdir = os.path.join(args.root, "assets", "unclerank", "beeld", args.type, f"v{args.variant}")
    os.makedirs(outdir, exist_ok=True)

    PER = max(1, int(args.per))
    manifest = []
    for i, raw in enumerate(queries):
        terms = _as_list(raw)
        if not terms:
            continue
        print(f"=== kaart {i}: {terms} ===")
        pool, seen = [], set()
        j = 0

        def _save_video(hit):
            nonlocal j
            url = hit.get("url")
            if not url or url in seen:
                return
            seen.add(url)
            fp = os.path.join(outdir, f"clip-{i}-{j}.mp4")
            with open(fp, "wb") as f:
                f.write(cb._get(url))
            cb.normalize_video(fp, args.root)
            pool.append({"kind": "vid", "file": os.path.basename(fp),
                         "credit": hit.get("credit", ""), "license": hit.get("license", "")})
            j += 1

        # ZAKELIJKE video's, verdeeld over de zoektermen van deze kaart
        per_term = max(1, PER // max(1, len(terms)))
        for t in terms:
            if len(pool) >= PER:
                break
            for hit in search_video_business(t, keys, n=per_term + 1, min_dur=2):
                if len(pool) >= PER:
                    break
                try:
                    _save_video(hit)
                except Exception as e:
                    print(f"    video-download fout: {e}")

        # optioneel: pas als expliciet toegestaan, en alleen als er nog niks is, een nette foto
        if args.allowphotos and not pool:
            for t in terms:
                try:
                    for im in cb.search_image_many(t, n=per_term + 1):
                        if len(pool) >= PER:
                            break
                        if not _tags_ok(im.get("title", ""), t):
                            continue
                        url = im.get("url")
                        if not url or url in seen:
                            continue
                        seen.add(url)
                        ext = cb.ext_for(im.get("mime", "image/jpeg"))
                        fp = os.path.join(outdir, f"img-{i}-{j}{ext}")
                        with open(fp, "wb") as f:
                            f.write(cb._get(url))
                        pool.append({"kind": "img", "file": os.path.basename(fp),
                                     "credit": im.get("credit", ""), "license": im.get("license", "")})
                        j += 1
                except Exception as e:
                    print(f"    foto-fout '{t}': {e}")
                if len(pool) >= PER:
                    break

        if pool:
            manifest.append({"i": i, "media": pool})
            print(f"    poel: {len(pool)} zakelijk beeld")
        else:
            print("    niks zakelijks gevonden, deze kaart blijft tekst")

    with open(os.path.join(outdir, "_beeld.json"), "w", encoding="utf-8") as f:
        json.dump({"type": args.type, "variant": args.variant, "per": PER, "items": manifest}, f, ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, "_queries.json"), "w", encoding="utf-8") as f:
        json.dump({"queries": queries, "per": PER}, f, ensure_ascii=False)
    gewenst = len([q for q in queries if _as_list(q)])
    total = sum(len(it["media"]) for it in manifest)
    print(f"klaar: {len(manifest)}/{gewenst} kaarten met zakelijk beeld, {total} clips in totaal")


if __name__ == "__main__":
    main()
