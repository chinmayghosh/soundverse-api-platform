# AI usage

## Tools

**Claude Code only** (Claude Opus 5.5, in the Claude desktop app). It was used for planning, writing the code, tests and docs, researching the fal.ai API and the MiniMax and fal terms, and running and verifying the stack. I didn't use ChatGPT, Copilot or any other AI tool.

## How the work was split

**What I did:**
- **Chose the stack** to match what I already know from my own projects (Next.js, Drizzle, Better Auth, Postgres, Zod, Vitest), so I can read, explain and change it. I turned down the suggested Fastify for that reason.
- **Questioned the storage choice.** I asked about using UploadThing. The AI explained that the brief needs S3-compatible storage with signed, expiring URLs and a one-command local run, which UploadThing doesn't give, so we used an S3-compatible store.
- **Chose fal.ai MiniMax** as the real model, Docker for the one-command run, and a milestone-by-milestone workflow.
- **Reviewed the work in stages.** I reviewed M0–M3 (scaffold and schema; accounts and keys; credits, ledger, rate limits and idempotency; worker and cancel) one milestone at a time before allowing the next. From M4 on I had it build straight through and reviewed afterwards.
- **Set up the real model myself**: fal account, credit, and the key in `.env`. I corrected the AI when it said fal's minimum top-up was $5 (it's $10).
- **Asked for a full re-check against the brief** before submitting. That led to a fresh clone of my GitHub repo being run exactly as a grader would.
- **Tested sign-up myself** and noticed I could "sign up" again with an email that already had an account (see case 1 below).
- **Asked for two changes after reviewing:** minimum password length 10 → 8, and a clearer sign-up message.
- **Pushed the repository to GitHub myself.**

**What I delegated to the AI:** almost all of the code, the tests and the first drafts of these documents; looking up the fal queue API and the model terms; running the stack, the crash test and the browser checks.

## What I reviewed, and how

I didn't review all ~4,600 lines line by line, and I won't claim I did. What I actually reviewed:

- **The milestone summaries for M0–M3**, as each milestone finished, before approving the next.
- **README.md and DECISIONS.md**: what the system does and why each major choice was made.
- **`src/server/http/api.ts`, `src/app/v1/generations/route.ts` and `src/server/http/idempotency.ts`**, walked through line by line with Claude explaining them: the request pipeline (auth → rate limit → scope → one error shape) and how a concurrent retry waits on the idempotency key instead of creating a second job.
- **`src/server/generations/create.ts`**, the per-account row lock. I can explain why removing `FOR UPDATE` lets more than 3 jobs through at once: all 20 requests read the running count at the same moment and all see 0.

The money, access and rights paths I still want to go through in depth before the follow-up: `limits/rateLimit.ts`, `billing/ledger.ts`, `keys/service.ts`, `jobs/worker.ts`, `webhooks/ssrf.ts`.

## Cases where something was wrong or subtly off, and how it was caught

Full running log: [docs/ai-review-log.md](docs/ai-review-log.md) (14 entries). The most instructive:

1. **Sign-up with an existing email looked like it succeeded (found by me).** I signed up again with an email that already had an account and got the "we sent you a link" screen, which looked like a duplicate account. Investigating showed it wasn't one: no second account was created, the impostor's password couldn't log in, and no email was sent. Better Auth deliberately returns the same response so the form can't be used to find out who has an account (email enumeration). But our page *told* the user an email had been sent, which is misleading. **Fix:** the page now says "If this email is new… / Already have an account? Log in", and a test proves a duplicate sign-up (including different letter case) creates nothing and can't take over the account.

2. **The first real paid model call failed.** The fal adapter sent `sample_rate: "44100"` as text, following fal's published docs, but the real API requires a number and returned 422. It also passed fal's raw error through to customers. Our tests used a fake fal API that accepted anything, so only a real call could catch this. **Fix:** numbers instead of text; provider details now stay in our logs. The failed job was refunded automatically, so the safety net worked. **Lesson:** a fake API proves our logic, not the provider's contract.

3. **Team invites could have been hijacked.** The AI first accepted a team invite inside Better Auth's sign-up hook, which runs *before* the email is verified. Anyone could sign up with an invited address and take that spot. It was caught by asking "who controls this email at this moment?" **Fix:** invites are accepted only after verification, with a test showing an unverified sign-up can't claim an invite.

4. **A webhook secret would have been stored in plain text.** Creating a webhook endpoint went through the generic idempotency layer, which saves the full response for replays, and that response contained the signing secret. **Fix:** replays store `secret: null`, and a test scans every database table for the secret.

5. **Infrastructure from memory that no longer exists.** The AI pinned MinIO Docker images it remembered; those repositories are gone and the first `docker compose up` failed. We replaced it with RustFS (S3-compatible, Apache-2.0), and the bucket is now created by our own code, so any S3 store works.

6. **A test that was wrong, not the code.** A scenario 12 test expected 1,519 credits used; the correct figure is 1,500 + 4 × 1 + 14 = 1,518. **Rule:** when a money test fails, first prove by hand which side is wrong.

## From the AI's side: judgment calls it made, and how it checked itself

*(Written by Claude Code, describing decisions it made while I had it build straight through from M4. I've reviewed these and agree with them.)*

- **Not selling `full_ownership` on the real model.** MiniMax's terms leave output ownership with the customer only "to the extent permitted by law", with no exclusivity or indemnity, so we can't credibly assign full ownership. Live `full_ownership` requests get a clear 403 instead of silently overselling rights. (DECISIONS #8.)
- **Deliberately not building provider failover** (a "Should" in the brief). Without a second model verified to grant the same rights, a silent switch would change what the customer bought. Failed jobs are refunded instead.
- **Mutation checks, so the tests prove something.** Tests that pass first time can be tests that can't fail. Removing the account lock made 5 of 20 requests get through instead of 3, and one generation free on the last credits. Disabling the delivery-time SSRF re-check made the DNS-rebinding test fail. Both guards were restored.
- **Running everything the way a grader would, not just the unit tests.** This caught two bugs that 125 passing tests missed: the webhook demo breaking when a `.env` exists (docker compose reads it), and the fal number/text bug above. The final check cloned the public GitHub repo into an empty folder and ran `docker compose up` and the test suite there.
- **A real crash test.** The worker was force-killed in the middle of a job. The job was recovered and finished by a new worker. The first attempt at this test was invalid: stopping the npm process on Windows left the worker running. This was noticed because a probe job still completed.

## What I'd do differently

- Review the core money paths (`create.ts`, `ledger.ts`, `rateLimit.ts`) line by line *before* letting the AI build further, rather than after.
- Make one real call to any paid provider on day 1. A two-minute real call would have caught the fal schema mismatch immediately.
