import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "../db/client";
import { idempotencyKeys } from "../db/schema";
import { Errors } from "../errors";
import type { ApiContext, ApiResult } from "./api";

const KEY_RE = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces

// Runs `work` in a transaction, made idempotent by the Idempotency-Key header.
//
// The key row is inserted at the start of the same transaction as the work:
//   - First request: insert succeeds -> do the work -> store the response ->
//     commit. Key row, job and ledger debit become visible atomically.
//   - Concurrent retry: its INSERT ... ON CONFLICT waits on the unique index
//     until the first transaction finishes. If that committed, we see the
//     conflict and replay the stored response; if it rolled back, our insert
//     goes through and we do the work ourselves.
//   - Same key, different request: 422, nothing executed.
// Failed requests (4xx/5xx thrown from `work`) roll back the key too, so a
// request rejected at a limit can be retried later with the same key.
export async function withIdempotency(
  ctx: ApiContext,
  rawBody: unknown,
  work: (tx: Tx) => Promise<ApiResult>,
): Promise<ApiResult> {
  const key = ctx.req.headers.get("idempotency-key");
  if (key === null) return db().transaction(work);
  if (!KEY_RE.test(key)) {
    throw Errors.invalidRequest(
      "invalid_idempotency_key",
      "Idempotency-Key must be 1-255 printable ASCII characters.",
    );
  }

  const requestHash = createHash("sha256")
    // Mode is included so a test-key request can never replay as a live one.
    .update(`${ctx.key.mode} ${ctx.req.method} ${ctx.url.pathname}\n${stableStringify(rawBody)}`)
    .digest("hex");
  const accountId = ctx.key.accountId;

  return db().transaction(async (tx) => {
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ accountId, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    if (inserted.length === 0) {
      const [prior] = await tx
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
      if (prior.requestHash !== requestHash) {
        throw Errors.unprocessable(
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request. Use a new key for a new request.",
        );
      }
      return {
        status: prior.responseStatus!,
        body: prior.responseBody,
        headers: { "Idempotent-Replayed": "true" },
      };
    }

    const result = await work(tx);
    await tx
      .update(idempotencyKeys)
      .set({ responseStatus: result.status, responseBody: result.body })
      .where(and(eq(idempotencyKeys.accountId, accountId), eq(idempotencyKeys.key, key)));
    return result;
  });
}

// Key order must not change the hash: {"a":1,"b":2} == {"b":2,"a":1}.
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
