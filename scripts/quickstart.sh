#!/usr/bin/env sh
# The quickstart, automated. Needs only curl and sed.
#   SV_KEY=sv_test_... ./scripts/quickstart.sh
#   SV_KEY=... SV_API=http://localhost:3000 ./scripts/quickstart.sh
set -eu
API="${SV_API:-http://localhost:3000}"
: "${SV_KEY:?set SV_KEY to an API key from the dashboard (API keys page)}"

field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }

echo "1. Creating a generation..."
CREATED=$(curl -sS -X POST "$API/v1/generations" \
  -H "Authorization: Bearer $SV_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: quickstart-$(date +%s)" \
  -d '{"prompt":"uplifting acoustic pop for a travel vlog, warm guitars","duration_sec":30,"license":"royalty_free","instrumental":true}')
ID=$(printf '%s' "$CREATED" | field id)
if [ -z "$ID" ]; then echo "   failed: $CREATED"; exit 1; fi
echo "   $ID queued"

echo "2. Waiting for it to finish (polling every 3s)..."
i=0
while :; do
  JOB=$(curl -sS "$API/v1/generations/$ID" -H "Authorization: Bearer $SV_KEY")
  STATUS=$(printf '%s' "$JOB" | field status)
  echo "   status: $STATUS"
  case "$STATUS" in
    succeeded) break ;;
    failed|canceled) echo "   $JOB"; exit 1 ;;
  esac
  i=$((i + 1)); [ "$i" -lt 100 ] || { echo "   timed out"; exit 1; }
  sleep 3
done

URL=$(printf '%s' "$JOB" | field audio_url | sed 's/\\u0026/\&/g')
EXT=$(printf '%s' "$JOB" | field format)
OUT="$ID.${EXT:-mp3}"
echo "3. Downloading the audio (signed URL, expires in 1h)..."
curl -sS -o "$OUT" "$URL"
echo "   saved $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
echo "Done. Open $OUT to listen."
