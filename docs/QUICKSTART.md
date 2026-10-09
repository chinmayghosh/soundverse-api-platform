# Quickstart: your first song in under five minutes

You need Docker and `curl`. Every command below is copy-paste. The API reference is at http://localhost:3000/docs and the raw OpenAPI spec at http://localhost:3000/v1/openapi.json.

## 1. Run the platform (≈2 min on first build)

```bash
docker compose up --build
```

When the logs show `worker: started`, open http://localhost:3000.

## 2. Sign up and verify (30 s)

1. Go to **Sign up** and create an account.
2. There's no email server locally. The verification link is printed in the logs:
   ```bash
   docker compose logs app | grep "\[email\]"
   ```
   Open that link. You land on your dashboard, on the free **Sandbox** plan.

## 3. Create a test key (15 s)

Dashboard → **API keys** → **Create key** (mode `test`). Copy the secret. It is shown **once**.

```bash
export SV_KEY=sv_test_...   # paste yours
```

Test keys run a mock model: instant, free, and never touch your allowance. They behave like live keys in every other way (auth, rate limits, parallel limits, idempotency, webhooks).

## 4. Generate (≈5 s)

```bash
curl -s -X POST http://localhost:3000/v1/generations \
  -H "Authorization: Bearer $SV_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-first-song" \
  -d '{"prompt":"uplifting acoustic pop for a travel vlog, warm guitars","duration_sec":30,"license":"royalty_free","instrumental":true}'
```

You get `202 Accepted` with `"status":"queued"` and an `id` like `gen_01J…`. Retrying the same command (same `Idempotency-Key`) returns the same job and never bills twice.

## 5. Get the result

```bash
curl -s http://localhost:3000/v1/generations/gen_01J...   -H "Authorization: Bearer $SV_KEY"
```

When `status` is `succeeded`, `output.audio_url` is a signed link that expires after an hour. Fetch the job again for a fresh one. Download it:

```bash
curl -o song.wav "<audio_url from the response>"
```

Or run steps 4 and 5 in one go:

```bash
SV_KEY=$SV_KEY sh scripts/quickstart.sh
```

## 6. Webhooks instead of polling (optional)

```bash
# Register an endpoint (the secret is shown once):
curl -s -X POST http://localhost:3000/v1/webhook_endpoints \
  -H "Authorization: Bearer $SV_KEY" -H "Content-Type: application/json" \
  -d '{"url":"http://host.docker.internal:4000/webhooks"}'

# In another terminal, run the reference receiver with that secret:
npm install && npm run webhook:receiver -- whsec_...
```

Create another generation. The receiver prints `✓ verified generation.succeeded …`.

`host.docker.internal` is allowed only because the local compose file exempts it, for this demo. Real endpoints must be public https URLs. Private, loopback and metadata addresses are rejected.

Verify signatures like this in your own code (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) throw new Error("too old");
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("bad signature");
}
```

Deliveries are at-least-once: dedupe on the event `id`.

## 7. Going live

Live keys call the real model (MiniMax Music v2.6 via fal.ai) and consume credits.

1. Upgrade the account (no deploy needed):
   ```bash
   docker compose exec app npm run plan:set -- you@example.com starter
   ```
2. Put your fal key in `.env` next to `docker-compose.yml`:
   ```
   LIVE_PROVIDER=fal
   FAL_KEY=...
   ```
   Then run `docker compose up -d`.
3. Create a **live** key in the dashboard and repeat steps 4–5.

| License | Credits per started minute | Available on the live model |
|---|---|---|
| `royalty_free` | 1 | yes |
| `sync` | 6 | yes |
| `full_ownership` | 14 | no. The model provider's terms don't let us assign ownership (see DECISIONS.md). |

## Errors you might hit

Every error has the same shape:

```json
{ "error": { "type": "rate_limit_error", "code": "parallel_limit_reached", "message": "…", "request_id": "req_…" } }
```

| Status | Code | Meaning |
|---|---|---|
| 401 | `invalid_api_key`, `api_key_revoked`, `api_key_expired` | Check `Authorization: Bearer …` |
| 402 | `insufficient_credits` | Allowance used up on a hard-stop plan |
| 403 | `license_not_in_plan`, `license_not_supported_by_model`, `insufficient_scope` | |
| 422 | `idempotency_key_reused`, `invalid_webhook_url` | |
| 429 | `parallel_limit_reached`, `hourly_rate_limit_exceeded`, `daily_rate_limit_exceeded` | Wait `Retry-After` seconds |
