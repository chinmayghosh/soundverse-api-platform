# Threat model

**Assets:** customers' money (credits and allowance), access (API keys, dashboard sessions), rights (which license a generation was sold under), customer data (prompts, audio, webhook secrets), and our infrastructure (internal network, model budget).

## Protected against

| Threat | Mitigation | Evidence |
|---|---|---|
| **Free capacity through races** (bursts past parallel, credit or rate limits) | A per-account row lock covers the license, slot and credit checks and the debit in one transaction. Rate limits use conditional upserts that can't pass the limit. The provider spend cap uses the same pattern. | Scenarios 4, 5, 14; `limits-and-ledger.test.ts`. A mutation check shows the tests fail without the lock. |
| **Double billing or double jobs on retry** | Idempotency keys inserted in the same transaction as the work; concurrent duplicates wait, then replay. Refunds are unique per generation. | Scenario 6, refund-once test |
| **Tampering with usage history** | The ledger is append-only, enforced by a DB trigger on UPDATE, DELETE and TRUNCATE. Balances are always derived from it. | Ledger tests |
| **Leaked API key in our DB or logs** | Only HMAC-SHA256(pepper, secret) is stored; the pepper is in env, not the DB. Only the public prefix appears in the UI, audit log and logs. The secret is shown exactly once. | Scenario 1 scans every column of every table |
| **Stolen or abandoned key** | Revocation takes effect on the next request (no cache). Rotation with a bounded grace window. Scopes limit what a key can do. `last_used_at` helps spot stale keys. Every key action is audit-logged with actor and IP. | Scenarios 2, 3 |
| **Cross-tenant access** | Every query is scoped by `account_id` taken from the authenticated key. Another tenant's resource gets the same 404 as one that doesn't exist. | Scenario 8; cancel and webhook-delete tests |
| **SSRF through webhook URLs** (cloud metadata, localhost, internal services) | Scheme must be https in production; no credentials allowed in the URL; *every* resolved address must be public (IPv4 and IPv6, including mapped and NAT64 forms; decimal and hex forms are normalized first). Re-checked on every delivery (DNS rebinding); the connection is pinned to the checked IP; redirects are never followed; 10 s timeout. | Scenario 11, SSRF unit tests, rebinding test |
| **Forged or replayed webhooks** | HMAC-SHA256 over `timestamp.body` with a per-endpoint secret (AES-256-GCM at rest, shown once). Receivers reject timestamps more than 300 s off and dedupe on the event id. | Scenario 10, signature tests |
| **Rights changed by a silent model switch** | The model is fixed on the job at creation; the worker never substitutes. Each model declares the licenses it can back. | Scenario 7, license-by-model test |
| **Stale worker overwriting results** | Lease plus fencing token (`attempts`) on every worker write; a cancel is a row-locked state transition. | Zombie-worker and cancel-race tests |
| **Account enumeration and takeover through sign-up** | Signing up with an email that already has an account returns the same response as a real sign-up, so the form can't reveal who has an account. Nothing is created, no email is sent, and the existing password and account are untouched. Email matching ignores letter case. | Duplicate sign-up test |
| **Invite hijack** | Invites are accepted only by a *verified* email, on first dashboard load, never in the pre-verification sign-up hook. | Team test |
| **Dashboard CSRF** | Mutations are Next.js server actions (POST-only, Origin checked); Better Auth checks trusted origins. | n/a |
| **Runaway model spend** | `LIVE_PROVIDER_MAX_CALLS` hard cap; tests and test keys can't reach the paid model (tests force the mock and delete `FAL_KEY`). | Spend-cap concurrency test |
| **Audio links leaking forever** | The bucket is private; links are presigned and expire after 1 h; they're minted fresh on each read. | Scenario 9 checks that unsigned or tampered URLs get 403 |

## Not protected against (and why)

- **Unauthenticated floods.** Rate limits are per account, so requests with invalid keys aren't rate-limited by IP. Guessing a key is infeasible (~190 bits), but a flood still costs one indexed lookup each. *In production:* an edge or WAF rate limit per IP.
- **A compromised server or environment.** Anyone with the pepper and the webhook encryption key plus the DB can verify keys offline and decrypt webhook secrets. *In production:* a KMS or secret manager, key rotation, separate DB roles (the app role shouldn't own the trigger).
- **Dashboard account takeover.** There's no 2FA, no breached-password check, no login throttling beyond Better Auth's defaults, and no password reset. These were scoped out for time.
- **Abusive prompts and model output.** Content moderation is left to the provider (fal's safety checker is on by default). We don't scan outputs.
- **Copyright of generated audio.** The license mapping (DECISIONS #8) is our best reading of the provider's terms, not legal advice. There's no indemnity from the provider.
- **Availability.** It's a single Postgres with no HA, backups or read replicas. The worker runs as one process (concurrency 10), though several can run safely at once.
- **Supply chain.** Dependencies are pinned by the lockfile but not audited. `npm audit` reports issues inherited from the Next.js scaffold.
- **Local dev defaults.** `docker-compose.yml` contains well-known local-only secrets and allows http webhooks plus a `host.docker.internal` exemption, so the demo works with zero setup. Never deploy those values.
