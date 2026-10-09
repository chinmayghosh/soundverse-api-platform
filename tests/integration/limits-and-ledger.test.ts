import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as list } from "@/app/v1/generations/route";
import { POST } from "@/app/v1/generations/route";
import { refundGeneration } from "@/server/billing/ledger";
import { db } from "@/server/db/client";
import { generations, ledgerEntries } from "@/server/db/schema";
import { call, countBy, createTestAccount, createTestKey, createTestPlan, genBody } from "../helpers";

describe("rate limits under concurrency", () => {
  it("never lets more than the hourly limit through", async () => {
    const planId = await createTestPlan({ reqPerHour: 10, reqPerDay: 1000 });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct);
    const results = await Promise.all(Array.from({ length: 30 }, () => call(list, { path: "/v1/generations", key: key.secret })));
    expect(countBy(results, (r) => r.status)).toEqual({ 200: 10, 429: 20 });
  });

  it("enforces the daily limit, and a day rejection does not burn hourly quota", async () => {
    const planId = await createTestPlan({ reqPerHour: 100, reqPerDay: 5 });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct);
    const results = await Promise.all(Array.from({ length: 12 }, () => call(list, { path: "/v1/generations", key: key.secret })));
    expect(countBy(results, (r) => r.status)).toEqual({ 200: 5, 429: 7 });
    expect(results.find((r) => r.status === 429)!.body.error.code).toBe("daily_rate_limit_exceeded");
    const [{ count }] = (
      await db().execute<{ count: number }>(
        sql`select count from rate_limit_counters where account_id = ${acct.accountId} and "window" = 'hour'`,
      )
    ).rows;
    expect(count).toBe(5);
  });

  it("limits are per account, shared by all of its keys", async () => {
    const planId = await createTestPlan({ reqPerHour: 6 });
    const acct = await createTestAccount(planId);
    const k1 = await createTestKey(acct);
    const k2 = await createTestKey(acct, "live");
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => call(list, { path: "/v1/generations", key: i % 2 ? k1.secret : k2.secret })),
    );
    expect(countBy(results, (r) => r.status)).toEqual({ 200: 6, 429: 4 });
  });
});

describe("request validation", () => {
  it("returns 400 invalid_parameter with the field path", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const res = await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody({ duration_sec: 9999 }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_parameter");
    expect(res.body.error.message).toMatch(/^duration_sec/);
  });

  it("returns 400 invalid_json for a malformed body", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct);
    const req = new Request("http://localhost:3000/v1/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_json");
  });
});

describe("ledger", () => {
  it("is append-only at the database level", async () => {
    const acct = await createTestAccount();
    const key = await createTestKey(acct, "live");
    await call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody() });
    await expect(
      db().update(ledgerEntries).set({ allowanceCredits: 0 }).where(eq(ledgerEntries.accountId, acct.accountId)),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("append-only (UPDATE blocked)") } });
    await expect(db().delete(ledgerEntries).where(eq(ledgerEntries.accountId, acct.accountId))).rejects.toMatchObject({
      cause: { message: expect.stringContaining("append-only (DELETE blocked)") },
    });
  });

  it("refunds exactly once and reconciles with job charges", async () => {
    const planId = await createTestPlan({ parallelLimit: 10 });
    const acct = await createTestAccount(planId);
    const key = await createTestKey(acct, "live");
    const made = await Promise.all(
      [30, 90, 150].map((d) => call(POST, { method: "POST", path: "/v1/generations", key: key.secret, body: genBody({ license: "sync", duration_sec: d }) })),
    );
    expect(made.map((m) => m.body.credits_charged).sort()).toEqual([12, 18, 6]);

    const failedId = made[1].body.id;
    const results = await Promise.all([1, 2, 3].map(() => db().transaction((tx) => refundGeneration(tx, failedId))));
    expect(results.filter(Boolean)).toHaveLength(1);
    await db().update(generations).set({ status: "failed" }).where(eq(generations.id, failedId));

    // Reconciliation: Σ ledger == Σ credits_charged over non-refunded live jobs.
    const [{ ledger }] = (
      await db().execute<{ ledger: number }>(
        sql`select coalesce(sum(allowance_credits + overage_credits), 0)::int as ledger from ledger_entries where account_id = ${acct.accountId}`,
      )
    ).rows;
    const [{ jobs }] = (
      await db().execute<{ jobs: number }>(
        sql`select coalesce(sum(credits_charged), 0)::int as jobs from generations g
            where account_id = ${acct.accountId} and mode = 'live'
              and not exists (select 1 from ledger_entries l where l.generation_id = g.id and l.kind = 'refund')`,
      )
    ).rows;
    expect(ledger).toBe(jobs);
    expect(ledger).toBe(36 - made[1].body.credits_charged);
  });
});
