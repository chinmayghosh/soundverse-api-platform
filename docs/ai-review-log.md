# AI review log (raw notes for AI_USAGE.md)

Running list of places where the AI assistant (Claude Code) was wrong or subtly off, and how it was caught.
Chinmay: confirm each entry with your own review before it goes into AI_USAGE.md, and add your own.

| # | Milestone | What the AI did | How it was caught | Fix |
|---|---|---|---|---|
| 1 | M0 | Pinned `minio/minio` and `minio/mc` image tags from memory in docker-compose.yml. MinIO no longer publishes these images (Docker Hub repos return 404). | First `docker compose up` failed with "pull access denied". | Switched to RustFS (S3-compatible, Apache-2.0). Bucket is now created by our migrate step via the S3 SDK instead of a vendor CLI container, so any S3 store works. |
| 2 | M1 | Added a process-wide `verificationLinks` Map to production auth code so tests could read verification URLs. Test-only code in prod, and unbounded memory growth keyed by email. | Self-review of the diff before running tests. | Removed. Tests capture the logged link with `vi.spyOn(console, "log")`. |
| 3 | M1 | Initially planned to create the tenant account only in Better Auth's `user.create.after` hook. That hook runs after the user insert commits, not in the same transaction, so a failure would leave a user with no account. | Reading Better Auth's type docs for `databaseHooks`. | `ensureAccountForUser` is idempotent (advisory lock + membership check) and is also called on every dashboard load, so the state self-heals. |
| 4 | M0 | create-next-app 16 scaffold enabled `cacheComponents`; the AI almost kept the default. | Read the generated next.config.ts. | Disabled: every response here depends on the caller and live DB state. |
