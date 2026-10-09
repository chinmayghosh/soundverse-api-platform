#!/usr/bin/env sh
# Acceptance scenario 4, live: fire N generation requests at the same instant
# and tally the responses. Needs curl only.
#   SV_KEY=sv_... sh scripts/burst.sh          (20 requests)
#   N=10 LICENSE=sync SV_KEY=... sh scripts/burst.sh
set -eu
API="${SV_API:-http://localhost:3000}"
N="${N:-20}"
LICENSE="${LICENSE:-royalty_free}"
: "${SV_KEY:?set SV_KEY}"
OUT=$(mktemp -d)

echo "Firing $N requests at once..."
i=0
while [ "$i" -lt "$N" ]; do
  curl -sS -o "$OUT/$i.json" -w "%{http_code}\n" -X POST "$API/v1/generations" \
    -H "Authorization: Bearer $SV_KEY" -H "Content-Type: application/json" \
    -d "{\"prompt\":\"burst test $i\",\"duration_sec\":30,\"license\":\"$LICENSE\"}" > "$OUT/$i.code" &
  i=$((i + 1))
done
wait

echo "Status codes:"
cat "$OUT"/*.code | sort | uniq -c
echo "Error codes:"
for f in "$OUT"/*.json; do sed -n 's/.*"code":"\([a-z_]*\)".*/\1/p' "$f"; echo; done | grep . | sort | uniq -c || true
rm -rf "$OUT"
