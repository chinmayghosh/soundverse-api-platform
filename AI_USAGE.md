# AI usage

> **Chinmay: edit this before submitting.** It's a factual draft. The sections marked ✏️ need your own words: only you can say what you reviewed line by line and what you caught yourself. The brief grades the review, so be specific and don't claim more than you did.

## Tools

- **Claude Code** (Claude Opus 5.5) in the Claude desktop app, for planning, code, tests, docs, and research (fal API docs, MiniMax and fal terms).
- No other AI tools. ✏️ *(Add any you used, e.g. Copilot or ChatGPT.)*

## How the work was split

| Who | What |
|---|---|
| **Me** | Read the brief and chose to build in my own stack (Next.js, Drizzle, Better Auth, Postgres, Zod, Vitest) so I can walk through and change it live. Turned down Fastify and asked about UploadThing; agreed to S3-compatible storage after the AI explained signed, expiring URLs and the one-command run. Chose fal.ai MiniMax as the real model, Docker for the one-command run, and a milestone-by-milestone workflow: I reviewed M0–M3 (scaffold and schema; accounts and keys; credits, ledger, rate limits and idempotency; worker and cancel) before allowing the next. From M4 on I had it build straight through and reviewed afterwards. ✏️ |
| **Delegated to the AI** | Almost all of the code, tests and first drafts of the docs; looking up the fal queue API and the model terms; running the stack, the crash test and the browser checks. |

## What I reviewed line by line ✏️

*(Fill this in honestly. Suggested must-reads, since these are the money, access and rights paths an interviewer will probe:)*

- [ ] `src/server/generations/create.ts`: the row lock and the order of checks
- [ ] `src/server/http/idempotency.ts`: why a concurrent retry waits instead of double-creating
- [ ] `src/server/limits/rateLimit.ts`: the conditional upsert
- [ ] `src/server/billing/ledger.ts` and `drizzle/0001_ledger_append_only.sql`
- [ ] `src/server/keys/service.ts` and `secrets.ts`: hashing, no cache, rotation
- [ ] `src/server/jobs/worker.ts`: SKIP LOCKED claim, lease, fencing with `attempts`
- [ ] `src/server/webhooks/ssrf.ts` and `deliveries.ts`: address checks, pinned connection

## Where the AI was wrong or subtly off, and how it was caught

The full running log is in [docs/ai-review-log.md](docs/ai-review-log.md). The most instructive cases:

1. **The plan's own invite design had a security hole.** To create the tenant account, the AI first used Better Auth's `user.create.after` hook, and later extended it to accept team invites by email. That hook runs *before* email verification. Anyone could sign up with an invited address and be placed in that team; they couldn't log in unverified, but the real invitee would then be locked out of that email. It was caught by asking "who controls this email at this moment?" while threat-modelling the invite flow. Fix: the tenant is created on first *verified* dashboard load, and there's a test where an unverified sign-up with an invited email gets its own account. ✏️ *(If you spotted or questioned this yourself, say so.)*

2. **A webhook secret would have been stored in plaintext.** `POST /v1/webhook_endpoints` was routed through the generic idempotency layer, which saves the response body for replays. That body contained the endpoint's signing secret, so every secret would have sat in `idempotency_keys` for 24 h and been returned again on replay. It was caught in review by asking "where does this response body go?" Fix: routes can store a redacted replay body (`secret: null`), and the test scans every table for the secret.

3. **The idempotency hash ignored key mode.** The first draft hashed method, path and body only, so an identical retry through a *test* key could replay a *live* job's response. It was caught in self-review against the test/live separation rule. Mode is now part of the hash.

4. **Infrastructure from memory that no longer exists.** The AI pinned `minio/minio` and `minio/mc` image tags it remembered. Those repos are gone from Docker Hub, and the first `docker compose up` failed. It was replaced with RustFS (Apache-2.0, S3 API), and bucket creation moved into our own migrate step via the S3 SDK, so it no longer depends on a vendor CLI.

5. **A test that was wrong, not the code.** The scenario 12 test expected 1,519 credits used; the correct figure is 1,500 + 4 × 1 + 14 = 1,518. The rule I took from it: when a money test fails, first prove which side is wrong by hand.

6. **A crash test that proved nothing at first.** "Killing" the worker by stopping its `npm` task on Windows left the child `node` process running and still processing jobs. It was caught because a probe job still completed after the "kill". The real test force-killed the node processes, and the job was then recovered by the reaper and finished by a new worker as claim #2.

7. **A point-free callback broke silently.** Adding an optional `opts` parameter to `serializeGeneration` changed the meaning of an existing `rows.map(serializeGeneration)`: `map` passes the index as the second argument. TypeScript caught it.

## How the tests were checked to be meaningful

Tests that pass on the first run can be tests that can't fail. Two **mutation checks** were run:
- With `FOR UPDATE` removed from generation creation, scenarios 4 and 5 fail: 5 of 20 accepted instead of 3, and one free generation on the last credits.
- With the delivery-time SSRF re-check disabled, the DNS-rebinding test fails.

✏️ *(Add any tests you broke or extended yourself.)*
