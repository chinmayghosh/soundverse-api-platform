# Loom demo run sheet (≤ 10 min, camera and mic on)

The brief requires: **sign-up to first song with a fresh account · a key revocation taking effect · scenario 4 live · a webhook arriving and being verified · code structure walkthrough · top three known problems.**

## Before recording (not on camera)

```bash
docker compose down -v            # wipe demo data so the account really is fresh
docker compose up --build -d
docker compose logs -f app worker  # keep this terminal visible
```

- Terminal 2 is for curl. Terminal 3 is for the webhook receiver (needs `npm install` once on the host).
- Optional: with `FAL_KEY` in `.env`, live keys make a real MiniMax song. Rehearse once to check it works, because it costs money.

## 0:00 – 0:30 · Intro (camera)

"I built Soundverse's self-serve music API. The core rule from the brief: anything touching money, access or rights is enforced in code that's provably correct under concurrency. Let me show it working, then how it's built, then what's still wrong with it."

## 0:30 – 2:30 · Sign-up to first song (fresh account)

1. http://localhost:3000 → **Sign up**.
2. Show the verification link in the logs (`[email] verify …`) and open it. You land on the dashboard, Sandbox plan.
3. **API keys** → Create a test key → point at "shown once" → copy it.
4. Terminal 2:
   ```bash
   export SV_KEY=sv_test_...
   sh scripts/quickstart.sh
   ```
   Show `queued → running → succeeded` and play the downloaded file.
5. Dashboard → **Generations**: the same job with an inline player. Mention that the URL is signed and expires in an hour.

## 2:30 – 3:30 · Key revocation takes effect immediately

```bash
curl -s localhost:3000/v1/generations -H "Authorization: Bearer $SV_KEY" -o /dev/null -w "%{http_code}\n"   # 200
```
Dashboard → Revoke that key, then run the same curl again: **401 `api_key_revoked`**. "No auth cache, by design: the very next request fails." Show the **Audit log** entry. Create a new test key for the rest of the demo.

## 3:30 – 4:30 · Scenario 4 live (20 requests at once on Starter)

```bash
docker compose exec app npm run plan:set -- you@example.com starter   # no deploy needed
sh scripts/burst.sh
```
Expected output: `3 202`, `17 429`, `17 parallel_limit_reached`. Say: "Exactly 3. Every create takes a row lock on the account, so the slot, license and credit checks and the debit are one serialized transaction. When I deleted that lock, this same burst let 5 through." Show the **Usage** page reading the ledger.

## 4:30 – 5:45 · Webhook arriving and verified

```bash
curl -s -X POST localhost:3000/v1/webhook_endpoints -H "Authorization: Bearer $SV_KEY" \
  -H "Content-Type: application/json" -d '{"url":"http://host.docker.internal:4000/webhooks"}'
# Terminal 3, with the secret from the response:
npm run webhook:receiver -- whsec_...
sh scripts/quickstart.sh
```
The receiver prints `✓ verified generation.succeeded evt_…`. Then show SSRF protection:
```bash
curl -s -X POST localhost:3000/v1/webhook_endpoints -H "Authorization: Bearer $SV_KEY" \
  -H "Content-Type: application/json" -d '{"url":"http://169.254.169.254/latest/meta-data/"}'
```
Result: 422 `invalid_webhook_url`. "The address is re-checked on every delivery too, against DNS rebinding."

Optional (15 s): kill the worker mid-job (`docker compose kill worker` while a job runs), then `docker compose up -d worker`. The job gets claim #2 and succeeds.

## 5:45 – 8:30 · Code walkthrough (IDE)

Follow the README architecture table:
1. `src/app/v1/generations/route.ts`: a thin handler. Then `http/api.ts`: auth → rate limit → scope → one error shape.
2. `generations/create.ts`: **the row lock**, then the checks in order: license → model license → parallel slots → credits → insert job and debit.
3. `http/idempotency.ts`: the key row in the same transaction; a concurrent retry waits on the unique index.
4. `billing/ledger.ts` and the append-only trigger migration. Refunds are new rows.
5. `jobs/worker.ts`: SKIP LOCKED claim, lease plus heartbeat, `attempts` as the fencing token, reaper.
6. `providers/registry.ts`: the model is fixed at creation; licenses per model; why full_ownership isn't sold on MiniMax.
7. `tests/scenarios/`: one file per acceptance scenario. Run `npm run test:docker` (125 passing).

## 8:30 – 9:45 · Top three known problems (camera)

1. The real-model path is tested against a fake fal API. *(Say whether you ran a real paid generation.)* MiniMax ignores duration, so a 30 s request billed as 30 s can come back as a 2-minute song. The fix is a model with duration control, or trimming before storage.
2. One account's creates are serialized by its row lock, which caps per-account throughput. Fine at these plans, but not at 1,000 creates per second.
3. Webhooks are at-least-once and unordered, and fixed-window rate limits allow 2× bursts at the hour boundary.

## 9:45 – 10:00 · Close

"Decisions, assumptions and per-scenario behaviour are in DECISIONS.md, the threat model in SECURITY.md, and how I used AI, including where it was wrong, in AI_USAGE.md."
