# Decisions

The ten decisions that shape this system. For each: the options considered, the choice, the trade-off, and what would change our mind. After them come every assumption made where the brief was silent, the behaviour chosen for each acceptance scenario, and what was deliberately not built.

---

## 1. Postgres is the only stateful dependency (limits, ledger, queue, idempotency)

- **Options:** Postgres plus Redis (counters, locks) plus a queue (BullMQ or SQS); or Postgres alone.
- **Choice:** Postgres alone. The `generations` table *is* the job queue (`FOR UPDATE SKIP LOCKED` plus leases). Rate-limit counters, idempotency keys and the webhook outbox are tables too.
- **Why:** The money-critical step (check limits, reserve credits, enqueue the job) has to be atomic. With everything in one database it is *one transaction*. We never get a job that was charged but never queued, or queued but never charged, so no two-phase coordination is needed. It also means one fewer system to explain, run and back up.
- **Trade-off:** Polling the queue (every 500 ms when idle) and counter rows cost database load that Redis would absorb. Throughput is bounded by Postgres, which is far above these plan sizes.
- **What would change our mind:** Sustained thousands of requests per second per region, or a queue that needs fan-out or priorities. Then: Redis for rate limits only (an approximate window is acceptable there), and the outbox pattern into a real queue.

## 2. Per-account row lock serializes generation creates

- **Options:** (a) `SERIALIZABLE` isolation with retry on conflict; (b) optimistic counters (`UPDATE … SET used = used + n WHERE used + n <= limit`); (c) `SELECT … FOR UPDATE` on the account row, then plain checks.
- **Choice:** (c). Every create first locks its account row. License, parallel-slot and credit checks then read committed state and write the job and ledger debit before the lock is released.
- **Why:** Three limits must hold *together*: slots, credits and the plan in force. A single lock makes the reasoning sequential and explainable line by line. (b) needs a stored balance, which competes with the append-only ledger. (a) is correct, but retries under bursts hurt latency and are harder to reason about. Different accounts never contend.
- **Proof:** `tests/scenarios/04` and `05`. Removing the `FOR UPDATE` makes them fail: 5 of 20 accepted instead of 3, and one free generation on the last credits.
- **Trade-off:** One account's creates are serial, at a few ms each. Plan changes take the same lock, so they never interleave with a credit check.
- **What would change our mind:** A single customer needing more than ~200 creates per second. Then use sharded slot and credit reservations.

## 3. Credits are reserved at creation and refunded on failure

- **Options:** Charge when the job succeeds; or reserve (debit) at creation and refund if it fails or is cancelled while queued.
- **Choice:** Reserve at creation.
- **Why:** Charging on success lets a burst of jobs overshoot the allowance, because they're all admitted before any of them completes. Reserving means the admission check and the charge happen in the same transaction (scenario 5). Refunds are new ledger rows (`kind=refund`, exactly negating the debit, in the debit's original period). A unique `(generation_id, kind)` index makes a double refund impossible.
- **Trade-off:** A customer's remaining balance dips while jobs run, and is restored if a job fails.
- **Refund rules:** failed (any reason) means a full refund; cancelled while queued means a full refund; **cancelled while running means no refund**, because the provider is already being paid for the work. Finance and the customer can both live with that, and it's documented in the API reference.

## 4. Reject at the parallel limit (429), don't queue

- **Options:** Hold excess jobs in a per-account queue, or reject with `429 parallel_limit_reached` plus `Retry-After`.
- **Choice:** Reject.
- **Why:** A hidden queue hides backpressure from the customer, can grow without bound, and makes "parallel generations" a soft limit. It also raises an awkward billing question: are queued-but-not-started jobs charged? Rejecting makes the contract crisp, and the customer's retry loop or own queue stays in control. This matches the brief's own error example.
- **What would change our mind:** Customers asking for "fire and forget" bulk submission. We would add an explicit `POST /v1/batches`, with its own, visible limits, rather than queue silently.

## 5. Bill on requested duration, rounded up per started 60 s

- **Options:** Bill on requested duration (known up front), or on actual output length (known only after generation).
- **Choice:** Requested duration.
- **Why:** The charge has to be reserved atomically at creation (decision 3), so it must be computable from the request. It's also predictable for the customer. Example: 30 s requested and 31.84 s delivered costs one unit, not two.
- **Trade-off (known problem):** MiniMax v2.6 has no duration control. The target goes into the prompt as a hint, and the actual length can differ a lot from it.
- **What would change our mind:** A live model with a hard duration parameter (fixes it outright), or ffmpeg trimming before storage.

## 6. Idempotency inside the same transaction, with waiting

- **Options:** (a) Stripe-style: insert a key row first in its own transaction, return 409 "in progress" to concurrent retries; (b) insert the key row as the first statement of the *same* transaction as the work.
- **Choice:** (b). A concurrent duplicate's `INSERT … ON CONFLICT DO NOTHING` blocks on the unique index until the first transaction finishes. It then replays the stored response (`Idempotent-Replayed: true`), or does the work itself if the first rolled back.
- **Why:** The key, job and debit become visible atomically, so there's no window where a key exists without its result. The client's retry gets the real answer instead of a 409 it has to retry again.
- **Details:**
  - The request hash covers the key mode, method, path and canonical (key-sorted) JSON body. A different body with the same key returns `422 idempotency_key_reused`.
  - **Only successful responses are stored.** A request rejected at a limit (402, 429) can be retried later with the same key.
  - Webhook endpoint creation stores a redacted replay body (`secret: null`), so signing secrets are never stored in plaintext.
  - Keys are scoped per account and kept for 24 h.
- **Trade-off:** A waiting duplicate holds a database connection for as long as the first request takes (milliseconds, since no provider call happens in the request).

## 7. Rate limits: fixed UTC windows, per account, every authenticated request counts

- **Options:** Sliding window or token bucket; fixed windows. Count all requests, or only creates.
- **Choice:**
  - Fixed hour and day windows (UTC), one counter row each.
  - A conditional upsert (`… DO UPDATE SET count = count + 1 WHERE count < limit RETURNING`), with both windows in one transaction. The count can never pass the limit, and a rejected request doesn't consume quota.
  - Every authenticated `/v1` request counts, including `GET` polls and idempotent replays.
- **Why:** The brief says "requests per hour", and the literal reading is the defensible one. Polling is the main way customers waste capacity, which is what a request limit is for. Webhooks are the documented alternative, with polling every 5 s or slower.
- **Trade-off:** Fixed windows allow up to 2× the limit across a boundary (known). Polls can exhaust the hourly limit and then block creates (scenario 14). Headers make this visible (`X-RateLimit-Remaining`, `Retry-After`).
- **What would change our mind:** Customer complaints about polls blocking creates. We would then give reads their own (larger) bucket and document the change.

## 8. The model is fixed at creation; licenses are per model; no silent failover

- **Options:** Fail over to another provider when the model is down or slow (a "Should" in the brief); or never substitute.
- **Choice:**
  - The job stores its provider and model at creation, and the worker runs exactly that.
  - Each model declares the licenses its provider's terms can back.
  - **No failover.**
- **Why:** The license a customer buys depends on the model's terms. Silently swapping models can change what they bought. We have one live model, and no second model we've verified to grant the same rights. A provider outage therefore fails the job with a clear error code (`provider_timeout` or `provider_error`) and a full refund (scenario 7).
- **License mapping:**
  - fal lists MiniMax Music v2.6 as "Commercial use".
  - MiniMax's terms leave output ownership with the customer only "to the extent permitted by applicable law", with no exclusivity or indemnity. AI output may not be copyrightable at all.
  - So we sell **royalty_free and sync** (non-exclusive licenses) on it, but **not full_ownership**: we can't assign rights we can't show we hold. A live `full_ownership` request returns `403 license_not_supported_by_model`, even on Growth. Test keys (mock model, our own synthetic audio) allow all three.
  - *Not legal advice.* This needs a real review of the current fal and MiniMax terms before selling.
- **What would change our mind:** A second model with verified equivalent terms. Then add opt-in failover (`allow_fallback: true`), restricted to models whose license set covers the request, with the actual model reported on the job.

## 9. API keys: peppered HMAC, prefix lookup, no cache, rotation with a grace window

- **Options:** bcrypt or argon2 per key versus HMAC-SHA256; cache valid keys versus look them up every time; rotation that cuts over immediately versus an overlap window.
- **Choice:**
  - Format `sv_<mode>_<8-char prefix>_<32-char secret>` (~190 bits of entropy).
  - Lookup by indexed prefix, then a constant-time compare of HMAC-SHA256(pepper, secret).
  - No cache.
  - Rotation creates a successor with the same mode and scopes, and leaves the old key valid until `expires_at`: a 24 h default, `0` for immediate, maximum 7 days.
- **Why:**
  - Slow hashes protect low-entropy passwords. A random 190-bit secret can't be dictionary-attacked, and auth runs on every request.
  - The pepper lives outside the database, so a database leak alone doesn't allow offline checks.
  - With no cache, "a revoked key fails on its very next request" (scenario 2) holds by construction.
  - Rotation can be done without a single failed request (scenario 3). A key can only be rotated once, so there's never more than one successor.
- **Trade-off:** One indexed query per request.

## 10. Test keys: mock model, never charged, separate parallel pool, shared rate limits

- **Choice:**
  - Test keys always run the mock model and write no ledger rows.
  - They share the account's rate limits, since the brief says "limits apply to the account".
  - They have their **own parallel-slot pool**.
- **Why:** Customers run CI on test keys. If test jobs shared parallel slots with live jobs, a CI burst could block production generations. The mock returns a real, playable WAV, so the quickstart (scenario 9) exercises storage, signed URLs and webhooks for real.

## Also decided (smaller)

- **Next.js plus a separate worker process.** One codebase for dashboard and API, matching the author's stack. The worker exists because long jobs can't run in request handlers.
- **RustFS instead of MinIO.** MinIO's Docker images are no longer published. RustFS speaks the same S3 API, and the bucket is created through the SDK, so any S3 store works by changing env vars.
- **Better Auth for dashboard login only**, as the brief allows. The tenant account is created on first verified dashboard load, not in the sign-up hook, which runs before verification.
- **404 for other tenants' resources**, identical to "doesn't exist", so IDs can't be probed across accounts.
- **Signed URLs are minted on every read** with a 1 h TTL. Webhook payloads get a fresh URL at delivery time, not when the event is created.

---

## Assumptions where the brief was unclear

| Topic | Assumption |
|---|---|
| Billing period | Calendar month in UTC. Unused credits don't roll over. Nothing is "reset"; usage is summed per `YYYY-MM`. |
| Cost | `license credits × ceil(requested_seconds / 60)`. Duration must be 5–240 s (default 30). |
| Defaults | `license` defaults to `royalty_free` (fewest rights). `instrumental` defaults to `true`. |
| Sandbox | Test keys only. Creating a live key returns 403 `live_keys_not_in_plan`. |
| Growth overage | Allowed and recorded per ledger row as `overage_credits`. Not invoiced (Stripe not built). |
| What "parallel" counts | `queued` plus `running` jobs, per key mode. |
| Plan change | Takes effect on the next request. The period is not reset. Already-used credits stay used. Running jobs continue even if they now exceed the new parallel limit. Jobs already admitted keep their license. |
| Retry-After at the parallel limit | 5 s (jobs take tens of seconds, so there's no exact moment a slot frees). |
| Cancel | Queued: refunded. Running: not refunded. Finished: 409. Already cancelled: returns it again (idempotent). Emits `generation.canceled`. |
| Webhook events | `generation.succeeded`, `generation.failed`, `generation.canceled` go to all of an account's endpoints, at most 10 endpoints. |
| Webhook retries | 13 attempts over about 24 h (10 s, 30 s, 1 m, 2 m, 5 m, 10 m, 30 m, 1 h, 2 h, 4 h, 8 h, 8 h). Any non-2xx, including 3xx, counts as a failure. Redirects are never followed. |
| Webhook URLs | https only in production. Every resolved address must be public. A dev-only exact-hostname allowlist exists (`WEBHOOK_ALLOW_PRIVATE_HOSTS`) and is empty by default. |
| Idempotency window | 24 h. All POSTs accept it. |
| Team | Users belong to exactly one account. Invites work for new sign-ups only. |
| Spend protection | `LIVE_PROVIDER_MAX_CALLS` (default 20) caps paid model calls, enforced with the same conditional-upsert pattern. |

## Behaviour per acceptance scenario

Each has a test in `tests/scenarios/NN-*.test.ts`.

| # | Scenario | Behaviour |
|---|---|---|
| 1 | Secret never retrievable | Only the HMAC is stored. The test scans every column of every table, the list API and the dashboard data for the secret. |
| 2 | Revoked key | The very next request gets 401 `api_key_revoked`. No caching. |
| 3 | Rotation without failures | The old and new key both work during the grace window. Traffic during rotation all succeeds. After expiry the old key gets 401 `api_key_expired`. |
| 4 | Starter, 20 at once | Exactly 3 × 202 and 17 × 429 `parallel_limit_reached`. Exactly 3 ledger debits. |
| 5 | 5 credits left, 10 at once | On Starter the parallel limit binds first: 3 × 202, 7 × 429. With slots out of the way: exactly 5 × 202 and 5 × 402 `insufficient_credits`, never over the allowance. With overage: 5 from allowance plus 5 overage. |
| 6 | Idempotent retries | Request 2 (arriving while 1 holds its transaction) waits, then replays. Request 3 replays. 1 job and 1 debit. Same key with a different body: 422 `idempotency_key_reused`. |
| 7 | Model times out or errors mid-job | Per-attempt timeout, 3 attempts with backoff. A timed-out provider request is *resumed*, not re-submitted (no double pay). Final: `failed` with `provider_timeout` or `provider_error`, full refund, `generation.failed` webhook, and the model unchanged. Non-retryable refusals fail immediately. |
| 8 | B reads A's job | 404, byte-identical to a job that doesn't exist (apart from `request_id`). A's jobs never appear in B's list. |
| 9 | Quickstart with a test key | Works on a fresh Sandbox account in about 6 s, with playable audio and zero credits. Also run as `scripts/quickstart.sh` against `docker compose up`. |
| 10 | Endpoint down 10 min / replay a day later | Backoff schedule; the same event id on every attempt; delivered after recovery, and never again after success. A captured payload replayed a day later fails verification: the timestamp is signed and must be within 300 s. Receivers dedupe on `event.id`. |
| 11 | Webhook to 169.254.169.254 | 422 `invalid_webhook_url`. Also rejected: decimal and hex IPv4 forms, IPv4-mapped IPv6, localhost and private ranges. Re-checked on every delivery (DNS rebinding). The connection is pinned to the validated IP. 3xx responses are not followed. |
| 12 | Growth with 1,500 used, downgraded to Starter | Immediate, no period reset. New live work gets 402 (0 of 200 left). Starter's parallel limit applies to new jobs. Running jobs finish. Full ownership is no longer sellable. Test keys keep working. The change is audit-logged. |
| 13 | Starter asks for full_ownership | 403 `license_not_in_plan`, listing the available licenses. No job, no charge. |
| 14 | Polling every second at the parallel limit | Polls never take slots or credits. They count toward the hourly request limit, so past it they get 429 `hourly_rate_limit_exceeded` with `Retry-After` and `X-RateLimit-*` headers. Jobs and billing are unaffected. |

## What we chose not to build

- **Provider failover:** see decision 8. Building it without a rights-equivalent second model would create the exact bug the brief warns about.
- **Stripe overage invoicing:** the ledger already records `overage_credits` per row, which is the hard part. Invoicing is plumbing.
- **Admin UI:** `npm run plan:set` or a row edit changes plans with no deploy, which meets the requirement.
- **SDKs and MCP server:** the OpenAPI spec is complete enough to generate an SDK. We prioritized correctness of the Musts.
- **Password reset, email delivery, account deletion, public deployment.**
