import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/v1/generations/route";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { call, createTestAccount, createTestKey, genBody } from "../helpers";

const post = (key: string, idem: string, body = genBody()) =>
  call(POST, { method: "POST", path: "/v1/generations", key, body, headers: { "Idempotency-Key": idem } });

const settled = async (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 300))]);

// Scenario 6: a client retries the same POST with the same Idempotency-Key
// three times, the second while the first is still being processed. Then it
// reuses that key with a different body.
describe("scenario 6: idempotent retries", () => {
  it("creates and bills once; the in-flight retry waits and replays; a different body is rejected", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "live");

    // Hold the account's row lock from another connection so request #1 is
    // provably mid-transaction when #2 arrives.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const blocker = await pool.connect();
    await blocker.query("begin");
    await blocker.query("select 1 from accounts where id = $1 for update", [acct.accountId]);

    const first = post(key.secret, "retry-abc");
    expect(await settled(first)).toBe(false); // stuck on the account lock
    const second = post(key.secret, "retry-abc");
    expect(await settled(second)).toBe(false); // stuck behind #1's idempotency row

    await blocker.query("commit");
    blocker.release();
    await pool.end();

    const [r1, r2] = await Promise.all([first, second]);
    const r3 = await post(key.secret, "retry-abc");

    expect([r1.status, r2.status, r3.status]).toEqual([202, 202, 202]);
    expect(r2.body.id).toBe(r1.body.id);
    expect(r3.body.id).toBe(r1.body.id);
    expect(r1.headers.get("idempotent-replayed")).toBeNull();
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r3.headers.get("idempotent-replayed")).toBe("true");

    const jobs = await db().select().from(generations).where(eq(generations.accountId, acct.accountId));
    const ledger = await db().select().from(ledgerEntries).where(eq(ledgerEntries.accountId, acct.accountId));
    expect(jobs).toHaveLength(1);
    expect(ledger).toHaveLength(1);

    const reused = await post(key.secret, "retry-abc", genBody({ prompt: "something else entirely" }));
    expect(reused.status).toBe(422);
    expect(reused.body.error).toMatchObject({ type: "invalid_request_error", code: "idempotency_key_reused" });
    expect(await db().select().from(generations).where(eq(generations.accountId, acct.accountId))).toHaveLength(1);
  });

  it("treats a reordered but identical JSON body as the same request", async () => {
    const acct = await createTestAccount("starter");
    const key = await createTestKey(acct, "test");
    const a = await post(key.secret, "k-order", { license: "royalty_free", prompt: "x", duration_sec: 30 } as never);
    const b = await post(key.secret, "k-order", { duration_sec: 30, prompt: "x", license: "royalty_free" } as never);
    expect(b.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
  });

  it("does not store failures: a key rejected at the parallel limit can succeed later", async () => {
    const acct = await createTestAccount("sandbox"); // parallel limit 1
    const key = await createTestKey(acct, "test");
    expect((await post(key.secret, "k1")).status).toBe(202);
    const blocked = await post(key.secret, "k2");
    expect(blocked.status).toBe(429);

    await db().update(generations).set({ status: "succeeded" }).where(eq(generations.accountId, acct.accountId));
    const retried = await post(key.secret, "k2");
    expect(retried.status).toBe(202);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
  });

  it("scopes keys per account", async () => {
    const a = await createTestAccount("starter");
    const b = await createTestAccount("starter");
    const ka = await createTestKey(a, "test");
    const kb = await createTestKey(b, "test");
    const ra = await post(ka.secret, "shared-key");
    const rb = await post(kb.secret, "shared-key");
    expect(rb.status).toBe(202);
    expect(rb.body.id).not.toBe(ra.body.id);
  });
});
