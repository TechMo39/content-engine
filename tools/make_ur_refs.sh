#!/usr/bin/env bash
# make_ur_refs.sh - maakt SCHONE stem-referenties voor de UR-renders.
# Van elke "NL commercial*.mp4" in Downloads: audio eruit -> Demucs isoleert de STEM
# (muziekje + achtergrondruis eruit) -> definitieve referentie als mono 24 kHz wav,
# rechtstreeks in de BESTAANDE map voice-test/refs/.
#
# Deze stap MOET lokaal (op jouw laptop): Demucs haalt z'n model van internet, en dat
# kan Claude's cloud-omgeving niet (geblokkeerd) - jouw laptop wel.
#
# EENMALIG vooraf:  pip install demucs
# Draaien (vanuit ~/Desktop/content-engine):  bash tools/make_ur_refs.sh
set -e

ROOT="$HOME/Desktop/content-engine"
FF="$ROOT/node_modules/ffmpeg-static/ffmpeg.exe"
SRC="$HOME/Downloads"                 # waar jouw 9 video's staan
DEST="$ROOT/voice-test/refs"          # BESTAANDE refs-map (hier komen de kant-en-klare wavs)
TMP="$(mktemp -d)"; RAW="$TMP/raw"; SEP="$TMP/sep"
mkdir -p "$RAW" "$SEP"
[ -d "$DEST" ] || { echo "FOUT: $DEST bestaat niet - klopt het pad naar content-engine?"; exit 1; }

shopt -s nullglob
found=0
for f in "$SRC"/NL\ commercial*.mp4; do
  found=1
  base="$(basename "${f%.*}")"; safe="${base// /_}"
  echo ">> audio eruit: $base"
  "$FF" -y -i "$f" -vn -ac 2 -ar 44100 "$RAW/$safe.wav" >/dev/null 2>&1
done
if [ "$found" -eq 0 ]; then
  echo "GEEN 'NL commercial*.mp4' gevonden in $SRC - staan ze daar wel?"; rm -rf "$TMP"; exit 1
fi

# STEM isoleren met Demucs (muziek + ruis eruit). CPU = traag, dus even geduld per clip.
echo ">> stem isoleren met Demucs (eerste keer: model-download; daarna een paar min per clip)..."
python -m demucs --two-stems=vocals -o "$SEP" "$RAW"/*.wav

# geisoleerde stem -> definitieve referentie: mono, 24 kHz, in voice-test/refs/
for v in "$SEP"/htdemucs/*/vocals.wav; do
  name="$(basename "$(dirname "$v")")"
  "$FF" -y -i "$v" -ac 1 -ar 24000 "$DEST/$name.wav" >/dev/null 2>&1
  echo "   klaar: voice-test/refs/$name.wav"
done

rm -rf "$TMP"
echo ""
echo "ALLE REFERENTIES staan nu in: voice-test/refs/"
echo "(mono, 24 kHz, alleen stem). De originele video's in Downloads blijven staan."
