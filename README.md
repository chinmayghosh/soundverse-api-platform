# Soundverse Enterprise API: AI music generation platform

A self-serve developer API for AI music generation. A developer signs up, verifies their email, creates a secret API key and calls the API to generate music. Every request is authenticated, every plan limit is enforced, and all usage goes to an append-only ledger. Generations run asynchronously on a worker against a real model (MiniMax Music v2.6 via fal.ai), or a mock for test keys. Results arrive by polling or by signed webhook.

**Rule we built around:** anything that touches money, access or rights is enforced in Postgres transactions whose correctness under concurrency we can explain, and the tests fire concurrent requests to prove it.

## Run it

```bash
docker compose up --build                            # app :3000, worker, Postgres, S3 (RustFS :9000/:9001)
docker compose --profile test run --rm --build test  # the full test suite (125 tests) against fresh Postgres + S3
```

No `.env` is needed for the above. Compose carries local-only defaults. To use the real model, put `LIVE_PROVIDER=fal` and `FAL_KEY=…` in `.env` (see [.env.example](.env.example)).

Then follow **[docs/QUICKSTART.md](docs/QUICKSTART.md)** to go from sign-up to your first song in under five minutes. Or, once you have a test key:

```bash
SV_KEY=sv_test_... sh scripts/quickstart.sh   # create -> poll -> download
SV_KEY=sv_test_... sh scripts/burst.sh        # scenario 4: 20 requests at once
```

| | |
|---|---|
| Dashboard | http://localhost:3000 |
| API reference (rendered OpenAPI) | http://localhost:3000/docs |
| OpenAPI spec | http://localhost:3000/v1/openapi.json, also in [docs/openapi.json](docs/openapi.json) |
| Change a plan without a deploy | `docker compose exec app npm run plan:set -- <email or acct_id> <sandbox\|starter\|growth>` |
| Reference webhook receiver | `npm run webhook:receiver -- whsec_...` |

Host development (optional): `docker compose up -d postgres storage`, `cp .env.example .env` and fill in the three secrets, then `npm install`, `npm run db:migrate`, `npm run dev` and `npm run worker` in separate terminals. Run `npm test` for the suite.

## Architecture

```
            ┌──────────────────────────── Next.js app (one process) ───────────────────────────┐
 browser ──▶│ dashboard (Better Auth session) ──┐                                               │
            │                                    ├─▶ services ──────────────────────────┐        │
 API     ──▶│ /v1/* route ─▶ apiRoute wrapper ──┘   keys · limits · billing ·           │        │
 clients    │   request id → key auth → rate limit  generations · webhooks · audit      │        │
            │   → scope → handler → one error shape                                     ▼        │
            └────────────────────────────────────────────────────────────────── Postgres ◀──────┘
                                                                     (accounts, plans, keys, ledger,
                                                                      generations = job queue,
            ┌──────────────── worker (separate process) ────────────┐  idempotency, rate counters,
            │ claim job (SKIP LOCKED + lease) → provider → S3 →      │  webhook outbox, audit)
            │ finish (fenced) + ledger refund + event, one tx        │◀───────────────▶ ▲
            │ reaper (expired leases) · webhook deliveries · cleanup │                  │
            └───────────────┬──────────────────────┬────────────────┘                  │
                            ▼                      ▼                                    │
                  fal.ai MiniMax v2.6       customer webhook URLs                       │
                  (or mock for test keys)   (SSRF-checked, signed)          S3 (RustFS) ┘ signed, expiring audio URLs
```

| Concern | Where | How |
|---|---|---|
| Auth | [src/server/keys](src/server/keys) | `sv_{test,live}_<prefix>_<secret>`. Only an HMAC-SHA256 (with server-side pepper) is stored. Looked up by prefix, compared in constant time, no cache. |
| Request pipeline | [src/server/http](src/server/http) | `apiRoute` wrapper (request id, auth, rate limit, scope, error shape) and `withIdempotency` |
| Limits | [src/server/limits](src/server/limits), [generations/create.ts](src/server/generations/create.ts) | Rate limits: conditional-upsert counters. License, parallel and credit checks: under one per-account row lock. |
| Metering | [src/server/billing](src/server/billing) | Append-only ledger enforced by a DB trigger. Balances are always a sum over immutable rows. |
| Jobs | [src/server/jobs](src/server/jobs) | The `generations` table is the queue (Postgres). Leases plus a fencing token (`attempts`). A reaper recovers crashed work. |
| Providers | [src/server/providers](src/server/providers) | `MusicProvider` interface. Mock and fal adapters. Each model declares which licenses it can back. Spend cap. |
| Webhooks | [src/server/webhooks](src/server/webhooks) | Transactional outbox. HMAC signatures with timestamp. SSRF guard at registration and on every delivery. |
| Dashboard | [src/app/dashboard](src/app/dashboard) | Server components and server actions over the same services |

The full reasoning behind these choices is in **[DECISIONS.md](DECISIONS.md)**. The threat model is in **[SECURITY.md](SECURITY.md)**, and how AI was used is in **[AI_USAGE.md](AI_USAGE.md)**.

## Status (honest)

### Works (tested, and run end to end in Docker)

| Brief item | Notes |
|---|---|
| Accounts | Sign up, email verification (link printed to the log), log in, dashboard |
| API keys | Create (secret shown once), list (prefix, scopes, created, last used), revoke (effective on the next request), rotate with a grace window. Test and live modes. Four scopes. |
| Async generation API | Create, get, list (cursor pagination, status filter), cancel. Audio stored in S3 and served through signed URLs that expire after 1 h. |
| Limits and metering | Monthly allowance, parallel generations, requests per hour and per day, licenses per plan, hard stop or overage. All enforced under concurrency (scenarios 4, 5, 14 plus burst tests). Proper status codes, one error shape, `X-RateLimit-*` and `Retry-After` headers. Append-only ledger that the dashboard reads from. |
| Idempotency | `Idempotency-Key` on all POSTs. A concurrent retry waits for the first request and replays its response. A different body gets 422. |
| Webhooks | Endpoints API. Signed `generation.succeeded`, `generation.failed` and `generation.canceled` events. 13 attempts over about 24 h. Replay protection. SSRF protection. |
| Docs | OpenAPI 3.1 generated from the validation schemas, with a test that real responses match it. Quickstart doc and script. |
| Tests | 125 tests, including every acceptance scenario (`tests/scenarios/01…14`). Two mutation checks confirm the concurrency and SSRF tests fail when their guard is removed. |
| Usage view (Should) | Credits used, remaining and overage; per key; per day; latest ledger rows |
| Audit log (Should) | Key create, rotate and revoke; plan changes; webhooks; team changes. Records actor, IP and time. |
| Team members (Should) | Owner and developer roles. Invites are accepted on verified sign-up. Developers manage test keys only. |
| Jobs survive a worker restart | Covered by tests, and checked by hard-killing a worker mid-job: the job was recovered and completed. |

### Partial

| Item | What's missing |
|---|---|
| **Live model (fal.ai MiniMax Music v2.6)** | The adapter is built and tested against a fake of fal's queue API: submit, resume after a crash, refusals, and the spend cap. **A real paid generation has not been run yet** (needs `FAL_KEY`). |
| Duration on the live model | MiniMax v2.6 has no duration parameter. We send the target length as a prompt hint and bill the *requested* duration, so actual length can differ from what was billed. Returned `output.duration_sec` for MP3 is estimated from file size at the requested bitrate. |
| Rate limits | Fixed UTC windows, so up to 2× the hourly limit can pass around an hour boundary. Polls count toward the limit by design (see DECISIONS). |
| Dashboard | Functional, not polished. No password reset or account settings. |

### Not built (by choice; reasons in DECISIONS.md)

- **Provider failover.** No second model is licensed for the same rights, so silently switching models would change what the customer bought. Jobs fail cleanly with a refund instead.
- **Stripe overage billing.** Overage is recorded in the ledger (`overage_credits`) but not invoiced.
- **Admin UI.** Plans change through `npm run plan:set` (no deploy needed) or by editing the `plans` table.
- **TypeScript/Python SDK, MCP server, public deployment.**

## Top 3 known problems

1. **The real-model path hasn't been exercised with a paid call yet**, and MiniMax decides the song length itself. A customer who asks for 30 s and is billed for 30 s may get a 2-minute track. The fix needs either a model with a duration control or server-side trimming (ffmpeg) before storage.
2. **Every create for one account runs through a single row lock**, so one account's create throughput is bounded by transaction latency (a few ms, about hundreds per second). That's fine at these plan sizes, but a very large customer would need sharded counters or a reservation table.
3. **Webhook delivery is at-least-once and unordered.** Receivers must dedupe on `event.id`, as documented. A `succeeded` event for a job could arrive after a later job's event. There's no manual "resend" button yet.

## Repository map

```
src/app/            Next.js routes: /v1/* API, /dashboard/*, /docs, /api/auth
src/server/         domain services (no Next.js imports except auth/session.ts)
src/worker/         worker entry point
drizzle/            SQL migrations (incl. the ledger's append-only trigger)
tests/scenarios/    one file per acceptance scenario
tests/integration/  limits, ledger, worker, webhooks, OpenAPI conformance, team
tests/unit/         pricing, SSRF rules, signatures
scripts/            quickstart.sh, burst.sh, webhook-receiver.ts, set-plan.ts, openapi.ts
docs/               QUICKSTART.md, openapi.json, ai-review-log.md
```
